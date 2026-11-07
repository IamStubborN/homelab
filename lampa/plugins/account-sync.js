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

  if (window.homelabAccountSync) return;
  window.homelabAccountSync = true;

  var SPACING = 15000, DEBOUNCE = 300, WATCHDOG = 30000, QUIET = 10000;
  var account = Lampa.Account;
  var generation = 0, running = 0, watchdog, timer;
  var lastAttempt = -Infinity, quietUntil = -Infinity, announcing = false, rerun = false;
  var knownProfile = profileId();
  var snapshot = signature();

  function profileId() {
    var current = account.Permit.account, profile = current && current.profile;
    return profile && profile.id !== undefined && profile.id !== null ? String(profile.id) : '';
  }

  function active() {
    return !document.hidden && !Lampa.Player.opened() && account.Permit.sync && profileId() !== '';
  }

  function cardKey(item) {
    return (item.name !== undefined || item.original_name !== undefined ? 't' : 'm') + item.id;
  }

  // Folder membership only: history and order change on every playback and must not reload screens.
  function signature() {
    var all = Lampa.Favorite.all() || {}, result = {};
    Object.keys(all).forEach(function (type) {
      var list = all[type];
      if (type === 'history' || !list || !list.length) return;
      var keys = result[type] = {};
      for (var i = 0; i < list.length; i++) if (list[i]) keys[cardKey(list[i])] = true;
    });
    return result;
  }

  function serialize(value) {
    return Object.keys(value).sort().map(function (type) {
      var keys = Object.keys(value[type]).sort();
      return keys.length ? type + ':' + keys.join(',') : '';
    }).filter(Boolean).join(';');
  }

  function release(id) {
    if (!id || running !== id) return false;
    running = 0;
    clearTimeout(watchdog);
    // A trigger arrived while this attempt was in flight; run it once spacing allows.
    if (rerun) { rerun = false; schedule(0); }
    return true;
  }

  function sync() {
    if (running) { rerun = true; return; }
    if (!active()) return;
    var now = Date.now();
    // A clock moved backwards must not stall sync for the size of the jump.
    if (lastAttempt > now + SPACING) lastAttempt = -Infinity;
    if (quietUntil > now + QUIET) quietUntil = -Infinity;
    var wait = Math.max(lastAttempt + SPACING, quietUntil) - now;
    if (wait > 0) return schedule(wait);
    lastAttempt = now;
    var id = running = ++generation;
    // Native callbacks are lost when Account.Api.clear() runs (search typing, profile loader cancel).
    watchdog = setTimeout(function () {
      if (release(id)) console.warn('Homelab account sync timed out');
    }, WATCHDOG);
    try {
      var profile = profileId();
      account.Timeline.update();
      account.Bookmarks.update(function () {
        if (!release(id)) return;
        if (profileId() !== profile) return profileSwitched();
        if (!active()) return;
        var next = signature(), changed = snapshot !== null && serialize(next) !== serialize(snapshot);
        snapshot = next;
        if (!changed) return;
        // Native periodic sync updates its cache but does not refresh open lists.
        announcing = true;
        try { Lampa.Listener.send('state:changed', { target: 'favorite', reason: 'read' }); }
        finally { announcing = false; }
      });
    } catch (error) {
      release(id);
      console.warn('Homelab account sync failed');
    }
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(sync, Math.max(DEBOUNCE, delay || 0));
  }

  function trigger() { schedule(DEBOUNCE); }

  // Native code resets and reloads bookmarks per profile; stay out of its way and take a fresh snapshot.
  function profileSwitched() {
    knownProfile = profileId();
    release(running);
    snapshot = null;
    quietUntil = Date.now() + QUIET;
  }

  if (account.listener && typeof account.listener.follow === 'function') {
    account.listener.follow('profile_select', profileSwitched);
    account.listener.follow('profile_check', function () { if (profileId() !== knownProfile) profileSwitched(); });
  }
  if (Lampa.Storage && Lampa.Storage.listener) Lampa.Storage.listener.follow('change', function (event) {
    if (event && event.name === 'account' && profileId() !== knownProfile) profileSwitched();
  });
  // Native favorite notifications already refreshed what they name; adopt only that as seen.
  // A local 'update' can follow a silent native pull (socket, 5-minute timer) that still needs a refresh.
  Lampa.Listener.follow('state:changed', function (event) {
    if (announcing || !event || event.target !== 'favorite') return;
    if (event.reason === 'profile') quietUntil = -Infinity;
    if (profileId() !== knownProfile || !account.Permit.sync) return;
    if (event.reason === 'profile' || event.reason === 'read' || event.reason === 'clear') { snapshot = signature(); return; }
    if (event.reason !== 'update' || snapshot === null || !event.type || event.type === 'history' || !event.card) return;
    var keys = snapshot[event.type] = snapshot[event.type] || {}, key = cardKey(event.card);
    if (event.method === 'remove') delete keys[key];
    else if (event.method === 'add' || event.method === 'added') keys[key] = true;
  });

  document.addEventListener('visibilitychange', trigger);
  window.addEventListener('focus', trigger);
  Lampa.Listener.follow('activity', function (event) {
    if (event.type === 'start') trigger();
  });
  Lampa.Activity.listener.follow('popstate', trigger);
  Lampa.Player.listener.follow('destroy', trigger);
  setInterval(trigger, 60000);
  trigger();
})();
