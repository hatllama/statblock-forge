# Notes for working on this repo

- No build step. `index.html` loads classic scripts that share globals; keep the load order
  (data/party.js → data/srd-monsters.js → js/spell-data.js → js/statblock-parser.js → js/sheet-reader.js → js/forge.js → js/engine/tactical-engine.js → js/war-table.js).
- `js/statblock-parser.js`, `js/spell-data.js` and `js/sheet-reader.js` (character sheets → party members; samples in `tests/sheets/`) must stay DOM-free too (tested under Node). When a statblock parses wrong,
  add it to `tests/statblocks/`, check it with `node tests/parse-dump.js <name>`, and add an expectation in `tests/run.js`.
- `js/engine/tactical-engine.js` must stay DOM-free: it also runs under Node in `tests/run.js`.
- AI knowledge modes (`opts.know = { party, foes }`: open / blind / learn): the AI reads other-side facts only through
  the `k*` accessors (`kHp`, `kMax`, `kDpr`, `kAc`, `kSave`, `kMult`, `kHeals`, `kAreas`, `kReach`, `kCaster`, `kLegRes`, `leftFor`). New AI
  code that looks at an enemy's hp, AC, saves, resistances, actions or the day's length should go through them too;
  dice and rules keep using the real numbers.
- After changing engine rules or AI, run `npm test` (checks wall/LoS violations, actors that are dead,
  hidden in plain sight, odds sanity) and play a fight on the War Table to eyeball the replay.
- Exports follow the day save-file format checked by `checkRealSchema` and `validateMonster` in `js/forge.js`;
  keep those checks in step with any format change.
- Creature/action extras live under `ext`; plain exports ignore them. Anything War-Table-only that would
  confuse the export gets `ext.wtOnly`; export-only stand-ins get `ext.wtSkip`.
- The built-in party and the class roster (`CLASS_BUILDS`, one level-5 build per class) are generated: edit
  `tools/build-party.js`, run `node tools/build-party.js` (rewrites `data/party.js`), then bump `PARTY_VERSION` in
  `js/forge.js` and list changed ids in `PARTY_UPDATES` so saved workspaces update. Zaki's own party lives in
  `parties/zaki-party-level-4.json` (load it with Day file → Load just the party).
- The official monsters in the Library (`data/srd-monsters.js`, `SRD_MONSTERS`) are generated from SRD 5.2 data by
  `tools/build-srd.js` (see its header for the 5e-database clone). Only SRD 5.2 monsters, never other books; keep the
  CC-BY attribution (`SRD_ATTRIBUTION`, the footer) wherever they appear. They are parsed by the statblock reader when
  added, so parser changes apply to them; `tests/run.js` checks they all parse and fight.
- Browser support: keep to syntax older Safari/iOS can run — no regex lookbehind (`(?<=` / `(?<!`), no `??=`/`||=`, no `structuredClone`.
  One unsupported regex makes the whole script fail to load.
- Every release: bump the `?v=` on the script/style tags in `index.html` so visitors don't keep a cached old copy.
- The Forge UI is one sidebar (`#forgeSide`) and one main panel (`#forgeDynamic`, plus the static `#panelImport` and `#panelFile`).
  What shows is `sel` in `js/forge.js`; every editor listens on `#forgeDynamic`. Creature keys: `'p3'` = party member 3,
  `'2'` = monster 2 of `encounters[activeIdx]`. The War Table calls `renderParty`/`renderMonsters`/`renderPartyBar`; keep those names.

## Where things live
Files are huge: `grep -n "function name"` (or `Sim.prototype.name`) and read just that range, never the whole file. Names are anchors, not line numbers.
- `tactical-engine.js` rules: `Sim.prototype.usable`/`spend` (uses, pools, recharge), `saveRoll`/`saveBonusFor`, `attackRoll`, `damage`, `moveAlong`, `settleAltitude` (flyers), `doAction` (resolves one action).
- `tactical-engine.js` areas: `areaSpec` → `areaCells` → `inArea` (top of file, plus `TEMPLATES`).
- `tactical-engine.js` lingering spells: a spell with `ext.zone.dmg` (Spirit Guardians, Moonbeam, Wall of Fire…) leaves a zone that hurts on `zoneTick` (start of a creature's turn) and `zoneEnter` (after a move), once a round each, via `zoneHit` → `resolveAttackAction`; `ext.zone.follow` moves it with the caster, `ext.hold` is its length in rounds (`expireZones`), `ext.sustain` (Moonbeam, Call Lightning, Sunbeam) lets the caster re-use it free (`sustaining`). Flag a new one in `spell-data.js`, then rebuild the party.
- `tactical-engine.js` turn flow: `turn` → `tacticalTurnInner` (movement + action plan) → `choose` (pick an action per slot) → `plan`/`planInner` (target + position scoring); `surge` is the action-surge style extra action; `runDay` is the whole-day loop.
- `tactical-engine.js` AI v2 (`opts.ai = 'v2'` or `{ party: 'v2' }`; non-casters and full casters, `casterKind` decides — half/third casters stay v1; design in `docs/ai-v2.md`): the "AI v2" block — `AI_BASE`/`AI_PROFILES` (every weight and threshold; `ext.aiProfile` picks one), `v2Setup`/`v2Eligible` (who uses it, per fight), `v2Posture`, `v2Value`/`v2SelfValue`/`v2AllyValue`/`v2Control` (what an option is worth), `v2Holding` (running concentration), `v2FF` (friendly fire), `v2TurnInner` (squares × options incl. each spell at each slot level via `v2CastLevels`/`castCopy`, and the Misty Step `jump` mode), `v2Aim`/`v2AimValue`/`v2Act` (re-aim after moving), `v2Bonus`, `v2Reckless`, `v2Surge`, `v2Pace` (pacing; spell slots as one pool of slot levels, `v2Recovery`), `v2ReactOk`, `v2Words` (intent lines), `v2Burn`/`v2BurnPlan` (Legendary Resistance: burn it with cheap control or race the boss's HP; `AI_BASE.burn`, `controller` leans burn, `artillery` race; `burn.bias` 0 = off; a burner's effect is lifted in `v2TurnInner`, the monster spends LR in `saveRoll` only on disabling/high-damage effects). `kLegRes` is the party's count: real in open; blind/learn assume 3 on a Huge+ body until it fails a dangerous save with none (`legNone`). The slot level v2 picks reaches `spend` through `u.castAt`. `turn` branches on `u.v2`; with the flag off the old AI plays exactly as before (check: `node tests/flagoff-hash.js` before and after a change, the output must match). New v2 behaviour = a weight in `AI_BASE` + a term, not a veto. Compare with `node tests/ai-compare.js [runs] [filter]` (old vs v2 tables, not part of `npm test`).
- `tactical-engine.js` knowledge: `kMax`, `kHp`, `kDpr`, `kAc`, `kSave`, `kMult`, `kHeals`, `kAreas`, `kReach`, `kCaster`, `kLegRes`, `leftFor`, `learnSave` (the "WHAT EACH SIDE KNOWS" block).
- `forge.js` validation/format: `validateMonster`, `checkRealSchema`, `buildDayObject` (export), `exportCreature`, `applyWorkspace`/`loadWorkspace`.
- `forge.js` UI: `renderSide` (sidebar), `sheetHtml` (creature sheet), `actionEditor` + `freqFields` (action editor), `handleFieldChange` (all field edits), `resourcesPanel`/`onResourceField` (pools).
- `forge.js` imports: `onSheetFile` → `readSheet` (character sheets; `readSheetWithClaude` for the PDF/AI path); `forgeOne` (Claude API statblock converter).
- `statblock-parser.js`: `parseOne` (one block → creature; the `rank` const inside it orders actions), `readMultiattack`/`comboAction`, `readSaveEffect`, `areaInfo`.
- `sheet-reader.js`: `fromDDB`/`fromFoundry`/`fromText` → facts → `build`; `classFeatures` adds per-class actions; `CUSTOM` holds spells the spell data lacks.
- `war-table.js`: `simOptsFor` (sim settings per encounter), `renderSetup`, `renderInspect`, odds (`runOdds`/`renderOdds`/`drawHist`), replay (`startReplay`/`showFrame`/`play`/`animateEvent`).
- `tests/run.js` is one script of `section('…')` blocks (the rule checks per AI incl. v2, area templates, terrain, flying, parser, class roster, knowledge modes, SRD monsters, character sheets, AI v2). Fixtures: `tests/statblocks`, `tests/sheets`, `tests/fixtures` (day files).

How to:
- Add a spell the spell data lacks: add an entry to `CUSTOM` in `sheet-reader.js` (same action shape as `misty step`); `build` uses it when `SD` has no entry.
- Pooled resource: the creature declares pools in `ext.resources`; an action draws on one via `ext.resource` (pool name) and `ext.resourceCost` (default 1). The engine checks/spends it in `usable`/`spend` (`u.uses` key `res:<name>`); the Forge edits it in `resourcesPanel`.
- Add a class feature to the sheet reader: add an `if (classLevel) { add({...}); ext.x = … }` branch in `classFeatures` (use `lv`/`sub`), then add a sample under `tests/sheets` and an expectation in the "Character sheets" section of `tests/run.js`.
