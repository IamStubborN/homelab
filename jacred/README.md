# JacRed resource budget

Background crawling may share resources with routing and interactive services.
JacRed is limited to 0.6 CPU and the dedicated `solverr-crawl` pool to 0.5 CPU.
Both use `cpu_shares: 256` to yield under contention. The interactive Solverr
pool retains its existing budget. These are CPU budgets, not request limits.

The private `jacred/config/init.yaml` should contain:

```yaml
tracks: true
tracksconcurrency: 1
```

`tracksconcurrency` limits background TorrServer metadata analyses, not user
playback. JacRed defaults to two analyses; one reduces simultaneous
background torrent caches. Keep the existing `tsuri` and tracker settings.

The image entrypoint copies `/app/config/init.yaml` to `/app/init.yaml` on
startup. The application polls the latter every ten seconds. For a change
without a restart, update both copies while preserving all other settings,
then verify `data.tracksconcurrency` from `GET /api/v1.0/config` is `1`.
That endpoint contains secrets: never print or save the complete response.
Existing analyses finish using their old semaphore; new work uses the new
limit, so the transition can briefly overlap.

Solverr's `SESSION_MAX` bounds idle retained sessions per browser engine; it is
not a strict concurrent-request limit. `solverr-crawl` uses `SESSION_MAX=2`, a
five-minute idle TTL and a 15-second reaper interval; the interactive `solverr`
keeps 4, 15 minutes and 30 seconds. `solverr-crawl`'s healthcheck calls
`/health` with exec-form curl. Low idle retention is containment, not a fix for
active browser fanout or incomplete cleanup; it can also increase browser
creation when hosts alternate.

The private configuration sets `Kinozal.reqMinute: 1` in both configuration
copies. This spaces listing attempts by 60 seconds; it
does not impose a global browser semaphore or limit every detail request.
Do not interpret JacRed full-cycle progress as successful ingestion:
`ParseAllCycleStore.NoteAttempt` settles a page after three failures, and the
Kinozal caller counts that settled page as successful. Dependency outages
therefore require checkpoint review. Do not edit checkpoint JSON underneath
the running process or start a new cycle as an automatic recovery action.

JacRed behaviour on this page (defaults, config reload, `ParseAllCycleStore`,
endpoint responses, crawler limits) was checked against the pinned build: the
upstream commit and `crawl-recovery.patch` in `jacred/build/Dockerfile`. Recheck
it on upgrade.

Measure current cache use and playback demand before imposing a hard memory
limit; idle memory changes alone do not establish a leak. Keep dated production
measurements and the selected resource budgets in private operator records.

## Network

JacRed has no API key, and `GET /api/v1.0/config` returns tracker passwords
and cookies to anyone who reaches port 9117 directly (Traefik refuses it from
outside). JacRed therefore stays off the shared `proxy` network and lives on
`jacred` with only its clients: `lampa` (Lampac's parser), `solverr`,
`solverr-crawl`, `jacred-cron`, Traefik (the `/jacred` route) and
`gluetun-torrserver` (`tsuri`, for track analyses). The network is not
internal, so crawling keeps its Internet access. Create it once with
`docker network create jacred` before the first `docker compose up`.

## Background schedule

The scheduler uses `Europe/Sofia` from the root `TIMEZONE` setting. Times
below follow local daylight saving time; they are not fixed UTC times.

| Task | Sofia local time |
| --- | --- |
| Resume incomplete JacRed cycles | Monday–Saturday 00:10; Sunday 14:10 |
| Rutor full-cycle start | Monday 01:00 |
| NNMClub full-cycle start | Tuesday 01:00 |
| Megapeer full-cycle start | Wednesday 01:00 |
| TorrentBy full-cycle start | Thursday 01:00 |
| Toloka full-cycle start | Friday 01:00 |
| Anibelka full-cycle start | Saturday 01:00 |

Most incremental refreshes run every four to six hours; Kinozal's runs every
six hours. Rutracker/Kinozal/Ultradox full-cycle starts, Cloudflare warmups and
archive backfills are disabled: these trackers' archives are already in the
database and new torrents also arrive through `syncapi`, while a full cycle
would re-crawl the whole archive through Solverr for weeks.
JSON checkpoints save every five minutes; logs rotate every 15 minutes.
There are no tracker starts at 22:00–23:59 and no new Sunday full-cycle start.

SubsPlease `ParseShows` walks its show catalogue 200 shows per run (JacRed's
maximum, about 50 minutes) and runs daily at 02:25, so the whole catalogue of
about 1,250 shows is revisited every week. It reads the public JSON API with
pauses and needs no browser solver, so it is not a heavy job.

AniLiberty's refresh reads the latest API page every four
hours. Search returns only trackers listed in `synctrackers`, so a locally
crawled tracker must be listed there too (and not in `disable_trackers`) for
its torrents to appear. To backfill its whole catalogue once (about 63 pages,
eight minutes), request
`/cron/aniliberty/parse?parseFrom=1&parseTo=<total_pages>` through
`run-job.sh`.

The HTTP runner skips new crawler submissions daily at **04:00–04:59** and
on Sundays at **08:00–11:59** (`Europe/Sofia`, like the backup timers). They
reserve the daily configuration/application-backup hour and additional time
for the monthly guest backup. Incremental refreshes retry
at their next normal cron slot; skips do not change failure backoff. Saves,
log rotation and the report-only maintenance check keep running. The Sunday
resume runs at 14:10 so it does not start new work just before the weekly
backup chain.

This is a conservative schedule guard, **not active-backup detection**. Manual
or delayed backups outside these windows are not covered, and an existing
asynchronous crawl is not paused. No Docker socket, host credentials or SSH
access is granted to the scheduler. Review these windows when backup
timers change.

This is a start schedule, not a strict work window. `ParseAllTask` starts
asynchronous work; existing cycles can continue into the daytime or backup
window. The HTTP runner lock does not cover the lifetime of that work. Changing
the scheduler does not interrupt, restart, or erase existing crawl checkpoints.
JacRed also resumes pending work after application startup. Keep resource
limits in place and measure actual overlap instead of assuming all crawling
ends before the backup starts.

### HTTP job outcomes

`scheduler/run-job.sh` distinguishes protocol acknowledgements from crawler
completion. `SUCCESS` (exit 0) clears crawler submission backoff only for an
explicit positive response: `ok` / `scheduled`, Mazepa's `ok N`, Bitru's
`saved N` with N > 0, Knaben's nonzero `fetched` with `failed=0`, all-True
Rutor/Megapeer/Rutracker category reports, or Ultradox ParseLatest listing
reports. Asynchronous acknowledgements do not prove ingestion completed.

Transport errors, non-2xx HTTP, and explicit application errors (including
login or missing configuration) return exit 1.
Only crawler submission jobs accumulate backoff: 6, 12, then 24 hours, capped
at 24 hours. Saves, maintenance and resume jobs do not acquire backoff.

`UNKNOWN` (exit 2) leaves both the failure count and next-attempt timestamp
unchanged. This includes any False or mixed True/False report, empty/HTML or
unrecognized responses, Bitru `no items`, Knaben's all-zero counts or positive
item failure count (including partially successful crawls), category
reports without explicit results, and the structured ResumeParseAll report.
`work`, `work_login`, `disabled`, `syncapi`, and `idle` are `SKIP` (exit 0),
also preserving backoff. Unknown is neither a confirmed failure nor success;
the next normal cron slot can retry once existing backoff has expired.

Rutor's False conflates failed
fetches and unrecognized listings with potentially empty pages. Some endpoints
also swallow internal errors and return `ok`; the scheduler cannot recover
information absent from the HTTP response. Inspect application logs and crawl
checkpoints for those cases. The runner does not log raw response bodies for
unknown results.

Deploy from the root Compose project after validating its full configuration:

```sh
docker compose config --quiet
docker compose build jacred-cron
docker compose up -d --no-deps jacred-cron
make check-runtime
```

Do not restart JacRed or its browser dependencies for a schedule-only change.
Verify the installed `/etc/crontabs/root`, container health, and root-project
ownership afterward.

## LostFilm

LostFilm needs the browser session cookie of a LostFilm account. Run
`jacred/set-lostfilm-cookie.sh` from a workstation: it reads the cookie without
echo, sends it over SSH stdin into the private `init.yaml`, moves `lostfilm`
from `disable_trackers` to `synctrackers`, and hot-reloads JacRed. Run it again
to renew an expired cookie: it then replaces only the `cookie:` line. Without a
valid cookie every episode logs `expand failed (no magnets)`. The refresh
reads LostFilm's new-episodes page every four hours. JacRed has no LostFilm
login by password, upstream included, so the cookie cannot renew itself.

`lostfilm-auth-check.sh` runs 28 minutes after each refresh. When at least
half of the run's items failed to resolve to magnets, it sends one Telegram
message (the disk-watchdog bot and chat) and another once LostFilm recovers.
Its state is `data/log/.scheduler-backoff/lostfilm-auth`.
