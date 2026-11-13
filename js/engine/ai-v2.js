/* TACTICAL ENGINE, part 8: AI v2 (file list and how the parts share names: js/engine/base.js).
   Who plays v2 (v2Eligible, v2Setup), casters and slot levels, downed and dead allies, pacing, danger, posture,
   what an option is worth (v2Value, v2SelfValue, v2AllyValue, v2Control), the Legendary Resistance burn plan,
   running concentration (v2Holding), friendly fire. Settings: ai-v2-data.js. Design: docs/ai-v2.md. */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { rollDice, avgDice, INCAP, DANGER_CONDS, ADV_TARGET, ADV_SELF, sizeIdx, smiteOf, smiteDice, effectName, isHpPool, freqKind, Sim, areaSpec, isHideAction, bodyEdge, offBody, areaOnBody, AI_BASE, aiProfile, tierOf, tierProfile, DUR_WEIGHT } = ENG;

const isReckless = a => (a.actionSlot === 5 || a.actionSlot === 6) && a.type === 'buff' && a.target === 'self' && a.buff && a.buff.condition === 'Attacks and is attacked with Advantage';

/* which creatures v2 drives: plays tactically (or names a profile), any caster kind (step 3a),
   and nothing it can't score yet (swallowing, dice pools other than heals) */
Sim.prototype.v2Eligible = function (u) {
  const prof = u.tpl.ext && u.tpl.ext.aiProfile;
  if (!this.aiV2 || !this.aiV2[u.team] || (u.ai !== 'tactical' && !prof && !(this.aiV2.tiers && !u.isPC))) return false;
  // every caster kind plays on v2 (step 3a); casterKind now only says who stands at the back (backLine)
  return !u.actions.some(a => (a.actionSlot === 0 || a.actionSlot === 1) && a.ext && (a.ext.swallow || (a.ext.pool && a.type !== 'heal')));
};
/* stands at the back: a spellbook, and a full caster or no melee attack (a paladin or an Eldritch Knight is a front-liner) */
Sim.prototype.backLine = function (o) {
  return !!o.hasSpells && (o.casterKind === 'full' || !this.hasMelee(o));
};
Sim.prototype.v2Setup = function (u) {
  u.v2 = this.v2Eligible(u);
  u._v2c = null;
  u.reviver = null;
  u.smiteA = null; u.smiteSeq = 0;
  if (!u.v2) return;
  u.smiteA = u.actions.find(a => smiteOf(a)) || null;     // Divine Smite: a rider on a hit, not a bonus option (docs/ai-v2.md "Hybrids")
  u._poolPick = new Map();                                  // Lay on Hands: the points v2 chose, per action and target
  u.reviver = u.isPC && u.slots ? u.actions.find(a => a.ext && a.ext.revivify && a._spell) || null : null;
  u.ai = 'tactical';
  u.tier = this.aiV2.tiers && !u.isPC ? tierOf(u.tpl) : null;      // foes: 'tiers' (docs/ai-v2.md)
  u.v2P = u.tier ? tierProfile(u.tier, u.tpl.ext && u.tpl.ext.aiProfile, u.tpl) : aiProfile(u.tpl.ext && u.tpl.ext.aiProfile);
  u.v2Start = new Map(u.uses);      // what it had when the fight started, for pacing
  u.v2Slots0 = slotLevels(u);
};

/* ---- casters: a spell at a chosen slot level ---- */
const slotLevels = u => u.slots ? u.slots.reduce((t, n, i) => t + n * (i + 1), 0) : 0;
// what the spell does cast at slot level L (upcast dice and targets folded in, as doAction will roll it)
function castCopy(a, L) {
  if (!(a._spell && a._spell.level) || !(L > a._spell.level)) return a;
  const k = L - a._spell.level, o = Object.assign({}, a);
  if (a._spell.upcast) {
    const extra = Array(k).fill(a._spell.upcast).join(' + ');
    if (a.type === 'heal') o.amount = a.amount + ' + ' + extra;
    else if (a.type === 'atk') { o.dpr = a.dpr + ' + ' + extra; if (a.ext && a.ext.wtDpr) o.ext = Object.assign({}, a.ext, { wtDpr: a.ext.wtDpr + ' + ' + extra }); }
  }
  if (a._spell.upcastTargets) o.targets = (a.targets || 1) + a._spell.upcastTargets * k;
  if (a.ext && a.ext.dot) o.ext = Object.assign({}, o.ext, { dotAt: [a.ext.dot.dice].concat(a.ext.dot.upcast ? Array(k).fill(a.ext.dot.upcast) : []).join(' + ') });
  return o;
}
/* the slot levels worth weighing for a spell: its lowest free slot, and up to two higher ones when upcasting adds something.
   [0] for anything that takes no slot, [] when it can't be cast */
Sim.prototype.v2CastLevels = function (u, a) {
  if (!(a._spell && a._spell.level) || this.sustaining(u, a)) return [0];
  const L0 = this.slotFor(u, a._spell.level);
  if (L0 < 0) return [];
  const out = [L0];
  if (a._spell.upcast || a._spell.upcastTargets || smiteOf(a)) for (let l = L0 + 1; l <= 9 && out.length < 3; l++) if (u.slots[l - 1] > 0) out.push(l);
  return out;
};
/* Arcane Recovery & co.: the levels it will win back on a short rest still ahead today */
Sim.prototype.v2Recovery = function (u) {
  if (!u.recovery || u.recoveryUsed || u.slotReset === 'sr' || !this.leftFor(u)) return 0;
  const restAhead = u.recovery.anyBreak || (typeof this.fightsBeforeRest === 'number' && this.fightsBeforeRest < (this.encountersLeft || 0));
  return restAhead ? u.recovery.levels || 0 : 0;
};

/* ---- Revivify (docs/ai-v2.md, step 2.12 part B): a death makes a caster keep a slot; the fight's end spends it ---- */
const REVIVIFY_ROUNDS = 10;      // the rule: dead for no longer than a minute
const slotsFrom = (u, level) => u.slots ? u.slots.slice(level - 1).reduce((t, n) => t + n, 0) : 0;
/* the party's dead that Revivify can still reach: died this fight, within the minute */
Sim.prototype.revivable = function (team) {
  return this.units.filter(o => o.team === team && o.isPC && o.dead && !o.fled && o.diedFight === this.fightNo && this.round - o.diedRound <= REVIVIFY_ROUNDS);
};
/* who keeps a slot for whom: each of the dead goes to the caster with the most slots free, standing casters first. Worked out afresh, so a
   reserve goes away by itself once the ally is back, the minute is up, or another caster covers it */
Sim.prototype.reviveDuty = function (team) {
  const duty = new Map(), casters = this.units.filter(o => o.team === team && o.reviver && !o.dead);
  const free = o => slotsFrom(o, o.reviver._spell.level) - (duty.get(o.uid) || 0);
  for (const t of this.revivable(team).sort((p, q) => (q.dpr || 0) - (p.dpr || 0))) {
    const c = casters.filter(o => free(o) > 0).sort((p, q) => (q.hp > 0 ? 1 : 0) - (p.hp > 0 ? 1 : 0) || free(q) - free(p))[0];
    if (c) duty.set(c.uid, (duty.get(c.uid) || 0) + 1);
    if (c) (duty.who = duty.who || new Map()).set(c.uid, t);
  }
  return duty;
};
/* what u keeps for its dead: { n slots, their levels, the lowest level that casts it, t: the ally } or null */
Sim.prototype.v2Reserve = function (u) {
  if (!u.reviver) return null;
  const duty = this.reviveDuty(u.team), n = duty.get(u.uid);
  if (!n) return null;
  const min = u.reviver._spell.level;
  let levels = 0, want = n;
  for (let l = min; l <= 9 && want > 0; l++) { const k = Math.min(want, u.slots[l - 1]); levels += k * l; want -= k; }
  return { n, levels, min, t: duty.who.get(u.uid) };
};
/* would spending a slot of level L leave too few for the reserve? */
Sim.prototype.v2Eats = function (u, L) {
  const res = this.v2Reserve(u);
  return !!res && L >= res.min && slotsFrom(u, res.min) <= res.n;
};
/* will u's side fall well before it wins? Its standing HP over the foes' damage against the foes' HP over its damage, as fightInHand reads it.
   Not losing(): that is true whenever someone is dead, which is exactly when a reserve exists */
Sim.prototype.v2Doomed = function (u) {
  const mine = this.alliesOf(u).filter(o => this.alive(o) && o.onBoard), theirs = this.enemiesOf(u).filter(e => this.alive(e) && e.onBoard);
  const myDpr = mine.reduce((t, o) => t + o.dpr, 0) * 0.6, theirDpr = theirs.reduce((t, e) => t + this.kDpr(u, e), 0) * 0.6;
  const toWin = theirs.reduce((t, e) => t + this.kHp(u, e), 0) / Math.max(1, myDpr), toLose = mine.reduce((t, o) => t + o.hp, 0) / Math.max(1, theirDpr);
  return toLose * u.v2P.pacing.reviveDoom < toWin;
};
/* breaking the reserve: the ally's worth, little when the fight is lost anyway (a term: nobody casts Revivify after a defeat) */
Sim.prototype.v2KeepCost = function (u, res, L, F) {
  if (L < res.min || slotsFrom(u, res.min) > res.n) return 0;
  return this.v2KeepWorth(u, res, F);
};
Sim.prototype.v2KeepWorth = function (u, res, F) {
  const P = u.v2P.pacing;
  return (P.reviveLife + (res.t.dpr || 0) * P.reviveDay * (F === undefined ? this.leftFor(u) : F)) * (this.v2Doomed(u) ? P.losing : 1);
};
/* a caster left at 0 HP with a slot: someone standing spends a heal to wake it, inside the minute */
Sim.prototype.wakeReviver = function () {
  const d = this.units.find(o => o.reviver && !o.dead && o.hp <= 0 && slotsFrom(o, o.reviver._spell.level) > 0);
  if (!d) return;
  for (const h of this.units) {
    if (h.team !== d.team || !this.alive(h) || this.incap(h)) continue;
    const a = h.actions.find(o => o.type === 'heal' && (o.actionSlot === 0 || o.actionSlot === 1) && o.target !== 'self' && o._range !== 0 && !o.tempHP && !(o.ext && o.ext.aid) && this.usable(h, o));
    if (a) { this.spend(h, a); this.doActionInner(h, a, {}, {}, [d]); return; }
  }
};
/* the fight is won: each caster with a slot left brings back its dead, at 1 HP (the 300 gp diamond is assumed) */
Sim.prototype.endFightRevives = function () {
  for (const t of this.revivable('party').sort((p, q) => (q.dpr || 0) - (p.dpr || 0))) {
    const standing = () => this.units.filter(o => o.reviver && this.alive(o) && !this.incap(o) && slotsFrom(o, o.reviver._spell.level) > 0).sort((p, q) => slotsFrom(q, q.reviver._spell.level) - slotsFrom(p, p.reviver._spell.level))[0];
    if (!standing()) this.wakeReviver();
    const c = standing();
    if (!c) continue;
    const L = this.slotFor(c, c.reviver._spell.level);
    c.slots[L - 1]--;
    t.dead = false; t.hp = 1; t.deathS = 0; t.deathF = 0; t.stable = false; t.revived = (t.revived || 0) + 1;
    this.boardChanged();
    this.ev('heal', `${c.name} → ${t.name}: ${c.reviver.name}${L > c.reviver._spell.level ? ' (L' + L + ')' : ''}, +1 HP, back from the dead`, { uid: c.uid, target: t.uid });
  }
};

/* ---- layer 3: pacing. What one use of a limited ability costs, in points of damage ---- */
Sim.prototype.v2Pool = function (u, a, L) {
  if (isHpPool(a)) return null;                                          // Lay on Hands: its points are priced where v2 picks them (v2HpPool)
  if (a._spell) return a._spell.level ? { key: 'slots', reset: u.slotReset === 'sr' ? 'sr' : 'lr', n: L || this.slotFor(u, a._spell.level), slots: true } : null;
  const ex = a.ext || {};
  if (ex.resource && u.resMax && u.resMax[ex.resource]) { const r = u.resMax[ex.resource]; return { key: 'res:' + ex.resource, reset: r.reset === 'sr' ? 'sr' : 'lr', n: ex.resourceCost || 1 }; }
  const k = freqKind(a.freq);
  if (k === 'sr' || k === 'lr' || k === '1/day') return { key: a.id, reset: k === 'sr' ? 'sr' : 'lr', n: 1 };
  return null;
};
/* { base, tax }: a use costs base points, and gives up `tax` of what it's worth once this fight has had its share of
   the pool (so it has to be clearly better than the free option to be spent) */
Sim.prototype.v2Pace = function (u, a, L) {
  const pl = this.v2Pool(u, a, L);
  if (!pl || pl.n < 0) return { base: 0, tax: 0 };
  const P = u.v2P.pacing;
  let F = u.team === 'party' ? this.leftFor(u) : 0;                      // a monster's day is this fight
  // slots kept for Revivify are out of the pool, and taking one costs what the ally is worth
  const res = pl.slots ? this.v2Reserve(u) : null, kept = res ? res.levels : 0, keep = res ? this.v2KeepCost(u, res, pl.n, F) : 0;
  if (pl.reset === 'sr') F = Math.min(F, typeof this.fightsBeforeRest === 'number' ? this.fightsBeforeRest : P.srFights);
  // spell slots are one pool counted in slot levels (plus what Arcane Recovery will win back); anything else, in uses
  const base = pl.slots ? P.slot * pl.n * (1 + P.slotUp * (pl.n - 1)) : Math.max(4, u.dpr) * P.costPerUse * pl.n;
  // no fight ahead: a slot is still worth its best use later in this one, when the fight should outlast them
  if (!F) return { base: keep + base * (pl.slots ? Math.min(0.5, Math.max(P.lastFight, (u._v2c ? u._v2c.rounds : 3) * 3 / Math.max(1, slotLevels(u) - kept))) : P.lastFight) * (this.losing(u) ? P.losing : 1), tax: 0 };
  let left, start;
  if (pl.slots) { const rec = this.v2Recovery(u) - kept; left = slotLevels(u) + rec; start = (u.v2Slots0 !== undefined ? u.v2Slots0 : slotLevels(u)) + rec; }
  else { left = u.uses.get(pl.key) || 0; start = u.v2Start && u.v2Start.has(pl.key) ? u.v2Start.get(pl.key) : left; }
  let c = base * F / (F + 1), tax = start - left + pl.n > start / (F + 1) + 1e-9 ? P.overTax : 0;   // this fight has had its share
  if (this.losing(u)) { c *= P.losing; tax *= P.losing; }
  else if (this.fightInHand(u)) { c *= P.easyFight; tax = Math.max(tax, pl.slots ? P.slotEasyTax : P.easyTax); }
  return { base: c + keep, tax };
};
Sim.prototype.v2PaceCost = function (u, a, val, L) {
  const p = this.v2Pace(u, a, L);
  return p.base + p.tax * Math.max(0, val || 0);
};
/* a limited damage-cutting reaction (Stone's Endurance): only on a hit that uses most of it, or that would drop it,
   and is worth the use (at-will ones like Uncanny Dodge keep the old rule: the first hit) */
Sim.prototype.v2ReactOk = function (u, r, dmg, src, info) {
  if (!this.v2Pool(u, r)) return this.reactCutNow(u, r, dmg, src, info);       // at will: this hit, or a bigger one still to come
  const P = u.v2P.pacing, mult = typeof r.buff.damageTakenMultiplier === 'number' ? r.buff.damageTakenMultiplier : 1, cut = avgDice(r.buff.damageReduction || 0);
  const after = Math.floor(Math.max(0, dmg * mult - cut)), drops = dmg >= u.hp && after < u.hp;
  const full = cut ? cut : dmg * (1 - mult);                                // what a use can save at best
  if (!drops && dmg - after < full * P.reactFull) return false;
  const saved = (dmg - after) * (drops ? P.reactDrop : 1);
  return saved > this.v2PaceCost(u, r, saved);
};

/* ---- what the turn looks like from where it stands: foes, danger, the fight's length, the posture ---- */
Sim.prototype.v2Danger = function (u, foes, myTeam) {
  const blindTo = this.kModeFor(u) !== 'open';
  const info = foes.filter(e => !this.incap(e) && e.hp > 0).map(e => {
    let dmg = 0, reach = 5, p = Math.min(0.95, Math.max(0.05, (21 + 5 - this.ac(u)) / 20));
    if (blindTo) { dmg = this.kDpr(u, e) * Math.min(1, Math.max(0.3, (21 + 5 - u.baseAC) / 20)) / 0.65; reach = this.kReach(u, e); }
    else for (const a of e.actions) {
      if (a.actionSlot !== 0 || a.type !== 'atk' || !this.usable(e, a) || (a.ext && a.ext.swallow)) continue;
      const d = this.expected(e, a, u);
      if (d > dmg) { dmg = d; reach = Math.max(5, a._range || 5); p = a.useSaves ? 1 : this.hitChance(e, u, a); }
    }
    const move = e.grappledBy || this.has(e, ['Restrained']) ? 0 : this.speedOf(e);
    const others = myTeam.filter(o => o !== u && this.dist(o, e) <= move + reach).length;
    const aura = e.actions.filter(a => (a.actionSlot === 5 || a.actionSlot === 6) && a.type === 'atk' && this.usable(e, a)).map(a => ({ r: Math.max(5, a._range || 10), d: this.expected(e, a, u) }));
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
    return { e, dmg, p, reach: move + reach, others, aura, zone };
  });
  const at = (x, y) => {
    let t = 0;
    for (const ti of info) {
      const d = this.distXY(x, y, ti.e);
      if (ti.zone) { if (ti.zone[x + y * this.W]) t += ti.dmg / (1 + ti.others); }
      else if (d <= ti.reach) t += ti.dmg / (1 + ti.others) * (this.T.any && !this.losB(ti.e.x, ti.e.y, ti.e.n, x, y, u.n) ? 0.4 : 1);
      for (const au of ti.aura) if (d <= au.r) t += au.d;
    }
    return t;
  };
  /* the enemy area attacks it knows of, priced in expected HP (docs/ai-v2.md, breath and cone spacing): for each, the chance it is ready on
     that enemy's next turn × the damage to one creature caught × what this square adds to our creatures caught, (2 (M1 − 1) + 1) / N:
     it picks a group of us in proportion to its size, M1 = u's group here, N = how many of us it can reach.
     Aims: a cone, line or adjacent cube from each square on the edge of the enemy's body × 8 directions; a sphere or set-down cube centred on
     one of us (or on the square itself) within its range + move; an emanation round its body. */
  const W = (u.v2P || AI_BASE).w, un = u.n || 1;
  const mine = myTeam.filter(o => o !== u && o.onBoard && !o.dead && o.hp > 0);
  const caughtBy = (spec, px, py, ax, ay) => { let c = 0; for (const o of mine) if (areaOnBody(spec, px, py, ax, ay, o.x, o.y, o.n || 1)) c++; return c; };
  const areas = [];
  for (const e of foes) if (!this.incap(e)) for (const ar of this.kAreasNext(u, e)) {
    const P = Math.min(1, ar.ready * W.areaUse), per = ar.dmg * W.areaSave;
    if (!(P * per > 0)) continue;
    const spec = { shape: ar.shape, size: ar.size, width: ar.width || 5, placed: !!ar.placed }, n = Math.max(1, Math.round(ar.size / 5)), en = e.n || 1;
    const A = { e, spec, P, per, aims: [], n, point: false, far: 0 };
    // it can move first: a group of us anywhere it can reach is one aim (allies within a cone's length less 5 ft, half a line's, a burst's
    // radius or an emanation's width, body to body)
    const mv = e.grappledBy || this.has(e, ['Restrained']) ? 0 : this.speedOf(e);
    A.grp = Math.max(1, Math.round((ar.shape === 'sphere' ? ar.size : ar.shape === 'emanation' ? ar.size * 2 + 5 * (en - 1) : ar.shape === 'cube' ? ar.size : ar.shape === 'cone' ? ar.size - 5 : ar.size / 2) / 5));
    A.reach = Math.round(((ar.shape === 'sphere' || ar.placed ? ar.range : 0) + mv + ar.size + 5) / 5);
    // how many of the others are within the group's reach of u's body on each square: one map per area, built the first time it is asked
    let gm = null;
    const grpOf = (x, y) => {
      if (!gm) {
        const Wd = this.W, Hd = this.H, g = A.grp;
        gm = new Uint8Array(Wd * Hd);
        for (const o of mine) {
          const on = o.n || 1;
          for (let yy = Math.max(0, o.y - g - un + 1); yy <= Math.min(Hd - 1, o.y + on - 1 + g); yy++) for (let xx = Math.max(0, o.x - g - un + 1); xx <= Math.min(Wd - 1, o.x + on - 1 + g); xx++) gm[xx + yy * Wd]++;
        }
      }
      return gm[x + y * this.W];
    };
    A.grpOf = grpOf;
    A.N = 1;                                                           // of us in its reach, u included (u is counted only where it stands in reach)
    for (const o of mine) if (this.gapTo(o.x, o.y, o.n || 1, e) <= A.reach) A.N++;
    if (ar.shape === 'cone' || ar.shape === 'line' || (ar.shape === 'cube' && !ar.placed)) {
      for (const [px, py] of en > 1 ? bodyEdge(e.x, e.y, en) : [[e.x, e.y]]) for (let k = 0; k < 8; k++) {
        const sx = Math.round(Math.cos(k * Math.PI / 4)), sy = Math.round(Math.sin(k * Math.PI / 4)), ax = px + sx * n, ay = py + sy * n;
        if (en > 1) { const off = offBody(spec, px, py, sx, sy, e.x, e.y, en); if (off === false || (off === null && areaOnBody(spec, px, py, ax, ay, e.x, e.y, en))) continue; }
        A.aims.push({ px, py, ax, ay, c: caughtBy(spec, px, py, ax, ay) });
      }
      A.far = (ar.size + 5) / 5;                                     // squares from its body beyond which no aim reaches
    } else if (ar.shape === 'emanation') {
      spec.bn = en;
      A.aims.push({ px: e.x, py: e.y, ax: e.x, ay: e.y, c: caughtBy(spec, e.x, e.y, e.x, e.y) });
      A.far = n + 1;
    } else {
      // a burst set down at a point: centred on one of us, within its range + the move to get there
      A.point = true; A.reachFt = ar.range + (e.grappledBy || this.has(e, ['Restrained']) ? 0 : this.speedOf(e));
      for (const o of mine) if (this.gapTo(o.x, o.y, 1, e) * 5 <= A.reachFt) A.aims.push({ px: o.x, py: o.y, ax: o.x, ay: o.y, c: caughtBy(spec, o.x, o.y, o.x, o.y) });
    }
    areas.push(A);
  }
  const spC = new Map();
  const spacing = (x, y) => {
    if (!areas.length) return 0;
    const key = x + y * this.W;
    let pen = spC.get(key);
    if (pen !== undefined) return pen;
    pen = 0;
    for (const A of areas) {
      if (this.gapTo(x, y, un, A.e) > A.reach) continue;
      let M1 = 1 + A.grpOf(x, y);
      for (const am of A.aims) if (am.c + 1 > M1 && areaOnBody(A.spec, am.px, am.py, am.ax, am.ay, x, y, un)) M1 = am.c + 1;
      if (A.point && this.gapTo(x, y, 1, A.e) * 5 <= A.reachFt) M1 = Math.max(M1, 1 + caughtBy(A.spec, x, y, x, y));
      // it picks a group of us in proportion to its size (N of us in reach): what u adds to our expected creatures caught, (M1² − (M1 − 1)²) / N
      pen += A.P * A.per * (2 * (M1 - 1) + 1) / A.N;
    }
    spC.set(key, pen);
    return pen;
  };
  const adjC = new Map(), hitC = new Map();
  const oaFoes = foes.filter(e => e.reaction && !e.noOA && !this.incap(e) && this.meleeReach(e) > 0);
  // the same test as adjacentEnemies, on the few foes close enough to matter
  const adjAt = (x, y) => {
    const k = x + y * this.W;
    let l = adjC.get(k);
    if (!l) {
      const zm = (this.T.anyH ? this.T.h[k] : 0) + (u.alt || 0);
      l = oaFoes.filter(e => { const r = this.meleeReach(e); const g = this.gapTo(x, y, u.n, e); return g * 5 <= r && Math.max(g, Math.abs(this.zOf(e) - zm)) * 5 <= r && this.losB(e.x, e.y, e.n, x, y, u.n); });
      adjC.set(k, l);
    }
    return l;
  };
  const oaHit = e => {
    let v = hitC.get(e);
    if (v === undefined) {
      const a = e.actions.find(o => o.type === 'atk' && !o.useSaves && o.actionSlot === 0 && o._range <= 10 && !(o.ext && o.ext.swallow));
      v = !a ? 0 : blindTo ? this.kDpr(u, e) * 0.4 : this.expected(e, Object.assign({}, a, { targets: 1 }), u);
      hitC.set(e, v);
    }
    return v;
  };
  const oa = path => {
    if (!path.length) return 0;
    let cost = 0, cx = u.x, cy = u.y;
    const used = new Set();
    for (const st of path) {
      for (const e of adjAt(cx, cy)) {
        if (used.has(e) || this.distXY(st.x, st.y, e) <= this.meleeReach(e)) continue;
        cost += oaHit(e); used.add(e);
      }
      cx = st.x; cy = st.y;
    }
    return cost;
  };
  // a flyer changing height beside a foe leaves its reach too (settleAltitude); z = the height it goes to, over the ground there
  const altOa = (x, y, z) => {
    let cost = 0;
    const zm = (this.T.anyH ? this.T.h[x + y * this.W] : 0) + z;
    for (const e of adjAt(x, y)) if (Math.max(this.gapTo(x, y, u.n, e), Math.abs(this.zOf(e) - zm)) * 5 > this.meleeReach(e)) cost += oaHit(e);
    return cost;
  };
  return { info, at, spacing, oa, altOa };
};
Sim.prototype.v2Ctx = function (u, speed) {
  const key = this.turnSeq + ':' + (this.posVer || 0) + ':' + speed + ':' + u.hp + ':' + u.buffs.length + ':' + this.units.reduce((t, o) => t + (o.hp > 0 ? 1 : 0), 0);
  if (u._v2c && u._v2c.key === key) return u._v2c;
  const foes = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e));
  const pol = u.v2P.finishDowned;
  const downed = pol === 'never' ? [] : this.enemiesOf(u).filter(e => e.onBoard && !e.dead && e.hp <= 0 && e.isPC && (pol === 'always' || e.downs >= 2));
  const myTeam = this.alliesOf(u).filter(o => o.onBoard && this.alive(o));
  const danger = this.v2Danger(u, foes, myTeam);
  const myDpr = myTeam.reduce((t, o) => t + (o.dpr || 0), 0) * 0.6;
  const rounds = Math.max(1, Math.min(8, foes.reduce((t, e) => t + this.kHp(u, e), 0) / Math.max(1, myDpr)));
  const proj = foes.reduce((t, e) => t + this.kDpr(u, e), 0) * 0.6 / Math.max(1, myTeam.length);
  // its main attack against the nearest foe: hits per round, for buffs that add damage per hit
  const near = foes.slice().sort((p, q) => this.dist(u, p) - this.dist(u, q))[0];
  let main = null;
  for (const a of u.actions) if (a.actionSlot === 0 && a.type === 'atk' && !a.useSaves && this.usable(u, a) && near) {
    const e = this.expected(u, a, near);
    if (!main || e > main.e) main = { a, e, p: this.hitChance(u, near, a), n: a.targets || 1, melee: (a._range || 5) <= 10 };
  }
  const ctx = { key, speed, foes, pool: foes.concat(downed), myTeam, danger, rounds, incoming: Math.max(danger.at(u.x, u.y), proj), main,
                focusDpr: Math.max(4, myDpr * 1.5 / Math.max(1, foes.length)), press: new Map() };
  ctx.posture = this.v2Posture(u, ctx, speed);
  u._v2c = ctx;
  return ctx;
};
/* ---- layer 1: posture ---- */
Sim.prototype.v2Posture = function (u, ctx, speed) {
  const P = u.v2P.posture, hp = Math.max(0, u.hp) / u.maxHp;
  // falling back only helps with someone to patch it up, or a way to keep fighting from range faster than they close
  if (hp <= P.retreatHp && speed > 0 && ctx.danger.at(u.x, u.y) >= u.hp * P.retreatDanger) {
    const healer = ctx.myTeam.some(o => o !== u && !this.incap(o) && o.actions.some(a => a.type === 'heal' && a.target !== 'self' && a._range !== 0 && this.usable(o, a)));
    const kite = u.actions.some(a => a.actionSlot === 0 && a.type === 'atk' && (a._range || 5) > 15 && this.usable(u, a)) &&
      ctx.foes.every(e => this.meleeReach(e) === 0 || this.speedOf(e) < speed);
    if (healer || kite) return { kind: 'retreat', kite: !healer };
  }
  const heal = u.actions.find(a => (a.actionSlot === 0 || a.actionSlot === 1) && a.type === 'heal' && (a.target === 'self' || a._range === 0) && this.usable(u, a) && this.condOk(u, a) && this.healNeeded(u, a, u));
  if (hp <= P.recoverHp && heal) return { kind: 'recover', heal };
  const atks = u.actions.filter(a => a.actionSlot === 0 && a.type === 'atk' && this.usable(u, a) && this.condOk(u, a));
  const inReach = t => atks.filter(a => this.dist(u, t) - Math.max(5, a._range || 5) <= speed);
  const near = ctx.foes.filter(t => inReach(t).length);
  if (!near.length) return { kind: 'advance' };
  // someone in the face of our back line (a caster's dagger doesn't make it a bodyguard)
  if (this.hasMelee(u) && !this.backLine(u)) {
    let best = null, bv = 0, ally = null;
    for (const o of ctx.myTeam) {
      if (o === u || (this.hasMelee(o) && !this.backLine(o) && o.hp >= o.maxHp * P.protectAllyHp)) continue;
      for (const e of this.adjacentEnemies(o, o.x, o.y)) if (near.includes(e) && this.kDpr(u, e) > bv) { bv = this.kDpr(u, e); best = e; ally = o; }
    }
    if (best) return { kind: 'protect', t: best, ally };
  }
  // their healers and casters, then whatever it can drop this turn, then the softest target
  const pickBy = list => { let o = null, ov = 0; for (const t of list) { const v = (this.kDpr(u, t) + 1) / Math.max(1, this.kHp(u, t)); if (v > ov) { ov = v; o = t; } } return o; };
  const key = pickBy(near.filter(t => this.kCaster(u, t) || this.kHeals(u, t)));
  if (key) return { kind: 'focus', t: key };
  let fin = null;
  for (const t of near) {
    const e = Math.max(...inReach(t).map(a => this.expected(u, a, t)));
    if (e >= this.kHp(u, t) * P.finishAt && (!fin || this.kDpr(u, t) > this.kDpr(u, fin))) fin = t;
  }
  if (fin) return { kind: 'finish', t: fin };
  const avgMax = ctx.foes.reduce((t, e) => t + this.kMax(u, e), 0) / Math.max(1, ctx.foes.length);
  const soft = pickBy(near.filter(t => ctx.foes.length > 1 && this.kMax(u, t) <= avgMax * P.squishyHp));
  if (soft) return { kind: 'focus', t: soft };
  return { kind: 'engage' };
};

/* ---- layer 2: what one use of an action on one target is worth (where it stands is scored separately) ---- */
Sim.prototype.v2PoolFor = function (u, a, ctx) {
  if (a.target === 'self' || a._range === 0) return (this.alreadyHas(a, u) || !this.healNeeded(u, a, u)) ? [] : [u];
  // heals and buffs on its own side: who could use it (never a full-HP ally; a downed one for a heal)
  if (a.type === 'heal') return this.alliesOf(u).filter(o => o.onBoard && !o.dead && ((a.ext && a.ext.aid) || o.hp < o.maxHp) && (a.condition !== 'ally at 0 HP' || o.hp <= 0) && this.healNeeded(u, a, o));
  if (a.type === 'buff') return this.alliesOf(u).filter(o => o.onBoard && this.alive(o) && !this.alreadyHas(a, o) && !o.buffs.some(b => b.id === a.id && b.src === u.uid));
  if (a.type !== 'atk' && a.type !== 'debuff') return [];
  let p = (a.type === 'atk' ? ctx.pool : ctx.foes).filter(e => !this.alreadyHas(a, e));
  if (a.ext && a.ext.swallow) { const mx = sizeIdx(a.ext.swallow.maxSize, 2); p = p.filter(t => t.grappledBy === u.uid && sizeIdx(t.size, 2) <= mx); }
  const types = a.ext && Array.isArray(a.ext.targetTypes) && a.ext.targetTypes.length ? a.ext.targetTypes.map(x => String(x).toLowerCase()) : null;
  if (types) p = p.filter(t => types.includes(String(t.isPC ? 'humanoid' : (t.tpl.type || '')).toLowerCase()));
  return p;
};
Sim.prototype.v2AdvGain = function (u, a, t) {
  const e0 = this.expected(u, a, t);
  u.buffs.push({ id: '__v2adv', data: { condition: 'Attacks with Advantage' } });
  let e1;
  try { e1 = this.expected(u, a, t); } finally { u.buffs = u.buffs.filter(b => b.id !== '__v2adv'); }
  // advantage also unlocks Sneak Attack when no ally stands next to the target
  if (u.sneak && a.ext && a.ext.sneak && u.saSeq !== this.turnSeq && !this.featureAdv(u, t) && !this.alliesOf(u).some(o => o !== u && o.onBoard && this.alive(o) && this.dist(o, t) <= 5))
    e1 += avgDice(u.sneak.dice) * 0.6 * this.hitChance(u, t, a) * this.kMult(u, a, t);
  return Math.max(0, e1 - e0);
};
Sim.prototype.v2SelfValue = function (u, a, ctx, plan) {
  const W = u.v2P.w;
  if (a.type === 'heal') {
    if (!this.healNeeded(u, a, u)) return -Infinity;
    if (isHpPool(a)) return this.v2HpPool(u, a, u, ctx);
    const amt = avgDice(a.amount);
    if (a.tempHP) {
      // Armor of Agathys: cold damage back at whoever hits it while the temporary HP last
      const back = a.ext && a.ext.retaliate ? a.ext.retaliate.dmg * 0.6 * ctx.foes.filter(e => this.meleeReach(e) > 0 && this.dist(e, u) <= 15).length : 0;
      return Math.max(0, amt - (u.temp || 0)) * 0.7 + back;
    }
    let v = Math.min(amt, u.maxHp - Math.max(0, u.hp)) * (u.hp < u.maxHp * 0.5 ? 1.1 : 0.4);
    if (ctx.posture.kind === 'recover' || ctx.posture.kind === 'retreat') v += W.recover;
    return v;
  }
  if (a.type === 'buff' && a.ext && a.ext.coin) return u.buffs.some(b => b.id === a.id + ':coin') ? -Infinity : this.v2CoinValue(u, a, ctx, plan);
  if (a.type !== 'buff' || isHideAction(a) || this.alreadyHas(a, u) || u.buffs.some(b => b.id === a.id && b.src === u.uid)) return -Infinity;
  if (u.buffs.some(b => b.id !== a.id && effectName(b.name) === effectName(a.name))) return -Infinity;     // the same effect doesn't stack
  // what it adds over the rounds it lasts
  const b = a.buff || {}, R = b.duration === 'entire encounter' ? ctx.rounds : 1;
  const m = ctx.main, hits = m ? m.n * m.p : 0, inc = ctx.incoming;
  let v = 0;
  if (b.damage !== undefined && b.damage !== '') v += avgDice(b.damage) * (b.duration === 'until next attack made' ? (m ? m.p : 0) : hits * R);
  if (b.toHit !== undefined && b.toHit !== '') v += avgDice(b.toHit) * 0.05 * (m ? m.e / Math.max(0.05, m.p) : 0) * R;
  if (typeof b.damageMultiplier === 'number') v += Math.max(0, b.damageMultiplier - 1) * (m ? m.e : 0) * R;
  if (b.condition === 'Attacks with Advantage' && m) v += this.v2AdvGain(u, m.a, ctx.foes[0] || u) * R;
  if (a.ext && a.ext.resist) v += inc * 0.5 * 0.8 * R;                              // Rage: physical damage halved
  if (b.ac !== undefined && b.ac !== '') v += avgDice(b.ac) * 0.05 * inc * 1.5 * R;
  if (typeof b.damageTakenMultiplier === 'number') v += Math.max(0, 1 - b.damageTakenMultiplier) * inc * R;
  if (b.damageReduction !== undefined) v += Math.min(inc, avgDice(b.damageReduction)) * 0.5 * R;
  if (b.condition === 'Is attacked with Disadvantage' || b.condition === 'Invisible') v += inc * 0.4 * R;
  if (!v && !b.condition && !b.damage && !b.toHit) v = this.effectValue(b, u, false, u);
  return v;
};
/* a coin flip as a bonus action (Double Down, ext.coin): the next attack roll of the main attack, p of one outcome and 1 - p of the other, in damage —
   advantage or disadvantage changes the chance that roll hits (p to 1 - (1 - p)^2, or to p^2) on a hit worth its damage; an outcome's hitDmg lands with it */
Sim.prototype.v2CoinValue = function (u, a, ctx, plan) {
  const c = a.ext.coin;
  let m = ctx.main;
  // the action it has planned: only an attack roll feels a coin (a breath or a save-based spell does not), and the roll is that attack's against its target
  if (plan && plan.a) {
    const t = plan.p && plan.p.targets && plan.p.targets[0];
    if (plan.a.type !== 'atk' || plan.a.useSaves || !t || t === u) return 0;
    m = { e: this.expected(u, plan.a, t), p: this.hitChance(u, t, plan.a), n: plan.a.targets || 1 };
  }
  if (!m) return 0;
  const ph = typeof c.p === 'number' ? c.p : 0.5, p = m.p, dmg = m.e / Math.max(0.05, m.n * Math.max(0.05, p));
  const side = o => {
    if (!o) return 0;
    const cond = o.buff && o.buff.condition, pr = cond === 'Attacks with Advantage' ? 1 - (1 - p) * (1 - p) : cond === 'Attacks with Disadvantage' ? p * p : p;
    return dmg * (pr - p) + (o.hitDmg ? avgDice(o.hitDmg) * pr : 0);
  };
  return (ph * side(c.heads) + (1 - ph) * side(c.tails)) * u.v2P.coin.weight;
};
/* ---- Divine Smite on a hit (docs/ai-v2.md "Hybrids"): what it is worth, when it is cast, what keeping the bonus action for it is worth ---- */
// the smite u could add to a's hits: its spell (a slot free, this turn's slot unused), a melee weapon attack
Sim.prototype.v2SmiteReady = function (u, a) {
  const s = u.smiteA;
  return s && a && a.type === 'atk' && !a._spell && !a.useSaves && (a._range || 5) <= 10 && this.usable(u, s) ? s : null;
};
// the best level to smite t at, net of the slot: left = what t has after this hit as u's side reckons it, f = the swings still to come on it
Sim.prototype.v2SmiteBest = function (u, s, t, crit, left, f) {
  const W = u.v2P.w, sd = smiteOf(s), tDpr = this.kDpr(u, t), mult = this.kMult(u, { type: 'atk', _spell: s._spell, ext: { damageType: sd.type } }, t);
  const pk = x => 1 / (1 + Math.exp(-5 * (x - left) / Math.max(4, x)));
  let best = null;
  for (const L of this.v2CastLevels(u, s)) {
    const d = avgDice(smiteDice(sd, s, L, t)) * (crit ? 2 : 1) * mult, kill = Math.max(0, pk(d + f) - pk(f));
    const v = (Math.min(d, Math.max(0, left + W.overkill)) * (1 + tDpr / W.dprScale) * W.damage + kill * (tDpr * W.killRounds + 5) * W.kill) * W.smite;
    const net = v - this.v2PaceCost(u, s, v, L);
    if (!best || net > best.v) best = { L, v: net, kill };
  }
  return best;
};
// a smite on the first of k swings still to hit t (left: t's HP before them): the chance one hits × the best smite then, crit or not
Sim.prototype.v2SmiteLater = function (u, s, a, t, left, k) {
  const p = this.hitChance(u, t, a), per = this.expected(u, a, t) / Math.max(1, a.targets || 1), onHit = per / Math.max(0.05, p);
  const c = Math.min(1, (21 - (u.critOn || 20)) / 20 / Math.max(0.05, p));
  const at = crit => { const b = this.v2SmiteBest(u, s, t, crit, left - onHit, Math.max(0, k - 1) * per); return b ? Math.max(0, b.v) : 0; };
  return (1 - Math.pow(1 - p, k)) * ((1 - c) * at(false) + (c > 0 ? c * at(true) : 0));
};
// keeping this turn's bonus action for a smite on a's hits on t
Sim.prototype.v2SmiteHold = function (u, a, t) {
  const s = t && t !== u && t.hp > 0 ? this.v2SmiteReady(u, a) : null;
  return s ? this.v2SmiteLater(u, s, a, t, this.kHp(u, t), a.targets || 1) : 0;
};
// a hit has landed (rawW: its dice): smite now, at which level? Spends the slot and returns the extra dice, or null
Sim.prototype.v2SmiteHit = function (u, a, t, crit, rawW) {
  if (!u.v2 || u.smiteSeq !== this.turnSeq || this.current !== u || t.hp <= 0 || t.dead) return null;
  const s = this.v2SmiteReady(u, a);
  if (!s) return null;
  const k = this._strikesLeft || 0, per = k ? this.expected(u, a, t) / Math.max(1, a.targets || 1) : 0;
  const left = this.kHp(u, t) - rawW * this.kMult(u, a, t);
  const now = this.v2SmiteBest(u, s, t, crit, left, k * per);
  if (!now || now.v <= 0) return null;
  // one smite a turn: a later hit that kills or crits may be the better one
  if (k > 0 && this.v2SmiteLater(u, s, a, t, left, k) * u.v2P.w.smiteWait > now.v) return null;
  u.castAt = now.L; this.spend(u, s); u.castAt = 0; u.smoteSeq = this.turnSeq;
  u.smiteSeq = 0;
  const sd = smiteOf(s), L = u.castLevel || now.L, dice = smiteDice(sd, s, L, t);
  if (this.record) this.ev('intent', `${u.name} smites${now.kill >= 0.5 ? ' to finish ' + t.name : crit ? ' on the critical hit' : ''}`, { uid: u.uid });
  return { raw: rollDice(dice, this.R, crit), type: sd.type, tag: ` + ${s.name}${L > s._spell.level ? ' (L' + L + ')' : ''}` };
};
/* bare: only what it does to t (damage, kill, control), for the extra creatures an area catches */
Sim.prototype.v2Value = function (u, a, t, ctx, bare) {
  const W = u.v2P.w;
  if (t === u || a.type === 'heal' || a.type === 'buff') return { val: t === u ? this.v2SelfValue(u, a, ctx) : this.v2AllyValue(u, a, t, ctx), why: '', pKill: 0 };
  if (t.hp <= 0) {
    // a downed PC: each hit is a failed death save (two up close)
    const hits = a.useSaves ? 1 : (a.targets || 1), p = a.useSaves ? 1 : this.hitChance(u, t, a);
    const pKill = Math.min(1, hits * p * (a.useSaves ? 1 : 2) / Math.max(1, 3 - t.deathF));
    const healers = this.alliesOf(t).filter(o => o !== t && this.alive(o) && this.kHeals(u, o)).length;
    return { val: pKill * (10 + this.kDpr(u, t)) * (healers ? 1.4 : 0.8) * W.kill, why: 'execute', pKill };
  }
  // a burn (ext.dot) deals nothing now: what counts is the tick, on the foe's turns
  const dot = a.ext && a.ext.dot, exp = this.expected(u, dot ? Object.assign({}, a, { dpr: a.ext.dotAt || dot.dice, ext: Object.assign({}, a.ext, { wtDpr: null }) }) : a, t), tHp = this.kHp(u, t), tDpr = this.kDprW(u, t);
  let val, why = '', pKill = 0;
  if (a.type === 'debuff') { val = this.v2Control(u, a, t, ctx, false, bare); if (bare) return { val, why: '', pKill: 0 }; }
  else {
    const ticks = dot ? Math.min(W.dotMax, Math.max(W.dotMin, ctx.rounds - W.dotLag)) * W.concKeep : 1;
    val = Math.min(exp * ticks, tHp + W.overkill) * (1 + tDpr / W.dprScale) * W.damage * (dot ? W.dot : 1);
    pKill = dot ? 0 : 1 / (1 + Math.exp(-5 * (exp - tHp) / Math.max(4, exp)));
    val += pKill * (tDpr * W.killRounds + 5) * W.kill;
    if (pKill >= 0.5) why = 'finish';
    // Extra Attack: what's left after it drops goes to the next one in reach
    if (!a.useSaves && (a.targets || 1) > 1 && exp > tHp && ctx.foes.some(o => o !== t && this.dist(o, t) <= Math.max(10, a._range || 5))) val += (exp - tHp) * W.spill;
    // riders: Stunning Strike, Sap… worth the effect, times the chance it lands, unless the hits drop it anyway
    const re = a.riderEffect;
    if (re && re.buff && !t.buffs.some(b => b.id === a.id && b.src === u.uid)) {
      const rab = a.ext && (a.ext.riderSave || a.ext.saveAbility);
      const pFail = re.dc >= 99 ? 1 : 1 - Math.min(1, Math.max(0, (21 + this.kSave(u, t, rab) - re.dc) / 20));
      const pLand = a.useSaves ? 1 - Math.min(1, Math.max(0, (21 + this.kSave(u, t, a.ext && a.ext.saveAbility) - avgDice(a.toHit)) / 20))
                               : 1 - Math.pow(1 - this.hitChance(u, t, a) * pFail, a.targets || 1);
      val += pLand * (this.effectValue(re.buff, t, true, u) * W.ctlRound + this.v2Expose(u, t, re.buff.condition, ctx)) * (1 - pKill) * W.control;
    }
    const oh = a.ext && a.ext.onHit;
    if (oh && oh.push && this.meleeReach(t) > 0 && this.meleeReach(t) < oh.push + 5 && ctx.myTeam.some(o => o !== u && this.dist(o, t) <= this.meleeReach(t)))
      val += this.kDpr(u, t) * 0.5 * (1 - pKill) * W.control;
    // break its concentration
    if (t.concentrating && exp < tHp) {
      const held = this.concValue(u, t);
      if (held > 0) {
        const con = this.kSave(u, t, 'con'), hits = a.useSaves ? 1 : (a.targets || 1), p = a.useSaves ? 1 : this.hitChance(u, t, a);
        const perHit = exp / Math.max(0.05, hits * p);
        const pf = Math.min(0.95, Math.max(0.05, (Math.max(10, Math.floor(perHit / 2)) - con - 1) / 20));
        val += held * (1 - Math.pow(1 - p * pf, hits)) * W.conc;
        why = why || 'concentration';
      }
    }
    // Spiritual Weapon, Starry Form: the strike it conjures keeps coming each round
    const gb = a.ext && a.ext.grantsBuff;
    if (gb && !u.buffs.some(b => b.id === gb.id)) {
      const f = u.actions.find(o => o.ext && o.ext.requiresBuff === gb.id && o.type === 'atk');
      if (f) val += Math.min(this.expected(u, f, t), tHp + W.overkill) * Math.max(0, ctx.rounds - 1) * W.concKeep;
    }
    // a damage zone (Spirit Guardians, Moonbeam…) hurts again each round the foe stays in it
    const zd = a.useSaves && a.ext && a.ext.zone && a.ext.zone.dmg;
    if (zd && exp < tHp + W.overkill) {
      const n = Math.max(0, Math.min(a.ext.hold || 10, ctx.rounds) - 1) * Math.min(1, W.zoneStay + (a.ext.zone.follow ? W.zoneFollow : 0)) * W.concKeep;
      val += Math.min(exp * n, Math.max(0, tHp - exp) + W.overkill) * (1 + tDpr / W.dprScale) * W.damage;
    }
    if (bare) {
      // what an area adds on a creature besides its target: no targeting bonuses, but don't wake what we put to sleep
      if (t.buffs.some(b => b.endsOnDamage) && this.incap(t) && pKill < 0.5) val -= 6 + tDpr * 1.5;
      return { val, why: '', pKill };
    }
  }
  const allyOn = ctx.myTeam.filter(o => o !== u && this.dist(o, t) <= 5).length;
  val += allyOn * W.focus + (1 - this.kFrac(u, t)) * W.wounded;
  // a foe in the face of our back line (casters, archers, the badly hurt) is worth more to a front-liner
  if (this.hasMelee(u)) {
    const back = ctx.myTeam.filter(o => o !== u && this.dist(o, t) <= Math.max(5, this.meleeReach(t)) && (this.backLine(o) || !this.hasMelee(o) || o.hp < o.maxHp * u.v2P.posture.protectAllyHp)).length;
    if (back) { val += back * W.guard; why = why || 'guard'; }
  }
  if (this.kHeals(u, t)) { val += W.healer; why = why || 'healer'; }
  if (this.kCaster(u, t)) { val += W.caster; why = why || 'caster'; }
  // leave alone what our side has talked or laughed out of the fight, unless this finishes it
  const lulled = o => o.buffs.some(b => b.endsOnDamage) && this.incap(o);
  if (lulled(t) && ctx.foes.some(o => o !== t && !lulled(o)) && pKill < 0.5) { val = val * 0.1 - 6 - tDpr; why = ''; }
  if (a.type === 'atk' && exp < tHp && t.buffs.some(b => b.saveOnDamage && this.byId[b.src] && this.byId[b.src].team === u.team)) { val *= 0.25; why = ''; }
  if (!why) {
    const top = Math.max(0, ...ctx.foes.map(o => this.kDpr(u, o)));
    if (ctx.foes.length > 1 && tDpr >= top && tDpr > 0) why = 'threat';
    else if (allyOn) why = 'focus';
  }
  return { val, why, pKill };
};

/* a heal or buff on an ally (its own side: real numbers) */
Sim.prototype.v2AllyValue = function (u, a, t, ctx) {
  const W = u.v2P.w;
  if (a.type === 'heal') {
    if (isHpPool(a)) return this.v2HpPool(u, a, t, ctx);                            // Lay on Hands: it picks the points, priced in
    const amt = avgDice(a.amount), hx = a.ext || {};
    if (t.hp <= 0) return this.v2BackUp(u, a, t, ctx, amt);
    if (hx.aid) return amt * 0.6 * W.heal;
    if (a.tempHP) return Math.max(0, amt - (t.temp || 0)) * 0.7 * W.heal;
    const got = Math.min(amt, Math.max(0, t.maxHp - t.hp));
    let v = got * W.heal * (t.hp < t.maxHp / 2 ? W.healLow : 0.5);
    const inc = this.v2Pressure(u, t, ctx);
    if (inc >= t.hp && inc < t.hp + got) v += W.healDanger * (6 + (t.dpr || 0));          // it keeps it standing
    return v;
  }
  if (a.type === 'buff') {
    const b = a.buff || {}, conc = a._spell && a._spell.conc;
    const R = b.duration === 'entire encounter' ? Math.min(ctx.rounds, W.buffRounds) * (conc ? W.concKeep : 1) : (DUR_WEIGHT[b.duration] || 1);
    return this.effectValue(Object.assign({}, b, { duration: '1 round' }), t, false, u) * R * W.buff;
  }
  return 0;
};
/* Lay on Hands (docs/ai-v2.md "Hybrids"): how many of the pool's points to put into t (1, enough to stand through next round's damage,
   all it is missing), each valued as any heal (a downed ally through v2BackUp) less the points' price; the pick is kept for doActionInner */
Sim.prototype.v2HpPool = function (u, a, t, ctx) {
  const W = u.v2P.w, P = u.v2P.pacing, left = u.uses.get(a.id) || 0, cap = Math.min(left, a.ext.pool.maxPer || left);
  const down = t.hp <= 0, miss = down ? t.maxHp : Math.max(0, t.maxHp - t.hp);
  if (cap < 1 || !miss) return 0;
  if (!u._poolPick) u._poolPick = new Map();
  const inc = this.v2Pressure(u, t, ctx), F = u.team === 'party' ? this.leftFor(u) : 0, hp0 = Math.max(0, t.hp);
  // a point is priced like a slot level's worth of healing (pacing.hpLevel points to a level); with no fight ahead, like a slot's best use later in this one
  const per = P.slot / P.hpLevel * (F ? 1 : Math.min(0.5, Math.max(P.lastFight, (ctx.rounds || 3) * 3 / Math.max(1, left / P.hpLevel))));
  const start = u.v2Start && u.v2Start.has(a.id) ? u.v2Start.get(a.id) : left;
  // standing again: through v2BackUp up to what keeps it up next round; past that (or for a standing ally) each point is an ordinary heal
  const need = Math.max(1, Math.ceil(inc) + 1), plain = (from, k) => {
    const under = Math.max(0, Math.min(k, Math.ceil(t.maxHp / 2) - from));
    let v = (under * W.healLow + (k - under) * 0.5) * W.heal;
    if (inc >= from && inc < from + k) v += W.healDanger * (6 + (t.dpr || 0));
    return v;
  };
  let best = -Infinity, pick = 0;
  for (const n of new Set([1, need, Math.ceil(t.maxHp / 2) - hp0, miss].map(k => Math.min(cap, miss, Math.max(1, Math.round(k)))))) {
    let v;
    if (down) { const up = Math.min(n, need); v = this.v2BackUp(u, a, t, ctx, up) + (n > up ? plain(up, n - up) : 0); }
    else v = plain(hp0, n);
    let c, tax = 0;
    if (!F) c = per * n * (this.losing(u) ? P.losing : 1);
    else {
      c = per * n * F / (F + 1);
      if (start - left + n > start / (F + 1) + 1e-9) tax = P.overTax;       // this fight has had its share of the pool
      if (this.losing(u)) { c *= P.losing; tax *= P.losing; }
      else if (this.fightInHand(u)) { c *= P.easyFight; tax = Math.max(tax, P.easyTax); }
    }
    const net = v - c - tax * Math.max(0, v);
    if (net > best) { best = net; pick = n; }
  }
  u._poolPick.set(a.id + '|' + t.uid, pick);
  return best;
};
/* the chance a creature at 0 HP dies within `rounds` turns, from s successes and f failures; hit2: the chance a round an attack lands two failures on it */
function deathOdds(s, f, rounds, hit2, stable) {
  const walk = (ds, df, r) => {
    if (df >= 3) return 1;
    if (r <= 0 || (ds >= 3 && !hit2)) return 0;
    const atk = hit2 ? hit2 * walk(ds, df + 2, r - 1) : 0, rest = (1 - hit2);
    if (ds >= 3) return atk + rest * walk(ds, df, r - 1);                                   // stable: only an attack can kill it
    return atk + rest * (0.4 * walk(ds, df + 1, r - 1) + 0.05 * walk(ds, df + 2, r - 1) + 0.5 * walk(ds + 1, df, r - 1));   // the other 5%: a natural 20, back up
  };
  return walk(stable ? 3 : s, f, Math.min(6, Math.ceil(rounds)));
}
/* one round of t on our side: its damage on the same scale as any attack's (× how dangerous the foes are), or a healer's round */
Sim.prototype.v2RoundWorth = function (u, t, ctx) {
  const W = u.v2P.w;
  const heals = t.actions.some(o => o.type === 'heal' && o.target !== 'self' && o._range !== 0 && (o.actionSlot === 0 || o.actionSlot === 1) && this.usable(t, o));
  const threat = 1 + ctx.foes.reduce((s, e) => s + this.kDpr(u, e), 0) / Math.max(1, ctx.foes.length) / W.dprScale;
  return Math.max((t.dpr || 0) * threat, heals ? W.backHealer : 0);
};
/* how likely d, the expected damage of the attacks a move draws, is to drop u: nothing until one attack can take a real share of what it has */
Sim.prototype.v2DropChance = function (u, d) {
  const W = u.v2P.w, p = (d * W.dropEdge / Math.max(1, u.hp) - W.dropFrom) / (1 - W.dropFrom);
  return p > 0 ? Math.min(1, p) : 0;
};
/* what u loses by going down: its turns, a life, and the ally it would have brought back */
Sim.prototype.v2OwnWorth = function (u, ctx) {
  const W = u.v2P.w, res = this.v2Reserve(u);
  return this.v2RoundWorth(u, u, ctx) * Math.min(ctx.rounds, W.dropRounds) * W.dropRound + W.dropLife + (res ? this.v2KeepWorth(u, res) : 0);
};
/* a downed ally back up (docs/ai-v2.md, step 2.12): its turns for the rest of the fight, cut short by the foes around it, plus the
   death it avoids, less the chance it drops again and pays for it anyway */
Sim.prototype.v2BackUp = function (u, a, t, ctx, amt) {
  const W = u.v2P.w, hp = Math.max(1, Math.min(t.maxHp, amt));
  const adj = ctx.foes.filter(e => !this.incap(e) && this.dist(e, t) <= this.meleeReach(e));
  const hit = Math.max(this.v2Pressure(u, t, ctx), adj.reduce((s, e) => s + this.kDpr(u, e), 0) * 0.6 * W.backFocus);
  const turns = Math.min(ctx.rounds, W.backFirst + hp / Math.max(1, hit)), pDrop = Math.min(1, hit / hp);
  // the blow past its HP is one nobody else takes
  const round = this.v2RoundWorth(u, t, ctx), soak = Math.max(0, hit - hp) * W.backSoak;
  const life = W.backLife * (1 + W.backDay * (t.team === 'party' ? this.leftFor(u) : 0));
  const saved = deathOdds(t.deathS || 0, t.deathF || 0, ctx.rounds, Math.min(1, W.backFinish * adj.length), t.stable) - pDrop * deathOdds(0, 0, ctx.rounds, Math.min(1, W.backFinish2 * adj.length));
  // dying before our next turn: a dead PC needs Revivify or worse, not a Healing Word
  const left = t.team === 'party' ? this.leftFor(u) : 0, dead = round * (ctx.rounds + W.deathDay * left * W.deathFightRounds) * W.backRound + W.deathLife;
  const now = deathOdds(t.deathS || 0, t.deathF || 0, 1, Math.min(1, W.backFinish * adj.length), t.stable);
  return round * turns * W.backRound + soak + life * Math.max(0, saved) + W.deathNow * now * dead;
};
/* damage heading for ally o next round, as u's side reckons it */
Sim.prototype.v2Pressure = function (u, o, ctx) {
  let p = ctx.press.get(o.uid);
  if (p !== undefined) return p;
  p = 0;
  for (const e of ctx.foes) {
    if (this.incap(e)) continue;
    let reach = this.kReach(u, e);
    if (reach === null) reach = e.actions.reduce((m, x) => x.actionSlot === 0 && (x.type === 'atk' || x.type === 'debuff') ? Math.max(m, x._range || 5) : m, 5);
    const r = this.speedOf(e) + reach;
    if (this.dist(e, o) > r) continue;
    const near = ctx.myTeam.filter(m => this.dist(e, m) <= r).length;
    p += this.kDpr(u, e) * 0.6 / Math.max(1, near);
  }
  ctx.press.set(o.uid, p);
  return p;
};
/* what one round of condition c on foe t adds to our side's damage, in damage points: for each ally that can reach it next
   round, its best action attack with the condition minus without (advantage unless it already has it; melee hits crit when
   EXPOSE says so), summed, × t's threat like any damage. Capped at the condition's share of what t has left (gain over
   gain + the plain damage): when our plain hits drop it anyway, hitting harder adds little. 0 for conditions that change nothing */
const EXPOSE = { Paralyzed: 2, Unconscious: 2, Stunned: 1, Petrified: 1, Restrained: 1, Blinded: 1 };   // 1: attacks against it have advantage; 2: and hits from within 5 ft crit
Sim.prototype.v2Expose = function (u, t, c, ctx) {
  const kind = EXPOSE[c];
  if (!kind || !ctx) return 0;
  const key = t.uid + ':' + kind, ce = ctx.expose = ctx.expose || new Map();
  if (ce.has(key)) return ce.get(key);
  const W = u.v2P.w, tc = this.conds(t), hasAdv = ADV_TARGET.some(x => tc.has(x));
  let g = 0, plain = 0;
  for (const o of ctx.myTeam) {
    if (this.incap(o)) continue;
    let best = 0, e0 = 0;
    for (const a of o.actions) {
      if (a.actionSlot !== 0 || a.type !== 'atk' || a.useSaves || areaSpec(a) || !this.usable(o, a)) continue;
      const rng = Math.max(5, a._range || 5);
      if (this.dist(o, t) > this.speedOf(o) + rng) continue;
      const e = this.expected(o, a, t), p = this.hitChance(o, t, a);
      if (!(e > 0) || !(p > 0)) continue;
      const pa = hasAdv || ADV_SELF.some(x => this.conds(o).has(x)) || this.featureAdv(o, t) ? p : Math.max(p, 1 - (1 - p) * (1 - p));
      const crit = kind === 2 && rng <= 10 ? W.critDmg : 1;
      const gain = e * (pa * crit / p - 1);
      if (gain > best) { best = gain; e0 = e; }
    }
    g += best; plain += e0;
  }
  const tHp = this.kHp(u, t), v = (g > 0 ? Math.min(g, tHp * g / (g + plain)) : 0) * (1 + this.kDpr(u, t) / W.dprScale) * W.damage * W.expose;
  ce.set(key, v);
  return v;
};
/* a debuff or control spell on foe t: one round's worth × the chance it lands × the rounds it should last. bare: t is one
   of several it catches, so our side's extra damage (v2Expose, one target per attack) is already counted on the first */
Sim.prototype.v2Control = function (u, a, t, ctx, noLR, bare) {
  const W = u.v2P.w, b = a.buff || {};
  let per = this.expected(u, Object.assign({}, a, { buff: Object.assign({}, b, { duration: '1 round' }) }), t) * W.ctlRound;
  // and our side hits it harder while it lasts (advantage, crits up close), if it fails the save
  const ex = bare ? 0 : this.v2Expose(u, t, b.condition, ctx);
  if (ex > 0) { const dc = avgDice(a.saveDC); per += ex * (areaSpec(a) ? 1 : this.throughChance(u, t)) * (dc >= 99 ? 1 : 1 - Math.min(1, Math.max(0, (21 + this.kSave(u, t, a.ext && a.ext.saveAbility) - dc) / 20))); }
  // it already has that condition (another caster's Hold Person, a pattern): nothing new
  if (b.condition && (t.buffs.some(x => x.data && x.data.condition === b.condition) || (INCAP.includes(b.condition) && this.incap(t)))) per *= 0.1;
  // a disabling effect on something that buys off failed saves (Legendary Resistance) mostly burns a use: worth the
  // progress toward emptying it when the plan says burn and this is the cheap effect it picked for u, else a little
  if (b.condition && this.kImmune(u, t, b.condition)) return 0;           // it can't be given that condition at all
  if (!noLR && DANGER_CONDS.includes(b.condition)) {
    const L = this.kLegRes(u, t);
    if (L > 0) {
      const bp = this.v2Burn(u, ctx), mine = bp && bp.on && bp.t === t ? bp.burners.get(u.uid) : null;
      if (mine && mine.a.id === a.id) {
        const ab = a.ext && a.ext.saveAbility, dc = avgDice(a.saveDC);
        const pFail = dc >= 99 ? 1 : 1 - Math.min(1, Math.max(0, (21 + this.kSave(u, t, ab) - dc) / 20));
        return pFail * bp.perLR * u.v2P.burn.value;
      }
      per *= W.legRes / L;                                                // it lands nothing while uses remain: this cast strips one of the L
    }
  }
  if (a.ext && a.ext.saveOnDamage) per *= W.shakeOff;
  const R = ctx.rounds;
  let r = 1;
  if (b.duration === 'repeat the save each round') {
    const dc = avgDice(a.saveDC), s = dc >= 99 ? 0 : Math.min(1, Math.max(0, (21 + this.kSave(u, t, a.ext && a.ext.saveAbility) - dc) / 20));
    r = s > 0.001 ? (1 - Math.pow(1 - s, R)) / s : R;
  } else if (b.duration === 'entire encounter') r = R * (a.ext && a.ext.endsOnDamage ? W.lull : 1);
  r = Math.min(r, this.kHp(u, t) / ctx.focusDpr + 0.5);                    // it may well drop before then
  if (a._spell && a._spell.conc) r *= W.concKeep;
  return per * Math.max(0.5, r) * W.control;
};
/* ---- Legendary Resistance: burn it or race the boss's HP (docs/ai-v2.md) ---- */
// how a condition changes the fight while the boss has it: the share of its damage that still comes, our damage × boost
const BURN_COND = { Paralyzed: [0, 1.4], Unconscious: [0, 1.4], Stunned: [0, 1.2], Petrified: [0, 1.2], Incapacitated: [0, 1],
  Restrained: [0.6, 1.2], Blinded: [0.6, 1.2], Frightened: [0.7, 1], 'Attacks and saves with Disadvantage': [0.7, 1] };
/* the plan for u's side, once a turn: { on, t, burners: Map(uid → { a, pFail, price, alt }), perLR, … } or null when nobody has LR left */
Sim.prototype.v2Burn = function (u, ctx) {
  if (ctx.burn !== undefined) return ctx.burn;
  const cache = this._burnC = this._burnC || {}, c = cache[u.team];
  if (c && c.seq === this.turnSeq) return (ctx.burn = c.plan);
  const plan = u.v2P.burn && u.v2P.burn.modes.indexOf(this.kMode(u.team)) >= 0 ? this.v2BurnPlan(u, ctx, false) : null;
  if (plan && !plan.on && u.v2P.burn.probeBias > 0 && this.kMode(u.team) === 'learn') this.v2Probe(u, ctx, plan);
  cache[u.team] = { seq: this.turnSeq, plan };
  if (plan) this.v2BurnSay(u, plan);
  return (ctx.burn = plan);
};
Sim.prototype.v2BurnPlan = function (u, ctx, doubt) {
  const B = u.v2P.burn, W = u.v2P.w;
  let boss = null, L0 = 0;
  for (const e of ctx.foes) { const l = this.kLegRes(u, e); if (l > 0 && (!boss || this.kHp(u, e) > this.kHp(u, boss))) { boss = e; L0 = l; } }
  if (!boss) return null;
  // what it deals the party a round: its damage (kDpr counts one target; an area attack catches more of us), and in open
  // mode what it has actually dealt so far this fight
  const spread = this.kAreas(u, boss).length ? 1 + 0.75 * Math.min(2, ctx.myTeam.length - 1) : 1, est = this.kDpr(u, boss) * B.share * spread;
  const H = Math.max(1, this.kBossHp(u, boss)), R = Math.max(1, Math.min(8, ctx.rounds));
  let D = est;
  if (this.kMode(u.team) !== 'blind') {                                       // it has watched what the boss does to the party (learn: and this kind earlier today)
    const k = this.kMode(u.team) === 'learn' ? this.kind(u.team, boss) : null;
    D = ((boss.dmgDealt || 0) + (k ? k.dealt : 0) + est * 1.5) / ((boss.fightTurns || 0) + (k ? k.turns : 0) + 1.5);
  }
  // each ally's damage per round against it: its best at-will attack, or 0.7 × a slot spell
  let total = 0;
  const dmg = new Map();
  for (const o of ctx.myTeam) {
    let best = 0;
    for (const a of o.actions) {
      if (a.actionSlot !== 0 || a.type !== 'atk' || !this.usable(o, a) || !this.condOk(o, a)) continue;
      const lv = this.v2CastLevels(o, a);
      if (!lv.length) continue;
      best = Math.max(best, this.expected(o, castCopy(a, lv[0]), boss) * (lv[0] > 0 ? 0.7 : 1));
    }
    dmg.set(o.uid, best * B.eff); total += best * B.eff;
  }
  const altOf = o => dmg.get(o.uid) * (1 + this.kDpr(u, boss) / W.dprScale) * W.damage;
  // damage taken is bounded by what the party has: past a few times its HP it is a lost fight, however long it takes
  const pool = Math.max(1, ctx.myTeam.reduce((t, o) => t + Math.max(0, o.hp), 0)) * B.cap, sat = x => pool * (1 - Math.exp(-x / pool));
  const costRace = sat(H / Math.max(1, total) * D);
  // every disabling save-effect a caster of ours could throw at it: its chance to fail the save, its price, its value once LR is gone
  const cands = [], learnMode = this.kMode(u.team) === 'learn';
  for (const o of ctx.myTeam) {
    if (!o.v2 || this.incap(o) || !o.hasSpells) continue;
    for (const a of o.actions) {
      if (a.actionSlot !== 0 || a.type !== 'debuff' || !a.buff || !DANGER_CONDS.includes(a.buff.condition) || (a.ext && a.ext.teleport) || !this.usable(o, a) || !this.condOk(o, a)) continue;
      const lv = this.v2CastLevels(o, a);
      if (!lv.length) continue;
      const act = castCopy(a, lv[0]), ab = a.ext && a.ext.saveAbility, dc = avgDice(a.saveDC);
      if (!this.v2PoolFor(o, act, ctx).includes(boss)) continue;                // Hold Person on a dragon: not a legal target
      // learn mode with no save of that ability seen yet: give the doubt to the cast (a probe), so the first one finds out
      const unseen = learnMode && !(this.kind(u.team, boss).saves[ab || 'any'] || []).length, guess = unseen && (doubt || !B.probeBias) ? B.probe : 0;
      const pass = dc >= 99 ? 0 : Math.min(1, Math.max(0, (21 + this.kSave(u, boss, ab) - guess - dc) / 20));
      const alt = altOf(o), pFail = 1 - pass;
      const pace = this.v2Pace(o, a, lv[0]);
      cands.push({ o, a, ab: ab || 'any', unseen, pFail, pass, alt, price: pace.base + pace.tax * (alt + pFail * costRace / L0), L: lv[0], fv: this.v2Control(o, act, boss, ctx, true), conc: !!(a._spell && a._spell.conc) });
    }
  }
  const plan = { on: false, t: boss, L0, burners: new Map(), perLR: 0, costRace, costBurn: 0, fu: null, rounds: 0 };
  // the follow-up: the effect worth the most once LR is gone
  let fu = null;
  for (const c of cands) if (!fu || c.fv > fu.fv + 1e-6 || (Math.abs(c.fv - fu.fv) <= 1e-6 && c.price > fu.price)) fu = c;
  if (!fu || fu.pFail < B.minFollow || !(fu.fv > 0)) return plan;
  plan.fu = fu;
  // burners: the cheapest effective effect of each caster not holding something worth more, cheapest caster first
  const picks = [];
  for (const o of ctx.myTeam) {
    let best = null;
    for (const c of cands) if (c.o === o && c !== fu && c.pFail >= B.minFail && (!best || c.price < best.price || (c.price === best.price && c.pFail > best.pFail))) best = c;
    if (!best) continue;
    if (o.concentrating && best.conc && this.v2Holding(o, this.v2Ctx(o, this.speedOf(o))) > B.hold) continue;
    picks.push(best);
  }
  picks.sort((p, q) => p.price - q.price || q.pFail - p.pFail);
  let sum = 0;
  const chosen = [];
  for (const c of picks) { if (sum >= L0) break; chosen.push(c); sum += c.pFail; }
  if (!chosen.length) return plan;
  // the burn: Rb rounds with the burners casting, one round for the follow-up, then the race
  const Rb = Math.max(1, L0 / sum), lost = chosen.reduce((t, c) => t + dmg.get(c.o.uid), 0);
  const M = Math.max(0.01, total - lost);
  let taken, slots = 0;
  const rem1 = H - M * Rb;
  if (rem1 <= 0) taken = sat(H / M * D);                                      // it drops before the LR is gone
  else {
    const fuDmg = dmg.get(fu.o.uid), rem2 = rem1 - Math.max(0.01, total - fuDmg);
    const b = fu.a.buff, cond = (BURN_COND[b.condition] || [0.7, 1]).slice();
    let dur = R;
    if (b.duration === 'repeat the save each round') dur = fu.pass > 0.001 ? (1 - Math.pow(1 - fu.pass, R)) / fu.pass : R;
    if (fu.conc) dur *= W.concKeep;
    if (fu.a.ext && fu.a.ext.endsOnDamage) { dur *= W.lull; cond[1] = 1; }
    let land = 0, miss = 0;
    if (rem2 <= 0) { land = miss = 0; }
    else {
      const d = Math.min(dur, rem2 / Math.max(1, total * cond[1])), rem3 = Math.max(0, rem2 - d * total * cond[1]);
      land = d * D * cond[0] + rem3 / Math.max(1, total) * D;
      miss = rem2 / Math.max(1, total) * D;
    }
    taken = sat(D * Rb + D + fu.pFail * land + (1 - fu.pFail) * miss);
    plan.rounds = Rb + 1;
    slots += fu.price;
  }
  for (const c of chosen) slots += c.price * Rb;
  plan.costBurn = taken;
  plan.swing = costRace * B.bias - taken - B.slotW * slots - B.margin;
  plan.chosen = chosen;
  plan.cands = cands;
  plan.on = costRace * B.bias > taken + B.slotW * slots + B.margin;
  if (plan.on) {
    plan.perLR = Math.max(0, costRace * B.bias - taken - B.margin) / L0;     // what each use burned is worth: what the whole burn saves, shared out
    for (const c of chosen) plan.burners.set(c.o.uid, { a: c.a, pFail: c.pFail, price: c.price });
  }
  return plan;
};
/* learn mode, plan says race: would it say burn if the saves nobody has tried yet were weak? Then a cheap effect aimed at
   each such save is worth its information: the chance it is weak × what burning would then save (docs/ai-v2.md) */
Sim.prototype.v2Probe = function (u, ctx, plan) {
  const B = u.v2P.burn, hyp = this.v2BurnPlan(u, ctx, true);
  // the estimates of its HP and damage are priors: a burn that looks a little worse than racing may be better once seen
  const swing = hyp && hyp.cands ? hyp.swing + B.probeSlack * hyp.costRace : 0;
  if (!(swing > 0)) return;
  const need = new Set(hyp.chosen.map(c => c.ab));
  if (hyp.fu) need.add(hyp.fu.ab);
  const cheapest = new Map();                                              // each untried save: its cheapest effect
  for (const c of hyp.cands) {
    if (!c.unseen || !need.has(c.ab) || !(c.pFail > 0)) continue;
    if (c.o.concentrating && c.conc && this.v2Holding(c.o, this.v2Ctx(c.o, this.speedOf(c.o))) > B.hold) continue;
    const b = cheapest.get(c.ab);
    if (!b || c.price < b.price || (c.price === b.price && c.pFail > b.pFail)) cheapest.set(c.ab, c);
  }
  const voi = B.probeP * swing * B.probeBias, picks = Array.from(cheapest.values()).sort((p, q) => p.price - q.price || q.pFail - p.pFail);
  const probers = new Map();
  for (const c of picks) {
    if (probers.size >= B.probeMax) break;
    if (voi > c.price && !probers.has(c.o.uid)) probers.set(c.o.uid, { a: c.a, ab: c.ab, voi, price: c.price });
  }
  if (probers.size) { plan.probers = probers; plan.voi = voi; }
};
// one intent line when the plan is first made for a boss, and again when it flips
Sim.prototype.v2BurnSay = function (u, plan) {
  if (!this.record) return;
  const said = this._burnSaid = this._burnSaid || {}, key = u.team + '|' + plan.t.uid;
  const now = plan.on ? 'burn' : 'race';
  if (said[key] === now) return;
  said[key] = now;
  this.ev('intent', plan.on ? `${u.name} wants the party to burn ${plan.t.name}'s resistances first (${plan.L0} left)` : `${u.name} reckons the party should race ${plan.t.name}'s HP`, { uid: u.uid, target: plan.t.uid });
};
/* what u's running concentration is still worth: the effects it holds on both sides × the rounds they have left, its fog */
Sim.prototype.v2Holding = function (u, ctx) {
  const id = u.concentrating;
  if (!id) return 0;
  if (ctx.holdId === id) return ctx.holding;
  const W = u.v2P.w, R = ctx.rounds;
  let v = 0, exp = 0;                 // our side's extra damage counts once, on the held foe where it is worth most
  for (const o of this.units) {
    if (!o.onBoard || o.dead || o.hp <= 0) continue;
    for (const b of o.buffs) {
      if (b.src !== u.uid || b.id !== id) continue;
      if (b.dot) {
        const a = u.actions.find(x => x.id === id), tick = avgDice(b.dot) * (a ? this.kMult(u, a, o) : 1);
        v += Math.min(tick * Math.min(W.dotMax, Math.max(W.dotMin, R - W.dotLag)) * W.concKeep, this.kHp(u, o) + W.overkill) * (1 + this.kDpr(u, o) / W.dprScale) * W.damage * W.dot * W.dotHold;
      }
      const one = Object.assign({}, b.data, { duration: '1 round' });
      if (o.team === u.team) { v += this.effectValue(one, o, false, u) * W.buff * R; continue; }
      let r = R;
      if (b.expiry === 'repeat the save each round' && typeof b.dc === 'number' && b.dc < 99) {
        const s = Math.min(1, Math.max(0, (21 + this.kSave(u, o, b.saveAbility) - b.dc) / 20));
        r = s > 0.001 ? (1 - Math.pow(1 - s, R)) / s : R;
      }
      if (b.endsOnDamage) r *= W.lull;
      const rr = Math.min(r, this.kHp(u, o) / ctx.focusDpr + 0.5) * W.control;
      v += this.effectValue(one, o, true, u) * W.ctlRound * rr;
      exp = Math.max(exp, this.v2Expose(u, o, b.data && b.data.condition, ctx) * rr);
    }
  }
  for (const z of this.zones || []) {
    if (z.src !== u.uid || z.id !== id) continue;
    if (z.rough) v += W.zone;
    if (z.fog) for (const e of ctx.foes) if (z.cells.has(e.x + e.y * this.W)) v += this.kDpr(u, e) * 0.5;
    if (z.dmg) for (const e of ctx.foes) if (this.coversIn(this.zoneCells(z), e)) v += Math.min(this.expected(u, z.act, e), this.kHp(u, e)) * (1 + this.kDpr(u, e) / W.dprScale) * W.damage * Math.min(1, W.zoneStay + (z.follow ? W.zoneFollow : 0)) * R;
  }
  v += exp;
  ctx.holdId = id; ctx.holding = v;
  return v;
};
/* friendly fire: what catching these allies costs, more for the ones that matter */
Sim.prototype.v2FF = function (u, a, friends) {
  const W = u.v2P.w;
  let p = 0;
  for (const f of friends) p += this.friendPenalty(u, a, [f]) * (f === u ? 1 : 1 + (f.dpr || 0) / W.dprScale);
  return p * W.ffValue;
};

Object.assign(ENG, { isReckless, castCopy, deathOdds });
})(typeof window !== 'undefined' ? window : globalThis);
