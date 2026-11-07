const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');

function nativePosters(h) {
  const make = h.L.Maker.make, cards = [];
  h.L.Maker.make = (...args) => {
    const card = make(...args), image = card.render().find('.card__img');
    card.data = args[1]; card.errors = 0;
    Object.defineProperty(image, 'src', {get: () => image.attr('src'), set: value => image.attr('src', value)});
    card.getPosterPath = () => card.data.poster_path ? h.L.Api.img(card.data.poster_path) : './img/img_broken.svg';
    // Native Card's image contract (frontend1992839, Card$2): visible arms a
    // 15s timer; onload clears its current handle; errors retry every2s.
    image.onerror = () => {
      clearTimeout(card.timer);
      if (++card.errors > 3) image.src = './img/img_broken.svg';
      else card.retry = setTimeout(image.onerror, 2000);
    };
    card.emit = event => {
      if (event !== 'visible') return;
      card.timer = setTimeout(image.onerror, 15000);
      image.onload = () => { clearTimeout(card.timer); clearTimeout(card.retry); };
      image.src = card.getPosterPath();
    };
    const destroy = card.destroy;
    card.destroy = () => {
      clearTimeout(card.timer); clearTimeout(card.retry);
      image.onload = image.onerror = () => {}; image.src = ''; destroy();
    };
    cards.push(card); return card;
  };
  h.L.Layer.visible = () => cards.forEach(card => { if (!card.seen) { card.seen = true; card.emit('visible'); } });
  return cards;
}

async function setup(t) {
  const h = harness(t), cards = nativePosters(h); let metadata, row;
  h.L.Api.sources.tmdb.get = (path, params, done) => { metadata = done; };
  h.syncRows([{hash: '123', watched_at: 1, position: 30, duration: 120, extra: JSON.stringify({card: 'tv_42', season: 1, episode: 2})}]);
  h.run('mods/HomelabSync/continue.js');
  h.rows[0].call()(data => { row = data.params.createInstance(); row.create(); });
  h.calls[0].finish({version: 1, items: []}); await flush();
  return {...h, cards, row, metadata() { metadata({id: 42, name: 'Series', poster_path: '/poster.jpg'}); }};
}

test('poster enrichment keeps a successful native image and focus beyond the old15s deadline', async t => {
  const h = await setup(t), card = h.cards[0], tile = card.render(), image = tile.find('.card__img');
  let focusCalls = 0;
  h.L.Controller.collectionFocus = node => { focusCalls++; node.addClass('focus').trigger('hover:focus'); };
  h.row.toggle(); const before = focusCalls;
  h.tick(100); h.metadata(); image.onload(); h.tick(15000); h.tick(2000); h.tick(2000); h.tick(2000);
  assert.equal(image.src, '/image/poster.jpg');
  assert.equal(card.errors, 0); assert.equal(h.cards.length, 1);
  assert.equal(tile.hasClass('focus'), true); assert.equal(focusCalls, before);
});

test('enriched posters retain native image error handling and a getPosterPath fallback', async t => {
  const h = await setup(t), card = h.cards[0], image = card.render().find('.card__img');
  delete card.getPosterPath;
  const onerror = image.onerror; h.metadata();
  assert.equal(image.src, '/image/poster.jpg'); assert.equal(image.onerror, onerror);
  image.onerror(); h.tick(2000); h.tick(2000); h.tick(2000);
  assert.equal(card.errors, 4); assert.equal(image.src, './img/img_broken.svg');
});

test('destroyed native cards ignore late poster enrichment and image deadlines', async t => {
  const h = await setup(t), card = h.cards[0], image = card.render().find('.card__img');
  h.row.destroy(); h.metadata(); h.tick(30000);
  assert.equal(image.src, ''); assert.equal(card.errors, 0); assert.equal(card.render().removed, true);
});
