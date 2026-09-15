#!/bin/sh
set -eu

ROOT=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)
WATCHER="$ROOT/media/gluetun-rezka-watcher/watch.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PARENT_ID='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
OTHER_ID='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
PARENT_SHORT='cccccccccccc'
PARENT_NS='/var/run/docker/netns/cccc'
STALE_NS='/var/run/docker/netns/stale'

DOCKER_CALLS="$TMP/docker-calls"
NETNS_STATE="$TMP/netns-state"
mkdir -p "$TMP/state"
export DOCKER_CALLS NETNS_STATE TMP PARENT_ID OTHER_ID PARENT_SHORT PARENT_NS STALE_NS

write_docker_mock() {
    mode=$1
    cat >"$TMP/docker" <<EOF
#!/bin/sh
set -eu
printf '%s\n' "\$*" >>"\$DOCKER_CALLS"

flip_stale() {
    [ "\${FLIP_TO_STALE:-0}" = 1 ] && [ -f "\$TMP/seen_event" ]
}

case "\$1" in
    compose)
        if printf '%s\n' "\$*" | grep -Fq 'force-recreate'; then
            printf 'matched\n' >"\$NETNS_STATE"
        fi
        exit 0
        ;;
    inspect)
        target=\$2
        if [ "\$#" -eq 2 ]; then
            case "\$target" in
                gluetun-rezka|"$PARENT_ID"|download-runner) exit 0 ;;
                *) exit 1 ;;
            esac
        fi
        case "\$*" in
            *'{{.Id}}'*)
                printf '%s\n' "$PARENT_ID"
                ;;
            *'{{.Name}}'*)
                if [ "\$target" = "$PARENT_ID" ] || [ "\$target" = gluetun-rezka ]; then
                    printf '%s\n' '/gluetun-rezka'
                else
                    printf '%s\n' "/\$target"
                fi
                ;;
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
            *HostConfig.NetworkMode*)
                if [ "\$target" = download-runner ]; then
                    if [ -f "\$NETNS_STATE" ] && [ "\$(cat "\$NETNS_STATE")" = matched ]; then
                        printf 'container:$PARENT_ID\n'
                    elif flip_stale; then
                        printf 'container:$OTHER_ID\n'
                    else
                        printf '%s\n' "\$DEPENDENT_NETMODE"
                    fi
                else
                    printf 'bridge\n'
                fi
                ;;
            *NetworkSettings.SandboxKey*)
                if [ "\$target" = download-runner ]; then
                    if [ -f "\$NETNS_STATE" ] && [ "\$(cat "\$NETNS_STATE")" = matched ]; then
                        printf '%s\n' "\$PARENT_SANDBOX"
                    elif flip_stale; then
                        printf '%s\n' "$STALE_NS"
                    else
                        printf '%s\n' "\$DEPENDENT_SANDBOX"
                    fi
                else
                    printf '%s\n' "\$PARENT_SANDBOX"
                fi
                ;;
            *State.StartedAt*)
                if [ "\$target" = download-runner ]; then
                    if flip_stale; then
                        printf '%s\n' '2026-09-14T10:00:00Z'
                    else
                        printf '%s\n' "\$DEPENDENT_STARTED"
                    fi
                else
                    printf '%s\n' "\$PARENT_STARTED"
                fi
                ;;
            *State.Status*)
                printf '%s\n' "\$DEPENDENT_STATE"
                ;;
            *)
                printf '\n'
                ;;
        esac
        ;;
    events)
        if [ "$mode" = flip ]; then
            : >"\$TMP/seen_event"
        fi
        if [ -n "\${DOCKER_EVENTS:-}" ]; then
            printf '%s\n' "\$DOCKER_EVENTS"
        fi
        ;;
    exec)
        printf '%s\n' '203.0.113.10'
        ;;
    start|restart|stop)
        exit 0
        ;;
esac
EOF
    chmod +x "$TMP/docker"
}

cat >"$TMP/wget" <<'EOF'
#!/bin/sh
set -eu
out=
while [ "$#" -gt 0 ]; do
    case "$1" in
        -O) out=$2; shift 2 ;;
        *) shift ;;
    esac
done
if [ -n "$out" ]; then
    printf '{"state":"ready","current_ip":"203.0.113.10","previous_ip":"203.0.113.10","reason":null}\n' >"$out"
fi
exit 0
EOF
chmod +x "$TMP/wget"

run_watcher() {
    mock_mode=${1:-plain}
    : >"$DOCKER_CALLS"
    : >"$NETNS_STATE"
    rm -f "$TMP/seen_event"
    write_docker_mock "$mock_mode"
    PATH="$TMP:$PATH" \
        PARENT_CONTAINER=gluetun-rezka \
        DEPENDENT_CONTAINER=download-runner \
        HEALTH_TIMEOUT=5 \
        SETTLE_DELAY=0 \
        RECREATE_DEBOUNCE=0 \
        DIE_LIFECYCLE_SETTLE="${DIE_LIFECYCLE_SETTLE:-0}" \
        ROTATION_ATTEMPTS=1 \
        REZKA_PROBE_IMAGE=example/runner:test \
        PROBE_UID=1000 \
        PROBE_GID=1000 \
        MEDIA_LIFECYCLE_TOKEN=test-token \
        MEDIA_REZKA_PROXY_URL=http://127.0.0.1:8888 \
        MEDIA_REZKA_MIRRORS=https://example.test \
        MEDIA_REZKA_SESSION_PROBE_URL=https://example.test/ \
        MEDIA_REZKA_SESSION_VALID_MARKERS_JSON='[]' \
        MEDIA_REZKA_SESSION_INVALID_MARKERS_JSON='[]' \
        STATE_DIR="$TMP/state" \
        "$WATCHER" >"$TMP/output" 2>&1 || true
}

expected='compose -p homelab --project-directory /srv/homelab -f /srv/homelab/compose.yml -f /srv/homelab/compose.override.yml up -d --force-recreate --no-deps download-runner'

# 1) Startup: running orphaned runner → force-recreate (do not wait on sticky lease)
PARENT_STARTED='2026-09-14T19:18:00Z'
DEPENDENT_STARTED='2026-09-14T10:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$OTHER_ID"
DEPENDENT_SANDBOX="$STALE_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS=''
FLIP_TO_STALE=0
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE \
    DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS FLIP_TO_STALE
run_watcher

if ! grep -Fqx "$expected" "$DOCKER_CALLS"; then
    echo "FAIL: startup orphaned runner was not force-recreated" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi
if grep -E '(^| )(restart|stop) download-runner($| )' "$DOCKER_CALLS"; then
    echo "FAIL: watcher used docker restart/stop instead of Compose recreate" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi
if ! grep -Fq 'orphaned on the previous' "$TMP/output"; then
    echo "FAIL: expected orphaned-netns recreate log" >&2
    cat "$TMP/output" >&2
    exit 1
fi

# 2) Parent start with orphaned netns → force-recreate after healthy
PARENT_STARTED='2026-09-14T19:18:00Z'
DEPENDENT_STARTED='2026-09-14T19:19:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_ID"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS="$PARENT_ID|gluetun-rezka|start"
FLIP_TO_STALE=1
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE \
    DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS FLIP_TO_STALE
run_watcher flip

if ! grep -Fqx "$expected" "$DOCKER_CALLS"; then
    echo "FAIL: parent start with orphaned netns did not force-recreate" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi
if ! grep -Fq 'start detected' "$TMP/output"; then
    echo "FAIL: expected parent start handling" >&2
    cat "$TMP/output" >&2
    exit 1
fi

# 3) Parent start but already on current netns → skip recreate
PARENT_STARTED='2026-09-14T19:18:00Z'
DEPENDENT_STARTED='2026-09-14T19:19:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_ID"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS="$PARENT_ID|gluetun-rezka|start"
FLIP_TO_STALE=0
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE \
    DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS FLIP_TO_STALE
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS"; then
    echo "FAIL: matching netns still forced recreate" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi
if ! grep -Fq 'already shares current' "$TMP/output"; then
    echo "FAIL: expected skip-recreate log for matching netns" >&2
    cat "$TMP/output" >&2
    exit 1
fi

# 4) Short NetworkMode id still counts as current parent
PARENT_STARTED='2026-09-14T19:18:00Z'
DEPENDENT_STARTED='2026-09-14T19:19:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_SHORT"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS=''
FLIP_TO_STALE=0
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE \
    DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS FLIP_TO_STALE
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS"; then
    echo "FAIL: short NetworkMode id should count as current parent" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi


# 5) Parent start via exec_start must be ignored
PARENT_STARTED='2026-09-14T19:18:00Z'
DEPENDENT_STARTED='2026-09-14T19:19:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_ID"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS="$PARENT_ID|gluetun-rezka|exec_start: /gluetun-entrypoint healthcheck"
FLIP_TO_STALE=1
DIE_LIFECYCLE_SETTLE=0
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE \
    DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS FLIP_TO_STALE DIE_LIFECYCLE_SETTLE
run_watcher flip

if grep -Fq 'force-recreate' "$DOCKER_CALLS"; then
    echo "FAIL: exec_start must not trigger orphaned recreate" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi
if grep -Fq 'start detected' "$TMP/output"; then
    echo "FAIL: exec_start must not be treated as parent start" >&2
    cat "$TMP/output" >&2
    exit 1
fi

# 6) Die while ready, then lifecycle flips to rotating within settle → skip start under ready
cat >"$TMP/wget" <<'EOF'
#!/bin/sh
set -eu
out=
post=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        -O) out=$2; shift 2 ;;
        --post-data) post=1; shift 2 ;;
        *) shift ;;
    esac
done
count_file="$TMP/lifecycle-gets"
count=0
if [ -f "$count_file" ]; then
    count=$(cat "$count_file")
fi
if [ "$post" -eq 0 ] && [ -n "$out" ]; then
    count=$((count + 1))
    printf '%s\n' "$count" >"$count_file"
    # First reads (startup) stay ready; the post-die settle read flips to rotating.
    if [ "$count" -ge 2 ]; then
        printf '{"state":"rotating","current_ip":"203.0.113.10","previous_ip":"203.0.113.10","reason":null}\n' >"$out"
    else
        printf '{"state":"ready","current_ip":"203.0.113.10","previous_ip":"203.0.113.10","reason":null}\n' >"$out"
    fi
fi
exit 0
EOF
chmod +x "$TMP/wget"

PARENT_STARTED='2026-09-14T19:18:00Z'
DEPENDENT_STARTED='2026-09-14T19:19:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_ID"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS="dddddddddddd|download-runner|die"
FLIP_TO_STALE=0
DIE_LIFECYCLE_SETTLE=0
: >"$TMP/lifecycle-gets"
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE \
    DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS FLIP_TO_STALE DIE_LIFECYCLE_SETTLE
run_watcher

if ! grep -Fq 'requested a fresh VPN session (post-settle)' "$TMP/output"; then
    echo "FAIL: die+settle should take rotating path, not ready start" >&2
    cat "$TMP/output" >&2
    exit 1
fi
if grep -Fq 'reusing the current VPN session' "$TMP/output"; then
    echo "FAIL: ready start must be skipped when lifecycle flips to rotating" >&2
    cat "$TMP/output" >&2
    exit 1
fi
if ! grep -Eq '(^| )restart gluetun-rezka($| )' "$DOCKER_CALLS"; then
    echo "FAIL: rotating path should restart gluetun-rezka" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

echo 'PASS: gluetun-rezka-watcher orphaned-netns, exec_start ignore, and die-settle rotate paths'
