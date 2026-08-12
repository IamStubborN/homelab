#!/bin/sh
set -eu

command -v docker >/dev/null
command -v git >/dev/null
command -v perl >/dev/null
command -v strings >/dev/null
docker info >/dev/null 2>&1

repository=$(git rev-parse --show-toplevel)
service="$repository/health/service"
work=$(mktemp -d "${TMPDIR:-/tmp}/health-docker-cache.XXXXXX")
fixture="$work/fixture"
old_tag="family-health-cache-probe-old:$$"
head_tag="family-health-cache-probe-head:$$"
old_container=
head_container=

cleanup() {
  set +e
  if [ -n "$old_container" ]; then docker rm -f "$old_container" >/dev/null; fi
  if [ -n "$head_container" ]; then docker rm -f "$head_container" >/dev/null; fi
  docker image rm "$old_tag" "$head_tag" >/dev/null 2>&1
  rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM

mkdir "$fixture"
(
  cd "$service"
  tar --exclude=target --exclude=.git -cf - .
) | tar -xf - -C "$fixture"
perl -0pi -e 's/confirmation_required:/cache_fixture_old:/' \
  "$fixture/crates/health-service/src/ops.rs"
grep -q 'cache_fixture_old:' "$fixture/crates/health-service/src/ops.rs"

# Both builds use the Dockerfile's same named BuildKit target cache. The second
# image must reflect the current source rather than the first fixture binary.
docker build --progress=plain -t "$old_tag" "$fixture"
docker build --progress=plain -t "$head_tag" "$service"

old_container=$(docker create "$old_tag")
head_container=$(docker create "$head_tag")
docker cp "$old_container:/usr/local/bin/health-service" "$work/old-health-service"
docker cp "$head_container:/usr/local/bin/health-service" "$work/head-health-service"

strings "$work/old-health-service" | grep -q 'cache_fixture_old:'
strings "$work/head-health-service" | grep -q 'confirmation_required:'
strings "$work/head-health-service" | grep -q 'm20260813_000002_sleep_time_order'
if strings "$work/head-health-service" | grep -q 'cache_fixture_old:'; then
  echo 'head image contains the stale fixture binary' >&2
  exit 1
fi

echo 'Docker cache regression passed: head binary and migration 000002 are present.'
