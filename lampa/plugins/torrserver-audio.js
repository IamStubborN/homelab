// Isolated browser playback and track preferences for Lampac GStreamer.
(function () {
  'use strict';

  function installGstAudio() {
    if (Lampa.HomelabGstAudio || !Lampa.Player || !Lampa.PlayerVideo || !Lampa.PlayerPanel) return;
    var active = null;
    var pausedWork = null;
    var generation = 0;
    var preferenceKey = 'homelab_gst_track_preferences';

    var MP4_CONTAINERS = {moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, mvex: 1, moof: 1, traf: 1};

    function mp4Boxes(view, start, end) {
      var boxes = [];
      for (var offset = start; offset + 8 <= end;) {
        var size = view.getUint32(offset);
        if (size < 8 || offset + size > end) throw new Error('Invalid MP4 box');
        boxes.push({
          type: String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7)),
          start: offset, end: offset + size
        });
        offset += size;
      }
      return boxes;
    }

    function mp4Child(view, box, path) {
      var current = box;
      for (var i = 0; current && i < path.length; i++) {
        current = mp4Boxes(view, current.start + 8, current.end).filter(function (child) { return child.type === path[i]; })[0];
      }
      return current || null;
    }

    function mp4TrackId(view, box) {
      if (box.type === 'trex') return view.getUint32(box.start + 12);
      var header = mp4Child(view, box, [box.type === 'trak' ? 'tkhd' : 'tfhd']);
      if (!header) return null;
      var version = view.getUint8(header.start + 8);
      return view.getUint32(header.start + 12 + (header.type === 'tkhd' ? (version === 1 ? 16 : 8) : 0));
    }

    function mp4AudioTrackId(bytes) {
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var moov = mp4Boxes(view, 0, view.byteLength).filter(function (box) { return box.type === 'moov'; })[0];
      var trak = moov && mp4Boxes(view, moov.start + 8, moov.end).filter(function (box) {
        var handler = box.type === 'trak' && mp4Child(view, box, ['mdia', 'hdlr']);
        return handler && String.fromCharCode.apply(null, bytes.subarray(handler.start + 16, handler.start + 20)) === 'soun';
      })[0];
      return trak ? mp4TrackId(view, trak) : null;
    }

    // GStreamer muxes the selected embedded audio into every main fragment.
    // With an external rendition the main stream must be video-only, or
    // hls.js keeps both audio tracks in the media element.
    function mp4WithoutTrack(bytes, id) {
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      function removable(box) {
        return (box.type === 'trak' || box.type === 'traf' || box.type === 'trex') && mp4TrackId(view, box) === id;
      }
      function rebuild(box) {
        if (!MP4_CONTAINERS[box.type]) return [bytes.subarray(box.start, box.end)];
        var parts = [];
        var removed = 0;
        mp4Boxes(view, box.start + 8, box.end).forEach(function (child) {
          if (removable(child)) removed += child.end - child.start;
          else parts.push.apply(parts, rebuild(child));
        });
        if (!removed && box.type !== 'moof') return [bytes.subarray(box.start, box.end)];
        // A smaller moof moves its mdat: trun data offsets are moof-relative.
        if (box.type === 'moof' && removed) parts = parts.map(function (part) { return shiftedTraf(part, removed); });
        var header = new Uint8Array(8);
        new DataView(header.buffer).setUint32(0, 8 + parts.reduce(function (sum, part) { return sum + part.byteLength; }, 0));
        header.set(bytes.subarray(box.start + 4, box.start + 8), 4);
        return [header].concat(parts);
      }
      var parts = [];
      mp4Boxes(view, 0, view.byteLength).forEach(function (box) { parts.push.apply(parts, rebuild(box)); });
      var output = new Uint8Array(parts.reduce(function (sum, part) { return sum + part.byteLength; }, 0));
      var offset = 0;
      parts.forEach(function (part) { output.set(part, offset); offset += part.byteLength; });
      return output;
    }

    function shiftedTraf(part, removed) {
      var view = new DataView(part.buffer, part.byteOffset, part.byteLength);
      if (mp4Boxes(view, 0, part.byteLength)[0].type !== 'traf') return part;
      var copy = part.slice();
      var copyView = new DataView(copy.buffer);
      mp4Boxes(copyView, 8, copy.byteLength).forEach(function (child) {
        var flags = copyView.getUint32(child.start + 8) & 0xffffff;
        // Only moof-relative trun offsets survive removing a sibling traf.
        if (child.type === 'tfhd' && (!(flags & 0x020000) || flags & 0x000001) ||
            child.type === 'trun' && !(flags & 0x000001)) {
          throw new Error('Unsupported fragment layout');
        }
        if (child.type === 'trun') copyView.setInt32(child.start + 16, copyView.getInt32(child.start + 16) - removed);
      });
      return copy;
    }

    function transformingLoader(BaseLoader, transform) {
      function Loader(config) { this.inner = new BaseLoader(config); }
      ['stats', 'context'].forEach(function (name) {
        Object.defineProperty(Loader.prototype, name, {get: function () { return this.inner[name]; }});
      });
      Loader.prototype.load = function (context, config, callbacks) {
        var inner = this.inner;
        this.inner.load(context, config, Object.assign({}, callbacks, {
          onSuccess: function (response, stats, loaderContext, networkDetails) {
            try { response = transform(context, response); }
            catch (error) {
              return callbacks.onError({code: 0, text: 'Homelab audio: ' + error.message}, loaderContext, networkDetails, stats || inner.stats);
            }
            callbacks.onSuccess(response, stats, loaderContext, networkDetails);
          }
        }));
      };
      Loader.prototype.abort = function () { this.inner.abort(); };
      Loader.prototype.destroy = function () { this.inner.destroy(); };
      Loader.prototype.getCacheAge = function () { return this.inner.getCacheAge ? this.inner.getCacheAge() : null; };
      Loader.prototype.getResponseHeader = function (name) { return this.inner.getResponseHeader ? this.inner.getResponseHeader(name) : null; };
      return Loader;
    }

    function hlsQuoted(value) {
      return String(value || '').replace(/["\r\n]/g, ' ').trim();
    }

    function withExternalAudio(text, external) {
      var media = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="homelab-external",NAME="' + (hlsQuoted(external.name) || 'External') + '"' +
        (hlsQuoted(external.language) ? ',LANGUAGE="' + hlsQuoted(external.language) + '"' : '') +
        ',DEFAULT=YES,AUTOSELECT=YES,URI="' + external.url + '"';
      var inserted = false;
      return String(text).split(/\r?\n/).map(function (line) {
        if (line.indexOf('#EXT-X-STREAM-INF:') !== 0) return line;
        line = line.replace(/,AUDIO="[^"]*"/, '').replace(/:AUDIO="[^"]*",?/, ':') + ',AUDIO="homelab-external"';
        if (inserted) return line;
        inserted = true;
        return media + '\n' + line;
      }).join('\n');
    }

    function externalAudioLoaders(config, BaseLoader, external) {
      var audioTrack = null;
      config.pLoader = transformingLoader(config.pLoader || BaseLoader, function (context, response) {
        if (context.type !== 'manifest') return response;
        return Object.assign({}, response, {data: withExternalAudio(response.data, external)});
      });
      config.fLoader = transformingLoader(config.fLoader || BaseLoader, function (context, response) {
        var frag = context.frag;
        if (!frag || frag.type !== 'main') return response;
        var bytes = new Uint8Array(response.data);
        if (frag.sn === 'initSegment') audioTrack = mp4AudioTrackId(bytes);
        if (audioTrack === null) return response;
        return Object.assign({}, response, {data: mp4WithoutTrack(bytes, audioTrack).buffer});
      });
    }

    function installHlsResilience() {
      var BaseHls = window.Hls;
      if (!BaseHls || BaseHls.homelabResilience) return;

      function policy(firstByte, total, retries) {
        return {default: {
          maxTimeToFirstByteMs: firstByte, maxLoadTimeMs: total,
          timeoutRetry: {maxNumRetry: retries, retryDelayMs: 1000, maxRetryDelayMs: 4000},
          errorRetry: {maxNumRetry: retries, retryDelayMs: 1000, maxRetryDelayMs: 4000}
        }};
      }

      function HomelabHls(config) {
        var work = Lampa.Player.playdata();
        var source = masterUrl(work);
        if (!source || source.origin !== window.location.origin) return new BaseHls(config);

        config = Object.assign({}, config);
        // Lampa uses obsolete/misspelled options and a single XHR timeout.
        // Let the installed hls.js loader enforce its per-resource policies.
        delete config.manifestLoadTimeout;
        delete config.manifestLoadMaxRetryTimeout;
        delete config.xhrSetup;
        config.manifestLoadPolicy = policy(90000, 90000, 2);
        config.playlistLoadPolicy = policy(30000, 60000, 2);
        config.fragLoadPolicy = policy(30000, 120000, 3);
        if (work.homelab_external_audio) {
          externalAudioLoaders(config, config.loader || BaseHls.DefaultConfig.loader, work.homelab_external_audio);
        }
        var hls = new BaseHls(config);
        var listen = hls.on.bind(hls);
        var destroy = hls.destroy.bind(hls);
        var retries = 0;
        var timer = null;
        var deadlineTimer = null;
        var terminated = false;
        var lastError = null;
        var disposed = false;
        var handled = new WeakSet();
        var cancelPauseRestore = function () {};

        function clearDeadline() {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }

        function finishFailure() {
          if (disposed || terminated) return;
          terminated = true;
          clearDeadline();
          clearTimeout(timer);
          timer = null;
          hls.stopLoad();
          cancelPauseRestore();
          // Also cancel a pending track probe/restore: it must not restart a
          // stream after the application has received a terminal error.
          if (active && active.work === work) clear();
        }

        function beginDeadline() {
          if (disposed || terminated || deadlineTimer !== null) return;
          // One deadline includes loader retries and task recreation. Only a
          // buffered main fragment proves recovery, not another manifest load.
          deadlineTimer = setTimeout(function () {
            deadlineTimer = null;
            if (disposed || Lampa.Player.playdata() !== work) return;
            finishFailure();
            hls.trigger(BaseHls.Events.ERROR, Object.assign({}, lastError || {
              type: BaseHls.ErrorTypes.NETWORK_ERROR,
              details: 'manifestLoadTimeOut'
            }, {fatal: true}));
          }, 180000);
        }

        listen(BaseHls.Events.MANIFEST_LOADING, beginDeadline);
        listen(BaseHls.Events.FRAG_LOADING, function (name, data) {
          if (data.frag && data.frag.type === 'main') beginDeadline();
        });
        listen(BaseHls.Events.FRAG_BUFFERED, function (name, data) {
          // Init data contains no playable frames. Nor can a late buffer event
          // prove recovery while a fatal-error restart is still pending.
          if (!terminated && timer === null && data.frag &&
              data.frag.type === 'main' && data.frag.sn !== 'initSegment') {
            clearDeadline();
            clearTimeout(timer);
            timer = null;
            retries = 0;
            lastError = null;
          }
        });
        listen(BaseHls.Events.ERROR, function (name, data) {
          if (data.type === BaseHls.ErrorTypes.NETWORK_ERROR &&
              /^(manifest|level|frag)Load(Error|TimeOut)$/.test(data.details)) {
            lastError = data;
            beginDeadline();
          }
        });

        function recover(data) {
          if (handled.has(data)) return true;
          if (disposed || terminated || Lampa.Player.playdata() !== work || !data.fatal ||
              data.type !== BaseHls.ErrorTypes.NETWORK_ERROR) return false;
          // Restarting the GST task cannot fix an external audio rendition.
          if (data.frag && data.frag.type !== 'main') return false;
          var status = data.response && (data.response.code || data.response.status) || 0;
          if (status && status !== 404 && status !== 408 && status !== 429 && status < 500) return false;
          if (!/^(manifest|level|frag)Load(Error|TimeOut)$/.test(data.details)) return false;
          if (timer !== null) { handled.add(data); return true; }
          if (retries >= 2) return false;
          handled.add(data);
          retries++;
          var reload = /^manifest/.test(data.details) || status === 404;
          console.warn('Homelab HLS recovery:', data.details, 'HTTP', status, 'attempt', retries);
          timer = setTimeout(function () {
            timer = null;
            if (disposed || terminated || Lampa.Player.playdata() !== work) return;
            var position = hls.media && hls.media.currentTime || 0;
            // A not-yet-started video is initially paused too. An explicit
            // Lampa pause must survive even before metadata or the first frame.
            var paused = hls.media && hls.media.paused &&
              (pausedWork === work || position > 0);
            if (reload) {
              cancelPauseRestore();
              if (paused && hls.media) {
                var media = hls.media;
                var keepPaused = function () { media.pause(); cancelPauseRestore(); };
                media.addEventListener('play', keepPaused, {once: true});
                cancelPauseRestore = function () { media.removeEventListener('play', keepPaused); };
              }
              hls.config.startPosition = position;
              source = masterUrl(work);
              if (!source) return;
              if (work.homelab_torrent_hash && source.pathname === '/gst/start.m3u8') {
                source.searchParams.set('uid', newSessionId());
                work.url = source.href;
              }
              hls.loadSource(source.href);
              if (active && active.work === work) ownStream(active, source);
            } else hls.startLoad(position);
          }, retries * 2000);
          return true;
        }

        // Internal controller listeners are already registered by BaseHls.
        // Only defer the application's fatal-error UI while recovering.
        hls.on = function (event, callback, context) {
          if (event !== BaseHls.Events.ERROR) return listen(event, callback, context);
          return listen(event, function (name, data) {
            if (!recover(data)) {
              if (data.fatal && Lampa.Player.playdata() === work) finishFailure();
              // Lampa treats this exact reason as a raw-video URL and starts
              // native playback. Our GST endpoint is always HLS: report the
              // parse error instead of restarting a released task unbounded.
              if (data.fatal && data.details === 'manifestParsingError' &&
                  data.reason === 'no EXTM3U delimiter') {
                data = Object.assign({}, data, {
                  reason: 'Invalid GST HLS manifest (no EXTM3U delimiter)'
                });
              }
              callback.call(context || hls, name, data);
            }
          }, context);
        };
        hls.destroy = function () {
          disposed = true;
          clearTimeout(timer);
          clearDeadline();
          cancelPauseRestore();
          return destroy();
        };
        return hls;
      }
      Object.setPrototypeOf(HomelabHls, BaseHls);
      HomelabHls.prototype = BaseHls.prototype;
      HomelabHls.homelabResilience = true;
      window.Hls = HomelabHls;
    }

    installHlsResilience();
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
      return {
        title: normalized(track.gstTitle === undefined ? track.label : track.gstTitle),
        language: aliases[language] || language,
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
    }

    function clear() {
      generation++;
      if (!active) return;
      if (active.releaseStream) active.releaseStream();
      active.abort.abort();
      active.externalAbort.abort();
      cancelPreparation(active);
      clearTimeout(active.probeTimeout);
      clearTimeout(active.externalTimeout);
      if (active.cancelRestore) active.cancelRestore();
      if (active.work.voiceovers === active.tracks) {
        if (active.previousTracks === undefined) delete active.work.voiceovers;
        else active.work.voiceovers = active.previousTracks;
      }
      active = null;
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
        if (error.name !== 'AbortError') console.warn('Homelab GST task:', error.message);
      }).finally(function () { clearTimeout(discoveryTimer); });
    }

    function preparePlayback(event) {
      installHlsResilience();
      var work = event.data;
      var original = masterUrl(work);
      if (!original) return;
      pausedWork = null;
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
        work.homelab_file_index = Number(source.searchParams.get('index'));
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
      if (!url || track === selectedTrack(state, url)) return cancelPreparation(state);
      if (track.external && !track.ready) return prepareExternal(state, track, automatic);
      cancelPreparation(state);
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
      var embedded = track.external ? carrierTrack(state, url) : track;
      if (track.external) {
        state.work.homelab_external_audio = {key: track.key, url: track.url, name: track.gstTitle, language: track.language};
      } else delete state.work.homelab_external_audio;
      // An external rendition reuses the running task unless the embedded
      // track would need transcoding that the stripped video never plays.
      if (Number(url.searchParams.get('audio') || 0) !== embedded.index) {
        url.searchParams.set('audio', String(embedded.index));
        if (state.work.homelab_torrent_hash) url.searchParams.set('uid', newSessionId());
      }
      state.work.url = url.href;
      state.tracks.forEach(function (item) { item.selected = item === track; });
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
      Lampa.PlayerPanel.setTracks(state.tracks);
    }

    function cancelPreparation(state) {
      if (!state.preparing) return;
      state.preparing.abort.abort();
      clearTimeout(state.preparing.timer);
      state.preparing = null;
    }

    // The sidecar remuxes the whole audio file before it can be played. Keep
    // the current audio playing meanwhile and switch once the rendition exists.
    function prepareExternal(state, track, automatic) {
      if (state.preparing && state.preparing.track === track) return;
      cancelPreparation(state);
      var preparing = state.preparing = {track: track, abort: new AbortController(), timer: null, deadline: Date.now() + 900000};
      if (!automatic && Lampa.Noty) Lampa.Noty.show('Готовлю озвучку: ' + track.label);
      function attempt() {
        if (state.preparing !== preparing) return;
        window.fetch(new URL(track.url, window.location.href).href, {signal: preparing.abort.signal, cache: 'no-store'}).then(function (response) {
          if (state.preparing !== preparing) return;
          if (response.ok) {
            state.preparing = null;
            track.ready = true;
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
          console.warn('Homelab external audio:', error.message);
          if (Lampa.Noty) Lampa.Noty.show('Не удалось подготовить озвучку: ' + track.label);
        });
      }
      attempt();
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
      var embedded = state.tracks.filter(function (track) { return !track.external; });
      var current = embedded.filter(function (track) { return track.index === index; })[0];
      if (current && current.aac) return current;
      return embedded.filter(function (track) { return track.aac; })[0] || current || {index: index};
    }

    function externalTracks(state, work) {
      if (!work.homelab_torrent_hash || !Number.isInteger(work.homelab_file_index)) return Promise.resolve([]);
      var base = '/extaudio/' + encodeURIComponent(work.homelab_torrent_hash) + '/';
      return window.fetch(new URL(base + work.homelab_file_index + '/tracks', window.location.href).href, {signal: state.externalAbort.signal})
        .then(function (response) {
          if (!response.ok) throw new Error('External audio lookup failed');
          return response.json();
        })
        .then(function (data) { return data.tracks || []; })
        .catch(function (error) {
          if (error.name === 'AbortError') throw error;
          console.warn('Homelab external audio:', error.message);
          return [];
        })
        .then(function (tracks) {
          return tracks.filter(function (track) {
            return Number.isInteger(track.file) && Number.isInteger(track.stream);
          }).map(function (track) {
            var path = base + track.file + '/' + track.stream + '/audio.m3u8';
            return {
              external: true, key: track.file + ':' + track.stream, url: path,
              language: track.language, gstTitle: track.title || '',
              label: (track.title || track.location || 'Audio') + ' (внешняя)',
              extra: {channels: track.channels}
            };
          });
        });
    }

    function installCurrent() {
      var work = Lampa.Player.playdata();
      var url = masterUrl(work);
      if (active && active.work === work && url) return;
      clear();
      if (!url || typeof window.fetch !== 'function' || typeof AbortController === 'undefined') return;
      var state = active = {work: work, abort: new AbortController(), externalAbort: new AbortController(), previousTracks: work.voiceovers};
      var stored = Lampa.Storage.get(preferenceKey, {});
      state.preferences = stored && stored[String(work.homelab_torrent_hash || work.torrent_hash)] || {};
      var revision = generation;
      var probe = new URL(url.href);
      probe.pathname = probe.pathname.replace(/(?:master|start)\.m3u8$/, 'probe');
      probe.searchParams.delete('audio');
      probe.searchParams.delete('seconds');
      state.probeTimeout = setTimeout(function () { state.abort.abort(); }, 90000);
      state.externalTimeout = setTimeout(function () { state.externalAbort.abort(); }, 30000);
      var embedded = window.fetch(probe.href, {signal: state.abort.signal}).then(function (response) {
        if (!response.ok) throw new Error('GStreamer track probe failed');
        return response.json();
      }).then(function (data) {
        var tracks = data.Tracks || (data.tracks || []).map(function (track) {
          return {Type: track.type, Index: track.index === undefined ? 0 : track.index, Title: track.title, Language: track.language, Channels: track.channels, IsAAC: track.isAAC};
        });
        return tracks.filter(function (track) {
          return track.Type === 'audio' && Number.isInteger(track.Index) && track.Index >= 0;
        }).map(function (track) {
          return {
            index: track.Index, language: track.Language, gstTitle: track.Title || '',
            label: track.Title || ('Audio ' + (track.Index + 1)),
            aac: Boolean(track.IsAAC), extra: {channels: track.Channels}
          };
        });
      });
      var lists = {embedded: null, external: []};
      // Embedded tracks are published first; slower external lookups are
      // merged when they arrive.
      function publish() {
        if (active !== state || generation !== revision || Lampa.Player.playdata() !== work || !lists.embedded) return;
        state.tracks = lists.embedded.concat(lists.external);
        if (state.tracks.length < 2) return;
        var current = selectedTrack(state, url);
        state.tracks.forEach(function (track) {
          track.selected = track === current;
          track.onSelect = function (item) {
            // Select invokes an item's own callback instead of the panel's
            // default handler, so restore the controller explicitly.
            try { selectTrack(state, item); }
            finally { Lampa.Controller.toggle('player'); }
          };
        });
        work.voiceovers = state.tracks;
        Lampa.PlayerPanel.setTracks(state.tracks);
        var preferred = matchingTrack(state.tracks, state.preferences.audio);
        if (preferred) selectTrack(state, preferred, true);
      }
      embedded.catch(function (error) {
        if (error.name === 'AbortError') throw error;
        console.warn('Homelab GST audio:', error.message);
        return [];
      }).then(function (list) {
        lists.embedded = list;
        publish();
      }).catch(function () {}).finally(function () { clearTimeout(state.probeTimeout); });
      externalTracks(state, work).then(function (list) {
        clearTimeout(state.externalTimeout);
        if (!list.length) return;
        lists.external = list;
        publish();
      }).catch(function () {});
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
    Lampa.PlayerVideo.listener.follow('pause', function () {
      var work = Lampa.Player.playdata();
      if (masterUrl(work)) pausedWork = work;
    });
    Lampa.PlayerVideo.listener.follow('play', function () {
      var video = Lampa.PlayerVideo.video();
      if (pausedWork === Lampa.Player.playdata() && video && !video.paused) pausedWork = null;
    });
    Lampa.Player.listener.follow('create', preparePlayback);
    Lampa.Player.listener.follow('ready', installCurrent);
    Lampa.Player.listener.follow('destroy', function () {
      pausedWork = null;
      clear();
    });
    Lampa.HomelabGstAudio = {installCurrent: installCurrent};
  }

  installGstAudio();
  if (Lampa.HomelabGstAudio) Lampa.HomelabGstAudio.installCurrent();
})();
