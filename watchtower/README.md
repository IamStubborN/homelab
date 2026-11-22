# Watchtower and nightly Docker host maintenance

Watchtower updates labeled containers at 05:45 `Europe/Sofia` with
`--cleanup=false`. The rest of this page covers the Docker host's nightly jobs
around it; the full night schedule is below.

## Image retention

`image-retention.py` (Python 3 standard library) records image IDs actually
used by explicitly enrolled, Watchtower-enabled Compose services. It retains
the current and one previous distinct observed ID per service/replica.
Histories are independent even when services share repositories; image
protection is the union across all histories sharing an ID.

Only older recorded IDs with **no tags**, no references from **any** container
(including stopped/created containers), and no digest in an untracked repository
can be removed, and only through repository digest references recorded while the
image was current for an enrolled service. Images without a proven digest remain
protected; the tool never falls back to deleting by image ID. All tags, including
`latest` and arbitrary manual rollback tags, are protected. Unknown existing
orphan images are never adopted by repository name, creation time, or digest.

Missing, stopped, disabled, or changed-reference services freeze their entire
history. New services are reported but not automatically enrolled; a new state
file can enroll them (keep the old one as a backup, since images known only to
it become protected unknowns). These safety exceptions can retain more than two
images. This bounds eligible update history, not total Docker disk use.

Deployed on the Docker host with `--apply`: the script is
`/usr/local/libexec/watchtower-image-retention.py`, the state is
`/var/lib/watchtower-image-retention/state.json` (directory 0700, file 0600,
outside Git), and `image-retention.timer` is enabled. The timer runs the
service at 05:40, capturing the old IDs before Watchtower, and at 06:25,
recording the replacements; `Persistent=false` avoids a catch-up run at boot.
Missed observations or extra manual updates can leave unknown intermediates;
those remain untouched.

Each deletion refreshes all containers and images twice, updates history, and
rechecks the candidate before each digest removal, resolving that exact digest
back to its recorded full image ID. It invokes only
`docker image rm --no-prune REPOSITORY@sha256:DIGEST`, without force, one digest
at a time. A Docker conflict or changing protection stops the run. No
parent-image, global-image, build-cache, or volume pruning is performed. A tag
added between the check and the removal is preserved (see the Engine's
[ImageDelete implementation](https://github.com/moby/moby/blob/464cd50/daemon/images/image_delete.go)).
The tool reports reference removal separately from image deletion and never
retries by ID.

Commands (the tool uses the local Unix socket, never a Docker context; none
pull, tag or restart anything): `discover --project PROJECT` and `plan` are
read-only; `init --project PROJECT` captures current IDs into a new state file
and refuses to overwrite history; `observe` records current IDs; `run` records
and prints a dry-run plan, or deletes with `--apply`. Every command takes
`--state PATH`. Plans contain image metadata and service identities, so keep
them outside Git. Logical image sizes are not reclaimed bytes.

Install or update as root on the Docker host, from its checkout. Shared
directories such as `/usr/local/libexec` must stay 0755 (0700 breaks Docker CLI
plugin discovery):

```sh
install -m 0755 watchtower/image-retention.py /usr/local/libexec/watchtower-image-retention.py
install -d -m 0700 /var/lib/watchtower-image-retention
sed -e 's|@SCRIPT@|/usr/local/libexec/watchtower-image-retention.py|' \
  -e 's|@STATE@|/var/lib/watchtower-image-retention/state.json --apply|' \
  watchtower/image-retention.service.in > /etc/systemd/system/image-retention.service
install -m 0644 watchtower/image-retention.timer /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/image-retention.service
[ -e /var/lib/watchtower-image-retention/state.json ] || python3 /usr/local/libexec/watchtower-image-retention.py \
  init --project homelab --state /var/lib/watchtower-image-retention/state.json
systemctl daemon-reload
systemctl enable --now image-retention.timer
```

To stop retention, disable the timer and keep the state: resetting it discards
provenance.

Retention never tags or pins images, so "retained" only means this tool will
not delete them. The 06:05 Docker cleanup removes an image Watchtower replaced
at 05:45 (untagged, used by no container) before retention's 06:25 run, so the
previous image is normally already gone locally. Roll back by pulling a
previous repository digest recorded in the state file (`digests`, keyed by the
image IDs in each service's `history`; `plan` lists the histories) while the
registry still serves it, or use an existing manual rollback tag. Disabling
retention does not restore deleted images.

## Nightly schedule

All times are `Europe/Sofia`, the timezone of both Proxmox and the Docker
guest. Timers also name the zone, so daylight saving time does not move one
job into another's window.

| Time | Job |
| --- | --- |
| 03:55 | Router configuration backups on Proxmox (private home repository, `scripts/router-config-backup`) |
| 04:00–04:45 | Backups (each waits for the previous one): daily OPNsense config (04:00) and app data (04:05), Sunday host config (04:20) and OPNsense VM (04:25); see `proxmox-backup/README.md`. JacRed starts no crawls 04:00–04:59 |
| 04:40–05:25 | Lampac update when upstream changed and Lampa is idle (`lampa/UPDATE.md`) |
| 05:40 | Image retention records the running images |
| 05:45 | Watchtower updates containers |
| 06:05 | Docker cleanup: untagged images, build cache older than 7 days |
| 06:10 | Docker host package updates: Ubuntu and Docker CE (a Docker update restarts every container) |
| 06:20 | Proxmox trims the Docker guest's rootfs (`homelab-guest-fstrim`, `proxmox-update/`) |
| 06:25 | Image retention records the replacements |
| 06:30 | OPNsense firmware auto-update (its cron job; a reboot drops the internet for a few minutes) |
| 06:50 | Proxmox host updates, reboot for a new kernel before 07:45 (`proxmox-update/`) |
| first Sunday 08:00 | Monthly Docker guest backup (about an hour, snapshot mode); JacRed starts no crawls on Sundays 08:00–11:59 |

Nobody uses the homelab between 04:00 and 08:00. Backups run first (the small
router configuration exports just before the window), so they copy the last
working state; downloads (Lampac, Watchtower, packages) come next; the jobs
that can drop the internet, OPNsense and Proxmox, come last.

## Failure notifications

Watchtower reports failed updates (log level `error`) to the disk-watchdog's
Telegram bot and chat. The URL holds the bot token, so it lives in the ignored
`watchtower/secrets/notification_url`; create it on the Docker host from the
disk-watchdog's own secret:

```sh
umask 077; mkdir -p watchtower/secrets
printf 'telegram://%s@telegram?chats=%s&preview=No\n' \
  "$(docker exec disk-watchdog cat /run/secrets/telegram_bot_token | tr -d '[:space:]')" \
  "$(docker exec disk-watchdog printenv TELEGRAM_CHAT_ID)" > watchtower/secrets/notification_url
```

## Nightly Docker cleanup

`docker-prune.timer` runs `docker image prune -f` and
`docker builder prune -f --filter until=168h` at 06:05. Only untagged images
that no container (even a stopped one) uses are removed, so tags such as
`latest` and Lampa's candidate/rollback tags stay. An image Watchtower replaced
at 05:45 loses its tag and is removed the same night (rollback: see Image
retention). Install as root on the Docker host:

```sh
install -m 0644 watchtower/docker-prune.service watchtower/docker-prune.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now docker-prune.timer
```

## Nightly host package updates

Container updates (05:45) and the Docker host's Ubuntu `unattended-upgrades`
both run at night, so neither restarts services during the day. Ubuntu's
`apt-daily-upgrade.timer` defaults to 06:00 UTC plus up to an hour of random
delay. `apt-daily-upgrade.override.conf` moves it to 06:10 `Europe/Sofia`.
Install it as root on the Docker host:

```sh
install -D -m 0644 watchtower/apt-daily-upgrade.override.conf \
  /etc/systemd/system/apt-daily-upgrade.timer.d/override.conf
systemctl daemon-reload
systemctl restart apt-daily-upgrade.timer
systemctl list-timers apt-daily-upgrade.timer
```

By default `unattended-upgrades` installs only Ubuntu's security updates.
`52homelab-unattended-upgrades` adds Ubuntu's regular updates (`noble-updates`)
and Docker CE from `download.docker.com`, major versions included. A Docker
Engine update restarts `dockerd` and every container with it for a minute or
two, inside the update window; all containers come back on their own, as after
a host reboot. Packages whose configuration files were changed locally are
skipped rather than prompted. Install it as root on the Docker host and check
the plan:

```sh
install -m 0644 watchtower/52homelab-unattended-upgrades /etc/apt/apt.conf.d/
unattended-upgrade --dry-run
```

## Drift check

Source edits reach the Docker host only through the `install` commands on this
page. After changing a file, install it and compare as root from the same
commit:

```sh
while read -r repo installed; do
  [ "$(sha256sum < "$repo")" = "$(sha256sum < "$installed")" ] || echo "drift: $installed"
done <<'EOF'
watchtower/image-retention.py /usr/local/libexec/watchtower-image-retention.py
watchtower/image-retention.timer /etc/systemd/system/image-retention.timer
watchtower/docker-prune.service /etc/systemd/system/docker-prune.service
watchtower/docker-prune.timer /etc/systemd/system/docker-prune.timer
watchtower/apt-daily-upgrade.override.conf /etc/systemd/system/apt-daily-upgrade.timer.d/override.conf
watchtower/52homelab-unattended-upgrades /etc/apt/apt.conf.d/52homelab-unattended-upgrades
EOF
sed -e 's|@SCRIPT@|/usr/local/libexec/watchtower-image-retention.py|' \
  -e 's|@STATE@|/var/lib/watchtower-image-retention/state.json --apply|' \
  watchtower/image-retention.service.in | diff - /etc/systemd/system/image-retention.service
```
