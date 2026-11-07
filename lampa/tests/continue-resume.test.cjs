const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, flush} = require('./ux-harness.cjs');

const saved = {card:'tv_42',title:'Saved series',original:'Saved original',torrent:'a'.repeat(40),index:1,timeline:'123',season:1,episode:2,position:20,duration:120,observed:1};

test('captured Specials restore season zero omitted by the API without inventing a season for legacy items', async t => {
  const h = harness(t), item = {...saved, kind: 'online', online: {provider: 'one', voice: 'Preferred'}};
  delete item.season;
  h.run('mods/HomelabSync/continue.js'); h.window.homelabContinue.load();
  h.calls[0].finish({version: 1, items: [item, {card: 'tv_43', title: 'Legacy', episode: 1, position: 20, duration: 120, observed: 1}]}); await flush();
  const items = h.window.homelabContinue.list();
  assert.equal(items.find(value => value.card === 'tv_42').season, 0);
  assert.equal(items.find(value => value.card === 'tv_43').season, undefined);
  assert.equal(item.season, undefined, 'wire record remains untouched');
});

test('native legacy rows preserve an explicit zero season and never infer it from absent or invalid metadata', async t => {
  const h = harness(t), values = [undefined, null, '', false, 0];
  h.syncRows(values.map((season, i) => ({hash: 'legacy-' + i, watched_at: 1, position: 30, duration: 120,
    extra: JSON.stringify({card: 'tv_' + (42 + i), episode: 3, season})})));
  h.run('mods/HomelabSync/continue.js'); h.window.homelabContinue.load();
  h.calls[0].finish({version: 1, items: []}); await flush();
  const items = h.window.homelabContinue.list();
  values.forEach((value, i) => assert.equal(items.find(item => item.card === 'tv_' + (42 + i)).season, value === 0 ? 0 : undefined));
});

test('online continuation restores native anime keywords, external IDs and canonical metadata', t => {
  const h=harness(t); let launched, requested;
  h.window.HomelabOnlineResume={cancel(){},resume(item,movie){launched=movie;return true}};
  h.L.Api.sources.tmdb.get=(path,params,done)=>{requested=path;done({id:42,name:'Canonical series',original_name:'Canonical original',first_air_date:'2026-01-01',number_of_seasons:3,
    keywords:{results:[{name:'anime'}]},external_ids:{imdb_id:'tt42',kinopoisk_id:123}})};
  h.run('mods/HomelabSync/continue.js');
  h.window.homelabContinue.resume({...saved,kind:'online',online:{provider:'kodik',voice:'Preferred'},date:'2000-01-01'});
  assert.match(requested,/^tv\/42\?append_to_response=external_ids,keywords$/);
  assert.equal(launched.name,'Canonical series'); assert.equal(launched.original_title,'Canonical original');
  assert.equal(launched.first_air_date,'2026-01-01'); assert.equal(launched.number_of_seasons,3);
  assert.equal(launched.keywords.results[0].name,'anime'); assert.equal(launched.imdb_id,'tt42'); assert.equal(launched.kinopoisk_id,123);
});

test('fresh movie title and release date win over stale saved placeholders', t => {
  const h=harness(t); let launched;
  h.window.HomelabOnlineResume={cancel(){},resume(item,movie){launched=movie;return true}};
  h.L.Api.sources.tmdb.get=(p,q,done)=>done({id:42,title:'Canonical movie',original_title:'Canonical original',release_date:'2025-01-01',imdb_id:'tt42'});
  h.run('mods/HomelabSync/continue.js');
  h.window.homelabContinue.resume({...saved,card:'movie_42',kind:'online',title:'Фильм #42',date:'2020-01-01',online:{provider:'one',voice:'Preferred'}});
  assert.equal(launched.title,'Canonical movie'); assert.equal(launched.release_date,'2025-01-01');
});

test('TV continuation survives native Explorer defaults with and without fresh metadata', t => {
  const h=harness(t), seen=[]; let metadata;
  h.window.HomelabOnlineResume={cancel(){},resume(item,movie){
    // Native Explorer.movie fills a missing title before Lampac requestParams prefers title over name.
    if (movie.title === undefined) movie.title='Фильм не найден';
    seen.push(movie); return true;
  }};
  h.L.Api.sources.tmdb.get=(p,q,done)=>{metadata=done};
  h.run('mods/HomelabSync/continue.js');
  h.window.homelabContinue.resume({...saved,kind:'online',online:{provider:'kodik',voice:'Preferred'}});
  metadata({id:42,name:'Canonical series',original_name:'Canonical original',number_of_seasons:1});
  assert.equal(seen[0].title,'Canonical series'); assert.equal(seen[0].name,'Canonical series');
  h.window.homelabContinue.resume({...saved,kind:'online',online:{provider:'kodik',voice:'Preferred'}}); h.tick(5000);
  assert.equal(seen[1].title,'Saved series'); assert.equal(seen[1].name,'Saved series');
});

test('staggered metadata and updated progress preserve native card DOM and focused selection', async t => {
  const h=harness(t), callbacks=[]; let row;
  h.L.Api.sources.tmdb.get=(path,params,done)=>callbacks.push({path,done});
  const make=h.L.Maker.make;
  h.L.Maker.make=(name,data,mask)=>{const native=make(name,data,mask);native.data=data;native.emit=()=>{};return native};
  h.run('mods/HomelabSync/continue.js');
  h.rows[0].call()(data=>{row=data.params.createInstance();row.create()});
  h.calls[0].finish({version:1,items:[{...saved,title:undefined},{...saved,card:'tv_43',title:undefined}]}); await flush();
  let focused, focuses=0; const focus=h.L.Controller.collectionFocus;
  h.L.Controller.collectionFocus=(node,...args)=>{focused=node;focuses++;return focus(node,...args)};
  row.toggle(); h.L.Controller.controllers.homelab_resume.right();
  const initial=h.elements.filter(e=>e.classes.has('homelab-resume-card')&&!e.removed);
  const before=focuses;
  callbacks[0].done({id:42,name:'Canonical first',original_name:'Original first'});
  callbacks[1].done({id:43,name:'Canonical second',original_name:'Original second'});
  assert.ok(initial.every(tile=>!tile.removed),'metadata must not recreate the selected row');
  assert.equal(focused,initial[1]); assert.equal(focuses,before,'metadata must not refocus or scroll the selected card');
  assert.equal(initial[0].find('.card__title').text(),'Canonical first');
  assert.equal(initial[1].find('.card__title').text(),'Canonical second');
  h.tick(15001); h.window.homelabContinue.load();
  h.calls.at(-1).finish({version:1,items:[{...saved,title:'Updated first',episode:3,position:40,observed:2},{...saved,card:'tv_43',title:'Updated second',observed:2}]}); await flush();
  assert.ok(initial.every(tile=>!tile.removed),'new progress/episode must retain each native instance');
  initial[0].trigger('hover:enter');
  h.L.sourceLookup.success({file_stats:[{id:1,path:'Series.S01E03.mkv'}],data:{movie:{id:42,name:'Series',original_name:'Original series',number_of_seasons:1}}});
  assert.equal(h.work().episode,3); assert.equal(h.video().currentTime,40,'retained handlers use current item, not the initial snapshot');
});

test('torrent continuation stops after navigation during source lookup or optional metadata', t => {
  const h=harness(t); let active={component:'main'}, metadata;
  h.L.Activity={active:()=>active}; h.L.Api.sources.tmdb.get=(p,q,done)=>{metadata=done};
  h.run('mods/HomelabSync/continue.js'); h.window.homelabContinue.resume(saved);
  active={component:'full',movie:{id:99}};
  h.L.sourceLookup.success({file_stats:[{id:1,path:'Series.S01E02.mkv'}],data:{movie:{id:42,name:'Series',original_name:'Original series',number_of_seasons:1}}});
  assert.equal(h.work(),null); h.tick(8000); assert.equal(h.L.routed,undefined);
  active={component:'main'}; h.window.homelabContinue.resume(saved);
  h.L.sourceLookup.success({file_stats:[{id:1,path:'Series.S01E02.mkv'}]});
  active={component:'full',movie:{id:99}}; metadata({id:42,name:'Series',original_name:'Original series',number_of_seasons:1}); h.tick(2000);
  assert.equal(h.work(),null); assert.equal(h.L.routed,undefined);
});

test('retained cards restore the year node removed by native Release for an initially unknown date', async t => {
  const h=harness(t); let row;
  h.run('mods/HomelabSync/continue.js');
  h.rows[0].call()(data=>{row=data.params.createInstance();row.create()});
  h.calls[0].finish({version:1,items:[saved]}); await flush();
  const tile=h.elements.find(e=>e.classes.has('homelab-resume-card')), find=tile.find.bind(tile);
  let age;
  tile.find=selector=>selector==='.card__age' ? age || {length:0,remove(){}} : find(selector);
  const title=tile.find('.card__title'), after=title.after.bind(title);
  title.after=node=>{age=node;return after(node)};
  h.tick(15001); h.window.homelabContinue.load();
  h.calls.at(-1).finish({version:1,items:[{...saved,date:'2026-04-04',observed:2}]}); await flush();
  assert.equal(tile.removed,undefined); assert.equal(age.text(),'2026');
  h.tick(15001); h.window.homelabContinue.load();
  h.calls.at(-1).finish({version:1,items:[{...saved,observed:3}]}); await flush();
  assert.equal(age.removed,true,'an unknown year must not retain the previous date');
});
