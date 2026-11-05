"""Collab verifier: counts valid ENHYPEN voting proofs (MAMA certificates) sent by partner fandoms.

Every proof is analysed on the server: the last image must match an ENHYPEN reference, the
certificate ID is read by two independent OCR passes that must agree, and the ID must be unique.
Anything that cannot be verified with certainty goes to a manual review queue.
"""
import csv
import hashlib
import io
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timezone

from PIL import Image, ImageOps

import storage

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(os.getenv('COLLAB_TIMEZONE', 'Europe/Rome'))
except Exception:  # Missing tz database: fall back to UTC rather than fail at import.
    TZ = timezone.utc

MAX_UPLOAD = max(1, int(os.getenv('COLLAB_MAX_UPLOAD_MB', '12'))) * 1024 * 1024
SLOTS = threading.BoundedSemaphore(max(1, int(os.getenv('COLLAB_WORKERS', '2'))))
TESSERACT = shutil.which('tesseract')
Image.MAX_IMAGE_PIXELS = 40_000_000

T_OK = 0.85    # similarity at or above: the last image is ENHYPEN
T_LOW = 0.60   # similarity below (standard layout only): clearly not ENHYPEN
RATIO = 930 / 1410  # Mnet Plus certificate width / height
# Layout of the certificate as fractions of the image (measured on a 930x1410 export).
THUMB_SLOTS = [(81 / 930, 443 / 1410, 321 / 930, 683 / 1410), (345 / 930, 443 / 1410, 585 / 930, 683 / 1410),
               (609 / 930, 443 / 1410, 849 / 930, 683 / 1410)]
ID_BOX = (0.04, 0.903, 0.66, 0.959)   # the whole "No. <ID>" line, with some margin
# Phone screenshots: the card is rendered a few pixels off the export layout, so the card found in the
# screenshot is padded to the export frame and thumbnails are compared over a small window of offsets.
SHOT_TOP, SHOT_BOTTOM = -0.0055, 0.001   # frame edges relative to the detected card height
SHOT_SHIFTS = tuple((dx * 0.0025, dy * 0.0025) for dx in range(-4, 5) for dy in range(-4, 5))
NO_SHIFT = ((0.0, 0.0),)
ID_RE = re.compile(r'[A-Z0-9]{16}')
ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
STATUSES = ('valid', 'duplicate', 'not_enhypen', 'not_partner', 'manual', 'rejected')
SLOT_WORD = ('first', 'second', 'last')
RAW_POSTS = ('/api/collab/upload', '/api/collab/ref')


SCHEMA_VERSION = 3
SCHEMA = '''
    -- A collab is a partner fandom. Its batches must show the partner image in one of `slots`
    -- (0 = first, 1 = second) in addition to ENHYPEN as the last image. No slots = ENHYPEN only.
    CREATE TABLE IF NOT EXISTS collab_collabs(id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      slots TEXT NOT NULL, created_at REAL NOT NULL);
    -- Reference images: collab_id NULL = ENHYPEN (last image); otherwise the partner image of that collab.
    CREATE TABLE IF NOT EXISTS collab_refs(id INTEGER PRIMARY KEY, collab_id INTEGER REFERENCES collab_collabs(id) ON DELETE CASCADE,
      label TEXT NOT NULL, vec TEXT NOT NULL, thumb BLOB NOT NULL, created_at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS collab_submissions(id INTEGER PRIMARY KEY, fandom TEXT NOT NULL COLLATE NOCASE,
      day TEXT NOT NULL, created_at REAL NOT NULL, UNIQUE(fandom,day));
    CREATE TABLE IF NOT EXISTS collab_proofs(id INTEGER PRIMARY KEY,
      submission_id INTEGER NOT NULL REFERENCES collab_submissions(id),
      file_key TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, sha256 TEXT NOT NULL, cert_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('valid','duplicate','not_enhypen','not_partner','manual','rejected')),
      reason TEXT NOT NULL DEFAULT '', similarity REAL, thumb BLOB, created_at REAL NOT NULL,
      reviewed_by TEXT, reviewed_at REAL);
    -- The database itself guarantees that a certificate ID is counted once.
    CREATE UNIQUE INDEX IF NOT EXISTS collab_valid_cert ON collab_proofs(cert_id) WHERE status='valid';
    CREATE INDEX IF NOT EXISTS collab_proofs_status ON collab_proofs(status,id);
    CREATE INDEX IF NOT EXISTS collab_proofs_sha ON collab_proofs(sha256);
    CREATE INDEX IF NOT EXISTS collab_proofs_sub ON collab_proofs(submission_id,status);
    -- One row per character position of every valid ID, with that position masked: finds IDs
    -- that differ by exactly one character (likely OCR misreads or doctored codes).
    CREATE TABLE IF NOT EXISTS collab_mask(k TEXT NOT NULL, cert_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS collab_mask_k ON collab_mask(k);
    '''


def init(c):
    c.execute('CREATE TABLE IF NOT EXISTS collab_meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    version = c.execute("SELECT v FROM collab_meta WHERE k='schema'").fetchone()
    if version is None and c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collab_proofs'").fetchone():
        upgrade_legacy(c)
    c.executescript(SCHEMA)
    c.execute("INSERT OR REPLACE INTO collab_meta(k,v) VALUES('schema',?)", (str(SCHEMA_VERSION),))


def upgrade_legacy(c):
    """One-time upgrade of tables created by the first versions of this module (no schema marker).

    Collabs and reference images are kept. Every uploaded proof, its submission rows and the
    duplicate index are deleted: those were test uploads made while the module was being tried out.
    """
    removed = c.execute('SELECT count(*) FROM collab_proofs').fetchone()[0]
    exists = lambda name: c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    collabs = [dict(r) for r in c.execute('SELECT * FROM collab_collabs')] if exists('collab_collabs') else []
    refs = [dict(r) for r in c.execute('SELECT * FROM collab_refs')] if exists('collab_refs') else []
    for table in ('collab_mask', 'collab_proofs', 'collab_submissions', 'collab_refs', 'collab_collabs'):
        c.execute(f'DROP TABLE IF EXISTS {table}')
    c.executescript(SCHEMA)
    for x in collabs:
        c.execute('INSERT INTO collab_collabs(id,name,slots,created_at) VALUES(?,?,?,?)', (x['id'], x['name'], x['slots'], x['created_at']))
    for x in refs:
        c.execute('INSERT INTO collab_refs(id,collab_id,label,vec,thumb,created_at) VALUES(?,?,?,?,?,?)',
                  (x['id'], x.get('collab_id'), x['label'], x['vec'], x['thumb'], x['created_at']))
    logging.warning('Collab verifier upgrade: removed %d uploaded test proofs; kept %d collabs and %d references', removed, len(collabs), len(refs))


def reset_proofs():
    """Deletes every uploaded proof and its submission rows. Collabs and reference images are kept."""
    with storage.connection() as c:
        removed = c.execute('SELECT count(*) FROM collab_proofs').fetchone()[0]
        for table in ('collab_mask', 'collab_proofs', 'collab_submissions'):
            c.execute(f'DELETE FROM {table}')
    return removed


# ---------------------------------------------------------------- image analysis
def open_image(data):
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
        im = ImageOps.exif_transpose(im)
        if im.mode in ('RGBA', 'LA', 'P'):
            im = im.convert('RGBA')
            flat = Image.new('RGB', im.size, (255, 255, 255))
            flat.paste(im, mask=im.getchannel('A'))
            return flat
        return im.convert('RGB')
    except Exception:
        return None


def crop(im, box):
    w, h = im.size
    return im.crop((round(box[0] * w), round(box[1] * h), round(box[2] * w), round(box[3] * h)))


def slot_vector(im, slot, dx=0.0, dy=0.0):
    box = THUMB_SLOTS[slot]
    mx, my = (box[2] - box[0]) * 0.1, (box[3] - box[1]) * 0.1  # trims the rounded corners
    small = crop(im, (box[0] + mx + dx, box[1] + my + dy, box[2] - mx + dx, box[3] - my + dy)).resize((24, 24), Image.LANCZOS)
    values = list(small.tobytes())
    mean = sum(values) / len(values)
    values = [v - mean for v in values]
    norm = sum(v * v for v in values) ** 0.5 or 1.0
    return [round(v / norm, 5) for v in values]


def correlation(a, b):
    return sum(x * y for x, y in zip(a, b))


def runs(fractions, minimum, gap):
    """(start, end) of the stretches where fractions >= minimum, bridging gaps of up to `gap` entries."""
    found, start, last, missed = [], None, 0, 0
    for i, v in enumerate(list(fractions) + [0] * (gap + 1)):
        if v >= minimum:
            if start is None:
                start = i
            last, missed = i, 0
        elif start is not None:
            missed += 1
            if missed > gap:
                found.append((start, last + 1))
                start = None
    return found


def find_card(im):
    """Box of the certificate card inside a phone screenshot, or None.

    The card is the only large tinted (non-white, non-grey) area with the certificate proportions;
    the status bar, ad banners and buttons are white or grey.
    """
    scale = min(1.0, 540 / im.width)
    small = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.BOX)
    mask = small.convert('HSV').getchannel('S').point(lambda v: 255 if v > 10 else 0)
    w, h = mask.size
    best = None
    for y0, y1 in runs([v / 255 for v in mask.resize((1, h), Image.BOX).tobytes()], 0.25, max(2, h // 40)):
        band = mask.crop((0, y0, w, y1))
        for x0, x1 in runs([v / 255 for v in band.resize((w, 1), Image.BOX).tobytes()], 0.4, max(2, w // 60)):
            if x1 - x0 < w * 0.4 or abs((x1 - x0) / (y1 - y0) / RATIO - 1) > 0.04:
                continue
            if best is None or (x1 - x0) * (y1 - y0) > best[0]:
                best = ((x1 - x0) * (y1 - y0), (x0, y0, x1, y1))
    if not best:
        return None
    return tuple(round(v / scale) for v in best[1])


def normalise(im):
    """(image, from_screenshot). A phone screenshot is cut down to the certificate card; anything else is returned as is."""
    if layout_ok(im):
        return im, False
    box = find_card(im)
    if not box:
        return im, False
    x0, y0, x1, y1 = box
    height = y1 - y0
    top, bottom = max(0, round(y0 + SHOT_TOP * height)), min(im.height, round(y1 + SHOT_BOTTOM * height))
    centre, width = (x0 + x1) / 2, (bottom - top) * RATIO
    left, right = max(0, round(centre - width / 2)), min(im.width, round(centre + width / 2))
    return im.crop((left, top, right, bottom)), True


def layout_ok(im):
    return abs(im.width / im.height / RATIO - 1) < 0.05


def jpeg(im, width, quality):
    im = im.copy()
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    out = io.BytesIO()
    im.convert('RGB').save(out, 'JPEG', quality=quality)
    return out.getvalue()


def tesseract(img):
    out = io.BytesIO()
    img.save(out, 'PNG')
    # The dictionaries are switched off: the ID is a random string, and word models "correct" it.
    run = subprocess.run([TESSERACT, 'stdin', 'stdout', '--psm', '7', '-l', 'eng', '-c', f'tessedit_char_whitelist={ALNUM}',
                          '-c', 'load_system_dawg=0', '-c', 'load_freq_dawg=0'],
                         input=out.getvalue(), capture_output=True, timeout=30, env=dict(os.environ, OMP_THREAD_LIMIT='1'))
    return run.stdout.decode('utf-8', 'ignore')


def parse_id(text):
    s = re.sub(r'[^A-Z0-9]', '', text.upper())
    if len(s) == 18 and s[:2] in ('NO', 'N0'):
        s = s[2:]
    elif len(s) == 17 and s[0] == 'N':  # the lower-case "o" of "No." is outside the character whitelist
        s = s[1:]
    return s if ID_RE.fullmatch(s) else None


def read_ids(im):
    """Independent OCR readings of the "No. <ID>" line: different heights, plain and binarised.

    The wide box tolerates a few pixels of misalignment. Three readings are taken first; when they
    all agree that is enough, otherwise up to five more are added, because the font is tightly spaced
    and a single reading can add or merge a character (a "W" read as "WA").
    """
    strip = crop(im, ID_BOX).convert('L')

    def variant(height, binarise=False):
        scale = min(8.0, max(1.0, height / strip.height))
        img = ImageOps.autocontrast(strip.resize((round(strip.width * scale), round(strip.height * scale)), Image.LANCZOS))
        if binarise:
            img = img.point(lambda p: 255 if p > 150 else 0)
        return parse_id(tesseract(ImageOps.expand(img, 24, fill=255)))

    plan = [(110, False), (150, True), (200, False), (110, True), (200, True), (150, False), (260, True), (130, True)]
    readings = []
    for i, (height, binarise) in enumerate(plan):
        readings.append(variant(height, binarise))
        if i == 2 and readings[0] and len(set(readings)) == 1:
            break
        found = [r for r in readings if r]
        if len(found) >= 4 and len(set(found)) == 1:
            break
    return readings


def consensus(readings):
    """The ID the readings agree on, or None. The leader needs two votes, more than half of the valid
    readings and a margin of two over the runner-up (unless every valid reading is identical)."""
    found = [r for r in readings if r]
    if len(found) < 2:
        return None
    top = max(set(found), key=found.count)
    votes = found.count(top)
    others = sorted((found.count(x) for x in set(found) if x != top), reverse=True)
    if votes >= 2 and votes * 2 > len(found) and (not others or votes >= others[0] + 2 or votes == len(found)):
        return top
    return None


CONFUSABLE = ('0OQD', '1IL', '5S', '8B', '2Z', '6G', 'A4', 'UV')
FOLD = {ch: group[0] for group in CONFUSABLE for ch in group}


def unsure_guess(readings):
    """The best guess when the OCR is not sure, or None when the readings differ in more than look-alike characters.

    A single valid reading, or readings that differ only in characters the OCR mixes up (O/0, I/1, S/5, B/8...),
    still point to one certificate. The most frequent reading (the first among equals) is the guess.
    """
    found = [r for r in readings if r]
    if not found:
        return None
    top = max(found, key=found.count)
    if all(FOLD.get(a, a) == FOLD.get(b, b) for r in set(found) for a, b in zip(r, top)):
        return top
    return None


def lookalikes(cert_id, limit=5):
    """The ID with each look-alike character swapped (at most `limit` positions, so at most 2**limit IDs)."""
    spots = [i for i, ch in enumerate(cert_id) if ch in FOLD][:limit]
    out = {cert_id}
    for i in spots:
        group = next(g for g in CONFUSABLE if cert_id[i] in g)
        out |= {v[:i] + alt + v[i + 1:] for v in out for alt in group}
    return out


# ---------------------------------------------------------------- identifiers
def mask_keys(cert_id):
    return [f'{i}:{cert_id[:i]}*{cert_id[i + 1:]}' for i in range(len(cert_id))]


def near_cert(c, cert_id):
    """Another valid ID differing from this one by exactly one character, with the proof that holds it."""
    keys = mask_keys(cert_id)
    return c.execute(f'''SELECT m.cert_id, s.fandom, s.day FROM collab_mask m
        JOIN collab_proofs p ON p.cert_id=m.cert_id AND p.status='valid'
        JOIN collab_submissions s ON s.id=p.submission_id
        WHERE m.k IN ({','.join('?' * len(keys))}) AND m.cert_id!=? LIMIT 1''', (*keys, cert_id)).fetchone()


def exact_cert(c, cert_id):
    return c.execute('''SELECT p.id, s.fandom, s.day FROM collab_proofs p JOIN collab_submissions s ON s.id=p.submission_id
        WHERE p.cert_id=? AND p.status='valid' ''', (cert_id,)).fetchone()


def add_mask(c, cert_id):
    c.executemany('INSERT INTO collab_mask(k,cert_id) VALUES(?,?)', [(k, cert_id) for k in mask_keys(cert_id)])


def decide_id(c, cert_id, sure):
    """Outcome of an ID once it is read: (status, reason). `sure` is False when the OCR did not fully confirm it.

    A sure ID is valid unless it is already counted or one character from a counted ID. An unsure ID is also
    accepted when no look-alike variant of it (O for 0, I for 1...) is counted or one character from a counted
    ID: the image already passed every other check, so the ID only has to be told apart from the others.
    """
    same = exact_cert(c, cert_id)
    if same:
        return 'duplicate', f"Already counted for {same['fandom']} on {same['day']}"
    near = near_cert(c, cert_id)
    if near:
        return 'manual', f"ID differs by one character from {near['cert_id']} ({near['fandom']}, {near['day']}): possible duplicate or misread"
    if sure:
        return 'valid', ''
    for variant in sorted(lookalikes(cert_id) - {cert_id}):
        twin = exact_cert(c, variant) and {'cert_id': variant} or near_cert(c, variant)
        if twin:
            return 'manual', f"The OCR is not sure of the ID and it could be {twin['cert_id']}, which is already counted"
    return 'valid', 'ID not fully confirmed by the OCR; no similar ID is counted'


# ---------------------------------------------------------------- upload pipeline
def clean(value, limit):
    return re.sub(r'\s+', ' ', str(value or '')).strip()[:limit]


def today():
    return datetime.now(TZ).strftime('%Y-%m-%d')


def proofs_day(value):
    """The date the votes refer to (not necessarily the upload day). Defaults to today."""
    day = clean(value, 10) or today()
    try:
        datetime.strptime(day, '%Y-%m-%d')
    except ValueError:
        raise ValueError('The proofs date must be a valid date (YYYY-MM-DD)')
    if day > today():
        raise ValueError('The proofs date cannot be in the future')
    return day


def submission(c, fandom, day):
    c.execute('INSERT OR IGNORE INTO collab_submissions(fandom,day,created_at) VALUES(?,?,?)', (fandom, day, time.time()))
    return c.execute('SELECT id,fandom,day FROM collab_submissions WHERE fandom=? AND day=?', (fandom, day)).fetchone()


def existing(c, file_key):
    row = c.execute('''SELECT p.id,p.status,p.reason,p.cert_id,s.fandom,s.day FROM collab_proofs p
        JOIN collab_submissions s ON s.id=p.submission_id WHERE p.file_key=?''', (file_key,)).fetchone()
    return None if row is None else {**dict(row), 'repeat': True}


def where(slots):
    return ' or '.join(SLOT_WORD[i] for i in slots)


def analyse(data, refs, partner=None):
    """Returns (status, reason, cert_id, similarity, thumbnail) for one image, before the uniqueness check.

    `partner` is None (ENHYPEN only) or {'name', 'slots', 'vecs'}: the collab's own image must appear
    in one of the allowed positions.
    """
    im = open_image(data)
    if im is None:
        return 'manual', 'Cannot open the image', None, None, None
    im, screenshot = normalise(im)  # a phone screenshot is reduced to the certificate card
    shifts = SHOT_SHIFTS if screenshot else NO_SHIFT

    def match(slot, targets):
        """Best similarity of one thumbnail with any target; screenshots are tried at a few small offsets."""
        best = -1.0
        for dx, dy in shifts:
            v = slot_vector(im, slot, dx, dy)
            best = max(best, max(correlation(v, t) for t in targets))
        return best

    last = match(2, refs)
    trusted = layout_ok(im)
    thumb = jpeg(im, 640, 65)
    if trusted and last < T_LOW:
        other = max(match(0, refs), match(1, refs))
        reason = 'ENHYPEN is not the last image' if other >= T_OK else 'The last image is not ENHYPEN'
        return 'not_enhypen', reason, None, last, thumb
    if last < T_OK:
        reason = f'The last image is unclear (similarity {last:.2f})' if trusted else 'Non-standard layout (cropped screenshot?)'
        return 'manual', reason, None, last, thumb
    if partner:
        fit = max(match(slot, partner['vecs']) for slot in partner['slots'])
        if fit < T_LOW:
            return 'not_partner', f"The {partner['name']} image is not in the {where(partner['slots'])} position", None, fit, thumb
        if fit < T_OK:
            return 'manual', f"The {partner['name']} image is unclear (similarity {fit:.2f})", None, fit, thumb
    readings = ocr_ids(im)
    found = [r for r in readings if r]
    if not found:
        return 'manual', 'Certificate ID not readable', None, last, thumb
    best = consensus(found)
    if best:
        return 'ok', '', best, last, None
    guess = max(found, key=found.count)  # the first reading among equals
    likely = unsure_guess(found)
    if likely:  # decided by process() against the IDs already counted
        return 'unsure', 'The OCR could not confirm the ID' if len(set(found)) == 1 else 'The OCR readings of the ID disagree', likely, last, thumb
    return 'manual', 'The OCR readings of the ID disagree', guess, last, thumb


def ocr_ids(im):
    if not TESSERACT:
        raise ValueError('The OCR engine (tesseract) is not installed on the server')
    return read_ids(im)


def process(fandom, file_name, file_key, data, actor, day=None):
    fandom, file_name, file_key = clean(fandom, 80), clean(file_name, 300), clean(file_key, 500)
    day = proofs_day(day)
    if not fandom:
        raise ValueError('Fandom collab name is required')
    if not file_key:
        raise ValueError('File key is required')
    sha = hashlib.sha256(data).hexdigest()
    with storage.connection() as c:
        again = existing(c, file_key)
        profile = c.execute('SELECT id,name,slots FROM collab_collabs WHERE name=?', (fandom,)).fetchone()
        if not profile:
            raise ValueError(f'"{fandom}" is not a defined collab. Add it in the Collabs section first.')
        fandom = profile['name']
        refs = [json.loads(r['vec']) for r in c.execute('SELECT vec FROM collab_refs WHERE collab_id IS NULL')]
        slots = json.loads(profile['slots'])
        partner = None
        if slots:
            vecs = [json.loads(r['vec']) for r in c.execute('SELECT vec FROM collab_refs WHERE collab_id=?', (profile['id'],))]
            if not vecs and not again:
                raise ValueError(f"Add a partner reference image for {fandom} first")
            partner = {'name': fandom, 'slots': slots, 'vecs': vecs}
        seen = c.execute('''SELECT p.cert_id,s.fandom,s.day FROM collab_proofs p JOIN collab_submissions s ON s.id=p.submission_id
            WHERE p.sha256=? AND p.status='valid' LIMIT 1''', (sha,)).fetchone()
    if again:
        return again
    if not refs:
        raise ValueError('Add at least one ENHYPEN reference certificate first')
    if seen:  # Byte-identical to a proof already counted: no need to analyse it again.
        status, reason, cert_id, sim, thumb = 'duplicate', f"Identical file already counted for {seen['fandom']} on {seen['day']}", seen['cert_id'], None, None
    else:
        with SLOTS:  # Bounds CPU and memory: OCR is the expensive step.
            status, reason, cert_id, sim, thumb = analyse(data, refs, partner)
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        again = existing(c, file_key)
        if again:
            return again
        sub = submission(c, fandom, day)
        if status in ('ok', 'unsure'):
            keep_thumb = thumb
            twin = c.execute('''SELECT s.fandom,s.day FROM collab_proofs p JOIN collab_submissions s ON s.id=p.submission_id
                WHERE p.sha256=? AND p.status='valid' LIMIT 1''', (sha,)).fetchone()
            if twin:
                status, reason = 'duplicate', f"Already counted for {twin['fandom']} on {twin['day']}"
            else:
                status, reason = decide_id(c, cert_id, status == 'ok')
            if status == 'manual':
                thumb = keep_thumb or jpeg(normalise(open_image(data))[0], 640, 65)
            else:
                thumb = None
        cur = c.execute('''INSERT INTO collab_proofs(submission_id,file_key,file_name,sha256,cert_id,status,reason,similarity,thumb,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)''', (sub['id'], file_key, file_name, sha, cert_id, status, reason, sim, thumb, time.time()))
        if status == 'valid':
            add_mask(c, cert_id)
        return {'id': cur.lastrowid, 'status': status, 'reason': reason, 'cert_id': cert_id, 'fandom': sub['fandom'], 'day': sub['day']}


# ---------------------------------------------------------------- references
def add_reference(label, data, collab_id=None, slot=None):
    """ENHYPEN reference (collab_id None: its last image) or a collab's partner reference (slot: where it sits in the sample)."""
    im = open_image(data)
    im = normalise(im)[0] if im is not None else None  # a full phone screenshot of the certificate is accepted too
    if im is None or not layout_ok(im):
        raise ValueError('Use a full, uncropped certificate image or a phone screenshot that shows the whole certificate card')
    with storage.connection() as c:
        if collab_id is None:
            slot, label = 2, clean(label, 80) or 'ENHYPEN'
        else:
            row = c.execute('SELECT name,slots FROM collab_collabs WHERE id=?', (collab_id,)).fetchone()
            if not row:
                raise ValueError('Collab not found')
            if slot not in json.loads(row['slots']):
                raise ValueError(f"Choose the position of the {row['name']} image in your sample: {where(json.loads(row['slots'])) or 'none expected'}")
            label = clean(label, 80) or row['name']
        thumb = jpeg(crop(im, THUMB_SLOTS[slot]), 120, 80)
        cur = c.execute('INSERT INTO collab_refs(collab_id,label,vec,thumb,created_at) VALUES(?,?,?,?,?)',
                        (collab_id, label, json.dumps(slot_vector(im, slot)), thumb, time.time()))
    return {'id': cur.lastrowid}


def create_collab(name, slots):
    name = clean(name, 80)
    if not name:
        raise ValueError('The collab name is required')
    if not isinstance(slots, list) or any(s not in (0, 1) for s in slots) or len(set(slots)) != len(slots):
        raise ValueError('The partner image position must be the first image, the second, or either')
    try:
        with storage.connection() as c:
            cur = c.execute('INSERT INTO collab_collabs(name,slots,created_at) VALUES(?,?,?)', (name, json.dumps(sorted(slots)), time.time()))
    except sqlite3.IntegrityError:
        raise ValueError(f'The collab "{name}" already exists')
    return {'id': cur.lastrowid}


def delete_collab(collab_id):
    with storage.connection() as c:
        row = c.execute('SELECT name FROM collab_collabs WHERE id=?', (collab_id,)).fetchone()
        if not row:
            raise ValueError('Collab not found')
        if c.execute('SELECT 1 FROM collab_submissions WHERE fandom=?', (row['name'],)).fetchone():
            raise ValueError('This collab already has uploaded proofs and cannot be removed')
        c.execute('DELETE FROM collab_collabs WHERE id=?', (collab_id,))
    return {'ok': True}


# ---------------------------------------------------------------- reading
def summary():
    with storage.connection() as c:
        rows = [dict(r) for r in c.execute('''SELECT s.id,s.fandom,s.day,count(p.id) files,
            coalesce(sum(p.status='valid'),0) valid, coalesce(sum(p.status='duplicate'),0) duplicate,
            coalesce(sum(p.status='not_enhypen'),0) not_enhypen, coalesce(sum(p.status='not_partner'),0) not_partner,
            coalesce(sum(p.status='manual'),0) manual,
            coalesce(sum(p.status='rejected'),0) rejected
            FROM collab_submissions s LEFT JOIN collab_proofs p ON p.submission_id=s.id
            GROUP BY s.id ORDER BY s.day DESC, s.fandom COLLATE NOCASE''')]
        refs = [dict(r) for r in c.execute('SELECT id,label,created_at FROM collab_refs WHERE collab_id IS NULL ORDER BY id')]
        collabs = [dict(r) for r in c.execute('SELECT id,name,slots FROM collab_collabs ORDER BY name')]
        for item in collabs:
            item['slots'] = json.loads(item['slots'])
            item['refs'] = [dict(r) for r in c.execute('SELECT id,label FROM collab_refs WHERE collab_id=? ORDER BY id', (item['id'],))]
    return {'submissions': rows, 'refs': refs, 'collabs': collabs, 'ocr_available': bool(TESSERACT), 'max_upload_mb': MAX_UPLOAD // 1048576}


# What each review list holds. The two "flagged" lists are proofs the system rejected on its own: a person
# can still accept one (a false rejection) or confirm it, which takes it out of the list.
REVIEW_KINDS = {
    'manual': "p.status='manual'",
    'groups': "p.status='not_enhypen' AND p.reviewed_at IS NULL",
    'partner': "p.status='not_partner' AND p.reviewed_at IS NULL",
}
OCR_REASONS = ('The OCR could not confirm the ID', 'The OCR readings of the ID disagree', 'Certificate ID not readable')
OCR_WHERE = f"p.status='manual' AND p.thumb IS NOT NULL AND p.reason IN ({','.join(repr(r) for r in OCR_REASONS)})"


def queue(offset, limit, kind='manual'):
    if kind not in REVIEW_KINDS:
        raise ValueError('Unknown review list')
    with storage.connection() as c:
        counts = {k: c.execute(f'SELECT count(*) FROM collab_proofs p WHERE {w}').fetchone()[0] for k, w in REVIEW_KINDS.items()}
        pending = c.execute(f'SELECT count(*) FROM collab_proofs p WHERE {OCR_WHERE}').fetchone()[0]
        items = [dict(r) for r in c.execute(f'''SELECT p.id,s.fandom,s.day,p.file_name,p.status,p.reason,p.cert_id,p.similarity,p.thumb IS NOT NULL has_image
            FROM collab_proofs p JOIN collab_submissions s ON s.id=p.submission_id WHERE {REVIEW_KINDS[kind]}
            ORDER BY p.id LIMIT ? OFFSET ?''', (limit, offset))]
    return {'total': counts[kind], 'items': items, 'counts': counts, 'ocr_pending': pending}


def known(keys):
    found = []
    with storage.connection() as c:
        for i in range(0, len(keys), 500):
            chunk = [clean(k, 500) for k in keys[i:i + 500]]
            found += [r[0] for r in c.execute(f"SELECT file_key FROM collab_proofs WHERE file_key IN ({','.join('?' * len(chunk))})", chunk)]
    return found


def export_csv(kind, day=''):
    out = io.StringIO()
    writer = csv.writer(out)
    where_day, args = ('WHERE s.day=?', (day,)) if day else ('', ())
    with storage.connection() as c:
        if kind == 'full':
            writer.writerow(['fandom_collab', 'date', 'file', 'certificate_id', 'result', 'reason', 'reviewed_by'])
            for r in c.execute(f'''SELECT s.fandom,s.day,p.file_name,p.cert_id,p.status,p.reason,p.reviewed_by FROM collab_proofs p
                JOIN collab_submissions s ON s.id=p.submission_id {where_day} ORDER BY s.day,s.fandom COLLATE NOCASE,p.id''', args):
                writer.writerow(list(r))
        else:
            writer.writerow(['Fandom collab', 'Valid proofs', 'Date'])
            for r in c.execute(f'''SELECT s.fandom, coalesce(sum(p.status='valid'),0), s.day FROM collab_submissions s
                LEFT JOIN collab_proofs p ON p.submission_id=s.id {where_day} GROUP BY s.id ORDER BY s.day,s.fandom COLLATE NOCASE''', args):
                writer.writerow(list(r))
    return out.getvalue()


def export_name(kind, day):
    base = 'mama-proofs-report' if kind == 'full' else 'mama-valid-proofs'
    return f"{base}-{day}.csv" if day else f"{base}-all-as-of-{today()}.csv"


# ---------------------------------------------------------------- review
def approve(proof_id, cert_id, confirm_similar, actor):
    cert_id = clean(cert_id, 40).upper()
    if not ID_RE.fullmatch(cert_id):
        raise ValueError('The certificate ID must be 16 letters or digits')
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute('SELECT status,reviewed_at FROM collab_proofs WHERE id=?', (proof_id,)).fetchone()
        if not row:
            raise ValueError('Proof not found')
        if row['status'] not in ('manual', 'not_enhypen', 'not_partner') or (row['status'] != 'manual' and row['reviewed_at']):
            raise ValueError('This proof was already reviewed')
        same = exact_cert(c, cert_id)
        if same:
            raise ValueError(f"Duplicate: this ID is already counted for {same['fandom']} on {same['day']}")
        near = near_cert(c, cert_id)
        if near and not confirm_similar:
            return {'needs_confirmation': True, 'message': f"Very similar to {near['cert_id']} ({near['fandom']}, {near['day']}). Confirm only if it is a different certificate."}
        c.execute("UPDATE collab_proofs SET status='valid',cert_id=?,reason='Approved manually',reviewed_by=?,reviewed_at=? WHERE id=?",
                  (cert_id, actor, time.time(), proof_id))
        add_mask(c, cert_id)
    return {'ok': True}


def keep(proof_id, actor):
    """Confirms that a proof the system rejected (other group, wrong partner image) really is not valid."""
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        done = c.execute("UPDATE collab_proofs SET reviewed_by=?,reviewed_at=? WHERE id=? AND status IN ('not_enhypen','not_partner') AND reviewed_at IS NULL",
                         (actor, time.time(), proof_id)).rowcount
    if not done:
        raise ValueError('Proof not found or already reviewed')
    return {'ok': True}


def read_proof_id(proof_id):
    """Reads the ID from the stored preview of a proof, to prefill the review form."""
    with storage.connection() as c:
        row = c.execute('SELECT thumb FROM collab_proofs WHERE id=?', (proof_id,)).fetchone()
    im = open_image(bytes(row['thumb'])) if row and row['thumb'] else None
    if im is None:
        raise ValueError('There is no image to read for this proof')
    with SLOTS:
        readings = ocr_ids(im)
    found = [r for r in readings if r]
    best = consensus(readings)
    return {'cert_id': best or (max(found, key=found.count) if found else None), 'confident': bool(best)}


def reject(proof_id, actor):
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        done = c.execute("UPDATE collab_proofs SET status='rejected',reason='Rejected manually',reviewed_by=?,reviewed_at=? WHERE id=? AND status='manual'",
                         (actor, time.time(), proof_id)).rowcount
    if not done:
        raise ValueError('Proof not found or already reviewed')
    return {'ok': True}


def reprocess_review(apply=False, progress=None):
    """Reads again the ID of proofs waiting in review because of the OCR, from their stored preview.

    The preview is the certificate card at 640 px, enough for the current reader. A proof whose ID is now
    confirmed is decided like a fresh upload: counted, duplicate, or kept for review when it is one character
    away from a counted ID. Proofs the OCR still cannot confirm are left untouched. Returns the counts.
    """
    done = {'eligible': 0, 'valid': 0, 'duplicate': 0, 'near': 0, 'unchanged': 0}
    with storage.connection() as c:
        ids = [r['id'] for r in c.execute(f'SELECT p.id FROM collab_proofs p WHERE {OCR_WHERE} ORDER BY p.id')]
    done['eligible'] = len(ids)
    if not apply:
        return done
    for n, proof_id in enumerate(ids, 1):
        with storage.connection() as c:
            row = c.execute("SELECT thumb FROM collab_proofs WHERE id=? AND status='manual'", (proof_id,)).fetchone()
        im = open_image(row['thumb']) if row else None
        best, sure = None, False
        if im is not None:
            with SLOTS:  # shares the CPU budget with uploads
                readings = ocr_ids(im)
            best = consensus(readings)
            sure = bool(best)
            best = best or unsure_guess(readings)
        outcome = 'unchanged'
        if best:
            with storage.connection() as c:
                c.execute('BEGIN IMMEDIATE')
                if c.execute("SELECT 1 FROM collab_proofs WHERE id=? AND status='manual'", (proof_id,)).fetchone():
                    status, reason = decide_id(c, best, sure)
                    if status == 'duplicate':
                        c.execute("UPDATE collab_proofs SET status='duplicate',cert_id=?,reason=?,thumb=NULL,reviewed_by='reprocess',reviewed_at=? WHERE id=?",
                                  (best, reason, time.time(), proof_id))
                        outcome = 'duplicate'
                    elif status == 'manual':
                        c.execute('UPDATE collab_proofs SET cert_id=?,reason=? WHERE id=?', (best, reason, proof_id))
                        outcome = 'near'
                    else:
                        c.execute("UPDATE collab_proofs SET status='valid',cert_id=?,reason=?,thumb=NULL,reviewed_by='reprocess',reviewed_at=? WHERE id=?",
                                  (best, reason or 'Re-read automatically', time.time(), proof_id))
                        add_mask(c, best)
                        outcome = 'valid'
        done[outcome] += 1
        if progress:
            progress(n, len(ids))
    return done


JOB = {'running': False, 'done': 0, 'total': 0, 'result': None, 'error': None}
JOB_LOCK = threading.Lock()


def reprocess_status():
    with JOB_LOCK:
        return dict(JOB)


def reprocess_start():
    """Starts reading the OCR-related review proofs again in the background (one run at a time)."""
    if not TESSERACT:
        raise ValueError('The OCR engine (tesseract) is not installed on the server')
    with JOB_LOCK:
        if JOB['running']:
            return dict(JOB)
        JOB.update(running=True, done=0, total=0, result=None, error=None)

    def progress(n, total):
        with JOB_LOCK:
            JOB.update(done=n, total=total)

    def run():
        try:
            result = reprocess_review(apply=True, progress=progress)
            with JOB_LOCK:
                JOB.update(result=result)
        except Exception as error:  # reported to the page; the proofs already decided stay decided
            logging.exception('Reprocessing the review list failed')
            with JOB_LOCK:
                JOB.update(error=str(error) or 'Unexpected error')
        finally:
            with JOB_LOCK:
                JOB.update(running=False)

    threading.Thread(target=run, daemon=True, name='collab-reprocess').start()
    return reprocess_status()


# ---------------------------------------------------------------- HTTP glue (called from app.py)
def get(path, query):
    """Returns (status, body, content_type) for authenticated GET requests, or None if not a collab route."""
    if path == '/api/collab/summary':
        return 200, summary(), 'application/json; charset=utf-8'
    if path == '/api/collab/queue':
        offset = max(0, int((query.get('offset') or ['0'])[0]))
        kind = (query.get('kind') or ['manual'])[0]
        return 200, queue(offset, min(50, max(1, int((query.get('limit') or ['10'])[0]))), kind), 'application/json; charset=utf-8'
    if path == '/api/collab/reprocess':
        return 200, reprocess_status(), 'application/json; charset=utf-8'
    if path == '/api/collab/export.csv':
        kind = 'full' if (query.get('kind') or [''])[0] == 'full' else 'summary'
        day = clean((query.get('day') or [''])[0], 10)
        if day:
            day = proofs_day(day)
        headers = {'Content-Disposition': f'attachment; filename="{export_name(kind, day)}"'}
        return 200, export_csv(kind, day), 'text/csv; charset=utf-8', headers
    match = re.fullmatch(r'/api/collab/(proofs|refs)/(\d+)/image', path)
    if match:
        sql = {'proofs': 'SELECT thumb FROM collab_proofs WHERE id=?', 'refs': 'SELECT thumb FROM collab_refs WHERE id=?'}[match[1]]
        with storage.connection() as c:
            row = c.execute(sql, (match[2],)).fetchone()
        if not row or not row['thumb']:
            return 404, {'error': 'Image not found'}, 'application/json; charset=utf-8'
        return 200, bytes(row['thumb']), 'image/jpeg'
    return None


def post_raw(path, query, data, actor):
    first = lambda name: (query.get(name) or [''])[0]
    if path == '/api/collab/upload':
        return process(first('fandom'), first('name'), first('key'), data, actor, first('day'))
    if path == '/api/collab/ref':
        collab_id = first('collab')
        if collab_id:
            return add_reference(first('label'), data, int(collab_id), int(first('slot') or -1))
        return add_reference(first('label'), data)
    raise ValueError('Unknown request')


def mutate(path, payload, actor):
    if path == '/api/collab/known':
        keys = payload.get('keys')
        if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys) or len(keys) > 2000:
            raise ValueError('keys must be a list of at most 2000 strings')
        return {'known': known(keys)}
    if path == '/api/collab/reprocess/start':
        return reprocess_start()
    match = re.fullmatch(r'/api/collab/proofs/(\d+)/(approve|reject|keep|read)', path)
    if match:
        if match[2] == 'approve':
            return approve(int(match[1]), payload.get('cert_id', ''), bool(payload.get('confirm_similar')), actor)
        if match[2] == 'keep':
            return keep(int(match[1]), actor)
        if match[2] == 'read':
            return read_proof_id(int(match[1]))
        return reject(int(match[1]), actor)
    if path == '/api/collab/collabs/create':
        return create_collab(payload.get('name', ''), payload.get('slots'))
    match = re.fullmatch(r'/api/collab/collabs/(\d+)/delete', path)
    if match:
        return delete_collab(int(match[1]))
    match = re.fullmatch(r'/api/collab/refs/(\d+)/delete', path)
    if match:
        with storage.connection() as c:
            c.execute('DELETE FROM collab_refs WHERE id=?', (match[1],))
        return {'ok': True}
    raise ValueError('Unknown request')


if __name__ == '__main__':
    import sys
    args = sys.argv[1:]
    if args == ['reset-proofs', '--yes']:
        print(f'Deleted {reset_proofs()} uploaded proofs. Collabs and reference images were kept.')
    elif args in (['reprocess-review'], ['reprocess-review', '--yes']):
        result = reprocess_review(apply='--yes' in args, progress=lambda n, total: n % 50 == 0 and print(f'  {n}/{total}', flush=True))
        if '--yes' in args:
            print(f"Re-read {result['eligible']} proofs: {result['valid']} now valid, {result['duplicate']} duplicates, "
                  f"{result['near']} one character from a counted ID (still in review), {result['unchanged']} still unconfirmed.")
        else:
            print(f"{result['eligible']} proofs are in review because of the OCR. Run with --yes to read them again.")
    else:
        print('Usage: python collab.py reset-proofs --yes        (deletes every uploaded proof; keeps collabs and references)\n'
              '       python collab.py reprocess-review [--yes]   (reads again the IDs of OCR-related review proofs; without --yes only counts them)')
