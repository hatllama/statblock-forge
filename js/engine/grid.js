/* TACTICAL ENGINE, part 2: the grid (file list and how the parts share names: js/engine/base.js).
   Areas of effect (areaSpec, areaCells, inArea), terrain, line of sight and cover, hiding, who is where,
   area aiming (areaAt, aimStraight, areaCatch), distances between bodies, occupancy and the movement maps. */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { rollDice, sizeIdx, Sim } = ENG;

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
    return { shape: ar.shape, size, explicit: true, placed, width: Number(ar.width) || 5, square: !!ar.square };
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
  if (spec.shape === 'emanation' && (spec.bn || 1) > 1) {
    // from a big creature: measured from the edge of its body (spec.bn squares across, top-left on ox,oy), which it doesn't catch
    const x1 = ox + spec.bn - 1, y1 = oy + spec.bn - 1;
    for (let y = oy - n; y <= y1 + n; y++) for (let x = ox - n; x <= x1 + n; x++) {
      const dx = x < ox ? ox - x : x > x1 ? x - x1 : 0, dy = y < oy ? oy - y : y > y1 ? y - y1 : 0;
      if (!dx && !dy) continue;
      if (spec.square || dx * dx + dy * dy <= R2) add(x, y);
    }
    return out;
  }
  if (spec.shape === 'emanation' || spec.shape === 'sphere') {
    const cx = spec.shape === 'emanation' ? ox : tx, cy = spec.shape === 'emanation' ? oy : ty;
    for (let y = cy - n; y <= cy + n; y++) for (let x = cx - n; x <= cx + n; x++) {
      if (spec.shape === 'emanation' && x === ox && y === oy) continue;
      const dx = x - cx, dy = y - cy;
      if (spec.square || dx * dx + dy * dy <= R2) add(x, y);
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
  // cones and lines: one of the 8 grid directions (the same squares inArea accepts, walked out directly)
  const sd = dir8(tx - ox, ty - oy), sx = sd[0], sy = sd[1];
  const w = Math.max(1, Math.round((spec.width || 5) / 5));
  if (!sx || !sy) {
    for (let along = 1; along <= n; along++) {
      const lo = spec.shape === 'cone' ? -Math.floor(along / 2) : -Math.floor((w - 1) / 2), hi = spec.shape === 'cone' ? Math.floor(along / 2) : Math.ceil((w - 1) / 2);
      for (let side = lo; side <= hi; side++) add(sx ? ox + along * sx : ox + side, sx ? oy + side : oy + along * sy);
    }
    return out;
  }
  const lim = Math.round(1.75 * n), band = Math.floor(w * 0.7072 + 0.01);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const d = Math.max(i, j);
    if (d < 1) continue;
    const ok = spec.shape === 'cone' ? Math.min(i, j) >= Math.ceil(d / 2) && i + j <= lim : Math.abs(i - j) <= band && (w > 1 || Math.min(i, j) >= 1);
    if (ok) add(ox + i * sx, oy + j * sy);
  }
  return out;
}
/* the grid direction (8 ways) nearest to the aim, as a step [sx, sy] */
const TAN225 = Math.SQRT2 - 1;          // tan 22.5°: the edge between a straight and a diagonal direction
function dir8(vx, vy) {
  if (!vx && !vy) return [1, 0];
  const ax = Math.abs(vx), ay = Math.abs(vy);
  if (ay <= ax * TAN225) return [Math.sign(vx), 0];
  if (ax <= ay * TAN225) return [0, Math.sign(vy)];
  return [Math.sign(vx), Math.sign(vy)];
}

/* whether square (x,y) is inside the area — the same templates as areaCells, for one square */
function inArea(spec, ox, oy, tx, ty, x, y, sd0) {
  const n = Math.round(spec.size / 5);
  if (spec.shape === 'emanation' && (spec.bn || 1) > 1) {
    const x1 = ox + spec.bn - 1, y1 = oy + spec.bn - 1;
    const dx = x < ox ? ox - x : x > x1 ? x - x1 : 0, dy = y < oy ? oy - y : y > y1 ? y - y1 : 0;
    if (!dx && !dy) return false;
    if (spec.square) return dx <= n && dy <= n;
    return dx * dx + dy * dy <= (n + 0.45) * (n + 0.45);
  }
  if (spec.shape === 'emanation' || spec.shape === 'sphere') {
    if (spec.shape === 'emanation' && x === ox && y === oy) return false;
    const cx = spec.shape === 'emanation' ? ox : tx, cy = spec.shape === 'emanation' ? oy : ty;
    const dx = x - cx, dy = y - cy;
    if (spec.square) return Math.abs(dx) <= n && Math.abs(dy) <= n;
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
  const sd = sd0 || dir8(tx - ox, ty - oy), sx = sd[0], sy = sd[1], wx = x - ox, wy = y - oy;
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

/* ---------------- terrain ----------------
   layout.terrain = { cells: { "x,y": { t?: 'wall' | 'difficult' | 'cover', h?: levels } } }
     wall      — can't be entered, blocks line of sight and areas
     difficult — costs double movement
     cover     — low wall / rubble: difficult to cross, and half cover (+2 AC) against ranged attacks across it
     h         — height in 5-ft steps. Climbing costs an extra 5 ft per step up, distance counts height
                 (5-ft reach can't hit someone 10 ft above), and higher ground blocks sight past its edge. */
Sim.prototype.setTerrain = function (t) {
  const W = this.W, H = this.H, N = W * H;
  const T = { wall: new Uint8Array(N), rough: new Uint8Array(N), cover: new Uint8Array(N), h: new Int8Array(N), any: false, anyH: false, losC: new Map(), solC: new Map(), covC: new Map(), fog: null };
  const cells = (t && t.cells) || {};
  for (const k in cells) {
    const [x, y] = k.split(',').map(Number);
    if (!(x >= 0 && y >= 0 && x < W && y < H)) continue;
    const c = cells[k] || {}, i = x + y * W;
    if (c.t === 'wall') T.wall[i] = 1; else if (c.t === 'difficult') T.rough[i] = 1; else if (c.t === 'cover') T.cover[i] = 1;
    const h = Math.max(-6, Math.min(24, parseInt(c.h, 10) || 0));
    if (h) { T.h[i] = h; T.anyH = true; }
    if (c.t || h) T.any = true;
  }
  this.T = T;
};
/* speed before standing up costs anything */
Sim.prototype.rawSpeed = function (u) {
  let s = u.speed;
  for (const b of u.buffs) if (b.speedBonus) s += b.speedBonus;
  return Math.max(0, s);
};
/* Prone (2024): standing up costs half the creature's speed, and is not possible at speed 0 or while incapacitated (or held).
   Crawling covers the same distance as standing and then walking (half), but leaves it prone, so a creature always stands. */
Sim.prototype.canStand = function (u) {
  return !u.grappledBy && !this.incap(u) && !this.has(u, ['Restrained']) && this.rawSpeed(u) > 0;
};
Sim.prototype.standCost = function (u) { return Math.ceil(this.rawSpeed(u) / 10) * 5; };
const isProne = u => { for (const b of u.buffs) if (b.data.condition === 'Prone') return true; return false; };
/* what it can move this turn: a creature that stood up this turn has paid for it (u.stoodFt), one that is still prone
   (it has not had its turn yet) moves as if it already had, so reach estimates and the AI see the same cost the turn will */
Sim.prototype.speedOf = function (u) {
  let s = this.rawSpeed(u);
  if (u.stoodFt && u.stoodTurn === this.turnSeq) s -= u.stoodFt;
  else if (isProne(u) && this.canStand(u)) s -= this.standCost(u);
  return Math.max(0, s);
};
/* start of its turn: a prone creature that can stands up, paying half its speed */
Sim.prototype.standUp = function (u) {
  if (!isProne(u) || !this.canStand(u)) return false;
  const c = this.standCost(u);
  this.dropBuffs(u, b => b.data.condition === 'Prone');
  u.stoodFt = c; u.stoodTurn = this.turnSeq;
  this.ev('effect', `${u.name} stands up (${c} ft of its movement)`, { uid: u.uid });
  return true;
};
/* knocked down by a fall or a spit: prone until it stands up on its own turn */
Sim.prototype.fallProne = function (u) {
  this.addBuff(u, u, { id: 'prone', name: 'Prone' }, { duration: 'until it stands up', condition: 'Prone' });
};
Sim.prototype.hAt = function (x, y) { return this.T.anyH ? this.T.h[x + y * this.W] : 0; };
Sim.prototype.isWall = function (x, y) { return this.T.any && this.T.wall[x + y * this.W] === 1; };
/* who is up in the air right now: a fly speed, conscious, and not knocked prone, grappled or restrained */
const FLY_LIFT = 3;    // how high a flyer planning to shoot expects to be (15 ft)
const MAX_ALT = 24;    // 120 ft
/* able to stay in the air: a fly speed, conscious, free to move, and not knocked prone */
Sim.prototype.airborne = function (u) {
  return !!(u && u.fly && u.onBoard && !u.dead && u.hp > 0 && !u.grappledBy && this.speedOf(u) > 0 &&
    !this.has(u, ['Prone', 'Restrained', 'Paralyzed', 'Stunned', 'Unconscious', 'Petrified', 'Incapacitated']));
};
Sim.prototype.flyMap = function () {
  if (this._flyMapVer === this.posVer && this._flyMap && this._flyMap.length === this.W * this.H) return this._flyMap;
  const m = new Uint8Array(this.W * this.H);
  for (const u of this.units || []) if (u.alt > 0 && u.onBoard && !u.dead) {
    const n = u.n || 1;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const x = u.x + i, y = u.y + j; if (x < this.W && y < this.H) m[x + y * this.W] = Math.max(m[x + y * this.W], u.alt); }
  }
  this._flyMap = m; this._flyMapVer = this.posVer;
  return m;
};
/* a creature in the air that can't stay up falls: 1d6 per 10 ft, lands prone (hovering creatures stay up
   unless they're knocked out) */
Sim.prototype.fallCheck = function (u) {
  if (!u || !(u.alt > 0) || this._falling === u) return;
  const conscious = !u.dead && u.hp > 0 && !this.has(u, ['Unconscious', 'Paralyzed', 'Stunned', 'Petrified']);
  if (u.dead) { u.alt = 0; this.boardChanged(); return; }
  if (this.airborne(u) || (u.hover && conscious && u.fly)) return;
  const h = u.alt;
  this._falling = u;
  try {
    u.alt = 0; this.boardChanged();
    const dice = Math.floor(h / 2);
    let d = 0;
    if (dice > 0) { d = this.damage(u, u, Math.floor(rollDice(dice + 'd6', this.R, false)), { type: 'bludgeoning' }); u.dmgDealt -= d; }
    if (!u.dead && !this.has(u, ['Prone'])) this.fallProne(u);
    this.ev('effect', `${u.name} falls ${h * 5} ft${d ? ` (${d} damage)` : ''}${u.dead ? '' : ' and lands prone'}`, { uid: u.uid, dmg: d });
  } finally { this._falling = null; }
};
/* can something at (x0,y0) see / reach a straight line to (x1,y1)?
   solid = only what physically stops things (walls, higher ground): an area of effect spreads through fog
   and past creatures, it just can't go through a wall or over a cliff. */
Sim.prototype.los = function (x0, y0, x1, y1, solid, air0, air1) {
  const T = this.T;
  if (!T.any) return true;
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  if (n <= 1 && !T.anyH) return true;
  const W = this.W;
  const fog = solid ? null : T.fog;
  if (fog && n > 1 && (fog[x0 + y0 * W] || fog[x1 + y1 * W])) return false;   // heavily obscured: nobody sees in or out
  // a flying creature is up in the air (FLY_LIFT above the ground under it), so ledges and crates don't hide it
  // or hide things from it; walls still do. Only matters on maps with height.
  let l0 = 0, l1 = 0;
  if (T.anyH) {
    const fa = this.flyMap();
    l0 = Math.min(15, Math.max(0, (air0 !== undefined ? +air0 : fa[x0 + y0 * W]) || 0));
    l1 = Math.min(15, Math.max(0, (air1 !== undefined ? +air1 : fa[x1 + y1 * W]) || 0));
  }
  const key = ((x0 + y0 * W) * 4096 + (x1 + y1 * W)) * 256 + l0 * 16 + l1, cache = solid ? T.solC : T.losC;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let ok = true;
  const h0 = T.h[x0 + y0 * W] + 1 + l0, h1 = T.h[x1 + y1 * W] + 1 + l1;    // eye level: a creature stands 5 ft tall
  const steps = n * 4;
  for (let i = 1; i < steps && ok; i++) {
    const f = i / steps;
    const cx = Math.floor(x0 + 0.5 + (x1 - x0) * f), cy = Math.floor(y0 + 0.5 + (y1 - y0) * f);
    if ((cx === x0 && cy === y0) || (cx === x1 && cy === y1)) continue;
    const c = cx + cy * W;
    if (T.wall[c] || (fog && fog[c])) ok = false;
    else if (T.anyH && T.h[c] > h0 + (h1 - h0) * f + 1e-9) ok = false;
  }
  cache.set(key, ok);
  return ok;
};
/* line of sight between two bodies (side n0 with its top-left on x0,y0; side n1 on x1,y1): clear from any square of one to any
   square of the other. The top-left pair goes first, so a Medium creature's test is the plain one */
Sim.prototype.losB = function (x0, y0, n0, x1, y1, n1, solid, air0, air1) {
  if (this.los(x0, y0, x1, y1, solid, air0, air1)) return true;
  const a = n0 || 1, b = n1 || 1;
  if (a + b === 2) return false;
  const W = this.W, H = this.H;
  // the answer for a big body is kept until anyone moves (who is up in the air changes the sight lines)
  if (this._lbVer !== this.posVer || !this._lbC) { this._lbC = new Map(); this._lbVer = this.posVer; }
  const ak = (air0 === undefined ? 0 : Math.min(127, +air0 || 0) + 1) * 130 + (air1 === undefined ? 0 : Math.min(127, +air1 || 0) + 1);
  const key = ((((x0 + y0 * W) * 4096 + (x1 + y1 * W)) * 25 + a * 5 + b) * 2 + (solid ? 1 : 0)) * 17000 + ak;
  const hit = this._lbC.get(key);
  if (hit !== undefined) return hit;
  let ok = false;
  for (let j0 = 0; !ok && j0 < a; j0++) for (let i0 = 0; !ok && i0 < a; i0++) {
    const p = x0 + i0, q = y0 + j0;
    if (p >= W || q >= H) continue;
    for (let j1 = 0; !ok && j1 < b; j1++) for (let i1 = 0; i1 < b; i1++) {
      const r = x1 + i1, s = y1 + j1;
      if ((!i0 && !j0 && !i1 && !j1) || r >= W || s >= H) continue;
      if (this.los(p, q, r, s, solid, air0, air1)) { ok = true; break; }
    }
  }
  this._lbC.set(key, ok);
  return ok;
};
Sim.prototype.losU = function (a, b, solid) { return this.losB(a.x, a.y, a.n, b.x, b.y, b.n, solid); };
/* half cover (+2 AC, +2 Dex saves) when something waist-high lies between: a low wall, or ground raised
   at least 5 ft above the line along the floor (a 5-ft ledge or crate). Higher ground that blocks the eye
   line is total cover instead (los). Shooting down from above clears it. */
Sim.prototype.coverAC = function (a, t) {
  if (!this.T.any || this.dist(a, t) <= 5) return 0;
  let v = this.coverBetween(a.x, a.y, t.x, t.y, a.alt || 0, t.alt || 0);
  const an = a.n || 1, tn = t.n || 1;
  // a big body: the least cover over its squares and the target's (the attacker picks its corner)
  for (let j0 = 0; v && j0 < an; j0++) for (let i0 = 0; v && i0 < an; i0++) for (let j1 = 0; v && j1 < tn; j1++) for (let i1 = 0; v && i1 < tn; i1++) {
    const p = a.x + i0, q = a.y + j0, r = t.x + i1, s = t.y + j1;
    if (p < this.W && q < this.H && r < this.W && s < this.H) v = Math.min(v, this.coverBetween(p, q, r, s, a.alt || 0, t.alt || 0));
  }
  return v;
};
Sim.prototype.coverBetween = function (x0, y0, x1, y1, air0, air1) {
  const T = this.T;
  if (!T.any) return 0;
  const a0 = Math.min(15, +air0 || 0), a1 = Math.min(15, +air1 || 0);
  const W = this.W, key = ((x0 + y0 * W) * 4096 + (x1 + y1 * W)) * 256 + a0 * 16 + a1;
  let v = T.covC.get(key);
  if (v !== undefined) return v;
  v = 0;
  // the line runs between the two creatures' feet, so from up in the air a crate rarely gets in the way
  const g0 = T.h[x0 + y0 * W] + a0, g1 = T.h[x1 + y1 * W] + a1;
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)), steps = n * 4;
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const cx = Math.floor(x0 + 0.5 + (x1 - x0) * f), cy = Math.floor(y0 + 0.5 + (y1 - y0) * f);
    if ((cx === x0 && cy === y0) || (cx === x1 && cy === y1)) continue;
    const c = cx + cy * W;
    if (T.cover[c] || (T.anyH && T.h[c] >= g0 + (g1 - g0) * f + 1 - 1e-9)) { v = 2; break; }
  }
  T.covC.set(key, v);
  return v;
};
Sim.prototype.canSee = function (x, y, t) {
  // a flyer planning its turn can go up to look over things
  const n = this._mn || 1, tn = t.n || 1;
  if (this._flyer) return this.losB(x, y, n, t.x, t.y, tn, false, this._flyer.alt || 0, t.alt || 0) || this.losB(x, y, n, t.x, t.y, tn, false, Math.max(FLY_LIFT, this._flyer.alt || 0), t.alt || 0);
  return this.losB(x, y, n, t.x, t.y, tn, false, 0, t.alt || 0);
};
/* Hiding (2024): only out of every enemy's line of sight (walls, high ground, heavy obscurement).
   Blindsight within 30 ft still finds you. */
const isHideAction = a => !!(a && a.type === 'buff' && a.target === 'self' && a.buff && a.buff.condition === 'Invisible' && a.buff.duration === '1 round');
Sim.prototype.concealedAt = function (u, x, y) {
  if (!this.units.some(e => e.team !== u.team && e.onBoard && this.alive(e))) return false;    // nobody left to hide from
  for (const e of this.units) {
    if (e.team === u.team || !e.onBoard || !this.alive(e) || this.incap(e) || this.has(e, ['Blinded'])) continue;
    if (this.losB(e.x, e.y, e.n, x, y, u.n) || (e.blindsight && this.distXY(x, y, e) <= 30)) return false;
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
      if (this.occupant(x, y, u.n, u)) continue;
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

/* ----- queries: who is alive, which side, which cells ----- */
Sim.prototype.alive = function (u) { return !u.dead && u.hp > 0; };
Sim.prototype.living = function (u) { return !u.dead; };
Sim.prototype.enemiesOf = function (u) { return this.units.filter(x => x.team !== u.team); };
Sim.prototype.alliesOf = function (u) { return this.units.filter(x => x.team === u.team); };
/* the squares an area covers on this map (walls stop it: a sphere or a set-down cube spreads from its point,
   everything else from the creature). Walls don't move, so each template is worked out once per map. */
Sim.prototype.cellsFor = function (spec, ox, oy, ax, ay, cx, cy) {
  const fromPoint = spec.shape === 'sphere' || (spec.shape === 'cube' && spec.placed);
  let key;
  if (fromPoint) key = spec.shape + spec.size + 'p' + ax + ',' + ay;
  else if (spec.shape === 'emanation') key = (spec.square ? 'q' : 'e') + spec.size + ',' + ox + ',' + oy + ((spec.bn || 1) > 1 ? 'b' + spec.bn : '');
  else if (spec.shape === 'cube') key = 'c' + spec.size + ',' + ox + ',' + oy + ',' + ax + ',' + ay;
  else { const d = dir8(ax - ox, ay - oy); key = spec.shape + spec.size + 'w' + (spec.width || 5) + ',' + ox + ',' + oy + ',' + d[0] + ',' + d[1]; }
  const C = this.T.cellC || (this.T.cellC = new Map());
  let cells = C.get(key);
  if (!cells) {
    cells = areaCells(spec, ox, oy, ax, ay, this.W, this.H);
    const bn = !fromPoint && spec.shape === 'emanation' ? spec.bn || 1 : 1;    // a big creature's emanation: from any square of its body
    if (this.T.any) cells = cells.filter(([x, y]) => !this.T.wall[x + y * this.W] && this.losB(cx, cy, bn, x, y, 1, true));
    if (C.size > 40000) C.clear();
    C.set(key, cells);
  }
  return cells;
};
/* who an area aimed at t from (ox,oy) would catch, besides t; spec/cells are returned for drawing */
Sim.prototype.areaAt = function (a, spec, t, ox, oy, ax, ay, pool, caster, fast) {
  // fast: only work out who is caught (no list of squares) — used while searching for the best aim
  const fromPoint = spec.shape === 'sphere' || (spec.shape === 'cube' && spec.placed);
  const cx = fromPoint ? ax : ox, cy = fromPoint ? ay : oy;
  let isIn, cells = null;
  if (fast) {
    const W = this.W, inb = (x, y) => x >= 0 && y >= 0 && x < W && y < this.H, bn = !fromPoint && spec.shape === 'emanation' ? spec.bn || 1 : 1;
    // nothing past this many squares from where it starts can be in it (a body further off is skipped before its squares are tried)
    const far = Math.round(spec.size / 5) * (spec.shape === 'cube' ? 2 : 1) + Math.max(1, Math.round((spec.width || 5) / 5)) + 1;   // a cube beside its user can slide its own width sideways
    const sd = spec.shape === 'cone' || spec.shape === 'line' ? dir8(ax - ox, ay - oy) : undefined;
    isIn = o => {
      const on = o.n || 1;
      if (this.gapTo(cx, cy, bn, o) > far) return false;
      for (let j = 0; j < on; j++) for (let i = 0; i < on; i++) {
        const px = o.x + i, py = o.y + j;
        if (inb(px, py) && inArea(spec, ox, oy, ax, ay, px, py, sd) && (!this.T.any || (!this.T.wall[px + py * W] && this.losB(cx, cy, bn, px, py, 1, true)))) return true;
      }
      return false;
    };
  } else {
    cells = this.cellsFor(spec, ox, oy, ax, ay, cx, cy);
    const N = this.W * this.H;
    if (!this._mark || this._mark.length !== N) { this._mark = new Int32Array(N); this._stamp = 0; }
    const st = ++this._stamp, mark = this._mark, W = this.W, H = this.H;
    for (const c of cells) mark[c[0] + c[1] * W] = st;
    // any square of a body counts (a big creature caught by its corner is caught)
    isIn = o => {
      if (mark[o.x + o.y * W] === st) return true;
      const on = o.n || 1;
      for (let j = 0; j < on; j++) for (let i = 0; i < on; i++) if ((i || j) && o.x + i < W && o.y + j < H && mark[(o.x + i) + (o.y + j) * W] === st) return true;
      return false;
    };
  }
  // height: a burst is set off at its target's height and reaches as far up and down as out; cones and lines
  // tilt from the creature towards their target and are as thick as they are wide there
  if (this.T.anyH || this.units.some(o => o.alt > 0)) {
    const n = Math.max(1, Math.round(spec.size / 5));
    const zO = (this.T.anyH ? this.T.h[ox + oy * this.W] : 0) + (caster && ((caster.x === ox && caster.y === oy) || spec.atSelf) ? (caster.alt || 0) : (caster && this._flyer === caster ? (caster.alt || 0) : 0));
    let vert;
    if (fromPoint || spec.shape === 'emanation' || spec.shape === 'cube') {
      const zC = fromPoint ? this.zOf(t) : zO;
      vert = o => Math.abs(this.zOf(o) - zC) <= n;
    } else {
      const dT = Math.max(1, Math.abs(t.x - ox), Math.abs(t.y - oy)), slope = (this.zOf(t) - zO) / dT;
      const tol = spec.shape === 'cone' ? (d => Math.floor(d / 2) + 0.5) : (() => 0.5 + (Math.max(1, Math.round((spec.width || 5) / 5)) - 1) / 2);
      vert = o => { const d = Math.max(Math.abs(o.x - ox), Math.abs(o.y - oy)); return Math.abs(this.zOf(o) - (zO + slope * d)) <= tol(d); };
    }
    const flat = isIn;
    isIn = o => flat(o) && vert(o);
  }
  if (!isIn(t)) return null;
  let extra = pool.filter(o => o !== t && o.onBoard && isIn(o));
  if (!spec.explicit) extra = this.orderBySelector(extra, a.target).sort((p, q) => this.dist(p, t) - this.dist(q, t)).slice(0, Math.max(0, (a.targets || 1) - 1));
  // an area hurts everyone in it, the caster's own side included (cones, lines, cubes and emanations start at the caster and spare it)
  let friends = [];
  if (caster && !(a.ext && a.ext.area && a.ext.area.selective) && !(a.ext && a.ext.zone && a.ext.zone.fog)) {
    friends = this.alliesOf(caster).filter(o => o.onBoard && !o.dead && !o.swallowedBy && isIn(o) && (o !== caster || spec.shape === 'sphere'));
  }
  return { spec, cells, extra, friends, ax, ay, ox, oy };
};
/* Cones and lines: try each of the 8 grid directions that reaches t and keep the one that catches the most
   enemies and the fewest allies (ties go to the direction closest to t's bearing). If none reaches t from
   here, a caster gets null (it should line up from another square). */
/* how good an aim is: for a tactical caster, the damage (or effect) it lands on enemies minus what it costs our
   own side (a downed ally takes a failed death save); otherwise simply more enemies, fewer allies */
Sim.prototype.aimScore = function (a, caster, extra, friends, memo) {
  if (!caster || caster.ai !== 'tactical') return extra.length * 10 - friends.reduce((q, f) => q + (f.hp <= 0 ? 60 : 16), 0);
  let v = 0;
  for (const o of extra) {
    let e = memo && memo.get(o);
    if (e === undefined) { e = Math.max(1, Math.min(this.expected(caster, a, o), this.kHp(caster, o) + 4)); if (memo) memo.set(o, e); }
    v += e;
  }
  if (friends.length) v -= this.friendPenalty(caster, a, friends);
  return v;
};
/* the 8 grid directions, in the order aimStraight has always tried them */
const DIR8 = [0, 1, 2, 3, 4, 5, 6, 7].map(k => [Math.round(Math.cos(k * Math.PI / 4)), Math.round(Math.sin(k * Math.PI / 4))]);
/* the squares a big creature (side bn, top-left on ox,oy) can start a cone, line or cube from: the edge of its body */
const bodyEdge = (ox, oy, bn) => {
  const out = [];
  for (let j = 0; j < bn; j++) for (let i = 0; i < bn; i++) if (!i || !j || i === bn - 1 || j === bn - 1) out.push([ox + i, oy + j]);
  return out;
};
/* a cone or a 5-ft line from an edge square (px,py) of a body, one step (sx,sy) at a time: it stays off the body exactly when its first
   square is off it (every square of it is at least that far out along the same axis); a wider line or a cube needs areaOnBody */
const offBody = (spec, px, py, sx, sy, bx, by, bn) => {
  const x = px + sx, y = py + sy, out = x < bx || y < by || x >= bx + bn || y >= by + bn;
  return spec.shape === 'cone' || (spec.shape === 'line' && Math.max(1, Math.round((spec.width || 5) / 5)) === 1) ? out : null;
};
/* does an area from (px,py) aimed at (ax,ay) cover any square of a body (side bn, top-left on bx,by)? */
const areaOnBody = (spec, px, py, ax, ay, bx, by, bn) => {
  for (let j = 0; j < bn; j++) for (let i = 0; i < bn; i++) if (inArea(spec, px, py, ax, ay, bx + i, by + j)) return true;
  return false;
};
Sim.prototype.aimStraight = function (a, spec, t, ox, oy, pool, caster) {
  const n = Math.max(1, Math.round(spec.size / 5)), bn = caster ? caster.n || 1 : 1, tn = t.n || 1;
  // a big creature's breath starts from any square on the edge of its body, pointing out of it (it never covers its own squares)
  const origins = bn > 1 ? bodyEdge(ox, oy, bn) : [[ox, oy]];
  const sp = bn > 1 ? Object.assign({}, spec, { atSelf: caster.x === ox && caster.y === oy }) : spec;
  let best = null, bs = -Infinity;
  const memo = new Map();
  const narrow = sp.shape === 'cone' || (sp.shape === 'line' && Math.max(1, Math.round((sp.width || 5) / 5)) === 1);
  // who an aim catches is the same for every square of a big body that shares this edge square: kept until anyone moves. Only for an
  // explicit area (a guessed one orders its extra targets with a dice roll, which must not be skipped)
  let fc = null, fk = '';
  if (bn > 1 && sp.explicit) {
    if (this._afVer !== this.posVer || !this._afC) { this._afC = new Map(); this._afVer = this.posVer; }
    fc = this._afC;
    fk = a.id + '|' + sp.shape + sp.size + 'w' + (sp.width || 5) + '|' + t.uid + '|' + caster.uid + ':' + (sp.atSelf ? 1 : 0) + ':' + (caster.alt || 0) + ':' + (this._flyer === caster ? 1 : 0) + '|' + pool.map(o => o.uid).join(',') + '|';
  }
  for (const [px, py] of origins) {
    const bear = Math.atan2(t.y - py, t.x - px);
    for (let k = 0; k < 8; k++) {
      const sx = DIR8[k][0], sy = DIR8[k][1];
      // a cone or 5-ft line only reaches squares 1..n steps out along each axis it moves on: t's body must have one there (cheap, before inArea)
      if (narrow && ((sx && ((sx > 0 ? t.x + tn - 1 - px : px - t.x) < 1 || (sx > 0 ? t.x - px : px - (t.x + tn - 1)) > n)) || (sy && ((sy > 0 ? t.y + tn - 1 - py : py - t.y) < 1 || (sy > 0 ? t.y - py : py - (t.y + tn - 1)) > n)))) continue;
      const ax = px + sx * n, ay = py + sy * n;
      if (bn > 1) { const off = offBody(sp, px, py, sx, sy, ox, oy, bn); if (off === false || (off === null && areaOnBody(sp, px, py, ax, ay, ox, oy, bn))) continue; }
      // does it reach t's body at all: geometry only, so a big body's other candidate squares that share this edge square reuse it
      let hit;
      if (fc) { const hk = 'h' + sp.shape + sp.size + 'w' + (sp.width || 5) + '|' + px + ',' + py + ',' + k + '|' + t.x + ',' + t.y + ',' + tn; hit = fc.get(hk); if (hit === undefined) { hit = tn > 1 ? areaOnBody(sp, px, py, ax, ay, t.x, t.y, tn) : inArea(sp, px, py, ax, ay, t.x, t.y); fc.set(hk, hit); } }
      else hit = tn > 1 ? areaOnBody(sp, px, py, ax, ay, t.x, t.y, tn) : inArea(sp, px, py, ax, ay, t.x, t.y);
      if (!hit) continue;
      let r;
      if (fc) { const key = fk + px + ',' + py + ',' + k; r = fc.get(key); if (r === undefined) { r = this.areaAt(a, sp, t, px, py, ax, ay, pool, caster, true); fc.set(key, r); } }
      else r = this.areaAt(a, sp, t, px, py, ax, ay, pool, caster, true);
      if (!r) continue;
      let off = Math.abs(k * Math.PI / 4 - bear) % (2 * Math.PI); if (off > Math.PI) off = 2 * Math.PI - off;
      const sc = this.aimScore(a, caster, r.extra, r.friends, memo) - off * 0.01;
      if (sc > bs) { best = r; bs = sc; }
    }
  }
  if (best) return this.areaAt(a, sp, t, best.ox, best.oy, best.ax, best.ay, pool, caster) || best;
  if (caster) return null;
  return { spec, cells: [], extra: [], friends: [], ax: t.x, ay: t.y, ox, oy };
};
/* a cube that starts next to a big creature (Thunderwave from a Large caster): any square on its body's edge, the cube clear of the body */
Sim.prototype.aimCubeFrom = function (a, spec, t, ox, oy, pool, caster) {
  const bn = caster.n, sp = Object.assign({}, spec, { atSelf: caster.x === ox && caster.y === oy }), memo = new Map();
  let best = null, bs = -Infinity;
  for (const [px, py] of bodyEdge(ox, oy, bn)) {
    if (areaOnBody(sp, px, py, t.x, t.y, ox, oy, bn)) continue;
    const r = this.areaAt(a, sp, t, px, py, t.x, t.y, pool, caster, true);
    if (!r) continue;
    const sc = this.aimScore(a, caster, r.extra, r.friends, memo) - (Math.abs(px - t.x) + Math.abs(py - t.y)) * 0.01;
    if (sc > bs) { best = r; bs = sc; }
  }
  return best ? this.areaAt(a, sp, t, best.ox, best.oy, t.x, t.y, pool, caster) || best : null;
};
/* Who an area aimed at t catches, besides t. With a caster given, it also looks for a better aim that still
   catches t: a sphere's point can sit anywhere within range that keeps t inside, a cone or line can swing
   a little either side. Better = more enemies, fewer allies (a downed ally counts heavily). */
Sim.prototype.areaCatch = function (a, t, ox, oy, pool, caster) {
  const spec = areaSpec(a);
  if (!spec) return null;
  if (spec.shape === 'cone' || spec.shape === 'line') return this.aimStraight(a, spec, t, ox, oy, pool, caster);
  const bn = caster ? caster.n || 1 : 1;
  if (bn > 1 && spec.shape === 'emanation') spec.bn = bn;                       // from the edge of a big creature's body
  if (bn > 1 && spec.shape === 'cube' && !spec.placed) { const c = this.aimCubeFrom(a, spec, t, ox, oy, pool, caster); if (c) return c; }
  let best = this.areaAt(a, spec, t, ox, oy, t.x, t.y, pool, caster);
  if (!best) best = { spec, cells: [], extra: [], friends: [], ax: t.x, ay: t.y, ox, oy };   // walls in the way: just the target
  if (!caster || !spec.explicit || spec.shape === 'emanation' || (spec.shape === 'cube' && !spec.placed)) return best;
  // Where a burst can be set down to keep t inside, and who each spot would catch, doesn't depend on where the
  // caster stands (only range and line of sight do): worked out once per board position, then scored per caster.
  if (!(spec.shape === 'sphere' || spec.shape === 'cube')) return best;
  const n = Math.round(spec.size / 5), range = Math.max(5, a._range || spec.size) / 5;
  const close = o => o !== t && o.onBoard && Math.max(Math.abs(o.x - t.x), Math.abs(o.y - t.y)) <= n * 2;
  if (!pool.some(close) && !this.alliesOf(caster).some(o => close(o) && !o.dead)) return best;
  if (this._aimVer !== this.posVer || !this._aimC) { this._aimC = new Map(); this._aimVer = this.posVer; }
  const key = spec.shape + spec.size + (spec.placed ? 'p' : '') + '|' + t.uid;
  let aims = this._aimC.get(key);
  if (!aims) {
    aims = [];
    const everyone = this.units.filter(o => o.onBoard && !o.dead && !o.swallowedBy);
    for (let y = t.y - n; y <= t.y + n; y++) for (let x = t.x - n; x <= t.x + n; x++) {
      if ((x === t.x && y === t.y) || x < 0 || y < 0 || x >= this.W || y >= this.H || this.isWall(x, y)) continue;
      if (!inArea(spec, ox, oy, x, y, t.x, t.y)) continue;
      const r = this.areaAt(a, spec, t, ox, oy, x, y, everyone, null, true);
      if (r) aims.push({ x, y, caught: r.extra });
    }
    this._aimC.set(key, aims);
  }
  const inPool = new Set(pool), mine = new Set(this.alliesOf(caster));
  const selective = !!(a.ext && a.ext.area && a.ext.area.selective);
  const scored = [], memo = new Map();
  let bs = this.aimScore(a, caster, best.extra, best.friends, memo);
  for (const am of aims) {
    if (Math.max(Math.abs(am.x - ox), Math.abs(am.y - oy)) > range) continue;
    const ex = [], fr = [];
    for (const o of am.caught) {
      if (inPool.has(o)) ex.push(o);
      else if (!selective && mine.has(o) && (o !== caster || spec.shape === 'sphere')) fr.push(o);
    }
    const sc = this.aimScore(a, caster, ex, fr, memo) - (Math.abs(am.x - t.x) + Math.abs(am.y - t.y)) * 0.01;
    if (sc > bs) scored.push({ am, sc });
  }
  scored.sort((p, q) => q.sc - p.sc);
  for (const c of scored) {
    if (this.T.any && !this.los(ox, oy, c.am.x, c.am.y, true)) continue;
    return this.areaAt(a, spec, t, ox, oy, c.am.x, c.am.y, pool, caster) || best;
  }
  return best;
};
/* height counts toward distance, unless one side flies (it simply rises or dips to meet the other) */
/* height: the ground under a creature plus how high it's flying, in 5-ft steps. Distances are 3D (5e grid:
   the bigger of across and up). */
Sim.prototype.zOf = function (u) { return (this.T.anyH ? this.T.h[u.x + u.y * this.W] : 0) + (u.alt || 0); };
/* squares between two footprints along one axis (0 = touching or overlapping) */
const gapAxis = (p, np, q, nq) => { const g = p > q ? p - (q + nq - 1) : q - (p + np - 1); return g > 0 ? g : 0; };
Sim.prototype.dist = function (a, b) {
  const an = a.n || 1, bn = b.n || 1;
  const gx = an + bn > 2 ? gapAxis(a.x, an, b.x, bn) : Math.abs(a.x - b.x), gy = an + bn > 2 ? gapAxis(a.y, an, b.y, bn) : Math.abs(a.y - b.y);
  const d = gx > gy ? gx : gy;
  if (!this.T.anyH && !a.alt && !b.alt) return d * 5;                    // flat ground, nobody up in the air
  return Math.max(d, Math.abs(this.zOf(a) - this.zOf(b))) * 5;
};
/* distance from a square to b, for whoever is planning a move there: a flyer planning its own turn can rise or
   drop to b's height (but not below the ground); anyone else stands on the ground */
Sim.prototype.distXY = function (x, y, b) {
  const mn = this._mn || 1, bn = b.n || 1, big = mn + bn > 2;
  const dx = big ? gapAxis(x, mn, b.x, bn) : (x > b.x ? x - b.x : b.x - x), dy = big ? gapAxis(y, mn, b.y, bn) : (y > b.y ? y - b.y : b.y - y), d = dx > dy ? dx : dy;
  if (!this.T.anyH && !b.alt) return d * 5;
  const g = this.T.anyH ? this.T.h[x + y * this.W] : 0, zb = this.zOf(b);
  const dz = this._flyer ? Math.max(0, g - zb) : Math.abs(zb - g);
  return Math.max(d, dz) * 5;
};

/* ----- grid & movement ----- */
/* who stands on (x,y); with n, who overlaps the n x n block whose top-left is (x,y) (a big creature's footprint) */
Sim.prototype.occupant = function (x, y, n, skip) {
  const m = n || 1;
  for (const u of this.units) if (u.onBoard && !u.dead && u !== skip) {
    const un = u.n || 1;
    if (un + m === 2 ? (u.x === x && u.y === y) : (u.x < x + m && x < u.x + un && u.y < y + m && y < u.y + un)) return u;
  }
  return null;
};
/* can u stand with its footprint's top-left on (x,y)? (map edge, walls, and anyone else's squares) */
Sim.prototype.fits = function (u, x, y) {
  const n = u.n || 1;
  if (x < 0 || y < 0 || x + n > this.W || y + n > this.H) return false;
  if (this.T.any) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (this.T.wall[(x + i) + (y + j) * this.W]) return false;
  return !this.occupant(x, y, n, u);
};
/* is any square of u's footprint in this set of cell indexes? */
Sim.prototype.coversIn = function (set, u) {
  const n = u.n || 1;
  if (n === 1) return set.has(u.x + u.y * this.W);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (set.has((u.x + i) + (u.y + j) * this.W)) return true;
  return false;
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
/* top-left squares where u's footprint would overlap someone else (a big mover is blocked by anyone's footprint near its corner) */
Sim.prototype.takenFor = function (u) {
  const W = this.W, H = this.H, un = u.n || 1, taken = new Uint8Array(W * H);
  for (const o of this.units) if (o !== u && o.onBoard && !o.dead) {
    const on = o.n || 1;
    for (let y = Math.max(0, o.y - un + 1); y < Math.min(H, o.y + on); y++) for (let x = Math.max(0, o.x - un + 1); x < Math.min(W, o.x + on); x++) taken[x + y * W] = 1;
  }
  return taken;
};
Sim.prototype.reachMapRaw = function (u, budgetFt) {
  const steps = Math.floor(budgetFt / 5);
  const W = this.W, H = this.H;
  const dist = new Int16Array(W * H).fill(-1), prev = new Int32Array(W * H).fill(-1);
  const block = new Uint8Array(W * H);   // 1 = standing enemy (can't pass)
  // a hostile creature's space can be passed if it is Tiny, two sizes apart or Incapacitated (2024 rule); an ally's always.
  // Anyone else's space is difficult terrain (crowd: top-left squares where u's body would overlap someone)
  const us = sizeIdx(u.size, 2), un = u.n || 1, crowd = new Uint8Array(W * H);
  for (const o of this.units) if (o !== u && o.onBoard && !o.dead) {
    const on = o.n || 1;
    for (let y = Math.max(0, o.y - un + 1); y < Math.min(H, o.y + on); y++) for (let x = Math.max(0, o.x - un + 1); x < Math.min(W, o.x + on); x++) crowd[x + y * W] = 1;
    if (o.team === u.team || !this.alive(o) || o.size === 'Tiny' || Math.abs(sizeIdx(o.size, 2) - us) >= 2 || this.incap(o)) continue;
    for (let j = 0; j < on; j++) for (let i = 0; i < on; i++) if (o.x + i < W && o.y + j < H) block[(o.x + i) + (o.y + j) * W] = 1;
  }
  if (un > 1) {   // a big creature needs its whole footprint clear: mark every square it can't stand on as blocked
    const bad = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let ok = x + un <= W && y + un <= H;
      for (let j = 0; ok && j < un; j++) for (let i = 0; i < un; i++) if (block[(x + i) + (y + j) * W] || (this.T.any && this.T.wall[(x + i) + (y + j) * W])) { ok = false; break; }
      if (!ok) bad[x + y * W] = 1;
    }
    bad[u.x + u.y * W] = 0;
    for (let c = 0; c < bad.length; c++) block[c] = bad[c];
  }
  crowd[u.x + u.y * W] = 0;
  return this.reachMapT(u, steps, dist, prev, block, crowd);    // another's space costs double, so even an open field is a weighted search
};
/* movement with terrain: difficult ground costs double, climbing costs extra, walls can't be crossed
   (or squeezed past diagonally). dist[] holds the movement spent, in 5-ft units. */
Sim.prototype.climbChance = function (u) {
  if (u.fly || u.climb) return 1;
  if (this.climbDC >= 99) return 0;
  return Math.max(0, Math.min(1, (21 + (u.athletics || 0) - this.climbDC) / 20));
};
Sim.prototype.reachMapT = function (u, steps, dist, prev, block, crowd) {
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
      const rough = T.rough[n] || T.cover[n] || (crowd && crowd[n]);
      if (dx && dy && T.wall[cx + dx + cy * W] && T.wall[cx + (cy + dy) * W]) continue;   // no slipping between two walls
      // flyers skip rough ground and climbing. Going up costs 5 ft extra per 5 ft of height. A ledge of 10 ft or
      // more (up or down) has to be climbed: a climb speed does it at no extra cost, anyone else needs an
      // Athletics check (rolled when they try) and doesn't attempt one it would likely fail
      const rise = T.h[n] - T.h[c];
      let cost;
      if (u.fly) cost = crowd && crowd[n] ? 2 : 1;                 // a flyer skips rough ground, not someone's space
      else if (rise >= 2 || rise <= -2) {
        if (u.climb) cost = rough ? 2 : 1;
        else if (this.climbChance(u) < 0.35) continue;
        else cost = (rough ? 2 : 1) + Math.abs(rise);
      } else cost = (rough ? 2 : 1) + Math.max(0, rise);
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
/* squares between a footprint of side n with its top-left on (x,y) and b's footprint */
Sim.prototype.gapTo = function (x, y, n, b) {
  const mn = n || 1, bn = b.n || 1;
  if (mn + bn === 2) return Math.max(Math.abs(x - b.x), Math.abs(y - b.y));
  return Math.max(gapAxis(x, mn, b.x, bn), gapAxis(y, mn, b.y, bn));
};
Sim.prototype.adjacentEnemies = function (u, x, y, alt) {
  const zm = (this.T.anyH ? this.T.h[x + y * this.W] : 0) + (alt !== undefined ? alt : (u.alt || 0));
  return this.enemiesOf(u).filter(e => e.onBoard && this.alive(e) && !this.incap(e) && this.meleeReach(e) > 0 &&
    Math.max(this.gapTo(x, y, u.n, e), Math.abs(this.zOf(e) - zm)) * 5 <= this.meleeReach(e) && this.losB(e.x, e.y, e.n, x, y, u.n));   // a reach weapon can't strike round a wall corner
};

Object.assign(ENG, { areaSpec, areaCells, inArea, MAX_ALT, isHideAction, bodyEdge, offBody, areaOnBody, gapAxis });
})(typeof window !== 'undefined' ? window : globalThis);
