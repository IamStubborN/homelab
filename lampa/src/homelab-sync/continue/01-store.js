(function install() {
  'use strict';
  // Public methods exist before native storage, favorites and menu are initialized.
  if (!window.appready) {
    var listener = window.Lampa && window.Lampa.Listener;
    if (listener && typeof listener.follow === 'function') listener.follow('app', function (event) {
      if (event.type === 'ready') install();
    });
    return;
  }
  var L = window.Lampa, sync = window.HomelabSync;
  if (!L || !sync || !sync.url || window.homelabContinue) return;
  if (!L.Player || !L.Player.listener || !L.PlayerVideo || !L.PlayerVideo.listener || !L.Timeline || !L.Controller || !L.Api || !L.Utils || !L.Router || !L.Noty) return;
  if (![window.fetch, window.AbortController, L.ContentRows && L.ContentRows.add,
    L.Torserver && L.Torserver.files, L.Torserver && L.Torserver.stream,
    L.Torserver && L.Torserver.parse, L.Torserver && L.Torserver.clearFileName,
    L.Timeline.view, L.Timeline.link, L.Player.play, L.Player.playlist,
    L.PlayerVideo.video, L.Player.listener.follow, L.PlayerVideo.listener.follow,
    L.Scroll, L.Subscribe, L.Maker && L.Maker.make, L.Layer && L.Layer.visible, L.Controller.own, L.Controller.collectionSet, L.Controller.collectionFocus,
    L.Controller.add, L.Controller.toggle, L.Controller.enabled, L.Api.img, L.Router.call, L.Noty.show,
    L.Utils.secondsToTime, L.Player.opened, window.$,
    sync.scope, sync.pull, sync.rows, sync.extra, sync.subscribe].every(function (fn) { return typeof fn === 'function'; })) return;
  var items = [], scope = '', reading = null, readAt = -Infinity, listeners = [], playing = null, pending = {}, sending = null, restore = null, metadata = {}, resolving = {}, metadataQueue = [], metadataRunning = 0, resumeIntent = null, writeTimer = null, writeError = false, readError = false, external = null, loadedOnce = false;
  var CACHE = 'homelab_continue_cache', EPISODES = 'homelab_continue_episodes', DAY = 86400000, NEWER = 120000;
  // Titles, posters and season sizes from the last session, so the row
  // starts in its final look instead of repainting each tile as TMDB answers.
  var remembered = {}, lastKey = 0;
  // Any key, click or touch while a launch is still being prepared hands
  // control back to the user (the online component then owns its own input).
  function interrupted() {
    var intent = resumeIntent;
    if (intent && !intent.launched && Date.now() - intent.created >= 500) cancelResume();
  }
  if (L.Keypad && L.Keypad.listener && typeof L.Keypad.listener.follow === 'function') L.Keypad.listener.follow('keydown', function () { lastKey = Date.now(); interrupted(); });
  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') ['mousedown', 'touchstart'].forEach(function (name) { document.addEventListener(name, interrupted, true); });
  function intentNew() { return resumeIntent = {created: Date.now()}; }
  function cancelResume() { if (window.HomelabOnlineResume) window.HomelabOnlineResume.cancel(); if (resumeIntent) clearTimeout(resumeIntent.timer); resumeIntent = null; }
  function plain(value) { return String(value || '').replace(/[<>"'`]/g, ''); }
  function context() {
    var key = sync.scope();
    if (scope !== key) {
      scope = key; items = cached(key); remembered = cachedMetadata(key); metadata = {}; resolving = {}; metadataQueue = []; metadataRunning = 0; readAt = -Infinity; pending = {}; writeError = false; readError = false; loadedOnce = false; external = null;
      clearTimeout(writeTimer);
      if (reading) reading.abort.abort(); reading = null;
      if (sending) sending.abort.abort(); sending = null;
      cancelResume();
      publish();
    }
    return key;
  }
  function publish() { listeners.slice().forEach(function (fn) { fn(); }); }
  // The last server list is kept per scope so the main row renders at once.
  function cached(key) {
    var value = null;
    try { value = L.Storage.get(CACHE, null); } catch (_) {}
    return key && value && value.scope === key && Array.isArray(value.items) ? value.items.map(normal).filter(accepted) : [];
  }
  function cachedMetadata(key) {
    var value = null, result = {};
    try { value = L.Storage.get(CACHE, null); } catch (_) {}
    if (!key || !value || value.scope !== key || !value.metadata || typeof value.metadata !== 'object') return result;
    Object.keys(value.metadata).forEach(function (card) {
      var entry = value.metadata[card], clean = {};
      if (!/^(tv|movie)_\d+$/.test(card) || !entry || typeof entry !== 'object') return;
      if (typeof entry.title === 'string') clean.title = plain(entry.title).slice(0, 200);
      ['poster', 'backdrop'].forEach(function (name) { if (typeof entry[name] === 'string' && /^\/[\w.-]+$/.test(entry[name])) clean[name] = entry[name]; });
      if (entry.seasons && typeof entry.seasons === 'object') {
        clean.seasons = {};
        Object.keys(entry.seasons).forEach(function (n) { if (/^\d{1,3}$/.test(n) && Number.isInteger(entry.seasons[n])) clean.seasons[n] = entry.seasons[n]; });
      }
      var aired = entry.aired;
      if (aired && Number.isInteger(aired.season) && Number.isInteger(aired.episode) && /^\d{4}-\d{2}-\d{2}$/.test(aired.date || '')) clean.aired = {season: aired.season, episode: aired.episode, date: aired.date};
      result[card] = clean;
    });
    return result;
  }
  function persist() {
    var shown = items.slice(0, 50), kept = {};
    // Cards that only exist in Lampa's own history need their titles kept too.
    var cards = merged().filter(function (item) { return !item.deleted; }).sort(function (a, b) { return b.observed - a.observed; }).slice(0, 50);
    cards.forEach(function (item) { var value = Object.assign({}, remembered[item.card] || {}, metadata[item.card] || {}); if (Object.keys(value).length) kept[item.card] = value; });
    try { L.Storage.set(CACHE, {scope: scope, items: shown, metadata: kept}, true); } catch (_) {}
  }
  // Lampac omits default values such as a zero position.
  function normal(item) { return item && !item.deleted && item.position === undefined ? Object.assign({}, item, {position: 0}) : item; }
  function accepted(item) {
    if (!item || !/^(tv|movie)_\d+$/.test(item.card)) return false;
    return item.deleted === true ? Number.isFinite(item.observed) : Number.isFinite(item.position) && Number.isFinite(item.duration);
  }
  function load(done) {
    done = done || function () {};
    var key = context(), url = sync.url('/homelab-sync/resume');
    if (!url) return done();
    if (reading) { reading.callbacks.push(done); return; }
    if (Date.now() - readAt < 15000) return done();
    var job = reading = {abort: new AbortController(), callbacks: [done]}, timer = setTimeout(function () { job.abort.abort(); }, 10000);
    readAt = Date.now();
    fetch(url, {signal: job.abort.signal, cache: 'no-store'}).then(function (r) { if (!r.ok) throw new Error('resume'); return r.json(); }).then(function (data) {
      if (context() !== key || reading !== job) return;
      if (data.version !== 1 || !Array.isArray(data.items)) throw new Error('contract');
      items = data.items.map(normal).filter(accepted).map(function (item) {
        // Lampac omits default-valued season=0 from captured Specials records.
        return item.card.indexOf('tv_') === 0 && item.season === undefined && !item.deleted && (item.kind === 'online' || item.kind === 'torrent') ? Object.assign({}, item, {season: 0}) : item;
      });
      var writes = Object.keys(pending).map(function (card) { return pending[card]; });
      if (sending && sending.queued.scope === key) writes.push(sending.queued);
      writes.forEach(function (write) {
        var queued = write.item, newer = items.find(function (item) { return item.card === queued.card && item.observed >= queued.observed; });
        if (!newer) { items = items.filter(function (item) { return item.card !== queued.card; }); items.unshift(queued); }
      });
      readError = false; loadedOnce = true;
      persist(); publish();
    }).catch(function () { if (context() === key) { readError = true; loadedOnce = true; publish(); } }).then(function () {
      clearTimeout(timer); if (reading === job) reading = null; enrich(); job.callbacks.splice(0).forEach(function (callback) { callback(); });
    });
  }
  function later(next, old) {
    if (!Number.isInteger(next.season) || !(next.episode > 0)) return false;
    // Specials have no position in the regular order; recency decides.
    if (next.season === 0 || !Number.isInteger(old.season) || old.season === 0) return true;
    return next.season > old.season || next.season === old.season && next.episode > old.episode;
  }
  function merged() {
    context();
    var byCard = {}, captured = {}, natives = {};
    items.forEach(function (item) { byCard[item.card] = Object.assign({}, item); captured[item.card] = true; });
    sync.rows().forEach(function (row) {
      var extra = sync.extra(row), key = extra.card;
      if (!/^(tv|movie)_\d+$/.test(key || '')) return;
      var old = byCard[key];
      // Native TimeCode stamps even a stale paused player's close as new. For
      // the captured episode (or movie) a newer native row only moves the
      // position forward, when it is watched or clearly further, and keeps
      // the source. Another episode replaces the record (without its source)
      // only when it is a later episode, or any episode once a special is
      // involved, viewed at least a minute and stamped more than two minutes
      // after the capture: the native player saves every two minutes, so
      // an active viewing keeps stamping while an old close does not. A
      // dismissed card returns on any newer viewing.
      if (captured[key]) {
        if (old.deleted) {
          if (!row.deleted && row.watched_at > old.observed && row.position > 1 && (!natives[key] || natives[key].watched_at < row.watched_at)) natives[key] = row;
          return;
        }
        if (row.deleted && String(row.hash) === old.timeline && row.watched_at > old.observed) { old.deleted = true; return; }
        if (row.deleted || !(row.watched_at > old.observed) || !(row.position > 1) || natives[key] && natives[key].watched_at >= row.watched_at) return;
        var same = key.indexOf('movie_') === 0 || extra.season === old.season && extra.episode === old.episode;
        // Another cut of the same episode has its own positions.
        if (same && old.timeline != null && String(row.hash) !== old.timeline) return;
        if (same ? watched(row) || row.position > old.position + 30 :
          key.indexOf('tv_') === 0 && row.watched_at > old.observed + NEWER && row.position >= 60 && later(extra, old)) natives[key] = row;
        return;
      }
      if (old && old.observed >= row.watched_at) return;
      var same = old && row.hash != null && String(row.hash) === old.timeline && (key.indexOf('movie_') === 0 || old.season === extra.season && old.episode === extra.episode);
      byCard[key] = Object.assign({}, old ? {title: old.title, poster: old.poster, backdrop: old.backdrop} : {}, same ? old : {}, {card: key, season: Number.isInteger(extra.season) && extra.season >= 0 ? extra.season : undefined, episode: extra.episode || 0,
        position: row.position, duration: row.duration, observed: row.watched_at, deleted: row.deleted});
    });
    Object.keys(natives).forEach(function (key) {
      var row = natives[key], extra = sync.extra(row), old = byCard[key];
      if (!old.deleted && (key.indexOf('movie_') === 0 || extra.season === old.season && extra.episode === old.episode)) {
        byCard[key] = Object.assign(old, {position: row.position, duration: row.duration, observed: row.watched_at});
        return;
      }
      byCard[key] = {card: key, title: old.title, poster: old.poster, backdrop: old.backdrop, original: old.original, date: old.date,
        season: Number.isInteger(extra.season) && extra.season >= 0 ? extra.season : undefined, episode: extra.episode || 0,
        timeline: row.hash != null ? String(row.hash) : undefined, position: row.position, duration: row.duration, observed: row.watched_at};
    });
    return Object.keys(byCard).map(function (key) { return Object.assign({}, byCard[key], remembered[key] || {}, metadata[key] || {}); });
  }
