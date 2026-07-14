#!/bin/sh
set -eu

ROOT=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)
WATCHER="$ROOT/media/gluetun-watcher/watch.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/docker" <<'EOF'
#!/bin/sh
set -eu

printf '%s\n' "$*" >>"$DOCKER_CALLS"

case "$1" in
    compose)
        exit 0
        ;;
    inspect)
        target=$2
        case "$*" in
            *com.docker.compose.project.config_files*)
                printf '%s\n' '/srv/homelab/compose.yml,/srv/homelab/compose.override.yml'
                ;;
            *com.docker.compose.project.working_dir*)
                printf '%s\n' '/srv/homelab'
                ;;
            *com.docker.compose.project*)
                printf '%s\n' 'homelab'
                ;;
            *State.Health.Status*)
                printf '%s\n' 'healthy'
                ;;
            *State.StartedAt*)
                if [ "$target" = "gluetun" ]; then
                    printf '%s\n' "$PARENT_STARTED"
                else
                    printf '%s\n' "$DEPENDENT_STARTED"
                fi
                ;;
            *State.Status*)
                printf '%s\n' "$DEPENDENT_STATE"
                ;;
        esac
        ;;
    events)
        if [ -n "${DOCKER_EVENTS:-}" ]; then
            printf '%s\n' "$DOCKER_EVENTS"
        fi
        ;;
    restart)
        printf '%s\n' "$2"
        ;;
esac
EOF
chmod +x "$TMP/docker"

run_watcher() {
    : >"$DOCKER_CALLS"
    PATH="$TMP:$PATH" \
        PARENT_CONTAINER=gluetun \
        DEPENDENT_CONTAINERS=qbittorrent \
        HEALTH_TIMEOUT=5 \
        SETTLE_DELAY=0 \
        "$WATCHER" >"$TMP/output" 2>&1
}

DOCKER_CALLS="$TMP/docker-calls"
export DOCKER_CALLS

# An exited dependent with an older network namespace must be recreated.
PARENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STATE='exited'
DOCKER_EVENTS=''
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DOCKER_EVENTS
run_watcher

expected='compose -p homelab --project-directory /srv/homelab -f /srv/homelab/compose.yml -f /srv/homelab/compose.override.yml up -d --force-recreate --no-deps qbittorrent'
if ! grep -Fqx "$expected" "$DOCKER_CALLS"; then
    echo "FAIL: exited stale dependent was not recreated with Compose" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

# Docker health checks emit exec_start events; they are not container starts.
PARENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STATE='running'
DOCKER_EVENTS='exec_start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DOCKER_EVENTS
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS" || grep -Fq 'restart qbittorrent' "$DOCKER_CALLS"; then
    echo "FAIL: exec_start event triggered dependent recovery" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

echo 'PASS: gluetun watcher recovery and event filtering'
