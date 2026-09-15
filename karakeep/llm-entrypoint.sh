#!/bin/sh
set -eu
OPENAI_API_KEY=$(tr -d '\n' < /run/secrets/karakeep_cliproxy_api_key)
EMBEDDING_OPENAI_API_KEY=$(tr -d '\n' < /run/secrets/karakeep_nvidia_api_key)
export OPENAI_API_KEY EMBEDDING_OPENAI_API_KEY
exec /init
