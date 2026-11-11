  // ── The «Общий» screen ──
  // The opening episode: an explicit one, else the last watched season and episode, else S1E1.
  function initialSelection(object, movie) {
    var tv = !!movie.name, saved = window.homelabContinue && window.homelabContinue.list().find(function (item) { return item.card === (tv ? 'tv_' : 'movie_') + movie.id; });
    var season = Number.isInteger(object.season) && object.season >= 0 ? object.season : saved && Number.isInteger(saved.season) && saved.season >= 0 ? saved.season : 1;
    return {season: season, episode: saved && saved.season === season && saved.episode || 1};
  }
  // TMDB image paths go into CSS url(): anything but a plain path is dropped.
  function imagePath(path) { return typeof path === 'string' && /^\/[A-Za-z0-9_.\-\/]{1,200}$/.test(path) ? path : ''; }
  // The accent of the release art: the hue that carries most colour, lifted to a readable lightness.
  // data is RGBA bytes; null when the art is close to grey.
  function accentOf(data) {
    var buckets = [], i, best = null;
    for (i = 0; i < 12; i++) buckets.push({weight: 0, hue: 0});
    for (i = 0; i + 3 < data.length; i += 4) {
      var r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min, light = (max + min) / 2;
      if (chroma < 0.15 || light < 0.1 || light > 0.92) continue;
      var hue = max === r ? (g - b) / chroma % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
      hue = (hue * 60 + 360) % 360;
      var bucket = buckets[Math.floor(hue / 30) % 12], weight = chroma * chroma;
      bucket.weight += weight; bucket.hue += hue * weight;
    }
    // Neighbouring hues count half: a red split across 0° is still one red.
    buckets.forEach(function (bucket, index) {
      bucket.score = bucket.weight + (buckets[(index + 11) % 12].weight + buckets[(index + 1) % 12].weight) / 2;
      if (bucket.weight && (!best || bucket.score > best.score)) best = bucket;
    });
    if (!best || best.score < data.length / 4 * 0.006) return null;
    return hslColor(best.hue / best.weight, 0.72, 0.66);
  }
  function hslColor(hue, saturation, light) {
    var chroma = (1 - Math.abs(2 * light - 1)) * saturation, part = hue / 60, x = chroma * (1 - Math.abs(part % 2 - 1)), m = light - chroma / 2;
    var rgb = part < 1 ? [chroma, x, 0] : part < 2 ? [x, chroma, 0] : part < 3 ? [0, chroma, x] : part < 4 ? [0, x, chroma] : part < 5 ? [x, 0, chroma] : [chroma, 0, x];
    return rgb.map(function (value) { return Math.round((value + m) * 255); });
  }
  var tintSequence = 0;
  function Common(object) {
    var self = this, movie = movieCard(object.movie), tv = !!movie.name;
    var recovery = object.homelab_recovery, pref = preferences();
    if (recovery && recovery.scope !== sync.scope()) recovery = null;
    var selection = recovery ? {season: recovery.season, episode: recovery.episode} : initialSelection(object, movie);
    var root = $('<div class="homelab-common"></div>'), art = $('<div class="homelab-common-art"></div>'), head = $('<div class="homelab-common-head"></div>');
    var status = $('<div class="homelab-common-status" aria-live="polite"></div>'), statusText = $('<div class="homelab-common-status-text"></div>'), bar = $('<div class="homelab-common-bar"></div>'), barFill = $('<div class="homelab-common-bar-fill"></div>');
    var main = $('<div class="homelab-common-main"></div>'), body = $('<div class="homelab-common-list"></div>'), scroll = new L.Scroll({mask: true, over: true}), hint = $('<div class="homelab-common-hint hide"></div>');
    var detail = $('<div class="homelab-common-detail hide"></div>'), detailSig = '', detailKey = '';
    var search, last = null, kind = recovery ? 'online' : 'all', q = recovery ? 0 : pref.quality, subsOnly = !recovery && pref.subs, tiles = {}, models = {}, shown = 20, visibleItems = [], order = [], locked = false, restoringFocus = false, more = null, torrentsOpen = null, toggled = false, rerank = null, fresh = 0, freshKeys = {}, sequence = '', sequenceKeys = [], qBefore = 0, reorderAt = 0, dead = false, voiceTimer = 0, started = false, refresh, uiIntent = 0, currentScope = sync.scope();
    // Grouped by voice, recovery too: its providers mostly carry the same voice, so one card leads to all of them.
    // untouched: until the first key press, focus follows the top (recommended) card so one OK plays it.
    var grouped = true, untouched = true, placeholder = null, placeholderState = '';
    // Header: poster, title and facts, live search progress, and the episode strip under them.
    var poster = $('<div class="homelab-common-poster hide"></div>'), info = $('<div class="homelab-common-info"></div>'), facts = $('<div class="homelab-common-facts"></div>');
    var title = $('<div class="homelab-common-heading"></div>').text(movie.title || movie.name || 'Общий'), titleRow = $('<div class="homelab-common-title-row"></div>'), titleBlock = $('<div class="homelab-common-title"></div>');
    var year = String(movie.release_date || movie.first_air_date || '').slice(0, 4), rating = Number(movie.vote_average);
    var genres = Array.isArray(movie.genres) ? movie.genres.map(function (genre) { return genre && typeof genre.name === 'string' ? genre.name.toLowerCase() : ''; }).filter(Boolean).slice(0, 2).join(' · ') : '';
    var strip = $('<div class="homelab-common-eps hide"></div>'), stripCenter = 0, stripTimer = 0;
    status.append($('<div class="homelab-common-spinner"></div>')).append(statusText).append(bar.append(barFill));
    [/^\d{4}$/.test(year) ? year : '', rating > 0 ? '★ ' + rating.toFixed(1) : '', genres].forEach(function (fact) { if (fact) facts.append($('<div class="homelab-common-year"></div>').text(fact)); });
    titleRow.append(titleBlock.append(title).append(facts)).append(status);
    info.append(titleRow).append(strip);
    head.append(poster).append(info);
    var backdrop = imagePath(movie.backdrop_path), cover = imagePath(movie.poster_path);
    if (backdrop && L.Api && L.Api.img) art.css('background-image', 'url("' + L.Api.img(backdrop, 'w1280') + '")').addClass('has-image');
    if (cover && L.Api && L.Api.img) poster.css('background-image', 'url("' + L.Api.img(cover, 'w200') + '")').removeClass('hide');
    root.append(art).append(head);
    tint(backdrop ? L.Api && L.Api.img && L.Api.img(backdrop, 'w300') : cover ? L.Api && L.Api.img && L.Api.img(cover, 'w200') : '');
    // The screen takes its accent from the release art; without it (or a canvas) it stays neutral.
    function tint(url) {
      if (!url || typeof Image === 'undefined' || typeof document === 'undefined') return;
      var image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = function () {
        if (dead) return;
        var color = null;
        try {
          var canvas = document.createElement('canvas'), context; canvas.width = 32; canvas.height = 18; context = canvas.getContext('2d');
          context.drawImage(image, 0, 0, 32, 18); color = accentOf(context.getImageData(0, 0, 32, 18).data);
        } catch (_) { return; }
        if (!color) return;
        var a = color.join(','), solid = 'rgb(' + a + ')', name = 'homelab-common-tint-' + (++tintSequence), at = '.' + name + ' ';
        root.addClass(name).append($('<style></style>').text([
          at + '.homelab-common-result.is-hero .homelab-common-pick{color:' + solid + '}',
          at + '.homelab-common-progress-fill,' + at + '.homelab-common-ep-bar,' + at + '.homelab-common-bar-fill,' + at + '.homelab-common-filter.is-on:not(.focus):before{background:' + solid + '}',
          at + '.homelab-common-result:not(.focus) .homelab-common-tag{color:' + solid + ';opacity:1}',
          at + '.homelab-common-result.is-hero.focus{background:-webkit-linear-gradient(left,rgba(' + a + ',.24),rgba(' + a + ',.06) 70%),rgba(0,0,0,.45);background:linear-gradient(100deg,rgba(' + a + ',.24),rgba(' + a + ',.06) 70%),rgba(0,0,0,.45);box-shadow:inset 0 0 0 .14em ' + solid + ',0 .8em 2em rgba(0,0,0,.45)}',
          at + '.homelab-common-result.is-hero.focus .homelab-common-play{background:' + solid + '}' + at + '.homelab-common-result.is-hero.focus .homelab-common-play:after{border-left-color:#14100c}'
        ].join('')));
      };
      image.src = url;
    }
    // Filters: quick chips, then the parameters (also →) on the right.
    var filters = $('<div class="homelab-common-filters"></div>'), chips = {};
    function chip(id, fn) { var tile = button('', 'homelab-common-filter', fn); chips[id] = tile; filters.append(tile); return tile; }
    function applyFilter() { reorder(); updateSummary(); draw(); }
    if (!recovery) {
      chip('all', function () { kind = 'all'; applyFilter(); });
      chip('online', function () { kind = 'online'; applyFilter(); });
      chip('torrent', function () { kind = 'torrent'; applyFilter(); });
    }
    chip('uhd', function () { if (q === 2160) q = qBefore === 2160 ? 0 : qBefore; else { qBefore = q; q = 2160; } if (!recovery) pref = preferences({quality: q}); applyFilter(); });
    chip('subs', function () { subsOnly = !subsOnly; if (!recovery) pref = preferences({subs: subsOnly}); applyFilter(); });
    var otherButton = button('', 'homelab-common-filter homelab-common-other-voices hide', otherVoices); filters.append(otherButton);
    var summary = button('', 'homelab-common-summary', function () { openSettings(); }), summaryText = $('<span class="homelab-common-summary-text"></span>');
    summary.append($('<span class="homelab-common-summary-icon"></span>')).append(summaryText).append($('<span class="homelab-common-summary-go"></span>').text('›'));
    filters.append(summary); root.append(filters);
    // The hero: the top recommendation, played by one OK; the list continues under it.
    var heroBox = $('<div class="homelab-common-herobox hide"></div>'); root.append(heroBox);
    body.appendTo(scroll.body()); main.append(scroll.render()).append(detail); root.append(main); root.append(hint);
    var recoveryLabel = recovery ? $('<div class="homelab-common-recovery"></div>') : null;
    // Recovery banner: the kept voice and the one caveat; the hero says what resumes where.
    function recoveryText() {
      if (!recoveryLabel) return;
      recoveryLabel.empty().append($('<span class="homelab-common-recovery-voice' + (recovery.voice ? '' : ' is-none') + '"></span>').text(recovery.voice ? 'Озвучка: ' + recovery.voice : 'Выберите озвучку'));
      recoveryLabel.append($('<span class="homelab-common-recovery-note"></span>').text('тайминги версий могут отличаться'));
    }
    if (recoveryLabel) { head.after(recoveryLabel); recoveryText(); }
    function active() { return !dead && L.Activity.active() === object; }
    // The list owns focus only while the parameters panel is closed.
    function ownList() { return L.Controller.own(self) && !settingsOpen; }
    // With nothing focused yet: the top of the list, else the parameters (never the episode strip by accident).
    function focus(background) { restoringFocus = !!background; L.Controller.collectionSet(root, false, true); L.Controller.collectionFocus(last && root[0].contains(last) ? last : listNodes()[0] || summary[0], root, true); restoringFocus = false; }
    function touch() { untouched = false; }
    function button(text, cls, fn) {
      return $('<div class="selector ' + cls + '"></div>').text(text).on('hover:focus', function () { last = this; if (!restoringFocus && body[0].contains(this)) scroll.update(this, true); })
        .on('hover:hover hover:touch', touch).on('hover:enter', function () { touch(); fn.apply(this, arguments); });
    }
    function choose(titleText, values, onSelect) {
      values = values.map(function (value) {
        var item = Object.assign({}, value), html = $('<div class="selectbox-item selector"></div>');
        html.append($('<div class="selectbox-item__title"></div>').text(item.title || ''));
        html.append($('<div class="selectbox-item__subtitle"></div>').text(item.subtitle || ''));
        item.html = html; return item;
      });
      L.Select.show({title: titleText, items: values, onSelect: function (value) { L.Select.close(); onSelect(value); if (active()) self.start(); }, onBack: function () { if (active()) self.start(); }});
    }
    function resetList() {
      Object.keys(tiles).forEach(function (key) { tiles[key].remove(); }); tiles = {}; models = {};
      locked = false; order = []; shown = 20; last = null; fresh = 0; freshKeys = {}; sequence = ''; sequenceKeys = []; detailSig = ''; detailKey = ''; scroll.reset();
    }
    // Torrents sit in their own section under the online voices, open by default; OK on the header folds it.
    function section(count, open) {
      var tile = tiles['section:torrents'];
      if (!tile) tile = tiles['section:torrents'] = button('', 'homelab-common-section', function () {
        torrentsOpen = !sectionOpen; toggled = true; locked = true; draw();
      });
      tile.text((open ? '▾ Торренты · ' : '▸ Торренты · ') + plural(count, ['раздача', 'раздачи', 'раздач']) + (open ? '' : ' — показать'));
      return tile;
    }
    var sectionOpen = false, voicesOpen = null;
    // Recovery keeps the voice: its sources are the list, other voices fold below.
    function voicesSection(count, open) {
      var tile = tiles['section:voices'];
      if (!tile) tile = tiles['section:voices'] = button('', 'homelab-common-section', function () { voicesOpen = !voicesShown; locked = true; draw(); });
      tile.text((open ? '▾ Другие озвучки · ' : '▸ Другие озвучки · ') + count + (open ? '' : ' — показать'));
      return tile;
    }
    var voicesShown = false;
    // Voices whose quality nobody checked fold below the checked ones.
    var checkedKeys = {}, uncheckedOpen = true, uncheckedShown = true;
    function uncheckedSection(count, open) {
      var tile = tiles['section:unchecked'];
      if (!tile) tile = tiles['section:unchecked'] = button('', 'homelab-common-section', function () { uncheckedOpen = !uncheckedShown; locked = true; draw(); });
      tile.text((open ? '▾ Ещё ' : '▸ Ещё ') + plural(count, ['озвучка', 'озвучки', 'озвучек']) + ' · качество не проверено');
      return tile;
    }
    function sourceMode() { return grouped && !!(recovery && recovery.voice); }
    // The voice this title is being watched in (Continue): its card leads, from the source that played it.
    function watchedVoice() {
      if (recovery || !window.homelabContinue || typeof window.homelabContinue.list !== 'function') return null;
      var card = (movie.name ? 'tv_' : 'movie_') + movie.id, item = null;
      try { item = window.homelabContinue.list().find(function (entry) { return entry && entry.card === card && entry.kind === 'online' && entry.online && entry.online.voice; }); } catch (_) {}
      var canon = item ? canonVoice(item.online.voice) : null;
      return canon && canon.key ? {key: 'voice:' + canon.key, provider: item.online.provider, label: canon.label, season: item.season || 0, episode: item.episode || 0, position: Number(item.position) || 0, duration: Number(item.duration) || 0} : null;
    }
    // Where this title stands in Continue, whatever played it: the episode strip marks it.
    function continued() {
      if (!window.homelabContinue || typeof window.homelabContinue.list !== 'function') return null;
      var card = (tv ? 'tv_' : 'movie_') + movie.id;
      try { return window.homelabContinue.list().find(function (entry) { return entry && entry.card === card; }) || null; } catch (_) { return null; }
    }
    var mine = watchedVoice();
    function otherVoices() {
      if (!recovery || !active() || sync.scope() !== currentScope) return;
      recovery.voice = ''; recoveryText(); locked = false; order = []; shown = 20; last = null; scroll.reset(); updateSummary(); draw();
      if (ownList()) focus(true);
    }
    function matchLabel(tile, row) {
      tile.find('.homelab-common-match').toggleClass('hide', !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) !== 1);
    }
    function seasonTitle(value) { return value === 0 ? 'Спецвыпуски' : 'Сезон ' + value; }
    // The chips show what to search and 4K/subtitles; the parameters chip names the rest.
    function updateSummary() {
      var parts = [];
      if (tv) parts.push((selection.season === 0 ? 'Спецвыпуски' : 'С' + selection.season) + ' · Е' + selection.episode);
      if (q && q !== 2160) parts.push(qualityLabel(q));
      if (!grouped) parts.push('все источники');
      summaryText.text(parts.length ? parts.join(' · ') : 'Параметры');
      if (chips.all) chips.all.toggleClass('is-on', kind === 'all');
      if (chips.online) chips.online.toggleClass('is-on', kind === 'online');
      if (chips.torrent) chips.torrent.toggleClass('is-on', kind === 'torrent');
      chips.uhd.toggleClass('is-on', q === 2160); chips.subs.toggleClass('is-on', !!subsOnly);
    }
    function chipText(id, name, count) {
      var tile = chips[id]; if (!tile) return;
      var sig = name + '|' + (count === undefined ? '' : count);
      if (tile.data('sig') === sig) return;
      tile.data('sig', sig).empty().append($('<span></span>').text(name));
      if (count !== undefined) tile.append($('<span class="homelab-common-filter-count"></span>').text(String(count)));
    }
    // ── Episode strip: a window of the season's episodes; OK searches one, the edges slide the window ──
    function seasonEntry(season) { return Array.isArray(movie.seasons) ? movie.seasons.find(function (entry) { return entry && entry.season_number === season; }) : null; }
    function askSeasons() {
      if (!tv || recovery || seasonsAsked || Array.isArray(movie.seasons) && movie.seasons.length) return;
      seasonsAsked = true;
      L.Api.sources.tmdb.get('tv/' + movie.id, {}, function (data) {
        if (dead || !data || +data.id !== movie.id || !Array.isArray(data.seasons)) return;
        movie.seasons = data.seasons; drawStrip();
        if (settingsOpen && active()) { renderSettings(); focusSetting(); }
      }, function () {});
    }
    // keep: the strip node to refocus after a restart (an episode number, or -1 for the season button).
    function drawStrip(keep) {
      if (!tv || recovery) return;
      var entry = seasonEntry(selection.season), count = entry && Number.isInteger(entry.episode_count) ? Math.min(entry.episode_count, 999) : 0;
      var total = count ? Math.max(count, selection.episode) : 0, center = stripCenter || selection.episode;
      var from = Math.max(1, total ? Math.min(center - 3, total - 6) : center - 3), to = total ? Math.min(total, from + 6) : from + 6;
      var focused = keep || (last && strip[0].contains(last) ? last.homelabEpisode : 0), target = null, seen = continued();
      strip.empty().removeClass('hide');
      var seasonButton = button(seasonTitle(selection.season), 'homelab-common-season', function () { seasonMenu(); });
      seasonButton[0].homelabEpisode = -1; strip.append(seasonButton);
      strip.append($('<span class="homelab-common-eps-arrow"></span>').text(from > 1 ? '‹' : ''));
      for (var ep = from; ep <= to; ep++) strip.append(episodeTile(ep, from, to, total, seen));
      strip.append($('<span class="homelab-common-eps-arrow"></span>').text(!total || to < total ? '›' : ''));
      if (count) strip.append($('<span class="homelab-common-eps-total"></span>').text('из ' + count));
      Array.prototype.forEach.call(strip[0].querySelectorAll('.selector'), function (node) { if (focused && node.homelabEpisode === focused) target = node; });
      if (focused && ownList()) { last = target || strip[0].querySelectorAll('.selector')[0]; focus(true); }
    }
    function episodeTile(ep, from, to, total, seen) {
      var cls = 'homelab-common-ep' + (ep === selection.episode ? ' is-current' : ''), started = 0;
      if (seen && seen.season === selection.season) {
        if (ep < seen.episode) cls += ' is-watched';
        else if (ep === seen.episode && Number(seen.duration) > 0) started = Math.min(1, Math.max(0, Number(seen.position) / Number(seen.duration)));
      }
      var tile = button(String(ep), cls, function () {
        if (ep === selection.episode || !active()) return;
        selection.episode = ep; stripCenter = ep; untouched = true; restart();
      });
      tile[0].homelabEpisode = ep;
      if (started > 0) tile.append($('<span class="homelab-common-ep-bar"></span>').css('width', Math.round(started * 100) + '%'));
      // Reaching an edge slides the window so the next episodes come into view.
      tile.on('hover:focus', function () {
        if (!(ep === from && from > 1 || ep === to && (!total || to < total))) return;
        clearTimeout(stripTimer); stripTimer = setTimeout(function () { if (!dead && last && last.homelabEpisode === ep) { stripCenter = ep; drawStrip(); } }, 0);
      });
      return tile;
    }
    function seasonMenu(preferred) {
      var token = ++uiIntent, marked = Number.isInteger(preferred) ? preferred : selection.season;
      function complete(data) {
        if (!active() || token !== uiIntent || !ownList() || sync.scope() !== currentScope) return;
        var seasons = data && Array.isArray(data.seasons) ? data.seasons : [];
        var values = seasons.filter(function (entry) { return Number.isInteger(entry.season_number) && entry.season_number >= 0 && entry.season_number <= 999; }).map(function (entry) {
          return {title: entry.name || seasonTitle(entry.season_number), value: entry.season_number, selected: entry.season_number === marked};
        });
        if (!values.length) return L.Noty.show('Не удалось получить список сезонов');
        movie.seasons = seasons;
        choose('Сезон', values, function (value) { selection.season = value.value; selection.episode = 1; untouched = true; restart(); });
      }
      if (Array.isArray(movie.seasons) && movie.seasons.length) return complete(movie);
      L.Api.sources.tmdb.get('tv/' + movie.id, {}, function (data) { complete(data && +data.id === movie.id ? data : null); }, function () { complete(null); });
    }
    // The list of a season picked in the panel but not yet searched: choosing an episode applies both.
    function episodeMenu(wanted) {
      var season = wanted ? wanted.season : selection.season, marked = wanted ? wanted.episode : selection.episode, token = ++uiIntent, from = selection.season;
      L.Api.sources.tmdb.get('tv/' + movie.id + '/season/' + season, {}, function (data) {
        if (!active() || token !== uiIntent || from !== selection.season || !ownList() || sync.scope() !== currentScope) return;
        choose('Серия', (data.episodes || []).map(function (episode) { return {title: episode.episode_number + ' · ' + episode.name, value: episode.episode_number, selected: episode.episode_number === marked}; }), function (value) { selection.season = season; selection.episode = value.value; untouched = true; restart(); });
      }, function () { if (active()) L.Noty.show('Не удалось получить список серий'); });
    }
    // ── Parameters: what the header chips used to hold, one press of → away from any row ──
    var SETTINGS = 'homelab_common_settings', panel = $('<div class="homelab-common-settings hide"></div>'), panelList = $('<div class="homelab-common-settings-list"></div>');
    var settingsOpen = false, settingIndex = 0, settingRows = [], pending = null, seasonsAsked = false;
    panel.append($('<div class="homelab-common-settings-title"></div>').text('Параметры')).append(panelList)
      .append($('<div class="homelab-common-settings-hint"></div>').text('↑↓ выбор · ←→ значение · ОК — список · Назад — закрыть'));
    root.append(panel);
    // A click (mouse, touch) outside the panel closes it, as Back does; the click that opened it (on the chip) bubbles here too.
    root.on('click', function (event) { if (settingsOpen && event && event.target && !panel[0].contains(event.target) && !summary[0].contains(event.target)) closeSettings(); });
    function seasonList() {
      var known = Array.isArray(movie.seasons) ? movie.seasons.map(function (entry) { return entry && entry.season_number; }).filter(function (value) { return Number.isInteger(value) && value >= 0 && value <= 999; }) : [];
      if (!known.length && Number.isInteger(movie.number_of_seasons) && movie.number_of_seasons > 0) for (var i = 1; i <= Math.min(movie.number_of_seasons, 999); i++) known.push(i);
      if (known.indexOf(pending.season) < 0) known.push(pending.season);
      return known.sort(function (a, b) { return a - b; });
    }
    function episodeList() {
      var entry = Array.isArray(movie.seasons) && movie.seasons.find(function (value) { return value && value.season_number === pending.season; }), count = entry && Number.isInteger(entry.episode_count) ? Math.min(entry.episode_count, 999) : 0, list = [];
      for (var i = 1; i <= count; i++) list.push(i);
      if (list.indexOf(pending.episode) < 0) list.push(pending.episode);
      return list.sort(function (a, b) { return a - b; });
    }
    function reorder() { shown = 20; locked = false; order = []; scroll.reset(); }
    function settingEntries() {
      var list = [];
      if (tv && !recovery) {
        list.push({label: 'Сезон', values: seasonList().map(function (value) { return {value: value, title: seasonTitle(value)}; }), current: pending.season,
          set: function (value) { pending.season = value; pending.episode = 1; }, enter: function (wanted) { seasonMenu(wanted.season); }, edge: true});
        list.push({label: 'Серия', values: episodeList().map(function (value) { return {value: value, title: 'Серия ' + value}; }), current: pending.episode,
          set: function (value) { pending.episode = value; }, enter: episodeMenu, edge: true});
      }
      list.push({label: 'Что искать', values: [['all', 'Всё'], ['online', 'Онлайн'], ['torrent', 'Торренты']].filter(function (value) { return !recovery || value[0] !== 'torrent'; }).map(function (value) { return {value: value[0], title: value[1]}; }),
        current: kind, set: function (value) { kind = value; reorder(); }});
      list.push({label: 'Качество', values: [0, 2160, 1080, 720].map(function (value) { return {value: value, title: value ? qualityLabel(value) : 'Любое'}; }),
        current: q, set: function (value) { q = value; qBefore = 0; if (!recovery) pref = preferences({quality: value}); reorder(); }});
      list.push({label: 'Показывать', values: [{value: true, title: 'По озвучкам'}, {value: false, title: 'Все источники'}], current: grouped,
        set: function (value) { grouped = value; resetList(); }});
      list.push({label: 'Субтитры', values: [{value: false, title: 'Неважно'}, {value: true, title: 'Только с субтитрами'}], current: subsOnly,
        set: function (value) { subsOnly = value; if (!recovery) pref = preferences({subs: value}); reorder(); }});
      if (recovery && recovery.voice) list.push({button: 'Другие озвучки', enter: otherVoices});
      list.push({button: 'Обновить поиск', refresh: true});
      return list;
    }
    function currentIndex(entry) { for (var i = 0; i < entry.values.length; i++) if (entry.values[i].value === entry.current) return i; return 0; }
    function renderSettings() {
      settingRows = settingEntries(); settingIndex = Math.max(0, Math.min(settingIndex, settingRows.length - 1)); panelList.empty();
      settingRows.forEach(function (entry, index) {
        var row = $('<div class="selector homelab-common-setting' + (entry.button ? ' is-button' : '') + '"></div>');
        if (entry.button) row.text(entry.button);
        else {
          var values = $('<div class="homelab-common-setting-values"></div>'), at = currentIndex(entry), from = entry.values.length > 5 ? Math.max(0, Math.min(at - 2, entry.values.length - 5)) : 0;
          entry.values.slice(from, from + 5).forEach(function (value, offset) {
            values.append($('<span class="homelab-common-setting-value' + (from + offset === at ? ' selected' : '') + '"></span>').text(value.title));
          });
          if (from + 5 < entry.values.length) values.append($('<span class="homelab-common-setting-more"></span>').text('…'));
          row.append($('<div class="homelab-common-setting-label"></div>').text(entry.label)).append(values);
        }
        row.on('hover:focus', function () { settingIndex = index; }).on('hover:enter', function () { settingIndex = index; activateSetting(); });
        entry.node = row; panelList.append(row);
      });
    }
    function focusSetting() {
      var entry = settingRows[settingIndex];
      if (entry) { L.Controller.collectionSet(panel, false, true); L.Controller.collectionFocus(entry.node[0], panel, true); }
    }
    function stepSetting(direction, closes) {
      var entry = settingRows[settingIndex];
      if (!entry) return;
      var next = entry.values ? currentIndex(entry) + direction : -1;
      if (!entry.values || next < 0 || next >= entry.values.length) { if (closes && !entry.edge) closeSettings(); return; }
      entry.set(entry.values[next].value); updateSummary(); draw(); renderSettings(); focusSetting();
    }
    // OK on a value row: the full list where there is one (seasons, episodes), else the next value.
    function activateSetting() {
      var entry = settingRows[settingIndex];
      if (!entry) return;
      if (entry.refresh) { closeSettings(false, true); restart(true); return; }
      if (entry.enter) { var wanted = pending; closeSettings(true); entry.enter(wanted); return; }
      var next = (currentIndex(entry) + 1) % entry.values.length;
      entry.set(entry.values[next].value); updateSummary(); draw(); renderSettings(); focusSetting();
    }
    function openSettings() {
      if (!active() || settingsOpen) return;
      touch(); settingsOpen = true; pending = {season: selection.season, episode: selection.episode}; settingIndex = 0;
      panel.removeClass('hide'); root.addClass('is-settings'); renderSettings();
      L.Controller.toggle(SETTINGS);
      // Seasons and their episode counts come from the title's metadata, asked once.
      askSeasons();
    }
    // Closing applies a changed episode; discard drops it (a full season or episode list replaces it).
    // quiet: apply the episode but leave the search to the caller.
    function closeSettings(discard, quiet) {
      if (!settingsOpen) return;
      var wanted = pending; settingsOpen = false; pending = null; panel.addClass('hide'); root.removeClass('is-settings');
      if (!discard && wanted && (wanted.season !== selection.season || wanted.episode !== selection.episode)) {
        selection.season = wanted.season; selection.episode = wanted.episode; untouched = true;
        if (!quiet) restart();
      }
      // A filter change may have removed the focused card: return to the top of the list, not the header.
      if (!last || !inList(last) || !visibleNode(last)) last = listNodes()[0] || last;
      if (active()) L.Controller.toggle('content');
    }
    function directIdentity(row) {
      return /^[a-z0-9_.-]{1,80}$/i.test(row.provider) && typeof row.identityVoice === 'string' && row.identityVoice.length <= 200 && Number.isInteger(row.seasonIndex) && row.seasonIndex >= 0 && row.seasonIndex <= 999;
    }
    function openNative(row) {
      L.Activity.push({component: 'lampac', movie: movie, title: 'Онлайн', search: movie.title || movie.name, search_one: movie.title || movie.name, search_two: movie.original_title || movie.original_name, page: 1, lampac_custom_select: row.provider});
    }
    function open(row) {
      if (!active() || sync.scope() !== currentScope) return;
      // Another voice is a choice made in the "Другие озвучки" fold (or after clearing the voice); the failed provider never is.
      if (recovery && (row.native || row.kind !== 'online' || row.provider === recovery.excludeProvider || recovery.voice && !sourceMode() && !voiceMatch(recovery.voice, row.identityVoice))) return;
      // Online handoffs push an activity, whose pause() cancels the search; a refused handoff keeps it running.
      if (row.kind === 'torrent') {
        cancel(); draw();
        var release = Object.assign({}, row.release, {title: row.release.Title, poster: movie.img || (movie.poster_path ? L.Api.img(movie.poster_path) : '')});
        L.Torrent.back(function () { if (active()) self.start(); }); L.Torrent.start(release, movie);
      } else if (row.native) {
        openNative(row);
      } else if (!directIdentity(row)) {
        // The bridge only accepts bounded identities; open the provider natively rather than claim it is loading.
        L.Noty.show('Этот вариант откроется в источнике');
        openNative(row);
      } else if (!window.HomelabOnlineResume || !window.HomelabOnlineResume.select(row, movie, selection, q || recovery && recovery.quality, recovery)) {
        L.Noty.show('Онлайн-источник ещё загружается. Повторите выбор');
      }
    }
    function rowSubtitles(row) {
      if (row.subtitles !== undefined) return row.subtitles;
      if (row.release && !row.described) row.described = describeRelease(row.release);
      return row.described && row.described.subtitles || null;
    }
    function hasSubtitles(row) { return !!rowSubtitles(row) || !!(row.canon && row.canon.subs); }
    // null when no row has subtitles, else their languages ("" when unnamed).
    function subtitleLanguagesOf(rows) {
      var found = null;
      rows.forEach(function (row) {
        var subtitles = rowSubtitles(row); if (!subtitles) return;
        found = (found || '').split(' · ').concat(subtitles.langs.split(' · ')).filter(function (lang, index, all) { return lang && all.indexOf(lang) === index; }).join(' · ');
      });
      return found;
    }
    function subtitleNote(row) { var subtitles = rowSubtitles(row); return subtitles ? 'субтитры' + (subtitles.langs ? ' ' + subtitles.langs : '') : ''; }
    function qualityClass(value) { return value >= 2160 ? 'is-uhd' : value >= 1080 ? 'is-hd' : value ? 'is-sd' : 'is-none'; }
    function gigabytes(release) { var size = Number(release.Size || release.size); return size > 0 ? (size / 1073741824).toFixed(1).replace('.', ',') + ' ГБ' : ''; }
    // What a card shows; the signature lets draw() skip unchanged cards instead of rebuilding them.
    function view(item, hero) {
      var row = item.best, count = item.rows.length, best = row.qualities[0] || 0;
      if (item.key === 'native') {
        var names = item.rows.map(function (entry) { return entry.providerName; }).filter(function (name, index, all) { return all.indexOf(name) === index; });
        var nativeModel = {voice: 'Открыть в источниках', details: plural(names.length, SOURCES) + ': ' + names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '') + ' · выбор внутри источника',
          badges: [], cls: 'is-native', note: '', quality: '', qcls: 'is-none', pick: ''};
        nativeModel.sig = [nativeModel.voice, nativeModel.details].join('|');
        return nativeModel;
      }
      if (item.nativeOne) {
        var oneModel = {voice: row.providerName, details: 'откроется список озвучек источника', badges: [], cls: 'is-native', note: '', quality: '', qcls: 'is-none', pick: '', what: '', progress: 0};
        oneModel.sig = ['one', oneModel.voice].join('|');
        return oneModel;
      }
      if (item.source) {
        var sourceModel = {voice: sourceName(row), badges: [], cls: 'is-online is-source', note: ''};
        sourceModel.details = [row.canon && row.canon.label || row.identityVoice, row.unavailable ? 'Не отдаёт видео' : !best ? 'Качество уточняется' : ''].filter(Boolean).join(' · ');
        var sourceLangs = subtitleLanguagesOf([row]);
        if (sourceLangs !== null || row.canon && row.canon.subs) sourceModel.badges.push([sourceLangs || 'субтитры', 'is-subs']);
        if (row.unavailable) { sourceModel.quality = 'нет видео'; sourceModel.qcls = 'is-off'; sourceModel.cls += ' is-unavailable'; }
        else if (best) { sourceModel.quality = qualityLabel(best); sourceModel.qcls = qualityClass(best); }
        else { sourceModel.quality = '—'; sourceModel.qcls = 'is-none'; }
        sourceModel.cls += ' has-' + sourceModel.qcls.slice(3);
        if (!row.unavailable && best) sourceModel.note = row.verified === 'play' ? 'по просмотру' : row.measured ? 'проверено' : row.doubtful ? 'заявлено, не проверено' : 'заявлено';
        sourceModel.measured = !!row.measured;
        sourceModel.pick = hero ? 'Лучший источник' + (row.measured ? ' · проверено' : '') : '';
        if (hero) sourceModel.cls += ' is-hero';
        heroLine(sourceModel, hero, false);
        sourceModel.sig = ['src', sourceModel.voice, sourceModel.details, sourceModel.quality, sourceModel.qcls, sourceModel.note, sourceModel.measured, sourceModel.pick, sourceModel.cls, sourceModel.badges.join(','), sourceModel.what, sourceModel.progress].join('|');
        return sourceModel;
      }
      var voice = !grouped ? row.voice : row.kind === 'torrent' ? (row.canon && row.canon.label || row.voice) : row.canon && row.canon.label || row.identityVoice || row.voice;
      if (voice === UNNAMED) voice = UNNAMED + ' · ' + row.providerName;
      var subs = item.rows.some(function (entry) { return entry.canon && entry.canon.subs; }), langs = subtitleLanguagesOf(item.rows);
      var model = {voice: voice, badges: [], cls: row.kind === 'torrent' ? 'is-torrent' : 'is-online', note: ''};
      model.details = row.providerName + ' · ' + (count > 1 ? 'ещё ' + plural(count - 1, row.kind === 'torrent' ? ['раздача', 'раздачи', 'раздач'] : item.key.indexOf('unnamed:') === 0 ? ['видео', 'видео', 'видео'] : SOURCES) : row.kind === 'torrent' ? 'Торрент' : 'Онлайн');
      if (row.release) {
        var described = row.described || (row.described = describeRelease(row.release)), size = gigabytes(row.release), seeds = Number(row.release.Seeders);
        if (Number.isFinite(seeds)) model.badges.push([plural(seeds, ['сид', 'сида', 'сидов']), seeds >= MIN_SEEDS ? 'is-seeds' : 'is-dead']);
        if (size) model.badges.push([size, '']);
        if (described.codec) model.badges.push([described.codec, '']);
        if (described.languages) model.badges.push([described.languages, '']);
        if (described.voices.length > 1) model.details += ' · ' + described.voices.slice(1, 3).join(', ');
        if (tv) model.details += ' · Выбор серии в раздаче';
        if (row.voiceProbe === 'pending') model.details += ' · узнаю озвучку…';
      } else if (row.unavailable) model.details += ' · Не отдаёт видео';
      else if (!best) model.details += row.native ? ' · Качество неизвестно · Открыть источник' : ' · Качество уточняется';
      // Subtitle tracks (an online file, a release's streams or title), or a subtitled voice: the CC mark carries the word.
      if (langs !== null || subs) model.badges.push([langs || 'субтитры', 'is-subs']);
      if (row.unavailable) { model.quality = 'нет видео'; model.qcls = 'is-off'; model.cls += ' is-unavailable'; }
      else if (best) { model.quality = qualityLabel(best); model.qcls = qualityClass(best); }
      else { model.quality = '—'; model.qcls = 'is-none'; }
      model.cls += ' has-' + model.qcls.slice(3);
      if (!row.unavailable && best && row.kind === 'online') {
        model.note = row.verified === 'play' ? 'по просмотру' : row.measured ? 'проверено' : row.doubtful ? 'заявлено, не проверено' : 'заявлено';
        // The source said more than its stream has.
        if (row.measured && row.claimed > best) model.note += ' · заявлено ' + qualityLabel(row.claimed);
      }
      model.measured = !!row.measured;
      var stopped = item.mine && mine.position > 30 && (!tv || mine.season === selection.season && mine.episode === selection.episode);
      // The hero's episode line already says where it resumes.
      model.pick = item.mine ? 'Ваша озвучка · ' + (hero ? (stopped ? 'продолжить' : 'смотреть') : stopped ? 'остановились на ' + L.Utils.secondsToTime(mine.position) : 'вы смотрите в ней') : hero ? 'Лучший выбор' + (row.measured ? ' · проверено' : '') : '';
      if (item.mine) model.cls += ' is-mine';
      if (hero) model.cls += ' is-hero';
      heroLine(model, hero, stopped);
      model.sig = [model.voice, model.details, model.quality, model.qcls, model.note, model.measured, model.pick, model.cls, model.badges.join(','), model.what, model.progress].join('|');
      return model;
    }
    // The hero names what one OK plays: the episode, and where it resumes.
    function heroLine(model, hero, stopped) {
      model.what = ''; model.progress = 0;
      if (!hero) return;
      var at = recovery ? Number(recovery.position) || 0 : stopped ? mine.position : 0, duration = recovery ? Number(recovery.duration) || 0 : stopped ? mine.duration : 0;
      var from = at > 0 ? L.Utils.secondsToTime(at) : '';
      model.what = tv ? (selection.season === 0 ? 'Спецвыпуск ' : 'Серия ') + selection.episode + (from ? ' · с ' + from : '') : from ? 'Продолжить с ' + from : '';
      if (at > 0 && duration > 0) model.progress = Math.round(Math.min(1, at / duration) * 100);
    }
    function fill(tile, model) {
      if (tile.data('sig') === model.sig) return;
      tile.data('sig', model.sig);
      // Swap only the modifier classes so Lampa's own focus class survives.
      tile.removeClass(tile.data('cls') || '').addClass(model.cls).data('cls', model.cls);
      tile.find('.homelab-common-pick').text(model.pick).toggleClass('hide', !model.pick);
      tile.find('.homelab-common-what').text(model.what || '').toggleClass('hide', !model.what);
      tile.find('.homelab-common-progress').toggleClass('hide', !model.progress).find('.homelab-common-progress-fill').css('width', (model.progress || 0) + '%');
      tile.find('.homelab-common-voice').text(model.voice);
      tile.find('.homelab-common-details').text(model.details);
      var badges = tile.find('.homelab-common-badges').empty().toggleClass('hide', !model.badges.length);
      model.badges.forEach(function (badge) { badges.append($('<span class="homelab-common-badge ' + badge[1] + '"></span>').text(badge[0])); });
      var badge = tile.find('.homelab-common-q'); badge.removeClass(badge.data('cls') || '').addClass(model.qcls).data('cls', model.qcls).text(model.quality);
      var note = tile.find('.homelab-common-q-note').toggleClass('hide', !model.note).toggleClass('is-measured', !!model.measured).empty();
      if (model.measured) note.append($('<span class="homelab-common-check"></span>').html(CHECK));
      if (model.note) note.append($('<span></span>').text(model.note));
    }
    function card(key) {
      var tile = $('<div class="selector homelab-common-result"></div>'), text = $('<div class="homelab-common-text"></div>'), side = $('<div class="homelab-common-quality"></div>');
      // One line in the list; as the hero the same tile grows a play mark, the episode line and progress.
      text.append($('<div class="homelab-common-pick hide"></div>')).append($('<div class="homelab-common-what hide"></div>'))
        .append($('<div class="homelab-common-name"></div>').append($('<span class="homelab-common-voice"></span>')).append($('<span class="homelab-common-tag">ваша</span>')))
        .append($('<div class="homelab-common-match hide"></div>').text('Та же студия · название отличается, проверьте версию'))
        .append($('<div class="homelab-common-line"></div>').append($('<span class="homelab-common-details"></span>')).append($('<span class="homelab-common-badges hide"></span>')));
      side.append($('<div class="homelab-common-q"></div>')).append($('<div class="homelab-common-q-note hide"></div>'));
      tile.append($('<div class="homelab-common-play"></div>')).append(text).append(side)
        .append($('<div class="homelab-common-progress hide"></div>').append($('<div class="homelab-common-progress-fill"></div>')));
      tile.on('hover:focus', function () {
        last = this; if (!restoringFocus) { locked = true; if (body[0].contains(this)) scroll.update(this, true); else scroll.reset(); }
        showDetail(key);
        // Dwelling on a torrent without a named voice asks its audio tracks.
        var focused = this; clearTimeout(voiceTimer);
        voiceTimer = setTimeout(function () { if (!dead && last === focused && search && models[key] && models[key].best && search.voices) search.voices(models[key].best); }, 1200);
      })
        .on('hover:hover hover:touch', function () { locked = true; touch(); })
        .on('hover:enter', function () { touch(); if (!models[key]) return; if (key === 'native') sourceMenu(models[key]); else open(models[key].best); })
        .on('hover:long', function () { touch(); if (models[key]) sourceMenu(models[key]); });
      return tile;
    }
    // One source of a card, as the detail panel and the source menu name it.
    function sourceName(entry) {
      if (entry.release || entry.native) return entry.providerName;
      // What sets this source's track apart within the card: «Дублированный HDrezka» under HDRezka reads «Дублированный».
      var voice = String(entry.voice || ''), identity = String(entry.canon && entry.canon.label || entry.identityVoice || ''), at = identity ? voice.toLowerCase().indexOf(identity.toLowerCase()) : -1;
      var extra = at >= 0 ? (voice.slice(0, at) + ' ' + voice.slice(at + identity.length)).replace(/[\s·,|()\-–]+/g, ' ').replace(/^\s+|\s+$/g, '') : voice !== identity ? voice : '';
      return entry.providerName + (extra ? ' · ' + extra : '');
    }
    function rowLine(row) {
      if (row.unavailable) return 'Не отдаёт видео';
      if (row.native) return 'Открыть в источнике';
      var note = subtitleNote(row), subtitles = note ? ' · ' + note : '';
      if (!row.qualities.length) return 'Качество уточняется' + subtitles;
      return row.qualities.map(qualityLabel).join(' / ') + (row.kind === 'online' ? (row.verified === 'play' ? ' · по просмотру' : row.measured ? ' · проверено' : ' · заявлено') + (row.measured && row.claimed > (row.qualities[0] || 0) ? ' (заявлено ' + qualityLabel(row.claimed) + ')' : '') : '') + subtitles;
    }
    function releaseLine(entry) {
      var seeds = Number(entry.release.Seeders);
      return [entry.qualities.length ? qualityLabel(entry.qualities[0]) : '', Number.isFinite(seeds) ? plural(seeds, ['сид', 'сида', 'сидов']) : '', gigabytes(entry.release), subtitleNote(entry), entry.providerName].filter(Boolean).join(' · ');
    }
    // ── Detail panel: the focused card's sources and how far their quality can be trusted ──
    function verdict(item) {
      var row = item.best, best = row.unavailable ? 0 : row.qualities[0] || 0;
      if (item.key === 'native' || row.native) return ['', 'Этот источник не отдаёт список озвучек сюда: ОК откроет его, озвучку и качество выберете там'];
      if (row.unavailable) return ['is-bad', 'Источник не отдаёт видео'];
      if (row.release) { var seeds = Number(row.release.Seeders); return Number.isFinite(seeds) ? [seeds >= MIN_SEEDS ? 'is-ok' : 'is-bad', seeds >= MIN_SEEDS ? plural(seeds, ['сид', 'сида', 'сидов']) + ' · раздача живая' : 'Мало сидов: запуск может не начаться'] : ['', 'Раздача']; }
      if (row.measured && row.claimed > best) return ['is-warn', 'Заявлено ' + qualityLabel(row.claimed) + ', поток ' + qualityLabel(best)];
      if (row.verified === 'play') return ['is-ok', '✓ Подтверждено просмотром'];
      if (row.measured) return ['is-ok', '✓ Проверено по потоку'];
      if (best) return ['', row.doubtful ? 'Заявлено источником, который часто завышает' : 'Заявлено источником, ещё не проверено'];
      return ['', 'Качество уточняется'];
    }
    function sourceValue(entry) {
      if (entry.unavailable) return ['is-bad', 'нет видео'];
      if (entry.native) return ['', 'выбор в источнике'];
      if (entry.release) { var seeds = Number(entry.release.Seeders); return [Number.isFinite(seeds) && seeds < MIN_SEEDS ? 'is-bad' : '', [entry.qualities.length ? qualityLabel(entry.qualities[0]) : '', Number.isFinite(seeds) ? plural(seeds, ['сид', 'сида', 'сидов']) : '', gigabytes(entry.release)].filter(Boolean).join(' · ')]; }
      var best = entry.qualities[0] || 0;
      if (!best) return ['', 'уточняется'];
      if (entry.measured && entry.claimed > best) return ['is-warn', qualityLabel(best) + ' · заявлено ' + qualityLabel(entry.claimed)];
      return [entry.measured ? 'is-ok' : '', qualityLabel(best) + (entry.verified === 'play' ? ' · по просмотру' : entry.measured ? ' · проверено' : ' · заявлено')];
    }
    function keysText(item) {
      if (recovery) return 'ОК — продолжить с ' + L.Utils.secondsToTime(recovery.position) + (item && !item.source && item.rows.length > 1 ? ' · удержание ОК — все источники' : '') + ' · → параметры';
      return 'ОК — смотреть · удержание ОК — все источники · → параметры';
    }
    function showDetail(key) {
      var item = key && models[key];
      if (!item || item.section) return;
      var row = item.best, model = view(item, false);
      var sig = [key, model.sig, item.source ? visibleItems.filter(function (entry) { return entry.source; }).map(function (entry) { return entry.key + ':' + (entry.best.qualities[0] || 0) + (entry.best.measured ? 'm' : ''); }).join(',') : '', item.rows.map(function (entry) { return entry.key + ':' + (entry.qualities[0] || 0) + (entry.measured ? 'm' : '') + (entry.unavailable ? 'u' : ''); }).join(',')].join('|');
      if (sig === detailSig) return;
      detailSig = sig; detailKey = key; detail.empty().removeClass('hide');
      var top = $('<div class="homelab-common-detail-top"></div>'), named = $('<div class="homelab-common-detail-name"></div>');
      top.append($('<div class="homelab-common-ring ' + model.qcls + '"></div>').text(model.quality || '—'));
      named.append($('<div class="homelab-common-detail-voice"></div>').text(model.voice));
      named.append($('<div class="homelab-common-detail-kind"></div>').text(item.source ? (row.canon && row.canon.label || row.identityVoice) : item.key === 'native' || row.native ? 'Выбор внутри источника' : row.release ? 'Торрент' + (row.described && row.described.codec ? ' · ' + row.described.codec : '') : 'Онлайн · ' + plural(item.rows.length, SOURCES)));
      detail.append(top.append(named));
      var said = verdict(item);
      detail.append($('<div class="homelab-common-verdict ' + said[0] + '"></div>').text(said[1]));
      var langs = subtitleLanguagesOf(item.rows);
      if (langs !== null || item.rows.some(function (entry) { return entry.canon && entry.canon.subs; })) detail.append($('<div class="homelab-common-detail-subs"></div>').text('Субтитры: ' + (langs || 'есть')));
      // A source row compares itself with the other sources of the kept voice; a card lists the sources behind it.
      var compared = item.source ? visibleItems.filter(function (entry) { return entry.source; }).map(function (entry) { return entry.best; }) : item.rows;
      detail.append($('<div class="homelab-common-detail-label"></div>').text(item.source ? 'Все источники озвучки' : row.release ? 'Раздачи' : 'Источники'));
      var list = $('<div class="homelab-common-sources"></div>');
      compared.slice(0, 6).forEach(function (entry) {
        var value = sourceValue(entry), height = entry.unavailable ? 0 : entry.qualities[0] || 0, line = $('<div class="homelab-common-source' + (entry === row ? ' is-best' : '') + '"></div>');
        line.append($('<span class="homelab-common-source-name"></span>').text(sourceName(entry))).append($('<span class="homelab-common-source-value ' + value[0] + '"></span>').text(value[1]));
        line.append($('<span class="homelab-common-meter"></span>').append($('<span class="homelab-common-meter-fill ' + qualityClass(height) + '"></span>').css('width', Math.round(height / 2160 * 100) + '%')));
        list.append(line);
      });
      if (compared.length > 6) list.append($('<div class="homelab-common-source-more"></div>').text('ещё ' + plural(compared.length - 6, row.release ? ['раздача', 'раздачи', 'раздач'] : SOURCES) + (item.source ? ' — ниже в списке' : ' — удержание ОК')));
      detail.append(list).append($('<div class="homelab-common-keys"></div>').text(keysText(item)));
    }
    // Long press: every source behind the card, or every release of a torrent group.
    function sourceMenu(item) {
      var row = item.best, items = [];
      if (search) search.probe(item.rows, true);
      if (item.key === 'native' || row.native) item.rows.forEach(function (entry) { items.push({title: entry.providerName, subtitle: entry.voice, open: entry}); });
      else if (row.release && item.rows.length > 1) item.rows.forEach(function (entry) { items.push({title: String(entry.release.Title).slice(0, 160), subtitle: releaseLine(entry) + (entry === row ? ' · лучшая' : ''), open: entry, selected: entry === row}); });
      else if (row.release) items.push({title: row.release.Title, subtitle: releaseLine(row), noenter: true}, {title: 'Смотреть', open: row});
      else item.rows.forEach(function (entry) {
        items.push({title: sourceName(entry) + (entry === row && item.rows.length > 1 ? ' · лучший' : ''), subtitle: rowLine(entry), open: entry, selected: entry === row});
      });
      var heading = item.key === 'native' || row.native ? row.providerName || 'Открыть в источнике' : row.release ? (item.rows.length > 1 ? plural(item.rows.length, ['раздача', 'раздачи', 'раздач']) : 'Раздача') : (item.rows.length > 1 ? plural(item.rows.length, SOURCES) + ' · ' : '') + (row.canon && row.canon.label || row.identityVoice);
      choose(heading, items, function (value) {
        if (value.open) open(value.open);
      });
    }
    function showPlaceholder(state, loading) {
      if (state === placeholderState) { if (placeholder) body.append(placeholder); return; }
      placeholderState = state; if (placeholder) { placeholder.remove(); placeholder = null; }
      if (!state) return;
      if (loading) {
        placeholder = $('<div class="homelab-common-skeletons"></div>');
        for (var i = 0; i < 4; i++) placeholder.append($('<div class="homelab-common-skeleton"></div>'));
      } else {
        placeholder = $('<div class="homelab-common-empty"></div>');
        placeholder.append($('<div class="homelab-common-empty-title"></div>').text(recovery ? 'Других подходящих источников нет' : 'Ничего не нашлось'));
        placeholder.append($('<div class="homelab-common-empty-hint"></div>').text(subsOnly ? 'Вариантов с субтитрами нет — снимите фильтр в параметрах (→)' : q ? 'В качестве ' + qualityLabel(q) + ' вариантов нет — выберите «Любое» в параметрах (→)' : kind !== 'all' ? 'Попробуйте «Всё» в параметрах (→)' : 'Нажмите → и «Обновить поиск», чтобы поискать заново'));
      }
      body.append(placeholder);
    }
    function draw() {
      if (dead || !search || sync.scope() !== currentScope) return;
      // Re-read each time: playing another voice from here makes it the watched one on return.
      mine = watchedVoice();
      // Groups merge while results stream in; a focused row that disappears
      // hands focus to the row now in its place, never to the filters above.
      var focusedKey = '', focusedIndex = -1;
      Object.keys(tiles).forEach(function (key) { if (tiles[key][0] === last) focusedKey = key; });
      if (focusedKey) focusedIndex = sequenceKeys.indexOf(focusedKey);
      var candidates = search.rows.filter(function (row) { return (kind === 'all' || row.kind === kind) && (!q || row.kind === 'online' && !row.qualities.length || row.qualities.indexOf(q) >= 0) && (!subsOnly || hasSubtitles(row)) && (!recovery || !row.native && row.kind === 'online' && row.provider !== recovery.excludeProvider); });
      var exact = recovery && recovery.voice ? candidates.filter(function (row) { return voiceMatch(recovery.voice, row.identityVoice) === 2; }).length : 0;
      function rank(a, b, tie) {
        var match = recovery && recovery.voice ? voiceMatch(recovery.voice, b.identityVoice) - voiceMatch(recovery.voice, a.identityVoice) : 0;
        return match || compareRows(a, b, tie);
      }
      var available = candidates.filter(function (row) { return !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) > 0; }).sort(function (a, b) { return rank(a, b); });
      var showOther = !sourceMode() && recovery && recovery.voice && candidates.length > 0 && (!exact || last === otherButton[0]);
      otherButton.text('Другие озвучки · ' + candidates.length).toggleClass('hide', !showOther);
      var byVoice = function (list) { return groupRows(list).map(function (item) {
        // The watched voice plays from the source it played from, while that source still has the video.
        if (mine && item.key === mine.key) {
          var same = item.rows.find(function (entry) { return entry.provider === mine.provider && !entry.unavailable; });
          if (same && same !== item.best) { item.rows.splice(item.rows.indexOf(same), 1); item.rows.unshift(same); item.best = same; }
          item.mine = !!item.best && !item.best.unavailable;
        }
        return item;
      }).sort(function (a, b) {
        if (!!a.mine !== !!b.mine) return a.mine ? -1 : 1;
        // Uploads without a named voice (VK, Rutube) are a last resort, however many of them there are.
        var unnamedA = a.key.indexOf('unnamed:') === 0, unnamedB = b.key.indexOf('unnamed:') === 0;
        if (unnamedA !== unnamedB) return unnamedA ? 1 : -1;
        return rank(a.best, b.best, function () { return b.rows.length - a.rows.length || (b.best.measured ? 1 : 0) - (a.best.measured ? 1 : 0); });
      }); };
      var groups = sourceMode() ? available.map(function (row) { return {key: 'row:' + row.key, rows: [row], best: row, source: true}; })
        .concat(byVoice(candidates.filter(function (row) { return !voiceMatch(recovery.voice, row.identityVoice); })).map(function (item) { item.other = true; return item; }))
        : grouped ? byVoice(available) : available.map(function (row) { return {key: 'row:' + row.key, rows: [row], best: row}; });
      var byKey = {}; groups.forEach(function (item) { byKey[item.key] = item; });
      var loading = search.onlinePending || search.torrentPending, now = Date.now();
      // Untouched lists re-rank at most once a second while results stream in; once the user moved, rows keep their places.
      if (!locked && (!loading || !order.length || now - reorderAt >= 1000)) { order = groups.map(function (item) { return item.key; }); reorderAt = now; freshKeys = {}; }
      else {
        if (!locked) { clearTimeout(rerank); rerank = setTimeout(function () { rerank = null; draw(); }, reorderAt + 1000 - now); }
        order = order.filter(function (key) { return !!byKey[key]; });
        groups.forEach(function (item) { if (order.indexOf(item.key) < 0) { order.push(item.key); if (locked) freshKeys[item.key] = true; } });
      }
      var items = order.map(function (key) { return byKey[key]; }), torrents = [];
      // The hero is the top playable item; it sits above the list, which goes on from the next one.
      var heroItem = items[0] && !items[0].other && !items[0].best.native && !items[0].best.unavailable ? items[0] : null;
      if (grouped && !sourceMode()) {
        var rest = items.filter(function (item) { return item !== heroItem; });
        torrents = rest.filter(function (item) { return item.best.kind === 'torrent'; });
        var online = rest.filter(function (item) { return item.best.kind !== 'torrent' && !item.best.native; }), natives = rest.filter(function (item) { return item.best.native; });
        // Checked voices lead; the rest fold away once there are enough checked ones. Membership holds once the user moved.
        if (!locked) { checkedKeys = {}; online.forEach(function (item) { if (isChecked(item)) checkedKeys[item.key] = true; }); }
        var checked = online.filter(function (item) { return checkedKeys[item.key]; }), unchecked = online.filter(function (item) { return !checkedKeys[item.key]; }), list = online;
        if (checked.length >= 2 && unchecked.length) {
          uncheckedShown = !!uncheckedOpen;
          list = [{key: 'label:checked', label: 'Проверенные · ' + plural(checked.length, ['озвучка', 'озвучки', 'озвучек'])}].concat(checked, [{key: 'section:unchecked', section: true, rows: unchecked}], uncheckedShown ? unchecked : []);
        }
        var onlineCount = online.length + (heroItem && heroItem.best.kind !== 'torrent' ? 1 : 0);
        if (kind === 'all') {
          // Open unless the user folded them.
          sectionOpen = torrentsOpen === null ? true : torrentsOpen;
          if (torrents.length && (onlineCount || toggled)) list = list.concat([{key: 'section:torrents', section: true, rows: torrents}], sectionOpen ? torrents : []);
          else list = list.concat(torrents);
        } else list = list.concat(torrents);
        // Under a torrents header the online rows get one too, so no row hangs outside a group.
        if (online.length && list[0] === online[0] && list.some(function (item) { return item.key === 'section:torrents'; })) list.unshift({key: 'label:online', label: 'Онлайн · ' + plural(online.length, ['озвучка', 'озвучки', 'озвучек'])});
        // Sources that keep their voices to themselves: one row each, opened in the source.
        var direct = [], named = {};
        natives.forEach(function (item) { item.rows.forEach(function (row) {
          if (named[row.provider]) return; named[row.provider] = true;
          var one = {key: 'native:' + row.provider, rows: [row], best: row, nativeOne: true}; byKey[one.key] = one; direct.push(one);
        }); });
        if (direct.length) direct.unshift({key: 'label:native', label: 'Выбор озвучки внутри источника'});
        items = (heroItem ? [heroItem] : []).concat(list, direct);
      }
      if (sourceMode()) {
        var others = items.filter(function (item) { return item.other; });
        items = items.filter(function (item) { return !item.other; });
        voicesShown = voicesOpen === null ? !items.length && !loading : voicesOpen;
        if (others.length) items = items.concat([{key: 'section:voices', section: true, rows: others}], voicesShown ? others : []);
      }
      visibleItems = items; models = byKey;
      // New rows the user can see: not those folded away.
      fresh = items.filter(function (item) { return freshKeys[item.key]; }).length;
      var real = function (item) { return !item.section && !item.label; };
      showPlaceholder(items.length ? '' : loading ? 'loading' : 'empty:' + q + ':' + kind + ':' + subsOnly, loading);
      var wanted = {}, page = items.slice(0, shown), keys = [];
      search.probe(page.filter(real).map(function (item) { return item.best; }));
      var heroKey = heroItem && page[0] === heroItem ? heroItem.key : '';
      page.forEach(function (item) {
        wanted[item.key] = true; keys.push(item.key);
        if (item.label) { (tiles[item.key] || (tiles[item.key] = $('<div class="homelab-common-label"></div>'))).text(item.label); return; }
        if (item.key === 'section:voices') { voicesSection(item.rows.length, voicesShown); return; }
        if (item.key === 'section:unchecked') { uncheckedSection(item.rows.length, uncheckedShown); return; }
        if (item.section) { section(torrents.length, sectionOpen); return; }
        var tile = tiles[item.key] || (tiles[item.key] = card(item.key));
        fill(tile, view(item, item.key === heroKey));
        matchLabel(tile, item.best);
      });
      Object.keys(tiles).forEach(function (key) { if (!wanted[key]) { tiles[key].remove(); delete tiles[key]; } });
      heroBox.toggleClass('hide', !heroKey);
      // Re-append only when the sequence changed: moving a focused node replays Lampa's focus animation.
      var seq = heroKey + '#' + keys.join('\n'), moved = seq !== sequence;
      if (moved) { sequence = seq; sequenceKeys = keys; keys.forEach(function (key) { (key === heroKey ? heroBox : body).append(tiles[key]); }); }
      var heirChanged = false;
      if (focusedKey && !tiles[focusedKey]) {
        // The row now in its place, never a heading.
        var at = Math.max(0, Math.min(focusedIndex, page.length - 1)), heir = null;
        for (var i = at; i < page.length && !heir; i++) if (real(page[i]) || page[i].section) heir = page[i];
        for (var j = at - 1; j >= 0 && !heir; j--) if (real(page[j]) || page[j].section) heir = page[j];
        last = heir && tiles[heir.key] ? tiles[heir.key][0] : null; heirChanged = true;
      }
      if (items.length > shown) {
        if (!more) more = button('', 'homelab-common-more', function () {
          var first = visibleItems[shown]; shown += 20; draw();
          if (first && tiles[first.key] && ownList()) L.Controller.collectionFocus(tiles[first.key][0], root, true);
        });
        more.text('Показать ещё · ' + (items.length - shown));
        if (moved || !body[0].contains(more[0]) || body.children().last()[0] !== more[0]) { body.append(more); moved = true; }
      } else if (more) { more.remove(); more = null; moved = true; }
      drawStatus(loading, items.filter(real), available, exact);
      drawChips();
      hint.toggleClass('hide', !items.length).text(recovery ? keysText(null) : grouped ? 'ОК — смотреть  ·  удержание ОК — все источники  ·  → параметры' : 'ОК — смотреть  ·  удержание ОК — подробности  ·  → параметры');
      var firstCard = keys.filter(function (key) { return key.indexOf('section:') !== 0 && key.indexOf('label:') !== 0; })[0], top = firstCard && tiles[firstCard] ? tiles[firstCard][0] : null;
      if (ownList()) {
        var before = last;
        if (untouched && top) last = top;
        if (moved || heirChanged || last !== before || !last) focus(true);
      }
      // The panel follows the focused card, or the top card while focus is elsewhere.
      var shownKey = '';
      Object.keys(tiles).forEach(function (key) { if (tiles[key][0] === last) shownKey = key; });
      if (!shownKey && firstCard && !models[detailKey]) shownKey = firstCard;
      if (!shownKey && models[detailKey]) shownKey = detailKey;
      if (shownKey) showDetail(shownKey);
      else if (!items.length) { detail.addClass('hide'); detailSig = ''; detailKey = ''; }
    }
    function isChecked(item) { return !item.best.unavailable && (!!item.best.measured || item.best.verified === 'play'); }
    // Chip counts ignore the kind filter: they say what each choice would show.
    function drawChips() {
      var rows = search.rows.filter(function (row) { return (!q || row.kind === 'online' && !row.qualities.length || row.qualities.indexOf(q) >= 0) && (!subsOnly || hasSubtitles(row)) && (!recovery || !row.native && row.kind === 'online' && row.provider !== recovery.excludeProvider); });
      var voices = {}, releases = 0;
      rows.forEach(function (row) { if (row.kind === 'torrent') releases++; else if (!row.native) voices[row.canon && row.canon.key || row.identityVoice] = true; });
      chipText('all', 'Всё'); chipText('online', 'Онлайн', Object.keys(voices).length); chipText('torrent', 'Торренты', releases);
      chipText('uhd', '4K'); chipText('subs', 'Субтитры');
    }
    function drawStatus(loading, items, rows, exact) {
      var voices = rows.filter(function (row) { return row.kind === 'online' && !row.native; }), releases = rows.filter(function (row) { return row.kind === 'torrent'; }).length;
      var top = rows.reduce(function (max, row) { return Math.max(max, row.unavailable ? 0 : row.qualities[0] || 0); }, 0), counted = {};
      voices.forEach(function (row) { counted[row.canon && row.canon.key || row.identityVoice] = true; });
      var summaryLine = [Object.keys(counted).length ? plural(Object.keys(counted).length, ['озвучка', 'озвучки', 'озвучек']) : '', top ? 'до ' + qualityLabel(top) : '', releases ? plural(releases, ['раздача', 'раздачи', 'раздач']) : ''].filter(Boolean).join(' · ');
      var found = grouped ? summaryLine || plural(items.length, VARIANTS) : plural(rows.length, VARIANTS), parts = [], providers = search.providers || {total: 0, done: 0};
      if (loading) {
        parts.push(search.onlinePending && providers.total ? 'Ищу: ' + providers.done + ' из ' + plural(providers.total, ['источника', 'источников', 'источников']) : 'Ищем варианты…');
        if (search.onlinePending && !providers.total) parts.push('опрашиваем онлайн-источники');
        if (search.torrentPending) parts.push('торренты ищутся');
        if (rows.length) parts.push('найдено ' + found);
      } else {
        parts.push(rows.length ? 'Найдено: ' + found : 'Ничего не найдено');
        if (search.checking()) parts.push('проверяем качество');
        if (search.interrupted) parts.push('Поиск прерван: → и «Обновить поиск»');
        if (search.cachedAt) { var minutes = Math.floor((Date.now() - search.cachedAt) / 60000); parts.push(minutes ? 'обновлено ' + minutes + ' мин назад' : 'обновлено только что'); }
        if (fresh) parts.push('ниже ещё ' + plural(fresh, ['новый', 'новых', 'новых']));
        if (recovery && recovery.voice && !exact && rows.length) parts.push('Точного совпадения нет; показаны похожие озвучки');
      }
      statusText.text(parts.concat(search.errors).join(' · '));
      status.toggleClass('is-loading', loading).toggleClass('has-errors', !!search.errors.length || !!search.interrupted && !loading);
      // Online answers drive the bar; the last stretch waits for torrents.
      var share = search.onlinePending ? (providers.total ? providers.done / providers.total : 0) * 0.85 + 0.05 : 0.92;
      barFill.css('transform', 'scaleX(' + share.toFixed(3) + ')').css('-webkit-transform', 'scaleX(' + share.toFixed(3) + ')');
    }
    function changed() { if (!refresh) refresh = setTimeout(function () { refresh = null; draw(); }, 150); }
    function cancel() { uiIntent++; clearTimeout(refresh); refresh = null; clearTimeout(rerank); rerank = null; if (search) search.cancel(); }
    function restart(fresh) {
      // OK on the strip keeps focus there until the new results bring the hero.
      var keep = last && strip[0].contains(last) ? last.homelabEpisode : 0;
      cancel(); currentScope = sync.scope(); resetList();
      body.empty(); heroBox.empty().addClass('hide'); more = null; placeholder = null; placeholderState = ''; detail.addClass('hide'); updateSummary(); stripCenter = 0; drawStrip(keep);
      var options = {torrents: !recovery, fresh: fresh === true}, warmed = fresh === true ? null : adoptWarm(searchKey(movie, selection, options.torrents));
      if (warmed) { search = warmed; search.follow(changed); }
      else { search = new Search(Object.assign({}, movie), selection, changed, options); search.start(); }
      draw();
    }
    function visibleNode(node) { return node.offsetParent !== null; }
    // The hero and the list are one column: Up/Down walk it in order.
    function listNodes() { return Array.prototype.filter.call(heroBox[0].querySelectorAll('.selector'), visibleNode).concat(Array.prototype.filter.call(body[0].querySelectorAll('.selector'), visibleNode)); }
    function inList(node) { return heroBox[0].contains(node) || body[0].contains(node); }
    function move(dx, dy) {
      touch();
      var all = Array.prototype.filter.call(root[0].querySelectorAll('.selector'), visibleNode), list = listNodes();
      var from = last && root[0].contains(last) && visibleNode(last) ? last : all[0]; if (!from) return;
      var index = list.indexOf(from);
      // Inside the single-column list, Up/Down follow list order (the tile's focus handler scrolls it into view).
      if (index >= 0 && dy && list[index + dy]) return L.Controller.collectionFocus(list[index + dy], root, true);
      if (index >= 0 && dy > 0) return;
      if (index >= 0 && dx < 0) return L.Controller.toggle('menu');
      var view = scroll.render(true).getBoundingClientRect();
      var a = from.getBoundingClientRect(), x = a.left + a.width / 2, y = a.top + a.height / 2, best, distance = Infinity;
      all.forEach(function (node) {
        if (node === from) return; var b = node.getBoundingClientRect(), px = b.left + b.width / 2, py = b.top + b.height / 2;
        // List entries are reachable from outside only while visible; scrolled-out tiles may sit behind the header.
        if (list.indexOf(node) >= 0 && (index >= 0 || body[0].contains(node) && !(py >= view.top && py <= view.bottom))) return;
        if (dx && (px - x) * dx <= 1 || dy && (py - y) * dy <= 1) return;
        // Left and Right stay in their row (the episode strip, the chips).
        if (dx && Math.abs(py - y) > Math.max(a.height, b.height) / 2) return;
        // Up/Down take the nearest row first (the chips before the strip), then the closest node in it.
        var along = dx ? Math.abs(px - x) : Math.abs(py - y), across = dx ? Math.abs(py - y) : Math.abs(px - x), score = dx ? along + across * 4 : along * 10 + across;
        if (score < distance) { distance = score; best = node; }
      });
      if (best) { L.Controller.collectionFocus(best, root, true); return true; }
      if (dy < 0) L.Controller.toggle('head');
      else if (dx < 0) L.Controller.toggle('menu');
      return false;
    }
    this.create = function () { scroll.minus(root.find('.homelab-common-head')); updateSummary(); };
    this.render = function (js) { return js ? root[0] : root; };
    this.start = function () {
      if (!active()) return;
      if (sync.scope() !== currentScope) { cancel(); return L.Activity.backward(); }
      if (settingsOpen) { settingsOpen = false; pending = null; panel.addClass('hide'); root.removeClass('is-settings'); }
      L.Controller.add('content', {link: self, invisible: true, toggle: function () { focus(false); }, up: function () { move(0, -1); }, down: function () { move(0, 1); }, left: function () { move(-1, 0); },
        // → walks the strip and the chips; past their end, and from anywhere else, it opens the parameters.
        right: function () { if (!(last && last !== summary[0] && (strip[0].contains(last) || filters[0].contains(last)) && move(1, 0))) openSettings(); }, back: function () { cancel(); L.Activity.backward(); }});
      L.Controller.add(SETTINGS, {link: self, invisible: true, toggle: focusSetting, up: function () { if (settingIndex > 0) { settingIndex--; focusSetting(); } },
        down: function () { if (settingIndex < settingRows.length - 1) { settingIndex++; focusSetting(); } }, left: function () { stepSetting(-1, true); }, right: function () { stepSetting(1); }, back: function () { closeSettings(); }});
      L.Controller.toggle('content');
      if (!started) { started = true; askSeasons(); restart(); }
      else draw();
    };
    this.pause = cancel;
    this.stop = function () {};
    var unsubscribe = sync.subscribe(function () { if (sync.scope() !== currentScope) { cancel(); if (active()) L.Activity.backward(); } });
    this.destroy = function () { dead = true; clearTimeout(voiceTimer); clearTimeout(stripTimer); cancel(); unsubscribe(); scroll.destroy(); root.remove(); };
  }
