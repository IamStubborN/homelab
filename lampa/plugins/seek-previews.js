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
        if (!enabled) stripStop();
        if (current) { if (enabled) bindPreparation(current); else { releaseFrames(current); stopPreparation(current); } }
        publish();
      },
      retryMetadata: function () { if (current && current.failed && !current.metaRequest && Date.now() >= current.metaManualAt) startMetadata(current); }
    };
    function publish() { subscribers.slice().forEach(function (fn) { fn(); }); }
    var current = null, button = null, overlay = null, sequence = 0, pendingTime = 0, selection = null, menuVisible = false;
    var retryDelays = [5000, 15000, 60000];
    // Native rewind grows each repeated step by 3%; reports are spaced out so
    // flapping waiting/playing events cannot flood the worker.
    var PHASE_GAP = 3000, LANDED_HIDE = 2500, RELEASE_HIDE = 1500, NEAR_SLOTS = 3;
    var enabled = L.Storage.get('homelab_seek_frames', true) !== false;
    var icon = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M3 10h5M3 15h5M12 9h6M12 14h6"/></svg>';
    var seekPanel = null, seekButtons = [];
    $('<style>' + [
      // Flex gap is missing on old TV WebViews: margins space the step buttons.
      '.player-panel .homelab-seek-step{background:rgba(255,255,255,.1);min-width:44px;min-height:44px}.player-panel .homelab-seek-step svg{width:32px!important;height:32px!important;flex-shrink:0}',
      '.homelab-seek-controls .homelab-seek-back{margin-right:.5em}.homelab-seek-controls .homelab-seek-forward{margin-left:.5em}',
      '.player-panel.panel--norewind .homelab-seek-step,.player.iptv .homelab-seek-step{display:none}',
      'body.true--mobile .homelab-seek-controls .player-panel__center{flex:0 0 168px}',
      'body.true--mobile .homelab-seek-controls .homelab-seek-back{margin-right:8px}body.true--mobile .homelab-seek-controls .homelab-seek-forward{margin-left:8px}',
      'body.true--mobile .homelab-seek-controls .player-panel__left,body.true--mobile .homelab-seek-controls .player-panel__right{flex:1;width:auto}',
      '@media(max-width:580px){body.true--mobile .homelab-seek-controls .player-panel__line-two{flex-wrap:wrap}body.true--mobile .homelab-seek-controls .player-panel__center{order:-1;flex-basis:100%;margin-bottom:8px}}'
    ].join('') + '</style>').appendTo('head');
    function seekLabels() {
      var step = Math.max(5, Number(L.Storage.field('player_rewind')) || 20);
      seekButtons.forEach(function (entry) {
        entry.button.find('text').text(step);
        entry.button.attr('aria-label', (entry.forward ? 'Вперёд' : 'Назад') + ' примерно на ' + step + ' с');
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
        button.html('<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><g' + (forward ? ' transform="translate(32 0) scale(-1 1)"' : '') + '><path d="M16 6A11 11 0 1 1 8.22 9.22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M11 6l5-3.5v7z" fill="currentColor"/></g><text x="16" y="20.5" text-anchor="middle" fill="currentColor" font-size="10" font-weight="700"></text></svg>');
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
    // Card: one reused node, positioned by transform, faded by opacity; the
    // frame keeps 16:9 by padding because aspect-ratio is missing on old WebViews.
    $('<style>' + [
      '.homelab-seek-preview{position:absolute;left:0;bottom:8em;width:20em;max-width:40vw;min-width:140px;padding:.35em;background:rgba(18,20,26,.94);border-radius:.8em;pointer-events:none;z-index:5;opacity:1;-webkit-transition:opacity .16s ease-out;transition:opacity .16s ease-out;-webkit-box-sizing:border-box;box-sizing:border-box}',
      '.homelab-seek-preview--off{opacity:0;visibility:hidden;-webkit-transition:opacity .16s ease-out,visibility 0s linear .16s;transition:opacity .16s ease-out,visibility 0s linear .16s}',
      '.player-panel:not(.panel--visible) .homelab-seek-preview{visibility:hidden}',
      '.homelab-seek-preview__frame{position:relative;height:0;padding-top:56.25%;background:#0d0e12;border-radius:.5em;overflow:hidden}',
      '.homelab-seek-preview__img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;opacity:0;-webkit-transition:opacity .16s;transition:opacity .16s}',
      '.homelab-seek-preview--image .homelab-seek-preview__img{opacity:1}.homelab-seek-preview--near .homelab-seek-preview__img{opacity:.45}',
      '.homelab-seek-preview__shimmer,.homelab-chapter-thumb__shimmer{position:absolute;left:0;top:0;width:100%;height:100%;display:none;background:-webkit-linear-gradient(left,rgba(255,255,255,0) 25%,rgba(255,255,255,.16) 50%,rgba(255,255,255,0) 75%);background:linear-gradient(90deg,rgba(255,255,255,0) 25%,rgba(255,255,255,.16) 50%,rgba(255,255,255,0) 75%);-webkit-animation:homelab-seek-shimmer 1.1s linear infinite;animation:homelab-seek-shimmer 1.1s linear infinite}',
      '.homelab-seek-preview--pending .homelab-seek-preview__shimmer,.homelab-chapter-thumb--loading .homelab-chapter-thumb__shimmer{display:block}',
      '@-webkit-keyframes homelab-seek-shimmer{0%{-webkit-transform:translateX(-100%)}100%{-webkit-transform:translateX(100%)}}@keyframes homelab-seek-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}',
      '.homelab-seek-preview__badge{position:absolute;left:.4em;top:.4em;padding:.15em .45em;border-radius:.3em;background:rgba(0,0,0,.7);font-size:.75em;line-height:1.3;display:none}.homelab-seek-preview--near .homelab-seek-preview__badge{display:block}',
      '.homelab-seek-preview__status{position:absolute;left:0;top:50%;width:100%;margin-top:-.65em;text-align:center;font-size:.8em;line-height:1.3;color:rgba(255,255,255,.55)}',
      '.homelab-seek-preview__time{padding:.35em .3em 0;text-align:center;font-size:1.15em;font-weight:600;line-height:1.3}',
      '.homelab-seek-preview__chapter{padding:0 .3em .15em;text-align:center;font-size:.85em;line-height:1.35;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-seek-preview__chapter:empty{display:none}',
      'body.true--mobile .homelab-seek-preview{width:11em;max-width:46vw}',
      // The card already carries the time: the native hover tooltip would duplicate it.
      '.homelab-seek-previewing .player-panel__time{opacity:0}',
      // Chapter ticks: own layer above Lampa segments, which Lampa empties on redraw.
      '.homelab-chapter-ticks{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:1}',
      '.homelab-chapter-tick{position:absolute;top:0;width:.18em;height:100%;margin-left:-.09em;background:rgba(0,0,0,.7)}',
      '.homelab-chapter-now{margin-left:.8em;min-width:0;-webkit-flex-shrink:1;flex-shrink:1;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-chapter-now:empty{display:none}',
      '.player-panel .homelab-chapters{width:auto;padding:.65em .9em;border-radius:2em}.homelab-chapters>span{margin-left:.4em;font-size:.75em;white-space:nowrap}',
      'body.true--mobile .homelab-chapters>span{display:none}body.true--mobile .homelab-chapters{min-width:44px;min-height:44px}',
      'body.true--mobile .player-panel .button{width:44px;height:44px;padding:10px}body.true--mobile .player-panel .player-panel__playpause{width:64px;height:64px;padding:16px}',
      'body.true--mobile .player-panel__left .homelab-chapter-controls{margin-left:2px}',
      // Chapter list: a 16:9 frame per row, filled lazily; the current row is marked.
      '.homelab-chapter-item .selectbox-item__icon{margin-right:1.2em}',
      '.selectbox-item__icon>.homelab-chapter-thumb{position:relative;width:8em;height:4.5em;border-radius:.4em;overflow:hidden;background:rgba(255,255,255,.08)}',
      '.homelab-chapter-thumb__img{position:absolute;left:0;top:0;width:100%;height:100%;background-position:50% 50%;background-size:cover;background-repeat:no-repeat;opacity:0;-webkit-transition:opacity .2s;transition:opacity .2s}',
      '.homelab-chapter-thumb--ready .homelab-chapter-thumb__img{opacity:1}',
      '.homelab-chapter-thumb__time{position:absolute;right:.3em;bottom:.3em;padding:.05em .35em;border-radius:.25em;background:rgba(0,0,0,.7);font-size:.8em;line-height:1.35}',
      '.homelab-chapter-badge{display:inline-block;margin-left:.5em;padding:0 .45em;border-radius:.3em;background:#fff;color:#000;font-size:.85em;line-height:1.5;vertical-align:middle}',
      'body.true--mobile .selectbox-item__icon>.homelab-chapter-thumb{width:6.4em;height:3.6em}'
    ].join('') + '</style>').appendTo('head');

    function plain(value) {
      return String(value).replace(/[<>"'`]/g, function (c) { return {'<':'‹','>':'›','"':'″',"'":'’','`':'ʼ'}[c]; });
    }
    function time(value) {
      var n = Math.floor(value), hours = Math.floor(n / 3600);
      return (hours ? hours + ':' : '') + ('0' + Math.floor(n / 60) % 60).slice(-2) + ':' + ('0' + n % 60).slice(-2);
    }
    function span(value) {
      var seconds = Math.max(0, Math.round(value)), minutes = Math.round(seconds / 60);
      if (seconds < 60) return seconds + ' с';
      if (minutes < 60) return minutes + ' мин';
      return Math.floor(minutes / 60) + ' ч ' + ('0' + minutes % 60).slice(-2) + ' мин';
    }
    function chapterName(chapter, index) {
      var title = chapter.title == null ? '' : String(chapter.title).trim();
      return title || 'Глава ' + (index + 1);
    }
    // Chapters are few; the hint makes the common "still inside" case O(1).
    function chapterIndex(chapters, at, hint) {
      if (hint >= 0 && hint < chapters.length && at >= chapters[hint].start && at < chapters[hint].end) return hint;
      for (var i = 0; i < chapters.length; i++) if (at >= chapters[i].start && at < chapters[i].end) return i;
      return -1;
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
    function clientId() { return 'hl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12); }
    // One frame owner for the plugin lifetime: the worker keeps only its latest
    // seek, across files too. n orders requests that overtake each other.
    var frameClient = clientId(), frameOrder = 0;
    // The chapter list owns a second client id, so its single in-flight
    // thumbnail never supersedes a seek and is itself superseded by focus moves.
    var chapterClient = clientId(), chapterOrder = 0;
    function releaseFrames(state) {
      if (!state || !state.frameUsed) return;
      state.frameUsed = false;
      fetch('/previews/cancel', {method: 'POST', keepalive: true, headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({client: frameClient, n: ++frameOrder})}).catch(function () {});
    }
    function retryAfter(response, fallback) {
      var value = response && response.headers && typeof response.headers.get === 'function' ? Number(response.headers.get('Retry-After')) : NaN;
      return Number.isFinite(value) && value > 0 ? Math.min(600, value) * 1000 : fallback;
    }
    // Card view state: every DOM write is skipped when the value is unchanged.
    var parts = null, ticks = null, nowLabel = null, ticksHtml = '';
    var view = {shown: false, width: 0, src: '', bottom: null, x: null, texts: {}, flags: {}};
    function text(name, value) {
      if (view.texts[name] === value) return;
      view.texts[name] = value;
      parts[name].text(value);
    }
    function flag(name, on) {
      on = !!on;
      if (view.flags[name] === on) return;
      view.flags[name] = on;
      if (on) overlay.addClass('homelab-seek-preview--' + name); else overlay.removeClass('homelab-seek-preview--' + name);
    }
    // Evicted object URLs that are still on screen (card image, a painted
    // chapter row) are retired, not revoked, until nothing references them.
    function inUse(state, url) {
      return url === state.blob || url === view.src || !!(strip && strip.state === state && strip.painted[url]);
    }
    function drop(state, url) {
      if (inUse(state, url)) state.retired.push(url); else URL.revokeObjectURL(url);
    }
    function sweep(state) {
      if (!state || !state.retired.length) return;
      state.retired = state.retired.filter(function (url) {
        if (inUse(state, url)) return true;
        URL.revokeObjectURL(url);
        return false;
      });
    }
    function card(url, nearSlot, pending, failed, step) {
      if (url !== view.src) {
        if (url) parts.img.attr('src', url); else parts.img.removeAttr('src');
        view.src = url || '';
        sweep(current);
      }
      flag('image', !!url);
      flag('near', !!url && nearSlot != null);
      flag('pending', pending);
      text('badge', url && nearSlot != null ? '≈ ' + time(nearSlot * step) : '');
      text('status', !url && failed ? 'Кадр недоступен' : '');
    }
    function scheduleHide(state, delay) {
      // A settled seek or a released touch caps how long a late frame may stay.
      if (state.hideBy) delay = Math.max(0, Math.min(delay, state.hideBy - Date.now()));
      clearTimeout(state.hide);
      state.hide = setTimeout(hide, delay);
    }
    function settle(delay) {
      var state = current;
      if (!state || !overlay || !view.shown) return;
      state.hideBy = Date.now() + delay;
      scheduleHide(state, delay);
    }
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
      if (current) current.hideBy = null;
      if (!overlay) return;
      // The image stays during the fade; the next show replaces it before fading in.
      flag('pending', false);
      if (view.shown) {
        overlay.addClass('homelab-seek-preview--off');
        var panel = L.PlayerPanel.render();
        if (panel) panel.removeClass('homelab-seek-previewing');
      }
      view.shown = false; view.width = 0;
    }
    function reveal() {
      if (view.shown) return;
      view.shown = true;
      overlay.removeClass('homelab-seek-preview--off');
      L.PlayerPanel.render().addClass('homelab-seek-previewing');
    }
    function clear() {
      hide();
      if (overlay) { card('', null, false, false, 10); text('time', ''); text('chapter', ''); }
      stripStop();
      releaseFrames(current);
      if (current) {
        stopPreparation(current);
        (current.frames || []).forEach(function (entry) { URL.revokeObjectURL(entry.url); });
        Object.keys(current.thumbs).forEach(function (slot) { URL.revokeObjectURL(current.thumbs[slot]); });
        current.retired.forEach(function (url) { URL.revokeObjectURL(url); });
        current.retired = [];
        if (current.metaRequest) current.metaRequest.abort.abort();
        clearTimeout(current.metaTimer); clearTimeout(current.metaDeadline);
      }
      if (menuVisible) L.Select.closeAll();
      selection = null; menuVisible = false;
      var panel = L.PlayerPanel.render();
      if (panel) panel.off('.homelabPreview');
      current = null;
      if (button) button.addClass('hide');
      if (ticks && ticksHtml) { ticks.html(''); ticksHtml = ''; }
      if (nowLabel) nowLabel.text('');
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
        overlay = $('<div class="homelab-seek-preview homelab-seek-preview--off"><div class="homelab-seek-preview__frame">' +
          '<img class="homelab-seek-preview__img" alt=""><div class="homelab-seek-preview__shimmer"></div>' +
          '<div class="homelab-seek-preview__badge"></div><div class="homelab-seek-preview__status"></div></div>' +
          '<div class="homelab-seek-preview__time"></div><div class="homelab-seek-preview__chapter"></div></div>');
        parts = {img: overlay.find('.homelab-seek-preview__img'), badge: overlay.find('.homelab-seek-preview__badge'),
          status: overlay.find('.homelab-seek-preview__status'), time: overlay.find('.homelab-seek-preview__time'),
          chapter: overlay.find('.homelab-seek-preview__chapter')};
        panel.append(overlay);
        ticks = $('<div class="homelab-chapter-ticks"></div>');
        panel.find('.player-panel__timeline').append(ticks);
        nowLabel = $('<div class="homelab-chapter-now"></div>');
        panel.find('.player-panel__timenow').after(nowLabel);
      }
      return true;
    }
    function drawTicks(state) {
      if (!ticks || !live(state) || !state.chapters) return;
      var video = L.PlayerVideo.video(), duration = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : state.info.duration;
      var html = '';
      // One chapter is the whole file: a tick or a label would only be noise.
      if (state.chapters.length > 1 && duration > 0) state.chapters.forEach(function (chapter) {
        if (chapter.start > 1 && chapter.start < duration - 1) html += '<div class="homelab-chapter-tick" style="left:' + (chapter.start / duration * 100).toFixed(3) + '%"></div>';
      });
      if (html !== ticksHtml) { ticks.html(html); ticksHtml = html; }
    }
    function nowChapter(state, at) {
      var chapters = state.chapters;
      if (!chapters || chapters.length < 2 || !nowLabel) return;
      var index = chapterIndex(chapters, at, state.nowIndex);
      if (index === state.nowIndex) return;
      state.nowIndex = index;
      nowLabel.text(index >= 0 ? chapterName(chapters[index], index) : '');
    }

    // Chapter thumbnails: only rows near the focused one, one request at a
    // time, cancelled when the list closes. Busy answers stop the strip: the
    // decoder belongs to scrubbing and playback first.
    var strip = null, THUMB_RANGE = 4, THUMB_WAIT = 20000, THUMB_KEEP = 64;
    function chapterSlot(state, index) {
      var chapter = state.chapters[index], step = state.info.step;
      // Chapter starts are often black: look a little inside the chapter.
      var at = chapter.start + Math.min(10, Math.max(0, (chapter.end - chapter.start) / 3));
      if (state.info.duration > 0) at = Math.min(at, state.info.duration - 0.01);
      return Math.floor(Math.max(0, at) / step);
    }
    function cachedFrame(state, slot) {
      if (state.thumbs[slot]) return state.thumbs[slot];
      var entry = (state.frames || []).find(function (item) { return item.slot === slot; });
      return entry ? entry.url : null;
    }
    function keepThumb(state, slot, url) {
      if (state.thumbs[slot]) drop(state, state.thumbs[slot]);
      else state.thumbOrder.push(slot);
      state.thumbs[slot] = url;
      while (state.thumbOrder.length > THUMB_KEEP) {
        var old = state.thumbOrder.shift();
        var stale = state.thumbs[old];
        delete state.thumbs[old];
        drop(state, stale);
      }
    }
    function paintThumb(s, node, url) {
      s.painted[url] = true;
      node.removeClass('homelab-chapter-thumb--loading').addClass('homelab-chapter-thumb--ready')
        .find('.homelab-chapter-thumb__img').css('background-image', 'url("' + url + '")');
    }
    function stripStop() {
      var s = strip;
      if (!s) return;
      strip = null;
      clearTimeout(s.timer); clearTimeout(s.focusTimer);
      if (s.abort) s.abort.abort();
      if (s.used) fetch('/previews/cancel', {method: 'POST', keepalive: true, headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({client: chapterClient, n: ++chapterOrder})}).catch(function () {});
      sweep(s.state);
    }
    function stripOpen(state) {
      stripStop();
      strip = {state: state, nodes: {}, painted: {}, focus: -1, failed: {}, slot: null};
    }
    function stripNode(state, index, item) {
      // Lampa draws rows in order: the first chapter row starts a fresh list.
      if (index === 0 || !strip || strip.state !== state) stripOpen(state);
      var node = item.find('.homelab-chapter-thumb');
      strip.nodes[index] = node;
      var url = cachedFrame(state, chapterSlot(state, index));
      if (url) paintThumb(strip, node, url);
    }
    function stripFocus(state, index) {
      var s = strip;
      if (!s || s.state !== state) return;
      s.focus = index;
      // Fast D-pad scrolling must not start a request for every passed row.
      clearTimeout(s.focusTimer);
      s.focusTimer = setTimeout(function () { stripPump(s); }, 250);
    }
    function stripWanted(s) {
      var wanted = [], count = s.state.chapters.length;
      for (var distance = 0; distance <= THUMB_RANGE; distance++) [s.focus + distance, s.focus - distance].forEach(function (index) {
        if (index < 0 || index >= count || !s.nodes[index] || wanted.indexOf(index) >= 0) return;
        var slot = chapterSlot(s.state, index);
        if (!cachedFrame(s.state, slot) && !s.failed[slot]) wanted.push(index);
      });
      return wanted;
    }
    function stripLoading(s, slot, on) {
      Object.keys(s.nodes).forEach(function (index) {
        if (chapterSlot(s.state, Number(index)) !== slot) return;
        if (on) s.nodes[index].addClass('homelab-chapter-thumb--loading'); else s.nodes[index].removeClass('homelab-chapter-thumb--loading');
      });
    }
    function stripPump(s) {
      if (strip !== s || s.halted || s.focus < 0 || !enabled || !live(s.state)) return;
      var wanted = stripWanted(s);
      if (s.slot != null) {
        if (wanted.some(function (index) { return chapterSlot(s.state, index) === s.slot; })) return;
        clearTimeout(s.timer);
        if (s.abort) s.abort.abort();
        stripLoading(s, s.slot, false);
        s.slot = null; s.abort = null;
      }
      if (wanted.length) stripFetch(s, chapterSlot(s.state, wanted[0]), Date.now() + THUMB_WAIT);
    }
    function stripFetch(s, slot, deadline) {
      var state = s.state, abort = s.abort = new AbortController();
      s.slot = slot; s.used = true;
      stripLoading(s, slot, true);
      function fresh() { return strip === s && s.abort === abort && live(state); }
      function done(failed) {
        if (failed) s.failed[slot] = true;
        stripLoading(s, slot, false);
        s.slot = null; s.abort = null;
        stripPump(s);
      }
      fetch(state.base + 'frame/' + slot + '.jpg?step=' + state.info.step + '&client=' + chapterClient + '&n=' + (++chapterOrder), {signal: abort.signal}).then(function (response) {
        if (!fresh()) return;
        if (response.status === 202) {
          if (Date.now() + 1000 >= deadline) return done(true);
          s.timer = setTimeout(function () { if (fresh()) stripFetch(s, slot, deadline); }, 1000);
          return;
        }
        if (response.status === 429 || response.status >= 500) { s.halted = true; return done(false); }
        if (!response.ok) return done(true);
        return response.blob().then(function (blob) {
          if (!fresh()) return;
          if (blob.type !== 'image/jpeg' || blob.size > 512 * 1024) return done(true);
          var url = URL.createObjectURL(blob);
          keepThumb(state, slot, url);
          Object.keys(s.nodes).forEach(function (index) { if (chapterSlot(state, Number(index)) === slot) paintThumb(s, s.nodes[index], url); });
          done(false);
        });
      }).catch(function (error) {
        if (fresh() && error.name !== 'AbortError') { s.halted = true; done(false); }
      });
    }

    function menuItems(state) {
      var items = [], chapters = state.chapters || [], video = L.PlayerVideo.video();
      var at = video && Number.isFinite(video.currentTime) ? video.currentTime : -1;
      var now = chapterIndex(chapters, at, state.nowIndex);
      chapters.forEach(function (chapter, i) {
        items.push({title: plain(chapterName(chapter, i)), template: 'selectbox_icon',
          icon: '<div class="homelab-chapter-thumb"><div class="homelab-chapter-thumb__img"></div><div class="homelab-chapter-thumb__shimmer"></div><div class="homelab-chapter-thumb__time">' + time(chapter.start) + '</div></div>',
          subtitle: time(chapter.start) + ' · ' + span(chapter.end - chapter.start) + (i === now ? '<span class="homelab-chapter-badge">сейчас</span>' : ''),
          selected: i === now, at: chapter.start, chapter: i});
      });
      if (!items.length) items.push({title: state.info ? 'Встроенных глав нет' : state.failed ? 'Не удалось прочитать главы' : 'Читаем главы…', status: true});
      if (chapters.length) items.push({title: 'Перемотка', separator: true});
      items.push({title: 'Кадры при перемотке', subtitle: 'Кадр и глава над шкалой времени', checkbox: true, checked: enabled, toggle: true});
      return items;
    }
    function selectionTitle(state) { return state.chapters && state.chapters.length ? 'Главы · ' + state.chapters.length : 'Главы'; }
    function refreshMenu(state) {
      if (!live(state) || !state.selection) return;
      state.selection.items = menuItems(state);
      state.selection.title = selectionTitle(state);
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
      function close() { stripStop(); selection = null; menuVisible = false; }
      state.selection = {title: selectionTitle(state), items: menuItems(state), onSelect: function (item) {
        close();
        if (!live(state)) return;
        if (!item.status && !item.toggle) L.PlayerVideo.to(item.at);
        L.Controller.toggle('player');
      }, onCheck: function (item) {
        if (!live(state) || !item.toggle) return;
        api.setEnabled(item.checked);
      }, onDraw: function (item, element) {
        if (element.chapter === undefined || !live(state)) return;
        item.addClass('homelab-chapter-item');
        stripNode(state, element.chapter, item);
      }, onFocus: function (element) {
        if (element.chapter !== undefined) stripFocus(state, element.chapter);
      }, onBack: function () { close(); if (live(state)) L.Controller.toggle('player'); }};
      L.Select.show(state.selection);
    }
    function metadataFailed(state, request, retryable, minDelay) {
      if (!live(state) || state.metaRequest !== request) return;
      state.metaRequest = null; state.failed = true;
      clearTimeout(state.metaTimer); clearTimeout(state.metaDeadline); request.abort.abort();
      if (retryable && state.metaAttempts <= retryDelays.length) {
        state.metaTimer = setTimeout(function () { startMetadata(state); }, Math.max(retryDelays[state.metaAttempts - 1], minDelay || 0));
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
        // 422: the worker's job failed and is backed off; retry after its delay.
        if (response.status === 422) return metadataFailed(state, request, true, retryAfter(response, 60000));
        if (!response.ok) return metadataFailed(state, request, response.status === 429 || response.status >= 500);
        return response.json().then(function (info) {
          if (!live(state) || state.metaRequest !== request) return;
          if (info.version !== 1 || [5, 10].indexOf(info.step) < 0 || !Number.isFinite(info.duration) || !Array.isArray(info.chapters)) return metadataFailed(state, request, false);
          state.info = info; state.failed = false; state.metaRequest = null;
          state.chapters = info.chapters.filter(function (chapter) {
            return chapter && Number.isFinite(chapter.start) && Number.isFinite(chapter.end) && chapter.end > chapter.start;
          }).sort(function (a, b) { return a.start - b.start; });
          clearTimeout(state.metaDeadline); clearTimeout(state.metaTimer);
          drawTicks(state);
          nowChapter(state, pendingTime);
          refreshMenu(state);
          publish();
        });
      }).catch(function () { metadataFailed(state, request, true); });
    }
    function label(state, at) {
      var chapters = state.chapters || [];
      state.labelIndex = chapterIndex(chapters, at, state.labelIndex);
      text('time', time(at));
      var index = state.labelIndex;
      // A lone untitled chapter is the whole file: naming it adds nothing.
      text('chapter', index >= 0 && (chapters.length > 1 || chapters[index].title) ? chapterName(chapters[index], index) : '');
    }
    function detachVideo(state) {
      // Tizen/Orsay wrappers are <object> elements: their native
      // removeEventListener cannot remove Lampa Subscribe listeners, so every
      // handler also checks the events token and becomes inert.
      var video = state.video, events = state.videoEvents;
      if (video && events && typeof video.removeEventListener === 'function') Object.keys(events).forEach(function (name) {
        video.removeEventListener(name, events[name]);
      });
      state.video = null; state.videoEvents = null;
    }
    function stopPreparation(state) {
      clearTimeout(state.prepareTimer); clearTimeout(state.prepareDeadline);
      if (state.prepareRequest) state.prepareRequest.abort();
      state.prepareRequest = null; state.preparationClosed = true;
      detachVideo(state);
      // The sequence number lets the worker drop a report that overtakes this one.
      if (state.prepareClient) fetch(state.base + 'prepare', {method: 'POST', keepalive: true, headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({client: state.prepareClient, state: 'closed', seq: ++state.prepareSeq})}).catch(function () {});
      state.prepareClient = null;
    }
    function preparation(state, phase) {
      if (!live(state) || !enabled || state.preparationClosed || state.prepareUnsupported) return;
      state.preparePhase = phase;
      if (state.prepareRequest) return;
      clearTimeout(state.prepareTimer);
      var wait = state.prepareAt == null ? 0 : state.prepareAt + PHASE_GAP - Date.now();
      if (wait > 0) {
        state.prepareTimer = setTimeout(function () { preparation(state, state.preparePhase); }, wait);
        return;
      }
      state.prepareAt = Date.now();
      var request = state.prepareRequest = new AbortController();
      state.prepareDeadline = setTimeout(function () { request.abort(); }, 5000);
      fetch(state.base + 'prepare', {method: 'POST', signal: request.signal, headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({client: state.prepareClient, state: phase, seq: ++state.prepareSeq})}).then(null, function () { return null; }).then(function (response) {
        if (state.prepareRequest !== request) return;
        clearTimeout(state.prepareDeadline); state.prepareRequest = null;
        if (response && response.status === 422) { state.prepareUnsupported = true; return; }
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
      if (!enabled || !video || typeof video.addEventListener !== 'function' || state.video === video) return;
      detachVideo(state);
      state.video = video; state.preparationClosed = false;
      if (!state.prepareClient) { state.prepareClient = clientId(); state.prepareSeq = 0; state.prepareAt = null; }
      var events = {};
      function phase(value) { return function () { if (state.videoEvents === events && live(state) && state.video === L.PlayerVideo.video()) preparation(state, value); }; }
      events.playing = phase('playing'); events.waiting = phase('buffering'); events.pause = phase('paused');
      events.canplay = function () { phase(video.paused ? 'paused' : 'playing')(); };
      state.videoEvents = events;
      Object.keys(events).forEach(function (name) { video.addEventListener(name, events[name]); });
      if (video.readyState >= 3) preparation(state, video.paused ? 'paused' : 'playing');
    }
    function remember(state, slot, url) {
      state.frames = state.frames || [];
      state.frames.push({slot: slot, url: url});
      while (state.frames.length > 16) drop(state, state.frames.shift().url);
    }
    function frame(state, slot, request, deadline) {
      if (!live(state) || state.request !== request) return;
      function unavailable(cooldown) {
        if (!live(state) || state.request !== request) return;
        clearTimeout(state.frameDeadline); state.frameDeadline = null;
        state.frameFailed = true; state.frameRetryAt = Date.now() + Math.max(5000, cooldown || 0);
        flag('pending', false);
        text('status', view.src ? '' : 'Кадр недоступен');
      }
      function retry(delay) {
        if (Date.now() + delay >= deadline) return unavailable();
        state.poll = setTimeout(function () { frame(state, slot, request, deadline); }, delay);
      }
      function transient(response) { retry(Math.max(Math.min(5000, 1000 * Math.pow(2, state.frameFailures++)), retryAfter(response, 0))); }
      if (Date.now() >= deadline) return unavailable();
      if (!state.frameDeadline) state.frameDeadline = setTimeout(function () {
        if (state.frameAbort) state.frameAbort.abort();
        unavailable();
      }, deadline - Date.now());
      state.frameAbort = new AbortController();
      // client= makes the worker drop this viewer's superseded seeks (latest wins).
      state.frameUsed = true;
      fetch(state.base + 'frame/' + slot + '.jpg?step=' + state.info.step + '&client=' + frameClient + '&n=' + (++frameOrder), {signal: state.frameAbort.signal}).then(function (response) {
        if (!live(state) || state.request !== request) return;
        if (response.status === 202) return retry(1000);
        if (response.status === 429 || response.status >= 500) return transient(response);
        // 422 is a failed job: do not poll it during the worker's backoff.
        if (response.status === 422) return unavailable(retryAfter(response, 60000));
        if (!response.ok) return unavailable();
        return response.blob().then(function (blob) {
          if (!live(state) || state.request !== request) return;
          if (blob.type !== 'image/jpeg' || blob.size > 512 * 1024) return unavailable(60000);
          state.blob = URL.createObjectURL(blob);
          remember(state, slot, state.blob);
          clearTimeout(state.frameDeadline); state.frameDeadline = null;
          card(state.blob, null, false, false, state.info.step);
          scheduleHide(state, 6000);
        });
      }).catch(function (error) {
        if (live(state) && state.request === request && error.name !== 'AbortError') transient();
      });
    }
    function position(at, duration) {
      var panel = L.PlayerPanel.render(), timeline = panel && panel.find('.player-panel__timeline');
      if (!panel || !panel[0] || !timeline || !timeline[0] || !overlay[0]) return;
      // All reads first, then writes: one layout per pointer move at most.
      var bounds = panel[0].getBoundingClientRect(), rail = timeline[0].getBoundingClientRect();
      if (!view.width) view.width = overlay[0].getBoundingClientRect().width;
      if (!bounds.width || !rail.width) return;
      var half = view.width / 2, margin = Math.max(8, bounds.width * 0.01);
      var x = rail.left - bounds.left + rail.width * Math.max(0, Math.min(1, at / duration));
      x = Math.round(Math.max(half + margin, Math.min(bounds.width - half - margin, x)) - half);
      var bottom = Math.round(bounds.bottom - rail.top + 14);
      if (x !== view.x) { view.x = x; overlay.css('transform', 'translate3d(' + x + 'px,0,0)'); }
      if (bottom !== view.bottom) { view.bottom = bottom; overlay.css('bottom', bottom); }
    }
    function nearest(state, slot) {
      var best = null;
      function consider(entrySlot, url) {
        var distance = Math.abs(entrySlot - slot);
        if (distance <= NEAR_SLOTS && (!best || distance < Math.abs(best.slot - slot))) best = {slot: entrySlot, url: url};
      }
      (state.frames || []).forEach(function (entry) { consider(entry.slot, entry.url); });
      Object.keys(state.thumbs).forEach(function (key) { consider(Number(key), state.thumbs[key]); });
      return best;
    }
    function preview(at) {
      var state = current, video = L.PlayerVideo.video();
      if (!state || !state.info || !live(state) || !enabled || !Number.isFinite(at) || !video || !Number.isFinite(video.duration) || video.duration <= 0) return;
      if (strip) stripStop();
      state.hideBy = null;
      at = Math.max(0, Math.min(at, Math.max(0, video.duration - 0.01)));
      var slot = Math.floor(at / state.info.step), step = state.info.step;
      position(at, video.duration);
      label(state, at);
      clearTimeout(state.hide);
      state.hide = setTimeout(hide, state.blob ? 6000 : 55000);
      if (state.slot === slot && (!state.frameFailed || Date.now() < state.frameRetryAt)) { reveal(); return; }
      cancelFrame(state);
      state.slot = slot;
      var request = state.request;
      var cached = (state.frames || []).find(function (entry) { return entry.slot === slot; });
      if (cached) {
        state.frames.splice(state.frames.indexOf(cached), 1); state.frames.push(cached);
        state.blob = cached.url;
      } else if (state.thumbs[slot]) state.blob = state.thumbs[slot];
      if (state.blob) {
        card(state.blob, null, false, false, step);
        reveal();
        state.hide = setTimeout(hide, 6000);
        return;
      }
      // Placeholder: the nearest known frame, dimmed and marked with its own time.
      var near = nearest(state, slot);
      card(near ? near.url : '', near ? near.slot : null, true, false, step);
      reveal();
      state.hide = setTimeout(hide, 55000);
      state.debounce = setTimeout(function () { frame(state, slot, request, Date.now() + 55000); }, 450);
    }
    function ready(data) {
      clear();
      seekControls();
      var base = identity(data);
      if (!base || !panelElements()) return;
      var state = current = {data: data, base: base, metaAttempts: 0, slot: null, thumbs: {}, thumbOrder: [], retired: [], nowIndex: -1, labelIndex: -1};
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
      // A quick release keeps the pending frame request briefly.
      }).on('touchend.homelabPreview touchcancel.homelabPreview', function () { settle(RELEASE_HIDE); })
        .on('mouseleave.homelabPreview', '.player-panel__timeline', hide);
    }
    L.Player.listener.follow('ready', ready);
    L.Player.listener.follow('destroy', clear);
    L.PlayerVideo.listener.follow('loadeddata', function () {
      if (!current || !live(current)) return;
      bindPreparation(current);
      if (current.chapters) drawTicks(current);
    });
    L.PlayerVideo.listener.follow('destroy', function (event) {
      var state = current;
      if (!state || !live(state)) return;
      if (!event || !event.savemeta) return stopPreparation(state);
      detachVideo(state);
      // A replacement video is not a phase flap: report it at once.
      state.prepareAt = null;
      preparation(state, 'buffering');
    });
    L.PlayerPanel.listener.follow('mouse_rewind', function (event) {
      var video = L.PlayerVideo.video();
      if (event.method === 'move' && video) preview(video.duration * event.percent);
    });
    // Playback path: remember the time and, only on a chapter boundary, rename it.
    L.PlayerVideo.listener.follow('timeupdate', function (event) {
      pendingTime = event.current;
      if (current && current.chapters) nowChapter(current, event.current);
    });
    L.PlayerVideo.listener.follow('rewind', function () { preview(pendingTime); settle(LANDED_HIDE); });
    // A hidden panel must not keep a stale target for its next appearance.
    L.PlayerPanel.listener.follow('visible', function (event) { if (event && event.status === false) hide(); });
    function selectState(event) {
      selection = event.active; menuVisible = !!current && selection === current.selection;
      // Another list on top owns the screen: its rows replaced ours.
      if (strip && !menuVisible) stripStop();
    }
    L.Select.listener.follow('fullshow', selectState);
    L.Select.listener.follow('toggle', selectState);
    L.Select.listener.follow('hide', function (event) {
      menuVisible = false;
      if (strip && (!event || !current || event.active === current.selection)) stripStop();
    });
    if (typeof L.Player.opened === 'function' && L.Player.opened()) ready(L.Player.playdata());
    if (typeof window.dispatchEvent === 'function' && window.CustomEvent) window.dispatchEvent(new window.CustomEvent('homelab:seek-ready'));
  }
  install();
  if (!window.homelabSeekPreviews && window.Lampa && Lampa.Listener && typeof Lampa.Listener.follow === 'function') Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
})();
