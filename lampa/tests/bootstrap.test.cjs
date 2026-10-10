const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const bootstrap = fs.readFileSync(path.join(__dirname, '../config/lampainit-invc.js'), 'utf8');

function harness(android, initial = {}) {
  const storage = new Map(Object.entries(initial));
  const defaults = new Map();
  const choices = new Map();
  const listeners = [];
  const writes = [];
  const probes = [];
  let gstAvailable = false;
  const Lampa = {
    Platform: { is: name => android && name === 'android' },
    // Match Lampa's public Params.select: register choices/default without
    // overwriting a value already persisted in Storage.
    Params: { select(name, values, fallback) { choices.set(name, values); defaults.set(name, fallback); } },
    Storage: {
      get: (name, fallback) => storage.has(name) ? storage.get(name) : fallback,
      field: name => storage.has(name) ? storage.get(name) : defaults.get(name),
      remove: name => storage.delete(name),
      set(name, value) {
        storage.set(name, value);
        writes.push({ name, value });
        for (const listener of [...listeners]) listener({ name, value });
      },
      listener: { follow(name, listener) { assert.equal(name, 'change'); listeners.push(listener); } },
    },
    Torserver: {
      connected(success, fail) { probes.push({ success, fail }); },
      gstWork: () => storage.get('torrserver_gts') && gstAvailable,
    },
  };
  const context = { Lampa, window: { location: { origin: 'https://lampa.test' } } };
  vm.runInNewContext(bootstrap, context, { filename: 'lampainit-invc.js' });
  return {
    hooks: context.lampainit_invc, storage, choices, listeners, writes, probes,
    set: Lampa.Storage.set,
    gstWork: Lampa.Torserver.gstWork,
    finishProbe() {
      assert.ok(probes.length, 'TorrServer must have been checked first');
      probes.at(-1).success({ CacheSize: 64 });
      // Native connected checks /gst/echo after its settings callback.
      gstAvailable = true;
    },
  };
}

test('saved torrents can use embedded Android playback without first opening a new torrent', () => {
  const h = harness(true, { player_torrent: 'inner' });
  h.hooks.appload();
  assert.equal(h.probes.length, 0, 'do not check before the app is ready');
  assert.equal(h.gstWork(), false, 'saved torrent entry does not discover GStreamer itself');
  h.hooks.appready();
  assert.equal(h.probes.length, 1);
  h.hooks.appload();
  h.hooks.appready();
  h.set('unrelated_preference', 'value');
  assert.equal(h.probes.length, 1, 'repeated setup must not cancel an in-flight TorrServer request');
  h.finishProbe();
  assert.equal(h.gstWork(), true, 'the saved torrent can now choose the embedded HLS pipeline');
});

test('switching from external to embedded discovers HLS without restarting an in-flight check', () => {
  const h = harness(true, { player_torrent: 'android' });
  h.hooks.appready();
  assert.equal(h.probes.length, 0, 'external playback does not probe GStreamer');
  h.set('player_torrent', 'inner');
  assert.equal(h.probes.length, 1);
  h.set('player_torrent', 'inner');
  h.set('player_torrent', 'android');
  h.set('player_torrent', 'inner');
  assert.equal(h.probes.length, 1, 'rapid player changes leave the first request intact');
  h.finishProbe();
  assert.equal(h.gstWork(), true);
  h.hooks.appload();
  h.set('player_torrent', 'android');
  h.set('player_torrent', 'inner');
  assert.equal(h.probes.length, 1, 'an already discovered server needs no new check');
});

test('browser playback uses HLS without replacing its player choice', () => {
  const h = harness(false, { player_torrent: 'inner' });
  h.hooks.appload();
  h.hooks.appready();
  assert.equal(h.storage.get('torrserver_gts'), true);
  assert.equal(h.storage.get('player_torrent'), 'inner');
  assert.equal(h.choices.has('player_torrent'), false);
  assert.equal(h.probes.length, 0, 'browser setup must not clear active TorServer requests');
});

test('Android exposes the embedded player while retaining external direct playback by default', () => {
  const h = harness(true);
  h.hooks.appload();
  h.hooks.appready();
  assert.deepEqual(Object.keys(h.choices.get('player_torrent')), ['inner', 'android']);
  assert.equal(h.storage.has('player_torrent'), false, 'registration must not persist an unsolicited choice');
  assert.equal(h.storage.get('torrserver_gts'), false);
  assert.equal(h.probes.length, 0);
});

for (const [player, hls] of [['android', false], ['inner', true]]) {
  test(`persisted Android ${player} choice selects the corresponding stream pipeline`, () => {
    const h = harness(true, { player_torrent: player });
    h.hooks.appload();
    h.hooks.appready();
    assert.equal(h.storage.get('player_torrent'), player);
    assert.equal(h.storage.get('torrserver_gts'), hls);
  });
}

test('Android player changes switch HLS immediately with one listener across repeated lifecycle hooks', () => {
  const h = harness(true);
  h.hooks.appload();
  h.hooks.appready();
  h.hooks.appload();
  assert.equal(h.listeners.length, 1);
  for (const [player, expected] of [['inner', true], ['android', false], ['inner', true]]) {
    const before = h.writes.filter(item => item.name === 'torrserver_gts').length;
    h.set('player_torrent', player);
    assert.equal(h.storage.get('torrserver_gts'), expected);
    assert.equal(h.writes.filter(item => item.name === 'torrserver_gts').length, before + 1);
    assert.equal(h.listeners.length, 1);
  }
  const before = h.writes.length;
  h.set('unrelated_preference', 'value');
  assert.equal(h.writes.length, before + 1, 'unrelated changes do not reconfigure playback');
});
