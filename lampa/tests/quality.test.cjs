const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');

const card = {id: 7, name: 'Series', source: 'tmdb'};
function play(h, extra = {}) {
  h.run('mods/HomelabSync/quality.js');
  Object.assign(h.video(), {videoWidth: 1280, videoHeight: 720, paused: false});
  h.start({card, season: 1, episode: 2, homelab_online: {provider: 'phantom', voice: 'Anilibria', season_index: 0},
    quality: {'2160p': '/stream/4k', '720p': '/stream/720'}, url: '/stream/4k', ...extra});
}
// Mock timers run one level of rescheduled timeouts per tick: advance in steps like real time.
const advance = (h, ms) => { for (let at = 0; at < ms; at += 1000) h.tick(1000); };
const posts = h => h.calls.filter(call => call.options.method === 'POST').map(call => JSON.parse(call.options.body));

test('a source that names 4K but plays 720p is reported after 90 s of play at its top quality', t => {
  const h = harness(t); play(h);
  advance(h, 85000); assert.equal(posts(h).length, 0, 'too early to judge');
  advance(h, 10000);
  assert.deepEqual(posts(h), [{card: 'tv_7', provider: 'phantom', season: 1, voice: 'Anilibria', claimed: 2160, measured: 720, source: 'play'}]);
  advance(h, 60000); assert.equal(posts(h).length, 1, 'the same height is sent once');
});

test('a lower quality picked by the user, a pause or a closed player say nothing about the source', t => {
  const lower = harness(t); play(lower, {url: '/stream/720'}); advance(lower, 200000);
  assert.equal(posts(lower).length, 0);
});

test('paused time does not count as played', t => {
  const h = harness(t); play(h); h.video().paused = true; advance(h, 200000);
  assert.equal(posts(h).length, 0);
  h.destroy(); advance(h, 200000); assert.equal(posts(h).length, 0);
});

test('native online rows show the known real quality instead of the claim', async t => {
  const h = harness(t); h.run('mods/HomelabSync/quality.js');
  const row = h.window.$('<div class="online-prestige"></div>'), badge = h.window.$('<div class="online-prestige__quality"></div>');
  row.append(badge); badge.text('2160p');
  h.window.HomelabQuality.decorate(card, 'phantom', {voice_name: 'Anilibria'}, {season: 1, episode: 2}, row);
  const read = h.calls.find(call => /\/homelab-sync\/quality\?/.test(call.url));
  assert.match(read.url, /card=tv_7/);
  read.finish({version: 1, rows: {'phantom|1|anilibria': {height: 720, claimed: 2160, source: 'play'}}, providers: {}}); await flush();
  assert.equal(badge.text(), '720p · заявлено 4K');
});

test('a provider is doubted after inflating at least a third of three checked rows', t => {
  const h = harness(t); h.run('mods/HomelabSync/quality.js');
  const Q = h.window.HomelabQuality;
  assert.equal(Q.doubtful({providers: {phantom: {total: 3, inflated: 1}}}, 'Phantom'), true);
  assert.equal(Q.doubtful({providers: {phantom: {total: 2, inflated: 2}}}, 'phantom'), false, 'too few checks');
  assert.equal(Q.doubtful({providers: {phantom: {total: 4, inflated: 1}}}, 'phantom'), false);
});

test('a url that matches no quality entry may be any quality and is not reported', t => {
  const h = harness(t); play(h, {url: '/proxy/unknown'}); advance(h, 200000);
  assert.equal(posts(h).length, 0);
});
