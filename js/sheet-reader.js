/* =====================================================================
   SHEET READER: turns a player character sheet into a War Table party member.
   Reads a D&D Beyond character JSON, a Foundry VTT (dnd5e) actor export, the form fields of a fillable
   PDF sheet (passed in as "Field: value" lines), or plain text pasted from any sheet. Everything goes
   through one set of facts (name, classes, AC, HP, scores, saves, attacks, spells, slots), and one
   builder turns those into the creature, with spells built by the statblock reader's own spell builder.
   DOM-free: tested under Node (tests/run.js). Needs js/spell-data.js and js/statblock-parser.js first.

   Load order: after js/statblock-parser.js, before js/forge.js. Must stay DOM-free.
   Contents (grep the banner text, in file order):
     - facts from a D&D Beyond character JSON (fromDDB)
     - facts from a Foundry VTT dnd5e actor (fromFoundry)
     - facts from text (pasted sheets, PDF form fields) (fromText)
     - class features the War Table has rules for (classFeatures)
     - the creature (build)
   ===================================================================== */
(function (root) {
'use strict';

const ABS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ABN = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
const mod = s => Math.floor((s - 10) / 2);
const pbOf = lvl => 2 + Math.floor((Math.max(1, lvl) - 1) / 4);
const titleCase = s => String(s).toLowerCase().replace(/(^|[\s\/(-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/'S\b/g, "'s");
const titleSmall = s => titleCase(s).replace(/ (Of|The|And|In|Or|A) /g, (m, w) => ' ' + w.toLowerCase() + ' ');
const signed = n => (n >= 0 ? '+' : '') + n;

const CLASSES = {
  barbarian: { saves: ['str', 'con'], cast: 0 }, bard: { saves: ['dex', 'cha'], cast: 1, ab: 'cha' }, cleric: { saves: ['wis', 'cha'], cast: 1, ab: 'wis' },
  druid: { saves: ['int', 'wis'], cast: 1, ab: 'wis' }, fighter: { saves: ['str', 'con'], cast: 0 }, monk: { saves: ['str', 'dex'], cast: 0 },
  paladin: { saves: ['wis', 'cha'], cast: 0.5, ab: 'cha' }, ranger: { saves: ['str', 'dex'], cast: 0.5, ab: 'wis' }, rogue: { saves: ['dex', 'int'], cast: 0 },
  sorcerer: { saves: ['con', 'cha'], cast: 1, ab: 'cha' }, warlock: { saves: ['wis', 'cha'], cast: 'pact', ab: 'cha' }, wizard: { saves: ['int', 'wis'], cast: 1, ab: 'int' },
  artificer: { saves: ['con', 'int'], cast: 0.5, ab: 'int', roundUp: true },
};
const THIRD = /eldritch knight|arcane trickster/i;
// spell slots by caster level (the multiclass table)
const SLOTS = [[], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]];
const PACT = l => ({ n: l >= 17 ? 4 : l >= 11 ? 3 : l >= 2 ? 2 : 1, lvl: Math.min(5, Math.ceil(l / 2)) });

// weapons: [dice, damage type, range (melee reach or ranged normal range), finesse/ranged]
const WEAPONS = {
  club: ['1d4', 'bludgeoning', 5], dagger: ['1d4', 'piercing', 5, 'f'], greatclub: ['1d8', 'bludgeoning', 5], handaxe: ['1d6', 'slashing', 5], javelin: ['1d6', 'piercing', 5],
  'light hammer': ['1d4', 'bludgeoning', 5], mace: ['1d6', 'bludgeoning', 5], quarterstaff: ['1d6', 'bludgeoning', 5], sickle: ['1d4', 'slashing', 5], spear: ['1d6', 'piercing', 5],
  'light crossbow': ['1d8', 'piercing', 80, 'r'], dart: ['1d4', 'piercing', 20, 'r'], shortbow: ['1d6', 'piercing', 80, 'r'], sling: ['1d4', 'bludgeoning', 30, 'r'],
  battleaxe: ['1d8', 'slashing', 5], flail: ['1d8', 'bludgeoning', 5], glaive: ['1d10', 'slashing', 10], greataxe: ['1d12', 'slashing', 5], greatsword: ['2d6', 'slashing', 5],
  halberd: ['1d10', 'slashing', 10], lance: ['1d10', 'piercing', 10], longsword: ['1d8', 'slashing', 5], maul: ['2d6', 'bludgeoning', 5], morningstar: ['1d8', 'piercing', 5],
  pike: ['1d10', 'piercing', 10], rapier: ['1d8', 'piercing', 5, 'f'], scimitar: ['1d6', 'slashing', 5, 'f'], shortsword: ['1d6', 'piercing', 5, 'f'], trident: ['1d8', 'piercing', 5],
  'war pick': ['1d8', 'piercing', 5], warhammer: ['1d8', 'bludgeoning', 5], whip: ['1d4', 'slashing', 10, 'f'], blowgun: ['1', 'piercing', 25, 'r'],
  'hand crossbow': ['1d6', 'piercing', 30, 'r'], 'heavy crossbow': ['1d10', 'piercing', 100, 'r'], longbow: ['1d8', 'piercing', 150, 'r'], musket: ['1d12', 'piercing', 40, 'r'], pistol: ['1d10', 'piercing', 30, 'r'],
  'unarmed strike': ['1', 'bludgeoning', 5],
};
// spells the spell data has no entry for but a party member often relies on (built the way tools/build-party.js builds them)
const CUSTOM = {
  'divine smite': { level: 1, actionSlot: 1, targets: 1, type: 'buff', target: 'self', buff: { duration: 'until next attack made', damage: '2d8' }, ext: { range: 0 } },
  'aid': { level: 2, actionSlot: 0, targets: 3, type: 'heal', amount: '5', upcast: '5', target: 'ally with the least HP', ext: { range: 30, aid: true } },
};
const weaponOf = name => { const n = String(name).toLowerCase(); let best = null; for (const k in WEAPONS) if (n.indexOf(k) >= 0 && (!best || k.length > best.length)) best = k; return best ? { key: best, w: WEAPONS[best] } : null; };
const DTYPES = /\b(acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)\b/i;

/* ---------- facts from a D&D Beyond character JSON ---------- */
function fromDDB(d) {
  const notes = [];
  const mods = [].concat(...Object.values(d.modifiers || {}).map(x => x || []));
  const bonus = sub => mods.filter(m => m.type === 'bonus' && m.subType === sub).reduce((t, m) => t + (m.value || m.fixedValue || 0), 0);
  const setTo = sub => mods.filter(m => m.type === 'set' && m.subType === sub).reduce((t, m) => Math.max(t, m.value || 0), 0);
  const scores = ABS.map((k, i) => {
    const ov = (d.overrideStats || []).find(s => s.id === i + 1);
    if (ov && ov.value) return ov.value;
    const base = ((d.stats || []).find(s => s.id === i + 1) || {}).value || 10;
    const b = ((d.bonusStats || []).find(s => s.id === i + 1) || {}).value || 0;
    return Math.max(base + b + bonus(ABN[k] + '-score'), setTo(ABN[k] + '-score'));
  });
  const classes = (d.classes || []).map(c => ({ name: (c.definition && c.definition.name || '').toLowerCase(), level: c.level || 1, sub: c.subclassDefinition && c.subclassDefinition.name || '' }));
  const level = classes.reduce((t, c) => t + c.level, 0) || 1;
  const conM = mod(scores[2]);
  const hp = d.overrideHitPoints || ((d.baseHitPoints || 0) + (d.bonusHitPoints || 0) + conM * level + bonus('hit-points-per-level') * level + bonus('hit-points'));
  const inv = d.inventory || [];
  const eq = inv.filter(it => it.equipped && it.definition);
  const magic = it => ((it.definition.grantedModifiers || []).filter(m => m.type === 'bonus' && m.subType === 'magic').reduce((t, m) => t + (m.value || 0), 0));
  // AC: worn armor (or unarmored defense), a shield, and anything else that adds to it
  const armor = eq.find(it => it.definition.armorTypeId >= 1 && it.definition.armorTypeId <= 3);
  const shield = eq.find(it => it.definition.armorTypeId === 4);
  const dexM = mod(scores[1]);
  let ac;
  if (armor) { const t = armor.definition.armorTypeId; ac = armor.definition.armorClass + (t === 1 ? dexM : t === 2 ? Math.min(2, dexM) : 0) + magic(armor); }
  else if (classes.some(c => c.name === 'barbarian')) ac = 10 + dexM + conM;
  else if (classes.some(c => c.name === 'monk') && !shield) ac = 10 + dexM + mod(scores[4]);
  else ac = 10 + dexM;
  if (shield) ac += (shield.definition.armorClass || 2) + magic(shield);
  ac += bonus('armor-class') + (armor ? bonus('armored-armor-class') : bonus('unarmored-armor-class'));
  if (d.characterValues) { const ov = d.characterValues.find(v => v.typeId === 1 && v.value); if (ov) ac = ov.value; }
  const ws = (d.race && d.race.weightSpeeds && d.race.weightSpeeds.normal) || {};
  const speed = (ws.walk || 30) + bonus('speed') + bonus('speed-walking') + (armor ? 0 : bonus('unarmored-movement'));
  const pbInit = mods.some(m => m.type === 'bonus' && m.subType === 'initiative' && !m.value && !m.fixedValue) ? pbOf((d.classes || []).reduce((t, c) => t + (c.level || 0), 0)) : 0;
  const init = dexM + pbInit + mods.filter(m => m.type === 'bonus' && m.subType === 'initiative' && (m.value || m.fixedValue)).reduce((t, m) => t + (m.value || m.fixedValue), 0);
  const traits = [].concat(...Object.values(d.actions || {}).map(l => Array.isArray(l) ? l.map(a => a.name) : [])).concat((d.feats || []).map(f => f.definition && f.definition.name)).filter(Boolean);
  const fly = ws.fly || setTo('fly') || setTo('innate-speed-flying');
  const saveProf = ABS.filter(k => mods.some(m => m.type === 'proficiency' && m.subType === ABN[k] + '-saving-throws'));
  const pb = pbOf(level);
  const attacks = [];
  eq.filter(it => it.definition.filterType === 'Weapon' || (it.definition.damage && it.definition.attackType)).forEach(it => {
    const df = it.definition, props = (df.properties || []).map(p => p.name.toLowerCase());
    const ranged = df.attackType === 2 && !props.includes('thrown');
    const fin = props.includes('finesse');
    const am = ranged ? dexM : fin ? Math.max(dexM, mod(scores[0])) : mod(scores[0]);
    const mb = magic(it);
    const dice = (df.damage && df.damage.diceString) || '1';
    attacks.push({ name: titleCase(it.definition.name), toHit: am + pb + mb, dmg: `${dice}${am + mb ? ` ${am + mb < 0 ? '-' : '+'} ${Math.abs(am + mb)}` : ''}`,
      type: (df.damageType || '').toLowerCase(), range: ranged || (props.includes('thrown') && df.range) ? (df.range || 80) : props.includes('reach') ? 10 : 5 });
  });
  const spells = [];
  const addSp = s => { const def = s && s.definition; if (!def) return; if (def.level === 0 || s.prepared || s.alwaysPrepared || s.countsAsKnownSpell || s.usesSpellSlot === false || s.limitedUse) spells.push(def.name); };
  (d.classSpells || []).forEach(cs => (cs.spells || []).forEach(addSp));
  Object.values(d.spells || {}).forEach(list => (list || []).forEach(addSp));
  const resist = mods.filter(m => m.type === 'resistance').map(m => m.subType).filter(t => DTYPES.test(t || ''));
  const skills = ['athletics', 'acrobatics'].filter(k => mods.some(m => (m.type === 'proficiency' || m.type === 'expertise') && m.subType === k));
  const race = (d.race && (d.race.fullName || d.race.baseName)) || '';
  const size = d.race && d.race.sizeId === 2 ? 'Small' : /\b(goblin|halfling|gnome|kobold|fairy)\b/i.test(race) ? 'Small' : '';
  if (/fury of the small/i.test(traits.join('|'))) notes.push('Fury of the Small (extra damage a few times a day) isn\'t modelled.');
  if (/uncanny metabolism/i.test(traits.join('|'))) notes.push('Uncanny Metabolism (Focus Points back on initiative once a day) isn\'t modelled.');
  return { name: d.name, classes, scores, hp, ac, speed, fly, init, saveProf, skills, size, attacks, spells, resist, traits, notes, src: 'D&D Beyond' };
}

/* ---------- facts from a Foundry VTT dnd5e actor ---------- */
function fromFoundry(a) {
  const notes = [], sys = a.system || a.data || {};
  const ab = sys.abilities || {};
  const scores = ABS.map(k => (ab[k] && ab[k].value) || 10);
  const items = a.items || [];
  const classes = items.filter(i => i.type === 'class').map(c => {
    const sub = items.find(i => i.type === 'subclass' && (i.system || {}).classIdentifier === ((c.system || {}).identifier || c.name.toLowerCase()));
    return { name: c.name.toLowerCase(), level: (c.system || {}).levels || 1, sub: sub ? sub.name : '' };
  });
  const level = classes.reduce((t, c) => t + c.level, 0) || (sys.details && sys.details.level) || 1;
  const pb = pbOf(level);
  const at = sys.attributes || {};
  const hp = (at.hp && (at.hp.max || at.hp.value)) || 0;
  const eq = items.filter(i => i.type === 'equipment' && (i.system || {}).equipped);
  const typ = i => ((i.system.type && i.system.type.value) || (i.system.armor && i.system.armor.type) || '').toLowerCase();
  const armor = eq.find(i => /light|medium|heavy/.test(typ(i)));
  const shield = eq.find(i => typ(i) === 'shield');
  const dexM = mod(scores[1]), conM = mod(scores[2]);
  let ac = at.ac && at.ac.calc === 'flat' ? at.ac.flat : null;
  if (!ac) {
    const av = i => (i.system.armor && (i.system.armor.value || 0)) + ((i.system.armor && i.system.armor.magicalBonus) || 0);
    if (armor) { const t = typ(armor); ac = av(armor) + (t === 'light' ? dexM : t === 'medium' ? Math.min(2, dexM) : 0); }
    else if (at.ac && at.ac.calc === 'unarmoredBarb') ac = 10 + dexM + conM;
    else if (at.ac && at.ac.calc === 'unarmoredMonk') ac = 10 + dexM + mod(scores[4]);
    else if (at.ac && at.ac.calc === 'mage') ac = 13 + dexM;
    else if (at.ac && at.ac.calc === 'draconic') ac = 13 + dexM;
    else ac = 10 + dexM;
    if (shield) ac += av(shield) || 2;
    if (at.ac && +at.ac.bonus) ac += +at.ac.bonus;
  }
  const mv = at.movement || {};
  const saveProf = ABS.filter(k => ab[k] && ab[k].proficient);
  const attacks = [];
  items.filter(i => i.type === 'weapon' && (i.system || {}).equipped !== false).forEach(w => {
    const s = w.system || {}, props = Array.isArray(s.properties) ? s.properties : Object.keys(s.properties || {}).filter(k => s.properties[k]);
    const ranged = /R$|^(simple|martial)?r/i.test((s.type && s.type.value) || s.weaponType || '') && !/M$/.test((s.type && s.type.value) || '') || (s.actionType === 'rwak' && !props.includes('thr'));
    const am = ranged ? dexM : props.includes('fin') ? Math.max(dexM, mod(scores[0])) : mod(scores[0]);
    const mb = +(s.magicalBonus || 0) || 0;
    let dice = '1', type = '';
    if (s.damage && s.damage.base && s.damage.base.denomination) { dice = `${s.damage.base.number || 1}d${s.damage.base.denomination}`; type = (s.damage.base.types || [])[0] || ''; }
    else if (s.damage && s.damage.parts && s.damage.parts[0]) { dice = String(s.damage.parts[0][0]).replace(/\s*\+\s*@mod/, '').trim() || '1'; type = s.damage.parts[0][1] || ''; }
    const fb = weaponOf(w.name);
    attacks.push({ name: w.name, toHit: am + pb + mb, dmg: `${dice}${am + mb ? ` ${am + mb < 0 ? '-' : '+'} ${Math.abs(am + mb)}` : ''}`, type: type || (fb ? fb.w[1] : ''),
      range: ranged ? ((s.range && s.range.value) || (fb ? fb.w[2] : 80)) : props.includes('rch') ? 10 : 5 });
  });
  const spells = items.filter(i => i.type === 'spell').filter(i => {
    const s = i.system || {}, p = s.preparation || {};
    return s.level === 0 || p.prepared || (p.mode && p.mode !== 'prepared') || s.prepared === 1 || s.prepared === 2 || (s.method && s.method !== 'spell');
  }).map(i => i.name);
  const resist = ((sys.traits && sys.traits.dr && sys.traits.dr.value) || []);
  return { name: a.name, classes, scores, hp, ac, speed: mv.walk || 30, fly: mv.fly || 0, saveProf, attacks, spells, resist: Array.isArray(resist) ? resist : [], notes, src: 'Foundry VTT' };
}

/* ---------- facts from text (pasted sheets, PDF form fields) ---------- */
function fromText(raw) {
  const notes = [];
  const t = String(raw).replace(/\r/g, '').replace(/[−–]/g, '-').replace(/ /g, ' ');
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  const num = re => { const m = t.match(re); return m ? +m[1] : null; };
  // name: a labelled one, or the first short line that isn't a heading
  let name = (t.match(/^\s*(?:character\s*name|charactername|name)\s*[:=]?\s*(.+)$/im) || [])[1] || '';
  if (!name) name = lines.find(l => l.length < 40 && !/\d/.test(l) && !/^(character|class|level|race|species|background|strength|stats?|abilities)\b/i.test(l)) || '';
  // classes: "Fighter 5", "Fighter (Champion) 5", "Level 5 Fighter", "Rogue 3 / Wizard 2"
  const classes = [];
  const cn = Object.keys(CLASSES).join('|');
  let m;
  const re1 = new RegExp(`\\b(${cn})\\b\\s*(?:\\(([^)]{2,40})\\)\\s*)?(?:lvl\\.?|level)?\\s*(\\d{1,2})\\b`, 'gi');
  while ((m = re1.exec(t))) if (!classes.some(c => c.name === m[1].toLowerCase()) && +m[3] >= 1 && +m[3] <= 20) classes.push({ name: m[1].toLowerCase(), level: +m[3], sub: m[2] || '' });
  if (!classes.length) {
    const re2 = new RegExp(`\\b(?:level|lvl\\.?)\\s*(\\d{1,2})\\s+(?:[A-Za-z-]+\\s+){0,3}?(${cn})\\b`, 'i');
    if ((m = t.match(re2))) classes.push({ name: m[2].toLowerCase(), level: +m[1], sub: '' });
  }
  if (!classes.length) {
    const c = t.match(new RegExp(`\\b(${cn})\\b`, 'i')), l = num(/\b(?:character\s*)?level\s*[:=]?\s*(\d{1,2})\b/i);
    if (c) { classes.push({ name: c[1].toLowerCase(), level: l || 1, sub: '' }); if (!l) notes.push('No level found; assumed level 1.'); }
  }
  classes.forEach(c => { if (!c.sub) { const s = t.match(/\b(?:subclass|archetype|path|college|domain|circle|oath|patron|tradition|school)\s*[:=]?\s*(?:of\s+(?:the\s+)?)?([A-Z][A-Za-z' ]{2,30})/); if (s && classes.length === 1) c.sub = s[1].trim(); } });
  // ability scores: "STR 16", "Strength: 16 (+3)", "STR\n+3\n16", or a "16 (+3)" pair after the label
  const scores = ABS.map((k, i) => {
    const re = new RegExp(`\\b(?:${k}|${ABN[k]})\\b(?!\\s*(?:sav|st\\b|mod))[^\\n\\d+-]{0,12}((?:[\\s:=|]*[+-]?\\d{1,2}\\b(?:\\s*\\([+-]?\\d+\\))?){1,2})`, 'i');
    const mm = t.match(re);
    if (!mm) return null;
    const nums = mm[1].match(/[+-]?\d{1,2}/g) || [];
    const plain = nums.find(n => !/^[+-]/.test(n) && +n >= 1 && +n <= 30);
    if (plain) return +plain;
    const sg = nums.find(n => /^[+-]/.test(n));
    return sg ? 10 + 2 * +sg : null;
  });
  const missing = ABS.filter((k, i) => scores[i] === null);
  if (missing.length) notes.push(`No score found for ${missing.map(k => k.toUpperCase()).join(', ')}; used 10.`);
  const sc = scores.map(s => s === null ? 10 : s);
  const ac = num(/\b(?:armou?r\s*class|AC)\b\s*[:=]?\s*(\d{1,2})\b/i);
  const hp = num(/\b(?:max(?:imum)?\s*(?:hit\s*points|hp)|hp\s*max|hit\s*point\s*maximum|hpmax)\b\s*[:=]?\s*(\d{1,3})\b/i) || num(/\b(?:hit\s*points|hp)\b\s*[:=]?\s*(?:\d{1,3}\s*\/\s*)?(\d{1,3})\b/i);
  const speed = num(/\b(?:walking\s*)?speed\b\s*[:=]?\s*(\d{2,3})/i) || num(/\bwalking\b\s*[:=]?\s*(\d{2,3})/i) || 30;
  const fly = num(/\bfly(?:ing)?(?:\s*speed)?\b\s*[:=]?\s*(\d{2,3})/i) || 0;
  const init = num(/\binit(?:iative)?\b\s*[:=]?\s*([+-]?\d{1,2})\b/i);
  // saves: "Saving Throws: Str +7, Con +6", "ST Strength +7", "Strength Save +7"
  const saveVals = {}, saveProf = [];
  const stLine = t.match(/saving throws?\s*[:=]?\s*([^\n]+)/i);
  ABS.forEach(k => {
    let mm2 = stLine && stLine[1].match(new RegExp(`\\b(?:${k}|${ABN[k]})\\w*\\s*([+-]\\d{1,2})`, 'i'));
    if (!mm2) mm2 = t.match(new RegExp(`\\b(?:ST\\s*${ABN[k]}|${ABN[k]}\\s*sav(?:e|ing throw)|${k}\\s*save)\\b\\s*[:=]?\\s*([+-]?\\d{1,2})\\b`, 'i'));
    if (mm2) saveVals[k] = +mm2[1];
  });
  // saving throw proficiency marks: "Saving Throw Proficiencies: Strength, Constitution"
  const spl = t.match(/saving throw proficienc\w*\s*[:=]?\s*([^\n]+)/i);
  if (spl) ABS.forEach(k => { if (new RegExp(`\\b(?:${k}|${ABN[k]})\\b`, 'i').test(spl[1])) saveProf.push(k); });
  // attacks: "Longsword +7 1d8+4 slashing", table rows, "Wpn1 AtkBonus: +7" fields
  const attacks = [];
  const seen = {};
  const push = (nm, hit, dmg, type, extra) => {
    nm = nm.replace(/^[-*•\s|:]+|[\s|:,-]+$/g, '').replace(/\s{2,}/g, ' ');
    if (!nm || nm.length > 40 || /^(attacks?|name|atk|bonus|damage|hit|weapon)$/i.test(nm) || seen[nm.toLowerCase()]) return;
    seen[nm.toLowerCase()] = 1;
    const fb = weaponOf(nm);
    let range = extra && extra.range;
    if (!range) range = fb ? fb.w[2] : /\b(bow|crossbow|sling|dart|gun|pistol|musket|blast|bolt|ray)\b/i.test(nm) ? 60 : 5;
    attacks.push({ name: titleCase(nm), toHit: +hit, dmg: dmg.replace(/\s+/g, '').replace(/([+-])/g, ' $1 ').trim(), type: (type || (fb ? fb.w[1] : '')).toLowerCase(), range });
  };
  // fillable sheet fields first
  for (let i = 1; i <= 8; i++) {
    const g = k => { const mm2 = t.match(new RegExp(`^\\s*${k}\\s*[:=]\\s*(.+)$`, 'im')); return mm2 ? mm2[1].trim() : ''; };
    const nm = g(i === 1 ? `wpn\\s*name(?:\\s*1)?` : `wpn\\s*name\\s*${i}`), hit = g(`wpn\\s*${i}\\s*atk\\s*bonus`), dmg = g(`wpn\\s*${i}\\s*damage`);
    if (nm && /[+-]?\d/.test(hit)) { const dd = dmg.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?|\b\d+\b)/); if (dd) push(nm, hit.match(/[+-]?\d+/)[0], dd[1], (dmg.match(DTYPES) || [])[1]); }
  }
  const atkRe = /(^|\n)\s*([A-Za-z][A-Za-z' ,()+-]{1,40}?)\s*(?:[|\t]|\s{2,}|\n|\s)\s*(?:(?:(\d{1,3})(?:\/\d{1,3})?\s*ft\.?(?:\s*\(\d+\))?|reach\s*\d+\s*ft\.?|range\s*\d+(?:\/\d+)?\s*ft\.?)\s*[|\t\n,]?\s*)?([+-]\d{1,2})\s*(?:to hit)?\s*[|\t\n,]?\s*(?:hit:?\s*)?(?:\d+\s*\()?(\d+d\d+(?:\s*[+-]\s*\d+)?)\)?\s*(?:[|\t\n,]\s*)?([A-Za-z]+)?/g;
  while ((m = atkRe.exec(t))) {
    const nm = m[2].trim();
    if (/^(dc|save|spell|str|dex|con|int|wis|cha|initiative|proficiency|bonus)\b/i.test(nm)) continue;
    push(nm, m[4], m[5], DTYPES.test(m[6] || '') ? m[6] : '', m[3] ? { range: +m[3] } : null);
    atkRe.lastIndex = m.index + m[0].length - (m[6] && !DTYPES.test(m[6]) ? m[6].length : 0);
  }
  // spells: names from the spell list that stand alone on a line or in a comma list
  const SD = root.SpellData || {};
  const spells = [];
  const items = t.toLowerCase().split(/\n|,|;|•|\|/).map(s => s.replace(/\([^)]*\)|\[[^\]]*\]|^[\s*\-–o◯●○✓x]+|\s*(?:\d+(?:st|nd|rd|th)?\s*(?:level)?|cantrip|ritual|concentration|[cr]\b)\s*$/gi, '').replace(/^\s*(?:spell\s*name\s*\d*|spells?|cantrips?|prepared|known|\d+(?:st|nd|rd|th)\s*level|level\s*\d)\s*[:=]?\s*/i, '').trim());
  items.forEach(s => { if ((SD[s] || CUSTOM[s]) && !spells.includes(s)) spells.push(s); });
  const slots = [];
  const slotRe = /\b(?:([1-9])(?:st|nd|rd|th)|level\s*([1-9]))(?:[-\s]level)?(?:\s*spell)?\s*(?:slots?)?\s*[:=]?\s*(?:\d+\s*(?:\/|of)\s*)?(\d)\s*(?:slots?|total|\/|$|\n|\s)/gi;
  while ((m = slotRe.exec(t))) { const lv = +(m[1] || m[2]); if (!slots[lv - 1] && /slot/i.test(t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 10))) slots[lv - 1] = +m[3]; }
  const dc = num(/\bspell\s*save\s*dc\b\s*[:=]?\s*(\d{1,2})/i), satk = num(/\bspell\s*attack(?:\s*bonus)?\b\s*[:=]?\s*([+-]?\d{1,2})/i);
  const resist = [];
  const rl = t.match(/\bresistances?\b\s*[:=]?\s*([^\n]+)/i);
  if (rl) (rl[1].match(new RegExp(DTYPES.source, 'gi')) || []).forEach(x => resist.push(x.toLowerCase()));
  // features & traits: D&D Beyond PDF fields hold "* Name • PHB 48" entries under "=== SECTION ===" headings, split over FeaturesTraits1, 2, 3…
  const ftFields = lines.map(l => l.match(/^FeaturesTraits(\d*)\s*:\s*(.*)$/i)).filter(Boolean).sort((a, b) => (+a[1] || 0) - (+b[1] || 0));
  const ftText = ftFields.map(x => x[2]).join(' ');
  const featList = [];
  const marks = [], fre = /===\s*([^=]+?)\s*===|(?:^|[\s,])\*\s+([^*•|,=]{2,60}?)\s*•/g;
  while ((m = fre.exec(ftText))) marks.push({ at: m.index, end: m.index + m[0].length, head: m[1], name: m[2] });
  let section = '';
  marks.forEach((k, i) => {
    if (k.head) { section = k.head.trim(); return; }
    const body = ftText.slice(k.end, i + 1 < marks.length ? marks[i + 1].at : ftText.length), um = body.match(/\|\s*(\d+)\s*\/\s*(Long|Short)\s*Rest/i);
    const nm = k.name.trim();
    if (!featList.some(x => x.name.toLowerCase() === nm.toLowerCase())) featList.push({ name: nm, section, body, uses: um ? +um[1] : 0, reset: um ? (/^s/i.test(um[2]) ? 'sr' : 'lr') : '' });
  });
  // a subclass the class line leaves out: "Primal Path • PHB 48 … | Path of the Ancestral Guardian"
  const sp1 = ftText.match(/\*\s+(?:Primal Path|Martial Archetype|Roguish Archetype|Arcane Tradition|Monastic Tradition|Sacred Oath|Divine Domain|Druid Circle|Bard College|Otherworldly Patron|Sorcerous Origin|Ranger Archetype|Ranger Conclave)\b[^|*]*\|\s*([^*|,]{3,50})/i);
  if (sp1 && classes.length === 1 && !classes[0].sub) classes[0].sub = sp1[1].trim().replace(/^(?:path|college|circle|oath|school|way|domain) of (?:the )?/i, '');
  // equipment: Eq Name0 / Eq Qty0 …, and the coin fields
  const eq = {};
  lines.forEach(l => { const e = l.match(/^Eq\s*(Name|Qty)\s*(\d+)\s*:\s*(.+)$/i); if (e) (eq[e[2]] = eq[e[2]] || {})[e[1].toLowerCase()] = e[3].trim(); });
  const inventory = [];
  Object.keys(eq).sort((a, b) => a - b).forEach(k => {
    if (!eq[k].name) return;
    const q = parseInt(eq[k].qty, 10) || 1, have = inventory.find(x => x.name.toLowerCase() === eq[k].name.toLowerCase());
    if (have) have.qty += q; else inventory.push({ name: eq[k].name, qty: q });
  });
  const coins = {};
  lines.forEach(l => { const c = l.match(/^(CP|SP|EP|GP|PP)\s*:\s*(\d+)\s*$/); if (c && +c[2]) coins[c[1].toLowerCase()] = +c[2]; });
  return { name: name.trim(), classes, scores: sc, hp, ac, speed, fly, init, saveVals, saveProf, attacks, spells, slots: slots.length ? slots : null, dc, spellAtk: satk, resist, notes, featList, inventory, coins, featuresText: ftText, src: 'text' };
}

/* ---------- class features the War Table has rules for ---------- */
function classFeatures(f, pb, add, ext, used) {
  const sc = f.scores, M = i => mod(sc[i]);
  const lv = n => { const c = f.classes.find(x => x.name === n); return c ? c.level : 0; };
  const sub = n => { const c = f.classes.find(x => x.name === n); return c ? c.sub || '' : ''; };
  // with a feature list on the sheet, a feature counts only if it is listed (so 2024 sheets don't get 2014 features); without one, class level decides
  const ent = n => (f.featList || []).find(x => x.name.toLowerCase() === n);
  const has = (n, ok) => !!ok && (!(f.featList && f.featList.length) || !!ent(n));
  const fi = lv('fighter'), bb = lv('barbarian'), ro = lv('rogue'), mo = lv('monk'), pa = lv('paladin'), ba = lv('bard');
  if (fi) {
    add({ name: 'Second Wind', actionSlot: 1, freq: { reset: 'lr', uses: fi >= 10 ? 4 : fi >= 4 ? 3 : 2 }, condition: 'is under half HP', type: 'heal', amount: `1d10 + ${fi}`, target: 'self' });
    if (/champion/i.test(sub('fighter')) && fi >= 3) ext.critRange = fi >= 15 ? 18 : 19;
  }
  if (bb) {
    const dmg = bb >= 16 ? 4 : bb >= 9 ? 3 : 2;
    const rg = ent('rage');
    add({ name: 'Rage', actionSlot: 1, freq: { reset: 'lr', uses: rg && rg.uses ? rg.uses : bb >= 17 ? 6 : bb >= 12 ? 5 : bb >= 6 ? 4 : bb >= 3 ? 3 : 2 }, condition: 'not used yet', type: 'buff', target: 'self',
      buff: { duration: 'entire encounter', damage: String(dmg) }, ext: { endsOnIncap: true, resist: ['bludgeoning', 'piercing', 'slashing'] } });
    used.push('rage');
    if (bb >= 2) { add({ name: 'Reckless Attack', actionSlot: 5, type: 'buff', target: 'self', buff: { duration: 'entire encounter', condition: 'Attacks and is attacked with Advantage' } }); used.push('reckless attack'); }
    if (has('danger sense', bb >= 2)) { ext.dexSaveAdvantage = true; used.push('danger sense'); }
    if (has('feral instinct', bb >= 7)) { ext.initAdvantage = true; used.push('feral instinct'); }
    if (has('brutal critical', bb >= 9)) { ext.brutalCritical = bb >= 17 ? 3 : bb >= 13 ? 2 : 1; used.push('brutal critical'); }
    if (has('relentless rage', bb >= 11)) { ext.relentlessRage = { hp: 2 * bb }; used.push('relentless rage'); }
  }
  if (ro) {
    ext.sneakAttack = { dice: `${Math.ceil(ro / 2)}d6` };
    if (ro >= 2) add({ name: 'Cunning Action: Hide', actionSlot: 1, type: 'buff', target: 'self', buff: { duration: '1 round', condition: 'Invisible' }, ext: { successChance: 0.75 } });
    if (ro >= 5) add({ name: 'Uncanny Dodge', actionSlot: 4, type: 'buff', target: 'self', buff: { duration: 'until next attack taken', damageTakenMultiplier: 0.5 } });
  }
  if (mo) {
    const die = mo >= 17 ? 'd12' : mo >= 11 ? 'd10' : mo >= 5 ? 'd8' : 'd6', dm = Math.max(M(0), M(1));
    if (mo >= 2) ext.resources = Object.assign(ext.resources || {}, { 'Focus Points': { uses: mo, reset: 'sr' } });
    if (!f.attacks.some(a => /unarmed/i.test(a.name))) f.attacks.push({ name: 'Unarmed Strike', toHit: dm + pb, dmg: `1${die} + ${dm}`, type: 'bludgeoning', range: 5 });
    add({ name: 'Martial Arts (bonus strike)', actionSlot: 1, type: 'atk', dpr: `1${die} + ${dm}`, toHit: dm + pb, target: 'enemy with least HP', ext: { range: 5, damageType: 'bludgeoning' } });
    if (mo >= 3) add({ name: 'Deflect Attacks', actionSlot: 4, type: 'buff', target: 'self', buff: { duration: 'until next attack taken', damageReduction: `1d10 + ${M(1) + mo}` } });
    if (mo >= 2) add({ name: 'Patient Defense (1 Focus Point)', actionSlot: 1, condition: 'is under half HP', type: 'buff', target: 'self', buff: { duration: '1 round', condition: 'Is attacked with Disadvantage' }, ext: { resource: 'Focus Points' } });
  }
  // Goliath's Stone's Endurance: a reaction that cuts one hit's damage (dice and uses as the sheet states them)
  const se = ent("stone's endurance") || ent('stone’s endurance');
  if (se) {
    const dd = se.body.match(/reduce the damage (?:taken )?by (\d+d\d+(?:\s*\+\s*\d+)?)/i);
    add({ name: "Stone's Endurance", actionSlot: 4, freq: { reset: se.reset || 'lr', uses: se.uses || pb }, type: 'buff', target: 'self', buff: { duration: 'until next attack taken', damageReduction: dd ? dd[1].replace(/\s*\+\s*/, ' + ') : `1d12 + ${M(2)}` } });
    used.push("stone's endurance");
  }
  const tr = (f.traits || []).join('|') + '|' + (f.featuresText || '');
  if (/nimble escape|cunning action/i.test(tr)) ext.bonusDisengage = true;
  if (pa) add({ name: 'Lay on Hands', actionSlot: 1, freq: { reset: 'lr', uses: 5 * pa }, condition: 'ally under half HP', type: 'heal', amount: '1', target: 'ally with the least HP', ext: { range: 5, pool: { dice: 5 * pa, die: 1, maxPer: 5 * pa } } });
  if (ba) {
    const die = ba >= 15 ? 'd12' : ba >= 10 ? 'd10' : ba >= 5 ? 'd8' : 'd6';
    add({ name: 'Bardic Inspiration', actionSlot: 1, freq: { reset: ba >= 5 ? 'sr' : 'lr', uses: Math.max(1, M(5)) }, type: 'buff', target: 'ally with the highest DPR', buff: { duration: 'until next attack made', toHit: '1' + die }, ext: { range: 60 } });
  }
  return { fi, bb, ro, mo, pa };
}

/* ---------- the creature ---------- */
function build(f, opts) {
  opts = opts || {};
  const notes = (f.notes || []).slice();
  if (!f.classes || !f.classes.length) { f.classes = [{ name: 'fighter', level: 1, sub: '' }]; notes.push("Couldn't tell the class; set it on the sheet."); }
  f.classes.forEach(c => { if (!CLASSES[c.name]) notes.push(`${titleCase(c.name)}: not a class it knows; no class features added.`); });
  const level = Math.min(20, f.classes.reduce((t, c) => t + c.level, 0));
  const pb = pbOf(level), sc = f.scores, M = i => mod(sc[i]);
  const main = f.classes.slice().sort((a, b) => b.level - a.level)[0];
  const saveProf = f.saveProf && f.saveProf.length ? f.saveProf : ((CLASSES[f.classes[0].name] || {}).saves || []);
  const saves = {};
  ABS.forEach((k, i) => { saves[k] = f.saveVals && f.saveVals[k] !== undefined ? f.saveVals[k] : M(i) + (saveProf.includes(k) ? pb : 0); });
  const hp = f.hp || (() => { notes.push('No hit points found; used the class average.'); return Math.max(1, Math.round((5 + M(2)) * level + 3)); })();
  const ac = f.ac || (() => { notes.push('No AC found; used 10 + Dex.'); return 10 + M(1); })();
  const id = opts.id || 'pc-' + Math.random().toString(36).slice(2, 10);
  let n = 0;
  const aid = () => `${id}-a${++n}`;
  const actions = [];
  const add = a => actions.push(Object.assign({ freq: 'at will', condition: 'default', targets: 1 }, a, { id: aid() }));
  const ext = { speed: f.speed || 30, initBonus: f.init !== null && f.init !== undefined ? f.init : M(1), saves };
  if (f.fly) ext.fly = f.fly;
  if (f.resist && f.resist.length) ext.resist = Array.from(new Set(f.resist));
  const athl = M(0) + (!f.skills || f.skills.includes('athletics') ? pb : 0), acro = M(1) + (f.skills && f.skills.includes('acrobatics') ? pb : 0);
  if (f.size) ext.size = f.size;
  ext.athletics = athl; ext.escapeBonus = Math.max(athl, acro);

  const used = [];
  const cf = classFeatures(f, pb, add, ext, used);
  // weapon attacks: the best melee and the best ranged one lead; the rest stay War Table alternatives
  const extra = cf.fi >= 20 ? 4 : cf.fi >= 11 ? 3 : (cf.fi >= 5 || cf.bb >= 5 || cf.pa >= 5 || cf.mo >= 5 || lv(f, 'ranger') >= 5 || /valor|swords|bladesing/i.test(f.classes.map(c => c.sub).join(' ')) && level >= 6) ? 2 : 1;
  const avg = d => String(d).split(/\s*([+-])\s*/).reduce((s, p, i, arr) => { if (i % 2) return s; const sign = i && arr[i - 1] === '-' ? -1 : 1; const dm = p.match(/^(\d*)d(\d+)$/); return s + sign * (dm ? (+dm[1] || 1) * (+dm[2] + 1) / 2 : +p || 0); }, 0);
  const atks = (f.attacks || []).filter(a => a.dmg && !(root.SpellData || {})[String(a.name).toLowerCase()]);
  const melee = atks.filter(a => a.range <= 10).sort((a, b) => avg(b.dmg) * (20 + b.toHit) - avg(a.dmg) * (20 + a.toHit));
  const ranged = atks.filter(a => a.range > 10).sort((a, b) => avg(b.dmg) * (20 + b.toHit) - avg(a.dmg) * (20 + a.toHit));
  const isCaster = CLASSES[main.name] && (CLASSES[main.name].cast === 1 || main.name === 'warlock');
  let lead = null;
  const score = a => a ? avg(a.dmg) * (20 + a.toHit) : -1;
  const best = score(ranged[0]) > score(melee[0]) * 1.05 ? ranged[0] : melee[0] || ranged[0];
  [].concat(melee, ranged).forEach((a, i) => {
    const primary = a === best;
    const w = { name: `${a.name}${extra > 1 ? ` ×${extra}${primary ? ' (Extra Attack)' : ''}` : ''}`, actionSlot: 0, type: 'atk', dpr: a.dmg, toHit: a.toHit, targets: extra, target: 'enemy with least HP',
      ext: { range: a.range, damageType: a.type || undefined } };
    if (!w.ext.damageType) delete w.ext.damageType;
    if (cf.ro) { w.dpr = `${a.dmg} + ${ext.sneakAttack.dice}`; w.ext.wtDpr = a.dmg; w.ext.sneak = true; }
    if (!primary || (isCaster && f.spells && f.spells.length)) w.ext.wtOnly = true;
    add(w);
    if (primary) lead = actions[actions.length - 1];
  });
  if (cf.fi >= 2 && lead) add(Object.assign(JSON.parse(JSON.stringify(lead)), { name: `Action Surge (${extra > 1 ? extra + ' more attacks' : 'one more attack'})`, actionSlot: 1, freq: { reset: 'sr', uses: cf.fi >= 17 ? 2 : 1 }, ext: Object.assign({}, lead.ext, { wtOnly: undefined }) }));
  if (cf.mo >= 2 && lead) {
    const wis = M(4), dc = 8 + pb + wis;
    if (cf.mo >= 5) add(Object.assign(JSON.parse(JSON.stringify(lead)), { name: `Stunning Strike (${lead.name.replace(/ \(Extra Attack\)/, '')}, 1 Focus Point)`, condition: 'is available', target: 'enemy with highest DPR',
      riderEffect: { dc, buff: { duration: '1 round', condition: 'Stunned' } }, ext: Object.assign({}, lead.ext, { riderSave: 'con', resource: 'Focus Points' }) }));
    if (f.classes.some(c => c.name === 'monk' && /element/i.test(c.sub))) {
      const att = { name: 'Elemental Attunement (1 Focus Point)', actionSlot: -3, type: 'buff', target: 'self', buff: { duration: 'entire encounter' }, ext: { resource: 'Focus Points' } };
      add(att);
      const attId = actions[actions.length - 1].id;
      actions[actions.length - 1].ext.grantsBuff = { id: attId, name: 'Elemental Attunement' };
      // reach 15 ft and a 10-ft push while attuned: ahead of the plain strikes
      actions.splice(actions.indexOf(lead), 0, Object.assign(JSON.parse(JSON.stringify(lead)), { id: aid(), name: `Elemental Strikes (${lead.name.replace(/ \(Extra Attack\)/, '')}, 15 ft, push)`,
        ext: Object.assign({}, lead.ext, { range: 15, requiresBuff: attId, onHit: { push: 10 } }) }));
    }
  }
  if (cf.mo >= 2) add({ name: 'Flurry of Blows (1 Focus Point)', actionSlot: 1, ext: { resource: 'Focus Points' }, type: 'atk', dpr: `1${cf.mo >= 17 ? 'd12' : cf.mo >= 11 ? 'd10' : cf.mo >= 5 ? 'd8' : 'd6'} + ${Math.max(M(0), M(1))}`, toHit: Math.max(M(0), M(1)) + pb, targets: cf.mo >= 10 ? 3 : 2, target: 'enemy with least HP' });
  if (cf.mo >= 2) Object.assign(actions[actions.length - 1].ext, { range: 5, damageType: 'bludgeoning' });
  if (!actions.some(a => a.actionSlot === 0 && a.type === 'atk' && !(a.ext && a.ext.wtOnly)) && !(f.spells && f.spells.length)) {
    const sm = Math.max(M(0), cf.mo ? M(1) : -9);
    add({ name: 'Unarmed Strike', actionSlot: 0, type: 'atk', dpr: cf.mo ? `1${cf.mo >= 5 ? 'd8' : 'd6'} + ${sm}` : String(Math.max(1, 1 + sm)), toHit: sm + pb, targets: extra, target: 'enemy with least HP', ext: { range: 5, damageType: 'bludgeoning' } });
    notes.push('No weapon attacks found; gave it an unarmed strike. Add its weapons on the sheet.');
  }

  if (extra > 1) used.push('extra attack');
  sheetNotes(f, used, actions).forEach(x => notes.push(x));

  // spells
  const SD = root.SpellData || {}, spellAction = root.StatblockParser && root.StatblockParser._internals.spellAction;
  const casters = f.classes.filter(c => CLASSES[c.name] && CLASSES[c.name].cast);
  if (f.spells && f.spells.length && spellAction) {
    const ab = (CLASSES[(casters.slice().sort((a, b) => b.level - a.level)[0] || main).name] || {}).ab || 'int';
    const m = M(ABS.indexOf(ab));
    const sctx = { dc: f.dc || 8 + pb + m, atk: f.spellAtk !== null && f.spellAtk !== undefined ? f.spellAtk : pb + m, mod: m, cantripDice: level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1 };
    let slots = f.slots;
    let reset = 'lr';
    const wl = casters.find(c => c.name === 'warlock');
    if (!slots) {
      let cl = 0;
      casters.forEach(c => { const k = CLASSES[c.name].cast; if (k === 1) cl += c.level; else if (k === 0.5) cl += CLASSES[c.name].roundUp ? Math.ceil(c.level / 2) : Math.floor(c.level / 2); });
      f.classes.forEach(c => { if (THIRD.test(c.sub) && (c.name === 'fighter' || c.name === 'rogue')) cl += Math.floor(c.level / 3); });
      if (casters.length === 1 && CLASSES[casters[0].name].cast === 0.5) cl = Math.ceil(casters[0].level / 2);   // a single-class paladin, ranger or artificer
      slots = (SLOTS[Math.min(20, cl)] || []).slice();
      if (wl) { const p = PACT(wl.level); if (!cl) reset = 'sr'; slots[p.lvl - 1] = (slots[p.lvl - 1] || 0) + p.n; if (cl) notes.push('Pact slots are added to the regular slots and come back on a long rest.'); }
    }
    slots = Array.from({ length: 9 }, (x, i) => +(slots[i] || 0));
    const top = slots.reduce((t, s, i) => s ? i + 1 : t, 0);
    const out = [], skipped = [];
    f.spells.forEach((nm0, i) => {
      const nm = String(nm0).toLowerCase().trim(), d = SD[nm];
      if (!d && CUSTOM[nm]) { if (CUSTOM[nm].level <= top) out.push(Object.assign(JSON.parse(JSON.stringify(CUSTOM[nm])), { name: titleSmall(nm), id: `${id}-s${i + 1}` })); return; }
      if (!d) { skipped.push(titleCase(nm0)); return; }
      if (d.L > top && d.L > 0) { skipped.push(titleCase(nm0) + ' (no slot that high)'); return; }
      const sp = spellAction(nm, d, sctx, { level: d.L });
      delete sp._avg;
      sp.name = titleSmall(nm);
      if (nm === 'eldritch blast' && /agonizing blast/i.test(opts.text || '')) sp.dpr = `1d10 + ${m}`;
      sp.id = `${id}-s${i + 1}`;
      out.push(sp);
    });
    if (skipped.length) notes.push(`Not in its spell list (no rules for them yet): ${skipped.slice(0, 12).join(', ')}${skipped.length > 12 ? '…' : ''}.`);
    if (out.length) { ext.spellbook = { slots, slotReset: reset, spells: out, conSave: saves.con }; if (top === 0 && out.some(s => s.level > 0)) notes.push('No spell slots found.'); }
  }
  // within each slot, the plain at-will options go last so pooled, conditional and limited ones get their turn
  const plain = a => a.condition === 'default' && a.freq === 'at will' && !(a.ext && (a.ext.resource || a.ext.requiresBuff || a.ext.wtOnly));
  Array.from(new Set(actions.map(a => a.actionSlot))).forEach(sl => {
    const at = [], list = [];
    actions.forEach((a, i) => { if (a.actionSlot === sl) { at.push(i); list.push(a); } });
    const sorted = list.filter(a => !plain(a)).concat(list.filter(plain));
    at.forEach((i, k) => { actions[i] = sorted[k]; });
  });
  const avgSave = Math.round(ABS.reduce((t, k) => t + saves[k], 0) / 6 * 100) / 100;
  const cls = { type: CLASSES[main.name] ? main.name : 'fighter', level, options: {} };
  ext.build = f.classes.map(c => `${titleCase(c.name)} ${c.level}${c.sub ? ` (${c.sub})` : ''}`).join(' / ') + ` · read from ${f.src === 'text' ? 'a pasted sheet' : f.src}`;
  const c = { id, mode: 'custom', class: cls, name: (f.name || 'Adventurer').slice(0, 60), count: 1, hp, AC: ac, saveBonus: avgSave, ext, actions };
  if (notes.length) c._notes = notes;
  return c;
}
/* what the sheet lists that the War Table has no rules for, as short name-only notes: features and traits, then the pack */
const STATED = /^(fast movement|unarmored defense|unarmored movement)$/i;
const ARMOR = /\b(?:padded|studded leather|leather armor|hide armor|chain shirt|scale mail|breastplate|half plate|ring mail|chain mail|splint|plate(?: armor)?)\b|\bshield\b/i;
function sheetNotes(f, used, actions) {
  const key = n => n.toLowerCase().replace(/’/g, "'");
  const out = [], list = f.featList || [], inv = f.inventory || [];
  const names = a => a.map(x => x.name + (x.qty > 1 ? ' \u00d7' + x.qty : ''));
  const line = (label, a) => { if (a.length) out.push(label + ': ' + a.join(', ') + '.'); };
  if (list.length) {
    line('Used in fights', list.filter(x => used.indexOf(key(x.name)) >= 0).map(x => x.name));
    line('Already in the stated speed and AC', list.filter(x => STATED.test(x.name)).map(x => x.name));
    const bySection = {};
    list.filter(x => used.indexOf(key(x.name)) < 0 && !STATED.test(x.name)).forEach(x => { const k = x.section || 'Other'; (bySection[k] = bySection[k] || []).push(x.name); });
    Object.keys(bySection).forEach(k => line(titleCase(k.toLowerCase()).replace(/\bTraits\b/, 'traits').replace(/\bFeatures\b/, 'features').replace(/\bSpecies\b/, 'species') + ' (no fight rules)', bySection[k]));
  }
  if (inv.length) {
    const atk = actions.map(a => a.name.toLowerCase()).join('|');
    const rest = [], weapons = [], armor = [], heal = [], magic = [];
    inv.forEach(it => {
      const n = it.name, w = weaponOf(n);
      if (/\bpotions?\b.*\bhealing\b|\bhealing\b.*\bpotions?\b/i.test(n)) heal.push(it);
      else if (ARMOR.test(n)) armor.push(it);
      else if (w && !/\b(tools?|kit|pot|case)\b/i.test(n)) { if (atk.indexOf(w.key) < 0) weapons.push(it); }
      else if (/\b(potions?|scrolls?|wand|rod|staff of|ring of|cloak of|boots of|amulet|bracers?|gauntlets?|helm|belt of|elixir)\b/i.test(n)) magic.push(it);
      else rest.push(it);
    });
    line('Healing potions (no use rule yet)', names(heal));
    line('Weapons in the pack with no attack bonus or damage on the sheet', names(weapons));
    line('Armor and shields (the stated AC is used as is)', names(armor));
    line('Magic items and other consumables', names(magic));
    const gear = names(rest), c = f.coins || {}, coins = ['pp', 'gp', 'ep', 'sp', 'cp'].filter(k => c[k]).map(k => c[k] + ' ' + k);
    if (gear.length || coins.length) out.push('Other gear: ' + gear.slice(0, 14).join('; ') + (gear.length > 14 ? `; +${gear.length - 14} more` : '') + (coins.length ? (gear.length ? '; ' : '') + coins.join(' ') : '') + '.');
  }
  return out;
}
function lv(f, n) { const c = f.classes.find(x => x.name === n); return c ? c.level : 0; }

/* what kind of input it is, then the facts, then the creature */
function read(input, opts) {
  opts = opts || {};
  let obj = input;
  if (typeof input === 'string') {
    const s = input.trim();
    if (/^[{[]/.test(s)) { try { obj = JSON.parse(s); } catch (e) { obj = null; } } else obj = null;
    if (!obj) return { player: build(fromText(s), { text: s, id: opts.id }), source: 'text' };
  }
  if (obj && obj.data && (obj.data.stats || obj.data.classes)) obj = obj.data;          // the character-service wrapper
  if (obj && obj.stats && obj.classes && (obj.inventory || obj.modifiers)) return { player: build(fromDDB(obj), { id: opts.id, text: JSON.stringify(obj.classes) + JSON.stringify(obj.options || '') }), source: 'D&D Beyond' };
  if (obj && (obj.system || obj.data) && Array.isArray(obj.items) && (obj.type === 'character' || obj.type === 'npc' || (obj.system || obj.data).abilities)) return { player: build(fromFoundry(obj), { id: opts.id, text: JSON.stringify(obj.items.map(i => i.name)) }), source: 'Foundry VTT' };
  if (obj && obj.classes && obj.scores) return { player: build(Object.assign({ notes: [], src: obj.src || 'Claude', spells: [], attacks: [], saveProf: [] }, obj), { id: opts.id, text: (obj.features || []).join('\n') }), source: obj.src || 'Claude' };
  if (obj && (obj.players || obj.encounters)) throw new Error('That is a day file. Load it from Save & load (Load just the party).');
  throw new Error("That JSON isn't a character sheet it knows (D&D Beyond or Foundry VTT).");
}
/* the facts layout a reader (or Claude) can fill in, for the "convert with Claude" route */
const FACTS_SCHEMA = '{"name":string,"classes":[{"name":"fighter|wizard|…(lowercase)","level":number,"sub":"subclass name"}],"scores":[STR,DEX,CON,INT,WIS,CHA],"hp":max hit points,"ac":number,"speed":walking ft,"fly":fly ft or 0,"init":initiative bonus,"saveVals":{"str":total save bonus,…all six},"attacks":[{"name":string,"toHit":number,"dmg":"1d8 + 4","type":"slashing","range":5 for melee/10 for reach/normal range in ft for ranged}],"spells":["spell names the character has prepared or knows, cantrips included"],"slots":[max slots for levels 1..9],"dc":spell save DC,"spellAtk":spell attack bonus,"resist":["damage types"],"features":["one line per class feature, feat or trait that matters in a fight"]}';

root.SheetReader = { read, fromText, fromDDB, fromFoundry, build, FACTS_SCHEMA };
})(typeof globalThis !== 'undefined' ? globalThis : this);
