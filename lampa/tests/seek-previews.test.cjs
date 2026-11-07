const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require('node:path').join(__dirname, '../plugins/seek-previews.js'), 'utf8');
const hash = 'a'.repeat(40);
const info = {version: 1, step: 5, duration: 120, chapters: [{start: 5, end: 10, title: '<Scene>'}]};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(t, beforeInstall) {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const handlers = new Map(), elements = [], calls = [], objects = [], revoked = [], storage = new Map();
  function element(html = '') {
    const children = new Map();
    const e = {length: 1, htmlValue: html, textValue: '', attrs: {}, styles: {}, appended: [], rect: {left: 0, top: 0, bottom: 120, width: 100, height: 120}, hidden: /\bhide\b/.test(html), events: {},
      on(name, selector, fn) { e.events[name] = typeof selector === 'function' ? selector : fn; return e; },
      off() { e.events = {}; return e; },
      find(name) { if (!children.has(name)) children.set(name, element(name)); return children.get(name); },
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
  const panel = element(), video = {duration: 120, currentTime: 12};
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
    const call = {url, options, signal: options.signal, finish(value, status = 200) {
      resolve({status, ok: status === 200, json: async () => value, blob: async () => value});
    }, fail: () => reject(new Error('network'))};
    calls.push(call); return promise;
  }
  const URLClass = class extends URL {};
  URLClass.createObjectURL = blob => { objects.push(blob); return 'blob:' + objects.length; };
  URLClass.revokeObjectURL = url => revoked.push(url);
  const window = {Lampa: L, jQuery: element, fetch, AbortController, location: {href: 'https://lampa.test/'}};
  if (beforeInstall) beforeInstall(L);
  const install = () => vm.runInNewContext(script, {window, Lampa: L, fetch, AbortController, URL: URLClass, setTimeout, clearTimeout, Date});
  install();
  const fire = (name, value) => handlers.get(name)?.(value);
  return {calls, objects, revoked, storage, elements, panel, video, fire, window, L, install,
    handlerCount: () => handlers.size, shows: () => shows,
    tick: ms => t.mock.timers.tick(ms), menu: () => menu, selected: () => selected,
    button: () => elements.find(e => e.htmlValue.includes('<span>Главы</span>')),
    ready(index = 1) { work = {homelab_torrent_hash: hash, homelab_file_index: index}; fire('player:ready', work); },
    online() { work = {url: 'https://video.test/episode.m3u8'}; fire('player:ready', work); },
  };
}

function withSeekControls(L) {
  const panel = L.PlayerPanel.render(), find = panel.find;
  panel.find = name => name === '.player-panel__rprev,.player-panel__rnext' ? {length: 0} : find(name);
  L.Platform = {tv: () => false};
  L.Storage.listener = {follow(name, fn) { L.changeSetting = fn; }};
  L.rewinds = [];
  L.PlayerVideo.rewind = forward => L.rewinds.push({forward, step: L.Storage.field('player_rewind')});
}

test('online and torrent controls delegate directions and configured step to native rewind without duplicates', t => {
  const h = harness(t, withSeekControls);
  h.storage.set('player_rewind', 20); h.online();
  const play = h.panel.find('.player-panel__center').find('.player-panel__playpause');
  const back = play.beforeValue, forward = play.afterValue;
  assert.equal(back.attrs['aria-label'], 'Назад на 20 с');
  assert.equal(forward.attrs['aria-label'], 'Вперёд на 20 с');
  back.events['hover:enter'](); forward.events['hover:enter']();
  assert.deepEqual(h.L.rewinds, [{forward: false, step: 20}, {forward: true, step: 20}]);
  h.storage.set('player_rewind', 30); h.L.changeSetting({name: 'player_rewind'});
  assert.equal(back.attrs['aria-label'], 'Назад на 30 с');
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

test('rapid scrub requests only the final five-second frame and never displays a late previous file', async t => {
  const h = harness(t); h.ready();
  h.calls[0].finish(info); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: .1});
  h.tick(300); h.fire('panel:mouse_rewind', {method: 'move', percent: .5});
  h.tick(449); assert.equal(h.calls.length, 1);
  h.tick(1); assert.equal(h.calls[1].url, `/previews/${hash}/1/frame/12.jpg`);
  h.ready(2); assert.equal(h.calls[1].signal.aborted, true);
  h.calls[1].finish({type: 'image/jpeg', size: 100}); await flush();
  assert.equal(h.objects.length, 0, 'old-file response cannot become current thumbnail');
  h.calls[2].finish(info); await flush();
  h.fire('video:timeupdate', {current: 44}); h.fire('video:rewind', {}); h.tick(450);
  assert.equal(h.calls[3].url, `/previews/${hash}/2/frame/8.jpg`);
  h.calls[3].finish({type: 'image/jpeg', size: 100}); await flush();
  assert.equal(h.objects.length, 1);
  h.fire('player:destroy'); assert.deepEqual(h.revoked, ['blob:1']);
});

test('chapters navigate explicitly; toggling previews prevents new decoder requests', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.button().events['hover:enter']();
  assert.equal(h.menu().items[1].title, '00:05 · ‹Scene›');
  assert.equal(h.selected(), undefined, 'a chapter is never automatically skipped');
  h.menu().onSelect(h.menu().items[1]); assert.equal(h.selected(), 5);
  h.menu().onSelect(h.menu().items[0]); assert.equal(h.storage.get('homelab_seek_frames'), false);
  h.fire('video:timeupdate', {current: 44}); h.fire('video:rewind', {}); h.tick(1000);
  assert.equal(h.calls.length, 1);
});

test('mobile preview uses native rendered target even when it differs from current time plus touch delta', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.panel.find('.player-panel__timenow').text('00:24'); // native target; currentTime+delta would be36
  h.panel.events['touchmove.homelabPreview']({originalEvent: {touches: [{clientX: 50}]}});
  h.tick(450);
  assert.equal(h.calls[1].url, `/previews/${hash}/1/frame/4.jpg`);
  assert.equal(h.selected(), undefined);
  h.fire('player:destroy'); assert.equal(h.calls[1].signal.aborted, true);
  h.tick(60000); assert.equal(h.calls.length, 2);
});

test('pending responses stop polling after close; unavailable APIs do not break player', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(null, 202); await flush();
  h.fire('player:destroy'); h.tick(60000); assert.equal(h.calls.length, 1);
  assert.doesNotThrow(() => vm.runInNewContext(script, {window: {}}));
});

test('a cold frame stays pending beyond six seconds and displays when generation finishes', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.fire('video:timeupdate', {current: 44}); h.fire('video:rewind', {}); h.tick(450);
  for (let i = 0; i < 7; i++) {
    h.calls.at(-1).finish(null, 202); await flush(); h.tick(1000);
  }
  assert.equal(h.calls.at(-1).signal.aborted, false);
  h.calls.at(-1).finish({type: 'image/jpeg', size: 100}); await flush();
  assert.equal(h.objects.length, 1);
  h.tick(6000); assert.deepEqual(h.revoked, [], 'hiding preserves the bounded frame cache');
  h.fire('video:timeupdate', {current: 44}); h.fire('video:rewind', {});
  assert.equal(h.calls.filter(call => call.url.endsWith('/frame/8.jpg')).length, 8, 'revisiting uses memory immediately without another HTTP call');
  h.fire('player:destroy'); assert.deepEqual(h.revoked, ['blob:1']);
});

test('temporary metadata error recovers automatically and refreshes the open chapter menu', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(null, 503); await flush();
  h.button().events['hover:enter']();
  assert.equal(h.menu().items[1].title, 'Не удалось прочитать главы');
  h.tick(4999); assert.equal(h.calls.length, 1);
  h.tick(1); assert.equal(h.calls.length, 2);
  h.calls[1].finish(info); await flush();
  assert.equal(h.menu().items[1].title, '00:05 · ‹Scene›');
  h.tick(300000); assert.equal(h.calls.length, 2, 'success cancels retries and deadlines');
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
  assert.equal(h.menu().items[1].title, '00:05 · ‹Scene›');
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
  assert.equal(owned.items[1].title, '00:05 · ‹Scene›', 'a stacked selector receives fresh entries without stealing focus');
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
  const overlay = h.elements.find(e => e.htmlValue.includes('homelab-seek-preview hide'));
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

test('temporary frame failures retry while stationary and are cancelled by another file', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  h.fire('panel:mouse_rewind', {method: 'move', percent: .5}); h.tick(450);
  h.calls[1].finish(null, 503); await flush(); h.tick(1000);
  assert.equal(h.calls.length, 3); assert.equal(h.calls[2].url, h.calls[1].url);
  h.calls[2].finish(null, 429); await flush(); h.tick(2000);
  assert.equal(h.calls.length, 4);
  h.calls[3].finish({type: 'image/jpeg', size: 100}); await flush(); assert.equal(h.objects.length, 1);
  h.fire('panel:mouse_rewind', {method: 'move', percent: .6}); h.tick(450); h.calls[4].finish(null, 503); await flush();
  h.ready(2); h.tick(10000); assert.equal(h.calls.length, 6, 'stale retry cannot request another file frame');
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

test('background preparation reports playback phases single-flight and stops heartbeat on close', async t => {
  const h = harness(t), events = {};
  h.video.readyState = 4; h.video.paused = false;
  h.video.addEventListener = (name, fn) => { events[name] = fn; };
  h.video.removeEventListener = name => { delete events[name]; };
  h.ready();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].url, `/previews/${hash}/1/prepare`);
  assert.equal(JSON.parse(h.calls[1].options.body).state, 'playing');
  h.calls[0].finish(info); h.video.readyState = 2; events.waiting();
  assert.equal(h.calls.length, 2, 'a state change joins the pending report');
  h.calls[1].finish({}, 202); await flush();
  assert.equal(h.calls.length, 3); assert.equal(JSON.parse(h.calls[2].options.body).state, 'buffering');
  h.calls[2].finish({}, 202); await flush();
  h.tick(15000); assert.equal(h.calls.length, 4);
  assert.equal(JSON.parse(h.calls[3].options.body).state, 'buffering');
  h.fire('player:destroy'); assert.equal(h.calls[3].signal.aborted, true);
  assert.equal(JSON.parse(h.calls[4].options.body).state, 'closed');
  assert.equal(h.calls[4].options.keepalive, true);
  h.calls[3].fail(); h.calls[4].finish({}, 202); await flush(); h.tick(300000);
  assert.equal(h.calls.length, 5); assert.equal(Object.keys(events).length, 0);
});

test('network stalls cannot leave a playing video reported as buffering', async t => {
  const h = harness(t), events = {};
  h.video.readyState = 4; h.video.paused = false;
  h.video.addEventListener = (name, fn) => { events[name] = fn; };
  h.video.removeEventListener = name => { delete events[name]; };
  h.ready(); h.calls[0].finish(info); h.calls[1].finish({}, 202); await flush();
  events.stalled?.();
  assert.equal(h.calls.length, 2, 'stalled while buffered is not playback waiting');
  h.video.readyState = 2; events.waiting(); h.calls[2].finish({}, 202); await flush();
  h.video.readyState = 4; h.video.currentTime += 15;
  h.tick(15000);
  assert.equal(JSON.parse(h.calls[3].options.body).state, 'playing', 'heartbeat heals a missed playing event');
});

test('native GST video replacement pauses preparation before the first new frame', async t => {
  const h = harness(t), events = {};
  h.video.readyState = 4; h.video.paused = false;
  h.video.addEventListener = (name, fn) => { events[name] = fn; };
  h.video.removeEventListener = name => { delete events[name]; };
  h.ready(); h.calls[0].finish(info); h.calls[1].finish({}, 202); await flush();
  h.fire('video:destroy', {savemeta: true});
  assert.equal(JSON.parse(h.calls[2].options.body).state, 'buffering');
  assert.equal(Object.keys(events).length, 0);
  h.calls[2].finish({}, 202); await flush();
  h.L.PlayerVideo.video = () => ({readyState: 0, paused: false});
  h.tick(15000);
  assert.equal(JSON.parse(h.calls[3].options.body).state, 'buffering');
});

test('native wrappers without readyState retain their last actual playback event', async t => {
  const h = harness(t), events = {};
  h.video.addEventListener = (name, fn) => { events[name] = fn; };
  h.video.removeEventListener = name => { delete events[name]; };
  h.ready(); h.calls[0].finish(info); events.playing();
  h.calls[1].finish({}, 202); await flush(); h.tick(15000);
  assert.equal(JSON.parse(h.calls[2].options.body).state, 'playing');
});

test('ten-second metadata uses explicit step URLs and the matching label', async t => {
  const h = harness(t); h.ready();
  assert.ok(h.calls[0].url.endsWith('/metadata?step=10'));
  h.calls[0].finish({...info, step: 10}); await flush();
  h.fire('video:timeupdate', {current: 44}); h.fire('video:rewind', {}); h.tick(450);
  assert.equal(h.calls[1].url, `/previews/${hash}/1/frame/4.jpg?step=10`);
  assert.equal(h.elements.find(e => e.htmlValue.includes('homelab-seek-preview hide')).find('.homelab-seek-preview__label').textValue, '00:40');
});

test('frame cache is bounded and revisits are immediate without preparation messages', async t => {
  const h = harness(t); h.ready(); h.calls[0].finish(info); await flush();
  const overlay = h.elements.find(e => e.htmlValue.includes('homelab-seek-preview hide'));
  for (let slot = 0; slot < 17; slot++) {
    h.fire('video:timeupdate', {current: slot * 5}); h.fire('video:rewind', {}); h.tick(450);
    assert.equal(overlay.find('.homelab-seek-preview__note').textValue, '');
    h.calls.at(-1).finish({type: 'image/jpeg', size: 100}); await flush();
  }
  assert.deepEqual(h.revoked, ['blob:1']);
  const calls = h.calls.length;
  h.fire('video:timeupdate', {current: 75}); h.fire('video:rewind', {});
  assert.equal(h.calls.length, calls); assert.equal(overlay.find('img').attrs.src, 'blob:16');
  h.fire('video:timeupdate', {current: 0}); h.fire('video:rewind', {}); h.tick(450);
  assert.equal(h.calls.length, calls + 1, 'an evicted frame can be fetched again');
  h.fire('player:destroy'); assert.equal(new Set(h.revoked).size, 17);
});
