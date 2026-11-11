const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');
const hash = 'a'.repeat(40), key = `/previews/${hash}/1/`;
const data = {key, enabled: true, info: {duration: 120, step: 5, version: 1, chapters: [
  {start: 0, end: 8, title: 'OP'}, {start: 8, end: 90, title: 'Opening Scene'}, {start: 90, end: 120, title: 'Ending'},
]}};

test('playback phases never produce popups or raw error text and keep one manual retry', t => {
  const h = harness(t); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const retry = h.elements.find(e => e.classes.has('homelab-playback-retry'));
  h.video().fire('waiting'); h.tick(400); assert.ok(retry.hasClass('hide'));
  h.phase('recovering'); h.tick(400);
  h.videoEvent('error', {fatal: true, error: 'http://private/?token=secret'});
  assert.ok(!retry.hasClass('hide'));
  assert.equal(h.notices.length, 0, 'phase changes never produce popups');
  const text = h.elements.filter(e => [...e.classes].some(name => name.startsWith('homelab-playback-card'))).map(e => e.text()).join(' ');
  assert.match(text, /Не удалось воспроизвести/); assert.doesNotMatch(text, /private|token|secret|http/, 'the status card shows human text only');
  retry.trigger('hover:enter'); assert.equal(h.retryCount(), 1);
  h.destroy(); h.tick(10000); assert.ok(retry.hasClass('hide'));
});

const entry = () => ({card: 'tv_42', title: 'Series', torrent: hash, index: 1, timeline: '123', season: 1, episode: 2, position: 112, duration: 120, observed: Date.now(), tracks: {audio: {title: 'Preferred', language: 'ru'}}});

test('continue loads once for concurrent callers and explicitly resumes high-percent playback with tracks', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  let first = false, second = false;
  h.window.homelabContinue.load(() => { first = true; }); h.window.homelabContinue.load(() => { second = true; });
  // 87.5%: below Lampa's 90% watched mark, so the episode itself resumes.
  assert.equal(h.calls.length, 1); h.calls[0].finish({version: 1, items: [{...entry(), position: 105}]}); await flush();
  assert.ok(first && second); assert.equal(h.window.homelabContinue.list().length, 1);
  h.window.homelabContinue.resume(h.window.homelabContinue.list()[0]);
  h.L.sourceLookup.success({file_stats: [{id: 1, path: 'Series/02.mkv'}]});
  assert.equal(h.select(), null, 'the saved file plays without a picker');
  assert.equal(h.video().currentTime, 105); assert.equal(h.work().timeline.continued, true);
  assert.equal(h.work().homelab_track_preferences.audio.title, 'Preferred');
  assert.ok(!JSON.stringify(h.calls).includes('/gst/'), 'resume persistence must not contain a session URL');
});

test('torrent continue restores the naturally ordered full release and keeps the selected file through GST rewriting', t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  const play = h.L.Player.play;
  h.L.Player.play = work => { work.url = '/gst/session/master.m3u8'; play(work); };
  h.window.homelabContinue.resume({...entry(), index: 77});
  h.L.sourceLookup.success({data: JSON.stringify({movie: {id: 42, name: 'Series', original_name: "Original's series", original_title: "Canonical's series", poster_path: '/canonical.jpg', number_of_seasons: 1}}), file_stats: [
    {id: 23, path: 'Series/S01E10.mkv'}, {id: 77, path: 'Series/S01E02.mkv'}, {id: 41, path: 'Series/S01E01.mkv'},
    {id: 5, path: 'Series/Subs/S01E02.ru.ass'}, {id: 6, path: 'poster.jpg'},
  ]});
  assert.deepEqual(Array.from(h.L.playlistData, work => work.id), [41, 77, 23]);
  assert.equal(h.L.playlistData[1], h.work()); assert.equal(h.work().url, '/gst/session/master.m3u8');
  assert.equal(h.work().timeline.hash, '123'); assert.equal(h.video().currentTime, 112);
  assert.ok(h.work().title.includes('Серия 2')); assert.equal(h.work().subtitles[0].label, 'Subs');
  assert.equal(h.L.playlistData[0].timeline.hash, "Canonical's series:1:1", 'siblings preserve the original canonical title and punctuation used by native parsing');
  assert.equal(h.work().card.poster_path, '/canonical.jpg');
  assert.equal(h.L.playlistData[2].homelab_resume_at, undefined);
  assert.equal(h.calls.length, 0, 'constructing the release must not fetch or probe sibling streams');
  assert.equal(h.notices.length, 0, 'availability checks are silent');
  h.video().currentTime = 40; h.start(h.work());
  assert.equal(h.video().currentTime, 40, 'reselecting the same playlist object does not reuse its original continue point');
});

test('optional metadata timeouts retain selected playback and late responses cannot replace it', t => {
  const h = harness(t); let complete;
  h.L.Api.sources.tmdb.get = (path, params, done) => { complete = done; };
  h.run('mods/HomelabSync/continue.js'); h.window.homelabContinue.resume(entry());
  h.L.sourceLookup.success({file_stats: [{id: 1, path: 'Series/S01E02.mkv'}]});
  h.tick(2000); h.pick(); assert.equal(h.video().currentTime, 112); assert.equal(h.L.playlistData.length, 1);
  const current = h.work(); complete({id: 42, name: 'Series', original_name: 'Original', number_of_seasons: 1});
  assert.equal(h.work(), current);
});

test('continue retains native video formats while explicit samples cannot become the next episode', t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  h.window.homelabContinue.resume(entry());
  h.L.sourceLookup.success({file_stats: [
    {id: 1, path: 'Series/S01E01.mkv'}, {id: 2, path: 'Series/S01E02.3gp'},
    {id: 3, path: 'Series/Sample/S01E01.sample.mkv'}, {id: 4, path: 'Series/Trailer.mkv'},
  ]});
  h.pick(); assert.deepEqual(Array.from(h.L.playlistData, work => work.id), [1, 2]);
});

test('a newer later native episode replaces the captured one without its source; stale closes and other cuts do not', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  h.window.homelabContinue.load(); const item = entry(); item.observed = 100; item.position = 60;
  h.calls[0].finish({version: 1, items: [item]}); await flush();
  // An external player or a client without the extension watched episode 3.
  // (Stamped beyond the two-minute native save interval, viewed over a minute.)
  h.syncRows([{watched_at: 200000, hash: '789', position: 70, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 1, episode: 3})}]);
  let value = h.window.homelabContinue.list()[0];
  assert.equal(value.episode, 3); assert.equal(value.position, 70); assert.equal(value.timeline, '789');
  assert.equal(value.torrent, undefined, 'the captured release belongs to episode 2 only'); assert.equal(value.title, 'Series');
  // Native TimeCode re-stamps a stale paused device closing an earlier episode.
  h.syncRows([{watched_at: 300000, hash: '111', position: 70, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 1, episode: 1})}]);
  value = h.window.homelabContinue.list()[0]; assert.equal(value.episode, 2); assert.equal(value.position, 60); assert.equal(value.torrent, hash);
  h.syncRows([{watched_at: 300000, hash: '456', position: 110, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 1, episode: 2})}]);
  assert.equal(h.window.homelabContinue.list()[0].position, 60, 'positions from another cut are not combined with the captured source');
});

test('continue profile changes discard old reads and queued playback writes', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js'); h.window.homelabContinue.load();
  h.profile('other'); h.calls[0].finish({version: 1, items: [entry()]}); await flush();
  assert.equal(h.window.homelabContinue.list().length, 0);
  assert.equal(h.calls[0].options.signal.aborted, true);
});

test('failed final progress writes retry the original observation and closing a paused device adds no fresh stamp', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  h.start({card: {id: 42, name: 'Series'}, season: 1, episode: 2, timeline: {hash: '123'}, homelab_torrent_hash: hash, homelab_file_index: 1});
  h.video().currentTime = 50; h.videoEvent('timeupdate');
  assert.equal(h.calls.length, 1);
  const first = JSON.parse(h.calls[0].options.body); h.calls[0].finish({}, 503); await flush();
  h.tick(5000); assert.equal(h.calls.length, 2);
  assert.equal(JSON.parse(h.calls[1].options.body).observed, first.observed, 'retry must not pretend old progress is newly observed');
  h.calls[1].finish({success: true}); await flush();
  h.tick(120000); h.videoEvent('pause'); h.tick(500); h.destroy();
  assert.equal(h.calls.length, 2, 'unchanged paused/closed playback cannot overwrite a newer device');
});

test('only the latest continue intent may launch or fall back after asynchronous source checks', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  h.window.homelabContinue.resume(entry()); const old = h.L.sourceLookup;
  h.window.homelabContinue.resume({...entry(), card: 'tv_43', title: 'Second'});
  h.L.sourceLookup.success({file_stats: [{id: 1, path: 'second.mkv'}]});
  old.failure(); h.tick(8000); h.pick();
  assert.equal(h.L.routed, undefined); assert.equal(h.work().card.id, 43);
});

test('owned continue row uses exported focus APIs for remote navigation without a private Navigator', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  let row;
  h.rows[0].call()(data => { row = data.params.createInstance(); row.create(); });
  h.calls[0].finish({version: 1, items: [entry(), {...entry(), card: 'tv_43', title: 'Second series'}]}); await flush();
  assert.ok(row); row.toggle();
  const first = h.elements.find(e => e.classes.has('homelab-resume-card'));
  const second = h.elements.filter(e => e.classes.has('homelab-resume-card'))[1];
  let focus;
  h.L.Controller.collectionFocus = node => { focus = node; node.trigger('hover:focus'); };
  h.L.Controller.controllers.homelab_resume.right(); assert.equal(focus, second);
  h.L.Controller.controllers.homelab_resume.left(); assert.equal(focus, first);
  let left = 0; row.use({onLeft() { left++; }});
  h.L.Controller.controllers.homelab_resume.left(); assert.equal(left, 1);
  row.destroy();
});


test('recovery actions stay hidden during playback, ignore recoverable errors and transfer current position only by explicit action', t => {
  const h = harness(t), recovered = [];
  h.window.HomelabSources = {recover: (...args) => { recovered.push(args); return true; }};
  h.run('plugins/playback-status.js');
  const work = {card: {id: 42}, homelab_online: {provider: 'one', voice: 'Preferred'}};
  h.start(work);
  const retry = h.elements.find(e => e.classes.has('homelab-playback-retry')), source = h.elements.find(e => e.classes.has('homelab-playback-source'));
  assert.ok(retry.hasClass('hide') && source.hasClass('hide'));
  assert.ok(!h.elements.some(e => e.classes.has('homelab-playback-help')));
  h.videoEvent('error', {fatal: false, error: 'fragLoadError'}); h.tick(30000); assert.ok(retry.hasClass('hide'));
  h.video().currentTime = 74; h.video().fire('timeupdate'); h.video().currentTime = 25; h.video().fire('timeupdate');
  h.videoEvent('error', {fatal: true, error: 'fragLoadError'});
  assert.ok(!retry.hasClass('hide') && !source.hasClass('hide')); assert.equal(recovered.length, 0);
  source.trigger('hover:enter'); assert.equal(recovered[0][0], work); assert.equal(recovered[0][1].position, 25); assert.equal(recovered[0][2], false);
  source.trigger('hover:enter'); assert.equal(recovered.length, 1, 'repeated input is bounded');
  h.profile('other'); h.tick(5000); source.trigger('hover:enter'); assert.equal(recovered.length, 1); assert.ok(source.hasClass('hide'));
});

test('stall recovery requires thirty seconds without progress, never triggers while paused, on another video or after close, and covers a stuck seek', t => {
  const h = harness(t); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const retry = h.elements.find(e => e.classes.has('homelab-playback-retry'));
  h.video().fire('waiting'); h.tick(29000); assert.ok(retry.hasClass('hide'));
  h.video().currentTime = 3; h.video().fire('timeupdate'); h.tick(1000); assert.ok(retry.hasClass('hide'));
  h.video().fire('waiting'); h.video().paused = true; h.video().fire('pause'); h.tick(30000); assert.ok(retry.hasClass('hide'));
  h.video().paused = false; h.video().fire('play'); h.video().fire('playing');
  h.video().seeking = true; h.video().currentTime = 50; h.video().fire('seeking'); h.tick(30000); assert.ok(!retry.hasClass('hide'), 'a seek that never completes is a stall');
  h.video().seeking = false; h.video().fire('seeked'); h.video().fire('playing'); assert.ok(retry.hasClass('hide'));
  h.video().fire('waiting'); h.tick(30000); assert.ok(!retry.hasClass('hide'));
  h.video().fire('playing'); assert.ok(retry.hasClass('hide'));
  h.video().fire('waiting'); const old = h.replaceVideo(); h.tick(30000); old.fire('error'); assert.ok(retry.hasClass('hide'));
  h.destroy(); h.tick(60000); assert.ok(retry.hasClass('hide'));
});

test('source recovery restores absolute time once and warns about different cuts without seeking to the end', t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  const work = {timeline: {hash: 'cut'}, homelab_resume_at: 71, homelab_resume_from_duration: 240};
  h.start(work); assert.equal(h.video().currentTime, 71); assert.ok(h.notices.some(text => text.includes('Длительность версии отличается')));
  h.video().currentTime = 80; h.video().fire('canplay'); assert.equal(h.video().currentTime, 80);
  h.start({timeline: {hash: 'short'}, homelab_resume_at: 130, homelab_resume_from_duration: 240});
  assert.equal(h.video().currentTime, 0); assert.ok(h.notices.some(text => text.includes('короче сохранённой позиции')));
});


test('a retry failing before replacement metadata preserves the previous position for another source', t => {
  const h = harness(t), calls = [];
  h.window.HomelabSources = {recover: (...args) => { calls.push(args); return true; }};
  h.run('plugins/playback-status.js'); h.start({card: {id: 42}, homelab_torrent_hash: hash});
  h.video().currentTime = 74; h.video().fire('timeupdate'); h.phase('failed');
  h.L.HomelabGstAudio.retryCurrent = () => { h.replaceVideo(); return true; };
  h.elements.find(e => e.classes.has('homelab-playback-retry')).trigger('hover:enter');
  h.videoEvent('loadeddata'); h.phase('failed'); h.tick(5000);
  h.elements.find(e => e.classes.has('homelab-playback-source')).trigger('hover:enter');
  assert.equal(calls[0][1].position, 74);
});

test('replacement metadata at zero cannot overwrite the last position, but a restored video can seek back to zero', t => {
  const h = harness(t), calls = [];
  h.window.HomelabSources = {recover: (...args) => { calls.push(args); return true; }};
  h.run('plugins/playback-status.js'); h.start({card: {id: 42}, homelab_torrent_hash: hash});
  h.video().currentTime = 74; h.video().fire('timeupdate'); h.phase('failed');
  h.L.HomelabGstAudio.retryCurrent = () => { h.replaceVideo(); return true; };
  h.elements.find(e => e.classes.has('homelab-playback-retry')).trigger('hover:enter');
  h.video().readyState = 1; h.video().currentTime = 0;
  h.videoEvent('error', {fatal: true}); h.tick(5000);
  const source = h.elements.find(e => e.classes.has('homelab-playback-source'));
  source.trigger('hover:enter'); assert.equal(calls[0][1].position, 74);
  h.video().currentTime = 74; h.video().readyState = 4; h.video().fire('timeupdate');
  h.video().currentTime = 0; h.video().fire('timeupdate');
  h.videoEvent('error', {fatal: true}); h.tick(5000); source.trigger('hover:enter');
  assert.equal(calls[1][1].position, 0, 'intentional zero after restored playback is authoritative');
});

test('source recovery accepts an explicit Specials season and still rejects missing TV season', t => {
  const h = harness(t), calls = [];
  h.window.HomelabSources = {recover: (...args) => { calls.push(args); return true; }};
  h.run('plugins/playback-status.js');
  h.start({card: {id: 42, name: 'Series'}, season: 0, episode: 1, homelab_online: {provider: 'one'}});
  h.videoEvent('error', {fatal: true});
  const source = h.elements.find(e => e.classes.has('homelab-playback-source'));
  assert.equal(source.hasClass('hide'), false);
  source.trigger('hover:enter'); assert.equal(calls[0][0].season, 0);
  h.start({card: {id: 42, name: 'Series'}, episode: 1, homelab_online: {provider: 'one'}});
  h.videoEvent('error', {fatal: true}); assert.equal(source.hasClass('hide'), true);
});


test('a failed replacement before loadeddata offers retry while errors from the detached video stay ignored', t => {
  const h = harness(t); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const retry = h.elements.find(e => e.classes.has('homelab-playback-retry'));
  h.videoEvent('destroy', {savemeta: true}); const old = h.replaceVideo(); h.tick(0);
  old.fire('error'); assert.ok(retry.hasClass('hide'));
  h.videoEvent('error', {fatal: true, error: 'manifestLoadError'}); assert.ok(!retry.hasClass('hide'));
  h.videoEvent('destroy', {savemeta: true}); h.replaceVideo();
  h.videoEvent('error', {fatal: true, error: 'manifestLoadError'}); assert.ok(!retry.hasClass('hide'), 'synchronous failures before deferred bind work too');
});
