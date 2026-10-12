/* =====================================================================
   STATBLOCK PARSER — turns pasted 5e statblocks into Forge creatures, no AI needed.
   Reads the 2014 (Monster Manual / SRD 5.1) layout, the 2024 layout (Melee Attack Roll,
   "Dexterity Saving Throw: DC 15 … Failure: … Success: …", the MOD/SAVE ability table),
   and D&D Beyond / 5etools copy-pastes where every label sits on its own line.
   Pure JS, no DOM. Exposes global `StatblockParser` and needs `SpellData` (js/spell-data.js).

   parse(text) → { monsters: [creature…], skipped: [string…] }
   Each creature carries `_notes`: what the parser assumed or couldn't model, shown on its card.
   ===================================================================== */
(function (root) {
'use strict';

const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
const TYPES = ['aberration', 'beast', 'celestial', 'construct', 'dragon', 'elemental', 'fey', 'fiend', 'giant', 'humanoid', 'monstrosity', 'ooze', 'plant', 'undead'];
const ABIL = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ABIL_NAMES = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twice: 2, thrice: 3 };
const SECTION_RE = /^(traits|actions|bonus actions|reactions|legendary actions|lair actions|mythic actions|regional effects)\s*:?$/i;
const CONDITION_WORDS = [
  ['paralyzed', 'Paralyzed'], ['stunned', 'Stunned'], ['petrified', 'Petrified'], ['unconscious', 'Unconscious'],
  ['restrained', 'Restrained'], ['frightened', 'Frightened'], ['poisoned', 'Poisoned'], ['blinded', 'Blinded'],
  ['incapacitated', 'Incapacitated'], ['charmed', 'Incapacitated'], ['prone', 'Is attacked with Advantage'],
];
const CR_LIST = ['0', '1/8', '1/4', '1/2'].concat(Array.from({ length: 30 }, (_, i) => String(i + 1)));

/* ---------- small helpers ---------- */
const avgDice = expr => {
  let t = 0;
  String(expr).replace(/\s+/g, '').replace(/([+-]?)(\d*)d(\d+)|([+-]?)(\d+(?:\.\d+)?)/gi, (m, s1, n, d, s2, flat) => {
    if (d) t += (s1 === '-' ? -1 : 1) * (n === '' ? 1 : +n) * (+d + 1) / 2;
    else if (flat) t += (s2 === '-' ? -1 : 1) * +flat;
    return m;
  });
  return t;
};
const round1 = x => Math.round(x * 100) / 100;
const cap = s => s.replace(/\b\w/g, c => c.toUpperCase());
const num = w => { if (w === undefined || w === null) return NaN; const k = String(w).toLowerCase(); return NUM_WORDS[k] !== undefined ? NUM_WORDS[k] : parseInt(k, 10); };
const STD_DIE = { 4: 1, 6: 1, 8: 1, 10: 1, 12: 1, 20: 1, 100: 1 };
// a dice expression the simulator can read; odd dice (d3, d7…) become their average
function cleanDice(expr) {
  const s = String(expr).replace(/[×x]/g, '*').replace(/\s+/g, ' ').trim();
  if (/d(\d+)/.test(s) && (s.match(/d(\d+)/g) || []).some(m => !STD_DIE[+m.slice(1)])) return String(round1(avgDice(s)));
  return s.replace(/\s*([+-])\s*/g, ' $1 ').replace(/^ \+ /, '').trim();
}
const profByCR = cr => { const v = cr.includes('/') ? 0 : +cr; return v >= 29 ? 9 : v >= 25 ? 8 : v >= 21 ? 7 : v >= 17 ? 6 : v >= 13 ? 5 : v >= 9 ? 4 : v >= 5 ? 3 : 2; };

/* ---------- text clean-up ---------- */
function normalize(text) {
  return String(text)
    .replace(/\r/g, '')
    // markdown from Homebrewery / GM Binder / 5etools exports
    .replace(/^\s*>\s?/gm, '').replace(/^\s*#{1,6}\s*/gm, '').replace(/^\s*_{3,}\s*$/gm, '').replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '')
    .replace(/\*\*\*?|__/g, '').replace(/(^|\s)\*(?=\S)/gm, '$1').replace(/(\S)\*(?=\s|[.,:;]|$)/gm, '$1').replace(/\|/g, ' ')
    .replace(/^\s*[-•]\s+(?=[A-Z])/gm, '\u0007')          // list bullets: a marker parseBody reads (options of an action)
    .replace(/[−‒–—](?=\s*\d)/g, '-')          // −1, –1 → -1 (minus signs before numbers)
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')             // Recharge 5–6 → 5-6
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/ /g, ' ').replace(/\t+/g, ' ')
    .replace(/[ ]{2,}/g, ' ');
}

/* several statblocks in one paste: split on lines of dashes, or at each name line that sits
   right above a "Size type, alignment" line */
const META_RE = /^(?:Tiny|Small|Medium|Large|Huge|Gargantuan)\b(?:\s+or\s+\w+)?\s+(?:swarm of \w+ )?[A-Za-z]+/;
function splitBlocks(text) {
  const parts = normalize(text).split(/\n\s*-{3,}\s*\n/);
  const out = [];
  for (const p of parts) {
    const lines = p.split('\n');
    const starts = [];
    lines.forEach((l, i) => { if (META_RE.test(l.trim()) && i > 0 && lines[i - 1].trim() && !/[.:]$/.test(lines[i - 1].trim())) starts.push(i - 1); });
    if (starts.length <= 1) { if (p.trim()) out.push(p.trim()); continue; }
    starts.forEach((s, k) => { const chunk = lines.slice(k === 0 ? 0 : s, starts[k + 1] === undefined ? lines.length : starts[k + 1]).join('\n').trim(); if (chunk) out.push(chunk); });
  }
  return out;
}

/* ---------- the header: name, size/type, AC, HP, speed, abilities, saves, CR ---------- */
function parseHeader(lines, flat, notes) {
  const h = { ext: {} };
  // name: the first line that isn't the size/type line
  h.name = lines[0] && !META_RE.test(lines[0]) ? lines[0].replace(/[*_#]/g, '').trim() : 'Unnamed creature';
  if (h.name === h.name.toUpperCase() && /[A-Z]{3}/.test(h.name)) h.name = h.name.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/(\S\s+)(The|Of|And|A|An|In|On|To|For|At|By|From|With)(?=\s)/g, (m, a, w) => a + w.toLowerCase());
  const meta = lines.find(l => META_RE.test(l)) || '';
  const sm = meta.match(/^(Tiny|Small|Medium|Large|Huge|Gargantuan)/i);
  h.ext.size = sm ? cap(sm[1].toLowerCase()) : 'Medium';
  const tm = meta.toLowerCase().match(/\b(aberration|beast|celestial|construct|dragon|elemental|fey|fiend|giant|humanoid|monstrosity|ooze|plant|undead)s?\b/);
  h.type = tm ? tm[1] : 'monstrosity';
  if (!tm) notes.push('Creature type not recognised; set to monstrosity.');

  const acm = flat.match(/\b(?:Armor Class|AC)\b\s*:?\s*(\d+)/i);
  h.AC = acm ? +acm[1] : 10;
  if (!acm) notes.push('No Armor Class found; using 10.');
  const hpm = flat.match(/\b(?:Hit Points|HP)\b\s*:?\s*(\d+)(?:\s*\(([^)]*)\))?/i);
  h.hp = hpm ? +hpm[1] : 10;
  if (!hpm) notes.push('No hit points found; using 10.');

  const spm = flat.match(/\bSpeed\b\s*:?\s*([^\n]*?)(?=\s+(?:STR|Str\b|MOD\b|Saving|Skills|Senses|Damage|Condition|Immunities|Resistances|Languages|Challenge|CR\b|Initiative|Hit Points|HP\b|Armor Class|AC\b)|\n|$)/);
  if (spm) {
    const sp = spm[1];
    const walk = sp.match(/^\s*(\d+)\s*ft/i);
    const other = {};
    sp.replace(/\b(fly|swim|burrow|climb)\s*(\d+)\s*ft/gi, (m, k, v) => { other[k.toLowerCase()] = +v; return m; });
    h.ext.speed = walk ? +walk[1] : Math.max(30, other.burrow || 0, other.swim || 0);
    if (!walk && (other.burrow || other.swim)) h.ext.speed = Math.max(other.burrow || 0, other.swim || 0);
    if (other.fly) h.ext.fly = other.fly;
    if (other.fly && /\(\s*hover\s*\)|\bhover\b/i.test(sp)) h.ext.hover = true;
    if (other.climb) h.ext.climb = other.climb;
  }
  const im = flat.match(/\bInitiative\b\s*:?\s*([+-]\d+)/i);

  // ability scores (and the 2024 table's save column)
  const scores = {}, saves = {};
  let m;
  const t2024 = /\b(Str|Dex|Con|Int|Wis|Cha)\b\s+(\d{1,2})\s+([+-]\d+)\s+([+-]\d+)/gi;
  while ((m = t2024.exec(flat))) { const k = m[1].toLowerCase(); scores[k] = +m[2]; saves[k] = +m[4]; }
  if (Object.keys(scores).length < 6) {
    const ddb = /\b(STR|DEX|CON|INT|WIS|CHA)\b\s*:?\s*(\d{1,2})\s*\(\s*([+-]?\d+)\s*\)/gi;
    while ((m = ddb.exec(flat))) scores[m[1].toLowerCase()] = +m[2];
  }
  if (Object.keys(scores).length < 6) {
    const hdr = flat.search(/\bSTR\s+DEX\s+CON\s+INT\s+WIS\s+CHA\b/i);
    if (hdr >= 0) {
      const vals = [], re = /(\d{1,2})\s*\(\s*[+-]?\d+\s*\)/g;
      re.lastIndex = hdr;
      while (vals.length < 6 && (m = re.exec(flat))) vals.push(+m[1]);
      if (vals.length === 6) ABIL.forEach((k, i) => { scores[k] = vals[i]; });
    }
  }
  const have = ABIL.filter(k => scores[k] !== undefined).length === 6;
  if (!have) notes.push('Ability scores not found; saves fall back to proficiency by CR.');
  h.scores = have ? scores : null;

  // challenge rating and proficiency bonus
  const crm = flat.match(/\b(?:Challenge|CR)\b\s*:?\s*(\d+\/\d+|\d+)/i);
  h.cr = crm && CR_LIST.includes(crm[1]) ? crm[1] : '1';
  if (!crm) notes.push('No challenge rating found; using CR 1.');
  const pbm = flat.match(/\b(?:PB|Proficiency Bonus)\b\s*:?\s*\+?(\d+)/i);
  h.pb = pbm ? +pbm[1] : profByCR(h.cr);

  // saves: stated "Saving Throws Dex +4, Con +6" (2014) beats the table, which beats plain modifiers
  const mod = k => (have ? Math.floor((scores[k] - 10) / 2) : 0);
  const stm = flat.match(/\bSaving Throws\b\s*:?\s*([^\n]*)/i);
  const stated = {};
  if (stm) stm[1].replace(/\b(Str|Dex|Con|Int|Wis|Cha)\w*\s*([+-]\d+)/gi, (x, k, v) => { stated[k.toLowerCase().slice(0, 3)] = +v; return x; });
  h.ext.saves = {};
  ABIL.forEach(k => { h.ext.saves[k] = stated[k] !== undefined ? stated[k] : saves[k] !== undefined ? saves[k] : have ? mod(k) : h.pb; });
  h.saveBonus = round1(ABIL.reduce((t, k) => t + h.ext.saves[k], 0) / 6);
  h.ext.initBonus = im ? +im[1] : mod('dex');
  h.mod = mod;

  // senses, skills
  if (/\bblindsight\b/i.test(flat)) h.ext.blindsight = true;
  const stealth = flat.match(/\bStealth\s*([+-]\d+)/i);
  h.stealth = stealth ? +stealth[1] : mod('dex');
  // Athletics climbs ledges on the War Table; the better of Athletics / Acrobatics breaks grapples
  const ath = flat.match(/\bAthletics\s*([+-]\d+)/i), acro = flat.match(/\bAcrobatics\s*([+-]\d+)/i);
  h.ext.athletics = ath ? +ath[1] : mod('str');
  h.ext.escapeBonus = Math.max(h.ext.athletics, acro ? +acro[1] : mod('dex'));

  // how it fights
  const int = have ? scores.int : 10;
  h.ext.ai = int <= 3 || ['ooze', 'plant'].includes(h.type) ? 'beast' : int >= 10 ? 'tactical' : 'regular';

  // damage resistances / immunities / vulnerabilities → one passive damage-taken multiplier
  const line = re => { const x = flat.match(re); return x ? x[1].toLowerCase() : ''; };
  const res = line(/\bDamage Resistances\b\s*:?\s*([^\n]*)/i) || line(/(?:^|\n)\s*Resistances\b\s*:?\s*([^\n]*)/i);
  let imm = line(/\bDamage Immunities\b\s*:?\s*([^\n]*)/i) || line(/(?:^|\n)\s*Immunities\b\s*:?\s*([^\n;]*)/i);
  const vul = line(/\bDamage Vulnerabilities\b\s*:?\s*([^\n]*)/i) || line(/(?:^|\n)\s*Vulnerabilities\b\s*:?\s*([^\n]*)/i);
  const condLine = line(/\bCondition Immunities\b\s*:?\s*([^\n]*)/i);
  const condWords = (condLine + ' ' + imm).match(/\b(blinded|charmed|deafened|exhaustion|frightened|grappled|incapacitated|paralyzed|petrified|poisoned|prone|restrained|stunned|unconscious)\b/g) || [];
  imm = imm.replace(/\b(blinded|charmed|deafened|exhaustion|frightened|grappled|incapacitated|paralyzed|petrified|poisoned|prone|restrained|stunned|unconscious)\b/g, '');
  // the War Table uses the real types; the export keeps one averaged multiplier (below)
  const typesIn = txt => {
    const out = [];
    for (const seg of txt.split(/;/)) {
      const nonmag = /nonmagical|non-magical|that aren't|aren't silvered|not made with/.test(seg);
      for (const w of seg.match(/\b(acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)\b/g) || []) {
        const v = nonmag && /bludgeoning|piercing|slashing/.test(w) ? 'nonmagical ' + w : w;
        if (!out.includes(v)) out.push(v);
      }
    }
    return out;
  };
  if (typesIn(res).length) h.ext.resist = typesIn(res);
  if (typesIn(imm).length) h.ext.immune = typesIn(imm);
  if (typesIn(vul).length) h.ext.vulnerable = typesIn(vul);
  if (condWords.length) h.ext.condImmune = condWords.map(cap).filter((c, i, arr) => arr.indexOf(c) === i);
  h.damageMult = damageMultiplier(res, imm, vul);
  h.resText = [res && 'resists ' + res, imm.replace(/[;,\s]+$/, '').trim() && 'immune to ' + imm.replace(/[;,\s]+$/, '').trim(), vul && 'vulnerable to ' + vul].filter(Boolean).join('; ');
  return h;
}

/* weapon damage resistance covers most of what a party deals; a single energy type covers little */
function damageMultiplier(res, imm, vul) {
  const share = txt => {
    if (!txt) return 0;
    let s = 0;
    const bps = /bludgeoning|piercing|slashing/.test(txt);
    if (bps) s += /nonmagical|non-magical|that aren't|aren't silvered|not made with|from nonmagical/.test(txt) ? 0.45 : 0.6;
    const energies = (txt.match(/\b(acid|cold|fire|force|lightning|necrotic|poison|psychic|radiant|thunder)\b/g) || []);
    s += energies.reduce((t, e) => t + ({ fire: 0.1, poison: 0.06, radiant: 0.08, necrotic: 0.07, force: 0.07, cold: 0.06, lightning: 0.05, psychic: 0.05, acid: 0.04, thunder: 0.04 })[e], 0);
    return Math.min(0.85, s);
  };
  let m = 1 - share(res) * 0.5 - share(imm);
  m += share(vul);
  return Math.max(0.15, round1(m));
}

/* ---------- body: traits and the action sections, each split into "Name. text" entries ---------- */
const SMALL = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'to', 'in', 'on', 'with', 'from', 'by', 'at', 'for', 'its', 'de', 'du']);
function looksLikeName(n) {
  const words = n.replace(/\([^)]*\)/g, '').trim().split(/\s+/);
  if (!words.length || words.length > 7 || !words[0]) return false;
  return words.every((w, i) => /^[A-Z'"(]/.test(w) || (i > 0 && SMALL.has(w.toLowerCase())) || /^\d+\/(day|turn|rest)/i.test(w));
}
const STAT_LINE = /^(Armor Class|AC\b|Hit Points|HP\b|Speed|STR\b|Str\b|MOD\b|Saving Throws|Skills|Senses|Languages|Challenge|CR\b|Damage|Condition|Immunities|Resistances|Vulnerabilities|Gear|Proficiency Bonus|Initiative|Habitat|Treasure)/;
function parseBody(lines) {
  const sections = { traits: [], actions: [], 'bonus actions': [], reactions: [], 'legendary actions': [], 'lair actions': [], 'mythic actions': [], 'regional effects': [] };
  let cur = 'traits', entry = null, started = false, intro = [];
  const push = () => { if (entry) sections[cur].push(entry); entry = null; };
  for (let i = 1; i < lines.length; i++) {
    let l = lines[i];
    // a bulleted list right after an action that offers options ("Choose one option:") belongs to that action
    if (l.charAt(0) === '\u0007') {
      l = l.slice(1).trim();
      if (entry && cur !== 'traits' && (entry._options || /:\s*$|choose one|one of the following|options?\b/i.test(entry.text))) { entry._options = true; entry.text += ' ' + l; continue; }
    }
    const sec = l.match(SECTION_RE);
    if (sec) { push(); cur = sec[1].toLowerCase(); started = true; continue; }
    const em = l.match(/^([^.:]{1,70}?(?:\s*\([^)]*\))?)\s*[.:]\s+(.*)$/) || l.match(/^([^.:]{1,70}?\([^)]*\))\s*[.:]?\s+(.*)$/);
    if (em && looksLikeName(em[1]) && !STAT_LINE.test(l) && !/^(Hit|Miss|Failure|Success|Failure or Success|Trigger|Response|At Will|Cantrips|\d+\/Day|\d+(st|nd|rd|th) level|Legendary Action Uses|Legendary Resistance Uses|Mythic Trait)\b/i.test(em[1].trim())) {
      push(); started = true;
      entry = { raw: em[1].trim(), text: em[2].trim() };
      continue;
    }
    if (entry) { entry.text += (/[:]$/.test(entry.text) || /^(Cantrips|At Will|\d|[A-Z][a-z]+ level)/i.test(l) ? '\n' : ' ') + l; continue; }
    if (started && cur !== 'traits') intro.push(l);   // e.g. "The dragon can take 3 legendary actions…"
  }
  push();
  sections.intro = intro.join(' ');
  return sections;
}

/* entry name + its usage tag: Recharge 5-6, 3/Day, Costs 2 Actions… */
function nameAndUsage(raw) {
  const out = { name: raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim(), freq: 'at will', cost: 1, recharge: false };
  const tags = (raw.match(/\(([^)]*)\)/g) || []).map(t => t.slice(1, -1));
  for (const t of tags) {
    let m;
    if ((m = t.match(/Recharge\s*(\d)(?:\s*-\s*(\d))?/i))) {
      const faces = m[2] ? (+m[2] - +m[1] + 1) : 1;
      out.freq = { reset: 'recharge', cooldownRounds: Math.max(2, Math.round(6 / faces)) }; out.recharge = true;
    } else if ((m = t.match(/(\d+)\s*\/\s*Day/i))) out.freq = +m[1] === 1 ? '1/day' : { reset: 'lr', uses: +m[1] };
    else if (/Recharges? after a Short or Long Rest|\/\s*Short Rest/i.test(t)) { m = t.match(/(\d+)/); out.freq = { reset: 'sr', uses: m ? +m[1] : 1 }; }
    else if ((m = t.match(/Costs?\s*(\d+)\s*Actions?/i))) out.cost = +m[1];
  }
  return out;
}

/* ---------- reading one entry's mechanics ---------- */
function damageParts(txt) {
  // "13 (2d8 + 4) bludgeoning damage", "plus 7 (2d6) fire damage"; skips conditional extras ("if…", "instead")
  const parts = [];
  const re = /(\d+)\s*\(\s*([\dd+\-\s×x*]+)\s*\)\s*([a-z]+)?\s*damage/gi;
  let m;
  while ((m = re.exec(txt))) {
    const rest = txt.slice(re.lastIndex);
    const after = rest.split(/[.,;]|\bplus\b|\band\b/i)[0] || '';
    if (/\bif\b|\binstead\b|\bwhile\b|two hands|when used/i.test(after)) { if (parts.length) continue; }
    parts.push({ avg: +m[1], dice: cleanDice(m[2]), type: (m[3] || '').toLowerCase() });
  }
  if (!parts.length) { const f = txt.match(/(?:Hit:|take|takes|taking)\s*(\d+)\s+([a-z]+)\s+damage/i); if (f) parts.push({ avg: +f[1], dice: f[1], type: f[2].toLowerCase() }); }
  return parts;
}
/* the damage type of an action from its damage parts: "fire", or "slashing + fire" with each part's share */
const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];
function setDamageType(a, parts) {
  const typed = parts.filter(p => DAMAGE_TYPES.includes(p.type));
  if (!typed.length) return;
  const by = {};
  typed.forEach(p => { by[p.type] = (by[p.type] || 0) + p.avg; });
  const names = Object.keys(by);
  a.ext.damageType = names.join(' + ');
  if (names.length > 1) a.ext.damageMix = names.map(n => [n, by[n]]);
}
const SKILL_ABIL = { athletics: 'str', acrobatics: 'dex', stealth: 'dex', sleight: 'dex', arcana: 'int', history: 'int', investigation: 'int', nature: 'int', religion: 'int',
  insight: 'wis', medicine: 'wis', perception: 'wis', survival: 'wis', animal: 'wis', deception: 'cha', intimidation: 'cha', performance: 'cha', persuasion: 'cha' };
function saveInfo(txt) {
  let m = txt.match(/DC\s*(\d+)\s*(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s*saving throw/i);
  if (m) return { dc: +m[1], ab: ABIL_NAMES[m[2].toLowerCase()] };
  m = txt.match(/(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s*Saving Throw\s*:\s*DC\s*(\d+)/i);
  if (m) return { dc: +m[2], ab: ABIL_NAMES[m[1].toLowerCase()] };
  m = txt.match(/(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s*\(?\s*DC\s*(\d+)\s*\)?\s*saving throw/i);
  if (m) return { dc: +m[2], ab: ABIL_NAMES[m[1].toLowerCase()] };
  // "a DC 22 History or Intelligence check": an ability check to resist, rolled like a save of that ability
  m = txt.match(/DC\s*(\d+)\s*((?:\(?[A-Z][a-z]+\)?\s*(?:or|\/)?\s*){1,3})(?:ability\s*)?check/);
  if (m) {
    const words = m[2].replace(/[()]/g, ' ').split(/\s+|\bor\b|\//).map(w => w.toLowerCase()).filter(Boolean);
    const ab = words.map(w => ABIL_NAMES[w] || SKILL_ABIL[w]).filter(Boolean)[0];
    if (ab) return { dc: +m[1], ab, check: true };
  }
  return null;
}
function areaInfo(txt) {
  let m = txt.match(/(\d+)[- ](?:foot|feet|ft\.?)[- ]long[^.]{0,30}?\bline\b/i);
  if (m) return { shape: 'line', size: +m[1] };
  m = txt.match(/(\d+)[- ](?:foot|feet|ft\.?)[- ](?:radius\s+)?(cone|line|cube|sphere|cylinder|emanation|radius|square)/i);
  if (m) {
    const size = +m[1], k = m[2].toLowerCase();
    const shape = k === 'radius' || k === 'cylinder' ? 'sphere' : k === 'square' ? 'cube' : k;
    // "a 20-foot-radius sphere centered on itself" or "within 10 feet of it" are emanations
    if ((shape === 'sphere') && /centered on (?:itself|it|the \w+)\b/i.test(txt)) return { shape: 'emanation', size };
    return { shape, size };
  }
  m = txt.match(/(?:each|every|all|any) (?:other )?creatures?[^.]{0,60}?within (\d+) (?:feet|ft\.?)(?! of (?:a|an|the) (?:point|target))/i);
  if (m) return { shape: 'emanation', size: +m[1] };
  return null;
}
function areaTargets(a) {
  if (!a) return 1;
  const s = a.size;
  switch (a.shape) {
    case 'cone': return s >= 60 ? 4 : s >= 30 ? 3 : 2;
    case 'line': return s >= 60 ? 2 : 1;
    case 'cube': return s >= 30 ? 4 : s >= 20 ? 3 : s >= 15 ? 2 : 1;
    case 'sphere': return s >= 30 ? 4 : s >= 20 ? 3 : s >= 10 ? 2 : 1;
    case 'emanation': return s >= 30 ? 4 : s >= 15 ? 3 : 2;
  }
  return 2;
}
function conditionIn(txt) {
  if (/disadvantage on attack rolls|make the attack with disadvantage|makes? (?:the|its|that) attack (?:roll )?with disadvantage|attack rolls? (?:\w+ ){0,3}(?:has|have|are made with) disadvantage/i.test(txt)) return 'Attacks with Disadvantage';
  if (/(?:attack rolls )?against (?:it|them|the target) (?:have|has|are made with) advantage/i.test(txt)) return 'Is attacked with Advantage';
  if (/\bcompelled\b|\b(?:must|or) (?:use its (?:action|turn)|spend its action)/i.test(txt)) return 'Incapacitated';
  for (const [w, c] of CONDITION_WORDS) if (new RegExp('\\b(?:be|is|become|becomes|are|has the|have the|knocked)\\s+(?:\\w+\\s+){0,2}' + w, 'i').test(txt) || new RegExp('\\b' + w + '\\b condition', 'i').test(txt)) return c;
  return null;
}
function durationIn(txt, cond) {
  if (cond === 'Is attacked with Advantage') return '1 round';                       // prone: stands up next turn
  if (/repeat the (?:saving throw|save)|at the end of each of its turns|end of each of (?:its|their) turns/i.test(txt)) return 'repeat the save each round';
  if (/until the (?:end|start) of (?:its|his|her|their|the \w+'s|your|the target's) next turn|until the end of the target's next turn/i.test(txt)) return '1 round';
  if (/\b(?:1|one) minute|\bhour|until it is freed|until the grapple ends|escape DC/i.test(txt)) return 'repeat the save each round';
  return '1 round';
}
function rangeOf(txt, fallback) {
  let m = txt.match(/reach\s*(\d+)\s*ft/i);
  const reach = m ? +m[1] : null;
  m = txt.match(/range\s*(\d+)(?:\s*\/\s*\d+)?\s*ft/i);
  const range = m ? +m[1] : null;
  if (reach !== null && range !== null) return { melee: reach, ranged: range };
  if (range !== null) return { ranged: range };
  if (reach !== null) return { melee: reach };
  m = txt.match(/within\s*(\d+)\s*(?:feet|ft)/i);
  if (m) return { ranged: +m[1] };
  return fallback ? { ranged: fallback } : {};
}

function movementEffect(txt) {
  const ext = {};
  if (/speed (?:is |becomes )?(?:reduced to|becomes|is) 0|speed of 0|can't move|cannot move|spend(?:s)? (?:all )?its movement|uses? (?:all )?its movement/i.test(txt)) ext.speedBonus = -60;
  else if (/speed (?:is )?halved|half (?:its|their) speed|speed (?:is )?reduced by half/i.test(txt)) ext.speedBonus = -15;
  else { const m = txt.match(/speed (?:is )?reduced by (\d+) (?:feet|ft)/i); if (m) ext.speedBonus = -(+m[1]); }
  if (/can't take reactions|unable to take reactions|cannot take reactions|no reactions/i.test(txt)) ext.onHit = { noReactions: true };
  return Object.keys(ext).length ? ext : null;
}

/* one attack roll: Melee Weapon Attack: +4 to hit / Melee Attack Roll: +4 */
function readAttack(entry, nm, notes) {
  const t = entry.text;
  const am = t.match(/(Melee or Ranged|Melee|Ranged)\s*(?:Weapon|Spell)?\s*Attack(?:\s*Roll)?\s*:\s*([+-]\d+)/i);
  if (!am) return null;
  const toHit = +am[2];
  const hitText = (t.split(/\bHit\s*:/i)[1] || t);
  const parts = damageParts(hitText.split(/\bMiss\s*:/i)[0]);
  if (!parts.length) { notes.push(`${nm.name}: no damage found in the hit.`); }
  const dpr = parts.length ? cleanDice(parts.map(p => p.dice).join(' + ')) : '1';
  const rg = rangeOf(t);
  const kind = am[1].toLowerCase();
  const a = { name: nm.name, actionSlot: 0, freq: nm.freq, condition: 'default', targets: 1, type: 'atk', dpr, toHit, target: 'enemy with most HP', ext: {} };
  a.ext.range = kind === 'ranged' ? (rg.ranged || 60) : (rg.melee || 5);
  a._melee = kind !== 'ranged';
  a._ranged = kind !== 'melee' ? (rg.ranged || 20) : 0;
  a._avg = parts.reduce((s, p) => s + p.avg, 0) || avgDice(dpr);
  setDamageType(a, parts);

  // grapples (2014 "the target is grappled (escape DC 13)", 2024 "has the Grappled condition (escape DC 13)")
  const gm = hitText.match(/grappled[^(]*\(\s*escape DC\s*(\d+)\s*\)|Grappled condition\s*\(\s*escape DC\s*(\d+)/i);
  if (gm) {
    const sz = hitText.match(/(Tiny|Small|Medium|Large|Huge|Gargantuan)\s+or\s+smaller/i);
    a.ext.grapple = { escapeDC: +(gm[1] || gm[2]), maxSize: sz ? cap(sz[1].toLowerCase()) : SIZES[Math.min(5, SIZES.indexOf(entry._size || 'Medium') + 1)], restrains: /restrained|Restrained condition/i.test(hitText) };
  }
  // a rider on the hit: "must succeed on a DC 11 Strength saving throw or be knocked prone"
  const sv = saveInfo(hitText);
  const cond = conditionIn(hitText.replace(/grappled|Grappled condition|restrained, and|Until this grapple ends, the target (?:is|has the) Restrained[^.]*\./gi, ''));
  const extra = sv ? damageParts(hitText.slice(hitText.search(/saving throw|Saving Throw/i))) : [];
  if (sv && extra.length) {
    // extra damage on a failed save (poisoned bites): count it at the rate it usually lands
    const half = /half as much|Half damage/i.test(hitText);
    const exp = extra.reduce((s, p) => s + p.avg, 0) * (half ? 0.75 : 0.55);
    a.dpr = cleanDice(a.dpr + ' + ' + round1(exp));
    a._avg += exp;
    a._noteExtra = true;
  }
  if (cond && !gm) {
    a.riderEffect = { dc: sv ? sv.dc : 99, buff: { duration: durationIn(hitText, cond), condition: cond } };
    if (sv && sv.ab) a.ext.riderSave = sv.ab;
  }
  // "… reduces/alters its AC (…) by 3": a lower AC until it wears off
  const acm = !a.riderEffect && !gm && (hitText.match(/(?:reduc|lower|decreas|alter|subtract)\w*[^.]{0,80}?\bAC\b[^.]{0,70}?\bby\s*(\d+)/i) || hitText.match(/\b(?:-|minus\s*|penalty of\s*)(\d+)\s*(?:penalty\s*)?to (?:its|their|the target's) AC/i));
  if (acm) {
    a.riderEffect = { dc: sv ? sv.dc : 99, buff: { duration: durationIn(hitText, null), ac: -(+acm[1]) } };
    if (sv && sv.ab) a.ext.riderSave = sv.ab;
    if (/\bor\b[^.]{0,40}(?:speed|saving throw)|one key statistic|one of/i.test(hitText)) notes.push(`${nm.name}: of the statistics it can lower, the War Table uses AC (−${acm[1]}).`);
  }
  if (/\bsaving throw\b/i.test(hitText) && !sv) notes.push(`${nm.name}: has a save on hit whose DC wasn't readable.`);
  // "the target's speed is reduced by 10 feet" / "can't take reactions" on a hit (War Table only)
  const mvh = !sv ? movementEffect(hitText) : null;
  if (mvh) {
    a.ext.onHit = Object.assign({}, a.ext.onHit, mvh.onHit || {}, mvh.speedBonus ? { slow: -mvh.speedBonus } : {});
    notes.push(`${nm.name}: ${mvh.speedBonus ? (mvh.speedBonus <= -60 ? 'stops the target moving' : 'slows the target') : ''}${mvh.speedBonus && mvh.onHit ? ' and ' : ''}${mvh.onHit ? 'blocks its reactions' : ''} on a hit — War Table only.`);
  }
  return a;
}

/* a save effect: breath weapons, auras, Frightful Presence… */
function readSaveEffect(entry, nm, notes, h) {
  const t = entry.text;
  const sv = saveInfo(t);
  if (!sv) return null;
  const area = areaInfo(t);
  const rg = rangeOf(t, area ? area.size : 60);
  const parts = damageParts(t);
  const cond = conditionIn(t);
  let targets = area ? areaTargets(area) : 1;
  const upTo = t.match(/(?:up to|choose up to)\s*(\w+)\s*(?:creatures|targets)/i);
  if (upTo && !isNaN(num(upTo[1]))) targets = num(upTo[1]);
  if (/each creature of [^.]{0,30}choice/i.test(t) && !area) targets = 4;
  const nCreat = !area && !upTo && t.match(/\b(two|three|four|five|six)\s+(?:other\s+)?creatures\b/i);
  if (nCreat) targets = num(nCreat[1]);
  const a = { name: nm.name, actionSlot: 0, freq: nm.freq, condition: 'default', targets: Math.max(1, targets), target: 'enemy with most HP', ext: { range: area && (['cone', 'line', 'emanation'].includes(area.shape) || (area.shape === 'cube' && !/can see|a point|centered|centred|within \d+/i.test(t))) ? area.size : (area ? (rangeOf(t).ranged || 120) : (rg.ranged || rg.melee || 60)), saveAbility: sv.ab } };
  if (area) a.ext.area = { shape: area.shape, size: area.size };
  if (/difficult terrain/i.test(t) && area) a.ext.zone = { difficult: true };
  const mv = movementEffect(t);
  if (parts.length) {
    Object.assign(a, { type: 'atk', dpr: cleanDice(parts.map(p => p.dice).join(' + ')), toHit: sv.dc, useSaves: true });
    setDamageType(a, parts);
    if (mv) { if (mv.onHit) a.ext.onHit = Object.assign({}, a.ext.onHit, mv.onHit); if (mv.speedBonus) a.ext.onHit = Object.assign({}, a.ext.onHit, { slow: -mv.speedBonus }); }
    if (/half as much|Success\s*:\s*Half damage|half damage on a success/i.test(t)) a.halfOnSave = true;
    if (cond) a.riderEffect = { dc: 99, buff: { duration: durationIn(t, cond), condition: cond } };
    a._avg = parts.reduce((s, p) => s + p.avg, 0) * targets;
  } else if (cond) {
    Object.assign(a, { type: 'debuff', saveDC: sv.dc, buff: { duration: durationIn(t, cond), condition: cond } });
    if (mv) Object.assign(a.ext, mv);
    // "… or use its action on its next turn …": on the War Table it only loses its action (it can still move and react)
    if (cond === 'Incapacitated' && /\b(?:must|or) (?:use|spend) its action/i.test(t) && !/incapacitated/i.test(t)) a.ext.loseAction = true;
    // "…and each time it takes damage, it repeats the saving throw (with advantage)"
    const sod = t.match(/(?:each time|whenever|every time)[^.]*?takes damage[^.]*?(?:saving throw|save)[^.]*\.?/i);
    if (sod) a.ext.saveOnDamage = /advantage/i.test(sod[0]) ? 'adv' : true;
    if (/within (?:reach|5 (?:feet|ft)) of each other/i.test(t)) a.ext.pairWithin = 5;
    a._avg = 4 * targets;
  } else if (mv) {
    // only movement / reactions: modelled on the War Table, with no other effect to export
    Object.assign(a, { type: 'debuff', saveDC: sv.dc, buff: { duration: durationIn(t, null) } });
    Object.assign(a.ext, mv, { wtOnly: true });
    a._avg = 2 * targets;
    notes.push(`${nm.name}: ${mv.speedBonus ? (mv.speedBonus <= -60 ? 'stops the target moving' : 'slows the target') : ''}${mv.speedBonus && mv.onHit ? ' and ' : ''}${mv.onHit ? 'blocks its reactions' : ''} — War Table only; the exported day has no ${mv.speedBonus ? 'movement' : 'reactions'}.`);
  } else {
    notes.push(`${nm.name}: a save with no damage or condition the simulator can use; left out.`);
    return null;
  }
  return a;
}

/* healing: "regains 10 hit points", "regains 22 (4d8 + 4) hit points" */
function readHeal(entry, nm) {
  const t = entry.text;
  const m = t.match(/regains?\s*(?:(\d+)\s*\(\s*([^)]+)\)|(\d+))\s*hit points/i) || t.match(/(\d+)\s*\(\s*([^)]+)\)\s*temporary hit points/i) || t.match(/gains?\s*(\d+)\s*temporary hit points/i);
  if (!m) return null;
  const temp = /temporary hit points/i.test(t);
  const amount = m[2] ? cleanDice(m[2]) : String(m[1] || m[3]);
  const self = /\b(?:the \w+|it|itself)\s+(?:regains|gains)\b/i.test(t) && !/\b(?:one|a|each|another) (?:creature|ally|willing)/i.test(t);
  return { name: nm.name, actionSlot: 0, freq: nm.freq, condition: self ? (temp ? 'has no THP' : 'is under half HP') : 'ally under half HP', targets: 1, type: 'heal', amount, ...(temp ? { tempHP: true } : {}), target: self ? 'self' : 'ally with the least HP', ext: { range: self ? 0 : (rangeOf(t, 5).ranged || 5) } };
}

/* ---------- spellcasting ---------- */
function parseSpellcasting(entry, h, notes, slotKind) {
  const t = entry.text;
  const dcm = t.match(/spell save DC\s*(\d+)/i);
  const hitm = t.match(/([+-]\d+)\s*to hit with spell attacks/i);
  const abm = t.match(/(?:spellcasting ability is|using|uses)\s*(Intelligence|Wisdom|Charisma)/i);
  const lvm = t.match(/(\d+)(?:st|nd|rd|th)[- ]level spellcaster/i);
  const ab = abm ? ABIL_NAMES[abm[1].toLowerCase()] : 'int';
  const mod = h.mod(ab);
  const dc = dcm ? +dcm[1] : 8 + h.pb + mod;
  const atk = hitm ? +hitm[1] : h.pb + mod;
  const lvl = lvm ? +lvm[1] : Math.max(1, Math.round(+(h.cr.includes('/') ? 1 : h.cr)));
  const cantripDice = lvl >= 17 ? 4 : lvl >= 11 ? 3 : lvl >= 5 ? 2 : 1;
  const ctx = { dc, atk, mod, lvl, cantripDice };

  const slots = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const book = [], innate = [], skipped = [];
  const listLines = t.split(/\n|(?=\b(?:Cantrips|At Will|At will|\d+\/[Dd]ay(?: [Ee]ach)?|\d+(?:st|nd|rd|th)[- ][Ll]evel)\b[^:]{0,20}:)/);
  for (const ln of listLines) {
    let m;
    const body = ln.split(':').slice(1).join(':');
    if (!body) continue;
    const names = body.split(',').map(s => s.replace(/\*|\[.*?\]/g, '').trim().toLowerCase()).filter(Boolean);
    if ((m = ln.match(/(\d+)(?:st|nd|rd|th)[- ]level\s*\((\d+)\s*slots?\)/i))) {
      slots[+m[1] - 1] = +m[2];
      names.forEach(n => book.push({ n, lvl: +m[1] }));
    } else if (/^\s*Cantrips/i.test(ln)) names.forEach(n => book.push({ n, lvl: 0 }));
    else if (/^\s*At will/i.test(ln)) names.forEach(n => innate.push({ n, freq: 'at will' }));
    else if ((m = ln.match(/(\d+)\s*\/\s*day/i))) names.forEach(n => innate.push({ n, freq: +m[1] === 1 ? '1/day' : { reset: 'lr', uses: +m[1] } }));
  }
  const make = (n0, extra) => {
    const vm = n0.match(/\(level (\d) version\)/i);
    const n = n0.replace(/\(.*?\)/g, '').trim();
    const sp = root.SpellData && root.SpellData[n];
    if (!sp) { skipped.push(n); return null; }
    return spellAction(n, sp, ctx, Object.assign({}, extra, vm ? { atLevel: +vm[1] } : {}));
  };
  const out = { actions: [], spellbook: null };
  if (book.length && slots.some(Boolean)) {
    const spells = book.map(b => make(b.n, { level: b.lvl })).filter(Boolean);
    if (spells.length) out.spellbook = { slots, slotReset: /pact magic|warlock/i.test(t) ? 'sr' : 'lr', spells };
  } else book.forEach(b => innate.push({ n: b.n, freq: b.lvl ? '1/day' : 'at will' }));
  innate.forEach(s => { const a = make(s.n, { freq: s.freq }); if (a) out.actions.push(a); });
  if (skipped.length) notes.push(`Spells skipped (no combat effect the simulator models, or not in the spell list): ${skipped.join(', ')}.`);
  return out;
}

function spellAction(n, sp, ctx, extra) {
  const name = cap(n);
  const slot = sp.react ? 4 : sp.bonus ? 1 : 0;
  const a = { name, actionSlot: slot, targets: sp.t || 1, ext: {} };
  if (sp.r !== undefined) a.ext.range = sp.r;
  let scaled = sp.L === 0 ? String(sp.d).replace(/^(\d*)d(\d+)/, (m, c, d) => `${(+c || 1) * ctx.cantripDice}d${d}`) : sp.d;
  if (extra.atLevel && extra.atLevel > sp.L && sp.u && sp.d) scaled = [sp.d].concat(Array(extra.atLevel - sp.L).fill(sp.u)).join(' + ');
  if (sp.k === 'shield') return Object.assign({ name: 'Shield', actionSlot: 4, type: 'template', templateOptions: { templateName: 'Shield' } }, extra.level !== undefined ? { level: 1 } : { freq: extra.freq, condition: 'default' });
  if (sp.k === 'atk') {
    Object.assign(a, { type: 'atk', dpr: sp.beams ? sp.d : scaled, toHit: sp.auto ? 99 : ctx.atk, target: 'enemy with most HP' });
    if (sp.beams) a.targets = ctx.cantripDice;
    if (sp.hits) a.targets = sp.hits;
  } else if (sp.k === 'save') {
    Object.assign(a, { type: 'atk', dpr: scaled, toHit: ctx.dc, useSaves: true, target: 'enemy with most HP' });
    if (sp.h) a.halfOnSave = true;
    a.ext.saveAbility = sp.sv;
  } else if (sp.k === 'heal') {
    const amt = sp.mod && ctx.mod ? `${sp.d} + ${ctx.mod}` : sp.d;
    Object.assign(a, { type: 'heal', amount: amt, target: sp.tg === 'self' ? 'self' : 'ally with the least HP' });
    if (sp.tmp) a.tempHP = true;
  } else if (sp.k === 'buff') {
    Object.assign(a, { type: 'buff', target: sp.tg === 'self' ? 'self' : 'ally with the highest DPR', buff: Object.assign({}, sp.b) });
  } else if (sp.k === 'debuff') {
    Object.assign(a, { type: 'debuff', saveDC: sp.sv ? ctx.dc : 99, target: 'enemy with highest DPR', buff: Object.assign({}, sp.b) });
    if (sp.sv) a.ext.saveAbility = sp.sv;
  }
  if (sp.rider) a.riderEffect = { dc: 99, buff: Object.assign({}, sp.rider) };
  if (sp.dt && a.type === 'atk') a.ext.damageType = sp.dt;
  if (a.type === 'atk') a._avg = avgDice(a.dpr) * (a.targets || 1) * (a.useSaves ? (a.halfOnSave ? 0.75 : 0.55) : 0.65);
  if (sp.a) a.ext.area = { shape: sp.a[0], size: sp.a[1] };
  if (sp.selective && a.ext.area) a.ext.area.selective = true;
  if (sp.types) a.ext.targetTypes = sp.types.slice();
  if (sp.e) Object.assign(a.ext, JSON.parse(JSON.stringify(sp.e)));
  if (extra.level !== undefined) {
    a.level = extra.level;
    if (sp.c) a.concentration = true;
    if (sp.u) a.upcast = sp.u;
    if (sp.ut) a.upcastTargets = sp.ut;
  } else {
    a.freq = extra.freq;
    a.condition = conditionFor(a, extra.freq);
  }
  return a;
}

/* the "when would a sensible creature use this" rules from the Forge's guidance */
function conditionFor(a, freq) {
  const limited = freq !== 'at will';
  const rech = freq && freq.reset === 'recharge';
  if (a.actionSlot === 5 || a.actionSlot === 6) return 'default';
  if (a.type === 'heal') return a.target === 'self' ? (a.tempHP ? 'has no THP' : 'is under half HP') : 'ally under half HP';
  if ((a.type === 'buff' || a.type === 'debuff') && a.buff && ['entire encounter', 'repeat the save each round'].includes(a.buff.duration) && a.actionSlot !== 5 && a.actionSlot !== 6) return 'not used yet';
  if (rech) return 'is available';
  if (limited && (a.useSaves || a.type === 'debuff') && (a.targets || 1) > 1) return 'enemy count multiple';
  return 'default';
}

/* ---------- traits ---------- */
function readTrait(entry, h, notes, out) {
  const nm = nameAndUsage(entry.raw), t = entry.text, low = nm.name.toLowerCase();
  if (/^spellcasting|innate spellcasting/i.test(nm.name)) return 'spell';
  if (/magic resistance/i.test(low)) { out.push({ name: nm.name, actionSlot: 5, freq: 'at will', condition: 'default', targets: 1, type: 'buff', target: 'self', buff: { duration: 'entire encounter', condition: 'Saves with Advantage' }, ext: { range: 0 } }); return true; }
  if (/pack tactics/i.test(low)) { h.ext.packTactics = true; return true; }
  if (/nimble escape|cunning action/i.test(low)) { h.ext.bonusDisengage = true; out.push(hideAction(h, 'Hide (' + nm.name + ')')); return true; }
  if (/regeneration/i.test(low) || /regains? \d+ hit points at the start of (?:its|each of its) turn/i.test(t)) {
    const m = t.match(/regains?\s*(\d+)\s*hit points/i);
    if (m) { out.push({ name: nm.name, actionSlot: 5, freq: 'at will', condition: 'default', targets: 1, type: 'heal', amount: m[1], target: 'self', ext: { range: 0 } }); return true; }
  }
  if (/surprise attack|ambush/i.test(low) || /creature it (?:surprised|has surprised)|against any creature it surprised/i.test(t)) {
    const dm = damageParts(t);
    out.push({ name: nm.name, actionSlot: -3, freq: 'at will', condition: 'default', targets: 1, type: 'buff', target: 'self', buff: dm.length ? { duration: 'until next attack made', damage: dm[0].dice } : { duration: '1 round', condition: 'Attacks with Advantage' }, ext: { range: 0, onlyIfEnemiesSurprised: true } });
    return true;
  }
  // death bursts: "When the X dies, it explodes…"
  if (/\bwhen [^.]{0,40}?\b(?:dies|is reduced to 0 hit points|drops to 0 hit points)/i.test(t)) {
    const a = readSaveEffect(entry, nm, notes, h) || null;
    if (a) { a.actionSlot = -1; a.condition = 'default'; out.push(a); return true; }
  }
  // auras: damage to creatures near it at the start/end of turns, with or without a save
  if (/within (\d+) (?:feet|ft)/i.test(t) && /(?:start|end) of (?:each of )?(?:its|their|[\w'’-]+'s?) turns?|starts its turn|ends its turn|starts their turn|ends their turn/i.test(t)) {
    const parts = damageParts(t);
    if (parts.length) {
      const sv = saveInfo(t);
      const r = +t.match(/within (\d+) (?:feet|ft)/i)[1];
      const dc = sv ? sv.dc : (h._dc || 8 + h.pb + Math.max(h.mod('con'), h.mod('cha'), h.mod('wis')));
      out.push({ name: nm.name, actionSlot: 5, freq: 'at will', condition: 'default', targets: r >= 15 ? 3 : r >= 10 ? 2 : 1, type: 'atk', dpr: cleanDice(parts[0].dice), toHit: dc, useSaves: true, target: 'enemy with most HP', ext: { range: r, ...(sv ? { saveAbility: sv.ab } : {}) }, _aura: true });
      if (!sv) notes.push(`${nm.name}: an aura with no save — modelled as a save against DC ${dc} so it doesn't always hit.`);
      return true;
    }
  }
  if (/legendary resistance/i.test(low)) {
    const m = (entry.raw + ' ' + t).match(/(\d+)\s*\/\s*Day/i);
    h.ext.legendaryResistance = m ? +m[1] : 3;
    notes.push(`${nm.name}: on the War Table it turns failed saves against dangerous effects (disabling conditions, or damage that would drop it or cost a big share of its hit points) into successes, ${h.ext.legendaryResistance}/day.`);
    return true;
  }
  // pure flavour: no numbers, dice, saves or rules words
  if (!/\d|\bDC\b|advantage|disadvantage|resist|immun|saving throw|hit points|damage|attack|condition|speed|reaction|bonus action|regain/i.test(t)) { notes.push(`"${nm.name}" is flavour text; nothing to model.`); return true; }
  return false;
}
function hideAction(h, name) {
  const chance = Math.max(0.05, Math.min(1, (21 + h.stealth - 15) / 20));
  return { name: name || 'Hide', actionSlot: 1, freq: 'at will', condition: 'default', targets: 1, type: 'buff', target: 'self', buff: { duration: '1 round', condition: 'Invisible' }, ext: { range: 0, successChance: round1(chance) } };
}

/* ---------- Multiattack: which attacks, how many of each ---------- */
function readMultiattack(entry, attacks, notes, others) {
  const t = entry.text.replace(/\.$/, '').split(/\.\s+/).filter(x => !/in place of|instead of|can replace|can use its [\w ]+ (?:in place|instead)/i.test(x)).join('. ');
  const swaps = /in place of|instead of|can replace/i.test(entry.text);
  const byName = attacks.filter(a => a.type === 'atk' && !a.useSaves);
  const find = phrase => {
    const p = phrase.toLowerCase().replace(/\battacks?\b|\bwith\b|\bits\b|\bthe\b|\bmelee\b|\branged\b|\busing\b|\bweapon\b/g, ' ').replace(/\s+/g, ' ').trim();
    let best = null;
    for (const a of byName) {
      const n = a.name.toLowerCase();
      const sing = n.replace(/s$/, '');
      if (p.includes(n) || p.includes(sing) || (sing.length > 3 && p.split(' ').some(w => w.replace(/s$/, '') === sing))) { if (!best || n.length > best.name.length) best = a; }
    }
    return best;
  };
  // options: "…or…" between whole routines; take the first as the main one
  const routines = t.split(/\.\s+Or\b|;\s*or\b|,? or (?=(?:it |the \w+ )?makes)|\bOr the \w+ makes\b|\s+or\s+(?=(?:one|two|three|four|five|six|\d+)\s)/i);
  const parseRoutine = rt => {
    const combo = [];
    const total = rt.match(/makes?\s+(\w+)\s+(?:melee |ranged |weapon )*attacks?/i);
    // "one with its bite and two with its claws" / "two Rend attacks" / "two attacks with its longsword"
    const re = /\b(one|two|three|four|five|six|\d+)\s+(?:of\s+)?([A-Za-z' -]+?)(?=,|\band\b|\bor\b|$|\.|:|;)/gi;
    let m;
    const body = rt.replace(/^.*?:/, m0 => (/makes/i.test(m0) ? ' ' : m0));
    while ((m = re.exec(body))) {
      const n = num(m[1]), a = find(m[2]);
      if (a && n > 0) combo.push({ a, n });
    }
    // "makes two attacks, using Blowpipe or Molten Gather in any combination": each named option, n times (the best is picked below)
    const usingM = !combo.length && total && rt.match(/\busing\s+(?:its\s+)?(.+?)(?:\s+in any (?:combination|order)|\.|$)/i);
    let choice = false;
    if (usingM) {
      const picks = usingM[1].split(/,|\bor\b|\band\b/).map(x => find(x.replace(/^\s*(?:its|a|an|the)\s+/i, '').trim())).filter((a, i, arr) => a && arr.indexOf(a) === i);
      if (picks.length) { picks.forEach(a => combo.push({ a, n: num(total[1]) })); choice = picks.length > 1; }
    }
    if (!combo.length && total) {
      // "makes two melee attacks" / "makes two attacks" with nothing named: its best melee weapon
      const n = num(total[1]);
      const ranged = /ranged attacks?/i.test(rt) && !/melee/i.test(rt);
      const pick = byName.filter(a => ranged ? a._ranged : a._melee).sort((p, q) => q._avg - p._avg)[0] || byName[0];
      if (pick && n > 0) combo.push({ a: pick, n });
    }
    // "using Mace or Radiant Flame in any combination": the best of those, n times
    if (combo.length > 1 && (choice || /any combination|in any order/i.test(rt))) {
      const n = num(total ? total[1] : combo.length) || combo.length;
      const best = combo.slice().sort((p, q) => q.a._avg - p.a._avg)[0];
      const out = [{ a: best.a, n }];
      // the others as War Table alternatives: n ranged shots when the best is melee, and so on
      out.others = combo.filter(c => c.a !== best.a && (c.a._melee !== best.a._melee || c.a.ext.onHit)).map(c => { const r = [{ a: c.a, n }]; r.ranged = !c.a._melee; return r; });
      return out;
    }
    return combo;
  };
  const main = parseRoutine(routines[0]);
  const alts = routines.slice(1).map(rt => { const c = parseRoutine(rt); c.ranged = /ranged|throw|shoot|range/i.test(rt) && !/melee/i.test(rt); return c; }).filter(c => c.length);
  main.ranged = /ranged attacks?/i.test(routines[0]) && !/melee/i.test(routines[0]);
  if (main.others) alts.push(...main.others);
  const pre = [];
  for (const o of others) if (new RegExp('\\buses?\\s+(?:its\\s+)?' + o.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t)) pre.push(o);
  if (!main.length) { notes.push('Multiattack: couldn\'t tell which attacks it makes; kept the individual attacks instead.'); return null; }
  return { main, alts, pre, replace: swaps };
}
function comboAction(name, combo) {
  const forceRanged = !!combo.ranged;
  const n = combo.reduce((s, c) => s + c.n, 0);
  const same = combo.every(c => c.a.dpr === combo[0].a.dpr && c.a.toHit === combo[0].a.toHit);
  const a = { name, actionSlot: 0, freq: 'at will', condition: 'default', targets: n, type: 'atk', target: 'enemy with most HP', ext: {} };
  if (same) { a.dpr = combo[0].a.dpr; a.toHit = combo[0].a.toHit; }
  else {
    a.dpr = round1(combo.reduce((s, c) => s + c.n * avgDice(c.a.dpr), 0) / n);
    a.toHit = Math.round(combo.reduce((s, c) => s + c.n * c.a.toHit, 0) / n);
  }
  const melee = !forceRanged && combo.every(c => c.a._melee);
  a.ext.range = melee ? Math.min(...combo.map(c => c.a.ext.range)) : Math.min(...combo.map(c => c.a._ranged || c.a.ext.range));
  // riders and grapples from the attack that makes up most of the routine
  const lead = combo.slice().sort((p, q) => q.n - p.n)[0].a;
  if (lead.riderEffect) a.riderEffect = JSON.parse(JSON.stringify(lead.riderEffect));
  if (lead.ext.riderSave) a.ext.riderSave = lead.ext.riderSave;
  if (lead.ext.onHit) a.ext.onHit = JSON.parse(JSON.stringify(lead.ext.onHit));
  const types = combo.map(c => c.a.ext.damageType).filter(Boolean);
  if (types.length && types.every(t => t === types[0])) { a.ext.damageType = types[0]; if (lead.ext.damageMix) a.ext.damageMix = JSON.parse(JSON.stringify(lead.ext.damageMix)); }
  else if (types.length) {
    const mix = {};
    combo.forEach(c => {
      if (c.a.ext.damageMix) c.a.ext.damageMix.forEach(([t, w]) => { mix[t] = (mix[t] || 0) + c.n * w; });
      else if (c.a.ext.damageType) mix[c.a.ext.damageType] = (mix[c.a.ext.damageType] || 0) + c.n * (c.a._avg || 1);
    });
    a.ext.damageType = Object.keys(mix).join(' + '); a.ext.damageMix = Object.entries(mix).map(([t, w]) => [t, round1(w)]);
  }
  const g = combo.find(c => c.a.ext.grapple);
  if (g) a.ext.grapple = Object.assign({}, g.a.ext.grapple);
  a._avg = combo.reduce((s, c) => s + c.n * c.a._avg, 0);
  a._melee = melee; a._ranged = melee ? 0 : a.ext.range;
  return a;
}

/* ---------- one statblock ---------- */
function parseOne(block) {
  const notes = [];
  const bodyLines = block.split('\n').map(l => l.trim()).filter(Boolean);
  const lines = bodyLines.map(l => l.replace(/^\u0007/, ''));
  // D&D Beyond puts labels on their own line ("Armor Class" / "11 (hide armor)"): join them back up
  const joined = [], bullet = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    bullet.push(bodyLines[i].charAt(0) === '\u0007');
    if (/^(Armor Class|Hit Points|Speed|Saving Throws|Skills|Senses|Languages|Challenge|Proficiency Bonus|Damage Resistances|Damage Immunities|Damage Vulnerabilities|Condition Immunities|STR|DEX|CON|INT|WIS|CHA|Initiative)$/i.test(l) && lines[i + 1] && !SECTION_RE.test(lines[i + 1])) { joined.push(l + ' ' + lines[i + 1]); i++; }
    else joined.push(l);
  }
  const flat = joined.join('\n');
  const h = parseHeader(joined, flat, notes);
  const body = parseBody(joined.map((l, i) => (bullet[i] ? '\u0007' : '') + l));

  const actions = [];
  const spellOut = [];
  let spellbook = null;
  const firstDC = (flat.match(/DC\s*(\d+)/) || [])[1];
  if (firstDC) h._dc = +firstDC;

  // traits
  const acNote = (flat.match(/\b(?:Armor Class|AC)\b\s*:?\s*\d+\s*\(([^)]*)\)/i) || [])[1] || '';
  for (const e of body.traits) {
    const nm0 = nameAndUsage(e.raw);
    // "Can't make opportunity attacks" (War Table)
    const noOA = /(?:can't|cannot|can not|doesn't|does not|never) (?:make|take) opportunity attacks/i.test(e.text);
    if (noOA) h.ext.noOpportunityAttacks = true;
    // the trait that explains its AC ("Armor Class 18 (Calculated Defense)") is already in the number
    if (acNote && acNote.toLowerCase().indexOf(nm0.name.toLowerCase()) >= 0) { notes.push(`"${nm0.name}" is already counted in its Armor Class.`); continue; }
    if (noOA && !/\d|\bDC\b|advantage|resist|immun|saving throw|hit points|damage/i.test(e.text.replace(/opportunity attacks?/gi, ''))) { notes.push(`"${nm0.name}": can't make opportunity attacks (War Table).`); continue; }
    const r = readTrait(e, h, notes, actions);
    if (r === 'spell') { const so = parseSpellcasting(e, h, notes); if (so.spellbook) spellbook = so.spellbook; spellOut.push(...so.actions); }
    else if (!r) {
      const nm = nameAndUsage(e.raw);
      // set off by something other creatures do ("Whenever a creature within 60 feet scores a critical hit…"): not an aura
      if (/^(?:whenever|each time|every time)\b[^.]*\b(?:deals?|scores?|fails?|expends?|casts?|spends?|uses?|makes?|regains?|hits?)\b/i.test(e.text) &&
          !/(?:start|end)s? (?:of )?(?:its|their|each of its) turns?/i.test(e.text)) { notes.push(`Trait "${nm.name}" is set off by what other creatures do; not modelled.`); continue; }
      const a = readAttack(e, nm, notes) || readSaveEffect(e, nm, notes, h);
      if (a) { a.actionSlot = 5; actions.push(a); }
      else if (!/^(Amphibious|Keen|Standing Leap|Spider Climb|Water Breathing|Hold Breath|False Appearance|Sunlight Sensitivity|Devil's Sight|Shapechanger|Echolocation|Flyby|Aggressive|Charge|Pounce|Trampling Charge|Siege Monster|Dark Devotion|Brave|Mimicry|Illumination|Web Sense|Web Walker|Limited Amphibiousness|Beast of Burden|Labyrinthine Recall|Fey Ancestry|Avoidance|Turn Immunity|Turn Resistance|Undead Fortitude|Immutable Form|Magic Weapons|Rejuvenation|Incorporeal Movement|Ethereal Sight)/i.test(nm.name))
        notes.push(noOA ? `Trait "${nm.name}": can't make opportunity attacks (War Table); the rest isn't modelled.` : `Trait "${nm.name}" isn't modelled.`);
      else notes.push(`Trait "${nm.name}" has no combat number; left out.`);
    }
  }
  // action sections
  const slotOf = { actions: 0, 'bonus actions': 1, reactions: 4, 'legendary actions': 2, 'mythic actions': 2, 'lair actions': 3 };
  const noRepeatLair = /can't use the same (?:lair )?(?:action|effect) two rounds in a row|can't (?:use|take) the same one two rounds/i.test(body.intro || '') || /can't use the same lair action two rounds in a row/i.test(flat);
  const parsedBySection = {};
  const multis = [];
  for (const sec of ['actions', 'bonus actions', 'reactions', 'legendary actions', 'mythic actions', 'lair actions']) {
    parsedBySection[sec] = [];
    for (const e of body[sec]) {
      e._size = h.ext.size;
      const nm = nameAndUsage(e.raw);
      const low = nm.name.toLowerCase();
      if (/^multiattack/.test(low)) { multis.push({ e, sec }); continue; }
      // a routine under its own name: "Legislative Revision. Elparin makes two Statutory Editing strikes…"
      if (sec === 'actions' && !/\bto hit\b|Attack(?:\s*Roll)?\s*:|saving throw|\bDC\s*\d/i.test(e.text) &&
          /\bmakes?\s+(?:two|three|four|five|six|[2-9])\b[^.]{0,60}?\b(?:attacks?|strikes?)\b/i.test(e.text) && !/swallow/i.test(low + ' ' + e.text)) { multis.push({ e, sec, label: nm.name }); continue; }
      if (/^spellcasting/.test(low)) { const so = parseSpellcasting(e, h, notes); if (so.spellbook) spellbook = so.spellbook; so.actions.forEach(a => { if (sec === 'bonus actions' && a.actionSlot === 0) a.actionSlot = 1; spellOut.push(a); }); continue; }
      // bonus-action spell menus ("Divine Aid (3/Day). The priest casts Bless, …, Healing Word …")
      const castsList = e.text.match(/\bcasts?\s+(?:one of the following spells?:?\s*)?([A-Z][^.]*?)(?:,\s*using|\.\s|$)/);
      if (castsList && !/Attack|saving throw/i.test(e.text)) {
        const raw = castsList[1].split(/,|\bor\b/).map(s => s.trim().toLowerCase()).filter(Boolean);
        const lvOf = {}; const names = raw.map(r => { const n = r.replace(/\(.*?\)/g, '').replace(/\bon itself\b|\bat will\b/g, '').trim(); const v = r.match(/level (\d) version/); if (v) lvOf[n] = +v[1]; return n; });
        const got = names.filter(n => root.SpellData && root.SpellData[n]);
        got.forEach(n => {
          const sp = root.SpellData[n];
          const a = spellAction(n, sp, spellCtx(h, flat), { freq: nm.freq, atLevel: lvOf[n] });
          a.name = `${cap(n)} (${nm.name})`;
          a.actionSlot = slotOf[sec];
          spellOut.push(a);
        });
        const miss = names.filter(n => !got.includes(n));
        if (miss.length) notes.push(`${nm.name}: ${miss.join(', ')} not modelled.`);
        continue;
      }
      if (/nimble escape|cunning action/i.test(low) || (/\bHide action\b/i.test(e.text) && sec === 'bonus actions')) { h.ext.bonusDisengage = true; parsedBySection[sec].push(hideAction(h, 'Hide (' + nm.name + ')')); continue; }
      // "When a creature targets it with an attack or spell … must succeed on a DC 22 Intelligence saving throw or the action is canceled"
      const firstName = h.name.split(/[\s,]+/)[0];
      if (sec === 'reactions' && /\btargets?\s+(?:it|him|her|them|[A-Z][\w'-]+)\s+with an attack/i.test(e.text) && /\b(?:cancel+ed|negated|wasted|is lost|fails? automatically|has no effect)\b/i.test(e.text)) {
        const sv = saveInfo(e.text);
        const self = new RegExp('targets?\\s+(?:it|him|her|them|' + firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b', 'i').test(e.text) && !/an ally|another creature/i.test(e.text);
        if (self) {
          parsedBySection[sec].push({ name: nm.name, actionSlot: 4, freq: nm.freq, condition: 'default', targets: 1, type: 'debuff', saveDC: sv ? sv.dc : 99, target: 'enemy with highest DPR', buff: { duration: 'until next attack made', condition: 'Attacks with Disadvantage' }, ext: { range: rangeOf(e.text, 60).ranged || 60, cancelAction: true, selfOnly: true, ...(sv ? { saveAbility: sv.ab } : {}) } });
          notes.push(`${nm.name}: on the War Table it can void an attack or spell aimed at ${firstName} (save or the action is lost); the export treats it as disadvantage on that attack.`);
          continue;
        }
      }
      if (sec === 'reactions' && /attack roll against (?:it|him|her|them)|is targeted by an attack|would hit (?:it|him|her)/i.test(e.text) && /disadvantage/i.test(e.text) && !/to (?:its|his|her|their) AC/i.test(e.text)) {
        const sv = saveInfo(e.text);
        parsedBySection[sec].push({ name: nm.name, actionSlot: 4, freq: nm.freq, condition: 'default', targets: 1, type: 'debuff', saveDC: sv ? sv.dc : 99, target: 'enemy with highest DPR', buff: { duration: 'until next attack made', condition: 'Attacks with Disadvantage' }, ext: { range: rangeOf(e.text, 60).ranged || 60, ...(sv ? { saveAbility: sv.ab } : {}), ...(/against (?:it|him|her|them)self|against (?:it|him|her)\b/i.test(e.text) && !/ally|another creature/i.test(e.text) ? { selfOnly: true } : {}) } });
        continue;
      }
      if (sec === 'reactions' && /(?:adds?|gains?)\s*(?:a\s*)?\+?(\d+)\s*(?:bonus\s*)?to (?:its|his|her|their) AC/i.test(e.text)) {
        const ac = +e.text.match(/(?:adds?|gains?)\s*(?:a\s*)?\+?(\d+)\s*(?:bonus\s*)?to (?:its|his|her|their) AC/i)[1];
        parsedBySection[sec].push({ name: nm.name, actionSlot: 4, freq: nm.freq, condition: 'default', targets: 1, type: 'buff', target: 'self', buff: { duration: 'until next attack taken', ac }, ext: { range: 0 } });
        continue;
      }
      // "When a creature ends its turn within 5 feet of it, it moves up to 10 feet away … without provoking"
      const stepM = sec === 'reactions' && /ends its turn within \d+\s*(?:feet|ft)/i.test(e.text) && /without provoking/i.test(e.text) && e.text.match(/moves? up to (\d+)\s*(?:feet|ft)/i);
      if (stepM) {
        parsedBySection[sec].push({ name: nm.name, actionSlot: 4, freq: nm.freq, condition: 'default', targets: 1, type: 'buff', target: 'self', buff: { duration: '1 round' }, ext: { range: 0, stepAway: +stepM[1], wtOnly: true } });
        notes.push(`${nm.name}: steps ${stepM[1]} ft away when a creature ends its turn next to it — War Table only; the exported day has no movement.`);
        continue;
      }
      // legendary options that just reuse another attack: "The dragon makes a tail attack."
      const reuse = e.text.match(/\b(?:makes|uses)\s+(?:one|a|an|its)\s+([\w' ]+?)\s+attack/i);
      let a = readAttack(e, nm, notes) || readSaveEffect(e, nm, notes, h) || readHeal(e, nm);
      if (!a && reuse) {
        const base = parsedBySection.actions.find(x => x.type === 'atk' && x.name.toLowerCase().replace(/s$/, '') === reuse[1].toLowerCase().replace(/s$/, ''));
        if (base) a = Object.assign(JSON.parse(JSON.stringify(stripPriv(base))), { name: nm.name, _avg: base._avg, _melee: base._melee, _ranged: base._ranged });
      }
      if (!a) {
        if (/swallow/i.test(low)) a = readSwallow(e, nm, parsedBySection.actions, notes);
        else if (/\barrive|\bsummons?\b|\bappear(?:s)? in|\bcalls? (?:forth|in)|reinforcements/i.test(e.text)) { notes.push(`"${nm.name}" brings in other creatures — add them to the encounter yourself.`); continue; }
        else if (/\bmoves? up to|\bteleports?\b|\bfly up to|without provoking/i.test(e.text)) { notes.push(`"${nm.name}" is movement only; the War Table already positions it.`); continue; }
        else { notes.push(`${cap(sec.replace(/s$/, ''))} "${nm.name}" has nothing the simulator can model; left out.`); continue; }
        if (!a) continue;
      }
      a.actionSlot = slotOf[sec];
      if (a.freq === 'at will' && nm.freq !== 'at will') a.freq = nm.freq;
      if (sec === 'lair actions' && noRepeatLair && a.freq === 'at will') { a.freq = { reset: 'recharge', cooldownRounds: 2 }; a.condition = 'is available'; }
      a._cost = nm.cost;
      if (/swallow/i.test(low) && a.type === 'atk' && !a.ext.swallow) { const s = readSwallow(e, nm, parsedBySection.actions, notes); if (s) a = Object.assign(s, { actionSlot: a.actionSlot }); }
      parsedBySection[sec].push(a);
    }
  }

  // multiattack: replace its component attacks with one routine
  let slot0 = parsedBySection.actions;
  for (const { e, label } of multis) {
    const others = slot0.filter(a => a.type !== 'atk' || a.useSaves);
    const ma = readMultiattack(e, slot0, notes, others);
    if (!ma) continue;
    const used = new Set(ma.main.map(c => c.a));
    const multi = comboAction('Multiattack', ma.main);
    multi.name = (label || 'Multiattack') + ' (' + ma.main.map(c => `${c.n} ${c.a.name}`).join(', ') + ')';
    const optOut = label && e.text.match(/\bor\s+uses?\s+(?:its\s+)?([A-Z][\w' ]+?)(?:\s+once)?\s*\.?$/);
    if (optOut && !slot0.concat(spellOut).some(a => a.name.toLowerCase() === optOut[1].trim().toLowerCase())) notes.push(`${label}: the ${optOut[1].trim()} option isn't modelled; it always makes the attacks.`);
    const altActs = ma.alts.map((c, i) => { c.forEach(x => used.add(x.a)); const x = comboAction('Multiattack' + (ma.alts.length > 1 ? ` ${i + 2}` : ' (alternative)'), c); x.name = 'Multiattack (' + c.map(y => `${y.n} ${y.a.name}`).join(', ') + ')'; x.ext.wtOnly = true; return x; });
    // Frightful Presence & co. used as part of the routine: fire them before the fight starts
    ma.pre.forEach(p => { p.actionSlot = -3; p.condition = 'default'; p.freq = 'at will'; p._pre = true; });
    slot0 = slot0.filter(a => !used.has(a) || a.ext.swallow);
    // attacks the routine doesn't use stay as War Table alternatives (a bow when nothing is in reach)
    slot0.forEach(a => { if (a.type === 'atk' && !a.useSaves && a.freq === 'at will' && !a.ext.swallow) { a.ext.wtOnly = true; if (a._ranged) a.ext.range = a._ranged; } });
    // single-target limited spells that hit less than the routine: kept for when the routine can't reach (War Table)
    slot0.concat(spellOut).forEach(a => {
      if (a.actionSlot === 0 && a.freq !== 'at will' && !(a.ext && a.ext.area) && a.type !== 'heal' && a.type !== 'buff' && !(a.freq && a.freq.reset === 'recharge') && (a._avg === undefined || a._avg < multi._avg)) { a.ext.wtOnly = true; a._below = true; }
    });
    slot0.push(multi, ...altActs);
    if (ma.replace) notes.push('Multiattack can swap an attack for something else; only the attack routine is modelled.');
  }
  parsedBySection.actions = slot0;

  // assemble every slot
  const all = actions.concat(parsedBySection.actions, parsedBySection['bonus actions'], parsedBySection.reactions, parsedBySection['legendary actions'], parsedBySection['mythic actions'], parsedBySection['lair actions'], spellOut);
  all.forEach(a => { if (!a.condition || a.condition === 'default') a.condition = a._pre ? 'default' : conditionFor(a, a.freq); });
  // legendary actions cost 2+: once in a while
  all.filter(a => a.actionSlot === 2 && a._cost > 1).forEach(a => {
    a.ext.legendaryCost = a._cost;
    if (a.freq === 'at will') { a.freq = { reset: 'recharge', cooldownRounds: Math.min(6, 1 + a._cost) }; a.condition = 'is available'; }
  });

  if (h.damageMult !== 1) {
    all.push({ name: h.damageMult < 1 ? 'Damage resistances' : 'Damage vulnerabilities', actionSlot: 5, freq: 'at will', condition: 'default', targets: 1, type: 'buff', target: 'self', buff: { duration: 'entire encounter', damageTakenMultiplier: h.damageMult }, ext: { range: 0, avgResist: h.damageMult } });
    notes.push(`${h.resText.charAt(0).toUpperCase() + h.resText.slice(1)}: the War Table checks each hit's damage type; the export averages it to damage taken ×${h.damageMult}.`);
  }
  // passive self-buffs (Magic Resistance, resistances…) merge into one, so they all fit the two passive slots
  const passBuffs = all.filter(a => (a.actionSlot === 5 || a.actionSlot === 6) && a.type === 'buff' && a.target === 'self' && a.buff && a.buff.duration === 'entire encounter' && !(a.ext && a.ext.wtSkip));
  if (passBuffs.length > 1) {
    const merged = { name: passBuffs.map(a => a.name).join(' + '), actionSlot: 5, freq: 'at will', condition: 'default', targets: 1, type: 'buff', target: 'self', buff: { duration: 'entire encounter' }, ext: { range: 0 } };
    passBuffs.forEach(a => { if (a.ext && a.ext.avgResist) merged.ext.avgResist = round1((merged.ext.avgResist || 1) * a.ext.avgResist); });
    for (const a of passBuffs) for (const [k, v] of Object.entries(a.buff)) {
      if (k === 'duration') continue;
      if (k === 'damageTakenMultiplier' || k === 'damageMultiplier') merged.buff[k] = round1((merged.buff[k] || 1) * v);
      else if (k === 'condition') { if (!merged.buff.condition) merged.buff.condition = v; else notes.push(`"${a.name}" (${v}) couldn't be combined with ${merged.buff.condition}; dropped.`); }
      else merged.buff[k] = merged.buff[k] === undefined ? v : cleanDice(merged.buff[k] + ' + ' + v);
    }
    for (const a of passBuffs) all.splice(all.indexOf(a), 1);
    all.unshift(merged);
  }
  // per slot: no two always-on defaults; most specific first
  const out = [];
  for (const slot of [-3, -1, -2, 0, 1, 2, 3, 4, 5]) {
    let list = all.filter(a => a.actionSlot === slot || (slot === 5 && a.actionSlot === 6));
    if (!list.length) continue;
    if (slot === 5 || slot === 6) { list.forEach((a, i) => { a.actionSlot = i === 0 ? 5 : 6; }); out.push(...list.slice(0, 2)); if (list.length > 2) { list.slice(2).forEach(a => { a.actionSlot = 6; a.ext.wtOnly = true; }); out.push(...list.slice(2)); notes.push('More than two passive traits; the extras are War Table only.'); } continue; }
    const isDefault = a => a.condition === 'default' && a.freq === 'at will' && !(a.ext && (a.ext.wtOnly || a.ext.swallow || a.ext.onlyIfEnemiesSurprised));
    const defs = list.filter(isDefault);
    if (defs.length > 1) {
      // keep the hardest-hitting option as the exported default; the rest stay War Table alternatives
      const worth = a => (a._avg || 0) * (a.useSaves || a.type !== 'atk' ? 1 : (a.targets || 1) > 1 && a.name.startsWith('Multiattack') ? 1 : (a.targets || 1)) * (a._melee ? 1.3 : 1);
      const keep = defs.slice().sort((p, q) => worth(q) - worth(p))[0];
      defs.forEach(a => { if (a !== keep) { a.ext.wtOnly = true; if (a._ranged && keep._melee) a.ext.range = a._ranged; } });
    }
    const rank = a => a.ext.swallow ? 0 : a._below ? 6 : a.condition !== 'default' ? (a.freq && a.freq.reset === 'recharge' ? 1 : 2) : isDefault(a) ? 4 : a.ext.wtOnly ? 5 : 3;
    list = list.map((a, i) => ({ a, i })).sort((p, q) => rank(p.a) - rank(q.a) || p.i - q.i).map(x => x.a);
    out.push(...list);
  }
  const lam = flat.match(/can take (\d+) legendary actions|Legendary Action Uses:\s*(\d+)/i);
  if (lam) h.ext.legendaryActions = +(lam[1] || lam[2]);
  const mon = { name: h.name, type: h.type, cr: h.cr, src: 'Custom', count: 1, hp: h.hp, AC: h.AC, saveBonus: h.saveBonus, ext: h.ext, actions: out.map(stripPriv) };
  if (spellbook) mon.ext.spellbook = spellbook;
  if (!mon.actions.length && !spellbook) notes.push('No usable actions found — add them in the editor.');
  if (!parsedBySection['lair actions'].length && /lair action/i.test(flat)) notes.push('Lair actions found but none could be converted.');
  if (parsedBySection.actions.some(a => a._noteExtra)) notes.push('Extra save-for-damage on hits is folded into the hit damage at its usual success rate.');
  mon._notes = notes;
  return mon;
}
function spellCtx(h, flat) {
  const dcm = flat.match(/spell save DC\s*(\d+)/i), hitm = flat.match(/([+-]\d+)\s*to hit with spell attacks/i);
  const abm = flat.match(/(?:spellcasting ability is|using|uses)\s*(Intelligence|Wisdom|Charisma)/i);
  const mod = h.mod(abm ? ABIL_NAMES[abm[1].toLowerCase()] : 'wis');
  const lvl = Math.max(1, +(h.cr.includes('/') ? 1 : h.cr));
  return { dc: dcm ? +dcm[1] : 8 + h.pb + mod, atk: hitm ? +hitm[1] : h.pb + mod, mod, lvl, cantripDice: lvl >= 17 ? 4 : lvl >= 11 ? 3 : lvl >= 5 ? 2 : 1 };
}
function readSwallow(e, nm, attacks, notes) {
  const t = e.text;
  const bite = attacks.find(a => /bite/i.test(a.name) && a.type === 'atk') || attacks.find(a => a.type === 'atk');
  if (!bite) return null;
  const sz = t.match(/(Tiny|Small|Medium|Large|Huge)\s+or\s+smaller/i);
  const dig = damageParts(t.slice(t.search(/swallowed/i) >= 0 ? t.search(/swallowed/i) : 0));
  const thr = t.match(/takes?\s*(\d+)\s*damage or more on a single turn from a creature inside/i);
  const rdc = t.match(/DC\s*(\d+)\s*Constitution saving throw/i);
  const cap1 = t.match(/can have (?:only )?(\w+) (?:targets?|creatures?) swallowed/i);
  const a = JSON.parse(JSON.stringify(stripPriv(bite)));
  a.name = nm.name; a.freq = 'at will'; a.condition = 'default';
  delete a.ext.grapple; delete a.ext.wtOnly; delete a.riderEffect;
  a.ext.swallow = { maxSize: sz ? cap(sz[1].toLowerCase()) : 'Medium', digest: dig.length ? dig[0].dice : '2d6', capacity: cap1 && !isNaN(num(cap1[1])) ? num(cap1[1]) : 1 };
  if (thr && rdc) a.ext.swallow.regurgitate = { threshold: +thr[1], dc: +rdc[1], saveBonus: 0 };
  return a;
}
function stripPriv(a) { const o = {}; for (const k in a) if (k[0] !== '_') o[k] = a[k]; if (o.ext && !Object.keys(o.ext).length) delete o.ext; return o; }

function parse(text) {
  const blocks = splitBlocks(text);
  const monsters = [], skipped = [];
  for (const b of blocks) {
    try { monsters.push(parseOne(b)); }
    catch (err) { skipped.push((b.split('\n')[0] || 'statblock') + ': ' + err.message); }
  }
  return { monsters, skipped };
}

root.StatblockParser = { parse, splitBlocks, _internals: { avgDice, cleanDice, damageMultiplier, areaInfo, saveInfo, spellAction } };
})(typeof window !== 'undefined' ? window : globalThis);
