# Custom mechanics: a pattern library and a small trait vocabulary

Job: model Fiorenzo Minuzzi (`tests/statblocks/fiorenzo.txt`, a CR 14 halfling sniper) **and** make the next statblock with a similar idea
expressible without a new engine feature for each one. Branch `fiorenzo`. Written before any code (Part A); "As built" notes at the end
are filled in as the steps land.

## A1. Audit: what Fiorenzo needs, by kind

Before this job the Forge gave 10 notes on him: First Stake flavour; Halfling Luck, Lucky Seam, Patience, Sniper's Eye "not modelled";
the Suit "already counted in its Armor Class"; Aimed Shot and Call the Shot "nothing the simulator can model; left out"; Stitch Step
"movement only"; the resistance line averaged for the export and played hit by hit on the War Table. The parser did read La Pazienza
(+12, 4d12 + 7, 200 ft) and Fitted Cut (a +3 AC reaction).

| Kind | Fiorenzo's entry | State before | Where / what was missing |
|---|---|---|---|
| (a) a resource that **accrues** from unused action economy at the end of the turn (movement / bonus action / action unused; a burnt action counts as used), capped, and **loses a fraction** when damaged | Patience | **new** | Pools exist (`ext.resources`, `u.uses['res:<name>']`, spent by `usable`/`spend`, reset on rests) but only ever go down, always start full, and nothing records which parts of a turn were used. `u.movedThisTurn` exists (Steady Aim); action and bonus use were turn locals in `turn()`. |
| (b) an action available only on a **precondition** (has the weapon, has not moved this turn) | Aimed Shot | **partly** | `condition` strings (`'is available'`, `'not used yet'`…) are fixed and about the fight, not the turn. `u.movedThisTurn` already means "walked this turn" (Steady Aim reads it; a teleport does not set it). "Has La Pazienza": the engine has no disarm, so the weapon is always on him. |
| (c) an action whose **number of attacks is variable**, paid for by spending a resource | Aimed Shot | **new** | `targets` is a fixed number of swings; `ext.resource` spends a fixed cost to *use* an action, not to buy swings. |
| (d) per-action **attack modifiers**: ignore half and three-quarters cover, no long-range disadvantage, ignore loading | Aimed Shot | **partly** | `ext.ignoreCover` exists but only `saveRoll` reads it (Sacred Flame); `attackRoll` always adds `coverAC`. Long range: the engine never takes a long-range shot (an attack's reach is its normal range), so the disadvantage never arises. Loading: never modelled (every shot is ready), as Pasquale's Trained Shooter note already says. |
| (e) an **action-level coin flip** before the action: heads = the first attack auto-hits, is a critical hit and ignores resistance; tails = the action is burnt, no attack, the resource kept | Call the Shot | **partly** | The coin primitive (`ext.coin`, `coinFlip`) exists for a self-buff bonus action and a reaction; its OUTCOME only carries a buff for the next attack roll, extra damage or a miss. Auto-hit, auto-crit, ignore resistance and "burn the action" are new outcomes; "before an action" is a new place to flip. |
| (f) a **once-per-turn rider tied to one weapon** | Sniper's Eye | **partly** | Riders exist per action (`ext.bolt`, `ext.nearBonus`) and once-a-turn per creature (`followThrough`, `saSeq`), but not "once a turn, on any action that uses this weapon". |
| (g) **reroll a natural 1** on attacks, checks and saves | Halfling Luck | **new** | Nothing rerolls a 1 — not for halfling PCs either (`sheet-reader.js` reads a halfling only for its size; `ext.luck` is the Lucky feat's points; `d20()` knows only advantage and Elven Accuracy). Nothing to reuse; the new rule is written so the sheet reader can set it later (not in this job: it would move party play). |
| (h) "if he fails a save he can choose to succeed" under another name, 3/day | Lucky Seam | **supported, not recognised** | That is Legendary Resistance (`ext.legendaryResistance`, `saveRoll`, `bossLR`, `kLegRes`). The parser only knows it by the name "Legendary Resistance"; the "can reroll it" wording goes to Indomitable. |
| (i) "advantage on saving throws against spells and other magical effects" inside a trait that says other things | the Suit | **partly** | The trait is named in the AC line, so the parser skips it whole ("already counted in its Armor Class") and its advantage is lost. Where the same words are a *Magic Resistance* trait, the parser gives advantage on **every** save (a passive `'Saves with Advantage'` buff; the engine has no "against magic" test). |
| (j) a limited-use **bonus-action teleport** | Stitch Step 3/day | **supported, not recognised** | Misty Step's shape (`ext.teleport: 30` on a bonus self-buff) and v2's `jump` option. The parser drops any "teleports up to" entry as movement only. v2 only considers a jump when engaged or under heavy threat. |
| (k) a Parry-style **"+N AC against that attack"** reaction | Fitted Cut | **supported** | Parsed already (`buff.ac` 3, `'until next attack taken'`); `reactKind` gives `'ac'`, the reaction layer prices it (`reactHitV2`); "only one reaction per round" is `u.reaction`. Nothing to do. |
| (l) *added*: **damage resistance from nonmagical attacks** | the resistance line | **supported** | Hit by hit on the War Table (`dmgModsOf`), averaged for the export. "Ignores any resistance" (Call the Shot heads) must reach this. |
| (m) *added*: **the order of events** | Patience | **new** | Damage taken during his own turn (an opportunity attack on the way, a reaction) halves Patience before the end-of-turn gain; the coin is flipped before Patience is spent, so tails keeps it. |
| (n) *added*: **a prerequisite item** | First Stake | **flavour** | "Without the coin he loses Patience, Call the Shot and Lucky Seam": the War Table has no disarm or theft, so the coin is always on him. Kept as a note. |

## A2. The future-proofing design

Two layers, used in this order: **(i)** the parser recognises a mechanic by what its text *says* and writes plain `ext` data (an existing flag
when one fits, a vocabulary trait when none does); **(ii)** a small declarative vocabulary in the engine, `ext.traits`, carries the mechanics that have
no flag. Nothing is a script: every word is a fixed key the engine knows, checked by a validator that rejects anything else.

### (i) Wording-based recognition: the pattern library

`statblock-parser.js` gets one table, `TRAIT_PATTERNS`, beside the existing `readTrait` chain (which stays as it is, so no existing statblock
moves). Each entry is a plain object:

```js
{ id: 'reroll-ones',            // stable id, used by the tests and the docs
  kind: 'reroll',               // what kind of thing it is (also used for the "looks like" notes)
  where: 'trait',               // 'trait' | 'action' | 'bonus' | 'reaction'
  re: /rolls? a 1 on an? (attack roll|ability check|saving throw)[^.]*?reroll the die/i,
  apply(m, P) { P.trait({ when: 'roll', if: [{ natural: 1 }], do: [{ reroll: 'must' }] }); return 'rerolls a natural 1 …'; } }
```

`apply` gets the match and a small helper `P` (`P.h` the creature, `P.nm` the entry's name and usage, `P.text`, `P.trait(t)` adds a trait to
`h.ext.traits`, `P.resource(name, pool)`, `P.action(a)`, `P.later(fn)` to finish once every action is read, for an entry that names an action
listed after it). It returns the note text, or `false` to let the next pattern try. The table runs **after** `readTrait` has said no (traits) and
before the "has nothing the simulator can model" fallback (actions), and on a trait named in the AC line (the Suit) it runs too, so a trait that
explains the AC *and* says something else keeps both. Adding a pattern is one entry: an id, a kind, a regex on the wording (not the name), and
an `apply` of a few lines; a test in `tests/run.js` ("Pattern library") parses a two-line statblock that uses it.

Patterns this job adds (each with a test): `reroll-ones` (Halfling Luck), `choose-to-succeed` (Lucky Seam → `ext.legendaryResistance` = its
uses, `ext.legResName`), `save-adv-magic` (the Suit → `onSave`/`vs: 'magic'`/`advantage`), `accrue-unused` (Patience: gain per unused part of
the turn, `can hold up to N`, `loses half … rounded up`), `weapon-rider-once` (Sniper's Eye), `aimed-action` (an action that "can take this
action only if … has not moved this turn", "makes one … attack with *W*", "spend any number of *R* to make one additional attack … for each",
"ignores half and three-quarters cover", "no disadvantage from long range", "ignores the weapon's loading property"), `coin-before-action`
(Call the Shot), `bonus-teleport` (a **limited-use** bonus action that only teleports, → Misty Step's shape). A pattern must not match any
existing test statblock or SRD 5.2 monster unless that creature is meant to change: the job checks the whole parse of every one of them before
and after.

**Unknown traits.** When nothing reads a trait, the note keeps "isn't modelled" and adds what kind of thing it looks like and a ready-to-edit
stub, from a second small table (`TRAIT_HINTS`: a regex on the wording → a kind and a stub): *resource* ("gains/loses N *X*", "can hold up to"),
*rider* ("extra N (dice) damage", "when … hits"), *reaction* ("when … is hit / targeted"), *reroll* ("reroll"), *aura* ("within N feet … start of"),
*save advantage* ("advantage on saving throws"), *defence* ("resistance", "AC"), *movement* ("teleport", "moves up to"). Example:
`Trait "Grim Tally" isn't modelled. It looks like a resource; a stub for Custom mechanics: {"when":"onHit","do":[{"gain":{"res":"Tally","n":1,"cap":5}}]}`.

### (ii) The trait vocabulary (`ext.traits`, version 1)

```js
ext.traitsV = 1;                         // the vocabulary version (absent = 1); a higher number is refused with a message
ext.traits = [ { name, when, if: [ … ], once: 'turn' | 'round', optional: true, do: [ … ] }, … ];
```
One trait = one trigger, all its conditions, and its effects in order. `name` is for the log. The engine reads the list once per creature
(`compileTraits` in `base.js`, at `makeUnit`) into `u.traits[when]`, so a creature without traits pays one empty-array test at each hook.
The words, each with a test (`tests/run.js`, "Trait vocabulary"):

**Triggers (`when`)** — where the engine calls the hook (`core.js` / `encounter.js`):
- `turnStart`, `turnEnd` — its own turn (`turn`, `endTurn`; `turnEnd` knows which parts of the turn were used).
- `beforeAction` — one of its own actions is about to resolve (`doAction`); the scope is that action. Effects here change that action only.
- `onHit`, `onMiss` — one of its own attack rolls has hit / missed (`attackOnce`), scope the action and the target.
- `onDamaged` — it took damage (at least 1, before temporary hit points; `damage`).
- `onSave` — it is about to roll a saving throw (`saveRoll`), scope the source's action.
- `roll` — it rolled a d20 for an attack, a save or an ability check (`d20` with the roller passed in).

**Conditions (`if`, all must hold)**
- `notMoved: true` — it has not walked this turn (`u.movedThisTurn`, the Steady Aim flag; a teleport is not a move).
- `has: { res, min }` — the pool `res` holds at least `min` (default 1).
- `action: 'name'` — the scope action is the one named (case-insensitive).
- `weapon: 'name'` — the scope action is that weapon or names it as `ext.weapon` (Aimed Shot shoots La Pazienza).
- `ranged: true|false`, `melee: true|false` — the scope action's reach.
- `natural: n` — the d20 showed `n` (`roll`).
- `rollIs: ['attack', 'save', 'check']` — which d20 (`roll`; default all three).
- `vs: 'magic'` — the effect comes from a spell or a magical source (`a._spell`, `ext.innateSpell`, `ext.magical`) (`onSave`).
- `nthHit: n` — this is its n-th hit on this target this turn (`onHit`).

**Trait options**: `once: 'turn' | 'round'` (at most once in its turn / per round), `optional: true` (the AI decides each time; only for words the AI
scores: `coin`, `extraAttacks`), `name`.

**Effects (`do`, in order)**
- `gain: { res, n, perUnused: ['move', 'bonus', 'action'], cap }` — add `n` (default 1), or `n` for each listed part of the turn left unused
  (`turnEnd` only; a burnt action counts as used); never above `cap` (default the pool's size).
- `lose: { res, n | frac, round: 'up' | 'down' }` — take `n`, or `frac` of what it holds rounded as said (default up).
- `extraAttacks: { pay: res, max }` (`beforeAction`) — one more swing of the action for each point spent; the AI picks how many (0 … what it
  holds, at most `max`).
- `ignoreCover: true`, `noLongRangeDisadvantage: true`, `ignoreLoading: true` (`beforeAction`) — every swing of the action ignores half and
  three-quarters cover (total cover still blocks sight). The last two are accepted and recorded but change nothing: the engine never shoots at long
  range and never models loading (said on the sheet).
- `autoHit`, `autoCrit`, `ignoreResistance`: `'first' | 'all'` (`beforeAction`, or inside a coin outcome) — the first / every swing hits without a
  roll (no hit reactions: there is no roll to change), is a critical hit, its damage ignores resistance (immunity still applies; resistances from
  buffs too, so Rage's).
- `extraDamage: { dice, type }` (`onHit`) — added to that hit (doubled on a critical hit, as weapon dice are).
- `advantage: true` (`onSave`: on that save; `beforeAction`: on the action's attack rolls).
- `reroll: 'must'` (`roll`) — roll the die again and use the new roll (each die of an advantage roll on its own, as Halfling Luck reads).
- `coin: { p, heads: [effects], tails: [effects] }` (`beforeAction`) — a flip on the engine's seeded generator before anything else in the action;
  the outcome's effects run as if listed in `do`. It extends the coin primitive: same `p`, same seeded draw (`coinFlip`'s `this.R()`), same log line,
  with effect lists as outcomes instead of a buff.
- `burn: true` (`beforeAction`, usually a coin's tails) — the action is lost: no swing, nothing paid for later effects in the list, the action
  counts as used.

**Action preconditions**: an action may carry `ext.req: [conditions]` (the same condition words). `usable` refuses it while one fails, so the
AI never plans it then and the export does not care (an action with `ext.req` is `ext.wtOnly`).

**Resources for traits**: an `ext.resources` pool may say `start: n` (it begins each fight with `n`, default full; monsters are rebuilt for every
fight, so Patience starts at 0 each fight) and `reset: 'fight'` (back to `start` at each fight for a creature that lives through the day, a
party member). `uses` stays the pool's size, the cap.

**Validation** (`validateTraits(ext)` in `base.js`, exported as `TacEngine.validateTraits`; the Forge's `validateMonster` calls it, so
`checkRealSchema` does too): every key of a trait, condition and effect must be a known word with a value of the right shape; a resource a word
names must be an `ext.resources` pool (or the message says so); `optional` only on scored words; a version above 1 is refused. Messages read
like the Forge's other warnings: `Trait 2 ("Patience"): unknown effect "gian" (known: gain, lose, …)`. The engine compiles only valid traits
(an invalid one is skipped, never half-run).

**Exports and files**: `ext.traits`/`ext.traitsV` stay in workspaces and day files (they are `ext`, which plain exports ignore, so they load back
on the War Table). Actions whose meaning depends on the vocabulary (Aimed Shot: `ext.req`) carry `ext.wtOnly`, as Pasquale's coin actions do,
so the plain export leaves them out. A creature without the new fields exports byte-for-byte as before.

### (iii) The Forge: "Custom mechanics (advanced)"

A collapsed panel on the creature sheet (`sheetHtml`), under Resources: a textarea holding `ext.traits` as JSON, an Apply button, and the
validator's messages under it. Invalid JSON, an unknown word or a bad value is shown and **nothing is saved** until it is valid; valid traits are
written to the creature and saved with the workspace. The parser's stub notes can be pasted into it. No visual builder. Under the box: one line per
trait saying what the AI does with it (planned / simulated only).

### (iv) What the AI does with a trait it cannot score

Every rule word runs for every creature on the War Table. v2 *scores* only: `extraAttacks` (how many to buy), `coin` before an action (flip or
not), the `gain` of a pool that some `extraAttacks` spends (the "stay still and build" term), `extraDamage` (added to `expected` once a turn on the
weapon it names), `ignoreCover`/`autoHit` (the hit chance of the action's swings). Any other word is simulated but neutral in scoring: v2 plays as
if it were not there. The sheet and the panel say "simulated on the War Table; the AI does not plan for it" for those.

### (v) Pasquale's and Elia's features in the vocabulary (not migrated)

Not migrated: their flags are read in the hot path and a migration is not hash-trivial. How each would be written, as proof of reach:
- **Follow Through** (`ext.followThrough`): `{ when: 'onHit', if: [{ nthHit: 2 }], once: 'turn', do: [{ extraDamage: { dice: '2d6', type: 'bludgeoning' } }] }`.
- **Hold the Door** (`ext.bolt`): `{ when: 'onHit', if: [{ action: 'Stock Strike' }, { has: { res: 'Hammer Bolts' } }], do: [{ extraDamage: { dice: '2d6 + 2d6' } }, { lose: { res: 'Hammer Bolts', n: 1 } }] }` (the action's `dpr` then being the base).
- **Point-Blank Shot** (`ext.nearBonus`): would need one more condition word, `within: 15` (distance to the target). Not in v1.
- **Trained Shooter** (`ext.closeShot`): `{ when: 'beforeAction', if: [{ ranged: true }], do: [{ noCloseDisadvantage: true }] }` — needs that effect word; not in v1.
- **Trained Fighter** (`ext.meleeHitNoOA`): `{ when: 'onHit', if: [{ melee: true }], do: [{ noOpportunityFrom: 'target' }] }` — needs that effect word; not in v1.
- **Double Down** (bonus-action coin): the coin outcome list `{ coin: { heads: [{ advantage: true }, { extraDamage: { dice: '2d8', type: 'force' } }], tails: [{ disadvantage: true }] } }`
  on a `beforeAction` of the *next* attack — needs a "next attack" scope and `disadvantage`; v1 keeps the old shape.
- **Call It in the Air** (reaction coin): needs an `attacked` trigger with a `miss` effect; v1 keeps it on the reaction layer.
- **Chain Bolts** (`ext.bolt.effect.slowHalf`): needs a condition effect on the target (`slow`); not in v1.
- **Push Your Luck** (`ext.pushLuck`): `{ when: 'onMiss', optional: true, do: [{ reroll: 'must' }, { selfDamage: '1d4' }] }` — needs `selfDamage` and an `onMiss` reroll the AI scores; not in v1.
So five of the nine fit v1 as it stands or with one condition word; the other four each need one effect word. That is the shape the next job extends.

### Decisions taken (the conservative option, nothing waiting on the user)
- **Teleport is not a move**: "has not moved this turn" reads `u.movedThisTurn`, the flag Steady Aim already uses, which a teleport (Misty Step,
  the `jump` option) does not set. So Stitch Step then Aimed Shot is allowed, as 5e reads teleportation. The bonus action is still used (one
  Patience fewer).
- **Lucky Seam is Legendary Resistance**: same rule, same AI, same knowledge (`kLegRes`). Because the tier rule (`tierOf`) gives the boss tier to
  any creature with Legendary Resistance, Fiorenzo plays on the boss tier, as any LR creature does; the Smartness select overrides it.
- **La Pazienza stays an action of its own** (it is listed under Actions): after he has moved he can still shoot once, without Aimed Shot's extras.
- **Patience starts at 0 each fight** (the statblock gives no start; monsters are rebuilt per fight anyway).
- **"Spells and other magical effects"**: spells (`a._spell`), innate spells (`ext.innateSpell`) and actions flagged `ext.magical`. Monster actions
  are not magical unless flagged. The existing Magic Resistance passive (advantage on every save) is left as it is: changing it would move SRD play.
- **Halfling Luck for halfling PCs** is not added to the sheet reader or the built-in party in this job (it would move party play and the hashes);
  `ext.traits` makes it one line when wanted.
- **Ability checks** that `roll` covers: the ones the engine rolls for a creature (initiative, escaping a grapple, the climb check).

## A3. Gap analysis: the next mechanics v1 cannot express (backlog)

1. **Auras that change others** (a paladin's +save aura, a frightful aura, "allies within 10 ft have advantage"): needs an `aura` trigger over creatures in range and effects on *others*.
2. **Retaliation** ("when hit by a melee attack, the attacker takes 2d8 fire", Fire Shield): an `attacked`/`onDamaged` effect that damages the source.
3. **Phases and HP thresholds** ("when first bloodied, it…", new actions below half HP): a `bloodied` trigger and an effect that enables/disables actions.
4. **Marks and stacks on targets** ("each hit adds a stack; at three stacks…"): resources that live on the *target*, not the holder.
5. **Interpose / redirect** (a bodyguard takes the hit for an ally, Sentinel-style reactions to an attack on someone else): a trigger on allies' events.
6. **Movement triggers** ("when a creature moves within 10 ft of it", "its speed becomes 0"): a `foeMoves` trigger and a speed effect.
7. **Damage conversion and absorption** ("absorbs fire damage and regains that many HP"): an effect inside `damage` before resistances.
8. **Conditional recharges** ("recharges when it is bloodied", "regains a use when it scores a critical hit"): an effect that resets an action's use.
9. **Effects on the target** (slowed, pushed, prone, a condition without a save as a rider): effect words aimed at the scope target (`slow`, `push`, `condition`).
10. **Distance and position conditions** (`within N ft`, "if no ally is within 5 ft", "while in dim light"): condition words on geometry and light.

## B. As built (branch `fiorenzo`)

Commits of kind B, one per mechanism: the vocabulary and its hooks (`base.js`, `core.js`, `encounter.js`, `d20` knows its roller); the pattern
library and Fiorenzo's parse (`statblock-parser.js`); v2's scoring (`ai-v2.js`, `ai-v2-turn.js`, `knowledge.js`, `AI_BASE.trait`); the Forge
panel. Every hook reads `u.traits`, which is null for every creature without `ext.traits`, so nothing else moves.

**Pattern library**: the eight patterns of A2 (i), each with a test that uses other wording and another name (`tests/run.js`, "Pattern library").
The whole parse of every test statblock and every SRD 5.2 monster was compared before and after: **no data changed**; two notes changed,
the Hydra's "Multiple Heads" (no hint: the hit points it regains are not a pool) and Elparin's charter ("looks like an aura").
**Vocabulary**: as listed in A2 (ii), plus the condition `ownTurn` (Sniper's Eye is "once on each of his turns"); `lose` and `burn` count as
scored (v2 prices a held point's loss and a tails that burns). **Validation**: `validateTraits` (unknown trigger, key, condition or effect,
a value of the wrong shape, a pool that does not exist, a word on the wrong trigger, `optional` on a word the AI does not decide, two words in one
effect, a coin in a coin, a newer version), run by the Forge's `validateMonster` and so by `checkRealSchema`; `compileTraits` skips an invalid
trait whole, and at run time an unknown condition never holds. **Forge**: the panel of A2 (iii), the Resources row's "each fight" reset and
"Starts at", the statblock view's trait lines, Lucky Seam under its own name.

**What Fiorenzo needed that v1 does not say, and how it was handled**: First Stake (the coin can be lost) and the Suit's removal: the War Table
has no disarm, so both stay notes; long range and loading: accepted words with nothing to do (the engine never shoots at long range or models
loading), said on the sheet; Fitted Cut and Stitch Step needed no word (the reaction layer and Misty Step's teleport already do them).

**Weights** (`AI_BASE.trait`): `keep` 0.5, `hitScale` 8, `accrue` 1, `coin` 1, `coinMargin` 0, `wait` false. Calibrated on FIO long, open, 200 runs
(party win; lower = a stronger Fiorenzo): keep 0.9 / 0.6 / 0.45 / 0.3 → 85.5 / 79.5 / 79.0 / 77.0 %; hitScale 4 / 8 / 16 at keep 0.9 → 83.5 / 85.5 /
88.5 %; accrual off → 87.0 %; the `wait` option (do nothing to build) on → 94.0 %, off → 85.5 %, so it is off.

**Hash sets** (recorded on `main` before the first change and compared after every commit): `tests/play-hash.js` default, `KNOW=open|learn|blind`,
`PREFIGHT=0`, and `tests/fixtures/hashes-learn.txt`: **identical**. The 12-run BOSS + TIER table: identical in every column but `ms`.
`npm test` 877 → 993 checks (+116: vocabulary 54, pattern library 28, Fiorenzo on the War Table 23, smoke 11). Run time: `node tests/run.js`
on `main` (an exported copy) and on the branch, alternating: 108 / 108 s against 108 / 107 s.

**Scenario** (`node tests/ai-compare.js 200 '^FIO'`, Zaki's party, party and Fiorenzo on v2 with the row's knowledge; per fight; "plain" = no
traits, no Aimed Shot, Stitch Step or Lucky Seam):

| block, mode | as written | plain | no coin | no patience | as written: Fio dmg, Aimed Shot swings, Patience gained / lost / spent, flips, Stitch Steps, Lucky Seams |
|---|---|---|---|---|---|
| 78 HP, open | 100.0 | 100.0 | 100.0 | 100.0 | 82, 0.1, 3.2 / 3.0 / 0.1, 0.00, 1.3, 0.5 |
| 78 HP, learn | 99.5 ± 0.5 | 100.0 | 99.5 | 100.0 | 106, 0.3, 3.7 / 3.5 / 0.2, 0.00, 1.3, 1.3 |
| 78 HP, blind | 100.0 | 100.0 | 100.0 | 100.0 | 129, 0.5, 4.6 / 4.1 / 0.3, 0.00, 1.7, 1.4 |
| 234 HP, open | 79.5 ± 2.9 | 100.0 | 79.0 ± 2.9 | 89.5 ± 2.2 | 368, 3.1, 14.3 / 11.8 / 1.8, 0.01, 2.8, 0.9 |
| 234 HP, learn | 77.5 ± 3.0 | 99.5 ± 0.5 | 77.0 ± 3.0 | 86.5 ± 2.4 | 377, 2.3, 14.2 / 12.2 / 1.2, 0.03, 2.9, 1.2 |
| 234 HP, blind | 80.5 ± 2.8 | 100.0 | 80.5 ± 2.8 | 86.5 ± 2.4 | 354, 3.1, 14.2 / 12.0 / 1.6, 0.00, 2.8, 1.4 |

Reading it: as written he lasts 2.7–3.7 rounds at 78 HP and deals 82–129 a fight (24–63 plain); six characters focus him, so the party always
wins. With three times the HP his custom mechanics take the party from 99.5–100 % to 77.5–80.5 %, and Patience alone is worth 6–10 points of that
(the "no patience" arm). He gains about 14 Patience in a long fight and loses 12 of them to damage: with six attackers he rarely starts a turn holding
any, so Aimed Shot buys about one swing a fight. Call the Shot is almost never flipped (0.00–0.03 a fight) and "no coin" equals "as written":
against these characters (AC 11–16, 28–43 HP) a plain shot nearly always hits and nearly drops its target, so heads adds little and tails loses the
turn; v2 flips against a target with high AC, resistance and many hit points (`tests/run.js`), which this party does not have.

**In the replay** (War Table, the default party, one fight): he shoots La Pazienza with Sniper's Eye, gains 2 Patience a turn and loses them to the
next hits, Stitch Steps away when the Fighter closes in, spends a Lucky Seam on a Hold Person the Bard's Cutting Words turned into a fail, and his
Halfling Luck rerolls a natural 1 on a save; nothing looked wrong. One thing that looks odd but is the rules: after Stitch Step he can still take
Aimed Shot (a teleport is not a move).
