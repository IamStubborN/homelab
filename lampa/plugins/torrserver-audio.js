// Isolated browser playback and track preferences for Lampac GStreamer.
(function () {
  'use strict';

  function installGstAudio() {
    if (Lampa.HomelabGstAudio || !Lampa.Player || !Lampa.PlayerVideo || !Lampa.PlayerPanel) return;
    var active = null;
    var pausedWork = null;
    var generation = 0;
    var preferenceKey = 'homelab_gst_track_preferences';

    // Playback events for `docker logs lampa-extaudio`: a page session, the
    // torrent hash prefix, the file and the position, never a URL's query.
    // Repeats within a few seconds and bursts are counted, not sent, and a
    // failed report never reaches playback.
    var LOG_REPEAT_MS = 5000;
    var LOG_PER_MINUTE = 30;
    var NOTABLE_HLS = /Load(Error|TimeOut)$|^buffer(Stalled|Append|Full)Error$|ParsingError$/;
    var logSession = Math.random().toString(36).slice(2, 10);
    var logRecent = {};
    var logWindow = 0;
    var logCount = 0;
    var logDropped = 0;

    // A full torrent hash shortens to the prefix every event carries.
    function shortHashes(text) {
      return text.replace(/[0-9a-f]{40}/gi, function (hash) { return hash.slice(0, 8); });
    }

    function logText(value) {
      // A message may quote a URL whose query carries a token.
      return shortHashes(String(value).replace(/\?\S*/g, '')).slice(0, 160);
    }

    function logPath(url) {
      if (!url) return null;
      try { return shortHashes(new URL(url, window.location.href).pathname).slice(0, 160); } catch (error) { return null; }
    }

    function report(name, fields, work) {
      try {
        if (typeof window.fetch !== 'function') return;
        var event = {e: name};
        Object.keys(fields || {}).forEach(function (key) {
          var value = fields[key];
          if (value === undefined || value === null || value === '') return;
          event[key] = typeof value === 'number' || typeof value === 'boolean' ? value : logText(value);
        });
        work = work || (active && active.work) || Lampa.Player.playdata();
        var hash = work && (work.homelab_torrent_hash || work.torrent_hash);
        if (hash) event.h = String(hash).slice(0, 8);
        if (work && Number.isInteger(work.homelab_file_index)) event.f = work.homelab_file_index;
        var key = JSON.stringify(event);
        var now = Date.now();
        if (now - logWindow >= 60000) {
          logWindow = now;
          logCount = 0;
          Object.keys(logRecent).forEach(function (old) { if (now - logRecent[old] >= LOG_REPEAT_MS) delete logRecent[old]; });
        }
        if (now - (logRecent[key] || -Infinity) < LOG_REPEAT_MS || logCount >= LOG_PER_MINUTE) { logDropped++; return; }
        logCount++;
        logRecent[key] = now;
        var video = Lampa.PlayerVideo.video();
        if (video && isFinite(video.currentTime)) event.t = Math.round(video.currentTime * 10) / 10;
        event.s = logSession;
        if (logDropped) { event.dropped = logDropped; logDropped = 0; }
        window.fetch(new URL('/extaudio/log', window.location.href).href, {
          method: 'POST', body: JSON.stringify(event), keepalive: true, credentials: 'omit',
          headers: {'Content-Type': 'application/json'}
        }).catch(function () {});
      } catch (error) {}
    }

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

    // The sidecar encodes external audio to AAC from the playback position.
    var EXTERNAL_CODECS = 'mp4a.40.2';
    var AUDIO_CODEC = /^(mp4a|ac-3|ec-3|opus|flac|mp3)/i;

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
          }).concat(external.codecs || EXTERNAL_CODECS).join(',') + '"';
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
        // A torrent at the edge of its bitrate can take longer than 30 s to
        // fetch the pieces of one segment; waiting beats asking again.
        config.fragLoadPolicy = policy(60000, 180000, 3);
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
          if (data.fatal || NOTABLE_HLS.test(data.details || '')) {
            var frag = data.frag || {};
            report('hls-error', {
              type: data.type, details: data.details, fatal: Boolean(data.fatal),
              status: data.response && (data.response.code || data.response.status), frag: frag.type, sn: frag.sn,
              path: logPath(data.url || frag.url || (data.context && data.context.url)),
              reason: data.reason || (data.error && data.error.message) || (data.response && data.response.text)
            }, work);
          }
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
          report('hls-recovery', {details: data.details, status: status, attempt: retries, reload: reload}, work);
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
    }

    function clear() {
      generation++;
      if (!active) return;
      hideAss(active, 'clear');
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
      clearTimeout(active.externalRetry);
      if (active.cancelRestore) active.cancelRestore();
      if (active.work.voiceovers === active.tracks) {
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
      var original = masterUrl(work);
      if (!original) return;
      pausedWork = null;
      // A torrent card's ffprobe describes one file of the release, often an
      // external audio file, and Lampa would label the GST tracks with it.
      delete work.ffprobe;
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

    // Renditions are encoded from the playback position, so tell the sidecar
    // where playback is.
    function externalUrl(track, time) {
      if (time === undefined) time = Number(Lampa.PlayerVideo.video().currentTime) || 0;
      return track.url + '?at=' + Math.floor(time);
    }

    function cancelPreparation(state) {
      if (!state.preparing) return;
      state.preparing.abort.abort();
      clearTimeout(state.preparing.timer);
      state.preparing = null;
    }

    // Keep the current audio playing until the sidecar has the rendition's
    // playlist, then switch to it.
    function prepareExternal(state, track, automatic) {
      if (state.preparing && state.preparing.track === track) return;
      cancelPreparation(state);
      var preparing = state.preparing = {track: track, abort: new AbortController(), timer: null, deadline: Date.now() + 120000};
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
          report('audio-external-failed', {track: track.label, reason: error.message}, state.work);
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
      report('audio-external-fallback', {track: failed && failed.label, to: carrier.label, reason: 'unsupported fragment layout'}, work);
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
      var embedded = (state.tracks || []).filter(function (track) { return !track.external; });
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

    // Lampa's subtitle delay; JASSUB draws at mediaTime + timeOffset.
    function subtitleOffset() {
      return -(parseInt(Lampa.Storage.get('player_subs_shift_time', '0'), 10) || 0);
    }

    function enabled(name, fallback) {
      var value = Lampa.Storage.field(name);
      return value === undefined || value === null ? fallback : value === true || value === 'true';
    }

    // Converted SRT has no style of its own: it follows Lampa's subtitle
    // settings (sizes at the sidecar's PlayResY 288).
    function textStyle(header) {
      var size = {small: 14, normal: 17, large: 21}[Lampa.Storage.field('subtitles_size')] || 17;
      var backdrop = enabled('subtitles_backdrop', false);
      var stroke = enabled('subtitles_stroke', true);
      return header.replace(/^Style: Default,.*$/m, 'Style: Default,Arial,' + size + ',&H00FFFFFF,&H000000FF,' +
        (backdrop ? '&H60000000' : '&H00000000') + ',&H80000000,0,0,0,0,100,100,0,0,' +
        (backdrop ? '3,1.5,0' : stroke ? '1,0.9,0.4' : '1,0,0') + ',2,20,20,14,1');
    }

    // JASSUB draws on new video frames only; a paused one is drawn on request.
    function redrawFrame(instance, video) {
      return instance.manualRender({mediaTime: video.currentTime, width: video.videoWidth, height: video.videoHeight});
    }

    function hideAss(state, why) {
      if (state.assActive || state.assInstance) {
        report('ass-destroy', {why: why, track: state.assActive && state.assActive.label, renderer: Boolean(state.assInstance)}, state.work);
      }
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

    // Why a drawn track is shown: Lampa or its menu set the mode, a remembered
    // choice, a plain-text track switching to its drawn version, a new video.
    var assWhy = null;

    function showWith(item, why) {
      assWhy = why;
      try { item.mode = 'showing'; } finally { assWhy = null; }
    }

    function showAss(state, item, why) {
      var video = Lampa.PlayerVideo.video();
      if (state.assActive === item && state.assVideo === video) return;
      var created = {
        why: why, track: item.label, embedded: Boolean(item.homelabAss.events),
        same: state.assActive === item, newVideo: Boolean(state.assVideo) && state.assVideo !== video
      };
      hideAss(state, created.newVideo ? 'new-video' : 'replace');
      report('ass-create', created, state.work);
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
        var text = decodeSubtitle(results[1]);
        if (item.homelabAss.signs) {
          text = signsOnly(text);
          if (!/^Dialogue:/im.test(text)) Lampa.Noty.show('В этих субтитрах надписи не отделены от реплик');
        }
        state.assInstance = new Renderer(rendererOptions(base, video, text, results[2], results[3]));
        seeked(); // a paused video shows no new frame to draw on
      }).catch(function (error) {
        if (active !== state || state.assRequest !== request) return;
        console.warn('Homelab ASS:', error && error.message);
        report('ass-failed', {track: item.label, reason: error && error.message}, state.work);
        hideAss(state, 'failed');
        updateSignsToggle();
        Lampa.Noty.show('Не удалось показать ASS-субтитры');
      });
    }

    // Releases name the styles of on-screen text: "Sign 3", "Title",
    // "Надпись серии", a translator's "Примечание". Dialogue styles are
    // named after speakers or "Text", "Default".
    // Word starts only: "Subtitles" and "Design" are dialogue styles.
    // Captions and interface messages (game windows, system notices) are on-screen text too.
    var SIGN_STYLE = /(^|[\s_\-])(sign|title|note|caption|interface)|надпис|тайтл|примеч|интерфейс/i;

    function signsOnly(text) {
      var style = 3; // the V4+ column order, until a Format line says otherwise
      var height = 288; // libass's frame height when the script names none
      return text.split(/\r?\n/).filter(function (line) {
        var resolution = /^PlayResY:\s*(\d+)/i.exec(line);
        if (resolution) height = parseInt(resolution[1], 10) || height;
        var format = /^Format:(.*)$/i.exec(line);
        if (format) {
          style = format[1].split(',').map(function (name) { return name.trim().toLowerCase(); }).indexOf('style');
          return true;
        }
        if (!/^Dialogue:/i.test(line)) return true;
        if (style < 0) return false;
        var fields = line.slice(line.indexOf(':') + 1).split(',');
        return SIGN_STYLE.test(fields[style] || '') || typeset(fields.slice(style + 6).join(','), height);
      }).join('\n');
    }

    // Some groups type a sign in the dialogue style: an episode title, a
    // "Next time" card, credits. Such a line is placed and styled by hand;
    // a placed line of dialogue rarely carries more than its position. A card
    // in the middle of the frame, where dialogue is not put, needs one tag.
    var TYPESET_TAGS = [/\\fade?\(/, /\\(blur|be)\d/, /\\fs\d/, /\\fsc[xy]\d/, /\\[1-4]?c&H/i, /\\fr[xyz]?-?\d/,
      /\\i?clip\(/, /\\fn[^\\}]/, /\\org\(/, /\\bord\d/, /\\shad\d/];

    function typeset(text, height) {
      var place = /\\(?:pos|move)\(\s*[\d.-]+\s*,\s*([\d.-]+)/.exec(text);
      if (!place) return false;
      var tags = TYPESET_TAGS.filter(function (tag) { return tag.test(text); }).length;
      var y = parseFloat(place[1]) / height;
      return tags >= 2 || tags === 1 && y > 0.3 && y < 0.7;
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
        video: video, subContent: content, fonts: fonts, timeOffset: subtitleOffset(),
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
        report('ass-failed', {track: item.label, embedded: true, reason: error && error.message}, state.work);
        hideAss(state, 'failed');
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
              var header = item.homelabAss.text ? textStyle(data.header) : data.header;
              state.assInstance = new Renderer(rendererOptions(base, video, header, results[1], library, loaded));
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
      report('ass-fallback', {stream: item.homelabAss.stream}, state.work);
      var original = item.homelabOriginal;
      if (!original || active !== state) return;
      original.selected = true;
      original.mode = 'showing';
      Lampa.PlayerVideo.subsview(true);
      // The menu's choice is remembered from this list.
      if (state.subtitles) state.subtitles = state.subtitles.map(function (sub) { return sub === item ? original : sub; });
      updateSignsToggle();
    }

    function defineMode(state, item) {
      // Lampa's menu switches subtitles through `mode`, like hls.js tracks.
      Object.defineProperty(item, 'mode', {
        enumerable: true,
        get: function () { return state.assActive === item && state.assHiding !== item ? 'showing' : 'disabled'; },
        set: function (value) {
          if (value === 'showing') {
            // The replaced hls.js track must not draw its plain text too.
            if (item.homelabOriginal && item.homelabOriginal.mode === 'showing') item.homelabOriginal.mode = 'disabled';
            if (state.assHiding === item) state.assHiding = null;
            showAss(state, item, assWhy || 'mode');
          } else if (state.assActive === item && state.assHiding !== item) {
            // Lampa's menu disables every track before showing the chosen
            // one; choosing the track already drawn keeps its renderer.
            state.assHiding = item;
            Promise.resolve().then(function () {
              if (state.assHiding !== item) return;
              state.assHiding = null;
              if (state.assActive === item) hideAss(state, 'off');
            });
          }
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
      // GST turns double quotes in a title into single ones, and names a
      // stream whose tags it lost "Subtitle N".
      function title(text) { return plain(text || '').replace(/[\u2033\u2019]/g, '').trim(); }
      var aligned = data.subtitles.every(function (sub, i) {
        var label = title(originals[i].label);
        return !sub.title || label === title(sub.title) || /^Subtitle \d+$/.test(label);
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
              stream: sub.stream, events: base + 'sub/' + sub.stream, text: sub.codec !== 'ass' && sub.codec !== 'ssa',
              fonts: (data.fonts || []).filter(Number.isInteger).map(function (id) {
                return new URL(base + 'attachment/' + id, window.location.href).href;
              })
            }
          });
        }
        // A reload brings new hls.js tracks; the item stays the same.
        item.index = original.index;
        item.label = item.homelabLabel = subtitleLabel(sub.title, sub.language, false);
        item.homelabSigns = signsTitle(sub.title);
        item.homelabLanguage = sub.language || '';
        // Choices are remembered by GST's name, which a choice made before
        // this probe arrived also used.
        item.gstTitle = original.label;
        item.selected = original.selected;
        item.homelabOriginal = original;
        return item;
      });
    }

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

    function subtitleLabel(title, language, external, signs) {
      title = String(title || '').replace(/["'«»\u2033\u2019]/g, '').trim();
      if (signs === undefined) signs = signsTitle(title);
      var lang = LANGUAGES[String(language || '').toLowerCase()] || '';
      var group = title.replace(NOISE_WORDS, '$1').replace(/[\[\]()]/g, ' ')
        .replace(/^[\s\-_.,:;|/+&]+|[\s\-_,:;|/+&]+$/g, '').replace(/\s+/g, ' ');
      if (/^[\d\s]*$/.test(group)) group = ''; // "Субтитры 2": tracks are numbered later
      var who = group || lang || title || 'Субтитры';
      var what = signs ? 'надписи' : 'полные';
      // A group says nothing of the language unless it is the usual Russian.
      if (group && lang && lang !== 'Русские') what += ', ' + lang.toLowerCase();
      return plain(who.charAt(0).toUpperCase() + who.slice(1) + ': ' + what + (external ? ' (внешние)' : ''));
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
      var base = '/extaudio/' + encodeURIComponent(state.work.homelab_torrent_hash) + '/';
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
            homelabAss: {url: base + sub.file + '/raw', fonts: fonts, signs: signs}, homelabSigns: signs
          }));
        });
      });
      return numberLabels(items);
    }

    function withAss(state, list) {
      if (!state.hlsSubs) state.hlsSubs = list.filter(function (item) { return !item.homelabAss; });
      var items = embeddedItems(state);
      // Tracks the plugin does not rename keep GST's name, which can carry markup.
      items.forEach(function (item) {
        if (!item.homelabAss && /[<>"'`]/.test(item.label)) item.label = plain(item.label);
      });
      list.splice.apply(list, [0, list.length].concat(numberLabels(items.concat(state.assItems || []))));
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
      return item.homelabAss && item.homelabAss.url || null;
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
      if (target) button.html(SIGNS_ICON + (subtitleSigns(current) ? 'Надп.' : 'Полн.') + '<div class="tooltip">Надписи / полные (S)</div>');
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

    // A pending lookup waits up to 10 s in the sidecar for the files it is
    // still reading, so about four minutes in all.
    var EXTERNAL_LOOKUPS = 20;

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
          report('audio-lookup-failed', {reason: error.message}, work);
          return [];
        })
        .then(function (tracks) {
          return tracks.filter(function (track) {
            return Number.isInteger(track.file) && Number.isInteger(track.stream);
          }).map(function (track) {
            return {
              external: true, key: track.file + ':' + track.stream,
              url: base + track.file + '/' + track.stream + '/aac/audio.m3u8',
              codecs: EXTERNAL_CODECS,
              language: track.language, gstTitle: track.title || '',
              label: plain((track.title || track.location || 'Audio') + ' (внешняя)'),
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
      report('play-start', {audio: Number(url.searchParams.get('audio') || 0)}, work);
      var stored = Lampa.Storage.get(preferenceKey, {});
      state.preferences = stored && stored[String(work.homelab_torrent_hash || work.torrent_hash)] || {};
      var revision = generation;
      var probe = new URL(url.href);
      probe.pathname = probe.pathname.replace(/(?:master|start)\.m3u8$/, 'probe');
      probe.searchParams.delete('audio');
      probe.searchParams.delete('seconds');
      state.probeTimeout = setTimeout(function () { state.abort.abort(); }, 90000);
      // The first answer can include a 10 s probe for each audio file.
      state.externalTimeout = setTimeout(function () { state.externalAbort.abort(); }, 60000);
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
            label: plain(track.Title || ('Audio ' + (track.Index + 1))),
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
        report('gst-probe-failed', {reason: error.message}, work);
        return [];
      }).then(function (list) {
        lists.embedded = list;
        publish();
        // GST has opened the file by now, so TorrServer knows the torrent.
        if (active === state && generation === revision) embeddedSubtitles(state, work, revision);
      }).catch(function () {}).finally(function () { clearTimeout(state.probeTimeout); });
      // The sidecar answers with the audio files it could read in time and
      // marks the rest pending; those are asked for again in the background.
      function lookupExternalTracks(attempts) {
        externalTracks(state, work).then(function (list) {
          clearTimeout(state.externalTimeout);
          if (active !== state || generation !== revision) return;
          // A torrent still fetching its metadata lists no subtitles at first.
          if (!state.assItems || !state.assItems.length) installAss(state, state.externalData);
          if (state.externalData && state.externalData.pending && attempts > 1) {
            state.externalRetry = setTimeout(function () { lookupExternalTracks(attempts - 1); }, 2000);
          }
          var keys = function (tracks) { return tracks.map(function (track) { return track.key; }).join(); };
          if (!list.length || keys(list) === keys(lists.external)) return;
          // Known tracks keep their objects: a preparation in progress and the
          // ready/unsupported marks belong to them.
          lists.external = list.map(function (track) {
            return lists.external.find(function (known) { return known.key === track.key; }) || track;
          });
          publish();
        }).catch(function () {});
      }
      lookupExternalTracks(EXTERNAL_LOOKUPS);
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
      if (showing && active.assVideo !== Lampa.PlayerVideo.video()) showAss(active, showing, 'new-video');
      applySubtitles(active, event.subs);
    });
    Lampa.PlayerPanel.listener.follow('subsview', function (event) {
      if (!active || Lampa.Player.playdata() !== active.work) return;
      updateSignsToggle();
      if (!event.status) {
        report('subtitle-switch', {auto: false, off: true});
        return remember(active, 'subtitles', {off: true});
      }
      var selected = showingSubtitle(active);
      if (selected) report('subtitle-switch', {auto: false, track: selected.label, via: toggling ? 'toggle' : null});
      if (selected) remember(active, 'subtitles', identity(selected));
    });
    // S on a keyboard does what the panel button does, while the player has the controls.
    if (Lampa.Keypad && Lampa.Keypad.listener) Lampa.Keypad.listener.follow('keydown', function (event) {
      var key = event.event;
      if (event.code !== 83 || !event.enabled || !key || key.metaKey || key.ctrlKey || key.altKey) return;
      var controller = Lampa.Controller.enabled && Lampa.Controller.enabled();
      if (controller && /^player(_panel|_rewind)?$/.test(controller.name)) toggleSigns();
    });
    Lampa.PlayerVideo.listener.follow('pause', function () {
      var work = Lampa.Player.playdata();
      if (masterUrl(work)) pausedWork = work;
    });
    Lampa.PlayerVideo.listener.follow('play', function () {
      var video = Lampa.PlayerVideo.video();
      if (pausedWork === Lampa.Player.playdata() && video && !video.paused) pausedWork = null;
    });
    if (Lampa.Storage.listener) Lampa.Storage.listener.follow('change', function (event) {
      var instance = active && active.assInstance;
      if (event.name !== 'player_subs_shift_time' || !instance) return;
      instance.timeOffset = subtitleOffset();
      var video = Lampa.PlayerVideo.video();
      if (video && video.paused) instance.ready.then(function () { return redrawFrame(instance, video); }).catch(function () {});
    });
    Lampa.Player.listener.follow('create', preparePlayback);
    Lampa.Player.listener.follow('ready', installCurrent);
    Lampa.Player.listener.follow('destroy', function () {
      if (active) report('play-stop', {}, active.work);
      pausedWork = null;
      clear();
    });
    Lampa.HomelabGstAudio = {installCurrent: installCurrent, toggleSigns: toggleSigns};
    updateSignsToggle();
  }

  installGstAudio();
  if (Lampa.HomelabGstAudio) Lampa.HomelabGstAudio.installCurrent();
})();
