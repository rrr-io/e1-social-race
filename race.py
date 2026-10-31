"""Competition rules and append-only manual observations."""
import json
import os
import time
from datetime import datetime, timedelta, timezone

import storage
from collectors import normalize_url

KST = timezone(timedelta(hours=9))
START = datetime(2026, 10, 28, 18, tzinfo=KST).timestamp()
END = datetime(2026, 11, 8, 23, 59, tzinfo=KST).timestamp()
METRICS = ('likes', 'comments', 'views')
# Each platform has its own leaderboard, scored on a single metric.
PLATFORMS = ('instagram', 'tiktok')
SCORE_METRIC = {'instagram': 'likes', 'tiktok': 'views'}
PLATFORM_LABEL = {'instagram': 'Instagram', 'tiktok': 'TikTok'}
# Platforms on which every team needs at least one creator (Instagram is optional for now).
REQUIRED_PLATFORMS = ('tiktok',)


def article(word):
    return f"{'an' if word[:1].lower() in 'aeiou' else 'a'} {word}"


def simulation_enabled():
    # The pre-race override expires automatically at the official start.
    return os.getenv('RACE_SIMULATION', '').strip().lower() in ('1', 'true', 'yes') and time.time() < START


def init(c):
    c.executescript('''
    CREATE TABLE IF NOT EXISTS race_config(id INTEGER PRIMARY KEY CHECK(id=1), weights TEXT, frozen TEXT);
    INSERT OR IGNORE INTO race_config(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS race_teams(id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, base_points INTEGER);
    CREATE TABLE IF NOT EXISTS race_creators(id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES race_teams(id),
      platform TEXT NOT NULL CHECK(platform IN ('instagram','tiktok')), name TEXT NOT NULL COLLATE NOCASE,
      UNIQUE(platform,name));
    CREATE TABLE IF NOT EXISTS race_events(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      starts REAL NOT NULL, ends REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS race_entries(id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES race_teams(id), creator_id INTEGER NOT NULL REFERENCES race_creators(id),
      event_id INTEGER NOT NULL REFERENCES race_events(id),
      post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id), platform TEXT NOT NULL,
      published_at REAL NOT NULL, UNIQUE(creator_id,event_id));
    CREATE TABLE IF NOT EXISTS race_manual(id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES race_entries(id), observed_at REAL NOT NULL, recorded_at REAL NOT NULL,
      likes INTEGER, comments INTEGER, views INTEGER, final INTEGER NOT NULL DEFAULT 0,
      evidence TEXT NOT NULL, actor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS race_event_results(event_id INTEGER PRIMARY KEY REFERENCES race_events(id),
      frozen_at REAL NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS race_audit(id INTEGER PRIMARY KEY, recorded_at REAL NOT NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL);
    ''')


def migrate(path):
    """Bring older databases up to date (see the two steps below). Returns True if anything changed."""
    changed = migrate_representative(path)
    return migrate_multi_creators(path) or changed


def migrate_multi_creators(path):
    """One creator per team and platform became several creators per team and platform.

    race_creators loses UNIQUE(team_id,platform); race_entries gains creator_id (the
    creator who published the post, one post per creator and event). Existing entries
    get the team's creator on that platform. Row ids are kept, so saved event results
    (keyed by entry id) stay valid.
    """
    import sqlite3
    con = sqlite3.connect(path, timeout=15)
    try:
        con.execute('PRAGMA foreign_keys=OFF')
        changed = False
        row = con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='race_creators'").fetchone()
        if row and 'UNIQUE(team_id,platform)' in row[0].replace(' ', ''):
            con.executescript("""
            BEGIN;
            CREATE TABLE race_creators_new(id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES race_teams(id),
              platform TEXT NOT NULL CHECK(platform IN ('instagram','tiktok')), name TEXT NOT NULL COLLATE NOCASE,
              UNIQUE(platform,name));
            INSERT INTO race_creators_new(id,team_id,platform,name) SELECT id,team_id,platform,name FROM race_creators;
            DROP TABLE race_creators;
            ALTER TABLE race_creators_new RENAME TO race_creators;
            COMMIT;
            """)
            changed = True
        columns = [r[1] for r in con.execute('PRAGMA table_info(race_entries)')]
        if columns and 'creator_id' not in columns:
            con.executescript("""
            BEGIN;
            INSERT OR IGNORE INTO race_creators(team_id,platform,name)
              SELECT DISTINCT e.team_id,e.platform,t.name||' ('||e.platform||')' FROM race_entries e JOIN race_teams t ON t.id=e.team_id
              WHERE NOT EXISTS(SELECT 1 FROM race_creators cr WHERE cr.team_id=e.team_id AND cr.platform=e.platform);
            CREATE TABLE race_entries_new(id INTEGER PRIMARY KEY,
              team_id INTEGER NOT NULL REFERENCES race_teams(id), creator_id INTEGER NOT NULL REFERENCES race_creators(id),
              event_id INTEGER NOT NULL REFERENCES race_events(id),
              post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id), platform TEXT NOT NULL,
              published_at REAL NOT NULL, UNIQUE(creator_id,event_id));
            INSERT INTO race_entries_new(id,team_id,creator_id,event_id,post_id,platform,published_at)
              SELECT e.id,e.team_id,(SELECT cr.id FROM race_creators cr WHERE cr.team_id=e.team_id AND cr.platform=e.platform ORDER BY cr.id LIMIT 1),
                     e.event_id,e.post_id,e.platform,e.published_at FROM race_entries e;
            DROP TABLE race_entries;
            ALTER TABLE race_entries_new RENAME TO race_entries;
            COMMIT;
            """)
            changed = True
        if changed:
            problems = con.execute('PRAGMA foreign_key_check').fetchall()
            if problems:
                raise RuntimeError(f'Foreign key problems after migrating creators: {problems[:5]}')
        return changed
    finally:
        con.close()


def migrate_representative(path):
    """One creator per team became one creator per team and platform.

    Older databases keep the creator in race_teams.representative (NOT NULL UNIQUE).
    Rebuild race_teams without it and copy that person to both platforms; the admin
    can then change either one. Runs with foreign keys off, as SQLite requires
    for rebuilding a referenced table.
    """
    import sqlite3
    con = sqlite3.connect(path, timeout=15)
    try:
        con.execute('PRAGMA foreign_keys=OFF')
        columns = [r[1] for r in con.execute('PRAGMA table_info(race_teams)')]
        if 'representative' not in columns:
            return False
        con.executescript("""
        BEGIN;
        CREATE TABLE IF NOT EXISTS race_creators(id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES race_teams(id),
          platform TEXT NOT NULL CHECK(platform IN ('instagram','tiktok')), name TEXT NOT NULL COLLATE NOCASE,
          UNIQUE(team_id,platform), UNIQUE(platform,name));
        CREATE TABLE race_teams_new(id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, base_points INTEGER);
        INSERT INTO race_teams_new(id,name,base_points) SELECT id,name,base_points FROM race_teams;
        INSERT OR IGNORE INTO race_creators(team_id,platform,name) SELECT id,'instagram',representative FROM race_teams;
        INSERT OR IGNORE INTO race_creators(team_id,platform,name) SELECT id,'tiktok',representative FROM race_teams;
        DROP TABLE race_teams;
        ALTER TABLE race_teams_new RENAME TO race_teams;
        COMMIT;
        """)
        problems = con.execute('PRAGMA foreign_key_check').fetchall()
        if problems:
            raise RuntimeError(f'Foreign key problems after migrating race_teams: {problems[:5]}')
        return True
    finally:
        con.close()


def teams_with_creators(c):
    teams = [dict(r) for r in c.execute('SELECT * FROM race_teams ORDER BY id')]
    creators = {}
    for r in c.execute('SELECT id,team_id,platform,name FROM race_creators ORDER BY id'):
        creators.setdefault(r['team_id'], {p: [] for p in PLATFORMS})[r['platform']].append({'id': r['id'], 'name': r['name']})
    for team in teams:
        team['creators'] = creators.get(team['id'], {p: [] for p in PLATFORMS})
    return teams


def unregister(c, column, value):
    """Remove race registrations (and their manual observations) by team, event or creator.
    The tracked posts and their automatic snapshots stay. Returns (entries, manual) counts."""
    rows = c.execute(f'SELECT id,post_id FROM race_entries WHERE {column}=?', (value,)).fetchall()
    manual = 0
    for entry_id, post_id in rows:
        manual += c.execute('DELETE FROM race_manual WHERE entry_id=?', (entry_id,)).rowcount
        # Back to ordinary tracking (a post of a closed event was no longer scheduled).
        c.execute('UPDATE posts SET next_check=? WHERE id=? AND paused=0', (time.time() + storage.INTERVAL, post_id))
    c.execute(f'DELETE FROM race_entries WHERE {column}=?', (value,))
    return len(rows), manual


def parse_creators(c, p, team_id):
    """Creators per platform from a team form: {'creators': {platform: [{id?, name}]}}.
    Older clients send one name per platform ('instagram', 'tiktok'). Items without an id
    whose name matches an existing creator of the team keep that creator."""
    existing = {pl: [] for pl in PLATFORMS}
    if team_id:
        for r in c.execute('SELECT id,platform,name FROM race_creators WHERE team_id=? ORDER BY id', (team_id,)):
            existing[r['platform']].append(dict(r))
    raw = p.get('creators')
    if raw is not None and not isinstance(raw, dict):
        raise ValueError('Invalid creator list. Reload the page and try again.')
    result = {}
    for platform in PLATFORMS:
        items = (raw.get(platform) or []) if raw is not None else [p.get(platform)]
        if not isinstance(items, list):
            raise ValueError('Invalid creator list. Reload the page and try again.')
        parsed, seen_ids, seen_names = [], set(), set()
        for item in items:
            item = item if isinstance(item, dict) else {'name': item}
            text = str(item.get('name') or '').strip()
            if not text:
                continue
            creator = {'id': integer(item['id']) if item.get('id') not in (None, '') else None, 'name': name(text)}
            if creator['id'] is None:
                match = next((e for e in existing[platform] if e['name'].casefold() == text.casefold() and e['id'] not in seen_ids), None)
                creator['id'] = match['id'] if match else None
            if creator['id'] is not None:
                if creator['id'] not in {e['id'] for e in existing[platform]}:
                    raise ValueError('A creator in the form no longer belongs to this team. Reload the page.')
                if creator['id'] in seen_ids:
                    raise ValueError('The same creator appears twice. Reload the page.')
                seen_ids.add(creator['id'])
            if text.casefold() in seen_names:
                raise ValueError(f'“{text}” is listed twice as a {PLATFORM_LABEL[platform]} creator.')
            seen_names.add(text.casefold())
            parsed.append(creator)
        result[platform] = parsed
    missing = [PLATFORM_LABEL[k] for k, v in result.items() if not v and k in REQUIRED_PLATFORMS]
    if missing:
        raise ValueError(f'Add at least one {" and one ".join(missing)} creator.')
    return existing, result


def rank_rows(rows, bonus=True):
    """Competition ranking (1, 1, 3); ties keep the bonus unresolved."""
    rows.sort(key=lambda r: (r['score'] is None, -(r['score'] or 0), r['team_id'], r.get('creator_id') or 0))
    for row in rows:
        row['rank'] = 1 + sum(o['score'] is not None and o['score'] > row['score'] for o in rows) if row['score'] is not None else None
        rank = row['rank']
        tied = rank and sum(o['score'] == row['score'] for o in rows) > 1
        row['tied'] = bool(tied)
        row['bonus_percent'] = (2 if rank == 1 else 1 if rank in (2, 3) else 0) if bonus and rank and not tied else None
        row['bonus_points'] = row['base_points'] * row['bonus_percent'] / 100 if row['base_points'] is not None and row['bonus_percent'] is not None else None
    return rows


# A race post collected this recently counts as current for "refresh all".
REFRESH_FRESH_SECONDS = 5 * 60

# How often registered race posts are collected (minutes, aligned to the KST clock).
CHECK_MINUTES = max(15, int(os.getenv('RACE_CHECK_MINUTES', '60')))


def next_check(now):
    """Next scheduled observation: every CHECK_MINUTES on the KST clock, plus a final
    attempt at the cutoff. Never backdated; nothing before the race unless simulating."""
    if now >= END:
        return 253402214400.0
    base = now if simulation_enabled() else max(now, START - 1)
    step = CHECK_MINUTES * 60
    local = datetime.fromtimestamp(base, KST)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    due = midnight + ((base - midnight) // step + 1) * step
    return min(due, END)


NEVER = 253402214400.0
# One last automatic collection shortly before each event closes.
PRECLOSE_SECONDS = 10 * 60


def post_next_check(c, post_id, now):
    """Schedule for a registered race post: hourly while its event is open, one last
    check just before the event closes, then nothing (its result is saved at close).
    None for posts that are not in the race."""
    row = c.execute('SELECT ev.ends FROM race_entries e JOIN race_events ev ON ev.id=e.event_id WHERE e.post_id=?', (post_id,)).fetchone()
    if not row:
        return None
    ends = min(row[0], END)
    if now >= ends:
        return NEVER
    due = next_check(now)
    if ends - PRECLOSE_SECONDS > now:
        due = min(due, ends - PRECLOSE_SECONDS)
    return min(due, ends)


def reschedule(c, now=None):
    """Align race posts with the current schedule: bring forward posts scheduled later
    than allowed, and stop collecting posts whose event has closed."""
    now = time.time() if now is None else now
    for (post_id,) in c.execute('SELECT p.id FROM posts p JOIN race_entries e ON e.post_id=p.id WHERE p.paused=0').fetchall():
        due = post_next_check(c, post_id, now)
        if due == NEVER:
            c.execute('UPDATE posts SET next_check=? WHERE id=?', (NEVER, post_id))
        elif due is not None:
            c.execute('UPDATE posts SET next_check=? WHERE id=? AND next_check>?', (due, post_id, due))


def timestamp(value):
    try:
        dt = datetime.fromisoformat(value)
        return dt.replace(tzinfo=KST).timestamp() if dt.tzinfo is None else dt.timestamp()
    except (ValueError, TypeError):
        raise ValueError('Enter a valid date and time (KST).') from None


def integer(value, optional=False):
    if optional and value in (None, ''):
        return None
    if isinstance(value, bool) or not str(value).isdigit() or int(value) > 10**12:
        raise ValueError('Counts and points must be whole numbers between 0 and 1,000,000,000,000.')
    return int(value)


def name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 500:
        raise ValueError('A nonempty text value of at most 500 characters is required.')
    return value.strip()


def entry_sample(c, e, cutoff):
    """Latest counts for a registered post up to `cutoff` (manual or automatic, whichever is newer)."""
    manual = c.execute('SELECT observed_at,likes,comments,views FROM race_manual WHERE entry_id=? AND observed_at<=? '
                       'ORDER BY observed_at DESC,id DESC LIMIT 1', (e['id'], cutoff)).fetchone()
    auto = c.execute('SELECT collected_at AS observed_at,likes,comments,views FROM snapshots WHERE post_id=? AND collected_at BETWEEN ? AND ? '
                     'ORDER BY collected_at DESC,id DESC LIMIT 1', (e['post_id'], e['published_at'], cutoff)).fetchone()
    sample = manual if manual and (not auto or manual['observed_at'] >= auto['observed_at']) else auto
    metric = SCORE_METRIC[e['platform']]
    return {'metrics': {k: sample[k] for k in METRICS} if sample else None,
            'observed_at': sample['observed_at'] if sample else None,
            'source': ('manual' if sample is manual else 'automatic') if sample else None,
            'score': sample[metric] if sample else None}


def close_events(c, now=None):
    """Save the result of every event whose window has closed (once). The saved counts
    are what the post had at the close; later engagement no longer changes them."""
    now = time.time() if now is None else now
    closed = c.execute('SELECT ev.* FROM race_events ev LEFT JOIN race_event_results r ON r.event_id=ev.id WHERE r.event_id IS NULL AND ev.ends<=?', (now,)).fetchall()
    for ev in closed:
        cutoff = min(ev['ends'], END)
        data = {str(e['id']): entry_sample(c, dict(e), cutoff)
                for e in c.execute('SELECT * FROM race_entries WHERE event_id=?', (ev['id'],)).fetchall()}
        c.execute('INSERT INTO race_event_results(event_id,frozen_at,data) VALUES(?,?,?)', (ev['id'], now, json.dumps(data)))
        c.execute('INSERT INTO race_audit(recorded_at,actor,action,details) VALUES(?,?,?,?)',
                  (now, 'system', 'event-close', json.dumps({'event_id': ev['id'], 'name': ev['name'], 'posts': len(data)})))


def make_boards(teams, entries, bonus):
    boards = {}
    for platform in PLATFORMS:
        rows = []
        # One row per creator: a team can hold several places, even the whole podium.
        for team in teams:
            for creator in team['creators'][platform]:
                posts = [e for e in entries if e['creator_id'] == creator['id']]
                missing = sum(e['score'] is None for e in posts)
                rows.append({'team_id': team['id'], 'team': team['name'], 'creator_id': creator['id'], 'creator': creator['name'],
                             'base_points': team['base_points'], 'posts': len(posts), 'missing': missing,
                             'score': sum(e['score'] for e in posts) if posts and not missing else None})
        boards[platform] = rank_rows(rows, bonus=bonus)
    return boards


def board(c):
    now = time.time()
    teams = teams_with_creators(c)
    simulation = simulation_enabled()
    events = {r['id']: dict(r) for r in c.execute('SELECT * FROM race_events WHERE starts>=? OR ? ORDER BY starts,id', (START, simulation))}
    saved = {r['event_id']: (r['frozen_at'], json.loads(r['data'])) for r in c.execute('SELECT * FROM race_event_results')}
    entries = []
    for r in c.execute('SELECT e.*,cr.name AS creator,p.url,p.last_attempt,p.status FROM race_entries e JOIN posts p ON p.id=e.post_id LEFT JOIN race_creators cr ON cr.id=e.creator_id'):
        e = dict(r)
        ev = events.get(e['event_id'])
        if not ev:
            continue  # simulation entries when simulation is off
        e['simulation'] = ev['starts'] < START
        e['metric'] = SCORE_METRIC[e['platform']]
        frozen = saved.get(ev['id'], (None, {}))[1].get(str(e['id']))
        e.update(frozen if frozen else entry_sample(c, e, min(now, ev['ends'], END)))
        e['final'] = ev['id'] in saved
        entries.append(e)
    if not simulation:
        test_only = {r[0] for r in c.execute('SELECT e.team_id FROM race_entries e JOIN race_events ev ON ev.id=e.event_id GROUP BY e.team_id HAVING max(ev.starts) < ?', (START,))}
        teams = [team for team in teams if team['id'] not in test_only]

    # One scope per event (rankings restart each event), plus the Grand Prix total.
    scopes = []
    for ev in events.values():
        status = 'closed' if ev['id'] in saved or now >= ev['ends'] else 'live' if now >= ev['starts'] else 'upcoming'
        scopes.append({'key': f"event-{ev['id']}", 'type': 'event', 'event_id': ev['id'], 'name': ev['name'],
                       'starts': ev['starts'], 'ends': ev['ends'], 'status': status,
                       'saved_at': saved[ev['id']][0] if ev['id'] in saved else None,
                       'boards': make_boards(teams, [e for e in entries if e['event_id'] == ev['id']], bonus=False)})
    total = make_boards(teams, entries, bonus=True)
    scopes.append({'key': 'total', 'type': 'total', 'name': 'Grand Prix total', 'status': 'closed' if now >= END else 'live', 'boards': total})
    live = [s for s in scopes if s['type'] == 'event' and s['status'] == 'live']
    closed = [s for s in scopes if s['type'] == 'event' and s['status'] == 'closed']
    if now >= END:
        current = 'total'
    elif live:
        current = max(live, key=lambda s: s['starts'])['key']
    elif closed:
        current = max(closed, key=lambda s: s['ends'])['key']
    else:
        current = scopes[0]['key'] if len(scopes) > 1 else 'total'

    for team in teams:
        bonus = [row['bonus_points'] for p in PLATFORMS for row in total[p] if row['team_id'] == team['id'] and row['bonus_points']]
        team['bonus_points_total'] = sum(bonus) if bonus else None
    return {'start': START, 'end': END, 'metrics': SCORE_METRIC, 'check_minutes': CHECK_MINUTES, 'simulation': simulation,
            'state': 'SIMULATION — not official results' if simulation else 'Provisional',
            'teams': teams, 'boards': total, 'scopes': scopes, 'current_scope': current, 'entries': entries,
            'events': list(events.values())}


def read(admin=False):
    with storage.connection() as c:
        frozen = c.execute('SELECT frozen FROM race_config WHERE id=1').fetchone()[0]
        if not frozen:
            close_events(c)
        result = json.loads(frozen) if frozen else board(c)
        if admin:
            result['tracked_posts'] = [dict(r) for r in c.execute('SELECT p.id,p.url,p.label,p.title,p.remote_id,p.platform,e.id AS entry_id,t.name AS assigned_team,cr.name AS assigned_creator,e.creator_id AS assigned_creator_id,e.published_at AS assigned_published_at,ev.name AS assigned_event FROM posts p LEFT JOIN race_entries e ON e.post_id=p.id LEFT JOIN race_teams t ON t.id=e.team_id LEFT JOIN race_creators cr ON cr.id=e.creator_id LEFT JOIN race_events ev ON ev.id=e.event_id ORDER BY p.created_at DESC,p.id DESC')]
            result['available_events'] = [dict(r) for r in c.execute('SELECT ev.*, count(e.id) AS post_count, r.frozen_at AS saved_at FROM race_events ev LEFT JOIN race_entries e ON e.event_id=ev.id LEFT JOIN race_event_results r ON r.event_id=ev.id GROUP BY ev.id ORDER BY ev.starts,ev.id')]
            result['available_teams'] = teams_with_creators(c)
            result['audit'] = [dict(r) for r in c.execute('SELECT * FROM race_audit ORDER BY id DESC LIMIT 100')]
        return result


def mutate(action, p, actor, limit=100):
    now = time.time()
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        cfg = c.execute('SELECT * FROM race_config WHERE id=1').fetchone()
        if cfg['frozen']:
            raise ValueError('The final results are frozen.')
        if action in ('team', 'team-update'):
            team_id = integer(p.get('team_id')) if action == 'team-update' else None
            existing = c.execute('SELECT * FROM race_teams WHERE id=?', (team_id,)).fetchone() if team_id else None
            if action == 'team-update' and not existing:
                raise ValueError('Team not found. Reload the page.')
            team_name = name(p.get('name'))
            existing_creators, creators = parse_creators(c, p, team_id)
            if c.execute('SELECT 1 FROM race_teams WHERE name=? AND id!=?', (team_name, team_id or -1)).fetchone():
                raise ValueError(f'“{team_name}” is already set up. Edit that team instead.')
            for platform, items in creators.items():
                for creator in items:
                    other = c.execute('SELECT t.name FROM race_creators cr JOIN race_teams t ON t.id=cr.team_id WHERE cr.platform=? AND cr.name=? AND cr.team_id!=?',
                                      (platform, creator['name'], team_id or -1)).fetchone()
                    if other:
                        raise ValueError(f'“{creator["name"]}” is already {article(PLATFORM_LABEL[platform])} creator of {other["name"]}.')
            base = integer(p.get('base_points'), True)
            if existing:
                before = {**dict(existing), 'creators': {pl: [e['name'] for e in existing_creators[pl]] for pl in PLATFORMS}}
                c.execute('UPDATE race_teams SET name=?,base_points=? WHERE id=?', (team_name, base, team_id))
            else:
                before = None
                team_id = c.execute('INSERT INTO race_teams(name,base_points) VALUES(?,?)', (team_name, base)).lastrowid
            # Creators left out of the form are removed; their posts leave the race.
            kept = {cr['id'] for items in creators.values() for cr in items if cr['id']}
            removed, unregistered = [], 0
            for platform in PLATFORMS:
                for old in existing_creators[platform]:
                    if old['id'] not in kept:
                        unregistered += unregister(c, 'creator_id', old['id'])[0]
                        c.execute('DELETE FROM race_creators WHERE id=?', (old['id'],))
                        removed.append(old['name'])
            # Two steps so names can be swapped between creators of the same team.
            for items in creators.values():
                for cr in items:
                    if cr['id']:
                        c.execute('UPDATE race_creators SET name=? WHERE id=?', (f'~renaming~{cr["id"]}', cr['id']))
            for platform, items in creators.items():
                for cr in items:
                    if cr['id']:
                        c.execute('UPDATE race_creators SET name=? WHERE id=?', (cr['name'], cr['id']))
                    else:
                        c.execute('INSERT INTO race_creators(team_id,platform,name) VALUES(?,?,?)', (team_id, platform, cr['name']))
            creators = {pl: [cr['name'] for cr in items] for pl, items in creators.items()}
            p = {'team_id': team_id, 'before': before, 'after': {'name': team_name, 'creators': creators, 'base_points': base},
                 'removed_creators': removed, 'unregistered_posts': unregistered}
        elif action in ('team-delete', 'event-delete'):
            table, column = ('race_teams', 'team_id') if action == 'team-delete' else ('race_events', 'event_id')
            record_id = integer(p.get(column))
            existing = c.execute(f'SELECT * FROM {table} WHERE id=?', (record_id,)).fetchone()
            if not existing:
                raise ValueError('Already deleted. Reload the page.')
            entries, manual = unregister(c, column, record_id)
            if action == 'event-delete':
                c.execute('DELETE FROM race_event_results WHERE event_id=?', (record_id,))
            if action == 'team-delete':
                c.execute('DELETE FROM race_creators WHERE team_id=?', (record_id,))
            c.execute(f'DELETE FROM {table} WHERE id=?', (record_id,))
            # Tracked posts and their snapshots stay; only the race registration goes.
            p = {column: record_id, 'deleted': dict(existing), 'unregistered_posts': entries, 'deleted_manual_observations': manual}
        elif action == 'entry-delete':
            # Unregister one post: it leaves the race (and its event) but stays tracked.
            entry = c.execute('SELECT e.*,cr.name AS creator,t.name AS team,ev.name AS event,p.url FROM race_entries e JOIN posts p ON p.id=e.post_id '
                              'LEFT JOIN race_creators cr ON cr.id=e.creator_id LEFT JOIN race_teams t ON t.id=e.team_id '
                              'LEFT JOIN race_events ev ON ev.id=e.event_id WHERE e.id=?', (integer(p.get('entry_id')),)).fetchone()
            if not entry:
                raise ValueError('This post is no longer registered. Reload the page.')
            _, manual = unregister(c, 'id', entry['id'])
            p = {'unregistered': dict(entry), 'deleted_manual_observations': manual}
        elif action == 'base':
            if not c.execute('UPDATE race_teams SET base_points=? WHERE id=?', (integer(p.get('base_points')), integer(p.get('team_id')))).rowcount:
                raise ValueError('Team not found.')
        elif action in ('event', 'event-update'):
            starts, ends = timestamp(p.get('starts')), timestamp(p.get('ends'))
            official = START <= starts < ends <= END
            test_event = simulation_enabled() and starts < ends < START
            if not (official or test_event):
                raise ValueError('Official events must open and close between 28 Oct 18:00 and 8 Nov 23:59 KST, and close after they open. Test events before the race need RACE_SIMULATION=true on the server.')
            event_name = name(p.get('name'))
            event_id = integer(p.get('event_id')) if action == 'event-update' else None
            if c.execute('SELECT 1 FROM race_events WHERE name=? AND id!=?', (event_name, event_id or -1)).fetchone():
                raise ValueError('An event with this name already exists. Choose a different name.')
            if event_id is None:
                c.execute('INSERT INTO race_events(name,starts,ends) VALUES(?,?,?)', (event_name, starts, ends))
            else:
                existing = c.execute('SELECT * FROM race_events WHERE id=?', (event_id,)).fetchone()
                if not existing:
                    raise ValueError('Event not found. Reload the page.')
                assigned = c.execute('SELECT count(*) FROM race_entries WHERE event_id=?', (event_id,)).fetchone()[0]
                if assigned and (existing['starts'] < START) != (starts < START):
                    raise ValueError('An event with assigned posts cannot switch between simulation and official competition.')
                outside = c.execute('SELECT cr.name,e.platform,e.published_at FROM race_entries e LEFT JOIN race_creators cr ON cr.id=e.creator_id '
                                    'WHERE e.event_id=? AND (e.published_at<? OR e.published_at>?) ORDER BY e.published_at', (event_id, starts, ends)).fetchall()
                if outside:
                    listed = '; '.join(f'{r["name"] or "?"} ({PLATFORM_LABEL.get(r["platform"], r["platform"])}, published {datetime.fromtimestamp(r["published_at"], KST):%d %b %H:%M} KST)' for r in outside[:5])
                    more = f' and {len(outside) - 5} more' if len(outside) > 5 else ''
                    raise ValueError(f'This window would leave out {len(outside)} registered post{"s" if len(outside) > 1 else ""}: {listed}{more}. '
                                     'Unregister them in Register first (you can register them again afterwards), or keep their publication times inside the window.')
                c.execute('UPDATE race_events SET name=?,starts=?,ends=? WHERE id=?', (event_name, starts, ends, event_id))
                if (existing['starts'], existing['ends']) != (starts, ends):
                    # The window changed: the saved result is recalculated at the (new) close.
                    c.execute('DELETE FROM race_event_results WHERE event_id=?', (event_id,))
                    for (pid,) in c.execute('SELECT post_id FROM race_entries WHERE event_id=?', (event_id,)).fetchall():
                        due = post_next_check(c, pid, now)
                        c.execute('UPDATE posts SET next_check=? WHERE id=? AND paused=0', (due, pid))
                p = {'event_id': event_id, 'before': dict(existing), 'after': {'name': event_name, 'starts': starts, 'ends': ends}}

        elif action in ('entry', 'register-post'):
            if action == 'register-post':
                tracked = c.execute('SELECT url FROM posts WHERE id=?', (integer(p.get('post_id')),)).fetchone()
                if not tracked:
                    raise ValueError('Tracked post not found. Add the post in Track posts first.')
                target = normalize_url(tracked['url'])
            else:
                target = normalize_url(p.get('url'))
            if target.platform not in ('instagram', 'tiktok'):
                raise ValueError('Only Instagram and TikTok are eligible for this race.')
            event = integer(p.get('event_id'))
            label = PLATFORM_LABEL[target.platform]
            if p.get('creator_id') not in (None, ''):
                creator = c.execute('SELECT * FROM race_creators WHERE id=?', (integer(p.get('creator_id')),)).fetchone()
                if not creator:
                    raise ValueError('That creator no longer exists. Reload the page and choose again.')
                if creator['platform'] != target.platform:
                    raise ValueError(f'{creator["name"]} is {article(PLATFORM_LABEL[creator["platform"]])} creator, but this is {article(label)} post.')
                team = creator['team_id']
            else:
                # Older clients send the team: fine as long as it has a single creator on this platform.
                team = integer(p.get('team_id'))
                team_row = c.execute('SELECT name FROM race_teams WHERE id=?', (team,)).fetchone()
                if not team_row:
                    raise ValueError('Choose an existing team from Setup.')
                candidates = c.execute('SELECT * FROM race_creators WHERE team_id=? AND platform=? ORDER BY id', (team, target.platform)).fetchall()
                if not candidates:
                    raise ValueError(f'{team_row["name"]} has no {label} creator yet. Add one in Setup.')
                if len(candidates) > 1:
                    raise ValueError(f'{team_row["name"]} has several {label} creators. Choose who published this post.')
                creator = candidates[0]
            ev = c.execute('SELECT * FROM race_events WHERE id=?', (event,)).fetchone()
            published = timestamp(p.get('published_at'))
            if not ev or not ev['starts'] <= published <= ev['ends'] or published > now:
                raise ValueError('Publication must be within the event window and cannot be in the future.')
            if ev['starts'] < START and not simulation_enabled():
                raise ValueError('This is a simulation event. Enable RACE_SIMULATION before the race starts to add test posts.')
            if c.execute('SELECT 1 FROM race_entries WHERE creator_id=? AND event_id=?', (creator['id'], event)).fetchone():
                raise ValueError(f'{creator["name"]} already has a post for the selected event. Each creator counts one {label} post per event.')
            post = c.execute('SELECT id FROM posts WHERE platform=? AND remote_id=?', (target.platform, target.remote_id)).fetchone()
            if not post:
                if c.execute('SELECT count(*) FROM posts').fetchone()[0] >= limit:
                    raise ValueError('Post limit reached.')
                pid = c.execute('INSERT INTO posts(platform,remote_id,url,created_at,next_check) VALUES(?,?,?,?,?)', (target.platform, target.remote_id, target.url, now, next_check(now))).lastrowid
            else:
                pid = post['id']
            if c.execute('SELECT 1 FROM race_entries WHERE post_id=?', (pid,)).fetchone():
                raise ValueError('This post is already registered. To move it, unregister it in Register first.')
            c.execute('INSERT INTO race_entries(team_id,creator_id,event_id,post_id,platform,published_at) VALUES(?,?,?,?,?,?)', (team, creator['id'], event, pid, target.platform, published))
            due = now if ev['starts'] < START else post_next_check(c, pid, now)
            c.execute('UPDATE posts SET next_check=? WHERE id=?', (due, pid))
            if now >= ev['ends']:
                # Registered after the event closed: recalculate its saved result.
                c.execute('DELETE FROM race_event_results WHERE event_id=?', (event,))
        elif action == 'manual':
            eid = integer(p.get('entry_id'))
            entry = c.execute('SELECT * FROM race_entries WHERE id=?', (eid,)).fetchone()
            observed = timestamp(p.get('observed_at'))
            if not entry or not entry['published_at'] <= observed <= min(now, END):
                raise ValueError('Observation must be after publication and no later than now or the race cutoff.')
            final = False  # superseded: each event's result is saved at its close
            counts = [integer(p.get(k), True) for k in METRICS]
            if all(v is None for v in counts):
                raise ValueError('Enter at least one metric.')
            evidence = name(p.get('evidence'))
            c.execute('INSERT INTO race_manual(entry_id,observed_at,recorded_at,likes,comments,views,final,evidence,actor) VALUES(?,?,?,?,?,?,?,?,?)', (eid, observed, now, *counts, int(final), evidence, actor))
            # A correction for a closed event updates its saved result.
            c.execute('DELETE FROM race_event_results WHERE event_id=(SELECT event_id FROM race_entries WHERE id=?) AND event_id IN (SELECT id FROM race_events WHERE ends<=?)', (eid, now))
        elif action == 'finalize':
            if now < END:
                raise ValueError('The race closes on 8 November at 23:59 KST. Results can be published after that.')
            close_events(c, now)
            result = board(c)
            rows = [row for platform in PLATFORMS for row in result['boards'][platform]]
            if not result['entries'] or any(row['posts'] and row['score'] is None for row in rows):
                raise ValueError('Every registered post needs its counts before publishing. Add manual counts for posts marked Pending.')
            if any(row['rank'] and row['rank'] <= 3 and row['bonus_percent'] is None for row in rows):
                raise ValueError('A podium tie needs an agreed tie-break rule before finalization.')
            result['current_scope'] = 'total'
            result['state'] = 'Final'
            result['finalized_at'] = now
            c.execute('UPDATE race_config SET frozen=? WHERE id=1', (json.dumps(result),))
        elif action == 'refresh-all':
            # Queue every registered race post for an immediate collection. Posts checked
            # in the last few minutes are already current; paused posts stay paused.
            queued, recent, paused = [], [], []
            for r in c.execute('SELECT p.id,p.paused,p.status,p.last_attempt FROM race_entries e JOIN posts p ON p.id=e.post_id JOIN race_events ev ON ev.id=e.event_id WHERE ev.ends>? ORDER BY e.id', (now,)):
                if r['paused']:
                    paused.append(r['id'])
                elif r['status'] == 'collecting' or r['status'] == 'queued' and r['last_attempt'] is None:
                    queued.append({'id': r['id'], 'last_attempt': r['last_attempt']})
                elif r['last_attempt'] and now - r['last_attempt'] < REFRESH_FRESH_SECONDS and r['status'] in ('ok', 'partial'):
                    recent.append(r['id'])
                else:
                    queued.append({'id': r['id'], 'last_attempt': r['last_attempt']})
            for item in queued:
                c.execute("UPDATE posts SET next_check=0,status=CASE WHEN status='collecting' THEN status ELSE 'queued' END WHERE id=?", (item['id'],))
            if not queued and not recent:
                raise ValueError('No open event has registered posts. Closed events keep the counts saved at their close.' if not paused else 'All posts of the open events are paused. Resume them in Track posts first.')
            response = {'ok': True, 'queued': queued, 'recent': recent, 'paused': paused}
            p = {'queued': [q['id'] for q in queued], 'recent': recent, 'paused': paused}
        else:
            raise ValueError('Unknown race action.')
        c.execute('INSERT INTO race_audit(recorded_at,actor,action,details) VALUES(?,?,?,?)', (now, actor, action, json.dumps(p)))
    return response if action == 'refresh-all' else {'ok': True}
