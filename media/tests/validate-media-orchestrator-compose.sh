#!/bin/sh
# shellcheck disable=SC2016
set -eu

MEDIA_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
COMPOSE_FILE="$MEDIA_DIR/compose.media-orchestrator.yml"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

mkdir -p "$TMP_DIR/secrets"
for secret in \
    gluetun_rezka_wireguard_private_key \
    gluetun_rezka_control_auth_config \
    media_database_url \
    media_andrii_token \
    media_valentyna_token \
    media_runner_token \
    media_lifecycle_token \
    media_andrii_webhook_hmac \
    media_valentyna_webhook_hmac \
    media_prowlarr_api_key \
    media_tmdb_api_key \
    rezka_cookie_key \
    media_plex_token \
    media_qbittorrent_password \
    media_postgres_password \
    andrii_rezka_broker_token
do
    printf 'dummy-%s\n' "$secret" > "$TMP_DIR/secrets/$secret"
done

export INTERNAL_STORAGE="$TMP_DIR/storage"
export TIMEZONE=UTC
export MEDIA_POSTGRES_IMAGE='postgres:17.5-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export MEDIA_SERVICE_IMAGE='ghcr.io/example/media-service:0.1.0@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
export DOWNLOAD_RUNNER_IMAGE='ghcr.io/example/download-runner:0.1.0@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
export GLUETUN_REZKA_IMAGE='qmcgaw/gluetun:v3.41.1@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
export GLUETUN_REZKA_WATCHER_IMAGE='docker:28.3.2-cli@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
export MEDIA_SECRETS_DIR="$TMP_DIR/secrets"
export GLUETUN_REZKA_SERVER_COUNTRIES=Bulgaria
export GLUETUN_REZKA_OUTBOUND_SUBNETS=172.18.0.0/16,172.22.0.0/16,172.29.0.0/16
export MEDIA_REZKA_MIRRORS=https://rezka.example
export MEDIA_REZKA_SESSION_PROBE_URL=https://rezka.example/account/probe
export MEDIA_REZKA_SESSION_VALID_MARKERS_JSON='["account-menu"]'
export MEDIA_REZKA_SESSION_INVALID_MARKERS_JSON='["login-form"]'
export MEDIA_PLEX_TV_SECTION=1
export MEDIA_PLEX_MOVIES_SECTION=2
export MEDIA_QBITTORRENT_TV_CATEGORY=tv
export MEDIA_QBITTORRENT_MOVIES_CATEGORY=movies
export MEDIA_QBITTORRENT_USERNAME=admin
export MT_TMDB_LANGUAGE=ru

docker compose -f "$COMPOSE_FILE" config > "$TMP_DIR/rendered.yml"

assert_yq() {
    expression=$1
    message=$2
    if [ "$(yq -r "$expression" "$TMP_DIR/rendered.yml")" != "true" ]; then
        printf 'FAIL: %s\n' "$message" >&2
        exit 1
    fi
}

assert_yq '.services.media-postgres.environment.POSTGRES_PASSWORD_FILE == "/run/secrets/media_postgres_password" and (.services.media-postgres.environment | has("POSTGRES_PASSWORD") | not)' \
    'PostgreSQL must read its password from a Docker secret file'
assert_yq '.services.media-service.environment.MEDIA_DATABASE_URL_FILE == "/run/secrets/media_database_url"' \
    'media-service must load DATABASE_URL from a secret file'
assert_yq '.services.media-service.environment.MEDIA_ANDRII_TOKEN_FILE == "/run/secrets/media_andrii_token"' \
    'media-service must load andrii token from a secret file'
assert_yq '.services.media-service.environment.MEDIA_TMDB_API_KEY_FILE == "/run/secrets/media_tmdb_api_key"' \
    'media-service must load TMDB key from a secret file'
assert_yq '.services.media-service.environment.MEDIA_REZKA_COOKIE_KEY_FILE == "/run/secrets/rezka_cookie_key"' \
    'media-service must load Rezka cookie key from a secret file'
assert_yq '(.services.media-service.environment | has("MEDIA_REZKA_USERNAME") | not) and (.services.media-service.environment | has("MEDIA_REZKA_PASSWORD") | not) and (.services.media-service.environment | has("MEDIA_REZKA_USERNAME_FILE") | not) and (.services.media-service.environment | has("MEDIA_REZKA_PASSWORD_FILE") | not)' \
    'media-service must not receive static Rezka login credentials'
assert_yq '.services.gluetun-rezka-watcher.environment.MEDIA_LIFECYCLE_TOKEN_FILE == "/run/secrets/media_lifecycle_token"' \
    'watcher must load lifecycle token from a secret file'
assert_yq '.services.download-runner.environment.MEDIA_TOKEN_FILE == "/run/secrets/media_runner_token"' \
    'runner must load token from a secret file'
assert_yq '.services.download-runner.environment.MEDIA_QBITTORRENT_PASSWORD_FILE == "/run/secrets/media_qbittorrent_password"' \
    'runner must load qBittorrent password from a secret file'
assert_yq '.services.download-runner.environment.MEDIA_REZKA_CREDENTIAL_BROKER_URL == "http://vaultwarden-broker-andrii:8787"' \
    'runner must keep the Vaultwarden broker path for Rezka refresh'
assert_yq '.secrets as $secrets | (($secrets | length) == 16 and ($secrets | has("media_database_url")) and ($secrets | has("media_postgres_password")) and ($secrets | has("media_andrii_rezka_broker_token")) and ($secrets | has("media_rezka_username") | not) and ($secrets | has("media_rezka_password") | not))' \
    'compose must declare Docker secrets without static Rezka login files'
assert_yq '.services.media-postgres.networks as $networks | (($networks | length) == 1 and ($networks | has("media-db")))' \
    'PostgreSQL must only join the private database network'
assert_yq '.networks.media-db.internal == true and .networks.media-private.internal == true' \
    'database and application networks must be internal'
assert_yq '.services.download-runner.network_mode == "service:gluetun-rezka"' \
    'runner must exclusively share the dedicated Rezka VPN namespace'
assert_yq '.services.gluetun-rezka.networks | has("rezka-credentials")' \
    'Gluetun namespace must join the Rezka credential broker network'

if ! grep -Fq 'MEDIA_LIFECYCLE_TOKEN_FILE' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: lifecycle watcher must support MEDIA_LIFECYCLE_TOKEN_FILE\n' >&2
    exit 1
fi

printf 'OK: media orchestrator compose validation passed\n'
