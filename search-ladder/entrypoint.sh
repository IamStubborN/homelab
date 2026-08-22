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
read_secret OMNIROUTE_API_KEY /run/secrets/search_ladder_omniroute_key
read_secret BROKER_API_KEY /run/secrets/search_ladder_broker_key
read_secret FINALIZER_API_KEY /run/secrets/search_ladder_omniroute_key
read_secret RERANKER_API_KEY /run/secrets/search_ladder_omniroute_key
exec /usr/local/bin/search-ladder "$@"
