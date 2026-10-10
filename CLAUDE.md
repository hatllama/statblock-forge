# Notes for working on this repo

- No build step. `index.html` loads classic scripts that share globals; keep the load order
  (vendor/battlesim → data/party.js → js/spell-data.js → js/statblock-parser.js → js/forge.js → js/engine/tactical-engine.js → js/war-table.js).
- `js/statblock-parser.js` and `js/spell-data.js` must stay DOM-free too (tested under Node). When a statblock parses wrong,
  add it to `tests/statblocks/`, check it with `node tests/parse-dump.js <name>`, and add an expectation in `tests/run.js`.
- `js/engine/tactical-engine.js` must stay DOM-free: it also runs under Node in `tests/run.js`.
- After changing engine rules or AI, run `npm test` (checks wall/LoS violations, actors that are dead,
  hidden in plain sight, odds sanity) and play a fight on the War Table to eyeball the replay.
- The averages engine in `vendor/battlesim/` is minified; patches are made by targeted string edits.
  "Exact" mode must stay identical to upstream BattleSim.
- Creature/action extras live under `ext`; BattleSim ignores them. Anything War-Table-only that would
  confuse BattleSim gets `ext.wtOnly`; BattleSim-only stand-ins get `ext.wtSkip`.
- Changing the built-in party: edit `data/party.js`, bump `PARTY_VERSION` in `js/forge.js` and list the
  changed ids in `PARTY_UPDATES` so saved workspaces update.
