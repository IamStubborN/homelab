const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {flush} = require('./ux-harness.cjs');

function setup(t, options = {}) {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const noAbort = !!options.noAbort; // old webviews: no AbortController and fetch ignores signals
  const requests = [], pages = new Map(), registry = {}, parser = [], notifications = [], storage = new Map();
  let scope = 'profile-a', clears = 0, active = 0, peak = 0;
  const dollar = () => ({append() { return this; }, text() { return this; }});
  const L = {Storage: {get: (key, value) => storage.get(key) ?? value, set: (key, value) => storage.set(key, value), field: () => true}, Utils: {hash: value => 'hash:' + value}, Component: {add: (name, ctor) => { registry[name] = ctor; }},
    Scroll() {}, Controller: {collectionFocus() {}}, Listener: {follow() {}}, Activity: {active: () => null},
    Parser: {get: (object, done, fail) => parser.push({object, done, fail}), clear: () => clears++}};
  const window = {appready: true, Lampa: L, $: dollar, fetch: request, AbortController: options.noAbort ? undefined : AbortController,
    HomelabSync: {scope: () => scope, url: pathname => 'https://lampac.test' + pathname + '?token=private-fixture&profile_id=' + scope}};
  function request(url, options) {
    return new Promise((resolve, reject) => {
      active++; peak = Math.max(peak, active); let settled = false;
      const job = {url: new URL(url), options, started: Date.now(), finish(body) { if (settled) return; settled = true; active--; const status = body && body.__status || 200; resolve({ok: status < 400, status, headers: {get: () => body && body.__type || ''}, text: async () => typeof body === 'string' ? body : JSON.stringify(body)}); }};
      if (!noAbort) options.signal.addEventListener('abort', () => { if (!settled) { settled = true; active--; reject(new Error('aborted')); }});
      requests.push(job);
    });
  }
  // Catalog traversal is tested through the browser DOM contract; real HTML parsing is also
  // exercised by the native-frontend browser fixture, without adding a DOM library here.
  const document = {createElement() {
    const template = {innerHTML: ''};
    template.content = {querySelectorAll: selector => (pages.get(template.innerHTML)?.[selector] || []).map(value => ({
      getAttribute: key => key === 'data-json' ? JSON.stringify(value) : key === 's' && value.season != null ? String(value.season) : key === 'e' && value.episode != null ? String(value.episode) : null,
      textContent: value.text || '', classList: {contains: key => key === 'active' && value.active},
    }))}; return template;
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugins/common-sources.js'), 'utf8'),
    {window, Lampa: L, document, fetch: request, AbortController: options.noAbort ? undefined : AbortController, URL, setTimeout, clearTimeout, Date, console});
  const movie = {id: 42, name: 'Series', original_title: 'Original', imdb_id: 'tt42', kinopoisk_id: '42'};
  const selection = {season: 2, episode: 3};
  const search = new window.HomelabSources.Search(movie, selection, value => notifications.push(value.rows.length));
  function source(name, url = 'https://lampac.test/lite/' + name) { return {balanser: name, name, url, show: true}; }
  return {window, L, requests, pages, parser, movie, selection, search, source, notifications, clears: () => clears, peak: () => peak,
    profile: value => { scope = value; }, tick: ms => t.mock.timers.tick(ms),
    async finish(pathname, body) { t.mock.timers.tick(700); await flush(); const job = requests.find(r => r.url.pathname === pathname && !r.completed); assert.ok(job, pathname); job.completed = true; job.finish(body); await flush(); t.mock.timers.tick(700); await flush(); },
    start: async () => { search.start(); await flush(); },
  };
}

test('source search repairs a TV Explorer placeholder on its own copy', async t => {
  const h = setup(t);
  h.movie.title = 'Фильм не найден';
  const search = new h.window.HomelabSources.Search(h.movie, h.selection, () => {});
  search.start(); await flush(); h.tick(700); await flush();
  const request = h.requests.find(job => job.url.pathname === '/lite/events');
  assert.equal(request.url.searchParams.get('title'), 'Series');
  assert.equal(h.movie.title, 'Фильм не найден');
  search.cancel();
});

test('common picker discovers voices for exactly one episode with two catalog requests and no media resolution', async t => {
  const h = setup(t); await h.start();
  await h.finish('/lite/events', [h.source('one'), h.source('two'), h.source('three')]);
  assert.equal(h.requests.filter(r => r.url.pathname.startsWith('/lite/') && !r.completed).length, 2);
  h.pages.set('seasons', {'.videos__item': [{method: 'link', text: 'Сезон 1', url: '/lite/one?s=1'}, {method: 'link', text: 'Сезон 2', url: '/lite/one?s=2'}]});
  h.pages.set('episode', {'.videos__item': [{method: 'call', text: 'Episode 2', season: 2, episode: 2}, {method: 'play', text: 'Episode 3', season: 2, episode: 3, url: '/media', quality: {'1080p': '/media'}}],
    '.videos__button': [{active: true, text: 'Preferred', url: '/lite/one?s=2'}, {text: 'Alternate', url: '/lite/one?s=2&voice=alternate'}]});
  // Realistic Lampac "call" items carry no quality map: quality stays unknown until playback.
  h.pages.set('alternate', {'.videos__item': [{method: 'call', text: 'Episode 3', season: 2, episode: 3, url: '/lite/one/video?e=3'}], '.videos__button': [{active: true, text: 'Alternate', url: '/lite/one?s=2&voice=alternate'}]});
  await h.finish('/lite/one', 'seasons');
  await h.finish('/lite/two', {rch: true});
  await h.finish('/lite/three', {rch: true});
  await h.finish('/lite/one', 'episode');
  await h.finish('/lite/one', 'alternate');
  const rows = h.search.rows.filter(r => !r.native);
  assert.deepEqual(Array.from(rows, r => r.voice), ['Preferred', 'Alternate']);
  assert.equal(rows[0].seasonIndex, 1); assert.equal(rows[0].identityVoice, 'Preferred');
  assert.deepEqual(Array.from(rows[0].qualities), [1080]); assert.deepEqual(Array.from(rows[1].qualities), []);
  assert.equal(h.search.onlinePending, false); assert.equal(h.peak(), 2);
  assert.ok(h.requests.every(r => !r.url.pathname.includes('media')));
  assert.ok(!h.requests.some(r => r.url.searchParams.get('s') === '1'));
  assert.equal(h.requests.filter(r => r.url.searchParams.get('voice') === 'alternate').length, 1, 'voice links are visited once');
  assert.ok(h.requests.slice(1).every((r, i) => r.started - h.requests[i].started >= 350), 'cached catalog pages are paced too');
  h.search.cancel();
});

test('torrent results retain the native release and arrive even when online discovery has failed', async t => {
  const h = setup(t); await h.start();
  const release = {Title: 'Series S02 1080p', MagnetUri: 'magnet:?xt=urn:btih:fixture', Tracker: 'Tracker', Seeders: 42, Size: 123};
  h.parser[0].done({Results: [release, {...release}]});
  assert.equal(h.search.rows.length, 1); assert.equal(h.search.rows[0].release, release);
  assert.equal(h.parser[0].object.movie.id, 42);
  await h.finish('/lite/events', {accsdb: true});
  assert.equal(h.search.onlinePending, false); assert.equal(h.search.torrentPending, false);
  h.search.cancel();
});

test('serial releases exclude explicit other seasons/episodes but retain full-season packs and unknown file coverage', async t => {
  const h = setup(t); await h.start();
  h.parser[0].done({Results: ['Series S01 1080p', 'Series S02E02 1080p', 'Series S01-S03', 'Series S02E01-E12', 'Series 01-26', 'Series Сезон 1', 'Series 2 сезон'].map((Title, i) => ({Title, Link: 'magnet:' + i}))});
  assert.deepEqual(Array.from(h.search.rows, row => row.release.Title), ['Series S01-S03', 'Series S02E01-E12', 'Series 01-26', 'Series 2 сезон']);
  h.search.cancel();
});

test('identity material is never sent to a foreign provider URL or foreign voice link', async t => {
  const h = setup(t); await h.start();
  await h.finish('/lite/events', [h.source('foreign', 'https://foreign.test/lite/root'), h.source('one')]);
  h.pages.set('foreign-link', {'.videos__item': [{method: 'link', text: 'Сезон 2', url: 'https://foreign.test/lite/voice'}]});
  await h.finish('/lite/one', 'foreign-link');
  assert.ok(h.requests.every(r => r.url.origin === 'https://lampac.test'));
  assert.ok(h.requests.every(r => r.url.searchParams.get('token') === 'private-fixture'));
  assert.equal(h.search.rows.length, 2); assert.ok(h.search.rows.every(r => r.native));
  h.search.cancel();
});

test('profile changes and cancellation reject stale results and do not clear a newer owned parser search', async t => {
  const h = setup(t); await h.start();
  h.profile('other'); h.parser[0].done({Results: [{Title: 'Wrong household', Link: 'magnet:wrong'}]});
  await h.finish('/lite/events', [h.source('one')]);
  assert.equal(h.search.rows.length, 0); assert.equal(h.requests.length, 1);
  const newer = new h.window.HomelabSources.Search(h.movie, h.selection, () => {}); newer.start(); await flush();
  h.search.cancel(); assert.equal(h.clears(), 0);
  newer.cancel(); assert.equal(h.clears(), 1);
  assert.ok(h.requests.slice(1).every(r => r.options.signal.aborted));
  await flush(); assert.equal(newer.onlinePending, false, 'aborted promises cannot resurrect a cancelled spinner');
  h.tick(60000); await flush(); assert.equal(h.search.rows.length, 0);
});

test('polling and per-request timeouts terminate without leaving an endless search spinner', async t => {
  const h = setup(t); await h.start();
  await h.finish('/lite/events', {life: true, memkey: 'fixture'});
  h.tick(16000); await flush();
  assert.equal(h.search.onlinePending, false);
  h.tick(45000); await flush();
  assert.equal(h.search.torrentPending, false); assert.equal(h.clears(), 1);
  assert.equal(h.search.errors.length, 2);
  h.search.cancel(); assert.equal(h.clears(), 1);
});


test('release labels use actual voice metadata, retain codec and never invent a voice from the release title', t => {
  const h = setup(t), describe = h.window.HomelabSources.describeRelease;
  const unknown = describe({Title: 'Series S02 WEB-DL 1080p HEVC Huge Studio Name', info: {voices: [], videotype: 'sdr'}});
  assert.equal(unknown.title, 'Озвучка в раздаче'); assert.equal(unknown.codec, 'HEVC');
  assert.equal(describe({Title: 'Release', info: {voices: ['Preferred', 'Other', 'Third']}}).title, 'Preferred / Other +1');
  const probe = describe({ffprobe: [{codec_type: 'video', codec_name: 'h264'}, {codec_type: 'audio', tags: {title: 'Preferred'}}, {codec_type: 'audio', tags: {handler_name: 'Audio Handler'}}]});
  assert.equal(probe.title, 'Preferred'); assert.equal(probe.codec, 'AVC');
});

test('favorite voice and quality are profile scoped, validated and reused across providers', t => {
  const h = setup(t), api = h.window.HomelabSources;
  api.preferences({voice: 'Preferred', quality: 1080});
  assert.equal(api.preferences().quality, 1080);
  const row = (key, voice, extra = {}) => ({key, kind: 'online', identityVoice: voice, providerName: key, qualities: [1080], ...extra});
  const rows = [row('z', 'Other'), row('b', 'Preferred'), row('a', 'preferred'), row('t1', '', {kind: 'torrent', release: {Seeders: 3}}), row('t2', '', {kind: 'torrent', release: {Seeders: 30}}), row('n', 'Preferred', {native: true})];
  rows.sort((a,b) => api.compareRows(a,b,api.preferences()));
  assert.deepEqual(rows.map(r => r.key), ['a', 'b', 'z', 't2', 't1', 'n']);
  api.preferences({quality: 999, voice: 'x'.repeat(201)}); assert.equal(api.preferences().voice, 'Preferred');
  h.profile('b'); assert.equal(api.preferences().voice, ''); assert.equal(api.preferences().quality, 0);
  h.profile('profile-a'); assert.equal(api.preferences().voice, 'Preferred');
});

test('recovery fully closes the owned player before opening exact episode alternatives and rejects stale callbacks', t => {
  const h = setup(t), pushes = [], activity = {}, work = {card: h.movie, season: 2, episode: 3, homelab_online: {provider: 'one', voice: 'Preferred'}};
  let opened = true, current = work, closes = 0;
  h.L.Player = {playdata: () => current, opened: () => opened, close() { closes++; opened = false; }};
  h.L.Activity = {active: () => activity, push: value => pushes.push(value)};
  assert.equal(h.window.HomelabSources.recover(work, {position: 71, duration: 120}, false), true);
  assert.equal(closes, 1); assert.equal(pushes.length, 0); h.tick(0);
  const recovery = pushes[0].homelab_recovery;
  assert.equal(recovery.position, 71); assert.equal(recovery.voice, 'Preferred'); assert.equal(recovery.excludeProvider, 'one'); assert.equal(recovery.episode, 3);
  opened = true; h.window.HomelabSources.recover(work, {position: 22, duration: 120}, false); h.profile('other'); h.tick(0); assert.equal(pushes.length, 1);
  h.profile('profile-a'); opened = true; h.window.HomelabSources.recover(work, {position: 22, duration: 120}, false); current = {...work}; opened = true; h.tick(0); assert.equal(pushes.length, 1);
});


test('torrent recovery dismisses only the captured native file modal restored by Player.close', t => {
  const h = setup(t), modal = {}, work = {card: h.movie, season: 2, episode: 3, homelab_torrent_hash: 'a'.repeat(40)};
  let opened = true, modalOpen = true, modalCloses = 0, controller = 'player', pushes = 0;
  h.L.Player = {playdata: () => work, opened: () => opened, close() { opened = false; controller = 'modal'; }};
  h.L.Modal = {opened: () => modalOpen, render: () => ({0: modal, find: () => ({length: 1})}), close() { modalCloses++; modalOpen = false; }};
  h.L.Activity.push = () => { pushes++; controller = 'content'; };
  h.window.HomelabSources.recover(work, {position: 71, duration: 120}, false); h.tick(0);
  assert.equal(modalCloses, 1); assert.equal(modalOpen, false); assert.equal(pushes, 1); assert.equal(controller, 'content');
});


test('recovery cannot transfer an unrecognized torrent episode position to episode one', t => {
  const h = setup(t), work = {card: h.movie, season: 1, episode: 0}; let closed = false;
  h.L.Player = {playdata: () => work, opened: () => true, close() { closed = true; }};
  assert.equal(h.window.HomelabSources.recover(work, {position: 71, duration: 120}, false), false);
  assert.equal(closed, false);
});

test('soft voice matching recognizes whole known studio aliases but keeps exact matches stronger', t => {
  const match = setup(t).window.HomelabSources.voiceMatch;
  assert.equal(match('Кубик в кубе (18+)', 'Кубик в кубе (18+)'), 2);
  for (const [a,b] of [['Кубик в кубе (18+)', 'Кубик в Кубе, 4К'], ['Кубик в кубе', 'Kubik v Kube'], ['Дубляж [RHS, 4K]', 'Дублированный Red Head Sound'], ['HDRezka Studio', 'Профессиональный многоголосый HDRezka 18+'], ['LostFilm', 'lost film'], ['AniLibria.TV', 'Анилибрия']]) {
    assert.equal(match(a,b), 1, a+' / '+b); assert.equal(match(b,a), 1, 'symmetric alias match');
  }
  assert.equal(match('Unknown Custom Studio', 'unknown-custom.studio'), 2, 'exact normalized names need no alias table');
});

test('soft voice rules never guess from partial names, mixed studios, unknown labels or unrecognized cut flags', t => {
  const match = setup(t).window.HomelabSources.voiceMatch;
  for (const [a,b] of [['', ''], ['Неизвестно', 'Неизвестно'], ['Оригинал', 'Оригинал'], ['Studio One', 'Studio 1'], ['Кубик в кубе', 'Кубик в кубе / LostFilm'], ['Кубик в кубе', 'Кубик в кубе без цензуры'], ['LostFilm', 'NotLostFilm'], ['RHS', 'RHS subtitles'], ['HDRezka', 'Red Head Sound'], ['Unknown 4K', 'Unknown 1080p']]) assert.equal(match(a,b), 0, a+' / '+b);
});

test('a failed saved source opens an exact episode chooser with position and permits trying the original provider again', t => {
  const h=setup(t),pushes=[];h.L.Player={opened:()=>false};h.L.Activity.push=value=>pushes.push(value);
  const item={card:'tv_42',season:2,episode:3,position:71,duration:120,online:{provider:'one',voice:'Preferred'}};
  assert.equal(h.window.HomelabSources.resume(item,h.movie),true);
  const r=pushes[0].homelab_recovery;assert.equal(r.position,71);assert.equal(r.episode,3);assert.equal(r.voice,'Preferred');assert.equal(r.excludeProvider,'');assert.equal(r.scope,'profile-a');
  assert.equal(h.window.HomelabSources.resume({...item,episode:0},h.movie),false);
  assert.equal(h.window.HomelabSources.resume({...item,card:'tv_43'},h.movie),false);
  h.L.Player.opened=()=>true;assert.equal(h.window.HomelabSources.resume(item,h.movie),false);assert.equal(pushes.length,1);
});

test('specials metadata routes the explicit zero season folder and preserves recovery identity', async t => {
  const h = setup(t); h.selection.season = 0; await h.start();
  h.pages.set('seasons', {'.videos__item': [{method: 'link', text: 'Extras 9', season: 0, url: '/lite/one?s=0'}, {method: 'link', text: 'Сезон 1', season: 1, url: '/lite/one?s=1'}]});
  h.pages.set('specials', {'.videos__item': [{method: 'call', text: 'Special', season: 0, episode: 3, voice_name: 'Preferred'}]});
  await h.finish('/lite/events', [h.source('one')]); await h.finish('/lite/one', 'seasons'); await h.finish('/lite/one', 'specials');
  assert.equal(h.search.rows.length, 1); assert.equal(h.search.rows[0].native, undefined);
  const pushes = []; h.L.Player = {opened: () => false}; h.L.Activity.push = item => pushes.push(item);
  assert.equal(h.window.HomelabSources.resume({card: 'tv_42', season: 0, episode: 3, position: 71, duration: 120}, h.movie), true);
  assert.equal(pushes[0].homelab_recovery.season, 0); h.search.cancel();
});

test('an unnumbered unknown folder never becomes specials and unknown recovery seasons are rejected', async t => {
  const h = setup(t); h.selection.season = 0; await h.start();
  h.pages.set('unknown', {'.videos__item': [{method: 'link', text: 'Unknown folder', url: '/lite/one?folder=unknown'}]});
  await h.finish('/lite/events', [h.source('one')]); await h.finish('/lite/one', 'unknown');
  assert.equal(h.search.rows.length, 1); assert.equal(h.search.rows[0].native, true);
  assert.ok(!h.requests.some(job => job.url.searchParams.has('folder')));
  h.L.Player = {opened: () => false}; h.L.Activity.push = () => assert.fail('unknown season must not navigate');
  for (const season of [undefined, null, '', false, -1]) assert.equal(h.window.HomelabSources.resume({card: 'tv_42', season, episode: 3}, h.movie), false);
  h.search.cancel();
});

test('playback recovery preserves an explicitly known specials season zero', t => {
  const h = setup(t), activity = {}, pushes = [], work = {card: h.movie, season: 0, episode: 3, homelab_online: {provider: 'one', voice: 'Preferred'}};
  let opened = true;
  h.L.Player = {playdata: () => work, opened: () => opened, close() { opened = false; }};
  h.L.Activity = {active: () => activity, push: value => pushes.push(value)};
  assert.equal(h.window.HomelabSources.recover(work, {position: 71, duration: 120}, false), true); h.tick(0);
  assert.equal(pushes[0].homelab_recovery.season, 0); assert.equal(pushes[0].homelab_recovery.episode, 3); assert.equal(pushes[0].homelab_recovery.position, 71);
});

for (const selected of [0, 2]) test(`numeric-string release metadata preserves filtering for season ${selected}`, async t => {
  const h = setup(t); h.selection.season = selected; await h.start();
  h.parser[0].done({Results: [['Zero', ['0']], ['One', ['1']], ['Two', ['2']], ['Empty', ['']], ['Null', [null]], ['Boolean', [false]]]
    .map(([Title, seasons]) => ({Title, Link: 'magnet:' + Title, info: {seasons}}))});
  assert.deepEqual(Array.from(h.search.rows, row => row.release.Title), [selected === 0 ? 'Zero' : 'Two', 'Empty', 'Null', 'Boolean']);
  h.search.cancel();
});

for (const season of [null, '', false]) test(`unknown catalog season ${JSON.stringify(season)} stays a manual choice rather than a Specials candidate`, async t => {
  const h = setup(t); h.selection.season = 0; await h.start();
  h.pages.set('unknown-season', {'.videos__item': [{method: 'call', text: 'Episode', season, episode: 3, voice_name: 'Preferred'}]});
  await h.finish('/lite/events', [h.source('one')]); await h.finish('/lite/one', 'unknown-season');
  assert.equal(h.search.rows.length, 1); assert.equal(h.search.rows[0].native, true);
  h.search.cancel();
});

test('unknown catalog episode identities cannot masquerade as episode one', async t => {
  const h = setup(t); h.selection.season = 0; h.selection.episode = 1; await h.start();
  h.pages.set('unknown-episode', {'.videos__item': [null, '', false, true].map(episode => ({method: 'call', text: 'Episode', season: 0, episode, voice_name: 'Preferred'}))});
  await h.finish('/lite/events', [h.source('one')]); await h.finish('/lite/one', 'unknown-episode');
  assert.equal(h.search.rows.length, 1); assert.equal(h.search.rows[0].native, true); h.search.cancel();
});

test('recovery searches skip the parser entirely', async t => {
  const h = setup(t);
  const search = new h.window.HomelabSources.Search(h.movie, h.selection, () => {}, {torrents: false});
  search.start(); await flush();
  assert.equal(h.parser.length, 0); assert.equal(search.torrentPending, false);
  search.cancel();
});

test('movie call items take their dub from translate/text, never a release tag in voice_name, and keep duplicates apart', async t => {
  const h = setup(t); delete h.movie.name; h.movie.title = 'Film';
  const search = new h.window.HomelabSources.Search(h.movie, {season: 1, episode: 1}, () => {});
  search.start(); await flush();
  h.parser[0].done({Results: []});
  // Fictional, structure-only fixture: many Lampac movie providers put the release tag in voice_name and the dub in translate/text.
  h.pages.set('film', {'.videos__item': [
    {method: 'call', text: 'Studio Alpha', translate: 'Studio Alpha', voice_name: 'WEB-DL', url: '/lite/one/video?i=0', maxquality: '1080p'},
    {method: 'call', text: 'Studio Alpha - cut', translate: 'Studio Alpha - cut', voice_name: 'WEB-DL', url: '/lite/one/video?i=1'},
    {method: 'call', text: 'Licensed Dub', voice_name: '2160p', url: '/lite/one/video?i=2'},
    {method: 'call', text: 'Licensed Dub', voice_name: '2160p', url: '/lite/one/video?i=3'},
    {method: 'play', text: '720p', url: '/media/c'}]});
  await h.finish('/lite/events', [h.source('one')]); await h.finish('/lite/one', 'film');
  assert.deepEqual(Array.from(search.rows, r => r.identityVoice), ['Studio Alpha', 'Studio Alpha - cut', 'Licensed Dub', 'Licensed Dub', 'Film']);
  assert.ok(search.rows.every(r => !/WEB-DL|2160p/.test(r.voice.split(' · ')[0])), 'release tags never become the voice title');
  assert.equal(new Set(search.rows.map(r => r.key)).size, 5, 'identical dubs stay separate rows');
  assert.notEqual(search.rows[2].voice, search.rows[3].voice, 'identical dubs get distinguishable labels');
  assert.deepEqual(Array.from(search.rows[0].qualities), [1080], 'maxquality is used when no quality map exists');
  assert.deepEqual(JSON.parse(JSON.stringify(search.rows[3].match)), {index: 3, count: 5, url: '/lite/one/video?i=3', text: 'Licensed Dub', translate: '', voice_name: '2160p'});
  assert.equal(search.rows[4].match.text, 'Film', 'match text mirrors native movie-title substitution');
  search.cancel();
});

test('the picker works without a native AbortController and still times out hung requests', async t => {
  const h = setup(t, {noAbort: true}); await h.start();
  assert.ok(h.window.HomelabSources.Search, 'installed');
  h.tick(8100); await flush();
  assert.equal(h.search.onlinePending, false, 'a hung events request is abandoned after its timeout');
  assert.ok(h.search.errors.length);
  h.search.cancel();
});

test('live discovery keeps its full window when externalids and events are slow', async t => {
  const h = setup(t); delete h.movie.kinopoisk_id;
  const search = new h.window.HomelabSources.Search(h.movie, h.selection, () => {});
  search.start(); await flush();
  h.tick(4000); await flush(); // externalids times out
  h.tick(7200); await flush();
  await h.finish('/lite/events', {life: true, memkey: 'fixture'});
  await h.finish('/lifeevents', {ready: false, online: []});
  await h.finish('/lifeevents', {ready: false, online: []});
  await h.finish('/lifeevents', {ready: false, online: []});
  assert.ok(Date.now() > 15000, 'the old construction-time window has elapsed');
  assert.equal(search.onlinePending, true, 'polling continues for 15 s after it started');
  await h.finish('/lifeevents', {ready: true, online: [h.source('one')]});
  assert.ok(h.requests.some(r => r.url.pathname === '/lite/one'));
  search.cancel();
});

test('voice pages are fetched once per provider, season and voice, after first pages of other providers', async t => {
  const h = setup(t); await h.start();
  await h.finish('/lite/events', [h.source('one'), h.source('two')]);
  const buttons = active => ['A', 'B', 'C'].map(v => ({text: 'Studio ' + v, active: v === active, url: '/lite/one?s=2&t=' + v}));
  const episodes = voice => [{method: 'call', text: '3 серия', season: 2, episode: 3, url: '/lite/one/video?t=' + voice}];
  h.pages.set('seasons', {'.videos__item': [{method: 'link', text: '1 сезон', url: '/lite/one?s=1'}, {method: 'link', text: '2 сезон', url: '/lite/one?s=2'}]});
  h.pages.set('season-a', {'.videos__item': episodes('A'), '.videos__button': buttons('A')});
  h.pages.set('voice-b', {'.videos__item': episodes('B'), '.videos__button': buttons('B')});
  h.pages.set('voice-c', {'.videos__item': episodes('C'), '.videos__button': buttons('C')});
  await h.finish('/lite/one', 'seasons');
  await h.finish('/lite/one', 'season-a');
  // provider two's first page has priority over provider one's voice pages
  const pending = h.requests.filter(r => !r.completed && !r.options.signal.aborted).map(r => r.url.pathname + r.url.search);
  assert.ok(pending.some(p => p.startsWith('/lite/two')), pending.join());
  await h.finish('/lite/two', {rch: true});
  await h.finish('/lite/one', 'voice-b');
  await h.finish('/lite/one', 'voice-c');
  h.tick(5000); await flush();
  const voices = h.requests.filter(r => r.url.pathname === '/lite/one' && r.url.searchParams.has('t')).map(r => r.url.searchParams.get('t'));
  assert.deepEqual(voices.sort(), ['B', 'C'], 'the already visited active voice is never re-fetched');
  assert.deepEqual(Array.from(h.search.rows.filter(r => !r.native), r => r.voice), ['Studio A', 'Studio B', 'Studio C']);
  assert.equal(h.search.onlinePending, false);
  h.search.cancel();
});

test('cancelling an unfinished search marks it interrupted', async t => {
  const h = setup(t); await h.start();
  h.search.cancel(); assert.equal(h.search.interrupted, true);
  const done = new h.window.HomelabSources.Search(h.movie, h.selection, () => {}, {torrents: false});
  done.cancel(); assert.equal(done.interrupted, false, 'a search that never started is not interrupted');
});

test('devices without fetch get a visible notice instead of a missing button', t => {
  const follows = {}, notices = [], buttons = [];
  const node = () => ({on(name, fn) { this.handler = fn; return this; }, find: () => ({length: 0}), prepend(b) { buttons.push(b); }});
  const L = {Listener: {follow: (name, fn) => { follows[name] = fn; }}, Noty: {show: text => notices.push(text)}, Activity: {active: () => null}};
  const $ = () => { const n = node(); n.length = 1; return n; };
  const window = {appready: true, Lampa: L, $, HomelabSync: {scope: () => 'a'}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugins/common-sources.js'), 'utf8'), {window, Lampa: L, document: {}, console});
  assert.ok(follows.full, 'the full card still receives a button');
  const render = {find: selector => selector === '.buttons--container' ? Object.assign(node(), {length: 1}) : {length: 0}};
  follows.full({type: 'complite', data: {movie: {id: 1}}, object: {activity: {render: () => render}}});
  assert.equal(buttons.length, 1); buttons[0].handler();
  assert.match(notices[0], /недоступен/);
});

test('movie recovery uses the dub from the saved match instead of a release-tag voice_name', t => {
  const h = setup(t), movie = {id: 7, title: 'Film', original_title: 'Film'}, pushes = [];
  h.L.Player = {opened: () => false}; h.L.Activity.push = value => pushes.push(value);
  const online = {provider: 'one', voice: 'WEB-DL', text: 'MVO Studio', match: {index: 1, count: 2, text: 'MVO Studio', translate: 'MVO Studio', voice_name: 'WEB-DL'}};
  assert.equal(h.window.HomelabSources.resume({card: 'movie_7', episode: 1, position: 40, online}, movie), true);
  assert.equal(pushes[0].homelab_recovery.voice, 'MVO Studio');
  assert.equal(h.window.HomelabSources.resume({card: 'movie_7', position: 40, online: {provider: 'one', voice: 'WEB-DL', match: {text: 'Film'}}}, movie), true);
  assert.equal(pushes[1].homelab_recovery.voice, '', 'a tag or the film title never filters the picker');
  const activity = {}, work = {card: movie, homelab_online: online}; let opened = true; pushes.length = 0;
  h.L.Player = {playdata: () => work, opened: () => opened, close() { opened = false; }};
  h.L.Activity = {active: () => activity, push: value => pushes.push(value)};
  assert.equal(h.window.HomelabSources.recover(work, {position: 71, duration: 120}, false), true); h.tick(0);
  assert.equal(pushes[0].homelab_recovery.voice, 'MVO Studio');
});

test('rows without quality learn the real height from the source once the catalog is done', async t => {
  const h = setup(t); await h.start();
  await h.finish('/lite/events', [h.source('one')]);
  h.pages.set('films', {'.videos__item': [
    {method: 'call', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio A', url: '/lite/one/video?f=a'},
    {method: 'call', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio B', url: '/lite/one/video?f=b'},
    {method: 'play', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio C', url: '/proxy/c.m3u8'},
    {method: 'play', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio D', url: '/proxy/d.mp4'},
    {method: 'call', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio E', url: '/lite/one/video?f=e', quality: {'720p': '/x'}}]});
  await h.finish('/lite/one', 'films');
  const row = voice => h.search.rows.find(r => r.voice === voice);
  // Quality map from the call answer.
  await h.finish('/lite/one/video', {method: 'play', url: '/proxy/a.m3u8', quality: {'1080p': '/proxy/a1', '480p': '/proxy/a2'}});
  assert.deepEqual(Array.from(row('Studio A').qualities), [1080, 480]);
  // A 404 from the source marks the row and sorts it last.
  await h.finish('/lite/one/video', {__status: 404});
  assert.equal(row('Studio B').unavailable, true);
  // HLS master: a cinema crop still counts as 1080p.
  await h.finish('/proxy/c.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x534\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x800\nhigh.m3u8\n');
  assert.deepEqual(Array.from(row('Studio C').qualities), [1080]);
  // A direct file is never downloaded and stays unknown.
  await h.finish('/proxy/d.mp4', {__type: 'video/mp4'});
  assert.deepEqual(Array.from(row('Studio D').qualities), []); assert.ok(!row('Studio D').unavailable);
  // Rows that already know their quality are never probed.
  assert.ok(!h.requests.some(r => r.url.searchParams.get('f') === 'e'));
  const order = h.search.rows.slice().sort((a, b) => h.window.HomelabSources.compareRows(a, b, {}));
  assert.equal(order[order.length - 1].voice, 'Studio B');
  h.search.cancel();
});
