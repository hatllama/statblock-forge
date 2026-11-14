/* TACTICAL ENGINE, part 3: the AI v2 settings (file list and how the parts share names: js/engine/base.js).
   Plain data: AI_BASE (every weight and threshold, with the generated threat table), the presets (AI_PROFILES),
   the monster tiers (AI_TIERS, tierOf, tierProfile). Design in docs/ai-v2.md. The code that reads it is in
   ai-v2.js, ai-boss.js and ai-v2-turn.js (through each unit's profile, u.v2P); knowledge.js reads the threat table. */
(function (root) {
'use strict';
const ENG = root.TacEngine._;

/* ===== AI v2 (docs/ai-v2.md) =====
   Turned on with opts.ai = 'v2' (martials and every caster kind). Three layers: a posture (what the creature is trying to do this round),
   one utility score per (mode, action, target, square), and resource pacing. It decides; the turn code in `turn`
   carries the decision out with the same rules as before. Every weight and threshold lives in AI_PROFILES. */
const AI_BASE = {
  posture: { retreatHp: 0.3, retreatDanger: 0.5, recoverHp: 0.5, protectAllyHp: 0.35, squishyHp: 0.6, finishAt: 0.9 },
  w: {
    damage: 1, dprScale: 20, overkill: 4, spill: 0.4,           // expected damage (capped near what it has left), × how dangerous the target is
    dprSeenGap: 0,                                               // on kDprOpen's reading, v2Value weighs by the sheet's DPR + this share of what the better reading adds (kDprW); 0.3 cost Zaki's boss day 1 more point
    kill: 1, killRounds: 1.5,                                    // dropping it: its damage for this many rounds, + 5
    control: 1,                                                  // all control: riders (Stunning Strike, Sap, push) and debuff spells (Hold Monster…)
    focus: 1.5, wounded: 4, healer: 4, caster: 4, conc: 1,       // focus fire: per ally on it, how hurt it looks, healers, casters, concentration
    pick: 5, protect: 0.6, finishBoost: 0,                       // the posture's own target
    guard: 4,                                                    // a foe in the face of our casters / back line / badly hurt
    bonus: 0.8, aim: 1,                                          // the bonus attack it could add from a square; Steady Aim
    risk: 0.45, riskRanged: 0.9, hurt: 1.6, downCap: 1.25,       // damage it would take there (melee / back line), more when hurt, capped at its HP × downCap
    retreatSafety: 2.5, retreatOffense: 0.5,
    oa: 1, move: 0.15, dodge: 0.45, meleeShoot: 0.6, hide: 0.3,
    // an enemy's area attack (breath, cone, Fireball: docs/ai-v2.md): HP it costs our side × safety × areaRisk; the share of its damage one creature caught takes; the chance a ready one is used
    areaRisk: 1, areaSave: 0.75, areaUse: 1,
    progress: 0.5,                                               // a full move closer is worth this share of its best hit
    recover: 6, recklessRisk: 0.8, recklessDrop: 3,              // self-heal when hurt; Reckless: extra hits taken, × recklessDrop if they could drop it
    // casters (step 2) and anything that heals, buffs or controls
    area: 1, ffValue: 1,                                         // the others an area catches (bare value each); friendly fire, × the ally's DPR weight
    ctlRound: 0.5, lull: 0.6, legRes: 0.4, concKeep: 0.75, shakeOff: 0.55, expose: 1, critDmg: 1.6,
    // control: one round's worth × rounds; damage ends it; a save bought off (legRes / the uses it has left: docs/ai-v2.md); holding it that long; a hold that damage can save it out of (Laughter);
    // our side's extra damage on a foe easier to hit (advantage, crits up close: v2Expose); a crit's damage over a plain hit
    heal: 1, healLow: 1.4, healDanger: 0.8,                     // HP back (more under half), a heal that keeps it standing
    // a downed ally back up (v2BackUp, docs/ai-v2.md): its value per round; the turn it may get even if it drops again; foes beside it turning on it; the blow it soaks for someone else; what a healer's round is worth;
    // a life in points, more per fight still to come; the chance a round an adjacent foe finishes it, first time down and after a second drop
    backRound: 4, backFirst: 0.75, backFocus: 1, backSoak: 0.5, backHealer: 10, backLife: 40, backDay: 0.25, backFinish: 0.1, backFinish2: 0.4,
    // a downed ally about to die (docs/ai-v2.md): the chance it dies before this healer's next turn × what a dead PC loses (its rounds here and,
    // for each fight left today, deathFightRounds more × deathDay; a life no ordinary heal brings back), × deathNow
    deathNow: 8, deathLife: 200, deathDay: 1, deathFightRounds: 4,
    buff: 1, buffRounds: 2, zone: 2,                             // buffs on allies (per round × rounds, counted this many rounds ahead at most); difficult ground
    concSwap: 1, concRisk: 1,                                    // dropping what it holds for a new one; losing it where it stands
    zoneStay: 0.55, zoneFollow: 0.3,                             // a damage zone (Moonbeam…): how many of the later rounds a foe in it stays and burns; more when it follows the caster
    // going down on its own turn (docs/ai-v2.md): how far expected damage understates a hit; the share of its HP a hit must reach before it can drop it; its rounds lost, at most this many, × a weight; a life in points
    dropEdge: 1.5, dropFrom: 0.25, dropRounds: 2, dropRound: 1, dropLife: 60,
    dot: 1, dotLag: 0.5, dotMin: 0.5, dotMax: 3.5, dotHold: 1,   // a burn (Caustic Brew: ext.dot): its value; the rounds it loses because the first tick comes on the foe's turn; the fewest and most ticks counted; what a running one is worth to keep
    casterRisk: 1.2, healReach: 1.5,                             // casters keep back; a healer stays in reach of the hurt
    // Divine Smite (docs/ai-v2.md "Hybrids"): its value on a hit (damage + the kill it makes now), × smite; with swings still to come it waits
    // when a later hit's expected smite × smiteWait is worth more
    smite: 1, smiteWait: 1,
    // open mode: 0 reads an enemy's DPR off its sheet (its first attack); > 0 reads its best action it can still use, blended with what it has dealt at this weight (kDprOpen).
    // dprSeenPC for the party, dprSeen for monsters (the boss tier sets 1; ordinary tiers stay 0: the true reading made undead and the 3-fight day dive the casters and lose, docs/ai-v2.md)
    dprSeen: 0, dprSeenPC: 1,
    dprSeenDealt: 0,                                             // 1: blend that reading with what the foe has dealt this fight (the boss tier); 0: its best usable action alone (luck in a martial's rolls cost the party)
  },
  // Legendary Resistance (docs/ai-v2.md): burn it with cheap control, or race the boss's HP. bias: burn when racing costs more than bias × (burning + margin)
  burn: { modes: ['open'], bias: 1, margin: 4, minFail: 0.25, hold: 12, slotW: 0.5, value: 1, share: 0.6, eff: 0.75, cap: 6, probe: 3, minFollow: 0.2, probeBias: 1, probeP: 0.35, probeMax: 2, probeSlack: 0 },
  pacing: { costPerUse: 0.1, overTax: 0.6, easyFight: 1.5, easyTax: 0.5, losing: 0.3, lastFight: 0.05, srFights: 1, reactDrop: 3, reactFull: 0.75,
            slot: 8, slotUp: 0.35, slotEasyTax: 0.7,             // a spell slot: points per slot level, each level above 1st costing slotUp more, × F/(F+1); its tax when the fight is in hand
            reviveLife: 60, reviveDay: 6, reviveDoom: 2,         // spending the slot kept for a dead ally's Revivify: a life, + its DPR × this many rounds per fight still to come; a fight counts as lost when the side falls in under 1/reviveDoom of the time it needs to win
            hpLevel: 8 },                                        // a hit-point pool (Lay on Hands): this many points cost what one slot level does
  // the threat estimate (docs/ai-v2.md): learn on v2, the party's side. prior + each signal's weight (× n / (n + half)), then the table
  threat: {
    useAc: 1, useSave: 1,                                        // AC, save bonus read from the score too (saves: each ability's own column, see the docs)
    saveShare: 0.5,                                              // how far an unseen save's prior moves from +2 toward its column at the score
    crowd: [[2, 1.5], [3, 2], [7, 2.5], [11, 3], [15, 4]],       // the same budget buys weaker creatures in a crowd: from this many enemies, xp ÷ this (DMG encounter multipliers)
    crPerLevel: 1.4, partySize: 4, level: 5,                     // a typical lone creature for a level; the party that goes with it; a creature with no class level
    prior: 2,
    atk: 3, atkHalf: 4, atkMin: -2, atkMax: 18,                  // attack bonus from plain rolls
    dc: 3,                                                       // the best save DC it has forced: announced, so at full weight at once
    dmg: 2, dmgHalf: 2, hitPrior: 0.65, hitHalf: 4, hitFloor: 0.3,   // damage per active turn ÷ its hit rate
    legRes: 6,                                                   // Legendary Resistance seen: only the strongest have it, the table's legCr at this weight
    floor: 0.25,                                                 // attacks, actions and conditions shown: this share of the way up to what they suggest
    /* threat-table:start (generated by tools/build-threat.js from data/srd-monsters.js) */
    table: [
      { cr: 0.125, hp: 9, ac: 13, dpr: 4.5, atk: 3, dc: 0, save: 0.5, str: 0, dex: 1, con: 0, int: 0, wis: 0, cha: 0, attacks: 1, shown: 1, xp: 25 },   // 5 monsters
      { cr: 0.25, hp: 12, ac: 13, dpr: 5.5, atk: 4, dc: 5, save: 1, str: 0.5, dex: 2, con: 1.5, int: 0, wis: 0, cha: 0, attacks: 1, shown: 1.5, xp: 50 },   // 4 monsters
      { cr: 1, hp: 26, ac: 14, dpr: 9.5, atk: 4, dc: 12, save: 1, str: 2, dex: 2, con: 1.5, int: 0, wis: 0, cha: 0, attacks: 1, shown: 2, xp: 200 },   // 7 monsters
      { cr: 2, hp: 48, ac: 14, dpr: 15.3, atk: 5, dc: 12.5, save: 1, str: 3.5, dex: 2, con: 1.5, int: 0.5, wis: 2.5, cha: 1, attacks: 1.5, shown: 2.5, xp: 450 },   // 4 monsters
      { cr: 3, hp: 62, ac: 14.5, dpr: 22.3, atk: 5, dc: 12.5, save: 1.5, str: 3.5, dex: 2, con: 2.5, int: 0.5, wis: 2.5, cha: 1, attacks: 2, shown: 2.5, xp: 700 },   // 10 monsters
      { cr: 5, hp: 92, ac: 15, dpr: 30.5, atk: 7, dc: 14, save: 2.5, str: 3.5, dex: 4, con: 3.5, int: 0.5, wis: 2.5, cha: 1, attacks: 2, shown: 2.5, xp: 1800 },   // 6 monsters
      { cr: 6, hp: 120.5, ac: 15, dpr: 44, atk: 7, dc: 14, save: 2.5, str: 3.5, dex: 4, con: 3.5, int: 0.5, wis: 3, cha: 1, attacks: 3, shown: 2.5, xp: 2300 },   // 4 monsters
      { cr: 8, hp: 178, ac: 18, dpr: 52.5, atk: 8, dc: 17, save: 2.5, str: 5, dex: 4, con: 5, int: 2, wis: 3, cha: 1, attacks: 3, shown: 2.5, xp: 3900 },   // 5 monsters
      { cr: 19, hp: 285.5, ac: 19.5, dpr: 74.3, atk: 13, dc: 20.5, save: 8, str: 5, dex: 8, con: 8.5, int: 7.5, wis: 8, cha: 4.5, attacks: 3, shown: 8, xp: 25500 },   // 2 monsters
    ],
    cond: {Restrained: 4, Poisoned: 6, Prone: 5},
    legCr: 19,
    /* threat-table:end */
  },
  // reactions (docs/ai-v2.md, "Reactions as a layer"): the reaction itself (what it gives up) in points; a luck point; the share of the foes still to act that count
  // against a Shield or a cut held for later; the chance a later hit lands; the damage a foe's round is split into hits; how much the best of several hits beats an average one;
  // the share of the best ally's DPR that advantage on its next attack is worth; a condition's worth when a save is rerolled; rounds a held spell is worth countering;
  // blind: rounds of the caster's damage a spell is taken to be worth; Ready: the chance a melee foe / a shooter comes into reach
  react: { base: 8, luck: 4, round: 0.6, hitP: 0.6, perFoe: 2, spread: 0.15, maxL: 2, ally: 0.2, stakes: 12, conc: 2, blindRounds: 1.2, blindLevel: 3, readyMelee: 0.8, readyRanged: 0.15 },
  // coin flips (ext.coin; docs/ai-v2.md "Pasquale Minuzzi"): tails = the share of one hit a disadvantaged attack roll loses (p(1 - p) at an even hit chance), priced in the
  // creature's best one-hit damage; weight = the expected coin value as a bonus action (Double Down) or reaction (Call It in the Air). Nothing here moves a creature with no coin.
  coin: { tails: 0.25, weight: 1 },
  // Follow Through / Tight Grouping: the share of its extra dice `expected` counts (chance two swings of the routine hit × the dice); 0 = not counted
  follow: { weight: 1 },
  // Push Your Luck (ext.pushLuck; docs/ai-v2.md "Elia Dantes"): a missed attack roll is rerolled when the chance the new die hits × the hit's damage beats
  // `cost` × the average self-damage; `floor` = hit points kept beyond the dice's maximum (it is never done at or below that maximum)
  push: { cost: 1, floor: 0 },
  morale: { fearless: false, bloodied: true, half: true, leader: true, dc: 10 },   // a creature that may lose its nerve (opts.morale on): which triggers count, and the Wisdom save DC; equal to the old rule
  // the boss tier (docs/ai-v2.md "Boss tier"); neutral here (factors 1, weights 0, pickers 'rule'), so only the boss profile changes play.
  // solo/soloOa: self-care and opportunity attacks × solo + (1 − solo) × the share of its side's DPR its allies bring; legendary/lair/legRes: 'rule' (old pickers) or 'weigh' (v2 values);
  // legKeep: a legendary point kept is worth this share of the value per point it has been seeing (legRate: how fast that estimate moves);
  // Legendary Resistance: the price of a use = the worst effect shown × lrKeep × lrSpare^(uses left − 1), at least its own turn × lrFloor; damage it avoids in
  // its HP × its DPR ÷ the party's (× lrDmg), × lrDrop of its HP when failing would drop it; a turn's worth is its DPR × (1 + lrLeg × legendary actions);
  // lrCond: a turn lost per round of the condition, lrTurns the most rounds counted; recharge: the next turn's use a recharge ability gives up now
  // (rechargeCatch: the share of foes a typical use catches); ext.aiPlan hints: planOpen/planSave a share of the option's value (through its pacing tax), planTarget points
  boss: { solo: 1, soloOa: 1, legendary: 'rule', lair: 'rule', legRes: 'rule', legKeep: 0.8, legRate: 0.3,
          lrKeep: 1, lrSpare: 0.6, lrFloor: 1.5, lrDmg: 1, lrDrop: 3, lrLeg: 0.15, lrTurns: 3, lrHorizon: 3,
          lrCond: { Incapacitated: 1, Stunned: 1.5, Paralyzed: 1.5, Unconscious: 1.5, Petrified: 1.5, Restrained: 0.4, Blinded: 0.4, 'Attacks and saves with Disadvantage': 0.35, Frightened: 0.25, other: 0.1 },
          recharge: 0, rechargeCatch: 0.5, planOpen: 0.5, planSave: 0.8, planTarget: 6 },
  finishDowned: 'second-down',     // downed PCs: 'never' | 'second-down' (like the old tactical AI) | 'always'
  reckless: 'weigh',               // Reckless Attack: 'weigh' each turn | 'always' | 'never'
};
const AI_PRESETS = {
  balanced: {},
  aggressive: { posture: { retreatHp: 0.15 }, w: { risk: 0.25, riskRanged: 0.5, hurt: 0.8, oa: 0.7 }, pacing: { costPerUse: 0.05, overTax: 0.4, easyFight: 1.2, easyTax: 0.15 } },
  cautious: { posture: { retreatHp: 0.45, retreatDanger: 0.35, recoverHp: 0.6 }, w: { risk: 0.8, riskRanged: 1.3, hurt: 2.5, oa: 1.5, recklessRisk: 1.5 }, pacing: { costPerUse: 0.2, overTax: 0.75, easyTax: 0.4 } },
  protector: { posture: { protectAllyHp: 0.6 }, w: { protect: 1.5, pick: 7, risk: 0.5 } },
  assassin: { posture: { squishyHp: 0.9 }, w: { caster: 10, healer: 8, wounded: 6, pick: 8, kill: 1.5 } },
  berserker: { posture: { retreatHp: 0, recoverHp: 0.25 }, w: { risk: 0.1, riskRanged: 0.3, hurt: 0, oa: 0.3, progress: 0.8 }, pacing: { costPerUse: 0.02, overTax: 0.2, easyFight: 1, easyTax: 0.1 }, reckless: 'always' },
  skirmisher: { w: { risk: 0.7, riskRanged: 1.2, meleeShoot: 0.5, oa: 1.5, hide: 0.5, progress: 0.35 } },
  // casters
  controller: { w: { ctlRound: 0.75, concKeep: 0.85, concSwap: 1.3, concRisk: 1.6, control: 1.25 }, burn: { bias: 1.3, probeBias: 1.4 } },
  artillery: { w: { area: 1.15, ffValue: 1.5, casterRisk: 1.5, ctlRound: 0.4, control: 0.8 }, pacing: { slot: 6 }, burn: { bias: 0.75, probeBias: 0.6 } },
  support: { w: { heal: 1.3, healLow: 1.6, healDanger: 1.2, backLife: 60, buff: 1.3, healReach: 3 } },
};
function mergeProfile(base, over) {
  const out = JSON.parse(JSON.stringify(base));
  if (!over || typeof over !== 'object') return out;
  for (const k in over) {
    if (k === 'base') continue;
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && out[k] && typeof out[k] === 'object') Object.assign(out[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}
const AI_PROFILES = {};
for (const k in AI_PRESETS) AI_PROFILES[k] = mergeProfile(AI_BASE, AI_PRESETS[k]);
/* a creature's settings: ext.aiProfile is a preset name, or { base: 'preset', ...overrides } */
function aiProfile(spec) {
  if (typeof spec === 'string') return AI_PROFILES[spec] || AI_PROFILES.balanced;
  if (spec && typeof spec === 'object') return mergeProfile(AI_PROFILES[spec.base] || AI_PROFILES.balanced, spec);
  return AI_PROFILES.balanced;
}
/* ---- monster intelligence tiers (docs/ai-v2.md "Monster intelligence tiers"): opts.ai.foes = 'tiers' ----
   A tier is a partial profile merged over AI_BASE, picked per creature: ext.aiTier, else from its Intelligence and type.
   rules: Int ceilings (mindless / animal) and floor (genius); types that are mindless at or under mindlessInt; wisRetreat: retreatHp per point of Wisdom modifier (tiers that retreat). */
const AI_TIERS = {
  tiers: ['mindless', 'animal', 'cunning', 'genius', 'boss'],
  // boss: what makes a creature a boss (legendary actions, lair actions, Legendary Resistance, a reaction that acts on a foe)
  rules: { mindlessInt: 6, mindlessTypes: ['ooze', 'plant', 'construct', 'undead'], mindlessAny: 0, animalInt: 7, geniusInt: 16, wisRetreat: 0.03,
           boss: { legendary: true, lair: true, legRes: true, react: true } },
  profiles: {
    mindless: {
      know: 'blind', morale: { fearless: true },
      posture: { retreatHp: 0, recoverHp: 0, protectAllyHp: 0 },
      w: { risk: 0, riskRanged: 0, hurt: 0, oa: 0, dodge: 0, hide: 0, retreatSafety: 0, casterRisk: 0, caster: 0, healer: 0, wounded: 0, pick: 0, guard: 0, focus: 0.5, areaRisk: 0.2, ffValue: 0.1, progress: 0.8 },
    },
    animal: {
      know: 'blind', morale: {},
      posture: { retreatHp: 0.3, protectAllyHp: 0 },
      w: { caster: 0, healer: 0, wounded: 6, pick: 2, guard: 0, focus: 1.5, oa: 0.7, dodge: 0.2, hide: 0, areaRisk: 0.4, ffValue: 0.3, casterRisk: 0.5 },
    },
    cunning: {},
    genius: {
      morale: { bloodied: false, half: false, leader: false },
      posture: { retreatHp: 0.35, retreatDanger: 0.4 },
      w: { caster: 6, healer: 6, wounded: 5, pick: 6, guard: 5, areaRisk: 1.4, ffValue: 1.3, casterRisk: 1.5, oa: 1.2 },
    },
    // genius, plus the boss block: little self-care when alone, legendary and lair actions and Legendary Resistance weighed, recharge priced
    boss: {
      morale: { bloodied: false, half: false, leader: false },
      posture: { retreatHp: 0.35, retreatDanger: 0.4 },
      w: { caster: 6, healer: 6, wounded: 5, pick: 6, guard: 5, areaRisk: 1.4, ffValue: 1.3, casterRisk: 1.5, oa: 1.2, dprSeen: 1, dprSeenGap: 1, dprSeenDealt: 1 },
      boss: { solo: 0.25, soloOa: 0.5, legendary: 'weigh', lair: 'weigh', legRes: 'weigh', recharge: 1 },
    },
  },
};
/* a reaction that acts on a foe (a cancel, a debuff, Counterspell): a boss's; Parry and other self buffs are not */
const bossReact = a => a.actionSlot === 4 && !(a.type === 'buff' && a.target === 'self');
const TIER_PROFILES = {};
for (const k of AI_TIERS.tiers) TIER_PROFILES[k] = mergeProfile(AI_BASE, AI_TIERS.profiles[k]);
/* a creature's tier: ext.aiTier, else the statblock (ext.scores from the parser; an older saved monster uses its Int save) */
function tierOf(tpl) {
  const ex = (tpl && tpl.ext) || {}, R = AI_TIERS.rules;
  if (AI_TIERS.tiers.includes(ex.aiTier)) return ex.aiTier;
  const B = R.boss, acts = (tpl && tpl.actions) || [];
  if (B && ((B.legendary && (ex.legendaryActions > 0 || acts.some(a => a.actionSlot === 2))) || (B.lair && acts.some(a => a.actionSlot === 3)) ||
            (B.legRes && ex.legendaryResistance > 0) || (B.react && acts.some(bossReact)))) return 'boss';
  const type = String((tpl && tpl.type) || '').toLowerCase();
  const int = ex.scores && typeof ex.scores.int === 'number' ? ex.scores.int : ex.saves && typeof ex.saves.int === 'number' ? 10 + 2 * ex.saves.int : (ex.ai === 'beast' ? 3 : ex.ai === 'tactical' ? 12 : 8);
  if (int <= R.mindlessAny || /\bswarm\b/i.test(String((tpl && tpl.name) || '')) || (R.mindlessTypes.includes(type) && int <= R.mindlessInt)) return 'mindless';
  if (type === 'beast' || int <= R.animalInt) return 'animal';
  return int >= R.geniusInt ? 'genius' : 'cunning';
}
/* the profile of a tiered creature: its tier, a Wisdom nudge to when it retreats, then ext.aiProfile on top */
function tierProfile(tier, spec, tpl) {
  let p = TIER_PROFILES[tier] || TIER_PROFILES.cunning;
  const wis = tpl && tpl.ext && tpl.ext.scores && typeof tpl.ext.scores.wis === 'number' ? tpl.ext.scores.wis : 10;
  if (p.posture.retreatHp > 0) { p = mergeProfile(p, null); p.posture.retreatHp = Math.min(0.8, Math.max(0, p.posture.retreatHp + Math.floor((wis - 10) / 2) * AI_TIERS.rules.wisRetreat)); }
  if (typeof spec === 'string') return AI_PRESETS[spec] ? mergeProfile(p, AI_PRESETS[spec]) : p;
  if (spec && typeof spec === 'object') return mergeProfile(mergeProfile(p, AI_PRESETS[spec.base] || null), spec);
  return p;
}

Object.assign(ENG, { AI_BASE, AI_PROFILES, aiProfile, AI_TIERS, TIER_PROFILES, tierOf, tierProfile });
})(typeof window !== 'undefined' ? window : globalThis);
