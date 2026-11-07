const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');
const state = file => ({key: '/previews/' + 'a'.repeat(40) + '/' + file + '/', enabled: true,
  info: {duration: 120, step: 10, chapters: [{start: 0, end: 60, title: 'Scene'}, {start: 60, end: 120, title: 'Ending'}]}});

function setup(t) {
  const h = harness(t), L = h.L, stack = [], closed = [];
  let active = null;
  const jq = h.window.jQuery, body = jq('<body></body>');
  h.window.jQuery = value => value === 'body' ? body : jq(value);
  const toggles = [], toggle = L.Controller.toggle;
  L.Controller.listener = {follow(name, callback) { assert.equal(name, 'toggle'); toggles.push(callback); }};
  L.Controller.toggle = name => { toggle(name); toggles.slice().forEach(callback => callback({name})); };
  // Native Modal contracts: open pushes the old frame; close emits before
  // popping it; Controller.windowClose restores a modal below via its toggle.
  // frontend-1992839.js:37667,37819,37888 and53398.
  function register() {
    L.Controller.add('modal', {
      toggle() { L.Modal.listener.send('toggle', {active: active.params}); },
      back() { active.params.onBack?.(); },
    });
  }
  L.Modal.opened = () => !!active;
  L.Modal.render = () => ({0: {contains: node => active?.params.html?.[0] === node}});
  L.Select.opened = () => !!h.select();
  L.Controller.windowTop = () => h.select() ? {name: 'select'} : active ? {name: 'modal'} : false;
  L.Modal.open = params => {
    if (active) stack.push(active);
    active = {params, below: L.Controller.enabled().name};
    L.Modal.listener.send('fullshow', {active: params});
    register(); L.Controller.toggle('modal');
  };
  L.Modal.close = () => {
    assert.ok(active, 'cannot close an absent frame');
    const frame = active;
    closed.push(frame.params);
    L.Modal.listener.send('close', {active: frame.params});
    active = stack.pop() || null;
    if (active) register();
    if (active && frame.below === 'modal' && L.Controller.enabled().name === 'modal') L.Controller.toggle('modal');
  };
  L.Modal.update = html => { active.params.html = html; L.Controller.toggle('modal'); };
  h.run('plugins/chapter-gallery.js');
  h.start({homelab_torrent_hash: 'a'.repeat(40)});
  return {...h, closed, body, active: () => active?.params || null,
    open(file = 1) { h.coreState(state(file)); h.core.openChapters(); return active.params; }};
}

test('invalidated gallery under another modal closes only its own restored frame and preserves the older modal', t => {
  const h = setup(t), older = {title: 'Older'}, other = {title: 'Other'};
  h.L.Modal.open(older); const owned = h.open(); h.L.Modal.open(other);
  h.coreState(null);
  assert.equal(h.active(), other); assert.equal(h.closed.length, 0, 'the unrelated top frame remains untouched');
  h.L.Modal.close();
  assert.equal(h.active(), older);
  assert.deepEqual(h.closed, [other, owned]);
  assert.equal(h.L.Controller.enabled().name, 'modal');
  owned.onBack();
  assert.equal(h.active(), older, 'a stale callback cannot close the restored older frame');
});

test('profile invalidation under a selector waits until its owned modal resumes', t => {
  const h = setup(t), owned = h.open();
  h.L.Select.show({title: 'Edit'}); h.profile('another-profile');
  assert.equal(h.active(), owned); assert.equal(h.closed.length, 0);
  assert.equal(h.L.Controller.enabled().name, 'select');
  h.L.Select.closeAll(); h.L.Controller.toggle('modal');
  assert.equal(h.active(), null); assert.deepEqual(h.closed, [owned]);
  assert.equal(h.L.Controller.enabled().name, 'player');
});

test('closing playback beneath a nested modal returns to content without an orphan overlay', t => {
  const h = setup(t), owned = h.open(), other = {title: 'Other'};
  h.L.Modal.open(other); h.destroy(); h.coreState(null);
  assert.equal(h.active(), other);
  h.L.Modal.close();
  assert.equal(h.active(), null); assert.deepEqual(h.closed, [other, owned]);
  assert.equal(h.L.Controller.enabled().name, 'content');
});

test('retiring and later dismissing a gallery revokes images once and stops pending thumbnail work', async t => {
  const h = setup(t); h.open();
  h.calls[0].finish({type: 'image/jpeg', size: 100}); await flush();
  assert.equal(h.calls.length, 2);
  h.L.Modal.open({title: 'Other'}); h.coreState(null);
  assert.equal(h.calls[1].options.signal.aborted, true);
  assert.equal(h.calls[2].url, '/previews/cancel', 'the covered gallery releases its server job once');
  assert.equal(h.revoked.length, 1);
  h.calls[1].finish({type: 'image/jpeg', size: 100}); await flush();
  h.L.Modal.close(); h.tick(60000);
  assert.equal(h.revoked.length, 1); assert.equal(h.calls.length, 3); assert.equal(h.active(), null);
});

test('a new gallery above an unrelated modal does not confuse the retired gallery below it', t => {
  const h = setup(t), old = h.open(), other = {title: 'Other'};
  h.L.Modal.open(other); h.coreState(null);
  const next = h.open(2);
  next.onBack();
  assert.equal(h.active(), other); assert.deepEqual(h.closed, [next]);
  h.L.Modal.close();
  assert.equal(h.active(), null); assert.deepEqual(h.closed, [next, other, old]);
  assert.equal(h.L.Controller.enabled().name, 'player');
});

test('normal gallery navigation closes its own frame and keeps an older modal focused', t => {
  const h = setup(t), older = {title: 'Older'};
  h.L.Modal.open(older); const owned = h.open();
  h.elements.find(e => e.classes.has('homelab-chapter-tile')).trigger('hover:enter');
  assert.equal(h.selected(), 0); assert.equal(h.active(), older);
  assert.deepEqual(h.closed, [owned]); assert.equal(h.L.Controller.enabled().name, 'modal');
});

test('native no-toggle restoration dismisses its owned stale frame after the close finishes', t => {
  const h = setup(t), older = {title: 'Older'}, other = {title: 'Other'};
  h.L.Modal.open(older); const owned = h.open(); h.L.Modal.open(other);
  h.profile('another-profile'); h.L.Controller.toggle('content'); h.tick(0);
  assert.equal(h.active(), other); assert.equal(h.closed.length, 0, 'controller changes cannot dismiss the unrelated frame');
  h.L.Modal.close();
  assert.equal(h.active(), owned, 'native restores without emitting toggle when content owns the controller');
  h.tick(0);
  assert.equal(h.active(), older); assert.deepEqual(h.closed, [other, owned]);
  assert.equal(h.L.Controller.enabled().name, 'modal');
});

test('a restored owned frame can be dismissed explicitly while another component left controller on player', t => {
  const h = setup(t), older = {title: 'Older'};
  h.L.Modal.open(older); const owned = h.open(); h.L.Modal.open({title: 'Other'});
  h.coreState(null); h.L.Controller.toggle('player'); h.L.Modal.close();
  owned.onBack();
  assert.equal(h.active(), older); assert.equal(h.L.Controller.enabled().name, 'modal');
  h.tick(0); assert.equal(h.active(), older, 'the deferred sweep cannot close the unrelated restored frame');
});

test('a selector remains protected after a different component changes controller to content', t => {
  const h = setup(t), owned = h.open();
  h.L.Select.show({title: 'Edit'}); h.profile('another-profile'); h.L.Controller.toggle('content'); h.tick(0);
  assert.equal(h.active(), owned); assert.equal(h.closed.length, 0);
  assert.ok(h.select(), 'the unrelated selector remains open');
  h.L.Select.closeAll(); h.tick(0);
  assert.equal(h.active(), null); assert.deepEqual(h.closed, [owned]);
  assert.equal(h.L.Controller.enabled().name, 'player');
});

test('native keyboard input protects its underlying gallery even though it has no controller window entry', t => {
  const h = setup(t), owned = h.open();
  h.body.addClass('keyboard-input--visible'); h.L.Controller.toggle('keybord');
  h.profile('another-profile'); h.L.Controller.toggle('content'); h.tick(0);
  assert.equal(h.active(), owned); assert.equal(h.closed.length, 0);
  h.body.removeClass('keyboard-input--visible'); h.L.Controller.toggle('settings_component'); h.tick(0);
  assert.equal(h.active(), null); assert.deepEqual(h.closed, [owned]);
  assert.equal(h.L.Controller.enabled().name, 'player');
});
