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
