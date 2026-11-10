    // ── External .mka/.srt files from the sidecar and installing the current playback ──
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
              language: track.language, gstTitle: track.title || '', location: track.location || '', sourceCodec: track.codec || '',
              label: plain((track.title || track.location || 'Audio') + ' (внешняя)'),
              extra: {channels: track.channels}
            };
          });
        });
    }

    function installCurrent() {
      var work = Lampa.Player.playdata();
      var url = masterUrl(work);
      if (active && active.work === work && (url || active.online)) return;
      clear();
      if (!url && work) return installOnline(work);
      if (!url || typeof window.fetch !== 'function' || typeof AbortController === 'undefined') return;
      var state = active = {
        work: work, abort: new AbortController(), externalAbort: new AbortController(), previousTracks: work.voiceovers,
        embeddedProxies: {}, embeddedBroken: {},
        // Counted from the first frame: a slow torrent start keeps the window open.
        autoUntil: Infinity
      };
      report('play-start', {audio: Number(url.searchParams.get('audio') || 0)}, work);
      var stored = Lampa.Storage.get(preferenceKey, {});
      state.preferences = work.homelab_track_preferences || stored && stored[String(work.homelab_torrent_hash || work.torrent_hash)] || {};
      work.homelab_track_preferences = state.preferences;
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
        // The URL changes with every switch; mark the track playing now.
        var current = selectedTrack(state, masterUrl(work) || url);
        state.tracks.forEach(function (track) {
          track.selected = track === current;
          offerTrack(state, track);
        });
        work.voiceovers = arrangeMenu(state);
        Lampa.PlayerPanel.setTracks(state.menu);
        var preferred = matchingTrack(state.tracks, state.preferences.audio);
        if (!preferred || preferred === current) return;
        // A late lookup must not reload a video the viewer is already watching.
        if (Date.now() < state.autoUntil) {
          state.autoNotice = preferred;
          selectTrack(state, preferred, true);
        } else lateTrack(state, preferred);
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

