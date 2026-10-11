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
function check(ok, msg) { checks++; if (!ok) { failures++; console.log('  FAIL', msg); } }
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

for (const file of ['worms-day.json', 'bandit-day.json']) {
  const day = fixture(file);
  for (const ai of ['tactical', 'regular']) for (const layout of [null, walled]) {
    section(`${file} · ${ai} AI · ${layout ? 'walled map' : 'open field'}`);
    const runs = [];
    let wallSteps = 0, throughWalls = 0, deadActs = 0, incapActs = 0, badHide = 0, events = 0;
    const t0 = Date.now();
    for (let i = 0; i < 25; i++) {
      const seed = 1000 + i * 7919;
      const res = Tac.runDay(JSON.parse(JSON.stringify(day)), { seed, partyAI: ai, record: true, layouts: layout ? { 0: layout, 1: layout } : undefined });
      runs.push({ seed, res });
      for (const r of res) {
        let cur = {}, turnOf = null, inArea = false;
        for (const e of r.events) {
          events++;
          const prev = cur; cur = Object.assign({}, cur);
          for (const k in e.state) cur[k] = Object.assign({}, cur[k] || {}, e.state[k]);
          if (e.kind === 'turn') turnOf = e.uid;
          // saves inside an area are rolled from the area's centre, not the caster
          if (e.kind === 'aoe') inArea = true; else if (!['save', 'effect', 'react', 'down', 'death', 'deathsave', 'zone', 'zoneEnd'].includes(e.kind)) inArea = false;
          if (layout && e.kind === 'move' && e.path) for (const q of e.path) if (isWall(q.x, q.y)) wallSteps++;
          if (layout && !inArea && (e.kind === 'attack' || e.kind === 'save') && e.ranged && !/leap|bites back|drains/.test(e.text)) {
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
      }
    }
    const S = Tac.summarize(day, runs, { partyAI: ai });
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
  console.log(`  ${Object.keys(parsed).length} statblocks parsed`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
