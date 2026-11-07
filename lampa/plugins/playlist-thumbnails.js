(function install() {
  'use strict';
  if (!window.appready) {
    if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
    return;
  }
  var L = window.Lampa, sync = window.HomelabSync;
  if (window.homelabPlaylistThumbnails || !L || !sync || !L.PlayerPlaylist || !L.PlayerPlaylist.listener || !L.Player || !L.Player.listener || !L.Api) return;
  if (![L.PlayerPlaylist.listener.follow, L.PlayerPlaylist.get, L.PlayerPlaylist.position, L.Player.listener.follow, L.Player.playlist, L.Player.playdata, L.Player.opened, L.Api.seasons, L.Api.img, sync.scope].every(function (fn) { return typeof fn === 'function'; })) return;
  var cache = {}, cacheScope = sync.scope(), generation = 0, paint, ready;
  function usable(value) { return typeof value === 'string' && !!value.trim() && !/(?:\/w\d+)?(?:null|undefined)(?:[?#].*)?$/i.test(value); }
  function image(path) { return typeof path === 'string' && /^\/[^/]/.test(path) && usable(path) ? L.Api.img(path, 'w300') : ''; }
  function live(playlist, scope, epoch) { return epoch === generation && sync.scope() === scope && L.Player.opened() && L.PlayerPlaylist.get() === playlist; }
  function repaint(playlist, scope, epoch) {
    clearTimeout(paint);
    paint = setTimeout(function () { if (live(playlist, scope, epoch)) L.Player.playlist(playlist); }, 0);
  }
  function clear() {
    generation++; clearTimeout(paint); clearTimeout(ready);
    Object.keys(cache).forEach(function (key) { clearTimeout(cache[key].timer); }); cache = {}; cacheScope = sync.scope();
  }
  function season(card, number, done) {
    var key = (card.source || 'tmdb') + ':' + card.id + ':' + number, job = cache[key];
    if (job) { if (job.value) done(job.value); else job.waiters.push(done); return; }
    if (Object.keys(cache).length >= 32) {
      var oldest = Object.keys(cache).find(function (name) { return cache[name].value; }); if (oldest) delete cache[oldest];
    }
    job = cache[key] = {waiters: [done]};
    function complete(value) {
      if (cache[key] !== job || job.value) return;
      clearTimeout(job.timer); job.value = value;
      job.waiters.splice(0).forEach(function (callback) { callback(value); });
    }
    job.timer = setTimeout(function () { complete({}); }, 5000);
    try { L.Api.seasons(card, [number], function (data) { complete(data && data[number] || {}); }); } catch (_) { complete({}); }
  }
  function decorate(event) {
    if (!L.Player.opened()) return;
    if (cacheScope !== sync.scope()) clear();
    var playlist = event.playlist, scope = cacheScope, epoch = generation;
    if (!Array.isArray(playlist) || L.PlayerPlaylist.get() !== playlist) return;
    var item = playlist[event.position + 1], work = L.Player.playdata();
    if (!item || usable(item.thumbnail) || !(item.season > 0 && item.episode > 0)) return;
    var card = item.card || work && work.card;
    if (!card || !Number.isInteger(card.id)) return;
    var fallback = image(card.backdrop_path) || (usable(card.background_image) ? card.background_image : '') || image(card.poster_path) || (usable(card.img) ? card.img : '');
    if (fallback) { item.thumbnail = fallback; repaint(playlist, scope, epoch); }
    season(card, item.season, function (data) {
      if (!live(playlist, scope, epoch)) return;
      var episode = (data.episodes || []).find(function (value) { return +value.episode_number === +item.episode; });
      var thumbnail = episode && image(episode.still_path);
      if (thumbnail && item.thumbnail !== thumbnail) { item.thumbnail = thumbnail; repaint(playlist, scope, epoch); }
    });
  }
  L.PlayerPlaylist.listener.follow('set', decorate);
  L.Player.listener.follow('ready', function () {
    clearTimeout(ready); ready = setTimeout(function () { decorate({playlist: L.PlayerPlaylist.get(), position: L.PlayerPlaylist.position()}); }, 0);
  });
  L.Player.listener.follow('destroy', clear);
  window.homelabPlaylistThumbnails = true;
})();
