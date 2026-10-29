/* Flag-off check: hashes of recorded fight logs with the old AI only (no opts.ai). Run before and after an AI change;
   the hashes must match. `node tests/flagoff-hash.js > before.txt` … `node tests/flagoff-hash.js | diff before.txt -` */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
function load(files) { const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx); for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }); return ctx; }
const Tac = load(['js/engine/tactical-engine.js']).TacEngine;
const Parser = load(['js/spell-data.js', 'js/statblock-parser.js']).StatblockParser;
const D = load(['data/party.js', 'data/srd-monsters.js']);
vm.runInContext('globalThis.CB = CLASS_BUILDS; globalThis.PP = PARTY_PLAYERS; globalThis.M = SRD_MONSTERS;', D);
const cp = x => JSON.parse(JSON.stringify(x));
const fixture = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
const pc = n => cp(D.CB.find(c => c.name === n));
function mon(name, count) {
  const s = D.M.find(m => m.name === name), m = cp(Parser.parse(s.text).monsters[0]);
  m.id = s.id; m.mode = 'custom'; m.count = count || 1; m.actions.forEach((a, i) => { a.id = s.id + i; });
  if (m.ext.spellbook) m.ext.spellbook.spells.forEach((x, i) => { x.id = s.id + 's' + i; });
  return m;
}
function file(name, count) {
  const m = cp(Parser.parse(fs.readFileSync(path.join(__dirname, 'statblocks', name), 'utf8')).monsters[0]);
  m.id = name; m.mode = 'custom'; m.count = count || 1; m.actions.forEach((a, i) => { a.id = name + i; });
  if (m.ext.spellbook) m.ext.spellbook.spells.forEach((x, i) => { x.id = name + 's' + i; });
  return m;
}
const casters = () => ['Wizard', 'Cleric', 'Sorcerer', 'Warlock', 'Druid', 'Bard', 'Paladin', 'Ranger', 'Fighter'].map(pc);
const DAYS = [
  ['default party vs hard-day', () => ({ players: cp(D.PP), encounters: cp(fixture('hard-day.json').encounters) })],
  ['default party vs bandit-day', () => ({ players: cp(D.PP), encounters: cp(fixture('bandit-day.json').encounters) })],
  ['casters vs goblins / ogres / mage', () => ({ players: casters(), encounters: [{ monsters: [mon('Goblin Warrior', 8)] }, { monsters: [mon('Ogre', 3)], shortRest: true }, { monsters: [file('mage-2014.txt', 2), mon('Guard', 4)] }] })],
  ['casters vs priests + young dragon', () => ({ players: casters(), encounters: [{ monsters: [mon('Priest', 2), mon('Bandit', 4)] }, { monsters: [mon('Young Green Dragon')] }] })],
];
const walled = (() => { const cells = {}; for (let y = 0; y < 16; y++) if (y < 6 || y > 9) cells['11,' + y] = { t: 'wall' }; for (let y = 2; y < 14; y++) for (let x = 3; x <= 5; x++) cells[x + ',' + y] = { h: 2 }; return { gapFt: 30, terrain: { cells } }; })();
for (const [name, mk] of DAYS) for (const lay of [null, walled]) for (const partyAI of ['tactical', 'regular']) for (let i = 0; i < 4; i++) {
  const seed = 500 + i * 7919;
  const res = Tac.runDay(mk(), { seed, partyAI, record: true, layout: lay || undefined, prefightBuffs: process.env.PREFIGHT === '0' ? false : undefined });
  const h = crypto.createHash('sha1').update(JSON.stringify(res.map(r => [r.won, r.rounds, r.events]))).digest('hex').slice(0, 12);
  console.log(`${name} | ${lay ? 'walled' : 'open'} | ${partyAI} | ${seed} | ${h}`);
}
