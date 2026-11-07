const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./ux-harness.cjs');
const hash = 'b'.repeat(40);

// A media element the way hls.js leaves it before MANIFEST_LOADED: paused,
// no data. play()/pause() fire events like a browser, time advances in
// 250 ms timeupdate steps.
function realistic(h, video = h.video()) {
  Object.assign(video, {paused: true, readyState: 0, currentTime: 0, seeking: false, ended: false,
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

test('a repeated press inside the guard interval explains why nothing happened', t => {
  const h = harness(t); realistic(h);
  h.L.HomelabGstAudio.retryCurrent = () => false;
  h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  h.videoEvent('error', {fatal: true});
  const {retry} = buttons(h);
  retry.trigger('hover:enter'); retry.trigger('hover:enter');
  assert.equal(h.notices.length, 2); assert.notEqual(h.notices[0], h.notices[1]);
});
