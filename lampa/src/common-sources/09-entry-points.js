  // ── Entry points: the card button, Continue resume and playback recovery ──
  function addButton(movie, render, unsupported) {
    if (!movie || !render || render.find('.view--homelab-sources').length) return;
    var container = render.find('.buttons--container'); if (!container.length) return;
    var button = $('<div class="full-start__button selector view--homelab-sources">' + PLAY + '<span>Общий</span></div>');
    button.on('hover:enter', unsupported || function (_, context) {
      L.Activity.push({component: COMPONENT, title: 'Общий', movie: movie, season: context && context.season, page: 1});
    }); container.prepend(button);
  }
  // ── Prefetch: a title card the user stays on starts its «Общий» search, so the screen opens with results ──
  // Only while that card is the active screen: any other screen (Lampa's own torrents use the same parser)
  // cancels it, and the «Общий» screen adopts it when the episode and lanes match.
  var warm = null, warmOwner = null, warmTimer = 0, WARM_DELAY = 1500;
  function cancelWarm() { clearTimeout(warmTimer); warmOwner = null; if (warm) { warm.search.cancel(); warm = null; } }
  function adoptWarm(key) {
    var found = warm && warm.search.key === key && warm.search.alive() ? warm.search : null;
    if (found) { warm = null; warmOwner = null; clearTimeout(warmTimer); } else cancelWarm();
    return found;
  }
  function prefetch(card, owner) {
    cancelWarm();
    if (!card || !Number.isInteger(card.id) || card.id <= 0 || !owner) return;
    warmOwner = owner;
    warmTimer = setTimeout(function () {
      if (L.Activity.active() !== owner || L.Player.opened()) return;
      var movie = movieCard(card), selection = initialSelection({}, movie), search = new Search(Object.assign({}, movie), selection, function () {}, {torrents: true});
      warm = {search: search, owner: owner}; search.start();
    }, WARM_DELAY);
  }
  // A trailer played from the card is not a screen change; it stops the prefetch as well.
  if (L.Player && L.Player.listener) L.Player.listener.follow('start', cancelWarm);
  L.Listener.follow('activity', function (event) {
    if (!event || (event.type !== 'init' && event.type !== 'start') || event.component === COMPONENT) return;
    if (event.object !== warmOwner) cancelWarm();
  });
  // Movie rows carry the dub in match.translate/text; their voice_name is often a release tag (WEB-DL) that matches no row.
  function sourceVoice(source, card) {
    var match = source && source.match || {}, pick = function (value) { return typeof value === 'string' ? value.trim() : ''; };
    var voice = pick(source && source.voice);
    if (ITEM_TAG.test(voice)) voice = '';
    if (card && !card.name) {
      var text = pick(match.text) || pick(source && source.text);
      if (text && (text === card.title || text === card.original_title)) text = '';
      voice = pick(match.translate) || text || voice;
    }
    return /^(неизвестно|оригинал|по умолчанию|дублированный|озвучка источника)$/i.test(voice) || ITEM_TAG.test(voice) ? '' : voice;
  }
  function resumeSource(item, movie) {
    if (!item || !movie || !Number.isInteger(movie.id) || item.card !== (movie.name ? 'tv_' : 'movie_') + movie.id || L.Player.opened()) return false;
    if (movie.name && (!Number.isInteger(item.season) || item.season < 0 || !Number.isInteger(item.episode) || item.episode <= 0)) return false;
    var voice = sourceVoice(item.online, movie);
    L.Activity.push({component: COMPONENT, title: 'Выбор источника', movie: movie, homelab_recovery: {
      scope: sync.scope(), season: movie.name ? item.season : 0, episode: item.episode || 1, voice: voice, excludeProvider: '',
      position: Number.isFinite(item.position) ? Math.max(0, item.position) : 0,
      duration: Number.isFinite(item.duration) ? item.duration : 0, quality: preferences().quality
    }});
    return true;
  }
  function recover(work, snapshot, sameProvider) {
    if (!snapshot || !work || !work.card || !Number.isInteger(work.card.id) || L.Player.playdata() !== work || !L.Player.opened() || typeof L.Player.close !== 'function') return false;
    if (work.card.name && (!Number.isInteger(work.season) || work.season < 0 || !Number.isInteger(work.episode) || work.episode <= 0)) return false;
    var scope = sync.scope(), activity = L.Activity.active(), source = work.homelab_online, movie = Object.assign({}, work.card), pref = preferences();
    var tracks = L.HomelabGstAudio && L.HomelabGstAudio.preferences ? L.HomelabGstAudio.preferences(work) : work.homelab_track_preferences;
    var voice = sourceVoice(source, work.card) || sourceVoice({voice: tracks && tracks.audio && tracks.audio.title}, work.card);
    var context = {scope: scope, season: work.card.name ? work.season : 0, episode: +work.episode || 1, voice: voice, excludeProvider: source && source.provider || '',
      position: Number.isFinite(snapshot.position) ? Math.max(0, snapshot.position) : 0, duration: Number.isFinite(snapshot.duration) ? snapshot.duration : 0, quality: qualityHeight(Object.keys(work.quality || {}).length === 1 ? Object.keys(work.quality)[0] : '') || pref.quality};
    var modal = L.Modal, torrentModal = modal && modal.opened && modal.opened() && modal.render && modal.render().find('.torrent-files').length ? modal.render()[0] : null;
    L.Player.close();
    if (torrentModal && sync.scope() === scope && !L.Player.opened() && L.Activity.active() === activity && modal.opened() && modal.render()[0] === torrentModal) modal.close();
    setTimeout(function () {
      if (sync.scope() !== scope || L.Activity.active() !== activity || L.Player.opened()) return;
      var adapter = window.HomelabOnlineResume;
      if (sameProvider && source && adapter && adapter.valid(source)) {
        if (!adapter.resume({card: (movie.name ? 'tv_' : 'movie_') + movie.id, online: Object.assign({}, source), season: context.season, episode: context.episode, position: context.position}, movie,
          function () { L.Noty.show('Источник не ответил. Выберите другой вариант'); }, {quality: context.quality, fromDuration: context.duration})) L.Noty.show('Откройте источник заново');
      } else L.Activity.push({component: COMPONENT, title: 'Другой источник', movie: movie, homelab_recovery: context});
    }, 0);
    return true;
  }
