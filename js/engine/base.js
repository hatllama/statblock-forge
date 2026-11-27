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
     choose.js      the plain picker the rest of the engine uses: choose, plan / planInner, mayHitDowned, slotCost
     ai-v2.js       the AI: casters, pacing, danger, posture, what an option is worth, the burn plan
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
const DIS_SELF = ['Blinded', 'Frightened', 'Poisoned', 'Prone', 'Restrained', 'Attacks with Disadvantage', 'Attacks and saves with Disadvantage'];
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

/* Magic Missile: darts, each its own target and damage, no attack roll (docs/ai-v2.md "Rules accuracy pass 2"). Data written before this (one
   3d4 + 3 "attack" at +99, or a plain export of the darts) reads the same: n d4 + n is n darts a swing, one more per slot level above the first */
function magicMissile(a) {
  if (!a || a.type !== 'atk' || a.useSaves || (a.ext && a.ext.darts) || !/^magic missile\b/i.test(a.name || '') || !(avgDice(a.toHit) >= 99)) return a;
  const p = parseDice(a.dpr), d = p.dice[0];
  if (p.dice.length !== 1 || d.d !== 4 || p.flat !== d.n) return a;
  return Object.assign({}, a, { dpr: '1d4 + 1', targets: d.n * (a.targets || 1), upcast: null, upcastTargets: 1, ext: Object.assign({}, a.ext, { darts: true }) });
}
function finalizeAction(a) {
  if (a.type !== 'template') return magicMissile(a);
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
   self-buff shape for the exports; ext.smite (or the name, for sheets read before it existed) tells v2 it is a rider */
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
  return sb.spells.filter(sp => sp && sp.type).map(magicMissile).map(sp => {
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
/* Hit Dice for the short rest (2024): ext.hitDice = { die, count, con } when the creature declares them (the class builds and the
   sheet reader do); otherwise from its class and level (older saved parties, Zaki's party file), with the Con modifier read back from its
   Con save (less proficiency for the classes that have it). No class and no hitDice: null, and a short rest heals it fully as before. */
const HIT_DIE = { barbarian: 12, fighter: 10, paladin: 10, ranger: 10, artificer: 8, bard: 8, cleric: 8, druid: 8, monk: 8, rogue: 8, warlock: 8, sorcerer: 6, wizard: 6 };
const CON_SAVE_CLASSES = { barbarian: 1, fighter: 1, sorcerer: 1 };
function hitDiceOf(tpl) {
  const ex = tpl.ext || {}, h = ex.hitDice;
  if (h && +h.die > 0 && +h.count > 0) return { die: +h.die, max: +h.count, left: +h.count, con: Math.round(+h.con || 0) };
  const c = tpl.class, die = c && HIT_DIE[c.type], lv = c ? Math.floor(+c.level) : 0;
  if (!die || !(lv > 0)) return null;
  const pb = 2 + Math.floor((lv - 1) / 4), sv = ex.saves && typeof ex.saves.con === 'number' ? ex.saves.con : 0;
  return { die, max: lv, left: lv, con: Math.round(sv - (CON_SAVE_CLASSES[c.type] ? pb : 0)) };
}
/* ---------------- custom mechanics: the trait vocabulary (ext.traits, docs/custom-mechanics.md) ----------------
   A trait is { name, when, if: [conditions], once, optional, do: [effects] }: plain data, every key a word below, nothing evaluated.
   validateTraits says what is wrong in words; compileTraits keeps the valid ones, grouped by trigger, for makeUnit (u.traits).
   `ai`: v2 scores the word (docs/custom-mechanics.md (iv)); every other word is simulated and neutral in scoring. */
const TRAITS_VERSION = 1;
const TRAIT_WHEN = ['turnStart', 'turnEnd', 'beforeAction', 'onHit', 'onMiss', 'onDamaged', 'onSave', 'roll'];
const TRAIT_KEYS = ['name', 'when', 'if', 'do', 'once', 'optional'];
const tStr = v => typeof v === 'string' && v.trim() !== '';
const tNum = v => typeof v === 'number' && isFinite(v);
const tDice = v => tNum(v) || (tStr(v) && /^[\d\sd+\-]+$/i.test(v) && /\d/.test(v));
const tScope = v => v === true || v === 'first' || v === 'all';
const PARTS = ['move', 'bonus', 'action'], ROLLS = ['attack', 'save', 'check'];
const TRAIT_IF = {
  notMoved: { ok: v => v === true, want: 'true' },
  has: { ok: v => !!v && tStr(v.res) && (v.min === undefined || tNum(v.min)), want: '{ res, min }', res: v => v.res },
  action: { ok: tStr, want: 'an action name' },
  weapon: { ok: tStr, want: 'a weapon (action) name' },
  ranged: { ok: v => typeof v === 'boolean', want: 'true or false' },
  melee: { ok: v => typeof v === 'boolean', want: 'true or false' },
  natural: { ok: v => tNum(v) && v >= 1 && v <= 20, want: 'a number 1-20', when: ['roll'] },
  rollIs: { ok: v => Array.isArray(v) && v.length > 0 && v.every(x => ROLLS.indexOf(x) >= 0), want: 'a list of attack, save, check', when: ['roll'] },
  vs: { ok: v => v === 'magic', want: '"magic"', when: ['onSave'] },
  nthHit: { ok: v => tNum(v) && v >= 1, want: 'a number from 1', when: ['onHit'] },
  ownTurn: { ok: v => typeof v === 'boolean', want: 'true or false' },
};
const TRAIT_DO = {
  gain: { ok: v => !!v && tStr(v.res) && (v.n === undefined || tNum(v.n)) && (v.cap === undefined || tNum(v.cap)) && (v.perUnused === undefined || (Array.isArray(v.perUnused) && v.perUnused.every(x => PARTS.indexOf(x) >= 0))),
          want: '{ res, n, perUnused: [move, bonus, action], cap }', res: v => v.res, ai: true },
  lose: { ok: v => !!v && tStr(v.res) && (v.n !== undefined ? tNum(v.n) : tNum(v.frac) && v.frac > 0 && v.frac <= 1) && (v.round === undefined || v.round === 'up' || v.round === 'down'),
          want: '{ res, n } or { res, frac, round: up|down }', res: v => v.res, ai: true },      // v2PointValue: what damage is expected to take from a held pool
  extraAttacks: { ok: v => !!v && tStr(v.pay) && (v.max === undefined || tNum(v.max)), want: '{ pay, max }', res: v => v.pay, when: ['beforeAction'], ai: true, optional: true },
  ignoreCover: { ok: v => v === true, want: 'true', when: ['beforeAction'], ai: true },
  noLongRangeDisadvantage: { ok: v => v === true, want: 'true', when: ['beforeAction'], inert: 'the War Table never shoots at long range' },
  ignoreLoading: { ok: v => v === true, want: 'true', when: ['beforeAction'], inert: 'loading is never modelled' },
  autoHit: { ok: tScope, want: '"first" or "all"', when: ['beforeAction'], ai: true },
  autoCrit: { ok: tScope, want: '"first" or "all"', when: ['beforeAction'], ai: true },
  ignoreResistance: { ok: tScope, want: '"first" or "all"', when: ['beforeAction'], ai: true },
  extraDamage: { ok: v => !!v && tDice(v.dice) && (v.type === undefined || typeof v.type === 'string'), want: '{ dice, type }', when: ['onHit'], ai: true },
  advantage: { ok: v => v === true, want: 'true', when: ['onSave', 'beforeAction'] },
  reroll: { ok: v => v === 'must', want: '"must"', when: ['roll'] },
  coin: { ok: v => !!v && (v.p === undefined || (tNum(v.p) && v.p >= 0 && v.p <= 1)) && (v.heads === undefined || Array.isArray(v.heads)) && (v.tails === undefined || Array.isArray(v.tails)),
          want: '{ p, heads: [effects], tails: [effects] }', when: ['beforeAction'], ai: true, optional: true },
  burn: { ok: v => v === true, want: 'true', when: ['beforeAction'], ai: true },         // a coin's tails that burns is priced as nothing done (v2TraitValue)
};
const tList = o => Object.keys(o).join(', ');
/* what is wrong with these traits, in words (an empty list: nothing). ext is the creature's ext; actions (optional) are checked for ext.req */
function validateTraits(ext, actions) {
  const out = [], ex = ext || {}, pools = ex.resources && typeof ex.resources === 'object' ? ex.resources : {};
  if (ex.traitsV !== undefined && !(ex.traitsV === TRAITS_VERSION)) out.push(`Custom mechanics: version ${ex.traitsV} is not one this Forge reads (it reads ${TRAITS_VERSION})`);
  const pool = (res, where) => { if (tStr(res) && !pools[res]) out.push(`${where}: no resource "${res}" (add it under Resources)`); };
  const conds = (list, when, where) => {
    if (!Array.isArray(list)) { out.push(`${where}: "if" must be a list of conditions`); return; }
    list.forEach((c, j) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) { out.push(`${where}, condition ${j + 1}: not an object`); return; }
      for (const k in c) {
        const w = TRAIT_IF[k];
        if (!w) { out.push(`${where}: unknown condition "${k}" (known: ${tList(TRAIT_IF)})`); continue; }
        if (!w.ok(c[k])) out.push(`${where}: condition "${k}" must be ${w.want}`);
        else if (w.res) pool(w.res(c[k]), where);
        if (w.when && when && w.when.indexOf(when) < 0) out.push(`${where}: condition "${k}" only works with when: ${w.when.join(' or ')}`);
      }
    });
  };
  const effects = (list, when, where, inCoin, optional) => {
    if (!Array.isArray(list) || (!inCoin && !list.length)) { out.push(`${where}: "do" must be a list of effects`); return; }
    list.forEach((e, j) => {
      const keys = e && typeof e === 'object' && !Array.isArray(e) ? Object.keys(e) : null;
      if (!keys || keys.length !== 1) { out.push(`${where}, effect ${j + 1}: each effect is an object with one word, like { "gain": … }`); return; }
      const k = keys[0], w = TRAIT_DO[k];
      if (!w) { out.push(`${where}: unknown effect "${k}" (known: ${tList(TRAIT_DO)})`); return; }
      if (!w.ok(e[k])) { out.push(`${where}: effect "${k}" must be ${w.want}`); return; }
      if (w.res) pool(w.res(e[k]), where);
      if (w.when && when && w.when.indexOf(when) < 0) out.push(`${where}: effect "${k}" only works with when: ${w.when.join(' or ')}`);
      if (k === 'gain' && e[k].perUnused && when !== 'turnEnd') out.push(`${where}: "perUnused" only works with when: turnEnd`);
      if (k === 'coin') {
        if (inCoin) out.push(`${where}: a coin inside a coin`);
        else { effects(e.coin.heads || [], when, where + ' (heads)', true); effects(e.coin.tails || [], when, where + ' (tails)', true); }
      }
    });
    if (optional && !list.some(e => e && typeof e === 'object' && Object.keys(e).some(k => TRAIT_DO[k] && TRAIT_DO[k].optional))) out.push(`${where}: "optional" only works with a word the AI decides (coin, extraAttacks)`);
  };
  if (ex.traits !== undefined) {
    if (!Array.isArray(ex.traits)) out.push('Custom mechanics: ext.traits must be a list');
    else ex.traits.forEach((t, i) => {
      const where = `Trait ${i + 1}${t && tStr(t.name) ? ` ("${t.name}")` : ''}`;
      if (!t || typeof t !== 'object' || Array.isArray(t)) { out.push(`${where}: not an object`); return; }
      for (const k in t) if (TRAIT_KEYS.indexOf(k) < 0) out.push(`${where}: unknown key "${k}" (known: ${TRAIT_KEYS.join(', ')})`);
      if (TRAIT_WHEN.indexOf(t.when) < 0) out.push(`${where}: unknown trigger "${t.when}" (known: ${TRAIT_WHEN.join(', ')})`);
      if (t.once !== undefined && t.once !== 'turn' && t.once !== 'round') out.push(`${where}: "once" must be "turn" or "round"`);
      if (t.optional !== undefined && typeof t.optional !== 'boolean') out.push(`${where}: "optional" must be true or false`);
      if (t.if !== undefined) conds(t.if, t.when, where);
      effects(t.do, t.when, where, false, t.optional === true);
    });
  }
  (actions || []).forEach(a => { if (a && a.ext && a.ext.req !== undefined) conds(a.ext.req, null, `Action "${a.name || '?'}" (requires)`); });
  return out;
}
/* the valid traits by trigger ({ turnEnd: [trait…], … }), or null when there are none */
function compileTraits(ext) {
  const ex = ext || {};
  if (!Array.isArray(ex.traits) || !ex.traits.length || (ex.traitsV !== undefined && ex.traitsV !== TRAITS_VERSION)) return null;
  let out = null;
  ex.traits.forEach((t, i) => {
    if (validateTraits({ resources: ex.resources, traits: [t] }).length) return;      // an invalid trait is skipped whole, never half-run
    out = out || {};
    (out[t.when] = out[t.when] || []).push(Object.assign({ idx: i }, t, { if: t.if || [] }));
  });
  return out;
}
/* what v2 does with each trait: 'planned' when every word it uses is scored, otherwise the words it only simulates */
function traitAiWords(t) {
  const words = [];
  const walk = list => (list || []).forEach(e => { if (!e || typeof e !== 'object') return; for (const k in e) { words.push(k); if (k === 'coin') { walk(e.coin.heads); walk(e.coin.tails); } } });
  walk(t && t.do);
  return { scored: words.filter(k => TRAIT_DO[k] && TRAIT_DO[k].ai), only: words.filter(k => TRAIT_DO[k] && !TRAIT_DO[k].ai), inert: words.filter(k => TRAIT_DO[k] && TRAIT_DO[k].inert).map(k => k + ': ' + TRAIT_DO[k].inert) };
}
/* a pool's number at the start of a fight: `start` when the pool says (Patience: 0), else full */
const poolStart = r => (r && tNum(r.start) ? Math.max(0, r.start) : +(r && r.uses) || 0);
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
    closeShot: !!ex.closeShot,                                              // Trained Shooter: ranged attacks within 5 ft of a foe have no disadvantage
    warCaster: !!ex.warCaster,                                              // advantage on concentration saves
    meleeHitNoOA: !!ex.meleeHitNoOA,                                        // Trained Fighter: no opportunity attack from a creature it hit with a melee attack this turn
    followThrough: ex.followThrough && ex.followThrough.dice ? ex.followThrough : null,   // once a turn, the second hit on one target: { dice, type }
    pushLuck: ex.pushLuck && ex.pushLuck.dice ? ex.pushLuck : null,        // Push Your Luck: reroll its own missed attack roll for { dice } damage to itself
    indomitable: ex.indomitable && ex.indomitable.uses ? { uses: +ex.indomitable.uses, bonus: +ex.indomitable.bonus || 0 } : null,   // reroll a failed save
    saveAdvVs: Array.isArray(ex.saveAdvVs) ? ex.saveAdvVs.map(c => String(c).toLowerCase()) : [],                          // Advantage on saves against these conditions
    resMax: ex.resources && typeof ex.resources === 'object' ? ex.resources : null,                                         // shared pools: { 'Superiority Dice': { uses, reset, regainOnInit } }                                        // "can't make opportunity attacks"
    critOn: typeof ex.critRange === 'number' && ex.critRange >= 15 && ex.critRange < 20 ? ex.critRange : 20,   // Champion: weapon crits on 19–20
    dmgMods: dmgModsOf(ex),                                                 // { resist, immune, vulnerable } by damage type, or null
    condImmune: Array.isArray(ex.condImmune) ? ex.condImmune.map(c => String(c).toLowerCase()) : [],     // climb speed: scales ledges with no check and no extra cost
    sneak: ex.sneakAttack && ex.sneakAttack.dice ? ex.sneakAttack : null,   // { dice: '2d6', assassinate: 4 }
    assassinate: !!ex.assassinate,                                          // advantage vs anyone who hasn't acted yet, round 1
    luckMax: typeof ex.luck === 'number' ? ex.luck : 0,
    legResMax: typeof ex.legendaryResistance === 'number' ? ex.legendaryResistance : 0,
    legResName: typeof ex.legResName === 'string' && ex.legResName ? ex.legResName : '',   // the same rule under another name (Lucky Seam), for the log   // Legendary Resistance uses per day                     // Lucky feat points per long rest
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
  u.hd = isPC ? hitDiceOf(tpl) : null;      // Hit Dice left for short rests (day.js)
  // "takes one additional action" (Action Surge) sits outside the normal action lists: it's used at the end of a turn
  u.surges = u.actions.filter(a => a.ext && a.ext.extraAction);
  if (u.surges.length) { u.actions = u.actions.filter(a => !u.surges.includes(a)); u.surges.forEach(a => initUses(u, a)); }
  if (u.resMax) for (const k in u.resMax) u.uses.set('res:' + k, poolStart(u.resMax[k]));
  u.traits = compileTraits(ex);                     // custom mechanics (docs/custom-mechanics.md); null for nearly everyone
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
  if (u.resMax) for (const k in u.resMax) if (u.resMax[k].reset === 'fight') u.uses.set('res:' + k, poolStart(u.resMax[k]));   // a pool that starts every fight afresh (Patience)
  u.tOnce = null;                                   // traits used this turn / round (once: 'turn' | 'round')
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
  // rule variants (docs/ai-v2.md, "Counterspell rules option", "Rules accuracy pass"): rest 'hitdice' (default) spends Hit Dice on a short rest, 'full' heals everyone fully
  this.rules = { counterspell: opts.rules && opts.rules.counterspell === '2014' ? '2014' : '2024', rest: opts.rules && opts.rules.rest === 'full' ? 'full' : 'hitdice' };
  this.morale = opts.morale === 'on' || opts.morale === true;      // monsters may flee or surrender
  const kn = opts.know || {};
  this.know = { party: KNOW_MODES.includes(kn.party) ? kn.party : 'open', foes: KNOW_MODES.includes(kn.foes) ? kn.foes : 'open' };
  this.mem = { party: new Map(), foes: new Map() };     // learned per kind of creature, kept all day
  this.expectFights = +opts.expectFights > 0 ? Math.round(+opts.expectFights) : 0;   // fights the party expects today (learn/blind; 0 = learn knows, blind assumes)
  this.threatMode = opts.threat === false ? 0 : opts.threat === 'bounds' ? 1 : 2;   // learn on v2 (keen): 2 the threat estimate and the bloodied reading (default), 1 the bloodied reading alone, 0 the classic reading (docs/ai-v2.md)
  this.setTerrain(null);
}

Object.assign(ENG, { makeRng, parseDice, rollDice, avgDice, INCAP, DANGER_CONDS, ADV_TARGET, ADV_SELF, DIS_TARGET, DIS_SELF, sizeIdx, finalizeAction, inferRange, listOf, damageMultFor, bestTypeFor, casterKind, smiteOf, smiteDice, effectName, isHpPool, recoverSlots, makeUnit, freqKind, resetFightState, Sim,
  TRAITS_VERSION, TRAIT_WHEN, TRAIT_IF, TRAIT_DO, validateTraits, compileTraits, traitAiWords });
})(typeof window !== 'undefined' ? window : globalThis);
