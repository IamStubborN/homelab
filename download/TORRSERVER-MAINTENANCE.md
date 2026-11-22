# TorrServer maintenance

The shared Gluetun healthcheck delegates to `/gluetun-entrypoint healthcheck`.
It uses the native VPN monitor and leaves firewall rules and application health
independent. Updating the bind-mounted script does not require a VPN restart.

## Persistent logs

Compose declares `./torrserver/log:/opt/ts/log`.

Run `torrserver-logrotate.sh` once per minute as the deployment user on the host
(requires Docker access and `/usr/sbin/logrotate`). The script exits without
changes unless the running container has the expected persistent log bind.
The deployed host cron job sends rotation errors to syslog with the tag
`torrserver-logrotate`; preserve unrelated cron entries when installing it.
Before rotation, the script normalizes the current log file's owner to the
deployment user through `docker exec`, including files recreated by TorrServer
as root. It does not change configuration or other container files.

Rotation checks a 10 MiB threshold once a minute and keeps three archives,
compressing older archives. The active file can exceed the threshold between
checks. `copytruncate` preserves TorrServer's open file descriptor, with the
usual small possibility of losing lines written during the copy/truncate gap.

## Changing settings.json

Some settings (for example `BitTorr.DisableUPNP` or `EnableRutorSearch`) must not
be changed through the settings API during playback: it can restart the torrent
client. Change them in a stopped instance instead:

1. Stop only `torrserver`; leave both Gluetun containers, the watchers and
   port-sync running (port-sync retries while TorrServer is down).
2. Edit `torrserver/config/settings.json` with an atomic replacement, changing
   only the intended key and preserving the rest, including the GStreamer
   section.
3. From the checkout root:
   `docker compose up -d --no-deps --no-build --pull never --wait --wait-timeout 60 torrserver`.
   Port-sync resumes once the API answers.

Keep a copy of the previous `settings.json`; if startup fails, restore it and
recreate only `torrserver`. Never touch the VPN containers.

## Rutor search and ffprobe

`EnableRutorSearch` stays `false` in `settings.json`. TorrServer's own rutor
index (used only by its web search and Telegram bot; Lampa searches through
JacRed, which crawls rutor itself) reloads every three hours. The MatriX build
can run two reload loops after a quick double `set`, and its decoder never leaves a
parse error. A corrupt temporary index can therefore keep a reload loop busy.
Change the flag only in a stopped instance, as described above. These upstream
behaviours were checked against the pinned build (`TORRSERVER_VERSION` in
`download/compose.yml` and `download/torrserver/Dockerfile`); recheck them on
upgrade.

The image ships `ffprobe`, which TorrServer looks up in `PATH` for `/ffp`.
Without it JacRed's track analyses (`tracks: true`) all fail while still making
TorrServer fetch each file's head; with it Lampa's torrent list shows the audio
and subtitle tracks of analysed releases.

## Requests from other web pages

TorrServer runs without a login (`TS_HTTPAUTH=0`) and answers every origin
with `Access-Control-Allow-Origin: *`, so any page open in a LAN browser or TV
could read the torrent list or change settings, and a plain
`<img src=".../shutdown">` would stop the server. The Traefik file provider
(`traefik/config/config.yml`, see `config.example.yml`) guards it without
recreating the VPN container that carries TorrServer's labels:

- `torrserver-shutdown*` refuses `/shutdown` on both hosts with 403
  (`deny-all`), also behind extra slashes and as `/torrservershutdown`.
  Restart TorrServer through Docker instead.
- `torrserver-foreign*`, `lampa-torrserver-foreign` and
  `lampa-torrserver-gst-foreign` refuse with 403 requests whose `Origin` is
  neither Lampa nor TorrServer, or cross-site requests without an `Origin`,
  and write an access log line. TV playback sends no such requests.

If a client stops playing, look for it with
`docker logs traefik | grep -- '-foreign@file'`. A `HEAD` request
tests the shutdown rule safely: TorrServer itself answers `HEAD /shutdown` with
404, so 403 proves Traefik refused it.
