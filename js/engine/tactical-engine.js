/* TACTICAL ENGINE: the parts not split out yet (file list and how the parts share names: js/engine/base.js).
   Still here, to be moved one module per commit: ai-boss.js, ai-v2-turn.js, encounter.js, day.js. */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { makeRng, parseDice, rollDice, avgDice, DANGER_CONDS, ADV_TARGET, ADV_SELF, finalizeAction, inferRange, damageMultFor, AI_TYPES, autoAI, casterKind, smiteOf, recoverSlots, makeUnit, freqKind, resetFightState, Sim, areaSpec, areaCells, inArea, MAX_ALT, isHideAction, AI_BASE, AI_PROFILES, aiProfile, AI_TIERS, TIER_PROFILES, tierOf, tierProfile, hitP, isReckless, castCopy, deathOdds } = ENG;
/* ---- the boss tier (docs/ai-v2.md "Boss tier") ---- */
/* the share of its side's damage its standing allies bring (its own side: real numbers); 0 for a boss alone */
Sim.prototype.bossShare = function (u, ctx) {
  const mine = Math.max(1, u.dpr || 0);
  let others = 0;
  for (const o of ctx.myTeam) if (o !== u && !this.incap(o) && o.hp > 0) others += Math.max(0, o.dpr || 0);
  return others / (others + mine);
};
/* what an option costs on top of its pacing, in points: the recharge price (ext.aiPlan's hints are a tax: bossPlan) */
Sim.prototype.bossAdj = function (u, a, ctx) {
  return this.bossRecharge(u, a, ctx);
};
/* a recharge ability used now gives up using it next turn with chance 1 − p: (1 − p) × what a typical use beats the best at-will option by.
   Main-turn actions only: the parser gives a legendary action that costs 2 or 3 a recharge as its way of limiting it, and pricing that too cost the Tyrant 5 points */
Sim.prototype.bossRecharge = function (u, a, ctx) {
  const B = u.v2P.boss;
  if (!B.recharge || a.actionSlot !== 0 || freqKind(a.freq) !== 'recharge') return 0;
  ctx.bossRc = ctx.bossRc || new Map();
  if (ctx.bossRc.has(a.id)) return ctx.bossRc.get(a.id);
  const foes = ctx.foes.filter(e => e.hp > 0), W = u.v2P.w, sp = areaSpec(a);
  let price = 0;
  if (foes.length) {
    const p = Math.max(1, Math.round(6 / Math.max(1, a.freq.cooldownRounds || 2))) / 6;
    const k = sp ? Math.max(1, Math.round(B.rechargeCatch * foes.length)) : Math.min(a.targets || 1, foes.length);
    const full = foes.map(t => this.v2Value(u, a, t, ctx).val).sort((x, y) => y - x);
    const rest = sp ? foes.map(t => this.v2Value(u, a, t, ctx, true).val).sort((x, y) => y - x).slice(1, k) : full.slice(1, k);
    const typical = Math.max(0, full[0]) + rest.reduce((t, v) => t + Math.max(0, v), 0) * (sp ? W.area : 1);
    let alt = 0;
    for (const b of u.actions) {
      if (b === a || b.actionSlot !== a.actionSlot || freqKind(b.freq) !== 'at will' || (b.type !== 'atk' && b.type !== 'debuff') || !this.usable(u, b) || !this.condOk(u, b)) continue;
      for (const t of foes) alt = Math.max(alt, this.v2Value(u, b, t, ctx).val);
    }
    price = B.recharge * (1 - p) * Math.max(0, typical - alt);
  }
  ctx.bossRc.set(a.id, price);
  return price;
};
/* ext.aiPlan's hints on one action, as a share of its value (added to its pacing tax): open −planOpen on its first turn, save +planSave until bloodied or the round */
Sim.prototype.bossPlan = function (u, a) {
  const P = u.tpl.ext && u.tpl.ext.aiPlan;
  if (!P) return 0;
  const B = u.v2P.boss, nm = String(a.name || '').toLowerCase(), is = s => !!s && nm.indexOf(String(s).toLowerCase()) === 0;
  let d = 0;
  if (is(P.open) && (u.fightTurns || 0) <= 1) d -= B.planOpen;
  for (const s of P.save || []) if (s && is(s.action) && !(s.until === 'bloodied' ? u.hp < u.maxHp / 2 : typeof s.until === 'number' ? this.round >= s.until : false)) d += B.planSave;
  return d;
};
/* ext.aiPlan.target: foes of that kind (read through k*) are worth planTarget points more */
Sim.prototype.bossPlanTarget = function (u, t) {
  const P = u.tpl.ext && u.tpl.ext.aiPlan, kind = P && P.target;
  if (!kind || t.team === u.team) return 0;
  const r = this.kReach(u, t), melee = r === null ? this.hasMelee(t) && !this.backLine(t) : r <= 10;
  const hit = kind === 'caster' ? this.kCaster(u, t) : kind === 'healer' ? this.kHeals(u, t) : kind === 'melee' ? melee : kind === 'ranged' ? !melee : kind === 'wounded' ? this.kFrac(u, t) < 0.5 : false;
  return hit ? u.v2P.boss.planTarget : 0;
};
/* the enemies that still take a turn before u's next one: after `after`'s turn (a legendary action), or from the top of the round (a lair action) */
Sim.prototype.bossBefore = function (u, after) {
  const ord = this.order || [], out = new Set();
  const i = after ? ord.indexOf(after) : -1;
  for (let k = 1; k <= ord.length; k++) { const o = ord[(i + k + ord.length) % ord.length]; if (o === u) break; if (o.team !== u.team && this.alive(o) && o.onBoard) out.add(o); }
  return out;
};
/* the uses of one slot's actions (2 legendary, 3 lair) from where it stands: v2 aims and values each one; maxCost limits legendary costs.
   Off its own turn a one-round effect from it ends when its next turn starts, so it only holds back the foes that act before then (before) */
Sim.prototype.bossOptions = function (u, slot, maxCost, before) {
  const ctx = this.v2Ctx(u, 0), out = [];
  for (const a of u.actions) {
    if (a.actionSlot !== slot || (a.ext && a.ext.teleport)) continue;
    const c = slot === 2 ? (a.ext && a.ext.legendaryCost) || 1 : 1;
    if (c > maxCost || !this.usable(u, a) || !this.condOk(u, a)) continue;
    const p = this.v2Aim(u, a);
    if (!p || !p.targets[0]) continue;
    let v = this.v2AimValue(u, a, p, ctx);
    if (before && a.type === 'debuff' && a.buff && a.buff.duration === '1 round') { const foes = p.targets.filter(t => t.team !== u.team); if (foes.length) v *= foes.filter(t => before.has(t)).length / foes.length; }
    v = v * (1 - this.bossPlan(u, a)) + (p.targets[0].team !== u.team ? this.bossPlanTarget(u, p.targets[0]) : 0) - this.bossAdj(u, a, ctx);
    if (v > 0) out.push({ a, p, v, c });
  }
  return out;
};
/* a lair action: the best one by value (a lair action unused is lost) */
Sim.prototype.bossLair = function (u) {
  let best = null;
  for (const o of this.bossOptions(u, 3, 1, this.bossBefore(u, null))) if (!best || o.v > best.v) best = o;
  return best;
};
/* legendary actions, which and when: each one it can pay for = its value + what the points left are worth later; waiting = the points kept.
   keep(L, K) = min(L, K) × its running value per point × legKeep, K = enemy turns before its own (this one included) */
Sim.prototype.bossLegendary = function (u, after) {
  const B = u.v2P.boss, L = u.legendaryLeft, before = this.bossBefore(u, after), K = 1 + before.size;
  const opts = this.bossOptions(u, 2, L, before);
  const top = opts.reduce((m, o) => Math.max(m, o.v / o.c), 0);
  if (top > 0) u.legPer = u.legPer ? u.legPer + (top - u.legPer) * B.legRate : top;
  const keep = (l, k) => Math.min(l, Math.max(0, k)) * (u.legPer || 0) * B.legKeep;
  const wait = keep(L, K - 1);
  let best = null;
  for (const o of opts) { const s = o.v + keep(L - o.c, K - 1); if (!best || s > best.s) best = Object.assign(o, { s }); }
  if (!best || best.s <= wait) {
    if (best && this.record && u.legSaid !== this.round) { u.legSaid = this.round; this.ev('intent', `${u.name} holds its legendary actions for a better moment`, { uid: u.uid }); }
    return null;
  }
  return best;
};
/* Legendary Resistance, weighed (bossLR): what failing costs (turns lost to the condition, damage it avoids, being dropped) against what one more use is worth later.
   A condition's cost: lrCond × the rounds it lasts (one round 1; repeat the save: 1 ÷ its chance to pass, at most lrTurns; longer lrTurns) × a turn of its own */
Sim.prototype.bossEffect = function (t, cond, dur, dc, ab) {
  const B = t.v2P.boss;
  if (!cond) return 0;
  const sev = B.lrCond[cond] !== undefined ? B.lrCond[cond] : B.lrCond.other;
  let turns = 1;
  if (dur === 'repeat the save each round') { const pass = Math.min(0.95, Math.max(0.05, (21 + this.saveBonusFor(t, ab) - dc) / 20)); turns = Math.min(B.lrTurns, 1 / pass); }
  else if (dur && dur !== '1 round' && !/^until/.test(dur)) turns = B.lrTurns;
  return sev * turns * this.bossTurnWorth(t);
};
Sim.prototype.bossTurnWorth = function (t) {
  return Math.max(4, t.dpr || 0) * (1 + t.v2P.boss.lrLeg * (t.hasLegendary ? t.legendaryMax : 0));
};
/* the effect a save is against: its condition and duration (this._saveA, the action being resolved) */
Sim.prototype.bossEffectOf = function (t, dc, ab) {
  const a = this._saveA, b = a && (a.type === 'debuff' ? a.buff : a.riderEffect && a.riderEffect.buff);
  return this.bossEffect(t, this._saveCond || (b && b.condition), b && b.duration, dc, ab);
};
Sim.prototype.bossLR = function (t, dc, ab, failDmg, seenBefore) {
  const B = t.v2P.boss, worth = this.bossTurnWorth(t);
  const foes = this.enemiesOf(t).filter(e => e.onBoard && this.alive(e));
  const incoming = Math.max(1, foes.reduce((s, e) => s + (this.kDpr(t, e) || 0), 0)), ratio = worth / incoming;
  const saved = failDmg * (this._saveHalf ? 0.5 : 1);
  const loss = this.bossEffectOf(t, dc, ab) + saved * B.lrDmg * ratio + (failDmg >= t.hp ? B.lrDrop * t.hp * ratio : 0);
  // the price: the worst it has been shown before this save (open: also what the party carries), at least lrFloor of its own turns, × lrSpare^(uses left − 1).
  // The floor is discounted too: kept for control that never comes, a use is wasted (an undiscounted floor cost the boss 7 points on Zaki's boss day in learn)
  let shown = Math.max(seenBefore || 0, B.lrFloor * worth);
  if (this.kModeFor(t) === 'open') for (const e of foes) for (const x of e.actions) {
    const b = x.type === 'debuff' ? x.buff : x.riderEffect && x.riderEffect.buff;
    if (b && b.condition && B.lrCond[b.condition] !== undefined)
      shown = Math.max(shown, this.bossEffect(t, b.condition, b.duration, Number(avgDice(x.type === 'debuff' ? x.saveDC : x.riderEffect.dc)) || 10, x.ext && (x.ext.saveAbility || x.ext.riderSave)));
  }
  const n = t.uses.get('__legres') || 0;
  // a use kept is only worth something if the fight lasts: × min(1, its rounds left (HP ÷ the party's DPR) ÷ lrHorizon)
  const life = B.lrHorizon ? Math.min(1, t.hp / incoming / B.lrHorizon) : 1;
  return loss >= B.lrKeep * shown * Math.pow(B.lrSpare, Math.max(0, n - 1)) * life;
};
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

/* ----- a creature's turn ----- */
Sim.prototype.turn = function (u) {
  // start of turn
  this._mn = u.n || 1;   // distXY measures from the acting creature's footprint
  u.turnNo = (u.turnNo || 0) + 1;
  u.fightTurns = (u.fightTurns || 0) + 1;
  this.turnSeq = (this.turnSeq || 0) + 1;
  this._flyMapVer = -1;   // effects run out at turn boundaries
  u._settled = false;
  if (u.alt > 0) this.fallCheck(u);
  u.tookTurn = true; u.movedThisTurn = false; u._steps = 0;
  // ongoing damage (Tasha's Caustic Brew, burning…) at the start of the creature's turn
  for (const b of u.buffs.slice()) if (b.dot && !u.dead) {
    const src = this.byId[b.src] || u, at = this.mark();
    const d = this.damage(src, u, Math.max(0, Math.floor(rollDice(b.dot, this.R, false))), { a: b.dtype ? { _spell: b.dmagic, ext: { damageType: b.dtype } } : null });
    this.ev('digest', `${u.name} takes ${d} damage from ${b.name}`, { uid: u.uid, target: u.uid, dmg: d });
    this.hoist(at);
  }
  this.zoneTick(u);
  if (u.dead) return;
  if (this.incap(u)) this.dropBuffs(u, b => b.endsOnIncap);
  u.mauling = u.ai === 'beast' && this.R() < 0.05;
  for (const x of this.units) this.dropBuffs(x, b => b.src === u.uid && b.expiry === '1 round');
  u.reaction = true; u.readied = null; u.legendaryLeft = u.legendaryMax;
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
      const d = this.damage(u, v, Math.max(0, Math.floor(rollDice(v.swallowInfo.digest, this.R, false))), { type: 'acid' });
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
      if (u.v2 && isReckless(a)) continue;     // v2 weighs Reckless Attack each turn (v2Reckless)
      const already = u.buffs.some(b => b.id === a.id);
      if (!already) { this.spend(u, a); this.doAction(u, a, { targets: this.plan(u, a, 0) ? this.plan(u, a, 0).targets : [u] }); }
    }
  }
  if (this.surpriseRules === '2014' && this.round === 1 && this.surprised[u.team]) { this.ev('skip', `${u.name} is surprised`, { uid: u.uid }); return; }
  if (this.incap(u)) { this.ev('skip', `${u.name} can't act`, { uid: u.uid }); this.endTurn(u); return; }

  if (u.swallowedBy) { this.insideTurn(u); this.endTurn(u); return; }

  if (!u.v2) this.rankSpells(u);                // v2 weighs every spell itself
  let actionUsed = false;
  const lost = u.buffs.find(b => b.loseAction);
  if (lost) {
    actionUsed = true;
    u.buffs = u.buffs.filter(b => b !== lost);
    this.ev('skip', `${u.name} spends its action on ${lost.name}`, { uid: u.uid });
  }
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
  let choice = null, moved = false, bonusSpent = false, hideAfter = null, v2tp = null;
  const out = () => u.dead || u.hp <= 0 || this.incap(u);          // dropped or disabled partway through: the rest of the turn is lost
  // self-buffs that change how the turn goes (Bladesong's speed and AC, Rage…) are invoked before moving
  if (!actionUsed) {
    const pre = u.v2 ? this.v2Bonus(u, 'pre') : this.choose(u, 1, 0);
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
        if ((x === u.x && y === u.y) || this.occupant(x, y, u.n, u) || (u.n > 1 ? !this.fits(u, x, y) : this.isWall(x, y)) || !this.losB(u.x, u.y, u.n, x, y, u.n)) continue;
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
    let tp = u.v2 ? this.v2Turn(u, speed, bonusSpent) : this.tacticalTurn(u, speed);
    if (u.v2) { v2tp = tp; this.v2Say(u, tp); if (tp && tp.hold) this.v2NotePacing(u, null); }
    // if saving resources leaves nothing better than dashing or dodging, spend one instead of wasting the turn
    else if (tp && (tp.mode === 'dash' || tp.mode === 'dodge' || tp.mode === 'actionDis') && u.actions.some(a => a.actionSlot === 0 && this.usable(u, a) && this.holdsResource(u, a))) {
      u._noHold = true;
      const tp2 = this.tacticalTurn(u, speed);
      u._noHold = false;
      if (tp2 && (tp2.mode === 'act' || tp2.mode === 'bonusDis') && tp2.off.val > 0) tp = tp2;
      else this.notePacing(u);
    } else this.notePacing(u);
    if (tp) {
      if (tp.mode === 'act' || tp.mode === 'bonusDis' || (tp.mode === 'jump' && tp.off)) {
        choice = { a: tp.off.pl.a, p: { targets: [tp.off.t], path: tp.path, why: u.v2 ? '' : tp.off.why } };
        if (u.v2) choice.p.castL = tp.off.pl.castL;
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
      if (tp.mode === 'ready' && !out()) {
        actionUsed = true; u.readied = { a: tp.readyA, round: this.round };
        this.ev('buff', `${u.name} readies ${tp.readyA.name} against the first foe to come into reach`, { uid: u.uid });
      }
      if ((tp.mode === 'dodge' || tp.mode === 'hide') && !out()) {
        actionUsed = true;
        this.addBuff(u, u, { id: 'dodge', name: 'Dodge' }, { duration: '1 round', condition: 'Is attacked with Disadvantage' });
        this.ev('buff', `${u.name} takes the Dodge action`, { uid: u.uid });
      }
      if (tp.mode === 'hide' && !bonusSpent && !out() && this.slipAndHide(u, 0)) bonusSpent = true;
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
        while (k > 0) { if (!this.occupant(full[k - 1].x, full[k - 1].y, u.n, u)) break; k--; }
        this.moveAlong(u, full.slice(0, k));
      } else this.approach(u, speed);
      if (foesUp.length && !out()) {
        this.addBuff(u, u, { id: 'dodge', name: 'Dodge' }, { duration: '1 round', condition: 'Is attacked with Disadvantage' });
        this.ev('buff', `${u.name} closes in carefully, taking the Dodge action`, { uid: u.uid });
      }
    }
    moved = true; actionUsed = true;
  }
  if (u.steadyAim && (!u.v2 || (v2tp && v2tp.aim)) && hideAfter === null && !bonusSpent && !actionUsed && choice && choice.a.type === 'atk' && !choice.a.useSaves && !u.movedThisTurn &&
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
  if (this.incap(u)) { this.endTurn(u); return; }

  // bonus action: first usable one, before or after the action depending on what it is
  u.reserveSlot = !!(choice && !actionUsed && choice.a._spell && choice.a._spell.level);
  const bonus = bonusSpent ? null : u.v2 ? this.v2Bonus(u, 'post', choice && !actionUsed ? choice : null) : this.choose(u, 1, 0);
  u.reserveSlot = false;
  if (u.v2) u.smiteSeq = !bonusSpent && !bonus && u.smiteA ? this.turnSeq : 0;     // the bonus action is free for a Divine Smite on a hit
  const after = bonus && (bonus.a.type === 'atk' || (bonus.a.buff && bonus.a.buff.condition === 'Invisible'));
  if (bonus && !after) { if (u.v2) u.castAt = bonus.p.castL || 0; this.spend(u, bonus.a); u.castAt = 0; this.doAction(u, bonus.a, bonus.p); }
  if (choice && !actionUsed && !out()) {
    // re-plan from where it ended up: it may have been stopped, or the target may have dropped
    let a = choice.a, p = null;
    // a flyer comes level with the creature it planned to touch before it aims again: from the air the ground is out of reach
    if (u.v2 && u.fly && choice.p && choice.p.targets && choice.p.targets[0]) this.settleAltitude(u, choice.a, choice.p);
    if (u.v2) { const c2 = out() ? null : this.v2Act(u, choice); if (c2) { a = c2.a; p = c2.p; } }
    else {
      p = this.usable(u, a) && this.condOk(u, a) ? this.plan(u, a, 0) : null;
      if (!p) { const c2 = this.choose(u, 0, 0); if (c2) { a = c2.a; p = c2.p; } }
    }
    if (p && p.targets.length && u.fly) {
      this.settleAltitude(u, a, p);
      // couldn't get level with it this turn: a melee swing can't reach
      const t0 = p.targets[0];
      if (t0 && t0 !== u && a.type === 'atk' && !a.useSaves && this.dist(u, t0) > Math.max(5, a._range || 5)) { this.ev('skip', `${u.name} can't reach ${t0.name} from ${(u.alt || 0) * 5} ft up`, { uid: u.uid }); p = null; }
      if (out()) p = null;                                       // rising or dropping can draw an opportunity attack
    }
    if (p && p.targets.length) {
      if (u.v2) this.v2Reckless(u, a, p);
      if (u.v2) u.castAt = p.castL || 0;
      this.spend(u, a); u.castAt = 0; this.doAction(u, a, p, { finishDowned: !!(p.targets[0] && p.targets[0].hp <= 0) });
      if ((a.type === 'atk' || a.type === 'debuff') && p.targets[0] && p.targets[0] !== u) u.focus = p.targets[0].uid;
    }
  }
  if ((hideAfter !== null || u.ai === 'regular') && !bonusSpent && !(bonus && !after) && !(u.v2 && u.smoteSeq === this.turnSeq) && !out()) {
    const left = Math.floor(speed / 5) - (u._steps || 0);
    if (this.slipAndHide(u, hideAfter !== null ? Math.min(hideAfter, left) : left)) bonusSpent = true;
  }
  if (bonus && after && !bonusSpent && !out()) {
    const p = u.v2 ? this.v2Aim(u, bonus.a, bonus.p.targets[0]) : this.plan(u, bonus.a, 0);
    if (p) { if (u.v2) { this.v2Reckless(u, bonus.a, p); u.castAt = p.castL || 0; } this.spend(u, bonus.a); u.castAt = 0; this.doAction(u, bonus.a, p); }
  }
  if (u.surges && u.surges.length && !u.dead && u.hp > 0 && !this.incap(u)) { if (u.v2) this.v2Surge(u); else this.surge(u); }
  // a flyer that didn't need a particular height this turn settles out of reach with what movement it has left
  if (u.fly && !u._settled && !out()) this.settleAltitude(u, null, null);
  this.endTurn(u);
};
/* Action Surge: one more action this turn. Monsters use it as soon as it lands an attack; the party holds it while a
   fight is in hand and more are coming. Its buff (Tactical Supremacy's extra damage) comes with it. */
Sim.prototype.surge = function (u) {
  const s = u.surges.find(a => this.usable(u, a));
  if (!s || !this.enemiesOf(u).some(e => e.onBoard && this.alive(e))) return;
  if (u.team === 'party' && u.ai === 'tactical' && this.fightInHand(u)) return;
  const left = this.has(u, ['Restrained']) || u.grappledBy ? 0 : Math.max(0, this.speedOf(u) - (u._steps || 0) * 5);
  const c = this.choose(u, 0, left);
  if (!c || !c.p || !c.p.targets.length || (c.a.type !== 'atk' && c.a.type !== 'debuff')) return;
  this.spend(u, s);
  if (c.p.path && c.p.path.length) { this.moveAlong(u, c.p.path); if (u.dead || u.hp <= 0) return; }
  if (s.buff && (s.buff.damage || s.buff.toHit || s.buff.ac || s.buff.condition)) this.addBuff(u, u, s, s.buff);
  this.ev('buff', `${u.name} uses ${s.name}: one more action`, { uid: u.uid });
  this.intent(u, c.a, c.p);
  this.spend(u, c.a);
  this.doAction(u, c.a, c.p);
};
Sim.prototype.approach = function (u, budget) {
  const foes = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e));
  if (!foes.length) return;
  const rm = this.reachMap(u, budget);
  let best = null, bs = Infinity;
  for (let i = 0; i < rm.dist.length; i++) {
    if (rm.dist[i] < 0) continue;
    const x = i % this.W, y = (i / this.W) | 0;
    if (this.occupant(x, y, u.n, u)) continue;
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
      this._saveCond = b.data && b.data.condition;
      const s = this.saveRoll(u, b.dc, null, b.saveAbility);
      this._saveCond = null;
      if (s.success) { u.buffs = u.buffs.filter(x => x !== b); this._flyMapVer = -1; this._rmCache = null; this.ev('save', `${u.name} shakes off ${b.name}`, { uid: u.uid }); }
    }
  }
  this.dropBuffs(u, b => b.expiry === 'hide' && (u.turnNo || 0) > b.madeOnTurn);
  // passive auras (Other 1 / Other 2 attacks and debuffs) hit enemies around it
  for (const a of u.actions) {
    if ((a.actionSlot !== 5 && a.actionSlot !== 6) || a.type === 'buff' || a.type === 'heal' || !this.usable(u, a) || !this.condOk(u, a)) continue;
    if (u.dead || u.hp <= 0 || u.swallowedBy) break;
    const r = Math.max(5, a._range || 10);
    const victims = this.orderBySelector(this.enemiesOf(u).filter(e => e.onBoard && this.alive(e) && this.dist(u, e) <= r && this.losU(u, e)), a.target).slice(0, a.useSaves || a.type === 'debuff' ? (a.targets || 1) : 1);
    if (!victims.length) continue;
    this.spend(u, a);
    if (this.record) {
      const n = r / 5, cells = [], un = u.n || 1;
      for (let y = u.y - n; y <= u.y + un - 1 + n; y++) for (let x = u.x - n; x <= u.x + un - 1 + n; x++) if (x >= 0 && y >= 0 && x < this.W && y < this.H) cells.push([x, y]);   // round the whole body
      this.ev('aoe', `${u.name}'s ${a.name} lashes out (${r}-ft aura)`, { uid: u.uid, shape: 'aura', size: r, ox: u.x, oy: u.y, cells, hits: victims.map(t => t.uid), harm: a.type === 'atk' ? 'dmg' : 'cond' });
    }
    if (a.type === 'atk') this.resolveAttackAction(u, a, victims, { aura: true });
    else this.doAction(u, a, { targets: victims });
  }
  if (!u.dead && u.onBoard) this.stepAwayFrom(u);
};
/* "When a creature ends its turn within 5 feet of it, it moves up to 10 feet away without provoking":
   enemies next to u with such a reaction slip to the nearby square that is safest from melee */
Sim.prototype.stepAwayFrom = function (u) {
  for (const w of this.enemiesOf(u)) {
    if (!w.onBoard || !this.alive(w) || !w.reaction || this.incap(w) || w.swallowedBy || w.grappledBy || this.has(w, ['Restrained'])) continue;
    if (this.dist(w, u) > 5) continue;
    const ra = w.actions.find(a => a.actionSlot === 4 && a.ext && a.ext.stepAway && this.usable(w, a) && this.condOk(w, a));
    if (!ra) continue;
    const threats = this.enemiesOf(w).filter(e => e.onBoard && this.alive(e) && !this.incap(e) && this.meleeReach(e) > 0);
    const score = (x, y) => {
      let s = 0, near = Infinity;
      for (const e of threats) { const d = this.distXY(x, y, e); if (d <= this.meleeReach(e)) s -= 100; near = Math.min(near, d); }
      return s + Math.min(near, 60) / 5;
    };
    const rm = this.reachMapRaw(w, ra.ext.stepAway);
    let best = null, bs = score(w.x, w.y);
    for (let c = 0; c < rm.dist.length; c++) {
      if (rm.dist[c] <= 0) continue;
      const x = c % this.W, y = (c / this.W) | 0;
      if (this.occupant(x, y, w.n, w)) continue;
      const sc = score(x, y) - rm.dist[c] * 0.01;
      if (sc > bs + 0.5) { bs = sc; best = { x, y }; }
    }
    if (!best) continue;
    w.reaction = false; this.spend(w, ra);
    this.ev('react', `${w.name} uses ${ra.name} and steps away from ${u.name}`, { uid: w.uid, target: u.uid });
    const keep = { dis: w.disengaged, moved: w.movedThisTurn, steps: w._steps };
    w.disengaged = true;
    this.moveAlong(w, this.pathTo(rm, best.x, best.y));
    w.disengaged = keep.dis; w.movedThisTurn = keep.moved; w._steps = keep.steps;
    if (u.dead) return;
  }
};

/* ----- flying height ----- */
/* Where a flyer wants to be this turn: level with its target to fight in melee, or (shooting, casting, or with
   nothing to do) just out of reach of the melee foes around it. Going up or down costs movement, and rising out
   of someone's reach provokes an opportunity attack like any other move. */
Sim.prototype.settleAltitude = function (u, a, p) {
  if (!u.fly || !this.airborne(u) || u._settled) return;
  const g = this.T.anyH ? this.T.h[u.x + u.y * this.W] : 0;
  const t = p && p.targets && p.targets[0];
  const melee = a && t && t !== u && (a.type === 'atk' || a.type === 'debuff' || a.type === 'heal') && Math.max(5, a._range || 5) <= 10 && !(a.useSaves && (a.ext && a.ext.area));
  let want;
  if (melee) want = this.zOf(t) - g;
  else {
    // out of reach of nearby foes that fight on the ground (or can't follow as high)
    const foes = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e) && !this.incap(e) && this.meleeReach(e) > 0 && this.gapTo(u.x, u.y, u.n, e) <= 8);
    want = foes.length ? Math.max(...foes.map(e => this.zOf(e) + Math.round(this.meleeReach(e) / 5) + 1)) - g : (u.alt || 0);
    if (a && t && t !== u && Math.max(5, a._range || 5) >= 30) want = Math.max(want, 6);       // a shooter or caster stays up, about 30 ft
    // …but the shot or spell still has to reach and see its target
    if (a && t && t !== u) {
      const R = Math.max(1, Math.round(Math.max(5, a._range || 5) / 5));
      want = Math.min(want, this.zOf(t) - g + R);
      while (want > 0 && !this.losB(u.x, u.y, u.n, t.x, t.y, t.n, false, want, t.alt || 0)) want--;
    }
  }
  want = Math.max(0, Math.min(MAX_ALT, Math.round(want)));
  const cur = u.alt || 0;
  if (want === cur) { u._settled = true; return; }
  const left = Math.floor(this.speedOf(u) / 5) - (u._steps || 0);
  if (left <= 0) return;
  const to = cur + Math.max(-left, Math.min(left, want - cur));
  // opportunity attacks from foes it rises (or drops) out of reach of
  if (!u.disengaged) {
    const before = new Set(this.adjacentEnemies(u, u.x, u.y, cur)), after = new Set(this.adjacentEnemies(u, u.x, u.y, to));
    for (const e of before) {
      if (after.has(e) || !e.reaction || this.incap(e) || e.noOA) continue;
      const atk = e.actions.find(x => x.type === 'atk' && !x.useSaves && x.actionSlot === 0 && x._range <= 10 && !(x.ext && x.ext.swallow));
      if (!atk) continue;
      e.reaction = false;
      this.ev('oa', `${e.name} takes an opportunity attack at ${u.name}`, { uid: e.uid, target: u.uid });
      this.attackOnce(e, atk, u, { oa: true });
      if (u.dead || u.hp <= 0 || !this.airborne(u) || this.incap(u)) return;
    }
  }
  u.alt = to; u._steps = (u._steps || 0) + Math.abs(to - cur); u._settled = true;
  this.boardChanged();
  this.ev('effect', to === 0 ? `${u.name} lands` : `${u.name} ${to > cur ? 'flies up' : 'drops'} to ${to * 5} ft`, { uid: u.uid });
};

/* ----- legendary & lair ----- */
Sim.prototype.legendary = function (after) {
  for (const u of this.units) {
    if (u === after || u.team === after.team || !this.alive(u) || !u.onBoard || u.legendaryLeft <= 0 || this.incap(u)) continue;
    // actions that cost more than the uses left are hidden for this pick
    const hidden = u.actions.filter(a => a.actionSlot === 2 && ((a.ext && a.ext.legendaryCost) || 1) > u.legendaryLeft);
    hidden.forEach(a => { a.actionSlot = -99; });
    const mn = this._mn;
    this._mn = u.n || 1;     // it measures from its own body, not the creature whose turn just ended
    const c = u.v2 && u.v2P.boss.legendary === 'weigh' ? this.bossLegendary(u, after) : this.choose(u, 2, 0);   // the boss tier weighs which and when
    hidden.forEach(a => { a.actionSlot = 2; });
    if (!c) { this._mn = mn; continue; }
    u.legendaryLeft -= (c.a.ext && c.a.ext.legendaryCost) || 1;
    this.spend(u, c.a);
    this.ev('legendary', `${u.name} uses a legendary action: ${c.a.name}`, { uid: u.uid });
    this.doAction(u, c.a, c.p);
    this._mn = mn;
    if (this.over()) return;
  }
};
Sim.prototype.lair = function () {
  for (const u of this.units) {
    if (!this.alive(u) || !u.onBoard) continue;
    let c;
    if (u.v2 && u.v2P.boss.lair === 'weigh') {     // the boss tier: the lair action worth most now, measured from its own body
      if (!u.actions.some(a => a.actionSlot === 3)) continue;
      const mn = this._mn; this._mn = u.n || 1; c = this.bossLair(u); this._mn = mn;
    } else c = this.choose(u, 3, 0);
    if (!c) continue;
    this.spend(u, c.a);
    this.ev('lair', `Lair action (${u.name}): ${c.a.name}`, { uid: u.uid });
    this.doAction(u, c.a, c.p);
  }
};

/* Morale (optional): a monster that's bloodied, sees half its side fall, or loses its leader makes a DC 10 Wisdom
   save at the start of its turn when its side is losing; on a failure it flees, or surrenders if it can't get away.
   Either way it's out of the fight and counts as defeated. Mindless creatures and legendary ones fight on. */
/* ----- morale, ending an encounter, placing units ----- */
const FEARLESS = ['undead', 'construct', 'ooze', 'plant'];
Sim.prototype.moraleBreaks = function (u) {
  if (!this.morale || u.team !== 'foes' || u.isPC || u.legResMax || u.hasLegendary) return false;
  if (FEARLESS.includes(String(u.tpl.type || '').toLowerCase()) || (u.tpl.ext && u.tpl.ext.fearless)) return false;
  const M = u.v2 && u.v2P && u.v2P.morale;      // AI v2: its profile says which triggers count (a tier's nerve); the base equals the old rule
  if (M && M.fearless) return false;
  const side = this.units.filter(o => o.team === u.team);
  const fallen = side.filter(o => o.dead || o.hp <= 0).length;
  const leader = side.reduce((m, o) => (!m || o.maxHp > m.maxHp ? o : m), null);
  const triggers = [];
  if (u.hp < u.maxHp / 2 && (!M || M.bloodied)) triggers.push('bloodied');
  if (side.length > 1 && fallen * 2 >= side.length && (!M || M.half)) triggers.push('half');
  if (leader && leader !== u && (leader.dead || leader.hp <= 0) && leader.maxHp > u.maxHp && (!M || M.leader)) triggers.push('leader');
  u.moraleSeen = u.moraleSeen || {};
  const fresh = triggers.filter(k => !u.moraleSeen[k]);
  if (!fresh.length || !this.losing(u)) return false;
  fresh.forEach(k => { u.moraleSeen[k] = true; });
  const r = this.d20(false, false, false) + this.saveBonusFor(u, 'wis');
  return r < (M && M.dc || 10);
};
Sim.prototype.leave = function (u) {
  const caught = !!u.grappledBy || this.has(u, ['Restrained', 'Paralyzed', 'Stunned', 'Unconscious', 'Petrified']) || this.speedOf(u) <= 0 ||
    this.adjacentEnemies(u, u.x, u.y).some(e => this.alive(e) && !this.incap(e) && this.speedOf(e) >= this.speedOf(u));
  this.boardChanged();
  u.alt = 0;
  this.endConcentration(u, caught ? 'surrenders' : 'flees');
  u.dead = true; u.fled = caught ? 'surrendered' : 'fled';
  this.releaseGrappleOf(u);
  for (const vid of u.inside.slice()) this.expel(u, this.byId[vid], 'freed');
  u.onBoard = false;
  this.ev('flee', caught ? `${u.name} throws down its weapons and surrenders` : `${u.name} loses its nerve and flees the fight`, { uid: u.uid });
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
  if (this.aiV2) this.units.forEach(u => this.v2Setup(u));
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
    this.expireZones();
    this.lair();
    for (const u of this.order) {
      if (this.over()) break;
      if (u.dead) continue;
      if (u.team === 'foes' && !u.onBoard) continue;
      this.ev('turn', `${u.name}'s turn`, { uid: u.uid });
      if (u.hp > 0 && !this.incap(u) && this.moraleBreaks(u)) { this.leave(u); if (this.over()) break; continue; }
      this.current = u; this.turn(u); this.current = null;
      if (this.over()) break;
      this.legendary(u);
    }
    this.round++;
  }
  const won = !this.foesStanding() && this.partyStanding();
  if (won) this.endFightRevives();
  if (this.tpkKills && !this.partyStanding() && this.foesStanding()) for (const u of this.units) if (u.team === 'party' && !u.dead) this.kill(u, null, 'the whole party is down');
  this.ev('end', won ? 'The party wins' : this.partyStanding() ? 'The fight drags on — stopped' : 'The party falls', { won });
  return { won, rounds: Math.min(this.round - 1, this.maxRounds) };
};

Sim.prototype.place = function (party, foes, layout) {
  const W = this.W, H = this.H;
  const pos = (layout && layout.positions) || {};
  const gap = Math.max(1, Math.round(((layout && layout.gapFt) || 30) / 5));
  const taken = new Set();
  const put = (u, x, y) => { u.x = x; u.y = y; const n = u.n || 1; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) taken.add((x + i) + ',' + (y + j)); };
  const free1 = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !taken.has(x + ',' + y) && !this.isWall(x, y);
  const free = (x, y, n) => { for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (!free1(x + i, y + j)) return false; return true; };
  const nearestFree = (x, y, n) => {
    for (let r = 0; r < Math.max(W, H); r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (free(x + dx, y + dy, n || 1)) return [x + dx, y + dy];
    }
    return [x, y];
  };
  const formation = (list, frontX, dir) => {
    const rows = Math.min(list.length, Math.max(3, Math.ceil(list.length / 2)));
    list.forEach((u, i) => {
      if (pos[u.key]) { const [x, y] = nearestFree(pos[u.key].x, pos[u.key].y, u.n); put(u, x, y); return; }
      const col = Math.floor(i / rows), row = i % rows;
      const y = Math.round(H / 2 - rows + row * 2 + (col % 2));
      const [x, yy] = nearestFree(frontX - dir * col * 2, Math.max(0, Math.min(H - 1, y)), u.n);
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

/* Pre-fight buffs (opts.prefightBuffs, default on; the one switch for all of them): hours-long, non-concentration buffs
   (8 hours or more) are cast once, at the start of the simulated day, before the first fight. Concentration spells are out
   (casting one pre-fight would block the caster's concentration in the fight) and so is anything shorter than 8 hours.
   Party only: monsters never do this (their statblock already assumes preparation). A spell joins by carrying
   ext.prefight (ext.aid for Aid) and an entry in PREFIGHT_SPELLS; the spell is inert in a fight (see usable).
   Each caster ranks what it has by expected HP saved over the day per slot level spent, and spends at most
   PREFIGHT.share (opts.morningShare) of its slot levels (levels x slots, summed) on the lot, each spell at most once, the lowest
   slot that works, a real slot (pacing and later fights see it spent). With no slot or no eligible target it does not cast.
   Effects that last the day sit on the unit: Aid is `aided` (never cleared), Death Ward is `deathWard` (cleared when it
   fires, see damage), and buffs (Mage Armor) go in `dayBuffs`, re-applied by runDay through addBuff after each fight's
   resetFightState. Returns log notes for runEncounter. */
const PREFIGHT = {
  share: 0.25,      // morningShare: part of a caster's slot levels that may go to pre-fight buffs
  intake: 0.5,      // part of its max HP a creature takes in a fight, before armor and luck
  hitP: 0.65,       // typical enemy chance to hit it; one point of AC removes 5% of the rolls, 0.05 / hitP of the damage
  downP: 0.1,       // chance, per fight, it drops to 0 HP
  downCost: 0.6     // an avoided drop to 0 is worth this part of its max HP (turns lost, risk of dying)
};
const unarmoredAC = o => { const x = (o.tpl && o.tpl.ext) || {}; return x.unarmored ? 13 + (+x.dexMod || 0) : 0; };
const aidAmount = (a, k) => Math.round(avgDice(a.amount) + (k > 0 ? k * avgDice(a._spell.upcast) : 0));
/* per spell: min slot level (rules) · ok(target) eligibility · gain(target, action, upcast steps, fights) in HP saved over the day · apply(sim, caster, action, target, upcast steps) -> log text */
const PREFIGHT_SPELLS = {
  aid:        { min: 2,    // +amt max HP and HP: amt HP, once
                ok: o => !o.aided,
                gain: (o, a, k) => aidAmount(a, k),
                apply: (sim, c, a, o, k) => { const amt = aidAmount(a, k); o.aided = true; o.maxHp += amt; o.hp += amt; return '+' + amt + ' max HP'; } },
  mageArmor:  { min: 1,    // AC 13 + Dex (unarmored only): (AC gained x 5% / hitP) of the HP it takes in the day, intake x max HP x fights
                ok: o => unarmoredAC(o) > o.baseAC && !(o.dayBuffs || []).some(d => d.kind === 'mageArmor'),
                gain: (o, a, k, f) => (unarmoredAC(o) - o.baseAC) * 0.05 / PREFIGHT.hitP * PREFIGHT.intake * o.maxHp * f,
                apply: (sim, c, a, o) => {
                  const ac = unarmoredAC(o), d = { kind: 'mageArmor', src: c.uid, action: { id: a.id, name: a.name, ext: {} }, data: { duration: 'entire encounter', ac: ac - o.baseAC } };
                  (o.dayBuffs = o.dayBuffs || []).push(d); sim.addBuff(o, { uid: d.src }, d.action, d.data); return 'AC ' + ac; } },
  deathWard:  { min: 4,    // the first drop to 0 HP leaves it at 1 HP: chance of dropping over the day (downP per fight) x downCost x max HP
                ok: o => !o.deathWard && !o.wardSpent,
                gain: (o, a, k, f) => Math.min(1, PREFIGHT.downP * f) * PREFIGHT.downCost * o.maxHp,
                apply: (sim, c, a, o) => { o.deathWard = true; o.wardSpent = true; return 'warded (1 HP instead of 0, once)'; } }
};
function prefightKind(a) { return a.ext && (a.ext.aid ? 'aid' : a.ext.prefight); }
function morningCasts(party, sim, opts) {
  const notes = [];
  const share = opts && typeof opts.morningShare === 'number' ? opts.morningShare : PREFIGHT.share;
  for (const u of party) {
    if (u.dead) continue;
    const done = {};
    let budget = u.slots ? Math.floor(share * u.slotsMax.reduce((t, n, i) => t + n * (i + 1), 0) + 1e-9) : 0;
    const fights = Math.max(1, sim.leftFor(u));
    for (;;) {
      let best = null;
      for (const a of u.actions) {
        const kind = prefightKind(a), spec = kind && PREFIGHT_SPELLS[kind];
        if (!spec || done[a.id]) continue;
        let L = 0;
        if (a._spell && a._spell.level) {
          for (let l = Math.max(a._spell.level, spec.min); l <= 9; l++) if (u.slots && u.slots[l - 1] > 0) { L = l; break; }
          if (!L || L > budget) continue;
        }
        const k = L && a._spell.upcast ? L - a._spell.level : 0;
        const n = (a.targets || 1) + (a._spell && a._spell.upcastTargets ? a._spell.upcastTargets * k : 0);
        const ts = party.filter(o => !o.dead && spec.ok(o)).map(o => ({ o, g: spec.gain(o, a, k, fights) })).filter(x => x.g > 0)
          .sort((x, y) => y.g - x.g || x.o.maxHp - y.o.maxHp).slice(0, n);
        if (!ts.length) continue;
        const v = ts.reduce((t, x) => t + x.g, 0) / Math.max(1, L);
        if (!best || v > best.v) best = { a, spec, L, k, ts, v };
      }
      if (!best) break;
      const text = best.ts.map(x => x.o.name).join(', ') + ' ' + best.spec.apply(sim, u, best.a, best.ts[0].o, best.k);
      for (let i = 1; i < best.ts.length; i++) best.spec.apply(sim, u, best.a, best.ts[i].o, best.k);
      if (best.L) { u.slots[best.L - 1]--; budget -= best.L; }
      done[best.a.id] = true;
      notes.push({ uid: u.uid, text: `${u.name} cast ${best.a.name} this morning: ${text}` });
    }
  }
  return notes;
}
function runDay(day, opts) {
  opts = opts || {};
  const sim = new Sim(opts);
  const party = expandTeam(day.players, 'party', true);
  sim.encountersLeft = (opts.only !== undefined ? [day.encounters[opts.only]] : day.encounters).filter(e => e && e.monsters && e.monsters.length).length;   // the day's length, for leftFor
  if (opts.prefightBuffs !== false) sim.morningNotes = morningCasts(party, sim, opts);
  const encs = (opts.only !== undefined) ? [day.encounters[opts.only]] : day.encounters;
  const results = [];
  let lostDay = false;     // a lost fight ends the day
  encs.forEach((enc, ei) => {
    if (lostDay) return;
    const realIdx = opts.only !== undefined ? opts.only : ei;
    if (!enc || !enc.monsters || !enc.monsters.length) return;
    if (!party.some(u => !u.dead)) return;
    if (enc.shortRest && results.length) {
      party.forEach(u => { if (!u.dead) { u.hp = u.maxHp; u.temp = 0; u.actions.concat(u.surges || []).forEach(a => { if (freqKind(a.freq) === 'sr') u.uses.set(a.id, a.freq.uses || 1); }); if (u.resMax) for (const k in u.resMax) if (u.resMax[k].reset === 'sr') u.uses.set('res:' + k, +u.resMax[k].uses || 0); if (u.slots && u.slotReset === 'sr') u.slots = u.slotsMax.slice(); else if (u.slots && u.recovery && !u.recovery.anyBreak && !u.recoveryUsed) recoverSlots(u); } });
    }
    party.forEach(u => { if (!u.dead && u.hp <= 0) u.hp = 1; resetFightState(u); (u.dayBuffs || []).forEach(d => sim.addBuff(u, { uid: d.src }, d.action, d.data)); });
    const foes = expandTeam(enc.monsters, 'foes', false);
    party.forEach(u => { if (!u.aiSet) u.ai = AI_TYPES.includes(opts.partyAI) ? opts.partyAI : 'tactical'; });
    sim.events = [];
    const layout = (opts.layouts && opts.layouts[realIdx]) || opts.layout || {};
    const later = encs.slice(ei + 1).filter(e => e && e.monsters && e.monsters.length);
    sim.encountersLeft = later.length;
    if (results.length) party.forEach(u => { if (!u.dead && u.slots && u.recovery && u.recovery.anyBreak && !u.recoveryUsed && u.slots.some((n, i) => n < u.slotsMax[i])) recoverSlots(u); });
    sim.restBeforeNext = !!(later[0] && later[0].shortRest);
    const restAt = later.findIndex(e => e.shortRest);
    sim.fightsBeforeRest = restAt < 0 ? later.length : restAt;     // fights after this one that short-rest pools must last
    sim.fightNo = results.length;
    const r = sim.runEncounter(party, foes, enc, layout);
    sim.learnFight();
    results.push({
      index: realIdx, won: r.won, rounds: r.rounds,
      events: sim.record ? sim.events : null,
      start: sim.record ? sim.events.length && null : null,
      party: party.map(u => ({ uid: u.uid, name: u.name, hp: u.hp, maxHp: u.maxHp, dead: !!u.dead, down: !u.dead && u.hp <= 0, everDowned: u.everDowned, downs: u.downs, dealt: u.dmgDealt, taken: u.dmgTaken, healed: u.healed, revived: u.revived || 0 })),
      foes: foes.map(u => ({ uid: u.uid, name: u.name, hp: u.hp, maxHp: u.maxHp, dead: !!u.dead, fled: u.fled || undefined, dealt: u.dmgDealt, taken: u.dmgTaken })),
      units: sim.record ? sim.units.map(u => ({ uid: u.uid, key: u.key, name: u.name, team: u.team, isPC: u.isPC, maxHp: u.maxHp, size: u.size, init: u.init, auras: aurasOf(u), areas: areasOf(u), sheet: sheetOf(u) })) : null,
    });
    if (!r.won) lostDay = true;
  });
  if (opts._keep) results._sim = sim;      // tests look at what each side learned
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
/* what a creature is, for the token inspector (the parts that don't change during a fight) */
function sheetOf(u) {
  const ex = (u.tpl && u.tpl.ext) || {};
  return { ac: u.baseAC, speed: u.speed, fly: u.fly || 0, climb: u.climb || 0, saves: u.saves, saveBonus: u.saveBonus, mods: u.dmgMods, condImmune: u.condImmune && u.condImmune.length ? u.condImmune : null,
    type: u.tpl && u.tpl.type, cr: u.tpl && u.tpl.cr, build: ex.build || '', ai: u.ai, slots: u.slotsMax ? u.slotsMax.map(n => n + '/' + n).slice(0, u.slotsMax.reduce((m, n, i) => n ? i + 1 : m, 0)).join(' ') : '' };
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
  return sim.units.map(u => ({ uid: u.uid, key: u.key, name: u.name, team: u.team, x: u.x, y: u.y, maxHp: u.maxHp, size: u.size, auras: aurasOf(u), areas: areasOf(u), sheet: sheetOf(u),
    state: sim.unitState(u) }));
}

root.TacEngine = { Sim, AI_BASE, AI_PROFILES, AI_TIERS, TIER_PROFILES, tierOf, tierProfile, aiProfile, casterKind, deathOdds, castCopy, damageMultFor, areaSpec, areaCells, inArea, AI_TYPES, autoAI, previewPlacement, runDay, monteCarlo, summarize, describeRanges, makeRng, rollDice, avgDice, parseDice, inferRange, expandTeam };
})(typeof window !== 'undefined' ? window : globalThis);

