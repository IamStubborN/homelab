# Uptime Kuma

Availability monitoring in the root Compose project. The stable-v2 slim/rootless
image uses SQLite on `./data`, HTTPS through Traefik, and no Docker socket or
published host port. Keep the actual catalog, admin credentials, notification
credentials and Push tokens in ignored private files. Watchtower follows
`2-slim-rootless`, the stable v2 tag (the official `latest` tag is v1).

## Bootstrap and deployment

1. Validate the root project with `docker compose config --quiet` and
   `make check-runtime`.
2. Create `uptime-kuma/data` owned by the image's Node UID/GID. Leave
   `UPTIME_KUMA_INGRESS_ENABLED=false` until the first admin exists.
3. Start only this service from the root project:
   `docker compose up -d --no-deps uptime-kuma`.
4. Create the administrator and monitors through the application. The optional
   `tools/provision.cjs` uses Kuma's internal Socket.IO API over
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

## Ingress

Both routers exist only while `UPTIME_KUMA_INGRESS_ENABLED=true`:

- `uptime-kuma`: the whole UI on `https://uptime.${DOCKER_DOMAIN}`, limited to
  `LAN_SUBNET`.
- `uptime-kuma-observer`: only `GET /api/entry-page` on the same host (priority
  350), limited to `UPTIME_KUMA_OBSERVER_SOURCES` (default `LAN_SUBNET`). It lets
  an external observer confirm that Kuma itself answers without opening the UI
  to that source. Set it in the root `.env` to the observer's addresses plus the
  LAN, as a comma-separated CIDR list.

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
latency is retained. A retired host must be removed from the desired
catalog and status-page membership as well as the live monitor list. Delete
its monitor through the native API; its history is not kept.

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

Optional `health_error_capture` saves failed native probes for one monitored
container. It uses the same minute collector and inspects probe output only for
that target. Install the service's private `StateDirectory` before enabling it:

```json
{"health_error_capture": {"container": "example-worker", "path": "/var/lib/homelab-kuma/health-errors.json"}}
```

The atomic mode-0600 file retains the latest 100 distinct failures, with probe
start/end times, exit code, bounded output and observed Docker state. Recovery
does not erase failures; repeated observations are deduplicated. Output may
contain private application details and must stay outside Git. A capture write
failure logs only its exception class and does not block heartbeat publication.
Docker retains only a short probe ring: collector downtime can still lose old
errors. This diagnostic does not add application request logging.

For noisy container Push monitors, retry tolerance must be tested against the
installed Kuma version. Its watchdog also consumes retries after a fresh bad
Push; a retry count is not an exact number of minutes. In tested v2 timing,
three retries suppress a single bad sample followed by recovery within
70 seconds, while sustained failures and absent collectors still become DOWN.
Keep the actual selected monitors and controls in the private catalog.

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

The app-data backup collector takes online SQLite backups of `data/` with
`quick_check`; a copied live `kuma.db` without its WAL is not a backup. A newer
image may migrate the database, so rolling back only the image does not roll
back the schema: restore the matching data snapshot with it. To take Kuma out of
service, stop the collector timer and the `uptime-kuma` service, disable its
ingress flag, and keep `data/` for recovery.

`tools/provision.cjs` uses Kuma's internal API, which can change in a Watchtower
update; recheck it before use after an update.
