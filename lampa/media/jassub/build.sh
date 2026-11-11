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

# Metric-compatible stand-ins for Windows fonts that subtitles name without
# attaching them (the plugin renames them). Pinned and checked.
fonts=https://raw.githubusercontent.com/google/fonts/47d54ca1ebb14fd864695f1d39dc734f39017c33
mkdir -p fonts
while read -r sum path; do
  mkdir -p "fonts/$(dirname "$path")"
  wget -q -O "fonts/$path" "$fonts/$path"
done < fonts.sha256
(cd fonts && sha256sum -c ../fonts.sha256)
for path in $(awk '/\.ttf$/ {print $2}' fonts.sha256); do
  # ComicRelief-Bold.ttf -> comic-relief-bold.ttf
  name=$(basename "$path" .ttf | sed 's/\([a-z]\)\([A-Z]\)/\1-\2/g; s/-\{1,\}/-/g' | tr 'A-Z' 'a-z')
  cp "fonts/$path" "$out/$name.ttf"
done
{
  echo "Tinos, Cousine, Carlito and Comic Relief: SIL Open Font License 1.1 (Tinos carries it in its name table)."
  for path in $(awk '/OFL\.txt$/ {print $2}' fonts.sha256); do echo; echo "== $path"; cat "fonts/$path"; done
} > "$out/FONTS-LICENSE.txt"
