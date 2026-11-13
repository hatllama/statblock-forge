/* TACTICAL ENGINE, part 6: reactions (file list and how the parts share names: js/engine/base.js).
   Design in docs/ai-v2.md, "Reactions as a layer". */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { rollDice, avgDice, damageMultFor, freqKind, Sim, otherTeam, reactFits } = ENG;

/* ----- reactions as a layer (docs/ai-v2.md, "Reactions as a layer") ----- */
/* what a reaction action is, from its shape; REACT_ON is what each kind is offered at, ext.react.on overrides it */
const REACT_ON = { ac: ['hit'], barbs: ['hit', 'save'], cut: ['damage'], counter: ['spell'], coin: ['hit'] };
function reactKind(x) {
  if (!x || x.actionSlot !== 4) return '';
  const ex = x.ext || {};
  if (ex.counterspell) return 'counter';
  if (ex.coin && x.type === 'buff' && x.target === 'self') return 'coin';       // Call It in the Air: a coin flip when hit (docs/ai-v2.md "Pasquale Minuzzi")
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
    // a coin-flip reaction on the target (Call It in the Air): it shares the one reaction with Shield and the rest, the best net wins
    const cn = tgt.v2 ? this.reactFind(tgt, 'coin', 'hit') : null;
    if (cn) { const val = this.reactCoinValue(S, tgt, cn), net = val - this.reactPrice(tgt, cn, val, 0); if (net > 0) cands.push({ who: tgt, x: cn, net, kind: 'coin' }); }
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
    else if (c.kind === 'coin') this.reactCoinDo(S, c.who, c.x);
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
/* Call It in the Air: heads turns this hit into a miss, tails leaves it and costs a disadvantaged attack roll of its own.
   The best one-hit damage the creature has, as the cost of one tails (react.coin.tails of it); the hit as the defender reads it, like Shield */
Sim.prototype.reactCoinValue = function (S, tgt, x) {
  const R = tgt.v2P, c = x.ext.coin, ph = typeof c.p === 'number' ? c.p : 0.5, dmg = this.kHitDmg(tgt, S.att, S.a) * (S.crit ? R.w.critDmg : 1);
  let mine = 0;
  for (const o of tgt.actions) if (o.type === 'atk' && !o.useSaves && o.actionSlot === 0) mine = Math.max(mine, avgDice((o.ext && o.ext.wtDpr) || o.dpr) / Math.max(1, o.targets || 1));
  const heads = c.heads && c.heads.miss ? dmg : 0, tails = c.tails && c.tails.buff && c.tails.buff.condition === 'Attacks with Disadvantage' ? mine * R.coin.tails : 0;
  return (ph * heads - (1 - ph) * tails) * R.coin.weight;
};
Sim.prototype.reactCoinDo = function (S, tgt, x) {
  this.reactTake(tgt, x, 0);
  const f = this.coinFlip(tgt, x);
  if (f.heads && f.out.miss) { S.hit = false; S.crit = false; }
  this.ev('react', `${tgt.name} uses ${x.name}: ${f.heads ? 'heads' : 'tails'} — ${this.coinWords(f.out)} (${S.att.name}'s ${Math.round(S.total)} vs AC ${Math.round(S.ac)})`, { uid: tgt.uid, target: S.att.uid });
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

Object.assign(ENG, { hitP });
})(typeof window !== 'undefined' ? window : globalThis);
