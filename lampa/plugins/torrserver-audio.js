// Isolated browser playback and track preferences for Lampac GStreamer.
(function () {
  'use strict';

  function installGstAudio() {
    if (Lampa.HomelabGstAudio || !Lampa.Player || !Lampa.PlayerVideo || !Lampa.PlayerPanel) return;
    var active = null;
    var generation = 0;
    var preferenceKey = 'homelab_gst_track_preferences';
    function newSessionId() {
      // Each replacement gets its own task: a slow obsolete request must not
      // finish later and dispose the current episode/audio task on the server.
      return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() :
        'lampa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }

    function normalized(value) {
      return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function identity(track) {
      var language = normalized(track.language);
      var aliases = {rus: 'ru', eng: 'en', jpn: 'ja', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', ukr: 'uk', por: 'pt'};
      // Lampa rewrites `title` with menu numbering; it is not track metadata.
      return {title: normalized(track.gstTitle === undefined ? track.label : track.gstTitle), language: aliases[language] || language};
    }

    function matchingTrack(tracks, preference) {
      if (!preference || preference.off) return null;
      var matches = tracks.filter(function (track) {
        var candidate = identity(track);
        if (preference.language && candidate.language && preference.language !== candidate.language) return false;
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
    }

    function clear() {
      generation++;
      if (!active) return;
      if (active.releaseStream) active.releaseStream();
      active.abort.abort();
      clearTimeout(active.probeTimeout);
      if (active.cancelRestore) active.cancelRestore();
      if (active.work.voiceovers === active.tracks) {
        if (active.previousTracks === undefined) delete active.work.voiceovers;
        else active.work.voiceovers = active.previousTracks;
      }
      active = null;
    }

    function ownStream(state, url) {
      if (state.releaseStream) state.releaseStream();
      // Legacy TorrServer tasks are shared: never claim or delete them.
      if (!state.work.homelab_torrent_hash || url.pathname !== '/gst/start.m3u8') return;
      var controller = new AbortController();
      var id = null;
      var closed = false;
      var removed = false;
      var heartbeatTimer;
      var discoveryTimer = setTimeout(function () { controller.abort(); }, 90000);
      function remove() {
        if (!id || removed) return;
        removed = true;
        var endpoint = new URL('/gst/remove', url.origin);
        endpoint.searchParams.set('id', id);
        window.fetch(endpoint.href, {keepalive: true}).catch(function () {});
      }
      function release() {
        closed = true;
        clearTimeout(discoveryTimer);
        clearTimeout(heartbeatTimer);
        controller.abort();
        remove();
        if (state.releaseStream === release) state.releaseStream = null;
      }
      function heartbeat() {
        if (closed || active !== state || state.releaseStream !== release) return;
        window.fetch(new URL('/gst/' + id + '/heartbeat', url.origin).href,
          {signal: controller.signal, cache: 'no-store'}).catch(function () {});
        heartbeatTimer = setTimeout(heartbeat, 20000);
      }
      state.releaseStream = release;
      // The player and this request use the same unique UID; Lampac deduplicates
      // creation. Its redirect identifies exactly the task owned by this stream.
      window.fetch(url.href, {signal: controller.signal, cache: 'no-store'}).then(function (response) {
        if (!response.ok) throw new Error('Task discovery failed');
        var resolved = new URL(response.url);
        var match = /^\/gst\/(\d+)\/master\.m3u8$/.exec(resolved.pathname);
        if (resolved.origin !== url.origin || !match) throw new Error('Unexpected task redirect');
        id = match[1];
        if (closed || active !== state || state.releaseStream !== release) return remove();
        heartbeatTimer = setTimeout(heartbeat, 20000);
      }).catch(function (error) {
        if (error.name !== 'AbortError') console.warn('Homelab GST task:', error.message);
      }).finally(function () { clearTimeout(discoveryTimer); });
    }

    function preparePlayback(event) {
      var work = event.data;
      var original = masterUrl(work);
      if (!original) return;
      // hls.js preserves EXT-X-MEDIA subtitles. Lampa's native parser can
      // reduce a muxed-audio master to its video-only variant on Safari.
      work.hls_type = 'hlsjs';
      if (Lampa.Platform && Lampa.Platform.is('android')) work.launch_player = 'inner';
      work.hls_manifest_timeout = 90000;
      if (!work.homelab_torrent_hash) {
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
        // Prevent Lampa's old TorrServer GST heartbeat/drop from controlling
        // another viewer's legacy task for this torrent.
        delete work.torrent_hash;
      } else {
        original.searchParams.set('uid', newSessionId());
        work.url = original.href;
      }
    }

    function masterUrl(work) {
      if (!work || typeof work.url !== 'string' || !(work.homelab_torrent_hash || work.torrent_hash)) return null;
      if (Lampa.Platform && Lampa.Platform.is('android') && Lampa.Storage.field('player_torrent') !== 'inner') return null;
      var source = Lampa.Torserver && Lampa.Torserver.toPlayUrl ? Lampa.Torserver.toPlayUrl(work.url) : work.url;
      try {
        var url = new URL(source, window.location.href);
        return /\/gst\/[^/]+\/master\.m3u8$/.test(url.pathname) ||
          (work.homelab_torrent_hash && url.pathname === '/gst/start.m3u8') ? url : null;
      } catch (error) { return null; }
    }

    function selectTrack(state, track, automatic) {
      if (active !== state || Lampa.Player.playdata() !== state.work) return;
      var url = masterUrl(state.work);
      if (!automatic) remember(state, 'audio', identity(track));
      if (!url || Number(url.searchParams.get('audio') || 0) === track.index) return;
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
      if (state.subtitles && !state.preferences.subtitles) {
        var selectedSubtitle = state.subtitles.find(function (sub) { return sub.mode === 'showing'; });
        state.restoreSubtitle = selectedSubtitle ? identity(selectedSubtitle) : {off: true};
      }
      url.searchParams.set('audio', String(track.index));
      if (state.work.homelab_torrent_hash) url.searchParams.set('uid', newSessionId());
      state.work.url = url.href;
      state.tracks.forEach(function (item) { item.selected = item.index === track.index; });
      Lampa.PlayerVideo.destroy(true);
      Lampa.PlayerVideo.url(url.href, true);
      ownStream(state, url);
      var video = Lampa.PlayerVideo.video();
      var timer;
      var restored = false;
      function valid() { return active === state && Lampa.PlayerVideo.video() === video; }
      function cleanup(keepSnapshot) {
        clearTimeout(timer);
        if (keepSnapshot !== true && state.pendingPlayback === saved) state.pendingPlayback = null;
        video.removeEventListener('loadedmetadata', restoreTime);
        video.removeEventListener('canplay', finish);
        video.removeEventListener('play', keepPaused);
        video.removeEventListener('error', cleanup);
        if (state.cancelRestore === cleanup) state.cancelRestore = null;
      }
      function keepPaused() { if (valid() && saved.paused) video.pause(); }
      function restoreTime() {
        if (!valid()) return cleanup();
        video.volume = saved.volume;
        video.muted = saved.muted;
        video.playbackRate = saved.rate;
        if (!restored && video.readyState >= 1) {
          try { video.currentTime = saved.time; restored = true; } catch (error) {}
        }
        keepPaused();
      }
      function finish() {
        if (!valid()) return cleanup();
        restoreTime();
        if (saved.paused) Lampa.PlayerVideo.pause();
        else Lampa.PlayerVideo.play();
        cleanup();
      }
      state.cancelRestore = cleanup;
      video.addEventListener('loadedmetadata', restoreTime);
      video.addEventListener('canplay', finish);
      video.addEventListener('play', keepPaused);
      video.addEventListener('error', cleanup);
      timer = setTimeout(cleanup, 60000);
      // Restore playback after a manual choice or a remembered episode preference.
      restoreTime();
      Lampa.PlayerPanel.setTracks(state.tracks);
    }

    function installCurrent() {
      var work = Lampa.Player.playdata();
      var url = masterUrl(work);
      if (active && active.work === work && url) return;
      clear();
      if (!url || typeof window.fetch !== 'function' || typeof AbortController === 'undefined') return;
      var state = active = {work: work, abort: new AbortController(), previousTracks: work.voiceovers};
      var stored = Lampa.Storage.get(preferenceKey, {});
      state.preferences = stored && stored[String(work.homelab_torrent_hash || work.torrent_hash)] || {};
      var revision = generation;
      var probe = new URL(url.href);
      probe.pathname = probe.pathname.replace(/(?:master|start)\.m3u8$/, 'probe');
      probe.searchParams.delete('audio');
      probe.searchParams.delete('seconds');
      state.probeTimeout = setTimeout(function () { state.abort.abort(); }, 15000);
      window.fetch(probe.href, {signal: state.abort.signal}).then(function (response) {
        if (!response.ok) throw new Error('GStreamer track probe failed');
        return response.json();
      }).then(function (data) {
        if (active !== state || generation !== revision || Lampa.Player.playdata() !== work) return;
        var tracks = data.Tracks || (data.tracks || []).map(function (track) {
          return {Type: track.type, Index: track.index === undefined ? 0 : track.index, Title: track.title, Language: track.language, Channels: track.channels};
        });
        var audio = tracks.filter(function (track) {
          return track.Type === 'audio' && Number.isInteger(track.Index) && track.Index >= 0;
        });
        if (audio.length < 2) return;
        state.tracks = audio.map(function (track) {
          return {
            index: track.Index,
            language: track.Language,
            gstTitle: track.Title || '',
            label: track.Title || ('Audio ' + (track.Index + 1)),
            selected: track.Index === Number(url.searchParams.get('audio') || 0),
            extra: {channels: track.Channels},
            onSelect: function (item) {
              // Select invokes an item's own callback instead of the panel's
              // default handler, so restore the controller explicitly.
              try { selectTrack(state, item); }
              finally { Lampa.Controller.toggle('player'); }
            }
          };
        });
        work.voiceovers = state.tracks;
        Lampa.PlayerPanel.setTracks(state.tracks);
        var preferred = matchingTrack(state.tracks, state.preferences.audio);
        if (preferred) selectTrack(state, preferred, true);
      }).catch(function (error) {
        if (error.name !== 'AbortError') console.warn('Homelab GST audio:', error.message);
      }).finally(function () { clearTimeout(state.probeTimeout); });
      ownStream(state, url);
    }

    Lampa.PlayerVideo.listener.follow('subs', function (event) {
      if (!active || Lampa.Player.playdata() !== active.work) return;
      // Native TextTrack accessors live on the prototype; hls.js uses own
      // accessors. Keep either real object so its playback setter stays intact.
      var subtitles = (event.subs || []).filter(function (sub) {
        return sub.index !== -1 && (!sub.kind || sub.kind === 'subtitles' || sub.kind === 'captions') &&
          ['disabled', 'hidden', 'showing'].indexOf(sub.mode) !== -1;
      });
      if (!subtitles.length) return;
      active.subtitles = subtitles;
      var preference = active.preferences.subtitles || active.restoreSubtitle;
      if (preference) {
        var selected = matchingTrack(subtitles, preference);
        subtitles.forEach(function (sub) {
          sub.selected = false;
          sub.mode = 'disabled';
        });
        if (selected) { selected.selected = true; selected.mode = 'showing'; }
        Lampa.PlayerVideo.subsview(Boolean(selected));
        delete active.restoreSubtitle;
      }
    });
    Lampa.PlayerPanel.listener.follow('subsview', function (event) {
      if (!active || Lampa.Player.playdata() !== active.work) return;
      if (!event.status) return remember(active, 'subtitles', {off: true});
      var selected = (active.subtitles || []).find(function (sub) { return sub.mode === 'showing'; });
      if (selected) remember(active, 'subtitles', identity(selected));
    });
    Lampa.Player.listener.follow('create', preparePlayback);
    Lampa.Player.listener.follow('ready', installCurrent);
    Lampa.Player.listener.follow('destroy', clear);
    Lampa.HomelabGstAudio = {installCurrent: installCurrent};
  }

  installGstAudio();
  if (Lampa.HomelabGstAudio) Lampa.HomelabGstAudio.installCurrent();
})();
