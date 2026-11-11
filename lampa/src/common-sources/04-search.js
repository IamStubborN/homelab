  // ── Search: the catalog walk across providers (one closure, continued in 05 and 06) ──
  var UNNAMED = 'Без названия', SEARCH_TTL = 10 * 60000, searchCache = {keys: [], values: {}};
  // One search per profile, title, episode and torrent lane: the cache and a prefetched search share it.
  function searchKey(movie, selection, torrents) { return [sync.scope(), movie.name ? 'tv' : 'movie', movie.id, selection.season, selection.episode, torrents === false ? 0 : 1].join('|'); }
  function Search(movie, selection, changed, options) {
    movie = movieCard(movie); options = options || {};
    function titleLike(text) {
      var value = normalized(text);
      if (!value || ITEM_TAG.test(String(text).trim()) || /(?:^|\s)(?:19|20)\d\d(?:\s|$)/.test(value) || /(?:^|\s)(?:4k|4к|uhd|hdr|2160p?|1080p?|720p?|web ?dl|webrip|bdrip|hdrip)(?:\s|$)/.test(value)) return true;
      return [movie.title, movie.original_title, movie.name, movie.original_name].some(function (name) {
        var known = normalized(name); return known.length >= 3 && (value === known || value.indexOf(known + ' ') === 0);
      });
    }
    // Two lanes: first pages of every provider go before alternate-voice pages, so all providers show up early.
    var self = this, scope = sync.scope(), alive = true, queue = [], voiceQueue = [], requests = [], timers = [], running = 0, discovered = {}, seenRows = {}, visited = {}, voicesSeen = {};
    var sourceCount = {}, deadline = Date.now() + 60000, pollUntil = 0, parserTimer, parserPending = false, started = false;
    var pendingBy = {}, runningBy = {}, finishedAt = 0;
    this.rows = []; this.onlinePending = true; this.torrentPending = false; this.errors = []; this.interrupted = false; this.providers = {total: 0, done: 0};
    this.checking = function () { return alive ? probeQueue.length + probing : 0; };
    function live() { return alive && sync.scope() === scope; }
    var cacheKey = searchKey(movie, selection, options.torrents);
    this.key = cacheKey;
    this.alive = function () { return live(); };
    // A search prefetched from the title card reports to the screen that adopts it.
    this.follow = function (fn) { changed = fn; };
    // A finished, uninterrupted search is kept for ten minutes; reopening the picker shows it at once.
    function remember() {
      if (self.cachedAt || !started || self.onlinePending || self.torrentPending || self.interrupted || self.errors.length || !alive) return;
      if (searchCache.keys.indexOf(cacheKey) < 0) { searchCache.keys.push(cacheKey); if (searchCache.keys.length > 20) delete searchCache.values[searchCache.keys.shift()]; }
      // The age counts from the end of the search; later quality checks only refresh the rows.
      var at = finishedAt || (finishedAt = Date.now());
      searchCache.values[cacheKey] = {at: at, rows: self.rows.slice(), errors: []};
    }
    function notify() { if (live()) { remember(); changed(self); } }
    function later(fn, delay) { var timer = setTimeout(function () { if (live()) fn(); }, delay); timers.push(timer); }
    // Household quality log (HomelabSync): heights a probe or a playback really showed, per provider voice.
    var facts = null, Q = window.HomelabQuality && typeof window.HomelabQuality.load === 'function' ? window.HomelabQuality : null;
    function factSeason() { return movie.name ? selection.season : 0; }
    function known(row) {
      if (!facts || row.native || row.kind !== 'online' || row.measured) return;
      var fact = Q.fact(facts, row.provider, factSeason(), row.factVoice || '', row.claimed || 0);
      if (fact) { row.qualities = [fact.height]; row.measured = true; row.verified = fact.source; row.doubtful = false; }
      else row.doubtful = !!row.claimed && Q.doubtful(facts, row.provider);
    }
    if (Q) Q.load(movie).then(function (data) { if (!live() || !data) return; facts = data; self.rows.forEach(known); notify(); }).catch(function () {});
    function add(row) { if (!live() || seenRows[row.key]) return; seenRows[row.key] = true; known(row); self.rows.push(row); notify(); }
    function server(path) {
      var address = sync.url(path); if (!address) throw new Error('identity'); return new URL(address);
    }
    function address(raw, metadata) {
      var auth = server('/lite/events'), url = new URL(raw, auth.origin);
      // Identity/header material belongs only to this Lampac instance.
      if (url.origin !== auth.origin || !/^\/(?:lite\/|lifeevents$|externalids$)/.test(url.pathname)) throw new Error('origin');
      ['uid', 'token', 'account_email', 'profile_id'].forEach(function (key) { if (auth.searchParams.has(key)) url.searchParams.set(key, auth.searchParams.get(key)); });
      var uid = L.Storage.get('lampac_unic_id', ''), nws = L.Storage.get('lampac_nws_id', '');
      if (uid && !url.searchParams.has('uid')) url.searchParams.set('uid', uid);
      if (nws) url.searchParams.set('nws_id', nws);
      if (metadata) {
        var params = {id: movie.id, title: movie.title || movie.name || '', original_title: movie.original_title || movie.original_name || '', serial: movie.name ? 1 : 0,
          original_language: movie.original_language || '', year: String(movie.release_date || movie.first_air_date || '').slice(0, 4), source: movie.source || 'tmdb', clarification: 0, similar: false};
        ['imdb_id', 'kinopoisk_id', 'tmdb_id'].forEach(function (key) { if (movie[key]) params[key] = movie[key]; });
        if (movie.keywords && movie.keywords.results && movie.keywords.results.some(function (k) { return k.name === 'anime'; })) params.anime = 1;
        Object.keys(params).forEach(function (key) { url.searchParams.set(key, params[key]); });
      }
      return url.href;
    }
    function request(raw, metadata, timeout, provider) {
      if (!live()) return Promise.reject(new Error('cancelled'));
      var url;
      try { url = address(raw, metadata); } catch (error) { return Promise.reject(error); }
      var abort = Abort(), timer = setTimeout(function () { abort.abort(); }, timeout || 8000);
      requests.push(abort);
      var headers = {}, kit = L.Storage.get('kit_aesgcmkey', ''); if (kit) headers['X-Kit-AesGcm'] = kit;
      var delay = paced(provider);
      var fetching = new Promise(function (resolve, reject) {
        var start = function () {
          if (!live() || abort.signal.aborted) return reject(new Error('cancelled'));
          fetch(url, {signal: abort.signal, credentials: 'same-origin', cache: 'no-store', headers: headers}).then(resolve, reject);
        };
        var wait;
        abort.signal.addEventListener('abort', function () { clearTimeout(wait); reject(new Error('cancelled')); }, {once: true});
        if (delay) { wait = setTimeout(start, delay); timers.push(wait); }
        else start();
      });
      return always(fetching.then(function (response) {
        if (!response.ok) throw new Error('request'); return response.text();
      }).then(function (text) { if (!live() || abort.signal.aborted) throw new Error('cancelled'); return text; }), function () {
        clearTimeout(timer); requests = requests.filter(function (entry) { return entry !== abort; });
      });
    }
    function fallback(source, label) {
      add({key: 'source:' + source.key, kind: 'online', provider: source.key, providerName: source.name, voice: label || 'Выбрать в источнике', native: true, qualities: []});
    }
