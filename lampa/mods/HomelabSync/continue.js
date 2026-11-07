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
  var items = [], scope = '', reading = null, readAt = -Infinity, listeners = [], playing = null, pending = {}, sending = null, restore = null, metadata = {}, resolving = {}, metadataQueue = [], metadataRunning = 0, resumeIntent = null, writeTimer = null, writeError = false, readError = false;
  function cancelResume() { if (window.HomelabOnlineResume) window.HomelabOnlineResume.cancel(); if (resumeIntent) clearTimeout(resumeIntent.timer); resumeIntent = null; }
  function plain(value) { return String(value || '').replace(/[<>"'`]/g, ''); }
  function context() {
    var key = sync.scope();
    if (scope !== key) {
      scope = key; items = []; metadata = {}; resolving = {}; metadataQueue = []; metadataRunning = 0; readAt = -Infinity; pending = {}; writeError = false; readError = false;
      clearTimeout(writeTimer);
      if (reading) reading.abort.abort(); reading = null;
      if (sending) sending.abort.abort(); sending = null;
      cancelResume();
      publish();
    }
    return key;
  }
  function publish() { listeners.slice().forEach(function (fn) { fn(); }); }
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
      items = data.items.filter(function (item) { return item && /^(tv|movie)_\d+$/.test(item.card) && Number.isFinite(item.position) && Number.isFinite(item.duration); }).map(function (item) {
        // Lampac omits default-valued season=0 from captured Specials records.
        return item.card.indexOf('tv_') === 0 && item.season === undefined && (item.kind === 'online' || item.kind === 'torrent') ? Object.assign({}, item, {season: 0}) : item;
      });
      var writes = Object.keys(pending).map(function (card) { return pending[card]; });
      if (sending && sending.queued.scope === key) writes.push(sending.queued);
      writes.forEach(function (write) {
        var queued = write.item, newer = items.find(function (item) { return item.card === queued.card && item.observed >= queued.observed; });
        if (!newer) { items = items.filter(function (item) { return item.card !== queued.card; }); items.unshift(queued); }
      });
      readError = false;
      publish();
    }).catch(function () { if (context() === key) { readError = true; publish(); } }).then(function () {
      clearTimeout(timer); if (reading === job) reading = null; enrich(); job.callbacks.splice(0).forEach(function (callback) { callback(); });
    });
  }
  function list() {
    context();
    var byCard = {}, captured = {};
    items.forEach(function (item) { byCard[item.card] = Object.assign({}, item); captured[item.card] = true; });
    sync.rows().forEach(function (row) {
      var extra = sync.extra(row), key = extra.card;
      if (!/^(tv|movie)_\d+$/.test(key || '')) return;
      var old = byCard[key];
      // Native TimeCode stamps even a stale paused player's close as new.
      // Captured observations are authoritative; legacy rows only seed cards
      // that have never been captured by this extension.
      if (captured[key]) {
        if (row.deleted && String(row.hash) === old.timeline && row.watched_at > old.observed) old.deleted = true;
        return;
      }
      if (old && old.observed >= row.watched_at) return;
      var same = old && row.hash != null && String(row.hash) === old.timeline && (key.indexOf('movie_') === 0 || old.season === extra.season && old.episode === extra.episode);
      byCard[key] = Object.assign({}, old ? {title: old.title, poster: old.poster, backdrop: old.backdrop} : {}, same ? old : {}, {card: key, season: Number.isInteger(extra.season) && extra.season >= 0 ? extra.season : undefined, episode: extra.episode || 0,
        position: row.position, duration: row.duration, observed: row.watched_at, deleted: row.deleted});
    });
    return Object.keys(byCard).map(function (key) { return Object.assign({}, byCard[key], metadata[key] || {}); }).filter(function (item) {
      return !item.deleted && item.position > 1 && item.duration > 0 && item.position / item.duration < .98;
    }).sort(function (a, b) { return b.observed - a.observed; }).slice(0, 20);
  }
  function enrich() {
    if (!L.Api.sources || !L.Api.sources.tmdb || !L.Api.sources.tmdb.get) return;
    var key = context();
    list().forEach(function (item) { if (!item.title && !resolving[item.card]) { resolving[item.card] = true; metadataQueue.push(item); } });
    function work() {
      if (context() !== key) return;
      while (metadataRunning < 4 && metadataQueue.length) {
        (function (item) {
          metadataRunning++;
          function complete(data) {
            if (context() !== key) return;
            if (data) metadata[item.card] = {title: plain(data.name || data.title), poster: data.poster_path, backdrop: data.backdrop_path};
            metadataRunning--; publish(); work();
          }
          L.Api.sources.tmdb.get(item.card.replace('_', '/'), {}, complete, function () { complete(); });
        })(metadataQueue.shift());
      }
    }
    work();
  }
  function card(item) {
    var tv = item.card.indexOf('tv_') === 0, result = {id: +item.card.split('_')[1], source: 'tmdb', poster_path: item.poster, backdrop_path: item.backdrop};
    result.title = plain(item.title || (tv ? 'Сериал #' : 'Фильм #') + result.id);
    if (tv) result.name = result.title;
    result.original_title = String(item.original || result[tv ? 'name' : 'title']);
    if (item.date) result[tv ? 'first_air_date' : 'release_date'] = item.date;
    if (tv) { result.original_name = result.original_title; result.number_of_seasons = Math.max(1, item.season || 0); }
    return result;
  }
  function fallback(item) {
    L.Noty.show('Раздача недоступна. Выберите источник для продолжения');
    var value = card(item); delete value.params;
    L.Router.call('full', value);
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
      var selected = file.id === item.index;
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
  function resume(item) {
    cancelResume();
    var key = context();
    if (L.Player.opened()) return L.Noty.show('Сначала закройте текущий просмотр');
    var owner = L.Activity && typeof L.Activity.active === 'function' ? L.Activity.active() : null;
    function owned(intent) { return resumeIntent === intent && context() === key && !L.Player.opened() && (!L.Activity || typeof L.Activity.active !== 'function' || L.Activity.active() === owner); }
    if (item.kind === 'online' && item.online) {
      var onlineIntent = resumeIntent = {}, settled = false;
      function unavailable(value) {
        if (!owned(onlineIntent)) return;
        cancelResume();
        var movie = value || card(item), picker = window.HomelabSources;
        if (picker && typeof picker.resume === 'function' && picker.resume(item, movie)) return;
        L.Router.call('full', movie);
      }
      function launchOnline(value) {
        if (settled || !owned(onlineIntent)) return;
        settled = true; clearTimeout(onlineIntent.timer);
        var adapter = window.HomelabOnlineResume, launched = false;
        try { launched = adapter && adapter.resume(item, value || card(item), function () { unavailable(value); }); } catch (_) {}
        if (L.Activity && typeof L.Activity.active === 'function') owner = L.Activity.active();
        if (!launched) unavailable(value);
      }
      if (!window.HomelabOnlineResume) { unavailable(); return; }
      onlineIntent.timer = setTimeout(function () { launchOnline(null); }, 5000);
      L.Api.sources.tmdb.get(item.card.replace('_', '/') + '?append_to_response=external_ids,keywords', {}, function (movie) { launchOnline(fullCard(item, movie)); }, function () { launchOnline(null); });
      return;
    }
    if (!item.torrent) return fallback(item);
    var intent = resumeIntent = {};
    intent.timer = setTimeout(fail, 8000);
    function fail() { if (!owned(intent)) return; cancelResume(); fallback(item); }
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
        L.Player.play(work); L.Player.playlist(playlist);
      }
      var stored = data.data;
      try { if (typeof stored === 'string') stored = JSON.parse(stored); } catch (_) { stored = null; }
      var value = fullCard(item, stored && stored.movie);
      if (value) return launch(value);
      clearTimeout(intent.timer);
      intent.timer = setTimeout(function () { launch(null); }, 2000);
      if (!L.Api.sources || !L.Api.sources.tmdb || typeof L.Api.sources.tmdb.get !== 'function') return launch(null);
      L.Api.sources.tmdb.get(item.card.replace('_', '/') + '?append_to_response=external_ids,keywords', {}, function (movie) { launch(fullCard(item, movie)); }, function () { launch(null); });
    }, fail);
  }
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
      if (context() !== queued.scope) return;
      var newer = items.find(function (item) { return item.card === queued.item.card && item.observed > queued.item.observed; });
      if (!newer) { items = items.filter(function (item) { return item.card !== queued.item.card; }); items.unshift(queued.item); items = items.slice(0, 50); }
      writeError = false;
      readAt = -Infinity;
    }).catch(function (error) {
      if (context() !== queued.scope) return;
      var newer = pending[queued.item.card];
      if (!newer || newer.item.observed < queued.item.observed) {
        queued.attempt++;
        queued.readyAt = error.retryable !== false && queued.attempt <= 3 ? Date.now() + [5000, 15000, 60000][queued.attempt - 1] : Infinity;
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
  function snapshot(state, force) {
    if (playing !== state || context() !== state.scope || (state.data.homelab_resume_at != null && !state.applied)) return;
    var data = state.data, video = L.PlayerVideo.video(), movie = data.card;
    if (!movie || !movie.id || !data.timeline || !video || video.seeking || video.rewind || !(video.duration > 0 && video.duration <= 86400) || !Number.isFinite(video.currentTime)) return;
    var hash = data.homelab_torrent_hash || data.torrent_hash, index = data.homelab_file_index;
    if (index == null && data.torrent_hash) { try { index = Number(new URL(data.url, window.location.href).searchParams.get('index')); } catch (_) {} }
    var online = data.homelab_online;
    if (online && (!window.HomelabOnlineResume || !window.HomelabOnlineResume.valid(online))) return;
    if (!online && (!/^[a-f0-9]{40}$/i.test(hash || '') || !Number.isInteger(index))) return;
    var tv = !!(movie.name || movie.original_name);
    if (tv && !(data.episode > 0)) return;
    var next = {card: (tv ? 'tv_' : 'movie_') + movie.id, title: plain(movie.name || movie.title), poster: movie.poster_path, backdrop: movie.backdrop_path,
      kind: online ? 'online' : 'torrent', online: online ? {provider: online.provider, voice: online.voice, season_index: online.season_index} : null,
      torrent: online ? null : hash.toLowerCase(), index: online ? 0 : index, original: String(movie.original_title || movie.original_name || ''), date: movie.first_air_date || movie.release_date || null, timeline: String(data.timeline.hash), season: data.season || 0, episode: data.episode || 0,
      position: Math.max(0, video.currentTime), duration: video.duration,
      tracks: L.HomelabGstAudio && L.HomelabGstAudio.preferences ? L.HomelabGstAudio.preferences(data) : data.homelab_track_preferences || {}};
    var stamp = JSON.stringify(next);
    if (stamp !== state.stamp) {
      state.stamp = stamp; state.last = Object.assign(next, {observed: Math.max(Date.now(), state.last ? state.last.observed + 1 : 0)});
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
  L.Player.listener.follow('ready', function (data) {
    if (resumeIntent) { clearTimeout(resumeIntent.timer); resumeIntent = null; }
    if (playing) queue(playing);
    playing = {data: data, scope: context(), url: sync.url('/homelab-sync/resume'), saved: -Infinity};
    bindResume(playing);
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
  function ResumeRow() {
    var self = this, bus = L.Subscribe(), html = window.$('<div class="homelab-resume-row"><div class="homelab-resume-title">Продолжить просмотр</div><div class="homelab-resume-sync"></div></div>');
    var scroll = new L.Scroll({horizontal: true, step: 300}), last = null, key = '', stamp = '', destroyed = false, cards = [], byCard = {}, order = '', seasons = {}, seasonScope = sync.scope();
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
      var data = list(), next = JSON.stringify({items: data, warning: writeError || readError});
      if (next === stamp) return; stamp = next;
      var focused = L.Controller.own(self), nextOrder = JSON.stringify(data.map(function (item) { return item.card; })), changedOrder = nextOrder !== order, wanted = {};
      html.find('.homelab-resume-sync').text(writeError || readError ? 'Продолжение не синхронизировано: показаны последние данные' : '');
      data.forEach(function (item) {
        wanted[item.card] = true;
        if (byCard[item.card]) { byCard[item.card].update(item); return; }
        var alive = true, timer = null, loaded = false, displayed = [];
        var native = L.Maker.make('Card', card(item), function (mask) { return mask.only('Card', 'Icons', 'Release', 'Callback'); });
        native.use({onEnter: function () { resume(item); }, onFocus: function (target) {
          key = item.card; last = target; scroll.update(last, true); self.emit('active');
        }, onDestroy: function () { alive = false; clearTimeout(timer); }});
        native.create();
        var tile = native.render().addClass('homelab-resume-card');
        var progress = window.$('<div class="card-watched homelab-resume-progress"><div class="card-watched__inner"><div class="card-watched__body"></div></div></div>');
        function paint(rows) {
          if (!alive || destroyed) return;
          displayed = rows;
          var body = progress.find('.card-watched__body').empty();
          (rows.length ? rows : [null]).forEach(function (episode, index) {
            var line = window.$('<div class="card-watched__item"><span></span></div>');
            line.find('span').text(episode ? episode.episode_number + ' - ' + plain(episode.name || 'Серия ' + episode.episode_number) : item.episode ? 'Сезон ' + item.season + ' · Серия ' + item.episode : 'Продолжить просмотр');
            if (!index) {
              var track = window.$('<div class="homelab-resume-track"><div></div></div>');
              track.find('div').css('width', Math.min(100, item.position / item.duration * 100) + '%'); line.append(track);
            }
            body.append(line);
          });
        }
        paint([]);
        function lookupEpisodes() {
          if (!item.episode || !Number.isInteger(item.season) || item.season < 0 || loaded) return;
          clearTimeout(timer); timer = setTimeout(function () {
            if (!alive || destroyed || !tile.hasClass('focus')) return;
            var scope = sync.scope(), selected = item; loaded = true;
            episodes(selected, function (rows) { if (alive && !destroyed && sync.scope() === scope && selected.season === item.season && selected.episode === item.episode) paint(episodeWindow(item, rows)); });
          }, 500);
        }
        tile.on('hover:focus hover:touch hover:hover', lookupEpisodes);
        tile.find('.card__view').append(progress);
        tile.find('.card__icons-inner').append(window.$('<div class="card__icon icon--history"></div>'));
        byCard[item.card] = {native: native, update: function (value) {
          var previous = card(item), changedEpisode = item.season !== value.season || item.episode !== value.episode;
          item = value;
          var current = card(item);
          if (native.data) Object.assign(native.data, current);
          tile.find('.card__title').text(current.title);
          var year = String(current.release_date || current.first_air_date || '').slice(0, 4), age = tile.find('.card__age');
          if (year && year !== '0000') {
            if (!age.length) { age = window.$('<div class="card__age"></div>'); tile.find('.card__title').after(age); }
            age.text(year);
          } else age.remove();
          if (previous.poster_path !== current.poster_path) {
            // Re-emitting visible leaves an old native image timeout armed.
            // Keep the loader's existing handlers and update only its source.
            tile.find('.card__img').attr('src', typeof native.getPosterPath === 'function' ? native.getPosterPath() : current.poster_path ? L.Api.img(current.poster_path) : './img/img_broken.svg');
          }
          if (changedEpisode) { clearTimeout(timer); loaded = false; displayed = []; }
          paint(displayed);
          if (changedEpisode && tile.hasClass('focus')) lookupEpisodes();
        }};
      });
      Object.keys(byCard).forEach(function (card) { if (!wanted[card]) { byCard[card].native.destroy(); delete byCard[card]; } });
      cards = data.map(function (item) { return byCard[item.card].native; });
      if (changedOrder) {
        order = nextOrder; scroll.clear();
        if (!cards.length) scroll.append(window.$('<div class="homelab-resume-empty selector">Здесь появятся незавершённые просмотры</div>'));
        cards.forEach(function (native) { scroll.append(native.render(true)); });
        last = byCard[key] ? byCard[key].native.render(true) : cards.length ? cards[0].render(true) : null;
      }
      L.Layer.visible(scroll.render(true));
      if (focused && changedOrder) { L.Controller.collectionSet(scroll.render(true)); L.Controller.collectionFocus(last || false, scroll.render(true)); }
    }
    this.create = function () { rowCount++; scroll.body().addClass('homelab-resume-items mapping--line'); html.append(scroll.render()); listeners.push(draw); draw(); };
    this.render = function (js) { return js ? html[0] : html; };
    function move(step) {
      var tiles = scroll.render(true).querySelectorAll('.selector'), index = Array.prototype.indexOf.call(tiles, last), next = index + step;
      if (next >= 0 && next < tiles.length) L.Controller.collectionFocus(tiles[next], scroll.render(true));
      else if (step < 0) self.emit('left');
    }
    this.toggle = function () {
      L.Controller.add('homelab_resume', {link: self, toggle: function () {
        L.Controller.collectionSet(scroll.render(true)); L.Controller.collectionFocus(last || false, scroll.render(true)); self.emit('toggle'); self.emit('active');
      }, right: function () { move(1); },
      left: function () { move(-1); },
      up: function () { self.emit('up'); }, down: function () { self.emit('down'); }, back: function () { self.emit('back'); }});
      L.Controller.toggle('homelab_resume');
    };
    this.destroy = function () { destroyed = true; rowCount--; listeners = listeners.filter(function (fn) { return fn !== draw; }); clearCards(); clearSeasons(); scroll.destroy(); html.remove(); self.emit('destroy'); };
  }
  window.$('head').append(window.$('<style></style>').text('.homelab-resume-row{padding:1em 0}.homelab-resume-items{display:flex;align-items:stretch}.homelab-resume-title{white-space:normal;font-size:1.8em;margin:0 .6em .8em}.homelab-resume-card{flex-shrink:0}.homelab-resume-card .card__title{line-height:1.3;height:2.6em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}.homelab-resume-progress .card-watched__inner{padding:.7em}.homelab-resume-track{height:.18em;background:rgba(255,255,255,.25);margin-top:.5em;border-radius:1em;overflow:hidden}.homelab-resume-track div{height:100%;background:#fff}.homelab-resume-empty{padding:1em;opacity:.7}'));
  L.ContentRows.add({name: 'homelab_continue', title: 'Продолжить просмотр', index: 0, screen: ['main'],
    call: function () { return function (resolve) { sync.pull(function () { load(function () { resolve({title: 'Продолжить просмотр', results: [{}], params: {createInstance: function () { return new ResumeRow(); }}}); }); }); }; }});
  window.homelabContinue = {list: list, resume: resume, load: load, subscribe: function (fn) { listeners.push(fn); }};
  // Plugins may finish loading after Main has already collected its rows.
  setTimeout(function () {
    var active = L.Activity && typeof L.Activity.active === 'function' ? L.Activity.active() : null;
    if (!rowCount && active && active.component === 'main' && typeof L.Activity.refresh === 'function' && !L.Player.opened() && (!L.Modal || !L.Modal.opened()) && (!L.Select || !L.Select.opened || !L.Select.opened())) L.Activity.refresh();
  }, 1000);
})();
