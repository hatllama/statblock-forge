/* Engine and parser checks. No dependencies: `node tests/run.js` (or `npm test`).
   Loads the War Table engine and the statblock parser the same way the browser does (plain scripts that set globals),
   plays a few hundred fights, and fails loudly if a rule is broken. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
function loadGlobal(file, name) {
  const ctx = { console, globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  if (!ctx[name]) throw new Error(`${file} did not define ${name}`);
  return ctx[name];
}
const Tac = loadGlobal('js/engine/tactical-engine.js', 'TacEngine');
const Parser = (() => {
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ['js/spell-data.js', 'js/statblock-parser.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return ctx.StatblockParser;
})();
const fixture = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));

let failures = 0, checks = 0;
function check(ok, msg) { checks++; if (!ok) { failures++; console.log('  FAIL', msg); } else if (process.env.VERBOSE) console.log('  ok', msg); }
function section(name) { console.log('\n' + name); }

// a map with walls, high ground and difficult terrain
const cells = {};
for (let y = 0; y < 16; y++) if (y < 6 || y > 9) cells['11,' + y] = { t: 'wall' };
for (let y = 2; y < 14; y++) for (let x = 3; x <= 5; x++) cells[x + ',' + y] = { h: 2 };
for (let y = 0; y < 16; y++) for (let x = 13; x <= 14; x++) if (!cells[x + ',' + y]) cells[x + ',' + y] = { t: 'difficult' };
cells['7,3'] = { t: 'wall' }; cells['7,4'] = { t: 'wall' };
const walled = { gapFt: 30, positions: {}, terrain: { cells } };
const isWall = (x, y) => cells[x + ',' + y] && cells[x + ',' + y].t === 'wall';
const INCAP = ['Incapacitated', 'Paralyzed', 'Petrified', 'Stunned', 'Unconscious'];

/* the rule checks one recorded fight must pass: no steps onto walls, no ranged attacks through them, nobody acting
   while dead, nobody hiding in plain sight on an open field (counts are added to acc) */
function scanRules(r, layout, acc) {
  let { wallSteps, throughWalls, deadActs, incapActs, badHide, events } = acc;
  let cur = {}, turnOf = null, inArea = false;
  const dmgZones = [];          // lingering zones hurt from the zone's cells, not along a line from the caster
  const zones = new Map();      // lingering damage zones now up: zid -> { name, cells }. Their damage comes from the zone's cells (already cut by walls), not a line from the caster
  const pushed = new Set();     // a later beam of the same attack follows a creature the first one pushed
  for (const e of r.events) {
    events++;
    const prev = cur; cur = Object.assign({}, cur);
    for (const k in e.state) cur[k] = Object.assign({}, cur[k] || {}, e.state[k]);
    if (e.kind === 'turn') { turnOf = e.uid; pushed.clear(); }
    if (e.kind === 'zone' && e.zkind === 'dmg') { const zn = /^(.*?) (lingers|follows)/.exec(e.text || ''); if (zn) dmgZones.push(zn[1]); }
    if (e.kind === 'zone' && e.zkind === 'dmg') { const zn = /^(.*?) (lingers|follows)/.exec(e.text || ''); if (zn) zones.set(e.zid, { name: zn[1], cells: new Set(e.cells.map(c => c[0] + ',' + c[1])) }); }
    if (e.kind === 'zoneEnd') zones.delete(e.zid);
    const zoneName = [...zones.values()].map(z => z.name).find(n => (e.text || '').includes(': ' + n));
    if (layout && zoneName && (e.kind === 'attack' || e.kind === 'save') && prev[e.target] && prev[e.target].onBoard !== false) {
      const t = prev[e.target];
      if (![...zones.values()].some(z => z.name === zoneName && z.cells.has(Math.floor(t.x + .5) + ',' + Math.floor(t.y + .5)))) throughWalls++;
    }
    if (e.kind === 'move' && / is pushed /.test(e.text)) pushed.add(e.uid);
    // saves inside an area are rolled from the area's centre, not the caster
    if (e.kind === 'aoe') inArea = true; else if (!['save', 'effect', 'react', 'down', 'death', 'deathsave', 'zone', 'zoneEnd', 'trigger', 'heal', 'expel'].includes(e.kind)) inArea = false;
    if (layout && e.kind === 'move' && e.path) for (const q of e.path) if (isWall(q.x, q.y)) wallSteps++;
    if (layout && !inArea && (e.kind === 'attack' || e.kind === 'save') && e.ranged && !zoneName && !pushed.has(e.target) && !/leap|bites back|drains/.test(e.text) && !dmgZones.some(n => (e.text || '').includes(': ' + n))) {
      const a = prev[e.uid], b = prev[e.target];
      if (a && b && a.onBoard !== false && b.onBoard !== false && !a.swallowedBy && !b.swallowedBy) {
        if (process.env.VERBOSE) { const n0 = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 4; for (let j = 1; j < n0; j++) { const f = j / n0; if (isWall(Math.floor(a.x + .5 + (b.x - a.x) * f), Math.floor(a.y + .5 + (b.y - a.y) * f))) { console.log('   wall?', e.kind, e.text.slice(0, 100), a.x, a.y, a.conds, '->', b.x, b.y); break; } } }
        const n = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 4;
        for (let j = 1; j < n; j++) { const f = j / n; if (isWall(Math.floor(a.x + .5 + (b.x - a.x) * f), Math.floor(a.y + .5 + (b.y - a.y) * f))) { throughWalls++; break; } }
      }
    }
    const me = prev[e.uid];
    if (me && e.uid === turnOf && ['attack', 'save', 'heal'].includes(e.kind) && !/drains|bites back|leaps|reacts|shakes off|rerolls|lashes|Agathys/.test(e.text)) {
      if (me.dead) deadActs++;
      else if ((me.conds || []).some(c => INCAP.includes(c))) incapActs++;
    }
    const foeUp = Object.keys(prev).some(k => k.startsWith('foes') || !k.includes('-') ? false : false) || r.units.some(u => u.team !== 'party' && prev[u.uid] && !prev[u.uid].dead && prev[u.uid].hp > 0 && prev[u.uid].onBoard !== false && !(prev[u.uid].conds || []).some(c => INCAP.includes(c)));
    if (!layout && foeUp && e.kind === 'buff' && /: Cunning Action: Hide/.test(e.text)) {
      // on an open field with no fog nothing can hide; fog clouds are the exception
      if (!r.events.some(x => x.kind === 'zone' && x.zkind === 'fog')) { badHide++; if (process.env.VERBOSE) console.log('   hide?', e.text, JSON.stringify(Object.fromEntries(Object.entries(prev).map(([k, v]) => [k.split(':').slice(-2).join(':'), [v.x, v.y, v.hp, (v.conds || []).join('/')]])))); }
    }
  }
  Object.assign(acc, { wallSteps, throughWalls, deadActs, incapActs, badHide, events });
}

for (const file of ['worms-day.json', 'bandit-day.json']) {
  const day = fixture(file);
  // 'v2': AI v2 on both sides for non-casters and full casters (docs/ai-v2.md), the old tactical AI for half casters
  for (const ai of ['tactical', 'regular', 'v2']) for (const layout of [null, walled]) {
    section(`${file} · ${ai} AI · ${layout ? 'walled map' : 'open field'}`);
    const runs = [];
    let wallSteps = 0, throughWalls = 0, deadActs = 0, incapActs = 0, badHide = 0, events = 0;
    const t0 = Date.now();
    for (let i = 0; i < 25; i++) {
      const seed = 1000 + i * 7919;
      const res = Tac.runDay(JSON.parse(JSON.stringify(day)), { seed, partyAI: ai === 'v2' ? 'tactical' : ai, ai: ai === 'v2' ? 'v2' : undefined, record: true, layouts: layout ? { 0: layout, 1: layout } : undefined });
      runs.push({ seed, res });
      const acc = { wallSteps, throughWalls, deadActs, incapActs, badHide, events };
      for (const r of res) scanRules(r, layout, acc);
      ({ wallSteps, throughWalls, deadActs, incapActs, badHide, events } = acc);
    }
    const S = Tac.summarize(day, runs, { partyAI: ai === 'v2' ? 'tactical' : ai });
    const ms = (Date.now() - t0) / runs.length;
    console.log('  ' + S.encounters.map((e, i) => `fight ${i + 1}: win ${(e.winRate * 100).toFixed(0)}% · a PC dies ${(e.anyDeath * 100).toFixed(1)}%`).join(' | ') + ` · ${ms.toFixed(0)} ms/day · ${events} events`);
    check(S.encounters.every(e => e.winRate >= 0 && e.winRate <= 1 && e.anyDeath >= 0 && e.anyDeath <= 1), 'odds are probabilities');
    check(wallSteps === 0, `${wallSteps} steps onto walls`);
    check(throughWalls === 0, `${throughWalls} ranged attacks through walls`);
    check(deadActs === 0, `${deadActs} actions by dead creatures`);
    check(badHide === 0, `${badHide} hides in plain sight`);
    if (incapActs) console.log(`  note: ${incapActs} passive/aura effects from incapacitated creatures`);
  }
}

section('Area templates');
{
  const cells = (shape, size, tx, ty, placed) => Tac.areaCells({ shape, size, explicit: true, placed: !!placed, width: 5 }, 20, 20, tx, ty, 41, 41);
  const sph = cells('sphere', 20, 30, 20), cone = cells('cone', 30, 26, 20), line = cells('line', 40, 28, 20), em = cells('emanation', 10, 20, 20);
  check(sph.length === 61 && !sph.some(([x, y]) => x === 26 && y === 24), `sphere r20 is round (${sph.length} squares)`);
  check(cone.length === 24 && cone.every(([x]) => x > 20), `30-ft cone is a triangle in front (${cone.length} squares)`);
  const dline = cells('line', 30, 27, 26), dcone = cells('cone', 30, 26, 14);
  check(dline.length === 6 && dline.every(([x, y]) => x - 20 === y - 20 && x > 20), 'a diagonal line is a straight diagonal of squares');
  check(dcone.length === 23 && dcone.every(([x, y]) => dcone.some(([p, q]) => p - 20 === 20 - y && 20 - q === x - 20)), `a diagonal cone is symmetric about its diagonal (${dcone.length} squares)`);
  check(cells('line', 30, 26, 22).every(([, y]) => y === 20), 'a line aimed slightly off a row snaps to the row');
  check(line.length === 8 && line.every(([, y]) => y === 20), `40-ft line is 1 square wide (${line.length})`);
  check(em.length === 20 && !em.some(([x, y]) => x === 20 && y === 20), 'emanation spares its source');
  let bad = 0;
  for (const c of [['sphere', 20], ['cone', 15], ['line', 60], ['cube', 15], ['emanation', 10]]) for (let k = 0; k < 30; k++) {
    const tx = (k * 7) % 41, ty = (k * 13) % 41, set = new Set(cells(c[0], c[1], tx, ty).map(String));
    for (let y = 0; y < 41; y++) for (let x = 0; x < 41; x++) if (set.has(x + ',' + y) !== Tac.inArea({ shape: c[0], size: c[1], explicit: true, width: 5 }, 20, 20, tx, ty, x, y)) bad++;
  }
  check(bad === 0, `inArea agrees with areaCells (${bad} mismatches)`);
}

section('Terrain: fog, cover and climbing');
{
  const sim = new Tac.Sim({ width: 12, height: 6 });
  const cells = {}; cells['5,1'] = { h: 1 }; cells['5,4'] = { h: 3 };
  sim.setTerrain({ cells });
  sim.T.fog = new Uint8Array(72); for (let x = 3; x <= 7; x++) for (let y = 0; y < 6; y++) sim.T.fog[x + y * 12] = 1;
  check(!sim.los(1, 2, 9, 2) && sim.los(1, 2, 9, 2, true), 'fog blocks sight but not an area spreading through it');
  sim.T.fog = null;
  check(sim.coverBetween(1, 1, 9, 1) === 2, 'a 5-ft rise between two creatures on the ground gives half cover');
  check(sim.coverBetween(1, 2, 9, 2) === 0, 'no cover with nothing in between');
  check(!sim.los(1, 4, 9, 4), 'a 15-ft block hides what is behind it');
  sim.setTerrain({ cells: { '4,1': { h: 2 }, '6,1': { h: 2 } } });
  sim.T.h[5 + 1 * 12] = 2;   // a 10-ft high plateau at x=4..6 on row 1
  check(sim.coverBetween(5, 1, 9, 2) === 0, 'shooting down from high ground: no cover from its own ledge');
  const mk = (ex) => ({ uid: 'u', team: 'party', x: 2, y: 1, fly: 0, climb: ex.climb || 0, athletics: ex.ath || 0, onBoard: true });
  const roomy = { cells: {} }; for (let y = 0; y < 6; y++) roomy.cells['6,' + y] = { h: 2 };
  sim.units = []; sim.setTerrain(roomy);
  sim.climbDC = 10;
  const rmA = sim.reachMapRaw(mk({ ath: 3 }), 30), rmC = sim.reachMapRaw(mk({ climb: 30 }), 30), rmW = sim.reachMapRaw(mk({ ath: -5 }), 30);
  check(rmA.dist[6 + 1 * 12] === 3 + 1 + 2, `climbing a 10-ft ledge costs 10 ft extra (${rmA.dist[6 + 12]} squares)`);
  check(rmC.dist[6 + 1 * 12] === 4, 'a climb speed scales it at no extra cost');
  check(rmW.dist[6 + 1 * 12] < 0, 'a creature that would likely fail the Athletics check doesn\'t try');
  sim.climbDC = 99;
  check(sim.reachMapRaw(mk({ ath: 20 }), 30).dist[6 + 12] < 0 && sim.reachMapRaw(mk({ climb: 20 }), 30).dist[6 + 12] === 4, '"only with a climb speed" setting');
}

section('Flying');
{
  const sim = new Tac.Sim({ width: 12, height: 6 });
  const cells = { '5,1': { h: 1 }, '5,3': { h: 2 } };
  for (let y = 0; y < 6; y++) cells['8,' + y] = { t: 'difficult' };
  sim.setTerrain({ cells });
  const unit = (uid, x, y, fly) => ({ uid, team: uid === 'a' ? 'party' : 'foes', x, y, fly: fly || 0, climb: 0, athletics: 0, onBoard: true, hp: 10, maxHp: 10, buffs: [], dead: false });
  const walker = unit('a', 1, 3), bird = unit('b', 9, 3, 30), goblin = unit('b', 9, 3);
  bird.alt = 3;   // 15 ft up
  sim.units = [walker, goblin]; sim.boardChanged();
  check(!sim.canSee(1, 3, goblin), 'a 10-ft ledge hides a creature on the ground');
  sim.units = [walker, bird]; sim.boardChanged();
  check(sim.canSee(1, 3, bird), 'a flyer is up in the air: the ledge doesn\'t hide it');
  const crateFoe = unit('b', 9, 1), crateBird = unit('b', 9, 1, 30); crateBird.alt = 3;
  sim.units = [walker, crateFoe]; sim.boardChanged();
  check(sim.coverAC(unit('a', 1, 1), crateFoe) === 2, 'a crate covers a creature on the ground');
  sim.units = [walker, crateBird]; sim.boardChanged();
  check(sim.coverAC(unit('a', 1, 1), crateBird) === 0, 'a crate doesn\'t cover a flyer');
  const rmW = sim.reachMapRaw(unit('a', 6, 0), 30), rmF = sim.reachMapRaw(unit('a', 6, 0, 30), 30);
  check(rmW.dist[10] === 5 && rmF.dist[10] === 4, `flyers ignore difficult ground (${rmW.dist[10]} vs ${rmF.dist[10]} squares)`);
  const rmL = sim.reachMapRaw(unit('a', 4, 3, 30), 30);
  check(rmL.dist[5 + 3 * 12] === 1, 'flyers go over ledges with no climb');
  crateBird.buffs = [{ id: 'p', data: { condition: 'Prone' } }]; sim._flyMapVer = -1;
  check(!sim.airborne(crateBird), 'a prone flyer can\'t stay up');
  // altitude: distance is 3D, reach and falls follow it
  const sim2 = new Tac.Sim({ width: 10, height: 6, seed: 3 });
  sim2.setTerrain(null);
  const mk = (uid, team, x, y, fly) => ({ uid, name: uid, team, x, y, fly: fly || 0, climb: 0, hover: false, alt: 0, speed: 30, onBoard: true, hp: 30, maxHp: 30, buffs: [], actions: [], dead: false, reaction: true, inside: [], uses: new Map(), dmgDealt: 0, dmgTaken: 0, isPC: false, _mr: 5 });
  const orc = mk('orc', 'foes', 4, 2), harpy = mk('harpy', 'party', 5, 2, 40);
  sim2.units = [orc, harpy]; sim2.byId = { orc, harpy }; sim2.boardChanged();
  check(sim2.dist(orc, harpy) === 5, 'side by side on the ground: 5 ft');
  harpy.alt = 3; sim2.boardChanged();
  check(sim2.dist(orc, harpy) === 15 && sim2.adjacentEnemies(harpy, 5, 2).length === 0, 'a flyer 15 ft up is out of a sword\'s reach (3D distance)');
  check(sim2.adjacentEnemies(harpy, 5, 2, 0).length === 1, '…and back in reach if it drops down');
  sim2.addBuff(harpy, orc, { id: 'trip', name: 'Trip' }, { duration: '1 round', condition: 'Prone' });
  check(harpy.alt === 0 && harpy.hp < 30, `knocked prone in the air, it falls (${30 - harpy.hp} damage)`);
  const owl = mk('owl', 'party', 6, 2, 40); owl.hover = true; owl.alt = 4; sim2.units.push(owl); sim2.byId.owl = owl;
  sim2.addBuff(owl, orc, { id: 'trip', name: 'Trip' }, { duration: '1 round', condition: 'Prone' });
  check(owl.alt === 4 && owl.hp === 30, 'a hovering flyer stays up when knocked prone');
}

section('Damage types and control spells');
{
  const mods = { dmgMods: { resist: ['fire', 'nonmagical slashing'], immune: ['poison'], vulnerable: ['radiant'] } };
  const A = (type, spell, mix) => ({ _spell: spell ? { level: 1 } : null, ext: { damageType: type, damageMix: mix } });
  check(Tac.damageMultFor(A('fire'), mods) === 0.5 && Tac.damageMultFor(A('poison'), mods) === 0 && Tac.damageMultFor(A('radiant'), mods) === 2, 'resistance halves, immunity stops, vulnerability doubles');
  check(Tac.damageMultFor(A('slashing'), mods) === 0.5 && Tac.damageMultFor(A('slashing', true), mods) === 1, 'resistance to nonmagical slashing doesn\'t cover a spell');
  check(Tac.damageMultFor(A('fire/radiant/poison'), mods) === 2, 'a chosen-type attack picks the best type');
  check(Math.abs(Tac.damageMultFor(A('slashing + fire', false, [['slashing', 10], ['fire', 10]]), mods) - 0.5) < 1e-9 && Math.abs(Tac.damageMultFor(A('cold + poison', false, [['cold', 3], ['poison', 1]]), mods) - 0.75) < 1e-9, 'mixed damage counts each part by its share');
  const day = fixture('bandit-day.json');
  let ent = 0, fights = 0, hurtOut = 0, fog = 0;
  for (let i = 0; i < 12; i++) for (const r of Tac.runDay(JSON.parse(JSON.stringify(day)), { seed: 500 + i, record: true })) {
    fights++;
    for (const e of r.events) { if (e.kind === 'aoe' && /Entangle/.test(e.text)) ent++; if (/hurt out of/.test(e.text)) hurtOut++; if (e.kind === 'zone' && /Fog/.test(e.text)) fog++; }
  }
  check(ent / fights < 0.4, `Entangle is saved for crowds (${ent} casts in ${fights} fights)`);
  check(fog === 0, `Fog Cloud isn't an opener when the party is winning (${fog} casts)`);
  check(hurtOut > 0, `Hideous Laughter breaks when the target is hurt (${hurtOut} times)`);
}

section('Statblock parser (no AI)');
{
  const dir = path.join(__dirname, 'statblocks');
  const parsed = {};
  for (const f of fs.readdirSync(dir)) {
    const r = Parser.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    check(r.monsters.length === 1 && !r.skipped.length, `${f}: expected one creature, got ${r.monsters.length} (${r.skipped.join('; ')})`);
    const m = r.monsters[0];
    if (!m) continue;
    parsed[f] = m;
    check(m.hp > 0 && m.AC > 0 && (m.actions.length || (m.ext.spellbook && m.ext.spellbook.spells.length)), `${f}: missing HP, AC or actions`);
    check(['str', 'dex', 'con', 'int', 'wis', 'cha'].every(k => typeof m.ext.saves[k] === 'number'), `${f}: missing saves`);
  }
  const act = (f, re) => (parsed[f] && parsed[f].actions || []).find(a => re.test(a.name));
  const expect = (cond, msg) => check(!!cond, msg);
  expect(parsed['goblin-2014.txt'].AC === 15 && parsed['goblin-2014.txt'].hp === 7 && act('goblin-2014.txt', /Scimitar/).toHit === 4, 'goblin stats');
  expect(act('goblin-2014.txt', /Hide/) && parsed['goblin-2014.txt'].ext.bonusDisengage, 'goblin Nimble Escape');
  const breath = act('adult-red-dragon-2014.txt', /Fire Breath/);
  expect(breath && breath.toHit === 21 && breath.dpr === '18d6' && breath.halfOnSave && breath.freq.cooldownRounds === 3 && breath.ext.area.shape === 'cone', 'red dragon breath');
  expect(act('adult-red-dragon-2014.txt', /Multiattack/).targets === 3 && act('adult-red-dragon-2014.txt', /Frightful/).actionSlot === -3, 'red dragon multiattack + Frightful Presence');
  expect(act('adult-red-dragon-2014.txt', /Tail Attack/).actionSlot === 2, 'red dragon legendary tail');
  expect(act('troll-2014.txt', /Multiattack/).targets === 3 && act('troll-2014.txt', /Regeneration/).amount === '10', 'troll');
  expect(act('owlbear-2024.txt', /Multiattack/).targets === 2 && act('owlbear-2024.txt', /Multiattack/).toHit === 7, 'owlbear (2024 format)');
  expect(act('giant-frog-2014.txt', /Swallow/).ext.swallow && act('giant-frog-2014.txt', /^Bite/).ext.grapple.escapeDC === 11, 'giant frog grapple + swallow');
  expect(parsed['mage-2014.txt'].ext.spellbook.slots.join() === '4,3,3,3,1,0,0,0,0' && parsed['mage-2014.txt'].ext.spellbook.spells.some(s => s.name === 'Fireball'), 'mage spellbook');
  expect(act('dragon-legendary-2024.txt', /Lightning Breath/).ext.area.shape === 'line', 'blue dragon line breath (2024)');
  expect(parsed['homebrewery-md.txt'].AC === 14 && act('homebrewery-md.txt', /Multiattack \(2 Longsword\)/), 'Homebrewery markdown');
  expect(parsed['ogre-ddb.txt'].hp === 59 && act('ogre-ddb.txt', /Greatclub/).toHit === 6, 'D&D Beyond layout');
  expect(act('bandit-captain-2014.txt', /Parry/).buff.ac === 2, 'bandit captain parry');
  const os = parsed['osric-homebrew.txt'];
  expect(os && os.name === 'Osric Aldermarch' && os.ext.legendaryResistance === 3 && os.ext.legendaryActions === 3, 'Osric: name, legendary resistance and actions');
  expect(act('osric-homebrew.txt', /Bought Off/).type === 'debuff' && act('osric-homebrew.txt', /Bought Off/).ext.selfOnly, 'Osric: Bought Off reaction');
  expect(act('osric-homebrew.txt', /Gilded Weight/).ext.legendaryCost === 2 && act('osric-homebrew.txt', /Gilded Weight/).ext.onHit.noReactions, 'Osric: Gilded Weight');
  const dv = parsed['dorian-homebrew.txt'];
  expect(act('dorian-homebrew.txt', /2 Blowpipe/) && act('dorian-homebrew.txt', /2 Molten Gather/).ext.onHit.slow === 10, 'Dorian: "any combination" multiattack gives a melee and a ranged routine, with the slow');
  expect(act('dorian-homebrew.txt', /Grasping Want/).targets === 2 && act('dorian-homebrew.txt', /Grasping Want/).ext.loseAction && act('dorian-homebrew.txt', /Grasping Want/).ext.pairWithin === 5, 'Dorian: Grasping Want costs two creatures their action');
  expect(act('dorian-homebrew.txt', /Molten Screen/).buff.ac === 2 && act('dorian-homebrew.txt', /Careful Distance/).ext.stepAway === 10, 'Dorian: Molten Screen (+2 AC) and Careful Distance (step 10 ft) reactions');
  expect(!dv._notes.some(n => /left out|nothing the simulator/.test(n)), 'Dorian: nothing left out');
  const hb = parsed['homebrewery-md.txt'], rd = parsed['adult-red-dragon-2014.txt'];
  expect(hb.ext.resist.includes('necrotic') && hb.ext.resist.includes('nonmagical slashing') && hb.ext.immune.includes('poison') && hb.ext.condImmune.includes('Poisoned'), 'resistances, immunities and condition immunities are read as lists');
  expect(rd.ext.immune.includes('fire') && act('adult-red-dragon-2014.txt', /Fire Breath/).ext.damageType === 'fire' && /piercing \+ fire \+ slashing/.test(act('adult-red-dragon-2014.txt', /Multiattack/).ext.damageType), 'damage types on attacks, breath weapons and mixed multiattacks');
  expect(parsed['wolf-2014.txt'].ext.packTactics && !act('wolf-2014.txt', /Pack Tactics/), 'wolf Pack Tactics is a trait, not an action');
  expect(os.actions.filter(a => a.actionSlot === 3).length === 3 && act('osric-homebrew.txt', /Ruinous/).ext.zone.difficult, 'Osric: lair actions and difficult terrain');
  const el = parsed['elparin-homebrew.txt'];
  expect(el.name === 'Elparin, the Attendant Athacus' && el.ext.noOpportunityAttacks, 'Elparin: name casing, no opportunity attacks');
  expect(act('elparin-homebrew.txt', /^Legislative Revision/).targets === 2 && act('elparin-homebrew.txt', /^Legislative Revision/).riderEffect.buff.ac === -3, 'Elparin: a named routine of two Statutory Editing strikes, each lowering AC by 3 on a failed save');
  expect(act('elparin-homebrew.txt', /Procedural Nullification/).ext.cancelAction && act('elparin-homebrew.txt', /Cite Precedent/).ext.onHit.noReactions && act('elparin-homebrew.txt', /Cite Precedent/).ext.saveAbility === 'int', 'Elparin: cancelling reaction; an ability check read as a save');
  expect(!el.actions.some(a => /Majd|Suspension/.test(a.name)) && !el._notes.some(n => /Suspension of/.test(n)), 'Elparin: triggered traits aren\'t auras; an action\'s bulleted options stay with it');
  {
    const kn = Parser.parse('Aldric the Bold\nMedium Humanoid (Human), Neutral\nAC 18\nHP 90 (12d8 + 36)\nSpeed 30 ft.\nCR 5 (XP 1,800; PB +3)\nActions\nLongsword. Melee Attack Roll: +7, reach 5 ft. Hit: 9 (1d8 + 5) Slashing damage.\nBonus Actions\nSecond Wind (2/Day). Aldric regains 10 (1d10 + 5) Hit Points.').monsters[0];
    const sw = kn && kn.actions.find(a => /Second Wind/.test(a.name));
    expect(sw && sw.target === 'self' && sw.type === 'heal', 'healing that names the creature ("Aldric regains…") heals itself');
  }
  {
    // a battle master-style foe: a shared die pool, Indomitable, save advantage, Action Surge, timed self-buff, Riposte, Brace, spellbreaking
    const bm = Parser.parse(['Duelist Captain', 'Medium Humanoid (Human), Neutral', 'AC 18', 'HP 120 (16d8 + 48)', 'Speed 30 ft.', 'CR 8 (XP 3,900; PB +3)',
      'Traits', 'Indomitable (2/Day). If the captain fails a saving throw, it can reroll it with a +10 bonus, and it must use the new roll.',
      'Steel Will. The captain has Advantage on saving throws to avoid or end the Stunned or Paralyzed condition.',
      'Superiority Dice (5/Day). The captain can expend one of these d8s to fuel a maneuver. It regains one when it rolls Initiative with none left.',
      'Actions', 'Multiattack. The captain makes two Longsword attacks.',
      'Longsword. Melee Attack Roll: +7, reach 5 ft. Hit: 9 (1d8 + 5) Slashing damage.',
      'Trip Attack (Superiority Die). Melee Attack Roll: +7, reach 5 ft. Hit: 13 (1d8 + 5 + 1d8) Slashing damage. The target must succeed on a DC 15 Strength saving throw or have the Prone condition.',
      'Action Surge (1/Day). The captain takes one additional action on this turn, and for the next minute its weapon attacks deal an extra 3 (1d6) damage.',
      'Bonus Actions', 'Battle Fury (1/Day). For 1 minute, the captain\'s Speed increases by 10 feet and its attacks deal an extra 4 (1d8) Slashing damage.',
      'Reactions', 'Riposte (Superiority Die). Trigger: A creature misses the captain with a melee attack roll. Response: The captain makes one melee attack against it, adding 4 (1d8) to the damage on a hit.',
      'Brace. Trigger: A creature moves into the captain\'s reach. Response: The captain makes one melee attack against it.',
      'Spellguard. Trigger: A creature casts a spell within 5 feet of the captain. Response: The captain makes one weapon attack against the spell; a damaging spell deals less damage, any other spell\'s DC drops by 2.'].join('\n')).monsters[0];
    const ba = re => bm.actions.find(a => re.test(a.name));
    expect(bm.ext.resources && bm.ext.resources['Superiority Dice'].uses === 5 && bm.ext.resources['Superiority Dice'].regainOnInit === 1, 'a shared die pool, refilled by one on Initiative');
    expect(bm.ext.indomitable && bm.ext.indomitable.uses === 2 && bm.ext.indomitable.bonus === 10 && bm.ext.saveAdvVs.join() === 'Stunned,Paralyzed', 'Indomitable and Advantage against named conditions');
    expect(ba(/with Trip Attack/) && ba(/with Trip Attack/).ext.resource === 'Superiority Dice' && ba(/^Riposte/).ext.riposte.bonus === '1d8' && ba(/^Riposte/).ext.resource, 'maneuvers spend from the pool, one swing of the routine at a time');
    {
      const g = Parser.parse('Vor\nMedium Humanoid, Neutral\nAC 15\nHP 60 (8d8 + 24)\nSpeed 30 ft.\nCR 4 (XP 1,100; PB +2)\nActions\nBlood Grasp (Recharge 5–6). Strength Saving Throw: DC 14, each enemy in a 20-foot Cube originating from Vor. Failure: 13 (3d8) Necrotic damage. Success: Half damage.').monsters[0].actions.find(a => /Grasp/.test(a.name));
      expect(g && g.ext.area.shape === 'emanation' && g.ext.area.square && g.ext.area.size === 10, 'a cube originating from the creature is a square around it');
    }
    expect(ba(/Action Surge/).ext.extraAction && ba(/Battle Fury/).buff.damage === '1d8' && ba(/Battle Fury/).ext.speedBonus === 10 && ba(/^Brace/).ext.brace && ba(/Spellguard/).ext.spellbreaker, 'Action Surge, a timed self-buff, Brace and a spell-blunting reaction');
    const mon = JSON.parse(JSON.stringify(bm)); mon.id = 'bm'; mon.mode = 'custom'; mon.actions.forEach((a, i) => { a.id = 'bm' + i; });
    const seen = {};
    for (let i = 0; i < 6; i++) for (const r of Tac.runDay({ players: fixture('worms-day.json').players, encounters: [{ monsters: [mon] }] }, { seed: 70 + i, partyAI: 'tactical', record: true }))
      for (const e of r.events) for (const [k, re] of [['surge', /uses Action Surge/], ['riposte', /ripostes/], ['trip', /with Trip Attack/], ['indom', /uses Indomitable/]]) if (re.test(e.text)) seen[k] = 1;
    check(seen.surge && seen.riposte && seen.trip, `the duelist surges, ripostes and trips on the War Table (${Object.keys(seen).join(', ')})`);
  }
  // every parsed creature can fight in both simulators
  const party = fixture('worms-day.json').players;
  let tacErr = 0;
  for (const [f, m] of Object.entries(parsed)) {
    const mon = JSON.parse(JSON.stringify(m)); mon.id = f; mon.mode = 'custom';
    (mon.actions || []).forEach((a, i) => { a.id = f + i; });
    if (mon.ext.spellbook) mon.ext.spellbook.spells.forEach((s, i) => { s.id = f + 's' + i; });
    const day = { players: party, encounters: [{ monsters: [mon] }] };
    try { for (let i = 0; i < 5; i++) Tac.runDay(JSON.parse(JSON.stringify(day)), { seed: 7 + i, partyAI: 'tactical' }); } catch (e) { tacErr++; console.log('  War Table error on', f, e.message); }
  }
  check(tacErr === 0, `${tacErr} parsed creatures broke the War Table`);
  {
    const mon = JSON.parse(JSON.stringify(el)); mon.id = 'elp'; mon.mode = 'custom'; mon.actions.forEach((a, i) => { a.id = 'elp' + i; });
    let cancels = 0, elOA = 0;
    for (let i = 0; i < 4; i++) for (const r of Tac.runDay({ players: party, encounters: [{ monsters: [mon] }] }, { seed: 40 + i, partyAI: 'tactical', record: true }))
      for (const e of r.events) { if (/is cancelled/.test(e.text)) cancels++; if (e.kind === 'oa' && e.uid && e.uid.indexOf('elp') >= 0) elOA++; }
    check(cancels > 0 && elOA === 0, `Elparin voids attacks aimed at him (${cancels}) and never takes opportunity attacks (${elOA})`);
  }
  console.log(`  ${Object.keys(parsed).length} statblocks parsed`);
}

// the level-5 class roster: every build fights, uses what makes it that class, and the class rules hold
{
  section('Level-5 class roster');
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/party.js'), 'utf8') + ';globalThis.CB = CLASS_BUILDS; globalThis.PP = PARTY_PLAYERS;', ctx);
  const CB = ctx.CB;
  check(CB.length === 13 && ctx.PP.length === 6 && new Set(ctx.PP.map(p => p.name)).size === 6, 'thirteen class builds and a six-class default party');
  const fx = fixture('bandit-day.json');
  const seen = {}; let err = 0;
  for (const group of [CB.slice(0, 7), CB.slice(7)]) for (let i = 0; i < 12; i++) {
    let res;
    try { res = Tac.runDay({ players: JSON.parse(JSON.stringify(group)), encounters: JSON.parse(JSON.stringify(fx.encounters)) }, { seed: 300 + i * 13, partyAI: 'tactical', record: true }); } catch (e) { err++; console.log('  ', e.message); continue; }
    for (const r of res) for (const e of r.events) {
      const t = e.text || '';
      if (/Luminous Arrow/.test(t)) seen.arrow = 1;
      if (/Force Ballista/.test(t)) seen.ballista = 1;
      if (/Rage/.test(t)) seen.rage = 1;
      if (/^Fighter →.*\b19 vs AC.*CRIT|^Fighter →.*CRIT/.test(t)) seen.fcrit = (seen.fcrit || 0) + 1;
    }
  }
  check(err === 0, `${err} roster fights threw`);
  check(seen.arrow && seen.ballista && seen.rage, 'Starry Form, Eldritch Cannon and Rage all get used');
  // Rage halves slashing; a Champion crits on a 19
  const barb = { buffs: [{ id: 'r', resist: ['slashing'] }], dmgMods: null };
  check(Tac.damageMultFor({ ext: { damageType: 'slashing' } }, barb) === 0.5 && Tac.damageMultFor({ ext: { damageType: 'fire' } }, barb) === 1, 'a raging barbarian resists slashing, not fire');
  check(CB.find(c => c.name === 'Fighter').ext.critRange === 19, 'the Champion crits on 19–20');
}

// what each side knows: black box and learning play without breaking rules, learning narrows in on the truth,
// and morale lets monsters leave the fight
{
  section('AI knowledge modes and morale');
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/party.js'), 'utf8') + ';globalThis.PP = PARTY_PLAYERS;', ctx);
  const hard = fixture('hard-day.json');
  let err = 0, acOk = 0, acN = 0, hpOk = 0, hpN = 0, fled = 0, actAfterFlee = 0;
  for (const mode of ['blind', 'learn']) for (let i = 0; i < 6; i++) {
    let res, sim;
    const day = { players: JSON.parse(JSON.stringify(ctx.PP)), encounters: JSON.parse(JSON.stringify(hard.encounters)) };
    try { res = Tac.runDay(day, { seed: 500 + i * 31, know: { party: mode, foes: mode }, morale: 'on', record: true, _keep: true }); } catch (e) { err++; console.log('  ', mode, e.stack.split('\n').slice(0, 3).join(' ')); continue; }
    for (const r of res) {
      const gone = new Set();
      for (const e of r.events) {
        if (e.kind === 'flee') { fled++; gone.add(e.uid); }
        else if (e.uid && gone.has(e.uid) && ['attack', 'save', 'aoe', 'move', 'heal'].includes(e.kind)) actAfterFlee++;
      }
    }
    if (mode === 'learn' && res._sim) {
      const S = res._sim;
      for (const [tplId, k] of S.mem.party) {
        const m = hard.encounters.flatMap(e => e.monsters).find(x => x.id === tplId); if (!m) continue;
        if (k.acLo > -Infinity || k.acHi < Infinity) { acN++; if (k.acLo <= m.AC && m.AC <= k.acHi) acOk++; }
        if (k.hpHi < Infinity) { hpN++; if (k.hpLo <= m.hp && m.hp <= k.hpHi) hpOk++; }
      }
    }
  }
  check(err === 0, `${err} black-box / learning days threw`);
  check(acN > 0 && acOk === acN, `learned AC ranges hold the real AC (${acOk}/${acN})`);
  check(hpN > 0 && hpOk === hpN, `learned hit point ranges hold the real hit points (${hpOk}/${hpN})`);
  check(fled > 0 && actAfterFlee === 0, `with morale on, monsters flee (${fled}) and don't act after leaving`);
  // the day's length (leftFor): open and learn know it, blind assumes one, "Fights the party expects today" overrides both
  const left = (mode, expectFights, fightNo, encountersLeft) => {
    const s = new Tac.Sim({ know: { party: mode }, expectFights });
    s.fightNo = fightNo; s.encountersLeft = encountersLeft;
    return s.leftFor({ team: 'party' });
  };
  check(left('learn', undefined, 0, 0) === 0 && left('learn', undefined, 1, 2) === 2 && left('learn', undefined, undefined, 4) === 4, 'learn knows the fights still to come (and the whole day in the morning)');
  check(left('learn', 3, 0, 0) === 2 && left('learn', 3, 2, 0) === 0 && left('learn', 3, 4, 0) === 0 && left('learn', 3, undefined, 1) === 3, 'expected fights override learn');
  check(left('blind', 1, 0, 3) === 0 && left('blind', 4, 1, 0) === 2 && left('open', 1, 0, 3) === 3, 'expected fights set blind; open always knows');
}

// the official SRD 5.2 monsters in the Library: every one parses with its real header and can fight
{
  section('Official SRD 5.2 monsters');
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/srd-monsters.js'), 'utf8') + ';globalThis.M = SRD_MONSTERS; globalThis.A = SRD_ATTRIBUTION;', ctx);
  const party = fixture('worms-day.json').players;
  let bad = 0, err = 0, empty = 0;
  for (const s of ctx.M) {
    const r = Parser.parse(s.text), m = r.monsters[0];
    if (!m || m.name !== s.name || m.AC !== s.ac || m.hp !== s.hp || m.cr !== s.cr) { bad++; console.log('  header mismatch', s.name); continue; }
    if (!m.actions.some(a => a.type === 'atk' && a.actionSlot === 0)) { empty++; console.log('  no attack', s.name); }
    const mon = JSON.parse(JSON.stringify(m)); mon.id = s.id; mon.mode = 'custom';
    mon.actions.forEach((a, i) => { a.id = s.id + i; });
    if (mon.ext.spellbook) mon.ext.spellbook.spells.forEach((x, i) => { x.id = s.id + 's' + i; });
    try { Tac.runDay({ players: party, encounters: [{ monsters: [mon] }] }, { seed: 3, partyAI: 'tactical' }); } catch (e) { err++; console.log('  War Table error on', s.name, e.message); }
  }
  check(ctx.M.length >= 40 && bad === 0, `${ctx.M.length} official monsters read with their real name, AC, HP and CR (${bad} off)`);
  check(empty === 0 && err === 0, `every official monster has an attack and fights (${empty} without, ${err} errors)`);
  check(/System Reference Document 5\.2/.test(ctx.A) && /creativecommons\.org\/licenses\/by\/4\.0/.test(ctx.A), 'the SRD attribution statement ships with them');
}

section('Character sheets');
{
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ['js/spell-data.js', 'js/statblock-parser.js', 'js/sheet-reader.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  const SR = ctx.SheetReader, dir = path.join(__dirname, 'sheets');
  const got = {};
  for (const f of fs.readdirSync(dir)) { try { got[f] = SR.read(fs.readFileSync(path.join(dir, f), 'utf8')).player; } catch (e) { console.log('  ', f, e.message); } }
  const p = got, sp = c => ((c && c.ext.spellbook && c.ext.spellbook.spells) || []).map(s => s.name);
  check(p['typed.txt'] && p['typed.txt'].AC === 18 && p['typed.txt'].hp === 58 && p['typed.txt'].class.level === 6 && p['typed.txt'].actions.some(a => /Longsword ×2/.test(a.name) && a.toHit === 7) && p['typed.txt'].actions.some(a => /Action Surge/.test(a.name)), 'a typed fighter sheet: AC, HP, level, Extra Attack, Action Surge');
  check(p['pdf.txt'] && p['pdf.txt'].name === 'Lyra Vane' && p['pdf.txt'].ext.spellbook.slots.slice(0, 3).join() === '4,3,2' && sp(p['pdf.txt']).includes('Fireball') && sp(p['pdf.txt']).includes('Misty Step'), 'fillable PDF fields: name, wizard slots and spells');
  const rl = p['russianllama.txt'];
  check(rl && rl.name === 'Baruba Ran' && rl.class.type === 'barbarian' && rl.class.level === 7 && rl.AC === 15 && rl.hp === 93 && rl.ext.speed === 40 && rl.ext.saves.str === 8 && rl.ext.saves.con === 6 && rl.ext.saves.int === -1 && rl.ext.resist.includes('cold') && rl.actions.some(a => /Greataxe/.test(a.name) && a.toHit === 8 && /1d12 \+ 5/.test(JSON.stringify(a))), 'a D&D Beyond PDF (form widgets, no AcroForm): name, level, AC, HP, speed, saves, greataxe');
  const notesOf = c => ((c && c._notes) || []).join('\n'), actOf = (c, re) => c && c.actions.find(a => re.test(a.name));
  check(rl && rl.ext.dexSaveAdvantage === true && rl.ext.initAdvantage === true && !rl.ext.brutalCritical && !rl.ext.relentlessRage && /Ancestral Guardian/.test(rl.ext.build)
    && actOf(rl, /^Rage/).freq.uses === 4 && actOf(rl, /^Stone's Endurance/).freq.uses === 3 && actOf(rl, /^Stone's Endurance/).actionSlot === 4 && actOf(rl, /^Stone's Endurance/).buff.damageReduction === '1d12 + 3',
    'PDF page 2 features: Danger Sense, Feral Instinct, Ancestral Guardian path, Rage uses from the sheet, Stone\'s Endurance as a reaction (no Brutal Critical or Relentless Rage at level 7)');
  check(/Used in fights: .*Danger Sense.*Feral Instinct/.test(notesOf(rl)) && /Barbarian features \(no fight rules\): .*Ancestral Protectors.*Spirit Shield/.test(notesOf(rl)) && /Goliath species traits \(no fight rules\): .*Little Giant.*Mountain Born/.test(notesOf(rl)) && !/PHB|Little Giant •|As a bonus action/.test(notesOf(rl)),
    'PDF page 2 features the sim cannot use are name-only notes grouped by section');
  check(/Weapons in the pack[^\n]*: Javelin ×4\./.test(notesOf(rl)) && !rl.actions.some(a => /Javelin/.test(a.name)) && /Magic items[^\n]*Cloak of the Manta Ray, Potion of Water Breathing ×2/.test(notesOf(rl)) && /Other gear: Backpack;[^\n]*Rations \(1 day\) ×20;[^\n]*10 gp\./.test(notesOf(rl)) && !/Greataxe/.test(notesOf(rl)) && rl.AC === 15,
    'PDF page 2 inventory: pack javelins without a bonus stay notes, duplicates merge, one gear line with coins, AC stays as stated');
  const b11 = p['barbarian11.txt'];
  check(b11 && b11.ext.brutalCritical === 1 && b11.ext.relentlessRage.hp === 22 && /Berserker/.test(b11.ext.build) && /Healing potions[^\n]*Potion of Healing ×2/.test(notesOf(b11)) && /Armor and shields[^\n]*Breastplate, Shield/.test(notesOf(b11)) && b11.AC === 15 && !/Potion of Healing/.test(JSON.stringify(b11.actions)),
    'a level-11 barbarian sheet: Brutal Critical, Relentless Rage, healing potions and armor as notes only');
  {
    // Relentless Rage: a raging barbarian dropped to 0 sometimes stays up on 2 × level HP; one at level 7 never does
    const run = c => { let n = 0; for (let i = 0; i < 40; i++) for (const r of Tac.runDay({ players: [Object.assign(JSON.parse(JSON.stringify(c)), { hp: 12 })], encounters: [{ monsters: [{ id: 'og', name: 'Ogre', mode: 'custom', hp: 200, AC: 11, saveBonus: 0, count: 2, actions: [{ id: 'og1', name: 'Greatclub', actionSlot: 0, freq: 'at will', condition: 'default', targets: 1, type: 'atk', dpr: '2d8 + 4', toHit: 8, target: 'enemy with least HP', ext: { range: 5 } }] }] }] }, { seed: 100 + i, partyAI: 'tactical', record: true })) n += r.events.filter(e => /Relentless Rage keeps it up/.test(e.text || '')).length; return n; };
    const k = run(b11), k7 = run(rl);
    check(k > 0 && k7 === 0, `Relentless Rage keeps a raging barbarian up sometimes (${k} times at level 11, ${k7} at level 7)`);
  }
  check(p['ddbcopy.txt'] &&p['ddbcopy.txt'].ext.sneakAttack.dice === '2d6' && p['ddbcopy.txt'].ext.spellbook.slotReset === 'sr' && /\+ 3/.test(p['ddbcopy.txt'].ext.spellbook.spells[0].dpr), 'a pasted rogue/warlock: sneak attack, pact slots, Agonizing Blast');
  {
    // page layout: a value printed above its caption, a title with its value under it, a bonus left of its label
    const it = (str, x, y, w, h) => ({ str, x, y, w, h });
    const page = [it('NIKO ARIS', 36, 759, 49, 10), it('NAME', 36, 744, 20, 7), it('Wayfarer', 27, 732, 32, 8), it('BACKGROUND', 27, 720, 48, 7),
      it('SPEED', 300, 700, 28, 8), it('30 ft.', 300, 688, 22, 8), it('STRENGTH', 46, 559, 44, 8), it('-1', 45, 523, 13, 16), it('MODIFIER', 35, 501, 32, 7),
      it('8', 80, 520, 9, 13), it('SCORE', 73, 504, 23, 7), it('Saving Throw', 44, 482, 48, 8), it('-1', 33, 483, 6, 8), it('Dagger Melee', 253, 563, 42, 7), it('+', 331, 563, 3, 7), it('5', 334, 563, 4, 7)];
    const lt = ctx.SheetReader.layoutText([page]);
    check(lt.slice(0, 4).join('|') === 'Name: NIKO ARIS|Background: Wayfarer|Speed: 30 ft.|Strength Modifier: -1' && lt.includes('Strength Score: 8') && lt.includes('Strength Saving Throw: -1') && lt.includes('Dagger Melee  +5'),
      'PDF page layout pairs a value above its caption, a title with the value under it and a bonus beside its label, and joins "+" and "5" into "+5"');
  }
  const nk = p['niko-roll20.txt'], tc = p['tacitus-roll20.txt'];
  check(nk && nk.name === 'Niko Aris' && nk.class.type === 'warlock' && nk.class.level === 5 && nk.AC === 13 && nk.hp === 38 && nk.ext.speed === 30 && nk.ext.saves.wis === 4 && nk.ext.saves.cha === 7 && nk.ext.saves.int === 0
    && nk.ext.resist.join() === 'necrotic,radiant' && nk.ext.luck === 3 && !nk.ext.unarmored && /Pact of the Celestial/.test(nk.ext.build) && !/No score found|No hit points|No AC/.test(notesOf(nk)),
    'a Roll20 2024 sheet (Niko, warlock 5): name, level, AC, HP, speed, saves, resistances, Lucky; nothing guessed');
  check(nk && nk.ext.spellbook.slots.join() === '0,0,2,0,0,0,0,0,0' && nk.ext.spellbook.slotReset === 'sr' && ['Eldritch Blast', 'Hex', 'Misty Step', 'Silvery Barbs', 'Mind Spike', 'Armor of Agathys'].every(n => sp(nk).includes(n)) && !sp(nk).includes('Witch Bolt') && !sp(nk).includes('Shield')
    && nk.ext.spellbook.spells.find(s => s.name === 'Eldritch Blast').dpr === '1d10 + 4' && nk.ext.spellbook.spells.find(s => s.name === 'Eldritch Blast').targets === 2 && nk.ext.spellbook.spells.find(s => s.name === 'Mind Spike').toHit === 15,
    'Niko: two pact slots of level 3 that come back on a short rest, spells from the spell table only, two Agonizing Eldritch Blast beams');
  check(nk && actOf(nk, /^Healing Light/).ext.pool.dice === 6 && actOf(nk, /^Healing Light/).ext.pool.maxPer === 4 && actOf(nk, /^Healing Hands/).amount === '3d4' && actOf(nk, /^Celestial Revelation/).buff.damage === '3' && actOf(nk, /^Dagger Melee/).toHit === 5
    && /Class features \(no fight rules\): [^\n]*Magical Cunning/.test(notesOf(nk)) && /Armor and shields[^\n]*Leather Armor/.test(notesOf(nk)) && /Other gear: [^\n]*Rations ×50/.test(notesOf(nk)) && /70 gp/.test(notesOf(nk)),
    'Niko: Healing Light as a pool of 6 d6 (4 per use), Healing Hands, Celestial Revelation, daggers; invocations, armor, gear and coins as notes');
  check(tc && tc.name === 'Tacitus Sicarius' && tc.class.type === 'rogue' && tc.class.level === 5 && tc.AC === 15 && tc.hp === 38 && tc.ext.speed === 35 && tc.ext.initBonus === 7 && tc.ext.saves.dex === 7 && tc.ext.saves.int === 3 && !tc.ext.unarmored && /Assassin/.test(tc.ext.build)
    && tc.ext.sneakAttack.dice === '3d6' && tc.ext.sneakAttack.assassinate === 5 && tc.ext.assassinate === true && tc.ext.initAdvantage === true && tc.ext.steadyAim === true && tc.ext.elvenAccuracy === true && tc.ext.bonusDisengage === true,
    'a Roll20 2024 sheet (Tacitus, rogue 5): name, level, AC, HP, speed, initiative, saves, Sneak Attack, Assassinate, Steady Aim, Elven Accuracy');
  check(tc && actOf(tc, /^Rapier/).toHit === 7 && actOf(tc, /^Rapier/).ext.onHit.vex === true && actOf(tc, /^Shortbow/).ext.range === 80 && actOf(tc, /^Dagger \(Thrown\)/).ext.range === 20 && actOf(tc, /^Pressurized Flame Squirter/).ext.range === 30 && actOf(tc, /^Pressurized Flame Squirter/).toHit === 7
    && actOf(tc, /^Cunning Action: Hide/) && actOf(tc, /^Uncanny Dodge/) && actOf(tc, /^Assassinate/) && /Used in fights: [^\n]*Steady Aim/.test(notesOf(tc)) && /Armor and shields[^\n]*Leather Armor/.test(notesOf(tc)) && /Not in its spell list[^\n]*Longstrider/.test(notesOf(tc)),
    'Tacitus: Rapier +7 with Vex, bow and thrown ranges, the Squirter as a 30-ft ranged weapon, Cunning Action, Uncanny Dodge; unmodeled spells and gear as notes');
  check(p['ddb.json'] && p['ddb.json'].AC === 18 && p['ddb.json'].hp === 46 && p['ddb.json'].ext.saves.cha === 6 && p['ddb.json'].ext.spellbook.slots.slice(0, 2).join() === '4,2' && !sp(p['ddb.json']).includes('Command'), 'a D&D Beyond JSON paladin: AC from armor, HP, saves, prepared spells only');
  check(p['foundry.json'] && p['foundry.json'].AC === 15 && p['foundry.json'].actions.some(a => /Longbow/.test(a.name) && a.ext.range === 150 && !a.ext.wtOnly), 'a Foundry VTT ranger: AC and the bow as the main attack');
  const kr = p['kraax-ddb.json'], ka = n => kr && kr.actions.find(a => n.test(a.name));
  check(kr && kr.AC === 16 && kr.hp === 30 && kr.ext.speed === 40 && kr.ext.initBonus === 6 && kr.ext.size === 'Small' && kr.ext.resources['Focus Points'].uses === 4 && ka(/^Flurry/).ext.resource === 'Focus Points' && ka(/^Elemental Strikes/).ext.range === 15, 'Kraax from D&D Beyond: Alert, unarmored movement, Focus Points spent by Flurry, Elemental Strikes');
  {
    let flurries = 0, maxSpent = 0;
    for (let i = 0; i < 6; i++) for (const r of Tac.runDay({ players: [JSON.parse(JSON.stringify(kr))], encounters: [{ monsters: [{ id: 'og', name: 'Ogre', mode: 'custom', hp: 90, AC: 11, saveBonus: 0, count: 1, actions: [{ id: 'og1', name: 'Greatclub', actionSlot: 0, freq: 'at will', condition: 'default', targets: 1, type: 'atk', dpr: '1d8 + 2', toHit: 4, target: 'enemy with least HP', ext: { range: 5 } }] }] }] }, { seed: 21 + i, partyAI: 'tactical', record: true })) {
      let n = 0; for (const e of r.events) if (/Kraax.*(Flurry|Patient Defense|Elemental Attunement)/.test(e.text || '') && /^Kraax/.test(e.text || '') && !/→.*Flurry/.test('')) n++;
      flurries += n; maxSpent = Math.max(maxSpent, n);
    }
    check(flurries > 0 && maxSpent <= 8, `Focus Points get spent and run out (${flurries} uses, at most ${maxSpent} in a fight)`);
  }
  let err = 0;
  const party = Object.values(got);
  for (let i = 0; i < 4; i++) try { Tac.runDay({ players: JSON.parse(JSON.stringify(party)), encounters: [{ monsters: [{ id: 'og', name: 'Ogre', mode: 'custom', hp: 68, AC: 11, saveBonus: 0, count: 2, actions: [{ id: 'og1', name: 'Greatclub', actionSlot: 0, freq: 'at will', condition: 'default', targets: 1, type: 'atk', dpr: '2d8 + 4', toHit: 6, target: 'enemy with least HP', ext: { range: 5 } }] }] }] }, { seed: 11 + i, partyAI: 'tactical' }); } catch (e) { err++; console.log('  ', e.message); }
  check(err === 0, `characters read from sheets fight on the War Table (${err} errors)`);
}

// AI v2 (docs/ai-v2.md): non-casters and full casters on v2, half casters on the old AI in the same fight; the martial
// features, pacing, profiles and knowledge modes; then the casters. The rule checks (walls, the dead, hiding, odds) run
// above as the "v2 AI" sections, and again below for caster-heavy days.
{
  section('AI v2 (non-casters)');
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/party.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'data/srd-monsters.js'), 'utf8') +
    ';globalThis.CB = CLASS_BUILDS; globalThis.PP = PARTY_PLAYERS; globalThis.M = SRD_MONSTERS;', ctx);
  const cp = x => JSON.parse(JSON.stringify(x));
  const pc = n => cp(ctx.CB.find(c => c.name === n));
  const srd = (name, count) => {
    const s = ctx.M.find(m => m.name === name), m = cp(Parser.parse(s.text).monsters[0]);
    m.id = s.id; m.mode = 'custom'; m.count = count || 1; m.actions.forEach((a, i) => { a.id = s.id + i; });
    if (m.ext.spellbook) m.ext.spellbook.spells.forEach((x, i) => { x.id = s.id + 's' + i; });
    return m;
  };
  const martials = () => ['Barbarian', 'Fighter', 'Monk', 'Rogue'].map(pc);
  const hard = fixture('hard-day.json');
  let err = 0;
  const run = (day, opts) => { try { return Tac.runDay(day, opts); } catch (e) { err++; console.log('  ', e.stack.split('\n').slice(0, 3).join(' ')); return []; } };

  // one fight, both AIs: the default party's Fighter and Rogue on v2, its casters on the old AI
  const mixed = run({ players: cp(ctx.PP), encounters: cp(hard.encounters) }, { seed: 77, ai: 'v2', record: true, _keep: true });
  const S = mixed._sim, by = n => S && S.units.find(u => u.name === n);
  check(S && ['Fighter', 'Rogue', 'Wizard', 'Cleric', 'Bard'].every(n => by(n).v2) && !by('Paladin').v2, 'v2 drives the Fighter, Rogue and the full casters; the Paladin (a half caster) keeps the old AI');
  check(mixed.some(r => r.events.some(e => e.kind === 'attack' && /^Fighter →/.test(e.text))) && mixed.some(r => r.events.some(e => /^Wizard → .*(Fire Bolt|Magic Missile|Fireball|Ray of Frost|Scorching|Lightning|Burning|Shocking)/.test(e.text))), 'both act in the same fights');
  const plain = run({ players: cp(ctx.PP), encounters: cp(hard.encounters) }, { seed: 77, _keep: true });
  check(plain._sim && plain._sim.units.every(u => !u.v2), 'without the flag nobody uses v2');

  // the martial roster: Rage, Reckless each turn, Action Surge, Stunning Strike / Flurry, Sneak Attack, Second Wind
  const seen = {};
  for (let i = 0; i < 10; i++) for (const r of run({ players: martials(), encounters: cp(fixture('bandit-day.json').encounters) }, { seed: 300 + i * 13, ai: { party: 'v2' }, record: true })) {
    let reckless = 0;
    for (const e of r.events) {
      const t = e.text || '';
      if (/^Barbarian: Rage$/.test(t)) seen.rage = 1;
      if (/^Barbarian: Reckless Attack$/.test(t)) reckless++;
      if (/^Fighter → .*Action Surge/.test(t)) seen.surge = 1;
      if (/^Monk → .*(Stunning Strike|Flurry of Blows)/.test(t)) seen.monk = 1;
      if (/^Rogue → .*Sneak Attack/.test(t)) seen.sneak = 1;
    }
    if (reckless > 1) seen.recklessTurns = 1;     // applied turn by turn, not once for the fight
  }
  check(seen.rage && seen.surge && seen.monk && seen.sneak && seen.recklessTurns, `v2 uses Rage, Reckless Attack turn by turn, Action Surge, the Monk's features and Sneak Attack (${Object.keys(seen).join(', ')})`);

  // pacing: three easy fights then a hard one; the Barbarian still has a Rage for the boss
  let boss = 0, bossDays = 0;
  for (let i = 0; i < 8; i++) {
    const res = run({ players: martials(), encounters: [0, 1, 2].map(() => ({ monsters: [srd('Goblin Warrior', 3)] })).concat([{ monsters: [srd('Troll'), srd('Ogre')] }]) }, { seed: 900 + i * 7919, ai: { party: 'v2' }, record: true });
    if (res.length === 4) { bossDays++; if (res[3].events.some(e => /^Barbarian: Rage$/.test(e.text))) boss++; }
  }
  check(bossDays > 0 && boss === bossDays, `v2 paces Rage over the day: raged at the boss on ${boss} of ${bossDays} days`);

  // a Goliath's Stone's Endurance (3 a day) waits for a hit worth it
  const goliath = pc('Fighter');
  goliath.actions.push({ id: 'g-stone', name: "Stone's Endurance", actionSlot: 4, freq: { reset: 'lr', uses: 3 }, condition: 'default', targets: 1, type: 'buff', target: 'self', buff: { duration: 'until next attack taken', damageReduction: '1d12 + 3' } });
  let small = 0, uses = 0;
  for (let i = 0; i < 6; i++) for (const r of run({ players: [cp(goliath), pc('Rogue')], encounters: [{ monsters: [srd('Goblin Warrior', 10)] }, { monsters: [srd('Ogre', 3)] }] }, { seed: 50 + i * 7919, ai: { party: 'v2' }, record: true }))
    for (const e of r.events) { const m = e.kind === 'react' && /Stone's Endurance \((\d+) →/.exec(e.text); if (m) { uses++; if (+m[1] < 7) small++; } }
  check(uses > 0 && small === 0, `Stone's Endurance is kept for real hits (${uses} uses, ${small} on hits under 7)`);

  // no Dodge-crawling toward archers: the Monk dashes in instead
  let crawl = 0;
  for (let i = 0; i < 6; i++) for (const r of run({ players: [pc('Monk'), pc('Rogue')], encounters: [{ monsters: [srd('Goblin Warrior', 6)] }] }, { seed: 60 + i * 7919, ai: { party: 'v2' }, record: true, layouts: { 0: { gapFt: 60 } } }))
    crawl += r.events.filter(e => e.kind === 'buff' && /^Monk .*Dodg/.test(e.text)).length;
  check(crawl <= 1, `the Monk closes on archers without Dodge-crawling (${crawl} Dodge turns)`);

  // profiles: plain data, merged over a preset; ext.aiProfile opts a monster in and Reckless 'always' holds
  check(['balanced', 'aggressive', 'cautious', 'protector', 'assassin', 'berserker', 'skirmisher'].every(k => Tac.AI_PROFILES[k]) &&
    JSON.stringify(JSON.parse(JSON.stringify(Tac.AI_PROFILES))) === JSON.stringify(Tac.AI_PROFILES), 'seven presets, all plain serializable data');
  const mp = Tac.aiProfile({ base: 'cautious', w: { risk: 2 } });
  check(mp.w.risk === 2 && mp.w.oa === Tac.AI_PROFILES.cautious.w.oa && Tac.AI_PROFILES.cautious.w.risk !== 2 && Tac.aiProfile('nonsense') === Tac.AI_PROFILES.balanced, 'a profile override merges over its preset without changing it');
  const ogre = srd('Ogre');
  const prof = run({ players: martials(), encounters: [{ monsters: [Object.assign(cp(ogre), { ext: Object.assign({}, ogre.ext, { aiProfile: 'berserker' }) }), cp(ogre)] }] }, { seed: 5, ai: 'v2', _keep: true });
  const ogres = prof._sim ? prof._sim.units.filter(u => u.team === 'foes') : [];
  check(ogres.length === 2 && ogres[0].v2 && ogres[0].v2P.reckless === 'always' && !ogres[1].v2, 'ext.aiProfile puts a regular monster on v2; the one without stays on its own AI');
  const berserk = pc('Barbarian'); berserk.ext.aiProfile = 'berserker';
  let swingTurns = 0, recklessTurns = 0;
  for (let i = 0; i < 4; i++) for (const r of run({ players: [berserk, pc('Fighter')], encounters: [{ monsters: [srd('Ogre', 2)] }] }, { seed: 70 + i, ai: { party: 'v2' }, record: true })) {
    let turn = false, swung = false, rk = false;
    const flush = () => { if (turn && swung) { swingTurns++; if (rk) recklessTurns++; } };
    for (const e of r.events) {
      if (e.kind === 'turn') { flush(); turn = /^Barbarian's turn/.test(e.text); swung = rk = false; }
      else if (turn && /^Barbarian → .*Greataxe/.test(e.text)) swung = true;
      else if (turn && /^Barbarian: Reckless Attack$/.test(e.text)) rk = true;
    }
    flush();
  }
  check(swingTurns > 0 && recklessTurns === swingTurns, `a berserker profile is Reckless on every melee turn (${recklessTurns}/${swingTurns})`);

  // knowledge modes: v2 reads the other side only through the k* estimates and runs blind and learning
  for (const mode of ['blind', 'learn']) for (let i = 0; i < 3; i++) run({ players: cp(ctx.PP).concat(martials()), encounters: cp(hard.encounters) }, { seed: 400 + i, ai: 'v2', know: { party: mode, foes: mode }, morale: 'on' });
  check(err === 0, `${err} v2 days threw`);

  section('AI v2 (casters)');
  // who counts as a caster
  const kinds = Object.fromEntries(ctx.CB.map(c => [c.name, Tac.casterKind(c)]));
  const ek = pc('Fighter'); ek.ext.spellbook = cp(pc('Wizard').ext.spellbook);
  const mageTpl = Parser.parse(fs.readFileSync(path.join(__dirname, 'statblocks', 'mage-2014.txt'), 'utf8')).monsters[0];
  mageTpl.id = 'mage'; mageTpl.mode = 'custom'; mageTpl.actions.forEach((a, i) => { a.id = 'mage' + i; }); mageTpl.ext.spellbook.spells.forEach((x, i) => { x.id = 'mages' + i; });
  check(['Wizard', 'Sorcerer', 'Warlock', 'Cleric', 'Druid', 'Bard'].every(n => kinds[n] === 'full') && ['Paladin', 'Ranger', 'Artificer'].every(n => kinds[n] === 'half') &&
    ['Fighter', 'Rogue', 'Monk', 'Barbarian'].every(n => kinds[n] === 'none') && Tac.casterKind(ek) === 'third' && Tac.casterKind(mageTpl) === 'full' &&
    Tac.casterKind(Object.assign(cp(ek), { ext: Object.assign({}, ek.ext, { casterKind: 'full' }) })) === 'full', `caster kinds (${JSON.stringify(kinds)})`);
  // full casters, half casters and martials in one fight; a spellbook monster on v2 too
  const actedBy = new Set();
  let MS = null;
  for (let i = 0; i < 4; i++) {
    const mix = run({ players: ['Fighter', 'Wizard', 'Cleric', 'Paladin', 'Ranger'].map(pc), encounters: [{ monsters: [Object.assign(cp(mageTpl), { count: 2 }), srd('Guard', 3)] }] }, { seed: 3 + i, ai: 'v2', record: true, _keep: true });
    MS = mix._sim;
    for (const r of mix) for (const e of r.events) if (['attack', 'save', 'heal', 'buff', 'aoe'].includes(e.kind)) { const u = MS.units.find(x => x.uid === e.uid); if (u) actedBy.add(u.name.replace(/ \d+$/, '')); }
  }
  const unit = n => MS.units.find(u => u.name === n);
  check(MS && ['Fighter', 'Wizard', 'Cleric'].every(n => unit(n).v2) && ['Paladin', 'Ranger'].every(n => !unit(n).v2) && unit('Mage 1').v2,
    'full casters and a spellbook monster on v2, the Paladin and Ranger on the old AI, in one fight');
  check(['Wizard', 'Cleric', 'Paladin', 'Ranger', 'Mage'].every(n => actedBy.has(n)), `they all act (${[...actedBy].join(', ')})`);

  // spend honours the slot level v2 picked; without it, the lowest free slot (the old rule)
  const wz = Tac.expandTeam([pc('Wizard')], 'party', true)[0], mm = wz.actions.find(a => /Magic Missile/.test(a.name));
  const sim0 = new Tac.Sim({ seed: 1 });
  wz.castAt = 3; sim0.spend(wz, mm);
  const at3 = wz.slots.join(','), lvl3 = wz.castLevel;
  sim0.spend(wz, mm);
  check(at3 === '4,3,1,0,0,0,0,0,0' && lvl3 === 3 && wz.slots.join(',') === '3,3,1,0,0,0,0,0,0' && !wz.castAt, `a chosen slot level is spent, then the default again (${at3} → ${wz.slots.join(',')})`);
  // Legendary Resistance as each side knows it
  const gl = srd('Gladiator'); gl.ext.legendaryResistance = 3;
  const kS = new Tac.Sim({ seed: 1, know: { party: 'blind' } });
  const lrBoss = Tac.expandTeam([gl], 'foes', false)[0], hero = Tac.expandTeam([pc('Wizard')], 'party', true)[0];
  const blind0 = kS.kLegRes(hero, lrBoss); lrBoss.legSeen = 1; lrBoss.uses.set('__legres', 2);
  check(new Tac.Sim({ seed: 1 }).kLegRes(hero, lrBoss) === 2 && blind0 === 0 && kS.kLegRes(hero, lrBoss) === 2, 'kLegRes: the real count in open mode; unseen, then counted down once used, when blind');
  // step 2.9: no guess from size. A Huge unknown has none as far as blind and learn can tell; one use seen means the usual three less the uses seen
  // (learn remembers it for the kind)
  const dr = srd('Adult Red Dragon'); dr.ext.legendaryResistance = 3;
  const bigFoe = Tac.expandTeam([dr], 'foes', false)[0], bigFoe2 = Tac.expandTeam([dr], 'foes', false)[0];
  const lS = new Tac.Sim({ seed: 1, know: { party: 'learn' } }), g0 = kS.kLegRes(hero, bigFoe), l0 = lS.kLegRes(hero, bigFoe);
  bigFoe.legSeen = 1; lS.kind('party', bigFoe).legRes = 1;
  check(g0 === 0 && l0 === 0 && kS.kLegRes(hero, bigFoe) === 2 && lS.kLegRes(hero, bigFoe) === 2 && lS.kLegRes(hero, bigFoe2) === 3 && new Tac.Sim({ seed: 1 }).kLegRes(hero, bigFoe) === 3,
    `kLegRes: a Huge unknown is not assumed to have any (${g0}, ${l0}); after a use, 3 less the uses seen; open reads the real count`);
  // step 2.7: a boss's HP in learn mode starts from a boss prior and gives way to what was seen; immunities are known when open or once seen
  {
    const lS2 = new Tac.Sim({ seed: 1, know: { party: 'learn' } }), bS = new Tac.Sim({ seed: 1, know: { party: 'blind' } });
    const dr2 = Tac.expandTeam([srd('Adult Red Dragon')], 'foes', false)[0];
    const h0 = lS2.kBossHp(hero, dr2), flat = lS2.kHp(hero, dr2), blindHp = bS.kBossHp(hero, dr2), blindFlat = bS.kHp(hero, dr2);
    dr2.visLost = 150; lS2.kind('party', dr2).hpLo = 151;
    const h1 = lS2.kBossHp(hero, dr2);
    check(h0 > flat && h0 === 225 && blindHp === blindFlat && h1 < h0 && h1 > 120, `kBossHp: learn starts from the boss prior (${h0} vs flat ${flat}), blind keeps the flat one, damage seen brings it down (${Math.round(h1)})`);
    dr2.condImmune = ['paralyzed'];
    const im = [new Tac.Sim({ seed: 1 }).kImmune(hero, dr2, 'Paralyzed'), bS.kImmune(hero, dr2, 'Paralyzed'), lS2.kImmune(hero, dr2, 'Paralyzed')];
    dr2.seenImmune = ['paralyzed'];
    check(im[0] === true && im[1] === false && im[2] === false && lS2.kImmune(hero, dr2, 'Paralyzed') === true, 'kImmune: the sheet when open, nothing when blind, learned once seen');
  }

  // burn the dragon's Legendary Resistance or race its HP (docs/ai-v2.md): the plan follows the numbers
  {
    const dragon = (lr, wis) => { const d = srd('Adult Red Dragon'); d.ext.legendaryResistance = lr; d.ext.fly = 0; d.ext.saves = Object.assign({}, d.ext.saves, wis === 'all' ? { str: 14, dex: 14, con: 14, int: 14, wis: 14, cha: 14 } : { wis }); d.actions.forEach(a => { if (a.dpr) a.dpr = String(Math.round(Tac.avgDice(a.dpr) * 0.35)); }); return d; };
    const party = () => {
      const w = pc('Wizard'), hm = cp(w.ext.spellbook.spells.find(s => s.name === 'Hold Person')), c = pc('Cleric'), cmd = cp(pc('Paladin').ext.spellbook.spells.find(s => s.name === 'Command'));
      hm.name = 'Hold Monster'; hm.level = 5; hm.id = 'hm'; delete hm.ext.targetTypes; w.ext.spellbook.spells.push(hm); w.ext.spellbook.slots[4] = 1;
      cmd.id = 'cmd'; c.ext.spellbook.spells.push(cmd);
      return [pc('Fighter'), pc('Barbarian'), w, c];
    };
    const tally = (boss, bias) => {
      const t = { burn: 0, race: 0, lr: 0, n: 6 };
      for (let i = 0; i < t.n; i++) {
        const pl = party(); if (bias !== undefined) pl.forEach(p => { p.ext.aiProfile = { burn: { bias } }; });
        for (const r of run({ players: pl, encounters: [{ monsters: [boss()] }] }, { seed: 900 + i * 13, ai: { party: 'v2' }, record: true })) {
          if (r.events.some(e => e.kind === 'intent' && /wants the party to burn/.test(e.text))) t.burn++;
          if (r.events.some(e => e.kind === 'intent' && /reckons the party should race/.test(e.text))) t.race++;
          t.lr += r.events.filter(e => /uses Legendary Resistance/.test(e.text || '')).length;
        }
      }
      return t;
    };
    const weak = tally(() => dragon(3, -1)), tough = tally(() => dragon(3, 'all')), off = tally(() => dragon(3, -1), 0), forced = tally(() => dragon(3, -1), 30);
    check(weak.burn >= 3 && weak.lr >= weak.n * 0.5, `a dragon with a poor Wisdom save: the party plans a burn (${weak.burn}/${weak.n} days) and burns Legendary Resistance (${weak.lr} uses)`);
    check(tough.burn === 0 && tough.race === tough.n && tough.lr === 0, `high saves all round: it races, nothing is burned (${JSON.stringify(tough)})`);
    check(off.burn === 0 && off.lr < forced.lr, `burn.bias 0 never plans a burn (${off.lr} uses against ${forced.lr} when forced)`);
  }

  // caster-heavy days on v2: the same rule checks as above, slots never below zero, little friendly fire, sane odds
  const cday = () => ({ players: ['Fighter', 'Wizard', 'Cleric', 'Sorcerer', 'Bard', 'Druid', 'Warlock'].map(pc),
    encounters: [{ monsters: [srd('Goblin Warrior', 8)] }, { monsters: [srd('Ogre', 2), srd('Bandit', 3)], shortRest: true }, { monsters: [Object.assign(cp(mageTpl), { count: 2 }), srd('Guard', 3)] }] });
  for (const layout of [null, walled]) {
    const acc = { wallSteps: 0, throughWalls: 0, deadActs: 0, incapActs: 0, badHide: 0, events: 0 }, runs = [];
    let negSlots = 0, ff = 0, days = 0;
    for (let i = 0; i < 12; i++) {
      const res = run(cday(), { seed: 700 + i * 7919, ai: 'v2', record: true, layouts: layout ? { 0: layout, 1: layout, 2: layout } : undefined });
      runs.push({ seed: 700 + i * 7919, res }); days++;
      for (const r of res) {
        scanRules(r, layout, acc);
        for (const e of r.events) {
          for (const k in e.state || {}) if (e.state[k].slots && /(^|\s)-/.test(e.state[k].slots)) negSlots++;
          const m = e.kind === 'aoe' && r.units.some(u => u.uid === e.uid && u.team === 'party') && /\((\d+) of them on its own side\)/.exec(e.text);
          if (m) ff += +m[1];
        }
      }
    }
    const Sx = Tac.summarize(cday(), runs, { partyAI: 'tactical' });
    check(acc.wallSteps === 0 && acc.throughWalls === 0 && acc.deadActs === 0 && acc.badHide === 0, `casters on v2, ${layout ? 'walled map' : 'open field'}: ${acc.wallSteps} wall steps, ${acc.throughWalls} shots through walls, ${acc.deadActs} acts by the dead, ${acc.badHide} bad hides`);
    check(negSlots === 0, `${negSlots} negative slot counts`);
    check(ff <= days * 0.5, `friendly fire from area spells stays rare (${ff} allies caught in ${days} days)`);
    check(Sx.encounters.every(e => e.winRate >= 0 && e.winRate <= 1 && e.anyDeath >= 0 && e.anyDeath <= 1), 'caster odds are probabilities');
  }

  // what the caster terms are for (tests/ai-compare.js has the old-vs-v2 numbers)
  let fodder = 0, lr = 0, stacked = 0, dropped = 0, fire = 0, hold = 0, misty = 0;
  const walkR = (r, fn) => { let prev = {}; for (const e of r.events) { const cur = Object.assign({}, prev); for (const k in e.state || {}) cur[k] = Object.assign({}, prev[k] || {}, e.state[k]); fn(e, prev); prev = cur; } };
  for (let i = 0; i < 8; i++) {
    // an easy opener before ogres: the 2nd-level and higher slots wait, the cantrips do the work
    const d1 = run({ players: ['Fighter', 'Wizard', 'Cleric', 'Bard'].map(pc), encounters: [{ monsters: [srd('Goblin Warrior', 3)] }, { monsters: [srd('Ogre', 2)] }] }, { seed: 40 + i * 7919, ai: { party: 'v2' }, record: true });
    if (d1[0]) fodder += d1[0].events.filter(e => e.kind !== 'intent' && /^(Wizard|Cleric|Bard) (→ [^:]*: [^,]*\(L[2-9]\)|unleashes [^,]*\(L[2-9]\))/.test(e.text || '')).length;
    if (d1[0] && d1[0].events.some(e => e.kind === 'intent' && /holds its spell slots/.test(e.text))) hold++;
    // a boss with Legendary Resistance and a good Wisdom save: no Hold Person into it
    const g2 = srd('Gladiator'); g2.ext.legendaryResistance = 3;
    const d2 = run({ players: ['Fighter', 'Wizard', 'Cleric', 'Bard'].map(pc), encounters: [{ monsters: [g2, srd('Bandit', 2)] }] }, { seed: 50 + i * 7919, ai: { party: 'v2' }, record: true });
    // (a control spell is a save with no damage: "— affected" / "— saved"; damage saves can burn a use too, and that's fine)
    if (d2[0]) walkR(d2[0], (e, prev) => { if (e.kind === 'save' && /^(Wizard|Cleric|Bard) → Gladiator[^:]*: .*, DC \d+ \w+ — (auto-fails, )?(affected|saved)/.test(e.text) && !/damage/.test(e.text) && prev[e.target] && /^[1-9]/.test(prev[e.target].legRes || '')) lr++; });
    // a Bard and a Cleric against four ogres: the pattern is kept, nothing is stacked on a disabled ogre
    const d3 = run({ players: ['Cleric', 'Bard', 'Barbarian', 'Fighter'].map(pc), encounters: [{ monsters: [srd('Ogre', 4)] }] }, { seed: 60 + i * 7919, ai: { party: 'v2' }, record: true });
    if (d3[0]) walkR(d3[0], (e, prev) => {
      if (e.kind === 'save' && /^(Bard|Cleric) → Ogre[^:]*: [^,]*, DC \d+ \w+ — (affected|saved)/.test(e.text) && prev[e.target] && (prev[e.target].conds || []).some(c => INCAP.includes(c))) stacked++;
      const held = e.uid && prev[e.uid] && prev[e.uid].conc, now = e.uid && e.state && e.state[e.uid] && e.state[e.uid].conc;
      if (held === 'Hypnotic Pattern' && now && now !== held && Object.keys(prev).some(k => prev[k].hp > 0 && (prev[k].buffs || []).some(b => /Hypnotic Pattern/.test(b[0])))) dropped++;
    });
    // a Sorcerer with Fireball against a crowd says what it's doing
    const d4 = run({ players: ['Fighter', 'Sorcerer'].map(pc), encounters: [{ monsters: [srd('Goblin Warrior', 8)] }] }, { seed: 70 + i * 7919, ai: { party: 'v2' }, record: true });
    if (d4[0] && d4[0].events.some(e => e.kind === 'intent' && /^Sorcerer casts (Fireball|Lightning Bolt) to catch [2-9]/.test(e.text))) fire++;
    // a Wizard with cantrips and Misty Step, between two slow Basilisks: walking off provokes, Disengage costs its action
    const wm = pc('Wizard'); wm.ext.spellbook.spells = wm.ext.spellbook.spells.filter(x => !x.level || /Misty/.test(x.name));
    const bas = srd('Basilisk', 2), mpos = { 'party|c5-wizard|0': { x: 10, y: 8 }, 'party|c5-fighter|0': { x: 3, y: 8 } };
    mpos['foes|' + bas.id + '|0'] = { x: 11, y: 8 }; mpos['foes|' + bas.id + '|1'] = { x: 9, y: 8 };
    const d5 = run({ players: [wm, pc('Fighter')], encounters: [{ monsters: [bas] }] }, { seed: 80 + i * 7919, ai: { party: 'v2' }, record: true, layouts: { 0: { positions: mpos } } });
    if (d5[0] && d5[0].events.some(e => e.kind === 'move' && /^Wizard teleports/.test(e.text))) misty++;
  }
  check(fodder <= 1, `v2 keeps 2nd-level and higher slots off a trivial opener (${fodder} such casts in 8 days)`);
  check(hold >= 4, `…and says it is holding them (${hold} of 8 days)`);
  check(lr <= 1, `v2 doesn't throw save-or-suck into Legendary Resistance (${lr} control spells at the boss in 8 days)`);
  check(stacked <= 1 && dropped <= 1, `v2 keeps a working Hypnotic Pattern and doesn't stack control on a disabled ogre (${dropped} dropped, ${stacked} stacked in 8 days)`);
  check(fire >= 6, `a Sorcerer explains its Fireball against a crowd (${fire} of 8 days)`);
  check(misty >= 5, `a Wizard caught in melee teleports out with Misty Step (${misty} of 8 days)`);
  check(['controller', 'artillery', 'support'].every(k => Tac.AI_PROFILES[k]) && Tac.AI_PROFILES.berserker.w.risk === 0.1 && Tac.AI_PROFILES.balanced.pacing.slot > 0, 'caster presets, and the martial ones unchanged');
  check(err === 0, `${err} v2 days threw`);
}

// Lingering damage (Spirit Guardians, Moonbeam…): a concentration area keeps hurting each round, on the old AI and v2
section('Lingering damage zones');
{
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/party.js'), 'utf8') + ';globalThis.CB = CLASS_BUILDS;', ctx);
  const cp = x => JSON.parse(JSON.stringify(x));
  const only = (cls, spell, slots, hold) => {
    const c = cp(ctx.CB.find(b => b.name === cls)), sp = c.ext.spellbook.spells.find(s => s.name === spell);
    if (hold) sp.ext.hold = hold;
    c.actions = []; c.ext.spellbook.spells = [sp]; c.ext.spellbook.slots = slots; c.hp = c.maxHp = 300;
    return c;
  };
  const dummy = (dmg, save) => ({ id: 'dm', name: 'Dummy', mode: 'custom', hp: 600, AC: 8, saveBonus: save, count: 2, speed: 30,
    actions: [{ id: 'dm1', name: 'Slap', actionSlot: 0, freq: 'at will', condition: 'default', targets: 1, type: 'atk', dpr: dmg, toHit: 99, target: 'enemy with least HP', ext: { range: 5 } }] });
  const fight = (party, foe, seed, ai) => Tac.runDay({ players: party, encounters: [{ monsters: [foe] }] }, { seed, partyAI: 'tactical', ai, record: true, maxRounds: 6 })[0];
  const ticks = (r, spell, who) => r.events.filter(e => e.kind === 'save' && new RegExp(`^${who || 'Cleric'} → Dummy [0-9]: ${spell}`).test(e.text));
  const byRound = list => { const m = {}; for (const e of list) m[e.round] = (m[e.round] || 0) + 1; return m; };

  // a foe that starts its turn in the emanation takes the damage every round, once a round, for as long as it holds
  let steady = 0, once = 0;
  for (const ai of [undefined, 'v2']) for (let s = 1; s <= 4; s++) {
    const r = fight([only('Cleric', 'Spirit Guardians', [0, 0, 1])], dummy('0', 0), s, ai), m = byRound(ticks(r, 'Spirit Guardians'));
    if ([2, 3, 4].every(k => m[k] === 2)) steady++;
    if (Object.values(m).every(n => n <= 2)) once++;
  }
  check(steady >= 7, `Spirit Guardians hurts both foes standing in it in rounds 2, 3 and 4, not just when cast (${steady} of 8 fights)`);
  check(once === 8, 'a foe is hit at most once a round by a zone');

  // a zone that follows its caster hurts nobody on the far side of a wall (the cells are cut by walls, as for a burst)
  let wallHits = 0, openHits = 0;
  for (const ai of [undefined, 'v2']) for (let sd = 1; sd <= 4; sd++) {
    const foe = dummy('0', 0); foe.ext = { speed: 0 };
    const pos = { 'party|c5-cleric|0': { x: 10, y: 2 }, ['foes|dm|0']: { x: 9, y: 2 }, ['foes|dm|1']: { x: 12, y: 2 } };
    const r = Tac.runDay({ players: [only('Cleric', 'Spirit Guardians', [0, 0, 1])], encounters: [{ monsters: [foe] }] }, { seed: sd, partyAI: 'tactical', ai, record: true, maxRounds: 6, layouts: { 0: { gapFt: 30, positions: pos, terrain: { cells } } } })[0];
    const hits = n => ticks(r, 'Spirit Guardians').filter(e => e.text.includes('Dummy ' + n + ':')).length;
    openHits += hits(1) ? 1 : 0; wallHits += hits(2);
  }
  check(openHits >= 6 && wallHits === 0, `Spirit Guardians reaches the foe beside the Cleric (${openHits} of 8 fights) and never the one behind the wall (${wallHits} hits)`);

  // concentration breaks: the zone is gone and nothing ticks until it is cast again
  let ends = 0, ghosts = 0;
  for (let s = 1; s <= 10; s++) {
    const r = fight([only('Cleric', 'Spirit Guardians', [0, 0, 1])], dummy('40', 0), s);
    let up = false;
    for (const e of r.events) {
      if (e.kind === 'zone' && /Spirit Guardians/.test(e.text) && !/follows/.test(e.text)) up = true;
      else if (e.kind === 'zoneEnd' && /Spirit Guardians fades/.test(e.text)) { up = false; ends++; }
      else if (e.kind === 'save' && /Spirit Guardians/.test(e.text) && !up) ghosts++;
    }
  }
  check(ends >= 3 && ghosts === 0, `when the Cleric loses concentration the zone ends and stops hurting (${ends} ends, ${ghosts} hits after)`);

  // the save: a saved throw takes half, a failed one the full roll (3d8 at 3rd level: 24 at most, so halves are 12 or less)
  let saved = 0, failed = 0, bigFail = 0, badHalf = 0;
  for (let s = 1; s <= 6; s++) for (const e of ticks(fight([only('Cleric', 'Spirit Guardians', [0, 0, 1])], dummy('0', 2), s), 'Spirit Guardians')) {
    const d = +(/, (\d+) damage/.exec(e.text) || [])[1];
    if (/— saved/.test(e.text)) { saved++; if (d > 12) badHalf++; } else { failed++; if (d > 12) bigFail++; }
  }
  check(saved >= 5 && failed >= 5 && badHalf === 0 && bigFail >= 1, `a save halves the damage (${saved} saved, none over 12; ${failed} failed, ${bigFail} over 12)`);

  // the creatures the Cleric spares aren't hurt, though they stand in the emanation
  let spared = 0, hurtAlly = 0, foeHits = 0;
  for (let s = 1; s <= 4; s++) {
    const fighter = cp(ctx.CB.find(b => b.name === 'Fighter')); fighter.hp = fighter.maxHp = 300;
    const r = fight([only('Cleric', 'Spirit Guardians', [0, 0, 1]), fighter], dummy('0', 0), s);
    hurtAlly += r.events.filter(e => e.kind === 'save' && /^Cleric → Fighter/.test(e.text)).length;
    foeHits += ticks(r, 'Spirit Guardians').length;
    if (r.events.some(e => e.kind === 'aoe' && /Spirit Guardians/.test(e.text))) spared++;
  }
  check(spared === 4 && foeHits >= 12 && hurtAlly === 0, `Spirit Guardians spares the Fighter beside the Cleric (${hurtAlly} hits on it, ${foeHits} on foes)`);

  // Moonbeam: the caster's action moves it, with no new slot (one 2nd-level slot, several casts), and it keeps hurting
  let moved = 0, recasts = 0, hits = 0;
  for (const ai of [undefined, 'v2']) for (let s = 1; s <= 4; s++) {
    const r = fight([only('Druid', 'Moonbeam', [0, 1])], dummy('0', 0), s, ai);
    recasts += r.events.filter(e => e.kind === 'aoe' && /Moonbeam/.test(e.text)).length;
    moved += r.events.filter(e => e.kind === 'zoneEnd' && /Moonbeam.* moves/.test(e.text)).length;
    hits += ticks(r, 'Moonbeam', 'Druid').length;
  }
  check(recasts >= 16 && moved >= 8, `Moonbeam is moved by a free action with no new slot (${recasts} casts and ${moved} moves in 8 fights with one slot)`);
  check(hits > recasts, `…and it also hurts at the start of the foes' turns (${hits} hits)`);

  // the zone ends at its duration
  let gone = 0, late = 0;
  for (let s = 1; s <= 4; s++) {
    const r = fight([only('Cleric', 'Spirit Guardians', [0, 0, 1], 2)], dummy('0', 0), s);
    const end = r.events.find(e => e.kind === 'zoneEnd' && /Spirit Guardians fades/.test(e.text));
    if (end && end.round === 3) gone++;
    late += ticks(r, 'Spirit Guardians').filter(e => e.round >= 3).length;
  }
  check(gone === 4 && late === 0, `a 2-round zone cast in round 1 fades at the start of round 3 and stops hurting (${gone} of 4 fades, ${late} late hits)`);
}

section('Pre-fight buffs (Aid cast in the morning; morningShare 1 = every slot may go to them)');
{
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/party.js'), 'utf8') + ';globalThis.CB = CLASS_BUILDS;', ctx);
  const cp = x => JSON.parse(JSON.stringify(x));
  const build = n => cp(ctx.CB.find(b => b.name === n));
  const cleric = slots => { const c = build('Cleric'); c.ext.spellbook.spells = c.ext.spellbook.spells.filter(s => s.name === 'Aid'); c.ext.spellbook.slots = slots; return c; };
  const foe = { id: 'dm', name: 'Dummy', mode: 'custom', hp: 30, AC: 8, saveBonus: 0, count: 1, speed: 30,
    actions: [{ id: 'dm1', name: 'Slap', actionSlot: 0, freq: 'at will', condition: 'default', targets: 1, type: 'atk', dpr: '1', toHit: 99, target: 'enemy with least HP', ext: { range: 5 } }] };
  const day = slots => ({ players: [cleric(slots), build('Fighter'), build('Wizard'), build('Rogue'), build('Barbarian')], encounters: [{ monsters: [cp(foe)] }, { monsters: [cp(foe)] }] });
  const base = {}; day([0, 0]).players.forEach(p => { base[p.name] = p.hp; });
  const run = (slots, o) => Tac.runDay(day(slots), Object.assign({ seed: 11, partyAI: 'tactical', record: true, maxRounds: 8, _keep: true, morningShare: 1 }, o));
  const morning = r => r.events.filter(e => /this morning/.test(e.text || ''));
  const aidHeals = r => r.events.filter(e => e.kind === 'heal' && /: Aid, max HP/.test(e.text));
  const grown = r => r.party.filter(p => p.maxHp > base[p.name]).map(p => p.name).sort();
  const slotsLeft = r => r._sim.units.find(u => u.name === 'Cleric').slots[1];

  const on = run([0, 2]), r1 = on[0];
  check(morning(r1).length === 1 && /^Cleric cast Aid this morning/.test(morning(r1)[0].text), 'Aid is logged as cast in the morning, before fight 1');
  const lowest = Object.keys(base).sort((a, b) => base[a] - base[b]).slice(0, 3).sort();
  const firstThree = morning(r1)[0].text.split(': ')[1].split(' +')[0].split(', ').sort();
  check(JSON.stringify(firstThree) === JSON.stringify(lowest), `the three allies with the lowest max HP are chosen (${firstThree} vs ${lowest})`);
  check(lowest.every(n => r1.party.find(p => p.name === n).maxHp === base[n] + 5), 'each of the three gets exactly +5 max HP from the level-2 slot');
  check(slotsLeft(on) < 2, `the morning cast spends a real slot (${slotsLeft(on)} of 2 left)`);
  check(morning(on[1]).length === 0 && lowest.every(n => on[1].party.find(p => p.name === n).maxHp >= base[n] + 5), 'the buff lasts into fight 2 and is not announced again');
  check([...on[0].events, ...on[1].events].filter(e => e.kind === 'heal' && /: Aid, max HP/.test(e.text) && lowest.some(n => (e.text.split('→ ')[1] || '').startsWith(n + ':'))).length === 0, 'Aid is never recast in a fight on someone who already has it');
  const again = run([0, 2], { seed: 12 });
  check(again[0].party.every(p => p.maxHp <= base[p.name] + 5), 'another day starts fresh: the buff does not stack across days');

  const one = run([0, 1]);
  check(slotsLeft(one) === 0 && aidHeals(one[0]).length === 0 && morning(one[0]).length === 1 && grown(one[0]).length === 3, 'with one slot the morning cast uses it and nothing is left for a recast');
  const none = run([0, 0]);
  check(morning(none[0]).length === 0 && grown(none[0]).length === 0, 'no slot, no morning cast');

  const off = run([0, 2], { prefightBuffs: false });
  check(morning(off[0]).length === 0, 'with the toggle off nothing is cast in the morning');
  check(slotsLeft(off) <= 2 && grown(off[0]).length <= aidHeals(off[0]).length, 'with the toggle off max HP only grows from in-fight casts');
}


section('Pre-fight buffs: Mage Armor, Death Ward, the table and morningShare');
{
  const cp = x => JSON.parse(JSON.stringify(x));
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ['data/party.js', 'js/spell-data.js', 'js/statblock-parser.js', 'js/sheet-reader.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8') + (f === 'data/party.js' ? ';globalThis.CB = CLASS_BUILDS;' : ''), ctx, { filename: f });
  const build = n => cp(ctx.CB.find(b => b.name === n));
  // the spells as the sheet reader builds them: a Foundry wizard with no armor on
  const fj = JSON.parse(fs.readFileSync(path.join(__dirname, 'sheets/foundry.json'), 'utf8'));
  fj.items.forEach(i => { if (i.type === 'equipment') i.system.equipped = false; });
  ['Mage Armor', 'Aid'].forEach(n => fj.items.push({ name: n, type: 'spell', system: { level: n === 'Aid' ? 2 : 1, preparation: { prepared: true } } }));
  const sheet = ctx.SheetReader.read(JSON.stringify(fj)).player;
  const spellOf = n => (sheet.ext.spellbook.spells || []).find(x => x.name === n);
  const MA = spellOf('Mage Armor');
  check(sheet.ext.unarmored === true && typeof sheet.ext.dexMod === 'number', 'a sheet with no armor worn is marked ext.unarmored with its Dex modifier');
  check(MA && MA.ext.prefight === 'mageArmor' && MA.level === 1 && MA.type === 'buff', 'Mage Armor comes in from a sheet as a pre-fight buff spell (level 1)');
  const DW = { id: 'dw', name: 'Death Ward', level: 4, actionSlot: 0, targets: 1, type: 'buff', target: 'ally', buff: { duration: 'entire encounter' }, ext: { range: 5, prefight: 'deathWard', wtOnly: true } };
  const caster = (spells, slots) => { const c = build('Cleric'); c.ext.spellbook.spells = spells.map(cp); c.ext.spellbook.slots = slots; return c; };
  const mark = (c, dex) => { c.ext = c.ext || {}; c.ext.unarmored = true; c.ext.dexMod = dex; return c; };
  const foe = { id: 'dm', name: 'Dummy', mode: 'custom', hp: 30, AC: 8, saveBonus: 0, count: 1, speed: 30,
    actions: [{ id: 'dm1', name: 'Slap', actionSlot: 0, freq: 'at will', condition: 'default', targets: 1, type: 'atk', dpr: '1', toHit: 99, target: 'enemy with least HP', ext: { range: 5 } }] };
  const day = (spells, slots) => ({ players: [caster(spells, slots), build('Fighter'), mark(build('Wizard'), 3), mark(build('Rogue'), 4), build('Barbarian')], encounters: [{ monsters: [cp(foe)] }, { monsters: [cp(foe)] }] });
  const run = (d, o) => Tac.runDay(d, Object.assign({ seed: 11, partyAI: 'tactical', record: true, maxRounds: 6, _keep: true }, o));
  const morning = r => r.events.filter(e => /this morning/.test(e.text || ''));
  const unit = (r, n) => r._sim.units.find(u => u.name === n);
  const L = [4, 3, 2];

  const ma = run(day([MA], L));
  check(morning(ma[0]).length === 1 && /^Cleric cast Mage Armor this morning: Rogue AC 17$/.test(morning(ma[0])[0].text), 'Mage Armor goes on the unarmored target it helps most (Rogue, 13 + Dex 4 = 17 over AC 15): ' + (morning(ma[0])[0] || {}).text);
  check(ma._sim.ac(unit(ma, 'Rogue')) === 17 && ma._sim.ac(unit(ma, 'Wizard')) === 15, 'the AC is still there after fight 2 (buffs reset between fights, the day buff is re-applied), and only the target has it');
  check(morning(ma[1]).length === 0 && unit(ma, 'Cleric').slots[0] === 3, 'it is cast once (one level-1 slot), not recast in fight 2');
  const ineligible = day([MA], L); ineligible.players.forEach(p => { if (p.ext) { delete p.ext.unarmored; } });
  const none = run(ineligible);
  check(morning(none[0]).length === 0 && unit(none, 'Cleric').slots[0] === 4, 'with nobody unarmored (or nobody it would help) Mage Armor is not cast and no slot is spent');
  const armored = day([MA], L); armored.players[3].AC = 17;
  check(morning(run(armored)[0]).every(e => !/Rogue/.test(e.text)), 'Mage Armor skips a target whose AC is already 13 + Dex or better');
  check(morning(run(day([MA], L), { prefightBuffs: false })[0]).length === 0, 'toggle off: no pre-fight spell is cast');

  // morningShare: a part of the caster's slot levels (here 4 + 3x2 + 2x3 = 16)
  check(morning(run(day([MA], L), { morningShare: 0 })[0]).length === 0, 'morningShare 0 casts nothing');
  check(morning(run(day([MA], L), { morningShare: 0.05 })[0]).length === 0, 'a share too small to pay for the spell (0.8 of a slot level) casts nothing');
  check(morning(run(day([MA], L), { morningShare: 0.07 })[0]).length === 1, 'a share that pays for a level-1 slot casts it');
  const aid = spellOf('Aid');
  const both = run(day([aid, MA], L), { morningShare: 0.25 });
  check(morning(both[0]).length === 2 && /Aid/.test(morning(both[0])[0].text) && /Mage Armor/.test(morning(both[0])[1].text), 'with room for both, the one worth more per slot level goes first (Aid, then Mage Armor): ' + morning(both[0]).map(e => e.text.split(' this')[0]).join(' / '));
  check(unit(both, 'Cleric').slots[0] === 3 && unit(both, 'Cleric').slots[1] === 2, 'each takes the lowest slot that works');
  const tight = run(day([aid, MA], L), { morningShare: 0.125 });
  check(morning(tight[0]).length === 1 && /Aid/.test(morning(tight[0])[0].text), 'a share that pays for only one spell leaves the lesser one uncast (2 levels: Aid, no Mage Armor)');
  const noRoom = run(day([aid, MA], [0, 0]));
  check(morning(noRoom[0]).length === 0, 'no slots, no cast, whatever the share');

  // Death Ward: one level-4 slot
  const dw = run(day([DW], [4, 3, 3, 1]), { morningShare: 0.4 });
  check(morning(dw[0]).length === 1 && /^Cleric cast Death Ward this morning: Barbarian warded/.test(morning(dw[0])[0].text), 'Death Ward goes on the target with the most to lose (highest max HP): ' + (morning(dw[0])[0] || {}).text);
  check(morning(run(day([DW], [4, 3, 3, 0]), { morningShare: 1 })[0]).length === 0, 'Death Ward needs a slot of level 4 or more');
  {
    const sim = dw._sim, b = unit(dw, 'Barbarian'), foeU = sim.units.find(u => u.team === 'foes');
    b.dead = false; b.hp = 20; b.deathWard = true; b.deathS = 0;
    sim.damage(foeU, b, 500, {});
    check(!b.dead && b.hp === 1 && b.deathWard === false, 'Death Ward: lethal damage leaves 1 HP, even a massive blow, and the ward is used up');
    sim.damage(foeU, b, 500, {});
    check(b.dead || b.hp === 0, 'the second drop is not caught');
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
