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
# Register the internal OpenAI-compatible embedding endpoint idempotently.
node - <<NODE
const Database = require("better-sqlite3");
const db = new Database("/app/data/storage.sqlite");
const now = new Date().toISOString();
const sql = [
  "INSERT INTO provider_nodes",
  "(id, type, name, prefix, api_type, base_url, chat_path, models_path, created_at, updated_at)",
  "VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
  "ON CONFLICT(id) DO UPDATE SET name=excluded.name, prefix=excluded.prefix,",
  "api_type=excluded.api_type, base_url=excluded.base_url,",
  "models_path=excluded.models_path, updated_at=excluded.updated_at",
].join(" ");
db.prepare(sql).run("ollama-ipex", "openai-compatible", "Ollama IPEX-LLM", "ollama-ipex", "embeddings", "http://ollama-ipex.local:11434/v1", "/models", now, now);
NODE
exec node dev/run-standalone.mjs
