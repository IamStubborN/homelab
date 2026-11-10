  // ── Row order and parsing provider pages ──
  // Torrents: enough seeds to stream is a threshold; above it the picture quality decides, then the seeds.
  var MIN_SEEDS = 3;
  function seeded(row) { return row.release && (Number(row.release.Seeders) || 0) >= MIN_SEEDS ? 1 : 0; }
  // An unchecked claim of a provider known to inflate its quality ranks as unknown until a probe checks it.
  function rankQuality(row) { return row.doubtful && !row.measured ? 0 : row.qualities[0] || 0; }
  // tie (optional) breaks equal-quality rows before the name order; groups use it for their source count.
  function compareRows(a, b, tie) {
    var match = (a.unavailable ? 1 : 0) - (b.unavailable ? 1 : 0); if (match) return match;
    function group(row) { return row.native ? 2 : row.kind === 'online' ? 0 : 1; }
    match = group(a) - group(b); if (match) return match;
    if (a.release && b.release) { match = seeded(b) - seeded(a); if (match) return match; }
    match = rankQuality(b) - rankQuality(a); if (match) return match;
    if (a.release && b.release) { match = (Number(b.release.Seeders) || 0) - (Number(a.release.Seeders) || 0); if (match) return match; }
    match = tie ? tie(a, b) : 0;
    return match || String(a.providerName).localeCompare(String(b.providerName)) || a.key.localeCompare(b.key);
  }
  // @include shared/quality.js
  function hlsQuality(text) {
    var best = 0;
    String(text).replace(/RESOLUTION=(\d+)x(\d+)/gi, function (all, width, height) { best = Math.max(best, pictureHeight(+width, +height)); return all; });
    return best;
  }
  function covers(release, selection) {
    var seasons = release.info && release.info.seasons;
    if (Array.isArray(seasons) && seasons.length && seasons.every(function (n) { return (typeof n === 'number' || typeof n === 'string' && n.trim() !== '') && Number.isInteger(+n) && +n >= 0; }) && seasons.map(Number).indexOf(selection.season) < 0) return false;
    var title = release.Title || '', match = /(?:^|[\s.\[(_-])S(\d{1,2})(?:\s*[-–]\s*S?(\d{1,2}))?(?:E(\d{1,3})(?:\s*[-–]\s*E?(\d{1,3}))?)?/i.exec(title);
    if (match) return selection.season >= +match[1] && selection.season <= +(match[2] || match[1]) && (!match[3] || selection.episode >= +match[3] && selection.episode <= +(match[4] || match[3]));
    match = /сезон[ыа]?\s*:?\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/i.exec(title);
    if (!match) match = /(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*сезон/i.exec(title);
    return !match || selection.season >= +match[1] && selection.season <= +(match[2] || match[1]);
  }
  function nodes(text, selector) {
    // A detached template keeps provider HTML inert: never append it to the UI.
    var template = document.createElement('template'); template.innerHTML = text;
    return Array.prototype.map.call(template.content.querySelectorAll(selector), function (node) {
      try {
        var data = JSON.parse(node.getAttribute('data-json'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        data.text = node.textContent.trim(); data.active = node.classList.contains('active');
        if (node.getAttribute('s')) data.season = +node.getAttribute('s');
        if (node.getAttribute('e')) data.episode = +node.getAttribute('e');
        return data;
      } catch (_) { return null; }
    }).filter(Boolean);
  }
  function movieCard(value) {
    var movie = Object.assign({}, value);
    if (movie.name) movie.title = movie.name;
    return movie;
  }
