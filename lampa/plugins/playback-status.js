(function () {
  'use strict';
  var L = window.Lampa, $ = window.jQuery;
  if (!L || !$ || window.homelabPlaybackStatus || !L.Player || !L.Player.listener || !L.PlayerVideo || !L.PlayerVideo.listener || !L.PlayerPanel || !L.Noty) return;
  if (![L.Player.playdata, L.Player.listener.follow, L.PlayerVideo.video,
    L.PlayerVideo.listener.follow, L.PlayerPanel.render, L.Noty.show, L.Player.opened].every(function (fn) { return typeof fn === 'function'; })) return;
  window.homelabPlaybackStatus = {version: 4};
  var state = null, boundAudio = null, retryButton = null, sourceButton = null;
  function scope() { return window.HomelabSync ? window.HomelabSync.scope() : L.Timeline.filename(); }
  function valid(s) { return state === s && L.Player.opened() && L.Player.playdata() === s.work && scope() === s.scope; }
  function currentVideo(s) { return valid(s) && s.video && s.video === L.PlayerVideo.video(); }
  function canChoose(s) { return s.work.card && Number.isInteger(s.work.card.id) && (!s.work.card.name || Number.isInteger(s.work.season) && s.work.season >= 0 && +s.work.episode > 0) && window.HomelabSources && typeof window.HomelabSources.recover === 'function'; }
  function gstRetry(s) {
    var audio = L.HomelabGstAudio; if (!audio || typeof audio.retryCurrent !== 'function') return false;
    return typeof audio.canRetry === 'function' ? !!audio.canRetry(s.work) : true;
  }
  function canRetry(s) { return s.work.homelab_online && canChoose(s) || !s.work.homelab_online && gstRetry(s); }
  function panel() {
    if (retryButton) return;
    var p = L.PlayerPanel.render(); if (!p || !p.length) return;
    retryButton = $('<div class="button selector hide homelab-playback-retry"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4a8 8 0 1 1-8 8H2a10 10 0 1 0 3-7L2 2v7h7L6.5 6.5A8 8 0 0 1 12 4z"/></svg><div class="tooltip">Повторить воспроизведение</div></div>').on('hover:enter', function () { recover(true); });
    sourceButton = $('<div class="button selector hide homelab-playback-source"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 6h12V3l6 4-6 4V8H3zm18 12H9v3l-6-4 6-4v3h12z"/></svg><div class="tooltip">Другой источник</div></div>').on('hover:enter', function () { recover(false); });
    p.find('.player-panel__subs').after(sourceButton).after(retryButton);
  }
  function toggle(button, show) {
    if (!button) return;
    var focused = !show && button.hasClass('focus') && !button.hasClass('hide');
    button.toggleClass('hide', !show);
    // A hidden selector keeps the remote's focus otherwise.
    if (focused && L.Controller && typeof L.Controller.collectionFocus === 'function') {
      var p = L.PlayerPanel.render(), target = p && p.find('.player-panel__playpause');
      if (target && target.length) L.Controller.collectionFocus(target[0], p);
    }
  }
  function actions(s, show) {
    // Retry would discard the GST plugin's own recovery while it is running.
    toggle(retryButton, show && s.phase !== 'recovering' && canRetry(s));
    toggle(sourceButton, show && canChoose(s));
  }
  function capture(s) {
    if (!currentVideo(s)) return;
    var at = s.video.currentTime, duration = s.video.duration;
    if (Number.isFinite(at) && (at > 0 || s.video.readyState >= 1 && (s.video.seeking || s.started))) { s.position = Math.max(0, at); s.started = s.observed = true; }
    if (Number.isFinite(duration) && duration > 0) s.duration = duration;
  }
  // Lampa's Timeline resume rules, for a failure before anything was observed.
  function resumeAt(s) {
    var at = Number(s.work.homelab_resume_at); if (at > 0) return at;
    var tl = s.work.timeline, mode = L.Storage && typeof L.Storage.field === 'function' ? L.Storage.field('player_timecode') : '';
    if (!tl || mode === 'again' || tl.continued_bloc) return 0;
    var duration = s.duration || Number(tl.duration) || 0, percent = Number(tl.percent), exact = parseFloat(tl.time + '');
    if (!(exact > 0 && (!duration || exact < duration))) exact = duration ? Math.round(duration * percent / 100) : 0;
    if (!(exact > 10 && percent < 90)) return 0;
    return duration && exact > duration - 15 ? Math.max(0, duration - 15) : exact;
  }
  function recover(same) {
    var s = state; if (!s || !valid(s) || !s.actionable) return;
    if (Date.now() - s.retryAt < 5000) { L.Noty.show('Перезапуск уже выполняется, подождите'); return; }
    s.retryAt = Date.now(); capture(s);
    if ((!same || s.work.homelab_online) && canChoose(s)) {
      if (!window.HomelabSources.recover(s.work, {position: s.observed ? s.position : resumeAt(s), duration: s.duration}, same)) { s.retryAt = -Infinity; L.Noty.show('Откройте источник заново'); }
      return;
    }
    var audio = L.HomelabGstAudio;
    if (!audio || !audio.retryCurrent || !audio.retryCurrent()) { s.retryAt = -Infinity; L.Noty.show('Повторный запуск недоступен. Откройте видео заново'); }
    else { bind(s); set('preparing'); arm(s); }
  }
  function set(phase, stalled) {
    var s = state; if (!s || !valid(s)) return;
    s.phase = phase; s.actionable = phase === 'failed' || !!stalled;
    if (s.actionable) s.mark = s.video ? s.video.currentTime : 0;
    actions(s, s.actionable);
  }
  function arm(s) {
    if (!currentVideo(s) || s.stall) return;
    var video = s.video, at = video.currentTime;
    s.stall = setTimeout(function () {
      s.stall = null;
      if (!currentVideo(s) || s.video !== video || s.userPaused || video.ended) return;
      // Before MANIFEST_LOADED hls.js leaves the element paused without data;
      // paused with playable data is a blocked autoplay, not a stall.
      // Players without pause events (Tizen AVPlay) report a user pause only
      // through paused after playback has started.
      if (window.document && window.document.hidden || video.paused && (s.started || video.readyState >= 3) || Math.abs(video.currentTime - at) > .5) return arm(s);
      set(s.phase === 'recovering' ? 'recovering' : 'buffering', true);
    }, 30000);
  }
  function cancelStall(s) { clearTimeout(s.stall); s.stall = null; }
  function unbind(s) {
    if (!s) return;
    cancelStall(s); clearTimeout(s.rebind);
    // The Tizen AVPlay wrapper has no removeEventListener; currentVideo() guards stale events.
    if (s.video && typeof s.video.removeEventListener === 'function') Object.keys(s.events).forEach(function (name) { s.video.removeEventListener(name, s.events[name]); });
    s.video = null;
  }
  function bind(s) {
    if (!valid(s)) return;
    var video = L.PlayerVideo.video(); if (!video || s.video === video) return;
    unbind(s); s.video = video;
    // A replacement's initial zero is not a playback observation from the old video.
    s.started = false; s.userPaused = false; s.reserve = !!s.work.url_reserve;
    function waiting() { if (currentVideo(s)) { set(s.phase === 'recovering' ? 'recovering' : 'buffering', s.actionable); arm(s); } }
    function ready(phase) { if (currentVideo(s)) { cancelStall(s); capture(s); set(phase); } }
    s.events = {waiting: waiting, stalled: waiting, playing: function () { ready('playing'); }, canplay: function () { ready('ready'); },
      pause: function () { if (!video.ended) s.userPaused = true; cancelStall(s); },
      play: function () { s.userPaused = false; if (currentVideo(s)) arm(s); },
      // A seek into missing torrent pieces may never complete.
      seeking: function () { if (currentVideo(s)) { cancelStall(s); capture(s); if (!video.paused) arm(s); } },
      seeked: function () { if (currentVideo(s)) { capture(s); if (!video.paused && video.readyState < 3) waiting(); } },
      timeupdate: function () { if (currentVideo(s)) { capture(s); if (s.actionable && s.phase !== 'failed' && !video.seeking && Math.abs(video.currentTime - s.mark) > .5) set(video.paused ? 'ready' : 'playing'); } },
      error: function () { if (currentVideo(s)) { capture(s); cancelStall(s); set('failed'); } }};
    Object.keys(s.events).forEach(function (name) { video.addEventListener(name, s.events[name]); });
    capture(s);
    if (video.readyState >= 3) set(video.paused ? 'ready' : 'playing'); else arm(s);
  }
  function clear() {
    if (state) { unbind(state); actions(state, false); }
    state = null;
  }
  function start(work) {
    clear();
    if (!work || !work.homelab_online && !/^[a-f0-9]{40}$/i.test(work.homelab_torrent_hash || work.torrent_hash || '')) return;
    panel();
    state = {work: work, scope: scope(), phase: 'preparing', retryAt: -Infinity, position: 0, observed: false, duration: 0, started: false, userPaused: false, reserve: !!work.url_reserve};
    set('preparing');
  }
  function audioReady() {
    var audio = L.HomelabGstAudio;
    if (!audio || audio === boundAudio || !audio.subscribe) return;
    boundAudio = audio;
    audio.subscribe(function (event) {
      if (!state || !valid(state) || state.work !== event.work) return;
      if (['preparing', 'recovering', 'failed'].indexOf(event.type) >= 0) { set(event.type); if (event.type !== 'failed') arm(state); }
      if (event.type === 'buffered' && state.phase === 'recovering') set('ready');
    });
  }
  L.Player.listener.follow('start', start);
  L.Player.listener.follow('ready', function (work) { if (!state || state.work !== work) start(work); if (state) bind(state); });
  L.Player.listener.follow('destroy', clear);
  L.PlayerVideo.listener.follow('loadeddata', function () { if (state) bind(state); });
  L.PlayerVideo.listener.follow('destroy', function (event) { if (state) { unbind(state); if (event && event.savemeta) { set('preparing'); var s = state; s.rebind = setTimeout(function () { if (valid(s)) bind(s); }, 0); } } });
  L.PlayerVideo.listener.follow('error', function (event) {
    // Upstream Player handles a fatal error first by switching to url_reserve.
    if (state && state.reserve && !state.work.url_reserve) { state.reserve = false; return; }
    if (state && !state.video) bind(state);
    if (!state || !currentVideo(state) || !event || event.fatal === false || event.fatal !== true && !state.video.error) return;
    capture(state); cancelStall(state); set('failed');
  });
  if (window.HomelabSync && window.HomelabSync.subscribe) window.HomelabSync.subscribe(function () { if (state && scope() !== state.scope) clear(); });
  audioReady(); window.addEventListener('homelab:audio-ready', audioReady);
  if (L.Player.opened()) { start(L.Player.playdata()); if (state) bind(state); }
})();
