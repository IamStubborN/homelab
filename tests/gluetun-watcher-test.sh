#!/bin/sh
set -eu

ROOT=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)
WATCHER="$ROOT/download/gluetun-watcher/watch.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PARENT_ID='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
OTHER_ID='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
PARENT_SHORT='aaaaaaaaaaaa'
PARENT_NS='/var/run/docker/netns/aaaa'
STALE_NS='/var/run/docker/netns/stale'

cat >"$TMP/docker" <<EOF
#!/bin/sh
set -eu

printf '%s\n' "\$*" >>"\$DOCKER_CALLS"

current_parent_id=\$(cat "\$PARENT_STATE")
case "\$1" in
    compose)
        # After a force-recreate, dependents share the parent netns.
        if printf '%s\n' "\$*" | grep -Fq 'force-recreate'; then
            printf 'matched\n' >"\$NETNS_STATE"
        fi
        exit 0
        ;;
    inspect)
        target=\$2
        # Bare inspect used for existence checks.
        if [ "\$#" -eq 2 ]; then
            case "\$target" in
                gluetun|"\$current_parent_id"|qbittorrent) exit 0 ;;
                *) exit 1 ;;
            esac
        fi
        case "\$*" in
            *'{{.Id}}'*)
                if [ "\$target" = "gluetun" ] || [ "\$target" = "\$current_parent_id" ]; then
                    printf '%s\n' "\$current_parent_id"
                elif [ "\$target" = "gluetun-rezka" ]; then
                    printf '%s\n' "$OTHER_ID"
                else
                    exit 1
                fi
                ;;
            *'{{.Name}}'*)
                if [ "\$target" = "\$current_parent_id" ] || [ "\$target" = "gluetun" ]; then
                    printf '%s\n' '/gluetun'
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
                if [ "\$target" = "gluetun" ] || [ "\$target" = "\$current_parent_id" ]; then
                    printf '%s\n' 'bridge'
                elif [ -f "\$NETNS_STATE" ] && [ "\$(cat "\$NETNS_STATE")" = "matched" ]; then
                    printf '%s\n' "container:\$current_parent_id"
                else
                    printf '%s\n' "\$DEPENDENT_NETMODE"
                fi
                ;;
            *NetworkSettings.SandboxKey*)
                if [ "\$target" = "gluetun" ] || [ "\$target" = "\$current_parent_id" ]; then
                    printf '%s\n' "\$PARENT_SANDBOX"
                elif [ -f "\$NETNS_STATE" ] && [ "\$(cat "\$NETNS_STATE")" = "matched" ]; then
                    printf '%s\n' "\$PARENT_SANDBOX"
                else
                    printf '%s\n' "\$DEPENDENT_SANDBOX"
                fi
                ;;
            *State.StartedAt*)
                if [ "\$target" = "gluetun" ] || [ "\$target" = "\$current_parent_id" ]; then
                    printf '%s\n' "\$PARENT_STARTED"
                else
                    printf '%s\n' "\$DEPENDENT_STARTED"
                fi
                ;;
            *State.Status*)
                printf '%s\n' "\$DEPENDENT_STATE"
                ;;
        esac
        ;;
    events)
        if [ -n "\${NEW_PARENT_ID:-}" ]; then
            printf '%s\n' "\$NEW_PARENT_ID" >"\$PARENT_STATE"
            # A subscription pinned to the retired ID cannot receive this event.
            case "\$*" in *"container=$PARENT_ID"*) exit 0 ;; esac
        fi
        if [ -n "\${DOCKER_EVENTS:-}" ]; then
            case "\$*" in
                *Actor.Attributes.name*) printf '%s\n' "\$DOCKER_EVENTS" ;;
                *) printf '%s\n' "\$DOCKER_EVENTS" | sed 's/|[^|]*|/ /' ;;
            esac
        fi
        ;;
    restart)
        printf '%s\n' "\$2"
        ;;
esac
EOF
chmod +x "$TMP/docker"

run_watcher() {
    : >"$DOCKER_CALLS"
    : >"$NETNS_STATE"
    printf '%s\n' "$PARENT_ID" >"$PARENT_STATE"
    PATH="$TMP:$PATH" \
        PARENT_CONTAINER=gluetun \
        DEPENDENT_CONTAINERS=qbittorrent \
        HEALTH_TIMEOUT=5 \
        SETTLE_DELAY=0 \
        RECREATE_DEBOUNCE=0 \
        "$WATCHER" >"$TMP/output" 2>&1
}

DOCKER_CALLS="$TMP/docker-calls"
NETNS_STATE="$TMP/netns-state"
PARENT_STATE="$TMP/parent-id"
export DOCKER_CALLS NETNS_STATE PARENT_STATE

expected='compose -p homelab --project-directory /srv/homelab -f /srv/homelab/compose.yml -f /srv/homelab/compose.override.yml up -d --force-recreate --no-deps qbittorrent'

# 1) Stale dependent at startup (old start time + stale netns) → recreate
PARENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STATE='exited'
DEPENDENT_NETMODE="container:$OTHER_ID"
DEPENDENT_SANDBOX="$STALE_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS=''
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if ! grep -Fqx "$expected" "$DOCKER_CALLS"; then
    echo "FAIL: exited stale dependent was not recreated with Compose" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

# 2) exec_start must not recreate
PARENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_ID"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|gluetun|exec_start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS" || grep -Fq 'restart qbittorrent' "$DOCKER_CALLS"; then
    echo "FAIL: exec_start event triggered dependent recovery" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

# 3) Non-parent start must not recreate
PARENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_ID"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|gluetun-rezka|start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS" || grep -Fq 'restart qbittorrent' "$DOCKER_CALLS"; then
    echo "FAIL: non-parent start event triggered dependent recovery" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

# 4) Exact parent start with stale netns → recreate
PARENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$OTHER_ID"
DEPENDENT_SANDBOX="$STALE_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|gluetun|start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if ! grep -Fqx "$expected" "$DOCKER_CALLS"; then
    echo "FAIL: exact parent start event did not recreate dependent" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

# 5) Parent start but dependent already on current netns → skip recreate
PARENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_ID"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|gluetun|start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS" || grep -Fq 'restart qbittorrent' "$DOCKER_CALLS"; then
    echo "FAIL: healthy matching netns still forced recreate" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi
if ! grep -Fq 'skip recreate' "$TMP/output" && ! grep -Fq 'already on current' "$TMP/output"; then
    echo "FAIL: expected skip-recreate log for matching netns" >&2
    cat "$TMP/output" >&2
    exit 1
fi

# 6) Rapid duplicate start events: first recreates, second skips (netns matched after recreate)
PARENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$OTHER_ID"
DEPENDENT_SANDBOX="$STALE_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS=$(printf '%s\n%s\n' \
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|gluetun|start' \
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|gluetun|start')
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

recreate_count=$(grep -Fc 'force-recreate' "$DOCKER_CALLS" || true)
if [ "$recreate_count" -ne 1 ]; then
    echo "FAIL: expected exactly one recreate for debounced/duplicate starts, got $recreate_count" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi
if ! grep -Fq 'skip recreate' "$TMP/output"; then
    echo "FAIL: second start should skip recreate after netns refresh" >&2
    cat "$TMP/output" >&2
    exit 1
fi

# 7) Short container NetworkMode id still counts as matched (no recreate)
PARENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_SHORT"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|gluetun|start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS"; then
    echo "FAIL: short NetworkMode id should count as current parent" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

# 8) Recreated parent has a new ID; matching old dependent must migrate exactly once.
NEW_PARENT_ID='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
DEPENDENT_NETMODE="container:$PARENT_ID"
DOCKER_EVENTS=$(printf '%s\n%s\n' "$NEW_PARENT_ID|gluetun|start" "$NEW_PARENT_ID|gluetun|start")
export NEW_PARENT_ID DEPENDENT_NETMODE DOCKER_EVENTS
run_watcher
if [ "$(grep -Fc 'force-recreate' "$DOCKER_CALLS" || true)" -ne 1 ]; then
    echo 'FAIL: replacement parent ID was not observed/reconciled exactly once' >&2
    cat "$TMP/output" >&2
    exit 1
fi
if ! grep -Fq "inspect $NEW_PARENT_ID --format {{index .Config.Labels" "$DOCKER_CALLS"; then
    echo 'FAIL: replacement parent Compose metadata was not read' >&2
    exit 1
fi

# Similarly named helpers must never trigger parent recovery, even if namespace is stale.
DOCKER_EVENTS="$NEW_PARENT_ID|gluetun-helper|start"
run_watcher
if grep -Fq 'force-recreate' "$DOCKER_CALLS"; then
    echo 'FAIL: similarly named helper triggered parent recovery' >&2
    exit 1
fi

# Compose must recognize the event subscription's actual process command line.
events_command=$(sed -n '/^events /{p;q;}' "$DOCKER_CALLS")
sed -n 's/.*test: \[CMD, pgrep, -f, "\(.*\)"\].*/\1/p' "$ROOT/download/compose.yml" | while IFS= read -r health_pattern; do
    if ! printf 'docker %s\n' "$events_command" | grep -Eq "$health_pattern"; then
        echo 'FAIL: Compose healthcheck does not match the active event subscription' >&2
        exit 1
    fi
done

echo 'PASS: gluetun watcher recovery, exact-name filter and replacement IDs, debounce/netns skip, and event filtering'
