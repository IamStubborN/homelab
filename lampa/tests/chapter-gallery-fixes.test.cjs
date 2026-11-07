const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');
const key = '/previews/' + 'b'.repeat(40) + '/2/';
const chapters = [
  {start: 0, end: 90, title: 'OP'}, {start: 90, end: 400, title: 'Part A'}, {start: 400, end: 406, title: 'Eyecatch'},
  {start: 406, end: 1300, title: 'Part B'}, {start: 1300, end: 1390, title: 'ED'}, {start: 1390, end: 1440, title: 'Preview'},
];
const info = (list = chapters, duration = 1440) => ({key, enabled: true, info: {version: 1, duration, step: 10, chapters: list}});

// Native Lampa contracts mirrored from the deployed frontend: Modal.open/update
// register `select` as the focus target of every later modal toggle, update
// forgets the last focused element, Modal.toggle(undefined) re-registers with
// the last focused element, close does not change the controller, and mouse
// hover sends hover:hover rather than hover:focus.
function setup(t, options = {}) {
  const h = harness(t), L = h.L, stack = [], closed = [], focused = [], counts = {close: 0, next: 0, toggle: 0};
  let active = null, panelVisible = false;
  h.video().duration = 1440;
  const jq = h.window.jQuery, body = jq('<body></body>');
  h.window.jQuery = value => value === 'body' ? body : jq(value);
  function first(frame) { return frame.html.querySelectorAll('.selector').find(node => !node.classes.has('hide')); }
  function focus(frame, node) { node = node || first(frame); if (node) { focused.push(node); node.trigger('hover:focus'); } }
  function bind(frame, html) { frame.html = html; html.querySelectorAll('.selector').forEach(node => node.on('hover:focus', () => { frame.last = node; })); }
  function register(frame, need) {
    L.Controller.add('modal', {toggle() { focus(frame, need || frame.last); L.Modal.listener.send('toggle', {active: frame.params}); }, back() { frame.params.onBack?.(); }});
  }
  L.Modal.opened = () => !!active;
  L.Modal.render = () => ({0: {contains: node => !!active && active.html === node}});
  L.Select.opened = () => !!h.select();
  L.Controller.windowTop = () => h.select() ? {name: 'select'} : active ? {name: 'modal'} : false;
  L.Modal.open = params => {
    if (active) stack.push(active);
    active = {params, below: L.Controller.enabled().name, last: null};
    bind(active, params.html);
    L.Modal.listener.send('fullshow', {active: params});
    register(active, params.select); L.Controller.toggle('modal');
  };
  L.Modal.toggle = need => { register(active, need); L.Controller.toggle('modal'); };
  L.Modal.update = html => { active.last = null; bind(active, html); register(active, active.params.select); L.Controller.toggle('modal'); };
  L.Modal.close = () => {
    const frame = active; closed.push(frame.params);
    L.Modal.listener.send('close', {active: frame.params});
    active = stack.pop() || null;
    if (active) register(active);
    if (active && frame.below === 'modal' && L.Controller.enabled().name === 'modal') L.Controller.toggle('modal');
  };
  L.Player.close = () => { counts.close++; };
  L.Player.toggle = () => { counts.toggle++; L.Controller.toggle('player'); };
  L.PlayerPanel.visibleStatus = () => panelVisible;
  L.PlayerPanel.reveal = () => { panelVisible = true; };
  L.PlayerPanel.hide = () => { panelVisible = false; };
  if (options.playlist) L.PlayerPlaylist = {canNext: () => options.playlist.next, next() { counts.next++; }};
  L.Controller.add('player_panel', {}); L.Controller.add('player', {}); L.Controller.add('player_skip', {});
  const native = jq('<div class="player-skip selector hide"></div>');
  L.Player.render().append(native);
  h.run('plugins/chapter-gallery.js');
  h.start({homelab_torrent_hash: 'b'.repeat(40)});
  return {...h, native, closed, focused, counts, panelVisible: () => panelVisible, active: () => active?.params || null,
    controller: () => L.Controller.enabled().name,
    skip: () => h.elements.find(e => e.classes.has('homelab-skip')),
    tile: index => h.elements.filter(e => e.attrs['data-chapter'] === index).at(-1),
    node: name => h.elements.filter(e => e.attrs['data-focus'] === name).at(-1),
    choose(item) { const previous = h.select(); L.Select.closeAll(); L.Controller.toggle('modal'); previous.onSelect(item); },
    time(value) { h.video().currentTime = value; h.videoEvent('timeupdate', {current: value}); }};
}

test('a visible manual skip takes remote focus once per segment from the bare player controller', t => {
  const h = setup(t);
  h.coreState(info()); h.time(5);
  assert.equal(h.skip().hasClass('hide'), false);
  assert.equal(h.controller(), 'homelab_chapter_skip', 'OK must activate the visible skip, not play/pause');
  h.L.Controller.controllers.homelab_chapter_skip.left();
  assert.equal(h.counts.toggle, 1, 'left/right leave like native Player.toggle');
  h.time(6); assert.equal(h.controller(), 'player', 'leaving the button is not undone by the next timeupdate');
  h.L.Controller.toggle('player_panel'); h.time(1310);
  assert.equal(h.controller(), 'player_panel', 'an open panel keeps its focus');
});

test('the manual skip never stacks over a visible native skip and hands focus to it', t => {
  const h = setup(t);
  h.coreState(info()); h.time(5);
  assert.equal(h.controller(), 'homelab_chapter_skip');
  h.native.removeClass('hide'); h.time(6);
  assert.equal(h.skip().hasClass('hide'), true);
  assert.equal(h.controller(), 'player_skip');
  h.native.addClass('hide').addClass('player-skip--preview').removeClass('hide'); h.L.Controller.toggle('player'); h.time(7);
  assert.equal(h.skip().hasClass('hide'), true, 'a native preview occupies the same corner');
  assert.equal(h.controller(), 'player');
});

test('remote Back and Up on the manual skip match native skip', t => {
  const h = setup(t);
  h.coreState(info()); h.time(5);
  const skip = h.L.Controller.controllers.homelab_chapter_skip;
  skip.up(); assert.equal(h.panelVisible(), true);
  skip.up(); assert.equal(h.panelVisible(), false);
  skip.back(); assert.equal(h.counts.close, 1);
});

test('skipping marks the segment so an imprecise seek cannot show the same button again', t => {
  const h = setup(t);
  h.coreState(info()); h.time(5);
  h.L.Controller.controllers.homelab_chapter_skip.enter();
  assert.equal(h.selected(), 90); assert.equal(h.controller(), 'player');
  h.time(89.6); assert.equal(h.skip().hasClass('hide'), true);
  h.time(2); h.time(3); assert.equal(h.skip().hasClass('hide'), false, 'rewinding before the segment offers it again');
});

const tail = [{start: 0, end: 1300, title: 'Story'}, {start: 1300, end: 1440, title: 'Ending'}];
test('a tail outro moves to the next episode when one exists', t => {
  const h = setup(t, {playlist: {next: true}});
  h.coreState(info(tail)); h.time(1350); h.skip().trigger('hover:enter');
  assert.equal(h.counts.next, 1); assert.equal(h.selected(), undefined);
});

test('a tail outro without a next episode uses the native end position', t => {
  const h = setup(t, {playlist: {next: false}});
  h.coreState(info(tail)); h.time(1350); h.skip().trigger('hover:enter');
  assert.equal(h.selected(), -1, 'native PlayerVideo.to(-1) stops three seconds before the end');
});

test('an ending followed by a preview seeks to the preview', t => {
  const h = setup(t);
  h.coreState(info()); h.time(1310); h.skip().trigger('hover:enter');
  assert.equal(h.selected(), 1390);
});

test('long movie chapters called Opening are story, short ones are intros', t => {
  const h = setup(t);
  h.coreState(info([{start: 0, end: 600, title: 'Opening Credits'}, {start: 600, end: 1440, title: 'Story'}])); h.time(5);
  assert.equal(h.skip().hasClass('hide'), true);
  h.coreState(info([{start: 0, end: 95, title: 'Opening'}, {start: 95, end: 1440, title: 'Story'}])); h.time(6);
  assert.equal(h.skip().hasClass('hide'), false);
});

test('gallery returns to the panel it was opened from and keeps focus on the edited control', t => {
  const h = setup(t);
  h.coreState(info()); h.time(500);
  h.L.Controller.toggle('player_panel'); h.core.openChapters();
  assert.equal(h.focused.at(-1), h.tile(3), 'first open focuses the playing chapter');
  const edit = h.node('edit:4'); edit.trigger('hover:focus'); edit.trigger('hover:enter');
  h.choose(h.select().items.find(item => item.type));
  assert.equal(h.focused.at(-1).attrs['data-focus'], 'edit:4', 'returning from the selector keeps the edited control');
  h.choose(h.select().items.find(item => item.save));
  assert.equal(h.focused.at(-1).attrs['data-focus'], 'edit:4', 'redraw after save keeps the edited control');
  h.L.Controller.controllers.modal.back();
  assert.equal(h.active(), null);
  assert.equal(h.controller(), 'player_panel');
  assert.equal(h.panelVisible(), true);
});

test('mouse and touch hover load thumbnails without keyboard focus', async t => {
  const h = setup(t);
  h.coreState(info()); h.time(5); h.core.openChapters();
  for (let i = 0; i < 2; i++) { h.calls.at(-1).finish({type: 'image/jpeg', size: 100}); await flush(); }
  const before = h.calls.length;
  h.tile(4).trigger('hover:hover');
  assert.equal(h.calls.length, before + 1);
  h.calls.at(-1).finish({type: 'image/jpeg', size: 100}); await flush();
  h.tile(5).trigger('hover:touch');
  assert.equal(h.calls.length, before + 2);
});

test('busy preview service responses retry with backoff instead of dropping the tile', async t => {
  const h = setup(t);
  h.coreState(info()); h.time(5); h.core.openChapters();
  const url = h.calls[0].url;
  h.calls[0].finish(null, 503); await flush();
  assert.equal(h.calls.length, 1, 'no immediate hammering');
  h.tick(1000); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].url, url);
  h.calls[1].finish(null, 429); await flush();
  h.tick(1999); assert.equal(h.calls.length, 2); h.tick(1); assert.equal(h.calls.length, 3);
  h.calls[2].finish({type: 'image/jpeg', size: 100}); await flush();
  assert.equal(h.tile(0).find('img').attrs.src.startsWith('blob:'), true);
});

test('frames are sampled inside each chapter, away from its boundary, with a nearest-slot fallback', async t => {
  const h = setup(t);
  h.coreState(info([{start: 0, end: 90, title: 'OP'}, {start: 92, end: 98, title: 'Bumper'}, {start: 98, end: 1440, title: 'Story'}])); h.time(5);
  h.core.openChapters();
  assert.equal(h.calls[0].url, key + 'frame/2.jpg?step=10', 'a chapter at zero avoids the black first frame');
  h.calls[0].finish({type: 'image/jpeg', size: 100}); await flush();
  assert.equal(h.calls[1].url, key + 'frame/10.jpg?step=10', 'a short chapter without a grid point uses the nearest slot');
  h.calls[1].finish({type: 'image/jpeg', size: 100}); await flush();
  h.tile(2).trigger('hover:focus');
  assert.equal(h.calls[2].url, key + 'frame/11.jpg?step=10');
});

test('thumbnail cache evicts the least recently shown tile', async t => {
  const list = Array.from({length: 14}, (_, i) => ({start: i * 100, end: i * 100 + 100, title: 'Part ' + (i + 1)}));
  const h = setup(t);
  h.coreState(info(list, 1400)); h.time(5); h.core.openChapters();
  for (let i = 0; i < 2; i++) { h.calls.at(-1).finish({type: 'image/jpeg', size: 100}); await flush(); }
  for (let i = 2; i < 12; i++) { h.tile(i).trigger('hover:focus'); h.calls.at(-1).finish({type: 'image/jpeg', size: 100}); await flush(); }
  const zero = h.tile(0).find('img').attrs.src, one = h.tile(1).find('img').attrs.src;
  h.tile(0).trigger('hover:focus');
  h.tile(12).trigger('hover:focus'); h.calls.at(-1).finish({type: 'image/jpeg', size: 100}); await flush();
  assert.deepEqual(h.revoked, [one]);
  assert.equal(h.tile(0).find('img').attrs.src, zero);
});
