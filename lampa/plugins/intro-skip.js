(function () {
  'use strict';
  // Intro, recap and credits timestamps for series and anime episodes from community databases:
  // TheIntroDB by TMDB id and SkipDB by IMDb id, then AniSkip for anime (MAL id through ani.zip). Lampa 3.4 draws the
  // «Пропустить» / «Следующая серия» button from data.segments, which it reads only when an
  // episode starts, so the timestamps are fetched before playback: the next episode is looked up
  // while the current one plays, and a cache miss holds the start for at most WAIT ms.
  // Only the TMDB/IMDb/MAL id, season and episode leave the device.
  if (window.homelabIntroSkip) return;
  var WAIT = 1500, TIMEOUT = 6000, HIT = 12 * 3600 * 1000, MISS = 6 * 3600 * 1000, LIMIT = 300, END = 86400;
  var INTRODB = 'https://api.theintrodb.org/v2/media', SKIPDB = 'https://api.skipdb.tv/api/segments', ANIZIP = 'https://api.ani.zip/mappings', ANISKIP = 'https://api.aniskip.com/v2/skip-times/';

  function install() {
    var L = window.Lampa;
    if (window.homelabIntroSkip || !L || !L.Player || !L.Player.listener || typeof L.Player.listener.follow !== 'function' ||
        typeof L.Player.play !== 'function' || typeof window.fetch !== 'function') return;
    var cache = {}, pending = {}, mal = {}, imdb = {};
    window.homelabIntroSkip = {version: 1, lookup: lookup, cache: cache};

    function tmdbId(card) {
      if (!card || typeof card !== 'object') return 0;
      var source = card.source || 'tmdb', id = +(source === 'tmdb' || source === 'cub' ? card.id : card.tmdb_id);
      return id > 0 && id % 1 === 0 ? id : 0;
    }
    function serial(card) { return !!card && (!!card.name || !!card.original_name || card.number_of_seasons > 0) && !card.original_title; }
    function anime(card) {
      var genres = (card.genre_ids || []).concat((card.genres || []).map(function (genre) { return genre && genre.id; }));
      return genres.indexOf(16) >= 0 && (card.original_language === 'ja' || (card.origin_country || []).indexOf('JP') >= 0);
    }
    function number(value) { value = +value; return value > 0 && value % 1 === 0 ? value : 0; }
    function target(data) {
      if (!data || typeof data !== 'object' || data.iptv) return null;
      var card = data.card, id = tmdbId(card), season = number(data.season), episode = number(data.episode);
      if (!id || !serial(card) || !season || !episode) return null;
      return {key: id + ':' + season + ':' + episode, id: id, season: season, episode: episode, anime: anime(card), imdb: card.imdb_id};
    }
    function cached(key) {
      var entry = cache[key];
      if (!entry) return undefined;
      if (Date.now() > entry.until) { delete cache[key]; return undefined; }
      return entry.value;
    }
    function remember(key, value) {
      var keys = Object.keys(cache);
      if (keys.length >= LIMIT) keys.sort(function (a, b) { return cache[a].until - cache[b].until; }).slice(0, keys.length - LIMIT + 1).forEach(function (old) { delete cache[old]; });
      cache[key] = {value: value, until: Date.now() + (value ? HIT : MISS)};
    }
    function get(url, done) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null, finished = false;
      var timer = setTimeout(function () { if (controller) controller.abort(); finish(null); }, TIMEOUT);
      function finish(value) { if (finished) return; finished = true; clearTimeout(timer); done(value); }
      window.fetch(url, controller ? {signal: controller.signal, credentials: 'omit'} : {credentials: 'omit'}).then(function (response) {
        return response.ok ? response.json() : null;
      }).then(finish, function () { finish(null); });
    }
    // Seconds; a missing start is the beginning, a missing end is the end of the file.
    function span(start, end, scale) {
      start = start === null || start === undefined ? 0 : +start / scale;
      end = end === null || end === undefined ? END : +end / scale;
      return isFinite(start) && isFinite(end) && start >= 0 && end - start >= 3 ? {start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10} : null;
    }
    // TheIntroDB lists each kind as an array, SkipDB gives the best match of each kind or null.
    function timed(segments) {
      var skip = [];
      if (!segments || typeof segments !== 'object') return skip;
      ['recap', 'intro', 'credits', 'outro', 'preview'].forEach(function (name) {
        var tail = name === 'credits' || name === 'outro' || name === 'preview', list = segments[name];
        (Array.isArray(list) ? list : list ? [list] : []).forEach(function (item) {
          // An open start is only trusted for a recap; an open end only for the tail of the episode.
          if (!item || typeof item !== 'object' || (item.start_ms == null && name !== 'recap') || (item.end_ms == null && !tail)) return;
          var part = span(item.start_ms, item.end_ms, 1000);
          if (part) skip.push(part);
        });
      });
      return merge(skip);
    }
    function aniskip(answer) {
      var skip = [];
      (answer && answer.found && Array.isArray(answer.results) ? answer.results : []).forEach(function (item) {
        var interval = item && item.interval, part = interval && span(interval.startTime, interval.endTime, 1);
        if (part) skip.push(part);
      });
      return merge(skip);
    }
    function merge(list) {
      list.sort(function (a, b) { return a.start - b.start; });
      var out = [];
      list.forEach(function (part) {
        var last = out[out.length - 1];
        if (last && part.start <= last.end + 1) last.end = Math.max(last.end, part.end); else out.push({start: part.start, end: part.end});
      });
      return out;
    }
    // AniSkip numbers episodes per MAL entry; ani.zip maps one TMDB show to one MAL entry with
    // TVDB numbering. Only an episode whose MAL number, season and episode all agree (the first
    // season of that entry) is safe to ask about: a guess would skip real content.
    function malEpisode(item, done) {
      function pick(map) {
        var key = map && map.id ? Object.keys(map.episodes).filter(function (name) {
          var episode = map.episodes[name];
          return episode && +episode.seasonNumber === item.season && +episode.episodeNumber === item.episode && +name === item.episode;
        })[0] : '';
        done(key && number(key) ? {id: map.id, episode: number(key)} : null);
      }
      if (mal[item.id] !== undefined) return pick(mal[item.id]);
      get(ANIZIP + '?themoviedb_id=' + item.id, function (answer) {
        var id = answer && answer.mappings && number(answer.mappings.mal_id);
        mal[item.id] = id && answer.episodes && typeof answer.episodes === 'object' ? {id: id, episodes: answer.episodes} : null;
        pick(mal[item.id]);
      });
    }
    function lookup(item, done) {
      var known = cached(item.key);
      if (known !== undefined) return done(known);
      if (pending[item.key]) return pending[item.key].push(done);
      pending[item.key] = [done];
      function finish(skip) {
        if (!pending[item.key]) return;
        var value = skip && skip.length ? {skip: skip} : null, waiting = pending[item.key] || [];
        delete pending[item.key];
        remember(item.key, value);
        waiting.forEach(function (fn) { fn(value); });
      }
      // TheIntroDB and SkipDB are asked together; the first in that order with timestamps wins.
      var answers = [undefined, undefined];
      function settle(index, skip) {
        answers[index] = skip || [];
        if (answers[0] && answers[0].length) return finish(answers[0]);
        if (!answers[0] || !answers[1]) return;
        if (answers[1].length || !item.anime) return finish(answers[1]);
        malEpisode(item, function (episode) {
          if (!episode) return finish(null);
          get(ANISKIP + episode.id + '/' + episode.episode + '?types[]=op&types[]=ed&types[]=recap&types[]=mixed-op&types[]=mixed-ed&episodeLength=0', function (answer) { finish(aniskip(answer)); });
        });
      }
      get(INTRODB + '?tmdb_id=' + item.id + '&season=' + item.season + '&episode=' + item.episode, function (answer) { settle(0, timed(answer)); });
      imdbId(item, function (id) {
        if (!id) return settle(1, null);
        get(SKIPDB + '?imdb_id=' + id + '&season=' + item.season + '&episode=' + item.episode, function (answer) { settle(1, timed(answer && answer.segments)); });
      });
    }
    // SkipDB knows shows by IMDb id: the card's own, else Lampac's TMDB lookup, once per show.
    function imdbId(item, done) {
      function valid(id) { return typeof id === 'string' && /^tt\d{5,10}$/.test(id) ? id : ''; }
      if (valid(item.imdb)) return done(item.imdb);
      if (imdb[item.id] !== undefined) return done(imdb[item.id]);
      var sync = window.HomelabSync, url = sync && typeof sync.url === 'function' ? sync.url('/externalids') : '';
      if (!url) return done('');
      get(url + '&id=' + item.id + '&serial=1', function (answer) { done(imdb[item.id] = valid(answer && answer.imdb_id)); });
    }
    function inner(data) {
      var chosen = data.launch_player || (L.Storage && typeof L.Storage.field === 'function' ? L.Storage.field('player') : '');
      return !chosen || chosen === 'inner' || chosen === 'lampa';
    }
    function usable(segments) { return segments && typeof segments === 'object' && Array.isArray(segments.skip) && segments.skip.length; }
    function apply(data, value) { if (value && !usable(data.segments)) data.segments = {ad: [], skip: value.skip.map(function (part) { return {start: part.start, end: part.end}; })}; }

    L.Player.listener.follow('create', function (event) {
      var data = event && event.data, item = target(data);
      if (!item || usable(data.segments) || data.homelab_intro_checked) return;
      var known = cached(item.key);
      if (known !== undefined) { data.homelab_intro_checked = true; return apply(data, known); }
      // Hold only a fresh start in the built-in player. Cache only for: torrents (other 'create'
      // handlers prepare them once), an episode switch inside the player (Lampa has already torn
      // the player down and runs its callbacks right after play) and external players.
      if (typeof event.abort !== 'function' || data.torrent_hash || data.homelab_torrent_hash || data.continue_play || !inner(data)) return lookup(item, function () {});
      // Lampa reads segments only at start: hold this start briefly, then play the same data again.
      event.abort();
      var settled = false, loading = L.Loading && typeof L.Loading.start === 'function' && typeof L.Loading.stop === 'function';
      function settle(play) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (loading) L.Loading.stop();
        if (!play) return;
        data.homelab_intro_checked = true;
        apply(data, cached(item.key));
        L.Player.play(data);
      }
      var timer = setTimeout(function () { settle(true); }, WAIT);
      // Back on the loading layer cancels this start, as it cancels the stream lookup before it.
      if (loading) L.Loading.start(function () { settle(false); });
      lookup(item, function () { settle(true); });
    });
    // Look up the next episode while this one plays, so it starts without the wait.
    L.Player.listener.follow('external', function (data) { if (data) delete data.homelab_intro_checked; });
    L.Player.listener.follow('start', function (data) {
      delete data.homelab_intro_checked;
      var item = target(data);
      if (!item) return;
      var list = L.PlayerPlaylist && typeof L.PlayerPlaylist.get === 'function' ? L.PlayerPlaylist.get() : [];
      var next = (Array.isArray(list) ? list : []).filter(function (entry) {
        return entry && number(entry.season) === item.season && number(entry.episode) === item.episode + 1;
      })[0];
      var nextItem = next && target({card: next.card || data.card, season: next.season, episode: next.episode});
      if (nextItem) setTimeout(function () { lookup(nextItem, function () {}); }, 20000);
    });
  }
  install();
  if (!window.homelabIntroSkip && window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
})();
