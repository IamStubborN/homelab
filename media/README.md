# Media Orchestrator Scaffold

`compose.media-orchestrator.yml` is intentionally separate from the active
`media/compose.yml`. It cannot affect the running homelab stack until it is
explicitly enabled after immutable application images have been built and
published.

## Prerequisites

Copy the media-orchestrator placeholders from the root `.env.example` into the
real ignored `.env`, replacing every image digest and provider placeholder.
The application images provide their own `media healthcheck` command; no
additional HTTP client is required in the runtime images. Create the external
networks used by this media-orchestrator profile once (the Hermes profiles and
credential broker live in separate deployments):

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
username/password for synchronous service searches, credential broker token and
cookie key, qBittorrent password, and Gluetun control API key. Set
`ANDRII_REZKA_BROKER_TOKEN` to the token configured for
`vaultwarden-broker-andrii`. The static Rezka username/password stay scoped to
`media-service` and are not passed to `download-runner`.

Create only these Gluetun-required secret files with mode `0600`:

```text
gluetun_rezka_wireguard_private_key
gluetun_rezka_control_auth_config
```

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
docker compose --env-file .env \
  -f media/compose.media-orchestrator.yml \
  --profile media-orchestrator config --quiet
```

## Start And Operate

Do not run these commands until the images, root environment values, and two
Gluetun secret files are ready. The service talks to existing Prowlarr and qBittorrent through
`http://gluetun:9696` and `http://gluetun:8400`, and to Plex through
`http://plex:32400`, while remaining outside both VPN namespaces.

```bash
docker compose --env-file .env \
  -f media/compose.media-orchestrator.yml \
  --profile media-orchestrator up -d

docker compose --env-file .env \
  -f media/compose.media-orchestrator.yml \
  --profile media-orchestrator ps
```

The existing `gluetun-watcher` remains paired only with the torrent Gluetun
stack. `gluetun-rezka-watcher` watches only `gluetun-rezka` and restarts only
`download-runner` when that dedicated container is recreated. An in-process VPN
rotation does not restart the runner, preserving one runner job per namespace.

## Glance Queue Widget

`glance/config/glance.example.yml` includes a `custom-api` widget ("Media Queue")
that calls `GET http://media-service:8080/v1/queue/status` and renders the
`queued` count and `active` flag from `QueueStatusDto`. It is wired for the
final topology but stays dark (Glance's own request-failed state) until this
profile is deployed, simply because `media-service` does not exist yet.

No network change is needed on the `glance` side: both `glance/compose.yml`
and this file already declare `proxy` as an `external: true` network, so once
`media-service` is running they resolve each other by container name over
that shared network.

The widget authenticates with `Authorization: Bearer ${MEDIA_STATUS_TOKEN}`,
an env placeholder resolved from the gitignored `glance/.env`. This service
only recognizes the three fixed client tokens configured above
(`MEDIA_ANDRII_TOKEN`, `MEDIA_VALENTYNA_TOKEN`, `MEDIA_RUNNER_TOKEN`) — there
is no dedicated read-only/status client. Set `MEDIA_STATUS_TOKEN` in
`glance/.env` to the same value as one of the existing family tokens (prefer
`MEDIA_ANDRII_TOKEN` or `MEDIA_VALENTYNA_TOKEN`; avoid reusing
`MEDIA_RUNNER_TOKEN`, which is scoped to the download runner) rather than
inventing a new credential.

## Rollback

Stopping this separate project leaves Plex, qBittorrent, Prowlarr, and the
existing Gluetun stack untouched:

```bash
docker compose --env-file .env \
  -f media/compose.media-orchestrator.yml \
  --profile media-orchestrator down
```

Named database, Gluetun, and encrypted session volumes are retained by default.
Never add `--volumes` during normal rollback. To roll back an image release,
restore the previous immutable digest in `.env`, run `config --quiet`, and then
run `up -d` again.
