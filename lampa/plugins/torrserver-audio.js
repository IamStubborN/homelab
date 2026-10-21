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

    // hls.js 1.4 accepts these sample entries; the sidecar copies them only
    // when the browser can decode them, and encodes anything else to AAC.
    var COPY_CODECS = {aac: 'mp4a.40.2', opus: 'Opus', ac3: 'ac-3', eac3: 'ec-3'};
    var AUDIO_CODEC = /^(mp4a|ac-3|ec-3|opus|flac|mp3)/i;

    function forceEncode() {
      // Diagnostics only: localStorage.homelab_extaudio_encode = '1' sends every
      // external track through the live encoder.
      try { return window.localStorage.getItem('homelab_extaudio_encode') === '1'; } catch (error) { return false; }
    }

    function externalMode(codec) {
      if (forceEncode()) return 'aac';
      if (codec === 'aac') return 'copy';
      try {
        return COPY_CODECS[codec] && window.MediaSource &&
          window.MediaSource.isTypeSupported('audio/mp4; codecs="' + COPY_CODECS[codec] + '"') ? 'copy' : 'aac';
      } catch (error) { return 'aac'; }
    }

    function withExternalAudio(text, external) {
      var media = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="homelab-external",NAME="' + (hlsQuoted(external.name) || 'External') + '"' +
        (hlsQuoted(external.language) ? ',LANGUAGE="' + hlsQuoted(external.language) + '"' : '') +
        ',DEFAULT=YES,AUTOSELECT=YES,URI="' + external.url + '"';
      var inserted = false;
      return String(text).split(/\r?\n/).map(function (line) {
        if (line.indexOf('#EXT-X-STREAM-INF:') !== 0) return line;
        line = line.replace(/,AUDIO="[^"]*"/, '').replace(/:AUDIO="[^"]*",?/, ':') + ',AUDIO="homelab-external"';
        // The audio SourceBuffer is created from CODECS, not from the init segment.
        line = line.replace(/CODECS="([^"]*)"/, function (all, list) {
          return 'CODECS="' + list.split(',').map(function (codec) { return codec.trim(); }).filter(function (codec) {
            return codec && !AUDIO_CODEC.test(codec);
          }).concat(external.codecs || COPY_CODECS.aac).join(',') + '"';
        });
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

    // ASS signs drawn with vector shapes ({\p1}m 345 192 b ...) lose their
    // tags in Lampac's WebVTT and would show up as rows of coordinates.
    var DRAWING = /^\s*(?:[mnlbspc]\s+)*-?\d+(?:\.\d+)?(?:\s+(?:[mnlbspc]|-?\d+(?:\.\d+)?))+\s*$/i;

    function isDrawing(line) {
      // A countdown ("3 2 1 0") has numbers but no move/line/curve command.
      return DRAWING.test(line) && /(?:^|\s)[mlb](?:\s|$)/i.test(line) && (line.match(/-?\d+(?:\.\d+)?/g) || []).length >= 4;
    }

    function withoutDrawings(text) {
      return text.split(/\r?\n\r?\n/).filter(function (block) {
        var lines = block.split(/\r?\n/);
        var timing = lines.findIndex(function (line) { return line.indexOf('-->') !== -1; });
        if (timing === -1) return true;
        var payload = lines.slice(timing + 1).filter(function (line) { return line.trim(); });
        return !payload.length || !payload.every(isDrawing);
      }).map(function (block) {
        var lines = block.split(/\r?\n/);
        var timing = lines.findIndex(function (line) { return line.indexOf('-->') !== -1; });
        return timing === -1 ? block : lines.filter(function (line, index) { return index <= timing || !isDrawing(line); }).join('\n');
      }).join('\n\n');
    }

    function subtitleLoader(BaseLoader) {
      return transformingLoader(BaseLoader, function (context, response) {
        var frag = context.frag;
        if (!frag || frag.type !== 'subtitle' || typeof TextDecoder === 'undefined') return response;
        try {
          var text = typeof response.data === 'string' ? response.data : new TextDecoder('utf-8').decode(response.data);
          if (!/\d+\s+-?\d+\s+[lb]\s/i.test(text)) return response;
          var cleaned = withoutDrawings(text);
          return Object.assign({}, response, {data: typeof response.data === 'string' ? cleaned : new TextEncoder().encode(cleaned).buffer});
        } catch (error) { return response; }
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
        config.fLoader = subtitleLoader(config.fLoader || config.loader || BaseHls.DefaultConfig.loader);
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
        var abandoned = false;
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
          if (!disposed && !terminated && data.response && /^Homelab audio:/.test(data.response.text || '')) {
            // A loader transform failed; retrying the same bytes cannot help.
            handled.add(data);
            if (!abandoned && !embeddedFallback(work)) {
              finishFailure();
              hls.trigger(BaseHls.Events.ERROR, Object.assign({}, data, {fatal: true}));
            } else if (!abandoned) {
              abandoned = true;
              hls.stopLoad();
              setTimeout(function () { if (!disposed) abandonExternal(work); }, 0);
            }
            return true;
          }
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
      hideAss(active);
      // The panel may keep this list into the next episode.
      if (active.subtitleList) {
        active.assItems = [];
        active.embedded = null;
        withAss(active, active.subtitleList);
      }
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
      if (track.external && track.unsupported && automatic) return;
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

    // Encoded renditions start at the playback position, so tell the sidecar
    // where playback is. Copied renditions are whole files.
    function externalUrl(track, time) {
      if (!track.live) return track.url;
      if (time === undefined) time = Number(Lampa.PlayerVideo.video().currentTime) || 0;
      return track.url + '?at=' + Math.floor(time);
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
      // The sidecar sizes its own deadline to the file; this only bounds polling.
      var preparing = state.preparing = {track: track, abort: new AbortController(), timer: null, deadline: Date.now() + 14400000};
      if (!automatic && Lampa.Noty) Lampa.Noty.show('Готовлю озвучку: ' + track.label);
      function attempt() {
        if (state.preparing !== preparing) return;
        window.fetch(new URL(externalUrl(track), window.location.href).href, {signal: preparing.abort.signal, cache: 'no-store'}).then(function (response) {
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

    function embeddedFallback(work) {
      var state = active;
      var url = state && state.work === work && work.homelab_external_audio && masterUrl(work);
      var carrier = url && carrierTrack(state, url);
      return carrier && state.tracks.indexOf(carrier) !== -1 ? carrier : null;
    }

    function abandonExternal(work) {
      var carrier = embeddedFallback(work);
      if (!carrier) return;
      var failed = selectedTrack(active, masterUrl(work));
      if (failed) failed.unsupported = true;
      console.warn('Homelab external audio: unsupported fragment layout');
      if (Lampa.Noty) Lampa.Noty.show('Внешняя озвучка не поддерживается для этого видео');
      selectTrack(active, carrier, true);
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

    var assModule = null;
    var assImport;
    var lastSubtitles = null;

    function assSupported() {
      if (window.HomelabJassub) return true;
      if (assImport === undefined) {
        // A Function keeps engines without dynamic import able to parse the plugin.
        try { assImport = new Function('url', 'return import(url)'); } catch (error) { assImport = null; }
      }
      return Boolean(assImport && typeof TextDecoder !== 'undefined' && typeof Worker !== 'undefined' &&
        typeof WebAssembly === 'object' && window.HTMLCanvasElement &&
        typeof window.HTMLCanvasElement.prototype.transferControlToOffscreen === 'function');
    }

    function loadAssRenderer(base) {
      if (window.HomelabJassub) return Promise.resolve(window.HomelabJassub);
      if (!assModule) {
        assModule = Promise.resolve().then(function () { return assImport(base + 'jassub.js'); }).then(function (module) {
          return module.default;
        }, function (error) { assModule = null; throw error; });
      }
      return assModule;
    }

    function decodeSubtitle(buffer) {
      var bytes = new Uint8Array(buffer);
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
      // Russian releases without a BOM are often still Windows-1251.
      try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
      catch (error) { return new TextDecoder('windows-1251').decode(bytes); }
    }

    function fetchBytes(url, cancelled, attempts) {
      return window.fetch(url).then(function (response) {
        // The sidecar answers 503 while its download slots are busy.
        if ((response.status === 503 || response.status === 429) && attempts > 1 && !cancelled()) {
          var delay = Math.min(10, Number(response.headers && response.headers.get('Retry-After')) || 2) * 1000;
          return new Promise(function (resolve) { setTimeout(resolve, delay); }).then(function () {
            if (cancelled()) throw new Error('cancelled');
            return fetchBytes(url, cancelled, attempts - 1);
          });
        }
        if (!response.ok) throw new Error('download failed: ' + response.status);
        return response.arrayBuffer();
      });
    }

    function fetchFonts(urls, cancelled) {
      // JASSUB would request every font at once and never retry; two at a
      // time with retries gets them all. A font that still fails falls back.
      var fonts = [];
      var next = 0;
      function worker() {
        if (next >= urls.length || cancelled()) return Promise.resolve();
        var url = urls[next++];
        return fetchBytes(url, cancelled, 5).then(function (buffer) {
          fonts.push(new Uint8Array(buffer));
        }, function (error) {
          if (!cancelled()) console.warn('Homelab ASS font:', url, error && error.message);
        }).then(worker);
      }
      // A stalled torrent must not hold the subtitles back for minutes.
      var timer;
      var deadline = new Promise(function (resolve) { timer = setTimeout(resolve, 30000); });
      return Promise.race([Promise.all([worker(), worker()]), deadline]).then(function () {
        clearTimeout(timer);
        return fonts.slice();
      });
    }

    // JASSUB draws on new video frames only; a paused one is drawn on request.
    function redrawFrame(instance, video) {
      return instance.manualRender({mediaTime: video.currentTime, width: video.videoWidth, height: video.videoHeight});
    }

    function hideAss(state) {
      state.assActive = null;
      state.assRequest = (state.assRequest || 0) + 1;
      if (state.assStop) state.assStop();
      state.assStop = null;
      if (state.assSeeked) state.assSeeked();
      state.assSeeked = null;
      if (!state.assInstance) return;
      try { state.assInstance.destroy(); } catch (error) {}
      state.assInstance = null;
    }

    function showAss(state, item) {
      var video = Lampa.PlayerVideo.video();
      if (state.assActive === item && state.assVideo === video) return;
      hideAss(state);
      state.assActive = item;
      state.assVideo = video;
      var request = state.assRequest;
      function cancelled() { return active !== state || state.assRequest !== request; }
      var base = new URL(state.assRenderer, window.location.href).href;
      function seeked() {
        var instance = state.assInstance;
        if (!instance || !video.paused) return;
        instance.ready.then(function () {
          if (state.assInstance === instance) return redrawFrame(instance, video);
        }).catch(function () {});
      }
      // A paused seek does not always report its frame to JASSUB.
      video.addEventListener('seeked', seeked);
      state.assSeeked = function () { video.removeEventListener('seeked', seeked); };
      if (item.homelabAss.events) return showEmbeddedAss(state, item, video, base, cancelled);
      var content = fetchBytes(new URL(item.homelabAss.url, window.location.href).href, cancelled, 5);
      Promise.all([loadAssRenderer(base), content, fetchFonts(item.homelabAss.fonts, cancelled), fontLibrary(base)]).then(function (results) {
        if (cancelled()) return;
        var Renderer = results[0];
        state.assInstance = new Renderer(rendererOptions(base, video, decodeSubtitle(results[1]), results[2], results[3]));
      }).catch(function (error) {
        if (active !== state || state.assRequest !== request) return;
        console.warn('Homelab ASS:', error && error.message);
        hideAss(state);
        Lampa.Noty.show('Не удалось показать ASS-субтитры');
      });
    }

    // Windows fonts subtitles often name without attaching them, and the
    // metric-compatible fonts the sidecar serves instead: the same widths keep
    // signs inside the boxes they were typeset for.
    var FONT_STAND_INS = {
      'comic sans ms': ['Comic Relief', 'comic-relief'], 'times new roman': ['Tinos', 'tinos'],
      'courier new': ['Cousine', 'cousine'], 'calibri': ['Carlito', 'carlito']
    };

    // Family names from a font's name table (the first font of a collection).
    function fontFamilies(bytes) {
      var names = [];
      try {
        var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var start = view.getUint32(0) === 0x74746366 ? view.getUint32(12) : 0; // 'ttcf'
        for (var i = 0; i < view.getUint16(start + 4); i++) {
          var record = start + 12 + i * 16;
          if (view.getUint32(record) !== 0x6e616d65) continue; // 'name'
          var table = view.getUint32(record + 8);
          var strings = table + view.getUint16(table + 4);
          for (var j = 0; j < view.getUint16(table + 2); j++) {
            var entry = table + 6 + j * 12;
            var id = view.getUint16(entry + 6);
            if (id !== 1 && id !== 16) continue;
            var wide = view.getUint16(entry) !== 1; // Unicode and Windows names are UTF-16BE
            var length = view.getUint16(entry + 8);
            var offset = strings + view.getUint16(entry + 10);
            var text = '';
            for (var k = 0; k < length; k += wide ? 2 : 1) {
              text += String.fromCharCode(wide ? view.getUint16(offset + k) : view.getUint8(offset + k));
            }
            names.push(text.trim().toLowerCase());
          }
        }
      } catch (error) {}
      return names;
    }

    // Fonts the sidecar kept from other releases; a release that names a font
    // without attaching it often finds it there.
    var libraryIndex = null;
    var libraryLoaded = 0;

    function fontLibrary(base) {
      if (!libraryIndex || Date.now() - libraryLoaded > 600000) {
        libraryLoaded = Date.now();
        var timer;
        // A slow sidecar must not hold the subtitles back.
        var timeout = new Promise(function (resolve, reject) {
          timer = setTimeout(function () { reject(new Error('font library: timeout')); }, 5000);
        });
        libraryIndex = Promise.race([window.fetch(new URL('../fonts/index.json', base).href), timeout]).then(function (response) {
          clearTimeout(timer);
          if (!response.ok) throw new Error('font library: HTTP ' + response.status);
          return response.json();
        }).then(function (index) {
          return {base: new URL('../fonts/', base).href, fonts: (index && index.fonts) || {}, families: (index && index.families) || {}};
        }).catch(function (error) {
          clearTimeout(timer);
          libraryIndex = null;
          console.warn('Homelab ASS fonts:', error && error.message);
          return {fonts: {}, families: {}};
        });
      }
      return libraryIndex;
    }

    function attachedFamilies(fonts) {
      var families = {};
      fonts.forEach(function (font) {
        if (typeof font !== 'string') fontFamilies(font).forEach(function (name) { families[name] = true; });
      });
      return families;
    }

    // Families drawn with their own font: attached ones, then library ones.
    function keptFamilies(attached, library) {
      var families = {};
      Object.keys(attached).concat(Object.keys(library.families)).forEach(function (name) { families[name] = true; });
      return families;
    }

    // Library files for the families `text` names that the release does not
    // attach. They load up front: JASSUB's own lookup by name and weight
    // misses names like "Roboto Light", and libass drops events without a font.
    function libraryFiles(text, library, attached, loaded) {
      var urls = [];
      function add(match, font) {
        var family = font.trim().toLowerCase();
        if (attached[family]) return match;
        (library.families[family] || []).forEach(function (file) {
          var url = library.base + file;
          if (!loaded[url]) { loaded[url] = true; urls.push(url); }
        });
        return match;
      }
      text.replace(/^Style:[^,]*,\s*([^,\r\n]*)/gm, add).replace(/\\fn([^\\}]*)/g, add);
      return urls;
    }

    function standInFonts(text, kept) {
      function rename(font) {
        // A font the release attaches is the one it was typeset with.
        if (kept[font.trim().toLowerCase()]) return font;
        var standIn = FONT_STAND_INS[font.trim().toLowerCase()];
        return standIn ? standIn[0] : font;
      }
      return text.replace(/^(Style:[^,]*,)([^,\r\n]*)/gm, function (match, head, font) {
        return head + rename(font);
      }).replace(/\\fn([^\\}]*)/g, function (match, font) {
        return '\\fn' + rename(font);
      });
    }

    function rendererOptions(base, video, content, fonts, library, loaded) {
      var attached = attachedFamilies(fonts);
      var urls = libraryFiles(content, library, attached, loaded || {});
      content = standInFonts(content, keptFamilies(attached, library));
      // The fallback and the fonts the styles use load up front: JASSUB
      // fetches the rest on demand, and libass skips an event without a font
      // (even a drawn mask) in the frames drawn meanwhile.
      fonts = fonts.concat(base + 'default.woff2', urls);
      Object.keys(FONT_STAND_INS).forEach(function (name) {
        var standIn = FONT_STAND_INS[name];
        if (new RegExp('^Style:[^,]*,\\s*' + standIn[0] + '\\s*,', 'im').test(content)) {
          fonts.push(base + standIn[1] + '-regular.ttf', base + standIn[1] + '-bold.ttf');
        }
      });
      var available = {'liberation sans': base + 'default.woff2'};
      Object.keys(library.fonts).forEach(function (key) { available[key] = library.base + library.fonts[key]; });
      Object.keys(FONT_STAND_INS).forEach(function (name) {
        var standIn = FONT_STAND_INS[name];
        // JASSUB fetches one only when libass asks for it by name and weight.
        available[standIn[0].toLowerCase()] = base + standIn[1] + '-regular.ttf';
        available[standIn[0].toLowerCase() + ' bold'] = base + standIn[1] + '-bold.ttf';
      });
      return {
        video: video, subContent: content, fonts: fonts,
        workerUrl: base + 'jassub-worker.js', wasmUrl: base + 'jassub-worker.wasm',
        modernWasmUrl: base + 'jassub-worker-modern.wasm',
        availableFonts: available
      };
    }

    function showEmbeddedAss(state, item, video, base, cancelled) {
      // The sidecar reads the stream from the playback position as it plays;
      // each poll reports where playback is and brings the events read since.
      var url = new URL(item.homelabAss.events, window.location.href);
      var fonts = fetchFonts(item.homelabAss.fonts, cancelled);
      var offset = 0;
      var track = null;
      var seen = new Set();
      var busy = false;
      var again = false;
      var queue = [];
      var renderer = null;
      var kept = {};
      var attached = {};
      var library = null;
      var loaded = {};
      var errors = 0;
      var timer = null;
      function fail(error) {
        if (cancelled()) return;
        console.warn('Homelab embedded ASS:', error && error.message);
        hideAss(state);
        fallBackToText(state, item);
      }
      function deliver() {
        if (!renderer || !queue.length || cancelled()) return;
        var lines = queue.splice(0, queue.length);
        renderer.then(function (instance) {
          if (cancelled()) return;
          var text = lines.join('\n');
          var urls = libraryFiles(text, library, attached, loaded);
          return Promise.resolve(urls.length && instance.renderer.addFonts(urls)).then(function () {
            return instance.renderer.processData(standInFonts(text, kept));
          }).then(function () {
            // A paused frame would keep missing the events that arrived after it.
            if (video.paused && !cancelled()) return redrawFrame(instance, video);
          });
        }).catch(fail);
      }
      function schedule(delay) {
        clearTimeout(timer);
        timer = setTimeout(poll, delay);
      }
      function poll() {
        clearTimeout(timer);
        if (cancelled()) return;
        // One request at a time: a seek during a request asks again after it.
        if (busy) { again = true; return; }
        busy = true;
        again = false;
        url.searchParams.set('at', Math.max(0, Number(video.currentTime) || 0).toFixed(1));
        url.searchParams.set('from', String(offset));
        if (track !== null) url.searchParams.set('track', String(track));
        window.fetch(url.href, {cache: 'no-store'}).then(function (response) {
          if (!response.ok) throw new Error('events: HTTP ' + response.status);
          return response.json();
        }).then(function (data) {
          if (cancelled()) return;
          busy = false;
          if (data.failed) return fail(new Error('the sidecar could not read the subtitles'));
          errors = 0;
          // A restarted sidecar numbers its events anew; seen ones are skipped.
          track = data.track;
          offset = data.next;
          (data.lines || []).forEach(function (line) {
            // Overlapping windows and a forgotten track resend events.
            if (!seen.has(line)) { seen.add(line); queue.push(line); }
          });
          if (!renderer && data.header) {
            renderer = Promise.all([loadAssRenderer(base), fonts, fontLibrary(base)]).then(function (results) {
              if (cancelled()) throw new Error('cancelled');
              var Renderer = results[0];
              attached = attachedFamilies(results[1]);
              library = results[2];
              kept = keptFamilies(attached, library);
              state.assInstance = new Renderer(rendererOptions(base, video, data.header, results[1], library, loaded));
              var instance = state.assInstance;
              return instance.ready.then(function () { return instance; });
            });
            renderer.catch(fail);
          }
          deliver();
          schedule(data.more || again ? 0 : 3000);
        }).catch(function (error) {
          busy = false;
          if (cancelled()) return;
          if (++errors >= 5) return fail(error);
          schedule(3000);
        });
      }
      function seeking() {
        // Ask for the new position at once instead of at the next poll.
        if (busy) again = true;
        else schedule(300);
      }
      video.addEventListener('seeking', seeking);
      state.assStop = function () {
        clearTimeout(timer);
        video.removeEventListener('seeking', seeking);
      };
      poll();
    }

    function fallBackToText(state, item) {
      state.embeddedBroken[item.homelabAss.stream] = true;
      if (state.subtitleList) withAss(state, state.subtitleList);
      Lampa.Noty.show('ASS-субтитры недоступны, показан простой текст');
      var original = item.homelabOriginal;
      if (!original || active !== state) return;
      original.selected = true;
      original.mode = 'showing';
      Lampa.PlayerVideo.subsview(true);
      // The menu's choice is remembered from this list.
      if (state.subtitles) state.subtitles = state.subtitles.map(function (sub) { return sub === item ? original : sub; });
    }

    function defineMode(state, item) {
      // Lampa's menu switches subtitles through `mode`, like hls.js tracks.
      Object.defineProperty(item, 'mode', {
        enumerable: true,
        get: function () { return state.assActive === item ? 'showing' : 'disabled'; },
        set: function (value) {
          if (value === 'showing') {
            // The replaced hls.js track must not draw its plain text too.
            if (item.homelabOriginal && item.homelabOriginal.mode === 'showing') item.homelabOriginal.mode = 'disabled';
            showAss(state, item);
          } else if (state.assActive === item) hideAss(state);
        }
      });
      return item;
    }

    var TEXT_CODECS = {ass: true, ssa: true, subrip: true, text: true};

    function embeddedItems(state) {
      var originals = state.hlsSubs || [];
      var data = state.embedded;
      // hls.js lists GST's text subtitles in file order; JASSUB draws them
      // instead when the sidecar's probe lines up with them (SRT converted).
      if (!data || data.subtitles.length !== originals.length) return originals;
      var aligned = data.subtitles.every(function (sub, i) {
        return !sub.title || String(originals[i].label || '').trim() === sub.title;
      });
      if (!aligned) return originals;
      var base = '/extaudio/' + encodeURIComponent(state.work.homelab_torrent_hash) + '/' + state.work.homelab_file_index + '/';
      return originals.map(function (original, i) {
        var sub = data.subtitles[i];
        if (!TEXT_CODECS[sub.codec] || !Number.isInteger(sub.stream) || state.embeddedBroken[sub.stream]) return original;
        if (original.homelabAss) return original;
        var item = state.embeddedProxies[sub.stream];
        if (!item) {
          item = state.embeddedProxies[sub.stream] = defineMode(state, {
            homelabAss: {
              stream: sub.stream, events: base + 'sub/' + sub.stream,
              fonts: (data.fonts || []).filter(Number.isInteger).map(function (id) {
                return new URL(base + 'attachment/' + id, window.location.href).href;
              })
            }
          });
        }
        // A reload brings new hls.js tracks; the item stays the same.
        item.index = original.index;
        item.label = original.label;
        item.selected = original.selected;
        item.homelabOriginal = original;
        return item;
      });
    }

    function assItems(state, data) {
      var base = '/extaudio/' + encodeURIComponent(state.work.homelab_torrent_hash) + '/';
      return (data.subtitles || []).filter(function (sub) { return Number.isInteger(sub.file); }).map(function (sub, number) {
        return defineMode(state, {
          index: 1000 + number, label: (sub.title || 'ASS') + ' (ASS)', language: sub.language || '', external: true,
          homelabAss: {
            url: base + sub.file + '/raw',
            fonts: (sub.fonts || []).filter(Number.isInteger).map(function (id) {
              return new URL(base + id + '/raw', window.location.href).href;
            })
          }
        });
      });
    }

    function withAss(state, list) {
      if (!state.hlsSubs) state.hlsSubs = list.filter(function (item) { return !item.homelabAss; });
      var items = embeddedItems(state);
      list.splice.apply(list, [0, list.length].concat(items, state.assItems || []));
      // A plain-text track already showing switches to its drawn version.
      items.forEach(function (item) {
        if (item.homelabOriginal && item.homelabOriginal.mode === 'showing') item.mode = 'showing';
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
      if (!subtitles.length) return;
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
          if (selected.mode !== 'showing') selected.mode = 'showing';
        }
        Lampa.PlayerVideo.subsview(Boolean(selected));
        delete state.restoreSubtitle;
      }
    }

    function adoptSubtitles(state) {
      if (state.subtitleList || !lastSubtitles || lastSubtitles.work !== state.work) return;
      state.subtitleList = lastSubtitles.list;
      state.hlsSubs = lastSubtitles.originals;
    }

    function embeddedSubtitles(state, work, revision) {
      if (!work.homelab_torrent_hash || !Number.isInteger(work.homelab_file_index) || !assSupported()) return;
      var url = new URL('/extaudio/' + encodeURIComponent(work.homelab_torrent_hash) + '/' + work.homelab_file_index + '/embedded', window.location.href);
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
        if (error.name !== 'AbortError') console.warn('Homelab embedded ASS:', error.message);
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

    function externalTracks(state, work) {
      if (!work.homelab_torrent_hash || !Number.isInteger(work.homelab_file_index)) return Promise.resolve([]);
      var base = '/extaudio/' + encodeURIComponent(work.homelab_torrent_hash) + '/';
      var signal = state.externalAbort.signal;
      function lookup(retry) {
        return window.fetch(new URL(base + work.homelab_file_index + '/tracks', window.location.href).href, {signal: signal})
          .then(function (response) {
            // The sidecar limits concurrent lookups; ask once more before giving up.
            if (response.status === 429 && retry) return new Promise(function (resolve, reject) {
              var timer = setTimeout(function () { resolve(lookup(false)); }, 5000);
              signal.addEventListener('abort', function () {
                clearTimeout(timer);
                var error = new Error('The operation was aborted');
                error.name = 'AbortError';
                reject(error);
              }, {once: true});
            });
            if (!response.ok) throw new Error('External audio lookup failed');
            return response.json();
          });
      }
      return lookup(true)
        .then(function (data) {
          state.externalData = data;
          return data.tracks || [];
        })
        .catch(function (error) {
          if (error.name === 'AbortError') throw error;
          console.warn('Homelab external audio:', error.message);
          return [];
        })
        .then(function (tracks) {
          return tracks.filter(function (track) {
            return Number.isInteger(track.file) && Number.isInteger(track.stream);
          }).map(function (track) {
            var mode = externalMode(track.codec);
            return {
              external: true, key: track.file + ':' + track.stream,
              url: base + track.file + '/' + track.stream + '/' + mode + '/audio.m3u8',
              codecs: mode === 'copy' ? COPY_CODECS[track.codec] : COPY_CODECS.aac, live: mode === 'aac',
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
      var state = active = {
        work: work, abort: new AbortController(), externalAbort: new AbortController(), previousTracks: work.voiceovers,
        embeddedProxies: {}, embeddedBroken: {}
      };
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
        // GST has opened the file by now, so TorrServer knows the torrent.
        if (active === state && generation === revision) embeddedSubtitles(state, work, revision);
      }).catch(function () {}).finally(function () { clearTimeout(state.probeTimeout); });
      externalTracks(state, work).then(function (list) {
        clearTimeout(state.externalTimeout);
        if (active === state && generation === revision) installAss(state, state.externalData);
        if (!list.length) return;
        lists.external = list;
        publish();
      }).catch(function () {});
      ownStream(state, url);
    }

    Lampa.PlayerVideo.listener.follow('subs', function (event) {
      if (!Array.isArray(event.subs)) return;
      // Lampa may send back the list it keeps, with drawn items already in it.
      lastSubtitles = {work: Lampa.Player.playdata(), list: event.subs, originals: event.subs.map(function (sub) {
        return sub.homelabOriginal || sub;
      }).filter(function (sub) { return !sub.homelabAss; })};
      if (!active || Lampa.Player.playdata() !== active.work) return;
      // The panel keeps this same array, so drawn items join or replace in its menu.
      active.hlsSubs = lastSubtitles.originals;
      active.subtitleList = withAss(active, event.subs);
      // A reload (audio switch) may bring a new video element.
      var showing = active.assActive;
      if (showing && active.assVideo !== Lampa.PlayerVideo.video()) showAss(active, showing);
      applySubtitles(active, event.subs);
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
