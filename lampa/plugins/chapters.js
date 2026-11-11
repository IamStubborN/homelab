(function () {
  'use strict';
  if (window.homelabChapters) return;

  // Embedded chapters of a TorrServer video: ticks on the timeline, the current
  // chapter's name next to the elapsed time and a chapter list in the panel.
  // They come from the header probe lampa-media already runs for subtitles
  // (/homelab-media/<hash>/<file>/embedded), so no extra torrent read is made.
  // Also adds the ±N s step buttons around Play outside TVs.
  function install() {
    if (window.homelabChapters) return;
    var L = window.Lampa, $ = window.jQuery;
    if (!L || !L.Player || !L.Player.listener || !L.PlayerVideo || !L.PlayerVideo.listener ||
        !L.PlayerPanel || !L.PlayerPanel.listener || !L.Select || !L.Select.listener || !L.Storage || !L.Controller) return;
    if (![$, window.fetch, window.AbortController, L.Player.playdata, L.Player.listener.follow,
        L.PlayerVideo.video, L.PlayerVideo.to, L.PlayerVideo.listener.follow, L.PlayerPanel.render,
        L.PlayerPanel.listener.follow, L.Select.show, L.Select.closeAll, L.Select.listener.follow,
        L.Controller.toggle, L.Storage.field].every(function (method) {
      return typeof method === 'function';
    })) return;
    window.homelabChapters = {version: 1};

    var RETRIES = [3000, 5000, 15000, 60000];
    var current = null, button = null, ticks = null, nowLabel = null, ticksHtml = '', menuVisible = false, pendingTime = 0;
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
      // One row like the native panel; narrow phones get tighter steps instead of a second row with a lone button.
      'body.true--mobile .homelab-seek-controls .player-panel__left{min-width:0}',
      '@media(max-width:400px){body.true--mobile .homelab-seek-controls .player-panel__center{flex-basis:148px}body.true--mobile .homelab-seek-controls .homelab-seek-back{margin-right:4px}body.true--mobile .homelab-seek-controls .homelab-seek-forward{margin-left:4px}body.true--mobile .player-panel .homelab-seek-step{min-width:40px;min-height:40px}}',
      // Chapter ticks: own layer above Lampa segments, which Lampa empties on redraw.
      '.homelab-chapter-ticks{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:1}',
      '.homelab-chapter-tick{position:absolute;top:0;width:2px;height:100%;margin-left:-1px;background:rgba(0,0,0,.5)}',
      // A phone's short, thick track turns many chapters into a dashed line: the label and the list are enough there.
      'body.true--mobile .homelab-chapter-ticks{display:none}',
      '.homelab-chapter-now{margin-left:.8em;min-width:0;-webkit-flex-shrink:1;flex-shrink:1;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-chapter-now:empty{display:none}',
      '.player-panel .homelab-chapters{width:auto;padding:.65em .9em;border-radius:2em}.homelab-chapters>span{margin-left:.4em;font-size:.75em;white-space:nowrap}',
      'body.true--mobile .homelab-chapters>span{display:none}body.true--mobile .homelab-chapters{min-width:44px;min-height:44px}',
      'body.true--mobile .player-panel__left .homelab-chapter-controls{margin-left:12px}body.true--mobile .player-panel__playlist-buttons.hide+.homelab-chapter-controls{margin-left:0}',
      '.homelab-chapter-badge{display:inline-block;margin-left:.5em;padding:0 .45em;border-radius:.3em;background:#fff;color:#000;font-size:.85em;line-height:1.5;vertical-align:middle}'
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
      if (!L.Platform || typeof L.Platform.tv !== 'function' || L.Platform.tv() || typeof L.PlayerVideo.video !== 'function') return;
      var panel = L.PlayerPanel.render();
      if (!panel || !panel.length || panel[0] === seekPanel || panel.find('.player-panel__rprev,.player-panel__rnext').length) return;
      var center = panel.find('.player-panel__center'), play = center.find('.player-panel__playpause');
      if (!center.length || !play.length) return;
      seekPanel = panel[0]; seekButtons = [];
      [false, true].forEach(function (forward) {
        var step = $('<div class="button selector homelab-seek-step homelab-seek-' + (forward ? 'forward' : 'back') + '" role="button"></div>');
        step.html('<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><g' + (forward ? ' transform="translate(32 0) scale(-1 1)"' : '') + '><path d="M16 6A11 11 0 1 1 8.22 9.22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M11 6l5-3.5v7z" fill="currentColor"/></g><text x="16" y="20.5" text-anchor="middle" fill="currentColor" font-size="10" font-weight="700"></text></svg>');
        step.on('hover:enter', function () {
          var data = L.Player.playdata(), video = L.PlayerVideo.video();
          if (!data || data.iptv || panel.hasClass('panel--norewind') || !video || !isFinite(video.duration) || video.duration <= 0) return;
          // Native rewind is the TV scrub: pause, a second to collect presses, seek, play. A tap seeks at once and keeps
          // playing; during a pending seek currentTime is already its target, so quick taps add up.
          var step = Math.max(5, Number(L.Storage.field('player_rewind')) || 20), from = video.currentTime;
          var to = forward ? Math.max(from, Math.min(video.duration - 1, from + step)) : Math.max(0, from - step);
          try { video.currentTime = to; } catch (error) { return; }
          // The panel keeps itself shown on its own rewind event.
          if (L.PlayerVideo.listener && typeof L.PlayerVideo.listener.send === 'function') L.PlayerVideo.listener.send('rewind', {});
        });
        if (forward) play.after(step); else play.before(step);
        seekButtons.push({button: step, forward: forward});
      });
      panel.addClass('homelab-seek-controls');
      seekLabels();
    }
    if (L.Storage.listener && typeof L.Storage.listener.follow === 'function') L.Storage.listener.follow('change', function (event) {
      if (event.name === 'player_rewind') seekLabels();
    });

    function plain(value) {
      return String(value).replace(/[<>"'`]/g, function (c) { return {'<': '‹', '>': '›', '"': '″', "'": '’', '`': 'ʼ'}[c]; });
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
      // torrserver-audio keeps the original file identity before GST replaces the URL.
      var hash = data.homelab_torrent_hash || data.torrent_hash, index = data.homelab_file_index;
      if (index === undefined && data.torrent_hash) {
        try { index = Number(new URL(data.url, window.location.href).searchParams.get('index')); } catch (_) {}
      }
      if (!/^[a-f0-9]{40}$/i.test(hash || '') || typeof index !== 'number' || index % 1 !== 0 || index < 1 || index > 999999) return null;
      if (L.Platform && typeof L.Platform.is === 'function' && L.Platform.is('android') && L.Storage.field('player_torrent') !== 'inner') return null;
      return '/homelab-media/' + hash.toLowerCase() + '/' + index + '/embedded';
    }
    function live(state) { return current === state && L.Player.playdata() === state.data; }
    // Only chapters that split the file are worth a button, ticks or a label.
    function useful(state) { return !!state.chapters && state.chapters.length > 1; }

    function panelElements() {
      var panel = L.PlayerPanel.render();
      if (!panel || !panel.length || !panel.find('.player-panel__subs').length) return false;
      if (!button) {
        button = $('<div class="button selector homelab-chapters hide" role="button" aria-label="Главы"></div>').html(icon + '<span>Главы</span><div class="tooltip">Главы</div>');
        button.on('hover:enter', menu);
        panel.find('.player-panel__left').append($('<div class="player-panel__box-buttons homelab-chapter-controls"></div>').append(button));
        ticks = $('<div class="homelab-chapter-ticks"></div>');
        panel.find('.player-panel__timeline').append(ticks);
        nowLabel = $('<div class="homelab-chapter-now"></div>');
        panel.find('.player-panel__timenow').after(nowLabel);
      }
      return true;
    }
    function drawTicks(state) {
      if (!ticks || !live(state) || !useful(state)) return;
      var video = L.PlayerVideo.video(), duration = video && isFinite(video.duration) && video.duration > 0 ? video.duration : state.duration;
      var html = '';
      if (duration > 0) state.chapters.forEach(function (chapter) {
        if (chapter.start > 1 && chapter.start < duration - 1) html += '<div class="homelab-chapter-tick" style="left:' + (chapter.start / duration * 100).toFixed(3) + '%"></div>';
      });
      if (html !== ticksHtml) { ticks.html(html); ticksHtml = html; }
    }
    function nowChapter(state, at) {
      if (!useful(state) || !nowLabel) return;
      var index = chapterIndex(state.chapters, at, state.nowIndex);
      if (index === state.nowIndex) return;
      state.nowIndex = index;
      nowLabel.text(index >= 0 ? chapterName(state.chapters[index], index) : '');
    }
    function menuItems(state) {
      var chapters = state.chapters, video = L.PlayerVideo.video();
      var at = video && isFinite(video.currentTime) ? video.currentTime : -1, now = chapterIndex(chapters, at, state.nowIndex);
      return chapters.map(function (chapter, i) {
        return {title: plain(chapterName(chapter, i)), at: chapter.start, selected: i === now,
          subtitle: time(chapter.start) + ' · ' + span(chapter.end - chapter.start) + (i === now ? '<span class="homelab-chapter-badge">сейчас</span>' : '')};
      });
    }
    function menu() {
      var state = current;
      if (!state || !live(state) || !useful(state)) return;
      if (menuVisible) L.Select.closeAll();
      function close() { menuVisible = false; }
      state.selection = {title: 'Главы · ' + state.chapters.length, items: menuItems(state), onSelect: function (item) {
        close();
        if (!live(state)) return;
        L.PlayerVideo.to(item.at);
        L.Controller.toggle('player');
      }, onBack: function () { close(); if (live(state)) L.Controller.toggle('player'); }};
      L.Select.show(state.selection);
    }

    function load(state) {
      if (!live(state)) return;
      var abort = state.abort = new AbortController();
      function retry() {
        if (!live(state) || state.abort !== abort) return;
        var delay = RETRIES[state.attempts++];
        if (delay !== undefined) state.timer = setTimeout(function () { load(state); }, delay);
      }
      fetch(state.url, {signal: abort.signal, cache: 'no-store'}).then(function (response) {
        if (!live(state) || state.abort !== abort) return;
        // 503: the header is still being fetched; 429: another probe runs.
        if (response.status === 429 || response.status >= 500) return retry();
        if (!response.ok) return;
        return response.json().then(function (info) {
          if (!live(state) || state.abort !== abort || !info || !Array.isArray(info.chapters)) return;
          state.duration = isFinite(info.duration) ? info.duration : 0;
          state.chapters = info.chapters.filter(function (chapter) {
            return chapter && isFinite(chapter.start) && isFinite(chapter.end) && chapter.end > chapter.start;
          }).sort(function (a, b) { return a.start - b.start; });
          if (!useful(state)) return;
          button.removeClass('hide');
          drawTicks(state);
          nowChapter(state, pendingTime);
        });
      }).catch(function (error) { if (error && error.name !== 'AbortError') retry(); });
    }
    function clear(next) {
      if (current) { clearTimeout(current.timer); if (current.abort) current.abort.abort(); }
      // An episode change with the list open: close it and give the player its keys back.
      if (menuVisible) { L.Select.closeAll(); if (next) L.Controller.toggle('player'); }
      menuVisible = false; current = null; pendingTime = 0;
      if (button) button.addClass('hide');
      if (ticks && ticksHtml) { ticks.html(''); ticksHtml = ''; }
      if (nowLabel) nowLabel.text('');
    }
    function ready(data) {
      clear(true);
      seekControls();
      var url = identity(data);
      if (!url || !panelElements()) return;
      load(current = {data: data, url: url, attempts: 0, nowIndex: -1});
    }
    L.Player.listener.follow('ready', ready);
    L.Player.listener.follow('destroy', function () { clear(false); });
    L.PlayerVideo.listener.follow('loadeddata', function () { if (current && live(current)) drawTicks(current); });
    // Playback path: remember the time and, only on a chapter boundary, rename it.
    L.PlayerVideo.listener.follow('timeupdate', function (event) {
      pendingTime = event.current;
      if (current) nowChapter(current, event.current);
    });
    function selectState(event) { menuVisible = !!current && event.active === current.selection; }
    L.Select.listener.follow('fullshow', selectState);
    L.Select.listener.follow('toggle', selectState);
    L.Select.listener.follow('hide', function () { menuVisible = false; });
    if (typeof L.Player.opened === 'function' && L.Player.opened()) ready(L.Player.playdata());
  }
  install();
  if (!window.homelabChapters && window.Lampa && Lampa.Listener && typeof Lampa.Listener.follow === 'function') Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
})();
