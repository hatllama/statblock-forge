# AI v2 — design (built so far: non-casters and full casters)

Naming: "step 1", "step 2" and "step 2.x" are the finished work (they match the commit names). What is still to build
uses the phases in `docs/ai-roadmap.md` (phase 2 = hybrids, phase 3 = reactions, and so on).

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
| `half` | a spellbook and paladin, ranger or artificer | v1 (roadmap phase 2) |
| `third` | a spellbook and any other class (Eldritch Knight, Arcane Trickster, a multiclass whose main class is a martial) | v1 (roadmap phase 2) |

`ext.casterKind` overrides the guess (`'full' | 'half' | 'third' | 'none'`). Multiclass sheets use the main class the
sheet reader picked. `kCaster` is unchanged: it is what the *other* side knows, not who v2 drives.

Still delegated to v1, for the whole creature: swallowing (`ext.swallow`) and dice pools that are not heals (`ext.pool`; Lay on Hands stays on v1 because paladins are half casters).
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
  likely to stay up. `R` is the fight's expected remaining length. A condition that makes the foe easier to hit
  (Paralyzed, Stunned…) also counts our side's extra damage against it (`v2Expose`, step 2.10 below). A disabling condition on a creature with Legendary
  Resistance left (`kLegRes`, new accessor) is worth only `w.legRes` of that: the save gets bought off. Area control
  sums over everyone caught, single-target control does not; the target values decide which wins.
- **Healing** an ally: missing hit points restored × `w.heal` (× `w.healLow` under half), plus `w.healDanger` × the
  damage heading its way next round that would drop it. A **downed** ally: the "back in the fight" term `v2BackUp`
  (step 2.12, below), which replaces the flat revive bonus. Full-HP allies are never targets. Multi-target heals sum
  their best targets in range. Potions are heal options like any other: a bonus action on a creature within 5 ft.
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
- Also an engine fact: Spiritual Weapon's conjured strike isn't tied to concentration here (its buff has its own id),
  so it keeps striking after the cleric concentrates on something else; v2 counts its follow-up strikes, not a holding.

### Slot pacing (layer 3, extended)

Slots are one pool counted in slot levels. Its budget is the levels left at the start of the fight, plus Arcane
Recovery's levels while a short rest is still ahead and it hasn't been used. A cast at level L costs
`base = pacing.slot × L × (1 + pacing.slotUp × (L − 1)) × F/(F+1)` points (8, 0.35: higher slots are scarcer, so each
level costs more; F = fights still to come, and for short-rest slots — warlocks — only the fights before the next short
rest). Once this fight has spent its share (`budget / (F+1)`) it also gives up `overTax` of its value. Losing: both
× `losing`. Fight in hand: base × `easyFight` and at least `slotEasyTax` (0.7) of its value — a slot rarely beats a
cantrip in a fight that's already won. No fight ahead (the last fight, or any monster): a slot still costs its best use
later in this fight, `base × clamp(rounds left × 3 / slot levels left, lastFight, 0.5)`, so a caster with many slots
spends freely and one with a few keeps them for the target that matters. **A lost fight spends its slots** (step 2.7):
that last-fight price is also × `losing` when the side is losing. Before, only the "fights to come" path had the discount,
so a party losing the *last* fight (B2: a dragon with +14 saves, a race the party loses) died with a third of its slot
levels unspent, and kept a 3rd-level Lightning Bolt in the book to cast Magic Missile instead.

So a high slot is cheap against a crowd (its value grows with what it catches, the cost doesn't) and expensive on one
target: a swarm fight empties the area spells, a boss fight keeps them unless they beat a cantrip there too.
"Holds its spell slots" is logged when a slot option was worth more before pacing and a free option won after.
Calibration: in the harness's ogre fights a 3rd-level slot buys a Hypnotic Pattern or Fireball worth 50–75 points
against a cantrip's 5–20, which is why a slot level is priced well above step 1's per-use cost.

### Positioning

Casters are back-liners for risk (`riskRanged` × `w.casterRisk`) even when they carry a dagger; a spell attack in melee
pays `meleeShoot` like any ranged attack. A caster with heals left adds `w.healReach` per hurt ally a square leaves out
of its heal range. **Bonus-action teleports** (Misty Step, `ext.teleport`) are a mode (`jump`): from where it stands to
any free square in range with line of sight, no opportunity attacks, then the action from there (only non-slot options
when the teleport took this turn's slot). It is offered when a foe threatens the creature where it stands. It wins less often than v1's rule fired: Disengage escapes
for free, and Misty Step takes the turn's spell slot, so walking off (taking a weak opportunity attack) and casting a
levelled spell, or teleporting out of the reach of slow foes that hit hard, are what the numbers pick. Statblocks read
by the parser don't get Misty Step (it isn't in `js/spell-data.js`), so caster monsters can't use it yet.

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

### Legendary Resistance and the burn plan (step 2.6)

**The strategy.** A boss with Legendary Resistance (LR, usually 3 a day) turns a failed save into a success. A party can
spend its cheaper control effects on the save the boss is bad at, force the LR out, and land a strong follow-up (Hold
Monster, Banishment, a big Hypnotic Pattern…) that would have been wasted. It is a judgment call between *burn* and
*race its HP*. It fails when the boss's saves are high across the board, when the party has few cheap effects, when damage
ends the fight first, and when the rounds spent burning cost too much incoming damage.

**The monster side (a rule, unchanged).** `saveRoll` already decides LR as a DM would, from the incoming effect (which
is public): it spends a use only when failing is *dangerous* — a disabling or crippling condition (`DANGER_CONDS`:
incapacitated, paralysed, stunned, unconscious, petrified, restrained, blinded, frightened, disadvantage on attacks and
saves), or damage that would drop it or take 10% of its maximum (25% of what it has left). It accepts everything else
(Bane, a Vicious Mockery, a plain Fireball). Rolls use the real numbers. So an effect only burns LR if it would hurt;
cheap harmless effects burn nothing. Step 2.6 changes no engine rule: logs with the flag off are identical, with or
without LR.

**What the party knows (`kLegRes`).** Open: the real count left. Blind and learn: nothing is known until a use is
seen, and then it is the typical three less each use seen (learn: or less the highest count seen on that kind earlier
today). **No size guess** (step 2.9): until a use is seen every creature is taken to have none, a Hill Giant and an
Adult Red Dragon alike. (Steps 2.6–2.8 assumed three on any Huge or Gargantuan unknown, which priced control on it at
`w.legRes` (0.2): a Hold Monster on a Wisdom −1 dragon with no LR was worth 12 instead of 49.5, so the party took the
damage spell; many Huge creatures have none.) The first control on a boss that does have LR is therefore cast at full
value; the LR it forces is a public event (`legSeen`, kind memory `legRes`), and from then on the usual discount and
the burn/race plan apply. Blind sees the same uses on the creature in front of it, so it also counts down once a use
shows; it just never remembers across fights. The weakest save comes from `kSave` per ability: open reads it, blind
assumes +2 (average) for every ability, learn infers it from the saves seen (`learnSave`). So blind can only burn on
an average-save guess, and learn finds the weak ability by casting at it.

**Martial control** (Stunning Strike, Sap, push riders) never went through this discount: `v2Value` prices a rider as
`pLand × effectValue × (1 − pKill) × w.control` on its own path and does not read `kLegRes`, so it was and is the same in
all three modes. Only spell-style `debuff` actions go through `v2Control`.

**The plan** (`v2Burn`, once per turn per side, cached; the posture layer's fight-level decision). It looks at the
boss with LR left (the one with most HP if several) and compares two estimates, in points of damage the party takes:

- **Race.** `H / P` rounds: `kHp` over the party's damage per round `P` (each member's best `expected` attack against
  the boss, so `kAc` and `kMult` apply; a slot spell counts 0.7, everything × `burn.eff` 0.75 for rounds lost to moving
  and support), times the boss's damage per round `D`: `kDpr` × `burn.share`, × a spread for an area attack (`kAreas`),
  and in open mode blended with what it has actually dealt this fight. Costs are squashed (`sat`) toward `burn.cap` × the
  party's HP, so "everyone dies either way" does not look like a tie of two huge numbers.
- **Burn.** The burners (below) cast instead of attacking; the others keep attacking and the boss keeps hitting.
  Each burner forces out `pFail = 1 − (21 + kSave − DC)/20` uses a round, so `Rb ≈ LR / Σ pFail` rounds. Then one round for
  the follow-up (the legal effect worth the most once LR is gone, by `v2Control` without the LR discount; ties go to the
  dearer slot, since the cheap ones burn). It lands with its fail chance, and if it does the boss is out (or crippled) for
  the rounds it should last (the save-each-round formula, × `concKeep`; `BURN_COND` says how much of its damage still comes and
  how much harder we hit), after which it is a race for what is left; if not, a round was spent and it is a race. Slots are charged
  at `burn.slotW` (0.5, because a race spends slots on damage too) × the pacing price (`v2Pace`).
- It burns when `race × burn.bias > burn + slotW × slots + burn.margin`. Ties go to racing. Recomputed every turn, it flips to
  racing as soon as the numbers flip (a streak of saves made, a burner downed or concentrating on something it holds
  (`burn.hold`), the boss low) and when LR is empty there is nothing to plan and the follow-up is simply the best spell.
- In learn mode, an ability whose save has not been seen on that kind yet is given `burn.probe` (3) of doubt in the cast's
  favour, so the first cast finds out; once saves are seen `kSave` takes over. Blind never probes: average saves, three LR.

**Roles are per creature, not a party switch.** A burner is a caster with a legal disabling effect that is not the follow-up
and fails the save at least `burn.minFail` of the time, not holding a concentration worth more than `burn.hold`. Sorted by
price (cantrip, then slot level, then `pFail`), they are taken until their `Σ pFail` covers the LR left. Martials and the
caster holding the follow-up keep doing what they do. The follow-up is not cast while LR is left (it keeps the 0.2 discount).

**Immune bosses (step 2.7).** `kImmune(u, t, cond)` (open: the sheet; learn: once an "is immune to being…" was seen;
blind: never) makes `v2Control` value a condition the foe cannot take at 0, so a caster aims at damage instead of a spell
that cannot work.

**Valuation.** In race mode, a disabling effect on a creature with LR left is worth `legRes` / the uses left × its normal value (step 2.11; `legRes` 0.4; before that a flat 0.2). In burn mode, for a burner and the effect the plan picked for it, the effect is worth what the
burner gives up (the best other option it has, net of its price) plus its progress, `pFail × perLR × burn.value`, where
`perLR` is what the whole burn saves (`race × bias − burn − margin`) shared out over the LR left. It is applied as a lift in
`v2TurnInner`, so it competes with damage on equal terms and the burn spell then goes through the same pacing cost as any
spell (cheapest first falls out of the burner order).

Two valuation fixes came with it, because the follow-up has to rank right to be chosen: a control that damage can save
the foe out of (Hideous Laughter, `ext.saveOnDamage`) is worth `shakeOff` (0.55) of its value, and Paralyzed/Unconscious is
worth `critBoost` (1.3) × (hits up close crit; replaced in step 2.10 by the allies' actual extra damage, `v2Expose`). These apply to every v2 caster, with or without LR.

**Profile.** `AI_BASE.burn = { bias, margin, minFail, hold, slotW, value, share, eff, cap, probe, minFollow }`, plain data.
`controller` leans toward burning (`bias` 1.3), `artillery` toward racing (`bias` 0.75). `bias: 0` is the step 2.5 behaviour.

**Intent lines.** "Cleric wants the party to burn the Adult Red Dragon's resistances first (3 left)" / "reckons the party
should race the Adult Red Dragon's HP" (once per boss when first decided and again on a flip), and "Wizard burns the Adult Red
Dragon's resistances with Tasha's Hideous Laughter" on each burn cast.

**Not modelled** (so the plan is conservative): a martial's rider (Stunning Strike) also burns LR as it lands — it still
does, it is just not counted; Counterspell-style cancels; the boss's allies. The harness (`tests/ai-compare.js`, scenarios B1–B6) has four
arms on the same seeds, v1, v2 with `burn.bias` 0 (`v2-`), v2 (`v2+`), and v2 with the bias forced up (`v2!`, to show what burning would have cost or won).

### Learn mode: boss HP, probing, Legendary Resistance (step 2.7)

Learn is the party's default knowledge mode. It starts as ignorant as blind and reads what it sees; the burn plan needs
three numbers it does not have at the start: the boss's HP, which save is weak, and how many LR it has. Blind stays on
racing on purpose: it knows nothing and learns nothing, so its plan is always "average saves, three LR, race".

**Boss HP (`kBossHp`).** The flat size prior (Huge 140) made a 256 HP dragon look like a short race. For the plan only, a
creature the party takes for a boss (it has LR left in the party's reckoning) starts from a bigger prior (Huge 200,
Gargantuan 320); once the party has seen something (bloodied, down: `hpLo`/`hpHi` from `learnHp`) the observed bounds take
over, and "not bloodied after N damage" already raises the floor to 2N. So the race estimate grows as damage goes in.
Nothing here is read from the creature's real HP.

**Probing (`v2BurnPlan` → `plan.probers`).** Where the plan says *race* only because an ability's save is unknown, a cheap
effect aimed at it is worth its information. For each ability the party has an effect for and has no save seen on, the
plan is recomputed as if that save were weak (`burn.probe` points of doubt); `swing` is what burning would then save over
racing. `voi = burn.probeP × swing × probeBias` (probeP: the chance an unseen save is weak, 0.35). The cheapest effect
for each such ability (cantrip, then low slot, then the likelier failure) is a probe when `voi` beats its price; at most
`probeMax` (2) a round, one per ability, so the party's Wisdom, Dexterity, … effects are spread. A prober is lifted in
`v2TurnInner` like a burner: it is worth what it gives up plus `voi`. Once a save is seen the ability is no longer unseen,
and `kSave` (via `learnSave`) takes over: weak → the normal plan burns; strong → the doubt is gone and it races. When
every ability it has an effect for has been tried and none is weak it stops probing. Open and blind never probe.

**Legendary Resistance.** Since step 2.9 there is no assumption of three on a Huge unknown (see "What the party knows"),
so the burn plan, and with it the probes, only start once a use of LR has been seen: the party's first control on a
boss is an ordinary cast at full value, and that cast is what shows the LR. Probes before that sighting no longer
happen (there is no boss with LR left to plan against). Open mode is unchanged.

**Profile.** `AI_BASE.burn.probeBias` (1), `probeP` (0.35), `probeMax` (2); `controller` 1.4, `artillery` 0.6. `probeBias: 0` turns probing off.

**Intent lines.** "Wizard probes the Adult Red Dragon's Wisdom save with Hideous Laughter".

### Control value: the party's turns against a held foe (step 2.10, part A)

**What was wrong.** On the no-LR, Wisdom −1 dragon (K2) the Wizard's Hold Monster scored 49.5 against a 5th-level slot priced
48, so it was cast about 1.6 times a day, usually late. Broken down by term at the round-1 decision (open mode):
denial `effectValue(Paralyzed) = 2 × kDpr + 8 = 38` × `ctlRound` 0.5 × pFail 0.8 = 15.2 a round, × `critBoost` 1.3, × 3.4
expected rounds (save at the end of each of its turns) × `concKeep` 0.75. The duration, the cap at the target's
expected life, the single concentration charge and the denied actions (kDpr × rounds) were all counted. The **allies'
side was not**: "attacks against it have advantage, and hits from within 5 ft crit" was the flat `+8` inside
`effectValue` (× 0.5 × 1.3, about 5 points a round), while the Fighter's and Barbarian's extra damage against a
paralysed dragon is about 30 a round. That is the term that made control lose to damage. The slot price (48 for a 5th
level in the last fight, `base × 0.5`) is the other half of the gap; it stays as it is (see the sweep below).

**The term (`v2Expose`).** For a condition that changes how hard our side hits (`EXPOSE`: Paralyzed, Unconscious =
advantage and crits from within 5 ft; Stunned, Petrified, Restrained, Blinded = advantage), the value of one round is
the extra damage the creature's side deals it: for each ally that can reach it next round (speed + range), its best
action attack's expected damage with the condition minus without (advantage on the hit chance unless it already has
it; × `w.critDmg` 1.6 for melee when hits crit), summed. It is capped at the condition's share of what the foe has
left, `kHp × gain / (gain + plain damage)`: when the party's plain hits drop it anyway (a goblin), hitting harder adds
little; on a 200 HP boss the cap does not bind. It is scored in damage units: × (1 + kDpr/`dprScale`) × `w.damage` ×
`w.expose`. Other-side facts come through `kAc` (via `hitChance`), `kHp`, `kDpr`.
- Counted once per cast: each ally attacks one target a round, so an area (Entangle) or a multi-target hold counts the
  exposure on its main target only (the others caught add their denial), and `v2Holding` counts the largest one.
  Without these two rules the first version had the Zaki party's Druid casting Entangle on Goblin Warriors in the
  day's opener: hard-day fell from 87% to 79% (paired seeds: 21 days lost, 5 won).
- `v2Control`: one round = denial (`effectValue` × `ctlRound`, as before) + pFail × exposure; then LR, `shakeOff`, the
  duration and the life cap as before. `critBoost` is gone (the crit is now counted where it happens).
- `v2Holding`: a held effect counts its exposure too (the effect is on; no pFail), so a caster keeps Hold Monster.
- Riders (Stunning Strike): `pLand × (effectValue × ctlRound + exposure) × (1 − pKill)`. Before, a rider counted
  denial at `effectValue` × 1 while spells counted it × `ctlRound` 0.5: one stunned round was worth twice as much from
  a Monk as from a Wizard. Now both are on one scale.
- `w.control` multiplies all of it (riders, pushes and spell control), plain data, swept by outcome below.

**Calibration.** `w.control` swept over 0.8 / 1 / 1.25 / 1.5 / 2 on K1–K8 (K8: the K2 dragon with a Bard, for
Hypnotic Pattern), B1–B9, A1–A8 and the step 1 / step 2 scenarios, 200 runs, same seeds. `controller` and
`artillery` scale it (1.25 / 0.8, both inside the range that held everywhere); no harness scenario uses those
presets, so they are not calibrated by outcome. Win % ± SE (v2 party; K rows per knowledge mode; B rows the v2+ arm),
"before" = the step 2.9 commit; only rows that moved are shown, every other scenario stayed within 1 SE:

| scenario | before | 0.8 | **1.0** | 1.25 | 1.5 | 2.0 |
|---|---|---|---|---|---|---|
| K2 open (no-LR dragon) | 71.5±3.2 | 79.5±2.9 | **80.0±2.8** | 81.0±2.8 | 82.0±2.7 | 82.5±2.7 |
| K2 learn | 49.5±3.5 | 67.5±3.3 | **73.5±3.1** | 78.0±2.9 | 77.0±3.0 | 80.5±2.8 |
| K2 blind | 0.5±0.5 | 17.0±2.7 | **25.5±3.1** | 32.0±3.3 | 30.5±3.3 | 29.5±3.2 |
| K8 open (with a Bard) | 60.5±3.5 | 69.5±3.3 | **67.0±3.3** | 69.0±3.3 | 68.0±3.3 | 67.5±3.3 |
| K8 learn | 20.0±2.8 | 46.0±3.5 | **48.0±3.5** | 49.0±3.5 | 48.5±3.5 | 46.5±3.5 |
| K8 blind | 2.5±1.1 | 25.0±3.1 | **27.0±3.1** | 35.5±3.4 | 34.0±3.3 | 32.5±3.3 |
| K3 / K5 learn (3 LR) | 44.5±3.5 | 48.5±3.5 | **42.0±3.5** | 40.5±3.5 | 38.0±3.4 | 37.5±3.4 |
| B3 (1 LR) | 54.0±3.5 | 57.5±3.5 | **59.0±3.5** | 59.5±3.5 | 61.0±3.4 | 63.0±3.4 |
| B4 open (damage-heavy party) | 78.5±2.9 | 78.0±2.9 | **78.5±2.9** | 78.0±2.9 | 69.0±3.3 | 68.0±3.3 |
| B4 learn | 72.0±3.2 | 73.0±3.1 | **67.0±3.3** | 63.0±3.4 | 63.5±3.4 | 64.0±3.4 |
| B2 / B8 learn (+14 saves) | 13.0±2.4 | 13.0±2.4 | **15.0±2.5** | 10.5±2.2 | 10.5±2.2 | 7.5±1.9 |
| A6 (boss and minions) | 78.5±2.9 | 81.0±2.8 | **80.0±2.8** | 79.0±2.9 | 77.0±3.0 | 68.0±3.3 |
| Zaki's party vs hard-day | 87.0±2.4 | 87.0±2.4 | **86.5±2.4** | 86.0±2.5 | 86.0±2.5 | 85.0±2.5 |
| worse / better beyond 2 SE | | 0 / 4 | **0 / 4** | 0 / 5 | 1 / 5 | 2 / 5 |

**Chosen: `w.control` 1.0.** The corrected term does the work; the multiplier stays neutral. 1.25 still passes the
2 SE test but leans on its edge (B4 learn −9, 1.9 SE); 1.5 and 2 lose B4 open and A6 (racing parties that hold instead
of hitting). Hold Monster on the no-LR dragon (K2 open): cast in 51% of days, first in round 1.65 → every day, round
1.0; on the Hill Giants (K1): never → 99% of days, round 1. Stunning Strike counts are unchanged (K6 4.0, K7 6.7 a day).

### What the party knows, and the day's length (step 2.10, part B)

**Ablation.** From learn and from blind, the party is given the true value of exactly one thing (boss HP, AC, save
bonuses, damage per round, resistances and condition immunities, the day's length) by swapping that one `k*` accessor
for the real number, in a harness script (no engine change). The table, ranked by win points recovered, is at the end
of this section.

**Day length (`leftFor`).** Fights still to come today, as the party reckons it:
- open: the real count (as before).
- learn: the real count too: the party knows the day's true length, total and remaining (a DM tells the table, or the
  party planned its day). `opts.expectFights` (a number: the fights the party expects today, counting this one and
  those already fought) overrides it: fight k (0-based) then has `max(0, expectFights − 1 − k)` to come.
- blind: an assumed length, `opts.expectFights` or `BLIND_FIGHTS` (the default, chosen from the numbers below), same
  formula. No floor: a blind party that has reached the end of the day it assumed spends what it has (the old guess,
  `max(1, 2 − fightNo)`, never believed the day was over, so it hoarded slots even in a one-fight day).
- before fight 1 (pre-fight buffs, `morningCasts`), "fights to come" is the whole day: the real total (open, learn) or
  the expected / assumed total.
Monsters still see their day as the fight in front of them (`v2Pace` uses 0 for them; `slotCost` prices them flat).

**War Table.** "Fights the party expects today": *exact* (default: learn uses the real count, blind its assumption) or
1–6. Saved with the other sim settings (`S.settings.expectFights`), passed through `simOpts()` to odds, single fights and
the replay; changing it clears the cached odds. Open mode ignores it.

**Ablation results** (after part A; v2 party, 200 runs, same seeds; win % change from the plain mode, then damage
dealt and slot levels spent; K2 = the no-LR Wisdom −1 dragon, K8 = the same with a Bard). Ranked by points recovered
(the mean of K2 and K8):

| truth given | blind K2 | blind K8 | blind mean | learn K2 | learn K8 | learn mean |
|---|---|---|---|---|---|---|
| (none) | 25.5±3.1, 190 dealt, 15.8 slots | 27.0±3.1, 184, 13.7 | | 73.5±3.1, 242, 18.1 | 48.0±3.5, 215, 14.7 | |
| boss HP | **+27.0** (211, 18.2) | +9.0 (193, 16.2) | **+18.0** | −3.5 (234, 16.4) | +4.5 (222, 15.7) | +0.5 |
| resistances / immunities | +8.5 (217, 13.4) | +17.5 (218, 11.8) | +13.0 | +0.5 (245, 18.0) | +6.0 (222, 13.9) | +3.3 |
| day length | +9.5 (198, 19.6) | +8.5 (194, 15.8) | +9.0 | −1.0 (242, 23.6) | +6.0 (221, 19.5) | +2.5 |
| save bonuses | +3.5 (199, 15.1) | +14.0 (200, 12.0) | +8.8 | +5.5 (247, 16.4) | +4.5 (224, 14.6) | **+5.0** |
| AC | +2.0 (204, 14.8) | +7.0 (198, 13.2) | +4.5 | +4.5 (246, 17.9) | +2.5 (221, 15.2) | +3.5 |
| damage per round | −10.5 (184, 15.2) | −14.5 (162, 13.2) | −12.5 | +0.5 (245, 18.7) | −17.0 (195, 14.7) | −8.3 |

Control casts per day (Hold Monster, Hypnotic Pattern, Laughter, Command): blind 0.77 / 1.10, learn 1.07 / 1.39
(K2 / K8); true saves raise learn to 1.96 / 2.31, true damage per round drops them to 0.35–0.89.

Reading it: blind's big gap is the boss's HP (the Huge prior is 140, the dragon has 256), then resistances and the day's
length. Learn already reads HP, AC and resistances well enough; its remaining gap is saves (it has to cast to learn
them). **The true damage per round loses points**: the harness dragon hits at a quarter of its real damage (15 a round)
while keeping its full HP, and the Huge prior (28) overstates it. Told the truth, the party values control (denial is
`kDpr` × rounds) and the boss's threat less and plays a long fight too cheaply. That is an AI weakness (the value of
ending a long fight sooner barely depends on the foe's damage), not a reason to keep a wrong prior.

**Day length, the change.** Learn knowing the day (the default): no win change beyond noise on a one-fight day (K2
73.5 → 72.5, K8 48 → 54) or on the harness's multi-fight days (all won or all lost either way), but it stops hoarding:
slot levels spent go up where the old guess of two more fights held them back (K2 18.1 → 23.6, K8 14.7 → 19.5, C-Day
11.1 → 16.3, C-Brute 7.0 → 9.9) and the party takes less damage (K2 182 → 150). With the change in the engine, K and B
learn/blind rows against part A alone: K8 learn 48 → 54, K4 learn 29 → 35.5, K2 blind 25.5 → 31.5, K8 blind 27 → 32,
B9 learn 6.5 → 4.5; nothing worse beyond 2 SE.

**Blind's default (`BLIND_FIGHTS` = 2).** Assumed totals tried in blind (win, slot levels): K2 old guess 25.5 / 15.8,
1 fight 35.0 / 19.6, 2 fights 31.5 / 16.3, 3 25.5 / 15.8 (= the old guess on one fight), 4 28.5 / 14.3; K8 27.0, 35.5,
32.0, 27.0, 30.0. On the multi-fight days (C-Day, C-Long, C-Brute, three-fight martial day, B9) every value gives the
same win rate (100% or 0%), so the cost of spending everything early is not measured there. 2 ("one more fight after
this one") takes most of the one-fight gain and keeps a reserve for a long day; 1 scored 3.5 points higher on the
one-fight days (within noise) but leaves a blind party nothing for fight 2.

**Priors (not changed).** The size priors are low: the Library's 47 SRD monsters average 61 HP for Medium (prior 32),
97 Large (70), 182 Huge (140, from only three: Hill Giant 105, Hydra 184, Adult Red Dragon 256). Raising them is a
one-line change, but three Huge monsters do not justify a number, it moves every blind and learn fight (and the old AI
in those modes), and the damage-per-round row shows that a more honest prior can make play worse until the AI weakness
above is fixed. Left for a decision with a larger sample (the full SRD 5.2 list, by size and CR).

### The threat estimate: learn mode reads strength, not size

**Status: adopted, the default for learn on v2 since step 2.11** (bloodied reading, part A; the threat score, part C; gate at the
end of this section). `opts.threat: 'bounds'` (harness `THREAT=bounds`) is the bloodied reading alone, `opts.threat: false`
(`THREAT=off`) the classic reading, both for comparing. The classic AI's logs do not move; the v2 learn logs move on
purpose, baseline `tests/fixtures/hashes-v2-learn.txt` (`AI=v2 KNOW=learn node tests/flagoff-hash.js`).

Decisions (the user's): blind keeps its size priors and may play badly; open is unchanged; learn stops guessing HP from
size. It judges how strong an enemy *seems* and reads HP from that. Applies when the side plays learn **and** runs AI v2
(`keen(team)`), so the classic AI's learn logs do not move; half casters in a v2 party share their side's estimate.
The score is the party's only (`threatOn`): a learning foe side keeps its size priors and gets the sharper bloodied
reading below.

**The score.** One number per kind of creature, on the CR scale, kept in the kind's record (`threat`, cached until new
evidence arrives).
- *Prior*: a typical creature for the party's level, shared out. `xp(level × crPerLevel) × (party size / 4) / enemies / crowd`,
  read back as a CR. `crowd` (`threat.crowd`) is the DMG's encounter multiplier: the same budget buys weaker creatures in a
  crowd (× 1.5 from 2 enemies, 2 from 3, 2.5 from 7, 3 from 11, 4 from 15). The party knows its own level and sees the head
  count. Nothing about the creature is used.
- *Evidence*, each read back as a CR through the table and averaged with the prior by weight; weights grow with the
  number of observations (`w × n / (n + half)`), so the prior fades as the fight goes on:
  attack bonus (most likely bonus given its hits and misses against our ACs, plain rolls only), the best save DC it has
  forced, damage per active turn divided by its observed hit rate (one victim per area), a sighting of Legendary
  Resistance (the median CR of the Library's monsters that have it), and, as floors that only pull up, the most attacks
  in a turn, the actions it has shown, and the conditions it inflicted.
- *Bounds win* (rule below): the score is moved to fit the HP bounds the moment they arrive, so a boss bloodied after 200
  damage is a strong creature for AC, saves and the race, not a weak one with a clamped HP number.

**From score to numbers.** `kMax` reads HP from the table at the score, inside the seen bounds; with both bounds it takes
their middle. `kHp`, `kFrac`, `kBossHp` and everything built on them (race estimate, pacing, "is the fight won") follow
through the same accessors; the size-based boss prior (225 / 400) is gone from learn. `kAc` takes its prior from the table
too (`useAc`), and the seen evidence works as before. `kSave` read one number for all saves at first, which hid the
harness dragon's weak Wisdom (K2 fell 72.5 → 56), so it was off; it now reads a column per ability, half way from +2 (see "Save priors by ability"). Damage per round (`kDpr`) keeps its size prior.

**The table (`AI_BASE.threat.table`).** Medians by CR measured from the SRD 5.2 Library (`data/srd-monsters.js`) with the
site's own parser, CRs grouped where a CR has few monsters, each column forced to rise with CR. Generated by
`node tools/build-threat.js` (rewrites the marked block in the engine; rerun it when the Library or the parser changes).
Between rows it interpolates; a flat stretch of a column reads back as its middle.

**Bloodied is a disclosure.** At HP ≤ half of its maximum a creature is bloodied and the other side is told, both ways
(`seeBloodied`, the unit's `bloodied` flag, an "is bloodied" / "is no longer bloodied" line in the log). A keen side reads
that flag and what it did itself: `netLost` is the damage that got through (the hit as rolled, not cut to the HP left)
less the healing it saw. Bounds on maximum HP (`learnBounds`; `hpLo`/`hpHi` on the kind):
- not bloodied after N net damage: max > 2N;
- bloodied after D: max ≤ 2D, and max > D (still standing);
- down after D: max ≤ D;
- healing is seen too: still bloodied after a heal tightens the top, out of bloodied raises the floor;
- bounds that contradict each other mean something unseen happened (healing it could not see): keep the latest.
The classic path (`visLost`, cut to the HP left) wrote the exact maximum into `hpHi` on a kill and used `<` for half;
it stays for the classic AI so its logs do not move, and a keen side never reads it. So a kill bounds a kind's HP by the
hit as rolled, unless the last hit happened to be exact, which is a fair reading.

**The foes' side.** Where a foe side plays learn on v2, the same flag, `netLost` and bounds apply to what it sees of the
party; its starting numbers stay the size priors. Nothing else was added for it.

**Results (learn rows, v2 party, 200 runs, same seeds; `node tests/ai-compare.js` with `KNOW=learn V2ONLY=1`; accuracy with `ACCURACY=1`).**
Across 66 rows, against before: threat estimate 8 worse and 4 better beyond 2 SE (mean 72.7 → 72.4); bloodied reading alone
0 and 0 (72.8). Rows that moved:

| scenario | before | threat | bloodied only |
|---|---|---|---|
| Zaki's party, hard-day | 51.5±3.5 | **73.5±3.1** | 51.0±3.5 |
| Default party, hard-day | 89.5±2.2 | **94.5±1.6** | 91.5±2.0 |
| Caster: 2 Mages + 6 Guards | 35.0±3.4 | 40.5±3.5 | 35.5±3.4 |
| K2 / T1 no-LR dragon | 72.5±3.2 | 72.5±3.2 | 73.0±3.1 |
| K8 no-LR dragon, Bard | 54.0±3.5 | 55.0±3.5 | 53.0±3.5 |
| K3 / B5 learn, 3 LR dragon | 45.5±3.5 | **32.0±3.3** | 43.5±3.5 |
| K5 immune dragon, 3 LR | 44.5±3.5 | **32.5±3.3** | 43.0±3.5 |
| B2 / B8 learn, +14 saves | 14.5±2.5 | **9.0±2.0** | 14.0±2.5 |
| B4 damage-heavy party, 3 LR | 71.0±3.2 | **62.5±3.4** | 70.5±3.2 |

Accuracy (estimated max HP ÷ true, median): the lone dragon at round 3 reads 1.02 with LR, 0.93 without (old 0.65, 0.84);
the Medium brute at round 1 reads 0.60 (old 0.13). But at round 1 the glass cannon reads 2.84 (old 1.07) and the swarm 2.54
(old 1.50), and on hard-day's mixed foes round 5 reads 1.36 / 1.14 (old 0.99 / 0.88) with a 90th percentile above 2. After
the bloodied moment every scenario reads 0.99–1.05.

**Where it fails.** Strength shows through what a creature does, so an enemy whose offence and toughness disagree reads
wrong until the bounds arrive: the glass cannon, and the swarm, whose prior is about CR 1 where the goblins are CR ¼. The
harness dragon at a quarter damage is not read low, as expected beforehand: its attack bonus and save DCs are untouched,
so they carry the score. Hard-day's gain comes with worse accuracy, so part of it is overestimates making the party spend
more, not better reading.

**The gate (step 2.11).** All learn rows, 200 runs, same seeds, on the Part B code (`w.buffRounds` 2): nothing worse beyond 2 SE, so
adopted by the rule set for it. Bloodied reading → threat estimate:

| scenario | bloodied | threat | threat + crowd prior (adopted) |
|---|---|---|---|
| Zaki's party, hard-day | 51.0±3.5 | 73.5±3.1 | **70.0±3.2** |
| Default party, hard-day | 91.5±2.0 | 95.0±1.5 | **96.0±1.4** |
| Caster: 2 Mages + 6 Guards | 35.5±3.4 | 40.5±3.5 | **38.5±3.4** |
| A6 boss and minions | 78.5±2.9 | 81.0±2.8 | **81.5±2.7** |
| K3 / K5 / B5 learn, 3 LR | 58.5±3.5 | 55.0±3.5 | **55.0±3.5** |
| K2 / T1 no-LR dragon | 84.0±2.6 | 79.0±2.9 | **79.0±2.9** |
| K8 no-LR dragon, Bard | 53.0±3.5 | 55.0±3.5 | **55.0±3.5** |
| B2 / B8 learn, +14 saves | 16.0±2.6 | 14.0±2.5 | **14.0±2.5** |
| B4 damage-heavy, 3 LR | 74.0±3.1 | 68.0±3.3 | **68.0±3.3** |
| B9 learn, day | 7.5±1.9 | 6.5±1.7 | **7.5±1.9** |
| C-Caster monster | 73.0±3.1 | 68.5±3.3 | **69.5±3.3** |
| mean of 66 / worse, better beyond 2 SE | 74.5 | 74.7, 0 / 2 | **74.6, 0 / 2** |

The two better rows are one scenario listed twice (the Zaki day). The dragons give back 3.5–6 points each, all inside 2 SE, and they all lean the same way; against the code before step 2.11 they are
still up (K3 43.5 → 55, K2 73 → 79). The adoption rests on the rule, and the
hard-day gain is not better reading (see "Pacing and danger").

**Accuracy after it** (median estimate ÷ true at round 1): swarm 1.18 (2.54 before the crowd prior), Medium brute 0.60, the dragon 0.58, boss
with minions 0.23 (the Hill Giant reads as one of seven; bounds fix it by round 3), glass cannon 2.37. The glass cannon stays: it hits like what it reads as
until the first bloodied moment, and nothing general corrects that sooner. After bloodied every scenario reads 0.99–1.10.

**Run time.** Ms per day, no replay, alternating arms, 100 days: default party hard-day 168 → 212 (+26%), Zaki's party 176 → 160, K3 299 → 291,
swarm 217 → 216. So the +24% is one day, not the estimate: of the 4.4 s added over 100 of those days, `threat`'s own code is under 0.2 s,
and `los` + `areaCatch` (area aiming) are 3.3 s, with call counts level on the first 40 days, so a minority of days carries it.
Not cut: no cheap saving in the estimate, and area aiming is a separate job.

**Why it was not adopted at first.** The LR dragons lost about 12 points whatever the estimate said: `crPerLevel` 1.4 / 2 / 3 and
`legRes` 6 / 20 all left K3 at 32–33.5, and the party cast more control into LR (K3: control casts 1.44 → 1.90, LR burned 1.01 →
1.26, damage dealt 216 → 196). Step 2.11 found the cause elsewhere: heals losing to buffs in a long fight, see "Control against
Legendary Resistance".

### Control against Legendary Resistance, and what the LR rows were really losing to (step 2.11)

**The problem as reported.** With a realistic HP estimate the LR rows lost about 12 points (K3 45.5 → 32), and more
control went into LR. The numbers below say control was not the cause.

**Diagnosis** (K3 learn, bloodied reading, 200 runs; per caster decision with control available on the dragon; `full` is
the best control's value with no LR, `disc` with it, `alt` the best other option net of its price):

| state | decisions/day | control picked | full | disc | alt | plan on |
|---|---|---|---|---|---|---|
| no LR seen (3 left) | 4.00 | 26% | 44.0 | 46.7 | 53.1 | 0% |
| 1 seen (2 left) | 6.88 | 3% | 21.2 | 8.1 | 50.2 | 6% |
| 2 seen (1 left) | 0.46 | 26% | 19.5 | 9.8 | 55.7 | 62% |
| 3 seen (0 left) | 0.50 | 10% | 24.0 | 27.6 | 43.2 | 0% |

- Before the first sighting: 1.05 casts a day, nearly all round 1, nearly all Hold Monster at 5th level (0.94). LR ate 0.75,
  0.30 passed, none landed.
- After it: 0.37 casts a day (threat estimate: 0.85), almost all Command; 0.04 landed.
- Pile-on: 0.01 casts a day shared a round with another after the sighting. Not a problem.
- The burn plan was still running in learn, against the user's decision: on at 62% of the decisions with one use left
  (68% with the threat estimate).

**The fixes that were asked for.**
- *Priced by uses left.* A failed dangerous save is bought off while uses remain, so a cast into a creature with L uses left
  lands nothing and buys one use of the L: `per × w.legRes / L`, in place of a flat `× 0.2`. `w.legRes` swept 0 / 0.2 / 0.4 /
  0.6 / 1 / 1.5 with the plan off: flat from 0 to 0.6 (K3 44 throughout); 1 costs B5 open a point or two, 1.5 costs it 9.5.
  **0.4**, the middle of the flat range (2 uses left reads as the old 0.2).
- *No burn plan in learn or blind.* `burn.modes`, default `['open']`. K3 44 with or without it at the bloodied reading (45.5
  with it), so nothing was lost by honouring the decision. The probing code stays dormant behind it.
- *The first, unavoidable cast.* Tried as a doubt on control at a creature that has shown neither LR nor a failed
  dangerous save, scaled by its share of the HP left. Doubt 0.2 / 0.4 / 0.6: K3 43.5 / 41.5 / 46; K2 73 / 65 / 61; K8 53 / 51 / 43.
  It costs the no-LR bosses far more than it saves, so it was dropped and the cast stays at full value (0.75 uses a day
  for a 5th-level slot, the price of not assuming LR).
- Together: no row moved beyond 2 SE in learn, open or blind. Safe, and not the cure.

**The real cause.** B2 (+14 saves) lost the same 5 points with no LR used at all, so it had to be something else. Actions a day,
K3, bloodied reading against the threat estimate: Cure Wounds 0.86 → 0.36, Healing Word 0.99 → 0.63, Mass Healing Word
0.47 → 0.23, Preserve Life 0.68 → 0.47, Bless 0.90 → 1.29. A buff was worth one round × the fight's expected rounds, up to 8; a
heal is worth the HP it gives back now. So the longer the party expects the fight to be, the more Bless beats healing, and
the party dies sooner (7.7 → 7.0 rounds) with less dealt. The realistic HP number only exposed it.

**A buff's horizon (`w.buffRounds`).** A buff is counted at most this many rounds ahead: `R = min(rounds, buffRounds)`.
Measured: damage, not value. It says how far ahead a concentration buff can be banked on against the same turn spent
healing. LR rows, learn, 200 runs, same seeds:

| scenario | before | 5 | 4 | 3 | **2** | w.buff 0.85 | 0.7 | 0.6 |
|---|---|---|---|---|---|---|---|---|
| K3 / B5 / K5 learn, 3 LR | 44.0 | 44.5 | 45.5 | 53.0 | **58.5** | 50.0 | 57.5 | 59.5 |
| K2 no-LR dragon | 73.0 | 73.0 | 73.0 | 75.0 | **84.0** | 76.0 | 80.0 | 84.5 |
| K8 no-LR dragon, Bard | 53.0 | 53.0 | 53.0 | 53.0 | **53.0** | 53.5 | 53.5 | 54.0 |
| B2 / B8 learn, +14 saves | 14.0 | 14.0 | 14.0 | 15.5 | **16.0** | 13.5 | 14.0 | 15.5 |
| B4 learn, damage-heavy | 71.0 | 71.0 | 71.0 | 71.5 | **74.0** | 71.5 | 72.0 | 72.5 |
| B9 learn, day | 4.5 | 4.5 | 5.0 | 7.0 | **7.5** | 4.5 | 6.5 | 7.5 |
| B5 open | 51.5 | 52.0 | 52.5 | 56.0 | **60.5** | 49.5 | 55.5 | 56.0 |

Chosen **2**: it cuts the term that was wrong rather than every buff. 1.5 is no better (K3 59.5, K2 85.5 learn; K2 87.5 open
against 89.5). Whole table, against the priced-LR code above, 66 rows, 200 runs, nothing worse beyond 2 SE in any mode:

| mode | mean | worse / better beyond 2 SE | rows that moved most |
|---|---|---|---|
| learn | 72.8 → 74.5 | 0 / 5 | K2 73 → 84, K3 44 → 58.5, K5 44 → 58.5, K4 37 → 44.5 |
| open | 77.6 → 79.6 | 0 / 6 | K2 80 → 89.5, K3 51.5 → 60.5, K4 46 → 67, K5 53.5 → 74.5, B7 29.5 → 42 |
| blind | 67.2 → 67.8 | 0 / 1 | B5 learn |

K3 learn after it: Cure Wounds 1.29, Healing Word 1.11, Mass Healing Word 0.58, Preserve Life 0.86; damage dealt 217 → 230, deaths 0.32
→ 0.22. Control still gets cast on a boss with no LR, more than before: K2 1.19 → 1.65 casts a day (K8 1.58 → 1.58). The party stops
casting control into a dragon it has seen use LR (0.37 → 0.00 after the sighting), first cast unchanged (1.17 a day). Open's burn plan
is unaffected: K3 open 51.5 → 60.5. Not capped: `v2Holding` still counts a running buff over the full rounds, so a caster keeps a buff it
already has; the sweep was measured that way.

**Not done.** A rider (Stunning Strike) still has no LR term: a martial's rider into LR is valued as if it lands. Nothing here measured it.

### Pacing and danger: the hard day (step 2.11, diagnostic only)

**The claim tested.** On Zaki's hard day the threat estimate gained 22 points with worse accuracy, which suggested a party that
hoards on hard days and an overestimate that makes it spend. **It does not hoard, and the estimate does not change what it spends.**
Per fight, 200 runs, step 2.11 part A code (bloodied reading / threat estimate; the share is what pacing allows the fight before the tax):

| fight | reached | won | party HP start → end | slot levels start | spent | share | limited uses spent |
|---|---|---|---|---|---|---|---|
| 1 Ogres, goblins | 200 / 200 | 100 / 100 | 100 → 89 / 87 | 29.0 | 10.1 / 10.3 | 25% (7.3) | 4.8 / 4.7 |
| 2 Troll, wolves | 200 / 200 | 100 / 100 | 89 → 82 / 87 → 81 | 19.0 | 4.8 / 4.9 | 33% (6.3) | 4.5 / 4.6 |
| 3 Mage, Priest, 4 Goblins | 200 / 200 | 54.0 / 77.5 | 82 → 19 / 81 → 42 | 14.3 / 14.1 | 5.9 / 6.2 | 50% (7.1) | 5.2 / 4.8 |
| 4 Owlbears | 108 / 155 | 94.4 / 94.8 | 36 → 37 / 55 → 51 | 7.8 / 8.3 | 5.2 / 5.3 | 100% | 4.3 / 3.8 |

Slots spent match to within 0.3 levels in every fight, and fight 1 runs over its share. Fight 3 decides the day, and round 1 of fight 3
decides that: party HP at round 2 is 29% against 46%.

**Does pacing respond to danger?** Yes, fast. `losing` is on before party HP reaches 60% (0.8 rounds before it, in fight 3). Share of caster
decisions spending a slot, fight 3, by party HP: ≥75% 59%, 50–75% 73%, 25–50% 91%, under 25% 94%; a slot's price falls from 8.1 to 2.2.
But it can only respond to damage already taken, and here most of it arrives in one blow: the Mage's Cone of Cold deals 110 a fight in rounds 1–2
(62 with the estimate). The 10 slot levels left on a lost fight are casters who went down before their next turn, not caution.

**The cause.** Who the party hits first. Hits in round 1: Mage 4.07 → 4.75, Priest 2.30 → 3.15, Goblins 2.86 → 2.12; Hold Person 0.20 → 0.37; so the
Mage casts its Cone of Cold in round 1 far less often. The size prior reads a Goblin at 15 HP, a soft target the posture picks (`finish`, `squishyHp`), and in round 1
the party cannot yet know which foe is the caster (`kCaster` needs a cast seen). The estimate reads everyone alike, so the goblins stop soaking up the opening.
Proof by ablation, no estimate: only raising Small foes' unseen HP to 32 takes the day from 51.0 to 66.5, slots spent unchanged. Tried on pacing instead:
`fightInHand` off in round 1, 53.5; slots 40% cheaper and untaxed in round 1, 57.0 (fight 3 63.5, fight 4 89.8: it borrows from the end of the day). Both inside noise of 51.

On the final code, with the estimate on, the same round-1 slot discount makes it worse: 70.0 → 66.0 (fight 4 starts with 5.5 slot levels against 8.6).

**Proposal (not built).** Leave pacing alone. Raise `SIZE_PRIOR.Small.hp` from 15 to 32 (for v2 it only reaches blind, now that learn uses the estimate).
Measured by ablation on the final code: Zaki's hard day under blind 47.5 → 68.0. Expected elsewhere: blind rows with Small swarms may spend more on goblins and lose a little; a full blind table is needed first (the classic AI reads the same prior, so its blind and learn logs would move: that needs the user's call).

### Downed allies: back in the fight (step 2.12, part A)

A heal priced by hit points restored is tiny for an ally at 0. What it really buys is the ally's next turns and the end
of its death saves. `v2BackUp(u, a, t, ctx, amt)` values that, in points of damage like everything else:

```
hp      = what the heal leaves it with
hit     = damage it would take next round if it stood up: the larger of v2Pressure and its adjacent foes' kDpr × 0.6 × backFocus
turns   = min(rounds left, backFirst + hp / hit)                 // it may get a turn even if it drops again at once
round   = its DPR, or backHealer if that is more and it can still heal
pDrop   = min(1, hit / hp)                                       // dropped again next round
up      = round × turns × backRound
life    = backLife × (1 + backDay × fights left)
saved   = deathOdds(left down) − pDrop × deathOdds(down again)   // the avoided death, less the chance of paying for it anyway
value   = up + life × saved
```

- **`deathOdds(s, f, rounds, hit2)`** is the exact chance of dying from `s` successes and `f` failures within `rounds`
  turns (a small table walk, no dice, no search): 40% one failure, 5% two, 5% back up, 50% a success, plus `hit2` a
  round for an attack on it that lands two failures. A stable ally only dies to attacks. Fight's end ends the risk,
  so a short fight leaves little to save.
- **`hit2`**: left down it is `backFinish` × adjacent foes (nobody can know a foe's policy on the downed, so it is a
  weight, not a read of `mayHitDowned`); after a second drop, `backFinish2` × adjacent foes, because foes that spare a
  first-timer do finish someone on the second drop (`mayHitDowned`).
- **The focus risk** is `hit`, and it costs twice: fewer turns up, and `pDrop` taking back the avoided death. Next to
  three foes a 7-point Healing Word buys about one turn and little else; across the room it buys the fight.
- **Bonus or action** needs no rule. A bonus heal is added to the action's score, so it wins whenever the action still
  has a use (a cantrip pairs with it; the one-slot rule makes "Healing Word + cantrip" compete with "Fireball").
  A full-action heal has to beat the whole action, so it wins only for an ally worth it at low risk.
- **Potions** go through the same term, on any creature within 5 ft, bonus action, drawn from `ext.resources`.
- **Own-side facts** (`t.dpr`, `t.deathF`, the heal's dice) are real; foes' damage goes through `kDpr`.

Replaces `w.revive`, `w.reviveRounds` and the failed-saves bonus. New weights in `AI_BASE.w`: `backRound`, `backFirst`,
`backFocus`, `backHealer`, `backLife`, `backDay`, `backFinish`, `backFinish2`; `support` raises `backLife`.

**Healing Light joins v2.** `v2Eligible` sent a creature with a dice-pool heal (`ext.pool`) to v1 for the whole fight,
so Niko, the only member of Zaki's party with Revivify, was not on v2 at all. A heal pool is an ordinary heal to the
scorer: the amount is `a.amount` (the per-use cap), `doAction` rolls the dice. Swallowing still goes to v1.

**Why the flat bonus lost.** Measured before the change: a Cleric with Spirit Guardians up chose Spiritual Weapon (32–48) over Healing Word for
the bonus action. An ally's round was priced in plain damage while every attack carries the threat multiplier, so the first version of this term
made things worse (44% healed, D4 from 53% to 31%). `round` now carries the same multiplier (1 + the foes' mean `kDpr` / `dprScale`), and the sweep
below set `backRound`.

**Calibration.** `DOWNED=1 node tests/ai-compare.js [runs]` counts, per ally at 0 HP with a heal in reach of someone on v2, whether it was healed.
D scenarios: `node tests/ai-compare.js 200 '^D[0-9]'`, one or more allies dropped as fight 1 starts. `backRound` on D1–D9, learn, 200 runs: 2: 68.4,
3: 71.3, 4: 72.2, 5: 72.8, 7: 73.4; it flattens from 4, so 4. `backSoak` 0.5 to 1 and `backFirst` 0.75 to 1 moved nothing beyond noise.

Rate over every harness scenario plus D1–D9, 100 runs each (more events after, because Niko is on v2 and counted):

| mode | events before, healed | after | turns with a bonus heal, used, before | after | turns with only an action heal, used, before | after |
|------|----------------------|-------|---------------------------------------|-------|---------------------------------------------|-------|
| learn | 2848, 70.0% | 3106, 82.6% | 35.1% | 69.5% | 85.9% | 93.8% |
| open | 2839, 69.7% | 3123, 80.5% | 35.6% | 64.8% | 79.7% | 85.8% |
| blind | 3410, 61.2% | 3588, 82.8% | 33.0% | 70.9% | 63.6% | 92.8% |

Win ± 3.5 (D9 ± 2), 200 runs, same seeds, before → after:

| scenario | open | learn | blind |
|----------|------|-------|-------|
| D1 healer, downed Fighter | 71.5 → 86.0 | 68.5 → 87.0 | 70.0 → 84.5 |
| D2 downed Fighter beside 3 foes | 81.0 → 85.0 | 79.0 → 80.0 | 64.0 → 64.5 |
| D3 downed healer | 83.0 → 81.0 | 74.5 → 79.5 | 71.0 → 73.5 |
| D4 two downed | 45.5 → 64.0 | 55.5 → 65.5 | 42.0 → 68.0 |
| D5 potions only | 65.5 → 66.0 | 58.5 → 58.5 | 60.5 → 60.5 |
| D6 a day | 53.0 → 63.0 | 48.0 → 50.5 | 28.0 → 31.5 |
| D7 Zaki, Kraax down | 42.5 → 65.0 | 47.5 → 66.0 | 45.5 → 62.0 |
| D8 Zaki, Faithwalker down | 58.5 → 67.5 | 59.5 → 69.0 | 50.0 → 63.0 |
| D9 Zaki, hard day | 96.5 → 94.0 | 92.5 → 95.0 | 85.5 → 90.0 |

D2 is the focus risk working: next to three foes the heal is priced down and the row does not move. D5 does not move because potions were already
used (93% of chances before): the term had nothing to fix there. Whole table, 66 rows, 200 runs: nothing worse beyond 2 SE in any mode; learn 77.2 → 77.8
(1 better), open 80.6 → 80.8 (1 better), blind 69.9 → 71.7 (10 better).

### Revivify: a death keeps a slot (step 2.12, part B)

**How the dead carry today.** `kill` sets `u.dead`; nothing clears it. `runDay` keeps the same units from fight to fight:
`resetFightState` leaves `hp` and `dead` alone, and `place` takes the dead off the board. So someone dead in fight 1 is
still dead in fight 4. Hit points carry between fights too: only a `shortRest` restores them, a downed creature wakes at
1 HP as the next fight starts, and a lost fight ends the day.

**The rule.** Revivify (level 3, action, touch, a creature dead for no more than a minute, back at 1 HP; the 300 gp
diamond is assumed). It is `ext.revivify` on an ordinary heal action, War Table only, and never a turn option: `usable`
says no, as for morning buffs, so neither AI can pick it or aim it, and it cannot touch the living. `heal()` still does
nothing to the dead and every heal pool still skips them, so ordinary heals cannot bring anyone back.

**The reserve is created by a death, not hoarded.** Nothing is kept until an ally dies.
- `revivable(team)`: the dead who died this fight, within `REVIVIFY_ROUNDS` (10, the minute). Someone dead from an
  earlier fight is out of reach. Fled creatures do not count.
- `reviveDuty(team)`: each of them goes to the caster with the most slots that can cast it, standing casters first.
  It is worked out afresh every time, so a reserve lets go by itself when the ally is back another way, the minute is up,
  or another caster covers it.
- `v2Reserve(u)`: what `u` keeps: the slots, their levels, the ally.

**Out of the pacing share.** In `v2Pace` the kept levels leave the pool: `left`, `start` and the last-fight budget all
drop by them, so the caster's share of this fight shrinks. On top, a cast that would take the last slot that can cast it
pays `v2KeepCost`: `pacing.reviveLife` + the ally's DPR × `pacing.reviveDay` × fights to come, × `pacing.losing` when the
fight looks lost (`v2Doomed`: the side falls in under 1/`pacing.reviveDoom` of the time it needs to win; not `losing`, which is
true whenever someone is dead). That is a term, not a veto: a lost fight still spends the slot, because nobody casts Revivify after a
defeat. Lower slots are untouched.

Reactions have no scorer yet (phase 3), so `usable` keeps them off the last slot that casts it. That is the one hard stop,
and only on v2 creatures holding a reserve.

**The fight's end.** `endFightRevives`, in `runEncounter` before the `end` event, when the party won: each of the dead,
highest DPR first, is brought back by a standing caster with a slot, which it pays for. It is logged as a `heal` event, so
the replay shows it; `results.party[].revived` counts it, and a revived creature is not dead in the results. A
caster who is down when the fight ends has to be woken first: `wakeReviver` has someone standing spend a heal on it
(a slot, a pool die, a potion), inside the minute. With no one to wake it, that ally stays dead.

**v2 only.** The rule runs for creatures on v2 (`u.reviver`), so the old AI's logs do not change. Mid-fight Revivify is
not built: it would take an action and a 3rd-level slot for an ally at 1 HP on a square foes may now stand on, and the
scorer would need a separate target path, so it did not come out naturally.

**Results.** On natural play it almost never fires. On the Zaki day and the Cleric day (R1–R4), rows with and without Revivify are identical, 0.00
revived a day. In 141 deaths on two harder days (200 runs each), the caster was never standing with a slot: it had just died itself (70), was dead
(26) or down (33), or had no slot left (12, all Niko's). Monsters focus healers, so the
casualty usually is the caster. So R5–R7 start the day with a non-caster dead, 200 runs, win / PC deaths / revived a day:

| scenario | mode | no Revivify | Revivify, no `v2KeepCost` | Revivify and reserve |
|----------|------|-------------|---------------------------|----------------------|
| R5 one 3rd-level slot | open | 5.0 / 1.39 / 0 | 5.5 / 1.39 / 0.01 | **34.0** / 1.02 / 0.47 |
| | learn | 2.5 / 1.33 / 0 | 3.5 / 1.33 / 0.01 | **31.0** / 1.02 / 0.45 |
| | blind | 3.0 / 1.27 / 0 | 3.0 / 1.27 / 0 | **21.0** / 1.04 / 0.40 |
| R6 two 3rd-level slots | open | 9.0 / 1.33 / 0 | 59.0 / 0.78 / 0.77 | **68.5** / 0.67 / 0.91 |
| | learn | 6.5 / 1.30 / 0 | 51.0 / 0.79 / 0.73 | **63.0** / 0.69 / 0.92 |
| | blind | 2.0 / 1.28 / 0 | 51.0 / 0.83 / 0.78 | **56.5** / 0.82 / 0.90 |
| R7 Zaki, Kraax dead | open | 66.0 / 1.50 / 0 | 89.5 / 0.46 / 0.73 | **97.5** / 0.12 / 0.97 |
| | learn | 77.0 / 1.29 / 0 | 92.5 / 0.41 / 0.76 | **99.5** / 0.04 / 0.99 |
| | blind | 69.0 / 1.39 / 0 | 85.0 / 0.58 / 0.67 | **97.5** / 0.13 / 0.99 |

With one slot, the keep term is the whole difference: without it the Cleric puts the slot into Spirit Guardians and the ally stays dead. In R5 a win
needs the slot to last the fight, and a reserve can only keep a slot that is still there, so the rate stops near 45%.

**Who has it.** The spell data lacked it; it is in `CUSTOM` in `sheet-reader.js`. The Life Cleric build gets it as a
domain spell. Niko is the only member of Zaki's party who has it (a Celestial patron spell, from the sheet).

### Two audits: Entangle on one foe, Caustic Brew over Chromatic Orb (step 2.12, parts C and D; no code changed)

Zaki's party, 200–300 seeded runs. "Without" removes the spell from that caster's book, same seeds.

**Entangle on a single enemy (Faithwalker).** DC 13 Strength, 1st-level slot, concentration.

| day | mode | casts per run | caught 1 | landed | win with / without |
|-----|------|---------------|----------|--------|--------------------|
| Stone Golem (Str +6) | learn | 1.27 | all | 19% | 100 / 100 |
| Stone Golem | open | 0.25 | all | 26% | 100 / 100 |
| Young Red Dragon (Str +6) | learn | 0.62 | all | 29% | 85.3 / 84.3 |
| Young Red Dragon | open | 0.04 (13 in 300) | all | n/a | 83.3 / 84.0 |
| hard-day.json | learn | 0.27 | two thirds | 62% | 94.7 / 94.7 |

A typical decision: the golem, round 1, nothing held. Entangle 30.7 raw, 26.7 net; Thunderwave 21.9 / 17.9; Toll the Dead 7.6; Guiding
Bolt 8.1 / 4.1. Entangle leads the next option by a median of 8–9 points. The target value decides, as designed; `ext.minCatch` is read by
v1 only, on purpose (terms, not vetoes).

**Verdict: right in kind, wrong in learn against a strong boss.** A lone boss can justify it, and open shows that: it is cast 7% of turns on
the golem. Learn casts it five times as often, because `kSave` reads an unseen Strength save at the +2 prior when the truth is +6, so it prices
a 30% spell as a 50% one. On a boss with a poor Strength it would be the right call. The cost is one 1st-level slot and an action: no row moves
beyond noise with the spell removed, though Faithwalker deals less with it (golem 12 against 18, the three-fight day 31 against 36). Proposed
(not built): let learn's prior for physical saves follow what the threat estimate reads (size or the attack bonus shown), in `kSave`.

**Caustic Brew over Chromatic Orb (Eldar).** What the log says each cast really dealt, a Brew's whole burn included (learn, 200 runs):

| day | Brew L2 | Brew L3 | Orb L1 | Orb L2 | Orb L3 | targets per Brew |
|-----|---------|---------|--------|--------|--------|------------------|
| Young Red Dragon | 3.8 | 7.7 | 11.6 | 11.9 | 19.9 | 1.0 |
| Stone Golem | 3.5 | | 9.9 | 14.4 | | 1.0 |
| hard-day.json | 8.4 | 13.7 | 8.8 | 15.2 | | 2.0 |
| 3 Ogres | | 21.6 | 17.8 | 16.0 | 14.8 | 2.5 |

Eldar deals as much or more with the Brew taken out: dragon 15 to 18 (learn), 24 to 27 (open); hard day 182 to 186, 161 to 165; golem (open) 50 to
56. Taking out the Orb instead costs damage: hard day 182 to 174, 161 to 152; dragon (open) 24 to 19. No win rate moves beyond noise either way.

**Verdict: the preference is wrong, except for a 3rd-level Brew on two or three foes in a long fight.** The cause is the action's data, not
the scorer. The engine deals nothing when it is cast and 2d4 per slot level at the start of each covered creature's turn while concentration
holds. But `dpr: '4d4'` (upcast +4d4) is what the scorer reads, so a 2nd-level Brew counts as 20 damage now, and earns the kill term on top. At
round 3, a dragon on 17 HP and one round left: Brew 74, Orb 42, though the Brew cannot kill it this turn and its first tick averages 10 on a failed
save. Also, `v2Holding` knows nothing of a burn (`holding 0.0` in the logs), so 97 of 309 Brews on the dragon were cast while concentrating, for free.

The change this audit proposed is built: see the next section.

### A burn is scored as a burn (step 2.12, after the audit)

A spell with `ext.dot` (Tasha's Caustic Brew, Phantasmal Force) deals nothing when cast; the engine gives each creature that fails a tick at the start of
its turn while concentration holds. `v2Value` now reads that instead of `a.dpr`, which stays as it is for the rule (`_saveDmg`, what Legendary Resistance weighs):

```
tick    = expected(the action with the tick as its damage): chance of failing × the dice at this slot level × what its resistances leave
ticks   = min(w.dotMax, max(w.dotMin, ctx.rounds − w.dotLag)) × w.concKeep   // the first tick is on its turn, and concentration may not last
value   = min(tick × ticks, kHp + overkill) × (1 + kDpr / dprScale) × w.dot
```

- **No kill term.** A burn cannot drop anything on the turn it is cast.
- **Upcasting.** `castCopy` puts the tick at slot level L in `ext.dotAt`, so each slot level is scored with its own dice.
- **Holding.** `v2Holding` counts a running burn: its tick × the rounds left × `w.concKeep`, per creature burning, capped by `kHp`. So a new concentration
  spell, or a second Brew, pays for what it ends.
- The other caster terms stay: the area sum over a line, slot pacing, the risk of losing concentration where it stands.

New weights: `w.dot`, `w.dotLag`, `w.dotMin`, `w.dotMax`, `w.dotHold` (× a running burn's value in `v2Holding`). `expected`, which the old AI reads, is unchanged.

**The cap.** Without `w.dotMax` the Brew rows gained, but D7 and D8 (twelve foes) fell 7–13 points in every mode: `ctx.rounds` sits at its ceiling of 8 in a crowd, so a burn out-scored
Fireball's damage now. On those rows and E2, E3, E6, 200 runs, open, `dotMax` 9: D7 52, D8 55, E3 88; 4: 60, 64, 87; 3.5: 61, 67, 88; 3: 64, 66, 79; 2: 65, 67, 80. So 3.5.
`dotHold` under 1 only hurts (0.5: D7 47; 0.25: E3 70), and `dot` 0.6–2.2 stays within noise or worse, so both stay at 1.

**Results.** E scenarios (`node tests/ai-compare.js 200 '^E[0-9]'`, Zaki's party), win before → after, 200 runs, same seeds, ±3.5 (E1 ±2.5):

| scenario | open | learn | blind |
|----------|------|-------|-------|
| E1 Young Red Dragon | 86.0 → 86.5 | 86.0 → 88.0 | 86.5 → 85.0 |
| E2 the dragon + 2 Ogres | 66.0 → **73.0** | 69.0 → 68.5 | 65.5 → 62.5 |
| E3 2 Stone Golems | 77.0 → **88.0** | 78.0 → 83.0 | 68.0 → 68.5 |
| E4 7 Ogres | 100 → 100 | 100 → 100 | 100 → 100 |
| E5 24 Gnoll Warriors | 100 → 100 | 99.5 → 99.5 | 99.5 → 99.5 |
| E6 a day | 46.0 → 53.0 | 54.5 → 51.0 | 47.0 → 48.0 |

Damage per cast read from the log (learn, 200 runs), before → after: on the dragon a 2nd-level Brew 3.8 → 13.1 and a 3rd-level one 7.7 → 14.7, because a running burn is kept instead of thrown away (Orb
10–16 there); on 2.2–2.7 foes 21.6 → 26.5 at 3rd level. The Brew now gives about what the Orb does on one target and more on a line, so the choice no longer costs damage. On the hard day it falls from 76 casts to 52.
Whole table against the Part B commit, 83 rows (the 66, D1–D9, R1–R7 and the arms), 200 runs: nothing worse or better beyond 2 SE in any mode (means 78.3 → 78.3, 81.2 → 81.2, 72.7 → 72.8). No hash moved:
neither spell is in the hashed parties.

### The price of going down (after a bug report: Niko, two Young Green Dragons)

**What happened.** Niko, low and flying beside a dragon, chose a touch heal on a downed ally. Touching a creature on the ground means dropping to its height, so
`settleAltitude` took him out of the dragon's reach and drew an opportunity attack. The search priced none of it: `v2Danger.oa` walks the ground path only, and a change of
height is not on it. And a priced opportunity attack is only its damage, capped by nothing and with no cost for what going down loses, while the heal it buys is priced by
`v2BackUp` at everything the ally is worth. So the two sides of the decision were not in the same currency.

**The term.** The same "back in the fight" sum, for the actor:

```
altOa   = opportunity attacks from foes in reach at its height that are out of reach at the target's (touch options, airborne, v2Danger.altOa)
share   = (oa + altOa) × w.dropEdge / its HP                         // expected damage understates a hit that lands
pDrop   = clamp((share − w.dropFrom) / (1 − w.dropFrom), 0, 1)       // nothing until one attack can take a real share of what it has
own     = its round (as in v2BackUp) × min(rounds left, w.dropRounds) × w.dropRound + w.dropLife + what it keeps for a dead ally (v2KeepWorth)
cost    = oa + altOa + pDrop × own
```

So going down costs the actor's turns and, for the only caster with a reserve, the ally it would have brought back. It is one term on the option's score, not a rule, and it
applies to any move: walking off, a touch heal, an action Dash. Rising out of reach at the end of a turn still draws an unpriced attack (backlog).

The height price lands after a square's best option is picked, so a priced touch would hide a ranged option that needs no descent. When a touch carries that price the square also offers its best non-touch
option (`offAt(x, y, false, true)`), unpriced, and the two compete. On the dragons it is offered 170 to 279 times per 300 days and tops the touch beside it 67 to 129 times (Eldritch Blast over Healing Hands, Aid or Mind Spike over Cure Wounds).

New weights: `w.dropEdge`, `w.dropFrom`, `w.dropRounds`, `w.dropRound`, `w.dropLife`.

**`w.dropFrom`.** Without it, `pDrop` grew from the first point of damage, so every small attack near a healthy caster carried part of its worth and casters stopped closing:
"Caster: 2 Mages + 6 Guards", blind, went from 49.5 to 36. Other weights did not cure that, because the fault is the shape, not the size. At 0.25 the row holds (45, within 2 SE) and the
gains stay (blind D2 81, D3 84, D4 72, D7 81, D8 73); at 0.5 they shrink (77, 83, 72, 78, 71), so 0.25.

**Results** (200 runs, same seeds, ±SE per row, against the rules fix alone; committed party):

| | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | D9 | F1 | F2 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| open, before | 86 | 85 | 81 | 64 | 67.5 | 63 | 58 | 66 | 95 | 50.5 | 1 |
| open, after | 89 | 89 | 89.5 | 67 | 69 | 68 | 72 | 74.5 | 96 | 52.5 | 1 |
| learn, before | 87 | 80 | 79.5 | 65.5 | 59.5 | 50.5 | 63 | 72.5 | 94.5 | 54 | 5 |
| learn, after | 92 | 86.5 | 88 | 73.5 | 66.5 | 57 | 78.5 | 74.5 | 95 | 55.5 | 3.5 |
| blind, before | 84.5 | 64.5 | 73.5 | 68 | 60 | 31.5 | 65.5 | 60.5 | 91.5 | 51.5 | 2.5 |
| blind, after | 89 | 80.5 | 84 | 72 | 68.5 | 38.5 | 80.5 | 72.5 | 90.5 | 51 | 2.5 |

R5-R7 (ally revived included): open 34 → 35, 68.5 → 75, 97.5 → 98.5; learn 31 → 35, 63 → 68.5, 99.5 → 100; blind 21 → 22.5, 56.5 → 60, 98.5 → 99.

All 104 rows per mode: 0 worse beyond 2 SE; 4 better in open, 11 in learn, 12 in blind (means 78.0 → 78.9, 75.5 → 76.8, 70.4 → 71.8). Downed allies healed: learn 82.8 → 84.7%, open 80.5 → 81.5%,
blind 82.1 → 84.3%; bonus-action turns 69.3 → 69.7, 63.3 → 64.0, 70.3 → 72.0; action turns 92.2 → 94.1, 85.5 → 85.6, 92.2 → 92.6. Old-AI logs do not change.

**What it does not do.** It is a price, not a veto. In a set-up scene (Cleric at 12 HP, flying beside an 18-damage foe, the only ally dying below) the touch costs 91 of an ally worth 627, and
still beats the best option that stays up (514 against 466), so it goes down to heal. On Zaki's party against two Young Green Dragons (300 days per mode) going down to an opportunity attack on one's own turn
falls from 111 to 77 and attacks drawn from 503 to 366, but F1's win rate does not move beyond noise (50.5 → 52.5, 54 → 55.5, 51.5 → 51): the chain in the report is rarer, not gone, and
that fight is decided elsewhere.

### Save priors by ability (after a War Table log: Adult Red Dragon, learn)

**What happened.** Learn reads an unseen save at +2 (`kSave`'s prior) whatever the creature. A CR 17 dragon (Str +8, Wis +7) read as +2 on every save, so
Faithwalker cast Entangle (DC 15 Strength) twice, the second time dropping her own Fog Cloud for it, and Juniper cast Dissonant Whispers at 3rd level twice: each
priced as a 60% chance when the truth was 30% or less. The same cause as the Entangle audit above. The threat estimate already carries a save column
(`useSave`), but it is off: one number for all six saves hid the test dragon's weak Wisdom (K2 72.5 → 56).

**The change.** The threat table gets a column per ability (`str`, `dex`, `con`, `int`, `wis`, `cha`): the Library's median save bonus for that
ability by CR group, proficiency included (the parser's `ext.saves` holds all six), forced to rise with CR like the other columns
(`tools/build-threat.js`). `kSave`'s prior for an unseen save is that column at the kind's threat score, so a strong creature reads strong on the saves
strong creatures tend to have, and stays lower on the ones they tend not to. A save with no ability named reads the old `save` column. Evidence works as
before: each save seen pulls the estimate. `AI_BASE.threat.useSave` turns it on, `threat.saveShare` is how far the prior moves from +2 toward the column
(1 = all the way), so a sweep can find a middle if the full reading costs a weak-save row. Learn on v2 only (`threatOn`); blind and open, and the old AI,
do not change.

**Results** (200 runs, same seeds, against the tip before it, all 104 rows; open and blind do not move at any share, by construction):

| learn | worse / better beyond 2 SE | mean | K2 | K8 | T1 | K3 / K5 | B2 / B8 | B9 |
|---|---|---|---|---|---|---|---|---|
| before | | 77.7 | 79 | 60.5 | 79 | 61 | 27 | 17.5 |
| `saveShare` 1 | **3 / 0** | 77.1 | **69.5** | **53** | **69.5** | 55.5 | 25.5 | 15.5 |
| `saveShare` 0.5 (adopted) | 0 / 0 | 77.5 | 78 | 56.5 | 78 | 60 | 24.5 | 15.5 |

The full reading costs the same rows as the old single column did, for the same reason: the test dragons have a Wisdom of −1 where the Library's
strong creatures have about +7, so the party stops trying Wisdom spells it would have found work. Half way passes the gate and is adopted; it gains no
row, and the boss rows lean down by 1–4 points inside the noise.

**On the case that prompted it** (Zaki's level-5 party against the Adult Red Dragon, learn, 200 fights at a 60-ft gap): the party loses every fight in
about two rounds at any setting, so win rates say nothing. Dissonant Whispers into its Wisdom falls from 0.09 to 0.03 casts a fight; Entangle stays at
0.41–0.48 casts a fight. Two reasons it moves so little: in round 1 the dragon has shown nothing, so its score is the party-level prior (about CR 7, Strength
+3.5 at full share), and the top CR group is two monsters, the dragon and the Lich (Strength 0), so even a dragon read as CR 19 has a Strength column
of +5. Entangle's choice rests on its control value against the biggest threat more than on the save. A stronger prior there needs more data or a
different model, not a bigger weight.

**Not done (the user's call).** A name-based prior (a red dragon is fire-immune, a skeleton is weak to bludgeoning) would answer the round-1 Fireball,
but learn has never read a creature's name; it is a design question, not a fix.

### A touch from the air lands on the caster (same log, Niko's Healing Hands)

**What happened.** Niko, flying at 30 ft, planned Healing Hands on a downed ally and healed himself for 5. Not the stay-up option and not a
self-preservation term: `turn` re-aims (`v2Act` → `v2Aim`) before `settleAltitude` brings a flyer level with its target, and `v2Aim` measures reach in
three dimensions, so from 30 ft up the ally on the ground is out of touch and the caster itself is the only creature in reach. With nothing else in
reach it does nothing. A second gap: the planner counted a touch as reachable from any square within flat range, without the movement it takes to come
down, so after a full move there was no movement left to drop. In 300 dragon fights (learn, 60-ft gap) an airborne touch heal ended on the caster 11 times.

**The change.** (a) On v2, a flyer comes level with the creature it planned to touch before it aims again (one `settleAltitude` call, moved forward;
an opportunity attack that drops it there ends the action as before). (b) In `v2TurnInner`, a touch from the air needs `steps + |height to the target|`
within its move; where it does not fit, the square offers its best option that stays up instead (the same `offAt(x, y, false, true)` as the priced touch).
The old AI keeps its order, so its logs do not move.

### Reactions that need an attack roll (rules, same log)

**What happened.** Tacitus's Uncanny Dodge halved a Fire Breath (30 → 15) and Kraax's Deflect Attacks cut Fire Breath and fire rays. In 2024 both need an
attack roll that hits; Deflect Attacks also needs Bludgeoning, Piercing or Slashing damage. The engine fires any damage-cutting reaction on any damage
marked `attack`, and save damage was marked `attack` too (it still is, for "when damaged" triggers). Stone's Endurance has the same shape and rightly
works on any damage, so the engine cannot tell them apart without data.

**The change (rules).** A reaction can carry `ext.react`: `{ roll: true }` (an attack roll that hits) and `types: [...]` (the damage must include one of
them; untyped damage counts, as the engine cannot tell). Attack-roll damage now carries `roll: true` into `damage`. The sheet reader and the class builds
set it on Uncanny Dodge (`roll`) and Deflect Attacks (`roll`, bludgeoning / piercing / slashing); `parties/zaki-party-level-5.json` gets it too, and a
saved workspace is updated by name (`PARTY_FN_UPDATES[13]`). Both AIs' logs move where these reactions met a save or a fire ray.

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

## Pre-fight buffs (morning casts; not part of v2, runs for both AIs)

`opts.prefightBuffs` (War Table: "Pre-fight buffs", default on) is the one switch. At the start of the day, before fight 1, each party caster spends some slots on
spells that last the day. **In:** non-concentration buff spells that last 8 hours or more and help in combat (Aid, Mage Armor, Death Ward).
**Out:** concentration buffs (a pre-fight cast would block the caster's concentration in the fight), anything under 8 hours, and Heroes' Feast
(level 6, an hour to cast, mostly immunities the engine has no use for: the parties are level 4–5). Monsters never cast pre-fight (their statblock assumes prep).

- **Policy.** Each caster ranks what it knows by *expected HP saved over the day per slot level spent*, casts the best, re-ranks (targets have changed),
  and stops when the budget or the eligible targets run out. Each spell once per caster, the lowest slot that works, a real slot. The budget is
  `PREFIGHT.share` (`opts.morningShare`) of the caster's slot levels (slots × level, summed). Plain data in the `PREFIGHT` block next to `morningCasts`.
- **Day length** comes from `leftFor` (open and learn know the real count; blind assumes `BLIND_FIGHTS`; "Fights the party expects today" overrides learn and blind).
- **Value functions** (units: HP saved over the day; `f` = fights from `leftFor`, `PREFIGHT.*` the weights):
  - Aid: the +amt max HP and HP, per target (amt = 5 + 5 per level above 2). Targets: lowest max HP first, up to 3 (+1 per level above 2).
  - Mage Armor: (13 + Dex − current AC) × 5% ÷ `hitP` × `intake` × max HP × f. Only on a target marked `ext.unarmored` whose 13 + `ext.dexMod` beats its AC.
  - Death Ward: min(1, `downP` × f) × `downCost` × max HP. Highest max HP goes first.
- **Effects.** Aid sets `aided` and raises max HP and HP. Mage Armor is a buff (`data.ac` = the difference, duration `entire encounter`) kept in the unit's `dayBuffs` and
  re-applied through `addBuff` after each fight's `resetFightState`. Death Ward sets `deathWard`; `damage` turns the first drop to 0 (a killing blow too) into 1 HP and clears it.
- **Not cast in a fight:** a spell carrying `ext.prefight` is inert in `usable`. Aid keeps its in-fight cast (never on someone who has it).
- **Data.** Mage Armor and Death Ward are in the sheet reader's `CUSTOM` table (same shape as Aid); the sheet reader marks `ext.unarmored` + `ext.dexMod` from
  D&D Beyond and Foundry sheets (no armor worn). Typed/PDF sheets carry no marker, so Mage Armor is never cast for them. The built-in roster has no Mage Armor (its Wizard's AC 15 already counts it).
- **Calibration.** Default share from a sweep over 0 / 0.15 / 0.25 / 0.4 (notes in the commit message and roadmap).

## Not built yet

Half/third casters and Divine Smite (roadmap phase 2), reactions (phase 3), the profile editor UI and a War Table switch (phase 5), lookahead of any kind (never: odds runs
play thousands of fights in the browser). Harness: `node tests/ai-compare.js [runs] [filter]`.
