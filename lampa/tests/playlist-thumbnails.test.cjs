const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./ux-harness.cjs');

function bus() {
  const handlers = {};
  return {follow(name, fn) { (handlers[name] ||= []).push(fn); }, send(name, value = {}) { for (const fn of [...(handlers[name] || [])]) fn(value); }};
}

// Models the native Lampa player/playlist ordering of the deployed client:
// the playlist module's start listener runs before the player marks itself opened,
// destroy empties the playlist, and the native "select" flow is destroy -> play -> set(saved).
function lampa(t, options = {}) {
  const h = harness(t), playerEvents = bus(), playlistEvents = bus(), lookups = [], renders = [];
  let opened = false, work = null, list = [], current = '', position = 0;
  function active() {
    const found = list.find(item => item.url === current) || (work && list.find(item => item.url === work.url)) ||
      (work && list.find(item => item.episode === work.episode && item.season === work.season));
    if (found) position = list.indexOf(found);
  }
  function set(value) { list = value; active(); playlistEvents.send('set', {playlist: list, position}); }
  h.L.PlayerPlaylist = {listener: playlistEvents, get: () => list, position: () => position, set, url: value => { current = value; }};
  h.L.Player = {listener: playerEvents, opened: () => opened, playdata: () => work, playlist: set};
  playerEvents.follow('start', data => { current = data.url; set(data.playlist && data.playlist.length ? data.playlist : list); });
  playerEvents.follow('destroy', () => { current = ''; list = []; position = 0; });
  playerEvents.follow('start', () => { opened = true; });
  // Native Next renderer: redraws on every set.
  playlistEvents.follow('set', e => { const next = e.playlist[e.position + 1]; if (next) renders.push(next.thumbnail); });
  h.L.Api.seasons = (card, seasons, done) => lookups.push({card, seasons, done});
  h.run('plugins/playlist-thumbnails.js');
  const card = options.card || {id: 42, name: 'Fictional Series', backdrop_path: '/backdrop.jpg', source: 'tmdb'};
  const playlist = [1, 2, 3, 4].map(episode => ({season: 1, episode, url: 'media-' + episode, title: 'Episode ' + episode, card}));
  const model = {
    ...h, lookups, renders, playlist, position: () => position,
    play(data) { work = data; playerEvents.send('start', data); playerEvents.send('ready', data); },
    close() { work = false; opened = false; playerEvents.send('destroy'); },
    select(index) { const saved = list; model.close(); model.play(playlist[index]); set(saved); h.tick(0); },
    lampacStart(index = 0) { const first = playlist[index]; first.playlist = playlist; model.play(first); set(playlist); h.tick(0); },
    stills(at, values) { lookups[at].done({1: {episodes: values.map(([episode_number, still_path]) => ({episode_number, still_path}))}}); h.tick(0); },
  };
  return model;
}

const all = [[1, '/one.jpg'], [2, '/two.jpg'], [3, '/three.jpg'], [4, '/four.jpg']];

test('a fast still replaces the missing thumbnail with a single native re-render and no backdrop flash', t => {
  const h = lampa(t);
  h.lampacStart();
  assert.equal(h.lookups.length, 1);
  assert.equal(JSON.stringify(h.lookups[0].card), JSON.stringify({id: 42, source: 'tmdb'}));
  const before = h.renders.length;
  h.tick(200); h.stills(0, all);
  assert.equal(h.renders.length, before + 1);
  assert.equal(h.renders.at(-1), '/image/two.jpg');
  assert.ok(!h.renders.includes('/image/backdrop.jpg'));
  assert.deepEqual(h.playlist.map(x => x.url), ['media-1', 'media-2', 'media-3', 'media-4']);
  assert.equal(h.position(), 0);
});

test('the first set happens before the player is opened, so the ready path decorates', t => {
  const h = lampa(t);
  const first = h.playlist[0]; first.playlist = h.playlist;
  h.play(first);
  assert.equal(h.lookups.length, 0);
  h.tick(0);
  assert.equal(h.lookups.length, 1);
  h.stills(0, all);
  assert.equal(h.renders.at(-1), '/image/two.jpg');
});

test('a slow still shows a provisional backdrop and still applies when it arrives before the Lampa timeout', t => {
  const h = lampa(t);
  h.lampacStart();
  h.tick(2000);
  assert.equal(h.renders.at(-1), '/image/backdrop.jpg');
  h.tick(6000);
  h.stills(0, all);
  assert.equal(h.renders.at(-1), '/image/two.jpg');
  assert.equal(h.playlist[1].thumbnail, '/image/two.jpg');
});

test('episode switches reuse season metadata across the native destroy/start/set sequence', t => {
  const h = lampa(t);
  h.lampacStart(); h.stills(0, all);
  h.select(1);
  assert.equal(h.position(), 1);
  assert.equal(h.lookups.length, 1);
  assert.equal(h.renders.at(-1), '/image/three.jpg');
  h.select(2);
  assert.equal(h.lookups.length, 1);
  assert.equal(h.renders.at(-1), '/image/four.jpg');
});

test('empty metadata falls back to the backdrop once without refresh loops or repeated lookups', t => {
  const h = lampa(t);
  h.lampacStart(); h.stills(0, []);
  assert.equal(h.renders.at(-1), '/image/backdrop.jpg');
  const count = h.renders.length;
  h.tick(20000);
  assert.equal(h.renders.length, count);
  h.select(1);
  assert.equal(h.lookups.length, 1);
  assert.equal(h.renders.at(-1), '/image/backdrop.jpg');
});

test('valid native thumbnails are preserved and native null placeholders are repaired', t => {
  const h = lampa(t);
  h.playlist[1].thumbnail = 'https://images.example/t/p/w300null';
  h.playlist[2].thumbnail = 'https://images.example/provider.jpg';
  h.lampacStart(); h.stills(0, all);
  assert.equal(h.renders.at(-1), '/image/two.jpg');
  h.select(1);
  assert.equal(h.renders.at(-1), 'https://images.example/provider.jpg');
  assert.equal(h.playlist[2].thumbnail, 'https://images.example/provider.jpg');
});

test('non-TMDB cards look up stills by tmdb_id', t => {
  const h = lampa(t, {card: {id: 777, tmdb_id: 42, name: 'Fictional Series', source: 'catalog', backdrop_path: '/backdrop.jpg'}});
  h.lampacStart();
  assert.equal(JSON.stringify(h.lookups[0].card), JSON.stringify({id: 42, source: 'tmdb'}));
});

test('non-TMDB cards without tmdb_id skip the lookup and keep only the backdrop', t => {
  const h = lampa(t, {card: {id: 777, name: 'Fictional Series', source: 'catalog', backdrop_path: '/backdrop.jpg'}});
  h.lampacStart();
  assert.equal(h.lookups.length, 0);
  assert.equal(h.renders.at(-1), '/image/backdrop.jpg');
});

test('string item cards fall back to the playing card', t => {
  const h = lampa(t);
  const card = h.playlist[0].card;
  h.playlist.forEach(item => { item.card = 'tv_42'; });
  h.playlist[0].card = card;
  h.lampacStart();
  assert.equal(h.lookups.length, 1);
});

test('late stills cannot repaint after a profile change', t => {
  const h = lampa(t);
  h.lampacStart();
  const count = h.renders.length;
  h.profile('other'); h.stills(0, all); h.tick(20000);
  assert.equal(h.renders.length, count);
  assert.notEqual(h.playlist[1].thumbnail, '/image/two.jpg');
});

test('late stills cannot repaint after the player closes', t => {
  const h = lampa(t);
  h.lampacStart();
  const count = h.renders.length;
  h.close(); h.stills(0, all); h.tick(20000);
  assert.equal(h.renders.length, count);
});

test('a known season map fills every episode, so episode switches draw the still with no extra re-set', t => {
  const h = lampa(t);
  h.lampacStart(); h.stills(0, all);
  assert.deepEqual(h.playlist.map(x => x.thumbnail), ['/image/one.jpg', '/image/two.jpg', '/image/three.jpg', '/image/four.jpg']);
  const before = h.renders.length;
  h.select(1);
  assert.deepEqual(h.renders.slice(before), ['/image/three.jpg']);
  h.tick(5000);
  assert.equal(h.renders.length, before + 1);
});

test('a still arriving after the safety timeout replaces the backdrop on every row', t => {
  const h = lampa(t);
  h.lampacStart(); h.tick(16000);
  assert.equal(h.renders.at(-1), '/image/backdrop.jpg');
  h.stills(0, all);
  assert.equal(h.renders.at(-1), '/image/two.jpg');
  assert.ok(h.playlist.every(x => x.homelab_thumbnail === 'still'));
});

test('a miss is re-queried after its TTL and earlier backdrop rows are replaced', t => {
  const h = lampa(t);
  h.lampacStart(); h.stills(0, []);
  assert.equal(h.playlist[1].thumbnail, '/image/backdrop.jpg');
  h.tick(5 * 60 * 1000 + 1);
  h.select(1);
  assert.equal(h.lookups.length, 2);
  h.stills(1, all);
  assert.equal(h.playlist[1].thumbnail, '/image/two.jpg');
  assert.equal(h.renders.at(-1), '/image/three.jpg');
});

test('found season maps expire so airing shows pick up new stills', t => {
  const h = lampa(t);
  h.lampacStart(); h.stills(0, [[1, '/one.jpg'], [2, '/two.jpg']]);
  h.tick(6 * 60 * 60 * 1000 + 1);
  h.select(1);
  assert.equal(h.lookups.length, 2);
  h.stills(1, all);
  assert.equal(h.renders.at(-1), '/image/three.jpg');
});

test('the season cache evicts the least recently used entry beyond 32 seasons', t => {
  const h = lampa(t);
  h.lampacStart(); h.stills(0, all);
  const show = id => [1, 2].map(episode => ({card: {id, name: 'Show ' + id, source: 'tmdb'}, season: 1, episode, url: 'show-' + id + '-' + episode}));
  for (let id = 100; id < 132; id++) { h.L.Player.playlist(show(id)); h.stills(h.lookups.length - 1, [[2, '/s' + id + '.jpg']]); }
  assert.equal(h.lookups.length, 33);
  h.L.Player.playlist(show(100)); h.tick(0);
  assert.equal(h.lookups.length, 33);
  h.L.Player.playlist(show(42)); h.tick(0);
  assert.equal(h.lookups.length, 34);
});

test('a profile change drops a pending lookup and queries again for the new profile', t => {
  const h = lampa(t);
  h.lampacStart();
  h.profile('other');
  h.L.Player.playlist(h.playlist); h.tick(0);
  assert.equal(h.lookups.length, 2);
  h.stills(0, [[2, '/stale.jpg']]);
  assert.notEqual(h.playlist[1].thumbnail, '/image/stale.jpg');
  h.stills(1, all);
  assert.equal(h.renders.at(-1), '/image/two.jpg');
});

test('repeated re-sets during a stuck lookup still produce a single still repaint', t => {
  const h = lampa(t);
  h.lampacStart();
  for (let i = 0; i < 20; i++) h.L.Player.playlist(h.playlist);
  const before = h.renders.length;
  h.stills(0, all);
  assert.equal(h.renders.length, before + 1);
  assert.equal(h.lookups.length, 1);
});

test('the native playlist list shows progress, a watched mark and «Сейчас» on episode stills', t => {
  const h = lampa(t);
  h.lampacStart(); h.stills(0, all);
  const list = h.L.PlayerPlaylist.get();
  list[0].selected = true; list[0].timeline = {percent: 10, time: 12, duration: 120};
  list[1].timeline = {percent: 95, time: 1140, duration: 1200};
  list[2].timeline = {percent: 50, time: 600, duration: 1200};
  h.video().currentTime = 60; h.video().duration = 120;
  const active = {title: 'Плейлист', items: list};
  h.L.Select.listener.send('preshow', {active});
  assert.equal(typeof active.onDraw, 'function');
  const rows = list.map(entry => { const row = h.window.$('<div class="selectbox-item selector"></div>'); active.onDraw(row, entry); return row; });
  const parts = row => ({state: row.find('.selectbox-item__title').children[0], icon: row.find('.selectbox-item__icon')});
  const current = parts(rows[0]);
  assert.ok(rows[0].hasClass('homelab-playlist-item--current'));
  assert.equal(current.state.children[0].text(), 'Сейчас'); assert.equal(current.state.children[1].text(), ' осталось 1 мин');
  assert.equal(current.icon.children[0].find('div').attrs['style:width'], '50%', 'current progress is live from the video');
  assert.ok(rows[1].hasClass('homelab-playlist-item--watched'));
  assert.equal(parts(rows[1]).state.children[0].text(), 'Просмотрено');
  assert.ok(parts(rows[1]).icon.children.some(child => child.classes.has('homelab-playlist-done')));
  assert.equal(parts(rows[2]).state.children[0].text(), 'осталось 10 мин');
  assert.equal(parts(rows[3]).state, undefined, 'an unstarted episode stays clean');
});

test('other selects and a closed player are never decorated', t => {
  const h = lampa(t);
  const other = {title: 'Другое', items: [{title: 'x'}]};
  h.L.Select.listener.send('preshow', {active: other}); assert.equal(other.onDraw, undefined);
  h.lampacStart(); const list = h.L.PlayerPlaylist.get(); h.close();
  const late = {items: list}; h.L.Select.listener.send('preshow', {active: late}); assert.equal(late.onDraw, undefined);
});

test('the last episode still loads the season stills for the list without a Next card', t => {
  const h = lampa(t);
  h.lampacStart(3);
  assert.equal(h.lookups.length, 1);
  h.stills(0, all);
  assert.equal(h.playlist[0].thumbnail, '/image/one.jpg');
});

test('a Lampac episode started with a quality URL and no numbers is still found as the playing item', t => {
  const h = lampa(t), card = h.playlist[0].card, nexts = [];
  // Fictional provider without season/episode on its items; the episode plays a quality URL, so the
  // native matcher (url, then numbers where undefined matches undefined) lands on item 0.
  const list = [1, 2, 3, 4].map(n => ({url: 'call-' + n, title: 'Серия ' + n + ' · Name ' + n, card}));
  list[2].url = 'master-3';
  h.L.PlayerPlaylist.listener.follow('set', e => nexts.push(e.playlist[e.position + 1] && e.playlist[e.position + 1].title));
  h.play({url: 'q1080-3', quality: {'1080p': 'q1080-3'}, title: 'Серия 3 · Name 3', card, playlist: list}); h.tick(0);
  assert.equal(h.position(), 2, 'the playing episode is the current item');
  assert.equal(nexts.at(-1), 'Серия 4 · Name 4', 'Next points at the following episode');
  list[0].selected = true;
  h.L.Select.listener.send('preshow', {active: {items: list}});
  assert.deepEqual(list.map(entry => !!entry.selected), [false, false, true, false], 'the playlist opens on the playing episode');
});

test('the Next card shows the episode name without the number prefix', t => {
  const h = lampa(t);
  const title = h.L.PlayerPanel.render().find('.player-next__episode-title');
  title.text('Серия 33 · Когда-нибудь');
  h.lampacStart(); h.tick(0);
  assert.equal(title.text(), 'Когда-нибудь');
});

test('the playing item is found through its quality map when titles do not help', t => {
  const h = lampa(t), card = h.playlist[0].card;
  const list = [1, 2, 3].map(n => ({url: 'master-' + n, title: 'Same', card}));
  h.play({url: 'q1080-2', quality: {'1080p': 'q1080-2', '720p': 'master-2'}, title: 'Other', card, playlist: list}); h.tick(0);
  assert.equal(h.position(), 1);
});

test('the first opening sizes the playlist window before Lampa scrolls to the playing episode', t => {
  const h = lampa(t), sized = [];
  // Lampa scrolls to the selected row in toggle(), then sets the window height in Layer.update():
  // with no height yet the first opening clamped the scroll to the top of the list.
  h.L.Layer.update = where => sized.push(where);
  h.lampacStart(); const list = h.L.PlayerPlaylist.get(), html = h.window.$('<div class="selectbox"></div>');
  const active = {items: list};
  h.L.Select.listener.send('preshow', {active});
  h.L.Select.listener.send('fullshow', {active, html});
  assert.equal(sized.length, 1); assert.equal(sized[0], html);
  h.L.Select.listener.send('fullshow', {active: {items: [{title: 'x'}]}, html});
  assert.equal(sized.length, 1, 'other selects are left alone');
});

test('a single-item playlist hides the native playlist button; a series keeps it', t => {
  const h = lampa(t);
  const box = h.L.PlayerPanel.render().find('.player-panel__playlist-buttons');
  h.L.PlayerPlaylist.listener.follow('set', () => {});
  const movie = {url: 'movie', title: 'Fictional Movie', card: {id: 7, title: 'Fictional Movie', source: 'tmdb'}};
  box.removeClass('hide'); h.play({...movie, playlist: [movie]}); h.tick(0);
  assert.ok(box.hasClass('hide'), 'a movie has nothing to pick');
  h.close(); box.removeClass('hide'); h.lampacStart();
  assert.ok(!box.hasClass('hide'), 'episodes keep the button');
});
