const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./ux-harness.cjs');

function setup(t) {
  const h = harness(t), registry = {}, choices = {}, requests = [], requested = [], marks = [], subtitleCalls = [], recoveries = [], rendered = [];
  let active, component, playlist = [], waiting = false, closes = 0, render;
  const callbacks = [], viewedIcons = new Map();
  const storageSet = h.L.Storage.set;
  h.L.Storage.set = function (name, value, silent, error) {
    if (silent) { h.storage.set(name, value); return; }
    return storageSet.call(this, name, value, silent, error);
  };
  h.L.Storage.cache = (name, _max, empty) => h.L.Storage.get(name, empty).slice();
  h.L.Storage.remove = (name, value) => h.L.Storage.set(name, h.L.Storage.get(name, []).filter(entry => entry !== value));
  h.L.Template = {get: name => { assert.equal(name, 'icon_viewed'); return '<svg></svg>'; }};
  h.L.PlayerPlaylist = {get: () => playlist, listener: {follow(name, callback) { assert.equal(name, 'set'); callbacks.push(callback); }}};
  h.L.Player.playlist = value => { playlist = value; callbacks.forEach(callback => callback({playlist, position: Math.max(0, playlist.indexOf(h.work()))})); };
  h.L.Player.close = () => { closes++; waiting = false; h.destroy(); playlist = []; };
  h.L.Utils.hash = value => 'hash-' + value;
  const roads = new Map();
  h.L.Timeline.view = (hash, metadata) => { if (!roads.has(hash)) roads.set(hash, {hash, time: 0, percent: 0, ...metadata}); return roads.get(hash); };
  h.L.Timeline.render = value => value;
  function Native(object) {
    this.getChoice = provider => choices[provider] || {};
    this.replaceChoice = (value, provider) => { choices[provider] = {...choices[provider], ...value}; };
    this.startSource = () => { h.L.Storage.set('active_balanser', 'kinobase'); return Promise.resolve(); };
    this.toPlayElement = file => ({title: file.title, url: file.url, quality: file.qualitys, timeline: file.timeline, season: file.season, episode: file.episode,
      subtitles: file.subtitles, segments: file.segments, callback: file.mark, thumbnail: file.thumbnail, voice_name: file.voice_name});
    this.getFileUrl = (file, done) => { requested.push(file.episode); requests.push({file, done}); };
    this.orUrlReserve = work => { if (typeof work.url === 'string' && work.url.includes(' or ')) [work.url, work.url_reserve] = work.url.split(' or '); };
    this.setDefaultQuality = work => { if (work.quality?.['2160p']) work.url = work.quality['2160p']; };
    this.loadSubtitles = url => subtitleCalls.push(url);
    this.draw = (items, params) => { render = () => items.forEach(file => {
      file.timeline = {hash: 'ambiguous-movie-hash', time: 80, percent: 50};
      const hash = h.L.Utils.hash(file.season ? [file.season, '', file.episode, object.movie.original_title, file.voice_name].join('') : object.movie.original_title + file.voice_name);
      viewedIcons.set(file, h.L.Storage.cache('online_view', 5000, []).includes(hash));
      file.mark = () => { h.L.nativeMarkEffects?.(); const viewed = h.L.Storage.cache('online_view', 5000, []); if (!viewed.includes(hash)) { viewed.push(hash); h.L.Storage.set('online_view', viewed); } viewedIcons.set(file, true); marks.push(file.episode); };
      file.unmark = () => { h.L.Storage.set('online_view', h.L.Storage.cache('online_view', 5000, []).filter(value => value !== hash)); h.L.Storage.remove('online_view', hash); viewedIcons.set(file, false); };
      const html = {find: selector => ({empty() { return this; }, append(value) { if (selector === '.online-prestige__timeline') rendered.push(value); else if (selector === '.online-prestige__img') viewedIcons.set(file, true); return this; }, remove() { viewedIcons.set(file, false); return this; }})};
      params.onRender?.(file, html, {hash_behold: hash});
    }); };
    // Public native display contract: its truthy-season branch loses the S0 playlist.
    this.display = items => this.draw(items, {onEnter: file => this.getFileUrl(file, (stream, metadata = {}) => {
      if (!stream?.url) return;
      const first = this.toPlayElement(file);
      Object.assign(first, {url: stream.url, headers: metadata.headers || stream.headers, quality: metadata.quality || file.qualitys,
        segments: metadata.segments || file.segments, subtitles: stream.subtitles, subtitles_call: metadata.subtitles_call || stream.subtitles_call,
        hls_manifest_timeout: metadata.hls_manifest_timeout || stream.hls_manifest_timeout});
      this.orUrlReserve(first); this.setDefaultQuality(first);
      const list = file.season ? items.map(entry => entry === file ? first : this.toPlayElement(entry)) : [first];
      h.L.Player.play(first); h.L.Player.playlist(list);
      if (first.subtitles_call) this.loadSubtitles(first.subtitles_call); file.mark();
    }, true)});
    this.destroy = () => {};
  }
  registry.lampac = Native;
  h.L.Component = {get: name => registry[name], add: (name, ctor) => { registry[name] = ctor; }};
  h.L.Activity = {active: () => active, push(object) { active = object; if (registry[object.component]) component = new registry[object.component](object); }};
  h.window.HomelabSources = {resume(item, movie) { recoveries.push({item, movie}); active = {component: 'homelab_sources'}; return true; }};
  h.run('mods/HomelabSync/online.js');
  const movie = {id: 42, name: 'Series', original_title: 'Original', source: 'tmdb', number_of_seasons: 1};
  const files = [3, 1, 2].map(episode => ({season: 0, episode, method: 'call', title: 'Special ' + episode, voice_name: 'Preferred', url: 'resolver-' + episode,
    qualitys: {'2160p': 'catalog-4k', '1080p': 'catalog-fhd'}, subtitles: [{url: 'catalog-sub'}], segments: {skip: []}, thumbnail: '/still-' + episode + '.jpg'}));
  function result(episode) { return {url: 'fresh-' + episode, subtitles: [{url: 'sub-' + episode}], subtitles_call: 'subtitles-' + episode}; }
  function select(index) {
    const cell = playlist[index];
    function play() {
      const saved = playlist; waiting = false; h.destroy(); playlist = [];
      h.L.Player.play(cell); h.L.Player.playlist(saved); cell.callback?.();
    }
    if (typeof cell.url === 'function') { if (!waiting) { waiting = true; cell.url(play); } } else play();
  }
  return {...h, files, requested, requests, marks, subtitleCalls, recoveries, rendered, select,
    movie, viewedIcons, redraw() { component.display(files); render(); }, active: () => active, component: () => component, playlist: () => playlist, waiting: () => waiting, closes: () => closes,
    leave() { active = {component: 'main'}; },
    resolve(stream, metadata) { const request = requests.shift(); request.done(stream === undefined ? result(request.file.episode) : stream, metadata); },
    async open({season = 0, manual = false, quality = 1080, position = 71} = {}) {
      files.forEach(file => { file.season = season; });
      if (manual) h.L.Activity.push({component: 'lampac', movie});
      else h.window.HomelabOnlineResume.resume({card: 'tv_42', season, episode: 2, position, online: {provider: 'kinobase', voice: 'Preferred', season_index: 0}}, movie, () => assert.fail('unexpected continuation failure'), {quality});
      await component.startSource(); component.display(files); render(); h.tick(0);
      if (manual) component.getFileUrl(files[2], stream => { const work = component.toPlayElement(files[2]); work.url = stream.url; h.L.Player.play(work); h.L.Player.playlist([work]); });
    },
    metadata: {headers: {Referer: 'https://provider.test/'}, quality: {'2160p': 'resolved-4k', '1080p': 'resolved-fhd'}, segments: {skip: [{start: 0, end: 5}]}, hls_manifest_timeout: 45000},
  };
}

test('Specials restore a full ordered playlist and distinct canonical timelines without resolving peers', async t => {
  const h = setup(t); await h.open(); assert.deepEqual(h.requested, [2]);
  h.resolve(undefined, h.metadata); const selected = h.work(); h.tick(0);
  assert.deepEqual(h.playlist().map(work => work.episode), [1, 2, 3]); assert.equal(h.playlist()[1], selected);
  assert.deepEqual(h.playlist().map(work => work.timeline.hash), ['hash-01Original', 'hash-02Original', 'hash-03Original']);
  assert.ok(h.playlist().every(work => work.timeline.time === 0)); assert.equal(selected.homelab_resume_at, 71);
  assert.deepEqual(h.requested, [2]); assert.equal(selected.headers, h.metadata.headers); assert.equal(selected.subtitles[0].url, 'sub-2'); assert.equal(selected.url, 'resolved-fhd');
  assert.equal(h.playlist()[0].homelab_resume_at, undefined); assert.doesNotThrow(() => JSON.stringify(h.playlist()));
});

test('native Next lazily resolves the requested Special and preserves tracks, subtitles and headers', async t => {
  const h = setup(t); await h.open(); h.resolve(undefined, h.metadata); h.tick(0); const list = h.playlist();
  h.select(2); assert.deepEqual(h.requested, [2, 3]); assert.equal(h.work().episode, 2);
  h.resolve(undefined, h.metadata); h.tick(0);
  assert.equal(h.work().episode, 3); assert.equal(h.playlist(), list); assert.equal(h.work().headers, h.metadata.headers);
  assert.equal(h.work().subtitles[0].url, 'sub-3'); assert.equal(h.work().url, 'resolved-fhd'); assert.equal(h.work().homelab_online.provider, 'kinobase');
  assert.equal(h.work().homelab_resume_at, undefined); assert.ok(h.subtitleCalls.includes('subtitles-3')); assert.ok(h.marks.includes(3));
});

for (const changed of ['profile', 'activity', 'playback', 'component']) test(`a stale Specials resolver cannot launch or close after ${changed} changes`, async t => {
  const h = setup(t); await h.open(); h.resolve(); h.tick(0); h.select(0);
  if (changed === 'profile') h.profile('other');
  if (changed === 'activity') h.leave();
  if (changed === 'playback') h.start({url: 'other-video'});
  if (changed === 'component') h.component().destroy();
  h.resolve(false); h.tick(0); assert.equal(h.closes(), 0); assert.equal(h.recoveries.length, 0); assert.notEqual(h.work().episode, 1);
});

test('only the latest lazy Specials request may complete', async t => {
  const h = setup(t); await h.open(); h.resolve(); h.tick(0); let old = 0, latest = 0;
  h.playlist()[0].url(() => old++); h.playlist()[2].url(() => latest++);
  h.resolve(); h.resolve(); assert.equal(old, 0); assert.equal(latest, 1);
});

test('a failed Next clears the native wait through public close and offers the exact target at zero', async t => {
  const h = setup(t); h.run('mods/HomelabSync/continue.js'); await h.open(); h.resolve(); h.tick(0);
  h.video().currentTime = 42; h.videoEvent('timeupdate'); h.select(2); assert.equal(h.waiting(), true);
  h.resolve(false); h.tick(0);
  assert.equal(h.closes(), 1); assert.equal(h.waiting(), false); assert.equal(h.recoveries.length, 1);
  assert.equal(h.recoveries[0].item.season, 0); assert.equal(h.recoveries[0].item.episode, 3); assert.equal(h.recoveries[0].item.position, 0);
  const observations = h.calls.filter(call => call.options.method === 'POST').map(call => JSON.parse(call.options.body));
  assert.ok(observations.some(item => item.episode === 2 && item.position === 42)); assert.ok(observations.every(item => item.episode === 2));
});

test('manual Specials get the same adapter while positive seasons keep the native playlist', async t => {
  const h = setup(t); await h.open({manual: true}); h.resolve(); h.tick(0); assert.equal(h.playlist().length, 3);
  h.L.Player.close(); await h.open({season: 1}); h.resolve(); h.tick(0); assert.equal(h.playlist().length, 3);
  assert.ok(h.playlist().every(work => work.timeline.hash === 'ambiguous-movie-hash'), 'positive-season timeline behavior stays native');
});


test('failed Next without the recovery picker opens native source selection without autoplay', async t => {
  const h = setup(t); await h.open(); h.resolve(); h.tick(0); h.window.HomelabSources = undefined;
  h.select(2); h.resolve(false); h.tick(0);
  assert.equal(h.closes(), 1); assert.equal(h.waiting(), false); assert.equal(h.work(), null);
  assert.equal(h.active().component, 'lampac'); assert.equal(h.active().lampac_custom_select, 'kinobase');
  assert.equal(h.active().homelab_online_intent, undefined); assert.deepEqual(h.requested, [2, 3]);
});

test('deferred Specials repair does not replace a different playlist', async t => {
  const h = setup(t); await h.open(); h.resolve();
  const other = [{url: 'unrelated-list'}]; h.L.Player.playlist(other); h.tick(0);
  assert.equal(h.playlist(), other); assert.deepEqual(h.requested, [2]);
});


test('direct-play Specials use native quality maps rather than the display quality label', async t => {
  const h = setup(t); await h.open(); h.resolve(); h.tick(0);
  const direct = h.files[1];
  Object.assign(direct, {method: 'play', url: 'direct-stream', quality: '1080p', qualitys: {'1080p': 'direct-fhd', '720p': 'direct-hd'}, headers: {Referer: 'https://direct.test/'}});
  h.select(0); h.resolve(direct, {}); h.tick(0);
  assert.equal(h.work().episode, 1); assert.equal(typeof h.work().quality, 'object');
  assert.deepEqual(Object.keys(h.work().quality), ['1080p']); assert.equal(h.work().url, 'direct-fhd');
  assert.equal(h.work().headers, direct.headers);
});


test('Specials ignore ambiguous legacy viewed marks and preserve them while marking one episode', async t => {
  const h = setup(t), legacy = 'hash-OriginalPreferred'; h.L.Storage.set('online_view', [legacy]);
  await h.open({manual: true}); const e1 = h.files[1], e2 = h.files[2];
  assert.equal(h.viewedIcons.get(e1), false); assert.equal(h.viewedIcons.get(e2), false);
  e1.mark();
  assert.deepEqual(h.L.Storage.get('online_view'), [legacy, 'hash-01OriginalPreferred']);
  assert.equal(h.viewedIcons.get(e1), true); assert.equal(h.viewedIcons.get(e2), false); assert.deepEqual(h.marks, [1]);
  h.redraw(); assert.equal(h.viewedIcons.get(e1), true); assert.equal(h.viewedIcons.get(e2), false);
});

test('Specials replace only newly added ambiguous marks; unmark preserves other episodes and native effects run once', async t => {
  const h = setup(t); await h.open({manual: true}); const e1 = h.files[1], e2 = h.files[2];
  e1.mark(); e2.mark();
  assert.deepEqual(h.L.Storage.get('online_view'), ['hash-01OriginalPreferred', 'hash-02OriginalPreferred']);
  e1.unmark(); assert.deepEqual(h.L.Storage.get('online_view'), ['hash-02OriginalPreferred']);
  assert.equal(h.viewedIcons.get(e1), false); assert.equal(h.viewedIcons.get(e2), true); assert.deepEqual(h.marks, [1, 2]);
  h.redraw(); e1.mark(); assert.deepEqual(h.marks, [1, 2, 1]);
});

test('Specials unmark preserves legacy viewed state and stale mark callbacks have no effects', async t => {
  const h = setup(t), legacy = 'hash-OriginalPreferred'; h.L.Storage.set('online_view', [legacy]);
  await h.open({manual: true}); const e1 = h.files[1], e2 = h.files[2];
  e1.mark(); e1.unmark(); assert.deepEqual(h.L.Storage.get('online_view'), [legacy]);
  const marked = h.marks.length; h.profile('new-profile'); e2.mark(); e1.unmark();
  assert.equal(h.marks.length, marked); assert.deepEqual(h.L.Storage.get('online_view'), [legacy]);
});

test('positive-season viewed hashes and native mark behavior remain unchanged', async t => {
  const h = setup(t); await h.open({season: 1, manual: true}); const e1 = h.files[1];
  e1.mark(); assert.deepEqual(h.L.Storage.get('online_view'), ['hash-11OriginalPreferred']);
  e1.unmark(); assert.deepEqual(h.L.Storage.get('online_view'), []); assert.deepEqual(h.marks, [1]);
});


test('native Specials mark writes are silent and only canonical viewed values are published', async t => {
  const h = setup(t), canonical = 'hash-01OriginalPreferred'; h.L.Storage.set('online_view', [canonical]);
  const changes = []; h.L.Storage.listener.follow('change', event => { if (event.name === 'online_view') changes.push([...event.value]); });
  const setter = h.L.Storage.set; await h.open({manual: true}); h.files[1].mark();
  assert.equal(h.L.Storage.set, setter); assert.deepEqual(h.L.Storage.get('online_view'), [canonical]);
  assert.ok(changes.length); assert.ok(changes.every(values => !values.includes('hash-OriginalPreferred')));
});


test('scoped native viewed writes preserve other writes, receiver and error callback', async t => {
  const h = setup(t); await h.open({manual: true}); const writes = [], base = h.L.Storage.set, error = () => {};
  h.L.Storage.set = function (...args) { writes.push({receiver: this, args}); return base.apply(this, args); };
  const setter = h.L.Storage.set;
  h.L.nativeMarkEffects = () => { h.L.Storage.set('online_view', [], false, error); h.L.Storage.set('native-choice', 'kept', false, error); };
  h.files[1].mark(); assert.equal(h.L.Storage.set, setter);
  assert.equal(writes[0].receiver, h.L.Storage); assert.equal(writes[0].args[2], true); assert.equal(writes[0].args[3], error);
  assert.equal(writes[1].args[0], 'native-choice'); assert.equal(writes[1].args[2], false); assert.equal(writes[1].args[3], error);
  assert.equal(h.L.Storage.get('native-choice'), 'kept');
});

test('scoped native viewed setter is restored when the native mark throws', async t => {
  const h = setup(t); await h.open({manual: true}); const setter = h.L.Storage.set;
  h.L.nativeMarkEffects = () => { throw new Error('native mark failure'); };
  assert.throws(() => h.files[1].mark(), /native mark failure/); assert.equal(h.L.Storage.set, setter);
});


for (const existing of [true, false]) test(`a full native viewed cache publishes only canonical S0 markers (existing=${existing})`, async t => {
  const h = setup(t), canonical = 'hash-01OriginalPreferred', legacy = 'hash-OriginalPreferred';
  const seed = Array.from({length: 5000}, (_, index) => 'seen-' + index); if (existing) seed[0] = canonical;
  h.L.Storage.set('online_view', seed);
  const internalSet = h.L.Storage.set, changes = [];
  h.L.Storage.cache = (name, maximum, empty) => {
    let values = h.L.Storage.get(name, empty).slice();
    if (values.length > maximum) { values = values.slice(-maximum); internalSet(name, values); }
    return values;
  };
  h.L.Storage.listener.follow('change', event => { if (event.name === 'online_view') changes.push([...event.value]); });
  await h.open({manual: true}); h.files[1].mark();
  const values = h.L.Storage.get('online_view');
  assert.equal(values.length, 5000); assert.ok(values.includes(canonical)); assert.ok(!values.includes(legacy));
  assert.ok(changes.every(value => !value.includes(legacy)), 'closed native cache trims must not publish the ambiguous value');
});
