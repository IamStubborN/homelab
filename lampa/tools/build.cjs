#!/usr/bin/env node
// Lampa loads every plugin as one plain ES5 file. Large plugins are kept here as ordered parts of
// one closure (src/<target>/NN-*.js, concatenated as text) and helpers several plugins need live
// once in src/shared/, pulled in by a `// @include shared/<file>` line at that line's indentation.
// The built files stay committed, so deployment copies them as before.
//
//   node tools/build.cjs          rebuild every target
//   node tools/build.cjs --check  fail when a built file differs from its sources
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
// Built file → its sources: a directory of parts, or a single file.
const TARGETS = {
  'plugins/torrserver-audio.js': 'src/torrserver-audio',
  'plugins/playlist-thumbnails.js': 'src/playlist-thumbnails.js',
  'mods/HomelabSync/continue.js': 'src/homelab-sync/continue',
  'mods/HomelabSync/history.js': 'src/homelab-sync/history.js',
  'plugins/common-sources.js': 'src/common-sources',
  'mods/HomelabSync/online.js': 'src/homelab-sync/online.js',
  'mods/HomelabSync/quality.js': 'src/homelab-sync/quality.js',
};
const INCLUDE = /^([ \t]*)\/\/ @include (shared\/[a-z0-9-]+\.js)\s*$/;

function include(text, from) {
  return text.split('\n').map(line => {
    const match = INCLUDE.exec(line);
    if (!match) return line;
    const file = path.join(ROOT, 'src', match[2]);
    if (!fs.existsSync(file)) throw new Error(from + ': missing ' + match[2]);
    return fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').map(part => part ? match[1] + part : part).join('\n');
  }).join('\n');
}
function build(source) {
  const full = path.join(ROOT, source);
  const files = fs.statSync(full).isDirectory() ? fs.readdirSync(full).filter(name => /\.js$/.test(name)).sort().map(name => path.join(source, name)) : [source];
  const header = '// Built by tools/build.cjs from ' + source + ': edit the sources there and rebuild.\n';
  return header + files.map(file => include(fs.readFileSync(path.join(ROOT, file), 'utf8'), file)).join('');
}
function main(check) {
  const stale = [];
  for (const [target, source] of Object.entries(TARGETS)) {
    const text = build(source), file = path.join(ROOT, target);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current === text) continue;
    if (check) stale.push(target); else fs.writeFileSync(file, text);
  }
  if (stale.length) { console.error('Out of date, run node tools/build.cjs: ' + stale.join(', ')); process.exitCode = 1; }
}
module.exports = {build, TARGETS};
if (require.main === module) main(process.argv.includes('--check'));
