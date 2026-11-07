const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.join(__dirname, '../mods/HomelabSync');
const core = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'history.js'), 'utf8');
function bus() {
  const handlers = {};
  return { follow(name, fn) { (handlers[name] ||= []).push(fn); }, emit(name, data) { (handlers[name] || []).forEach(fn => fn(data)); } };
}
function harness({ screen = false, missingApi = false } = {}) {
  let now = 100000, readCount = 0, refreshCount = 0, cacheReads = 0, timerId = 0, selection, comp, built, menu, historyCalls = 0;
  let totalPages = 1, events = [], cubCards = [{ id: 42, name: 'Test', original_name: 'Test', watch_history: { watched_at: 1000 } }];
  const requests = [], timers = new Map(), storage = {}, components = {};
  const timelineEvents = bus(), activityEvents = bus(), changes = bus(), selectEvents = bus();
  const account = { Permit: { sync: true, account: { profile: { id: 1, main: true } } }, Api: {
    watchHistory(params, done) { done({ results: cubCards, total_pages: totalPages }); },
    watchHistoryCard(key, done) { historyCalls++; done(events.slice()); }
  } };
  const label = text => ({ value: typeof text === 'string' ? text : '', text(v) { this.value = v; return this; }, attr() { return this; }, addClass() { return this; }, append() { return this; } });
  const L = {
    Account: account, Utils: { secondsToTimeHuman: n => String(n), cardImgBackground() {} }, Noty: { show() {} },
    Storage: { get: (key, fallback) => key in storage ? storage[key] : fallback, cache: (key, n, fallback) => { cacheReads++; return storage[key] || fallback; }, set: (key, data) => { storage[key] = data; }, listener: changes },
    Reguest: function () {
      this.timeout = n => assert.equal(n, 10000);
      this.clear = () => {};
      this.silent = (url, done, fail) => requests.push({ url, done, fail });
    },
    Timeline: { filename: () => 'file_view_' + account.Permit.account.profile.id, listener: timelineEvents,
      read() { readCount++; timelineEvents.emit('read', {}); }, update() { assert.fail('received progress must not echo writes'); } },
    Player: { opened: () => false, listener: bus() }, Listener: activityEvents,
    Component: { add(name, value) { components[name] = value; } },
    Maker: { make() { comp = { use(hooks) { this.hooks = hooks; }, build(data) { built = data; }, empty() { built = { results: [] }; } }; return comp; } },
    Menu: { addButton(svg, name, action) { menu = action; return label(); } },
    Activity: { own: () => true, refresh() { refreshCount++; }, push() {} }, Controller: { toggle() {} },
    Select: { listener: selectEvents, opened: () => Boolean(selection), closeAll() { selection = null; }, show(value) { selection = value; selectEvents.emit('fullshow', { active: value }); } },
    Background: { change() {} }, Router: { call() {} },
    Api: { sources: { tmdb: { get(method, params, done) { done({ id: 43, name: 'Metadata', original_name: 'Metadata' }); } } } }
  };
  if (missingApi) delete L.Timeline.read;
  const context = { console: { warn() {} }, Date: class extends Date { static now() { return now; } }, document: { hidden: false, addEventListener(name, fn) { activityEvents.follow(name, fn); } },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() {}, $: label,
    window: { appready: true, Lampa: L, $: label, homelabSyncConfig: { version: 1, url: 'https://test.invalid', uid: 'synthetic', token: '' }, addEventListener(name, fn) { activityEvents.follow(name, fn); } }
  };
  vm.runInNewContext(core, context);
  if (screen) vm.runInNewContext(ui, context);
  return {
    L, storage, requests, sync: context.window.HomelabSync, timelineEvents, changes,
    get reads() { return readCount; }, get refreshes() { return refreshCount; },
    pages(value) { totalPages = value; }, get selection() { return selection; }, get built() { return built; }, get historyCalls() { return historyCalls; },
    advance(n) { now += n; }, get cacheReads() { return cacheReads; },
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    pull(done) { now += 10001; context.window.HomelabSync.pull(done); }, events(value) { events = value; }, cards(value) { cubCards = value; },
    start() { new components.homelab_history({}); comp.hooks.onCreate.call(comp); return comp; },
    open(card) { now += 10001; let hooks; comp.hooks.onInstance({ use(value) { hooks = value; } }, card); hooks.onEnter(); },
    resolve(rows, index = requests.length - 1, extra = {}) { requests[index].done({ rows, ...extra }); }
  };
}
function row(episode, extra = {}) {
  return { hash: String(episode), card: '42_tv', position: 900, duration: 1000, percent: 90, watched_at: 3000,
    extra: JSON.stringify({ card: 'tv_42', season: 1, episode }), ...extra };
}

test('loads all episodes and repairs both older native import paths without echoing writes', () => {
  const h = harness();
  h.pull(); h.resolve(Array.from({ length: 20 }, (_, i) => row(i + 1)));
  assert.equal(Object.keys(h.storage.file_view_1).length, 20);
  for (const event of ['read', 'update']) {
    h.storage.file_view_1['20'] = { updated: 1000, percent: 0 };
    h.timelineEvents.emit(event, {}); h.flush();
    assert.equal(h.storage.file_view_1['20'].percent, 90);
    assert.equal(h.storage.file_view_1['20'].episode, 20);
  }
  h.storage.file_view_1['20'] = { updated: 4000, percent: 10 };
  h.timelineEvents.emit('read', {}); h.flush();
  assert.equal(h.storage.file_view_1['20'].percent, 10, 'newer local playback wins');
});

test('late responses do not cross profiles, request failures retry, tombstones clear progress', () => {
  const h = harness(); h.pull();
  h.L.Account.Permit.account.profile = { id: 2, main: false };
  h.resolve([row(1)]);
  assert.equal(h.sync.rows().length, 0);
  h.pull(); assert.match(h.requests.at(-1).url, /profile_id=2/);
  h.requests.at(-1).fail(); h.pull(); h.resolve([row(1)]);
  h.pull(); h.resolve([row(1, { deleted: true, watched_at: 4000 })]);
  assert.equal(h.storage.file_view_2['1'].percent, 0);
  assert.equal(h.storage.file_view_2['1'].duration, 1000);
});

test('missing APIs disable only this extension, and token/identity values are encoded', () => {
  assert.equal(harness({ missingApi: true }).sync, undefined);
  const h = harness(); h.L.Account.Permit.sync = false;
  h.storage.lampac_profile_id = 'test & profile'; h.pull();
  assert.match(h.requests[0].url, /profile_id=test%20%26%20profile/);
});

test('own history screen updates a still-open panel and refetches CUB rewatches without a pull loop', () => {
  const h = harness({ screen: true }); h.start();
  h.resolve(Array.from({ length: 20 }, (_, i) => row(i + 1)));
  assert.equal(h.built.results[0].homelab_summary, 'Серии: 20');
  h.open(h.built.results[0]); h.resolve([row(20)]);
  assert.equal(h.selection.items[0].html.value, 'Серии: 1');
  const requests = h.requests.length, before = h.historyCalls;
  h.events([{ season: 1, episode: 20, watched_at: 5000 }, { season: 1, episode: 20, watched_at: 4000 }]);
  h.pull(); h.resolve([row(20)]);
  assert.equal(h.requests.length, requests + 1, 'panel repaint must not pull recursively');
  assert.ok(h.historyCalls > before, 'CUB event history is fetched again');
  assert.equal(h.selection.items.length, 4, 'two rewatches remain separate events');
});

test('switching profiles immediately closes the old history panel', () => {
  const h = harness({ screen: true }); h.start(); h.resolve([row(1)]);
  h.open(h.built.results[0]); h.resolve([row(1)]);
  assert.ok(h.selection);
  h.L.Account.Permit.account.profile = { id: 2, main: false };
  h.changes.emit('change', { name: 'account' });
  assert.equal(h.sync.rows().length, 0);
  assert.equal(h.selection, null);
});

test('CUB-only episodes contribute to the card and panel count without duplicating rewatches', () => {
  const h = harness({ screen: true });
  h.cards([{ id: 42, name: 'Test', original_name: 'Test', watch_history: { episodes: [{ season: 1, episode: 1 }] } }]);
  h.events([{ season: 1, episode: 1, watched_at: 5000 }, { season: 1, episode: 1, watched_at: 4000 }]);
  h.start(); h.resolve([]);
  assert.equal(h.built.results[0].homelab_summary, 'Серии: 1');
  h.open(h.built.results[0]); h.resolve([]);
  assert.equal(h.selection.items[0].html.value, 'Серии: 1');
  assert.equal(h.selection.items.length, 4);
});

test('an unchanged poll on page two does not reset pagination', () => {
  const h = harness({ screen: true }); h.pages(2);
  const comp = h.start(); h.resolve([row(1)]);
  h.cards([{ id: 43, name: 'Second', original_name: 'Second' }]);
  comp.hooks.onNext(() => {}, () => assert.fail('next page failed'));
  h.pull(); h.resolve([row(1)]);
  assert.equal(h.refreshes, 0);
});

test('a legacy hash shared by different cards is not imported ambiguously into native storage', () => {
  const h = harness();
  h.storage.file_view_1 = { '1': { percent: 50, updated: 1000 } };
  h.pull(); h.resolve([row(1), row(2, { hash: '1', card: '43_tv', extra: JSON.stringify({ card: 'tv_43', season: 1, episode: 2 }) })]);
  assert.equal(h.sync.rows().length, 2, 'own history retains both canonical cards');
  assert.equal(h.storage.file_view_1['1'].percent, 50, 'native hash collision must not select an arbitrary card');
});

test('network failures mark cached panels stale and a successful retry clears that status', () => {
  const h = harness({ screen: true }); h.start(); h.resolve([row(1)]);
  h.open(h.built.results[0]); h.resolve([row(1)]);
  h.pull(); h.requests.at(-1).fail();
  assert.equal(h.sync.error(), 'network');
  assert.match(h.selection.items[0].html.value, /Прогресс не обновлён/);
  h.pull(); h.resolve([row(1)]);
  assert.equal(h.sync.error(), '');
});

test('a collision with a card found only in native storage is also preserved', () => {
  const h = harness();
  h.storage.file_view_1 = { '1': { card: 'tv_99', percent: 50, updated: 1000 } };
  h.pull(); h.resolve([row(1)]);
  assert.equal(h.sync.rows().length, 1);
  assert.equal(h.storage.file_view_1['1'].card, 'tv_99');
  assert.equal(h.storage.file_view_1['1'].percent, 50);
});

test('an initial network failure does not create an activity refresh retry loop', () => {
  const h = harness({ screen: true }); h.start(); h.requests[0].fail();
  assert.equal(h.refreshes, 0);
  assert.equal(h.requests.length, 1);
});

test('callers within the freshness window share one dump instead of issuing a request each', () => {
  const h = harness(); let calls = 0;
  h.sync.pull(() => calls++); h.resolve([row(1)]);
  h.sync.pull(() => calls++); h.sync.pull(() => calls++);
  assert.equal(h.requests.length, 1); assert.equal(calls, 3);
  h.advance(10001); h.sync.pull(); assert.equal(h.requests.length, 2);
});

test('after a versioned dump, polls use the incremental changelog and merge without dropping rows', () => {
  const h = harness();
  h.sync.pull(); h.resolve([row(1), row(2)], 0, { version: 5 });
  h.pull(); assert.match(h.requests[1].url, /\/timecode\/changelog\?since=5&uid=synthetic$/);
  h.resolve([row(2, { position: 950, watched_at: 4000 })], 1, { version: 7, truncated: true });
  assert.match(h.requests[2].url, /since=7/, 'a truncated page continues within the same pull');
  h.resolve([row(3)], 2, { version: 8 });
  assert.deepEqual(Array.from(h.sync.rows(), value => value.hash + ':' + value.position), ['1:900', '2:950', '3:900']);
});

test('a web row that gains a native identity is replaced, not duplicated', () => {
  const h = harness();
  h.sync.pull(); h.resolve([row(1)], 0, { version: 5 });
  h.pull(); h.resolve([row(1, { id: 'tv-42-s1e1', watched_at: 4000 })], 1, { version: 6 });
  assert.equal(h.sync.rows().length, 1); assert.equal(h.sync.rows()[0].id, 'tv-42-s1e1');
});

test('a Lampac without a changelog falls back to full dumps for the rest of the session', () => {
  const h = harness();
  h.sync.pull(); h.resolve([row(1)], 0, { version: 5 });
  h.pull(); h.requests[1].done(undefined);
  assert.match(h.requests[2].url, /\/timecode\/dump\?/);
  h.resolve([row(1), row(2)], 2, { version: 6 });
  assert.equal(h.sync.rows().length, 2);
  h.pull(); assert.match(h.requests[3].url, /\/timecode\/dump\?/);
});

test('a burst of native timeline events repairs storage once', () => {
  const h = harness();
  h.sync.pull(); h.resolve([row(1)]);
  const before = h.cacheReads;
  for (let i = 0; i < 25; i++) h.timelineEvents.emit('update', {});
  h.flush();
  assert.equal(h.cacheReads - before, 1);
});

test('background polls repaint visible history progress in place without rebuilding the screen', () => {
  const h = harness({ screen: true }); const comp = h.start(); h.resolve([row(1)]);
  let item, hooks; comp.hooks.onInstance({ render: () => ({}), use(value) { hooks = value; } }, h.built.results[0]);
  item = { render() { return {}; } }; hooks.onCreate.call(item);
  h.pull(); h.resolve([row(1), row(2)]);
  assert.equal(h.refreshes, 0, 'no Activity.refresh: focus and scroll are retained');
  assert.equal(h.built.results[0].homelab_summary, 'Серии: 2');
});
