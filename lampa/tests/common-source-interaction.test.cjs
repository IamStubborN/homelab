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
  const listeners = {};
  h.L.Listener = {follow(name, fn) { (listeners[name] ||= []).push(fn); }};
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
  if (options.facts) h.window.HomelabQuality = options.facts;
  if (options.watching) h.window.homelabContinue = {list: () => [options.watching]};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugins/common-sources.js'), 'utf8'),
    {window: h.window, Lampa: h.L, document, fetch: request, AbortController, URL, setTimeout, clearTimeout, Date, console});
  if (options.quality) h.window.HomelabSources.preferences({quality: options.quality});
  const movie = {id: 42, name: 'Series', original_title: 'Original', number_of_seasons: 2, imdb_id: 'tt42', kinopoisk_id: '42', ...options.movie};
  let component = null;
  function openScreen() {
    object = {component: 'homelab_sources', season: options.season, movie};
    if (options.recovery) object.homelab_recovery = {scope: h.sync.scope(), season: 1, episode: 1, voice: '', excludeProvider: '', position: 30, duration: 0, quality: 0, ...options.recovery};
    component = new registry.homelab_sources(object); component.create(); component.start();
  }
  if (!options.deferred) openScreen();
  const settingRow = label => component.render()[0].querySelectorAll('.homelab-common-setting').find(node => node.offsetParent !== null && (node.content === label || node.find('.homelab-common-setting-label').text() === label));
  return {...h, get component() { return component; }, openScreen, movie, parser, pages, metadata, fire, requests,
    emit(name, event) { (listeners[name] || []).forEach(fn => fn(event)); },
    settingRow,
    setting: label => settingRow(label).querySelectorAll('.homelab-common-setting-value').find(node => node.classes.has('selected')).text(),
    toSetting(label) { h.L.Controller.collectionFocus(settingRow(label), component.render()); },
    summary: () => component.render()[0].querySelectorAll('.homelab-common-summary-text')[0].text(),
    detail: () => component.render()[0].querySelectorAll('.homelab-common-detail')[0],
    rows: () => component.render()[0].querySelectorAll('.homelab-common-result'),
    status: () => component.render()[0].querySelectorAll('.homelab-common-status-text')[0].text(),
    more: () => component.render()[0].querySelectorAll('.homelab-common-more')[0],
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
  assert.equal(h.rows()[0].find('.homelab-common-voice').text(), 'One');
  assert.match(h.rows()[0].find('.homelab-common-details').text(), /список озвучек источника/);
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

test('native Watch season zero stays zero and the season list uses only actual metadata', t => {
  const h = setup(t, {season: 0, movie: {seasons: [{season_number: 0, name: 'Спецвыпуски'}, {season_number: 2, name: 'Сезон 2'}]}}), c = h.L.Controller.controllers;
  c.content.right(); assert.equal(h.setting('Сезон'), 'Спецвыпуски'); assert.equal(h.metadata.length, 0, 'known seasons are not asked again');
  h.fire(h.settingRow('Сезон'), 'hover:enter');
  assert.deepEqual(Array.from(h.select().items, item => item.value), [0, 2]);
  h.select().onSelect(h.select().items[1]); assert.match(h.summary(), /^С2 · Е1/);
  c.content.right(); h.fire(h.settingRow('Сезон'), 'hover:enter');
  h.select().onSelect(h.select().items[0]); assert.match(h.summary(), /^Спецвыпуски · Е1/);
  c.content.right(); h.fire(h.settingRow('Серия'), 'hover:enter');
  assert.equal(h.metadata.at(-1).url, 'tv/42/season/0');
});

test('season metadata resolves asynchronously and a departed picker cannot open a stale menu', t => {
  const h = setup(t); h.L.Controller.controllers.content.right();
  assert.equal(h.metadata[0].url, 'tv/42', 'the panel asks the seasons once');
  h.fire(h.settingRow('Сезон'), 'hover:enter');
  const menu = h.metadata.at(-1); assert.equal(h.select(), null); assert.equal(menu.url, 'tv/42');
  menu.done({id: 42, seasons: [{season_number: 0, name: 'Спецвыпуски'}, {season_number: 2, name: 'Сезон 2'}]});
  assert.deepEqual(Array.from(h.select().items, item => item.value), [0, 2]);
  h.L.Select.close(); h.L.Controller.toggle('content'); h.leave(); menu.done({id: 42, seasons: [{season_number: 9}]});
  assert.equal(h.select(), null);
});

test('Right opens the parameters; arrows step the episode within the season and closing searches it', t => {
  const h = setup(t, {movie: {seasons: [{season_number: 1, episode_count: 3}, {season_number: 2, episode_count: 8}]}}), c = h.L.Controller.controllers;
  c.content.right(); assert.equal(h.L.Controller.enabled().name, 'homelab_common_settings');
  h.toSetting('Серия'); c.homelab_common_settings.right(); c.homelab_common_settings.right();
  assert.equal(h.setting('Серия'), 'Серия 3');
  c.homelab_common_settings.right(); assert.equal(h.setting('Серия'), 'Серия 3', 'stops at the last episode of the season');
  assert.match(h.summary(), /^С1 · Е1/, 'nothing is searched while the value is being picked');
  const searches = h.parser.length;
  c.homelab_common_settings.back();
  assert.equal(h.L.Controller.enabled().name, 'content'); assert.match(h.summary(), /^С1 · Е3/);
  assert.equal(h.parser.length, searches + 1, 'closing the panel searches the new episode');
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
  h.parser[0].done({Results: Array.from({length: 22}, (_, i) => ({Title: 'Series S01 720p ' + i, Link: 'magnet:' + i, Tracker: 'T', info: {voices: ['Voice ' + i]}}))}); h.tick(150);
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

test('remote navigation: the hero and the list are one column, chips walk sideways, Left at the edge opens the menu', async t => {
  const h = setup(t), c = h.L.Controller.controllers, all = () => h.component.render()[0].querySelectorAll('.selector');
  h.parser[0].done({Results: [0, 1, 2, 3].map(i => ({Title: 'Series S01 720p ' + i, Link: 'magnet:' + i, Tracker: 'T', info: {voices: ['Voice ' + i]}}))}); h.tick(150);
  const rect = (top, left = 0, width = 100, height = 20) => ({top, left, width, height, bottom: top + height, right: left + width});
  const view = h.component.render()[0].querySelectorAll('.scroll')[0]; view.rect = rect(100, 0, 400, 300);
  for (const node of all()) node.rect = rect(-1000, 0);
  const summary = all().find(node => node.classes.has('homelab-common-summary')), chipAll = chipOf(h, 'Всё'), chipOnline = chipOf(h, 'Онлайн');
  summary.rect = rect(60, 600); chipAll.rect = rect(60, 0); chipOnline.rect = rect(60, 120);
  const [hero, hidden, second, third] = h.rows();
  hero.rect = rect(80, 200); hidden.rect = rect(30, 200); second.rect = rect(110, 200); third.rect = rect(140, 200); // hidden is scrolled out above the viewport
  h.L.Controller.collectionFocus(chipAll, h.component.render());
  c.content.right(); assert.equal(h.focused(), chipOnline, 'Right walks the chips');
  c.content.down(); assert.equal(h.focused(), hero, 'down from the chips reaches the hero, not a scrolled-out row');
  c.content.down(); assert.equal(h.focused(), hidden, 'below the hero the list follows its order');
  c.content.up(); assert.equal(h.focused(), hero);
  c.content.up(); assert.equal(h.focused(), chipOnline, 'up from the hero returns to the chips');
  const ep = h.component.render()[0].querySelectorAll('.homelab-common-ep')[0]; ep.rect = rect(20, 220);
  h.L.Controller.collectionFocus(hero, h.component.render()); c.content.up();
  assert.equal(h.focused(), chipOnline, 'the chips row is nearer than an episode right above the hero');
  h.L.Controller.collectionFocus(summary, h.component.render());
  c.content.right(); assert.equal(h.L.Controller.enabled().name, 'homelab_common_settings', 'Right on the parameters chip opens them');
  c.homelab_common_settings.back(); h.L.Controller.collectionFocus(second, h.component.render());
  c.content.left(); assert.equal(h.L.Controller.enabled().name, 'menu');
});

test('opening a torrent redraws the status so it is not left as searching', async t => {
  const h = setup(t);
  h.L.Torrent = {back() {}, start() {}};
  h.parser[0].done({Results: [{Title: 'Series S01 720p', Link: 'magnet:fixture', Tracker: 'T'}]}); h.tick(150);
  assert.match(h.status(), /Ищем/);
  h.fire(h.rows()[0], 'hover:enter');
  assert.doesNotMatch(h.status(), /Ищем/); assert.match(h.status(), /прерван/);
});

test('an online row whose identity the bridge cannot accept opens the native source instead of claiming it is loading', async t => {
  const h = setup(t), long = 'Studio '.repeat(40).trim();
  await h.finish('/lite/events', [{balanser: 'one', name: 'One', show: true, url: '/lite/one'}]);
  h.pages.set('long', episodePage(long)); await h.finish('/lite/one', 'long'); h.tick(150);
  let selected = 0; h.window.HomelabOnlineResume = {select: () => { selected++; return false; }};
  const pushes = []; const push = h.L.Activity.push; h.L.Activity.push = value => { pushes.push(value); push(value); };
  h.fire(h.rows().find(row => row.find('.homelab-common-voice').text() === long), 'hover:enter');
  assert.equal(selected, 0); assert.equal(pushes[0].component, 'lampac'); assert.equal(pushes[0].lampac_custom_select, 'one');
  assert.ok(!h.notices.some(text => /загружается/.test(text)));
});

test('Right opens the parameters from the "more" button too, and Back returns there', async t => {
  const h = setup(t), c = h.L.Controller.controllers;
  h.parser[0].done({Results: Array.from({length: 22}, (_, i) => ({Title: 'Series S01 720p ' + i, Link: 'magnet:' + i, Tracker: 'T', info: {voices: ['Voice ' + i]}}))}); h.tick(150);
  const more = h.more(); h.L.Controller.collectionFocus(more, h.component.render());
  c.content.right(); assert.equal(h.L.Controller.enabled().name, 'homelab_common_settings');
  c.homelab_common_settings.back();
  assert.equal(h.L.Controller.enabled().name, 'content'); assert.equal(h.focused(), more);
});

const twoProviders = [{balanser: 'one', name: 'One', show: true, url: '/lite/one'}, {balanser: 'two', name: 'Two', show: true, url: '/lite/two'}, {balanser: 'three', name: 'Three', show: true, url: '/lite/three'}];
async function grouped(t, options) {
  const h = setup(t, options);
  h.parser[0].done({Results: []});
  await h.finish('/lite/events', twoProviders);
  assert.match(h.status(), /Ищу: 0 из 3 источников/);
  h.pages.set('one', episodePage('Studio A')); h.pages.set('two', episodePage('Studio A', {method: 'play', quality: {'1080p': '/media'}})); h.pages.set('three', episodePage('Studio B', {method: 'play', quality: {'720p': '/media'}}));
  await h.finish('/lite/one', 'one'); await h.finish('/lite/two', 'two');
  assert.match(h.status(), /Ищу: 2 из 3 источников/);
  await h.finish('/lite/three', 'three'); h.tick(150);
  return h;
}
const voice = row => row.find('.homelab-common-voice').text();
function chipOf(h, name) { return h.component.render()[0].querySelectorAll('.homelab-common-filter').find(node => node.children[0] && node.children[0].text() === name); }

test('the voice being watched leads, from the source it played from', async t => {
  const h = await grouped(t, {watching: {card: 'tv_42', kind: 'online', online: {provider: 'one', voice: 'Studio B'}}}), picked = [];
  h.window.HomelabOnlineResume = {select: row => { picked.push(row.provider); return true; }};
  assert.equal(voice(h.rows()[0]), 'Studio B', 'the 720p voice being watched beats the 1080p one');
  assert.match(h.rows()[0].find('.homelab-common-pick').text(), /Ваша озвучка/);
  h.fire(h.rows()[0], 'hover:enter'); assert.deepEqual(picked, ['three']);
});

test('the watched voice plays from its own source even when another has a higher quality', async t => {
  const h = await grouped(t, {watching: {card: 'tv_42', kind: 'online', online: {provider: 'one', voice: 'Studio A'}}}), picked = [];
  h.window.HomelabOnlineResume = {select: row => { picked.push(row.provider); return true; }};
  h.fire(h.rows()[0], 'hover:enter'); assert.deepEqual(picked, ['one']);
});

test('uploads without a named voice share one card below every named voice', async t => {
  const h = setup(t, {movie: {name: undefined, title: 'Film', original_title: 'Film'}});
  h.parser[0].done({Results: []});
  await h.finish('/lite/events', twoProviders.slice(0, 2));
  const film = (text, quality) => ({method: 'play', text, url: '/v', quality: {[quality]: '/m'}});
  h.pages.set('one', {'.videos__item': [film('Film (2014) 4K UHD', '2160p'), film('🎬Film - 2160p', '2160p'), film('Фильм/ Film 2014', '2160p')]});
  h.pages.set('two', {'.videos__item': [film('Studio A', '720p')]});
  await h.finish('/lite/one', 'one'); await h.finish('/lite/two', 'two'); h.tick(150);
  assert.deepEqual(h.rows().map(voice), ['Studio A', 'Без названия · One']);
  assert.match(h.rows()[1].find('.homelab-common-details').text(), /ещё 2 видео/);
});

test('the watched voice is re-read on every draw', async t => {
  let watching = {card: 'tv_42', kind: 'online', online: {provider: 'three', voice: 'Studio B'}};
  const h = await grouped(t, {watching: {}});
  h.window.homelabContinue = {list: () => [watching]}; h.tick(1100);
  h.component.start(); h.tick(1100);
  const studioB = h.rows().find(row => voice(row) === 'Studio B');
  assert.match(studioB.find('.homelab-common-pick').text(), /Ваша озвучка/, 'rows keep their places once focused, the mark moves');
});

test('a watched voice from another title changes nothing', async t => {
  const h = await grouped(t, {watching: {card: 'tv_7', kind: 'online', online: {provider: 'three', voice: 'Studio B'}}});
  assert.equal(voice(h.rows()[0]), 'Studio A');
  assert.doesNotMatch(h.rows()[0].find('.homelab-common-pick').text(), /Ваша озвучка/);
});

test('one card per voice plays its best source and names how many sources stand behind it', async t => {
  const h = await grouped(t), picked = [];
  h.window.HomelabOnlineResume = {select: row => { picked.push(row.provider); return true; }};
  assert.deepEqual(h.rows().map(voice), ['Studio A', 'Studio B']);
  const [top] = h.rows();
  assert.ok(top.classes.has('is-hero') || [...top.classes].some(name => /is-hero/.test(name)), 'the top card is the recommendation');
  assert.equal(top.find('.homelab-common-pick').text(), 'Лучший выбор');
  assert.match(top.find('.homelab-common-details').text(), /^Two · ещё 1 источник$/);
  assert.equal(top.find('.homelab-common-q').text(), '1080p');
  assert.match(h.status(), /Найдено: 2 озвучки · до 1080p/);
  h.fire(top, 'hover:enter'); assert.deepEqual(picked, ['two'], 'Enter plays the best source of the voice');
});

test('focus follows the recommendation until the first key press, then never jumps', async t => {
  const h = setup(t);
  h.parser[0].done({Results: []});
  await h.finish('/lite/events', twoProviders);
  h.pages.set('one', episodePage('Studio A', {method: 'play', quality: {'720p': '/media'}})); h.pages.set('two', episodePage('Studio B', {method: 'play', quality: {'1080p': '/media'}}));
  await h.finish('/lite/one', 'one'); h.tick(150);
  assert.equal(h.focused(), h.rows()[0], 'focus sits on the only card');
  await h.finish('/lite/two', 'two'); h.tick(150);
  assert.equal(voice(h.focused()), 'Studio B', 'a better recommendation takes the top and the focus while untouched');
  h.L.Controller.controllers.content.down(); const second = h.focused(); assert.equal(voice(second), 'Studio A');
  h.pages.set('three', episodePage('Studio C', {method: 'play', quality: {'2160p': '/media'}}));
  await h.finish('/lite/three', 'three'); h.tick(150);
  assert.equal(h.focused(), second, 'after a key press late results never move the focus');
  assert.equal(voice(h.rows().at(-1)), 'Studio C', 'late results append below');
});

test('a long press lists every source of a voice; there is no favourite voice', async t => {
  const h = await grouped(t), picked = [];
  h.window.HomelabOnlineResume = {select: row => { picked.push(row.provider); return true; }};
  h.fire(h.focused(), 'hover:long');
  const menu = h.select(); assert.match(menu.title, /2 источника · Studio A/);
  assert.deepEqual(JSON.parse(JSON.stringify(menu.items.map(item => item.title))), ['Two · лучший', 'One']);
  assert.match(menu.items[0].subtitle, /1080p · заявлено/); assert.equal(menu.items[1].subtitle, 'Качество уточняется');
  menu.onSelect(menu.items[1]); assert.deepEqual(picked, ['one'], 'an alternative source can be chosen explicitly');
  assert.ok(!h.elements.some(node => node.classes.has('homelab-common-favorite')));
});

test('sources of one card are told apart by what their own voice name adds', async t => {
  const h = setup(t);
  h.parser[0].done({Results: []});
  await h.finish('/lite/events', twoProviders.slice(0, 2));
  h.pages.set('one', episodePage('Дублированный HDrezka', {method: 'play', quality: {'1080p': '/media'}}));
  h.pages.set('two', episodePage('Профессиональный многоголосый HDRezka', {method: 'play', quality: {'1080p': '/media'}}));
  await h.finish('/lite/one', 'one'); await h.finish('/lite/two', 'two'); h.tick(150);
  h.fire(h.focused(), 'hover:long');
  const titles = JSON.parse(JSON.stringify(h.select().items.map(item => item.title.replace(' · лучший', '')))).sort();
  assert.deepEqual(titles, ['One · Дублированный', 'Two · Профессиональный многоголосый']);
});

test('the view setting switches between voice cards and every source', async t => {
  const h = await grouped(t), c = h.L.Controller.controllers;
  c.content.right(); h.toSetting('Показывать'); c.homelab_common_settings.right();
  assert.deepEqual(h.rows().map(voice), ['Studio A', 'Studio B', 'Studio A']);
  assert.equal(h.setting('Показывать'), 'Все источники'); assert.match(h.summary(), /все источники/);
});

test('«Обновить поиск» searches the episode picked in the panel; Left never closes from the episode row', t => {
  const h = setup(t, {movie: {seasons: [{season_number: 1, episode_count: 3}]}}), c = h.L.Controller.controllers;
  c.content.right(); h.toSetting('Серия'); c.homelab_common_settings.left();
  assert.equal(h.L.Controller.enabled().name, 'homelab_common_settings', 'a held Left stops at the first episode');
  c.homelab_common_settings.right(); const searches = h.parser.length;
  h.fire(h.settingRow('Обновить поиск'), 'hover:enter');
  assert.match(h.summary(), /^С1 · Е2/); assert.equal(h.parser.length, searches + 1, 'one search, for the new episode');
  assert.equal(h.L.Controller.enabled().name, 'content');
});

test('after an episode change focus follows the new recommendation, not the header', async t => {
  const h = setup(t, {movie: {seasons: [{season_number: 1, episode_count: 3}]}}), c = h.L.Controller.controllers;
  c.content.right(); h.toSetting('Серия'); c.homelab_common_settings.right(); c.homelab_common_settings.back();
  h.parser.at(-1).done({Results: [{Title: 'Series S01 720p', Link: 'magnet:fixture', Tracker: 'T'}]}); h.tick(150);
  assert.equal(h.focused(), h.rows()[0]);
});

test('the subtitles filter hides sources without subtitles; Left at the first value closes the panel', async t => {
  const h = await grouped(t), c = h.L.Controller.controllers;
  c.content.right(); h.toSetting('Субтитры'); c.homelab_common_settings.right();
  assert.equal(h.rows().length, 0); assert.ok(chipOf(h, 'Субтитры').classes.has('is-on'));
  assert.match(h.component.render()[0].querySelectorAll('.homelab-common-empty-hint')[0].text(), /субтитр/);
  c.homelab_common_settings.left(); assert.equal(h.rows().length, 2);
  c.homelab_common_settings.left(); assert.equal(h.L.Controller.enabled().name, 'content');
  assert.equal(h.focused(), h.rows()[0], 'focus returns to the list, not the header');
});

test('the detail panel follows the focused card and lists its sources, the one OK plays first', async t => {
  const h = await grouped(t), detail = h.detail();
  assert.ok(!detail.classes.has('hide'));
  assert.deepEqual(detail.querySelectorAll('.homelab-common-source-name').map(node => node.text()), ['Two', 'One']);
  assert.ok(detail.querySelectorAll('.homelab-common-source')[0].classes.has('is-best'));
  assert.match(detail.querySelectorAll('.homelab-common-verdict')[0].text(), /не проверено/);
  h.L.Controller.controllers.content.down();
  assert.equal(detail.querySelectorAll('.homelab-common-detail-voice')[0].text(), 'Studio B');
});

test('a title card the user stays on prefetches the search and the screen adopts it', async t => {
  const h = setup(t, {deferred: true}), full = {component: 'full', activity: {render: () => h.window.$('<div></div>')}};
  h.L.Activity.push(full);
  h.emit('full', {type: 'complite', data: {movie: h.movie}, object: full});
  assert.equal(h.parser.length, 0, 'a passing glance starts nothing');
  h.tick(1500); assert.equal(h.parser.length, 1, 'a card the user stays on starts the search');
  h.openScreen(); assert.equal(h.parser.length, 1, 'the screen adopts the running search');
  h.parser[0].done({Results: [{Title: 'Series S01 720p', Link: 'magnet:fixture', Tracker: 'T'}]}); h.tick(150);
  assert.equal(h.rows().length, 1, 'its results reach the screen');
});

test('a trailer played from the title card cancels the prefetched search', async t => {
  const h = setup(t, {deferred: true}), full = {component: 'full', activity: {render: () => h.window.$('<div></div>')}};
  h.L.Activity.push(full); h.emit('full', {type: 'complite', data: {movie: h.movie}, object: full}); h.tick(1500); h.tick(700); await flush();
  const events = h.requests.find(entry => entry.url.pathname === '/lite/events'); assert.ok(events);
  h.L.Player.listener.send('start', {});
  assert.equal(events.options.signal.aborted, true);
});

test('leaving the title card for another screen cancels the prefetched search', async t => {
  const h = setup(t, {deferred: true}), full = {component: 'full', activity: {render: () => h.window.$('<div></div>')}};
  h.L.Activity.push(full); h.emit('full', {type: 'complite', data: {movie: h.movie}, object: full}); h.tick(1500); h.tick(700); await flush();
  const events = h.requests.find(entry => entry.url.pathname === '/lite/events'); assert.ok(events);
  h.emit('activity', {type: 'init', component: 'torrents', object: {component: 'torrents'}});
  assert.equal(events.options.signal.aborted, true);
  h.openScreen(); assert.equal(h.parser.length, 2, 'the screen starts its own search');
});

test('recovery lists the kept voice by source and folds other voices below', async t => {
  const h = setup(t, {recovery: {voice: 'Studio A'}});
  await h.finish('/lite/events', twoProviders.slice(0, 3));
  h.pages.set('one', episodePage('Studio A')); h.pages.set('two', episodePage('Studio A')); h.pages.set('three', episodePage('Studio B'));
  await h.finish('/lite/one', 'one'); await h.finish('/lite/two', 'two'); await h.finish('/lite/three', 'three'); h.tick(150);
  const names = h.rows().map(row => row.find('.homelab-common-voice').text());
  assert.equal(names.length, 2, 'one row per source of the kept voice; Studio B waits in the fold');
  assert.ok(names.every(name => name !== 'Studio A'), 'rows are named by their source, the voice is said once above');
  assert.match(h.rows()[0].find('.homelab-common-details').text(), /Studio A/);
  assert.doesNotMatch(h.summary(), /все источники/);
  const fold = h.component.render()[0].querySelectorAll('.homelab-common-section')[0];
  assert.match(fold.text(), /Другие озвучки · 1/);
  h.fire(fold, 'hover:enter');
  assert.equal(h.rows().length, 3);
  const picked = []; h.window.HomelabOnlineResume = {select: row => { picked.push(row.provider); return true; }};
  h.fire(h.rows().find(row => row.find('.homelab-common-voice').text() === 'Studio B'), 'hover:enter');
  assert.deepEqual(picked, ['three'], 'a voice from the fold plays');
});

test('the focused summary paints over the generic selector focus', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'plugins', 'common-sources.js'), 'utf8');
  assert.match(css, /\.homelab-common \.homelab-common-summary\.selector\.focus\{outline:0;background:#fff;color:#000[;}]/);
});

test('a finished empty search explains itself instead of a blank list', async t => {
  const h = setup(t, {quality: 2160});
  h.parser[0].done({Results: [{Title: 'Series S01 720p', Link: 'magnet:fixture', Tracker: 'T'}]});
  await h.finish('/lite/events', []); h.tick(150);
  assert.equal(h.rows().length, 0);
  const empty = h.component.render()[0].querySelectorAll('.homelab-common-empty-hint')[0];
  assert.match(empty.text(), /4K/); assert.match(h.status(), /Ничего не найдено/);
});

test('torrent cards carry seeds, size and codec as badges', async t => {
  const h = setup(t);
  h.parser[0].done({Results: [{Title: 'Series S01 2160p HEVC', Link: 'magnet:fixture', Tracker: 'Tracker', Seeders: 21, Size: 3221225472}]}); h.tick(150);
  const badges = h.rows()[0].find('.homelab-common-badges').children.map(node => node.text());
  assert.deepEqual(badges, ['21 сид', '3,0 ГБ', 'HEVC']);
  assert.equal(h.rows()[0].find('.homelab-common-q').text(), '4K');
});

test('voice cards probe only their leader; alternates are asked when their source list opens', async t => {
  const h = setup(t), probes = () => h.requests.filter(r => r.url.pathname === '/lite/x/video').length;
  h.parser[0].done({Results: []});
  await h.finish('/lite/events', twoProviders.slice(0, 2));
  h.pages.set('two', episodePage('Studio A', {method: 'play', quality: {'1080p': '/media'}})); h.pages.set('one', episodePage('Studio A'));
  await h.finish('/lite/two', 'two'); h.tick(150); await h.finish('/lite/one', 'one'); h.tick(3000); await flush();
  assert.equal(probes(), 1, 'the leader\'s claimed quality is checked; its unknown alternate waits');
  h.fire(h.focused(), 'hover:long'); h.tick(1000); await flush();
  assert.equal(probes(), 2, 'opening the source list probes the alternate');
});

test('torrents sit open in their section under online voices and fold on Enter', async t => {
  const h = setup(t);
  h.parser[0].done({Results: [{Title: 'Series S01 1080p', Link: 'magnet:a', Tracker: 'T', Seeders: 20, info: {voices: ['Torrent Voice']}}]});
  await h.finish('/lite/events', [{balanser: 'one', name: 'One', show: true, url: '/lite/one'}]);
  h.pages.set('a', episodePage('Studio A')); await h.finish('/lite/one', 'a'); h.tick(150);
  const section = () => h.component.render()[0].querySelectorAll('.homelab-common-section')[0];
  assert.deepEqual(h.rows().map(voice), ['Studio A', 'Torrent Voice'], 'torrents are shown, not folded');
  assert.match(section().text(), /▾ Торренты · 1 раздача/);
  h.fire(section(), 'hover:enter');
  assert.deepEqual(h.rows().map(voice), ['Studio A']);
  assert.match(section().text(), /▸ Торренты · 1 раздача — показать/);
});

test('online rows above a torrents header get a heading of their own', async t => {
  const h = setup(t);
  h.parser[0].done({Results: [{Title: 'Series S01 1080p', Link: 'magnet:a', Tracker: 'T', Seeders: 20, info: {voices: ['Torrent Voice']}}]});
  await h.finish('/lite/events', twoProviders.slice(0, 2));
  h.pages.set('a', episodePage('Studio A')); h.pages.set('b', episodePage('Studio B'));
  await h.finish('/lite/one', 'a'); await h.finish('/lite/two', 'b'); h.tick(150);
  const labels = h.component.render()[0].querySelectorAll('.homelab-common-label').map(node => node.text());
  assert.match(labels[0] || '', /^Онлайн · 1 озвучка$/);
});

test('sources that keep their voices get one row each under a heading; Enter opens that source', async t => {
  const h = setup(t), pushes = [];
  const push = h.L.Activity.push; h.L.Activity.push = value => { pushes.push(value); push(value); };
  h.parser[0].done({Results: []});
  await h.finish('/lite/events', twoProviders.slice(0, 2));
  await h.finish('/lite/one', {rch: true}); await h.finish('/lite/two', {rch: true}); h.tick(150);
  assert.deepEqual(h.rows().map(voice), ['One', 'Two']);
  assert.equal(h.component.render()[0].querySelectorAll('.homelab-common-label')[0].text(), 'Выбор озвучки внутри источника');
  h.fire(h.rows()[1], 'hover:enter');
  assert.equal(pushes.at(-1).lampac_custom_select, 'two');
});

test('a long press on a per-source row is titled with that source', async t => {
  const h = setup(t);
  h.parser[0].done({Results: []});
  await h.finish('/lite/events', twoProviders.slice(0, 2));
  await h.finish('/lite/one', {rch: true}); await h.finish('/lite/two', {rch: true}); h.tick(150);
  h.fire(h.rows()[1], 'hover:long');
  const menu = h.select(); assert.equal(menu.title, 'Two');
  assert.deepEqual(JSON.parse(JSON.stringify(menu.items.map(item => item.title))), ['Two']);
});

test('with torrents only there is no section header: the first card is the recommended release', async t => {
  const h = setup(t);
  h.parser[0].done({Results: [{Title: 'Series S01 1080p', Link: 'magnet:a', Tracker: 'T', Seeders: 20, info: {voices: ['Torrent Voice']}}]}); h.tick(150);
  assert.equal(h.component.render()[0].querySelectorAll('.homelab-common-section').length, 0);
  assert.equal(h.focused(), h.rows()[0]); assert.equal(h.rows()[0].find('.homelab-common-pick').text(), 'Лучший выбор');
});

test('a source that named 4K but was measured at 720p shows the measured quality and the claim', async t => {
  const facts = {load: () => Promise.resolve({version: 1, providers: {}, rows: {'one|1|studio a': {height: 720, claimed: 2160, source: 'probe'}}}),
    fact: (data, provider, season, voice) => data.rows[[provider, season, voice.toLowerCase()].join('|')] || null, doubtful: () => false, report() {}};
  const h = setup(t, {facts});
  h.parser[0].done({Results: []});
  h.pages.set('a', episodePage('Studio A', {maxquality: '2160p'}));
  await h.finish('/lite/events', [{balanser: 'one', name: 'One', show: true, url: '/lite/one'}]); await h.finish('/lite/one', 'a'); h.tick(150);
  const row = h.rows()[0];
  assert.equal(row.find('.homelab-common-q').text(), '720p');
  assert.match(row.find('.homelab-common-q-note').children.map(node => node.text()).join(''), /проверено · заявлено 4K/);
});

test('the hero plays the top voice and says which episode it resumes; the list goes on below it', async t => {
  const h = await grouped(t, {watching: {card: 'tv_42', kind: 'online', online: {provider: 'three', voice: 'Studio B'}, season: 1, episode: 1, position: 700, duration: 1400}});
  const hero = h.component.render()[0].querySelectorAll('.homelab-common-herobox')[0].children[0];
  assert.equal(hero, h.rows()[0]); assert.equal(voice(hero), 'Studio B'); assert.equal(h.focused(), hero);
  assert.equal(hero.find('.homelab-common-pick').text(), 'Ваша озвучка · продолжить');
  assert.equal(hero.find('.homelab-common-what').text(), 'Серия 1 · с ' + h.L.Utils.secondsToTime(700));
  assert.equal(hero.find('.homelab-common-progress-fill').attrs['style:width'], '50%');
  assert.ok(!h.component.render()[0].querySelectorAll('.homelab-common-list')[0].contains(hero), 'the hero is not repeated in the list');
  assert.equal(voice(h.rows()[1]), 'Studio A');
});

test('chips filter by kind, 4K and subtitles and count what each would show', async t => {
  const h = await grouped(t);
  assert.equal(chipOf(h, 'Онлайн').children[1].text(), '2'); assert.ok(chipOf(h, 'Всё').classes.has('is-on'));
  h.fire(chipOf(h, 'Торренты'), 'hover:enter'); assert.equal(h.rows().length, 0); assert.ok(chipOf(h, 'Торренты').classes.has('is-on'));
  h.fire(chipOf(h, 'Всё'), 'hover:enter'); assert.equal(h.rows().length, 2);
  h.fire(chipOf(h, 'Субтитры'), 'hover:enter'); assert.equal(h.rows().length, 0); assert.ok(chipOf(h, 'Субтитры').classes.has('is-on'));
  h.fire(chipOf(h, 'Субтитры'), 'hover:enter'); h.fire(chipOf(h, '4K'), 'hover:enter');
  assert.ok(chipOf(h, '4K').classes.has('is-on')); assert.equal(h.rows().filter(row => row.find('.homelab-common-q').text() === '1080p').length, 0);
});

test('the episode strip marks watched episodes, searches the chosen one and slides at its edges', async t => {
  const h = setup(t, {movie: {seasons: [{season_number: 1, episode_count: 10}]}, watching: {card: 'tv_42', kind: 'online', online: {provider: 'one', voice: 'X'}, season: 1, episode: 3, position: 600, duration: 1200}});
  const eps = () => h.component.render()[0].querySelectorAll('.homelab-common-ep');
  assert.deepEqual(eps().map(node => node.text()), ['1', '2', '3', '4', '5', '6', '7']);
  assert.ok(eps()[0].classes.has('is-watched') && eps()[1].classes.has('is-watched') && !eps()[2].classes.has('is-watched'));
  assert.ok(eps()[2].classes.has('is-current')); assert.equal(eps()[2].find('.homelab-common-ep-bar').attrs['style:width'], '50%');
  assert.equal(h.metadata.length, 0, 'known seasons are not asked');
  const searches = h.parser.length;
  h.fire(eps()[4], 'hover:enter');
  assert.match(h.summary(), /^С1 · Е5/); assert.equal(h.parser.length, searches + 1, 'OK on an episode searches it');
  assert.deepEqual(eps().map(node => node.text()), ['2', '3', '4', '5', '6', '7', '8']);
  h.L.Controller.collectionFocus(eps()[6], h.component.render()); h.tick(1);
  assert.deepEqual(eps().map(node => node.text()), ['4', '5', '6', '7', '8', '9', '10'], 'the window slides at its edge');
  assert.equal(h.focused().text(), '8', 'focus stays on the episode');
});

test('without season metadata the strip asks it once and fills in the count', t => {
  const h = setup(t), eps = () => h.component.render()[0].querySelectorAll('.homelab-common-ep');
  assert.equal(h.metadata.length, 1); assert.equal(h.metadata[0].url, 'tv/42');
  assert.deepEqual(eps().map(node => node.text()), ['1', '2', '3', '4', '5', '6', '7']);
  h.metadata[0].done({id: 42, seasons: [{season_number: 1, episode_count: 4}]});
  assert.deepEqual(eps().map(node => node.text()), ['1', '2', '3', '4']);
  h.L.Controller.controllers.content.right(); assert.equal(h.metadata.length, 1, 'the parameters do not ask again');
});

test('checked voices lead; unchecked ones follow in an open, foldable section', async t => {
  const rows = {'one|1|studio a': {height: 1080, source: 'probe'}, 'two|1|studio b': {height: 1080, source: 'probe'}, 'three|1|studio c': {height: 720, source: 'probe'}};
  const facts = {load: () => Promise.resolve({version: 1, providers: {}, rows}), fact: (data, provider, season, name) => data.rows[[provider, season, name.toLowerCase()].join('|')] || null, doubtful: () => false, report() {}};
  const h = setup(t, {facts});
  h.parser[0].done({Results: []});
  await h.finish('/lite/events', [...twoProviders, {balanser: 'four', name: 'Four', show: true, url: '/lite/four'}]);
  ['a', 'b', 'c', 'd'].forEach(id => h.pages.set(id, episodePage('Studio ' + id.toUpperCase(), {method: 'play', quality: {'720p': '/media'}})));
  await h.finish('/lite/one', 'a'); await h.finish('/lite/two', 'b'); await h.finish('/lite/three', 'c'); await h.finish('/lite/four', 'd'); h.tick(1100);
  assert.ok(h.rows().map(voice).includes('Studio D'), 'unchecked voices are shown');
  const label = h.component.render()[0].querySelectorAll('.homelab-common-label')[0];
  assert.equal(label.text(), 'Проверенные · 2 озвучки');
  const fold = h.component.render()[0].querySelectorAll('.homelab-common-section').find(node => /качество не проверено/.test(node.text()));
  assert.equal(fold.text(), '▾ Ещё 1 озвучка · качество не проверено');
  h.fire(fold, 'hover:enter'); assert.ok(!h.rows().map(voice).includes('Studio D'), 'Enter folds them');
});

test('the accent comes from the most colourful hue of the art; grey art keeps the screen neutral', t => {
  const h = setup(t), accent = h.window.HomelabSources.accent, pixels = list => Uint8ClampedArray.from(list.flatMap(rgb => [...rgb, 255]));
  const red = accent(pixels([[200, 30, 40], [190, 20, 30], [40, 40, 40], [20, 120, 30]]));
  assert.ok(red[0] > red[1] && red[0] > red[2], 'red wins over the lone green pixel');
  assert.equal(accent(pixels([[40, 40, 40], [120, 120, 120], [250, 250, 250]])), null);
});

test('OK on an episode keeps focus on it while searching; season metadata keeps focus on the season button', t => {
  const h = setup(t), eps = () => h.component.render()[0].querySelectorAll('.homelab-common-ep');
  h.L.Controller.collectionFocus(eps()[2], h.component.render()); h.fire(eps()[2], 'hover:enter');
  assert.match(h.summary(), /^С1 · Е3/); assert.equal(h.focused().text(), '3', 'focus stays on the chosen episode');
  h.parser.at(-1).done({Results: [{Title: 'Series S01 720p', Link: 'magnet:a', Tracker: 'T'}]}); h.tick(150);
  assert.equal(h.focused(), h.rows()[0], 'its results bring the focus to the hero');
  const season = () => h.component.render()[0].querySelectorAll('.homelab-common-season')[0];
  h.L.Controller.collectionFocus(season(), h.component.render()); h.fire(season(), 'hover:hover');
  h.metadata[0].done({id: 42, seasons: [{season_number: 1, episode_count: 12}]});
  assert.equal(h.focused(), season(), 'the redrawn season button takes the focus');
  h.parser.at(-1).done({Results: [{Title: 'Series S01 1080p', Link: 'magnet:b', Tracker: 'T'}]}); h.tick(150);
  assert.equal(h.focused(), season(), 'once the user moved, results do not pull focus away');
});

test('the 4K chip turned off returns to the quality chosen in the parameters', async t => {
  const h = await grouped(t, {quality: 1080});
  h.fire(chipOf(h, '4K'), 'hover:enter'); h.fire(chipOf(h, '4K'), 'hover:enter');
  assert.match(h.summary(), /1080p/);
});

test('a click outside the parameters closes them; inside it does not', t => {
  const h = setup(t), c = h.L.Controller.controllers, root = h.component.render()[0];
  c.content.right(); assert.equal(h.L.Controller.enabled().name, 'homelab_common_settings');
  const panel = root.querySelectorAll('.homelab-common-settings')[0];
  h.fire(Object.assign(root, {}), 'click'); // target is the screen itself
  assert.equal(h.L.Controller.enabled().name, 'content');
  c.content.right(); for (const callback of root.events.click) callback.call(root, {target: panel});
  assert.equal(h.L.Controller.enabled().name, 'homelab_common_settings');
});

test('the click on the parameters chip that opens the panel does not close it again', t => {
  const h = setup(t), root = h.component.render()[0];
  const chip = root.querySelectorAll('.homelab-common-summary')[0];
  h.fire(chip, 'hover:enter'); for (const callback of root.events.click) callback.call(root, {target: chip});
  assert.equal(h.L.Controller.enabled().name, 'homelab_common_settings');
});
