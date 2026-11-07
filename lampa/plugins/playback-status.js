(function () {
  'use strict';
  var L = window.Lampa, $ = window.jQuery;
  if (!L || !$ || window.homelabPlaybackStatus || !L.Player || !L.Player.listener || !L.PlayerVideo || !L.PlayerVideo.listener || !L.PlayerPanel || !L.Noty) return;
  if (![L.Player.playdata, L.Player.listener.follow, L.PlayerVideo.video,
    L.PlayerVideo.listener.follow, L.PlayerPanel.render, L.Noty.show, L.Player.opened].every(function (fn) { return typeof fn === 'function'; })) return;
  window.homelabPlaybackStatus = {version: 3};
  var state = null, boundAudio = null, retryButton = null, sourceButton = null;
  function scope() { return window.HomelabSync ? window.HomelabSync.scope() : L.Timeline.filename(); }
  function valid(s) { return state === s && L.Player.opened() && L.Player.playdata() === s.work && scope() === s.scope; }
  function currentVideo(s) { return valid(s) && s.video && s.video === L.PlayerVideo.video(); }
  function canChoose(s) { return s.work.card && Number.isInteger(s.work.card.id) && (!s.work.card.name || Number.isInteger(s.work.season) && s.work.season >= 0 && +s.work.episode > 0) && window.HomelabSources && typeof window.HomelabSources.recover === 'function'; }
  function panel() {
    if (retryButton) return;
    var p = L.PlayerPanel.render(); if (!p || !p.length) return;
    retryButton = $('<div class="button selector hide homelab-playback-retry"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4a8 8 0 1 1-8 8H2a10 10 0 1 0 3-7L2 2v7h7L6.5 6.5A8 8 0 0 1 12 4z"/></svg><div class="tooltip">Повторить воспроизведение</div></div>').on('hover:enter', function () { recover(true); });
    sourceButton = $('<div class="button selector hide homelab-playback-source"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 6h12V3l6 4-6 4V8H3zm18 12H9v3l-6-4 6-4v3h12z"/></svg><div class="tooltip">Другой источник</div></div>').on('hover:enter', function () { recover(false); });
    p.find('.player-panel__subs').after(retryButton).after(sourceButton);
  }
  function actions(s, show) {
    if (retryButton) retryButton.toggleClass('hide', !show);
    if (sourceButton) sourceButton.toggleClass('hide', !show || !canChoose(s));
  }
  function capture(s) {
    if (!currentVideo(s)) return;
    var at = s.video.currentTime, duration = s.video.duration;
    if (Number.isFinite(at) && (at > 0 || s.video.readyState >= 1 && (s.video.seeking || s.started))) { s.position = Math.max(0, at); s.started = true; }
    if (Number.isFinite(duration) && duration > 0) s.duration = duration;
  }
  function recover(same) {
    var s = state; if (!s || !valid(s) || !s.actionable || Date.now() - s.retryAt < 5000) return;
    s.retryAt = Date.now(); capture(s);
    if ((!same || s.work.homelab_online) && canChoose(s)) {
      if (!window.HomelabSources.recover(s.work, {position: s.position, duration: s.duration}, same)) L.Noty.show('Откройте источник заново');
      return;
    }
    var audio = L.HomelabGstAudio;
    if (!audio || !audio.retryCurrent || !audio.retryCurrent()) L.Noty.show('Повторный запуск недоступен. Откройте видео заново');
    else { bind(s); set('preparing'); arm(s); }
  }
  function set(phase, stalled) {
    var s = state; if (!s || !valid(s)) return;
    s.phase = phase; s.actionable = phase === 'failed' || !!stalled;
    actions(s, s.actionable);
  }
  function arm(s) {
    if (!currentVideo(s) || s.stall) return;
    var video = s.video, at = video.currentTime;
    s.stall = setTimeout(function () {
      s.stall = null;
      if (!currentVideo(s) || s.video !== video || video.paused || video.seeking || video.ended || window.document && window.document.hidden) return;
      if (Math.abs(video.currentTime - at) > .5) return arm(s);
      set('buffering', true);
    }, 30000);
  }
  function cancelStall(s) { clearTimeout(s.stall); s.stall = null; }
  function unbind(s) {
    if (!s) return;
    cancelStall(s); clearTimeout(s.rebind);
    if (s.video) Object.keys(s.events).forEach(function (name) { s.video.removeEventListener(name, s.events[name]); });
    s.video = null;
  }
  function bind(s) {
    if (!valid(s)) return;
    var video = L.PlayerVideo.video(); if (!video || s.video === video) return;
    unbind(s); s.video = video;
    // A replacement's initial zero is not a playback observation from the old video.
    s.started = false;
    function waiting() { if (currentVideo(s)) { set(s.phase === 'recovering' ? 'recovering' : 'buffering', s.actionable); arm(s); } }
    function ready(phase) { if (currentVideo(s)) { cancelStall(s); capture(s); set(phase); } }
    s.events = {waiting: waiting, stalled: waiting, playing: function () { ready('playing'); }, canplay: function () { ready('ready'); },
      pause: function () { cancelStall(s); }, seeking: function () { cancelStall(s); },
      seeked: function () { if (currentVideo(s)) { capture(s); if (!video.paused && video.readyState < 3) waiting(); } },
      timeupdate: function () { if (currentVideo(s)) { var old = s.position; capture(s); if (Math.abs(s.position - old) > .5) { cancelStall(s); set(video.paused ? 'ready' : 'playing'); } } },
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
    state = {work: work, scope: scope(), phase: 'preparing', retryAt: -Infinity, position: Number(work.homelab_resume_at) || 0, duration: 0, started: false};
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
    if (state && !state.video) bind(state);
    if (!state || !currentVideo(state) || !event || event.fatal === false || event.fatal !== true && !state.video.error) return;
    capture(state); cancelStall(state); set('failed');
  });
  if (window.HomelabSync && window.HomelabSync.subscribe) window.HomelabSync.subscribe(function () { if (state && scope() !== state.scope) clear(); });
  audioReady(); window.addEventListener('homelab:audio-ready', audioReady);
  if (L.Player.opened()) { start(L.Player.playdata()); if (state) bind(state); }
})();
