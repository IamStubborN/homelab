# TorrServer maintenance

The shared Gluetun healthcheck delegates to `/gluetun-entrypoint healthcheck`.
It uses the native VPN monitor and leaves firewall rules and application health
independent. Updating the bind-mounted script does not require a VPN restart.

## Persistent logs

Compose declares `./torrserver/log:/opt/ts/log`. The deployed container already
uses this bind. Older deployments acquire it only on recreation; do not restart
active playback solely to enable log rotation.

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
The existing TorrServer image and entrypoint remain unchanged.

## Recreation procedure

1. Back up the current Compose file, complete TorrServer config directory,
   existing log, and current crontab to a private directory below
   `torrserver/backups/`. Confirm the running image and VPN parent are unchanged.
2. Stop only `torrserver`. Allow it up to 20 seconds to stop. Leave both Gluetun
   containers, watchers, and port-sync running. Port-sync will retry the API
   while TorrServer is stopped.
3. Take final, stopped copies of the configuration and log. Seed
   `torrserver/log/torrserver.log` with the entire final log using `docker cp`
   before recreating TorrServer. Keep the backup separately. The deployment
   user must own and be able to write the log directory and seeded log file.
4. In the stopped instance's `torrserver/config/settings.json`, change only
   `BitTorr.DisableUPNP` to `true`, using an atomic replacement. Preserve all
   other keys, including the complete GStreamer section. Do not apply this via
   the settings API during playback: it can restart the torrent client.
5. From the root Compose project, run
   `docker compose up -d --no-deps --no-build --pull never --wait --wait-timeout 60 torrserver`.
   The existing port-sync container resumes automatically when the API responds.
   No image build or VPN recreation is needed. Allow roughly 30–90 seconds for
   this window; failed health checks require recovery rather than further waits.
6. Verify healthy containers, matching live/persisted settings, `DisableUPNP`,
   the forwarded port and TCP/UDP listeners, unchanged VPN container identities
   and firewall policy, cache 2147483648, preload 3, and CPU shares 2048.
   Confirm the log bind, ownership, host rotation dry-run, and the next scheduled
   rotation. Do not start a playback or speed test as part of verification.

If startup fails, restore the saved Compose/config, preserve any new logs, and
recreate only TorrServer with the original image. Port-sync resumes once the
server responds. Do not alter the VPN namespace to recover a logging change.

## Rutor search and ffprobe

`EnableRutorSearch` stays `false` in `settings.json`. TorrServer's own rutor
index (used only by its web search and Telegram bot; Lampa searches through
JacRed, which crawls rutor itself) reloads every three hours. MatriX.145 can
run two reload loops after a quick double `set`, and its decoder never leaves a
parse error: on 2026-10-22 a torn `rutor.tmp` left one loop spinning at about
1.2 cores until the restart. Change the flag only in a stopped instance, as in
the recreation procedure above.

The image ships `ffprobe`, which TorrServer looks up in `PATH` for `/ffp`.
Without it JacRed's track analyses (`tracks: true`) all fail while still making
TorrServer fetch each file's head; with it Lampa's torrent list shows the audio
and subtitle tracks of analysed releases.
