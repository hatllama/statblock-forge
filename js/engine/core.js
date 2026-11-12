/* TACTICAL ENGINE, part 5: the rules (file list and how the parts share names: js/engine/base.js).
   The event log and unit state, buffs & conditions, uses and pools, target selection, carrying out a move,
   rolling (d20, saveRoll, attackRoll), damage/healing/death, damage zones, reactions on taking damage, triggers,
   executing actions (resolveAttackAction, doAction). Not AI: AI work does not change this file. */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { parseDice, rollDice, avgDice, INCAP, DANGER_CONDS, ADV_TARGET, ADV_SELF, DIS_TARGET, DIS_SELF, sizeIdx, listOf, damageMultFor, bestTypeFor, isHpPool, freqKind, Sim, isHideAction, gapAxis, otherTeam } = ENG;

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
           conc: u.concentrating ? ((u.actions.find(a => a.id === u.concentrating) || {}).name || 'a spell') : undefined,
           alt: u.fly || u.alt ? (u.alt || 0) * 5 : undefined,
           // for the token inspector: what's on it, what it has left
           ac: this.ac(u), ground: this.T.anyH ? this.T.h[u.x + u.y * this.W] * 5 : 0,
           buffs: u.buffs.length ? u.buffs.map(b => this.buffInfo(u, b)) : undefined,
           uses: this.usesInfo(u),
           react: u.reaction ? undefined : false,
           leg: u.hasLegendary ? u.legendaryLeft + '/' + u.legendaryMax : undefined,
           legRes: u.legResMax ? u.uses.get('__legres') + '/' + u.legResMax : undefined,
           luck: u.luckMax ? u.uses.get('__luck') + '/' + u.luckMax : undefined,
           fled: u.fled || undefined };
};
/* one line per effect on a creature: [name, what it does, how long, who put it there] */
const EXPIRY_TEXT = { 'entire encounter': 'the whole fight', '1 round': 'until its maker\'s next turn', 'until next attack made': 'until its next attack', 'until next attack taken': 'until it is next attacked',
  'repeat the save each round': 'save each turn to end', hide: 'until it attacks or moves into view' };
Sim.prototype.buffInfo = function (u, b) {
  const d = b.data || {}, bits = [];
  const sign = v => (typeof v === 'number' && v >= 0 ? '+' : (typeof v === 'string' && !/^[-+]/.test(v) ? '+' : '')) + v;
  if (d.condition && b.expiry !== 'hide') bits.push(d.condition);
  if (d.ac) bits.push(sign(d.ac) + ' AC');
  if (d.toHit) bits.push(sign(d.toHit) + ' to hit');
  if (d.save) bits.push(sign(d.save) + ' to saves');
  if (d.damage) bits.push(sign(d.damage) + ' damage');
  if (d.damageReduction) bits.push('−' + d.damageReduction + ' damage taken');
  if (typeof d.damageMultiplier === 'number' && d.damageMultiplier !== 1) bits.push('×' + d.damageMultiplier + ' damage');
  if (typeof d.damageTakenMultiplier === 'number' && d.damageTakenMultiplier !== 1) bits.push('×' + d.damageTakenMultiplier + ' damage taken');
  if (b.resist) bits.push('resists ' + b.resist.join(', '));
  if (b.speedBonus) bits.push(sign(b.speedBonus) + ' ft speed');
  if (b.mirror) bits.push(b.mirror + ' images');
  if (b.loseAction) bits.push('loses its action');
  if (b.expiry === 'hide') bits.push('hidden');
  const src = b.src && b.src !== u.uid ? (this.units.find(o => o.uid === b.src) || {}).name : '';
  return [b.name, bits.join(', '), EXPIRY_TEXT[b.expiry] || b.expiry || '', src || ''];
};
/* limited uses left: "Rage 2/3", recharges, once-a-fight features */
Sim.prototype.usesInfo = function (u) {
  const out = [];
  if (u.resMax) for (const k in u.resMax) out.push(`${k} ${u.uses.get('res:' + k) || 0}/${u.resMax[k].uses}`);
  if (u.indomitable) out.push(`Indomitable ${u.uses.get('__indom') || 0}/${u.indomitable.uses}`);
  for (const a of u.surges || []) { const k = freqKind(a.freq); if (k !== 'at will') out.push(`${a.name} ${u.uses.get(a.id) || 0}/${a.freq.uses || 1}`); }
  for (const a of u.actions) {
    if (a._spell) continue;
    const k = freqKind(a.freq);
    if (a.ext && a.ext.pool) out.push(`${a.name} ${u.uses.get(a.id)}/${a.ext.pool.dice || 1}`);
    else if (k === 'sr' || k === 'lr' || k === '1/day') out.push(`${a.name} ${u.uses.get(a.id) || 0}/${k === '1/day' ? 1 : (a.freq.uses || 1)}${k === 'sr' ? ' (short rest)' : ''}`);
    else if (k === '1/fight') out.push(`${a.name} ${u.fightUses.get(a.id) ? 'used' : 'ready'}`);
    else if (k === 'recharge') out.push(`${a.name} ${u.recharge.get(a.id) === false ? 'recharging' : 'ready'}`);
  }
  return out.length ? out : undefined;
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
  if (data && data.condition && holder !== src && holder.condImmune && holder.condImmune.indexOf(String(data.condition).toLowerCase()) >= 0) {
    (holder.seenImmune = holder.seenImmune || []).push(String(data.condition).toLowerCase());
    if (this.record) this.ev('effect', `${holder.name} is immune to being ${String(data.condition).toLowerCase()}`, { uid: holder.uid });
    return { id: action.id, name: action.name, data: {}, immune: true };
  }
  if (data && data.condition && src.team && holder !== src) this.learnCond(src, holder, data.condition);
  holder.buffs = holder.buffs.filter(b => !(b.id === action.id && b.src === src.uid));
  const b = { id: action.id, name: action.name || 'effect', src: src.uid, data: Object.assign({}, data), expiry: data.duration };
  const ax = action.ext || {};
  if (typeof ax.speedBonus === 'number') b.speedBonus = ax.speedBonus;          // Bladesong +10 ft, Longstrider…
  if (typeof ax.concBonus === 'number') b.concBonus = ax.concBonus;            // Bladesong adds Int to concentration saves
  if (ax.endsOnIncap) b.endsOnIncap = true;
  if (ax.resist) b.resist = listOf(ax.resist);                                  // Rage: resistance while it lasts
  if (ax.endsOnDamage) b.endsOnDamage = true;
  if (typeof ax.grantFly === 'number' && holder === src) { holder.fly = Math.max(holder.fly || 0, ax.grantFly); holder.speed = Math.max(holder.speed, ax.grantFly); }
  if (typeof ax.mirror === 'number') { b.mirror = ax.mirror; delete b.data.damageTakenMultiplier; }
  // "…or use its action on its next turn…": the export calls it Incapacitated; here it only costs that action
  if (ax.loseAction && holder !== src) { delete b.data.condition; b.loseAction = true; }
  if (ax.saveOnDamage && holder !== src) b.saveOnDamage = ax.saveOnDamage;
  if (ax.damageType) { b.dtype = ax.damageType; b.dmagic = !!(action._spell || ax.magical); }
  // the export's averaged resistance gives way to the real damage types when the creature lists them
  if (ax.avgResist && holder.dmgMods && typeof b.data.damageTakenMultiplier === 'number') b.data.damageTakenMultiplier = Math.round(b.data.damageTakenMultiplier / ax.avgResist * 100) / 100;   // real duplicates here, an average in the export
  if (extra) Object.assign(b, extra);
  // Hiding (self-applied Invisible) lasts until the creature attacks or its next turn ends (2024 Hide)
  if (holder === src && data.condition === 'Invisible' && data.duration === '1 round') { b.expiry = 'hide'; b.madeOnTurn = holder.turnNo || 0; }
  holder.buffs.push(b);
  if (b.data.condition) this._rmCache = null;   // an Incapacitated creature's space can be walked through: the movement maps change
  if (holder.fly) this._flyMapVer = -1;   // knocked out of the air, or given wings
  if (holder.alt > 0) this.fallCheck(holder);
  return b;
};
Sim.prototype.dropBuffs = function (u, pred) {
  const n = u.buffs.length;
  u.buffs = u.buffs.filter(b => !pred(b));
  if (u.buffs.length !== n) this._rmCache = null;     // a condition may have ended (see addBuff)
  if (u.fly) this._flyMapVer = -1;
};

/* ----- uses ----- */
Sim.prototype.slotFor = function (u, level) {
  if (!level) return 0;
  for (let l = level; l <= 9; l++) if (u.slots[l - 1] > 0) return l;
  return -1;
};
Sim.prototype.usable = function (u, a) {
  if (a.ext && (a.ext.prefight || a.ext.revivify)) return false;     // pre-fight buffs are cast in the morning only (morningCasts), Revivify when the fight ends (endFightRevives)
  if (a._spell) {
    if (!a._spell.level) return true;
    if (a.actionSlot === 4 && u.reviver && this.v2Eats(u, this.slotFor(u, a._spell.level))) return false;   // no scorer for reactions yet (roadmap phase 3): they leave a kept slot alone
    if (this.sustaining(u, a)) return true;                                                  // moving Moonbeam, another Call Lightning bolt: no new slot
    if (a._spell.conc && a.ext && a.ext.zone && a.ext.zone.dmg && u.concentrating === a.id && (this.zones || []).some(z => z.src === u.uid && z.id === a.id)) return false;   // it's already up
    if (a.actionSlot !== 4 && u.slotTurn === u.turnNo && this.current === u) return false;   // one spell slot per turn (2024 rules)
    if (a.actionSlot === 1 && u.reserveSlot) return false;                                  // the action is going to need it
    return this.slotFor(u, a._spell.level) > 0;
  }
  if (a.ext && a.ext.pool) return (u.uses.get(a.id) || 0) >= 1;
  if (a.ext && a.ext.resource && !((u.uses.get('res:' + a.ext.resource) || 0) >= (a.ext.resourceCost || 1))) return false;   // a superiority die to spend
  const k = freqKind(a.freq);
  if (k === 'at will') return true;
  if (k === '1/fight') return !u.fightUses.has(a.id);
  if (k === 'recharge') return u.recharge.get(a.id) !== false;
  return (u.uses.get(a.id) || 0) > 0;
};
/* a concentration spell the caster is already holding that its action re-uses for free (ext.sustain), within its duration */
Sim.prototype.sustaining = function (u, a) {
  return !!(a._spell && a._spell.conc && a.ext && a.ext.sustain && u.concentrating === a.id && this.round <= (u.concUntil || 0));
};
Sim.prototype.spend = function (u, a) {
  u.usedThisFight.add(a.id);
  if (a.ext && a.ext.pool) return;       // dice are taken from the pool when the healing is rolled
  if (a._spell && this.sustaining(u, a)) { u.castAt = 0; u.castLevel = u.concLevel || a._spell.level; return; }
  if (a._spell) {
    u.castLevel = a._spell.level;
    if (a._spell.level) {
      // AI v2 may pick a higher slot on purpose (u.castAt, set just before this); otherwise the lowest free one
      const want = u.castAt; u.castAt = 0;
      const l = want && want >= a._spell.level && u.slots[want - 1] > 0 ? want : this.slotFor(u, a._spell.level);
      if (l > 0) { u.slots[l - 1]--; u.castLevel = l; }
      if (this.current === u) u.slotTurn = u.turnNo;
    }
    if (a._spell.conc) { this.endConcentration(u, 'casts ' + a.name); u.concentrating = a.id; u.concLevel = u.castLevel; u.concUntil = this.round + ((a.ext && a.ext.hold) || 100) - 1; }
    return;
  }
  if (a.ext && a.ext.resource) u.uses.set('res:' + a.ext.resource, Math.max(0, (u.uses.get('res:' + a.ext.resource) || 0) - (a.ext.resourceCost || 1)));
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
/* is u's side in trouble? someone down, or clearly behind on hit points */
Sim.prototype.losing = function (u) {
  const frac = team => {
    let hp = 0, max = 0;
    for (const o of this.units) if (o.team === team && (o.onBoard || o.isPC) && !(o.dead && !o.isPC)) { hp += Math.max(0, o.dead ? 0 : this.kHp(u, o)); max += this.kMax(u, o); }
    return max ? hp / max : 1;
  };
  const mine = frac(u.team), theirs = frac(u.team === 'party' ? 'foes' : 'party');
  if (this.alliesOf(u).some(o => o.dead || (o.hp <= 0 && o.isPC))) return true;
  return mine < 0.4 || mine < theirs - 0.2;
};
Sim.prototype.condOk = function (u, a) {
  if (this.stillRunning(u, a)) return false;
  const allies = this.alliesOf(u).filter(x => x !== u);
  const foes = this.enemiesOf(u).filter(x => this.alive(x));
  const ex = a.ext || {};
  if (ex.onlyIfEnemiesSurprised && !(this.round === 1 && this.surprised[u.team === 'party' ? 'foes' : 'party'])) return false;
  if (ex.requiresBuff && !u.buffs.some(b => b.id === ex.requiresBuff)) return false;     // e.g. Wrath of the Sea strikes need the spray up
  if (ex.grantsBuff && u.buffs.some(b => b.id === ex.grantsBuff.id)) return false;        // …and it isn't manifested twice
  if (ex.wtWhen === 'losing' && !this.losing(u)) return false;                             // Fog Cloud & co.: a way out, not an opener
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

/* A move passes through friends' squares, but it can stop short (a failed climb, an opportunity attack, a slip) on one of
   them: back up along the way to the last square nobody stands on. */
Sim.prototype.moveAlong = function (u, path) {
  if (!path.length) return;
  const trail = [{ x: u.x, y: u.y }];
  this.moveAlongSteps(u, path, trail);
  if (u.dead || !u.onBoard) return;
  const o = this.occupant(u.x, u.y, u.n, u);
  if (!o) return;
  for (let i = trail.length - 1; i >= 0; i--) {
    if (this.occupant(trail[i].x, trail[i].y, u.n, u)) continue;
    const from = { x: u.x, y: u.y };
    u.x = trail[i].x; u.y = trail[i].y; this.boardChanged();
    this.ev('move', `${u.name} can't stop on ${o.name}'s square and steps back`, { uid: u.uid, path: [{ x: u.x, y: u.y }], from });
    return;
  }
};
Sim.prototype.moveAlongSteps = function (u, path, trail) {
  let seg = [], from = { x: u.x, y: u.y };
  const flush = () => {
    if (seg.length) this.ev('move', `${u.name} moves ${seg.length * 5} ft`, { uid: u.uid, path: seg.slice(), from: Object.assign({}, from) });
    seg = []; from = { x: u.x, y: u.y };
  };
  for (const step of path) {
    const after = new Set(this.adjacentEnemies(u, step.x, step.y));
    for (const e of (u.disengaged ? [] : this.adjacentEnemies(u, u.x, u.y))) {
      if (after.has(e) || !e.reaction || this.incap(e) || e.noOA) continue;
      const atk = e.actions.find(a => a.type === 'atk' && !a.useSaves && a.actionSlot === 0 && a._range <= 10 && !(a.ext && a.ext.swallow));
      if (!atk) continue;
      flush();
      e.reaction = false;
      this.ev('oa', `${e.name} takes an opportunity attack at ${u.name}`, { uid: e.uid, target: u.uid });
      this.attackOnce(e, atk, u, { oa: true });
      if (u.dead || u.hp <= 0) return;
      if (u.grappledBy || this.incap(u) || this.has(u, ['Restrained'])) { flush(); this.ev('effect', `${u.name} is stopped in place`, { uid: u.uid }); return; }
    }
    const rise = this.T.anyH && !u.fly ? this.hAt(step.x, step.y) - this.hAt(u.x, u.y) : 0;
    if ((rise >= 2 || rise <= -2) && !u.climb) {
      // scaling a ledge of 10 ft or more: Athletics check
      const r = this.R.d(20), tot = r + (u.athletics || 0), dc = this.climbDC;
      if (tot < dc) {
        flush();
        if (rise > 0) { this.ev('effect', `${u.name} fails to climb the ${rise * 5}-ft ledge (Athletics ${tot} vs DC ${dc >= 99 ? '—' : dc})`, { uid: u.uid }); return; }
        // climbing down and slipping: it falls the rest of the way
        u.x = step.x; u.y = step.y; trail.push({ x: step.x, y: step.y }); this.boardChanged();
        this.ev('move', `${u.name} slips climbing down`, { uid: u.uid, path: [{ x: step.x, y: step.y }], from: Object.assign({}, from) });
        const d = this.damage(u, u, Math.floor(rollDice(Math.floor(-rise / 2) + 'd6', this.R, false)), { type: 'bludgeoning' });
        u.dmgDealt -= d;   // it hurt itself; don't count it as damage dealt
        this.addBuff(u, u, { id: 'prone', name: 'Prone' }, { duration: '1 round', condition: 'Prone' });
        this.ev('effect', `${u.name} falls ${-rise * 5} ft (Athletics ${tot} vs DC ${dc}; ${d} damage) and lands prone`, { uid: u.uid, dmg: d });
        return;
      }
      if (this.record) { flush(); this.ev('effect', `${u.name} climbs ${rise > 0 ? 'up' : 'down'} the ${Math.abs(rise) * 5}-ft ledge (Athletics ${tot} vs DC ${dc})`, { uid: u.uid }); }
    }
    const was = this._braceCheck ? null : this.enemiesOf(u).filter(e => e.reaction && e.onBoard && !e.dead && (e.readied || e.actions.some(y => y.actionSlot === 4 && y.ext && y.ext.brace)) && this.dist(e, u) > this.meleeReach(e));
    u.x = step.x; u.y = step.y; trail.push({ x: step.x, y: step.y }); seg.push({ x: step.x, y: step.y }); u.movedThisTurn = true; this.boardChanged();
    if (was && was.length) for (const e of was) if (this.dist(e, u) <= this.meleeReach(e)) {
      flush(); this._braceCheck = true;
      try { if (!this.readyStrike(e, u)) this.counterAttack(e, u, 'brace'); } finally { this._braceCheck = false; }
      if (u.dead || u.hp <= 0) return;
    }
    // rough ground (not for flyers), or another creature's space (2024: difficult terrain for anyone)
    const rough = (!u.fly && this.T.any && (this.T.rough[step.x + step.y * this.W] || this.T.cover[step.x + step.y * this.W])) || !!this.occupant(step.x, step.y, u.n, u);
    u._steps = (u._steps || 0) + (rough ? 2 : 1) + (u.fly || (u.climb && Math.abs(rise) >= 2) ? 0 : (Math.abs(rise) >= 2 ? Math.abs(rise) : Math.max(0, rise)));
  }
  flush();
  this.zoneEnter(u);
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
Sim.prototype.saveRoll = function (t, dc, src, ab, sopt) {
  if (dc >= 99) return { success: false, roll: 1, total: -99 };
  const c = this.conds(t);
  const physical = ab === 'str' || ab === 'dex' || ab === 'strdex';
  // paralysed, stunned, unconscious or petrified creatures automatically fail Strength and Dexterity saves
  if (physical && ['Paralyzed', 'Stunned', 'Unconscious', 'Petrified'].some(x => c.has(x))) return { success: false, roll: 0, total: 0, autoFail: true };
  const adv = c.has('Saves with Advantage') || !!(sopt && sopt.adv) || (t.dexAdv && ab === 'dex' && !this.incap(t) && !c.has('Blinded') && !c.has('Deafened')) || (!!this._saveCond && t.saveAdvVs.length > 0 && t.saveAdvVs.includes(String(this._saveCond).toLowerCase()));
  const dis = c.has('Save with Disadvantage') || c.has('Attacks and saves with Disadvantage') || ((ab === 'dex') && c.has('Restrained'));
  let r = this.d20(adv, dis, false);
  let total = r + this.saveBonusFor(t, ab) + this.sumBuff(t, 'save', true);
  // half cover helps Dexterity saves against something coming from elsewhere (the area's point, or the caster)
  if (ab === 'dex' && src && src !== t && this.T.any && !this._ignoreCover) {
    const from = this._coverFrom || src;
    if (this.gapTo(from.x, from.y, from.n, t) > 1) total += this.coverBetween(from.x, from.y, t.x, t.y, from.uid ? (from.alt || 0) : (from.alt || 0), t.alt || 0);
  }
  if (total < dc && t.luckMax && (t.uses.get('__luck') || 0) > 0 && (this._saveStakes || 0) >= 1) {
    t.uses.set('__luck', t.uses.get('__luck') - 1);
    const r2 = this.R.d(20);
    if (r2 > r) { total += r2 - r; r = r2; }
    this.ev('react', `${t.name} spends a luck point on the save`, { uid: t.uid });
  }
  // Legendary Resistance: only when failing would be dangerous — a disabling condition (paralysed, stunned,
  // restrained, frightened, blinded…), or damage that would drop it or take a big bite out of what it has left
  this.learnSave(t, dc, ab, total >= dc);
  this.learnDc(src, t, dc);
  const failDmg = this._saveDmg || 0;
  // Indomitable: reroll a failed save with a bonus (saved for ones that matter)
  if (total < dc && t.indomitable && (t.uses.get('__indom') || 0) > 0 && dc < 99 &&
      ((this._saveStakes || 0) >= 1 || failDmg >= t.hp * 0.25 || t.ai !== 'tactical')) {
    t.uses.set('__indom', t.uses.get('__indom') - 1);
    const r2 = this.d20(adv, dis, false);
    const tot2 = r2 + this.saveBonusFor(t, ab) + this.sumBuff(t, 'save', true) + t.indomitable.bonus;
    this.ev('react', `${t.name} uses Indomitable: rerolls the save (${Math.round(total)} → ${Math.round(tot2)})`, { uid: t.uid });
    r = r2; total = tot2;
  }
  // Silvery Barbs against a save that went our way (v2 reactors): reroll, keep the lower die
  if (total >= dc && this.aiV2 && src && src.team && src.team !== t.team && ((this._saveDmg || 0) > 0 || (this._saveStakes || 0) >= 1)) {
    const pk = this.reactSaveV2(t, dc, src, ab);
    if (pk) {
      this.reactTake(pk.h, pk.x, 0);
      const was = Math.round(total), r2 = Math.min(r, this.R.d(20));
      total += r2 - r; r = r2;
      const ally = this.reactGrantAdv(pk.h);
      this.ev('react', `${pk.h.name} ${pk.x._spell ? 'casts' : 'uses'} ${pk.x.name}: ${t.name}'s save ${was} rerolls to ${Math.round(total)} vs DC ${dc}, ${total >= dc ? 'still passes' : 'now fails'}${ally ? `; ${ally.name} gains advantage` : ''}`, { uid: pk.h.uid, target: t.uid });
    }
  }
  // the boss tier weighs the use (bossLR) and remembers the worst effect it has been shown (learn learns the party's save-or-suck spells)
  const weighLR = t.legResMax && t.v2 && t.v2P.boss.legRes === 'weigh' && dc < 99 && src && src.team && src.team !== t.team;
  let seenLR = 0;
  if (weighLR) { seenLR = t.lrSeen || 0; t.lrSeen = Math.max(seenLR, this.bossEffectOf(t, dc, ab)); }
  const dangerous = weighLR ? total < dc && (t.uses.get('__legres') || 0) > 0 && this.bossLR(t, dc, ab, failDmg, seenLR)
    : (this._saveStakes || 0) >= 1 || failDmg >= t.hp || failDmg >= Math.max(t.maxHp * 0.1, t.hp * 0.25);
  if (total < dc && t.legResMax && (t.uses.get('__legres') || 0) > 0 && dc < 99 && dangerous) {
    t.uses.set('__legres', t.uses.get('__legres') - 1);
    t.legSeen = (t.legSeen || 0) + 1;
    if (this.learning(otherTeam(t.team))) { const k = this.kind(otherTeam(t.team), t); k.legRes = Math.max(k.legRes || 0, t.legSeen); k.seen++; }
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
  let crit = r === 20 || (hit && !a._spell && r >= (att.critOn || 20));
  if (r !== 20 && r !== 1 && !opt.inside) this.learnAC(att, tgt, total - this.sumBuff(tgt, 'ac', false) - this.coverAC(att, tgt), hit);
  this.learnAtk(att, tgt, ac, r !== 20 && r !== 1 && !adv && !dis, hit);
  // reactions on the target's side (docs/ai-v2.md, "Reactions as a layer"): v1 creatures keep their thresholds, v2 creatures score theirs
  const S = { att, tgt, a, r, d: r, toHit, total, hit, crit, ac };
  if (hit && !opt.noReact) {
    this.reactBarbsOld(S, opt);
    if (this.aiV2) this.reactHitV2(S, opt);
    this.reactLuckyOld(S, opt);
    this.reactShieldOld(S, opt);
    total = S.total; hit = S.hit; crit = S.crit; ac = S.ac;
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
/* a damage-cutting reaction's own limits (ext.react): roll — only an attack roll that hit (Uncanny Dodge, Deflect Attacks); types — the damage must
   include one of these (Deflect Attacks: bludgeoning, piercing, slashing). Untyped damage passes: the engine can't tell */
function reactFits(x, info) {
  const rx = x.ext && x.ext.react;
  if (!rx) return true;
  if (rx.roll && !info.roll) return false;
  if (rx.types) {
    const type = String(info.type || (info.a && info.a.ext && info.a.ext.damageType) || '').toLowerCase();
    if (type && !rx.types.some(t => type.indexOf(t) >= 0)) return false;
  }
  return true;
}
Sim.prototype.damage = function (src, tgt, raw, info) {
  info = info || {};
  if (tgt.dead) return 0;
  // damage type against resistances, immunities and vulnerabilities
  const tm = info.a || info.type ? damageMultFor(info.a, tgt, info.type) : 1;
  if (raw > 0) this.learnType(tgt, info, tm);
  if (tm !== 1 && raw > 0) {
    info.typeNote = tm === 0 ? 'immune' : tm < 1 ? 'resisted' : tm > 1 ? 'vulnerable' : '';
    if (tm === 0 && this.record) this.ev('effect', `${tgt.name} is immune to ${info.type || (info.a && (bestTypeFor(info.a, tgt) || info.a.ext.damageType))} damage`, { uid: tgt.uid });
  }
  let dmg = Math.max(0, raw * tm * this.multBuff(tgt, 'damageTakenMultiplier') - this.sumBuff(tgt, 'damageReduction', false));
  dmg = Math.floor(dmg);
  if (dmg <= 0) return 0;
  // a defensive reaction on the target that reduces damage (e.g. "until next attack taken" resistance)
  if (info.attack && tgt.reaction && !this.incap(tgt) && tgt.hp > 0) {
    const r = tgt.actions.find(x => x.actionSlot === 4 && x.type === 'buff' && x.target === 'self' && x.buff && x.buff.ac === undefined &&
      (x.buff.damageTakenMultiplier !== undefined || x.buff.damageReduction !== undefined) && reactFits(x, info) && this.usable(tgt, x) && this.condOk(tgt, x));
    if (r && (!tgt.v2 || this.v2ReactOk(tgt, r, dmg, src, info))) {
      tgt.reaction = false; this.spend(tgt, r);
      const red = Math.floor(Math.max(0, dmg * (typeof r.buff.damageTakenMultiplier === 'number' ? r.buff.damageTakenMultiplier : 1) - avgDice(r.buff.damageReduction || 0)));
      this.ev('react', `${tgt.name} uses ${r.name} (${dmg} → ${red})`, { uid: tgt.uid });
      dmg = red;
      if (dmg <= 0) { if (r.ext && r.ext.react && r.ext.react.redirect) this.reactRedirect(tgt, r, src, info); return 0; }
    }
  }
  src.dmgDealt += dmg; tgt.dmgTaken += dmg;
  this.learnDmg(src, tgt, dmg, info);
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
  tgt.visLost = (tgt.visLost || 0) + Math.min(dmg, tgt.hp);
  tgt.netLost = (tgt.netLost || 0) + dmg;                 // the hit as the table saw it, not cut to the HP it had left
  tgt.hp = Math.max(0, tgt.hp - dmg);
  // Death Ward (pre-fight): the first drop to 0 HP, or a killing blow, leaves it at 1 HP and the spell ends
  if (tgt.hp <= 0 && tgt.deathWard) { tgt.deathWard = false; tgt.hp = 1; this.ev('react', `${tgt.name}'s Death Ward holds: 1 HP instead of 0`, { uid: tgt.uid }); }
  // Relentless Rage: dropped to 0 while raging, a Con save (DC 10, +5 each time) leaves it standing
  if (tgt.hp <= 0 && tgt.relentless && !(tgt.isPC && overflow >= tgt.maxHp) && tgt.buffs.some(b => b.name === 'Rage')) {
    const n = tgt.uses.get('__relentless') || 0, dc = 10 + 5 * n, roll = this.R.d(20) + this.saveBonusFor(tgt, 'con');
    tgt.uses.set('__relentless', n + 1);
    if (roll >= dc) { tgt.hp = tgt.relentless.hp; this.ev('react', `${tgt.name}'s Relentless Rage keeps it up (Con ${Math.round(roll)} vs DC ${dc}, ${tgt.hp} HP)`, { uid: tgt.uid }); }
  }
  this.learnHp(tgt);
  if (tgt.hp <= 0) {
    if (tgt.isPC && overflow >= tgt.maxHp) this.kill(tgt, src, 'massive damage');
    else if (tgt.isPC) this.downPC(tgt);
    else this.kill(tgt, src, '');
    this.trigger(src, -2, tgt);
    if (!tgt.dead || !tgt.isPC) this.trigger(tgt, -1, src);
  } else if (info.attack && src !== tgt) {
    this.onDamaged(tgt, src);
  }
  // concentration check: Con save, DC 10 or half the damage, at most 30 (2024)
  if (tgt.concentrating && tgt.hp > 0 && !tgt.dead && dmg > 0) {
    const dc = Math.min(30, Math.max(10, Math.floor(dmg / 2)));
    const roll = this.R.d(20) + (tgt.conSave || 0) + tgt.buffs.reduce((t, b) => t + (b.concBonus || 0), 0);
    if (roll < dc) this.endConcentration(tgt, `Con save ${roll} vs DC ${dc}`);
  }
  // "…each time it takes damage, it repeats the save" (Hideous Laughter: with advantage)
  if (tgt.hp > 0 && !tgt.dead && dmg > 0) for (const b of tgt.buffs.slice()) {
    if (!b.saveOnDamage || typeof b.dc !== 'number' || b.dc >= 99 || tgt.buffs.indexOf(b) < 0) continue;
    const s = this.saveRoll(tgt, b.dc, this.byId[b.src] || null, b.saveAbility, { adv: b.saveOnDamage === 'adv' });
    if (s.success) { tgt.buffs = tgt.buffs.filter(x => x !== b); this._flyMapVer = -1; this._rmCache = null; this.ev('save', `${tgt.name} is hurt out of ${b.name} (${s.total} vs DC ${b.dc}${b.saveOnDamage === 'adv' ? ', advantage' : ''})`, { uid: tgt.uid }); }
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
/* ----- damage zones (ext.zone.dmg): Spirit Guardians, Moonbeam, Wall of Fire… hurt whoever is in them as the rounds go by.
   A creature takes the spell's save-for-damage when it starts its turn in the zone or moves into it (or the zone moves onto it),
   at most once a round per zone; the cast itself counts as that round's hit. A zone with ext.zone.follow moves with its caster;
   it ends when concentration does, or after ext.hold rounds ----- */
Sim.prototype.zoneCells = function (z) {
  if (!z.follow) return z.cells;
  const s = this.byId[z.src];
  if (!s || s.x === undefined) return z.cells;
  const key = s.x + ',' + s.y;
  if (z._at !== key) { z._at = key; z._cells = new Set(this.cellsFor(z.spec, s.x, s.y, s.x, s.y, s.x, s.y).map(c => c[0] + c[1] * this.W)); }   // walls and sight lines cut it, as for an instant burst
  return z._cells;
};
Sim.prototype.zoneHit = function (z, t) {
  const s = this.byId[z.src];
  if (!s || t.dead || !t.onBoard || z.hit[t.uid] === this.round) return;
  if (z.spare && t.team === s.team) return;            // the creatures the caster picked to spare
  z.hit[t.uid] = this.round;
  let act = z.act;
  if (act.riderEffect && t.buffs.some(b => b.id === act.id && b.src === s.uid)) act = Object.assign({}, act, { riderEffect: null });   // already held
  const at = this.mark(), keepC = this._coverFrom;
  this._coverFrom = null;
  try { this.resolveAttackAction(s, act, [t], { aura: true }); } finally { this._coverFrom = keepC; }
  this.hoist(at);
};
/* start of u's turn */
Sim.prototype.zoneTick = function (u) {
  if (!this.zones || !this.zones.length || !u.onBoard) return;
  for (const z of this.zones.slice()) if (z.dmg && !u.dead && this.coversIn(this.zoneCells(z), u)) this.zoneHit(z, u);
};
/* after u has moved: it walked into a zone, or it is the caster and its zone has moved onto others */
Sim.prototype.zoneEnter = function (u) {
  if (!this.zones || !this.zones.length) return;
  for (const z of this.zones.slice()) {
    if (!z.dmg) continue;
    if (z.follow && z.src === u.uid) {
      this.zoneShift(z);
      for (const o of this.units.slice()) if (o !== u && o.onBoard && !o.dead && this.coversIn(this.zoneCells(z), o)) this.zoneHit(z, o);
    } else if (!u.dead && u.onBoard && this.coversIn(this.zoneCells(z), u)) this.zoneHit(z, u);
  }
};
Sim.prototype.zoneShift = function (z) {
  if (!this.record) return;
  const cells = [...this.zoneCells(z)];
  this.ev('zoneEnd', `${z.name} moves`, { uid: z.src, zid: z.zid });
  z.zid = this.zoneSeq = (this.zoneSeq || 0) + 1;
  this.ev('zone', `${z.name} follows its caster`, { uid: z.src, zid: z.zid, cells: cells.map(i => [i % this.W, (i / this.W) | 0]), zkind: 'dmg' });
};
/* a damage zone whose duration has run out */
Sim.prototype.expireZones = function () {
  for (const z of (this.zones || []).slice()) {
    if (!z.dmg || this.round <= z.until) continue;
    const s = this.byId[z.src];
    if (s && s.concentrating === z.id) this.endConcentration(s, 'the spell runs out');
    else if (this.zones.includes(z)) { this.zones = this.zones.filter(x => x !== z); this.ev('zoneEnd', `${z.name} fades`, { uid: z.src, zid: z.zid }); this.applyZones(); }
  }
};
Sim.prototype.endConcentration = function (u, why) {
  if (!u.concentrating) return;
  const id = u.concentrating;
  if ((this.zones || []).some(z => z.src === u.uid && z.id === id)) {
    this.zones.filter(z => z.src === u.uid && z.id === id).forEach(z => this.ev('zoneEnd', z.dmg ? `${z.name} fades` : `the ${z.fog ? 'fog' : 'difficult ground'} fades`, { uid: u.uid, zid: z.zid }));
    this.zones = this.zones.filter(z => !(z.src === u.uid && z.id === id)); this.applyZones();
  }
  u.concentrating = null;
  let any = false;
  this._flyMapVer = -1;
  for (const o of this.units) { const n = o.buffs.length; o.buffs = o.buffs.filter(b => !(b.src === u.uid && b.id === id)); if (o.buffs.length !== n) any = true; }
  if (any) this._rmCache = null;
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
  if (u.alt > 0) this.fallCheck(u);
};
Sim.prototype.kill = function (u, src, why) {
  this.boardChanged();
  u.alt = 0;
  this.endConcentration(u, 'slain');
  u.hp = 0; u.dead = true;
  if (u.isPC) { u.diedRound = this.round; u.diedFight = this.fightNo; }
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
  tgt.visLost = Math.max(0, (tgt.visLost || 0) - (tgt.hp - was));
  tgt.netLost = Math.max(0, (tgt.netLost || 0) - (tgt.hp - was));
  this.seeBloodied(tgt);
  if (tgt.hp > was && tgt.startFull && this.keen(otherTeam(tgt.team))) this.learnBounds(tgt, this.kind(otherTeam(tgt.team), tgt));
  if (src !== tgt && tgt.hp > was) this.learnHeal(src);
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
    if (a.type === 'atk' && src.onBoard && this.alive(src) && this.dist(tgt, src) <= Math.max(5, a._range) && this.losU(tgt, src)) {
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
      this._saveDmg = dmgRoll * (a.ext && a.ext.dot ? 3 : 1); this._saveHalf = a.halfOnSave ? 1 : 0; this._saveA = a;
      if (a.riderEffect && a.riderEffect.buff && DANGER_CONDS.includes(a.riderEffect.buff.condition)) this._saveStakes = 1;
      this._saveCond = a.riderEffect && a.riderEffect.buff ? a.riderEffect.buff.condition : null;
      const s = this.saveRoll(t, Number(avgDice(a.toHit)), u, a.ext && a.ext.saveAbility);
      this._saveDmg = 0; this._saveStakes = 0; this._saveCond = null; this._saveA = null;
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
      const dealt = dmg > 0 ? this.damage(u, t, dmg, { attack: !opt.aura, a }) : 0;
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
    this._strikeBy = u; this._strikesLeft = n - i - 1;       // reactions read how many swings are still to come
    this.attackOnce(u, a, cur, opt);
    this._strikeBy = null; this._strikesLeft = 0;
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
  let dealt = 0, sa = false, smTag = '';
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
    if (r.crit && u.brutalCrit && !a._spell && this.dist(u, t) <= 10) { const bd = parseDice(formula).dice[0]; if (bd) raw += rollDice(`${u.brutalCrit}d${bd.d}`, this.R, false); }   // Brutal Critical
    if (this.sneakOk(u, t, a, r)) {
      sa = true; u.saSeq = this.turnSeq;
      raw += rollDice(u.sneak.dice, this.R, r.crit);
      if (u.sneak.assassinate && this.round === 1) raw += u.sneak.assassinate;     // Assassinate: Surprising Strikes
    }
    // Divine Smite (v2 only): decided now the hit is known, one damage instance with the weapon's, each part of its own type
    const sm = u.v2 && u.smiteSeq === this.turnSeq ? this.v2SmiteHit(u, a, t, r.crit, raw) : null;
    raw *= this.multBuff(u, 'damageMultiplier');
    let apart = 0;
    if (sm) {
      smTag = sm.tag;
      const sR = sm.raw * this.multBuff(u, 'damageMultiplier'), tmW = damageMultFor(a, t), tmS = damageMultFor(null, t, sm.type);
      if (sR > 0) this.learnType(t, { type: sm.type }, tmS);
      if (tmW > 0) raw += sR * tmS / tmW; else apart = sR;
    }
    dealt = this.damage(u, t, Math.max(0, Math.floor(raw)), { attack: true, roll: true, crit: r.crit, a });
    if (apart > 0 && !t.dead) dealt += this.damage(u, t, Math.floor(apart), { attack: true, crit: r.crit, type: sm.type });
  }
  const tag = (r.adv ? ' (adv' + (r.fa === 'assassinate' ? ', Assassinate' : r.fa === 'vex' ? ', Vex' : r.fa === 'pack' ? ', Pack Tactics' : '') + ')' : r.dis ? ' (dis)' : '') + (sa ? ' + Sneak Attack' : '') + smTag;
  this.ev('attack', `${u.name} → ${t.name}: ${a.name}${tag}, ${r.total} vs AC ${r.ac} — ${r.crit && r.hit ? 'CRIT' : r.hit ? 'hit' : r.mirror ? 'image' : 'miss'}${r.hit ? `, ${dealt} damage` : ''}`,
    { uid: u.uid, target: t.uid, hit: r.hit, crit: r.crit && r.hit, dmg: dealt, ranged: this.dist(u, t) > 5, oa: !!opt.oa });
  this.hoist(at);
  if (agathys && !u.dead) {
    const at2 = this.mark();
    const d = this.damage(t, u, agathys.retaliate, { type: agathys.retaliateType || 'cold' });
    this.ev('attack', `${t.name}'s ${agathys.name} bites back at ${u.name}, ${d} damage`, { uid: t.uid, target: u.uid, hit: true, dmg: d });
    this.hoist(at2);
  }
  if (r.hit && a.riderEffect) this.applyRider(u, t, a);
  if (r.hit && ex.onHit) this.onHitEffects(u, t, a, dealt);
  if (r.hit && ex.leap) this.leap(u, a, t, opt);
  this.afterHitExt(u, t, a, r.hit);
  if (!r.hit && !opt.inside && !a.useSaves && (a._range || 5) <= 10 && !u.dead && u.onBoard) this.counterAttack(t, u, 'riposte');
  return r;
};
/* Riposte / Brace: a reaction that answers with one melee attack (ext.riposte or ext.brace: { bonus: '1d10' }) */
/* how much of e's damage is struck in melee, as u reads it: open, the best melee action against the best ranged one; otherwise only what has been seen of its reach */
Sim.prototype.meleeShare = function (u, e) {
  if (this.kOf(u, e)) return this.kReach(u, e) <= 10 ? 1 : 0;
  let m = 0, r = 0;
  for (const o of e.actions) {
    if (o.type !== 'atk' || o.actionSlot !== 0 || (o.ext && (o.ext.swallow || o.ext.wtOnly))) continue;
    const d = avgDice((o.ext && o.ext.wtDpr) || o.dpr) * (o.useSaves ? 1 : Math.max(1, o.targets || 1));
    if ((o._range || 5) <= 10) m = Math.max(m, d); else r = Math.max(r, d);
  }
  return m + r > 0 ? m / (m + r) : 1;
};
/* a readied attack (the Ready action, docs/ai-v2.md): the first foe to come into reach takes one swing, on the reaction */
Sim.prototype.readyStrike = function (e, u) {
  const rd = e.readied;
  if (!rd || !e.reaction || e.dead || e.hp <= 0 || this.incap(e) || !e.onBoard) return false;
  e.readied = null; e.reaction = false;
  const strike = Object.assign({}, rd.a, { targets: 1 });
  this.ev('react', `${e.name}'s readied attack: ${u.name} comes into reach`, { uid: e.uid, target: u.uid });
  this.attackOnce(e, strike, u, { counter: true });
  return true;
};
Sim.prototype.counterAttack = function (t, u, kind) {
  if (!t.reaction || t.dead || t.hp <= 0 || this.incap(t) || !t.onBoard || t.team === u.team) return false;
  const x = t.actions.find(y => y.actionSlot === 4 && y.ext && y.ext[kind] && this.usable(t, y) && this.condOk(t, y));
  if (!x) return false;
  const melee = t.actions.filter(o => o.type === 'atk' && !o.useSaves && o.actionSlot === 0 && (o._range || 5) <= 10 && !(o.ext && (o.ext.swallow || o.ext.resource)))
    .map(o => ({ o, per: avgDice((o.ext && o.ext.wtDpr) || o.dpr) }))
    .filter(m => this.dist(t, u) <= Math.max(5, m.o._range || 5));
  if (!melee.length) return false;
  const best = melee.sort((p, q) => q.per - p.per)[0].o;
  t.reaction = false; this.spend(t, x);
  const bonus = x.ext[kind].bonus;
  const strike = Object.assign({}, best, { name: x.name, targets: 1, dpr: bonus ? cleanDiceE(best.dpr + ' + ' + bonus) : best.dpr, ext: Object.assign({}, best.ext, { wtDpr: undefined }) });
  this.ev('react', kind === 'riposte' ? `${t.name} ripostes as ${u.name} misses` : `${t.name} braces as ${u.name} comes into reach`, { uid: t.uid, target: u.uid });
  this.attackOnce(t, strike, u, { counter: true });
  return true;
};
function cleanDiceE(s) { return String(s).replace(/\s+/g, ' ').replace(/\s*\+\s*/g, ' + ').trim(); }
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
      const d = this.damage(u, o, Math.max(0, Math.floor(rollDice(oh.splash.dmg, this.R, false))), { a, type: oh.splash.type || undefined });
      this.ev('attack', `${a.name} leaps to ${o.name}, ${d} damage`, { uid: u.uid, target: o.uid, hit: true, dmg: d, ranged: true });
      this.hoist(at);
    }
  }
};
/* forced movement: straight away from the source, stopping at walls, creatures and the map edge.
   No opportunity attacks; a drop of 10 ft or more means falling damage (1d6 per 10 ft) and landing prone. */
Sim.prototype.push = function (src, t, ft) {
  // straight away from the nearest part of the pusher's body (a big pusher doesn't shove sideways what stands in front of it)
  const tn = t.n || 1, sn = src.n || 1;
  const dx = gapAxis(t.x, tn, src.x, sn) ? Math.sign(t.x - src.x) : 0, dy = gapAxis(t.y, tn, src.y, sn) ? Math.sign(t.y - src.y) : 0;
  if (!dx && !dy) return;
  const from = { x: t.x, y: t.y }, path = [];
  for (let i = 0; i < Math.round(ft / 5); i++) {
    const nx = t.x + dx, ny = t.y + dy;
    if (!this.fits(t, nx, ny)) break;
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
    const d = this.damage(src, t, Math.floor(rollDice(Math.floor(drop / 2) + 'd6', this.R, false)), { type: 'bludgeoning' });
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
  const next = this.enemiesOf(u).filter(e => e.onBoard && this.alive(e) && !done.has(e.uid) && this.dist(e, t) <= (L.range || 30) && this.losU(t, e));
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
    this._saveStakes = re.buff && DANGER_CONDS.includes(re.buff.condition) ? 1 : 0; this._saveA = a;
    this._saveCond = re.buff && re.buff.condition;
    const s = this.saveRoll(t, re.dc, u, rab);
    this._saveStakes = 0; this._saveCond = null; this._saveA = null;
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
      if (t.alt > 0 && !(u.alt > 0)) this.fallCheck(t);
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
    if ((this.occupant(x, y, v.n) && !(w.dead && x === w.x && y === w.y)) || this.isWall(x, y)) continue;
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
  this.learnAction(u, a);
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
  if ((a._spell || (a.ext && a.ext.innateSpell)) && !opt.inside && this.counterCheck(u, a, plan)) return true;      // a foe's Counterspell
  if ((a.type === 'atk' || a.type === 'debuff') && !plan.area && !opt.inside && this.cancelled(u, a, targets)) return true;
  if (a._spell && (a.type === 'atk' || a.type === 'debuff') && !opt.inside) a = this.spellbreak(u, a);
  if (plan.area && a.ext && a.ext.zone) {
    const cells = new Set(plan.area.cells.map(c => c[0] + c[1] * this.W));
    const old = this.zones.filter(z => z.src === u.uid && z.id === a.id);
    this.zones = this.zones.filter(z => !(z.src === u.uid && z.id === a.id));
    old.forEach(z => this.ev('zoneEnd', `${a.name} moves`, { uid: u.uid, zid: z.zid }));
    const zid = this.zoneSeq = (this.zoneSeq || 0) + 1;
    const zn = { zid, src: u.uid, id: a.id, cells, rough: !!a.ext.zone.difficult, fog: !!a.ext.zone.fog, conc: !!(a._spell && a._spell.conc) };
    if (a.ext.zone.dmg && a.useSaves) {
      const ar = plan.area;
      Object.assign(zn, { dmg: true, follow: !!a.ext.zone.follow, spec: { shape: ar.shape, size: ar.size, explicit: true, square: !!ar.square, bn: ar.bn }, act: a,
        spare: !!(a.ext.area && a.ext.area.selective), name: a.name.replace(/ \(L\d\)$/, ''), hit: {},
        until: a._spell && a._spell.conc && u.concentrating === a.id && u.concUntil ? u.concUntil : this.round + ((a.ext.hold) || 10) - 1 });
      for (const t of targets) zn.hit[t.uid] = this.round;
    }
    this.zones.push(zn);
    this.applyZones();
    this._pendingZone = { zid, cells: [...cells].map(i => [i % this.W, (i / this.W) | 0]), zkind: a.ext.zone.fog ? 'fog' : zn.dmg ? 'dmg' : 'rough', name: a.name, uid: u.uid };
  }
  if (plan.area && this.record) {
    const ar = plan.area;
    const label = { sphere: `${ar.size}-ft-radius burst`, cone: `${ar.size}-ft cone`, line: `${ar.size}-ft line`, cube: `${ar.size}-ft cube`, emanation: ar.square || (a.ext.area && a.ext.area.square) ? `${ar.size * 2}-ft square around it` : `${ar.size} ft around it` }[ar.shape];
    const ff = plan.friends ? plan.friends.filter(f => targets.includes(f)).length : 0;
    this.ev('aoe', `${u.name} unleashes ${a.name} (${label}), catching ${targets.length}${ff ? ` (${ff} of them on its own side)` : ''}`, { uid: u.uid, target: targets[0] && targets[0].uid, shape: ar.shape, size: ar.size, ox: ar.ox, oy: ar.oy, tx: ar.tx, ty: ar.ty, cells: ar.cells, hits: targets.map(t => t.uid), harm: a.type === 'atk' ? 'dmg' : 'cond' });
  }
  if (this._pendingZone) {
    const z = this._pendingZone; this._pendingZone = null;
    this.ev('zone', z.zkind === 'fog' ? `${z.name} fills the area: nobody sees into or out of it` : z.zkind === 'dmg' ? `${z.name} lingers: it hurts whoever starts a turn in it or walks in` : `${z.name} turns the ground into difficult terrain`, { uid: z.uid, zid: z.zid, cells: z.cells, zkind: z.zkind });
  }
  if (a.ext && a.ext.zone && a.ext.zone.fog) return true;
  // cover against Dexterity saves is measured from where the effect comes from: a burst's point, else the caster
  const ar0 = plan.area, keepC = this._coverFrom, keepI = this._ignoreCover;   // reactions can resolve inside another action
  this._coverFrom = ar0 && (ar0.shape === 'sphere' || (ar0.shape === 'cube' && Math.max(Math.abs(ar0.tx - ar0.ox), Math.abs(ar0.ty - ar0.oy)) > 1)) ? { x: ar0.tx, y: ar0.ty } : null;
  this._ignoreCover = /sacred flame/i.test(a.name || '') || !!(a.ext && a.ext.ignoreCover);
  try { return this.doActionInner(u, a, plan, opt, targets); } finally { this._coverFrom = keepC; this._ignoreCover = keepI; }
};
/* a reaction that voids an attack or spell aimed at its user (ext.cancelAction): the attacker saves or loses the action */
Sim.prototype.cancelReaction = function (t) {
  if (!t.reaction || t.dead || t.hp <= 0 || this.incap(t)) return null;
  return t.actions.find(y => y.actionSlot === 4 && y.ext && y.ext.cancelAction && this.usable(t, y) && this.condOk(t, y)) || null;
};
Sim.prototype.cancelled = function (u, a, targets) {
  for (const t of targets) {
    if (t.team === u.team) continue;
    const x = this.cancelReaction(t);
    if (!x || this.dist(t, u) > Math.max(5, x.ext.range || 60)) continue;
    t.reaction = false; this.spend(t, x);
    t.seenCancel = true;
    if (this.learning(otherTeam(t.team))) this.kind(otherTeam(t.team), t).cancel = true;
    const dc = Number(avgDice(x.saveDC));
    const s = dc < 99 ? this.saveRoll(u, dc, t, x.ext.saveAbility) : { success: false, total: 0 };
    if (s.success) { this.ev('react', `${t.name} uses ${x.name}, but ${u.name} pushes through (${s.total} vs DC ${dc})`, { uid: t.uid, target: u.uid }); return false; }
    this.ev('react', `${t.name} uses ${x.name}: ${u.name}'s ${a.name} is cancelled${dc < 99 ? ` (${s.total} vs DC ${dc})` : ''}`, { uid: t.uid, target: u.uid });
    return true;
  }
  return false;
};
/* a reaction that strikes at a spell cast next to it (ext.spellbreaker): a damaging spell loses what the blow deals,
   any other spell's DC drops by 2 */
Sim.prototype.spellbreak = function (u, a) {
  for (const t of this.enemiesOf(u)) {
    if (!t.reaction || t.dead || t.hp <= 0 || this.incap(t) || !t.onBoard) continue;
    const x = t.actions.find(y => y.actionSlot === 4 && y.ext && y.ext.spellbreaker && this.usable(t, y) && this.condOk(t, y));
    if (!x || this.dist(t, u) > Math.max(5, x.ext.spellbreaker.range || 5)) continue;
    const w = t.actions.filter(o => o.type === 'atk' && !o.useSaves && o.actionSlot === 0).map(o => avgDice((o.ext && o.ext.wtDpr) || o.dpr) / Math.max(1, o.targets || 1)).sort((p, q) => q - p)[0] || 0;
    t.reaction = false; this.spend(t, x);
    const blow = Math.max(0, Math.round(rollDice(String(Math.round(w * 2) / 2 || 0), this.R, false)));
    if (a.type === 'atk' && a.useSaves) {
      a = Object.assign({}, a, { toHit: Number(avgDice(a.toHit)) - 2, dpr: blow ? a.dpr + ' - ' + Math.round(blow / Math.max(1, a.targets || 1)) : a.dpr });
      this.ev('react', `${t.name} strikes at ${u.name}'s ${a.name}: DC down by 2, ${blow} less damage`, { uid: t.uid, target: u.uid });
    } else if (a.type === 'atk') {
      a = Object.assign({}, a, { dpr: blow ? a.dpr + ' - ' + Math.round(blow / Math.max(1, a.targets || 1)) : a.dpr });
      this.ev('react', `${t.name} strikes at ${u.name}'s ${a.name}: ${blow} less damage`, { uid: t.uid, target: u.uid });
    } else {
      a = Object.assign({}, a, { saveDC: Number(avgDice(a.saveDC)) - 2 });
      this.ev('react', `${t.name} strikes at ${u.name}'s ${a.name}: its DC drops by 2`, { uid: t.uid, target: u.uid });
    }
    return a;
  }
  return a;
};
/* the chance u's action against t goes through, as u's side sees it */
Sim.prototype.throughChance = function (u, t) {
  if (t.team === u.team) return 1;
  const m = this.kOf(u, t);
  if (m && !(t.seenCancel || (m === 'learn' && this.kind(u.team, t).cancel))) return 1;
  const x = this.cancelReaction(t);
  if (!x) return 1;
  const dc = Number(avgDice(x.saveDC));
  if (dc >= 99) return 0.05;
  return Math.min(1, Math.max(0.05, (21 + this.saveBonusFor(u, x.ext.saveAbility) - dc) / 20));
};
Sim.prototype.doActionInner = function (u, a, plan, opt, targets) {
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
        const pick = u.v2 && isHpPool(a) && u._poolPick ? u._poolPick.get(a.id + "|" + t.uid) : 0;      // v2 chose the points (v2HpPool)
        const n = Math.max(1, Math.min(hx.pool.maxPer || left, left, pick || Math.ceil(need / avgDie)));
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
      const hpWas = t.hp;
      this.heal(u, t, amt, a.tempHP);
      if (a.tempHP && (hx.retaliate || hx.tempBuff)) {
        const lvl = (a._spell && u.castLevel) || 1;
        const data = Object.assign({ duration: 'entire encounter' }, hx.tempBuff || {});
        this.addBuff(t, u, a, data, { whileTemp: true, retaliate: hx.retaliate ? hx.retaliate.dmg * (hx.retaliate.perLevel ? lvl : 1) : 0, retaliateType: hx.retaliate && hx.retaliate.type });
      }
      this.ev('heal', `${u.name} → ${t.name}: ${a.name}, +${a.tempHP ? Math.round(amt) : t.hp - hpWas}${a.tempHP ? ' temp' : ''} HP`, { uid: u.uid, target: t.uid });
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
      this._saveStakes = a.buff && DANGER_CONDS.includes(a.buff.condition) ? 1 : 0; this._saveA = a;
      this._saveCond = a.buff && a.buff.condition;
      const s = this.saveRoll(t, dc, u, sab);
      this._saveStakes = 0; this._saveCond = null; this._saveA = null;
      if (!s.success) { this.addBuff(t, u, a, a.buff, { dc, saveAbility: sab }); if (a.ext && a.ext.onHit) this.onHitEffects(u, t, a, 0); }
      this.ev('save', `${u.name} → ${t.name}: ${a.name}, DC ${dc >= 99 ? '—' : dc}${sab && sab !== 'strdex' && dc < 99 ? ' ' + sab.toUpperCase() : ''} — ${s.autoFail ? 'auto-fails, ' : ''}${s.success ? 'saved' : 'affected' + (a.buff.condition ? ' (' + a.buff.condition + ')' : '')}`,
        { uid: u.uid, target: t.uid, hit: !s.success, dmg: 0, ranged: this.dist(u, t) > 5 });
    }
    return true;
  }
  return false;
};

Object.assign(ENG, { reactFits });
})(typeof window !== 'undefined' ? window : globalThis);
