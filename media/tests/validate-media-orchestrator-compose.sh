#!/bin/sh
# shellcheck disable=SC2016
set -eu

MEDIA_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
COMPOSE_FILE="$MEDIA_DIR/compose.media-orchestrator.yml"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

mkdir -p "$TMP_DIR/secrets"
for secret in \
    media_postgres_password \
    media_database_url \
    media_andrii_token \
    media_valentyna_token \
    media_runner_token \
    media_prowlarr_api_key \
    media_qbittorrent_password \
    media_plex_token \
    media_andrii_webhook_hmac \
    media_valentyna_webhook_hmac \
    rezka_username \
    rezka_password \
    rezka_cookie_key \
    gluetun_rezka_wireguard_private_key \
    gluetun_rezka_control_auth_config \
    gluetun_rezka_control_api_key
do
    printf 'dummy-%s\n' "$secret" > "$TMP_DIR/secrets/$secret"
done

export INTERNAL_STORAGE="$TMP_DIR/storage"
export TIMEZONE=UTC
export MEDIA_POSTGRES_IMAGE='postgres:17.5-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export MEDIA_SERVICE_IMAGE='ghcr.io/example/media-service:0.1.0@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
export DOWNLOAD_RUNNER_IMAGE='ghcr.io/example/download-runner:0.1.0@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
export GLUETUN_REZKA_IMAGE='qmcgaw/gluetun:v3.40.0@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
export GLUETUN_REZKA_WATCHER_IMAGE='docker:28.3.2-cli@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
export MEDIA_SECRETS_DIR="$TMP_DIR/secrets"
export GLUETUN_REZKA_SERVER_COUNTRIES=Bulgaria
export MEDIA_REZKA_MIRRORS=https://rezka.example
export MEDIA_REZKA_SESSION_PROBE_URL=https://rezka.example/account/probe
export MEDIA_REZKA_SESSION_VALID_MARKERS_JSON='["account-menu"]'
export MEDIA_REZKA_SESSION_INVALID_MARKERS_JSON='["login-form"]'
export MEDIA_PLEX_TV_SECTION=1
export MEDIA_PLEX_MOVIES_SECTION=2
export MEDIA_QBITTORRENT_CATEGORY=tv
export MEDIA_QBITTORRENT_USERNAME=admin

docker compose -f "$COMPOSE_FILE" --profile media-orchestrator config > "$TMP_DIR/rendered.yml"

assert_yq() {
    expression=$1
    message=$2
    if [ "$(yq -r "$expression" "$TMP_DIR/rendered.yml")" != "true" ]; then
        printf 'FAIL: %s\n' "$message" >&2
        exit 1
    fi
}

assert_yq '.services.media-postgres.networks as $networks | (($networks | length) == 1 and ($networks | has("media-db")))' \
    'PostgreSQL must only join the private database network'
assert_yq '.networks.media-db.internal == true and .networks.media-private.internal == true' \
    'database and application networks must be internal'
assert_yq '.services.media-service.networks as $networks | (($networks | has("proxy")) and ($networks | has("media-db")) and ($networks | has("media-private")))' \
    'media-service must reach existing media services and its private dependencies'
assert_yq '.services.media-service as $service | (($service | has("ports") | not) and $service.labels."traefik.enable" == "false")' \
    'media-service must not have public ports or Traefik exposure'
assert_yq '.services.media-service.networks | has("media-internal")' \
    'media-service must join the shared Hermes media network'
assert_yq '.services.media-service.environment.MEDIA_ANDRII_WEBHOOK_HMAC_FILE == "/run/secrets/media_andrii_webhook_hmac" and .services.media-service.environment.MEDIA_VALENTYNA_WEBHOOK_HMAC_FILE == "/run/secrets/media_valentyna_webhook_hmac"' \
    'media-service must sign notifications for both Hermes profiles'
assert_yq '.services.media-service.environment.MEDIA_REZKA_SESSION_STORE_FILE == "/var/lib/media-orchestrator/session/session.bin" and (.services.media-service.volumes | any_c(.source == "rezka_service_session_encrypted" and .target == "/var/lib/media-orchestrator/session"))' \
    'media-service must have its own encrypted Rezka search session'
assert_yq '.services.media-service.healthcheck.test | join(" ") == "CMD media healthcheck --url http://127.0.0.1:8080/v1/ready"' \
    'media-service healthcheck must use the bundled media binary'
assert_yq '.services.download-runner.network_mode == "service:gluetun-rezka"' \
    'runner must exclusively share the dedicated Rezka VPN namespace'
assert_yq '.services.download-runner as $runner | (($runner.environment | has("MEDIA_DATABASE_URL_FILE") | not) and ($runner.secrets | map(.source) | contains(["media_database_url"]) | not))' \
    'runner must not receive a database connection or secret'
assert_yq '.services.download-runner.devices | any_c(.source == "/dev/dri" and .target == "/dev/dri")' \
    'runner must receive VAAPI devices'
assert_yq '.services.gluetun-rezka.ports == null and .services.gluetun-rezka.environment.HTTP_CONTROL_SERVER_ADDRESS == "127.0.0.1:8000"' \
    'Gluetun control API must remain private to the shared namespace'
assert_yq '.services.gluetun-rezka-watcher.environment.PARENT_CONTAINER == "gluetun-rezka" and .services.gluetun-rezka-watcher.environment.DEPENDENT_CONTAINER == "download-runner"' \
    'dedicated watcher must only pair the Rezka VPN and runner'
assert_yq '.services.download-runner.environment.MEDIA_STORAGE_RESERVE_BYTES == "21474836480"' \
    'runner must preserve the 20 GiB free-space reserve'
assert_yq '.services.download-runner.environment.MEDIA_STAGING_ROOT == "/data/internal/media-orchestrator/staging/rezka" and .services.download-runner.environment.MEDIA_TV_ROOT == "/data/internal/media/rezka/tv" and .services.download-runner.environment.MEDIA_MOVIES_ROOT == "/data/internal/media/rezka/movies"' \
    'staging must remain outside the Plex roots on the shared storage mount'
assert_yq '.services.download-runner.environment.MEDIA_QBITTORRENT_URL == "http://gluetun:8400" and .services.download-runner.environment.MEDIA_QBITTORRENT_CATEGORY != null and .services.download-runner.environment.MEDIA_QBITTORRENT_USERNAME != null' \
    'runner must receive qBittorrent connection and category configuration'
assert_yq '.services.download-runner.environment.MEDIA_GLUETUN_URL == "http://127.0.0.1:8000" and .services.download-runner.environment.MEDIA_GLUETUN_API_KEY_FILE == "/run/secrets/gluetun_rezka_control_api_key"' \
    'runner must use the typed Gluetun control configuration'
assert_yq '.services.download-runner.healthcheck.test | join(" ") == "CMD media healthcheck --url http://media-service:8080/v1/health"' \
    'runner healthcheck must use the bundled media binary'
assert_yq '.services.download-runner.volumes | any_c(.source == "rezka_session_encrypted" and .target == "/var/lib/media-orchestrator/session")' \
    'runner must persist its encrypted Rezka session in a dedicated volume'

for service in media-postgres media-migrate media-service gluetun-rezka download-runner gluetun-rezka-watcher; do
    image=$(yq -r ".services.\"$service\".image" "$TMP_DIR/rendered.yml")
    if ! printf '%s\n' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
        printf 'FAIL: %s image is not pinned by sha256 digest: %s\n' "$service" "$image" >&2
        exit 1
    fi
done

if grep -Fq 'gluetun-watcher' "$COMPOSE_FILE"; then
    printf 'FAIL: scaffold must not modify or reuse the torrent VPN watcher\n' >&2
    exit 1
fi

printf 'media-orchestrator compose validation passed\n'
