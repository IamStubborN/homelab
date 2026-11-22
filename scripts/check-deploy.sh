#!/usr/bin/env bash
# Deployment check, run on the Docker host from the checkout: the checkout is
# clean at origin/main, Compose plans no container changes beyond Watchtower's
# stale image labels, and every service is running (one-shot jobs may exit 0).
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."

fail=0
git fetch -q origin
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
    echo "Checkout is not at origin/main"; fail=1
fi
if [[ -n "$(git status --porcelain)" ]]; then
    git status --short; echo "Checkout has local changes"; fail=1
fi

if ! plan=$(docker compose up -d --dry-run 2>&1); then
    printf '%s\n' "$plan"; echo "Compose dry run failed"; exit 1
fi
drift=() labels=()
while read -r name; do
    [[ -n "$name" ]] || continue
    if ! info=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.Image}} {{index .Config.Labels "com.docker.compose.image"}} {{.Config.Image}} {{.HostConfig.NetworkMode}} {{index .Config.Labels "com.docker.compose.config-hash"}}' "$name" 2>/dev/null); then
        drift+=("$name (not created)"); continue
    fi
    read -r service image labelled ref netmode hash <<<"$info"
    tagged=$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)
    # Watchtower swaps the image but keeps Compose's image label, so Compose plans
    # a same-image recreation: running image == tagged image != labelled image.
    # config --hash cannot judge network_mode: service: containers (Compose hashes
    # them after substituting the container ID); for those the parent container
    # they share must still be running instead.
    if [[ "$image" == "$tagged" && "$labelled" != "$image" ]]; then
        if [[ "$netmode" == container:* ]]; then
            same=$([[ "$(docker inspect -f '{{.State.Running}}' "${netmode#container:}" 2>/dev/null)" == true ]] && echo y || true)
        else
            same=$([[ "$(docker compose config --hash "$service" | awk '{print $2}')" == "$hash" ]] && echo y || true)
        fi
        if [[ -n "$same" ]]; then labels+=("$service"); continue; fi
    fi
    drift+=("$service")
done < <(awk '$1 == "Container" && $3 ~ /^(Create|Creating|Recreate)$/ {print $2}' <<<"$plan" | sort -u)

stopped=()
while IFS='|' read -r name service state code health; do
    if [[ "$state" == running ]]; then
        [[ "$health" == unhealthy ]] && stopped+=("$service (unhealthy)")
        continue
    fi
    # Finished one-shot jobs: exit 0 under a policy that does not restart on success.
    policy=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$name")
    [[ "$state" == exited && "$code" == 0 && ( "$policy" == no || "$policy" == on-failure || -z "$policy" ) ]] && continue
    stopped+=("$service ($state, exit $code)")
done < <(docker compose ps -a --format '{{.Name}}|{{.Service}}|{{.State}}|{{.ExitCode}}|{{.Health}}')

if ((${#drift[@]})); then
    printf 'Compose would change containers:\n'; printf '  %s\n' "${drift[@]}"; fail=1
fi
if ((${#stopped[@]})); then
    printf 'Services not running:\n'; printf '  %s\n' "${stopped[@]}"; fail=1
fi
if ((${#labels[@]})); then
    printf 'Warning: Watchtower updated these services; refresh their Compose labels with docker compose up -d <service>:\n'
    printf '  %s\n' "${labels[@]}"
fi
((fail == 0)) || exit 1
echo "Checkout is clean at origin/main and every container matches Compose"
