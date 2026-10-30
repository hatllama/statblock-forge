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
  likely to stay up. `R` is the fight's expected remaining length. A condition that makes the foe easier to hit
  (Paralyzed, Stunned…) also counts our side's extra damage against it (`v2Expose`, step 2.10 below). A disabling condition on a creature with Legendary
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

**Valuation.** In race mode, `v2Control` is unchanged: a disabling effect on a creature with LR left is worth `legRes`
(0.2) × its normal value. In burn mode, for a burner and the effect the plan picked for it, the effect is worth what the
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
- **Day length** comes from `leftFor` (the open mode knows the real count; blind/learn assume 2).
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
