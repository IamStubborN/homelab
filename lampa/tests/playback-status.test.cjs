const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./ux-harness.cjs');
const hash = 'b'.repeat(40);

// A media element the way hls.js leaves it before MANIFEST_LOADED: paused,
// no data. play()/pause() fire events like a browser, time advances in
// 250 ms timeupdate steps.
function realistic(h, video = h.video()) {
  Object.assign(video, {paused: true, readyState: 0, currentTime: 0, duration: NaN, seeking: false, ended: false,
    play() { if (!video.paused) return; video.paused = false; video.fire('play'); if (video.readyState < 3) video.fire('waiting'); },
    pause() { if (video.paused) return; video.paused = true; video.fire('pause'); },
    data() { video.readyState = 4; video.fire('canplay'); if (!video.paused) video.fire('playing'); },
    advance(seconds) { for (let i = 0; i < seconds * 4; i++) { video.currentTime += .25; video.fire('timeupdate'); h.tick(250); } },
    seek(to) { video.seeking = true; video.currentTime = to; video.readyState = 1; video.fire('seeking'); if (!video.paused) video.fire('waiting'); }});
  return video;
}
// Upstream Player's own error listener is registered before any plugin.
function upstreamReserve(h) {
  h.L.PlayerVideo.listener.follow('error', event => {
    const work = h.work();
    if (event.fatal && work && work.url_reserve) { h.videoEvent('destroy', {savemeta: true}); realistic(h, h.replaceVideo()); delete work.url_reserve; }
  });
}
const buttons = h => ({retry: h.elements.find(e => e.classes.has('homelab-playback-retry')), source: h.elements.find(e => e.classes.has('homelab-playback-source'))});
const shown = node => !node.hasClass('hide');

test('a GST manifest that never arrives offers recovery after thirty seconds although the video is still paused', t => {
  const h = harness(t); realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const {retry} = buttons(h);
  h.tick(29000); assert.ok(!shown(retry));
  h.tick(1000); assert.ok(shown(retry), 'never-started loading is a stall');
});

test('a user pause is never a stall, while a slow start after the pause timer still is', t => {
  const h = harness(t); const video = realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const {retry} = buttons(h);
  video.play(); video.data(); video.advance(2); video.pause();
  h.tick(120000); assert.ok(!shown(retry), 'paused by the user');
  video.play(); video.readyState = 2; video.fire('waiting'); h.tick(30000);
  assert.ok(shown(retry), 'resuming re-arms the stall timer');
  video.data(); assert.ok(!shown(retry));
});

test('autoplay blocked with playable data is not a stall', t => {
  const h = harness(t); const video = realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  video.readyState = 4; video.fire('canplay'); h.tick(90000);
  assert.ok(!shown(buttons(h).retry));
});

test('a seek that never completes offers recovery and transfers the seek target', t => {
  const h = harness(t), calls = [];
  h.window.HomelabSources = {recover: (...args) => { calls.push(args); return true; }};
  const video = realistic(h); h.run('plugins/playback-status.js'); h.start({card: {id: 7}, homelab_torrent_hash: hash});
  const {retry, source} = buttons(h);
  video.play(); video.data(); video.advance(3);
  video.seek(900); h.tick(29000); assert.ok(!shown(retry));
  h.tick(1000); assert.ok(shown(retry) && shown(source), 'stuck seeking is a stall');
  source.trigger('hover:enter'); assert.equal(calls[0][1].position, 900);
});

test('a completed seek resumes normally without recovery actions', t => {
  const h = harness(t); const video = realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  video.play(); video.data(); video.advance(2);
  video.seek(60); h.tick(5000); video.seeking = false; video.fire('seeked'); video.data(); video.advance(40);
  assert.ok(!shown(buttons(h).retry));
});

test('normal playback progress hides actions shown by a stall without a playing event', t => {
  const h = harness(t); const video = realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const {retry} = buttons(h);
  video.play(); h.tick(30000); assert.ok(shown(retry));
  video.readyState = 4; video.advance(1); assert.ok(!shown(retry), 'small timeupdate steps count as progress');
});

test('an early failure of a timeline-resumed episode keeps the saved position for another source', t => {
  const h = harness(t), calls = [];
  h.window.HomelabSources = {recover: (...args) => { calls.push(args); return true; }};
  realistic(h); h.run('plugins/playback-status.js');
  h.start({card: {id: 7}, homelab_torrent_hash: hash, timeline: {hash: 'x', time: 600, percent: 40}});
  h.videoEvent('error', {fatal: true, error: 'manifestLoadError'});
  buttons(h).source.trigger('hover:enter'); assert.equal(calls[0][1].position, 600);
});

test('the timeline fallback follows Lampa resume rules and stays clear of the end', t => {
  const cases = [
    [{time: 600, percent: 40}, {}, 600],
    [{time: 600, percent: 95}, {}, 0],
    [{time: 8, percent: 1}, {}, 0],
    [{time: 600, percent: 40, continued_bloc: true}, {}, 0],
    [{time: 600, percent: 40}, {player_timecode: 'again'}, 0],
    [{time: 1195, percent: 89, duration: 1200}, {}, 1185],
    [{percent: 50, duration: 1200}, {}, 600],
  ];
  for (const [timeline, settings, expected] of cases) {
    const h = harness(t), calls = [];
    for (const [name, value] of Object.entries(settings)) h.storage.set(name, value);
    h.window.HomelabSources = {recover: (...args) => { calls.push(args); return true; }};
    realistic(h); h.run('plugins/playback-status.js');
    h.start({card: {id: 7}, homelab_torrent_hash: hash, timeline: {hash: 'x', ...timeline}});
    h.videoEvent('error', {fatal: true});
    buttons(h).source.trigger('hover:enter');
    assert.equal(calls[0][1].position, expected, JSON.stringify([timeline, settings]));
    t.mock.timers.reset();
  }
});

test('a user pause on a player without pause events or readyState is not a stall', t => {
  const h = harness(t);
  // Tizen AVPlay wrapper: custom addEventListener only, paused from the player state.
  const video = h.video(); delete video.readyState; delete video.removeEventListener; Object.assign(video, {currentTime: 0, paused: false});
  h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const {retry} = buttons(h);
  h.tick(30000); assert.ok(shown(retry), 'a Tizen start that never plays is a stall');
  video.fire('playing'); for (let i = 0; i < 8; i++) { video.currentTime += .25; video.fire('timeupdate'); }
  assert.ok(!shown(retry));
  video.paused = true; h.tick(120000); assert.ok(!shown(retry), 'paused after playback started');
  assert.doesNotThrow(() => { h.videoEvent('destroy', {savemeta: true}); h.destroy(); });
});

test('Retry stays hidden while the GST plugin recovers on its own, Other source does not', t => {
  const h = harness(t); h.window.HomelabSources = {recover: () => true};
  const video = realistic(h); h.run('plugins/playback-status.js'); h.start({card: {id: 7}, homelab_torrent_hash: hash});
  const {retry, source} = buttons(h);
  video.play(); video.data(); video.advance(2);
  h.phase('recovering'); video.readyState = 2; video.fire('waiting'); h.tick(30000);
  assert.ok(!shown(retry) && shown(source));
  h.phase('failed'); assert.ok(shown(retry) && shown(source));
});

test('retry is offered only when the GST plugin can retry the work', t => {
  const h = harness(t); realistic(h);
  let possible = false; h.L.HomelabGstAudio.canRetry = work => possible && work === h.work();
  h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const {retry} = buttons(h);
  h.videoEvent('error', {fatal: true}); assert.ok(!shown(retry), 'plain stream torrent cannot be retried');
  h.destroy(); possible = true; realistic(h); h.start({homelab_torrent_hash: hash});
  h.videoEvent('error', {fatal: true}); assert.ok(shown(retry));
});

test('Lampa switching to its reserve URL is not reported as a failure', t => {
  const h = harness(t); upstreamReserve(h); realistic(h); h.run('plugins/playback-status.js');
  h.start({card: {id: 7}, homelab_online: {provider: 'one', voice: 'A'}, url_reserve: 'https://media.example/reserve.m3u8'});
  h.window.HomelabSources = {recover: () => true};
  const {retry} = buttons(h);
  h.videoEvent('error', {fatal: true, error: 'manifestLoadError'}); h.tick(0);
  assert.ok(!shown(retry), 'the reserve is loading');
  h.videoEvent('error', {fatal: true, error: 'manifestLoadError'});
  assert.ok(shown(retry), 'a failure of the reserve itself is fatal');
});

test('hiding a focused recovery button moves focus to play/pause', t => {
  const h = harness(t); const video = realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const {retry} = buttons(h), playpause = h.L.PlayerPanel.render().find('.player-panel__playpause');
  let focused = 0; playpause.on('hover:focus', () => { focused++; });
  h.videoEvent('error', {fatal: true}); retry.addClass('focus');
  video.data(); assert.ok(!shown(retry)); assert.equal(focused, 1);
  h.videoEvent('error', {fatal: true}); retry.removeClass('focus'); video.fire('playing'); assert.equal(focused, 1, 'unfocused buttons leave focus alone');
});

test('a failed retry can be pressed again, a running one explains why a repeat is ignored', t => {
  const h = harness(t); realistic(h);
  let works = false; h.L.HomelabGstAudio.retryCurrent = () => works;
  h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  h.videoEvent('error', {fatal: true});
  const {retry} = buttons(h);
  retry.trigger('hover:enter'); retry.trigger('hover:enter');
  assert.equal(h.notices.length, 2); assert.equal(h.notices[0], h.notices[1], 'nothing is running after a failed attempt');
  works = true; retry.trigger('hover:enter'); assert.equal(h.notices.length, 2);
  h.videoEvent('error', {fatal: true}); retry.trigger('hover:enter');
  assert.equal(h.notices.length, 3); assert.match(h.notices[2], /уже выполняется/);
});

// ---- State card
const card = h => {
  const node = cls => h.elements.find(e => e.classes.has('homelab-playback-card' + cls));
  return {root: node(''), title: node('__title'), detail: node('__detail'), hint: node('__hint'), retry: node('__retry'), source: node('__source')};
};
const focusLog = h => { const log = [], original = h.L.Controller.collectionFocus; h.L.Controller.collectionFocus = (node, html) => { log.push(node); original(node, html); }; return log; };
const controllerName = h => h.L.Controller.enabled().name;

test('a short buffering blip never shows the card, a longer one counts seconds and hides when playback resumes', t => {
  const h = harness(t); const video = realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  video.play(); video.data(); video.advance(2);
  const c = card(h); assert.ok(!shown(c.root));
  video.readyState = 2; video.fire('waiting'); h.tick(600); assert.ok(!shown(c.root), 'debounced');
  video.data(); h.tick(2000); assert.ok(!shown(c.root));
  video.readyState = 2; video.fire('waiting'); h.tick(700); assert.ok(shown(c.root));
  assert.equal(c.title.text(), 'Буферизация… 1 с');
  h.tick(3000); assert.equal(c.title.text(), 'Буферизация… 3 с');
  assert.ok(!shown(c.retry) && !shown(c.source), 'no actions before a stall');
  video.data(); assert.ok(!shown(c.root), 'resumed playback hides at once');
});

test('preparation shows a live timer and after twenty seconds suggests another source without a stall', t => {
  const h = harness(t), calls = [];
  h.window.HomelabSources = {recover: (...args) => { calls.push(args); return true; }};
  realistic(h); h.run('plugins/playback-status.js'); const log = focusLog(h);
  h.start({card: {id: 7}, homelab_torrent_hash: hash});
  const c = card(h), panelButtons = buttons(h);
  h.tick(2400); assert.ok(!shown(c.root), "Lampa's loader covers a fast start");
  h.tick(100); assert.ok(shown(c.root)); assert.equal(c.title.text(), 'Подготовка видео… 2 с');
  h.tick(5500); assert.equal(c.title.text(), 'Подготовка видео… 8 с');
  assert.equal(c.detail.text(), 'Подключаемся к раздаче'); assert.ok(!shown(c.hint) && !shown(c.source));
  assert.equal(controllerName(h), 'player', 'nothing to focus yet');
  h.tick(12000);
  assert.match(c.hint.text(), /другой источник/); assert.ok(shown(c.source) && !shown(c.retry));
  assert.ok(shown(panelButtons.source) && !shown(panelButtons.retry), 'the panel offers the same action');
  assert.equal(controllerName(h), 'homelab_playback_card'); assert.equal(log.at(-1), c.source);
  c.retry.trigger('hover:enter'); assert.equal(calls.length, 0, 'retry needs a real stall');
  c.source.trigger('hover:enter'); assert.equal(calls.length, 1); assert.equal(calls[0][2], false);
});

test('playback starting after an escalated preparation removes the suggestion and returns the remote to the player', t => {
  const h = harness(t); h.window.HomelabSources = {recover: () => true};
  const video = realistic(h); h.run('plugins/playback-status.js'); h.start({card: {id: 7}, homelab_torrent_hash: hash});
  h.tick(21000); assert.equal(controllerName(h), 'homelab_playback_card');
  video.play(); video.data();
  assert.ok(!shown(card(h).root) && !shown(buttons(h).source)); assert.equal(controllerName(h), 'player');
});

test('the failure card focuses Retry first, Other source after a retry that failed, and Back only hides the card', t => {
  const h = harness(t); h.window.HomelabSources = {recover: () => true};
  realistic(h); h.run('plugins/playback-status.js'); const log = focusLog(h);
  h.start({card: {id: 7}, homelab_torrent_hash: hash});
  h.videoEvent('error', {fatal: true, error: 'http://private.example/?token=secret'});
  const c = card(h);
  assert.ok(shown(c.root)); assert.equal(c.title.text(), 'Не удалось воспроизвести');
  assert.equal(c.hint.text(), 'Повторите или выберите другой источник');
  assert.ok(![c.title, c.detail, c.hint].some(node => /token|http|Error/.test(node.text())), 'no raw error text');
  assert.ok(shown(c.retry) && shown(c.source)); assert.equal(controllerName(h), 'homelab_playback_card'); assert.equal(log.at(-1), c.retry);
  c.retry.trigger('hover:enter'); assert.equal(h.retryCount(), 1);
  assert.equal(controllerName(h), 'player', 'a running retry leaves the card');
  h.tick(6000); h.videoEvent('error', {fatal: true});
  assert.equal(controllerName(h), 'homelab_playback_card'); assert.equal(log.at(-1), c.source, 'a retry already failed once');
  h.L.Controller.controllers.homelab_playback_card.down(); assert.equal(controllerName(h), 'player_panel');
  h.video().fire('pause'); h.videoEvent('error', {fatal: true}); assert.equal(controllerName(h), 'player_panel', 'the card does not pull the remote back');
  h.L.Controller.toggle('homelab_playback_card');
  let backs = 0; h.L.Controller.back = () => { backs++; };
  h.L.Controller.controllers.homelab_playback_card.back();
  assert.ok(!shown(c.root)); assert.equal(controllerName(h), 'player'); assert.equal(backs, 0, 'once the user moved focus, Back only hides the card');
  assert.ok(shown(buttons(h).retry) && shown(buttons(h).source), 'the panel keeps the actions');
  assert.equal(h.notices.length, 0);
});

test('the card never takes the remote from a menu and left/right move between its actions', t => {
  const h = harness(t); h.window.HomelabSources = {recover: () => true};
  realistic(h); h.run('plugins/playback-status.js'); const log = focusLog(h);
  h.start({card: {id: 7}, homelab_torrent_hash: hash});
  h.L.Controller.toggle('select');
  h.videoEvent('error', {fatal: true}); const c = card(h);
  assert.ok(shown(c.root)); assert.equal(controllerName(h), 'select');
  h.L.Controller.toggle('homelab_playback_card'); assert.equal(log.at(-1), c.retry);
  c.retry.addClass('focus'); h.L.Controller.controllers.homelab_playback_card.right(); assert.equal(log.at(-1), c.source);
  c.retry.removeClass('focus'); c.source.addClass('focus'); h.L.Controller.controllers.homelab_playback_card.right();
  assert.equal(controllerName(h), 'player_panel', 'the last action hands off to the panel');
  h.L.Controller.toggle('homelab_playback_card'); c.source.removeClass('focus'); c.retry.addClass('focus');
  h.L.Controller.controllers.homelab_playback_card.left(); assert.equal(controllerName(h), 'player_panel', 'so does the first');
});

test('a stall card names a stuck seek and a started playback differently', t => {
  const h = harness(t); const video = realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  video.play(); video.data(); video.advance(2);
  video.seek(900); h.tick(30000); assert.equal(card(h).title.text(), 'Перемотка не завершилась');
  assert.equal(card(h).hint.text(), 'Попробуйте повторить');
  video.seeking = false; video.fire('seeked'); video.data();
  video.readyState = 2; video.fire('waiting'); h.tick(30000); assert.equal(card(h).title.text(), 'Воспроизведение остановилось');
});

test('GST recovery shows only while the picture is stuck', t => {
  const h = harness(t); const video = realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  video.play(); video.data(); video.advance(2);
  h.phase('recovering'); h.tick(2000); assert.ok(!shown(card(h).root), 'still playing from the buffer');
  video.readyState = 2; video.fire('waiting'); h.tick(1000); assert.ok(shown(card(h).root));
  assert.match(card(h).title.text(), /^Восстановление… \d с$/);
  video.advance(1); assert.ok(!shown(card(h).root), 'progress without a playing event');
  video.readyState = 2; video.fire('waiting'); h.tick(30000);
  assert.ok(!shown(card(h).retry) && !shown(buttons(h).retry), 'GST is still recovering on its own');
  h.phase('buffered'); video.data(); assert.ok(!shown(card(h).root));
});

test('torrent statistics come from Lampa TorrServer cache only while the card is visible, at most every two seconds', t => {
  const h = harness(t), asked = [];
  h.L.Torserver.url = () => 'https://lampa.test/torrserver';
  h.L.Torserver.cache = (value, ok, fail) => asked.push({value, ok, fail});
  const video = realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  h.tick(2400); assert.equal(asked.length, 0, 'nothing is polled behind a hidden card');
  h.tick(100); assert.equal(asked.length, 1); assert.equal(asked[0].value, hash);
  asked[0].ok({Torrent: {active_peers: 12, download_speed: 3.4 * 1048576}, Readers: [{Reader: 100, End: 110}],
    Pieces: {100: {Completed: true}, 101: {Completed: true}, 102: {Completed: true}, 103: {Completed: true}, 105: {Completed: true}}});
  assert.equal(card(h).detail.text(), 'Торрент: 12 пиров · 3,4 МБ/с · буфер 40%');
  h.tick(2000); assert.equal(asked.length, 2);
  h.tick(2000); assert.equal(asked.length, 2, 'an unanswered request is not repeated at once');
  asked[1].ok({Torrent: {active_peers: 1, download_speed: 300 * 1024}});
  assert.equal(card(h).detail.text(), 'Торрент: 1 пир · 300 КБ/с');
  video.play(); video.data(); const count = asked.length; h.tick(20000);
  assert.equal(asked.length, count, 'polling stops when the card hides');
});

test('online playback shows no torrent statistics', t => {
  const h = harness(t), asked = [];
  h.L.Torserver.url = () => 'https://lampa.test/torrserver'; h.L.Torserver.cache = (...args) => asked.push(args);
  realistic(h); h.run('plugins/playback-status.js'); h.start({card: {id: 7}, homelab_online: {provider: 'one'}});
  h.tick(5000); assert.equal(asked.length, 0); assert.equal(card(h).detail.text(), 'Загружаем видео');
});

test('Back on an automatically focused card hides it and still reaches the player', t => {
  const h = harness(t); h.window.HomelabSources = {recover: () => true};
  realistic(h); h.run('plugins/playback-status.js');
  const backs = []; h.L.Controller.back = () => backs.push(controllerName(h));
  h.start({card: {id: 7}, homelab_torrent_hash: hash});
  h.videoEvent('error', {fatal: true}); assert.equal(controllerName(h), 'homelab_playback_card');
  h.L.Controller.controllers.homelab_playback_card.back();
  assert.ok(!shown(card(h).root)); assert.deepEqual(backs, ['player'], "one Back is the player's Back");
});

test('the card never takes the remote from the panel', t => {
  const h = harness(t); h.window.HomelabSources = {recover: () => true};
  const video = realistic(h); h.run('plugins/playback-status.js'); h.start({card: {id: 7}, homelab_torrent_hash: hash});
  video.play(); video.data(); video.advance(2);
  h.L.PlayerPanel.toggle(); assert.equal(controllerName(h), 'player_panel');
  video.readyState = 2; video.fire('waiting'); h.tick(30000);
  assert.ok(shown(card(h).root) && shown(card(h).retry)); assert.equal(controllerName(h), 'player_panel');
  h.videoEvent('error', {fatal: true}); assert.equal(controllerName(h), 'player_panel');
  assert.ok(shown(buttons(h).retry) && shown(buttons(h).source));
});

test('mid-play buffering keeps the short delay and the card steps aside while a menu is open', t => {
  const h = harness(t); let open = false; h.L.Select.opened = () => open;
  const video = realistic(h); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  video.play(); video.data(); video.advance(2);
  video.readyState = 2; video.fire('waiting'); h.tick(700); assert.ok(shown(card(h).root));
  open = true; h.L.Select.show({items: []}); h.tick(0); assert.ok(!shown(card(h).root));
  h.tick(3000); assert.ok(!shown(card(h).root), 'the timer does not bring it back');
  open = false; h.L.Select.closeAll(); h.tick(0); assert.ok(shown(card(h).root));
});
