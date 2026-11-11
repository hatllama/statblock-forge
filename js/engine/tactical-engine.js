/* TACTICAL ENGINE: the parts not split out yet (file list and how the parts share names: js/engine/base.js).
   Still here, to be moved one module per commit: reactions.js, ai-v1.js, ai-v2.js, ai-boss.js, ai-v2-turn.js, encounter.js, day.js. */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { makeRng, parseDice, rollDice, avgDice, INCAP, DANGER_CONDS, ADV_TARGET, ADV_SELF, sizeIdx, finalizeAction, inferRange, damageMultFor, AI_TYPES, autoAI, casterKind, smiteOf, smiteDice, effectName, isHpPool, recoverSlots, makeUnit, freqKind, resetFightState, Sim, areaSpec, areaCells, inArea, MAX_ALT, isHideAction, bodyEdge, offBody, areaOnBody, AI_BASE, AI_PROFILES, aiProfile, AI_TIERS, TIER_PROFILES, tierOf, tierProfile, otherTeam, threatAt, DUR_WEIGHT, reactFits } = ENG;
/* ----- reactions as a layer (docs/ai-v2.md, "Reactions as a layer") ----- */
/* what a reaction action is, from its shape; REACT_ON is what each kind is offered at, ext.react.on overrides it */
const REACT_ON = { ac: ['hit'], barbs: ['hit', 'save'], cut: ['damage'], counter: ['spell'] };
function reactKind(x) {
  if (!x || x.actionSlot !== 4) return '';
  const ex = x.ext || {};
  if (ex.counterspell) return 'counter';
  if (x.type === 'buff' && x.target === 'self' && x.buff) {
    if (x.buff.ac !== undefined) return 'ac';
    if (x.buff.damageTakenMultiplier !== undefined || x.buff.damageReduction !== undefined) return 'cut';
  }
  if (x.type === 'debuff' && x.buff && x.buff.condition === 'Attacks with Disadvantage' && !ex.cancelAction) return 'barbs';
  return '';
}
function reactOn(x, trig) {
  const rx = x.ext && x.ext.react, k = reactKind(x);
  return (rx && rx.on ? rx.on : REACT_ON[k] || []).indexOf(trig) >= 0;
}
/* u's first reaction of this kind that this trigger offers and its limits allow (null when it has no reaction left) */
Sim.prototype.reactFind = function (u, kind, trig, info) {
  if (!u.reaction || u.dead || u.hp <= 0 || this.incap(u) || !u.onBoard) return null;
  return u.actions.find(x => reactKind(x) === kind && reactOn(x, trig) && reactFits(x, info || { roll: true }) && this.usable(u, x) && this.condOk(u, x)) || null;
};
/* spend the reaction (and the slot, at level L when set) */
Sim.prototype.reactTake = function (u, x, L) {
  u.reaction = false;
  if (L) u.castAt = L;
  this.spend(u, x); u.castAt = 0;
};
/* the price of taking x for `val` points: the reaction itself, then the pacing cost of its slot, use or resource (Revivify reserve included) */
Sim.prototype.reactPrice = function (u, x, val, L) {
  return u.v2P.react.base + this.v2PaceCost(u, x, Math.max(0, val), L || 0);
};
/* the attacker's to-hit bonus as the defender reads it: open, the sheet; otherwise the total it was shown less an average die */
Sim.prototype.kToHit = function (u, att, a, total) {
  if (!this.kOf(u, att)) return Number(avgDice(a.toHit)) + this.sumBuff(att, 'toHit', false);
  return total - 10.5;
};
/* one hit of this attack on u, as u reads it (open: the dice; otherwise the damage the attacker has been seen to deal, per swing) */
Sim.prototype.kHitDmg = function (u, att, a) {
  if (this.kOf(u, att)) return this.kDpr(u, att) / Math.max(1, a.targets || 1);
  return avgDice((a.ext && a.ext.wtDpr) || a.dpr) * this.multBuff(att, 'damageMultiplier') * damageMultFor(a, u) * this.multBuff(u, 'damageTakenMultiplier');
};
/* the foes that still act between now (att's turn) and u's next turn and could reach u */
Sim.prototype.foesToAct = function (u, att) {
  const ord = this.order, n = ord ? ord.length : 0, i0 = n ? ord.indexOf(att) : -1;
  if (i0 < 0 || this.current !== att) return [];
  const out = [];
  for (let k = 1; k < n; k++) {
    const e = ord[(i0 + k) % n];
    if (e === u) break;
    if (e.team === u.team || !e.onBoard || !this.alive(e) || this.incap(e)) continue;
    const reach = this.kOf(u, e) ? this.kReach(u, e) : Math.max.apply(null, [5].concat(e.actions.filter(o => o.type === 'atk' && o.actionSlot === 0).map(o => o._range || 5)));
    if (this.dist(u, e) <= this.speedOf(e) + reach) out.push(e);
  }
  return out;
};
/* chance of a hit on a d20 with bonus b against armor class ac (nat 1 and 20 as ever) */
const hitP = (b, ac) => Math.min(0.95, Math.max(0.05, (21 + b - ac) / 20));
/* faces of a reroll that miss, of 20 (the new die is taken if lower, so only a miss turns a hit into one) */
function missFaces(b, ac) { let n = 0; for (let f = 1; f <= 20; f++) if (f === 1 || (f !== 20 && f + b < ac)) n++; return n; }

/* ---- the old thresholds, moved out of attackRoll unchanged; v1 creatures use them (S = the roll so far: r, total, hit, crit, ac, toHit) ---- */
Sim.prototype.reactBarbsOld = function (S, opt) {
  const att = S.att, tgt = S.tgt, a = S.a, r = S.r, toHit = S.toHit;
  let total = S.total, hit = S.hit, crit = S.crit, ac = S.ac;
  // Silvery-Barbs-style reactions from the target's side: reroll, take the lower
  if (hit && !opt.noReact) {
    const avgHit = avgDice(a.dpr) * (r === 20 ? 1.6 : 1);
    const matters = r === 20 || avgHit >= tgt.maxHp * 0.25 || avgHit >= tgt.hp || (a.ext && (a.ext.grapple || a.ext.swallow)) || !!a.riderEffect;
    const helper = this.alliesOf(tgt).find(h => !h.v2 && h.reaction && !this.incap(h) && h.onBoard && this.dist(h, att) <= 60 && this.losU(h, att) && (h.ai !== 'tactical' || matters) &&
      h.actions.some(x => x.actionSlot === 4 && x.type === 'debuff' && x.buff && x.buff.condition === 'Attacks with Disadvantage' && !(x.ext && x.ext.cancelAction) && (!(x.ext && x.ext.selfOnly) || h === tgt) && this.usable(h, x) && this.condOk(h, x)));
    if (helper) {
      const x = helper.actions.find(y => y.actionSlot === 4 && y.type === 'debuff' && y.buff && y.buff.condition === 'Attacks with Disadvantage' && !(y.ext && y.ext.cancelAction) && (!(y.ext && y.ext.selfOnly) || helper === tgt) && this.usable(helper, y) && this.condOk(helper, y));
      helper.reaction = false; this.spend(helper, x);
      const xdc = Number(avgDice(x.saveDC));
      const resisted = xdc < 99 && this.saveRoll(att, xdc, helper, x.ext && x.ext.saveAbility).success;
      const r2 = resisted ? r : Math.min(r, this.R.d(20));
      if (resisted) this.ev('react', `${helper.name} uses ${x.name}, but ${att.name} resists`, { uid: helper.uid, target: att.uid });
      else this.ev('react', `${helper.name} ${x._spell ? 'casts' : 'uses'} ${x.name}: ${att.name} rerolls (${r} → ${r2})`, { uid: helper.uid, target: att.uid });
      total = r2 + toHit; hit = r2 === 20 || (r2 !== 1 && total >= ac); crit = r2 === 20;
    }
  }
  S.total = total; S.hit = hit; S.crit = crit; S.ac = ac;
};

Sim.prototype.reactLuckyOld = function (S, opt) {
  const att = S.att, tgt = S.tgt, a = S.a, r = S.r, toHit = S.toHit;
  let total = S.total, hit = S.hit, crit = S.crit, ac = S.ac;
  // Lucky: the target spends a luck point to impose disadvantage on a hit that matters
  if (hit && !opt.noReact && !tgt.v2 && tgt.luckMax && (tgt.uses.get('__luck') || 0) > 0) {
    const avgHit2 = avgDice((a.ext && a.ext.wtDpr) || a.dpr) * (r === 20 ? 1.6 : 1);
    if (r === 20 || avgHit2 >= tgt.hp || avgHit2 >= tgt.maxHp * 0.3 || tgt.ai !== 'tactical') {
      tgt.uses.set('__luck', tgt.uses.get('__luck') - 1);
      const r2 = Math.min(r, this.R.d(20));
      total = r2 + toHit; hit = r2 === 20 || (r2 !== 1 && total >= ac); crit = r2 === 20;
      this.ev('react', `${tgt.name} spends a luck point: ${att.name} rerolls (${r} → ${r2})`, { uid: tgt.uid, target: att.uid });
    }
  }
  S.total = total; S.hit = hit; S.crit = crit; S.ac = ac;
};

Sim.prototype.reactShieldOld = function (S, opt) {
  const att = S.att, tgt = S.tgt, a = S.a, r = S.r, toHit = S.toHit;
  let total = S.total, hit = S.hit, crit = S.crit, ac = S.ac;
  // Shield-style reactions on the target: an AC boost that would turn the hit into a miss
  if (hit && !crit && !opt.noReact && !tgt.v2 && tgt.reaction && !this.incap(tgt)) {
    const sh = tgt.actions.find(x => x.actionSlot === 4 && x.type === 'buff' && x.target === 'self' && x.buff && x.buff.ac !== undefined && this.usable(tgt, x) && this.condOk(tgt, x));
    const hurts = !sh || tgt.ai !== 'tactical' || r === 20 || avgDice(a.dpr) >= tgt.hp * 0.3 || tgt.hp < tgt.maxHp * 0.6 || freqKind(sh.freq) === 'at will';
    if (sh && hurts && total < ac + avgDice(sh.buff.ac)) {
      tgt.reaction = false; this.spend(tgt, sh);
      this.addBuff(tgt, tgt, sh, sh.buff);
      ac = this.ac(tgt) + this.coverAC(att, tgt); hit = false;
      this.ev('react', `${tgt.name} ${sh._spell ? 'casts' : 'uses'} ${sh.name} (AC ${ac})`, { uid: tgt.uid });
    }
  }
  S.total = total; S.hit = hit; S.crit = crit; S.ac = ac;
};


/* ---- v2: the same reactions, scored ---- */
/* Shield: this hit if it turns it into a miss, + the attacks still to come before its next turn */
Sim.prototype.reactShieldValue = function (S, tgt, x) {
  const R = tgt.v2P.react, bonus = avgDice(x.buff.ac), margin = S.total - S.ac;
  const dmg = this.kHitDmg(tgt, S.att, S.a), crit = tgt.v2P.w.critDmg;
  let val = !S.crit && margin < bonus ? dmg : 0;
  const bh = this.kToHit(tgt, S.att, S.a, S.total), ac = this.ac(tgt) + this.coverAC(S.att, tgt);
  const gain = Math.max(0, hitP(bh, ac) - hitP(bh, ac + bonus));
  val += (this._strikeBy === S.att ? this._strikesLeft : 0) * gain * dmg;
  for (const e of this.foesToAct(tgt, S.att)) val += this.kDpr(tgt, e) * Math.min(1, (bonus / 20) / R.hitP) * R.round;
  return val;
};
/* Silvery Barbs / Lucky on a hit: the chance the lower of two dice misses, × the hit */
Sim.prototype.reactRerollValue = function (S, tgt, who) {
  const bh = this.kToHit(tgt, S.att, S.a, S.total), ac = S.ac;
  return missFaces(bh, ac) / 20 * this.kHitDmg(tgt, S.att, S.a) * (S.d === 20 ? who.v2P.w.critDmg : 1);
};
Sim.prototype.reactHitV2 = function (S, opt) {
  for (let round = 0; round < 3 && S.hit; round++) {
    const cands = [];
    const tgt = S.tgt, att = S.att;
    // Shield on the target
    if (!S.crit) {
      const sh = tgt.v2 ? this.reactFind(tgt, 'ac', 'hit') : null;
      if (sh) { const val = this.reactShieldValue(S, tgt, sh), net = val - this.reactPrice(tgt, sh, val, 0); if (net > 0) cands.push({ who: tgt, x: sh, net, kind: 'ac' }); }
    }
    // Silvery Barbs from any v2 ally that sees the attacker
    for (const h of this.alliesOf(tgt)) {
      if (!h.v2 || !h.reaction || !h.onBoard || this.dist(h, att) > 60) continue;
      const x = this.reactFind(h, 'barbs', 'hit');
      if (!x || (x.ext && x.ext.selfOnly && h !== tgt) || !this.losU(h, att)) continue;
      const ally = this.v2AllyGain(h);
      const val = this.reactRerollValue(S, tgt, h) + ally, net = val - this.reactPrice(h, x, val, 0);
      if (net > 0) cands.push({ who: h, x, net, kind: 'barbs' });
    }
    if (!cands.length) break;
    cands.sort((p, q) => q.net - p.net);
    const c = cands[0];
    if (c.kind === 'ac') this.reactShieldDo(S, c.who, c.x);
    else this.reactBarbsDo(S, c.who, c.x);
  }
  // Lucky (no reaction): a luck point against a hit
  const tgt = S.tgt;
  if (S.hit && tgt.v2 && tgt.luckMax && (tgt.uses.get('__luck') || 0) > 0) {
    const val = this.reactRerollValue(S, tgt, tgt);
    if (val > tgt.v2P.react.luck) {
      tgt.uses.set('__luck', tgt.uses.get('__luck') - 1);
      const d2 = Math.min(S.d, this.R.d(20)), was = Math.round(S.total);
      this.reactApplyDie(S, d2);
      this.ev('react', `${tgt.name} spends a luck point: ${S.att.name}'s attack roll ${was} rerolls to ${Math.round(S.total)} vs AC ${Math.round(S.ac)}, ${S.hit ? 'still hits' : 'now misses'}`, { uid: tgt.uid, target: S.att.uid });
    }
  }
};
/* the best ally's DPR, a share of it for the advantage Silvery Barbs gives */
Sim.prototype.v2AllyGain = function (h) {
  let best = 0;
  for (const o of this.alliesOf(h)) if (o.onBoard && this.alive(o) && !this.incap(o) && o.dpr > best) best = o.dpr;
  return best * h.v2P.react.ally;
};
Sim.prototype.reactApplyDie = function (S, d) {
  S.d = d; S.total = d + S.toHit;
  S.hit = d === 20 || (d !== 1 && S.total >= S.ac); S.crit = d === 20;
};
Sim.prototype.reactShieldDo = function (S, tgt, x) {
  const was = Math.round(S.total), acWas = Math.round(S.ac);
  this.reactTake(tgt, x, 0);
  this.addBuff(tgt, tgt, x, x.buff);
  S.ac = this.ac(tgt) + this.coverAC(S.att, tgt);
  S.hit = S.d === 20 || (S.d !== 1 && S.total >= S.ac);
  this.ev('react', `${tgt.name} ${x._spell ? 'casts' : 'uses'} ${x.name}: ${was} would hit AC ${acWas}, ${S.hit ? 'still hits' : 'now misses'} (AC ${Math.round(S.ac)})`, { uid: tgt.uid });
};
Sim.prototype.reactBarbsDo = function (S, h, x) {
  const att = S.att;
  this.reactTake(h, x, 0);
  const xdc = Number(avgDice(x.saveDC));
  const resisted = xdc < 99 && this.saveRoll(att, xdc, h, x.ext && x.ext.saveAbility).success;
  const was = Math.round(S.total);
  if (resisted) { this.ev('react', `${h.name} uses ${x.name}, but ${att.name} resists`, { uid: h.uid, target: att.uid }); return; }
  this.reactApplyDie(S, Math.min(S.d, this.R.d(20)));
  const ally = this.reactGrantAdv(h);
  this.ev('react', `${h.name} ${x._spell ? 'casts' : 'uses'} ${x.name}: ${att.name}'s attack roll ${was} rerolls to ${Math.round(S.total)} vs AC ${Math.round(S.ac)}, ${S.hit ? 'still hits' : 'now misses'}${ally ? `; ${ally.name} gains advantage` : ''}`, { uid: h.uid, target: att.uid });
};
/* Silvery Barbs also gives one ally within 30 ft advantage on its next attack (the best hitter) */
Sim.prototype.reactGrantAdv = function (h) {
  let best = null;
  for (const o of this.alliesOf(h)) if (o.onBoard && this.alive(o) && !this.incap(o) && this.dist(o, h) <= 30 && (!best || o.dpr > best.dpr)) best = o;
  if (best) this.addBuff(best, h, { id: 'barbs-adv', name: 'Silvery Barbs' }, { duration: 'until next attack made', condition: 'Attacks with Advantage' });
  return best;
};
/* Silvery Barbs on a foe's save that succeeded against us: the reroll takes the lower die. The best ally that sees it and finds it worth the slot, or null */
Sim.prototype.reactSaveV2 = function (t, dc, src, ab) {
  const stakes = this._saveStakes || 0, dmg = (this._saveDmg || 0) * (this._saveHalf ? 0.5 : 1);
  let pick = null;
  for (const h of this.alliesOf(src)) {
    if (!h.v2 || !h.reaction || !h.onBoard || this.dist(h, t) > 60) continue;
    const x = this.reactFind(h, 'barbs', 'save', { roll: false });
    if (!x || (x.ext && x.ext.selfOnly) || !this.losU(h, t)) continue;
    // the new die fails the save when it is below what the save needs: faces 1 .. need - 1, of 20
    const failFaces = Math.max(0, Math.min(20, Math.ceil(dc - this.kSave(h, t, ab)) - 1));
    const val = (failFaces / 20) * (dmg + stakes * h.v2P.react.stakes) + this.v2AllyGain(h);
    const net = val - this.reactPrice(h, x, val, 0);
    if (net > 0 && (!pick || net > pick.net)) pick = { h, x, net };
  }
  return pick;
};
/* Uncanny Dodge, Deflect Attacks: at will, once a round: this hit or a bigger one still to come? */
Sim.prototype.reactCutNow = function (u, r, dmg, src, info) {
  const R = u.v2P.react, P = u.v2P.pacing;
  const mult = typeof r.buff.damageTakenMultiplier === 'number' ? r.buff.damageTakenMultiplier : 1, cutAmt = avgDice(r.buff.damageReduction || 0);
  const cutOf = d => d - Math.floor(Math.max(0, d * mult - cutAmt));
  const drops = dmg >= u.hp && Math.floor(Math.max(0, dmg * mult - cutAmt)) < u.hp;
  const now = cutOf(dmg) * (drops ? P.reactDrop : 1);
  if (drops) return now > 0;
  const left = src && this._strikeBy === src ? this._strikesLeft : 0;
  const foes = src && info && info.attack ? this.foesToAct(u, src) : [];
  const L = left + foes.length * R.round;
  if (L <= 0) return now > 0;
  let big = dmg;
  for (const e of foes) big = Math.max(big, this.kDpr(u, e) / R.perFoe);
  big *= 1 + R.spread;
  const wait = (1 - Math.pow(1 - R.hitP, Math.min(L, R.maxL))) * cutOf(big);
  return now > 0 && now >= wait;
};

/* ---- Counterspell (docs/ai-v2.md): a foe casts within 60 ft; its Constitution save against the counter's spell save DC, or the spell fails and the slot comes back ---- */
Sim.prototype.spellDcOf = function (u) {
  if (u._spellDc) return u._spellDc;
  let dc = 0;
  for (const x of u.actions) {
    if (!x._spell) continue;
    const d = x.type === 'atk' && x.useSaves ? Number(avgDice(x.toHit)) : x.type === 'debuff' && x.saveDC !== undefined ? Number(avgDice(x.saveDC)) : 0;
    if (d < 99 && d > dc) dc = d;
  }
  return (u._spellDc = dc || 13);
};
/* 2014 Counterspell: the proficiency bonus read off the counter's highest spell slot (no ability scores in the engine: ability bonus = DC - 8 - proficiency) */
const COUNTER_PROF = [2, 2, 3, 3, 4, 4, 5, 5, 6];
Sim.prototype.counterBonus = function (o) {
  let top = 0;
  if (o.slotsMax) o.slotsMax.forEach((n, i) => { if (n) top = i + 1; });
  return this.spellDcOf(o) - 8 - (top ? COUNTER_PROF[top - 1] : 2);
};
/* the level a cast spell counts as (2014): the slot it was cast at; an innate-spell monster's own level, 3 when unknown */
Sim.prototype.castSpellLevel = function (u, a) {
  return a._spell ? (a._spell.level ? (u.castLevel || a._spell.level) : 0) : (a.ext && a.ext.innateLevel) || 3;
};
/* does the counter know what it is facing? (open: yes; learn: once this kind has cast it; blind: only that a spell is coming) */
Sim.prototype.counterKnown = function (o, u, a) {
  const m = this.kOf(o, u);
  return !m || (m === 'learn' && this.learning(o.team) && !!(this.kind(o.team, u).spells || {})[a.id]);
};
/* 2014 options for countering a spell of level SL: slot level L (0 = the lowest, a 3rd) and the chance it works */
Sim.prototype.counterOptions2014 = function (o, SL, bonus, check) {
  const base = this.slotFor(o, 3), out = [];
  const pCheck = Math.min(1, Math.max(0, (21 + bonus - (10 + SL)) / 20));
  out.push({ L: 0, slot: base, p: SL <= 3 || base >= SL ? 1 : pCheck });
  if (SL >= 4 && check) for (let l = Math.max(SL, base + 1); l <= 9; l++) if (o.slots[l - 1] > 0 && !this.v2Eats(o, l)) out.push({ L: l, slot: l, p: 1 });
  return out;
};
/* what the spell would do to the counter's side, as that side reads it: open, the spell as cast; learn, the same once this kind has been seen casting it;
   blind (and a first sight in learn), only that a spell is coming: the caster's damage over a few rounds */
Sim.prototype.counterValue = function (o, u, a, plan) {
  const R = o.v2P.react, m = this.kOf(o, u);
  const known = !m || (m === 'learn' && this.learning(o.team) && (this.kind(o.team, u).spells || {})[a.id]);
  if (!known) return this.kDpr(o, u) * R.blindRounds;
  let v = 0;
  for (const t of plan.targets) {
    if (t.team === u.team) { if (a.type === 'heal') v += avgDice(a.amount) * 0.5; continue; }
    v += Math.max(0, this.expected(u, a, t));
  }
  return v * (a._spell && a._spell.conc ? R.conc : 1);
};
Sim.prototype.counterCheck = function (u, a, plan) {
  let pick = null;
  for (const o of this.enemiesOf(u)) {
    if (!o.reaction || o.dead || o.hp <= 0 || !o.onBoard || this.dist(o, u) > 60) continue;
    const x = this.reactFind(o, 'counter', 'spell', { roll: false });
    if (!x || !this.losU(o, u)) continue;
    const dc = this.spellDcOf(o);
    let net, L = 0;
    if (o.v2 && this.rules.counterspell === '2014') {
      const R = o.v2P.react, SL = this.counterKnown(o, u, a) ? this.castSpellLevel(u, a) : R.blindLevel, val = this.counterValue(o, u, a, plan);
      net = -Infinity;
      for (const op of this.counterOptions2014(o, SL, this.counterBonus(o), true)) { const n = op.p * val - this.reactPrice(o, x, val, op.L); if (n > net) { net = n; L = op.L; } }
    } else if (o.v2) {
      // P(its save fails) x what the spell is worth, against the slot and the reaction (paid whether or not it works)
      const pFail = Math.min(1, Math.max(0, 1 - (21 + this.kSave(o, u, 'con') - dc) / 20));
      const val = this.counterValue(o, u, a, plan);
      net = pFail * val - this.reactPrice(o, x, val, 0);
    } else net = (!a._spell || a._spell.level >= 1) && (a.type === 'atk' || a.type === 'debuff') ? 1 : -1;
    if (net > 0 && (!pick || net > pick.net)) pick = { o, x, dc, net, L };
  }
  if (this.learning(otherTeam(u.team))) { const k = this.kind(otherTeam(u.team), u); (k.spells = k.spells || {})[a.id] = true; }
  if (!pick) return false;
  const o = pick.o, x = pick.x, dc = pick.dc;
  this.reactTake(o, x, pick.L);
  if (this.rules.counterspell === '2014') {
    // SRD 5.1: 3rd level or lower fails; 4th or higher needs an ability check against 10 + its level, unless the slot used is at least its level; the slot of the spell is spent either way
    const SL = this.castSpellLevel(u, a), used = o.castLevel || 3, bonus = this.counterBonus(o);
    let how = '', ok = SL <= 3 || used >= SL;
    if (!ok) { const r = this.d20(false, false, false); ok = r + bonus >= 10 + SL; how = ' (check ' + (r + bonus) + ' vs DC ' + (10 + SL) + ')'; }
    if (!ok) { this.ev('react', `${o.name} casts ${x.name} on ${u.name}'s ${a.name}, but it goes off${how}`, { uid: o.uid, target: u.uid }); return false; }
    if (a._spell && a._spell.conc && u.concentrating === a.id) u.concentrating = null;
    this.ev('react', `${o.name} casts ${x.name}${used > 3 ? ' at level ' + used : ''}: ${u.name}'s ${a.name} fizzles${how}`, { uid: o.uid, target: u.uid });
    return true;
  }
  const sv = this.saveRoll(u, dc, o, 'con');
  if (sv.success) { this.ev('react', `${o.name} casts ${x.name} on ${u.name}'s ${a.name}, but it goes off (Con save ${sv.total} vs DC ${dc})`, { uid: o.uid, target: u.uid }); return false; }
  const lvl = a._spell && a._spell.level ? u.castLevel : 0;
  if (lvl > 0 && u.slots && u.slots[lvl - 1] !== undefined) u.slots[lvl - 1]++;        // a countered spell's slot isn't spent (2024)
  if (a._spell && a._spell.conc && u.concentrating === a.id) u.concentrating = null;
  this.ev('react', `${o.name} casts ${x.name}: ${u.name}'s ${a.name} fizzles (Con save ${sv.total} vs DC ${dc}${lvl ? ', slot kept' : ''})`, { uid: o.uid, target: u.uid });
  return true;
};

/* Deflect Attacks, redirect (2024): a hit cut to 0 can be sent back for 1 Focus Point: the attacker (within 5 ft of a melee attack, 60 ft of a ranged one)
   saves against the monk's DC or takes two Martial Arts dice + Dex. v2 weighs P(the save fails) x the damage against the point's pacing price; v1 always does it. */
Sim.prototype.reactRedirect = function (u, r, src, info) {
  const rd = r.ext.react.redirect, key = 'res:' + rd.resource;
  if (!src || src === u || src.team === u.team || src.dead || src.hp <= 0 || !src.onBoard || (u.uses.get(key) || 0) < (rd.cost || 1)) return;
  const melee = !info.a || (info.a._range || 5) <= 10;
  if (this.dist(u, src) > (melee ? 5 : 60) || !this.losU(u, src)) return;
  if (u.v2) {
    const pFail = Math.min(1, Math.max(0, 1 - (21 + this.kSave(u, src, 'dex') - rd.dc) / 20)), val = pFail * avgDice(rd.dice);
    if (val <= this.v2PaceCost(u, { id: r.id + ':redirect', ext: { resource: rd.resource, resourceCost: rd.cost || 1 } }, val, 0)) return;
  }
  u.uses.set(key, u.uses.get(key) - (rd.cost || 1));
  const sv = this.saveRoll(src, rd.dc, u, 'dex');
  if (sv.success) { this.ev('react', `${u.name} redirects the blow at ${src.name}, who dodges it (Dex save ${sv.total} vs DC ${rd.dc})`, { uid: u.uid, target: src.uid }); return; }
  const d = this.damage(u, src, Math.max(0, Math.floor(rollDice(rd.dice, this.R, false))), { type: info.type || (info.a && info.a.ext && info.a.ext.damageType) || 'bludgeoning' });
  this.ev('react', `${u.name} redirects the blow at ${src.name} (Dex save ${sv.total} vs DC ${rd.dc}): ${d} damage`, { uid: u.uid, target: src.uid, dmg: d });
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
  const left = this.leftFor(u);
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
        this.alliesOf(u).some(o => o.onBoard && this.alive(o) && this.dist(o, t) <= this.meleeReach(t))) v += this.kDpr(u, t) * 0.5;
    if (a.ext && a.ext.zone && a.ext.zone.difficult) v += 2;
    if (!this.areaCatch(act, t, p.dest.x, p.dest.y, pool, u) && a.type === 'debuff') for (const o of p.targets.slice(1)) v += this.expected(u, act, o);
    if (a.type === 'atk' && !act.useSaves) for (const o of p.targets.slice(1)) v += Math.min(this.expected(u, act, o), this.kHp(u, o) + 4);
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
    for (const t of p.targets) v += this.effectValue(act.buff, t, false, u);
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
  if (this.record && !u.notedPacing && u.team === 'party' && this.leftFor(u) && u.actions.some(a => a.actionSlot === 0 && this.usable(u, a) && this.holdsResource(u, a))) {
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
  const prevF = this._flyer; this._flyer = u.fly && this.airborne(u) ? u : null;
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
      if (pl.limited && lone && atWill.length && this.kHp(u, lone) <= Math.max(...atWill.map(w => this.expected(u, w.a, lone))) * 1.5) continue;
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
          if (pl.act.ext && pl.act.ext.minCatch && 1 + ac.extra.length < pl.act.ext.minCatch) continue;   // Entangle & co.: only worth it on a crowd
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
        if (pl.range > 10 && !pl.a.useSaves && pl.a.type === 'atk' && engagedHere && !(pl.a.ext && pl.a.ext.anyRange)) v *= 0.6;     // shooting in melee
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
  const blindTo = this.kMode(u.team) !== 'open';
  const threatInfo = foes.filter(e => !this.incap(e) && e.hp > 0).map(e => {
    let dmg = 0, reach = 5;
    if (blindTo) { dmg = this.kDpr(u, e) * Math.min(1, Math.max(0.3, (21 + 5 - u.baseAC) / 20)) / 0.65; reach = this.kReach(u, e); }
    else for (const a of e.actions) {
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
      else if (d <= ti.reach) t += ti.dmg / (1 + ti.others) * (this.T.any && !this.losB(ti.e.x, ti.e.y, ti.e.n, x, y, u.n) ? 0.4 : 1);
      for (const au of ti.aura) if (d <= au.r) t += au.d;
    }
    return t;
  };
  // group sensibly: spread out against area attacks
  // the area attacks it knows the other side has: don't bunch up where one could catch several of us
  const areaThreats = [];
  for (const e of foes) if (!this.incap(e)) for (const ar of this.kAreas(u, e)) areaThreats.push({ e, shape: ar.shape, size: ar.size, range: ar.range, w: Math.min(3, Math.max(0.6, ar.dmg / 10)) });
  const spacingAt = (x, y) => {
    let pen = 0;
    for (const at of areaThreats) {
      let near;
      if (at.shape === 'cone' || at.shape === 'line') {
        // a cone or line starts at its user: in a bunch within its length of them is where it lands
        if (this.distXY(x, y, at.e) > at.size + 5) continue;
        const r = Math.max(10, at.size / 2);
        near = 0;
        for (const o of myTeam) if (o !== u && this.distXY(x, y, o) <= r && this.dist(o, at.e) <= at.size + 5) near++;
      } else {
        if (this.distXY(x, y, at.e) > at.range + at.size * 2) continue;
        const r = Math.min(30, at.shape === 'sphere' ? at.size * 2 : at.size);     // two creatures this close can share one blast
        near = 0;
        for (const o of myTeam) if (o !== u && this.distXY(x, y, o) <= r) near++;
      }
      pen += near * 1.2 * at.w;
    }
    return pen;
  };

  // opportunity attacks it would take walking a path
  const oaCost = (path, disengaged) => {
    if (disengaged || !path.length) return 0;
    let cost = 0, cx = u.x, cy = u.y;
    const used = new Set();
    for (const st of path) {
      for (const e of this.adjacentEnemies(u, cx, cy)) {
        if (used.has(e) || !e.reaction || e.noOA || this.distXY(st.x, st.y, e) <= this.meleeReach(e)) continue;
        const a = e.actions.find(o => o.type === 'atk' && !o.useSaves && o.actionSlot === 0 && o._range <= 10 && !(o.ext && o.ext.swallow));
        if (a) { cost += blindTo ? this.kDpr(u, e) * 0.4 : this.expected(e, Object.assign({}, a, { targets: 1 }), u); used.add(e); }
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
  const taken = this.takenFor(u);
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
      if ((x === u.x && y === u.y) || taken[x + y * W] || (u.n > 1 ? !this.fits(u, x, y) : this.isWall(x, y)) || !this.losB(u.x, u.y, u.n, x, y, u.n)) continue;
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
  else if (best.mode === 'act' && best.path.length && best.off && best.off.pl && areaSpec(best.off.pl.act) && best.off.why === 'cluster') note = `${u.name} moves to line up ${best.off.pl.a.name}`;
  else if (best.mode === 'act' && best.path.length && nearFoe(best.x, best.y) > nearFoe(u.x, u.y) && nearFoe(u.x, u.y) <= 15) note = meleeSelf && hpFrac > 0.5 ? `${u.name} repositions` : `${u.name} falls back to keep its distance`;
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
  const prevF = this._flyer; this._flyer = u.fly && this.current === u && this.airborne(u) ? u : null;   // off its turn it can't change height
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
    ci = { adj: new Int8Array(N), nd: new Int16Array(N), occ: null, leave: new Int8Array(N) };
    ci.occ = this.takenFor(u);
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
               area: { shape: ac.spec.shape, size: ac.spec.size, ox: ac.ox !== undefined ? ac.ox : d.x, oy: ac.oy !== undefined ? ac.oy : d.y, tx: ac.ax, ty: ac.ay, cells: ac.cells, bn: ac.spec.bn } };
    }
    if (n > 1 && (a.useSaves || a.type === 'debuff' || a.type === 'buff' || a.type === 'heal')) {
      // area / multi-target: extra creatures clustered near the first one (allies: anyone within range of the caster)
      const extra = this.orderBySelector(pool.filter(o => o !== t && (offensive ? this.dist(o, t) <= ((a.ext && a.ext.pairWithin) || 10) : this.distXY(d.x, d.y, o) <= range)), a.target)
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

/* first usable action of a slot that has a valid plan within `budget` ft of movement */
/* ----- choosing an action (classic AI) ----- */
Sim.prototype.choose = function (u, slot, budget) {
  const list = u.actions.filter(a => a.actionSlot === slot && !(a.ext && a.ext.teleport) && this.usable(u, a) && this.condOk(u, a) && !(slot === 0 && this.holdsResource(u, a)));
  for (let k = 0; k < list.length; k++) {
    const a = list[k];
    const p = this.plan(u, a, budget);
    if (!p) continue;
    if (a.ext && a.ext.minCatch && p.targets.filter(t => t.team !== u.team).length < a.ext.minCatch) continue;
    if (u.ai === 'tactical' && (a.type === 'atk' || a.type === 'debuff')) {
      const k2 = freqKind(a.freq), limited = k2 !== 'at will' && k2 !== 'recharge';
      const rest = list.slice(k + 1).filter(b => b.type === 'atk' && freqKind(b.freq) === 'at will');
      if (limited && rest.length) {
        const foes = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e));
        // don't burn a spell slot on one foe the at-will attack can finish
        if (foes.length === 1 && this.kHp(u, foes[0]) <= Math.max(...rest.map(b => this.expected(u, b, foes[0]))) * 1.5) continue;
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
  if (p.why === 'cluster' && p.targets.filter(o => o.team !== u.team).length < 2) return;
  const t = p.targets[0];
  const key = p.why + ':' + t.uid;
  if (u.lastIntent === key) return;
  u.lastIntent = key;
  const txt = {
    finish: `${u.name} goes after ${t.name}, who looks ready to drop`,
    healer: `${u.name} goes for the healer, ${t.name}`,
    concentration: `${u.name} hits ${t.name} to break their concentration${t.concentrating ? ' on ' + ((t.actions.find(x => x.id === t.concentrating) || {}).name || 'a spell') : ''}`,
    threat: `${u.name} focuses ${t.name}, the biggest threat`,
    focus: `${u.name} piles onto ${t.name} with the others`,
    cluster: `${u.name} lines up ${a.name} to catch ${p.targets.filter(o => o.team !== u.team).length} of them`,
    revive: `${u.name} rushes to get ${t.name} back up`,
    retaliate: `${u.name} turns on ${t.name}, who hurt it`,
    nearest: `${u.name} lunges at the nearest prey, ${t.name}`,
    execute: `${u.name} decides to finish off ${t.name}, who keeps getting back up`,
    grudge: `${u.name} has had enough of them getting back up, and strikes the fallen ${t.name}`,
    maul: `${u.name} keeps mauling ${t.name}`,
  }[p.why];
  if (txt) this.ev('intent', txt, { uid: u.uid, target: t.uid });
};

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
Sim.prototype.v2SelfValue = function (u, a, ctx) {
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

