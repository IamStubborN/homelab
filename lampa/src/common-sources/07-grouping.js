  // ── Grouping rows into voice cards ──
  function plural(n, forms) {
    var a = n % 10, b = n % 100;
    return n + ' ' + (a === 1 && b !== 11 ? forms[0] : a >= 2 && a <= 4 && (b < 12 || b > 14) ? forms[1] : forms[2]);
  }
  var SOURCES = ['источник', 'источника', 'источников'], VARIANTS = ['вариант', 'варианта', 'вариантов'];
  // Inside one voice: playable first, then the highest quality, a measured height over a declared one.
  function bestFirst(a, b) {
    var match = (a.unavailable ? 1 : 0) - (b.unavailable ? 1 : 0); if (match) return match;
    match = seeded(b) - seeded(a); if (match) return match;
    match = rankQuality(b) - rankQuality(a); if (match) return match;
    if (a.release && b.release) { match = (Number(b.release.Seeders) || 0) - (Number(a.release.Seeders) || 0); if (match) return match; }
    match = (b.measured ? 1 : 0) - (a.measured ? 1 : 0);
    return match || String(a.providerName).localeCompare(String(b.providerName)) || a.key.localeCompare(b.key);
  }
  function groupKey(row) {
    if (row.native) return 'native';
    if (row.kind === 'torrent') return row.canon && row.canon.key ? 'torrent:' + row.canon.key + ':' + (row.qualities[0] || 0) : 'row:' + row.key;
    // Unnamed files of one provider (VK uploads) share a card instead of a card each.
    if (row.identityVoice === UNNAMED) return 'unnamed:' + row.provider;
    var canon = row.canon || (row.identityVoice ? canonVoice(row.identityVoice) : null);
    return canon && canon.key ? 'voice:' + canon.key : 'row:' + row.key;
  }
  // One card per voice across providers and spellings, one per torrent voice and quality, one for every
  // "open in the source" fallback.
  function groupRows(rows) {
    var groups = [], byKey = {};
    rows.forEach(function (row) {
      var key = groupKey(row);
      if (!byKey[key]) { byKey[key] = {key: key, rows: []}; groups.push(byKey[key]); }
      byKey[key].rows.push(row);
    });
    groups.forEach(function (group) { group.rows.sort(bestFirst); group.best = group.rows[0]; });
    return groups;
  }
