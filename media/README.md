# Media Stack and Orchestrator

## Active Torrent VPN Gateway

The torrent stack uses `qmcgaw/gluetun:latest` with Watchtower updates enabled.
Gluetun selects Proton VPN port-forwarding servers in Bulgaria, and
`qbittorrent-port-sync` applies the current forwarded port to qBittorrent over
its local API without restarting qBittorrent.

Before the first start, create the ignored runtime files with permissions that
allow the unprivileged sync container to read the non-secret forwarded port:

```bash
install -d -m 0755 media/gluetun/data
install -m 0644 /dev/null media/gluetun/data/forwarded_port
install -d -m 0700 media/secrets
install -m 0600 /dev/null media/secrets/protonvpn_wireguard_private_key
install -m 0600 /dev/null media/secrets/gluetun_control_auth_config
install -m 0600 /dev/null media/secrets/gluetun_control_api_key
```

The forwarded-port file is not a credential. The WireGuard private key and
control API credentials must remain mode `0600` and must never be committed.

`compose.media-orchestrator.yml` is included by the root `compose.yml` and is
managed as part of the `homelab` Compose project. Application images must be
built before running a root deployment.

## Prerequisites

Copy the media-orchestrator placeholders from the root `.env.example` into the
real ignored `.env`, replacing every image digest and provider placeholder.
The application images provide their own `media healthcheck` command; no
additional HTTP client is required in the runtime images. Create the external
networks used by Media Orchestrator once (the Hermes services and credential
broker live in a separate deployment):

```bash
docker network create media-internal
docker network create rezka-credentials
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

Set the application credentials in the real ignored root `.env`; never commit
their values. This includes the PostgreSQL password and database URL, all three
API tokens, both webhook HMAC values, the Prowlarr API key, Plex token, Rezka
credential broker token and cookie key, qBittorrent password, and Gluetun
control API key. Set
`ANDRII_REZKA_BROKER_TOKEN` to the token configured for
`vaultwarden-broker-andrii`.

Create these local secret files with mode `0600`:

```text
media_rezka_username
media_rezka_password
gluetun_rezka_wireguard_private_key
gluetun_rezka_control_auth_config
```

The Rezka files are mounted only into `media-service`. It uses them to log in
again automatically whenever the encrypted cookie session expires; Hermes and
`download-runner` never receive the static password, and routine session
renewal does not require Telegram approval.

`MEDIA_DATABASE_URL` uses the private hostname, for example
`postgres://media:<password>@media-postgres:5432/media_orchestrator`.
The two media API tokens and webhook HMAC values must match the corresponding
values in the `hermes-home` deployment. Set the real Plex TV/movie section IDs,
the existing qBittorrent TV and movies categories, and the qBittorrent username
in `.env`.
`MEDIA_REZKA_COOKIE_KEY` is base64 for exactly 32 decoded bytes. The Gluetun API key
is generated with `docker run --rm qmcgaw/gluetun:<pinned-version> genkey`; set
the same key as `GLUETUN_REZKA_CONTROL_API_KEY` in `.env` and in the auth config:

```toml
[[roles]]
name = "download-runner"
routes = ["GET /v1/vpn/status", "PUT /v1/vpn/status", "GET /v1/publicip/ip"]
auth = "apikey"
apikey = "replace-with-generated-key"
```

The control server binds to `127.0.0.1` inside the namespace shared only by
`gluetun-rezka` and `download-runner`; it has no published port or Traefik
route. `HEALTH_RESTART_VPN=off` prevents Gluetun health recovery from changing
the job IP. The runner owns explicit rotation only after a terminal job state.
Because the runner uses `network_mode: service:gluetun-rezka`, the
`gluetun-rezka` service joins the external `rezka-credentials` network on its
behalf. The runner reaches the broker at
`http://vaultwarden-broker-andrii:8787` over that shared network namespace.

## Validate

The repository test creates temporary dummy environment values and the two
required Gluetun secret files, then only renders Compose:

```bash
media/tests/validate-media-orchestrator-compose.sh
shellcheck media/gluetun-rezka-watcher/watch.sh \
  media/tests/validate-media-orchestrator-compose.sh
```

For an operator-side render using the real ignored environment and the two
Gluetun secret file paths:

```bash
docker compose --env-file .env config --quiet
```

## Start And Operate

Do not run these commands until the images, root environment values, and two
Gluetun secret files are ready. The service talks to Prowlarr directly through
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

The existing `gluetun-watcher` remains paired only with the torrent Gluetun
stack. `gluetun-rezka-watcher` watches only `gluetun-rezka` and restarts only
`download-runner` when that dedicated container is recreated. An in-process VPN
rotation does not restart the runner, preserving one runner job per namespace.

## FlareSolverr

Prowlarr reaches indexers directly from the server. The internal-only
`flaresolverr` service is an exception handler for indexers protected by
Cloudflare; it has no published port or Traefik route. In Prowlarr, assign the
`cloudflare` tag to both the FlareSolverr proxy and only the indexers that need
it. RuTracker currently uses this tag, while other indexers continue to use
their normal direct connection.

Keep `LOG_LEVEL=warning` and `LOG_HTML=false`. Debug or HTML logging can include
indexer request bodies and must only be enabled briefly during supervised
diagnostics, then disabled before the container is recreated.

## Glance Queue Widget

`glance/config/glance.example.yml` includes a `custom-api` widget ("Media Queue")
that calls `GET http://media-service:8080/v1/queue/status` and renders the
`queued` count and `active` flag from `QueueStatusDto`. It uses the shared `proxy` network to reach the active `media-service`.

No network change is needed on the `glance` side: both `glance/compose.yml`
and this file already declare `proxy` as an `external: true` network, so once
`media-service` is running they resolve each other by container name over
that shared network.

The widget authenticates with `Authorization: Bearer ${MEDIA_STATUS_TOKEN}`,
an env placeholder resolved from the gitignored `glance/.env`. This service
only recognizes the three fixed client tokens configured above
(`MEDIA_ANDRII_TOKEN`, `MEDIA_VALENTYNA_TOKEN`, `MEDIA_RUNNER_TOKEN`,
`MEDIA_LIFECYCLE_TOKEN`) — there
is no dedicated read-only/status client. Set `MEDIA_STATUS_TOKEN` in
`glance/.env` to the same value as one of the existing family tokens (prefer
`MEDIA_ANDRII_TOKEN` or `MEDIA_VALENTYNA_TOKEN`; avoid reusing
`MEDIA_RUNNER_TOKEN`, which is scoped to the download runner) rather than
inventing a new credential.

## Rollback

Do not use `down` for an orchestrator-only rollback because it belongs to the
root project. Restore the previous application image values in `.env`, then
recreate only its long-running services:

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d \
  media-postgres media-service gluetun-rezka download-runner gluetun-rezka-watcher
```

The database, Gluetun, lifecycle, and encrypted-session volumes have explicit
`media-orchestrator_*` names so the root-project migration preserves existing
data. Never delete those volumes during a normal rollback.
