  // ── Opening a card: the captured source, the picker or the torrent files ──
  function card(item) {
    var tv = item.card.indexOf('tv_') === 0, result = {id: +item.card.split('_')[1], source: 'tmdb', poster_path: item.poster, backdrop_path: item.backdrop};
    result.title = plain(item.title || (tv ? 'Сериал #' : 'Фильм #') + result.id);
    if (tv) result.name = result.title;
    result.original_title = String(item.original || result[tv ? 'name' : 'title']);
    if (item.date) result[tv ? 'first_air_date' : 'release_date'] = item.date;
    if (tv) { result.original_name = result.original_title; result.number_of_seasons = Math.max(1, item.season || 0); }
    return result;
  }
  function fullCard(item, data) {
    var tv = item.card.indexOf('tv_') === 0;
    if (!data || +data.id !== +item.card.split('_')[1] || !!(data.name || data.original_name || data.number_of_seasons) !== tv) return null;
    var original = data.original_title || (tv ? data.original_name : null);
    if (typeof original !== 'string' || !original || (tv && !(data.number_of_seasons > 0))) return null;
    var value = Object.assign({}, card(item), data);
    // Native torrent hashes depend on the canonical title, including punctuation.
    value.original_title = original;
    if (tv) { value.original_name = data.original_name || original; value.title = value.name; }
    var ids = data.external_ids || {};
    ['imdb_id', 'kinopoisk_id', 'tmdb_id'].forEach(function (key) { if (!value[key] && ids[key]) value[key] = ids[key]; });
    delete value.params;
    return value;
  }
  function releasePlaylist(item, data, value) {
    var files = (data.file_stats || []).filter(function (file) { return file && Number.isInteger(file.id) && file.id > 0 && typeof file.path === 'string'; });
    var videos = files.filter(function (file) { return /\.(asf|wmv|divx|avi|mp4|m4v|mov|3gp|3g2|mkv|trp|tp|mts|mpg|mpeg|dat|vob|rm|rmvb|m2ts|ts|webm)$/i.test(file.path); }).map(function (file) { return Object.assign({}, file); });
    videos.sort(function (a, b) {
      function key(path) { return path.replace(/\d+/g, function (n) { return n.length > 12 ? n : ('000000000000' + n).slice(-12); }); }
      return key(a.path).localeCompare(key(b.path));
    });
    L.Torserver.clearFileName(videos);
    return videos.filter(function (file) {
      if (file.id === item.index) return true;
      var parts = file.path.split('/'), name = parts.pop();
      return !parts.some(function (folder) { return /^(samples?|trailers?|трейлеры?|пробник)$/i.test(folder); })
        && !/(?:^|[. _-])(sample|trailer|трейлер|пробник)\.[^.]+$/i.test(name);
    }).map(function (file) {
      var selected = !item.advance && file.id === item.index;
      var info = L.Torserver.parse({movie: value, files: videos, filename: file.path_human, path: file.path, is_file: /\.(vob|m2ts)$/i.test(file.path)});
      var season = selected ? item.season : info.season, episode = selected ? item.episode : info.episode;
      var road = L.Timeline.view(selected ? item.timeline : info.hash,
        selected || info.by_title && (!info.serial || info.episode) ? L.Timeline.link(value, season, episode) : null);
      var stem = file.path.split('/').pop().replace(/\.[^.]+$/, ''), subtitleIndex = 0;
      var subtitles = files.filter(function (other) {
        return /\.(vtt|lrc|smi|ssa|ass|sub|srt|sbv|json)$/i.test(other.path) && other.path.split('/').pop().indexOf(stem) >= 0;
      }).map(function (other) {
        return {label: plain(other.path.split('/').slice(1, -1).join(' - ')), index: subtitleIndex++, url: L.Torserver.stream(other.path, item.torrent, other.id).replace('&preload', '&play')};
      });
      var work = {id: file.id, path: file.path, card: value, season: season, episode: episode,
        title: (episode ? 'Серия ' + episode + ' · ' : '') + plain(file.path_human), first_title: plain(item.title),
        torrent_hash: item.torrent, homelab_file_index: file.id, timeline: road,
        url: L.Torserver.stream(file.path, item.torrent, file.id), subtitles: subtitles.length ? subtitles : false, launch_player: 'inner'};
      if (selected) {
        road.percent = 0; road.time = 0;
        work.homelab_resume_at = item.position; work.homelab_track_preferences = item.tracks || {};
        if (item.duration > 0) work.homelab_resume_from_duration = item.duration;
      }
      return work;
    });
  }
  // options.choose opens the source picker for the exact episode and position
  // instead of the captured source.
  function resume(item, options) {
    cancelResume();
    var key = context();
    if (L.Player.opened()) return L.Noty.show('Сначала закройте текущий просмотр');
    var owner = L.Activity && typeof L.Activity.active === 'function' ? L.Activity.active() : null;
    function owned(intent) { return resumeIntent === intent && context() === key && !L.Player.opened() && (!L.Activity || typeof L.Activity.active !== 'function' || L.Activity.active() === owner); }
    function metadataFor(intent, done) {
      if (!L.Api.sources || !L.Api.sources.tmdb || typeof L.Api.sources.tmdb.get !== 'function') return done(null);
      L.Api.sources.tmdb.get(item.card.replace('_', '/') + '?append_to_response=external_ids,keywords', {}, function (movie) { done(fullCard(item, movie)); }, function () { done(null); });
    }
    // Without a usable captured source, offer the picker with the exact
    // episode and position instead of a bare card.
    function chooseSource(notice) {
      var intent = intentNew(), settled = false;
      function open(value) {
        if (settled || !owned(intent)) return;
        settled = true; cancelResume();
        if (notice) L.Noty.show(notice);
        var movie = value || card(item), picker = window.HomelabSources;
        delete movie.params;
        if (picker && typeof picker.resume === 'function' && picker.resume(item, movie)) return;
        L.Router.call('full', movie);
      }
      intent.timer = setTimeout(function () { open(null); }, 5000);
      metadataFor(intent, open);
    }
    function onlineFailed(reason) {
      L.Noty.show(reason === 'changed' ? 'Сохранённая озвучка не найдена. Выберите вариант в списке' :
        reason === 'ambiguous' ? 'Подходит несколько вариантов. Выберите нужный в списке' :
        reason === 'missing' ? 'Сохранённая серия не найдена. Выберите сезон и серию в списке' : 'Источник не ответил. Выберите вариант в списке');
    }
    if (options && options.choose) return chooseSource('');
    if (item.kind === 'online' && item.online) {
      var onlineIntent = intentNew(), settled = false;
      var unavailable = function (value) {
        if (!owned(onlineIntent)) return;
        cancelResume();
        var movie = value || card(item), picker = window.HomelabSources;
        if (picker && typeof picker.resume === 'function' && picker.resume(item, movie)) return;
        L.Router.call('full', movie);
      };
      var launchOnline = function (value) {
        if (settled || !owned(onlineIntent)) return;
        settled = true; clearTimeout(onlineIntent.timer); onlineIntent.launched = true;
        var adapter = window.HomelabOnlineResume, launched = false;
        // Once the native component is shown the user stays there: a failure
        // only explains what to choose instead of navigating away.
        try { launched = adapter && adapter.resume(item, value || card(item), function (reason) { if (resumeIntent === onlineIntent) cancelResume(); onlineFailed(reason); }, {focus: true}); } catch (_) {}
        if (L.Activity && typeof L.Activity.active === 'function') owner = L.Activity.active();
        if (!launched) unavailable(value);
      };
      if (!window.HomelabOnlineResume) { unavailable(); return; }
      onlineIntent.timer = setTimeout(function () { launchOnline(null); }, 5000);
      L.Api.sources.tmdb.get(item.card.replace('_', '/') + '?append_to_response=external_ids,keywords', {}, function (movie) { launchOnline(fullCard(item, movie)); }, function () { launchOnline(null); });
      return;
    }
    if (!item.torrent) return chooseSource(item.advance ? '' : 'Выберите источник для продолжения');
    var intent = intentNew();
    intent.timer = setTimeout(fail, 8000);
    function fail() { if (!owned(intent)) return; cancelResume(); chooseSource('Раздача недоступна. Выберите источник для продолжения'); }
    L.Torserver.files(item.torrent, function (data) {
      if (!owned(intent)) return;
      var file = (data.file_stats || []).find(function (entry) { return entry.id === item.index && typeof entry.path === 'string'; });
      if (!file) return fail();
      function launch(value) {
        if (!owned(intent)) return;
        cancelResume();
        if (L.Player.opened()) return L.Noty.show('Сначала закройте текущий просмотр');
        var playlist = [];
        try { if (value) playlist = releasePlaylist(item, data, value); } catch (_) {}
        if (item.advance) {
          var next = playlist.find(function (entry) { return entry.episode === item.episode && (!Number.isInteger(entry.season) || entry.season === item.season); });
          if (!next) return chooseSource('Следующая серия не найдена в раздаче. Выберите источник');
          return offer(playlist, next);
        }
        var work = playlist.find(function (entry) { return entry.id === item.index; });
        if (!work) {
          value = card(item);
          var road = L.Timeline.view(item.timeline, L.Timeline.link(value, item.season, item.episode));
          road.percent = 0; road.time = 0;
          work = {card: value, season: item.season, episode: item.episode, title: plain(file.path.split('/').pop()),
            torrent_hash: item.torrent, homelab_file_index: item.index, timeline: road,
            url: L.Torserver.stream(file.path, item.torrent, item.index), homelab_resume_at: item.position, homelab_resume_from_duration: item.duration > 0 ? item.duration : undefined,
            homelab_track_preferences: item.tracks || {}, launch_player: 'inner'};
          playlist = [work];
          L.Noty.show('Не удалось восстановить список серий. Доступна выбранная серия');
        }
        offer(playlist, work);
      }
      // The release's files with the saved one focused: the user starts it.
      function offer(playlist, chosen) {
        if (!L.Select || typeof L.Select.show !== 'function') { L.Player.play(chosen); L.Player.playlist(playlist); return; }
        var previous = L.Controller.enabled().name;
        L.Select.show({title: plain(item.title || 'Продолжить просмотр'), items: playlist.map(function (entry) {
          return {title: entry.title, subtitle: entry !== chosen ? '' : item.advance ? 'Следующая серия' : remaining(item.position, item.duration), selected: entry === chosen, entry: entry};
        }), onBack: function () { L.Controller.toggle(previous); }, onSelect: function (choice) {
          if (!choice || !choice.entry || context() !== key) { L.Select.close(); return L.Controller.toggle(previous); }
          if (L.Player.opened()) { L.Select.close(); L.Controller.toggle(previous); return L.Noty.show('Сначала закройте текущий просмотр'); }
          L.Player.play(choice.entry); L.Player.playlist(playlist);
        }});
      }
      var stored = data.data;
      try { if (typeof stored === 'string') stored = JSON.parse(stored); } catch (_) { stored = null; }
      var value = fullCard(item, stored && stored.movie);
      if (value) return launch(value);
      clearTimeout(intent.timer);
      intent.timer = setTimeout(function () { launch(null); }, 2000);
      metadataFor(intent, launch);
    }, fail);
  }
