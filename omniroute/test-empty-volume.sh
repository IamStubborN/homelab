#!/bin/sh
set -eu

ROOT=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)
IMAGE=${OMNIROUTE_IMAGE:-ghcr.io/diegosouzapw/omniroute:latest}
SUFFIX=$$
NETWORK="omniroute-empty-test-$SUFFIX"
REDIS="omniroute-empty-redis-$SUFFIX"
APP="omniroute-empty-app-$SUFFIX"
VOLUME="omniroute-empty-data-$SUFFIX"

cleanup() {
  docker container rm -f "$APP" "$REDIS" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker network create "$NETWORK" >/dev/null
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$REDIS" --network "$NETWORK" redis:8-alpine >/dev/null
docker run -d --name "$APP" --network "$NETWORK" \
  -e NODE_ENV=production \
  -e PORT=20128 \
  -e API_PORT=20129 \
  -e HOSTNAME=0.0.0.0 \
  -e API_HOST=0.0.0.0 \
  -e DATA_DIR=/app/data \
  -e REDIS_URL="redis://$REDIS:6379" \
  -e JWT_SECRET=test-jwt-secret-00000000000000000000000000000000 \
  -e API_KEY_SECRET=test-api-key-secret-00000000000000000000000000000 \
  -e STORAGE_ENCRYPTION_KEY=test-storage-encryption-key-000000000000000000000 \
  -e INITIAL_PASSWORD=test-initial-password-000000000000000000000000000 \
  -e REQUIRE_API_KEY=true \
  -e AUTH_COOKIE_SECURE=true \
  -e NEXT_PUBLIC_BASE_URL=https://omniroute.example.invalid \
  -e BASE_URL=http://127.0.0.1:20128 \
  -e OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS=true \
  -e CURSORPIPE_BEARER_TOKEN=test-cursor-token \
  -v "$VOLUME:/app/data" \
  -v "$ROOT/omniroute/start.sh:/app/patches/start.sh:ro" \
  "$IMAGE" /bin/sh /app/patches/start.sh >/dev/null

wait_for_rows() {
  attempts=0
  while [ "$attempts" -lt 90 ]; do
    if docker exec "$APP" node -e '
      const Database = require("better-sqlite3");
      const db = new Database("/app/data/storage.sqlite", { readonly: true });
      const nodes = db.prepare("SELECT count(*) AS count FROM provider_nodes WHERE id IN (?, ?)")
        .get("ollama-ipex", "openai-compatible-chat-c04550c1-9e55-4111-8111-c0550c01de00").count;
      const connections = db.prepare("SELECT count(*) AS count FROM provider_connections WHERE id = ?")
        .get("c04550c1-9e55-4111-8111-c0550c01de01").count;
      if (nodes !== 2 || connections !== 1) process.exit(1);
    ' >/dev/null 2>&1; then
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$APP")" != true ]; then
      docker logs "$APP"
      return 1
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  docker logs "$APP"
  return 1
}

wait_for_rows
sleep 2
test "$(docker inspect -f '{{.State.Running}}' "$APP")" = true
docker restart "$APP" >/dev/null
wait_for_rows
sleep 2
test "$(docker inspect -f '{{.State.Running}}' "$APP")" = true

echo "PASS: OmniRoute initializes and reuses an empty data volume"
