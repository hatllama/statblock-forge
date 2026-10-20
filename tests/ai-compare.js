/* Old AI vs AI v2 (docs/ai-v2.md), side by side. Not part of `npm test`:
     node tests/ai-compare.js [runs per scenario, default 200] [scenario name filter]
   Every scenario plays the same seeds with the party on the old AI and on v2 (`ai: { party: 'v2' }`); monsters keep
   the old AI in both, so the difference is the party's play. Casters in a party stay on the old AI either way.
   The "dumb behavior" scenarios each count one thing the old AI does that looks wrong at the table. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
function load(files) {
  const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return ctx;
}
const Tac = load(['js/engine/tactical-engine.js']).TacEngine;
const Parser = load(['js/spell-data.js', 'js/statblock-parser.js']).StatblockParser;
const D = load(['data/party.js', 'data/srd-monsters.js']);
vm.runInContext('globalThis.CB = CLASS_BUILDS; globalThis.PP = PARTY_PLAYERS; globalThis.M = SRD_MONSTERS;', D);
const clone = x => JSON.parse(JSON.stringify(x));
const fixture = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));

const pc = name => { const c = D.CB.find(x => x.name === name); if (!c) throw new Error('no class build ' + name); return clone(c); };
function mon(name, count) {
  const s = D.M.find(m => m.name === name);
  if (!s) throw new Error('no SRD monster ' + name);
  const m = clone(Parser.parse(s.text).monsters[0]);
  m.id = s.id; m.mode = 'custom'; m.count = count || 1;
  m.actions.forEach((a, i) => { a.id = s.id + i; });
  if (m.ext.spellbook) m.ext.spellbook.spells.forEach((x, i) => { x.id = s.id + 's' + i; });
  return m;
}
// "Ogre*2,Hill Giant / Troll": fights separated by '/', monsters by ','
const fights = spec => spec.split('/').map(g => ({ monsters: g.split(',').map(s => { const [n, c] = s.trim().split('*'); return mon(n, +c || 1); }) }));
const MARTIALS = ['Barbarian', 'Fighter', 'Monk', 'Rogue'];
// a Goliath fighter: Stone's Endurance as the sheet reader builds it
const goliath = () => {
  const f = pc('Fighter');
  f.name = 'Goliath Fighter';
  f.actions.push({ id: 'c5-fighter-stone', name: "Stone's Endurance", actionSlot: 4, freq: { reset: 'lr', uses: 3 }, condition: 'default', targets: 1, type: 'buff', target: 'self', buff: { duration: 'until next attack taken', damageReduction: '1d12 + 3' } });
  return f;
};

/* ---- reading a replay ---- */
// walk the events with the state as it was just before each one
function walk(r, fn) {
  let cur = {};
  for (const e of r.events) {
    const prev = cur;
    cur = Object.assign({}, cur);
    for (const k in e.state) cur[k] = Object.assign({}, cur[k] || {}, e.state[k]);
    fn(e, prev);
  }
}
const nameOf = (r, uid) => { const u = r.units.find(x => x.uid === uid); return u ? u.name : ''; };
const uidOf = (r, name) => { const u = r.units.find(x => x.name === name); return u ? u.uid : ''; };

/* ---- the scenarios ---- */
const SCENARIOS = [
  { name: 'Brute: 2 Hill Giants + 2 Ogres', party: MARTIALS, day: 'Hill Giant*2,Ogre*2' },
  { name: 'Ranged strikers: 5 Manticores', party: MARTIALS, day: 'Manticore*5' },
  { name: 'Swarm: 16 Gnoll Warriors', party: MARTIALS, day: 'Gnoll Warrior*16' },
  { name: 'Caster: 2 Mages + 6 Guards', party: MARTIALS, day: 'Mage*2,Guard*6' },
  { name: 'Duelists: 3 Gladiators', party: MARTIALS, day: 'Gladiator*3' },
  { name: 'Flyer: Young Green Dragon', party: MARTIALS, day: 'Young Green Dragon' },
  { name: 'Three-fight day: goblins / ogres + bugbears / gladiators', party: MARTIALS, day: 'Goblin Warrior*6/Ogre*2,Bugbear Warrior*2/Gladiator*2' },
  { name: 'Mixed party (Fighter, Paladin, Cleric, Wizard, Rogue, Bard; casters stay v1) vs hard-day.json', players: () => clone(D.PP), encounters: () => clone(fixture('hard-day.json').encounters) },
  { name: "Zaki's party (Kraax and Tacitus on v2, the casters on v1) vs hard-day.json", players: () => clone(JSON.parse(fs.readFileSync(path.join(ROOT, 'parties/zaki-party-level-4.json'), 'utf8')).players), encounters: () => clone(fixture('hard-day.json').encounters) },

  // ---- dumb behaviors ----
  { name: 'DUMB 1: the Monk spends Stunning Strike / Flurry on a foe its free strikes would drop (Guards, then Ogres)',
    party: ['Monk', 'Fighter'], day: 'Guard*4/Ogre*2', record: true,
    metrics: {
      // one count per use (its first attack line in a turn) whose target was already low enough for the free option:
      // a Martial Arts strike averages 8.5, the plain two-strike action about 11 against these ACs
      'wasted uses/day': r => { let n = 0, used = new Set(); walk(r, (e, prev) => {
        if (e.kind === 'turn') { used = new Set(); return; }
        const m = e.kind === 'attack' && /^Monk → [^:]+: (Stunning Strike|Flurry of Blows)/.exec(e.text || '');
        if (!m || used.has(m[1])) return;
        used.add(m[1]);
        const t = prev[e.target];
        if (t && t.hp > 0 && t.hp <= (m[1] === 'Flurry of Blows' ? 8 : 11)) n++;
      }); return n; },
      'Stunning Strikes on the Ogres': (r, i) => i === 1 ? r.events.filter(e => e.kind === 'attack' && /^Monk → Ogre[^:]*: Stunning Strike/.test(e.text)).length / 2 : 0,
    } },
  { name: 'DUMB 2: per-rest features burned in trivial openers (3× 3 goblins, then Troll + Ogre)',
    party: MARTIALS, day: 'Goblin Warrior*3/Goblin Warrior*3/Goblin Warrior*3/Troll,Ogre', record: true,
    metrics: {
      'uses in openers': (r, i) => i < 3 ? r.events.filter(e => /^Barbarian: Rage$/.test(e.text) || (e.kind === 'attack' && /Action Surge|Stunning Strike|Flurry of Blows/.test(e.text))).length : 0,
      'Rage left for the boss': (r, i, sim) => i === 3 ? (r.events.some(e => /^Barbarian: Rage$/.test(e.text)) ? 1 : 0) : 0,
    } },
  { name: 'DUMB 3: the Monk Dodge-crawls toward archers instead of dashing (6 goblins with bows, 60 ft away)',
    party: ['Monk', 'Rogue'], day: 'Goblin Warrior*6', layout: { gapFt: 60 }, record: true,
    metrics: {
      'Dodge turns while closing': r => r.events.filter(e => e.kind === 'buff' && /^Monk (takes the Dodge action|closes in carefully)/.test(e.text) && /Dodge/.test(e.text)).length,
      'round of first Monk hit': r => { let rd = 0, at = 0; for (const e of r.events) { if (e.kind === 'round') rd++; if (!at && e.kind === 'attack' && /^Monk →/.test(e.text)) at = rd; } return at || rd; },
    } },
  { name: 'DUMB 4: Reckless Attack kept on while badly hurt among heavy hitters (Barbarian + Fighter vs 4 Ogres)',
    party: ['Barbarian', 'Fighter'], day: 'Ogre*4', record: true,
    metrics: {
      'attacks at adv on a hurt Barbarian': r => { let n = 0; const b = uidOf(r, 'Barbarian'); walk(r, (e, prev) => {
        if (e.kind !== 'attack' || e.target !== b || !/\(adv/.test(e.text)) return;
        const s = prev[b]; if (s && s.hp > 0 && s.hp < 28) n++; }); return n; },
      'Barbarian downed': r => r.party.find(p => p.name === 'Barbarian').everDowned ? 1 : 0,
    } },
  { name: "DUMB 5: Stone's Endurance (3/day) spent on scratches (Goliath Fighter + Rogue: 10 goblins, then 3 Ogres)",
    players: () => [goliath(), pc('Rogue')], encounters: () => fights('Goblin Warrior*10/Ogre*3'), record: true,
    metrics: {
      'uses on hits under 7': r => r.events.filter(e => { const m = e.kind === 'react' && /Stone's Endurance \((\d+) →/.exec(e.text); return m && +m[1] < 7; }).length,
      'damage prevented/use': null,     // filled in from the two counters below
      '_prevented': r => r.events.reduce((t, e) => { const m = e.kind === 'react' && /Stone's Endurance \((\d+) → (\d+)\)/.exec(e.text); return t + (m ? m[1] - m[2] : 0); }, 0),
      '_uses': r => r.events.filter(e => e.kind === 'react' && /Stone's Endurance/.test(e.text)).length,
      'uses vs the Ogres': (r, i) => i === 1 ? r.events.filter(e => e.kind === 'react' && /Stone's Endurance/.test(e.text)).length : 0,
    } },
];

/* ---- running ---- */
function play(sc, ai, n) {
  const out = { n, won: 0, rounds: 0, deaths: 0, dealt: 0, taken: 0, ms: 0, m: {} };
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const seed = (1000 + i * 7919) >>> 0;
    const encounters = sc.encounters ? sc.encounters() : fights(sc.day);
    const players = sc.players ? sc.players() : sc.party.map(pc);
    const layouts = sc.layout ? Object.fromEntries(encounters.map((e, k) => [k, sc.layout])) : undefined;
    const res = Tac.runDay({ players, encounters }, { seed, ai, partyAI: 'tactical', record: !!sc.record, layouts });
    const last = res[res.length - 1];
    if (res.length === encounters.length && res.every(r => r.won)) out.won++;
    out.deaths += last ? last.party.filter(p => p.dead).length : 0;
    res.forEach((r, k) => {
      out.rounds += r.rounds;
      for (const p of r.party) { out.dealt += p.dealt; out.taken += p.taken; }
      if (sc.metrics) for (const key in sc.metrics) if (sc.metrics[key]) out.m[key] = (out.m[key] || 0) + sc.metrics[key](r, k);
    });
  }
  out.ms = (Date.now() - t0) / n;
  if (sc.metrics && '_uses' in sc.metrics) out.m['damage prevented/use'] = out.m._uses ? out.m._prevented / out.m._uses * n : 0;
  return out;
}
const pad = (s, k) => String(s).padEnd(k);
const lpad = (s, k) => String(s).padStart(k);
function row(label, o) {
  const f = (x, d) => (x / o.n).toFixed(d === undefined ? 1 : d);
  const cells = [pad(label, 4), lpad((o.won / o.n * 100).toFixed(1) + '%', 7), lpad(f(o.rounds), 7), lpad(f(o.deaths, 2), 7), lpad(f(o.dealt, 0), 7), lpad(f(o.taken, 0), 7), lpad(o.ms.toFixed(0), 6)];
  for (const k in o.m) if (k[0] !== '_') cells.push(lpad(f(o.m[k], 2), Math.max(8, k.length + 2)));
  return '  ' + cells.join(' ');
}

const N = Math.max(1, parseInt(process.argv[2], 10) || 200);
const only = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
console.log(`Old AI (v1) vs AI v2 for the party, ${N} seeded runs per scenario. Per day: win = won every fight; rounds, PC deaths, damage dealt and taken by the party; ms per day.`);
for (const sc of SCENARIOS) {
  if (only && !only.test(sc.name)) continue;
  const a = play(sc, undefined, N), b = play(sc, { party: 'v2' }, N);
  const extra = Object.keys(a.m).filter(k => k[0] !== '_');
  console.log('\n' + sc.name);
  console.log('  ' + [pad('AI', 4), lpad('win', 7), lpad('rounds', 7), lpad('deaths', 7), lpad('dealt', 7), lpad('taken', 7), lpad('ms', 6)].concat(extra.map(k => lpad(k, Math.max(8, k.length + 2)))).join(' '));
  console.log(row('v1', a));
  console.log(row('v2', b));
}
