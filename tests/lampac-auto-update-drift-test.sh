#!/bin/sh
# A Lampa container that does not match the root Compose model, or a model
# that does not build, is reported once and retried nightly; it never marks
# the upstream digest as failed.
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state" "$TMP/root"
touch "$TMP/root/compose.yml"
printf '%s\n' '{"phase":"applied","upstream":"ghcr.io/lampac-nextgen/lampac@sha256:old"}' > "$TMP/state/pending.json"
MODEL=$(printf 'a%.0s' $(seq 64))
OLD=$(printf 'b%.0s' $(seq 64))

# The model hash comes from $TMP/model (empty: config fails); the running
# container's labels come from $TMP/deployed.
cat > "$TMP/bin/docker" <<'EOF2'
#!/bin/sh
case "$*" in
  'pull -q '*) ;;
  'image inspect '*) echo 'ghcr.io/lampac-nextgen/lampac@sha256:new' ;;
  'compose -p homelab '*' config --hash lampa') [ -s "$TEST_DIR/model" ] && echo "lampa $(cat "$TEST_DIR/model")" ;;
  *'config-hash'*' lampa') cat "$TEST_DIR/deployed" ;;
  *'config_files'*' lampa') echo "$LAMPA_ROOT/compose.yml" ;;
  *) exit 1 ;;
esac
EOF2
chmod +x "$TMP/bin/docker"

run() {
  PATH="$TMP/bin:$PATH" LAMPA_ROOT="$TMP/root" LAMPAC_UPDATE_STATE="$TMP/state" \
    TEST_DIR="$TMP" "$ROOT/lampa/auto-update.sh" > "$TMP/out" 2>&1 || echo $? > "$TMP/code"
}
expect_wait() {
  rm -f "$TMP/code"; run
  test "$(cat "$TMP/code" 2>/dev/null)" = 1 || { cat "$TMP/out"; echo "expected exit 1"; exit 1; }
  test ! -e "$TMP/state/auto/failed-upstream"
}

echo "$MODEL" > "$TMP/model"
echo "$OLD $TMP/root/compose.yml $TMP/root" > "$TMP/deployed"
expect_wait
grep -q 'правки Compose для Lampa не применены' "$TMP/out"
grep -q 'up -d --no-deps --no-build --pull never --force-recreate lampa' "$TMP/out"
expect_wait
if grep -q 'Lampac:' "$TMP/out"; then echo "drift reported twice"; exit 1; fi

# Same hash, but an override file was added since the container was created.
touch "$TMP/root/compose.override.yml"
echo "$MODEL $TMP/root/compose.yml $TMP/root" > "$TMP/deployed"
expect_wait
grep -q 'правки Compose для Lampa не применены' "$TMP/out"
rm "$TMP/root/compose.override.yml"

: > "$TMP/model"
expect_wait
grep -q 'Compose-модель Lampa не собирается' "$TMP/out"
expect_wait
if grep -q 'Lampac:' "$TMP/out"; then echo "invalid model reported twice"; exit 1; fi

echo "$MODEL" > "$TMP/model"
rm -f "$TMP/code"
DRY_RUN=1 run
test ! -e "$TMP/code"
grep -q 'DRY_RUN: would wait' "$TMP/out"
test ! -e "$TMP/state/auto/drift-notified"
# After a rollback the failed digest is pending; it is retried once
# failed-upstream is removed, and skipped while it is there.
printf '%s\n' '{"phase":"rolled-back","upstream":"ghcr.io/lampac-nextgen/lampac@sha256:new"}' > "$TMP/state/pending.json"
mkdir -p "$TMP/state/auto"
echo 'ghcr.io/lampac-nextgen/lampac@sha256:new' > "$TMP/state/auto/failed-upstream"
DRY_RUN=1 run
grep -q 'failed here before' "$TMP/out"
rm "$TMP/state/auto/failed-upstream"
DRY_RUN=1 run
grep -q 'DRY_RUN: would wait' "$TMP/out"
echo "Lampac auto-update drift tests passed"
