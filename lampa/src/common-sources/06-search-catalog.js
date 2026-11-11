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
