const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {harness, flush} = require('./ux-harness.cjs');

function setup(t, options = {}) {
  const h = harness(t), registry = {}, parser = [], requests = [], pages = new Map(), metadata = [], subscriptions = [];
  const original = h.window.$;
  let object, focused = null, focusCalls = 0, scrollCalls = 0;
  function dollar(value) {
    const node = original(value); if (!node || !node.children) return node;
    node.append = child => {
      const previous = child.parentElement;
      if (previous) { const index = previous.children.indexOf(child); if (index >= 0) previous.children.splice(index, 1); }
      node.children.push(child); child.parentElement = node; return node;
    };
    node.prepend = child => { node.children.unshift(child); child.parentElement = node; return node; };
    node.appendTo = parent => { parent.append(node); return node; };
    node.remove = () => {
      const parent = node.parentElement;
      if (parent) { const index = parent.children.indexOf(node); if (index >= 0) parent.children.splice(index, 1); }
      node.parentElement = null; node.removed = true; return node;
    };
    node.classList = {contains: name => node.classes.has(name)};
    node.contains = target => node === target || node.children.some(child => child.contains ? child.contains(target) : child === target);
    Object.defineProperty(node, 'offsetParent', {configurable: true, get() {
      for (let current = node; current; current = current.parentElement) if (current.removed || current.classes.has('hide')) return null;
      return node.parentElement || node;
    }});
    return node;
  }
  function fire(node, event) { for (const callback of node.events[event] || []) callback.call(node, {target: node}); }
  h.window.$ = dollar;
  h.L.Component = {add: (name, ctor) => { registry[name] = ctor; }};
  h.L.Listener = {follow() {}};
  h.L.Utils.hash = value => value;
  h.L.Storage.set('parser_use', true);
  h.L.Parser = {get: (params, done, fail) => parser.push({params, done, fail}), clear() {}};
  h.L.Scroll = function () {
    const root = dollar('<div class="scroll"></div>'), body = dollar('<div class="scroll-body"></div>'); root.append(body);
    this.body = () => body; this.render = js => js ? root[0] : root;
    this.minus = () => {}; this.update = () => { scrollCalls++; }; this.reset = () => {}; this.destroy = () => root.remove();
  };
  h.L.Activity = {active: () => object, push(value) { object = value; }, backward() { object = null; }};
  h.L.Controller.collectionFocus = (node, root) => {
    node = node || root[0].querySelectorAll('.selector').find(value => value.offsetParent !== null);
    if (node) { focused = node; focusCalls++; fire(node, 'hover:focus'); }
  };
  h.L.Select.close = h.L.Select.closeAll;
  h.L.Api.sources.tmdb.get = (url, params, done, fail) => metadata.push({url, done, fail});
  h.sync.subscribe = callback => { subscriptions.push(callback); return () => subscriptions.splice(subscriptions.indexOf(callback), 1); };
  function request(url, options) {
    return new Promise((resolve, reject) => {
      const job = {url: new URL(url), options, finish(value) { job.finished = true; resolve({ok: true, text: async () => typeof value === 'string' ? value : JSON.stringify(value)}); }};
      options.signal.addEventListener('abort', () => reject(new Error('aborted'))); requests.push(job);
    });
  }
  h.window.fetch = request;
  const document = {createElement() {
    const template = {innerHTML: ''};
    template.content = {querySelectorAll: selector => (pages.get(template.innerHTML)?.[selector] || []).map(value => ({
      getAttribute: key => key === 'data-json' ? JSON.stringify(value) : key === 's' && value.season != null ? String(value.season) : key === 'e' && value.episode != null ? String(value.episode) : null,
      textContent: value.text || '', classList: {contains: name => name === 'active' && value.active},
    }))}; return template;
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugins/common-sources.js'), 'utf8'),
    {window: h.window, Lampa: h.L, document, fetch: request, AbortController, URL, setTimeout, clearTimeout, Date, console});
  if (options.quality) h.window.HomelabSources.preferences({quality: options.quality});
  const movie = {id: 42, name: 'Series', original_title: 'Original', number_of_seasons: 2, imdb_id: 'tt42', kinopoisk_id: '42', ...options.movie};
  object = {component: 'homelab_sources', season: options.season, movie};
  if (options.recovery) object.homelab_recovery = {scope: h.sync.scope(), season: 1, episode: 1, voice: '', excludeProvider: '', position: 30, duration: 0, quality: 0, ...options.recovery};
  const component = new registry.homelab_sources(object); component.create(); component.start();
  return {...h, component, parser, pages, metadata, fire, requests,
    rows: () => component.render()[0].querySelectorAll('.homelab-common-result'),
    status: () => component.render()[0].querySelectorAll('.homelab-common-status')[0].text(),
    more: () => component.render()[0].querySelectorAll('.homelab-common-more')[0],
    control: text => h.elements.find(node => node.offsetParent !== null && node.classes.has('homelab-common-chip') && node.content === text),
    focused: () => focused, focusCalls: () => focusCalls, scrollCalls: () => scrollCalls,
    leave() { object = {component: 'main'}; },
    async finish(pathname, value) {
      h.tick(700); await flush(); const job = requests.find(entry => entry.url.pathname === pathname && !entry.finished); assert.ok(job, pathname);
      job.finish(value); await flush(); h.tick(700); await flush();
    },
  };
}

test('unknown-quality native sources remain reachable under a saved quality and identify the uncertainty', async t => {
  const h = setup(t, {quality: 1080});
  await h.finish('/lite/events', [{balanser: 'one', name: 'One', show: true, url: '/lite/one'}]);
  await h.finish('/lite/one', {rch: true});
  assert.equal(h.rows().length, 1);
  assert.match(h.rows()[0].find('.homelab-common-details').text(), /Качество неизвестно/);
});

for (const event of ['hover:hover', 'hover:touch']) test(`${event} freezes existing result order without scrolling or changing focus`, async t => {
  const h = setup(t);
  h.parser[0].done({Results: [{Title: 'Series S01 720p', Link: 'magnet:fixture', Tracker: 'Tracker', info: {voices: ['Low']}}]}); h.tick(150);
  const row = h.rows()[0], focused = h.focused(), focusCalls = h.focusCalls(), scrollCalls = h.scrollCalls();
  h.fire(row, event);
  assert.equal(h.focused(), focused); assert.equal(h.focusCalls(), focusCalls); assert.equal(h.scrollCalls(), scrollCalls);
  h.pages.set('online', {'.videos__item': [{method: 'call', text: '1 серия', voice_name: 'High', season: 1, episode: 1, url: '/lite/one/video?e=1'}]});
  await h.finish('/lite/events', [{balanser: 'one', name: 'One', show: true, url: '/lite/one'}]); await h.finish('/lite/one', 'online');
  assert.equal(h.rows()[0], row); assert.equal(h.rows().length, 2); assert.equal(h.scrollCalls(), scrollCalls);
  assert.equal(h.focused(), focused, 'asynchronous results must preserve the native keyboard focus');
});

test('native Watch season zero stays zero and the season menu uses only actual metadata', t => {
  const h = setup(t, {season: 0, movie: {seasons: [{season_number: 0, name: 'Спецвыпуски'}, {season_number: 2, name: 'Сезон 2'}]}});
  const button = h.control('Спецвыпуски'); assert.ok(button); h.fire(button, 'hover:enter');
  assert.deepEqual(Array.from(h.select().items, item => item.value), [0, 2]);
  h.select().onSelect(h.select().items[1]); h.fire(h.control('Сезон 2'), 'hover:enter');
  h.select().onSelect(h.select().items[0]); assert.ok(h.control('Спецвыпуски'));
  h.fire(h.component.render()[0].querySelectorAll('.selector').find(node => node.content === 'Серия 1'), 'hover:enter');
  assert.equal(h.metadata.at(-1).url, 'tv/42/season/0');
});

test('season metadata resolves asynchronously and a departed picker cannot open a stale menu', t => {
  const h = setup(t); h.fire(h.control('Сезон 1'), 'hover:enter');
  assert.equal(h.select(), null); assert.equal(h.metadata[0].url, 'tv/42');
  h.metadata[0].done({id: 42, seasons: [{season_number: 0, name: 'Спецвыпуски'}, {season_number: 2, name: 'Сезон 2'}]});
  assert.deepEqual(Array.from(h.select().items, item => item.value), [0, 2]);
  h.L.Select.close(); h.L.Controller.toggle('content'); h.leave(); h.metadata[0].done({id: 42, seasons: [{season_number: 9}]});
  assert.equal(h.select(), null);
});

const episodePage = (voice, extra = {}) => ({'.videos__item': [{method: 'call', text: '1 серия', season: 1, episode: 1, url: '/lite/x/video', ...extra}],
  '.videos__button': [{active: true, text: voice, url: '/lite/x?s=1&t=' + voice}]});

test('a saved quality keeps unknown-quality online voices visible and labelled, but hides other known qualities', async t => {
  const h = setup(t, {quality: 1080});
  h.pages.set('unknown', episodePage('Studio A'));
  h.pages.set('lower', episodePage('Studio B', {method: 'play', quality: {'720p': '/media'}}));
  await h.finish('/lite/events', [{balanser: 'one', name: 'One', show: true, url: '/lite/one'}, {balanser: 'two', name: 'Two', show: true, url: '/lite/two'}]);
  await h.finish('/lite/one', 'unknown'); await h.finish('/lite/two', 'lower');
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].find('.homelab-common-voice').text(), 'Studio A');
  assert.match(h.rows()[0].find('.homelab-common-details').text(), /Качество уточняется/);
});

test('focusing "more" inside the list scrolls it into view', async t => {
  const h = setup(t);
  h.parser[0].done({Results: Array.from({length: 22}, (_, i) => ({Title: 'Series S01 720p ' + i, Link: 'magnet:' + i, Tracker: 'T'}))}); h.tick(150);
  const more = h.more(); assert.ok(more); const before = h.scrollCalls();
  h.fire(more, 'hover:focus');
  assert.equal(h.scrollCalls(), before + 1);
});

test('recovery mode never starts a torrent search', async t => {
  const h = setup(t, {recovery: {voice: 'Studio A'}});
  assert.equal(h.parser.length, 0);
  await h.finish('/lite/events', [{balanser: 'one', name: 'One', show: true, url: '/lite/one'}]);
  h.pages.set('a', episodePage('Studio A')); await h.finish('/lite/one', 'a'); h.tick(150);
  assert.doesNotMatch(h.status(), /Ищем|Торрент/);
});

test('a refused online handoff keeps the search running; leaving mid-search shows an interrupted state', async t => {
  const h = setup(t);
  await h.finish('/lite/events', [{balanser: 'one', name: 'One', show: true, url: '/lite/one'}, {balanser: 'two', name: 'Two', show: true, url: '/lite/two'}]);
  h.pages.set('a', episodePage('Studio A')); await h.finish('/lite/one', 'a'); h.tick(150);
  const pending = h.requests.find(r => r.url.pathname === '/lite/two' && !r.finished);
  h.window.HomelabOnlineResume = {select: () => false};
  h.fire(h.rows().find(row => row.find('.homelab-common-voice').text() === 'Studio A'), 'hover:enter');
  assert.ok(h.notices.some(text => /загружается/.test(text)));
  assert.equal(pending.options.signal.aborted, false, 'the search is not cancelled by a refused handoff');
  h.component.pause(); h.component.start();
  assert.match(h.status(), /прерван/);
  assert.doesNotMatch(h.status(), /Ищем/);
});

test('remote navigation ignores scrolled-out tiles, walks the list in order and Left at the edge opens the menu', async t => {
  const h = setup(t);
  h.parser[0].done({Results: [0, 1, 2].map(i => ({Title: 'Series S01 720p ' + i, Link: 'magnet:' + i, Tracker: 'T'}))}); h.tick(150);
  const rect = (top, left = 0, width = 100, height = 20) => ({top, left, width, height, bottom: top + height, right: left + width});
  const view = h.component.render()[0].querySelectorAll('.scroll')[0]; view.rect = rect(100, 0, 400, 300);
  for (const node of h.component.render()[0].querySelectorAll('.selector')) node.rect = rect(-1000, 0);
  const tab = h.component.render()[0].querySelectorAll('.homelab-common-tab')[0], chip = h.component.render()[0].querySelectorAll('.homelab-common-chip').find(node => node.content === 'Сезон 1');
  chip.rect = rect(10, 0); tab.rect = rect(60, 0);
  const [first, second, third] = h.rows();
  first.rect = rect(40, 200); second.rect = rect(110, 200); third.rect = rect(140, 200); // first is scrolled out above the viewport
  h.L.Controller.collectionFocus(tab, h.component.render());
  h.L.Controller.controllers.content.up(); assert.equal(h.focused(), chip, 'a hidden tile behind the header is not a target');
  h.L.Controller.collectionFocus(tab, h.component.render());
  h.L.Controller.controllers.content.down(); assert.equal(h.focused(), second, 'down enters the first visible tile');
  h.L.Controller.controllers.content.up(); assert.equal(h.focused(), first, 'inside the list Up follows list order');
  h.L.Controller.controllers.content.left(); assert.equal(h.L.Controller.enabled().name, 'menu');
});
