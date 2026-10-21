# AI v2 — design (steps 1–2 of 4: non-casters, full casters)

The old tactical AI is a priority list (`choose`) wrapped in a square search with special cases
(`tacticalTurnInner`) and per-action vetoes. v2 replaces the *decision* for one creature's turn with three
separate layers. Rules, dice and turn mechanics are untouched: v2 decides, and the existing `turn` code carries the
decision out. Code: the "AI v2" block in `js/engine/tactical-engine.js` (`AI_PROFILES` … `v2Act`).

## Where v1 and v2 meet

- Turned on per run: `opts.ai = 'v2'` (both sides) or `{ party: 'v2', foes: 'v1' }`, beside `partyAI`, `know`,
  `morale`. Default (no `ai`) is the old AI, and with the flag off the engine plays exactly as before.
- Switch point: per creature at the start of each fight (`v2Setup` from `runEncounter`), so one fight mixes them.
  A creature uses v2 when its side has the flag, it has **no spellbook**, and it either plays `tactical` (the party
  by default, and monsters the parser marks tactical: Int ≥ 10) or names a profile in `ext.aiProfile`.
  Everything else — casters, `regular`/`beast` monsters without a profile — keeps the old AI.
- Delegated to v1 for the whole creature: bonus-action teleports (`ext.teleport`), zones/fog (`ext.zone`),
  swallowing, healing pools (`ext.pool`, Lay on Hands), heals or buffs aimed at allies. Paladins and rangers have
  spellbooks (Divine Smite and Hunter's Mark are spells), so they stay on v1.
- In `turn()` v2 takes these decisions: the pre-move bonus action (`v2Bonus 'pre'`: Rage…), move + action
  (`v2Turn`, same result shape as `tacticalTurnInner`: act / bonusDis / actionDis / dodge / dash / hide), Reckless
  Attack (`v2Reckless`), Steady Aim, the post-move bonus action (`v2Bonus 'post'`), re-aiming after the move
  (`v2Act`/`v2Aim`), Action Surge (`v2Surge`), and limited damage-cutting reactions (`v2ReactOk`, called from
  `damage()`). The replay's `intent` lines come from `v2Words` (posture + choice).

## Layer 1 — posture (`v2Posture`, a small decision tree)

First match wins; thresholds are `P.posture.*`. `hp` = own HP fraction; "near" = foes it can reach this turn.

| posture   | when | effect |
|-----------|------|--------|
| `retreat` | `hp ≤ retreatHp`, danger here ≥ `retreatDanger` × HP, **and** an ally can heal it or it can kite (ranged attack, faster than every melee foe) | risk × `retreatSafety`; offense × `retreatOffense` unless kiting |
| `recover` | `hp ≤ recoverHp` and a self-heal is usable (Second Wind) | self-heals get `w.recover` |
| `protect` | (melee only) a near foe stands next to a back-liner: caster, no melee, or under `protectAllyHp` | that foe +`w.pick` × (1 + `w.protect` × its DPR / 5) |
| `focus`   | a near foe is a caster or healer (`kCaster`, `kHeals`) — highest DPR per HP | +`w.pick` |
| `finish`  | a near foe should drop this turn (expected ≥ `finishAt` × `kHp`) — highest DPR | +`w.pick` × (1 + `finishBoost`) |
| `focus`   | a near foe is soft (`kMax` ≤ `squishyHp` × the foes' average) | +`w.pick` |
| `advance` / `engage` | nothing near / otherwise | plain scoring |

Without a healer, falling back only takes damage off the board, so a hurt martial with no one to patch it up fights on.

## Layer 2 — utility scoring (`v2Value` per action × target, `v2TurnInner` per square)

One score per (mode, action, target, square), all other-side facts through `k*` accessors (`kHp`, `kMax`, `kDpr`,
`kAc` via `hitChance`, `kSave`, `kMult` via `expected`, `kHeals`, `kAreas`, `kReach`, `kCaster`, `leftFor`):

- **damage** `min(expected, kHp + overkill) × (1 + kDpr/dprScale)`; **spill** for Extra Attack past a kill.
- **kill** chance it drops (smooth step on expected vs `kHp`) × `(kDpr × killRounds + 5)`.
- **control** riders and debuffs: chance to land × `effectValue` × (1 − kill chance) — Stunning Strike, Sap, a push
  that takes a foe off an ally. Concentration breaking (`concValue`), as v1.
- **focus** per ally already on it, how hurt it looks, healer, caster; **guard** (front-liners) per back-liner it threatens.
- **posture** pick bonus (above). Leaves alone foes our side has talked or laughed out of the fight, as v1.
- **bonus** the best bonus attack reachable from the square (Flurry, Martial Arts, a slot-1 Action Surge), or
  **Steady Aim**'s advantage when standing still, whichever is worth more.
- **risk** expected damage at the square next round (`v2Danger`: v1's threat model) × `risk`/`riskRanged` × hurt
  factor, **capped at its HP × downCap** (past that, more damage only means going down); **oa** opportunity attacks
  along the whole path; **spacing** bunching against known area attacks; **move** per step.
- **progress** for non-attacking modes: feet gained toward a target ÷ speed × its best hit × `progress`. Dodge keeps
  `1 − dodge` of the threat. So it Dashes in when the archers hit it anyway, and walks + Dodges when the last stretch
  is into a brute's reach. Dash is offered when nothing is in reach this turn.
- **Reckless Attack** (`v2Reckless`, per turn, a 1-round buff): advantage gain on this attack vs the extra hits it
  takes until its next turn, × `recklessDrop` when those could drop it. `reckless: 'always' | 'never'` overrides.

Areas (breath weapons) use `areaCatch` like v1, scored per square with `friendPenalty`.

## Layer 3 — resource pacing (`v2Pace`)

For a limited use (per-rest uses, `ext.resource` pools such as Focus Points, 1/day): fights still to come `F`
(`leftFor`; 0 for monsters; for short-rest pools at most the fights before the next short rest). A use costs
`base = costPerUse × own DPR × F/(F+1)` and, once this fight has used its share (`left at start / (F+1)`), gives up
`overTax` of its value — so it has to be clearly better than the free option. Fight in hand (`fightInHand`):
`base × easyFight` and at least `easyTax`; losing (`losing`): both × `losing`. Last fight of the day: `lastFight`
(near free). Limited reactions (`v2ReactOk`): only on a hit that uses `reactFull` of the reduction or would drop
it (× `reactDrop`), and worth the pacing cost. At-will and recharge abilities cost nothing.

## Settings (`AI_PROFILES`, `TacEngine.aiProfile(spec)`)

Plain, serializable: `{ posture: {…}, w: {…}, pacing: {…}, finishDowned, reckless }` (`AI_BASE` in the engine
lists every knob with a comment). Presets: `balanced` (default), `aggressive`, `cautious`, `protector`, `assassin`,
`berserker`, `skirmisher` — each is `balanced` plus a few overrides. A creature picks one with `ext.aiProfile`: a
preset name, or `{ base: 'name', w: { … }, … }` merged over it. Like `ext.ai` it lives under `ext`, which plain
exports ignore; the day format is unchanged. No v2 number lives outside this object.

## Martial features

Scored by v2: Rage (pre-move: rage damage × hits × expected rounds + halved physical damage), Reckless Attack (per
turn), Sneak Attack (in `expected`, ally-adjacent targets, Steady Aim's advantage), Cunning Action (bonus Disengage
and Hide-after-attack modes, as v1's), Action Surge (slot-1 "Action Surge" attacks from sheets/builds and
`ext.extraAction` surges), Stunning Strike, Flurry of Blows, Martial Arts, Focus Points and any `ext.resource` pool,
Patient Defense, Second Wind, Stone's Endurance-style limited reactions.
Kept on the old rule: at-will damage-cutting reactions (Uncanny Dodge, Deflect Attacks: first hit, as before),
Shield/Silvery-Barbs-style reactions and Lucky (decided inside `attackRoll`), Divine Smite (paladins are casters).

## Casters (step 2)

### Who is a caster, and who stays on v1

`casterKind(tpl)` (engine, plain function) classifies a template once; `v2Eligible` reads it.

| kind | who | AI with the flag on |
|------|-----|---------------------|
| `none` | no spellbook (martials; monsters whose spells are plain X/day actions, like SRD 5.2 Mages and Priests) | v2 |
| `full` | a spellbook and `class.type` wizard, sorcerer, warlock, cleric, druid or bard; any **monster** with a spellbook (2014-style "1st level (4 slots)" statblocks); a PC with a spellbook and no class | v2 (caster terms on) |
| `half` | a spellbook and paladin, ranger or artificer | v1 (step 3) |
| `third` | a spellbook and any other class (Eldritch Knight, Arcane Trickster, a multiclass whose main class is a martial) | v1 (step 3) |

`ext.casterKind` overrides the guess (`'full' | 'half' | 'third' | 'none'`). Multiclass sheets use the main class the
sheet reader picked. `kCaster` is unchanged: it is what the *other* side knows, not who v2 drives.

Still delegated to v1, for the whole creature: swallowing (`ext.swallow`) and dice pools (`ext.pool`, Lay on Hands).
Everything step 1 kept on v1 for want of scoring (heals and buffs aimed at allies, bonus-action teleports, zones and
fog) is now scored by v2, for every creature v2 drives. Reactions (Shield, Hellish Rebuke, Cutting Words,
Counterspell-style cancels) keep v1's rules inside `attackRoll`/`cancelled`, as in step 1.

### One score, more kinds of option

The caster path is the same `v2TurnInner` square × option search; casters only add options and terms.

- **Options.** Every usable action-slot spell × every castable level: its lowest free slot, plus up to two higher
  slots when it has `upcast`/`upcastTargets`. Upcasting is a separate option, so it is chosen only when the extra dice
  or targets beat the higher slot's cost. The chosen level reaches `spend` through `u.castAt` (unset = lowest free
  slot, so v1 is unaffected). Cantrips are options with no slot cost.
- **Damage** (single target or area): as step 1, `min(expected, kHp + overkill)` × threat, plus the kill term.
  `expected` already applies the save (`kSave`, half on success), resistances (`kMult`) and the hit chance (`kAc`).
- **Area spells** are the sum over every creature caught: the target gets its full value, each other creature its
  **bare** value (damage capped by `kHp`, kill chance; no per-target focus or guard bonuses), so a nearly dead goblin
  adds what it has left, not a full goblin. Friendly fire is subtracted with `friendPenalty` (expected damage on the
  ally after its own saves and resistances, a big extra cost when it would drop, more for a downed ally) × `w.ffValue`
  × how much that ally matters (its DPR). Aim comes from `areaCatch`/`aimScore` per square, so moving to a square that
  catches more foes or fewer friends is part of the same search. No "area on one target" veto: one target is simply
  one term, and the slot cost usually makes it lose.
- **Control** (Hold Person, Hypnotic Pattern, Entangle, Faerie Fire): per-round value of the condition (`effectValue`
  for one round × `w.ctlRound`) × the chance the save fails (`kSave`) × the rounds it should last: repeat-save effects
  `(1 − (1−s)^R) / s`, whole-fight effects `R` (× `w.lull` when damage ends it), capped by how long the target is
  likely to stay up. `R` is the fight's expected remaining length. A disabling condition on a creature with Legendary
  Resistance left (`kLegRes`, new accessor) is worth only `w.legRes` of that: the save gets bought off. Area control
  sums over everyone caught, single-target control does not; the target values decide which wins.
- **Healing** an ally: missing hit points restored × `w.heal` (× `w.healLow` under half), plus `w.healDanger` × the
  damage heading its way next round that would drop it. A **downed** ally: `w.revive` + its DPR × the rounds left ×
  `w.reviveRounds`, more after failed death saves. Full-HP allies are never targets. Multi-target heals sum their
  best targets in range.
- **Buffs** on allies (Bless, Shield of Faith, Aid): the per-round `effectValue` for that ally × the rounds it lasts,
  × `w.buff`, summed over targets; self buffs (Hex, Armor of Agathys) use step 1's `v2SelfValue`. Spells that conjure
  a follow-up attack (`ext.grantsBuff` + an action with `ext.requiresBuff`: Spiritual Weapon, Starry Form) add the
  follow-up's value × the rounds it should keep striking.
- **Fog and zones**: Fog Cloud keeps v1's valuation (the damage it stops ranged foes from dealing, minus our shooters'
  lost targets); difficult-ground zones add `w.zone`.

### Concentration

- `v2Holding(u)`: what u's running concentration is worth from now on: the per-round value of the effects it holds on
  foes and allies × the rounds they still have, plus the follow-up attack it keeps up, plus fog/zone value.
- A new concentration spell pays `w.concSwap × v2Holding(u)`: it only replaces the running one when it is worth more.
- Protecting it: at each square, `holding × P(fail a Con save)` for the hits expected there is added to the risk
  (`w.concRisk`), so a caster holding a strong spell stays further back, behind cover or out of reach.
- Engine fact, not changed here: Spirit Guardians, Moonbeam and Call Lightning resolve as one burst per cast (there is
  no per-round damage rule). v2 values them as the bursts they are; since they hold nothing afterwards, they never
  block another concentration spell. "Persistent zone vs burst" therefore only exists for held effects (control,
  buffs, fog, conjured weapons), and is handled by the holding/rounds terms above.

### Slot pacing (layer 3, extended)

Slots are one pool counted in slot levels. Its budget is the levels left at the start of the fight, plus Arcane
Recovery's levels while a short rest is still ahead and it hasn't been used. A cast at level L costs
`base = pacing.slot × L × F/(F+1)` points (F = fights still to come; for short-rest slots, warlocks, only the fights
before the next short rest), and once this fight has spent its share (`budget / (F+1)`) also `overTax` of its value.
Easy fight, losing and last fight adjust both exactly as in step 1. So a high slot is cheap against a crowd (its value
grows with what it catches, the cost doesn't) and expensive on one target: a swarm fight empties the area spells, a
boss fight keeps them unless they beat a cantrip there too. Monsters have no day ahead (F = 0) and spend freely.
"Holds its slots" is logged when a slot option was the best before pacing and a free option won after.

### Positioning

Casters are back-liners for risk (`riskRanged` × `w.casterRisk`) even when they carry a dagger; a spell attack in melee
pays `meleeShoot` like any ranged attack. A caster with heals left adds `w.healReach` per hurt ally a square leaves out
of its heal range. **Bonus-action teleports** (Misty Step, `ext.teleport`) are a mode (`jump`): from where it stands to
any free square in range with line of sight, no opportunity attacks, then the action from there (only non-slot options
when the teleport took this turn's slot). It is offered when a foe threatens the creature where it stands.

### Bonus actions

`v2Bonus` scores bonus-action spells too (Healing Word, Spiritual Weapon, Shield of Faith, Hex, Mass Healing Word) and
heals and buffs on allies. The square search adds the best bonus option a square allows and respects the
one-slot-per-turn rule: an action that takes a slot only pairs with non-slot bonus options, so "Healing Word on the
downed Fighter + a cantrip" competes with "Fireball" on the same scale.

### Caster presets

`controller` (control and concentration up), `artillery` (area damage up, less friendly-fire tolerance, stays further
back), `support` (heals, revives and buffs up, healReach up). The step-1 presets set no caster weights, so martials play
exactly as before. Caster defaults live in `AI_BASE.w` (`ctlRound`, `lull`, `legRes`, `heal`, `healLow`, `healDanger`,
`revive`, `reviveRounds`, `buff`, `concSwap`, `concRisk`, `casterRisk`, `healReach`, `ffValue`, `zone`) and
`AI_BASE.pacing.slot`.

### Intent lines

"casts Fireball to catch 4 of them", "holds its slots for a fight still to come", "gets the Fighter back up with
Healing Word", "tries to Hold the Ogre, the biggest threat", "keeps concentrating on Hypnotic Pattern", "teleports out
of reach with Misty Step".

## Existing user-facing AI options → v2 knobs

| today | where | v2 knob |
|-------|-------|---------|
| "The party plays" tactical / regular | War Table `partyAI` | v2 replaces `tactical` for non-casters; `regular` stays v1 (later: a `byTheBook` profile) |
| "Fights like" tactical / regular / beast | Forge + War Table `ext.ai` | `ext.aiProfile`; beast ≈ `berserker` with nearest-target picking (not yet a knob) |
| Knowledge: open / blind / learn | `know.party`, `know.foes` | unchanged: v2 reads only the `k*` accessors |
| Monster morale | `morale` | unchanged (a rule, `moraleBreaks`); later `posture.fleeHp` |
| When grappled: smart / always / never | `escapePolicy` | unchanged (v1 turn code) |
| Downed PCs as targets (beast 5% maul, regular after 2 revivals, tactical from the 2nd down) | `mayHitDowned` | `finishDowned: 'never' / 'second-down' / 'always'` |
| Party saves big resources when the fight is in hand | `holdsResource` / `fightInHand` | `pacing.easyFight`, `pacing.easyTax`, `pacing.costPerUse` |
| Slot cost by level and day length | `slotCost` | `pacing.slot` (+ step 1's share and tax) |
| Dash only when it saves a turn | `dashWorthIt` | `w.progress` vs `w.risk` |
| Back line keeps away, hurt creatures play safe (`safetyW` 0.45 / 0.9, ×1.6 hurt) | `tacticalTurnInner` | `w.risk`, `w.riskRanged`, `w.hurt` |
| Only turtle under 40% HP (`canDodge`) | `tacticalTurnInner` | `posture.retreatHp` + `w.dodge` |
| Shooting in melee ×0.6, focus fire 1.5/ally, healer +4, guard +4, finish 12 + DPR/2 | `targetValue` | `w.meleeShoot`, `w.focus`, `w.healer`, `w.guard`, `w.kill` |
| Reaction thresholds (Shield 30% / 60%, Lucky 30%, Silvery Barbs 25%) | `attackRoll` | v1 for now; `react.*` later |
| Teleport away when hurt (regular, < 40%) | `turn` | v2: the `jump` mode, scored like any other |
| TPK kills, surprise rules, climb DC | sim options | rules, not AI |

## Not in this step

Half/third casters and Divine Smite (step 3), the profile editor UI and a War Table switch (later), lookahead of any kind (never: odds runs
play thousands of fights in the browser). Harness: `node tests/ai-compare.js [runs] [filter]`.
