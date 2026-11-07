(function () {
  'use strict';
  function install() {
    var L = window.Lampa, core = window.homelabSeekPreviews, $ = window.jQuery;
    if (!L || !core || [2, 3].indexOf(core.version) < 0 || window.homelabChapterGallery || !$ || !L.Modal || !L.Modal.listener || !L.Input || !L.Timeline || !L.Storage || !L.Storage.listener || !L.PlayerVideo || !L.PlayerVideo.listener || !L.Controller || !L.Utils || !L.Select || !L.PlayerPanel || !L.Noty || !L.Player || !L.Keypad || !L.Keypad.listener || !L.PlayerPanel.listener) return;
    if (![L.Modal.open, L.Modal.update, L.Modal.close, L.Modal.listener.follow, L.Input.edit,
      L.Timeline.filename, L.Select.show, L.PlayerVideo.to, L.PlayerVideo.video, L.PlayerVideo.listener.follow,
      L.Storage.get, L.Storage.set, L.Storage.listener.follow, L.PlayerPanel.render,
      L.Controller.enabled, L.Controller.toggle, L.Controller.add, L.Controller.collectionSet, L.Controller.collectionFocus,
      L.Player.render, L.Keypad.listener.follow, L.PlayerPanel.listener.follow, L.PlayerPanel.reveal, L.PlayerPanel.toggle, L.Utils.secondsToTime, L.Noty.show,
      core.current, core.subscribe, core.retryMetadata, core.setEnabled].every(function (fn) { return typeof fn === 'function'; })) return;
    window.homelabChapterGallery = {version: 1};
    var gallery = null, retired = [], retireTimer, activeModal = null, skipButton = null, skipFocusTimer;
    $('<style>.homelab-skip{position:absolute;right:1.5em;bottom:2em;z-index:4;display:flex;align-items:center;gap:.6em;padding:.65em 1em;border:1px solid #ffffff99;border-radius:.35em;background:rgba(20,22,27,.9);color:#fff;font-size:.9em;white-space:nowrap;max-width:90vw}.homelab-skip svg{width:1.2em;height:1.2em;flex-shrink:0}.homelab-skip.focus{color:#111;background:#fff;box-shadow:0 0 0 .12em #fff}.homelab-skip.hide{display:none}body.true--mobile .homelab-skip{font-size:14px;min-height:44px;right:16px}</style>').appendTo('head');
    $('<style>.homelab-chapter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(12em,1fr));gap:1em}.homelab-chapter-tile{background:#333;padding:.4em;border-radius:.5em}.homelab-chapter-tile.focus,.homelab-chapter-edit.focus{outline:.18em solid white}.homelab-chapter-tile img{width:100%;aspect-ratio:16/9;object-fit:cover;background:#17191f}.homelab-chapter-current{box-shadow:inset 0 0 0 .15em #9cd7ff}.homelab-chapter-title{font-size:1.25em}.homelab-chapter-time{font-size:1em;opacity:.8}.homelab-chapter-edit{font-size:1.15em;margin-top:.3em;padding:.5em;background:#444;border-radius:.3em}.homelab-chapter-note{margin-bottom:1em;opacity:.8}.homelab-chapter-tools{display:flex;gap:1em;margin-bottom:1em}.homelab-chapter-tools .selector{padding:.6em;background:#444;border-radius:.3em}</style>').appendTo('head');
    function scope() { return L.Timeline.filename() + '|' + String(L.Storage.get('lampac_profile_id', '') || ''); }
    function valid(g) { var now = core.current(); return gallery === g && now && now.key === g.key && scope() === g.scope; }
    function kind(title) {
      var text = String(title || '').toLowerCase().trim().replace(/^[\d.\-\s]+|[.\-\s]+$/g, '');
      if (/^(?:op\d*|opening(?:\s+(?:theme|credits))?|intro|заставка|опенинг|オープニング)$/.test(text)) return 'intro';
      if (/^(?:ed\d*|ending(?:\s+(?:theme|credits))?|outro|end credits|credits|титры|эндинг|エンディング)$/.test(text)) return 'outro';
      return '';
    }
    function time(at) { return L.Utils.secondsToTime(at); }
    function chapters() {
      var current = core.current(); if (!current || !current.info) return [];
      var saved = L.Storage.get('homelab_chapter_edits_' + scope(), {}), edits = saved[current.key] || {};
      return current.info.chapters.map(function (chapter, index) {
        var override = edits[index], result = Object.assign({kind: kind(chapter.title)}, chapter, {index: index, skipStart: chapter.start, skipEnd: chapter.end});
        if (override && Number.isFinite(override.start) && Number.isFinite(override.end) && override.start >= 0 && override.start < override.end && override.end <= current.info.duration && ['', 'intro', 'outro'].indexOf(override.kind) >= 0) Object.assign(result, {skipStart: override.start, skipEnd: override.end, kind: override.kind});
        return result;
      });
    }
    function stopThumb(g) { if (!g) return; clearTimeout(g.timer); if (g.job) { clearTimeout(g.job.deadline); g.job.abort.abort(); } g.job = null; g.loading = null; g.busy = false; g.queue = []; }
    function release(g) {
      if (g.released) return;
      g.released = true; stopThumb(g);
      Object.keys(g.images).forEach(function (key) { URL.revokeObjectURL(g.images[key]); });
      g.images = {};
    }
    function afterClose() {
      if (typeof L.Modal.opened === 'function' && L.Modal.opened()) L.Controller.toggle('modal');
      else L.Controller.toggle(typeof L.Player.opened === 'function' && !L.Player.opened() ? 'content' : 'player');
    }
    function ownsTop(g) {
      var name = L.Controller.enabled().name;
      if (name === 'select' || name === 'keybord' || $('body').hasClass('keyboard-input--visible')) return false;
      if (typeof L.Select.opened === 'function' && L.Select.opened()) return false;
      var top = typeof L.Controller.windowTop === 'function' && L.Controller.windowTop();
      if (top && top.name !== 'modal') return false;
      var frame = typeof L.Modal.render === 'function' && L.Modal.render();
      if (frame && frame[0] && typeof frame[0].contains === 'function') return !!g.html && frame[0].contains(g.html[0]);
      return activeModal === g.params && name === 'modal';
    }
    function sweepRetired() {
      clearTimeout(retireTimer);
      var old = retired.find(ownsTop);
      if (old) close(old);
    }
    function scheduleSweep() {
      if (!retired.length) return;
      clearTimeout(retireTimer); retireTimer = setTimeout(sweepRetired, 0);
    }
    function close(g) {
      g = g || gallery; if (!g || g.closed) return;
      if (gallery === g) gallery = null;
      if (retired.indexOf(g) < 0) retired.push(g);
      release(g);
      if (g.html) g.html.empty().text('Просмотр завершён');
      // A selector or another modal may cover this frame. Keep its identity
      // until native Modal restores it, then dismiss only that owned frame.
      if (ownsTop(g)) { L.Modal.close(); afterClose(); }
      else scheduleSweep();
    }
    function queueThumb(g, index) {
      if (!valid(g) || !g.visible || g.images[index] || g.loading === index || g.queue.indexOf(index) >= 0) return;
      g.queue.unshift(index); g.queue = g.queue.slice(0, 3); pump(g);
    }
    function pump(g) {
      if (!valid(g) || !g.visible || g.busy || !g.queue.length) return;
      var index = g.queue.shift(), chapter = chapters()[index];
      if (!chapter) return pump(g);
      var current = core.current(), step = current && current.info && current.info.step || 5;
      var at = Math.ceil(chapter.start / step) * step;
      // A frame before the chapter would depict the previous scene.
      if (at >= chapter.end) return pump(g);
      g.busy = true; g.loading = index;
      var deadline = Date.now() + 55000, job = g.job = {abort: new AbortController()};
      function finish() { if (g.job !== job) return; clearTimeout(job.deadline); clearTimeout(g.timer); g.job = null; g.busy = false; g.loading = null; if (valid(g)) pump(g); }
      job.deadline = setTimeout(function () { job.abort.abort(); finish(); }, 55000);
      function request() {
        if (g.job !== job) return;
        if (!valid(g) || !g.visible || Date.now() > deadline) return finish();
        fetch(g.key + 'frame/' + Math.floor(at / step) + '.jpg' + (step === 5 ? '' : '?step=' + step), {signal: job.abort.signal}).then(function (r) {
          if (!valid(g) || !g.visible || g.job !== job) return finish();
          if (r.status === 202) { g.timer = setTimeout(request, 1000); return; }
          if (!r.ok) throw new Error('frame');
          return r.blob().then(function (blob) {
            if (!valid(g) || !g.visible || g.job !== job || blob.type !== 'image/jpeg' || blob.size > 512 * 1024) return finish();
            var url = URL.createObjectURL(blob); g.images[index] = url;
            g.html.find('[data-chapter="' + index + '"] img').attr('src', url);
            var keys = Object.keys(g.images);
            if (keys.length > 12) { var old = keys.find(function (key) { return +key !== index; }); g.html.find('[data-chapter="' + old + '"] img').attr('src', './img/img_broken.svg'); URL.revokeObjectURL(g.images[old]); delete g.images[old]; }
            finish();
          });
        }).catch(finish);
      }
      request();
    }
    function saveEdit(g, index, draft, reset) {
      var current = core.current();
      if (!valid(g) || !current.info) return;
      if (!reset && (!Number.isFinite(draft.start) || !Number.isFinite(draft.end) || draft.start < 0 || draft.start >= draft.end || draft.end > current.info.duration)) return L.Noty.show('Нужно: 0 ≤ начало < конец ≤ длительность видео');
      var key = 'homelab_chapter_edits_' + g.scope, saved = L.Storage.get(key, {}), edits = saved[g.key] || {};
      if (reset) delete edits[index]; else edits[index] = draft;
      delete saved[g.key]; saved[g.key] = edits;
      Object.keys(saved).slice(0, -30).forEach(function (old) { delete saved[old]; });
      L.Storage.set(key, saved); draw(g); updateSkip();
    }
    function edit(g, index) {
      var chapter = chapters()[index]; if (!chapter || !valid(g)) return;
      var draft = {start: chapter.skipStart, end: chapter.skipEnd, kind: chapter.kind};
      function show() {
        if (!valid(g)) return;
        L.Select.show({title: 'Настройка пропуска', items: [
          {title: 'Начало: ' + time(draft.start), field: 'start'}, {title: 'Конец: ' + time(draft.end), field: 'end'},
          {title: 'Тип: ' + (draft.kind === 'intro' ? 'Заставка' : draft.kind === 'outro' ? 'Титры' : 'Обычная глава'), type: true},
          {title: 'Сохранить', save: true}, {title: 'Сбросить изменения', reset: true}, {title: 'Отмена'}
        ], onBack: function () { L.Controller.toggle('modal'); }, onSelect: function (item) {
          if (!valid(g)) return;
          if (item.field) L.Input.edit({title: item.field === 'start' ? 'Начало, секунды' : 'Конец, секунды', value: String(draft[item.field]), free: true, nosave: true, nomic: true, layout: 'nums', keyboard: 'lampa'}, function (value) {
            if (String(value).trim() !== '' && Number.isFinite(Number(value))) draft[item.field] = Number(value);
            show();
          });
          else if (item.type) { draft.kind = draft.kind === '' ? 'intro' : draft.kind === 'intro' ? 'outro' : ''; show(); }
          else { if (item.save || item.reset) saveEdit(g, index, draft, item.reset); L.Controller.toggle('modal'); }
        }});
      }
      show();
    }
    function draw(g) {
      if (!valid(g)) return;
      if (g.params && (!g.visible || L.Controller.enabled().name !== 'modal')) { g.dirty = true; return; }
      g.dirty = false;
      var current = core.current(), list = chapters(), html = $('<div class="homelab-chapter-gallery"></div>');
      var note = $('<div class="homelab-chapter-note"></div>').text(!current.info ? current.failed ? 'Главы временно недоступны. Можно повторить запрос.' : 'Читаем главы…' : list.length ? 'Выберите главу для перехода. Кнопка ниже задаёт границы пропуска.' : 'В этом видео нет встроенных глав');
      html.append(note);
      var tools = $('<div class="homelab-chapter-tools"></div>');
      tools.append($('<div class="selector"></div>').text('Кадры при перемотке: ' + (current.enabled ? 'вкл.' : 'выкл.')).on('hover:enter', function () { core.setEnabled(!core.current().enabled); }));
      tools.append($('<div class="selector">Обновить главы</div>').on('hover:enter', function () { core.retryMetadata(); }));
      html.append(tools);
      var grid = $('<div class="homelab-chapter-grid"></div>'), video = L.PlayerVideo.video(), position = video && video.currentTime || 0, selected;
      list.forEach(function (chapter) {
        var cell = $('<div></div>'), tile = $('<div class="homelab-chapter-tile selector"><img><div class="homelab-chapter-title"></div><div class="homelab-chapter-time"></div></div>').attr('data-chapter', chapter.index);
        tile.find('.homelab-chapter-title').text(chapter.title || ('Глава ' + (chapter.index + 1)));
        tile.find('.homelab-chapter-time').text(time(chapter.start) + ' — ' + time(chapter.end));
        tile.find('img').attr('src', g.images[chapter.index] || './img/img_broken.svg');
        if (position >= chapter.start && position < chapter.end) { tile.addClass('homelab-chapter-current'); selected = tile; }
        tile.on('hover:focus', function () { queueThumb(g, chapter.index); });
        tile.on('hover:enter', function (event) { event.stopImmediatePropagation(); if (valid(g)) { close(g); L.PlayerVideo.to(chapter.start); } });
        cell.append(tile).append($('<div class="homelab-chapter-edit selector">Настроить пропуск</div>').on('hover:enter', function () { edit(g, chapter.index); }));
        grid.append(cell);
      });
      html.append(grid); g.html = html;
      if (!g.params) g.params = {title: 'Главы', html: html, size: 'large', onBack: function () { close(g); }};
      g.params.html = html; g.params.select = selected ? selected[0] : html.find('.selector')[0];
      g.initialIndex = Math.max(0, list.findIndex(function (item) { return position >= item.start && position < item.end; }));
      if (g.visible && L.Controller.enabled().name === 'modal') L.Modal.update(html);
    }
    function open() {
      close(); var current = core.current(); if (!current) return;
      var g = gallery = {key: current.key, scope: scope(), images: {}, queue: [], visible: false};
      draw(g); L.Modal.open(g.params);
    }
    function updateSkip() {
      var current = core.current(), video = L.PlayerVideo.video();
      if (!current || !video || !skipButton) return skipButton && skipButton.addClass('hide');
      var chapter = chapters().find(function (item) { return item.kind && video.currentTime >= item.skipStart && video.currentTime < item.skipEnd; });
      skipButton.toggleClass('hide', !chapter);
      if (!chapter && L.Controller.enabled().name === 'homelab_chapter_skip') L.Controller.toggle('player');
      if (chapter) {
        var label = chapter.kind === 'intro' ? 'Пропустить заставку' : 'Пропустить титры';
        skipButton.find('.homelab-skip-label').text(label); skipButton.attr('aria-label', label).data('end', chapter.skipEnd);
      }
    }
    function skipPosition(event) {
      var root = L.Player.render(), panel = L.PlayerPanel.render();
      if (!skipButton || !root || !panel || !root[0] || !panel[0] || !panel[0].getBoundingClientRect) return;
      var visible = event && typeof event.status === 'boolean' ? event.status : panel.hasClass('panel--visible');
      var bottom = visible ? Math.max(24, panel[0].getBoundingClientRect().height + 12) : 24;
      skipButton.css('bottom', bottom);
    }
    function activateSkip() {
      if (!skipButton || skipButton.hasClass('hide')) return;
      L.PlayerVideo.to(skipButton.data('end')); L.Controller.toggle('player');
    }
    function panel() {
      var root = L.Player.render(); if (!root || !root.length) return;
      if (!skipButton) skipButton = $('<div class="selector hide homelab-skip" role="button"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 4l10 8L4 20V4m12 0h4v16h-4z"/></svg><span class="homelab-skip-label"></span></div>').on('hover:enter', activateSkip);
      if (skipButton.parent()[0] !== root[0]) root.append(skipButton);
      skipPosition();
    }
    L.Controller.add('homelab_chapter_skip', {
      toggle: function () { var root = L.Player.render(); L.Controller.collectionSet(root); L.Controller.collectionFocus(skipButton[0], root); },
      enter: activateSkip,
      gone: function () { if (skipButton) skipButton.removeClass('focus'); },
      down: function () { L.PlayerPanel.toggle(); }, back: function () { L.PlayerPanel.toggle(); },
      left: function () { L.PlayerPanel.toggle(); }, right: function () { L.PlayerPanel.toggle(); },
      up: function () { L.Controller.toggle('player'); }
    });
    L.Keypad.listener.follow('keydown', function (event) {
      if (!event.enabled || (event.code !== 38 && event.code !== 29460) || L.Controller.enabled().name !== 'player_rewind' || !skipButton || skipButton.hasClass('hide')) return;
      var current = core.current(); if (!current) return;
      clearTimeout(skipFocusTimer);
      // Let native Skip take priority; otherwise expose our manual action.
      skipFocusTimer = setTimeout(function () {
        var now = core.current();
        if (now && now.key === current.key && !skipButton.hasClass('hide') && L.Controller.enabled().name === 'player') {
          L.PlayerPanel.reveal(); skipPosition(); L.Controller.toggle('homelab_chapter_skip');
        }
      }, 0);
    });
    L.PlayerPanel.listener.follow('visible', skipPosition);
    core.openChapters = open;
    core.subscribe(function () { panel(); if (gallery) { if (!valid(gallery)) close(); else draw(gallery); } updateSkip(); scheduleSweep(); });
    L.PlayerVideo.listener.follow('timeupdate', updateSkip);
    L.Modal.listener.follow('fullshow', function (event) {
      activeModal = event.active;
      if (!gallery) return;
      gallery.visible = event.active === gallery.params;
      if (gallery.visible) [gallery.initialIndex, gallery.initialIndex + 1, gallery.initialIndex - 1].forEach(function (index) { if (index >= 0) queueThumb(gallery, index); });
      else stopThumb(gallery);
    });
    L.Modal.listener.follow('toggle', function (event) {
      activeModal = event.active;
      var old = retired.find(function (g) { return g.params === event.active; });
      if (old) return close(old);
      if (gallery) { gallery.visible = event.active === gallery.params; if (gallery.visible && gallery.dirty) draw(gallery); if (gallery.visible) queueThumb(gallery, gallery.initialIndex); }
    });
    L.Modal.listener.follow('close', function (event) {
      if (activeModal === event.active) activeModal = null;
      retired = retired.filter(function (g) { if (g.params !== event.active) return true; g.closed = true; return false; });
      if (gallery && event.active === gallery.params) { var g = gallery; gallery = null; g.closed = true; release(g); }
      // Native close emits before the lower frame is popped, and may skip its
      // toggle if another component changed the controller to content/player.
      scheduleSweep();
    });
    if (L.Select.listener && typeof L.Select.listener.follow === 'function') {
      L.Select.listener.follow('hide', scheduleSweep); L.Select.listener.follow('close', scheduleSweep);
    }
    if (L.Controller.listener && typeof L.Controller.listener.follow === 'function') L.Controller.listener.follow('toggle', scheduleSweep);
    L.Storage.listener.follow('change', function () { if (gallery && gallery.scope !== scope()) close(); updateSkip(); });
    panel(); updateSkip();
  }
  install(); window.addEventListener('homelab:seek-ready', install);
})();
