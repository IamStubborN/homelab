(function () {
  'use strict';
  var L = window.Lampa, $ = window.jQuery;
  if (!L || !$ || window.homelabPlaybackStatus || !L.Player || !L.Player.listener || !L.PlayerVideo || !L.PlayerVideo.listener || !L.PlayerPanel || !L.Noty) return;
  if (![L.Player.playdata, L.Player.listener.follow, L.PlayerVideo.video,
    L.PlayerVideo.listener.follow, L.PlayerPanel.render, L.Noty.show, L.Player.opened].every(function (fn) { return typeof fn === 'function'; })) return;
  window.homelabPlaybackStatus = {version: 5};
  // Short buffering blips stay invisible, Lampa's own loader covers a fast
  // start; a long start suggests another source.
  var DEBOUNCE = 700, START_DELAY = 2500, ESCALATE = 20000, STATS_EVERY = 2000, CTRL = 'homelab_playback_card';
  var state = null, boundAudio = null, retryButton = null, sourceButton = null, card = null;
  function scope() { return window.HomelabSync ? window.HomelabSync.scope() : L.Timeline.filename(); }
  function valid(s) { return state === s && L.Player.opened() && L.Player.playdata() === s.work && scope() === s.scope; }
  function currentVideo(s) { return valid(s) && s.video && s.video === L.PlayerVideo.video(); }
  function canChoose(s) { return s.work.card && Number.isInteger(s.work.card.id) && (!s.work.card.name || Number.isInteger(s.work.season) && s.work.season >= 0 && Number.isInteger(s.work.episode) && s.work.episode > 0) && window.HomelabSources && typeof window.HomelabSources.recover === 'function'; }
  function gstRetry(s) {
    var audio = L.HomelabGstAudio; if (!audio || typeof audio.retryCurrent !== 'function') return false;
    return typeof audio.canRetry === 'function' ? !!audio.canRetry(s.work) : true;
  }
  function canRetry(s) { return s.work.homelab_online && canChoose(s) || !s.work.homelab_online && gstRetry(s); }
  // Retry would discard the GST plugin's own recovery while it is running.
  function retryShown(s) { return s.actionable && s.phase !== 'recovering' && canRetry(s); }
  function sourceShown(s) { return (s.actionable || s.escalated) && canChoose(s); }
  function torrentHash(work) { var hash = work.homelab_torrent_hash || work.torrent_hash || ''; return /^[a-f0-9]{40}$/i.test(hash) ? hash : ''; }
  function controller() { var c = L.Controller && typeof L.Controller.enabled === 'function' && L.Controller.enabled(); return c && c.name || ''; }
  function panel() {
    if (retryButton) return;
    var p = L.PlayerPanel.render(); if (!p || !p.length) return;
    retryButton = $('<div class="button selector hide homelab-playback-retry"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4a8 8 0 1 1-8 8H2a10 10 0 1 0 3-7L2 2v7h7L6.5 6.5A8 8 0 0 1 12 4z"/></svg><div class="tooltip">Повторить</div></div>').on('hover:enter', function () { recover(true); });
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
    toggle(retryButton, show && retryShown(s));
    toggle(sourceButton, (show || s.escalated) && canChoose(s));
  }

  // ---- State card: one calm line about what is happening, actions when stuck.
  var CSS = '.homelab-playback-card{position:fixed;left:0;right:0;top:50%;margin-top:5em;padding:0 1em;text-align:center;pointer-events:none}' +
    '.homelab-playback-card__box{display:inline-block;position:relative;max-width:36em;min-width:18em;padding:1em 1.4em 1em 4.3em;text-align:left;background:rgba(0,0,0,.72);border-radius:1em;pointer-events:auto;-webkit-animation:homelab-playback-in .25s ease-out;animation:homelab-playback-in .25s ease-out}' +
    '.homelab-playback-card__icon{position:absolute;left:1.3em;top:1.05em;width:2em;height:2em;color:#fff}' +
    '.homelab-playback-card__icon svg{display:block;width:2em;height:2em}' +
    '.homelab-playback-card__spin{-webkit-animation:homelab-playback-spin 1s linear infinite;animation:homelab-playback-spin 1s linear infinite}' +
    '.homelab-playback-card--alert .homelab-playback-card__icon{color:#f5c36b}' +
    '.homelab-playback-card__title{font-size:1.5em;font-weight:600;line-height:1.3}' +
    '.homelab-playback-card__detail,.homelab-playback-card__hint{font-size:1.15em;line-height:1.35;margin-top:.3em}' +
    '.homelab-playback-card__detail{opacity:.7}' +
    '.homelab-playback-card__actions{display:-webkit-box;display:-webkit-flex;display:flex;-webkit-flex-wrap:wrap;flex-wrap:wrap;margin-top:.9em}' +
    '.homelab-playback-card__actions .simple-button{margin:0 1em 0 0;background-color:rgba(255,255,255,.1)}' +
    '.homelab-playback-card__actions .simple-button.focus{background-color:#fff;color:#000}' +
    '@-webkit-keyframes homelab-playback-spin{to{-webkit-transform:rotate(360deg)}}@keyframes homelab-playback-spin{to{transform:rotate(360deg)}}' +
    '@-webkit-keyframes homelab-playback-in{from{opacity:0;-webkit-transform:translateY(.5em)}to{opacity:1;-webkit-transform:none}}@keyframes homelab-playback-in{from{opacity:0;transform:translateY(.5em)}to{opacity:1;transform:none}}';
  var ICON = {
    wait: '<svg class="homelab-playback-card__spin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2.5"/><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v7h-2zm0 9h2v2h-2z"/></svg>'
  };
  function buttons() { return card ? [card.retry, card.source].filter(function (b) { return !b.hasClass('hide'); }) : []; }
  function preferred() {
    // After a retry that did not help, the other source is the better default.
    if (state && state.attempts && !card.source.hasClass('hide')) return card.source;
    return buttons()[0];
  }
  function toPanel() { if (state) state.autoFocus = false; if (typeof L.PlayerPanel.toggle === 'function') L.PlayerPanel.toggle(); else L.Controller.toggle('player'); }
  function moveFocus(step) {
    var list = buttons(), index = -1;
    list.forEach(function (b, i) { if (b.hasClass('focus')) index = i; });
    var next = list[index + step];
    // The edges hand the remote to the panel instead of trapping it.
    if (next) L.Controller.collectionFocus(next[0], card.actions); else toPanel();
  }
  function release() { if (controller() === CTRL && L.Player.opened()) L.Controller.toggle('player'); }
  function dismiss() {
    var auto = state && state.autoFocus;
    if (state) { state.dismissed = true; state.autoFocus = false; }
    hideCard(); if (controller() === CTRL) L.Controller.toggle('player');
    // The user never asked for the card's focus: Back still means the player's Back.
    if (auto && controller() === 'player' && typeof L.Controller.back === 'function') L.Controller.back();
  }
  function menuOpen() { return !!(L.Select && typeof L.Select.opened === 'function' && L.Select.opened()); }
  function cardView() {
    if (card) return card;
    var root = typeof L.Player.render === 'function' && L.Player.render(); if (!root || !root.length) return null;
    $('head').append($('<style></style>').text(CSS));
    card = {root: $('<div class="homelab-playback-card hide"></div>'), box: $('<div class="homelab-playback-card__box"></div>'),
      icon: $('<div class="homelab-playback-card__icon"></div>'), title: $('<div class="homelab-playback-card__title"></div>'),
      detail: $('<div class="homelab-playback-card__detail hide"></div>'), hint: $('<div class="homelab-playback-card__hint hide"></div>'),
      actions: $('<div class="homelab-playback-card__actions hide"></div>'),
      retry: $('<div class="simple-button selector hide homelab-playback-card__retry"><span>Повторить</span></div>').on('hover:enter', function () { recover(true); }),
      source: $('<div class="simple-button selector hide homelab-playback-card__source"><span>Другой источник</span></div>').on('hover:enter', function () { recover(false); }),
      visible: false, text: {}, timer: null, statTimer: null, layout: ''};
    var body = $('<div class="homelab-playback-card__body"></div>');
    card.box.attr('role', 'status').attr('aria-live', 'polite');
    card.actions.append(card.retry).append(card.source);
    body.append(card.title).append(card.detail).append(card.hint).append(card.actions);
    card.box.append(card.icon).append(body); card.root.append(card.box); root.append(card.root);
    if (L.Controller && typeof L.Controller.add === 'function') L.Controller.add(CTRL, {
      toggle: function () {
        // Whatever returns here after the actions are gone goes to the player.
        if (!card.visible || !buttons().length) return L.Controller.toggle('player');
        L.Controller.collectionSet(card.actions); L.Controller.collectionFocus(preferred()[0], card.actions);
      },
      left: function () { moveFocus(-1); }, right: function () { moveFocus(1); }, up: function () {},
      down: toPanel,
      gone: function () { card.retry.removeClass('focus'); card.source.removeClass('focus'); },
      back: dismiss
    });
    // Lampa's menus stack above the player; the card steps aside meanwhile.
    if (L.Select && L.Select.listener && typeof L.Select.listener.follow === 'function') ['toggle', 'fullshow', 'hide', 'close'].forEach(function (name) {
      L.Select.listener.follow(name, function () { setTimeout(render, 0); });
    });
    return card;
  }
  function line(node, key, value) {
    if (card.text[key] === value) return;
    card.text[key] = value;
    node.text(value); if (key !== 'title') node.toggleClass('hide', !value);
  }
  function plural(n, one, few, many) { var a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many; }
  function rate(bytes) {
    var mb = bytes / 1048576;
    if (mb >= 1) return (mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)) + ' МБ/с';
    return Math.round(bytes / 1024) + ' КБ/с';
  }
  // TorrServer /cache: peers, download speed and how much is read ahead of GST.
  function statsText(data) {
    var torrent = data && typeof data === 'object' && (data.Torrent || data); if (!torrent || typeof torrent !== 'object') return '';
    var parts = [], peers = parseInt(torrent.active_peers, 10), speed = Number(torrent.download_speed);
    if (peers >= 0) parts.push(peers + ' ' + plural(peers, 'пир', 'пира', 'пиров'));
    if (torrent.download_speed !== undefined && speed >= 0 && Number.isFinite(speed)) parts.push(rate(speed));
    var reader = data.Readers && data.Readers[0], pieces = data.Pieces;
    if (reader && pieces && Number(reader.End) > Number(reader.Reader)) {
      var from = Number(reader.Reader), end = Number(reader.End), at = from;
      while (at < end && pieces[at] && pieces[at].Completed) at++;
      parts.push('буфер ' + Math.round((at - from) * 100 / (end - from)) + '%');
    }
    return parts.length ? 'Торрент: ' + parts.join(' · ') : '';
  }
  // Lampa's own TorrServer cache request; only while a card is on screen.
  function pollStats(s) {
    var ts = L.Torserver;
    if (!card || card.statTimer || !s.hash || !ts || typeof ts.cache !== 'function' || typeof ts.url === 'function' && !ts.url()) return;
    (function poll() {
      card.statTimer = setTimeout(poll, STATS_EVERY);
      // Lampa's shared TorrServer request can be aborted without callbacks.
      if (s.statAsked && Date.now() - s.statAsked < 6000) return;
      var asked = s.statAsked = Date.now();
      function done(data) { if (s.statAsked !== asked) return; s.statAsked = 0; if (state !== s || !card.visible) return; s.stats = statsText(data); render(); }
      try { ts.cache(s.hash, done, function () { if (s.statAsked === asked) s.statAsked = 0; }); } catch (error) { s.statAsked = 0; }
    })();
  }
  function hideCard() {
    if (!card) return;
    clearTimeout(card.timer); card.timer = null;
    clearTimeout(card.statTimer); card.statTimer = null;
    if (card.visible) { card.visible = false; card.root.addClass('hide'); }
    if (state) state.stats = '';
    release();
  }
  function kindOf(s) {
    if (s.phase === 'failed') return 'failed';
    if (s.actionable) return 'stall';
    if (s.phase === 'playing' || s.phase === 'ready' || !s.stuck || s.userPaused && s.playedOnce) return '';
    if (s.phase === 'recovering') return 'recovering';
    return s.phase === 'preparing' || !s.playedOnce ? 'preparing' : 'buffering';
  }
  function elapsedText(ms) { var sec = Math.max(1, Math.floor(ms / 1000)); return sec < 60 ? sec + ' с' : Math.floor(sec / 60) + ' мин ' + sec % 60 + ' с'; }
  function content(s, kind, elapsed, retry, source) {
    if (kind === 'preparing') return {title: 'Подготовка видео… ' + elapsedText(elapsed), detail: s.stats || (s.hash ? 'Подключаемся к раздаче' : 'Загружаем видео'),
      hint: s.escalated ? 'Долго? Можно выбрать другой источник' : ''};
    if (kind === 'buffering') return {title: 'Буферизация… ' + elapsedText(elapsed), detail: s.stats, hint: ''};
    if (kind === 'recovering') return {title: 'Восстановление… ' + elapsedText(elapsed), detail: s.stats || 'Поток перезапускается автоматически', hint: ''};
    var title = kind === 'failed' ? 'Не удалось воспроизвести' : s.seekStuck ? 'Перемотка не завершилась' : s.playedOnce ? 'Воспроизведение остановилось' : 'Видео не загружается';
    return {title: title, detail: kind === 'stall' ? s.stats || 'Нет данных больше 30 с' : '',
      hint: retry && source ? 'Повторите или выберите другой источник' : retry ? 'Попробуйте повторить' : source ? 'Выберите другой источник' : 'Закройте и откройте видео заново'};
  }
  function render() {
    var s = state, c = card;
    if (!c) return;
    clearTimeout(c.timer); c.timer = null;
    if (!s || !valid(s)) return hideCard();
    var kind = kindOf(s), now = Date.now(), waiting = kind === 'preparing' || kind === 'buffering' || kind === 'recovering';
    if (kind !== s.kind) {
      if (waiting || !kind) s.since = now;
      s.kind = kind; s.dismissed = false; s.offered = false; s.autoFocus = false;
      if (s.escalated) { s.escalated = false; actions(s, s.actionable); }
    }
    if (!kind || s.dismissed || menuOpen()) return hideCard();
    var elapsed = now - s.since;
    if (kind === 'preparing' && !s.escalated && elapsed >= ESCALATE && canChoose(s)) { s.escalated = true; actions(s, s.actionable); }
    var delay = kind === 'preparing' ? START_DELAY : DEBOUNCE;
    if (waiting && elapsed < delay) { hideCard(); c.timer = setTimeout(render, delay - elapsed); return; }
    var retry = retryShown(s), source = sourceShown(s), text = content(s, kind, elapsed, retry, source);
    var layout = (waiting ? 'wait' : 'alert') + (retry ? ':retry' : '') + (source ? ':source' : ''), changed = c.layout !== layout;
    line(c.title, 'title', text.title); line(c.detail, 'detail', text.detail || ''); line(c.hint, 'hint', text.hint);
    if (changed) {
      if (c.layout.split(':')[0] !== layout.split(':')[0]) { c.icon.html(waiting ? ICON.wait : ICON.alert); c.root.toggleClass('homelab-playback-card--alert', !waiting); }
      c.retry.toggleClass('hide', !retry); c.source.toggleClass('hide', !source); c.actions.toggleClass('hide', !retry && !source);
      c.layout = layout;
    }
    if (!c.visible) { c.visible = true; c.root.removeClass('hide'); }
    if (waiting) c.timer = setTimeout(render, 1000 - elapsed % 1000);
    if (kind !== 'failed') pollStats(s);
    var name = controller();
    if (!retry && !source) { if (name === CTRL) L.Controller.toggle('player'); return; }
    if (name === CTRL) { if (changed) L.Controller.toggle(CTRL); return; }
    // Take the remote only from the bare player: in the panel the user may be
    // seeking away from a broken spot, and the panel has the same actions.
    if (!s.offered && name === 'player') { s.offered = true; s.autoFocus = true; L.Controller.toggle(CTRL); }
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
    // Before a stall, only a slow start may offer another source.
    var s = state; if (!s || !valid(s) || !s.actionable && !(s.escalated && !same)) return;
    if (Date.now() - s.retryAt < 5000) { L.Noty.show('Перезапуск уже выполняется, подождите'); return; }
    s.retryAt = Date.now(); capture(s);
    if ((!same || s.work.homelab_online) && canChoose(s)) {
      if (same) s.attempts++;
      if (!window.HomelabSources.recover(s.work, {position: s.observed ? s.position : resumeAt(s), duration: s.duration}, same)) { s.retryAt = -Infinity; L.Noty.show('Откройте источник заново'); }
      return;
    }
    var audio = L.HomelabGstAudio;
    if (!audio || !audio.retryCurrent || !audio.retryCurrent()) { s.retryAt = -Infinity; L.Noty.show('Повторный запуск недоступен. Откройте видео заново'); }
    else { s.attempts++; s.stuck = true; bind(s); set('preparing'); arm(s); }
  }
  function set(phase, stalled) {
    var s = state; if (!s || !valid(s)) return;
    s.phase = phase; s.actionable = phase === 'failed' || !!stalled;
    if (s.actionable) s.mark = s.video ? s.video.currentTime : 0;
    if (phase === 'playing' || phase === 'ready') { s.stuck = false; s.seekStuck = false; }
    actions(s, s.actionable);
    render();
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
      s.seekStuck = !!video.seeking;
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
    s.started = false; s.userPaused = false; s.playedOnce = false; s.reserve = !!s.work.url_reserve;
    function waiting() { if (currentVideo(s)) { if (!s.stuck) { s.stuck = true; s.stuckAt = video.currentTime; } set(s.phase === 'recovering' ? 'recovering' : 'buffering', s.actionable); arm(s); } }
    function ready(phase) { if (currentVideo(s)) { cancelStall(s); capture(s); if (phase === 'playing') s.playedOnce = true; set(phase); } }
    s.events = {waiting: waiting, stalled: waiting, playing: function () { ready('playing'); }, canplay: function () { ready('ready'); },
      pause: function () { if (!video.ended) s.userPaused = true; cancelStall(s); if (currentVideo(s)) render(); },
      play: function () { s.userPaused = false; if (currentVideo(s)) { arm(s); render(); } },
      // A seek into missing torrent pieces may never complete.
      seeking: function () { if (currentVideo(s)) { cancelStall(s); capture(s); if (!video.paused) arm(s); } },
      seeked: function () { if (currentVideo(s)) { capture(s); if (!video.paused && video.readyState < 3) waiting(); } },
      timeupdate: function () {
        if (!currentVideo(s)) return;
        capture(s);
        if (video.seeking) return;
        if (s.actionable && s.phase !== 'failed' && Math.abs(video.currentTime - s.mark) > .5) return set(video.paused ? 'ready' : 'playing');
        // Some players resume without a playing event; progress alone ends the wait.
        if (s.stuck && !s.actionable && !video.paused && Math.abs(video.currentTime - s.stuckAt) > .5) {
          s.stuck = false; s.playedOnce = true;
          if (s.phase === 'preparing' || s.phase === 'buffering') set('playing'); else render();
        }
      },
      error: function () { if (currentVideo(s)) { capture(s); cancelStall(s); set('failed'); } }};
    Object.keys(s.events).forEach(function (name) { video.addEventListener(name, s.events[name]); });
    capture(s);
    if (video.readyState >= 3) set(video.paused ? 'ready' : 'playing');
    else { s.stuck = true; s.stuckAt = video.currentTime; arm(s); render(); }
  }
  function clear() {
    if (state) { unbind(state); state.escalated = false; actions(state, false); }
    state = null;
    hideCard();
  }
  function start(work) {
    clear();
    if (!work || !work.homelab_online && !/^[a-f0-9]{40}$/i.test(work.homelab_torrent_hash || work.torrent_hash || '')) return;
    panel(); cardView();
    state = {work: work, scope: scope(), phase: 'preparing', retryAt: -Infinity, position: 0, observed: false, duration: 0, started: false, userPaused: false,
      reserve: !!work.url_reserve, stuck: true, stuckAt: 0, since: Date.now(), kind: '', attempts: 0, hash: work.homelab_online ? '' : torrentHash(work)};
    set('preparing');
  }
  function audioReady() {
    var audio = L.HomelabGstAudio;
    if (!audio || audio === boundAudio || !audio.subscribe) return;
    boundAudio = audio;
    audio.subscribe(function (event) {
      if (!state || !valid(state) || state.work !== event.work) return;
      if (event.type === 'preparing') state.stuck = true;
      if (['preparing', 'recovering', 'failed'].indexOf(event.type) >= 0) { set(event.type); if (event.type !== 'failed') arm(state); }
      if (event.type === 'buffered' && state.phase === 'recovering') set('ready');
    });
  }
  L.Player.listener.follow('start', start);
  L.Player.listener.follow('ready', function (work) { if (!state || state.work !== work) start(work); if (state) bind(state); });
  L.Player.listener.follow('destroy', clear);
  L.PlayerVideo.listener.follow('loadeddata', function () { if (state) bind(state); });
  L.PlayerVideo.listener.follow('destroy', function (event) { if (state) { unbind(state); if (event && event.savemeta) { state.stuck = true; set('preparing'); var s = state; s.rebind = setTimeout(function () { if (valid(s)) bind(s); }, 0); } } });
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
