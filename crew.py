"""EMGP26 crew list: who raced, for which scuderia, at which crew licence level and with which role.

The list is a CSV kept in the data volume (next to the database, not in git). The certificate page searches it by
nickname, so a crew member only types the name and the team, level and role come from the list.

Accepted columns (header names are case-insensitive): username or "E1 username"; team or Team (scuderia name,
"Team JAKE" style names or the key); level or "Crew Licence level"; role (optional); x (optional, X handles
separated by spaces) or "Social link" (the X handles are taken from the x.com links); donor (optional: yes / x / 1
for crew members who donated to the campaign, empty or no otherwise).
"""
import csv
import hashlib
import io
import os
import re
import threading
import unicodedata
from pathlib import Path

import storage

MAX_UPLOAD = 1048576
LIMIT = 8
TEAMS = {  # key: (scuderia, member team)
    'jaybull': ('Jaybull Racing', 'Team JAY'), 'mcjakey': ('McJakey', 'Team JAKE'), 'hoonrari': ('Hoonrari', 'Team SUNGHOON'),
    'alpinoo': ('Alpinoo', 'Team SUNOO'), 'meowcedes': ('Meowcedes', 'Team JUNGWON'), 'rikston': ('Rikston Drift', 'Team NI-KI'),
    'independent': ('Independent Crew', 'Independent Crew'),
    # The organisers: no team and no crew licence level, a staff certificate instead.
    'staff': ('EMGP Admin', 'Admin', 'Organising Team'),
    # Staff who are not admins (e.g. Paddock Announcers): no level either, a staff certificate.
    'crew': ('EMGP Staff', 'EMGP Radio', 'Staff', 'Radio'),
}
TEAM_KEYS = {n.casefold(): k for k, names in TEAMS.items() for n in (k, *names)}
LEVELS = ['Paddock Rookie', 'Race Ready', 'Fast Lane', 'Pit Lane Pro', 'Redline Ace', 'Paddock Icon', 'Circuit Storm', 'E1 Elite',
          'Diamond Crew', 'All-Star', 'Hall of Fame', 'Grand Prix Legend', 'E1 Titan', 'E1 Immortal', 'E1 Eternal',
          'Supersonic Vanguard', 'Hyperdrive Elite', 'E1 Singularity']
LEVEL_INDEX = {n.casefold(): i for i, n in enumerate(LEVELS)}
COLUMNS = {'username': ('username', 'e1 username', 'nickname'), 'team': ('team', 'scuderia'),
           'level': ('level', 'crew licence level', 'crew license level'), 'role': ('role',), 'x': ('x', 'social link'), 'donor': ('donor', 'supporter', 'donated')}
NO_LEVEL_ROLES = {'Social Media Creator'}
NO = {'', 'no', 'n', 'false', 'falso', '0', '-', 'none'}
X_HANDLE = re.compile(r'(?:x|twitter)\.com/@?([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])')
NOT_HANDLES = {'i', 'home', 'intent', 'share', 'search', 'hashtag', 'explore', 'enmamagrandprix'}  # the project account is not a crew handle


def x_handles(text):
    """X handles from a cell: a social link list ("https://x.com/name ; …") or bare handles ("name other")."""
    found = X_HANDLE.findall(text) if '.com' in text else re.findall(r'@?([A-Za-z0-9_]{1,15})', text)
    seen, out = set(), []
    for h in found:
        if h.casefold() not in seen and h.casefold() not in NOT_HANDLES:
            seen.add(h.casefold()); out.append(h)
    # Next to a real handle, a very short one is almost always a typo (x.com/jay ; x.com/jymeowon).
    if len(out) > 1:
        out = [h for h in out if len(h) > 4] or out
    return out[:3]

_lock = threading.Lock()
_cache = {'key': None, 'entries': []}


def path():
    return Path(os.getenv('CREW_CSV') or Path(storage.DB).parent / 'crew.csv')


def fold(text):
    return unicodedata.normalize('NFKC', text).strip().lstrip('@').casefold()


def delimiter(text):
    # Spreadsheets in some languages (Italian Excel, Numbers) save with ; or tabs instead of commas.
    first = text.split('\n', 1)[0]
    return max((',', ';', '\t'), key=first.count)


def parse(text):
    """CSV text -> (entries, skipped rows). Same name and team twice: one entry, the higher level, the role kept."""
    text = text.lstrip('\ufeff')
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter(text))
    header = {(h or '').strip().casefold(): h for h in reader.fieldnames or []}
    cols = {k: next((header[n] for n in names if n in header), None) for k, names in COLUMNS.items()}
    if not (cols['username'] and cols['team'] and cols['level']):
        raise ValueError('The CSV needs the columns username, team and level')
    found, skipped = {}, []
    for line, row in enumerate(reader, 2):
        name = (row.get(cols['username']) or '').strip()[:40]
        team = TEAM_KEYS.get((row.get(cols['team']) or '').strip().casefold())
        level = LEVEL_INDEX.get((row.get(cols['level']) or '').strip().casefold())
        role = (row.get(cols['role']) or '').strip()[:60] if cols['role'] else ''
        handles = x_handles(row.get(cols['x']) or '') if cols['x'] else []
        donor = bool(cols['donor']) and (row.get(cols['donor']) or '').strip().casefold() not in NO
        # No crew licence level (stored as 0): the admins, and creators or donors who did not race.
        if team in ('staff', 'crew') or (level is None and not (row.get(cols['level']) or '').strip() and (NO_LEVEL_ROLES & set(re.split(r'\s*(?:;|\||/|\+|&|·)\s*', role)) or donor)):
            level = -1
        if not name.lstrip('@') or team is None or level is None:
            skipped.append(line)
            continue
        key = (name.lstrip('@'), team)
        old = found.get(key)
        if old:
            old['level'] = max(old['level'], level + 1)
            old['role'] = old['role'] or role
            old['x'] = old['x'] or handles
            old['donor'] = old['donor'] or donor
            continue
        found[key] = {'id': hashlib.sha1(f'{name.lstrip("@")}|{team}'.encode()).hexdigest()[:10],
                      'username': name, 'team': team, 'level': level + 1, 'role': role, 'x': handles, 'donor': donor}
    entries = list(found.values())
    # Same nickname more than once: the search shows the team, and the level too when the team is the same.
    names = {}
    for e in entries:
        names.setdefault(fold(e['username']), []).append(e)
    for same in names.values():
        if len(same) > 1:
            teams = [e['team'] for e in same]
            for e in same:
                e['note'] = TEAMS[e['team']][0] + (f' · {LEVELS[e["level"] - 1]}' if teams.count(e['team']) > 1 and e['level'] else '')
    for e in entries:
        e['_fold'] = fold(e['username'])
    entries.sort(key=lambda e: (e['_fold'], e['team']))
    return entries, skipped


def entries():
    p = path()
    try:
        stat = p.stat()
    except OSError:
        return []
    key = (str(p), stat.st_mtime_ns, stat.st_size)
    with _lock:
        if _cache['key'] != key:
            _cache['entries'] = parse(p.read_text(encoding='utf-8'))[0]
            _cache['key'] = key
        return _cache['entries']


def public(e, handles=False):
    # The X handles and the supporter flag only come with a single entry (after picking it), not with every search result.
    return {k: v for k, v in e.items() if not k.startswith('_') and (handles or k not in ('x', 'donor'))}


def search(query):
    q = fold(query or '')[:40]
    rows = entries()
    if not q:
        return {'loaded': bool(rows), 'results': []}
    # The E1 username or one of the X handles: exact, then starts with, then contains.
    rank = lambda text: 0 if text == q else 1 if text.startswith(q) else 2 if q in text else 3
    hits = []
    for e in rows:
        own = rank(e['_fold'])
        via = min(((rank(h.casefold()), h) for h in e['x']), default=(3, ''))
        best = min(own, via[0])
        if best < 3:
            hits.append((best, e, via[1] if via[0] < own else ''))
    hits.sort(key=lambda h: h[0])  # stable: alphabetical inside each group
    # A match on the handle says which one (only the handle that was typed, not the others).
    return {'loaded': True, 'results': [{**public(e), **({'via': via} if via else {})} for _, e, via in hits[:LIMIT]]}


def get(entry_id):
    return next((public(e, handles=True) for e in entries() if e['id'] == entry_id), None)


def replace(data):
    """Admin upload: validate the whole CSV, then swap the file atomically."""
    text = data.decode('utf-8-sig')
    rows, skipped = parse(text)
    if not rows:
        raise ValueError('No valid rows in the CSV')
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix('.tmp')
    tmp.write_text(text, encoding='utf-8')
    os.replace(tmp, p)
    columns = next(csv.reader(io.StringIO(text.lstrip('\ufeff')), delimiter=delimiter(text.lstrip('\ufeff'))))
    return {'columns': columns, 'count': len(rows), 'roles': sum(1 for e in rows if e['role']), 'donors': sum(1 for e in rows if e['donor']), 'skipped_lines': skipped[:50], 'skipped': len(skipped)}
