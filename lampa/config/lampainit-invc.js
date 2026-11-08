// Homelab defaults injected into the generated Lampac Lampa bootstrap.
var lampainit_invc = {};

(function () {
  'use strict';

  var readyForPlugins = false;
  var watchingPlayer = false;
  var torrentServerChecked = false;
  var checkingTorrentServer = false;

  function quietPluginSuccess() {
    var noty = Lampa.Noty, lang = Lampa.Lang;
    if (!noty || typeof noty.show !== 'function' || !lang || typeof lang.translate !== 'function' || noty.show.homelabQuietPluginSuccess) return;
    var show = noty.show;
    function quiet(text) {
      if (text === lang.translate('plugins_add_success')) return;
      return show.apply(this, arguments);
    }
    quiet.homelabQuietPluginSuccess = true;
    noty.show = quiet;
  }

  function configureTorrentPlayer() {
    var android = Lampa.Platform && Lampa.Platform.is('android');
    if (android && Lampa.Params && Lampa.Params.select) {
      Lampa.Params.select('player_torrent', {
        inner: '#{settings_param_player_inner}', android: 'Android'
      }, 'android');
    }
    // Browser/embedded players need HLS for codecs unsupported by WebView.
    // Keep direct torrent streams for users choosing an external Android player.
    Lampa.Storage.set('torrserver_gts', !android || Lampa.Storage.field('player_torrent') === 'inner');
    if (!watchingPlayer && Lampa.Storage.listener) {
      watchingPlayer = true;
      Lampa.Storage.listener.follow('change', function (event) {
        if (event.name === 'player_torrent') configureTorrentPlayer();
      });
    }
    if (!android || Lampa.Storage.field('player_torrent') !== 'inner') {
      torrentServerChecked = false;
      return;
    }
    if (!readyForPlugins || torrentServerChecked || checkingTorrentServer ||
        !Lampa.Torserver || typeof Lampa.Torserver.connected !== 'function') return;
    torrentServerChecked = true;
    if (Lampa.Torserver.gstWork && Lampa.Torserver.gstWork()) return;
    // Saved torrent hashes skip Lampa's connection check. Discover GStreamer
    // once before playback, without repeatedly clearing TorServer's requests.
    checkingTorrentServer = true;
    Lampa.Torserver.connected(function () {
      checkingTorrentServer = false;
    }, function () {
      checkingTorrentServer = false;
    });
  }

  function applyRuntimeSettings() {
    quietPluginSuccess();
    var origin = window.location.origin;

    Lampa.Storage.set('torrserver_url', origin + '/torrserver');
    Lampa.Storage.set('internal_torrclient', true);
    Lampa.Storage.set('torrserver_use_link', 'one');
    Lampa.Storage.set('torrserver_savedb', true);
    configureTorrentPlayer();
    // JacRed is the configured torrent backend. Do not overwrite its native
    // Lampa plugin with the legacy Prowlarr client settings.
    if (typeof Lampa.Storage.remove === 'function') {
      Lampa.Storage.remove('prowlarr_url');
      Lampa.Storage.remove('prowlarr_key');
    }
    Lampa.Storage.set('jackett_url', origin + '/jacred');
    Lampa.Storage.set('jackett_key', '');
    Lampa.Storage.set('parser_use', 'true');
    Lampa.Storage.set('parser_torrent_type', 'jackett');
    Lampa.Storage.set('parse_in_search', 'true');
    // Set initial preferences without overwriting the user's later choices.
    var defaults = {parse_timeout: '30', online_balanser: 'kinobase', video_quality_default: '2160'};
    Object.keys(defaults).forEach(function (key) {
      if (Lampa.Storage.get(key, '') === '') Lampa.Storage.set(key, defaults[key]);
    });
  }

  function installPlugins() {
    var origin = window.location.origin;

    // The plugin registry is ready only after Lampa opens its IndexedDB.
    if (!Lampa.Plugins || typeof Lampa.Plugins.get !== 'function') return;

    // YummyAnime (1.3 MB from GitHub on every start) is unused: removed by the user's decision.
    var retired = [origin + '/plugins/homelab/chapter-gallery.js', 'https://yummyanime.github.io/yummy-lampa-plugin/stable/index.js'];
    // Copy first: remove() mutates the registry array that get() returns.
    Lampa.Plugins.get().slice().forEach(function (plugin) {
      if (typeof plugin.url !== 'string') return;
      // Remove the known obsolete third-party plugin host (the old malformed
      // marker `la,padocker` never matched a URL) and retired homelab plugins.
      if (plugin.url.indexOf('stunnorm') === -1 && retired.indexOf(plugin.url) === -1) return;
      if (typeof Lampa.Plugins.remove === 'function') Lampa.Plugins.remove(plugin);
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
      },
      {
        url: origin + '/plugins/homelab/account-sync.js',
        status: 1,
        name: 'Account sync',
        author: 'Homelab'
      },
      {
        url: origin + '/plugins/homelab/torrserver-audio.js',
        status: 1,
        name: 'TorrServer audio tracks',
        author: 'Homelab'
      },
      {
        url: origin + '/plugins/homelab/seek-previews.js',
        status: 1,
        name: 'Главы и кадры перемотки',
        author: 'Homelab'
      },
      {
        url: origin + '/plugins/homelab/playback-status.js',
        status: 1,
        name: 'Состояние воспроизведения',
        author: 'Homelab'
      },
      {
        url: origin + '/plugins/homelab/intro-skip.js',
        status: 1,
        name: 'Пропуск заставок',
        author: 'Homelab'
      }
    ];

    lampacPlugins.forEach(function (plugin) {
      var existing = Lampa.Plugins.get().find(function (item) {
        return item.url === plugin.url;
      });

      if (!existing) {
        Lampa.Plugins.add(plugin);
      } else if (existing.status == 1) {
        if (typeof Lampa.Plugins.push === 'function') Lampa.Plugins.push(existing);
      }
    });

    if (typeof Lampa.Plugins.save === 'function') Lampa.Plugins.save();

  }

  lampainit_invc.appload = function appload() {
    applyRuntimeSettings();

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
