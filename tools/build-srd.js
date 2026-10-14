#!/usr/bin/env node
/* Builds data/srd-monsters.js: a hand-picked set of official monsters from the System Reference Document 5.2
   (Wizards of the Coast, CC-BY-4.0), written out as 2024-style statblock text that the site's own statblock
   reader turns into War Table creatures.

   The structured SRD 5.2 data comes from the 5e-database project (https://github.com/5e-bits/5e-database):
     git clone --depth 1 https://github.com/5e-bits/5e-database.git /tmp/5e-database
     node tools/build-srd.js /tmp/5e-database

   To add a monster: put its exact SRD name in PICK below and run the script again. */
'use strict';
const fs = require('fs');
const path = require('path');

const DB = process.argv[2] || '/tmp/5e-database';
const MON = JSON.parse(fs.readFileSync(path.join(DB, 'src/2024/en/5e-SRD-Monsters.json'), 'utf8'));
const SPELLS = JSON.parse(fs.readFileSync(path.join(DB, 'src/2024/en/5e-SRD-Spells.json'), 'utf8'));
const baseLevel = {};
SPELLS.forEach(s => { baseLevel[s.index] = s.level; });

// a spread from the first adventures to the last, kept to monsters that play well on the War Table
const PICK = [
  'Goblin Warrior', 'Goblin Boss', 'Kobold Warrior', 'Bandit', 'Cultist', 'Guard', 'Skeleton', 'Zombie', 'Wolf', 'Giant Rat',
  'Tough', 'Cultist Fanatic', 'Ghoul', 'Giant Spider', 'Bugbear Warrior', 'Dire Wolf',
  'Bandit Captain', 'Ogre', 'Gnoll Warrior', 'Priest', 'Hobgoblin Captain', 'Knight', 'Owlbear', 'Warrior Veteran', 'Wight',
  'Basilisk', 'Manticore', 'Minotaur of Baphomet', 'Mummy', 'Werewolf, Hybrid Form',
  'Troll', 'Hill Giant', 'Air Elemental', 'Gladiator', 'Vampire Spawn', 'Wraith',
  'Mage', 'Wyvern', 'Chimera', 'Medusa', 'Assassin', 'Hydra', 'Young Green Dragon', 'Young Red Dragon', 'Stone Golem',
  'Adult Red Dragon', 'Lich',
];

const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const titleWords = s => String(s).split(/(\s+|-)/).map(w => /^(of|and|the|in|or)$/i.test(w) ? w.toLowerCase() : cap(w)).join('');
const signed = n => (n >= 0 ? '+' : '−') + Math.abs(n);
const mod = v => Math.floor((v - 10) / 2);
const crText = cr => cr === 0.125 ? '1/8' : cr === 0.25 ? '1/4' : cr === 0.5 ? '1/2' : String(cr);
const listOf = arr => (arr || []).map(x => typeof x === 'string' ? x : x.name).filter(Boolean);
const usage = u => {
  if (!u) return '';
  if (u.type === 'recharge on roll') return ` (Recharge ${u.min_value === 6 ? '6' : u.min_value + '–6'})`;
  if (u.type === 'per day') return ` (${u.times}/Day${u.times_in_lair ? `, or ${u.times_in_lair}/Day in Lair` : ''})`;
  if (u.type === 'recharge after rest') return ' (Recharges after a Short or Long Rest)';
  return '';
};
// "The mage casts one of the following spells…:" plus its list, the way the books print it
function spellList(sc) {
  const groups = new Map();
  for (const sp of sc.spells || []) {
    const u = sp.usage || { type: 'at will' };
    const key = u.type === 'per day' ? `${u.times}/Day Each` : 'At Will';
    const up = baseLevel[sp.index] !== undefined && sp.level > baseLevel[sp.index] && baseLevel[sp.index] > 0 ? ` (level ${sp.level} version)` : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sp.name + up + (sp.notes ? ` (${sp.notes})` : ''));
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'At Will' ? -1 : b === 'At Will' ? 1 : parseInt(b) - parseInt(a)));
  return order.map(k => `${k}: ${groups.get(k).join(', ')}`).join('\n');
}
function entry(a) {
  let s = `${a.name}${usage(a.usage)}. ${a.desc.trim()}`;
  if (a.spellcasting && /following spells/i.test(a.desc) && /:\s*$/.test(a.desc.trim())) s += '\n' + spellList(a.spellcasting);
  return s;
}

function render(m) {
  const L = [];
  L.push(m.name);
  L.push(`${titleWords(m.size)} ${titleWords(m.type)}${m.subtype ? ` (${titleWords(m.subtype)})` : ''}, ${titleWords(m.alignment)}`);
  const dex = mod(m.dexterity);
  L.push(`AC ${m.armor_class[0].value}    Initiative ${signed(dex)} (${10 + dex})`);
  L.push(`HP ${m.hit_points} (${m.hit_points_roll || m.hit_dice})`);
  const sp = m.speed || {};
  const speeds = [sp.walk || '0 ft.'].concat(Object.keys(sp).filter(k => k !== 'walk' && k !== 'hover').map(k => `${cap(k)} ${sp[k]}${k === 'fly' && sp.hover ? ' (hover)' : ''}`));
  L.push(`Speed ${speeds.join(', ')}`);
  const saves = {};
  (m.proficiencies || []).forEach(p => { const k = p.proficiency.index.match(/^saving-throw-(\w+)/); if (k) saves[k[1]] = p.value; });
  L.push('MOD SAVE');
  [['str', 'Str', m.strength], ['dex', 'Dex', m.dexterity], ['con', 'Con', m.constitution], ['int', 'Int', m.intelligence], ['wis', 'Wis', m.wisdom], ['cha', 'Cha', m.charisma]]
    .forEach(([k, n, v]) => L.push(`${n} ${v} ${signed(mod(v))} ${signed(saves[k] !== undefined ? saves[k] : mod(v))}`));
  const skills = (m.proficiencies || []).filter(p => /^skill-/.test(p.proficiency.index)).map(p => `${p.proficiency.name.replace(/^Skill:\s*/, '')} ${signed(p.value)}`);
  if (skills.length) L.push(`Skills ${skills.join(', ')}`);
  if ((m.damage_vulnerabilities || []).length) L.push(`Vulnerabilities ${listOf(m.damage_vulnerabilities).map(cap).join(', ')}`);
  if ((m.damage_resistances || []).length) L.push(`Resistances ${listOf(m.damage_resistances).map(cap).join(', ')}`);
  const imm = listOf(m.damage_immunities).map(cap), cimm = listOf(m.condition_immunities).map(cap);
  if (imm.length || cimm.length) L.push(`Immunities ${imm.join(', ')}${imm.length && cimm.length ? '; ' : ''}${cimm.join(', ')}`);
  if (m.gear) L.push(`Gear ${m.gear}`);
  const se = m.senses || {};
  const senses = Object.keys(se).filter(k => k !== 'passive_perception').map(k => `${cap(k)} ${se[k]}`);
  L.push(`Senses ${senses.length ? senses.join(', ') + '; ' : ''}Passive Perception ${se.passive_perception}`);
  L.push(`Languages ${m.languages || 'None'}`);
  L.push(`CR ${crText(m.challenge_rating)} (XP ${Number(m.xp).toLocaleString('en-US')}${m.xp_in_lair ? `, or ${Number(m.xp_in_lair).toLocaleString('en-US')} in lair` : ''}; PB ${signed(m.proficiency_bonus)})`);
  if ((m.special_abilities || []).length) { L.push('Traits'); m.special_abilities.forEach(a => L.push(entry(a))); }
  if ((m.actions || []).length) { L.push('Actions'); m.actions.forEach(a => L.push(entry(a))); }
  if ((m.bonus_actions || []).length) { L.push('Bonus Actions'); m.bonus_actions.forEach(a => L.push(entry(a))); }
  if ((m.reactions || []).length) { L.push('Reactions'); m.reactions.forEach(a => L.push(entry(a))); }
  if ((m.legendary_actions || []).length) {
    const lr = (m.special_abilities || []).find(a => /legendary resistance/i.test(a.name));
    L.push('Legendary Actions');
    L.push(`Legendary Action Uses: 3${lr && lr.usage && lr.usage.times_in_lair ? ' (4 in Lair)' : ''}. Immediately after another creature's turn, the ${m.name.toLowerCase().split(/[ ,]/).pop()} can expend a use to take one of the following actions. It regains all expended uses at the start of each of its turns.`);
    m.legendary_actions.forEach(a => L.push(entry(a)));
  }
  return L.join('\n').replace(/[’]/g, "'");
}

const out = [];
for (const name of PICK) {
  const m = MON.find(x => x.name === name);
  if (!m) { console.error('not in the SRD data:', name); process.exitCode = 1; continue; }
  out.push({ id: 'srd-' + m.index, name: m.name, cr: crText(m.challenge_rating), size: titleWords(m.size), type: titleWords(m.type), ac: m.armor_class[0].value, hp: m.hit_points, text: render(m) });
}
out.sort((a, b) => eval(a.cr) - eval(b.cr) || a.name.localeCompare(b.name));

const ATTR = 'This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';
const js = `/* Official monsters from the System Reference Document 5.2. Generated by tools/build-srd.js; edit that, not this.

   ${ATTR}

   The statblocks are SRD 5.2 text as published, laid out for the site's statblock reader (structured data via the
   5e-database project, https://github.com/5e-bits/5e-database). */
const SRD_ATTRIBUTION = ${JSON.stringify(ATTR)};
const SRD_MONSTERS = ${JSON.stringify(out, null, 1)};
`;
fs.writeFileSync(path.join(__dirname, '..', 'data', 'srd-monsters.js'), js);
console.log(`wrote ${out.length} SRD monsters`);
