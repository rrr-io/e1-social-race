# Social Grid Race MVP

This extension preserves the existing collection tracker and SQLite database.

- `/`: public team/creator leaderboard and official posts. No login required.
- `/admin#setup`: events, teams/creators and scoring configuration.
- `/admin#register`: register tracked posts, record manual counts and review results.
- `/admin#monitoring`: original authenticated tracker, collection errors, pause and refresh controls.

## Confirmed mechanics

One representative per team; one post per platform, team and event. Instagram and TikTok are eligible. YouTube remains available in the standalone tracker. Facebook is not included.

The race runs from **28 October 2026, 18:00 KST** to **8 November 2026, 23:59 KST**. The implementation treats the cutoff as exactly 23:59:00. Posting events and their windows are entered by the admin; the application does not assume daily events or import the older November 9 schedule.

Each creator's score is the sum of their official posts' latest cumulative engagement scores. Historical snapshots are never added together. A viral post contributes its full score: there is no per-post cap or normalization. With one representative per team, creator and team rankings coincide. The public post table is an observation register, not a separate winners leaderboard.

## Setup

1. Open `/admin#setup` using the existing administrator credentials.
2. Confirm the agreed integer weights for likes, comments and views. Zero excludes a metric. No formula is preselected; rankings remain unavailable until configured. Shares/reposts are not collected in this release. Weights are locked after the race begins once configured.
3. Add teams and their representatives. Representative names are unique, case-insensitively; enter each person's identity consistently.
4. Add the scheduled posting events and their KST publication windows.
5. In **Track posts**, add the canonical Instagram or TikTok link and a post name. In **Register posts**, find that tracked post and choose an existing event and team/creator. Enter the actual publication time in KST. The admin must verify ownership, hashtags, theme and eligibility. Registration reuses the existing tracker record and snapshots; it does not create another post.
6. Inspect the tracker for collection failures. Record manual counts when necessary, including observation time and an evidence reference or correction reason. Blank metrics are unknown, not zero. Corrections append records rather than overwrite history. Automatic observations with a later actual timestamp supersede manual observations in the provisional standings.

An official post cannot be deleted through the tracker. This MVP does not offer entry replacement, disqualification or representative reassignment. Confirm the registration before submitting it. Failed duplicate submissions roll back atomically, including any newly created tracker record.

## Observation schedule and outages

Registered race posts are scheduled at 22:00 KST daily and for one final attempt at the cutoff. The existing single worker processes posts sequentially, with collection time and spacing between posts. Consequently, 22:00 is the scheduled start, not a guarantee of simultaneous snapshots. Observations retain their actual collection time. Manual refresh remains available in the tracker with its existing rate limit. Non-race posts retain their usual polling interval.

A failed race collection retains the previous observation and schedules the next daily attempt. It does not retry hourly. Paused posts stay paused. After downtime an overdue attempt runs when the worker is available; missed historical counts cannot be reconstructed. The UI displays the last observation time. A team with missing required metrics has no score; other provisional ranks are not guaranteed final.

Cookies and automatic extraction remain subject to platform access restrictions. This extension does not fix bot challenges or guarantee automatic counts. Manual entry is a first-class fallback. Manual observations are stored in `race_manual` and the race audit, separately from automatic `snapshots`; the legacy per-post CSV exports automatic observations only.

## Closing the race

Automatic observations made after the cutoff are excluded from scoring. A collector started at the cutoff normally finishes later, so its result is diagnostic rather than eligible final evidence. The system never presents a late count as a historical count.

After closure, enter a certified manual final observation for each official post, referring to **8 November 23:59 KST**, with evidence for the cutoff counts. Then review all eligibility and figures and select **Freeze and publish final results**. This creates an immutable result snapshot and blocks further race mutations. Existing collection history is retained. Finalization is blocked if a team has no posts, any post lacks required final metrics, or a tie affects the podium. No tie-break rule has been invented.

P1 receives 2%, P2 and P3 each receive 1% of their team's entered Grand Prix base points. These figures are previews; no points are transferred to an external voting system. Base points can be entered or corrected before finalization. No integer rounding policy is imposed: fractional bonus values are displayed. Agree the formula, tie-break rule, rounding policy and acceptable cutoff evidence before launch.

## Deployment and data

The existing GitHub Actions deployment now bundles `race.py`; the production Dockerfile copies it. No new Python packages, secrets or Caddy routes are needed if Caddy already proxies the whole hostname to this app. If Caddy has its own site-wide authentication, the public page will remain behind that authentication until you change the proxy policy.

Back up the SQLite database before deployment. For an online backup use SQLite's backup API, rather than copying only the main database file while WAL writes are active. Startup adds race tables without deleting or rewriting existing posts or metric snapshots. Database volumes and current cookie mounts are unchanged.

The public endpoint intentionally publishes team and representative names, official post URLs, counts, observation timestamps and bonus previews. Evidence references, audit details and administrator identity are available only to authenticated admins. The application still uses one shared Basic Auth administrator account, not per-person accounts.

Run checks:

```sh
python -m unittest discover -s tests -v
node --check static/race.js
```

Rollback: deploy the previous code after a database backup. The previous code ignores the extra tables, but it does not enforce race constraints or the race schedule. Do not administer official entries from the older version.

## Two pages, one admin workspace

- `https://e1-social-race.rrriooo.com/` is the public leaderboard.
- `https://e1-social-race.rrriooo.com/admin` is the authenticated administration page.

The admin page has three tabs: **Setup**, **Track posts**, and **Register posts**. Hash links `/admin#setup`, `/admin#monitoring` and `/admin#register` select a tab without opening another page. Old `#race` links select Setup. Track posts accepts only a link and post name. Register posts lists tracked posts and lets the admin select existing events and team/creator pairs; registered posts show their current assignment. Unsupported platforms are marked as tracking-only. Manual observations and final results are available in a collapsible section under Register posts. Scoring settings and the audit trail are under Setup. The tracker history contains automatic observations.

Registration uses the authenticated `/api/race/register-post` endpoint with `post_id`, `team_id`, `event_id` and `published_at`. It rejects unknown posts and preserves the tracked post ID and history. The older `/api/race/entry` endpoint remains available for existing integrations; the admin UI no longer uses it.

Legacy `/race` and `/race-admin` links redirect to `/` and `/admin#race`. The health check verifies the authenticated `/admin` endpoint. API authorization is unchanged: only the leaderboard API is public. Use `PUBLIC_ORIGIN=https://e1-social-race.rrriooo.com` on the server, with no path.

## Pre-race simulation

Set `RACE_SIMULATION=true` in the server `.env` and recreate the container to allow test events entirely before 28 October 2026 at 18:00 KST. Official date limits remain unchanged. Mixed test/official windows are rejected. Register a real Instagram or TikTok post whose actual publication time falls within the test event. The first test collection is queued immediately; later checks follow 22:00 KST, with the existing manual Refresh available in Post monitoring. An already paused tracker record must be resumed.

The leaderboard is labelled **SIMULATION — not official results** while this mode is active. It uses real platform requests, so cookies and platform blocks still apply. Manual input remains available. This is not a separate database: test posts and observations remain stored and visible in the authenticated tracker.

Set `RACE_SIMULATION=false` and recreate the container when finished. The override also expires automatically at the official race start. Events beginning before the official start and their entries are then excluded from the race leaderboard and final scoring; teams with only test entries are hidden from standings. To participate officially, register posts under an official event. Test-only records remain in the database and audit. Do not change the hard-coded Grand Prix dates to run a test.

Production restart (after deploying the patch):

```sh
cd /opt/social-pulse
docker compose --env-file .env -f deploy/compose.production.yaml up -d --force-recreate
```

## Reviewing and editing events

Open `/admin#setup` and find **Posting events** above the setup forms. The list includes all events, including past simulation events, their KST windows and assigned-post counts. **Edit** fills the event form; **Save changes** updates the existing event without changing its ID or post assignments. **Cancel edit** returns the form to creation mode.

The same official/simulation date rules apply to edits. A new window cannot exclude an assigned post's publication time. Events with posts cannot change from simulation to official status or vice versa. Finalized results lock all event edits. Duplicate names are rejected with a specific message. Each update records the previous and new values in the administrator audit trail. Save errors are displayed directly under the relevant form.
