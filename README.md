# E1 Social Pulse

Self-hosted monitoring for public TikTok, Instagram and YouTube post metrics. Python backend, plain HTML/CSS/JavaScript dashboard, SQLite history and a background worker. No paid scraping service is required.

**Collection is best-effort.** Platforms may hide metrics, require sign-in or block server access. An authenticated session can help with sign-in requirements and anonymous rate limits, but cannot guarantee collection. Optional TikTok and Instagram cookie files provide session authentication. The application does not log in with a username/password or solve CAPTCHA.

## Choose your setup

- **Local development:** follow the Docker instructions below.
- **Production on rio-server:** follow the [deployment guide](deploy/README.md). GitHub Actions deploys on pushes to `main`; Caddy serves the dashboard and API over HTTPS.

The production configuration uses the `web` Docker network and its own database volume. Local Docker commands and cookie paths are different from production commands and paths.

## Start with Docker

Requires Docker Engine, Docker Compose and outbound Internet access.

```bash
cp .env.example .env
```

Set a unique `ADMIN_PASSWORD` of at least 12 characters in `.env`, then run:

```bash
docker compose up -d --build
```

Open **http://localhost:8000** and sign in with `admin` and your password.

For a remote Ubuntu server, establish a tunnel from your computer:

```bash
ssh -L 8000:127.0.0.1:8000 ubuntu@SERVER_IP
```

Then open `http://localhost:8000` on your computer. Docker exposes the port only on loopback. This tunnel applies to the local Compose configuration. For the production Caddy setup, use the [deployment guide](deploy/README.md). Basic authentication needs HTTPS over untrusted networks. All users sharing the password have administrator access.

## Updating an existing installation

Replace the application files in the **same project directory**, preserving your existing `.env`. Keep using the same Compose project name/directory so it reuses the existing volume. Then:

```bash
docker compose up -d --build
```

Do not run `docker compose down -v`: it deletes the database volume. If session cookies are not configured, collection continues anonymously.

## TikTok / Instagram: authenticated session for local Docker (optional)

For the production server, use the [production cookie setup](deploy/README.md#3-optional-tiktok--instagram-cookies). The steps below use `compose.yaml` plus `compose.cookies.yaml` (TikTok) and/or `compose.cookies.instagram.yaml` (Instagram); use either override on its own or both together.

**Do not put an account password or session cookies in the repository, even a private one.** The application does not accept TikTok or Instagram username/password variables. Cookies are credentials and belong in a private server-side file. Do not paste them into issues, logs or chats. For Instagram, prefer a secondary account used only for this: repeated anonymous-looking requests from an authenticated account can still get that account flagged or rate-limited.

1. Sign into your TikTok and/or Instagram account in a browser on your computer and confirm the target public post opens normally.
2. Export the session cookies in Mozilla/Netscape format. Use a trusted export method; yt-dlp supports browser-cookie export. A fresh browser profile used only for this account avoids exporting unrelated browsing sessions.
3. Transfer the cookie file(s) privately to the Docker host, outside the repository, for example `/srv/e1-pulse-secrets/tiktok.cookies.txt` and/or `/srv/e1-pulse-secrets/instagram.cookies.txt`.
4. Restrict access to the file(s). The container runs as UID `10001`, which must be able to read them. With standard rootful Docker on Linux, for example:

```bash
sudo chown 10001:10001 /srv/e1-pulse-secrets/tiktok.cookies.txt /srv/e1-pulse-secrets/instagram.cookies.txt
sudo chmod 600 /srv/e1-pulse-secrets/tiktok.cookies.txt /srv/e1-pulse-secrets/instagram.cookies.txt
```

Rootless Docker/user namespaces may require different host ownership. Do not make the files world-readable to fix permissions.

5. Set the matching path(s) in `.env`:

```dotenv
TIKTOK_COOKIES_HOST_PATH=/srv/e1-pulse-secrets/tiktok.cookies.txt
INSTAGRAM_COOKIES_HOST_PATH=/srv/e1-pulse-secrets/instagram.cookies.txt
```

6. Start with the optional Compose override(s), combining only the ones you configured:

```bash
docker compose -f compose.yaml -f compose.cookies.yaml -f compose.cookies.instagram.yaml up -d --build
```

Use the same `-f` combination for subsequent Compose updates while using cookies. Each override mounts its cookie file as a read-only secret and sets `TIKTOK_COOKIES_FILE` / `INSTAGRAM_COOKIES_FILE` inside the container. The collector copies only that platform's domain entries to a private temporary cookie jar, lets yt-dlp use that copy, and removes it after each attempt. The original secret is never modified or included in the Docker image. Cookie updates from the extractor are not persisted: export a fresh session if it expires. After replacing a host file, recreate the container to ensure the new mount is picked up.

For direct Python execution, set `TIKTOK_COOKIES_FILE` / `INSTAGRAM_COOKIES_FILE` to your private local file instead. The `*_HOST_PATH` variables are only used by the local Compose overrides. Production sets the `*_COOKIES_FILE` variables to the mounted paths described in the deployment guide.

### Exporting with yt-dlp

On the computer where you signed in, using a dedicated Firefox profile, you can export cookies and attempt metadata extraction:

```bash
python -m yt_dlp --cookies-from-browser firefox --cookies /absolute/private/path/tiktok.cookies.txt --skip-download -- "https://www.tiktok.com/@username/video/VIDEO_ID"
python -m yt_dlp --cookies-from-browser firefox --cookies /absolute/private/path/instagram.cookies.txt --skip-download -- "https://www.instagram.com/reel/CODE/"
```

Replace the example URLs with the actual public posts. For a specific profile, use `firefox:PROFILE_PATH`. The export may contain all cookies from the selected browser profile, so treat the entire exported file as a secret. Only that platform's domain entries are forwarded by this application. See the official [yt-dlp cookie FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp).

A new account is not necessarily required. Cookies may help if sign-in or an anonymous rate limit is the problem; they may not fix expired sessions, server-IP restrictions, bot challenges or changes to the extractor. Troubleshooting requires the original extractor error. Local tests do not establish that authenticated TikTok or Instagram collection will work from your server.

## Features

- Add a post link, creator label and team.
- Monitor views, likes and comment counts; no video files or comment text are downloaded.
- Automatic checks every 60 minutes while the server stays running, even with the dashboard closed.
- Latest snapshot, change from the first snapshot, local display timestamps and collector source.
- Platform and text filters, per-post history, CSV export, pause/resume, manual refresh and deletion.
- Persistent database in the Docker volume.

No historical reconstruction before you added a link, challenge leaderboard, deadline scoring, global CSV export or fake-engagement detection is included.

## Supported links and limitations

| Platform | Links | Collection |
| --- | --- | --- |
| YouTube | `/watch?v=ID`, `youtu.be/ID`, `/shorts/ID`, `/live/ID` | Official API when configured, otherwise yt-dlp. Some counts may be unavailable. |
| TikTok | `https://www.tiktok.com/@username/video/ID` | yt-dlp, anonymous or with the optional cookie file. Open short links in a browser and copy the full address first. Photo posts are unsupported. |
| Instagram | `/reel/CODE/`, `/reels/CODE/`, `/p/CODE/`, `/tv/CODE/` | yt-dlp, anonymous or with the optional cookie file, primarily videos/Reels. Photos and carousels are not guaranteed. Carousel metrics are never summed across entries. |

Reading a post manually does not guarantee a server can extract it. No OCR is used; counts come from structured metadata, not rounded visual labels such as “1.2K”.

## Data semantics

- **Up to date**: all three metrics are present in the latest snapshot.
- **Partial data**: at least one metric is available; missing fields are `null`, displayed as `—`.
- **Last attempt failed**: no new snapshot; previous values remain visible with their original timestamp.
- **Queued / Collecting**: a check is pending or running.
- **Paused**: no new automatic check starts. An already running check may complete.

Actual zeros remain zero. Missing metrics are not replaced with old values from different timestamps. Decreases are preserved. Deltas require values in both the first and latest snapshots. Metrics from different platforms are not inherently comparable, so no combined score is calculated.

## Optional YouTube API

1. Enable **YouTube Data API v3** in a Google Cloud project.
2. Create an API key restricted to that API and, where possible, the server IP.
3. Set `YOUTUBE_API_KEY` in `.env` and recreate the container.

Public videos do not require creator authorization. The collector uses `videos.list` with `statistics,snippet`. Your Google project quotas apply. When a key is configured, API errors are shown instead of silently switching to scraping.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_USER` | `admin` | Dashboard/API username |
| `ADMIN_PASSWORD` | required | At least 12 characters |
| `PUBLIC_ORIGIN` | `http://localhost:8000` | Exact browser origin for request protection |
| `POLL_INTERVAL_MINUTES` | `60` | Interval after a check, minimum 15 minutes |
| `MAX_POSTS` | `100` | Maximum saved posts, including paused posts |
| `YOUTUBE_API_KEY` | empty | Enable the official YouTube API |
| `TIKTOK_COOKIES_HOST_PATH` | unset | Host file for the optional Compose secret (TikTok) |
| `TIKTOK_COOKIES_FILE` | unset | Cookie-file path inside the running application (TikTok) |
| `INSTAGRAM_COOKIES_HOST_PATH` | unset | Host file for the optional Compose secret (Instagram) |
| `INSTAGRAM_COOKIES_FILE` | unset | Cookie-file path inside the running application (Instagram) |
| `DATABASE_PATH` | `data/pulse.sqlite3` | SQLite location; normally leave unchanged |

A single worker processes one post at a time, with a 90-second timeout and a 10-second gap between attempts. Queues can delay scheduled checks. Manual refresh has a 5-minute cooldown. Consecutive errors increase the retry interval up to 24 hours; a successful collection restores the normal interval. Sampling is not guaranteed at exact or identical times across posts.

## Run without Docker

Python 3.12 is recommended.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export ADMIN_PASSWORD='choose-a-unique-password'
python app.py
```

Direct execution reads environment variables; it does **not** load `.env` automatically. Set optional variables with `export` as needed. Run only one application instance per database because the worker is embedded.

```bash
python -m unittest discover -s tests -v
```

## Local maintenance and backup

For production, use the Compose command and volume described in the [deployment guide](deploy/README.md#6-verify-and-operate).

Platforms change. Update yt-dlp when an extractor stops working:

```bash
docker compose build --no-cache
docker compose up -d
```

If you use cookies, include the same `-f` flags you used to start the stack (e.g. `-f compose.yaml -f compose.cookies.yaml -f compose.cookies.instagram.yaml`) in both commands. Without Docker: `pip install -U yt-dlp`. Check the installed version with `docker compose exec social-pulse python -m yt_dlp --version`.

Create a consistent backup while the server runs:

```bash
docker compose exec social-pulse python -c "import sqlite3; s=sqlite3.connect('/app/data/pulse.sqlite3'); d=sqlite3.connect('/app/data/backup.sqlite3'); s.backup(d); d.close(); s.close()"
docker compose cp social-pulse:/app/data/backup.sqlite3 ./backup.sqlite3
```

History has no automatic retention limit. Deleting a post also deletes all its snapshots. Back up regularly.

## Project structure and validation

- `app.py`: authenticated HTTP endpoints and worker.
- `collectors.py`: URL validation, YouTube API, yt-dlp and optional TikTok/Instagram cookies.
- `storage.py`: SQLite, snapshots, scheduling and legacy error translation.
- `deploy/`: production Docker configuration, health check and server setup instructions.
- `.github/workflows/deploy.yml`: tests and SSH deployment on pushes to `main`.
- `static/`: dashboard with no external JavaScript dependencies.
- `tests/`: local unit and HTTP tests; no platform calls or real credentials.

Tests cover URL handling, missing counts, timeout, stale snapshot preservation, retry scheduling, serialization, pause/delete, authentication, Origin checks, duplicates, CSV and cookie-file handling. They do not certify live extraction from the three platforms. The database starts empty.

## Language and compatibility

The interface, application messages, comments and documentation are in English. Dates and numbers use the `en-GB` locale; displayed times use the browser's local timezone.

`storage.py` retains exact Italian error strings as migration lookup keys for databases created by the first release. They are matched and replaced with English messages at startup. These legacy keys are compatibility data, not new application messages. User-provided creator labels, team names and imported post titles are preserved in their original language.

## Technical references

- https://github.com/yt-dlp/yt-dlp
- https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp
- https://developers.google.com/youtube/v3/docs/videos
- https://developers.google.com/youtube/v3/getting-started

## Social Grid Race

The competition extension adds `/` (public standings) and `/admin` (authenticated administration with Setup, Track posts and Register posts tabs). See [RACE.md](RACE.md) for setup, scoring, the KST schedule, manual evidence, finalization and deployment limitations. Facebook is excluded from this MVP.
