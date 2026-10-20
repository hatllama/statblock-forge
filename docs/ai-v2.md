# AI v2 — design (step 1 of 4: non-casters)

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
| Slot cost by level and day length | `slotCost` | step 2 (casters): `pacing.slot*` |
| Dash only when it saves a turn | `dashWorthIt` | `w.progress` vs `w.risk` |
| Back line keeps away, hurt creatures play safe (`safetyW` 0.45 / 0.9, ×1.6 hurt) | `tacticalTurnInner` | `w.risk`, `w.riskRanged`, `w.hurt` |
| Only turtle under 40% HP (`canDodge`) | `tacticalTurnInner` | `posture.retreatHp` + `w.dodge` |
| Shooting in melee ×0.6, focus fire 1.5/ally, healer +4, guard +4, finish 12 + DPR/2 | `targetValue` | `w.meleeShoot`, `w.focus`, `w.healer`, `w.guard`, `w.kill` |
| Reaction thresholds (Shield 30% / 60%, Lucky 30%, Silvery Barbs 25%) | `attackRoll` | v1 for now; `react.*` later |
| Teleport away when hurt (regular, < 40%) | `turn` | v1 only (teleports are delegated) |
| TPK kills, surprise rules, climb DC | sim options | rules, not AI |

## Not in this step

Spellcasting (step 2), the profile editor UI and a War Table switch (later), lookahead of any kind (never: odds runs
play thousands of fights in the browser). Harness: `node tests/ai-compare.js [runs] [filter]`.
