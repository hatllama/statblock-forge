/* TACTICAL ENGINE, part 10: the AI v2 turn (file list and how the parts share names: js/engine/base.js).
   v2TurnInner (squares × options), intent lines (v2Words), re-aiming after the move (v2Aim, v2Act), bonus actions,
   Reckless Attack, Action Surge. */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { avgDice, DANGER_CONDS, smiteOf, Sim, areaSpec, isHideAction, isReckless, castCopy } = ENG;

/* ---- the turn: every square it could end on × every way to spend it ---- */
Sim.prototype.v2Turn = function (u, speed, bonusSpent, onlyAct) {
  const prevF = this._flyer; this._flyer = u.fly && this.airborne(u) ? u : null;
  try { return this.v2TurnInner(u, speed, bonusSpent, onlyAct); } finally { this._flyer = prevF; }
};
Sim.prototype.v2TurnInner = function (u, speed, bonusSpent, onlyAct) {
  const ctx = this.v2Ctx(u, speed);
  if (!ctx.foes.length) return null;
  if (u.reviver && this.record && !onlyAct) { const res = this.v2Reserve(u); if (res && u.saidKeep !== res.t.uid) { u.saidKeep = res.t.uid; this.ev('intent', `${u.name} keeps a slot for ${res.t.name}'s Revivify`, { uid: u.uid }); } }
  const W = u.v2P.w, Wd = this.W, post = ctx.posture, caster = this.backLine(u), spells = !!u.hasSpells;
  const hpFrac = Math.max(0, u.hp / u.maxHp), meleeSelf = this.hasMelee(u) && !caster;
  let safety = (meleeSelf ? W.risk : W.riskRanged * (caster ? W.casterRisk : 1)) * (1 + W.hurt * (1 - hpFrac)), offMult = 1;
  if (post.kind === 'retreat') { safety *= W.retreatSafety; if (!post.kite) offMult = W.retreatOffense; }
  // a boss alone (docs/ai-v2.md "Boss tier"): self-care only pays while someone else holds the line
  const B = u.v2P.boss, share = B.solo !== 1 || B.soloOa !== 1 ? this.bossShare(u, ctx) : 1;
  if (B.solo !== 1) safety *= B.solo + (1 - B.solo) * share;
  const Woa = B.soloOa !== 1 ? W.oa * (B.soloOa + (1 - B.soloOa) * share) : W.oa;
  // what an opportunity attack costs: its damage, and the chance it drops it (docs/ai-v2.md)
  let ownWorth = null;
  const dropCost = d => { const p = this.v2DropChance(u, d); if (!p) return 0; if (ownWorth === null) ownWorth = this.v2OwnWorth(u, ctx); return p * ownWorth; };
  const zHere = (x, y) => this.T.anyH ? this.T.h[x + y * this.W] : 0;
  // it can't lose more than it has: past that, more incoming damage only means going down (a bit worse than its HP)
  const hpCap = Math.max(1, u.hp) * W.downCap;
  const threat = (x, y) => Math.min(ctx.danger.at(x, y), hpCap);
  const aiPlan = u.tpl.ext && u.tpl.ext.aiPlan, planT = aiPlan && aiPlan.target ? t => this.bossPlanTarget(u, t) : null;
  const postBonus = t => (post.t !== t ? 0 : W.pick * (post.kind === 'protect' ? 1 + W.protect * this.kDpr(u, t) / 5 : post.kind === 'finish' ? 1 + W.finishBoost : 1)) + (planT ? planT(t) : 0);
  // what it's concentrating on: a new concentration spell gives it up, and every hit taken risks it
  const holding = spells ? this.v2Holding(u, ctx) : 0;

  // every action-slot option, each spell at every slot level worth weighing
  const plans = [];
  for (const a of u.actions) {
    if (a.actionSlot !== 0 || (a.ext && a.ext.teleport) || !this.usable(u, a) || !this.condOk(u, a)) continue;
    const pool = this.v2PoolFor(u, a, ctx);
    if (!pool.length) continue;
    const sp = areaSpec(a), self = a.target === 'self' || a._range === 0;
    for (const L of this.v2CastLevels(u, a)) {
      const act = castCopy(a, L);
      const pl = { a, act, castL: L, slot: L > 0, pool, range: Math.max(5, a._range || 5), self, ally: !self && (a.type === 'heal' || a.type === 'buff'), n: act.targets || 1,
                   area: !!sp, sphere: !!sp && sp.shape === 'sphere', fog: !!(a.ext && a.ext.zone && a.ext.zone.fog), fogC: new Map(),
                   pace: this.v2Pace(u, a, L), conc: a._spell && a._spell.conc && u.concentrating && !this.sustaining(u, a) ? W.concSwap * holding : 0,
                   vals: new Map(), bare: null, multi: new Map() };
      for (const t of pool) pl.vals.set(t.uid, this.v2Value(u, act, t, ctx));
      if (pl.self && !(pl.vals.get(u.uid).val > 0)) continue;
      if (pl.area && !pl.fog) { pl.bare = new Map(); for (const t of pool) pl.bare.set(t.uid, this.v2Value(u, act, t, ctx, true).val); }
      // several targets with one save (no template): the others near the first
      if (!sp && !pl.ally && (act.useSaves || act.type === 'debuff') && pl.n > 1) for (const t of pool) {
        const ex = pool.filter(o => o !== t && o.hp > 0 && this.dist(o, t) <= ((a.ext && a.ext.pairWithin) || 10)).map(o => act.type === 'debuff' ? this.v2Control(u, act, o, ctx, false, true) : pl.vals.get(o.uid).val).sort((p, q) => q - p).slice(0, pl.n - 1);
        pl.multi.set(t.uid, ex.reduce((s, v) => s + Math.max(0, v), 0));
      }
      plans.push(pl);
    }
  }
  // a boss's recharge price and authored hints (docs/ai-v2.md "Boss tier"): added to what the option spends
  if (B.recharge || aiPlan) for (const pl of plans) { const d = this.bossAdj(u, pl.a, ctx), dt = this.bossPlan(u, pl.a); if (d || dt) pl.pace = { base: pl.pace.base + d, tax: pl.pace.tax + dt }; }
  // a burner (docs/ai-v2.md, Legendary Resistance): the cheap effect the plan picked for it is worth what it gives up, the best
  // other option, plus its progress toward emptying LR (the plan already weighed the cost of burning against racing)
  const burn = u.hasSpells ? this.v2Burn(u, ctx) : null, mine = burn && burn.on ? burn.burners.get(u.uid) : null, probe = burn && !burn.on && burn.probers ? burn.probers.get(u.uid) : null;
  if (probe) {
    let give = 0;
    for (const pl of plans) if (pl.a.id !== probe.a.id) for (const t of pl.pool) { const v = pl.vals.get(t.uid).val; give = Math.max(give, v - pl.pace.base - pl.pace.tax * Math.max(0, v) - pl.conc); }
    for (const pl of plans) {
      const cell = pl.a.id === probe.a.id && pl.pool.includes(burn.t) ? pl.vals.get(burn.t.uid) : null;
      if (cell) cell.val = Math.max(cell.val, (give + probe.voi + pl.pace.base + pl.conc) / (1 - Math.min(0.9, pl.pace.tax)));
    }
  }
  if (mine) {
    let give = 0;
    for (const pl of plans) if (pl.a.id !== mine.a.id) for (const t of pl.pool) { const v = pl.vals.get(t.uid).val; give = Math.max(give, v - pl.pace.base - pl.pace.tax * Math.max(0, v) - pl.conc); }
    for (const pl of plans) {
      const cell = pl.a.id === mine.a.id && pl.pool.includes(burn.t) ? pl.vals.get(burn.t.uid) : null;
      if (cell) cell.val = Math.max(cell.val, (give + cell.val + pl.pace.base + pl.conc) / (1 - Math.min(0.9, pl.pace.tax)));
    }
  }
  // plain options first: an area aim is skipped where even its best case can't beat what a square already offers
  plans.sort((p, q) => (p.area && !p.fog ? 1 : 0) - (q.area && !q.fog ? 1 : 0));
  const atk = plans.filter(pl => !pl.self && !pl.ally);
  const boundOf = (pl, t) => {
    if (!pl.bound) { const sp = areaSpec(pl.act); pl.bound = new Map(); pl.reach = sp ? sp.size * 2 : 0; }
    let b = pl.bound.get(t.uid);
    if (b === undefined) {
      b = Math.max(0, pl.vals.get(t.uid).val) + W.zone;
      for (const o of pl.pool) if (o !== t && o.hp > 0 && this.dist(o, t) <= pl.reach) b += Math.max(0, pl.bare.get(o.uid)) * W.area;
      pl.bound.set(t.uid, b);
    }
    return b;
  };
  const net = (pl, v) => v - pl.pace.base - pl.pace.tax * Math.max(0, v) - pl.conc;
  // bonus options (Flurry, Martial Arts, a slot-1 Action Surge; Healing Word, Spiritual Weapon, Hex…): what it could add
  // from a square. One spell slot a turn: an action that takes a slot only pairs with a bonus option that doesn't.
  const bonusOpts = [];
  if (!bonusSpent) for (const a of u.actions) {
    if (a.actionSlot !== 1 || (a.ext && a.ext.teleport) || isHideAction(a) || smiteOf(a) || !this.usable(u, a) || !this.condOk(u, a)) continue;
    const off = a.type === 'atk' || a.type === 'debuff', self = a.target === 'self' || a._range === 0;
    const ally = !off && !self && (a.type === 'heal' || a.type === 'buff');
    if (!off && !ally && !(self && a._spell)) continue;
    const L = this.v2CastLevels(u, a)[0];
    if (L === undefined) continue;
    const act = castCopy(a, L), b = { a, slot: L > 0, range: Math.max(5, a._range || 5), n: ally ? act.targets || 1 : 1, pace: this.v2Pace(u, a, L), self, conc: a._spell && a._spell.conc && u.concentrating && !this.sustaining(u, a) ? W.concSwap * holding : 0 };
    if (self) { if (!this.v2PoolFor(u, act, ctx).length) continue; b.raw = this.v2SelfValue(u, act, ctx); if (!(b.raw > 0)) continue; }
    else { b.vals = this.v2PoolFor(u, act, ctx).map(t => ({ t, v: ally ? this.v2AllyValue(u, act, t, ctx) : this.v2Value(u, act, t, ctx).val })).filter(o => o.v > 0); if (!b.vals.length) continue; }
    bonusOpts.push(b);
  }

  const taken = this.takenFor(u);
  const consider = (budget, fn) => {
    const rm = this.reachMap(u, speed > 0 ? budget : 0);
    for (let i = 0; i < rm.dist.length; i++) if (rm.dist[i] >= 0 && !taken[i]) fn(i % Wd, (i / Wd) | 0, rm, rm.dist[i]);
  };
  // how far a square is from being able to use its main action
  const reachOf = new Map();
  for (const pl of atk) for (const t of pl.pool) if (t.hp > 0) reachOf.set(t, Math.max(reachOf.get(t) || 0, pl.range));
  if (!reachOf.size) for (const t of ctx.foes) reachOf.set(t, 5);
  const needs = Array.from(reachOf);
  const need = (x, y) => {
    let best = Infinity;
    for (const [t, r] of needs) { const d = this.distXY(x, y, t) - r; if (d < best) best = d; }
    return best === Infinity ? 0 : Math.max(0, best);
  };
  const need0 = need(u.x, u.y);
  // closing in is worth the offense it brings a turn nearer: a full move of progress ≈ W.progress × its best hit
  let offense = 4;
  for (const pl of atk) for (const t of pl.pool) if (t.hp > 0) offense = Math.max(offense, net(pl, pl.vals.get(t.uid).val));
  const progUnit = offense * W.progress / Math.max(5, speed || this.speedOf(u) || 30);
  const meleeFoes = ctx.foes.filter(e => !this.incap(e) && this.meleeReach(e) > 0);
  const engaged = this.adjacentEnemies(u, u.x, u.y).some(e => e.reaction);
  const bonusDis = engaged && !bonusSpent && this.canBonusDisengage(u);
  // a path can brush past a foe on the way: count the opportunity attacks whenever one could reach it
  const oaNear = meleeFoes.some(e => e.reaction && !e.noOA && this.dist(u, e) <= speed * 2 + this.meleeReach(e) + 5);
  const canAim = u.steadyAim && !bonusSpent && !u.movedThisTurn;
  // a healer keeps within reach of the badly hurt
  let healR = 0;
  if (caster) for (const a of u.actions) if ((a.actionSlot === 0 || a.actionSlot === 1) && a.type === 'heal' && a.target !== 'self' && a._range !== 0 && this.usable(u, a)) healR = Math.max(healR, a._range || 5);
  const hurt = healR ? this.alliesOf(u).filter(o => o !== u && o.onBoard && !o.dead && o.hp < o.maxHp * 0.5) : [];
  const reachPen = (x, y) => { let n = 0; for (const o of hurt) if (this.distXY(x, y, o) > healR) n++; return n * W.healReach; };
  // concentration: each hit is a Con save (DC 10 for most hits)
  const pfConc = holding ? Math.min(0.95, Math.max(0.05, (10 - (u.conSave || 0) - 1 - u.buffs.reduce((t, b) => t + (b.concBonus || 0), 0)) / 20)) : 0;
  const concR = th => holding && th > 0 ? holding * (1 - Math.pow(1 - pfConc, th / 8)) * W.concRisk : 0;
  // hiding: which squares nobody can see, and how far each square is from one
  const hideA = this.T.any && !bonusSpent && !bonusDis ? u.actions.find(a => isHideAction(a) && a.actionSlot === 1 && this.usable(u, a) && this.condOk(u, a)) : null;
  const spSteps = Math.floor(speed / 5);
  let distH = null;
  if (hideA && speed > 0) {
    const N = Wd * this.H, q = [];
    distH = new Int16Array(N).fill(-1);
    for (let i = 0; i < N; i++) if (!this.T.wall[i] && !taken[i] && this.concealedAt(u, i % Wd, (i / Wd) | 0)) { distH[i] = 0; q.push(i); }
    for (let k = 0; k < q.length; k++) {
      const c = q[k], cx = c % Wd, cy = (c / Wd) | 0;
      if (distH[c] >= spSteps) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= Wd || ny >= this.H) continue;
        const n = nx + ny * Wd; if (distH[n] >= 0 || this.T.wall[n]) continue;
        distH[n] = distH[c] + 1; q.push(n);
      }
    }
  }

  // the best way to spend the action from (x, y); noSlot: the bonus action already took this turn's spell slot
  const acShared = new Map();
  let slotRaw = 0;
  const touchPl = pl => pl.range <= 10 && (pl.ally || (pl.a.type === 'atk' && !pl.a.useSaves) || pl.a.type === 'debuff');
  const offAt = (x, y, noSlot, noTouch) => {
    const seen = new Map(), dC = new Map();
    const dOf = t => { let d = dC.get(t); if (d === undefined) { d = this.distXY(x, y, t); dC.set(t, d); } return d; };
    const sees = t => { let v = seen.get(t); if (v === undefined) { v = this.canSee(x, y, t); seen.set(t, v); } return v; };
    const engagedHere = meleeFoes.some(e => dOf(e) <= this.meleeReach(e));
    let best = null;
    for (const pl of plans) {
      if (noSlot && pl.slot) continue;
      if (noTouch && !pl.self && touchPl(pl)) continue;
      if (pl.self) { const raw = pl.vals.get(u.uid).val * offMult, v = net(pl, raw); if (!best || v > best.val) best = { pl, t: u, val: v, raw, why: '' }; continue; }
      if (pl.ally) {
        // heals and buffs: the best targets in reach from here (a multi-target spell sums them)
        let tops = null;
        for (const t of pl.pool) { if (dOf(t) > pl.range || !sees(t)) continue; const v = pl.vals.get(t.uid).val; if (v > 0) (tops = tops || []).push({ t, v }); }
        if (!tops) continue;
        tops.sort((p, q) => q.v - p.v);
        const raw = tops.slice(0, pl.n).reduce((s, o) => s + o.v, 0), v = net(pl, raw);
        if (pl.slot && raw > slotRaw) slotRaw = raw;
        if (!best || v > best.val) best = { pl, t: tops[0].t, val: v, raw, why: '', count: Math.min(pl.n, tops.length) };
        continue;
      }
      for (const t of pl.pool) {
        if (dOf(t) > pl.range || !sees(t)) continue;
        const b = pl.vals.get(t.uid);
        let v = b.val, why = b.why, caught = 1, ff = 0;
        if (pl.fog) {
          // Fog Cloud: the damage it stops ranged foes from dealing (hardly depends on where it's cast from)
          let fv = pl.fogC.get(t.uid);
          if (fv === undefined) { fv = this.targetValue(u, pl.act, t, pl.pool, x, y).val; pl.fogC.set(t.uid, fv); }
          if (!(fv > 0)) continue;
          v = fv; why = 'fog';
        } else if (pl.area) {
          if (best && net(pl, boundOf(pl, t) * offMult + postBonus(t)) <= best.val) continue;
          const key = pl.a.id + '|' + t.uid;
          let ac = pl.sphere ? acShared.get(key) : null;
          if (ac && Math.max(Math.abs(ac.ax - x), Math.abs(ac.ay - y)) * 5 > pl.range) ac = null;
          if (!ac) {
            ac = this.areaCatch(pl.act, t, x, y, pl.pool.filter(o => o.hp > 0), u);
            if (!ac) continue;
            if (pl.sphere) { ac.cellSet = new Set(ac.cells.map(c => c[0] + ',' + c[1])); ac.others = ac.friends.filter(f => f !== u); acShared.set(key, ac); }
          }
          // everyone else it catches adds what it would actually do to them (capped by what they have left)
          for (const o of ac.extra) { const ov = pl.bare.get(o.uid); if (ov !== undefined) v += Math.max(0, ov) * W.area; }
          caught += ac.extra.length;
          if (ac.extra.length) why = 'cluster';
          const friends = pl.sphere ? (ac.cellSet.has(x + ',' + y) ? ac.others.concat([u]) : ac.others) : ac.friends;
          if (friends.length) { v -= this.v2FF(u, pl.act, friends); ff = friends.length; }
          if (pl.act.ext && pl.act.ext.zone && pl.act.ext.zone.difficult) v += W.zone;
        } else if (pl.multi.has(t.uid)) v += pl.multi.get(t.uid);
        if (t.hp <= 0 && pl.a.type === 'atk' && !pl.a.useSaves && dOf(t) > 5) v *= 0.5;            // a downed foe is crit only up close
        if (pl.range > 10 && !pl.a.useSaves && pl.a.type === 'atk' && engagedHere && !(pl.a.ext && pl.a.ext.anyRange)) v *= W.meleeShoot;  // shooting in melee
        const raw = v * offMult + postBonus(t);
        v = net(pl, raw);
        if (pl.slot && raw > slotRaw) slotRaw = raw;
        if (!best || v > best.val) best = { pl, t, val: v, raw, why, caught, ff };
      }
    }
    return { best, dOf, sees, engagedHere };
  };
  // the best bonus option from a square, given whether the action takes a slot
  const bonusAt = (dOf, sees, slotTaken) => {
    let bon = 0;
    for (const b of bonusOpts) {
      if (b.slot && slotTaken) continue;
      let raw = 0;
      if (b.self) raw = b.raw;
      else if (b.n > 1) { const ok = b.vals.filter(o => dOf(o.t) <= b.range && sees(o.t)).map(o => o.v).sort((p, q) => q - p); raw = ok.slice(0, b.n).reduce((s, v) => s + v, 0); }
      else for (const o of b.vals) if (o.v > raw && dOf(o.t) <= b.range && sees(o.t)) raw = o.v;
      if (raw > 0) bon = Math.max(bon, raw - b.pace.base - b.pace.tax * raw - b.conc);
    }
    return bon;
  };

  // keeping the bonus action for a Divine Smite on the hits of the square's best attack (docs/ai-v2.md "Hybrids")
  const smC = new Map(), smHold = o => { if (bonusSpent || !u.smiteA || !o || o.t === u || o.pl.slot) return 0; const k = o.pl.a.id + '|' + o.t.uid; let v = smC.get(k); if (v === undefined) { v = this.v2SmiteHold(u, o.pl.act, o.t); smC.set(k, v); } return v; };
  const options = [];
  let anyOffense = false;
  // Ready: a melee creature with nothing in reach holds one swing for a foe that comes to it (a reaction; docs/ai-v2.md)
  const readyA = !onlyAct && u.reaction && !u.readied && !u.grappledBy ? u.actions.filter(a => a.actionSlot === 0 && a.type === 'atk' && !a.useSaves && (a._range || 5) <= 10 && !(a.ext && (a.ext.swallow || a.ext.resource || a.ext.pool)) && this.usable(u, a) && this.condOk(u, a))
    .sort((p, q) => avgDice((q.ext && q.ext.wtDpr) || q.dpr) - avgDice((p.ext && p.ext.wtDpr) || p.dpr))[0] : null;
  const readyAt = (x, y) => {
    const R = u.v2P.react, rng = Math.max(5, readyA._range || 5);
    let miss = 1, top = 0;
    for (const e of ctx.foes) {
      if (e.hp <= 0 || !e.onBoard || this.incap(e)) continue;
      const gap = this.distXY(x, y, e) - rng;
      if (gap <= 0 || gap > this.speedOf(e)) continue;
      miss *= 1 - (R.readyRanged + (R.readyMelee - R.readyRanged) * this.meleeShare(u, e));
      top = Math.max(top, this.expected(u, readyA, e) / Math.max(1, readyA.targets || 1));
    }
    return (1 - miss) * top;
  };
  consider(speed, (x, y, rm, steps) => {
    const { best, dOf, sees } = offAt(x, y, false);
    const th = threat(x, y), sp = ctx.danger.spacing(x, y) * safety * W.areaRisk;
    const keep = (caster ? reachPen(x, y) : 0) + concR(th);
    const risk = th * safety + sp + keep, walk = steps * W.move;
    const oa0 = oaNear && steps > 0 ? ctx.danger.oa(this.pathTo(rm, x, y)) * Woa : 0, oa = oa0 + dropCost(oa0);
    const prog = (need0 - need(x, y)) * progUnit;
    if (best) {
      anyOffense = true;
      const bon = Math.max(bonusAt(dOf, sees, best.pl.slot), smHold(best)) * W.bonus;
      // a touch from the air means coming level with the target
      const touch = u.alt > 0 && this.airborne(u) && best.t !== u && touchPl(best.pl);
      // coming down takes movement too: a touch it can't get level with this turn is no option from here
      const short = touch && steps + Math.abs(this.zOf(best.t) - zHere(x, y) - u.alt) > spSteps;
      const alt0 = touch ? ctx.danger.altOa(x, y, this.zOf(best.t) - zHere(x, y)) * Woa : 0, alt = alt0 ? alt0 + dropCost(oa0 + alt0) - dropCost(oa0) : 0;
      let aim = 0;
      if (canAim && steps === 0 && best.pl.a.type === 'atk' && !best.pl.a.useSaves && best.t !== u) aim = this.v2AdvGain(u, best.pl.a, best.t) * W.aim;
      const opt = { mode: 'act', x, y, rm, off: best, steps, score: best.val + Math.max(bon, aim) - risk - oa - alt - walk, aim: aim > bon && aim > 0 };
      // shoot, then use the rest of the move to get out of sight and Hide
      if (distH && !opt.aim && best.pl.a.type === 'atk') {
        const dh = distH[x + y * Wd];
        if (dh >= 0 && dh <= spSteps - steps && (dh === 0 || !this.adjacentEnemies(u, x, y).length)) { opt.hideAfter = spSteps - steps; opt.score += best.val * W.hide + risk * 0.5 + 2 - bon; }
      }
      if (!short) options.push(opt);
      // the same square without coming down: the option a priced or unreachable touch would otherwise hide
      if (alt > 0 || short) { const far = offAt(x, y, false, true).best; if (far) options.push({ mode: 'act', x, y, rm, off: far, steps, score: far.val + Math.max(bonusAt(dOf, sees, far.pl.slot), smHold(far)) * W.bonus - risk - oa - walk, aim: false }); }
      if (bonusDis && steps > 0) options.push({ mode: 'bonusDis', x, y, rm, off: best, steps, score: best.val - risk - walk });
    }
    if (onlyAct) return;
    if (engaged && steps > 0) options.push({ mode: 'actionDis', x, y, rm, steps, score: -risk - walk + prog - 2 });
    options.push({ mode: 'dodge', x, y, rm, steps, prog, score: -th * safety * (1 - W.dodge) - sp - keep - oa - walk + prog });
    if (readyA && !best) { const rv = readyAt(x, y); if (rv > 0) options.push({ mode: 'ready', readyA, x, y, rm, steps, prog, score: -th * safety - sp - keep - oa - walk + prog + rv - u.v2P.react.base }); }
    if (distH && distH[x + y * Wd] === 0) options.push({ mode: 'hide', x, y, rm, steps, score: -th * safety * 0.3 - sp - keep - oa - walk + prog });
  });
  // a bonus-action teleport (Misty Step): out of reach without provoking, then the action from there
  const jumpA = !bonusSpent && !onlyAct ? u.actions.find(a => a.actionSlot === 1 && a.ext && a.ext.teleport && this.usable(u, a) && this.condOk(u, a)) : null;
  if (jumpA && (engaged || threat(u.x, u.y) >= u.hp * 0.4)) {
    const R = Math.round(jumpA.ext.teleport / 5), jp = this.v2Pace(u, jumpA), noSlot = !!(jumpA._spell && jumpA._spell.level);
    for (let y = Math.max(0, u.y - R); y <= Math.min(this.H - 1, u.y + R); y++) for (let x = Math.max(0, u.x - R); x <= Math.min(Wd - 1, u.x + R); x++) {
      if ((x === u.x && y === u.y) || taken[x + y * Wd] || (u.n > 1 ? !this.fits(u, x, y) : this.isWall(x, y)) || !this.losB(u.x, u.y, u.n, x, y, u.n)) continue;
      const { best } = offAt(x, y, noSlot);
      if (!best) continue;
      const th = threat(x, y), risk = th * safety + ctx.danger.spacing(x, y) * safety * W.areaRisk + (caster ? reachPen(x, y) : 0) + concR(th);
      options.push({ mode: 'jump', jumpA, x, y, rm: null, off: best, steps: 0, score: best.val - risk - jp.base - jp.tax * Math.max(0, best.val) });
    }
  }
  // nothing to hit from anywhere it can walk: Dash is the other way to spend the action
  if (!onlyAct && !anyOffense && speed > 0) consider(speed * 2, (x, y, rm, steps) => {
    const oa0 = oaNear && steps > 0 ? ctx.danger.oa(this.pathTo(rm, x, y)) * Woa : 0, oa = oa0 + dropCost(oa0);
    options.push({ mode: 'dash', x, y, rm, steps, score: (need0 - need(x, y)) * progUnit - threat(x, y) * safety - ctx.danger.spacing(x, y) * safety * W.areaRisk - oa - steps * W.move * 0.5 });
  });
  if (!options.length) return null;
  options.sort((p, q) => q.score - p.score);
  const best = options[0];
  best.path = best.rm ? this.pathTo(best.rm, best.x, best.y) : [];
  best.note = '';
  // a slot would have done more, but the day ahead needs it more
  if (best.off && !best.off.pl.slot && slotRaw > best.off.raw + 2) best.hold = true;
  best.say = this.v2Words(u, best, ctx, engaged);
  return best;
};
/* the replay's "why" line, from the posture and what it chose */
Sim.prototype.v2Words = function (u, o, ctx, engaged) {
  const post = ctx.posture, t = o.off && o.off.t !== u ? o.off.t : null, n = u.name;
  const foeNear = (x, y) => ctx.foes.reduce((m, e) => Math.min(m, this.distXY(x, y, e)), 999);
  if (o.mode === 'bonusDis') return { text: `${n} slips away with a bonus-action Disengage`, key: 'bdis' };
  if (o.mode === 'actionDis') return { text: post.kind === 'retreat' ? `${n} is badly hurt and disengages to get clear` : `${n} disengages to get out of reach`, key: 'adis' };
  if (o.mode === 'hide') return { text: `${n} slips out of sight to hide`, key: 'hide' };
  if (o.mode === 'ready') return { text: `${n} holds its ground and readies an attack for whoever comes into reach`, key: 'ready' };
  if (o.mode === 'dodge') return { text: post.kind === 'retreat' ? `${n} is badly hurt and turns defensive, Dodging` : engaged ? `${n} goes on the defensive and Dodges` : o.prog > 0 ? `${n} closes in carefully, Dodging as it comes` : `${n} holds back and Dodges`, key: 'dodge' };
  if (o.mode === 'dash') return { text: `${n} has nothing in reach and dashes toward the fight`, key: 'dash' };
  if (o.mode === 'jump') return { text: `${n} teleports out of reach with ${o.jumpA.name}`, key: 'jump' };
  if (!t) return null;
  // casters: say what the spell is for
  const a = o.off.pl.a, sp = a._spell ? a.name : '';
  if (o.off.pl.ally) {
    if (a.type === 'heal') return t.hp <= 0 ? { text: `${n} gets ${t.name} back up with ${a.name}`, key: 'revive', t } : { text: `${n} patches up ${t.name} with ${a.name}`, key: 'heal', t };
    return { text: `${n} casts ${a.name} on ${o.off.count > 1 ? o.off.count + ' allies' : t.name}`, key: 'buff', t };
  }
  if (o.off.why === 'fog') return { text: `${n} drops ${a.name} on the shooters`, key: 'fog', t };
  if (sp && o.off.caught > 1) return { text: `${n} casts ${a.name} to catch ${o.off.caught} of them${o.off.ff ? ` (and ${o.off.ff} of its own)` : ''}`, key: 'cluster', t };
  if (a.type === 'debuff' && DANGER_CONDS.includes(a.buff && a.buff.condition) && this.kLegRes(u, t) > 0) {
    const bp = this.v2Burn(u, ctx), mine = bp && bp.on && bp.t === t ? bp.burners.get(u.uid) : null;
    if (mine && mine.a.id === a.id) return { text: `${n} burns ${t.name}'s resistances with ${a.name}`, key: 'burn', t };
    const pr = bp && !bp.on && bp.t === t && bp.probers ? bp.probers.get(u.uid) : null;
    if (pr && pr.a.id === a.id) return { text: `${n} probes ${t.name}'s ${pr.ab.toUpperCase()} save with ${a.name}`, key: 'probe', t };
  }
  if (a.type === 'debuff' && o.off.caught === 1) {
    const ab = a.ext && a.ext.saveAbility, weak = ab && avgDice(a.saveDC) < 99 && this.kSave(u, t, ab) <= 1;
    return { text: `${n} tries ${a.name} on ${t.name}${weak ? `, whose ${ab.toUpperCase()} save looks weak` : this.kDpr(u, t) >= Math.max(...ctx.foes.map(e => this.kDpr(u, e))) ? ', the biggest threat' : ''}`, key: 'control', t };
  }
  if (post.kind === 'retreat' && o.path.length && foeNear(o.x, o.y) > foeNear(u.x, u.y)) return { text: `${n} is badly hurt and fights from further back`, key: 'retreat', t };
  if (post.t === t) {
    if (post.kind === 'finish') return { text: `${n} moves to finish off ${t.name}`, key: 'finish', t };
    if (post.kind === 'protect') return { text: `${n} steps in to protect ${post.ally.name} from ${t.name}`, key: 'protect', t };
    if (post.kind === 'focus') return { text: `${n} goes for ${this.kCaster(u, t) ? 'the caster' : this.kHeals(u, t) ? 'the healer' : 'the softer target'}, ${t.name}`, key: 'focus', t };
  }
  const why = o.off.why;
  if (why === 'execute') return { text: `${n} decides to finish off ${t.name}, who keeps getting back up`, key: 'execute', t };
  if (why === 'finish') return { text: `${n} goes after ${t.name}, who looks ready to drop`, key: 'finish', t };
  if (why === 'cluster') return { text: `${n} lines up ${o.off.pl.a.name} to catch several of them`, key: 'cluster', t };
  if (why === 'threat') return { text: `${n} focuses ${t.name}, the biggest threat`, key: 'threat', t };
  if (why === 'focus') return { text: `${n} piles onto ${t.name} with the others`, key: 'focus', t };
  if (why === 'guard') return { text: `${n} steps in to protect an ally from ${t.name}`, key: 'guard', t };
  return null;
};
Sim.prototype.v2Say = function (u, tp) {
  const s = tp && tp.say;
  if (!this.record || !s) return;
  const key = 'v2:' + s.key + ':' + (s.t ? s.t.uid : '');
  if (u.lastIntent === key) return;
  u.lastIntent = key;
  this.ev('intent', s.text, s.t ? { uid: u.uid, target: s.t.uid } : { uid: u.uid });
};
/* aim action `a` from where it stands now (after moving, or a bonus action): the best target(s) in reach, at slot level L
   (its lowest free slot when L isn't given or no longer free) */
Sim.prototype.v2Aim = function (u, a, prefer, L) {
  if (!this.usable(u, a) || !this.condOk(u, a)) return null;
  const lv = this.v2CastLevels(u, a);
  if (!lv.length) return null;
  if (!(L !== undefined && lv.indexOf(L) >= 0)) L = lv[0];
  const act = castCopy(a, L), ctx = this.v2Ctx(u, 0), W = u.v2P.w;
  if (a.target === 'self' || a._range === 0) return this.v2PoolFor(u, act, ctx).length ? { dest: { x: u.x, y: u.y }, path: [], targets: [u], castL: L } : null;
  const pool = this.v2PoolFor(u, act, ctx), range = Math.max(5, a._range || 5), live = pool.filter(o => o.hp > 0);
  if (a.type === 'heal' || a.type === 'buff') {
    const ok = pool.filter(t => this.dist(u, t) <= range && this.canSee(u.x, u.y, t)).map(t => ({ t, v: this.v2AllyValue(u, act, t, ctx) + (t === prefer ? W.pick : 0) }))
      .filter(o => o.v > 0).sort((p, q) => q.v - p.v);
    return ok.length ? { dest: { x: u.x, y: u.y }, path: [], targets: ok.slice(0, act.targets || 1).map(o => o.t), why: '', castL: L } : null;
  }
  const fog = !!(a.ext && a.ext.zone && a.ext.zone.fog);
  let best = null;
  for (const t of pool) {
    if (this.dist(u, t) > range || !this.canSee(u.x, u.y, t)) continue;
    let v = (fog ? this.targetValue(u, act, t, pool, u.x, u.y).val : this.v2Value(u, act, t, ctx).val) + (t === prefer ? W.pick : 0) + (ctx.posture.t === t ? W.pick : 0), ac = null;
    if (areaSpec(act)) {
      ac = this.areaCatch(act, t, u.x, u.y, live, u);
      if (!ac) continue;
      if (!fog) {
        for (const o of ac.extra) v += Math.max(0, this.v2Value(u, act, o, ctx, true).val) * W.area;
        if (ac.friends.length) v -= this.v2FF(u, act, ac.friends);
      }
    }
    if (!best || v > best.v) best = { t, v, ac };
  }
  if (!best || (best.ac && best.v <= 0)) return null;
  const t = best.t, ac = best.ac;
  if (ac) return { friends: ac.friends, dest: { x: u.x, y: u.y }, path: [], targets: [t].concat(ac.extra), why: '', castL: L,
                   area: { shape: ac.spec.shape, size: ac.spec.size, ox: ac.ox !== undefined ? ac.ox : u.x, oy: ac.oy !== undefined ? ac.oy : u.y, tx: ac.ax, ty: ac.ay, cells: ac.cells, bn: ac.spec.bn } };
  const targets = [t], n = act.targets || 1;
  if (n > 1 && (act.useSaves || act.type === 'debuff'))
    targets.push(...live.filter(o => o !== t && this.dist(o, t) <= ((a.ext && a.ext.pairWithin) || 10) && this.dist(u, o) <= range).sort((p, q) => this.dist(p, t) - this.dist(q, t)).slice(0, n - 1));
  return { dest: { x: u.x, y: u.y }, path: [], targets, why: '', castL: L };
};
/* what an aimed action is worth, net of what it spends */
Sim.prototype.v2AimValue = function (u, a, p, ctx) {
  const act = castCopy(a, p.castL);
  let v;
  if (p.targets[0] === u && (a.target === 'self' || a._range === 0)) v = this.v2SelfValue(u, act, ctx);
  else if (a.type === 'heal' || a.type === 'buff') v = p.targets.reduce((s, t) => s + this.v2AllyValue(u, act, t, ctx), 0);
  else { v = this.v2Value(u, act, p.targets[0], ctx).val; if (p.area) for (const o of p.targets.slice(1)) v += Math.max(0, this.v2Value(u, act, o, ctx, true).val); }
  return v - this.v2PaceCost(u, a, v, p.castL);
};
/* the bonus action: 'pre' = a self-buff worth taking before it moves (Rage), 'post' = the best one from where it ended up */
Sim.prototype.v2Bonus = function (u, phase, choice) {
  const speed = (this.has(u, ['Restrained']) || u.grappledBy) ? 0 : this.speedOf(u);
  const ctx = this.v2Ctx(u, phase === 'pre' ? speed : 0);
  const list = u.actions.filter(a => a.actionSlot === 1 && !(a.ext && a.ext.teleport) && !isHideAction(a) && !smiteOf(a) && !(phase === 'pre' && a._spell && a._spell.level) && this.usable(u, a) && this.condOk(u, a));
  let best = null;
  let held = null;
  // a concentration spell gives up the one it holds (docs/ai-v2.md "Hybrids": bonus-action concentration)
  const conc = a => a._spell && a._spell.conc && u.concentrating && !this.sustaining(u, a) ? u.v2P.w.concSwap * this.v2Holding(u, ctx) : 0;
  const offer = (a, p, v) => { v -= conc(a); if (v > 0 && (!best || v > best.v)) best = { a, p, v }; };
  for (const a of list) {
    if (a.target === 'self' || a._range === 0) {
      if (phase === 'pre' && a.type !== 'buff') continue;
      const L = this.v2CastLevels(u, a)[0];
      if (L === undefined || !this.v2PoolFor(u, a, ctx).length) continue;
      const v = this.v2SelfValue(u, a, ctx);
      offer(a, { dest: { x: u.x, y: u.y }, path: [], targets: [u], castL: L }, v - this.v2PaceCost(u, a, v, L));
      if (phase === 'pre' && v > 0 && v - this.v2PaceCost(u, a, v, L) <= 0) held = a;
    } else if (phase === 'post' && (a.type === 'atk' || a.type === 'debuff' || a.type === 'heal' || a.type === 'buff')) {
      const p = this.v2Aim(u, a);
      if (p && p.targets[0]) offer(a, p, this.v2AimValue(u, a, p, ctx));
    }
  }
  if (phase === 'pre' && !best && held) this.v2NotePacing(u, held);
  if (phase === 'pre' && best) {
    // a buff now takes the bonus action: worth it only over the best bonus attack it could make this turn
    let atk = 0;
    for (const a of list) if (a.type === 'atk') for (const t of this.v2PoolFor(u, a, ctx)) if (this.dist(u, t) - Math.max(5, a._range || 5) <= speed) { const v = this.v2Value(u, a, t, ctx).val; atk = Math.max(atk, v - this.v2PaceCost(u, a, v)); }
    // or keeping it for a Divine Smite on the main attack's hits against the nearest foe
    if (u.smiteA && ctx.main && ctx.main.melee) { const t = ctx.foes.slice().sort((p, q) => this.dist(u, p) - this.dist(u, q))[0]; atk = Math.max(atk, this.v2SmiteHold(u, ctx.main.a, t)); }
    // or a bonus heal on an ally it can reach this turn (Lay on Hands, Healing Word on the downed: step 3a)
    for (const a of u.actions) {
      if (a.actionSlot !== 1 || a.type !== 'heal' || a.target === 'self' || a._range === 0 || !this.usable(u, a) || !this.condOk(u, a)) continue;
      const L = this.v2CastLevels(u, a)[0];
      if (L === undefined) continue;
      for (const t of this.v2PoolFor(u, a, ctx)) if (t !== u && this.dist(u, t) - Math.max(5, a._range || 5) <= speed) { const v = this.v2AllyValue(u, castCopy(a, L), t, ctx); atk = Math.max(atk, v - this.v2PaceCost(u, a, v, L)); }
    }
    if (best.v <= atk * u.v2P.w.bonus) return null;
  }
  // after moving: a smite on the planned attack's hits is worth keeping the bonus action for when it beats the best bonus option
  if (phase === 'post' && u.smiteA && choice && choice.p && choice.p.targets && choice.p.targets[0]) {
    const hold = this.v2SmiteHold(u, castCopy(choice.a, choice.p.castL), choice.p.targets[0]);
    if (hold > 0 && (!best || hold >= best.v)) return null;
  }
  return best;
};
/* Reckless Attack: advantage on its attacks this turn against advantage on everyone's attacks on it until its next turn */
Sim.prototype.v2Reckless = function (u, a, p) {
  const rk = u.actions.find(isReckless);
  if (!rk || a.type !== 'atk' || a.useSaves || (a._range || 5) > 10 || !p || !p.targets[0] || p.targets[0] === u) return;
  if (u.buffs.some(b => b.data && b.data.condition === rk.buff.condition)) return;
  const mode = u.v2P.reckless;
  if (mode === 'never') return;
  if (mode !== 'always') {
    const t = p.targets[0], W = u.v2P.w, ctx = this.v2Ctx(u, 0);
    const gain = this.v2AdvGain(u, a, t) * (1 + this.kDpr(u, t) / W.dprScale);
    let extra = 0, incoming = 0;
    for (const ti of ctx.danger.info) if (this.distXY(u.x, u.y, ti.e) <= ti.reach && ti.p < 1) { extra += ti.dmg * (1 - ti.p) / (1 + ti.others); incoming += ti.dmg / (1 + ti.others); }
    // the extra hits could be the ones that drop it
    if (incoming + extra >= u.hp) extra *= W.recklessDrop;
    if (gain <= extra * W.recklessRisk * (1 + W.hurt * (1 - Math.max(0, u.hp / u.maxHp)))) return;
  }
  this.addBuff(u, u, rk, Object.assign({}, rk.buff, { duration: '1 round' }));
  this.ev('buff', `${u.name}: ${rk.name}`, { uid: u.uid });
};
/* Action Surge (ext.extraAction): one more action when it's worth the use */
Sim.prototype.v2Surge = function (u) {
  const s = u.surges.find(a => this.usable(u, a));
  if (!s || !this.enemiesOf(u).some(e => e.onBoard && this.alive(e))) return;
  const left = this.has(u, ['Restrained']) || u.grappledBy ? 0 : Math.max(0, this.speedOf(u) - (u._steps || 0) * 5);
  const tp = this.v2Turn(u, left, true, true);
  if (!tp || tp.mode !== 'act' || !tp.off || tp.off.t === u || (tp.off.pl.a.type !== 'atk' && tp.off.pl.a.type !== 'debuff')) return;
  if (tp.off.val <= this.v2PaceCost(u, s, tp.off.val)) { this.v2NotePacing(u, s); return; }
  this.spend(u, s);
  if (tp.path.length) { this.moveAlong(u, tp.path); if (u.dead || u.hp <= 0) return; }
  if (s.buff && (s.buff.damage || s.buff.toHit || s.buff.ac || s.buff.condition)) this.addBuff(u, u, s, s.buff);
  this.ev('buff', `${u.name} uses ${s.name}: one more action`, { uid: u.uid });
  const a = tp.off.pl.a, p = this.v2Aim(u, a, tp.off.t);
  if (!p) return;
  this.v2Say(u, tp);
  this.v2Reckless(u, a, p);
  this.spend(u, a);
  this.doAction(u, a, p);
};
Sim.prototype.v2NotePacing = function (u, a) {
  if (!this.record || u.notedPacing || u.team !== 'party' || !this.leftFor(u)) return;
  u.notedPacing = true;
  this.ev('intent', a ? `${u.name} holds ${a.name} back: it's worth more in a fight still to come` : `${u.name} holds its spell slots for a fight still to come`, { uid: u.uid });
};
/* after it moved: aim the planned action again, or the best other one from here */
Sim.prototype.v2Act = function (u, choice) {
  let a = choice.a, p = this.v2Aim(u, a, choice.p.targets[0], choice.p.castL);
  if (!p) {
    const ctx = this.v2Ctx(u, 0);
    let best = null;
    for (const b of u.actions) {
      if (b.actionSlot !== 0 || (b.ext && b.ext.teleport) || !this.usable(u, b) || !this.condOk(u, b)) continue;
      const q = this.v2Aim(u, b);
      if (!q || !q.targets[0]) continue;
      const v = this.v2AimValue(u, b, q, ctx);
      if (!best || v > best.v) best = { a: b, p: q, v };
    }
    if (!best) return null;
    a = best.a; p = best.p;
  }
  return { a, p };
};

})(typeof window !== 'undefined' ? window : globalThis);
