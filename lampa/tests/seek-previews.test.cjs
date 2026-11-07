const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require('node:path').join(__dirname, '../plugins/seek-previews.js'), 'utf8');
const hash = 'a'.repeat(40);
// Production always requests metadata?step=10 and the worker echoes step 10.
const info = {version: 1, step: 10, duration: 120, chapters: [{start: 10, end: 20, title: '<Scene>'}]};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const frameUrl = (index, slot) => new RegExp(`^/previews/${hash}/${index}/frame/${slot}\\.jpg\\?step=10&client=[A-Za-z0-9_-]{8,64}&n=\\d+$`);
const owner = call => /client=([^&]+)/.exec(call.url)[1];
const order = call => Number(/&n=(\d+)/.exec(call.url)[1]);
const withoutOrder = call => call.url.replace(/&n=\d+$/, '');
const cancels = h => h.calls.filter(call => call.url === '/previews/cancel');
const jpeg = {type: 'image/jpeg', size: 100};

// Selectors of Lampa's native player panel template (app.min.js html$25).
// Anything else must fail loudly so that a typo or a native rename cannot pass.
const NATIVE = new Set(['.player-panel__center', '.player-panel__left', '.player-panel__subs', '.player-panel__timeline',
  '.player-panel__timenow', '.player-panel__time-touch-zone']);
const ABSENT = new Set(['.player-panel__rprev,.player-panel__rnext']);

function harness(t, beforeInstall) {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const handlers = new Map(), elements = [], calls = [], objects = [], revoked = [], storage = new Map();
  function empty() { return {length: 0, find: () => empty(), text: () => '', on() { return this; }}; }
  function element(html = '', strict) {
    const children = new Map();
    const e = {length: 1, htmlValue: html, textValue: '', attrs: {}, styles: {}, appended: [], rect: {left: 0, top: 0, bottom: 120, width: 100, height: 120}, hidden: /\bhide\b/.test(html), events: {},
      on(names, selector, fn) { for (const name of names.split(' ')) e.events[name] = typeof selector === 'function' ? selector : fn; return e; },
      off() { e.events = {}; return e; },
      find(name) {
        if (strict && ABSENT.has(name)) return empty();
        if (strict && !NATIVE.has(name)) throw new Error('selector is not in the native panel template: ' + name);
        if (!children.has(name)) children.set(name, element(name)); return children.get(name);
      },
      before(value) { e.beforeValue = value; return e; }, after(value) { e.afterValue = value; return e; }, append(value) { e.appended.push(value); return e; }, css(name, value) { e.styles[name] = value; return e; }, appendTo() { return e; },
      html(value) { e.htmlValue = value; return e; }, text(value) { if (value === undefined) return e.textValue; e.textValue = value; return e; },
      attr(name, value) { e.attrs[name] = value; return e; }, removeAttr(name) { delete e.attrs[name]; return e; },
      classes: new Set(), hasClass(name) { return e.classes.has(name); },
      addClass(name) { e.classes.add(name); if (name === 'hide') e.hidden = true; return e; }, removeClass(name) { e.classes.delete(name); if (name === 'hide') e.hidden = false; return e; },
      0: {getBoundingClientRect: () => e.rect}};
    elements.push(e); return e;
  }
  function listener(prefix) {
    return {follow(name, fn) { handlers.set(prefix + ':' + name, fn); }};
  }
  const panel = element('', true), video = {duration: 120, currentTime: 12};
  let work, menu, selected, shows = 0, controller = 'player';
  const L = {
    Player: {listener: listener('player'), playdata: () => work},
    PlayerPanel: {listener: listener('panel'), render: () => panel},
    PlayerVideo: {listener: listener('video'), video: () => video, to: at => { selected = at; }},
    Storage: {get: (name, fallback) => storage.get(name) ?? fallback, field: name => storage.get(name), set: (name, value) => storage.set(name, value)},
    Select: {listener: listener('select'),
      show(value) { menu = value; shows++; controller = 'select'; handlers.get('select:fullshow')?.({active: value}); },
      closeAll() { const previous = menu; menu = null; handlers.get('select:hide')?.({active: previous}); },
    }, Controller: {toggle(name) { controller = name; }, enabled: () => ({name: controller})},
  };
  function fetch(url, options) {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    const call = {url, options, signal: options.signal, finish(value, status = 200, headers = {}) {
      // Real Response.ok is true for every 2xx, including 202.
      resolve({status, ok: status >= 200 && status < 300, headers: {get: name => headers[name] ?? null}, json: async () => value, blob: async () => value});
    }, fail: () => reject(new Error('network'))};
    calls.push(call); return promise;
  }
  const URLClass = class extends URL {};
  URLClass.createObjectURL = blob => { objects.push(blob); return 'blob:' + objects.length; };
  URLClass.revokeObjectURL = url => revoked.push(url);
  const window = {Lampa: L, jQuery: element, fetch, AbortController, location: {href: 'https://lampa.test/'}};
  if (beforeInstall) beforeInstall(L);
  const install = () => vm.runInNewContext(script, {window, Lampa: L, fetch, AbortController, URL: URLClass, setTimeout, clearTimeout, Date, Math});
  install();
  const fire = (name, value) => handlers.get(name)?.(value);
  const overlay = () => elements.find(e => e.htmlValue.includes('homelab-seek-preview hide'));
  return {calls, objects, revoked, storage, elements, panel, video, fire, window, L, install, overlay,
    handlerCount: () => handlers.size, shows: () => shows,
    tick: ms => t.mock.timers.tick(ms), menu: () => menu, selected: () => selected,
    button: () => elements.find(e => e.htmlValue.includes('<span>Главы</span>')),
    ready(index = 1) { work = {homelab_torrent_hash: hash, homelab_file_index: index}; fire('player:ready', work); },
    online() { work = {url: 'https://video.test/episode.m3u8'}; fire('player:ready', work); },
    // Native PlayerVideo.rewind: timeupdate with the target, then rewind.
    rewind(at) { fire('video:timeupdate', {current: at}); fire('video:rewind', {}); },
    frames: () => calls.filter(call => call.url.includes('/frame/')),
  };
}

function withSeekControls(L) {
  L.Platform = {tv: () => false};
  L.Storage.listener = {follow(name, fn) { L.changeSetting = fn; }};
  L.rewinds = [];
  L.PlayerVideo.rewind = forward => L.rewinds.push({forward, step: L.Storage.field('player_rewind')});
}

function trackVideo(h, options = {}) {
  const events = {};
  h.video.readyState = 4; h.video.paused = false;
  h.video.addEventListener = (name, fn) => { (events[name] ||= []).push(fn); };
  // Lampa's Tizen/Orsay wrappers are <object> elements: the native
  // removeEventListener exists but cannot remove Lampa Subscribe listeners.
  h.video.removeEventListener = options.wrapper ? () => {} : (name, fn) => { events[name] = (events[name] || []).filter(item => item !== fn); };
  const emit = name => (events[name] || []).slice().forEach(fn => fn());
  return {events, emit, count: () => Object.values(events).reduce((sum, list) => sum + list.length, 0)};
}
const body = call => JSON.parse(call.options.body);
const prepares = h => h.calls.filter(call => call.url.endsWith('/prepare'));

test('online and torrent controls delegate directions and configured step to native rewind without duplicates', t => {
  const h = harness(t, withSeekControls);
  h.storage.set('player_rewind', 20); h.online();
  const play = h.panel.find('.player-panel__center').find('.player-panel__playpause');
  const back = play.beforeValue, forward = play.afterValue;
  assert.equal(back.attrs['aria-label'], 'Назад примерно на 20 с', 'native rewind grows each step by 3% and accumulates');
  assert.equal(forward.attrs['aria-label'], 'Вперёд примерно на 20 с');
  back.events['hover:enter'](); forward.events['hover:enter']();
  assert.deepEqual(h.L.rewinds, [{forward: false, step: 20}, {forward: true, step: 20}]);
  h.storage.set('player_rewind', 30); h.L.changeSetting({name: 'player_rewind'});
  assert.equal(back.attrs['aria-label'], 'Назад примерно на 30 с');
  h.ready(); forward.events['hover:enter']();
  assert.equal(h.L.rewinds.at(-1).step, 30);
  assert.equal(play.afterValue, forward, 'episode changes reuse controls');
  assert.equal(h.calls.length, 1, 'online controls do not request torrent previews');
  h.install(); h.online();
  assert.equal(play.beforeValue, back, 'reloading the plugin does not duplicate controls');
});

test('seek controls leave native TV/existing buttons alone and reject live or unseekable playback', t => {
  const h = harness(t, withSeekControls);
  h.L.Platform.tv = () => true; h.online();
  const play = h.panel.find('.player-panel__center').find('.player-panel__playpause');
  assert.equal(play.beforeValue, undefined);
  h.L.Platform.tv = () => false;
  const find = h.panel.find;
  h.panel.find = name => name === '.player-panel__rprev,.player-panel__rnext' ? {length: 2} : find(name);
  h.online(); assert.equal(play.beforeValue, undefined);
  h.panel.find = find; h.online();
  const back = play.beforeValue;
  h.L.Player.playdata().iptv = true; back.events['hover:enter']();
  delete h.L.Player.playdata().iptv;
  h.panel.addClass('panel--norewind'); back.events['hover:enter']();
  h.panel.removeClass('panel--norewind');
  h.video.duration = Infinity; back.events['hover:enter']();
  h.video.duration = 0; back.events['hover:enter']();
  assert.equal(h.L.rewinds.length, 0);
  h.video.duration = 120; back.events['hover:enter']();
  assert.equal(h.L.rewinds.length, 1);
});

test('strict panel mock rejects selectors outside the native template', t => {
  const h = harness(t);
  assert.throws(() => h.panel.find('.player-panel__typo'), /native panel template/);
});

test('rapid scrub requests only the final ten-second frame and never displays a late previous file', async t => {
  const h = harness(t); h.ready();
  assert.ok(h.calls[0].url.endsWith('/metadata?step=10'));
  h.calls[0].finish(info); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: .1});
  h.tick(300); h.fire('panel:mouse_rewind', {method: 'move', percent: .5});
  h.tick(449); assert.equal(h.calls.length, 1);
  h.tick(1); assert.match(h.calls[1].url, frameUrl(1, 6));
  assert.equal(h.overlay().find('.homelab-seek-preview__label').textValue, '01:00');
  h.ready(2); assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(cancels(h).length, 1, 'changing files releases the old job on the worker');
  assert.deepEqual(JSON.parse(cancels(h)[0].options.body), {client: owner(h.calls[1]), n: order(h.calls[1]) + 1});
  assert.equal(cancels(h)[0].options.keepalive, true);
  h.calls[1].finish(jpeg); await flush();
  assert.equal(h.objects.length, 0, 'old-file response cannot become current thumbnail');
  h.calls.find(call => call.url.includes('/2/metadata')).finish(info); await flush();
  h.rewind(44); h.tick(450);
  const next = h.frames().at(-1);
  assert.match(next.url, frameUrl(2, 4));
  assert.equal(owner(next), owner(h.calls[1]), 'one owner for the plugin lifetime supersedes across files');
  assert.ok(order(next) > JSON.parse(cancels(h)[0].options.body).n, "the counter keeps rising after a cancel");
  next.finish(jpeg); await flush();
  assert.equal(h.objects.length, 1);
  h.fire('player:destroy'); assert.deepEqual(h.revoked, ['blob:1']);
  assert.equal(cancels(h).length, 2, 'closing playback releases the pending job');
  h.ready(3); assert.equal(cancels(h).length, 2, 'files without frame requests send no cancel');
});

test('chapters navigate explicitly; toggling previews prevents new decoder requests', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.button().events['hover:enter']();
  assert.equal(h.menu().items[1].title, '00:10 · ‹Scene›');
  assert.equal(h.selected(), undefined, 'a chapter is never automatically skipped');
  h.menu().onSelect(h.menu().items[1]); assert.equal(h.selected(), 10);
  h.menu().onSelect(h.menu().items[0]); assert.equal(h.storage.get('homelab_seek_frames'), false);
  h.rewind(44); h.tick(1000);
  assert.equal(h.calls.length, 1);
});

test('mobile preview uses the native rendered target and survives a quick release', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.panel.find('.player-panel__timenow').text('00:00:24'); // native HH:MM:SS; currentTime+delta would be 36
  h.panel.events['touchmove.homelabPreview']({originalEvent: {touches: [{clientX: 50}]}});
  h.panel.events['touchend.homelabPreview']();
  assert.equal(h.overlay().hidden, false, 'release keeps the pending preview briefly');
  h.tick(450);
  assert.match(h.calls[1].url, frameUrl(1, 2));
  assert.equal(h.selected(), undefined);
  h.calls[1].finish(jpeg); await flush();
  assert.equal(h.overlay().find('img').attrs.src, 'blob:1');
  h.tick(1049); assert.equal(h.overlay().hidden, false);
  h.tick(1); assert.equal(h.overlay().hidden, true, 'a late frame cannot keep the overlay after release');
  h.panel.events['touchmove.homelabPreview']({});
  h.panel.events['touchend.homelabPreview']();
  h.tick(1500); assert.equal(h.overlay().hidden, true);
  h.fire('player:destroy'); h.tick(60000); assert.equal(h.frames().length, 1);
});

test('an unprepared slot shows the nearest cached frame as a placeholder', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: 40 / 120}); h.tick(450); h.calls[1].finish(jpeg); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: 62 / 120});
  assert.equal(h.overlay().find('img').attrs.src, 'blob:1');
  assert.ok(h.overlay().classes.has('homelab-seek-preview--near'));
  h.tick(450); h.calls[2].finish(jpeg); await flush();
  assert.equal(h.overlay().find('img').attrs.src, 'blob:2');
  assert.equal(h.overlay().classes.has('homelab-seek-preview--near'), false);
  h.fire('panel:mouse_rewind', {method: 'move', percent: 115 / 120});
  assert.equal(h.overlay().find('img').styles.display, 'none', 'distant frames are not substituted');
});

test('the overlay hides when the panel hides and shortly after a remote seek lands', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.rewind(44); assert.equal(h.overlay().hidden, false);
  h.fire('panel:visible', {status: true}); assert.equal(h.overlay().hidden, false);
  h.fire('panel:visible', {status: false}); assert.equal(h.overlay().hidden, true);
  h.tick(450); assert.equal(h.frames().length, 0, 'hiding cancels the pending request');
  h.rewind(44); h.tick(300); h.rewind(64); h.tick(450);
  assert.equal(h.frames().length, 1);
  h.tick(2049); assert.equal(h.overlay().hidden, false);
  h.tick(1); assert.equal(h.overlay().hidden, true, 'a stale target cannot reappear with the panel later');
  assert.equal(h.frames()[0].signal.aborted, true);
});

test('pending responses stop polling after close; unavailable APIs do not break player', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(null, 202); await flush();
  h.fire('player:destroy'); h.tick(60000); assert.equal(h.calls.length, 1);
  assert.doesNotThrow(() => vm.runInNewContext(script, {window: {}}));
});

test('a cold frame stays pending beyond six seconds and displays when generation finishes', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: 44 / 120}); h.tick(450);
  for (let i = 0; i < 7; i++) {
    h.calls.at(-1).finish(null, 202); await flush(); h.tick(1000);
  }
  assert.equal(h.calls.at(-1).signal.aborted, false);
  h.calls.at(-1).finish(jpeg); await flush();
  assert.equal(h.objects.length, 1);
  h.tick(6000); assert.deepEqual(h.revoked, [], 'hiding preserves the bounded frame cache');
  h.fire('panel:mouse_rewind', {method: 'move', percent: 44 / 120});
  assert.equal(h.calls.filter(call => /\/frame\/4\.jpg/.test(call.url)).length, 8, 'revisiting uses memory immediately without another HTTP call');
  h.fire('player:destroy'); assert.deepEqual(h.revoked, ['blob:1']);
});

test('temporary metadata error recovers automatically and refreshes the open chapter menu', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(null, 503); await flush();
  h.button().events['hover:enter']();
  assert.equal(h.menu().items[1].title, 'Не удалось прочитать главы');
  h.tick(4999); assert.equal(h.calls.length, 1);
  h.tick(1); assert.equal(h.calls.length, 2);
  h.calls[1].finish(info); await flush();
  assert.equal(h.menu().items[1].title, '00:10 · ‹Scene›');
  h.tick(300000); assert.equal(h.calls.length, 2, 'success cancels retries and deadlines');
});

test('a failed metadata job waits for the worker backoff before retrying', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(null, 422, {'Retry-After': '42'}); await flush();
  h.tick(41999); assert.equal(h.calls.length, 1, 'polling during the failure backoff only repeats the failure');
  h.tick(1); assert.equal(h.calls.length, 2);
});

test('automatic retries are bounded and reopening the failed menu allows a throttled manual retry', async t => {
  const h = harness(t); h.ready();
  for (const delay of [5000, 15000, 60000]) {
    h.calls.at(-1).finish(null, 503); await flush(); h.tick(delay);
  }
  assert.equal(h.calls.length, 4);
  h.calls[3].finish(null, 503); await flush(); h.tick(300000);
  assert.equal(h.calls.length, 4, 'no unlimited background retry loop');
  h.button().events['hover:enter'](); h.button().events['hover:enter']();
  assert.equal(h.calls.length, 5, 'reopening does not duplicate an in-flight request');
  h.calls[4].finish(null, 503); await flush();
  h.button().events['hover:enter'](); assert.equal(h.calls.length, 5, 'manual retry is rate limited');
  h.tick(5000); h.button().events['hover:enter'](); assert.equal(h.calls.length, 6);
  h.calls[5].finish(info); await flush();
  assert.equal(h.menu().items[1].title, '00:10 · ‹Scene›');
});

test('timeout recovery ignores a late old response and close cancels pending retries', async t => {
  const h = harness(t); h.ready(); h.tick(55000);
  assert.equal(h.calls[0].signal.aborted, true);
  h.tick(5000); assert.equal(h.calls.length, 2);
  h.calls[0].finish(info); await flush();
  h.button().events['hover:enter'](); assert.equal(h.menu().items[1].title, 'Читаем главы…');
  h.calls[1].fail(); await flush();
  h.fire('player:destroy'); h.tick(300000);
  assert.equal(h.calls.length, 2, 'closing playback cancels the scheduled network retry');
});

test('metadata does not replace another selector and cancellation prevents old-file menu updates', async t => {
  const h = harness(t); h.ready(); h.button().events['hover:enter']();
  const owned = h.menu(), other = {title: 'Other menu', items: []};
  h.L.Select.show(other); h.calls[0].finish(info); await flush();
  assert.equal(h.menu(), other); assert.equal(h.shows(), 2);
  assert.equal(owned.items[1].title, '00:10 · ‹Scene›', 'a stacked selector receives fresh entries without stealing focus');
  h.ready(2); h.calls[1].finish(null, 503); await flush();
  h.ready(3); h.tick(5000);
  assert.equal(h.calls.length, 3); assert.ok(h.calls[2].url.includes('/3/metadata'));
  assert.equal(h.menu(), other);
});

test('missing subscription methods refuse installation without markers, DOM or partial hooks', t => {
  let follow;
  const h = harness(t, L => { follow = L.PlayerPanel.listener.follow; delete L.PlayerPanel.listener.follow; });
  assert.equal(h.window.homelabSeekPreviews, undefined);
  assert.equal(h.handlerCount(), 0); assert.equal(h.elements.length, 1);
  h.L.PlayerPanel.listener.follow = follow; h.install();
  assert.equal(h.window.homelabSeekPreviews.version, 3);
  h.ready(); assert.equal(h.calls.length, 1, 'installation can recover when APIs become available');
});

test('thumbnail tracks pointer within one slot, clamps at edges, and chapters live on the left', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  const overlay = h.overlay();
  h.panel.rect = {left: 100, top: 500, bottom: 700, width: 1000, height: 200};
  h.panel.find('.player-panel__timeline').rect = {left: 120, top: 550, width: 960}; overlay.rect.width = 200;
  h.fire('panel:mouse_rewind', {method: 'move', percent: .5});
  assert.equal(overlay.styles.left, 500); assert.equal(overlay.styles.bottom, 162);
  h.fire('panel:mouse_rewind', {method: 'move', percent: .51});
  assert.ok(Math.abs(overlay.styles.left - 509.6) < .001, 'same-slot motion still repositions');
  h.fire('panel:mouse_rewind', {method: 'move', percent: 0}); assert.equal(overlay.styles.left, 108);
  h.fire('panel:mouse_rewind', {method: 'move', percent: 1}); assert.equal(overlay.styles.left, 892);
  assert.ok(h.panel.find('.player-panel__left').appended.length, 'chapter controls belong to the left group');
  h.panel.events['mouseleave.homelabPreview'](); assert.equal(overlay.hidden, true);
});

test('busy frames retry while stationary and are cancelled by another file', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: .5}); h.tick(450);
  h.calls[1].finish(null, 503); await flush(); h.tick(1000);
  assert.equal(h.calls.length, 3); assert.equal(withoutOrder(h.calls[2]), withoutOrder(h.calls[1]));
  assert.ok(order(h.calls[2]) > order(h.calls[1]), 'every poll carries a newer counter');
  h.calls[2].finish(null, 429); await flush(); h.tick(2000);
  assert.equal(h.calls.length, 4);
  h.calls[3].finish(jpeg); await flush(); assert.equal(h.objects.length, 1);
  h.fire('panel:mouse_rewind', {method: 'move', percent: .7}); h.tick(450); h.calls[4].finish(null, 503); await flush();
  h.ready(2); h.tick(10000); assert.equal(h.frames().length, 4, 'stale retry cannot request another file frame');
});

test('the first busy retry honours Retry-After', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: .5}); h.tick(450);
  h.frames()[0].finish(null, 503, {'Retry-After': '4'}); await flush();
  h.tick(3999); assert.equal(h.frames().length, 1);
  h.tick(1); assert.equal(h.frames().length, 2);
});

test('failed and invalid frames are not polled; the worker backoff is honoured', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: .5}); h.tick(450);
  h.calls[1].finish(null, 422, {'Retry-After': '30'}); await flush();
  h.tick(10000); assert.equal(h.frames().length, 1, 'a failed job is not retried by polling');
  h.fire('panel:mouse_rewind', {method: 'move', percent: .5}); h.tick(450);
  assert.equal(h.frames().length, 1, 'the same slot waits for Retry-After');
  h.tick(20000); h.fire('panel:mouse_rewind', {method: 'move', percent: .5}); h.tick(450);
  assert.equal(h.frames().length, 2);
  h.fire('panel:mouse_rewind', {method: 'move', percent: .8}); h.tick(450);
  h.frames().at(-1).finish({type: 'text/html', size: 100}); await flush();
  h.tick(30000); assert.equal(h.frames().length, 3, 'a response of the wrong type is final, not transient');
  assert.equal(h.objects.length, 0);
});

test('failed same-slot requests can be retried after cooldown and a hung fetch has its own deadline', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: .5}); h.tick(450);
  h.calls[1].finish(null, 404); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: .5}); h.tick(450); assert.equal(h.calls.length, 2);
  h.tick(5000); h.fire('panel:mouse_rewind', {method: 'move', percent: .5}); h.tick(450); assert.equal(h.calls.length, 3);
  for (let i = 0; i < 6; i++) { h.tick(10000); h.fire('panel:mouse_rewind', {method: 'move', percent: .5}); }
  assert.equal(h.calls[2].signal.aborted, true, 'hover motion cannot extend a hung request deadline');
});

test('background preparation reports phases single-flight, rate limited, sequenced and stops on close', async t => {
  const h = harness(t), video = trackVideo(h);
  h.ready();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].url, `/previews/${hash}/1/prepare`);
  assert.equal(body(h.calls[1]).state, 'playing'); assert.equal(body(h.calls[1]).seq, 1);
  h.calls[0].finish(info); h.video.readyState = 2; video.emit('waiting');
  assert.equal(prepares(h).length, 1, 'a state change joins the pending report');
  h.calls[1].finish({}, 202); await flush();
  assert.equal(prepares(h).length, 1, 'flapping phases are spaced out');
  h.video.readyState = 4; video.emit('playing'); h.video.readyState = 2; video.emit('waiting');
  h.tick(2999); assert.equal(prepares(h).length, 1);
  h.tick(1); assert.equal(prepares(h).length, 2);
  assert.equal(body(prepares(h)[1]).state, 'buffering', 'the last phase wins'); assert.equal(body(prepares(h)[1]).seq, 2);
  prepares(h)[1].finish({}, 202); await flush();
  h.tick(15000); assert.equal(prepares(h).length, 3);
  assert.equal(body(prepares(h)[2]).state, 'buffering');
  h.fire('player:destroy'); assert.equal(prepares(h)[2].signal.aborted, true);
  assert.equal(body(prepares(h)[3]).state, 'closed');
  assert.equal(body(prepares(h)[3]).seq, 4, 'closing outranks every earlier report');
  assert.equal(prepares(h)[3].options.keepalive, true);
  prepares(h)[2].fail(); prepares(h)[3].finish({}, 202); await flush(); h.tick(300000);
  assert.equal(prepares(h).length, 4); assert.equal(video.count(), 0);
});

test('an unsupported release stops preparation reports', async t => {
  const h = harness(t), video = trackVideo(h);
  h.ready(); h.calls[0].finish(info);
  prepares(h)[0].finish({}, 422); await flush();
  video.emit('waiting'); h.tick(60000);
  assert.equal(prepares(h).length, 1);
});

test('network stalls cannot leave a playing video reported as buffering', async t => {
  const h = harness(t), video = trackVideo(h);
  h.ready(); h.calls[0].finish(info); h.calls[1].finish({}, 202); await flush();
  video.emit('stalled');
  assert.equal(h.calls.length, 2, 'stalled while buffered is not playback waiting');
  h.tick(3000); h.video.readyState = 2; video.emit('waiting'); h.calls[2].finish({}, 202); await flush();
  h.video.readyState = 4; h.video.currentTime += 15;
  h.tick(15000);
  assert.equal(body(h.calls[3]).state, 'playing', 'heartbeat heals a missed playing event');
});

test('native GST video replacement pauses preparation before the first new frame', async t => {
  const h = harness(t), video = trackVideo(h);
  h.ready(); h.calls[0].finish(info); h.calls[1].finish({}, 202); await flush();
  h.tick(3000); h.fire('video:destroy', {savemeta: true});
  assert.equal(body(h.calls[2]).state, 'buffering');
  assert.equal(video.count(), 0);
  h.calls[2].finish({}, 202); await flush();
  h.L.PlayerVideo.video = () => ({readyState: 0, paused: false});
  h.tick(15000);
  assert.equal(body(h.calls[3]).state, 'buffering');
});

test('native wrappers whose listeners cannot be removed still report and go inert on close', async t => {
  const h = harness(t), video = trackVideo(h, {wrapper: true});
  delete h.video.readyState;
  h.ready(); h.calls[0].finish(info); video.emit('playing');
  assert.equal(body(h.calls[1]).state, 'playing');
  h.calls[1].finish({}, 202); await flush(); h.tick(15000);
  assert.equal(body(h.calls[2]).state, 'playing');
  h.calls[2].finish({}, 202); await flush();
  h.fire('player:destroy');
  const after = h.calls.length;
  video.emit('waiting'); video.emit('playing'); h.tick(60000);
  assert.equal(h.calls.length, after, 'listeners that cannot be removed are inert after close');
});

test('frame cache is bounded and revisits are immediate', async t => {
  const h = harness(t); h.video.duration = 400; h.ready(); h.calls[0].finish({...info, duration: 400}); await flush();
  const overlay = h.overlay();
  for (let slot = 0; slot < 17; slot++) {
    h.fire('panel:mouse_rewind', {method: 'move', percent: slot * 10 / 400}); h.tick(450);
    assert.equal(overlay.find('.homelab-seek-preview__note').textValue, '');
    h.calls.at(-1).finish(jpeg); await flush();
  }
  assert.deepEqual(h.revoked, ['blob:1']);
  const calls = h.calls.length;
  h.fire('panel:mouse_rewind', {method: 'move', percent: 150 / 400});
  assert.equal(h.calls.length, calls); assert.equal(overlay.find('img').attrs.src, 'blob:16');
  h.fire('panel:mouse_rewind', {method: 'move', percent: 0}); h.tick(450);
  assert.equal(h.calls.length, calls + 1, 'an evicted frame can be fetched again');
  h.fire('player:destroy'); assert.equal(new Set(h.revoked).size, 17);
});
