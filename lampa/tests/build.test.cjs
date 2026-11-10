const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {build, TARGETS} = require('../tools/build.cjs');

test('every built plugin matches its sources (run node tools/build.cjs after editing src/)', () => {
  for (const [target, source] of Object.entries(TARGETS)) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', target), 'utf8'), build(source), target + ' is stale');
  }
});

test('shared helpers are pulled in at the include line\'s indentation', () => {
  const text = build('src/homelab-sync/history.js');
  assert.match(text, /\n  function remaining\(position, duration\) \{\n    var rest/);
  assert.doesNotMatch(text, /@include/);
});
