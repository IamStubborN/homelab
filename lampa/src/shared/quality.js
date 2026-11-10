// Quality labels and picture sizes, the same in every plugin.
// "4K", "UHD", "1080p", "720i", "WEB-DL 2160p" → 2160, 1080, 720, 2160; anything else → 0.
function qualityHeight(label) {
  var text = String(label || '');
  if (/\b(4k|uhd)\b/i.test(text)) return 2160;
  var match = /(?:^|\D)(2160|1440|1080|720|576|480|360)(?:p|i|\D|$)/i.exec(text);
  return match ? +match[1] : 0;
}
// A decoded or announced picture size → its quality. Width first: cinema crops (1920x800) still count as 1080p.
function pictureHeight(width, height) {
  var steps = [[3800, 2160], [2500, 1440], [1800, 1080], [1200, 720], [1000, 576], [800, 480]];
  for (var i = 0; i < steps.length; i++) if (width >= steps[i][0] || height >= steps[i][1] * 0.9) return steps[i][1];
  return width || height ? 360 : 0;
}
// 2160 → "4K", 1080 → "1080p", 0 → "".
function qualityLabel(value) { return value === 2160 ? '4K' : value ? value + 'p' : ''; }
// Heights a provider page names for a file, best first: its quality map, a tag in its text, else maxquality.
// Lampa's online screen moves the map to "qualitys" and leaves the first label in "quality".
function listedQualities(file) {
  var map = [file.quality, file.qualitys].filter(function (value) { return value && typeof value === 'object'; })[0] || {};
  var found = Object.keys(map).map(qualityHeight).filter(Boolean);
  var named = qualityHeight(file.text || file.Title || file.title) || qualityHeight(file.info && file.info.quality);
  if (named) found.push(named);
  if (!found.length && file.maxquality) { named = qualityHeight(file.maxquality); if (named) found.push(named); }
  return found.filter(function (q, i) { return found.indexOf(q) === i; }).sort(function (a, b) { return b - a; });
}
