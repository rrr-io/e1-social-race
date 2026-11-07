"""Collab verifier: counts valid ENHYPEN voting proofs (MAMA certificates) sent by partner fandoms.

Every proof is analysed on the server: the last image must match an ENHYPEN reference, the
certificate ID is read by two independent OCR passes that must agree, and the ID must be unique.
Anything that cannot be verified with certainty goes to a manual review queue.
"""
import csv
import hashlib
import itertools
import io
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from urllib.parse import urlencode, urlsplit

from PIL import Image, ImageOps

try:  # iPhone photos and screenshots can be HEIC/HEIF: readable when pillow-heif is installed (it is in the Docker image)
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIF = True
except ImportError:
    HEIF = False

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
    -- A private link to the report of one batch (collab + proofs date): whoever holds it can review that batch only.
    CREATE TABLE IF NOT EXISTS collab_shares(submission_id INTEGER PRIMARY KEY REFERENCES collab_submissions(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE, created_at REAL NOT NULL);
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
    if not c.execute("SELECT 1 FROM collab_meta WHERE k='fold_index'").fetchone():  # one-time: look-alike keys for the IDs already counted
        for row in c.execute("SELECT cert_id FROM collab_proofs WHERE status='valid' AND cert_id IS NOT NULL").fetchall():
            c.execute('INSERT INTO collab_mask(k,cert_id) VALUES(?,?)', (fold_key(row[0]), row[0]))
        c.execute("INSERT INTO collab_meta(k,v) VALUES('fold_index','1')")


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
UNREADABLE = 'Cannot open the image'


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


def scaled_vector(im, slot, sx, sy, dx, dy):
    """Like slot_vector, for a thumbnail that is `sx` times as wide and `sy` times as tall as the standard slot and moved by (dx, dy)."""
    box = THUMB_SLOTS[slot]
    cx, cy = (box[0] + box[2]) / 2 + dx, (box[1] + box[3]) / 2 + dy
    hw, hh = (box[2] - box[0]) * sx * 0.4, (box[3] - box[1]) * sy * 0.4  # the 10% trim of slot_vector, on each side
    small = crop(im, (cx - hw, cy - hh, cx + hw, cy + hh)).resize((24, 24), Image.LANCZOS)
    values = list(small.tobytes())
    mean = sum(values) / len(values)
    values = [v - mean for v in values]
    norm = sum(v * v for v in values) ** 0.5 or 1.0
    return [v / norm for v in values]


def align(im, slot, target, stop=0.97):
    """Best similarity of a thumbnail with `target` when its position and size differ from the standard layout.

    Some devices and app versions draw the thumbnails a little wider or lower; the same photo then scores
    0.4-0.8 in the standard slot and above 0.99 once the window is aligned. A coarse search over size and
    position is refined by a few rounds of small moves. Returns the best similarity found.
    """
    def score(p):
        return correlation(scaled_vector(im, slot, *p), target)

    seeds = sorted(((score((sx, 1.0, dx, dy)), (sx, 1.0, dx, dy)) for sx in (0.9, 0.96, 1.02, 1.08, 1.14)
                    for dx in (-0.03, -0.015, 0.0, 0.015, 0.03) for dy in (-0.02, 0.0, 0.02)), reverse=True)
    best = -1.0
    for value, point in seeds[:2]:
        step = [0.03, 0.03, 0.01, 0.01]
        while step[2] > 0.0015 and value < stop:
            moved = False
            for i in range(4):
                for sign in (-1, 1):
                    candidate = list(point)
                    candidate[i] += sign * step[i]
                    got = score(candidate)
                    if got > value:
                        value, point, moved = got, tuple(candidate), True
            if not moved:
                step = [v / 2 for v in step]
        best = max(best, value)
        if best >= stop:
            break
    return best


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
    return abs(im.width / im.height / RATIO - 1) < 0.08


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


def squash(text):
    s = re.sub(r'[^A-Z0-9]', '', text.upper())
    return s if 16 <= len(s) <= 18 else None  # "N" or "NO" from "No." may be glued in front; a stray character may be inserted


def parse_id(text):
    """The 16-character ID inside one raw reading, when it is unambiguous."""
    s = squash(text) or ''
    if len(s) == 18 and s[:2] in ('NO', 'N0'):
        s = s[2:]
    elif len(s) == 17 and s[0] == 'N':  # the lower-case "o" of "No." is outside the character whitelist
        s = s[1:]
    return s if ID_RE.fullmatch(s) else None


def forms(reading):
    """Every 16-character ID a raw reading can stand for: the "No." prefix and stray inserted characters
    (the font is tightly spaced and OCR adds a character here and there) are removed in every possible way.
    The true ID is among the forms of every reading that has no wrong character; a wrong one is in few."""
    if not reading:
        return set()
    if len(reading) > 16 and reading[0] == 'N':  # "No." read as "N": always a prefix, never part of the ID
        reading = reading[1:]
    if len(reading) == 16:
        return {reading}
    return {''.join(ch for i, ch in enumerate(reading) if i not in drop)
            for drop in itertools.combinations(range(len(reading)), len(reading) - 16)}


def tally(readings):
    """[(ID, number of readings that can stand for it)], best first; ties keep the order of the readings."""
    votes, order = {}, []
    for reading in readings:
        for form in forms(reading):
            if form not in votes:
                votes[form] = 0
                order.append(form)
            votes[form] += 1
    return sorted(((f, votes[f]) for f in order), key=lambda x: -x[1])


def read_ids(im):
    """Independent OCR readings of the "No. <ID>" line: different heights, plain and binarised.

    The wide box tolerates a few pixels of misalignment. Three readings are taken first; when they
    all agree that is enough, otherwise up to five more are added.
    """
    strip = crop(im, ID_BOX).convert('L')

    def variant(height, binarise=False):
        scale = min(8.0, max(1.0, height / strip.height))
        img = ImageOps.autocontrast(strip.resize((round(strip.width * scale), round(strip.height * scale)), Image.LANCZOS))
        if binarise:
            img = img.point(lambda p: 255 if p > 150 else 0)
        return squash(tesseract(ImageOps.expand(img, 24, fill=255)))

    plan = [(110, False), (150, True), (200, False), (110, True), (200, True), (150, False), (260, True), (130, True)]
    readings = []
    for i, (height, binarise) in enumerate(plan):
        readings.append(variant(height, binarise))
        ranked = tally(readings)
        if i >= 2 and ranked and ranked[0][1] == sum(1 for r in readings if r) >= 3 and len(ranked) == 1:
            break
    return readings


def consensus(readings):
    """The ID the readings agree on, or None. The leader needs two votes, more than half of the valid
    readings and a margin of two over the runner-up (unless every valid reading is identical)."""
    found = [r for r in readings if r]
    ranked = tally(found)
    if len(found) < 2 or not ranked:
        return None
    top, votes = ranked[0]
    runner = ranked[1][1] if len(ranked) > 1 else 0
    if votes >= 2 and votes * 2 > len(found) and (votes >= runner + 2 or votes == len(found)):
        return top
    return None


CONFUSABLE = ('0OQD9', '1IL', '5S9', '8BS', '2Z', '6G', 'A4', 'UV')  # groups overlap on purpose: 9 looks like 0 and like S


def _classes():
    classes = []
    for group in CONFUSABLE:
        merged = set(group)
        for other in [c for c in classes if c & merged]:
            merged |= other
            classes.remove(other)
        classes.append(merged)
    return {ch: min(c) for c in classes for ch in c}


FOLD = _classes()


def fold(cert_id):
    return ''.join(FOLD.get(ch, ch) for ch in cert_id or '')


def unsure_guess(readings):
    """The best guess when the OCR is not sure, or None when there is no basis for one.

    Accepted: a single candidate, a candidate with more votes than any other, or candidates that differ
    only in look-alike characters (O/0, I/1, S/5, B/8...). A tie between really different IDs is not guessed.
    """
    ranked = tally([r for r in readings if r])
    if not ranked:
        return None
    top, votes = ranked[0]
    if len(ranked) == 1 or votes > ranked[1][1]:
        return top
    if all(fold(other) == fold(top) for other, _ in ranked):
        return top
    return None


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


def fold_key(cert_id):
    return 'F:' + fold(cert_id)


def add_mask(c, cert_id):
    # one more key per ID: the ID with every look-alike character (O/0, 1/I, 5/S...) folded, to find look-alike twins
    c.executemany('INSERT INTO collab_mask(k,cert_id) VALUES(?,?)', [(k, cert_id) for k in mask_keys(cert_id) + [fold_key(cert_id)]])


def look_alike(c, cert_id):
    """A counted ID that is the same as this one except for look-alike characters, with its proof, or None."""
    return c.execute('''SELECT m.cert_id, s.fandom, s.day FROM collab_mask m
        JOIN collab_proofs p ON p.cert_id=m.cert_id AND p.status='valid'
        JOIN collab_submissions s ON s.id=p.submission_id
        WHERE m.k=? AND m.cert_id!=? LIMIT 1''', (fold_key(cert_id), cert_id)).fetchone()


def decide_id(c, cert_id, sure):
    """Outcome of an ID once it is read: (status, reason). `sure` is False when the OCR did not fully confirm it.

    An ID is valid unless it is already counted, one character from a counted ID, or the same as a counted ID
    apart from look-alike characters (O for 0, 9 for S, I for 1...). An ID the OCR did not fully confirm is
    accepted too when none of that holds: the image already passed every other check, so the ID only has to be
    told apart from the others.
    """
    same = exact_cert(c, cert_id)
    if same:
        return 'duplicate', f"Already counted for {same['fandom']} on {same['day']}"
    near = near_cert(c, cert_id)
    if near:
        return 'manual', f"ID differs by one character from {near['cert_id']} ({near['fandom']}, {near['day']}): possible duplicate or misread"
    twin = look_alike(c, cert_id)
    if twin:  # the OCR confuses O/0, 1/I, 5/S...: the same certificate can be read two ways, even when the reading looks sure
        return 'manual', f"Looks like {twin['cert_id']} ({twin['fandom']}, {twin['day']}) apart from look-alike characters: possible duplicate"
    return ('valid', '') if sure else ('valid', 'ID not fully confirmed by the OCR; no similar ID is counted')


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
        return 'manual', UNREADABLE, None, None, None
    im, screenshot = normalise(im)  # a phone screenshot is reduced to the certificate card
    shifts = SHOT_SHIFTS if screenshot else NO_SHIFT

    def match(slot, targets):
        """Best similarity of one thumbnail with any target; screenshots are tried at a few small offsets.
        When nothing matches at the standard position the thumbnail is searched for (position and size)."""
        best = -1.0
        for dx, dy in shifts:
            v = slot_vector(im, slot, dx, dy)
            best = max(best, max(correlation(v, t) for t in targets))
        if best < T_OK:
            best = max(best, *(align(im, slot, t) for t in targets[:4]))
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
    ranked = tally([r for r in readings if r])
    if not ranked:
        return 'manual', 'Certificate ID not readable', None, last, thumb
    best = consensus(readings)
    if best:
        return 'ok', '', best, last, None
    likely = unsure_guess(readings)
    if likely:  # decided by process() against the IDs already counted
        return 'unsure', 'The OCR could not confirm the ID' if len(ranked) == 1 else 'The OCR readings of the ID disagree', likely, last, thumb
    return 'manual', 'The OCR readings of the ID disagree', ranked[0][0], last, thumb


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
        if again and again['status'] == 'manual' and again['reason'] == UNREADABLE and open_image(data) is not None:
            c.execute('DELETE FROM collab_proofs WHERE id=?', (again['id'],))   # it could not be opened before (e.g. HEIC) and now it can: check it for real
            again = None
        profile = c.execute('SELECT id,name,slots FROM collab_collabs WHERE name=?', (fandom,)).fetchone()
        if not profile:
            raise ValueError(f'"{fandom}" is not a defined collab. Add it in the Collabs section first.')
        fandom = profile['name']
        if not again:  # the same file (same bytes, same name) already in this run, sent another way (Drive, folder, images): a repeat, not a duplicate
            same = c.execute('''SELECT p.id,p.status,p.reason,p.cert_id,s.fandom,s.day FROM collab_proofs p JOIN collab_submissions s ON s.id=p.submission_id
                WHERE p.sha256=? AND s.fandom=? AND s.day=? AND p.file_name=? LIMIT 1''', (sha, fandom, day, file_name)).fetchone()
            again = None if same is None else {**dict(same), 'repeat': True}
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
            coalesce(sum(p.status='rejected'),0) rejected, (SELECT token FROM collab_shares WHERE submission_id=s.id) share_token,
            coalesce(sum(p.status='duplicate' AND EXISTS(SELECT 1 FROM collab_proofs q WHERE q.submission_id=p.submission_id AND q.sha256=p.sha256
              AND q.file_name=p.file_name AND q.id<p.id)),0) repeats
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
# What a new check can change in each review list: the ID could not be read, or an image was not recognised.
RETRY_KINDS = {
    'manual': f"p.status='manual' AND (p.reason IN ({','.join(repr(r) for r in OCR_REASONS)}) OR p.reason LIKE '%image is unclear%' OR p.reason LIKE 'Non-standard layout%')",
    'groups': REVIEW_KINDS['groups'],
    'partner': REVIEW_KINDS['partner'],
}


def queue(offset, limit, kind='manual'):
    if kind not in REVIEW_KINDS:
        raise ValueError('Unknown review list')
    with storage.connection() as c:
        counts = {k: c.execute(f'SELECT count(*) FROM collab_proofs p WHERE {w}').fetchone()[0] for k, w in REVIEW_KINDS.items()}
        pending = c.execute(f'SELECT count(*) FROM collab_proofs p WHERE {retry_where(kind)}').fetchone()[0]
        items = [dict(r) for r in c.execute(f'''SELECT p.id,s.fandom,s.day,p.file_name,p.status,p.reason,p.cert_id,p.similarity,p.thumb IS NOT NULL has_image
            FROM collab_proofs p JOIN collab_submissions s ON s.id=p.submission_id WHERE {REVIEW_KINDS[kind]}
            ORDER BY p.id LIMIT ? OFFSET ?''', (limit, offset))]
    return {'total': counts[kind], 'items': items, 'counts': counts, 'retry_pending': pending}


def known(keys):
    found = []
    with storage.connection() as c:
        for i in range(0, len(keys), 500):
            chunk = [clean(k, 500) for k in keys[i:i + 500]]
            # files that could not be opened before are not "done": picking the folder again tries them again (e.g. after HEIC support)
            found += [r[0] for r in c.execute(f"SELECT file_key FROM collab_proofs WHERE file_key IN ({','.join('?' * len(chunk))}) AND NOT (status='manual' AND reason=?)", chunk + [UNREADABLE])]
    return found


def export_csv(kind, day='', run=None):
    """CSV exports. `run` (a submission id) limits them to one verification run (collab + proofs date)."""
    out = io.StringIO()
    writer = csv.writer(out)
    if run:
        where_day, args = 'WHERE s.id=?', (run,)
    else:
        where_day, args = ('WHERE s.day=?', (day,)) if day else ('', ())
    with storage.connection() as c:
        if kind == 'full':
            writer.writerow(['fandom_collab', 'date', 'file', 'certificate_id', 'result', 'reason', 'reviewed_by'])
            for r in c.execute(f'''SELECT s.fandom,s.day,p.file_name,p.cert_id,p.status,p.reason,p.reviewed_by FROM collab_proofs p
                JOIN collab_submissions s ON s.id=p.submission_id {where_day} ORDER BY s.day,s.fandom COLLATE NOCASE,p.id''', args):
                writer.writerow(list(r))
        elif kind == 'stats':
            writer.writerow(['Fandom collab', 'Date', 'Files', 'Valid proofs', 'Duplicates', 'Not ENHYPEN', 'Wrong partner image', 'To review', 'Rejected'])
            for r in c.execute(f'''SELECT s.fandom, s.day, count(p.id), coalesce(sum(p.status='valid'),0), coalesce(sum(p.status='duplicate'),0),
                coalesce(sum(p.status='not_enhypen'),0), coalesce(sum(p.status='not_partner'),0), coalesce(sum(p.status='manual'),0),
                coalesce(sum(p.status='rejected'),0) FROM collab_submissions s LEFT JOIN collab_proofs p ON p.submission_id=s.id {where_day}
                GROUP BY s.id ORDER BY s.day,s.fandom COLLATE NOCASE''', args):
                writer.writerow(list(r))
        else:
            writer.writerow(['Fandom collab', 'Valid proofs', 'Date'])
            for r in c.execute(f'''SELECT s.fandom, coalesce(sum(p.status='valid'),0), s.day FROM collab_submissions s
                LEFT JOIN collab_proofs p ON p.submission_id=s.id {where_day} GROUP BY s.id ORDER BY s.day,s.fandom COLLATE NOCASE''', args):
                writer.writerow(list(r))
    return out.getvalue()


def export_name(kind, day, run=None):
    if run:
        with storage.connection() as c:
            row = c.execute('SELECT fandom,day FROM collab_submissions WHERE id=?', (run,)).fetchone()
        if not row:
            raise ValueError('Run not found')
        slug = re.sub(r'[^a-z0-9]+', '-', row['fandom'].lower()).strip('-') or 'collab'
        return f"mama-{'proofs-report' if kind == 'full' else 'stats'}-{slug}-{row['day']}.csv"
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
    best = consensus(readings)
    ranked = tally([r for r in readings if r])
    return {'cert_id': best or (ranked[0][0] if ranked else None), 'confident': bool(best)}


def reject(proof_id, actor):
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        done = c.execute("UPDATE collab_proofs SET status='rejected',reason='Rejected manually',reviewed_by=?,reviewed_at=? WHERE id=? AND status='manual'",
                         (actor, time.time(), proof_id)).rowcount
    if not done:
        raise ValueError('Proof not found or already reviewed')
    return {'ok': True}


# ---------------------------------------------------------------- report links (one per batch)
SHARE_KINDS = {
    'manual': REVIEW_KINDS['manual'],
    'groups': REVIEW_KINDS['groups'],
    'partner': REVIEW_KINDS['partner'],
    'rejected': "(p.status='rejected' OR (p.status IN ('not_enhypen','not_partner') AND p.reviewed_at IS NOT NULL))",
}


def share_create(submission_id, renew=False):
    """The private report link token of a batch. Made on first use; `renew` replaces it (the old link stops working)."""
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        if not c.execute('SELECT 1 FROM collab_submissions WHERE id=?', (submission_id,)).fetchone():
            raise ValueError('Batch not found')
        row = c.execute('SELECT token FROM collab_shares WHERE submission_id=?', (submission_id,)).fetchone()
        if row and not renew:
            return {'token': row['token']}
        token = secrets.token_urlsafe(24)
        c.execute('INSERT OR REPLACE INTO collab_shares(submission_id,token,created_at) VALUES(?,?,?)', (submission_id, token, time.time()))
    return {'token': token}


def share_revoke(submission_id):
    with storage.connection() as c:
        c.execute('DELETE FROM collab_shares WHERE submission_id=?', (submission_id,))
    return {'ok': True}


def share_batch(c, token):
    row = c.execute("""SELECT s.id,s.fandom,s.day FROM collab_shares h JOIN collab_submissions s ON s.id=h.submission_id
        WHERE h.token=?""", (clean(token, 80),)).fetchone()
    if not row:
        raise LookupError('This link is not valid any more. Ask for a new one.')
    return row


def anonymise(text):
    """Takes out what would tell a batch about the others: which collab or day an ID was counted for, and the other IDs."""
    text = re.sub(r'\s*\([^()]*, \d{4}-\d{2}-\d{2}\)', '', text or '')
    text = re.sub(r'(ounted) for .+? on \d{4}-\d{2}-\d{2}', r'\1 in another batch', text)
    text = re.sub(r'(?<=from |like )[A-Z0-9]{16}', 'an ID already counted', text)
    text = re.sub(r'Very similar to [A-Z0-9]{16}', 'Very similar to an ID already counted', text)
    return text


def report(token, kind='manual', offset=0, limit=10):
    if kind not in SHARE_KINDS:
        raise ValueError('Unknown list')
    with storage.connection() as c:
        batch = share_batch(c, token)
        counts = dict(c.execute('SELECT status, count(*) FROM collab_proofs WHERE submission_id=? GROUP BY status', (batch['id'],)).fetchall())
        lists = {k: c.execute(f'SELECT count(*) FROM collab_proofs p WHERE p.submission_id=? AND {w}', (batch['id'],)).fetchone()[0] for k, w in SHARE_KINDS.items()}
        items = [dict(r) for r in c.execute(f"""SELECT p.id,p.file_name,p.status,p.reason,p.cert_id,p.thumb IS NOT NULL has_image
            FROM collab_proofs p WHERE p.submission_id=? AND {SHARE_KINDS[kind]} ORDER BY p.id LIMIT ? OFFSET ?""", (batch['id'], limit, offset))]
    for item in items:
        item['reason'] = anonymise(item['reason'])
    counts = {k: counts.get(k, 0) for k in STATUSES}
    counts['files'] = sum(counts.values())
    return {'fandom': batch['fandom'], 'day': batch['day'], 'counts': counts, 'lists': lists, 'items': items, 'total': lists[kind]}


def report_image(token, proof_id):
    with storage.connection() as c:
        batch = share_batch(c, token)
        row = c.execute('SELECT thumb FROM collab_proofs WHERE id=? AND submission_id=?', (proof_id, batch['id'])).fetchone()
    if not row or not row['thumb']:
        raise LookupError('Image not found')
    return bytes(row['thumb'])


def report_csv(token):
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(['file', 'certificate_id', 'result', 'reason'])
    with storage.connection() as c:
        batch = share_batch(c, token)
        for r in c.execute('SELECT file_name,cert_id,status,reason FROM collab_proofs WHERE submission_id=? ORDER BY id', (batch['id'],)):
            writer.writerow([r['file_name'], r['cert_id'] or '', r['status'], anonymise(r['reason'])])
    return out.getvalue(), batch


def report_act(token, proof_id, action, payload):
    """Approve, reject, confirm or re-read a proof of this batch, with the same rules as the administrator's review."""
    with storage.connection() as c:
        batch = share_batch(c, token)
        if not c.execute('SELECT 1 FROM collab_proofs WHERE id=? AND submission_id=?', (proof_id, batch['id'])).fetchone():
            raise LookupError('This proof is not part of this report.')
    actor = f"link:{batch['fandom']} {batch['day']}"
    try:
        if action == 'approve':
            result = approve(proof_id, payload.get('cert_id', ''), bool(payload.get('confirm_similar')), actor)
        elif action == 'keep':
            result = keep(proof_id, actor)
        elif action == 'read':
            result = read_proof_id(proof_id)
        else:
            result = reject(proof_id, actor)
    except ValueError as exc:
        raise ValueError(anonymise(str(exc)))
    if 'message' in result:
        result['message'] = anonymise(result['message'])
    return result


def report_get(path, query):
    """Public GET routes of a batch report (the link is the credential): (status, body, content type[, headers]) or None."""
    match = re.fullmatch(r'/api/report/([\w-]{20,64})(?:/(proofs/(\d+)/image|export\.csv))?', path)
    if not match:
        return None
    token = match[1]
    try:
        if match[3]:
            return 200, report_image(token, int(match[3])), 'image/jpeg'
        if match[2]:
            text, batch = report_csv(token)
            name = re.sub(r'[^\w-]+', '-', f"{batch['fandom']}-{batch['day']}").strip('-')
            return 200, text, 'text/csv; charset=utf-8', {'Content-Disposition': f'attachment; filename="proofs-{name}.csv"'}
        first = lambda name, default: (query.get(name) or [default])[0]
        return 200, report(token, first('kind', 'manual'), max(0, int(first('offset', '0'))), min(50, max(1, int(first('limit', '10'))))), 'application/json; charset=utf-8'
    except LookupError as exc:
        return 404, {'error': str(exc)}, 'application/json; charset=utf-8'


def report_post(path, payload):
    match = re.fullmatch(r'/api/report/([\w-]{20,64})/proofs/(\d+)/(approve|reject|keep|read)', path)
    if not match:
        return None
    return report_act(match[1], int(match[2]), match[3], payload)


def delete_run(submission_id, actor):
    """Removes a whole verification run (collab + proofs date), e.g. one started for the wrong collab.

    Its proofs disappear as if never uploaded: the IDs it had counted are free again, its files can be uploaded or
    imported again (also for another collab), and its report link stops working. A proof of another run that had been
    set aside as a duplicate of one of those IDs becomes the counted one, so nothing else is lost.
    """
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        run = c.execute('SELECT id,fandom,day FROM collab_submissions WHERE id=?', (submission_id,)).fetchone()
        if not run:
            raise ValueError('Run not found')
        with IMPORT_LOCK:
            if IMPORT['running'] and (IMPORT['fandom'], IMPORT['day']) == (run['fandom'], run['day']):
                raise ValueError('A Drive import is running for this run: stop it first')
        counted = [r[0] for r in c.execute("SELECT cert_id FROM collab_proofs WHERE submission_id=? AND status='valid' AND cert_id IS NOT NULL", (submission_id,))]
        files = c.execute('SELECT count(*) FROM collab_proofs WHERE submission_id=?', (submission_id,)).fetchone()[0]
        c.execute('DELETE FROM collab_proofs WHERE submission_id=?', (submission_id,))
        c.execute('DELETE FROM collab_shares WHERE submission_id=?', (submission_id,))
        c.execute('DELETE FROM collab_submissions WHERE id=?', (submission_id,))
        promoted = 0
        for cert_id in counted:
            c.execute('DELETE FROM collab_mask WHERE cert_id=?', (cert_id,))
            heir = c.execute("SELECT id FROM collab_proofs WHERE cert_id=? AND status='duplicate' ORDER BY id LIMIT 1", (cert_id,)).fetchone()
            if heir:
                c.execute("UPDATE collab_proofs SET status='valid',reason='Counted after an earlier run was removed',reviewed_by=?,reviewed_at=? WHERE id=?",
                          (actor, time.time(), heir['id']))
                add_mask(c, cert_id)
                promoted += 1
    logging.info('Run %s %s removed by %s: %d files, %d IDs freed, %d duplicates promoted', run['fandom'], run['day'], actor, files, len(counted), promoted)
    return {'ok': True, 'files': files, 'freed': len(counted) - promoted, 'promoted': promoted}


def tidy_run(submission_id):
    """Removes the duplicates of a run that are the same file sent twice (same bytes and name), e.g. a folder uploaded again after an import."""
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        if not c.execute('SELECT 1 FROM collab_submissions WHERE id=?', (submission_id,)).fetchone():
            raise ValueError('Run not found')
        removed = c.execute("""DELETE FROM collab_proofs WHERE submission_id=? AND status='duplicate' AND EXISTS(
            SELECT 1 FROM collab_proofs q WHERE q.submission_id=collab_proofs.submission_id AND q.sha256=collab_proofs.sha256
            AND q.file_name=collab_proofs.file_name AND q.id<collab_proofs.id)""", (submission_id,)).rowcount
    return {'ok': True, 'removed': removed}


def retry_where(kind):
    """The review proofs a new check can change, from their stored preview. 'all' is every list at once."""
    if kind != 'all' and kind not in RETRY_KINDS:
        raise ValueError('Unknown review list')
    wanted = RETRY_KINDS.values() if kind == 'all' else [RETRY_KINDS[kind]]
    return '(' + ' OR '.join(f'({w})' for w in wanted) + ') AND p.thumb IS NOT NULL'


def reprocess_review(apply=False, progress=None, kind='all'):
    """Checks again the proofs waiting in review, from their stored preview, with the current checker.

    The preview is the certificate card at 640 px, enough for the current checker. A proof is checked like a
    fresh upload (ENHYPEN image, partner image, ID): when it now passes it is counted, marked duplicate, or kept for
    review when the ID is one character (or only look-alike characters) from a counted ID. A proof the system had
    rejected as another group or wrong partner image whose images now match but whose ID needs a person moves to
    the verify list. Proofs that still fail are left untouched. Returns the counts.
    """
    done = {'eligible': 0, 'valid': 0, 'duplicate': 0, 'near': 0, 'review': 0, 'unchanged': 0}
    with storage.connection() as c:
        ids = [r['id'] for r in c.execute(f'SELECT p.id FROM collab_proofs p WHERE {retry_where(kind)} ORDER BY p.id')]
    done['eligible'] = len(ids)
    if not apply:
        return done
    with storage.connection() as c:
        refs = [json.loads(r['vec']) for r in c.execute('SELECT vec FROM collab_refs WHERE collab_id IS NULL')]
    partners = {}
    for n, proof_id in enumerate(ids, 1):
        outcome = 'unchanged'
        with storage.connection() as c:
            row = c.execute("""SELECT p.thumb,p.status,s.fandom FROM collab_proofs p JOIN collab_submissions s ON s.id=p.submission_id
                WHERE p.id=? AND p.status IN ('manual','not_enhypen','not_partner')""", (proof_id,)).fetchone()
            if row and refs and row['fandom'] not in partners:
                profile = c.execute('SELECT id,name,slots FROM collab_collabs WHERE name=?', (row['fandom'],)).fetchone()
                slots = json.loads(profile['slots']) if profile else None
                vecs = [json.loads(r['vec']) for r in c.execute('SELECT vec FROM collab_refs WHERE collab_id=?', (profile['id'],))] if slots else []
                partners[row['fandom']] = False if profile is None or (slots and not vecs) else ({'name': profile['name'], 'slots': slots, 'vecs': vecs} if slots else None)
        if row and refs and partners.get(row['fandom']) is not False:
            with SLOTS:  # shares the CPU budget with uploads
                status, reason, cert_id, sim, _ = analyse(bytes(row['thumb']), refs, partners[row['fandom']])
            if status in ('ok', 'unsure'):
                with storage.connection() as c:
                    c.execute('BEGIN IMMEDIATE')
                    if c.execute("SELECT 1 FROM collab_proofs WHERE id=? AND status IN ('manual','not_enhypen','not_partner')", (proof_id,)).fetchone():
                        verdict, why = decide_id(c, cert_id, status == 'ok')
                        if verdict == 'duplicate':
                            c.execute("UPDATE collab_proofs SET status='duplicate',cert_id=?,reason=?,similarity=?,thumb=NULL,reviewed_by='reprocess',reviewed_at=? WHERE id=?",
                                      (cert_id, why, sim, time.time(), proof_id))
                            outcome = 'duplicate'
                        elif verdict == 'manual':
                            c.execute("UPDATE collab_proofs SET status='manual',cert_id=?,reason=?,similarity=? WHERE id=?", (cert_id, why, sim, proof_id))
                            outcome = 'near'
                        else:
                            c.execute("UPDATE collab_proofs SET status='valid',cert_id=?,reason=?,similarity=?,thumb=NULL,reviewed_by='reprocess',reviewed_at=? WHERE id=?",
                                      (cert_id, why or 'Checked again automatically', sim, time.time(), proof_id))
                            add_mask(c, cert_id)
                            outcome = 'valid'
            elif status == 'manual' and row['status'] != 'manual' and reason in OCR_REASONS:
                # the images are right now, only the ID needs a person
                with storage.connection() as c:
                    c.execute('BEGIN IMMEDIATE')
                    moved = c.execute("UPDATE collab_proofs SET status='manual',cert_id=?,reason=?,similarity=? WHERE id=? AND status IN ('not_enhypen','not_partner')",
                                      (cert_id, reason, sim, proof_id)).rowcount
                outcome = 'review' if moved else 'unchanged'
        done[outcome] += 1
        if progress:
            progress(n, len(ids))
    return done


JOB = {'running': False, 'done': 0, 'total': 0, 'result': None, 'error': None}
JOB_LOCK = threading.Lock()


def reprocess_status():
    with JOB_LOCK:
        return dict(JOB)


def reprocess_start(kind='all'):
    """Starts checking the review proofs again in the background (one run at a time)."""
    retry_where(kind)  # validates the list
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
            result = reprocess_review(apply=True, progress=progress, kind=kind)
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


# ---------------------------------------------------------------- import from Google Drive
# The server reads a public Drive folder (or file) itself, so nothing has to be downloaded on the organiser's device.
# It needs a Google API key (Drive API) in GOOGLE_API_KEY; the folder must be shared as "anyone with the link".
GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY', '').strip()
DRIVE_API = 'https://www.googleapis.com/drive/v3/files'
DRIVE_ID = r'[A-Za-z0-9_-]{10,100}'
DRIVE_FOLDER = 'application/vnd.google-apps.folder'
DRIVE_LANES = 2          # files downloaded and checked at the same time
DRIVE_MAX_FILES = 60000
DRIVE_MAX_DEPTH = 8
IMAGE_NAME = re.compile(r'\.(png|jpe?g|webp|gif|bmp|heic|heif)$', re.I)
IMPORT_LOCK = threading.Lock()
IMPORT = {'running': False, 'stopping': False, 'phase': '', 'source': '', 'fandom': '', 'day': '', 'found': 0, 'skipped': 0, 'total': 0, 'done': 0, 'began': 0.0,
          'counts': {}, 'failed': 0, 'refused': 0, 'errors': [], 'error': None, 'started': 0.0, 'finished': 0.0}


class DriveError(Exception):
    def __init__(self, message, retry=False):
        super().__init__(message)
        self.retry = retry


def drive_target(url):
    """('folder' | 'file' | 'any', id) from a Google Drive link."""
    url = clean(url, 500)
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or parts.hostname not in ('drive.google.com', 'docs.google.com'):
        raise ValueError('Paste a Google Drive link (drive.google.com)')
    for pattern, kind in ((rf'/folders/({DRIVE_ID})', 'folder'), (rf'/file/d/({DRIVE_ID})', 'file'), (rf'[?&]id=({DRIVE_ID})', 'any')):
        found = re.search(pattern, url)
        if found:
            return kind, found[1]
    raise ValueError('This does not look like a link to a Drive folder or file')


DRIVE_PACE = max(0.0, float(os.getenv('GOOGLE_DRIVE_DELAY', '0.4')))   # seconds between requests to Google, shared by every lane
DRIVE_WAITS = (5, 20, 60, 120)                                            # waits before each retry when Google is limiting
DRIVE_GATE = threading.Lock()
DRIVE_NEXT = [0.0]
DRIVE_GIVE_UP = 5       # this many files in a row refused: stop and ask to try again later


def drive_pace(cooldown=0.0):
    """Spaces the requests out (Google throttles bursts) and, after a refusal, holds all lanes back for `cooldown` seconds."""
    with DRIVE_GATE:
        now = time.time()
        if cooldown:
            DRIVE_NEXT[0] = max(DRIVE_NEXT[0], now + cooldown)
            return
        wait = max(0.0, DRIVE_NEXT[0] - now)
        DRIVE_NEXT[0] = max(now, DRIVE_NEXT[0]) + DRIVE_PACE
    if wait:
        time.sleep(wait)


def drive_reason(body):
    try:
        error = json.loads(body)['error']
        return (error.get('errors') or [{}])[0].get('reason') or error.get('message') or ''
    except (ValueError, KeyError, TypeError, AttributeError):
        return ''


def drive_open(url, limit=None, soft=False):
    """GET to the Drive API with the key; raises DriveError with a message people can act on.

    `soft`: a file download in the middle of an import. Google answers "not found" or "forbidden" there when it is
    throttling, so these answers are treated as "try again later" and not as "this is not shared".
    """
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/json'}), timeout=60) as response:
            return response.read(limit) if limit else response.read()
    except urllib.error.HTTPError as error:
        body = error.read(2000).decode('utf-8', 'ignore')
        reason = drive_reason(body)
        detail = f'HTTP {error.code}' + (f', {reason}' if reason else '')
        if error.code in (429, 500, 502, 503, 504) or 'ateLimit' in body or 'uotaExceeded' in body:
            raise DriveError(f'Google is limiting the downloads right now ({detail})', retry=True)
        if error.code == 400 and 'API key' in body:
            raise DriveError('The Google API key is not valid: check GOOGLE_API_KEY')
        if error.code == 403 and ('accessNotConfigured' in body or 'has not been used' in body or 'SERVICE_DISABLED' in body):
            raise DriveError('The Drive API is not enabled for this API key: enable it in Google Cloud')
        if error.code in (401, 403, 404):
            if soft:
                raise DriveError(f'Google refused this download ({detail}); it is most likely limiting downloads', retry=True)
            raise DriveError(f'Google Drive says this is not found or not shared ({detail}). Set it to "Anyone with the link can view".')
        raise DriveError(f'Google Drive answered {detail}')
    except (urllib.error.URLError, TimeoutError, OSError):
        raise DriveError('Could not reach Google Drive', retry=True)


def drive_call(url, limit=None, soft=False):
    for attempt in range(len(DRIVE_WAITS) + 1):
        drive_pace()
        try:
            return drive_open(url, limit, soft)
        except DriveError as error:
            if not error.retry or attempt == len(DRIVE_WAITS):
                raise
            drive_pace(DRIVE_WAITS[attempt])   # every lane waits, not only this one


def drive_json(file_id=None, **params):
    params['key'] = GOOGLE_API_KEY
    params.setdefault('supportsAllDrives', 'true')
    return json.loads(drive_call(f"{DRIVE_API}{'/' + file_id if file_id else ''}?{urlencode(params)}"))


def drive_bytes(file_id):
    query = urlencode({'alt': 'media', 'key': GOOGLE_API_KEY, 'supportsAllDrives': 'true'})
    data = drive_call(f'{DRIVE_API}/{file_id}?{query}', MAX_UPLOAD + 1, soft=True)
    if len(data) > MAX_UPLOAD:
        raise ValueError(f'The image is larger than {MAX_UPLOAD // 1048576} MB')
    return data


def drive_files(kind, root):
    """Images found at the link, as (id, path): the file itself, or the folder with its sub-folders."""
    meta = drive_json(root, fields='id,name,mimeType')
    if meta.get('mimeType') != DRIVE_FOLDER:
        if kind == 'folder':
            raise ValueError('This link is not a folder')
        if meta.get('mimeType', '').startswith('image/') or IMAGE_NAME.search(meta.get('name', '')):
            yield meta['id'], meta['name']
        return
    stack = [(root, '', 0)]
    while stack:
        folder, prefix, depth = stack.pop()
        token = None
        while True:
            params = {'q': f"'{folder}' in parents and trashed=false", 'fields': 'nextPageToken,files(id,name,mimeType)', 'pageSize': 1000,
                      'includeItemsFromAllDrives': 'true'}
            if token:
                params['pageToken'] = token
            page = drive_json(None, **params)
            for item in page.get('files', []):
                if item.get('mimeType') == DRIVE_FOLDER:
                    if depth < DRIVE_MAX_DEPTH:
                        stack.append((item['id'], f"{prefix}{item['name']}/", depth + 1))
                elif item.get('mimeType', '').startswith('image/') or IMAGE_NAME.search(item.get('name', '')):
                    yield item['id'], f"{prefix}{item['name']}"
            token = page.get('nextPageToken')
            if not token:
                break


def import_status():
    with IMPORT_LOCK:
        return {**IMPORT, 'counts': dict(IMPORT['counts']), 'errors': list(IMPORT['errors']), 'configured': bool(GOOGLE_API_KEY)}


def import_start(url, fandom, day, actor):
    if not GOOGLE_API_KEY:
        raise ValueError('Google Drive import is not set up: add GOOGLE_API_KEY to the server settings')
    kind, root = drive_target(url)
    fandom, day = clean(fandom, 80), proofs_day(day)
    with storage.connection() as c:
        profile = c.execute('SELECT name FROM collab_collabs WHERE name=?', (fandom,)).fetchone()
    if not profile:
        raise ValueError(f'"{fandom}" is not a defined collab')
    fandom = profile['name']
    with IMPORT_LOCK:
        if IMPORT['running']:
            raise ValueError('A Drive import is already running: wait for it or stop it')
        IMPORT.update(running=True, stopping=False, phase='listing', source=clean(url, 200), fandom=fandom, day=day, found=0, skipped=0, total=0, done=0,
                      counts={}, failed=0, refused=0, errors=[], error=None, started=time.time(), finished=0.0)

    def note(error, name):
        with IMPORT_LOCK:
            IMPORT['failed'] += 1
            IMPORT['errors'].append(f'{name}: {error}')
            del IMPORT['errors'][:-8]

    def run():
        try:
            found = []
            for item in drive_files(kind, root):
                if IMPORT['stopping']:
                    return
                found.append(item)
                with IMPORT_LOCK:
                    IMPORT['found'] = len(found)
                if len(found) >= DRIVE_MAX_FILES:
                    break
            done_keys = set(known([f'drive:{i}' for i, _ in found]))
            todo = [(i, p) for i, p in found if f'drive:{i}' not in done_keys]
            with IMPORT_LOCK:
                IMPORT.update(phase='checking', skipped=len(found) - len(todo), total=len(todo), began=time.time())
            queue = iter(todo)
            queue_lock = threading.Lock()

            def lane():
                while not IMPORT['stopping']:
                    with queue_lock:
                        item = next(queue, None)
                    if item is None:
                        return
                    file_id, path = item
                    try:
                        result = process(fandom, path, f'drive:{file_id}', drive_bytes(file_id), actor, day)
                        with IMPORT_LOCK:
                            IMPORT['counts'][result['status']] = IMPORT['counts'].get(result['status'], 0) + 1
                            IMPORT['refused'] = 0
                    except DriveError as error:
                        note(error, path)
                        with IMPORT_LOCK:
                            IMPORT['refused'] += 1
                            if IMPORT['refused'] >= DRIVE_GIVE_UP and not IMPORT['stopping']:
                                IMPORT['stopping'] = True
                                IMPORT['error'] = 'Google keeps refusing the downloads, so the import was paused. Wait a while (10 minutes or more) and import the same link again: finished files are skipped.'
                    except ValueError as error:
                        note(error, path)
                    except Exception as error:
                        logging.exception('Drive import of %s failed', path)
                        note(error or 'Unexpected error', path)
                    with IMPORT_LOCK:
                        IMPORT['done'] += 1
            workers = [threading.Thread(target=lane, daemon=True) for _ in range(DRIVE_LANES)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join()
        except (DriveError, ValueError) as error:
            with IMPORT_LOCK:
                IMPORT['error'] = str(error)
        except Exception as error:
            logging.exception('Drive import failed')
            with IMPORT_LOCK:
                IMPORT['error'] = str(error) or 'Unexpected error'
        finally:
            with IMPORT_LOCK:
                IMPORT.update(running=False, phase='stopped' if IMPORT['stopping'] else 'done', finished=time.time())

    threading.Thread(target=run, daemon=True, name='collab-drive-import').start()
    return import_status()


def import_stop():
    with IMPORT_LOCK:
        if IMPORT['running']:
            IMPORT['stopping'] = True
    return import_status()


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
    if path == '/api/collab/import':
        return 200, import_status(), 'application/json; charset=utf-8'
    if path == '/api/collab/export.csv':
        kind = 'full' if (query.get('kind') or [''])[0] == 'full' else 'summary'
        day = clean((query.get('day') or [''])[0], 10)
        if day:
            day = proofs_day(day)
        run = int((query.get('run') or ['0'])[0]) or None
        if run and (query.get('kind') or [''])[0] == 'stats':
            kind = 'stats'
        headers = {'Content-Disposition': f'attachment; filename="{export_name(kind, day, run)}"'}
        return 200, export_csv(kind, day, run), 'text/csv; charset=utf-8', headers
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
    if path == '/api/collab/import/start':
        return import_start(payload.get('url', ''), payload.get('fandom', ''), payload.get('day'), actor)
    if path == '/api/collab/import/stop':
        return import_stop()
    if path == '/api/collab/reprocess/start':
        return reprocess_start(payload.get('kind') or 'all')
    match = re.fullmatch(r'/api/collab/proofs/(\d+)/(approve|reject|keep|read)', path)
    if match:
        if match[2] == 'approve':
            return approve(int(match[1]), payload.get('cert_id', ''), bool(payload.get('confirm_similar')), actor)
        if match[2] == 'keep':
            return keep(int(match[1]), actor)
        if match[2] == 'read':
            return read_proof_id(int(match[1]))
        return reject(int(match[1]), actor)
    match = re.fullmatch(r'/api/collab/submissions/(\d+)/tidy', path)
    if match:
        return tidy_run(int(match[1]))
    match = re.fullmatch(r'/api/collab/submissions/(\d+)/delete', path)
    if match:
        return delete_run(int(match[1]), actor)
    match = re.fullmatch(r'/api/collab/submissions/(\d+)/(share|share/renew|share/revoke)', path)
    if match:
        if match[2] == 'share/revoke':
            return share_revoke(int(match[1]))
        return share_create(int(match[1]), renew=match[2] == 'share/renew')
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
            print(f"Checked {result['eligible']} proofs again: {result['valid']} now valid, {result['duplicate']} duplicates, "
                  f"{result['near']} similar to a counted ID (still in review), {result['review']} moved to the verify list, {result['unchanged']} unchanged.")
        else:
            print(f"{result['eligible']} proofs in review can be checked again. Run with --yes to do it.")
    else:
        print('Usage: python collab.py reset-proofs --yes        (deletes every uploaded proof; keeps collabs and references)\n'
              '       python collab.py reprocess-review [--yes]   (checks again the review proofs the checker can change; without --yes only counts them)')
