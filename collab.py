"""Collab verifier: counts valid ENHYPEN voting proofs (MAMA certificates) sent by partner fandoms.

Every proof is analysed on the server: the last image must match an ENHYPEN reference, the
certificate ID is read by two independent OCR passes that must agree, and the ID must be unique.
Anything that cannot be verified with certainty goes to a manual review queue.
"""
import csv
import hashlib
import io
import json
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
ID_BOX = (0.125, 0.903, 0.585, 0.959)
ID_RE = re.compile(r'[A-Z0-9]{16}')
ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
STATUSES = ('valid', 'duplicate', 'not_enhypen', 'not_partner', 'manual', 'rejected')
SLOT_WORD = ('first', 'second', 'last')
RAW_POSTS = ('/api/collab/upload', '/api/collab/ref')


def init(c):
    c.executescript('''
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
    ''')


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


def slot_vector(im, slot):
    box = THUMB_SLOTS[slot]
    mx, my = (box[2] - box[0]) * 0.1, (box[3] - box[1]) * 0.1  # trims the rounded corners
    small = crop(im, (box[0] + mx, box[1] + my, box[2] - mx, box[3] - my)).resize((24, 24), Image.LANCZOS)
    values = list(small.tobytes())
    mean = sum(values) / len(values)
    values = [v - mean for v in values]
    norm = sum(v * v for v in values) ** 0.5 or 1.0
    return [round(v / norm, 5) for v in values]


def correlation(a, b):
    return sum(x * y for x, y in zip(a, b))


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
    run = subprocess.run([TESSERACT, 'stdin', 'stdout', '--psm', '7', '-l', 'eng', '-c', f'tessedit_char_whitelist={ALNUM}'],
                         input=out.getvalue(), capture_output=True, timeout=30, env=dict(os.environ, OMP_THREAD_LIMIT='1'))
    return run.stdout.decode('utf-8', 'ignore')


def parse_id(text):
    s = re.sub(r'[^A-Z0-9]', '', text.upper())
    if len(s) == 18 and re.match(r'N[O0]', s):
        s = s[2:]
    return s if ID_RE.fullmatch(s) else None


def read_ids(im):
    """Independent OCR readings of the ID line (different scaling and preprocessing).

    Two readings are always taken; a third (binarised) one only when they do not already agree.
    """
    strip = crop(im, ID_BOX).convert('L')

    def variant(scale, binarise=False):
        img = ImageOps.autocontrast(strip.resize((round(strip.width * scale), round(strip.height * scale)), Image.LANCZOS))
        if binarise:
            img = img.point(lambda p: 255 if p > 140 else 0)
        return parse_id(tesseract(ImageOps.expand(img, 24, fill=255)))

    readings = [variant(2), variant(3)]
    if not (readings[0] and readings[0] == readings[1]):
        readings.append(variant(3, binarise=True))
    return readings


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


# ---------------------------------------------------------------- upload pipeline
def clean(value, limit):
    return re.sub(r'\s+', ' ', str(value or '')).strip()[:limit]


def today():
    return datetime.now(TZ).strftime('%Y-%m-%d')


def submission(c, fandom):
    day = today()
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
    vecs = [slot_vector(im, slot) for slot in range(3)]
    sims = [[correlation(v, r) for r in refs] for v in vecs]
    last = max(sims[2])
    trusted = layout_ok(im)
    thumb = jpeg(im, 640, 65)
    if trusted and last < T_LOW:
        other = max(max(sims[0]), max(sims[1]))
        reason = 'ENHYPEN is not the last image' if other >= T_OK else 'The last image is not ENHYPEN'
        return 'not_enhypen', reason, None, last, thumb
    if last < T_OK:
        reason = f'The last image is unclear (similarity {last:.2f})' if trusted else 'Non-standard layout (cropped screenshot?)'
        return 'manual', reason, None, last, thumb
    if partner:
        fit = max(correlation(vecs[slot], v) for slot in partner['slots'] for v in partner['vecs'])
        if fit < T_LOW:
            return 'not_partner', f"The {partner['name']} image is not in the {where(partner['slots'])} position", None, fit, thumb
        if fit < T_OK:
            return 'manual', f"The {partner['name']} image is unclear (similarity {fit:.2f})", None, fit, thumb
    readings = ocr_ids(im)
    found = [r for r in readings if r]
    if not found:
        return 'manual', 'Certificate ID not readable', None, last, thumb
    best, votes = max(((r, found.count(r)) for r in found), key=lambda x: x[1])
    if votes >= 2:  # at least two independent readings agree
        return 'ok', '', best, last, None
    if len(set(found)) > 1:
        return 'manual', 'The OCR readings of the ID disagree', found[0], last, thumb
    return 'manual', 'The OCR could not confirm the ID', found[0], last, thumb


def ocr_ids(im):
    if not TESSERACT:
        raise ValueError('The OCR engine (tesseract) is not installed on the server')
    return read_ids(im)


def process(fandom, file_name, file_key, data, actor):
    fandom, file_name, file_key = clean(fandom, 80), clean(file_name, 300), clean(file_key, 500)
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
        sub = submission(c, fandom)
        if status == 'ok':
            thumb = None
            twin = c.execute('''SELECT s.fandom,s.day FROM collab_proofs p JOIN collab_submissions s ON s.id=p.submission_id
                WHERE p.sha256=? AND p.status='valid' LIMIT 1''', (sha,)).fetchone()
            same = exact_cert(c, cert_id)
            near = None if same else near_cert(c, cert_id)
            if twin or same:
                holder = twin or same
                status, reason = 'duplicate', f"Already counted for {holder['fandom']} on {holder['day']}"
            elif near:
                status, reason = 'manual', f"ID differs by one character from {near['cert_id']} ({near['fandom']}, {near['day']}): possible duplicate or misread"
                thumb = jpeg(open_image(data), 640, 65)
            else:
                status = 'valid'
        cur = c.execute('''INSERT INTO collab_proofs(submission_id,file_key,file_name,sha256,cert_id,status,reason,similarity,thumb,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)''', (sub['id'], file_key, file_name, sha, cert_id, status, reason, sim, thumb, time.time()))
        if status == 'valid':
            add_mask(c, cert_id)
        return {'id': cur.lastrowid, 'status': status, 'reason': reason, 'cert_id': cert_id, 'fandom': sub['fandom'], 'day': sub['day']}


# ---------------------------------------------------------------- references
def add_reference(label, data, collab_id=None, slot=None):
    """ENHYPEN reference (collab_id None: its last image) or a collab's partner reference (slot: where it sits in the sample)."""
    im = open_image(data)
    if im is None or not layout_ok(im):
        raise ValueError('Use a full, uncropped certificate image exported from Mnet Plus')
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


def queue(offset, limit):
    with storage.connection() as c:
        total = c.execute("SELECT count(*) FROM collab_proofs WHERE status='manual'").fetchone()[0]
        items = [dict(r) for r in c.execute('''SELECT p.id,s.fandom,s.day,p.file_name,p.reason,p.cert_id,p.similarity,p.thumb IS NOT NULL has_image
            FROM collab_proofs p JOIN collab_submissions s ON s.id=p.submission_id WHERE p.status='manual'
            ORDER BY p.id LIMIT ? OFFSET ?''', (limit, offset))]
    return {'total': total, 'items': items}


def known(keys):
    found = []
    with storage.connection() as c:
        for i in range(0, len(keys), 500):
            chunk = [clean(k, 500) for k in keys[i:i + 500]]
            found += [r[0] for r in c.execute(f"SELECT file_key FROM collab_proofs WHERE file_key IN ({','.join('?' * len(chunk))})", chunk)]
    return found


def export_csv(kind):
    out = io.StringIO()
    writer = csv.writer(out)
    with storage.connection() as c:
        if kind == 'full':
            writer.writerow(['fandom_collab', 'date', 'file', 'certificate_id', 'result', 'reason', 'reviewed_by'])
            for r in c.execute('''SELECT s.fandom,s.day,p.file_name,p.cert_id,p.status,p.reason,p.reviewed_by FROM collab_proofs p
                JOIN collab_submissions s ON s.id=p.submission_id ORDER BY s.day,s.fandom COLLATE NOCASE,p.id'''):
                writer.writerow(list(r))
        else:
            writer.writerow(['Fandom collab', 'Valid proofs', 'Date'])
            for r in c.execute('''SELECT s.fandom, coalesce(sum(p.status='valid'),0), s.day FROM collab_submissions s
                LEFT JOIN collab_proofs p ON p.submission_id=s.id GROUP BY s.id ORDER BY s.day,s.fandom COLLATE NOCASE'''):
                writer.writerow(list(r))
    return out.getvalue()


# ---------------------------------------------------------------- review
def approve(proof_id, cert_id, confirm_similar, actor):
    cert_id = clean(cert_id, 40).upper()
    if not ID_RE.fullmatch(cert_id):
        raise ValueError('The certificate ID must be 16 letters or digits')
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute('SELECT status FROM collab_proofs WHERE id=?', (proof_id,)).fetchone()
        if not row:
            raise ValueError('Proof not found')
        if row['status'] != 'manual':
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


def reject(proof_id, actor):
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        done = c.execute("UPDATE collab_proofs SET status='rejected',reason='Rejected manually',reviewed_by=?,reviewed_at=? WHERE id=? AND status='manual'",
                         (actor, time.time(), proof_id)).rowcount
    if not done:
        raise ValueError('Proof not found or already reviewed')
    return {'ok': True}


# ---------------------------------------------------------------- HTTP glue (called from app.py)
def get(path, query):
    """Returns (status, body, content_type) for authenticated GET requests, or None if not a collab route."""
    if path == '/api/collab/summary':
        return 200, summary(), 'application/json; charset=utf-8'
    if path == '/api/collab/queue':
        offset = max(0, int((query.get('offset') or ['0'])[0]))
        return 200, queue(offset, min(50, max(1, int((query.get('limit') or ['10'])[0])))), 'application/json; charset=utf-8'
    if path == '/api/collab/export.csv':
        kind = (query.get('kind') or ['summary'])[0]
        return 200, export_csv('full' if kind == 'full' else 'summary'), 'text/csv; charset=utf-8'
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
        return process(first('fandom'), first('name'), first('key'), data, actor)
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
    match = re.fullmatch(r'/api/collab/proofs/(\d+)/(approve|reject)', path)
    if match:
        if match[2] == 'approve':
            return approve(int(match[1]), payload.get('cert_id', ''), bool(payload.get('confirm_similar')), actor)
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
