const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');

// Fictional fixtures only.
const hash = 'b'.repeat(40);
const saved = {card: 'tv_42', title: 'Series', kind: 'torrent', torrent: hash, index: 2, timeline: '123', season: 1, episode: 2, position: 30, duration: 120, observed: 1000};
function timelineBus() {
  const handlers = [];
  return {follow(name, fn) { if (name === 'update') handlers.push(fn); }, send(data) { handlers.forEach(fn => fn({data})); }};
}
async function loaded(t, items, setup = () => {}) {
  const h = harness(t); setup(h); h.run('mods/HomelabSync/continue.js');
  h.window.homelabContinue.load(); h.calls[0].finish({version: 1, items}); await flush();
  return h;
}

test('an episode past Lampa\'s 90% watched mark is offered as the next episode from the start', async t => {
  const h = await loaded(t, [{...saved, position: 110}]);
  const [item] = h.window.homelabContinue.list();
  assert.equal(item.season, 1); assert.equal(item.episode, 3); assert.equal(item.position, 0);
  assert.deepEqual({...item.advance}, {season: 1, episode: 2});
});

const seasons = [{season_number: 0, episode_count: 2}, {season_number: 1, episode_count: 2}, {season_number: 2, episode_count: 8}];
const withSeasons = h => { h.L.Api.sources.tmdb.get = (path, params, done) => done({id: 42, name: 'Series', original_name: 'Series', seasons}); };
test('the last episode of a season advances to the first episode of the next season', async t => {
  const h = await loaded(t, [{...saved, title: undefined, position: 110}], withSeasons);
  const [item] = h.window.homelabContinue.list();
  assert.equal(item.season, 2); assert.equal(item.episode, 1);
});

test('a finished series disappears from the row', async t => {
  const h = await loaded(t, [{...saved, title: undefined, season: 2, episode: 8, position: 115}], withSeasons);
  assert.equal(h.window.homelabContinue.list().length, 0);
});

test('a watched movie leaves the row', async t => {
  const h = await loaded(t, [{...saved, card: 'movie_42', season: 0, episode: 0, position: 110}]);
  assert.equal(h.window.homelabContinue.list().length, 0);
});

test('resuming an advanced torrent item plays the next file of the same release from its own progress', async t => {
  const h = await loaded(t, [{...saved, position: 110}]);
  h.window.homelabContinue.resume(h.window.homelabContinue.list()[0]);
  h.L.sourceLookup.success({data: JSON.stringify({movie: {id: 42, name: 'Series', original_name: 'Series', number_of_seasons: 1}}), file_stats: [
    {id: 1, path: 'Series/S01E01.mkv'}, {id: 2, path: 'Series/S01E02.mkv'}, {id: 3, path: 'Series/S01E03.mkv'}]});
  assert.equal(h.work().id, 3); assert.equal(h.work().homelab_resume_at, undefined);
  assert.equal(h.video().currentTime, 0);
});

test('long press removes a card with a tombstone; a later viewing brings it back', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js'); let row;
  h.rows[0].call()(data => { row = data.params.createInstance(); row.create(); });
  h.calls[0].finish({version: 1, items: [saved, {...saved, card: 'tv_43', title: 'Other'}]}); await flush();
  const tile = h.elements.find(e => e.classes.has('homelab-resume-card') && !e.removed);
  tile.trigger('hover:long');
  assert.equal(h.select().items[0].remove, true);
  h.choose(h.select().items[0]);
  const body = JSON.parse(h.calls.at(-1).options.body);
  assert.deepEqual(body, {card: 'tv_42', deleted: true, observed: body.observed});
  assert.deepEqual(Array.from(h.window.homelabContinue.list(), item => item.card), ['tv_43']);
  h.calls.at(-1).finish({success: true, observed: body.observed}); await flush();
  assert.deepEqual(Array.from(h.window.homelabContinue.list(), item => item.card), ['tv_43']);
  h.syncRows([{watched_at: body.observed - 1, hash: '9', position: 40, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 1, episode: 4})}]);
  assert.equal(h.window.homelabContinue.list().length, 1, 'older native progress stays dismissed');
  h.syncRows([{watched_at: body.observed + 1, hash: '9', position: 40, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 1, episode: 4})}]);
  const back = h.window.homelabContinue.list().find(item => item.card === 'tv_42');
  assert.equal(back.episode, 4);
  row.destroy();
});

test('external players are captured at launch and again when the native timeline returns their position', async t => {
  const h = harness(t), timeline = timelineBus(); h.L.Timeline.listener = timeline;
  h.run('mods/HomelabSync/continue.js');
  const work = {card: {id: 42, name: 'Series', original_name: 'Series'}, season: 1, episode: 2, timeline: {hash: '123', time: 30, duration: 120},
    torrent_hash: hash, url: '/stream/x.mkv?link=' + hash + '&index=2'};
  h.L.Player.listener.send('external', work);
  assert.equal(h.calls.length, 1); assert.equal(JSON.parse(h.calls[0].options.body).position, 30);
  h.calls[0].finish({success: true}); await flush();
  h.tick(60000); timeline.send({hash: '123', road: {time: 80, duration: 120, percent: 66}});
  await flush();
  const last = JSON.parse(h.calls.at(-1).options.body);
  assert.equal(last.position, 80); assert.equal(last.episode, 2); assert.equal(last.torrent, hash);
});

test('an external player starts at the continuation point while the inner player keeps the explicit seek', t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  const data = {timeline: {hash: '1', time: 0, percent: 0, duration: 120}, homelab_resume_at: 60};
  h.L.Player.listener.send('create', {data});
  assert.equal(data.timeline.time, 60, 'external launchers read timeline.time');
  h.L.Player.listener.send('start', data);
  assert.equal(data.timeline.time, 0); assert.equal(data.timeline.percent, 0, 'no native ask-to-continue prompt');
});

test('cards from non-TMDB catalogues are not captured under a TMDB key', t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  h.start({card: {id: 42, name: 'Series', source: 'kp'}, season: 1, episode: 2, timeline: {hash: '1'}, homelab_torrent_hash: hash, homelab_file_index: 1});
  h.video().currentTime = 50; h.videoEvent('timeupdate');
  assert.equal(h.calls.length, 0);
});

test('the main row is created immediately from the cached list even while Lampac is slow', async t => {
  const h = harness(t); let pulled;
  h.sync.pull = done => { pulled = done; };
  h.storage.set('homelab_continue_cache', {scope: 'a', items: [saved]});
  h.run('mods/HomelabSync/continue.js'); let row;
  h.rows[0].call()(data => { row = data.params.createInstance(); row.create(); });
  assert.ok(row, 'resolved before the progress pull finished');
  assert.equal(h.elements.filter(e => e.classes.has('homelab-resume-card') && !e.removed).length, 1);
  pulled(); h.calls[0].finish({version: 1, items: [saved, {...saved, card: 'tv_43', observed: 2000}]}); await flush();
  assert.equal(h.elements.filter(e => e.classes.has('homelab-resume-card') && !e.removed).length, 2);
  assert.equal(h.storage.get('homelab_continue_cache').items.length, 2);
  row.destroy();
});

test('a cache from another profile is never shown', t => {
  const h = harness(t); h.sync.pull = () => {};
  h.storage.set('homelab_continue_cache', {scope: 'other', items: [saved]});
  h.run('mods/HomelabSync/continue.js');
  assert.equal(h.window.homelabContinue.list().length, 0);
});

test('a server-clamped stamp is adopted', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  h.start({card: {id: 42, name: 'Series'}, season: 1, episode: 2, timeline: {hash: '123'}, homelab_torrent_hash: hash, homelab_file_index: 1});
  h.video().currentTime = 50; h.videoEvent('timeupdate');
  h.calls[0].finish({success: true, observed: 777}); await flush();
  assert.equal(h.window.homelabContinue.list()[0].observed, 777);
});

test('a write the server rejected as older does not shadow the newer server record', async t => {
  const h = await loaded(t, [{...saved, episode: 5, observed: Date.now() + 100000}]);
  h.start({card: {id: 42, name: 'Series'}, season: 1, episode: 2, timeline: {hash: '123'}, homelab_torrent_hash: hash, homelab_file_index: 1});
  h.video().currentTime = 50; h.videoEvent('timeupdate');
  h.calls.at(-1).finish({success: true, stale: true}); await flush();
  assert.equal(h.window.homelabContinue.list()[0].episode, 5);
});

test('a captured source without a usable release opens the source picker with the exact episode', async t => {
  const h = await loaded(t, [{...saved, torrent: undefined, kind: undefined}]); const picked = [];
  h.window.HomelabSources = {resume(item, movie) { picked.push({item, movie}); return true; }};
  h.window.homelabContinue.resume(h.window.homelabContinue.list()[0]);
  assert.equal(picked.length, 1); assert.equal(picked[0].item.episode, 2); assert.equal(picked[0].item.position, 30);
});

const native = (extra, values) => ({hash: '123', duration: 120, extra: JSON.stringify({card: 'tv_42', ...extra}), ...values});
test('newer native progress on the captured episode moves the position forward and keeps the source', async t => {
  const h = await loaded(t, [saved]);
  h.syncRows([native({season: 1, episode: 2}, {watched_at: 2000, position: 80})]);
  const [item] = h.window.homelabContinue.list();
  assert.equal(item.position, 80); assert.equal(item.torrent, hash); assert.equal(item.observed, 2000);
  h.syncRows([native({season: 1, episode: 2}, {watched_at: 3000, position: 40})]);
  assert.equal(h.window.homelabContinue.list()[0].position, 30, 'a rewind or stale close does not move it back');
});

test('newer native progress on a captured movie is used once it is watched', async t => {
  const h = await loaded(t, [{...saved, card: 'movie_42', season: 0, episode: 0}]);
  h.syncRows([{hash: '123', duration: 120, extra: JSON.stringify({card: 'movie_42'}), watched_at: 2000, position: 115}]);
  assert.equal(h.window.homelabContinue.list().length, 0);
});

test('a later native episode stamped within the native save interval does not replace an active capture', async t => {
  const h = await loaded(t, [saved]);
  h.syncRows([native({season: 1, episode: 5}, {hash: '9', watched_at: 1000 + 60000, position: 300})]);
  assert.equal(h.window.homelabContinue.list()[0].episode, 2);
  h.syncRows([native({season: 0, episode: 1}, {hash: '9', watched_at: 1000 + 200000, position: 20})]);
  assert.equal(h.window.homelabContinue.list()[0].episode, 2, 'a special barely opened does not win');
  h.syncRows([native({season: 0, episode: 1}, {hash: '9', watched_at: 1000 + 200000, position: 70})]);
  assert.equal(h.window.homelabContinue.list()[0].season, 0);
});

test('a key press while a torrent launch is being prepared cancels it without navigating', async t => {
  const h = await loaded(t, [saved]); const routes = [];
  h.L.Router.call = (name, value) => routes.push(name);
  h.window.homelabContinue.resume(h.window.homelabContinue.list()[0]);
  h.tick(600); h.L.Keypad.listener.send('keydown', {code: 40});
  h.tick(20000);
  assert.deepEqual(routes, []); assert.equal(h.work(), null);
});

test('a permanently rejected write is dropped instead of being shown as saved', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  h.start({card: {id: 42, name: 'Series'}, season: 1, episode: 2, timeline: {hash: '123'}, homelab_torrent_hash: hash, homelab_file_index: 1});
  h.video().currentTime = 50; h.videoEvent('timeupdate');
  assert.equal(h.window.homelabContinue.list().length, 1);
  h.calls[0].finish({}, 400); await flush();
  assert.equal(h.window.homelabContinue.list().length, 0);
});

test('a full server (507) keeps retrying the write', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  h.start({card: {id: 42, name: 'Series'}, season: 1, episode: 2, timeline: {hash: '123'}, homelab_torrent_hash: hash, homelab_file_index: 1});
  h.video().currentTime = 50; h.videoEvent('timeupdate');
  for (const wait of [5000, 15000, 60000, 300000]) { h.calls.at(-1).finish({}, 507); await flush(); const before = h.calls.length; h.tick(wait); assert.equal(h.calls.length, before + 1); }
});

test('a dismissal is stamped after the newest native viewing of the card', async t => {
  const h = await loaded(t, [saved]);
  h.syncRows([native({season: 1, episode: 4}, {hash: '9', watched_at: Date.now() + 500000, position: 40})]);
  h.window.homelabContinue.dismiss('tv_42');
  const body = JSON.parse(h.calls.at(-1).options.body);
  assert.ok(body.observed > Date.now() + 500000); assert.equal(h.window.homelabContinue.list().some(item => item.card === 'tv_42'), false);
});

test('a record whose zero position the server omitted still shadows older native progress', async t => {
  const {position, ...rest} = saved;
  const h = await loaded(t, [rest]);
  h.syncRows([native({season: 1, episode: 1}, {hash: '9', watched_at: 500, position: 40})]);
  assert.equal(h.window.homelabContinue.list().length, 0);
});
