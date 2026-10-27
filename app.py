import base64
import csv
import hmac
import io
import json
import logging
import os
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import storage
import race
from collectors import CollectionError, Target, collect, normalize_url

STATIC = Path(__file__).parent / 'static'
STOP = threading.Event()
PASSWORD = os.getenv('ADMIN_PASSWORD', '')
USERNAME = os.getenv('ADMIN_USER', 'admin')
PORT = int(os.getenv('PORT', '8000'))
PUBLIC_ORIGIN = os.getenv('PUBLIC_ORIGIN', f'http://localhost:{PORT}').rstrip('/')
MAX_POSTS = max(1, int(os.getenv('MAX_POSTS', '100')))


def worker():
    while not STOP.is_set():
        try:
            post = storage.claim()
            if not post:
                STOP.wait(3)
                continue
            try:
                data = collect(Target(post['platform'], post['remote_id'], post['url']))
                storage.finish(post, data=data)
            except CollectionError as exc:
                storage.finish(post, error=str(exc))
            except Exception:
                logging.exception('Collector failure for post %s', post['id'])
                storage.finish(post, error='Internal collector error; check the server logs.')
            STOP.wait(10)  # At most one collection at a time, no request bursts.
        except Exception:
            logging.exception('Worker error')
            STOP.wait(10)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        logging.info('%s %s', self.address_string(), fmt % args)

    def reply(self, status, body, content_type='application/json; charset=utf-8', extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def authenticated(self):
        expected = 'Basic ' + base64.b64encode(f'{USERNAME}:{PASSWORD}'.encode()).decode()
        if not PASSWORD or not hmac.compare_digest(self.headers.get('Authorization', ''), expected):
            self.reply(401, {'error': 'Authentication required'}, extra={'WWW-Authenticate': 'Basic realm="Social Pulse", charset="UTF-8"'})
            return False
        return True

    def do_GET(self):
        path = urlsplit(self.path).path
        redirects = {'/race': '/', '/race/': '/', '/race-admin': '/admin#race', '/race-admin/': '/admin#race', '/admin/': '/admin'}
        if path in redirects:
            return self.reply(302, '', extra={'Location': redirects[path]})
        if path == '/api/race':
            return self.reply(200, race.read())
        public = {'/': ('race.html', 'text/html'), '/race.js': ('race.js', 'application/javascript'), '/race.css': ('race.css', 'text/css'),
                  '/common.js': ('common.js', 'application/javascript'), '/common.css': ('common.css', 'text/css'),
                  '/e1-logo.png': ('e1-logo.png', 'image/png')}
        if path in public:
            filename, mime = public[path]
            return self.reply(200, (STATIC / filename).read_bytes(), mime if mime.startswith('image/') else mime + '; charset=utf-8')
        if not self.authenticated():
            return
        if path == '/api/race/admin':
            return self.reply(200, race.read(admin=True))
        admin_files = {'/admin': ('index.html', 'text/html'), '/app.js': ('app.js', 'application/javascript'), '/style.css': ('style.css', 'text/css'),
                       '/admin.js': ('admin.js', 'application/javascript'), '/admin.css': ('admin.css', 'text/css'), '/share.js': ('share.js', 'application/javascript')}
        if path in admin_files:
            filename, mime = admin_files[path]
            return self.reply(200, (STATIC / filename).read_bytes(), mime if mime.startswith('image/') else mime + '; charset=utf-8')
        if path == '/api/posts':
            return self.reply(200, {'posts': storage.rows(), 'interval_minutes': storage.INTERVAL // 60})
        match = re.fullmatch(r'/api/posts/(\d+)/(history|export)', path)
        if match:
            with storage.connection() as c:
                if not c.execute('SELECT 1 FROM posts WHERE id=?', (match[1],)).fetchone():
                    return self.reply(404, {'error': 'Post not found'})
                history = [dict(r) for r in c.execute('SELECT collected_at,views,likes,comments,source FROM snapshots WHERE post_id=? ORDER BY collected_at,id', (match[1],))]
            if match[2] == 'history':
                return self.reply(200, history)
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(['timestamp_utc', 'views', 'likes', 'comments', 'source'])
            for row in history:
                writer.writerow([time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(row['collected_at'])), row['views'], row['likes'], row['comments'], row['source']])
            return self.reply(200, output.getvalue(), 'text/csv; charset=utf-8', {'Content-Disposition': f'attachment; filename="post-{match[1]}.csv"'})
        self.reply(404, {'error': 'Resource not found'})

    def do_POST(self):
        if not self.authenticated():
            return
        if self.headers.get('Origin') not in (None, PUBLIC_ORIGIN):
            return self.reply(403, {'error': 'Origin not allowed. Check PUBLIC_ORIGIN.'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.reply(415, {'error': 'Use application/json'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 8192:
                raise ValueError('Request is too large or empty')
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError('Invalid JSON')
            path = urlsplit(self.path).path
            if path.startswith('/api/race/'):
                return self.reply(200, race.mutate(path.rsplit('/', 1)[1], payload, USERNAME, MAX_POSTS))
            if path == '/api/posts':
                target = normalize_url(payload.get('url'))
                label = payload.get('label', '')
                team = payload.get('team', '')
                if not isinstance(label, str) or not isinstance(team, str):
                    raise ValueError('Label and team must be strings')
                with storage.connection() as c:
                    c.execute('BEGIN IMMEDIATE')
                    if c.execute('SELECT count(*) FROM posts').fetchone()[0] >= MAX_POSTS:
                        raise ValueError(f'Post limit reached ({MAX_POSTS})')
                    cur = c.execute('INSERT INTO posts(platform,remote_id,url,label,team,created_at) VALUES(?,?,?,?,?,?)',
                                    (target.platform, target.remote_id, target.url, label[:120], team[:80], time.time()))
                    post_id = cur.lastrowid
                return self.reply(201, {'id': post_id})
            match = re.fullmatch(r'/api/posts/(\d+)/(refresh|pause|delete)', path)
            if match:
                with storage.connection() as c:
                    row = c.execute('SELECT * FROM posts WHERE id=?', (match[1],)).fetchone()
                    if not row:
                        return self.reply(404, {'error': 'Post not found'})
                    action = match[2]
                    if action == 'delete':
                        if c.execute('SELECT 1 FROM race_entries WHERE post_id=?', (row['id'],)).fetchone():
                            raise ValueError('Official race posts cannot be deleted; their history must be retained.')
                        c.execute('DELETE FROM posts WHERE id=?', (row['id'],))
                    elif action == 'pause':
                        c.execute('UPDATE posts SET paused=? WHERE id=?', (1 - row['paused'], row['id']))
                    elif row['status'] == 'collecting' or (row['last_attempt'] and time.time() - row['last_attempt'] < 300):
                        return self.reply(429, {'error': 'Wait at least 5 minutes between manual attempts.'})
                    else:
                        c.execute("UPDATE posts SET next_check=0,status='queued',paused=0 WHERE id=?", (row['id'],))
                return self.reply(200, {'ok': True})
            self.reply(404, {'error': 'Resource not found'})
        except sqlite3.IntegrityError:
            self.reply(409, {'error': 'Duplicate or invalid record. Each team has one representative and one post per platform per event.'})
        except (ValueError, TypeError) as exc:
            self.reply(400, {'error': str(exc)})
        except Exception:
            logging.exception('Request failure')
            self.reply(500, {'error': 'Internal server error'})


def main():
    if len(PASSWORD) < 12 or ':' in USERNAME:
        raise SystemExit('Set ADMIN_PASSWORD (at least 12 characters) and ADMIN_USER without colons.')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    storage.init()
    threading.Thread(target=worker, daemon=True).start()
    server = ThreadingHTTPServer((os.getenv('HOST', '127.0.0.1'), PORT), Handler)
    print(f'E1 Social Pulse listening on {PUBLIC_ORIGIN}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        STOP.set()
        server.server_close()


if __name__ == '__main__':
    main()
