#!/bin/sh
set -eu

probe_output_is_ready() {
    [ "$1" = '{"category":"RezkaReachable"}' ]
}

should_skip_rezka_probe() {
    lifecycle_state=${1:-}
    lifecycle_ip=${2:-}
    public_ip=${3:-}
    [ "$lifecycle_state" = ready ] \
        && [ -n "$lifecycle_ip" ] \
        && [ -n "$public_ip" ] \
        && [ "$lifecycle_ip" = "$public_ip" ]
}

if [ "${WATCHER_PROBE_CONTRACT_TEST:-0}" = 1 ]; then
    probe_output_is_ready "${WATCHER_PROBE_OUTPUT:-}"
    exit
fi

if [ "${WATCHER_SKIP_PROBE_CONTRACT_TEST:-0}" = 1 ]; then
    should_skip_rezka_probe \
        "${WATCHER_LIFECYCLE_STATE:-}" \
        "${WATCHER_LIFECYCLE_IP:-}" \
        "${WATCHER_PUBLIC_IP:-}"
    exit
fi

if [ "${WATCHER_STARTUP_IP_CONTRACT_TEST:-0}" = 1 ]; then
    # Startup skip must use the post-healthy IP, never the pre-wait captured address.
    should_skip_rezka_probe \
        "${WATCHER_LIFECYCLE_STATE:-}" \
        "${WATCHER_LIFECYCLE_IP:-}" \
        "${WATCHER_POST_HEALTHY_IP:-}"
    exit
fi

PARENT=${PARENT_CONTAINER:-gluetun-rezka}
DEPENDENT=${DEPENDENT_CONTAINER:-download-runner}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}
SETTLE_DELAY=${SETTLE_DELAY:-10}
ROTATION_ATTEMPTS=${ROTATION_ATTEMPTS:-3}
LIFECYCLE_WRITE_ATTEMPTS=${LIFECYCLE_WRITE_ATTEMPTS:-3}
LIFECYCLE_RETRY_DELAY=${LIFECYCLE_RETRY_DELAY:-2}
LIFECYCLE_HTTP_TIMEOUT=${LIFECYCLE_HTTP_TIMEOUT:-10}
REZKA_PROBE_IMAGE=${REZKA_PROBE_IMAGE:?REZKA_PROBE_IMAGE is required}
PROBE_UID=${PROBE_UID:?PROBE_UID is required}
PROBE_GID=${PROBE_GID:?PROBE_GID is required}
MEDIA_SERVICE_URL=${MEDIA_SERVICE_URL:-http://media-service:8080}
STATE_DIR=${STATE_DIR:-/state}
if [ -z "${MEDIA_LIFECYCLE_TOKEN:-}" ] && [ -n "${MEDIA_LIFECYCLE_TOKEN_FILE:-}" ] && [ -f "$MEDIA_LIFECYCLE_TOKEN_FILE" ]; then
  MEDIA_LIFECYCLE_TOKEN="$(tr -d '\n' < "$MEDIA_LIFECYCLE_TOKEN_FILE")"
  export MEDIA_LIFECYCLE_TOKEN
fi
: "${MEDIA_LIFECYCLE_TOKEN:?MEDIA_LIFECYCLE_TOKEN is required}"

log() {
    printf '%s [gluetun-rezka-watcher] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1"
}

started_at() {
    docker inspect "$1" --format '{{.State.StartedAt}}' 2>/dev/null || true
}

wait_healthy() {
    elapsed=0
    while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
        status=$(docker inspect "$PARENT" --format '{{.State.Health.Status}}' 2>/dev/null || true)
        if [ "$status" = healthy ]; then
            return 0
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done
    return 1
}

public_ip() {
    ip=$(docker exec "$PARENT" cat /tmp/gluetun/ip 2>/dev/null | tr -d '\r\n' || true)
    if [ -n "$ip" ]; then
        printf '%s' "$ip"
        return
    fi

    for endpoint in http://ipinfo.io/ip http://ifconfig.me/ip; do
        ip=$(docker exec "$PARENT" wget -qO- --timeout=15 "$endpoint" 2>/dev/null \
            | tr -d '\r\n' || true)
        if [ -n "$ip" ]; then
            printf '%s' "$ip"
            return
        fi
    done
}

mount_source() {
    destination=$1
    docker inspect "$DEPENDENT" \
        --format "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Source}}{{end}}{{end}}" \
        2>/dev/null || true
}

session_volume_name() {
    docker inspect "$DEPENDENT" \
        --format '{{range .Mounts}}{{if eq .Destination "/var/lib/media-orchestrator/session"}}{{.Name}}{{end}}{{end}}' \
        2>/dev/null || true
}

rezka_egress_healthy() {
    # Run the immutable runner's challenge-aware CLI in the parent's namespace. Mount only the
    # encrypted jar and two secrets required by RunnerConfig; never expose media storage or
    # qBittorrent credentials to the probe. Only the typed category is inspected.
    session_volume=$(session_volume_name)
    runner_token_source=$(mount_source /run/secrets/media_runner_token)
    cookie_key_source=$(mount_source /run/secrets/rezka_cookie_key)
    if [ -z "$session_volume" ] || [ -z "$runner_token_source" ] || [ -z "$cookie_key_source" ]; then
        log "cannot resolve the probe's restricted session and secret mounts"
        return 1
    fi
    probe_output=$(docker run --rm \
        --user "$PROBE_UID:$PROBE_GID" \
        --read-only \
        --tmpfs /tmp:rw,nosuid,nodev,exec,size=512m,mode=1777 \
        --shm-size 256m \
        --cap-drop ALL \
        --security-opt no-new-privileges:true \
        --network "container:$PARENT" \
        --mount "type=volume,source=$session_volume,target=/var/lib/media-orchestrator/session" \
        --mount "type=bind,source=$runner_token_source,target=/run/secrets/media_runner_token,readonly" \
        --mount "type=bind,source=$cookie_key_source,target=/run/secrets/rezka_cookie_key,readonly" \
        -e "MEDIA_SERVICE_URL=$MEDIA_SERVICE_URL" \
        -e MEDIA_TOKEN_FILE=/run/secrets/media_runner_token \
        -e "MEDIA_REZKA_PROXY_URL=$MEDIA_REZKA_PROXY_URL" \
        -e "MEDIA_REZKA_MIRRORS=$MEDIA_REZKA_MIRRORS" \
        -e "MEDIA_REZKA_SESSION_PROBE_URL=$MEDIA_REZKA_SESSION_PROBE_URL" \
        -e "MEDIA_REZKA_SESSION_VALID_MARKERS_JSON=$MEDIA_REZKA_SESSION_VALID_MARKERS_JSON" \
        -e "MEDIA_REZKA_SESSION_INVALID_MARKERS_JSON=$MEDIA_REZKA_SESSION_INVALID_MARKERS_JSON" \
        -e MEDIA_REZKA_COOKIE_KEY_FILE=/run/secrets/rezka_cookie_key \
        -e MEDIA_REZKA_SESSION_STORE_FILE=/var/lib/media-orchestrator/session/session.bin \
        "$REZKA_PROBE_IMAGE" rezka probe --json 2>/dev/null || true)
    probe_output_is_ready "$probe_output"
}

record_rotation() {
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    printf '%s\t%s\t%s\t%s\n' "$timestamp" "$1" "$2" "$3" \
        >>"$STATE_DIR/rotations.tsv"
}

json_ip() {
    case ${1:-} in
        '' | *[!0-9A-Fa-f:.]*) printf 'null' ;;
        *) printf '"%s"' "$1" ;;
    esac
}

put_lifecycle() {
    state=$1
    reason=$2
    previous_ip=$3
    current_ip=$4
    body=$(printf '{"state":"%s","reason":%s,"previous_ip":%s,"current_ip":%s}' \
        "$state" "$reason" "$(json_ip "$previous_ip")" "$(json_ip "$current_ip")")
    response_file="$STATE_DIR/lifecycle-response.$$"
    attempt=1

    while [ "$attempt" -le "$LIFECYCLE_WRITE_ATTEMPTS" ]; do
        if wget -q -T "$LIFECYCLE_HTTP_TIMEOUT" -O "$response_file" \
            --header "Authorization: Bearer $MEDIA_LIFECYCLE_TOKEN" \
            --header 'Content-Type: application/json' \
            --post-data "$body" \
            http://media-service:8080/v1/runner/lifecycle; then
            rm -f "$response_file"
            return 0
        fi

        log "failed to record lifecycle state $state (attempt $attempt/$LIFECYCLE_WRITE_ATTEMPTS)"
        attempt=$((attempt + 1))
        if [ "$attempt" -le "$LIFECYCLE_WRITE_ATTEMPTS" ]; then
            sleep "$LIFECYCLE_RETRY_DELAY"
        fi
    done

    rm -f "$response_file"
    return 1
}

get_lifecycle() {
    response_file="$STATE_DIR/lifecycle-state.$$"
    attempt=1
    while [ "$attempt" -le "$LIFECYCLE_WRITE_ATTEMPTS" ]; do
        if wget -q -T "$LIFECYCLE_HTTP_TIMEOUT" -O "$response_file" \
            --header "Authorization: Bearer $MEDIA_LIFECYCLE_TOKEN" \
            http://media-service:8080/v1/runner/lifecycle; then
            state=$(sed -n 's/.*"state":"\([^"]*\)".*/\1/p' "$response_file")
            current_ip=$(sed -n 's/.*"current_ip":"\([^"]*\)".*/\1/p' "$response_file")
            case $state in
                ready | rotating | blocked)
                    rm -f "$response_file"
                    printf '%s\t%s' "$state" "$current_ip"
                    return 0
                    ;;
            esac
        fi
        log "failed to read lifecycle state (attempt $attempt/$LIFECYCLE_WRITE_ATTEMPTS)" >&2
        attempt=$((attempt + 1))
        if [ "$attempt" -le "$LIFECYCLE_WRITE_ATTEMPTS" ]; then
            sleep "$LIFECYCLE_RETRY_DELAY"
        fi
    done
    rm -f "$response_file"
    return 1
}

get_lifecycle_state() {
    lifecycle=$(get_lifecycle) || return 1
    printf '%s' "${lifecycle%%	*}"
}

rotate_parent() {
    if [ -z "${ROTATION_PREVIOUS_IP:-}" ]; then
        ROTATION_PREVIOUS_IP=$(public_ip)
    fi
    ROTATION_CURRENT_IP=
    attempt=1
    while [ "$attempt" -le "$ROTATION_ATTEMPTS" ]; do
        log "rotating $PARENT before the next job (attempt $attempt/$ROTATION_ATTEMPTS)"
        docker restart "$PARENT" >/dev/null
        if wait_healthy; then
            sleep "$SETTLE_DELAY"
            ROTATION_CURRENT_IP=$(public_ip)
            if [ -n "$ROTATION_PREVIOUS_IP" ] && [ -n "$ROTATION_CURRENT_IP" ] \
                && [ "$ROTATION_PREVIOUS_IP" != "$ROTATION_CURRENT_IP" ]; then
                if ! rezka_egress_healthy; then
                    log "$PARENT obtained a new IP that Rezka rejected; rotating again"
                    attempt=$((attempt + 1))
                    continue
                fi
                record_rotation "$ROTATION_PREVIOUS_IP" "$ROTATION_CURRENT_IP" "$attempt"
                log "$PARENT rotated from $ROTATION_PREVIOUS_IP to $ROTATION_CURRENT_IP"
                return 0
            fi
            log "$PARENT did not obtain a different public IP"
        else
            log "$PARENT did not become healthy within ${HEALTH_TIMEOUT}s"
        fi
        attempt=$((attempt + 1))
    done
    record_rotation "${ROTATION_PREVIOUS_IP:-unknown}" "failed" "$ROTATION_ATTEMPTS"
    return 1
}

start_dependent() {
    state=$(docker inspect "$DEPENDENT" --format '{{.State.Status}}' 2>/dev/null || true)
    if [ "$state" = running ]; then
        log "$DEPENDENT is already running; leaving the active attempt untouched"
        check_stale_namespace
        return
    fi
    log "starting $DEPENDENT on the prepared VPN session"
    docker start "$DEPENDENT" >/dev/null
}

check_stale_namespace() {
    parent_started=$(started_at "$PARENT")
    dependent_started=$(started_at "$DEPENDENT")
    oldest_started=$(printf '%s\n%s\n' "$parent_started" "$dependent_started" | sort | head -n 1)
    if [ -n "$parent_started" ] && [ -n "$dependent_started" ] \
        && [ "$dependent_started" != "$parent_started" ] \
        && [ "$oldest_started" = "$dependent_started" ]; then
        log "$DEPENDENT still uses the previous $PARENT namespace; its sticky lease must end the attempt retryably"
        return 1
    fi
    return 0
}

mkdir -p "$STATE_DIR"
touch "$STATE_DIR/rotations.tsv"

log "watching $PARENT and $DEPENDENT; only this dedicated pair may be controlled"
sleep "$SETTLE_DELAY"
check_stale_namespace || true

dependent_state=$(docker inspect "$DEPENDENT" --format '{{.State.Status}}' 2>/dev/null || true)
if [ "$dependent_state" = running ] && wait_healthy; then
    current_ip=$(public_ip)
    lifecycle=$(get_lifecycle || true)
    lifecycle_state=${lifecycle%%	*}
    lifecycle_ip=${lifecycle#*	}
    if should_skip_rezka_probe "$lifecycle_state" "$lifecycle_ip" "$current_ip"; then
        log "lifecycle already ready for the current public IP; skipping Rezka probe"
    elif ! rezka_egress_healthy; then
        log "$PARENT egress is healthy but Rezka rejected it; gating new work until $DEPENDENT exits"
        if ! put_lifecycle rotating null "$current_ip" ''; then
            log "cannot gate new work; leaving the running attempt untouched"
            exit 1
        fi
    elif ! put_lifecycle ready null "$current_ip" "$current_ip"; then
        log "cannot initialize ready lifecycle state; leaving the running attempt untouched"
        exit 1
    fi
elif [ "$dependent_state" != running ]; then
    ROTATION_PREVIOUS_IP=$(public_ip)
    lifecycle=$(get_lifecycle || true)
    lifecycle_state=${lifecycle%%	*}
    lifecycle_ip=${lifecycle#*	}
    parent_healthy=0
    current_ip=
    if wait_healthy; then
        parent_healthy=1
        current_ip=$(public_ip)
    fi
    if [ "$parent_healthy" -eq 1 ] && { should_skip_rezka_probe "$lifecycle_state" "$lifecycle_ip" "$current_ip" \
        || rezka_egress_healthy; }; then
        if put_lifecycle ready null "$ROTATION_PREVIOUS_IP" "$current_ip"; then
            log "existing VPN session is Rezka-ready; reusing it"
            start_dependent
        else
            log "cannot initialize ready lifecycle state; $DEPENDENT remains stopped"
            exit 1
        fi
    elif ! put_lifecycle rotating null "$ROTATION_PREVIOUS_IP" ''; then
        log "cannot initialize rotating lifecycle state; $DEPENDENT remains stopped"
        exit 1
    elif rotate_parent && put_lifecycle ready null "$ROTATION_PREVIOUS_IP" "$ROTATION_CURRENT_IP"; then
        start_dependent
    else
        put_lifecycle blocked '"vpn_rotation_failed"' "$ROTATION_PREVIOUS_IP" "$ROTATION_CURRENT_IP" || true
        log "startup VPN reconciliation failed; $DEPENDENT remains stopped"
    fi
fi

docker events \
    --filter type=container \
    --filter "container=$PARENT" \
    --filter "container=$DEPENDENT" \
    --filter "event=start" \
    --filter "event=die" \
    --format '{{.Actor.Attributes.name}}|{{.Action}}' | while IFS='|' read -r container action; do
    if [ "$container" = "$DEPENDENT" ] && [ "$action" = die ]; then
        lifecycle_state=$(get_lifecycle_state || true)
        if [ "$lifecycle_state" = ready ]; then
            log "$DEPENDENT completed an attempt; reusing the current VPN session"
            start_dependent
        elif [ "$lifecycle_state" = rotating ]; then
            log "$DEPENDENT requested a fresh VPN session"
            ROTATION_PREVIOUS_IP=$(public_ip)
            if rotate_parent; then
                if put_lifecycle ready null "$ROTATION_PREVIOUS_IP" "$ROTATION_CURRENT_IP"; then
                    start_dependent
                else
                    log "cannot record ready lifecycle state; $DEPENDENT remains stopped"
                fi
            else
                if ! put_lifecycle blocked '"vpn_rotation_failed"' \
                    "$ROTATION_PREVIOUS_IP" "$ROTATION_CURRENT_IP"; then
                    log "cannot record blocked lifecycle state"
                fi
                log "VPN rotation failed; $DEPENDENT remains stopped and queued work is gated"
            fi
        elif [ "$lifecycle_state" = blocked ]; then
            log "$DEPENDENT stopped while lifecycle is blocked; queued work remains gated"
        else
            log "cannot read lifecycle state; $DEPENDENT remains stopped fail-closed"
        fi
    elif [ "$container" = "$PARENT" ] && [ "$action" = start ]; then
        log "$PARENT start detected"
        check_stale_namespace || true
    fi
done

log "Docker event stream ended"
exit 1
