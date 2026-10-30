# Statblock Forge

A D&D 5e encounter-prep workshop that runs entirely in the browser. It has two views:

- **Forge** is the workshop where the party and the day's encounters are built. A sidebar lists the party and each encounter; the main panel shows the selected creature as an editable sheet, a roster of ready-made level-5 characters for every class (or a printable statblock), an encounter page with quick odds, a library of saved creatures and official SRD 5.2 monsters, the statblock importer, or save & load. Pasted statblocks are read by a built-in parser with no AI and no network: 2014 and 2024 layouts, D&D Beyond and 5etools copy-pastes, and Homebrewery markdown. Claude can optionally be used instead with your own API key. Everything autosaves; days can be downloaded and loaded as JSON.
- **War Table** is an original tactical engine. It plays every fight out with real dice on a grid that has walls, high ground, difficult terrain, cover and fog. Party and monsters use a tactical AI, and you can run the odds over hundreds of fights or replay any single one turn by turn; click any token to see its hit points, height, conditions, effects and what it has left. Each side's AI can know every number (open info), only what's visible at the table (black box), or learn as it goes (AC from hits and misses, saves, hit points, resistances, healers, area attacks), and monsters can be set to flee or surrender when a fight turns.

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
npm test                # engine, parser, sheet reader and AI checks
npm run compare         # old AI vs AI v2 tables (tests/ai-compare.js [runs] [filter])
npm run flagoff         # hashes of classic-AI fight logs; must not change after an AI change
npm run build-party     # regenerate data/party.js
npm run build-srd       # regenerate data/srd-monsters.js
npm run serve           # static server for the app at http://localhost:8080
```

## Layout

```
index.html                     page markup, loads the scripts below in order
css/styles.css                 all styling
data/party.js                  generated: the level-5 class roster (CLASS_BUILDS) and the default party (PARTY_PLAYERS)
tools/build-party.js           builds data/party.js: `node tools/build-party.js`
data/srd-monsters.js           generated: official monsters from the SRD 5.2 (CC-BY-4.0)
tools/build-srd.js             builds data/srd-monsters.js from the 5e-database SRD data
parties/                       saved parties to load (Day file → Load just the party)
js/spell-data.js               combat spells the parser knows (damage, saves, areas, conditions)
js/statblock-parser.js         statblock text → Forge creatures, no AI (exposes StatblockParser)
js/sheet-reader.js             character sheets (D&D Beyond, Foundry, text/PDF) → party members
js/forge.js                    Forge view: workshop UI (sidebar, sheet, statblock, encounter page, quick odds, library), editor, validation, export, autosave, migrations
js/engine/tactical-engine.js   War Table engine (pure JS, no DOM) — exposes TacEngine
js/war-table.js                War Table UI: board, terrain painting, odds, replay
tests/run.js                   engine and parser checks (wall/LoS violations, dead or hidden-in-plain-sight actors, odds sanity)
tests/ai-compare.js            old AI vs v2 win-rate tables (not part of npm test)
tests/flagoff-hash.js          flag-off regression hashes
tests/sheets/                  character sheets the sheet reader is tested on
tests/fixtures/                sample adventuring days used by the tests
tests/statblocks/              statblocks in different formats the parser is tested on
tests/parse-dump.js            `node tests/parse-dump.js [name]` shows what the parser makes of them
```

The scripts are plain classic scripts that share globals, and the load order in `index.html` matters:
party data → SRD monsters → spell data → statblock parser → sheet reader → forge → tactical engine → war table.

For contributors and AI work: [CLAUDE.md](CLAUDE.md) (working notes and where things live), [docs/ai-v2.md](docs/ai-v2.md) (how the v2 AI decides) and [docs/ai-roadmap.md](docs/ai-roadmap.md) (plan, phases, backlog).

## Where things live

| You want to change | Look in |
|---|---|
| How pasted statblocks are read | `js/statblock-parser.js` (header, sections, attacks, save effects, multiattack, traits, spellcasting) and `js/spell-data.js` for spells. Add a sample to `tests/statblocks/` and run `npm test` |
| The built-in party / class roster | Edit `tools/build-party.js` and run it. Bump `PARTY_VERSION` and add the ids to `PARTY_UPDATES` in `js/forge.js` so saved workspaces pick up the change |
| The Forge layout and pages | `js/forge.js`: `renderSide` (sidebar), `sheetHtml` (creature sheet), `statblockHtml` (read-only statblock), `encounterHtml` + `runQuickOdds`, `libraryHtml`. The selection lives in `sel` |
| Editor fields for actions and creatures | `js/forge.js`, around `actionEditor`, `mechanicsPanel` (War Table fields) and `handleFieldChange`; creature fields in `sheetHtml`, `onCoreField` and the `data-ext` handler |
| Validation and export | `js/forge.js`, around `validateMonster`, `checkRealSchema`, `exportCreature`, `compileSpellbook` |
| How War Table creatures choose what to do | `js/engine/tactical-engine.js`, especially `tacticalTurnInner` (where to stand), `optionValue` / `rankSpells` (which spell), `targetValue` (who to hit) |
| Rules: attacks, saves, damage, conditions | `js/engine/tactical-engine.js`: `attackRoll`, `saveRoll`, `damage`, `addBuff` |
| Board drawing and replay | `js/war-table.js` |

Extra data beyond the base save format goes in an `ext` object on creatures and actions, such as ranges, areas, saves, spellbooks and on-hit effects. `exportCreature` strips or compiles it for the export.

## Saved data

The workspace autosaves to `localStorage` under `forge-workspace-v1`, per browser and per domain. Moving the site to a new address starts with a fresh workspace, so export a JSON from the old copy and import it into the new one.

## Credits

- Everything here (Forge, statblock reader, War Table engine and UI) was written for this project.

## Licences

This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

Statblock Forge is unofficial fan content and is not affiliated with or endorsed by Wizards of the Coast.
