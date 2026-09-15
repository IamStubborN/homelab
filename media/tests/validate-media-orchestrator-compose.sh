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
    gluetun_rezka_control_api_key \
    media_database_url \
    media_primary_token \
    media_secondary_token \
    media_runner_token \
    media_lifecycle_token \
    media_primary_webhook_hmac \
    media_secondary_webhook_hmac \
    media_prowlarr_api_key \
    media_tmdb_api_key \
    rezka_cookie_key \
    media_plex_token \
    media_qbittorrent_password \
    media_postgres_password
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
export PUID=1000
export PGID=1000
export DOCKER_SOCKET_GID=990
export GLUETUN_REZKA_SERVER_COUNTRIES=Bulgaria
export GLUETUN_REZKA_OUTBOUND_SUBNETS=192.0.2.12/16
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
assert_yq '.services.media-service.environment.MEDIA_PRIMARY_TOKEN_FILE == "/run/secrets/media_primary_token"' \
    'media-service must load primary token from a secret file'
assert_yq '.services.media-service.environment.MEDIA_TMDB_API_KEY_FILE == "/run/secrets/media_tmdb_api_key"' \
    'media-service must load TMDB key from a secret file'
assert_yq '.services.media-service.environment.MEDIA_REZKA_COOKIE_KEY_FILE == "/run/secrets/rezka_cookie_key"' \
    'media-service must load Rezka cookie key from a secret file'
assert_yq '(.services.media-session-init.entrypoint | join(" ") == "/bin/sh") and (.services.media-session-init.command | join(" ") == "/prepare-session.sh") and .services.media-session-init.environment.SESSION_UID == "1000" and .services.media-session-init.environment.SESSION_GID == "1000"' \
    'session init must run the targeted ownership preparation script with the application UID/GID'
assert_yq '.services.media-session-init.volumes | any_c(.target == "/prepare-session.sh" and .read_only == true)' \
    'session init must mount its preparation script read-only'
assert_yq '(.services.media-service.environment | has("MEDIA_REZKA_USERNAME") | not) and (.services.media-service.environment | has("MEDIA_REZKA_PASSWORD") | not) and (.services.media-service.environment | has("MEDIA_REZKA_USERNAME_FILE") | not) and (.services.media-service.environment | has("MEDIA_REZKA_PASSWORD_FILE") | not)' \
    'media-service must not receive static Rezka login credentials'
assert_yq '.services.gluetun-rezka-watcher.environment.MEDIA_LIFECYCLE_TOKEN_FILE == "/run/secrets/media_lifecycle_token"' \
    'watcher must load lifecycle token from a secret file'
assert_yq '.services.gluetun-rezka-watcher.user == "1000:1000" and ((.services.gluetun-rezka-watcher.group_add | length) == 1) and .services.gluetun-rezka-watcher.group_add[0] == "990"' \
    'watcher must use the application UID and host Docker socket group'
assert_yq '.services.download-runner.environment.MEDIA_TOKEN_FILE == "/run/secrets/media_runner_token"' \
    'runner must load token from a secret file'
assert_yq '.services.download-runner.environment.MEDIA_QBITTORRENT_PASSWORD_FILE == "/run/secrets/media_qbittorrent_password"' \
    'runner must load qBittorrent password from a secret file'
assert_yq '.services.download-runner.environment.MEDIA_GLUETUN_URL == "http://127.0.0.1:8000" and .services.download-runner.environment.MEDIA_GLUETUN_API_KEY_FILE == "/run/secrets/gluetun_rezka_control_api_key"' \
    'runner must bind active Rezka jobs to the dedicated Gluetun public IP'
assert_yq '(.services.download-runner.environment | has("MEDIA_REZKA_CREDENTIAL_BROKER_URL") | not) and (.services.download-runner.environment | has("MEDIA_REZKA_CREDENTIAL_BROKER_TOKEN_FILE") | not)' \
    'runner must not expose a Vaultwarden Rezka credential broker'
assert_yq '(.services.download-runner.environment | has("MEDIA_REZKA_BROWSER_FALLBACK") | not) and (.services.download-runner.environment | has("MEDIA_REZKA_CHROMIUM_BIN") | not)' \
    'download-runner must not take Anubis browser toggle env; chrome-headless-shell is automatic'
assert_yq '(.services.media-service.environment | has("MEDIA_REZKA_BROWSER_FALLBACK") | not) and (.services.media-service.environment | has("MEDIA_REZKA_CHROMIUM_BIN") | not)' \
    'media-service must not take Anubis browser env'
assert_yq '(.services.gluetun-rezka-watcher.environment | has("MEDIA_REZKA_BROWSER_FALLBACK") | not) and (.services.gluetun-rezka-watcher.environment | has("MEDIA_REZKA_CHROMIUM_BIN") | not)' \
    'watcher must not take Anubis browser toggle env; the runner image enables chrome automatically'
assert_yq '.services.download-runner.volumes | any_c(.target == "/var/lib/media-orchestrator/session" and .volume.nocopy == true) and .services.media-service.volumes | any_c(.target == "/var/lib/media-orchestrator/session" and .volume.nocopy == true)' \
    'encrypted session volume must remain nocopy on service and runner'
assert_yq '.volumes.rezka_session_encrypted.name == "homelab_rezka_session_encrypted" and (.volumes.rezka_session_encrypted.external | not)' \
    'encrypted session volume must use the homelab project volume'
assert_yq '((.services.download-runner.volumes | length) == 2) and (.services.download-runner.volumes | any_c(.target == "/data/internal")) and (.services.download-runner.volumes | any_c(.target == "/var/lib/media-orchestrator/session"))' \
    'download-runner must not persist a Chrome profile volume'
assert_yq '.services.download-runner.tmpfs | any_c(. == "/tmp:size=1g,mode=1777")' \
    'download-runner must keep its /tmp tmpfs for chrome-headless-shell'
assert_yq '.services.download-runner.shm_size == 268435456 or .services.download-runner.shm_size == "256mb" or .services.download-runner.shm_size == "256m"' \
    'download-runner must raise /dev/shm above Docker default 64m'
assert_yq '.services.gluetun-rezka-watcher.environment.REZKA_PROBE_IMAGE == env(DOWNLOAD_RUNNER_IMAGE)' \
    'watcher must probe with the immutable runner image'
assert_yq '.services.gluetun-rezka-watcher.environment.PROBE_UID == "1000" and .services.gluetun-rezka-watcher.environment.PROBE_GID == "1000"' \
    'watcher probe must use the session owner UID/GID'
assert_yq '.services.gluetun-rezka-watcher.environment.MEDIA_REZKA_PROXY_URL == "http://127.0.0.1:8888"' \
    'watcher probe must use Gluetun HTTP proxy inside the shared network namespace'
assert_yq '(.services.gluetun-rezka-watcher.secrets | length) == 1 and .services.gluetun-rezka-watcher.secrets[0].source == "media_lifecycle_token"' \
    'watcher itself must receive only the lifecycle secret'
assert_yq '.services.gluetun-rezka-watcher.volumes | any_c(.type == "bind" and .source == "/opt/homelab" and .target == "/opt/homelab" and .read_only == true)' \
    'watcher must bind-mount HOMELAB_ROOT so Compose recreate can read project files'
assert_yq '.secrets as $secrets | (($secrets | length) == 16 and ($secrets | has("media_database_url")) and ($secrets | has("media_postgres_password")) and ($secrets | has("gluetun_rezka_control_api_key")) and ($secrets | has("media_primary_rezka_broker_token") | not) and ($secrets | has("media_rezka_username") | not) and ($secrets | has("media_rezka_password") | not))' \
    'compose must declare anonymous-session secrets without broker credentials'
assert_yq '.services["media-postgres"].labels["com.centurylinklabs.watchtower.enable"] == "true" and .services["media-postgres"].labels["com.centurylinklabs.watchtower.monitor-only"] == null' \
    'media-postgres must be Watchtower-enabled without monitor-only'
assert_yq '.services.media-postgres.networks as $networks | (($networks | length) == 1 and ($networks | has("media-db")))' \
    'PostgreSQL must only join the private database network'
assert_yq '.networks.media-db.internal == true and .networks.media-private.internal == true' \
    'database and application networks must be internal'
assert_yq '.services["media-service"].labels["com.centurylinklabs.watchtower.enable"] == "false"' \
    'media-service must opt out of Watchtower'
assert_yq '.services["media-migrate"].labels["com.centurylinklabs.watchtower.enable"] == "false"' \
    'media-migrate must opt out of Watchtower'
assert_yq '.services["media-session-init"].labels["com.centurylinklabs.watchtower.enable"] == "false"' \
    'media-session-init must opt out of Watchtower'
assert_yq '.services["download-runner"].labels["com.centurylinklabs.watchtower.enable"] == "false"' \
    'download-runner must opt out of Watchtower'
assert_yq '.services["gluetun-rezka"].labels["com.centurylinklabs.watchtower.enable"] == "false"' \
    'gluetun-rezka must opt out of Watchtower'
assert_yq '.services["gluetun-rezka-watcher"].labels["com.centurylinklabs.watchtower.enable"] == "false"' \
    'gluetun-rezka-watcher must opt out of Watchtower'
assert_yq '.services.download-runner.network_mode == "service:gluetun-rezka"' \
    'runner must exclusively share the dedicated Rezka VPN namespace'
assert_yq '(.services.gluetun-rezka.networks | has("rezka-credentials") | not)' \
    'Gluetun namespace must not join a Rezka credential broker network'

if ! grep -Fq 'MEDIA_LIFECYCLE_TOKEN_FILE' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: lifecycle watcher must support MEDIA_LIFECYCLE_TOKEN_FILE\n' >&2
    exit 1
fi

if ! grep -Fq 'rezka probe --json' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || grep -Fq 'REZKA_PROBE_URL' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must use the typed runner probe, not a raw HTML URL check\n' >&2
    exit 1
fi

if WATCHER_PROBE_CONTRACT_TEST=1 \
    WATCHER_PROBE_OUTPUT='{"category":"AnubisChallengeRequired"}' \
    sh "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must reject a typed Anubis challenge outcome\n' >&2
    exit 1
fi
if ! WATCHER_PROBE_CONTRACT_TEST=1 \
    WATCHER_PROBE_OUTPUT='{"category":"RezkaReachable"}' \
    sh "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must accept only the typed reachable outcome\n' >&2
    exit 1
fi
if ! WATCHER_SKIP_PROBE_CONTRACT_TEST=1 \
    WATCHER_LIFECYCLE_STATE=ready \
    WATCHER_LIFECYCLE_IP=203.0.113.10 \
    WATCHER_PUBLIC_IP=203.0.113.10 \
    sh "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must skip the Rezka probe when ready on the same public IP\n' >&2
    exit 1
fi
if WATCHER_SKIP_PROBE_CONTRACT_TEST=1 \
    WATCHER_LIFECYCLE_STATE=ready \
    WATCHER_LIFECYCLE_IP=203.0.113.10 \
    WATCHER_PUBLIC_IP=198.51.100.20 \
    sh "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must probe Rezka when the public IP changed\n' >&2
    exit 1
fi
if WATCHER_SKIP_PROBE_CONTRACT_TEST=1 \
    WATCHER_LIFECYCLE_STATE=rotating \
    WATCHER_LIFECYCLE_IP=203.0.113.10 \
    WATCHER_PUBLIC_IP=203.0.113.10 \
    sh "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must probe Rezka when lifecycle is not ready\n' >&2
    exit 1
fi
if WATCHER_SKIP_PROBE_CONTRACT_TEST=1 \
    WATCHER_LIFECYCLE_STATE=ready \
    WATCHER_LIFECYCLE_IP= \
    WATCHER_PUBLIC_IP=203.0.113.10 \
    sh "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must probe Rezka when the lifecycle IP is missing\n' >&2
    exit 1
fi
if WATCHER_STARTUP_IP_CONTRACT_TEST=1 \
    WATCHER_LIFECYCLE_STATE=ready \
    WATCHER_LIFECYCLE_IP=203.0.113.10 \
    WATCHER_POST_HEALTHY_IP=198.51.100.20 \
    sh "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must probe when the post-healthy IP differs even if the captured IP matched lifecycle\n' >&2
    exit 1
fi
if grep -Fq 'should_skip_rezka_probe "$lifecycle_state" "$lifecycle_ip" "$ROTATION_PREVIOUS_IP"' \
    "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must not skip a Rezka probe using the pre-wait captured IP\n' >&2
    exit 1
fi
for malformed_probe in \
    '{"category":"RezkaReachable","extra":true}' \
    'prefix {"category":"RezkaReachable"}' \
    '{"category":"RezkaReachable"}{"category":"AnubisChallengeRequired"}'
do
    if WATCHER_PROBE_CONTRACT_TEST=1 WATCHER_PROBE_OUTPUT="$malformed_probe" \
        sh "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
        printf 'FAIL: watcher must reject non-canonical probe output\n' >&2
        exit 1
    fi
done
if grep -Eq 'docker (restart|stop) "?\$DEPENDENT"?' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must not stop or restart an active runner during VPN lifecycle handling\n' >&2
    exit 1
fi
if ! grep -Fq 'up -d --force-recreate --no-deps' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq 'refresh_orphaned_dependent' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq 'SandboxKey' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must force-recreate orphaned runners onto the current Gluetun netns\n' >&2
    exit 1
fi
if grep -Fq 'sticky lease must end the attempt retryably' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher must not wait forever on sticky lease for orphaned netns\n' >&2
    exit 1
fi
if grep -Fq -- '--volumes-from' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq -- '--user "$PROBE_UID:$PROBE_GID"' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq -- '--read-only' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq -- '--cap-drop ALL' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq -- '--security-opt no-new-privileges:true' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq -- '-e "MEDIA_REZKA_PROXY_URL=$MEDIA_REZKA_PROXY_URL"' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || grep -Fq 'MEDIA_REZKA_BROWSER_FALLBACK' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || grep -Fq 'MEDIA_REZKA_CHROMIUM_BIN' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq -- '--tmpfs /tmp:rw,nosuid,nodev,exec,size=512m,mode=1777' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq -- '--shm-size 256m' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq 'target=/var/lib/media-orchestrator/session' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq 'target=/run/secrets/media_runner_token,readonly' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh" \
    || ! grep -Fq 'target=/run/secrets/rezka_cookie_key,readonly' "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"; then
    printf 'FAIL: watcher probe must use the application UID, tmpfs, and only its three exact mounts\n' >&2
    exit 1
fi

if ! command -v shellcheck >/dev/null 2>&1; then
    printf 'FAIL: shellcheck is required to validate session init\n' >&2
    exit 1
fi
shellcheck "$MEDIA_DIR/session-init/prepare.sh" "$MEDIA_DIR/gluetun-rezka-watcher/watch.sh"

printf 'OK: media orchestrator compose validation passed\n'
