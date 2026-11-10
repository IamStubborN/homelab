// Built by tools/build.cjs from src/homelab-sync/continue: edit the sources there and rebuild.
(function install() {
  'use strict';
  // Public methods exist before native storage, favorites and menu are initialized.
  if (!window.appready) {
    var listener = window.Lampa && window.Lampa.Listener;
    if (listener && typeof listener.follow === 'function') listener.follow('app', function (event) {
      if (event.type === 'ready') install();
    });
    return;
  }
  var L = window.Lampa, sync = window.HomelabSync;
  if (!L || !sync || !sync.url || window.homelabContinue) return;
  if (!L.Player || !L.Player.listener || !L.PlayerVideo || !L.PlayerVideo.listener || !L.Timeline || !L.Controller || !L.Api || !L.Utils || !L.Router || !L.Noty) return;
  if (![window.fetch, window.AbortController, L.ContentRows && L.ContentRows.add,
    L.Torserver && L.Torserver.files, L.Torserver && L.Torserver.stream,
    L.Torserver && L.Torserver.parse, L.Torserver && L.Torserver.clearFileName,
    L.Timeline.view, L.Timeline.link, L.Player.play, L.Player.playlist,
    L.PlayerVideo.video, L.Player.listener.follow, L.PlayerVideo.listener.follow,
    L.Scroll, L.Subscribe, L.Maker && L.Maker.make, L.Layer && L.Layer.visible, L.Controller.own, L.Controller.collectionSet, L.Controller.collectionFocus,
    L.Controller.add, L.Controller.toggle, L.Controller.enabled, L.Api.img, L.Router.call, L.Noty.show,
    L.Utils.secondsToTime, L.Player.opened, window.$,
    sync.scope, sync.pull, sync.rows, sync.extra, sync.subscribe].every(function (fn) { return typeof fn === 'function'; })) return;
  var items = [], scope = '', reading = null, readAt = -Infinity, listeners = [], playing = null, pending = {}, sending = null, restore = null, metadata = {}, resolving = {}, metadataQueue = [], metadataRunning = 0, resumeIntent = null, writeTimer = null, writeError = false, readError = false, external = null, loadedOnce = false;
  var CACHE = 'homelab_continue_cache', EPISODES = 'homelab_continue_episodes', DAY = 86400000, NEWER = 120000;
  // Titles, posters and season sizes from the last session, so the row
  // starts in its final look instead of repainting each tile as TMDB answers.
  var remembered = {}, lastKey = 0;
  // Any key, click or touch while a launch is still being prepared hands
  // control back to the user (the online component then owns its own input).
  function interrupted() {
    var intent = resumeIntent;
    if (intent && !intent.launched && Date.now() - intent.created >= 500) cancelResume();
  }
  if (L.Keypad && L.Keypad.listener && typeof L.Keypad.listener.follow === 'function') L.Keypad.listener.follow('keydown', function () { lastKey = Date.now(); interrupted(); });
  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') ['mousedown', 'touchstart'].forEach(function (name) { document.addEventListener(name, interrupted, true); });
  function intentNew() { return resumeIntent = {created: Date.now()}; }
  function cancelResume() { if (window.HomelabOnlineResume) window.HomelabOnlineResume.cancel(); if (resumeIntent) clearTimeout(resumeIntent.timer); resumeIntent = null; }
  function plain(value) { return String(value || '').replace(/[<>"'`]/g, ''); }
  function context() {
    var key = sync.scope();
    if (scope !== key) {
      scope = key; items = cached(key); remembered = cachedMetadata(key); metadata = {}; resolving = {}; metadataQueue = []; metadataRunning = 0; readAt = -Infinity; pending = {}; writeError = false; readError = false; loadedOnce = false; external = null;
      clearTimeout(writeTimer);
      if (reading) reading.abort.abort(); reading = null;
      if (sending) sending.abort.abort(); sending = null;
      cancelResume();
      publish();
    }
    return key;
  }
  function publish() { listeners.slice().forEach(function (fn) { fn(); }); }
  // The last server list is kept per scope so the main row renders at once.
  function cached(key) {
    var value = null;
    try { value = L.Storage.get(CACHE, null); } catch (_) {}
    return key && value && value.scope === key && Array.isArray(value.items) ? value.items.map(normal).filter(accepted) : [];
  }
  function cachedMetadata(key) {
    var value = null, result = {};
    try { value = L.Storage.get(CACHE, null); } catch (_) {}
    if (!key || !value || value.scope !== key || !value.metadata || typeof value.metadata !== 'object') return result;
    Object.keys(value.metadata).forEach(function (card) {
      var entry = value.metadata[card], clean = {};
      if (!/^(tv|movie)_\d+$/.test(card) || !entry || typeof entry !== 'object') return;
      if (typeof entry.title === 'string') clean.title = plain(entry.title).slice(0, 200);
      ['poster', 'backdrop'].forEach(function (name) { if (typeof entry[name] === 'string' && /^\/[\w.-]+$/.test(entry[name])) clean[name] = entry[name]; });
      if (entry.seasons && typeof entry.seasons === 'object') {
        clean.seasons = {};
        Object.keys(entry.seasons).forEach(function (n) { if (/^\d{1,3}$/.test(n) && Number.isInteger(entry.seasons[n])) clean.seasons[n] = entry.seasons[n]; });
      }
      var aired = entry.aired;
      if (aired && Number.isInteger(aired.season) && Number.isInteger(aired.episode) && /^\d{4}-\d{2}-\d{2}$/.test(aired.date || '')) clean.aired = {season: aired.season, episode: aired.episode, date: aired.date};
      result[card] = clean;
    });
    return result;
  }
  function persist() {
    var shown = items.slice(0, 50), kept = {};
    // Cards that only exist in Lampa's own history need their titles kept too.
    var cards = merged().filter(function (item) { return !item.deleted; }).sort(function (a, b) { return b.observed - a.observed; }).slice(0, 50);
    cards.forEach(function (item) { var value = Object.assign({}, remembered[item.card] || {}, metadata[item.card] || {}); if (Object.keys(value).length) kept[item.card] = value; });
    try { L.Storage.set(CACHE, {scope: scope, items: shown, metadata: kept}, true); } catch (_) {}
  }
  // Lampac omits default values such as a zero position.
  function normal(item) { return item && !item.deleted && item.position === undefined ? Object.assign({}, item, {position: 0}) : item; }
  function accepted(item) {
    if (!item || !/^(tv|movie)_\d+$/.test(item.card)) return false;
    return item.deleted === true ? Number.isFinite(item.observed) : Number.isFinite(item.position) && Number.isFinite(item.duration);
  }
  function load(done) {
    done = done || function () {};
    var key = context(), url = sync.url('/homelab-sync/resume');
    if (!url) return done();
    if (reading) { reading.callbacks.push(done); return; }
    if (Date.now() - readAt < 15000) return done();
    var job = reading = {abort: new AbortController(), callbacks: [done]}, timer = setTimeout(function () { job.abort.abort(); }, 10000);
    readAt = Date.now();
    fetch(url, {signal: job.abort.signal, cache: 'no-store'}).then(function (r) { if (!r.ok) throw new Error('resume'); return r.json(); }).then(function (data) {
      if (context() !== key || reading !== job) return;
      if (data.version !== 1 || !Array.isArray(data.items)) throw new Error('contract');
      items = data.items.map(normal).filter(accepted).map(function (item) {
        // Lampac omits default-valued season=0 from captured Specials records.
        return item.card.indexOf('tv_') === 0 && item.season === undefined && !item.deleted && (item.kind === 'online' || item.kind === 'torrent') ? Object.assign({}, item, {season: 0}) : item;
      });
      var writes = Object.keys(pending).map(function (card) { return pending[card]; });
      if (sending && sending.queued.scope === key) writes.push(sending.queued);
      writes.forEach(function (write) {
        var queued = write.item, newer = items.find(function (item) { return item.card === queued.card && item.observed >= queued.observed; });
        if (!newer) { items = items.filter(function (item) { return item.card !== queued.card; }); items.unshift(queued); }
      });
      readError = false; loadedOnce = true;
      persist(); publish();
    }).catch(function () { if (context() === key) { readError = true; loadedOnce = true; publish(); } }).then(function () {
      clearTimeout(timer); if (reading === job) reading = null; enrich(); job.callbacks.splice(0).forEach(function (callback) { callback(); });
    });
  }
  function later(next, old) {
    if (!Number.isInteger(next.season) || !(next.episode > 0)) return false;
    // Specials have no position in the regular order; recency decides.
    if (next.season === 0 || !Number.isInteger(old.season) || old.season === 0) return true;
    return next.season > old.season || next.season === old.season && next.episode > old.episode;
  }
  function merged() {
    context();
    var byCard = {}, captured = {}, natives = {};
    items.forEach(function (item) { byCard[item.card] = Object.assign({}, item); captured[item.card] = true; });
    sync.rows().forEach(function (row) {
      var extra = sync.extra(row), key = extra.card;
      if (!/^(tv|movie)_\d+$/.test(key || '')) return;
      var old = byCard[key];
      // Native TimeCode stamps even a stale paused player's close as new. For
      // the captured episode (or movie) a newer native row only moves the
      // position forward, when it is watched or clearly further, and keeps
      // the source. Another episode replaces the record (without its source)
      // only when it is a later episode, or any episode once a special is
      // involved, viewed at least a minute and stamped more than two minutes
      // after the capture: the native player saves every two minutes, so
      // an active viewing keeps stamping while an old close does not. A
      // dismissed card returns on any newer viewing.
      if (captured[key]) {
        if (old.deleted) {
          if (!row.deleted && row.watched_at > old.observed && row.position > 1 && (!natives[key] || natives[key].watched_at < row.watched_at)) natives[key] = row;
          return;
        }
        if (row.deleted && String(row.hash) === old.timeline && row.watched_at > old.observed) { old.deleted = true; return; }
        if (row.deleted || !(row.watched_at > old.observed) || !(row.position > 1) || natives[key] && natives[key].watched_at >= row.watched_at) return;
        var same = key.indexOf('movie_') === 0 || extra.season === old.season && extra.episode === old.episode;
        // Another cut of the same episode has its own positions.
        if (same && old.timeline != null && String(row.hash) !== old.timeline) return;
        if (same ? watched(row) || row.position > old.position + 30 :
          key.indexOf('tv_') === 0 && row.watched_at > old.observed + NEWER && row.position >= 60 && later(extra, old)) natives[key] = row;
        return;
      }
      if (old && old.observed >= row.watched_at) return;
      var same = old && row.hash != null && String(row.hash) === old.timeline && (key.indexOf('movie_') === 0 || old.season === extra.season && old.episode === extra.episode);
      byCard[key] = Object.assign({}, old ? {title: old.title, poster: old.poster, backdrop: old.backdrop} : {}, same ? old : {}, {card: key, season: Number.isInteger(extra.season) && extra.season >= 0 ? extra.season : undefined, episode: extra.episode || 0,
        position: row.position, duration: row.duration, observed: row.watched_at, deleted: row.deleted});
    });
    Object.keys(natives).forEach(function (key) {
      var row = natives[key], extra = sync.extra(row), old = byCard[key];
      if (!old.deleted && (key.indexOf('movie_') === 0 || extra.season === old.season && extra.episode === old.episode)) {
        byCard[key] = Object.assign(old, {position: row.position, duration: row.duration, observed: row.watched_at});
        return;
      }
      byCard[key] = {card: key, title: old.title, poster: old.poster, backdrop: old.backdrop, original: old.original, date: old.date,
        season: Number.isInteger(extra.season) && extra.season >= 0 ? extra.season : undefined, episode: extra.episode || 0,
        timeline: row.hash != null ? String(row.hash) : undefined, position: row.position, duration: row.duration, observed: row.watched_at};
    });
    return Object.keys(byCard).map(function (key) { return Object.assign({}, byCard[key], remembered[key] || {}, metadata[key] || {}); });
  }
  // ── Labels and the row list: next episode, progress text, metadata ──
  // Lampa marks an episode watched at 90%; Continue then offers the next one.
  function nextEpisode(item, seasons) {
    if (!Number.isInteger(item.season) || item.season < 0 || !(item.episode > 0)) return null;
    var count = seasons && seasons[item.season];
    if (!seasons || !(count > 0) || item.episode < count) return seasons && seasons[item.season] === 0 ? null : {season: item.season, episode: item.episode + 1};
    if (item.season === 0) return null;
    var following = Object.keys(seasons).map(Number).filter(function (n) { return n > item.season && seasons[n] > 0; }).sort(function (a, b) { return a - b; })[0];
    return following ? {season: following, episode: 1} : null;
  }
  function watched(item) { return item.duration > 0 && item.position / item.duration >= .9; }
  // Time left as short Russian copy: "осталось 1 ч 5 мин".
  function remaining(position, duration) {
    var rest = Math.max(0, duration - position), minutes = Math.round(rest / 60);
    if (rest < 60) return 'осталось меньше минуты';
    if (minutes < 60) return 'осталось ' + minutes + ' мин';
    return 'осталось ' + Math.floor(minutes / 60) + ' ч' + (minutes % 60 ? ' ' + minutes % 60 + ' мин' : '');
  }
  function episodeLabel(season, episode) { return season === 0 ? 'Спецвыпуск ' + episode : 'С' + season + ' · Е' + episode; }
  function hasEpisode(item) { return item.card.indexOf('tv_') === 0 && Number.isInteger(item.season) && item.season >= 0 && item.episode > 0; }
  function percentOf(item) { return item.advance || !(item.duration > 0) ? 0 : Math.max(0, Math.min(100, item.position / item.duration * 100)); }
  function progressText(item) {
    var label = hasEpisode(item) ? episodeLabel(item.season, item.episode) : '';
    if (item.advance) return (item.fresh ? 'Новая серия: ' : 'Следующая: ') + (!label ? 'серия' : item.season === item.advance.season && item.season !== 0 ? 'Е' + item.episode : label);
    return (label ? label + ' · ' : '') + remaining(item.position, item.duration);
  }
  function sourceLabel(item) {
    if (item.kind === 'online' && item.online && item.online.provider) {
      var name = plain(item.online.provider).slice(0, 14);
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return item.kind !== 'online' && item.torrent ? 'Торрент' : '';
  }
  function list() {
    var result = [];
    merged().forEach(function (item) {
      if (item.deleted || !(item.duration > 0)) return;
      if (watched(item)) {
        if (item.card.indexOf('tv_') !== 0) return;
        var known = metadata[item.card] || remembered[item.card], next = nextEpisode(item, known && known.seasons);
        if (!next) return;
        // TMDB lists announced episodes too: an episode that has not aired yet is nothing to continue.
        var aired = known && known.aired, airedAt = aired ? Date.parse(aired.date + 'T00:00:00Z') : NaN;
        if (aired && next.season !== 0 && (next.season > aired.season || next.season === aired.season && next.episode > aired.episode)) return;
        var value = Object.assign({}, item, {season: next.season, episode: next.episode, position: 0, advance: {season: item.season, episode: item.episode}});
        // Episodes released after the last viewing are new: they lead the row and say so.
        if (Number.isFinite(airedAt) && airedAt > item.observed && next.season !== 0) value.fresh = true;
        // A native season index cannot be derived for another season.
        if (next.season !== item.season) delete value.online;
        result.push(value);
      } else if (item.position > 1) result.push(item);
    });
    return result.sort(function (a, b) { return (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0) || b.observed - a.observed; }).slice(0, 20);
  }
  function enrich() {
    if (!L.Api.sources || !L.Api.sources.tmdb || !L.Api.sources.tmdb.get) return;
    var key = context();
    merged().forEach(function (item) {
      if (resolving[item.card] || item.deleted) return;
      if (!item.title || item.card.indexOf('tv_') === 0 && watched(item) && !(metadata[item.card] && metadata[item.card].seasons)) { resolving[item.card] = true; metadataQueue.push(item); }
    });
    function work() {
      if (context() !== key) return;
      while (metadataRunning < 4 && metadataQueue.length) {
        (function (item) {
          metadataRunning++;
          function complete(data) {
            if (context() !== key) return;
            if (data) {
              var value = {};
              if (data.name || data.title) value.title = plain(data.name || data.title);
              if (data.poster_path) value.poster = data.poster_path;
              if (data.backdrop_path) value.backdrop = data.backdrop_path;
              if (Array.isArray(data.seasons)) {
                value.seasons = {};
                data.seasons.forEach(function (season) { if (season && Number.isInteger(season.season_number) && Number.isInteger(season.episode_count)) value.seasons[season.season_number] = season.episode_count; });
              }
              var aired = data.last_episode_to_air;
              if (aired && Number.isInteger(aired.season_number) && Number.isInteger(aired.episode_number) && /^\d{4}-\d{2}-\d{2}$/.test(aired.air_date || ''))
                value.aired = {season: aired.season_number, episode: aired.episode_number, date: aired.air_date};
              metadata[item.card] = value; persist();
            }
            metadataRunning--; publish(); work();
          }
          L.Api.sources.tmdb.get(item.card.replace('_', '/'), {}, complete, function () { complete(); });
        })(metadataQueue.shift());
      }
    }
    work();
  }
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
            url: L.Torserver.stream(file.path, item.torrent, item.index), homelab_resume_at: item.position,
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
  // ── Saving progress to the server while playing ──
  function drain() {
    if (sending) return;
    clearTimeout(writeTimer);
    var keys = Object.keys(pending).sort(function (a, b) { return pending[a].readyAt - pending[b].readyAt; });
    if (!keys.length) return;
    var wait = pending[keys[0]].readyAt - Date.now();
    if (wait > 0) { if (Number.isFinite(wait)) writeTimer = setTimeout(drain, wait); return; }
    var queued = pending[keys[0]]; delete pending[keys[0]];
    if (context() !== queued.scope) return drain();
    var job = sending = {abort: new AbortController(), queued: queued}, timer = setTimeout(function () { job.abort.abort(); }, 10000);
    fetch(queued.url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(queued.item),
      signal: job.abort.signal, keepalive: true}).then(function (r) {
      if (!r.ok) { var error = new Error('save'); error.retryable = r.status === 429 || r.status >= 500; throw error; }
      return typeof r.json === 'function' ? r.json().catch(function () { return {}; }) : {};
    }).then(function (body) {
      if (context() !== queued.scope) return;
      body = body || {};
      // The server may clamp a skewed device clock; adopt its stamp. A
      // rejected older write leaves the newer server record in place.
      if (!body.stale) {
        var saved = Number.isFinite(body.observed) ? Object.assign({}, queued.item, {observed: body.observed}) : queued.item;
        var newer = items.find(function (item) { return item.card === saved.card && item.observed > saved.observed; });
        if (!newer) { items = items.filter(function (item) { return item.card !== saved.card; }); items.unshift(saved); items = items.slice(0, 50); }
      }
      writeError = false;
      readAt = -Infinity;
    }).catch(function (error) {
      if (context() !== queued.scope) return;
      var newer = pending[queued.item.card];
      if (error.retryable === false) {
        // A permanently rejected write is dropped and no longer shown as saved.
        items = items.filter(function (item) { return item.card !== queued.item.card || item.observed !== queued.item.observed; });
        readAt = -Infinity; persist();
      } else if (!newer || newer.item.observed < queued.item.observed) {
        queued.attempt++;
        queued.readyAt = Date.now() + ([5000, 15000, 60000][queued.attempt - 1] || 300000);
        pending[queued.item.card] = queued;
      }
      writeError = true;
    }).then(function () { clearTimeout(timer); if (sending === job) sending = null; publish(); drain(); });
  }
  function queue(state) {
    if (!state.last || context() !== state.scope) return;
    if (state.queuedObserved >= state.last.observed) return;
    state.queuedObserved = state.last.observed;
    pending[state.last.card] = {scope: state.scope, url: state.url, item: Object.assign({}, state.last), attempt: 0, readyAt: 0};
    Object.keys(pending).slice(0, -50).forEach(function (key) { delete pending[key]; });
    var newer = items.find(function (item) { return item.card === state.last.card && item.observed > state.last.observed; });
    if (!newer) { items = items.filter(function (item) { return item.card !== state.last.card; }); items.unshift(state.last); items = items.slice(0, 50); }
    state.saved = Date.now(); drain();
  }
  // A user action stamped after the captured record and any native row, so
  // it wins locally at once and on the server.
  function stampFor(cardKey) {
    var previous = items.find(function (item) { return item.card === cardKey; });
    var native = sync.rows().reduce(function (max, row) { return sync.extra(row).card === cardKey && row.watched_at > max ? row.watched_at : max; }, 0);
    return Math.max(Date.now(), previous ? previous.observed + 1 : 0, native + 1);
  }
  function save(record) {
    var key = context(), url = sync.url('/homelab-sync/resume');
    if (!url) return false;
    items = items.filter(function (item) { return item.card !== record.card; }); items.unshift(record); items = items.slice(0, 50);
    pending[record.card] = {scope: key, url: url, item: record, attempt: 0, readyAt: 0};
    persist(); return true;
  }
  // Dismissal is a server tombstone; a later viewing brings the card back.
  function dismiss(cardKey) {
    context();
    if (!/^(tv|movie)_\d+$/.test(cardKey)) return;
    if (save({card: cardKey, deleted: true, observed: stampFor(cardKey)})) { publish(); drain(); }
  }
  // Marking the shown episode (or movie) watched stores it at its end with the
  // captured source, so the row offers the next episode exactly as after a
  // real viewing. Only records with a server-valid captured source qualify.
  function watchedRecord(entry) {
    context();
    var base = entry && items.find(function (item) { return item.card === entry.card && !item.deleted; });
    if (!base || entry.deleted || base.timeline == null || String(entry.timeline) !== String(base.timeline) || !(base.duration > 0)) return null;
    var online = base.kind === 'online';
    if (online ? !base.online || !base.online.provider : !/^[a-f0-9]{40}$/i.test(base.torrent || '') || !(base.index > 0)) return null;
    // The captured online season index belongs to the captured season; the
    // server requires an online source, so another season cannot be marked.
    if (online && hasEpisode(entry) && entry.season !== base.season) return null;
    var record = Object.assign({}, base, {position: base.duration, duration: base.duration});
    if (hasEpisode(entry)) { record.season = entry.season; record.episode = entry.episode; }
    return record;
  }
  function markWatched(entry) {
    var record = watchedRecord(entry);
    if (!record) return false;
    record.observed = stampFor(record.card);
    if (!save(record)) return false;
    enrich(); return true;
  }
  function measure(state) {
    var data = state.data;
    if (state.external) {
      var road = data.timeline || {};
      return Number.isFinite(road.time) && road.duration > 0 && road.duration <= 86400 ? {position: road.time, duration: road.duration} : null;
    }
    var video = L.PlayerVideo.video();
    if (!video || video.seeking || video.rewind || !(video.duration > 0 && video.duration <= 86400) || !Number.isFinite(video.currentTime)) return null;
    return {position: video.currentTime, duration: video.duration};
  }
  // Row position for a movie resume; the resolver url stays in this session.
  function matchOf(match) {
    return {index: match.index || 0, count: match.count, text: match.text || '', translate: match.translate || '', voice_name: match.voice_name || ''};
  }
  // A hand start before the video reports anything: its stored position, if it is one to continue from.
  function again() { return !!(L.Storage.field && L.Storage.field('player_timecode') === 'again'); }
  function launchPoint(state) {
    var road = state.data.timeline;
    // In «start over» mode the stored position is not where playback goes.
    if (!state.launch || state.last || state.external || !road || again()) return null;
    return Number.isFinite(road.time) && road.time > 1 && road.percent < 90 && road.duration > 0 && road.duration <= 86400 ? {position: road.time, duration: road.duration} : null;
  }
  function snapshot(state, force, atStart) {
    if ((playing !== state && external !== state) || context() !== state.scope || (!state.external && state.data.homelab_resume_at != null && !state.applied)) return;
    var data = state.data, movie = data.card;
    // Until Lampa has moved the video to the stored position it reports the start: keep the stored one.
    if (!atStart && !state.external && data.timeline && data.timeline.continued === false && !again()) return;
    var measured = atStart ? launchPoint(state) : measure(state) || launchPoint(state);
    if (!movie || !movie.id || !data.timeline || !measured) return;
    // Ids from other catalogues (Kinopoisk, anime plugins) are not TMDB ids.
    if (['tmdb', 'cub'].indexOf(String(movie.source || 'tmdb')) < 0) return;
    var hash = data.homelab_torrent_hash || data.torrent_hash, index = data.homelab_file_index;
    if (index == null && data.torrent_hash) { try { index = Number(new URL(data.url, window.location.href).searchParams.get('index')); } catch (_) {} }
    var online = data.homelab_online;
    if (online && (!window.HomelabOnlineResume || !window.HomelabOnlineResume.valid(online))) return;
    if (!online && (!/^[a-f0-9]{40}$/i.test(hash || '') || !Number.isInteger(index))) return;
    var tv = !!(movie.name || movie.original_name);
    if (tv && !(data.episode > 0)) return;
    var next = {card: (tv ? 'tv_' : 'movie_') + movie.id, title: plain(movie.name || movie.title), poster: movie.poster_path, backdrop: movie.backdrop_path,
      kind: online ? 'online' : 'torrent', online: online ? Object.assign({provider: online.provider, voice: online.voice, season_index: online.season_index}, online.text ? {text: String(online.text).slice(0, 200)} : {}, online.match ? {match: matchOf(online.match)} : {}) : null,
      torrent: online ? null : hash.toLowerCase(), index: online ? 0 : index, original: String(movie.original_title || movie.original_name || ''), date: movie.first_air_date || movie.release_date || null, timeline: String(data.timeline.hash), season: data.season || 0, episode: data.episode || 0,
      position: Math.max(0, measured.position), duration: measured.duration,
      tracks: L.HomelabGstAudio && L.HomelabGstAudio.preferences ? L.HomelabGstAudio.preferences(data) : data.homelab_track_preferences || {}};
    var stamp = JSON.stringify(next);
    if (stamp !== state.stamp) {
      // An episode started by hand is the one being watched, even an earlier one than the record
      // (a playlist that went on overnight): stamp it past every record and native row of the card.
      var base = state.launch && !state.last ? stampFor(next.card) : Date.now();
      state.stamp = stamp; state.last = Object.assign(next, {observed: Math.max(base, state.last ? state.last.observed + 1 : 0)});
    }
    if (force || Date.now() - state.saved >= 15000) queue(state);
  }
  function detachRestore() {
    if (!restore) return;
    restore.video.removeEventListener('loadedmetadata', restore.apply); restore.video.removeEventListener('canplay', restore.apply); restore = null;
  }
  function bindResume(state) {
    detachRestore();
    if (!state || state.applied || state.data.homelab_resume_at == null) return;
    var video = L.PlayerVideo.video();
    function apply() {
      if (playing !== state || state.applied || context() !== state.scope || L.PlayerVideo.video() !== video || !(video.duration > 0)) return;
      var requested = state.data.homelab_resume_at, oldDuration = state.data.homelab_resume_from_duration;
      if (oldDuration > 0 && requested >= video.duration - 5) {
        requested = 0; L.Noty.show('Эта версия короче сохранённой позиции. Воспроизведение начнётся сначала');
      } else if (oldDuration > 0 && Math.abs(oldDuration - video.duration) > Math.max(30, oldDuration * .03)) {
        L.Noty.show('Длительность версии отличается. Проверьте позицию воспроизведения');
      }
      var at = Math.max(0, Math.min(requested, video.duration - .1));
      try {
        video.currentTime = at; state.applied = true;
        Object.assign(state.data.timeline, {continued: true, waiting_for_user: false, time: at, duration: video.duration, percent: at / video.duration * 100});
        delete state.data.homelab_resume_at;
        delete state.data.homelab_resume_from_duration;
        detachRestore();
      } catch (_) {}
    }
    restore = {video: video, apply: apply}; video.addEventListener('loadedmetadata', apply); video.addEventListener('canplay', apply); apply();
  }
  // External players (Android, webOS, Apple TV) read the start position from
  // the timeline before 'external'; the inner player gets it from bindResume.
  L.Player.listener.follow('create', function (event) {
    var data = event && event.data;
    if (!data || data.homelab_resume_at == null || !data.timeline) return;
    data.homelab_external_start = true;
    var duration = data.homelab_resume_from_duration || data.timeline.duration;
    data.timeline.time = data.homelab_resume_at;
    if (duration > 0) data.timeline.percent = Math.min(100, data.homelab_resume_at / duration * 100);
  });
  L.Player.listener.follow('start', function (data) {
    if (!data || !data.homelab_external_start || !data.timeline) return;
    delete data.homelab_external_start; data.timeline.time = 0; data.timeline.percent = 0;
  });
  L.Player.listener.follow('external', function (data) {
    if (resumeIntent) { clearTimeout(resumeIntent.timer); resumeIntent = null; }
    if (playing) { clearTimeout(playing.pause); queue(playing); playing = null; }
    if (!data) return;
    delete data.homelab_external_start;
    external = {data: data, scope: context(), url: sync.url('/homelab-sync/resume'), saved: -Infinity, external: true, at: Date.now()};
    snapshot(external, true);
  });
  // Returning from an external player updates the native timeline.
  if (L.Timeline.listener && typeof L.Timeline.listener.follow === 'function') L.Timeline.listener.follow('update', function (event) {
    var state = external, road = event && event.data && event.data.road, timeline = state && state.data.timeline;
    if (!state || !road || !timeline || Date.now() - state.at > DAY || String(event.data.hash) !== String(timeline.hash)) return;
    timeline.time = road.time; timeline.duration = road.duration; timeline.percent = road.percent;
    snapshot(state, true);
  });
  L.Player.listener.follow('ready', function (data) {
    if (resumeIntent) { clearTimeout(resumeIntent.timer); resumeIntent = null; }
    external = null;
    if (playing) queue(playing);
    // Playlist steps (the next episode, also automatic ones) carry continue_play; a start by hand does not.
    playing = {data: data, scope: context(), url: sync.url('/homelab-sync/resume'), saved: -Infinity, launch: !!data && !data.continue_play && data.homelab_resume_at == null};
    bindResume(playing);
    if (playing.launch) snapshot(playing, true, true);
  });
  L.PlayerVideo.listener.follow('loadeddata', function () { bindResume(playing); });
  L.PlayerVideo.listener.follow('timeupdate', function () { if (playing) snapshot(playing, false); });
  L.PlayerVideo.listener.follow('pause', function () {
    var state = playing; if (!state) return;
    clearTimeout(state.pause); state.pause = setTimeout(function () { snapshot(state, true); }, 500);
  });
  L.Player.listener.follow('destroy', function () {
    if (playing) { clearTimeout(playing.pause); queue(playing); }
    playing = null; detachRestore(); publish();
  });
  sync.subscribe(function () { context(); if (!L.Player.opened()) load(); });
  // ── The home screen row: «Продолжить просмотр» and «Новые серии» ──
  var audioBound;
  function audioReady() {
    var audio = L.HomelabGstAudio;
    if (!audio || audioBound === audio || !audio.subscribe) return;
    audioBound = audio; audio.subscribe(function (event) {
      if (event.type === 'preferences' && playing && playing.data === event.work) {
        var state = playing; clearTimeout(state.pause); state.pause = setTimeout(function () { snapshot(state, true); }, 500);
      }
    });
  }
  audioReady(); window.addEventListener('homelab:audio-ready', audioReady);
  var rowCount = 0;
  function episodeWindow(item, episodes) {
    var seen = {};
    var season = (Array.isArray(episodes) ? episodes : []).filter(function (ep) {
      if (!ep || ep.season_number !== item.season || !Number.isInteger(ep.episode_number) || ep.episode_number < 1 || seen[ep.episode_number]) return false;
      seen[ep.episode_number] = true; return true;
    }).slice().sort(function (a, b) { return a.episode_number - b.episode_number; });
    var index = season.findIndex(function (ep) { return ep.episode_number === item.episode; });
    return index < 0 ? [] : season.slice(index, index + 5);
  }
  // The focus overlay's episode list from the last session, so a focused
  // tile does not grow from one line to the list while the app starts.
  function storedWindow(item) {
    var value = null;
    try { value = L.Storage.get(EPISODES, null); } catch (_) {}
    var rows = value && value[scope + '|' + item.card + ':' + item.season + ':' + item.episode];
    return Array.isArray(rows) ? rows.filter(function (row) { return row && Number.isInteger(row.episode_number); }).map(function (row) { return {episode_number: row.episode_number, name: plain(row.name).slice(0, 200)}; }) : [];
  }
  function storeWindow(item, rows) {
    var value = null;
    try { value = L.Storage.get(EPISODES, null); } catch (_) {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
    var name = scope + '|' + item.card + ':' + item.season + ':' + item.episode, wanted = {};
    list().forEach(function (entry) { wanted[scope + '|' + entry.card + ':' + entry.season + ':' + entry.episode] = true; });
    // Other profiles keep their entries; this profile keeps only its row.
    Object.keys(value).forEach(function (key) { if (key.indexOf(scope + '|') === 0 && !wanted[key]) delete value[key]; });
    if (Object.keys(value).length > 200) value = {};
    value[name] = rows.map(function (row) { return {episode_number: row.episode_number, name: plain(row.name).slice(0, 200)}; });
    try { L.Storage.set(EPISODES, value, true); } catch (_) {}
  }
  // One line of tiles: what is being watched ('continue') or episodes released since ('fresh').
  function ResumeLine(kind, focus) {
    var fresh = kind === 'fresh', self = this, bus = L.Subscribe(), html = window.$('<div class="homelab-resume-row' + (fresh ? ' homelab-resume-fresh hide' : '') + '"><div class="homelab-resume-title"></div><div class="homelab-resume-sync"></div></div>');
    html.find('.homelab-resume-title').text(fresh ? 'Новые серии' : 'Продолжить просмотр');
    var scroll = new L.Scroll({horizontal: true, step: 300}), last = null, stamp = '', destroyed = false, cards = [], byCard = {}, order = '', orderList = [], seasons = {}, seasonScope = sync.scope(), empty = null;
    function clearSeasons() { Object.keys(seasons).forEach(function (name) { clearTimeout(seasons[name].timer); }); seasons = {}; }
    function clearCards() { cards.splice(0).forEach(function (native) { native.destroy(); }); byCard = {}; order = ''; }
    scroll.onScroll = function () { L.Layer.visible(scroll.render(true)); };
    function episodes(item, done) {
      var name = item.card + ':' + item.season, key = sync.scope(), cached = seasons[name];
      if (cached) { if (cached.value) done(cached.value); else cached.waiters.push(done); return; }
      var job = seasons[name] = {waiters: [done]};
      function complete(value) {
        if (destroyed || sync.scope() !== key || job.value) return;
        clearTimeout(job.timer); job.value = value;
        job.waiters.splice(0).forEach(function (callback) { callback(value); });
      }
      job.timer = setTimeout(function () { complete([]); }, 10000);
      function fetchSeason() {
        if (destroyed || sync.scope() !== key || job.value) return;
        if (!L.Api.sources || !L.Api.sources.tmdb || typeof L.Api.sources.tmdb.get !== 'function') return complete([]);
        L.Api.sources.tmdb.get('tv/' + item.card.split('_')[1] + '/season/' + item.season, {}, function (data) {
          complete(data && Array.isArray(data.episodes) ? data.episodes : []);
        }, function () { complete([]); });
      }
      if (!L.TimeTable || typeof L.TimeTable.get !== 'function') return fetchSeason();
      L.TimeTable.get(card(item), function (rows) {
        if (destroyed || sync.scope() !== key || job.value) return;
        if (rows && rows[0] && rows[0].season_number === 1) {
          rows = typeof L.Utils.splitEpisodesIntoSeasons === 'function' ? L.Utils.splitEpisodesIntoSeasons(rows)[item.season] || [] : [];
        }
        if (episodeWindow(item, rows).length) complete(rows); else fetchSeason();
      });
    }

    this.use = function (module) { Object.keys(module).forEach(function (name) {
      if (/^on[A-Z]/.test(name)) bus.follow(name.slice(2).toLowerCase(), function (args) { module[name].apply(self, args || []); });
    }); };
    this.emit = function (name) { bus.send(name.toLowerCase(), [].slice.call(arguments, 1)); };
    function draw() {
      if (destroyed) return;
      if (seasonScope !== sync.scope()) { clearSeasons(); clearCards(); seasonScope = sync.scope(); stamp = ''; }
      var data = list().filter(function (item) { return !!item.fresh === fresh; }), next = JSON.stringify({items: data, warning: writeError || readError, ready: loadedOnce, minute: Math.floor(Date.now() / 60000)});
      if (next === stamp) return; stamp = next;
      var focused = L.Controller.own(self), nextOrder = JSON.stringify(data.map(function (item) { return item.card; })), changedOrder = nextOrder !== order, wanted = {};
      html.find('.homelab-resume-sync').text(!fresh && (writeError || readError) ? 'Продолжение не синхронизировано: показаны последние данные' : '');
      html.toggleClass('hide', fresh && !data.length);
      data.forEach(function (item) {
        wanted[item.card] = true;
        if (byCard[item.card]) { byCard[item.card].update(item); return; }
        var alive = true, timer = null, loaded = false, displayed = [];
        var native = L.Maker.make('Card', card(item), function (mask) { return mask.only('Card', 'Icons', 'Release', 'Callback'); });
        native.use({onEnter: function () { resume(item); }, onFocus: function (target) {
          focus.card = item.card; last = target; scroll.update(last, true); self.emit('active');
        }, onDestroy: function () { alive = false; clearTimeout(timer); }});
        native.create();
        var tile = native.render().addClass('homelab-resume-card');
        var progress = window.$('<div class="card-watched homelab-resume-progress"><div class="card-watched__inner"><div class="homelab-resume-head"></div><div class="card-watched__body"></div></div></div>');
        var bar = window.$('<div class="homelab-resume-bar"><div></div></div>'), badge = window.$('<div class="homelab-resume-badge"></div>');
        // Native progress of the other episodes of the shown season, so the
        // overlay can mark watched and started ones.
        function states() {
          var result = {};
          sync.rows().forEach(function (row) {
            var extra = sync.extra(row), old;
            if (row.deleted || extra.card !== item.card || extra.season !== item.season || !(extra.episode > 0)) return;
            old = result[extra.episode];
            if (old && old.at >= row.watched_at) return;
            result[extra.episode] = {at: row.watched_at, percent: row.duration > 0 ? row.position / row.duration * 100 : +row.percent || 0};
          });
          if (item.advance && item.advance.season === item.season) result[item.advance.episode] = {at: Infinity, percent: 100};
          return result;
        }
        function track(percent) {
          var value = window.$('<div class="homelab-resume-track"><div></div></div>');
          value.find('div').css('width', percent + '%'); return value;
        }
        function paint(rows) {
          if (!alive || destroyed) return;
          displayed = rows;
          var body = progress.find('.card-watched__body').empty(), known = rows.length ? states() : {};
          progress.find('.homelab-resume-head').text(hasEpisode(item) ? item.season === 0 ? 'Спецвыпуски' : 'Сезон ' + item.season : '');
          (rows.length ? rows : [null]).forEach(function (episode) {
            var number = episode ? episode.episode_number : item.episode, current = !episode || number === item.episode;
            var state = current ? null : known[number], done = !!state && state.percent >= 90, percent = current ? percentOf(item) : state && !done ? state.percent : 0;
            var line = window.$('<div class="card-watched__item homelab-ep"><span></span></div>');
            if (current) line.addClass(item.advance ? 'homelab-ep--current homelab-ep--next' : 'homelab-ep--current');
            if (done) line.addClass('homelab-ep--watched');
            line.find('span').text(episode ? number + ' · ' + plain(episode.name || 'Серия ' + number) : progressText(item));
            if (current ? percent > 0 : percent > 1) line.append(track(Math.min(100, percent)));
            body.append(line);
          });
        }
        // Everything on the tile itself comes from the cached record: no
        // request is needed to show progress, source or time.
        function decorate() {
          var percent = percentOf(item), source = sourceLabel(item);
          bar.toggleClass('hide', !(percent > 0)); bar.find('div').css('width', percent + '%');
          badge.text(item.fresh ? 'Новая серия' : source).toggleClass('hide', !item.fresh && !source).toggleClass('is-new', !!item.fresh);
        }
        function lookupEpisodes() {
          if (!item.episode || !Number.isInteger(item.season) || item.season < 0 || loaded) return;
          clearTimeout(timer); timer = setTimeout(function () {
            if (!alive || destroyed || !tile.hasClass('focus')) return;
            var scope = sync.scope(), selected = item; loaded = true;
            episodes(selected, function (rows) {
              if (!alive || destroyed || sync.scope() !== scope || selected.season !== item.season || selected.episode !== item.episode) return;
              var shown = episodeWindow(item, rows);
              if (JSON.stringify(shown.map(function (row) { return [row.episode_number, plain(row.name)]; })) !== JSON.stringify(displayed.map(function (row) { return [row.episode_number, plain(row.name)]; }))) paint(shown);
              if (shown.length) storeWindow(item, shown);
            });
          }, 500);
        }
        tile.on('hover:focus hover:touch hover:hover', lookupEpisodes);
        tile.on('hover:long', function () { if (alive && !destroyed) menu(item); });
        tile.find('.card__view').append(progress).append(bar).append(badge);
        // No footer under the title: progress and source live on the poster.
        tile.find('.card__age').remove();
        tile.find('.card__icons-inner').append(window.$('<div class="card__icon icon--history"></div>'));
        decorate(); paint(hasEpisode(item) ? storedWindow(item) : []);
        byCard[item.card] = {native: native, update: function (value) {
          var previous = card(item), changedEpisode = item.season !== value.season || item.episode !== value.episode;
          item = value;
          var current = card(item);
          if (native.data) Object.assign(native.data, current);
          tile.find('.card__title').text(current.title);
          decorate();
          if (previous.poster_path !== current.poster_path) {
            // Re-emitting visible leaves an old native image timeout armed.
            // Keep the loader's existing handlers and update only its source.
            tile.find('.card__img').attr('src', typeof native.getPosterPath === 'function' ? native.getPosterPath() : current.poster_path ? L.Api.img(current.poster_path) : './img/img_broken.svg');
          }
          if (changedEpisode) { clearTimeout(timer); loaded = false; displayed = hasEpisode(item) ? storedWindow(item) : []; }
          paint(displayed);
          if (changedEpisode && tile.hasClass('focus')) lookupEpisodes();
        }};
      });
      Object.keys(byCard).forEach(function (card) { if (!wanted[card]) { byCard[card].native.destroy(); delete byCard[card]; } });
      cards = data.map(function (item) { return byCard[item.card].native; });
      if (empty) empty.text(loadedOnce ? 'Здесь появятся незавершённые просмотры' : 'Загрузка…');
      if (changedOrder) {
        order = nextOrder; orderList = data.map(function (item) { return item.card; }); scroll.clear(); empty = null;
        if (!cards.length && !fresh) { empty = window.$('<div class="homelab-resume-empty selector"></div>').text(loadedOnce ? 'Здесь появятся незавершённые просмотры' : 'Загрузка…'); scroll.append(empty); }
        cards.forEach(function (native) { scroll.append(native.render(true)); });
        last = byCard[focus.card] ? byCard[focus.card].native.render(true) : cards.length ? cards[0].render(true) : null;
      }
      L.Layer.visible(scroll.render(true));
      // The last new episode left (watched, removed): hand focus back to the line above.
      if (focused && !cards.length && fresh) { last = null; return self.emit('up'); }
      if (focused && changedOrder) { quiet(); L.Controller.collectionSet(scroll.render(true)); L.Controller.collectionFocus(last || false, scroll.render(true)); }
    }
    // Long press (or remote hold) opens the card's actions. Removal keeps the
    // tombstone semantics; focus moves to a neighbour only when the card leaves.
    function menu(item) {
      if (!L.Select || typeof L.Select.show !== 'function') return;
      var previous = L.Controller.enabled().name, tv = item.card.indexOf('tv_') === 0, shown = hasEpisode(item) ? episodeLabel(item.season, item.episode) : '';
      function back() { L.Controller.toggle(previous); }
      var options = [{title: 'Убрать из ряда', subtitle: 'Вернётся при следующем просмотре', action: 'remove', remove: true}];
      if (watchedRecord(item)) options.push({title: 'Отметить просмотренным', subtitle: tv ? (shown ? shown + ' · ' : '') + 'в ряду останется следующая' : 'Фильм уйдёт из ряда', action: 'watched'});
      options.push({title: 'Выбрать источник', subtitle: (shown ? shown + ' · ' : '') + 'другая озвучка или раздача', action: 'source'});
      L.Select.show({title: plain(item.title || 'Продолжить просмотр'), items: options,
        onBack: back,
        onSelect: function (choice) {
          back();
          if (!choice || destroyed) return;
          var index = orderList.indexOf(item.card), neighbour = orderList[index + 1] || orderList[index - 1] || '';
          if (choice.action === 'source') return resume(item, {choose: true});
          if (choice.action === 'remove') { focus.card = neighbour; dismiss(item.card); return; }
          if (choice.action !== 'watched' || !markWatched(item)) return;
          focus.card = list().some(function (entry) { return entry.card === item.card && !!entry.fresh === fresh; }) ? item.card : neighbour;
          publish(); drain();
        }});
    }
    this.empty = function () { return !cards.length; };
    this.has = function (cardKey) { return !!byCard[cardKey]; };
    this.create = function () { scroll.body().addClass('homelab-resume-items mapping--line'); html.append(scroll.render()); listeners.push(draw); draw(); };
    this.render = function (js) { return js ? html[0] : html; };
    // Lampa restarts the card focus bounce whenever focus is set again; only
    // a remote press should bounce, not the reloads while the app starts.
    function quiet(on) { html.toggleClass('homelab-resume-quiet', on !== false && Date.now() - lastKey > 500); }
    function move(step) {
      var tiles = scroll.render(true).querySelectorAll('.selector'), index = Array.prototype.indexOf.call(tiles, last), next = index + step;
      if (next >= 0 && next < tiles.length) { quiet(false); L.Controller.collectionFocus(tiles[next], scroll.render(true)); }
      else if (step < 0) self.emit('left');
    }
    this.toggle = function () {
      L.Controller.add('homelab_resume', {link: self, toggle: function () {
        // Re-toggled by name (a menu closing) after its last tile left: go back up instead.
        if (fresh && !cards.length) return self.emit('up');
        quiet(); L.Controller.collectionSet(scroll.render(true)); L.Controller.collectionFocus(last || false, scroll.render(true)); self.emit('toggle'); self.emit('active');
      }, right: function () { move(1); },
      left: function () { move(-1); },
      up: function () { self.emit('up'); }, down: function () { self.emit('down'); }, back: function () { self.emit('back'); }});
      L.Controller.toggle('homelab_resume');
    };
    this.destroy = function () { destroyed = true; listeners = listeners.filter(function (fn) { return fn !== draw; }); clearCards(); clearSeasons(); scroll.destroy(); html.remove(); self.emit('destroy'); };
  }
  // The home screen row: «Продолжить просмотр», and under it «Новые серии» when there are any.
  // Both live in one Main row, so an empty second line never takes a step of the remote.
  function ResumeRow() {
    var self = this, bus = L.Subscribe(), html = window.$('<div class="homelab-resume-group"></div>');
    // The focused card is shared, so focus follows a card that moves between the lines.
    var focus = {card: ''}, watching = new ResumeLine('continue', focus), fresh = new ResumeLine('fresh', focus), destroyed = false;
    function current() { return fresh.has(focus.card) ? fresh : watching; }
    function relay(name) { return function () { self.emit.apply(self, [name].concat([].slice.call(arguments))); }; }
    watching.use({onDown: function () { if (fresh.empty()) self.emit('down'); else fresh.toggle(); }, onUp: relay('up'), onBack: relay('back'), onLeft: relay('left'), onActive: relay('active'), onToggle: relay('toggle')});
    fresh.use({onUp: function () { if (!destroyed) watching.toggle(); }, onDown: relay('down'), onBack: relay('back'), onLeft: relay('left'), onActive: relay('active'), onToggle: relay('toggle')});
    this.use = function (module) { Object.keys(module).forEach(function (name) {
      if (/^on[A-Z]/.test(name)) bus.follow(name.slice(2).toLowerCase(), function (args) { module[name].apply(self, args || []); });
    }); };
    this.emit = function (name) { bus.send(name.toLowerCase(), [].slice.call(arguments, 1)); };
    this.create = function () { rowCount++; watching.create(); fresh.create(); html.append(watching.render()).append(fresh.render()); };
    this.render = function (js) { return js ? html[0] : html; };
    this.toggle = function () { current().toggle(); };
    this.destroy = function () { destroyed = true; rowCount--; watching.destroy(); fresh.destroy(); html.remove(); self.emit('destroy'); };
  }
  window.$('head').append(window.$('<style></style>').text('.homelab-resume-row{padding:1em 0}' +
    '.homelab-resume-row.hide{display:none}' +
    '.homelab-resume-fresh{padding-top:0}' +
    '.homelab-resume-items{display:flex;align-items:stretch}' +
    '.homelab-resume-title{white-space:normal;font-size:1.8em;margin:0 .6em .8em}' +
    '.homelab-resume-card{flex-shrink:0}' +
    '.homelab-resume-card .card__title{line-height:1.3;height:2.6em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}' +
    '.homelab-resume-bar{position:absolute;left:.7em;right:.7em;bottom:.7em;height:.3em;border-radius:1em;background:rgba(255,255,255,.3);overflow:hidden;z-index:1;pointer-events:none}' +
    '.homelab-resume-bar div{height:100%;border-radius:1em;background:#fff}' +
    '.homelab-resume-badge{position:absolute;top:.6em;right:.6em;max-width:45%;padding:.25em .55em;border-radius:.4em;background:rgba(0,0,0,.6);color:#fff;font-size:.8em;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:1;pointer-events:none}' +
    '.homelab-resume-bar.hide,.homelab-resume-badge.hide{display:none}' +
    '.homelab-resume-badge.is-new{background:#ffd66b;color:#000;font-weight:600}' +
    '.homelab-resume-progress .card-watched__inner{padding:.7em .8em .8em}' +
    '.homelab-resume-head{font-size:.75em;opacity:.6;padding-top:.2em}' +
    '.homelab-resume-head:empty{display:none}' +
    '.homelab-resume-progress .card-watched__item.homelab-ep{margin-top:.55em;color:rgba(255,255,255,.65)}' +
    '.homelab-resume-progress .card-watched__item.homelab-ep--current{color:#fff;font-weight:600}' +
    '.homelab-resume-progress .card-watched__item.homelab-ep--watched{color:rgba(255,255,255,.45)}' +
    '.homelab-ep--watched>span:before{content:"";display:inline-block;width:.3em;height:.6em;margin:0 .55em .15em .15em;border-right:.15em solid currentColor;border-bottom:.15em solid currentColor;-webkit-transform:rotate(45deg);transform:rotate(45deg)}' +
    '.homelab-ep--next>span:before{content:"";display:inline-block;width:0;height:0;margin:0 .45em .05em .1em;border-left:.5em solid #fff;border-top:.32em solid transparent;border-bottom:.32em solid transparent}' +
    '.homelab-resume-track{height:.2em;background:rgba(255,255,255,.25);margin-top:.4em;border-radius:1em;overflow:hidden}' +
    '.homelab-resume-track div{height:100%;background:#fff}' +
    '.homelab-ep:not(.homelab-ep--current) .homelab-resume-track div{background:rgba(255,255,255,.55)}' +
    '.homelab-resume-empty{padding:1em;opacity:.7}' +
    '.homelab-resume-quiet .homelab-resume-card .card__view{-webkit-animation:none!important;animation:none!important}'));
  L.ContentRows.add({name: 'homelab_continue', title: 'Продолжить просмотр', index: 0, screen: ['main'],
    // Resolve at once from the cached list: Main waits for its whole first
    // batch of rows, so a slow Lampac must not hold the home screen.
    call: function () { return function (resolve) {
      context();
      resolve({title: 'Продолжить просмотр', results: [{}], params: {createInstance: function () { return new ResumeRow(); }}});
      sync.pull(function () { load(); });
    }; }});
  window.homelabContinue = {list: list, resume: resume, load: load, dismiss: dismiss,
    watched: function (entry) { if (markWatched(entry)) { publish(); drain(); return true; } return false; }, subscribe: function (fn) { listeners.push(fn); }};
  // Plugins may finish loading after Main has already collected its rows.
  setTimeout(function () {
    var active = L.Activity && typeof L.Activity.active === 'function' ? L.Activity.active() : null;
    if (!rowCount && active && active.component === 'main' && typeof L.Activity.refresh === 'function' && !L.Player.opened() && (!L.Modal || !L.Modal.opened()) && (!L.Select || !L.Select.opened || !L.Select.opened())) L.Activity.refresh();
  }, 1000);
})();
