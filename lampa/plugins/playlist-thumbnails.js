(function install() {
  'use strict';
  if (!window.appready) {
    if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
    return;
  }
  var L = window.Lampa, sync = window.HomelabSync;
  if (window.homelabPlaylistThumbnails || !L || !sync || !L.PlayerPlaylist || !L.PlayerPlaylist.listener || !L.Player || !L.Player.listener || !L.Api) return;
  if (![L.PlayerPlaylist.listener.follow, L.PlayerPlaylist.get, L.PlayerPlaylist.position, L.Player.listener.follow, L.Player.playlist, L.Player.playdata, L.Player.opened, L.Api.seasons, L.Api.img, sync.scope].every(function (fn) { return typeof fn === 'function'; })) return;
  // A still that arrives within FALLBACK_DELAY is painted directly (one native re-render, no backdrop flash).
  // LOOKUP_TIMEOUT is a safety net above Lampa's own 10 s TMDB request timeout; a still that still arrives later is applied.
  // Season maps expire (airing shows gain stills); misses retry sooner. Waiters per pending lookup are capped.
  var FALLBACK_DELAY = 1500, LOOKUP_TIMEOUT = 15000, MISS_TTL = 5 * 60 * 1000, HIT_TTL = 6 * 60 * 60 * 1000, LIMIT = 32, WAITERS = 8;
  var cache = {}, uses = 0, cacheScope = sync.scope(), generation = 0, paint, ready, delay;
  function usable(value) { return typeof value === 'string' && !!value.trim() && !/(?:\/w\d+)?(?:null|undefined)(?:[?#].*)?$/i.test(value); }
  function image(path) { return typeof path === 'string' && /^\/[^/]/.test(path) && usable(path) ? L.Api.img(path, 'w300') : ''; }
  function live(playlist, scope, epoch) { return epoch === generation && sync.scope() === scope && L.Player.opened() && L.PlayerPlaylist.get() === playlist; }
  function repaint(playlist, scope, epoch) {
    clearTimeout(paint);
    paint = setTimeout(function () { if (live(playlist, scope, epoch)) L.Player.playlist(playlist); }, 0);
  }
  // Invalidates callbacks of the current playback; the metadata cache survives episode switches.
  function reset() { generation++; clearTimeout(paint); clearTimeout(ready); clearTimeout(delay); }
  function forget() {
    Object.keys(cache).forEach(function (key) { clearTimeout(cache[key].timer); });
    cache = {}; cacheScope = sync.scope();
  }
  function tmdbId(card) {
    var source = card.source || 'tmdb', id = source === 'tmdb' || source === 'cub' ? card.id : card.tmdb_id;
    return typeof id === 'number' && id > 0 && id % 1 === 0 ? id : 0;
  }
  function evict() {
    var keys = Object.keys(cache).filter(function (key) { return cache[key].value; });
    if (Object.keys(cache).length < LIMIT || !keys.length) return;
    keys.sort(function (a, b) { return cache[a].used - cache[b].used; });
    clearTimeout(cache[keys[0]].timer); delete cache[keys[0]];
  }
  // Calls done with {episodeNumber: still_path}. A timed-out lookup reports {} but keeps its
  // waiters, so a still that arrives later is still delivered.
  function wait(job, done, epoch) {
    // Waiters of an earlier playback can never paint again; drop them and keep only the newest few.
    job.waiters = job.waiters.filter(function (waiter) { return waiter.epoch === epoch; }).slice(1 - WAITERS);
    job.waiters.push({done: done, epoch: epoch});
  }
  function stills(id, number, done, epoch) {
    var key = id + ':' + number, job = cache[key];
    if (job && job.expires < Date.now()) { clearTimeout(job.timer); delete cache[key]; job = null; }
    if (job) {
      job.used = ++uses;
      if (!job.value || job.timedOut) wait(job, done, epoch);
      if (job.value) done(job.value);
      return;
    }
    evict();
    job = cache[key] = {waiters: [], used: ++uses, expires: Infinity};
    wait(job, done, epoch);
    job.timer = setTimeout(function () {
      if (cache[key] !== job || job.value) return;
      job.value = {}; job.timedOut = true; job.expires = Date.now() + MISS_TTL;
      job.waiters.slice().forEach(function (waiter) { waiter.done(job.value); });
    }, LOOKUP_TIMEOUT);
    function complete(map, found) {
      if (cache[key] !== job || (job.value && !job.timedOut)) return;
      clearTimeout(job.timer);
      job.value = map; job.timedOut = false; job.expires = Date.now() + (found ? HIT_TTL : MISS_TTL);
      job.waiters.splice(0).forEach(function (waiter) { waiter.done(map); });
    }
    try {
      L.Api.seasons({id: id, source: 'tmdb'}, [number], function (data) {
        var season = data && data[number], map = {}, found = false;
        ((season && season.episodes) || []).forEach(function (episode) {
          var episodeNumber = episode && +episode.episode_number;
          if (episodeNumber > 0 && image(episode.still_path)) { map[episodeNumber] = episode.still_path; found = true; }
        });
        complete(map, found);
      });
    } catch (_) { complete({}, false); }
  }
  function cardOf(item, work) { return item.card && typeof item.card === 'object' ? item.card : work && work.card; }
  // Writes known stills into every item of that season, replacing missing thumbnails and earlier
  // backdrop fallbacks, so later native sets already draw the right image. Returns changed items.
  function fill(playlist, id, number, map, work) {
    var changed = [];
    playlist.forEach(function (entry) {
      var card = entry && +entry.season === +number && cardOf(entry, work), url;
      if (!card || typeof card !== 'object' || tmdbId(card) !== id) return;
      if (usable(entry.thumbnail) && entry.homelab_thumbnail !== 'fallback') return;
      url = image(map[+entry.episode]);
      if (!url || entry.thumbnail === url) return;
      entry.thumbnail = url; entry.homelab_thumbnail = 'still'; changed.push(entry);
    });
    return changed;
  }
  function decorate(event) {
    if (!L.Player.opened()) return;
    if (cacheScope !== sync.scope()) { reset(); forget(); }
    var playlist = event.playlist, scope = cacheScope, epoch = generation;
    if (!Array.isArray(playlist) || L.PlayerPlaylist.get() !== playlist) return;
    var item = playlist[event.position + 1], work = L.Player.playdata();
    // On the last episode there is no Next card; stills still serve the list.
    if (!item) return listStills(playlist, playlist[event.position], work, scope, epoch);
    if ( (usable(item.thumbnail) && item.homelab_thumbnail !== 'fallback') || !(item.season > 0 && item.episode > 0)) return;
    var card = cardOf(item, work);
    if (!card || typeof card !== 'object') return;
    var id = tmdbId(card), resolved = false, timer;
    function fallback() {
      if (!live(playlist, scope, epoch) || item.homelab_thumbnail) return;
      var url = image(card.backdrop_path) || (usable(card.background_image) ? card.background_image : '') || image(card.poster_path) || (usable(card.img) ? card.img : '');
      if (!url) return;
      item.thumbnail = url; item.homelab_thumbnail = 'fallback';
      repaint(playlist, scope, epoch);
    }
    if (!id) return fallback();
    stills(id, item.season, function (map) {
      resolved = true;
      if (!live(playlist, scope, epoch)) return;
      var changed = fill(playlist, id, item.season, map, work);
      if (item.homelab_thumbnail !== 'still') return fallback();
      clearTimeout(timer);
      if (changed.indexOf(item) >= 0) repaint(playlist, scope, epoch);
    }, epoch);
    if (!resolved) timer = delay = setTimeout(fallback, FALLBACK_DELAY);
  }
  function listStills(playlist, item, work, scope, epoch) {
    var card = item && item.season > 0 && cardOf(item, work), id = card && typeof card === 'object' ? tmdbId(card) : 0;
    if (!id || playlist.every(function (entry) { return !entry || +entry.season !== +item.season || usable(entry.thumbnail); })) return;
    stills(id, item.season, function (map) {
      if (live(playlist, scope, epoch) && fill(playlist, id, item.season, map, work).length) repaint(playlist, scope, epoch);
    }, epoch);
  }
  // The native playlist is a Select of the playlist items. Each row gets its
  // saved progress (live for the current one), a watched mark and «Сейчас».
  function remaining(position, duration) {
    var rest = Math.max(0, duration - position), minutes = Math.round(rest / 60);
    if (rest < 60) return 'осталось меньше минуты';
    if (minutes < 60) return 'осталось ' + minutes + ' мин';
    return 'осталось ' + Math.floor(minutes / 60) + ' ч' + (minutes % 60 ? ' ' + minutes % 60 + ' мин' : '');
  }
  function progress(entry) {
    var road = entry.timeline && typeof entry.timeline === 'object' ? entry.timeline : {}, video, time = +road.time || 0, duration = +road.duration || 0;
    if (entry.selected && L.PlayerVideo && typeof L.PlayerVideo.video === 'function') {
      video = L.PlayerVideo.video();
      if (video && video.duration > 0 && isFinite(video.currentTime)) { time = video.currentTime; duration = video.duration; }
    }
    var percent = duration > 0 ? time / duration * 100 : +road.percent || 0;
    return {percent: Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10, time: time, duration: duration};
  }
  function mark(row, entry) {
    if (!row || typeof row.find !== 'function' || !entry || typeof entry !== 'object') return;
    var $ = window.$, state = progress(entry), current = !!entry.selected, done = !current && state.percent >= 90;
    var title = row.find('.selectbox-item__title'), icon = row.find('.selectbox-item__icon'), host = entry.thumbnail && icon.length ? icon : null;
    row.addClass('homelab-playlist-item');
    if (current) row.addClass('homelab-playlist-item--current');
    if (done) row.addClass('homelab-playlist-item--watched');
    var text = current ? (state.duration > 0 ? remaining(state.time, state.duration) : '') : done ? 'Просмотрено' : state.percent > 1 ? (state.duration > 0 ? remaining(state.time, state.duration) : Math.round(state.percent) + '%') : '';
    var line = $('<div class="homelab-playlist-state"></div>');
    if (current) line.append($('<span class="homelab-playlist-now"></span>').text('Сейчас'));
    if (text) line.append($('<span></span>').text(current ? (text ? ' ' + text : '') : text));
    if (current || text) title.after(line);
    if (current || !done && state.percent > 1) {
      var bar = $('<div class="homelab-playlist-bar"><div></div></div>');
      bar.find('div').css('width', state.percent + '%');
      if (host) host.append(bar); else line.after(bar);
    }
    if (done && host) host.append($('<div class="homelab-playlist-done"></div>'));
  }
  if (window.$ && typeof window.$ === 'function') {
    window.$('head').append(window.$('<style></style>').text(
      '.homelab-playlist-item .selectbox-item__icon{position:relative}' +
      '.homelab-playlist-item .selectbox-item__icon>img.size-youtube{border-radius:.4em}' +
      '.homelab-playlist-item.homelab-playlist-item--current.selected::after{display:none}' +
      '.homelab-playlist-item.selected:not(.nomark){padding-right:2em}' +
      '.homelab-playlist-item--watched .selectbox-item__title{opacity:.6}' +
      '.homelab-playlist-state{font-size:1em;margin-top:.35em;opacity:.75}' +
      '.homelab-playlist-now{display:inline-block;padding:.1em .5em;border-radius:.3em;background:#fff;color:#000;font-size:.85em;margin-right:.3em}' +
      '.homelab-playlist-item.focus .homelab-playlist-now{background:#000;color:#fff}' +
      '.homelab-playlist-bar{height:.25em;margin-top:.5em;border-radius:1em;background:rgba(255,255,255,.3);overflow:hidden}' +
      '.selectbox-item__icon .homelab-playlist-bar{position:absolute;left:.35em;right:.35em;bottom:.35em;margin:0;width:auto;height:.25em}' +
      '.homelab-playlist-bar div{height:100%;background:#fff;border-radius:1em}' +
      '.homelab-playlist-done{position:absolute;top:.3em;right:.3em;width:1.3em;height:1.3em;border-radius:50%;background:rgba(0,0,0,.65)}' +
      '.homelab-playlist-done:after{content:"";position:absolute;left:.47em;top:.25em;width:.3em;height:.6em;border-right:.15em solid #fff;border-bottom:.15em solid #fff;-webkit-transform:rotate(45deg);transform:rotate(45deg)}'
    ));
  }
  if (L.Select && L.Select.listener && typeof L.Select.listener.follow === 'function') L.Select.listener.follow('preshow', function (event) {
    var active = event && event.active;
    if (!active || active.homelab_playlist || !L.Player.opened() || !Array.isArray(active.items) || active.items !== L.PlayerPlaylist.get()) return;
    var native = active.onDraw, index = currentIndex(active.items, L.Player.playdata());
    // The Select focuses the selected row: make it the playing episode.
    if (index >= 0 && !active.items[index].selected) active.items.forEach(function (entry, i) { if (entry) entry.selected = i === index; });
    active.homelab_playlist = true;
    active.onDraw = function (row, entry) {
      try { mark(row, entry); } catch (_) {}
      if (typeof native === 'function') return native.apply(this, arguments);
    };
  });
  // Lampa scrolls to the selected row in toggle() and sets the window height only afterwards, in
  // Layer.update(): on the first opening the window had no height yet, the scroll was clamped to
  // the top and the list opened on episode 1. Size the window before that scroll.
  if (L.Select && L.Select.listener && typeof L.Select.listener.follow === 'function') L.Select.listener.follow('fullshow', function (event) {
    if (event && event.active && event.active.homelab_playlist && event.html && L.Layer && typeof L.Layer.update === 'function') {
      try { L.Layer.update(event.html); } catch (_) {}
    }
  });
  // Lampa finds the playing item by URL, then by season and episode. Lampac starts an episode
  // with its chosen quality URL and some providers carry no numbers, so undefined == undefined
  // picked the first item: the playlist opened on episode 1 and Next pointed to episode 2.
  function sameNumber(a, b) { return a !== undefined && a !== null && a !== '' && +a === +b; }
  function currentIndex(list, work) {
    if (!work) return -1;
    var urls = [work.url, work.homelab_source_url].filter(function (url) { return typeof url === 'string' && url; });
    if (work.quality && typeof work.quality === 'object') Object.keys(work.quality).forEach(function (key) {
      var value = work.quality[key]; if (typeof value === 'string' && value) urls.push(value); else if (value && typeof value.url === 'string') urls.push(value.url);
    });
    function numbered(entry) { return sameNumber(entry.episode, work.episode) && sameNumber(entry.season, work.season); }
    var hasNumbers = sameNumber(work.episode, work.episode) && sameNumber(work.season, work.season);
    var byUrl = list.filter(function (entry) { return entry && typeof entry.url === 'string' && urls.indexOf(entry.url) >= 0 && (!hasNumbers || !sameNumber(entry.episode, entry.episode) || numbered(entry)); });
    if (byUrl.length === 1) return list.indexOf(byUrl[0]);
    var byNumber = hasNumbers ? list.filter(function (entry) { return entry && numbered(entry); }) : [];
    if (byNumber.length === 1) return list.indexOf(byNumber[0]);
    var title = typeof work.title === 'string' && work.title ? work.title : '', byTitle = title ? list.filter(function (entry) { return entry && entry.title === title; }) : [];
    return byTitle.length === 1 ? list.indexOf(byTitle[0]) : -1;
  }
  var correcting = false;
  function locate(event) {
    if (correcting || !L.Player.opened() || typeof L.PlayerPlaylist.url !== 'function' || typeof L.PlayerPlaylist.set !== 'function') return false;
    var list = event && event.playlist;
    if (!Array.isArray(list) || L.PlayerPlaylist.get() !== list) return false;
    var index = currentIndex(list, L.Player.playdata()), entry = list[index];
    if (index < 0 || index === event.position || typeof entry.url !== 'string' || !entry.url) return false;
    // Lampa matches by URL first: a duplicated URL could not hold the corrected position.
    if (list.some(function (other) { return other !== entry && other && other.url === entry.url; })) return false;
    // Point Lampa at the playing item and announce the list again: the Next card, Prev/Next
    // and the playlist's focus all follow the corrected position.
    correcting = true;
    try { L.PlayerPlaylist.url(entry.url); L.PlayerPlaylist.set(list); } finally { correcting = false; }
    return true;
  }
  // The Next card already says «Следующая серия»; the episode number prefix only repeats it.
  function plainNext() {
    var title = L.PlayerPanel && typeof L.PlayerPanel.render === 'function' ? L.PlayerPanel.render().find('.player-next__episode-title') : window.$('.player-next__episode-title');
    if (!title || !title.length) return;
    for (var i = 0; i < title.length; i++) {
      var node = window.$(title[i]), text = String(node.text() || ''), plain = text.replace(/^(?:Серия|Спецвыпуск) \d+ · /, '');
      if (plain !== text) node.text(plain);
    }
  }
  L.PlayerPlaylist.listener.follow('set', function (event) {
    if (locate(event)) return;
    try { plainNext(); } catch (_) {}
    decorate(event);
  });
  L.Player.listener.follow('ready', function () {
    // The first set of a playback happens before the player is opened; correct the position here.
    clearTimeout(ready); ready = setTimeout(function () {
      var event = {playlist: L.PlayerPlaylist.get(), position: L.PlayerPlaylist.position()};
      if (!locate(event)) { try { plainNext(); } catch (_) {} decorate(event); }
    }, 0);
  });
  L.Player.listener.follow('destroy', reset);
  window.homelabPlaylistThumbnails = true;
})();
