/* TACTICAL ENGINE: the parts not split out yet (file list and how the parts share names: js/engine/base.js).
   Still here, to be moved one module per commit: knowledge.js, core.js, reactions.js, ai-v1.js, ai-v2.js, ai-boss.js, ai-v2-turn.js, encounter.js, day.js. */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { makeRng, parseDice, rollDice, avgDice, INCAP, DANGER_CONDS, ADV_TARGET, ADV_SELF, DIS_TARGET, DIS_SELF, sizeIdx, finalizeAction, inferRange, listOf, damageMultFor, bestTypeFor, AI_TYPES, autoAI, casterKind, smiteOf, smiteDice, effectName, isHpPool, recoverSlots, makeUnit, freqKind, resetFightState, Sim, areaSpec, areaCells, inArea, MAX_ALT, isHideAction, bodyEdge, offBody, areaOnBody, gapAxis, AI_BASE, AI_PROFILES, aiProfile, AI_TIERS, TIER_PROFILES, tierOf, tierProfile } = ENG;
/* ----- expected outcomes, used by the tactical AI ----- */
/* ===== WHAT EACH SIDE KNOWS =====
   Each side's AI runs in one of three modes (opts.know = { party, foes }):
     open  — reads the real numbers (hit points, AC, saves, resistances, everyone's actions, how many fights are left)
     blind — black box: only what's visible at the table. Size, position, conditions, bloodied or not, the damage it
             has taken and dealt this fight, who it's seen healing or throwing areas around. Hit points, AC, saves and
             damage output come from rough priors by size; resistances are unknown; the day's length is assumed
             (BLIND_FIGHTS, or opts.expectFights).
     learn — knows the day's length (opts.expectFights overrides it); for the rest starts like blind, then reads what it sees: hits and misses bound AC, saves made and failed give the
             save bonus, "it resists that" sticks, the damage that bloodied or dropped a creature gives its hit points.
             It remembers per kind of creature for the rest of the day.
             A learning side on AI v2 is keen: it reads the bloodied flag and its own net damage (learnBounds), and the party starts
             from a threat estimate instead of size (threat, docs/ai-v2.md). opts.threat 'bounds': the bloodied reading alone; false: the classic reading.
   Only the AI's estimates use this; the dice always use the real numbers. */
const SIZE_PRIOR = { Tiny: { hp: 7, dpr: 3 }, Small: { hp: 15, dpr: 6 }, Medium: { hp: 32, dpr: 9 }, Large: { hp: 70, dpr: 16 }, Huge: { hp: 140, dpr: 28 }, Gargantuan: { hp: 260, dpr: 45 } };
const priorOf = t => SIZE_PRIOR[t.size] || SIZE_PRIOR.Medium;
const otherTeam = team => team === 'party' ? 'foes' : 'party';
Sim.prototype.kMode = function (team) { return (this.know && this.know[team]) || 'open'; };
/* what u itself reads: its side's mode, except that a tier's profile (know: 'blind') makes a dull creature read blind even in open mode */
Sim.prototype.kModeFor = function (u) {
  const m = this.kMode(u.team);
  return m === 'open' && u.v2 && u.v2P && u.v2P.know === 'blind' ? 'blind' : m;
};
/* null when u sees the truth about t (its own side, or open mode), else the mode */
Sim.prototype.kOf = function (u, t) {
  if (!u || !t || u.team === t.team) return null;
  const m = this.kModeFor(u);
  return m === 'open' ? null : m;
};
/* what `team` has learned about creatures of t's kind today */
Sim.prototype.kind = function (team, t) {
  const K = this.mem[team];
  let k = K.get(t.tplId);
  if (!k) { k = { acLo: -Infinity, acHi: Infinity, hpLo: 0, hpHi: Infinity, saves: {}, saveEst: {}, mods: null, heals: false, areas: [], range: 0, dealt: 0, turns: 0, caster: false,
                  seen: 0, atk: [], swings: 0, hits: 0, multi: 1, dc: 0, shown: [], conds: [], obsDmg: 0, obsTurns: 0, thAt: -1 }; K.set(t.tplId, k); }
  return k;
};
Sim.prototype.learning = function (team) { return this.kMode(team) === 'learn'; };
/* a learning side on AI v2: reads the bloodied flag and its own net damage, not the classic reading */
Sim.prototype.keen = function (team) { return this.threatMode > 0 && !!this.aiV2 && !!this.aiV2[team] && this.kMode(team) === 'learn'; };
/* the party starts from the threat estimate; a keen foe side keeps its size priors */
Sim.prototype.threatOn = function (team) { return this.threatMode === 2 && team === 'party' && this.keen(team); };
Sim.prototype.learnAC = function (att, tgt, base, hit) {
  if (att.team === tgt.team || !this.learning(att.team)) return;
  const k = this.kind(att.team, tgt);
  if (hit) k.acHi = Math.min(k.acHi, base); else k.acLo = Math.max(k.acLo, base + 1);
  if (k.acLo > k.acHi) { k.acLo = hit ? -Infinity : base + 1; k.acHi = hit ? base : Infinity; }   // a buff it couldn't see: start over
};
Sim.prototype.learnSave = function (t, dc, ab, ok) {
  const team = otherTeam(t.team);
  if (!this.learning(team) || dc >= 99) return;
  const k = this.kind(team, t), key = ab || 'any';
  (k.saves[key] = k.saves[key] || []).push([dc, ok ? 1 : 0]);
  if (k.saves[key].length > 40) k.saves[key].shift();
  k.saveEst = {};
};
Sim.prototype.learnType = function (tgt, info, tm) {
  const team = otherTeam(tgt.team);
  if (!this.learning(team)) return;
  const type = String(info.type || (info.a && info.a.ext && info.a.ext.damageType) || '').toLowerCase();
  if (!type || type.indexOf('/') >= 0 || type.indexOf('+') >= 0) return;
  const k = this.kind(team, tgt);
  if (!k.mods) { if (tm === 1) return; k.mods = { resist: [], immune: [], vulnerable: [] }; }
  const m = k.mods;
  ['resist', 'immune', 'vulnerable'].forEach(f => { const i = m[f].indexOf(type); if (i >= 0) m[f].splice(i, 1); });
  if (tm === 0) m.immune.push(type); else if (tm < 1) m.resist.push(type); else if (tm > 1) m.vulnerable.push(type);
};
/* at half HP or less: public, both ways. A keen side hears it in the log. */
Sim.prototype.seeBloodied = function (t) {
  const b = t.hp > 0 && t.hp * 2 <= t.maxHp;
  if (b === t.bloodied) return;
  t.bloodied = b;
  if (t.hp > 0 && this.keen(otherTeam(t.team))) this.ev('effect', `${t.name} is ${b ? 'bloodied' : 'no longer bloodied'}`, { uid: t.uid });
};
/* a keen side's bounds on maximum HP, from the flag and its own net damage only: not bloodied after N means max > 2N,
   bloodied after D means D < max <= 2D, down after D means max <= D. Bounds that cross: something it couldn't see, keep the latest. */
Sim.prototype.learnBounds = function (t, k) {
  const n = t.netLost, lo = t.hp <= 0 ? 0 : t.bloodied ? n + 1 : n * 2 + 1, hi = t.hp <= 0 ? n : t.bloodied ? n * 2 : Infinity;
  k.hpLo = Math.max(k.hpLo, lo); k.hpHi = Math.min(k.hpHi, hi);
  if (k.hpLo > k.hpHi) { k.hpLo = lo; k.hpHi = hi; }
  k.seen++;
};
Sim.prototype.learnHp = function (t) {
  const team = otherTeam(t.team);
  this.seeBloodied(t);
  if (!this.learning(team) || !t.startFull) return;
  const k = this.kind(team, t), lost = t.visLost;
  if (this.keen(team)) { this.learnBounds(t, k); return; }
  if (t.hp <= 0) k.hpHi = Math.min(k.hpHi, lost);
  else { k.hpLo = Math.max(k.hpLo, lost + 1); if (t.hp < t.maxHp / 2) k.hpHi = Math.min(k.hpHi, lost * 2); else k.hpLo = Math.max(k.hpLo, lost * 2); }
  if (k.hpLo > k.hpHi) { k.hpLo = lost; k.hpHi = Infinity; }
};
Sim.prototype.learnHeal = function (src) {
  src.seenHeal = true;
  if (this.learning(otherTeam(src.team))) this.kind(otherTeam(src.team), src).heals = true;
};
Sim.prototype.learnAction = function (u, a) {
  if (a._spell) u.seenCaster = true;
  if ((a.type === 'atk' || a.type === 'debuff') && a._range) u.seenRange = Math.max(u.seenRange || 0, a._range);
  const sp = areaSpec(a);
  const area = sp && (a.type === 'atk' || a.type === 'debuff') ? { id: a.id, shape: sp.shape, size: sp.size, range: Math.max(5, a._range || 5), dmg: a.type === 'atk' ? avgDice((a.ext && a.ext.wtDpr) || a.dpr) : 8 } : null;
  if (area) { u.seenAreas = u.seenAreas || []; if (!u.seenAreas.some(x => x.id === a.id)) u.seenAreas.push(area); (u.areaUsed = u.areaUsed || {})[a.id] = true; }
  const team = otherTeam(u.team);
  if (!this.learning(team)) return;
  const k = this.kind(team, u);
  if (a._spell) k.caster = true;
  if (a.type === 'atk' || a.type === 'debuff') k.range = Math.max(k.range, a._range || 5);
  if (area && !k.areas.some(x => x.id === a.id)) k.areas.push(area);
  if ((a.type === 'atk' || a.type === 'debuff') && this.threatOn(team) && k.shown.indexOf(a.id) < 0) { k.shown.push(a.id); k.seen++; }
};
/* what the party sees an enemy do, for the threat estimate */
Sim.prototype.learnActive = function (u, k) {            // a turn it did something to us (walking up doesn't count against its damage)
  if (u.obsTurn !== u.fightTurns) { u.obsTurn = u.fightTurns; u.obsSwings = 0; k.obsTurns++; }
};
Sim.prototype.learnAtk = function (att, tgt, ac, plain, hit) {
  if (att.team === tgt.team || !this.threatOn(tgt.team)) return;
  const k = this.kind(tgt.team, att);
  this.learnActive(att, k);
  k.multi = Math.max(k.multi, ++att.obsSwings); k.swings++; if (hit) k.hits++;
  if (plain) { k.atk.push([ac, hit ? 1 : 0]); if (k.atk.length > 40) k.atk.shift(); }
  k.seen++;
};
Sim.prototype.learnDc = function (src, t, dc) {
  if (!src || !src.team || src.team === t.team || dc >= 99 || !this.threatOn(t.team)) return;
  const k = this.kind(t.team, src);
  this.learnActive(src, k);
  if (dc > k.dc) { k.dc = dc; k.seen++; }
};
/* damage per turn is read against a table of one target: an area counts its first victim only */
Sim.prototype.learnDmg = function (src, tgt, dmg, info) {
  if (src.team === tgt.team || !this.threatOn(tgt.team)) return;
  const a = info && info.a, k = this.kind(tgt.team, src);
  if (a && (a.useSaves || areaSpec(a))) { const key = a.id + ':' + src.fightTurns; if (src.obsArea === key) return; src.obsArea = key; }
  this.learnActive(src, k);
  k.obsDmg += dmg; k.seen++;
};
Sim.prototype.learnCond = function (src, t, cond) {
  if (src.team === t.team || !this.threatOn(t.team) || !AI_BASE.threat.cond[cond]) return;
  const k = this.kind(t.team, src);
  if (k.conds.indexOf(cond) < 0) { k.conds.push(cond); k.seen++; }
};
/* end of a fight: fold what each creature did into its kind's record */
Sim.prototype.learnFight = function () {
  for (const u of this.units) {
    const team = otherTeam(u.team);
    if (!this.learning(team) || !u.fightTurns) continue;
    const k = this.kind(team, u);
    k.dealt += u.dmgDealt; k.turns += u.fightTurns;
  }
};
/* ---- the threat estimate (docs/ai-v2.md): how strong a kind of creature seems, on the CR scale ---- */
/* the column f of the threat table at score c */
function threatAt(f, c) {
  const r = AI_BASE.threat.table;
  if (c <= r[0].cr) return r[0][f];
  for (let i = 1; i < r.length; i++) if (c <= r[i].cr) return r[i - 1][f] + (r[i][f] - r[i - 1][f]) * (c - r[i - 1].cr) / (r[i].cr - r[i - 1].cr);
  return r[r.length - 1][f];
}
/* the score at which column f reads v; a flat stretch reads as its middle */
function threatCr(f, v) {
  const r = AI_BASE.threat.table;
  let i = 0;
  while (i < r.length && r[i][f] < v) i++;
  if (i === r.length) return r[i - 1].cr;
  if (r[i][f] > v) return i ? r[i - 1].cr + (r[i].cr - r[i - 1].cr) * (v - r[i - 1][f]) / (r[i][f] - r[i - 1][f]) : r[0].cr;
  let j = i;
  while (j + 1 < r.length && r[j + 1][f] === v) j++;
  return (r[i].cr + r[j].cr) / 2;
}
/* before anything is seen: a typical creature for the party's level, shared out over the enemies in view */
Sim.prototype.threatPrior = function (team) {
  const T = AI_BASE.threat, mine = this.units.filter(o => o.team === team), n = Math.max(1, this.units.length - mine.length);
  const level = mine.reduce((s, o) => s + (+(o.tpl && o.tpl.class && o.tpl.class.level) || T.level), 0) / Math.max(1, mine.length);
  let crowd = 1;
  for (const [from, m] of T.crowd) if (n >= from) crowd = m;
  return threatCr('xp', threatAt('xp', level * T.crPerLevel) * mine.length / T.partySize / n / crowd);
};
/* the most likely attack bonus given its plain rolls against our ACs */
function threatAtk(obs) {
  const T = AI_BASE.threat;
  let best = 0, bestL = -Infinity;
  for (let b = T.atkMin; b <= T.atkMax; b++) {
    let L = 0;
    for (const o of obs) { const p = Math.min(0.95, Math.max(0.05, (21 + b - o[0]) / 20)); L += Math.log(o[1] ? p : 1 - p); }
    if (L > bestL) { bestL = L; best = b; }
  }
  return best;
}
/* the score of t's kind as `team` reckons it, and what it reads as; recomputed when something new was seen */
Sim.prototype.threat = function (team, t) {
  const k = this.kind(team, t);
  if (k.thAt === k.seen) return k;
  const T = AI_BASE.threat;
  if (k.thPrior === undefined) k.thPrior = this.threatPrior(team);
  let W = T.prior, S = T.prior * k.thPrior;
  const add = (cr, w) => { S += cr * w; W += w; };
  if (k.atk.length) add(threatCr('atk', threatAtk(k.atk)), T.atk * k.atk.length / (k.atk.length + T.atkHalf));
  if (k.dc) add(threatCr('dc', k.dc), T.dc);
  if (k.legRes) add(T.legCr, T.legRes);
  if (k.obsTurns) {
    const hit = Math.max(T.hitFloor, (k.hits + T.hitPrior * T.hitHalf) / (k.swings + T.hitHalf));
    add(threatCr('dpr', k.obsDmg / k.obsTurns / hit), T.dmg * k.obsTurns / (k.obsTurns + T.dmgHalf));
  }
  let c = S / W;
  const floor = f => { if (f > c) c += (f - c) * T.floor; };
  if (k.multi > 1) floor(threatCr('attacks', k.multi));
  if (k.shown.length > 1) floor(threatCr('shown', k.shown.length));
  for (const x of k.conds) floor(T.cond[x]);
  if (k.hpHi < Infinity) c = Math.min(c, threatCr('hp', k.hpHi));   // the bounds win, and move the score with them
  if (k.hpLo > 0) c = Math.max(c, threatCr('hp', k.hpLo));
  k.th = c; k.thAt = k.seen;
  k.thHp = threatAt('hp', c); k.thAc = threatAt('ac', c);
  if (c !== k.thSaveAt) { k.thSaveAt = c; k.thSave = threatAt('save', c); k.saveEst = {}; }
  return k;
};
// ---- the estimates the AI uses ----
Sim.prototype.kMax = function (u, t) {
  const m = this.kOf(u, t); if (!m) return t.maxHp;
  if (this.threatOn(u.team)) {
    const k = this.threat(u.team, t);
    if (k.hpHi < Infinity && k.hpLo > 0) return Math.max(1, (k.hpLo + k.hpHi) / 2);
    return Math.max(1, k.hpLo, Math.min(k.hpHi, k.thHp));
  }
  const pr = priorOf(t).hp;
  if (m === 'blind') return pr;
  const k = this.kind(u.team, t);
  if (k.hpHi < Infinity && k.hpLo > 0) return Math.max(1, (k.hpLo + k.hpHi) / 2);
  if (k.hpHi < Infinity) return Math.max(1, Math.min(pr, k.hpHi * 0.85));
  if (k.hpLo > 0) return Math.max(pr, k.hpLo * 1.15);
  return pr;
};
/* hit points left out of an estimated max, from the damage seen and bloodied or not */
Sim.prototype.kLeft = function (u, t, max) {
  const keen = this.keen(u.team);
  let est = max - ((keen ? t.netLost : t.visLost) || 0);
  if (keen ? t.bloodied : t.hp < t.maxHp / 2) est = Math.min(est, max * 0.45); else est = Math.max(est, max * 0.55);
  return Math.max(1, est);
};
Sim.prototype.kHp = function (u, t) {
  if (!this.kOf(u, t) || t.dead || t.hp <= 0) return t.hp;        // down and dead are plain to see
  return this.kLeft(u, t, this.kMax(u, t));
};
/* hit points left on a boss-sized creature (one the party reckons has Legendary Resistance), for the burn plan. Learn mode
   without the threat estimate starts from a bigger prior than kHp's flat size prior (a Huge boss is rarely 140), and any
   bound the party has seen (bloodied, down) replaces it. Blind keeps the flat prior; the threat estimate needs neither. */
const BOSS_HP = { Huge: 225, Gargantuan: 400 };
Sim.prototype.kBossHp = function (u, t) {
  if (this.kMode(u.team) !== 'learn' || this.threatOn(u.team) || !this.kOf(u, t) || t.dead || t.hp <= 0 || !BOSS_HP[t.size]) return this.kHp(u, t);
  const k = this.kind(u.team, t);
  let max;
  if (k.hpHi < Infinity) max = this.kMax(u, t);                     // bloodied or down: seen, not guessed
  else max = Math.max(BOSS_HP[t.size], k.hpLo * 1.15);
  return this.kLeft(u, t, max);
};
Sim.prototype.kFrac = function (u, t) { return this.kOf(u, t) ? Math.max(0, Math.min(1, this.kHp(u, t) / this.kMax(u, t))) : Math.max(0, t.hp / t.maxHp); };
Sim.prototype.kDpr = function (u, t) {
  const m = this.kOf(u, t);
  if (!m && this.dprSeenBy(u, t)) return this.kDprOpen(u, t);
  if (!m) return t.dpr;
  const pr = priorOf(t).dpr;
  let dealt = t.dmgDealt || 0, turns = t.fightTurns || 0;
  if (m === 'learn') { const k = this.kind(u.team, t); dealt += k.dealt; turns += k.turns; }
  return (dealt + pr * 1.5) / (turns + 1.5);
};
/* open mode, read better (w.dprSeen > 0; the boss tier): t.dpr is its first attack's average, which leaves out a caster's spells. Its best single action it
   can still use (spells while it has the slot), blended with what it has dealt this fight, as learn blends its prior (docs/ai-v2.md "Boss tier") */
/* u reads t's DPR through kDprOpen: open mode, the other side, a v2 reader whose profile asks for it (dprSeenPC for the party, dprSeen for monsters) */
Sim.prototype.dprSeenBy = function (u, t) {
  return !!(u && t && u.team !== t.team && u.v2 && u.v2P && (u.isPC ? u.v2P.w.dprSeenPC : u.v2P.w.dprSeen) && !this.kOf(u, t));
};
/* the DPR an option's worth in v2Value is weighed by (the damage weight and the kill): on kDprOpen's reading, the sheet's figure plus dprSeenGap of what
   the better reading adds. A martial foe the sheet already reads right keeps its weight; a caster's or a boss's rises partway (docs/ai-v2.md) */
Sim.prototype.kDprW = function (u, t) {
  const d = this.kDpr(u, t);
  if (!this.dprSeenBy(u, t)) return d;
  const sheet = t.dpr || 0;
  return d > sheet ? sheet + (d - sheet) * u.v2P.w.dprSeenGap : d;
};
Sim.prototype.kDprOpen = function (u, t) {
  let best = t.dpr || 0;
  for (const a of t.actions) if (a.actionSlot === 0 && a.type === 'atk' && !(a.ext && a.ext.swallow) && this.usable(t, a))
    best = Math.max(best, avgDice((a.ext && a.ext.wtDpr) || a.dpr) * (a.useSaves ? 1 : (a.targets || 1)));
  if (!u.v2P.w.dprSeenDealt) return best;
  const w = u.isPC ? u.v2P.w.dprSeenPC : u.v2P.w.dprSeen;
  return ((t.dmgDealt || 0) + best * 1.5 * w) / ((t.fightTurns || 0) + 1.5 * w);
};
Sim.prototype.kAc = function (u, t) {
  const m = this.kOf(u, t); if (!m) return this.ac(t);
  const vis = this.sumBuff(t, 'ac', false);
  if (m === 'blind') return 14 + vis;
  const k = this.kind(u.team, t), pr = this.threatOn(u.team) && AI_BASE.threat.useAc ? this.threat(u.team, t).thAc : 14;
  let e = pr;
  if (k.acLo > -Infinity && k.acHi < Infinity) e = (k.acLo + k.acHi) / 2;
  else if (k.acLo > -Infinity) e = Math.max(pr, k.acLo + 0.5);
  else if (k.acHi < Infinity) e = Math.min(pr, k.acHi - 0.5);
  return e + vis;
};
Sim.prototype.kSave = function (u, t, ab) {
  const m = this.kOf(u, t); if (!m) return this.saveBonusFor(t, ab);
  if (m === 'blind') return 2;
  const T = AI_BASE.threat, th = this.threatOn(u.team) && T.useSave, k = th ? this.threat(u.team, t) : this.kind(u.team, t), key = ab || 'any';
  if (k.saveEst[key] !== undefined) return k.saveEst[key];
  // the prior: +2, or with the threat estimate that ability's column at the kind's score (a save with no ability: the all-saves column)
  const pr = th ? 2 + T.saveShare * (threatAt(T.table[0][key] !== undefined ? key : 'save', k.th) - 2) : 2;
  // most likely bonus given the saves seen (this ability counts fully, the others a little), pulled toward the prior
  const obs = [];
  for (const kk in k.saves) for (const o of k.saves[kk]) obs.push([o[0], o[1], kk === key ? 1 : 0.3]);
  let best = 2, bestL = -Infinity;
  for (let b = -2; b <= 14; b++) {
    let L = -((b - pr) * (b - pr)) / 18;
    for (const o of obs) { const p = Math.min(0.95, Math.max(0.05, (21 + b - o[0]) / 20)); L += o[2] * Math.log(o[1] ? p : 1 - p); }
    if (L > bestL) { bestL = L; best = b; }
  }
  k.saveEst[key] = best;
  return best;
};
/* immunities a table knows from the name alone (the user's decision: obvious ones only). Learn on v2 reads them until it has seen what the kind takes */
const NAME_PRIORS = [
  [/\b(red|gold|brass)\b.*\b(dragon|wyrmling)\b/i, ['fire']],
  [/\b(white|silver)\b.*\b(dragon|wyrmling)\b/i, ['cold']],
  [/\b(blue|bronze)\b.*\b(dragon|wyrmling)\b/i, ['lightning']],
  [/\b(black|copper)\b.*\b(dragon|wyrmling)\b/i, ['acid']],
  [/\bgreen\b.*\b(dragon|wyrmling)\b/i, ['poison']],
  [/\bfire (giant|elemental)\b|\b(magma|fire) mephit\b|\bhell hound\b|\bsalamander\b/i, ['fire']],
  [/\bfrost giant\b|\bice mephit\b/i, ['cold']],
  [/\bstorm giant\b/i, ['lightning', 'thunder']],
];
function namePrior(name) {
  const immune = [];
  for (const [re, types] of NAME_PRIORS) if (re.test(name || '')) for (const x of types) if (immune.indexOf(x) < 0) immune.push(x);
  return immune.length ? { resist: [], immune, vulnerable: [] } : null;
}
Sim.prototype.kMult = function (u, a, t) {
  const m = this.kOf(u, t); if (!m) return damageMultFor(a, t);
  if (m === 'blind') return 1;
  const k = this.kind(u.team, t);
  if (k.mods) return damageMultFor(a, { dmgMods: k.mods, buffs: [] });
  const named = this.keen(u.team) ? namePrior((t.tpl && t.tpl.name) || t.name) : null;
  return named ? damageMultFor(a, { dmgMods: named, buffs: [] }) : 1;
};
Sim.prototype.kHeals = function (u, t) {
  const m = this.kOf(u, t); if (!m) return t.actions.some(o => o.type === 'heal' && o.target !== 'self');
  return !!t.seenHeal || (m === 'learn' && this.kind(u.team, t).heals);
};
/* area attacks u's side knows t has: [{ shape, size, range, dmg }] */
Sim.prototype.kAreas = function (u, t) {
  const m = this.kOf(u, t);
  if (!m) return t.actions.filter(a => (a.type === 'atk' || a.type === 'debuff') && a.actionSlot === 0 && (areaSpec(a) || ((a.useSaves || a.type === 'debuff') && (a.targets || 1) > 1)) && this.usable(t, a))
    .map(a => { const sp = areaSpec(a) || { shape: 'sphere', size: 10 }; return { id: a.id, shape: sp.shape, size: sp.size, range: Math.max(5, a._range || 5), dmg: a.type === 'atk' ? avgDice((a.ext && a.ext.wtDpr) || a.dpr) : 8 }; });
  const seen = t.seenAreas || [];
  return m === 'learn' ? seen.concat(this.kind(u.team, t).areas.filter(x => !seen.some(y => y.id === x.id))) : seen;
};
/* the chance a recharge action comes back at the start of its user's turn, from the rules (Recharge 5-6: 1/3), as `turn` rolls it */
const rechargeChance = a => Math.max(1, Math.round(6 / Math.max(1, (a.freq && a.freq.cooldownRounds) || 2))) / 6;
/* area attacks u's side knows t has, each with the chance it is ready on t's next turn (docs/ai-v2.md, breath spacing; AI v2):
   [{ id, shape, size, range, dmg, width, placed, ready }]. Open: the real state (ready 1; a spent recharge its recharge chance; a spent
   limited one 0). Learn and blind: what kAreas knows, ready until it is seen used this fight, then (a recharge) its recharge chance */
Sim.prototype.kAreasNext = function (u, t) {
  const m = this.kOf(u, t);
  const geo = a => { const sp = a && areaSpec(a); return sp ? { width: sp.width || 5, placed: !!sp.placed } : { width: 5, placed: false }; };
  if (!m) {
    const out = [];
    for (const a of t.actions) {
      if (!((a.type === 'atk' || a.type === 'debuff') && a.actionSlot === 0 && (areaSpec(a) || ((a.useSaves || a.type === 'debuff') && (a.targets || 1) > 1)))) continue;
      const ok = this.usable(t, a), ready = freqKind(a.freq) === 'recharge' ? (ok ? 1 : rechargeChance(a)) : ok ? 1 : 0;
      if (!ready) continue;
      const sp = areaSpec(a) || { shape: 'sphere', size: 10 };
      out.push(Object.assign({ id: a.id, shape: sp.shape, size: sp.size, range: Math.max(5, a._range || 5), dmg: a.type === 'atk' ? avgDice((a.ext && a.ext.wtDpr) || a.dpr) : 8, ready }, geo(a)));
    }
    return out;
  }
  return this.kAreas(u, t).map(x => {
    const a = t.actions.find(o => o.id === x.id), used = !!(t.areaUsed && t.areaUsed[x.id]);
    return Object.assign({}, x, geo(a), { ready: used && a && freqKind(a.freq) === 'recharge' ? rechargeChance(a) : 1 });
  });
};
Sim.prototype.kCaster = function (u, t) {
  const m = this.kOf(u, t); if (!m) return !!t.hasSpells;
  return !!t.seenCaster || (m === 'learn' && this.kind(u.team, t).caster);
};
/* Legendary Resistance uses t has left, as u's side reckons it. Open: the real count. Blind and learn: none until one is
   seen (a use is a public event), then the usual 3 less the uses seen (learn: or the most seen on that kind today). No
   guess from size: plenty of Huge creatures (Hill Giants) have none, and assuming three made the party shy away from
   control that works. */
Sim.prototype.kLegRes = function (u, t) {
  const m = this.kOf(u, t); if (!m) return t.legResMax ? (t.uses.get('__legres') || 0) : 0;
  const k = m === 'learn' ? this.kind(u.team, t) : null, known = k ? (k.legRes || 0) : 0, seen = t.legSeen || 0;
  return seen || known ? Math.max(0, Math.max(3, known) - seen) : 0;
};
/* does t shrug off condition `cond`? Open: the sheet. Blind: no idea. Learn: once seen ("is immune to being…") */
Sim.prototype.kImmune = function (u, t, cond) {
  const m = this.kOf(u, t), c = String(cond || '').toLowerCase();
  if (!c) return false;
  if (!m) return !!(t.condImmune && t.condImmune.indexOf(c) >= 0);
  return m === 'learn' && !!(t.seenImmune && t.seenImmune.indexOf(c) >= 0);
};
Sim.prototype.kReach = function (u, t) {
  const m = this.kOf(u, t); if (!m) return null;
  return Math.max(5, t.seenRange || 0, m === 'learn' ? this.kind(u.team, t).range : 0);
};
/* fights still to come today, as u's side reckons it. Open and learn: the real count (learn knows the day's length).
   opts.expectFights (the day's length the party expects, all fights counted) overrides learn and blind; blind otherwise
   assumes BLIND_FIGHTS. Before fight 1 (fightNo unset: the morning) it is the whole day. */
const BLIND_FIGHTS = 2;
Sim.prototype.leftFor = function (u) {
  const m = this.kMode(u.team), N = this.expectFights || (m === 'blind' ? BLIND_FIGHTS : 0);
  if (m === 'open' || !N) return this.encountersLeft || 0;
  return this.fightNo === undefined ? N : Math.max(0, N - 1 - this.fightNo);
};

Sim.prototype.hitChance = function (u, t, a) {
  const tc = this.conds(t), atc = this.conds(u);
  if (u.blindsight) { atc.delete('Blinded'); tc.delete('Invisible'); }
  const close = this.dist(u, t) <= 5;
  const adv = ADV_TARGET.some(x => tc.has(x)) || ADV_SELF.some(x => atc.has(x)) || !!this.featureAdv(u, t) || (tc.has('Prone') && close);
  const dis = DIS_TARGET.some(x => tc.has(x)) || DIS_SELF.some(x => atc.has(x)) || (tc.has('Prone') && !close);
  let p = Math.min(0.95, Math.max(0.05, (21 + avgDice(a.toHit) + this.sumBuff(u, 'toHit', false) - this.kAc(u, t) - this.coverAC(u, t)) / 20));
  if (adv && !dis) p = 1 - Math.pow(1 - p, u.elvenAccuracy ? 3 : 2);
  else if (dis && !adv) p = p * p;
  return p;
};
Sim.prototype.expected = function (u, a, t) {
  const sab = a.ext && a.ext.saveAbility;
  const saveP = dc => Math.min(1, Math.max(0, (21 + this.kSave(u, t, sab) - dc) / 20));
  if (a.type === 'atk') {
    const sneakAvg = u.sneak && a.ext && a.ext.sneak && u.saSeq !== this.turnSeq ? avgDice(u.sneak.dice) * (this.featureAdv(u, t) || this.alliesOf(u).some(o => o !== u && o.onBoard && this.alive(o) && this.dist(o, t) <= 5) ? 0.95 : 0.35) : 0;
    const dmg = Math.max(0, (avgDice((a.ext && a.ext.dprIfHurt && t.hp < t.maxHp) ? a.ext.dprIfHurt : (a.ext && a.ext.wtDpr) || a.dpr) + sneakAvg / Math.max(1, a.targets || 1) + this.sumBuff(u, 'damage', false)) * this.multBuff(u, 'damageMultiplier') * this.multBuff(t, 'damageTakenMultiplier') * this.kMult(u, a, t));
    const thru = areaSpec(a) ? 1 : this.throughChance(u, t);
    if (a.useSaves) { const ps = saveP(avgDice(a.toHit)); return thru * dmg * ((1 - ps) + (a.halfOnSave ? ps / 2 : 0)); }
    return thru * dmg * this.hitChance(u, t, a) * (a.targets || 1);
  }
  if (a.type === 'debuff') {
    let v = this.effectValue(a.buff, t, true, u);
    const ex = a.ext || {};
    if (typeof ex.speedBonus === 'number' && ex.speedBonus < 0) v += this.meleeReach(t) > 0 ? this.kDpr(u, t) * (ex.speedBonus <= -30 ? 0.5 : 0.25) : 1;
    if (ex.onHit && ex.onHit.noReactions && t.reaction) v += 1.5 + (this.cancelReaction(t) || t.actions.some(o => o.actionSlot === 4 && this.usable(t, o)) ? 2 : 0);
    return (areaSpec(a) ? 1 : this.throughChance(u, t)) * (1 - saveP(avgDice(a.saveDC))) * v;
  }
  return 0;
};

/* How much a tactical creature wants to use action `a` on `t`, standing at (x,y) */
Sim.prototype.friendPenalty = function (u, a, friends) {
  let p = 0;
  for (const f of friends) {
    // a downed ally takes a failed death save (or dies); a standing one takes the hit and the condition
    if (f.hp <= 0) p += 40 + f.deathF * 20;
    else { const e = this.expected(u, a, f); p += e * (f === u ? 1.4 : 1.7) + (e >= f.hp ? 25 : 0); }
  }
  return p;
};
Sim.prototype.targetValue = function (u, a, t, pool, x, y, noArea) {
  const offensive = a.type === 'atk' || a.type === 'debuff';
  let val = 0, why = '';
  if (offensive && t.hp <= 0) {
    // each hit is a failed death save; within 5 ft it's a crit, so two
    const near = this.distXY(x, y, t) <= 5;
    const hits = a.useSaves ? 1 : (a.targets || 1);
    const p = a.useSaves ? 1 : this.hitChance(u, t, a);
    const need = Math.max(1, 3 - t.deathF);
    const pKill = Math.min(1, hits * p * (near && !a.useSaves ? 2 : 1) / need);
    const healers = this.alliesOf(t).filter(o => o !== t && this.alive(o) && this.kHeals(u, o)).length;
    return { val: pKill * (10 + this.kDpr(u, t)) * (healers ? 1.4 : 0.8), why: 'execute' };
  }
  if (offensive) {
    const exp = this.expected(u, a, t);
    const tHp = this.kHp(u, t), tDpr = this.kDpr(u, t);
    val = Math.min(exp, tHp + 4) * (1 + tDpr / 20);
    if (a.type === 'atk' && exp >= tHp * 0.9) { val += 12 + tDpr * 0.5; why = 'finish'; }
    if (this.kHeals(u, t)) { val += 4; why = why || 'healer'; }
    // break its concentration: worth what the spell it's holding is doing, times the chance the hits make it drop
    if (t.concentrating && a.type === 'atk' && exp < tHp) {
      const held = this.concValue(u, t);
      if (held > 0) {
        const con = this.kOf(u, t) ? this.kSave(u, t, 'con') : (t.conSave || 0);
        const hits = a.useSaves ? 1 : (a.targets || 1), p = a.useSaves ? 1 : this.hitChance(u, t, a);
        const perHit = exp / Math.max(0.05, hits * p);
        const pf = Math.min(0.95, Math.max(0.05, (Math.max(10, Math.floor(perHit / 2)) - con - 1) / 20));
        val += held * (1 - Math.pow(1 - p * pf, hits));
        why = why || 'concentration';
      }
    }
    val += (1 - this.kFrac(u, t)) * 4;
    const allyOn = this.alliesOf(u).filter(o => o !== u && this.alive(o) && o.onBoard && this.dist(o, t) <= 5).length;
    val += allyOn * 1.5;   // focus fire
    // don't wake up a creature our side has laughing (Hideous Laughter breaks on a save each time it's hurt), unless it'll drop
    if (a.type === 'atk' && exp < tHp && t.buffs.some(b => b.saveOnDamage && this.byId[b.src] && this.byId[b.src].team === u.team)) { val *= 0.25; why = why || 'leave it laughing'; }
    // protect our casters: whoever is in their face is worth more
    const menacing = this.alliesOf(u).filter(o => o !== u && this.alive(o) && o.onBoard && this.dist(o, t) <= 5 && !this.hasMelee(o)).length;
    if (menacing && this.hasMelee(u)) { val += 4 * menacing; why = why || 'guard'; }
    const fromT = x === undefined || (x === t.x && y === t.y);
    const ac = noArea ? null : this.areaCatch(a, t, fromT ? u.x : x, fromT ? u.y : y, pool.filter(o => o.hp > 0), u);
    let friendly = false;
    if (ac) {
      const extra = ac.extra;
      val += extra.reduce((sum, o) => sum + this.expected(u, a, o), 0);
      if (extra.length) why = 'cluster';
      if (ac.friends.length) { friendly = true; val -= this.friendPenalty(u, a, ac.friends); }
    }
    const top = Math.max(0, ...pool.filter(o => o.hp > 0).map(o => this.kDpr(u, o)));
    const others = pool.filter(o => o !== t && o.hp > 0).map(o => this.kDpr(u, o));
    if (!why && others.length && tDpr >= top && tDpr > 0 && Math.min(...others) < tDpr * 0.8) why = 'threat';
    if (!why && allyOn) why = 'focus';
    // leave a creature that's been talked out of the fight (Suggestion) alone, unless this kills it
    const lulled = o => o.buffs.some(b => b.endsOnDamage) && this.incap(o);
    if (lulled(t) && pool.some(o => o !== t && o.hp > 0 && !lulled(o)) && !(a.type === 'atk' && exp >= tHp * 0.9)) { val = val * 0.1 - 6 - tDpr; why = ''; }
    if (ac && a.type === 'atk') for (const o of ac.extra) if (lulled(o)) val -= 6 + this.kDpr(u, o) * 1.5;
    if (friendly && !why) why = 'cluster';
    // Fog Cloud: worth the damage it stops ranged enemies (not already in someone's face) from dealing,
    // minus the targets it takes away from our own shooters
    if (a.ext && a.ext.zone && a.ext.zone.fog && !noArea) {
      if (this.zones && this.zones.some(z => z.fog && z.src === u.uid)) return { val: -Infinity, why: '' };
      const mine = this.alliesOf(u).filter(o => o.onBoard && this.alive(o));
      const shooters = mine.filter(o => o.actions.some(q => q.type === 'atk' && q.actionSlot === 0 && (q._range || 5) > 15)).length;
      const caught = [t].concat(ac ? ac.extra : []);
      val = 0;
      for (const c of caught) {
        const engagedC = mine.some(o => this.dist(o, c) <= Math.max(5, this.meleeReach(c)));
        const kr = this.kReach(u, c);
        const rangedC = kr !== null ? kr > 15 : (this.meleeReach(c) === 0 || c.actions.some(q => q.type === 'atk' && (q._range || 5) > 15));
        val += rangedC && !engagedC ? this.kDpr(u, c) * 2.2 : -this.kDpr(u, c) * 0.2;
      }
      val -= shooters * 2 * caught.length / Math.max(1, pool.length);
      return { val, why: 'cluster' };
    }
    return { val, why, friendly };
  }
  if (a.type === 'heal') return { val: (t.hp <= 0 ? 50 : 0) + (1 - t.hp / t.maxHp) * 20, why: t.hp <= 0 ? 'revive' : '' };
  return { val: this.effectValue(a.buff, t, false, u) + (t === u ? 0.3 : 0), why: '' };
};
/* what t's concentration spell is worth to t's side, as u sees it: the effects it holds on u's side and on its own,
   the zone it keeps up, the weapon it conjured */
Sim.prototype.concValue = function (u, t) {
  const id = t.concentrating;
  if (!id) return 0;
  let v = 3;
  for (const o of this.units) {
    if (!o.onBoard || o.dead) continue;
    for (const b of o.buffs) if (b.src === t.uid && b.id === id) v += o.team === u.team ? this.effectValue(b.data, o, true) : this.effectValue(b.data, o, false, u) * 0.6;
  }
  if (t.buffs.some(b => b.id === id && b.src === t.uid)) v += 5;
  for (const z of this.zones || []) if (z.src === t.uid && z.conc) for (const o of this.alliesOf(u)) if (o.onBoard && this.alive(o) && this.coversIn(this.zoneCells(z), o)) v += 3;
  return v;
};
/* the value of putting buff/debuff `b` on `t` (tactical) */
const DUR_WEIGHT = { 'entire encounter': 3, 'repeat the save each round': 2, '1 round': 1, 'until next attack made': 0.6, 'until next attack taken': 0.6 };
Sim.prototype.effectValue = function (b, t, hostile, obs) {
  if (!b) return 0;
  const tDpr = obs ? this.kDpr(obs, t) : t.dpr;
  const dur = DUR_WEIGHT[b.duration] || 1;
  let v = 0;
  const c = b.condition;
  if (hostile) {
    // the target's own offence it loses, and how much easier it becomes to hit
    if (['Incapacitated', 'Paralyzed', 'Stunned', 'Unconscious', 'Petrified'].includes(c)) v += tDpr * 2 + 8;
    else if (c === 'Restrained') v += tDpr * 0.4 + 4;
    else if (c === 'Blinded') v += tDpr * 0.4 + 3;
    else if (['Frightened', 'Poisoned', 'Attacks with Disadvantage', 'Attacks and saves with Disadvantage'].includes(c)) v += tDpr * 0.3 + 1;
    else if (c === 'Is attacked with Advantage' || c === 'Attacks and is attacked with Advantage') v += 3;
    if (b.toHit !== undefined) v += Math.max(0, -avgDice(b.toHit)) * 0.05 * tDpr * 2;
    if (b.ac !== undefined) v += Math.max(0, -avgDice(b.ac)) * 1.5;
    if (typeof b.damageTakenMultiplier === 'number') v += Math.max(0, b.damageTakenMultiplier - 1) * 12;
    if (typeof b.damageMultiplier === 'number') v += Math.max(0, 1 - b.damageMultiplier) * tDpr * 1.5;
    if (b.damage !== undefined) v += Math.max(0, avgDice(b.damage));
    // no point spending it on something about to drop
    v *= obs ? Math.min(1, this.kHp(obs, t) / Math.max(8, this.kMax(obs, t) * 0.25)) : Math.min(1, t.hp / Math.max(8, t.maxHp * 0.25));
  } else {
    const incoming = this.enemiesOf(t).filter(e => e.onBoard && this.alive(e) && this.dist(e, t) <= Math.max(5, this.meleeReach(e)) + 5).reduce((sum, e) => sum + (obs ? this.kDpr(obs, e) : e.dpr), 0);
    if (b.toHit !== undefined) v += Math.max(0, avgDice(b.toHit)) * 0.05 * tDpr * 2;
    if (b.damage !== undefined) v += Math.max(0, avgDice(b.damage)) * 0.65 * Math.max(1, tDpr / 8);
    if (typeof b.damageMultiplier === 'number') v += Math.max(0, b.damageMultiplier - 1) * tDpr;
    if (c === 'Attacks with Advantage') v += tDpr * 0.25;
    if (b.ac !== undefined) v += Math.max(0, avgDice(b.ac)) * 0.05 * (incoming + 2) * 1.5;
    if (typeof b.damageTakenMultiplier === 'number') v += Math.max(0, 1 - b.damageTakenMultiplier) * (incoming + 2);
    if (b.damageReduction !== undefined) v += Math.max(0, avgDice(b.damageReduction)) * 0.5;
    if (c === 'Is attacked with Disadvantage' || c === 'Invisible') v += (incoming + 2) * 0.3;
    if (!v) v = 2;
  }
  return v * dur;
};
/* would this buff/debuff be wasted on `t` because the effect is already there? */
Sim.prototype.alreadyHas = function (a, t) {
  if (a.type !== 'buff' && a.type !== 'debuff') return false;
  // all it does is take away reactions, and this one has already spent its reaction
  if (a.type === 'debuff' && a.ext && a.ext.onHit && a.ext.onHit.noReactions && !(a.buff && a.buff.condition) && !t.reaction) return true;
  const d = a.buff && a.buff.duration;
  if (d !== 'entire encounter' && d !== 'repeat the save each round') return false;
  return t.buffs.some(b => b.id === a.id);
};
/* heals marked "default" only make sense when someone actually needs them */
Sim.prototype.healNeeded = function (u, a, t) {
  if (a.type !== 'heal') return true;
  if (a.ext && a.ext.aid) return !t.aided;
  if (a.tempHP && a.target === 'self') return !(t.temp > 0);
  if (t.hp <= 0) return true;
  if (a.condition !== 'default') return true;
  if (a.tempHP) return !t.temp;
  return t.hp < t.maxHp * 0.5;
};
/* party pacing: hold long-rest resources when the fight is in hand and more fights are coming */
Sim.prototype.fightInHand = function (u) {
  if (u.team !== 'party' || !this.leftFor(u)) return false;
  const mine = this.alliesOf(u).filter(o => this.alive(o) && o.onBoard), theirs = this.enemiesOf(u).filter(e => this.alive(e) && e.onBoard);
  const myDpr = mine.reduce((t, o) => t + o.dpr, 0) * 0.6, theirDpr = theirs.reduce((t, e) => t + this.kDpr(u, e), 0) * 0.6;
  const roundsToWin = theirs.reduce((t, e) => t + this.kHp(u, e), 0) / Math.max(1, myDpr);
  const roundsToLose = mine.reduce((t, o) => t + o.hp, 0) / Math.max(1, theirDpr);
  return roundsToLose >= roundsToWin * 3 && mine.every(o => o.hp > o.maxHp * 0.35);
};
Sim.prototype.holdsResource = function (u, a) {
  if (u.ai !== 'tactical' || !(a.type === 'atk' || a.type === 'debuff')) return false;
  const k = freqKind(a.freq);
  if (k === 'at will' || k === 'recharge' || k === '1/fight') return false;
  if (u._noHold) return false;                                   // holding back would mean wasting the turn
  if (k === 'sr' && this.restBeforeNext) return false;           // it comes back before the next fight anyway
  return this.fightInHand(u);
};

Sim.prototype.hasMelee = function (u) {
  return u.actions.some(a => a.type === 'atk' && !a.useSaves && a.actionSlot === 0 && (a._range || 5) <= 10 && !(a.ext && a.ext.swallow));
};
Sim.prototype.canBonusDisengage = function (u) {
  if (u.tpl.ext && u.tpl.ext.bonusDisengage === true) return true;
  if (u.tpl.ext && u.tpl.ext.bonusDisengage === false) return false;   // explicitly switched off
  return u.actions.some(a => a.actionSlot === 1 && /cunning action|nimble escape|disengage/i.test(a.name || ''));
};

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
  // concentration check: Con save, DC 10 or half the damage
  if (tgt.concentrating && tgt.hp > 0 && !tgt.dead && dmg > 0) {
    const dc = Math.max(10, Math.floor(dmg / 2));
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

