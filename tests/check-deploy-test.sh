#!/usr/bin/env bash
# Runs scripts/check-deploy.sh against fake git and docker commands.
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo/scripts"
cp "$ROOT/scripts/check-deploy.sh" "$TMP/repo/scripts/"

cat > "$TMP/bin/git" <<'EOF'
#!/bin/sh
case "$1" in
  fetch) exit 0 ;;
  rev-parse) [ "$2" = HEAD ] && cat "$FAKE/head" || echo aaa ;;
  status) cat "$FAKE/status" ;;
esac
EOF
# State files: plan (dry-run output), plan.rc, ps (compose ps lines),
# c.<name> (inspect line), policy.<name>, tag.<ref>, hash.<service>.
cat > "$TMP/bin/docker" <<'EOF'
#!/bin/sh
case "$*" in
  'compose up -d --dry-run') cat "$FAKE/plan" >&2; exit "$(cat "$FAKE/plan.rc")" ;;
  'compose ps -a --format'*) cat "$FAKE/ps" ;;
  'compose config --hash '*) echo "$4 $(cat "$FAKE/hash.$4")" ;;
  'image inspect -f '*) cat "$FAKE/tag.$5" 2>/dev/null || exit 1 ;;
  'inspect -f {{.HostConfig.RestartPolicy.Name}} '*) cat "$FAKE/policy.$4" ;;
  'inspect -f {{.State.Running}} '*) cat "$FAKE/running.$4" 2>/dev/null || exit 1 ;;
  'inspect -f '*) cat "$FAKE/c.$4" 2>/dev/null || exit 1 ;;
  *) echo "unexpected docker $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$TMP/bin/git" "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH" FAKE="$TMP/state"

reset() {
  rm -rf "$FAKE"; mkdir -p "$FAKE"
  echo aaa > "$FAKE/head"; : > "$FAKE/status"
  printf ' Container web Running \n' > "$FAKE/plan"; echo 0 > "$FAKE/plan.rc"
  printf 'web|web|running|0|healthy\n' > "$FAKE/ps"
}
expect() { # expect <pass|fail> <name> [pattern]
  local out rc=0
  out=$("$TMP/repo/scripts/check-deploy.sh" 2>&1) || rc=$?
  if [ "$1" = pass ] && [ "$rc" -ne 0 ] || [ "$1" = fail ] && [ "$rc" -eq 0 ]; then
    printf 'FAIL %s (rc=%s)\n%s\n' "$2" "$rc" "$out"; exit 1
  fi
  if [ -n "${3:-}" ] && ! grep -q -- "$3" <<<"$out"; then
    printf 'FAIL %s: missing %s\n%s\n' "$2" "$3" "$out"; exit 1
  fi
  echo "ok $2"
}

reset; expect pass clean 'every container matches'
reset; echo bbb > "$FAKE/head"; expect fail behind-origin 'not at origin/main'
reset; echo ' M compose.yml' > "$FAKE/status"; expect fail dirty 'local changes'
reset; echo 1 > "$FAKE/plan.rc"; expect fail dry-run-error 'dry run failed'
reset; printf ' Container homelab-new-1 Creating \n' > "$FAKE/plan"; expect fail not-created 'homelab-new-1 (not created)'

reset; printf ' Container web Recreate \n Container web Recreated \n' > "$FAKE/plan"
echo 'web sha256:new sha256:old img:latest bridge h1' > "$FAKE/c.web"; echo sha256:new > "$FAKE/tag.img:latest"; echo h1 > "$FAKE/hash.web"
expect pass watchtower-labels 'Warning: Watchtower'

reset; printf ' Container web Recreate \n' > "$FAKE/plan"
echo 'web sha256:old sha256:old img:latest bridge h1' > "$FAKE/c.web"; echo sha256:new > "$FAKE/tag.img:latest"; echo h1 > "$FAKE/hash.web"
expect fail newer-image-pulled 'would change'

reset; printf ' Container web Recreate \n' > "$FAKE/plan"
echo 'web sha256:new sha256:old img:latest bridge h1' > "$FAKE/c.web"; echo sha256:new > "$FAKE/tag.img:latest"; echo h2 > "$FAKE/hash.web"
expect fail config-changed 'would change'

reset; printf ' Container vpn-app Recreate \n' > "$FAKE/plan"
echo 'app sha256:new sha256:old img:latest container:abc h1' > "$FAKE/c.vpn-app"; echo sha256:new > "$FAKE/tag.img:latest"; echo true > "$FAKE/running.abc"
expect pass service-network-labels 'Warning: Watchtower'

reset; printf ' Container vpn-app Recreate \n' > "$FAKE/plan"
echo 'app sha256:new sha256:old img:latest container:dead h1' > "$FAKE/c.vpn-app"; echo sha256:new > "$FAKE/tag.img:latest"
expect fail service-network-parent-gone 'would change'

reset; printf ' Container vpn-app Recreate \n' > "$FAKE/plan"
echo 'app sha256:new sha256:new img:latest container:abc h1' > "$FAKE/c.vpn-app"; echo sha256:new > "$FAKE/tag.img:latest"; echo true > "$FAKE/running.abc"
expect fail service-network-config-changed 'would change'

reset; printf 'web|web|running|0|unhealthy\n' > "$FAKE/ps"; expect fail unhealthy 'web (unhealthy)'
reset; printf 'web|web|running|0|healthy\ninit|init|exited|0|\n' > "$FAKE/ps"; echo on-failure > "$FAKE/policy.init"; expect pass one-shot-on-failure

reset; printf 'web|web|exited|137|\n' > "$FAKE/ps"; echo unless-stopped > "$FAKE/policy.web"; expect fail stopped 'web (exited, exit 137)'
reset; printf 'web|web|running|0|healthy\ninit|init|exited|0|\n' > "$FAKE/ps"; echo no > "$FAKE/policy.init"; expect pass one-shot-done
reset; printf 'job|job|exited|1|\n' > "$FAKE/ps"; echo no > "$FAKE/policy.job"; expect fail one-shot-failed 'job (exited, exit 1)'
