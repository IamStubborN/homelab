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
  var L = window.Lampa, sync = window.HomelabSync;
  if (!sync || window.homelabHistoryInstalled) return;
  if (!L.Maker || !L.Maker.make || !L.Component || !L.Component.add || !L.Menu ||
      !L.Menu.addButton || !L.Select || !L.Select.listener || !L.Select.opened || !L.Select.closeAll ||
      !L.Controller || !L.Controller.toggle || !L.Background || !L.Utils.cardImgBackground || !L.Utils.secondsToTimeHuman || !L.Noty || !L.Activity || !L.Activity.own || !L.Activity.refresh || !L.Account.Api ||
      !L.Account.Api.watchHistory || !L.Account.Api.watchHistoryCard || !L.Api || !L.Api.sources || !L.Api.sources.tmdb ||
      !L.Api.sources.tmdb.get || !L.Router || !L.Router.call || !window.$) {
    console.warn('Homelab history screen disabled: incompatible extension API');
    return;
  }
  window.homelabHistoryInstalled = true;
  $('head').append($('<style></style>').text(
    '.homelab-history-progress{font-size:.9em;opacity:.8;padding:.3em 0}' +
    '.homelab-history-summary{font-size:1.15em;padding:.8em 0}' +
    '.homelab-history-event{padding:1em;margin:.5em 0;border-radius:.6em;background:rgba(255,255,255,.06);line-height:1.4}' +
    '.homelab-history-event.focus,.homelab-history-event.selected{background:rgba(255,255,255,.18)}'
  ));
  var panel, generation = 0, metadata = {}, cachedPages = {}, cacheScope = '';
  var icon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3a9 9 0 1 1-8.5 12h2.2A7 7 0 1 0 5 10h3l-4 4-4-4h3a9 9 0 0 1 9-7m-1 4h2v5l4 2-1 1.7-5-3z"/></svg>';
  function label(value) { return $('<div></div>').text(value); }
  function cardKey(card) { return (card.original_name || card.name ? 'tv_' : 'movie_') + card.id; }
  function snapshot(key) { return sync.rows().filter(function (row) { return sync.extra(row).card === key && !row.deleted; }); }
  function newest(list) { return list.reduce(function (value, row) { return Math.max(value, row.watched_at || 0); }, 0); }
  function summary(card, events) {
    var list = snapshot(card.homelab_key || cardKey(card)), episodes = {};
    list.forEach(function (row) {
      var extra = sync.extra(row);
      if (row.percent > 1 && extra.season != null && extra.episode != null) episodes[extra.season + ':' + extra.episode] = true;
    });
    ((card.watch_history && card.watch_history.episodes || []).concat(events || [])).forEach(function (event) {
      if (event.season != null && event.episode != null) episodes[event.season + ':' + event.episode] = true;
    });
    var count = Object.keys(episodes).length;
    if (card.original_name || card.name) return 'Серии: ' + count + (card.number_of_episodes ? ' из ' + card.number_of_episodes : '');
    var last = list.sort(function (a, b) { return b.watched_at - a.watched_at; })[0];
    return last ? Math.round(last.percent) + '% · ' + L.Utils.secondsToTimeHuman(last.position) : 'Просмотр';
  }
  function resetScope() {
    var scope = sync.scope();
    if (scope !== cacheScope) { cachedPages = {}; metadata = {}; cacheScope = scope; closePanel(); }
    return scope;
  }
  function loadPage(page, done) {
    var scope = resetScope();
    function build(data) {
      if (sync.scope() !== scope) return done(new Error('profile'));
      var cards = (data.results || []).map(function (card) {
        var copy = Object.assign({}, card); copy.homelab_key = cardKey(copy); return copy;
      });
      var byKey = {};
      cards.forEach(function (card) { byKey[card.homelab_key] = card; });
      if (page === 1) sync.rows().forEach(function (row) {
        var key = sync.extra(row).card, match = /^(tv|movie)_(\d+)$/.exec(key || '');
        if (row.deleted || !match || byKey[key]) return;
        var card = metadata[key] || { id: +match[2], source: 'tmdb' };
        if (match[1] === 'tv' && !card.name) card.name = 'Сериал #' + match[2];
        if (match[1] === 'tv' && !card.original_name) card.original_name = card.name;
        if (match[1] === 'movie' && !card.title) card.title = 'Фильм #' + match[2];
        card = Object.assign({}, card, { homelab_key: key });
        byKey[key] = card; cards.push(card);
      });
      // Resolve only missing metadata, with four requests in flight at most.
      var pending = cards.filter(function (card) { return !card.watch_history && !metadata[card.homelab_key]; });
      var next = 0, running = 0;
      function finish() {
        if (sync.scope() !== scope) return done(new Error('profile'));
        cards = cards.map(function (card) { return Object.assign({}, card, metadata[card.homelab_key] || {}, { homelab_key: card.homelab_key, watch_history: card.watch_history }); });
        cards.forEach(function (card) { card.homelab_last = Math.max(newest(snapshot(card.homelab_key)), card.watch_history && card.watch_history.watched_at || 0); card.homelab_summary = summary(card); });
        cards.sort(function (a, b) { return b.homelab_last - a.homelab_last; });
        done(null, { results: cards, page: page, total_pages: data.total_pages || 1 });
      }
      function worker() {
        if (next === pending.length && !running) return finish();
        while (running < 4 && next < pending.length) {
          var card = pending[next++]; running++;
          (function (item) {
            function complete(value) { if (value && sync.scope() === scope) metadata[item.homelab_key] = value; running--; worker(); }
            L.Api.sources.tmdb.get(item.homelab_key.replace('_', '/'), {}, complete, function () { complete(); });
          })(card);
        }
      }
      worker();
    }
    L.Account.Api.watchHistory({ page: page, group: 'card' }, function (data) { if (sync.scope() === scope) cachedPages[page] = data; build(data); }, function () { build(cachedPages[page] || { results: [] }); });
  }
  function closePanel() { if (panel) { panel.closed = true; if (panel.visible) L.Select.closeAll(); panel = null; } generation++; }
  function showPanel(card) {
    closePanel();
    panel = { card: card, events: [], selection: null, visible: false, scope: sync.scope(), id: generation };
    refreshPanel(panel);
  }
  function refreshPanel(state, fresh) {
    var seq = state.sequence = (state.sequence || 0) + 1;
    function fetched() {
      if (panel !== state || state.scope !== sync.scope()) return;
      L.Account.Api.watchHistoryCard(state.card.homelab_key, function (events) { state.cubError = false; render(events); }, function () { state.cubError = true; render(state.events); });
      function render(events) {
        if (panel !== state || state.closed || state.sequence !== seq || state.scope !== sync.scope()) return;
        state.events = events;
        var seen = {}, list = events.slice();
        events.forEach(function (event) { if (event.season != null && event.episode != null) seen[event.season + ':' + event.episode] = true; });
        snapshot(state.card.homelab_key).forEach(function (row) {
          var extra = sync.extra(row), key = extra.season + ':' + extra.episode;
          if (row.percent <= 1 || seen[key]) return;
          list.push({ season: extra.season, episode: extra.episode, watched_at: row.watched_at }); seen[key] = true;
        });
        list.sort(function (a, b) { return b.watched_at - a.watched_at; });
        var items = [{ html: label(summary(state.card, events)).addClass('homelab-history-summary'), noenter: true }, { title: 'Открыть', open: true }];
        if (sync.error()) items.unshift({html: label('Прогресс не обновлён: показаны последние полученные данные'), noenter: true});
        else if (state.cubError) items.unshift({html: label('История CUB не обновлена: показаны последние полученные события'), noenter: true});
        list.forEach(function (event) {
          var title = new Date(event.watched_at).toLocaleString('ru-RU');
          if (event.season != null && event.episode != null) title += ' · Сезон ' + event.season + ', серия ' + event.episode;
          else title += ' · Просмотр';
          items.push({ html: label(title).addClass('homelab-history-event selector'), noenter: true });
        });
        if (!state.selection && L.Select.opened()) return;
        if (state.selection && !state.visible) return; // Another selector owns the screen.
        if (state.visible) L.Select.closeAll();
        state.selection = { title: 'История дома · ' + (state.card.name || state.card.title || ''), items: items, nomark: true,
          onBack: function () { closePanel(); L.Controller.toggle('content'); },
          onSelect: function (item) { closePanel(); L.Controller.toggle('content'); if (item.open) L.Router.call('full', state.card); }
        };
        L.Select.show(state.selection);
      }
    }
    if (fresh) fetched(); else sync.pull(fetched);
  }
  function selectState(event) { if (panel) panel.visible = event.active === panel.selection; }
  L.Select.listener.follow('fullshow', selectState);
  L.Select.listener.follow('toggle', selectState);
  function History(object) {
    var comp = L.Maker.make('Category', object, function (helper) { return helper.toggle(helper.MASK.base, 'Pagination'); });
    var destroyed = false, loading = false, page = 1, shown = {}, labels = {};
    function read(done) {
      loading = true;
      loadPage(page, function (error, data) {
        loading = false;
        if (destroyed) return;
        if (error) return done(error);
        done(null, data);
      });
    }
    // Background polls repaint visible progress in place; rebuilding the
    // activity would reset TV focus, scroll and pagination.
    var unsubscribe = sync.subscribe(function () {
      resetScope();
      if (destroyed || loading || !L.Activity.own(comp)) return;
      if (panel) { if (panel.visible) refreshPanel(panel, true); return; }
      Object.keys(labels).forEach(function (key) {
        var entry = labels[key], text = summary(entry.card);
        if (text !== entry.card.homelab_summary) { entry.card.homelab_summary = text; entry.node.text(text); }
      });
    });
    comp.use({
      onCreate: function () {
        var self = this; loading = true;
        sync.pull(function (error) {
          if (destroyed) return;
          if (error && sync.rows().length) L.Noty.show('История не обновлена: показаны последние полученные данные');
          if (error && !sync.rows().length) { loading = false; self.empty(); L.Noty.show('История дома временно недоступна'); return; }
          read(function (failure, data) {
            if (failure) return self.empty();
            data.results.forEach(function (card) { shown[card.homelab_key] = true; });
            if (data.results.length) self.build(data); else self.empty();
          });
        });
      },
      onNext: function (resolve, reject) {
        page++;
        read(function (error, data) {
          if (error) return reject();
          data.results = data.results.filter(function (card) { if (shown[card.homelab_key]) return false; shown[card.homelab_key] = true; return true; });
          resolve(data);
        });
      },
      onInstance: function (item, card) {
        item.use({
          onCreate: function () { var node = label(card.homelab_summary).addClass('homelab-history-progress'); labels[card.homelab_key] = {node: node, card: card}; $(this.render()).append(node); },
          onEnter: function () { showPanel(card); },
          onFocus: function () { L.Background.change(L.Utils.cardImgBackground(card)); }
        });
      },
      onDestroy: function () { destroyed = true; labels = {}; closePanel(); unsubscribe(); }
    });
    return comp;
  }
  L.Component.add('homelab_history', History);
  L.Menu.addButton(icon, 'История дома', function () {
    L.Activity.push({ component: 'homelab_history', title: 'История дома', page: 1 });
  }).attr('data-action', 'homelab_history');
})();
