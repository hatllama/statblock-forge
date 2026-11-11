/* TACTICAL ENGINE, part 4: knowledge (file list and how the parts share names: js/engine/base.js).
   What each side knows (the k* accessors, learning, the threat estimate), then the estimates both AIs use
   (hitChance, expected, targetValue, effectValue, fightInHand…). */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { avgDice, ADV_TARGET, ADV_SELF, DIS_TARGET, DIS_SELF, damageMultFor, freqKind, Sim, areaSpec, AI_BASE } = ENG;

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

Object.assign(ENG, { otherTeam, threatAt, DUR_WEIGHT });
})(typeof window !== 'undefined' ? window : globalThis);
