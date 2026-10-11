/* Builds data/party.js: a generic level-5 character for every class (2024 rules) and the default party.
   Run: node tools/build-party.js
   Spells come from js/spell-data.js through the statblock parser's own spell builder, so a spell
   behaves the same on a PC as on a monster. Features the engine has no rule for are approximated
   in the plainest way that keeps the numbers right, and say so in their name or a note. */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
for (const f of ['js/spell-data.js', 'js/statblock-parser.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
const S = ctx.SpellData, spellAction = ctx.StatblockParser._internals.spellAction;

const PB = 3, LEVEL = 5;
const mod = s => Math.floor((s - 10) / 2);
const ABS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const titleCase = s => s.replace(/(^|[\s\/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/'S\b/g, "'s");

/* one character */
function build(def) {
  const sc = def.scores, saveProf = def.saves;
  const saves = {}; ABS.forEach((k, i) => { saves[k] = mod(sc[i]) + (saveProf.includes(k) ? PB : 0); });
  const avgSave = Math.round(ABS.reduce((t, k) => t + saves[k], 0) / 6 * 100) / 100;
  const id = 'c5-' + def.cls;
  let n = 0;
  const aid = () => `${id}-a${++n}`;
  const actions = def.actions.map(a => Object.assign({ id: aid(), freq: 'at will', condition: 'default', targets: 1 }, a));
  const c = {
    id, mode: 'custom', class: { type: def.cls, level: LEVEL, options: {} },
    name: def.name, count: 1, hp: def.hp, AC: def.ac, saveBonus: avgSave,
    ext: Object.assign({ speed: def.speed || 30, initBonus: mod(sc[1]), saves, build: def.build }, def.ext || {}),
    actions,
  };
  const athl = mod(sc[0]) + (def.athletics ? PB : 0), acro = mod(sc[1]) + (def.acrobatics ? PB : 0);
  c.ext.athletics = athl; c.ext.escapeBonus = Math.max(athl, acro);
  if (def.spells) {
    const ab = def.spells.ability, m = mod(sc[ABS.indexOf(ab)]);
    const sctx = { dc: 8 + PB + m, atk: PB + m, mod: m, cantripDice: 2 };
    const spells = def.spells.list.map((x, i) => {
      const name = typeof x === 'string' ? x : x.name;
      let sp;
      if (x.custom) sp = Object.assign({ name: titleCase(name) }, x.custom);
      else {
        const d = S[name]; if (!d) throw new Error(`${def.cls}: no spell data for ${name}`);
        sp = spellAction(name, d, sctx, { level: d.L });
        delete sp._avg;
        sp.name = titleCase(name);
      }
      if (x.patch) x.patch(sp, sctx);
      sp.id = `${id}-s${i + 1}`;
      return sp;
    });
    c.ext.spellbook = { slots: def.spells.slots, slotReset: def.spells.reset || 'lr', spells };
    if (def.spells.recovery) c.ext.spellbook.recovery = def.spells.recovery;
    c.ext.spellbook.conSave = saves.con;
  }
  return c;
}

/* shared bits */
const wpn = (name, dice, toHit, dtype, range, extra) => Object.assign({ name, actionSlot: 0, type: 'atk', dpr: dice, toHit, target: 'enemy with least HP', ext: Object.assign({ range, damageType: dtype }, extra || {}) });
const sap = { riderEffect: { dc: 99, buff: { duration: 'until next attack made', condition: 'Attacks with Disadvantage' } } };
const healAlly = (name, amount, extra) => Object.assign({ name, actionSlot: 1, type: 'heal', amount, target: 'ally with the least HP', condition: 'ally under half HP' }, extra || {});

const DEFS = [
  { cls: 'barbarian', name: 'Barbarian', build: 'Path of the Berserker · Greataxe (Cleave)', hp: 55, ac: 15, speed: 40, athletics: true,
    scores: [18, 14, 16, 8, 12, 10], saves: ['str', 'con'],
    actions: [
      { name: 'Rage', actionSlot: 1, freq: { reset: 'lr', uses: 3 }, condition: 'not used yet', type: 'buff', target: 'self',
        buff: { duration: 'entire encounter', damage: '2' }, ext: { endsOnIncap: true, resist: ['bludgeoning', 'piercing', 'slashing'] } },
      Object.assign(wpn('Greataxe ×2 (Extra Attack)', '1d12 + 4', 7, 'slashing', 5), { targets: 2 }),
      Object.assign(wpn('Handaxe ×2 (thrown)', '1d6 + 4', 7, 'slashing', 20, { wtOnly: true }), { targets: 2 }),
      { name: 'Reckless Attack', actionSlot: 5, type: 'buff', target: 'self', buff: { duration: 'entire encounter', condition: 'Attacks and is attacked with Advantage' } },
    ] },
  { cls: 'bard', name: 'Bard', build: 'College of Lore · Bardic Inspiration d8, Cutting Words', hp: 38, ac: 14,
    scores: [8, 14, 14, 12, 10, 18], saves: ['dex', 'cha'], acrobatics: true,
    actions: [
      wpn('Rapier', '1d8 + 2', 5, 'piercing', 5),
      { name: 'Bardic Inspiration', actionSlot: 1, freq: { reset: 'sr', uses: 4 }, type: 'buff', target: 'ally with the highest DPR', buff: { duration: 'until next attack made', toHit: '1d8' }, ext: { range: 60 } },
      { name: 'Cutting Words', actionSlot: 4, freq: { reset: 'sr', uses: 2 }, type: 'debuff', target: 'enemy with highest DPR', saveDC: 99, buff: { duration: 'until next attack made', condition: 'Attacks with Disadvantage' }, ext: { range: 60 } },
    ],
    spells: { ability: 'cha', slots: [4, 3, 2, 0, 0, 0, 0, 0, 0], list: ['vicious mockery', 'sorcerous burst', 'healing word', 'dissonant whispers', 'faerie fire', "tasha's hideous laughter", 'shatter', 'hold person', 'hypnotic pattern', 'mass healing word'] } },
  { cls: 'cleric', name: 'Cleric', build: 'Life Domain · Protector · Disciple of Life (+2 + level to healing spells)', hp: 38, ac: 18,
    scores: [14, 10, 14, 8, 18, 12], saves: ['wis', 'cha'],
    actions: [
      { name: 'Preserve Life (Channel Divinity)', actionSlot: 0, freq: { reset: 'sr', uses: 1 }, condition: 'ally under half HP', type: 'heal', targets: 3, amount: '8', target: 'ally with the least HP', ext: { range: 30 } },
      wpn('Mace', '1d6 + 2', 5, 'bludgeoning', 5),
      { name: 'Spiritual Weapon (strike)', actionSlot: 1, type: 'atk', dpr: '1d8 + 4', toHit: 7, target: 'enemy with least HP', ext: { range: 60, damageType: 'force', requiresBuff: 'c5-cleric-s11', magical: true } },
    ],
    spells: { ability: 'wis', slots: [4, 3, 2, 0, 0, 0, 0, 0, 0], list: [
      'sacred flame', 'toll the dead',
      { name: 'cure wounds', patch: sp => { sp.amount += ' + 3'; } },
      { name: 'healing word', patch: sp => { sp.amount += ' + 3'; } },
      'bless', 'guiding bolt', 'shield of faith',
      { name: 'aid', custom: { level: 2, actionSlot: 0, targets: 3, type: 'heal', amount: '5', upcast: '5', target: 'ally with the least HP', ext: { range: 30, aid: true } } },
      'hold person', 'spirit guardians',
      { name: 'spiritual weapon', custom: { level: 2, concentration: true, actionSlot: 1, targets: 1, type: 'atk', dpr: '1d8 + 4', toHit: 7, target: 'enemy with least HP', upcast: '1d8',
        ext: { range: 60, damageType: 'force', grantsBuff: { id: 'c5-cleric-s11', name: 'Spiritual Weapon' } } } },
      { name: 'mass healing word', patch: sp => { sp.amount += ' + 5'; } },
    ] } },
  { cls: 'druid', name: 'Druid', build: 'Circle of the Stars · Starry Form: Archer', hp: 38, ac: 15,
    scores: [8, 14, 14, 12, 18, 10], saves: ['int', 'wis'],
    actions: [
      { name: 'Starry Form: Archer (Wild Shape) + Luminous Arrow', actionSlot: 1, freq: { reset: 'lr', uses: 2 }, condition: 'not used yet', type: 'atk', dpr: '1d8 + 4', toHit: 7, target: 'enemy with least HP',
        ext: { range: 60, damageType: 'radiant', magical: true, grantsBuff: { id: 'c5-druid-starry', name: 'Starry Form' } } },
      { name: 'Luminous Arrow', actionSlot: 1, type: 'atk', dpr: '1d8 + 4', toHit: 7, target: 'enemy with least HP', ext: { range: 60, damageType: 'radiant', requiresBuff: 'c5-druid-starry', magical: true } },
      wpn('Quarterstaff', '1d6 - 1', 2, 'bludgeoning', 5),
    ],
    spells: { ability: 'wis', slots: [4, 3, 2, 0, 0, 0, 0, 0, 0], list: ['produce flame', 'thorn whip', 'healing word', 'cure wounds', 'entangle', 'guiding bolt', 'thunderwave', 'fog cloud', 'moonbeam', 'call lightning'] } },
  { cls: 'fighter', name: 'Fighter', build: 'Champion · Longsword & shield, Dueling, Sap mastery · crits on 19–20', hp: 49, ac: 18, athletics: true,
    scores: [18, 12, 16, 10, 12, 8], saves: ['str', 'con'], ext: { critRange: 19 },
    actions: [
      Object.assign(wpn('Longsword ×2 (Extra Attack)', '1d8 + 6', 7, 'slashing', 5), { targets: 2 }, sap),
      Object.assign(wpn('Heavy Crossbow ×2', '1d10 + 1', 4, 'piercing', 100, { wtOnly: true }), { targets: 2 }),
      Object.assign({ name: 'Action Surge (two more attacks)', actionSlot: 1, freq: { reset: 'sr', uses: 1 }, type: 'atk', dpr: '1d8 + 6', toHit: 7, targets: 2, target: 'enemy with least HP', ext: { range: 5, damageType: 'slashing' } }, sap),
      { name: 'Second Wind', actionSlot: 1, freq: { reset: 'lr', uses: 3 }, condition: 'is under half HP', type: 'heal', amount: '1d10 + 5', target: 'self' },
    ] },
  { cls: 'monk', name: 'Monk', build: 'Warrior of the Open Hand · Martial Arts d8, 5 Focus Points', hp: 38, ac: 17, speed: 40, acrobatics: true,
    scores: [10, 18, 14, 8, 16, 12], saves: ['str', 'dex'],
    actions: [
      Object.assign({ name: 'Stunning Strike (2 attacks)', actionSlot: 0, freq: { reset: 'sr', uses: 2 }, condition: 'default', type: 'atk', dpr: '1d8 + 4', toHit: 7, targets: 2, target: 'enemy with highest DPR',
        riderEffect: { dc: 14, buff: { duration: '1 round', condition: 'Stunned' } }, ext: { range: 5, damageType: 'bludgeoning', riderSave: 'con' } }),
      Object.assign(wpn('Unarmed Strike ×2 (Extra Attack)', '1d8 + 4', 7, 'bludgeoning', 5), { targets: 2 }),
      { name: 'Flurry of Blows (Open Hand: push)', actionSlot: 1, freq: { reset: 'sr', uses: 2 }, type: 'atk', dpr: '1d8 + 4', toHit: 7, targets: 2, target: 'enemy with least HP', ext: { range: 5, damageType: 'bludgeoning', onHit: { push: 15 } } },
      Object.assign(wpn('Martial Arts (bonus strike)', '1d8 + 4', 7, 'bludgeoning', 5), { actionSlot: 1 }),
      { name: 'Deflect Attacks', actionSlot: 4, type: 'buff', target: 'self', buff: { duration: 'until next attack taken', damageReduction: '1d10 + 9' } },
    ] },
  { cls: 'paladin', name: 'Paladin', build: 'Oath of Devotion · Longsword & shield, Dueling, Sap mastery', hp: 44, ac: 18, athletics: true,
    scores: [18, 8, 14, 10, 12, 16], saves: ['wis', 'cha'],
    actions: [
      Object.assign(wpn('Longsword ×2 (Extra Attack)', '1d8 + 6', 7, 'slashing', 5), { targets: 2 }, sap),
      Object.assign(wpn('Javelin ×2', '1d6 + 4', 7, 'piercing', 30, { wtOnly: true }), { targets: 2 }),
      { name: 'Lay on Hands', actionSlot: 1, freq: { reset: 'lr', uses: 25 }, condition: 'ally under half HP', type: 'heal', amount: '1', target: 'ally with the least HP',
        ext: { range: 5, pool: { dice: 25, die: 1, maxPer: 25 } } },
      { name: 'Sacred Weapon (Channel Divinity)', actionSlot: 1, freq: { reset: 'sr', uses: 1 }, condition: 'not used yet', type: 'buff', target: 'self', buff: { duration: 'entire encounter', toHit: 3 } },
    ],
    spells: { ability: 'cha', slots: [4, 2, 0, 0, 0, 0, 0, 0, 0], list: [
      { name: 'divine smite', custom: { level: 1, actionSlot: 1, targets: 1, type: 'buff', target: 'self', buff: { duration: 'until next attack made', damage: '2d8' }, ext: { range: 0 } } },
      'bless', 'cure wounds', 'shield of faith', 'command',
      { name: 'aid', custom: { level: 2, actionSlot: 0, targets: 3, type: 'heal', amount: '5', upcast: '5', target: 'ally with the least HP', ext: { range: 30, aid: true } } },
    ] } },
  { cls: 'ranger', name: 'Ranger', build: 'Hunter · Longbow (Slow mastery), Archery, Colossus Slayer', hp: 44, ac: 16, athletics: true,
    scores: [12, 18, 14, 10, 14, 8], saves: ['str', 'dex'],
    actions: [
      Object.assign(wpn('Longbow ×2 (Extra Attack)', '1d8 + 4', 9, 'piercing', 150, { onHit: { slow: 10 }, dprIfHurt: '1d8 + 4 + 1d4' }), { targets: 2 }),
      Object.assign(wpn('Shortsword ×2', '1d6 + 4', 7, 'piercing', 5, { onHit: { vex: true }, wtOnly: true }), { targets: 2 }),
      { name: "Hunter's Mark (Favored Enemy, free)", actionSlot: 1, freq: { reset: 'lr', uses: 2 }, condition: 'not used yet', type: 'buff', target: 'self', buff: { duration: 'entire encounter', damage: '1d6' } },
    ],
    spells: { ability: 'wis', slots: [4, 2, 0, 0, 0, 0, 0, 0, 0], list: ["hunter's mark", 'cure wounds', 'fog cloud', 'entangle'] } },
  { cls: 'rogue', name: 'Rogue', build: 'Assassin · Rapier & Shortbow (Vex), Sneak Attack 3d6', hp: 38, ac: 16, acrobatics: true,
    scores: [8, 18, 14, 12, 12, 12], saves: ['dex', 'int'], ext: { sneakAttack: { dice: '3d6', assassinate: 5 }, assassinate: true, steadyAim: true, bonusDisengage: true },
    actions: [
      { name: 'Assassinate (round 1)', actionSlot: -3, type: 'buff', target: 'self', buff: { duration: '1 round', condition: 'Attacks with Advantage', damage: 5 }, ext: { wtSkip: true } },
      wpn('Rapier', '1d8 + 4 + 3d6', 7, 'piercing', 5, { wtDpr: '1d8 + 4', sneak: true, onHit: { vex: true } }),
      wpn('Shortbow', '1d6 + 4 + 3d6', 7, 'piercing', 80, { wtDpr: '1d6 + 4', sneak: true, onHit: { vex: true }, wtOnly: true }),
      { name: 'Cunning Action: Hide', actionSlot: 1, type: 'buff', target: 'self', buff: { duration: '1 round', condition: 'Invisible' }, ext: { successChance: 0.75 } },
      { name: 'Uncanny Dodge', actionSlot: 4, type: 'buff', target: 'self', buff: { duration: 'until next attack taken', damageTakenMultiplier: 0.5 } },
    ] },
  { cls: 'sorcerer', name: 'Sorcerer', build: 'Draconic (red) · Innate Sorcery, Quickened Spell', hp: 37, ac: 15,
    scores: [8, 14, 14, 10, 12, 18], saves: ['con', 'cha'],
    actions: [
      { name: 'Innate Sorcery', actionSlot: 1, freq: { reset: 'lr', uses: 2 }, condition: 'not used yet', type: 'buff', target: 'self', buff: { duration: 'entire encounter', toHit: 2 } },
      { name: 'Quickened Fire Bolt (2 sorcery points)', actionSlot: 1, freq: { reset: 'lr', uses: 2 }, type: 'atk', dpr: '2d10', toHit: 7, target: 'enemy with least HP', ext: { range: 120, damageType: 'fire', magical: true } },
      wpn('Dagger', '1d4 + 2', 5, 'piercing', 5),
    ],
    spells: { ability: 'cha', slots: [4, 3, 2, 0, 0, 0, 0, 0, 0], list: ['fire bolt', 'mind sliver', 'shield', 'magic missile', 'chromatic orb', 'scorching ray', 'hold person',
      { name: 'misty step', custom: { level: 2, actionSlot: 1, targets: 1, type: 'buff', target: 'self', buff: { duration: '1 round' }, ext: { teleport: 30, wtOnly: true } } },
      'fireball', 'lightning bolt'] } },
  { cls: 'warlock', name: 'Warlock', build: 'The Fiend · Agonizing & Repelling Blast, Armor of Shadows, Dark One\'s Blessing', hp: 38, ac: 15,
    scores: [8, 14, 14, 10, 12, 18], saves: ['wis', 'cha'],
    actions: [
      { name: "Dark One's Blessing", actionSlot: -2, type: 'heal', tempHP: true, amount: '9', target: 'self', ext: { range: 0 } },
      wpn('Dagger', '1d4 + 2', 5, 'piercing', 5),
    ],
    spells: { ability: 'cha', slots: [0, 0, 2, 0, 0, 0, 0, 0, 0], reset: 'sr', list: [
      { name: 'eldritch blast', patch: sp => { sp.dpr = '1d10 + 4'; sp.ext.onHit = { push: 10 }; } },
      'mind sliver',
      { name: 'hex', patch: sp => { sp.name = 'Hex'; } },
      'armor of agathys', 'hellish rebuke', 'burning hands', 'hold person', 'scorching ray',
      { name: 'misty step', custom: { level: 2, actionSlot: 1, targets: 1, type: 'buff', target: 'self', buff: { duration: '1 round' }, ext: { teleport: 30, wtOnly: true } } },
      'fireball'] } },
  { cls: 'wizard', name: 'Wizard', build: 'Evoker · Sculpt Spells, Mage Armor up, Arcane Recovery', hp: 32, ac: 15,
    scores: [8, 14, 14, 18, 12, 10], saves: ['int', 'wis'],
    actions: [ wpn('Dagger', '1d4 + 2', 5, 'piercing', 5) ],
    spells: { ability: 'int', slots: [4, 3, 2, 0, 0, 0, 0, 0, 0], recovery: { levels: 3, maxSlot: 5 }, list: [
      'fire bolt', 'ray of frost', 'shocking grasp', 'shield', 'magic missile', 'burning hands', "tasha's hideous laughter", 'scorching ray', 'hold person',
      { name: 'misty step', custom: { level: 2, actionSlot: 1, targets: 1, type: 'buff', target: 'self', buff: { duration: '1 round' }, ext: { teleport: 30, wtOnly: true } } },
      { name: 'fireball', patch: sp => { sp.ext.area.selective = true; sp.name = 'Fireball (sculpted)'; } },
      'lightning bolt'] } },
  { cls: 'artificer', name: 'Artificer', build: 'Artillerist · Eldritch Cannon (Force Ballista), Arcane Firearm', hp: 38, ac: 18,
    scores: [10, 14, 14, 18, 12, 8], saves: ['con', 'int'],
    actions: [
      { name: 'Eldritch Cannon (create) + Force Ballista', actionSlot: 1, freq: { reset: 'lr', uses: 1 }, condition: 'not used yet', type: 'atk', dpr: '2d8', toHit: 7, target: 'enemy with least HP',
        ext: { range: 120, damageType: 'force', magical: true, onHit: { push: 5 }, grantsBuff: { id: 'c5-artificer-cannon', name: 'Eldritch Cannon' } } },
      { name: 'Force Ballista', actionSlot: 1, type: 'atk', dpr: '2d8', toHit: 7, target: 'enemy with least HP', ext: { range: 120, damageType: 'force', requiresBuff: 'c5-artificer-cannon', onHit: { push: 5 }, magical: true } },
      wpn('Light Crossbow', '1d8 + 2', 5, 'piercing', 80),
    ],
    spells: { ability: 'int', slots: [4, 2, 0, 0, 0, 0, 0, 0, 0], list: [
      { name: 'fire bolt', patch: sp => { sp.dpr = '2d10 + 1d8'; sp.name = 'Fire Bolt (Arcane Firearm)'; } },
      'cure wounds', 'faerie fire', 'shield', 'thunderwave', 'scorching ray', 'shatter'] } },
];

const builds = DEFS.map(build);
const party = ['fighter', 'paladin', 'cleric', 'wizard', 'rogue', 'bard'].map(k => builds.find(b => b.class.type === k));

const header = `/* ---------------------------------------------------------
   Built-in characters. Generated by tools/build-party.js — edit that file and re-run it.
   CLASS_BUILDS: a generic level-5 character for every class (2024 rules, proficiency +3).
   PARTY_PLAYERS: the default party (Fighter, Paladin, Cleric, Wizard, Rogue, Bard).
--------------------------------------------------------- */
`;
fs.writeFileSync(path.join(ROOT, 'data/party.js'),
  header + 'const CLASS_BUILDS = ' + JSON.stringify(builds) + ';\n' +
  'const PARTY_PLAYERS = JSON.parse(JSON.stringify(CLASS_BUILDS.filter(c => ' + JSON.stringify(party.map(p => p.id)) + '.includes(c.id))))\n' +
  '  .sort((a, b) => ' + JSON.stringify(party.map(p => p.id)) + '.indexOf(a.id) - ' + JSON.stringify(party.map(p => p.id)) + '.indexOf(b.id));\n');
console.log('wrote', builds.length, 'builds; party:', party.map(p => p.name).join(', '));
builds.forEach(b => console.log(` ${b.name.padEnd(10)} HP ${b.hp} AC ${b.AC} saves ${JSON.stringify(b.ext.saves)} actions ${b.actions.length} spells ${b.ext.spellbook ? b.ext.spellbook.spells.length : 0}`));
