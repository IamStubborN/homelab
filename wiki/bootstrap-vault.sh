#!/bin/sh
# Idempotent llm-wiki layout under WIKI_ROOT.
# Does not require root, does not SSH, does not overwrite existing
# SCHEMA.md / index.md / log.md / jsonl.
set -eu

usage() {
  cat <<'EOF'
Usage: bootstrap-vault.sh [WIKI_ROOT]

Create the family llm-wiki tree (personal Andrii/Valentyna wikis plus
shared/health). Default WIKI_ROOT is /mnt/internal/wiki, or $WIKI_ROOT
when set. Pass a temp directory for tests.

Does not require root and does not SSH to docker.local. Does not
overwrite existing SCHEMA.md, index.md, log.md, or jsonl files.
Does not create .obsidian/ (obsidian-headless writes that on sync-setup).
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PERSONAL_SCHEMA_EXAMPLE=$REPO_ROOT/health/docs/wiki-SCHEMA.example.md
HEALTH_SCHEMA_EXAMPLE=$REPO_ROOT/health/docs/wiki-health-SCHEMA.example.md

if [ "$#" -eq 1 ]; then
  ROOT=$1
else
  ROOT=${WIKI_ROOT:-/mnt/internal/wiki}
fi

JSONL_NAMES='measurements.jsonl meals.jsonl symptoms.jsonl sleep.jsonl medications.jsonl conditions.jsonl allergies.jsonl labs.jsonl'

copy_schema() {
  src=$1
  dest=$2
  if [ -e "$dest" ]; then
    return 0
  fi
  awk 'p || $0 == "# SCHEMA" { p = 1 } p' "$src" >"$dest"
}

touch_if_absent() {
  dest=$1
  if [ -e "$dest" ]; then
    return 0
  fi
  : >"$dest"
}

if [ ! -f "$PERSONAL_SCHEMA_EXAMPLE" ] || [ ! -f "$HEALTH_SCHEMA_EXAMPLE" ]; then
  echo "bootstrap-vault: missing in-repo SCHEMA examples under $REPO_ROOT/health/docs/" >&2
  exit 1
fi

mkdir -p "$ROOT"
ROOT=$(CDPATH= cd -- "$ROOT" && pwd)

case "$ROOT" in
  "$SCRIPT_DIR" | "$REPO_ROOT")
    echo "bootstrap-vault: refusing to write a live vault into the git clone ($ROOT)" >&2
    exit 1
    ;;
esac

write_personal_index() {
  dest=$1
  if [ -e "$dest" ]; then
    return 0
  fi
  cat >"$dest" <<'EOF'
# Index

This directory is one person's llm-wiki (`WIKI_PATH=/wiki`). See
[SCHEMA](SCHEMA.md).

- [SCHEMA](SCHEMA.md)
- [Log](log.md)

Family notes that both spouses should see live under `shared/` (a
bind-mount, not a copy). Medical facts go through MCP and
`shared/health`; do not store them as personal journal pages.
EOF
}

write_personal_log() {
  dest=$1
  if [ -e "$dest" ]; then
    return 0
  fi
  cat >"$dest" <<'EOF'
# Log

- Vault bootstrap: created personal llm-wiki layout (SCHEMA, index, log,
  raw/, entities/, concepts/).
EOF
}

write_health_index() {
  dest=$1
  if [ -e "$dest" ]; then
    return 0
  fi
  cat >"$dest" <<'EOF'
# Index

Family health wiki. See [SCHEMA](SCHEMA.md).

- [SCHEMA](SCHEMA.md)
- [Log](log.md)
- Current medical picture: `generated/` (MCP-owned; read, never edit)
- Synthesis: `people/{andrii,valentyna}/` and `family/`
- Source documents: `raw/{andrii,valentyna,family}/`
EOF
}

write_health_log() {
  dest=$1
  if [ -e "$dest" ]; then
    return 0
  fi
  cat >"$dest" <<'EOF'
# Log

- Vault bootstrap: created shared health layout (SCHEMA, index, log,
  data/, generated/, people/, family/, raw/).
EOF
}

for person in andrii valentyna; do
  mkdir -p \
    "$ROOT/$person/raw" \
    "$ROOT/$person/entities" \
    "$ROOT/$person/concepts"
  copy_schema "$PERSONAL_SCHEMA_EXAMPLE" "$ROOT/$person/SCHEMA.md"
  write_personal_index "$ROOT/$person/index.md"
  write_personal_log "$ROOT/$person/log.md"
done

mkdir -p \
  "$ROOT/shared/health/data/andrii" \
  "$ROOT/shared/health/data/valentyna" \
  "$ROOT/shared/health/generated" \
  "$ROOT/shared/health/people/andrii" \
  "$ROOT/shared/health/people/valentyna" \
  "$ROOT/shared/health/family" \
  "$ROOT/shared/health/raw/andrii" \
  "$ROOT/shared/health/raw/valentyna" \
  "$ROOT/shared/health/raw/family"

copy_schema "$HEALTH_SCHEMA_EXAMPLE" "$ROOT/shared/health/SCHEMA.md"
write_health_index "$ROOT/shared/health/index.md"
write_health_log "$ROOT/shared/health/log.md"

for person in andrii valentyna; do
  for name in $JSONL_NAMES; do
    touch_if_absent "$ROOT/shared/health/data/$person/$name"
  done
done
