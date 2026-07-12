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
    gluetun_rezka_control_auth_config
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
export MEDIA_POSTGRES_PASSWORD=dummy-postgres-password
export MEDIA_DATABASE_URL=postgres://media:dummy-postgres-password@media-postgres:5432/media_orchestrator
export MEDIA_ANDRII_TOKEN=dummy-andrii-token
export MEDIA_VALENTYNA_TOKEN=dummy-valentyna-token
export MEDIA_RUNNER_TOKEN=dummy-runner-token
export MEDIA_ANDRII_WEBHOOK_HMAC=dummy-andrii-webhook-hmac
export MEDIA_VALENTYNA_WEBHOOK_HMAC=dummy-valentyna-webhook-hmac
export MEDIA_PROWLARR_API_KEY=dummy-prowlarr-api-key
export MEDIA_PLEX_TOKEN=dummy-plex-token
export GLUETUN_REZKA_SERVER_COUNTRIES=Bulgaria
export GLUETUN_REZKA_CONTROL_API_KEY=dummy-gluetun-api-key
export MEDIA_REZKA_MIRRORS=https://rezka.example
export MEDIA_REZKA_SESSION_PROBE_URL=https://rezka.example/account/probe
export MEDIA_REZKA_SESSION_VALID_MARKERS_JSON='["account-menu"]'
export MEDIA_REZKA_SESSION_INVALID_MARKERS_JSON='["login-form"]'
export MEDIA_PLEX_TV_SECTION=1
export MEDIA_PLEX_MOVIES_SECTION=2
export MEDIA_QBITTORRENT_TV_CATEGORY=tv
export MEDIA_QBITTORRENT_MOVIES_CATEGORY=movies
export MEDIA_QBITTORRENT_USERNAME=admin
export MEDIA_QBITTORRENT_PASSWORD=dummy-qbittorrent-password
export MEDIA_REZKA_USERNAME=dummy-rezka-username
export MEDIA_REZKA_PASSWORD=dummy-rezka-password
export ANDRII_REZKA_BROKER_TOKEN=dummy-rezka-broker-token
export MEDIA_REZKA_COOKIE_KEY=ZHVtbXktMzItYnl0ZS1yZXprYS1jb29raWUta2V5ISE=

docker compose -f "$COMPOSE_FILE" --profile media-orchestrator config > "$TMP_DIR/rendered.yml"

assert_yq() {
    expression=$1
    message=$2
    if [ "$(yq -r "$expression" "$TMP_DIR/rendered.yml")" != "true" ]; then
        printf 'FAIL: %s\n' "$message" >&2
        exit 1
    fi
}

assert_file_contains() {
    file=$1
    pattern=$2
    message=$3
    if ! grep -Fq "$pattern" "$file"; then
        printf 'FAIL: %s\n' "$message" >&2
        exit 1
    fi
}

assert_file_not_contains() {
    file=$1
    pattern=$2
    message=$3
    if grep -Fq "$pattern" "$file"; then
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
assert_yq '.services.media-service.environment.MEDIA_ANDRII_WEBHOOK_HMAC == "dummy-andrii-webhook-hmac" and .services.media-service.environment.MEDIA_VALENTYNA_WEBHOOK_HMAC == "dummy-valentyna-webhook-hmac"' \
    'media-service must sign notifications for both Hermes profiles'
assert_yq '.services.media-postgres.environment.POSTGRES_PASSWORD == "dummy-postgres-password" and (.services.media-postgres.environment | has("POSTGRES_PASSWORD_FILE") | not)' \
    'PostgreSQL must receive its password directly from the root environment'
assert_yq '.services.media-service.environment as $env | ($env.MEDIA_DATABASE_URL != null and $env.MEDIA_ANDRII_TOKEN != null and $env.MEDIA_VALENTYNA_TOKEN != null and $env.MEDIA_RUNNER_TOKEN != null and $env.MEDIA_PROWLARR_API_KEY != null and $env.MEDIA_PLEX_TOKEN != null and $env.MEDIA_REZKA_USERNAME == "dummy-rezka-username" and $env.MEDIA_REZKA_PASSWORD == "dummy-rezka-password" and $env.MEDIA_REZKA_COOKIE_KEY != null and ($env | has("MEDIA_DATABASE_URL_FILE") | not) and ($env | has("MEDIA_ANDRII_TOKEN_FILE") | not) and ($env | has("MEDIA_VALENTYNA_TOKEN_FILE") | not) and ($env | has("MEDIA_RUNNER_TOKEN_FILE") | not) and ($env | has("MEDIA_PROWLARR_API_KEY_FILE") | not) and ($env | has("MEDIA_PLEX_TOKEN_FILE") | not) and ($env | has("MEDIA_REZKA_USERNAME_FILE") | not) and ($env | has("MEDIA_REZKA_PASSWORD_FILE") | not) and ($env | has("MEDIA_REZKA_COOKIE_KEY_FILE") | not))' \
    'media-service must receive application secrets directly from the root environment'
assert_yq '.services.media-service.environment.MEDIA_REZKA_SESSION_STORE_FILE == "/var/lib/media-orchestrator/session/session.bin" and (.services.media-service.volumes | any_c(.source == "rezka_service_session_encrypted" and .target == "/var/lib/media-orchestrator/session"))' \
    'media-service must have its own encrypted Rezka search session'
assert_yq '.services.media-session-init.restart == "no" and (.services.media-session-init.cap_add | contains(["CHOWN"]))' \
    'session volumes must be initialized for the non-root runtime user'
assert_yq '.services.media-migrate.user == "1000:1000" and .services.media-service.user == "1000:1000" and .services.download-runner.user == "1000:1000"' \
    'application containers must use the homelab secret and storage owner'
assert_yq '.services.media-service.healthcheck.test | join(" ") == "CMD media healthcheck --url http://127.0.0.1:8080/v1/ready"' \
    'media-service healthcheck must use the bundled media binary'
assert_yq '.services.download-runner.network_mode == "service:gluetun-rezka"' \
    'runner must exclusively share the dedicated Rezka VPN namespace'
assert_yq '.services.download-runner.environment | has("MEDIA_DATABASE_URL") | not' \
    'runner must not receive a database connection or secret'
assert_yq '.services.download-runner.devices | any_c(.source == "/dev/dri" and .target == "/dev/dri")' \
    'runner must receive VAAPI devices'
assert_yq '.services.gluetun-rezka.ports == null and .services.gluetun-rezka.environment.HTTP_CONTROL_SERVER_ADDRESS == "127.0.0.1:8000"' \
    'Gluetun control API must remain private to the shared namespace'
assert_yq '.services.gluetun-rezka.cap_add | contains(["NET_ADMIN", "DAC_READ_SEARCH"])' \
    'Gluetun must read strict host secrets after dropping all capabilities'
assert_yq '.services.gluetun-rezka.networks | has("rezka-credentials")' \
    'Gluetun namespace must join the Rezka credential broker network'
assert_yq '.networks."rezka-credentials".external == true and .networks."rezka-credentials".name == "rezka-credentials"' \
    'Rezka credential broker network must use the fixed external network name'
assert_yq '.services.gluetun-rezka-watcher.environment.PARENT_CONTAINER == "gluetun-rezka" and .services.gluetun-rezka-watcher.environment.DEPENDENT_CONTAINER == "download-runner"' \
    'dedicated watcher must only pair the Rezka VPN and runner'
assert_yq '.services.download-runner.restart == "no" and .services.download-runner.environment.MEDIA_RUNNER_EXIT_AFTER_JOB == "true"' \
    'runner must process one job and remain stopped until the lifecycle watcher rotates VPN'
assert_yq '.services.gluetun-rezka-watcher.environment.ROTATION_ATTEMPTS == "3" and .services.gluetun-rezka-watcher.environment.STATE_DIR == "/state" and ((.services.gluetun-rezka-watcher.volumes | map(select(.target == "/state" and .source == "gluetun_rezka_lifecycle")) | length) == 1)' \
    'lifecycle watcher must bound rotations and persist non-secret rotation evidence'
assert_file_contains 'media/gluetun-rezka-watcher/watch.sh' 'cat /tmp/gluetun/ip' \
    'lifecycle watcher must use Gluetun public-IP state instead of a single external HTTPS dependency'
assert_file_not_contains 'media/gluetun-rezka-watcher/watch.sh' 'api.ipify.org' \
    'lifecycle watcher must not depend on the unavailable api.ipify.org endpoint'
assert_yq '.services.download-runner.environment.MEDIA_STORAGE_RESERVE_BYTES == "21474836480"' \
    'runner must preserve the 20 GiB free-space reserve'
assert_yq '.services.download-runner.environment.MEDIA_STAGING_ROOT == "/data/internal/media-orchestrator/staging/rezka" and .services.download-runner.environment.MEDIA_TV_ROOT == "/data/internal/media/rezka/tv" and .services.download-runner.environment.MEDIA_MOVIES_ROOT == "/data/internal/media/rezka/movies"' \
    'staging must remain outside the Plex roots on the shared storage mount'
assert_yq '.services.download-runner.environment.MEDIA_QBITTORRENT_URL == "http://gluetun:8400" and .services.download-runner.environment.MEDIA_QBITTORRENT_TV_CATEGORY == "tv" and .services.download-runner.environment.MEDIA_QBITTORRENT_MOVIES_CATEGORY == "movies" and .services.download-runner.environment.MEDIA_QBITTORRENT_USERNAME != null' \
    'runner must receive qBittorrent connection and category configuration'
assert_yq '.services.download-runner.environment as $env | ($env.MEDIA_TOKEN == "dummy-runner-token" and $env.MEDIA_QBITTORRENT_PASSWORD == "dummy-qbittorrent-password" and $env.MEDIA_REZKA_CREDENTIAL_BROKER_URL == "http://vaultwarden-broker-andrii:8787" and $env.MEDIA_REZKA_CREDENTIAL_BROKER_TOKEN == "dummy-rezka-broker-token" and $env.MEDIA_REZKA_CREDENTIAL_BROKER_PRIVATE_HTTP_HOSTS == "vaultwarden-broker-andrii" and $env.MEDIA_REZKA_COOKIE_KEY != null and ($env | has("MEDIA_TOKEN_FILE") | not) and ($env | has("MEDIA_QBITTORRENT_PASSWORD_FILE") | not) and ($env | has("MEDIA_REZKA_USERNAME") | not) and ($env | has("MEDIA_REZKA_PASSWORD") | not) and ($env | has("MEDIA_REZKA_USERNAME_FILE") | not) and ($env | has("MEDIA_REZKA_PASSWORD_FILE") | not) and ($env | has("MEDIA_REZKA_COOKIE_KEY_FILE") | not) and ($env | has("MEDIA_GLUETUN_URL") | not) and ($env | has("MEDIA_GLUETUN_API_KEY") | not) and ($env | has("MEDIA_GLUETUN_API_KEY_FILE") | not))' \
    'runner must receive application secrets directly from the root environment'
assert_yq '.secrets as $secrets | (($secrets | length) == 2 and ($secrets | has("gluetun_rezka_control_auth_config")) and ($secrets | has("gluetun_rezka_wireguard_private_key")))' \
    'only Gluetun-required top-level file secrets may remain'
assert_yq '.services.gluetun-rezka.secrets as $secrets | (($secrets | length) == 2 and ($secrets | map(.source) | contains(["gluetun_rezka_control_auth_config", "gluetun_rezka_wireguard_private_key"])))' \
    'only Gluetun-required secret mounts may remain'
assert_yq '.services.download-runner.healthcheck.test | join(" ") == "CMD media healthcheck --url http://media-service:8080/v1/health"' \
    'runner healthcheck must use the bundled media binary'
assert_yq '.services.download-runner.volumes | any_c(.source == "rezka_session_encrypted" and .target == "/var/lib/media-orchestrator/session")' \
    'runner must persist its encrypted Rezka session in a dedicated volume'

for service in media-postgres media-session-init media-migrate media-service gluetun-rezka download-runner gluetun-rezka-watcher; do
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
