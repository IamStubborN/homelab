(function () {
  'use strict';

  if (window.homelabAccountSync) return;
  window.homelabAccountSync = true;

  var busy = false;
  var lastAttempt = -Infinity;
  var timer;
  var account = Lampa.Account;
  var lastBookmarks = JSON.stringify(Lampa.Favorite.all());

  function active() {
    return !document.hidden && !Lampa.Player.opened() && account.Permit.sync;
  }

  function sync() {
    if (!active() || busy || Date.now() - lastAttempt < 15000) return;
    lastAttempt = Date.now();
    busy = true;
    var profile = account.Permit.account.profile.id;
    try {
      account.Timeline.update();
      account.Bookmarks.update(function () {
        busy = false;
        if (!active() || account.Permit.account.profile.id !== profile) return;
        var bookmarks = JSON.stringify(Lampa.Favorite.all());
        if (bookmarks === lastBookmarks) return;
        lastBookmarks = bookmarks;
        // Native periodic sync updates its cache but does not refresh open lists.
        Lampa.Listener.send('state:changed', { target: 'favorite', reason: 'read' });
      });
    } catch (error) {
      busy = false;
      console.warn('Homelab account sync failed');
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(sync, 300);
  }

  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('focus', schedule);
  Lampa.Listener.follow('activity', function (event) {
    if (event.type === 'start') schedule();
  });
  Lampa.Activity.listener.follow('popstate', schedule);
  Lampa.Player.listener.follow('destroy', schedule);
  setInterval(sync, 60000);
  schedule();
})();
