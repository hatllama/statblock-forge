# AI roadmap

The plan for the AI decision system. Design details of what exists are in `docs/ai-v2.md`; the rules for anyone
changing the AI are in `CLAUDE.md` ("AI worker rules") and repeated in section D. Read this instead of re-reading old briefs.

## A. Purpose

Statblock Forge is a DM prep tool. The War Table simulates fights and reports odds. The AI should play like a
**competent table, not a perfect solver**. It must be:

- **Competent**: focus sensibly, use the right tool, do not waste resources.
- **Honest**: it knows only what a real side would know (the `k*` accessors).
- **Explainable**: every choice has a "why" line (v2 intent lines).
- **Tunable**: the user can change how it plays (presets, then sliders).
- **Fast**: odds runs execute thousands of fights in a browser, so estimates, never search.

## B. Decisions made

1. **Target is a competent table, not a solver.** Odds that a human table could not reach are not useful to a DM.
2. **Day length.** Learn mode knows the day's true length (total and fights left). A War Table setting "Fights the
   party expects today" (default: exact) can override it. Blind keeps an assumed length, with a better default than 2.
   *Today* (step 2.10) open and learn read the real number of fights left, blind assumes 2 (`BLIND_FIGHTS`), and the War Table setting "Fights the party expects today" (`opts.expectFights`) overrides learn and blind.
3. **Monster smartness belongs to the creature**, not a global toggle: tiers (beast/simple, cunning, genius) with
   defaults from Int and Wis, overridable by `ext.aiProfile`. Beasts play simply, cunning monsters focus fire, geniuses use everything.
4. **Blind stays** as an "ambush / first contact" mode. It is expected to play badly.
5. **User control**: presets plus three or four sliders first (focus fire vs spread, target preference, resource
   spending, risk tolerance). Custom rules only if those are not enough. Existing options (for example how enemies at
   0 HP are handled, `mayHitDowned`) become knobs; saved workspaces are migrated.
6. **Odds runs should be seedable** (see the check below).
7. *(history)* The Legendary Resistance burn plan works in open mode. A burn plan for learn and blind was tried and
   dropped by the user; the probing code stays but is dormant (`burn.modes`, open only: step 2.11 closed the gap where it still ran). Learn and blind assume no Legendary Resistance until one is seen (step 2.9).

## C. Layers

| Layer | Question it answers | Status |
|-------|--------------------|--------|
| Knowledge | What does this side know? | Partial: day length, priors for HP/AC/saves/damage, learn-vs-open gap |
| Strategy | Fight or hold back, spend or save? | Partial: posture, pacing, burn plan |
| Tactics | Where to stand, what to do, at whom? | Done for martials, full casters and (step 3a) half and third casters (`v2TurnInner`) |
| Reactions | Shield, Counterspell, Silvery Barbs, Lucky, Uncanny Dodge, Deflect Attacks, Cutting Words, Stone's Endurance, Spirit Shield: spend now or not? | Done for Zaki's party (step 3b, `docs/ai-v2.md` "Reactions as a layer"): Shield, Silvery Barbs (attack and save), Lucky, Uncanny Dodge, Deflect Attacks, Counterspell, Ready. Not done: Cutting Words, Stone's Endurance scoring beyond `v2ReactOk`, Spirit Shield, Deflect Attacks' redirect |
| Profiles | How does this creature lean? | Data exists (`AI_PROFILES`, `ext.aiProfile`); no UI |
| Explanation | Why did it do that? | Intent lines in v2 (`v2Words`) |
| Evaluation | Did a change make it better? | `tests/ai-compare.js`, `tests/flagoff-hash.js`, `npm test` |

The rules engine (dice, saves, damage, movement, zones) is not AI and is not changed by AI work.

## D. AI worker rules

1. **One currency.** Every option reduces to expected value in the same unit; each new term states what it measures.
2. **Terms, not vetoes.** Add a weighted term; never a special-case rule.
3. **Estimates, not lookahead.** No rollouts, no search.
4. **Other-side facts only through the `k*` accessors**; dice and rules use the real numbers.
5. **Weights and thresholds are plain data in `AI_PROFILES`** (`AI_BASE`); no hardcoded numbers outside it.
6. **Calibrate by outcome.** A behavior change needs a harness scenario with win rate ±SE (200+ runs, same seeds);
   nothing may get worse beyond noise.
7. **Flag-off logs stay identical** (`node tests/flagoff-hash.js`, before and after) until the default switch.
8. **Docs first, then code.** Update `docs/ai-v2.md` BEFORE writing code; keep `npm test` green; bump `?v=` on
   changed script tags; the engine stays DOM-free; Safari-safe syntax; commit with the attribution lines.

## E. Phases

| # | Model | Scope | Done when |
|---|-------|-------|-----------|
| 1 | Opus | **DONE (c6be6fa, 000b8c1).** **Step 2.10.** Part A: why strong control (Hold Monster, Hideous Laughter, Command, Hypnotic Pattern, Stunning Strike) is rarely cast in open mode. Diagnose the score terms (duration with repeated saves, denied actions, crit/advantage for allies, concentration cost counted once, slot price in a fight not being won fast), then calibrate with a sweep of a plain-data control weight. Part B: knowledge ablation, giving the learn/blind party the TRUE value of one thing at a time (HP, AC, saves, damage, day length) to find which gap costs most; implement the day-length decision (B2). | Control scenarios (K) improve beyond SE with nothing worse; ablation table in `docs/ai-v2.md`; day-length setting works |
| 2 | Opus | **DONE (step 3a, see `docs/ai-v2.md` "Hybrids").** **Step 3a: hybrids.** Paladin (Divine Smite per hit, Lay on Hands), ranger (Hunter's Mark), artificer, Eldritch Knight, Arcane Trickster: martial scoring plus spell scoring, one classification (replaces the `casterKind` full-only gate in `v2Eligible`). | Hybrids leave v1; hybrid scenarios no worse than v1 |
| 3 | Opus | **Step 3b: reactions** as a layer with their own decisions and costs. | Reactions chosen by value, not threshold; scenarios no worse |
| 4 | Sonnet | **DONE (opt-in: `opts.ai.foes = 'tiers'`, War Table Enemy AI "Smart, by intelligence"; see `docs/ai-v2.md` "Monster intelligence tiers").** **Monster intelligence tiers**; non-tactical monsters on v2 with a simple profile; Enemy AI default decided here. | Tiers from Int/Wis, `ext.aiProfile` overrides; beast fights look like beasts |
| 4b | Opus | **DONE (opt-in with the tiers; see `docs/ai-v2.md` "Boss tier").** **Boss tier**: monsters with legendary or lair actions, Legendary Resistance or a foe-acting reaction; solo self-care, legendary actions weighed (which and when), lair actions and Legendary Resistance by value, recharge priced, `ext.aiPlan` hints. | Boss tier at least as strong as the old AI and genius on every boss (BOSS family) |
| 5 | Sonnet | **Seeded odds runs** (cheap, see below), then the preset and slider UI per B5, with workspace migration. | Same encounter, same number; old workspaces load |
| 6 | Sonnet | **Default switch to v2**, then removal of the old AI. | Gate below |
| 7 | Opus | **Summons and companions.** Summon spells (skipped in `spell-data.js`) and a companion/summoned-creature model in the engine and spell data; rangers and artificers use it. | Summon spells cast and fought with by v2; companions act on their own turns; scenarios no worse |

**Gate for phase 6:** the harness table is no worse than the old AI in any scenario beyond noise; the user has
watched about ten fights on New (a mix of martials, casters and different monsters) and signed off; `npm test` and
the flag-off hash are clean; time per run is not worse; exports and day files are unchanged.

## F. Evaluation

Harness: `node tests/ai-compare.js [runs] [filter]`; old vs v2 on the same seeds. Rule: **200+ runs, same seeds;
report win ±SE, rounds, deaths, slots spent.**

| Family | Tests |
|--------|-------|
| A1–A8 | Area vs single target (evoker, fireball choices, friendly fire) |
| B1–B9 | Legendary Resistance and learn mode: burn plan, racing, probing, boss HP priors |
| K1–K7 | Control: when Hold Monster / Command etc. should and should not be cast |
| Step 1 martial scenarios | Focus fire, retreat, reckless, positioning, features (Rage, Sneak Attack, Stunning Strike…) |
| Step 2 caster scenarios | Slot pacing, concentration, bonus actions, healing, caster positioning |

**User fight-watching checklist** (War Table replay on New):
- Does it focus fire sensibly?
- Does it waste resources (big slot on a trivial foe, spent on a won fight)?
- Does anyone stand somewhere dumb (in an area, in the open, in melee as a caster)?
- Does it ignore a downed ally it could have helped?
- Does it fight on when it should retreat, or flee when it should fight?

## G. Unverified / open (checked in phase 0, nothing fixed)

| Item | Status | Evidence |
|------|--------|----------|
| Summons and companions | **Doesn't work** | `js/spell-data.js` header: summons are skipped with a note; no summon/companion code in the engine |
| Flee and morale | **Works, v1 rule** | `moraleBreaks` (`morale` option) is a rule independent of the AI; v2 has `posture.retreatHp` but no `fleeHp` yet |
| Hiding and ambush in v2 | **Unknown** | `slipAndHide` and the `hide` mode live in `turn` / `tacticalTurnInner` (v1 code); v2 has a `w.hide` weight but whether a v2 creature hides was not confirmed by a scripted fight |
| Spirit Shield, Ancestral Protectors | **Doesn't work** | no trace in engine, spell data or sheet reader; needs an ally damage-reduction reaction and a "disadvantage on attacks against others" effect |
| Relentless Rage DC counter | **Fixed (cleanup pass)** | counter is `u.uses '__relentless'` (DC 10 +5 each use, `damage` in `js/engine/core.js`); a short rest now clears it (`runDay` in `js/engine/day.js`) |
| Stone's Endurance and similar | **Works in v2 only** | `v2ReactOk` fires a limited cutter by value; the old AI fires by threshold (`attackRoll`); at-will ones (Uncanny Dodge) use the first-hit rule in both |

## Seeding check: can odds runs be seeded?

**Yes, the engine is already deterministic; only the War Table's choice of seed varies.**

- RNG: `makeRng(seed)` in `js/engine/base.js` (mulberry32; `R()`, `R.d(n)`, `R.pick(arr)`), made once per `Sim` from `opts.seed` (`this.R`). There is **no `Math.random` in the engine** (the only two in the repo are id generators in `forge.js` and `sheet-reader.js`).
- `monteCarlo(day, opts, n, baseSeed)` uses `seed = baseSeed + i * 7919` per run; the test harness and the War Table's replay (`startReplay(seed)`) already rely on this.
- The War Table's `runOdds` (`js/war-table.js`) does the same but takes `base = (Date.now() & 0xffffff) + 1`, so each click gives different numbers.
- A seeded run needs: (1) a setting (for example `S.settings.seed`, plus a "fixed seed" switch, default off or on as the user decides) that replaces `Date.now()` in `runOdds`; (2) persisting it in the saved settings (`store.set`); (3) showing the seed next to the odds so a number can be reproduced; (4) nothing in the engine. Per-run seeds come from the run index, so chunking does not matter.
- Caveat: the same number requires the same day, layouts and `simOpts()`; any change to those or to the AI (by design) changes the result.

## Done outside the phases: generic pre-fight buffs

Aid, Mage Armor and Death Ward are cast in the morning from a table (`PREFIGHT_SPELLS`) under one toggle and one slot share (`morningShare`); see "Pre-fight buffs" in `docs/ai-v2.md`. Not built: concentration buffs (they would block the caster in the fight), spells under 8 hours, Heroes' Feast, and monsters casting pre-fight.

## Done outside the phases: downed and dead allies (step 2.12)

A "back in the fight" term for healing a downed ally, Healing Light on v2, Revivify (a death keeps a slot, cast as the fight ends). Audits of Entangle on one foe and Caustic Brew over Chromatic Orb; the Brew's scoring is fixed, Entangle's proposal is below, not built. See `docs/ai-v2.md`.

## Backlog (checked / to add later)

One line each: what, why, which phase takes it. Phase 7 (summons and companions) is in the table above.

- **Summons and companions** (summon spells are skipped in `spell-data.js`; no companion code in the engine): Phase 7. Step 3a left the Artillerist's Eldritch Cannon as an at-will bonus strike while it stands, not a creature.
- **Flee and morale**: tiers read `profile.morale` inside `moraleBreaks` (phase 4); morale itself stays opt-in. v2 still has no `fleeHp`.
- **Lone bosses on v2**: done for the boss tier (phase 4b). Causes found: self-care with no one else holding the line, a parser bug (Arcane/Eldritch Burst read as 5-ft melee: fixed for everyone), and open mode reading a caster's damage as its cantrip (`kDprOpen`, boss only). Genius and the other tiers still read open `kDpr` off the sheet.
- **Open-mode `kDpr`**: done for the party on v2 (`kDprOpen`, `w.dprSeenPC`; docs/ai-v2.md "Open mode reads a caster's damage"). Left: monsters (with casters read right, undead and the 3-fight day dive the back line and lose, so `dprSeen` stays 0 outside the boss tier) and healing against a big hitter not weighed by its DPR the way damage is (why the reading is kept out of `v2Value`). Next AI job on targeting.
- **v2's area aim is weaker than the old AI's** (Adult Red Dragon: 2.4 of the party per breath on v2, 2.9 on the old AI; the boss tier did not change it): next AI job on areas.
- **Costed legendary actions are parsed as recharge** (Ember Burst, Ground Slam): that limits a 2- or 3-cost action to about one use in three rounds, which is not the rule. The boss's recharge price skips legendary actions for that reason. Parser job.
- **Zaki's boss day** (hard-day fights 1-2, then the Ember Tyrant): the boss tier is level with the old AI in blind, 4.7 weaker in learn (1.7 SE) and 8 weaker in open (3.6 SE; level with the old genius Tyrant). Six mostly-melee PCs swarm a lone boss: low self-care and weighed Legendary Resistance each cost a little there, while the four-PC bosses want them. A "surrounded" term was tried and dropped (no gain there, a loss on the four-PC Tyrant). Next boss job.
- **Boss gaps left out on purpose**: legendary moves (the parser drops "movement only" legendary actions), damage reactions such as Searing Retort (no engine rule fires slot-4 attacks), summoners (phase 7), phases beyond what `condition` already gates, a Forge UI for `ext.aiPlan`.
- **Harness note**: the old AI's monsters do read the knowledge mode (`kAc`, `kHp`… in learn and blind); the TIER family's "v1 (any)" row is its open row only. The BOSS family runs v1 in every mode.
- **Hiding and ambush in v2**: UNKNOWN; do a small scripted check before phase 4.
- **Spirit Shield, Ancestral Protectors**: need an ally damage-reduction reaction and a "disadvantage on attacks against others" effect: phase 3.
- **Rising out of reach**: `settleAltitude` at the end of a turn can draw an opportunity attack the search does not price (`altOa` covers touch options only): next AI job on flyers.
- **Lingering-zone gaps**: Flaming Sphere's bonus-action move and ram, Wall of Fire's side damage, Cloudkill drift, foes avoiding a damage zone; the cast-time hit counts as a round's zone hit (a small over-credit): next engine job, foe avoidance with phase 4.
- **Spell data gaps, zones**: Cloud of Daggers, Hunger of Hadar, Create Bonfire, Spike Growth, Sleet Storm: next spell-data job (phase 2 for the casters that use them).
- **Spell data gaps, utility**: Invisibility, Fly, Dimension Door, Dispel Magic, Animate Dead, Plane Shift, Power Word Kill, Scrying, Detect Thoughts, Detect Magic, Light, Mage Hand, Prestidigitation, Thaumaturgy: phase 2 (those with a combat effect), the rest are out of scope.
- **Sheet reader gaps**: Elementalism and other cantrips, Uncanny Metabolism, Fury of the Small: next sheet-reader job.
- **Reactions inside `attackRoll`** (Shield, Silvery Barbs, Lucky): phase 3.
- **Dormant probing code** (learn mode burn was dropped): decide at phase 6 whether to delete it.
- **Stale items**: the comment above `leftFor` disagrees with the code, and `docs/ai-v2.md` step numbering should match these phases (both cleaned up in the repo-cleanup pass); the `v2Eligible` casterKind gate is touched by both phase 2 and phase 4.
- **Roll20 2024 sheets (Niko, Tacitus), read but not modeled**: Cunning Strike (Poison, Trip, Withdraw), Expertise, the Pressurized Flame Squirter's second attack mode (+10, bludgeoning plus fire), Fey Touched free casts (Misty Step, Silvery Barbs once per long rest), Magical Cunning (regain pact slots), the Pact of the Chain familiar, invocations other than Agonizing Blast, Mask of Many Faces free cast, Wood Elf lineage spells (Druidcraft, Longstrider, Pass Without Trace), Fancy Clothes (10 temp HP, +2 AC). All appear as notes on the character.
- **Control multipliers untested**: the Controller (1.25) and Artillery (0.8) control multipliers are not exercised by any scenario; add scenarios when the preset UI is built (phase 5).
- **Harness dragon, true damage lowers win rate**: in the harness dragon (damage scaled to a quarter, full HP), giving the party the TRUE damage per round lowers the win rate. The AI under-values ending a long fight against a weak hitter: revisit.
- **Threat estimate: adopted for learn on v2 in step 2.11** (`docs/ai-v2.md`). The dragons gave back 3–6 points inside 2 SE and the glass cannon still reads 2.4× until bloodied. Hard-day's gain is the opening hits leaving the goblins, not better reading: see "Pacing and danger".
- **Opening hits in blind**: the size prior pulls the first hits onto Small foes while the unseen caster acts (Zaki hard-day 51 → 66.5 by ablation). One term proposed in `docs/ai-v2.md`; not built.
- **Learn's kill leak**: fixed for v2 (step 2.11: the bloodied reading is v2 learn's default). The classic AI keeps the old reading, which writes a creature's exact maximum HP into `hpHi` on a kill, so its logs do not move.
- **Riders into Legendary Resistance**: Stunning Strike and other riders have no LR term in `v2Value`; a rider into LR is valued as if it lands (step 2.11 priced spells only).
- **Limited-use items (Pressurized Flame Squirter)**: the importer reads them as at-will attacks (its item text said 30 ft while the table said 5 ft). Tacitus's Squirter was removed from his actions by hand in the party file. Limited-use items should import as limited-use actions, and its second mode (+10, bludgeoning plus fire) modeled with it.
- **Spell data gaps seen on those sheets**: Light, Prestidigitation, Minor Illusion, Disguise Self, Find Familiar, Lesser Restoration, Daylight, Hunger of Hadar.
- **Learn's save prior on strong bosses**: `kSave` reads an unseen Strength save at +2, so learn casts Entangle on a +6 boss five times as often as open (19% landed). No win-rate cost seen. Proposed in `docs/ai-v2.md`.
- **Revivify, not built**: casting it mid-fight; other classes' builds (Druid, 2024); revival for the old AI. Natural play rarely leaves the caster standing with a slot, because monsters focus healers.
- **Invisibility**: Eldar has it (an action, touch, ends when the target attacks or casts). Needs hide/ambush rules and line-of-sight work (attackers without sight of the target, guessing squares) before it can be an action; not imported.
- **Potions other than healing**: only Healing, Greater, Superior and Supreme are actions now (`POTIONS` in `sheet-reader.js`). Resistance, Speed, Haste-like and breath potions, oils and scrolls stay name-only notes. Foundry VTT inventories do not feed the potion pools yet (D&D Beyond and pasted/PDF sheets do).
- **Counterspell has no engine rule**: it imports as a reaction-slot spell (`ext.counterspell`, War Table only, `wtOnly`) so it shows on the sheet and spends nothing, but nothing fires it. Needs a reaction hook on enemy casts within 60 ft (2024 rule: the caster makes a Con save against the spell save DC or the spell fails, slot not spent), valued like Silvery Barbs in `attackRoll`'s neighbourhood; phase 3 with the other reactions.
- **Spells from Eldar's sheet that do not import** (no combat rules in the spell data): Minor Illusion, Message, Mage Hand, the elven lineage cantrip, Unseen Servant, Disguise Self, Feather Fall, Identify, Find Familiar, Detect Magic, Invisibility (above). Complex enough to want an engine rule first: Green-Flame Blade (weapon attack plus a leap of fire to a second foe), Tasha's Caustic Brew (30-ft line, Dex save, acid each turn while concentrating), Expeditious Retreat (bonus Dash, which v2 would need to price). Elementalism (Kraax's cantrip) also does not import.
- **Spell-name tolerance**: the loose scan of a sheet's whole text (when no spell table is found) still only accepts exact spell names; names with a source label or cut short with an ellipsis are resolved only for spell-table rows and the structured readers.
- **Big creatures: line of sight, cover and area origins**: a Large, Huge or Gargantuan creature covers its whole footprint for occupancy, movement, reach and areas, but line of sight, cover and the origin of a cone, line or aura still use its top-left square. Should use the nearest or any square of the body (5e: a square-to-square line from any corner).
- **Squeezing**: a creature may squeeze through a space one size smaller (moving at half speed, disadvantage on attacks and Dex saves). A Large creature cannot enter a 1-square gap now; `reachMapRaw`/`fits` have no squeeze rule.
- **Tiny creatures sharing a square**: four Tiny creatures may share one square; every creature is treated as taking its own square (`FOOT` gives Tiny 1x1 and `occupant` allows no sharing).
- **Divine Smite under 2014 rules** (no bonus action, any number of hits a turn): step 3a models the 2024 rule only; an `opts.rules.smite` switch like Counterspell's would carry it. Next engine job.
- **Hunter's Mark is not tied to one target**: the engine adds its die to every hit and never moves it when the marked foe drops (a bonus action). v2 prices it as the engine plays it. Next engine job.
- **Lay on Hands' other uses** (curing poison, 5 points a condition) are not modelled; only healing is.
- **Smite on reactions**: a readied strike or an opportunity attack cannot smite (no bonus action off its own turn, rules-correct); 2014's reaction smites would need the 2014 switch above.
- **Eldritch Knight War Magic, Arcane Trickster Magical Ambush / Versatile Trickster**: not imported or modelled.
- **Buffs of the same name stack on allies**: v2 now refuses a self buff whose effect it already has (the ranger's free Hunter's Mark and the spell); two Blesses on one ally are still possible (rules: they do not stack). Next engine job.
- **Pre-move self buffs and the action**: the free Hunter's Mark is taken before moving (`v2Bonus 'pre'`) even on a turn whose action then goes to a heal; harmless (free casts). The pre-move check now weighs bonus attacks, the smite hold and reachable bonus heals, not action-slot plans.
- **Lay on Hands in the last fight**: with no fight ahead a point costs at most half its usual price (as a slot does in a last fight), so the Paladin tops an ally up to half HP or past it in one go (often all 25 points). Consistent with how slots are priced in a last fight; revisit if the table wants it frugal.
- **The Artificer gains nothing from v2** (H3 at 600 runs, noise): its turns were already Shatter, the cannon and Fire Bolt. The cannon as a creature (phase 7) is where it would gain.
