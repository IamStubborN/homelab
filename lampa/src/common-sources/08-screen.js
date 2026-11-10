  // ── The «Общий» screen ──
  function Common(object) {
    var self = this, movie = movieCard(object.movie), tv = !!movie.name, saved = window.homelabContinue && window.homelabContinue.list().find(function (item) { return item.card === (tv ? 'tv_' : 'movie_') + movie.id; });
    var recovery = object.homelab_recovery, pref = preferences();
    if (recovery && recovery.scope !== sync.scope()) recovery = null;
    var season = Number.isInteger(object.season) && object.season >= 0 ? object.season : saved && Number.isInteger(saved.season) && saved.season >= 0 ? saved.season : 1;
    var selection = recovery ? {season: recovery.season, episode: recovery.episode} : {season: season, episode: saved && saved.season === season && saved.episode || 1};
    var root = $('<div class="homelab-common"></div>'), head = $('<div class="homelab-common-head"></div>'), controls = $('<div class="homelab-common-controls"></div>'), tabs = $('<div class="homelab-common-tabs"></div>');
    var status = $('<div class="homelab-common-status" aria-live="polite"></div>'), statusText = $('<div class="homelab-common-status-text"></div>'), bar = $('<div class="homelab-common-bar"></div>'), barFill = $('<div class="homelab-common-bar-fill"></div>');
    var body = $('<div class="homelab-common-list"></div>'), scroll = new L.Scroll({mask: true, over: true}), hint = $('<div class="homelab-common-hint hide"></div>');
    var search, last = null, kind = recovery ? 'online' : 'all', q = recovery ? 0 : pref.quality, tiles = {}, models = {}, shown = 20, visibleItems = [], order = [], locked = false, restoringFocus = false, more = null, torrentsOpen = null, toggled = false, rerank = null, fresh = 0, sequence = '', reorderAt = 0, dead = false, voiceTimer = 0, started = false, refresh, uiIntent = 0, currentScope = sync.scope();
    // Grouped by voice by default; recovery lists every provider, since the point there is to pick another one.
    // untouched: until the first key press, focus follows the top (recommended) card so one OK plays it.
    var grouped = !recovery, untouched = true, placeholder = null, placeholderState = '';
    var title = $('<div class="homelab-common-heading"></div>').text('Общий'), label = $('<div class="homelab-common-movie"></div>').text(movie.title || movie.name || '');
    status.append($('<div class="homelab-common-spinner"></div>')).append(statusText).append(bar.append(barFill));
    head.append(title).append(label); root.append(head).append(controls).append(tabs).append(status);
    var otherButton = button('', 'homelab-common-chip homelab-common-other-voices hide', otherVoices); root.append(otherButton);
    body.appendTo(scroll.body()); root.append(scroll.render()); root.append(hint);
    var recoveryLabel = recovery ? $('<div class="homelab-common-recovery"></div>') : null;
    function recoveryText() { if (recoveryLabel) recoveryLabel.text('Продолжить с ' + L.Utils.secondsToTime(recovery.position) + (recovery.voice ? ' · ' + recovery.voice : ' · Выберите озвучку') + '. Тайминги разных версий могут отличаться'); }
    if (recoveryLabel) { head.after(recoveryLabel); recoveryText(); }
    function active() { return !dead && L.Activity.active() === object; }
    function focus(background) { restoringFocus = !!background; L.Controller.collectionSet(root, false, true); L.Controller.collectionFocus(last && root[0].contains(last) ? last : false, root, true); restoringFocus = false; }
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
      locked = false; order = []; shown = 20; last = null; fresh = 0; sequence = ''; scroll.reset();
    }
    // Torrents fold into one row under the online voices; with no online voice they open by themselves.
    function section(count, open) {
      var tile = tiles['section:torrents'];
      if (!tile) tile = tiles['section:torrents'] = button('', 'homelab-common-section', function () {
        torrentsOpen = !sectionOpen; toggled = true; locked = true; draw();
      });
      tile.text((open ? '▾ Торренты · ' : '▸ Торренты · ') + plural(count, ['раздача', 'раздачи', 'раздач']) + (open ? '' : ' — показать'));
      return tile;
    }
    var sectionOpen = false;
    function otherVoices() {
      if (!recovery || !active() || sync.scope() !== currentScope) return;
      recovery.voice = ''; recoveryText(); locked = false; order = []; shown = 20; last = null; scroll.reset(); selectors(); draw();
      if (L.Controller.own(self)) focus(true);
    }
    function matchLabel(tile, row) {
      tile.find('.homelab-common-match').toggleClass('hide', !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) !== 1);
    }
    function selectors() {
      controls.empty();
      if (tv && recovery) {
        controls.append($('<div class="homelab-common-chip homelab-common-static"></div>').text('Сезон ' + selection.season + ' · Серия ' + selection.episode));
      } else if (tv) {
        controls.append(button(selection.season === 0 ? 'Спецвыпуски' : 'Сезон ' + selection.season, 'homelab-common-chip', function () {
          var token = ++uiIntent;
          function complete(data) {
            if (!active() || token !== uiIntent || !L.Controller.own(self) || sync.scope() !== currentScope) return;
            var seasons = data && Array.isArray(data.seasons) ? data.seasons : [];
            var values = seasons.filter(function (entry) { return Number.isInteger(entry.season_number) && entry.season_number >= 0 && entry.season_number <= 999; }).map(function (entry) {
              return {title: entry.name || (entry.season_number === 0 ? 'Спецвыпуски' : 'Сезон ' + entry.season_number), value: entry.season_number, selected: entry.season_number === selection.season};
            });
            if (!values.length) return L.Noty.show('Не удалось получить список сезонов');
            movie.seasons = seasons;
            choose('Сезон', values, function (value) { selection.season = value.value; selection.episode = 1; restart(); });
          }
          if (Array.isArray(movie.seasons) && movie.seasons.length) return complete(movie);
          L.Api.sources.tmdb.get('tv/' + movie.id, {}, function (data) { complete(data && +data.id === movie.id ? data : null); }, function () { complete(null); });
        }));
        controls.append(button('Серия ' + selection.episode, 'homelab-common-chip', function () {
          var season = selection.season, token = ++uiIntent;
          L.Api.sources.tmdb.get('tv/' + movie.id + '/season/' + season, {}, function (data) {
            if (!active() || token !== uiIntent || season !== selection.season || !L.Controller.own(self) || sync.scope() !== currentScope) return;
            choose('Серия', (data.episodes || []).map(function (episode) { return {title: episode.episode_number + ' · ' + episode.name, value: episode.episode_number, selected: episode.episode_number === selection.episode}; }), function (value) { selection.episode = value.value; restart(); });
          }, function () { if (active()) L.Noty.show('Не удалось получить список серий'); });
        }));
      }
      [['all', 'Все'], ['online', 'Онлайн'], ['torrent', 'Торренты']].forEach(function (value) {
        if (recovery && value[0] === 'torrent') return;
        controls.append(button(value[1], 'homelab-common-chip homelab-common-kind' + (kind === value[0] ? ' selected' : ''), function () {
          kind = value[0]; shown = 20; locked = false; order = []; scroll.reset(); controls.find('.homelab-common-kind.selected').removeClass('selected'); $(this).addClass('selected'); draw();
        }));
      });
      controls.append(button(grouped ? 'По озвучкам' : 'Все источники', 'homelab-common-chip homelab-common-view', function () {
        grouped = !grouped; $(this).text(grouped ? 'По озвучкам' : 'Все источники'); resetList(); last = this; draw();
      }));
      if (recovery && recovery.voice) controls.append(button('Озвучка: ' + recovery.voice, 'homelab-common-chip', function () {
        choose('Озвучка для другого источника', [{title: 'Сохранить ту же озвучку', keep: true}, {title: 'Выбрать другую вручную'}], function (value) {
          if (!value.keep) otherVoices();
        });
      }));
      controls.append(button('Обновить', 'homelab-common-refresh', function () { restart(true); }));
    }
    function directIdentity(row) {
      return /^[a-z0-9_.-]{1,80}$/i.test(row.provider) && typeof row.identityVoice === 'string' && row.identityVoice.length <= 200 && Number.isInteger(row.seasonIndex) && row.seasonIndex >= 0 && row.seasonIndex <= 999;
    }
    function openNative(row) {
      L.Activity.push({component: 'lampac', movie: movie, title: 'Онлайн', search: movie.title || movie.name, search_one: movie.title || movie.name, search_two: movie.original_title || movie.original_name, page: 1, lampac_custom_select: row.provider});
    }
    function open(row) {
      if (!active() || sync.scope() !== currentScope) return;
      if (recovery && (row.native || row.kind !== 'online' || row.provider === recovery.excludeProvider || recovery.voice && !voiceMatch(recovery.voice, row.identityVoice))) return;
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
    // What a card shows; the signature lets draw() skip unchanged cards instead of rebuilding them.
    function view(item, hero) {
      var row = item.best, count = item.rows.length, best = row.qualities[0] || 0;
      if (item.key === 'native') {
        var names = item.rows.map(function (entry) { return entry.providerName; }).filter(function (name, index, all) { return all.indexOf(name) === index; });
        var nativeModel = {voice: 'Открыть в источниках', details: plural(names.length, SOURCES) + ': ' + names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '') + ' · выбор внутри источника',
          badges: [], cls: 'is-native', icon: NATIVE, note: '', quality: '', qcls: 'is-none', pick: ''};
        nativeModel.sig = [nativeModel.voice, nativeModel.details].join('|');
        return nativeModel;
      }
      var voice = !grouped ? row.voice : row.kind === 'torrent' ? (row.canon && row.canon.label || row.voice) : row.canon && row.canon.label || row.identityVoice || row.voice;
      if (voice === UNNAMED) voice = UNNAMED + ' · ' + row.providerName;
      var subs = item.rows.some(function (entry) { return entry.canon && entry.canon.subs; }), langs = subtitleLanguagesOf(item.rows);
      var model = {voice: voice, badges: [], cls: row.kind === 'torrent' ? 'is-torrent' : 'is-online', icon: row.kind === 'torrent' ? MAGNET : PLAY, note: ''};
      model.details = row.providerName + ' · ' + (count > 1 ? 'ещё ' + plural(count - 1, row.kind === 'torrent' ? ['раздача', 'раздачи', 'раздач'] : SOURCES) : row.kind === 'torrent' ? 'Торрент' : 'Онлайн');
      // Subtitle tracks (an online file, a release's streams or title), or a subtitled voice.
      if (langs !== null || subs) model.badges.push(['субтитры' + (langs ? ' ' + langs : ''), 'is-subs']);
      if (row.release) {
        var described = row.described || (row.described = describeRelease(row.release)), size = Number(row.release.Size || row.release.size), seeds = Number(row.release.Seeders);
        if (Number.isFinite(seeds)) model.badges.push([plural(seeds, ['сид', 'сида', 'сидов']), seeds >= MIN_SEEDS ? 'is-seeds' : 'is-dead']);
        if (size > 0) model.badges.push([(size / 1073741824).toFixed(1).replace('.', ',') + ' ГБ', '']);
        if (described.codec) model.badges.push([described.codec, '']);
        if (described.languages) model.badges.push([described.languages, '']);
        if (described.voices.length > 1) model.details += ' · ' + described.voices.slice(1, 3).join(', ');
        if (tv) model.details += ' · Выбор серии в раздаче';
        if (row.voiceProbe === 'pending') model.details += ' · узнаю озвучку…';
      } else if (row.unavailable) model.details += ' · Не отдаёт видео';
      else if (!best) model.details += row.native ? ' · Качество неизвестно · Открыть источник' : ' · Качество уточняется';
      if (row.unavailable) { model.quality = 'нет видео'; model.qcls = 'is-off'; model.cls += ' is-unavailable'; }
      else if (best) { model.quality = qualityLabel(best); model.qcls = best >= 2160 ? 'is-uhd' : best >= 1080 ? 'is-hd' : 'is-sd'; }
      else { model.quality = '—'; model.qcls = 'is-none'; }
      if (!row.unavailable && best && row.kind === 'online') {
        model.note = row.verified === 'play' ? 'по просмотру' : row.measured ? 'проверено' : row.doubtful ? 'заявлено, не проверено' : 'заявлено';
        // The source said more than its stream has.
        if (row.measured && row.claimed > best) model.note += ' · заявлено ' + qualityLabel(row.claimed);
      }
      model.measured = !!row.measured;
      model.pick = hero ? 'Рекомендуем' + (row.measured ? ' · проверено' : '') : '';
      if (hero) model.cls += ' is-hero';
      model.sig = [model.voice, model.details, model.quality, model.qcls, model.note, model.measured, model.pick, model.cls, model.badges.join(',')].join('|');
      return model;
    }
    function fill(tile, model) {
      if (tile.data('sig') === model.sig) return;
      tile.data('sig', model.sig);
      // Swap only the modifier classes so Lampa's own focus class survives.
      tile.removeClass(tile.data('cls') || '').addClass(model.cls).data('cls', model.cls);
      tile.find('.homelab-common-play').html(model.icon);
      tile.find('.homelab-common-pick').text(model.pick).toggleClass('hide', !model.pick);
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
      text.append($('<div class="homelab-common-pick hide"></div>')).append($('<div class="homelab-common-voice"></div>'))
        .append($('<div class="homelab-common-match hide"></div>').text('Та же студия · название отличается, проверьте версию'))
        .append($('<div class="homelab-common-details"></div>')).append($('<div class="homelab-common-badges hide"></div>'));
      side.append($('<div class="homelab-common-q"></div>')).append($('<div class="homelab-common-q-note hide"></div>'));
      tile.append($('<div class="homelab-common-play"></div>')).append(text).append(side);
      tile.on('hover:focus', function () {
        last = this; if (!restoringFocus) { locked = true; scroll.update(this, true); }
        // Dwelling on a torrent without a named voice asks its audio tracks.
        var focused = this; clearTimeout(voiceTimer);
        voiceTimer = setTimeout(function () { if (!dead && last === focused && search && models[key] && models[key].best && search.voices) search.voices(models[key].best); }, 1200);
      })
        .on('hover:hover hover:touch', function () { locked = true; touch(); })
        .on('hover:enter', function () { touch(); if (!models[key]) return; if (key === 'native') sourceMenu(models[key]); else open(models[key].best); })
        .on('hover:long', function () { touch(); if (models[key]) sourceMenu(models[key]); });
      return tile;
    }
    function rowSubtitles(row) {
      if (row.subtitles !== undefined) return row.subtitles;
      if (row.release && !row.described) row.described = describeRelease(row.release);
      return row.described && row.described.subtitles || null;
    }
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
    function rowLine(row) {
      if (row.unavailable) return 'Не отдаёт видео';
      if (row.native) return 'Открыть в источнике';
      var note = subtitleNote(row), subtitles = note ? ' · ' + note : '';
      if (!row.qualities.length) return 'Качество уточняется' + subtitles;
      return row.qualities.map(qualityLabel).join(' / ') + (row.kind === 'online' ? (row.verified === 'play' ? ' · по просмотру' : row.measured ? ' · проверено' : ' · заявлено') + (row.measured && row.claimed > (row.qualities[0] || 0) ? ' (заявлено ' + qualityLabel(row.claimed) + ')' : '') : '') + subtitles;
    }
    // Right / long press: every source behind the card, or every release of a torrent group.
    function releaseLine(entry) {
      var size = Number(entry.release.Size || entry.release.size), seeds = Number(entry.release.Seeders);
      return [entry.qualities.length ? qualityLabel(entry.qualities[0]) : '', Number.isFinite(seeds) ? plural(seeds, ['сид', 'сида', 'сидов']) : '', size > 0 ? (size / 1073741824).toFixed(1).replace('.', ',') + ' ГБ' : '', subtitleNote(entry), entry.providerName].filter(Boolean).join(' · ');
    }
    function sourceMenu(item) {
      var row = item.best, items = [];
      if (search) search.probe(item.rows, true);
      if (item.key === 'native') item.rows.forEach(function (entry) { items.push({title: entry.providerName, subtitle: entry.voice, open: entry}); });
      else if (row.release && item.rows.length > 1) item.rows.forEach(function (entry) { items.push({title: String(entry.release.Title).slice(0, 160), subtitle: releaseLine(entry) + (entry === row ? ' · лучшая' : ''), open: entry, selected: entry === row}); });
      else if (row.release) items.push({title: row.release.Title, subtitle: releaseLine(row), noenter: true}, {title: 'Смотреть', open: row});
      else item.rows.forEach(function (entry) {
        var extra = entry.voice.indexOf(entry.identityVoice) === 0 ? entry.voice.slice(entry.identityVoice.length).replace(/^\s*·\s*/, '') : '';
        items.push({title: entry.providerName + (extra ? ' · ' + extra : '') + (entry === row && item.rows.length > 1 ? ' · лучший' : ''), subtitle: rowLine(entry), open: entry, selected: entry === row});
      });
      var heading = item.key === 'native' ? 'Открыть в источнике' : row.release ? (item.rows.length > 1 ? plural(item.rows.length, ['раздача', 'раздачи', 'раздач']) : 'Раздача') : (item.rows.length > 1 ? plural(item.rows.length, SOURCES) + ' · ' : '') + (row.canon && row.canon.label || row.identityVoice);
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
        for (var i = 0; i < 3; i++) placeholder.append($('<div class="homelab-common-skeleton"></div>'));
      } else {
        placeholder = $('<div class="homelab-common-empty"></div>');
        placeholder.append($('<div class="homelab-common-empty-title"></div>').text(recovery ? 'Других подходящих источников нет' : 'Ничего не нашлось'));
        placeholder.append($('<div class="homelab-common-empty-hint"></div>').text(q ? 'В качестве ' + qualityLabel(q) + ' вариантов нет — выберите «Все качества»' : kind !== 'all' ? 'Попробуйте «Все» или нажмите «Обновить»' : 'Нажмите «Обновить», чтобы поискать заново'));
      }
      body.append(placeholder);
    }
    function draw() {
      if (dead || !search || sync.scope() !== currentScope) return;
      // Groups merge while results stream in; a focused row that disappears
      // hands focus to the row now in its place, never to the filters above.
      var focusedKey = '', focusedIndex = -1;
      Object.keys(tiles).forEach(function (key) { if (tiles[key][0] === last) focusedKey = key; });
      if (focusedKey) focusedIndex = sequence.split('\n').indexOf(focusedKey);
      var candidates = search.rows.filter(function (row) { return (kind === 'all' || row.kind === kind) && (!q || row.kind === 'online' && !row.qualities.length || row.qualities.indexOf(q) >= 0) && (!recovery || !row.native && row.kind === 'online' && row.provider !== recovery.excludeProvider); });
      var exact = recovery && recovery.voice ? candidates.filter(function (row) { return voiceMatch(recovery.voice, row.identityVoice) === 2; }).length : 0;
      function rank(a, b, tie) {
        var match = recovery && recovery.voice ? voiceMatch(recovery.voice, b.identityVoice) - voiceMatch(recovery.voice, a.identityVoice) : 0;
        return match || compareRows(a, b, tie);
      }
      var available = candidates.filter(function (row) { return !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) > 0; }).sort(function (a, b) { return rank(a, b); });
      var showOther = recovery && recovery.voice && candidates.length > 0 && (!exact || last === otherButton[0]);
      otherButton.text('Другие озвучки · ' + candidates.length).toggleClass('hide', !showOther);
      var groups = grouped ? groupRows(available).sort(function (a, b) {
        return rank(a.best, b.best, function () { return b.rows.length - a.rows.length || (b.best.measured ? 1 : 0) - (a.best.measured ? 1 : 0); });
      }) : available.map(function (row) { return {key: 'row:' + row.key, rows: [row], best: row}; });
      var byKey = {}; groups.forEach(function (item) { byKey[item.key] = item; });
      var loading = search.onlinePending || search.torrentPending, now = Date.now();
      // Untouched lists re-rank at most once a second while results stream in; once the user moved, rows keep their places.
      if (!locked && (!loading || !order.length || now - reorderAt >= 1000)) { order = groups.map(function (item) { return item.key; }); reorderAt = now; fresh = 0; }
      else {
        if (!locked) { clearTimeout(rerank); rerank = setTimeout(function () { rerank = null; draw(); }, reorderAt + 1000 - now); }
        order = order.filter(function (key) { return !!byKey[key]; });
        groups.forEach(function (item) { if (order.indexOf(item.key) < 0) { order.push(item.key); if (locked) fresh++; } });
      }
      var items = order.map(function (key) { return byKey[key]; }), torrents = [];
      if (grouped && kind === 'all') {
        torrents = items.filter(function (item) { return item.best.kind === 'torrent'; });
        var online = items.filter(function (item) { return item.best.kind !== 'torrent' && !item.best.native; }).length;
        sectionOpen = torrentsOpen === null ? !online : torrentsOpen;
        if (!online && !toggled) sectionOpen = true;
        if (locked && torrentsOpen === null) torrentsOpen = sectionOpen; // once the user moved, the section no longer folds by itself
        if (torrents.length && (online || toggled)) {
          var at = items.indexOf(torrents[0]), rest = items.filter(function (item) { return item.best.kind !== 'torrent'; });
          var before = rest.filter(function (item) { return items.indexOf(item) < at; });
          items = before.concat([{key: 'section:torrents', section: true, rows: torrents}], sectionOpen ? torrents : [], rest.slice(before.length));
        }
      }
      visibleItems = items; models = byKey;
      showPlaceholder(items.length ? '' : loading ? 'loading' : 'empty:' + q + ':' + kind, loading);
      var wanted = {}, page = items.slice(0, shown), keys = [];
      search.probe(page.filter(function (item) { return !item.section; }).map(function (item) { return item.best; }));
      var heroKey = page[0] && !page[0].section ? page[0].key : '';
      page.forEach(function (item) {
        wanted[item.key] = true; keys.push(item.key);
        if (item.section) { section(torrents.length, sectionOpen); return; }
        var tile = tiles[item.key] || (tiles[item.key] = card(item.key));
        fill(tile, view(item, item.key === heroKey && !item.best.native && !item.best.unavailable));
        matchLabel(tile, item.best);
      });
      Object.keys(tiles).forEach(function (key) { if (!wanted[key]) { tiles[key].remove(); delete tiles[key]; } });
      // Re-append only when the sequence changed: moving a focused node replays Lampa's focus animation.
      var seq = keys.join('\n'), moved = seq !== sequence;
      if (moved) { sequence = seq; keys.forEach(function (key) { body.append(tiles[key]); }); }
      var heirChanged = false;
      if (focusedKey && !tiles[focusedKey]) {
        var heir = page[Math.max(0, Math.min(focusedIndex, page.length - 1))];
        last = heir && tiles[heir.key] ? tiles[heir.key][0] : null; heirChanged = true;
      }
      if (items.length > shown) {
        if (!more) more = button('', 'homelab-common-more', function () {
          var first = visibleItems[shown]; shown += 20; draw();
          if (first && tiles[first.key] && L.Controller.own(self)) L.Controller.collectionFocus(tiles[first.key][0], root, true);
        });
        more.text('Показать ещё · ' + (items.length - shown));
        if (moved || !body[0].contains(more[0]) || body.children().last()[0] !== more[0]) { body.append(more); moved = true; }
      } else if (more) { more.remove(); more = null; moved = true; }
      drawStatus(loading, items.filter(function (item) { return !item.section; }), available, exact);
      hint.toggleClass('hide', !items.length).text(grouped ? 'ОК — смотреть лучший источник  ·  → или удержание — все источники' : 'ОК — смотреть  ·  → или удержание — подробности');
      if (L.Controller.own(self)) {
        var firstCard = keys.filter(function (key) { return key !== 'section:torrents'; })[0], top = firstCard && tiles[firstCard] ? tiles[firstCard][0] : null, before = last;
        if (untouched && top) last = top;
        if (moved || heirChanged || last !== before || !last) focus(true);
      }
    }
    function drawStatus(loading, items, rows, exact) {
      var voices = rows.filter(function (row) { return row.kind === 'online' && !row.native; }), releases = rows.filter(function (row) { return row.kind === 'torrent'; }).length;
      var top = rows.reduce(function (max, row) { return Math.max(max, row.unavailable ? 0 : row.qualities[0] || 0); }, 0), counted = {};
      voices.forEach(function (row) { counted[row.canon && row.canon.key || row.identityVoice] = true; });
      var summary = [Object.keys(counted).length ? plural(Object.keys(counted).length, ['озвучка', 'озвучки', 'озвучек']) : '', top ? 'до ' + qualityLabel(top) : '', releases ? plural(releases, ['раздача', 'раздачи', 'раздач']) : ''].filter(Boolean).join(' · ');
      var found = grouped ? summary || plural(items.length, VARIANTS) : plural(rows.length, VARIANTS), parts = [], providers = search.providers || {total: 0, done: 0};
      if (loading) {
        parts.push('Ищем варианты…');
        if (search.onlinePending) parts.push(providers.total ? 'онлайн: ответили ' + providers.done + ' из ' + providers.total : 'опрашиваем онлайн-источники');
        if (search.torrentPending) parts.push('торренты ищутся');
        if (rows.length) parts.push('найдено ' + found);
      } else {
        parts.push(rows.length ? 'Найдено: ' + found : 'Ничего не найдено');
        if (search.checking()) parts.push('проверяем качество');
        if (search.interrupted) parts.push('Поиск прерван, нажмите «Обновить»');
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
      cancel(); currentScope = sync.scope(); resetList();
      body.empty(); more = null; placeholder = null; placeholderState = ''; selectors();
      search = new Search(Object.assign({}, movie), selection, changed, {torrents: !recovery, fresh: fresh === true}); search.start(); draw();
    }
    function visibleNode(node) { return node.offsetParent !== null; }
    function move(dx, dy) {
      touch();
      var all = Array.prototype.filter.call(root[0].querySelectorAll('.selector'), visibleNode), list = Array.prototype.filter.call(body[0].querySelectorAll('.selector'), visibleNode);
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
        if (list.indexOf(node) >= 0 && (index >= 0 || !(py >= view.top && py <= view.bottom))) return;
        if (dx && (px - x) * dx <= 1 || dy && (py - y) * dy <= 1) return;
        var along = dx ? Math.abs(px - x) : Math.abs(py - y), across = dx ? Math.abs(py - y) : Math.abs(px - x), score = along + across * 4;
        if (score < distance) { distance = score; best = node; }
      });
      if (best) L.Controller.collectionFocus(best, root, true);
      else if (dy < 0) L.Controller.toggle('head');
      else if (dx < 0) L.Controller.toggle('menu');
    }
    this.create = function () {
      scroll.minus(root.find('.homelab-common-head')); selectors();
      [0, 2160, 1080, 720].forEach(function (value) { tabs.append(button(value ? qualityLabel(value) : 'Все качества', 'homelab-common-tab' + (value === q ? ' selected' : ''), function () {
        q = value; pref = preferences({quality: value}); shown = 20; locked = false; order = []; scroll.reset(); tabs.find('.selected').removeClass('selected'); $(this).addClass('selected'); draw();
      })); });
    };
    this.render = function (js) { return js ? root[0] : root; };
    this.start = function () {
      if (!active()) return;
      if (sync.scope() !== currentScope) { cancel(); return L.Activity.backward(); }
      L.Controller.add('content', {link: self, invisible: true, toggle: function () { focus(false); }, up: function () { move(0, -1); }, down: function () { move(0, 1); }, left: function () { move(-1, 0); },
        right: function () { touch(); if (last && last.classList.contains('homelab-common-result')) $(last).trigger('hover:long'); else if (!(last && body[0].contains(last))) move(1, 0); }, back: function () { cancel(); L.Activity.backward(); }});
      L.Controller.toggle('content');
      if (!started) { started = true; restart(); }
      else draw();
    };
    this.pause = cancel;
    this.stop = function () {};
    var unsubscribe = sync.subscribe(function () { if (sync.scope() !== currentScope) { cancel(); if (active()) L.Activity.backward(); } });
    this.destroy = function () { dead = true; clearTimeout(voiceTimer); cancel(); unsubscribe(); scroll.destroy(); root.remove(); };
  }
