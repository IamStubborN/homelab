// Built by tools/build.cjs from src/common-sources: edit the sources there and rebuild.
(function install() {
  'use strict';
  if (!window.appready) {
    if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
    return;
  }
  var L = window.Lampa, sync = window.HomelabSync, $ = window.$;
  var COMPONENT = 'homelab_sources', PLAY = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
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
  // ── Voice labels: studios, types, languages; torrent release voices ──
  var BLOCKED = /заблокирован|правообладател|недоступно в (?:вашем|данном) регионе|blocked by|copyright/i;
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
    // AniLibria renamed itself AniLiberty in 2025; providers use both names.
    anilibria: ['AniLibria', 'anilibria', 'anilibria tv', 'анилибрия', 'анилибриа', 'aniliberty', 'aniliberty tv', 'анилиберти'],
    jaskier: ['Jaskier', 'jaskier', 'ясkier', 'яскер'], tvshows: ['TVShows', 'tvshows', 'tv shows'],
    pifagor: ['Пифагор', 'пифагор', 'pifagor'], kravec: ['Кравец', 'кравец', 'kravec', 'кравец records'],
    coldfilm: ['ColdFilm', 'coldfilm', 'cold film'], baibako: ['BaibaKo', 'baibako'], amedia: ['Amedia', 'amedia'],
    ideafilm: ['IdeaFilm', 'ideafilm', 'idea film'], novamedia: ['NovaMedia', 'novamedia', 'nova media'],
    kurazh: ['Кураж-Бамбей', 'кураж бамбей', 'kurazh bambey'], viruseproject: ['ViruseProject', 'viruseproject'],
    anidub: ['AniDub', 'anidub', 'anidub online'], animevost: ['AnimeVost', 'animevost'], dreamcast: ['DreamCast', 'dreamcast'],
    sovetromantica: ['SovetRomantica', 'sovetromantica'], studioband: ['Studio Band', 'studio band', 'studioband', 'студийная банда'],
    flarrow: ['Flarrow Films', 'flarrow films', 'flarrow'], ledoyen: ['LeDoyen', 'ledoyen', 'le doyen'],
    gaevsky: ['Гаевский', 'гаевский', 'gaevsky'], gavrilov: ['Гаврилов', 'гаврилов', 'gavrilov'],
    volodarsky: ['Володарский', 'володарский', 'volodarsky'], sdi: ['SDI Media', 'sdi media', 'sdi'],
    goblin: ['Гоблин', 'гоблин', 'goblin', 'дмитрий goblin пучков', 'дмитрий гоблин пучков', 'дмитрий пучков', 'пучков'],
    netflix: ['Netflix', 'netflix'], pazl: ['Pazl Voice', 'pazl voice', 'pazl'], tvin: ['TVIN', 'tvin']
  };
  function normalized(value) {
    return voiceKey(value).replace(/ё/g, 'е')
      .replace(/(?:^|\s|[\[(])(?:0|6|12|16|18)\+([\])]|(?=\s|$))/g, ' ')
      .replace(/[^a-zа-я0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Spellings fold to one Latin skeleton: "ЛостФильм", "Lost Film" and "lostfilm" meet, so do "АлексФильм" and "AlexFilm".
  var TRANSLIT = {а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'};
  function fold(text) {
    return String(text).replace(/[а-яё]/g, function (letter) { return TRANSLIT[letter]; }).replace(/x/g, 'ks').replace(/c/g, 'k').replace(/[^a-z0-9]/g, '').replace(/(.)\1+/g, '$1');
  }
  var FOLDED = null;
  function studioOf(text) {
    var exact = Object.keys(STUDIOS).find(function (key) { return STUDIOS[key].indexOf(text, 1) >= 1; });
    if (exact || !text) return exact || '';
    if (!FOLDED) {
      FOLDED = {};
      Object.keys(STUDIOS).forEach(function (key) { STUDIOS[key].forEach(function (alias) { var folded = fold(normalized(alias)); if (folded.length >= 4 && !FOLDED[folded]) FOLDED[folded] = key; }); });
    }
    // Only skeletons of four letters and more: short codes (SDI, RHS) match exactly or not at all.
    var folded = fold(text);
    return folded.length >= 4 && FOLDED[folded] || '';
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
  var TYPES = [['Дубляж', /^(?:дублированный|дублированная|дубляж|дубл|dub|dubbed|лицензия|license)$/], ['Многоголосый', /^(?:многоголосый|многоголосая|mvo)$/],
    ['Двухголосый', /^(?:двухголосый|двухголосая|dvo)$/], ['Любительский', /^(?:любительский|любительская)$/],
    ['Авторский', /^(?:авторский|авторская|одноголосый|одноголосая|avo)$/], ['Оригинал', /^(?:оригинал|оригинальный|оригинальная|original|orig)$/]];
  // Tracker shorthand, only inside release names.
  var CODES = [['Дубляж', /^d$/], ['Многоголосый', /^p\d?$/], ['Любительский', /^l\d?$/], ['Авторский', /^(?:a|vo)$/]];
  // A voice label split into studio, type and language; key groups the same voice across providers and spellings.
  function canonVoice(value) {
    var raw = String(value || '').trim(), text = normalized(raw), result = {studio: '', type: '', lang: '', subs: false, key: '', label: raw};
    if (!text) { result.key = ''; return result; }
    // Placeholders name no voice: each stays its provider's own card.
    if (/^(?:неизвестно|неизвестная|по умолчанию|unknown|default|delete|deleted|null|undefined|none)$/.test(text)) { result.label = 'Озвучка не указана'; return result; }
    var studio = studioOf(text), words = text.split(' '), rest = [];
    if (!studio) {
      words.forEach(function (word) {
        var lang = LANGUAGES.find(function (entry) { return entry[1].test(word); }), type = TYPES.find(function (entry) { return entry[1].test(word); });
        if (/^(?:субтитры|subs?|subtitles)$/.test(word)) result.subs = true;
        else if (lang) result.lang = result.lang || lang[0];
        else if (type) result.type = result.type || type[0];
        // Release tags and initials ("Дубляж [4K, SDR, Ukr, LeDoyen]", "Ю. Сербин") say nothing about the studio.
        else if (/^(?:\d{3,4}p|2160|1440|1080|720|576|480|360|4k|4к|uhd|hdr|sdr|hdr10|dv|bd|web|webrip|webdl|bdrip|hdrip|remux|av1|hevc)$/.test(word)) return;
        else if (!/^(?:профессиональный|любительский|озвучка|перевод|голос|закадровый|закадровая|studio|studios|st|студия|tv|records|version|версия)$/.test(word)) rest.push(word);
      });
      // Cyrillic initials go when a name stays and no studio needs them: "Ю. Сербин" is Сербин,
      // "Кубик в Кубе (Дубляж)" keeps its "в"; "Studio A" and "Voice 2" keep theirs.
      var leftover = rest.join(' ');
      if (!studioOf(leftover) && rest.some(function (word) { return word.length > 1; })) leftover = rest.filter(function (word) { return !/^[а-я]$/.test(word); }).join(' ');
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
    var stored = scope ? L.Storage.get(key, {}) : {}, value = {quality: 0, subs: false};
    if (stored && [0, 2160, 1080, 720].indexOf(stored.quality) >= 0) value.quality = stored.quality;
    if (stored && typeof stored.subs === 'boolean') value.subs = stored.subs;
    if (update) {
      if ([0, 2160, 1080, 720].indexOf(update.quality) >= 0) value.quality = update.quality;
      if (typeof update.subs === 'boolean') value.subs = update.subs;
      if (scope) L.Storage.set(key, value);
    }
    return value;
  }
  // Subtitle languages a source names: "RU · EN", "" when it names none it knows.
  var SUBTITLE_LANGUAGES = [['RU', /рус|russian|^ru$|^rus$/i], ['EN', /англ|english|^en$|^eng$/i], ['UK', /укр|ukrain|^uk$|^ukr$/i], ['JA', /япон|japan|^ja$|^jpn$/i]];
  function subtitleLanguages(names) {
    var found = [];
    names.forEach(function (name) {
      var text = String(name || '').trim(), words = text.split(/[^a-zа-яё]+/i);
      SUBTITLE_LANGUAGES.forEach(function (entry) {
        if ((entry[1].test(text) || words.some(function (word) { return entry[1].test(word); })) && found.indexOf(entry[0]) < 0) found.push(entry[0]);
      });
    });
    return found.join(' · ');
  }
  // Whether a release or online file carries subtitles: {langs} or null.
  function releaseSubtitles(release, streams) {
    var subs = streams.filter(function (s) { return s.codec_type === 'subtitle'; });
    if (subs.length) return {langs: subtitleLanguages(subs.map(function (s) { var tags = s.tags || {}; return tags.language || tags.title || ''; }))};
    return /(?:^|[^a-zа-яё])(?:subs?|субтитры|sub\s*rus|rus\s*sub)(?=$|[^a-zа-яё])/i.test(String(release.Title || '')) ? {langs: ''} : null;
  }
  function onlineSubtitles(file) {
    var list = Array.isArray(file.subtitles) ? file.subtitles.filter(function (sub) { return sub && sub.url; }) : [];
    return list.length ? {langs: subtitleLanguages(list.map(function (sub) { return sub.label || sub.language || ''; }))} : null;
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
    return {title: voices.length ? voices.slice(0, 2).join(' / ') + (voices.length > 2 ? ' +' + (voices.length - 2) : '') : languages ? 'Дорожки: ' + languages : 'Озвучка не указана', codec: codec, voices: voices, languages: languages,
      subtitles: releaseSubtitles(release, streams)};
  }
  // Voices read from a release's audio tracks by the lampa-media sidecar, by info hash, for this app run.
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
  // ── Row order and parsing provider pages ──
  // Torrents: enough seeds to stream is a threshold; above it the picture quality decides, then the seeds.
  var MIN_SEEDS = 3;
  function seeded(row) { return row.release && (Number(row.release.Seeders) || 0) >= MIN_SEEDS ? 1 : 0; }
  // An unchecked claim of a provider known to inflate its quality ranks as unknown until a probe checks it.
  function rankQuality(row) { return row.doubtful && !row.measured ? 0 : row.qualities[0] || 0; }
  // tie (optional) breaks equal-quality rows before the name order; groups use it for their source count.
  function compareRows(a, b, tie) {
    var match = (a.unavailable ? 1 : 0) - (b.unavailable ? 1 : 0); if (match) return match;
    function group(row) { return row.native ? 2 : row.kind === 'online' ? 0 : 1; }
    match = group(a) - group(b); if (match) return match;
    if (a.release && b.release) { match = seeded(b) - seeded(a); if (match) return match; }
    match = rankQuality(b) - rankQuality(a); if (match) return match;
    if (a.release && b.release) { match = (Number(b.release.Seeders) || 0) - (Number(a.release.Seeders) || 0); if (match) return match; }
    match = tie ? tie(a, b) : 0;
    return match || String(a.providerName).localeCompare(String(b.providerName)) || a.key.localeCompare(b.key);
  }
  // Quality labels and picture sizes, the same in every plugin.
  // "4K", "UHD", "1080p", "720i", "WEB-DL 2160p" → 2160, 1080, 720, 2160; anything else → 0.
  function qualityHeight(label) {
    var text = String(label || '');
    if (/\b(4k|uhd)\b/i.test(text)) return 2160;
    var match = /(?:^|\D)(2160|1440|1080|720|576|480|360)(?:p|i|\D|$)/i.exec(text);
    return match ? +match[1] : 0;
  }
  // A decoded or announced picture size → its quality. Width first: cinema crops (1920x800) still count as 1080p.
  function pictureHeight(width, height) {
    var steps = [[3800, 2160], [2500, 1440], [1800, 1080], [1200, 720], [1000, 576], [800, 480]];
    for (var i = 0; i < steps.length; i++) if (width >= steps[i][0] || height >= steps[i][1] * 0.9) return steps[i][1];
    return width || height ? 360 : 0;
  }
  // 2160 → "4K", 1080 → "1080p", 0 → "".
  function qualityLabel(value) { return value === 2160 ? '4K' : value ? value + 'p' : ''; }
  // Heights a provider page names for a file, best first: its quality map, a tag in its text, else maxquality.
  // Lampa's online screen moves the map to "qualitys" and leaves the first label in "quality".
  function listedQualities(file) {
    var map = [file.quality, file.qualitys].filter(function (value) { return value && typeof value === 'object'; })[0] || {};
    var found = Object.keys(map).map(qualityHeight).filter(Boolean);
    var named = qualityHeight(file.text || file.Title || file.title) || qualityHeight(file.info && file.info.quality);
    if (named) found.push(named);
    if (!found.length && file.maxquality) { named = qualityHeight(file.maxquality); if (named) found.push(named); }
    return found.filter(function (q, i) { return found.indexOf(q) === i; }).sort(function (a, b) { return b - a; });
  }
  function hlsQuality(text) {
    var best = 0;
    String(text).replace(/RESOLUTION=(\d+)x(\d+)/gi, function (all, width, height) { best = Math.max(best, pictureHeight(+width, +height)); return all; });
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
    // Uploads (VK Видео and the like) label a file with the film's own name: "🎬Интерстеллар (2014) - 4K UHD".
    function namesFilm(text) {
      var value = ' ' + normalized(text) + ' ';
      return [movie.title, movie.original_title].some(function (name) { var known = normalized(name); return known.length >= 4 && value.indexOf(' ' + known + ' ') >= 0; });
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
    // ── Search: checking the real quality of rows ──
    // Rows without quality ask their source once, after the catalog is done: the call JSON or the HLS master
    // (RESOLUTION) gives the real height. The UI asks only for each voice card's leader (at most 12 per search) and,
    // lazily, for the alternatives of a card whose source list is opened (24 in total). Only an own-Lampac 404/410 or an
    // explicit "not found" error means the source hands out no video; auth/quota answers (401/403, accsdb, other
    // errors), rch/ws handshakes, timeouts and foreign CDN refusals change nothing. Media is never read.
    var probeQueue = [], probing = 0, probes = 0, leaders = 0, probeUrls = {}, probed = {}, PROBE_TTL = 30 * 60000;
    function probeApply(row, value) {
      if (value.unavailable) row.unavailable = true;
      else { row.qualities = value.qualities.slice(); row.measured = true; row.verified = 'probe'; }
    }
    function probeCached(key) {
      var entry = probeCache.values[key];
      if (entry && Date.now() - entry.at < PROBE_TTL) return entry.value;
    }
    // Catalog rows only remember where they could be probed; a cached answer applies at once without a request.
    function probeable(row, raw) {
      // Without a native AbortController a hung or media response could not be stopped: skip probing entirely.
      // A claimed quality is checked too: sources name heights their stream does not have.
      if (row.native || row.measured || typeof raw !== 'string' || !raw || !window.AbortController) return;
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
        if (!live() || !target || probed[row.key] || row.measured || row.unavailable || probes >= 24 || !lazy && leaders >= 12) return;
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
    // declared: heights the resolved JSON named; its stream manifest (when it is the top quality's) decides.
    function probeJob(job, raw, hop, declared) {
      var row = job.row;
      function settle(list) {
        probeRemember(job.key, {qualities: list}); row.qualities = list; row.measured = true; row.verified = 'probe'; row.doubtful = false;
        if (Q && row.kind === 'online' && !row.native) Q.report(movie, row.provider, factSeason(), row.factVoice || '', row.claimed || 0, list[0], 'probe');
        notify();
      }
      // Heights the resolver only named. A row the listing gave no quality takes them as before; a listing claim
      // is only shown, neither «проверено» nor logged, until its manifest is read.
      function asDeclared(list) {
        list = list || declared; if (!live() || !list || !list.length || row.measured) return;
        if (!row.claimed) return settle(list);
        row.qualities = list.slice(); notify();
      }
      return probeFetch(raw, row.provider).then(function (result) {
        if (!live()) return;
        if (result.status === 404 || result.status === 410) {
          if (result.trusted) { probeRemember(job.key, {unavailable: true}); row.unavailable = true; notify(); }
          return;
        }
        if (result.status >= 300) return asDeclared();
        var json; try { json = JSON.parse(result.text); } catch (_) {}
        if (json && typeof json === 'object') {
          var map = json.quality || json.qualitys, found = listedQualities({quality: map, maxquality: json.maxquality});
          if (typeof json.url === 'string' && json.url && !hop) {
            var labels = map && typeof map === 'object' ? Object.keys(map) : [];
            var top = labels.reduce(function (best, label) { return qualityHeight(label) > qualityHeight(best) ? label : best; }, labels[0]);
            // The manifest measures the top quality only when it is that quality's stream.
            if (!labels.length || map[top] === json.url) return probeJob(job, json.url, 1, found).catch(function () { asDeclared(found); });
          }
          if (found.length) return asDeclared(found);
          // Explicit "file not found" style errors only; not cached, since providers reuse error texts for quota.
          if (!json.accsdb && /not\s*found|не\s*найден|удал[её]н|removed|deleted|нет\s+видео|no\s+video/i.test(typeof json.error === 'string' ? json.error : '')) { row.unavailable = true; notify(); }
          return;
        }
        var best = /^\s*#EXTM3U/.test(result.text) ? hlsQuality(result.text) : 0;
        if (best) settle([best]); else asDeclared();
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
    // ── Search: provider catalog pages, seasons and voices ──
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
        // A rights-holder notice stands where the voice should ("Заблокировано правообладателем!"): nothing plays behind
        // it, though the page's other voices still get asked below.
        if (BLOCKED.test(voice)) matching = [];
        matching.forEach(function (file) {
          if (BLOCKED.test(file.voice_name || '') || BLOCKED.test(file.translate || '')) return;
          var row = {kind: 'online', provider: source.key, providerName: source.name, seasonIndex: state.seasonIndex, qualities: listedQualities(file), subtitles: onlineSubtitles(file)}, identityVoice;
          row.claimed = row.qualities[0] || 0;
          // Quality log key, the same one native rows and playback use (HomelabSync resume identity).
          row.factVoice = movie.name ? String(voice || file.voice_name || '') : String(file.translate || file.text || '').trim().slice(0, 200);
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
            if (identityVoice !== UNNAMED && namesFilm(identityVoice)) identityVoice = UNNAMED;
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
        var value = {key: key, name: String(source.name || key).replace(/\s*~.*$/, '').replace(/\s+-\s+(?:\d{3,4}p|4k|uhd|hd)$/i, '') || key};
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
          var row = {key: 'torrent:' + (release.hash || magnet), kind: 'torrent', voice: described.title, providerName: release.Tracker || 'Торрент', qualities: listedQualities(release), release: release, described: described,
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
    // A focused torrent whose title and tracker name no voice: the lampa-media sidecar adds the release
    // to TorrServer and reads its audio tracks. Only on request, one release at a time, seeded ones.
    var voiceBusy = false, lastVoiceRow = null;
    this.voices = function (row) {
      var release = row && row.release, link = release && release.MagnetUri, key = magnetKey(link);
      if (!live() || !release || !key || voiceBusy || row.voiceProbe || row.described && row.described.voices.length || (Number(release.Seeders) || 0) < MIN_SEEDS) return false;
      if (releaseVoiceCache[key]) { applyReleaseVoices(row, releaseVoiceCache[key]); notify(); return true; }
      var abort = Abort(), timer = setTimeout(function () { abort.abort(); }, 90000), url = new URL('/homelab-media/voices', window.location.href);
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
  // ── Grouping rows into voice cards ──
  function plural(n, forms) {
    var a = n % 10, b = n % 100;
    return n + ' ' + (a === 1 && b !== 11 ? forms[0] : a >= 2 && a <= 4 && (b < 12 || b > 14) ? forms[1] : forms[2]);
  }
  var SOURCES = ['источник', 'источника', 'источников'], VARIANTS = ['вариант', 'варианта', 'вариантов'];
  // Inside one voice: playable first, then the highest quality, a measured height over a declared one.
  function bestFirst(a, b) {
    var match = (a.unavailable ? 1 : 0) - (b.unavailable ? 1 : 0); if (match) return match;
    match = seeded(b) - seeded(a); if (match) return match;
    match = rankQuality(b) - rankQuality(a); if (match) return match;
    if (a.release && b.release) { match = (Number(b.release.Seeders) || 0) - (Number(a.release.Seeders) || 0); if (match) return match; }
    match = (b.measured ? 1 : 0) - (a.measured ? 1 : 0);
    return match || String(a.providerName).localeCompare(String(b.providerName)) || a.key.localeCompare(b.key);
  }
  function groupKey(row) {
    if (row.native) return 'native';
    if (row.kind === 'torrent') return row.canon && row.canon.key ? 'torrent:' + row.canon.key + ':' + (row.qualities[0] || 0) : 'row:' + row.key;
    // Unnamed files of one provider (VK uploads) share a card instead of a card each.
    if (row.identityVoice === UNNAMED) return 'unnamed:' + row.provider;
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
  // ── The «Общий» screen ──
  // The opening episode: an explicit one, else the last watched season and episode, else S1E1.
  function initialSelection(object, movie) {
    var tv = !!movie.name, saved = window.homelabContinue && window.homelabContinue.list().find(function (item) { return item.card === (tv ? 'tv_' : 'movie_') + movie.id; });
    var season = Number.isInteger(object.season) && object.season >= 0 ? object.season : saved && Number.isInteger(saved.season) && saved.season >= 0 ? saved.season : 1;
    return {season: season, episode: saved && saved.season === season && saved.episode || 1};
  }
  // TMDB image paths go into CSS url(): anything but a plain path is dropped.
  function imagePath(path) { return typeof path === 'string' && /^\/[A-Za-z0-9_.\-\/]{1,200}$/.test(path) ? path : ''; }
  function Common(object) {
    var self = this, movie = movieCard(object.movie), tv = !!movie.name;
    var recovery = object.homelab_recovery, pref = preferences();
    if (recovery && recovery.scope !== sync.scope()) recovery = null;
    var selection = recovery ? {season: recovery.season, episode: recovery.episode} : initialSelection(object, movie);
    var root = $('<div class="homelab-common layer--wheight"></div>'), art = $('<div class="homelab-common-art"></div>'), head = $('<div class="homelab-common-head"></div>');
    var status = $('<div class="homelab-common-status" aria-live="polite"></div>'), statusText = $('<div class="homelab-common-status-text"></div>'), bar = $('<div class="homelab-common-bar"></div>'), barFill = $('<div class="homelab-common-bar-fill"></div>');
    var main = $('<div class="homelab-common-main"></div>'), body = $('<div class="homelab-common-list"></div>'), scroll = new L.Scroll({over: true}), hint = $('<div class="homelab-common-hint hide"></div>');
    var detail = $('<div class="homelab-common-detail hide"></div>'), detailSig = '', detailKey = '', picking = null, PICK = 'homelab_common_pick';
    var search, last = null, kind = recovery ? 'online' : 'all', q = recovery ? 0 : pref.quality, subsOnly = !recovery && pref.subs, tiles = {}, models = {}, shown = 20, visibleItems = [], order = [], locked = false, restoringFocus = false, more = null, torrentsOpen = null, toggled = false, rerank = null, fresh = 0, freshKeys = {}, sequence = '', sequenceKeys = [], qBefore = 0, reorderAt = 0, dead = false, voiceTimer = 0, started = false, refresh, uiIntent = 0, currentScope = sync.scope();
    // Grouped by voice, recovery too: its providers mostly carry the same voice, so one card leads to all of them.
    // untouched: until the first key press, focus follows the top (recommended) card so one OK plays it.
    var grouped = true, untouched = true, placeholder = null, placeholderState = '';
    // Header: poster, title and facts, live search progress, and the episode strip under them.
    var poster = $('<div class="homelab-common-poster hide"></div>'), info = $('<div class="homelab-common-info"></div>'), facts = $('<div class="homelab-common-facts"></div>');
    var title = $('<div class="homelab-common-heading"></div>').text(movie.title || movie.name || 'Общий'), titleRow = $('<div class="homelab-common-title-row"></div>'), titleBlock = $('<div class="homelab-common-title"></div>');
    var year = String(movie.release_date || movie.first_air_date || '').slice(0, 4), rating = Number(movie.vote_average);
    var genres = Array.isArray(movie.genres) ? movie.genres.map(function (genre) { return genre && typeof genre.name === 'string' ? genre.name.toLowerCase() : ''; }).filter(Boolean).slice(0, 2).join(' · ') : '';
    var strip = $('<div class="homelab-common-eps hide"></div>'), stripCenter = 0, stripTimer = 0;
    status.append($('<div class="homelab-common-spinner"></div>')).append(statusText).append(bar.append(barFill));
    [/^\d{4}$/.test(year) ? year : '', rating > 0 ? '★ ' + rating.toFixed(1) : '', genres].forEach(function (fact) { if (fact) facts.append($('<div class="homelab-common-year"></div>').text(fact)); });
    titleRow.append(titleBlock.append(title).append(facts)).append(status);
    info.append(titleRow).append(strip);
    head.append(poster).append(info);
    var backdrop = imagePath(movie.backdrop_path), cover = imagePath(movie.poster_path);
    if (backdrop && L.Api && L.Api.img) art.css('background-image', 'url("' + L.Api.img(backdrop, 'w1280') + '")').addClass('has-image');
    if (cover && L.Api && L.Api.img) poster.css('background-image', 'url("' + L.Api.img(cover, 'w200') + '")').removeClass('hide');
    root.append(art).append(head);
    // Filters: quick chips, then the parameters (also →) on the right.
    var filters = $('<div class="homelab-common-filters"></div>'), chips = {};
    function chip(id, fn) { var tile = button('', 'homelab-common-filter', fn); chips[id] = tile; filters.append(tile); return tile; }
    function applyFilter() { reorder(); updateSummary(); draw(); }
    if (!recovery) {
      chip('all', function () { kind = 'all'; applyFilter(); });
      chip('online', function () { kind = 'online'; applyFilter(); });
      chip('torrent', function () { kind = 'torrent'; applyFilter(); });
    }
    chip('uhd', function () { if (q === 2160) q = qBefore === 2160 ? 0 : qBefore; else { qBefore = q; q = 2160; } if (!recovery) pref = preferences({quality: q}); applyFilter(); });
    chip('subs', function () { subsOnly = !subsOnly; if (!recovery) pref = preferences({subs: subsOnly}); applyFilter(); });
    var otherButton = button('', 'homelab-common-filter homelab-common-other-voices hide', otherVoices); filters.append(otherButton);
    var summary = button('', 'homelab-common-summary', function () { openSettings(); }), summaryText = $('<span class="homelab-common-summary-text"></span>');
    summary.append($('<span class="homelab-common-summary-icon"></span>')).append(summaryText).append($('<span class="homelab-common-summary-go"></span>').text('›'));
    filters.append(summary); root.append(filters);
    // The hero: the top recommendation, played by one OK; the list continues under it.
    var heroBox = $('<div class="homelab-common-herobox hide"></div>'); root.append(heroBox);
    // A finger scroll started between rows fixes the order like a touch on a row.
    scroll.render().on('touchmove', function () { locked = true; });
    body.appendTo(scroll.body()); main.append(scroll.render()).append(detail); root.append(main); root.append(hint);
    var recoveryLabel = recovery ? $('<div class="homelab-common-recovery"></div>') : null;
    // Recovery banner: the kept voice and the one caveat; the hero says what resumes where.
    function recoveryText() {
      if (!recoveryLabel) return;
      recoveryLabel.empty().append($('<span class="homelab-common-recovery-voice' + (recovery.voice ? '' : ' is-none') + '"></span>').text(recovery.voice ? 'Озвучка: ' + recovery.voice : 'Выберите озвучку'));
      recoveryLabel.append($('<span class="homelab-common-recovery-note"></span>').text('тайминги версий могут отличаться'));
    }
    if (recoveryLabel) { head.after(recoveryLabel); recoveryText(); }
    function active() { return !dead && L.Activity.active() === object; }
    // The list owns focus only while the parameters panel is closed.
    function ownList() { return L.Controller.own(self) && !settingsOpen && !picking; }
    // With nothing focused yet: the top of the list, else the parameters (never the episode strip by accident).
    function focus(background) { restoringFocus = !!background; L.Controller.collectionSet(root, false, true); L.Controller.collectionFocus(last && root[0].contains(last) ? last : listNodes()[0] || summary[0], root, true); restoringFocus = false; }
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
      locked = false; order = []; shown = 20; last = null; fresh = 0; freshKeys = {}; sequence = ''; sequenceKeys = []; detailSig = ''; detailKey = ''; scroll.reset();
    }
    // Torrents sit in their own section under the online voices, open by default; OK on the header folds it.
    function section(count, open) {
      var tile = tiles['section:torrents'];
      if (!tile) tile = tiles['section:torrents'] = button('', 'homelab-common-section', function () {
        torrentsOpen = !sectionOpen; toggled = true; locked = true; draw();
      });
      tile.text((open ? '▾ Торренты · ' : '▸ Торренты · ') + plural(count, ['раздача', 'раздачи', 'раздач']) + (open ? '' : ' — показать'));
      return tile;
    }
    var sectionOpen = false, voicesOpen = null;
    // Recovery keeps the voice: its sources are the list, other voices fold below.
    function voicesSection(count, open) {
      var tile = tiles['section:voices'];
      if (!tile) tile = tiles['section:voices'] = button('', 'homelab-common-section', function () { voicesOpen = !voicesShown; locked = true; draw(); });
      tile.text((open ? '▾ Другие озвучки · ' : '▸ Другие озвучки · ') + count + (open ? '' : ' — показать'));
      return tile;
    }
    var voicesShown = false;
    // Voices whose quality nobody checked fold below the checked ones.
    var checkedKeys = {}, uncheckedOpen = true, uncheckedShown = true;
    function uncheckedSection(count, open) {
      var tile = tiles['section:unchecked'];
      if (!tile) tile = tiles['section:unchecked'] = button('', 'homelab-common-section', function () { uncheckedOpen = !uncheckedShown; locked = true; draw(); });
      tile.text((open ? '▾ Ещё ' : '▸ Ещё ') + plural(count, ['озвучка', 'озвучки', 'озвучек']) + ' · качество не проверено');
      return tile;
    }
    function sourceMode() { return grouped && !!(recovery && recovery.voice); }
    // The voice this title is being watched in (Continue): its card leads, from the source that played it.
    function watchedVoice() {
      if (recovery || !window.homelabContinue || typeof window.homelabContinue.list !== 'function') return null;
      var card = (movie.name ? 'tv_' : 'movie_') + movie.id, item = null;
      try { item = window.homelabContinue.list().find(function (entry) { return entry && entry.card === card && entry.kind === 'online' && entry.online && entry.online.voice; }); } catch (_) {}
      var canon = item ? canonVoice(item.online.voice) : null;
      return canon && canon.key ? {key: 'voice:' + canon.key, provider: item.online.provider, label: canon.label, season: item.season || 0, episode: item.episode || 0, position: Number(item.position) || 0, duration: Number(item.duration) || 0} : null;
    }
    // Where this title stands in Continue, whatever played it: the episode strip marks it.
    function continued() {
      if (!window.homelabContinue || typeof window.homelabContinue.list !== 'function') return null;
      var card = (tv ? 'tv_' : 'movie_') + movie.id;
      try { return window.homelabContinue.list().find(function (entry) { return entry && entry.card === card; }) || null; } catch (_) { return null; }
    }
    var mine = watchedVoice();
    function otherVoices() {
      if (!recovery || !active() || sync.scope() !== currentScope) return;
      recovery.voice = ''; recoveryText(); locked = false; order = []; shown = 20; last = null; scroll.reset(); updateSummary(); draw();
      if (ownList()) focus(true);
    }
    function matchLabel(tile, row) {
      tile.find('.homelab-common-match').toggleClass('hide', !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) !== 1);
    }
    function seasonTitle(value) { return value === 0 ? 'Спецвыпуски' : 'Сезон ' + value; }
    // The chips show what to search and 4K/subtitles; the parameters chip names the rest.
    function updateSummary() {
      var parts = [];
      if (tv) parts.push((selection.season === 0 ? 'Спецвыпуски' : 'С' + selection.season) + ' · Е' + selection.episode);
      if (q && q !== 2160) parts.push(qualityLabel(q));
      if (!grouped) parts.push('все источники');
      summaryText.text(parts.length ? parts.join(' · ') : 'Параметры');
      if (chips.all) chips.all.toggleClass('is-on', kind === 'all');
      if (chips.online) chips.online.toggleClass('is-on', kind === 'online');
      if (chips.torrent) chips.torrent.toggleClass('is-on', kind === 'torrent');
      chips.uhd.toggleClass('is-on', q === 2160); chips.subs.toggleClass('is-on', !!subsOnly);
    }
    function chipText(id, name, count) {
      var tile = chips[id]; if (!tile) return;
      var sig = name + '|' + (count === undefined ? '' : count);
      if (tile.data('sig') === sig) return;
      tile.data('sig', sig).empty().append($('<span></span>').text(name));
      if (count !== undefined) tile.append($('<span class="homelab-common-filter-count"></span>').text(String(count)));
    }
    // ── Episode strip: a window of the season's episodes; OK searches one, the edges slide the window ──
    function seasonEntry(season) { return Array.isArray(movie.seasons) ? movie.seasons.find(function (entry) { return entry && entry.season_number === season; }) : null; }
    function askSeasons() {
      if (!tv || recovery || seasonsAsked || Array.isArray(movie.seasons) && movie.seasons.length) return;
      seasonsAsked = true;
      L.Api.sources.tmdb.get('tv/' + movie.id, {}, function (data) {
        if (dead || !data || +data.id !== movie.id || !Array.isArray(data.seasons)) return;
        movie.seasons = data.seasons; drawStrip();
        if (settingsOpen && active()) { renderSettings(); focusSetting(); }
      }, function () {});
    }
    // keep: the strip node to refocus after a restart (an episode number, or -1 for the season button).
    function drawStrip(keep) {
      if (!tv || recovery) return;
      var entry = seasonEntry(selection.season), count = entry && Number.isInteger(entry.episode_count) ? Math.min(entry.episode_count, 999) : 0;
      var total = count ? Math.max(count, selection.episode) : 0, center = stripCenter || selection.episode;
      var from = Math.max(1, total ? Math.min(center - 3, total - 6) : center - 3), to = total ? Math.min(total, from + 6) : from + 6;
      var focused = keep || (last && strip[0].contains(last) ? last.homelabEpisode : 0), target = null, seen = continued();
      strip.empty().removeClass('hide');
      var seasonButton = button(seasonTitle(selection.season), 'homelab-common-season', function () { seasonMenu(); });
      seasonButton[0].homelabEpisode = -1; strip.append(seasonButton);
      // A tap gives no hover:focus, so on phones the arrows slide the window themselves.
      strip.append(stripArrow(from > 1 ? '‹' : '', from));
      for (var ep = from; ep <= to; ep++) strip.append(episodeTile(ep, from, to, total, seen));
      strip.append(stripArrow(!total || to < total ? '›' : '', to));
      if (count) strip.append($('<span class="homelab-common-eps-total"></span>').text('из ' + count));
      Array.prototype.forEach.call(strip[0].querySelectorAll('.selector'), function (node) { if (focused && node.homelabEpisode === focused) target = node; });
      if (focused && ownList()) { last = target || strip[0].querySelectorAll('.selector')[0]; focus(true); }
    }
    function stripArrow(text, center) {
      return $('<span class="homelab-common-eps-arrow"></span>').text(text).on('click', function () { if (text && !dead) { stripCenter = center; drawStrip(); } });
    }
    function episodeTile(ep, from, to, total, seen) {
      var cls = 'homelab-common-ep' + (ep === selection.episode ? ' is-current' : ''), started = 0;
      if (seen && seen.season === selection.season) {
        if (ep < seen.episode) cls += ' is-watched';
        else if (ep === seen.episode && Number(seen.duration) > 0) started = Math.min(1, Math.max(0, Number(seen.position) / Number(seen.duration)));
      }
      var tile = button(String(ep), cls, function () {
        if (ep === selection.episode || !active()) return;
        selection.episode = ep; stripCenter = ep; untouched = true; restart();
      });
      tile[0].homelabEpisode = ep;
      if (started > 0) tile.append($('<span class="homelab-common-ep-bar"></span>').css('width', Math.round(started * 100) + '%'));
      // Reaching an edge slides the window so the next episodes come into view.
      tile.on('hover:focus', function () {
        if (!(ep === from && from > 1 || ep === to && (!total || to < total))) return;
        clearTimeout(stripTimer); stripTimer = setTimeout(function () { if (!dead && last && last.homelabEpisode === ep) { stripCenter = ep; drawStrip(); } }, 0);
      });
      return tile;
    }
    function seasonMenu(preferred) {
      var token = ++uiIntent, marked = Number.isInteger(preferred) ? preferred : selection.season;
      function complete(data) {
        if (!active() || token !== uiIntent || !ownList() || sync.scope() !== currentScope) return;
        var seasons = data && Array.isArray(data.seasons) ? data.seasons : [];
        var values = seasons.filter(function (entry) { return Number.isInteger(entry.season_number) && entry.season_number >= 0 && entry.season_number <= 999; }).map(function (entry) {
          return {title: entry.name || seasonTitle(entry.season_number), value: entry.season_number, selected: entry.season_number === marked};
        });
        if (!values.length) return L.Noty.show('Не удалось получить список сезонов');
        movie.seasons = seasons;
        choose('Сезон', values, function (value) { selection.season = value.value; selection.episode = 1; untouched = true; restart(); });
      }
      if (Array.isArray(movie.seasons) && movie.seasons.length) return complete(movie);
      L.Api.sources.tmdb.get('tv/' + movie.id, {}, function (data) { complete(data && +data.id === movie.id ? data : null); }, function () { complete(null); });
    }
    // The list of a season picked in the panel but not yet searched: choosing an episode applies both.
    function episodeMenu(wanted) {
      var season = wanted ? wanted.season : selection.season, marked = wanted ? wanted.episode : selection.episode, token = ++uiIntent, from = selection.season;
      L.Api.sources.tmdb.get('tv/' + movie.id + '/season/' + season, {}, function (data) {
        if (!active() || token !== uiIntent || from !== selection.season || !ownList() || sync.scope() !== currentScope) return;
        choose('Серия', (data.episodes || []).map(function (episode) { return {title: episode.episode_number + ' · ' + episode.name, value: episode.episode_number, selected: episode.episode_number === marked}; }), function (value) { selection.season = season; selection.episode = value.value; untouched = true; restart(); });
      }, function () { if (active()) L.Noty.show('Не удалось получить список серий'); });
    }
    // ── Parameters: what the header chips used to hold, one press of → away from any row ──
    var SETTINGS = 'homelab_common_settings', panel = $('<div class="homelab-common-settings hide"></div>'), panelList = $('<div class="homelab-common-settings-list"></div>');
    var settingsOpen = false, settingIndex = 0, settingRows = [], pending = null, seasonsAsked = false;
    panel.append($('<div class="homelab-common-settings-title"></div>').text('Параметры')).append(panelList)
      .append($('<div class="homelab-common-settings-hint"></div>').text('↑↓ выбор · ←→ значение · ОК — список · Назад — закрыть'));
    root.append(panel);
    // A click (mouse, touch) outside the panel closes it, as Back does; the click that opened it (on the chip) bubbles here too.
    root.on('click', function (event) { if (settingsOpen && event && event.target && !panel[0].contains(event.target) && !summary[0].contains(event.target)) closeSettings(); });
    function seasonList() {
      var known = Array.isArray(movie.seasons) ? movie.seasons.map(function (entry) { return entry && entry.season_number; }).filter(function (value) { return Number.isInteger(value) && value >= 0 && value <= 999; }) : [];
      if (!known.length && Number.isInteger(movie.number_of_seasons) && movie.number_of_seasons > 0) for (var i = 1; i <= Math.min(movie.number_of_seasons, 999); i++) known.push(i);
      if (known.indexOf(pending.season) < 0) known.push(pending.season);
      return known.sort(function (a, b) { return a - b; });
    }
    function episodeList() {
      var entry = Array.isArray(movie.seasons) && movie.seasons.find(function (value) { return value && value.season_number === pending.season; }), count = entry && Number.isInteger(entry.episode_count) ? Math.min(entry.episode_count, 999) : 0, list = [];
      for (var i = 1; i <= count; i++) list.push(i);
      if (list.indexOf(pending.episode) < 0) list.push(pending.episode);
      return list.sort(function (a, b) { return a - b; });
    }
    function reorder() { shown = 20; locked = false; order = []; scroll.reset(); }
    function settingEntries() {
      var list = [];
      if (tv && !recovery) {
        list.push({label: 'Сезон', values: seasonList().map(function (value) { return {value: value, title: seasonTitle(value)}; }), current: pending.season,
          set: function (value) { pending.season = value; pending.episode = 1; }, enter: function (wanted) { seasonMenu(wanted.season); }, edge: true});
        list.push({label: 'Серия', values: episodeList().map(function (value) { return {value: value, title: 'Серия ' + value}; }), current: pending.episode,
          set: function (value) { pending.episode = value; }, enter: episodeMenu, edge: true});
      }
      list.push({label: 'Что искать', values: [['all', 'Всё'], ['online', 'Онлайн'], ['torrent', 'Торренты']].filter(function (value) { return !recovery || value[0] !== 'torrent'; }).map(function (value) { return {value: value[0], title: value[1]}; }),
        current: kind, set: function (value) { kind = value; reorder(); }});
      list.push({label: 'Качество', values: [0, 2160, 1080, 720].map(function (value) { return {value: value, title: value ? qualityLabel(value) : 'Любое'}; }),
        current: q, set: function (value) { q = value; qBefore = 0; if (!recovery) pref = preferences({quality: value}); reorder(); }});
      list.push({label: 'Показывать', values: [{value: true, title: 'По озвучкам'}, {value: false, title: 'Все источники'}], current: grouped,
        set: function (value) { grouped = value; resetList(); }});
      list.push({label: 'Субтитры', values: [{value: false, title: 'Неважно'}, {value: true, title: 'Только с субтитрами'}], current: subsOnly,
        set: function (value) { subsOnly = value; if (!recovery) pref = preferences({subs: value}); reorder(); }});
      if (recovery && recovery.voice) list.push({button: 'Другие озвучки', enter: otherVoices});
      list.push({button: 'Обновить поиск', refresh: true});
      return list;
    }
    function currentIndex(entry) { for (var i = 0; i < entry.values.length; i++) if (entry.values[i].value === entry.current) return i; return 0; }
    function renderSettings() {
      settingRows = settingEntries(); settingIndex = Math.max(0, Math.min(settingIndex, settingRows.length - 1)); panelList.empty();
      settingRows.forEach(function (entry, index) {
        var row = $('<div class="selector homelab-common-setting' + (entry.button ? ' is-button' : '') + '"></div>');
        if (entry.button) row.text(entry.button);
        else {
          var values = $('<div class="homelab-common-setting-values"></div>'), at = currentIndex(entry), from = entry.values.length > 5 ? Math.max(0, Math.min(at - 2, entry.values.length - 5)) : 0;
          entry.values.slice(from, from + 5).forEach(function (value, offset) {
            // A tap on a value picks it; the row's own OK still steps or opens the full list.
            values.append($('<span class="homelab-common-setting-value' + (from + offset === at ? ' selected' : '') + '"></span>').text(value.title).on('click', function (event) {
              event.stopPropagation(); settingIndex = index;
              if (value.value === entry.current) return;
              entry.set(value.value); updateSummary(); draw(); renderSettings(); focusSetting();
            }));
          });
          if (from + 5 < entry.values.length) values.append($('<span class="homelab-common-setting-more"></span>').text('…'));
          row.append($('<div class="homelab-common-setting-label"></div>').text(entry.label)).append(values);
        }
        row.on('hover:focus', function () { settingIndex = index; }).on('hover:enter', function () { settingIndex = index; activateSetting(); });
        entry.node = row; panelList.append(row);
      });
    }
    function focusSetting() {
      var entry = settingRows[settingIndex];
      if (entry) { L.Controller.collectionSet(panel, false, true); L.Controller.collectionFocus(entry.node[0], panel, true); }
    }
    function stepSetting(direction, closes) {
      var entry = settingRows[settingIndex];
      if (!entry) return;
      var next = entry.values ? currentIndex(entry) + direction : -1;
      if (!entry.values || next < 0 || next >= entry.values.length) { if (closes && !entry.edge) closeSettings(); return; }
      entry.set(entry.values[next].value); updateSummary(); draw(); renderSettings(); focusSetting();
    }
    // OK on a value row: the full list where there is one (seasons, episodes), else the next value.
    function activateSetting() {
      var entry = settingRows[settingIndex];
      if (!entry) return;
      if (entry.refresh) { closeSettings(false, true); restart(true); return; }
      if (entry.enter) { var wanted = pending; closeSettings(true); entry.enter(wanted); return; }
      var next = (currentIndex(entry) + 1) % entry.values.length;
      entry.set(entry.values[next].value); updateSummary(); draw(); renderSettings(); focusSetting();
    }
    function openSettings() {
      if (!active() || settingsOpen) return;
      touch(); settingsOpen = true; pending = {season: selection.season, episode: selection.episode}; settingIndex = 0;
      panel.removeClass('hide'); root.addClass('is-settings'); renderSettings();
      L.Controller.toggle(SETTINGS);
      // Seasons and their episode counts come from the title's metadata, asked once.
      askSeasons();
    }
    // Closing applies a changed episode; discard drops it (a full season or episode list replaces it).
    // quiet: apply the episode but leave the search to the caller.
    function closeSettings(discard, quiet) {
      if (!settingsOpen) return;
      var wanted = pending; settingsOpen = false; pending = null; panel.addClass('hide'); root.removeClass('is-settings');
      if (!discard && wanted && (wanted.season !== selection.season || wanted.episode !== selection.episode)) {
        selection.season = wanted.season; selection.episode = wanted.episode; untouched = true;
        if (!quiet) restart();
      }
      // A filter change may have removed the focused card: return to the top of the list, not the header.
      if (!last || !inList(last) || !visibleNode(last)) last = listNodes()[0] || last;
      if (active()) L.Controller.toggle('content');
    }
    function directIdentity(row) {
      return /^[a-z0-9_.-]{1,80}$/i.test(row.provider) && typeof row.identityVoice === 'string' && row.identityVoice.length <= 200 && Number.isInteger(row.seasonIndex) && row.seasonIndex >= 0 && row.seasonIndex <= 999;
    }
    function openNative(row) {
      L.Activity.push({component: 'lampac', movie: movie, title: 'Онлайн', search: movie.title || movie.name, search_one: movie.title || movie.name, search_two: movie.original_title || movie.original_name, page: 1, lampac_custom_select: row.provider});
    }
    function open(row) {
      if (!active() || sync.scope() !== currentScope) return;
      // Another voice is a choice made in the "Другие озвучки" fold (or after clearing the voice); the failed provider never is.
      if (recovery && (row.native || row.kind !== 'online' || row.provider === recovery.excludeProvider || recovery.voice && !sourceMode() && !voiceMatch(recovery.voice, row.identityVoice))) return;
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
    function rowSubtitles(row) {
      if (row.subtitles !== undefined) return row.subtitles;
      if (row.release && !row.described) row.described = describeRelease(row.release);
      return row.described && row.described.subtitles || null;
    }
    function hasSubtitles(row) { return !!rowSubtitles(row) || !!(row.canon && row.canon.subs); }
    // null when no row has subtitles, else their languages ("" when unnamed).
    function subtitleLanguagesOf(rows) {
      var found = null;
      rows.forEach(function (row) {
        var subtitles = rowSubtitles(row); if (!subtitles) return;
        found = (found || '').split(' · ').concat(subtitles.langs.split(' · ')).filter(function (lang, index, all) { return lang && all.indexOf(lang) === index; }).join(' · ');
      });
      return found;
    }
    function subtitleNote(row) { var subtitles = rowSubtitles(row); return subtitles ? 'субтитры' + (subtitles.langs ? ' ' + subtitles.langs : '') : ''; }
    function qualityClass(value) { return value >= 2160 ? 'is-uhd' : value >= 1080 ? 'is-hd' : value ? 'is-sd' : 'is-none'; }
    function gigabytes(release) { var size = Number(release.Size || release.size); return size > 0 ? (size / 1073741824).toFixed(1).replace('.', ',') + ' ГБ' : ''; }
    // What a card shows; the signature lets draw() skip unchanged cards instead of rebuilding them.
    function view(item, hero) {
      var row = item.best, count = item.rows.length, best = row.qualities[0] || 0;
      if (item.key === 'native') {
        var names = item.rows.map(function (entry) { return entry.providerName; }).filter(function (name, index, all) { return all.indexOf(name) === index; });
        var nativeModel = {voice: 'Открыть в источниках', details: plural(names.length, SOURCES) + ': ' + names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '') + ' · выбор внутри источника',
          badges: [], cls: 'is-native', note: '', quality: '', qcls: 'is-none', pick: ''};
        nativeModel.sig = [nativeModel.voice, nativeModel.details].join('|');
        return nativeModel;
      }
      if (item.nativeOne) {
        var oneModel = {voice: row.providerName, details: 'откроется список озвучек источника', badges: [], cls: 'is-native', note: '', quality: '', qcls: 'is-none', pick: '', what: '', progress: 0};
        oneModel.sig = ['one', oneModel.voice].join('|');
        return oneModel;
      }
      if (item.source) {
        var sourceModel = {voice: sourceName(row), badges: [], cls: 'is-online is-source', note: ''};
        sourceModel.details = [row.canon && row.canon.label || row.identityVoice, row.unavailable ? 'Не отдаёт видео' : !best ? 'Качество уточняется' : ''].filter(Boolean).join(' · ');
        var sourceLangs = subtitleLanguagesOf([row]);
        if (sourceLangs !== null || row.canon && row.canon.subs) sourceModel.badges.push([sourceLangs || 'субтитры', 'is-subs']);
        if (row.unavailable) { sourceModel.quality = 'нет видео'; sourceModel.qcls = 'is-off'; sourceModel.cls += ' is-unavailable'; }
        else if (best) { sourceModel.quality = qualityLabel(best); sourceModel.qcls = qualityClass(best); }
        else { sourceModel.quality = '—'; sourceModel.qcls = 'is-none'; }
        sourceModel.cls += ' has-' + sourceModel.qcls.slice(3);
        if (!row.unavailable && best) sourceModel.note = row.verified === 'play' ? 'по просмотру' : row.measured ? 'проверено' : row.doubtful ? 'заявлено, не проверено' : 'заявлено';
        sourceModel.measured = !!row.measured;
        sourceModel.pick = hero ? 'Лучший источник' + (row.measured ? ' · проверено' : '') : '';
        if (hero) sourceModel.cls += ' is-hero';
        heroLine(sourceModel, hero, false);
        sourceModel.sig = ['src', sourceModel.voice, sourceModel.details, sourceModel.quality, sourceModel.qcls, sourceModel.note, sourceModel.measured, sourceModel.pick, sourceModel.cls, sourceModel.badges.join(','), sourceModel.what, sourceModel.progress].join('|');
        return sourceModel;
      }
      var voice = !grouped ? row.voice : row.kind === 'torrent' ? (row.canon && row.canon.label || row.voice) : row.canon && row.canon.label || row.identityVoice || row.voice;
      if (voice === UNNAMED) voice = UNNAMED + ' · ' + row.providerName;
      var subs = item.rows.some(function (entry) { return entry.canon && entry.canon.subs; }), langs = subtitleLanguagesOf(item.rows);
      var model = {voice: voice, badges: [], cls: row.kind === 'torrent' ? 'is-torrent' : 'is-online', note: ''};
      model.details = row.providerName + ' · ' + (count > 1 ? 'ещё ' + plural(count - 1, row.kind === 'torrent' ? ['раздача', 'раздачи', 'раздач'] : item.key.indexOf('unnamed:') === 0 ? ['видео', 'видео', 'видео'] : SOURCES) : row.kind === 'torrent' ? 'Торрент' : 'Онлайн');
      if (row.release) {
        var described = row.described || (row.described = describeRelease(row.release)), size = gigabytes(row.release), seeds = Number(row.release.Seeders);
        if (Number.isFinite(seeds)) model.badges.push([plural(seeds, ['сид', 'сида', 'сидов']), seeds >= MIN_SEEDS ? 'is-seeds' : 'is-dead']);
        if (size) model.badges.push([size, '']);
        if (described.codec) model.badges.push([described.codec, '']);
        if (described.languages) model.badges.push([described.languages, '']);
        if (described.voices.length > 1) model.details += ' · ' + described.voices.slice(1, 3).join(', ');
        if (tv) model.details += ' · Выбор серии в раздаче';
        if (row.voiceProbe === 'pending') model.details += ' · узнаю озвучку…';
      } else if (row.unavailable) model.details += ' · Не отдаёт видео';
      else if (!best) model.details += row.native ? ' · Качество неизвестно · Открыть источник' : ' · Качество уточняется';
      // Subtitle tracks (an online file, a release's streams or title), or a subtitled voice: the CC mark carries the word.
      if (langs !== null || subs) model.badges.push([langs || 'субтитры', 'is-subs']);
      if (row.unavailable) { model.quality = 'нет видео'; model.qcls = 'is-off'; model.cls += ' is-unavailable'; }
      else if (best) { model.quality = qualityLabel(best); model.qcls = qualityClass(best); }
      else { model.quality = '—'; model.qcls = 'is-none'; }
      model.cls += ' has-' + model.qcls.slice(3);
      if (!row.unavailable && best && row.kind === 'online') {
        model.note = row.verified === 'play' ? 'по просмотру' : row.measured ? 'проверено' : row.doubtful ? 'заявлено, не проверено' : 'заявлено';
        // The source said more than its stream has.
        if (row.measured && row.claimed > best) model.note += ' · заявлено ' + qualityLabel(row.claimed);
      }
      model.measured = !!row.measured;
      var stopped = item.mine && mine.position > 30 && (!tv || mine.season === selection.season && mine.episode === selection.episode);
      // The hero's episode line already says where it resumes.
      model.pick = item.mine ? 'Ваша озвучка · ' + (hero ? (stopped ? 'продолжить' : 'смотреть') : stopped ? 'остановились на ' + L.Utils.secondsToTime(mine.position) : 'вы смотрите в ней') : hero ? 'Лучший выбор' + (row.measured ? ' · проверено' : '') : '';
      if (item.mine) model.cls += ' is-mine';
      if (hero) model.cls += ' is-hero';
      heroLine(model, hero, stopped);
      model.sig = [model.voice, model.details, model.quality, model.qcls, model.note, model.measured, model.pick, model.cls, model.badges.join(','), model.what, model.progress].join('|');
      return model;
    }
    // The hero names what one OK plays: the episode, and where it resumes.
    function heroLine(model, hero, stopped) {
      model.what = ''; model.progress = 0;
      if (!hero) return;
      var at = recovery ? Number(recovery.position) || 0 : stopped ? mine.position : 0, duration = recovery ? Number(recovery.duration) || 0 : stopped ? mine.duration : 0;
      var from = at > 0 ? L.Utils.secondsToTime(at) : '';
      model.what = tv ? (selection.season === 0 ? 'Спецвыпуск ' : 'Серия ') + selection.episode + (from ? ' · с ' + from : '') : from ? 'Продолжить с ' + from : '';
      if (at > 0 && duration > 0) model.progress = Math.round(Math.min(1, at / duration) * 100);
    }
    function fill(tile, model) {
      if (tile.data('sig') === model.sig) return;
      tile.data('sig', model.sig);
      // Swap only the modifier classes so Lampa's own focus class survives.
      tile.removeClass(tile.data('cls') || '').addClass(model.cls).data('cls', model.cls);
      tile.find('.homelab-common-pick').text(model.pick).toggleClass('hide', !model.pick);
      tile.find('.homelab-common-what').text(model.what || '').toggleClass('hide', !model.what);
      tile.find('.homelab-common-progress').toggleClass('hide', !model.progress).find('.homelab-common-progress-fill').css('width', (model.progress || 0) + '%');
      tile.find('.homelab-common-voice').text(model.voice);
      tile.find('.homelab-common-details').text(model.details);
      var badges = tile.find('.homelab-common-badges').empty().toggleClass('hide', !model.badges.length);
      model.badges.forEach(function (badge) { badges.append($('<span class="homelab-common-badge ' + badge[1] + '"></span>').text(badge[0])); });
      var badge = tile.find('.homelab-common-q'); badge.removeClass(badge.data('cls') || '').addClass(model.qcls).data('cls', model.qcls).text(model.quality);
      var note = tile.find('.homelab-common-q-note').toggleClass('hide', !model.note).toggleClass('is-measured', !!model.measured).empty();
      if (model.measured) note.append($('<span class="homelab-common-check"></span>').html(CHECK));
      if (model.note) note.append($('<span></span>').text(model.note));
    }
    function card(key) {
      var tile = $('<div class="selector homelab-common-result"></div>'), text = $('<div class="homelab-common-text"></div>'), side = $('<div class="homelab-common-quality"></div>');
      // One line in the list; as the hero the same tile grows a play mark, the episode line and progress.
      text.append($('<div class="homelab-common-pick hide"></div>')).append($('<div class="homelab-common-what hide"></div>'))
        .append($('<div class="homelab-common-name"></div>').append($('<span class="homelab-common-voice"></span>')).append($('<span class="homelab-common-tag">ваша</span>')))
        .append($('<div class="homelab-common-match hide"></div>').text('Та же студия · название отличается, проверьте версию'))
        .append($('<div class="homelab-common-line"></div>').append($('<span class="homelab-common-details"></span>')).append($('<span class="homelab-common-badges hide"></span>')));
      side.append($('<div class="homelab-common-q"></div>')).append($('<div class="homelab-common-q-note hide"></div>'));
      tile.append($('<div class="homelab-common-play"></div>')).append(text).append(side)
        .append($('<div class="homelab-common-progress hide"></div>').append($('<div class="homelab-common-progress-fill"></div>')));
      tile.on('hover:focus', function () {
        last = this; if (!restoringFocus) { locked = true; if (body[0].contains(this)) scroll.update(this, true); else scroll.reset(); }
        showDetail(key);
        // Dwelling on a torrent without a named voice asks its audio tracks.
        var focused = this; clearTimeout(voiceTimer);
        voiceTimer = setTimeout(function () { if (!dead && last === focused && search && models[key] && models[key].best && search.voices) search.voices(models[key].best); }, 1200);
      })
        .on('hover:hover hover:touch', function () { locked = true; touch(); })
        .on('hover:enter', function () { touch(); if (!models[key]) return; if (key === 'native') sourceMenu(models[key]); else open(models[key].best); })
        .on('hover:long', function () { touch(); if (models[key]) sourceMenu(models[key]); });
      return tile;
    }
    // One source of a card, as the detail panel and the source menu name it.
    function sourceName(entry) {
      if (entry.release || entry.native) return entry.providerName;
      // What sets this source's track apart within the card: «Дублированный HDrezka» under HDRezka reads «Дублированный».
      var voice = String(entry.voice || ''), identity = String(entry.canon && entry.canon.label || entry.identityVoice || ''), at = identity ? voice.toLowerCase().indexOf(identity.toLowerCase()) : -1;
      var extra = at >= 0 ? (voice.slice(0, at) + ' ' + voice.slice(at + identity.length)).replace(/[\s·,|()\-–]+/g, ' ').replace(/^\s+|\s+$/g, '') : voice !== identity ? voice : '';
      return entry.providerName + (extra ? ' · ' + extra : '');
    }
    function rowLine(row) {
      if (row.unavailable) return 'Не отдаёт видео';
      if (row.native) return 'Открыть в источнике';
      var note = subtitleNote(row), subtitles = note ? ' · ' + note : '';
      if (!row.qualities.length) return 'Качество уточняется' + subtitles;
      return row.qualities.map(qualityLabel).join(' / ') + (row.kind === 'online' ? (row.verified === 'play' ? ' · по просмотру' : row.measured ? ' · проверено' : ' · заявлено') + (row.measured && row.claimed > (row.qualities[0] || 0) ? ' (заявлено ' + qualityLabel(row.claimed) + ')' : '') : '') + subtitles;
    }
    function releaseLine(entry) {
      var seeds = Number(entry.release.Seeders);
      return [entry.qualities.length ? qualityLabel(entry.qualities[0]) : '', Number.isFinite(seeds) ? plural(seeds, ['сид', 'сида', 'сидов']) : '', gigabytes(entry.release), subtitleNote(entry), entry.providerName].filter(Boolean).join(' · ');
    }
    // ── Detail panel: the focused card's sources and how far their quality can be trusted ──
    function verdict(item) {
      var row = item.best, best = row.unavailable ? 0 : row.qualities[0] || 0;
      if (item.key === 'native' || row.native) return ['', 'Этот источник не отдаёт список озвучек сюда: ОК откроет его, озвучку и качество выберете там'];
      if (row.unavailable) return ['is-bad', 'Источник не отдаёт видео'];
      if (row.release) { var seeds = Number(row.release.Seeders); return Number.isFinite(seeds) ? [seeds >= MIN_SEEDS ? 'is-ok' : 'is-bad', seeds >= MIN_SEEDS ? plural(seeds, ['сид', 'сида', 'сидов']) + ' · раздача живая' : 'Мало сидов: запуск может не начаться'] : ['', 'Раздача']; }
      if (row.measured && row.claimed > best) return ['is-warn', 'Заявлено ' + qualityLabel(row.claimed) + ', поток ' + qualityLabel(best)];
      if (row.verified === 'play') return ['is-ok', '✓ Подтверждено просмотром'];
      if (row.measured) return ['is-ok', '✓ Проверено по потоку'];
      if (best) return ['', row.doubtful ? 'Заявлено источником, который часто завышает' : 'Заявлено источником, ещё не проверено'];
      return ['', 'Качество уточняется'];
    }
    function sourceValue(entry) {
      if (entry.unavailable) return ['is-bad', 'нет видео'];
      if (entry.native) return ['', 'выбор в источнике'];
      if (entry.release) { var seeds = Number(entry.release.Seeders); return [Number.isFinite(seeds) && seeds < MIN_SEEDS ? 'is-bad' : '', [entry.qualities.length ? qualityLabel(entry.qualities[0]) : '', Number.isFinite(seeds) ? plural(seeds, ['сид', 'сида', 'сидов']) : '', gigabytes(entry.release)].filter(Boolean).join(' · ')]; }
      var best = entry.qualities[0] || 0;
      if (!best) return ['', 'уточняется'];
      if (entry.measured && entry.claimed > best) return ['is-warn', qualityLabel(best) + ' · заявлено ' + qualityLabel(entry.claimed)];
      return [entry.measured ? 'is-ok' : '', qualityLabel(best) + (entry.verified === 'play' ? ' · по просмотру' : entry.measured ? ' · проверено' : ' · заявлено')];
    }
    function keysText(item) {
      var right = pickable(item) ? item.best.release ? ' · → выбрать раздачу' : ' · → выбрать источник' : ' · → параметры';
      return (recovery ? 'ОК — продолжить с ' + L.Utils.secondsToTime(recovery.position) : 'ОК — смотреть') + right;
    }
    function showDetail(key) {
      var item = key && models[key];
      if (!item || item.section || picking) return;
      var row = item.best, model = view(item, false);
      var sig = [key, model.sig, item.source ? visibleItems.filter(function (entry) { return entry.source; }).map(function (entry) { return entry.key + ':' + (entry.best.qualities[0] || 0) + (entry.best.measured ? 'm' : ''); }).join(',') : '', item.rows.map(function (entry) { return entry.key + ':' + (entry.qualities[0] || 0) + (entry.measured ? 'm' : '') + (entry.unavailable ? 'u' : ''); }).join(',')].join('|');
      if (sig === detailSig) return;
      detailSig = sig; detailKey = key; detail.empty().removeClass('hide');
      var top = $('<div class="homelab-common-detail-top"></div>'), named = $('<div class="homelab-common-detail-name"></div>');
      top.append($('<div class="homelab-common-ring ' + model.qcls + '"></div>').text(model.quality || '—'));
      named.append($('<div class="homelab-common-detail-voice"></div>').text(model.voice));
      named.append($('<div class="homelab-common-detail-kind"></div>').text(item.source ? (row.canon && row.canon.label || row.identityVoice) : item.key === 'native' || row.native ? 'Выбор внутри источника' : row.release ? 'Торрент' + (row.described && row.described.codec ? ' · ' + row.described.codec : '') : 'Онлайн · ' + plural(item.rows.length, SOURCES)));
      detail.append(top.append(named));
      var said = verdict(item);
      detail.append($('<div class="homelab-common-verdict ' + said[0] + '"></div>').text(said[1]));
      var langs = subtitleLanguagesOf(item.rows);
      if (langs !== null || item.rows.some(function (entry) { return entry.canon && entry.canon.subs; })) detail.append($('<div class="homelab-common-detail-subs"></div>').text('Субтитры: ' + (langs || 'есть')));
      // A source row compares itself with the other sources of the kept voice; a card lists the sources behind it.
      var compared = item.source ? visibleItems.filter(function (entry) { return entry.source; }).map(function (entry) { return entry.best; }) : item.rows;
      detail.append($('<div class="homelab-common-detail-label"></div>').text(item.source ? 'Все источники озвучки' : row.release ? 'Раздачи' : 'Источники'));
      var list = $('<div class="homelab-common-sources"></div>');
      compared.slice(0, 6).forEach(function (entry) { list.append(sourceLine(entry, entry === row)); });
      if (compared.length > 6) list.append($('<div class="homelab-common-source-more"></div>').text('ещё ' + plural(compared.length - 6, row.release ? ['раздача', 'раздачи', 'раздач'] : SOURCES) + (item.source ? ' — ниже в списке' : ' — нажмите →')));
      detail.append(list).append($('<div class="homelab-common-keys"></div>').text(keysText(item)));
    }
    function sourceLine(entry, best) {
      var value = sourceValue(entry), height = entry.unavailable ? 0 : entry.qualities[0] || 0, line = $('<div class="homelab-common-source' + (best ? ' is-best' : '') + '"></div>');
      line.append($('<span class="homelab-common-source-name"></span>').text(sourceName(entry))).append($('<span class="homelab-common-source-value ' + value[0] + '"></span>').text(value[1]));
      return line.append($('<span class="homelab-common-meter"></span>').append($('<span class="homelab-common-meter-fill ' + qualityClass(height) + '"></span>').css('width', Math.round(height / 2160 * 100) + '%')));
    }
    // → on a card with several sources: choose one in the detail panel; where the panel is not
    // shown (narrow screens) the same list opens as Lampa's menu. OK on the card still plays the best.
    function pickable(item) { return !!item && !item.section && !item.source && item.key !== 'native' && !item.best.native && item.rows.length > 1; }
    function startPick() {
      var key = ''; Object.keys(tiles).forEach(function (name) { if (tiles[name][0] === last) key = name; });
      var item = key && models[key];
      if (!pickable(item)) return false;
      touch();
      // Releases need their full titles to be told apart: they keep Lampa's menu.
      if (item.best.release || detailKey !== key || detail[0].offsetParent === null) { sourceMenu(item); return true; }
      if (search) search.probe(item.rows, true);
      var list = detail.find('.homelab-common-sources').empty(), state = picking = {key: key, nodes: [], index: 0};
      item.rows.forEach(function (entry, index) {
        var line = sourceLine(entry, entry === item.best).addClass('selector');
        line.on('hover:focus', function () {
          state.index = index;
          // The list clips its overflow: keep the focused source in view.
          var box = list[0], top = this.offsetTop - box.offsetTop, bottom = top + this.offsetHeight;
          if (top < box.scrollTop) box.scrollTop = top; else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
        }).on('hover:enter', function () { touch(); stopPick(); open(entry); });
        if (entry === item.best) state.index = index;
        state.nodes.push(line[0]); list.append(line);
      });
      detail.addClass('is-picking').find('.homelab-common-keys').text('ОК — смотреть этот источник · ← назад');
      L.Controller.toggle(PICK);
      return true;
    }
    function focusPick() {
      if (!picking) return L.Controller.toggle('content');
      L.Controller.collectionSet(detail, false, true); L.Controller.collectionFocus(picking.nodes[picking.index], detail, true);
    }
    function stepPick(delta) { if (picking && picking.nodes[picking.index + delta]) { picking.index += delta; focusPick(); } }
    // quiet: the panel is being redrawn or hidden anyway; only the state goes.
    function stopPick(quiet) {
      if (!picking) return;
      var key = picking.key, on = L.Controller.enabled && L.Controller.enabled();
      picking = null; detailSig = ''; detail.removeClass('is-picking').find('.homelab-common-source').removeClass('selector');
      if (!quiet) showDetail(key);
      // The keys go back to the list whenever they are still in the panel.
      if ((!quiet || on && on.name === PICK) && active()) L.Controller.toggle('content');
    }
    function leavePick() { if (picking) stopPick(); else L.Controller.toggle('content'); }
    // Long press: every source behind the card, or every release of a torrent group.
    function sourceMenu(item) {
      var row = item.best, items = [];
      if (search) search.probe(item.rows, true);
      if (item.key === 'native' || row.native) item.rows.forEach(function (entry) { items.push({title: entry.providerName, subtitle: entry.voice, open: entry}); });
      else if (row.release && item.rows.length > 1) item.rows.forEach(function (entry) { items.push({title: String(entry.release.Title).slice(0, 160), subtitle: releaseLine(entry) + (entry === row ? ' · лучшая' : ''), open: entry, selected: entry === row}); });
      else if (row.release) items.push({title: row.release.Title, subtitle: releaseLine(row), noenter: true}, {title: 'Смотреть', open: row});
      else item.rows.forEach(function (entry) {
        items.push({title: sourceName(entry) + (entry === row && item.rows.length > 1 ? ' · лучший' : ''), subtitle: rowLine(entry), open: entry, selected: entry === row});
      });
      var heading = item.key === 'native' || row.native ? row.providerName || 'Открыть в источнике' : row.release ? (item.rows.length > 1 ? plural(item.rows.length, ['раздача', 'раздачи', 'раздач']) : 'Раздача') : (item.rows.length > 1 ? plural(item.rows.length, SOURCES) + ' · ' : '') + (row.canon && row.canon.label || row.identityVoice);
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
        for (var i = 0; i < 4; i++) placeholder.append($('<div class="homelab-common-skeleton"></div>'));
      } else {
        placeholder = $('<div class="homelab-common-empty"></div>');
        placeholder.append($('<div class="homelab-common-empty-title"></div>').text(recovery ? 'Других подходящих источников нет' : 'Ничего не нашлось'));
        placeholder.append($('<div class="homelab-common-empty-hint"></div>').text(subsOnly ? 'Вариантов с субтитрами нет — снимите фильтр в параметрах (→)' : q ? 'В качестве ' + qualityLabel(q) + ' вариантов нет — выберите «Любое» в параметрах (→)' : kind !== 'all' ? 'Попробуйте «Всё» в параметрах (→)' : 'Нажмите → и «Обновить поиск», чтобы поискать заново'));
      }
      body.append(placeholder);
    }
    function draw() {
      if (dead || !search || sync.scope() !== currentScope) return;
      // Re-read each time: playing another voice from here makes it the watched one on return.
      mine = watchedVoice();
      // Groups merge while results stream in; a focused row that disappears
      // hands focus to the row now in its place, never to the filters above.
      var focusedKey = '', focusedIndex = -1;
      Object.keys(tiles).forEach(function (key) { if (tiles[key][0] === last) focusedKey = key; });
      if (focusedKey) focusedIndex = sequenceKeys.indexOf(focusedKey);
      var candidates = search.rows.filter(function (row) { return (kind === 'all' || row.kind === kind) && (!q || row.kind === 'online' && !row.qualities.length || row.qualities.indexOf(q) >= 0) && (!subsOnly || hasSubtitles(row)) && (!recovery || !row.native && row.kind === 'online' && row.provider !== recovery.excludeProvider); });
      var exact = recovery && recovery.voice ? candidates.filter(function (row) { return voiceMatch(recovery.voice, row.identityVoice) === 2; }).length : 0;
      function rank(a, b, tie) {
        var match = recovery && recovery.voice ? voiceMatch(recovery.voice, b.identityVoice) - voiceMatch(recovery.voice, a.identityVoice) : 0;
        return match || compareRows(a, b, tie);
      }
      var available = candidates.filter(function (row) { return !recovery || !recovery.voice || voiceMatch(recovery.voice, row.identityVoice) > 0; }).sort(function (a, b) { return rank(a, b); });
      var showOther = !sourceMode() && recovery && recovery.voice && candidates.length > 0 && (!exact || last === otherButton[0]);
      otherButton.text('Другие озвучки · ' + candidates.length).toggleClass('hide', !showOther);
      var byVoice = function (list) { return groupRows(list).map(function (item) {
        // The watched voice plays from the source it played from, while that source still has the video.
        if (mine && item.key === mine.key) {
          var same = item.rows.find(function (entry) { return entry.provider === mine.provider && !entry.unavailable; });
          if (same && same !== item.best) { item.rows.splice(item.rows.indexOf(same), 1); item.rows.unshift(same); item.best = same; }
          item.mine = !!item.best && !item.best.unavailable;
        }
        return item;
      }).sort(function (a, b) {
        if (!!a.mine !== !!b.mine) return a.mine ? -1 : 1;
        // Uploads without a named voice (VK, Rutube) are a last resort, however many of them there are.
        var unnamedA = a.key.indexOf('unnamed:') === 0, unnamedB = b.key.indexOf('unnamed:') === 0;
        if (unnamedA !== unnamedB) return unnamedA ? 1 : -1;
        return rank(a.best, b.best, function () { return b.rows.length - a.rows.length || (b.best.measured ? 1 : 0) - (a.best.measured ? 1 : 0); });
      }); };
      var groups = sourceMode() ? available.map(function (row) { return {key: 'row:' + row.key, rows: [row], best: row, source: true}; })
        .concat(byVoice(candidates.filter(function (row) { return !voiceMatch(recovery.voice, row.identityVoice); })).map(function (item) { item.other = true; return item; }))
        : grouped ? byVoice(available) : available.map(function (row) { return {key: 'row:' + row.key, rows: [row], best: row}; });
      var byKey = {}; groups.forEach(function (item) { byKey[item.key] = item; });
      var loading = search.onlinePending || search.torrentPending, now = Date.now();
      // Untouched lists re-rank at most once a second while results stream in; once the user moved, rows keep their places.
      if (!locked && (!loading || !order.length || now - reorderAt >= 1000)) { order = groups.map(function (item) { return item.key; }); reorderAt = now; freshKeys = {}; }
      else {
        if (!locked) { clearTimeout(rerank); rerank = setTimeout(function () { rerank = null; draw(); }, reorderAt + 1000 - now); }
        order = order.filter(function (key) { return !!byKey[key]; });
        groups.forEach(function (item) { if (order.indexOf(item.key) < 0) { order.push(item.key); if (locked) freshKeys[item.key] = true; } });
      }
      var items = order.map(function (key) { return byKey[key]; }), torrents = [];
      // The hero is the top playable item; it sits above the list, which goes on from the next one.
      var heroItem = items[0] && !items[0].other && !items[0].best.native && !items[0].best.unavailable ? items[0] : null;
      if (grouped && !sourceMode()) {
        var rest = items.filter(function (item) { return item !== heroItem; });
        torrents = rest.filter(function (item) { return item.best.kind === 'torrent'; });
        var online = rest.filter(function (item) { return item.best.kind !== 'torrent' && !item.best.native; }), natives = rest.filter(function (item) { return item.best.native; });
        // Checked voices lead; the rest fold away once there are enough checked ones. Membership holds once the user moved.
        if (!locked) { checkedKeys = {}; online.forEach(function (item) { if (isChecked(item)) checkedKeys[item.key] = true; }); }
        var checked = online.filter(function (item) { return checkedKeys[item.key]; }), unchecked = online.filter(function (item) { return !checkedKeys[item.key]; }), list = online;
        if (checked.length >= 2 && unchecked.length) {
          uncheckedShown = !!uncheckedOpen;
          list = [{key: 'label:checked', label: 'Проверенные · ' + plural(checked.length, ['озвучка', 'озвучки', 'озвучек'])}].concat(checked, [{key: 'section:unchecked', section: true, rows: unchecked}], uncheckedShown ? unchecked : []);
        }
        var onlineCount = online.length + (heroItem && heroItem.best.kind !== 'torrent' ? 1 : 0);
        if (kind === 'all') {
          // Open unless the user folded them.
          sectionOpen = torrentsOpen === null ? true : torrentsOpen;
          if (torrents.length && (onlineCount || toggled)) list = list.concat([{key: 'section:torrents', section: true, rows: torrents}], sectionOpen ? torrents : []);
          else list = list.concat(torrents);
        } else list = list.concat(torrents);
        // Under a torrents header the online rows get one too, so no row hangs outside a group.
        if (online.length && list[0] === online[0] && list.some(function (item) { return item.key === 'section:torrents'; })) list.unshift({key: 'label:online', label: 'Онлайн · ' + plural(online.length, ['озвучка', 'озвучки', 'озвучек'])});
        // Sources that keep their voices to themselves: one row each, opened in the source.
        var direct = [], named = {};
        natives.forEach(function (item) { item.rows.forEach(function (row) {
          if (named[row.provider]) return; named[row.provider] = true;
          var one = {key: 'native:' + row.provider, rows: [row], best: row, nativeOne: true}; byKey[one.key] = one; direct.push(one);
        }); });
        if (direct.length) direct.unshift({key: 'label:native', label: 'Выбор озвучки внутри источника'});
        items = (heroItem ? [heroItem] : []).concat(list, direct);
      }
      if (sourceMode()) {
        var others = items.filter(function (item) { return item.other; });
        items = items.filter(function (item) { return !item.other; });
        voicesShown = voicesOpen === null ? !items.length && !loading : voicesOpen;
        if (others.length) items = items.concat([{key: 'section:voices', section: true, rows: others}], voicesShown ? others : []);
      }
      visibleItems = items; models = byKey;
      // New rows the user can see: not those folded away.
      fresh = items.filter(function (item) { return freshKeys[item.key]; }).length;
      var real = function (item) { return !item.section && !item.label; };
      showPlaceholder(items.length ? '' : loading ? 'loading' : 'empty:' + q + ':' + kind + ':' + subsOnly, loading);
      var wanted = {}, page = items.slice(0, shown), keys = [];
      search.probe(page.filter(real).map(function (item) { return item.best; }));
      var heroKey = heroItem && page[0] === heroItem ? heroItem.key : '';
      page.forEach(function (item) {
        wanted[item.key] = true; keys.push(item.key);
        if (item.label) { (tiles[item.key] || (tiles[item.key] = $('<div class="homelab-common-label"></div>'))).text(item.label); return; }
        if (item.key === 'section:voices') { voicesSection(item.rows.length, voicesShown); return; }
        if (item.key === 'section:unchecked') { uncheckedSection(item.rows.length, uncheckedShown); return; }
        if (item.section) { section(torrents.length, sectionOpen); return; }
        var tile = tiles[item.key] || (tiles[item.key] = card(item.key));
        fill(tile, view(item, item.key === heroKey));
        matchLabel(tile, item.best);
      });
      Object.keys(tiles).forEach(function (key) { if (!wanted[key]) { tiles[key].remove(); delete tiles[key]; } });
      heroBox.toggleClass('hide', !heroKey);
      // Re-append only when the sequence changed: moving a focused node replays Lampa's focus animation.
      var seq = heroKey + '#' + keys.join('\n'), moved = seq !== sequence;
      if (moved) { sequence = seq; sequenceKeys = keys; keys.forEach(function (key) { (key === heroKey ? heroBox : body).append(tiles[key]); }); }
      var heirChanged = false;
      if (focusedKey && !tiles[focusedKey]) {
        // The row now in its place, never a heading.
        var at = Math.max(0, Math.min(focusedIndex, page.length - 1)), heir = null;
        for (var i = at; i < page.length && !heir; i++) if (real(page[i]) || page[i].section) heir = page[i];
        for (var j = at - 1; j >= 0 && !heir; j--) if (real(page[j]) || page[j].section) heir = page[j];
        last = heir && tiles[heir.key] ? tiles[heir.key][0] : null; heirChanged = true;
      }
      if (items.length > shown) {
        if (!more) more = button('', 'homelab-common-more', function () {
          var first = visibleItems[shown]; shown += 20; draw();
          if (first && tiles[first.key] && ownList()) L.Controller.collectionFocus(tiles[first.key][0], root, true);
        });
        more.text('Показать ещё · ' + (items.length - shown));
        if (moved || !body[0].contains(more[0]) || body.children().last()[0] !== more[0]) { body.append(more); moved = true; }
      } else if (more) { more.remove(); more = null; moved = true; }
      drawStatus(loading, items.filter(real), available, exact);
      drawChips();
      hint.toggleClass('hide', !items.length).text(recovery ? keysText(null) : grouped ? 'ОК — смотреть  ·  → выбрать источник' : 'ОК — смотреть  ·  удержание ОК — подробности  ·  → параметры');
      var firstCard = keys.filter(function (key) { return key.indexOf('section:') !== 0 && key.indexOf('label:') !== 0; })[0], top = firstCard && tiles[firstCard] ? tiles[firstCard][0] : null;
      // The card being chosen from was regrouped away: leave the panel for the list.
      if (picking && !models[picking.key]) stopPick();
      if (ownList()) {
        var before = last;
        if (untouched && top) last = top;
        if (moved || heirChanged || last !== before || !last) focus(true);
      }
      // The panel follows the focused card, or the top card while focus is elsewhere.
      var shownKey = '';
      Object.keys(tiles).forEach(function (key) { if (tiles[key][0] === last) shownKey = key; });
      if (!shownKey && firstCard && !models[detailKey]) shownKey = firstCard;
      if (!shownKey && models[detailKey]) shownKey = detailKey;
      if (shownKey) showDetail(shownKey);
      else if (!items.length) { stopPick(true); detail.addClass('hide'); detailSig = ''; detailKey = ''; }
    }
    function isChecked(item) { return !item.best.unavailable && (!!item.best.measured || item.best.verified === 'play'); }
    // Chip counts ignore the kind filter: they say what each choice would show.
    function drawChips() {
      var rows = search.rows.filter(function (row) { return (!q || row.kind === 'online' && !row.qualities.length || row.qualities.indexOf(q) >= 0) && (!subsOnly || hasSubtitles(row)) && (!recovery || !row.native && row.kind === 'online' && row.provider !== recovery.excludeProvider); });
      var voices = {}, releases = 0;
      rows.forEach(function (row) { if (row.kind === 'torrent') releases++; else if (!row.native) voices[row.canon && row.canon.key || row.identityVoice] = true; });
      chipText('all', 'Всё'); chipText('online', 'Онлайн', Object.keys(voices).length); chipText('torrent', 'Торренты', releases);
      chipText('uhd', '4K'); chipText('subs', 'Субтитры');
    }
    function drawStatus(loading, items, rows, exact) {
      var voices = rows.filter(function (row) { return row.kind === 'online' && !row.native; }), releases = rows.filter(function (row) { return row.kind === 'torrent'; }).length;
      var top = rows.reduce(function (max, row) { return Math.max(max, row.unavailable ? 0 : row.qualities[0] || 0); }, 0), counted = {};
      voices.forEach(function (row) { counted[row.canon && row.canon.key || row.identityVoice] = true; });
      var summaryLine = [Object.keys(counted).length ? plural(Object.keys(counted).length, ['озвучка', 'озвучки', 'озвучек']) : '', top ? 'до ' + qualityLabel(top) : '', releases ? plural(releases, ['раздача', 'раздачи', 'раздач']) : ''].filter(Boolean).join(' · ');
      var found = grouped ? summaryLine || plural(items.length, VARIANTS) : plural(rows.length, VARIANTS), parts = [], providers = search.providers || {total: 0, done: 0};
      if (loading) {
        parts.push(search.onlinePending && providers.total ? 'Ищу: ' + providers.done + ' из ' + plural(providers.total, ['источника', 'источников', 'источников']) : 'Ищем варианты…');
        if (search.onlinePending && !providers.total) parts.push('опрашиваем онлайн-источники');
        if (search.torrentPending) parts.push('торренты ищутся');
        if (rows.length) parts.push('найдено ' + found);
      } else {
        parts.push(rows.length ? 'Найдено: ' + found : 'Ничего не найдено');
        if (search.checking()) parts.push('проверяем качество');
        if (search.interrupted) parts.push('Поиск прерван: «Параметры» → «Обновить поиск»');
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
      // OK on the strip keeps focus there until the new results bring the hero.
      var keep = last && strip[0].contains(last) ? last.homelabEpisode : 0;
      cancel(); currentScope = sync.scope(); resetList();
      stopPick(true); body.empty(); heroBox.empty().addClass('hide'); more = null; placeholder = null; placeholderState = ''; detail.addClass('hide'); updateSummary(); stripCenter = 0; drawStrip(keep);
      var options = {torrents: !recovery, fresh: fresh === true}, warmed = fresh === true ? null : adoptWarm(searchKey(movie, selection, options.torrents));
      if (warmed) { search = warmed; search.follow(changed); }
      else { search = new Search(Object.assign({}, movie), selection, changed, options); search.start(); }
      draw();
    }
    function visibleNode(node) { return node.offsetParent !== null; }
    // The hero and the list are one column: Up/Down walk it in order.
    function listNodes() { return Array.prototype.filter.call(heroBox[0].querySelectorAll('.selector'), visibleNode).concat(Array.prototype.filter.call(body[0].querySelectorAll('.selector'), visibleNode)); }
    function inList(node) { return heroBox[0].contains(node) || body[0].contains(node); }
    function move(dx, dy) {
      touch();
      var all = Array.prototype.filter.call(root[0].querySelectorAll('.selector'), visibleNode), list = listNodes();
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
        if (list.indexOf(node) >= 0 && (index >= 0 || body[0].contains(node) && !(py >= view.top && py <= view.bottom))) return;
        if (dx && (px - x) * dx <= 1 || dy && (py - y) * dy <= 1) return;
        // Left and Right stay in their row (the episode strip, the chips).
        if (dx && Math.abs(py - y) > Math.max(a.height, b.height) / 2) return;
        // Up/Down take the nearest row first (the chips before the strip), then the closest node in it.
        var along = dx ? Math.abs(px - x) : Math.abs(py - y), across = dx ? Math.abs(py - y) : Math.abs(px - x), score = dx ? along + across * 4 : along * 10 + across;
        if (score < distance) { distance = score; best = node; }
      });
      if (best) { L.Controller.collectionFocus(best, root, true); return true; }
      if (dy < 0) L.Controller.toggle('head');
      else if (dx < 0) L.Controller.toggle('menu');
      return false;
    }
    this.create = function () { updateSummary(); };
    this.render = function (js) { return js ? root[0] : root; };
    this.start = function () {
      if (!active()) return;
      if (sync.scope() !== currentScope) { cancel(); return L.Activity.backward(); }
      if (settingsOpen) { settingsOpen = false; pending = null; panel.addClass('hide'); root.removeClass('is-settings'); }
      stopPick(true);
      L.Controller.add('content', {link: self, invisible: true, toggle: function () { focus(false); }, up: function () { move(0, -1); }, down: function () { move(0, 1); }, left: function () { move(-1, 0); },
        // → walks the strip and the chips; on a card with several sources it chooses among them;
        // past the chips' end, and from anywhere else, it opens the parameters.
        right: function () { if (!(last && last !== summary[0] && (strip[0].contains(last) || filters[0].contains(last)) && move(1, 0)) && !startPick()) openSettings(); }, back: function () { cancel(); L.Activity.backward(); }});
      L.Controller.add(PICK, {link: self, invisible: true, toggle: focusPick, up: function () { stepPick(-1); }, down: function () { stepPick(1); },
        left: leavePick, right: function () {}, back: leavePick});
      L.Controller.add(SETTINGS, {link: self, invisible: true, toggle: focusSetting, up: function () { if (settingIndex > 0) { settingIndex--; focusSetting(); } },
        down: function () { if (settingIndex < settingRows.length - 1) { settingIndex++; focusSetting(); } }, left: function () { stepSetting(-1, true); }, right: function () { stepSetting(1); }, back: function () { closeSettings(); }});
      L.Controller.toggle('content');
      if (!started) { started = true; askSeasons(); restart(); }
      else draw();
    };
    this.pause = cancel;
    this.stop = function () {};
    var unsubscribe = sync.subscribe(function () { if (sync.scope() !== currentScope) { cancel(); if (active()) L.Activity.backward(); } });
    this.destroy = function () { dead = true; clearTimeout(voiceTimer); clearTimeout(stripTimer); cancel(); unsubscribe(); scroll.destroy(); root.remove(); };
  }
  // ── Entry points: the card button, Continue resume and playback recovery ──
  function addButton(movie, render, unsupported) {
    if (!movie || !render || render.find('.view--homelab-sources').length) return;
    var container = render.find('.buttons--container'); if (!container.length) return;
    var button = $('<div class="full-start__button selector view--homelab-sources">' + PLAY + '<span>Общий</span></div>');
    button.on('hover:enter', unsupported || function (_, context) {
      L.Activity.push({component: COMPONENT, title: 'Общий', movie: movie, season: context && context.season, page: 1});
    }); container.prepend(button);
  }
  // ── Prefetch: a title card the user stays on starts its «Общий» search, so the screen opens with results ──
  // Only while that card is the active screen: any other screen (Lampa's own torrents use the same parser)
  // cancels it, and the «Общий» screen adopts it when the episode and lanes match.
  var warm = null, warmOwner = null, warmTimer = 0, WARM_DELAY = 1500;
  function cancelWarm() { clearTimeout(warmTimer); warmOwner = null; if (warm) { warm.search.cancel(); warm = null; } }
  function adoptWarm(key) {
    var found = warm && warm.search.key === key && warm.search.alive() ? warm.search : null;
    if (found) { warm = null; warmOwner = null; clearTimeout(warmTimer); } else cancelWarm();
    return found;
  }
  function prefetch(card, owner) {
    cancelWarm();
    if (!card || !Number.isInteger(card.id) || card.id <= 0 || !owner) return;
    warmOwner = owner;
    warmTimer = setTimeout(function () {
      if (L.Activity.active() !== owner || L.Player.opened()) return;
      var movie = movieCard(card), selection = initialSelection({}, movie), search = new Search(Object.assign({}, movie), selection, function () {}, {torrents: true});
      warm = {search: search, owner: owner}; search.start();
    }, WARM_DELAY);
  }
  // A trailer played from the card is not a screen change; it stops the prefetch as well.
  if (L.Player && L.Player.listener) L.Player.listener.follow('start', cancelWarm);
  L.Listener.follow('activity', function (event) {
    if (!event || (event.type !== 'init' && event.type !== 'start') || event.component === COMPONENT) return;
    if (event.object !== warmOwner) cancelWarm();
  });
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
      position: Number.isFinite(snapshot.position) ? Math.max(0, snapshot.position) : 0, duration: Number.isFinite(snapshot.duration) ? snapshot.duration : 0, quality: qualityHeight(Object.keys(work.quality || {}).length === 1 ? Object.keys(work.quality)[0] : '') || pref.quality};
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
  // ── Styles, registration and the public API ──
  $('head').append($('<style></style>').text([
    '.homelab-common{position:relative;background:#1d1f20;height:100%;display:flex;flex-direction:column;padding:1.2em 2.4em .8em;box-sizing:border-box;overflow:hidden}',
    '.homelab-common-art{position:absolute;left:0;top:0;right:0;bottom:0;background:#1d1f20 center top no-repeat;background-size:cover;opacity:.5}',
    '.homelab-common-art:after{content:"";position:absolute;left:0;top:0;right:0;bottom:0;background:-webkit-linear-gradient(left,#1d1f20 0,rgba(29,31,32,.85) 40%,rgba(29,31,32,.4) 100%),-webkit-linear-gradient(bottom,#1d1f20 10%,rgba(29,31,32,0) 60%);background:linear-gradient(90deg,#1d1f20 0,rgba(29,31,32,.85) 40%,rgba(29,31,32,.4) 100%),linear-gradient(0deg,#1d1f20 10%,rgba(29,31,32,0) 60%)}',
    '.homelab-common>*{position:relative}.homelab-common>.homelab-common-art{position:absolute}',
    '.homelab-common-head{display:flex;align-items:flex-start;-webkit-transition:opacity .25s;transition:opacity .25s}',
    '.homelab-common-poster{width:4.6em;height:6.9em;border-radius:.3em;background-position:center;background-size:cover;margin-right:1.3em;flex-shrink:0}',
    '.homelab-common-info{flex:1;min-width:0}',
    '.homelab-common-title-row{display:flex;align-items:flex-start}',
    '.homelab-common-title{flex:1;min-width:0}',
    '.homelab-common-heading{font-size:2.2em;font-weight:600;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.homelab-common-facts{display:flex;align-items:center;margin-top:.35em;font-size:.92em;min-width:0}',
    '.homelab-common-facts>*{margin-right:.9em;flex-shrink:0}',
    '.homelab-common-year{opacity:.55}',
    '.homelab-common-status{flex:0 1 auto;max-width:45%;min-width:0;margin-left:1.5em;padding-top:.5em;display:flex;align-items:center;font-size:.88em;opacity:.65}',
    '.homelab-common-status.is-loading{opacity:.9}.homelab-common-status.has-errors .homelab-common-status-text{color:#dfc154}',
    '.homelab-common-status-text{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.homelab-common-spinner{display:none;width:.8em;height:.8em;margin-right:.5em;flex-shrink:0;border-radius:100%;border:.14em solid rgba(255,255,255,.2);border-top-color:#fff;-webkit-animation:homelab-common-spin .9s linear infinite;animation:homelab-common-spin .9s linear infinite}',
    '.homelab-common-status.is-loading .homelab-common-spinner{display:block}',
    '.homelab-common-bar{display:none;width:5em;height:.2em;margin-left:.8em;flex-shrink:0;border-radius:.2em;background:rgba(255,255,255,.12);overflow:hidden}',
    '.homelab-common-status.is-loading .homelab-common-bar{display:block}',
    '.homelab-common-bar-fill{height:100%;background:#fff;-webkit-transform-origin:0 50%;transform-origin:0 50%;-webkit-transform:scaleX(0);transform:scaleX(0);-webkit-transition:-webkit-transform .4s;transition:transform .4s}',
    '@-webkit-keyframes homelab-common-spin{to{-webkit-transform:rotate(360deg)}}@keyframes homelab-common-spin{to{transform:rotate(360deg)}}',
    '@-webkit-keyframes homelab-common-pulse{50%{opacity:.4}}@keyframes homelab-common-pulse{50%{opacity:.4}}',
    // Episode strip.
    '.homelab-common-eps{display:flex;align-items:center;margin-top:.8em;white-space:nowrap;overflow:hidden}',
    '.homelab-common-season{padding:.38em .8em;margin-right:.3em;border-radius:.55em;font-size:.9em;opacity:.7}',
    '.homelab-common-ep{position:relative;min-width:2.7em;padding:.38em .55em;margin-right:.4em;text-align:center;box-sizing:border-box;border-radius:.55em;background:rgba(0,0,0,.3);font-weight:600;font-size:.95em;color:rgba(255,255,255,.78)}',
    '.homelab-common-ep.is-watched{color:rgba(255,255,255,.4)}',
    '.homelab-common-ep.is-watched:after{content:"";position:absolute;left:.55em;right:.55em;bottom:.22em;height:.12em;border-radius:.1em;background:rgba(255,255,255,.35)}',
    '.homelab-common-ep.is-current{background:rgba(255,255,255,.2);color:#fff}',
    '.homelab-common-ep-bar{position:absolute;left:.55em;bottom:.22em;max-width:-webkit-calc(100% - 1.1em);max-width:calc(100% - 1.1em);height:.12em;border-radius:.1em;background:#fff}',
    '.homelab-common .homelab-common-ep.focus,.homelab-common .homelab-common-season.focus{outline:0;opacity:1;background:#fff;color:#000}.homelab-common-ep.focus:after,.homelab-common-ep.focus .homelab-common-ep-bar{background:#000}',
    '.homelab-common-eps-arrow{margin:0 .4em 0 .1em;opacity:.45}',
    '.homelab-common-eps-total{font-size:.88em;opacity:.45;margin-left:.3em}',
    // Filters.
    '.homelab-common-filters{display:flex;align-items:center;margin:.9em 0 .8em;-webkit-transition:opacity .25s;transition:opacity .25s}',
    '.homelab-common-filter{flex-shrink:0;padding:.4em 1.1em;margin-right:.5em;border-radius:1em;background:rgba(0,0,0,.3);white-space:nowrap}',
    '.homelab-common-filter-count{margin-left:.4em;opacity:.5}',
    '.homelab-common-filter.is-on{background:rgba(255,255,255,.2)}',
    '.homelab-common .homelab-common-filter.focus{outline:0;background:#fff;color:#000}',
    '.homelab-common-other-voices{flex-shrink:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
    '.homelab-common-summary{flex-shrink:1;min-width:0;max-width:40%;display:flex;align-items:center;margin-left:auto;padding:.4em .9em .4em 1em;border-radius:1em;background:rgba(0,0,0,.3);box-sizing:border-box}',
    '.homelab-common-summary-icon{flex-shrink:0;width:1.1em;height:1.1em;margin-right:.5em;opacity:.75;background:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23fff%27 stroke-width=%272%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M4 7h9M19 7h1M4 17h3M13 17h7%27/%3E%3Ccircle cx=%2716%27 cy=%277%27 r=%272.4%27/%3E%3Ccircle cx=%2710%27 cy=%2717%27 r=%272.4%27/%3E%3C/svg%3E") center/contain no-repeat}',
    '.homelab-common-summary-text{min-width:0;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.homelab-common-summary-go{flex-shrink:0;margin-left:.45em;font-size:1.35em;line-height:.7;opacity:.45}',
    '.homelab-common .homelab-common-summary.selector.focus{outline:0;background:#fff;color:#000;box-shadow:none}.homelab-common-summary.focus .homelab-common-summary-text,.homelab-common-summary.focus .homelab-common-summary-icon{opacity:1}.homelab-common-summary.focus .homelab-common-summary-go{opacity:.7}.homelab-common-summary.focus .homelab-common-summary-icon{background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%272%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M4 7h9M19 7h1M4 17h3M13 17h7%27/%3E%3Ccircle cx=%2716%27 cy=%277%27 r=%272.4%27/%3E%3Ccircle cx=%2710%27 cy=%2717%27 r=%272.4%27/%3E%3C/svg%3E")}',
    '.homelab-common-recovery{display:flex;align-items:center;flex-wrap:wrap;margin:.7em 0 0;line-height:1.3;font-size:.9em;color:#efe1bf}',
    '.homelab-common-recovery-voice{padding:.25em .8em;border-radius:1em;background:rgba(255,255,255,.12);color:#fff;font-weight:600;margin-right:1em}.homelab-common-recovery-voice.is-none{background:transparent;color:#efe1bf;padding-left:0}',
    '.homelab-common-recovery-note{font-size:.9em;opacity:.65}',
    '.homelab-common .selector.focus{outline:.16em solid #fff;outline-offset:.12em;background:rgba(255,255,255,.16)}',
    '.homelab-common-main{flex:1;min-height:0;display:flex;-webkit-transition:opacity .25s;transition:opacity .25s}',
    '.homelab-common.is-settings .homelab-common-main,.homelab-common.is-settings .homelab-common-head,.homelab-common.is-settings .homelab-common-filters,.homelab-common.is-settings .homelab-common-herobox{opacity:.35}',
    '.homelab-common-main>.scroll{flex:1 1 0;min-width:0;height:100%}',
    // The screen takes Lampa's layer height (window minus head and the phone's bottom bar); the list fills what the
    // head leaves instead of its own window-based height, so its end stays above the bottom bar and it scrolls.
    '.homelab-common-main>.scroll>.scroll__content{padding-top:.4em}',
    '.homelab-common-list{padding:.4em .7em .4em .4em}',
    // List rows: Lampa torrent-item tiles, one line each.
    '.homelab-common-result{position:relative;display:flex;align-items:center;padding:.75em 1em;border-radius:.3em;margin-bottom:.6em;box-sizing:border-box;background:rgba(0,0,0,.3)}',
    '.homelab-common-result.is-native{opacity:.85}.homelab-common-result.is-unavailable{opacity:.45}',
    '.homelab-common .homelab-common-result.focus{outline:0;opacity:1;box-shadow:0 0 0 .3em #fff}',
    '.homelab-common-text{min-width:0;flex:1;display:flex;flex-wrap:wrap;align-items:baseline}',
    '.homelab-common-pick,.homelab-common-what,.homelab-common-match{-webkit-flex-basis:100%;flex-basis:100%}',
    '.homelab-common-pick{display:none;font-size:.85em;color:#d8c39a;margin-bottom:.25em}',
    '.homelab-common-what{display:none;font-size:1.45em;font-weight:600;margin-bottom:.1em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.homelab-common-name{flex:1 1 0;min-width:38%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.homelab-common-voice{font-size:1.15em}',
    '.homelab-common-tag{display:none;margin-left:.6em;font-size:.62em;font-weight:800;letter-spacing:.1em;text-transform:uppercase;opacity:.7;vertical-align:.2em}',
    '.homelab-common-result.is-mine .homelab-common-tag{display:inline}',
    '.homelab-common-match{font-size:.82em;color:#d8c39a;margin-top:.2em}',
    '.homelab-common-line{flex:0 1 auto;max-width:55%;margin-left:1em;font-size:.82em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}',
    '.homelab-common-details{opacity:.55}',
    '.homelab-common-badge{display:inline-block;margin-left:.8em;opacity:.8}',
    '.homelab-common-badge.is-seeds{color:#a5d15f;opacity:1}.homelab-common-badge.is-dead{color:#e17171;opacity:1}',
    '.homelab-common-badge.is-subs{opacity:.7}',
    '.homelab-common-badge.is-subs:before{content:"CC";display:inline-block;font-size:.72em;font-weight:800;line-height:1.2;border:.14em solid currentColor;border-radius:.25em;padding:0 .25em;margin-right:.35em;vertical-align:.1em}',
    '.homelab-common-quality{flex-shrink:0;display:flex;align-items:center;margin-left:1em}',
    // Quality: Lampa's outlined age-badge look, one colour for every height.
    '.homelab-common-q{display:inline-block;font-size:.8em;padding:.2em .5em;border-radius:.2em;min-width:3em;text-align:center;white-space:nowrap;box-sizing:border-box;border:1px solid rgba(255,255,255,.6)}',
    '.homelab-common-q.is-none{border:0;opacity:.4}.homelab-common-q.is-off{border:0;color:#e17171;font-size:.74em}',
    '.homelab-common-result.is-hero .homelab-common-q{font-size:1.05em;padding:.3em .7em}',
    '.homelab-common-q-note{width:1.2em;margin-left:.5em;font-size:.8em;white-space:nowrap;overflow:hidden}',
    '.homelab-common-q-note>span:not(.homelab-common-check){display:none}',
    '.homelab-common-q-note.is-measured{color:#a5d15f}',
    '.homelab-common-check{display:inline-block;width:1.1em;height:1.1em;vertical-align:-.2em;margin-right:.15em}.homelab-common-check svg{display:block;width:100%;height:100%}',
    '.homelab-common-play,.homelab-common-progress{display:none}',
    // The hero: Lampa's popular torrent tile; focus is the same white frame as every row.
    '.homelab-common-herobox{margin-bottom:.7em;-webkit-transition:opacity .25s;transition:opacity .25s}',
    '.homelab-common-result.is-hero{padding:.85em 1.3em .85em .95em;margin:0;overflow:hidden;background:rgba(255,255,255,.12)}',
    '.homelab-common-result.is-hero:before{display:none}',
    '.homelab-common-result.is-hero .homelab-common-play{display:block;position:relative;width:3.2em;height:3.2em;margin-right:1.1em;flex-shrink:0;border-radius:50%;background:rgba(255,255,255,.14)}',
    '.homelab-common-play:after{content:"";position:absolute;left:50%;top:50%;margin:-.55em 0 0 -.3em;border-style:solid;border-width:.55em 0 .55em .9em;border-color:transparent transparent transparent #fff}',
    '.homelab-common-result.is-hero .homelab-common-pick{display:block}.homelab-common-result.is-hero .homelab-common-pick.hide{display:none}',
    '.homelab-common-result.is-hero .homelab-common-what{display:block}.homelab-common-result.is-hero .homelab-common-what.hide{display:none}',
    '.homelab-common-result.is-hero .homelab-common-what:not(.hide)+.homelab-common-name .homelab-common-voice{font-size:.95em;opacity:.75}',
    '.homelab-common-result.is-hero .homelab-common-voice{font-size:1.45em;font-weight:600}',
    '.homelab-common-result.is-hero .homelab-common-tag{display:none}',
    '.homelab-common-result.is-hero .homelab-common-line{-webkit-flex-basis:100%;flex-basis:100%;max-width:none;margin:.15em 0 0;text-align:left}',
    '.homelab-common-result.is-hero .homelab-common-quality{-webkit-flex-direction:column;flex-direction:column;align-items:flex-end}',
    '.homelab-common-result.is-hero .homelab-common-q-note{width:auto;margin:.45em 0 0;font-size:.75em;opacity:.6}.homelab-common-result.is-hero .homelab-common-q-note.is-measured{opacity:1}',
    '.homelab-common-result.is-hero .homelab-common-q-note>span:not(.homelab-common-check){display:inline}',
    '.homelab-common-result.is-hero .homelab-common-progress{display:block;position:absolute;left:0;right:0;bottom:0;height:.2em;background:rgba(255,255,255,.12)}.homelab-common-result.is-hero .homelab-common-progress.hide{display:none}',
    '.homelab-common-progress-fill{height:100%;background:#fff}',
    '.homelab-common .homelab-common-result.is-hero.focus{box-shadow:0 0 0 .3em #fff}',
    '.homelab-common-result.is-hero.focus .homelab-common-play{background:#fff}.homelab-common-result.is-hero.focus .homelab-common-play:after{border-left-color:#000}',
    // Headings and folds.
    '.homelab-common-label{margin:.7em 0 .5em;padding:0 1em;opacity:.5}',
    '.homelab-common-label:first-child{margin-top:.2em}',
    '.homelab-common-section{margin:.5em 0 .6em;padding:.75em 1em;border-radius:.3em;background:rgba(0,0,0,.3);opacity:.7}',
    '.homelab-common .homelab-common-section.focus{outline:0;opacity:1;background:#fff;color:#000}',
    '.homelab-common-more{padding:.7em;text-align:center;border-radius:.7em;background:rgba(255,255,255,.04)}',
    '.homelab-common-skeleton{height:2.6em;margin-bottom:.3em;border-radius:.7em;background:rgba(255,255,255,.05);-webkit-animation:homelab-common-pulse 1.4s ease-in-out infinite;animation:homelab-common-pulse 1.4s ease-in-out infinite}',
    '.homelab-common-empty{padding:3em 1em;text-align:center}.homelab-common-empty-title{font-size:1.5em;font-weight:600;margin-bottom:.5em}.homelab-common-empty-hint{opacity:.6}',
    '.homelab-common-detail{flex:0 0 30%;min-width:0;margin-left:1.6em;align-self:flex-start;max-height:100%;box-sizing:border-box;display:flex;flex-direction:column;padding:1.1em 1.2em;border-radius:1em;background:#262829;overflow:hidden}',
    '.homelab-common-detail-top{display:flex;align-items:center;margin-bottom:1em}',
    '.homelab-common-ring{min-width:3.4em;height:2.1em;padding:0 .7em;flex-shrink:0;margin-right:.9em;border-radius:.2em;border:1px solid #fff;box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-size:.95em;white-space:nowrap}',
    '.homelab-common-ring.is-off{border-color:#e17171;color:#e17171;font-size:.6em}',
    '.homelab-common-detail-name{min-width:0}',
    '.homelab-common-detail-voice{font-size:1.3em;font-weight:700;letter-spacing:-.01em;line-height:1.2;max-height:2.4em;overflow:hidden}',
    '.homelab-common-detail-kind{font-size:.85em;opacity:.55;margin-top:.25em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.homelab-common-verdict{font-size:.88em;padding:.6em .9em;border-radius:.7em;margin-bottom:.9em;background:rgba(255,255,255,.06);color:rgba(255,255,255,.7)}',
    '.homelab-common-verdict.is-ok{background:rgba(165,209,95,.12);color:#a5d15f}.homelab-common-verdict.is-warn{background:rgba(223,193,84,.12);color:#dfc154}.homelab-common-verdict.is-bad{background:rgba(225,113,113,.12);color:#e17171}',
    '.homelab-common-detail-subs{font-size:.86em;opacity:.7;margin:-.2em 0 .9em}',
    '.homelab-common-detail-label{font-size:.9em;opacity:.45;margin-bottom:.6em}',
    '.homelab-common-sources{min-height:0;overflow:hidden}',
    '.homelab-common-source{display:flex;flex-wrap:wrap;align-items:baseline;font-size:.86em;margin-bottom:.65em}',
    '.homelab-common-source-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.homelab-common-source.is-best .homelab-common-source-name{font-weight:700}',
    '.homelab-common-source.is-best .homelab-common-source-name:after{content:"\\041E\\041A";margin-left:.5em;padding:0 .35em;border-radius:.25em;font-size:.72em;border:1px solid #fff;vertical-align:.1em}',
    '.homelab-common-source-value{flex-shrink:0;margin-left:.6em;font-size:.88em;opacity:.6;white-space:nowrap}',
    '.homelab-common-source-value.is-ok{opacity:1;color:#a5d15f}.homelab-common-source-value.is-warn{opacity:1;color:#dfc154}.homelab-common-source-value.is-bad{opacity:1;color:#e17171}',
    '.homelab-common-meter{display:block;width:100%;height:.18em;margin-top:.35em;border-radius:.2em;background:rgba(255,255,255,.08);overflow:hidden}',
    '.homelab-common-meter-fill{display:block;height:100%;border-radius:.2em;background:#fff}',
    // Choosing a source with →: the panel's lines become a focusable list.
    '.homelab-common-detail.is-picking .homelab-common-sources{margin:0 -.6em}.homelab-common-detail.is-picking .homelab-common-source{padding:.45em .6em;margin-bottom:.2em;border-radius:.3em}',
    '.homelab-common .homelab-common-detail .homelab-common-source.focus{outline:0;background:#fff;color:#000}',
    '.homelab-common-source.focus .homelab-common-source-value{color:#000;opacity:.7}.homelab-common-source.focus .homelab-common-meter{background:rgba(0,0,0,.12)}.homelab-common-source.focus .homelab-common-meter-fill{background:#000}.homelab-common-source.is-best.focus .homelab-common-source-name:after{border-color:#000}',
    '.homelab-common-source-more{font-size:.78em;opacity:.45}',
    '.homelab-common-keys{margin-top:1em;font-size:.76em;opacity:.45}',
    '.homelab-common-hint{display:none;font-size:.85em;opacity:.45;padding-top:.6em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.homelab-common-settings{position:absolute;top:0;right:0;bottom:0;width:26em;max-width:92%;z-index:5;box-sizing:border-box;display:flex;flex-direction:column;padding:2em 1.6em 1.4em;background:rgba(16,19,22,.98);border-left:.08em solid rgba(255,255,255,.08);box-shadow:-2em 0 4em rgba(0,0,0,.5)}',
    '.homelab-common-settings-title{font-size:1.5em;font-weight:700;margin-bottom:1em}',
    '.homelab-common-settings-list{flex:1;min-height:0;overflow:hidden}',
    // Phones scroll natively and have no remote: the parameters list scrolls, values are tapped, the side panel
    // (its list is picked with →) and the key hints are left out.
    'body.true--mobile .homelab-common-settings-list{overflow-y:auto;-webkit-overflow-scrolling:touch}',
    'body.true--mobile .homelab-common-detail,body.true--mobile .homelab-common-hint,body.true--mobile .homelab-common-keys,body.true--mobile .homelab-common-settings-hint{display:none!important}',
    'body.true--mobile .homelab-common-eps-arrow{padding:.4em .7em;cursor:pointer}',
    '.homelab-common-setting{padding:.65em .8em .4em;border-radius:.9em;margin-bottom:.4em;border:.12em solid transparent}',
    '.homelab-common-setting-label{font-size:.7em;font-weight:600;letter-spacing:.14em;text-transform:uppercase;opacity:.5;margin-bottom:.45em}',
    '.homelab-common-setting-values{display:flex;flex-wrap:wrap}',
    '.homelab-common-setting-value,.homelab-common-setting-more{padding:.35em .85em;border-radius:2em;margin:0 .35em .35em 0;font-size:.9em;background:rgba(255,255,255,.07);opacity:.7}',
    '.homelab-common-setting-more{background:none}',
    '.homelab-common-setting-value.selected{background:rgba(255,255,255,.22);opacity:1;font-weight:600}',
    '.homelab-common .homelab-common-setting.focus{outline:0;border-color:rgba(255,255,255,.55);background:rgba(255,255,255,.05)}',
    '.homelab-common-setting.focus .homelab-common-setting-value.selected{background:#fff;color:#000}',
    '.homelab-common-setting.is-button{text-align:center;padding:.8em;margin-top:.4em;background:rgba(255,255,255,.07)}',
    '.homelab-common .homelab-common-setting.is-button.focus{background:#fff;color:#000}',
    '.homelab-common-settings-hint{font-size:.78em;opacity:.4;margin-top:1em}',
    '.homelab-common .hide{display:none}',
    '@media(max-width:900px){.homelab-common-detail{display:none}.homelab-common-hint{display:block}.homelab-common-summary{max-width:48%}}',
    '@media(max-width:600px){.homelab-common{padding:1em}.homelab-common-poster,.homelab-common-year,.homelab-common-status{display:none}.homelab-common-heading{font-size:1.6em}.homelab-common-result{padding:.8em .9em .8em 1.1em}.homelab-common-q{font-size:.9em}.homelab-common-summary-text{display:none}.homelab-common-settings{width:100%;max-width:100%}.homelab-common-hint{display:none}}'
  ].join('')));
  L.Component.add(COMPONENT, Common);
  L.Listener.follow('full', function (event) {
    if (event.type !== 'complite') return;
    addButton(event.data.movie, event.object.activity.render());
    prefetch(event.data.movie, event.object);
  });
  var active = L.Activity.active(); if (active && active.component === 'full' && active.activity) addButton(active.card, active.activity.render());
  window.HomelabSources = {Search: Search, quality: qualityHeight, voiceMatch: voiceMatch, preferences: preferences, describeRelease: describeRelease, canonVoice: canonVoice, releaseVoices: releaseVoices, compareRows: compareRows, groupRows: groupRows, resume: resumeSource, recover: recover};
})();
