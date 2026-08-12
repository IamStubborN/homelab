#!/bin/sh
set -eu
old_url="https://integrate.api.nvidia.com/v1/ranking"
new_url="https://ai.api.nvidia.com/v1/retrieval/nvidia/reranking"
old_model="nvidia/nv-rerankqa-mistral-4b-v3"
new_model="nv-rerank-qa-mistral-4b:1"
find /app/open-sse /app/.build/next/server/chunks -type f \( -name "*.ts" -o -name "*.js" \) -exec sed -i "s#$old_url#$new_url#g; s#$old_model#$new_model#g" {} +
# Google OpenAI-compatible embeddings accept `dimensions`; OmniRoute also sent an invalid native field.
sed -i '/if (provider === "gemini" && upstreamBody.outputDimensionality === undefined) {/,/^  }$/d' /app/open-sse/handlers/embeddings.ts
find /app/.build/next/server/chunks -type f -name "*.js" -exec perl -0pi -e 's/if\("gemini"===\w+&&void 0===\w+\.outputDimensionality\)\{let \w+=Number\(\w+\.dimensions\);Number\.isFinite\(\w+\)&&\w+>0&&\(\w+\.outputDimensionality=\w+\)\}//g' {} +

# The official server owns schema creation and migrations. Start it first, then
# wait for the provider tables before applying our idempotent registrations.
node dev/run-standalone.mjs &
server_pid=$!

# Invoked by the signal/EXIT traps below.
# shellcheck disable=SC2329
stop_server() {
  if kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
  fi
  wait "$server_pid" 2>/dev/null || true
}
trap stop_server EXIT HUP INT TERM

attempts=0
until node -e '
  const Database = require("better-sqlite3");
  const db = new Database("/app/data/storage.sqlite", { fileMustExist: true, readonly: true });
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?)"
  ).all("table", "provider_nodes", "provider_connections");
  if (names.length !== 2) process.exit(1);
' >/dev/null 2>&1; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit $?
  fi
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 90 ]; then
    echo "OmniRoute provider schema was not ready within 90 seconds" >&2
    exit 1
  fi
  sleep 1
done

# Register internal OpenAI-compatible endpoints idempotently.
node - <<'NODE'
const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require("crypto");
const Database = require("better-sqlite3");

const db = new Database("/app/data/storage.sqlite");
const now = new Date().toISOString();
const upsertNode = db.prepare(
  [
    "INSERT INTO provider_nodes",
    "(id, type, name, prefix, api_type, base_url, chat_path, models_path, created_at, updated_at)",
    "VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
    "ON CONFLICT(id) DO UPDATE SET name=excluded.name, prefix=excluded.prefix,",
    "api_type=excluded.api_type, base_url=excluded.base_url,",
    "models_path=excluded.models_path, updated_at=excluded.updated_at",
  ].join(" ")
);

upsertNode.run(
  "ollama-ipex",
  "openai-compatible",
  "Ollama IPEX-LLM",
  "ollama-ipex",
  "embeddings",
  "http://ollama-ipex.local:11434/v1",
  "/models",
  now,
  now
);

const cursorNodeId = "openai-compatible-chat-c04550c1-9e55-4111-8111-c0550c01de00";
const cursorConnectionId = "c04550c1-9e55-4111-8111-c0550c01de01";
const cursorBaseUrl = "http://cursorpipe:8080/v1";
const cursorPrefix = "cursorpipe";
const cursorName = "Cursor SDK";
const cursorBearer = process.env.CURSORPIPE_BEARER_TOKEN;

upsertNode.run(
  cursorNodeId,
  "openai-compatible",
  cursorName,
  cursorPrefix,
  "chat",
  cursorBaseUrl,
  "/models",
  now,
  now
);

if (typeof cursorBearer === "string" && cursorBearer.trim() !== "") {
  const secret = process.env.STORAGE_ENCRYPTION_KEY;
  const key =
    typeof secret === "string" && secret.trim() !== ""
      ? scryptSync(secret, "omniroute-field-encryption-v1", 32)
      : null;

  const encrypt = (plaintext) => {
    if (!key) return plaintext;
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
    return `enc:v1:${iv.toString("hex")}:${encrypted}:${cipher.getAuthTag().toString("hex")}`;
  };

  const decrypt = (ciphertext) => {
    if (typeof ciphertext !== "string" || ciphertext === "") return ciphertext;
    if (!key || !ciphertext.startsWith("enc:v1:")) return ciphertext;
    const parts = ciphertext.slice("enc:v1:".length).split(":");
    if (parts.length !== 3) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "hex"), {
      authTagLength: 16,
    });
    decipher.setAuthTag(Buffer.from(parts[2], "hex"));
    return decipher.update(parts[1], "hex", "utf8") + decipher.final("utf8");
  };

  const psd = JSON.stringify({
    prefix: cursorPrefix,
    apiType: "chat",
    baseUrl: cursorBaseUrl,
    nodeName: cursorName,
    modelsPath: "/models",
    apiKeyHealth: {},
  });

  const existing = db
    .prepare("SELECT api_key FROM provider_connections WHERE id = ?")
    .get(cursorConnectionId);
  let current = null;
  if (existing && typeof existing.api_key === "string") {
    try {
      current = decrypt(existing.api_key);
    } catch {
      current = null;
    }
  }

  if (!existing) {
    db.prepare(
      [
        "INSERT INTO provider_connections",
        "(id, provider, auth_type, name, priority, is_active, api_key, provider_specific_data,",
        "created_at, updated_at)",
        "VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)",
      ].join(" ")
    ).run(cursorConnectionId, cursorNodeId, "apikey", "main", encrypt(cursorBearer.trim()), psd, now, now);
  } else if (current !== cursorBearer.trim()) {
    db.prepare(
      [
        "UPDATE provider_connections SET api_key = ?, provider_specific_data = ?,",
        "is_active = 1, updated_at = ? WHERE id = ?",
      ].join(" ")
    ).run(encrypt(cursorBearer.trim()), psd, now, cursorConnectionId);
  } else {
    db.prepare(
      "UPDATE provider_connections SET provider_specific_data = ?, is_active = 1, updated_at = ? WHERE id = ?"
    ).run(psd, now, cursorConnectionId);
  }
}

NODE

set +e
wait "$server_pid"
server_status=$?
set -e
trap - EXIT HUP INT TERM
exit "$server_status"
