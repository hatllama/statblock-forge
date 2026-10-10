/* =====================================================================
   TACTICAL ENGINE — plays fights out with real dice on a grid.
   Reads the day JSON exported by the Statblock Forge.
   Pure JS, no DOM. Exposes global `TacEngine`.
   ===================================================================== */
(function (root) {
'use strict';

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
const sizeIdx = (s, d) => { const i = SIZES.indexOf(s || ''); return i < 0 ? d : i; };

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

/* ---------------- areas of effect ----------------
   ext.area = { shape: 'sphere' | 'cone' | 'line' | 'cube', size: ft } sets the exact area, and then
   everyone inside it is caught. Without it the shape is guessed from the name (cone for breaths and
   cones, cube for Thunderwave, otherwise a 10-ft-radius burst) and at most "targets" creatures are hit. */
const AREA_SHAPES = ['sphere', 'cone', 'line', 'cube', 'emanation'];
function areaSpec(a) {
  if (!a || !(a.useSaves || a.type === 'debuff')) return null;
  if (a.actionSlot === 5 || a.actionSlot === 6) return null;                 // auras are drawn around the creature instead
  const ar = a.ext && a.ext.area;
  if (ar && AREA_SHAPES.includes(ar.shape)) {
    const def = { sphere: 20, cone: 15, line: 60, cube: 15, emanation: 10 }[ar.shape];
    const size = Math.max(5, Number(ar.size) || def);
    // a cube or square set down at a point (Shattering Display, Faerie Fire) is centred there; a cube with range = size starts at the caster (Thunderwave)
    const placed = ar.shape === 'cube' && (a._range || 0) > size + 5;
    return { shape: ar.shape, size, explicit: true, placed, width: Number(ar.width) || 5 };
  }
  if ((a.targets || 1) < 2) return null;
  const n = (a.name || '').toLowerCase();
  if (/thunderwave|\bcube\b/.test(n)) return { shape: 'cube', size: 15, explicit: false };
  if (/lightning bolt|\bline\b/.test(n)) return { shape: 'line', size: Math.max(30, a._range || 60), explicit: false };
  if (/cone|breath|burning hands|spray|cold/.test(n)) return { shape: 'cone', size: Math.max(15, a._range || 15), explicit: false };
  return { shape: 'sphere', size: 10, explicit: false };
}
/* the grid squares an area covers, cast from (ox,oy) and aimed at (tx,ty) */
function areaCells(spec, ox, oy, tx, ty, W, H) {
  /* Grid templates, measured from square centres (1 square = 5 ft):
       sphere     every square whose centre is within the radius of the point (a round blob, not a box)
       emanation  the same, measured from the creature, which isn't caught by its own emanation
       cone       from the creature, as long as its size and as wide at any distance as that distance (5e rule)
       line       from the creature, its size long and 5 ft (or ext.area.width) wide
       cube       next to the creature in the aimed direction, or centred on a point when set down at range */
  const out = [];
  const add = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) out.push([x, y]); };
  const n = Math.round(spec.size / 5);
  const R2 = (n + 0.45) * (n + 0.45);
  if (spec.shape === 'emanation' || spec.shape === 'sphere') {
    const cx = spec.shape === 'emanation' ? ox : tx, cy = spec.shape === 'emanation' ? oy : ty;
    for (let y = cy - n; y <= cy + n; y++) for (let x = cx - n; x <= cx + n; x++) {
      if (spec.shape === 'emanation' && x === ox && y === oy) continue;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= R2) add(x, y);
    }
    return out;
  }
  if (spec.shape === 'cube') {
    if (spec.placed) {
      const x0 = tx - Math.floor((n - 1) / 2), y0 = ty - Math.floor((n - 1) / 2);
      for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) add(x, y);
      return out;
    }
    let x0, y0;
    const dx = tx - ox, dy = ty - oy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      x0 = dx >= 0 ? ox + 1 : ox - n;
      y0 = oy - Math.floor((n - 1) / 2); if (ty < y0) y0 = ty; if (ty > y0 + n - 1) y0 = ty - n + 1;
    } else {
      y0 = dy >= 0 ? oy + 1 : oy - n;
      x0 = ox - Math.floor((n - 1) / 2); if (tx < x0) x0 = tx; if (tx > x0 + n - 1) x0 = tx - n + 1;
    }
    for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) add(x, y);
    return out;
  }
  // cones and lines: one of the 8 grid directions (see inArea)
  for (let y = oy - n; y <= oy + n; y++) for (let x = ox - n; x <= ox + n; x++) if (inArea(spec, ox, oy, tx, ty, x, y)) add(x, y);
  return out;
}
/* the grid direction (8 ways) nearest to the aim, as a step [sx, sy] */
function dir8(vx, vy) {
  if (!vx && !vy) return [1, 0];
  const k = Math.round(Math.atan2(vy, vx) / (Math.PI / 4));
  return [Math.round(Math.cos(k * Math.PI / 4)), Math.round(Math.sin(k * Math.PI / 4))];
}

/* whether square (x,y) is inside the area — the same templates as areaCells, for one square */
function inArea(spec, ox, oy, tx, ty, x, y) {
  const n = Math.round(spec.size / 5);
  if (spec.shape === 'emanation' || spec.shape === 'sphere') {
    if (spec.shape === 'emanation' && x === ox && y === oy) return false;
    const cx = spec.shape === 'emanation' ? ox : tx, cy = spec.shape === 'emanation' ? oy : ty;
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= (n + 0.45) * (n + 0.45);
  }
  if (spec.shape === 'cube') {
    let x0, y0;
    if (spec.placed) { x0 = tx - Math.floor((n - 1) / 2); y0 = ty - Math.floor((n - 1) / 2); }
    else {
      const dx = tx - ox, dy = ty - oy;
      if (Math.abs(dx) >= Math.abs(dy)) {
        x0 = dx >= 0 ? ox + 1 : ox - n;
        y0 = oy - Math.floor((n - 1) / 2); if (ty < y0) y0 = ty; if (ty > y0 + n - 1) y0 = ty - n + 1;
      } else {
        y0 = dy >= 0 ? oy + 1 : oy - n;
        x0 = ox - Math.floor((n - 1) / 2); if (tx < x0) x0 = tx; if (tx > x0 + n - 1) x0 = tx - n + 1;
      }
    }
    return x >= x0 && x < x0 + n && y >= y0 && y < y0 + n;
  }
  /* Cones and lines run straight along one of the 8 grid directions, so they never come out jagged.
       line      a row of squares (or a diagonal of squares), its size long and ext.area.width wide
       cone      d squares out it covers the d-th row to floor(d/2) squares either side of centre (widths 1, 3, 3,
                 5, 5, 7…: as wide as it is far); on a diagonal, a triangle of about the same number of squares */
  if (x === ox && y === oy) return false;
  const sd = dir8(tx - ox, ty - oy), sx = sd[0], sy = sd[1], wx = x - ox, wy = y - oy;
  const w = Math.max(1, Math.round((spec.width || 5) / 5));
  if (!sx || !sy) {
    const along = sx ? wx * sx : wy * sy, side = sx ? wy : wx;
    if (along < 1 || along > n) return false;
    if (spec.shape === 'cone') return Math.abs(side) <= Math.floor(along / 2);
    return side >= -Math.floor((w - 1) / 2) && side <= Math.ceil((w - 1) / 2);
  }
  const i = wx * sx, j = wy * sy, d = Math.max(i, j);
  if (i < 0 || j < 0 || d < 1 || d > n) return false;
  // a diagonal cone: the wedge between the 1:2 and 2:1 slopes, cut square across the diagonal so it ends in a flat edge
  if (spec.shape === 'cone') return Math.min(i, j) >= Math.ceil(d / 2) && i + j <= Math.round(1.75 * n);
  return Math.abs(i - j) <= Math.floor(w * 0.7072 + 0.01) && (w > 1 || Math.min(i, j) >= 1);
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
    sneak: ex.sneakAttack && ex.sneakAttack.dice ? ex.sneakAttack : null,   // { dice: '2d6', assassinate: 4 }
    assassinate: !!ex.assassinate,                                          // advantage vs anyone who hasn't acted yet, round 1
    luckMax: typeof ex.luck === 'number' ? ex.luck : 0,
    legResMax: typeof ex.legendaryResistance === 'number' ? ex.legendaryResistance : 0,   // Legendary Resistance uses per day                     // Lucky feat points per long rest
    steadyAim: !!ex.steadyAim,
    packTactics: !!ex.packTactics,                                          // advantage when an ally is next to the target
    speed: Math.max(typeof ex.speed === 'number' ? ex.speed : 30, typeof ex.fly === 'number' ? ex.fly : 0),
    size: ex.size || 'Medium',
    blindsight: !!ex.blindsight, elvenAccuracy: !!ex.elvenAccuracy,
    initBonus: typeof ex.initBonus === 'number' ? ex.initBonus : 0,
    initAdv: !!ex.initAdvantage,
    escapeBonus: (ex.escapeBonus !== undefined && ex.escapeBonus !== '') ? Number(ex.escapeBonus) : (tpl.saveBonus || 0),
    legendaryMax: typeof ex.legendaryActions === 'number' ? ex.legendaryActions : 3,
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
    u.recovery = sb.recovery && sb.recovery.levels ? sb.recovery : null;   // e.g. Arcane Recovery { levels: 2, maxSlot: 5, restores: [actionId] }
  }
  u.baseFly = u.fly;
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
  u.onBoard = true;
  u.concentrating = null; u.slotTurn = -1; u.reserveSlot = false;
  u.tookTurn = false; u.vex = null; u.saSeq = -1; u.movedThisTurn = false;
  if (u.baseFly !== undefined) u.fly = u.baseFly;
}

/* ---------------- the encounter simulator ---------------- */
function Sim(opts) {
  this.R = makeRng(opts.seed);
  this.record = !!opts.record;
  this.events = [];
  this.W = opts.width || 24; this.H = opts.height || 16;
  this.escapePolicy = opts.escapePolicy || 'smart';
  this.surpriseRules = opts.surpriseRules || '2024';
  this.tpkKills = !!opts.tpkKills;     // the whole party down with foes still standing: nobody is left to save them
  this.maxRounds = opts.maxRounds || 40;
  this.setTerrain(null);
}

/* ---------------- terrain ----------------
   layout.terrain = { cells: { "x,y": { t?: 'wall' | 'difficult' | 'cover', h?: levels } } }
     wall      — can't be entered, blocks line of sight and areas
     difficult — costs double movement
     cover     — low wall / rubble: difficult to cross, and half cover (+2 AC) against ranged attacks across it
     h         — height in 5-ft steps. Climbing costs an extra 5 ft per step up, distance counts height
                 (5-ft reach can't hit someone 10 ft above), and higher ground blocks sight past its edge. */
Sim.prototype.setTerrain = function (t) {
  const W = this.W, H = this.H, N = W * H;
  const T = { wall: new Uint8Array(N), rough: new Uint8Array(N), cover: new Uint8Array(N), h: new Int8Array(N), any: false, anyH: false, losC: new Map(), covC: new Map(), fog: null };
  const cells = (t && t.cells) || {};
  for (const k in cells) {
    const [x, y] = k.split(',').map(Number);
    if (!(x >= 0 && y >= 0 && x < W && y < H)) continue;
    const c = cells[k] || {}, i = x + y * W;
    if (c.t === 'wall') T.wall[i] = 1; else if (c.t === 'difficult') T.rough[i] = 1; else if (c.t === 'cover') T.cover[i] = 1;
    const h = Math.max(-6, Math.min(12, parseInt(c.h, 10) || 0));
    if (h) { T.h[i] = h; T.anyH = true; }
    if (c.t || h) T.any = true;
  }
  this.T = T;
};
Sim.prototype.speedOf = function (u) {
  let s = u.speed;
  for (const b of u.buffs) if (b.speedBonus) s += b.speedBonus;
  return Math.max(0, s);
};
Sim.prototype.hAt = function (x, y) { return this.T.anyH ? this.T.h[x + y * this.W] : 0; };
Sim.prototype.isWall = function (x, y) { return this.T.any && this.T.wall[x + y * this.W] === 1; };
/* can something at (x0,y0) see / reach a straight line to (x1,y1)? */
Sim.prototype.los = function (x0, y0, x1, y1) {
  const T = this.T;
  if (!T.any) return true;
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  if (n <= 1 && !T.anyH) return true;
  const W = this.W;
  if (T.fog && n > 1 && (T.fog[x0 + y0 * W] || T.fog[x1 + y1 * W])) return false;   // heavily obscured: nobody sees in or out
  const key = (x0 + y0 * W) * 4096 + (x1 + y1 * W);
  const hit = T.losC.get(key);
  if (hit !== undefined) return hit;
  let ok = true;
  const h0 = T.h[x0 + y0 * W] + 1, h1 = T.h[x1 + y1 * W] + 1;    // eye level: a creature stands 5 ft tall
  const steps = n * 4;
  for (let i = 1; i < steps && ok; i++) {
    const f = i / steps;
    const cx = Math.floor(x0 + 0.5 + (x1 - x0) * f), cy = Math.floor(y0 + 0.5 + (y1 - y0) * f);
    if ((cx === x0 && cy === y0) || (cx === x1 && cy === y1)) continue;
    const c = cx + cy * W;
    if (T.wall[c] || (T.fog && T.fog[c])) ok = false;
    else if (T.anyH && T.h[c] > h0 + (h1 - h0) * f + 1e-9) ok = false;
  }
  T.losC.set(key, ok);
  return ok;
};
/* half cover (+2 AC) when a low wall lies between a ranged attacker and its target */
Sim.prototype.coverAC = function (a, t) {
  const T = this.T;
  if (!T.any || this.dist(a, t) <= 5) return 0;
  const W = this.W, key = (a.x + a.y * W) * 4096 + (t.x + t.y * W);
  let v = T.covC.get(key);
  if (v !== undefined) return v;
  v = 0;
  const n = Math.max(Math.abs(t.x - a.x), Math.abs(t.y - a.y)), steps = n * 4;
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const cx = Math.floor(a.x + 0.5 + (t.x - a.x) * f), cy = Math.floor(a.y + 0.5 + (t.y - a.y) * f);
    if ((cx === a.x && cy === a.y) || (cx === t.x && cy === t.y)) continue;
    if (T.cover[cx + cy * W]) { v = 2; break; }
  }
  T.covC.set(key, v);
  return v;
};
Sim.prototype.canSee = function (x, y, t) { return this.los(x, y, t.x, t.y); };
/* Hiding (2024): only out of every enemy's line of sight (walls, high ground, heavy obscurement).
   Blindsight within 30 ft still finds you. */
const isHideAction = a => !!(a && a.type === 'buff' && a.target === 'self' && a.buff && a.buff.condition === 'Invisible' && a.buff.duration === '1 round');
Sim.prototype.concealedAt = function (u, x, y) {
  if (!this.units.some(e => e.team !== u.team && e.onBoard && this.alive(e))) return false;    // nobody left to hide from
  for (const e of this.units) {
    if (e.team === u.team || !e.onBoard || !this.alive(e) || this.incap(e) || this.has(e, ['Blinded'])) continue;
    if (this.los(e.x, e.y, x, y) || (e.blindsight && this.distXY(x, y, e) <= 30)) return false;
  }
  return true;
};
Sim.prototype.isHidden = function (u) { return u.buffs.some(b => b.expiry === 'hide'); };
/* after acting: walk what's left of its movement to a spot nobody can see, then Hide */
Sim.prototype.slipAndHide = function (u, stepsLeft) {
  const h = u.actions.find(a => isHideAction(a) && a.actionSlot === 1 && this.usable(u, a) && this.condOk(u, a));
  if (!h || u.dead || u.hp <= 0 || this.incap(u)) return false;
  if (!this.concealedAt(u, u.x, u.y)) {
    if (stepsLeft <= 0 || this.has(u, ['Restrained']) || u.grappledBy) return false;
    const engaged = !u.disengaged && this.adjacentEnemies(u, u.x, u.y).some(e => e.reaction && !this.incap(e));
    if (engaged) return false;                                   // not worth an opportunity attack
    const rm = this.reachMap(u, stepsLeft * 5);
    let best = null, bs = Infinity;
    for (let i = 0; i < rm.dist.length; i++) {
      if (rm.dist[i] <= 0) continue;
      const x = i % this.W, y = (i / this.W) | 0;
      const o = this.occupant(x, y); if (o && o !== u) continue;
      if (this.adjacentEnemies(u, x, y).length || !this.concealedAt(u, x, y)) continue;
      const sc = rm.dist[i];
      if (sc < bs) { bs = sc; best = { x, y }; }
    }
    if (!best) return false;
    if (this.record) this.ev('intent', `${u.name} ducks out of sight to hide`, { uid: u.uid });
    this.moveAlong(u, this.pathTo(rm, best.x, best.y));
    if (u.dead || u.hp <= 0 || !this.concealedAt(u, u.x, u.y)) return false;
  }
  const p = this.plan(u, h, 0);
  if (!p) return false;
  this.spend(u, h); this.doAction(u, h, p);
  return true;
};

Sim.prototype.ev = function (kind, text, data) {
  if (!this.record) return;
  const e = Object.assign({ kind, text, round: this.round }, data || {});
  e.state = this.diffState();
  this.events.push(e);
};
Sim.prototype.mark = function () { return this.events.length; };
Sim.prototype.hoist = function (at) {
  if (!this.record || this.events.length - 1 <= at) return;
  const e = this.events.pop();
  // the state change it caused was captured by the later events; keep the line itself first
  this.events.splice(at, 0, Object.assign(e, { state: {} }));
};
Sim.prototype.unitState = function (u) {
  return { x: u.x, y: u.y, hp: Math.round(u.hp * 10) / 10, temp: u.temp, onBoard: u.onBoard, dead: !!u.dead, down: u.hp <= 0 && !u.dead,
           conds: Array.from(this.conds(u)).sort(), stable: u.stable, ds: u.deathS, df: u.deathF,
           grappledBy: u.grappledBy, swallowedBy: u.swallowedBy,
           slots: u.slots ? u.slots.map((n, i) => n + '/' + u.slotsMax[i]).slice(0, u.slotsMax.reduce((m, n, i) => n ? i + 1 : m, 0)).join(' ') : undefined,
           conc: u.concentrating ? ((u.actions.find(a => a.id === u.concentrating) || {}).name || 'a spell') : undefined };
};
Sim.prototype.diffState = function () {
  const out = {};
  for (const u of this.units) {
    const s = this.unitState(u);
    const k = JSON.stringify(s);
    if (this._last[u.uid] !== k) { this._last[u.uid] = k; out[u.uid] = s; }
  }
  return out;
};

Sim.prototype.alive = function (u) { return !u.dead && u.hp > 0; };
Sim.prototype.living = function (u) { return !u.dead; };
Sim.prototype.enemiesOf = function (u) { return this.units.filter(x => x.team !== u.team); };
Sim.prototype.alliesOf = function (u) { return this.units.filter(x => x.team === u.team); };
/* who an area aimed at t from (ox,oy) would catch, besides t; spec/cells are returned for drawing */
Sim.prototype.areaAt = function (a, spec, t, ox, oy, ax, ay, pool, caster, fast) {
  // fast: only work out who is caught (no list of squares) — used while searching for the best aim
  const fromPoint = spec.shape === 'sphere' || (spec.shape === 'cube' && spec.placed);
  const cx = fromPoint ? ax : ox, cy = fromPoint ? ay : oy;
  let isIn, cells = null;
  if (fast) {
    const W = this.W, inb = (x, y) => x >= 0 && y >= 0 && x < W && y < this.H;
    isIn = o => inb(o.x, o.y) && inArea(spec, ox, oy, ax, ay, o.x, o.y) && (!this.T.any || (!this.T.wall[o.x + o.y * W] && this.los(cx, cy, o.x, o.y)));
  } else {
    cells = areaCells(spec, ox, oy, ax, ay, this.W, this.H);
    // walls stop an area; a sphere or a set-down cube spreads from its point, everything else from the creature
    if (this.T.any) cells = cells.filter(([x, y]) => !this.T.wall[x + y * this.W] && this.los(cx, cy, x, y));
    const N = this.W * this.H;
    if (!this._mark || this._mark.length !== N) { this._mark = new Int32Array(N); this._stamp = 0; }
    const st = ++this._stamp, mark = this._mark, W = this.W;
    for (const c of cells) mark[c[0] + c[1] * W] = st;
    isIn = o => mark[o.x + o.y * W] === st;
  }
  if (!isIn(t)) return null;
  let extra = pool.filter(o => o !== t && o.onBoard && isIn(o));
  if (!spec.explicit) extra = this.orderBySelector(extra, a.target).sort((p, q) => this.dist(p, t) - this.dist(q, t)).slice(0, Math.max(0, (a.targets || 1) - 1));
  // an area hurts everyone in it, the caster's own side included (cones, lines, cubes and emanations start at the caster and spare it)
  let friends = [];
  if (caster && !(a.ext && a.ext.area && a.ext.area.selective) && !(a.ext && a.ext.zone && a.ext.zone.fog)) {
    friends = this.alliesOf(caster).filter(o => o.onBoard && !o.dead && !o.swallowedBy && isIn(o) && (o !== caster || spec.shape === 'sphere'));
  }
  return { spec, cells, extra, friends, ax, ay };
};
/* Cones and lines: try each of the 8 grid directions that reaches t and keep the one that catches the most
   enemies and the fewest allies (ties go to the direction closest to t's bearing). If none reaches t from
   here, a caster gets null (it should line up from another square). */
Sim.prototype.aimStraight = function (a, spec, t, ox, oy, pool, caster) {
  const n = Math.max(1, Math.round(spec.size / 5)), bear = Math.atan2(t.y - oy, t.x - ox);
  let best = null, bs = -Infinity;
  for (let k = 0; k < 8; k++) {
    const sx = Math.round(Math.cos(k * Math.PI / 4)), sy = Math.round(Math.sin(k * Math.PI / 4));
    const ax = ox + sx * n, ay = oy + sy * n;
    if (!inArea(spec, ox, oy, ax, ay, t.x, t.y)) continue;
    const r = this.areaAt(a, spec, t, ox, oy, ax, ay, pool, caster, true);
    if (!r) continue;
    let off = Math.abs(k * Math.PI / 4 - bear) % (2 * Math.PI); if (off > Math.PI) off = 2 * Math.PI - off;
    const sc = r.extra.length * 10 - r.friends.reduce((q, f) => q + (f.hp <= 0 ? 60 : 16), 0) - off * 0.01;
    if (sc > bs) { best = r; bs = sc; }
  }
  if (best) return this.areaAt(a, spec, t, ox, oy, best.ax, best.ay, pool, caster) || best;
  if (caster) return null;
  return { spec, cells: [], extra: [], friends: [], ax: t.x, ay: t.y };
};
/* Who an area aimed at t catches, besides t. With a caster given, it also looks for a better aim that still
   catches t: a sphere's point can sit anywhere within range that keeps t inside, a cone or line can swing
   a little either side. Better = more enemies, fewer allies (a downed ally counts heavily). */
Sim.prototype.areaCatch = function (a, t, ox, oy, pool, caster) {
  const spec = areaSpec(a);
  if (!spec) return null;
  if (spec.shape === 'cone' || spec.shape === 'line') return this.aimStraight(a, spec, t, ox, oy, pool, caster);
  let best = this.areaAt(a, spec, t, ox, oy, t.x, t.y, pool, caster);
  if (!best) best = { spec, cells: [], extra: [], friends: [], ax: t.x, ay: t.y };   // walls in the way: just the target
  if (!caster || !spec.explicit || spec.shape === 'emanation' || (spec.shape === 'cube' && !spec.placed)) return best;
  const score = r => r ? r.extra.length * 10 - r.friends.reduce((s, f) => s + (f.hp <= 0 ? 60 : 16), 0) - (Math.abs(r.ax - t.x) + Math.abs(r.ay - t.y)) * 0.01 : -Infinity;
  let bs = score(best);
  const n = Math.round(spec.size / 5), range = Math.max(5, a._range || spec.size) / 5;
  if (spec.shape === 'sphere' || spec.shape === 'cube') {
    // nothing to gain if nobody else is near enough to matter
    const close = o => o !== t && o.onBoard && Math.max(Math.abs(o.x - t.x), Math.abs(o.y - t.y)) <= n * 2;
    const foesNear = pool.filter(close);
    if (!foesNear.length && !this.alliesOf(caster).some(o => close(o) && !o.dead)) return best;
    for (let y = t.y - n; y <= t.y + n; y++) for (let x = t.x - n; x <= t.x + n; x++) {
      if ((x === t.x && y === t.y) || x < 0 || y < 0 || x >= this.W || y >= this.H) continue;
      // cheap bound first: enemies this aim could catch, walls ignored and allies not counted
      let ub = -(Math.abs(x - t.x) + Math.abs(y - t.y)) * 0.01;
      if (!inArea(spec, ox, oy, x, y, t.x, t.y)) continue;
      for (const o of foesNear) if (inArea(spec, ox, oy, x, y, o.x, o.y)) ub += 10;
      if (ub <= bs) continue;
      if (Math.max(Math.abs(x - ox), Math.abs(y - oy)) > range || this.isWall(x, y)) continue;
      if (this.T.any && !this.los(ox, oy, x, y)) continue;
      const r = this.areaAt(a, spec, t, ox, oy, x, y, pool, caster, true);
      const sc = score(r);
      if (sc > bs) { best = r; bs = sc; }
    }
  }
  return best.cells ? best : (this.areaAt(a, spec, t, ox, oy, best.ax, best.ay, pool, caster) || best);
};
/* height counts toward distance, unless one side flies (it simply rises or dips to meet the other) */
Sim.prototype.dist = function (a, b) {
  const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  return (this.T.anyH && !a.fly && !b.fly ? Math.max(d, Math.abs(this.T.h[a.x + a.y * this.W] - this.T.h[b.x + b.y * this.W])) : d) * 5;
};
Sim.prototype.distXY = function (x, y, b) {
  const d = Math.max(Math.abs(x - b.x), Math.abs(y - b.y));
  return (this.T.anyH && !b.fly && !this._flyer ? Math.max(d, Math.abs(this.T.h[x + y * this.W] - this.T.h[b.x + b.y * this.W])) : d) * 5;
};

/* ----- buffs & conditions ----- */
Sim.prototype.conds = function (u) {
  const s = new Set();
  for (const b of u.buffs) if (b.data.condition) s.add(b.data.condition);
  if (!u.dead && u.hp <= 0 && u.isPC) s.add('Unconscious');
  if (u.grappledBy && u.grappleInfo && u.grappleInfo.restrains) s.add('Restrained');
  if (u.swallowedBy) { s.add('Blinded'); s.add('Restrained'); }
  return s;
};
Sim.prototype.has = function (u, list) { const c = this.conds(u); return list.some(x => c.has(x)); };
Sim.prototype.incap = function (u) { return u.dead || this.has(u, INCAP); };
Sim.prototype.sumBuff = function (u, field, roll) {
  let t = 0;
  for (const b of u.buffs) if (b.data[field] !== undefined && b.data[field] !== '') t += roll ? rollDice(b.data[field], this.R, false) : avgDice(b.data[field]);
  return t;
};
Sim.prototype.multBuff = function (u, field) {
  let t = 1;
  for (const b of u.buffs) if (typeof b.data[field] === 'number') t *= b.data[field];
  return t;
};
Sim.prototype.ac = function (u) { return u.baseAC + this.sumBuff(u, 'ac', false); };
Sim.prototype.addBuff = function (holder, src, action, data, extra) {
  holder.buffs = holder.buffs.filter(b => !(b.id === action.id && b.src === src.uid));
  const b = { id: action.id, name: action.name || 'effect', src: src.uid, data: Object.assign({}, data), expiry: data.duration };
  const ax = action.ext || {};
  if (typeof ax.speedBonus === 'number') b.speedBonus = ax.speedBonus;          // Bladesong +10 ft, Longstrider…
  if (typeof ax.concBonus === 'number') b.concBonus = ax.concBonus;            // Bladesong adds Int to concentration saves
  if (ax.endsOnIncap) b.endsOnIncap = true;
  if (ax.endsOnDamage) b.endsOnDamage = true;
  if (typeof ax.grantFly === 'number' && holder === src) { holder.fly = Math.max(holder.fly || 0, ax.grantFly); holder.speed = Math.max(holder.speed, ax.grantFly); }
  if (typeof ax.mirror === 'number') { b.mirror = ax.mirror; delete b.data.damageTakenMultiplier; }   // real duplicates here, an average in the export
  if (extra) Object.assign(b, extra);
  // Hiding (self-applied Invisible) lasts until the creature attacks or its next turn ends (2024 Hide)
  if (holder === src && data.condition === 'Invisible' && data.duration === '1 round') { b.expiry = 'hide'; b.madeOnTurn = holder.turnNo || 0; }
  holder.buffs.push(b);
  return b;
};
Sim.prototype.dropBuffs = function (u, pred) { u.buffs = u.buffs.filter(b => !pred(b)); };

/* ----- uses ----- */
Sim.prototype.slotFor = function (u, level) {
  if (!level) return 0;
  for (let l = level; l <= 9; l++) if (u.slots[l - 1] > 0) return l;
  return -1;
};
Sim.prototype.usable = function (u, a) {
  if (a._spell) {
    if (!a._spell.level) return true;
    if (a.actionSlot !== 4 && u.slotTurn === u.turnNo && this.current === u) return false;   // one spell slot per turn (2024 rules)
    if (a.actionSlot === 1 && u.reserveSlot) return false;                                  // the action is going to need it
    return this.slotFor(u, a._spell.level) > 0;
  }
  if (a.ext && a.ext.pool) return (u.uses.get(a.id) || 0) >= 1;
  const k = freqKind(a.freq);
  if (k === 'at will') return true;
  if (k === '1/fight') return !u.fightUses.has(a.id);
  if (k === 'recharge') return u.recharge.get(a.id) !== false;
  return (u.uses.get(a.id) || 0) > 0;
};
Sim.prototype.spend = function (u, a) {
  u.usedThisFight.add(a.id);
  if (a.ext && a.ext.pool) return;       // dice are taken from the pool when the healing is rolled
  if (a._spell) {
    u.castLevel = a._spell.level;
    if (a._spell.level) {
      const l = this.slotFor(u, a._spell.level);
      if (l > 0) { u.slots[l - 1]--; u.castLevel = l; }
      if (this.current === u) u.slotTurn = u.turnNo;
    }
    if (a._spell.conc) { this.endConcentration(u, 'casts ' + a.name); u.concentrating = a.id; }
    return;
  }
  const k = freqKind(a.freq);
  if (k === '1/fight') u.fightUses.set(a.id, true);
  else if (k === 'recharge') u.recharge.set(a.id, false);
  else if (k !== 'at will') u.uses.set(a.id, Math.max(0, (u.uses.get(a.id) || 0) - 1));
};

/* a lasting effect this creature already has running (on anyone still standing) is not cast again —
   it behaves like a concentration spell: re-casting would only replace it */
Sim.prototype.stillRunning = function (u, a) {
  if (a.type !== 'buff' && a.type !== 'debuff') return false;
  const d = a.buff && a.buff.duration;
  if (d !== 'entire encounter' && d !== 'repeat the save each round') return false;
  return this.units.some(o => o.onBoard && this.alive(o) && o.buffs.some(b => b.id === a.id && b.src === u.uid));
};
Sim.prototype.condOk = function (u, a) {
  if (this.stillRunning(u, a)) return false;
  const allies = this.alliesOf(u).filter(x => x !== u);
  const foes = this.enemiesOf(u).filter(x => this.alive(x));
  const ex = a.ext || {};
  if (ex.onlyIfEnemiesSurprised && !(this.round === 1 && this.surprised[u.team === 'party' ? 'foes' : 'party'])) return false;
  if (ex.requiresBuff && !u.buffs.some(b => b.id === ex.requiresBuff)) return false;     // e.g. Wrath of the Sea strikes need the spray up
  if (ex.grantsBuff && u.buffs.some(b => b.id === ex.grantsBuff.id)) return false;        // …and it isn't manifested twice
  switch (a.condition) {
    case 'ally at 0 HP': return allies.some(x => !x.dead && x.hp <= 0);
    case 'ally under half HP': return allies.some(x => !x.dead && x.hp < x.maxHp / 2);
    case 'is under half HP': return u.hp < u.maxHp / 2;
    case 'has no THP': return !u.temp;
    case 'not used yet': return !u.usedThisFight.has(a.id);
    case 'enemy count one': return foes.length === 1;
    case 'enemy count multiple': return foes.length > 1;
    default: return true;
  }
};

/* ----- target selection ----- */
Sim.prototype.selectorKey = function (sel) {
  switch (sel) {
    case 'enemy with least HP': case 'ally with the least HP': return u => u.hp;
    case 'enemy with most HP': case 'ally with the most HP': return u => -u.hp;
    case 'enemy with highest DPR': case 'ally with the highest DPR': return u => -u.dpr;
    case 'enemy with lowest AC': case 'ally with the lowest AC': return u => this.ac(u);
    case 'enemy with highest AC': case 'ally with the highest AC': return u => -this.ac(u);
    default: return u => u.hp;
  }
};
Sim.prototype.orderBySelector = function (list, sel) {
  const k = this.selectorKey(sel);
  return list.slice().sort((a, b) => (k(a) - k(b)) || (this.R() - 0.5));
};

/* ----- grid & movement ----- */
Sim.prototype.occupant = function (x, y) {
  for (const u of this.units) if (u.onBoard && !u.dead && u.x === x && u.y === y) return u;
  return null;
};
/* reach maps are reused until anyone moves, drops or dies (spellcasters ask for many per turn) */
Sim.prototype.boardChanged = function () { this.posVer = (this.posVer || 0) + 1; this._rmCache = null; };
Sim.prototype.reachMap = function (u, budgetFt) {
  const key = u.uid + '|' + budgetFt + '|' + u.x + ',' + u.y + '|' + (u.fly ? 1 : 0);
  if (!this._rmCache) this._rmCache = new Map();
  const hit = this._rmCache.get(key);
  if (hit) return hit;
  const rm = this.reachMapRaw(u, budgetFt);
  this._rmCache.set(key, rm);
  return rm;
};
Sim.prototype.reachMapRaw = function (u, budgetFt) {
  const steps = Math.floor(budgetFt / 5);
  const W = this.W, H = this.H;
  const dist = new Int16Array(W * H).fill(-1), prev = new Int32Array(W * H).fill(-1);
  const block = new Uint8Array(W * H);   // 1 = standing enemy (can't pass)
  for (const o of this.units) if (o !== u && o.onBoard && !o.dead && o.team !== u.team && this.alive(o)) block[o.x + o.y * W] = 1;
  if (this.T.any) return this.reachMapT(u, steps, dist, prev, block);
  const q = [u.x + u.y * W]; dist[q[0]] = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi], cx = c % W, cy = (c / W) | 0;
    if (dist[c] >= steps) continue;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = nx + ny * W;
      if (dist[n] >= 0 || block[n]) continue;                     // can't move through standing enemies
      dist[n] = dist[c] + 1; prev[n] = c; q.push(n);
    }
  }
  return { dist, prev, W };
};
/* movement with terrain: difficult ground costs double, climbing costs extra, walls can't be crossed
   (or squeezed past diagonally). dist[] holds the movement spent, in 5-ft units. */
Sim.prototype.reachMapT = function (u, steps, dist, prev, block) {
  const W = this.W, H = this.H, T = this.T;
  const start = u.x + u.y * W;
  dist[start] = 0;
  const q = [start];
  const inq = new Uint8Array(W * H); inq[start] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]; inq[c] = 0;
    const cx = c % W, cy = (c / W) | 0, dc = dist[c];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = nx + ny * W;
      if (block[n] || T.wall[n]) continue;
      if (dx && dy && T.wall[cx + dx + cy * W] && T.wall[cx + (cy + dy) * W]) continue;   // no slipping between two walls
      const cost = u.fly ? 1 : (T.rough[n] || T.cover[n] ? 2 : 1) + Math.max(0, T.h[n] - T.h[c]);   // flyers skip rough ground and climbing
      const nd = dc + cost;
      if (nd > steps) continue;
      if (dist[n] >= 0 && dist[n] <= nd) continue;
      dist[n] = nd; prev[n] = c;
      if (!inq[n]) { inq[n] = 1; q.push(n); }
    }
  }
  return { dist, prev, W };
};
Sim.prototype.pathTo = function (rm, x, y) {
  const W = rm.W; const out = [];
  let c = x + y * W;
  while (c >= 0 && rm.dist[c] > 0) { out.push({ x: c % W, y: (c / W) | 0 }); c = rm.prev[c]; }
  return out.reverse();
};
Sim.prototype.meleeReach = function (u) {
  if (u._mr !== undefined) return u._mr;
  let r = 0;
  for (const a of u.actions) if (a.type === 'atk' && !a.useSaves && a.actionSlot === 0 && a._range <= 10) r = Math.max(r, a._range);
  u._mr = r;
  return r;
};
Sim.prototype.adjacentEnemies = function (u, x, y) {
  return this.enemiesOf(u).filter(e => e.onBoard && this.alive(e) && !this.incap(e) && this.meleeReach(e) > 0 && this.distXY(x, y, e) <= this.meleeReach(e) && this.los(e.x, e.y, x, y));   // a reach weapon can't strike round a wall corner
};

/* ----- expected outcomes, used by the tactical AI ----- */
Sim.prototype.hitChance = function (u, t, a) {
  const tc = this.conds(t), atc = this.conds(u);
  if (u.blindsight) { atc.delete('Blinded'); tc.delete('Invisible'); }
  const close = this.dist(u, t) <= 5;
  const adv = ADV_TARGET.some(x => tc.has(x)) || ADV_SELF.some(x => atc.has(x)) || !!this.featureAdv(u, t) || (tc.has('Prone') && close);
  const dis = DIS_TARGET.some(x => tc.has(x)) || DIS_SELF.some(x => atc.has(x)) || (tc.has('Prone') && !close);
  let p = Math.min(0.95, Math.max(0.05, (21 + avgDice(a.toHit) + this.sumBuff(u, 'toHit', false) - this.ac(t) - this.coverAC(u, t)) / 20));
  if (adv && !dis) p = 1 - Math.pow(1 - p, u.elvenAccuracy ? 3 : 2);
  else if (dis && !adv) p = p * p;
  return p;
};
Sim.prototype.expected = function (u, a, t) {
  const sab = a.ext && a.ext.saveAbility;
  const saveP = dc => Math.min(1, Math.max(0, (21 + this.saveBonusFor(t, sab) - dc) / 20));
  if (a.type === 'atk') {
    const sneakAvg = u.sneak && a.ext && a.ext.sneak && u.saSeq !== this.turnSeq ? avgDice(u.sneak.dice) * (this.featureAdv(u, t) || this.alliesOf(u).some(o => o !== u && o.onBoard && this.alive(o) && this.dist(o, t) <= 5) ? 0.95 : 0.35) : 0;
    const dmg = Math.max(0, (avgDice((a.ext && a.ext.dprIfHurt && t.hp < t.maxHp) ? a.ext.dprIfHurt : (a.ext && a.ext.wtDpr) || a.dpr) + sneakAvg / Math.max(1, a.targets || 1) + this.sumBuff(u, 'damage', false)) * this.multBuff(u, 'damageMultiplier') * this.multBuff(t, 'damageTakenMultiplier'));
    if (a.useSaves) { const ps = saveP(avgDice(a.toHit)); return dmg * ((1 - ps) + (a.halfOnSave ? ps / 2 : 0)); }
    return dmg * this.hitChance(u, t, a) * (a.targets || 1);
  }
  if (a.type === 'debuff') {
    let v = this.effectValue(a.buff, t, true);
    const ex = a.ext || {};
    if (typeof ex.speedBonus === 'number' && ex.speedBonus < 0) v += this.meleeReach(t) > 0 ? t.dpr * (ex.speedBonus <= -30 ? 0.5 : 0.25) : 1;
    if (ex.onHit && ex.onHit.noReactions) v += 1.5;
    return (1 - saveP(avgDice(a.saveDC))) * v;
  }
  return 0;
};

/* How much a tactical creature wants to use action `a` on `t`, standing at (x,y) */
Sim.prototype.friendPenalty = function (u, a, friends) {
  let p = 0;
  for (const f of friends) {
    // a downed ally takes a failed death save (or dies); a standing one takes the hit and the condition
    if (f.hp <= 0) p += 40 + f.deathF * 20;
    else { const e = this.expected(u, a, f); p += e * (f === u ? 1.4 : 1.7) + (e >= f.hp ? 25 : 0); }
  }
  return p;
};
Sim.prototype.targetValue = function (u, a, t, pool, x, y, noArea) {
  const offensive = a.type === 'atk' || a.type === 'debuff';
  let val = 0, why = '';
  if (offensive && t.hp <= 0) {
    // each hit is a failed death save; within 5 ft it's a crit, so two
    const near = this.distXY(x, y, t) <= 5;
    const hits = a.useSaves ? 1 : (a.targets || 1);
    const p = a.useSaves ? 1 : this.hitChance(u, t, a);
    const need = Math.max(1, 3 - t.deathF);
    const pKill = Math.min(1, hits * p * (near && !a.useSaves ? 2 : 1) / need);
    const healers = this.alliesOf(t).filter(o => o !== t && this.alive(o) && o.actions.some(h => h.type === 'heal' && h.target !== 'self')).length;
    return { val: pKill * (10 + t.dpr) * (healers ? 1.4 : 0.8), why: 'execute' };
  }
  if (offensive) {
    const exp = this.expected(u, a, t);
    val = Math.min(exp, t.hp + 4) * (1 + t.dpr / 20);
    if (a.type === 'atk' && exp >= t.hp * 0.9) { val += 12 + t.dpr * 0.5; why = 'finish'; }
    if (t.actions.some(o => o.type === 'heal' && o.target !== 'self')) { val += 3; why = why || 'healer'; }
    val += (1 - t.hp / t.maxHp) * 4;
    const allyOn = this.alliesOf(u).filter(o => o !== u && this.alive(o) && o.onBoard && this.dist(o, t) <= 5).length;
    val += allyOn * 1.5;   // focus fire
    // protect our casters: whoever is in their face is worth more
    const menacing = this.alliesOf(u).filter(o => o !== u && this.alive(o) && o.onBoard && this.dist(o, t) <= 5 && !this.hasMelee(o)).length;
    if (menacing && this.hasMelee(u)) { val += 4 * menacing; why = why || 'guard'; }
    const fromT = x === undefined || (x === t.x && y === t.y);
    const ac = noArea ? null : this.areaCatch(a, t, fromT ? u.x : x, fromT ? u.y : y, pool.filter(o => o.hp > 0), u);
    let friendly = false;
    if (ac) {
      const extra = ac.extra;
      val += extra.reduce((sum, o) => sum + this.expected(u, a, o), 0);
      if (extra.length) why = 'cluster';
      if (ac.friends.length) { friendly = true; val -= this.friendPenalty(u, a, ac.friends); }
    }
    const top = Math.max(0, ...pool.filter(o => o.hp > 0).map(o => o.dpr));
    const others = pool.filter(o => o !== t && o.hp > 0).map(o => o.dpr);
    if (!why && others.length && t.dpr >= top && t.dpr > 0 && Math.min(...others) < t.dpr * 0.8) why = 'threat';
    if (!why && allyOn) why = 'focus';
    // leave a creature that's been talked out of the fight (Suggestion) alone, unless this kills it
    const lulled = o => o.buffs.some(b => b.endsOnDamage) && this.incap(o);
    if (lulled(t) && pool.some(o => o !== t && o.hp > 0 && !lulled(o)) && !(a.type === 'atk' && exp >= t.hp * 0.9)) { val = val * 0.1 - 6 - t.dpr; why = ''; }
    if (ac && a.type === 'atk') for (const o of ac.extra) if (lulled(o)) val -= 6 + o.dpr * 1.5;
    if (friendly && !why) why = 'cluster';
    // Fog Cloud: worth the damage it stops ranged enemies (not already in someone's face) from dealing,
    // minus the targets it takes away from our own shooters
    if (a.ext && a.ext.zone && a.ext.zone.fog && !noArea) {
      if (this.zones && this.zones.some(z => z.fog && z.src === u.uid)) return { val: -Infinity, why: '' };
      const mine = this.alliesOf(u).filter(o => o.onBoard && this.alive(o));
      const shooters = mine.filter(o => o.actions.some(q => q.type === 'atk' && q.actionSlot === 0 && (q._range || 5) > 15)).length;
      const caught = [t].concat(ac ? ac.extra : []);
      val = 0;
      for (const c of caught) {
        const engagedC = mine.some(o => this.dist(o, c) <= Math.max(5, this.meleeReach(c)));
        const rangedC = this.meleeReach(c) === 0 || c.actions.some(q => q.type === 'atk' && (q._range || 5) > 15);
        val += rangedC && !engagedC ? c.dpr * 2.2 : -c.dpr * 0.2;
      }
      val -= shooters * 2 * caught.length / Math.max(1, pool.length);
      return { val, why: 'cluster' };
    }
    return { val, why, friendly };
  }
  if (a.type === 'heal') return { val: (t.hp <= 0 ? 50 : 0) + (1 - t.hp / t.maxHp) * 20, why: t.hp <= 0 ? 'revive' : '' };
  return { val: this.effectValue(a.buff, t, false) + (t === u ? 0.3 : 0), why: '' };
};
/* the value of putting buff/debuff `b` on `t` (tactical) */
const DUR_WEIGHT = { 'entire encounter': 3, 'repeat the save each round': 2, '1 round': 1, 'until next attack made': 0.6, 'until next attack taken': 0.6 };
Sim.prototype.effectValue = function (b, t, hostile) {
  if (!b) return 0;
  const dur = DUR_WEIGHT[b.duration] || 1;
  let v = 0;
  const c = b.condition;
  if (hostile) {
    // the target's own offence it loses, and how much easier it becomes to hit
    if (['Incapacitated', 'Paralyzed', 'Stunned', 'Unconscious', 'Petrified'].includes(c)) v += t.dpr * 2 + 8;
    else if (c === 'Restrained') v += t.dpr * 0.4 + 4;
    else if (c === 'Blinded') v += t.dpr * 0.4 + 3;
    else if (['Frightened', 'Poisoned', 'Attacks with Disadvantage', 'Attacks and saves with Disadvantage'].includes(c)) v += t.dpr * 0.3 + 1;
    else if (c === 'Is attacked with Advantage' || c === 'Attacks and is attacked with Advantage') v += 3;
    if (b.toHit !== undefined) v += Math.max(0, -avgDice(b.toHit)) * 0.05 * t.dpr * 2;
    if (b.ac !== undefined) v += Math.max(0, -avgDice(b.ac)) * 1.5;
    if (typeof b.damageTakenMultiplier === 'number') v += Math.max(0, b.damageTakenMultiplier - 1) * 12;
    if (typeof b.damageMultiplier === 'number') v += Math.max(0, 1 - b.damageMultiplier) * t.dpr * 1.5;
    if (b.damage !== undefined) v += Math.max(0, avgDice(b.damage));
    // no point spending it on something about to drop
    v *= Math.min(1, t.hp / Math.max(8, t.maxHp * 0.25));
  } else {
    const incoming = this.enemiesOf(t).filter(e => e.onBoard && this.alive(e) && this.dist(e, t) <= Math.max(5, this.meleeReach(e)) + 5).reduce((sum, e) => sum + e.dpr, 0);
    if (b.toHit !== undefined) v += Math.max(0, avgDice(b.toHit)) * 0.05 * t.dpr * 2;
    if (b.damage !== undefined) v += Math.max(0, avgDice(b.damage)) * 0.65 * Math.max(1, t.dpr / 8);
    if (typeof b.damageMultiplier === 'number') v += Math.max(0, b.damageMultiplier - 1) * t.dpr;
    if (c === 'Attacks with Advantage') v += t.dpr * 0.25;
    if (b.ac !== undefined) v += Math.max(0, avgDice(b.ac)) * 0.05 * (incoming + 2) * 1.5;
    if (typeof b.damageTakenMultiplier === 'number') v += Math.max(0, 1 - b.damageTakenMultiplier) * (incoming + 2);
    if (b.damageReduction !== undefined) v += Math.max(0, avgDice(b.damageReduction)) * 0.5;
    if (c === 'Is attacked with Disadvantage' || c === 'Invisible') v += (incoming + 2) * 0.3;
    if (!v) v = 2;
  }
  return v * dur;
};
/* would this buff/debuff be wasted on `t` because the effect is already there? */
Sim.prototype.alreadyHas = function (a, t) {
  if (a.type !== 'buff' && a.type !== 'debuff') return false;
  const d = a.buff && a.buff.duration;
  if (d !== 'entire encounter' && d !== 'repeat the save each round') return false;
  return t.buffs.some(b => b.id === a.id);
};
/* heals marked "default" only make sense when someone actually needs them */
Sim.prototype.healNeeded = function (u, a, t) {
  if (a.type !== 'heal') return true;
  if (a.ext && a.ext.aid) return !t.aided;
  if (a.tempHP && a.target === 'self') return !(t.temp > 0);
  if (t.hp <= 0) return true;
  if (a.condition !== 'default') return true;
  if (a.tempHP) return !t.temp;
  return t.hp < t.maxHp * 0.5;
};
/* party pacing: hold long-rest resources when the fight is in hand and more fights are coming */
Sim.prototype.fightInHand = function (u) {
  if (u.team !== 'party' || !this.encountersLeft) return false;
  const mine = this.alliesOf(u).filter(o => this.alive(o) && o.onBoard), theirs = this.enemiesOf(u).filter(e => this.alive(e) && e.onBoard);
  const myDpr = mine.reduce((t, o) => t + o.dpr, 0) * 0.6, theirDpr = theirs.reduce((t, e) => t + e.dpr, 0) * 0.6;
  const roundsToWin = theirs.reduce((t, e) => t + e.hp, 0) / Math.max(1, myDpr);
  const roundsToLose = mine.reduce((t, o) => t + o.hp, 0) / Math.max(1, theirDpr);
  return roundsToLose >= roundsToWin * 3 && mine.every(o => o.hp > o.maxHp * 0.35);
};
Sim.prototype.holdsResource = function (u, a) {
  if (u.ai !== 'tactical' || !(a.type === 'atk' || a.type === 'debuff')) return false;
  const k = freqKind(a.freq);
  if (k === 'at will' || k === 'recharge' || k === '1/fight') return false;
  if (u._noHold) return false;                                   // holding back would mean wasting the turn
  if (k === 'sr' && this.restBeforeNext) return false;           // it comes back before the next fight anyway
  return this.fightInHand(u);
};

Sim.prototype.hasMelee = function (u) {
  return u.actions.some(a => a.type === 'atk' && !a.useSaves && a.actionSlot === 0 && (a._range || 5) <= 10 && !(a.ext && a.ext.swallow));
};
Sim.prototype.canBonusDisengage = function (u) {
  if (u.tpl.ext && u.tpl.ext.bonusDisengage === true) return true;
  if (u.tpl.ext && u.tpl.ext.bonusDisengage === false) return false;   // explicitly switched off
  return u.actions.some(a => a.actionSlot === 1 && /cunning action|nimble escape|disengage/i.test(a.name || ''));
};

/* ===== SPELLCASTING: which spell is worth it right now =====
   Every option in the action and bonus-action slots gets a value (what it would actually do this
   turn, from where the caster could stand) minus what the spell slot costs. Slot cost grows with
   the slot's level, with how many fights are still ahead and how few slots are left, and shrinks
   when things are going badly. The slots' actions are then re-ordered best-first, so the normal
   turn logic (movement, targeting, the tactical square search) simply uses the best one it can. */
Sim.prototype.slotCost = function (u, level) {
  if (!level) return 0;
  if (u.team !== 'party') return level * 1.5;
  const left = this.encountersLeft || 0;
  const slotsLeft = u.slots.reduce((t, n, i) => t + n * (i + 1), 0);
  const perFight = slotsLeft / (left + 1);                        // slot levels it can afford per fight from here
  if (!left) return level * 0.5;                                  // last fight of the day: unspent slots are wasted
  let c = level * 2 * (1 + left * 0.5) * Math.min(2.5, Math.max(0.6, level * 2 / Math.max(1, perFight)));
  if (this.fightInHand(u)) c *= 1.8;
  const mine = this.alliesOf(u).filter(o => o.onBoard && !o.dead);
  const hpFrac = mine.reduce((t, o) => t + Math.max(0, o.hp), 0) / Math.max(1, mine.reduce((t, o) => t + o.maxHp, 0));
  if (mine.some(o => o.hp <= 0) || hpFrac < 0.45 || u.hp < u.maxHp * 0.35) c *= 0.35;   // things are going badly: spend
  return c;
};
Sim.prototype.optionValue = function (u, a, budget) {
  if (!this.usable(u, a) || !this.condOk(u, a)) return -Infinity;
  const p = this.plan(u, a, budget);
  if (!p || !p.targets.length) return -Infinity;
  let v = 0;
  const lvl = a._spell ? a._spell.level : 0;
  const castL = lvl ? Math.max(lvl, this.slotFor(u, lvl)) : 0;
  let act = a;
  if (lvl && a._spell.upcast && castL > lvl) {
    const extra = Array(castL - lvl).fill(a._spell.upcast).join(' + ');
    act = Object.assign({}, a, a.type === 'heal' ? { amount: a.amount + ' + ' + extra } : a.type === 'atk' ? { dpr: a.dpr + ' + ' + extra } : {});
    if (a.type === 'atk' && a.ext && a.ext.wtDpr) act.ext = Object.assign({}, a.ext, { wtDpr: a.ext.wtDpr + ' + ' + extra });
  }
  if (a.type === 'atk' || a.type === 'debuff') {
    const pool = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e));
    const t = p.targets[0];
    v = this.targetValue(u, act, t, pool, p.dest.x, p.dest.y).val;
    // shoving a creature out of someone's face is worth roughly the hits it won't land
    if (a.ext && a.ext.onHit && a.ext.onHit.push && this.meleeReach(t) > 0 && this.meleeReach(t) < a.ext.onHit.push + 5 &&
        this.alliesOf(u).some(o => o.onBoard && this.alive(o) && this.dist(o, t) <= this.meleeReach(t))) v += t.dpr * 0.5;
    if (a.ext && a.ext.zone && a.ext.zone.difficult) v += 2;
    if (!this.areaCatch(act, t, p.dest.x, p.dest.y, pool, u) && a.type === 'debuff') for (const o of p.targets.slice(1)) v += this.expected(u, act, o);
    if (a.type === 'atk' && !act.useSaves) for (const o of p.targets.slice(1)) v += Math.min(this.expected(u, act, o), o.hp + 4);
  } else if (a.type === 'heal') {
    const amt = avgDice(act.amount);
    const hx = a.ext || {};
    if (hx.aid) { for (const t of p.targets) v += t.hp <= 0 ? 25 + t.dpr : amt * 0.8; }
    else if (a.tempHP) {
      const adj = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e) && this.meleeReach(e) > 0 && this.dist(e, u) <= 15).length;
      for (const t of p.targets) v += Math.max(0, amt - (t.temp || 0)) * 0.7 + (hx.retaliate ? hx.retaliate.dmg * (castL || 1) * 0.6 * adj : 0) + (hx.tempBuff && hx.tempBuff.ac ? hx.tempBuff.ac * adj * 1.5 : 0);
    }
    else for (const t of p.targets) v += t.hp <= 0 ? 25 + t.dpr + amt * 0.3 : Math.min(amt, t.maxHp - t.hp) * (t.hp < t.maxHp * 0.5 ? 1.1 : 0.4);
  } else if (a.type === 'buff') {
    for (const t of p.targets) v += this.effectValue(act.buff, t, false);
  }
  if (lvl && a._spell.conc && u.concentrating && u.concentrating !== a.id) v -= 8;   // drops what it's already holding
  if (p.path && p.path.length && budget) v -= p.path.length * 0.1;
  return v - this.slotCost(u, castL);
};
Sim.prototype.rankSpells = function (u) {
  if (!u.hasSpells || this.incap(u) || u.hp <= 0) return;
  const speed = (this.has(u, ['Restrained']) || u.grappledBy) ? 0 : this.speedOf(u);
  const out = [];
  u.spellNotes = {};
  for (const slot of [0, 1]) {
    const list = u.actions.filter(a => a.actionSlot === slot);
    if (!list.some(a => a._spell)) { out.push(...list); continue; }
    const tele = list.filter(a => a.ext && a.ext.teleport);
    for (const a of tele) list.splice(list.indexOf(a), 1);
    out.push(...tele);
    // hand-written conditional actions (potions, recharge abilities…) keep their place on top
    const fixed = list.filter(a => !a._spell && !(freqKind(a.freq) === 'at will' && a.condition === 'default'));
    const pool = list.filter(a => !fixed.includes(a));
    const scored = pool.map((a, i) => ({ a, i, v: this.optionValue(u, a, speed) }));
    scored.sort((p, q) => (q.v - p.v) || (p.i - q.i));
    // a levelled spell that's worth less than doing nothing waits below the free options
    const free = scored.filter(x => !(x.a._spell && x.a._spell.level) || x.v > 0);
    const rest = scored.filter(x => !free.includes(x));
    out.push(...fixed, ...free.map(x => x.a), ...rest.map(x => x.a));
    if (scored[0] && scored[0].v > -Infinity) u.spellNotes[slot] = scored[0];
  }
  out.push(...u.actions.filter(a => a.actionSlot !== 0 && a.actionSlot !== 1));
  u.actions = out;
};

/* ===== TACTICAL TURN PLANNING =====
   Looks at every square it could end its move on and every way to spend the turn:
     act        — move (maybe provoking), then use its best action from there
     bonusDis   — Disengage as a bonus action (Cunning Action, Nimble Escape…), move freely, then act
     actionDis  — Disengage as its action: move freely, no attack
     dodge      — move, then Dodge (attacks against it have disadvantage)
     dash       — double move toward the fight when nothing is in reach
   and weighs what it could do from each square against how much it would get hurt there next round. */
Sim.prototype.notePacing = function (u) {
  if (this.record && !u.notedPacing && u.team === 'party' && this.encountersLeft && u.actions.some(a => a.actionSlot === 0 && this.usable(u, a) && this.holdsResource(u, a))) {
    u.notedPacing = true;
    this.ev('intent', `${u.name} saves their bigger spells and abilities: this fight is in hand and there's more to come today`, { uid: u.uid });
  }
};
/* Dash only pays off when it gets you attacking a turn sooner: from `need` feet out, walking attacks on
   turn ceil(need/speed), dashing first attacks on turn ceil(need/speed) - 1 (never before turn 2).
   So it's only worth it past 2 × speed; closer than that, walk up and Dodge instead. Beasts just charge. */
Sim.prototype.dashWorthIt = function (u, need, speed) {
  if (u.ai === 'beast') return true;
  return speed > 0 && need > speed * 2;
};
Sim.prototype.tacticalTurn = function (u, speed) {
  const prevF = this._flyer; this._flyer = u.fly ? u : null;
  try { return this.tacticalTurnInner(u, speed); } finally { this._flyer = prevF; }
};
Sim.prototype.tacticalTurnInner = function (u, speed) {
  const W = this.W;
  const foes = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e));
  if (!foes.length) return null;
  const myTeam = this.alliesOf(u).filter(o => o.onBoard && this.alive(o));
  const meleeSelf = this.hasMelee(u);
  const hpFrac = Math.max(0, u.hp / u.maxHp);
  // the back line cares more about safety, and everyone does when hurt
  const safetyW = (meleeSelf ? 0.45 : 0.9) * (1 + 1.6 * (1 - hpFrac));

  // ---- the actions it might use, in its own priority order (same economy rules as choose()) ----
  const acts = u.actions.filter(a => a.actionSlot === 0 && this.usable(u, a) && this.condOk(u, a) && !this.holdsResource(u, a));
  const poolOf = a => {
    if (a.target === 'self' || a._range === 0) return (this.alreadyHas(a, u) || !this.healNeeded(u, a, u)) ? [] : [u];
    if (a.type === 'atk' || a.type === 'debuff') {
      let p = this.enemiesOf(u).filter(e => e.onBoard && (this.alive(e) || (a.type === 'atk' && this.mayHitDowned(u, e))) && !this.alreadyHas(a, e));
      if (a.ext && a.ext.swallow) { const mx = sizeIdx(a.ext.swallow.maxSize, 2); p = p.filter(t => t.grappledBy === u.uid && sizeIdx(t.size, 2) <= mx); }
      return p;
    }
    if (a.type === 'heal') return this.alliesOf(u).filter(o => o.onBoard && !o.dead && o.hp < o.maxHp && (a.condition !== 'ally at 0 HP' || o.hp <= 0) && this.healNeeded(u, a, o));
    return this.alliesOf(u).filter(o => o.onBoard && this.alive(o) && !this.alreadyHas(a, o));
  };
  // a levelled spell is weighed at the slot it would actually be cast with
  const upcastOf = a => {
    if (!(a._spell && a._spell.level)) return a;
    const L = Math.max(a._spell.level, this.slotFor(u, a._spell.level)), k = L - a._spell.level;
    if (k <= 0 || !a._spell.upcast) return a;
    const extra = Array(k).fill(a._spell.upcast).join(' + ');
    const o = Object.assign({}, a, a.type === 'heal' ? { amount: a.amount + ' + ' + extra } : a.type === 'atk' ? { dpr: a.dpr + ' + ' + extra } : {});
    if (a.type === 'atk' && a.ext && a.ext.wtDpr) o.ext = Object.assign({}, a.ext, { wtDpr: a.ext.wtDpr + ' + ' + extra });
    return o;
  };
  const plans = acts.map(a0 => {
    const a = upcastOf(a0);
    const pool = poolOf(a0);
    const limited = !['at will', 'recharge'].includes(freqKind(a.freq));
    return { a: a0, act: a, pool, range: Math.max(5, a._range || 5), self: a.target === 'self' || a._range === 0, limited,
             aoe: (a.useSaves || a.type === 'debuff') && (a.targets || 1) > 1, area: !!areaSpec(a),
             cost: a._spell && a._spell.level ? this.slotCost(u, Math.max(a._spell.level, this.slotFor(u, a._spell.level))) : 0,
             vals: new Map(pool.map(t => [t.uid, this.targetValue(u, a, t, pool, t.x, t.y)])),
             base: areaSpec(a) && !(a.ext && a.ext.zone && a.ext.zone.fog) ? new Map(pool.map(t => [t.uid, this.targetValue(u, a, t, pool, t.x, t.y, true)])) : null,
             exp: new Map(), acCache: new Map(), sphere: (areaSpec(a) || {}).shape === 'sphere',
             cluster: new Map(pool.map(t => { const ac = this.areaCatch(a, t, u.x, u.y, pool.filter(o => o.hp > 0)); return [t.uid, ac ? ac.extra.length > 0 : pool.some(o => o !== t && o.hp > 0 && this.dist(o, t) <= 10)]; })) };
  }).filter(pl => pl.pool.length);
  const atWill = plans.filter(pl => freqKind(pl.a.freq) === 'at will' && pl.a.type === 'atk');
  const lone = foes.length === 1 ? foes[0] : null;

  // best thing to do from (x,y): first action in priority order with a worthwhile target in range
  const meleeFoes = foes.filter(e => !this.incap(e) && this.meleeReach(e) > 0);
  // Spellcasters weigh every option at each square (an area spell is scored on who it would actually catch
  // from there, minus what the slot is worth); everyone else uses the first action in its own order that has a target.
  const weigh = !!u.hasSpells;
  // weighing order: plain options first, so area spells can be skipped when even their best case can't beat them
  const ordered = weigh && !(plans[0] && plans[0].self) ? plans.filter(pl => !pl.area).concat(plans.filter(pl => pl.area)) : plans;
  const boundOf = (pl, t) => {
    if (!pl.bound) pl.bound = new Map();
    let b = pl.bound.get(t.uid);
    if (b === undefined) {
      const sp = areaSpec(pl.act), reach = sp ? (sp.shape === 'sphere' ? sp.size : sp.size * 2) : 0;
      b = pl.base.get(t.uid).val;
      for (const o of pl.pool) if (o !== t && o.hp > 0 && this.dist(o, t) <= reach) { let e = pl.exp.get(o.uid); if (e === undefined) { e = this.expected(u, pl.act, o); pl.exp.set(o.uid, e); } b += e; }
      pl.bound.set(t.uid, b);
    }
    return b;
  };
  const offenseAt = (x, y) => {
    const engagedHere = meleeFoes.some(e => this.distXY(x, y, e) <= e._mr);
    let overall = null;
    const dC = new Map(), sC = new Map();
    const dOf = t => { let d = dC.get(t); if (d === undefined) { d = this.distXY(x, y, t); dC.set(t, d); } return d; };
    const seen = t => { let v = sC.get(t); if (v === undefined) { v = this.canSee(x, y, t); sC.set(t, v); } return v; };
    for (const pl of ordered) {
      if (pl.self) { if (!overall) return { pl, t: u, val: 5, why: '' }; continue; }
      if (pl.limited && lone && atWill.length && lone.hp <= Math.max(...atWill.map(w => this.expected(u, w.a, lone))) * 1.5) continue;
      let best = null;
      for (const t of pl.pool) {
        if (dOf(t) > pl.range || !seen(t)) continue;
        let v = pl.vals.get(t.uid).val, why = pl.vals.get(t.uid).why;
        let catches = pl.cluster.get(t.uid);
        if (pl.area && pl.base) {
          if (weigh && overall && boundOf(pl, t) - pl.cost <= overall.net) continue;
          // from this square: who the area really catches, allies included
          let ac = pl.sphere ? pl.acCache.get(t.uid) : null, friends;
          if (ac && Math.max(Math.abs(ac.ax - x), Math.abs(ac.ay - y)) * 5 > pl.range) ac = null;
          if (!ac) {
            ac = this.areaCatch(pl.act, t, x, y, pl.pool.filter(o => o.hp > 0), u);
            if (!ac) continue;
            if (pl.sphere) { ac.cellSet = new Set(ac.cells.map(c => c[0] + ',' + c[1])); ac.others = ac.friends.filter(f => f !== u); pl.acCache.set(t.uid, ac); }
          }
          friends = pl.sphere ? (ac.cellSet.has(x + ',' + y) ? ac.others.concat([u]) : ac.others) : ac.friends;
          const b = pl.base.get(t.uid);
          v = b.val; why = b.why;
          for (const o of ac.extra) { let e = pl.exp.get(o.uid); if (e === undefined) { e = this.expected(u, pl.act, o); pl.exp.set(o.uid, e); } v += e; }
          if (ac.extra.length) why = why || 'cluster';
          if (friends.length) { v -= this.friendPenalty(u, pl.act, friends); if (v <= 0) continue; }
          catches = ac.extra.length > 0;
        } else if (pl.area || (t.hp <= 0 && pl.a.type === 'atk')) {
          // Fog Cloud, or finishing a downed foe: the full valuation (a cloud's worth hardly depends on where it's cast from, so once per target)
          let tv;
          if (pl.area) { if (!pl.tvCache) pl.tvCache = new Map(); tv = pl.tvCache.get(t.uid); if (!tv) { tv = this.targetValue(u, pl.act, t, pl.pool, x, y); pl.tvCache.set(t.uid, tv); } }
          else tv = this.targetValue(u, pl.act, t, pl.pool, x, y);
          v = tv.val; why = tv.why;
        }
        if (pl.range > 10 && !pl.a.useSaves && pl.a.type === 'atk' && engagedHere) v *= 0.6;     // shooting in melee
        if (pl.limited && pl.aoe && !catches && !weigh) continue;   // no single-target fireballs (casters weigh it against the slot instead)
        if (!best || v > best.val) best = { pl, t, val: v, why };
      }
      if (!best) continue;
      if (!weigh) return best;
      const net = best.val - pl.cost;
      if (!overall || net > overall.net) overall = Object.assign(best, { net });
    }
    return overall;
  };

  // how hard it would get hit standing at (x,y) next round
  const threatInfo = foes.filter(e => !this.incap(e) && e.hp > 0).map(e => {
    let dmg = 0, reach = 5;
    for (const a of e.actions) {
      if (a.actionSlot !== 0 || a.type !== 'atk' || !this.usable(e, a) || (a.ext && a.ext.swallow)) continue;
      const d = this.expected(e, a, u);
      if (d > dmg) { dmg = d; reach = Math.max(5, a._range || 5); }
    }
    const grabbed = e.grappledBy || this.has(e, ['Restrained']);
    const move = grabbed ? 0 : this.speedOf(e);
    const others = myTeam.filter(o => o !== u && this.dist(o, e) <= move + reach).length;
    const aura = e.actions.filter(a => (a.actionSlot === 5 || a.actionSlot === 6) && a.type === 'atk' && this.usable(e, a))
      .map(a => ({ r: Math.max(5, a._range || 10), d: this.expected(e, a, u) }));
    // with terrain, a melee foe threatens only the squares it can actually walk up to
    let zone = null;
    if (this.T.any && reach <= 10) {
      const rm = this.reachMap(e, move), r = Math.round(reach / 5), Wd = this.W, Hd = this.H;
      zone = new Uint8Array(Wd * Hd);
      for (let i = 0; i < rm.dist.length; i++) {
        if (rm.dist[i] < 0) continue;
        const cx = i % Wd, cy = (i / Wd) | 0, ch = this.T.h[i];
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= Wd || ny >= Hd) continue;
          const n = nx + ny * Wd;
          if (Math.abs(this.T.h[n] - ch) <= r) zone[n] = 1;
        }
      }
    }
    return { e, dmg, reach: move + reach, others, aura, zone };
  });
  const threatAt = (x, y) => {
    let t = 0;
    for (const ti of threatInfo) {
      const d = this.distXY(x, y, ti.e);
      if (ti.zone) { if (ti.zone[x + y * this.W]) t += ti.dmg / (1 + ti.others); }
      else if (d <= ti.reach) t += ti.dmg / (1 + ti.others) * (this.T.any && !this.los(ti.e.x, ti.e.y, x, y) ? 0.4 : 1);
      for (const au of ti.aura) if (d <= au.r) t += au.d;
    }
    return t;
  };
  // group sensibly: spread out against area attacks
  const foeAoE = foes.some(e => e.actions.some(a => (a.useSaves || a.type === 'debuff') && (a.targets || 1) > 1));
  const spacingAt = (x, y) => foeAoE ? myTeam.filter(o => o !== u && this.distXY(x, y, o) <= 10).length * 1.2 : 0;

  // opportunity attacks it would take walking a path
  const oaCost = (path, disengaged) => {
    if (disengaged || !path.length) return 0;
    let cost = 0, cx = u.x, cy = u.y;
    const used = new Set();
    for (const st of path) {
      for (const e of this.adjacentEnemies(u, cx, cy)) {
        if (used.has(e) || !e.reaction || this.distXY(st.x, st.y, e) <= this.meleeReach(e)) continue;
        const a = e.actions.find(o => o.type === 'atk' && !o.useSaves && o.actionSlot === 0 && o._range <= 10 && !(o.ext && o.ext.swallow));
        if (a) { cost += this.expected(e, Object.assign({}, a, { targets: 1 }), u); used.add(e); }
      }
      cx = st.x; cy = st.y;
    }
    return cost;
  };

  const engaged = this.adjacentEnemies(u, u.x, u.y).some(e => e.reaction);
  const bonusDis = engaged && this.canBonusDisengage(u);
  let _bc;
  const bonusCost = () => { if (_bc === undefined) { const b = this.choose(u, 1, 0); _bc = b ? (b.a.type === 'atk' ? this.expected(u, b.a, b.p.targets[0] || u) : 3) : 0; } return _bc; };

  const options = [];
  // squares taken by anyone (can't end there)
  const taken = new Uint8Array(W * this.H);
  for (const o of this.units) if (o !== u && o.onBoard && !o.dead) taken[o.x + o.y * W] = 1;
  const consider = (budget, fn) => {
    const rm = this.reachMap(u, speed > 0 ? budget : 0);
    for (let i = 0; i < rm.dist.length; i++) {
      if (rm.dist[i] < 0 || taken[i]) continue;
      fn(i % W, (i / W) | 0, rm, rm.dist[i]);
    }
  };
  const nearestNeed = (x, y) => {
    // how far from being able to use its main action next turn
    let best = Infinity;
    for (const pl of plans) {
      if (pl.self) continue;
      for (const t of pl.pool) if (t.hp > 0) best = Math.min(best, Math.max(0, this.distXY(x, y, t) - pl.range));
      if (best < Infinity) break;
    }
    return best === Infinity ? 0 : best;
  };
  const canDodge = hpFrac < 0.4;
  let anyOffense = false;
  // hiding: which squares nobody can see, and how many steps each square is from one
  const hideA = this.T.any && !bonusDis ? u.actions.find(a => isHideAction(a) && a.actionSlot === 1 && this.usable(u, a) && this.condOk(u, a)) : null;
  let distH = null;
  const spSteps = Math.floor(speed / 5);
  if (hideA && speed > 0) {
    const N = W * this.H, q = [];
    distH = new Int16Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      if (this.T.wall[i] || (taken[i])) continue;
      if (this.concealedAt(u, i % W, (i / W) | 0)) { distH[i] = 0; q.push(i); }
    }
    for (let k = 0; k < q.length; k++) {
      const c = q[k], cx = c % W, cy = (c / W) | 0;
      if (distH[c] >= spSteps) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= this.H) continue;
        const n = nx + ny * W; if (distH[n] >= 0 || this.T.wall[n]) continue;
        distH[n] = distH[c] + 1; q.push(n);
      }
    }
  }
  consider(speed, (x, y, rm, steps) => {
    const off = offenseAt(x, y);
    const th = threatAt(x, y), sp = spacingAt(x, y);
    const danger = th * safetyW + sp;
    const walk = steps * 0.15;
    const oa = engaged && steps > 0 ? oaCost(this.pathTo(rm, x, y), false) : 0;
    if (off) {
      anyOffense = true;
      // Steady Aim only works for a creature that stays put: standing still is worth the advantage
      const aim = u.steadyAim && steps === 0 && off.pl.a.type === 'atk' && !off.pl.a.useSaves && !this.featureAdv(u, off.t) ? off.val * 0.3 : 0;
      const opt = { mode: 'act', x, y, rm, off, score: off.val + aim - danger - oa - walk };
      // shoot, then use the rest of the move to get out of sight and Hide: advantage next turn, and harder to hit back
      if (distH && !aim && off.pl.a.type === 'atk') {
        const dh = distH[x + y * W];
        if (dh >= 0 && dh <= spSteps - steps && (dh === 0 || !this.adjacentEnemies(u, x, y).length)) {
          opt.hideAfter = spSteps - steps; opt.score += off.val * 0.3 + danger * 0.5 + 2;
        }
      }
      options.push(opt);
      if (bonusDis && steps > 0) options.push({ mode: 'bonusDis', x, y, rm, off, score: off.val - danger - walk - bonusCost() * 0.5 });
    }
    if (engaged && steps > 0) options.push({ mode: 'actionDis', x, y, rm, score: -danger - walk - nearestNeed(x, y) * 0.05 - 2 });
    options.push({ mode: 'dodge', x, y, rm, score: -th * safetyW * 0.55 - sp - oa - walk - nearestNeed(x, y) * 0.2 - 4 });
    if (distH && distH[x + y * W] === 0) options.push({ mode: 'hide', x, y, rm, score: -th * safetyW * 0.3 - sp - oa - walk - nearestNeed(x, y) * 0.2 - 2 });
  });
  // a bonus-action teleport: get out of reach without provoking, then still act
  const jumpA = engaged ? u.actions.find(a => a.ext && a.ext.teleport && a.actionSlot === 1 && this.usable(u, a)) : null;
  if (jumpA && (hpFrac < 0.6 || !meleeSelf)) {
    const R = Math.round(jumpA.ext.teleport / 5);
    for (let y = Math.max(0, u.y - R); y <= Math.min(this.H - 1, u.y + R); y++) for (let x = Math.max(0, u.x - R); x <= Math.min(W - 1, u.x + R); x++) {
      if ((x === u.x && y === u.y) || taken[x + y * W] || this.isWall(x, y) || !this.los(u.x, u.y, x, y)) continue;
      const off = offenseAt(x, y), danger = threatAt(x, y) * safetyW + spacingAt(x, y);
      const cost = (jumpA._spell && jumpA._spell.level ? this.slotCost(u, jumpA._spell.level) : 2) + bonusCost() * 0.5;
      options.push({ mode: 'jump', jumpA, x, y, rm: null, off, score: (off ? off.val : -nearestNeed(x, y) * 0.2) - danger - cost });
    }
  }
  if (anyOffense && !canDodge) for (let i = options.length - 1; i >= 0; i--) if (options[i].mode === 'dodge' || options[i].mode === 'actionDis' || options[i].mode === 'hide') {
    // healthy creatures with something to hit don't turtle; they only break away from melee if they're back-liners
    if (options[i].mode === 'dodge' || options[i].mode === 'hide' || meleeSelf) options.splice(i, 1);
  }
  if (!anyOffense && speed > 0 && this.dashWorthIt(u, nearestNeed(u.x, u.y), speed)) {
    consider(speed * 2, (x, y, rm, steps) => {
      const oa = engaged && steps > 0 ? oaCost(this.pathTo(rm, x, y), false) : 0;
      options.push({ mode: 'dash', x, y, rm, score: -nearestNeed(x, y) * 0.35 - threatAt(x, y) * safetyW * 0.6 - spacingAt(x, y) - oa - steps * 0.05 });
    });
  }
  if (!options.length) return null;
  options.sort((p, q) => q.score - p.score);
  const best = options[0];
  best.path = best.rm ? this.pathTo(best.rm, best.x, best.y) : [];
  // say why, when it's a positioning call worth noticing
  const nearFoe = (x, y) => foes.reduce((m, e) => Math.min(m, this.distXY(x, y, e)), 999);
  let note = '';
  if (best.mode === 'bonusDis') note = `${u.name} slips away with a bonus-action Disengage`;
  else if (best.mode === 'jump') note = `${u.name} teleports out of reach with ${best.jumpA.name}`;
  else if (best.mode === 'actionDis') note = `${u.name} disengages to get out of reach`;
  else if (best.mode === 'hide') note = `${u.name} slips out of sight to hide`;
  else if (best.mode === 'dodge') note = engaged ? `${u.name} goes on the defensive and Dodges` : nearestNeed(best.x, best.y) < nearestNeed(u.x, u.y) ? `${u.name} closes in carefully, Dodging as it comes` : `${u.name} holds back and Dodges`;
  else if (best.mode === 'act' && best.path.length && nearFoe(best.x, best.y) > nearFoe(u.x, u.y) && nearFoe(u.x, u.y) <= 15) note = `${u.name} falls back to keep its distance`;
  else if (best.mode === 'act' && best.off && best.off.why === 'guard') note = `${u.name} steps in to protect an ally`;
  return Object.assign(best, { note });
};

/* Downed PCs as targets:
   beast    — almost never: a 5% chance per turn it keeps mauling the prey it just dropped
   regular  — once the other side has been picked back up twice this fight
   tactical — never someone's first time down; after that it's weighed against the standing targets */
Sim.prototype.mayHitDowned = function (u, t) {
  if (t.dead || t.hp > 0 || !t.isPC || !t.onBoard) return false;
  if (u.ai === 'beast') return u.mauling && t.uid === u.focus;
  if (u.ai === 'tactical') return t.downs >= 2;
  return (this.revives[t.team] || 0) >= 2;
};

/* Find where to stand and whom to hit for an action, according to the creature's AI.
   Returns {dest:{x,y}, path, targets[], why} or null */
Sim.prototype.plan = function (u, a, budget) {
  const prevF = this._flyer; this._flyer = u.fly ? u : null;
  try { return this.planInner(u, a, budget); } finally { this._flyer = prevF; }
};
Sim.prototype.planInner = function (u, a, budget) {
  const range = Math.max(5, a._range || 5);
  if (a.target === 'self' || a._range === 0) {
    if (this.alreadyHas(a, u) || !this.healNeeded(u, a, u)) return null;
    if (isHideAction(a) && !this.concealedAt(u, u.x, u.y)) return null;
    return { dest: { x: u.x, y: u.y }, path: [], targets: [u] };
  }
  const offensive = a.type === 'atk' || a.type === 'debuff';
  let pool;
  if (offensive) pool = this.enemiesOf(u).filter(e => e.onBoard && (this.alive(e) || (a.type === 'atk' && this.mayHitDowned(u, e))));
  else if (a.type === 'heal') pool = this.alliesOf(u).filter(x => x.onBoard && !x.dead && (x.hp < x.maxHp || (a.ext && a.ext.aid)) && (a.condition !== 'ally at 0 HP' || x.hp <= 0));
  else pool = this.alliesOf(u).filter(x => x.onBoard && this.alive(x));
  if (a.ext && a.ext.swallow) {
    const max = sizeIdx(a.ext.swallow.maxSize, 2);
    pool = pool.filter(t => t.grappledBy === u.uid && sizeIdx(t.size, 2) <= max);
  }
  pool = pool.filter(t => !this.alreadyHas(a, t) && this.healNeeded(u, a, t));
  // spells like Hold Person only work on some creature types (PCs count as humanoids)
  const types = a.ext && Array.isArray(a.ext.targetTypes) && a.ext.targetTypes.length ? a.ext.targetTypes.map(x => String(x).toLowerCase()) : null;
  if (types) pool = pool.filter(t => types.includes(String(t.isPC ? 'humanoid' : (t.tpl.type || '')).toLowerCase()));
  if (!pool.length) return null;
  const ai = u.ai || 'regular';
  const canMove = !this.has(u, ['Restrained']) && !u.grappledBy && this.speedOf(u) > 0;
  const rm = this.reachMap(u, canMove ? budget : 0);
  const W = this.W;
  const ranged = range > 10;
  const casterish = ranged || a.type === 'heal' || a.type === 'buff' || a.type === 'debuff' || !!a.useSaves;
  const engagedBy = this.adjacentEnemies(u, u.x, u.y);
  const engaged = engagedBy.length > 0;
  const standingFoes = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e));

  // per-square facts that don't depend on the action or target, worked out once per position of the board
  if (!this._cellInfo) this._cellInfo = new WeakMap();
  let ci = this._cellInfo.get(rm);
  if (!ci) {
    const N = rm.dist.length, meleeFoes = standingFoes.filter(e => this.meleeReach(e) > 0);
    ci = { adj: new Int8Array(N), nd: new Int16Array(N), occ: new Uint8Array(N), leave: new Int8Array(N) };
    for (const o of this.units) if (o !== u && o.onBoard && !o.dead) ci.occ[o.x + o.y * W] = 1;
    for (let i = 0; i < N; i++) {
      if (rm.dist[i] < 0) continue;
      const x = i % W, y = (i / W) | 0;
      ci.adj[i] = this.adjacentEnemies(u, x, y).length;
      ci.nd[i] = meleeFoes.reduce((m, e) => Math.min(m, this.distXY(x, y, e)), 999);
      if (engaged) ci.leave[i] = engagedBy.filter(e => this.distXY(x, y, e) > this.meleeReach(e)).length;
    }
    this._cellInfo.set(rm, ci);
  }
  // the best square from which `t` is in range, scored by how this AI likes to stand
  const bestDest = (t) => {
    let best = null, bs = Infinity;
    for (let i = 0; i < rm.dist.length; i++) {
      if (rm.dist[i] < 0 || ci.occ[i]) continue;
      const x = i % W, y = (i / W) | 0;
      if (this.distXY(x, y, t) > range || !this.canSee(x, y, t)) continue;
      const steps = rm.dist[i];
      let sc = steps * 10;
      if (ai !== 'beast') {
        const adjN = ci.adj[i];
        if (casterish && adjN) sc += ai === 'tactical' ? 60 : 35;              // casters and archers keep out of melee
        if (ai === 'regular' && casterish && steps > 0 && ci.nd[i] <= 10) sc += 12;   // ...and don't stop right next to them
        if (steps > 0 && engaged) sc += ci.leave[i] * 60;                      // leaving reach provokes
        if (ai === 'tactical') {
          if (casterish) {
            const nd = ci.nd[i];
            if (nd <= 10) sc += 15;                                             // one step from a melee enemy
            sc -= Math.min(nd, range) / 5 * 2;                                 // otherwise, the further the better
          } else {
            sc += Math.max(0, adjN - 1) * 12;                                   // don't get surrounded
          }
        }
      }
      if (sc < bs) { bs = sc; best = { x, y, cost: sc }; }
    }
    return best;
  };
  const finish = (t, d, why) => {
    const targets = [t];
    const n = a.targets || 1;
    const ac = offensive ? this.areaCatch(a, t, d.x, d.y, pool, u) : null;
    if (ac) {
      targets.push(...ac.extra);
      return { friends: ac.friends, dest: { x: d.x, y: d.y }, path: this.pathTo(rm, d.x, d.y), targets, why: ac.extra.length ? (why === 'cluster' || !why ? 'cluster' : why) : why,
               area: { shape: ac.spec.shape, size: ac.spec.size, ox: d.x, oy: d.y, tx: ac.ax, ty: ac.ay, cells: ac.cells } };
    }
    if (n > 1 && (a.useSaves || a.type === 'debuff' || a.type === 'buff' || a.type === 'heal')) {
      // area / multi-target: extra creatures clustered near the first one (allies: anyone within range of the caster)
      const extra = this.orderBySelector(pool.filter(o => o !== t && (offensive ? this.dist(o, t) <= 10 : this.distXY(d.x, d.y, o) <= range)), a.target)
        .sort((p, q) => this.dist(p, t) - this.dist(q, t));
      targets.push(...extra.slice(0, n - 1));
    }
    return { dest: { x: d.x, y: d.y }, path: this.pathTo(rm, d.x, d.y), targets, why };
  };

  /* TACTICAL: score every target it could reach and pick the best */
  if (ai === 'tactical') {
    let pick = null, bestVal = -Infinity;
    for (const t of pool) {
      const d = bestDest(t);
      if (!d) continue;
      const tv = this.targetValue(u, a, t, pool, d.x, d.y);
      if (tv.friendly && tv.val <= 0) continue;                 // not worth catching our own people
      const val = tv.val - d.cost / 10;
      if (val > bestVal) { bestVal = val; pick = { t, d, why: tv.why }; }
    }
    return pick ? finish(pick.t, pick.d, pick.why) : null;
  }

  /* BEAST: nearest prey, sticks with what it's biting, turns on whoever hurt it */
  let ordered;
  if (ai === 'beast' && offensive) {
    const sel = this.selectorKey(a.target);
    ordered = pool.slice().sort((p, q) => (this.dist(u, p) - this.dist(u, q)) || (sel(p) - sel(q)));
    const pri = [u.lastAttacker, u.focus].map(id => pool.find(t => t.uid === id)).filter(Boolean);
    ordered = pri.concat(ordered.filter(t => !pri.includes(t)));
    for (const t of ordered) {
      const d = bestDest(t);
      if (!d) continue;
      const why = t.hp <= 0 ? 'maul' : t.uid === u.lastAttacker && t.uid !== u.focus ? 'retaliate' : t.uid === u.focus ? '' : 'nearest';
      return finish(t, d, why);
    }
    return null;
  }

  /* REGULAR: follow the action's own targeting, but fight who is in front of it rather than provoke */
  ordered = this.orderBySelector(pool, a.target);
  if (offensive && !ranged && engaged) {
    const near = ordered.filter(t => this.dist(u, t) <= range);
    if (near.length) ordered = near.concat(ordered.filter(t => !near.includes(t)));
  }
  for (const t of ordered) {
    const d = bestDest(t);
    if (!d) continue;
    const res = finish(t, d, t.hp <= 0 ? 'grudge' : '');
    if (res.friends && res.friends.length && (res.friends.some(f => f.hp <= 0) || res.friends.length >= res.targets.length)) continue;
    return res;
  }
  return null;
};

Sim.prototype.moveAlong = function (u, path) {
  if (!path.length) return;
  let seg = [], from = { x: u.x, y: u.y };
  const flush = () => {
    if (seg.length) this.ev('move', `${u.name} moves ${seg.length * 5} ft`, { uid: u.uid, path: seg.slice(), from: Object.assign({}, from) });
    seg = []; from = { x: u.x, y: u.y };
  };
  for (const step of path) {
    const after = new Set(this.adjacentEnemies(u, step.x, step.y));
    for (const e of (u.disengaged ? [] : this.adjacentEnemies(u, u.x, u.y))) {
      if (after.has(e) || !e.reaction || this.incap(e)) continue;
      const atk = e.actions.find(a => a.type === 'atk' && !a.useSaves && a.actionSlot === 0 && a._range <= 10 && !(a.ext && a.ext.swallow));
      if (!atk) continue;
      flush();
      e.reaction = false;
      this.ev('oa', `${e.name} takes an opportunity attack at ${u.name}`, { uid: e.uid, target: u.uid });
      this.attackOnce(e, atk, u, { oa: true });
      if (u.dead || u.hp <= 0) return;
      if (u.grappledBy || this.has(u, ['Restrained'])) { flush(); this.ev('effect', `${u.name} is stopped in place`, { uid: u.uid }); return; }
    }
    u.x = step.x; u.y = step.y; seg.push({ x: step.x, y: step.y }); u.movedThisTurn = true; this.boardChanged();
    u._steps = (u._steps || 0) + (!u.fly && this.T.any && this.T.rough[step.x + step.y * this.W] ? 2 : 1);
  }
  flush();
  for (const o of this.units) if (o.team !== u.team && o.onBoard && this.isHidden(o) && this.dist(u, o) <= 5 && !this.incap(u)) {
    this.dropBuffs(o, b => b.expiry === 'hide');
    this.ev('effect', `${u.name} finds ${o.name}`, { uid: u.uid, target: o.uid });
  }
  for (const t of this.units) if (t.grappledBy === u.uid && this.dist(u, t) > 5) {
    t.grappledBy = null; t.grappleInfo = null;
    this.ev('effect', `${t.name} is no longer grappled`, { uid: t.uid });
  }
};

/* ----- rolling ----- */
Sim.prototype.d20 = function (adv, dis, elven) {
  const R = this.R;
  if (adv && !dis) { const n = elven ? 3 : 2; let b = 0; for (let i = 0; i < n; i++) b = Math.max(b, R.d(20)); return b; }
  if (dis && !adv) return Math.min(R.d(20), R.d(20));
  return R.d(20);
};
/* the creature's bonus for a given saving throw: its real save when known, else the average */
Sim.prototype.saveBonusFor = function (t, ab) {
  const sv = t.saves;
  if (!sv || !ab) return t.saveBonus;
  if (ab === 'strdex') return Math.max(typeof sv.str === 'number' ? sv.str : t.saveBonus, typeof sv.dex === 'number' ? sv.dex : t.saveBonus);
  return typeof sv[ab] === 'number' ? sv[ab] : t.saveBonus;
};
Sim.prototype.saveRoll = function (t, dc, src, ab) {
  if (dc >= 99) return { success: false, roll: 1, total: -99 };
  const c = this.conds(t);
  const physical = ab === 'str' || ab === 'dex' || ab === 'strdex';
  // paralysed, stunned, unconscious or petrified creatures automatically fail Strength and Dexterity saves
  if (physical && ['Paralyzed', 'Stunned', 'Unconscious', 'Petrified'].some(x => c.has(x))) return { success: false, roll: 0, total: 0, autoFail: true };
  const adv = c.has('Saves with Advantage');
  const dis = c.has('Save with Disadvantage') || c.has('Attacks and saves with Disadvantage') || ((ab === 'dex') && c.has('Restrained'));
  let r = this.d20(adv, dis, false);
  let total = r + this.saveBonusFor(t, ab) + this.sumBuff(t, 'save', true);
  if (total < dc && t.luckMax && (t.uses.get('__luck') || 0) > 0 && (this._saveStakes || 0) >= 1) {
    t.uses.set('__luck', t.uses.get('__luck') - 1);
    const r2 = this.R.d(20);
    if (r2 > r) { total += r2 - r; r = r2; }
    this.ev('react', `${t.name} spends a luck point on the save`, { uid: t.uid });
  }
  // Legendary Resistance: only when failing would be dangerous — a disabling condition (paralysed, stunned,
  // restrained, frightened, blinded…), or damage that would drop it or take a big bite out of what it has left
  const failDmg = this._saveDmg || 0;
  const dangerous = (this._saveStakes || 0) >= 1 || failDmg >= t.hp || failDmg >= Math.max(t.maxHp * 0.1, t.hp * 0.25);
  if (total < dc && t.legResMax && (t.uses.get('__legres') || 0) > 0 && dc < 99 && dangerous) {
    t.uses.set('__legres', t.uses.get('__legres') - 1);
    this.ev('react', `${t.name} uses Legendary Resistance (${t.uses.get('__legres')} left)`, { uid: t.uid });
    return { success: true, roll: r, total: Math.round(total * 10) / 10, legendary: true };
  }
  return { success: total >= dc, roll: r, total: Math.round(total * 10) / 10 };
};

/* attack roll; returns {hit, crit, total, ac} */
/* feature-based advantage: Assassinate (round 1, target hasn't acted) and Vex (weapon mastery) */
Sim.prototype.featureAdv = function (att, tgt) {
  if (att.assassinate && this.round === 1 && !tgt.tookTurn) return 'assassinate';
  if (att.vex && att.vex.t === tgt.uid) return 'vex';
  if (att.packTactics && this.alliesOf(att).some(o => o !== att && o.onBoard && this.alive(o) && !this.incap(o) && this.dist(o, tgt) <= 5)) return 'pack';
  return '';
};
Sim.prototype.attackRoll = function (att, tgt, a, opt) {
  opt = opt || {};
  const ac0 = att, tc = this.conds(tgt), atc = this.conds(att);
  if (att.blindsight) { atc.delete('Blinded'); tc.delete('Invisible'); }
  if (opt.inside) atc.add('Blinded');
  const fa = opt.inside ? '' : this.featureAdv(att, tgt);
  if (fa === 'vex') att.vex = null;   // Vex is spent on the next attack against that creature
  let adv = ADV_TARGET.some(x => tc.has(x)) || ADV_SELF.some(x => atc.has(x)) || !!fa;
  let dis = DIS_TARGET.some(x => tc.has(x)) || DIS_SELF.some(x => atc.has(x));
  if (tc.has('Prone') && !opt.inside) { if (this.dist(att, tgt) <= 5) adv = true; else dis = true; }      // prone: easy up close, hard from afar
  // ranged attack with any enemy (that can see you and isn't incapacitated) within 5 ft
  if ((a._range || 5) > 10 && !opt.inside && this.enemiesOf(att).some(e => e.onBoard && this.alive(e) && !this.incap(e) && this.dist(e, att) <= 5 && !this.isHidden(att))) dis = true;
  const r = this.d20(adv, dis, att.elvenAccuracy);
  const toHit = Number(avgDice(a.toHit)) + this.sumBuff(att, 'toHit', true);
  let total = r + toHit;
  let ac = this.ac(tgt) + this.coverAC(att, tgt);
  let hit = r === 20 || (r !== 1 && total >= ac);
  let crit = r === 20;
  // Silvery-Barbs-style reactions from the target's side: reroll, take the lower
  if (hit && !opt.noReact) {
    const avgHit = avgDice(a.dpr) * (r === 20 ? 1.6 : 1);
    const matters = r === 20 || avgHit >= tgt.maxHp * 0.25 || avgHit >= tgt.hp || (a.ext && (a.ext.grapple || a.ext.swallow)) || !!a.riderEffect;
    const helper = this.alliesOf(tgt).find(h => h.reaction && !this.incap(h) && h.onBoard && this.dist(h, att) <= 60 && this.los(h.x, h.y, att.x, att.y) && (h.ai !== 'tactical' || matters) &&
      h.actions.some(x => x.actionSlot === 4 && x.type === 'debuff' && x.buff && x.buff.condition === 'Attacks with Disadvantage' && (!(x.ext && x.ext.selfOnly) || h === tgt) && this.usable(h, x) && this.condOk(h, x)));
    if (helper) {
      const x = helper.actions.find(y => y.actionSlot === 4 && y.type === 'debuff' && y.buff && y.buff.condition === 'Attacks with Disadvantage' && (!(y.ext && y.ext.selfOnly) || helper === tgt) && this.usable(helper, y) && this.condOk(helper, y));
      helper.reaction = false; this.spend(helper, x);
      const xdc = Number(avgDice(x.saveDC));
      const resisted = xdc < 99 && this.saveRoll(att, xdc, helper, x.ext && x.ext.saveAbility).success;
      const r2 = resisted ? r : Math.min(r, this.R.d(20));
      if (resisted) this.ev('react', `${helper.name} uses ${x.name}, but ${att.name} resists`, { uid: helper.uid, target: att.uid });
      else this.ev('react', `${helper.name} ${x._spell ? 'casts' : 'uses'} ${x.name}: ${att.name} rerolls (${r} → ${r2})`, { uid: helper.uid, target: att.uid });
      total = r2 + toHit; hit = r2 === 20 || (r2 !== 1 && total >= ac); crit = r2 === 20;
    }
  }
  // Lucky: the target spends a luck point to impose disadvantage on a hit that matters
  if (hit && !opt.noReact && tgt.luckMax && (tgt.uses.get('__luck') || 0) > 0) {
    const avgHit2 = avgDice((a.ext && a.ext.wtDpr) || a.dpr) * (r === 20 ? 1.6 : 1);
    if (r === 20 || avgHit2 >= tgt.hp || avgHit2 >= tgt.maxHp * 0.3 || tgt.ai !== 'tactical') {
      tgt.uses.set('__luck', tgt.uses.get('__luck') - 1);
      const r2 = Math.min(r, this.R.d(20));
      total = r2 + toHit; hit = r2 === 20 || (r2 !== 1 && total >= ac); crit = r2 === 20;
      this.ev('react', `${tgt.name} spends a luck point: ${att.name} rerolls (${r} → ${r2})`, { uid: tgt.uid, target: att.uid });
    }
  }
  // Shield-style reactions on the target: an AC boost that would turn the hit into a miss
  if (hit && !crit && !opt.noReact && tgt.reaction && !this.incap(tgt)) {
    const sh = tgt.actions.find(x => x.actionSlot === 4 && x.type === 'buff' && x.target === 'self' && x.buff && x.buff.ac !== undefined && this.usable(tgt, x) && this.condOk(tgt, x));
    const hurts = !sh || tgt.ai !== 'tactical' || r === 20 || avgDice(a.dpr) >= tgt.hp * 0.3 || tgt.hp < tgt.maxHp * 0.6 || freqKind(sh.freq) === 'at will';
    if (sh && hurts && total < ac + avgDice(sh.buff.ac)) {
      tgt.reaction = false; this.spend(tgt, sh);
      this.addBuff(tgt, tgt, sh, sh.buff);
      ac = this.ac(tgt) + this.coverAC(att, tgt); hit = false;
      this.ev('react', `${tgt.name} casts ${sh.name} (AC ${ac})`, { uid: tgt.uid });
    }
  }
  // Mirror Image: each duplicate left gives a d6; any 3+ means a duplicate took the hit instead
  let mirror = false;
  if (hit && !opt.inside) {
    const mb = tgt.buffs.find(b => b.mirror > 0);
    if (mb && !att.blindsight && !atc.has('Blinded')) {
      let fooled = false;
      for (let i = 0; i < mb.mirror; i++) if (this.R.d(6) >= 3) fooled = true;
      if (fooled) { mb.mirror--; hit = false; crit = false; mirror = true; this.ev('react', `${att.name} strikes one of ${tgt.name}'s mirror images (${mb.mirror} left)`, { uid: tgt.uid }); if (!mb.mirror) tgt.buffs = tgt.buffs.filter(b => b !== mb); }
    }
  }
  // Paralyzed / unconscious targets within 5 ft take a critical hit
  if (hit && this.dist(att, tgt) <= 5 && !opt.inside && (tc.has('Paralyzed') || tc.has('Unconscious'))) crit = true;
  // attack-scoped buffs are spent
  this.dropBuffs(att, b => b.expiry === 'until next attack made' || b.expiry === 'hide');
  this.dropBuffs(tgt, b => b.expiry === 'until next attack taken');
  return { hit, crit, total: Math.round(total * 10) / 10, ac: Math.round(ac * 10) / 10, roll: r, adv: adv && !dis, dis: dis && !adv, mirror, fa };
};

/* ----- damage, healing, death ----- */
Sim.prototype.damage = function (src, tgt, raw, info) {
  info = info || {};
  if (tgt.dead) return 0;
  let dmg = Math.max(0, raw * this.multBuff(tgt, 'damageTakenMultiplier') - this.sumBuff(tgt, 'damageReduction', false));
  dmg = Math.floor(dmg);
  if (dmg <= 0) return 0;
  // a defensive reaction on the target that reduces damage (e.g. "until next attack taken" resistance)
  if (info.attack && tgt.reaction && !this.incap(tgt) && tgt.hp > 0) {
    const r = tgt.actions.find(x => x.actionSlot === 4 && x.type === 'buff' && x.target === 'self' && x.buff && x.buff.ac === undefined &&
      (x.buff.damageTakenMultiplier !== undefined || x.buff.damageReduction !== undefined) && this.usable(tgt, x) && this.condOk(tgt, x));
    if (r) {
      tgt.reaction = false; this.spend(tgt, r);
      const red = Math.floor(Math.max(0, dmg * (typeof r.buff.damageTakenMultiplier === 'number' ? r.buff.damageTakenMultiplier : 1) - avgDice(r.buff.damageReduction || 0)));
      this.ev('react', `${tgt.name} uses ${r.name} (${dmg} → ${red})`, { uid: tgt.uid });
      dmg = red;
      if (dmg <= 0) return 0;
    }
  }
  src.dmgDealt += dmg; tgt.dmgTaken += dmg;
  if (info.attack && src.team !== tgt.team) tgt.lastAttacker = src.uid;
  if (src.swallowedBy === tgt.uid) tgt.insideDamage.set(src.uid, (tgt.insideDamage.get(src.uid) || 0) + dmg);
  if (tgt.temp) { const a = Math.min(tgt.temp, dmg); tgt.temp -= a; dmg -= a; if (tgt.temp <= 0) this.dropBuffs(tgt, b => b.whileTemp); }
  if (tgt.buffs.some(b => b.endsOnDamage)) { this.dropBuffs(tgt, b => b.endsOnDamage); this.ev('effect', `${tgt.name} snaps out of it`, { uid: tgt.uid }); }
  if (tgt.hp <= 0) {
    if (tgt.isPC && !tgt.dead) {
      if (dmg >= tgt.maxHp) { this.kill(tgt, src, 'massive damage'); return dmg; }
      tgt.stable = false;
      tgt.deathF += info.crit ? 2 : 1;
      this.ev('deathsave', `${tgt.name} takes damage while down (${tgt.deathF} failure${tgt.deathF > 1 ? 's' : ''})`, { uid: tgt.uid });
      if (tgt.deathF >= 3) this.kill(tgt, src, 'death saves');
    }
    return dmg;
  }
  const overflow = dmg - tgt.hp;
  tgt.hp = Math.max(0, tgt.hp - dmg);
  if (tgt.hp <= 0) {
    if (tgt.isPC && overflow >= tgt.maxHp) this.kill(tgt, src, 'massive damage');
    else if (tgt.isPC) this.downPC(tgt);
    else this.kill(tgt, src, '');
    this.trigger(src, -2, tgt);
    if (!tgt.dead || !tgt.isPC) this.trigger(tgt, -1, src);
  } else if (info.attack && src !== tgt) {
    this.onDamaged(tgt, src);
  }
  // concentration check: Con save, DC 10 or half the damage
  if (tgt.concentrating && tgt.hp > 0 && !tgt.dead && dmg > 0) {
    const dc = Math.max(10, Math.floor(dmg / 2));
    const roll = this.R.d(20) + (tgt.conSave || 0) + tgt.buffs.reduce((t, b) => t + (b.concBonus || 0), 0);
    if (roll < dc) this.endConcentration(tgt, `Con save ${roll} vs DC ${dc}`);
  }
  return dmg;
};
Sim.prototype.applyZones = function () {
  const T = this.T, N = this.W * this.H;
  if (!T.baseRough) T.baseRough = T.rough.slice();
  T.rough = T.baseRough.slice();
  for (const z of this.zones || []) if (z.rough) z.cells.forEach(i => { if (i >= 0 && i < N) T.rough[i] = 1; });
  const fogZ = (this.zones || []).filter(z => z.fog);
  T.fog = fogZ.length ? new Uint8Array(N) : null;
  for (const z of fogZ) z.cells.forEach(i => { if (i >= 0 && i < N) T.fog[i] = 1; });
  T.losC = new Map(); T.covC = new Map();
  T.any = T.any || (this.zones || []).length > 0;
  this.boardChanged();
};
Sim.prototype.endConcentration = function (u, why) {
  if (!u.concentrating) return;
  const id = u.concentrating;
  if ((this.zones || []).some(z => z.src === u.uid && z.id === id)) {
    this.zones.filter(z => z.src === u.uid && z.id === id).forEach(z => this.ev('zoneEnd', `the ${z.fog ? 'fog' : 'difficult ground'} fades`, { uid: u.uid, zid: z.zid }));
    this.zones = this.zones.filter(z => !(z.src === u.uid && z.id === id)); this.applyZones();
  }
  u.concentrating = null;
  let any = false;
  for (const o of this.units) { const n = o.buffs.length; o.buffs = o.buffs.filter(b => !(b.src === u.uid && b.id === id)); if (o.buffs.length !== n) any = true; }
  const sp = u.actions.find(a => a.id === id);
  if (any && why && !/^casts /.test(why)) this.ev('effect', `${u.name} loses concentration on ${sp ? sp.name : 'a spell'}${why ? ' (' + why + ')' : ''}`, { uid: u.uid });
};
Sim.prototype.downPC = function (u) {
  this.boardChanged();
  this.endConcentration(u, 'knocked out');
  this.dropBuffs(u, b => b.endsOnIncap);
  u.hp = 0; u.deathS = 0; u.deathF = 0; u.stable = false; u.everDowned = true; u.downs++;
  this.dropBuffs(u, b => b.data.duration !== 'entire encounter');
  this.releaseGrappleOf(u);
  this.ev('down', `${u.name} drops to 0 HP and falls unconscious`, { uid: u.uid });
};
Sim.prototype.kill = function (u, src, why) {
  this.boardChanged();
  this.endConcentration(u, 'slain');
  u.hp = 0; u.dead = true;
  this.releaseGrappleOf(u);
  // whoever it swallowed tumbles out
  for (const vid of u.inside.slice()) this.expel(u, this.byId[vid], 'freed');
  if (u.swallowedBy) { const w = this.byId[u.swallowedBy]; if (w) w.inside = w.inside.filter(x => x !== u.uid); }
  if (!u.isPC) u.onBoard = false;
  this.ev('death', u.isPC ? `${u.name} dies${why ? ' (' + why + ')' : ''}` : `${u.name} is slain`, { uid: u.uid });
};
Sim.prototype.heal = function (src, tgt, amt, temp) {
  if (tgt.dead) return;
  amt = Math.max(0, Math.round(amt));
  if (temp) {
    // scaled temp HP for spells cast with bigger slots (Armor of Agathys 5 per level) is already in amt
    tgt.temp = Math.max(tgt.temp, amt); return;
  }
  const was = tgt.hp;
  tgt.hp = Math.min(tgt.maxHp, tgt.hp + amt);
  if (was <= 0) this.boardChanged();
  src.healed += tgt.hp - was;
  if (was <= 0 && tgt.hp > 0) { tgt.deathS = 0; tgt.deathF = 0; tgt.stable = false; this.revives[tgt.team] = (this.revives[tgt.team] || 0) + 1; }
};
Sim.prototype.releaseGrappleOf = function (u) {
  // u can no longer hold anyone
  for (const t of this.units) if (t.grappledBy === u.uid) { t.grappledBy = null; t.grappleInfo = null; }
};

/* ----- reactions on taking damage ----- */
Sim.prototype.onDamaged = function (tgt, src) {
  if (!tgt.reaction || this.incap(tgt) || tgt.hp <= 0) return;
  for (const a of tgt.actions) {
    if (a.actionSlot !== 4 || !this.usable(tgt, a) || !this.condOk(tgt, a)) continue;
    if (a.type === 'atk' && src.onBoard && this.alive(src) && this.dist(tgt, src) <= Math.max(5, a._range) && this.los(tgt.x, tgt.y, src.x, src.y)) {
      // a levelled reaction spell (Hellish Rebuke) is only worth a slot when the damage matters
      let act = a;
      if (a._spell && a._spell.level) {
        const L = this.slotFor(tgt, a._spell.level), k = L - a._spell.level;
        if (k > 0 && a._spell.upcast) act = Object.assign({}, a, { dpr: a.dpr + ' + ' + Array(k).fill(a._spell.upcast).join(' + ') });
        const exp = avgDice(act.dpr) * (a.useSaves ? (a.halfOnSave ? 0.75 : 0.55) : 0.6);
        const worth = Math.min(exp, src.hp) * (src.hp <= exp ? 1.6 : 1) + (src.dpr || 0) * (src.hp <= exp ? 1 : 0);
        if (worth < this.slotCost(tgt, L)) continue;
        act = Object.assign({}, act, { name: `${a.name} (L${L})` });
      }
      tgt.reaction = false; this.spend(tgt, a);
      this.ev('react', `${tgt.name} reacts with ${act.name} against ${src.name}`, { uid: tgt.uid, target: src.uid });
      this.resolveAttackAction(tgt, act, [src], { reaction: true });
      return;
    }
    if (a.type === 'heal' && a.target === 'self') {
      tgt.reaction = false; this.spend(tgt, a);
      const amt = rollDice(a.amount, this.R, false);
      this.heal(tgt, tgt, amt, a.tempHP);
      this.ev('heal', `${tgt.name} reacts with ${a.name} (+${Math.round(amt)} HP)`, { uid: tgt.uid, target: tgt.uid });
      return;
    }
  }
};

/* ----- triggers: -1 reduced to 0, -2 reduced an enemy to 0, -3 before the encounter ----- */
Sim.prototype.trigger = function (u, slot, other) {
  for (const a of u.actions) {
    if (a.actionSlot !== slot || !this.usable(u, a) || !this.condOk(u, a)) continue;
    if (slot !== -1 && this.incap(u)) continue;
    this.spend(u, a);
    this.ev('trigger', `${u.name}: ${a.name}`, { uid: u.uid });
    this.doAction(u, a, null, { trigger: true, other });
  }
};

/* ----- executing actions ----- */
Sim.prototype.resolveAttackAction = function (u, a, targets, opt) {
  opt = opt || {};
  if (a.useSaves) {
    const dmgRoll = rollDice(a.dpr, this.R, false) + this.sumBuff(u, 'damage', true);
    const mult = this.multBuff(u, 'damageMultiplier');
    for (const t of targets) {
      if (t.dead) continue;
      this._saveDmg = dmgRoll * (a.ext && a.ext.dot ? 3 : 1);
      if (a.riderEffect && a.riderEffect.buff && DANGER_CONDS.includes(a.riderEffect.buff.condition)) this._saveStakes = 1;
      const s = this.saveRoll(t, Number(avgDice(a.toHit)), u, a.ext && a.ext.saveAbility);
      this._saveDmg = 0; this._saveStakes = 0;
      const at = this.mark();
      const roll = (a.ext && a.ext.dprIfHurt && t.hp < t.maxHp) ? rollDice(a.ext.dprIfHurt, this.R, false) + this.sumBuff(u, 'damage', true) : dmgRoll;
      let dmg = s.success ? (a.halfOnSave ? Math.floor(roll * mult / 2) : 0) : Math.floor(roll * mult);
      if (a.ext && a.ext.dot) {
        // no damage up front: the target is covered and burns at the start of each of its turns
        dmg = 0;
        if (!s.success) {
          const k = a._spell && u.castLevel ? u.castLevel - a._spell.level : 0;
          const dice = [a.ext.dot.dice].concat(k > 0 && a.ext.dot.upcast ? Array(k).fill(a.ext.dot.upcast) : []).join(' + ');
          this.addBuff(t, u, a, { duration: 'entire encounter' }, { dot: dice });
        }
      }
      const dealt = dmg > 0 ? this.damage(u, t, dmg, { attack: !opt.aura }) : 0;
      this.ev('save', `${u.name} → ${t.name}: ${a.name}, DC ${avgDice(a.toHit)}${a.ext && a.ext.saveAbility && a.ext.saveAbility !== 'strdex' ? ' ' + a.ext.saveAbility.toUpperCase() : ''} save ${s.autoFail ? 'auto-fail' : s.total >= 0 ? s.total : 'auto-fail'} — ${s.success ? 'saved' : 'failed'}${dealt ? `, ${dealt} damage` : ''}`,
        { uid: u.uid, target: t.uid, hit: !s.success, dmg: dealt, ranged: this.dist(u, t) > 5 });
      this.hoist(at);
      if (!s.success && a.riderEffect) this.applyRider(u, t, a);
      if (!s.success && a.ext && a.ext.onHit) this.onHitEffects(u, t, a, dealt);    // on a failed save (Arms of Hadar: no reactions)
      this.afterHitExt(u, t, a, !s.success);
    }
    this.dropBuffs(u, b => b.expiry === 'until next attack made');
    return;
  }
  // attack rolls: `targets` = number of attacks, re-aimed if the target drops
  let n = a.targets || 1;
  let cur = targets[0];
  for (let i = 0; i < n; i++) {
    if (!cur || cur.dead || (cur.hp <= 0 && !cur.isPC) || (cur.hp <= 0 && !opt.finishDowned)) {
      opt = Object.assign({}, opt, { finishDowned: false });
      const range = Math.max(5, a._range || 5);
      const opts = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e) && (opt.inside ? e.uid === u.swallowedBy : this.dist(u, e) <= range && this.canSee(u.x, u.y, e)));
      if (!opts.length) break;
      cur = this.orderBySelector(opts, a.target)[0];
    }
    this.attackOnce(u, a, cur, opt);
    if (u.dead || u.hp <= 0) break;
  }
};
/* can `u` Sneak Attack `t` with this roll? (advantage, or an active ally next to the target; never with disadvantage) */
Sim.prototype.sneakOk = function (u, t, a, r) {
  if (!u.sneak || !(a.ext && a.ext.sneak) || u.saSeq === this.turnSeq || r.dis) return false;
  if (r.adv) return true;
  return this.alliesOf(u).some(o => o !== u && o.onBoard && this.alive(o) && !this.incap(o) && this.dist(o, t) <= 5);
};
Sim.prototype.attackOnce = function (u, a, t, opt) {
  opt = opt || {};
  const r = this.attackRoll(u, t, a, opt);
  let dealt = 0, sa = false;
  const at = this.mark();
  const ex = a.ext || {};
  const agathys = r.hit && this.dist(u, t) <= 5 ? t.buffs.find(b => b.retaliate > 0) : null;
  if (r.hit) {
    const formula = (ex.dprIfHurt && t.hp < t.maxHp) ? ex.dprIfHurt : (ex.wtDpr || a.dpr);
    let raw;
    if (ex.leap) {
      // roll the dice one by one: two of the same number on the spell's dice let it leap
      const pd = parseDice(formula), die = pd.dice[0], seen = new Set();
      raw = pd.flat; opt = Object.assign({}, opt, { doubles: false });
      for (const g of pd.dice) for (let i = 0; i < g.n * (r.crit ? 2 : 1); i++) {
        const v = this.R.d(g.d); raw += g.s * v;
        if (die && g.d === die.d) { if (seen.has(v)) opt.doubles = true; seen.add(v); }
      }
      raw += this.rollBuffDamage(u, r.crit);
    } else raw = rollDice(formula, this.R, r.crit) + this.rollBuffDamage(u, r.crit);
    if (this.sneakOk(u, t, a, r)) {
      sa = true; u.saSeq = this.turnSeq;
      raw += rollDice(u.sneak.dice, this.R, r.crit);
      if (u.sneak.assassinate && this.round === 1) raw += u.sneak.assassinate;     // Assassinate: Surprising Strikes
    }
    raw *= this.multBuff(u, 'damageMultiplier');
    dealt = this.damage(u, t, Math.max(0, Math.floor(raw)), { attack: true, crit: r.crit });
  }
  const tag = (r.adv ? ' (adv' + (r.fa === 'assassinate' ? ', Assassinate' : r.fa === 'vex' ? ', Vex' : r.fa === 'pack' ? ', Pack Tactics' : '') + ')' : r.dis ? ' (dis)' : '') + (sa ? ' + Sneak Attack' : '');
  this.ev('attack', `${u.name} → ${t.name}: ${a.name}${tag}, ${r.total} vs AC ${r.ac} — ${r.crit && r.hit ? 'CRIT' : r.hit ? 'hit' : r.mirror ? 'image' : 'miss'}${r.hit ? `, ${dealt} damage` : ''}`,
    { uid: u.uid, target: t.uid, hit: r.hit, crit: r.crit && r.hit, dmg: dealt, ranged: this.dist(u, t) > 5, oa: !!opt.oa });
  this.hoist(at);
  if (agathys && !u.dead) {
    const at2 = this.mark();
    const d = this.damage(t, u, agathys.retaliate, {});
    this.ev('attack', `${t.name}'s ${agathys.name} bites back at ${u.name}, ${d} damage`, { uid: t.uid, target: u.uid, hit: true, dmg: d });
    this.hoist(at2);
  }
  if (r.hit && a.riderEffect) this.applyRider(u, t, a);
  if (r.hit && ex.onHit) this.onHitEffects(u, t, a, dealt);
  if (r.hit && ex.leap) this.leap(u, a, t, opt);
  this.afterHitExt(u, t, a, r.hit);
  return r;
};
/* ext.onHit: { vex, slow: ft, noReactions, splash: { dmg, range } } */
Sim.prototype.onHitEffects = function (u, t, a, dealt) {
  const oh = a.ext.onHit;
  if (oh.vex && dealt > 0 && !t.dead) u.vex = { t: t.uid, turn: u.turnNo || 0 };   // lasts until the end of the attacker's next turn
  if (oh.slow && !t.dead) this.addBuff(t, u, { id: 'slow:' + u.uid, name: 'Slowed', ext: { speedBonus: -oh.slow } }, { duration: '1 round' });
  if (oh.noReactions && !t.dead) t.reaction = false;
  if (oh.drain && dealt > 0 && !u.dead) { this.heal(u, u, dealt, false); this.ev('heal', `${u.name} drains ${dealt} HP`, { uid: u.uid, target: u.uid }); }
  if (oh.push && !t.dead && t.onBoard && sizeIdx(t.size, 2) <= sizeIdx(oh.pushMaxSize || 'Huge', 4)) this.push(u, t, oh.push);
  if (oh.dot && !t.dead) {
    const k = a._spell && u.castLevel ? u.castLevel - a._spell.level : 0;
    const dice = [oh.dot.dice || oh.dot].concat(k > 0 && oh.dot.upcast ? Array(k).fill(oh.dot.upcast) : []).join(' + ');
    this.addBuff(t, u, a, { duration: 'entire encounter' }, { dot: dice });
  }
  if (oh.splash) {
    const o = this.enemiesOf(u).find(e => e !== t && e.onBoard && this.alive(e) && this.dist(e, t) <= (oh.splash.range || 5));
    if (o) {
      const at = this.mark();
      const d = this.damage(u, o, Math.max(0, Math.floor(rollDice(oh.splash.dmg, this.R, false))), {});
      this.ev('attack', `${a.name} leaps to ${o.name}, ${d} damage`, { uid: u.uid, target: o.uid, hit: true, dmg: d, ranged: true });
      this.hoist(at);
    }
  }
};
/* forced movement: straight away from the source, stopping at walls, creatures and the map edge.
   No opportunity attacks; a drop of 10 ft or more means falling damage (1d6 per 10 ft) and landing prone. */
Sim.prototype.push = function (src, t, ft) {
  const dx = Math.sign(t.x - src.x), dy = Math.sign(t.y - src.y);
  if (!dx && !dy) return;
  const from = { x: t.x, y: t.y }, path = [];
  for (let i = 0; i < Math.round(ft / 5); i++) {
    const nx = t.x + dx, ny = t.y + dy;
    if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H || this.isWall(nx, ny) || this.occupant(nx, ny)) break;
    if (!t.fly && this.T.anyH && this.hAt(nx, ny) > this.hAt(t.x, t.y)) break;     // can't be shoved up a ledge
    t.x = nx; t.y = ny; path.push({ x: nx, y: ny });
  }
  if (!path.length) return;
  this.boardChanged();
  this.ev('move', `${t.name} is pushed ${path.length * 5} ft`, { uid: t.uid, path, from });
  for (const o of this.units) if (o.grappledBy && (o.grappledBy === t.uid || o === t)) {
    const g = o === t ? this.byId[t.grappledBy] : t;
    if (g && this.dist(o, g) > 5) { o.grappledBy = null; o.grappleInfo = null; this.ev('effect', `${o.name} is no longer grappled`, { uid: o.uid }); }
  }
  const drop = this.T.anyH && !t.fly ? this.hAt(from.x, from.y) - this.hAt(t.x, t.y) : 0;
  if (drop >= 2) {
    const d = this.damage(src, t, Math.floor(rollDice(Math.floor(drop / 2) + 'd6', this.R, false)), {});
    this.addBuff(t, t, { id: 'prone', name: 'Prone' }, { duration: '1 round', condition: 'Prone' });
    this.ev('effect', `${t.name} falls ${drop * 5} ft (${d} damage) and lands prone`, { uid: t.uid, dmg: d });
  }
};
/* Chromatic Orb: doubles on the damage dice make it leap to a new target, up to once per slot level */
Sim.prototype.leap = function (u, a, t, opt) {
  const L = a.ext.leap, max = (a._spell && u.castLevel) || L.max || 1;
  const done = (opt && opt.leapDone) || new Set([t.uid]);
  if (done.size > max) return;
  if (!opt || !opt.doubles) return;
  const next = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e) && !done.has(e.uid) && this.dist(e, t) <= (L.range || 30) && this.los(t.x, t.y, e.x, e.y));
  if (!next.length) return;
  const nt = this.orderBySelector(next, a.target)[0];
  done.add(nt.uid);
  this.ev('effect', `${a.name} rolled doubles and leaps ${this.dist(t, nt)} ft from ${t.name} to ${nt.name}`, { uid: u.uid, target: nt.uid, from: t.uid });
  this.attackOnce(u, Object.assign({}, a, { name: a.name + ' (leap)' }), nt, Object.assign({}, opt, { leapDone: done }));
};
Sim.prototype.rollBuffDamage = function (u, crit) {
  let t = 0;
  for (const b of u.buffs) if (b.data.damage !== undefined && b.data.damage !== '') t += rollDice(b.data.damage, this.R, crit);
  return t;
};
Sim.prototype.applyRider = function (u, t, a) {
  if (t.dead) return;
  const re = a.riderEffect;
  const rab = a.ext && (a.ext.riderSave || a.ext.saveAbility);
  if (re.dc < 99) {
    this._saveStakes = re.buff && DANGER_CONDS.includes(re.buff.condition) ? 1 : 0;
    const s = this.saveRoll(t, re.dc, u, rab);
    this._saveStakes = 0;
    if (s.success) { this.ev('save', `${t.name} resists ${a.name}'s effect (${s.total} vs DC ${re.dc})`, { uid: t.uid }); return; }
  }
  this.addBuff(t, u, a, re.buff, { dc: re.dc, saveAbility: rab });
  this.ev('effect', `${t.name} is affected by ${a.name}${re.buff.condition ? ': ' + re.buff.condition : ''}`, { uid: t.uid });
};
Sim.prototype.afterHitExt = function (u, t, a, hit) {
  const ex = a.ext || {};
  if (!hit || t.dead) return;   // a creature knocked to 0 can still be grabbed or swallowed
  if (ex.grapple && !t.grappledBy && !t.swallowedBy && sizeIdx(t.size, 2) <= sizeIdx(ex.grapple.maxSize, 2)) {
    let ok = true;
    if (typeof ex.grapple.dc === 'number') ok = !this.saveRoll(t, ex.grapple.dc, u, 'strdex').success;
    if (ok) {
      t.grappledBy = u.uid;
      t.grappleInfo = { escapeDC: ex.grapple.escapeDC || 10, restrains: ex.grapple.restrains !== false, name: a.name };
      this.ev('effect', `${t.name} is grappled by ${u.name}${t.grappleInfo.restrains ? ' and restrained' : ''}`, { uid: t.uid });
    }
  }
  if (ex.swallow && t.grappledBy === u.uid) {
    const cap = ex.swallow.capacity || 1;
    if (u.inside.length < cap) {
      t.grappledBy = null; t.grappleInfo = null;
      t.swallowedBy = u.uid; t.swallowInfo = ex.swallow; t.onBoard = false; this.boardChanged();
      u.inside.push(t.uid);
      this.ev('swallow', `${u.name} swallows ${t.name}!`, { uid: u.uid, target: t.uid });
    }
  }
};
Sim.prototype.expel = function (w, v, why) {
  if (!v) return;
  w.inside = w.inside.filter(x => x !== v.uid);
  v.swallowedBy = null; v.swallowInfo = null; v.onBoard = true;
  // land in the nearest free square
  let best = null, bd = Infinity;
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
    const x = w.x + dx, y = w.y + dy;
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) continue;
    if ((this.occupant(x, y) && !(w.dead && x === w.x && y === w.y)) || this.isWall(x, y)) continue;
    const d = Math.max(Math.abs(dx), Math.abs(dy)) + this.R() * 0.1;
    if (d < bd) { bd = d; best = { x, y }; }
  }
  if (best) { v.x = best.x; v.y = best.y; }
  this.boardChanged();
  this.addBuff(v, v, { id: 'prone', name: 'Prone' }, { duration: '1 round', condition: 'Prone' });
  this.ev('expel', why === 'freed' ? `${v.name} crawls out of ${w.name}` : `${w.name} regurgitates ${v.name}, who lands prone`, { uid: v.uid, target: w.uid });
};

Sim.prototype.doAction = function (u, a, plan, opt) {
  opt = opt || {};
  if (!isHideAction(a) && (a._spell || a.useSaves || a.type === 'debuff') && !(a.type === 'atk' && !a.useSaves) && this.isHidden(u)) {
    this.dropBuffs(u, b => b.expiry === 'hide');
    if (this.record) this.ev('effect', `${u.name} gives away its hiding place`, { uid: u.uid });
  }
  if (a.ext && a.ext.grantsBuff) {
    const g = a.ext.grantsBuff;
    this.addBuff(u, u, { id: g.id, name: g.name || a.name, ext: { endsOnIncap: g.endsOnIncap !== false } }, { duration: g.duration || 'entire encounter' });
    this.ev('buff', `${u.name}: ${g.name || a.name}`, { uid: u.uid });
  }
  if (a._spell && a._spell.level) {
    const k = (u.castLevel || a._spell.level) - a._spell.level;
    const extra = a._spell.upcast && k > 0 ? Array(k).fill(a._spell.upcast).join(' + ') : '';
    const extraT = a._spell.upcastTargets && k > 0 ? { targets: (a.targets || 1) + a._spell.upcastTargets * k } : {};
    a = Object.assign({}, a, { name: `${a.name} (L${u.castLevel || a._spell.level})` }, extraT,
      extra ? (a.type === 'heal' ? { amount: a.amount + ' + ' + extra } : a.type === 'atk' ? { dpr: a.dpr + ' + ' + extra } : {}) : {});
    if (extra && a.type === 'atk' && a.ext && a.ext.wtDpr) a.ext = Object.assign({}, a.ext, { wtDpr: a.ext.wtDpr + ' + ' + extra });
  }
  if (!plan) plan = this.plan(u, a, 0) || { targets: [] };
  const targets = plan.friends && plan.friends.length ? plan.targets.concat(plan.friends.filter(f => !plan.targets.includes(f) && !f.dead)) : plan.targets;
  if (!targets.length && a.target !== 'self') return false;
  if (plan.area && a.ext && a.ext.zone) {
    const cells = new Set(plan.area.cells.map(c => c[0] + c[1] * this.W));
    const old = this.zones.filter(z => z.src === u.uid && z.id === a.id);
    this.zones = this.zones.filter(z => !(z.src === u.uid && z.id === a.id));
    old.forEach(z => this.ev('zoneEnd', `${a.name} moves`, { uid: u.uid, zid: z.zid }));
    const zid = this.zoneSeq = (this.zoneSeq || 0) + 1;
    this.zones.push({ zid, src: u.uid, id: a.id, cells, rough: !!a.ext.zone.difficult, fog: !!a.ext.zone.fog, conc: !!(a._spell && a._spell.conc) });
    this.applyZones();
    this._pendingZone = { zid, cells: [...cells].map(i => [i % this.W, (i / this.W) | 0]), zkind: a.ext.zone.fog ? 'fog' : 'rough', name: a.name, uid: u.uid };
  }
  if (plan.area && this.record) {
    const ar = plan.area;
    const label = { sphere: `${ar.size}-ft-radius burst`, cone: `${ar.size}-ft cone`, line: `${ar.size}-ft line`, cube: `${ar.size}-ft cube` }[ar.shape];
    const ff = plan.friends ? plan.friends.filter(f => targets.includes(f)).length : 0;
    this.ev('aoe', `${u.name} unleashes ${a.name} (${label}), catching ${targets.length}${ff ? ` (${ff} of them on its own side)` : ''}`, { uid: u.uid, target: targets[0] && targets[0].uid, shape: ar.shape, size: ar.size, ox: ar.ox, oy: ar.oy, tx: ar.tx, ty: ar.ty, cells: ar.cells, hits: targets.map(t => t.uid), harm: a.type === 'atk' ? 'dmg' : 'cond' });
  }
  if (this._pendingZone) {
    const z = this._pendingZone; this._pendingZone = null;
    this.ev('zone', z.zkind === 'fog' ? `${z.name} fills the area: nobody sees into or out of it` : `${z.name} turns the ground into difficult terrain`, { uid: z.uid, zid: z.zid, cells: z.cells, zkind: z.zkind });
  }
  if (a.ext && a.ext.zone && a.ext.zone.fog) return true;
  if (a.type === 'atk') {
    if (opt.inside) this.resolveAttackAction(u, a, targets, { inside: true });
    else this.resolveAttackAction(u, a, targets, opt);
    return true;
  }
  if (a.type === 'heal') {
    const hx = a.ext || {};
    for (const t of targets) {
      let amt;
      if (hx.pool) {
        // spend as many dice from the pool as the wound needs, up to the per-use cap
        const avgDie = ((hx.pool.die || 6) + 1) / 2, left = u.uses.get(a.id) || 0;
        const need = t.hp <= 0 ? t.maxHp * 0.5 : t.maxHp - t.hp;
        const n = Math.max(1, Math.min(hx.pool.maxPer || left, left, Math.ceil(need / avgDie)));
        u.uses.set(a.id, left - n);
        amt = rollDice(n + 'd' + (hx.pool.die || 6), this.R, false);
      } else amt = rollDice(a.amount, this.R, false);
      if (hx.aid) {
        // Aid: maximum and current hit points both go up, for the rest of the day
        if (!t.aided) { t.aided = true; t.maxHp += Math.round(amt); }
        this.heal(u, t, amt, false);
        this.ev('heal', `${u.name} → ${t.name}: ${a.name}, max HP +${Math.round(amt)}`, { uid: u.uid, target: t.uid });
        continue;
      }
      this.heal(u, t, amt, a.tempHP);
      if (a.tempHP && (hx.retaliate || hx.tempBuff)) {
        const lvl = (a._spell && u.castLevel) || 1;
        const data = Object.assign({ duration: 'entire encounter' }, hx.tempBuff || {});
        this.addBuff(t, u, a, data, { whileTemp: true, retaliate: hx.retaliate ? hx.retaliate.dmg * (hx.retaliate.perLevel ? lvl : 1) : 0 });
      }
      this.ev('heal', `${u.name} → ${t.name}: ${a.name}, +${Math.round(amt)}${a.tempHP ? ' temp' : ''} HP`, { uid: u.uid, target: t.uid });
    }
    return true;
  }
  const succ = (a.ext && typeof a.ext.successChance === 'number') ? a.ext.successChance : 1;
  if (succ < 1 && this.R() >= succ) { this.ev('fail', `${u.name} tries ${a.name} — fails`, { uid: u.uid }); return true; }
  if (a.type === 'buff') {
    for (const t of targets) this.addBuff(t, u, a, a.buff);
    this.ev('buff', `${u.name}: ${a.name}${targets.length === 1 && targets[0] === u ? '' : ' → ' + targets.map(t => t.name).join(', ')}`, { uid: u.uid, target: targets[0] && targets[0].uid });
    return true;
  }
  if (a.type === 'debuff') {
    for (const t of targets) {
      const dc = Number(avgDice(a.saveDC));
      const sab = a.ext && a.ext.saveAbility;
      this._saveStakes = a.buff && DANGER_CONDS.includes(a.buff.condition) ? 1 : 0;
      const s = this.saveRoll(t, dc, u, sab);
      this._saveStakes = 0;
      if (!s.success) { this.addBuff(t, u, a, a.buff, { dc, saveAbility: sab }); if (a.ext && a.ext.onHit) this.onHitEffects(u, t, a, 0); }
      this.ev('save', `${u.name} → ${t.name}: ${a.name}, DC ${dc >= 99 ? '—' : dc}${sab && sab !== 'strdex' && dc < 99 ? ' ' + sab.toUpperCase() : ''} — ${s.autoFail ? 'auto-fails, ' : ''}${s.success ? 'saved' : 'affected' + (a.buff.condition ? ' (' + a.buff.condition + ')' : '')}`,
        { uid: u.uid, target: t.uid, hit: !s.success, dmg: 0, ranged: this.dist(u, t) > 5 });
    }
    return true;
  }
  return false;
};

/* first usable action of a slot that has a valid plan within `budget` ft of movement */
Sim.prototype.choose = function (u, slot, budget) {
  const list = u.actions.filter(a => a.actionSlot === slot && !(a.ext && a.ext.teleport) && this.usable(u, a) && this.condOk(u, a) && !(slot === 0 && this.holdsResource(u, a)));
  for (let k = 0; k < list.length; k++) {
    const a = list[k];
    const p = this.plan(u, a, budget);
    if (!p) continue;
    if (u.ai === 'tactical' && (a.type === 'atk' || a.type === 'debuff')) {
      const k2 = freqKind(a.freq), limited = k2 !== 'at will' && k2 !== 'recharge';
      const rest = list.slice(k + 1).filter(b => b.type === 'atk' && freqKind(b.freq) === 'at will');
      if (limited && rest.length) {
        const foes = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e));
        // don't burn a spell slot on one foe the at-will attack can finish
        if (foes.length === 1 && foes[0].hp <= Math.max(...rest.map(b => this.expected(u, b, foes[0]))) * 1.5) continue;
        // don't waste an area effect on a single creature
        if (a.useSaves && (a.targets || 1) > 1 && p.targets.length < 2) continue;
      }
    }
    return { a, p };
  }
  return null;
};

/* a line in the log saying why the AI did what it did */
Sim.prototype.intent = function (u, a, p) {
  if (!this.record || !p || !p.why || !p.targets.length) return;
  const t = p.targets[0];
  const key = p.why + ':' + t.uid;
  if (u.lastIntent === key) return;
  u.lastIntent = key;
  const txt = {
    finish: `${u.name} goes after ${t.name}, who looks ready to drop`,
    healer: `${u.name} goes for the healer, ${t.name}`,
    threat: `${u.name} focuses ${t.name}, the biggest threat`,
    focus: `${u.name} piles onto ${t.name} with the others`,
    cluster: `${u.name} lines up ${a.name} to catch ${p.targets.length} of them`,
    revive: `${u.name} rushes to get ${t.name} back up`,
    retaliate: `${u.name} turns on ${t.name}, who hurt it`,
    nearest: `${u.name} lunges at the nearest prey, ${t.name}`,
    execute: `${u.name} decides to finish off ${t.name}, who keeps getting back up`,
    grudge: `${u.name} has had enough of them getting back up, and strikes the fallen ${t.name}`,
    maul: `${u.name} keeps mauling ${t.name}`,
  }[p.why];
  if (txt) this.ev('intent', txt, { uid: u.uid, target: t.uid });
};

/* ----- a creature's turn ----- */
Sim.prototype.turn = function (u) {
  // start of turn
  u.turnNo = (u.turnNo || 0) + 1;
  this.turnSeq = (this.turnSeq || 0) + 1;
  u.tookTurn = true; u.movedThisTurn = false; u._steps = 0;
  // ongoing damage (Tasha's Caustic Brew, burning…) at the start of the creature's turn
  for (const b of u.buffs.slice()) if (b.dot && !u.dead) {
    const src = this.byId[b.src] || u, at = this.mark();
    const d = this.damage(src, u, Math.max(0, Math.floor(rollDice(b.dot, this.R, false))), {});
    this.ev('digest', `${u.name} takes ${d} damage from ${b.name}`, { uid: u.uid, target: u.uid, dmg: d });
    this.hoist(at);
  }
  if (this.incap(u)) this.dropBuffs(u, b => b.endsOnIncap);
  u.mauling = u.ai === 'beast' && this.R() < 0.05;
  for (const x of this.units) this.dropBuffs(x, b => b.src === u.uid && b.expiry === '1 round');
  u.reaction = true; u.legendaryLeft = u.legendaryMax;
  for (const a of u.actions) if (freqKind(a.freq) === 'recharge' && u.recharge.get(a.id) === false) {
    const faces = Math.max(1, Math.round(6 / Math.max(1, a.freq.cooldownRounds || 2)));
    const r = this.R.d(6);
    if (r > 6 - faces) { u.recharge.set(a.id, true); this.ev('recharge', `${u.name}'s ${a.name} recharges (rolled ${r})`, { uid: u.uid }); }
  }
  // digest whoever is inside
  for (const vid of u.inside.slice()) {
    const v = this.byId[vid];
    if (!v || v.dead) continue;
    if (v.swallowInfo && v.swallowInfo.digest) {
      const at = this.mark();
      const d = this.damage(u, v, Math.max(0, Math.floor(rollDice(v.swallowInfo.digest, this.R, false))), {});
      this.ev('digest', `${u.name} digests ${v.name}: ${d} damage`, { uid: u.uid, target: v.uid, dmg: d });
      this.hoist(at);
    }
  }
  if (u.dead) return;
  // death saves
  if (u.isPC && u.hp <= 0) {
    if (u.stable) return;
    const r = this.R.d(20);
    if (r === 20) { this.boardChanged(); u.hp = 1; u.deathS = 0; u.deathF = 0; this.revives[u.team] = (this.revives[u.team] || 0) + 1; this.ev('deathsave', `${u.name} rolls a natural 20 on a death save and gets up!`, { uid: u.uid }); }
    else if (r === 1) u.deathF += 2;
    else if (r >= 10) u.deathS++;
    else u.deathF++;
    if (u.hp <= 0) {
      this.ev('deathsave', `${u.name} death save: ${r} (${u.deathS}✓ ${u.deathF}✗)`, { uid: u.uid });
      if (u.deathF >= 3) this.kill(u, u, 'failed death saves');
      else if (u.deathS >= 3) { u.stable = true; this.ev('deathsave', `${u.name} is stable`, { uid: u.uid }); }
      return;
    }
  }
  // passives (Other 1 / Other 2): self buffs keep themselves up
  for (const a of u.actions) {
    if ((a.actionSlot === 5 || a.actionSlot === 6) && a.type === 'buff' && this.usable(u, a) && this.condOk(u, a)) {
      const already = u.buffs.some(b => b.id === a.id);
      if (!already) { this.spend(u, a); this.doAction(u, a, { targets: this.plan(u, a, 0) ? this.plan(u, a, 0).targets : [u] }); }
    }
  }
  if (this.surpriseRules === '2014' && this.round === 1 && this.surprised[u.team]) { this.ev('skip', `${u.name} is surprised`, { uid: u.uid }); return; }
  if (this.incap(u)) { this.ev('skip', `${u.name} can't act`, { uid: u.uid }); this.endTurn(u); return; }

  if (u.swallowedBy) { this.insideTurn(u); this.endTurn(u); return; }

  this.rankSpells(u);
  let actionUsed = false;
  // grappled: maybe spend the action breaking free
  if (u.grappledBy) {
    const g = this.byId[u.grappledBy];
    const canSwallow = g && g.actions.some(a => a.ext && a.ext.swallow);
    if (this.escapePolicy === 'always' || (this.escapePolicy === 'smart' && canSwallow)) {
      const r = this.R.d(20) + u.escapeBonus;
      actionUsed = true;
      const dc = u.grappleInfo.escapeDC;
      if (r >= dc) { u.grappledBy = null; u.grappleInfo = null; this.ev('escape', `${u.name} breaks free (${r} vs DC ${dc})`, { uid: u.uid }); }
      else this.ev('escape', `${u.name} fails to break free (${r} vs DC ${u.grappleInfo.escapeDC})`, { uid: u.uid });
    }
  }
  // what will the action be?
  let choice = null, moved = false, bonusSpent = false, hideAfter = null;
  // self-buffs that change how the turn goes (Bladesong's speed and AC, Rage…) are invoked before moving
  if (!actionUsed) {
    const pre = this.choose(u, 1, 0);
    if (pre && pre.a.type === 'buff' && pre.a.target === 'self' && !(pre.a._spell && pre.a._spell.level) && !(pre.a.buff && pre.a.buff.condition === 'Invisible')) {
      this.spend(u, pre.a); this.doAction(u, pre.a, pre.p); bonusSpent = true;
    }
  }
  const speed = (this.has(u, ['Restrained']) || u.grappledBy) ? 0 : this.speedOf(u);
  // non-tactical creatures teleport away when cornered and hurt
  if (!actionUsed && !bonusSpent && u.ai !== 'tactical' && u.ai !== 'beast' && u.hp < u.maxHp * 0.4 && this.adjacentEnemies(u, u.x, u.y).length) {
    const j = u.actions.find(a => a.ext && a.ext.teleport && a.actionSlot === 1 && this.usable(u, a));
    if (j) {
      const R = Math.round(j.ext.teleport / 5), foesUp = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e));
      let bx = null, bd = -1;
      for (let y = Math.max(0, u.y - R); y <= Math.min(this.H - 1, u.y + R); y++) for (let x = Math.max(0, u.x - R); x <= Math.min(this.W - 1, u.x + R); x++) {
        if (this.occupant(x, y) || this.isWall(x, y) || !this.los(u.x, u.y, x, y)) continue;
        const d = Math.min(...foesUp.map(e => this.distXY(x, y, e)));
        if (d > bd) { bd = d; bx = { x, y }; }
      }
      if (bx) {
        this.spend(u, j); bonusSpent = true;
        const from = { x: u.x, y: u.y };
        u.x = bx.x; u.y = bx.y; this.boardChanged();
        this.ev('move', `${u.name} teleports away (${j.name})`, { uid: u.uid, path: [{ x: bx.x, y: bx.y }], from });
        if (u.grappledBy) { u.grappledBy = null; u.grappleInfo = null; }
      }
    }
  }
  if (!actionUsed && u.ai === 'tactical') {
    let tp = this.tacticalTurn(u, speed);
    // if saving resources leaves nothing better than dashing or dodging, spend one instead of wasting the turn
    if (tp && (tp.mode === 'dash' || tp.mode === 'dodge' || tp.mode === 'actionDis') && u.actions.some(a => a.actionSlot === 0 && this.usable(u, a) && this.holdsResource(u, a))) {
      u._noHold = true;
      const tp2 = this.tacticalTurn(u, speed);
      u._noHold = false;
      if (tp2 && (tp2.mode === 'act' || tp2.mode === 'bonusDis') && tp2.off.val > 0) tp = tp2;
      else this.notePacing(u);
    } else this.notePacing(u);
    if (tp) {
      if (tp.mode === 'act' || tp.mode === 'bonusDis' || (tp.mode === 'jump' && tp.off)) {
        choice = { a: tp.off.pl.a, p: { targets: [tp.off.t], path: tp.path, why: tp.off.why } };
        this.intent(u, choice.a, choice.p);
      }
      if (tp.mode === 'jump') {
        this.spend(u, tp.jumpA); bonusSpent = true;
        if (tp.note && this.record) this.ev('intent', tp.note, { uid: u.uid });
        tp.note = '';
        const from = { x: u.x, y: u.y };
        u.x = tp.x; u.y = tp.y; this.boardChanged();
        this.ev('move', `${u.name} teleports ${Math.max(Math.abs(tp.x - from.x), Math.abs(tp.y - from.y)) * 5} ft (${tp.jumpA.name})`, { uid: u.uid, path: [{ x: tp.x, y: tp.y }], from });
        for (const t of this.units) if (t.grappledBy === u.uid) { t.grappledBy = null; t.grappleInfo = null; }
        if (u.grappledBy) { u.grappledBy = null; u.grappleInfo = null; }
      }
      if (tp.note && this.record) this.ev('intent', tp.note, { uid: u.uid });
      if (tp.mode === 'bonusDis' || tp.mode === 'actionDis') {
        u.disengaged = true;
        if (tp.mode === 'bonusDis') bonusSpent = true; else actionUsed = true;
        this.ev('disengage', `${u.name} takes the Disengage action${tp.mode === 'bonusDis' ? ' (bonus action)' : ''}`, { uid: u.uid });
      }
      if (tp.mode === 'dash') { actionUsed = true; this.ev('dash', `${u.name} dashes`, { uid: u.uid }); }
      this.moveAlong(u, tp.path); moved = true;
      if (tp.mode === 'dodge' || tp.mode === 'hide') {
        actionUsed = true;
        this.addBuff(u, u, { id: 'dodge', name: 'Dodge' }, { duration: '1 round', condition: 'Is attacked with Disadvantage' });
        this.ev('buff', `${u.name} takes the Dodge action`, { uid: u.uid });
      }
      if (tp.mode === 'hide' && !bonusSpent && this.slipAndHide(u, 0)) bonusSpent = true;
      if (tp.mode === 'act' && tp.hideAfter !== undefined) hideAfter = tp.hideAfter;
    }
  }
  if (!actionUsed && !choice && !moved) choice = this.choose(u, 0, speed);
  if (!actionUsed && !choice && !moved && u.actions.some(a => a.actionSlot === 0 && this.usable(u, a) && this.holdsResource(u, a))) {
    u._noHold = true; choice = this.choose(u, 0, speed); u._noHold = false;     // better a saved spell than a wasted turn
  }
  if (!actionUsed && !choice && !moved && speed > 0) {
    // nothing in reach: dash toward the first thing it would like to do, but only if that gets it there a turn sooner;
    // otherwise walk up and Dodge on the way in
    const dashing = this.choose(u, 0, speed * 2);
    const foesUp = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e));
    const need = dashing ? Math.max(0, this.reachMap(u, speed * 2).dist[dashing.p.dest.y * this.W + dashing.p.dest.x] * 5)
                         : Math.max(0, Math.min(...foesUp.map(e => this.dist(u, e))) - 5);
    if (this.dashWorthIt(u, need, speed) || (!dashing && foesUp.length && need > speed * 2)) {
      if (dashing) this.moveAlong(u, this.pathTo(this.reachMap(u, speed * 2), dashing.p.dest.x, dashing.p.dest.y));
      else this.approach(u, speed * 2);
      this.ev('dash', `${u.name} dashes`, { uid: u.uid });
    } else {
      if (dashing) {
        const full = this.pathTo(this.reachMap(u, speed * 2), dashing.p.dest.x, dashing.p.dest.y);
        const rm2 = this.reachMap(u, speed * 2);
        let k = 0;
        while (k < full.length && rm2.dist[full[k].x + full[k].y * this.W] <= Math.floor(speed / 5)) k++;
        while (k > 0) { const o = this.occupant(full[k - 1].x, full[k - 1].y); if (!o || o === u) break; k--; }
        this.moveAlong(u, full.slice(0, k));
      } else this.approach(u, speed);
      if (foesUp.length) {
        this.addBuff(u, u, { id: 'dodge', name: 'Dodge' }, { duration: '1 round', condition: 'Is attacked with Disadvantage' });
        this.ev('buff', `${u.name} closes in carefully, taking the Dodge action`, { uid: u.uid });
      }
    }
    moved = true; actionUsed = true;
  }
  if (u.steadyAim && hideAfter === null && !bonusSpent && !actionUsed && choice && choice.a.type === 'atk' && !choice.a.useSaves && !u.movedThisTurn &&
      !(choice.p.path && choice.p.path.length) && choice.p.targets && choice.p.targets[0]) {
    const t = choice.p.targets[0];
    const tc = this.conds(t), atc = this.conds(u);
    const already = ADV_TARGET.some(x => tc.has(x)) || ADV_SELF.some(x => atc.has(x)) || !!this.featureAdv(u, t);
    // a hurt rogue next to enemies would rather Hide or slip away with its bonus action
    const wantsOut = u.hp < u.maxHp * 0.5 && this.adjacentEnemies(u, u.x, u.y).length > 0;
    if (!already && !wantsOut) {
      bonusSpent = true;
      this.addBuff(u, u, { id: 'steady-aim', name: 'Steady Aim' }, { duration: 'until next attack made', condition: 'Attacks with Advantage' });
      this.ev('buff', `${u.name} uses Steady Aim (advantage, can't move this turn)`, { uid: u.uid });
    }
  }
  if (choice && !moved) { this.intent(u, choice.a, choice.p); this.moveAlong(u, choice.p.path); moved = true; }
  u.disengaged = false;
  if (u.dead || u.hp <= 0) return;

  // bonus action: first usable one, before or after the action depending on what it is
  u.reserveSlot = !!(choice && !actionUsed && choice.a._spell && choice.a._spell.level);
  const bonus = bonusSpent ? null : this.choose(u, 1, 0);
  u.reserveSlot = false;
  const after = bonus && (bonus.a.type === 'atk' || (bonus.a.buff && bonus.a.buff.condition === 'Invisible'));
  if (bonus && !after) { this.spend(u, bonus.a); this.doAction(u, bonus.a, bonus.p); }
  if (choice && !actionUsed) {
    // re-plan from where it ended up: it may have been stopped, or the target may have dropped
    let a = choice.a, p = this.usable(u, a) && this.condOk(u, a) ? this.plan(u, a, 0) : null;
    if (!p) { const c2 = this.choose(u, 0, 0); if (c2) { a = c2.a; p = c2.p; } }
    if (p && p.targets.length) {
      this.spend(u, a); this.doAction(u, a, p, { finishDowned: !!(p.targets[0] && p.targets[0].hp <= 0) });
      if ((a.type === 'atk' || a.type === 'debuff') && p.targets[0] && p.targets[0] !== u) u.focus = p.targets[0].uid;
    }
  }
  if ((hideAfter !== null || u.ai === 'regular') && !bonusSpent && !(bonus && !after) && !u.dead && u.hp > 0) {
    const left = Math.floor(speed / 5) - (u._steps || 0);
    if (this.slipAndHide(u, hideAfter !== null ? Math.min(hideAfter, left) : left)) bonusSpent = true;
  }
  if (bonus && after && !bonusSpent && !u.dead && u.hp > 0) {
    const p = this.plan(u, bonus.a, 0);
    if (p) { this.spend(u, bonus.a); this.doAction(u, bonus.a, p); }
  }
  this.endTurn(u);
};
Sim.prototype.approach = function (u, budget) {
  const foes = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e));
  if (!foes.length) return;
  const rm = this.reachMap(u, budget);
  let best = null, bs = Infinity;
  for (let i = 0; i < rm.dist.length; i++) {
    if (rm.dist[i] < 0) continue;
    const x = i % this.W, y = (i / this.W) | 0;
    const occ = this.occupant(x, y); if (occ && occ !== u) continue;
    const d = Math.min(...foes.map(f => this.distXY(x, y, f)));
    if (d < bs) { bs = d; best = { x, y }; }
  }
  if (best) this.moveAlong(u, this.pathTo(rm, best.x, best.y));
};
Sim.prototype.insideTurn = function (u) {
  const w = this.byId[u.swallowedBy];
  if (!w) return;
  u.insideDamage = new Map();
  w.insideDamage = new Map();
  const a = u.actions.find(x => x.actionSlot === 0 && x.type === 'atk' && this.usable(u, x));
  if (a) { this.spend(u, a); this.resolveAttackAction(u, a, [w], { inside: true }); }
  const b = u.actions.find(x => x.actionSlot === 1 && x.type === 'atk' && this.usable(u, x));
  if (b && !w.dead) { this.spend(u, b); this.resolveAttackAction(u, b, [w], { inside: true }); }
  if (w.dead || !u.swallowInfo) return;
  const rg = u.swallowInfo.regurgitate;
  const took = w.insideDamage.get(u.uid) || 0;
  if (rg && typeof rg.threshold === 'number' && took >= rg.threshold) {
    const bonus = (rg.saveBonus !== undefined && rg.saveBonus !== '') ? Number(rg.saveBonus) : this.saveBonusFor(w, 'con');
    const r = this.R.d(20) + bonus;
    if (r < (rg.dc || 10)) this.expel(w, u, 'regurgitated');
    else this.ev('save', `${w.name} keeps ${u.name} down (Con ${r} vs DC ${rg.dc})`, { uid: w.uid });
  }
};
Sim.prototype.endTurn = function (u) {
  if (u.vex && (u.turnNo || 0) > u.vex.turn) u.vex = null;
  // "repeat the save each round" effects on this creature
  for (const b of u.buffs.slice()) {
    if (b.expiry === 'repeat the save each round' && typeof b.dc === 'number' && b.dc < 99) {
      const s = this.saveRoll(u, b.dc, null, b.saveAbility);
      if (s.success) { u.buffs = u.buffs.filter(x => x !== b); this.ev('save', `${u.name} shakes off ${b.name}`, { uid: u.uid }); }
    }
  }
  this.dropBuffs(u, b => b.expiry === 'hide' && (u.turnNo || 0) > b.madeOnTurn);
  // passive auras (Other 1 / Other 2 attacks and debuffs) hit enemies around it
  for (const a of u.actions) {
    if ((a.actionSlot !== 5 && a.actionSlot !== 6) || a.type === 'buff' || a.type === 'heal' || !this.usable(u, a) || !this.condOk(u, a)) continue;
    if (u.dead || u.hp <= 0 || u.swallowedBy) break;
    const r = Math.max(5, a._range || 10);
    const victims = this.orderBySelector(this.enemiesOf(u).filter(e => e.onBoard && this.alive(e) && this.dist(u, e) <= r && this.los(u.x, u.y, e.x, e.y)), a.target).slice(0, a.useSaves || a.type === 'debuff' ? (a.targets || 1) : 1);
    if (!victims.length) continue;
    this.spend(u, a);
    if (this.record) {
      const n = r / 5, cells = [];
      for (let y = u.y - n; y <= u.y + n; y++) for (let x = u.x - n; x <= u.x + n; x++) if (x >= 0 && y >= 0 && x < this.W && y < this.H) cells.push([x, y]);
      this.ev('aoe', `${u.name}'s ${a.name} lashes out (${r}-ft aura)`, { uid: u.uid, shape: 'aura', size: r, ox: u.x, oy: u.y, cells, hits: victims.map(t => t.uid), harm: a.type === 'atk' ? 'dmg' : 'cond' });
    }
    if (a.type === 'atk') this.resolveAttackAction(u, a, victims, { aura: true });
    else this.doAction(u, a, { targets: victims });
  }
};

/* ----- legendary & lair ----- */
Sim.prototype.legendary = function (after) {
  for (const u of this.units) {
    if (u === after || u.team === after.team || !this.alive(u) || !u.onBoard || u.legendaryLeft <= 0 || this.incap(u)) continue;
    // actions that cost more than the uses left are hidden for this pick
    const hidden = u.actions.filter(a => a.actionSlot === 2 && ((a.ext && a.ext.legendaryCost) || 1) > u.legendaryLeft);
    hidden.forEach(a => { a.actionSlot = -99; });
    const c = this.choose(u, 2, 0);
    hidden.forEach(a => { a.actionSlot = 2; });
    if (!c) continue;
    u.legendaryLeft -= (c.a.ext && c.a.ext.legendaryCost) || 1;
    this.spend(u, c.a);
    this.ev('legendary', `${u.name} uses a legendary action: ${c.a.name}`, { uid: u.uid });
    this.doAction(u, c.a, c.p);
    if (this.over()) return;
  }
};
Sim.prototype.lair = function () {
  for (const u of this.units) {
    if (!this.alive(u) || !u.onBoard) continue;
    const c = this.choose(u, 3, 0);
    if (!c) continue;
    this.spend(u, c.a);
    this.ev('lair', `Lair action (${u.name}): ${c.a.name}`, { uid: u.uid });
    this.doAction(u, c.a, c.p);
  }
};

Sim.prototype.partyStanding = function () { return this.units.some(u => u.team === 'party' && this.alive(u)); };
Sim.prototype.foesStanding = function () { return this.units.some(u => u.team === 'foes' && this.alive(u)); };
Sim.prototype.over = function () { return !this.partyStanding() || !this.foesStanding(); };

Sim.prototype.runEncounter = function (party, foes, enc, layout) {
  this.units = party.concat(foes);
  this.byId = {}; this.units.forEach(u => this.byId[u.uid] = u);
  this._last = {};
  this.surprised = { party: !!enc.playersSurprised, foes: !!enc.monstersSurprised };
  this.revives = { party: 0, foes: 0 };
  this.round = 0;
  this.setTerrain(layout && layout.terrain);
  this.zones = [];
  this.place(party, foes, layout);
  this.boardChanged();
  // initiative (2024: surprised creatures roll with disadvantage)
  for (const u of this.units) {
    const sur = this.surprised[u.team] && this.surpriseRules === '2024';
    u.init = this.d20(u.initAdv, sur, false) + u.initBonus + this.R() * 0.01;
  }
  this.order = this.units.slice().sort((a, b) => b.init - a.init);
  this.ev('start', 'Initiative: ' + this.order.map(u => `${u.name} ${Math.floor(u.init)}`).join(', '), { order: this.order.map(u => u.uid) });
  this.round = 1;
  if (this.morningNotes && this.morningNotes.length) { this.morningNotes.forEach(n => this.ev('heal', n.text, { uid: n.uid })); this.morningNotes = null; }
  for (const u of this.order) if (this.alive(u)) this.trigger(u, -3, null);
  while (this.round <= this.maxRounds && !this.over()) {
    this.ev('round', `Round ${this.round}`, {});
    this.lair();
    for (const u of this.order) {
      if (this.over()) break;
      if (u.dead) continue;
      if (u.team === 'foes' && !u.onBoard) continue;
      this.ev('turn', `${u.name}'s turn`, { uid: u.uid });
      this.current = u; this.turn(u); this.current = null;
      if (this.over()) break;
      this.legendary(u);
    }
    this.round++;
  }
  const won = !this.foesStanding() && this.partyStanding();
  if (this.tpkKills && !this.partyStanding() && this.foesStanding()) for (const u of this.units) if (u.team === 'party' && !u.dead) this.kill(u, null, 'the whole party is down');
  this.ev('end', won ? 'The party wins' : this.partyStanding() ? 'The fight drags on — stopped' : 'The party falls', { won });
  return { won, rounds: Math.min(this.round - 1, this.maxRounds) };
};

Sim.prototype.place = function (party, foes, layout) {
  const W = this.W, H = this.H;
  const pos = (layout && layout.positions) || {};
  const gap = Math.max(1, Math.round(((layout && layout.gapFt) || 30) / 5));
  const taken = new Set();
  const put = (u, x, y) => { u.x = x; u.y = y; taken.add(x + ',' + y); };
  const free = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !taken.has(x + ',' + y) && !this.isWall(x, y);
  const nearestFree = (x, y) => {
    for (let r = 0; r < Math.max(W, H); r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (free(x + dx, y + dy)) return [x + dx, y + dy];
    }
    return [x, y];
  };
  const formation = (list, frontX, dir) => {
    const rows = Math.min(list.length, Math.max(3, Math.ceil(list.length / 2)));
    list.forEach((u, i) => {
      if (pos[u.key]) { const [x, y] = nearestFree(pos[u.key].x, pos[u.key].y); put(u, x, y); return; }
      const col = Math.floor(i / rows), row = i % rows;
      const y = Math.round(H / 2 - rows + row * 2 + (col % 2));
      const [x, yy] = nearestFree(frontX - dir * col * 2, Math.max(0, Math.min(H - 1, y)));
      put(u, x, yy);
    });
  };
  const partyFront = Math.max(2, Math.floor((W - gap) / 2) - 1);
  formation(party.filter(u => u.onBoard && !u.dead), partyFront, 1);
  formation(foes, Math.min(W - 3, partyFront + gap), -1);
  party.filter(u => u.dead).forEach(u => { u.onBoard = false; });
};

/* ---------------- a whole adventuring day ---------------- */
function expandTeam(list, team, isPC) {
  const out = [];
  (list || []).forEach(t => { const n = Math.max(1, t.count || 1); for (let i = 0; i < n; i++) out.push(makeUnit(t, team, i, n, isPC)); });
  return out;
}

/* hours-long buffs (Aid) are cast in the morning, before the first fight. A caster whose slots come
   back on a short rest is assumed to rest after casting, so the slot isn't missing in the first fight. */
function morningCasts(party) {
  const notes = [];
  for (const u of party) {
    for (const a of u.actions) {
      if (!(a.ext && a.ext.aid) || u.dead) continue;
      if (a._spell && a._spell.level && !(u.slots && u.slots.some((n, i) => n > 0 && i + 1 >= a._spell.level))) continue;
      const L = a._spell && a._spell.level ? (() => { for (let l = a._spell.level; l <= 9; l++) if (u.slots[l - 1] > 0) return l; return a._spell.level; })() : 0;
      const k = L && a._spell.upcast ? L - a._spell.level : 0;
      const amt = Math.round(avgDice(a.amount) + (k > 0 ? k * avgDice(a._spell.upcast) : 0));
      const ts = party.filter(o => !o.dead && !o.aided).sort((x, y) => x.maxHp - y.maxHp).slice(0, (a.targets || 1) + (a._spell && a._spell.upcastTargets ? a._spell.upcastTargets * k : 0));
      if (!ts.length) continue;
      ts.forEach(t => { t.aided = true; t.maxHp += amt; t.hp += amt; });
      if (L && u.slotReset !== 'sr') u.slots[L - 1]--;
      notes.push({ uid: u.uid, text: `${u.name} cast ${a.name} this morning: ${ts.map(t => t.name).join(', ')} +${amt} max HP` });
    }
  }
  return notes;
}
function runDay(day, opts) {
  opts = opts || {};
  const sim = new Sim(opts);
  const party = expandTeam(day.players, 'party', true);
  const encs = (opts.only !== undefined) ? [day.encounters[opts.only]] : day.encounters;
  const results = [];
  encs.forEach((enc, ei) => {
    const realIdx = opts.only !== undefined ? opts.only : ei;
    if (!enc || !enc.monsters || !enc.monsters.length) return;
    if (!party.some(u => !u.dead)) return;
    if (enc.shortRest && results.length) {
      party.forEach(u => { if (!u.dead) { u.hp = u.maxHp; u.temp = 0; u.actions.forEach(a => { if (freqKind(a.freq) === 'sr') u.uses.set(a.id, a.freq.uses || 1); }); if (u.slots && u.slotReset === 'sr') u.slots = u.slotsMax.slice(); else if (u.slots && u.recovery && !u.recovery.anyBreak && !u.recoveryUsed) recoverSlots(u); } });
    }
    party.forEach(u => { if (!u.dead && u.hp <= 0) u.hp = 1; resetFightState(u); });
    const foes = expandTeam(enc.monsters, 'foes', false);
    party.forEach(u => { if (!u.aiSet) u.ai = AI_TYPES.includes(opts.partyAI) ? opts.partyAI : 'tactical'; });
    sim.events = [];
    const layout = (opts.layouts && opts.layouts[realIdx]) || opts.layout || {};
    const later = encs.slice(ei + 1).filter(e => e && e.monsters && e.monsters.length);
    sim.encountersLeft = later.length;
    if (results.length) party.forEach(u => { if (!u.dead && u.slots && u.recovery && u.recovery.anyBreak && !u.recoveryUsed && u.slots.some((n, i) => n < u.slotsMax[i])) recoverSlots(u); });
    sim.restBeforeNext = !!(later[0] && later[0].shortRest);
    const r = sim.runEncounter(party, foes, enc, layout);
    results.push({
      index: realIdx, won: r.won, rounds: r.rounds,
      events: sim.record ? sim.events : null,
      start: sim.record ? sim.events.length && null : null,
      party: party.map(u => ({ uid: u.uid, name: u.name, hp: u.hp, maxHp: u.maxHp, dead: !!u.dead, down: !u.dead && u.hp <= 0, everDowned: u.everDowned, downs: u.downs, dealt: u.dmgDealt, taken: u.dmgTaken, healed: u.healed })),
      foes: foes.map(u => ({ uid: u.uid, name: u.name, hp: u.hp, maxHp: u.maxHp, dead: !!u.dead, dealt: u.dmgDealt, taken: u.dmgTaken })),
      units: sim.record ? sim.units.map(u => ({ uid: u.uid, key: u.key, name: u.name, team: u.team, isPC: u.isPC, maxHp: u.maxHp, size: u.size, init: u.init, auras: aurasOf(u), areas: areasOf(u) })) : null,
    });
    if (!r.won) return;
  });
  return results;
}

/* Run many days, collect odds. Returns summary + seeds so any run can be replayed. */
function monteCarlo(day, opts, n, baseSeed) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    const seed = (baseSeed + i * 7919) >>> 0;
    const res = runDay(day, Object.assign({}, opts, { seed, record: false }));
    runs.push({ seed, res });
  }
  return summarize(day, runs, opts);
}
function summarize(day, runs, opts) {
  const encs = [];
  const pcNames = (day.players || []).flatMap(t => Array.from({ length: Math.max(1, t.count || 1) }, (_, i) => ({ uid: 'party:' + t.id + ':' + i, name: (t.count || 1) > 1 ? t.name + ' ' + (i + 1) : t.name })));
  const pcStats = {};
  pcNames.forEach(p => pcStats[p.uid] = { name: p.name, deaths: 0, downed: 0, dealt: 0, taken: 0 });
  let tpk = 0, anyDeath = 0, cleared = 0;
  const realEncs = (day.encounters || []).map((e, i) => ({ e, i })).filter(x => x.e.monsters && x.e.monsters.length);
  realEncs.forEach(() => encs.push({ fought: 0, won: 0, rounds: [], hpPct: [], deaths: 0, downs: 0, anyDeath: 0, anyDown: 0, pcs: {} }));
  const maxHp = pcNames.length ? (day.players || []).reduce((t, p) => t + p.hp * Math.max(1, p.count || 1), 0) : 1;
  const runSummaries = runs.map(({ seed, res }) => {
    let died = false;
    const encHp = {};
    res.forEach((r, k) => {
      const E = encs[realEncs.findIndex(x => x.i === r.index)];
      if (!E) return;
      E.fought++; if (r.won) E.won++;
      E.rounds.push(r.rounds);
      const hp = r.party.reduce((t, p) => t + Math.max(0, p.hp), 0);
      E.hpPct.push(Math.min(1, hp / Math.max(maxHp, r.party.reduce((t, p) => t + p.maxHp, 0))));
      E.deaths += r.party.filter(p => p.dead).length;
      E.downs += r.party.reduce((t, p) => t + p.downs, 0);
      const wasAlive = k === 0 ? null : new Set(res[k - 1].party.filter(p => !p.dead).map(p => p.uid));
      if (r.party.some(p => p.dead && (!wasAlive || wasAlive.has(p.uid)))) E.anyDeath++;
      if (r.party.some(p => p.everDowned)) E.anyDown++;
      r.party.forEach(p => {
        const s = E.pcs[p.uid] || (E.pcs[p.uid] = { name: p.name, died: 0, downed: 0, dealt: 0, taken: 0 });
        if (p.dead && (!wasAlive || wasAlive.has(p.uid))) s.died++;
        if (p.everDowned) s.downed++;
        s.dealt += p.dealt; s.taken += p.taken;
      });
      encHp[r.index] = hp / maxHp;
    });
    const last = res[res.length - 1];
    const finalParty = last ? last.party : [];
    finalParty.forEach(p => { const s = pcStats[p.uid]; if (!s) return; if (p.dead) { s.deaths++; died = true; } });
    res.forEach(r => r.party.forEach(p => { const s = pcStats[p.uid]; if (!s) return; s.dealt += p.dealt; s.taken += p.taken; }));
    // ever downed across the day
    const downedSet = new Set(); res.forEach(r => r.party.forEach(p => { if (p.everDowned) downedSet.add(p.uid); }));
    downedSet.forEach(uid => pcStats[uid] && pcStats[uid].downed++);
    const lost = res.some(r => !r.won);
    if (lost) tpk++;
    if (died) anyDeath++;
    if (!lost && res.length === realEncs.length) cleared++;
    const hpEnd = finalParty.reduce((t, p) => t + Math.max(0, p.hp), 0) / maxHp;
    return { seed, encHp, encWon: Object.fromEntries(res.map(r => [r.index, r.won])), lost, died, hpEnd, rounds: res.reduce((t, r) => t + r.rounds, 0), deaths: finalParty.filter(p => p.dead).length };
  });
  const N = runs.length;
  const pct = (arr, q) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };
  return {
    n: N, cleared: cleared / N, partyLost: tpk / N, anyDeath: anyDeath / N,
    encounters: encs.map((E, k) => ({
      index: realEncs[k].i, fought: E.fought, winRate: E.fought ? E.won / E.fought : 0,
      roundsMedian: pct(E.rounds, 0.5), hpMedian: pct(E.hpPct, 0.5), hpP10: pct(E.hpPct, 0.1), hpP90: pct(E.hpPct, 0.9),
      deathsPerFight: E.fought ? E.deaths / E.fought : 0, downsPerFight: E.fought ? E.downs / E.fought : 0,
      anyDeath: E.fought ? E.anyDeath / E.fought : 0, anyDown: E.fought ? E.anyDown / E.fought : 0,
      pcs: Object.values(E.pcs).map(s => ({ name: s.name, died: s.died / E.fought, downed: s.downed / E.fought, dealt: s.dealt / E.fought, taken: s.taken / E.fought })),
      hpHist: hist(E.hpPct),
    })),
    pcs: Object.values(pcStats).map(s => ({ name: s.name, death: s.deaths / N, downed: s.downed / N, dealt: s.dealt / N, taken: s.taken / N })),
    runs: runSummaries,
  };
}
function hist(vals) {
  const b = new Array(10).fill(0);
  vals.forEach(v => b[Math.min(9, Math.max(0, Math.floor(v * 10 - 1e-9)))]++);
  if (vals.length) b[0] += 0;
  return b;
}

/* Describe how each action's range was decided (for the setup panel) */
function describeRanges(day) {
  const out = [];
  const add = (c, team) => (c.actions || []).map(finalizeAction).filter(Boolean).forEach(a => {
    const r = inferRange(a);
    out.push({ creature: c.name, team, action: a.name, slot: a.actionSlot, range: r.range, inferred: r.inferred, id: a.id, creatureId: c.id });
  });
  (day.players || []).forEach(p => add(p, 'party'));
  (day.encounters || []).forEach(e => (e.monsters || []).forEach(m => add(m, 'foes')));
  return out;
}

function aurasOf(u) {
  return u.actions.filter(a => (a.actionSlot === 5 || a.actionSlot === 6) && (a.type === 'atk' || a.type === 'debuff'))
    .map(a => ({ name: a.name, r: Math.max(5, a._range || 10) }));
}
function areasOf(u) {
  return u.actions.map(a => { const s = areaSpec(a); return s ? { name: a.name, shape: s.shape, size: s.size, range: Math.max(5, a._range || 5) } : null; }).filter(Boolean);
}
function previewPlacement(day, encIndex, layout, opts) {
  const sim = new Sim(Object.assign({ seed: 1 }, opts || {}));
  const party = expandTeam(day.players, 'party', true);
  const enc = (day.encounters || [])[encIndex] || { monsters: [] };
  const foes = expandTeam(enc.monsters, 'foes', false);
  sim.units = party.concat(foes);
  sim.setTerrain(layout && layout.terrain);
  sim.place(party, foes, layout || {});
  return sim.units.map(u => ({ uid: u.uid, key: u.key, name: u.name, team: u.team, x: u.x, y: u.y, maxHp: u.maxHp, size: u.size, auras: aurasOf(u), areas: areasOf(u) }));
}

root.TacEngine = { areaSpec, areaCells, inArea, AI_TYPES, autoAI, previewPlacement, runDay, monteCarlo, summarize, describeRanges, makeRng, rollDice, avgDice, parseDice, inferRange, expandTeam };
})(typeof window !== 'undefined' ? window : globalThis);
