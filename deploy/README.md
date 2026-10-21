# Production deployment on rio-server

The deployment workflow uses the same architecture as the other rrr-io projects:
push to `main` → tests → SSH upload → Docker Compose → Caddy.

The source repository is `rrr-io/e1-social-race`. Run Git commands from the
application root containing `app.py`, `Dockerfile`, `static/` and `tests/`.
Local Docker configuration is separate from production configuration.

## 1. GitHub configuration

The repository must have these Actions secrets:

- `SSH_HOST`: the same deployment host as the other projects.
- `SSH_USER`: the same SSH deployment user, usually `ubuntu`.
- `SSH_KEY`: the private deployment key whose public key is authorized on the host.

Secret values cannot be checked through public repository access. Match their
names exactly. The workflow uses port 22, like the reference projects.

Optional Actions variable `SSH_KNOWN_HOSTS`: a verified known_hosts entry for
this server. When absent, the workflow discovers the key with ssh-keyscan,
matching existing workflows; discovery alone does not independently verify
server identity. Pin an entry verified against your trusted SSH connection.

Runtime settings are stored in `/opt/social-pulse/.env` on the server. No
additional GitHub password or cookie secret is required.

## 2. One-time server preparation

Connect using your normal SSH account. The commands below assume that account
matches `SSH_USER` and already has Docker access, as with your other projects.

```bash
sudo mkdir -p /opt/social-pulse
sudo chown "$(id -un):$(id -gn)" /opt/social-pulse
mkdir -p /opt/social-pulse/secrets
chmod 700 /opt/social-pulse
chmod 755 /opt/social-pulse/secrets
docker compose version
docker network inspect web
```

The `web` network should already exist. If missing, investigate the current
Caddy networking before proceeding; do not disconnect or replace other apps.
Check its membership with:

```bash
docker inspect caddy --format '{{json .NetworkSettings.Networks}}'
```

Create the runtime environment:

```bash
nano /opt/social-pulse/.env
chmod 600 /opt/social-pulse/.env
```

Use this content, replacing the password with a new unique value:

```dotenv
ADMIN_USER=admin
ADMIN_PASSWORD=REPLACE_WITH_A_NEW_LONG_PASSWORD
PUBLIC_ORIGIN=https://social-pulse.rrriooo.com
POLL_INTERVAL_MINUTES=60
MAX_POSTS=100
YOUTUBE_API_KEY=
TIKTOK_COOKIES_FILE=
```

The example hostname is `social-pulse.rrriooo.com`; configure its DNS record before using it.
Change it here and in the Caddy block if you want another hostname. Use a
password of at least 12 characters; generating a hex password avoids dotenv
interpolation issues. Keep the password private.

The `secrets/` directory stores an optional TikTok session file. It is unrelated
to GitHub Actions secrets. The production Compose configuration mounts this
directory unconditionally, so create it even if it will remain empty.

## 3. Optional TikTok cookies

For the first infrastructure deployment you can leave `TIKTOK_COOKIES_FILE`
empty. To use cookies, privately transfer a fresh Netscape export to:

```text
/opt/social-pulse/secrets/tiktok.cookies.txt
```

For example, from your Mac (replace SERVER_IP):

```bash
scp "$HOME/Downloads/www.tiktok.com_cookies.txt" \
  ubuntu@SERVER_IP:/opt/social-pulse/secrets/tiktok.cookies.txt
```

On the server with standard rootful Docker:

```bash
sudo chown 10001:10001 /opt/social-pulse/secrets/tiktok.cookies.txt
sudo chmod 600 /opt/social-pulse/secrets/tiktok.cookies.txt
```

Set in the server `.env`:

```dotenv
TIKTOK_COOKIES_FILE=/run/pulse-secrets/tiktok.cookies.txt
```

Production mounts the secret directory directly. Do not use the Mac path or
`TIKTOK_COOKIES_HOST_PATH` here; those belong to the local Compose override.
Do not include cookie contents in Git, logs or messages. Session changes and
platform blocks may still prevent collection after successful deployment.

## 4. Commit and push from your Mac

Configure the repository-local Git author before creating commits. Use an
email verified by your GitHub account or its exact GitHub noreply address:

```bash
git config --local user.name "rrr-io"
git config --local user.email "YOUR_VERIFIED_GITHUB_EMAIL"
git var GIT_AUTHOR_IDENT
```

If your SSH configuration defines `github-rio` for your personal GitHub key,
use `git@github-rio:rrr-io/e1-social-race.git` as the remote URL. Check with
`git remote -v`; use `git remote add origin` for a new remote or
`git remote set-url origin` for an existing one. The SSH identity grants push
access; the Git author email determines commit attribution.

After preparing the server, review and push your changes:

```bash
git status --short
git add .
git diff --cached --name-only
git commit -m "Update Social Pulse"
git push origin main
```

Before committing, confirm the staged files do not include `.env`, session
cookies, private keys or databases. Keep the source at the repository root.
Every push to `main` triggers deployment. You can also use **Run workflow**
on the Actions page to redeploy the selected branch.

Open GitHub → Actions → Deploy Social Pulse. The workflow installs Python,
runs tests, packages application files, uploads to `/opt/social-pulse`, builds
the image and waits for its authenticated HTTP healthcheck. It never overwrites
the server `.env` or secret files. No checkout of a private repo is needed on
the server because the Actions runner uploads the package.

## 5. DNS and Caddy

Create an A record for `social-pulse.rrriooo.com` pointing to the server's public
IPv4 (or use an existing appropriate wildcard). Only set AAAA if server IPv6 is
configured. Existing Caddy must have inbound ports 80/443 available for HTTPS.

After the first successful deploy, append the block from
`deploy/Caddyfile.example` to `/srv/caddy/Caddyfile` on the server. Do not
replace the existing file or remove any existing site blocks.

```bash
sudo nano /srv/caddy/Caddyfile
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Run reload only if validation succeeds. Caddy reaches `e1-social-pulse:8000`
on the shared `web` network. No host port is published by this production
Compose file, avoiding conflicts with your other projects. The application
serves its dashboard and API through the same HTTPS hostname.

## 6. Verify and operate

```bash
cd /opt/social-pulse
docker compose --env-file .env -f deploy/compose.production.yaml ps
docker compose --env-file .env -f deploy/compose.production.yaml logs --tail=80 social-pulse
```

Check the public endpoint with:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://social-pulse.rrriooo.com/
```

An unauthenticated GET should return 401. Open the URL and sign in. Test a
real post and confirm a snapshot; a healthy deployment does not prove that
TikTok/Instagram collection works. If extraction fails, inspect the original
extractor error without exposing cookie values or credentials.

Future code deployments: push to main. Environment changes on the server:

```bash
cd /opt/social-pulse
docker compose --env-file .env -f deploy/compose.production.yaml up -d --force-recreate --wait
```

This production stack uses a new persistent volume under the stable project
name `social-pulse-production`. Local history is not migrated automatically.
Never use `down -v` or remove that volume unless you intend to delete history.
For backups, use SQLite's backup API against `/app/data/pulse.sqlite3` as
explained in the application README. Automated rollback is not implemented;
a failing healthcheck fails the workflow and needs investigation. Redeploy a
known-good commit to recover from a code regression.

## Related deployment workflows

- https://github.com/rrr-io/coven-gathering/blob/main/.github/workflows/deploy.yml
- https://github.com/rrr-io/coven-gathering/blob/main/deploy/docker-compose.yml
- https://github.com/rrr-io/my-race-engineer/blob/main/.github/workflows/deploy.yml
- https://github.com/rrr-io/e1-pixel-pit/blob/main/.github/workflows/deploy.yml
- https://github.com/rrr-io/e1-pixel-pit/blob/main/deploy/Caddyfile
