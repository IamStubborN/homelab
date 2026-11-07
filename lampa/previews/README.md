# Chapters and seek previews

Implemented as a homelab side service and `plugins/seek-previews.js`. No upstream
file edits or submissions are involved. Lampac's updater already fingerprints
and snapshots the mounted homelab plugins and bootstrap; the new worker has its
own image and can be stopped without stopping playback. It does not depend on
the separate history extension.

## Current behavior

- Built-in Lampa playback of known TorrServer video files. Uses the original
  hash and file index retained by `torrserver-audio.js`, including GST playback.
  External Android players, arbitrary HTTP providers and Plex files are outside
  this version's input contract.
- A player button opens embedded chapter names and seeks to the selected start.
  No chapter is automatically skipped. Missing chapters are reported explicitly.
- Temporary metadata failures recover with at most four automatic attempts,
  delayed by 5, 15 and 60 seconds between failures. Each attempt is limited to
  55 seconds, including polling while queued. Opening a failed chapter menu
  permits another attempt at most once per five seconds. Closing playback or
  changing files cancels retries; late responses are ignored. An open owned
  chapter menu refreshes when metadata arrives, without replacing other menus.
- Mouse hover, TV rewind and mobile native scrub gestures request a 320×180 JPEG
  on a ten-second grid after 450 ms without a change of grid cell. Chapters are
  shown with the target time. Sixteen object URLs per playing file are kept in a
  client LRU: revisiting one is immediate. An unprepared frame shows the nearest
  cached frame within 30 seconds, dimmed, or only the time. The overlay hides when
  the panel hides, 2.5 s after the last TV/button rewind and 1.5 s after a touch
  release (the pending request survives a quick release). The plugin uses one
  frame `client` id for its lifetime, with an increasing `n`, so the worker keeps
  only its latest seek across files; closing or changing a file (after a frame
  request) and disabling frames send a cancel. Closing the file releases all URLs.
- The player reports playback state every 15 seconds, with one request in flight,
  a five-second timeout, at least three seconds between reports (the last phase
  wins) and an increasing `seq`. A 422 (unsupported release) stops its reports.
  Tizen AVPlay/Orsay `<object>` wrappers, whose native `removeEventListener`
  cannot remove Lampa's listeners, are supported: the handlers become inert on close. Background preparation starts after ten stable
  seconds. The current series file is first, then naturally sorted following
  files, then previous files. Only supported video files of the existing torrent
  are included; no torrent is added. A new current file takes priority.
- Each series uses one sequential GPU pass: select the ten-second samples,
  shrink with `scale_vaapi`, and only then download the small images to RAM.
  Atomic JPEG publication makes frames available progressively. Unsupported GPU
  decode falls back to bounded software extraction. This is not scene/intro/ED
  detection or HDR tone mapping.
- A foreground frame or metadata request interrupts the background process.
  Actual video waiting and GST recovery pause it too; a network `stalled` event
  alone does not mean playback has stopped. Cancelled ffprobe/ffmpeg processes
  are terminated, and preparation resumes at the first missing ten-second image.
  The small persisted queue resumes after worker restart. Closing playback leaves
  the accepted release queued; lost client leases expire after 45 seconds.

Resource limits: one ffmpeg/ffprobe process at a time, one thread, one CPU and
768 MiB RAM. Foreground retains two waiting jobs and a 25-second subprocess
limit. A request with `client` supersedes that client's previous job: a queued
one is dropped and a running one is interrupted. A request whose `n` is not
newer than that client's last one is ignored. Requests without `client`
(legacy clients) are never superseded, and a job shared with them keeps running.
One device may use several client ids (for example seek and gallery); at most
256 are tracked, beyond which requests get 503. Background has at most four releases, 500 videos per release, 32 client
leases, and 15-minute resumable process slices. Its lower-priority process reads
at most eight media seconds per wall second (`BATCH_READ_RATE`, clamped to
0.25–16), or two in software mode. This bounds decoding pace, not absolute
network bytes or GPU utilisation. A cold release can still fetch most of every
video and compete with playback. The eightfold default reserves more headroom
than the unrestricted benchmark; it is deliberately slower.

The disk cache is capped at 2 GiB and 72 hours since access; each file is capped
at 128 MiB. Cleanup runs at startup, every idle minute, and between background
jobs. It evicts whole least-recently-used file folders, protects current work
and live player leases, and atomically reserves an eviction before deleting.
A current file may temporarily exceed the total cap until older folders are
removed. Cache keys include immutable torrent identity and extraction version.
New playback rebuilds missing work after eviction. Failed background files
retry after 30/120/600 seconds, then wait for a new session or queue expiry.
Disabling frames stops new frontend requests; an already accepted batch remains
queued with the same limits.

## HTTP contract

All endpoints are served on the existing Lampa origin behind Traefik:

- `GET /previews/health`
- `GET /previews/{40-hex-infohash}/{one-based-file-index}/metadata?step=10`
- `GET /previews/{40-hex-infohash}/{one-based-file-index}/frame/{slot}.jpg?step=10[&client=ID[&n=N]]`
- `POST /previews/cancel` with JSON `{"client": ID, "n": N}` (`n` optional):
  releases that client's job; returns 202, or 400 for an invalid body
- `POST /previews/{40-hex-infohash}/{one-based-file-index}/prepare`
- `GET /previews/{40-hex-infohash}/{one-based-file-index}/status`

`slot = floor(seconds / step)`. A request returns 202 with Retry-After while queued,
200 when ready, 503 with Retry-After when busy or the source is temporarily
unavailable (TorrServer errors, timeouts, missing statistics; such failures back
off for 10 seconds), or 422 with Retry-After when decoding failed or the file is
unsupported (do not poll before Retry-After; 60 seconds). Backoff is counted
from the job's completion. A superseded job
returns no status of its own: its key is forgotten, so a later request gets 202
(new job), 200 or 503. An invalid `client` returns 400. Metadata version 1 supplies
`duration`, `step:10` and `chapters:[{start,end,title}]` in seconds. The frontend
ignores late responses from previous playback and cancels polling on close.

Preparation accepts at most 2 KiB of JSON, with `client` (8–64 alphanumeric,
underscore/hyphen characters) and `state` (`playing`, `buffering`, `paused`, or
`closed`) and an optional integer `seq`, returning 202 on acceptance. A report
whose `seq` is not newer than the lease's last one, or than its `closed`
report, is ignored, so a late request cannot resurrect a closed lease. A release
without supported videos returns 422 and is remembered for ten minutes, so
heartbeats stop querying TorrServer; missing torrent statistics stay a 503. Client IDs are ephemeral playback leases,
not credentials. Release membership and video count are validated by the worker.
Status is read-only and reports queued file count, current-file active state and
completion. Bare metadata/frame URLs retain their five-second meaning for older
clients; steps 5 and 10 have separate cache and foreground job keys. New clients
negotiate the reported step and also work with an older five-second server.
Background batches always use ten seconds. The native Lampa rewind setting is
independent and remains unchanged.

No source URL or filesystem path is accepted. The service looks up an existing
TorrServer file (`action:get`, never adds a torrent), validates a video suffix,
then builds its own stream URL from the fixed backend. ffmpeg's protocol and
format whitelists exclude playlists/concat. This inherits the existing private
Lampa/TorrServer network access boundary; a known hash is not an authentication
credential. Do not publish this route on an unauthenticated public origin.
Gateway access logs are disabled for these private media identifiers.

## Why this extraction path

The existing `media_preview_generator` in the homelab uses the same GPU scaling
before download, plus an optional keyframe-only fast path. Its Plex database and
bundle integration is not required by this worker and is not imported.

[Plex](https://support.plex.tv/articles/202197528-video-preview-thumbnails/)
prepares preview indexes in advance. Its
[hidden settings](https://support.plex.tv/articles/201105343-advanced-hidden-server-settings/)
include keyframe-only extraction. Jellyfin similarly supports optional keyframe
extraction with fallback, and [JPEG tiles](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Server.Implementations/Trickplay/TrickplayManager.cs).
Keyframe-only extraction is approximate and needs gap/duplicate checks; it must
not be combined blindly with this worker's regular time-grid selection. Full GPU
selection remains the default. JPEG sheets/BIF can reduce HTTP requests, but do
not speed up reading/decoding the video. Neither is needed for the current
small JPEG output or sixteen-frame client cache.

An isolated 1080p H.264 SDR, 25:29 episode benchmark produced 306 JPEGs in 95.5
seconds including probing, 1.77 MiB total, 151 MiB peak container RAM and 42% of
one CPU on average. CPU scaling alone gave no clear gain; GPU filtering made
the compared 90-second segment about five times faster. This unrestricted
benchmark read about the whole file over HTTP from a previously used source;
it is not a cold-torrent internet-download or concurrent-TV benchmark. Current
code/review/installation status is recorded separately below.

## Deployment (requires separate approval)

1. Save the live Compose, bootstrap and plugin files for rollback. Create
   `lampa/preview-cache` owned by UID/GID 1000; keep it ignored.
2. For Intel decoding, put `LAMPA_PREVIEW_VAAPI_DEVICE=/dev/dri/renderD128` and
   `LAMPA_PREVIEW_RENDER_GID` equal to the host render node's numeric group in the
   ignored deployment environment. With no device variable, software decoding
   is used. VAAPI codec support must be tested before enabling it for users.
3. Build `docker compose build lampa-previews`; validate the composed model with
   `docker compose config --quiet`, without printing resolved private values.
4. Start only `lampa-previews`, install the plugin and bootstrap together using
   the existing guarded Lampa configuration rollout. A browser/PWA reload is
   required to register the added plugin. Do not overwrite unrelated pending
   history-extension changes.
5. Check health and playback on a real TV and iPhone PWA, including seeking to a
   cold frame while playback continues. Stop the worker / revert the plugin
   registration if playback suffers. Rollback needs no database migration.

The worker image is not automatically updated by Lampac's upstream updater.
Lampa API guards stop installation if required public player entrypoints disappear;
semantic changes still need regression testing against the new client.

## Verification

```sh
python3 -m unittest discover -s lampa/previews -v
node --test lampa/tests/
docker build -t homelab/lampa-previews:test lampa/previews
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --cpus 1 --memory 768m --pids-limit 64 \
  --tmpfs /tmp:rw,size=64m -v "$PWD/lampa/previews:/src:ro" -w /src \
  homelab/lampa-previews:test python -B -m unittest -v test_app
```

The Python test synthesizes a 12-second MKV with two chapters, serves it through
a local range-capable fake TorrServer, and runs real ffprobe/ffmpeg through the
worker HTTP API. It checks cache reuse without a second source read, invalid
identities, out-of-range seeks and queue bounds. This is functional validation,
not a representative 1080p/4K performance benchmark or real-device validation.

Validation for this change: 108 JavaScript tests and both Python tests pass.
The real extraction test passes in the actual worker image in an isolated
container on the home Intel render device, with one CPU, 768 MiB RAM and a
16 MiB temporary filesystem. It was also tested locally in software mode.
Browser checks against Lampa revision `4294a571aad8883116e57d975ad05519f84be13e`
cover desktop hover, chapter selection by keyboard, a narrow chapter menu and
the native mobile touch gesture with an emulated iPhone user agent. In that
gesture Lampa displayed 13 seconds and our grid correctly displayed 10 seconds.
Physical iPhone PWA/TV playback and representative torrent contention remain
deployment-stage checks.

Follow-up metadata recovery and complete subscription-method guards are
implemented, tested and deployed on 2026-11-01 after explicit approval.
The plugin was replaced atomically with its prior version backed up; no
containers were restarted. HTTPS source integrity and service health checks
passed. Regressions cover
temporary 503 recovery, retry limits, manual retry throttling, timeouts and late
responses, cancellation, menu ownership and refusal to install partial hooks.
Independent re-review passed. A browser check against the current Lampa client
injected a first metadata 503 and verified recovery on the second request:
the already open menu changed from an error to both chapter entries without
reloading the app or reopening the menu.

Installed on 2026-11-01 after independent source and rollout reviews. The
rollout backed up changed files and the private deployment environment, tested
the built image with VAAPI, then waited for five idle traffic samples before
restarting Lampa to refresh its bootstrap cache. The existing Lampac image and
container identity were preserved. Both services are healthy; HTTPS health,
plugin source integrity, bootstrap registration, render/cache permissions and
TorrServer connectivity passed. `docker compose config --quiet` and
`make check-runtime` passed; the nightly Lampac timer was restored. Backups and
the deployment journal remain outside the repository in private operator state.
Clients need one reload to register the added plugin and must use Lampa's own
embedded player for its controls.


## Additional player UX (deployed 2026-11-01)

`chapter-gallery.js` consumes the guarded version-2 interface of
`seek-previews.js`. Its responsive owned modal shows embedded chapters, current
chapter and on-demand frames. A chapter frame is sampled on the five-second grid
inside that chapter. Short chapters without a grid point show a placeholder.
One client request runs at a time, with at most three queued chapters, a 55-second
request deadline and twelve retained object URLs. Closing the gallery or changing
file/profile cancels requests and releases images. Server worker limits remain
unchanged; this is not a full-file scene detector or background scan.

Only explicit OP/ED, opening/ending, intro/credits labels offer a manual skip
button. There is no automatic skipping or inferred boundary detection. The user
can edit the skip type/start/end, explicitly save or reset them; those edits do
not alter the original chapter’s navigation or preview. Edits are local to the
client/profile, bounded to thirty files, and do not synchronise between devices.

`playback-status.js` adds preparation, buffering, recovery and failure states
from native video events and the existing audio bridge. It offers manual retry
through that bridge, preserving position and playback preferences even across a
failed retry. It introduces no extra automatic retry loop. Raw source URLs and
exceptions are not displayed. These controls target Lampa’s embedded player;
external players keep their own interface.

The combined regression suite has 134 passing JavaScript tests. The new scoped
Continue Watching API additionally passed authenticated user/profile isolation,
stale-write, validation, bounded-body and retention tests in the actual Lampac
image. See [HomelabSync](../mods/HomelabSync/README.md) for cross-device behaviour.
Physical TV/iPhone PWA playback and representative live-torrent contention remain
rollout checks after separate approval.

Browser integration of the four additions passed against frontend revision
`4294a571aad8883116e57d975ad05519f84be13e` using synthetic video and the real
isolated resume API: separate browser origins shared updated episode/position
and preserved track identity; switching profiles cleared/restored the owned row;
chapter frames, manual intro skip and buffering/error/retry UI were checked.
The mobile check used an emulated iPhone user agent and 390×844 viewport, not a
physical device. Fault UI was checked through controlled event injection;
manual GST retry restoration is covered by regressions rather than a live torrent
failure experiment. Browser validation caught and removed reliance on a private
Navigator symbol; its regression now runs with public focus APIs only.


The four UX additions were installed on 2026-11-01 after separate approval and
independent source and rollout reviews. Only Lampa was recreated to add the
HomelabSync read-only bind; the existing Lampac image and preview worker were
preserved. Source integrity over HTTPS, native module/API/bootstrap checks,
service health and the updated runtime guard passed. Backups and rollout logs
are private. See the HomelabSync installation note above for client reload and
device validation limits.


## Startup and seek UI correction (2026-11-01)

The follow-up waits for native `appready` before installing history/continuation
and the account-sync plugin. Method-presence checks alone cannot establish that
Menu and Favorite internal state is ready; fast cached startup reproduced a
failure that a slow cold load had masked.

The seek thumbnail follows the requested point on the actual timeline, clamps at
the viewport edges, and hides on leaving the rail. Temporary frame429/5xx/network
failures retry with bounded backoff inside the existing55-second deadline;
hovering within the same five-second interval no longer locks out a failed frame.
Worker CPU/memory/queue limits are unchanged. An actual media probe returned a
JPEG in2.3seconds; the historical cause of the reported individual frame failure
could not be reconstructed from the intentionally minimal worker logs.

Chapters are in the left control group. Manual intro/credits skip is a separate
action above the panel, with a remote-Up route that preserves the native Skip
priority. It reattaches after player cleanup and clears focus when leaving its
controller. Touch targets are at least44pixels. Regression suite:142JS tests.
Local browser checks cover early startup, a transient503 followed by a real frame,
edge clamping, keyboard navigation, repeated playback and390px mobile layout.

## GPU release batches: implemented and tested, not deployed

The 2026-11-01 follow-up above changes preparation to a ten-second grid while
retaining old five-second GET semantics. Its separate candidate image passed
13 Python tests on the actual Intel render device, including full extraction,
checkpoint resume, priority/cancellation, idle cleanup, two-player heartbeats,
queue restore and old/new HTTP contracts. The JavaScript suite passes 153 tests.
Independent backend, player and continuation reviews passed before UI validation.

The final rate-limited candidate generated all 153 JPEGs of the same 25:29
1080p H.264 episode in 192.2 seconds. Output was 0.87 MiB, peak container RAM
125 MiB and average container CPU 12.4% of one core. The source had already been
accessed; this does not establish cold download speed or concurrent physical TV
playback. The eightfold pace, not JPEG encoding, dominates this time.

A browser fixture against native Lampa frontend `1992839` verified preparation
of all three release files, ten-second negotiation, native next-episode playback,
the full restored playlist, and uniform continuation cards on desktop and an
emulated 390-pixel iPhone. It also verified quiet plugin-success notifications
while retaining errors. No physical iPhone/TV test of this candidate or production
installation has happened. Existing deployed functionality described in the
historical sections is unchanged until a separately approved rollout.

Installation must save the old worker image and changed sources, install the
matching plugins/bootstrap, and promote only the tested candidate through root
Compose. The worker and JavaScript should be rolled back together; clients need
a reload to load changed code, including after rollback. Preserve the existing
cache bind and ownership. There is no database migration. Private rollout
artifacts, queue/cache contents and source identities stay outside Git.
