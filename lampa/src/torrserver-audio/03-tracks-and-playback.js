    // ── Track identity, remembered choices, own GST streams and switching them ──
    function newSessionId() {
      // Each replacement gets its own task: a slow obsolete request must not
      // finish later and dispose the current episode/audio task on the server.
      return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() :
        'lampa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }

    function normalized(value) {
      return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }

    // Track names come from torrent files and tags, and Lampa puts menu titles
    // and notices into HTML unescaped: never let one carry markup. Look-alikes
    // keep the name readable; the sidecar does the same.
    var MARKUP = {'<': '\u2039', '>': '\u203a', '"': '\u2033', "'": '\u2019', '`': '\u02bb'};
    function plain(text) {
      return String(text).replace(/[<>"'`]/g, function (char) { return MARKUP[char]; });
    }

    var LANGUAGE_ALIASES = {rus: 'ru', eng: 'en', jpn: 'ja', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', ukr: 'uk', por: 'pt'};

    function languageCode(value) {
      var language = normalized(value);
      return LANGUAGE_ALIASES[language] || language;
    }

    function identity(track) {
      // Lampa rewrites `title` with menu numbering; it is not track metadata.
      return {
        title: normalized(track.gstTitle === undefined ? track.label : track.gstTitle),
        language: languageCode(track.language),
        external: Boolean(track.external)
      };
    }

    function matchingTrack(tracks, preference) {
      if (!preference || preference.off) return null;
      var matches = tracks.filter(function (track) {
        var candidate = identity(track);
        if (preference.language && candidate.language && preference.language !== candidate.language) return false;
        // Preferences stored before external tracks existed are embedded.
        if (Boolean(preference.external) !== candidate.external) return false;
        return preference.title ? candidate.title === preference.title : preference.language && candidate.language === preference.language;
      });
      return matches.length === 1 ? matches[0] : null;
    }

    function remember(state, type, preference) {
      state.preferences[type] = preference;
      var stored = Lampa.Storage.get(preferenceKey, {});
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
      var hash = String(state.work.homelab_torrent_hash || state.work.torrent_hash);
      delete stored[hash];
      stored[hash] = state.preferences;
      Object.keys(stored).slice(0, -50).forEach(function (key) { delete stored[key]; });
      Lampa.Storage.set(preferenceKey, stored);
      if (type === 'audio' && state.tracks) { arrangeMenu(state); repaintTracks(state); }
      phase('preferences', state.work);
    }

    function clear() {
      generation++;
      if (!active) return;
      hideAss(active, 'clear');
      // The panel may keep this list into the next episode: it keeps only
      // the stream's own tracks, without the drawn items, «Выкл.» or menu hooks.
      if (active.subtitleList) {
        var originals = (active.hlsSubs || []).filter(function (item) { return !item.homelabAss && !item.homelabOff; });
        active.subtitleList.splice.apply(active.subtitleList, [0, active.subtitleList.length].concat(originals));
        originals.forEach(releaseItem);
      }
      (active.tracks || []).forEach(releaseItem);
      clearTimeout(active.prepareTick);
      if (active.releaseStream) active.releaseStream();
      active.abort.abort();
      active.externalAbort.abort();
      cancelPreparation(active);
      clearTimeout(active.probeTimeout);
      clearTimeout(active.externalTimeout);
      clearTimeout(active.externalRetry);
      if (active.cancelRestore) active.cancelRestore();
      if (active.menu && active.work.voiceovers === active.menu) {
        if (active.previousTracks === undefined) delete active.work.voiceovers;
        else active.work.voiceovers = active.previousTracks;
      }
      active = null;
      updateSignsToggle();
    }

    function ownStream(state, url) {
      if (state.streamUrl === url.href && state.releaseStream) return;
      if (state.releaseStream) state.releaseStream();
      // Legacy TorrServer tasks are shared: never claim or delete them.
      if (!state.work.homelab_torrent_hash || url.pathname !== '/gst/start.m3u8') return;
      var controller = new AbortController();
      var discoveryController = new AbortController();
      var id = null;
      var closed = false;
      var removed = false;
      var heartbeatTimer;
      var discoveryTimer = setTimeout(function () { discoveryController.abort(); }, 90000);
      function remove() {
        if (!id || removed) return;
        removed = true;
        var endpoint = new URL('/gst/remove', url.origin);
        endpoint.searchParams.set('id', id);
        window.fetch(endpoint.href, {keepalive: true}).catch(function () {});
      }
      function release() {
        closed = true;
        clearTimeout(heartbeatTimer);
        controller.abort();
        // An in-flight redirect can still reveal an already-created task.
        // Keep that one bounded lookup alive, without issuing another start.
        if (id) {
          clearTimeout(discoveryTimer);
          discoveryController.abort();
        }
        remove();
        if (state.releaseStream === release) {
          state.releaseStream = null;
          state.streamUrl = null;
        }
      }
      function heartbeat() {
        if (closed || active !== state || state.releaseStream !== release) return;
        window.fetch(new URL('/gst/' + id + '/heartbeat', url.origin).href,
          {signal: controller.signal, cache: 'no-store'}).catch(function () {});
        heartbeatTimer = setTimeout(heartbeat, 20000);
      }
      state.releaseStream = release;
      state.streamUrl = url.href;
      // The player and this request use the same unique UID; Lampac deduplicates
      // creation. Its redirect identifies exactly the task owned by this stream.
      window.fetch(url.href, {signal: discoveryController.signal, cache: 'no-store'}).then(function (response) {
        var resolved = new URL(response.url);
        var match = /^\/gst\/(\d+)\/master\.m3u8$/.exec(resolved.pathname);
        if (resolved.origin !== url.origin || !match) throw new Error('Unexpected task redirect');
        id = match[1];
        if (closed || active !== state || state.releaseStream !== release) return remove();
        if (!response.ok) throw new Error('Task discovery failed');
        heartbeatTimer = setTimeout(heartbeat, 20000);
      }).catch(function (error) {
        if (error.name === 'AbortError') return;
        console.warn('Homelab GST task:', error.message);
        report('gst-task-failed', {reason: error.message}, state.work);
      }).finally(function () { clearTimeout(discoveryTimer); });
    }

    function preparePlayback(event) {
      installHlsResilience();
      var work = event.data;
      var runas = runasChoice;
      runasChoice = null;
      if (runas && runas !== 'inner' && runas !== 'lampa') return;
      var original = masterUrl(work);
      if (!original) return;
      pausedWork = null;
      // A torrent card's ffprobe describes one file of the release, often an
      // external audio file, and Lampa would label the GST tracks with it.
      delete work.ffprobe;
      // hls.js preserves EXT-X-MEDIA subtitles. Lampa's native parser can
      // reduce a muxed-audio master to its video-only variant on Safari.
      work.hls_type = 'hlsjs';
      // Without torrent_hash Lampa would pick its main player setting, not
      // the torrent one; masterUrl already checked that this is the embedded player.
      work.launch_player = 'inner';
      work.hls_manifest_timeout = 90000;
      var replayed = Boolean(work.homelab_gst_played);
      if (replayed) {
        // A playlist item played again keeps the object of its last play.
        // Only cross-device resume brings preferences of its own.
        if (work.homelab_resume_at === undefined || work.homelab_resume_at === null) delete work.homelab_track_preferences;
        delete work.homelab_external_audio;
        delete work.homelab_retry_playback;
      }
      work.homelab_gst_played = true;
      if (!work.homelab_torrent_hash) {
        // Lampa finds the playing item of its playlist by this URL.
        work.homelab_source_url = work.url;
        var source = new URL('http://gluetun-torrserver:8090/stream/');
        source.searchParams.set('link', work.torrent_hash);
        source.searchParams.set('index', original.searchParams.get('index') || '1');
        source.searchParams.set('play', '');
        var playback = new URL('/gst/start.m3u8', window.location.href);
        playback.searchParams.set('link', source.href);
        playback.searchParams.set('uid', newSessionId());
        playback.searchParams.set('audio', original.searchParams.get('audio') || '0');
        work.url = playback.href;
        work.homelab_torrent_hash = work.torrent_hash;
        work.homelab_file_index = Number(source.searchParams.get('index'));
        // Prevent Lampa's old TorrServer GST heartbeat/drop from controlling
        // another viewer's legacy task for this torrent.
        delete work.torrent_hash;
      } else {
        // The audio of the last play is chosen again from the preferences.
        if (replayed) original.searchParams.delete('audio');
        original.searchParams.set('uid', newSessionId());
        work.url = original.href;
      }
    }

    // Torrent player choices Lampa plays in its own embedded player; any other
    // (Android, VLC, Infuse, webOS, an outside player...) opens an external app.
    var EMBEDDED_PLAYERS = {inner: true, lampa: true, tizen: true, orsay: true, ios: true};

    function externalTorrentPlayer() {
      var choice = Lampa.Storage.field('player_torrent');
      if (choice && !EMBEDDED_PLAYERS[choice]) return true;
      // Lampa's main `player` setting picks Samsung AVPlay or Orsay for the
      // embedded player: an <object> without hls.js, MSE or working
      // removeEventListener. Leave those to Lampa's own flow.
      var platform = Lampa.Platform && Lampa.Platform.is;
      var main = Lampa.Storage.field('player');
      return Boolean(platform && (platform.call(Lampa.Platform, 'tizen') && main === 'tizen' ||
        platform.call(Lampa.Platform, 'orsay') && main === 'orsay'));
    }

    // The torrent menu's "run as" (Player.runas) applies to the next play only
    // after `create`; remember it so that play is left to Lampa.
    var runasChoice = null;
    if (typeof Lampa.Player.runas === 'function' && !Lampa.Player.runas.homelab) {
      var lampaRunas = Lampa.Player.runas;
      Lampa.Player.runas = function (need) {
        runasChoice = need || null;
        return lampaRunas.apply(this, arguments);
      };
      Lampa.Player.runas.homelab = true;
    }

    function masterUrl(work) {
      if (!work || typeof work.url !== 'string' || !(work.homelab_torrent_hash || work.torrent_hash)) return null;
      if (externalTorrentPlayer()) return null;
      var source = Lampa.Torserver && Lampa.Torserver.toPlayUrl ? Lampa.Torserver.toPlayUrl(work.url) : work.url;
      try {
        var url = new URL(source, window.location.href);
        return /\/gst\/[^/]+\/master\.m3u8$/.test(url.pathname) ||
          (work.homelab_torrent_hash && url.pathname === '/gst/start.m3u8') ? url : null;
      } catch (error) { return null; }
    }

    function selectTrack(state, track, automatic, retry) {
      if (active !== state || Lampa.Player.playdata() !== state.work) return;
      var url = masterUrl(state.work);
      if (!automatic && !retry) remember(state, 'audio', identity(track));
      if (!url || (!retry && track === selectedTrack(state, url))) return cancelPreparation(state);
      // Only an explicit choice tries a track that already failed again.
      if (track.external && (track.unsupported || track.failed) && automatic) return;
      if (!automatic) track.failed = track.prepareFailed = false;
      if (track.external && !track.ready) return prepareExternal(state, track, automatic);
      cancelPreparation(state);
      if (automatic && !retry && state.autoNotice === track) {
        state.autoNotice = null;
        notify('Озвучка: ' + audioName(track) + (seriesPlayback(state.work) ? ' — как в прошлой серии' : ' — как в прошлый раз'));
      }
      report('audio-switch', {auto: Boolean(automatic), track: track.label, external: Boolean(track.external)}, state.work);
      if (state.cancelRestore) state.cancelRestore(true);
      var oldVideo = Lampa.PlayerVideo.video();
      // A second selection can arrive before the replacement video is ready.
      // Its temporary paused/zero-time state is not the user's playback state.
      var saved = state.pendingPlayback || {
        time: Number(oldVideo.currentTime) || 0,
        paused: automatic && oldVideo.readyState < 1 ? false : oldVideo.paused,
        volume: oldVideo.volume,
        muted: oldVideo.muted,
        rate: oldVideo.playbackRate
      };
      state.pendingPlayback = saved;
      if (retry) { if (state.work.homelab_torrent_hash) url.searchParams.set('uid', newSessionId()); phase('preparing', state.work); }
      if (state.subtitles && !state.preferences.subtitles) {
        var selectedSubtitle = state.subtitles.find(function (sub) { return sub.mode === 'showing'; });
        state.restoreSubtitle = selectedSubtitle ? identity(selectedSubtitle) : {off: true};
      }
      var embedded = track.external ? carrierTrack(state, url) : track;
      if (track.external) {
        state.work.homelab_external_audio = {key: track.key, url: externalUrl(track, saved.time), codecs: track.codecs, name: track.gstTitle, language: track.language};
      } else delete state.work.homelab_external_audio;
      // An external rendition reuses the running task unless the embedded
      // track would need transcoding that the stripped video never plays.
      if (Number(url.searchParams.get('audio') || 0) !== embedded.index) {
        url.searchParams.set('audio', String(embedded.index));
        if (state.work.homelab_torrent_hash) url.searchParams.set('uid', newSessionId());
      }
      state.work.url = url.href;
      state.tracks.forEach(function (item) { item.selected = item === track; });
      replaceVideo(state, url, saved);
    }

    function replaceVideo(state, url, saved) {
      Lampa.PlayerVideo.destroy(true);
      Lampa.PlayerVideo.url(url.href, true);
      ownStream(state, url);
      var video = Lampa.PlayerVideo.video();
      var timer;
      var pauseTimer;
      var restored = false;
      function valid() { return active === state && Lampa.PlayerVideo.video() === video; }
      function cleanup(keepSnapshot) {
        clearTimeout(timer);
        clearTimeout(pauseTimer);
        video.muted = saved.muted;
        if (keepSnapshot !== true && state.pendingPlayback === saved) state.pendingPlayback = null;
        if (restored && keepSnapshot !== true) delete state.work.homelab_retry_playback;
        video.removeEventListener('loadedmetadata', restoreTime);
        video.removeEventListener('canplay', finish);
        video.removeEventListener('playing', keepPaused);
        video.removeEventListener('error', cleanup);
        if (state.cancelRestore === cleanup) state.cancelRestore = null;
      }
      function keepPaused() {
        if (!valid() || !saved.paused) return;
        video.removeEventListener('playing', keepPaused);
        // Native PlayerVideo clears its loading flag only on actual playing.
        // Restore pause after its play Promise updates the controls; the
        // handoff stays muted so switching a paused track emits no sound.
        pauseTimer = setTimeout(function () {
          if (!valid()) return cleanup();
          Lampa.PlayerVideo.pause();
          cleanup();
        }, 0);
      }
      function restoreTime() {
        if (!valid()) return cleanup();
        video.volume = saved.volume;
        video.muted = saved.paused ? true : saved.muted;
        video.playbackRate = saved.rate;
        if (!restored && video.readyState >= 1) {
          try { video.currentTime = saved.time; restored = true; } catch (error) {}
        }
      }
      function finish() {
        if (!valid()) return cleanup();
        restoreTime();
        Lampa.PlayerVideo.play();
        if (!saved.paused) cleanup();
      }
      state.cancelRestore = cleanup;
      video.addEventListener('loadedmetadata', restoreTime);
      video.addEventListener('canplay', finish);
      video.addEventListener('playing', keepPaused);
      video.addEventListener('error', cleanup);
      timer = setTimeout(cleanup, 60000);
      // Restore playback after a manual choice or a remembered episode preference.
      restoreTime();
      if (state.tracks) Lampa.PlayerPanel.setTracks(state.menu || state.tracks);
      // Lampa reports subtitles again only when the stream has embedded ones;
      // drawn subtitles must follow the new video element either way.
      if (state.assActive && state.assVideo !== video) showAss(state, state.assActive, 'new-video');
    }

    // Renditions are encoded from the playback position, so tell the sidecar
    // where playback is.
    function externalUrl(track, time) {
      if (time === undefined) time = Number(Lampa.PlayerVideo.video().currentTime) || 0;
      return track.url + '?at=' + Math.floor(time);
    }

    // A remembered voice is applied while playback is just starting; a late
    // lookup or preparation only tells the viewer it is there.
    var AUTO_APPLY_MS = 45000;
    var AUTO_PREPARE_MS = 90000;

    function lateTrack(state, track) {
      if (state.lateNotice === track) return;
      state.lateNotice = track;
      report('audio-late', {track: track.label, external: Boolean(track.external)}, state.work);
      notify('Озвучка «' + audioName(track) + '» готова — включите её в аудиодорожках');
    }

