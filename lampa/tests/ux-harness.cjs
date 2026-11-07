const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function bus() {
  const handlers = new Map();
  return {follow(name, fn) { for (const key of name.split(',')) { if (!handlers.has(key)) handlers.set(key, []); handlers.get(key).push(fn); } },
    remove(name, fn) { handlers.set(name, (handlers.get(name) || []).filter(handler => handler !== fn)); },
    send(name, value = {}) { for (const fn of [...(handlers.get(name) || [])]) fn(value); }};
}

function harness(t) {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const elements = [], calls = [], storage = new Map(), notices = [], rows = [], events = bus(), coreEvents = [], syncEvents = [], phaseEvents = [], revoked = [];
  function element(html = '') {
    const classes = new Set((/class="([^"]*)"/.exec(html)?.[1] || '').split(/\s+/));
    const handlers = {}, children = [], found = new Map();
    const e = {length: 1, classes, children, rect: {height: 160}, getBoundingClientRect() { return e.rect; }, attrs: {}, values: {}, content: '', events: handlers,
      on(names, selector, callback) { const fn = typeof selector === 'function' ? selector : callback; for (const name of names.split(' ')) (handlers[name] ||= []).push(fn); return e; },
      off() { for (const name of Object.keys(handlers)) delete handlers[name]; return e; },
      trigger(name) { let stopped = false; const event = {stopImmediatePropagation() { stopped = true; }}; for (const fn of [...(handlers[name] || [])]) { fn(event); if (stopped) break; } return e; },
      append(child) { children.push(child); child.parentElement = e; return e; }, parent() { return e.parentElement || {0: null}; }, after(child) { children.push(child); return e; }, appendTo() { return e; },
      querySelectorAll(selector) { return children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => child.classes.has(selector.slice(1))); },
      empty() { children.forEach(child => { child.parentElement = null; }); children.length = 0; found.clear(); e.content = ''; return e; }, remove() { e.removed = true; return e; },
      text(value) { if (value === undefined) return e.content; e.content = value; return e; }, html(value) { if (value === undefined) return e.content; e.content = value; return e; },
      attr(name, value) { if (value === undefined) return e.attrs[name]; e.attrs[name] = value; return e; }, removeAttr(name) { delete e.attrs[name]; return e; },
      data(name, value) { if (value === undefined) return e.values[name]; e.values[name] = value; return e; },
      css(name, value) { e.attrs['style:' + name] = value; return e; },
      addClass(name) { classes.add(name); return e; }, removeClass(name) { classes.delete(name); return e; }, hasClass(name) { return classes.has(name); },
      toggleClass(name, value) { value ? classes.add(name) : classes.delete(name); return e; },
      find(selector) {
        if (selector.includes(',')) { const list = selector.split(',').map(key => e.find(key)); return {text(value) { list.forEach(node => node.text(value)); return this; }}; }
        const indexed = /^\[data-chapter="(\d+)"\] img$/.exec(selector);
        if (indexed) return (elements.find(node => String(node.attrs['data-chapter']) === indexed[1]) || e).find('img');
        function search(node) {
          for (const child of node.children || []) {
            if (selector[0] === '.' && child.classes?.has(selector.slice(1))) return child;
            const deep = search(child); if (deep) return deep;
          }
        }
        const existing = search(e); if (existing) return existing;
        if (!found.has(selector)) { const node = element(selector[0] === '.' ? '<div class="' + selector.slice(1) + '"></div>' : selector); found.set(selector, node); }
        return found.get(selector);
      },
    };
    e[0] = e; elements.push(e); return e;
  }
  const $ = value => typeof value === 'string' ? element(value) : value;
  function makeVideo(values = {}) { const videoEvents = bus(); return {currentTime: 0, duration: 120, paused: false, readyState: 4, volume: .7, muted: false, playbackRate: 1,
    addEventListener: videoEvents.follow, removeEventListener: videoEvents.remove, fire: videoEvents.send, ...values}; }
  let video = makeVideo();
  let work = null, profile = 'profile-a', modal = null, select = null, controller = {name: 'player'}, selected, input, coreState = null, syncRows = [], scope = 'a', audioRetry = 0;
  const modalEvents = bus(), selectEvents = bus(), playerEvents = bus(), pvEvents = bus(), storageEvents = bus();
  const panel = element('<div><div class="player-panel__subs"></div></div>'), root = element();
  const L = {
    Player: {listener: playerEvents, playdata: () => work, opened: () => !!work, render: () => root, play(data) { work = data; playerEvents.send('start', data); playerEvents.send('ready', data); }, playlist(data) { L.playlistData = data; }},
    PlayerVideo: {listener: pvEvents, video: () => video, to: at => { selected = at; }},
    PlayerPanel: {listener: bus(), render: () => panel, reveal() { panel.addClass('panel--visible'); }, toggle() { L.Controller.toggle('player_panel'); }},
    Keypad: {listener: bus()},
    Controller: {enabled: () => controller, own: instance => controller.link === instance,
      add(name, config) { L.Controller.controllers[name] = config; }, controllers: {},
      toggle(name) { L.Controller.controllers[controller.name]?.gone?.(); controller = {name, link: L.Controller.controllers[name]?.link}; L.Controller.controllers[name]?.toggle?.(); },
      collectionSet() {}, collectionFocus(node) { node?.trigger?.('hover:focus'); }},
    Timeline: {filename: () => profile, link: (card, season, episode) => ({card: 'tv_' + card.id, season, episode}),
      view: (hash, meta) => ({hash, ...meta, percent: 90, time: 80, handler() {}})},
    Storage: {get: (key, fallback) => storage.get(key) ?? fallback, set(key, value) { storage.set(key, value); storageEvents.send('change', {name: key, value}); }, field: name => storage.get(name), listener: storageEvents},
    Utils: {secondsToTime: value => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(Math.floor(value % 60)).padStart(2, '0')},
    Noty: {show: text => notices.push(text)}, Router: {call: (name, value) => { L.routed = {name, value}; }},
    Select: {listener: selectEvents, show(value) { select = value; controller = {name: 'select'}; selectEvents.send('fullshow', {active: value}); },
      closeAll() { const previous = select; select = null; selectEvents.send('hide', {active: previous}); }},
    Modal: {listener: modalEvents, open(value) { modal = value; controller = {name: 'modal'}; modalEvents.send('fullshow', {active: value}); value.select?.trigger?.('hover:focus'); },
      update(html) { modal.html = html; modalEvents.send('toggle', {active: modal}); modal.select?.trigger?.('hover:focus'); },
      close() { const previous = modal; modal = null; controller = {name: 'player'}; modalEvents.send('close', {active: previous}); }},
    Input: {edit(options, callback) { input = {options, callback}; }},
    Torserver: {files(hash, success, failure) { L.sourceLookup = {hash, success, failure}; }, stream: (name, hash, index) => '/stream/' + name + '?link=' + hash + '&index=' + index,
      clearFileName(files) { files.forEach(file => { file.path_human = file.path.split('/').pop().replace(/\.[^.]+$/, ''); }); return files; },
      parse(data) { const season = +(data.path.match(/S(\d+)/i)?.[1] || 1), episode = +(data.path.match(/E(\d+)/i)?.[1] || data.path.match(/(?:^|\/)(\d+)\./)?.[1] || 0);
        return {season, episode, serial: !!data.movie.number_of_seasons, by_title: !!data.movie.original_title, hash: data.movie.original_title + ':' + season + ':' + episode}; }},
    Maker: {make(name, data, mask) {
      mask({only(...names) { return names; }});
      const tile = element('<div class="card selector"></div>');
      return {use(hooks) { tile.on('hover:enter', () => hooks.onEnter?.(tile)); tile.on('hover:focus', () => hooks.onFocus?.(tile)); tile.on('destroy', () => hooks.onDestroy?.()); },
        create() {}, render(js) { return js ? tile[0] : tile; }, destroy() { tile.trigger('destroy'); tile.remove(); }};
    }},
    Layer: {visible() {}},
    ContentRows: {add: row => rows.push(row)},
    Scroll: function () { const body = element(); this.render = js => js ? body[0] : body; this.body = () => body; this.clear = () => body.empty(); this.append = value => body.append(value); this.update = () => {}; this.destroy = () => {}; },
    Subscribe: bus,
    Api: {img: path => '/image' + path, sources: {tmdb: {get(path, params, done) { done({id: +path.split('?')[0].split('/')[1], name: 'Series', original_name: 'Original series', number_of_seasons: 1, poster_path: '/poster.jpg'}); }}}},
    HomelabGstAudio: {subscribe: fn => phaseEvents.push(fn), retryCurrent() { audioRetry++; return true; }},
  };
  const core = {version: 2, current: () => coreState, subscribe: fn => coreEvents.push(fn), retryMetadata() {}, setEnabled() {}};
  const sync = {scope: () => scope, url: path => 'https://lampa.test' + path + '?uid=test&profile_id=' + scope,
    rows: () => syncRows, extra: row => JSON.parse(row.extra || '{}'), pull: done => done(), subscribe: fn => syncEvents.push(fn)};
  function fetch(url, options = {}) { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); calls.push({url, options,
    finish(data, status = 200, headers = {}) { resolve({ok: status === 200, status, headers: {get: name => headers[name] ?? null}, json: async () => data, blob: async () => data}); }, fail() { reject(new Error('network')); }}); return promise; }
  const URLClass = class extends URL {};
  URLClass.createObjectURL = () => 'blob:' + Math.random(); URLClass.revokeObjectURL = value => revoked.push(value);
  const window = {appready: true, Lampa: L, jQuery: $, $, HomelabSync: sync, homelabSeekPreviews: core, fetch, AbortController, location: {href: 'https://lampa.test/'}, addEventListener: events.follow, dispatchEvent: event => events.send(event.type, event)};
  const context = {window, Lampa: L, $, fetch, URL: URLClass, AbortController, setTimeout, clearTimeout, Date, console};
  return {L, core, sync, elements, calls, storage, notices, rows, window, revoked,
    run(relative) { vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), context, {filename: relative}); },
    work: () => work, video: () => video, modal: () => modal, select: () => select, input: () => input, selected: () => selected, retryCount: () => audioRetry,
    coreState(value) { coreState = value; coreEvents.forEach(fn => fn()); },
    start(data) { work = data; playerEvents.send('start', data); playerEvents.send('ready', data); },
    destroy() { work = null; playerEvents.send('destroy'); }, videoEvent: pvEvents.send,
    replaceVideo() { const old = video; video = makeVideo({currentTime: 0, readyState: 0}); return old; },
    phase(type) { phaseEvents.forEach(fn => fn({type, work})); },
    profile(value) { profile = value; scope = value; storageEvents.send('change', {name: 'account'}); syncEvents.forEach(fn => fn()); },
    syncRows(value) { syncRows = value; },
    choose(item) { const previous = select; select = null; controller = {name: modal ? 'modal' : 'player'}; selectEvents.send('hide', {active: previous}); previous.onSelect(item); },
    tick: ms => t.mock.timers.tick(ms),
  };
}
async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
module.exports = {harness, flush};
