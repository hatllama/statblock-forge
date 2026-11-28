/* TACTICAL ENGINE, part 11: a turn and a fight (file list and how the parts share names: js/engine/base.js).
   A creature's turn (turn: carries out what either AI decided), flying height, legendary & lair actions, morale,
   running an encounter, placing units. */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { rollDice, ADV_TARGET, ADV_SELF, freqKind, Sim, MAX_ALT, isReckless, homeElsewhere } = ENG;

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
  if (u.traits && u.traits.turnStart) this.traitRun(u, 'turnStart', {});
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
  this.standUp(u);                  // prone: stands, for half its speed (2024)
  // passives (Other 1 / Other 2): self buffs keep themselves up
  for (const a of u.actions) {
    if ((a.actionSlot === 5 || a.actionSlot === 6) && a.type === 'buff' && this.usable(u, a) && this.condOk(u, a)) {
      if (isReckless(a)) continue;     // v2 weighs Reckless Attack each turn (v2Reckless)
      const already = u.buffs.some(b => b.id === a.id);
      if (!already) { this.spend(u, a); this.doAction(u, a, { targets: this.plan(u, a, 0) ? this.plan(u, a, 0).targets : [u] }); }
    }
  }
  if (this.surpriseRules === '2014' && this.round === 1 && this.surprised[u.team]) { this.ev('skip', `${u.name} is surprised`, { uid: u.uid }); return; }
  if (this.incap(u)) { this.ev('skip', `${u.name} can't act`, { uid: u.uid }); this.endTurn(u); return; }

  if (u.swallowedBy) { this.insideTurn(u); this.endTurn(u); return; }

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
      const r = this.d20(false, false, false, u, 'check') + u.escapeBonus;
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
    const pre = this.v2Bonus(u, 'pre');
    if (pre && pre.a.type === 'buff' && pre.a.target === 'self' && !(pre.a._spell && pre.a._spell.level) && !(pre.a.buff && pre.a.buff.condition === 'Invisible')) {
      this.spend(u, pre.a); this.doAction(u, pre.a, pre.p); bonusSpent = true;
    }
  }
  const speed = (this.has(u, ['Restrained']) || u.grappledBy) ? 0 : this.speedOf(u);
  if (!actionUsed) {
    const tp = this.v2Turn(u, speed, bonusSpent);
    v2tp = tp; this.v2Say(u, tp); if (tp && tp.hold) this.v2NotePacing(u, null);
    if (tp) {
      if (tp.mode === 'act' || tp.mode === 'bonusDis' || (tp.mode === 'jump' && tp.off)) {
        choice = { a: tp.off.pl.a, p: { targets: [tp.off.t], path: tp.path, why: '' } };
        choice.p.castL = tp.off.pl.castL;
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
  if (u.steadyAim && (v2tp && v2tp.aim) && hideAfter === null && !bonusSpent && !actionUsed && choice && choice.a.type === 'atk' && !choice.a.useSaves && !u.movedThisTurn &&
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
  if (choice && !moved) { this.moveAlong(u, choice.p.path); moved = true; }
  u.disengaged = false;
  if (u.dead || u.hp <= 0) return;
  const used = () => { if (u.traits) { if (actionUsed) u._actSeq = this.turnSeq; if (bonusSpent) u._bonSeq = this.turnSeq; } };   // for turnEnd (Patience)
  if (this.incap(u)) { used(); this.endTurn(u); return; }

  // bonus action: first usable one, before or after the action depending on what it is
  u.reserveSlot = !!(choice && !actionUsed && choice.a._spell && choice.a._spell.level);
  const bonus = bonusSpent ? null : this.v2Bonus(u, 'post', choice && !actionUsed ? choice : null);
  u.reserveSlot = false;
  u.smiteSeq = !bonusSpent && !bonus && u.smiteA ? this.turnSeq : 0;     // the bonus action is free for a Divine Smite on a hit
  const after = bonus && (bonus.a.type === 'atk' || (bonus.a.buff && bonus.a.buff.condition === 'Invisible'));
  if (bonus && !after) { u.castAt = bonus.p.castL || 0; this.spend(u, bonus.a); u.castAt = 0; this.doAction(u, bonus.a, bonus.p); }
  if (choice && !actionUsed && !out()) {
    // re-plan from where it ended up: it may have been stopped, or the target may have dropped
    let a = choice.a, p = null;
    // a flyer comes level with the creature it planned to touch before it aims again: from the air the ground is out of reach
    if (u.fly && choice.p && choice.p.targets && choice.p.targets[0]) this.settleAltitude(u, choice.a, choice.p);
    { const c2 = out() ? null : this.v2Act(u, choice); if (c2) { a = c2.a; p = c2.p; } }
    if (p && p.targets.length && u.fly) {
      this.settleAltitude(u, a, p);
      // couldn't get level with it this turn: a melee swing can't reach
      const t0 = p.targets[0];
      if (t0 && t0 !== u && a.type === 'atk' && !a.useSaves && this.dist(u, t0) > Math.max(5, a._range || 5)) { this.ev('skip', `${u.name} can't reach ${t0.name} from ${(u.alt || 0) * 5} ft up`, { uid: u.uid }); p = null; }
      if (out()) p = null;                                       // rising or dropping can draw an opportunity attack
    }
    if (p && p.targets.length) {
      this.v2Reckless(u, a, p);
      u.castAt = p.castL || 0;
      this.spend(u, a); u.castAt = 0; this.doAction(u, a, p, { finishDowned: !!(p.targets[0] && p.targets[0].hp <= 0) });
      if ((a.type === 'atk' || a.type === 'debuff') && p.targets[0] && p.targets[0] !== u) u.focus = p.targets[0].uid;
    }
  }
  if (hideAfter !== null && !bonusSpent && !(bonus && !after) && u.smoteSeq !== this.turnSeq && !out()) {
    const left = Math.floor(speed / 5) - (u._steps || 0);
    if (this.slipAndHide(u, hideAfter !== null ? Math.min(hideAfter, left) : left)) bonusSpent = true;
  }
  if (bonus && after && !bonusSpent && !out()) {
    const p = this.v2Aim(u, bonus.a, bonus.p.targets[0]);
    if (p) { this.v2Reckless(u, bonus.a, p); u.castAt = p.castL || 0; this.spend(u, bonus.a); u.castAt = 0; this.doAction(u, bonus.a, p); }
  }
  if (u.surges && u.surges.length && !u.dead && u.hp > 0 && !this.incap(u)) this.v2Surge(u);
  // a flyer that didn't need a particular height this turn settles out of reach with what movement it has left
  if (u.fly && !u._settled && !out()) this.settleAltitude(u, null, null);
  used();
  this.endTurn(u);
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
  if (u.traits && u.traits.turnEnd && !u.dead) this.traitRun(u, 'turnEnd', { unused: this.tUnused(u) });   // Patience: one for each part of the turn left unused
  // "repeat the save each round" effects on this creature
  for (const b of u.buffs.slice()) {
    if (b.expiry === 'repeat the save each round' && typeof b.dc === 'number' && b.dc < 99) {
      this._saveCond = b.data && b.data.condition; this._saveMagic = !!b.magic;
      const s = this.saveRoll(u, b.dc, null, b.saveAbility);
      this._saveCond = null; this._saveMagic = false;
      if (s.success) { u.buffs = u.buffs.filter(x => x !== b); this._flyMapVer = -1; this._rmCache = null; this.ev('save', `${u.name} shakes off ${b.name}`, { uid: u.uid }); }
    }
  }
  this.dropBuffs(u, b => b.expiry === 'hide' && (u.turnNo || 0) > b.madeOnTurn);
  this.dropBuffs(u, b => b.endTurn !== undefined && b.endTurn <= (u.turnNo || 0));     // a coin's effect (Double Down, Call It in the Air) with a time limit
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
/* 2024 / SRD 5.2: "immediately after another creature's turn" (an ally's too, never its own), one legendary action per window;
   the uses come back at the start of its own turn (turn) */
Sim.prototype.legendary = function (after) {
  for (const u of this.units) {
    if (u === after || !this.alive(u) || !u.onBoard || u.legendaryLeft <= 0 || this.incap(u)) continue;
    // actions that cost more than the uses left are hidden for this pick
    const hidden = u.actions.filter(a => a.actionSlot === 2 && ((a.ext && a.ext.legendaryCost) || 1) > u.legendaryLeft);
    hidden.forEach(a => { a.actionSlot = -99; });
    const mn = this._mn;
    this._mn = u.n || 1;     // it measures from its own body, not the creature whose turn just ended
    const c = u.v2P && u.v2P.boss.legendary === 'weigh' ? this.bossLegendary(u, after) : this.choose(u, 2, 0);   // the boss tier weighs which and when
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
    if (u.v2P && u.v2P.boss.lair === 'weigh') {     // the boss tier: the lair action worth most now, measured from its own body
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
  const M = u.v2P && u.v2P.morale;      // its profile says which triggers count (a tier's nerve)
  if (M && M.fearless) return false;
  const side = this.units.filter(o => o.team === u.team);
  const fallen = side.filter(o => o.dead || o.hp <= 0 || o.removed).length;     // a banished ally is gone as far as its side can see
  const leader = side.reduce((m, o) => (!m || o.maxHp > m.maxHp ? o : m), null);
  const triggers = [];
  if (u.hp < u.maxHp / 2 && (!M || M.bloodied)) triggers.push('bloodied');
  if (side.length > 1 && fallen * 2 >= side.length && (!M || M.half)) triggers.push('half');
  if (leader && leader !== u && (leader.dead || leader.hp <= 0 || leader.removed) && leader.maxHp > u.maxHp && (!M || M.leader)) triggers.push('leader');
  u.moraleSeen = u.moraleSeen || {};
  const fresh = triggers.filter(k => !u.moraleSeen[k]);
  if (!fresh.length || !this.losing(u)) return false;
  fresh.forEach(k => { u.moraleSeen[k] = true; });
  const r = this.d20(false, false, false, u, 'save') + this.saveBonusFor(u, 'wis');
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
/* ----- away from the fight (docs/ai-v2.md "Removed from the fight") ----- */
/* a removed creature's turn: what it made that lasts "until its next turn" ends; in a maze it studies a way out; nothing else */
Sim.prototype.awayTurn = function (u) {
  u.turnNo = (u.turnNo || 0) + 1; u.fightTurns = (u.fightTurns || 0) + 1;
  this.turnSeq = (this.turnSeq || 0) + 1;
  for (const x of this.units) this.dropBuffs(x, b => b.src === u.uid && b.expiry === '1 round');
  const R = u.removed;
  if (R.kind !== 'maze') { this.ev('skip', `${u.name} is away (${R.name})`, { uid: u.uid }); return; }
  const dc = R.dc || 20, tot = this.d20(false, false, false, u, 'check') + this.intCheck(u);
  this.ev('escape', `${u.name} studies the maze for a way out (${tot} vs DC ${dc})${tot >= dc ? ': it finds one' : ''}`, { uid: u.uid });
  if (tot >= dc) this.endAway(u, `${u.name} escapes the maze`);
};
/* the spell holding u ends now: through its caster's concentration when it still holds it */
Sim.prototype.endAway = function (u, why) {
  const R = u.removed, src = R && this.byId[R.by];
  if (src && src.concentrating === R.id) this.endConcentration(src, why); else this.comeBack(u, why);
};
/* start of a round: a removal that has run its whole duration ends (a Banishment's minute: one of the five types stays gone), a maze
   escape found while the other side waited (waitOut) comes through */
Sim.prototype.removalTick = function () {
  if (!this.awayN) return;
  for (const o of this.units) if (o.removed && o.removed.escapeAt && this.round >= o.removed.escapeAt) this.endAway(o, `${o.name} escapes the maze`);
  const due = this.units.filter(o => o.removed && this.round > o.removed.until), spent = [];
  // those that stay away go first, so the spell ending does not bring them back with the rest
  for (const o of due) if (o.removed.kind === 'banishment' && homeElsewhere(o)) { spent.push(o.removed); this.goneForGood(o, `${o.removed.name} lasted the full minute`); }
  for (const o of due) if (o.removed) this.endAway(o, 'the spell runs out');
  for (const R of spent) { const src = this.byId[R.by]; if (src && src.concentrating === R.id) this.endConcentration(src, 'the spell runs out'); }
};
/* one side has nobody on the board who is not dead, and someone of its side is away: the other side waits it out. No turns are played;
   time moves on to the first removal that ends (a Banishment's minute, a maze's first good Study check, up to its ten minutes); the
   waiting side's downed are stabilised. Those rounds count in the fight, not against the round cap. Returns true when it waited. */
Sim.prototype.waitOut = function () {
  const onField = team => this.units.some(o => o.team === team && !o.dead && !o.removed && (o.onBoard || o.swallowedBy));
  let side = null;
  for (const team of ['foes', 'party']) if (!onField(team) && this.units.some(o => o.team === team && o.removed && !o.dead)) side = team;
  if (!side) return false;
  const other = side === 'foes' ? 'party' : 'foes';
  if (!this.units.some(o => o.team === other && this.alive(o) && !o.removed)) return false;      // nobody to wait: the cap decides
  let first = null;
  for (const o of this.units) {
    const R = o.removed;
    if (!R || o.dead) continue;
    let at = R.until + 1, esc = false;
    if (R.kind === 'maze') for (let rd = this.round + 1; rd <= R.until; rd++) if (this.d20(false, false, false, o, 'check') + this.intCheck(o) >= (R.dc || 20)) { at = rd; esc = true; break; }
    if (!first || at < first.at) first = { o, at, esc };
  }
  if (!first) return false;
  for (const o of this.units) if (o.team === other && o.isPC && !o.dead && o.hp <= 0 && !o.stable) { o.stable = true; this.ev('deathsave', `${o.name} is stabilised while the fight waits`, { uid: o.uid }); }
  const k = Math.max(0, first.at - this.round - 1);
  this.ev('wait', `${other === 'party' ? 'The party waits' : 'The foes wait'} for ${first.o.name} (${first.o.removed.name}): ${k + 1} round${k ? 's' : ''} pass with nobody to fight`, { uid: first.o.uid });
  if (first.esc) first.o.removed.escapeAt = first.at;
  this.waitRounds = (this.waitRounds || 0) + k;
  this.round = first.at - 1;       // the round loop's ++ starts round first.at
  return true;
};
Sim.prototype.partyStanding = function () { return this.units.some(u => u.team === 'party' && this.alive(u)); };
Sim.prototype.foesStanding = function () { return this.units.some(u => u.team === 'foes' && this.alive(u)); };
Sim.prototype.over = function () { return !this.partyStanding() || !this.foesStanding(); };

Sim.prototype.runEncounter = function (party, foes, enc, layout) {
  this.units = party.concat(foes);
  this.byId = {}; this.units.forEach(u => this.byId[u.uid] = u);
  this.units.forEach(u => { u.maxHp0 = u.maxHp; });     // max HP as the fight starts: the replay's unit table; a change in the fight (Aid) goes in the frame state (unitState)
  this._last = {};
  this.surprised = { party: !!enc.playersSurprised, foes: !!enc.monstersSurprised };
  this.revives = { party: 0, foes: 0 };
  this.round = 0;
  this.setTerrain(layout && layout.terrain);
  this.zones = [];
  this.place(party, foes, layout);
  this.boardChanged();
  this.units.forEach(u => this.v2Setup(u));
  // initiative (2024: surprised creatures roll with disadvantage)
  // the dead (a party member lost in an earlier fight and not revived) take no part: no roll, no place in the order
  // (a revive happens between fights, endFightRevives, so a revived one rolls like anyone else in the next fight)
  for (const u of this.units) {
    if (u.dead) { u.init = undefined; continue; }
    const sur = this.surprised[u.team] && this.surpriseRules === '2024';
    u.init = this.d20(u.initAdv, sur, false, u, 'check') + u.initBonus + this.R() * 0.01;
  }
  this.order = this.units.filter(u => !u.dead).sort((a, b) => b.init - a.init);
  this.ev('start', 'Initiative: ' + this.order.map(u => `${u.name} ${Math.floor(u.init)}`).join(', '), { order: this.order.map(u => u.uid) });
  this.round = 1;
  if (this.morningNotes && this.morningNotes.length) { this.morningNotes.forEach(n => this.ev('heal', n.text, { uid: n.uid })); this.morningNotes = null; }
  for (const u of this.order) if (this.alive(u)) this.trigger(u, -3, null);
  this.awayN = 0; this.waitRounds = 0;      // removed creatures (Banishment, Maze) and the rounds waited for them (not counted against the cap)
  while (this.round - this.waitRounds <= this.maxRounds && !this.over()) {
    this.ev('round', `Round ${this.round}`, {});
    this.expireZones();
    this.removalTick();
    this.lair();
    for (const u of this.order) {
      if (this.over()) break;
      if (this.awayN && this.waitOut()) break;
      if (u.dead) continue;
      if (u.team === 'foes' && !u.onBoard && !u.removed) continue;
      this.ev('turn', `${u.name}'s turn`, { uid: u.uid });
      if (u.removed) { this.current = u; this.awayTurn(u); this.current = null; if (this.over()) break; this.legendary(u); continue; }
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
  return { won, rounds: Math.min(this.round - 1, this.maxRounds + this.waitRounds) };
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

})(typeof window !== 'undefined' ? window : globalThis);
