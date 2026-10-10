# Statblock Forge

A D&D 5e encounter-prep workshop that runs entirely in the browser. It has three views:

- **Forge** turns monster statblocks and character sheets into [BattleSim](https://github.com/Trekiros/battleSim)-compatible JSON. Pasted statblocks are read by a built-in parser with no AI and no network: 2014 and 2024 layouts, D&D Beyond and 5etools copy-pastes, and Homebrewery markdown. Claude can optionally be used instead with your own API key. It has a visual editor, spellbooks with slots, six saving throws, terrain-aware ranges, and an autosave.
- **Simulate** plays a whole adventuring day with BattleSim's averages engine, extended with spell lists, slots and real saving throws.
- **War Table** is an original tactical engine. It plays every fight out with real dice on a grid that has walls, high ground, difficult terrain, cover and fog. Party and monsters use a tactical AI, and you can run the odds over hundreds of fights or replay any single one turn by turn.

There's no build step and there are no dependencies. Open `index.html` directly or serve the folder.

## Running it

```bash
# any static server works; for example
python3 -m http.server 8000
# then open http://localhost:8000
```

Double-clicking `index.html` also works.

Run the engine checks with Node 18 or newer:

```bash
npm test
```

## Layout

```
index.html                     page markup, loads the scripts below in order
css/styles.css                 all styling
data/party.js                  the built-in party (PARTY_PLAYERS) + nothing else
js/spell-data.js               combat spells the parser knows (damage, saves, areas, conditions)
js/statblock-parser.js         statblock text → Forge creatures, no AI (exposes StatblockParser)
js/forge.js                    Forge + Simulate views: parsing, editor, validation, export, autosave, migrations
js/engine/tactical-engine.js   War Table engine (pure JS, no DOM) — exposes TacEngine
js/war-table.js                War Table UI: board, terrain painting, odds, replay
vendor/battlesim/              modified build of BattleSim's averages engine — exposes BattleSimEngine
tests/run.js                   engine checks (wall/LoS violations, dead or hidden-in-plain-sight actors, odds sanity)
tests/fixtures/                sample adventuring days used by the tests
tests/statblocks/              statblocks in different formats the parser is tested on
tests/parse-dump.js            `node tests/parse-dump.js [name]` shows what the parser makes of them
```

The scripts are plain classic scripts that share globals, and the load order in `index.html` matters:
BattleSim engine → party data → spell data → statblock parser → forge → tactical engine → war table.

## Where things live

| You want to change | Look in |
|---|---|
| How pasted statblocks are read | `js/statblock-parser.js` (header, sections, attacks, save effects, multiattack, traits, spellcasting) and `js/spell-data.js` for spells. Add a sample to `tests/statblocks/` and run `npm test` |
| The built-in party | `data/party.js`. Bump `PARTY_VERSION` and add the ids to `PARTY_UPDATES` in `js/forge.js` so saved workspaces pick up the change |
| Editor fields for actions and creatures | `js/forge.js`, around `actionEditor`, `mechanicsPanel` (War Table fields) and `handleFieldChange` |
| Validation and BattleSim export | `js/forge.js`, around `validateMonster`, `exportCreature`, `compileSpellbook` |
| How War Table creatures choose what to do | `js/engine/tactical-engine.js`, especially `tacticalTurnInner` (where to stand), `optionValue` / `rankSpells` (which spell), `targetValue` (who to hit) |
| Rules: attacks, saves, damage, conditions | `js/engine/tactical-engine.js`: `attackRoll`, `saveRoll`, `damage`, `addBuff` |
| Board drawing and replay | `js/war-table.js` |

Extra data that BattleSim doesn't know about goes in an `ext` object on creatures and actions, such as ranges, areas, saves, spellbooks and on-hit effects. BattleSim ignores it, and `exportCreature` strips or compiles it for the BattleSim export.

## Saved data

The workspace autosaves to `localStorage` under `forge-workspace-v1`, per browser and per domain. Moving the site to a new address starts with a fresh workspace, so export a JSON from the old copy and import it into the new one.

## Credits and licence

- War Table engine, Forge and UI: written for this project.
- `vendor/battlesim/` is a modified build of **BattleSim** by Trekiros, licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). See `vendor/battlesim/NOTICE.md`.
