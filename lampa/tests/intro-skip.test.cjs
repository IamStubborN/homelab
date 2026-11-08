const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'intro-skip.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function bus() {
  const handlers = {};
  return {follow(name, fn) { (handlers[name] ||= []).push(fn); }, send(name, value) { for (const fn of handlers[name] || []) fn(value); }};
}

function lampa(t, answers = {}) {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const events = bus(), requests = [], plays = [], loading = [];
  let playlist = [];
  const L = {
    Player: {listener: events, play(data) {
      let run = true;
      events.send('create', {data, abort: () => { run = false; }});
      if (!run) return;
      plays.push(JSON.parse(JSON.stringify(data.segments || null)));
      events.send('start', data);
    }},
    PlayerPlaylist: {get: () => playlist},
    Loading: {start(cancel) { loading.push('start'); L.cancel = cancel; }, stop() { loading.push('stop'); }},
  };
  const window = {Lampa: L, AbortController, fetch(url) {
    requests.push(url);
    const host = Object.keys(answers).find(prefix => url.startsWith(prefix));
    const body = host ? answers[host] : null;
    return Promise.resolve({ok: !!body, json: () => Promise.resolve(typeof body === 'function' ? body(url) : body)});
  }};
  vm.runInNewContext(source, {window, Lampa: L, setTimeout, clearTimeout, Date, Promise, Object, Array, Math, isFinite, JSON});
  return {L, window, requests, plays, loading, setPlaylist: list => { playlist = list; }};
}

const show = {id: 1429, name: 'Fictional Show', original_name: 'Fictional Show', genre_ids: [16], original_language: 'ja'};
const INTRODB = 'https://api.theintrodb.org/', ANIZIP = 'https://api.ani.zip/', ANISKIP = 'https://api.aniskip.com/';

test('an episode start waits for TheIntroDB and plays with its intro, recap and credits', async t => {
  const h = lampa(t, {[INTRODB]: {intro: [{start_ms: 123435, end_ms: 215464}], recap: [{start_ms: null, end_ms: 23000}],
    credits: [{start_ms: 1435007, end_ms: null}], preview: [{start_ms: 1432000, end_ms: null}]}});
  h.L.Player.play({url: 'video-1', card: show, season: 1, episode: 1});
  assert.equal(h.plays.length, 0, 'the start is held for the lookup');
  assert.match(h.requests[0], /tmdb_id=1429&season=1&episode=1$/);
  await flush(); await flush();
  assert.deepEqual(h.plays[0], {ad: [], skip: [{start: 0, end: 23}, {start: 123.4, end: 215.5}, {start: 1432, end: 86400}]});
  assert.deepEqual(h.loading, ['start', 'stop']);
});

test('a slow database never holds the start for more than 1.5 seconds, and the answer is kept', async t => {
  let release;
  const h = lampa(t, {[INTRODB]: () => new Promise(resolve => { release = resolve; })});
  h.L.Player.play({url: 'video-2', card: show, season: 1, episode: 2});
  t.mock.timers.tick(1500);
  assert.deepEqual(h.plays, [null]);
  await flush(); release({intro: [{start_ms: 60000, end_ms: 150000}]}); await flush(); await flush();
  h.L.Player.play({url: 'video-2', card: show, season: 1, episode: 2});
  assert.deepEqual(h.plays[1], {ad: [], skip: [{start: 60, end: 150}]}, 'a later start uses the cached answer at once');
  assert.equal(h.requests.length, 1);
});

test('anime without TheIntroDB data falls back to AniSkip only for an episode ani.zip maps exactly', async t => {
  const h = lampa(t, {[INTRODB]: {}, [ANIZIP]: {mappings: {mal_id: 21}, episodes: {7: {seasonNumber: 1, episodeNumber: 7}}},
    [ANISKIP]: {found: true, results: [{interval: {startTime: 13.891, endTime: 123.834}, skipType: 'op'}]}});
  h.L.Player.play({url: 'v7', card: show, season: 1, episode: 7});
  for (let i = 0; i < 6; i++) await flush();
  assert.match(h.requests[2], /skip-times\/21\/7\?/);
  assert.deepEqual(h.plays[0], {ad: [], skip: [{start: 13.9, end: 123.8}]});
  h.L.Player.play({url: 'v8', card: show, season: 1, episode: 8});
  for (let i = 0; i < 6; i++) await flush();
  assert.deepEqual(h.plays[1], null, 'an unmapped episode is not guessed');
  assert.equal(h.requests.filter(url => url.startsWith(ANIZIP)).length, 1, 'the mapping is fetched once per show');
});

test('Back on the loading layer cancels the held start', async t => {
  const h = lampa(t, {[INTRODB]: () => new Promise(() => {})});
  h.L.Player.play({url: 'v', card: show, season: 1, episode: 3});
  h.L.cancel(); t.mock.timers.tick(2000);
  assert.equal(h.plays.length, 0);
});

test('movies, torrents and provider segments start at once', async t => {
  const h = lampa(t, {[INTRODB]: {intro: [{start_ms: 1000, end_ms: 9000}]}});
  h.L.Player.play({url: 'm', card: {id: 5, title: 'Film', original_title: 'Film'}});
  h.L.Player.play({url: 'p', card: show, season: 1, episode: 4, segments: {skip: [{start: 1, end: 5}]}});
  h.L.Player.play({url: 't', card: show, season: 1, episode: 5, torrent_hash: 'abc'});
  assert.equal(h.plays.length, 3);
  assert.deepEqual(h.plays[1], {skip: [{start: 1, end: 5}]});
  assert.equal(h.requests.length, 1, 'only the torrent episode is looked up, for its next start');
});

test('the next episode is looked up while the current one plays', async t => {
  const h = lampa(t, {[INTRODB]: url => ({intro: [{start_ms: 30000, end_ms: 120000}], url})});
  h.setPlaylist([{season: 1, episode: 1, url: 'a'}, {season: 1, episode: 2, url: 'b'}]);
  h.L.Player.play({url: 'a', card: show, season: 1, episode: 1});
  await flush(); await flush();
  t.mock.timers.tick(20000);
  assert.match(h.requests[1], /season=1&episode=2$/);
  await flush(); await flush();
  h.L.Player.play({url: 'b', card: show, season: 1, episode: 2});
  assert.deepEqual(h.plays[1], {ad: [], skip: [{start: 30, end: 120}]}, 'no wait for the next episode');
});

test('SkipDB answers by IMDb id from Lampac when TheIntroDB has nothing', async t => {
  const h = lampa(t, {[INTRODB]: {}, 'https://lampac.test/externalids': {imdb_id: 'tt0000001'},
    'https://api.skipdb.tv/': {segments: {intro: {start_ms: 193000, end_ms: 283000}, recap: null, outro: {start_ms: 1276000, end_ms: null}, preview: null}}});
  h.window.HomelabSync = {url: path => 'https://lampac.test' + path + '?uid=u1'};
  const film = Object.assign({}, show, {genre_ids: []});
  h.L.Player.play({url: 's', card: film, season: 2, episode: 3});
  for (let i = 0; i < 8; i++) await flush();
  assert.ok(h.requests.includes('https://lampac.test/externalids?uid=u1&id=1429&serial=1'));
  assert.ok(h.requests.includes('https://api.skipdb.tv/api/segments?imdb_id=tt0000001&season=2&episode=3'));
  assert.deepEqual(h.plays[0], {ad: [], skip: [{start: 193, end: 283}, {start: 1276, end: 86400}]});
  h.L.Player.play({url: 's4', card: film, season: 2, episode: 4});
  assert.equal(h.requests.filter(url => url.includes('externalids')).length, 1, 'the IMDb id is looked up once per show');
});

test('TheIntroDB wins over SkipDB when both have timestamps', async t => {
  const h = lampa(t, {[INTRODB]: {intro: [{start_ms: 10000, end_ms: 20000}]}, 'https://api.skipdb.tv/': {segments: {intro: {start_ms: 50000, end_ms: 90000}}}});
  h.L.Player.play({url: 'w', card: Object.assign({imdb_id: 'tt0000002'}, show), season: 1, episode: 9});
  for (let i = 0; i < 6; i++) await flush();
  assert.deepEqual(h.plays[0], {ad: [], skip: [{start: 10, end: 20}]});
});

test('an episode switch inside the player and an external player are never held', async t => {
  const h = lampa(t, {[INTRODB]: () => new Promise(() => {})});
  h.L.Player.play({url: 'n', card: show, season: 1, episode: 10, continue_play: true});
  h.L.Player.play({url: 'x', card: show, season: 1, episode: 11, launch_player: 'android'});
  assert.equal(h.plays.length, 2);
  assert.deepEqual(h.loading, []);
});
