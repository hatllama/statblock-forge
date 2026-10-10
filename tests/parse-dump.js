// prints what the parser makes of each test statblock: node tests/parse-dump.js [name-filter]
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
for (const f of ['js/spell-data.js', 'js/statblock-parser.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
const dir = path.join(__dirname, 'statblocks');
for (const f of fs.readdirSync(dir).filter(f => !process.argv[2] || f.includes(process.argv[2]))) {
  const r = ctx.StatblockParser.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const m of r.monsters) {
    console.log(`\n=== ${f}: ${m.name} · ${m.ext.size} ${m.type} · CR ${m.cr} · AC ${m.AC} · HP ${m.hp} · save avg ${m.saveBonus} · saves ${JSON.stringify(m.ext.saves)} · speed ${m.ext.speed}${m.ext.fly ? ' fly ' + m.ext.fly : ''} · init ${m.ext.initBonus} · ai ${m.ext.ai}${m.ext.blindsight ? ' · blindsight' : ''}${m.ext.bonusDisengage ? ' · bonusDisengage' : ''}`);
    for (const a of m.actions) console.log(`  [${a.actionSlot}] ${a.name} · ${typeof a.freq === 'object' ? JSON.stringify(a.freq) : a.freq} · ${a.condition} · ${a.type} x${a.targets}` + (a.type === 'atk' ? ` dpr ${a.dpr} ${a.useSaves ? 'DC' : '+'}${a.toHit}${a.halfOnSave ? ' half' : ''}` : '') + (a.type === 'debuff' ? ` DC${a.saveDC}` : '') + (a.amount ? ` amt ${a.amount}${a.tempHP ? ' temp' : ''}` : '') + (a.buff ? ' buff ' + JSON.stringify(a.buff) : '') + (a.riderEffect ? ' rider ' + JSON.stringify(a.riderEffect) : '') + ' ext ' + JSON.stringify(a.ext || {}));
    if (m.ext.spellbook) { console.log('  spellbook slots', JSON.stringify(m.ext.spellbook.slots)); for (const s of m.ext.spellbook.spells) console.log(`    L${s.level} ${s.name} · ${s.type} ${s.dpr || s.amount || JSON.stringify(s.buff || s.templateOptions)} ${s.useSaves ? 'DC' + s.toHit : s.toHit !== undefined ? '+' + s.toHit : ''}${s.concentration ? ' conc' : ''}${s.upcast ? ' up ' + s.upcast : ''}`); }
    m._notes.forEach(n => console.log('  note:', n));
  }
  r.skipped.forEach(s => console.log('  SKIPPED', s));
}
