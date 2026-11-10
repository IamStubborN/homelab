const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');

function setup(t, options = {}) {
  const h = harness(t), registry = {}, choices = {}, starts = [];
  let active = null, requests = [], draws = [];
  function Native(object) {
    this.getChoice = provider => choices[provider] || {};
    this.replaceChoice = (data, provider) => { choices[provider] = {...choices[provider], ...data}; };
    this.startSource = function () { assert.equal(this, component); h.L.Storage.set('active_balanser', 'kinobase'); return Promise.resolve(); };
    this.toPlayElement = file => ({url: file.url, title: file.title, timeline: {hash: '123', percent: 42, time: 50}, season: file.season, episode: file.episode});
    this.getFileUrl = (file, done) => { requests.push(() => done({url: 'fresh-url'})); };
    this.setDefaultQuality = work => { if (work.quality) work.url = work.quality['2160p']; };
    // Lampac display(): with voice filter buttons the choice names the active
    // (default first) button and every row takes that name.
    this.draw = (items, params) => { draws.push(() => items.forEach(file => {
      if (options.buttons) {
        const choice = choices.kinobase || {}, name = options.buttons.includes(choice.voice_name) ? choice.voice_name : options.buttons[0];
        choices.kinobase = {...choice, voice_name: name}; file.voice_name = name;
      } file.timeline = {hash: '123'}; file.mark = () => {}; params.onRender?.(file, options.html?.(file) || {}, {}); })); };
    this.destroy = () => {};
    const root = h.window.$('<div></div>');
    this.render = () => root;
    this.noConnectToServer = function () { root.find('.online-empty__time').text('Поиск на (undefined) не дал результатов'); };
  }
  registry.lampac = Native;
  h.L.Component = {get: name => registry[name], add: (name, ctor) => { registry[name] = ctor; }};
  h.L.Activity = {active: () => active, push(object) { active = object; component = new registry[object.component](object); }};
  let component;
  h.run('mods/HomelabSync/online.js');
  const item = {card: 'tv_42', season: 2, episode: 3, position: 71, online: {provider: 'kinobase', voice: 'Preferred', season_index: 1}};
  const movie = {id: 42, name: 'Series', source: 'tmdb', original_title: "Original's series", number_of_seasons: 2};
  return {...h, item, movie, choices, starts, registry,
    async open(value = item) { assert.equal(h.window.HomelabOnlineResume.resume(value, movie, () => starts.push('timeout')), true); await component.startSource(); return component; },
    component: () => component, render() { draws.shift()(); }, resolve() { requests.shift()(); },
    draw(items) { component.draw(items, {onEnter(file) { starts.push(file); component.getFileUrl(file, () => { h.L.Player.play(component.toPlayElement(file)); }); }}); },
    active: value => { active = value; },
  };
}
const file = (episode = 3, voice = 'Preferred') => ({season: 2, episode, voice_name: voice, title: 'Episode', url: 'ephemeral-url'});

test('native online receives the TV display title instead of an Explorer placeholder without mutating the caller', async t => {
  const h = setup(t);
  h.movie.title = 'Фильм не найден';
  await h.open();
  assert.equal(h.L.Activity.active().movie.title, 'Series');
  assert.equal(h.L.Activity.active().movie.name, 'Series');
  assert.equal(h.L.Activity.active().movie.original_title, "Original's series");
  assert.equal(h.movie.title, 'Фильм не найден');
});

test('online capture attaches only stable source identity and card to all native playlist works', async t => {
  const h = setup(t), c = await h.open();
  const first = c.toPlayElement(file()), next = c.toPlayElement(file(4));
  assert.equal(first.card.id, 42); assert.equal(next.card.id, 42);
  assert.deepEqual({...first.homelab_online}, {provider: 'kinobase', voice: 'Preferred', season_index: 1});
  assert.ok(!JSON.stringify(first.homelab_online).includes('url'));
  assert.equal(first.homelab_resume_at, undefined, 'rendering alone does not apply a resume point');
});

test('native fresh resolution starts only after asynchronous rendering and matching voice/episode', async t => {
  const h = setup(t); await h.open(); h.draw([file(2), file(), file(4)]);
  h.tick(0); assert.equal(h.starts.length, 0);
  h.render(); assert.equal(h.starts.length, 0, 'do not launch midway through the native loop');
  h.tick(0); assert.equal(h.starts.length, 1); assert.equal(h.work(), null);
  h.resolve(); assert.equal(h.work().homelab_resume_at, 71);
  assert.equal(h.work().timeline.percent, 0); assert.equal(h.work().timeline.time, 0, 'prevent an earlier native ask-to-continue prompt');
  assert.equal(h.component().toPlayElement(file()).homelab_resume_at, undefined, 'one-shot resume does not stick to a playlist sibling');
});

test('a missing exact voice or provider cannot autoplay a different source', async t => {
  const h = setup(t); await h.open(); h.draw([file(3, 'Different')]); h.render(); h.tick(0);
  assert.deepEqual(h.starts, ['timeout'], 'a known mismatch invokes the owned failure callback instead of playing a different voice');
  h.tick(60000); assert.deepEqual(h.starts, ['timeout'], 'failure is reported exactly once'); assert.equal(h.work(), null);
});

test('late native source responses cannot launch after profile change or cancellation', async t => {
  const h = setup(t); await h.open(); h.draw([file()]); h.render(); h.tick(0); assert.equal(h.starts.length, 1);
  h.profile('other'); h.resolve(); assert.equal(h.work(), null);
});

test('leaving the online activity prevents a delayed automatic selection', async t => {
  const h = setup(t); await h.open(); h.draw([file()]); h.render(); h.active({component: 'main'}); h.tick(0);
  assert.equal(h.starts.length, 0);
});

test('timeout cancels automatic playback even if a native resolver eventually replies', async t => {
  const h = setup(t); await h.open(); h.draw([file()]); h.render(); h.tick(0); h.tick(60000); h.resolve();
  assert.equal(h.work(), null); assert.equal(h.starts.at(-1), 'timeout');
});

test('online and torrent observations replace the same card without retaining previous-source fields', async t => {
  const h = setup(t); h.run('mods/HomelabSync/continue.js');
  h.start({card: h.movie, season: 2, episode: 3, timeline: {hash: '123'}, homelab_torrent_hash: 'a'.repeat(40), homelab_file_index: 3});
  h.video().currentTime = 20; h.videoEvent('timeupdate'); h.calls[0].finish({success: true}); await flush();
  h.start({card: h.movie, season: 2, episode: 4, timeline: {hash: '456'}, homelab_online: h.item.online});
  h.video().currentTime = 30; h.videoEvent('timeupdate');
  const online = JSON.parse(h.calls.at(-1).options.body); assert.equal(online.kind, 'online'); assert.equal(online.torrent, null); assert.equal(online.index, 0); assert.equal(online.original, "Original's series");
  assert.equal(h.window.homelabContinue.list()[0].episode, 4); assert.equal(h.window.homelabContinue.list()[0].kind, 'online');
});

test('native cards clean up old instances when refreshed and keep one source of progress', async t => {
  const h = setup(t); h.run('mods/HomelabSync/continue.js');
  let model; h.rows[0].call()(value => { model = value; }); h.calls[0].finish({version: 1, items: [{...h.item, duration: 120, observed: Date.now(), title: 'Series'}]}); await flush();
  const row = model.params.createInstance(); row.create(); const card = h.elements.find(x => x.classes.has('homelab-resume-card')); assert.ok(card);
  row.destroy(); assert.equal(card.removed, true);
});


test('manual playback of another episode retires the outstanding automatic continuation', async t => {
  const h = setup(t); await h.open(); h.draw([file()]); h.render(); h.tick(0);
  h.L.Player.play(h.component().toPlayElement(file(4))); h.tick(60000); h.resolve();
  assert.equal(h.work().episode, 4); assert.ok(!h.starts.includes('timeout'));
});

test('a departed activity or profile receives no stale timeout notification', async t => {
  const h = setup(t); await h.open(); h.active({component: 'main'}); h.tick(60000);
  assert.ok(!h.starts.includes('timeout'));
});

test('common source selection uses exact provider/voice/episode without overwriting native progress and honors chosen quality', async t => {
  const h = setup(t);
  assert.equal(h.window.HomelabOnlineResume.select({provider: 'kinobase', identityVoice: 'Preferred', seasonIndex: 1}, h.movie, {season: 2, episode: 3}, 1080), true);
  const c = h.component(); await c.startSource();
  h.draw([file(2), file(), file(4)]); h.render(); h.tick(0); h.resolve();
  assert.equal(h.work().episode, 3); assert.equal(h.work().homelab_resume_at, undefined);
  assert.equal(h.work().timeline.time, 50, 'manual source selection keeps the native continuation policy');
  const work = {quality: {'2160p': 'fresh-4k', '1080p': 'fresh-fhd'}};
  c.setDefaultQuality(work); assert.equal(work.url, 'fresh-fhd');
  assert.deepEqual(Object.keys(work.quality), ['1080p'], 'native Player.play cannot reapply its 2160p global default');
  const next = c.toPlayElement(file(4)); assert.equal(next.homelab_online.provider, 'kinobase');
});


test('recovery selection resolves a fresh exact source and attaches position plus original duration once', async t => {
  const h = setup(t);
  assert.equal(h.window.HomelabOnlineResume.select({provider: 'kinobase', identityVoice: 'Preferred', seasonIndex: 1}, h.movie, {season: 2, episode: 3}, 1080, {scope: 'a', position: 71, duration: 120}), true);
  await h.component().startSource(); h.draw([file()]); h.render(); h.tick(0); h.resolve();
  assert.equal(h.work().homelab_resume_at, 71); assert.equal(h.work().homelab_resume_from_duration, 120);
  assert.equal(h.component().toPlayElement(file(4)).homelab_resume_at, undefined);
  assert.equal(h.window.HomelabOnlineResume.select({provider: 'kinobase', identityVoice: 'Preferred', seasonIndex: 1}, h.movie, {season: 2, episode: 3}, 1080, {scope: 'other', position: 71, duration: 120}), false);
});

test('continue navigates away from home when the saved online source cannot be launched', t => {
  const h = setup(t); h.run('mods/HomelabSync/continue.js'); delete h.registry.lampac;
  h.window.homelabContinue.resume({...h.item, kind:'online', title:'Series', duration:120});
  assert.equal(h.L.routed?.name, 'full', 'a toast alone must never strand the user on home when the picker is unavailable');
  assert.equal(h.L.routed.value.id, 42);
});

test('first-season continuation accepts a zero season index omitted by the API serializer', async t => {
  const h = setup(t), source = {provider:'kinobase',voice:'Preferred'};
  assert.equal(h.window.HomelabOnlineResume.valid(source), true, 'omitted int default must mean native season index zero');
  const c = await h.open({...h.item, season:1, episode:3, online:source});
  assert.equal(h.choices.kinobase.season, 0);
  h.draw([{...file(),season:1}]); h.render(); h.tick(0); h.resolve();
  assert.equal(h.work().homelab_resume_at, 71); assert.equal(h.work().homelab_online.season_index, 0);
});

test('wire-default compatibility does not accept explicit corrupt season indices', t => {
  const h = setup(t);
  for (const season_index of [-1, 1.5, '0', false, '', null, 1000, NaN]) assert.equal(h.window.HomelabOnlineResume.valid({provider:'kinobase',voice:'Preferred',season_index}), false);
});

test('an online launch failure opens the source picker with the saved item instead of stranding home', t => {
  const h = setup(t), picked=[]; h.run('mods/HomelabSync/continue.js'); delete h.registry.lampac;
  h.window.HomelabSources={resume(item,movie){picked.push({item,movie});return true}};
  h.window.homelabContinue.resume({...h.item,kind:'online',title:'Series',duration:120});
  assert.equal(picked.length,1); assert.equal(picked[0].item.position,71); assert.equal(picked[0].item.episode,3); assert.equal(picked[0].movie.id,42);
  assert.equal(h.notices.length,0); assert.equal(h.L.routed,undefined);
});

test('a source timeout inside the opened component only explains what to choose, once and never for another profile', t => {
  const h = setup(t), picked=[]; h.run('mods/HomelabSync/continue.js');
  h.window.HomelabSources={resume(item,movie){picked.push({item,movie});return true}};
  h.window.homelabContinue.resume({...h.item,kind:'online',title:'Series',duration:120});
  const opened = h.L.Activity.active();
  h.tick(60000); assert.equal(picked.length,0); assert.equal(h.L.Activity.active(), opened, 'the user stays in the native component');
  assert.equal(h.notices.filter(text => text.includes('Источник не ответил')).length, 1);
  h.tick(60000); assert.equal(h.notices.length, 1);
  h.window.homelabContinue.resume({...h.item,kind:'online',title:'Series',duration:120});
  h.profile('other'); h.tick(60000); assert.equal(picked.length,0); assert.equal(h.notices.length, 1);
});

test('leaving home during metadata resolution or starting another video suppresses stale failure navigation', t => {
  const h=setup(t),picked=[];let done;h.L.Api.sources.tmdb.get=(path,p,complete)=>{done=complete};h.run('mods/HomelabSync/continue.js');delete h.registry.lampac;
  h.window.HomelabSources={resume(){picked.push(true);return true}};
  h.window.homelabContinue.resume({...h.item,kind:'online',title:'Series',duration:120});h.active({component:'full'});done(h.movie);h.tick(5000);assert.equal(picked.length,0);
  h.window.homelabContinue.resume({...h.item,kind:'online',title:'Series',duration:120});h.start({card:h.movie});done(h.movie);h.tick(5000);assert.equal(picked.length,0);
});

test('a saved voice mismatch keeps the user in the native component with a notice instead of navigating', async t => {
  const h = setup(t), recovered = []; h.run('mods/HomelabSync/continue.js');
  h.window.HomelabSources = {resume(item, movie) { recovered.push({item, movie}); return true; }};
  h.window.homelabContinue.resume({...h.item, kind: 'online', title: 'Series', duration: 120});
  const opened = h.L.Activity.active();
  await h.component().startSource(); h.draw([file(3, 'Different')]); h.render(); h.tick(0); h.tick(60000);
  assert.equal(recovered.length, 0); assert.equal(h.L.Activity.active(), opened); assert.equal(h.work(), null);
  assert.deepEqual(Array.from(h.notices), ['Сохранённая озвучка не найдена. Выберите вариант в списке']);
});

test('a stale mismatch cannot redirect a different activity or profile', async t => {
  const h = setup(t); await h.open(); h.draw([file(3, 'Different')]); h.render(); h.active({component: 'main'}); h.tick(0); h.tick(60000);
  assert.deepEqual(h.starts, []);
  await h.open(); h.draw([file(3, 'Different')]); h.render(); h.profile('other'); h.tick(0); h.tick(60000);
  assert.deepEqual(h.starts, []);
});

for (const season of [null, '', false]) test(`Specials continuation rejects an unknown native season ${JSON.stringify(season)}`, async t => {
  const h = setup(t); await h.open({...h.item, season: 0});
  h.draw([{...file(), season}]); h.render(); h.tick(0);
  assert.deepEqual(h.starts, []); assert.equal(h.work(), null);
});

test('an explicit native integer season zero still continues the exact Specials episode', async t => {
  const h = setup(t); await h.open({...h.item, season: 0});
  h.draw([{...file(), season: 0}]); h.render(); h.tick(0); h.resolve();
  assert.equal(h.work().season, 0); assert.equal(h.work().episode, 3); assert.equal(h.work().homelab_resume_at, 71);
});

test('movie continuation does not require TV season or episode metadata', async t => {
  const h = setup(t); delete h.movie.name; h.movie.title = 'Film';
  await h.open({...h.item, card: 'movie_42', season: 0, episode: 0});
  h.draw([{voice_name: 'Preferred', title: 'Film', url: 'ephemeral-url'}]); h.render(); h.tick(0); h.resolve();
  assert.equal(h.work().card.title, 'Film'); assert.equal(h.work().homelab_resume_at, 71);
});

test('unknown native episode identities cannot autoplay as episode one', async t => {
  const h = setup(t);
  for (const episode of [null, '', false, true]) {
    await h.open({...h.item, season: 0, episode: 1});
    h.draw([{...file(), season: 0, episode}]); h.render(); h.tick(0);
    assert.deepEqual(h.starts, []); assert.equal(h.work(), null);
  }
});

// Native Lampac draws each translation of a movie as its own row when the
// provider has no voice buttons; the saved voice need not be the first row.
test('movie continuation matches the saved voice in any rendered row, not only the first', async t => {
  const h = setup(t); delete h.movie.name; h.movie.title = 'Film';
  await h.open({...h.item, card: 'movie_42', season: 0, episode: 0, online: {provider: 'kinobase', voice: 'Second voice', season_index: 0}});
  h.draw([{voice_name: 'First voice', title: 'Film', url: 'a'}, {voice_name: 'Second voice', title: 'Film', url: 'b'}, {voice_name: 'Third voice', title: 'Film', url: 'c'}]);
  h.render(); h.tick(0);
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].voice_name, 'Second voice');
  assert.deepEqual(Array.from(h.notices), []);
});

test('a voice is declared changed only after a whole draw had no matching row', async t => {
  const h = setup(t), failures = [];
  delete h.movie.name; h.movie.title = 'Film';
  assert.equal(h.window.HomelabOnlineResume.resume({...h.item, card: 'movie_42', season: 0, episode: 0, online: {provider: 'kinobase', voice: 'Gone', season_index: 0}}, h.movie, reason => failures.push(reason)), true);
  await h.component().startSource();
  h.draw([{voice_name: 'First voice', url: 'a'}, {voice_name: 'Second voice', url: 'b'}]); h.render(); h.tick(0);
  assert.deepEqual(failures, ['changed']); assert.equal(h.starts.length, 0);
});

test('an explicit 4K choice selects the 4K stream when the provider labels it "4K"', async t => {
  const h = setup(t);
  assert.equal(h.window.HomelabOnlineResume.select({provider: 'kinobase', identityVoice: 'Preferred', seasonIndex: 1}, h.movie, {season: 2, episode: 3}, 2160), true);
  const c = h.component(); await c.startSource();
  const work = {quality: {'4K': 'fresh-uhd', '1080p': 'fresh-fhd'}};
  c.setDefaultQuality(work); assert.equal(work.url, 'fresh-uhd'); assert.deepEqual(Object.keys(work.quality), ['4K']);
});

test('a key press in the opened component cancels automatic continuation without navigating', async t => {
  const h = setup(t); await h.open(); const opened = h.L.Activity.active();
  h.tick(600); h.L.Keypad.listener.send('keydown', {code: 40});
  h.draw([file()]); h.render(); h.tick(0); h.tick(60000);
  assert.deepEqual(h.starts, []); assert.equal(h.L.Activity.active(), opened);
});

test('a shifted saved season index (wrong season drawn) is reported at once instead of waiting a minute', async t => {
  const h = setup(t), failures = [];
  assert.equal(h.window.HomelabOnlineResume.resume(h.item, h.movie, reason => failures.push(reason)), true);
  await h.component().startSource();
  h.draw([{...file(1), season: 3}, {...file(2), season: 3}]); h.render(); h.tick(0);
  assert.deepEqual(failures, ['missing']); assert.equal(h.work(), null);
  h.tick(60000); assert.deepEqual(failures, ['missing'], 'the failure is reported once');
});

// Some providers put a release tag in voice_name and the dub in translate.
test('movie rows sharing a release-tag voice are told apart by their translation text', async t => {
  const h = setup(t); delete h.movie.name; h.movie.title = 'Film';
  await h.open({...h.item, card: 'movie_42', season: 0, episode: 0, online: {provider: 'kinobase', voice: 'WEB-DL', text: 'Dub B', season_index: 0}});
  h.draw([{voice_name: 'WEB-DL', translate: 'Dub A', url: 'a'}, {voice_name: 'WEB-DL', translate: 'Dub B', url: 'b'}]); h.render(); h.tick(0);
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].translate, 'Dub B');
  h.resolve(); assert.equal(h.work().homelab_resume_at, 71);
});

test('identical movie rows are never guessed between', async t => {
  const h = setup(t), failures = []; delete h.movie.name; h.movie.title = 'Film';
  assert.equal(h.window.HomelabOnlineResume.resume({...h.item, card: 'movie_42', season: 0, episode: 0, online: {provider: 'kinobase', voice: 'WEB-DL', season_index: 0}}, h.movie, reason => failures.push(reason)), true);
  await h.component().startSource();
  h.draw([{voice_name: 'WEB-DL', translate: 'Dub A', url: 'a'}, {voice_name: 'WEB-DL', translate: 'Dub B', url: 'b'}]); h.render(); h.tick(0);
  assert.deepEqual(failures, ['ambiguous']); assert.equal(h.work(), null);
});

test('movie continuation seeds the saved voice so a provider with voice buttons opens that voice', async t => {
  const h = setup(t, {buttons: ['Default Dub', 'Preferred']}); delete h.movie.name; h.movie.title = 'Film';
  await h.open({...h.item, card: 'movie_42', season: 0, episode: 0, online: {provider: 'kinobase', voice: 'Preferred', season_index: 0}});
  assert.equal(h.choices.kinobase.voice_name, 'Preferred'); assert.equal(h.choices.kinobase.voice_url, '');
  h.draw([{text: 'Film 1080p', url: 'a'}]); h.render(); h.tick(0);
  assert.equal(h.starts.length, 1, 'a saved non-default voice is not reported as changed');
});

test('series continuation still seeds the saved voice button', async t => {
  const h = setup(t); await h.open(); assert.equal(h.choices.kinobase.voice_name, 'Preferred');
});

test('movie capture records the row translation text alongside the voice label', async t => {
  const h = setup(t); delete h.movie.name; h.movie.title = 'Film'; const c = await h.open({...h.item, card: 'movie_42', season: 0, episode: 0});
  const work = c.toPlayElement({voice_name: 'WEB-DL', translate: 'Dub B', url: 'b'});
  assert.equal(work.homelab_online.text, 'Dub B');
});

const dubs = () => [{voice_name: '2160p', text: 'Licensed Dub', url: '/v?i=0'}, {voice_name: '2160p', text: 'Licensed Dub', url: '/v?i=1'}, {voice_name: 'WEB-DL', translate: 'Other Dub', url: '/v?i=2'}];
function movieSetup(t) { const h = setup(t), failures = []; delete h.movie.name; h.movie.title = 'Film'; return {h, failures}; }
async function pick(h, failures, match) {
  assert.equal(h.window.HomelabOnlineResume.select({provider: 'kinobase', identityVoice: 'Licensed Dub', seasonIndex: 0, match}, h.movie, {season: 0, episode: 0}, null), true);
  await h.component().startSource();
  h.component().draw(arguments[3] || dubs(), {onEnter(file) { h.starts.push(file); }});
  h.render(); h.tick(0);
}
// Route Noty failures to the list: select() reports through L.Noty.
function notices(h) { const seen = []; h.L.Noty = {show: text => seen.push(text)}; return seen; }

test('a common-source movie row is picked by its exact url among identical dubs', async t => {
  const {h} = movieSetup(t), seen = notices(h);
  await pick(h, null, {index: 1, count: 3, url: '/v?i=1', text: 'Licensed Dub', translate: '', voice_name: '2160p'});
  assert.deepEqual(seen, []); assert.equal(h.starts.length, 1); assert.equal(h.starts[0].url, '/v?i=1');
});

test('without a url the saved index is used when the page has the same row count', async t => {
  const {h} = movieSetup(t), seen = notices(h);
  // The server omits a zero index.
  await pick(h, null, {count: 3, text: 'Licensed Dub', translate: '', voice_name: '2160p'});
  assert.deepEqual(seen, []); assert.equal(h.starts[0].url, '/v?i=0');
});

test('a changed page row count falls back to a unique text match', async t => {
  const {h} = movieSetup(t), seen = notices(h);
  await pick(h, null, {index: 0, count: 5, text: 'Other', translate: 'Other Dub', voice_name: 'WEB-DL'});
  assert.equal(h.starts[0].url, '/v?i=2');
});

test('identical dubs on a changed page are ambiguous, not guessed', async t => {
  const second = movieSetup(t), again = notices(second.h);
  await pick(second.h, null, {index: 0, count: 5, text: 'Licensed Dub', translate: '', voice_name: '2160p'});
  assert.equal(second.h.starts.length, 0); assert.match(again[0], /несколько/);
});

test('a url row whose dub no longer matches is reported as changed, never played', async t => {
  const {h} = movieSetup(t), seen = notices(h);
  await pick(h, null, {index: 2, count: 3, url: '/v?i=2', text: 'Licensed Dub', translate: 'Licensed Dub', voice_name: 'WEB-DL'});
  assert.equal(h.starts.length, 0); assert.match(seen[0], /изменился/);
});

test('movie capture records the drawn row position and texts but never the resolver url', async t => {
  const {h} = movieSetup(t); const c = await h.open({...h.item, card: 'movie_42', season: 0, episode: 0, online: {provider: 'kinobase', voice: '2160p', season_index: 0}});
  const rows = dubs(); c.draw(rows, {}); h.render();
  const work = c.toPlayElement(rows[1]);
  assert.deepEqual({...work.homelab_online.match}, {index: 1, count: 3, text: 'Licensed Dub', translate: '', voice_name: '2160p'});
});

test('series rows ignore a stray match and keep voice/episode matching', async t => {
  const h = setup(t);
  assert.equal(h.window.HomelabOnlineResume.select({provider: 'kinobase', identityVoice: 'Preferred', seasonIndex: 1, match: {index: 0, count: 1, url: 'x'}}, h.movie, {season: 2, episode: 3}, null), true);
  await h.component().startSource(); h.draw([file(2), file()]); h.render(); h.tick(0);
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].episode, 3);
});

test('a movie match with out-of-range positions is rejected before opening', t => {
  const {h} = movieSetup(t), valid = h.window.HomelabOnlineResume.valid;
  assert.equal(valid({provider: 'kinobase', voice: '', season_index: 0, match: {index: 3, count: 3}}), false);
  assert.equal(valid({provider: 'kinobase', voice: '', season_index: 0, match: {index: 0, count: 1, translate: 'x'.repeat(201)}}), false);
  assert.equal(valid({provider: 'kinobase', voice: '', season_index: 0, match: {count: 1}}), true);
});

test('continue focuses the saved voice and episode row without starting it; Enter on that row resumes the saved point', async t => {
  const h = setup(t), focused = [];
  h.L.Controller.collectionFocus = target => { focused.push(target); };
  h.L.Controller.enabled = () => ({name: 'content'});
  assert.equal(h.window.HomelabOnlineResume.resume(h.item, h.movie, () => h.starts.push('failed'), {focus: true}), true);
  const c = h.component(); await c.startSource();
  const rows = [file(2), file(), file(4)];
  h.draw(rows); h.render(); h.tick(0);
  assert.equal(h.starts.length, 0, 'the video is not started');
  assert.equal(focused.length, 1, 'the saved episode row receives focus');
  h.tick(60000); assert.equal(h.starts.length, 0, 'no timeout notice after landing on the row');
  assert.equal(c.toPlayElement(rows[0]).homelab_resume_at, undefined, 'another episode starts from its own progress');
  const work = c.toPlayElement(rows[1]);
  assert.equal(work.homelab_resume_at, 71, 'the user\'s Enter on the saved row resumes the saved point');
  assert.equal(c.toPlayElement(rows[1]).homelab_resume_at, undefined, 'applied once');
});

test('series play elements carry the episode number for the player and its playlist', async t => {
  const h = setup(t), c = await h.open();
  assert.equal(c.toPlayElement(file()).title, 'Серия 3 · Episode');
  assert.equal(c.toPlayElement({...file(), title: '3 серия'}).title, '3 серия', 'a title that already has the number is kept');
  assert.equal(c.toPlayElement({...file(5), season: 0, title: 'Recap'}).title, 'Спецвыпуск 5 · Recap');
});

test('Enter on another row after a Continue landing drops the saved point instead of spending it on the playlist', async t => {
  const h = setup(t);
  h.L.Controller.collectionFocus = () => {}; h.L.Controller.enabled = () => ({name: 'content'});
  h.window.HomelabOnlineResume.resume(h.item, h.movie, () => {}, {focus: true});
  const c = h.component(); await c.startSource();
  const rows = [file(2), file(), file(4)];
  let params;
  c.draw(rows, {onEnter() {}, onRender() { params = this; }}); h.render(); h.tick(0);
  params.onEnter(rows[0]);
  assert.equal(c.toPlayElement(rows[1]).homelab_resume_at, undefined, 'the playlist cell of the saved row stays native');
});

test('the next "call" episode is fetched quietly in the last minutes, so Next starts at once', async t => {
  const h = setup(t), c = await h.open();
  const call = episode => ({season: 2, episode, voice_name: 'Preferred', title: 'Episode', method: 'call', url: '/lite/kinobase/video?e=' + episode});
  const first = c.toPlayElement(call(3)), next = c.toPlayElement(call(4)), lazy = () => {};
  next.url = lazy;
  const list = [first, next];
  h.L.PlayerPlaylist = {get: () => list, position: () => 0};
  h.L.Player.play(first);
  const video = h.L.PlayerVideo.video(); video.duration = 1200; video.currentTime = 100;
  const asked = () => h.calls.filter(entry => String(entry.url).includes('/lite/kinobase/video'));
  h.videoEvent('timeupdate'); assert.equal(asked().length, 0, 'nothing is fetched early in the episode');
  video.currentTime = 1100; h.videoEvent('timeupdate'); h.videoEvent('timeupdate');
  assert.equal(asked().length, 1, 'one request near the end');
  const url = new URL(asked()[0].url);
  assert.equal(url.searchParams.get('e'), '4'); assert.equal(url.searchParams.get('uid'), 'test'); assert.equal(url.searchParams.get('profile_id'), 'a');
  asked()[0].finish({url: 'stream-4', quality: {'1080p': 'q1080', '2160p': 'q2160'}}); await flush();
  assert.equal(next.url, 'q2160', 'the row now holds a playable stream with the default quality');
  assert.equal(Object.keys(next).includes('homelab_lazy'), false, 'helper fields stay out of the saved playlist');
  h.tick(11 * 60000); video.currentTime = 1150; h.videoEvent('timeupdate');
  assert.equal(asked().length, 2, 'an old stream is fetched again before it expires');
});

test('a prefetch answer that needs the remote client is left to Lampac', async t => {
  const h = setup(t), c = await h.open();
  const next = c.toPlayElement({season: 2, episode: 4, voice_name: 'Preferred', title: 'Episode', method: 'call', url: '/lite/kinobase/video?e=4'}), lazy = () => {};
  next.url = lazy;
  h.L.PlayerPlaylist = {get: () => [{}, next], position: () => 0};
  h.L.Player.play({});
  const video = h.L.PlayerVideo.video(); video.duration = 1200; video.currentTime = 1100; h.videoEvent('timeupdate');
  h.calls.filter(entry => String(entry.url).includes('/lite/'))[0].finish({rch: true}); await flush();
  assert.equal(next.url, lazy);
});

test('an unreachable Lampac server is named instead of an undefined provider', async t => {
  const h = setup(t);
  const c = await h.open();
  c.noConnectToServer(new Error('network'));
  assert.match(c.render().find('.online-empty__time').text(), /^Сервер Lampac не ответил/);
});

function focusLog(h, log) { return item => { const html = h.window.$('<div class="online-prestige"></div>'); html.on('hover:focus', () => log.push(item.episode)); return html; }; }

test('Back from the player lands on the episode that played last, not the one started', async t => {
  const log = [], h = setup(t, {html: file => focusLog(h, log)(file)}), c = await h.open();
  const files = [2, 3, 4, 5].map(episode => file(episode));
  c.draw(files, {}); h.render();
  h.L.Player.play(c.toPlayElement(files[1]));
  h.L.Player.play(c.toPlayElement(files[3]));
  h.L.Player.listener.send('destroy');
  assert.deepEqual(log, [5]);
  h.L.Player.listener.send('destroy');
  assert.deepEqual(log, [5], 'only once per playback');
});

test('another voice, a movie or a closed component leaves the focus alone', async t => {
  const log = [], h = setup(t, {html: file => focusLog(h, log)(file)}), c = await h.open();
  const files = [2, 3].map(episode => file(episode));
  c.draw(files, {}); h.render();
  h.L.Player.play(c.toPlayElement(file(3, 'Other')));
  h.L.Player.listener.send('destroy');
  assert.deepEqual(log, []);
  h.L.Player.play(c.toPlayElement(files[1]));
  c.destroy(); h.L.Player.listener.send('destroy');
  assert.deepEqual(log, []);
});

const progress = (episode, at, season = 2) => ({extra: JSON.stringify({card: 'tv_42', season, episode}), watched_at: at});

test('the episode list opens at the newest episode watched on any device', async t => {
  const h = setup(t), c = await h.open();
  h.syncRows([progress(3, 100), progress(7, 300), progress(5, 200), {extra: JSON.stringify({card: 'tv_9', season: 2, episode: 9}), watched_at: 999}]);
  h.choices.kinobase = {episodes_view: {1: 4, 2: 3}};
  c.draw([file(3), file(7)], {});
  assert.deepEqual(JSON.parse(JSON.stringify(h.choices.kinobase.episodes_view)), {1: 4, 2: 7});
});

test('a list left open moves to newer progress from another device, and only then', async t => {
  const log = [], h = setup(t, {html: file => focusLog(h, log)(file)}), c = await h.open();
  h.syncRows([progress(3, 100)]);
  const files = [3, 4, 5].map(episode => file(episode));
  c.draw(files, {}); h.render(); h.L.Controller.toggle('select');
  h.syncPublish(); assert.deepEqual(log, [], 'nothing new');
  h.syncRows([progress(3, 100), progress(5, 400)]); h.syncPublish();
  assert.deepEqual(log, [], 'not under a menu');
  h.L.Controller.toggle('content'); h.syncPublish();
  assert.deepEqual(log, [5]);
  h.syncPublish(); assert.deepEqual(log, [5], 'the same progress moves it once');
  h.syncRows([progress(3, 100), progress(5, 450)]); h.syncPublish();
  assert.deepEqual(log, [5], 'another TV still saving the same episode does not pull focus again');
  h.syncRows([progress(3, 100), progress(5, 400), progress(4, 500)]);
  h.L.Player.play(c.toPlayElement(files[0])); h.syncPublish();
  assert.deepEqual(log, [5], 'never under the player');
  c.destroy(); h.syncRows([progress(4, 900)]); h.syncPublish();
  assert.deepEqual(log, [5], 'a closed list is left alone');
});

test('the episode just played here is not focused again by its own progress', async t => {
  const log = [], h = setup(t, {html: file => focusLog(h, log)(file)}), c = await h.open();
  h.syncRows([progress(3, 100)]);
  const files = [3, 4, 5].map(episode => file(episode));
  c.draw(files, {}); h.render();
  h.L.Player.play(c.toPlayElement(files[2])); h.L.Player.listener.send('destroy');
  h.L.Controller.toggle('content'); log.length = 0;
  h.syncRows([progress(3, 100), progress(5, 600)]); h.syncPublish();
  assert.deepEqual(log, []);
});
