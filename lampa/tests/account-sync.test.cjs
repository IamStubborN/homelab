const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../plugins/account-sync.js'), 'utf8');

function harness({ready = true} = {}) {
  const events = {};
  const timers = new Map();
  const calls = [];
  let now = 0, id = 0, bookmarks = [], done, bookmarkReads = 0, intervalCount = 0;
  const listen = prefix => ({ follow(name, fn) { events[prefix + name] = fn; } });
  const account = {
    Permit: { sync: true, account: { profile: { id: 1 } } },
    Timeline: { update() { calls.push('timeline'); } },
    Bookmarks: {
            update(callback) { calls.push('bookmarks'); done = callback; },
    },
  };
  const player = { opened: () => player.playing, playing: false, listener: listen('player:') };
  const document = { hidden: false, addEventListener(name, fn) { events[name] = fn; } };
  const window = { appready: ready, addEventListener(name, fn) { events[name] = fn; } };
  const context = {
    document, window, console, Date: { now: () => now },
    Lampa: { Account: account, Favorite: { all() { assert.equal(window.appready, true, 'Favorite methods exist before their internal data is initialized'); bookmarkReads++; return bookmarks; } }, Player: player, Activity: { listener: listen('activity:') },
      Listener: { ...listen(''), send(name, data) { calls.push([name, data]); events.activity({ type: 'start' }); } } },
    setTimeout(fn) { timers.set(++id, fn); return id; },
    clearTimeout(key) { timers.delete(key); },
    setInterval(fn, ms) { assert.equal(ms, 60000); intervalCount++; events.interval = fn; },
  };
  window.Lampa = context.Lampa;
  vm.runInNewContext(source, context);
  return {
    calls, events, player, document, account, window,
    get bookmarkReads() { return bookmarkReads; }, get intervalCount() { return intervalCount; },
    advance(ms) { now += ms; },
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    complete(value = bookmarks) { bookmarks = value; done(); },
    reload() { vm.runInNewContext(source, context); },
  };
}

test('syncs native history and progress; refreshes changed cached lists without a refresh loop', () => {
  const h = harness();
  h.flush();
  assert.deepEqual(h.calls, ['timeline', 'bookmarks']);
  h.events.interval();
  assert.equal(h.calls.length, 2, 'no overlapping bookmark request');
  h.complete([{ id: 42 }]);
  assert.equal(h.calls[2][0], 'state:changed');
  assert.equal(h.calls[2][1].reason, 'read');
  h.flush();
  assert.equal(h.calls.length, 3, 'refresh-triggered navigation is throttled');
  h.advance(60000);
  h.events.interval();
  h.complete();
  assert.equal(h.calls.length, 5, 'unchanged history does not refresh');
  h.reload();
  h.flush();
  assert.equal(h.calls.length, 5, 'repeated plugin injection is harmless');
});

test('resumes on focus, visibility and navigation; skips hidden, playing and signed-out sessions', () => {
  const h = harness();
  h.document.hidden = true;
  h.flush();
  assert.equal(h.calls.length, 0);
  h.document.hidden = false;
  h.events.visibilitychange(); h.flush(); h.complete();
  assert.equal(h.calls.length, 2);
  h.advance(16000);
  h.player.playing = true;
  h.events.interval();
  assert.equal(h.calls.length, 2);
  h.player.playing = false;
  h.events['player:destroy'](); h.flush(); h.complete();
  assert.equal(h.calls.length, 4);
  h.advance(16000);
  h.events.activity({ type: 'start' }); h.flush(); h.complete();
  assert.equal(h.calls.length, 6);
  h.advance(16000);
  h.events.focus(); h.flush(); h.complete();
  assert.equal(h.calls.length, 8);
  h.advance(16000);
  h.events['activity:popstate'](); h.flush(); h.complete();
  assert.equal(h.calls.length, 10);
  h.account.Permit.sync = false;
  h.advance(60000); h.events.interval();
  assert.equal(h.calls.length, 10);
});

test('late responses do not refresh a playing screen or a different profile', () => {
  const h = harness();
  h.flush();
  h.player.playing = true;
  h.complete([{ id: 1 }]);
  assert.equal(h.calls.length, 2);
  h.player.playing = false;
  h.advance(16000); h.events.interval();
  h.account.Permit.account.profile.id = 2;
  h.complete([{ id: 2 }]);
  assert.equal(h.calls.length, 4);
});


test('moving the same card between folders refreshes its markers', () => {
  const h = harness();
  h.flush();
  h.complete({ history: [{ id: 42 }], viewed: [] });
  h.flush();
  h.advance(16000); h.events.interval();
  h.complete({ history: [], viewed: [{ id: 42 }] });
  assert.equal(h.calls.filter(call => Array.isArray(call)).length, 2);
});


test('account sync waits for native Favorite initialization and starts only once', () => {
  const h = harness({ready: false}); h.reload();
  assert.equal(h.bookmarkReads, 0); assert.equal(h.intervalCount, 0);
  h.events.app({type: 'start'});
  assert.equal(h.bookmarkReads, 0);
  h.window.appready = true; h.events.app({type: 'ready'});
  assert.equal(h.bookmarkReads, 1); assert.equal(h.intervalCount, 1);
  h.flush(); assert.deepEqual(h.calls, ['timeline', 'bookmarks']);
  h.events.app({type: 'ready'}); h.reload();
  assert.equal(h.bookmarkReads, 1); assert.equal(h.intervalCount, 1);
});
