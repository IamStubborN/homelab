#!/usr/bin/env sh
set -eu
umask 077

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
backup_dir="${1:-$script_dir/backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output="$backup_dir/freedium-$timestamp.sql.gz"

mkdir -p "$backup_dir"
cd "$repo_dir"
docker compose exec -T freedium-db pg_dump -U postgres postgres | gzip > "$output"
printf '%s\n' "$output"
