"""Public metadata collectors. Never download media or replace absent counts with 0."""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from contextlib import contextmanager
import urllib.parse
import urllib.request
from dataclasses import dataclass


class CollectionError(Exception):
    pass


@dataclass(frozen=True)
class Target:
    platform: str
    remote_id: str
    url: str


def normalize_url(raw):
    if not isinstance(raw, str) or len(raw) > 2048:
        raise ValueError('Invalid link.')
    p = urllib.parse.urlsplit(raw.strip())
    if p.scheme != 'https' or p.username or p.password or p.port not in (None, 443):
        raise ValueError('Use a public HTTPS link without credentials.')
    host = (p.hostname or '').lower()
    path = p.path.rstrip('/')
    if host in {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'}:
        if host == 'youtu.be':
            vid = path.lstrip('/')
        elif path == '/watch':
            vid = urllib.parse.parse_qs(p.query).get('v', [''])[0]
        else:
            m = re.fullmatch(r'/(?:shorts|live|embed)/([A-Za-z0-9_-]{11})', path)
            vid = m.group(1) if m else ''
        if re.fullmatch(r'[A-Za-z0-9_-]{11}', vid):
            return Target('youtube', vid, f'https://www.youtube.com/watch?v={vid}')
    elif host in {'instagram.com', 'www.instagram.com'}:
        m = re.fullmatch(r'/(p|reel|reels|tv)/([A-Za-z0-9_-]+)', path)
        if m:
            kind = 'reel' if m[1] == 'reels' else m[1]
            return Target('instagram', m[2], f'https://www.instagram.com/{kind}/{m[2]}/')
    elif host in {'tiktok.com', 'www.tiktok.com', 'm.tiktok.com'}:
        m = re.fullmatch(r'/@([A-Za-z0-9_.]+)/video/(\d{10,25})', path)
        if m:
            return Target('tiktok', m[2], f'https://www.tiktok.com/@{m[1]}/video/{m[2]}')
    raise ValueError('Paste the full link to a single post/video. For TikTok, open the short link in your browser first and copy https://www.tiktok.com/@username/video/ID.')


def count(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r'\d+', value):
        return int(value)
    return None


def metrics(info, source):
    result = {key: count(info.get(field)) for key, field in
              [('views', 'view_count'), ('likes', 'like_count'), ('comments', 'comment_count')]}
    if all(v is None for v in result.values()):
        raise CollectionError('No public metrics available: sign-in required, blocked access, unsupported post or hidden data.')
    return {**result, 'title': str(info.get('title') or '')[:300], 'source': source}


def youtube_api(target):
    query = urllib.parse.urlencode({'part': 'statistics,snippet', 'id': target.remote_id,
                                   'key': os.environ['YOUTUBE_API_KEY']})
    try:
        with urllib.request.urlopen('https://www.googleapis.com/youtube/v3/videos?' + query, timeout=30) as r:
            data = json.load(r)
    except Exception as exc:
        # Do not expose the request URL containing the API key.
        raise CollectionError('YouTube API unavailable: check the API key, quota and network.') from exc
    items = data.get('items', [])
    if not items:
        raise CollectionError('YouTube video unavailable or private.')
    item = items[0]
    s = item.get('statistics', {})
    return metrics({'title': item.get('snippet', {}).get('title'),
                    'view_count': s.get('viewCount'), 'like_count': s.get('likeCount'),
                    'comment_count': s.get('commentCount')}, 'youtube-api')



# Platform -> (env var holding the private cookie-file path, cookie domains to keep).
# A browser export may contain cookies for unrelated sites; only these are forwarded.
PLATFORM_COOKIE_ENV = {
    'tiktok': 'TIKTOK_COOKIES_FILE',
    'instagram': 'INSTAGRAM_COOKIES_FILE',
}
PLATFORM_COOKIE_DOMAINS = {
    'tiktok': ('tiktok.com',),
    'instagram': ('instagram.com',),
}


@contextmanager
def platform_cookie_copy(target):
    """Use a private writable copy: yt-dlp writes its cookie jar on exit."""
    env_var = PLATFORM_COOKIE_ENV.get(target.platform)
    configured = os.getenv(env_var, '').strip() if env_var else ''
    if not configured:
        yield None
        return
    domains = PLATFORM_COOKIE_DOMAINS[target.platform]
    label = target.platform.capitalize()
    try:
        original = Path(configured)
        if not original.is_file() or original.stat().st_size > 2_000_000:
            raise ValueError('Invalid cookie file')
        content = original.read_text(encoding='utf-8')
        if not content.startswith(('# Netscape HTTP Cookie File', '# HTTP Cookie File')):
            raise ValueError('Invalid cookie format')
        # Keep only this platform's domains, even if a browser export contains other sites.
        lines = ['# Netscape HTTP Cookie File']
        for line in content.splitlines():
            if not line or (line.startswith('#') and not line.startswith('#HttpOnly_')):
                continue
            fields = line.split('\t')
            if len(fields) != 7:
                continue
            domain = fields[0].removeprefix('#HttpOnly_').lstrip('.').lower()
            if any(domain == d or domain.endswith('.' + d) for d in domains):
                lines.append(line)
        if len(lines) == 1:
            raise ValueError(f'No {label} cookies')
    except (OSError, UnicodeError, ValueError) as exc:
        raise CollectionError(f'{label} cookies could not be loaded. Check the file permissions and Netscape format; export a signed-in {label} session again.') from exc
    with tempfile.TemporaryDirectory(prefix='pulse-session-') as directory:
        copied = Path(directory) / 'cookies.txt'
        copied.touch(mode=0o600)
        copied.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        yield str(copied)


def collect(target):
    if target.platform == 'youtube' and os.environ.get('YOUTUBE_API_KEY'):
        return youtube_api(target)
    # A separate process guarantees a hard timeout even if an extractor stalls.
    command = [sys.executable, '-m', 'yt_dlp', '--ignore-config', '--dump-single-json',
               '--skip-download', '--no-playlist', '--no-warnings', '--no-progress',
               '--socket-timeout', '20', '--retries', '0', '--extractor-retries', '0',
               '--no-check-formats']
    try:
        with platform_cookie_copy(target) as cookies:
            if cookies:
                command.extend(['--cookies', cookies])
            command.extend(['--', target.url])
            result = subprocess.run(command, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired as exc:
        raise CollectionError('Platform timed out after 90 seconds. A retry has been scheduled.') from exc
    if result.returncode:
        detail = result.stderr.lower()
        if 'no module named' in detail:
            raise CollectionError('Install dependencies: pip install -r requirements.txt.')
        if '429' in detail or 'too many requests' in detail:
            raise CollectionError('Platform rate limit reached. A slower retry has been scheduled.')
        if any(x in detail for x in ('captcha', 'not a bot', 'bot detection', 'automated requests')):
            raise CollectionError('The platform reported a browser or bot challenge. A signed-in session may not resolve it. No metrics were updated.')
        if '403' in detail or 'forbidden' in detail:
            raise CollectionError('The platform denied access (HTTP 403). This does not confirm that sign-in is the cause. No metrics were updated.')
        if any(x in detail for x in ('login', 'sign in', 'log in', 'cookies')):
            raise CollectionError('The extractor reported a sign-in or session requirement. For TikTok or Instagram, configure or refresh TIKTOK_COOKIES_FILE / INSTAGRAM_COOKIES_FILE. No metrics were updated.')
        raise CollectionError('Extraction failed: unavailable/unsupported post, network error or outdated extractor.')
    try:
        info = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise CollectionError('Invalid collector response.') from exc
    # Never sum carousel entries: likes/comments may be shared across slides.
    # Playlist-level fields are usable; missing ones remain unknown.
    if target.platform in ('youtube', 'tiktok') and str(info.get('id')) != target.remote_id:
        raise CollectionError('The returned ID does not match the requested post.')
    return metrics(info, 'yt-dlp')
