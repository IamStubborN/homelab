# Lampa

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
`Sound/<episode>.mka`. GStreamer reads one file, so the `lampa-extaudio`
sidecar adds those files to browser playback without modifying Lampac:

- `/extaudio/<hash>/<video file id>/tracks` lists the video's audio files,
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
- `/extaudio/<hash>/<file id>/<stream>/aac/audio.m3u8?at=<seconds>`
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
- Results live in the ignored `extaudio-cache/` directory, which is limited to
  1 GiB and 24 hours. Delete it at any time.
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
audio SourceBuffer from it. If a GST fragment layout cannot be stripped, the
plugin falls back to the embedded track.

## External ASS subtitles

Lampa draws subtitles as plain text in one box at the bottom, and Lampac turns
embedded ASS into WebVTT, so styled signs lose their font and position.
External `.ass`/`.ssa` files named after the video (for example
`YakuSub Studio/<video stem>.ass`) are rendered properly instead:

- `/extaudio/<hash>/<file id>/tracks` also lists those files as `subtitles`,
  each with the fonts the release ships next to or below it (else any `fonts`
  or `шрифты` folder below the video).
- `/extaudio/<hash>/<file id>/raw` returns the bytes of a subtitle (up to
  8 MiB) or font (up to 32 MiB) file of that torrent and caches them. Other
  files are refused.
- The image bundles [JASSUB](https://github.com/ThaUnknown/jassub) (libass in
  WebAssembly), pinned in `extaudio/jassub/package-lock.json`, and serves it at
  `/extaudio/jassub/`. It needs Chrome 80 or Safari 17 or newer.
- The plugin adds `<group> (ASS)` items to the subtitle menu. Choosing one
  draws the file over the video with its own fonts; the choice is remembered
  per torrent. The encoding is detected from the BOM, then UTF-8, then
  Windows-1251.

Embedded text subtitles are drawn the same way. `/extaudio/<hash>/<file
id>/embedded` lists the text streams and font attachments; `sub/<n>` reads a
stream from the playback position as it plays. SRT is converted to ASS (GST's
WebVTT of some SRT streams comes out empty); the plugin styles it from Lampa's
subtitle size, stroke and backdrop settings. Lampa's subtitle delay applies to
every drawn track.

Fonts a release attaches or ships are also copied once, by content hash, into
`extaudio-fonts/` (ignored; `FONT_LIBRARY_DIR`, capped by
`FONT_LIBRARY_MAX_MB`). A release that names a font without attaching it gets
it from there (`/extaudio/fonts/index.json`), before a metric-compatible
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

## Intel runtime and updates

`runtime/Dockerfile` extends `ghcr.io/lampac-nextgen/lampac:latest` with the Intel
VA driver and VPL GPU runtime. Upstream includes the GStreamer QSV plugin and
VPL dispatcher, but the inspected image lacks these driver/runtime packages.
Lampac's hardware backend selects `qsvh264enc` after a successful startup probe;
VA-API support in another container is not sufficient.

The managed application and modules remain upstream. The image rebuilds
`libe_sqlite3.so` with local symbol binding (`-Bsymbolic`) so a globally loaded
system SQLite cannot interpose incompatible WAL callbacks. The build verifies
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
checkpoint before applying it in an idle maintenance window. The CLI is manual;
it does not detect viewers or schedule restarts. Watchtower is disabled for this
service because it cannot rebuild a derived image. No automatic rebuild pipeline
is installed.

## Runtime safeguards and logs

The browser GST plugin bounds recovery to 180 seconds, including hls.js loader
retries. Init segments do not count as successful playback. A terminal error
releases the owned server task and cancels its heartbeat, track probe and pending
restoration. Explicit Lampa pauses survive recovery even at 0:00; the initial
paused state of a video that has not started is not treated as a user pause.
Task discovery records a validated redirect ID even when the manifest response
fails. On release, its original in-flight lookup may finish within its 90-second
deadline solely to remove that owned task; no new start request is issued.
If a network failure hides the ID entirely, safe targeted removal is impossible
and the backend's inactivity handling remains the fallback. Invalid GST
manifests are reported as errors, never retried as native raw-video playback.
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
`lampa`, `lampa-extaudio` and `lampa-gst-sessions` routers, without client
addresses or headers, so `docker logs traefik` shows which online stream or GST
session a viewer played. They share Traefik's three 10 MiB console log files,
which hold roughly days of playback, not a fixed period.

The plugin also reports player events to `POST /extaudio/log`, and the
sidecar prints each as one `client {...}` JSON line with a UTC `ts`:

```bash
docker logs lampa-extaudio 2>&1 | grep '^client '
```

`e` names the event: `play-start`/`play-stop`, `audio-switch` and
`subtitle-switch` (`auto` true for a remembered choice), `hls-error` (fatal
and notable load, buffer and parsing errors), `hls-recovery`, failed GST probe
or task, external audio lookup, preparation and fallback, and JASSUB
`ass-create`/`ass-destroy` with `why` (`mode`: Lampa or its menu set the
track; `preference`, `drawn`, `new-video`; `replace`, `off`, `failed`,
`clear`), `ass-failed` and `ass-fallback`. Each line carries the page session
`s`, the first 8 hash characters `h`, the file `f` and the position `t` in
seconds; URLs keep only their path. The plugin drops a repeat within 5 s and
sends at most 30 events a minute, counting the rest in `dropped`; the sidecar
takes bodies up to 4 KiB of JSON, 300 a minute in all. Logging failures never
affect playback.

`init.conf` disables VeoVeo: its upstream host `api.rstprgapipt.com` no longer
resolves. Lampac rereads `init.conf` when the file changes, but it is mounted as
a single file and `git pull` replaces it, so recreate `lampa` to apply a pulled
change.

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
curl -fsS "https://lampa.${DOCKER_DOMAIN}/extaudio/health"
```

Tests:

```bash
node --test lampa/tests/
(cd lampa/extaudio && python3 -m unittest -q test_app)
```
