(function install() {
  'use strict';
  if (!window.appready) {
    if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
    return;
  }
  var L = window.Lampa, sync = window.HomelabSync, $ = window.$;
  var COMPONENT = 'homelab_sources', PLAY = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  var MAGNET = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z"/></svg>';
  var NATIVE = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2zM14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3z"/></svg>';
  var CHECK = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
  if (window.HomelabSources || !L || !sync || !$) return;
  if (!window.fetch || typeof URL !== 'function' || !('searchParams' in URL.prototype) || typeof Promise !== 'function' || !L.Component || !L.Component.add || !L.Parser || !L.Parser.get || !L.Parser.clear || !L.Scroll || !L.Controller || !L.Controller.collectionFocus) {
    // Very old TV webviews keep a visible button that explains why instead of silently missing.
    window.HomelabSources = {unsupported: true};
    if (L.Listener && L.Noty) L.Listener.follow('full', function (event) {
      if (event.type === 'complite') addButton(event.data.movie, event.object.activity.render(), function () { L.Noty.show('Общий недоступен на этом устройстве: браузер ТВ устарел. Используйте обычные источники'); });
    });
    return;
  }
  // probeCache: per page session, bounded; reopening the picker reuses measured qualities instead of re-probing.
  var parserOwner = null, nextRequestAt = 0, probeCache = {keys: [], values: {}};
  // Tizen/webOS <= 5 lack AbortController; their fetch ignores the signal, and request() rejects on abort itself.
  function Abort() {
    if (window.AbortController) return new window.AbortController();
    var listeners = [], signal = {aborted: false, addEventListener: function (name, fn) { if (name === 'abort') listeners.push(fn); }};
    return {signal: signal, abort: function () { if (signal.aborted) return; signal.aborted = true; listeners.splice(0).forEach(function (fn) { fn(); }); }};
  }
  function always(promise, fn) { return promise.then(function (value) { fn(); return value; }, function (error) { fn(); throw error; }); }
  var ITEM_TAG = /^(?:web[\s-]?dl|webrip|hdrip|bdrip|blu[\s-]?ray|hdtv|camrip|ts|4k|uhd|hdr|sdr|\d{3,4}[pi])$/i;
  function voiceKey(value) { return String(value || '').toLowerCase().replace(/[\s._-]+/g, ' ').trim(); }
  function voiceStudio(value) {
    var text = voiceKey(value).replace(/ё/g, 'е')
      .replace(/(?:^|\s|[\[(])(?:0|6|12|16|18)\+([\])]|(?=\s|$))/g, ' ')
      .replace(/[^a-zа-я0-9]+/g, ' ')
      .replace(/(?:^|\s)(?:4[kк]|2160p|1080p|720p|480p|hdr|uhd)(?=\s|$)/g, ' ')
      .replace(/(?:профессиональный|любительский)\s+(?:многоголосый|двухголосый|одноголосый)|дублированный|дубляж/g, ' ')
      .replace(/\s+/g, ' ').trim();
    // Whole-label aliases only: unknown or combined studios stay manual choices.
    var studios = {
      kubik: ['кубик в кубе', 'kubik v kube', 'kubikvkube'],
      rhs: ['red head sound', 'redheadsound', 'rhs'],
      hdrezka: ['hdrezka', 'hdrezka studio', 'hd rezka', 'hd rezka studio'],
      lostfilm: ['lostfilm', 'lost film', 'lostfilm tv'],
      alexfilm: ['alexfilm', 'alex film'], newstudio: ['newstudio', 'new studio'],
      ultradox: ['ultradox', 'ультрадокс'], leproduction: ['le production', 'leproduction'],
      anilibria: ['anilibria', 'anilibria tv', 'анилибрия']
    };
    return Object.keys(studios).find(function (key) { return studios[key].indexOf(text) >= 0; }) || '';
  }
  function voiceMatch(a, b) {
    var first = voiceKey(a), second = voiceKey(b);
    if (!first || !second || /^(неизвестно|оригинал|по умолчанию|дублированный|озвучка источника)$/.test(first)) return 0;
    if (first === second) return 2;
    var studio = voiceStudio(first);
    return studio && studio === voiceStudio(second) ? 1 : 0;
  }
  function preferences(update) {
    var scope = L.Utils && typeof L.Utils.hash === 'function' ? sync.scope() : '', key = 'homelab_sources_preferences_' + (scope ? L.Utils.hash(scope) : '');
    var stored = scope ? L.Storage.get(key, {}) : {}, value = {voice: '', quality: 0};
    if (stored && typeof stored.voice === 'string' && stored.voice.length <= 200) value.voice = stored.voice;
    if (stored && [0, 2160, 1080, 720].indexOf(stored.quality) >= 0) value.quality = stored.quality;
    if (update) {
      if (typeof update.voice === 'string' && update.voice.length <= 200) value.voice = update.voice;
      if ([0, 2160, 1080, 720].indexOf(update.quality) >= 0) value.quality = update.quality;
      if (scope) L.Storage.set(key, value);
    }
    return value;
  }
  function describeRelease(release) {
    var info = release.info || {}, streams = Array.isArray(release.ffprobe) ? release.ffprobe : release.ffprobe && release.ffprobe.streams || [], voices = Array.isArray(info.voices) ? info.voices.filter(function (v) { return typeof v === 'string' && v.trim(); }) : [];
    if (!voices.length) streams.filter(function (s) { return s.codec_type === 'audio'; }).forEach(function (s) {
      var tags = s.tags || {}, name = tags.title || tags.handler_name; if (name && !/^(soundhandler|audiohandler|audio)$/i.test(String(name).replace(/\s/g, ''))) voices.push(name);
    });
    voices = voices.filter(function (voice, i) { return voices.indexOf(voice) === i; });
    var video = streams.find(function (s) { return s.codec_type === 'video'; }), codec = video && video.codec_name || (String(release.Title || '').match(/\b(?:HEVC|AVC|AV1|H[. ]?26[45]|x26[45]|VP9)\b/i) || [''])[0];
    codec = /hevc|265/i.test(codec) ? 'HEVC' : /avc|264/i.test(codec) ? 'AVC' : String(codec).toUpperCase();
    return {title: voices.length ? voices.slice(0, 2).join(' / ') + (voices.length > 2 ? ' +' + (voices.length - 2) : '') : 'Озвучка в раздаче', codec: codec, voices: voices};
  }
  // tie (optional) breaks equal-quality rows before the name order; groups use it for their source count.
  function compareRows(a, b, pref, tie) {
    var broken = (a.unavailable ? 1 : 0) - (b.unavailable ? 1 : 0); if (broken) return broken;
    function favorite(row) { return pref.voice && !row.native && voiceKey(row.identityVoice || row.voice) === voiceKey(pref.voice) ? 1 : 0; }
    var match = favorite(b) - favorite(a); if (match) return match;
    function group(row) { return row.native ? 2 : row.kind === 'online' ? 0 : 1; }
    match = group(a) - group(b); if (match) return match;
    if (a.release && b.release) { match = (Number(b.release.Seeders) || 0) - (Number(a.release.Seeders) || 0); if (match) return match; }
    match = (b.qualities[0] || 0) - (a.qualities[0] || 0); if (match) return match;
    match = tie ? tie(a, b) : 0;
    return match || String(a.providerName).localeCompare(String(b.providerName)) || a.key.localeCompare(b.key);
  }
  function quality(value) {
    var text = String(value || '');
    if (/\b(4k|uhd)\b/i.test(text)) return 2160;
    var match = /(?:^|\D)(2160|1440|1080|720|576|480|360)(?:p|i|\D|$)/i.exec(text);
    return match ? +match[1] : 0;
  }
  function qualities(file) {
    var found = Object.keys(file.quality || file.qualitys || {}).map(quality).filter(Boolean);
    var named = quality(file.text || file.Title || file.title) || quality(file.info && file.info.quality);
    if (named) found.push(named);
    if (!found.length && file.maxquality) { named = quality(file.maxquality); if (named) found.push(named); }
    return found.filter(function (q, i) { return found.indexOf(q) === i; }).sort(function (a, b) { return b - a; });
  }
  // Width first: cinema crops (1920x800) still count as 1080p.
  function standard(width, height) {
    var steps = [[3800, 2160], [2500, 1440], [1800, 1080], [1200, 720], [1000, 576], [800, 480]];
    for (var i = 0; i < steps.length; i++) if (width >= steps[i][0] || height >= steps[i][1] * 0.9) return steps[i][1];
    return width || height ? 360 : 0;
  }
  function hlsQuality(text) {
    var best = 0;
    String(text).replace(/RESOLUTION=(\d+)x(\d+)/gi, function (all, width, height) { best = Math.max(best, standard(+width, +height)); return all; });
    return best;
  }
  function covers(release, selection) {
    var seasons = release.info && release.info.seasons;
    if (Array.isArray(seasons) && seasons.length && seasons.every(function (n) { return (typeof n === 'number' || typeof n === 'string' && n.trim() !== '') && Number.isInteger(+n) && +n >= 0; }) && seasons.map(Number).indexOf(selection.season) < 0) return false;
    var title = release.Title || '', match = /(?:^|[\s.\[(_-])S(\d{1,2})(?:\s*[-–]\s*S?(\d{1,2}))?(?:E(\d{1,3})(?:\s*[-–]\s*E?(\d{1,3}))?)?/i.exec(title);
    if (match) return selection.season >= +match[1] && selection.season <= +(match[2] || match[1]) && (!match[3] || selection.episode >= +match[3] && selection.episode <= +(match[4] || match[3]));
    match = /сезон[ыа]?\s*:?\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/i.exec(title);
    if (!match) match = /(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*сезон/i.exec(title);
    return !match || selection.season >= +match[1] && selection.season <= +(match[2] || match[1]);
  }
  function nodes(text, selector) {
    // A detached template keeps provider HTML inert: never append it to the UI.
    var template = document.createElement('template'); template.innerHTML = text;
    return Array.prototype.map.call(template.content.querySelectorAll(selector), function (node) {
      try {
        var data = JSON.parse(node.getAttribute('data-json'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        data.text = node.textContent.trim(); data.active = node.classList.contains('active');
        if (node.getAttribute('s')) data.season = +node.getAttribute('s');
        if (node.getAttribute('e')) data.episode = +node.getAttribute('e');
        return data;
      } catch (_) { return null; }
    }).filter(Boolean);
  }
  function movieCard(value) {
    var movie = Object.assign({}, value);
    if (movie.name) movie.title = movie.name;
    return movie;
  }
  function Search(movie, selection, changed, options) {
    movie = movieCard(movie); options = options || {};
    // Two lanes: first pages of every provider go before alternate-voice pages, so all providers show up early.
    var self = this, scope = sync.scope(), alive = true, queue = [], voiceQueue = [], requests = [], timers = [], running = 0, discovered = {}, seenRows = {}, visited = {}, voicesSeen = {};
    var sourceCount = {}, deadline = Date.now() + 60000, pollUntil = 0, parserTimer, parserPending = false, started = false;
    var pendingBy = {};
    this.rows = []; this.onlinePending = true; this.torrentPending = false; this.errors = []; this.interrupted = false; this.providers = {total: 0, done: 0};
    this.checking = function () { return alive ? probeQueue.length + probing : 0; };
    function live() { return alive && sync.scope() === scope; }
    function notify() { if (live()) changed(self); }
    function later(fn, delay) { var timer = setTimeout(function () { if (live()) fn(); }, delay); timers.push(timer); }
    function add(row) { if (!live() || seenRows[row.key]) return; seenRows[row.key] = true; self.rows.push(row); notify(); }
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
    function request(raw, metadata, timeout) {
      if (!live()) return Promise.reject(new Error('cancelled'));
      var url;
      try { url = address(raw, metadata); } catch (error) { return Promise.reject(error); }
      var abort = Abort(), timer = setTimeout(function () { abort.abort(); }, timeout || 8000);
      requests.push(abort);
      var headers = {}, kit = L.Storage.get('kit_aesgcmkey', ''); if (kit) headers['X-Kit-AesGcm'] = kit;
      var delay = Math.max(0, nextRequestAt - Date.now()); nextRequestAt = Date.now() + delay + 350;
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
    // Rows without quality ask their source once, after the catalog is done: the call JSON or the HLS master
    // (RESOLUTION) gives the real height. Only an own-Lampac 4xx or an explicit error/accsdb answer means the source
    // hands out no video; rch/ws handshakes, timeouts and foreign CDN refusals change nothing. Media is never read.
    var probeQueue = [], probing = 0, probes = 0;
    function probeApply(row, value) {
      if (value.unavailable) row.unavailable = true;
      else { row.qualities = value.qualities.slice(); row.measured = true; }
    }
    function probe(row, raw) {
      // Without a native AbortController a hung or media response could not be stopped: skip probing entirely.
      if (row.native || row.qualities.length || typeof raw !== 'string' || !raw || !window.AbortController) return;
      var key = scope + '\n' + row.provider + '\n' + raw;
      if (probeCache.values[key]) return probeApply(row, probeCache.values[key]);
      if (probes >= 24) return;
      probes++; probeQueue.push({row: row, url: raw, key: key}); probeNext();
    }
    function probeRemember(key, value) {
      if (!probeCache.values[key]) { probeCache.keys.push(key); if (probeCache.keys.length > 200) delete probeCache.values[probeCache.keys.shift()]; }
      probeCache.values[key] = value;
    }
    function probeRead(response, abort) {
      var type = String(response.headers.get('content-type') || '').toLowerCase(), length = Number(response.headers.get('content-length'));
      var known = response.headers.get('content-length') != null && response.headers.get('content-length') !== '' && Number.isFinite(length);
      var readable = /json|mpegurl|m3u8/.test(type) || /^text\/html/.test(type) || /^text\/plain/.test(type) && known && length <= 65536;
      if (!readable || known && length > 262144) { abort.abort(); return Promise.resolve(''); }
      if (known) return response.text();
      // Unknown length: stream with a byte cap, or give up where streams are missing.
      var reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
      if (!reader || typeof window.TextDecoder !== 'function') { abort.abort(); return Promise.resolve(''); }
      var decoder = new window.TextDecoder(), text = '', total = 0;
      function next() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return text + decoder.decode();
          total += chunk.value.byteLength;
          if (total > 262144) { abort.abort(); return ''; }
          text += decoder.decode(chunk.value, {stream: true}); return next();
        });
      }
      return next();
    }
    function probeFetch(raw) {
      var auth, url, own;
      try {
        auth = server('/lite/events'); url = new URL(raw, auth.origin); own = url.origin === auth.origin;
        if (own && /^\/lite\//.test(url.pathname)) url = new URL(address(url.href, false));
      } catch (error) { return Promise.reject(error); }
      if (!/^https?:$/.test(url.protocol)) return Promise.reject(new Error('url'));
      var trusted = own && /^\/(?:lite|proxy)\//.test(url.pathname);
      var abort = Abort(), timer = setTimeout(function () { abort.abort(); }, 10000); requests.push(abort);
      var headers = {}, kit = own && L.Storage.get('kit_aesgcmkey', ''); if (kit) headers['X-Kit-AesGcm'] = kit;
      // Own-Lampac probes share the catalog pacing; foreign CDNs are not rate limited by us.
      var delay = own ? Math.max(0, nextRequestAt - Date.now()) : 0; if (own) nextRequestAt = Date.now() + delay + 350;
      var fetching = new Promise(function (resolve, reject) {
        var wait, start = function () {
          if (!live() || abort.signal.aborted) return reject(new Error('cancelled'));
          fetch(url.href, {signal: abort.signal, credentials: own ? 'same-origin' : 'omit', cache: 'no-store', headers: headers}).then(resolve, reject);
        };
        abort.signal.addEventListener('abort', function () { clearTimeout(wait); reject(new Error('cancelled')); }, {once: true});
        if (delay) { wait = setTimeout(start, delay); timers.push(wait); } else start();
      });
      return always(fetching.then(function (response) {
        return probeRead(response, abort).then(function (text) { return {status: response.status, trusted: trusted, text: text}; });
      }), function () { clearTimeout(timer); requests = requests.filter(function (entry) { return entry !== abort; }); });
    }
    function probeJob(job, raw, hop) {
      var row = job.row;
      return probeFetch(raw).then(function (result) {
        if (!live()) return;
        if (result.status >= 400 && result.status < 500 && result.status !== 429) {
          if (result.trusted) { probeRemember(job.key, {unavailable: true}); row.unavailable = true; notify(); }
          return;
        }
        if (result.status >= 300) return;
        var json; try { json = JSON.parse(result.text); } catch (_) {}
        if (json && typeof json === 'object') {
          var found = qualities({quality: json.quality || json.qualitys, maxquality: json.maxquality});
          if (found.length) { probeRemember(job.key, {qualities: found}); row.qualities = found; row.measured = true; return notify(); }
          if (typeof json.url === 'string' && json.url && !hop) return probeJob(job, json.url, 1);
          if (json.error || json.accsdb) { probeRemember(job.key, {unavailable: true}); row.unavailable = true; notify(); }
          return;
        }
        var best = /^\s*#EXTM3U/.test(result.text) ? hlsQuality(result.text) : 0;
        if (best) { probeRemember(job.key, {qualities: [best]}); row.qualities = [best]; row.measured = true; notify(); }
      });
    }
    function probeNext() {
      while (live() && discoveryDone && probing < 2 && probeQueue.length && !running && !queue.length && !voiceQueue.length) {
        (function (job) {
          probing++;
          always(probeJob(job, job.url, 0).catch(function () {}), function () { probing--; probeNext(); notify(); });
        })(probeQueue.shift());
      }
    }
    function voiceSeen(source, seasonIndex, text) {
      var key = source.key + ':' + seasonIndex + ':' + voiceKey(text);
      if (voicesSeen[key]) return true;
      voicesSeen[key] = true; return false;
    }
    function enqueue(source, url, state, lane) {
      var absolute;
      try { absolute = address(url, false); } catch (_) { fallback(source); return; }
      var key = source.key + ':' + absolute;
      if (visited[key] || !live()) return;
      visited[key] = true;
      // ponytail: cap catalog traversal per provider; remaining choices stay available natively.
      if ((sourceCount[source.key] || 0) >= 32) { fallback(source, 'Другие варианты в источнике'); return; }
      sourceCount[source.key] = (sourceCount[source.key] || 0) + 1;
      pendingBy[source.key] = (pendingBy[source.key] || 0) + 1;
      (lane ? voiceQueue : queue).push({source: source, url: absolute, state: state}); pump();
    }
    function catalog(job, text) {
      var source = job.source, state = job.state, json;
      try { json = JSON.parse(text); } catch (_) {}
      if (json && (json.rch || json.accsdb)) return fallback(source);
      var items = nodes(text, '.videos__item'), voices = nodes(text, '.videos__button');
      var files = items.filter(function (file) { return file.method === 'play' || file.method === 'call'; });
      if (files.length) {
        var active = voices.find(function (voice) { return voice.active; });
        var voice = active ? active.text : state.voice || '';
        if (voice) voiceSeen(source, state.seasonIndex, voice);
        if (state.voice && state.voice !== voice) voiceSeen(source, state.seasonIndex, state.voice);
        var matching = files.filter(function (file) { return !movie.name || Number.isInteger(file.season) && file.season >= 0 && Number.isInteger(file.episode) && file.episode > 0 && file.season === selection.season && file.episode === selection.episode; });
        var labels = {};
        matching.forEach(function (file) {
          var row = {kind: 'online', provider: source.key, providerName: source.name, seasonIndex: state.seasonIndex, qualities: qualities(file)}, identityVoice;
          if (movie.name) {
            identityVoice = voice || file.voice_name || 'Неизвестно';
            row.key = source.key + ':' + state.seasonIndex + ':' + identityVoice + ':' + row.qualities.join(',');
          } else {
            // Movie items often keep a release tag (WEB-DL, 2160p) in voice_name and the dub in translate/text.
            var index = files.indexOf(file), translate = typeof file.translate === 'string' ? file.translate.trim() : '';
            var filmText = /\d+p/i.test(file.text) || file.text === 'По умолчанию' ? movie.title : file.text;
            var tag = typeof file.voice_name === 'string' ? file.voice_name.trim() : '';
            identityVoice = voice || translate || filmText || (tag && !ITEM_TAG.test(tag) ? tag : '') || movie.title || 'Неизвестно';
            row.key = source.key + ':' + state.seasonIndex + ':' + index + ':' + identityVoice + ':' + row.qualities.join(',');
            row.tag = tag && tag !== identityVoice ? tag : '';
            // Exact native draw identity for the bridge: same item index among play/call items, URL and texts.
            row.match = {index: index, count: files.length, url: typeof file.url === 'string' ? file.url : '', text: filmText || '', translate: translate, voice_name: tag};
          }
          var label = identityVoice + (row.tag ? ' · ' + row.tag : '');
          labels[label] = (labels[label] || 0) + 1;
          row.voice = labels[label] > 1 ? label + ' · вариант ' + labels[label] : label;
          row.identityVoice = identityVoice;
          add(row);
          if (self.rows[self.rows.length - 1] === row) probe(row, file.url);
        });
        if (!matching.length && !voices.length) fallback(source, 'Уточнить серию в источнике');
        voices.forEach(function (choice) { if (!choice.active && choice.url && choice.text && !voiceSeen(source, state.seasonIndex, choice.text)) enqueue(source, choice.url, {seasonIndex: state.seasonIndex, voice: choice.text}, 1); });
      } else {
        var folders = items.filter(function (item) { return item.method === 'link' && !item.similar; });
        var selected = folders.findIndex(function (folder) {
          var number = Number.isInteger(folder.season) ? folder.season : (String(folder.text).match(/\d+/) || [])[0];
          return number != null && +number === selection.season;
        });
        if (selected < 0 && folders.length === 1 && (!movie.name || selection.season === 1)) selected = 0;
        if (selected >= 0) enqueue(source, folders[selected].url, {seasonIndex: selected, voice: state.voice});
        else fallback(source, movie.name ? 'Уточнить сезон в источнике' : 'Выбрать фильм в источнике');
      }
    }
    var discoveryDone = false;
    function settle() {
      self.onlinePending = live() && (!discoveryDone || running > 0 || queue.length > 0 || voiceQueue.length > 0);
      // A provider has answered once none of its catalog pages is queued or running.
      var keys = Object.keys(discovered); self.providers = {total: keys.length, done: keys.filter(function (key) { return !pendingBy[key]; }).length};
      probeNext(); notify();
    }
    function pump() {
      if (!live()) return;
      while (running < 2 && (queue.length || voiceQueue.length)) {
        if (Date.now() >= deadline) { queue.splice(0).concat(voiceQueue.splice(0)).forEach(function (job) { pendingBy[job.source.key]--; fallback(job.source, 'Другие варианты в источнике'); }); break; }
        (function (job) {
          running++;
          always(request(job.url, false).then(function (text) { catalog(job, text); }).catch(function () { if (live()) fallback(job.source); }), function () { running--; pendingBy[job.source.key]--; pump(); settle(); });
        })(queue.length ? queue.shift() : voiceQueue.shift());
      }
      settle();
    }
    function sources(rows) {
      (Array.isArray(rows) ? rows : []).forEach(function (source) {
        var key = String(source.balanser || source.name && source.name.split(' ')[0] || '').toLowerCase();
        if (!/^[a-z0-9_.-]{1,80}$/i.test(key) || discovered[key] || source.show === false || !source.url) return;
        discovered[key] = true;
        var value = {key: key, name: String(source.name || key)};
        try { enqueue(value, address(source.url, true), {seasonIndex: 0, voice: ''}); } catch (_) { fallback(value); }
      });
    }
    function poll(memkey, seen) {
      // The live window starts with polling itself, as in native Lampac, not when the picker opened.
      if (!pollUntil) pollUntil = Date.now() + 15000;
      request(server('/lifeevents').href + '&memkey=' + encodeURIComponent(memkey) + '&seen=' + seen, true, 4000).then(function (text) {
        var json = JSON.parse(text); sources(json.online);
        if (!json.ready && Date.now() < pollUntil) later(function () { poll(memkey, (json.online || []).length); }, 750);
        else { discoveryDone = true; settle(); }
      }).catch(function () { if (Date.now() < pollUntil) later(function () { poll(memkey, seen); }, 1000); else { discoveryDone = true; self.errors.push('Не все онлайн-источники ответили'); settle(); } });
    }
    function online() {
      request(server('/lite/events').href + '&life=true', true).then(function (text) {
        var data = JSON.parse(text);
        if (data.life && data.memkey) poll(data.memkey, 0);
        else { sources(data); discoveryDone = true; settle(); }
      }).catch(function () { discoveryDone = true; self.errors.push('Онлайн-поиск недоступен'); settle(); });
    }
    function torrents() {
      if (options.torrents === false || !L.Storage.field('parser_use') || window.lampa_settings && window.lampa_settings.torrents_use === false) return;
      parserOwner = self; parserPending = true; self.torrentPending = true;
      function done(result, failed) {
        if (!live() || parserOwner !== self || !parserPending) return;
        parserPending = false; self.torrentPending = false; clearTimeout(parserTimer);
        if (failed) self.errors.push('Торрент-поиск недоступен');
        (result && Array.isArray(result.Results) ? result.Results : []).forEach(function (release) {
          var magnet = release.MagnetUri || release.Link;
          if (!magnet || typeof release.Title !== 'string' || movie.name && !covers(release, selection)) return;
          add({key: 'torrent:' + (release.hash || magnet), kind: 'torrent', voice: describeRelease(release).title, providerName: release.Tracker || 'Торрент', qualities: qualities(release), release: release});
        }); notify();
      }
      parserTimer = setTimeout(function () { if (live() && parserOwner === self && parserPending) { L.Parser.clear(); done(null, true); } }, 45000);
      var name = movie.title || movie.name || '', original = movie.original_title || movie.original_name || name;
      try { L.Parser.get({movie: movie, search: original, search_one: name, search_two: original, page: 1}, function (json) { done(json); }, function () { done(null, true); }); }
      catch (_) { done(null, true); }
    }
    this.cancel = function () {
      if (alive && started && (self.onlinePending || self.torrentPending)) self.interrupted = true;
      alive = false; timers.forEach(clearTimeout); clearTimeout(parserTimer); requests.forEach(function (abort) { abort.abort(); }); queue = []; voiceQueue = []; probeQueue = [];
      if (parserOwner === self && parserPending) L.Parser.clear();
      if (parserOwner === self) parserOwner = null;
      parserPending = false;
      self.onlinePending = false; self.torrentPending = false;
    };
    this.start = function () {
      started = true; torrents();
      var ids = Promise.resolve();
      if (!movie.imdb_id || !movie.kinopoisk_id) ids = request(server('/externalids').href + '&id=' + encodeURIComponent(movie.id) + '&serial=' + (movie.name ? 1 : 0), false, 4000).then(function (text) {
        var data = JSON.parse(text); ['imdb_id', 'kinopoisk_id', 'tmdb_id'].forEach(function (key) { if (typeof data[key] === 'string' || Number.isInteger(data[key])) movie[key] = data[key]; });
      }).catch(function () {});
      ids.then(function () { if (live()) online(); }); notify();
    };
  }
  function plural(n, forms) {
    var a = n % 10, b = n % 100;
    return n + ' ' + (a === 1 && b !== 11 ? forms[0] : a >= 2 && a <= 4 && (b < 12 || b > 14) ? forms[1] : forms[2]);
  }
  var SOURCES = ['источник', 'источника', 'источников'], VARIANTS = ['вариант', 'варианта', 'вариантов'];
  function qualityName(value) { return value === 2160 ? '4K' : value ? value + 'p' : ''; }
  // Inside one voice: playable first, then the highest quality, a measured height over a declared one.
  function bestFirst(a, b) {
    var match = (a.unavailable ? 1 : 0) - (b.unavailable ? 1 : 0); if (match) return match;
    match = (b.qualities[0] || 0) - (a.qualities[0] || 0); if (match) return match;
    match = (b.measured ? 1 : 0) - (a.measured ? 1 : 0);
    return match || String(a.providerName).localeCompare(String(b.providerName)) || a.key.localeCompare(b.key);
  }
  // One card per online voice (same identity as the favourite match); torrents and native fallbacks stay single.
  function groupRows(rows) {
    var groups = [], byKey = {};
    rows.forEach(function (row) {
      var key = row.kind === 'online' && !row.native ? 'voice:' + voiceKey(row.identityVoice || row.voice) : 'row:' + row.key;
      if (!byKey[key]) { byKey[key] = {key: key, rows: []}; groups.push(byKey[key]); }
      byKey[key].rows.push(row);
    });
    groups.forEach(function (group) { group.rows.sort(bestFirst); group.best = group.rows[0]; });
    return groups;
  }
  function Common(object) {
    var self = this, movie = movieCard(object.movie), tv = !!movie.name, saved = window.homelabContinue && window.homelabContinue.list().find(function (item) { return item.card === (tv ? 'tv_' : 'movie_') + movie.id; });
    var recovery = object.homelab_recovery, pref = preferences();
    if (recovery && recovery.scope !== sync.scope()) recovery = null;
    var season = Number.isInteger(object.season) && object.season >= 0 ? object.season : saved && Number.isInteger(saved.season) && saved.season >= 0 ? saved.season : 1;
    var selection = recovery ? {season: recovery.season, episode: recovery.episode} : {season: season, episode: saved && saved.season === season && saved.episode || 1};
    var root = $('<div class="homelab-common"></div>'), head = $('<div class="homelab-common-head"></div>'), controls = $('<div class="homelab-common-controls"></div>'), tabs = $('<div class="homelab-common-tabs"></div>');
    var status = $('<div class="homelab-common-status" aria-live="polite"></div>'), statusText = $('<div class="homelab-common-status-text"></div>'), bar = $('<div class="homelab-common-bar"></div>'), barFill = $('<div class="homelab-common-bar-fill"></div>');
    var body = $('<div class="homelab-common-list"></div>'), scroll = new L.Scroll({mask: true, over: true}), hint = $('<div class="homelab-common-hint hide"></div>');
    var search, last = null, kind = recovery ? 'online' : 'all', q = recovery ? 0 : pref.quality, tiles = {}, models = {}, shown = 20, visibleItems = [], order = [], locked = false, restoringFocus = false, more = null, dead = false, started = false, refresh, uiIntent = 0, currentScope = sync.scope();
    // Grouped by voice by default; recovery lists every provider, since the point there is to pick another one.
    // untouched: until the first key press, focus follows the top (recommended) card so one OK plays it.
    var grouped = !recovery, untouched = true, placeholder = null, placeholderState = '';
    var title = $('<div class="homelab-common-heading"></div>').text('Общий'), label = $('<div class="homelab-common-movie"></div>').text(movie.title || movie.name || '');
    status.append($('<div class="homelab-common-spinner"></div>')).append(statusText).append(bar.append(barFill));
    head.append(title).append(label); root.append(head).append(controls).append(tabs).append(status);
    var otherButton = button('', 'homelab-common-chip homelab-common-other-voices hide', otherVoices); root.append(otherButton);
    body.appendTo(scroll.body()); root.append(scroll.render()); root.append(hint);
    var recoveryLabel = recovery ? $('<div class="homelab-common-recovery"></div>') : null;
    function recoveryText() { if (recoveryLabel) recoveryLabel.text('Продолжить с ' + L.Utils.secondsToTime(recovery.position) + (recovery.voice ? ' · ' + recovery.voice : ' · Выберите озвучку') + '. Тайминги разных версий могут отличаться'); }
    if (recoveryLabel) { head.after(recoveryLabel); recoveryText(); }
    function active() { return !dead && L.Activity.active() === object; }
    function focus(background) { restoringFocus = !!background; L.Controller.collectionSet(root, false, true); L.Controller.collectionFocus(last && root[0].contains(last) ? last : false, root, true); restoringFocus = false; }
    function touch() { untouched = false; }
    function button(text, cls, fn) {
      return $('<div class="selector ' + cls + '"></div>').text(text).on('hover:focus', function () { last = this; if (!restoringFocus && body[0].contains(this)) scroll.update(this, true); })
        .on('hover:hover hover:touch', touch).on('hover:enter', function () { touch(); fn.apply(this, arguments); });
    }
    function choose(titleText, values, onSelect) {
      values = values.map(function (value) {
        var item = Object.assign({}, value), html = $('<div class="selectbox-item selector"></div>');
        html.append($('<div class="selectbox-item__title"></div>').text(item.title || ''));
        html.append($('<div class="selectbox-item__subtitle"></div>').text(item.subtitle || ''));
        item.html = html; return item;
      });
      L.Select.show({title: titleText, items: values, onSelect: function (value) { L.Select.close(); onSelect(value); if (active()) self.start(); }, onBack: function () { if (active()) self.start(); }});
    }
    function favorite(row) { return !!pref.voice && !row.native && row.kind === 'online' && voiceKey(row.identityVoice) === voiceKey(pref.voice); }
    function resetList() {
      Object.keys(tiles).forEach(function (key) { tiles[key].remove(); }); tiles = {}; models = {};
      locked = false; order = []; shown = 20; last = null; scroll.reset();
    }
    function otherVoices() {
      if (!recovery || !active() || sync.scope() !== currentScope) return;
      recovery.voice = ''; recoveryText(); locked = false; order = []; shown = 20; last = null; scroll.reset(); selectors(); draw();
      if (L.Controller.own(self)) focus(true);
    }
    function matchLabel(tile, row) {
      tile.find('.homelab-common-match').toggleClass('hide', !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) !== 1);
    }
    function setFavorite(voice) { pref = preferences({voice: voice}); resetList(); selectors(); draw(); }
    function selectors() {
      controls.empty();
      if (tv && recovery) {
        controls.append($('<div class="homelab-common-chip homelab-common-static"></div>').text('Сезон ' + selection.season + ' · Серия ' + selection.episode));
      } else if (tv) {
        controls.append(button(selection.season === 0 ? 'Спецвыпуски' : 'Сезон ' + selection.season, 'homelab-common-chip', function () {
          var token = ++uiIntent;
          function complete(data) {
            if (!active() || token !== uiIntent || !L.Controller.own(self) || sync.scope() !== currentScope) return;
            var seasons = data && Array.isArray(data.seasons) ? data.seasons : [];
            var values = seasons.filter(function (entry) { return Number.isInteger(entry.season_number) && entry.season_number >= 0 && entry.season_number <= 999; }).map(function (entry) {
              return {title: entry.name || (entry.season_number === 0 ? 'Спецвыпуски' : 'Сезон ' + entry.season_number), value: entry.season_number, selected: entry.season_number === selection.season};
            });
            if (!values.length) return L.Noty.show('Не удалось получить список сезонов');
            movie.seasons = seasons;
            choose('Сезон', values, function (value) { selection.season = value.value; selection.episode = 1; restart(); });
          }
          if (Array.isArray(movie.seasons) && movie.seasons.length) return complete(movie);
          L.Api.sources.tmdb.get('tv/' + movie.id, {}, function (data) { complete(data && +data.id === movie.id ? data : null); }, function () { complete(null); });
        }));
        controls.append(button('Серия ' + selection.episode, 'homelab-common-chip', function () {
          var season = selection.season, token = ++uiIntent;
          L.Api.sources.tmdb.get('tv/' + movie.id + '/season/' + season, {}, function (data) {
            if (!active() || token !== uiIntent || season !== selection.season || !L.Controller.own(self) || sync.scope() !== currentScope) return;
            choose('Серия', (data.episodes || []).map(function (episode) { return {title: episode.episode_number + ' · ' + episode.name, value: episode.episode_number, selected: episode.episode_number === selection.episode}; }), function (value) { selection.episode = value.value; restart(); });
          }, function () { if (active()) L.Noty.show('Не удалось получить список серий'); });
        }));
      }
      [['all', 'Все'], ['online', 'Онлайн'], ['torrent', 'Торренты']].forEach(function (value) {
        if (recovery && value[0] === 'torrent') return;
        controls.append(button(value[1], 'homelab-common-chip homelab-common-kind' + (kind === value[0] ? ' selected' : ''), function () {
          kind = value[0]; shown = 20; locked = false; order = []; scroll.reset(); controls.find('.homelab-common-kind.selected').removeClass('selected'); $(this).addClass('selected'); draw();
        }));
      });
      controls.append(button(grouped ? 'По озвучкам' : 'Все источники', 'homelab-common-chip homelab-common-view', function () {
        grouped = !grouped; $(this).text(grouped ? 'По озвучкам' : 'Все источники'); resetList(); last = this; draw();
      }));
      if (recovery && recovery.voice) controls.append(button('Озвучка: ' + recovery.voice, 'homelab-common-chip', function () {
        choose('Озвучка для другого источника', [{title: 'Сохранить ту же озвучку', keep: true}, {title: 'Выбрать другую вручную'}], function (value) {
          if (!value.keep) otherVoices();
        });
      }));
      // The favourite is set from a card (Right / long press); the chip only appears once there is one to change.
      if (!recovery && pref.voice) controls.append(button('★ ' + pref.voice, 'homelab-common-chip homelab-common-favorite', function () {
        var voices = search ? search.rows.filter(function (row) { return row.kind === 'online' && !row.native; }).map(function (row) { return row.identityVoice; }).filter(Boolean) : [];
        voices.push(pref.voice);
        voices = voices.filter(function (voice, index) { return voices.indexOf(voice) === index; }).sort();
        choose('Любимая озвучка — всегда выше', [{title: 'Не выделять', value: ''}].concat(voices.map(function (voice) { return {title: voice, value: voice, selected: voiceKey(voice) === voiceKey(pref.voice)}; })), function (value) {
          setFavorite(value.value);
        });
      }));
      controls.append(button('Обновить', 'homelab-common-refresh', restart));
    }
    function directIdentity(row) {
      return /^[a-z0-9_.-]{1,80}$/i.test(row.provider) && typeof row.identityVoice === 'string' && row.identityVoice.length <= 200 && Number.isInteger(row.seasonIndex) && row.seasonIndex >= 0 && row.seasonIndex <= 999;
    }
    function openNative(row) {
      L.Activity.push({component: 'lampac', movie: movie, title: 'Онлайн', search: movie.title || movie.name, search_one: movie.title || movie.name, search_two: movie.original_title || movie.original_name, page: 1, lampac_custom_select: row.provider});
    }
    function open(row) {
      if (!active() || sync.scope() !== currentScope) return;
      if (recovery && (row.native || row.kind !== 'online' || row.provider === recovery.excludeProvider || recovery.voice && !voiceMatch(recovery.voice, row.identityVoice))) return;
      // Online handoffs push an activity, whose pause() cancels the search; a refused handoff keeps it running.
      if (row.kind === 'torrent') {
        cancel(); draw();
        var release = Object.assign({}, row.release, {title: row.release.Title, poster: movie.img || (movie.poster_path ? L.Api.img(movie.poster_path) : '')});
        L.Torrent.back(function () { if (active()) self.start(); }); L.Torrent.start(release, movie);
      } else if (row.native) {
        openNative(row);
      } else if (!directIdentity(row)) {
        // The bridge only accepts bounded identities; open the provider natively rather than claim it is loading.
        L.Noty.show('Этот вариант откроется в источнике');
        openNative(row);
      } else if (!window.HomelabOnlineResume || !window.HomelabOnlineResume.select(row, movie, selection, q || recovery && recovery.quality, recovery)) {
        L.Noty.show('Онлайн-источник ещё загружается. Повторите выбор');
      }
    }
    // What a card shows; the signature lets draw() skip unchanged cards instead of rebuilding them.
    function view(item, hero) {
      var row = item.best, count = item.rows.length, best = row.qualities[0] || 0, voice = grouped && row.kind === 'online' && !row.native ? row.identityVoice : row.voice;
      var model = {voice: (favorite(row) ? '★ ' : '') + voice, badges: [], cls: row.kind === 'torrent' ? 'is-torrent' : row.native ? 'is-native' : 'is-online', icon: row.kind === 'torrent' ? MAGNET : row.native ? NATIVE : PLAY, note: ''};
      model.details = row.providerName + ' · ' + (count > 1 ? 'ещё ' + plural(count - 1, SOURCES) : row.kind === 'torrent' ? 'Торрент' : 'Онлайн');
      if (row.release) {
        var described = describeRelease(row.release), size = Number(row.release.Size || row.release.size), seeds = Number(row.release.Seeders);
        if (Number.isFinite(seeds)) model.badges.push([plural(seeds, ['сид', 'сида', 'сидов']), seeds > 0 ? 'is-seeds' : 'is-dead']);
        if (size > 0) model.badges.push([(size / 1073741824).toFixed(1).replace('.', ',') + ' ГБ', '']);
        if (described.codec) model.badges.push([described.codec, '']);
        if (tv) model.details += ' · Выбор серии в раздаче';
      } else if (row.unavailable) model.details += ' · Не отдаёт видео';
      else if (!best) model.details += row.native ? ' · Качество неизвестно · Открыть источник' : ' · Качество уточняется';
      if (row.unavailable) { model.quality = 'нет видео'; model.qcls = 'is-off'; model.cls += ' is-unavailable'; }
      else if (best) { model.quality = qualityName(best); model.qcls = best >= 2160 ? 'is-uhd' : best >= 1080 ? 'is-hd' : 'is-sd'; }
      else { model.quality = '—'; model.qcls = 'is-none'; }
      if (!row.unavailable && best && row.kind === 'online') model.note = row.measured ? 'проверено' : 'заявлено';
      model.pick = hero ? 'Рекомендуем' + (favorite(row) ? ' · любимая озвучка' : row.measured ? ' · проверено' : '') : '';
      if (hero) model.cls += ' is-hero';
      model.sig = [model.voice, model.details, model.quality, model.qcls, model.note, model.pick, model.cls, model.badges.join(',')].join('|');
      return model;
    }
    function fill(tile, model) {
      if (tile.data('sig') === model.sig) return;
      tile.data('sig', model.sig);
      // Swap only the modifier classes so Lampa's own focus class survives.
      tile.removeClass(tile.data('cls') || '').addClass(model.cls).data('cls', model.cls);
      tile.find('.homelab-common-play').html(model.icon);
      tile.find('.homelab-common-pick').text(model.pick).toggleClass('hide', !model.pick);
      tile.find('.homelab-common-voice').text(model.voice);
      tile.find('.homelab-common-details').text(model.details);
      var badges = tile.find('.homelab-common-badges').empty().toggleClass('hide', !model.badges.length);
      model.badges.forEach(function (badge) { badges.append($('<span class="homelab-common-badge ' + badge[1] + '"></span>').text(badge[0])); });
      var badge = tile.find('.homelab-common-q'); badge.removeClass(badge.data('cls') || '').addClass(model.qcls).data('cls', model.qcls).text(model.quality);
      var note = tile.find('.homelab-common-q-note').toggleClass('hide', !model.note).toggleClass('is-measured', model.note === 'проверено').empty();
      if (model.note === 'проверено') note.append($('<span class="homelab-common-check"></span>').html(CHECK));
      if (model.note) note.append($('<span></span>').text(model.note));
    }
    function card(key) {
      var tile = $('<div class="selector homelab-common-result"></div>'), text = $('<div class="homelab-common-text"></div>'), side = $('<div class="homelab-common-quality"></div>');
      text.append($('<div class="homelab-common-pick hide"></div>')).append($('<div class="homelab-common-voice"></div>'))
        .append($('<div class="homelab-common-match hide"></div>').text('Та же студия · название отличается, проверьте версию'))
        .append($('<div class="homelab-common-details"></div>')).append($('<div class="homelab-common-badges hide"></div>'));
      side.append($('<div class="homelab-common-q"></div>')).append($('<div class="homelab-common-q-note hide"></div>'));
      tile.append($('<div class="homelab-common-play"></div>')).append(text).append(side);
      tile.on('hover:focus', function () { last = this; if (!restoringFocus) { locked = true; scroll.update(this, true); } })
        .on('hover:hover hover:touch', function () { locked = true; touch(); })
        .on('hover:enter', function () { touch(); if (models[key]) open(models[key].best); })
        .on('hover:long', function () { touch(); if (models[key]) sourceMenu(models[key]); });
      return tile;
    }
    function rowLine(row) {
      if (row.unavailable) return 'Не отдаёт видео';
      if (row.native) return 'Открыть в источнике';
      if (!row.qualities.length) return 'Качество уточняется';
      return row.qualities.map(qualityName).join(' / ') + (row.kind === 'online' ? row.measured ? ' · проверено' : ' · заявлено' : '');
    }
    // Right / long press: every source behind the card, and the favourite voice toggle.
    function sourceMenu(item) {
      var row = item.best, items = [];
      if (row.release) items.push({title: row.release.Title, subtitle: row.providerName, noenter: true}, {title: 'Смотреть', open: row});
      else item.rows.forEach(function (entry) {
        var extra = entry.voice.indexOf(entry.identityVoice) === 0 ? entry.voice.slice(entry.identityVoice.length).replace(/^\s*·\s*/, '') : '';
        items.push({title: entry.providerName + (extra ? ' · ' + extra : '') + (entry === row && item.rows.length > 1 ? ' · лучший' : ''), subtitle: rowLine(entry), open: entry, selected: entry === row});
      });
      if (!row.native && row.kind === 'online') items.push(favorite(row) ? {title: 'Убрать из любимых', favorite: ''} : {title: '★ Сделать любимой озвучкой', favorite: row.identityVoice});
      var heading = row.release ? 'Раздача' : row.native ? row.providerName : (item.rows.length > 1 ? plural(item.rows.length, SOURCES) + ' · ' : '') + row.identityVoice;
      choose(heading, items, function (value) {
        if (value.open) open(value.open);
        if (typeof value.favorite === 'string') setFavorite(value.favorite);
      });
    }
    function showPlaceholder(state, loading) {
      if (state === placeholderState) { if (placeholder) body.append(placeholder); return; }
      placeholderState = state; if (placeholder) { placeholder.remove(); placeholder = null; }
      if (!state) return;
      if (loading) {
        placeholder = $('<div class="homelab-common-skeletons"></div>');
        for (var i = 0; i < 3; i++) placeholder.append($('<div class="homelab-common-skeleton"></div>'));
      } else {
        placeholder = $('<div class="homelab-common-empty"></div>');
        placeholder.append($('<div class="homelab-common-empty-title"></div>').text(recovery ? 'Других подходящих источников нет' : 'Ничего не нашлось'));
        placeholder.append($('<div class="homelab-common-empty-hint"></div>').text(q ? 'В качестве ' + qualityName(q) + ' вариантов нет — выберите «Все качества»' : kind !== 'all' ? 'Попробуйте «Все» или нажмите «Обновить»' : 'Нажмите «Обновить», чтобы поискать заново'));
      }
      body.append(placeholder);
    }
    function draw() {
      if (dead || !search || sync.scope() !== currentScope) return;
      var candidates = search.rows.filter(function (row) { return (kind === 'all' || row.kind === kind) && (!q || row.kind === 'online' && !row.qualities.length || row.qualities.indexOf(q) >= 0) && (!recovery || !row.native && row.kind === 'online' && row.provider !== recovery.excludeProvider); });
      var exact = recovery && recovery.voice ? candidates.filter(function (row) { return voiceMatch(recovery.voice, row.identityVoice) === 2; }).length : 0;
      function rank(a, b, tie) {
        var match = recovery && recovery.voice ? voiceMatch(recovery.voice, b.identityVoice) - voiceMatch(recovery.voice, a.identityVoice) : 0;
        return match || compareRows(a, b, pref, tie);
      }
      var available = candidates.filter(function (row) { return !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) > 0; }).sort(function (a, b) { return rank(a, b); });
      var showOther = recovery && recovery.voice && candidates.length > 0 && (!exact || last === otherButton[0]);
      otherButton.text('Другие озвучки · ' + candidates.length).toggleClass('hide', !showOther);
      var groups = grouped ? groupRows(available).sort(function (a, b) {
        return rank(a.best, b.best, function () { return b.rows.length - a.rows.length || (b.best.measured ? 1 : 0) - (a.best.measured ? 1 : 0); });
      }) : available.map(function (row) { return {key: 'row:' + row.key, rows: [row], best: row}; });
      var byKey = {}; groups.forEach(function (item) { byKey[item.key] = item; });
      if (!locked) order = groups.map(function (item) { return item.key; });
      else { order = order.filter(function (key) { return !!byKey[key]; }); groups.forEach(function (item) { if (order.indexOf(item.key) < 0) order.push(item.key); }); }
      var items = order.map(function (key) { return byKey[key]; });
      visibleItems = items; models = byKey;
      var loading = search.onlinePending || search.torrentPending;
      showPlaceholder(items.length ? '' : loading ? 'loading' : 'empty:' + q + ':' + kind, loading);
      var wanted = {}, page = items.slice(0, shown);
      page.forEach(function (item, index) {
        wanted[item.key] = true;
        var tile = tiles[item.key] || (tiles[item.key] = card(item.key));
        fill(tile, view(item, index === 0 && !item.best.native && !item.best.unavailable));
        matchLabel(tile, item.best); body.append(tile);
      });
      Object.keys(tiles).forEach(function (key) { if (!wanted[key]) { tiles[key].remove(); delete tiles[key]; } });
      if (items.length > shown) {
        if (!more) more = button('', 'homelab-common-more', function () {
          var first = visibleItems[shown]; shown += 20; draw();
          if (first && tiles[first.key] && L.Controller.own(self)) L.Controller.collectionFocus(tiles[first.key][0], root, true);
        });
        more.text('Показать ещё · ' + (items.length - shown)); body.append(more);
      } else if (more) { more.remove(); more = null; }
      drawStatus(loading, items, available, exact);
      hint.toggleClass('hide', !items.length).text(grouped ? 'ОК — смотреть лучший источник  ·  → или удержание — все источники и ★ любимая озвучка' : 'ОК — смотреть  ·  → или удержание — подробности и ★ любимая озвучка');
      if (L.Controller.own(self)) {
        if (untouched && order.length && tiles[order[0]]) last = tiles[order[0]][0];
        focus(true);
      }
    }
    function drawStatus(loading, items, rows, exact) {
      var found = grouped ? plural(items.length, VARIANTS) + ' · ' + plural(rows.length, SOURCES) : plural(rows.length, VARIANTS), parts = [], providers = search.providers || {total: 0, done: 0};
      if (loading) {
        parts.push('Ищем варианты…');
        if (search.onlinePending) parts.push(providers.total ? 'онлайн: ответили ' + providers.done + ' из ' + providers.total : 'опрашиваем онлайн-источники');
        if (search.torrentPending) parts.push('торренты ищутся');
        if (rows.length) parts.push('найдено ' + found);
      } else {
        parts.push(rows.length ? 'Найдено: ' + found : 'Ничего не найдено');
        if (search.checking()) parts.push('проверяем качество');
        if (search.interrupted) parts.push('Поиск прерван, нажмите «Обновить»');
        if (recovery && recovery.voice && !exact && rows.length) parts.push('Точного совпадения нет; показаны похожие озвучки');
      }
      statusText.text(parts.concat(search.errors).join(' · '));
      status.toggleClass('is-loading', loading).toggleClass('has-errors', !!search.errors.length || !!search.interrupted && !loading);
      // Online answers drive the bar; the last stretch waits for torrents.
      var share = search.onlinePending ? (providers.total ? providers.done / providers.total : 0) * 0.85 + 0.05 : 0.92;
      barFill.css('transform', 'scaleX(' + share.toFixed(3) + ')').css('-webkit-transform', 'scaleX(' + share.toFixed(3) + ')');
    }
    function changed() { if (!refresh) refresh = setTimeout(function () { refresh = null; draw(); }, 150); }
    function cancel() { uiIntent++; clearTimeout(refresh); refresh = null; if (search) search.cancel(); }
    function restart() {
      cancel(); currentScope = sync.scope(); resetList();
      body.empty(); more = null; placeholder = null; placeholderState = ''; selectors();
      search = new Search(Object.assign({}, movie), selection, changed, {torrents: !recovery}); search.start(); draw();
    }
    function visibleNode(node) { return node.offsetParent !== null; }
    function move(dx, dy) {
      touch();
      var all = Array.prototype.filter.call(root[0].querySelectorAll('.selector'), visibleNode), list = Array.prototype.filter.call(body[0].querySelectorAll('.selector'), visibleNode);
      var from = last && root[0].contains(last) && visibleNode(last) ? last : all[0]; if (!from) return;
      var index = list.indexOf(from);
      // Inside the single-column list, Up/Down follow list order (the tile's focus handler scrolls it into view).
      if (index >= 0 && dy && list[index + dy]) return L.Controller.collectionFocus(list[index + dy], root, true);
      if (index >= 0 && dy > 0) return;
      if (index >= 0 && dx < 0) return L.Controller.toggle('menu');
      var view = scroll.render(true).getBoundingClientRect();
      var a = from.getBoundingClientRect(), x = a.left + a.width / 2, y = a.top + a.height / 2, best, distance = Infinity;
      all.forEach(function (node) {
        if (node === from) return; var b = node.getBoundingClientRect(), px = b.left + b.width / 2, py = b.top + b.height / 2;
        // List entries are reachable from outside only while visible; scrolled-out tiles may sit behind the header.
        if (list.indexOf(node) >= 0 && (index >= 0 || !(py >= view.top && py <= view.bottom))) return;
        if (dx && (px - x) * dx <= 1 || dy && (py - y) * dy <= 1) return;
        var along = dx ? Math.abs(px - x) : Math.abs(py - y), across = dx ? Math.abs(py - y) : Math.abs(px - x), score = along + across * 4;
        if (score < distance) { distance = score; best = node; }
      });
      if (best) L.Controller.collectionFocus(best, root, true);
      else if (dy < 0) L.Controller.toggle('head');
      else if (dx < 0) L.Controller.toggle('menu');
    }
    this.create = function () {
      scroll.minus(root.find('.homelab-common-head')); selectors();
      [0, 2160, 1080, 720].forEach(function (value) { tabs.append(button(value ? qualityName(value) : 'Все качества', 'homelab-common-tab' + (value === q ? ' selected' : ''), function () {
        q = value; pref = preferences({quality: value}); shown = 20; locked = false; order = []; scroll.reset(); tabs.find('.selected').removeClass('selected'); $(this).addClass('selected'); draw();
      })); });
    };
    this.render = function (js) { return js ? root[0] : root; };
    this.start = function () {
      if (!active()) return;
      if (sync.scope() !== currentScope) { cancel(); return L.Activity.backward(); }
      L.Controller.add('content', {link: self, invisible: true, toggle: function () { focus(false); }, up: function () { move(0, -1); }, down: function () { move(0, 1); }, left: function () { move(-1, 0); },
        right: function () { touch(); if (last && last.classList.contains('homelab-common-result')) $(last).trigger('hover:long'); else if (!(last && body[0].contains(last))) move(1, 0); }, back: function () { cancel(); L.Activity.backward(); }});
      L.Controller.toggle('content');
      if (!started) { started = true; restart(); }
      else draw();
    };
    this.pause = cancel;
    this.stop = function () {};
    var unsubscribe = sync.subscribe(function () { if (sync.scope() !== currentScope) { cancel(); if (active()) L.Activity.backward(); } });
    this.destroy = function () { dead = true; cancel(); unsubscribe(); scroll.destroy(); root.remove(); };
  }
  function addButton(movie, render, unsupported) {
    if (!movie || !render || render.find('.view--homelab-sources').length) return;
    var container = render.find('.buttons--container'); if (!container.length) return;
    var button = $('<div class="full-start__button selector view--homelab-sources">' + PLAY + '<span>Общий</span></div>');
    button.on('hover:enter', unsupported || function (_, context) {
      L.Activity.push({component: COMPONENT, title: 'Общий', movie: movie, season: context && context.season, page: 1});
    }); container.prepend(button);
  }
  // Movie rows carry the dub in match.translate/text; their voice_name is often a release tag (WEB-DL) that matches no row.
  function sourceVoice(source, card) {
    var match = source && source.match || {}, pick = function (value) { return typeof value === 'string' ? value.trim() : ''; };
    var voice = pick(source && source.voice);
    if (ITEM_TAG.test(voice)) voice = '';
    if (card && !card.name) {
      var text = pick(match.text) || pick(source && source.text);
      if (text && (text === card.title || text === card.original_title)) text = '';
      voice = pick(match.translate) || text || voice;
    }
    return /^(неизвестно|оригинал|по умолчанию|дублированный|озвучка источника)$/i.test(voice) || ITEM_TAG.test(voice) ? '' : voice;
  }
  function resumeSource(item, movie) {
    if (!item || !movie || !Number.isInteger(movie.id) || item.card !== (movie.name ? 'tv_' : 'movie_') + movie.id || L.Player.opened()) return false;
    if (movie.name && (!Number.isInteger(item.season) || item.season < 0 || !Number.isInteger(item.episode) || item.episode <= 0)) return false;
    var voice = sourceVoice(item.online, movie);
    L.Activity.push({component: COMPONENT, title: 'Выбор источника', movie: movie, homelab_recovery: {
      scope: sync.scope(), season: movie.name ? item.season : 0, episode: item.episode || 1, voice: voice, excludeProvider: '',
      position: Number.isFinite(item.position) ? Math.max(0, item.position) : 0,
      duration: Number.isFinite(item.duration) ? item.duration : 0, quality: preferences().quality
    }});
    return true;
  }
  function recover(work, snapshot, sameProvider) {
    if (!snapshot || !work || !work.card || !Number.isInteger(work.card.id) || L.Player.playdata() !== work || !L.Player.opened() || typeof L.Player.close !== 'function') return false;
    if (work.card.name && (!Number.isInteger(work.season) || work.season < 0 || !Number.isInteger(work.episode) || work.episode <= 0)) return false;
    var scope = sync.scope(), activity = L.Activity.active(), source = work.homelab_online, movie = Object.assign({}, work.card), pref = preferences();
    var tracks = L.HomelabGstAudio && L.HomelabGstAudio.preferences ? L.HomelabGstAudio.preferences(work) : work.homelab_track_preferences;
    var voice = sourceVoice(source, work.card) || sourceVoice({voice: tracks && tracks.audio && tracks.audio.title}, work.card);
    var context = {scope: scope, season: work.card.name ? work.season : 0, episode: +work.episode || 1, voice: voice, excludeProvider: source && source.provider || '',
      position: Number.isFinite(snapshot.position) ? Math.max(0, snapshot.position) : 0, duration: Number.isFinite(snapshot.duration) ? snapshot.duration : 0, quality: quality(Object.keys(work.quality || {}).length === 1 ? Object.keys(work.quality)[0] : '') || pref.quality};
    var modal = L.Modal, torrentModal = modal && modal.opened && modal.opened() && modal.render && modal.render().find('.torrent-files').length ? modal.render()[0] : null;
    L.Player.close();
    if (torrentModal && sync.scope() === scope && !L.Player.opened() && L.Activity.active() === activity && modal.opened() && modal.render()[0] === torrentModal) modal.close();
    setTimeout(function () {
      if (sync.scope() !== scope || L.Activity.active() !== activity || L.Player.opened()) return;
      var adapter = window.HomelabOnlineResume;
      if (sameProvider && source && adapter && adapter.valid(source)) {
        if (!adapter.resume({card: (movie.name ? 'tv_' : 'movie_') + movie.id, online: Object.assign({}, source), season: context.season, episode: context.episode, position: context.position}, movie,
          function () { L.Noty.show('Источник не ответил. Выберите другой вариант'); }, {quality: context.quality, fromDuration: context.duration})) L.Noty.show('Откройте источник заново');
      } else L.Activity.push({component: COMPONENT, title: 'Другой источник', movie: movie, homelab_recovery: context});
    }, 0);
    return true;
  }
  $('head').append($('<style></style>').text('.homelab-common{background:#202324;height:100%;display:flex;flex-direction:column;padding:1.4em 2.2em 1em;box-sizing:border-box}.homelab-common-head{display:flex;align-items:baseline;margin-bottom:.9em}.homelab-common-heading{font-size:2.4em;font-weight:600;flex-shrink:0;margin-right:.6em}.homelab-common-movie{font-size:1.3em;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.6}.homelab-common-recovery{font-size:1em;margin:0 0 1em;line-height:1.4;padding:.7em 1em;border-radius:.6em;background:rgba(223,204,162,.12);color:#efe1bf}.homelab-common-controls,.homelab-common-tabs{display:flex;flex-wrap:wrap;align-items:center;margin-bottom:.5em}.homelab-common-controls>*,.homelab-common-tabs>*{margin:0 .6em .5em 0}.homelab-common-chip,.homelab-common-refresh{padding:.6em 1.15em;border-radius:1em;background:rgba(255,255,255,.07)}.homelab-common-static{opacity:.75}.homelab-common-refresh{margin-left:auto;margin-right:0;opacity:.75}.homelab-common-chip.selected{background:rgba(255,255,255,.22)}.homelab-common-favorite{color:#ffd66b}.homelab-common-tab{padding:.45em 1.2em;border-radius:1em;opacity:.7}.homelab-common-tab.selected{opacity:1;background:rgba(255,255,255,.12);box-shadow:inset 0 -.15em 0 #fff}.homelab-common-other-voices{align-self:flex-start;margin-bottom:1em;max-width:100%;box-sizing:border-box}.homelab-common-status{position:relative;display:flex;align-items:center;min-height:1.6em;padding:.2em 0 .5em;margin-bottom:.4em;font-size:1em;opacity:.75}.homelab-common-status.is-loading{opacity:1}.homelab-common-status.has-errors .homelab-common-status-text{color:#f0c27a}.homelab-common-status-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-common-spinner{display:none;width:1em;height:1em;margin-right:.6em;flex-shrink:0;border-radius:100%;border:.15em solid rgba(255,255,255,.2);border-top-color:#fff;-webkit-animation:homelab-common-spin .9s linear infinite;animation:homelab-common-spin .9s linear infinite}.homelab-common-status.is-loading .homelab-common-spinner{display:block}.homelab-common-bar{display:none;position:absolute;left:0;right:0;bottom:0;height:.2em;border-radius:.2em;background:rgba(255,255,255,.08);overflow:hidden}.homelab-common-status.is-loading .homelab-common-bar{display:block}.homelab-common-bar-fill{height:100%;background:#fff;opacity:.8;-webkit-transform-origin:0 50%;transform-origin:0 50%;-webkit-transform:scaleX(0);transform:scaleX(0);-webkit-transition:-webkit-transform .4s;transition:transform .4s}@-webkit-keyframes homelab-common-spin{to{-webkit-transform:rotate(360deg)}}@keyframes homelab-common-spin{to{transform:rotate(360deg)}}@-webkit-keyframes homelab-common-pulse{50%{opacity:.4}}@keyframes homelab-common-pulse{50%{opacity:.4}}.homelab-common>.scroll{flex:1;min-height:0}.homelab-common-list{padding:.3em}.homelab-common-result{position:relative;display:flex;align-items:center;padding:1em 1.3em;background:rgba(255,255,255,.05);border-radius:.8em;margin-bottom:.55em;box-sizing:border-box;min-height:5.3em}.homelab-common-result.is-torrent{background:rgba(120,170,255,.06)}.homelab-common-result.is-native{background:rgba(255,255,255,.03)}.homelab-common-result.is-unavailable{opacity:.45}.homelab-common-result.is-hero{padding:1.35em 1.5em;min-height:6.6em;background:rgba(255,255,255,.1);margin-bottom:.9em}.homelab-common .selector.focus{outline:.16em solid #fff;outline-offset:.12em;background:rgba(255,255,255,.16)}.homelab-common-result.focus{background:#fff;color:#000;outline:0;opacity:1}.homelab-common-play{width:2.2em;height:2.2em;margin-right:1.2em;padding:.35em;box-sizing:border-box;border-radius:100%;background:rgba(255,255,255,.12);flex-shrink:0}.homelab-common-result.is-hero .homelab-common-play{width:2.8em;height:2.8em;background:#fff;color:#000}.homelab-common-result.is-torrent .homelab-common-play{color:#9cc2ff}.homelab-common-result.focus .homelab-common-play{background:#000;color:#fff}.homelab-common-play svg{display:block;width:100%;height:100%}.homelab-common-text{min-width:0;flex:1}.homelab-common-pick{font-size:.8em;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#ffd66b;margin-bottom:.3em}.homelab-common-result.focus .homelab-common-pick{color:#8a5a00}.homelab-common-voice{font-size:1.3em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-common-result.is-hero .homelab-common-voice{font-size:1.55em}.homelab-common-match{font-size:.85em;color:#dfcca2;margin-top:.3em}.homelab-common-result.focus .homelab-common-match{color:#6d5520}.homelab-common-details{font-size:.95em;opacity:.65;margin-top:.35em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-common-badges{margin-top:.45em;white-space:nowrap;overflow:hidden}.homelab-common-badge{display:inline-block;font-size:.8em;padding:.2em .6em;margin-right:.45em;border-radius:.4em;background:rgba(255,255,255,.1)}.homelab-common-badge.is-seeds{color:#8fe3a1}.homelab-common-badge.is-dead{color:#ff9b8f}.homelab-common-result.focus .homelab-common-badge{background:rgba(0,0,0,.1);color:#000}.homelab-common-quality{flex-shrink:0;margin-left:1em;text-align:right;max-width:30%}.homelab-common-q{display:inline-block;font-size:1.15em;font-weight:700;padding:.25em .65em;border-radius:.45em;border:.1em solid rgba(255,255,255,.5);white-space:nowrap}.homelab-common-q.is-uhd{border-color:#ffd66b;color:#ffd66b}.homelab-common-q.is-sd{opacity:.7}.homelab-common-q.is-none{border-color:transparent;opacity:.45}.homelab-common-q.is-off{border-color:transparent;font-size:.9em;color:#ff9b8f}.homelab-common-result.is-hero .homelab-common-q{font-size:1.4em}.homelab-common-result.focus .homelab-common-q{color:#000;border-color:#000}.homelab-common-result.focus .homelab-common-q.is-none,.homelab-common-result.focus .homelab-common-q.is-off{border-color:transparent}.homelab-common-q-note{font-size:.78em;opacity:.6;margin-top:.35em;white-space:nowrap}.homelab-common-q-note.is-measured{opacity:1;color:#8fe3a1}.homelab-common-result.focus .homelab-common-q-note.is-measured{color:#1d7a33}.homelab-common-check{display:inline-block;width:1.1em;height:1.1em;vertical-align:-.2em;margin-right:.2em}.homelab-common-check svg{display:block;width:100%;height:100%}.homelab-common-more{padding:1em;text-align:center;border-radius:.8em;background:rgba(255,255,255,.04)}.homelab-common-skeleton{height:5.3em;margin-bottom:.55em;border-radius:.8em;background:rgba(255,255,255,.06);-webkit-animation:homelab-common-pulse 1.4s ease-in-out infinite;animation:homelab-common-pulse 1.4s ease-in-out infinite}.homelab-common-skeleton:first-child{height:6.6em}.homelab-common-empty{padding:3em 1em;text-align:center}.homelab-common-empty-title{font-size:1.5em;font-weight:600;margin-bottom:.5em}.homelab-common-empty-hint{opacity:.6}.homelab-common-hint{font-size:.85em;opacity:.45;padding-top:.6em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-common .hide{display:none}@media(max-width:600px){.homelab-common{padding:1em}.homelab-common-result{padding:.9em}.homelab-common-play{margin-right:.7em;width:1.8em;height:1.8em}.homelab-common-q{font-size:1em}.homelab-common-movie{font-size:1em}.homelab-common-chip,.homelab-common-tab{padding:.55em .9em}.homelab-common-hint{display:none}}'));
  L.Component.add(COMPONENT, Common);
  L.Listener.follow('full', function (event) { if (event.type === 'complite') addButton(event.data.movie, event.object.activity.render()); });
  var active = L.Activity.active(); if (active && active.component === 'full' && active.activity) addButton(active.card, active.activity.render());
  window.HomelabSources = {Search: Search, quality: quality, voiceMatch: voiceMatch, preferences: preferences, describeRelease: describeRelease, compareRows: compareRows, groupRows: groupRows, resume: resumeSource, recover: recover};
})();
