const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {harness} = require('./ux-harness.cjs');

const moduleRoot = path.join(__dirname, '../mods/HomelabSync');
const bundle = ['plugin.js', 'history.js', 'continue.js'].map(name => fs.readFileSync(path.join(moduleRoot, name), 'utf8')).join('\n');

test('the real sync bundle waits for initialized native state and installs all three parts once', t => {
  const h = harness(t), listeners = new Map();
  let menuCalls = 0, componentCalls = 0, intervals = 0;
  delete h.window.HomelabSync;
  h.window.appready = false;
  h.window.homelabSyncConfig = {version: 1, url: 'https://test.invalid', uid: 'synthetic', token: ''};
  h.L.Listener = {
    follow(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    send(name, data) { for (const fn of [...(listeners.get(name) || [])]) fn(data); },
  };
  h.L.Account = {Permit: {}, Api: {watchHistory() {}, watchHistoryCard() {}}};
  h.L.Reguest = function () {};
  h.L.Storage.cache = (key, size, fallback) => h.L.Storage.get(key, fallback);
  h.L.Timeline.read = () => {};
  h.L.Timeline.listener = {follow() {}};
  h.L.Utils.cardImgBackground = () => {};
  h.L.Utils.secondsToTimeHuman = h.L.Utils.secondsToTime;
  h.L.Maker = {make() {}};
  h.L.Component = {add() { componentCalls++; }};
  h.L.Menu = {addButton() {
    assert.equal(h.window.appready, true, 'Menu methods exist before its internal HTML is initialized');
    menuCalls++;
    return h.window.$('<div></div>');
  }};
  h.L.Background = {change() {}};
  h.L.Activity = {own() {}, refresh() {}};
  h.L.Select.opened = () => false;
  const context = {window: h.window, Lampa: h.L, $: h.window.$, fetch: h.window.fetch,
    AbortController, console, Date, setTimeout, clearTimeout,
    setInterval() { intervals++; }, document: {hidden: false, addEventListener() {}}};
  const inject = () => vm.runInNewContext(bundle, context);

  inject(); inject();
  assert.equal(h.window.HomelabSync, undefined);
  assert.equal(h.window.homelabHistoryInstalled, undefined);
  assert.equal(h.window.homelabContinue, undefined);
  assert.equal(menuCalls + componentCalls + h.rows.length + intervals, 0);
  h.L.Listener.send('app', {type: 'start'});
  assert.equal(menuCalls, 0);

  h.window.appready = true;
  h.L.Listener.send('app', {type: 'ready'});
  assert.ok(h.window.HomelabSync);
  assert.ok(h.window.homelabHistoryInstalled);
  assert.ok(h.window.homelabContinue, 'an early history exception must not prevent continuation from installing');
  assert.equal(menuCalls, 1);
  assert.equal(componentCalls, 1);
  assert.equal(h.rows.length, 1);
  assert.equal(intervals, 1);

  h.L.Listener.send('app', {type: 'ready'}); inject();
  assert.equal(menuCalls, 1);
  assert.equal(componentCalls, 1);
  assert.equal(h.rows.length, 1);
  assert.equal(intervals, 1);
});
