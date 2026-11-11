const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require('node:path').join(__dirname, '../plugins/chapters.js'), 'utf8');
const hash = 'a'.repeat(40);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const parts = {duration: 120, chapters: [{start: 0, end: 30, title: 'Intro'}, {start: 30, end: 80, title: '<Part>'}, {start: 80, end: 120, title: ''}]};

// Selectors of Lampa's native player panel template; anything else fails loudly.
const NATIVE = new Set(['.player-panel__center', '.player-panel__left', '.player-panel__subs', '.player-panel__timeline',
  '.player-panel__timenow', '.player-panel__playpause']);
const ABSENT = new Set(['.player-panel__rprev,.player-panel__rnext']);

const timed = new WeakSet();
const EMPTY_TICKS = '<div class="homelab-chapter-ticks"></div>';
function harness(t, beforeInstall) {
  if (!timed.has(t)) { t.mock.timers.enable({apis: ['setTimeout', 'Date']}); timed.add(t); }
  const handlers = new Map(), elements = [], calls = [], storage = new Map();
  function empty() { return {length: 0, find: () => empty(), text: () => '', on() { return this; }}; }
  function element(html = '', strict) {
    const children = new Map();
    const e = {length: 1, htmlValue: html, textValue: '', attrs: {}, appended: [], events: {}, classes: new Set(/\bhide\b/.test(html) ? ['hide'] : []),
      on(names, fn) { for (const name of names.split(' ')) e.events[name] = fn; return e; },
      find(name) {
        if (strict && ABSENT.has(name)) return empty();
        if (strict && !NATIVE.has(name)) throw new Error('selector is not in the native panel template: ' + name);
        if (!children.has(name)) children.set(name, element(name, strict)); return children.get(name);
      },
      before(value) { e.beforeValue = value; return e; }, after(value) { e.afterValue = value; return e; }, append(value) { e.appended.push(value); return e; },
      appendTo() { return e; }, html(value) { e.htmlValue = value; return e; }, text(value) { if (value === undefined) return e.textValue; e.textValue = value; return e; },
      attr(name, value) { e.attrs[name] = value; return e; }, hasClass: name => e.classes.has(name),
      addClass(name) { e.classes.add(name); return e; }, removeClass(name) { e.classes.delete(name); return e; }, 0: {}};
    elements.push(e); return e;
  }
  const listener = prefix => ({follow(name, fn) { handlers.set(prefix + ':' + name, fn); }});
  const panel = element('', true), video = {duration: 120, currentTime: 12};
  let work, menu, selected, controller = 'player';
  const L = {
    Player: {listener: listener('player'), playdata: () => work},
    PlayerPanel: {listener: listener('panel'), render: () => panel},
    PlayerVideo: {listener: listener('video'), video: () => video, to: at => { selected = at; }},
    Storage: {field: name => storage.get(name)},
    Select: {listener: listener('select'), show(value) { menu = value; controller = 'select'; handlers.get('select:fullshow')?.({active: value}); },
      closeAll() { const previous = menu; menu = null; handlers.get('select:hide')?.({active: previous}); }},
    Controller: {toggle(name) { controller = name; }, enabled: () => ({name: controller})},
  };
  function fetch(url, options) {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    calls.push({url, signal: options.signal, finish(value, status = 200) { resolve({status, ok: status >= 200 && status < 300, json: async () => value}); },
      fail: () => reject(new Error('network'))});
    return promise;
  }
  const window = {Lampa: L, jQuery: element, fetch, AbortController, location: {href: 'https://lampa.test/'}};
  if (beforeInstall) beforeInstall(L);
  const install = () => vm.runInNewContext(script, {window, Lampa: L, fetch, AbortController, URL, setTimeout, clearTimeout, Date, Math, isFinite});
  install();
  const fire = (name, value) => handlers.get(name)?.(value);
  return {calls, storage, elements, panel, video, fire, window, L, install, controller: () => controller,
    tick: ms => t.mock.timers.tick(ms), menu: () => menu, selected: () => selected,
    button: () => elements.find(e => e.htmlValue.includes('<span>Главы</span>')),
    ticks: () => panel.find('.player-panel__timeline').appended[0], now: () => panel.find('.player-panel__timenow').afterValue,
    ready(index = 1) { work = {homelab_torrent_hash: hash, homelab_file_index: index}; fire('player:ready', work); },
    online() { work = {url: 'https://video.test/episode.m3u8'}; fire('player:ready', work); },
  };
}

function withSeekControls(L) {
  L.Platform = {tv: () => false};
  L.Storage.listener = {follow(name, fn) { L.changeSetting = fn; }};
  L.rewinds = [];
  L.PlayerVideo.rewind = forward => L.rewinds.push(forward);
}

test('chapters come from the subtitle header probe of the playing file, not from a frame worker', async t => {
  const h = harness(t); h.ready(3);
  assert.deepEqual(h.calls.map(call => call.url), [`/homelab-media/${hash}/3/embedded`]);
  h.online(); assert.equal(h.calls.length, 1, 'online streams have no torrent file to probe');
});

test('chapters draw ticks, name the current chapter only on boundaries and navigate from the list', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(parts); await flush();
  assert.equal(h.ticks().htmlValue, '<div class="homelab-chapter-tick" style="left:25.000%"></div><div class="homelab-chapter-tick" style="left:66.667%"></div>');
  assert.equal(h.now().textValue, 'Intro', 'labelled before the first timeupdate');
  let writes = 0; const text = h.now().text; h.now().text = value => { if (value !== undefined) writes++; return text(value); };
  h.fire('video:timeupdate', {current: 6}); h.fire('video:timeupdate', {current: 29}); assert.equal(writes, 0);
  h.fire('video:timeupdate', {current: 95}); assert.equal(h.now().textValue, 'Глава 3', 'untitled chapters get a number');
  assert.ok(!h.button().hasClass('hide'));
  h.button().events['hover:enter']();
  assert.equal(h.menu().title, 'Главы · 3');
  assert.equal(h.menu().items[1].title, '‹Part›', 'titles are plain text');
  assert.equal(h.menu().items[0].selected, true, 'the video at 00:12 is inside the first chapter');
  assert.equal(h.menu().items[0].subtitle, '00:00 · 30 с<span class="homelab-chapter-badge">сейчас</span>');
  h.menu().onSelect(h.menu().items[1]); assert.equal(h.selected(), 30); assert.equal(h.controller(), 'player');
  h.fire('player:destroy');
  assert.equal(h.ticks().htmlValue, ''); assert.equal(h.now().textValue, ''); assert.ok(h.button().hasClass('hide'));
});

test('a file with one chapter or none shows no button, ticks or label', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish({duration: 120, chapters: [{start: 0, end: 120, title: 'All'}]}); await flush();
  assert.ok(h.button().hasClass('hide')); assert.equal(h.ticks().htmlValue, EMPTY_TICKS);
  h.fire('video:timeupdate', {current: 5}); assert.equal(h.now().textValue, '');
  h.button().events['hover:enter'](); assert.equal(h.menu(), undefined);
});

test('a probe still reading the header is retried a bounded number of times; closing cancels it', async t => {
  const h = harness(t); h.ready();
  for (const delay of [3000, 5000, 15000, 60000]) { h.calls.at(-1).finish(null, 503); await flush(); h.tick(delay); }
  assert.equal(h.calls.length, 5);
  h.calls[4].finish(null, 429); await flush(); h.tick(600000);
  assert.equal(h.calls.length, 5, 'no endless retries');
  const k = harness(t); k.ready(); k.calls[0].fail(); await flush();
  k.fire('player:destroy'); k.tick(600000); assert.equal(k.calls.length, 1);
  assert.equal(k.calls[0].signal.aborted, true);
});

test('the next episode closes an open chapter list and gives the player its keys back', async t => {
  const h = harness(t); h.ready(1); h.calls[0].finish(parts); await flush();
  h.button().events['hover:enter'](); assert.equal(h.controller(), 'select');
  h.fire('video:timeupdate', {current: 95});
  h.ready(2);
  assert.equal(h.menu(), null); assert.equal(h.controller(), 'player');
  h.calls[1].finish(parts); await flush();
  assert.equal(h.now().textValue, 'Intro', 'the old position does not name a chapter of the new file');
});

test('a late answer for a previous file is ignored', async t => {
  const h = harness(t); h.ready(1); h.ready(2);
  h.calls[0].finish(parts); await flush();
  assert.equal(h.ticks().htmlValue, EMPTY_TICKS);
  h.calls[1].finish(parts); await flush();
  assert.notEqual(h.ticks().htmlValue, EMPTY_TICKS);
});

test('step buttons seek at once by the configured step without pausing, add up while a seek is pending and stay off TVs', t => {
  const h = harness(t, withSeekControls);
  h.storage.set('player_rewind', 20); h.online();
  const play = h.panel.find('.player-panel__center').find('.player-panel__playpause');
  const back = play.beforeValue, forward = play.afterValue;
  assert.equal(back.attrs['aria-label'], 'Назад на 20 с');
  h.video.currentTime = 50; h.video.seeking = false;
  forward.events['hover:enter'](); assert.equal(h.video.currentTime, 70);
  h.video.seeking = true;
  forward.events['hover:enter'](); assert.equal(h.video.currentTime, 90, 'a pending seek counts from its target');
  h.video.seeking = false; back.events['hover:enter'](); assert.equal(h.video.currentTime, 70);
  h.video.currentTime = 110; forward.events['hover:enter'](); assert.equal(h.video.currentTime, 119, 'stays before the end');
  h.video.currentTime = 119.5; forward.events['hover:enter'](); assert.equal(h.video.currentTime, 119.5, 'forward never moves back');
  h.video.currentTime = 5; back.events['hover:enter'](); assert.equal(h.video.currentTime, 0);
  assert.deepEqual(h.L.rewinds, [], 'the TV scrub with its pause is not used');
  h.storage.set('player_rewind', 30); h.L.changeSetting({name: 'player_rewind'});
  assert.equal(forward.attrs['aria-label'], 'Вперёд на 30 с');
  h.online(); assert.equal(play.beforeValue, back, 'controls are added once');
  const tv = harness(t, L => { withSeekControls(L); L.Platform.tv = () => true; }); tv.online();
  assert.equal(tv.panel.find('.player-panel__center').find('.player-panel__playpause').beforeValue, undefined);
});

test('missing player APIs refuse installation without hooks', t => {
  const h = harness(t, L => { delete L.PlayerPanel.listener.follow; });
  assert.equal(h.window.homelabChapters, undefined);
});
