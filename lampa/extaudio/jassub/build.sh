#!/bin/sh
# Bundle JASSUB into same-origin files the Lampa plugin loads at runtime.
set -eu
out=${1:-dist}
rm -rf "$out" && mkdir -p "$out"
src=node_modules/jassub/dist
npx esbuild "$src/jassub.js" --bundle --format=esm --target=es2020 --minify --outfile="$out/jassub.js"
npx esbuild "$src/worker/worker.js" --bundle --format=esm --target=es2020 --minify --outfile="$out/jassub-worker.js"
cp "$src/wasm/jassub-worker.wasm" "$src/wasm/jassub-worker-modern.wasm" "$src/default.woff2" "$out/"
cp node_modules/jassub/LICENSE "$out/LICENSE.txt"
