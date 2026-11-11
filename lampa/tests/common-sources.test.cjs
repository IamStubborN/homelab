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
  const window = {appready: true, location: {href: 'https://lampac.test/'}, Lampa: L, $: dollar, fetch: request, AbortController: options.noAbort ? undefined : AbortController,
    HomelabSync: {scope: () => scope, url: pathname => 'https://lampac.test' + pathname + '?token=private-fixture&profile_id=' + scope}};
  function request(url, options) {
    return new Promise((resolve, reject) => {
      active++; peak = Math.max(peak, active); let settled = false;
      const job = {url: new URL(url), options, started: Date.now(), finish(body) {
        if (settled) return; settled = true; active--; const status = body && body.__status || 200, text = typeof body === 'string' ? body : JSON.stringify(body);
        // Realistic headers: JSON for objects, an HLS type for playlists; __type/__length override them (null = absent).
        const type = body && body.__type !== undefined ? body.__type : typeof body === 'string' ? /^#EXTM3U/.test(body) ? 'application/vnd.apple.mpegurl' : 'text/html' : 'application/json; charset=utf-8';
        const length = body && body.__length !== undefined ? body.__length : String(text.length);
        job.read = false;
        resolve({ok: status < 400, status, headers: {get: name => name.toLowerCase() === 'content-type' ? type : name.toLowerCase() === 'content-length' ? length : null}, text: async () => { job.read = true; return text; }}); }};
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
  assert.equal(h.requests.filter(r => r.url.pathname.startsWith('/lite/') && !r.completed).length, 3, 'all three providers are asked at once');
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
  assert.equal(h.search.onlinePending, false); assert.equal(h.peak(), 3, 'providers are asked in parallel, up to five at once');
  assert.ok(h.requests.every(r => !r.url.pathname.includes('media')));
  assert.ok(!h.requests.some(r => r.url.searchParams.get('s') === '1'));
  assert.equal(h.requests.filter(r => r.url.searchParams.get('voice') === 'alternate').length, 1, 'voice links are visited once');
  const own = h.requests.filter(r => r.url.pathname.startsWith('/lite/one'));
  assert.ok(own.slice(1).every((r, i) => r.started - own[i].started >= 350), 'pages of one provider are paced; providers do not wait for each other');
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


test('release labels prefer voice metadata, fall back to the voices listed in the release title and retain codec', t => {
  const h = setup(t), describe = h.window.HomelabSources.describeRelease;
  const unknown = describe({Title: 'Series S02 WEB-DL 1080p HEVC Huge Studio Name', info: {voices: [], videotype: 'sdr'}});
  assert.equal(unknown.title, 'Озвучка не указана'); assert.equal(unknown.codec, 'HEVC');
  assert.deepEqual(Array.from(describe({Title: 'Series S02 1080p | D, P | LostFilm, Кубик в Кубе'}).voices), ['Дубляж', 'Многоголосый', 'LostFilm', 'Кубик в Кубе']);
  assert.equal(describe({Title: 'Release', info: {voices: ['Preferred', 'Other', 'Third']}}).title, 'Preferred / Other +1');
  const probe = describe({ffprobe: [{codec_type: 'video', codec_name: 'h264'}, {codec_type: 'audio', tags: {title: 'Preferred'}}, {codec_type: 'audio', tags: {handler_name: 'Audio Handler'}}]});
  assert.equal(probe.title, 'Preferred'); assert.equal(probe.codec, 'AVC');
});

test('quality is profile scoped and validated; rows rank online, seeded torrents by quality, then native', t => {
  const h = setup(t), api = h.window.HomelabSources;
  api.preferences({quality: 1080});
  assert.equal(api.preferences().quality, 1080); assert.equal(api.preferences().voice, undefined, 'there is no favourite voice');
  const row = (key, voice, extra = {}) => ({key, kind: 'online', identityVoice: voice, providerName: key, qualities: [1080], ...extra});
  const rows = [row('z', 'Other'), row('b', 'Preferred'), row('a', 'preferred'), row('t1', '', {kind: 'torrent', release: {Seeders: 300}, qualities: [720]}),
    row('t2', '', {kind: 'torrent', release: {Seeders: 4}, qualities: [2160]}), row('t3', '', {kind: 'torrent', release: {Seeders: 1}, qualities: [2160]}), row('n', 'Preferred', {native: true})];
  rows.sort((a, b) => api.compareRows(a, b));
  assert.deepEqual(rows.map(r => r.key), ['a', 'b', 'z', 't2', 't1', 't3', 'n'], 'quality beats seeds once a release is seeded; dead releases sink');
  api.preferences({quality: 999}); assert.equal(api.preferences().quality, 1080);
  h.profile('b'); assert.equal(api.preferences().quality, 0);
  h.profile('profile-a'); assert.equal(api.preferences().quality, 1080);
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
  assert.deepEqual(Array.from(search.rows, r => r.identityVoice), ['Studio Alpha', 'Studio Alpha - cut', 'Licensed Dub', 'Licensed Dub', 'Без названия']);
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
    {method: 'call', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio E', url: '/lite/one/video?f=e', maxquality: '2160p'}]});
  await h.finish('/lite/one', 'films');
  h.search.probe(h.search.rows);
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
  // A claimed quality is checked too: the stream manifest of the top quality decides.
  assert.equal(row('Studio E').claimed, 2160);
  await h.finish('/lite/one/video', {method: 'play', url: '/proxy/e.m3u8', quality: {'2160p': '/proxy/e.m3u8', '720p': '/proxy/e7'}});
  await h.finish('/proxy/e.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\ne.m3u8\n');
  assert.deepEqual(Array.from(row('Studio E').qualities), [720]); assert.equal(row('Studio E').measured, true);
  const order = h.search.rows.slice().sort((a, b) => h.window.HomelabSources.compareRows(a, b));
  assert.equal(order[order.length - 1].voice, 'Studio B');
  h.search.cancel();
});

async function probeFixture(h, items) {
  await h.start();
  await h.finish('/lite/events', [h.source('one')]);
  h.pages.set('probe', {'.videos__item': items.map(([voice, url]) => ({method: 'call', text: '3 серия', season: 2, episode: 3, voice_name: voice, url}))});
  await h.finish('/lite/one', 'probe');
  h.search.probe(h.search.rows);
  return voice => h.search.rows.find(r => r.voice === voice);
}

test('rch/ws handshakes, auth and quota answers keep a row available; only "not found" marks it unavailable', async t => {
  const h = setup(t), row = await probeFixture(h, [['Studio A', '/lite/one/video?f=a'], ['Studio B', '/lite/one/video?f=b'], ['Studio C', '/lite/one/video?f=c'], ['Studio D', '/lite/one/video?f=d'], ['Studio E', '/lite/one/video?f=e']]);
  await h.finish('/lite/one/video', {rch: true, ws: 'wss://lampac.test/ws', nws: true});
  assert.ok(!row('Studio A').unavailable, 'an rch handshake is not a missing video');
  await h.finish('/lite/one/video', {error: 'Daily limit reached'});
  await h.finish('/lite/one/video', {accsdb: true, error: 'not found'});
  await h.finish('/lite/one/video', {__status: 403});
  assert.ok(['Studio B', 'Studio C', 'Studio D'].every(voice => !row(voice).unavailable), 'quota, account and 403 answers can be transient');
  await h.finish('/lite/one/video', {error: 'File not found'});
  assert.equal(row('Studio E').unavailable, true);
  h.search.cancel();
});

test('only measured qualities and own 404/410 are cached, for 30 minutes', async t => {
  const h = setup(t), row = await probeFixture(h, [['Studio A', '/lite/one/video?f=a'], ['Studio B', '/lite/one/video?f=b'], ['Studio C', '/lite/one/video?f=c']]);
  await h.finish('/lite/one/video', {__status: 410});
  await h.finish('/lite/one/video', {__status: 401});
  await h.finish('/lite/one/video', {error: 'File not found'});
  assert.equal(row('Studio A').unavailable, true); h.search.cancel();
  const reopen = async () => {
    const search = new h.window.HomelabSources.Search(h.movie, h.selection, () => {});
    search.start(); await flush(); await h.finish('/lite/events', [h.source('one')]); await h.finish('/lite/one', 'probe');
    const before = h.requests.length; search.probe(search.rows); h.tick(5000); await flush();
    const probed = h.requests.slice(before).map(r => r.url.searchParams.get('f')).sort(); search.cancel();
    return {search, probed};
  };
  let again = await reopen();
  assert.equal(again.search.rows.find(r => r.voice === 'Studio A').unavailable, true, 'own 410 comes from the cache');
  assert.deepEqual(again.probed, ['b', 'c'], 'auth failures and error texts are asked again');
  h.tick(31 * 60000);
  again = await reopen();
  assert.ok(again.probed.includes('a'), 'the cache expires after 30 minutes');
});

test('a search probes at most 12 leaders; alternates are probed only on request, within 24 in total', async t => {
  const h = setup(t), voices = Array.from({length: 30}, (_, i) => ['Studio ' + i, '/lite/one/video?f=' + i]);
  await probeFixture(h, []);
  h.search.cancel();
  const search = new h.window.HomelabSources.Search(h.movie, h.selection, () => {});
  search.start(); await flush(); await h.finish('/lite/events', [h.source('one')]);
  h.pages.set('many', {'.videos__item': voices.map(([voice, url]) => ({method: 'call', text: '3 серия', season: 2, episode: 3, voice_name: voice, url}))});
  await h.finish('/lite/one', 'many');
  assert.equal(search.checking(), 0, 'nothing is probed until the UI asks');
  search.probe(search.rows); search.probe(search.rows);
  assert.equal(search.checking(), 12);
  search.probe(search.rows, true);
  assert.equal(search.checking(), 24);
  search.cancel();
});

test('a foreign CDN refusal never marks a row unavailable, an own /proxy/ refusal does', async t => {
  const h = setup(t), row = await probeFixture(h, [['Studio A', 'https://cdn.test/a.m3u8'], ['Studio B', '/proxy/b.m3u8']]);
  await h.finish('/a.m3u8', {__status: 403});
  assert.ok(!row('Studio A').unavailable);
  const foreign = h.requests.find(r => r.url.origin === 'https://cdn.test');
  assert.equal(foreign.options.credentials, 'omit'); assert.ok(!foreign.url.searchParams.has('token'), 'identity stays on Lampac');
  await h.finish('/proxy/b.m3u8', {__status: 404});
  assert.equal(row('Studio B').unavailable, true);
  h.search.cancel();
});

test('without a native AbortController nothing is probed', async t => {
  const h = setup(t, {noAbort: true}), row = await probeFixture(h, [['Studio A', '/lite/one/video?f=a']]);
  h.tick(5000); await flush();
  assert.ok(!h.requests.some(r => r.url.pathname === '/lite/one/video'));
  assert.deepEqual(Array.from(row('Studio A').qualities), []); assert.equal(h.search.checking(), 0);
  h.search.cancel();
});

test('bodies without an allowed content type or above the size cap are never read', async t => {
  const h = setup(t), row = await probeFixture(h, [['Studio A', '/lite/one/video?f=a'], ['Studio B', '/lite/one/video?f=b'], ['Studio C', '/lite/one/video?f=c']]);
  const job = () => h.requests.find(r => r.url.pathname === '/lite/one/video' && !r.completed);
  let pending = job(); await h.finish('/lite/one/video', {__type: null, quality: {'1080p': '/x'}});
  assert.equal(pending.read, false, 'no content type: the body may be media'); assert.deepEqual(Array.from(row('Studio A').qualities), []);
  pending = job(); await h.finish('/lite/one/video', {__length: '9000000', quality: {'1080p': '/x'}});
  assert.equal(pending.read, false, 'oversized answer');
  pending = job(); await h.finish('/lite/one/video', {__type: 'text/plain', __length: null, quality: {'1080p': '/x'}});
  assert.equal(pending.read, false, 'plain text of unknown size');
  assert.ok(['Studio A', 'Studio B', 'Studio C'].every(voice => !row(voice).unavailable && !row(voice).qualities.length));
  h.search.cancel();
});

test('probes start once their provider has no catalog pages left and share its pacing', async t => {
  const h = setup(t); await h.start();
  await h.finish('/lite/events', {life: true, memkey: 'fixture'});
  h.pages.set('probe', {'.videos__item': [{method: 'call', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio A', url: '/lite/one/video?f=a'}]});
  await h.finish('/lifeevents', {ready: false, online: [h.source('one')]});
  await h.finish('/lite/one', 'probe');
  assert.deepEqual({...h.search.providers}, {total: 1, done: 1});
  h.search.probe(h.search.rows); h.tick(400); await flush();
  const probe = h.requests.find(r => r.url.pathname === '/lite/one/video'); assert.ok(probe);
  const previous = h.requests[h.requests.indexOf(probe) - 1];
  assert.ok(probe.started - previous.started >= 350, 'own probes are paced like catalog pages');
  await h.finish('/lifeevents', {ready: true, online: [h.source('one')]});
  h.search.cancel();
});

test('measured results are cached for the session, so a reopened picker does not probe again', async t => {
  const h = setup(t), row = await probeFixture(h, [['Studio A', '/lite/one/video?f=a']]);
  await h.finish('/lite/one/video', {quality: {'1080p': '/x'}});
  assert.equal(row('Studio A').measured, true); h.search.cancel();
  const again = new h.window.HomelabSources.Search(h.movie, h.selection, () => {});
  again.start(); await flush();
  await h.finish('/lite/events', [h.source('one')]); await h.finish('/lite/one', 'probe');
  h.tick(5000); await flush();
  assert.equal(h.requests.filter(r => r.url.pathname === '/lite/one/video').length, 1, 'no second probe');
  const cached = again.rows.find(r => r.voice === 'Studio A');
  assert.deepEqual(Array.from(cached.qualities), [1080]); assert.equal(cached.measured, true);
  again.cancel();
});

test('a probe whose address cannot be built still releases its slot', async t => {
  const h = setup(t), row = await probeFixture(h, [['Studio A', '/lite/one/video?f=a']]);
  // probeFixture ran the catalog; the probe was queued and is fetching. Rebuild with a failing identity.
  h.search.cancel();
  const search = new h.window.HomelabSources.Search(h.movie, h.selection, () => {});
  search.start(); await flush(); await h.finish('/lite/events', [h.source('one')]);
  const url = h.window.HomelabSync.url; let broken = false; h.window.HomelabSync.url = path => broken ? '' : url(path);
  h.pages.set('probe2', {'.videos__item': [{method: 'call', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio Z', url: '/lite/one/video?f=z'}]});
  const job = h.requests.find(r => r.url.pathname === '/lite/one' && !r.completed); job.completed = true; job.finish('probe2');
  await flush(); broken = true; search.probe(search.rows); h.tick(1000); await flush();
  assert.equal(search.checking(), 0, 'the failed probe left the queue'); assert.ok(row('Studio A'));
  assert.ok(search.rows.some(r => r.voice === 'Studio Z') && !search.rows.some(r => r.native), 'a synchronous failure never escapes into the catalog handler');
  search.cancel();
});

test('rows group by voice with the best playable source first; torrents and native fallbacks stay single', t => {
  const group = setup(t).window.HomelabSources.groupRows, row = (key, voice, qualities, extra = {}) => ({key, kind: 'online', provider: key, providerName: key, identityVoice: voice, voice, qualities, ...extra});
  const groups = group([row('a', 'Dub', [2160], {unavailable: true}), row('b', 'Dub', [1080]), row('c', 'dub', [1080], {measured: true}), row('d', 'Other', []),
    row('t', 'Dub', [1080], {kind: 'torrent'}), row('n', 'Dub', [], {native: true})]);
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(g => g.rows.map(r => r.key)))), [['c', 'b', 'a'], ['d'], ['t'], ['n']]);
  assert.equal(groups[0].best.key, 'c', 'measured beats declared at the same height; unavailable is last');
});

test('voice names from different providers fold into one canonical voice', t => {
  const canon = setup(t).window.HomelabSources.canonVoice;
  const key = value => canon(value).key;
  assert.equal(key('HDrezka Studio'), key('Rezka')); assert.equal(key('LostFilm'), key('Lost Film'));
  assert.equal(canon('LostFilm').label, 'LostFilm');
  assert.notEqual(key('LostFilm'), key('LostFilm (UKR)'), 'another language stays apart');
  assert.equal(canon('Многоголосый закадровый').label.indexOf('Многоголосый'), 0);
  assert.equal(canon('Субтитры').subs, true);
});

test('spellings of one studio across scripts fold together; short codes and other studios stay apart', t => {
  const canon = setup(t).window.HomelabSources.canonVoice, key = value => canon(value).key;
  const anilibria = key('AniLibria');
  for (const name of ['AniLibria.TV', 'Anilibria', 'АниЛибриа', 'Анилибрия', 'AniLiberty', 'Анилиберти']) assert.equal(key(name), anilibria, name);
  assert.equal(canon('АниЛибриа').label, 'AniLibria');
  assert.equal(key('ЛостФильм'), key('LostFilm')); assert.equal(key('АлексФильм'), key('AlexFilm')); assert.equal(key('Ультрадокс'), key('Ultradox'));
  assert.equal(key('Колдфильм'), key('ColdFilm'));
  assert.notEqual(key('AniDub'), anilibria); assert.notEqual(key('LostFilm'), key('AlexFilm'));
  assert.notEqual(key('ЭсДиАй'), key('SDI Media'), 'a skeleton shorter than four letters never matches');
  assert.notEqual(key('ЛостФильм (UKR)'), key('LostFilm'), 'another language still stays apart');
});

test('a finished search is reused for ten minutes unless refreshed', async t => {
  const h = setup(t); await h.start();
  h.parser[0].done({Results: []});
  h.pages.set('one', {'.videos__item': [{method: 'play', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio A', url: '/media', quality: {'1080p': '/media'}}]});
  await h.finish('/lite/events', [h.source('one')]); await h.finish('/lite/one', 'one');
  assert.equal(h.search.onlinePending, false); h.search.cancel();
  const count = h.requests.length, Search = h.window.HomelabSources.Search;
  const again = new Search(h.movie, h.selection, () => {}); again.start(); await flush();
  assert.equal(h.requests.length, count, 'no request while the cache is fresh');
  assert.ok(again.cachedAt); assert.deepEqual(Array.from(again.rows, r => r.voice), ['Studio A']); again.cancel();
  const fresh = new Search(h.movie, h.selection, () => {}, {fresh: true}); fresh.start(); await flush();
  assert.ok(h.requests.length > count, 'Refresh asks the providers again'); assert.ok(!fresh.cachedAt); fresh.cancel();
  h.tick(11 * 60000);
  const late = new Search(h.movie, h.selection, () => {}); late.start(); await flush();
  assert.ok(!late.cachedAt, 'the cache expires'); late.cancel();
});

test('labels without a studio or a type never merge, and fillers do not hide a studio', t => {
  const canon = setup(t).window.HomelabSources.canonVoice;
  assert.equal(canon('Русский').key, ''); assert.equal(canon('Озвучка').key, '');
  assert.equal(canon('Red Head Sound (Украинский)').key, canon('RHS (UKR)').key);
  assert.equal(canon('Многоголосый закадровый').key, canon('Многоголосый').key);
  assert.notEqual(canon('Субтитры').key, canon('Оригинал').key);
});

test('a search with errors is not cached', async t => {
  const h = setup(t); await h.start();
  h.parser[0].fail();
  h.pages.set('one', {'.videos__item': [{method: 'play', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio A', url: '/media', quality: {'1080p': '/media'}}]});
  await h.finish('/lite/events', [h.source('one')]); await h.finish('/lite/one', 'one');
  assert.equal(h.search.onlinePending, false); assert.ok(h.search.errors.length); h.search.cancel();
  const again = new h.window.HomelabSources.Search(h.movie, h.selection, () => {}); again.start(); await flush();
  assert.ok(!again.cachedAt, 'a failed torrent search is asked again'); again.cancel();
});

test('a seeded torrent without a named voice learns it from its audio tracks once, on request', async t => {
  const h = setup(t); await h.start();
  const hash = 'b'.repeat(40);
  h.parser[0].done({Results: [{Title: 'Series S02 1080p', MagnetUri: 'magnet:?xt=urn:btih:' + hash, Tracker: 'Tracker', Seeders: 9},
    {Title: 'Series S02 720p', MagnetUri: 'magnet:?xt=urn:btih:' + 'c'.repeat(40), Seeders: 1}]});
  const [row, weak] = h.search.rows;
  assert.equal(row.voice, 'Озвучка не указана');
  assert.equal(h.search.voices(weak), false, 'releases with too few seeds are not probed');
  assert.equal(h.search.voices(row), true);
  assert.equal(row.voiceProbe, 'pending');
  assert.equal(h.search.voices(row), false, 'one lookup at a time');
  const job = h.requests.find(r => r.url.pathname === '/extaudio/voices');
  assert.equal(job.url.searchParams.get('link'), 'magnet:?xt=urn:btih:' + hash);
  assert.equal(job.url.searchParams.get('token'), null, 'no Lampac identity goes to the sidecar');
  assert.equal(job.options.headers['X-Homelab-Voices'], '1');
  job.finish({voices: ['Studio Fictional', 'Studio Other'], languages: ['rus', 'rus', 'eng']}); await flush(); await flush();
  assert.equal(row.voice, 'Studio Fictional / Studio Other');
  assert.equal(row.described.languages, 'RU×2 · EN');
  h.search.cancel();
  const again = new h.window.HomelabSources.Search(h.movie, h.selection, () => {}, {fresh: true}); again.start(); await flush();
  h.parser.at(-1).done({Results: [{Title: 'Series S02 1080p', MagnetUri: 'magnet:?xt=urn:btih:' + hash, Seeders: 9}]});
  assert.equal(again.rows[0].voice, 'Studio Fictional / Studio Other', 'a later search reuses the answer');
  assert.equal(h.requests.filter(r => r.url.pathname === '/extaudio/voices').length, 1);
  again.cancel();
});

test('a release still looking for peers is asked again on a later focus', async t => {
  const h = setup(t); await h.start();
  h.parser[0].done({Results: [{Title: 'Series S02 1080p', MagnetUri: 'magnet:?xt=urn:btih:' + 'd'.repeat(40), Seeders: 9}]});
  const row = h.search.rows[0];
  h.search.voices(row);
  h.requests.find(r => r.url.pathname === '/extaudio/voices').finish({__status: 503, error: 'preparing'}); await flush(); await flush();
  assert.equal(row.voiceProbe, '');
  h.tick(15000); await flush();
  assert.equal(h.requests.filter(r => r.url.pathname === '/extaudio/voices').length, 2, 'asked again by itself after 15 s');
  assert.equal(row.voiceProbe, 'pending');
  h.search.cancel();
});

function qualityLog(h, data, reports) {
  h.window.HomelabQuality = {load: () => Promise.resolve(data), report: (...args) => reports.push(args),
    fact: (value, provider, season, voice) => value.rows[[provider.toLowerCase(), season, voice.trim().toLowerCase()].join('|')] || null,
    doubtful: (value, provider) => { const stats = value.providers[provider]; return !!stats && stats.total >= 3 && stats.inflated * 3 >= stats.total; }};
  return new h.window.HomelabSources.Search(h.movie, h.selection, () => {});
}

test('the household quality log replaces claims it has measured and doubts providers that inflate', async t => {
  const h = setup(t), reports = [];
  const search = qualityLog(h, {version: 1, rows: {'three|2|studio c': {height: 720, claimed: 2160, source: 'play'}}, providers: {one: {total: 3, inflated: 2}}}, reports);
  search.start(); await flush();
  await h.finish('/lite/events', [h.source('one'), h.source('two'), h.source('three')]);
  const page = (voice, quality, f) => ({'.videos__item': [{method: 'call', text: '3 серия', season: 2, episode: 3, voice_name: voice, url: '/lite/x/video?f=' + f, maxquality: quality}]});
  h.pages.set('a', page('Studio A', '2160p', 'a')); h.pages.set('b', page('Studio B', '1080p', 'b')); h.pages.set('c', page('Studio C', '2160p', 'c'));
  await h.finish('/lite/one', 'a'); await h.finish('/lite/two', 'b'); await h.finish('/lite/three', 'c');
  const row = voice => search.rows.find(r => r.voice === voice);
  assert.equal(row('Studio A').doubtful, true, 'an unchecked 4K of a provider that inflates');
  assert.deepEqual(Array.from(row('Studio C').qualities), [720]); assert.equal(row('Studio C').verified, 'play');
  const order = search.rows.slice().sort((a, b) => h.window.HomelabSources.compareRows(a, b)).map(r => r.voice);
  assert.deepEqual(Array.from(order), ['Studio B', 'Studio C', 'Studio A']);
  // Its probe checks the claim against the top quality's manifest and logs the result.
  search.probe([row('Studio A')]);
  await h.finish('/lite/x/video', {method: 'play', url: '/proxy/a.m3u8', quality: {'2160p': '/proxy/a.m3u8'}});
  await h.finish('/proxy/a.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\na.m3u8\n');
  assert.deepEqual(Array.from(row('Studio A').qualities), [720]); assert.equal(row('Studio A').doubtful, false);
  assert.deepEqual(reports.map(args => Array.from(args).slice(1)), [['one', 2, 'Studio A', 2160, 720, 'probe']]);
  search.cancel();
});

test('a claimed quality whose manifest cannot be read stays a claim and is not logged', async t => {
  const h = setup(t), reports = [];
  const search = qualityLog(h, {version: 1, rows: {}, providers: {}}, reports);
  search.start(); await flush();
  await h.finish('/lite/events', [h.source('one')]);
  h.pages.set('a', {'.videos__item': [{method: 'call', text: '3 серия', season: 2, episode: 3, voice_name: 'Studio A', url: '/lite/x/video?f=a', maxquality: '2160p'}]});
  await h.finish('/lite/one', 'a');
  const row = search.rows.find(r => r.voice === 'Studio A');
  search.probe([row]);
  // The resolver points at the 720p stream: its manifest says nothing about the 4K entry.
  await h.finish('/lite/x/video', {method: 'play', url: '/proxy/a720.m3u8', quality: {'2160p': '/proxy/a4k.m3u8', '720p': '/proxy/a720.m3u8'}});
  assert.ok(!row.measured); assert.deepEqual(reports, []);
  search.cancel();
});

test('releases name their subtitles from ffprobe streams or the title', t => {
  const h = setup(t), describe = h.window.HomelabSources.describeRelease;
  const probed = describe({Title: 'Show', ffprobe: [{codec_type: 'subtitle', tags: {language: 'rus'}}, {codec_type: 'subtitle', tags: {language: 'eng'}}, {codec_type: 'subtitle', tags: {language: 'rus', title: 'Надписи'}}]});
  assert.equal(probed.subtitles.langs, 'RU · EN');
  assert.equal(describe({Title: 'Show S01 1080p | Sub'}).subtitles.langs, '');
  assert.equal(describe({Title: 'Show S01 1080p | Субтитры'}).subtitles.langs, '');
  assert.equal(describe({Title: 'Show S01 1080p | Subaru Studio'}).subtitles, null, 'a word that starts with sub is no subtitle');
  assert.equal(describe({Title: 'Show S01 1080p'}).subtitles, null);
});

test('one subtitle label may name several languages', t => {
  const h = setup(t), describe = h.window.HomelabSources.describeRelease;
  assert.equal(describe({Title: 'Show', ffprobe: [{codec_type: 'subtitle', tags: {title: 'Russian, English'}}]}).subtitles.langs, 'RU · EN');
});
