    // ── Search: checking the real quality of rows ──
    // Rows without quality ask their source once, after the catalog is done: the call JSON or the HLS master
    // (RESOLUTION) gives the real height. The UI asks only for each voice card's leader (at most 12 per search) and,
    // lazily, for the alternatives of a card whose source list is opened (24 in total). Only an own-Lampac 404/410 or an
    // explicit "not found" error means the source hands out no video; auth/quota answers (401/403, accsdb, other
    // errors), rch/ws handshakes, timeouts and foreign CDN refusals change nothing. Media is never read.
    var probeQueue = [], probing = 0, probes = 0, leaders = 0, probeUrls = {}, probed = {}, PROBE_TTL = 30 * 60000;
    function probeApply(row, value) {
      if (value.unavailable) row.unavailable = true;
      else { row.qualities = value.qualities.slice(); row.measured = true; row.verified = 'probe'; }
    }
    function probeCached(key) {
      var entry = probeCache.values[key];
      if (entry && Date.now() - entry.at < PROBE_TTL) return entry.value;
    }
    // Catalog rows only remember where they could be probed; a cached answer applies at once without a request.
    function probeable(row, raw) {
      // Without a native AbortController a hung or media response could not be stopped: skip probing entirely.
      // A claimed quality is checked too: sources name heights their stream does not have.
      if (row.native || row.measured || typeof raw !== 'string' || !raw || !window.AbortController) return;
      var key = scope + '\n' + row.provider + '\n' + raw, cached = probeCached(key);
      if (cached) return probeApply(row, cached);
      probeUrls[row.key] = {url: raw, key: key};
    }
    function probeRemember(key, value) {
      if (!probeCache.values[key]) { probeCache.keys.push(key); if (probeCache.keys.length > 200) delete probeCache.values[probeCache.keys.shift()]; }
      probeCache.values[key] = {value: value, at: Date.now()};
    }
    // lazy: alternatives the user asked to see; they do not use the leader budget.
    this.probe = function (rows, lazy) {
      (rows || []).forEach(function (row) {
        var target = row && probeUrls[row.key];
        if (!live() || !target || probed[row.key] || row.measured || row.unavailable || probes >= 24 || !lazy && leaders >= 12) return;
        probed[row.key] = true; probes++; if (!lazy) leaders++;
        probeQueue.push({row: row, url: target.url, key: target.key});
      });
      probeNext();
    };
    function probeRead(response, abort) {
      var type = String(response.headers.get('content-type') || '').toLowerCase(), length = Number(response.headers.get('content-length'));
      var known = response.headers.get('content-length') != null && response.headers.get('content-length') !== '' && Number.isFinite(length);
      var readable = /json|mpegurl|m3u8/.test(type) || /^text\/html/.test(type) || /^text\/plain/.test(type) && known && length <= 65536;
      if (!readable || known && length > 262144) { abort.abort(); return Promise.resolve(''); }
      if (known) return response.text();
      // Unknown length: stream with a byte cap, or give up where streams are missing.
      var reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
      if (!reader || typeof window.TextDecoder !== 'function') { abort.abort(); return Promise.resolve(''); }
      var decoder = new window.TextDecoder(), text = '', total = 0;
      function next() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return text + decoder.decode();
          total += chunk.value.byteLength;
          if (total > 262144) { abort.abort(); return ''; }
          text += decoder.decode(chunk.value, {stream: true}); return next();
        });
      }
      return next();
    }
    function probeFetch(raw, provider) {
      var auth, url, own;
      try {
        auth = server('/lite/events'); url = new URL(raw, auth.origin); own = url.origin === auth.origin;
        if (own && /^\/lite\//.test(url.pathname)) url = new URL(address(url.href, false));
      } catch (error) { return Promise.reject(error); }
      if (!/^https?:$/.test(url.protocol)) return Promise.reject(new Error('url'));
      var trusted = own && /^\/(?:lite|proxy)\//.test(url.pathname);
      var abort = Abort(), timer = setTimeout(function () { abort.abort(); }, 10000); requests.push(abort);
      var headers = {}, kit = own && L.Storage.get('kit_aesgcmkey', ''); if (kit) headers['X-Kit-AesGcm'] = kit;
      // Own-Lampac probes share their provider's pacing; foreign CDNs are not rate limited by us.
      var delay = own ? paced(provider) : 0;
      var fetching = new Promise(function (resolve, reject) {
        var wait, start = function () {
          if (!live() || abort.signal.aborted) return reject(new Error('cancelled'));
          fetch(url.href, {signal: abort.signal, credentials: own ? 'same-origin' : 'omit', cache: 'no-store', headers: headers}).then(resolve, reject);
        };
        abort.signal.addEventListener('abort', function () { clearTimeout(wait); reject(new Error('cancelled')); }, {once: true});
        if (delay) { wait = setTimeout(start, delay); timers.push(wait); } else start();
      });
      return always(fetching.then(function (response) {
        return probeRead(response, abort).then(function (text) { return {status: response.status, trusted: trusted, text: text}; });
      }), function () { clearTimeout(timer); requests = requests.filter(function (entry) { return entry !== abort; }); });
    }
    // declared: heights the resolved JSON named; its stream manifest (when it is the top quality's) decides.
    function probeJob(job, raw, hop, declared) {
      var row = job.row;
      function settle(list) {
        probeRemember(job.key, {qualities: list}); row.qualities = list; row.measured = true; row.verified = 'probe'; row.doubtful = false;
        if (Q && row.kind === 'online' && !row.native) Q.report(movie, row.provider, factSeason(), row.factVoice || '', row.claimed || 0, list[0], 'probe');
        notify();
      }
      // Heights the resolver only named. A row the listing gave no quality takes them as before; a listing claim
      // is only shown, neither «проверено» nor logged, until its manifest is read.
      function asDeclared(list) {
        list = list || declared; if (!live() || !list || !list.length || row.measured) return;
        if (!row.claimed) return settle(list);
        row.qualities = list.slice(); notify();
      }
      return probeFetch(raw, row.provider).then(function (result) {
        if (!live()) return;
        if (result.status === 404 || result.status === 410) {
          if (result.trusted) { probeRemember(job.key, {unavailable: true}); row.unavailable = true; notify(); }
          return;
        }
        if (result.status >= 300) return asDeclared();
        var json; try { json = JSON.parse(result.text); } catch (_) {}
        if (json && typeof json === 'object') {
          var map = json.quality || json.qualitys, found = listedQualities({quality: map, maxquality: json.maxquality});
          if (typeof json.url === 'string' && json.url && !hop) {
            var labels = map && typeof map === 'object' ? Object.keys(map) : [];
            var top = labels.reduce(function (best, label) { return qualityHeight(label) > qualityHeight(best) ? label : best; }, labels[0]);
            // The manifest measures the top quality only when it is that quality's stream.
            if (!labels.length || map[top] === json.url) return probeJob(job, json.url, 1, found).catch(function () { asDeclared(found); });
          }
          if (found.length) return asDeclared(found);
          // Explicit "file not found" style errors only; not cached, since providers reuse error texts for quota.
          if (!json.accsdb && /not\s*found|не\s*найден|удал[её]н|removed|deleted|нет\s+видео|no\s+video/i.test(typeof json.error === 'string' ? json.error : '')) { row.unavailable = true; notify(); }
          return;
        }
        var best = /^\s*#EXTM3U/.test(result.text) ? hlsQuality(result.text) : 0;
        if (best) settle([best]); else asDeclared();
      });
    }
    // A row is probed as soon as its own provider has no catalog page left, not after the whole search.
    function probeNext() {
      while (live() && probing < 2) {
        var index = -1;
        for (var i = 0; i < probeQueue.length; i++) if (!pendingBy[probeQueue[i].row.provider]) { index = i; break; }
        if (index < 0) return;
        (function (job) {
          probing++;
          always(probeJob(job, job.url, 0).catch(function () {}), function () { probing--; probeNext(); notify(); });
        })(probeQueue.splice(index, 1)[0]);
      }
    }
