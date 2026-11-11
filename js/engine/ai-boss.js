/* TACTICAL ENGINE, part 9: the boss tier of AI v2 (file list and how the parts share names: js/engine/base.js).
   Design in docs/ai-v2.md, "Boss tier". */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { avgDice, freqKind, Sim, areaSpec } = ENG;

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

})(typeof window !== 'undefined' ? window : globalThis);
