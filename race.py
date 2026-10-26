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


def simulation_enabled():
    # The pre-race override expires automatically at the official start.
    return os.getenv('RACE_SIMULATION', '').strip().lower() in ('1', 'true', 'yes') and time.time() < START


def init(c):
    c.executescript('''
    CREATE TABLE IF NOT EXISTS race_config(id INTEGER PRIMARY KEY CHECK(id=1), weights TEXT, frozen TEXT);
    INSERT OR IGNORE INTO race_config(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS race_teams(id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      representative TEXT NOT NULL COLLATE NOCASE UNIQUE, base_points INTEGER);
    CREATE TABLE IF NOT EXISTS race_events(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      starts REAL NOT NULL, ends REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS race_entries(id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES race_teams(id), event_id INTEGER NOT NULL REFERENCES race_events(id),
      post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id), platform TEXT NOT NULL,
      published_at REAL NOT NULL, UNIQUE(team_id,event_id,platform));
    CREATE TABLE IF NOT EXISTS race_manual(id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES race_entries(id), observed_at REAL NOT NULL, recorded_at REAL NOT NULL,
      likes INTEGER, comments INTEGER, views INTEGER, final INTEGER NOT NULL DEFAULT 0,
      evidence TEXT NOT NULL, actor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS race_audit(id INTEGER PRIMARY KEY, recorded_at REAL NOT NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL);
    ''')


def next_check(now):
    """Daily 22:00 KST observations and a final cutoff attempt; never backdate."""
    local = datetime.fromtimestamp(now if simulation_enabled() else max(now, START - 1), KST)
    due = local.replace(hour=22, minute=0, second=0, microsecond=0)
    if due.timestamp() <= now:
        due += timedelta(days=1)
    return min(due.timestamp(), END) if now < END else 253402214400.0


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
        raise ValueError('Counts and weights must be whole numbers between 0 and 1,000,000,000,000.')
    return int(value)


def name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 500:
        raise ValueError('A nonempty text value of at most 500 characters is required.')
    return value.strip()


def board(c, final=False):
    config = c.execute('SELECT * FROM race_config WHERE id=1').fetchone()
    weights = json.loads(config['weights']) if config['weights'] else None
    teams = [dict(r) for r in c.execute('SELECT * FROM race_teams ORDER BY id')]
    entries = []
    simulation = simulation_enabled()
    cutoff = min(time.time(), END)
    for r in c.execute('SELECT e.*,p.url,p.last_attempt,p.status,ev.starts AS event_start FROM race_entries e JOIN posts p ON p.id=e.post_id JOIN race_events ev ON ev.id=e.event_id'):
        e = dict(r)
        e['simulation'] = e.pop('event_start') < START
        if e['simulation'] and not simulation:
            continue
        manual = c.execute('SELECT observed_at,likes,comments,views,final FROM race_manual WHERE entry_id=? AND observed_at<=? '
                           + ('AND final=1 ' if final else '') + 'ORDER BY observed_at DESC,id DESC LIMIT 1', (e['id'], cutoff)).fetchone()
        auto = None if final else c.execute('SELECT collected_at AS observed_at,likes,comments,views FROM snapshots WHERE post_id=? AND collected_at BETWEEN ? AND ? ORDER BY collected_at DESC,id DESC LIMIT 1', (e['post_id'], e['published_at'], cutoff)).fetchone()
        sample = manual if manual and (not auto or manual['observed_at'] >= auto['observed_at']) else auto
        e['metrics'] = {k: sample[k] for k in METRICS} if sample else None
        e['observed_at'] = sample['observed_at'] if sample else None
        e['source'] = ('manual' if sample is manual else 'automatic') if sample else None
        e['score'] = sum(sample[k] * weights[k] for k in METRICS if weights[k]) if weights and sample and all(sample[k] is not None for k in METRICS if weights[k]) else None
        entries.append(e)
    if not simulation:
        test_only = {r[0] for r in c.execute('SELECT e.team_id FROM race_entries e JOIN race_events ev ON ev.id=e.event_id GROUP BY e.team_id HAVING max(ev.starts) < ?', (START,))}
        teams = [team for team in teams if team['id'] not in test_only]
    for team in teams:
        posts = [e for e in entries if e['team_id'] == team['id']]
        team['posts'] = len(posts)
        team['missing'] = sum(e['score'] is None for e in posts)
        team['score'] = sum(e['score'] for e in posts) if weights and posts and not team['missing'] else None
    teams.sort(key=lambda t: (t['score'] is None, -(t['score'] or 0), t['id']))
    for team in teams:
        team['rank'] = 1 + sum(t['score'] is not None and t['score'] > team['score'] for t in teams) if team['score'] is not None else None
        rank = team['rank']
        tied = rank and sum(t['score'] == team['score'] for t in teams) > 1
        team['bonus_percent'] = (2 if rank == 1 else 1 if rank in (2, 3) else 0) if rank and not tied else None
        team['bonus_points'] = team['base_points'] * team['bonus_percent'] / 100 if team['base_points'] is not None and team['bonus_percent'] is not None else None
    return {'start': START, 'end': END, 'weights': weights, 'simulation': simulation, 'state': 'SIMULATION — not official results' if simulation else 'Awaiting scoring rules' if not weights else 'Provisional', 'teams': teams, 'entries': entries,
            'events': [dict(r) for r in c.execute('SELECT * FROM race_events WHERE starts>=? OR ? ORDER BY starts', (START, simulation))]}


def read(admin=False):
    with storage.connection() as c:
        frozen = c.execute('SELECT frozen FROM race_config WHERE id=1').fetchone()[0]
        result = json.loads(frozen) if frozen else board(c)
        if admin:
            result['available_teams'] = [dict(r) for r in c.execute('SELECT * FROM race_teams ORDER BY id')]
            result['audit'] = [dict(r) for r in c.execute('SELECT * FROM race_audit ORDER BY id DESC LIMIT 100')]
        return result


def mutate(action, p, actor, limit=100):
    now = time.time()
    with storage.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        cfg = c.execute('SELECT * FROM race_config WHERE id=1').fetchone()
        if cfg['frozen']:
            raise ValueError('The final results are frozen.')
        if action == 'weights':
            if cfg['weights'] and now >= START:
                raise ValueError('Scoring rules are locked after the race starts.')
            weights = {k: integer(p.get(k)) for k in METRICS}
            if not any(weights.values()):
                raise ValueError('At least one metric must have a positive weight.')
            c.execute('UPDATE race_config SET weights=? WHERE id=1', (json.dumps(weights),))
        elif action == 'team':
            c.execute('INSERT INTO race_teams(name,representative,base_points) VALUES(?,?,?)', (name(p.get('name')), name(p.get('representative')), integer(p.get('base_points'), True)))
        elif action == 'base':
            if not c.execute('UPDATE race_teams SET base_points=? WHERE id=?', (integer(p.get('base_points')), integer(p.get('team_id')))).rowcount:
                raise ValueError('Team not found.')
        elif action == 'event':
            starts, ends = timestamp(p.get('starts')), timestamp(p.get('ends'))
            official = START <= starts < ends <= END
            test_event = simulation_enabled() and starts < ends < START
            if not (official or test_event):
                raise ValueError('Use a window inside the Grand Prix, or enable RACE_SIMULATION for a test event entirely before 28 October at 18:00 KST.')
            c.execute('INSERT INTO race_events(name,starts,ends) VALUES(?,?,?)', (name(p.get('name')), starts, ends))
        elif action == 'entry':
            target = normalize_url(p.get('url'))
            if target.platform not in ('instagram', 'tiktok'):
                raise ValueError('Only Instagram and TikTok are eligible for this race.')
            team, event = integer(p.get('team_id')), integer(p.get('event_id'))
            ev = c.execute('SELECT * FROM race_events WHERE id=?', (event,)).fetchone()
            published = timestamp(p.get('published_at'))
            if not ev or not ev['starts'] <= published <= ev['ends'] or published > now:
                raise ValueError('Publication must be within the event window and cannot be in the future.')
            if ev['starts'] < START and not simulation_enabled():
                raise ValueError('This is a simulation event. Enable RACE_SIMULATION before the race starts to add test posts.')
            post = c.execute('SELECT id FROM posts WHERE platform=? AND remote_id=?', (target.platform, target.remote_id)).fetchone()
            if not post:
                if c.execute('SELECT count(*) FROM posts').fetchone()[0] >= limit:
                    raise ValueError('Post limit reached.')
                pid = c.execute('INSERT INTO posts(platform,remote_id,url,created_at,next_check) VALUES(?,?,?,?,?)', (target.platform, target.remote_id, target.url, now, next_check(now))).lastrowid
            else:
                pid = post['id']
            c.execute('INSERT INTO race_entries(team_id,event_id,post_id,platform,published_at) VALUES(?,?,?,?,?)', (team, event, pid, target.platform, published))
            due = now if ev['starts'] < START else next_check(now)
            c.execute('UPDATE posts SET next_check=? WHERE id=?', (due, pid))
        elif action == 'manual':
            eid = integer(p.get('entry_id'))
            entry = c.execute('SELECT * FROM race_entries WHERE id=?', (eid,)).fetchone()
            observed = timestamp(p.get('observed_at'))
            if not entry or not entry['published_at'] <= observed <= min(now, END):
                raise ValueError('Observation must be after publication and no later than now or the race cutoff.')
            final = p.get('final') is True
            if final and now < END:
                raise ValueError('Final observations can only be certified after the race closes.')
            if final and observed != END:
                raise ValueError('Certified final counts must refer to 8 November 2026 at 23:59 KST.')
            counts = [integer(p.get(k), True) for k in METRICS]
            if all(v is None for v in counts):
                raise ValueError('Enter at least one metric.')
            evidence = name(p.get('evidence'))
            c.execute('INSERT INTO race_manual(entry_id,observed_at,recorded_at,likes,comments,views,final,evidence,actor) VALUES(?,?,?,?,?,?,?,?,?)', (eid, observed, now, *counts, int(final), evidence, actor))
        elif action == 'finalize':
            result = board(c, final=True)
            if now < END or not result['weights'] or not result['entries'] or any(t['score'] is None for t in result['teams']):
                raise ValueError('Finalization requires a closed race, confirmed weights and certified final counts for every team and post.')
            if any(t['rank'] <= 3 and t['bonus_percent'] is None for t in result['teams']):
                raise ValueError('A podium tie needs an agreed tie-break rule before finalization.')
            result['state'] = 'Final'
            result['finalized_at'] = now
            c.execute('UPDATE race_config SET frozen=? WHERE id=1', (json.dumps(result),))
        else:
            raise ValueError('Unknown race action.')
        c.execute('INSERT INTO race_audit(recorded_at,actor,action,details) VALUES(?,?,?,?)', (now, actor, action, json.dumps(p)))
    return {'ok': True}
