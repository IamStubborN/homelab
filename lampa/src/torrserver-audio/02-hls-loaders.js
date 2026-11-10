    // ── HLS: MP4 fragment surgery, retrying and audio/subtitle loaders for hls.js ──
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

    function bufferedAhead(media) {
      var ranges = media.buffered;
      var time = Number(media.currentTime) || 0;
      if (!ranges) return 0;
      for (var i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= time + 0.5 && ranges.end(i) > time) return ranges.end(i) - time;
      }
      return 0;
    }

    // The sidecar answers 503 while it encodes a segment, and a restart
    // briefly refuses connections. External audio fragments wait for it
    // longer than hls.js's shared fragment policy before failing for good.
    var AUDIO_RETRY_MS = 60000;
    var AUDIO_RETRY_DELAY_MS = 2000;
    var TRANSIENT_STATUS = {0: true, 429: true, 500: true, 502: true, 503: true, 504: true};

    function retryingLoader(BaseLoader) {
      function Loader(config) { this.config = config; this.inner = new BaseLoader(config); this.timer = null; this.stopped = false; }
      ['stats', 'context'].forEach(function (name) {
        Object.defineProperty(Loader.prototype, name, {get: function () { return this.inner[name]; }});
      });
      Loader.prototype.load = function (context, config, callbacks) {
        var self = this;
        var frag = context.frag;
        if (!frag || frag.type !== 'audio') return this.inner.load(context, config, callbacks);
        var deadline = Date.now() + AUDIO_RETRY_MS;
        function attempt() {
          self.timer = null;
          if (self.stopped) return;
          self.inner.load(context, config, Object.assign({}, callbacks, {
            onError: function (error, loaderContext, networkDetails, stats) {
              if (!self.stopped && error && TRANSIENT_STATUS[error.code] && Date.now() + AUDIO_RETRY_DELAY_MS < deadline) {
                // A loader is used once; hls.js keeps the first one's stats.
                var kept = self.inner.stats;
                try { self.inner.destroy(); } catch (_) {}
                self.inner = new BaseLoader(self.config);
                if (kept && kept.loading) {
                  kept.loading.start = kept.loading.first = kept.loading.end = 0;
                  kept.loaded = 0;
                  kept.aborted = false;
                  kept.retry = (kept.retry || 0) + 1;
                  self.inner.stats = kept;
                }
                self.timer = setTimeout(attempt, AUDIO_RETRY_DELAY_MS);
                return;
              }
              callbacks.onError(error, loaderContext, networkDetails, stats);
            }
          }));
        }
        attempt();
      };
      Loader.prototype.abort = function () { this.stopped = true; clearTimeout(this.timer); this.inner.abort(); };
      Loader.prototype.destroy = function () { this.stopped = true; clearTimeout(this.timer); this.inner.destroy(); };
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
      config.fLoader = transformingLoader(retryingLoader(config.fLoader || BaseLoader), function (context, response) {
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
          phase('failed', work);
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
            // A paused video with frames buffered ahead is not stuck: hls.js
            // loads nothing while the buffer is full. Count again from resume.
            if (hls.media && hls.media.paused && bufferedAhead(hls.media) >= 1) return beginDeadline();
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
            phase('buffered', work);
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
          // Only the video can stall playback: an audio rendition or subtitle
          // fragment that fails must not start the terminal deadline.
          if (data.type === BaseHls.ErrorTypes.NETWORK_ERROR && (!data.frag || data.frag.type === 'main') &&
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
              setTimeout(function () { if (!disposed) abandonExternal(work, 'unsupported fragment layout'); }, 0);
            }
            return true;
          }
          // The external rendition failed for good (sidecar error, missing
          // segment): the video is fine, so play the embedded audio instead.
          if (!disposed && !terminated && data.fatal && work.homelab_external_audio && audioRenditionError(data) &&
              Lampa.Player.playdata() === work && (abandoned || embeddedFallback(work))) {
            handled.add(data);
            if (!abandoned) {
              abandoned = true;
              hls.stopLoad();
              setTimeout(function () { if (!disposed) abandonExternal(work, 'rendition failed'); }, 0);
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
          phase('recovering', work);
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
