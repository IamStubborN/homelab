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
  var lastAttempt = -Infinity, quietUntil = 0, announcing = false;
  var knownProfile = profileId();
  var snapshot = signature();

  function profileId() {
    var current = account.Permit.account, profile = current && current.profile;
    return profile && profile.id !== undefined && profile.id !== null ? String(profile.id) : '';
  }

  function active() {
    return !document.hidden && !Lampa.Player.opened() && account.Permit.sync && profileId() !== '';
  }

  // Folder membership only: history and order change on every playback and must not reload screens.
  function signature() {
    var all = Lampa.Favorite.all() || {}, parts = [];
    Object.keys(all).sort().forEach(function (type) {
      var list = all[type];
      if (type === 'history' || !list || !list.length) return;
      var keys = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (item) keys.push((item.name !== undefined || item.original_name !== undefined ? 't' : 'm') + item.id);
      }
      parts.push(type + ':' + keys.sort().join(','));
    });
    return parts.join(';');
  }

  function release(id) {
    if (!id || running !== id) return false;
    running = 0;
    clearTimeout(watchdog);
    return true;
  }

  function sync() {
    if (running || !active()) return;
    var wait = Math.max(lastAttempt + SPACING, quietUntil) - Date.now();
    if (wait > 0) return schedule(wait);
    lastAttempt = Date.now();
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
        if (profileId() !== profile) { snapshot = null; return; }
        if (!active()) return;
        var next = signature();
        if (snapshot === null || next === snapshot) { snapshot = next; return; }
        snapshot = next;
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
  // Native favorite notifications already refreshed what they changed; adopt that state as seen.
  Lampa.Listener.follow('state:changed', function (event) {
    if (announcing || !event || event.target !== 'favorite') return;
    if (event.reason === 'profile') quietUntil = 0;
    if (profileId() === knownProfile && account.Permit.sync) snapshot = signature();
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
