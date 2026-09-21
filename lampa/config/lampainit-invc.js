// Homelab defaults injected into the generated Lampac Lampa bootstrap.
var lampainit_invc = {};

(function () {
  'use strict';

  var readyForPlugins = false;

  function applyRuntimeSettings() {
    var origin = window.location.origin;
    var useTorrserverGst = typeof Platform === 'undefined' ||
      typeof Platform.is !== 'function' ||
      !Platform.is('android');

    Lampa.Storage.set('torrserver_url', origin + '/torrserver');
    Lampa.Storage.set('internal_torrclient', true);
    Lampa.Storage.set('torrserver_use_link', 'one');
    Lampa.Storage.set('torrserver_savedb', true);
    // Browser playback needs TorrServer's HLS transcoder for AC-3/E-AC-3;
    // Android TV keeps the native/Vimu path instead.
    Lampa.Storage.set('torrserver_gts', useTorrserverGst);
    Lampa.Storage.set('prowlarr_url', origin + '/prowlarr');
    Lampa.Storage.set('prowlarr_key', '__PROWLARR_KEY__');
    Lampa.Storage.set('parser_use', 'true');
    Lampa.Storage.set('parser_torrent_type', 'prowlarr');
    Lampa.Storage.set('parse_in_search', 'true');
    Lampa.Storage.set('parse_timeout', '30');
    Lampa.Storage.set('online_balanser', 'kinobase');
    Lampa.Storage.set('video_quality_default', '2160');
  }

  function patchParser() {
    var torrserverProxyOrigin = 'http://traefik';

    // Prowlarr may return Docker-internal download URLs. TorrServer runs in
    // another network namespace, so expose those URLs through Traefik's
    // internal Docker-DNS route before handing them to TorrServer.
    if (Lampa.Parser && typeof Lampa.Parser.get === 'function' && !Lampa.Parser.__homelabTorrentParserPatched) {
      var parserGet = Lampa.Parser.get;
      Lampa.Parser.get = function patchedParserGet(params, oncomplete, onerror) {
        return parserGet.call(this, params, function (data) {
          if (data && Array.isArray(data.Results)) {
            data.Results.forEach(function (item) {
              if (typeof item.MagnetUri !== 'string' || item.MagnetUri.indexOf('://') === -1) return;

              try {
                var parsed = new URL(item.MagnetUri);
                if (parsed.pathname.indexOf('/download') === -1) return;

                item.MagnetUri = torrserverProxyOrigin + '/prowlarr' + parsed.pathname + parsed.search;
                item.Link = item.MagnetUri;
              } catch (error) {}
            });
          }

          if (typeof oncomplete === 'function') oncomplete(data);
        }, onerror);
      };
      Lampa.Parser.__homelabTorrentParserPatched = true;
    }
  }

  function installPlugins() {
    var origin = window.location.origin;

    // The plugin registry is ready only after Lampa opens its IndexedDB.
    if (!Lampa.Plugins || typeof Lampa.Plugins.get !== 'function') return;

    Lampa.Plugins.get().forEach(function (plugin) {
      if (typeof plugin.url !== 'string') return;
      if (plugin.url.indexOf('la,padocker') === -1 && plugin.url.indexOf('stunnorm') === -1) return;
      if (typeof Lampa.Plugins.remove === 'function') Lampa.Plugins.remove(plugin.url);
    });

    if (typeof Lampa.Plugins.save === 'function') Lampa.Plugins.save();

    // Re-activate Lampac's built-in plugins even when an older bootstrap
    // already left their records in Lampa storage. In that case the normal
    // bootstrap skips them as "already installed" without executing them
    // during the current page load.
    var lampacPlugins = [
      {
        url: origin + '/tmdbproxy.js',
        status: 1,
        name: 'TMDB Proxy',
        author: 'lampac'
      },
      {
        url: origin + '/cubproxy.js',
        status: 1,
        name: 'CUB Proxy',
        author: 'lampac'
      },
      {
        url: origin + '/online.js',
        status: 1,
        name: 'Онлайн',
        author: 'lampac'
      }
    ];

    lampacPlugins.forEach(function (plugin) {
      var existing = Lampa.Plugins.get().find(function (item) {
        return item.url === plugin.url;
      });

      if (!existing) {
        Lampa.Plugins.add(plugin);
      } else {
        existing.status = 1;
        if (typeof Lampa.Plugins.push === 'function') Lampa.Plugins.push(existing);
      }
    });

    if (typeof Lampa.Plugins.save === 'function') Lampa.Plugins.save();

    var yummyAnime = 'https://yummyanime.github.io/yummy-lampa-plugin/stable/index.js';
    if (!Lampa.Plugins.get().some(function (plugin) { return plugin.url === yummyAnime; })) {
      Lampa.Plugins.add({
        url: yummyAnime,
        status: 1,
        name: 'YummyAnime',
        author: 'YummyAnime'
      });
      Lampa.Plugins.save();
      Lampa.Utils.putScriptAsync([yummyAnime], function () {});
    }
  }

  lampainit_invc.appload = function appload() {
    applyRuntimeSettings();
    patchParser();

    // The first hook runs before Lampa opens its IndexedDB. Defer all plugin
    // writes until appready, while still applying playback/storage settings.
    if (!readyForPlugins) return;
    installPlugins();
  };

  // Lampac calls this hook after Lampa has initialized its database and
  // plugin registry. Reuse the idempotent setup so persisted settings and
  // plugins are applied at the correct lifecycle stage as well.
  lampainit_invc.appready = function appready() {
    readyForPlugins = true;
    lampainit_invc.appload();
  };

  // Lampac calls this on first initialization. The generated bootstrap owns
  // its first-run defaults; this hook is intentionally idempotent.
  lampainit_invc.first_initiale = function first_initiale() {};
})();
