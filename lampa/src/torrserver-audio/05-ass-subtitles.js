    // ── ASS/SSA subtitles drawn with JASSUB, fonts and the text fallback ──
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
        paintSubtitle(state, item);
        seeked(); // a paused video shows no new frame to draw on
      }).catch(function (error) {
        if (active !== state || state.assRequest !== request) return;
        console.warn('Homelab ASS:', error && error.message);
        report('ass-failed', {track: item.label, reason: error && error.message}, state.work);
        hideAss(state, 'failed');
        updateSignsToggle();
        paintSubtitle(state, item);
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
        item.homelabSource = {title: sub.title || original.label, language: sub.language || '', external: false};
        // Choices are remembered by GST's name, which a choice made before
        // this probe arrived also used.
        item.gstTitle = original.label;
        item.selected = original.selected;
        item.homelabOriginal = original;
        return item;
      });
    }

