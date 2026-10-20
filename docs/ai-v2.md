# AI v2 — design (step 1 of 4: non-casters)

The old tactical AI is a priority list (`choose`) wrapped in a square search with special cases
(`tacticalTurnInner`) and per-action vetoes. v2 replaces the *decision* for one creature's turn with three
separate layers. Rules, dice and turn mechanics are untouched: v2 only decides, and the existing turn code
carries the decision out.

## Where v1 and v2 meet

- Turned on per run with `opts.ai = 'v2'` (beside `partyAI`, `know`, `morale` in the sim options). Default is
  the old AI.
- Switch point: per creature, decided once at the start of each fight (`v2Eligible`), so one fight mixes them.
  A creature uses v2 when the flag is on, it has **no spellbook** (no slots, no spell list), and it either
  plays `tactical` (the whole party by default) or names a profile in `ext.aiProfile`. Everything else
  (casters, `regular`/`beast` monsters without a profile) keeps the old AI.
- Delegated to v1 for the whole turn: creatures with actions v2 can't score yet — bonus-action teleports
  (`ext.teleport`), zones/fog (`ext.zone`), swallowing, heals or buffs aimed at allies. Paladin smite is a spell
  (Divine Smite sits in the spellbook), so paladins stay on v1.
- In `turn()` v2 takes over these decisions: the pre-move bonus action (Rage…), the move + action plan
  (`v2Plan`, same result shape as `tacticalTurnInner`), Reckless Attack, Steady Aim, the post-move bonus action,
  the re-aim after moving, Action Surge (`v2Surge`), and limited damage-cutting reactions (`v2ReactOk`, called from
  `damage()`; v1 always says yes, as before).

## Layer 1 — posture (a small decision tree, `v2Posture`)

Read top to bottom; first match wins. `hp` = own HP fraction, thresholds come from the profile (`P.posture`).

| posture   | when | what it changes |
|-----------|------|-----------------|
| `retreat` | `hp ≤ retreatHp` and the danger where it stands ≥ `retreatDanger` × its HP | safety weight × `retreatSafety`, offense × 0.5, Disengage/Dodge allowed |
| `recover` | `hp ≤ recoverHp` and a self-heal is usable (Second Wind) | heal options get `recoverBonus` |
| `finish`  | a foe it can reach this turn is expected to drop (`expected ≥ kHp`) | kill term × `finishBoost` |
| `protect` | (melee only) a foe is next to a squishy ally (no melee, or under `protectAllyHp`) | that foe gets `protectBonus` × its DPR |
| `focus`   | a reachable foe is a caster/healer, or squishy (`kMax ≤ squishyHp` of own max HP) | that foe gets `focusBonus` |
| `advance` | nothing reachable this turn | movement terms decide (Dash vs. careful approach) |
| `engage`  | otherwise | plain scoring |

The posture writes the replay's `intent` lines ("Monk goes for the caster, Mage", "Barbarian falls back, badly
hurt", "Fighter steps in to protect Wizard from Ogre"…).

## Layer 2 — utility scoring (`v2Plan`)

Every legal option = (mode, action, target, square). Modes: `act`, `bonusDis` (Cunning Action), `actionDis`,
`dodge`, `dash`, `hide`. Score = weighted sum (weights `P.w`), all other-side facts through `k*` accessors:

- **damage** — `expected()` capped at `kHp + 4`, × `(1 + kDpr/dprScale)`: hurting dangerous things matters more.
- **kill** — chance it drops the target this turn (smooth step on expected vs `kHp`) × `(kDpr × killRounds + 5)`.
- **control** — riders and debuffs: chance to land × `effectValue` (Stunning Strike, Sap, push off an ally).
- **focus** — allies already on the target, how hurt it looks (`kFrac`), healers/casters (`kHeals`, `kCaster`).
- **posture fit** — the posture's target or mode bonus.
- **bonus** — the best bonus-action attack possible from that square (keeps the Monk in reach of Flurry).
- **risk** — expected damage at the square next round (`kDpr`/`kReach`/real attacks in open mode), × hurt factor.
- **oa** — opportunity attacks along the path. **spacing** — bunching up against known area attacks (`kAreas`).
- **resource** — the pacing cost (layer 3). **move** — a small cost per step. **progress** — feet gained toward
  the nearest target when it can't attack (decides Dash vs. walk + Dodge; Dodge is only worth the threat it stops).

Martial features, all scored: **Rage** (pre-move bonus: rage damage × expected melee hits for the rounds the fight
should last + resisted physical damage, minus pacing), **Reckless Attack** (each turn: extra hits from advantage vs.
extra hits it takes; applied as a 1-round buff, so it can be switched off), **Sneak Attack** (inside `expected`,
plus the ally-adjacent target bonus), **Cunning Action** (Disengage/Hide modes), **Steady Aim** (when standing
still and no advantage), **Action Surge** (bonus-slot "Action Surge" attacks and `ext.extraAction` surges, paced),
**Stunning Strike**, **Flurry of Blows**, **Focus Points / any `ext.resource` pool**, **Patient Defense**,
**Second Wind**, **Stone's Endurance / Uncanny Dodge / Deflect** (limited ones only on a hit worth it).

## Layer 3 — resource pacing (`v2PaceCost`)

For a limited use (per-rest uses, `ext.resource` pools, 1/day): fights still to come `F` (`leftFor`; 0 for
monsters; 0 for short-rest pools when `restBeforeNext`), share for this fight `L/(F+1)` of what's left. Cost of one
use = `costPerUse × own DPR × F/(F+1)`, × `overBudget` once this fight has used its share, × `easyFight` when the
fight is in hand (`fightInHand`), × `losing` when it's going badly (`losing`). Last fight of the day: `lastFight`.
At-will and recharge abilities cost nothing. `notePacing` still logs the "saving it for later" line.

## Settings object (`AI_PROFILES`, `TacEngine.aiProfile`)

Plain, serializable: `{ posture: {...thresholds}, w: {...weights}, pacing: {...}, finishDowned, reckless }`.
Presets: `balanced` (default), `aggressive`, `cautious`, `protector`, `assassin`, `berserker`, `skirmisher`; each is
`balanced` plus a few overrides. A creature picks one with `ext.aiProfile` (a preset name, or
`{ base: 'name', ...overrides }`). Like `ext.ai`, it lives under `ext`, which plain exports ignore; the day format
does not change. No numbers live outside this object.

## Existing user-facing AI options → v2 knobs

| today | where | v2 knob |
|-------|-------|---------|
| "The party plays" tactical / regular | War Table `partyAI` | v2 replaces `tactical`; `regular` stays v1 (later: a `byTheBook` profile) |
| "Fights like" tactical / regular / beast | Forge + War Table `ext.ai` | `ext.aiProfile`; beast ≈ `berserker` + `finishDowned:'maul'` |
| Knowledge: open / blind / learn | `know.party`, `know.foes` | unchanged: v2 reads only `k*` accessors |
| Monster morale | `morale` | unchanged (rule); later `posture.fleeHp` |
| When grappled: smart / always / never | `escapePolicy` | unchanged (v1 turn code) |
| Downed PCs as targets (beast 5% maul, regular after 2 revivals, tactical after 2nd down) | `mayHitDowned` | `finishDowned: 'never' / 'second-down' / 'always'` |
| Party saves big resources when the fight is in hand | `holdsResource`/`fightInHand` | `pacing.easyFight`, `pacing.costPerUse` |
| Slot cost | `slotCost` | (step 2: casters) `pacing.slot*` |
| Dash only when it saves a turn | `dashWorthIt` | `w.progress` vs `w.risk` |
| Back line keeps away, hurt creatures play safe (`safetyW`) | `tacticalTurnInner` | `w.risk`, `w.hurt` |
| Turtle only under 40% HP (`canDodge`) | `tacticalTurnInner` | `posture.retreatHp` |
| Reaction thresholds (Shield 30%/60%, Lucky 30%, Silvery Barbs 25%) | `attackRoll` | v1 for now; `react.*` later |
| Teleport away when hurt (regular, < 40%) | `turn` | v1 only (teleports delegated) |
| TPK kills, surprise, climb DC | sim options | rules, not AI |

## Not in this step

Spellcasting (step 2), the profile editor UI (later step), lookahead of any kind (never: odds runs play thousands of
fights in the browser).
