# Uptime Kuma

Availability monitoring in the root Compose project. The stable-v2 slim/rootless
image uses SQLite on `./data`, HTTPS through Traefik, and no Docker socket or
published host port. Keep the actual catalog, admin credentials, notification
credentials and Push tokens in ignored private files. Watchtower is enabled by operator request. The official `latest` tag stays
on v1; `2-slim-rootless` follows stable v2. The initially verified release is 2.5.9.

## Bootstrap and deployment

1. Review the current runtime and back it up. Do not synchronize the whole
   checkout over unrelated live changes. Validate the root project with
   `docker compose config --quiet` and `make check-runtime`.
2. Create `uptime-kuma/data` owned by the image's verified Node UID/GID. Leave
   `UPTIME_KUMA_INGRESS_ENABLED=false` until the first admin exists.
3. After deployment approval, start only this service from the root project:
   `docker compose up -d --no-deps uptime-kuma`.
4. Create the administrator and monitors through the application. The optional
   `tools/provision.cjs` uses the initially verified version's internal Socket.IO API over
   container loopback. Feed its private JSON on stdin and capture its stdout
   privately: it contains Push secrets. It refuses unowned monitor-name or
   status-page collisions. Monitors are initially inactive. Never edit the live
   SQLite database to configure Kuma.
5. Set the ignored deployment environment's ingress flag to `true`, verify the
   narrow `LAN_SUBNET` source allowlist and trusted HTTPS, and recreate only Kuma.
   Admin authentication stays enabled. Native status pages can be viewed without
   admin login by anyone allowed through the private ingress boundary.
6. Install the reviewed collector, then activate the reviewed owned monitors
   (`phase: "activate"`). `sendTest: true` sends a real notification; use it only
   with authorization and record success so reruns do not repeat the test.

Provisioning input uses `username`, `password`, `timezone`, `baseUrl`, `tags`,
`monitors`, optional native `notification`, and `statusPage`. Monitor ownership
is `description: homelab-managed:<key>`. The status-page description must retain
`<!-- homelab-managed:status -->`. Monitor parents must precede children. The
catalog and deployment addresses are intentionally absent from this repository.

## Monitoring contracts

- HTTP checks accept only their endpoint's expected response. An expected login
  page/401 is edge availability, not proof of authenticated application behavior.
- Container Push checks inspect native Docker health. A running container without
  a healthcheck is explicitly labeled process-only. Exited successful one-shot
  initializers and intentionally disabled profiles are excluded.
- Groups aggregate children; they do not suppress dependency notifications.
  Configure notifications on leaves only to avoid duplicate group alerts.
- Optional phones/desktops have a separate unalerted group. Monitoring does not
  wake devices or establish an ADB session.
- Filesystem checks require at least 5% and 5 GiB available by default. Existing
  capacity problems remain visible rather than being hidden by changed limits.
  Notifications can be disabled for accepted low-space conditions while checks
  remain visible; capacity DOWN denotes a threshold violation, not disk failure.
  Set `require_mount: true` for dedicated storage mountpoints so an unmounted
  disk cannot be mistaken for free space on the parent filesystem.
- This instance cannot send an alert if its own host/power/network fails. An
  independent external observer is a separate component.

## Telegram presentation

`telegram-template.liquid` is the reviewed native Telegram HTML template. The
private catalog supplies it through `telegramUseTemplate`, `telegramTemplate`
and `telegramTemplateParseMode: HTML`. Edit only the existing notification
provider; keep its recipient, credentials, default policy and monitor bindings.
Saving a template does not require sending a live test notification.

Messages show a clear state, service name, bounded diagnostic text and the
heartbeat's `localDateTime`/`timezone` (Europe/Sofia). Dynamic text is truncated
before HTML escaping; missing heartbeat events use a generic notice, and zero
latency is retained. The real installed provider passed five offline rendering
cases with network disabled. A retired host must be removed from the desired
catalog and status-page membership as well as the live monitor list; preserve a
verified native data snapshot before deleting its history.

## Host collector

The trusted host helper reads only selected Docker state/health fields and
filesystem capacity. Kuma receives no Docker API or host SSH credential. Keep
`/etc/homelab/uptime-kuma-push.json` root-owned mode 0600. The installed script
must be root-owned and not writable by untrusted users.

Install `tools/push-health.py` as
`/usr/local/libexec/homelab-kuma-push`, and install the provided systemd service
and timer after reviewing the configuration. The timer runs each minute. Use
120-second Push intervals and a bounded retry to tolerate small scheduling
variation; verify expiry and recovery with an isolated, unalerted test monitor.
Total Docker query failure publishes no successful result; stale Push monitors
expire. A partial inspect preserves valid rows and marks a missing target down.
Transport errors log only target identity and exception class, never token URLs.

Example shape (replace placeholders only in private configuration):

```json
{
  "base_url": "https://uptime.example.invalid",
  "containers": [{"name": "example-worker", "token": "PRIVATE_PUSH_TOKEN"}],
  "mounts": [{"name": "System disk", "path": "/", "token": "PRIVATE_PUSH_TOKEN"}]
}
```

The source defaults to a trusted HTTPS frontend. If the source ACL rejects host
pushes, inspect the actual path and source; do not broadly open the dashboard.

## Verification and recovery

Run `python3 -m unittest discover -s uptime-kuma/tests -v`,
`node --test uptime-kuma/tests/provision.test.cjs`, and Node syntax
checks on the `.cjs` tools. Validate the root Compose model without printing
resolved secrets. Verify HTTPS, unauthorized admin access, allowed/denied ingress,
actual probes from the Kuma container, one failure/recovery and stale-Push test,
and persistence across a scoped Kuma restart.

The existing app-data backup collector discovers service-local bind data and
performs online SQLite backups with `quick_check`. Confirm the deployed collector
and repository path, then verify a real capture includes Kuma before reporting
backup coverage. Back up the entire `data` directory, including uploads and
settings; a copied live `kuma.db` without its WAL is not a backup.

For recovery, create and restore-test a private backup with the actual deployed image digest. A newer application may migrate the database: rolling back only
the image does not roll back the schema. Restore the matching data snapshot.
Rollback of this new service consists of stopping its timer and only the Kuma
service, disabling its ingress flag, and retaining the private state for recovery.

Watchtower uses the existing root-stack schedule. The application backup timer
should complete before it; this is not a transactional pre-update gate. Keep
previous image digests with matching snapshots for recovery after DB migrations.
The provisioning tools target the initially verified internal API version and
must be rechecked before use after an automatic update.
