#!/usr/bin/env node
/* Builds the threat table of learn mode (AI_BASE.threat.table in js/engine/tactical-engine.js, docs/ai-v2.md "The
   threat estimate"): median HP, AC, damage per round, attack bonus, save DC, save bonus (all six, and each ability's), attacks and actions by CR, plus the
   XP of a CR and the CR that typically inflicts a condition. Everything is measured from the SRD 5.2 monsters in
   data/srd-monsters.js, read by the site's own statblock parser; no other table is used.

   Rerun after data/srd-monsters.js or the parser changes (it rewrites the block between the threat-table markers):
     node tools/build-threat.js          rewrite the block and print the table
     node tools/build-threat.js --dry    print it only */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { ENGINE_FILES, loadEngine } = require('./engine-files.js');
const MARKERS = /\/\* threat-table:start[\s\S]*?threat-table:end \*\//;
// the engine file that holds the table: the one with the markers
const ENGINE_FILE = ENGINE_FILES.find(f => MARKERS.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
function load(files) { const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx); for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }); return ctx; }
const Parser = load(['js/spell-data.js', 'js/statblock-parser.js']).StatblockParser;
const Tac = loadEngine();
const Data = load(['data/srd-monsters.js']);
vm.runInContext('globalThis.M = SRD_MONSTERS;', Data);

// the CRs in the Library fall in these groups: too few monsters at one CR to trust a median, so neighbours share one
const ABS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const GROUPS = [[0, 0.125], [0.25, 0.25], [0.5, 1], [2, 2], [3, 3], [5, 5], [6, 6], [8, 10], [17, 21]];
const CONDS = /\b(Paralyzed|Stunned|Petrified|Unconscious|Incapacitated|Restrained|Frightened|Charmed|Poisoned|Blinded|Grappled|Prone)\b/g;
const crOf = c => { const p = String(c).split('/'); return p.length > 1 ? +p[0] / +p[1] : +c; };
const median = l => { const s = l.slice().sort((a, b) => a - b), n = s.length; return !n ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const avg = d => Number(Tac.avgDice(d)) || 0;

/* one monster's numbers. Damage per round: its best at-will action if everything hits, on one target (a Multiattack's
   hits added up; limited actions count only if it has nothing at will). Attacks: the most it makes in an action. */
function measure(s) {
  const m = Parser.parse(s.text).monsters[0];
  const acts = m.actions.filter(a => a.type === 'atk' || a.type === 'debuff');
  const main = acts.filter(a => (a.actionSlot || 0) === 0);
  let dpr = 0, limited = 0, atk = 0, dc = 0, attacks = 1;
  for (const a of main) {
    const area = a.ext && a.ext.area, hits = a.type === 'atk' && !a.useSaves && !area ? a.targets || 1 : 1;
    const d = a.type === 'atk' ? avg((a.ext && a.ext.wtDpr) || a.dpr) * hits : 0;
    if (a.freq === 'at will') dpr = Math.max(dpr, d); else limited = Math.max(limited, d);
    if (a.type === 'atk' && !a.useSaves) atk = Math.max(atk, avg(a.toHit));
    attacks = Math.max(attacks, hits);
  }
  dpr = dpr || limited;
  for (const x of s.text.matchAll(/DC (\d+)/g)) dc = Math.max(dc, +x[1]);
  const saves = Object.values(m.ext.saves || {}).map(Number).filter(n => !isNaN(n));
  const save = saves.length ? median(saves) : Number(avg(m.saveBonus)) || 0;
  const xp = +(/XP ([\d,]+)/.exec(s.text) || [0, '0'])[1].replace(/,/g, '');
  const conds = new Set(); for (const x of s.text.split(/^Actions$/m).slice(1).join('\n').matchAll(CONDS)) conds.add(x[1]);
  const by = {}; for (const ab of ABS) by[ab] = Number((m.ext.saves || {})[ab]) || 0;     // proficiency included
  return { name: s.name, cr: crOf(s.cr), hp: s.hp, ac: s.ac, dpr, atk, dc, save, by, attacks, shown: acts.length, xp, conds: Array.from(conds), legRes: /Legendary Resistance/.test(s.text) };
}
const all = Data.M.map(measure);

/* a table that only goes up: a row below the rows before it takes their level (a Library of 47 has noisy medians) */
const rise = (rows, f) => { let hi = -Infinity; for (const r of rows) { r[f] = Math.max(hi, r[f]); hi = r[f]; } };
const round1 = x => Math.round(x * 10) / 10;
const rows = GROUPS.map(([lo, hi]) => {
  const g = all.filter(m => m.cr >= lo && m.cr <= hi);
  const col = f => median(g.map(m => m[f]).filter(v => v > 0));
  const sv = {}; for (const ab of ABS) sv[ab] = round1(median(g.map(m => m.by[ab])));   // a save can be 0 or less: no filter
  return Object.assign({ cr: round1(median(g.map(m => m.cr)) * 100) / 100, n: g.length, hp: col('hp'), ac: col('ac'), dpr: round1(col('dpr')), atk: col('atk'), dc: col('dc'), save: round1(col('save')), attacks: col('attacks'), shown: col('shown'), xp: col('xp') }, sv);
});
for (const f of ['hp', 'ac', 'dpr', 'atk', 'dc', 'save', 'attacks', 'shown', 'xp'].concat(ABS)) rise(rows, f);

// the CR at which the Library's monsters inflict a condition: the median over those that do (three at least)
const cond = {};
for (const c of ['Paralyzed', 'Stunned', 'Petrified', 'Unconscious', 'Incapacitated', 'Restrained', 'Frightened', 'Charmed', 'Poisoned', 'Blinded', 'Grappled', 'Prone']) {
  const l = all.filter(m => m.conds.includes(c)).map(m => m.cr);
  if (l.length >= 3) cond[c] = median(l);
}

const line = r => `      { cr: ${r.cr}, hp: ${r.hp}, ac: ${r.ac}, dpr: ${r.dpr}, atk: ${r.atk}, dc: ${r.dc}, save: ${r.save}, ${ABS.map(ab => `${ab}: ${r[ab]}`).join(', ')}, attacks: ${r.attacks}, shown: ${r.shown}, xp: ${r.xp} },   // ${r.n} monsters`;
const block = `/* threat-table:start (generated by tools/build-threat.js from data/srd-monsters.js) */
    table: [
${rows.map(line).join('\n')}
    ],
    cond: ${JSON.stringify(cond).replace(/"/g, '').replace(/([:,])/g, '$1 ')},
    legCr: ${median(all.filter(m => m.legRes).map(m => m.cr))},
    /* threat-table:end */`;
console.log(block);
if (process.argv.indexOf('--dry') < 0) {
  if (!ENGINE_FILE) { console.error('no threat-table markers in the engine'); process.exit(1); }
  const file = path.join(ROOT, ENGINE_FILE), src = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, src.replace(MARKERS, () => block));
  console.log('rewrote the table in ' + ENGINE_FILE);
}
