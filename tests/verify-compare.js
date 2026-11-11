/* Old AI vs AI v2 (docs/ai-v2.md), side by side. Not part of `npm test`:
     node tests/ai-compare.js [runs per scenario, default 200] [scenario name filter]
   Every scenario plays the same seeds with the party on the old AI and on v2 (`ai: { party: 'v2' }`); monsters keep
   the old AI in both, so the difference is the party's play (scenarios marked side: 'foes' switch the monsters instead).
   Full casters use v2 with the flag (step 2), and since step 3a half and third casters (Paladin, Ranger, Artificer, Eldritch Knight,
   Arcane Trickster) do too; scenario names that still say "the Paladin stays v1" are kept so their rows compare across commits.
   The "dumb behavior" scenarios each count one thing the old AI does that looks wrong at the table; the A scenarios
   show how a caster chooses between an area spell and a single-target one. win ± its standard error. */
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
// ENGINE=path: play another copy of the engine (a "before" saved from an older commit), same scenarios and seeds
const Tac = (process.env.ENGINE ? (() => { const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(fs.readFileSync(process.env.ENGINE, 'utf8'), ctx, { filename: 'engine' }); return ctx; })() : load(['js/engine/tactical-engine.js'])).TacEngine;
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

/* ---- casters (step 2) ---- */
const CASTER_RE = /^(Wizard|Cleric|Sorcerer|Warlock|Druid|Bard)\b/;
const isPartyCaster = (r, uid) => { const u = r.units.find(x => x.uid === uid); return !!(u && u.team === 'party' && CASTER_RE.test(u.name)); };
const teamOf = (r, uid) => { const u = r.units.find(x => x.uid === uid); return u ? u.team : ''; };
const maxHpOf = (r, uid) => { const u = r.units.find(x => x.uid === uid); return u ? u.maxHp : 1; };
const DISABLED = ['Incapacitated', 'Paralyzed', 'Stunned', 'Unconscious', 'Petrified'];
// an Evoker without Sculpt Spells, so its Fireball can hurt its friends
const evoker = () => { const w = pc('Wizard'); w.ext.spellbook.spells.forEach(s => { if (s.ext && s.ext.area) delete s.ext.area.selective; if (/sculpted/.test(s.name)) s.name = 'Fireball'; }); return w; };
const withHp = (m, hp) => { m.hp = hp; m.id += '-hurt'; m.name = 'Hurt ' + m.name; m.actions.forEach(a => { a.id += '-h'; }); return m; };
const scaled = (m, by) => { for (const a of m.actions) if (a.dpr) a.dpr = String(Math.round(Tac.avgDice(a.dpr) * by)); return m; };
const withLR = (m, n) => { m.ext.legendaryResistance = n; m.name = m.name + ' (LR ' + n + ')'; return m; };
const statblock = (file, count) => {
  const m = clone(Parser.parse(fs.readFileSync(path.join(__dirname, 'statblocks', file), 'utf8')).monsters[0]);
  m.id = file; m.mode = 'custom'; m.count = count || 1; m.actions.forEach((a, i) => { a.id = file + i; });
  if (m.ext.spellbook) m.ext.spellbook.spells.forEach((x, i) => { x.id = file + 's' + i; });
  return m;
};
// positions: a 3×2 block of goblins (clustered) or six far apart (spread); optionally the Fighter in among them
const goblinsAt = (cells, fighter) => (encs) => {
  const g = encs[0].monsters.find(m => /Goblin/.test(m.name)), pos = {};
  cells.forEach(([x, y], i) => { pos['foes|' + g.id + '|' + i] = { x, y }; });
  if (fighter) pos['party|' + fighter + '|0'] = { x: 14, y: 7 };
  return { 0: { gapFt: 30, positions: pos } };
};
const CLUSTER = [[15, 6], [15, 7], [15, 8], [16, 6], [16, 7], [16, 8]];
const SPREAD = [[14, 1], [14, 8], [14, 15], [21, 1], [21, 8], [21, 15]];

/* one logical spell cast per caster, turn and spell: { caster, spell, L, targets: [{ uid, prev }], foes, friends, aoe } */
function casts(r) {
  const out = [];
  let turn = 0, cur = null, key = '';
  walk(r, (e, prev) => {
    if (e.kind === 'turn') { turn++; cur = null; key = ''; return; }
    if (!isPartyCaster(r, e.uid) || !['attack', 'save', 'heal', 'buff', 'aoe'].includes(e.kind)) return;
    const m = /(?:→ [^:]+: |unleashes |: )([A-Z][^,(]*?)(?: \(L(\d)\))?(?:,| \(|$| →)/.exec(e.text || '');
    if (!m) return;
    const spell = m[1].trim(), k = turn + '|' + e.uid + '|' + spell;
    if (k !== key) { key = k; cur = { caster: nameOf(r, e.uid), uid: e.uid, spell, L: +m[2] || 0, targets: [], aoe: false, ff: 0 }; out.push(cur); }
    if (e.kind === 'aoe') { cur.aoe = true; const f = /\((\d+) of them on its own side\)/.exec(e.text); cur.ff = f ? +f[1] : 0; }
    if (e.target && e.kind !== 'aoe' && !cur.targets.some(t => t.uid === e.target)) cur.targets.push({ uid: e.target, prev: prev[e.target] || {}, dmg: +((/(\d+) damage/.exec(e.text) || [])[1] || 0), text: e.text });
  });
  for (const c of out) { c.foes = c.targets.filter(t => teamOf(r, t.uid) === 'foes'); c.control = c.foes.some(t => /— (auto-fails, )?(affected|saved)/.test(t.text) && !/damage/.test(t.text)); }
  return out;
}
// slot levels the party's casters spent this fight
function slotsSpent(r) {
  const first = {}, last = {};
  for (const e of r.events) for (const uid in e.state || {}) { const s = e.state[uid].slots; if (s === undefined || !isPartyCaster(r, uid)) continue; if (!(uid in first)) first[uid] = s; last[uid] = s; }
  let n = 0;
  for (const uid in first) {
    const a = first[uid].split(' ').map(x => +x.split('/')[0]), b = last[uid].split(' ').map(x => +x.split('/')[0]);
    a.forEach((v, i) => { n += Math.max(0, v - b[i]) * (i + 1); });
  }
  return n;
}
const CASTER_METRICS = {
  'slot lvls': r => slotsSpent(r),
  'ally hits': r => casts(r).reduce((t, c) => t + c.ff, 0),
  '_areas': r => casts(r).filter(c => c.aoe && c.foes.length).length,
  '_caught': r => casts(r).filter(c => c.aoe && c.foes.length).reduce((t, c) => t + c.foes.length, 0),
  'caught/area': null,
  'overkill': r => casts(r).reduce((t, c) => t + c.foes.reduce((s, x) => s + (x.prev.hp > 0 ? Math.max(0, x.dmg - x.prev.hp) : 0), 0), 0),
};
// hybrids (step 3a): Divine Smites (a v2 rider on a hit, or the old AI's bonus-action buff), the ones v2 took to finish a foe, Lay on Hands uses and points, Hunter's Marks
const evText = (r, kind, re) => r.events.filter(e => e.kind === kind && re.test(e.text || ''));
const HYB_METRICS = {
  'smites': r => evText(r, 'attack', /\+ Divine Smite/).length + evText(r, 'buff', /: Divine Smite/).length,
  'smite kills': r => evText(r, 'intent', /smites to finish/).length,
  'LoH': r => evText(r, 'heal', /: Lay on Hands/).length,
  'LoH pts': r => evText(r, 'heal', /: Lay on Hands/).reduce((t, e) => t + +((/\+(\d+) HP/.exec(e.text) || [0, 0])[1]), 0),
  'marks': r => evText(r, 'buff', /: Hunter's Mark/).length,
};
const SPELLS = r => casts(r).map(c => c.spell + (c.L ? ' L' + c.L : '') + (c.aoe ? ' ×' + c.foes.length : ''));
// dumb behaviors seen with the old AI
const DUMB_C = {
  // a slot spent where every foe it hit had no more HP than a cantrip deals (11), before the day's last fight
  'slot on fodder': (r, i, n) => i < n - 1 ? casts(r).filter(c => c.L >= 1 && c.foes.length && c.foes.every(t => t.prev.hp > 0 && t.prev.hp <= 11)).length : 0,
  // a Wizard ends its turn next to a foe that can still act (a Cleric with Spirit Guardians belongs there)
  'Wizard turns in melee': r => {
    let n = 0, who = null;
    walk(r, (e, prev) => {
      if (e.kind !== 'turn' && e.kind !== 'round' && e.kind !== 'end') return;
      if (who && /^Wizard/.test(nameOf(r, who))) {
        const me = prev[who];
        if (me && me.hp > 0 && !me.dead && r.units.some(u => u.team === 'foes' && prev[u.uid] && prev[u.uid].hp > 0 && !prev[u.uid].dead && prev[u.uid].onBoard !== false &&
          !(prev[u.uid].conds || []).some(c => DISABLED.includes(c)) && Math.max(Math.abs(prev[u.uid].x - me.x), Math.abs(prev[u.uid].y - me.y)) <= 1)) n++;
      }
      who = e.kind === 'turn' ? e.uid : null;
    });
    return n;
  },
  // a new concentration spell while the one it holds is still doing something
  'conc dropped': r => {
    let n = 0;
    const concNames = new Set();
    walk(r, (e, prev) => {
      if (!isPartyCaster(r, e.uid) || !['save', 'buff', 'aoe', 'attack'].includes(e.kind)) return;
      const held = prev[e.uid] && prev[e.uid].conc, now = e.state && e.state[e.uid] && e.state[e.uid].conc;
      if (held && now && now !== held && !concNames.has(e.uid + now + e.round)) {
        concNames.add(e.uid + now + e.round);
        const me = nameOf(r, e.uid);
        if (Object.keys(prev).some(k => prev[k].hp > 0 && !prev[k].dead && (prev[k].buffs || []).some(b => b[0].replace(/ \(L\d\)$/, '') === held && b[3] === me))) n++;
      }
    });
    return n;
  },
  // damage on a foe our own Hypnotic Pattern (or any spell that damage ends) is holding, while others are free
  'pattern woken': r => {
    let n = 0;
    walk(r, (e, prev) => {
      if (!['attack', 'save'].includes(e.kind) || teamOf(r, e.uid) !== 'party' || !/(\d+) damage/.test(e.text || '')) return;
      const t = prev[e.target];
      const held = u => prev[u.uid] && (prev[u.uid].buffs || []).some(b => /Hypnotic Pattern/.test(b[0]) && b[1] === 'Incapacitated');
      if (t && t.hp > 0 && held({ uid: e.target }) && r.units.some(u => u.team === 'foes' && prev[u.uid] && prev[u.uid].hp > 0 && !prev[u.uid].dead && !held(u))) n++;
    });
    return n;
  },
  // control spells (save-or-suck) at a foe that's already disabled, or one with Legendary Resistance left
  'control on disabled': r => casts(r).filter(c => c.control && c.foes.length && c.foes.every(t => (t.prev.conds || []).some(x => DISABLED.includes(x)))).length,
  'control into LR': r => casts(r).filter(c => c.control && c.foes.some(t => t.prev.legRes && +t.prev.legRes.split('/')[0] > 0)).length,
  // heals on allies over half HP; caster turns with an ally down, a heal in hand, and no heal for the downed
  'heals over half': r => casts(r).filter(c => c.targets.some(t => teamOf(r, t.uid) === 'party' && /HP$/.test(t.text) && !/temp|max HP/.test(t.text) && t.prev.hp >= maxHpOf(r, t.uid) / 2)).length,
  'downed left': r => {
    let n = 0, who = null, down = false, healed = false;
    const flush = () => { if (who && down && !healed) n++; };
    walk(r, (e, prev) => {
      if (e.kind === 'turn') {
        flush();
        who = isPartyCaster(r, e.uid) && /Cleric|Bard|Druid/.test(nameOf(r, e.uid)) && prev[e.uid] && prev[e.uid].hp > 0 ? e.uid : null;
        down = !!who && r.units.some(u => u.team === 'party' && u.uid !== who && prev[u.uid] && prev[u.uid].down && !prev[u.uid].dead) && /[1-9]\//.test(prev[who].slots || '');
        healed = false;
      } else if (who && e.kind === 'heal' && e.uid === who && prev[e.target] && prev[e.target].down) healed = true;
    });
    flush();
    return n;
  },
};

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
  { name: "Zaki's party (Kraax and Tacitus on v2, the casters on v1) vs hard-day.json", players: () => clone(JSON.parse(fs.readFileSync(path.join(ROOT, 'parties/zaki-party-level-5.json'), 'utf8')).players), encounters: () => clone(fixture('hard-day.json').encounters) },

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
  // ---- casters (step 2): full casters move to v2; Paladins and Rangers (half casters) stay on the old AI ----
  { name: 'C-Brute: Fighter, Barbarian, Wizard, Cleric vs Hill Giant + 2 Ogres', party: ['Fighter', 'Barbarian', 'Wizard', 'Cleric'], day: 'Hill Giant,Ogre*2', record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'C-Swarm: Fighter, Wizard, Cleric, Sorcerer vs 14 Goblin Warriors', party: ['Fighter', 'Wizard', 'Cleric', 'Sorcerer'], day: 'Goblin Warrior*14', record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'C-Boss with Legendary Resistance: Fighter, Wizard, Cleric, Bard vs Gladiator (LR 3) + 2 Bandits', party: ['Fighter', 'Wizard', 'Cleric', 'Bard'],
    encounters: () => [{ monsters: [withLR(mon('Gladiator'), 3), mon('Bandit', 2)] }], record: true, spells: true, metrics: Object.assign({ 'control into LR': DUMB_C['control into LR'] }, CASTER_METRICS) },
  { name: 'C-Caster monster: Fighter, Wizard, Cleric, Bard vs 2 Mages (2014 statblock with slots) + 4 Guards', party: ['Fighter', 'Wizard', 'Cleric', 'Bard'],
    encounters: () => [{ monsters: [statblock('mage-2014.txt', 2), mon('Guard', 4)] }], record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'C-Caster monster on v2 (monster side: the Mages and Priests on v1 vs v2; party on v1 both times; lower win = better monsters)', side: 'foes', party: ['Fighter', 'Wizard', 'Cleric', 'Rogue'],
    encounters: () => [{ monsters: [statblock('mage-2014.txt', 2), mon('Guard', 3)] }, { monsters: [mon('Priest', 2), mon('Bandit', 4)] }] },
  { name: 'C-Day, slot pacing: Fighter, Wizard, Cleric, Bard: 3 goblins / 2 ogres / Bandit Captain + 5 bandits (short rest before it)', party: ['Fighter', 'Wizard', 'Cleric', 'Bard'],
    encounters: () => [{ monsters: [mon('Goblin Warrior', 3)] }, { monsters: [mon('Ogre', 2)] }, { monsters: [mon('Bandit Captain'), mon('Bandit', 5)], shortRest: true }], record: true, spells: true,
    metrics: Object.assign({ 'slot on fodder': DUMB_C['slot on fodder'] }, CASTER_METRICS) },
  { name: 'C-Long day: Fighter, Warlock (short-rest slots), Wizard (Arcane Recovery), Cleric: gnolls / ogres / rest / gnolls / Hill Giant + ogre', party: ['Fighter', 'Warlock', 'Wizard', 'Cleric'],
    encounters: () => [{ monsters: [mon('Gnoll Warrior', 6)] }, { monsters: [mon('Ogre', 2)] }, { monsters: [mon('Gnoll Warrior', 6)], shortRest: true }, { monsters: [mon('Hill Giant'), mon('Ogre')] }], record: true, metrics: CASTER_METRICS },
  { name: 'C-Cleric (lingering damage): Fighter, Rogue, Cleric, Wizard vs Hill Giant + 2 Ogres', party: ['Fighter', 'Rogue', 'Cleric', 'Wizard'], day: 'Hill Giant,Ogre*2', record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'C-Druid (lingering damage): Fighter, Rogue, Druid, Wizard vs Hill Giant + 2 Ogres', party: ['Fighter', 'Rogue', 'Druid', 'Wizard'], day: 'Hill Giant,Ogre*2', record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'C-Default party (Fighter, Paladin, Cleric, Wizard, Rogue, Bard; the Paladin stays v1) vs hard-day.json', players: () => clone(D.PP), encounters: () => clone(fixture('hard-day.json').encounters), record: true, metrics: CASTER_METRICS },
  { name: "C-Zaki's party (druid, two warlocks, wizard, monk, rogue: all on v2) vs hard-day.json", players: () => clone(JSON.parse(fs.readFileSync(path.join(ROOT, 'parties/zaki-party-level-5.json'), 'utf8')).players), encounters: () => clone(fixture('hard-day.json').encounters) },

  // ---- step 2.5 check: lingering zones in long fights ----
  { name: 'L-Long boss (400 HP Troll): Fighter, Rogue, Cleric, Druid', party: ['Fighter', 'Rogue', 'Cleric', 'Druid'], encounters: () => [{ monsters: [withHp(mon('Troll'), 400)] }], record: true, spells: true,
    metrics: { 'SpiritG casts': r => casts(r).filter(c => c.spell === 'Spirit Guardians').length, 'Moonbeam casts': r => casts(r).filter(c => c.spell === 'Moonbeam').length } },

  // ---- caster dumb behaviors (seen with the old AI) ----
  { name: 'DUMB C1: slots spent on foes a cantrip drops, before the last fight (same day as C-Day)', party: ['Fighter', 'Wizard', 'Cleric', 'Bard'],
    encounters: () => [{ monsters: [mon('Goblin Warrior', 3)] }, { monsters: [mon('Ogre', 2)] }, { monsters: [mon('Bandit Captain'), mon('Bandit', 5)] }], record: true,
    metrics: { 'slot on fodder': DUMB_C['slot on fodder'], 'slot lvls': CASTER_METRICS['slot lvls'], 'overkill': CASTER_METRICS.overkill } },
  { name: 'DUMB C2: casters ending turns in melee (Fighter, Wizard, Cleric vs 4 Goblin Warriors + 2 Bugbear Warriors, 20 ft apart)', party: ['Fighter', 'Wizard', 'Cleric'], day: 'Goblin Warrior*4,Bugbear Warrior*2', layout: { gapFt: 20 }, record: true,
    metrics: { 'Wizard turns in melee': DUMB_C['Wizard turns in melee'] } },
  { name: 'DUMB C3: dropping a working concentration spell; stacking control on a disabled foe (Bard, Wizard, Cleric, Fighter: captain + bandits / 2 ogres)', party: ['Fighter', 'Wizard', 'Cleric', 'Bard'],
    day: 'Bandit Captain,Bandit*4/Ogre*2', record: true, metrics: { 'conc dropped': DUMB_C['conc dropped'], 'control on disabled': DUMB_C['control on disabled'] } },
  { name: 'DUMB C4: area spells catching allies (Sorcerer, Barbarian, Fighter, Monk vs 10 Goblin Warriors)', party: ['Sorcerer', 'Barbarian', 'Fighter', 'Monk'], day: 'Goblin Warrior*10', record: true,
    metrics: { 'ally hits': CASTER_METRICS['ally hits'], '_areas': CASTER_METRICS._areas, '_caught': CASTER_METRICS._caught, 'caught/area': null } },
  { name: 'DUMB C5: a Bard with Hypnotic Pattern and a Cleric (Barbarian, Fighter) vs 4 Ogres: dropping the pattern, waking it, catching allies; healing',
    party: ['Cleric', 'Bard', 'Barbarian', 'Fighter'], day: 'Ogre*4', record: true,
    metrics: { 'conc dropped': DUMB_C['conc dropped'], 'pattern woken': DUMB_C['pattern woken'], 'ally hits': CASTER_METRICS['ally hits'], 'heals over half': DUMB_C['heals over half'], 'downed left': DUMB_C['downed left'] } },
  { name: 'DUMB C6: save-or-suck into Legendary Resistance (Bard, Wizard, Cleric, Fighter vs Gladiator (LR 3) + 2 Bandits)', party: ['Fighter', 'Wizard', 'Cleric', 'Bard'],
    encounters: () => [{ monsters: [withLR(mon('Gladiator'), 3), mon('Bandit', 2)] }], record: true, metrics: { 'control into LR': DUMB_C['control into LR'], 'control on disabled': DUMB_C['control on disabled'] } },

  // ---- area vs single target (an Evoker without Sculpt Spells, a Fighter in front; 1 fight to come after this one) ----
  { name: 'A1: Evoker + Fighter vs 1 Ogre', players: () => [evoker(), pc('Fighter')], encounters: () => fights('Ogre/Ogre'), only0: true, record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'A2: Evoker + Fighter vs 6 Goblin Warriors, spread out', players: () => [evoker(), pc('Fighter')], encounters: () => fights('Goblin Warrior*6/Ogre'), layoutFn: goblinsAt(SPREAD), only0: true, record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'A3: Evoker + Fighter vs 6 Goblin Warriors, clustered', players: () => [evoker(), pc('Fighter')], encounters: () => fights('Goblin Warrior*6/Ogre'), layoutFn: goblinsAt(CLUSTER), only0: true, record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'A4: Evoker + Fighter vs 6 clustered Goblin Warriors, the Fighter in among them', players: () => [evoker(), pc('Fighter')], encounters: () => fights('Goblin Warrior*6/Ogre'), layoutFn: goblinsAt(CLUSTER, 'c5-fighter'), only0: true, record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'A5: Evoker + Fighter vs 2 nearly dead goblins (3 HP) + 1 healthy Ogre', players: () => [evoker(), pc('Fighter')], encounters: () => [{ monsters: [withHp(mon('Goblin Warrior', 2), 3), mon('Ogre')] }, { monsters: [mon('Ogre')] }], only0: true, record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'A6: boss and minions: Evoker + Fighter vs Gladiator + 2 Goblin Warriors', players: () => [evoker(), pc('Fighter')], encounters: () => fights('Gladiator,Goblin Warrior*2/Ogre'), only0: true, record: true, spells: true, metrics: CASTER_METRICS },
  { name: 'A7: zone vs burst: Druid (Moonbeam, Call Lightning, Entangle, Thunderwave) + Fighter vs Ogre + 4 Goblin Warriors', players: () => [pc('Druid'), pc('Fighter')], encounters: () => fights('Ogre,Goblin Warrior*4/Ogre'), only0: true, record: true, spells: true, metrics: CASTER_METRICS },
  // ---- hybrids (step 3a): each with a Fighter and a Cleric, a mixed party, all five, undead, a downed ally ----
  ...['Paladin', 'Ranger', 'Artificer', 'Eldritch Knight', 'Arcane Trickster'].map((c, i) => ({ name: `H${i + 1} ${c}, Fighter, Cleric vs 8 Goblin Warriors + Bandit Captain / 3 Ogres / Troll + 2 Ogres`, party: [c, 'Fighter', 'Cleric'], day: 'Goblin Warrior*8,Bandit Captain/Ogre*3/Troll,Ogre*2', record: true, metrics: HYB_METRICS })),
  { name: 'H6 mixed: Paladin, Ranger (hybrids), Wizard, Cleric (full casters), Fighter (martial) vs hard-day.json', party: ['Paladin', 'Ranger', 'Wizard', 'Cleric', 'Fighter'], encounters: () => clone(fixture('hard-day.json').encounters), record: true, metrics: HYB_METRICS },
  { name: 'H7 all five hybrids vs Bandit Captain + 6 Bandits / Hill Giant + 2 Ogres', party: ['Paladin', 'Ranger', 'Artificer', 'Eldritch Knight', 'Arcane Trickster'], day: 'Bandit Captain,Bandit*6/Hill Giant,Ogre*2', record: true, metrics: HYB_METRICS },
  { name: 'H8 Paladin, Fighter, Cleric vs undead: 4 Ghouls + Wight / Mummy + 4 Zombies', party: ['Paladin', 'Fighter', 'Cleric'], day: 'Ghoul*4,Wight/Mummy,Zombie*4', record: true, metrics: HYB_METRICS },
  { name: 'H9 Paladin, Ranger, Rogue (no other healer), the Rogue down as fight 1 starts, vs 2 Ogres + 3 Goblin Warriors / 2 Ogres', party: ['Paladin', 'Ranger', 'Rogue'], day: 'Ogre*2,Goblin Warrior*3/Ogre*2', down: ['Rogue'], record: true, metrics: HYB_METRICS },
  { name: 'A8: area control vs one big target: Bard + Fighter vs Bandit Captain + 4 Bandits', players: () => [pc('Bard'), pc('Fighter')], encounters: () => fights('Bandit Captain,Bandit*4/Ogre'), only0: true, record: true, spells: true, metrics: CASTER_METRICS },
];

/* ---- step 2.6: burn the boss's Legendary Resistance, or race its HP (docs/ai-v2.md) ----
   Three arms on the same seeds: the old AI (v1), v2 without the burn plan (burn.bias 0 = the step 2.5 behavior), v2 with it. */
const lrBurned = r => r.events.filter(e => /uses Legendary Resistance/.test(e.text || '')).length;
const saidIn = re => r => r.events.some(e => e.kind === 'intent' && re.test(e.text || '')) ? 1 : 0;
const BURN_METRICS = {
  'LR burned': lrBurned,
  'burn plan': saidIn(/wants the party to burn/),
  'race plan': saidIn(/reckons the party should race/),
  'probes': r => r.events.filter(e => e.kind === 'intent' && / probes .* save with /.test(e.text || '')).length,
  'id rd': r => { let rd = 0; for (const e of r.events) { if (e.kind === 'round') rd = +(/[0-9]+/.exec(e.text) || [0])[0]; if (e.kind === 'intent' && /wants the party to burn/.test(e.text || '')) return rd; } return 0; },
  'slot lvls': r => slotsSpent(r),
  'boss down': r => r.units.filter(u => u.team === 'foes').every(u => { let last; for (const e of r.events) if (e.state && e.state[u.uid]) last = e.state[u.uid]; return last && (last.dead || last.hp <= 0); }) ? 1 : 0,
};
// an adult dragon: LR uses, and the save bonuses (one number for all of them, or wis alone). A level-5 party can't
// survive the real CR 17 dragon (its breath alone is 60 damage on four targets), so its damage is scaled down to DRAGON_DMG
const DRAGON_DMG = 0.35;
const dragon = (lr, saves, hp, dmg) => {
  const m = mon('Adult Red Dragon');
  for (const a of m.actions) if (a.dpr) a.dpr = String(Math.round(avgOf(a.dpr) * (dmg || DRAGON_DMG)));
  m.ext.legendaryResistance = lr;
  m.ext.fly = 0; m.ext.hover = false;      // fights on the ground (a flyer out of the martials' reach is a different test)
  m.ext.saves = Object.assign({}, m.ext.saves, saves);
  if (hp) m.hp = hp;
  m.name = 'Adult Red Dragon';
  return m;
};
const avgOf = expr => Tac.avgDice(expr);
const immune = m => { m.ext.condImmune = ['paralyzed', 'incapacitated', 'stunned', 'unconscious', 'charmed', 'frightened', 'restrained', 'blinded', 'prone']; return m; };
const ALL = v => ({ str: v, dex: v, con: v, int: v, wis: v, cha: v });
// the Cleric also has Command (1st level, Wisdom, a cheap effect to burn with); the Wizard has Hideous Laughter and Hold Person
// the Wizard also has a scroll's worth of Hold Monster (a 5th-level slot): Hold Person for any creature, the strong follow-up
const holdMonster = w => {
  const hp = w.ext.spellbook.spells.find(s => s.name === 'Hold Person'), hm = clone(hp);
  hm.name = 'Hold Monster'; hm.level = 5; hm.id = 'c5-wizard-holdmonster'; hm.ext.range = 90; delete hm.ext.targetTypes; delete hm.upcastTargets;
  w.ext.spellbook.spells.push(hm); w.ext.spellbook.slots[4] = 1;
  return w;
};
const clericCmd = () => { const c = pc('Cleric'), cmd = clone(D.CB.find(x => x.name === 'Paladin').ext.spellbook.spells.find(x => x.name === 'Command')); cmd.id = 'c5-cleric-command'; c.ext.spellbook.spells.push(cmd); return c; };
const burnParty = () => [pc('Fighter'), pc('Barbarian'), holdMonster(pc('Wizard')), clericCmd()];
const bigHitters = () => { const a = pc('Fighter'), b = pc('Barbarian'); for (const x of [a, b]) x.actions.forEach(k => { if (k.dpr) k.dpr = k.dpr + ' + 12'; }); return [a, b, holdMonster(pc('Wizard')), clericCmd()]; };
const BURN_SCENARIOS = [
  { name: 'B1: adult dragon, 3 LR, Wisdom -1 (the rest +7); Fighter, Barbarian, Wizard, Cleric', players: burnParty, encounters: () => [{ monsters: [dragon(3, { wis: -1 })] }] },
  { name: 'B2: the same dragon with +14 saves across the board', players: burnParty, encounters: () => [{ monsters: [dragon(3, ALL(14))] }] },
  { name: 'B3: the dragon with 1 LR (Wisdom -1)', players: burnParty, encounters: () => [{ monsters: [dragon(1, { wis: -1 })] }] },
  { name: 'B4: 3 LR, Wisdom -1, but a damage-heavy party (+12 per attack) drops it in about two rounds', players: bigHitters, encounters: () => [{ monsters: [dragon(3, { wis: -1 })] }] },
  { name: 'B5 open: as B1 with the dragon hitting at 0.25 (so a blind party has a fight); the party reads the truth', players: burnParty, know: { party: 'open' }, encounters: () => [{ monsters: [dragon(3, { wis: -1 }, 0, 0.25)] }] },
  { name: 'B5 blind: the same; it can only guess three LR and +2 saves', players: burnParty, know: { party: 'blind' }, encounters: () => [{ monsters: [dragon(3, { wis: -1 }, 0, 0.25)] }] },
  { name: 'B5 learn: the same; it probes the save, counts LR as they go', players: burnParty, know: { party: 'learn' }, encounters: () => [{ monsters: [dragon(3, { wis: -1 }, 0, 0.25)] }] },
  { name: 'B7: the dragon is immune to every condition the party inflicts (Wisdom -1, 3 LR): control is worth nothing, damage is all there is', players: burnParty, encounters: () => [{ monsters: [immune(dragon(3, { wis: -1 }))] }] },
  { name: 'B2 learn: +14 saves, the party learns: it should probe a little, then race', players: burnParty, know: { party: 'learn' }, encounters: () => [{ monsters: [dragon(3, ALL(14))] }] },
  { name: 'B4 learn: damage-heavy party, Wisdom -1: race', players: bigHitters, know: { party: 'learn' }, encounters: () => [{ monsters: [dragon(3, { wis: -1 })] }] },
  { name: 'B8 learn: weak Charisma (-1), the rest +14, but the party burns with Wisdom: race, few slots wasted', players: burnParty, know: { party: 'learn' }, encounters: () => [{ monsters: [dragon(3, Object.assign(ALL(14), { cha: -1 }))] }] },
  { name: 'B9 learn: a day, goblins / ogres / the dragon last (Wisdom -1)', players: burnParty, know: { party: 'learn' }, encounters: () => [{ monsters: [mon('Goblin Warrior', 4)] }, { monsters: [mon('Ogre', 2)] }, { monsters: [dragon(3, { wis: -1 })] }] },
  { name: 'B6: a day, the dragon last (goblins / ogres / dragon, Wisdom -1)', players: burnParty, encounters: () => [{ monsters: [mon('Goblin Warrior', 4)] }, { monsters: [mon('Ogre', 2)] }, { monsters: [dragon(3, { wis: -1 })] }] },
];
function playBurn(sc, N) {
  const noBurn = pl => pl.forEach(p => { p.ext = p.ext || {}; p.ext.aiProfile = { burn: { bias: 0 } }; });
  const forced = pl => pl.forEach(p => { p.ext = p.ext || {}; p.ext.aiProfile = { burn: { bias: 30 } }; });   // always burns when it can: shows what burning costs or wins
  const noProbe = pl => pl.forEach(p => { p.ext = p.ext || {}; p.ext.aiProfile = { burn: { probeBias: 0 } }; });   // learn mode as step 2.6 played it: a doubt in the plan, no probes
  const learn = sc.know && sc.know.party === 'learn';
  const arms = V2ONLY ? [['v2+', { party: 'v2' }, null]] : [['v1', undefined, null], ['v2-', { party: 'v2' }, noBurn]].concat(learn ? [['v2o', { party: 'v2' }, noProbe]] : [], [['v2+', { party: 'v2' }, null], ['v2!', { party: 'v2' }, forced]]);
  const cs = Object.assign({ record: true, metrics: BURN_METRICS }, sc);
  console.log('\n' + sc.name);
  console.log('  ' + [pad('AI', 4), lpad('win', 12), lpad('rounds', 7), lpad('deaths', 7), lpad('dealt', 7), lpad('taken', 7), lpad('ms', 6)].concat(Object.keys(BURN_METRICS).map(k => lpad(k, Math.max(8, k.length + 2)))).join(' '));
  for (const [label, ai, tw] of arms) console.log(row(label, play(cs, ai, N, tw)));
}

/* ---- step 2.9: does the party cast its strong control when the save looks winnable? (docs/ai-v2.md, Legendary Resistance) ----
   The same fight in open / learn / blind mode, v2 party; run with a filter: node tests/ai-compare.js 200 "^K[0-9]".
   'ctl casts' = Hold Monster / Hold Person / Command / Hideous Laughter / Hypnotic Pattern aimed at a foe, 'first rd' = round of the first
   (0 = never), 'stuns' = the Monk's Stunning Strike attacks. */
const CTL_RE = /: (Hold Monster|Hold Person|Command|Tasha's Hideous Laughter|Hypnotic Pattern)(?: \(L\d\))?,/;
const isCtl = (r, e) => e.kind === 'save' && CTL_RE.test(e.text || '') && teamOf(r, e.uid) === 'party';
const CTL_METRICS = {
  'ctl casts': r => r.events.filter(e => isCtl(r, e)).length,
  'first rd': r => { let rd = 0; for (const e of r.events) { if (e.kind === 'round') rd = +(/[0-9]+/.exec(e.text) || [0])[0]; if (isCtl(r, e)) return rd; } return 0; },
  'LR burned': lrBurned,
  'stuns': r => r.events.filter(e => e.kind === 'attack' && /^Monk → [^:]+: Stunning Strike/.test(e.text || '')).length,
};
const martialParty = () => ['Monk', 'Fighter', 'Rogue', 'Barbarian'].map(pc);
const bardParty = () => [pc('Fighter'), pc('Barbarian'), holdMonster(pc('Wizard')), pc('Bard')];
const CTL_SCENARIOS = [
  { name: 'K1: 2 Hill Giants (Huge, no LR, Wisdom -1); Fighter, Barbarian, Wizard (Hold Monster), Cleric (Command)', players: burnParty, encounters: () => [{ monsters: [mon('Hill Giant', 2)] }] },
  { name: 'K2: dragon with no LR, Wisdom -1 (hits at 0.25)', players: burnParty, encounters: () => [{ monsters: [dragon(0, { wis: -1 }, 0, 0.25)] }] },
  { name: 'K3: dragon with 3 LR, Wisdom -1', players: burnParty, encounters: () => [{ monsters: [dragon(3, { wis: -1 }, 0, 0.25)] }] },
  { name: 'K4: dragon with 3 LR and +14 saves everywhere (hopeless)', players: burnParty, encounters: () => [{ monsters: [dragon(3, ALL(14), 0, 0.25)] }] },
  { name: 'K5: dragon immune to every condition (Wisdom -1, 3 LR)', players: burnParty, encounters: () => [{ monsters: [immune(dragon(3, { wis: -1 }, 0, 0.25))] }] },
  { name: 'K6 martials: Monk, Fighter, Rogue, Barbarian vs 2 Hill Giants (Stunning Strike against Constitution +4)', players: martialParty, encounters: () => [{ monsters: [mon('Hill Giant', 2)] }] },
  { name: 'K7 martials: the same party vs a dragon with 3 LR, Constitution -1', players: martialParty, encounters: () => [{ monsters: [dragon(3, { con: -1 }, 0, 0.25)] }] },
  { name: 'K8: the K2 dragon (no LR, Wisdom -1) with a Bard (Hypnotic Pattern, Hideous Laughter) instead of the Cleric', players: bardParty, encounters: () => [{ monsters: [dragon(0, { wis: -1 }, 0, 0.25)] }] },
  // the threat estimate: where reading strength from what a creature does should work, and where it can't
  { name: 'T1 weak hitter, big HP: the dragon at a quarter damage, no LR', players: burnParty, encounters: () => [{ monsters: [dragon(0, { wis: -1 }, 0, 0.25)] }] },
  { name: 'T2 glass cannon: 2 Gladiators at 1.5 damage, 30 HP', players: burnParty, encounters: () => [{ monsters: [withHp(scaled(mon('Gladiator', 2), 1.5), 30)] }] },
  { name: 'T3 Medium brute: a Gladiator with 250 HP', players: burnParty, encounters: () => [{ monsters: [withHp(mon('Gladiator'), 250)] }] },
  { name: 'T4 swarm: 16 Goblin Warriors', players: burnParty, encounters: () => [{ monsters: [mon('Goblin Warrior', 16)] }] },
  { name: 'T5 boss with minions: a Hill Giant and 6 Goblin Warriors', players: burnParty, encounters: () => [{ monsters: [mon('Hill Giant'), mon('Goblin Warrior', 6)] }] },
];
function playCtl(sc, N) {
  console.log('\n' + sc.name);
  console.log('  ' + [pad('mode', 6), lpad('win', 12), lpad('rounds', 7), lpad('deaths', 7), lpad('dealt', 7), lpad('taken', 7), lpad('ms', 6)].concat(Object.keys(CTL_METRICS).map(k => lpad(k, Math.max(8, k.length + 2)))).join(' '));
  for (const mode of KNOW ? [KNOW.party] : ['open', 'learn', 'blind']) console.log(row(mode, play(Object.assign({}, sc, { record: true, metrics: CTL_METRICS, know: { party: mode } }), { party: 'v2' }, N)));
}


/* ---- reactions as a layer (step 3b, docs/ai-v2.md): the same fight in open / learn / blind, v2 party; node tests/ai-compare.js 200 "^RC".
   Zaki's own sheets (Eldar: Shield, Counterspell, Silvery Barbs; Tacitus: Uncanny Dodge; Kraax: Deflect Attacks). Run with ENGINE=<an older engine> for the "before". */
const ZAKI = (() => { const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'parties', 'zaki-party-level-5.json'), 'utf8')); return j.players || j; })();
const zk = name => { const c = ZAKI.find(x => x.name.indexOf(name) === 0); if (!c) throw new Error('no Zaki sheet ' + name); return clone(c); };
const reactCount = re => r => r.events.filter(e => e.kind === 'react' && re.test(e.text || '')).length;
const REACT_METRICS = {
  'shield': reactCount(/ (casts|uses) Shield/),
  'barbs': reactCount(/Silvery Barbs/),
  'counter': reactCount(/Counterspell/),
  'cut': reactCount(/uses (Uncanny Dodge|Deflect Attacks)/),
  'ready': reactCount(/readied attack/),
  'readies': r => r.events.filter(e => /readies /.test(e.text || '')).length,
  'dodges': r => r.events.filter(e => /Dodg/.test(e.text || '') && teamOf(r, e.uid) === 'party').length,
};
const REACT_SCENARIOS = [
  { name: 'RC1 Counterspell: Eldar, Fighter vs 2 Mages', players: () => [zk('Eldar'), pc('Fighter')], encounters: () => fights('Mage*2') },
  { name: 'RC2 Shield: Eldar, Fighter vs 2 Hill Giants + Ogre', players: () => [zk('Eldar'), pc('Fighter')], encounters: () => fights('Hill Giant*2,Ogre') },
  { name: 'RC3 Uncanny Dodge: Tacitus, Fighter, Cleric vs 2 Gladiators', players: () => [zk('Tacitus'), pc('Fighter'), pc('Cleric')], encounters: () => fights('Gladiator*2') },
  { name: 'RC4 Deflect Attacks: Kraax, Fighter vs 4 Manticores (spikes)', players: () => [zk('Kraax'), pc('Fighter')], encounters: () => fights('Manticore*4') },
  { name: 'RC5 Ready: Kraax, Tacitus, Fighter vs Young Green Dragon, 30 ft apart', players: () => [zk('Kraax'), zk('Tacitus'), pc('Fighter')], encounters: () => fights('Young Green Dragon'), layout: { gapFt: 30 } },
  { name: 'RC5b Ready: Kraax, Fighter vs 2 Wyverns, 30 ft apart', players: () => [zk('Kraax'), pc('Fighter')], encounters: () => fights('Wyvern*2'), layout: { gapFt: 30 } },
  { name: "RC6 Zaki's party on hard-day.json", players: () => ZAKI.map(clone), encounters: () => clone(fixture('hard-day.json').encounters) },
  { name: "RC7 Zaki's party: goblins / ogres + mage / Young Green Dragon", players: () => ZAKI.map(clone), encounters: () => fights('Goblin Warrior*6/Ogre*2,Mage/Young Green Dragon') },
];
function playReact(sc, N) {
  console.log(String.fromCharCode(10) + sc.name);
  console.log('  ' + [pad('mode', 6), lpad('win', 12), lpad('rounds', 7), lpad('deaths', 7), lpad('dealt', 7), lpad('taken', 7), lpad('ms', 6)].concat(Object.keys(REACT_METRICS).map(k => lpad(k, Math.max(8, k.length + 2)))).join(' '));
  for (const mode of KNOW ? [KNOW.party] : ['open', 'learn', 'blind']) console.log(row(mode, play(Object.assign({}, sc, { record: true, metrics: REACT_METRICS, know: { party: mode } }), { party: 'v2' }, N)));
}

/* ---- downed allies (step 2.12) ---- */
// a limited-use healing potion as the sheet reader builds it
const withPotions = (p, n) => {
  p.ext = Object.assign({}, p.ext, { resources: Object.assign({}, p.ext && p.ext.resources, { 'Potion of Healing': { uses: n, reset: 'lr' } }) });
  p.actions.push({ id: p.id + '-potion', name: 'Potion of Healing', actionSlot: 1, freq: 'at will', condition: 'ally under half HP', targets: 1, type: 'heal', amount: '2d4 + 2', target: 'ally with the least HP', ext: { range: 5, resource: 'Potion of Healing', potion: true } });
  return p;
};
const zaki = () => clone(JSON.parse(fs.readFileSync(path.join(ROOT, 'parties/zaki-party-level-5.json'), 'utf8')).players);
// DOWN_NOW: the names knocked to 0 HP as the day's first fight starts ('Wizard:2' also gives it two death-save failures)
let DOWN_NOW = null, KILL_NOW = null;     // KILL_NOW: the same, dead
const realTurn = Tac.Sim.prototype.turn;
Tac.Sim.prototype.turn = function (u) {
  if (DOWN_NOW && this.fightNo === 0 && !this._downDone) {
    this._downDone = true;
    for (const o of this.units) for (const n of DOWN_NOW) { const [nm, f] = n.split(':'); if (o.team === 'party' && o.name.indexOf(nm) === 0) { this.downPC(o); o.deathF = +f || 0; } }
  }
  if (KILL_NOW && this.fightNo === 0 && !this._killDone) {
    this._killDone = true;
    for (const o of this.units) if (o.team === 'party' && KILL_NOW.some(n => o.name.indexOf(n) === 0)) this.kill(o, null, 'scenario');
  }
  return realTurn.call(this, u);
};
// the party's front line at (14,7), n foes of one kind round it
const around = (name, n, who) => encs => {
  const m = encs[0].monsters.find(x => x.name === name), pos = {}, ring = [[15, 7], [15, 6], [15, 8], [13, 6], [13, 8], [14, 6], [14, 8]];
  for (let i = 0; i < n; i++) pos['foes|' + m.id + '|' + i] = { x: ring[i][0], y: ring[i][1] };
  pos['party|' + who + '|0'] = { x: 14, y: 7 };
  return { 0: { gapFt: 30, positions: pos } };
};
const potionRogue = () => withPotions(pc('Rogue'), 2);
const DOWN_SCENARIOS = [
  { name: 'D1 healer, downed Fighter: Cleric, Wizard, Rogue (Fighter down) vs Hill Giant + 3 Ogres', party: ['Fighter', 'Cleric', 'Wizard', 'Rogue'], day: 'Hill Giant,Ogre*3', down: ['Fighter'] },
  { name: 'D2 downed Fighter beside 3 Gnoll Warriors: Cleric, Wizard, Rogue vs 20 Gnoll Warriors', party: ['Fighter', 'Cleric', 'Wizard', 'Rogue'], day: 'Gnoll Warrior*20', down: ['Fighter'], layoutFn: around('Gnoll Warrior', 3, 'c5-fighter') },
  { name: 'D3 downed healer: Cleric down; Bard, Fighter, Rogue (2 potions) vs 2 Hill Giants + 2 Ogres', players: () => [pc('Cleric'), pc('Bard'), pc('Fighter'), potionRogue()], encounters: () => fights('Hill Giant*2,Ogre*2'), down: ['Cleric'] },
  { name: 'D4 two downed: Fighter and Barbarian down; Cleric, Bard, Wizard vs 2 Hill Giants + 3 Ogres', party: ['Fighter', 'Barbarian', 'Cleric', 'Bard', 'Wizard'], day: 'Hill Giant*2,Ogre*3', down: ['Fighter', 'Barbarian'] },
  { name: 'D5 potions only: Fighter down; Rogue (2 potions), Monk, Barbarian vs 2 Hill Giants + 3 Ogres', players: () => [pc('Fighter'), potionRogue(), pc('Monk'), pc('Barbarian')], encounters: () => fights('Hill Giant*2,Ogre*3'), down: ['Fighter'] },
  { name: 'D6 a day: downed Fighter in fight 1; Cleric, Bard, Rogue vs 10 goblins / Hill Giant + 3 Ogres / 2 Bandit Captains + 10 Bandits', party: ['Fighter', 'Cleric', 'Bard', 'Rogue'], day: 'Goblin Warrior*10/Hill Giant,Ogre*3/Bandit Captain*2,Bandit*10', down: ['Fighter'] },
  { name: "D7 Zaki's party, Kraax down, vs 2 Hill Giants + 4 Ogres + 6 Gnoll Warriors", players: zaki, encounters: () => fights('Hill Giant*2,Ogre*4,Gnoll Warrior*6'), down: ['Kraax'] },
  { name: "D8 Zaki's party, Faithwalker down, vs 2 Hill Giants + 4 Ogres + 6 Gnoll Warriors", players: zaki, encounters: () => fights('Hill Giant*2,Ogre*4,Gnoll Warrior*6'), down: ['Faithwalker'] },
  { name: "D9 Zaki's party vs hard-day.json", players: zaki, encounters: () => clone(fixture('hard-day.json').encounters) },
  { name: 'D10 two downed, the Wizard at two failures, the Fighter at none; Cleric, Bard, Rogue vs 2 Hill Giants + 3 Ogres', party: ['Fighter', 'Wizard', 'Cleric', 'Bard', 'Rogue'], day: 'Hill Giant*2,Ogre*3', down: ['Fighter', 'Wizard:2'] },
  { name: 'D11 the same, the Fighter at two failures, the Wizard at none', party: ['Fighter', 'Wizard', 'Cleric', 'Bard', 'Rogue'], day: 'Hill Giant*2,Ogre*3', down: ['Fighter:2', 'Wizard'] },
];
/* DOWNED=1: per downed ally, did a v2 creature that could have healed it do so? A chance = a turn of a standing creature with a
   heal in reach of it (move + range, line of sight not checked); an event = one time at 0 HP with at least one chance */
function downedRate(sc, N, know) {
  const c = { ev: 0, evHealed: 0, bTurns: 0, bUsed: 0, aTurns: 0, aUsed: 0, v1Turns: 0, v1Used: 0 };
  const proto = Tac.Sim.prototype, wrapped = proto.turn;
  const seen = new Map();
  const note = key => { let e = seen.get(key); if (!e) { e = { healed: 0 }; seen.set(key, e); } return e; };
  proto.turn = function (u) {
    const down = u.team === 'party' && this.alive(u) && !this.incap(u) ? this.alliesOf(u).filter(o => o.onBoard && !o.dead && o.hp <= 0) : [];
    if (!down.length) return wrapped.call(this, u);
    const reach = (a, t) => a.type === 'heal' && this.usable(u, a) && this.condOk(u, a) && a.target !== 'self' && a._range !== 0 && !(a.ext && a.ext.aid) && !a.tempHP && !(a.ext && a.ext.revivify) && this.dist(u, t) <= this.speedOf(u) + Math.max(5, a._range || 5);
    const bon = down.filter(t => u.actions.some(a => a.actionSlot === 1 && reach(a, t))), act = down.filter(t => u.actions.some(a => a.actionSlot === 0 && reach(a, t)));
    const could = down.filter(t => bon.includes(t) || act.includes(t));
    if (!could.length) return wrapped.call(this, u);
    for (const t of could) note(this.fightNo + '|' + t.uid + '|' + t.downs);
    const before = u.healed;
    wrapped.call(this, u);
    const up = could.filter(t => t.hp > 0 && u.healed > before);
    for (const t of up) note(this.fightNo + '|' + t.uid + '|' + t.downs).healed = 1;
    if (!u.v2) { c.v1Turns++; if (up.length) c.v1Used++; return; }
    if (bon.length) { c.bTurns++; if (up.length) c.bUsed++; } else { c.aTurns++; if (up.length) c.aUsed++; }
  };
  for (let i = 0; i < N; i++) {
    const encounters = sc.encounters ? sc.encounters() : fights(sc.day), players = sc.players ? sc.players() : sc.party.map(pc);
    const layouts = sc.layoutFn ? sc.layoutFn(encounters) : sc.layout ? Object.fromEntries(encounters.map((e, k) => [k, sc.layout])) : undefined;
    seen.clear(); DOWN_NOW = sc.down || null;
    Tac.runDay({ players, encounters }, { seed: (1000 + i * 7919) >>> 0, ai: { party: 'v2' }, partyAI: 'tactical', layouts, know: sc.know || { party: know } });
    for (const e of seen.values()) { c.ev++; c.evHealed += e.healed; }
  }
  proto.turn = wrapped; DOWN_NOW = null;
  const rate = (a, b) => b ? lpad((a / b * 100).toFixed(0) + '%', 5) : lpad('-', 5);
  console.log(['  ' + pad(sc.name.slice(0, 74), 74), lpad(c.ev, 6), rate(c.evHealed, c.ev), lpad(c.bTurns, 6), rate(c.bUsed, c.bTurns), lpad(c.aTurns, 6), rate(c.aUsed, c.aTurns), lpad(c.v1Turns, 6), rate(c.v1Used, c.v1Turns)].join(' '));
  return c;
}
function playDown(sc, N) {
  console.log('\n' + sc.name);
  console.log('  ' + [pad('mode', 6), lpad('win', 12), lpad('rounds', 7), lpad('deaths', 7), lpad('dealt', 7), lpad('taken', 7), lpad('ms', 6)].concat(AREA_COLS.map(k => lpad(k, Math.max(8, k.length + 2)))).join(' '));
  for (const mode of KNOW ? [KNOW.party] : ['open', 'learn', 'blind']) { DOWN_NOW = sc.down || null; console.log(row(mode, play(Object.assign({ record: true }, sc, { know: { party: mode }, metrics: Object.assign({}, sc.metrics, AREA_METRICS) }), { party: 'v2' }, N))); DOWN_NOW = null; }
}
/* the enemy's area attacks (breaths, cones, Fireballs) against the party: party creatures caught per use, the day's first use of each and the later ones */
const foeAreas = r => r.events.filter(e => e.kind === 'aoe' && e.shape !== 'aura' && teamOf(r, e.uid) === 'foes');
const caughtIn = (r, e) => (e.hits || []).filter(h => teamOf(r, h) === 'party').length;
const firstOf = r => { const seen = new Set(); return foeAreas(r).map(e => { const k = e.uid + '|' + (/unleashes (.*?) \(/.exec(e.text || '') || [])[1]; const f = !seen.has(k); seen.add(k); return { e, first: f }; }); };
const AREA_METRICS = {
  _breaths: r => foeAreas(r).length,
  _b1: r => firstOf(r).filter(x => x.first).length,
  _c1: r => firstOf(r).filter(x => x.first).reduce((s, x) => s + caughtIn(r, x.e), 0),
  _b2: r => firstOf(r).filter(x => !x.first).length,
  _c2: r => firstOf(r).filter(x => !x.first).reduce((s, x) => s + caughtIn(r, x.e), 0),
};
const AREA_COLS = ['breaths', 'caught/1st', 'caught/2nd+', 'caught/breath'];

/* ---- Caustic Brew: a burn scored as a burn (step 2.12) ---- */
const BREW_SCENARIOS = [
  { name: "E1 Zaki's party vs Young Red Dragon (one target)", players: zaki, encounters: () => fights('Young Red Dragon') },
  { name: "E2 Zaki's party vs Young Red Dragon + 2 Ogres", players: zaki, encounters: () => fights('Young Red Dragon,Ogre*2') },
  { name: "E3 Zaki's party vs 2 Stone Golems (long fight, few targets)", players: zaki, encounters: () => fights('Stone Golem*2') },
  { name: "E4 Zaki's party vs 7 Ogres (a line to catch)", players: zaki, encounters: () => fights('Ogre*7') },
  { name: "E5 Zaki's party vs 24 Gnoll Warriors", players: zaki, encounters: () => fights('Gnoll Warrior*24') },
  { name: "E6 Zaki's party, a day: 2 Ogres + 5 Gnoll Warriors / Troll + 2 Ogres / Young Red Dragon", players: zaki, encounters: () => fights('Ogre*2,Gnoll Warrior*5/Troll,Ogre*2/Young Red Dragon') },
];

/* ---- Revivify (step 2.12) ---- */
const noRevivify = players => { for (const p of players) if (p.ext && p.ext.spellbook) p.ext.spellbook.spells = p.ext.spellbook.spells.filter(s => !(s.ext && s.ext.revivify)); };
// results carry the day's running count per creature: this fight's is what it added
let revivedSoFar = 0;
const REVIVE_METRICS = { 'revived/day': (r, k) => { const all = r.party.reduce((t, p) => t + (p.revived || 0), 0), got = all - (k ? revivedSoFar : 0); revivedSoFar = all; return got; } };
const lastSlots = (n, id) => players => { const p = players.find(x => x.id === id || x.name === id); p.ext.spellbook.slots[2] = n; return players; };
/* ---- breath and cone spacing (docs/ai-v2.md): node tests/ai-compare.js 200 '^S[0-9]' ---- */
const ZAKI_IDS = () => zaki().map(p => p.id);
// the party's six starting squares (spread: 4 squares apart; clustered: a 2 x 3 block), the foe(s) at x 17
const SPREAD6 = [[3, 1], [3, 5], [3, 9], [3, 13], [6, 3], [6, 11]], CLUSTER6 = [[4, 6], [4, 7], [4, 8], [5, 6], [5, 7], [5, 8]];
const startAt = (cells, ids) => encs => {
  const pos = {}, pl = ids();
  pl.forEach((id, i) => { if (cells[i]) pos['party|' + id + '|0'] = { x: cells[i][0], y: cells[i][1] }; });
  encs[0].monsters.forEach((m, k) => { for (let i = 0; i < (m.count || 1); i++) pos['foes|' + m.id + '|' + i] = { x: 17, y: 3 + (k * 2 + i) * 4 }; });
  return { 0: { gapFt: 30, positions: pos } };
};
const groundDragon = name => { const m = mon(name); m.ext.fly = 0; m.ext.hover = false; return m; };
// a Huge giant with a cone: the Hill Giant plus a 20-ft stomp first in its list (the old AI takes the first usable action) (Recharge 5-6, 6d10 bludgeoning, Dexterity save for half)
const stompGiant = () => { const m = mon('Hill Giant'); m.actions.unshift({ id: m.id + 'st', name: 'Stomp', actionSlot: 0, freq: { reset: 'recharge', cooldownRounds: 3 }, recharge: true, condition: 'is available', targets: 6, type: 'atk', useSaves: true, halfOnSave: true, toHit: 14, dpr: '6d10', target: 'enemy with most HP', ext: { range: 20, area: { shape: 'cone', size: 20 }, saveAbility: 'dex', damageType: 'bludgeoning' } }); return m; };
const meleeParty = () => ['Fighter', 'Barbarian', 'Monk', 'Paladin', 'Rogue'].map(pc);
const SPACE_SCENARIOS = [
  { name: "S1 Zaki's party vs Young Red Dragon on the ground, spread start", players: zaki, encounters: () => [{ monsters: [groundDragon('Young Red Dragon')] }], layoutFn: startAt(SPREAD6, ZAKI_IDS) },
  { name: "S2 the same, clustered start", players: zaki, encounters: () => [{ monsters: [groundDragon('Young Red Dragon')] }], layoutFn: startAt(CLUSTER6, ZAKI_IDS) },
  { name: "S3 Zaki's party vs the harness Adult Red Dragon (Huge, 60-ft cone, 0.35 damage): breath after breath", players: zaki, encounters: () => [{ monsters: [dragon(0, {})] }] },
  { name: 'S4 melee-heavy: Fighter, Barbarian, Monk, Paladin, Rogue vs Young Red Dragon on the ground', players: meleeParty, encounters: () => [{ monsters: [groundDragon('Young Red Dragon')] }] },
  { name: 'S5 Huge giants: Fighter, Barbarian, Wizard, Cleric vs 2 Hill Giants with a 20-ft stomp (Recharge 5-6, 6d10)', party: ['Fighter', 'Barbarian', 'Wizard', 'Cleric'], encounters: () => [{ monsters: [stompGiant(), stompGiant()] }] },
  { name: "S6 Zaki's party vs Young Red Dragon (flying), clustered start", players: zaki, encounters: () => [{ monsters: [mon('Young Red Dragon')] }], layoutFn: startAt(CLUSTER6, ZAKI_IDS) },
];
const FLYER_SCENARIOS = [
  { name: "F1 Zaki's party vs 2 Young Green Dragons", players: zaki, encounters: () => fights('Young Green Dragon*2') },
  { name: "F2 Zaki's party vs hard-day.json, then 2 Young Green Dragons", players: zaki, encounters: () => clone(fixture('hard-day.json').encounters).concat(fights('Young Green Dragon*2')) },
];
const REVIVE_SCENARIOS = [
  { name: "R1 Zaki's party vs a hard day: 2 Ogres + 5 Gnoll Warriors / 3 Ogres / Hill Giant + 2 Ogres / 2 Bandit Captains + 6 Bandits", players: zaki, encounters: () => fights('Ogre*2,Gnoll Warrior*5/Ogre*3/Hill Giant,Ogre*2/Bandit Captain*2,Bandit*6') },
  { name: "R2 Zaki's party vs hard-day.json", players: zaki, encounters: () => clone(fixture('hard-day.json').encounters) },
  { name: 'R3 a Cleric with exactly one 3rd-level slot: Fighter, Cleric, Rogue, Wizard vs 2 Ogres + 3 Bugbear Warriors / Hill Giant + 2 Ogres / 2 Bandit Captains + 6 Bandits', players: () => lastSlots(1, 'Cleric')(['Fighter', 'Cleric', 'Rogue', 'Wizard'].map(pc)), encounters: () => fights('Ogre*2,Bugbear Warrior*3/Hill Giant,Ogre*2/Bandit Captain*2,Bandit*6') },
  { name: 'R4 the same with the usual two 3rd-level slots', party: ['Fighter', 'Cleric', 'Rogue', 'Wizard'], encounters: () => fights('Ogre*2,Bugbear Warrior*3/Hill Giant,Ogre*2/Bandit Captain*2,Bandit*6') },
  // natural deaths almost never leave the caster standing with a slot (docs/ai-v2.md), so these start the day with one
  { name: 'R5 one 3rd-level slot, the Fighter dead as fight 1 starts: R3 day', kill: ['Fighter'], players: () => lastSlots(1, 'Cleric')(['Fighter', 'Cleric', 'Rogue', 'Wizard'].map(pc)), encounters: () => fights('Ogre*2,Bugbear Warrior*3/Hill Giant,Ogre*2/Bandit Captain*2,Bandit*6') },
  { name: 'R6 two 3rd-level slots, the Fighter dead as fight 1 starts: R3 day', kill: ['Fighter'], party: ['Fighter', 'Cleric', 'Rogue', 'Wizard'], encounters: () => fights('Ogre*2,Bugbear Warrior*3/Hill Giant,Ogre*2/Bandit Captain*2,Bandit*6') },
  { name: "R7 Zaki's party, Kraax dead as fight 1 starts: 2 Ogres + 5 Gnoll Warriors / 3 Ogres / Hill Giant + 2 Ogres", kill: ['Kraax'], players: zaki, encounters: () => fights('Ogre*2,Gnoll Warrior*5/Ogre*3/Hill Giant,Ogre*2') },
];
// the arm with Revivify but no reserve: the slot is priced like any other, though the pool still leaves out what is kept
const noKeep = players => { for (const p of players) p.ext = Object.assign({}, p.ext, { aiProfile: { pacing: { reviveLife: 0, reviveDay: 0 } } }); };
function playRevive(sc, N) {
  console.log('\n' + sc.name);
  console.log('  ' + [pad('mode', 12), lpad('win', 12), lpad('rounds', 7), lpad('deaths', 7), lpad('dealt', 7), lpad('taken', 7), lpad('ms', 6), lpad('revived/day', 13)].join(' '));
  for (const mode of KNOW ? [KNOW.party] : ['open', 'learn', 'blind']) for (const [tag, tw] of [['', noRevivify], ['+nokeep', noKeep], ['+revive', null]]) {
    KILL_NOW = sc.kill || null;
    console.log(row(mode + tag, play(Object.assign({}, sc, { know: { party: mode }, metrics: REVIVE_METRICS }), { party: 'v2' }, N, tw)).replace(/^ {2}(\S+)\s/, (m, l) => '  ' + pad(l, 12) + ' '));
    KILL_NOW = null;
  }
}

/* ---- running ---- */
// sweeps: AI_W='{"control":1.5}' (and AI_PACING, AI_BURN) merge into every party member's profile, on top of a scenario's own tweak
const AI_OVER = ['w', 'pacing', 'burn', 'react'].reduce((o, k) => { const v = process.env['AI_' + k.toUpperCase()]; if (v) (o = o || {})[k] = JSON.parse(v); return o; }, null);
const aiOver = spec => {
  const base = typeof spec === 'string' ? { base: spec } : Object.assign({}, spec);
  for (const k in AI_OVER) base[k] = Object.assign({}, base[k], AI_OVER[k]);
  return base;
};
if (process.env.AI_THREAT) Object.assign(Tac.AI_BASE.threat, JSON.parse(process.env.AI_THREAT));     // sweeps: AI_THREAT='{"useSave":0}'
// KNOW=learn: the party's knowledge in every scenario that doesn't name its own. V2ONLY=1: skip the old-AI and no-burn arms. THREAT=bounds: learn with the bloodied reading alone, THREAT=off: the classic reading.
const KNOW = process.env.KNOW ? { party: process.env.KNOW } : undefined, V2ONLY = process.env.V2ONLY === '1';
function play(sc, ai, n, tweak) {
  const out = { n, won: 0, rounds: 0, deaths: 0, dealt: 0, taken: 0, ms: 0, m: {}, spells: new Map() };
  const t0 = Date.now(), downWas = DOWN_NOW;
  if (sc.down) DOWN_NOW = sc.down;              // a plain scenario can start with someone down too (H9); playDown sets it itself
  for (let i = 0; i < n; i++) {
    const seed = (1000 + i * 7919) >>> 0;
    const encounters = sc.encounters ? sc.encounters() : fights(sc.day);
    const players = sc.players ? sc.players() : sc.party.map(pc);
    if (tweak) tweak(players);
    if (AI_OVER) for (const p of players) p.ext = Object.assign({}, p.ext, { aiProfile: aiOver(p.ext && p.ext.aiProfile) });
    const layouts = sc.layoutFn ? sc.layoutFn(encounters) : sc.layout ? Object.fromEntries(encounters.map((e, k) => [k, sc.layout])) : undefined;
    let res = Tac.runDay({ players, encounters }, { seed, ai, partyAI: 'tactical', record: !!sc.record, layouts, know: sc.know || KNOW, rules: process.env.CS ? { counterspell: process.env.CS } : undefined, prefightBuffs: process.env.PREFIGHT === '0' ? false : undefined, threat: process.env.THREAT === 'off' ? false : process.env.THREAT });
    // A scenarios: a fight still to come today (for pacing), but only the first one is scored
    const nf = sc.only0 ? 1 : encounters.length;
    if (sc.only0) res = res.slice(0, 1);
    const last = res[res.length - 1];
    if (res.length === nf && res.every(r => r.won)) out.won++;
    out.deaths += last ? last.party.filter(p => p.dead).length : 0;
    res.forEach((r, k) => {
      out.rounds += r.rounds;
      for (const p of r.party) { out.dealt += p.dealt; out.taken += p.taken; }
      if (sc.metrics) for (const key in sc.metrics) if (sc.metrics[key]) out.m[key] = (out.m[key] || 0) + sc.metrics[key](r, k, nf);
      if (sc.spells) for (const x of SPELLS(r)) out.spells.set(x, (out.spells.get(x) || 0) + 1);
    });
  }
  out.ms = (Date.now() - t0) / n;
  DOWN_NOW = downWas;
  if (sc.metrics && '_uses' in sc.metrics) out.m['damage prevented/use'] = out.m._uses ? out.m._prevented / out.m._uses * n : 0;
  if (sc.metrics && '_areas' in sc.metrics) out.m['caught/area'] = out.m._areas ? out.m._caught / out.m._areas * n : 0;
  if (sc.metrics && '_breaths' in sc.metrics) {
    out.m['breaths'] = out.m._breaths;
    out.m['caught/1st'] = out.m._b1 ? out.m._c1 / out.m._b1 * n : 0;
    out.m['caught/2nd+'] = out.m._b2 ? out.m._c2 / out.m._b2 * n : 0;
    out.m['caught/breath'] = out.m._breaths ? (out.m._c1 + out.m._c2) / out.m._breaths * n : 0;
  }
  return out;
}
const pad = (s, k) => String(s).padEnd(k);
const lpad = (s, k) => String(s).padStart(k);
/* ACCURACY=1: a learning v2 party's estimate of each enemy's maximum HP over its true value (1 = right), the bloodied reading vs
   threat estimate: median [10th-90th percentile] at the start of rounds 1, 3 and 5, and just before and after the
   enemy's first bloodied moment. Filter picks the scenarios, as usual. */
function accuracy(sc, N) {
  const proto = Tac.Sim.prototype, ev = proto.ev, learnHp = proto.learnHp;
  const arm = threat => {
    const got = { r1: [], r3: [], r5: [], pre: [], post: [] };
    const obs = s => s.units.find(o => o.team === 'party' && !o.dead && o.hp > 0) || s.units.find(o => o.team === 'party');
    proto.ev = function (kind, text, data) {
      if (kind === 'round' && [1, 3, 5].includes(this.round)) {
        const seen = new Set(), who = obs(this);
        for (const t of this.units) if (t.team === 'foes' && t.hp > 0 && !seen.has(t.tplId)) { seen.add(t.tplId); got['r' + this.round].push(this.kMax(who, t) / t.maxHp); }
      }
      return ev.call(this, kind, text, data);
    };
    proto.learnHp = function (t) {
      if (t.team !== 'foes') return learnHp.call(this, t);
      const was = t.bloodied, who = obs(this), a = this.kMax(who, t);
      learnHp.call(this, t);
      const key = '_blood' + t.tplId;
      if (!was && t.bloodied && !this[key]) { this[key] = true; got.pre.push(a / t.maxHp); got.post.push(this.kMax(who, t) / t.maxHp); }
    };
    for (let i = 0; i < N; i++) {
      const encounters = sc.encounters ? sc.encounters() : fights(sc.day), players = sc.players ? sc.players() : sc.party.map(pc);
      const layouts = sc.layoutFn ? sc.layoutFn(encounters) : sc.layout ? Object.fromEntries(encounters.map((e, k) => [k, sc.layout])) : undefined;
      Tac.runDay({ players, encounters }, { seed: (1000 + i * 7919) >>> 0, ai: { party: 'v2' }, partyAI: 'tactical', layouts, know: { party: 'learn' }, threat });
    }
    proto.ev = ev; proto.learnHp = learnHp;
    return got;
  };
  const cell = l => { if (!l.length) return lpad('-', 18); const s = l.slice().sort((p, q) => p - q), q = f => s[Math.floor(f * (s.length - 1))].toFixed(2); return lpad(`${q(0.5)} [${q(0.1)}-${q(0.9)}]`, 18); };
  console.log('\n' + sc.name);
  console.log('  ' + [pad('', 7), lpad('round 1', 18), lpad('round 3', 18), lpad('round 5', 18), lpad('before bloodied', 18), lpad('after bloodied', 18)].join(' '));
  for (const [label, th] of [['bounds', 'bounds'], ['threat', undefined]]) { const g = arm(th); console.log('  ' + [pad(label, 7), cell(g.r1), cell(g.r3), cell(g.r5), cell(g.pre), cell(g.post)].join(' ')); }
}
function row(label, o) {
  const f = (x, d) => (x / o.n).toFixed(d === undefined ? 1 : d);
  const p = o.won / o.n, se = Math.sqrt(p * (1 - p) / o.n);
  const cells = [pad(label, 4), lpad((p * 100).toFixed(1) + '±' + (se * 100).toFixed(1) + '%', 12), lpad(f(o.rounds), 7), lpad(f(o.deaths, 2), 7), lpad(f(o.dealt, 0), 7), lpad(f(o.taken, 0), 7), lpad(o.ms.toFixed(0), 6)];
  for (const k in o.m) if (k[0] !== '_') cells.push(lpad(f(o.m[k], 2), Math.max(8, k.length + 2)));
  return '  ' + cells.join(' ');
}

const N = Math.max(1, parseInt(process.argv[2], 10) || 200);
const only = (() => { const re = process.argv[3] ? new RegExp(process.argv[3], 'i') : /./; const [K, S] = (process.env.SHARD || '0/1').split('/').map(Number); let i = 0; return { test: n => n === 'timing' ? false : (i++ % S === K) && re.test(n) }; })();
console.log(`Old AI (v1) vs AI v2 for the party, ${N} seeded runs per scenario. Per day: win = won every fight; rounds, PC deaths, damage dealt and taken by the party; ms per day.`);
const spellLine = o => Array.from(o.spells).sort((p, q) => q[1] - p[1]).slice(0, 6).map(([k, v]) => `${k} ${(v / o.n).toFixed(2)}`).join(', ');
if (process.env.DOWNED === '1') {
  const all = BURN_SCENARIOS.concat(CTL_SCENARIOS, SCENARIOS, DOWN_SCENARIOS).filter(sc => sc.side !== 'foes' && (!only || only.test(sc.name)));
  for (const know of KNOW ? [KNOW.party] : ['learn', 'open', 'blind']) {
    console.log('\n' + pad(know, 76) + ' events healed | turns with a bonus heal, used | with only an action heal, used | v1 creatures, used');
    const sum = { ev: 0, evHealed: 0, bTurns: 0, bUsed: 0, aTurns: 0, aUsed: 0 };
    for (const sc of all) { const c = downedRate(sc, N, know); for (const k in sum) sum[k] += c[k]; }
    console.log(`  TOTAL events ${sum.ev}, healed ${(sum.evHealed / sum.ev * 100).toFixed(1)}%; bonus-heal turns ${sum.bTurns}, used ${(sum.bUsed / sum.bTurns * 100).toFixed(1)}%; action-heal turns ${sum.aTurns}, used ${(sum.aUsed / sum.aTurns * 100).toFixed(1)}%`);
  }
  process.exit(0);
}
if (process.env.ACCURACY === '1') {
  for (const sc of BURN_SCENARIOS.concat(CTL_SCENARIOS, SCENARIOS)) if (!only || only.test(sc.name)) accuracy(sc, N);
  process.exit(0);
}
for (const sc of BURN_SCENARIOS) if (!only || only.test(sc.name)) playBurn(sc, N);
for (const sc of CTL_SCENARIOS) if (only && only.test(sc.name)) playCtl(sc, N);
for (const sc of DOWN_SCENARIOS) if (only && only.test(sc.name)) playDown(sc, N);
for (const sc of REACT_SCENARIOS) if (only && only.test(sc.name)) playReact(sc, N);
for (const sc of REVIVE_SCENARIOS) if (only && only.test(sc.name)) playRevive(sc, N);
for (const sc of BREW_SCENARIOS) if (only && only.test(sc.name)) playDown(sc, N);
for (const sc of FLYER_SCENARIOS) if (only && only.test(sc.name)) playDown(sc, N);
for (const sc of SPACE_SCENARIOS) if (only && only.test(sc.name)) playDown(sc, N);
for (const sc of SCENARIOS) {
  if (only && !only.test(sc.name)) continue;
  const v2 = sc.side === 'foes' ? { foes: 'v2' } : { party: 'v2' };
  const a = V2ONLY ? { n: N, won: 0, rounds: 0, deaths: 0, dealt: 0, taken: 0, ms: 0, m: {}, spells: new Map() } : play(sc, undefined, N), b = play(sc, v2, N);
  const extra = Object.keys(a.m).filter(k => k[0] !== '_');
  console.log('\n' + sc.name);
  console.log('  ' + [pad('AI', 4), lpad('win', 12), lpad('rounds', 7), lpad('deaths', 7), lpad('dealt', 7), lpad('taken', 7), lpad('ms', 6)].concat(extra.map(k => lpad(k, Math.max(8, k.length + 2)))).join(' '));
  if (!V2ONLY) console.log(row('v1', a));
  console.log(row('v2', b));
  if (sc.spells) { console.log('    v1 casts/day: ' + spellLine(a)); console.log('    v2 casts/day: ' + spellLine(b)); }
}
// what a day costs to simulate with no replay recorded (as the odds runs play it)
if (!only || only.test('timing')) {
  const T = Math.max(20, Math.round(N / 2));
  const time = (players, encounters, ai) => { const t0 = Date.now(); for (let i = 0; i < T; i++) Tac.runDay({ players: players(), encounters: encounters() }, { seed: 5000 + i * 7919, ai, partyAI: 'tactical' }); return (Date.now() - t0) / T; };
  console.log(`\nTiming, ${T} days each, no replay (ms per day):`);
  for (const [label, pl, en] of [
    ['default party vs hard-day', () => clone(D.PP), () => clone(fixture('hard-day.json').encounters)],
    ['Wizard, Cleric, Sorcerer, Bard vs goblins / ogres', () => ['Wizard', 'Cleric', 'Sorcerer', 'Bard'].map(pc), () => fights('Goblin Warrior*10/Ogre*3')],
  ]) console.log(`  ${pad(label, 52)} v1 ${lpad(time(pl, en, undefined).toFixed(1), 7)}   v2 ${lpad(time(pl, en, 'v2').toFixed(1), 7)}`);
}
