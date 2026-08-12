#!/usr/bin/env bash
set -euo pipefail
command -v docker >/dev/null || { echo "docker required" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker daemon unavailable" >&2; exit 1; }
CONTAINER=family-health-it-pg
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=it -e POSTGRES_DB=health -p 127.0.0.1:54329:5432 postgres:17.5-alpine >/dev/null
trap 'docker rm -f "$CONTAINER" >/dev/null' EXIT
until docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do sleep 0.5; done
export DATABASE_URL="postgres://postgres:it@127.0.0.1:54329/health"
cargo nextest run -p health-service --features integration-tests --locked
