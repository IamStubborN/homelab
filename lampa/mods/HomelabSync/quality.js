(function install() {
  'use strict';
  if (!window.appready) {
    if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
    return;
  }
  // Sources often name a quality their stream does not have (a "4K" row that plays 720p). This keeps,
  // on the server and for every device, the height a manifest probe or a playback really showed for
  // a provider's voice on a title, and how often each provider claims more than it delivers.
  var L = window.Lampa, sync = window.HomelabSync;
  if (window.HomelabQuality || !L || !sync || !window.fetch || typeof Promise !== 'function') return;
  var HEIGHTS = [360, 480, 576, 720, 1080, 1440, 2160], cache = {}, TTL = 5 * 60000;
  function height(label) {
    var text = String(label || '');
    if (/\b(4k|uhd)\b/i.test(text)) return 2160;
    var match = /(?:^|\D)(2160|1440|1080|720|576|480|360)(?:p|i|\D|$)/i.exec(text);
    return match ? +match[1] : 0;
  }
  // Width first: cinema crops (1920x800) still count as 1080p.
  function standard(width, height) {
    var steps = [[3800, 2160], [2500, 1440], [1800, 1080], [1200, 720], [1000, 576], [800, 480]];
    for (var i = 0; i < steps.length; i++) if (width >= steps[i][0] || height >= steps[i][1] * 0.9) return steps[i][1];
    return width || height ? 360 : 0;
  }
  function name(value) { return value === 2160 ? '4K' : value ? value + 'p' : ''; }
  function cardOf(movie) {
    if (!movie || !Number.isInteger(movie.id) || movie.id <= 0 || ['tmdb', 'cub'].indexOf(String(movie.source || 'tmdb')) < 0) return '';
    return (movie.name || movie.original_name ? 'tv_' : 'movie_') + movie.id;
  }
  function key(provider, season, voice) { return String(provider || '').toLowerCase() + '|' + (season || 0) + '|' + String(voice || '').trim().toLowerCase(); }
  function load(movie) {
    var card = cardOf(movie), url = card && sync.url('/homelab-sync/quality');
    if (!url) return Promise.resolve(null);
    var scope = sync.scope(), entry = cache[card];
    if (entry && entry.scope === scope && Date.now() - entry.at < TTL) return entry.promise;
    var promise = fetch(url + '&card=' + encodeURIComponent(card), {cache: 'no-store'}).then(function (response) {
      if (!response.ok) throw new Error('quality'); return response.json();
    }).then(function (data) {
      if (!data || data.version !== 1 || typeof data.rows !== 'object' || typeof data.providers !== 'object') throw new Error('contract');
      return data;
    }).catch(function () { if (cache[card] && cache[card].promise === promise) delete cache[card]; return null; });
    cache[card] = {scope: scope, at: Date.now(), promise: promise};
    return promise;
  }
  // A provider claims more than it delivers on at least a third of at least three checked rows.
  function doubtful(data, provider) {
    var stats = data && data.providers && data.providers[String(provider || '').toLowerCase()];
    return !!stats && (stats.total || 0) >= 3 && (stats.inflated || 0) * 3 >= stats.total;
  }
  function fact(data, provider, season, voice) {
    var row = data && data.rows && data.rows[key(provider, season, voice)];
    return row && HEIGHTS.indexOf(row.height) >= 0 ? row : null;
  }
  function report(movie, provider, season, voice, claimed, measured, source) {
    var card = cardOf(movie), url = card && sync.url('/homelab-sync/quality');
    if (!url || HEIGHTS.indexOf(measured) < 0 || typeof voice !== 'string' || voice.length > 200 || !/^[a-z0-9_.-]{1,80}$/i.test(provider || '')) return;
    var body = {card: card, provider: provider, season: season || 0, voice: voice, claimed: HEIGHTS.indexOf(claimed) >= 0 ? claimed : 0, measured: measured, source: source};
    // The next read asks the server again and sees this observation.
    delete cache[card];
    fetch(url, {method: 'POST', cache: 'no-store', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}).catch(function () {});
  }
  // Native online rows: the voice a row plays under, as the resume identity names it.
  function rowVoice(movie, file, choice) {
    if (movie && !movie.name) { var text = String(file && (file.translate || file.text) || '').trim(); if (text) return text.slice(0, 200); }
    return String(file && file.voice_name || choice && choice.voice_name || '');
  }
  function decorate(movie, provider, choice, file, html) {
    if (!html || typeof html.find !== 'function' || !file) return;
    var season = movie && movie.name ? file.season : 0;
    load(movie).then(function (data) {
      var known = fact(data, provider, season, rowVoice(movie, file, choice)), badge = html.find('.online-prestige__quality');
      if (!known || !badge.length) return;
      var claimed = Math.max(known.claimed || 0, height(badge.text()));
      badge.text(name(known.height) + (claimed > known.height ? ' · заявлено ' + name(claimed) : ' ✓'))
        .attr('title', known.source === 'play' ? 'Качество по просмотру' : 'Качество проверено по потоку');
    });
  }
  // Playback: the largest decoded picture over 90 s of actual play, for the top quality the source
  // offered (a lower quality the user picked says nothing about the source).
  var PLAYED = 90000, STEP = 5000, watch = null;
  function selected(work) {
    var map = work.quality && typeof work.quality === 'object' ? work.quality : null, labels = map ? Object.keys(map) : [];
    if (!labels.length) return {top: true, claimed: 0};
    var top = labels.reduce(function (best, label) { return height(label) > height(best) ? label : best; }, labels[0]);
    var url = typeof work.url === 'string' ? work.url : '';
    var current = labels.filter(function (label) { return map[label] === url; })[0];
    // A url that matches no entry (a proxy, a switch inside the player) may be any quality.
    return {top: labels.length === 1 || !!current && height(current) >= height(top), claimed: height(top)};
  }
  function tick(state) {
    if (watch !== state) return;
    state.timer = setTimeout(function () { tick(state); }, STEP);
    if (!L.Player.opened() || L.Player.playdata() !== state.work) return stop(state);
    var video = L.PlayerVideo && typeof L.PlayerVideo.video === 'function' ? L.PlayerVideo.video() : null;
    if (!video || video.paused || !(video.videoHeight > 0)) return;
    state.played += STEP; state.best = Math.max(state.best, standard(video.videoWidth, video.videoHeight));
    if (state.played >= PLAYED && state.best > state.sent) {
      var pick = selected(state.work);
      if (!pick.top) return;
      state.sent = state.best;
      report(state.work.card, state.online.provider, state.season, state.voice, pick.claimed, state.best, 'play');
    }
  }
  function stop(state) { if (state && watch === state) { clearTimeout(state.timer); watch = null; } }
  L.Player.listener.follow('start', function (work) {
    stop(watch);
    var online = work && work.homelab_online, movie = work && work.card;
    if (!online || !cardOf(movie) || !L.PlayerVideo) return;
    var voice = movie.name ? online.voice : online.text || online.voice;
    watch = {work: work, online: online, voice: String(voice || ''), season: movie.name ? work.season || 0 : 0, played: 0, best: 0, sent: 0};
    var state = watch; state.timer = setTimeout(function () { tick(state); }, STEP);
  });
  L.Player.listener.follow('destroy', function () { stop(watch); });
  window.HomelabQuality = {load: load, fact: fact, doubtful: doubtful, report: report, decorate: decorate, key: key};
})();
