import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DB = os.getenv('DATABASE_PATH', 'data/pulse.sqlite3')
INTERVAL = max(15, int(os.getenv('POLL_INTERVAL_MINUTES', '60'))) * 60


@contextmanager
def connection():
    con = sqlite3.connect(DB, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    try:
        with con:
            yield con
    finally:
        con.close()


def init():
    Path(DB).parent.mkdir(parents=True, exist_ok=True)
    import race
    race.migrate(DB)
    with connection() as c:
        c.execute('PRAGMA journal_mode=WAL')
        c.executescript('''
        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY, platform TEXT NOT NULL, remote_id TEXT NOT NULL,
            url TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', team TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL,
            paused INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
            next_check REAL NOT NULL DEFAULT 0, last_attempt REAL,
            status TEXT NOT NULL DEFAULT 'queued', error TEXT,
            UNIQUE(platform,remote_id));
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
            collected_at REAL NOT NULL, views INTEGER, likes INTEGER, comments INTEGER,
            source TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS snapshot_post_time ON snapshots(post_id,collected_at);
        ''')
        import race
        race.init(c)
        race.reschedule(c)
        c.execute("UPDATE posts SET status='queued' WHERE status='collecting'")


def rows():
    with connection() as c:
        records = [dict(r) for r in c.execute('SELECT * FROM posts ORDER BY created_at DESC')]
        for r in records:
            latest = c.execute('SELECT * FROM snapshots WHERE post_id=? ORDER BY collected_at DESC,id DESC LIMIT 1', (r['id'],)).fetchone()
            first = c.execute('SELECT * FROM snapshots WHERE post_id=? ORDER BY collected_at,id LIMIT 1', (r['id'],)).fetchone()
            r['latest'] = dict(latest) if latest else None
            r['baseline'] = dict(first) if first else None
        return records


def claim():
    with connection() as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute("SELECT * FROM posts WHERE paused=0 AND next_check<=? AND status!='collecting' ORDER BY next_check,id LIMIT 1", (time.time(),)).fetchone()
        if row:
            c.execute("UPDATE posts SET status='collecting',last_attempt=? WHERE id=?", (time.time(), row['id']))
            return dict(row)


def finish(post, data=None, error=None):
    now = time.time()
    with connection() as c:
        if not c.execute('SELECT 1 FROM posts WHERE id=?', (post['id'],)).fetchone():
            return
        if error:
            failures = post['failures'] + 1
            delay = min(INTERVAL * 2 ** min(failures - 1, 8), 24 * 3600)
            c.execute("UPDATE posts SET status='error',error=?,failures=?,next_check=? WHERE id=?",
                      (error[:500], failures, now + delay, post['id']))
        else:
            c.execute('INSERT INTO snapshots(post_id,collected_at,views,likes,comments,source) VALUES(?,?,?,?,?,?)',
                      (post['id'], now, data['views'], data['likes'], data['comments'], data['source']))
            status = 'ok' if all(data[k] is not None for k in ('views', 'likes', 'comments')) else 'partial'
            c.execute('UPDATE posts SET title=?,status=?,error=NULL,failures=0,next_check=? WHERE id=?',
                      (data['title'], status, now + INTERVAL, post['id']))

        # Competition posts use the fixed KST observation schedule, including on failure.
        if c.execute('SELECT 1 FROM race_entries WHERE post_id=?', (post['id'],)).fetchone():
            import race
            c.execute('UPDATE posts SET next_check=? WHERE id=?', (race.next_check(now), post['id']))
