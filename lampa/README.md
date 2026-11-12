# Lampa

The locally prepared UX additions include playback status/retry and
`plugins/chapters.js`: embedded chapters of a torrent file (timeline ticks, the
current chapter next to the time, a chapter list) plus ±N s step buttons outside
TVs. Chapters come from the `lampa-media` header probe below, so they cost no
extra torrent read. Cross-device continuation and household history live
in the separate [HomelabSync module](mods/HomelabSync/README.md). These additions
were installed on 2026-11-01 after explicit approval; a source checkout alone
does not install them. Clients need one reload to load the new plugins.

## Sources and build

Large plugins live as ordered parts in `src/` and helpers shared by several plugins in
`src/shared/` (pulled in by a `// @include shared/<file>` line). `node tools/build.cjs`
concatenates them into the served files (`plugins/*.js`, `mods/HomelabSync/*.js`), which stay
committed, so deployment copies files as before. A built file starts with a «Built by» line: edit
its sources, rebuild, and `node --test tests/` fails while a built file is stale.

The independent `common-sources.js` picker offers online voices and native torrent
results together. By default it shows one card per online voice: Enter plays the
best source of that voice (playable first, highest quality, a measured height over
a declared one), the card names how many other sources stand behind it, and Right
or a long press lists every source (every release for a torrent card). Torrents
fold into one «Торренты» row below the online voices, and native fallbacks share
one «Открыть в источниках» row. The view chip switches to a flat
list of every source; recovery pickers start flat. The top card is highlighted as
the recommendation and, until the first key press, keeps the focus so one OK plays
it. Quality is a single badge (4K, 1080p, ...) marked as measured or declared; rows
whose source hands out no video are dimmed and sorted last. Torrent cards carry
seeds, size and codec badges; Right/long press shows the full release title. A
status line with a spinner and bar reports how many online providers have answered
and whether torrents are still searched; an empty result explains what to change.
The quality tab is stored per HomelabSync profile on this device and reused
across providers. Results rank concrete online variants first, followed by seeded torrents and native provider fallbacks. Once a result receives
focus, late results append without moving it or recentering the scroll. Online
voices whose quality is only known at playback stay visible under every quality
tab, marked as to be clarified. Leaving mid-search marks the list as interrupted;
Refresh restarts it. Recovery pickers skip the torrent search. Devices without
`AbortController` get a button that explains the picker is unavailable.

Rows without a quality are probed once the live discovery and every catalog page
are done, two at a time, own-Lampac requests paced like catalog pages. Only the
leading source of each card on screen is probed (at most 12 per search); the other
sources of a voice are probed when its source list is opened (at most 24 probes in
total). Measured qualities and own 404/410 answers are cached per page session for
30 minutes (at most 200 URLs). Only JSON, HLS, HTML or small plain text bodies under
256 KB are read, so media is never downloaded; without a native `AbortController`
nothing is probed. A row is marked as having no video only on an own-Lampac
(`/lite/`, `/proxy/`) 404/410 or an explicit "not found" error; 401/403, `accsdb`,
quota or other errors, rch/ws handshakes, timeouts and foreign CDN refusals change
nothing.

`playback-status.js` shows a small state card below the native loader in the
embedded player. Preparation, buffering and GST recovery show one line with an
elapsed timer ("Подготовка видео… 8 с"): a start after 2.5 s, which Lampa's own
loader covers until then, and mid-play buffering after 700 ms, so short blips
never flash; the card hides while a Lampa menu is open; GST recovery shows only while the picture is actually stuck. For
torrents the card adds peers, download speed and read-ahead from Lampa's own
TorrServer `/cache` request ("Торрент: 12 пиров · 3,4 МБ/с · буфер 40%"),
polled at most every 2 seconds and only while the card is visible. The card
hides as soon as playback progresses, also without a `playing` event.

Retry and Other source appear on the card and in the player panel only after a
fatal error or 30 seconds of stalled loading, including a start that never
receives data and a seek that never completes; a user pause is not a stall.
After 20 seconds of preparation the card also suggests Other source. Retry is
shown only when the current source can be retried and GST is not already
recovering on its own, and Lampa's own switch to a reserve URL is not a failure.
The card takes the remote only from the bare player, never from the panel (the
user may be seeking away from a broken spot) or a menu, and once per state:
Retry is focused first, Other source after a retry that did not help. Left/Right
move between the actions and hand off to the panel at the edges, Down opens the
panel. Back on an automatically focused card hides it and still acts as the
player's Back; after the user moved focus, Back only hides it. The panel keeps
the actions. Phase changes never produce notifications or raw error text,
and recovery never switches automatically. Online retry resolves a fresh
URL from the same provider. Other source opens concrete online variants for the
same episode and known voice. Exact voice labels rank first; whole-label aliases
for a small set of known studios appear as clearly marked similar voices. They
require explicit selection and do not promise equivalent cuts. Unknown or mixed
studio labels are never guessed. When no exact match exists, a direct Other voices
button shows the number of concrete alternatives without discarding the episode
or saved position. The existing voice menu remains available as well. Native protected
provider fallbacks cannot guarantee that identity and are excluded from recovery.
The old player is fully closed before resolution, including owned GST cleanup.
Recovery transfers absolute seconds once; substantially different durations warn,
and a version shorter than that position starts at zero. This does not align
edits/cuts or add recovery controls to external Android players.

This module hosts the Lampa web client and Lampac NextGen online backend. The
TorrServer module inside Lampac is deliberately disabled: torrent streaming
uses the existing `torrserver` service from `download/compose.yml`.

## Playback paths

- Torrent search uses JacRed at the same-origin `/jacred` endpoint. The
  bootstrap clears obsolete Prowlarr settings and uses an empty JacRed key;
  it does not inject a Prowlarr API key.
- Browser and embedded-player playback uses Lampac's own GStreamer module
  (`localGST`). It reads the source from the external TorrServer at
  `http://gluetun-torrserver:8090/stream/` and creates a separate numeric GST
  session for each viewer. AVI is decoded and encoded to H.264; supported
  MKV/WebM video codecs remain in copy mode unless explicitly configured otherwise.
- External Android players receive the direct TorrServer stream. The external
  TorrServer also has its own GStreamer backend (`externalTorrServer`); its GPU
  configuration is independent of Lampac's. Enabling that backend does not give
  Lampac access to the GPU.

The Traefik file-provider `lampa-gst-sessions` route sends Lampac's session
creation, numeric session, probe, heartbeat, removal, and plugin paths to
`lampa@docker` with priority 120. Legacy TorrServer hash-based `/gst/` paths
retain the priority-101 route to TorrServer. Do not redirect every `/gst/` path
to a single backend.

## External audio tracks

Some torrents keep voice-overs in separate files, for example
`Sound/<episode>.mka`. GStreamer reads one file, so the `lampa-media`
sidecar (URL prefix `/homelab-media/`) adds those files to browser playback without modifying Lampac:

- `/homelab-media/<hash>/<video file id>/tracks` lists the video's audio files,
  folder by folder, from the first rule that matches:
  1. named after the video: `<stem>.mka` in any folder, `<stem>.<label>.ac3`
     or `<stem> [Dub].mka`;
  2. in a folder with one file per episode, the file with the video's episode
     number, taken from the number that tells the folder's files apart
     (`[AniLibria] Show - 03.mka`, `Show.S01E03.ac3`); release tags such as
     `1080p`, `x264` or a year are ignored, and extras like `NCOP1` do not
     count as episodes;
  3. in an unnumbered folder with as many files as episodes, the file in the
     video's position.

  A film (the only video in the torrent, samples aside) takes every audio
  file; a lone video among others (an OVA, a folder per episode) only the
  audio beside it. `Shrek 2.mka` is not a labelled track of `Shrek`. Rules 2
  and 3 skip folders of another season (`Season 2/`, `S02`, `2 сезон`); for
  season 2 and later, a folder without a season keeps only files that name
  it, since such folders usually number episodes across seasons. They also
  skip `OST`, `Music`, `Bonus`, `Extras`, `Specials`, `CD1` and `Scans`
  folders unless the video itself is in one. Lookups query only the torrent
  being played and probe at most six candidates, named files first.
- `/homelab-media/<hash>/<file id>/<stream>/aac/audio.m3u8?at=<seconds>`
  serves the selected track from the playback position on demand, the way
  Jellyfin does. AAC-LC mono or stereo (most voice-overs) is copied as it is:
  ffmpeg copies it from just before the position with its absolute timestamps,
  and the sidecar cuts segments of about 6 s on the track's own frame grid
  (281 frames at 48 kHz, 258 at 44.1 kHz), so segments from different start
  positions are byte-identical. The encoder's priming frame before zero is left
  out. Anything else is encoded to AAC: stereo at 256 kbit/s, 5.1 at
  384 kbit/s. The voice-over starts a second or a few after it is chosen;
  copying the whole file first took 15–30 s per episode. The playlist covers
  the whole duration at once; ffmpeg starts at the playback position and
  restarts at a seek. Encoded segments are 281 AAC frames on the same fixed
  grid, and the sidecar writes each segment's absolute time, so segments from
  different runs line up. An encoding run starts one segment early and drops
  it, because an AAC encoder's first frame is priming. ffmpeg pauses once it is `LIVE_AHEAD_SEGMENTS` (about five
  minutes) ahead of playback and resumes in batches, so the torrent is read
  only as far as someone watches. Multichannel audio becomes standard 5.1:
  Chrome rejects the `5.1(side)` layout that AC-3 and DTS decode to.
  Each track keeps up to two runs, so two viewers at different positions do
  not restart each other; a third position replaces the least recently used
  run, and at most two runs encode at once across all tracks.
- ffmpeg accepts only audio container formats (`INPUT_FORMATS` in `app.py`), so a
  file disguised as a playlist cannot make it fetch other URLs. Track lookups
  run at most two at a time, and a probe that fails (other than a timeout) is
  not retried for 10 minutes.
- Results live in the ignored `media-cache/` directory, which is limited to
  2 GiB and 72 hours (`CACHE_MAX_MB`, `CACHE_TTL_HOURS`). Delete it at any time.
- The plugin lists external tracks in the regular audio menu. When an external
  track is chosen, the video keeps using the same GST task. hls.js receives an
  `EXT-X-MEDIA` audio rendition, and the plugin removes the embedded audio track
  from GST init and media segments so the main buffer is video-only. The plugin
  switches the hidden embedded track to AAC when one exists, to avoid
  transcoding. The choice is remembered per torrent, like embedded tracks.

hls.js 1.4.7 stalls when one audio group mixes a muxed rendition with an
external one. The master playlist therefore carries only the external
rendition, and switching back to an embedded track reloads the player. The plugin also
rewrites the variant's `CODECS` to the external codec, because hls.js creates the
audio SourceBuffer from it. If a GST fragment layout cannot be stripped, or the
external rendition fails for good (sidecar error, missing segment), the plugin
falls back to the embedded track; choosing the external track again prepares it
anew. External audio fragments retry a busy or restarting sidecar for up to a
minute first. A remembered voice is applied automatically only in the first 45
seconds after the first frame (90 seconds while an external rendition is being prepared); one found
later is announced and left in the menu instead of reloading the video.

### Track menus

The plugin draws Lampa's audio and subtitle menu items itself (Select's
`onDraw`); each track's `label` stays its source name, which preferences, logs
and other plugins match by.

- Audio: a title from the voice-over's tag or folder, cleaned of extensions,
  release tags, language words and dots/underscores (`Rus_MVO_LostFilm.mka`
  reads `Многоголосая — LostFilm`), then a small line: language, `5.1`/`стерео`,
  codec and `внешняя`/`встроенная`. The voice remembered for the torrent comes
  first and is marked `★ для сериала`, then Russian, untagged, Ukrainian,
  English and the rest, otherwise in file order. An external voice being
  prepared shows `готовится… N с` on its item, and a failed one says so until
  it is chosen again.
- Subtitles: `Выкл.` first, then the group or language with `полные`,
  `надписи` (signs, forced, songs) or `полные, для слабослышащих` (SDH), the
  language, `ASS со стилями` for tracks drawn with their own styles, and
  `внешние`/`встроенные`.
- Notices: one when the remembered voice is applied (`Озвучка: LostFilm — как
  в прошлой серии`), and one per voice when its external rendition fails and
  the embedded audio takes over.

## Intro skip

`intro-skip.js` gives series and anime episodes Lampa's own «Пропустить» /
«Следующая серия» button. Timestamps come from community databases:
TheIntroDB by TMDB id and SkipDB by IMDb id (Lampac `/externalids`, once per
show) are asked together, the first in that order with timestamps wins; anime
with neither falls back to AniSkip through ani.zip's MAL mapping, only where the
MAL episode number, season and episode agree. IntroDB is not used: its API
allows only its own site (CORS). Lampa reads segments only when an episode
starts, so a fresh start in the built-in player with nothing cached is held for
at most 1.5 s (Back cancels it); torrents, an episode switch inside the player
and external players are never held and only fill the cache, and the next
episode is looked up 20 s into the current one. Only the TMDB/IMDb/MAL id,
season and episode leave the device. Answers are kept 12 h, misses 6 h.
Lampa's player setting «Интро и другое» decides between skipping
automatically and showing the button.

## Torrent voices from audio tracks

When a seeded torrent card (3 or more seeds) in «Общий» names no voice in its
title or parser data, dwelling on it for 1.2 s asks
`GET /homelab-media/voices?link=<magnet>&title=…`. The sidecar accepts only
`magnet:` links and the plugin's `X-Homelab-Voices: 1` header (a foreign page
cannot send it without a CORS preflight), hands TorrServer a magnet rebuilt from
the hash and its http/udp trackers only (no web seeds or exact sources), adds
the release without saving it to its database, waits up to 30 s for the file list, probes the largest video's audio
tags and takes the folder names of its external audio files. The card then shows
those voices and the track languages. One release at a time (429 otherwise);
503 while TorrServer still looks for peers, asked again on a later focus;
answers are kept a day, failures 10 minutes. The release appears in TorrServer's
list until TorrServer drops it as inactive.

## Provider statistics

`provider-stats.py collect` adds the `/lite/<provider>` requests of Traefik's
access log (`docker logs --timestamps`, Docker's write time is the cursor) to
daily per-provider counters (requests, errors, empty answers, answers slower
than 8 s); `report --days 7` names providers to disable in `init.conf`. Only
provider names and numbers are stored, under the ignored `cache/`. Run it hourly
(`provider-stats.service` / `.timer`, or a user crontab line where systemd
units cannot be installed).

## Next episode warm-up

On a slow torrent the next episode waits for its head before GST and the
track probes can start. Once an episode has played 10 s within its last
7 minutes and its second half (paused, seeking or scrubbing does not count),
the plugin sends `POST /homelab-media/<hash>/<file id>/warm` for the next playlist
item, only when that item is another file of the same torrent and the browser
reports no data saver or cellular connection. The playing item is found by the
URL Lampa listed for it (`homelab_source_url`), or by its torrent and file. It
asks once per play of an episode (an audio switch or a retry keeps that play)
and remembers the last 50 files the sidecar accepted (2xx), until the page
reloads. A busy sidecar (429) is asked once more after 30 s, a failure (5xx or
network) once more after 10 s; then the play gives up. The window opens only
once `video.duration` has held the same finite value for 30 s, since a GST
EVENT playlist grows while the task encodes ahead. While an
external voice-over plays, it adds `?voice=<its file id>`. Each request is
logged as a `warm-next` event.

The sidecar refuses a request from another site's page (`Origin`), and a
torrent that `list` does not report as running: it never makes TorrServer
start a torrent. It accepts only a video of that torrent, runs one warm at a
time (429 otherwise) and warms a file at most once in 6 hours. A warm reads:

- the first `WARM_HEAD_MB` (8) MiB of the video with a range request, closed
  at that limit;
- whatever ffprobe reads for the embedded subtitle probe: the header, and in
  MKV also the attachments (fonts), tags and seek index it points to, which may
  sit at the end of the file;
- with `voice`, the head of that voice-over's file for the next episode (the
  candidate in the same folder), as the `/tracks` probe reads it. Without
  `voice`, no audio file is read.

Results land in the probe caches, so the next episode's menus answer at once;
a probe that fails during a warm is not remembered, so the real start probes
again. A probe already running is joined, not repeated. Nothing is encoded.
TorrServer marks every file it streams as viewed; a warm removes that mark
again unless the file was viewed before (a start of that episode during the
warm marks it again on its next read).

## External ASS subtitles

Lampa draws subtitles as plain text in one box at the bottom, and Lampac turns
embedded ASS into WebVTT, so styled signs lose their font and position.
External `.ass`/`.ssa` files named after the video (for example
`YakuSub Studio/<video stem>.ass`) are rendered properly instead:

- `/homelab-media/<hash>/<file id>/tracks` also lists those files as `subtitles`,
  each with the fonts the release ships next to or below it (else any `fonts`
  or `шрифты` folder below the video).
- `/homelab-media/<hash>/<file id>/raw` returns the bytes of a subtitle (up to
  8 MiB) or font (up to 32 MiB) file of that torrent and caches them. Other
  files are refused.
- The image bundles [JASSUB](https://github.com/ThaUnknown/jassub) (libass in
  WebAssembly), pinned in `media/jassub/package-lock.json`, and serves it at
  `/homelab-media/jassub/`. It needs Chrome 80 or Safari 17 or newer.
- The plugin adds `<group>: полные/надписи (внешние)` items to the subtitle menu. Choosing one
  draws the file over the video with its own fonts; the choice is remembered
  per torrent. The encoding is detected from the BOM, then UTF-8, then
  Windows-1251.

Embedded text subtitles are drawn the same way. `/homelab-media/<hash>/<file
id>/embedded` lists the text streams, font attachments, duration and chapters
(the same cached header probe); `sub/<n>` reads a
stream from the playback position as it plays. SRT is converted to ASS (GST's
WebVTT of some SRT streams comes out empty); the plugin styles it from Lampa's
subtitle size, stroke and backdrop settings. Lampa's subtitle delay applies to
every drawn track.

While a track that has a counterpart is on screen, the player panel shows a
`Надп.`/`Полн.` button next to the subtitle menu (`S` on a keyboard does the
same). One press switches between signs only and full subtitles of the same
release: the other item of an external file, or the embedded track of the same
language (the same group first, else the nearest in the menu; a track without
a language pairs only within its group). A second press returns to the track
the first came from. It works like a
menu choice, so the new track is remembered for the torrent, and a notice names
it. Use it when a voice-over leaves parts untranslated.

Fonts a release attaches or ships are also copied once, by content hash, into
`media-fonts/` (ignored; `FONT_LIBRARY_DIR`, capped by
`FONT_LIBRARY_MAX_MB`). A release that names a font without attaching it gets
it from there (`/homelab-media/fonts/index.json`), before a metric-compatible
stand-in. Fonts copied in by hand count too when named `<32 hex>.ttf|otf|ttc`.
Create the directory as the Docker user before the first start, or Docker
creates it owned by root.

## Runtime setup

Create the ignored root-password file on the Docker host before starting the
root Compose project:

```bash
umask 077
openssl rand -hex 32 > lampa/config/passwd
```

The AI adapter reads the TMDB API key from a Docker secret. Create the ignored
secret file before starting the stack:

```bash
install -m 0600 /dev/null hermes/secrets/tmdb_api_key
# Put the TMDB API key on the single line in this file.
```

The service is published at:

```text
https://lampa.${DOCKER_DOMAIN}/
```

On first load the client is configured to use same-origin paths:

- `/torrserver` → the existing TorrServer;
- `/jacred` → JacRed torrent search;
- `/online.js` → Lampac online and anime providers.

The server-side bootstrap also enables Lampac's built-in Dorama section.

The bootstrap sets the parser mode and local service URLs on every Lampa start.

## Account synchronization

The bootstrap installs `plugins/account-sync.js` alongside the playback plugin.
It asks Lampa's native CUB account code to pull bookmark and history changes
(`Account.Bookmarks.update`) and its timeline changelog (`Account.Timeline.update`)
on focus, return to the foreground, section navigation and player close, plus
once a minute while visible and outside the player. CUB only receives local
playback progress from Premium accounts, so without Premium the timeline pull
brings nothing new; cross-device progress then comes from `HomelabSync`.

Event bursts are debounced. Attempts are spaced at least 15 seconds apart;
triggers inside that window, or while a request is in flight, are deferred and
run once rather than dropped. A backward system-clock jump resets the spacing.
A 30-second watchdog releases an attempt whose native callback never arrives
(Lampa's `Account.Api.clear()` silently drops pending CUB requests, for example
while typing in Search). Late callbacks from released attempts are ignored.

Open screens are refreshed only when folder membership changes: a card added,
removed or moved between bookmark folders. History and ordering changes, which
occur on every playback, do not reload screens. A native profile, read or clear
notification resets the comparison baseline; a native add/remove notification
updates only the card it names, so changes native code pulled silently (socket
or its 5-minute timer) are still refreshed.

Around a profile switch (profile selection, a different profile in the stored
account, or one noticed when a request completes) the plugin ignores its own
pending result, starts no new sync for up to 10 seconds while native code
reloads the profile, and takes the first list afterwards as the new baseline.
It cannot cancel native CUB requests already in flight; if one completes after
the switch, native code may still apply it to the newly selected profile.

Synchronization still requires the user's account sync setting and a selected
profile. Android may suspend the client in the background; returning to the app
schedules a check. Existing clients must reload once to load the plugin after
deployment.

## Intel runtime and updates

`runtime/Dockerfile` extends `ghcr.io/lampac-nextgen/lampac:latest` with the Intel
VA driver and VPL GPU runtime. Upstream includes the GStreamer QSV plugin and
VPL dispatcher, but the inspected image lacks these driver/runtime packages.
Lampac's hardware backend selects `qsvh264enc` after a successful startup probe;
VA-API support in another container is not sufficient.

The Lampac application and modules come from the upstream image. The build
recompiles `libe_sqlite3.so` with local symbol binding (`-Bsymbolic`) so a
globally loaded system SQLite cannot interpose incompatible WAL callbacks. It verifies
the SQLite source ID and compile options against the bundled library and stops
if upstream changes either; review the pinned amalgamation before updating it.
The isolated native regression is in `runtime/tests/sqlite_interposition.py`.

The Compose service exposes `/dev/dri/renderD128` and selects the `iHD` driver.
The device must be readable and writable by Lampac's UID 1000 or one of its
supplementary groups. The current deployment's render device is owned by UID
1000; recheck permissions if the host changes.

The derived image is also tagged `latest`, but upstream updates require an
explicit rebuild. Use the [controlled update workflow](UPDATE.md) to stage a
separately tagged candidate, check isolated startup, and retain a rollback
checkpoint before applying it in an idle maintenance window. The CLI itself
does not detect viewers; `lampac-auto-update.timer` runs it nightly at 04:40
`Europe/Sofia` only after Lampa has sent almost nothing for five minutes, as
described there.
Watchtower is disabled for this service because it cannot rebuild a derived
image; a plain `docker compose build` would retag `latest` and make the next
staged update refuse, so rebuild only through that workflow.

## Runtime safeguards and logs

The browser GST plugin bounds recovery to 180 seconds, including hls.js loader
retries. Init segments do not count as successful playback, and only manifest,
level and main-fragment failures start the deadline; a paused video with frames
buffered ahead is not failed by it. A terminal error
releases the owned server task and cancels its heartbeat, track probe and pending
restoration. Explicit Lampa pauses survive recovery even at 0:00; the initial
paused state of a video that has not started is not treated as a user pause.
Task discovery records a validated redirect ID even when the manifest response
fails. On release, its original in-flight lookup may finish within its 90-second
deadline solely to remove that owned task; no new start request is issued.
If a network failure hides the ID entirely, safe targeted removal is impossible
and the backend's inactivity handling remains the fallback. Invalid GST
manifests are reported as errors, never retried as native raw-video playback.
The plugin takes over a torrent only when Lampa's torrent player setting
(`player_torrent`) is an embedded one, the main player is not Samsung AVPlay or
Orsay, and the torrent menu's "run as" did not pick an external app; it then pins
the embedded player. Everything else keeps Lampa's own flow. Lampa's playlist is pointed at the item's
original URL, so Next/Previous stay on the right episode after the GST rewrite.
Lampa's own Playback info button stays hidden for these streams: it needs the
legacy TorrServer hash, which the plugin removes so that Lampa's legacy GST
heartbeat cannot reach another viewer's task.
Plugin changes require reloading the client, not restarting Lampac.

`cpu_shares: 2048` gives playback relative CPU priority under contention.
There is no hard CPU, memory, or PID cap without measurements of concurrent
playback peaks. GST retains the existing 96 MiB forward and 32 MiB backward
segment-cache budgets per session, and freezes pipelines after five inactive
minutes. `maxTasks` stays at zero because a positive limit evicts an existing
session. Software fallback uses `x264Ultrafast`; hardware encoding ignores
this setting. These cache budgets do not bound all native or .NET memory.

`serilog: true` writes structured errors, including GST task/segment context,
to the private `logs/` bind mount. Lampac rolls files daily and retains 14 files.
The host `lampac-logrotate.timer` checks `app-*.log` every minute and copies and
truncates files larger than 10 MiB, keeping two archives per daily file with
delayed compression. Only generated `app-*.log.[0-9]*` archive files older than
14 days are expired, without following directory symlinks. This is approximately
420 MiB before compression across 14 daily files, plus growth between checks;
it is not a strict instantaneous quota. The private log directory is validated
before installation, and the timer refuses a symlink at that path.
Docker console logs use the `local` driver with three 10 MiB files.
Treat logs as private runtime data: upstream errors can contain source URLs
and viewer identifiers. Do not commit or publish them.

Lampac itself logs no requests. Traefik writes JSON access logs only for the
`lampa`, `lampa-media` and `lampa-gst-sessions` routers, without client
addresses or headers, so `docker logs traefik` shows which online stream or GST
session a viewer played. They share Traefik's three 10 MiB console log files,
which hold roughly days of playback, not a fixed period.

The plugin also reports player events to `POST /homelab-media/log`, and the
sidecar prints each as one `client {...}` JSON line with a UTC `ts`:

```bash
docker logs lampa-media 2>&1 | grep '^client '
```

`e` names the event: `play-start`/`play-stop`, `audio-switch` and
`subtitle-switch` (`auto` true for a remembered choice), `hls-error` (fatal
and notable load, buffer and parsing errors), `hls-recovery`, failed GST probe
or task, external audio lookup, preparation and fallback, and JASSUB
`ass-create`/`ass-destroy` with `why` (`mode`: Lampa or its menu set the
track; `preference`, `drawn`, `new-video`; `replace`, `off`, `failed`,
`clear`), `ass-failed` and `ass-fallback`. Each line carries the page session
`s`, the first 8 hash characters `h`, the file `f` and the position `t` in
seconds; URLs keep only their path and full hashes their prefix. The plugin
drops a repeat within 5 s and sends at most 30 events a minute; `dropped` on
the next event counts both kinds. The sidecar takes bodies up to 4 KiB of
JSON, 120 a minute in all. The `lampa-media-log` router limits each address
to 60 a minute (burst 30) and keeps these posts out of Traefik's access log.
Logging failures never affect playback.

`init.conf` disables VeoVeo: its upstream host `api.rstprgapipt.com` no longer
resolves. Aladin is disabled because its CDN returns HTTP 403 for some freshly
resolved streams.

Lampac rereads in-place changes to `init.conf` without a restart. Release any
exclusive lock on the file before waiting for the reload. `git pull` can replace
the host file while the bind mount still points to the old one. Recreate `lampa`
to apply a change made that way.

The HTTP healthcheck requests `/version?type=hash` with a three-second timeout.
It verifies the HTTP application, not GPU functionality or an individual stream.

Before deployment, back up the current Compose/configuration and application
state, create `logs/` with mode 0700 and ownership matching Lampac, verify the
render-device permissions, and validate the complete Compose model with the
deployment environment. Build first; recreate only `lampa` in an agreed playback
window. Recreation interrupts its active GST sessions. Rebuilding the image
alone does not change the running container. The host log policy and systemd
units in this directory must be installed on the Docker host separately.

Render the templates on the Docker host with `envsubst` (from `gettext-base`).
Use that host's deployment directory and account; the values below are examples.
Keep rendered files in `/etc`, outside the repository:

```bash
export HOMELAB_ROOT=/srv/homelab DEPLOY_USER=homelab
export DEPLOY_GROUP="$(id -gn "$DEPLOY_USER")"
test ! -L "$HOMELAB_ROOT/lampa/logs"
sudo install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" "$HOMELAB_ROOT/lampa/logs"
test "$(readlink -f "$HOMELAB_ROOT/lampa/logs")" = "$HOMELAB_ROOT/lampa/logs"
envsubst '${HOMELAB_ROOT} ${DEPLOY_USER} ${DEPLOY_GROUP}' < lampa/logrotate.conf.in |
  sudo tee /etc/logrotate-lampac.conf >/dev/null
envsubst '${HOMELAB_ROOT}' < lampa/lampac-logrotate.service.in |
  sudo tee /etc/systemd/system/lampac-logrotate.service >/dev/null
sudo install -m 0644 lampa/lampac-logrotate.timer /etc/systemd/system/
sudo logrotate --debug --state /var/lib/logrotate/lampac.status /etc/logrotate-lampac.conf
sudo systemd-analyze verify /etc/systemd/system/lampac-logrotate.service /etc/systemd/system/lampac-logrotate.timer
sudo systemctl daemon-reload
sudo systemctl enable --now lampac-logrotate.timer
```

## Verification

```bash
curl -fsS "https://lampa.${DOCKER_DOMAIN}/version?type=hash"
curl -fsS "https://lampa.${DOCKER_DOMAIN}/torrserver/echo"
curl -fsS "https://lampa.${DOCKER_DOMAIN}/online.js" | head
curl -fsS "https://lampa.${DOCKER_DOMAIN}/homelab-media/health"
```

Tests:

```bash
node --test lampa/tests/
(cd lampa/media && python3 -m unittest -q test_app)
```
