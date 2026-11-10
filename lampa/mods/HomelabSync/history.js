// Built by tools/build.cjs from src/homelab-sync/history.js: edit the sources there and rebuild.
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
    '.homelab-history-progress{font-size:.95em;padding:.3em 0;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.homelab-history-when{font-size:.85em;opacity:.6;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.homelab-history-bar{position:absolute;left:.7em;right:.7em;bottom:.7em;height:.3em;border-radius:1em;background:rgba(255,255,255,.3);overflow:hidden;z-index:1;pointer-events:none}' +
    '.homelab-history-bar div{height:100%;border-radius:1em;background:#fff}' +
    '.homelab-history-bar.hide{display:none}' +
    '.homelab-history-summary{font-size:1.15em;padding:.8em 0}' +
    '.homelab-history-event{padding:.9em 1em;margin:.4em 0;border-radius:.6em;background:rgba(255,255,255,.06);line-height:1.4}' +
    '.homelab-history-event.focus,.homelab-history-event.selected{background:#fff;color:#000}' +
    '.homelab-history-event__head{display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center}' +
    '.homelab-history-event__title{-webkit-box-flex:1;-webkit-flex:1;flex:1;font-size:1.1em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.homelab-history-event__time{margin-left:1em;opacity:.6;-webkit-flex-shrink:0;flex-shrink:0}' +
    '.homelab-history-event__state{font-size:.9em;opacity:.7;margin-top:.2em}' +
    '.homelab-history-event__state:empty{display:none}' +
    '.homelab-history-event--watched .homelab-history-event__title:before{content:"";display:inline-block;width:.3em;height:.65em;margin:0 .6em .15em .1em;border-right:.15em solid currentColor;border-bottom:.15em solid currentColor;-webkit-transform:rotate(45deg);transform:rotate(45deg)}' +
    '.homelab-history-event .homelab-history-track{height:.25em;margin-top:.5em;border-radius:1em;background:rgba(255,255,255,.25);overflow:hidden}' +
    '.homelab-history-event.focus .homelab-history-track{background:rgba(0,0,0,.2)}' +
    '.homelab-history-track div{height:100%;background:#fff}' +
    '.homelab-history-event.focus .homelab-history-track div{background:#000}'
  ));
  var panel, generation = 0, metadata = {}, cachedPages = {}, cacheScope = '';
  var icon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3a9 9 0 1 1-8.5 12h2.2A7 7 0 1 0 5 10h3l-4 4-4-4h3a9 9 0 0 1 9-7m-1 4h2v5l4 2-1 1.7-5-3z"/></svg>';
  function label(value) { return $('<div></div>').text(value); }
  // Same wording as the Continue row: «С1 · Е29 · осталось 12 мин», «вчера».
  var DAY = 86400000, MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  function plural(n, forms) { var a = Math.abs(n) % 100, b = a % 10; return forms[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b > 1 && b < 5 ? 1 : 2]; }
  function daysAgo(stamp) {
    var today = new Date(Date.now()), then = new Date(stamp);
    today.setHours(0, 0, 0, 0); then.setHours(0, 0, 0, 0);
    return Math.round((today.getTime() - then.getTime()) / DAY);
  }
  function calendar(stamp) {
    var date = new Date(stamp);
    return date.getDate() + ' ' + MONTHS[date.getMonth()] + (date.getFullYear() !== new Date(Date.now()).getFullYear() ? ' ' + date.getFullYear() : '');
  }
  function ago(stamp) {
    if (!(stamp > 0)) return '';
    var diff = Date.now() - stamp, days = daysAgo(stamp);
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
    if (days <= 0) return 'сегодня';
    if (days === 1) return 'вчера';
    return days < 7 ? days + ' ' + plural(days, ['день', 'дня', 'дней']) + ' назад' : calendar(stamp);
  }
  function dayTitle(stamp) { var days = daysAgo(stamp); return days <= 0 ? 'Сегодня' : days === 1 ? 'Вчера' : calendar(stamp); }
  function clock(stamp) { var date = new Date(stamp); return date.getHours() + ':' + ('0' + date.getMinutes()).slice(-2); }
  // Time left as short Russian copy: "осталось 1 ч 5 мин".
  function remaining(position, duration) {
    var rest = Math.max(0, duration - position), minutes = Math.round(rest / 60);
    if (rest < 60) return 'осталось меньше минуты';
    if (minutes < 60) return 'осталось ' + minutes + ' мин';
    return 'осталось ' + Math.floor(minutes / 60) + ' ч' + (minutes % 60 ? ' ' + minutes % 60 + ' мин' : '');
  }
  function episodeLabel(season, episode) { return +season === 0 ? 'Спецвыпуск ' + episode : 'С' + season + ' · Е' + episode; }
  function percentOf(row) { var value = row.duration > 0 ? row.position / row.duration * 100 : +row.percent || 0; return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10; }
  function stateText(row) { var percent = percentOf(row); return percent >= 90 ? 'просмотрено' : row.duration > 0 ? remaining(row.position, row.duration) : Math.round(percent) + '%'; }
  // Latest saved position per episode (or the movie) of one card.
  function positions(key) {
    var result = {};
    snapshot(key).forEach(function (row) {
      var extra = sync.extra(row), name = extra.season != null && extra.episode != null ? extra.season + ':' + extra.episode : 'movie';
      if (!result[name] || result[name].watched_at < row.watched_at) result[name] = row;
    });
    return result;
  }
  // The newest position of a card as one line plus its poster progress.
  function latest(card) {
    var list = snapshot(card.homelab_key || cardKey(card)).sort(function (a, b) { return b.watched_at - a.watched_at; }), row = list[0];
    if (!row) return {text: '', percent: 0};
    var extra = sync.extra(row), tv = !!(card.original_name || card.name), percent = percentOf(row);
    var text = (tv && extra.season != null && extra.episode > 0 ? episodeLabel(extra.season, extra.episode) + ' · ' : '') + stateText(row);
    return {text: text, percent: percent >= 90 ? 0 : percent};
  }
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
  function capital(text) { return text ? text.charAt(0).toUpperCase() + text.slice(1) : text; }
  function when(card) {
    var time = ago(card.homelab_last), tv = !!(card.original_name || card.name);
    return tv ? card.homelab_summary + (time ? ' · ' + time : '') : time || card.homelab_summary;
  }
  // Grid card: newest position, watched count with relative time, poster bar.
  function paintCard(entry) {
    var card = entry.card, line = card.homelab_line || latest(card);
    entry.line.text(capital(line.text) || card.homelab_summary);
    entry.when.text(line.text ? when(card) : ago(card.homelab_last));
    entry.bar.toggleClass('hide', !(line.percent > 0)); entry.bar.find('div').css('width', line.percent + '%');
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
        cards.forEach(function (card) { card.homelab_last = Math.max(newest(snapshot(card.homelab_key)), card.watch_history && card.watch_history.watched_at || 0); card.homelab_summary = summary(card); card.homelab_line = latest(card); });
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
        var items = [{ html: label(summary(state.card, events)).addClass('homelab-history-summary'), noenter: true }];
        var resumable = window.homelabContinue && typeof window.homelabContinue.list === 'function' ? window.homelabContinue.list().filter(function (entry) { return entry.card === state.card.homelab_key; })[0] : null;
        if (resumable) items.push({ title: 'Продолжить', subtitle: resumable.episode > 0 ? episodeLabel(resumable.season, resumable.episode) : '', resume: resumable });
        items.push({ title: 'Открыть', open: true });
        var saved = positions(state.card.homelab_key), described = {}, day = '';
        if (sync.error()) items.unshift({html: label('Прогресс не обновлён: показаны последние полученные данные'), noenter: true});
        else if (state.cubError) items.unshift({html: label('История CUB не обновлена: показаны последние полученные события'), noenter: true});
        // Events grouped under day headers; the newest event of an episode
        // also shows its saved progress, like the Continue row.
        list.forEach(function (event) {
          var episode = event.season != null && event.episode != null, name = episode ? event.season + ':' + event.episode : 'movie', heading = dayTitle(event.watched_at);
          if (heading !== day) { day = heading; items.push({ title: heading, separator: true }); }
          var row = !described[name] ? saved[name] : null, node = $('<div class="homelab-history-event selector"></div>');
          described[name] = true;
          var head = $('<div class="homelab-history-event__head"></div>');
          head.append(label(episode ? episodeLabel(event.season, event.episode) : 'Просмотр').addClass('homelab-history-event__title'));
          head.append(label(clock(event.watched_at)).addClass('homelab-history-event__time'));
          node.append(head).append(label(row ? capital(stateText(row)) : '').addClass('homelab-history-event__state'));
          if (row && percentOf(row) >= 90) node.addClass('homelab-history-event--watched');
          else if (row && percentOf(row) > 1) { var bar = $('<div class="homelab-history-track"><div></div></div>'); bar.find('div').css('width', percentOf(row) + '%'); node.append(bar); }
          items.push({ html: node, noenter: true });
        });
        if (!state.selection && L.Select.opened()) return;
        if (state.selection && !state.visible) return; // Another selector owns the screen.
        if (state.visible) L.Select.closeAll();
        state.selection = { title: 'История дома · ' + (state.card.name || state.card.title || ''), items: items, nomark: true,
          onBack: function () { closePanel(); L.Controller.toggle('content'); },
          onSelect: function (item) {
            closePanel(); L.Controller.toggle('content');
            if (item.resume) window.homelabContinue.resume(item.resume); else if (item.open) L.Router.call('full', state.card);
          }
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
        var entry = labels[key], text = summary(entry.card), line = latest(entry.card);
        entry.card.homelab_last = Math.max(newest(snapshot(entry.card.homelab_key)), entry.card.watch_history && entry.card.watch_history.watched_at || 0);
        var stamp = JSON.stringify([text, line, ago(entry.card.homelab_last)]);
        if (stamp === entry.stamp) return;
        entry.stamp = stamp; entry.card.homelab_summary = text; entry.card.homelab_line = line; paintCard(entry);
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
          onCreate: function () {
            var root = $(this.render()), entry = {card: card, line: label('').addClass('homelab-history-progress'), when: label('').addClass('homelab-history-when'),
              bar: $('<div class="homelab-history-bar"><div></div></div>')};
            entry.stamp = JSON.stringify([card.homelab_summary, card.homelab_line || latest(card), ago(card.homelab_last)]);
            labels[card.homelab_key] = entry; paintCard(entry);
            root.append(entry.line).append(entry.when); root.find('.card__view').append(entry.bar);
          },
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
