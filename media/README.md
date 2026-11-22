# Media Stack and Orchestrator

Plex and its helpers live in `plex/`. The torrent VPN stack lives in `download/`.
This directory keeps Media Orchestrator, the dedicated Rezka VPN, and their secrets.

## Active Torrent VPN Gateway

The torrent stack lives in `download/compose.yml` and uses `qmcgaw/gluetun:latest` with Watchtower updates enabled.
Gluetun selects Proton VPN port-forwarding servers in Bulgaria, and
`qbittorrent-port-sync` applies the current forwarded port to qBittorrent over
its local API without restarting qBittorrent. TorrServer has its own
`gluetun-torrserver` namespace and forwarded port (`torrserver-port-sync`
writes `PeersListenPort`). LAN URL is `https://torrserver.${DOCKER_DOMAIN}`.

On a fresh checkout only, create the ignored runtime files under `download/`
before the first start. Each line skips a file that already exists, so it never
truncates a live key or port file:

```bash
install -d -m 0755 download/gluetun/data download/gluetun-torrserver/data
install -d -m 0700 download/secrets
for f in download/gluetun/data/forwarded_port \
         download/gluetun-torrserver/data/forwarded_port; do
  [ -e "$f" ] || install -m 0644 /dev/null "$f"
done
for f in protonvpn_wireguard_private_key protonvpn_wireguard_private_key_torrserver \
         gluetun_control_auth_config gluetun_control_api_key; do
  [ -e "download/secrets/$f" ] || install -m 0600 /dev/null "download/secrets/$f"
done
```

The forwarded-port files are not credentials and must stay readable by the
unprivileged port-sync containers. The WireGuard private keys and control API
credentials stay mode `0600` and are never committed. All torrent VPN state and
secrets live under `download/`, next to `download/compose.yml`.

`compose.media-orchestrator.yml` is included by the root `compose.yml` and is
managed as part of the `homelab` Compose project. Application images must be
published before running a root deployment. `MEDIA_POSTGRES_IMAGE` stays on a
PostgreSQL 17 tag without a digest so Watchtower can apply patch updates; do
not pin it by sha256 and do not use `postgres:latest`.

The private application repository exports a four-file release contract. Copy
one real export to the ignored `media/release/` directory, validate it with
`MEDIA_RELEASE_DIR=/absolute/path/to/media/release
hermes/scripts/deploy-preflight`, and set `MEDIA_SERVICE_IMAGE` and
`DOWNLOAD_RUNNER_IMAGE` to the exact immutable references in its `release.json`.
The tracked `media/release.example/` directory is deliberately non-production
and exists only for tests. Registry authentication and image publication remain
explicit operator steps; this repository does not log in, publish, or deploy.

The private guarded deploy must be invoked with explicit paths, for example
`HOMELAB_ROOT=/absolute/path/to/homelab` and
`MEDIA_RELEASE_DIR=/absolute/path/to/homelab/media/release`. It never requires a
private source checkout on the Docker host and does not infer sibling paths.

`media-session-init` is a one-shot permissions bootstrap for the shared
`rezka_session_encrypted` volume. It runs as root only long enough to assign the
application UID/GID to the session directory and existing `session.bin`; it
does not rotate cookies, reset the session, or participate in VPN lifecycle.

## Prerequisites

Copy the media-orchestrator placeholders from the root `.env.example` into the
real ignored `.env`, replacing every image digest and provider placeholder.
The application images provide their own `media healthcheck` command for
`media-service`. `download-runner` instead uses a process liveness probe
(`kill -0 1`): with `MEDIA_RUNNER_EXIT_AFTER_JOB=true` and `restart: "no"`, an
exited container after a finished attempt is expected — do not treat that as a
broken Watcher path. `gluetun-rezka-watcher` healthchecks the `docker events`
loop (same pattern as `download/gluetun-watcher`). The four `homelab_*` media
named volumes are declared external because they hold live data; create or
restore them before first boot and never remove them during a normal recreate. Create the external networks used by
Media Orchestrator once:

```bash
docker network create media-internal
```

Create the host paths before starting. Staging remains outside Plex roots, but
all Rezka paths stay on the same filesystem for atomic publication:

```bash
install -d -m 0750 \
  "${INTERNAL_STORAGE}/media-orchestrator/staging/rezka" \
  "${INTERNAL_STORAGE}/media/rezka/tv" \
  "${INTERNAL_STORAGE}/media/rezka/movies"
install -d -m 0700 "${MEDIA_SECRETS_DIR}"
```

Non-secret settings (images, Rezka mirrors and session markers, Plex section
IDs, qBittorrent categories and username) come from the real ignored root
`.env`. Every credential is a file in `${MEDIA_SECRETS_DIR}`, mode `0600`,
declared in `compose.media-orchestrator.yml`:

```text
gluetun_rezka_wireguard_private_key
gluetun_rezka_control_auth_config
gluetun_rezka_control_api_key
media_database_url
media_postgres_password
media_primary_token
media_secondary_token
media_runner_token
media_lifecycle_token
media_primary_webhook_hmac
media_secondary_webhook_hmac
media_prowlarr_api_key
media_tmdb_api_key
media_plex_token
media_qbittorrent_password
rezka_cookie_key
```

`MEDIA_PRIMARY_TOKEN_PATH`, `MEDIA_SECONDARY_TOKEN_PATH` and the two
`*_WEBHOOK_HMAC_PATH` variables can point those four secrets at another file.
Rezka is always anonymous: the encrypted cookie jar carries only provider
cookies and Anubis clearance.

`media_database_url` uses the private hostname, for example
`postgres://media:<password>@media-postgres:5432/media_orchestrator`.
The primary/secondary tokens and webhook HMAC values must match the values the
Hermes profiles use. `rezka_cookie_key` is base64 for exactly 32 decoded bytes. Generate the
Gluetun API key with `docker run --rm qmcgaw/gluetun:<pinned-version> genkey`.
Write the same value to `gluetun_rezka_control_api_key` and the auth config:

```toml
[[roles]]
name = "download-runner"
routes = ["GET /v1/publicip/ip"]
auth = "apikey"
apikey = "replace-with-generated-key"
```

The control server binds to `127.0.0.1` inside the namespace shared only by
`gluetun-rezka` and `download-runner`; it has no published port or Traefik
route. `HEALTH_RESTART_VPN=off` prevents Gluetun health recovery from changing
the job IP. The runner binds each Rezka job to its initial public IP, checks it
every five seconds and again at completion, and cooperatively stops the attempt
as retryable if the IP changes or cannot be verified. Routine search and
download reuse the current VPN lease and encrypted anonymous cookie jar; only
the watcher performs an explicit rotation after lifecycle enters `rotating`.

The watcher runs `media rezka probe --json` from the immutable runner image with
the application UID/GID in the same Gluetun namespace. The one-shot container
receives only the encrypted session volume, runner API token, and cookie key;
it does not inherit the runner's media mounts or qBittorrent secret. A challenge
page is therefore reported as a failed typed probe, never as a healthy HTTP
status. An unexpected Gluetun restart/recreation that leaves the runner on a dead
network namespace is recovered by Compose `--force-recreate --no-deps` (same
pattern as `download/gluetun-watcher`), even while a sticky lease is still
open — an orphaned netns cannot finish the attempt. Sticky leases still protect
healthy same-namespace IP drift; the watcher does not `docker stop`/`restart`
the runner for ordinary lifecycle gating.

The runner image contains a checksum-pinned Chrome for Testing
`chrome-headless-shell` binary. Anubis browser fallback turns on automatically
when that binary is present; there is no compose toggle to disable it. The
native SHA-256 solver remains the default path and does not launch Chromium.
The service image does not include Chrome. There is no FlareSolverr on the
direct Rezka path, no user Chrome profile, and no extra session volume.
Obscura and Lightpanda stay out of this path: Anubis blocks Lightpanda, and
neither is a real Chromium cookie/JS runtime for `preact` / `metarefresh`.

## Validate

The repository test creates temporary dummy environment values and secret
files, then only renders Compose:

```bash
media/tests/validate-media-orchestrator-compose.sh
tests/gluetun-rezka-watcher-test.sh
shellcheck media/gluetun-rezka-watcher/watch.sh \
  media/tests/validate-media-orchestrator-compose.sh \
  tests/gluetun-rezka-watcher-test.sh
```

For an operator-side render using the real ignored environment and secret files:

```bash
docker compose --env-file .env config --quiet
```

## Start And Operate

Do not run these commands until the images, root environment values, and
secret files are ready. The service talks to Prowlarr directly through
`http://prowlarr:9696`, to qBittorrent through `http://gluetun:8400`, and to
Plex through `http://plex:32400`. Prowlarr stays outside the VPN so indexer
sites see the server address, while qBittorrent remains inside the dedicated
Bulgaria P2P VPN namespace.

`media-service` also acts as the only media-admin facade for Hermes. It receives
qBittorrent and Plex credentials, plus one scoped `/data/internal` bind mount;
Hermes receives none of those directly. Reads are restricted to media roots,
the Docker socket is not mounted, and file mutations move data into
`/data/internal/media-orchestrator/quarantine`.

```bash
docker compose --env-file .env up -d

docker compose --env-file .env ps
```

The existing `gluetun-watcher` in `download/compose.yml` remains paired only
with the torrent Gluetun stack. `gluetun-rezka-watcher` watches only
`gluetun-rezka`. It gates new work before rotation and does not `docker stop`
or `docker restart` an active `download-runner` for ordinary lifecycle changes.
If the runner is orphaned on a previous Gluetun netns after parent restart, the
watcher force-recreates it onto the current namespace promptly. Parent events
are filtered by exact container ID and `exec_start` is ignored. On runner
`die`, the watcher settles briefly and re-reads lifecycle so a late `rotating`
write wins over starting under stale `ready`. Like `gluetun-watcher`, it
bind-mounts `${HOMELAB_ROOT}` at the same absolute path
so in-container `docker compose --project-directory … -f …/compose.yml` can
read the host project tree.

## Solverr

Prowlarr reaches indexers directly from the server. `solverr` (defined in
`download/compose.yml`) exposes a FlareSolverr-compatible `/v1` API on port
8191 for indexers protected by Cloudflare; it has no published port or Traefik
route. In Prowlarr, assign the `cloudflare` tag to both the FlareSolverr proxy
(pointing at `http://solverr:8191`) and only the indexers that need it; other
indexers keep their direct connection. `solverr-crawl` is a separate, lower
priority browser pool for JacRed crawling (see `jacred/README.md`).

Keep `LOG_LEVEL=info`. Debug logging can include indexer request bodies; enable
it only briefly during supervised diagnostics.

## Glance Queue Widget

`glance/config/glance.example.yml` includes a `custom-api` widget ("Media Queue")
that calls `GET http://media-service:8080/v1/queue/status` and renders the
`queued` count and `active` flag from `QueueStatusDto`. It uses the shared `proxy` network to reach the active `media-service`.

No network change is needed on the `glance` side: both `glance/compose.yml`
and this file already declare `proxy` as an `external: true` network, so once
`media-service` is running they resolve each other by container name over
that shared network.

The widget authenticates with `Authorization: Bearer ${MEDIA_STATUS_TOKEN}`,
resolved from the gitignored `glance/.env`. Every token `media-service`
recognizes (`media_primary_token`, `media_secondary_token`,
`media_runner_token`, `media_lifecycle_token`) can change state, and the family
tokens can also run destructive media-admin actions. Do not reuse any of them
in Glance: Glance fetches `custom-api` server-side and does not serve its
config, but a status widget needs only read access (least privilege). Give the
widget a dedicated read-only status token; until `media-service`
offers one, leave `MEDIA_STATUS_TOKEN` at its placeholder and accept that the
widget shows an error.

## Rollback

Do not use `down` for an orchestrator-only rollback because it belongs to the
root project. Restore the previous application image values in `.env`, then
recreate the long-running services:

```bash
docker compose --env-file .env config --quiet
# Only while download-runner is stopped: on a running runner this recreates
# the container and kills the active attempt.
docker compose --env-file .env up --no-start --no-deps download-runner
docker compose --env-file .env up -d \
  media-postgres media-service gluetun-rezka gluetun-rezka-watcher
```

The `--no-start` step moves a stopped runner onto the restored
`DOWNLOAD_RUNNER_IMAGE` without starting it; otherwise the watcher may
`docker start` the old container. Skip it while the runner is running; the
watcher recreates it through Compose whenever `gluetun-rezka` gets a new
namespace. Never name `download-runner` in `up -d` or `docker start` it by
hand: that starts an attempt outside the watcher's lifecycle gate. The watcher
starts the runner when lifecycle is `ready`.

The database, Gluetun, lifecycle, and encrypted-session volumes have explicit
`homelab_*` names. Never delete those volumes during a normal rollback.
