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
