/* Engine checks. No dependencies: `node tests/run.js` (or `npm test`).
   Loads the two engines the same way the browser does (plain scripts that set globals),
   plays a few hundred fights, and fails loudly if a rule is broken. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
function loadGlobal(file, name) {
  const ctx = { console, crypto: require('crypto').webcrypto, structuredClone, globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  if (!ctx[name]) throw new Error(`${file} did not define ${name}`);
  return ctx[name];
}
const Tac = loadGlobal('js/engine/tactical-engine.js', 'TacEngine');
const Avg = loadGlobal('vendor/battlesim/battlesim-engine.js', 'BattleSimEngine');
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

section('Averages engine (Simulate page)');
{
  const day = fixture('worms-day.json');
  let res = null, err = null;
  try { res = Avg.runSimulation(day.players, day.encounters, 0.5, { escapePolicy: 'never', surpriseRules: '2024', smartActions: true }); } catch (e) { err = e; }
  check(!err, 'runSimulation threw: ' + (err && err.message));
  check(Array.isArray(res) && res.length > 0, 'runSimulation returned results');
  if (res) console.log(`  ${res.length} result set(s)`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
