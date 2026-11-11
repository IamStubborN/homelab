    // ── Online sources' subtitles, drawn like a torrent's ──
    // Lampac passes a provider's WebVTT/SRT files in work.subtitles, which Lampa
    // would show as plain text, and a provider host may refuse the browser
    // altogether. The sidecar reads and converts them; JASSUB draws them in the
    // same style, menu and per-title choice as a torrent's subtitles. When the
    // drawing fails, Lampa gets its files back and shows them as text.
    var ONLINE_LANGUAGES = [[/рус|russian|\bru\b|\brus\b/i, 'ru'], [/англ|english|\beng?\b/i, 'en'], [/укр|ukrain|\bukr?\b/i, 'uk'], [/япон|japan|\bjpn?\b/i, 'ja']];
    var CONVERTED_MARK = /^; homelab: converted from plain text$/m;

    function onlineSubtitleList(list) {
      return (Array.isArray(list) ? list : []).filter(function (sub) {
        if (!sub || typeof sub.url !== 'string' || !sub.url || /\.(?:idx|sub|sup)(?:[?#]|$)/i.test(sub.url)) return false;
        try { return /^https?:$/.test(new URL(sub.url, window.location.href).protocol); } catch (error) { return false; }
      });
    }

    // At 'start', which Lampa sends for its own player only, before it builds
    // its list at 'ready'. Torrent works keep theirs: those are TorrServer files.
    function takeOnlineSubtitles(work) {
      if (!work || work.iptv || work.torrent_hash || work.homelab_torrent_hash || masterUrl(work) || work.homelab_online_subtitles) return;
      if (!assSupported() || typeof window.fetch !== 'function' || typeof AbortController === 'undefined') return;
      var list = onlineSubtitleList(work.subtitles);
      if (!list.length) return;
      Object.defineProperty(work, 'homelab_online_subtitles', {configurable: true, writable: true, enumerable: false, value: work.subtitles.slice()});
      delete work.subtitles;
    }

    function onlineLanguage(text) {
      for (var i = 0; i < ONLINE_LANGUAGES.length; i++) if (ONLINE_LANGUAGES[i][0].test(text)) return ONLINE_LANGUAGES[i][1];
      return '';
    }

    function onlineItems(state, work) {
      return numberLabels(onlineSubtitleList(work.homelab_online_subtitles).map(function (sub, number) {
        var label = plain(String(sub.label || sub.title || '')).replace(/\s*[-–]\s*\d+\s*$/, '').trim();
        var language = languageCode(sub.language || onlineLanguage(label));
        // "Рус. форсированные", "(Russian) Надписи": the language goes to its own field.
        var title = label.replace(/форсированн[а-яё]*|форсован[а-яіїє]*/gi, 'надписи')
          .replace(/(^|[^0-9a-zа-яё])(рус|англ|укр|яп|eng|ukr|rus)\.?(?=$|[^0-9a-zа-яё])/gi, '$1').replace(/\s+/g, ' ').trim();
        var signs = signsTitle(title);
        var url = new URL('/homelab-media/online/subtitle', window.location.href);
        url.searchParams.set('url', new URL(sub.url, window.location.href).href);
        return defineMode(state, {
          index: 2000 + number, external: true, language: language,
          label: subtitleLabel(title, language, false, signs), homelabLabel: subtitleLabel(title, language, false, signs),
          // Whether the file was plain text is known once it arrives.
          homelabAss: {url: url.href, fonts: [], signs: false, text: true, online: true, source: sub}, homelabSigns: signs,
          homelabSource: {title: title, language: language, external: true, online: true}
        });
      }));
    }

    // A subtitled voice ("Субтитры", "Crunchyroll.Subtitles", the original) plays
    // a language the viewer may not know: its full Russian track starts with it.
    function subtitledVoice(work) {
      var online = work.homelab_online || {};
      return /субтитр|subtitle|оригинал|original/i.test([online.voice, online.text, work.voice_name, work.translate].join(' '));
    }

    function onlinePreferenceKey(work) {
      var card = work.card || {};
      if (!card.id) return '';
      return 'online:' + (card.name || card.original_name ? 'tv_' : 'movie_') + card.id;
    }

    function installOnline(work) {
      if (!work.homelab_online_subtitles) return;
      var state = active = {
        work: work, online: true, abort: new AbortController(), externalAbort: new AbortController(),
        embeddedProxies: {}, embeddedBroken: {}, autoUntil: Infinity, preferenceKey: onlinePreferenceKey(work)
      };
      var stored = Lampa.Storage.get(preferenceKey, {});
      state.preferences = state.preferenceKey && stored && stored[state.preferenceKey] || {};
      state.assRenderer = '/homelab-media/jassub/';
      state.assItems = onlineItems(state, work);
      if (!state.assItems.length) return onlineFallback(state, null);
      if (!state.preferences.subtitles && (subtitledVoice(work) || Lampa.Storage.field('subtitles_start'))) {
        var full = state.assItems.filter(function (item) { return !item.homelabSigns; });
        var pick = full.filter(function (item) { return item.language === 'ru'; })[0] || full[0];
        if (pick) state.restoreSubtitle = identity(pick);
      }
      report('online-subtitles', {count: state.assItems.length}, work);
      // The stream's own subtitle tracks may have arrived first; they stay in the menu.
      adoptSubtitles(state);
      if (!state.subtitleList) {
        state.subtitleList = [];
        state.hlsSubs = [];
        Lampa.PlayerPanel.setSubs(state.subtitleList);
      }
      applySubtitles(state, withAss(state, state.subtitleList));
    }

    // The renderer or the sidecar failed: Lampa shows the files as before, as text.
    function onlineFallback(state, failed) {
      var work = state.work, list = work.homelab_online_subtitles;
      if (!list || active !== state || state.onlineFallback) return;
      state.onlineFallback = true;
      report('online-subtitles-fallback', {track: failed && failed.label}, work);
      state.assItems = [];
      if (state.subtitleList) withAss(state, state.subtitleList);
      var source = failed && failed.homelabAss.source;
      try { Lampa.Player.subtitles(list.map(function (sub) { return Object.assign({}, sub); })); } catch (error) { return; }
      // Lampa's 'subs' event has brought its own items into the menu by now.
      var native = source && (state.subtitleList || []).filter(function (sub) { return sub.url === source.url; })[0];
      if (!native) return;
      native.selected = true;
      native.mode = 'showing';
      Lampa.PlayerVideo.subsview(true);
    }

    // Lampa replaces the video element on a quality or stream switch, often
    // without a new subtitle list: the drawn subtitles follow it.
    function followVideo() {
      var state = active, video = Lampa.PlayerVideo.video();
      if (!state || !state.assActive || !video || state.assVideo === video || Lampa.Player.playdata() !== state.work) return;
      showAss(state, state.assActive, 'new-video');
    }

