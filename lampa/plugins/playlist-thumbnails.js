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
  var FALLBACK_DELAY = 1500, LOOKUP_TIMEOUT = 15000, MISS_TTL = 5 * 60 * 1000, LIMIT = 32;
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
  function stills(id, number, done) {
    var key = id + ':' + number, job = cache[key];
    if (job && job.expires && job.expires < Date.now()) { clearTimeout(job.timer); delete cache[key]; job = null; }
    if (job) {
      job.used = ++uses;
      if (!job.value || job.timedOut) job.waiters.push(done);
      if (job.value) done(job.value);
      return;
    }
    evict();
    job = cache[key] = {waiters: [done], used: ++uses};
    job.timer = setTimeout(function () {
      if (cache[key] !== job || job.value) return;
      job.value = {}; job.timedOut = true; job.expires = Date.now() + MISS_TTL;
      job.waiters.slice().forEach(function (callback) { callback(job.value); });
    }, LOOKUP_TIMEOUT);
    function complete(map, found) {
      if (cache[key] !== job || (job.value && !job.timedOut)) return;
      clearTimeout(job.timer);
      job.value = map; job.timedOut = false; job.expires = found ? 0 : Date.now() + MISS_TTL;
      job.waiters.splice(0).forEach(function (callback) { callback(map); });
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
  function decorate(event) {
    if (!L.Player.opened()) return;
    if (cacheScope !== sync.scope()) { reset(); forget(); }
    var playlist = event.playlist, scope = cacheScope, epoch = generation;
    if (!Array.isArray(playlist) || L.PlayerPlaylist.get() !== playlist) return;
    var item = playlist[event.position + 1], work = L.Player.playdata();
    if (!item || (usable(item.thumbnail) && item.homelab_thumbnail !== 'fallback') || !(item.season > 0 && item.episode > 0)) return;
    var card = item.card && typeof item.card === 'object' ? item.card : work && work.card;
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
      var url = image(map[+item.episode]);
      if (!url) return fallback();
      clearTimeout(timer);
      if (item.thumbnail === url) return;
      item.thumbnail = url; item.homelab_thumbnail = 'still';
      repaint(playlist, scope, epoch);
    });
    if (!resolved) timer = delay = setTimeout(fallback, FALLBACK_DELAY);
  }
  L.PlayerPlaylist.listener.follow('set', decorate);
  L.Player.listener.follow('ready', function () {
    clearTimeout(ready); ready = setTimeout(function () { decorate({playlist: L.PlayerPlaylist.get(), position: L.PlayerPlaylist.position()}); }, 0);
  });
  L.Player.listener.follow('destroy', reset);
  window.homelabPlaylistThumbnails = true;
})();
