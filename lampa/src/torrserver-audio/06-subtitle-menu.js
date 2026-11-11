    // ── The subtitle menu: labels, signs-only toggle, embedded and external items ──
    // Menu labels read "<who>: <what>", like the audio menu: the group or the
    // language, then full subtitles or signs only. External files end in
    // "(внешние)", as external audio ends in "(внешняя)".
    // Words match whole only: JS's \b knows no Cyrillic letters.
    function words(list) { return new RegExp('(^|[^0-9A-Za-zА-Яа-яЁё])(' + list + ')(?=$|[^0-9A-Za-zА-Яа-яЁё])', 'gi'); }
    var FULL_WORDS = words('full|полные|полн[а-яё]*');
    var SIGNS_WORDS = words('signs?|forced|songs?|надпис[а-яё]*|песни');
    var NOISE_WORDS = words('[a-z]{2}-[a-z]{2}|только|от|by|full|полные|полн[а-яё]*|signs?|forced|songs?|надпис[а-яё]*|песни|и|and|subs?|subtitles?|субтитры|' +
      'srt|ass|ssa|rus|ru|russian|русские|русский|eng|en|english|английские|английский|jpn|ja|japanese|японские|японский|ukr|uk|украинские|украинский');
    var LANGUAGES = {
      rus: 'Русские', ru: 'Русские', eng: 'Английские', en: 'Английские', jpn: 'Японские', ja: 'Японские',
      ukr: 'Украинские', uk: 'Украинские'
    };
    function signsTitle(title) {
      title = String(title || '');
      // Full subtitles that mention signs ("Full + Signs") are still full.
      return !title.match(FULL_WORDS) && !!title.match(SIGNS_WORDS);
    }

    function subtitleParts(title, language, signs) {
      title = String(title || '').replace(/["'«»\u2033\u2019]/g, '').trim();
      if (signs === undefined) signs = signsTitle(title);
      var lang = LANGUAGES[String(language || '').toLowerCase()] || '';
      var group = title.replace(NOISE_WORDS, '$1').replace(/[\[\]()]/g, ' ')
        .replace(/^[\s\-_.,:;|/+&]+|[\s\-_,:;|/+&]+$/g, '').replace(/\s+/g, ' ');
      if (/^[\d\s]*$/.test(group)) group = ''; // "Субтитры 2": tracks are numbered later
      return {title: title, group: group, lang: lang, signs: signs};
    }

    function capitalized(text) {
      return text.charAt(0).toUpperCase() + text.slice(1);
    }

    function subtitleLabel(title, language, external, signs) {
      var parts = subtitleParts(title, language, signs);
      var who = parts.group || parts.lang || parts.title || 'Субтитры';
      var what = parts.signs ? 'надписи' : 'полные';
      // A group says nothing of the language unless it is the usual Russian.
      if (parts.group && parts.lang && parts.lang !== 'Русские') what += ', ' + parts.lang.toLowerCase();
      return plain(capitalized(who) + ': ' + what + (external ? ' (внешние)' : ''));
    }

    // The subtitle menu: the group or the language as the title, then what
    // the track covers, whether ASS draws it with its styles and where it is from.
    var SDH_WORDS = words('sdh|cc|hoh|слабослыш[а-яё]*');

    function subtitleSource(item) {
      return item.homelabSource || {title: item.label, language: subtitleLanguage(item), external: Boolean(item.external)};
    }

    function subtitleTitle(item) {
      var source = subtitleSource(item);
      var parts = subtitleParts(cleanName(source.title).replace(SDH_WORDS, '$1'), source.language, subtitleSigns(item));
      return capitalized(parts.group || parts.lang || languageName(source.language) || 'Субтитры');
    }

    function subtitleDetails(state, item) {
      var source = subtitleSource(item);
      var parts = subtitleParts(source.title, source.language, subtitleSigns(item));
      var details = [];
      if (state.assActive === item && !state.assInstance) details.push('загружаются…');
      if (state.subtitles && matchingTrack(state.subtitles, state.preferences.subtitles) === item) details.push('★ для сериала');
      details.push(parts.signs ? 'надписи' : String(source.title || '').match(SDH_WORDS) ? 'полные, для слабослышащих' : 'полные');
      var title = item.homelabTitle || subtitleTitle(item);
      if (parts.lang && title.indexOf(parts.lang) !== 0) details.push(parts.lang.toLowerCase());
      if (item.homelabAss && !item.homelabAss.text) details.push('ASS со стилями');
      details.push(source.online ? 'от источника' : source.external ? 'внешние' : 'встроенные');
      return details.join(' · ');
    }

    function paintSubtitle(state, item) {
      if (item.homelabItem) paintItem(item.homelabItem, item.homelabTitle || subtitleTitle(item), subtitleDetails(state, item));
    }

    function repaintSubtitles(state) {
      (state.subtitleList || []).forEach(function (item) { if (!item.homelabOff) paintSubtitle(state, item); });
    }

    // Our own first item: Lampa inserts its «Отключено» only into a list without one.
    function offItem(list) {
      var item = {index: -1, title: 'Выкл.', homelabOff: true};
      Object.defineProperty(item, 'selected', {
        enumerable: true,
        get: function () { return !list.some(function (sub) { return sub !== item && sub.mode === 'showing'; }); },
        set: function () {}
      });
      // Lampa's menu sets the chosen item's mode; this one is never a track.
      Object.defineProperty(item, 'mode', {enumerable: true, get: function () { return 'disabled'; }, set: function () {}});
      return item;
    }

    function decorateSubtitles(items) {
      var seen = {};
      items.forEach(function (item) {
        var title = subtitleTitle(item);
        var key = title + '|' + subtitleSigns(item) + '|' + Boolean(subtitleSource(item).external);
        seen[key] = (seen[key] || 0) + 1;
        item.homelabTitle = seen[key] > 1 ? title + ' (' + seen[key] + ')' : title;
        hidden(item, 'onDraw', drawSubtitle);
      });
      return items;
    }

    // Tracks that come out with the same label are numbered in menu order, so
    // they stay apart and a choice by label finds the same one next episode.
    function numberLabels(items) {
      var seen = {};
      items.forEach(function (item) {
        if (!item.homelabLabel) return;
        var count = seen[item.homelabLabel] = (seen[item.homelabLabel] || 0) + 1;
        item.label = count > 1 ? item.homelabLabel + ' ' + count : item.homelabLabel;
      });
      return items;
    }

    function assItems(state, data) {
      var base = '/homelab-media/' + encodeURIComponent(state.work.homelab_torrent_hash) + '/';
      var items = [];
      (data.subtitles || []).filter(function (sub) { return Number.isInteger(sub.file); }).forEach(function (sub, number) {
        var fonts = (sub.fonts || []).filter(Number.isInteger).map(function (id) {
          return new URL(base + id + '/raw', window.location.href).href;
        });
        [false, true].forEach(function (signs) {
          items.push(defineMode(state, {
            index: 1000 + number * 2 + (signs ? 1 : 0), external: true, language: sub.language || '',
            label: subtitleLabel(sub.title, sub.language, true, signs),
            homelabLabel: subtitleLabel(sub.title, sub.language, true, signs),
            homelabAss: {url: base + sub.file + '/raw', fonts: fonts, signs: signs}, homelabSigns: signs,
            homelabSource: {title: sub.title, language: sub.language || '', external: true}
          }));
        });
      });
      return numberLabels(items);
    }

    function withAss(state, list) {
      if (!state.hlsSubs) state.hlsSubs = list.filter(function (item) { return !item.homelabAss && !item.homelabOff; });
      var items = embeddedItems(state);
      // Tracks the plugin does not rename keep GST's name, which can carry markup.
      items.forEach(function (item) {
        if (!item.homelabAss && /[<>"'`]/.test(item.label)) item.label = plain(item.label);
      });
      var all = decorateSubtitles(numberLabels(items.concat(state.assItems || [])));
      list.splice.apply(list, [0, list.length].concat(all.length ? [offItem(list)].concat(all) : []));
      // A plain-text track already showing switches to its drawn version.
      items.forEach(function (item) {
        if (item.homelabOriginal && item.homelabOriginal.mode === 'showing') showWith(item, 'drawn');
      });
      return list;
    }

    function applySubtitles(state, list) {
      // Native TextTrack accessors live on the prototype; hls.js uses own
      // accessors. Keep either real object so its playback setter stays intact.
      var subtitles = list.filter(function (sub) {
        return sub.index !== -1 && (!sub.kind || sub.kind === 'subtitles' || sub.kind === 'captions') &&
          ['disabled', 'hidden', 'showing'].indexOf(sub.mode) !== -1;
      });
      if (!subtitles.length) return updateSignsToggle();
      state.subtitles = subtitles;
      var preference = state.preferences.subtitles || state.restoreSubtitle;
      if (preference) {
        var selected = matchingTrack(subtitles, preference);
        subtitles.forEach(function (sub) {
          if (sub === selected) return;
          sub.selected = false;
          sub.mode = 'disabled';
        });
        // Leave a showing track alone: re-enabling would restart its renderer.
        if (selected) {
          selected.selected = true;
          if (selected.mode !== 'showing') {
            report('subtitle-switch', {auto: true, track: selected.label}, state.work);
            showWith(selected, 'preference');
          }
        }
        Lampa.PlayerVideo.subsview(Boolean(selected));
        delete state.restoreSubtitle;
      }
      updateSignsToggle();
    }

    // One press switches between signs only and full subtitles of the same
    // release: the other item of an external file, or the embedded track of
    // the same language that covers the other part.
    function subtitleSigns(item) {
      return item.homelabSigns !== undefined ? item.homelabSigns : signsTitle(item.label);
    }

    function subtitleLanguage(item) {
      var language = languageCode(item.homelabLanguage !== undefined ? item.homelabLanguage : item.language || item.lang);
      return language === 'und' ? '' : language;
    }

    function subtitleFile(item) {
      // Online forced and full come as separate files of one language.
      return item.homelabAss && !item.homelabAss.online && item.homelabAss.url || null;
    }

    // "AniLibria" of "AniLibria: надписи".
    function subtitleGroup(item) {
      var label = item.homelabLabel || subtitleLabel(item.label, subtitleLanguage(item), false);
      return label.slice(0, label.lastIndexOf(': '));
    }

    function showingSubtitle(state) {
      return (state.subtitles || []).filter(function (sub) { return sub.mode === 'showing'; })[0] || null;
    }

    function counterpart(state, current) {
      var list = state.subtitles || [];
      var at = list.indexOf(current);
      if (at === -1) return null;
      var signs = subtitleSigns(current);
      var file = subtitleFile(current);
      var candidates = list.filter(function (sub) {
        if (sub === current || subtitleSigns(sub) === signs || subtitleFile(sub) !== file) return false;
        return file || subtitleLanguage(sub) === subtitleLanguage(current);
      });
      var group = subtitleGroup(current);
      var same = candidates.filter(function (sub) { return subtitleGroup(sub) === group; });
      // Without a language only the same group is known to be the same release.
      if (!file && !subtitleLanguage(current)) candidates = same;
      // Of several, the nearest in the menu: a release lists its pair together.
      return (same.length ? same : candidates).reduce(function (best, sub) {
        return !best || Math.abs(list.indexOf(sub) - at) < Math.abs(list.indexOf(best) - at) ? sub : best;
      }, null);
    }

    // A second press returns to the track the first one came from.
    function toggleTarget(state, current) {
      var origin = state.signsOrigin;
      if (origin && origin.to === current && (state.subtitles || []).indexOf(origin.from) !== -1) return origin.from;
      return counterpart(state, current);
    }

    var toggling = false;

    function toggleSigns() {
      var state = active;
      if (!state || Lampa.Player.playdata() !== state.work) return;
      var current = showingSubtitle(state);
      var target = current && toggleTarget(state, current);
      if (!target) return;
      state.signsOrigin = {from: current, to: target};
      // The steps of Lampa's subtitle menu: its subsview event remembers the choice.
      (state.subtitleList || []).concat(state.subtitles).forEach(function (sub) {
        if (sub === target) return;
        sub.mode = 'disabled';
        sub.selected = false;
      });
      target.mode = 'showing';
      target.selected = true;
      toggling = true;
      try { Lampa.PlayerPanel.listener.send('subsview', {status: true}); } finally { toggling = false; }
      if (Lampa.Noty) Lampa.Noty.show('Субтитры: ' + target.label);
    }

    // A panel button beside the subtitle menu, shown while the track on
    // screen has a counterpart. Lampa's controller and its mobile "more"
    // menu pick up any `.button.selector` with a tooltip.
    var signsButton = null;
    var SIGNS_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>';

    function signsToggleButton() {
      if (signsButton) return signsButton;
      var jq = window.jQuery;
      var panel = jq && Lampa.PlayerPanel.render && Lampa.PlayerPanel.render();
      var menu = panel && panel.find('.player-panel__subs');
      if (!menu || !menu.length) return null;
      signsButton = jq('<div class="player-panel__homelab-signs button selector hide"></div>');
      signsButton.on('hover:enter', toggleSigns);
      menu.after(signsButton);
      return signsButton;
    }

    function updateSignsToggle() {
      var button = signsToggleButton();
      if (!button) return;
      var state = active && Lampa.Player.playdata() === active.work ? active : null;
      var current = state && showingSubtitle(state);
      var target = current && toggleTarget(state, current);
      button.toggleClass('hide', !target);
      // Lampa's mobile "more" menu takes each button's icon from its svg.
      // Only the icon on the panel; the tooltip names the track on screen.
      if (target) button.html(SIGNS_ICON + '<div class="tooltip">' + (subtitleSigns(current) ? 'Сейчас надписи' : 'Сейчас полные') + ' · переключить (S)</div>');
    }

    function adoptSubtitles(state) {
      if (state.subtitleList || !lastSubtitles || lastSubtitles.work !== state.work) return;
      state.subtitleList = lastSubtitles.list;
      state.hlsSubs = lastSubtitles.originals;
    }

    function embeddedSubtitles(state, work, revision) {
      if (!work.homelab_torrent_hash || !Number.isInteger(work.homelab_file_index) || !assSupported()) return;
      var url = new URL('/homelab-media/' + encodeURIComponent(work.homelab_torrent_hash) + '/' + work.homelab_file_index + '/embedded', window.location.href);
      var signal = state.abort.signal;
      function lookup(attempts) {
        return window.fetch(url.href, {signal: signal}).then(function (response) {
          // Busy lookup slots (429) or a torrent still fetching its file list (503).
          if ((response.status === 429 || response.status === 503) && attempts > 1) {
            return new Promise(function (resolve, reject) {
              var timer = setTimeout(function () { resolve(lookup(attempts - 1)); }, 5000);
              signal.addEventListener('abort', function () {
                clearTimeout(timer);
                var error = new Error('The operation was aborted');
                error.name = 'AbortError';
                reject(error);
              }, {once: true});
            });
          }
          if (!response.ok) throw new Error('embedded subtitle lookup: HTTP ' + response.status);
          return response.json();
        });
      }
      lookup(4).then(function (data) {
        if (active !== state || generation !== revision || !data || typeof data.renderer !== 'string' || !Array.isArray(data.subtitles)) return;
        if (!data.subtitles.some(function (sub) { return TEXT_CODECS[sub.codec]; })) return;
        state.assRenderer = data.renderer;
        state.embedded = data;
        adoptSubtitles(state);
        if (state.subtitleList) applySubtitles(state, withAss(state, state.subtitleList));
      }).catch(function (error) {
        if (error.name === 'AbortError') return;
        console.warn('Homelab embedded ASS:', error.message);
        report('ass-lookup-failed', {reason: error.message}, work);
      });
    }

    function installAss(state, data) {
      if (!data || typeof data.renderer !== 'string' || !Array.isArray(data.subtitles) || !data.subtitles.length) return;
      if (!assSupported()) return;
      state.assRenderer = data.renderer;
      state.assItems = assItems(state, data);
      if (!state.assItems.length) return;
      // Embedded subtitles may have arrived before this player state, or may
      // never arrive; then the external ones form the menu on their own.
      adoptSubtitles(state);
      if (!state.subtitleList) {
        state.subtitleList = [];
        state.hlsSubs = [];
        Lampa.PlayerPanel.setSubs(state.subtitleList);
      }
      applySubtitles(state, withAss(state, state.subtitleList));
    }

