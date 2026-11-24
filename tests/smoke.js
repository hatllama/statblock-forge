/* Browser smoke test, without a browser: runs every script index.html ships, in its order, in one vm context with a
   small stand-in page, then drives a few real flows. No dependencies. Called from tests/run.js (`npm test`), or alone:
     node tests/smoke.js
   What it is: the elements index.html declares (id, tag, value, checked), event listeners that can be fired, timers
   that can be drained, localStorage, and a "chameleon" object that absorbs everything else (canvas contexts, SVG nodes,
   query results). What it is not: a layout or rendering engine. HTML written to innerHTML is kept as text and not
   parsed, so clicks on rendered buttons and anything that walks the rendered DOM are not covered. It catches a script
   that throws while loading (forge.js once did, for several commits), a missing global, and a crash in the start-up
   render, the importer, the day export, a War Table fight, an odds run, the settings selects and a workspace reload. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');

/* absorbs any use: callable, constructible, every property is another one; reads as '' / 0 / an empty list */
const chameleon = new Proxy(function () {}, {
  get(t, p) {
    if (p === Symbol.toPrimitive) return () => '';
    if (p === Symbol.iterator) return function* () {};
    if (p === 'then') return undefined;
    if (p === 'length') return 0;
    if (p === 'toString' || p === 'valueOf') return () => '';
    return chameleon;
  },
  set() { return true; }, apply() { return chameleon; }, construct() { return chameleon; }, has() { return true; },
});

function makePage(html, saved) {
  const errors = [];
  const els = new Map();
  const mkEl = (tag, id) => {
    const lst = {}, classes = new Set();
    const el = {
      id: id || '', tagName: String(tag || 'div').toUpperCase(), type: '', value: '', checked: false, disabled: false, hidden: false,
      innerHTML: '', textContent: '', className: '', style: {}, dataset: {}, children: [],
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; } },
      addEventListener(type, fn) { (lst[type] = lst[type] || []).push(fn); },
      removeEventListener(type, fn) { lst[type] = (lst[type] || []).filter(f => f !== fn); },
      /* what the test calls: run the listeners and the on<type> handler, as a browser would for an event on this element */
      fire(type, ev) {
        const e = Object.assign({ type, target: proxy, currentTarget: proxy, preventDefault() {}, stopPropagation() {} }, ev || {});
        const out = [];
        if (typeof el['on' + type] === 'function') out.push(el['on' + type](e));
        for (const fn of (lst[type] || []).slice()) out.push(fn(e));
        return Promise.all(out);
      },
      click() { return el.fire('click'); },
      querySelector() { return chameleon; }, querySelectorAll() { return []; }, closest() { return null; }, contains() { return false; },
      getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, appendChild(c) { return c; }, insertBefore(c) { return c; }, remove() {},
      focus() {}, blur() {}, select() {}, scrollIntoView() {}, getBoundingClientRect() { return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
    };
    const proxy = new Proxy(el, { get(t, p) { return p in t ? t[p] : (typeof p === 'symbol' ? undefined : chameleon); }, set(t, p, v) { t[p] = v; return true; } });
    return proxy;
  };
  // the elements index.html declares
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g; let m;
  while ((m = tagRe.exec(html))) {
    const id = /\bid="([^"]+)"/.exec(m[2]); if (!id) continue;
    const el = mkEl(m[1], id[1]);
    const type = /\btype="([^"]+)"/.exec(m[2]), val = /\bvalue="([^"]*)"/.exec(m[2]);
    if (type) el.type = type[1];
    if (val) el.value = val[1];
    if (/\bchecked\b/.test(m[2])) el.checked = true;
    if (el.tagName === 'SELECT') {
      const inner = html.slice(m.index, html.indexOf('</select>', m.index));
      const opts = [...inner.matchAll(/<option\b([^>]*)>([^<]*)/g)].map(o => ({ sel: /\bselected\b/.test(o[1]), v: (/\bvalue="([^"]*)"/.exec(o[1]) || [0, o[2].trim()])[1] }));
      const pick = opts.find(o => o.sel) || opts[0];
      if (pick) el.value = pick.v;
    }
    if (el.tagName === 'TEXTAREA') el.value = '';
    els.set(id[1], el);
  }
  const body = mkEl('body'), head = mkEl('head');
  const docLst = {}, winLst = {};
  const document = {
    body, head, documentElement: mkEl('html'), title: '', activeElement: body, cookie: '',
    getElementById(id) {
      if (els.has(id)) return els.get(id);
      // an element some script has rendered: its id is in HTML written to the page
      for (const e of els.values()) if (typeof e.innerHTML === 'string' && e.innerHTML.includes('id="' + id + '"')) { const made = mkEl('div', id); els.set(id, made); return made; }
      return null;
    },
    querySelector(sel) { const one = /^#([\w-]+)$/.exec(sel); return one ? document.getElementById(one[1]) : chameleon; },
    querySelectorAll() { return []; },
    createElement(tag) { return mkEl(tag); }, createElementNS(ns, tag) { return mkEl(tag); }, createTextNode() { return chameleon; },
    addEventListener(type, fn) { (docLst[type] = docLst[type] || []).push(fn); }, removeEventListener() {},
  };
  // timers the test drains by hand, earliest first
  let timers = [], tid = 0, clock = 0;
  const setT = (fn, ms) => { timers.push({ id: ++tid, at: clock + (+ms || 0), fn }); return tid; };
  const clearT = id => { timers = timers.filter(t => t.id !== id); };
  const store = new Map(Object.entries(saved || {}));
  const ctx = {
    document, console: { log() {}, info() {}, debug() {}, warn() {}, error(...a) { errors.push('console.error: ' + a.map(x => (x && x.stack) || String(x)).join(' ').slice(0, 600)); } },
    location: { hash: '', href: 'http://localhost:8080/', search: '', protocol: 'http:', pathname: '/' },
    history: { replaceState() {}, pushState() {} },
    navigator: { userAgent: 'smoke', clipboard: { writeText: async () => {} } },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); } },
    setTimeout: setT, clearTimeout: clearT, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: fn => setT(() => fn(clock), 16), cancelAnimationFrame: clearT,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    confirm: () => true, alert() {}, prompt: () => null, print() {}, scrollTo() {}, scrollY: 0, innerWidth: 1280, innerHeight: 800,
    fetch: () => Promise.reject(new Error('no network in the smoke test')),
    getComputedStyle: () => chameleon, performance: { now: () => clock },
    URL: { createObjectURL: () => 'blob:smoke', revokeObjectURL() {} }, Blob: function () {}, FileReader: chameleon, Image: chameleon,
    crypto: { randomUUID: () => 'smoke-' + (++tid), getRandomValues: a => a },
    addEventListener(type, fn) { (winLst[type] = winLst[type] || []).push(fn); }, removeEventListener() {},
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  return {
    ctx, errors, els, store,
    el: id => document.getElementById(id),
    run(code, name) { return vm.runInContext(code, ctx, { filename: name || 'smoke', timeout: 60000 }); },
    fireWindow(type) { return Promise.all((winLst[type] || []).map(fn => fn({ type }))); },
    /* let promises settle and run the timers that are due, until nothing is left (animations and chunked odds runs) */
    async settle(maxTimers) {
      for (let n = 0; n < (maxTimers || 20000); n++) {
        await new Promise(r => setImmediate(r));
        if (!timers.length) { await new Promise(r => setImmediate(r)); if (!timers.length) return true; }
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = timers.shift(); clock = Math.max(clock, t.at);
        try { t.fn(); } catch (e) { errors.push('a timer threw: ' + ((e && e.stack) || e)); }
      }
      return false;
    },
  };
}

/* load index.html's scripts into a page; returns the page with page.loadErrors */
function loadSite(saved) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*\bsrc="([^"?]+)/g)].map(s => s[1]).filter(f => !/^https?:/.test(f));
  const page = makePage(html, saved);
  page.scripts = scripts; page.loadErrors = [];
  for (const f of scripts) {
    try { page.run(fs.readFileSync(path.join(ROOT, f), 'utf8'), f); }
    catch (e) { page.loadErrors.push(f + ' threw while loading: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
  }
  return page;
}

const GLOBALS = ['PARTY_PLAYERS', 'CLASS_BUILDS', 'SRD_MONSTERS', 'SpellData', 'StatblockParser', 'SheetReader', 'TacEngine', 'WarTable',
  'renderParty', 'renderMonsters', 'renderPartyBar', 'renderAll', 'validateMonster', 'checkRealSchema', 'buildDayObject', 'exportCreature', 'applyWorkspace', 'loadWorkspace', 'showView'];

async function smoke() {
  const out = [];
  const check = (ok, msg) => { out.push({ ok: !!ok, msg }); if (process.env.SMOKE_TRACE) console.log((ok ? '  ok   ' : '  FAIL ') + msg); };
  const errs = (page, from) => page.errors.slice(from || 0).join(' || ').slice(0, 700);

  // 1. every script loads, the globals exist, the start-up render ran
  const page = loadSite();
  check(!page.loadErrors.length, 'every script index.html ships runs to the end in a page' + (page.loadErrors.length ? ': ' + page.loadErrors.join(' || ') : ' (' + page.scripts.length + ' scripts)'));
  const missing = GLOBALS.filter(g => page.run('typeof ' + g) === 'undefined');
  check(!missing.length, 'the globals the app needs exist' + (missing.length ? '; missing: ' + missing.join(', ') : ''));
  if (page.loadErrors.length || missing.length) return out;
  check(page.run('typeof TacEngine.runDay === "function" && typeof WarTable.show === "function" && Object.keys(TacEngine).length') >= 26, 'TacEngine and WarTable are whole');
  await page.fireWindow('DOMContentLoaded'); await page.settle();
  const first = page.run('PARTY_PLAYERS[0].name');
  check(page.el('forgeSide').innerHTML.includes(first) && page.el('forgeDynamic').innerHTML.length > 200, 'the Forge drew its sidebar (with ' + first + ') and its main panel');
  check(/Autosave on/.test(page.el('saveStatus').textContent), 'with nothing saved the status reads "Autosave on": ' + page.el('saveStatus').textContent);
  check(!page.errors.length, 'no error logged while starting up' + (page.errors.length ? ': ' + errs(page) : ''));

  // 2. a statblock goes in through the importer (built-in reader)
  let at = page.errors.length;
  const ogre = page.run('SRD_MONSTERS.find(m => m.name === "Ogre").text');
  page.el('statblockInput').value = ogre;
  if (page.el('useClaudeInput')) page.el('useClaudeInput').checked = false;
  await page.el('parseBtn').fire('click'); await page.settle();
  check(page.run('encounters[activeIdx].monsters.some(m => m.name === "Ogre")') && /Added 1 creature/.test(page.el('parseStatus').innerHTML), 'pasting the Ogre statblock adds it to the encounter: ' + String(page.el('parseStatus').innerHTML).replace(/<[^>]+>/g, '').slice(0, 90));
  check(page.el('forgeDynamic').innerHTML.includes('Ogre'), 'the new creature\'s sheet is shown');
  await page.el('parseBtn').fire('click');
  check(/Paste a statblock first/.test(page.el('parseStatus').innerHTML), 'an empty box gives a message, not a crash');
  page.el('statblockInput').value = 'this is not a statblock at all';
  await page.el('parseBtn').fire('click'); await page.settle();
  check(/couldn't be converted/.test(page.el('parseStatus').innerHTML) && page.run('encounters[activeIdx].monsters.length') === 1, 'text that is no statblock adds nothing and gives a message: ' + String(page.el('parseStatus').innerHTML).replace(/<[^>]+>/g, '').slice(0, 80));
  check(page.errors.length === at, 'no error logged by the importer' + (page.errors.length > at ? ': ' + errs(page, at) : ''));

  // 3. the day export passes the format check
  at = page.errors.length;
  const exp = page.run('(() => { const d = buildDayObject(); const r = checkRealSchema(d); return { fights: d.encounters.length, players: d.players.length, ok: r.ok, problems: r.errors }; })()');
  check(exp.players > 0 && exp.fights > 0 && exp.ok === true && !exp.problems.length, 'the day export passes checkRealSchema (' + exp.players + ' players, ' + exp.fights + ' encounter): ' + JSON.stringify(exp.problems).slice(0, 200));

  check(page.run('PARTY_PLAYERS.every(p => p.ext && p.ext.hitDice) && buildDayObject().players.every(p => !(p.ext && p.ext.hitDice))'), 'the built-in party carries Hit Dice, and the day export leaves ext.hitDice out (the save-file format is unchanged)');

  // 4. the Forge's Smartness select writes ext.aiTier, and "auto" clears it
  const key = page.run('String(encounters[activeIdx].monsters.findIndex(m => m.name === "Ogre"))');
  const pick = v => page.el('forgeDynamic').fire('change', { target: { tagName: 'SELECT', type: 'select-one', value: v, checked: false, dataset: { ext: 'aiTier', owner: key } } });
  await pick('boss');
  const tier1 = page.run('(encounters[activeIdx].monsters[' + key + '].ext || {}).aiTier');
  await pick('auto');
  const tier2 = page.run('(encounters[activeIdx].monsters[' + key + '].ext || {}).aiTier');
  check(tier1 === 'boss' && tier2 === undefined, 'the Smartness select sets ext.aiTier and "auto" clears it (' + tier1 + ', ' + tier2 + ')');

  // 5. the War Table opens, plays one fight, runs the odds; its selects reach the sim options
  page.run('showView("war")'); await page.settle();
  check(page.el('viewWar').style.display === '' && page.el('viewForge').style.display === 'none', 'the War Table view opens');
  const set = (id, v) => { const e = page.el(id); e.value = v; return e.fire('change', { target: e }); };
  await set('wt-rulesCounter', '2014');
  const so = page.run('JSON.parse(JSON.stringify(WarTable.simOpts(0)))');
  check(so.rules && so.rules.counterspell === '2014' && so.ai === undefined && so.partyAI === undefined && !page.el('wt-aiFoes') && !page.el('wt-aiParty') && !page.el('wt-partyAI'), 'the Counterspell select reaches the sim options, and no select picks the AI any more: ' + JSON.stringify({ rules: so.rules, ai: so.ai }));
  await set('wt-rulesCounter', '2024');
  check(page.run('WarTable.simOpts(0).rules.counterspell') === '2024', 'and back to 2024');
  check(page.run('WarTable.simOpts(0).rules.rest') === 'hitdice' && page.el('wt-rulesRest').value === 'hitdice', 'the short rest rule starts as Hit Dice (a workspace saved before it existed has no setting and reads the same)');
  await set('wt-rulesRest', 'full');
  check(page.run('WarTable.simOpts(0).rules.rest') === 'full', 'the Short rest select reaches the sim options (full)');
  await set('wt-rulesRest', 'hitdice');
  check(page.run('WarTable.simOpts(0).rules.rest') === 'hitdice', 'and back to Hit Dice');
  // handlers that wait on timers (animation, chunked odds) are started, then the timers are drained
  const go = async (el, type, max) => { let ended = false; el.fire(type || 'click').then(() => { ended = true; }, e => { ended = true; page.errors.push('a handler threw: ' + ((e && e.stack) || e)); }); await page.settle(max); await page.settle(max); return ended; };
  await go(page.el('wt-btnOne'));
  const log = String(page.el('wt-log').innerHTML);
  check(log.length > 500 && /Ogre/.test(log), 'one fight plays: the replay log has ' + (log.match(/class="l/g) || []).length + ' lines');
  check(await go(page.el('wt-btnPlay'), 'click', 400000) && page.el('wt-btnPlay').textContent === '▶', 'the replay animates to its end');
  await go(page.el('wt-btnSetup'));
  await set('wt-runs', '100');
  check(await go(page.el('wt-btnRun')) && /\d%/.test(String(page.el('wt-odds').innerHTML)), 'an odds run finishes and shows a percentage: ' + String(page.el('wt-runStatus').textContent).slice(0, 60));
  check(page.errors.length === at, 'no error logged on the War Table' + (page.errors.length > at ? ': ' + errs(page, at) : ''));

  // 6. an empty encounter: a message, not a crash
  at = page.errors.length;
  page.run('showView("forge"); encounters.push(freshEncounter()); activeIdx = encounters.length - 1; select({ kind: "enc", e: activeIdx }); showView("war"); WarTable.openEncounter(activeIdx);');
  await page.settle();
  await go(page.el('wt-btnOne'));
  await go(page.el('wt-btnRun'));
  check(page.errors.length === at, 'an encounter with no monsters does not crash a fight or an odds run' + (page.errors.length > at ? ': ' + errs(page, at) : ''));

  // 6b. loading a day file: not JSON, JSON of the wrong shape, and a real day (tests/fixtures/hard-day.json)
  at = page.errors.length;
  page.run('showView("forge")');
  const snap = JSON.parse(page.run('snapshot()'));      // the session's work, for step 7 (hard-day.json has no party)
  const loadDay = async (name, text) => { await page.el('loadDayInput').fire('change', { target: { value: '', files: [{ name, text: async () => text }] } }); await page.settle(); return String(page.el('loadStatus').innerHTML).replace(/<[^>]+>/g, ' '); };
  const shape = () => page.run('JSON.stringify([encounters.length, encounters.map(e => e.monsters.length), PARTY_PLAYERS.length])');
  const before = shape();
  const s1 = await loadDay('broken.json', '{"players": [');
  const s2 = await loadDay('other.json', '{"hello": "world"}');
  const untouched = shape() === before;
  const s3 = await loadDay('hard-day.json', fs.readFileSync(path.join(__dirname, 'fixtures', 'hard-day.json'), 'utf8'));
  check(/isn't valid JSON/.test(s1) && /doesn't look like a day save file/.test(s2) && untouched, 'a day file that is not JSON, or not a day, gives a message and changes nothing: ' + s1.slice(0, 40) + ' / ' + s2.slice(0, 50));
  check(/Loaded "hard-day.json"/.test(s3) && page.run('encounters.length') === 4 && page.errors.length === at, 'a real day file loads (hard-day.json, 4 encounters): ' + s3.slice(0, 70) + (page.errors.length > at ? ' || ' + errs(page, at) : ''));

  // 7. saved work comes back: this session's, and one saved by an older version (party version 9, no selection, bare encounters)
  const old =JSON.parse(JSON.stringify(snap));
  old.partyVersion = 9; delete old.sel; delete old.activeIdx; old.dayName = 'An old day';
  old.players.forEach(p => (p.actions || []).forEach(a => { if (a.ext && a.ext.react) delete a.ext.react; }));
  old.encounters = old.encounters.filter(e => e.monsters.length).map(e => ({ monsters: e.monsters }));
  for (const [label, ws] of [['this version', snap], ['an older version', old]]) {
    const again = loadSite({ 'forge-workspace-v1': JSON.stringify(ws) });
    await again.fireWindow('DOMContentLoaded'); await again.settle();
    const got = again.run('({ mons: encounters.reduce((n, e) => n + e.monsters.length, 0), players: PARTY_PLAYERS.length, day: document.getElementById("dayNameInput").value })');
    const status = String(again.el('saveStatus').textContent);
    check(!again.loadErrors.length && !again.errors.length && /Restored|✓ Saved/.test(status) && got.players === ws.players.length && got.mons === ws.encounters.reduce((n, e) => n + e.monsters.length, 0) && got.day === ws.dayName,
      'a workspace saved by ' + label + ' is restored (' + got.players + ' players, ' + got.mons + ' monsters): ' + status.slice(0, 70) + (again.errors.length ? ' || ' + errs(again) : ''));
  }
  // saved text that is not a workspace: a message, the page still works
  const broken = loadSite({ 'forge-workspace-v1': '{"v":1,"players":[{"name":"half a creature"' });
  await broken.fireWindow('DOMContentLoaded'); await broken.settle();
  const bad = '{"v":1,"players":[{"name":"half a creature"';
  check(!broken.loadErrors.length && /Couldn't read saved work/.test(String(broken.el('saveStatus').textContent)) && broken.el('forgeSide').innerHTML.length > 100, 'saved work that cannot be read gives a message and the default workspace');
  check(broken.store.get('forge-workspace-v1-unreadable') === bad, 'and the unreadable text is put aside before autosave can write over it');
  // a saved encounter with a hole in its monster list still loads (the hole is dropped)
  const holed = JSON.parse(JSON.stringify(snap)); holed.encounters[0].monsters.push(null);
  const patched = loadSite({ 'forge-workspace-v1': JSON.stringify(holed) });
  await patched.fireWindow('DOMContentLoaded'); await patched.settle();
  check(!patched.errors.length && /Restored|✓ Saved/.test(String(patched.el('saveStatus').textContent)) && patched.run('encounters[0].monsters.length') === snap.encounters[0].monsters.length, 'a saved encounter with an empty slot in its monster list still loads');
  // a workspace and War Table state saved while the old AI choices existed (Party AI / Enemy AI / The party plays, "Fights like" per creature,
  // the old Smartness values) load silently, the dead settings are dropped, and a fight plays with the one AI
  const legacy = JSON.parse(JSON.stringify(snap));
  for (const e of legacy.encounters) for (const m of e.monsters) { m.ext = Object.assign({}, m.ext, { ai: 'regular', aiTier: 'genius' }); }
  legacy.players.forEach((p, i) => { p.ext = Object.assign({}, p.ext, { ai: i % 2 ? 'regular' : 'beast' }); });
  const wtOld = JSON.stringify({ settings: { surprise: '2024', escape: 'smart', runs: 100, map: '24x16', partyAI: 'regular', aiParty: 'v1', aiFoes: 'v1', knowParty: 'blind', knowFoes: 'open', morale: 'off', settingsVer: 2 }, layouts: {}, enc: 0 });
  const leg = loadSite({ 'forge-workspace-v1': JSON.stringify(legacy), 'war-table-v1': wtOld });
  await leg.fireWindow('DOMContentLoaded'); await leg.settle();
  leg.run('showView("war")'); await leg.settle();
  const lso = leg.run('JSON.parse(JSON.stringify(WarTable.simOpts(0)))');
  await leg.el('wt-btnOne').fire('click', {}); await leg.settle();
  check(!leg.loadErrors.length && !leg.errors.length && lso.ai === undefined && lso.partyAI === undefined && lso.know.party === 'blind', 'a workspace and War Table state saved with the old AI settings load, ignore them, keep the knowledge setting, and play a fight: ' + JSON.stringify([leg.loadErrors, lso.ai, lso.partyAI, lso.know]) + (leg.errors.length ? ' || ' + errs(leg) : ''));
  // a saved Smartness of "genius" (the tier is gone) reads as cunning in the Forge's select, which no longer offers Genius
  const sheet = String(leg.run('sheetHtml("0", [].concat(...encounters.map(e => e.monsters)).find(m => m.ext && m.ext.aiTier === "genius"))'));
  check(/<option value="cunning" selected>/.test(sheet) && !/genius/i.test(sheet.replace(/title="[^"]*"/g, '')) && !/Fights like/.test(sheet), 'the Smartness select shows a saved "genius" as Cunning, has no Genius option, and the Fights like select is gone');

  // 8. custom mechanics (docs/custom-mechanics.md): Fiorenzo through the importer, his sheet's panel, the panel's checks, the export, a reload, a fight
  at = page.errors.length;
  page.run('showView("forge")');
  page.el('statblockInput').value = fs.readFileSync(path.join(__dirname, 'statblocks', 'fiorenzo.txt'), 'utf8');
  await page.el('parseBtn').fire('click'); await page.settle();
  const fk = page.run('String(encounters[activeIdx].monsters.findIndex(m => /Fiorenzo/.test(m.name)))');
  const fpath = 'encounters[activeIdx].monsters[' + fk + ']';
  check(+fk >= 0 && page.run(fpath + '.ext.traits.length') === 7 && page.run('validateMonster(' + fpath + ').length') === 0, 'Fiorenzo imports with 7 traits and no warnings: ' + page.run('JSON.stringify(validateMonster(' + fpath + '))'));
  const fsheet = String(page.run('sheetHtml("' + fk + '", ' + fpath + ')'));
  check(/Custom mechanics \(advanced\)/.test(fsheet) && /data-cm-apply/.test(fsheet) && /Sniper&#39;s Eye — when onHit/.test(fsheet) && /the AI plans for it/.test(fsheet), 'his sheet has the Custom mechanics panel, one line per trait and what the AI does with it');
  check(/simulated on the War Table; the AI does not plan for reroll/.test(fsheet), 'a word the AI does not score says so (Halfling Luck: simulated, not planned for)');
  const cm = text => page.run('(() => { const c = JSON.parse(JSON.stringify(' + fpath + ')); const r = applyCustomMechanics(c, ' + JSON.stringify(text) + '); return { ok: r.ok, m: r.messages, n: (c.ext.traits || []).length }; })()');
  const good = cm('[{"name":"Grit","when":"onMiss","do":[{"gain":{"res":"Patience","n":1}}]}]');
  const notJson = cm('[{"name": "Grit", when: onMiss}]');
  const unknown = cm('[{"name":"Grit","when":"onMiss","do":[{"gian":{"res":"Patience"}}]}]');
  check(good.ok && good.n === 1 && !good.m.length, 'Custom mechanics: valid JSON is applied (' + JSON.stringify(good) + ')');
  check(!notJson.ok && /Not valid JSON/.test(notJson.m[0]) && notJson.n === 7, 'invalid JSON is refused with a message and nothing changes: ' + notJson.m[0]);
  check(!unknown.ok && /unknown effect "gian"/.test(unknown.m.join(' ')) && unknown.n === 7, 'an unknown word is refused with a message and nothing changes: ' + unknown.m.join(' | ').slice(0, 90));
  // through the panel's Apply button: a refused text is kept with its messages; the creature is untouched
  page.el('forgeDynamic').innerHTML += '<textarea id="cm-' + fk + '"></textarea>';
  page.el('cm-' + fk).value = '[{"when":"onTuesday","do":[{"advantage":true}]}]';
  page.run('onCustomMechanics("' + fk + '", false)'); await page.settle();        // what the Apply button calls (rendered buttons are not clickable here)
  check(page.run(fpath + '.ext.traits.length') === 7 && /unknown trigger/.test(String(page.run('sheetHtml("' + fk + '", ' + fpath + ')'))), 'the Apply button keeps a refused draft on the sheet with its message, and the traits stay as they were');
  page.run('cmDrafts.clear()');
  // the export: valid, his War Table-only actions left out, the plain actions kept
  const fexp = page.run('(() => { const d = buildDayObject(); const r = checkRealSchema(d); const f = d.encounters[activeIdx].monsters.find(m => /Fiorenzo/.test(m.name)); return { ok: r.ok, errs: r.errors, acts: f.actions.map(a => a.name), traits: !!(f.ext && f.ext.traits) }; })()');
  check(fexp.ok && fexp.acts.indexOf('La Pazienza') >= 0 && fexp.acts.indexOf('Aimed Shot') < 0 && fexp.acts.indexOf('Stitch Step') < 0, 'the day export with Fiorenzo passes checkRealSchema; Aimed Shot and Stitch Step (War Table only) are left out: ' + JSON.stringify(fexp).slice(0, 160));
  // a workspace with ext.traits comes back with them
  const snap2 = page.run('snapshot()');
  const again2 = loadSite({ 'forge-workspace-v1': snap2 });
  await again2.fireWindow('DOMContentLoaded'); await again2.settle();
  const back = again2.run('(() => { const f = [].concat(...encounters.map(e => e.monsters)).find(m => /Fiorenzo/.test(m.name)); return f ? { n: f.ext.traits.length, pool: f.ext.resources.Patience.start, w: validateMonster(f).length } : null; })()');
  check(!again2.errors.length && back && back.n === 7 && back.pool === 0 && back.w === 0, 'a workspace with ext.traits is restored with them (' + JSON.stringify(back) + ')' + (again2.errors.length ? ' || ' + errs(again2) : ''));
  // and a fight with him plays on the War Table
  if (!page.run('PARTY_PLAYERS.length')) page.run('PARTY_PLAYERS.splice(0, 0, ...' + JSON.stringify(snap.players) + ')');      // hard-day.json (step 6b) has no party
  page.run('(() => { const f = JSON.parse(JSON.stringify(' + fpath + ')); f.id = uid(); encounters.unshift(freshEncounter()); activeIdx = 0; encounters[0].monsters.push(f); select({ kind: "enc", e: activeIdx }); showView("war"); WarTable.openEncounter(activeIdx); })()'); await page.settle();
  await go(page.el('wt-btnOne'));
  const flog = String(page.el('wt-log').innerHTML);
  check(/Fiorenzo/.test(flog) && /La Pazienza|Aimed Shot/.test(flog) && page.errors.length === at, 'a War Table fight with Fiorenzo plays and logs his shots' + (page.errors.length > at ? ': ' + errs(page, at) : ': ' + String(page.el('wt-runStatus').textContent) + ' ' + flog.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)));
  return out;
}

module.exports = { smoke, loadSite, makePage };
if (require.main === module) smoke().then(out => { let bad = 0; for (const r of out) { if (!r.ok) bad++; console.log((r.ok ? '  ok   ' : '  FAIL ') + r.msg); } console.log(bad ? bad + ' failed' : 'smoke test passed (' + out.length + ' checks)'); process.exit(bad ? 1 : 0); }, e => { console.error(e); process.exit(1); });
