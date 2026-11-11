/* =====================================================================
   TACTICAL ENGINE — plays fights out with real dice on a grid.
   Reads the day JSON exported by the Statblock Forge.
   Pure JS, no DOM. Exposes global `TacEngine`.

   The engine is the files in js/engine/, loaded in the order listed in tools/engine-files.js (index.html and every
   Node script follow that list): after js/forge.js, before js/war-table.js. All of them must stay DOM-free:
   tests/run.js loads them under Node.

   Each file is its own closure. Sim.prototype.* methods find each other through `this`, so their file order does not
   matter. The free helpers and constants a later file needs are handed on through one object, ENG: a file ends with
   `Object.assign(ENG, { what later files use })` and starts with `const { what it uses } = ENG;`. `npm test`
   ("Engine modules") checks both lists against the code. day.js, the last file, replaces the placeholder with the
   public TacEngine.

     base.js        (this file) RNG & dice, constants, range inference, damage types, unit construction, spellbooks,
                    the Sim constructor
     grid.js        areas of effect (areaSpec, areaCells, inArea), terrain, line of sight, cover, hiding, area aiming,
                    distances, occupancy and the movement maps
     ai-v2-data.js  AI_BASE, AI_PROFILES, AI_TIERS: every AI v2 weight and threshold, and who gets which profile
     knowledge.js   WHAT EACH SIDE KNOWS (the k* accessors, learning, the threat estimate) and the estimates both AIs use
     core.js        the rules: events, buffs & conditions, uses, movement, rolling, damage/healing/death, damage zones,
                    triggers, executing actions (resolveAttackAction, doAction)
     reactions.js   reactions as a layer: Shield, Silvery Barbs, Lucky, the damage cutters, Counterspell, Ready
     ai-v1.js       the classic AI: spell choice, tactical turn planning (tacticalTurnInner, plan), choose
     ai-v2.js       AI v2: who plays it, casters, pacing, danger, posture, what an option is worth, the burn plan
     ai-boss.js     the boss tier: legendary and lair actions, Legendary Resistance, recharge, ext.aiPlan
     ai-v2-turn.js  the v2 turn: squares × options (v2TurnInner), intent lines, re-aiming, bonus actions, surges
     encounter.js   a creature's turn (turn), flying height, legendary & lair, morale, running an encounter, placement
     day.js         a whole adventuring day (runDay, monteCarlo, summarize), previews, then the TacEngine export
   ===================================================================== */
(function (root) {
'use strict';
const ENG = {};
root.TacEngine = { _: ENG };

/* ---------------- RNG & dice ---------------- */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const R = function () {            // mulberry32
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  R.d = n => 1 + Math.floor(R() * n);
  R.pick = arr => arr[Math.floor(R() * arr.length)];
  return R;
}

const diceCache = new Map();
function parseDice(expr) {
  if (expr === undefined || expr === null || expr === '') return { dice: [], flat: 0 };
  if (typeof expr === 'number') return { dice: [], flat: expr };
  const key = String(expr);
  if (diceCache.has(key)) return diceCache.get(key);
  const s = key.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
  const out = { dice: [], flat: 0 };
  const re = /([+-]?)(\d*)d(\d+)|([+-]?)(\d+(?:\.\d+)?)/gi;
  let m;
  while ((m = re.exec(s))) {
    if (m[3]) out.dice.push({ n: m[2] === '' ? 1 : parseInt(m[2], 10), d: parseInt(m[3], 10), s: m[1] === '-' ? -1 : 1 });
    else if (m[5]) out.flat += (m[4] === '-' ? -1 : 1) * parseFloat(m[5]);
  }
  diceCache.set(key, out);
  return out;
}
function rollDice(expr, R, crit) {
  const p = parseDice(expr);
  let t = p.flat;
  for (const g of p.dice) {
    const n = g.n * (crit ? 2 : 1);
    for (let i = 0; i < n; i++) t += g.s * R.d(g.d);
  }
  return t;
}
function avgDice(expr) {
  const p = parseDice(expr);
  return p.flat + p.dice.reduce((t, g) => t + g.s * g.n * (g.d + 1) / 2, 0);
}

/* ---------------- constants ---------------- */
const INCAP = ['Incapacitated', 'Paralyzed', 'Petrified', 'Stunned', 'Unconscious'];
// conditions worth burning Lucky or Legendary Resistance on
const DANGER_CONDS = ['Incapacitated', 'Paralyzed', 'Stunned', 'Unconscious', 'Petrified', 'Restrained', 'Blinded', 'Frightened', 'Attacks and saves with Disadvantage'];
const ADV_TARGET = ['Blinded', 'Paralyzed', 'Restrained', 'Stunned', 'Unconscious', 'Petrified', 'Is attacked with Advantage', 'Attacks and is attacked with Advantage'];
const ADV_SELF = ['Invisible', 'Attacks with Advantage', 'Attacks and is attacked with Advantage'];
const DIS_TARGET = ['Invisible', 'Is attacked with Disadvantage'];
const DIS_SELF = ['Blinded', 'Frightened', 'Poisoned', 'Restrained', 'Attacks with Disadvantage', 'Attacks and saves with Disadvantage'];
const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
/* squares a creature covers along each side (5e grid: Large 2x2, Huge 3x3, Gargantuan 4x4). A unit's x,y is the top-left
   square of its footprint; u.n holds the side. */
const FOOT = { Large: 2, Huge: 3, Gargantuan: 4 };
const footOf = size => FOOT[size] || 1;
const sizeIdx = (s, d) => { const i = SIZES.indexOf(s || ''); return i < 0 ? d : i; };
const KNOW_MODES = ['open', 'blind', 'learn'];

const TEMPLATES = {
  'Bane':  { actionSlot: 0, type: 'debuff', targets: 3, buff: { duration: 'entire encounter', toHit: '-1d4', save: '-1d4' }, saveDC: 0 },
  'Bless': { actionSlot: 0, type: 'buff', targets: 3, buff: { duration: 'entire encounter', toHit: '1d4', save: '1d4' } },
  'Fireball': { actionSlot: 0, type: 'atk', targets: 2, useSaves: true, dpr: '8d6', halfOnSave: true, toHit: 0 },
  'Heal': { actionSlot: 0, type: 'heal', targets: 1, amount: 70 },
  'Hypnotic Pattern': { actionSlot: 0, type: 'debuff', targets: 2, saveDC: 0, buff: { duration: '1 round', condition: 'Incapacitated' } },
  'Meteor Swarm': { actionSlot: 0, type: 'atk', targets: 4, useSaves: true, dpr: '20d6 + 20d6', halfOnSave: true, toHit: 0 },
  'Shield': { actionSlot: 4, type: 'buff', targets: 1, target: 'self', buff: { duration: '1 round', ac: 5 } },
};

function finalizeAction(a) {
  if (a.type !== 'template') return a;
  const o = a.templateOptions || {};
  const t = TEMPLATES[o.templateName];
  if (!t) return null;
  const r = JSON.parse(JSON.stringify(t));
  Object.assign(r, { id: a.id, name: o.templateName, freq: a.freq, condition: a.condition, target: t.target || o.target, ext: a.ext });
  if (r.type === 'atk' && o.toHit !== undefined) r.toHit = o.toHit;
  if (r.type === 'debuff' && o.saveDC !== undefined) r.saveDC = o.saveDC;
  if (!r.target) r.target = r.type === 'atk' || r.type === 'debuff' ? 'enemy with most HP' : 'ally with the least HP';
  return r;
}

/* ---------------- range inference (when the day file has no ext.range) ---------------- */
function inferRange(a) {
  const ex = a.ext || {};
  if (typeof ex.range === 'number') return { range: ex.range, inferred: false };
  const n = (a.name || '').toLowerCase();
  const g = r => ({ range: r, inferred: true });
  if (a.target === 'self') return g(0);
  if (a.actionSlot === 5 || a.actionSlot === 6) return g(10);                 // passive auras
  if (a.type === 'heal') return g(/word|light|ranged|spirit|potion/.test(n) ? 60 : 5);
  if (a.type === 'buff') return g(30);
  if (/burning hands|cone|breath|thunderwave|shatter|pulse|nova/.test(n)) return g(15);
  if (a.type === 'debuff' || a.useSaves) return g(60);
  if (/longbow|crossbow|shortbow|\bbow\b|arrow/.test(n)) return g(80);
  if (/blast|bolt|ray|orb|missile|sling|dart|spit|squirt|bomb|beam|gaze|rebuke|guiding|hurl|rock/.test(n)) return g(60);
  if (/lash|whip|tether/.test(n)) return g(10);
  if (/throw|javelin|thrown/.test(n)) return g(20);
  return g(5);
}

/* ---------------- damage types ---------------- */
const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];
const listOf = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
function dmgModsOf(ex) {
  const m = { resist: listOf(ex.resist), immune: listOf(ex.immune), vulnerable: listOf(ex.vulnerable) };
  return m.resist.length || m.immune.length || m.vulnerable.length ? m : null;
}
/* how much of a hit of this type gets through: 0 immune, 0.5 resistant, 2 vulnerable (resist + vulnerable = 1).
   "nonmagical slashing" only counts against nonmagical attacks (spells and ext.magical are magical). */
function typeMult(mods, type, magical) {
  if (!mods || !type) return 1;
  const has = (list) => list.includes(type) || (!magical && list.includes('nonmagical ' + type));
  if (has(mods.immune)) return 0;
  let m = 1;
  if (has(mods.resist)) m *= 0.5;
  if (has(mods.vulnerable)) m *= 2;
  return m;
}
/* the multiplier for an action's damage against a target: "a / b" = the attacker's best choice, "a + b" = the
   parts by share (ext.damageMix gives the shares; even split otherwise) */
/* the target's damage mods with any buff resistances (Rage…) folded in */
function modsOf(t) {
  if (!t) return null;
  const extra = t.buffs && t.buffs.filter(b => b.resist && b.resist.length);
  if (!extra || !extra.length) return t.dmgMods;
  const m = t.dmgMods ? { resist: t.dmgMods.resist.slice(), immune: t.dmgMods.immune, vulnerable: t.dmgMods.vulnerable } : { resist: [], immune: [], vulnerable: [] };
  extra.forEach(b => b.resist.forEach(x => { if (m.resist.indexOf(x) < 0) m.resist.push(x); }));
  return m;
}
function damageMultFor(a, t, typeOverride) {
  const mods = modsOf(t);
  const type = typeOverride || (a && a.ext && a.ext.damageType);
  if (!mods || !type) return 1;
  const magical = !!(a && (a._spell || (a.ext && a.ext.magical)));
  const s = String(type).toLowerCase();
  if (s.indexOf('/') >= 0) return Math.max(...s.split('/').map(x => typeMult(mods, x.trim(), magical)));
  if (s.indexOf('+') >= 0) {
    const parts = s.split('+').map(x => x.trim());
    const mix = a && a.ext && Array.isArray(a.ext.damageMix) && !typeOverride ? a.ext.damageMix : parts.map(p => [p, 1]);
    const tot = mix.reduce((q, p) => q + (+p[1] || 0), 0) || 1;
    return mix.reduce((q, p) => q + (+p[1] || 0) / tot * typeMult(mods, String(p[0]).toLowerCase(), magical), 0);
  }
  return typeMult(mods, s, magical);
}
/* the type a "a / b / c" attacker picks against this target (for the log) */
function bestTypeFor(a, t) {
  const s = String((a && a.ext && a.ext.damageType) || '').toLowerCase();
  if (s.indexOf('/') < 0 || !t || !t.dmgMods) return null;
  const magical = !!(a._spell || (a.ext && a.ext.magical));
  return s.split('/').map(x => x.trim()).sort((p, q) => typeMult(t.dmgMods, q, magical) - typeMult(t.dmgMods, p, magical))[0];
}

/* ---------------- unit construction ---------------- */
function avgPerTurn(actions) {
  const a = actions.find(x => x && x.type === 'atk' && x.actionSlot === 0);
  return a ? avgDice(a.dpr) * (a.useSaves ? 1 : (a.targets || 1)) : 0;
}

const AI_TYPES = ['regular', 'tactical', 'beast'];
// Default when the creature doesn't say: animals, oozes and plants fight like beasts, everything else like a regular monster
function autoAI(tpl) {
  const t = String(tpl.type || '').toLowerCase();
  return ['beast', 'ooze', 'plant'].includes(t) ? 'beast' : 'regular';
}

/* ---------------- spellbooks ----------------
   ext.spellbook = { slots: [L1, L2, … L9], slotReset: 'lr' | 'sr', conSave?: n,
                     spells: [ { ...an ordinary action, level: 0-9, concentration?: true, upcast?: '1d8' } ] }
   On the War Table a caster with a spellbook ignores the actions compiled from it for the export
   (ext.fromSpellbook) and instead picks, every turn, whichever spell is worth the slot right now. */
function spellbookOf(tpl) {
  const sb = tpl && tpl.ext && tpl.ext.spellbook;
  return sb && Array.isArray(sb.spells) && sb.spells.length ? sb : null;
}
/* who AI v2 drives as a caster (docs/ai-v2.md "Casters"): 'full' (wizard, sorcerer, warlock, cleric, druid, bard;
   any monster with a spellbook), 'half' (paladin, ranger, artificer), 'third' (any other class with a spellbook),
   'none' (no spellbook). ext.casterKind overrides the guess. */
const FULL_CASTERS = ['wizard', 'sorcerer', 'warlock', 'cleric', 'druid', 'bard'], HALF_CASTERS = ['paladin', 'ranger', 'artificer'];
function casterKind(tpl) {
  const ex = (tpl && tpl.ext) || {};
  if (['full', 'half', 'third', 'none'].includes(ex.casterKind)) return ex.casterKind;
  if (!spellbookOf(tpl)) return 'none';
  const cls = String((tpl.class && tpl.class.type) || '').toLowerCase();
  if (!cls || FULL_CASTERS.includes(cls)) return 'full';
  return HALF_CASTERS.includes(cls) ? 'half' : 'third';
}
/* Divine Smite (2024): a bonus-action spell cast right after a melee weapon hit (docs/ai-v2.md "Hybrids"). The spell keeps its old
   self-buff shape for the old AI and the exports; ext.smite (or the name, for sheets read before it existed) tells v2 it is a rider */
const SMITE_DEF = { dice: '2d8', up: 1, max: 5, type: 'radiant', foes: ['fiend', 'undead'], foeDice: 1 };
function smiteOf(a) {
  if (!a || !a._spell || !a._spell.level) return null;
  const s = a.ext && a.ext.smite;
  if (s) return typeof s === 'object' ? Object.assign({}, SMITE_DEF, s) : SMITE_DEF;
  return /^divine smite\b/i.test(a.name || '') && a.type === 'buff' ? SMITE_DEF : null;
}
/* the smite's dice cast at slot level L on t (an extra die on a fiend or undead), as "Nd8" */
function smiteDice(s, a, L, t) {
  const g = parseDice(s.dice).dice[0] || { n: 2, d: 8 };
  let n = Math.min(s.max, g.n + (s.up || 0) * Math.max(0, L - a._spell.level));
  if (t && !t.isPC && s.foes && s.foes.indexOf(String((t.tpl && t.tpl.type) || '').toLowerCase()) >= 0) n += s.foeDice || 0;
  return n + 'd' + g.d;
}
// the same effect doesn't stack: "Hunter's Mark (Favored Enemy, free)" and the spell Hunter's Mark
const effectName = n => String(n || '').toLowerCase().replace(/\s*\(.*$/, '').trim();
// a pool of hit points (Lay on Hands: ext.pool with die 1): v2 picks how many to spend (docs/ai-v2.md "Hybrids")
const isHpPool = a => !!(a && a.type === 'heal' && a.ext && a.ext.pool && a.ext.pool.die === 1);
function spellActions(sb) {
  return sb.spells.filter(sp => sp && sp.type).map(sp => {
    const lvl = Math.max(0, Math.min(9, parseInt(sp.level, 10) || 0));
    const base = Object.assign({}, sp, { id: 'sb:' + sp.id, freq: 'at will', condition: 'default',
      actionSlot: typeof sp.actionSlot === 'number' ? sp.actionSlot : 0, targets: sp.targets || 1 });
    const a = finalizeAction(base);
    if (!a) return null;
    a._spell = { level: lvl, conc: !!sp.concentration, upcast: sp.upcast || null, upcastTargets: sp.upcastTargets || 0 };
    return a;
  }).filter(Boolean);
}
/* Arcane Recovery and the like: on a short rest, win back expended slots up to a total level, highest first */
function recoverSlots(u) {
  let budget = u.recovery.levels, got = false;
  const top = Math.min(9, u.recovery.maxSlot || 5);
  for (let l = Math.min(top, budget); l >= 1; l--) {
    while (budget >= l && u.slots[l - 1] < u.slotsMax[l - 1]) { u.slots[l - 1]++; budget -= l; got = true; }
  }
  if (!got) return;
  u.recoveryUsed = true;
  (u.recovery.restores || []).forEach(id => { const a = u.actions.find(x => x.id === id); if (a && u.uses.has(id)) u.uses.set(id, Math.min((a.freq && a.freq.uses) || 1, u.uses.get(id) + 1)); });
}
function makeUnit(tpl, team, idx, count, isPC) {
  const ex = tpl.ext || {};
  const sb = spellbookOf(tpl);
  const baseActs = (tpl.actions || []).filter(a => !(sb && a.ext && a.ext.fromSpellbook) && !(a.ext && a.ext.wtSkip));   // wtSkip: export-only stand-ins for features simulated natively here
  const actions = baseActs.map(finalizeAction).filter(Boolean).concat(sb ? spellActions(sb) : []).map(a => {
    const r = inferRange(a);
    return Object.assign({}, a, { _range: r.range, _rangeInferred: r.inferred });
  });
  const u = {
    uid: team + ':' + tpl.id + ':' + idx,
    key: team + '|' + tpl.id + '|' + idx,
    tplId: tpl.id,
    name: count > 1 ? tpl.name + ' ' + (idx + 1) : tpl.name,
    team, isPC,
    tpl, actions,
    maxHp: tpl.hp, hp: tpl.hp, temp: 0,
    baseAC: tpl.AC, saveBonus: tpl.saveBonus || 0,
    saves: ex.saves && typeof ex.saves === 'object' ? ex.saves : null,     // { str, dex, con, int, wis, cha }
    fly: typeof ex.fly === 'number' && ex.fly > 0 ? ex.fly : 0,
    climb: typeof ex.climb === 'number' && ex.climb > 0 ? ex.climb : 0,
    hover: !!ex.hover,                                                     // can stay up when knocked prone or stopped
    alt: 0,                                                                 // height above the ground under it, in 5-ft steps (flyers only)
    noOA: !!ex.noOpportunityAttacks,
    indomitable: ex.indomitable && ex.indomitable.uses ? { uses: +ex.indomitable.uses, bonus: +ex.indomitable.bonus || 0 } : null,   // reroll a failed save
    saveAdvVs: Array.isArray(ex.saveAdvVs) ? ex.saveAdvVs.map(c => String(c).toLowerCase()) : [],                          // Advantage on saves against these conditions
    resMax: ex.resources && typeof ex.resources === 'object' ? ex.resources : null,                                         // shared pools: { 'Superiority Dice': { uses, reset, regainOnInit } }                                        // "can't make opportunity attacks"
    critOn: typeof ex.critRange === 'number' && ex.critRange >= 15 && ex.critRange < 20 ? ex.critRange : 20,   // Champion: weapon crits on 19–20
    dmgMods: dmgModsOf(ex),                                                 // { resist, immune, vulnerable } by damage type, or null
    condImmune: Array.isArray(ex.condImmune) ? ex.condImmune.map(c => String(c).toLowerCase()) : [],     // climb speed: scales ledges with no check and no extra cost
    sneak: ex.sneakAttack && ex.sneakAttack.dice ? ex.sneakAttack : null,   // { dice: '2d6', assassinate: 4 }
    assassinate: !!ex.assassinate,                                          // advantage vs anyone who hasn't acted yet, round 1
    luckMax: typeof ex.luck === 'number' ? ex.luck : 0,
    legResMax: typeof ex.legendaryResistance === 'number' ? ex.legendaryResistance : 0,   // Legendary Resistance uses per day                     // Lucky feat points per long rest
    steadyAim: !!ex.steadyAim,
    packTactics: !!ex.packTactics,                                          // advantage when an ally is next to the target
    speed: Math.max(typeof ex.speed === 'number' ? ex.speed : 30, typeof ex.fly === 'number' ? ex.fly : 0),
    size: ex.size || 'Medium',
    n: footOf(ex.size),
    blindsight: !!ex.blindsight, elvenAccuracy: !!ex.elvenAccuracy,
    initBonus: typeof ex.initBonus === 'number' ? ex.initBonus : 0,
    initAdv: !!ex.initAdvantage,
    dexAdv: !!ex.dexSaveAdvantage,                                          // Danger Sense: advantage on Dex saves while it can see and act
    brutalCrit: typeof ex.brutalCritical === 'number' ? ex.brutalCritical : 0,   // extra weapon dice on a melee crit
    relentless: ex.relentlessRage && +ex.relentlessRage.hp > 0 ? { hp: +ex.relentlessRage.hp } : null,   // drops to this many HP instead of 0 while raging (Con save)
    escapeBonus: (ex.escapeBonus !== undefined && ex.escapeBonus !== '') ? Number(ex.escapeBonus) : (tpl.saveBonus || 0),
    athletics: typeof ex.athletics === 'number' ? ex.athletics : ((ex.escapeBonus !== undefined && ex.escapeBonus !== '') ? Number(ex.escapeBonus) : (ex.saves && typeof ex.saves.str === 'number' ? ex.saves.str : (tpl.saveBonus || 0))),
    legendaryMax: typeof ex.legendaryActions === 'number' ? ex.legendaryActions : 3,
    hasLegendary: actions.some(a => a.actionSlot === 2),
    aiSet: AI_TYPES.includes(ex.ai) ? ex.ai : null,
    ai: AI_TYPES.includes(ex.ai) ? ex.ai : autoAI(tpl),
    dpr: avgPerTurn(actions),
    uses: new Map(),           // day-persistent limited uses
    x: 0, y: 0,
  };
  if (sb) {
    u.slotsMax = Array.from({ length: 9 }, (_, i) => Math.max(0, parseInt((sb.slots || [])[i], 10) || 0));
    u.slots = u.slotsMax.slice();
    u.slotReset = sb.slotReset === 'sr' ? 'sr' : 'lr';
    u.conSave = typeof sb.conSave === 'number' ? sb.conSave : (u.saves && typeof u.saves.con === 'number' ? u.saves.con : u.saveBonus);
    u.hasSpells = true;
    u.casterKind = casterKind(tpl);
    u.recovery =sb.recovery && sb.recovery.levels ? sb.recovery : null;   // e.g. Arcane Recovery { levels: 2, maxSlot: 5, restores: [actionId] }
  }
  u.baseFly = u.fly;
  // "takes one additional action" (Action Surge) sits outside the normal action lists: it's used at the end of a turn
  u.surges = u.actions.filter(a => a.ext && a.ext.extraAction);
  if (u.surges.length) { u.actions = u.actions.filter(a => !u.surges.includes(a)); u.surges.forEach(a => initUses(u, a)); }
  if (u.resMax) for (const k in u.resMax) u.uses.set('res:' + k, +u.resMax[k].uses || 0);
  if (u.indomitable) u.uses.set('__indom', u.indomitable.uses);
  u.uses.set('__luck', u.luckMax);
  u.uses.set('__legres', u.legResMax);
  resetFightState(u);
  u.actions.forEach(a => initUses(u, a));
  return u;
}
function freqKind(f) { return typeof f === 'string' ? f : (f && f.reset) || 'at will'; }
function initUses(u, a) {
  if (a.ext && a.ext.pool) { u.uses.set(a.id, a.ext.pool.dice || 1); return; }    // a pool of dice (Healing Light)
  const k = freqKind(a.freq);
  if (k === '1/day') u.uses.set(a.id, 1);
  else if (k === 'sr' || k === 'lr') u.uses.set(a.id, a.freq.uses || 1);
}
function resetFightState(u) {
  u.buffs = [];
  u.fightUses = new Map();     // 1/fight
  u.usedThisFight = new Set();
  u.recharge = new Map();      // actionId -> ready
  u.reaction = true;
  u.legendaryLeft = 0;
  u.grappledBy = null; u.grappleInfo = null;
  u.swallowedBy = null; u.swallowInfo = null;
  u.inside = [];               // uids this unit has swallowed
  u.insideDamage = new Map();
  u.deathS = 0; u.deathF = 0; u.stable = false;
  u.everDowned = false; u.downs = 0;
  u.focus = null; u.lastAttacker = null; u.lastIntent = ''; u.notedPacing = false;
  u.dmgDealt = 0; u.dmgTaken = 0; u.healed = 0;
  u.fightTurns = 0; u.visLost = 0; u.startFull = u.hp >= u.maxHp;           // what the other side can see happen this fight
  u.netLost = 0; u.bloodied = u.hp > 0 && u.hp * 2 <= u.maxHp;              // the damage that got through less the healing seen; at half HP or less, and the table is told
  u.seenHeal = false; u.seenRange = 0; u.seenAreas = null; u.areaUsed = null; u.seenCaster = false; u.seenCancel = false; u.legSeen = 0;
  u.onBoard = true;
  // Relentless & co.: rolling initiative with an empty pool gives one back
  if (u.resMax) for (const k in u.resMax) if (u.resMax[k].regainOnInit && !(u.uses.get('res:' + k) > 0)) u.uses.set('res:' + k, +u.resMax[k].regainOnInit);
  u.concentrating = null; u.slotTurn = -1; u.reserveSlot = false;
  u.tookTurn = false; u.vex = null; u.saSeq = -1; u.movedThisTurn = false;
  if (u.baseFly !== undefined) u.fly = u.baseFly;
  u.alt = 0;
}

/* ---------------- the encounter simulator ---------------- */
function Sim(opts) {
  this.R = makeRng(opts.seed);
  this.record = !!opts.record;
  this.events = [];
  this.W = opts.width || 24; this.H = opts.height || 16;
  this.escapePolicy = opts.escapePolicy || 'smart';
  this.surpriseRules = opts.surpriseRules || '2024';
  this.climbDC = typeof opts.climbDC === 'number' ? opts.climbDC : 10;    // Athletics DC to scale a ledge 10 ft or higher (99: climb speed only)
  this.tpkKills = !!opts.tpkKills;     // the whole party down with foes still standing: nobody is left to save them
  this.maxRounds = opts.maxRounds || 40;
  this.rules = { counterspell: opts.rules && opts.rules.counterspell === '2014' ? '2014' : '2024' };      // rule variants (docs/ai-v2.md, "Counterspell rules option")
  this.morale = opts.morale === 'on' || opts.morale === true;      // monsters may flee or surrender
  // AI v2 for non-casters (docs/ai-v2.md): 'v2' for both sides, or { party: 'v2', foes: 'v1' }
  const ai = opts.ai;
  this.aiV2 = ai === 'v2' ? { party: true, foes: true } : ai && typeof ai === 'object' && (ai.party === 'v2' || ai.foes === 'v2' || ai.foes === 'tiers') ? { party: ai.party === 'v2', foes: ai.foes === 'v2' || ai.foes === 'tiers', tiers: ai.foes === 'tiers' } : null;
  const kn = opts.know || {};
  this.know = { party: KNOW_MODES.includes(kn.party) ? kn.party : 'open', foes: KNOW_MODES.includes(kn.foes) ? kn.foes : 'open' };
  this.mem = { party: new Map(), foes: new Map() };     // learned per kind of creature, kept all day
  this.expectFights = +opts.expectFights > 0 ? Math.round(+opts.expectFights) : 0;   // fights the party expects today (learn/blind; 0 = learn knows, blind assumes)
  this.threatMode = opts.threat === false ? 0 : opts.threat === 'bounds' ? 1 : 2;   // learn on v2 (keen): 2 the threat estimate and the bloodied reading (default), 1 the bloodied reading alone, 0 the classic reading (docs/ai-v2.md)
  this.setTerrain(null);
}

Object.assign(ENG, { makeRng, parseDice, rollDice, avgDice, INCAP, DANGER_CONDS, ADV_TARGET, ADV_SELF, DIS_TARGET, DIS_SELF, sizeIdx, finalizeAction, inferRange, listOf, damageMultFor, bestTypeFor, AI_TYPES, autoAI, casterKind, smiteOf, smiteDice, effectName, isHpPool, recoverSlots, makeUnit, freqKind, resetFightState, Sim });
})(typeof window !== 'undefined' ? window : globalThis);
