(function install() {
  'use strict';
  if (!window.appready) {
    if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') install(); });
    return;
  }
  var L = window.Lampa, sync = window.HomelabSync, $ = window.$;
  var COMPONENT = 'homelab_sources', PLAY = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  var MAGNET = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z"/></svg>';
  var NATIVE = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2zM14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3z"/></svg>';
  var CHECK = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
  if (window.HomelabSources || !L || !sync || !$) return;
  if (!window.fetch || typeof URL !== 'function' || !('searchParams' in URL.prototype) || typeof Promise !== 'function' || !L.Component || !L.Component.add || !L.Parser || !L.Parser.get || !L.Parser.clear || !L.Scroll || !L.Controller || !L.Controller.collectionFocus) {
    // Very old TV webviews keep a visible button that explains why instead of silently missing.
    window.HomelabSources = {unsupported: true};
    if (L.Listener && L.Noty) L.Listener.follow('full', function (event) {
      if (event.type === 'complite') addButton(event.data.movie, event.object.activity.render(), function () { L.Noty.show('Общий недоступен на этом устройстве: браузер ТВ устарел. Используйте обычные источники'); });
    });
    return;
  }
  // probeCache: per page session, bounded, 30 min TTL; reopening the picker reuses measured qualities and own 404/410s.
  // paceAt: per-provider pacing, so one slow or strict provider never holds the others back.
  var parserOwner = null, paceAt = {}, probeCache = {keys: [], values: {}}, idsCache = {}, CATALOG_PARALLEL = 5, PACE = 350;
  function paced(provider) {
    if (!provider) return 0;
    var delay = Math.max(0, (paceAt[provider] || 0) - Date.now()); paceAt[provider] = Date.now() + delay + PACE; return delay;
  }
  // Tizen/webOS <= 5 lack AbortController; their fetch ignores the signal, and request() rejects on abort itself.
  function Abort() {
    if (window.AbortController) return new window.AbortController();
    var listeners = [], signal = {aborted: false, addEventListener: function (name, fn) { if (name === 'abort') listeners.push(fn); }};
    return {signal: signal, abort: function () { if (signal.aborted) return; signal.aborted = true; listeners.splice(0).forEach(function (fn) { fn(); }); }};
  }
  function always(promise, fn) { return promise.then(function (value) { fn(); return value; }, function (error) { fn(); throw error; }); }
