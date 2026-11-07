const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');
const hash = 'a'.repeat(40), key = `/previews/${hash}/1/`;
const data = {key, enabled: true, info: {duration: 120, step: 5, version: 1, chapters: [
  {start: 0, end: 8, title: 'OP'}, {start: 8, end: 90, title: 'Opening Scene'}, {start: 90, end: 120, title: 'Ending'},
]}};

test('actual seek core wakes the chapter gallery when its script loads later', t => {
  const h = harness(t);
  delete h.window.homelabSeekPreviews;
  h.window.CustomEvent = function (type) { this.type = type; };
  h.run('plugins/chapter-gallery.js');
  assert.equal(h.window.homelabChapterGallery, undefined);
  h.run('plugins/seek-previews.js');
  assert.ok(h.window.homelabChapterGallery);
  assert.equal(typeof h.window.homelabSeekPreviews.openChapters, 'function');
});

test('gallery loaded after metadata immediately offers skip on a paused intro', async t => {
  const h = harness(t);
  delete h.window.homelabSeekPreviews;
  h.run('plugins/seek-previews.js');
  h.video().paused = true;
  h.start({homelab_torrent_hash: hash, homelab_file_index: 1});
  h.calls[0].finish({...data.info, step: 10}); await flush();
  h.run('plugins/chapter-gallery.js');
  assert.equal(h.elements.find(e => e.classes.has('homelab-skip')).hasClass('hide'), false);
});

test('chapter gallery samples inside the chapter and keeps thumbnail generation serial', async t => {
  const h = harness(t); h.run('plugins/chapter-gallery.js'); h.coreState(data);
  h.video().currentTime = 10; h.core.openChapters();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, key + 'frame/5.jpg', 'the 8s chapter samples 15s inside it, not the preceding scene');
  h.calls[0].finish({type: 'image/jpeg', size: 100}); await flush();
  assert.equal(h.calls.length, 2, 'only one decoder request runs at a time');
  h.L.Modal.close(); assert.equal(h.calls[1].options.signal.aborted, true);
  h.calls[1].finish({type: 'image/jpeg', size: 100}); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.revoked.length, 1);
});

test('chapter gallery respects the negotiated ten-second grid', t => {
  const h = harness(t); h.run('plugins/chapter-gallery.js');
  h.coreState({...data, info: {...data.info, step: 10}}); h.video().currentTime = 10; h.core.openChapters();
  assert.equal(h.calls[0].url, key + 'frame/2.jpg?step=10', 'the 8s chapter samples the ten-second grid inside it');
});

test('skip buttons never auto-seek and conservative labels leave story chapters alone', t => {
  const h = harness(t); h.run('plugins/chapter-gallery.js'); h.coreState(data);
  h.L.PlayerPanel.listener.follow('to_end', () => h.L.PlayerVideo.to(-1)); // native without a next episode
  const button = h.elements.find(e => e.classes.has('homelab-skip'));
  assert.equal(h.selected(), undefined); assert.equal(button.hasClass('hide'), false);
  button.trigger('hover:enter'); assert.equal(h.selected(), 8);
  h.video().currentTime = 10; h.videoEvent('timeupdate'); assert.equal(button.hasClass('hide'), true, 'Opening Scene is not an intro marker');
  h.video().currentTime = 100; h.videoEvent('timeupdate'); assert.equal(button.hasClass('hide'), false);
  button.trigger('hover:enter'); assert.equal(h.selected(), -1, 'tail credits use native end position');
});

test('manual chapter edits require explicit save and reject invalid boundaries or another profile', t => {
  const h = harness(t); h.run('plugins/chapter-gallery.js'); h.coreState(data); h.core.openChapters();
  h.elements.filter(e => e.classes.has('homelab-chapter-edit'))[1].trigger('hover:enter');
  h.choose(h.select().items[0]); h.input().callback('200');
  assert.equal(h.storage.size, 0, 'typing/back from input does not persist edits');
  h.choose(h.select().items.find(i => i.save)); assert.equal(h.storage.size, 0); assert.ok(h.notices.length);
  h.elements.filter(e => e.classes.has('homelab-chapter-edit'))[1].trigger('hover:enter');
  h.choose(h.select().items.find(i => i.type));
  h.choose(h.select().items.find(i => i.save));
  assert.equal(h.storage.get('homelab_chapter_edits_profile-a|')[key][1].kind, 'intro');
  h.elements.filter(e => e.classes.has('homelab-chapter-edit')).at(-2).trigger('hover:enter');
  const old = h.select(); h.profile('profile-b'); old.onSelect(old.items.find(i => i.save));
  assert.equal(h.storage.has('homelab_chapter_edits_profile-b|'), false);
});

test('another modal cancels thumbnail work and late responses cannot corrupt the restored gallery', async t => {
  const h = harness(t); h.run('plugins/chapter-gallery.js'); h.coreState(data); h.core.openChapters();
  const owned = h.modal(); h.L.Modal.open({title: 'Other', html: {}});
  assert.equal(h.calls[0].options.signal.aborted, true);
  h.L.Modal.open(owned); assert.equal(h.calls.length, 2);
  h.calls[0].finish({type: 'image/jpeg', size: 100}); await flush();
  h.calls[1].finish({type: 'image/jpeg', size: 100}); await flush();
  assert.equal(h.calls.length, 3, 'the active thumbnail queue keeps running');
});

test('playback recovery stays silent through preparation, buffering, recovery and failure while retaining one manual retry', t => {
  const h = harness(t); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const retry = h.elements.find(e => e.classes.has('homelab-playback-retry'));
  h.video().fire('waiting'); h.tick(400); assert.ok(retry.hasClass('hide'));
  h.phase('recovering'); h.tick(400);
  h.videoEvent('error', {fatal: true, error: 'http://private/?token=secret'});
  assert.ok(!retry.hasClass('hide'));
  assert.equal(h.notices.length, 0, 'phase changes never produce popups');
  assert.equal(h.elements.some(e => [...e.classes].some(name => name.startsWith('homelab-playback-status'))), false, 'no status overlay or hint DOM is created');
  retry.trigger('hover:enter'); assert.equal(h.retryCount(), 1);
  h.destroy(); h.tick(10000); assert.ok(retry.hasClass('hide'));
});

const entry = () => ({card: 'tv_42', title: 'Series', torrent: hash, index: 1, timeline: '123', season: 1, episode: 2, position: 112, duration: 120, observed: Date.now(), tracks: {audio: {title: 'Preferred', language: 'ru'}}});

test('continue loads once for concurrent callers and explicitly resumes high-percent playback with tracks', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  let first = false, second = false;
  h.window.homelabContinue.load(() => { first = true; }); h.window.homelabContinue.load(() => { second = true; });
  assert.equal(h.calls.length, 1); h.calls[0].finish({version: 1, items: [entry()]}); await flush();
  assert.ok(first && second); assert.equal(h.window.homelabContinue.list().length, 1);
  h.window.homelabContinue.resume(h.window.homelabContinue.list()[0]);
  h.L.sourceLookup.success({file_stats: [{id: 1, path: 'Series/02.mkv'}]});
  assert.equal(h.video().currentTime, 112); assert.equal(h.work().timeline.continued, true);
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
  h.tick(2000); assert.equal(h.video().currentTime, 112); assert.equal(h.L.playlistData.length, 1);
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
  assert.deepEqual(Array.from(h.L.playlistData, work => work.id), [1, 2]);
});

test('unreliable native close timestamps cannot override captured episode, source or position', async t => {
  const h = harness(t); h.run('mods/HomelabSync/continue.js');
  h.window.homelabContinue.load(); const item = entry(); item.observed = 100;
  h.calls[0].finish({version: 1, items: [item]}); await flush();
  h.syncRows([{watched_at: 200, position: 40, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 1, episode: 3})}]);
  const value = h.window.homelabContinue.list()[0]; assert.equal(value.episode, 2); assert.equal(value.position, 112); assert.equal(value.torrent, hash);
  h.syncRows([{watched_at: 300, hash: '456', position: 50, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 1, episode: 2})}]);
  assert.equal(h.window.homelabContinue.list()[0].position, 112, 'positions from another cut are not combined with the captured source');
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
  old.failure(); h.tick(8000);
  assert.equal(h.L.routed, undefined); assert.equal(h.work().card.id, 43);
});

test('manual Lampac areas isolate skip edits without changing the native timeline profile', t => {
  const h = harness(t); h.run('plugins/chapter-gallery.js'); h.coreState(data);
  h.L.Storage.set('lampac_profile_id', 'a'); h.core.openChapters();
  h.elements.filter(e => e.classes.has('homelab-chapter-edit'))[1].trigger('hover:enter');
  h.choose(h.select().items.find(i => i.type)); h.choose(h.select().items.find(i => i.save));
  h.video().currentTime = 20; h.videoEvent('timeupdate');
  const button = h.elements.find(e => e.classes.has('homelab-skip')); assert.equal(button.hasClass('hide'), false);
  h.L.Storage.set('lampac_profile_id', 'b'); h.videoEvent('timeupdate');
  assert.equal(button.hasClass('hide'), true);
});

test('editing skip boundaries leaves chapter navigation times and sampled scene intact', async t => {
  const h = harness(t); h.run('plugins/chapter-gallery.js'); h.coreState(data); h.core.openChapters();
  h.calls[0].finish({type: 'image/jpeg', size: 100}); await flush();
  h.elements.filter(e => e.classes.has('homelab-chapter-edit'))[0].trigger('hover:enter');
  h.choose(h.select().items[0]); h.input().callback('20');
  h.choose(h.select().items[1]); h.input().callback('40');
  h.choose(h.select().items.find(i => i.save));
  const tile = h.elements.filter(e => e.attrs['data-chapter'] === 0).at(-1);
  assert.equal(tile.find('.homelab-chapter-time').content, '00:00 — 00:08');
  h.video().currentTime = 25; h.videoEvent('timeupdate');
  const button = h.elements.find(e => e.classes.has('homelab-skip')); button.trigger('hover:enter'); assert.equal(h.selected(), 40);
  tile.trigger('hover:enter'); assert.equal(h.selected(), 0);
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


test('manual skip is a separate action above controls rather than a fixed-size toolbar circle', t => {
  const h = harness(t); h.run('plugins/chapter-gallery.js'); h.coreState(data);
  const button = h.elements.find(e => e.classes.has('homelab-skip'));
  assert.equal(button.classes.has('button'), false);
  assert.ok(h.L.Player.render().children.includes(button));
});


test('skip action survives native player cleanup and is reachable with remote Up without taking native skip focus', t => {
  const h = harness(t); h.run('plugins/chapter-gallery.js'); h.coreState(data);
  const button = h.elements.find(e => e.classes.has('homelab-skip'));
  h.L.Player.render().empty(); h.coreState(null); h.coreState(data);
  assert.ok(h.L.Player.render().children.includes(button), 'reattach after native root cleanup');
  h.L.Controller.toggle('player_rewind');
  h.L.Keypad.listener.send('keydown', {code: 38, enabled: true}); h.L.Controller.toggle('player_skip'); h.tick(0);
  assert.equal(h.L.Controller.enabled().name, 'player_skip', 'native skip retains priority');
  h.L.Controller.toggle('player_rewind');
  h.L.Keypad.listener.send('keydown', {code: 38, enabled: true}); h.L.Controller.toggle('player'); h.tick(0);
  assert.equal(h.L.Controller.enabled().name, 'homelab_chapter_skip');
  h.L.Controller.controllers.homelab_chapter_skip.enter(); assert.equal(h.selected(), 8);
  assert.equal(h.L.Controller.enabled().name, 'player');
});


test('skip positioning follows native visibility event order and leaving its controller clears focus', t => {
  const h = harness(t); h.run('plugins/chapter-gallery.js'); h.coreState(data);
  const button = h.elements.find(e => e.classes.has('homelab-skip')), panel = h.L.PlayerPanel.render();
  panel.rect.height = 200;
  h.L.PlayerPanel.listener.send('visible', {status: true});
  assert.equal(button.attrs['style:bottom'], 212, 'native sends visible before changing its CSS class');
  panel.addClass('panel--visible'); h.L.PlayerPanel.listener.send('visible', {status: false});
  assert.equal(button.attrs['style:bottom'], 24);
  h.L.Controller.toggle('homelab_chapter_skip'); button.addClass('focus');
  h.L.Controller.controllers.homelab_chapter_skip.left(); assert.equal(button.hasClass('focus'), false);
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

test('stall recovery requires thirty seconds without progress and never triggers while paused, seeking, on another video or after close', t => {
  const h = harness(t); h.run('plugins/playback-status.js'); h.start({homelab_torrent_hash: hash});
  const retry = h.elements.find(e => e.classes.has('homelab-playback-retry'));
  h.video().fire('waiting'); h.tick(29000); assert.ok(retry.hasClass('hide'));
  h.video().currentTime = 3; h.video().fire('timeupdate'); h.tick(1000); assert.ok(retry.hasClass('hide'));
  h.video().fire('waiting'); h.video().paused = true; h.tick(30000); assert.ok(retry.hasClass('hide'));
  h.video().paused = false; h.video().fire('waiting'); h.video().seeking = true; h.tick(30000); assert.ok(retry.hasClass('hide'));
  h.video().seeking = false; h.video().fire('waiting'); h.tick(30000); assert.ok(!retry.hasClass('hide'));
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
