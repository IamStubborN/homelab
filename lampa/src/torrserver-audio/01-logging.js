// Isolated browser playback and track preferences for Lampac GStreamer.
(function () {
  'use strict';

  function installGstAudio() {
    if (Lampa.HomelabGstAudio || !Lampa.Player || !Lampa.PlayerVideo || !Lampa.PlayerPanel) return;
    var active = null;
    var pausedWork = null;
    var generation = 0;
    var preferenceKey = 'homelab_gst_track_preferences';
    var phaseListeners = [];
    var retryWork = null;
    function phase(name, work) {
      phaseListeners.slice().forEach(function (fn) { try { fn({type: name, work: work}); } catch (_) {} });
    }

    // Playback events for `docker logs lampa-media`: a page session, the
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
        window.fetch(new URL('/homelab-media/log', window.location.href).href, {
          method: 'POST', body: JSON.stringify(event), keepalive: true, credentials: 'omit',
          headers: {'Content-Type': 'application/json'}
        }).catch(function () {});
      } catch (error) {}
    }

