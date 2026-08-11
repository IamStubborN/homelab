#!/usr/bin/env bash
set -euo pipefail

umask 077
root=$(cd "$(dirname "$0")/.." && pwd)
output=${1:-"$root/backups/hindsight-$(date +%Y%m%d-%H%M%S).dump"}
mkdir -p "$(dirname "$output")"

docker exec hindsight-db pg_dump -U hindsight -d hindsight --format=custom >"$output"
test -s "$output"
printf '%s\n' "$output"
