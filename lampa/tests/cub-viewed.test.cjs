const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./ux-harness.cjs');

// Public WorkerArray and Socket.send methods from native frontend 1992839.
function nativeRuntime(h, wire, queued) {
  const Account = {hasPremium: () => true}, Arrays = {remove(list, value) { const at = list.indexOf(value); if (at >= 0) list.splice(at, 1); }};
  const Platform = {get: () => 'test'}, navigator = {userAgent: 'test'}, Utils$1 = {capitalizeFirstLetter: value => value};
  const _uid = 'test', Storage = h.L.Storage, expects = queued, Markers = {pass() {}}, listener$h = {send() {}};
  const socket = {readyState: 1, send(value) { wire.push(JSON.parse(value)); }};
  const console = {log() {}};
  const Socket = h.L.Socket = {send: function send$2(method, data) {
    var name_devise = Platform.get() ? Platform.get() : navigator.userAgent.toLowerCase().indexOf('mobile') > -1 ? 'mobile' : navigator.userAgent.toLowerCase().indexOf('x11') > -1 ? 'chrome' : 'other';
    listener$h.send('send', {
      method: method,
      data: data
    });
    data.device_id = _uid;
    data.name = Utils$1.capitalizeFirstLetter(name_devise) + ' - ' + Storage.field('device_name');
    data.method = method;
    data.version = 2;
    data.account = Storage.get('account', '{}');
    data.premium = Account.hasPremium();
    data.terminal = Storage.get('terminal_access', '');
    if (socket && socket.readyState == 1) socket.send(JSON.stringify(data));else expects.push(data);
    Markers.pass('socket');
  }};
  const worker = {data: [], field: 'online_view', send_timers: {}, send_rate: {reset: 0, count: 0},
    send: function send(id, value) {
        var _this3 = this;

        if (!Account.hasPremium()) return;
        clearTimeout(this.send_timers[id]);
        this.send_timers[id] = setTimeout(function () {
          delete _this3.send_timers[id];
          var now = Date.now();

          if (now > _this3.send_rate.reset) {
            _this3.send_rate.count = 0;
            _this3.send_rate.reset = now + 2000;
          }

          if (_this3.send_rate.count >= 5) {
            console.log('StorageWorker', 'rate limit:', _this3.field, id);
            return;
          }

          _this3.send_rate.count++;
          console.log('StorageWorker', 'save:', _this3.field, id, value);
          var str = JSON.stringify(value);

          if (str.length < 10000) {
            Socket.send('storage', {
              params: {
                id: id,
                name: _this3.field,
                value: value
              }
            });
          }
        }, 2000);
      },
    save: function save(value) {
        var _this4 = this;

        var uniq = value.filter(function (a) {
          return _this4.data.indexOf(a) == -1;
        });
        uniq.forEach(function (val) {
          _this4.data.push(val);

          _this4.send(null, val);
        });
      },
    remove: function remove(value) {
        Arrays.remove(this.data, value);
        this.sendRemove(null, value);
      },
    sendRemove: function sendRemove(id, value) {
        var str = JSON.stringify(value);
        console.log('StorageWorker', 'remove:', this.field, id, value);

        if (str.length < 10000) {
          Socket.send('storage', {
            params: {
              id: id,
              name: this.field,
              value: value,
              remove: true
            }
          });
        }
      },
    sendClean: function sendClean() {
        Socket.send('storage', {
          params: {
            id: null,
            name: this.field,
            value: '',
            clean: true
          }
        });
      }
  };
  const closedSend = Socket.send;
  return {worker, disconnect() { socket.readyState = 0; }, reconnect() { socket.readyState = 1; while (queued.length) { const message = queued.shift(); closedSend(message.method, message); } }};
}

function setup(t, install = true) {
  const h = harness(t), wire = [], queued = [];
  const write = h.L.Storage.set;
  h.L.Storage.set = function (name, value, silent) { if (silent) h.storage.set(name, value); else return write.call(this, name, value); };
  h.L.Storage.set('account', {token: 'account-A', profile: {id: 1}});
  h.L.Account = {Permit: {sync: true}};
  const native = nativeRuntime(h, wire, queued);
  h.L.Storage.listener.follow('change', event => { if (event.name === 'online_view') native.worker.save(event.value); });
  if (install) h.run('mods/HomelabSync/plugin.js');
  return {...h, ...native, wire, queued,
    set(value) { h.L.Storage.set('online_view', value); },
    unmark(value) { h.L.Storage.set('online_view', h.L.Storage.get('online_view', []).filter(item => item !== value)); native.worker.remove(value); },
    clean() { h.L.Storage.set('online_view', []); native.worker.data = []; native.worker.sendClean(); },
    account(token, profile) { h.L.Storage.set('account', token ? {token, profile: {id: profile}} : {}); },
    send(value, params = {}) { return h.L.Socket.send('storage', {params: {name: 'online_view', id: null, value, ...params}}); },
  };
}

for (const season of [0, 1]) test(`explicit rapid unmark blocks native delayed S${season} resurrection`, t => {
  const h = setup(t), value = 'S' + season; h.set([value]); h.unmark(value); h.tick(2001);
  assert.deepEqual(h.wire.map(message => message.params.remove), [true]);
});
test('a local re-mark allows the latest native addition', t => {
  const h = setup(t); h.set(['E']); h.unmark('E'); h.set(['E']); h.tick(2001);
  assert.equal(h.wire.at(-1).params.remove, undefined); assert.equal(h.wire.at(-1).params.value, 'E');
});
test('explicit clean blocks known pre-clean additions but unknown writes pass', t => {
  const h = setup(t); h.set(['E']); h.clean(); h.tick(2001); h.send('unknown');
  assert.equal(h.wire.length, 2); assert.equal(h.wire[0].params.clean, true); assert.equal(h.wire[1].params.value, 'unknown');
});
test('cache eviction is not a deletion intent', t => {
  const h = setup(t); h.set(['E']); h.set([]); h.tick(2001); assert.equal(h.wire.at(-1).params.remove, undefined);
});
test('silent remote insertion permits a currently present marked value', t => {
  const h = setup(t); h.set(['E']); h.unmark('E'); h.L.Storage.set('online_view', ['E'], true); h.tick(2001);
  assert.equal(h.wire.at(-1).params.remove, undefined);
});
for (const change of ['profile', 'account', 'logout']) test(`known pending origin cannot write after ${change} switch`, t => {
  const h = setup(t); h.set(['E']); h.account(change === 'logout' ? '' : change === 'account' ? 'account-B' : 'account-A', 2); h.tick(2001);
  assert.equal(h.wire.length, 0);
});
test('scope switch does not reuse old deletion tombstones or delete unknown writes', t => {
  const h = setup(t); h.unmark('E'); h.account('account-A', 2); h.send('E');
  assert.equal(h.wire.at(-1).account.profile.id, 2); assert.equal(h.wire.at(-1).params.remove, undefined);
});
test('unrelated storage payloads retain native behavior', t => {
  const h = setup(t); h.unmark('E'); h.send('E', {name: 'other'}); h.send('E', {id: 'object-key'}); h.send({nested: 'E'});
  assert.equal(h.wire.length, 4); assert.equal(h.wire[1].params.name, 'other'); assert.equal(h.wire[2].params.id, 'object-key');
});
test('same-scope offline native replay preserves add/remove order', t => {
  const h = setup(t); h.disconnect(); h.set(['E']); h.tick(2001); h.unmark('E'); h.reconnect();
  assert.deepEqual(h.wire.map(message => !!message.params.remove), [false, true]);
});
test('negative control: already queued native writes still reattach the new profile on private retry', t => {
  const h = setup(t); h.disconnect(); h.set(['E']); h.tick(2001); h.account('account-A', 2); h.reconnect();
  assert.equal(h.wire.at(-1).account.profile.id, 2);
});
test('installation is idempotent and does not require the history core to initialize again', t => {
  const h = setup(t), send = h.L.Socket.send; h.run('mods/HomelabSync/plugin.js'); assert.equal(h.L.Socket.send, send);
});
test('missing public Socket API leaves native installation untouched', t => {
  const h = setup(t, false); delete h.L.Socket; h.run('mods/HomelabSync/plugin.js'); assert.equal(h.window.homelabCubViewedGuard, undefined);
});
test('bounded origin history eviction does not become a remote remove', t => {
  const h = setup(t); h.set(Array.from({length: 5100}, (_, index) => 'E' + index)); h.account('account-A', 2); h.send('E0');
  assert.equal(h.wire.at(-1).params.remove, undefined); assert.equal(h.wire.at(-1).params.value, 'E0');
});
test('wrapper preserves receiver, arguments, return values and throws', t => {
  const h = setup(t, false), calls = [], receiver = {}, marker = new Error('native');
  h.L.Socket.send = function (...args) { calls.push({receiver: this, args}); if (args[0] === 'throw') throw marker; return 42; };
  h.run('mods/HomelabSync/plugin.js'); const payload = {params: {name: 'other'}};
  assert.equal(h.L.Socket.send.call(receiver, 'storage', payload, 'extra'), 42); assert.equal(calls[0].receiver, receiver);
  assert.equal(calls[0].args[1], payload); assert.equal(calls[0].args[2], 'extra'); assert.throws(() => h.L.Socket.send('throw', {}), error => error === marker);
});

test('explicit clean permits a subsequent local re-mark', t => {
  const h = setup(t); h.set(['E']); h.clean(); h.set(['E']); h.tick(2001);
  assert.equal(h.wire.at(-1).params.value, 'E'); assert.equal(h.wire.at(-1).params.remove, undefined);
});
test('viewed guard waits for native app ready and installs once', t => {
  const h = setup(t, false), ready = [], original = h.L.Socket.send;
  h.L.Listener = {follow(name, callback) { assert.equal(name, 'app'); ready.push(callback); }};
  h.window.appready = false; h.run('mods/HomelabSync/plugin.js'); assert.equal(h.L.Socket.send, original);
  h.window.appready = true; ready.forEach(callback => callback({type: 'ready'}));
  const wrapped = h.L.Socket.send; assert.notEqual(wrapped, original);
  ready.forEach(callback => callback({type: 'ready'})); assert.equal(h.L.Socket.send, wrapped);
});
test('bounded explicit removal metadata forgets oldest intent without emitting another delete', t => {
  const h = setup(t);
  for (let index = 0; index < 5100; index++) h.send('E' + index, {remove: true});
  const before = h.wire.length; h.send('E0'); h.send('E5099');
  assert.equal(h.wire.length, before + 1); assert.equal(h.wire.at(-1).params.value, 'E0'); assert.equal(h.wire.at(-1).params.remove, undefined);
});
