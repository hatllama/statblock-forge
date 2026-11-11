/* TACTICAL ENGINE: the parts not split out yet (file list and how the parts share names: js/engine/base.js).
   Still here, to be moved one module per commit: day.js. */
(function (root) {
'use strict';
const ENG = root.TacEngine._;
const { makeRng, parseDice, rollDice, avgDice, finalizeAction, inferRange, damageMultFor, AI_TYPES, autoAI, casterKind, recoverSlots, makeUnit, freqKind, resetFightState, Sim, areaSpec, areaCells, inArea, AI_BASE, AI_PROFILES, aiProfile, AI_TIERS, TIER_PROFILES, tierOf, tierProfile, hitP, castCopy, deathOdds } = ENG;
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

