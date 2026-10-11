# Notes for working on this repo

- No build step. `index.html` loads classic scripts that share globals; keep the load order
  (data/party.js → js/spell-data.js → js/statblock-parser.js → js/forge.js → js/engine/tactical-engine.js → js/war-table.js).
- `js/statblock-parser.js` and `js/spell-data.js` must stay DOM-free too (tested under Node). When a statblock parses wrong,
  add it to `tests/statblocks/`, check it with `node tests/parse-dump.js <name>`, and add an expectation in `tests/run.js`.
- `js/engine/tactical-engine.js` must stay DOM-free: it also runs under Node in `tests/run.js`.
- After changing engine rules or AI, run `npm test` (checks wall/LoS violations, actors that are dead,
  hidden in plain sight, odds sanity) and play a fight on the War Table to eyeball the replay.
- Exports follow the day save-file format checked by `checkRealSchema` and `validateMonster` in `js/forge.js`;
  keep those checks in step with any format change.
- Creature/action extras live under `ext`; plain exports ignore them. Anything War-Table-only that would
  confuse the export gets `ext.wtOnly`; export-only stand-ins get `ext.wtSkip`.
- Changing the built-in party: edit `data/party.js`, bump `PARTY_VERSION` in `js/forge.js` and list the
  changed ids in `PARTY_UPDATES` so saved workspaces update.
- Browser support: keep to syntax older Safari/iOS can run — no regex lookbehind (`(?<=` / `(?<!`), no `??=`/`||=`, no `structuredClone`.
  One unsupported regex makes the whole script fail to load.
- Every release: bump the `?v=` on the script/style tags in `index.html` so visitors don't keep a cached old copy.
- The Forge UI is one sidebar (`#forgeSide`) and one main panel (`#forgeDynamic`, plus the static `#panelImport` and `#panelFile`).
  What shows is `sel` in `js/forge.js`; every editor listens on `#forgeDynamic`. Creature keys: `'p3'` = party member 3,
  `'2'` = monster 2 of `encounters[activeIdx]`. The War Table calls `renderParty`/`renderMonsters`/`renderPartyBar`; keep those names.
