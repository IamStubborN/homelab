# Media Orchestrator Scaffold

`compose.media-orchestrator.yml` is intentionally separate from the active
`media/compose.yml`. It cannot affect the running homelab stack until it is
explicitly enabled after immutable application images have been built and
published.

## Prerequisites

Copy the media-orchestrator placeholders from the root `.env.example` into the
real ignored `.env`, replacing every image digest and provider placeholder.
The application images provide their own `media healthcheck` command; no
additional HTTP client is required in the runtime images. Create the shared
external network used by the two Hermes profiles once:

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

Create these secret files with mode `0600`; never commit their values:

```text
media_postgres_password
media_database_url
media_andrii_token
media_valentyna_token
media_runner_token
media_andrii_webhook_hmac
media_valentyna_webhook_hmac
media_prowlarr_api_key
media_qbittorrent_password
media_plex_token
rezka_username
rezka_password
rezka_cookie_key
gluetun_rezka_wireguard_private_key
gluetun_rezka_control_auth_config
gluetun_rezka_control_api_key
```

`media_database_url` uses the private hostname, for example
`postgres://media:<password>@media-postgres:5432/media_orchestrator`.
The two media API tokens and webhook HMAC values must match the corresponding
files in the `hermes-home` deployment. Set the real Plex TV/movie section IDs,
the existing qBittorrent TV and movies categories, and the qBittorrent username
in `.env`.
`rezka_cookie_key` is base64 for exactly 32 decoded bytes. The Gluetun API key
is generated with `docker run --rm qmcgaw/gluetun:<pinned-version> genkey`; put
the same key in `gluetun_rezka_control_api_key` and in the auth config:

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

## Validate

The repository test creates temporary dummy secrets and only renders Compose:

```bash
media/tests/validate-media-orchestrator-compose.sh
shellcheck media/gluetun-rezka-watcher/watch.sh \
  media/tests/validate-media-orchestrator-compose.sh
```

For an operator-side render using the real ignored environment and secret file
paths:

```bash
docker compose --env-file .env \
  -f media/compose.media-orchestrator.yml \
  --profile media-orchestrator config --quiet
```

## Start And Operate

Do not run these commands until the images exist and the secret files are
ready. The service talks to existing Prowlarr and qBittorrent through
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
