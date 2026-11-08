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
  // probeCache: per page session, bounded, 30 min TTL; reopening the picker reuses measured qualities and own 404/410s.
  // paceAt: per-provider pacing, so one slow or strict provider never holds the others back.
  var parserOwner = null, paceAt = {}, probeCache = {keys: [], values: {}}, idsCache = {}, CATALOG_PARALLEL = 5, PACE = 350;
  function paced(provider) {
    if (!provider) return 0;
    var delay = Math.max(0, (paceAt[provider] || 0) - Date.now()); paceAt[provider] = Date.now() + delay + PACE; return delay;
  }
  // Tizen/webOS <= 5 lack AbortController; their fetch ignores the signal, and request() rejects on abort itself.
  function Abort() {
    if (window.AbortController) return new window.AbortController();
    var listeners = [], signal = {aborted: false, addEventListener: function (name, fn) { if (name === 'abort') listeners.push(fn); }};
    return {signal: signal, abort: function () { if (signal.aborted) return; signal.aborted = true; listeners.splice(0).forEach(function (fn) { fn(); }); }};
  }
  function always(promise, fn) { return promise.then(function (value) { fn(); return value; }, function (error) { fn(); throw error; }); }
  var ITEM_TAG = /^(?:web[\s-]?dl|webrip|hdrip|bdrip|blu[\s-]?ray|hdtv|camrip|ts|4k|uhd|hdr|sdr|\d{3,4}[pi])$/i;
  function voiceKey(value) { return String(value || '').toLowerCase().replace(/[\s._-]+/g, ' ').trim(); }
  // Whole-label studio aliases (normalized: lower case, ё→е, punctuation to spaces) and a display name.
  var STUDIOS = {
    kubik: ['Кубик в Кубе', 'кубик в кубе', 'kubik v kube', 'kubikvkube'],
    rhs: ['Red Head Sound', 'red head sound', 'redheadsound', 'rhs'],
    hdrezka: ['HDRezka', 'hdrezka', 'hdrezka studio', 'hd rezka', 'hd rezka studio', 'rezka', 'резка'],
    lostfilm: ['LostFilm', 'lostfilm', 'lost film', 'lostfilm tv'],
    alexfilm: ['AlexFilm', 'alexfilm', 'alex film'], newstudio: ['NewStudio', 'newstudio', 'new studio'],
    ultradox: ['Ultradox', 'ultradox', 'ультрадокс'], leproduction: ['LE-Production', 'le production', 'leproduction'],
    anilibria: ['AniLibria', 'anilibria', 'anilibria tv', 'анилибрия'],
    jaskier: ['Jaskier', 'jaskier', 'ясkier', 'яскер'], tvshows: ['TVShows', 'tvshows', 'tv shows'],
    pifagor: ['Пифагор', 'пифагор', 'pifagor'], kravec: ['Кравец', 'кравец', 'kravec', 'кравец records'],
    coldfilm: ['ColdFilm', 'coldfilm', 'cold film'], baibako: ['BaibaKo', 'baibako'], amedia: ['Amedia', 'amedia'],
    ideafilm: ['IdeaFilm', 'ideafilm', 'idea film'], novamedia: ['NovaMedia', 'novamedia', 'nova media'],
    kurazh: ['Кураж-Бамбей', 'кураж бамбей', 'kurazh bambey'], viruseproject: ['ViruseProject', 'viruseproject'],
    anidub: ['AniDub', 'anidub'], animevost: ['AnimeVost', 'animevost'], dreamcast: ['DreamCast', 'dreamcast'],
    sovetromantica: ['SovetRomantica', 'sovetromantica'], studioband: ['Studio Band', 'studio band', 'studioband'],
    flarrow: ['Flarrow Films', 'flarrow films', 'flarrow'], ledoyen: ['LeDoyen', 'ledoyen', 'le doyen'],
    gaevsky: ['Гаевский', 'гаевский', 'gaevsky'], gavrilov: ['Гаврилов', 'гаврилов', 'gavrilov'],
    volodarsky: ['Володарский', 'володарский', 'volodarsky'], sdi: ['SDI Media', 'sdi media', 'sdi'],
    netflix: ['Netflix', 'netflix'], pazl: ['Pazl Voice', 'pazl voice', 'pazl'], tvin: ['TVIN', 'tvin']
  };
  function normalized(value) {
    return voiceKey(value).replace(/ё/g, 'е')
      .replace(/(?:^|\s|[\[(])(?:0|6|12|16|18)\+([\])]|(?=\s|$))/g, ' ')
      .replace(/[^a-zа-я0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function studioOf(text) {
    return Object.keys(STUDIOS).find(function (key) { return STUDIOS[key].indexOf(text, 1) >= 1; }) || '';
  }
  function voiceStudio(value) {
    var text = normalized(value)
      .replace(/(?:^|\s)(?:4[kк]|2160p|1080p|720p|480p|hdr|uhd)(?=\s|$)/g, ' ')
      .replace(/(?:профессиональный|любительский)\s+(?:многоголосый|двухголосый|одноголосый)|дублированный|дубляж/g, ' ')
      .replace(/\s+/g, ' ').trim();
    // Whole-label aliases only: unknown or combined studios stay manual choices.
    return studioOf(text);
  }
  var LANGUAGES = [['RU', /^(?:рус(?:ский|ская|ское)?|ru|rus|russian)$/], ['UK', /^(?:укр(?:аинский|аинская)?|uk|ua|ukr|ukrainian)$/],
    ['EN', /^(?:англ(?:ийский|ийская)?|en|eng|english)$/], ['KZ', /^(?:каз(?:ахский)?|kz|kaz)$/], ['JA', /^(?:японский|ja|jp|jpn|japanese)$/]];
  var TYPES = [['Дубляж', /^(?:дублированный|дублированная|дубляж|dub|лицензия|license)$/], ['Многоголосый', /^(?:многоголосый|многоголосая|mvo)$/],
    ['Двухголосый', /^(?:двухголосый|двухголосая|dvo)$/], ['Любительский', /^(?:любительский|любительская)$/],
    ['Авторский', /^(?:авторский|авторская|одноголосый|одноголосая|avo)$/], ['Оригинал', /^(?:оригинал|оригинальный|оригинальная|original|orig)$/]];
  // Tracker shorthand, only inside release names.
  var CODES = [['Дубляж', /^d$/], ['Многоголосый', /^p\d?$/], ['Любительский', /^l\d?$/], ['Авторский', /^(?:a|vo)$/]];
  // A voice label split into studio, type and language; key groups the same voice across providers and spellings.
  function canonVoice(value) {
    var raw = String(value || '').trim(), text = normalized(raw), result = {studio: '', type: '', lang: '', subs: false, key: '', label: raw};
    if (!text) { result.key = ''; return result; }
    var studio = studioOf(text), words = text.split(' '), rest = [];
    if (!studio) {
      words.forEach(function (word) {
        var lang = LANGUAGES.find(function (entry) { return entry[1].test(word); }), type = TYPES.find(function (entry) { return entry[1].test(word); });
        if (/^(?:субтитры|subs?|subtitles)$/.test(word)) result.subs = true;
        else if (lang) result.lang = result.lang || lang[0];
        else if (type) result.type = result.type || type[0];
        else if (!/^(?:профессиональный|любительский|озвучка|перевод|голос|закадровый|закадровая|studio|studios|студия|tv|records|version|версия)$/.test(word)) rest.push(word);
      });
      var leftover = rest.join(' ');
      // A language next to a studio stays part of its identity: "HDRezka Studio (Украинский)".
      result.studio = studioOf(leftover) || (leftover ? 'text:' + leftover : '');
    } else result.studio = studio;
    if (result.subs && !result.type) result.type = 'Оригинал';
    if (result.studio) {
      var known = STUDIOS[result.studio];
      result.label = known ? known[0] + (result.lang && result.lang !== 'RU' ? ' · ' + result.lang : '') : raw;
      result.key = 'studio:' + result.studio + ':' + (result.lang === 'RU' ? '' : result.lang);
    } else {
      var LANG_NAMES = {RU: 'Русский', UK: 'Украинский', EN: 'Английский', KZ: 'Казахский', JA: 'Японский'};
      result.label = [result.type, LANG_NAMES[result.lang] || ''].filter(Boolean).join(' · ') || raw;
      // A bare language or filler ("Русский", "Озвучка") says nothing about the voice: such rows stay apart.
      result.key = result.type ? 'type:' + result.type + ':' + (result.lang === 'RU' ? '' : result.lang) + (result.subs ? ':subs' : '') : '';
    }
    return result;
  }
  // Release names on Russian trackers list their voices after the title: "| D, P, A |", "Дубляж, LeDoyen", "Лицензия".
  function releaseVoices(title) {
    var text = String(title || ''), found = [], parts = text.split(/[|\[\]]/).slice(1);
    parts.forEach(function (part) {
      part.split(/[,+\/]|\s+и\s+/).forEach(function (token) {
        var value = token.trim(); if (!value || value.length > 40) return;
        var word = normalized(value), studio = studioOf(word), type = TYPES.concat(CODES).find(function (entry) { return entry[1].test(word); });
        if (studio) found.push(STUDIOS[studio][0]);
        else if (type && type[0] !== 'Оригинал') found.push(type[0] === 'Дубляж' && /лиценз|license/.test(word) ? 'Дубляж (лицензия)' : type[0]);
        else if (/^(?:sub|subs|субтитры)$/.test(word)) found.push('Субтитры');
        else if (/^(?:eng|original|оригинал)$/.test(word)) found.push('Оригинал');
      });
    });
    return found.filter(function (voice, index) { return found.indexOf(voice) === index; });
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
    var stored = scope ? L.Storage.get(key, {}) : {}, value = {quality: 0};
    if (stored && [0, 2160, 1080, 720].indexOf(stored.quality) >= 0) value.quality = stored.quality;
    if (update) {
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
    if (!voices.length) voices = releaseVoices(release.Title);
    voices = voices.filter(function (voice, i) { return voices.indexOf(voice) === i; });
    // Audio track languages: "RU×3 · EN".
    var counts = {}, langs = [];
    streams.filter(function (s) { return s.codec_type === 'audio'; }).forEach(function (s) {
      var code = String((s.tags || {}).language || '').toLowerCase(), lang = LANGUAGES.find(function (entry) { return entry[1].test(code); });
      var name = lang ? lang[0] : /^[a-z]{2,3}$/.test(code) && code !== 'und' ? code.toUpperCase() : '';
      if (name) { if (!counts[name]) langs.push(name); counts[name] = (counts[name] || 0) + 1; }
    });
    var languages = langs.map(function (name) { return counts[name] > 1 ? name + '×' + counts[name] : name; }).join(' · ');
    var video = streams.find(function (s) { return s.codec_type === 'video'; }), codec = video && video.codec_name || (String(release.Title || '').match(/\b(?:HEVC|AVC|AV1|H[. ]?26[45]|x26[45]|VP9)\b/i) || [''])[0];
    codec = /hevc|265/i.test(codec) ? 'HEVC' : /avc|264/i.test(codec) ? 'AVC' : String(codec).toUpperCase();
    return {title: voices.length ? voices.slice(0, 2).join(' / ') + (voices.length > 2 ? ' +' + (voices.length - 2) : '') : languages ? 'Дорожки: ' + languages : 'Озвучка не указана', codec: codec, voices: voices, languages: languages};
  }
  // Voices read from a release's audio tracks by the extaudio sidecar, by info hash, for this app run.
  var releaseVoiceCache = {};
  function magnetKey(link) { var match = /[?&]xt=urn:btih:([0-9a-z]{32,40})/i.exec(String(link || '')); return match ? match[1].toLowerCase() : ''; }
  function applyReleaseVoices(row, value) {
    var release = row.release;
    release.info = Object.assign({}, release.info || {});
    if (value.voices.length) release.info.voices = value.voices.slice();
    if (!Array.isArray(release.ffprobe) && !(release.ffprobe && release.ffprobe.streams) && value.languages.length) {
      release.ffprobe = value.languages.map(function (language) { return {codec_type: 'audio', tags: {language: language}}; });
    }
    var described = row.described = describeRelease(release);
    row.voice = described.title; row.voiceProbe = 'done';
    row.canon = described.voices.length ? canonVoice(described.voices[0]) : {key: '', label: described.title, subs: false};
  }
  // Torrents: enough seeds to stream is a threshold; above it the picture quality decides, then the seeds.
  var MIN_SEEDS = 3;
  function seeded(row) { return row.release && (Number(row.release.Seeders) || 0) >= MIN_SEEDS ? 1 : 0; }
  // tie (optional) breaks equal-quality rows before the name order; groups use it for their source count.
  function compareRows(a, b, tie) {
    var match = (a.unavailable ? 1 : 0) - (b.unavailable ? 1 : 0); if (match) return match;
    function group(row) { return row.native ? 2 : row.kind === 'online' ? 0 : 1; }
    match = group(a) - group(b); if (match) return match;
    if (a.release && b.release) { match = seeded(b) - seeded(a); if (match) return match; }
    match = (b.qualities[0] || 0) - (a.qualities[0] || 0); if (match) return match;
    if (a.release && b.release) { match = (Number(b.release.Seeders) || 0) - (Number(a.release.Seeders) || 0); if (match) return match; }
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
  var UNNAMED = 'Без названия', SEARCH_TTL = 10 * 60000, searchCache = {keys: [], values: {}};
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
    var cacheKey = [scope, movie.name ? 'tv' : 'movie', movie.id, selection.season, selection.episode, options.torrents === false ? 0 : 1].join('|');
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
    // Rows without quality ask their source once, after the catalog is done: the call JSON or the HLS master
    // (RESOLUTION) gives the real height. The UI asks only for each voice card's leader (at most 12 per search) and,
    // lazily, for the alternatives of a card whose source list is opened (24 in total). Only an own-Lampac 404/410 or an
    // explicit "not found" error means the source hands out no video; auth/quota answers (401/403, accsdb, other
    // errors), rch/ws handshakes, timeouts and foreign CDN refusals change nothing. Media is never read.
    var probeQueue = [], probing = 0, probes = 0, leaders = 0, probeUrls = {}, probed = {}, PROBE_TTL = 30 * 60000;
    function probeApply(row, value) {
      if (value.unavailable) row.unavailable = true;
      else { row.qualities = value.qualities.slice(); row.measured = true; }
    }
    function probeCached(key) {
      var entry = probeCache.values[key];
      if (entry && Date.now() - entry.at < PROBE_TTL) return entry.value;
    }
    // Catalog rows only remember where they could be probed; a cached answer applies at once without a request.
    function probeable(row, raw) {
      // Without a native AbortController a hung or media response could not be stopped: skip probing entirely.
      if (row.native || row.qualities.length || typeof raw !== 'string' || !raw || !window.AbortController) return;
      var key = scope + '\n' + row.provider + '\n' + raw, cached = probeCached(key);
      if (cached) return probeApply(row, cached);
      probeUrls[row.key] = {url: raw, key: key};
    }
    function probeRemember(key, value) {
      if (!probeCache.values[key]) { probeCache.keys.push(key); if (probeCache.keys.length > 200) delete probeCache.values[probeCache.keys.shift()]; }
      probeCache.values[key] = {value: value, at: Date.now()};
    }
    // lazy: alternatives the user asked to see; they do not use the leader budget.
    this.probe = function (rows, lazy) {
      (rows || []).forEach(function (row) {
        var target = row && probeUrls[row.key];
        if (!live() || !target || probed[row.key] || row.qualities.length || row.unavailable || probes >= 24 || !lazy && leaders >= 12) return;
        probed[row.key] = true; probes++; if (!lazy) leaders++;
        probeQueue.push({row: row, url: target.url, key: target.key});
      });
      probeNext();
    };
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
    function probeFetch(raw, provider) {
      var auth, url, own;
      try {
        auth = server('/lite/events'); url = new URL(raw, auth.origin); own = url.origin === auth.origin;
        if (own && /^\/lite\//.test(url.pathname)) url = new URL(address(url.href, false));
      } catch (error) { return Promise.reject(error); }
      if (!/^https?:$/.test(url.protocol)) return Promise.reject(new Error('url'));
      var trusted = own && /^\/(?:lite|proxy)\//.test(url.pathname);
      var abort = Abort(), timer = setTimeout(function () { abort.abort(); }, 10000); requests.push(abort);
      var headers = {}, kit = own && L.Storage.get('kit_aesgcmkey', ''); if (kit) headers['X-Kit-AesGcm'] = kit;
      // Own-Lampac probes share their provider's pacing; foreign CDNs are not rate limited by us.
      var delay = own ? paced(provider) : 0;
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
      return probeFetch(raw, row.provider).then(function (result) {
        if (!live()) return;
        if (result.status === 404 || result.status === 410) {
          if (result.trusted) { probeRemember(job.key, {unavailable: true}); row.unavailable = true; notify(); }
          return;
        }
        if (result.status >= 300) return;
        var json; try { json = JSON.parse(result.text); } catch (_) {}
        if (json && typeof json === 'object') {
          var found = qualities({quality: json.quality || json.qualitys, maxquality: json.maxquality});
          if (found.length) { probeRemember(job.key, {qualities: found}); row.qualities = found; row.measured = true; return notify(); }
          if (typeof json.url === 'string' && json.url && !hop) return probeJob(job, json.url, 1);
          // Explicit "file not found" style errors only; not cached, since providers reuse error texts for quota.
          if (!json.accsdb && /not\s*found|не\s*найден|удал[её]н|removed|deleted|нет\s+видео|no\s+video/i.test(typeof json.error === 'string' ? json.error : '')) { row.unavailable = true; notify(); }
          return;
        }
        var best = /^\s*#EXTM3U/.test(result.text) ? hlsQuality(result.text) : 0;
        if (best) { probeRemember(job.key, {qualities: [best]}); row.qualities = [best]; row.measured = true; notify(); }
      });
    }
    // A row is probed as soon as its own provider has no catalog page left, not after the whole search.
    function probeNext() {
      while (live() && probing < 2) {
        var index = -1;
        for (var i = 0; i < probeQueue.length; i++) if (!pendingBy[probeQueue[i].row.provider]) { index = i; break; }
        if (index < 0) return;
        (function (job) {
          probing++;
          always(probeJob(job, job.url, 0).catch(function () {}), function () { probing--; probeNext(); notify(); });
        })(probeQueue.splice(index, 1)[0]);
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
            // A film title, year or release tag ("Начало (2010) 4K") names the file, not its voice.
            var named = filmText && !titleLike(filmText) ? filmText : '';
            identityVoice = voice || translate || named || (tag && !ITEM_TAG.test(tag) && !titleLike(tag) ? tag : '') || UNNAMED;
            row.key = source.key + ':' + state.seasonIndex + ':' + index + ':' + identityVoice + ':' + row.qualities.join(',');
            row.tag = tag && tag !== identityVoice ? tag : '';
            // Exact native draw identity for the bridge: same item index among play/call items, URL and texts.
            row.match = {index: index, count: files.length, url: typeof file.url === 'string' ? file.url : '', text: filmText || '', translate: translate, voice_name: tag};
          }
          var label = identityVoice + (row.tag ? ' · ' + row.tag : '');
          labels[label] = (labels[label] || 0) + 1;
          row.voice = labels[label] > 1 ? label + ' · вариант ' + labels[label] : label;
          row.identityVoice = identityVoice;
          row.canon = identityVoice === UNNAMED ? {key: '', label: UNNAMED, subs: false} : canonVoice(identityVoice);
          add(row);
          if (self.rows[self.rows.length - 1] === row) probeable(row, file.url);
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
    function firstFree(list) { for (var i = 0; i < list.length; i++) if ((runningBy[list[i].source.key] || 0) < 2) return i; return -1; }
    function pump() {
      if (!live()) return;
      while (running < CATALOG_PARALLEL && (queue.length || voiceQueue.length)) {
        if (Date.now() >= deadline) { queue.splice(0).concat(voiceQueue.splice(0)).forEach(function (job) { pendingBy[job.source.key]--; fallback(job.source, 'Другие варианты в источнике'); }); break; }
        // At most two pages per provider at once, so one slow provider cannot hold every slot.
        var list = queue, index = firstFree(queue);
        if (index < 0) { list = voiceQueue; index = firstFree(voiceQueue); }
        if (index < 0) break;
        (function (job) {
          var key = job.source.key; running++; runningBy[key] = (runningBy[key] || 0) + 1;
          always(request(job.url, false, 0, key).then(function (text) { catalog(job, text); }).catch(function () { if (live()) fallback(job.source); }), function () { running--; runningBy[key]--; pendingBy[key]--; pump(); settle(); });
        })(list.splice(index, 1)[0]);
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
          var described = describeRelease(release);
          var row = {key: 'torrent:' + (release.hash || magnet), kind: 'torrent', voice: described.title, providerName: release.Tracker || 'Торрент', qualities: qualities(release), release: release, described: described,
            canon: described.voices.length ? canonVoice(described.voices[0]) : {key: '', label: described.title, subs: false}};
          if (!described.voices.length && releaseVoiceCache[magnetKey(magnet)]) applyReleaseVoices(row, releaseVoiceCache[magnetKey(magnet)]);
          add(row);
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
    // A focused torrent whose title and tracker name no voice: the extaudio sidecar adds the release
    // to TorrServer and reads its audio tracks. Only on request, one release at a time, seeded ones.
    var voiceBusy = false, lastVoiceRow = null;
    this.voices = function (row) {
      var release = row && row.release, link = release && release.MagnetUri, key = magnetKey(link);
      if (!live() || !release || !key || voiceBusy || row.voiceProbe || row.described && row.described.voices.length || (Number(release.Seeders) || 0) < MIN_SEEDS) return false;
      if (releaseVoiceCache[key]) { applyReleaseVoices(row, releaseVoiceCache[key]); notify(); return true; }
      var abort = Abort(), timer = setTimeout(function () { abort.abort(); }, 90000), url = new URL('/extaudio/voices', window.location.href);
      url.searchParams.set('link', link); url.searchParams.set('title', String(release.Title).slice(0, 150));
      voiceBusy = true; row.voiceProbe = 'pending'; lastVoiceRow = row; requests.push(abort); notify();
      function strings(list) { return Array.isArray(list) ? list.filter(function (item) { return typeof item === 'string' && item.trim(); }).slice(0, 12) : []; }
      always(fetch(url.href, {signal: abort.signal, credentials: 'same-origin', cache: 'no-store', headers: {'X-Homelab-Voices': '1'}}).then(function (response) {
        // 503: TorrServer is still looking for peers; a later focus asks again.
        if (response.status === 503 || response.status === 429) return null;
        if (!response.ok) throw new Error('voices');
        return response.text().then(function (text) { return JSON.parse(text); });
      }).then(function (data) {
        if (!data) {
          // Still preparing: TorrServer keeps fetching, so ask again while this card stays the last asked.
          row.voiceProbe = ''; row.voiceAttempts = (row.voiceAttempts || 0) + 1;
          if (row.voiceAttempts < 3) { var again = setTimeout(function () { if (lastVoiceRow === row) self.voices(row); }, 15000); timers.push(again); }
          return;
        }
        var value = {voices: strings(data.voices), languages: strings(data.languages)};
        releaseVoiceCache[key] = value;
        applyReleaseVoices(row, value);
      }, function () { row.voiceProbe = 'failed'; }), function () {
        voiceBusy = false; clearTimeout(timer); requests = requests.filter(function (entry) { return entry !== abort; });
        if (live()) { remember(); notify(); }
      });
      return true;
    };
    this.start = function () {
      started = true;
      var kept = !options.fresh && searchCache.values[cacheKey];
      if (kept && Date.now() - kept.at < SEARCH_TTL) {
        self.cachedAt = kept.at; self.rows = kept.rows.slice(); self.errors = kept.errors.slice();
        self.rows.forEach(function (row) { seenRows[row.key] = true; });
        discoveryDone = true; self.onlinePending = false; self.torrentPending = false; changed(self); return;
      }
      torrents();
      // External ids are remembered per card; with one id already known the wait is short.
      var idKey = (movie.name ? 'tv:' : 'movie:') + movie.id, ids = Promise.resolve();
      function applyIds(data) { ['imdb_id', 'kinopoisk_id', 'tmdb_id'].forEach(function (key) { if (!movie[key] && (typeof data[key] === 'string' || Number.isInteger(data[key]))) movie[key] = data[key]; }); }
      if (idsCache[idKey]) applyIds(idsCache[idKey]);
      if (!movie.imdb_id || !movie.kinopoisk_id) ids = request(server('/externalids').href + '&id=' + encodeURIComponent(movie.id) + '&serial=' + (movie.name ? 1 : 0), false, movie.imdb_id || movie.kinopoisk_id ? 1500 : 4000).then(function (text) {
        var data = JSON.parse(text); if (data && typeof data === 'object') { idsCache[idKey] = data; applyIds(data); }
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
    match = seeded(b) - seeded(a); if (match) return match;
    match = (b.qualities[0] || 0) - (a.qualities[0] || 0); if (match) return match;
    if (a.release && b.release) { match = (Number(b.release.Seeders) || 0) - (Number(a.release.Seeders) || 0); if (match) return match; }
    match = (b.measured ? 1 : 0) - (a.measured ? 1 : 0);
    return match || String(a.providerName).localeCompare(String(b.providerName)) || a.key.localeCompare(b.key);
  }
  function groupKey(row) {
    if (row.native) return 'native';
    if (row.kind === 'torrent') return row.canon && row.canon.key ? 'torrent:' + row.canon.key + ':' + (row.qualities[0] || 0) : 'row:' + row.key;
    var canon = row.canon || (row.identityVoice ? canonVoice(row.identityVoice) : null);
    return canon && canon.key ? 'voice:' + canon.key : 'row:' + row.key;
  }
  // One card per voice across providers and spellings, one per torrent voice and quality, one for every
  // "open in the source" fallback.
  function groupRows(rows) {
    var groups = [], byKey = {};
    rows.forEach(function (row) {
      var key = groupKey(row);
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
    var search, last = null, kind = recovery ? 'online' : 'all', q = recovery ? 0 : pref.quality, tiles = {}, models = {}, shown = 20, visibleItems = [], order = [], locked = false, restoringFocus = false, more = null, torrentsOpen = null, toggled = false, rerank = null, fresh = 0, sequence = '', reorderAt = 0, dead = false, voiceTimer = 0, started = false, refresh, uiIntent = 0, currentScope = sync.scope();
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
    function resetList() {
      Object.keys(tiles).forEach(function (key) { tiles[key].remove(); }); tiles = {}; models = {};
      locked = false; order = []; shown = 20; last = null; fresh = 0; sequence = ''; scroll.reset();
    }
    // Torrents fold into one row under the online voices; with no online voice they open by themselves.
    function section(count, open) {
      var tile = tiles['section:torrents'];
      if (!tile) tile = tiles['section:torrents'] = button('', 'homelab-common-section', function () {
        torrentsOpen = !sectionOpen; toggled = true; locked = true; draw();
      });
      tile.text((open ? '▾ Торренты · ' : '▸ Торренты · ') + plural(count, ['раздача', 'раздачи', 'раздач']) + (open ? '' : ' — показать'));
      return tile;
    }
    var sectionOpen = false;
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
      controls.append(button('Обновить', 'homelab-common-refresh', function () { restart(true); }));
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
      var row = item.best, count = item.rows.length, best = row.qualities[0] || 0;
      if (item.key === 'native') {
        var names = item.rows.map(function (entry) { return entry.providerName; }).filter(function (name, index, all) { return all.indexOf(name) === index; });
        var nativeModel = {voice: 'Открыть в источниках', details: plural(names.length, SOURCES) + ': ' + names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '') + ' · выбор внутри источника',
          badges: [], cls: 'is-native', icon: NATIVE, note: '', quality: '', qcls: 'is-none', pick: ''};
        nativeModel.sig = [nativeModel.voice, nativeModel.details].join('|');
        return nativeModel;
      }
      var voice = !grouped ? row.voice : row.kind === 'torrent' ? (row.canon && row.canon.label || row.voice) : row.canon && row.canon.label || row.identityVoice || row.voice;
      if (voice === UNNAMED) voice = UNNAMED + ' · ' + row.providerName;
      var subs = item.rows.some(function (entry) { return entry.canon && entry.canon.subs; });
      var model = {voice: voice, badges: [], cls: row.kind === 'torrent' ? 'is-torrent' : 'is-online', icon: row.kind === 'torrent' ? MAGNET : PLAY, note: ''};
      model.details = row.providerName + ' · ' + (count > 1 ? 'ещё ' + plural(count - 1, row.kind === 'torrent' ? ['раздача', 'раздачи', 'раздач'] : SOURCES) : row.kind === 'torrent' ? 'Торрент' : 'Онлайн');
      if (subs) model.badges.push(['субтитры', '']);
      if (row.release) {
        var described = row.described || (row.described = describeRelease(row.release)), size = Number(row.release.Size || row.release.size), seeds = Number(row.release.Seeders);
        if (Number.isFinite(seeds)) model.badges.push([plural(seeds, ['сид', 'сида', 'сидов']), seeds >= MIN_SEEDS ? 'is-seeds' : 'is-dead']);
        if (size > 0) model.badges.push([(size / 1073741824).toFixed(1).replace('.', ',') + ' ГБ', '']);
        if (described.codec) model.badges.push([described.codec, '']);
        if (described.languages) model.badges.push([described.languages, '']);
        if (described.voices.length > 1) model.details += ' · ' + described.voices.slice(1, 3).join(', ');
        if (tv) model.details += ' · Выбор серии в раздаче';
        if (row.voiceProbe === 'pending') model.details += ' · узнаю озвучку…';
      } else if (row.unavailable) model.details += ' · Не отдаёт видео';
      else if (!best) model.details += row.native ? ' · Качество неизвестно · Открыть источник' : ' · Качество уточняется';
      if (row.unavailable) { model.quality = 'нет видео'; model.qcls = 'is-off'; model.cls += ' is-unavailable'; }
      else if (best) { model.quality = qualityName(best); model.qcls = best >= 2160 ? 'is-uhd' : best >= 1080 ? 'is-hd' : 'is-sd'; }
      else { model.quality = '—'; model.qcls = 'is-none'; }
      if (!row.unavailable && best && row.kind === 'online') model.note = row.measured ? 'проверено' : 'заявлено';
      model.pick = hero ? 'Рекомендуем' + (row.measured ? ' · проверено' : '') : '';
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
      tile.on('hover:focus', function () {
        last = this; if (!restoringFocus) { locked = true; scroll.update(this, true); }
        // Dwelling on a torrent without a named voice asks its audio tracks.
        var focused = this; clearTimeout(voiceTimer);
        voiceTimer = setTimeout(function () { if (!dead && last === focused && search && models[key] && models[key].best && search.voices) search.voices(models[key].best); }, 1200);
      })
        .on('hover:hover hover:touch', function () { locked = true; touch(); })
        .on('hover:enter', function () { touch(); if (!models[key]) return; if (key === 'native') sourceMenu(models[key]); else open(models[key].best); })
        .on('hover:long', function () { touch(); if (models[key]) sourceMenu(models[key]); });
      return tile;
    }
    function rowLine(row) {
      if (row.unavailable) return 'Не отдаёт видео';
      if (row.native) return 'Открыть в источнике';
      if (!row.qualities.length) return 'Качество уточняется';
      return row.qualities.map(qualityName).join(' / ') + (row.kind === 'online' ? row.measured ? ' · проверено' : ' · заявлено' : '');
    }
    // Right / long press: every source behind the card, or every release of a torrent group.
    function releaseLine(entry) {
      var size = Number(entry.release.Size || entry.release.size), seeds = Number(entry.release.Seeders);
      return [entry.qualities.length ? qualityName(entry.qualities[0]) : '', Number.isFinite(seeds) ? plural(seeds, ['сид', 'сида', 'сидов']) : '', size > 0 ? (size / 1073741824).toFixed(1).replace('.', ',') + ' ГБ' : '', entry.providerName].filter(Boolean).join(' · ');
    }
    function sourceMenu(item) {
      var row = item.best, items = [];
      if (search) search.probe(item.rows, true);
      if (item.key === 'native') item.rows.forEach(function (entry) { items.push({title: entry.providerName, subtitle: entry.voice, open: entry}); });
      else if (row.release && item.rows.length > 1) item.rows.forEach(function (entry) { items.push({title: String(entry.release.Title).slice(0, 160), subtitle: releaseLine(entry) + (entry === row ? ' · лучшая' : ''), open: entry, selected: entry === row}); });
      else if (row.release) items.push({title: row.release.Title, subtitle: releaseLine(row), noenter: true}, {title: 'Смотреть', open: row});
      else item.rows.forEach(function (entry) {
        var extra = entry.voice.indexOf(entry.identityVoice) === 0 ? entry.voice.slice(entry.identityVoice.length).replace(/^\s*·\s*/, '') : '';
        items.push({title: entry.providerName + (extra ? ' · ' + extra : '') + (entry === row && item.rows.length > 1 ? ' · лучший' : ''), subtitle: rowLine(entry), open: entry, selected: entry === row});
      });
      var heading = item.key === 'native' ? 'Открыть в источнике' : row.release ? (item.rows.length > 1 ? plural(item.rows.length, ['раздача', 'раздачи', 'раздач']) : 'Раздача') : (item.rows.length > 1 ? plural(item.rows.length, SOURCES) + ' · ' : '') + (row.canon && row.canon.label || row.identityVoice);
      choose(heading, items, function (value) {
        if (value.open) open(value.open);
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
      // Groups merge while results stream in; a focused row that disappears
      // hands focus to the row now in its place, never to the filters above.
      var focusedKey = '', focusedIndex = -1;
      Object.keys(tiles).forEach(function (key) { if (tiles[key][0] === last) focusedKey = key; });
      if (focusedKey) focusedIndex = sequence.split('\n').indexOf(focusedKey);
      var candidates = search.rows.filter(function (row) { return (kind === 'all' || row.kind === kind) && (!q || row.kind === 'online' && !row.qualities.length || row.qualities.indexOf(q) >= 0) && (!recovery || !row.native && row.kind === 'online' && row.provider !== recovery.excludeProvider); });
      var exact = recovery && recovery.voice ? candidates.filter(function (row) { return voiceMatch(recovery.voice, row.identityVoice) === 2; }).length : 0;
      function rank(a, b, tie) {
        var match = recovery && recovery.voice ? voiceMatch(recovery.voice, b.identityVoice) - voiceMatch(recovery.voice, a.identityVoice) : 0;
        return match || compareRows(a, b, tie);
      }
      var available = candidates.filter(function (row) { return !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) > 0; }).sort(function (a, b) { return rank(a, b); });
      var showOther = recovery && recovery.voice && candidates.length > 0 && (!exact || last === otherButton[0]);
      otherButton.text('Другие озвучки · ' + candidates.length).toggleClass('hide', !showOther);
      var groups = grouped ? groupRows(available).sort(function (a, b) {
        return rank(a.best, b.best, function () { return b.rows.length - a.rows.length || (b.best.measured ? 1 : 0) - (a.best.measured ? 1 : 0); });
      }) : available.map(function (row) { return {key: 'row:' + row.key, rows: [row], best: row}; });
      var byKey = {}; groups.forEach(function (item) { byKey[item.key] = item; });
      var loading = search.onlinePending || search.torrentPending, now = Date.now();
      // Untouched lists re-rank at most once a second while results stream in; once the user moved, rows keep their places.
      if (!locked && (!loading || !order.length || now - reorderAt >= 1000)) { order = groups.map(function (item) { return item.key; }); reorderAt = now; fresh = 0; }
      else {
        if (!locked) { clearTimeout(rerank); rerank = setTimeout(function () { rerank = null; draw(); }, reorderAt + 1000 - now); }
        order = order.filter(function (key) { return !!byKey[key]; });
        groups.forEach(function (item) { if (order.indexOf(item.key) < 0) { order.push(item.key); if (locked) fresh++; } });
      }
      var items = order.map(function (key) { return byKey[key]; }), torrents = [];
      if (grouped && kind === 'all') {
        torrents = items.filter(function (item) { return item.best.kind === 'torrent'; });
        var online = items.filter(function (item) { return item.best.kind !== 'torrent' && !item.best.native; }).length;
        sectionOpen = torrentsOpen === null ? !online : torrentsOpen;
        if (!online && !toggled) sectionOpen = true;
        if (locked && torrentsOpen === null) torrentsOpen = sectionOpen; // once the user moved, the section no longer folds by itself
        if (torrents.length && (online || toggled)) {
          var at = items.indexOf(torrents[0]), rest = items.filter(function (item) { return item.best.kind !== 'torrent'; });
          var before = rest.filter(function (item) { return items.indexOf(item) < at; });
          items = before.concat([{key: 'section:torrents', section: true, rows: torrents}], sectionOpen ? torrents : [], rest.slice(before.length));
        }
      }
      visibleItems = items; models = byKey;
      showPlaceholder(items.length ? '' : loading ? 'loading' : 'empty:' + q + ':' + kind, loading);
      var wanted = {}, page = items.slice(0, shown), keys = [];
      search.probe(page.filter(function (item) { return !item.section; }).map(function (item) { return item.best; }));
      var heroKey = page[0] && !page[0].section ? page[0].key : '';
      page.forEach(function (item) {
        wanted[item.key] = true; keys.push(item.key);
        if (item.section) { section(torrents.length, sectionOpen); return; }
        var tile = tiles[item.key] || (tiles[item.key] = card(item.key));
        fill(tile, view(item, item.key === heroKey && !item.best.native && !item.best.unavailable));
        matchLabel(tile, item.best);
      });
      Object.keys(tiles).forEach(function (key) { if (!wanted[key]) { tiles[key].remove(); delete tiles[key]; } });
      // Re-append only when the sequence changed: moving a focused node replays Lampa's focus animation.
      var seq = keys.join('\n'), moved = seq !== sequence;
      if (moved) { sequence = seq; keys.forEach(function (key) { body.append(tiles[key]); }); }
      var heirChanged = false;
      if (focusedKey && !tiles[focusedKey]) {
        var heir = page[Math.max(0, Math.min(focusedIndex, page.length - 1))];
        last = heir && tiles[heir.key] ? tiles[heir.key][0] : null; heirChanged = true;
      }
      if (items.length > shown) {
        if (!more) more = button('', 'homelab-common-more', function () {
          var first = visibleItems[shown]; shown += 20; draw();
          if (first && tiles[first.key] && L.Controller.own(self)) L.Controller.collectionFocus(tiles[first.key][0], root, true);
        });
        more.text('Показать ещё · ' + (items.length - shown));
        if (moved || !body[0].contains(more[0]) || body.children().last()[0] !== more[0]) { body.append(more); moved = true; }
      } else if (more) { more.remove(); more = null; moved = true; }
      drawStatus(loading, items.filter(function (item) { return !item.section; }), available, exact);
      hint.toggleClass('hide', !items.length).text(grouped ? 'ОК — смотреть лучший источник  ·  → или удержание — все источники' : 'ОК — смотреть  ·  → или удержание — подробности');
      if (L.Controller.own(self)) {
        var firstCard = keys.filter(function (key) { return key !== 'section:torrents'; })[0], top = firstCard && tiles[firstCard] ? tiles[firstCard][0] : null, before = last;
        if (untouched && top) last = top;
        if (moved || heirChanged || last !== before || !last) focus(true);
      }
    }
    function drawStatus(loading, items, rows, exact) {
      var voices = rows.filter(function (row) { return row.kind === 'online' && !row.native; }), releases = rows.filter(function (row) { return row.kind === 'torrent'; }).length;
      var top = rows.reduce(function (max, row) { return Math.max(max, row.unavailable ? 0 : row.qualities[0] || 0); }, 0), counted = {};
      voices.forEach(function (row) { counted[row.canon && row.canon.key || row.identityVoice] = true; });
      var summary = [Object.keys(counted).length ? plural(Object.keys(counted).length, ['озвучка', 'озвучки', 'озвучек']) : '', top ? 'до ' + qualityName(top) : '', releases ? plural(releases, ['раздача', 'раздачи', 'раздач']) : ''].filter(Boolean).join(' · ');
      var found = grouped ? summary || plural(items.length, VARIANTS) : plural(rows.length, VARIANTS), parts = [], providers = search.providers || {total: 0, done: 0};
      if (loading) {
        parts.push('Ищем варианты…');
        if (search.onlinePending) parts.push(providers.total ? 'онлайн: ответили ' + providers.done + ' из ' + providers.total : 'опрашиваем онлайн-источники');
        if (search.torrentPending) parts.push('торренты ищутся');
        if (rows.length) parts.push('найдено ' + found);
      } else {
        parts.push(rows.length ? 'Найдено: ' + found : 'Ничего не найдено');
        if (search.checking()) parts.push('проверяем качество');
        if (search.interrupted) parts.push('Поиск прерван, нажмите «Обновить»');
        if (search.cachedAt) { var minutes = Math.floor((Date.now() - search.cachedAt) / 60000); parts.push(minutes ? 'обновлено ' + minutes + ' мин назад' : 'обновлено только что'); }
        if (fresh) parts.push('ниже ещё ' + plural(fresh, ['новый', 'новых', 'новых']));
        if (recovery && recovery.voice && !exact && rows.length) parts.push('Точного совпадения нет; показаны похожие озвучки');
      }
      statusText.text(parts.concat(search.errors).join(' · '));
      status.toggleClass('is-loading', loading).toggleClass('has-errors', !!search.errors.length || !!search.interrupted && !loading);
      // Online answers drive the bar; the last stretch waits for torrents.
      var share = search.onlinePending ? (providers.total ? providers.done / providers.total : 0) * 0.85 + 0.05 : 0.92;
      barFill.css('transform', 'scaleX(' + share.toFixed(3) + ')').css('-webkit-transform', 'scaleX(' + share.toFixed(3) + ')');
    }
    function changed() { if (!refresh) refresh = setTimeout(function () { refresh = null; draw(); }, 150); }
    function cancel() { uiIntent++; clearTimeout(refresh); refresh = null; clearTimeout(rerank); rerank = null; if (search) search.cancel(); }
    function restart(fresh) {
      cancel(); currentScope = sync.scope(); resetList();
      body.empty(); more = null; placeholder = null; placeholderState = ''; selectors();
      search = new Search(Object.assign({}, movie), selection, changed, {torrents: !recovery, fresh: fresh === true}); search.start(); draw();
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
    this.destroy = function () { dead = true; clearTimeout(voiceTimer); cancel(); unsubscribe(); scroll.destroy(); root.remove(); };
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
  $('head').append($('<style></style>').text('.homelab-common{background:#202324;height:100%;display:flex;flex-direction:column;padding:1.4em 2.2em 1em;box-sizing:border-box}.homelab-common-head{display:flex;align-items:baseline;margin-bottom:.9em}.homelab-common-heading{font-size:2.4em;font-weight:600;flex-shrink:0;margin-right:.6em}.homelab-common-movie{font-size:1.3em;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.6}.homelab-common-recovery{font-size:1em;margin:0 0 1em;line-height:1.4;padding:.7em 1em;border-radius:.6em;background:rgba(223,204,162,.12);color:#efe1bf}.homelab-common-controls,.homelab-common-tabs{display:flex;flex-wrap:wrap;align-items:center;margin-bottom:.5em}.homelab-common-controls>*,.homelab-common-tabs>*{margin:0 .6em .5em 0}.homelab-common-chip,.homelab-common-refresh{padding:.6em 1.15em;border-radius:1em;background:rgba(255,255,255,.07)}.homelab-common-static{opacity:.75}.homelab-common-refresh{margin-left:auto;margin-right:0;opacity:.75}.homelab-common-chip.selected{background:rgba(255,255,255,.22)}.homelab-common-tab{padding:.45em 1.2em;border-radius:1em;opacity:.7}.homelab-common-tab.selected{opacity:1;background:rgba(255,255,255,.12);box-shadow:inset 0 -.15em 0 #fff}.homelab-common-other-voices{align-self:flex-start;margin-bottom:1em;max-width:100%;box-sizing:border-box}.homelab-common-status{position:relative;display:flex;align-items:center;min-height:1.6em;padding:.2em 0 .5em;margin-bottom:.4em;font-size:1em;opacity:.75}.homelab-common-status.is-loading{opacity:1}.homelab-common-status.has-errors .homelab-common-status-text{color:#f0c27a}.homelab-common-status-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-common-spinner{display:none;width:1em;height:1em;margin-right:.6em;flex-shrink:0;border-radius:100%;border:.15em solid rgba(255,255,255,.2);border-top-color:#fff;-webkit-animation:homelab-common-spin .9s linear infinite;animation:homelab-common-spin .9s linear infinite}.homelab-common-status.is-loading .homelab-common-spinner{display:block}.homelab-common-bar{display:none;position:absolute;left:0;right:0;bottom:0;height:.2em;border-radius:.2em;background:rgba(255,255,255,.08);overflow:hidden}.homelab-common-status.is-loading .homelab-common-bar{display:block}.homelab-common-bar-fill{height:100%;background:#fff;opacity:.8;-webkit-transform-origin:0 50%;transform-origin:0 50%;-webkit-transform:scaleX(0);transform:scaleX(0);-webkit-transition:-webkit-transform .4s;transition:transform .4s}@-webkit-keyframes homelab-common-spin{to{-webkit-transform:rotate(360deg)}}@keyframes homelab-common-spin{to{transform:rotate(360deg)}}@-webkit-keyframes homelab-common-pulse{50%{opacity:.4}}@keyframes homelab-common-pulse{50%{opacity:.4}}.homelab-common>.scroll{flex:1;min-height:0}.homelab-common-list{padding:.3em}.homelab-common-result{position:relative;display:flex;align-items:center;padding:1em 1.3em;background:rgba(255,255,255,.05);border-radius:.8em;margin-bottom:.55em;box-sizing:border-box;min-height:5.3em}.homelab-common-result.is-torrent{background:rgba(120,170,255,.06)}.homelab-common-result.is-native{background:rgba(255,255,255,.03)}.homelab-common-result.is-unavailable{opacity:.45}.homelab-common-result.is-hero{padding:1.35em 1.5em;min-height:6.6em;background:rgba(255,255,255,.1);margin-bottom:.9em}.homelab-common .selector.focus{outline:.16em solid #fff;outline-offset:.12em;background:rgba(255,255,255,.16)}.homelab-common .homelab-common-result.focus{background:#fff;color:#000;outline:0;opacity:1}.homelab-common-play{width:2.2em;height:2.2em;margin-right:1.2em;padding:.35em;box-sizing:border-box;border-radius:100%;background:rgba(255,255,255,.12);flex-shrink:0}.homelab-common-result.is-hero .homelab-common-play{width:2.8em;height:2.8em;background:#fff;color:#000}.homelab-common-result.is-torrent .homelab-common-play{color:#9cc2ff}.homelab-common-result.focus .homelab-common-play{background:#000;color:#fff}.homelab-common-play svg{display:block;width:100%;height:100%}.homelab-common-text{min-width:0;flex:1}.homelab-common-pick{font-size:.8em;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#ffd66b;margin-bottom:.3em}.homelab-common-result.focus .homelab-common-pick{color:#8a5a00}.homelab-common-voice{font-size:1.3em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-common-result.is-hero .homelab-common-voice{font-size:1.55em}.homelab-common-match{font-size:.85em;color:#dfcca2;margin-top:.3em}.homelab-common-result.focus .homelab-common-match{color:#6d5520}.homelab-common-details{font-size:.95em;opacity:.65;margin-top:.35em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-common-badges{margin-top:.45em;white-space:nowrap;overflow:hidden}.homelab-common-badge{display:inline-block;font-size:.8em;padding:.2em .6em;margin-right:.45em;border-radius:.4em;background:rgba(255,255,255,.1)}.homelab-common-badge.is-seeds{color:#8fe3a1}.homelab-common-badge.is-dead{color:#ff9b8f}.homelab-common-result.focus .homelab-common-badge{background:rgba(0,0,0,.1);color:#000}.homelab-common-quality{flex-shrink:0;margin-left:1em;text-align:right;max-width:30%}.homelab-common-q{display:inline-block;font-size:1.15em;font-weight:700;padding:.25em .65em;border-radius:.45em;border:.1em solid rgba(255,255,255,.5);white-space:nowrap}.homelab-common-q.is-uhd{border-color:#ffd66b;color:#ffd66b}.homelab-common-q.is-sd{opacity:.7}.homelab-common-q.is-none{border-color:transparent;opacity:.45}.homelab-common-q.is-off{border-color:transparent;font-size:.9em;color:#ff9b8f}.homelab-common-result.is-hero .homelab-common-q{font-size:1.4em}.homelab-common-result.focus .homelab-common-q{color:#000;border-color:#000}.homelab-common-result.focus .homelab-common-q.is-none,.homelab-common-result.focus .homelab-common-q.is-off{border-color:transparent}.homelab-common-q-note{font-size:.78em;opacity:.6;margin-top:.35em;white-space:nowrap}.homelab-common-q-note.is-measured{opacity:1;color:#8fe3a1}.homelab-common-result.focus .homelab-common-q-note.is-measured{color:#1d7a33}.homelab-common-check{display:inline-block;width:1.1em;height:1.1em;vertical-align:-.2em;margin-right:.2em}.homelab-common-check svg{display:block;width:100%;height:100%}.homelab-common-section{padding:.85em 1.3em;margin-bottom:.55em;border-radius:.8em;font-size:1.1em;background:rgba(120,170,255,.06)}.homelab-common .homelab-common-section.focus{background:#fff;color:#000;outline:0}.homelab-common-more{padding:1em;text-align:center;border-radius:.8em;background:rgba(255,255,255,.04)}.homelab-common-skeleton{height:5.3em;margin-bottom:.55em;border-radius:.8em;background:rgba(255,255,255,.06);-webkit-animation:homelab-common-pulse 1.4s ease-in-out infinite;animation:homelab-common-pulse 1.4s ease-in-out infinite}.homelab-common-skeleton:first-child{height:6.6em}.homelab-common-empty{padding:3em 1em;text-align:center}.homelab-common-empty-title{font-size:1.5em;font-weight:600;margin-bottom:.5em}.homelab-common-empty-hint{opacity:.6}.homelab-common-hint{font-size:.85em;opacity:.45;padding-top:.6em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.homelab-common .hide{display:none}@media(max-width:600px){.homelab-common{padding:1em}.homelab-common-result{padding:.9em}.homelab-common-play{margin-right:.7em;width:1.8em;height:1.8em}.homelab-common-q{font-size:1em}.homelab-common-movie{font-size:1em}.homelab-common-chip,.homelab-common-tab{padding:.55em .9em}.homelab-common-hint{display:none}}'));
  L.Component.add(COMPONENT, Common);
  L.Listener.follow('full', function (event) { if (event.type === 'complite') addButton(event.data.movie, event.object.activity.render()); });
  var active = L.Activity.active(); if (active && active.component === 'full' && active.activity) addButton(active.card, active.activity.render());
  window.HomelabSources = {Search: Search, quality: quality, voiceMatch: voiceMatch, preferences: preferences, describeRelease: describeRelease, canonVoice: canonVoice, releaseVoices: releaseVoices, compareRows: compareRows, groupRows: groupRows, resume: resumeSource, recover: recover};
})();
