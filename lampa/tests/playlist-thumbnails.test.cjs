const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./ux-harness.cjs');

function setup(t, invalid = false) {
  const h = harness(t), callbacks = [], handlers = [], rendered = [];
  let list = [], index = 0;
  h.L.PlayerPlaylist = {get: () => list, position: () => index, listener: {follow(name, fn) { assert.equal(name, 'set'); handlers.push(fn); }}};
  h.L.Api.seasons = (card, seasons, done) => callbacks.push({card, seasons, done});
  h.L.Player.playlist = value => { list = value; rendered.push(list[index + 1]?.thumbnail); handlers.forEach(fn => fn({playlist: list, position: index})); };
  h.run('plugins/playlist-thumbnails.js');
  const card = {id: 42, name: 'Series', backdrop_path: '/backdrop.jpg', source: 'tmdb'};
  const playlist = [1, 2, 3].map(episode => ({card, season: 1, episode, url: 'media-' + episode, title: 'Episode ' + episode}));
  if (invalid) playlist[1].thumbnail = 'https://images.test/t/p/w300null';
  h.start(playlist[0]); h.L.Player.playlist(playlist); h.tick(0);
  return {...h, callbacks, rendered, playlist, next(value) { index = value; h.start(list[index]); h.L.Player.playlist(list); h.tick(0); }};
}

test('next episode gets a fallback immediately and exact episode artwork updates the native renderer', t => {
  const h = setup(t);
  assert.equal(h.rendered.at(-1), '/image/backdrop.jpg');
  assert.equal(h.callbacks.length, 1);
  h.callbacks[0].done({1: {episodes: [{episode_number: 1, still_path: '/one.jpg'}, {episode_number: 2, still_path: '/two.jpg'}, {episode_number: 3, still_path: '/three.jpg'}]}});
  h.tick(0); assert.equal(h.rendered.at(-1), '/image/two.jpg');
  assert.deepEqual(h.playlist.map(x => x.url), ['media-1', 'media-2', 'media-3']);
  h.next(1); assert.equal(h.callbacks.length, 1); h.tick(0); assert.equal(h.rendered.at(-1), '/image/three.jpg');
});

test('late episode images cannot repaint another playlist or another household profile', t => {
  const h = setup(t), calls = h.rendered.length;
  h.profile('other'); h.callbacks[0].done({1: {episodes: [{episode_number: 2, still_path: '/wrong-profile.jpg'}]}}); h.tick(0);
  assert.equal(h.rendered.length, calls); assert.notEqual(h.playlist[1].thumbnail, '/image/wrong-profile.jpg');
});

test('valid native thumbnails are preserved and empty still metadata does not cause a refresh loop', t => {
  const h = setup(t);
  h.callbacks[0].done({1: {episodes: []}}); h.tick(0);
  h.playlist[2].thumbnail = 'https://images.test/provider.jpg';
  h.next(1); h.tick(0);
  assert.equal(h.rendered.at(-1), 'https://images.test/provider.jpg');
  assert.equal(h.callbacks.length, 1); assert.ok(h.rendered.length < 6);
});

test('native null still placeholders are repaired and closed playback ignores delayed images', t => {
  const h = setup(t, true); assert.equal(h.rendered.at(-1), '/image/backdrop.jpg');
  const count = h.rendered.length; h.destroy();
  h.callbacks[0].done({1: {episodes: [{episode_number: 2, still_path: '/late.jpg'}]}}); h.tick(0);
  assert.equal(h.rendered.length, count); assert.notEqual(h.playlist[1].thumbnail, '/image/late.jpg');
});
