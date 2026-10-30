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
   dropped by the user; the probing code stays but is dormant. Learn and blind assume no Legendary Resistance until one is seen (step 2.9).

## C. Layers

| Layer | Question it answers | Status |
|-------|--------------------|--------|
| Knowledge | What does this side know? | Partial: day length, priors for HP/AC/saves/damage, learn-vs-open gap |
| Strategy | Fight or hold back, spend or save? | Partial: posture, pacing, burn plan |
| Tactics | Where to stand, what to do, at whom? | Done for martials and full casters (`v2TurnInner`) |
| Reactions | Shield, Counterspell, Silvery Barbs, Lucky, Uncanny Dodge, Deflect Attacks, Cutting Words, Stone's Endurance, Spirit Shield: spend now or not? | Not started. They live in `attackRoll` and the old rules; only `v2ReactOk` gates limited damage-cutters |
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
| 2 | Opus | **Step 3a: hybrids.** Paladin (Divine Smite per hit, Lay on Hands), ranger (Hunter's Mark), artificer, Eldritch Knight, Arcane Trickster: martial scoring plus spell scoring, one classification (replaces the `casterKind` full-only gate in `v2Eligible`). | Hybrids leave v1; hybrid scenarios no worse than v1 |
| 3 | Opus | **Step 3b: reactions** as a layer with their own decisions and costs. | Reactions chosen by value, not threshold; scenarios no worse |
| 4 | Sonnet | **Monster intelligence tiers**; non-tactical monsters on v2 with a simple profile; Enemy AI default decided here. | Tiers from Int/Wis, `ext.aiProfile` overrides; beast fights look like beasts |
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
| Relentless Rage DC counter | **Doesn't work as intended** | counter is `u.uses '__relentless'` (DC 10 +5 each use), nothing resets it on a rest (`tactical-engine.js` ~2406) |
| Stone's Endurance and similar | **Works in v2 only** | `v2ReactOk` fires a limited cutter by value; the old AI fires by threshold (`attackRoll`); at-will ones (Uncanny Dodge) use the first-hit rule in both |

## Seeding check: can odds runs be seeded?

**Yes, the engine is already deterministic; only the War Table's choice of seed varies.**

- RNG: `makeRng(seed)` in `js/engine/tactical-engine.js` (mulberry32; `R()`, `R.d(n)`, `R.pick(arr)`), made once per `Sim` from `opts.seed` (`this.R`). There is **no `Math.random` in the engine** (the only two in the repo are id generators in `forge.js` and `sheet-reader.js`).
- `monteCarlo(day, opts, n, baseSeed)` uses `seed = baseSeed + i * 7919` per run; the test harness and the War Table's replay (`startReplay(seed)`) already rely on this.
- The War Table's `runOdds` (`js/war-table.js`) does the same but takes `base = (Date.now() & 0xffffff) + 1`, so each click gives different numbers.
- A seeded run needs: (1) a setting (for example `S.settings.seed`, plus a "fixed seed" switch, default off or on as the user decides) that replaces `Date.now()` in `runOdds`; (2) persisting it in the saved settings (`store.set`); (3) showing the seed next to the odds so a number can be reproduced; (4) nothing in the engine. Per-run seeds come from the run index, so chunking does not matter.
- Caveat: the same number requires the same day, layouts and `simOpts()`; any change to those or to the AI (by design) changes the result.

## Done outside the phases: generic pre-fight buffs

Aid, Mage Armor and Death Ward are cast in the morning from a table (`PREFIGHT_SPELLS`) under one toggle and one slot share (`morningShare`); see "Pre-fight buffs" in `docs/ai-v2.md`. Not built: concentration buffs (they would block the caster in the fight), spells under 8 hours, Heroes' Feast, and monsters casting pre-fight.

## Backlog (checked / to add later)

One line each: what, why, which phase takes it. Phase 7 (summons and companions) is in the table above.

- **Summons and companions** (summon spells are skipped in `spell-data.js`; no companion code in the engine): Phase 7; rangers and artificers touch it in phase 2.
- **Flee and morale**: v1 has `moraleBreaks`, v2 has no `fleeHp`: phase 4.
- **Hiding and ambush in v2**: UNKNOWN; do a small scripted check before phase 4.
- **Spirit Shield, Ancestral Protectors**: need an ally damage-reduction reaction and a "disadvantage on attacks against others" effect: phase 3.
- **Relentless Rage DC counter** never resets on rests: small rules fix, bundle with the next engine job.
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
- **Limited-use items (Pressurized Flame Squirter)**: the importer reads them as at-will attacks (its item text said 30 ft while the table said 5 ft). Tacitus's Squirter was removed from his actions by hand in the party file. Limited-use items should import as limited-use actions, and its second mode (+10, bludgeoning plus fire) modeled with it.
- **Spell data gaps seen on those sheets**: Light, Prestidigitation, Minor Illusion, Disguise Self, Find Familiar, Lesser Restoration, Revivify, Daylight, Hunger of Hadar.
