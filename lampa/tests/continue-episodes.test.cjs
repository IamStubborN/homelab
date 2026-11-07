const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');
const item = {card: 'tv_42', title: 'Series', season: 1, episode: 10, position: 30, duration: 120, observed: 1};
const season = (number, first, last) => Array.from({length: last - first + 1}, (_, i) => ({season_number: number, episode_number: first + i, name: 'Episode ' + (first + i)}));
async function setup(t, value = item) {
  const h = harness(t); h.run('mods/HomelabSync/continue.js'); let row;
  h.rows[0].call()(data => { row = data.params.createInstance(); row.create(); });
  h.calls[0].finish({version: 1, items: [value]}); await flush();
  function tile() { return h.elements.filter(x => x.classes.has('homelab-resume-card') && !x.removed).at(-1); }
  function lines() { return h.elements.filter(x => x.classes.has('homelab-resume-progress')).at(-1).find('.card-watched__body').children; }
  return {...h, row, tile, lines, focus() { tile().addClass('focus').trigger('hover:focus'); h.tick(500); }};
}

test('five episode overlay uses the exact season and only current source progress', async t => {
  const h = await setup(t); let gets = 0;
  h.L.TimeTable = {get(card, done) { done(season(2, 1, 20)); }};
  h.L.Api.sources.tmdb.get = (path, params, done) => { gets++; assert.equal(path, 'tv/42/season/1'); done({episodes: season(1, 1, 20).reverse()}); };
  h.focus(); assert.deepEqual(h.lines().map(x => x.find('span').content), ['10 - Episode 10', '11 - Episode 11', '12 - Episode 12', '13 - Episode 13', '14 - Episode 14']);
  assert.equal(h.lines()[0].children.length, 1); assert.equal(h.lines()[0].children[0].find('div').attrs['style:width'], '25%');
  assert.ok(h.lines().slice(1).every(x => x.children.length === 0));
  h.tile().trigger('hover:focus'); h.tick(1000); assert.equal(gets, 1);
});

test('Specials use the season-zero episode list in the Continue overlay', async t => {
  const h = await setup(t, {...item, season: 0, episode: 1});
  h.L.Api.sources.tmdb.get = (path, params, done) => { assert.equal(path, 'tv/42/season/0'); done({episodes: season(0, 1, 5)}); };
  h.focus(); assert.equal(h.lines().length, 5); assert.equal(h.lines()[0].find('span').content, '1 - Episode 1');
});

test('end of a season has fewer rows and never invents episodes or crosses seasons', async t => {
  const h = await setup(t, {...item, episode: 23});
  h.L.TimeTable = {get(card, done) { done(season(1, 1, 26)); }};
  h.L.Utils.splitEpisodesIntoSeasons = rows => ({1: rows});
  h.L.Api.sources.tmdb.get = () => assert.fail('valid native cache must not fetch');
  h.focus(); assert.equal(h.lines().length, 4); assert.equal(h.lines().at(-1).find('span').content, '26 - Episode 26');
});

test('metadata failure retains current episode and destroyed cards ignore late responses', async t => {
  const h = await setup(t); let done;
  h.L.Api.sources.tmdb.get = (path, params, success) => { done = success; };
  h.focus(); h.tick(10000); assert.equal(h.lines().length, 1);
  h.row.destroy(); done({episodes: season(1, 1, 20)}); assert.equal(h.lines().length, 1);
});

test('profile changes discard the previous episode request even for an identical card', async t => {
  const h = await setup(t); const callbacks = [];
  h.L.Api.sources.tmdb.get = (path, params, done) => callbacks.push(done);
  h.focus(); assert.equal(callbacks.length, 1);
  h.profile('second'); h.calls.at(-1).finish({version: 1, items: [item]}); await flush();
  h.focus(); assert.equal(callbacks.length, 2);
  callbacks[0]({episodes: season(1, 1, 20)}); assert.equal(h.lines().length, 1);
  callbacks[1]({episodes: season(1, 1, 20)}); assert.equal(h.lines().length, 5);
});

test('rapid focus movement starts no episode lookup for a card that already lost focus', async t => {
  const h = await setup(t); h.L.Api.sources.tmdb.get = () => assert.fail('stale hover must not fetch');
  h.tile().addClass('focus').trigger('hover:focus'); h.tile().removeClass('focus'); h.tick(500);
  assert.equal(h.lines().length, 1);
});
