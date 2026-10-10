# BattleSim engine (modified)

`battlesim-engine.js` is a bundled build of the simulation code from **BattleSim** by Trekiros:
https://github.com/Trekiros/battleSim

BattleSim's source is licensed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0
International licence (https://creativecommons.org/licenses/by-nc-sa/4.0/). This modified build is shared
under the same licence.

Changes made for Statblock Forge:
- "smart actions" mode: spell lists with slots chosen per situation, slot recovery (Arcane Recovery / Magical
  Cunning), creature-type restrictions (e.g. Hold Person on humanoids only)
- the six real saving throws per creature and a save ability per action
- War-Table-only spells (`ext.wtOnly`) are left out
- exact mode keeps parity with upstream BattleSim
