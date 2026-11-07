const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../plugins/account-sync.js'), 'utf8');

// Fake clock that honours delays, so debounce, deferral and watchdog timing is real.
function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout(key) { timers.delete(key); },
    setInterval(fn, ms) {
      const key = ++id;
      const arm = () => timers.set(key, { fn: () => { arm(); fn(); }, at: now + ms });
      arm();
      return key;
    },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let next;
        for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].fn();
      }
      now = end;
    },
  };
}

// Native Favorite.all() with account sync returns a map of every category, history included.
function categories(extra = {}) {
  return Object.assign({ like: [], wath: [], book: [], history: [], look: [], viewed: [], scheduled: [], continued: [], thrown: [] }, extra);
}

function harness({ ready = true } = {}) {
  const c = clock();
  const handlers = {};
  const on = (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); };
  const emit = (name, data) => (handlers[name] || []).slice().forEach(fn => fn(data));
  const calls = [], pending = [];
  let store = categories(), bookmarkReads = 0, intervals = 0;
  const listen = prefix => ({ follow(name, fn) { on(prefix + name, fn); } });
  const permit = { sync: true, account: { token: 'synthetic', profile: { id: 1 } } };
  const account = {
    Permit: permit,
    listener: listen('account:'),
    Timeline: { update() { calls.push('timeline'); } },
    // Native callbacks can be dropped entirely: Account.Api.clear() empties the shared request list.
    Bookmarks: { update(callback) { calls.push('bookmarks'); pending.push(callback); } },
  };
  const player = { opened: () => player.playing, playing: false, listener: listen('player:') };
  const document = { hidden: false, addEventListener(name, fn) { on(name, fn); } };
  const window = { appready: ready, addEventListener(name, fn) { on(name, fn); } };
  const Lampa = {
    Account: account,
    Favorite: { all() { assert.equal(window.appready, true, 'Favorite methods exist before their internal data is initialized'); bookmarkReads++; return store; } },
    Player: player,
    Activity: { listener: listen('activity:') },
    Storage: { listener: listen('storage:') },
    Listener: {
      ...listen(''),
      send(name, data) {
        calls.push([name, data]);
        emit(name, data);
        // Native Activity answers a favorite read by replacing the screen, which starts it again.
        if (name === 'state:changed' && data.target === 'favorite' && data.reason === 'read') c.setTimeout(() => emit('activity', { type: 'start' }), 1400);
      },
    },
  };
  window.Lampa = Lampa;
  const context = {
    document, window, Lampa, console: { warn() {}, log() {} }, Date: { now: c.now },
    setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    setInterval(fn, ms) { assert.equal(ms, 60000); intervals++; return c.setInterval(fn, ms); },
  };
  vm.runInNewContext(source, context);
  return {
    calls, emit, player, document, account, permit, window, pending,
    refreshes: () => calls.filter(call => Array.isArray(call) && call[0] === 'state:changed'),
    get bookmarkReads() { return bookmarkReads; }, get intervalCount() { return intervals; },
    get requests() { return calls.filter(call => call === 'bookmarks').length; },
    tick: c.tick,
    set(next) { store = next; },
    // Native Bookmarks.update replaced its cache and calls back the newest request.
    complete(next) {
      if (next) store = next;
      assert.ok(pending.length, 'a bookmark request is pending');
      const callback = pending.pop(); pending.length = 0; callback();
    },
    reload() { vm.runInNewContext(source, context); },
  };
}

const card = (id, extra = {}) => Object.assign({ id, title: 'Fictional title ' + id }, extra);

test('first sync runs after the debounce and requests do not overlap', () => {
  const h = harness();
  h.tick(299);
  assert.equal(h.requests, 0);
  h.tick(1);
  assert.deepEqual(h.calls, ['timeline', 'bookmarks']);
  h.emit('focus'); h.tick(20000);
  assert.equal(h.requests, 1, 'no overlapping request while one is in flight');
});

test('a dropped native callback is released by the watchdog and its late callback is ignored', () => {
  const h = harness();
  h.tick(300);
  const lost = h.pending.shift();
  h.tick(29000);
  h.emit('focus'); h.tick(300);
  assert.equal(h.requests, 1, 'still waiting on the dropped request');
  h.tick(1000);
  h.emit('focus'); h.tick(300);
  assert.equal(h.requests, 2, 'watchdog released the busy flag');
  h.set(categories({ book: [card(7)] }));
  lost();
  assert.equal(h.refreshes().length, 0, 'a late callback from an abandoned attempt changes nothing');
  h.complete();
  assert.equal(h.refreshes().length, 1, 'the current attempt still refreshes');
});

test('only real bookmark changes refresh screens; history and order are ignored', () => {
  const h = harness();
  h.tick(300);
  h.complete(categories({ history: [card(1)] }));
  assert.equal(h.refreshes().length, 0, 'history-only change on another device');
  h.tick(60000);
  h.complete(categories({ history: [card(2), card(1)], book: [card(3), card(4)] }));
  assert.equal(h.refreshes().length, 1, 'a new bookmark refreshes once');
  assert.equal(h.refreshes()[0][1].reason, 'read');
  h.tick(60000);
  h.complete(categories({ history: [card(1), card(2)], book: [card(4), card(3)] }));
  assert.equal(h.refreshes().length, 1, 'reordering is not a change');
  h.tick(60000);
  h.complete(categories({ history: [card(1)], book: [card(4)], viewed: [card(3)] }));
  assert.equal(h.refreshes().length, 2, 'moving a card between folders is a change');
  h.tick(60000);
  h.complete(categories({ history: [card(1)], book: [card(4)], viewed: [card(3, { title: 'Renamed' })] }));
  assert.equal(h.refreshes().length, 2, 'card metadata changes are not membership changes');
  h.tick(60000);
  h.complete(categories({ history: [card(1)], book: [card(4)], viewed: [card(3, { name: 'Fictional series' })] }));
  assert.equal(h.refreshes().length, 3, 'a series with the same numeric id is a different card');
});

test('native favorite notifications resnapshot, so this device’s own changes are not refreshed again', () => {
  const h = harness();
  h.tick(300); h.complete();
  h.set(categories({ book: [card(5)] }));
  h.emit('state:changed', { target: 'favorite', reason: 'update', method: 'add', type: 'book' });
  h.tick(60000); h.complete();
  assert.equal(h.refreshes().length, 0);
});

test('refresh-triggered navigation does not loop', () => {
  const h = harness();
  h.tick(300);
  h.complete(categories({ book: [card(9)] }));
  assert.equal(h.refreshes().length, 1);
  h.tick(15000);
  assert.equal(h.requests, 2, 'the replaced screen start was deferred, not dropped');
  h.complete();
  h.tick(15000);
  assert.equal(h.requests, 2);
  assert.equal(h.refreshes().length, 1, 'unchanged bookmarks do not refresh again');
});

test('triggers inside the 15-second spacing are deferred to its end', () => {
  const h = harness();
  h.tick(300); h.complete();
  h.tick(5000);
  h.emit('activity', { type: 'start' });
  h.tick(9999);
  assert.equal(h.requests, 1);
  h.tick(1);
  assert.equal(h.requests, 2);
});

test('skips hidden, playing and signed-out sessions; resumes on focus, visibility and navigation', () => {
  const h = harness();
  h.document.hidden = true;
  h.tick(300);
  assert.equal(h.requests, 0);
  h.document.hidden = false;
  h.emit('visibilitychange'); h.tick(300); h.complete();
  assert.equal(h.requests, 1);
  for (const trigger of ['focus', 'activity', 'activity:popstate']) {
    const before = h.requests;
    h.tick(16000); h.emit(trigger, { type: 'start' }); h.tick(300);
    assert.equal(h.requests, before + 1, trigger);
    h.complete();
  }
  h.player.playing = true;
  h.tick(60000);
  assert.equal(h.requests, 4);
  h.player.playing = false;
  h.emit('player:destroy'); h.tick(300); h.complete();
  assert.equal(h.requests, 5);
  h.permit.sync = false;
  h.tick(120000);
  assert.equal(h.requests, 5);
});

test('late responses do not refresh a playing screen; the change is applied after playback', () => {
  const h = harness();
  h.tick(300);
  h.player.playing = true;
  h.complete(categories({ book: [card(1)] }));
  assert.equal(h.refreshes().length, 0);
  h.player.playing = false;
  h.emit('player:destroy'); h.tick(15000); h.complete();
  assert.equal(h.refreshes().length, 1);
});

test('profile switch abandons the in-flight attempt, waits for native reload and does not double-refresh', () => {
  const h = harness();
  h.tick(300);
  h.permit.account.profile = { id: 2 };
  h.emit('account:profile_select', { profile: { id: 2 } });
  h.set(categories({ book: [card(20)] }));
  h.complete();
  assert.equal(h.refreshes().length, 0, 'old-profile response ignored');
  h.emit('focus'); h.tick(4000);
  assert.equal(h.requests, 1, 'no sync while native code reloads the new profile');
  h.emit('state:changed', { target: 'favorite', reason: 'profile' });
  h.tick(15000);
  assert.equal(h.requests, 2, 'the deferred trigger runs once spacing allows');
  h.complete();
  assert.equal(h.refreshes().length, 0, 'the new profile’s list is not a change');
});

test('a profile change noticed through storage pauses sync like a profile selection', () => {
  const h = harness();
  h.tick(300); h.complete();
  h.tick(20000);
  h.permit.account.profile = { id: 4 };
  h.emit('storage:change', { name: 'account' });
  h.emit('focus'); h.tick(5000);
  assert.equal(h.requests, 1);
  h.tick(10000);
  assert.equal(h.requests, 2, 'resumes after the quiet window without a native notification');
  h.complete(categories({ book: [card(40)] }));
  assert.equal(h.refreshes().length, 0, 'first list after a switch is a new snapshot');
});

test('a profile change detected at completion is not treated as a bookmark change', () => {
  const h = harness();
  h.tick(300);
  h.permit.account.profile = { id: 3 };
  h.complete(categories({ book: [card(30)] }));
  assert.equal(h.refreshes().length, 0);
  h.tick(60000); h.complete();
  assert.equal(h.refreshes().length, 0, 'snapshot was retaken for the new profile');
});

test('a missing profile or a throwing native call never leaves sync stuck', () => {
  const h = harness();
  h.permit.account.profile = undefined;
  h.tick(300);
  assert.equal(h.requests, 0, 'no sync without a profile');
  h.permit.account.profile = { id: 1 };
  const update = h.account.Timeline.update;
  h.account.Timeline.update = () => { throw new Error('synthetic'); };
  h.tick(60000);
  assert.equal(h.requests, 0);
  h.account.Timeline.update = update;
  h.tick(60000);
  assert.equal(h.requests, 1, 'the next attempt runs');
  h.complete();
});

test('account sync waits for native Favorite initialization and starts only once', () => {
  const h = harness({ ready: false }); h.reload();
  assert.equal(h.bookmarkReads, 0); assert.equal(h.intervalCount, 0);
  h.emit('app', { type: 'start' });
  assert.equal(h.bookmarkReads, 0);
  h.window.appready = true; h.emit('app', { type: 'ready' });
  assert.equal(h.bookmarkReads, 1); assert.equal(h.intervalCount, 1);
  h.tick(300); assert.deepEqual(h.calls, ['timeline', 'bookmarks']);
  h.emit('app', { type: 'ready' }); h.reload();
  assert.equal(h.intervalCount, 1);
  h.tick(300); assert.equal(h.requests, 1, 'repeated plugin injection is harmless');
});
