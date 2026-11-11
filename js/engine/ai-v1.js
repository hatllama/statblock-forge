/* TACTICAL ENGINE, part 7: the classic AI (file list and how the parts share names: js/engine/base.js).
   Which spell is worth it, tactical turn planning (tacticalTurnInner, plan), choosing an action per slot (choose). */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { avgDice, sizeIdx, freqKind, Sim, areaSpec, isHideAction, threatAt } = ENG;

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

})(typeof window !== 'undefined' ? window : globalThis);
