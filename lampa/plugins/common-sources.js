(function install() {
  'use strict';
  if (!window.appready) {
    if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
    return;
  }
  var L = window.Lampa, sync = window.HomelabSync, $ = window.$;
  var COMPONENT = 'homelab_sources', PLAY = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  if (window.HomelabSources || !L || !sync || !$) return;
  if (!window.fetch || typeof URL !== 'function' || !('searchParams' in URL.prototype) || typeof Promise !== 'function' || !L.Component || !L.Component.add || !L.Parser || !L.Parser.get || !L.Parser.clear || !L.Scroll || !L.Controller || !L.Controller.collectionFocus) {
    // Very old TV webviews keep a visible button that explains why instead of silently missing.
    window.HomelabSources = {unsupported: true};
    if (L.Listener && L.Noty) L.Listener.follow('full', function (event) {
      if (event.type === 'complite') addButton(event.data.movie, event.object.activity.render(), function () { L.Noty.show('Общий недоступен на этом устройстве: браузер ТВ устарел. Используйте обычные источники'); });
    });
    return;
  }
  var parserOwner = null, nextRequestAt = 0;
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
  function compareRows(a, b, pref) {
    function favorite(row) { return pref.voice && !row.native && voiceKey(row.identityVoice || row.voice) === voiceKey(pref.voice) ? 1 : 0; }
    var match = favorite(b) - favorite(a); if (match) return match;
    function group(row) { return row.native ? 2 : row.kind === 'online' ? 0 : 1; }
    match = group(a) - group(b); if (match) return match;
    if (a.release && b.release) { match = (Number(b.release.Seeders) || 0) - (Number(a.release.Seeders) || 0); if (match) return match; }
    match = (b.qualities[0] || 0) - (a.qualities[0] || 0);
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
    this.rows = []; this.onlinePending = true; this.torrentPending = false; this.errors = []; this.interrupted = false;
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
    function settle() { self.onlinePending = live() && (!discoveryDone || running > 0 || queue.length > 0 || voiceQueue.length > 0); notify(); }
    function pump() {
      if (!live()) return;
      while (running < 2 && (queue.length || voiceQueue.length)) {
        if (Date.now() >= deadline) { queue.splice(0).concat(voiceQueue.splice(0)).forEach(function (job) { fallback(job.source, 'Другие варианты в источнике'); }); break; }
        (function (job) {
          running++;
          always(request(job.url, false).then(function (text) { catalog(job, text); }).catch(function () { if (live()) fallback(job.source); }), function () { running--; pump(); settle(); });
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
      alive = false; timers.forEach(clearTimeout); clearTimeout(parserTimer); requests.forEach(function (abort) { abort.abort(); }); queue = []; voiceQueue = [];
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
  function Common(object) {
    var self = this, movie = movieCard(object.movie), tv = !!movie.name, saved = window.homelabContinue && window.homelabContinue.list().find(function (item) { return item.card === (tv ? 'tv_' : 'movie_') + movie.id; });
    var recovery = object.homelab_recovery, pref = preferences();
    if (recovery && recovery.scope !== sync.scope()) recovery = null;
    var season = Number.isInteger(object.season) && object.season >= 0 ? object.season : saved && Number.isInteger(saved.season) && saved.season >= 0 ? saved.season : 1;
    var selection = recovery ? {season: recovery.season, episode: recovery.episode} : {season: season, episode: saved && saved.season === season && saved.episode || 1};
    var root = $('<div class="homelab-common"></div>'), head = $('<div class="homelab-common-head"></div>'), controls = $('<div class="homelab-common-controls"></div>'), tabs = $('<div class="homelab-common-tabs"></div>');
    var status = $('<div class="homelab-common-status" aria-live="polite"></div>'), body = $('<div class="homelab-common-list"></div>'), scroll = new L.Scroll({mask: true, over: true});
    var search, last = null, kind = recovery ? 'online' : 'all', q = recovery ? 0 : pref.quality, tiles = {}, shown = 20, visibleRows = [], order = [], locked = false, restoringFocus = false, more = null, dead = false, started = false, refresh, uiIntent = 0, currentScope = sync.scope();
    var title = $('<div class="homelab-common-heading"></div>').text('Общий'), label = $('<div class="homelab-common-movie"></div>').text(movie.title || movie.name || '');
    head.append(title).append(label); root.append(head).append(controls).append(tabs).append(status);
    var otherButton = button('', 'homelab-common-chip homelab-common-other-voices hide', otherVoices); root.append(otherButton);
    body.appendTo(scroll.body()); root.append(scroll.render());
    var recoveryLabel = recovery ? $('<div class="homelab-common-recovery"></div>') : null;
    function recoveryText() { if (recoveryLabel) recoveryLabel.text('Продолжить с ' + L.Utils.secondsToTime(recovery.position) + (recovery.voice ? ' · ' + recovery.voice : ' · Выберите озвучку') + '. Тайминги разных версий могут отличаться'); }
    if (recoveryLabel) { head.after(recoveryLabel); recoveryText(); }
    function active() { return !dead && L.Activity.active() === object; }
    function focus(background) { restoringFocus = !!background; L.Controller.collectionSet(root, false, true); L.Controller.collectionFocus(last && root[0].contains(last) ? last : false, root, true); restoringFocus = false; }
    function button(text, cls, fn) {
      return $('<div class="selector ' + cls + '"></div>').text(text).on('hover:focus', function () { last = this; if (!restoringFocus && body[0].contains(this)) scroll.update(this, true); }).on('hover:enter', fn);
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
    function otherVoices() {
      if (!recovery || !active() || sync.scope() !== currentScope) return;
      recovery.voice = ''; recoveryText(); locked = false; order = []; shown = 20; last = null; scroll.reset(); selectors(); draw();
      if (L.Controller.own(self)) focus(true);
    }
    function matchLabel(tile, row) {
      tile.find('.homelab-common-match').toggleClass('hide', !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) !== 1);
    }
    function selectors() {
      controls.empty();
      if (tv && recovery) {
        controls.append($('<div class="homelab-common-chip"></div>').text('Сезон ' + selection.season + ' · Серия ' + selection.episode));
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
            choose('Серия', (data.episodes || []).map(function (episode) { return {title: episode.episode_number + ' · ' + episode.name, value: episode.episode_number}; }), function (value) { selection.episode = value.value; restart(); });
          }, function () { if (active()) L.Noty.show('Не удалось получить список серий'); });
        }));
      }
      [['all', 'Все'], ['online', 'Онлайн'], ['torrent', 'Торренты']].forEach(function (value) {
        if (recovery && value[0] === 'torrent') return;
        controls.append(button(value[1], 'homelab-common-chip homelab-common-kind' + (kind === value[0] ? ' selected' : ''), function () {
          kind = value[0]; shown = 20; locked = false; order = []; scroll.reset(); controls.find('.homelab-common-kind.selected').removeClass('selected'); $(this).addClass('selected'); draw();
        }));
      });
      if (recovery && recovery.voice) controls.append(button('Озвучка: ' + recovery.voice, 'homelab-common-chip', function () {
        choose('Озвучка для другого источника', [{title: 'Сохранить ту же озвучку', keep: true}, {title: 'Выбрать другую вручную'}], function (value) {
          if (!value.keep) otherVoices();
        });
      }));
      if (!recovery) controls.append(button('Любимая: ' + (pref.voice || 'не выбрана'), 'homelab-common-chip homelab-common-favorite', function () {
        var voices = search ? search.rows.filter(function (row) { return row.kind === 'online' && !row.native; }).map(function (row) { return row.identityVoice; }).filter(Boolean) : [];
        if (pref.voice) voices.push(pref.voice);
        voices = voices.filter(function (voice, index) { return voices.indexOf(voice) === index; }).sort();
        choose('Любимая озвучка — показывать выше', [{title: 'Не выделять', value: ''}].concat(voices.map(function (voice) { return {title: voice, value: voice}; })), function (value) {
          pref = preferences({voice: value.value}); locked = false; order = []; shown = 20; scroll.reset(); selectors(); draw();
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
    function draw() {
      if (dead || !search || sync.scope() !== currentScope) return;
      var candidates = search.rows.filter(function (row) { return (kind === 'all' || row.kind === kind) && (!q || row.kind === 'online' && !row.qualities.length || row.qualities.indexOf(q) >= 0) && (!recovery || !row.native && row.kind === 'online' && row.provider !== recovery.excludeProvider); });
      var exact = recovery && recovery.voice ? candidates.filter(function (row) { return voiceMatch(recovery.voice, row.identityVoice) === 2; }).length : 0;
      var available = candidates.filter(function (row) { return !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) > 0; }).sort(function (a, b) {
        var match = recovery && recovery.voice ? voiceMatch(recovery.voice, b.identityVoice) - voiceMatch(recovery.voice, a.identityVoice) : 0;
        return match || compareRows(a, b, pref);
      });
      var showOther = recovery && recovery.voice && candidates.length > 0 && (!exact || last === otherButton[0]);
      otherButton.text('Другие озвучки · ' + candidates.length).toggleClass('hide', !showOther);
      var byKey = {}; available.forEach(function (row) { byKey[row.key] = row; });
      if (!locked) order = available.map(function (row) { return row.key; });
      else { order = order.filter(function (key) { return !!byKey[key]; }); available.forEach(function (row) { if (order.indexOf(row.key) < 0) order.push(row.key); }); }
      var rows = order.map(function (key) { return byKey[key]; });
      visibleRows = rows;
      var wanted = {}, page = rows.slice(0, shown);
      page.forEach(function (row) {
        wanted[row.key] = true;
        if (tiles[row.key]) { tiles[row.key].find('.homelab-common-voice').text((pref.voice && !row.native && voiceKey(row.identityVoice) === voiceKey(pref.voice) ? '★ ' : '') + row.voice); matchLabel(tiles[row.key], row); body.append(tiles[row.key]); return; }
        var tile = $('<div class="selector homelab-common-result"></div>'), icon = $('<div class="homelab-common-play"></div>').html(PLAY), text = $('<div class="homelab-common-text"></div>');
        text.append($('<div class="homelab-common-voice"></div>').text((pref.voice && !row.native && voiceKey(row.identityVoice) === voiceKey(pref.voice) ? '★ ' : '') + row.voice));
        text.append($('<div class="homelab-common-match hide"></div>').text('Та же студия · название отличается, проверьте версию')); matchLabel(tile.append(text), row);
        var details = row.providerName + ' · ' + (row.kind === 'torrent' ? 'Торрент' : 'Онлайн');
        if (row.release) {
          var codec = describeRelease(row.release).codec; if (codec) details += ' · ' + codec;
          var size = Number(row.release.Size || row.release.size); if (size > 0) details += ' · ' + (size / 1073741824).toFixed(1).replace('.', ',') + ' ГБ';
          if (Number.isFinite(+row.release.Seeders)) details += ' · ' + (+row.release.Seeders) + ' сидов';
          if (tv) details += ' · Выбор серии в раздаче';
        } else if (!row.qualities.length) details += row.native ? ' · Качество неизвестно · Открыть источник' : ' · Качество уточняется';
        text.append($('<div class="homelab-common-details"></div>').text(details));
        tile.prepend(icon).append($('<div class="homelab-common-quality"></div>').text(row.qualities.length ? row.qualities.map(function (n) { return n === 2160 ? '4K' : n + 'p'; }).join(' / ') : '—'));
        tile.on('hover:focus', function () { last = this; if (!restoringFocus) { locked = true; scroll.update(this, true); } })
          .on('hover:hover hover:touch', function () { locked = true; })
          .on('hover:enter', function () { open(row); }).on('hover:long', function () { detailsMenu(row); });
        tiles[row.key] = tile; body.append(tile);
      });
      Object.keys(tiles).forEach(function (key) { if (!wanted[key]) { tiles[key].remove(); delete tiles[key]; } });
      if (rows.length > shown) {
        if (!more) more = button('', 'homelab-common-more', function () {
          var first = visibleRows[shown]; shown += 20; draw();
          if (first && tiles[first.key] && L.Controller.own(self)) L.Controller.collectionFocus(tiles[first.key][0], root, true);
        });
        more.text('Ещё варианты · ' + (rows.length - shown)); body.append(more);
      } else if (more) { more.remove(); more = null; }
      var loading = search.onlinePending || search.torrentPending;
      status.text((loading ? 'Ищем варианты… · ' : '') + 'Найдено: ' + rows.length + (search.interrupted && !loading ? ' · Поиск прерван, нажмите «Обновить»' : '') + (!loading && recovery && recovery.voice && !exact ? rows.length ? ' · Точного совпадения нет; показаны похожие озвучки' : ' · Других подходящих источников нет' : !loading && !rows.length ? ' · Попробуйте другое качество или источник' : '') + (search.errors.length ? ' · ' + search.errors.join(' · ') : ''));
      if (L.Controller.own(self)) focus(true);
    }
    function detailsMenu(row) {
      var items = [{title: row.release ? row.release.Title : row.voice, subtitle: row.providerName, noenter: true}, {title: 'Открыть', open: true}];
      if (!row.native && row.kind === 'online') items.push({title: 'Сделать любимой озвучкой', favorite: true});
      choose('Подробности', items, function (item) {
        if (item.open) open(row);
        if (item.favorite) { pref = preferences({voice: row.identityVoice}); Object.keys(tiles).forEach(function (key) { tiles[key].remove(); }); tiles = {}; locked = false; order = []; shown = 20; last = null; scroll.reset(); selectors(); draw(); }
      });
    }
    function changed() { if (!refresh) refresh = setTimeout(function () { refresh = null; draw(); }, 150); }
    function cancel() { uiIntent++; clearTimeout(refresh); refresh = null; if (search) search.cancel(); }
    function restart() {
      cancel(); currentScope = sync.scope(); Object.keys(tiles).forEach(function (key) { tiles[key].remove(); }); tiles = {}; shown = 20;
      body.empty(); scroll.reset(); more = null; order = []; locked = false; last = null; selectors();
      search = new Search(Object.assign({}, movie), selection, changed, {torrents: !recovery}); search.start(); draw();
    }
    function visibleNode(node) { return node.offsetParent !== null; }
    function move(dx, dy) {
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
      [0, 2160, 1080, 720].forEach(function (value) { tabs.append(button(value ? value === 2160 ? '4K' : value + 'p' : 'Все качества', 'homelab-common-tab' + (value === q ? ' selected' : ''), function () {
        q = value; pref = preferences({quality: value}); shown = 20; locked = false; order = []; scroll.reset(); tabs.find('.selected').removeClass('selected'); $(this).addClass('selected'); draw();
      })); });
    };
    this.render = function (js) { return js ? root[0] : root; };
    this.start = function () {
      if (!active()) return;
      if (sync.scope() !== currentScope) { cancel(); return L.Activity.backward(); }
      L.Controller.add('content', {link: self, invisible: true, toggle: function () { focus(false); }, up: function () { move(0, -1); }, down: function () { move(0, 1); }, left: function () { move(-1, 0); }, right: function () { if (last && last.classList.contains('homelab-common-result')) $(last).trigger('hover:long'); else if (!(last && body[0].contains(last))) move(1, 0); }, back: function () { cancel(); L.Activity.backward(); }});
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
  function resumeSource(item, movie) {
    if (!item || !movie || !Number.isInteger(movie.id) || item.card !== (movie.name ? 'tv_' : 'movie_') + movie.id || L.Player.opened()) return false;
    if (movie.name && (!Number.isInteger(item.season) || item.season < 0 || !Number.isInteger(item.episode) || item.episode <= 0)) return false;
    var voice = item.online && typeof item.online.voice === 'string' ? item.online.voice : '';
    if (/^(неизвестно|оригинал|по умолчанию|дублированный|озвучка источника)$/i.test(voice)) voice = '';
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
    var voice = source && source.voice || tracks && tracks.audio && tracks.audio.title || '';
    if (/^(неизвестно|оригинал|по умолчанию|дублированный|озвучка источника)$/i.test(voice)) voice = '';
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
  $('head').append($('<style></style>').text('.homelab-common{background:#202324;height:100%;display:flex;flex-direction:column;padding:1.4em 2.2em;box-sizing:border-box}.homelab-common-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:1em;gap:1em}.homelab-common-recovery{font-size:1em;opacity:.8;margin:0 0 1em;line-height:1.4}.homelab-common-heading{font-size:2.4em;font-weight:600}.homelab-common-movie{font-size:1.3em;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75}.homelab-common-controls,.homelab-common-tabs{display:flex;gap:.6em;flex-wrap:wrap;margin-bottom:1em}.homelab-common-chip,.homelab-common-refresh{padding:.65em 1.2em;border-radius:.6em;background:rgba(255,255,255,.07)}.homelab-common-refresh{margin-left:auto;opacity:.7}.homelab-common-chip.selected{background:rgba(255,255,255,.2)}.homelab-common-tab{padding:.5em 1.3em;border-bottom:.15em solid transparent}.homelab-common-tab.selected{border-color:#fff}.homelab-common-other-voices{align-self:flex-start;margin-bottom:1em;max-width:100%;box-sizing:border-box}.homelab-common-match{font-size:.85em;color:#dfcca2;margin-top:.3em}.homelab-common-status{font-size:.9em;opacity:.6;margin-bottom:.8em;min-height:1.1em}.homelab-common>.scroll{flex:1;min-height:0}.homelab-common-list{padding:.3em}.homelab-common-result{display:flex;align-items:center;gap:1.2em;padding:1em 1.3em;background:rgba(255,255,255,.045);border-radius:.65em;margin-bottom:.5em;box-sizing:border-box;min-height:5.3em}.homelab-common .selector.focus{outline:.16em solid #fff;outline-offset:.12em;background:rgba(255,255,255,.12)}.homelab-common-play{width:2em;height:2em;border:.08em solid rgba(255,255,255,.7);border-radius:100%;flex-shrink:0}.homelab-common-play svg{width:100%;height:100%}.homelab-common-text{min-width:0;flex:1}.homelab-common-voice{font-size:1.3em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-common-details{font-size:.95em;opacity:.65;margin-top:.35em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-common-quality{font-size:1.25em;font-weight:600;max-width:25%;text-align:right}.homelab-common-more{padding:1em;text-align:center;border-radius:.5em}@media(max-width:600px){.homelab-common{padding:1em}.homelab-common-result{gap:.7em;padding:.9em}.homelab-common-quality{font-size:1em}.homelab-common-play{width:1.5em;height:1.5em}.homelab-common-movie{font-size:1em}.homelab-common-chip,.homelab-common-tab{padding:.6em .9em}}'));
  L.Component.add(COMPONENT, Common);
  L.Listener.follow('full', function (event) { if (event.type === 'complite') addButton(event.data.movie, event.object.activity.render()); });
  var active = L.Activity.active(); if (active && active.component === 'full' && active.activity) addButton(active.card, active.activity.render());
  window.HomelabSources = {Search: Search, quality: quality, voiceMatch: voiceMatch, preferences: preferences, describeRelease: describeRelease, compareRows: compareRows, resume: resumeSource, recover: recover};
})();
