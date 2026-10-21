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
    play() {
      this.paused = false;
      this.fire('play');
      if (!this.paused && this.readyState >= 3) this.fire('playing');
    },
  };
}

class FakeAss {
  constructor(options) {
    this.options = options; this.destroyed = false; this.events = [];
    this.ready = Promise.resolve();
    this.added = [];
    this.renderer = { processData: data => { this.events.push(...data.split('\n')); }, addFonts: urls => { this.added.push(...urls); } };
    this.renders = [];
    FakeAss.instances.push(this);
  }
  manualRender(frame) { this.renders.push(frame); }
  destroy() { this.destroyed = true; }
}
FakeAss.instances = [];

function harness(t, storage = new Map(), { android = false, external = [], rendition = [], mse = [], ass = null, raw = {}, embedded = null, events = null, attachments = {}, library = null } = {}) {
  const notices = [];
  let work = false;
  let video = createVideo();
  let audioMenu = [];
  let subtitles = [];
  let selectedSubtitle = -1;
  let waiting = false;
  const pending = [];
  const requests = [];
  const timers = new Map();
  const loads = [];
  const playingStates = [];
  const hlsInstances = [];
  class TestLoader {
    constructor(config) { this.config = config; TestLoader.instances.push(this); }
    load(context, config, callbacks) { this.context = context; this.callbacks = callbacks; }
    abort() {}
    destroy() {}
  }
  TestLoader.instances = [];
  class TestHls {
    static DefaultConfig = { loader: TestLoader };
    static Events = {
      ERROR: 'error', MANIFEST_LOADING: 'manifestLoading',
      FRAG_LOADING: 'fragLoading', FRAG_BUFFERED: 'fragBuffered',
    };
    static ErrorTypes = { NETWORK_ERROR: 'networkError' };
    constructor(config) { this.config = config; this.listeners = new Map(); this.sources = []; this.stops = 0; }
    on(event, callback, context) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push({ callback, context });
    }
    trigger(event, data = {}) {
      for (const { callback, context } of this.listeners.get(event) || []) callback.call(context || this, event, data);
    }
    loadSource(url) { this.sources.push(url); }
    startLoad(position) { this.startPosition = position; }
    stopLoad() { this.stops++; }
    destroy() {}
  }
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
      url(url) {
        loads.push(url); video = createVideo(); video.readyState = 0; video.paused = true;
        // Match native PlayerVideo: url/waiting set the loader; only playing
        // clears it, and playpause refuses user input while it is set.
        waiting = true;
        video.addEventListener('playing', () => {
          waiting = false;
          playingStates.push({ muted: video.muted, currentTime: video.currentTime });
        });
      },
      pause: () => video.pause(), play: () => video.play(),
      playpause() { if (!waiting) video.paused ? video.play() : video.pause(); },
      subsview() {},
    },
    Noty: { show: message => notices.push(message) },
    PlayerPanel: { listener: panel, setTracks: value => { audioMenu = value; }, setSubs: value => { subtitles = value; } },
  };
  const browserStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const context = {
    Lampa, URL, AbortController, console, localStorage: browserStorage, TextDecoder, TextEncoder, Worker: class {},
    setTimeout(fn, delay) { timers.set(++timerId, {fn, delay}); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    window: {
      Hls: TestHls, HomelabJassub: FakeAss,
      MediaSource: { isTypeSupported: type => mse.some(codec => type === `audio/mp4; codecs="${codec}"`) },
      location: { origin: 'https://lampa.test', href: 'https://lampa.test/' },
      localStorage: browserStorage,
      fetch(url, options) {
        requests.push({url, options});
        if (/\/(?:heartbeat|remove)(?:\?|$)/.test(url)) return Promise.resolve({ok: true});
        if (/^\/extaudio\/[^/]+\/\d+\/tracks$/.test(new URL(url).pathname)) {
          return Promise.resolve({ok: true, json: async () => ({tracks: external, ...(ass || {})})});
        }
        if (/^\/extaudio\/[^/]+\/\d+\/embedded$/.test(new URL(url).pathname)) {
          if (typeof embedded === 'function') return Promise.resolve(embedded());
          return Promise.resolve(embedded ? {ok: true, json: async () => embedded} : {ok: false, status: 404});
        }
        if (/^\/extaudio\/[^/]+\/\d+\/sub\/\d+$/.test(new URL(url).pathname)) {
          const payload = events(new URL(url));
          return Promise.resolve(payload ? {ok: true, json: async () => payload} : {ok: false, status: 502});
        }
        if (new URL(url).pathname === '/extaudio/fonts/index.json') {
          return Promise.resolve(library ? {ok: true, json: async () => library} : {ok: false, status: 404});
        }
        const fontMatch = /^\/extaudio\/[^/]+\/\d+\/attachment\/(\d+)$/.exec(new URL(url).pathname);
        if (fontMatch) {
          const bytes = attachments[fontMatch[1]] || new Uint8Array([Number(fontMatch[1])]);
          return Promise.resolve({ok: true, arrayBuffer: async () => bytes.buffer});
        }
        const rawMatch = /^\/extaudio\/[^/]+\/(\d+)\/raw$/.exec(new URL(url).pathname);
        if (rawMatch) {
          const bytes = raw[rawMatch[1]];
          return Promise.resolve({ok: Boolean(bytes), status: bytes ? 200 : 502, arrayBuffer: async () => bytes.buffer});
        }
        if (/^\/extaudio\/.+\/audio\.m3u8$/.test(new URL(url).pathname)) {
          const status = rendition.length ? rendition.shift() : 200;
          return Promise.resolve({ok: status === 200, status});
        }
        return new Promise((resolve, reject) => {
          const signal = options?.signal;
          const request = {
            url, options,
            resolve(response) {
              signal?.removeEventListener('abort', abort);
              resolve(response);
            },
          };
          function abort() {
            const index = pending.indexOf(request);
            if (index !== -1) pending.splice(index, 1);
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          }
          pending.push(request);
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
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
  t.after(async () => {
    for (const hls of hlsInstances) hls.destroy();
    destroy();
    await new Promise(setImmediate);
    // Closing playback preserves only bounded ownership lookups: a late
    // redirect can identify an already-created task that still needs removal.
    const discoveries = pending.filter(item => new URL(item.url).pathname === '/gst/start.m3u8');
    assert.equal(timers.size, discoveries.length, 'only pending ownership deadlines may survive close');
    assert.ok([...timers.values()].every(timer => timer.delay === 90000), 'all surviving lookups are bounded to 90 seconds');
    const before = requests.length;
    for (const [id, timer] of [...timers]) {
      timers.delete(id);
      timer.fn();
    }
    await new Promise(setImmediate);
    assert.ok(discoveries.every(item => item.options.signal.aborted), 'expired lookups must abort their requests');
    assert.equal(requests.length, before, 'closed playback must not create new tasks or heartbeats');
    assert.equal(pending.length, 0, 'no pending requests after ownership deadlines');
    assert.equal(timers.size, 0, 'no pending plugin timers after ownership deadlines');
  });

  return {
    loads, storage, requests, destroy, playingStates, notices, context, video: () => video,
    settle: async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); },
    audioMenu: () => audioMenu,
    loaderInstances: TestLoader.instances,
    createHls() {
      const hls = new context.window.Hls({});
      hls.media = video;
      hlsInstances.push(hls);
      return hls;
    },
    explicitPause() { video.pause(); playerVideo.send('pause'); },
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
    startWithSubtitles(tracks, file = 1, hash = 'same-torrent') {
      // Lampa may report subtitles before the player is ready.
      destroy();
      work = { torrent_hash: hash, url: `https://lampa.test/torrserver/gst/${hash}/master.m3u8?index=${file}&audio=0` };
      video = createVideo();
      player.send('create', {data: work});
      player.send('start', work);
      this.emitSubtitles(tracks);
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
    ready() {
      video.readyState = 3;
      video.fire('loadedmetadata');
      video.fire('canplay');
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 0) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    waiting: () => waiting,
    userPlayPause: () => Lampa.PlayerVideo.playpause(),
    audioIndex: () => Number(new URL(work.url).searchParams.get('audio') || 0),
    subtitleTitle: () => subtitles.find(item => item.mode === 'showing')?.label ?? null,
    subtitleMenu: () => Array.from(subtitles, item => item.label),
    subtitleList: () => subtitles,
    currentVideo: () => video,
    replaceVideo() { video = createVideo(); },
    timers,
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

test('HLS loader retries end at one terminal deadline and release the owned task', async t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  await h.task('501');
  const hls = h.createHls();
  const errors = [];
  hls.on('error', (name, error) => errors.push(error));
  hls.trigger('manifestLoading');
  hls.trigger('error', { type: 'networkError', details: 'manifestLoadTimeOut', fatal: false });
  h.fireTimer(180000);
  assert.equal(errors.at(-1).fatal, true);
  assert.equal(hls.stops, 1);
  assert.equal(h.requests.filter(r => new URL(r.url).pathname === '/gst/remove').length, 1);
  assert.ok(h.pending.every(r => r.options.signal.aborted), 'terminal errors cancel track probes');
});

test('HLS init segments do not count as recovery and playable fragments do', t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  const hls = h.createHls();
  hls.trigger('manifestLoading');
  hls.trigger('fragBuffered', { frag: { type: 'main', sn: 'initSegment' } });
  h.fireTimer(180000);
  assert.equal(hls.stops, 1, 'init segments leave the recovery deadline active');
});

test('HLS main fragment cancels the recovery deadline', t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  const hls = h.createHls();
  hls.trigger('manifestLoading');
  hls.trigger('fragBuffered', { frag: { type: 'main', sn: 1 } });
  assert.throws(() => h.fireTimer(180000), /timer 180000 is scheduled/);
  assert.equal(hls.stops, 0);
});

test('fatal HLS retries are bounded and preserve an explicit pause at zero', t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  h.explicitPause();
  const hls = h.createHls();
  const errors = [];
  hls.on('error', (name, error) => errors.push(error));
  const error = { type: 'networkError', details: 'manifestLoadError', fatal: true, response: { code: 503 } };
  hls.trigger('error', { ...error });
  assert.equal(errors.length, 0);
  h.fireTimer(2000);
  assert.equal(hls.sources.length, 1);
  hls.media.play();
  assert.equal(hls.media.paused, true, 'recovery must preserve the explicit pause at 0:00');
  hls.trigger('error', { ...error });
  h.fireTimer(4000);
  hls.trigger('error', { ...error });
  assert.equal(errors.length, 1, 'third fatal failure reaches the application');
  assert.equal(hls.sources.length, 2);
  assert.equal(hls.stops, 1);
});

test('invalid GST manifests report an error without the native raw-video fallback', t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  const hls = h.createHls();
  const errors = [];
  hls.on('error', (name, error) => errors.push(error));
  hls.trigger('error', { fatal: true, details: 'manifestParsingError', reason: 'no EXTM3U delimiter' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, 'Invalid GST HLS manifest (no EXTM3U delimiter)');
  assert.equal(hls.stops, 1);
  assert.equal(hls.sources.length, 0);
});

test('paused audio replacement clears the native loader and can resume through the player controls', async t => {
  const h = harness(t);
  h.start();
  await h.probe(firstEpisode);
  Object.assign(h.currentVideo(), { currentTime: 30, paused: true, muted: false });
  h.chooseAudio('Amediateka (Studio Band)');
  assert.equal(h.waiting(), true);
  h.ready();
  assert.equal(h.currentVideo().currentTime, 30);
  assert.equal(h.currentVideo().paused, true, 'a track change preserves the user pause');
  assert.equal(h.currentVideo().muted, false, 'restore the original mute setting');
  assert.equal(h.waiting(), false, 'a real playing event must clear the native loader before restoring pause');
  assert.ok(h.playingStates.length, 'the replacement must become playable');
  assert.ok(h.playingStates.every(state => state.muted && state.currentTime === 30), 'the paused handoff must stay silent at the saved position');
  h.userPlayPause();
  assert.equal(h.currentVideo().paused, false, 'native playpause must accept input after the track switch');
});

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
  assert.equal(stale.options.signal.aborted, false, 'keep the bounded lookup alive to discover its stale task ID');
  await h.probe(reorderedEpisode, true);
  await h.task('302', h.pending.find(r => r !== stale && new URL(r.url).pathname === '/gst/start.m3u8'));
  await h.task('301', stale);
  assert.equal(stale.options.signal.aborted, false, 'the completed lookup does not need cancellation');
  assert.equal(h.requests.filter(r => new URL(r.url).searchParams.get('id') === '301').length, 1);
  assert.equal(h.requests.filter(r => new URL(r.url).searchParams.get('id') === '302').length, 0);
  h.fireTimer(20000);
  assert.equal(new URL(h.requests.at(-1).url).pathname, '/gst/302/heartbeat');
});

test('closing before the ownership redirect removes the late-created task without restarting playback', async t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  await h.probe(firstEpisode, true);
  const discovery = h.pending.find(r => new URL(r.url).pathname === '/gst/start.m3u8');
  h.destroy();
  assert.equal(discovery.options.signal.aborted, false, 'ownership lookup survives close until its bounded deadline');
  await h.task('401', discovery);
  assert.equal(h.requests.filter(r => new URL(r.url).pathname === '/gst/remove' && new URL(r.url).searchParams.get('id') === '401').length, 1);
  assert.equal(h.requests.filter(r => new URL(r.url).pathname === '/gst/start.m3u8').length, 1, 'closing must not issue a replacement start');
  assert.equal(h.requests.filter(r => /\/heartbeat$/.test(new URL(r.url).pathname)).length, 0);
});

test('ownership discovery has its own 90-second abort deadline', async t => {
  const h = harness(t);
  h.start(1, 'same-torrent', true);
  const discovery = h.pending.find(r => new URL(r.url).pathname === '/gst/start.m3u8');
  const probe = h.pending.find(r => new URL(r.url).pathname === '/gst/probe');
  h.fireTimer(90000);
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

const japaneseAAC = { Type: 'audio', Index: 0, Title: 'Japanese', Language: 'ja', Channels: 2, IsAAC: true };
const anilibria = { file: 1, stream: 0, title: 'AniLibria.tv', location: 'Sound', language: 'rus', codec: 'aac', channels: 2 };
const externalLabel = 'AniLibria.tv (внешняя)';
const externalAudio = { key: '1:0', url: '/extaudio/abc/1/0/copy/audio.m3u8', codecs: 'mp4a.40.2', name: 'AniLibria.tv', language: 'rus' };

test('external audio is offered with one embedded track and reuses the AAC task', async t => {
  const h = harness(t, new Map(), { external: [anilibria] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.task('301');
  assert.ok(h.requests.some(r => new URL(r.url).pathname === '/extaudio/abc/13/tracks'));
  assert.deepEqual(h.audioMenu().map(item => item.label), ['Japanese', externalLabel]);
  const before = h.work().url;
  h.chooseAudio(externalLabel);
  await h.settle();
  assert.deepEqual({ ...h.work().homelab_external_audio }, externalAudio);
  assert.equal(h.work().url, before, 'the running GST task keeps serving video');
  assert.equal(h.loads.at(-1), before);
  assert.deepEqual(h.audioMenu().filter(item => item.selected).map(item => item.label), [externalLabel]);
  assert.equal(h.requests.filter(r => new URL(r.url).pathname === '/gst/remove').length, 0);
  h.ready();
  h.chooseAudio('Japanese');
  assert.equal(h.work().homelab_external_audio, undefined);
  assert.deepEqual(h.audioMenu().filter(item => item.selected).map(item => item.label), ['Japanese']);
});

test('external audio moves the hidden embedded track to AAC to avoid transcoding', async t => {
  const h = harness(t, new Map(), { external: [anilibria] });
  h.start(13, 'abc', true);
  await h.probe([{ ...japaneseAAC, IsAAC: false }, { ...japaneseAAC, Index: 1, Title: 'English', Language: 'en' }]);
  await h.task('311');
  const uid = new URL(h.work().url).searchParams.get('uid');
  h.chooseAudio(externalLabel);
  await h.settle();
  assert.equal(h.audioIndex(), 1);
  assert.notEqual(new URL(h.work().url).searchParams.get('uid'), uid);
});

test('a remembered external track is restored on the next episode', async t => {
  const h = harness(t, new Map(), { external: [anilibria] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  h.chooseAudio(externalLabel);
  await h.settle();
  h.ready();
  h.start(14, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.settle();
  assert.deepEqual({ ...h.work().homelab_external_audio }, externalAudio);
  assert.ok(h.requests.some(r => new URL(r.url).pathname === '/extaudio/abc/14/tracks'));
});

test('external audio keeps current audio playing until the rendition is ready', async t => {
  const h = harness(t, new Map(), { external: [anilibria], rendition: [503, 429] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.task('301');
  const loads = h.loads.length;
  h.chooseAudio(externalLabel);
  await h.settle();
  assert.equal(h.work().homelab_external_audio, undefined);
  assert.equal(h.loads.length, loads, 'playback is not reloaded while the sidecar prepares');
  assert.deepEqual(h.notices, ['Готовлю озвучку: ' + externalLabel]);
  h.fireTimer(2000);
  await h.settle();
  assert.equal(h.work().homelab_external_audio, undefined);
  h.fireTimer(10000);
  await h.settle();
  assert.deepEqual({ ...h.work().homelab_external_audio }, externalAudio);
  assert.equal(h.requests.filter(r => /audio\.m3u8$/.test(new URL(r.url).pathname)).length, 3);
});

test('a failed external rendition keeps the embedded track', async t => {
  const h = harness(t, new Map(), { external: [anilibria], rendition: [502] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.task('301');
  h.chooseAudio(externalLabel);
  await h.settle();
  assert.equal(h.work().homelab_external_audio, undefined);
  assert.deepEqual(h.audioMenu().filter(item => item.selected).map(item => item.label), ['Japanese']);
  assert.equal(h.notices.at(-1), 'Не удалось подготовить озвучку: ' + externalLabel);
});

test('choosing an embedded track cancels external preparation', async t => {
  const h = harness(t, new Map(), { external: [anilibria], rendition: [503] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.task('301');
  h.chooseAudio(externalLabel);
  await h.settle();
  h.chooseAudio('Japanese');
  assert.throws(() => h.fireTimer(2000), /timer 2000 is scheduled/);
  assert.equal(h.work().homelab_external_audio, undefined);
});

test('external audio lookup failure keeps embedded tracks working', async t => {
  const h = harness(t);
  h.start(13, 'abc', true);
  await h.probe(firstEpisode);
  assert.deepEqual(h.audioMenu().map(item => item.label), ['Dream Cast', 'Amediateka (Studio Band)', 'Japanese']);
});

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}
const exact = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
const u32 = (...values) => Buffer.concat(values.map(value => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b; }));
const trak = (id, handler) => box('trak', box('tkhd', u32(0, 0, 0, id, 0)), box('mdia', box('hdlr', u32(0, 0), Buffer.from(handler))));
const trex = id => box('trex', u32(0, id, 1, 0, 0, 0));
const traf = (id, offset) => box('traf', box('tfhd', u32(0x020000, id)), box('tfdt', u32(0, 0)), box('trun', u32(1, 1, offset)));
const types = bytes => {
  const found = [];
  const walk = (start, end) => {
    for (let offset = start; offset < end;) {
      const size = bytes.readUInt32BE(offset);
      const type = bytes.toString('latin1', offset + 4, offset + 8);
      found.push(type);
      if (['moov', 'trak', 'mdia', 'mvex', 'moof', 'traf'].includes(type)) walk(offset + 8, offset + size);
      offset += size;
    }
  };
  walk(0, bytes.length);
  return found;
};

test('external audio rewrites the master playlist and strips embedded audio from main fragments', async t => {
  const h = harness(t, new Map(), { external: [anilibria] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  h.chooseAudio(externalLabel);
  await h.settle();
  const hls = h.createHls();
  const load = (Loader, context, data) => {
    let result = null;
    new Loader({}).load(context, {}, { onSuccess: response => { result = response; }, onError: error => { result = error; } });
    h.loaderInstances.at(-1).callbacks.onSuccess({ data }, {}, context, null);
    return result;
  };

  const manifest = load(hls.config.pLoader, { type: 'manifest' },
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640033,mp4a.40.2",SUBTITLES="subs"\n/gst/1/video.m3u8?audio=0\n');
  assert.equal(manifest.data, '#EXTM3U\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="homelab-external",NAME="AniLibria.tv",LANGUAGE="rus",DEFAULT=YES,AUTOSELECT=YES,URI="/extaudio/abc/1/0/copy/audio.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640033,mp4a.40.2",SUBTITLES="subs",AUDIO="homelab-external"\n/gst/1/video.m3u8?audio=0\n');
  const level = load(hls.config.pLoader, { type: 'level' }, '#EXTM3U\n');
  assert.equal(level.data, '#EXTM3U\n');

  const init = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('mvhd', u32(0)), trak(1, 'vide'), trak(2, 'soun'), box('mvex', trex(1), trex(2)))]);
  const strippedInit = Buffer.from(load(hls.config.fLoader, { frag: { type: 'main', sn: 'initSegment' } }, exact(init)).data);
  assert.deepEqual(types(strippedInit), ['ftyp', 'moov', 'mvhd', 'trak', 'tkhd', 'mdia', 'hdlr', 'mvex', 'trex']);

  const audioTraf = traf(2, 0);
  const fragment = Buffer.concat([box('moof', box('mfhd', u32(0, 1)), traf(1, 500), audioTraf), box('mdat', Buffer.from('samples'))]);
  const stripped = Buffer.from(load(hls.config.fLoader, { frag: { type: 'main', sn: 7 } }, exact(fragment)).data);
  assert.deepEqual(types(stripped), ['moof', 'mfhd', 'traf', 'tfhd', 'tfdt', 'trun', 'mdat']);
  assert.equal(stripped.length, fragment.length - audioTraf.length);
  const trun = stripped.indexOf('trun', 0, 'latin1') - 4;
  assert.equal(stripped.readInt32BE(trun + 16), 500 - audioTraf.length, 'video samples still point into mdat');
  assert.equal(stripped.toString('latin1', stripped.length - 7), 'samples');

  const audio = exact(Buffer.from('external'));
  assert.equal(load(hls.config.fLoader, { frag: { type: 'audio', sn: 0 } }, audio).data, audio);
});

test('external audio handles a leading AUDIO attribute and rejects unsupported fragment layouts', async t => {
  const h = harness(t, new Map(), { external: [anilibria] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  h.chooseAudio(externalLabel);
  await h.settle();
  const hls = h.createHls();
  const load = (Loader, context, data) => {
    let result = null;
    new Loader({}).load(context, {}, { onSuccess: response => { result = response; }, onError: error => { result = error; } });
    h.loaderInstances.at(-1).callbacks.onSuccess({ data }, {}, context, null);
    return result;
  };
  const manifest = load(hls.config.pLoader, { type: 'manifest' },
    '#EXTM3U\n#EXT-X-STREAM-INF:AUDIO="old",BANDWIDTH=1\n/v.m3u8\n');
  assert.match(manifest.data, /#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="homelab-external"\n/);

  const init = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('mvhd', u32(0)), trak(1, 'vide'), trak(2, 'soun'), box('mvex', trex(1), trex(2)))]);
  load(hls.config.fLoader, { frag: { type: 'main', sn: 'initSegment' } }, exact(init));
  const absolute = box('traf', box('tfhd', u32(0x000001, 1, 0, 0)), box('trun', u32(1, 1, 500)));
  const fragment = Buffer.concat([box('moof', box('mfhd', u32(0, 1)), absolute, traf(2, 0)), box('mdat', Buffer.from('x'))]);
  const error = load(hls.config.fLoader, { frag: { type: 'main', sn: 1 } }, exact(fragment));
  assert.equal(error.data, undefined, 'unsupported layouts fail instead of corrupting samples');
});

test('external audio copies codecs the browser decodes and encodes the rest', async t => {
  const tracks = [
    { ...anilibria, file: 1, codec: 'opus', title: 'Opus' },
    { ...anilibria, file: 2, codec: 'ac3', title: 'AC3' },
    { ...anilibria, file: 3, codec: 'dts', title: 'DTS' },
  ];
  const h = harness(t, new Map(), { external: tracks, mse: ['Opus'] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.settle();
  assert.deepEqual(h.audioMenu().filter(item => item.external).map(item => [item.url, item.codecs]), [
    ['/extaudio/abc/1/0/copy/audio.m3u8', 'Opus'],
    ['/extaudio/abc/2/0/aac/audio.m3u8', 'mp4a.40.2'],
    ['/extaudio/abc/3/0/aac/audio.m3u8', 'mp4a.40.2'],
  ]);
  h.chooseAudio('Opus (внешняя)');
  await h.settle();
  const hls = h.createHls();
  let result = null;
  new hls.config.pLoader({}).load({ type: 'manifest' }, {}, { onSuccess: response => { result = response; } });
  h.loaderInstances.at(-1).callbacks.onSuccess({ data: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640033,mp4a.40.2"\n/v.m3u8\n' }, {}, { type: 'manifest' }, null);
  assert.match(result.data, /CODECS="avc1\.640033,Opus",AUDIO="homelab-external"/);
});

test('a diagnostics flag sends every external track through the encoder', async t => {
  const tracks = [
    { ...anilibria, file: 1, codec: 'aac', title: 'AAC' },
    { ...anilibria, file: 2, codec: 'opus', title: 'Opus' },
  ];
  const h = harness(t, new Map([['homelab_extaudio_encode', '1']]), { external: tracks, mse: ['Opus'] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.settle();
  assert.deepEqual(h.audioMenu().filter(item => item.external).map(item => [item.url, item.codecs]), [
    ['/extaudio/abc/1/0/aac/audio.m3u8', 'mp4a.40.2'],
    ['/extaudio/abc/2/0/aac/audio.m3u8', 'mp4a.40.2'],
  ]);
});

test('encoded external audio tells the sidecar where playback is', async t => {
  const h = harness(t, new Map(), { external: [{ ...anilibria, codec: 'dts', title: 'DTS' }] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.task('301');
  h.video().currentTime = 754.6;
  h.chooseAudio('DTS (внешняя)');
  await h.settle();
  const prepared = h.requests.filter(r => /audio\.m3u8/.test(r.url)).map(r => new URL(r.url).pathname + new URL(r.url).search);
  assert.deepEqual(prepared, ['/extaudio/abc/1/0/aac/audio.m3u8?at=754']);
  assert.equal(h.work().homelab_external_audio.url, '/extaudio/abc/1/0/aac/audio.m3u8?at=754');
});

test('an unsupported fragment layout falls back to the embedded track', async t => {
  const h = harness(t, new Map(), { external: [anilibria] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.task('301');
  h.chooseAudio(externalLabel);
  await h.settle();
  const hls = h.createHls();
  const errors = [];
  hls.on('error', (name, data) => errors.push(data));
  hls.trigger('error', { type: 'networkError', details: 'fragLoadError', fatal: false,
    frag: { type: 'main' }, response: { code: 0, text: 'Homelab audio: Unsupported fragment layout' } });
  assert.deepEqual(errors, [], 'the transform error is not retried or reported as a network failure');
  h.fireTimer(0);
  assert.equal(h.work().homelab_external_audio, undefined);
  assert.deepEqual(h.audioMenu().filter(item => item.selected).map(item => item.label), ['Japanese']);
  assert.equal(h.notices.at(-1), 'Внешняя озвучка не поддерживается для этого видео');
});

test('an unsupported fragment layout without an embedded track is reported as fatal', async t => {
  const h = harness(t, new Map(), { external: [anilibria, { ...anilibria, file: 2, title: 'Second' }] });
  h.start(13, 'abc', true);
  const probe = h.pending.find(item => /\/probe$/.test(new URL(item.url).pathname));
  h.pending.splice(h.pending.indexOf(probe), 1);
  probe.resolve({ ok: false });
  await h.settle();
  h.chooseAudio(externalLabel);
  await h.settle();
  const hls = h.createHls();
  const errors = [];
  hls.on('error', (name, data) => errors.push(data));
  hls.trigger('error', { type: 'networkError', details: 'fragLoadError', fatal: false,
    frag: { type: 'main' }, response: { code: 0, text: 'Homelab audio: Unsupported fragment layout' } });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, true);
});

test('a busy external lookup is asked once more', async t => {
  const h = harness(t, new Map(), { external: [anilibria] });
  const fetch = h.context.window.fetch;
  let busy = true;
  h.context.window.fetch = (url, options) => {
    if (busy && /\/tracks$/.test(new URL(url).pathname)) { busy = false; h.requests.push({ url, options }); return Promise.resolve({ ok: false, status: 429 }); }
    return fetch(url, options);
  };
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.settle();
  assert.deepEqual(h.audioMenu().map(item => item.label), []);
  h.fireTimer(5000);
  await h.settle();
  assert.deepEqual(h.audioMenu().map(item => item.label), ['Japanese', externalLabel]);
});

test('players without external audio keep default playlist loaders', async t => {
  const h = harness(t, new Map(), { external: [anilibria] });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  const hls = h.createHls();
  assert.equal(hls.config.pLoader, undefined);
  // Only the subtitle cleanup wraps fragments; main fragments pass unchanged.
  let data = null;
  new hls.config.fLoader({}).load({ frag: { type: 'main', sn: 1 } }, {}, { onSuccess: response => { data = response.data; } });
  const payload = new Uint8Array([1, 2, 3]).buffer;
  h.loaderInstances.at(-1).callbacks.onSuccess({ data: payload }, {}, { frag: { type: 'main' } }, null);
  assert.equal(data, payload);
});

const yakusub = { file: 25, title: 'YakuSub Studio', location: 'YakuSub Studio', language: '', fonts: [37, 38] };
const assLookup = { subtitles: [yakusub], renderer: '/extaudio/jassub/' };
const assText = '[Script Info]\nTitle: Тест\n';

test('external ASS subtitles join the menu and render through JASSUB', async t => {
  FakeAss.instances.length = 0;
  const h = harness(t, new Map(), { ass: assLookup, raw: { 25: new TextEncoder().encode(assText), 37: new TextEncoder().encode('font37'), 38: new TextEncoder().encode('font38') } });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.settle();
  assert.deepEqual(h.subtitleMenu(), ['YakuSub Studio (ASS)'], 'external subtitles form the menu without embedded ones');
  h.emitSubtitles(firstEpisode);
  assert.deepEqual(h.subtitleMenu(), ['надписи', 'English', 'Russian', 'YakuSub Studio (ASS)']);
  h.chooseSubtitle('YakuSub Studio (ASS)');
  await h.settle();
  assert.equal(FakeAss.instances.length, 1);
  const options = FakeAss.instances[0].options;
  assert.equal(options.subContent, assText);
  assert.equal(options.video, h.video());
  assert.deepEqual(Array.from(options.fonts.slice(0, 2), font => new TextDecoder().decode(font)), ['font37', 'font38'], 'fonts arrive as bytes');
  assert.equal(options.fonts[2], 'https://lampa.test/extaudio/jassub/default.woff2', 'the fallback font loads up front');
  assert.equal(options.workerUrl, 'https://lampa.test/extaudio/jassub/jassub-worker.js');
  assert.equal(h.subtitleTitle(), 'YakuSub Studio (ASS)');
  h.chooseSubtitle('English');
  assert.ok(FakeAss.instances[0].destroyed, 'another subtitle removes the ASS layer');
  h.chooseSubtitle('YakuSub Studio (ASS)');
  await h.settle();
  h.destroy();
  assert.ok(FakeAss.instances[1].destroyed, 'closing the player removes the ASS layer');
});

test('a remembered ASS choice returns on the next episode', async t => {
  FakeAss.instances.length = 0;
  const storage = new Map();
  const first = harness(t, storage, { ass: assLookup, raw: { 25: new TextEncoder().encode(assText) } });
  first.start(13, 'abc', true);
  await first.probe([japaneseAAC]);
  await first.settle();
  first.chooseSubtitle('YakuSub Studio (ASS)');
  await first.settle();
  first.start(14, 'abc', true);
  await first.probe([japaneseAAC]);
  first.emitSubtitles(firstEpisode);
  await first.settle();
  assert.equal(first.subtitleTitle(), 'YakuSub Studio (ASS)');
  assert.equal(FakeAss.instances.length, 2);
  assert.ok(FakeAss.instances[0].destroyed && !FakeAss.instances[1].destroyed);
});

test('ASS subtitles without a BOM fall back to Windows-1251', async t => {
  FakeAss.instances.length = 0;
  const cp1251 = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет»
  const h = harness(t, new Map(), { ass: assLookup, raw: { 25: cp1251 } });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.settle();
  h.chooseSubtitle('YakuSub Studio (ASS)');
  await h.settle();
  assert.equal(FakeAss.instances[0].options.subContent, 'Привет');
});

test('a failed ASS download is reported and leaves subtitles off', async t => {
  FakeAss.instances.length = 0;
  const h = harness(t, new Map(), { ass: assLookup });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.settle();
  h.chooseSubtitle('YakuSub Studio (ASS)');
  await h.settle();
  assert.equal(FakeAss.instances.length, 0);
  assert.equal(h.subtitleTitle(), null);
  assert.deepEqual(h.notices, ['Не удалось показать ASS-субтитры']);
});

test('ASS items join subtitles reported before the player was ready', async t => {
  const h = harness(t, new Map(), { ass: assLookup, raw: { 25: new TextEncoder().encode(assText) } });
  h.startWithSubtitles(firstEpisode, 13, 'abc');
  await h.probe([japaneseAAC]);
  await h.settle();
  assert.deepEqual(h.subtitleMenu(), ['надписи', 'English', 'Russian', 'YakuSub Studio (ASS)']);
});

test('a pending ASS download is dropped after another choice or closing', async t => {
  FakeAss.instances.length = 0;
  const h = harness(t, new Map(), { ass: assLookup, raw: { 25: new TextEncoder().encode(assText) } });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  h.emitSubtitles(firstEpisode);
  await h.settle();
  h.chooseSubtitle('YakuSub Studio (ASS)');
  h.chooseSubtitle('English');
  await h.settle();
  assert.equal(FakeAss.instances.length, 0, 'switching away cancels the pending renderer');
  h.chooseSubtitle('YakuSub Studio (ASS)');
  h.destroy();
  await h.settle();
  assert.equal(FakeAss.instances.length, 0, 'closing cancels the pending renderer');
});

test('ASS items leave the menu with their episode', async t => {
  const h = harness(t, new Map(), { ass: assLookup, raw: { 25: new TextEncoder().encode(assText) } });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  await h.settle();
  const panelList = h.subtitleList();
  assert.deepEqual(Array.from(panelList, item => item.label), ['YakuSub Studio (ASS)']);
  h.destroy();
  assert.equal(panelList.length, 0, 'the list the panel kept loses its ASS items');
});

test('ASS rendering follows a new video element after a reload', async t => {
  FakeAss.instances.length = 0;
  const h = harness(t, new Map(), { ass: assLookup, raw: { 25: new TextEncoder().encode(assText) } });
  h.start(13, 'abc', true);
  await h.probe([japaneseAAC]);
  h.emitSubtitles(firstEpisode);
  await h.settle();
  h.chooseSubtitle('YakuSub Studio (ASS)');
  await h.settle();
  h.replaceVideo();
  h.emitSubtitles(firstEpisode);
  await h.settle();
  assert.equal(FakeAss.instances.length, 2);
  assert.ok(FakeAss.instances[0].destroyed);
  assert.equal(FakeAss.instances[1].options.video, h.video());
});

test('ASS vector drawings never reach Lampa as subtitle text', async t => {
  const h = harness(t);
  h.start();
  await h.probe(firstEpisode);
  const hls = h.createHls();
  const vtt = [
    'WEBVTT', 'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0', '',
    '00:00:01.000 --> 00:00:01.040', 'm 345 192 b 374 189 398 163 402 134 l 978 135 977 577 345 577', '',
    '00:00:01.000 --> 00:00:01.040', 'Имя  Неизвестно', '', 'Хозяин:  Никто', '',
    '00:00:02.000 --> 00:00:03.000', '604 403 615 395 631 412 l 743 411 b 753 402', 'КРИСТАЛЛЫ ОПЫТА: 3/100', '',
    '00:00:04.000 --> 00:00:05.000', 'Серия 12', '',
    '00:00:06.000 --> 00:00:07.000', '3 2 1 0', '',
  ].join('\n');
  const results = [];
  for (const [type, data] of [['subtitle', new TextEncoder().encode(vtt).buffer], ['subtitle', vtt], ['main', new TextEncoder().encode(vtt).buffer]]) {
    new hls.config.fLoader({}).load({ frag: { type, sn: 1 } }, {}, { onSuccess: response => results.push(response.data) });
    h.loaderInstances.at(-1).callbacks.onSuccess({ data }, {}, { frag: { type } }, null);
  }
  const cleaned = new TextDecoder().decode(results[0]);
  assert.doesNotMatch(cleaned, /345 192|604 403/);
  assert.match(cleaned, /00:00:02\.000 --> 00:00:03\.000\nКРИСТАЛЛЫ ОПЫТА: 3\/100/);
  assert.match(cleaned, /Имя  Неизвестно/);
  assert.match(cleaned, /Серия 12/);
  assert.match(cleaned, /\n3 2 1 0\n/, 'a countdown is dialogue, not a drawing');
  assert.equal(results[1], cleaned, 'text responses are cleaned the same way');
  assert.equal(new TextDecoder().decode(results[2]), vtt, 'video fragments are untouched');
});

const signsAndFull = [
  track('audio', 0, 'Japanese', 'ja'), track('subtitle', 0, 'Надписи'), track('subtitle', 1, 'SRT'), track('subtitle', 2, 'Полные'),
];
// A font with only a name table: a Windows family name and a Mac full name.
function fontNamed(family) {
  const full = Buffer.from(family + ' Bold', 'latin1');
  const wide = Buffer.from(family, 'utf16le').swap16();
  const name = Buffer.alloc(30 + wide.length + full.length);
  name.writeUInt16BE(2, 2); name.writeUInt16BE(30, 4);
  [[3, 1, wide.length, 0], [1, 4, full.length, wide.length]].forEach(([platform, id, length, offset], i) => {
    const entry = 6 + i * 12;
    name.writeUInt16BE(platform, entry); name.writeUInt16BE(id, entry + 6);
    name.writeUInt16BE(length, entry + 8); name.writeUInt16BE(offset, entry + 10);
  });
  wide.copy(name, 30); full.copy(name, 30 + wide.length);
  const head = Buffer.alloc(28);
  head.writeUInt32BE(0x00010000, 0); head.writeUInt16BE(1, 4);
  head.write('name', 12, 'latin1'); head.writeUInt32BE(28, 20); head.writeUInt32BE(name.length, 24);
  return new Uint8Array(Buffer.concat([head, name]));
}

const embeddedLookup = {
  renderer: '/extaudio/jassub/', fonts: [7, 9],
  subtitles: [
    { stream: 0, codec: 'ass', title: 'Надписи', language: 'rus' },
    { stream: 2, codec: 'subrip', title: 'SRT', language: '' },
    { stream: 3, codec: 'ass', title: 'Полные', language: 'rus' },
  ],
};
const header = '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
const line = second => `Dialogue: 0,0:00:${String(second).padStart(2, '0')}.00,0:00:${String(second + 2).padStart(2, '0')}.00,Default,,0,0,0,,L${second}`;

function eventServer(batches) {
  const asked = [];
  return {
    asked,
    respond(url) {
      asked.push({ stream: url.pathname.split('/').pop(), at: url.searchParams.get('at'), from: Number(url.searchParams.get('from')) });
      const from = Number(url.searchParams.get('from'));
      const lines = batches.slice(0, asked.length).flat();
      const track = Number(url.searchParams.get('track') || 1);
      return { track: this.track ?? track, header: from === 0 ? header : null, lines: lines.slice(from), next: lines.length, more: false, failed: false };
    },
  };
}

async function pollTimer(h) {
  h.fireTimer(3000);
  await h.settle();
}

test('embedded ASS tracks are drawn by JASSUB from events read as playback goes', async t => {
  FakeAss.instances.length = 0;
  const server = eventServer([[line(1), line(3)], [line(3), line(5)]]);
  const h = harness(t, new Map(), { embedded: embeddedLookup, events: url => server.respond(url) });
  h.start(13, 'abc', true);
  await h.probe(signsAndFull);
  h.emitSubtitles(signsAndFull);
  await h.settle();
  assert.deepEqual(h.subtitleMenu(), ['Надписи', 'SRT', 'Полные'], 'labels stay as GST named them');
  const [signs, srt, full] = h.subtitleList();
  assert.ok(signs.homelabAss && full.homelabAss && srt.homelabAss, 'SRT is drawn too: the WebVTT GST makes of it can come out empty');
  h.video().currentTime = 61.25;
  h.chooseSubtitle('Полные');
  await h.settle();
  assert.equal(h.subtitleTitle(), 'Полные');
  assert.deepEqual(server.asked[0], { stream: '3', at: '61.3', from: 0 });
  assert.equal(FakeAss.instances.length, 1);
  const ass = FakeAss.instances[0];
  assert.equal(ass.options.subContent, header);
  assert.deepEqual(Array.from(ass.options.fonts.slice(0, 2), font => font[0]), [7, 9], 'fonts come from the attachments');
  assert.deepEqual(ass.events, [line(1), line(3)]);
  assert.deepEqual(ass.renders, [], 'a playing video redraws with its next frame');
  Object.assign(h.video(), { paused: true, currentTime: 62.5, videoWidth: 1920, videoHeight: 1080 });
  await pollTimer(h);
  assert.equal(server.asked[1].from, 2);
  assert.deepEqual(ass.events, [line(1), line(3), line(5)], 'a repeated event is not added twice');
  assert.deepEqual(JSON.parse(JSON.stringify(ass.renders)), [{ mediaTime: 62.5, width: 1920, height: 1080 }], 'a paused frame is redrawn with the new events');
  h.video().currentTime = 70;
  h.video().fire('seeked');
  await h.settle();
  assert.equal(ass.renders.length, 2, 'a paused seek redraws even when the frame callback stays silent');
  assert.equal(ass.renders[1].mediaTime, 70);
  h.video().paused = false;
  h.video().fire('seeked');
  await h.settle();
  assert.equal(ass.renders.length, 2, 'a playing video redraws by itself');
  h.video().paused = true;
  h.video().fire('seeking');
  h.fireTimer(300);
  await h.settle();
  assert.equal(server.asked.length, 3, 'a seek asks for the new position at once');
  h.chooseSubtitle('SRT');
  await h.settle();
  assert.ok(ass.destroyed);
  assert.equal(h.subtitleTitle(), 'SRT');
  assert.equal(server.asked.at(-1).stream, '2', 'the sidecar converts the SRT stream');
  assert.equal(FakeAss.instances.length, 2);
  h.chooseSubtitle(null);
  await h.settle();
  assert.ok(FakeAss.instances[1].destroyed);
  assert.ok(![...h.timers.values()].some(timer => timer.delay === 3000), 'polling stops with the track');
});

test('a plain-text track already showing switches to its drawn version', async t => {
  FakeAss.instances.length = 0;
  const server = eventServer([[line(1)]]);
  const h = harness(t, new Map(), { embedded: embeddedLookup, events: url => server.respond(url) });
  h.start(13, 'abc', true);
  h.emitSubtitles(signsAndFull);
  h.chooseSubtitle('Надписи');
  await h.probe(signsAndFull);
  await h.settle();
  const signs = h.subtitleList()[0];
  assert.ok(signs.homelabAss);
  assert.equal(signs.mode, 'showing');
  assert.equal(signs.homelabOriginal.mode, 'disabled', 'hls.js no longer loads the WebVTT version');
  assert.equal(server.asked[0].stream, '0');
});

test('embedded ASS falls back to the plain-text track when the sidecar cannot read it', async t => {
  FakeAss.instances.length = 0;
  const h = harness(t, new Map(), { embedded: embeddedLookup, events: () => ({ header: null, lines: [], next: 0, failed: true }) });
  h.start(13, 'abc', true);
  await h.probe(signsAndFull);
  h.emitSubtitles(signsAndFull);
  await h.settle();
  h.chooseSubtitle('Полные');
  await h.settle();
  const full = h.subtitleList()[2];
  assert.ok(!full.homelabAss, 'the broken drawn item leaves the menu');
  assert.equal(h.subtitleTitle(), 'Полные', 'the plain-text track shows instead');
  assert.match(h.notices.at(-1), /простой текст/);
});

test('a quoted title GST rewrote still lines up with the probe', async t => {
  const quoted = [track('audio', 0, 'Japanese', 'ja'), track('subtitle', 0, "'Русские'")];
  const h = harness(t, new Map(), {
    embedded: { ...embeddedLookup, subtitles: [{ stream: 0, codec: 'subrip', title: '"Русские"', language: 'rus' }] },
    events: () => null,
  });
  h.start(13, 'abc', true);
  await h.probe(quoted);
  h.emitSubtitles(quoted);
  await h.settle();
  assert.ok(h.subtitleList()[0].homelabAss);
});

test('embedded ASS stays plain text when the probe does not line up with the menu', async t => {
  const h = harness(t, new Map(), { embedded: { ...embeddedLookup, subtitles: embeddedLookup.subtitles.slice(1) }, events: () => null });
  h.start(13, 'abc', true);
  await h.probe(signsAndFull);
  h.emitSubtitles(signsAndFull);
  await h.settle();
  assert.ok(h.subtitleList().every(item => !item.homelabAss));
  const renamed = harness(t, new Map(), { embedded: embeddedLookup, events: () => null });
  renamed.start(13, 'abc', true);
  await renamed.probe(signsAndFull);
  renamed.emitSubtitles([track('subtitle', 0, 'Other'), track('subtitle', 1, 'SRT'), track('subtitle', 2, 'Полные')]);
  await renamed.settle();
  assert.ok(renamed.subtitleList().every(item => !item.homelabAss));
});

test('a seek during a request asks again once instead of starting a second poll loop', async t => {
  FakeAss.instances.length = 0;
  const server = eventServer([[line(1)], [line(3)], [line(5)]]);
  const h = harness(t, new Map(), { embedded: embeddedLookup, events: url => server.respond(url) });
  h.start(13, 'abc', true);
  await h.probe(signsAndFull);
  h.emitSubtitles(signsAndFull);
  await h.settle();
  h.chooseSubtitle('Полные');
  h.video().fire('seeking');
  h.video().fire('seeking');
  await h.settle();
  assert.equal(server.asked.length, 1);
  const polls = () => [...h.timers.values()].filter(timer => timer.delay === 0 || timer.delay === 300 || timer.delay === 3000);
  assert.equal(polls().length, 1, 'exactly one poll is scheduled');
  assert.equal(polls()[0].delay, 0, 'the seek is asked about right after the request');
  h.fireTimer(0);
  await h.settle();
  assert.equal(server.asked.length, 2);
  assert.equal(polls().length, 1);
});

test('a restarted sidecar track resends events that are not drawn twice', async t => {
  FakeAss.instances.length = 0;
  const server = eventServer([[line(1), line(3)], [line(1), line(3), line(5)]]);
  const h = harness(t, new Map(), { embedded: embeddedLookup, events: url => server.respond(url) });
  h.start(13, 'abc', true);
  await h.probe(signsAndFull);
  h.emitSubtitles(signsAndFull);
  await h.settle();
  h.chooseSubtitle('Полные');
  await h.settle();
  server.track = 2;
  await pollTimer(h);
  assert.equal(server.asked[1].from, 2);
  assert.deepEqual(FakeAss.instances[0].events, [line(1), line(3), line(5)]);
});

test('Lampa sending back its kept list does not make drawn items their own originals', async t => {
  FakeAss.instances.length = 0;
  const server = eventServer([[line(1)]]);
  const h = harness(t, new Map(), { embedded: embeddedLookup, events: url => server.respond(url) });
  h.start(13, 'abc', true);
  await h.probe(signsAndFull);
  h.emitSubtitles(signsAndFull);
  await h.settle();
  const list = h.subtitleList();
  h.context.Lampa.PlayerVideo.listener.send('subs', { subs: list });
  await h.settle();
  assert.equal(list.length, 3);
  assert.ok(list.every(item => item.homelabOriginal !== item));
  assert.ok(!list[0].homelabOriginal.homelabAss);
});

test('embedded ASS is looked up again while TorrServer still fetches the torrent', async t => {
  const answers = [{ ok: false, status: 503 }, { ok: true, json: async () => embeddedLookup }];
  const h = harness(t, new Map(), { embedded: () => answers.shift(), events: () => null });
  h.start(13, 'abc', true);
  h.emitSubtitles(signsAndFull);
  assert.ok(!h.requests.some(request => /\/embedded$/.test(request.url)), 'asked only once GST has opened the file');
  await h.probe(signsAndFull);
  await h.settle();
  assert.ok(h.subtitleList().every(item => !item.homelabAss));
  h.fireTimer(5000);
  await h.settle();
  assert.ok(h.subtitleList()[0].homelabAss);
});

test('Windows fonts a release does not attach are drawn with metric-compatible stand-ins', async t => {
  FakeAss.instances.length = 0;
  const styled = header.replace('[Events]', '[V4+ Styles]\nStyle: fon,Comic Sans MS,55,&H00FFFFFF\nStyle: Default,Open Sans Semibold,50,&H00FFFFFF\n\n[Events]');
  const sign = 'Dialogue: 0,0:00:01.00,0:00:03.00,fon,,0,0,0,,{\\fnTimes New Roman\\b1}Имя{\\fncalibri} Тип';
  const h = harness(t, new Map(), {
    embedded: embeddedLookup,
    events: url => ({ track: 1, header: url.searchParams.get('from') === '0' ? styled : null, lines: [sign], next: 1, more: false, failed: false }),
  });
  h.start(13, 'abc', true);
  await h.probe(signsAndFull);
  h.emitSubtitles(signsAndFull);
  await h.settle();
  h.chooseSubtitle('Полные');
  await h.settle();
  const ass = FakeAss.instances[0];
  assert.match(ass.options.subContent, /Style: fon,Comic Relief,55,/);
  assert.match(ass.options.subContent, /Style: Default,Open Sans Semibold,50,/, 'attached fonts keep their names');
  assert.deepEqual(ass.events, ['Dialogue: 0,0:00:01.00,0:00:03.00,fon,,0,0,0,,{\\fnTinos\\b1}Имя{\\fnCarlito} Тип']);
  assert.equal(ass.options.availableFonts['comic relief bold'], 'https://lampa.test/extaudio/jassub/comic-relief-bold.ttf');
  assert.equal(ass.options.availableFonts['tinos'], 'https://lampa.test/extaudio/jassub/tinos-regular.ttf');
  assert.deepEqual(Array.from(ass.options.fonts).filter(font => typeof font === 'string'), [
    'https://lampa.test/extaudio/jassub/default.woff2',
    'https://lampa.test/extaudio/jassub/comic-relief-regular.ttf', 'https://lampa.test/extaudio/jassub/comic-relief-bold.ttf',
  ], 'a stand-in the styles use loads up front; one only in \\fn tags waits until asked');
});

test('fonts kept from other releases are drawn instead of stand-ins', async t => {
  FakeAss.instances.length = 0;
  const styled = header.replace('[Events]', '[V4+ Styles]\nStyle: fon,Comic Sans MS,55,&H00FFFFFF\nStyle: Default,Tahoma,50,&H00FFFFFF\n\n[Events]');
  const sign = 'Dialogue: 0,0:00:01.00,0:00:03.00,fon,,0,0,0,,{\\fnImpact}Нати{\\fnTimes New Roman} Тип';
  const h = harness(t, new Map(), {
    embedded: embeddedLookup,
    library: {
      fonts: { 'tahoma': 'a.ttf', 'tahoma regular': 'a.ttf', 'tahoma bold': 'b.ttf', 'impact': 'c.ttf', 'comic sans ms': 'd.ttf' },
      families: { 'tahoma': ['a.ttf', 'b.ttf'], 'impact': ['c.ttf'], 'comic sans ms': ['d.ttf'] },
    },
    events: url => ({ track: 1, header: url.searchParams.get('from') === '0' ? styled : null, lines: [sign], next: 1, more: false, failed: false }),
  });
  h.start(13, 'abc', true);
  await h.probe(signsAndFull);
  h.emitSubtitles(signsAndFull);
  await h.settle();
  h.chooseSubtitle('Полные');
  await h.settle();
  const ass = FakeAss.instances[0];
  assert.match(ass.options.subContent, /Style: fon,Comic Sans MS,55,/, 'the real font beats a stand-in');
  assert.deepEqual(ass.events, ['Dialogue: 0,0:00:01.00,0:00:03.00,fon,,0,0,0,,{\\fnImpact}Нати{\\fnTinos} Тип']);
  assert.equal(ass.options.availableFonts['tahoma bold'], 'https://lampa.test/extaudio/fonts/b.ttf');
  assert.equal(ass.options.availableFonts['impact'], 'https://lampa.test/extaudio/fonts/c.ttf');
  assert.deepEqual(ass.added, ['https://lampa.test/extaudio/fonts/c.ttf'], 'a font named in \\fn tags loads with its events');
  assert.deepEqual(Array.from(ass.options.fonts).filter(font => typeof font === 'string'), [
    'https://lampa.test/extaudio/jassub/default.woff2', 'https://lampa.test/extaudio/fonts/d.ttf',
    'https://lampa.test/extaudio/fonts/a.ttf', 'https://lampa.test/extaudio/fonts/b.ttf',
  ], 'fonts the styles use load up front');
  assert.equal(h.requests.filter(request => request.url.endsWith('/fonts/index.json')).length, 1);
});

test('a Windows font the release attaches keeps its name instead of a stand-in', async t => {
  FakeAss.instances.length = 0;
  const styled = header.replace('[Events]', '[V4+ Styles]\nStyle: fon,Comic Sans MS,55,&H00FFFFFF\n\n[Events]');
  const sign = 'Dialogue: 0,0:00:01.00,0:00:03.00,fon,,0,0,0,,{\\fnComic Sans MS\\b1}Нати{\\fnTimes New Roman} Тип';
  const h = harness(t, new Map(), {
    embedded: embeddedLookup,
    attachments: { 9: fontNamed('Comic Sans MS') },
    events: url => ({ track: 1, header: url.searchParams.get('from') === '0' ? styled : null, lines: [sign], next: 1, more: false, failed: false }),
  });
  h.start(13, 'abc', true);
  await h.probe(signsAndFull);
  h.emitSubtitles(signsAndFull);
  await h.settle();
  h.chooseSubtitle('Полные');
  await h.settle();
  const ass = FakeAss.instances[0];
  assert.match(ass.options.subContent, /Style: fon,Comic Sans MS,55,/);
  assert.deepEqual(ass.events, ['Dialogue: 0,0:00:01.00,0:00:03.00,fon,,0,0,0,,{\\fnComic Sans MS\\b1}Нати{\\fnTinos} Тип'], 'only the missing family is replaced');
  assert.deepEqual(Array.from(ass.options.fonts).filter(font => typeof font === 'string'), ['https://lampa.test/extaudio/jassub/default.woff2']);
});
