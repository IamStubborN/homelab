    // ── Player and key events, retry, Lampa.HomelabGstAudio ──
    Lampa.PlayerVideo.listener.follow('subs', function (event) {
      if (!Array.isArray(event.subs)) return;
      // Lampa may send back the list it keeps, with drawn items already in it.
      lastSubtitles = {work: Lampa.Player.playdata(), list: event.subs, originals: event.subs.map(function (sub) {
        return sub.homelabOriginal || sub;
      }).filter(function (sub) { return !sub.homelabAss && !sub.homelabOff; })};
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
      repaintSubtitles(active);
    });
    // S on a keyboard does what the panel button does, while the player has the controls.
    if (Lampa.Keypad && Lampa.Keypad.listener) Lampa.Keypad.listener.follow('keydown', function (event) {
      var key = event.event;
      if (event.code !== 83 || !event.enabled || !key || key.metaKey || key.ctrlKey || key.altKey) return;
      var controller = Lampa.Controller.enabled && Lampa.Controller.enabled();
      if (controller && /^player(_panel|_rewind)?$/.test(controller.name)) toggleSigns();
    });
    Lampa.PlayerVideo.listener.follow('timeupdate', warmNext);
    Lampa.PlayerVideo.listener.follow('pause', function () {
      var work = Lampa.Player.playdata();
      if (masterUrl(work)) pausedWork = work;
    });
    Lampa.PlayerVideo.listener.follow('play', function () {
      var video = Lampa.PlayerVideo.video();
      if (active && active.work === Lampa.Player.playdata() && active.autoUntil === Infinity) active.autoUntil = Date.now() + AUTO_APPLY_MS;
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
    Lampa.Player.listener.follow('start', function (work) {
      // The playlist keeps copies with the URL Lampa built; the playing copy
      // carries its rewritten URL. Point the playlist at the original one,
      // or it falls back to the first item without an episode number.
      if (work && work.homelab_source_url && masterUrl(work) && Lampa.PlayerPlaylist && Lampa.PlayerPlaylist.url) {
        Lampa.PlayerPlaylist.url(work.homelab_source_url);
      }
    });
    Lampa.Player.listener.follow('ready', installCurrent);
    // A play that still ends in an external app gets back what Lampa built.
    Lampa.Player.listener.follow('external', function (work) {
      if (!work || !work.homelab_source_url || !work.homelab_torrent_hash) return;
      work.url = work.homelab_source_url;
      work.torrent_hash = work.homelab_torrent_hash;
      delete work.homelab_torrent_hash;
      delete work.homelab_source_url;
      delete work.homelab_external_audio;
      delete work.homelab_gst_played;
    });
    Lampa.Player.listener.follow('destroy', function () {
      if (active) report('play-stop', {}, active.work);
      pausedWork = null;
      clear();
      if (retryWork) delete retryWork.homelab_retry_playback;
      retryWork = null;
    });
    function canRetry(work) {
      if (!work || work !== Lampa.Player.playdata() || !masterUrl(work) || !Lampa.PlayerVideo.video()) return false;
      if (active) return active.work === work;
      return typeof window.fetch === 'function' && typeof AbortController !== 'undefined';
    }

    Lampa.HomelabGstAudio = {installCurrent: installCurrent, toggleSigns: toggleSigns,
      preferences: function (work) {
        var state = active, url = masterUrl(work);
        if (!state || state.work !== work || !url) return work && work.homelab_track_preferences || {};
        var result = Object.assign({}, state.preferences), track = selectedTrack(state, url);
        if (track) result.audio = identity(track);
        if (!result.subtitles && (state.subtitleList || state.subtitles)) {
          var shown = (state.subtitleList || state.subtitles).find(function (sub) { return sub.mode === 'showing'; });
          result.subtitles = shown ? identity(shown) : {off: true};
        }
        return result;
      },
      // Whether retryCurrent() would restart this work in place; reads only.
      canRetry: canRetry,
      subscribe: function (fn) { phaseListeners.push(fn); return function () { phaseListeners = phaseListeners.filter(function (value) { return value !== fn; }); }; },
      retryCurrent: function () {
        var work = Lampa.Player.playdata();
        // Decide before touching the work: a refusal leaves it as it was.
        if (!canRetry(work)) return false;
        var url = masterUrl(work), old = Lampa.PlayerVideo.video();
        var saved = active && active.pendingPlayback || ((old.readyState < 1 || old.error) && work.homelab_retry_playback) || {time: Number(old.currentTime) || 0, paused: old.paused,
          volume: old.volume, muted: old.muted, rate: old.playbackRate};
        work.homelab_retry_playback = saved; retryWork = work;
        if (work.homelab_torrent_hash) url.searchParams.set('uid', newSessionId());
        work.url = url.href;
        if (!active) installCurrent();
        var state = active;
        if (!state || state.work !== work) return false;
        if (state.cancelRestore) state.cancelRestore(true);
        state.pendingPlayback = saved;
        phase('preparing', work);
        var track = selectedTrack(state, url);
        if (track) selectTrack(state, track, true, true);
        else {
          if (work.homelab_external_audio) {
            var external = new URL(work.homelab_external_audio.url, window.location.href);
            external.searchParams.set('at', Math.floor(saved.time)); work.homelab_external_audio.url = external.href;
          }
          replaceVideo(state, url, saved);
        }
        return true;
      }
    };
    if (typeof window.dispatchEvent === 'function' && window.CustomEvent) window.dispatchEvent(new window.CustomEvent('homelab:audio-ready'));
    updateSignsToggle();
  }

  installGstAudio();
  if (Lampa.HomelabGstAudio) Lampa.HomelabGstAudio.installCurrent();
})();
