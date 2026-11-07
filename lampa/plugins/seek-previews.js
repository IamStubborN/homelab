(function () {
  'use strict';
  if (window.homelabSeekPreviews) return;

  function install() {
    if (window.homelabSeekPreviews) return;
    var L = window.Lampa, $ = window.jQuery;
    if (!L || !L.Player || !L.Player.listener || !L.PlayerVideo || !L.PlayerVideo.listener ||
        !L.PlayerPanel || !L.PlayerPanel.listener || !L.Select || !L.Select.listener || !L.Storage || !L.Controller) return;
    if (![$, window.fetch, window.AbortController, L.Player.playdata, L.Player.listener.follow,
        L.PlayerVideo.video, L.PlayerVideo.to, L.PlayerVideo.listener.follow, L.PlayerPanel.render,
        L.PlayerPanel.listener.follow, L.Select.show, L.Select.closeAll, L.Select.listener.follow,
        L.Controller.toggle, L.Controller.enabled, L.Storage.get, L.Storage.set, L.Storage.field].every(function (method) {
      return typeof method === 'function';
    })) return;
    var subscribers = [];
    var api = window.homelabSeekPreviews = {version: 3,
      current: function () { return current ? {key: current.base, info: current.info, failed: !!current.failed, enabled: enabled} : null; },
      subscribe: function (fn) { subscribers.push(fn); return function () { subscribers = subscribers.filter(function (value) { return value !== fn; }); }; },
      setEnabled: function (value) {
        enabled = !!value; L.Storage.set('homelab_seek_frames', enabled); hide();
        if (current) { if (enabled) bindPreparation(current); else stopPreparation(current); }
        publish();
      },
      retryMetadata: function () { if (current && current.failed && !current.metaRequest && Date.now() >= current.metaManualAt) startMetadata(current); }
    };
    function publish() { subscribers.slice().forEach(function (fn) { fn(); }); }
    var current = null, button = null, overlay = null, sequence = 0, pendingTime = 0, selection = null, menuVisible = false;
    var retryDelays = [5000, 15000, 60000];
    var enabled = L.Storage.get('homelab_seek_frames', true) !== false;
    var icon = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M3 10h5M3 15h5M12 9h6M12 14h6"/></svg>';
    var seekPanel = null, seekButtons = [];
    $('<style>' + [
      '.homelab-seek-controls .player-panel__center{gap:.5em}',
      '.player-panel .homelab-seek-step{background:#ffffff1a;min-width:44px;min-height:44px}.player-panel .homelab-seek-step svg{width:32px!important;height:32px!important;flex-shrink:0}',
      '.player-panel.panel--norewind .homelab-seek-step,.player.iptv .homelab-seek-step{display:none}',
      'body.true--mobile .homelab-seek-controls .player-panel__center{flex:0 0 168px;gap:8px}',
      'body.true--mobile .homelab-seek-controls .player-panel__left,body.true--mobile .homelab-seek-controls .player-panel__right{flex:1;width:auto}',
      '@media(max-width:580px){body.true--mobile .homelab-seek-controls .player-panel__line-two{flex-wrap:wrap;row-gap:8px}body.true--mobile .homelab-seek-controls .player-panel__center{order:-1;flex-basis:100%}}'
    ].join('') + '</style>').appendTo('head');
    function seekLabels() {
      var step = Math.max(5, Number(L.Storage.field('player_rewind')) || 20);
      seekButtons.forEach(function (entry) {
        entry.button.find('text').text(step);
        entry.button.attr('aria-label', (entry.forward ? 'Вперёд' : 'Назад') + ' на ' + step + ' с');
      });
    }
    function seekControls() {
      // Platform.screen('tv') also includes desktop browsers; tv() identifies actual TVs.
      if (!L.Platform || typeof L.Platform.tv !== 'function' || L.Platform.tv() || typeof L.PlayerVideo.rewind !== 'function') return;
      var panel = L.PlayerPanel.render();
      if (!panel || !panel.length || panel[0] === seekPanel || panel.find('.player-panel__rprev,.player-panel__rnext').length) return;
      var center = panel.find('.player-panel__center'), play = center.find('.player-panel__playpause');
      if (!center.length || !play.length) return;
      seekPanel = panel[0]; seekButtons = [];
      [false, true].forEach(function (forward) {
        var button = $('<div class="button selector homelab-seek-step homelab-seek-' + (forward ? 'forward' : 'back') + '" role="button"></div>');
        button.html('<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><g' + (forward ? ' transform="translate(32 0) scale(-1 1)"' : '') + '><path d="M7 10a11 11 0 1 1-2 12M7 4v6H1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g><text x="16" y="20" text-anchor="middle" fill="currentColor" font-size="12" font-weight="600"></text></svg>');
        button.on('hover:enter', function () {
          var data = L.Player.playdata(), video = L.PlayerVideo.video();
          if (!data || data.iptv || panel.hasClass('panel--norewind') || !video || !Number.isFinite(video.duration) || video.duration <= 0) return;
          L.PlayerVideo.rewind(forward);
        });
        if (forward) play.after(button); else play.before(button);
        seekButtons.push({button: button, forward: forward});
      });
      panel.addClass('homelab-seek-controls');
      seekLabels();
    }
    if (L.Storage.listener && typeof L.Storage.listener.follow === 'function') L.Storage.listener.follow('change', function (event) {
      if (event.name === 'player_rewind') seekLabels();
    });
    $('<style>.homelab-seek-preview{position:absolute;bottom:8em;left:50%;transform:translateX(-50%);width:clamp(140px,18vw,280px);max-width:70vw;background:#17191f;border-radius:.5em;overflow:hidden;text-align:center;pointer-events:none;z-index:5;box-shadow:0 .2em 1em #0008}.homelab-seek-preview img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain}.homelab-seek-preview__label{padding:.4em;font-size:max(.8em,11px)}.homelab-seek-preview__note{padding:.2em .4em;font-size:max(.7em,10px);color:#bbb}.homelab-seek-preview.hide{display:none}.player-panel:not(.panel--visible) .homelab-seek-preview{visibility:hidden}.player-panel .homelab-chapters{width:auto;padding:.65em .9em;border-radius:2em;gap:.4em}.homelab-chapters>span{font-size:.75em;white-space:nowrap}body.true--mobile .homelab-chapters>span{display:none}body.true--mobile .homelab-chapters{min-width:44px;min-height:44px}body.true--mobile .player-panel .button{width:44px;height:44px;padding:10px}body.true--mobile .player-panel .player-panel__playpause{width:64px;height:64px;padding:16px}body.true--mobile .player-panel__left .homelab-chapter-controls{margin-left:2px}</style>').appendTo('head');

    function plain(value) {
      return String(value).replace(/[<>"'`]/g, function (c) { return {'<':'‹','>':'›','"':'″',"'":'’','`':'ʼ'}[c]; });
    }
    function time(value) {
      var n = Math.floor(value), hours = Math.floor(n / 3600);
      return (hours ? hours + ':' : '') + ('0' + Math.floor(n / 60) % 60).slice(-2) + ':' + ('0' + n % 60).slice(-2);
    }
    function identity(data) {
      if (!data) return null;
      // The audio side plugin preserves original file identity before GST replaces its URL.
      var hash = data.homelab_torrent_hash || data.torrent_hash, index = data.homelab_file_index;
      if (index === undefined && data.torrent_hash) {
        try { index = Number(new URL(data.url, window.location.href).searchParams.get('index')); } catch (_) {}
      }
      if (!/^[a-f0-9]{40}$/i.test(hash || '') || !Number.isInteger(index) || index < 1 || index > 999999) return null;
      if (L.Platform && typeof L.Platform.is === 'function' && L.Platform.is('android') && L.Storage.field('player_torrent') !== 'inner') return null;
      return '/previews/' + hash.toLowerCase() + '/' + index + '/';
    }
    function live(state) { return current === state && L.Player.playdata() === state.data; }
    function cancelFrame(state) {
      if (!state) return;
      clearTimeout(state.debounce); clearTimeout(state.poll); clearTimeout(state.hide); clearTimeout(state.frameDeadline); state.frameDeadline = null;
      if (state.frameAbort) state.frameAbort.abort();
      state.blob = null;
      state.request = ++sequence;
      state.slot = null;
      state.frameFailed = false; state.frameFailures = 0;
    }
    function hide() {
      cancelFrame(current);
      if (overlay) overlay.addClass('hide').find('img').removeAttr('src');
    }
    function clear() {
      hide();
      if (current) {
        stopPreparation(current);
        (current.frames || []).forEach(function (entry) { URL.revokeObjectURL(entry.url); });
        if (current.metaRequest) current.metaRequest.abort.abort();
        clearTimeout(current.metaTimer); clearTimeout(current.metaDeadline);
      }
      if (menuVisible) L.Select.closeAll();
      selection = null; menuVisible = false;
      var panel = L.PlayerPanel.render();
      if (panel) panel.off('.homelabPreview');
      current = null;
      if (button) button.addClass('hide');
      publish();
    }
    function panelElements() {
      var panel = L.PlayerPanel.render();
      if (!panel || !panel.length || !panel.find('.player-panel__subs').length) return false;
      if (!button) {
        button = $('<div class="button selector homelab-chapters hide" role="button" aria-label="Главы"></div>').html(icon + '<span>Главы</span><div class="tooltip">Главы и кадры перемотки</div>');
        button.on('hover:enter', menu);
        var controls = $('<div class="player-panel__box-buttons homelab-chapter-controls"></div>').append(button);
        panel.find('.player-panel__left').append(controls);
        overlay = $('<div class="homelab-seek-preview hide"><img><div class="homelab-seek-preview__label"></div><div class="homelab-seek-preview__note"></div></div>');
        panel.append(overlay);
      }
      return true;
    }
    function menuItems(state) {
      var items = [{title: 'Кадры при перемотке: ' + (enabled ? 'вкл.' : 'выкл.'), toggle: true}];
      (state.info && state.info.chapters || []).forEach(function (chapter, i) {
        items.push({title: time(chapter.start) + ' · ' + plain(chapter.title || ('Глава ' + (i + 1))), at: chapter.start});
      });
      if (items.length === 1) items.push({title: state.info ? 'Встроенных глав нет' : state.failed ? 'Не удалось прочитать главы' : 'Читаем главы…', status: true});
      return items;
    }
    function refreshMenu(state) {
      if (!live(state) || !state.selection) return;
      state.selection.items = menuItems(state);
      if (menuVisible && selection === state.selection && L.Controller.enabled().name === 'select') {
        L.Select.closeAll(); L.Select.show(state.selection);
      }
    }
    function menu() {
      var state = current;
      if (!state || !live(state)) return;
      if (state.failed && !state.metaRequest && Date.now() >= state.metaManualAt) startMetadata(state);
      if (typeof api.openChapters === 'function') return api.openChapters();
      if (menuVisible) L.Select.closeAll();
      state.selection = {title: 'Главы и кадры', items: menuItems(state), onSelect: function (item) {
        selection = null; menuVisible = false;
        if (!live(state)) return;
        if (item.toggle) {
          api.setEnabled(!enabled);
        } else if (!item.status) L.PlayerVideo.to(item.at);
        L.Controller.toggle('player');
      }, onBack: function () { selection = null; menuVisible = false; if (live(state)) L.Controller.toggle('player'); }};
      L.Select.show(state.selection);
    }
    function metadataFailed(state, request, retryable) {
      if (!live(state) || state.metaRequest !== request) return;
      state.metaRequest = null; state.failed = true;
      clearTimeout(state.metaTimer); clearTimeout(state.metaDeadline); request.abort.abort();
      if (retryable && state.metaAttempts <= retryDelays.length) {
        state.metaTimer = setTimeout(function () { startMetadata(state); }, retryDelays[state.metaAttempts - 1]);
      }
      refreshMenu(state);
      publish();
    }
    function startMetadata(state) {
      if (!live(state) || state.info || state.metaRequest) return;
      clearTimeout(state.metaTimer);
      var request = state.metaRequest = {abort: new AbortController()};
      state.failed = false; state.metaAttempts++; state.metaManualAt = Date.now() + 5000;
      state.metaDeadline = setTimeout(function () { metadataFailed(state, request, true); }, 55000);
      metadata(state, request);
      publish();
    }
    function metadata(state, request) {
      if (!live(state) || state.metaRequest !== request) return;
      fetch(state.base + 'metadata?step=10', {signal: request.abort.signal, cache: 'no-store'}).then(function (response) {
        if (!live(state) || state.metaRequest !== request) return;
        if (response.status === 202) { state.metaTimer = setTimeout(function () { metadata(state, request); }, 1000); return; }
        if (!response.ok) return metadataFailed(state, request, response.status === 429 || response.status >= 500);
        return response.json().then(function (info) {
          if (!live(state) || state.metaRequest !== request) return;
          if (info.version !== 1 || [5, 10].indexOf(info.step) < 0 || !Number.isFinite(info.duration) || !Array.isArray(info.chapters)) return metadataFailed(state, request, false);
          state.info = info; state.failed = false; state.metaRequest = null;
          clearTimeout(state.metaDeadline); clearTimeout(state.metaTimer);
          refreshMenu(state);
          publish();
        });
      }).catch(function () { metadataFailed(state, request, true); });
    }
    function label(state, at) {
      var title = '', chapters = state.info && state.info.chapters || [];
      chapters.forEach(function (chapter) { if (at >= chapter.start && at < chapter.end) title = chapter.title; });
      overlay.find('.homelab-seek-preview__label').text(time(at) + (title ? ' · ' + title : ''));
    }
    function stopPreparation(state) {
      clearTimeout(state.prepareTimer); clearTimeout(state.prepareDeadline);
      if (state.prepareRequest) state.prepareRequest.abort();
      state.prepareRequest = null; state.preparationClosed = true;
      if (state.video && state.videoEvents) Object.keys(state.videoEvents).forEach(function (name) {
        state.video.removeEventListener(name, state.videoEvents[name]);
      });
      state.video = null;
      if (state.prepareClient) fetch(state.base + 'prepare', {method: 'POST', keepalive: true, headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({client: state.prepareClient, state: 'closed'})}).catch(function () {});
      state.prepareClient = null;
    }
    function preparation(state, phase) {
      if (!live(state) || !enabled || state.preparationClosed) return;
      state.preparePhase = phase;
      if (state.prepareRequest) return;
      clearTimeout(state.prepareTimer);
      var request = state.prepareRequest = new AbortController();
      state.prepareDeadline = setTimeout(function () { request.abort(); }, 5000);
      fetch(state.base + 'prepare', {method: 'POST', signal: request.signal, headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({client: state.prepareClient, state: phase})}).catch(function () {}).then(function () {
        if (state.prepareRequest !== request) return;
        clearTimeout(state.prepareDeadline); state.prepareRequest = null;
        if (!live(state) || !enabled || state.preparationClosed) return;
        if (state.preparePhase !== phase) preparation(state, state.preparePhase);
        else state.prepareTimer = setTimeout(function () {
          var video = L.PlayerVideo.video();
          var phase = state.video === video && video && video.readyState >= 3 ? (video.paused ? 'paused' : 'playing') : 'buffering';
          if (state.video === video && video && typeof video.readyState !== 'number') phase = state.preparePhase;
          preparation(state, phase);
        }, 15000);
      });
    }
    function bindPreparation(state) {
      var video = L.PlayerVideo.video();
      if (!enabled || !video || typeof video.addEventListener !== 'function' || typeof video.removeEventListener !== 'function' || state.video === video) return;
      if (state.video && state.videoEvents) Object.keys(state.videoEvents).forEach(function (name) { state.video.removeEventListener(name, state.videoEvents[name]); });
      state.video = video; state.preparationClosed = false;
      if (!state.prepareClient) state.prepareClient = 'hl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
      function phase(value) { return function () { if (live(state) && state.video === L.PlayerVideo.video()) preparation(state, value); }; }
      state.videoEvents = {playing: phase('playing'), canplay: function () { phase(video.paused ? 'paused' : 'playing')(); },
        waiting: phase('buffering'), pause: phase('paused')};
      Object.keys(state.videoEvents).forEach(function (name) { video.addEventListener(name, state.videoEvents[name]); });
      if (video.readyState >= 3) preparation(state, video.paused ? 'paused' : 'playing');
    }
    function remember(state, slot, url) {
      state.frames = state.frames || [];
      state.frames.push({slot: slot, url: url});
      while (state.frames.length > 16) URL.revokeObjectURL(state.frames.shift().url);
    }
    function frame(state, slot, request, deadline) {
      if (!live(state) || state.request !== request) return;
      function unavailable() {
        if (!live(state) || state.request !== request) return;
        clearTimeout(state.frameDeadline); state.frameDeadline = null;
        state.frameFailed = true; state.frameRetryAt = Date.now() + 5000;
        overlay.find('.homelab-seek-preview__note').text('');
      }
      function retry(delay) {
        if (Date.now() + delay >= deadline) return unavailable();
        state.poll = setTimeout(function () { frame(state, slot, request, deadline); }, delay);
      }
      function transient() { retry(Math.min(5000, 1000 * Math.pow(2, state.frameFailures++))); }
      if (Date.now() >= deadline) return unavailable();
      if (!state.frameDeadline) state.frameDeadline = setTimeout(function () {
        if (state.frameAbort) state.frameAbort.abort();
        unavailable();
      }, deadline - Date.now());
      state.frameAbort = new AbortController();
      fetch(state.base + 'frame/' + slot + '.jpg' + (state.info.step === 5 ? '' : '?step=' + state.info.step), {signal: state.frameAbort.signal}).then(function (response) {
        if (!live(state) || state.request !== request) return;
        if (response.status === 202) return retry(1000);
        if (response.status === 429 || response.status >= 500) return transient();
        if (!response.ok) return unavailable();
        return response.blob().then(function (blob) {
          if (!live(state) || state.request !== request) return;
          if (blob.type !== 'image/jpeg' || blob.size > 512 * 1024) throw new Error('frame type');
          state.blob = URL.createObjectURL(blob);
          remember(state, slot, state.blob);
          clearTimeout(state.frameDeadline); state.frameDeadline = null;
          overlay.find('img').attr('src', state.blob).css('display', 'block');
          overlay.find('.homelab-seek-preview__note').text('');
          clearTimeout(state.hide);
          state.hide = setTimeout(hide, 6000);
        });
      }).catch(function (error) {
        if (live(state) && state.request === request && error.name !== 'AbortError') transient();
      });
    }
    function position(at, duration) {
      var panel = L.PlayerPanel.render(), timeline = panel && panel.find('.player-panel__timeline');
      if (!panel || !panel[0] || !timeline || !timeline[0] || !overlay[0]) return;
      var bounds = panel[0].getBoundingClientRect(), rail = timeline[0].getBoundingClientRect(), half = overlay[0].getBoundingClientRect().width / 2;
      if (!bounds.width || !rail.width) return;
      var x = rail.left - bounds.left + rail.width * Math.max(0, Math.min(1, at / duration));
      overlay.css('left', Math.max(half + 8, Math.min(bounds.width - half - 8, x)));
      overlay.css('bottom', bounds.bottom - rail.top + 12);
    }
    function preview(at) {
      var state = current, video = L.PlayerVideo.video();
      if (!state || !state.info || !live(state) || !enabled || !Number.isFinite(at) || !video || !Number.isFinite(video.duration) || video.duration <= 0) return;
      at = Math.max(0, Math.min(at, Math.max(0, video.duration - 0.01)));
      var slot = Math.floor(at / state.info.step);
      label(state, slot * state.info.step);
      overlay.removeClass('hide');
      position(at, video.duration);
      clearTimeout(state.hide);
      state.hide = setTimeout(hide, state.blob ? 6000 : 55000);
      if (state.slot === slot && (!state.frameFailed || Date.now() < state.frameRetryAt)) return;
      cancelFrame(state);
      state.slot = slot;
      var request = state.request;
      var cached = (state.frames || []).find(function (entry) { return entry.slot === slot; });
      overlay.removeClass('hide');
      overlay.find('.homelab-seek-preview__note').text('');
      if (cached) {
        state.frames.splice(state.frames.indexOf(cached), 1); state.frames.push(cached);
        state.blob = cached.url;
        overlay.find('img').attr('src', cached.url).css('display', 'block');
        state.hide = setTimeout(hide, 6000);
        return;
      }
      overlay.find('img').removeAttr('src').css('display', 'none');
      state.hide = setTimeout(hide, 55000);
      state.debounce = setTimeout(function () { frame(state, slot, request, Date.now() + 55000); }, 450);
    }
    function ready(data) {
      clear();
      seekControls();
      var base = identity(data);
      if (!base || !panelElements()) return;
      var state = current = {data: data, base: base, metaAttempts: 0, slot: null};
      button.removeClass('hide');
      startMetadata(state);
      bindPreparation(state);
      publish();
      var panel = L.PlayerPanel.render();
      // The delegated listener runs after native touchmove. Read the target
      // already rendered by Lampa instead of recreating its gesture arithmetic.
      panel.on('touchmove.homelabPreview', '.player-panel__time-touch-zone', function () {
        var rendered = panel.find('.player-panel__timenow').text().trim();
        if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(rendered)) return;
        var at = rendered.split(':').reduce(function (sum, part) { return sum * 60 + Number(part); }, 0);
        preview(at);
      }).on('touchend.homelabPreview touchcancel.homelabPreview', hide)
        .on('mouseleave.homelabPreview', '.player-panel__timeline', hide);
    }
    L.Player.listener.follow('ready', ready);
    L.Player.listener.follow('destroy', clear);
    L.PlayerVideo.listener.follow('loadeddata', function () { if (current && live(current)) bindPreparation(current); });
    L.PlayerVideo.listener.follow('destroy', function (event) {
      var state = current;
      if (!state || !live(state)) return;
      if (!event || !event.savemeta) return stopPreparation(state);
      if (state.video && state.videoEvents) Object.keys(state.videoEvents).forEach(function (name) { state.video.removeEventListener(name, state.videoEvents[name]); });
      state.video = null;
      preparation(state, 'buffering');
    });
    L.PlayerPanel.listener.follow('mouse_rewind', function (event) {
      var video = L.PlayerVideo.video();
      if (event.method === 'move' && video) preview(video.duration * event.percent);
    });
    L.PlayerVideo.listener.follow('timeupdate', function (event) { pendingTime = event.current; });
    L.PlayerVideo.listener.follow('rewind', function () { preview(pendingTime); });
    function selectState(event) { selection = event.active; menuVisible = !!current && selection === current.selection; }
    L.Select.listener.follow('fullshow', selectState);
    L.Select.listener.follow('toggle', selectState);
    L.Select.listener.follow('hide', function () { menuVisible = false; });
    if (typeof L.Player.opened === 'function' && L.Player.opened()) ready(L.Player.playdata());
    if (typeof window.dispatchEvent === 'function' && window.CustomEvent) window.dispatchEvent(new window.CustomEvent('homelab:seek-ready'));
  }
  install();
  if (!window.homelabSeekPreviews && window.Lampa && Lampa.Listener && typeof Lampa.Listener.follow === 'function') Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
})();
