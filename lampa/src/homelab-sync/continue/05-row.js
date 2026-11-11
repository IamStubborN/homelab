  // ── The home screen row: «Продолжить просмотр» and «Новые серии» ──
  var audioBound;
  function audioReady() {
    var audio = L.HomelabGstAudio;
    if (!audio || audioBound === audio || !audio.subscribe) return;
    audioBound = audio; audio.subscribe(function (event) {
      if (event.type === 'preferences' && playing && playing.data === event.work) {
        var state = playing; clearTimeout(state.pause); state.pause = setTimeout(function () { snapshot(state, true); }, 500);
      }
    });
  }
  audioReady(); window.addEventListener('homelab:audio-ready', audioReady);
  var rowCount = 0;
  function episodeWindow(item, episodes) {
    var seen = {};
    var season = (Array.isArray(episodes) ? episodes : []).filter(function (ep) {
      if (!ep || ep.season_number !== item.season || !Number.isInteger(ep.episode_number) || ep.episode_number < 1 || seen[ep.episode_number]) return false;
      seen[ep.episode_number] = true; return true;
    }).slice().sort(function (a, b) { return a.episode_number - b.episode_number; });
    var index = season.findIndex(function (ep) { return ep.episode_number === item.episode; });
    return index < 0 ? [] : season.slice(index, index + 5);
  }
  // The focus overlay's episode list from the last session, so a focused
  // tile does not grow from one line to the list while the app starts.
  function storedWindow(item) {
    var value = null;
    try { value = L.Storage.get(EPISODES, null); } catch (_) {}
    var rows = value && value[scope + '|' + item.card + ':' + item.season + ':' + item.episode];
    return Array.isArray(rows) ? rows.filter(function (row) { return row && Number.isInteger(row.episode_number); }).map(function (row) { return {episode_number: row.episode_number, name: plain(row.name).slice(0, 200)}; }) : [];
  }
  function storeWindow(item, rows) {
    var value = null;
    try { value = L.Storage.get(EPISODES, null); } catch (_) {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
    var name = scope + '|' + item.card + ':' + item.season + ':' + item.episode, wanted = {};
    list().forEach(function (entry) { wanted[scope + '|' + entry.card + ':' + entry.season + ':' + entry.episode] = true; });
    // Other profiles keep their entries; this profile keeps only its row.
    Object.keys(value).forEach(function (key) { if (key.indexOf(scope + '|') === 0 && !wanted[key]) delete value[key]; });
    if (Object.keys(value).length > 200) value = {};
    value[name] = rows.map(function (row) { return {episode_number: row.episode_number, name: plain(row.name).slice(0, 200)}; });
    try { L.Storage.set(EPISODES, value, true); } catch (_) {}
  }
  // One line of tiles: what is being watched ('continue') or episodes released since ('fresh').
  function ResumeLine(kind, focus) {
    var fresh = kind === 'fresh', self = this, bus = L.Subscribe(), html = window.$('<div class="homelab-resume-row' + (fresh ? ' homelab-resume-fresh hide' : '') + '"><div class="homelab-resume-title"></div><div class="homelab-resume-sync"></div></div>');
    html.find('.homelab-resume-title').text(fresh ? 'Новые серии' : 'Продолжить просмотр');
    var scroll = new L.Scroll({horizontal: true, step: 300}), last = null, stamp = '', destroyed = false, cards = [], byCard = {}, order = '', orderList = [], seasons = {}, seasonScope = sync.scope(), empty = null;
    function clearSeasons() { Object.keys(seasons).forEach(function (name) { clearTimeout(seasons[name].timer); }); seasons = {}; }
    function clearCards() { cards.splice(0).forEach(function (native) { native.destroy(); }); byCard = {}; order = ''; }
    scroll.onScroll = function () { L.Layer.visible(scroll.render(true)); };
    function episodes(item, done) {
      var name = item.card + ':' + item.season, key = sync.scope(), cached = seasons[name];
      if (cached) { if (cached.value) done(cached.value); else cached.waiters.push(done); return; }
      var job = seasons[name] = {waiters: [done]};
      function complete(value) {
        if (destroyed || sync.scope() !== key || job.value) return;
        clearTimeout(job.timer); job.value = value;
        job.waiters.splice(0).forEach(function (callback) { callback(value); });
      }
      job.timer = setTimeout(function () { complete([]); }, 10000);
      function fetchSeason() {
        if (destroyed || sync.scope() !== key || job.value) return;
        if (!L.Api.sources || !L.Api.sources.tmdb || typeof L.Api.sources.tmdb.get !== 'function') return complete([]);
        L.Api.sources.tmdb.get('tv/' + item.card.split('_')[1] + '/season/' + item.season, {}, function (data) {
          complete(data && Array.isArray(data.episodes) ? data.episodes : []);
        }, function () { complete([]); });
      }
      if (!L.TimeTable || typeof L.TimeTable.get !== 'function') return fetchSeason();
      L.TimeTable.get(card(item), function (rows) {
        if (destroyed || sync.scope() !== key || job.value) return;
        if (rows && rows[0] && rows[0].season_number === 1) {
          rows = typeof L.Utils.splitEpisodesIntoSeasons === 'function' ? L.Utils.splitEpisodesIntoSeasons(rows)[item.season] || [] : [];
        }
        if (episodeWindow(item, rows).length) complete(rows); else fetchSeason();
      });
    }

    this.use = function (module) { Object.keys(module).forEach(function (name) {
      if (/^on[A-Z]/.test(name)) bus.follow(name.slice(2).toLowerCase(), function (args) { module[name].apply(self, args || []); });
    }); };
    this.emit = function (name) { bus.send(name.toLowerCase(), [].slice.call(arguments, 1)); };
    function draw() {
      if (destroyed) return;
      if (seasonScope !== sync.scope()) { clearSeasons(); clearCards(); seasonScope = sync.scope(); stamp = ''; }
      var data = list().filter(function (item) { return !!item.fresh === fresh; }), next = JSON.stringify({items: data, warning: writeError || readError, ready: loadedOnce, minute: Math.floor(Date.now() / 60000)});
      if (next === stamp) return; stamp = next;
      var focused = L.Controller.own(self), nextOrder = JSON.stringify(data.map(function (item) { return item.card; })), changedOrder = nextOrder !== order, wanted = {};
      html.find('.homelab-resume-sync').text(!fresh && (writeError || readError) ? 'Продолжение не синхронизировано: показаны последние данные' : '');
      html.toggleClass('hide', fresh && !data.length);
      data.forEach(function (item) {
        wanted[item.card] = true;
        if (byCard[item.card]) { byCard[item.card].update(item); return; }
        var alive = true, timer = null, loaded = false, displayed = [];
        var native = L.Maker.make('Card', card(item), function (mask) { return mask.only('Card', 'Icons', 'Release', 'Callback'); });
        native.use({onEnter: function () { resume(item); }, onFocus: function (target) {
          focus.card = item.card; last = target; scroll.update(last, true); self.emit('active');
        }, onDestroy: function () { alive = false; clearTimeout(timer); }});
        native.create();
        var tile = native.render().addClass('homelab-resume-card');
        var progress = window.$('<div class="card-watched homelab-resume-progress"><div class="card-watched__inner"><div class="homelab-resume-head"></div><div class="card-watched__body"></div></div></div>');
        var bar = window.$('<div class="homelab-resume-bar"><div></div></div>'), badge = window.$('<div class="homelab-resume-badge"></div>');
        // Native progress of the other episodes of the shown season, so the
        // overlay can mark watched and started ones.
        function states() {
          var result = {};
          sync.rows().forEach(function (row) {
            var extra = sync.extra(row), old;
            if (row.deleted || extra.card !== item.card || extra.season !== item.season || !(extra.episode > 0)) return;
            old = result[extra.episode];
            if (old && old.at >= row.watched_at) return;
            result[extra.episode] = {at: row.watched_at, percent: row.duration > 0 ? row.position / row.duration * 100 : +row.percent || 0};
          });
          if (item.advance && item.advance.season === item.season) result[item.advance.episode] = {at: Infinity, percent: 100};
          return result;
        }
        function track(percent) {
          var value = window.$('<div class="homelab-resume-track"><div></div></div>');
          value.find('div').css('width', percent + '%'); return value;
        }
        function paint(rows) {
          if (!alive || destroyed) return;
          displayed = rows;
          var body = progress.find('.card-watched__body').empty(), known = rows.length ? states() : {};
          progress.find('.homelab-resume-head').text(hasEpisode(item) ? item.season === 0 ? 'Спецвыпуски' : 'Сезон ' + item.season : '');
          (rows.length ? rows : [null]).forEach(function (episode) {
            var number = episode ? episode.episode_number : item.episode, current = !episode || number === item.episode;
            var state = current ? null : known[number], done = !!state && state.percent >= 90, percent = current ? percentOf(item) : state && !done ? state.percent : 0;
            var line = window.$('<div class="card-watched__item homelab-ep"><span></span></div>');
            if (current) line.addClass(item.advance ? 'homelab-ep--current homelab-ep--next' : 'homelab-ep--current');
            if (done) line.addClass('homelab-ep--watched');
            line.find('span').text(episode ? number + ' · ' + plain(episode.name || 'Серия ' + number) : progressText(item));
            if (current ? percent > 0 : percent > 1) line.append(track(Math.min(100, percent)));
            body.append(line);
          });
        }
        // Everything on the tile itself comes from the cached record: no
        // request is needed to show progress, source or time.
        function decorate() {
          var percent = percentOf(item), source = sourceLabel(item);
          bar.toggleClass('hide', !(percent > 0)); bar.find('div').css('width', percent + '%');
          badge.text(item.fresh ? 'Новая серия' : source).toggleClass('hide', !item.fresh && !source).toggleClass('is-new', !!item.fresh);
        }
        function lookupEpisodes() {
          if (!item.episode || !Number.isInteger(item.season) || item.season < 0 || loaded) return;
          clearTimeout(timer); timer = setTimeout(function () {
            if (!alive || destroyed || !tile.hasClass('focus')) return;
            var scope = sync.scope(), selected = item; loaded = true;
            episodes(selected, function (rows) {
              if (!alive || destroyed || sync.scope() !== scope || selected.season !== item.season || selected.episode !== item.episode) return;
              var shown = episodeWindow(item, rows);
              if (JSON.stringify(shown.map(function (row) { return [row.episode_number, plain(row.name)]; })) !== JSON.stringify(displayed.map(function (row) { return [row.episode_number, plain(row.name)]; }))) paint(shown);
              if (shown.length) storeWindow(item, shown);
            });
          }, 500);
        }
        tile.on('hover:focus hover:touch hover:hover', lookupEpisodes);
        tile.on('hover:long', function () { if (alive && !destroyed) menu(item); });
        tile.find('.card__view').append(progress).append(bar).append(badge);
        // No footer under the title: progress and source live on the poster.
        tile.find('.card__age').remove();
        tile.find('.card__icons-inner').append(window.$('<div class="card__icon icon--history"></div>'));
        decorate(); paint(hasEpisode(item) ? storedWindow(item) : []);
        byCard[item.card] = {native: native, update: function (value) {
          var previous = card(item), changedEpisode = item.season !== value.season || item.episode !== value.episode;
          item = value;
          var current = card(item);
          if (native.data) Object.assign(native.data, current);
          tile.find('.card__title').text(current.title);
          decorate();
          if (previous.poster_path !== current.poster_path) {
            // Re-emitting visible leaves an old native image timeout armed.
            // Keep the loader's existing handlers and update only its source.
            tile.find('.card__img').attr('src', typeof native.getPosterPath === 'function' ? native.getPosterPath() : current.poster_path ? L.Api.img(current.poster_path) : './img/img_broken.svg');
          }
          if (changedEpisode) { clearTimeout(timer); loaded = false; displayed = hasEpisode(item) ? storedWindow(item) : []; }
          paint(displayed);
          if (changedEpisode && tile.hasClass('focus')) lookupEpisodes();
        }};
      });
      Object.keys(byCard).forEach(function (card) { if (!wanted[card]) { byCard[card].native.destroy(); delete byCard[card]; } });
      cards = data.map(function (item) { return byCard[item.card].native; });
      if (empty) empty.text(loadedOnce ? 'Здесь появятся незавершённые просмотры' : 'Загрузка…');
      if (changedOrder) {
        order = nextOrder; orderList = data.map(function (item) { return item.card; }); scroll.clear(); empty = null;
        if (!cards.length && !fresh) { empty = window.$('<div class="homelab-resume-empty selector"></div>').text(loadedOnce ? 'Здесь появятся незавершённые просмотры' : 'Загрузка…'); scroll.append(empty); }
        cards.forEach(function (native) { scroll.append(native.render(true)); });
        // Until the remote moved along the row, the cursor belongs at its start: the list from the server
        // reorders the cached one while the app starts, and the card that was first need not stay first.
        if (!fresh && !focus.moved && cards.length) { focus.card = data[0].card; if (typeof scroll.reset === 'function') scroll.reset(); }
        last = byCard[focus.card] ? byCard[focus.card].native.render(true) : cards.length ? cards[0].render(true) : null;
      }
      L.Layer.visible(scroll.render(true));
      // The last new episode left (watched, removed): hand focus back to the line above.
      if (focused && !cards.length && fresh) { last = null; return self.emit('up'); }
      if (focused && changedOrder) { quiet(); L.Controller.collectionSet(scroll.render(true)); L.Controller.collectionFocus(last || false, scroll.render(true)); }
    }
    // Long press (or remote hold) opens the card's actions. Removal keeps the
    // tombstone semantics; focus moves to a neighbour only when the card leaves.
    function menu(item) {
      if (!L.Select || typeof L.Select.show !== 'function') return;
      var previous = L.Controller.enabled().name, tv = item.card.indexOf('tv_') === 0, shown = hasEpisode(item) ? episodeLabel(item.season, item.episode) : '';
      function back() { L.Controller.toggle(previous); }
      var options = [{title: 'Убрать из ряда', subtitle: 'Вернётся при следующем просмотре', action: 'remove', remove: true}];
      if (watchedRecord(item)) options.push({title: 'Отметить просмотренным', subtitle: tv ? (shown ? shown + ' · ' : '') + 'в ряду останется следующая' : 'Фильм уйдёт из ряда', action: 'watched'});
      options.push({title: 'Выбрать источник', subtitle: (shown ? shown + ' · ' : '') + 'другая озвучка или раздача', action: 'source'});
      L.Select.show({title: plain(item.title || 'Продолжить просмотр'), items: options,
        onBack: back,
        onSelect: function (choice) {
          back();
          if (!choice || destroyed) return;
          var index = orderList.indexOf(item.card), neighbour = orderList[index + 1] || orderList[index - 1] || '';
          if (choice.action === 'source') return resume(item, {choose: true});
          focus.moved = true;
          if (choice.action === 'remove') { focus.card = neighbour; dismiss(item.card); return; }
          if (choice.action !== 'watched' || !markWatched(item)) return;
          focus.card = list().some(function (entry) { return entry.card === item.card && !!entry.fresh === fresh; }) ? item.card : neighbour;
          publish(); drain();
        }});
    }
    this.empty = function () { return !cards.length; };
    this.has = function (cardKey) { return !!byCard[cardKey]; };
    this.create = function () { scroll.body().addClass('homelab-resume-items mapping--line'); html.append(scroll.render()); listeners.push(draw); draw(); };
    this.render = function (js) { return js ? html[0] : html; };
    // Lampa restarts the card focus bounce whenever focus is set again; only
    // a remote press should bounce, not the reloads while the app starts.
    function quiet(on) { html.toggleClass('homelab-resume-quiet', on !== false && Date.now() - lastKey > 500); }
    function move(step) {
      var tiles = scroll.render(true).querySelectorAll('.selector'), index = Array.prototype.indexOf.call(tiles, last), next = index + step;
      if (next >= 0 && next < tiles.length) { focus.moved = true; quiet(false); L.Controller.collectionFocus(tiles[next], scroll.render(true)); }
      else if (step < 0) self.emit('left');
    }
    this.toggle = function () {
      L.Controller.add('homelab_resume', {link: self, toggle: function () {
        // Re-toggled by name (a menu closing) after its last tile left: go back up instead.
        if (fresh && !cards.length) return self.emit('up');
        quiet(); L.Controller.collectionSet(scroll.render(true)); L.Controller.collectionFocus(last || false, scroll.render(true)); self.emit('toggle'); self.emit('active');
      }, right: function () { move(1); },
      left: function () { move(-1); },
      up: function () { self.emit('up'); }, down: function () { self.emit('down'); }, back: function () { self.emit('back'); }});
      L.Controller.toggle('homelab_resume');
    };
    this.destroy = function () { destroyed = true; listeners = listeners.filter(function (fn) { return fn !== draw; }); clearCards(); clearSeasons(); scroll.destroy(); html.remove(); self.emit('destroy'); };
  }
  // The home screen row: «Продолжить просмотр», and under it «Новые серии» when there are any.
  // Both live in one Main row, so an empty second line never takes a step of the remote.
  function ResumeRow() {
    var self = this, bus = L.Subscribe(), html = window.$('<div class="homelab-resume-group"></div>');
    // The focused card is shared, so focus follows a card that moves between the lines.
    var focus = {card: ''}, watching = new ResumeLine('continue', focus), fresh = new ResumeLine('fresh', focus), destroyed = false;
    function current() { return fresh.has(focus.card) ? fresh : watching; }
    function relay(name) { return function () { self.emit.apply(self, [name].concat([].slice.call(arguments))); }; }
    watching.use({onDown: function () { if (fresh.empty()) self.emit('down'); else fresh.toggle(); }, onUp: relay('up'), onBack: relay('back'), onLeft: relay('left'), onActive: relay('active'), onToggle: relay('toggle')});
    fresh.use({onUp: function () { if (!destroyed) watching.toggle(); }, onDown: relay('down'), onBack: relay('back'), onLeft: relay('left'), onActive: relay('active'), onToggle: relay('toggle')});
    this.use = function (module) { Object.keys(module).forEach(function (name) {
      if (/^on[A-Z]/.test(name)) bus.follow(name.slice(2).toLowerCase(), function (args) { module[name].apply(self, args || []); });
    }); };
    this.emit = function (name) { bus.send(name.toLowerCase(), [].slice.call(arguments, 1)); };
    this.create = function () { rowCount++; watching.create(); fresh.create(); html.append(watching.render()).append(fresh.render()); };
    this.render = function (js) { return js ? html[0] : html; };
    this.toggle = function () { current().toggle(); };
    this.destroy = function () { destroyed = true; rowCount--; watching.destroy(); fresh.destroy(); html.remove(); self.emit('destroy'); };
  }
  window.$('head').append(window.$('<style></style>').text('.homelab-resume-row{padding:1em 0}' +
    '.homelab-resume-row.hide{display:none}' +
    '.homelab-resume-fresh{padding-top:0}' +
    '.homelab-resume-items{display:flex;align-items:stretch}' +
    '.homelab-resume-title{white-space:normal;font-size:1.8em;margin:0 .6em .8em}' +
    '.homelab-resume-card{flex-shrink:0}' +
    '.homelab-resume-card .card__title{line-height:1.3;height:2.6em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}' +
    '.homelab-resume-bar{position:absolute;left:.7em;right:.7em;bottom:.7em;height:.3em;border-radius:1em;background:rgba(255,255,255,.3);overflow:hidden;z-index:1;pointer-events:none}' +
    '.homelab-resume-bar div{height:100%;border-radius:1em;background:#fff}' +
    '.homelab-resume-badge{position:absolute;top:.6em;right:.6em;max-width:45%;padding:.25em .55em;border-radius:.4em;background:rgba(0,0,0,.6);color:#fff;font-size:.8em;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:1;pointer-events:none}' +
    '.homelab-resume-bar.hide,.homelab-resume-badge.hide{display:none}' +
    '.homelab-resume-badge.is-new{background:#ffd66b;color:#000;font-weight:600}' +
    '.homelab-resume-progress .card-watched__inner{padding:.7em .8em .8em}' +
    '.homelab-resume-head{font-size:.75em;opacity:.6;padding-top:.2em}' +
    '.homelab-resume-head:empty{display:none}' +
    '.homelab-resume-progress .card-watched__item.homelab-ep{margin-top:.55em;color:rgba(255,255,255,.65)}' +
    '.homelab-resume-progress .card-watched__item.homelab-ep--current{color:#fff;font-weight:600}' +
    '.homelab-resume-progress .card-watched__item.homelab-ep--watched{color:rgba(255,255,255,.45)}' +
    '.homelab-ep--watched>span:before{content:"";display:inline-block;width:.3em;height:.6em;margin:0 .55em .15em .15em;border-right:.15em solid currentColor;border-bottom:.15em solid currentColor;-webkit-transform:rotate(45deg);transform:rotate(45deg)}' +
    '.homelab-ep--next>span:before{content:"";display:inline-block;width:0;height:0;margin:0 .45em .05em .1em;border-left:.5em solid #fff;border-top:.32em solid transparent;border-bottom:.32em solid transparent}' +
    '.homelab-resume-track{height:.2em;background:rgba(255,255,255,.25);margin-top:.4em;border-radius:1em;overflow:hidden}' +
    '.homelab-resume-track div{height:100%;background:#fff}' +
    '.homelab-ep:not(.homelab-ep--current) .homelab-resume-track div{background:rgba(255,255,255,.55)}' +
    '.homelab-resume-empty{padding:1em;opacity:.7}' +
    '.homelab-resume-quiet .homelab-resume-card .card__view{-webkit-animation:none!important;animation:none!important}'));
  L.ContentRows.add({name: 'homelab_continue', title: 'Продолжить просмотр', index: 0, screen: ['main'],
    // Resolve at once from the cached list: Main waits for its whole first
    // batch of rows, so a slow Lampac must not hold the home screen.
    call: function () { return function (resolve) {
      context();
      resolve({title: 'Продолжить просмотр', results: [{}], params: {createInstance: function () { return new ResumeRow(); }}});
      sync.pull(function () { load(); });
    }; }});
  window.homelabContinue = {list: list, resume: resume, load: load, dismiss: dismiss,
    watched: function (entry) { if (markWatched(entry)) { publish(); drain(); return true; } return false; }, subscribe: function (fn) { listeners.push(fn); }};
  // Plugins may finish loading after Main has already collected its rows.
  setTimeout(function () {
    var active = L.Activity && typeof L.Activity.active === 'function' ? L.Activity.active() : null;
    if (!rowCount && active && active.component === 'main' && typeof L.Activity.refresh === 'function' && !L.Player.opened() && (!L.Modal || !L.Modal.opened()) && (!L.Select || !L.Select.opened || !L.Select.opened())) L.Activity.refresh();
  }, 1000);
})();
