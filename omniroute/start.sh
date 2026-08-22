#!/bin/sh
set -eu
read_secret() {
  var=$1
  file=$2
  if [ ! -s "$file" ]; then
    echo "missing secret file: $file" >&2
    exit 1
  fi
  value=$(tr -d '\n' < "$file")
  export "$var=$value"
}
read_secret JWT_SECRET /run/secrets/omniroute_jwt_secret
read_secret API_KEY_SECRET /run/secrets/omniroute_api_key_secret
read_secret STORAGE_ENCRYPTION_KEY /run/secrets/omniroute_storage_encryption_key
read_secret INITIAL_PASSWORD /run/secrets/omniroute_initial_password

old_url="https://integrate.api.nvidia.com/v1/ranking"
new_url="https://ai.api.nvidia.com/v1/retrieval/nvidia/reranking"
old_model="nvidia/nv-rerankqa-mistral-4b-v3"
new_model="nv-rerank-qa-mistral-4b:1"
find /app/open-sse /app/.build/next/server/chunks -type f \( -name "*.ts" -o -name "*.js" \) -exec sed -i "s#$old_url#$new_url#g; s#$old_model#$new_model#g" {} +
# Google OpenAI-compatible embeddings accept `dimensions`; OmniRoute also sent an invalid native field.
sed -i '/if (provider === "gemini" && upstreamBody.outputDimensionality === undefined) {/,/^  }$/d' /app/open-sse/handlers/embeddings.ts
find /app/.build/next/server/chunks -type f -name "*.js" -exec perl -0pi -e 's/if\("gemini"===\w+&&void 0===\w+\.outputDimensionality\){let \w+=Number\(\w+\.dimensions\);Number\.isFinite\(\w+\)&&\w+>0&&\(\w+\.outputDimensionality=\w+\)}//g' {} +

exec node dev/run-standalone.mjs
