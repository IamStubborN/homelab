    // ── The audio menu: labels, drawing, preparing an external voice ──
    // Lampa puts notices into HTML unescaped.
    function notify(text) {
      if (Lampa.Noty) Lampa.Noty.show(plain(text));
    }

    // How tracks read in Lampa's menus. `label` stays the track's source
    // name: preferences, logs and other plugins match by it. Each menu item
    // is drawn from it instead: a human title, then small details.
    var LANGUAGE_NAMES = {
      ru: 'Русский', uk: 'Украинский', en: 'Английский', ja: 'Японский', de: 'Немецкий', fr: 'Французский',
      es: 'Испанский', it: 'Итальянский', pt: 'Португальский', ko: 'Корейский', zh: 'Китайский', pl: 'Польский'
    };
    // Display only: identity() keeps its own aliases, or stored choices would stop matching.
    var DISPLAY_LANGUAGES = {kor: 'ko', chi: 'zh', zho: 'zh', pol: 'pl', russian: 'ru', english: 'en', japanese: 'ja'};
    // Russian first, then untagged (in practice a Russian voice-over), then the rest.
    var LANGUAGE_ORDER = {ru: 0, '': 1, uk: 2, en: 3};
    var CHANNEL_NAMES = {1: 'моно', 2: 'стерео', 3: '2.1', 6: '5.1', 7: '6.1', 8: '7.1'};
    var CODEC_NAMES = {aac: 'AAC', ac3: 'AC3', eac3: 'E-AC3', dts: 'DTS', truehd: 'TrueHD', flac: 'FLAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', alac: 'ALAC'};
    var VOICE_KINDS = [
      [words('dub|dubbed|dubbing|дубляж|дублированн[а-яё]*|дубл[а-яё]*'), 'Дубляж'],
      [words('mvo|многоголос[а-яё]*'), 'Многоголосая'],
      [words('dvo|двухголос[а-яё]*'), 'Двухголосая'],
      [words('avo|авторск[а-яё]*'), 'Авторская'],
      [words('vo|одноголос[а-яё]*'), 'Одноголосая'],
      [words('original|orig|оригинал[а-яё]*'), 'Оригинал']
    ];
    var VOICE_NOISE = words('rus|ru|russian|русск[а-яё]*|eng|en|english|англ[а-яё]*|jpn|ja|jap|japanese|японск[а-яё]*|ukr|uk|укр[а-яё]*|' +
      'audio|sound|sounds|track|voice|voices|звук|дорожка|озвучк[а-яё]*|озвучани[а-яё]*|перевод|закадров[а-яё]*|' +
      'профессиональн[а-яё]*|любительск[а-яё]*|ext|external|внешн[а-яё]*|stereo|mono|dts-hd|e-ac3|aac|ac3|eac3|dts|truehd|' +
      'flac|opus|mp3|\\d\\.\\d|\\d+ch|\\d{3,4}p|web-?dl|webrip|bdrip|hdtv|x26[45]|hevc|10bit|s\\d{1,2}e\\d{1,3}|e\\d{1,3}');
    var MEDIA_EXTENSION = /\.(?:mka|mkv|mp4|m4a|aac|ac3|eac3|dts|flac|mp3|ogg|opus|wav|ass|ssa|srt)$/i;

    function displayLanguage(value) {
      var code = languageCode(value);
      return code === 'und' ? '' : DISPLAY_LANGUAGES[code] || code;
    }

    function languageName(value) {
      var code = displayLanguage(value);
      return LANGUAGE_NAMES[code] || (/^[a-z]{2,3}$/.test(code) ? code.toUpperCase() : '');
    }

    function tidy(text) {
      return text.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ').replace(/[\[\]{}]/g, ' ').replace(/\s+/g, ' ')
        .replace(/^[\s\-_.,:;|/+&]+|[\s\-_.,:;|/+&]+$/g, '');
    }

    // A file name ("LostFilm_Rus.mka") reads as words.
    function cleanName(text) {
      text = String(text || '').replace(/["'«»″’]/g, '').trim();
      var file = MEDIA_EXTENSION.test(text);
      text = text.replace(MEDIA_EXTENSION, '');
      if (file || /_/.test(text) || !/\s/.test(text) && (text.match(/\./g) || []).length > 1) text = text.replace(/[._]+/g, ' ');
      return text;
    }

    function voiceKind(text) {
      var found = '';
      VOICE_KINDS.some(function (kind) { return String(text).match(kind[0]) ? (found = kind[1], true) : false; });
      return found;
    }

    // "Sound / RUS / AniLibria" or "MVO | LostFilm" -> the studio.
    function voiceStudio(text) {
      var parts = cleanName(text).split(/\s+\/\s+|\s*\|\s*/).map(function (part) {
        VOICE_KINDS.forEach(function (kind) { part = part.replace(kind[0], '$1'); });
        part = tidy(part.replace(VOICE_NOISE, '$1'));
        return /^[\d\s.]*$/.test(part) ? '' : part;
      }).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '';
    }

    function audioTitle(track) {
      var kind = voiceKind((track.gstTitle || '') + ' / ' + (track.location || ''));
      var studio = voiceStudio(track.gstTitle) || voiceStudio(track.location);
      if (studio && kind) return kind + ' — ' + studio;
      return studio || kind || languageName(track.language) ||
        (track.external ? 'Внешняя озвучка' : 'Дорожка ' + ((track.index || 0) + 1));
    }

    // The short name notices use: "LostFilm", not "Дубляж — LostFilm".
    function audioName(track) {
      return voiceStudio(track.gstTitle) || voiceStudio(track.location) || track.homelabTitle || audioTitle(track);
    }

    function audioStatus(state, track) {
      if (state.preparing && state.preparing.track === track) {
        var seconds = Math.floor((Date.now() - state.preparing.started) / 1000);
        return seconds >= 2 ? 'готовится… ' + seconds + ' с' : 'готовится…';
      }
      if (track.unsupported) return 'не подходит к этому видео';
      if (track.failed || track.prepareFailed) return 'не загрузилась — выберите ещё раз';
      return '';
    }

    function audioDetails(state, track) {
      var parts = [];
      var status = audioStatus(state, track);
      if (status) parts.push(status);
      if (matchingTrack(state.tracks || [], state.preferences.audio) === track) parts.push('★ для сериала');
      var language = languageName(track.language);
      if (language && (track.homelabTitle || audioTitle(track)).indexOf(language) !== 0) parts.push(language);
      var channels = CHANNEL_NAMES[track.extra && track.extra.channels];
      if (channels) parts.push(channels);
      var codec = String(track.sourceCodec || '').toLowerCase();
      codec = codec ? CODEC_NAMES[codec] || codec.toUpperCase() : track.aac ? 'AAC' : '';
      if (codec) parts.push(codec);
      parts.push(track.external ? 'внешняя' : 'встроенная');
      return parts.join(' · ');
    }

    // Menu hooks and drawn nodes stay out of anything that copies or saves a track.
    function hidden(target, name, value) {
      Object.defineProperty(target, name, {value: value, writable: true, configurable: true, enumerable: false});
    }

    // Lampa's Select draws an item from its template, then calls onDraw.
    function paintItem(node, title, details) {
      if (!node || !node.find) return;
      node.find('.selectbox-item__title').text(title);
      var line = node.find('.selectbox-item__subtitle');
      if (!line.length && details && window.jQuery) {
        line = window.jQuery('<div class="selectbox-item__subtitle"></div>');
        node.append(line);
      }
      if (line.length) line.text(details);
    }

    function releaseItem(item) {
      delete item.onDraw;
      delete item.homelabItem;
    }

    // Lampa calls onDraw(node, element). The state is looked up then: a list
    // the panel kept from an earlier play draws nothing of that play.
    function drawTrack(node, track) {
      hidden(track, 'homelabItem', node);
      var state = active && (active.tracks || []).indexOf(track) !== -1 ? active : null;
      if (!state) return;
      paintTrack(state, track);
      tickPreparation(state);
    }

    function drawSubtitle(node, item) {
      hidden(item, 'homelabItem', node);
      var state = active && (active.subtitleList || []).indexOf(item) !== -1 ? active : null;
      if (state) paintSubtitle(state, item);
    }

    // Whether a drawn item is still on screen; without a DOM to ask, it is.
    function onScreen(node) {
      var element = node && node[0];
      var root = window.document && window.document.documentElement;
      return !element || !root || !root.contains || root.contains(element);
    }

    // While the menu shows a voice being prepared, its seconds count up.
    // The tick stops when the menu closes, the preparation ends or playback does.
    function tickPreparation(state) {
      clearTimeout(state.prepareTick);
      state.prepareTick = null;
      var preparing = state.preparing;
      if (!preparing || active !== state || !preparing.track.homelabItem || !onScreen(preparing.track.homelabItem)) return;
      state.prepareTick = setTimeout(function () {
        state.prepareTick = null;
        if (state.preparing !== preparing || active !== state) return;
        paintTrack(state, preparing.track);
        tickPreparation(state);
      }, 1000);
    }

    function paintTrack(state, track) {
      if (track.homelabItem) paintItem(track.homelabItem, track.homelabTitle || audioTitle(track), audioDetails(state, track));
    }

    // An open menu follows a preparation without being redrawn.
    function repaintTracks(state) {
      (state.tracks || []).forEach(function (track) { paintTrack(state, track); });
    }

    // The menu: the remembered voice first, then by language, else in file
    // order. state.tracks keeps file order for the logic; Lampa keeps this
    // array, so it is reordered in place.
    function arrangeMenu(state) {
      var seen = {};
      state.tracks.forEach(function (track) {
        var title = audioTitle(track);
        seen[title] = (seen[title] || 0) + 1;
        track.homelabTitle = seen[title] > 1 ? title + ' (' + seen[title] + ')' : title;
      });
      var remembered = matchingTrack(state.tracks, state.preferences.audio);
      var order = state.tracks.map(function (track, at) {
        var language = LANGUAGE_ORDER[displayLanguage(track.language)];
        return {track: track, at: at, rank: (track === remembered ? 0 : 10) + (language === undefined ? 4 : language)};
      }).sort(function (a, b) { return a.rank - b.rank || a.at - b.at; }).map(function (entry) { return entry.track; });
      if (!state.menu) state.menu = [];
      state.menu.splice.apply(state.menu, [0, state.menu.length].concat(order));
      return state.menu;
    }

    // Lampa's panel marks the chosen item and switches it on through
    // `enabled`, like hls.js tracks; an item's own onSelect would replace
    // that handler and its focus return. Labels are ours, not Lampa's translations.
    function offerTrack(state, track) {
      track.ignore_translate = true;
      hidden(track, 'onDraw', drawTrack);
      var descriptor = Object.getOwnPropertyDescriptor(track, 'enabled');
      if (descriptor && descriptor.set && descriptor.set.homelabState === state) return;
      function choose(value) {
        if (!value) return;
        // The panel returns focus after this setter: an error must not skip that.
        try { selectTrack(state, track); } catch (error) {
          console.warn('Homelab GST audio:', error && error.message);
          report('audio-switch-failed', {track: track.label, reason: error && error.message}, state.work);
        }
      }
      choose.homelabState = state;
      Object.defineProperty(track, 'enabled', {
        configurable: true, enumerable: false,
        get: function () { return Boolean(track.selected); },
        set: choose
      });
    }

    function markSelected(state) {
      var url = masterUrl(state.work);
      var current = url && selectedTrack(state, url);
      (state.tracks || []).forEach(function (item) { item.selected = item === current; });
    }

    function cancelPreparation(state) {
      if (!state.preparing) return;
      state.preparing.abort.abort();
      clearTimeout(state.preparing.timer);
      var track = state.preparing.track;
      state.preparing = null;
      clearTimeout(state.prepareTick);
      state.prepareTick = null;
      paintTrack(state, track);
    }

    // Keep the current audio playing until the sidecar has the rendition's
    // playlist, then switch to it.
    function prepareExternal(state, track, automatic) {
      if (state.preparing && state.preparing.track === track) return;
      cancelPreparation(state);
      var preparing = state.preparing = {track: track, abort: new AbortController(), timer: null, started: Date.now(), deadline: Date.now() + 120000};
      track.prepareFailed = false;
      if (!automatic) notify('Готовлю озвучку «' + audioName(track) + '»…');
      function attempt() {
        if (state.preparing !== preparing) return;
        paintTrack(state, track);
        window.fetch(new URL(externalUrl(track), window.location.href).href, {signal: preparing.abort.signal, cache: 'no-store'}).then(function (response) {
          if (state.preparing !== preparing) return;
          if (response.ok) {
            state.preparing = null;
            clearTimeout(state.prepareTick);
            track.ready = true;
            paintTrack(state, track);
            if (automatic && Date.now() >= state.autoUntil + AUTO_PREPARE_MS - AUTO_APPLY_MS) return lateTrack(state, track);
            return selectTrack(state, track, true);
          }
          if ((response.status === 503 || response.status === 429) && Date.now() < preparing.deadline) {
            preparing.timer = setTimeout(attempt, response.status === 429 ? 10000 : 2000);
            return;
          }
          throw new Error('HTTP ' + response.status);
        }).catch(function (error) {
          if (error.name === 'AbortError' || state.preparing !== preparing) return;
          state.preparing = null;
          clearTimeout(state.prepareTick);
          track.prepareFailed = true;
          console.warn('Homelab external audio:', error.message);
          report('audio-external-failed', {track: track.label, reason: error.message}, state.work);
          // The panel marked the chosen item; the previous track still plays.
          markSelected(state);
          paintTrack(state, track);
          notify('Не удалось подготовить озвучку «' + audioName(track) + '»');
        });
      }
      attempt();
    }

    function seriesPlayback(work) {
      var list = Lampa.PlayerPlaylist && typeof Lampa.PlayerPlaylist.get === 'function' ? Lampa.PlayerPlaylist.get() : work.playlist;
      return Array.isArray(list) && list.length > 1;
    }

    function embeddedFallback(work) {
      var state = active;
      var url = state && state.work === work && work.homelab_external_audio && masterUrl(work);
      var carrier = url && carrierTrack(state, url);
      return carrier && state.tracks.indexOf(carrier) !== -1 ? carrier : null;
    }

    function audioRenditionError(data) {
      return Boolean(data.frag && data.frag.type === 'audio') || data.parent === 'audio' || /^audioTrack/.test(data.details || '');
    }

    function abandonExternal(work, reason) {
      var carrier = embeddedFallback(work);
      if (!carrier) return;
      var failed = selectedTrack(active, masterUrl(work));
      var layout = reason === 'unsupported fragment layout';
      if (failed) {
        // A layout never changes; a failed rendition is prepared again when chosen.
        if (layout) failed.unsupported = true;
        else { failed.ready = false; failed.failed = true; }
      }
      console.warn('Homelab external audio:', reason);
      report('audio-external-fallback', {track: failed && failed.label, to: carrier.label, reason: reason}, work);
      // Once per voice and play: a voice failing again stays quiet.
      var state = active;
      var key = (failed ? failed.key : '') + (layout ? ':layout' : '');
      state.fallbackNotices = state.fallbackNotices || {};
      if (!state.fallbackNotices[key]) {
        state.fallbackNotices[key] = true;
        var name = failed ? 'Озвучка «' + audioName(failed) + '»' : 'Внешняя озвучка';
        notify(name + (layout ? ' не подходит к этому видео' : ' недоступна') + ' — включена встроенная');
      }
      selectTrack(state, carrier, true);
      repaintTracks(state);
    }

    function selectedTrack(state, url) {
      var external = state.work.homelab_external_audio;
      var index = Number(url.searchParams.get('audio') || 0);
      return (state.tracks || []).filter(function (track) {
        return external ? track.external && track.key === external.key : !track.external && track.index === index;
      })[0] || null;
    }

    function carrierTrack(state, url) {
      var index = Number(url.searchParams.get('audio') || 0);
      var embedded = (state.tracks || []).filter(function (track) { return !track.external; });
      var current = embedded.filter(function (track) { return track.index === index; })[0];
      if (current && current.aac) return current;
      return embedded.filter(function (track) { return track.aac; })[0] || current || {index: index};
    }

