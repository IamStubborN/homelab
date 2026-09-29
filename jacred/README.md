# JacRed resource budget

This host shares four CPU cores with OPNsense and interactive media services.
JacRed is limited to 0.6 CPU and the dedicated `solverr-crawl` pool to 0.5 CPU.
Both use `cpu_shares: 256` to yield under contention. The interactive Solverr
pool retains its existing budget. These are CPU budgets, not request limits.

The private `jacred/config/init.yaml` should contain:

```yaml
tracks: true
tracksconcurrency: 1
```

`tracksconcurrency` limits background TorrServer metadata analyses, not user
playback. Version 3.15.1 defaults to two analyses; one reduces simultaneous
background torrent caches. Keep the existing `tsuri` and tracker settings.

The image entrypoint copies `/app/config/init.yaml` to `/app/init.yaml` on
startup. The application polls the latter every ten seconds. For a change
without a restart, update both copies while preserving all other settings,
then verify `data.tracksconcurrency` from `GET /api/v1.0/config` is `1`.
That endpoint contains secrets: never print or save the complete response.
Existing analyses finish using their old semaphore; new work uses the new
limit, so the transition can briefly overlap.

Solverr's `SESSION_MAX` bounds idle retained sessions per browser engine; it is
not a strict concurrent-request limit. Following the September 25 process
exhaustion incident, only `solverr-crawl` uses `SESSION_MAX=2`, a five-minute
idle TTL, and a 15-second reaper interval. Its healthcheck calls `/health`
directly with exec-form curl. CPU, memory and PID budgets are unchanged.
The interactive pool retains its previous settings. Lower idle retention is
containment, not a proven fix for active browser fanout or incomplete cleanup;
it can also increase browser creation when hosts alternate.

The private configuration now sets `Kinozal.reqMinute: 1`, hot-reloaded in
both configuration copies. This spaces listing attempts by 60 seconds; it
does not impose a global browser semaphore or limit every detail request.
Do not interpret JacRed 3.15.1 full-cycle progress as successful ingestion:
`ParseAllCycleStore.NoteAttempt` settles a page after three failures, and the
Kinozal caller counts that settled page as successful. Dependency outages
therefore require checkpoint review. Do not edit checkpoint JSON underneath
the running process or start a new cycle as an automatic recovery action.

TorrServer's 2 GiB RAM cache and disconnect timeout are retained. On
2026-09-25 its memory fell from 4.16 GiB to about 0.7 GiB without a restart
when torrents became inactive. This observation does not establish a leak
and does not justify a hard memory limit below playback demand.

## Background schedule

The scheduler and both Speedtest Tracker applications use `Europe/Sofia` from
the root `TIMEZONE` setting. Times below follow local daylight saving time;
they are not fixed UTC times. The application checks Speedtest cron against
`app.display_timezone`, even though the container OS clock displays UTC.

| Task | Sofia local time |
| --- | --- |
| Direct speed test | Daily 23:00 |
| VPN speed test | Daily 23:30 |
| Resume incomplete JacRed cycles | Daily 00:10 |
| Rutor full-cycle start | Monday 01:00 |
| NNMClub full-cycle start | Tuesday 01:00 |
| Megapeer full-cycle start | Wednesday 01:00 |
| TorrentBy full-cycle start | Thursday 01:00 |
| Toloka full-cycle start | Friday 01:00 |
| Anibelka full-cycle start | Saturday 01:00 |

Most incremental refreshes run every four to six hours. Previously disabled
jobs remain disabled, including Rutracker/Kinozal/Ultradox full-cycle starts,
Kinozal incremental refresh, Cloudflare warmups, and archive backfills.
JSON checkpoints still save every five minutes; logs rotate every 15 minutes.
There are no tracker starts at 22:00–23:59 and no new Sunday full-cycle start.
The 30-minute gap separates scheduled speed tests, not manual API runs.

This is a start schedule, not a strict work window. `ParseAllTask` starts
asynchronous work; existing cycles can continue into the daytime or backup
window. The HTTP runner lock does not cover the lifetime of that work. Changing
the scheduler does not interrupt, restart, or erase existing crawl checkpoints.
JacRed 3.15.1 also resumes pending work after application startup. Keep resource
limits in place and measure actual overlap instead of assuming all crawling
ends before the backup starts.

Deploy from the root Compose project after validating its full configuration:

```sh
docker compose config --quiet
docker compose build jacred-cron
docker compose up -d --no-deps jacred-cron speedtest-tracker speedtest-tracker-vpn
make check-runtime
```

Do not restart JacRed or its browser dependencies for a schedule-only change.
Before deployment retain the previous scheduler image and both source files
for rollback. Verify the installed `/etc/crontabs/root`, cached Speedtest
schedules/timezones, container health, and root-project ownership afterward.
