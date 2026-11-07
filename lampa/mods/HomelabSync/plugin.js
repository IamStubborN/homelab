(function install() {
  'use strict';
  // Public methods exist before native storage, favorites and menu are initialized.
  if (!window.appready) {
    var listener = window.Lampa && window.Lampa.Listener;
    if (listener && typeof listener.follow === 'function') listener.follow('app', function (event) {
      if (event.type === 'ready') install();
    });
    return;
  }
  if (window.HomelabSync) return;
  var L = window.Lampa, config = window.homelabSyncConfig;
  function unavailable() {
    console.warn('Homelab history disabled: incompatible extension API');
    if (L && L.Noty && L.Noty.show) L.Noty.show('История дома: несовместимая версия API');
  }
  if (!L || !config || config.version !== 1 || !L.Reguest || !L.Storage ||
      !L.Storage.cache || !L.Storage.set || !L.Storage.listener || !L.Timeline ||
      !L.Timeline.filename || !L.Timeline.read || !L.Timeline.listener || !L.Player ||
      !L.Player.opened || !L.Player.listener || !L.Listener || !L.Listener.follow || !L.Account || !L.Utils) return unavailable();

  var rows = [], area = '', listeners = [], request, timer, lastPull = -Infinity, enabled = true;
  var repairing = false, lastError = '', repairTimer, last = null, cursor = null, cursorKey = '', fullAt = -Infinity, incremental = true;
  // Fresh results are shared by every caller; a failure may be retried sooner.
  var FRESH = 10000, RETRY = 3000, FULL = 6 * 3600000;
  function context() {
    var account = L.Storage.get('account', {}), permit = L.Account.Permit || {};
    var profile = permit.account && permit.account.profile;
    var scope = L.Storage.get('lampac_profile_id', '');
    if (scope === '' || scope === 0) scope = permit.sync && profile && profile.id && !profile.main ? profile.id : '';
    var query = [];
    if (config.token) query.push('token=' + encodeURIComponent(config.token));
    else if (config.uid) query.push('uid=' + encodeURIComponent(config.uid));
    else if (account.email) query.push('account_email=' + encodeURIComponent(account.email));
    else {
      var uid = L.Storage.get('lampac_unic_id', '');
      if (!uid) return null; // The native TimeCode plugin owns first-time identity creation.
      query.push('uid=' + encodeURIComponent(uid));
    }
    if (scope !== '' && scope !== 0) query.push('profile_id=' + encodeURIComponent(scope));
    return { key: L.Timeline.filename() + ':' + scope + ':' + query[0], file: L.Timeline.filename(),
      url: config.url + '/timecode/dump?' + query.join('&'), query: query.join('&') };
  }
  function publish() { listeners.slice().forEach(function (fn) { fn(); }); }
  function current() {
    var ctx = context();
    if (!ctx || ctx.key !== area) { rows = []; area = ctx ? ctx.key : ''; cursor = null; cursorKey = area; last = null; fullAt = -Infinity; }
    return ctx;
  }
  function extra(row) {
    var value = {};
    try { value = JSON.parse(row.extra || '{}') || {}; } catch (error) {}
    var identity = /^(tv)-(\d+)-s(\d+)e(\d+)$/.exec(row.id || '');
    if (identity) { value.card = 'tv_' + identity[2]; value.season = +identity[3]; value.episode = +identity[4]; }
    if (!value.card && /^\d+_(tv|movie)$/.test(row.card || '')) value.card = row.card.split('_').reverse().join('_');
    return value;
  }
  function repair() {
    clearTimeout(repairTimer); repairTimer = null;
    if (repairing || !enabled) return;
    var ctx = current();
    if (!ctx) return;
    var viewed = L.Storage.cache(ctx.file, 10000, {}), changed = false, claims = {};
    rows.forEach(function (row) {
      if (!row.hash) return;
      var card = row.card || extra(row).card;
      claims[row.hash] = claims[row.hash] === undefined ? card : claims[row.hash] === card ? card : false;
    });
    rows.forEach(function (row) {
      if (!row.hash || !claims[row.hash]) return;
      var old = viewed[row.hash], metadata = extra(row);
      if (old && old.card && metadata.card && old.card !== metadata.card) return;
      if (old && (old.updated || 0) > row.watched_at) return;
      var road = Object.assign({}, old, metadata, {
        time: row.deleted ? 0 : row.position, duration: row.duration,
        percent: row.deleted ? 0 : row.percent, updated: row.watched_at, profile: row.profile || 0
      });
      if (row.id) road.id = row.id;
      if (JSON.stringify(old) === JSON.stringify(road)) return;
      viewed[row.hash] = road; changed = true;
    });
    if (!changed) return;
    repairing = true;
    try { L.Storage.set(ctx.file, viewed, true); L.Timeline.read(); }
    finally { repairing = false; }
  }
  // Native batches (CUB changelog, dump reads) emit one Timeline event per row.
  function scheduleRepair() { if (!repairing && !repairTimer) repairTimer = setTimeout(repair, 50); }
  function rowKey(row) { return row.id ? 'i:' + row.id : 'h:' + row.card + '|' + row.hash; }
  function merge(changes) {
    var map = {}, order = [];
    rows.forEach(function (row) { var key = rowKey(row); if (!map[key]) order.push(key); map[key] = row; });
    changes.forEach(function (row) {
      // A web-created row gains an identity on its first native write.
      if (row.id) delete map['h:' + row.card + '|' + row.hash];
      var key = rowKey(row); if (!(key in map)) order.push(key); map[key] = row;
    });
    rows = order.filter(function (key) { return map[key]; }).map(function (key) { return map[key]; });
  }
  function validRows(list) {
    return list.every(function (row) {
      return row && Number.isFinite(row.watched_at) && Number.isFinite(row.position) &&
        Number.isFinite(row.duration) && Number.isFinite(row.percent);
    });
  }
  function pull(done) {
    done = done || function () {};
    if (!enabled) return done(new Error('incompatible'));
    var ctx = current();
    if (!ctx) return done(new Error('identity'));
    if (request && request.ctx.url === ctx.url && request.ctx.key === ctx.key) { request.callbacks.push(done); return; }
    if (!request && last && last.key === ctx.key && Date.now() - last.at < (last.error ? RETRY : FRESH)) return done(last.error ? new Error(last.error) : undefined);
    if (request) { var previous = request; request = null; previous.net.clear(); finish(previous, new Error('profile')); }
    var pending = { ctx: ctx, net: new L.Reguest(), callbacks: [done], pages: 0 };
    request = pending; lastPull = Date.now(); pending.net.timeout(10000);
    fetchPage(pending);
  }
  function fetchPage(pending) {
    var ctx = pending.ctx, full = !incremental || cursor === null || cursorKey !== ctx.key || Date.now() - fullAt > FULL;
    var url = full ? ctx.url : config.url + '/timecode/changelog?since=' + encodeURIComponent(cursor) + '&' + ctx.query;
    pending.net.silent(url, function (dump) {
      if (request !== pending) return;
      var now = current();
      if (!now || now.key !== ctx.key || now.url !== ctx.url) return finish(pending, new Error('profile'));
      if (!dump || !Array.isArray(dump.rows)) {
        if (dump && dump.success === false) return finish(pending, new Error('access'));
        // Older Lampac without a changelog: fall back to full dumps.
        if (!full) { incremental = false; return fetchPage(pending); }
        enabled = false; unavailable(); return finish(pending, new Error('incompatible'));
      }
      if (!validRows(dump.rows)) { enabled = false; unavailable(); return finish(pending, new Error('incompatible')); }
      if (full) { rows = dump.rows.slice(); fullAt = Date.now(); } else merge(dump.rows);
      cursor = Number.isFinite(dump.version) ? dump.version : null; cursorKey = ctx.key;
      if (!full && dump.truncated === true && cursor !== null && ++pending.pages < 20) return fetchPage(pending);
      repair(); finish(pending); publish();
    }, function (xhr) {
      if (request !== pending) return;
      var status = xhr && xhr.status;
      // An older Lampac answers the unknown changelog route with a client error.
      if (!full && status >= 400 && status < 500 && [401, 403, 429].indexOf(status) < 0) { incremental = false; return fetchPage(pending); }
      finish(pending, new Error('network'));
    });
  }
  function finish(pending, error) {
    if (request === pending) request = null;
    lastError = error ? error.message : '';
    if (!error || error.message !== 'profile') last = { key: pending.ctx.key, at: Date.now(), error: lastError };
    pending.callbacks.splice(0).forEach(function (callback) { callback(error); });
    if (error && error.message !== 'profile') publish();
  }
  function schedule() {
    clearTimeout(timer);
    if (!enabled || document.hidden || L.Player.opened()) return;
    timer = setTimeout(function () { if (!L.Player.opened()) pull(); }, Math.max(300, 15000 - (Date.now() - lastPull)));
  }
  window.HomelabSync = {
    pull: pull, rows: function () { current(); return rows.slice(); }, extra: extra,
    scope: function () { var ctx = current(); return ctx ? ctx.key : ''; },
    error: function () { return lastError; },
    url: function (path) { var ctx = current(); return ctx ? ctx.url.replace('/timecode/dump?', path + '?') : null; },
    subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (value) { return value !== fn; }); }; }
  };
  L.Timeline.listener.follow('read', scheduleRepair);
  L.Timeline.listener.follow('update', scheduleRepair);
  L.Storage.listener.follow('change', function (e) { if (['account', 'account_use', 'lampac_profile_id'].indexOf(e.name) !== -1) { current(); publish(); schedule(); } });
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('focus', schedule);
  window.addEventListener('pageshow', schedule);
  L.Listener.follow('activity', function (e) { if (e.type === 'start') schedule(); });
  L.Player.listener.follow('destroy', schedule);
  setInterval(schedule, 60000);
  schedule();
})();

// Keep explicit viewed removals ahead of native WorkerArray's delayed additions.
(function installCubViewedGuard() {
  'use strict';
  var L = window.Lampa;
  if (!window.appready) {
    if (L && L.Listener && typeof L.Listener.follow === 'function') L.Listener.follow('app', function (event) { if (event.type === 'ready') installCubViewedGuard(); });
    return;
  }
  if (window.homelabCubViewedGuard || !L || !L.Socket || typeof L.Socket.send !== 'function' || !L.Storage || typeof L.Storage.get !== 'function' || !L.Storage.listener || typeof L.Storage.listener.follow !== 'function' || !L.Account || !L.Account.Permit) return;
  var send = L.Socket.send, origins = new Map(), removed = new Map(), generation = 0, cleaned = -1, area, previous;
  function primitive(value) { return typeof value === 'string' && value.length <= 10000 || typeof value === 'number' && Number.isFinite(value); }
  function values(value) { return Array.isArray(value) ? value.slice(-5000).filter(primitive) : []; }
  function present() { return new Set(values(L.Storage.get('online_view', []))); }
  function scope() {
    var account = L.Storage.get('account', {}), profile = account && account.profile;
    return L.Account.Permit.sync && account && typeof account.token === 'string' && account.token && profile && (typeof profile.id === 'string' || typeof profile.id === 'number') ? JSON.stringify([account.token, String(profile.id)]) : '';
  }
  function current() {
    var next = scope();
    if (next !== area) { area = next; previous = present(); removed.clear(); cleaned = -1; }
    return next;
  }
  function remember(map, value, record) {
    map.delete(value); map.set(value, record);
    // Native viewed history is capped at 5000; evicted metadata stays unknown.
    if (map.size > 5000) map.delete(map.keys().next().value);
  }
  current();
  L.Storage.listener.follow('change', function (event) {
    var area = current();
    if (event.name !== 'online_view') return;
    var next = new Set(values(event.value));
    if (area) next.forEach(function (value) { if (!previous.has(value)) remember(origins, value, {scope: area, generation: ++generation}); });
    previous = next;
  });
  L.Socket.send = function (method, data) {
    var params = data && data.params;
    if (method === 'storage' && params && params.name === 'online_view' && params.id === null) {
      var area = current(), value = params.value, origin = origins.get(value);
      if (params.clean === true) {
        if (area) { removed.clear(); cleaned = generation; }
      } else if (primitive(value)) {
        if (params.remove === true) {
          if (area) remember(removed, value, true);
        } else {
          if (origin && origin.scope !== area) return;
          if (area && (removed.has(value) || origin && origin.generation <= cleaned)) {
            if (!present().has(value)) return;
            removed.delete(value);
          }
        }
      }
    }
    return send.apply(this, arguments);
  };
  window.homelabCubViewedGuard = true;
})();
