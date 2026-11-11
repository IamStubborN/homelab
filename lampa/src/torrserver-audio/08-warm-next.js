    // ── Warming up the next file of the torrent near the end of an episode ──
    // Near the end of an episode the sidecar reads the head of the next one
    // (a few MB) and probes it, so a slow torrent starts it sooner.
    // Only playback counts, not a pause or a scrub through the timeline.
    var WARM_REMAINING = 420;
    var WARM_PLAYED = 10;
    // A GST EVENT playlist grows while the task encodes ahead: its end is
    // known only once the duration has stopped changing for a while.
    var WARM_STABLE_MS = 30000;
    // One retry: a busy sidecar (429) after a while, a failure (5xx, network) sooner.
    var WARM_BUSY_RETRY_MS = 30000;
    var WARM_FAILED_RETRY_MS = 10000;
    var warmedFiles = [];

    function torrentFile(item) {
      // An item that has played was rewritten to a GST start URL; it keeps its file.
      if (item && item.homelab_torrent_hash && Number.isInteger(item.homelab_file_index)) {
        return {hash: String(item.homelab_torrent_hash).toLowerCase(), index: item.homelab_file_index};
      }
      if (!item || typeof item.url !== 'string') return null;
      try {
        // Lampa lists `/stream/<name>?link=<hash>&index=N` or `/gst/<hash>/master.m3u8?index=N`.
        var url = new URL(item.url, window.location.href);
        var gst = /\/gst\/([^/]+)\/master\.m3u8$/.exec(url.pathname);
        var hash = url.searchParams.get('link') || (gst && decodeURIComponent(gst[1]));
        var index = url.searchParams.get('index');
        return hash && /^\d+$/.test(index || '') ? {hash: hash.toLowerCase(), index: Number(index)} : null;
      } catch (error) { return null; }
    }

    // The item after the playing one, if it is another file of the same torrent.
    function nextFile(work) {
      var list = Lampa.PlayerPlaylist && typeof Lampa.PlayerPlaylist.get === 'function' ? Lampa.PlayerPlaylist.get() : work.playlist;
      if (!Array.isArray(list) || !Number.isInteger(work.homelab_file_index)) return null;
      var hash = String(work.homelab_torrent_hash).toLowerCase();
      var files = list.map(torrentFile);
      // From the second episode on Lampa plays the playlist item itself; the
      // first one is a copy that keeps the item's URL in homelab_source_url.
      var current = list.indexOf(work);
      if (current === -1 && work.homelab_source_url) {
        current = list.findIndex(function (item) { return item && item.url === work.homelab_source_url; });
      }
      if (current === -1) current = files.findIndex(function (file) { return file && file.hash === hash && file.index === work.homelab_file_index; });
      var next = current === -1 ? null : files[current + 1];
      return next && next.hash === hash && next.index !== work.homelab_file_index ? next : null;
    }

    function metered() {
      var connection = window.navigator && window.navigator.connection;
      return Boolean(connection && (connection.saveData || connection.type === 'cellular'));
    }

    function warmNext() {
      var state = active;
      if (!state || state.warmed || state.warmBusy || Lampa.Player.playdata() !== state.work || !state.work.homelab_torrent_hash) return;
      var video = Lampa.PlayerVideo.video();
      var duration = video && Number(video.duration);
      var now = Date.now();
      if (duration !== state.warmDuration) {
        state.warmDuration = duration;
        state.warmStableSince = now;
        state.warmPlayed = 0;
        state.warmLast = null;
      }
      var time = video && Number(video.currentTime);
      var left = video && duration - time;
      if (!video || video.paused || video.seeking || !isFinite(duration) || now - state.warmStableSince < WARM_STABLE_MS ||
          !(left > 0 && left <= WARM_REMAINING) || time < duration / 2) {
        state.warmPlayed = 0;
        state.warmLast = null;
        return;
      }
      // A jump forward is a seek, not playback.
      var step = state.warmLast === null || state.warmLast === undefined ? 0 : time - state.warmLast;
      state.warmLast = time;
      if (step > 0 && step < 3) state.warmPlayed = (state.warmPlayed || 0) + step;
      if (state.warmPlayed < WARM_PLAYED || now < (state.warmRetryAt || 0)) return;
      var next = nextFile(state.work);
      if (!next || metered()) { state.warmed = true; return; }
      var key = next.hash + '/' + next.index;
      if (warmedFiles.indexOf(key) !== -1) { state.warmed = true; return; }
      var url = new URL('/homelab-media/' + encodeURIComponent(state.work.homelab_torrent_hash) + '/' + next.index + '/warm', window.location.href);
      // The sidecar probes external audio only for the voice-over being played.
      var external = state.work.homelab_external_audio;
      if (external && /^\d+:/.test(external.key)) url.searchParams.set('voice', external.key.split(':')[0]);
      state.warmAttempts = (state.warmAttempts || 0) + 1;
      state.warmBusy = true;
      report('warm-next', {next: next.index, voice: Boolean(url.searchParams.get('voice')), attempt: state.warmAttempts}, state.work);
      // Once per episode only when the sidecar took it; a refusal may be retried once.
      function failed(status) {
        state.warmBusy = false;
        report('warm-failed', {next: next.index, status: status, attempt: state.warmAttempts}, state.work);
        var retry = (status === 429 || status === 0 || status >= 500) && state.warmAttempts < 2;
        if (!retry) { state.warmed = true; return; }
        state.warmRetryAt = Date.now() + (status === 429 ? WARM_BUSY_RETRY_MS : WARM_FAILED_RETRY_MS);
      }
      window.fetch(url.href, {method: 'POST', cache: 'no-store'}).then(function (response) {
        if (!response || !response.ok) return failed(response && response.status || 0);
        state.warmBusy = false;
        state.warmed = true;
        if (warmedFiles.indexOf(key) === -1) warmedFiles.push(key);
        if (warmedFiles.length > 50) warmedFiles.shift();
      }, function () { failed(0); });
    }

