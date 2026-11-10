  // ── Labels and the row list: next episode, progress text, metadata ──
  // Lampa marks an episode watched at 90%; Continue then offers the next one.
  function nextEpisode(item, seasons) {
    if (!Number.isInteger(item.season) || item.season < 0 || !(item.episode > 0)) return null;
    var count = seasons && seasons[item.season];
    if (!seasons || !(count > 0) || item.episode < count) return seasons && seasons[item.season] === 0 ? null : {season: item.season, episode: item.episode + 1};
    if (item.season === 0) return null;
    var following = Object.keys(seasons).map(Number).filter(function (n) { return n > item.season && seasons[n] > 0; }).sort(function (a, b) { return a - b; })[0];
    return following ? {season: following, episode: 1} : null;
  }
  function watched(item) { return item.duration > 0 && item.position / item.duration >= .9; }
  // @include shared/remaining.js
  function episodeLabel(season, episode) { return season === 0 ? 'Спецвыпуск ' + episode : 'С' + season + ' · Е' + episode; }
  function hasEpisode(item) { return item.card.indexOf('tv_') === 0 && Number.isInteger(item.season) && item.season >= 0 && item.episode > 0; }
  function percentOf(item) { return item.advance || !(item.duration > 0) ? 0 : Math.max(0, Math.min(100, item.position / item.duration * 100)); }
  function progressText(item) {
    var label = hasEpisode(item) ? episodeLabel(item.season, item.episode) : '';
    if (item.advance) return (item.fresh ? 'Новая серия: ' : 'Следующая: ') + (!label ? 'серия' : item.season === item.advance.season && item.season !== 0 ? 'Е' + item.episode : label);
    return (label ? label + ' · ' : '') + remaining(item.position, item.duration);
  }
  function sourceLabel(item) {
    if (item.kind === 'online' && item.online && item.online.provider) {
      var name = plain(item.online.provider).slice(0, 14);
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return item.kind !== 'online' && item.torrent ? 'Торрент' : '';
  }
  function list() {
    var result = [];
    merged().forEach(function (item) {
      if (item.deleted || !(item.duration > 0)) return;
      if (watched(item)) {
        if (item.card.indexOf('tv_') !== 0) return;
        var known = metadata[item.card] || remembered[item.card], next = nextEpisode(item, known && known.seasons);
        if (!next) return;
        // TMDB lists announced episodes too: an episode that has not aired yet is nothing to continue.
        var aired = known && known.aired, airedAt = aired ? Date.parse(aired.date + 'T00:00:00Z') : NaN;
        if (aired && next.season !== 0 && (next.season > aired.season || next.season === aired.season && next.episode > aired.episode)) return;
        var value = Object.assign({}, item, {season: next.season, episode: next.episode, position: 0, advance: {season: item.season, episode: item.episode}});
        // Episodes released after the last viewing are new: they lead the row and say so.
        if (Number.isFinite(airedAt) && airedAt > item.observed && next.season !== 0) value.fresh = true;
        // A native season index cannot be derived for another season.
        if (next.season !== item.season) delete value.online;
        result.push(value);
      } else if (item.position > 1) result.push(item);
    });
    return result.sort(function (a, b) { return (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0) || b.observed - a.observed; }).slice(0, 20);
  }
  function enrich() {
    if (!L.Api.sources || !L.Api.sources.tmdb || !L.Api.sources.tmdb.get) return;
    var key = context();
    merged().forEach(function (item) {
      if (resolving[item.card] || item.deleted) return;
      if (!item.title || item.card.indexOf('tv_') === 0 && watched(item) && !(metadata[item.card] && metadata[item.card].seasons)) { resolving[item.card] = true; metadataQueue.push(item); }
    });
    function work() {
      if (context() !== key) return;
      while (metadataRunning < 4 && metadataQueue.length) {
        (function (item) {
          metadataRunning++;
          function complete(data) {
            if (context() !== key) return;
            if (data) {
              var value = {};
              if (data.name || data.title) value.title = plain(data.name || data.title);
              if (data.poster_path) value.poster = data.poster_path;
              if (data.backdrop_path) value.backdrop = data.backdrop_path;
              if (Array.isArray(data.seasons)) {
                value.seasons = {};
                data.seasons.forEach(function (season) { if (season && Number.isInteger(season.season_number) && Number.isInteger(season.episode_count)) value.seasons[season.season_number] = season.episode_count; });
              }
              var aired = data.last_episode_to_air;
              if (aired && Number.isInteger(aired.season_number) && Number.isInteger(aired.episode_number) && /^\d{4}-\d{2}-\d{2}$/.test(aired.air_date || ''))
                value.aired = {season: aired.season_number, episode: aired.episode_number, date: aired.air_date};
              metadata[item.card] = value; persist();
            }
            metadataRunning--; publish(); work();
          }
          L.Api.sources.tmdb.get(item.card.replace('_', '/'), {}, complete, function () { complete(); });
        })(metadataQueue.shift());
      }
    }
    work();
  }
