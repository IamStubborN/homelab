# Homelab development guide

This repository holds a modular Docker Compose homelab. The root `compose.yml`
includes service-specific Compose files. Run commands from the repository root
unless a service README says otherwise.

## Local checks

- `docker compose config --quiet` validates the assembled Compose model without
  printing resolved environment values.
- `make check-runtime` checks for services launched outside the root project.
- Run the service's own tests before changing its deployment contract.

## Deployment

The Docker host runs a checkout of `origin/main` and is a deploy target. Every
change, hotfixes included, is committed and pushed from a development checkout;
the host then runs `git pull --ff-only` and `docker compose up -d <service>`.
The VPN watchers (`gluetun-watcher`, `gluetun-torrserver-watcher`,
`gluetun-rezka-watcher`) run `docker compose up` from the host's working tree at
any moment, so an edit made on the host reaches production unreviewed, fails
`make check-deploy` and can block the next `git pull --ff-only`.

A deployment is done when `make check-deploy` passes on the host: the checkout is
clean at `origin/main`, Compose plans no container changes and every service is
running and not unhealthy (one-shot jobs may exit 0). A warning lists services
Watchtower updated: their Compose image label is stale, and
`docker compose up -d <service>` restarts them on the same image to refresh it.

Ignored private configuration is authoritative on the host. A development
checkout that keeps copies of these files pulls each changed file back from the
host.

## Host-installed files

Some files are installed by hand, outside Compose: `proxmox-backup/` and
`proxmox-update/` on Proxmox. On the Docker host:

- `app-data-backup.py`, `docker-journald-retention.conf`, the `watchtower/` apt
  files;
- units: `lampac-*`, `image-retention`, `docker-prune`, `homelab-kuma-push`;
- deployment user's crontab lines: `provider-stats` (or its units),
  `torrserver-logrotate`, `telegram-watchdog`;
- `/etc/logrotate-lampac.conf` (from `lampa/logrotate.conf.in`).

`make check-deploy` does not cover them. After changing one,
install it as its README says and compare the installed file's SHA256 with the
repository's.

## Configuration boundary

The public repository contains examples and code. Keep actual `.env` files,
`compose.override.yml`, service-local configuration, credentials, household
profiles, host inventory, health records, databases, media libraries, runtime
state, and backups outside Git. Use `hermes/private-profiles/` for private agent
profiles and override `HERMES_PRIMARY_PROFILE_DIR` and
`HERMES_SECONDARY_PROFILE_DIR` in the ignored deployment environment.

The public roles are `primary` and `secondary`. A deployed instance can map
those roles to existing health person IDs with `HEALTH_PRIMARY_PERSON` and
`HEALTH_SECONDARY_PERSON`. Preserve existing named volume names and wiki paths
through the ignored deployment environment during a cutover. Container names
and media notifier URLs use the public role names.

Never print a resolved Compose model or secret file contents into reports.

## Storage

- Media libraries and the wiki live on host-mounted storage.
- Application state generally uses bind mounts below each service directory.
- Engine-managed state uses explicit Docker named volumes.
- Credentials are mounted from ignored secret files.

Do not rename a live volume or move a bind mount merely for naming consistency.
Recreation keeps named volumes and bind mounts, and nightly backups cover
state; take a deliberate backup only before an irreversible data migration
(schema change or volume move). Validate the selected Compose resources before
deployment.
