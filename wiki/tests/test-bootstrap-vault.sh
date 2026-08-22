#!/bin/sh
# Temp-dir check: bootstrap-vault.sh produces a valid llm-wiki layout.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WIKI_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$WIKI_DIR/.." && pwd)
BOOTSTRAP=$WIKI_DIR/bootstrap-vault.sh
PERSONAL_SCHEMA_EXAMPLE=$REPO_ROOT/health/docs/wiki-SCHEMA.example.md
HEALTH_SCHEMA_EXAMPLE=$REPO_ROOT/health/docs/wiki-health-SCHEMA.example.md

fails=0
assert() {
  msg=$1
  shift
  if "$@"; then
    return 0
  fi
  echo "FAIL: $msg" >&2
  fails=$((fails + 1))
}

assert_file() {
  path=$1
  if [ -f "$path" ]; then
    return 0
  fi
  echo "FAIL: missing file $path" >&2
  fails=$((fails + 1))
}

assert_dir() {
  path=$1
  if [ -d "$path" ]; then
    return 0
  fi
  echo "FAIL: missing directory $path" >&2
  fails=$((fails + 1))
}

assert_file_contains() {
  path=$1
  needle=$2
  if grep -F -q "$needle" "$path"; then
    return 0
  fi
  echo "FAIL: $path does not contain: $needle" >&2
  fails=$((fails + 1))
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

assert "bootstrap is executable" test -x "$BOOTSTRAP"
assert "default path is /mnt/internal/wiki" grep -q '/mnt/internal/wiki' "$BOOTSTRAP"
assert "default is not /opt/data/wiki" sh -c '! grep -q "/opt/data/wiki" "$0"' "$BOOTSTRAP"

"$BOOTSTRAP" "$tmp/wiki"
root=$tmp/wiki

for person in andrii valentyna; do
  assert_dir "$root/$person"
  assert_dir "$root/$person/raw"
  assert_dir "$root/$person/entities"
  assert_dir "$root/$person/concepts"
  assert_file "$root/$person/SCHEMA.md"
  assert_file "$root/$person/index.md"
  assert_file "$root/$person/log.md"
  assert "no personal shared copy/symlink for $person" sh -c '! test -e "$0"' "$root/$person/shared"
  assert_file_contains "$root/$person/SCHEMA.md" "Medical facts go through MCP"
  assert_file_contains "$root/$person/SCHEMA.md" "shared/health"
  assert_file_contains "$root/$person/SCHEMA.md" "Do not store blood pressure"
  expected_personal=$(mktemp)
  awk 'p || $0 == "# SCHEMA" { p = 1 } p' "$PERSONAL_SCHEMA_EXAMPLE" >"$expected_personal"
  assert "$person SCHEMA matches in-repo example" cmp -s "$expected_personal" "$root/$person/SCHEMA.md"
  rm -f "$expected_personal"
done

assert_dir "$root/shared/health"
assert_dir "$root/shared/health/data/andrii"
assert_dir "$root/shared/health/data/valentyna"
assert_dir "$root/shared/health/generated"
assert_dir "$root/shared/health/people/andrii"
assert_dir "$root/shared/health/people/valentyna"
assert_dir "$root/shared/health/family"
assert_dir "$root/shared/health/raw/andrii"
assert_dir "$root/shared/health/raw/valentyna"
assert_dir "$root/shared/health/raw/family"
assert_file "$root/shared/health/SCHEMA.md"
assert_file "$root/shared/health/index.md"
assert_file "$root/shared/health/log.md"
assert_file_contains "$root/shared/health/SCHEMA.md" "person\` on every page"
assert_file_contains "$root/shared/health/SCHEMA.md" "No mixing Andrii and Valentyna on one synthesis page"
assert_file_contains "$root/shared/health/SCHEMA.md" "Never edit \`data/\` or \`generated/\`"
expected_health=$(mktemp)
awk 'p || $0 == "# SCHEMA" { p = 1 } p' "$HEALTH_SCHEMA_EXAMPLE" >"$expected_health"
assert "health SCHEMA matches in-repo example" cmp -s "$expected_health" "$root/shared/health/SCHEMA.md"
rm -f "$expected_health"

assert "did not invent .obsidian" sh -c '! test -e "$0"' "$root/.obsidian"

JSONL_NAMES='measurements.jsonl meals.jsonl symptoms.jsonl sleep.jsonl medications.jsonl conditions.jsonl allergies.jsonl labs.jsonl'
for person in andrii valentyna; do
  for name in $JSONL_NAMES; do
    assert_file "$root/shared/health/data/$person/$name"
  done
done

printf '%s\n' "KEEP-PERSONAL-SCHEMA" >>"$root/andrii/SCHEMA.md"
printf '%s\n' "KEEP-HEALTH-SCHEMA" >>"$root/shared/health/SCHEMA.md"
printf '%s\n' '{"id":"keep-me"}' >>"$root/shared/health/data/andrii/measurements.jsonl"
printf '%s\n' "KEEP-INDEX" >>"$root/valentyna/index.md"
printf '%s\n' "KEEP-LOG" >>"$root/shared/health/log.md"
rm -rf "$root/andrii/entities" "$root/shared/health/people/valentyna"

"$BOOTSTRAP" "$root"

assert_file_contains "$root/andrii/SCHEMA.md" "KEEP-PERSONAL-SCHEMA"
assert_file_contains "$root/shared/health/SCHEMA.md" "KEEP-HEALTH-SCHEMA"
assert_file_contains "$root/shared/health/data/andrii/measurements.jsonl" '{"id":"keep-me"}'
assert_file_contains "$root/valentyna/index.md" "KEEP-INDEX"
assert_file_contains "$root/shared/health/log.md" "KEEP-LOG"
assert_dir "$root/andrii/entities"
assert_dir "$root/shared/health/people/valentyna"

assert "refuses repo root" sh -c 'out=$(mktemp); if "$0" "$1" >"$out" 2>&1; then rm -f "$out"; echo "FAIL: expected non-zero"; exit 1; fi; grep -q "refusing" "$out"; rc=$?; rm -f "$out"; exit "$rc"' "$BOOTSTRAP" "$REPO_ROOT"

if [ "$fails" -ne 0 ]; then
  echo "test-bootstrap-vault: $fails failure(s)" >&2
  exit 1
fi
echo "test-bootstrap-vault: ok"
