const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');

// Fictional fixtures only.
const hash = 'c'.repeat(40), DAY = 86400000;
const saved = {card: 'tv_42', title: 'Series', kind: 'torrent', torrent: hash, index: 2, timeline: '123', season: 1, episode: 2, position: 30, duration: 120, observed: 1000};
async function row(t, items, setup = () => {}) {
  const h = harness(t); setup(h); h.run('mods/HomelabSync/continue.js'); let instance;
  h.rows[0].call()(data => { instance = data.params.createInstance(); instance.create(); });
  h.calls[0].finish({version: 1, items}); await flush();
  const last = name => h.elements.filter(e => e.classes.has(name) && !e.removed).at(-1);
  const overlay = () => h.elements.filter(e => e.classes.has('homelab-resume-progress') && !e.removed).at(-1).find('.card-watched__body').children[0].find('span').content;
  const all = name => h.elements.filter(e => e.classes.has(name) && !e.removed);
  return {...h, row: instance, last, all, overlay};
}

test('a tile has no footer: episode and remaining time are in the focus overlay, progress and source on the poster', async t => {
  const h = await row(t, [saved]);
  assert.equal(h.all('homelab-resume-meta').length, 0);
  assert.equal(h.overlay(), 'С1 · Е2 · осталось 2 мин');
  const bar = h.last('homelab-resume-bar');
  assert.equal(bar.hasClass('hide'), false); assert.equal(bar.find('div').attrs['style:width'], '25%');
  assert.equal(h.last('homelab-resume-badge').text(), 'Торрент');
  assert.equal(h.last('card').find('.card__age').removed, true, 'no year/time line under the title');
});

test('a finished episode reads as the next one without a progress bar, and online records show their provider', async t => {
  const h = await row(t, [{...saved, position: 110, kind: 'online', torrent: null, index: 0, online: {provider: 'fictional', voice: 'Voice', season_index: 0}}]);
  assert.equal(h.overlay(), 'Следующая: Е3');
  assert.equal(h.last('homelab-resume-bar').hasClass('hide'), true);
  assert.equal(h.last('homelab-resume-badge').text(), 'Fictional');
});

test('long remaining time uses short human Russian copy in the overlay', async t => {
  const h = await row(t, [{...saved, card: 'movie_7', season: 0, episode: 0, position: 600, duration: 6000}]);
  assert.equal(h.overlay(), 'осталось 1 ч 30 мин');
});

test('the focus overlay marks watched and started episodes of the season and highlights the current one', async t => {
  const season = Array.from({length: 6}, (_, i) => ({season_number: 1, episode_number: i + 1, name: 'Episode ' + (i + 1)}));
  const h = await row(t, [saved], h => {
    h.syncRows([
      {hash: '3', watched_at: 2, position: 118, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 1, episode: 3})},
      {hash: '4', watched_at: 2, position: 60, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 1, episode: 4})},
      {hash: '5', watched_at: 2, position: 60, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 2, episode: 5})}]);
  });
  h.L.Api.sources.tmdb.get = (path, params, done) => done({episodes: season});
  h.last('homelab-resume-card').addClass('focus').trigger('hover:focus'); h.tick(500);
  const lines = h.last('homelab-resume-progress').find('.card-watched__body').children;
  assert.deepEqual(lines.map(x => x.find('span').content), ['2 · Episode 2', '3 · Episode 3', '4 · Episode 4', '5 · Episode 5', '6 · Episode 6']);
  assert.ok(lines[0].hasClass('homelab-ep--current'));
  assert.ok(lines[1].hasClass('homelab-ep--watched')); assert.equal(lines[1].children.length, 0);
  assert.equal(lines[2].children[0].find('div').attrs['style:width'], '50%');
  assert.equal(lines[3].children.length, 0, 'another season never marks this one');
  assert.equal(h.last('homelab-resume-progress').find('.homelab-resume-head').text(), 'Сезон 1');
});

test('long press offers remove, mark watched and source choice; marking watched advances the series with its captured source', async t => {
  const h = await row(t, [saved, {...saved, card: 'tv_43', title: 'Other'}]);
  h.elements.find(e => e.classes.has('homelab-resume-card')).trigger('hover:long');
  assert.deepEqual([...h.select().items].map(x => x.title), ['Убрать из ряда', 'Отметить просмотренным', 'Выбрать источник']);
  h.choose(h.select().items[1]);
  const body = JSON.parse(h.calls.at(-1).options.body);
  assert.equal(body.position, 120); assert.equal(body.duration, 120); assert.equal(body.episode, 2);
  assert.equal(body.kind, 'torrent'); assert.equal(body.torrent, hash); assert.equal(body.timeline, '123');
  const item = h.window.homelabContinue.list().find(x => x.card === 'tv_42');
  assert.equal(item.episode, 3); assert.deepEqual({...item.advance}, {season: 1, episode: 2});
  assert.equal(h.overlay().length > 0, true);
});

test('marking a movie watched removes it from the row', async t => {
  const h = await row(t, [{...saved, card: 'movie_7', season: 0, episode: 0}]);
  assert.equal(h.window.homelabContinue.watched(h.window.homelabContinue.list()[0]), true);
  assert.equal(h.window.homelabContinue.list().length, 0);
});

test('native-only progress without a captured source cannot be marked watched', async t => {
  const native = await row(t, [], h => h.syncRows([{hash: '9', watched_at: 5, position: 40, duration: 120, extra: JSON.stringify({card: 'tv_44', season: 1, episode: 1})}]));
  native.elements.filter(e => e.classes.has('homelab-resume-card')).at(-1).trigger('hover:long');
  assert.deepEqual([...native.select().items].map(x => x.title), ['Убрать из ряда', 'Выбрать источник']);
});

test('choose source opens the picker for the exact episode and position instead of the captured source', async t => {
  const picks = [];
  const h = await row(t, [saved], h => { h.window.HomelabSources = {resume(item, movie) { picks.push({item, movie}); return true; }}; });
  h.elements.find(e => e.classes.has('homelab-resume-card')).trigger('hover:long');
  h.choose(h.select().items.find(x => x.action === 'source'));
  assert.equal(picks.length, 1); assert.equal(picks[0].item.episode, 2); assert.equal(picks[0].item.position, 30);
  assert.equal(h.L.sourceLookup, undefined, 'the captured torrent is not opened');
});

test('an online next episode in another season cannot be marked watched with the old season index', async t => {
  const online = {...saved, kind: 'online', torrent: null, index: 0, online: {provider: 'fictional', voice: 'Voice', season_index: 0}, title: undefined, season: 1, episode: 2, position: 115};
  const h = await row(t, [online], h => { h.L.Api.sources.tmdb.get = (path, params, done) => done({id: 42, name: 'Series', original_name: 'Series', seasons: [{season_number: 1, episode_count: 2}, {season_number: 2, episode_count: 5}]}); });
  const [item] = h.window.homelabContinue.list();
  assert.equal(item.season, 2); assert.equal(item.episode, 1);
  assert.equal(h.window.homelabContinue.watched(item), false);
  h.elements.filter(e => e.classes.has('homelab-resume-card')).at(-1).trigger('hover:long');
  assert.deepEqual([...h.select().items].map(x => x.title), ['Убрать из ряда', 'Выбрать источник']);
});

test('programmatic refocus of the row does not replay the card bounce; a remote move does', async t => {
  const h = await row(t, [saved, {...saved, card: 'tv_43', title: 'Other', observed: 900}]);
  const element = h.last('homelab-resume-row');
  h.tick(1000); h.row.toggle();
  assert.equal(element.hasClass('homelab-resume-quiet'), true, 'startup and reload refocus stay still');
  h.L.Controller.controllers.homelab_resume.right();
  assert.equal(element.hasClass('homelab-resume-quiet'), false, 'a remote move bounces the next card');
});

test('titles, posters and the episode list from the last session render at once on the next start', async t => {
  const h = await row(t, [{...saved, title: undefined}], h => {
    h.L.Api.sources.tmdb.get = () => {};
    h.storage.set('homelab_continue_cache', {scope: 'a', items: [], metadata: {tv_42: {title: 'Cached title', poster: '/cached.jpg', bad: '<x>'}, 'bad key': {title: 'x'}}});
    h.storage.set('homelab_continue_episodes', {'a|tv_42:1:2': [{episode_number: 2, name: 'Second'}, {episode_number: 3, name: 'Third'}]});
  });
  const shown = h.window.homelabContinue.list()[0];
  assert.equal(shown.title, 'Cached title'); assert.equal(shown.poster, '/cached.jpg');
  assert.equal(h.overlay(), '2 · Second', 'the cached episode list is painted before any lookup');
  const stored = h.storage.get('homelab_continue_cache');
  assert.deepEqual(Object.keys(stored.metadata), ['tv_42']);
  assert.equal(stored.metadata.tv_42.bad, undefined);
});
