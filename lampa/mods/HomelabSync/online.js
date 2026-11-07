(function install() {
  'use strict';
  if (!window.appready) {
    if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
    return;
  }
  var L = window.Lampa, sync = window.HomelabSync;
  if (window.HomelabOnlineResume || !L || !sync || !L.Component || !L.Component.get || !L.Component.add || !L.Activity || !L.Activity.push || !L.Activity.active) return;
  var pending = null, sequence = 0, attempts = 0, specialWorks = typeof WeakMap === 'function' ? new WeakMap() : null, specialTimer;
  var specialSupport = specialWorks && L.PlayerPlaylist && L.PlayerPlaylist.listener && L.Timeline && L.Utils &&
    [L.PlayerPlaylist.listener.follow, L.PlayerPlaylist.get, L.Player.playlist, L.Player.playdata, L.Player.opened, L.Player.close, L.Timeline.view, L.Timeline.link, L.Timeline.render, L.Utils.hash].every(function (fn) { return typeof fn === 'function'; });
  function special(file) { return file && file.season === 0 && Number.isInteger(file.episode) && file.episode > 0; }
  function refreshSpecials(work) { var refresh = specialWorks && work && specialWorks.get(work); if (refresh) refresh(); }
  function valid(source) {
    var season = source && source.season_index === undefined ? 0 : source && source.season_index;
    return source && /^[a-z0-9_.-]{1,80}$/i.test(source.provider) && typeof source.voice === 'string' && source.voice.length <= 200 && Number.isInteger(season) && season >= 0 && season <= 999 &&
      (source.text === undefined || source.text === null || typeof source.text === 'string' && source.text.length <= 200) &&
      (source.match === undefined || source.match === null || validMatch(source.match));
  }
  function short(value) { return value === undefined || value === null || typeof value === 'string' && value.length <= 200; }
  // A movie row position from the picker (url only for this session) or a capture.
  function validMatch(match) {
    // The server omits a zero index on read.
    var index = match && match.index === undefined ? 0 : match && match.index;
    return typeof match === 'object' && Number.isInteger(index) && index >= 0 && index < 10000 &&
      (match.count === undefined || Number.isInteger(match.count) && match.count > index && match.count <= 10000) &&
      (match.url === undefined || typeof match.url === 'string' && match.url.length <= 4000) &&
      short(match.text) && short(match.translate) && short(match.voice_name);
  }
  function clean(value) { return String(value || '').trim(); }
  // Native movie rows show the title for quality-only or default labels.
  function movieText(file, movie) {
    var text = clean(file && file.text);
    return /\d+p/i.test(text) || text === 'По умолчанию' ? clean(movie && (movie.title || movie.name)) : text;
  }
  // Movie rows of some providers carry a release tag ("WEB-DL", "2160p") in
  // voice_name and the dub in translate/text, so both identify a movie row.
  function rowText(file) { return String(file && (file.translate || file.text) || '').slice(0, 200); }
  function rowMatches(item, file, provider) {
    var source = item.online;
    if (provider !== source.provider || file.voice_name !== source.voice) return false;
    return item.card.indexOf('movie_') !== 0 || !source.text || rowText(file) === source.text;
  }
  function cancel() { if (pending) { pending.cancelled = true; clearTimeout(pending.timer); pending = null; } }
  // Same label to height mapping as the source picker ("4K" is 2160, not 4).
  function height(label) {
    var text = String(label || '');
    if (/\b(4k|uhd)\b/i.test(text)) return 2160;
    var match = /(?:^|\D)(2160|1440|1080|720|576|480|360)(?:p|i|\D|$)/i.exec(text);
    return match ? +match[1] : 0;
  }
  // Any key, click or touch in the opened component hands control to the user.
  function interrupted() {
    var intent = pending;
    if (!intent || intent.opening || intent.finished || Date.now() - intent.created < 500 || L.Activity.active() !== intent.activity) return;
    cancel();
  }
  if (L.Keypad && L.Keypad.listener && typeof L.Keypad.listener.follow === 'function') L.Keypad.listener.follow('keydown', interrupted);
  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') ['mousedown', 'touchstart'].forEach(function (name) { document.addEventListener(name, interrupted, true); });
  function live(intent, object) { return !intent.cancelled && !intent.finished && sync.scope() === intent.scope && L.Activity.active() === object && !L.Player.opened(); }
  function fail(intent, reason) {
    if (pending !== intent || !live(intent, intent.activity)) return;
    intent.finished = true; clearTimeout(intent.timer);
    if (typeof intent.failed === 'function') intent.failed(reason);
  }
  function sameFile(item, file) {
    return item.card.indexOf('movie_') === 0 || Number.isInteger(file.season) && file.season >= 0 && Number.isInteger(file.episode) && file.episode > 0 && file.season === item.season && file.episode === item.episode;
  }
  function wrap() {
    var Original = L.Component.get('lampac');
    if (typeof Original !== 'function') return false;
    if (Original.homelabOnlineResume) return true;
    function Component(object) {
      var comp = new Original(object), provider = object.balanser || '', intent = pending && object.homelab_online_intent === pending.id ? pending : null;
      if (![comp.toPlayElement, comp.startSource, comp.getChoice, comp.replaceChoice, comp.draw, comp.getFileUrl, comp.destroy].every(function (fn) { return typeof fn === 'function'; })) return comp;
      var source = comp.startSource, play = comp.toPlayElement, draw = comp.draw, resolve = comp.getFileUrl, destroy = comp.destroy;
      var specials = null, disposed = false, requestId = 0, drawn = null;
      function owns(batch) { return !disposed && specials === batch && sync.scope() === batch.scope && L.Activity.active() === object && provider === batch.provider; }
      function specialRoad(file) {
        var movie = object.movie, hash = L.Utils.hash([0, '', file.episode, movie.original_title || movie.original_name].join(''));
        return file.timeline && String(file.timeline.hash) === String(hash) ? file.timeline : L.Timeline.view(hash, L.Timeline.link(movie, 0, file.episode));
      }
      function specialViewed(file, html, data, batch) {
        if (!L.Template || typeof L.Template.get !== 'function' || typeof L.Storage.cache !== 'function' || !html || typeof html.find !== 'function' || !data || typeof file.mark !== 'function' || typeof file.voice_name !== 'string') return;
        var legacy = data.hash_behold;
        if (typeof legacy !== 'number' && typeof legacy !== 'string') return;
        var records = batch.marks || (batch.marks = new WeakMap()), record = records.get(file);
        if (record && file.mark === record.mark) { record.html = html; return record.paint(); }
        var original = file.mark, movie = object.movie, hash = L.Utils.hash([0, '', file.episode, movie.original_title || movie.original_name, file.voice_name].join(''));
        record = {html: html};
        function viewed() { var values = L.Storage.get('online_view', []); return Array.isArray(values) ? values : []; }
        record.paint = function () {
          record.html.find('.online-prestige__viewed').remove();
          if (viewed().indexOf(hash) !== -1) record.html.find('.online-prestige__img').append('<div class="online-prestige__viewed">' + L.Template.get('icon_viewed', {}, true) + '</div>');
        };
        file.mark = record.mark = function () {
          if (!owns(batch)) return;
          var existed = viewed().indexOf(legacy) !== -1, store = L.Storage.set;
          L.Storage.set = function (name) {
            var args = Array.prototype.slice.call(arguments);
            if (name === 'online_view') args[2] = true;
            return store.apply(this, args);
          };
          try { original.apply(this, arguments); } finally { L.Storage.set = store; }
          if (!owns(batch)) return;
          var values = viewed().filter(function (value) { return existed || value !== legacy; });
          if (values.indexOf(hash) === -1) values.push(hash);
          L.Storage.set('online_view', values.slice(-5000));
          if (!existed && typeof L.Storage.remove === 'function') L.Storage.remove('online_view', legacy);
          record.paint();
        };
        file.unmark = function () {
          if (!owns(batch)) return;
          L.Storage.set('online_view', viewed().filter(function (value) { return value !== hash; }));
          if (typeof L.Storage.remove === 'function') L.Storage.remove('online_view', hash);
          record.paint();
        };
        records.set(file, record); record.paint();
      }
      function lazyPeer(file, batch) {
        var cell = comp.toPlayElement(file), marked = cell.callback;
        cell.callback = function () {
          if (!owns(batch) || L.Player.playdata() !== cell) return;
          if (typeof marked === 'function') marked();
          if (cell.subtitles_call && typeof comp.loadSubtitles === 'function') comp.loadSubtitles(cell.subtitles_call);
        };
        cell.url = function (done) {
          var token = ++requestId, previous = L.Player.playdata();
          function current() { return token === requestId && owns(batch) && L.Player.opened() && L.Player.playdata() === previous && L.PlayerPlaylist.get() === batch.playlist; }
          function unavailable() {
            if (!current()) return;
            var movie = object.movie, identity = cell.homelab_online;
            L.Player.close();
            setTimeout(function () {
              if (token !== requestId || !owns(batch) || L.Player.opened()) return;
              var picker = window.HomelabSources, item = {card: 'tv_' + movie.id, season: 0, episode: file.episode, position: 0, duration: 0, online: identity};
              if (picker && typeof picker.resume === 'function' && picker.resume(item, movie)) return;
              L.Noty.show('Серия недоступна. Выберите источник');
              L.Activity.push({component: 'lampac', movie: movie, title: 'Онлайн', search: movie.title || movie.name, search_one: movie.title || movie.name, search_two: movie.original_title || movie.original_name, page: 1, lampac_custom_select: identity.provider});
            }, 0);
          }
          try {
            resolve.call(comp, file, function (stream, metadata) {
              if (!current()) return;
              if (!stream || typeof stream.url !== 'string' || !stream.url) return unavailable();
              metadata = metadata || {};
              cell.url = stream.url; cell.headers = metadata.headers || stream.headers;
              cell.quality = metadata.quality || file.qualitys;
              cell.segments = metadata.segments || file.segments; cell.subtitles = stream.subtitles || file.subtitles;
              cell.subtitles_call = metadata.subtitles_call || stream.subtitles_call;
              cell.hls_manifest_timeout = metadata.hls_manifest_timeout || stream.hls_manifest_timeout;
              if (stream.vast && stream.vast.url) ['url', 'msg', 'region', 'platform', 'screen'].forEach(function (name) { cell['vast_' + name] = stream.vast[name]; });
              cell.isonline = true;
              if (typeof comp.orUrlReserve === 'function') comp.orUrlReserve(cell);
              if (typeof comp.setDefaultQuality === 'function') comp.setDefaultQuality(cell);
              done();
            }, true);
          } catch (_) { unavailable(); }
        };
        return cell;
      }
      function rememberSpecial(work, file, batch) {
        specialWorks.set(work, function () {
          if (!owns(batch) || !L.Player.opened() || L.Player.playdata() !== work) return;
          clearTimeout(specialTimer);
          specialTimer = setTimeout(function () {
            if (!owns(batch) || !L.Player.opened() || L.Player.playdata() !== work) return;
            var shown = L.PlayerPlaylist.get();
            if (!Array.isArray(shown) || shown.length !== 1 || shown[0] !== work) return;
            if (!batch.playlist) {
              var files = batch.files.filter(function (entry) { return entry.voice_name === work.homelab_online.voice; }).slice().sort(function (a, b) { return a.episode - b.episode; });
              if (files.length < 2) return;
              batch.files = files;
              batch.playlist = files.map(function (entry) { return entry === file ? work : lazyPeer(entry, batch); });
            } else batch.playlist[batch.files.indexOf(file)] = work;
            L.Player.playlist(batch.playlist);
          }, 0);
        });
      }
      comp.startSource = function () {
        return Promise.resolve(source.apply(comp, arguments)).then(function (result) { provider = L.Storage.get('active_balanser', ''); return result; });
      };
      comp.toPlayElement = function (file) {
        var work = play.apply(comp, arguments), movie = object.movie, choice = comp.getChoice(provider);
        var identity = {provider: provider, voice: String(file.voice_name || choice.voice_name || ''), season_index: choice.season || 0};
        if (movie && !movie.name && rowText(file)) identity.text = rowText(file);
        // Record the row position for a later resume (never its resolver url).
        var position = movie && !movie.name && drawn ? drawn.indexOf(file) : -1;
        if (position >= 0) identity.match = {index: position, count: drawn.length, text: movieText(file, movie).slice(0, 200), translate: clean(file.translate).slice(0, 200), voice_name: clean(file.voice_name).slice(0, 200)};
        if (movie && Number.isInteger(movie.id) && ['tmdb', 'cub'].indexOf(movie.source || 'tmdb') >= 0 && valid(identity)) {
          work.card = movie; work.homelab_online = identity;
          if (specialSupport && movie.name && special(file) && specials && specials.files.indexOf(file) >= 0) {
            work.timeline = specialRoad(file); rememberSpecial(work, file, specials);
          }
          if (intent && Number.isFinite(intent.item.position) && intent.opening && !intent.positionApplied && live(intent, object) && sameFile(intent.item, file) && intent.chosen === file) {
            intent.positionApplied = true;
            work.homelab_resume_at = intent.item.position;
            if (intent.fromDuration > 0) work.homelab_resume_from_duration = intent.fromDuration;
            if (work.timeline) { work.timeline.percent = 0; work.timeline.time = 0; }
          }
        }
        return work;
      };
      comp.getFileUrl = function (file, callback) {
        requestId++;
        var args = Array.prototype.slice.call(arguments), guarded = intent && intent.opening && !intent.finished;
        if (guarded) args[1] = function () { if (live(intent, object)) callback.apply(this, arguments); };
        return resolve.apply(comp, args);
      };
      if (typeof comp.setDefaultQuality === 'function') {
        var defaultQuality = comp.setDefaultQuality;
        comp.setDefaultQuality = function (work) {
          defaultQuality.apply(comp, arguments);
          if (intent && intent.quality && work.quality) Object.keys(work.quality).some(function (key) {
            if (height(key) !== intent.quality) return false;
            work.url = work.quality[key];
            // Native Player.play applies the global default again for multi-quality maps.
            var chosen = {}; chosen[key] = work.quality[key]; work.quality = chosen; return true;
          });
        };
      }
      comp.draw = function (items, params) {
        requestId++; drawn = Array.isArray(items) ? items : null;
        var batch = specials = specialSupport && object.movie.name && items.some(special) ? {files: items.filter(special), scope: sync.scope(), provider: provider, playlist: null} : null;
        if (!batch && (!intent || intent.finished || intent.cancelled)) return draw.apply(comp, arguments);
        params = Object.assign({}, params || {});
        var rendered = params.onRender, round = null;
        // Native rendering is one synchronous loop per draw; decide after it,
        // so a saved voice that is not the first row (movies) still matches.
        params.onRender = function (file, html, data) {
          if (batch && owns(batch) && special(file)) {
            file.timeline = specialRoad(file);
            if (html && typeof html.find === 'function') html.find('.online-prestige__timeline').empty().append(L.Timeline.render(file.timeline));
            specialViewed(file, html, data, batch);
          }
          if (rendered) rendered.apply(this, arguments);
          if (!intent || intent.finished || intent.cancelled || intent.opening) return;
          if (!round) {
            var current = round = {match: null, matches: 0, mismatch: false, known: false, rows: []};
            setTimeout(function () { if (round === current) round = null; decide(current); }, 0);
          }
          if (Number.isInteger(file.season) && file.season >= 0 && Number.isInteger(file.episode) && file.episode > 0) round.known = true;
          round.rows.push({file: file, html: html, data: data});
          if (!sameFile(intent.item, file)) return;
          if (rowMatches(intent.item, file, provider)) { round.matches++; if (!round.match) round.match = {file: file, html: html, data: data}; }
          else round.mismatch = true;
        };
        // Movie rows: exact url (this session), else the same position on an
        // identical page, each confirmed by translation/text.
        function confirmed(file, match) {
          if (clean(match.voice_name) && clean(file.voice_name) && clean(file.voice_name) !== clean(match.voice_name)) return false;
          if (clean(match.translate) && clean(file.translate)) return clean(file.translate) === clean(match.translate);
          if (clean(match.text)) return movieText(file, object.movie) === clean(match.text);
          return true;
        }
        function movieRow(result, match) {
          if (provider !== intent.item.online.provider) return {reason: 'changed'};
          if (match.url) {
            var byUrl = result.rows.filter(function (row) { return row.file.url === match.url; });
            if (byUrl.length > 1) return {reason: 'ambiguous'};
            if (byUrl.length === 1) return confirmed(byUrl[0].file, match) ? {row: byUrl[0]} : {reason: 'changed'};
          }
          var at = result.rows.find(function (row) { return items.indexOf(row.file) === (match.index || 0); });
          if (at && (match.count === undefined || match.count === items.length) && confirmed(at.file, match)) return {row: at};
          var similar = result.rows.filter(function (row) { return (clean(match.translate) || clean(match.text)) && confirmed(row.file, match); });
          if (similar.length > 1) return {reason: 'ambiguous'};
          return similar.length ? {row: similar[0]} : {reason: 'changed'};
        }
        function decide(result) {
          if (!intent || !live(intent, object) || intent.opening) return;
          var match = intent.item.card.indexOf('movie_') === 0 && intent.item.online.match;
          if (match) {
            var found = movieRow(result, match);
            if (!found.row) return fail(intent, found.reason);
            result = {match: found.row, matches: 1};
          }
          if (!result.match) {
            if (result.mismatch) fail(intent, 'changed');
            else if (result.known && intent.item.card.indexOf('tv_') === 0) fail(intent, 'missing');
            return;
          }
          // Several equal movie rows cannot be told apart: never guess.
          if (result.matches > 1 && intent.item.card.indexOf('movie_') === 0) return fail(intent, 'ambiguous');
          if (typeof params.onEnter !== 'function') return;
          intent.opening = true; intent.chosen = result.match.file;
          params.onEnter(result.match.file, result.match.html, result.match.data);
        }
        return draw.call(comp, items, params);
      };
      comp.destroy = function () { disposed = true; requestId++; if (intent && !intent.finished) { intent.cancelled = true; clearTimeout(intent.timer); } return destroy.apply(comp, arguments); };
      if (intent) {
        // Native choices are movie/provider scoped; seed only the requested source.
        // Native display() names unlabeled rows after choice.voice_name, so a
        // seeded name would make every movie row look like the saved voice.
        var seed = {season: intent.item.online.season_index, voice_url: ''};
        if (intent.item.card.indexOf('tv_') === 0) seed.voice_name = intent.item.online.voice;
        comp.replaceChoice(seed, intent.item.online.provider);
      }
      return comp;
    }
    Component.homelabOnlineResume = true;
    L.Component.add('lampac', Component);
    return true;
  }
  function resume(item, movie, failed, options) {
    cancel();
    if (!valid(item.online) || !wrap()) return false;
    // Explorer supplies a "film not found" title when a TV card has only name.
    movie = Object.assign({}, movie);
    if (movie.name) movie.title = movie.name;
    item = Object.assign({}, item, {online: Object.assign({}, item.online, {season_index: item.online.season_index === undefined ? 0 : item.online.season_index})});
    var intent = pending = {id: ++sequence, item: item, scope: sync.scope(), cancelled: false, failed: failed, quality: options && options.quality, fromDuration: options && options.fromDuration, created: Date.now()};
    intent.timer = setTimeout(function () { fail(intent, 'timeout'); }, 60000);
    var activity = intent.activity = {component: 'lampac', movie: movie, title: 'Онлайн', url: '', search: movie.title || movie.name,
      search_one: movie.title || movie.name, search_two: movie.original_title || movie.original_name, page: 1,
      lampac_custom_select: item.online.provider, homelab_online_intent: intent.id};
    L.Activity.push(activity);
    return true;
  }
  function select(row, movie, selection, quality, recovery) {
    if (recovery && recovery.scope !== sync.scope()) return false;
    var item = {card: (movie.name ? 'tv_' : 'movie_') + movie.id, season: selection.season, episode: selection.episode, position: recovery ? recovery.position : null,
      online: {provider: row.provider, voice: row.identityVoice, season_index: row.seasonIndex}};
    if (!movie.name && row.match && validMatch(row.match)) item.online.match = row.match;
    return resume(item, movie, function (reason) { L.Noty.show(reason === 'changed' ? 'Вариант изменился. Выберите озвучку в источнике' : reason === 'ambiguous' ? 'Подходит несколько вариантов. Выберите нужный в источнике' : 'Источник не ответил. Выберите другой вариант'); }, {quality: quality, fromDuration: recovery && recovery.duration});
  }
  window.HomelabOnlineResume = {resume: resume, select: select, cancel: cancel, valid: valid};
  L.Player.listener.follow('ready', function (work) {
    if (pending) { pending.finished = true; clearTimeout(pending.timer); }
    refreshSpecials(work);
  });
  if (specialSupport) {
    L.PlayerPlaylist.listener.follow('set', function () { refreshSpecials(L.Player.playdata()); });
    L.Player.listener.follow('destroy', function () { clearTimeout(specialTimer); });
  }
  function ready() { if (!wrap() && ++attempts < 120) setTimeout(ready, 500); }
  ready();
})();

// Load the independent picker from the existing read-only plugins directory.
(function () {
  var L = window.Lampa, config = window.homelabSyncConfig;
  if (window.homelabSourcesLoading || window.HomelabSources || !L || !L.Utils || typeof L.Utils.putScriptAsync !== 'function' || !config || !config.url) return;
  window.homelabSourcesLoading = true;
  L.Utils.putScriptAsync([config.url + '/plugins/homelab/common-sources.js?v=20261108a', config.url + '/plugins/homelab/playlist-thumbnails.js?v=20261108a'], function () { window.homelabSourcesLoading = false; });
})();
