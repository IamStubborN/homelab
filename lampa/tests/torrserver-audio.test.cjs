const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const plugin = fs.readFileSync(path.join(__dirname, '../plugins/torrserver-audio.js'), 'utf8');
const track = (Type, Index, Title, Language = 'ru') => ({ Type, Index, Title, Language, Channels: 2 });
const firstEpisode = [
  track('audio', 0, 'Dream Cast'), track('audio', 1, 'Amediateka (Studio Band)'),
  track('audio', 2, 'Japanese', 'ja'), track('subtitle', 0, 'надписи'),
  track('subtitle', 1, 'English', 'en'), track('subtitle', 2, 'Russian'),
];
const reorderedEpisode = [
  track('audio', 0, 'Japanese', 'ja'), track('audio', 1, 'Dream Cast'),
  track('audio', 2, 'Amediateka (Studio Band)'), track('subtitle', 0, 'Russian'),
  track('subtitle', 1, 'English', 'en'), track('subtitle', 2, 'надписи'),
];

function subscription() {
  const listeners = new Map();
  return {
    follow(names, fn) {
      for (const name of names.split(',')) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
      }
    },
    remove(name, fn) { listeners.get(name)?.delete(fn); },
    send(name, event = {}) { for (const fn of [...(listeners.get(name) || [])]) fn(event); },
  };
}

function createVideo() {
  const events = subscription();
  return {
    currentTime: 0, paused: false, volume: 0.4, muted: false, playbackRate: 1,
    duration: 1400, readyState: 1,
    addEventListener: events.follow, removeEventListener: events.remove,
    fire: events.send,
    pause() { this.paused = true; },
  };
}

function harness(t, storage = new Map(), { android = false } = {}) {
  let work = false;
  let video = createVideo();
  let audioMenu = [];
  let subtitles = [];
  let selectedSubtitle = -1;
  const pending = [];
  const requests = [];
  const timers = new Map();
  const loads = [];
  let timerId = 0;
  const player = subscription(), playerVideo = subscription(), panel = subscription();
  const Lampa = {
    Storage: {
      get: (key, fallback) => storage.has(key) ? JSON.parse(storage.get(key)) : fallback,
      set: (key, value) => storage.set(key, JSON.stringify(value)),
      remove: key => storage.delete(key),
      field: key => storage.has(key) ? JSON.parse(storage.get(key)) : undefined,
    },
    Controller: { toggle() {} }, Platform: { is: name => android && name === 'android' },
    Player: { playdata: () => work, listener: player },
    PlayerVideo: {
      listener: playerVideo, video: () => video,
      destroy(savemeta) { selectedSubtitle = -1; subtitles = []; playerVideo.send('destroy', { savemeta }); },
      url(url) { loads.push(url); video = createVideo(); video.readyState = 0; video.paused = true; },
      pause: () => video.pause(), play: () => { video.paused = false; },
      subsview() {},
    },
    PlayerPanel: { listener: panel, setTracks: value => { audioMenu = value; }, setSubs: value => { subtitles = value; } },
  };
  const browserStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const context = {
    Lampa, URL, AbortController, console, localStorage: browserStorage,
    setTimeout(fn, delay) { timers.set(++timerId, {fn, delay}); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    window: {
      location: { origin: 'https://lampa.test', href: 'https://lampa.test/' },
      localStorage: browserStorage,
      fetch(url, options) {
        requests.push({url, options});
        if (/\/(?:heartbeat|remove)(?:\?|$)/.test(url)) return Promise.resolve({ok: true});
        return new Promise(resolve => pending.push({ url, options, resolve }));
      },
    },
  };
  vm.runInNewContext(plugin, context, { filename: 'torrserver-audio.js' });

  function destroy() {
    // Lampa destroys PlayerVideo while old playdata still exists, then emits Player.destroy.
    Lampa.PlayerVideo.destroy();
    work = false;
    player.send('destroy');
  }
  t.after(() => { destroy(); assert.equal(timers.size, 0, 'no pending plugin timers after destroy'); });

  return {
    loads, storage, requests, destroy,
    fireTimer(delay) {
      const timer = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(timer, `timer ${delay} is scheduled`);
      timers.delete(timer[0]);
      timer[1].fn();
    },
    async task(id, request) {
      request = request || pending.find(item => new URL(item.url).pathname === '/gst/start.m3u8');
      assert.ok(request, 'task ownership discovery request exists');
      pending.splice(pending.indexOf(request), 1);
      request.resolve({ok: true, url: `https://lampa.test/gst/${id}/master.m3u8`});
      await new Promise(setImmediate);
    },
    start(file = 1, hash = 'same-torrent', prepare = false) {
      destroy();
      work = { torrent_hash: hash, url: `https://lampa.test/torrserver/gst/${hash}/master.m3u8?index=${file}&audio=0` };
      video = createVideo();
      if (prepare) player.send('create', {data: work});
      player.send('start', work);
      player.send('ready', work);
    },
    work: () => work,
    pending,
    async probe(tracks, lampac = false) {
      const request = pending.find(item => /\/probe$/.test(new URL(item.url).pathname));
      assert.ok(request, 'plugin must request source metadata');
      pending.splice(pending.indexOf(request), 1);
      request.resolve({ ok: true, json: async () => lampac ? {tracks: tracks.map(t => ({type:t.Type,index:t.Index || undefined,title:t.Title,language:t.Language,channels:t.Channels}))} : ({ Tracks: tracks }) });
      await new Promise(setImmediate);
    },
    emitSubtitles(tracks, native = false) {
      selectedSubtitle = -1;
      subtitles = tracks.filter(item => item.Type === 'subtitle').map((item, index) => {
        const sub = { index, label: item.Title, selected: false };
        const properties = native ? Object.create(Object.getPrototypeOf(sub)) : sub;
        if (native) Object.setPrototypeOf(sub, properties);
        Object.defineProperty(properties, 'mode', {
          get: () => selectedSubtitle === index ? 'showing' : 'disabled',
          set(value) { if (value === 'showing') selectedSubtitle = index; else if (selectedSubtitle === index) selectedSubtitle = -1; },
        });
        return sub;
      });
      playerVideo.send('subs', { subs: subtitles });
    },
    chooseAudio(title) {
      // Native PlayerPanel decorates each mutable title before opening Select.
      audioMenu.forEach((item, index) => { item.title = `${index + 1} / ${item.language || ''} / ${item.label}`; });
      const item = audioMenu.find(value => value.label === title);
      assert.ok(item, `audio option ${title} exists`);
      // Select invokes the item's onSelect directly instead of the panel callback.
      item.onSelect(item);
    },
    chooseSubtitle(title) {
      // The subtitle menu also replaces title; label remains source metadata.
      subtitles.forEach((item, index) => { item.title = `${index + 1} / ${item.label}`; });
      const chosen = title === null ? null : subtitles.find(item => item.label === title);
      if (title !== null) assert.ok(chosen);
      subtitles.forEach(item => { item.mode = 'disabled'; item.selected = false; });
      if (chosen) { chosen.mode = 'showing'; chosen.selected = true; }
      panel.send('subsview', { status: Boolean(chosen) });
    },
    ready() { video.readyState = 1; video.fire('loadedmetadata'); video.fire('canplay'); },
    audioIndex: () => Number(new URL(work.url).searchParams.get('audio') || 0),
    subtitleTitle: () => subtitles.find(item => item.mode === 'showing')?.label ?? null,
    currentVideo: () => video,
  };
}

async function selectFirstEpisode(h, subtitle = 'Russian') {
  h.start();
  await h.probe(firstEpisode);
  h.emitSubtitles(firstEpisode);
  h.chooseAudio('Amediateka (Studio Band)');
  h.ready();
  h.emitSubtitles(firstEpisode);
  h.chooseSubtitle(subtitle);
}

test('next episode restores audio by metadata after its index changes', async t => {
  const h = harness(t);
  await selectFirstEpisode(h);
  h.start(2);
  await h.probe(reorderedEpisode);
  h.ready();
  assert.equal(h.audioIndex(), 2, 'Studio Band moved from index 1 to index 2');
});

test('next episode restores subtitle by metadata after its index changes', async t => {
  const h = harness(t);
  await selectFirstEpisode(h);
  h.start(2);
  await h.probe(reorderedEpisode);
  h.emitSubtitles(reorderedEpisode);
  h.ready();
  assert.equal(h.subtitleTitle(), 'Russian');
});

test('Safari native TextTrack selection survives an episode change', async t => {
  const h = harness(t);
  h.start();
  await h.probe(firstEpisode);
  h.emitSubtitles(firstEpisode, true);
  h.chooseSubtitle('Russian');
  h.start(2);
  await h.probe(reorderedEpisode);
  h.emitSubtitles(reorderedEpisode, true);
  assert.equal(h.subtitleTitle(), 'Russian');
});

test('subtitle event before probe completion does not lose the stored selection', async t => {
  const h = harness(t);
  await selectFirstEpisode(h);
  h.start(2);
  h.emitSubtitles(reorderedEpisode);
  assert.equal(h.subtitleTitle(), 'Russian', 'native subtitle metadata is enough before probe finishes');
  await h.probe(reorderedEpisode);
  h.emitSubtitles(reorderedEpisode); // The automatic audio reload emits a fresh manifest.
  h.ready();
  assert.equal(h.subtitleTitle(), 'Russian');
});

test('explicit subtitle off survives the next episode', async t => {
  const h = harness(t);
  await selectFirstEpisode(h);
  h.chooseSubtitle(null);
  h.start(2);
  await h.probe(reorderedEpisode);
  h.emitSubtitles(reorderedEpisode);
  h.ready();
  assert.equal(h.subtitleTitle(), null);
});

test('absent metadata match never selects an unrelated track at the old index', async t => {
  const h = harness(t);
  await selectFirstEpisode(h);
  const absent = reorderedEpisode.filter(item => item.Title !== 'Amediateka (Studio Band)' && item.Title !== 'Russian');
  h.start(2);
  await h.probe(absent);
  h.emitSubtitles(absent);
  h.ready();
  assert.equal(h.audioIndex(), 0);
  assert.equal(h.subtitleTitle(), null);
});

test('preferences do not leak into another torrent with matching labels', async t => {
  const h = harness(t);
  await selectFirstEpisode(h);
  h.start(1, 'different-torrent');
  await h.probe(reorderedEpisode);
  h.emitSubtitles(reorderedEpisode);
  h.ready();
  assert.equal(h.audioIndex(), 0);
  assert.equal(h.subtitleTitle(), null);
});

test('same-torrent preferences survive a fresh browser plugin instance', async t => {
  const storage = new Map();
  const first = harness(t, storage);
  await selectFirstEpisode(first);
  const next = harness(t, storage);
  next.start(2);
  await next.probe(reorderedEpisode);
  next.emitSubtitles(reorderedEpisode);
  next.ready();
  assert.equal(next.audioIndex(), 2);
  assert.equal(next.subtitleTitle(), 'Russian');
});


test('explicitly choosing the already active audio is remembered without a reload', async t => {
  const h = harness(t);
  h.start();
  await h.probe(firstEpisode);
  h.chooseAudio('Dream Cast');
  assert.equal(h.loads.length, 0);
  h.start(2);
  await h.probe(reorderedEpisode);
  h.ready();
  assert.equal(h.audioIndex(), 1, 'Dream Cast moved from index 0 to index 1');
});


test('automatic preference restore starts an unloaded video instead of preserving its temporary pause', async t => {
  const h = harness(t);
  await selectFirstEpisode(h);
  h.start(2);
  Object.assign(h.currentVideo(), { readyState: 0, paused: true, currentTime: 0 });
  await h.probe(reorderedEpisode);
  h.emitSubtitles(reorderedEpisode);
  h.ready();
  assert.equal(h.audioIndex(), 2);
  assert.equal(h.currentVideo().paused, false);
});

for (const paused of [true, false]) {
  test(`rapid manual audio changes preserve original time and ${paused ? 'pause' : 'playing'} state`, async t => {
    const h = harness(t);
    h.start();
    await h.probe(firstEpisode);
    Object.assign(h.currentVideo(), { currentTime: 333.25, paused, volume: 0.3, muted: true, playbackRate: 1.5 });
    h.chooseAudio('Amediateka (Studio Band)');
    assert.equal(h.currentVideo().readyState, 0);
    h.chooseAudio('Japanese');
    h.ready();
    assert.equal(h.currentVideo().currentTime, 333.25);
    assert.equal(h.currentVideo().paused, paused);
    assert.equal(h.currentVideo().volume, 0.3);
    assert.equal(h.currentVideo().muted, true);
    assert.equal(h.currentVideo().playbackRate, 1.5);
  });
}

test('a temporarily absent preferred track is remembered when it returns in episode three', async t => {
  const h = harness(t);
  await selectFirstEpisode(h);
  const absent = reorderedEpisode.filter(item => item.Title !== 'Amediateka (Studio Band)' && item.Title !== 'Russian');
  h.start(2);
  await h.probe(absent);
  h.emitSubtitles(absent);
  h.ready();
  assert.equal(h.audioIndex(), 0);
  assert.equal(h.subtitleTitle(), null);
  h.start(3);
  await h.probe(reorderedEpisode);
  h.emitSubtitles(reorderedEpisode);
  h.ready();
  assert.equal(h.audioIndex(), 2);
  assert.equal(h.subtitleTitle(), 'Russian');
});


test('browser tabs use independent Lampac sessions for the same torrent', async t => {
  const storage = new Map();
  const first = harness(t, storage), second = harness(t, storage);
  first.start(1, 'same-torrent', true);
  second.start(1, 'same-torrent', true);
  const a = new URL(first.work().url), b = new URL(second.work().url);
  assert.equal(a.pathname, '/gst/start.m3u8');
  assert.notEqual(a.searchParams.get('uid'), b.searchParams.get('uid'));
  assert.equal(a.searchParams.get('link'), b.searchParams.get('link'));
  assert.equal(new URL(a.searchParams.get('link')).searchParams.get('index'), '1');
  assert.equal(first.work().torrent_hash, undefined, 'legacy task heartbeat disabled');
  assert.equal(first.work().hls_type, 'hlsjs', 'Safari retains subtitle master');
  assert.equal(new URL(first.pending[0].url).pathname, '/gst/probe');
  await first.probe(firstEpisode, true);
  first.chooseAudio('Dream Cast');
  assert.equal(first.audioIndex(), 0, 'Lampac omits zero-valued index in JSON');
  first.chooseAudio('Amediateka (Studio Band)');
  assert.equal(first.audioIndex(), 1);
  assert.notEqual(new URL(first.work().url).searchParams.get('uid'), a.searchParams.get('uid'), 'audio replacement cannot race old request');
  assert.equal(second.audioIndex(), 0);
  first.start(2, 'same-torrent', true);
  const next = new URL(first.work().url);
  assert.notEqual(next.searchParams.get('uid'), a.searchParams.get('uid'), 'late old episode cannot evict current task');
  assert.equal(new URL(next.searchParams.get('link')).searchParams.get('index'), '2');
  await first.probe(reorderedEpisode, true);
  assert.equal(first.audioIndex(), 2, 'preferences survive the backend change');
});

test('owned Lampac task receives heartbeat while paused and is removed on close', async t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  await h.probe(firstEpisode, true);
  await h.task('101');
  h.currentVideo().paused = true;
  h.fireTimer(20000);
  assert.equal(h.requests.filter(r => new URL(r.url).pathname === '/gst/101/heartbeat').length, 1);
  h.destroy();
  assert.equal(h.requests.filter(r => new URL(r.url).pathname === '/gst/remove' && new URL(r.url).searchParams.get('id') === '101').length, 1);
});

test('audio change removes only the previous owned task and follows its replacement', async t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  await h.probe(firstEpisode, true);
  await h.task('201');
  h.chooseAudio('Amediateka (Studio Band)');
  await h.task('202');
  assert.equal(h.requests.filter(r => new URL(r.url).searchParams.get('id') === '201').length, 1);
  assert.equal(h.requests.filter(r => new URL(r.url).searchParams.get('id') === '202').length, 0);
  h.fireTimer(20000);
  assert.equal(new URL(h.requests.at(-1).url).pathname, '/gst/202/heartbeat');
});

test('late task discovery removes its own stale ID without touching current playback', async t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  await h.probe(firstEpisode, true);
  const stale = h.pending.find(r => new URL(r.url).pathname === '/gst/start.m3u8');
  h.start(2, 'same-torrent', true);
  await h.probe(reorderedEpisode, true);
  await h.task('302', h.pending.find(r => r !== stale && new URL(r.url).pathname === '/gst/start.m3u8'));
  await h.task('301', stale);
  assert.equal(stale.options.signal.aborted, true);
  assert.equal(h.requests.filter(r => new URL(r.url).searchParams.get('id') === '301').length, 1);
  assert.equal(h.requests.filter(r => new URL(r.url).searchParams.get('id') === '302').length, 0);
  h.fireTimer(20000);
  assert.equal(new URL(h.requests.at(-1).url).pathname, '/gst/302/heartbeat');
});

test('ownership discovery has its own 90-second abort deadline', async t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  const discovery = h.pending.find(r => new URL(r.url).pathname === '/gst/start.m3u8');
  const probe = h.pending.find(r => new URL(r.url).pathname === '/gst/probe');
  h.fireTimer(15000);
  assert.equal(probe.options.signal.aborted, true);
  assert.equal(discovery.options.signal.aborted, false);
  h.fireTimer(90000);
  assert.equal(discovery.options.signal.aborted, true);
});

test('legacy shared TorrServer task is never claimed or removed', async t => {
  const h = harness(t);
  h.start();
  await h.probe(firstEpisode);
  h.chooseAudio('Amediateka (Studio Band)');
  h.destroy();
  assert.equal(h.requests.length, 1, 'legacy probe is the only request');
});


test('Android embedded player owns a separate HLS session and preserves reordered audio', async t => {
  const storage = new Map([['player_torrent', JSON.stringify('inner')], ['player', JSON.stringify('android')]]);
  const h = harness(t, storage, { android: true });
  const browser = harness(t);
  h.start(1, 'same-torrent', true);
  browser.start(1, 'same-torrent', true);
  const androidUrl = new URL(h.work().url), browserUrl = new URL(browser.work().url);
  assert.equal(androidUrl.pathname, '/gst/start.m3u8');
  assert.notEqual(androidUrl.searchParams.get('uid'), browserUrl.searchParams.get('uid'));
  assert.equal(h.work().hls_type, 'hlsjs');
  assert.equal(h.work().launch_player, 'inner', 'torrent playback must not fall back to the external main player');
  assert.equal(browser.work().launch_player, undefined, 'browser player selection remains untouched');
  assert.equal(h.work().torrent_hash, undefined);
  await h.probe(firstEpisode, true);
  h.chooseAudio('Amediateka (Studio Band)');
  h.start(2, 'same-torrent', true);
  await h.probe(reorderedEpisode, true);
  assert.equal(h.audioIndex(), 2);
  assert.equal(browser.audioIndex(), 0, 'Android selection must not control another viewer');
});

test('Android external player bypasses HLS ownership and track interception after a setting change', t => {
  const storage = new Map([['player_torrent', JSON.stringify('android')]]);
  const h = harness(t, storage, { android: true });
  h.start(1, 'same-torrent', true);
  assert.equal(new URL(h.work().url).pathname, '/torrserver/gst/same-torrent/master.m3u8');
  assert.equal(h.work().torrent_hash, 'same-torrent');
  assert.equal(h.work().hls_type, undefined);
  assert.equal(h.work().launch_player, undefined);
  assert.equal(h.requests.length, 0, 'external player must not create metadata or owned-task requests');
  storage.set('player_torrent', JSON.stringify('inner'));
  h.start(2, 'same-torrent', true);
  assert.equal(new URL(h.work().url).pathname, '/gst/start.m3u8');
  assert.ok(h.requests.some(request => new URL(request.url).pathname === '/gst/probe'));
});
