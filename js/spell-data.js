/* =====================================================================
   SPELL DATA — the combat-relevant spells a monster statblock is likely to list,
   in a compact form the statblock parser turns into actions.
   Fields:
     L      spell level (0 = cantrip)
     k      'atk' (spell attack) · 'save' (save for damage) · 'heal' · 'buff' · 'debuff' · 'shield'
     d      damage / healing dice at base level (cantrips: per die count, scaled by caster level)
     mod    true: add the spellcasting modifier to the dice (Cure Wounds, Healing Word…)
     sv     save ability · h: half damage on a save
     a      area [shape, size] · r: range in feet (0 = self) · t: creatures caught / hits made
     c      concentration · u: extra dice per slot level above · ut: extra targets per slot level
     b      buff object (buff/debuff spells) · tg: 'self' | 'ally' for buffs
     bonus  cast as a bonus action · react: cast as a reaction
     tmp    heal is temporary hit points · types: only works on these creature types
     e      extra ext fields (War Table)
     dt     damage type (set from the DT table at the bottom)
   Spells not listed here (utility, movement, summons) are skipped with a note.
   ===================================================================== */
(function (root) {
'use strict';
const S = {
  // ---- cantrips ----
  'acid splash':      { L: 0, k: 'save', d: '1d6', sv: 'dex', r: 60, t: 1 },
  'chill touch':      { L: 0, k: 'atk', d: '1d8', r: 120 },
  'eldritch blast':   { L: 0, k: 'atk', d: '1d10', r: 120, beams: true },
  'fire bolt':        { L: 0, k: 'atk', d: '1d10', r: 120 },
  'frostbite':        { L: 0, k: 'save', d: '1d6', sv: 'con', r: 60 },
  'infestation':      { L: 0, k: 'save', d: '1d6', sv: 'con', r: 30 },
  'mind sliver':      { L: 0, k: 'save', d: '1d6', sv: 'int', r: 60 },
  'poison spray':     { L: 0, k: 'save', d: '1d12', sv: 'con', r: 10 },
  'primal savagery':  { L: 0, k: 'atk', d: '1d10', r: 5 },
  'produce flame':    { L: 0, k: 'atk', d: '1d8', r: 30 },
  'ray of frost':     { L: 0, k: 'atk', d: '1d8', r: 60, e: { onHit: { slow: 10 } } },
  'sacred flame':     { L: 0, k: 'save', d: '1d8', sv: 'dex', r: 60 },
  'shocking grasp':   { L: 0, k: 'atk', d: '1d8', r: 5, e: { onHit: { noReactions: true } } },
  'sorcerous burst':  { L: 0, k: 'atk', d: '1d8', r: 120 },
  'starry wisp':      { L: 0, k: 'atk', d: '1d8', r: 60 },
  'sword burst':      { L: 0, k: 'save', d: '1d6', sv: 'dex', a: ['emanation', 5], r: 5, t: 2 },
  'thorn whip':       { L: 0, k: 'atk', d: '1d6', r: 30 },
  'toll the dead':    { L: 0, k: 'save', d: '1d8', sv: 'wis', r: 60, e: { dprIfHurt: '1d12' } },
  'vicious mockery':  { L: 0, k: 'save', d: '1d4', sv: 'wis', r: 60, rider: { duration: 'until next attack made', condition: 'Attacks with Disadvantage' } },
  'word of radiance': { L: 0, k: 'save', d: '1d6', sv: 'con', a: ['emanation', 5], r: 5, t: 2 },
  // ---- 1st level ----
  'arms of hadar':    { L: 1, k: 'save', d: '2d6', sv: 'str', h: true, a: ['emanation', 10], r: 10, t: 3, u: '1d6', e: { onHit: { noReactions: true } } },
  'armor of agathys': { L: 1, k: 'heal', d: '5', tmp: true, tg: 'self', u: '5', e: { retaliate: { dmg: 5, perLevel: true } } },
  'bane':             { L: 1, k: 'debuff', sv: 'cha', c: true, r: 30, t: 3, ut: 1, b: { duration: 'entire encounter', toHit: '-1d4', save: '-1d4' } },
  'bless':            { L: 1, k: 'buff', c: true, r: 30, t: 3, ut: 1, tg: 'ally', b: { duration: 'entire encounter', toHit: '1d4', save: '1d4' } },
  'burning hands':    { L: 1, k: 'save', d: '3d6', sv: 'dex', h: true, a: ['cone', 15], r: 15, t: 2, u: '1d6' },
  'cause fear':       { L: 1, k: 'debuff', sv: 'wis', c: true, r: 60, t: 1, ut: 1, b: { duration: 'repeat the save each round', condition: 'Frightened' } },
  'chromatic orb':    { L: 1, k: 'atk', d: '3d8', r: 90, u: '1d8', e: { leap: { range: 30 } } },
  'command':          { L: 1, k: 'debuff', sv: 'wis', r: 60, t: 1, ut: 1, b: { duration: '1 round', condition: 'Incapacitated' } },
  'cure wounds':      { L: 1, k: 'heal', d: '2d8', mod: true, r: 5, u: '2d8' },
  'dissonant whispers': { L: 1, k: 'save', d: '3d6', sv: 'wis', h: true, r: 60, u: '1d6' },
  'divine favor':     { L: 1, k: 'buff', bonus: true, c: true, tg: 'self', b: { duration: 'entire encounter', damage: '1d4' } },
  'entangle':         { L: 1, k: 'debuff', sv: 'str', c: true, a: ['sphere', 10], r: 90, t: 3, b: { duration: 'repeat the save each round', condition: 'Restrained' }, e: { zone: { difficult: true }, minCatch: 3 } },
  'faerie fire':      { L: 1, k: 'debuff', sv: 'dex', c: true, a: ['cube', 20], r: 60, t: 3, b: { duration: 'entire encounter', condition: 'Is attacked with Advantage' } },
  'false life':       { L: 1, k: 'heal', d: '2d4 + 4', tmp: true, tg: 'self', u: '5' },
  'guiding bolt':     { L: 1, k: 'atk', d: '4d6', r: 120, u: '1d6', rider: { duration: 'until next attack taken', condition: 'Is attacked with Advantage' } },
  'healing word':     { L: 1, k: 'heal', d: '2d4', mod: true, bonus: true, r: 60, u: '2d4' },
  'hellish rebuke':   { L: 1, k: 'save', d: '2d10', sv: 'dex', h: true, react: true, r: 60, u: '1d10' },
  'hex':              { L: 1, k: 'buff', bonus: true, c: true, tg: 'self', b: { duration: 'entire encounter', damage: '1d6' } },
  "hunter's mark":    { L: 1, k: 'buff', bonus: true, c: true, tg: 'self', b: { duration: 'entire encounter', damage: '1d6' } },
  'ice knife':        { L: 1, k: 'atk', d: '1d10 + 2d6', r: 60, u: '1d6' },
  'inflict wounds':   { L: 1, k: 'atk', d: '3d10', r: 5, u: '1d10' },
  'magic missile':    { L: 1, k: 'atk', d: '3d4 + 3', r: 120, u: '1d4 + 1', auto: true },
  'ray of sickness':  { L: 1, k: 'atk', d: '2d8', r: 60, u: '1d8', rider: { duration: '1 round', condition: 'Poisoned' } },
  'shield':           { L: 1, k: 'shield', react: true },
  'shield of faith':  { L: 1, k: 'buff', bonus: true, c: true, tg: 'ally', r: 60, b: { duration: 'entire encounter', ac: 2 } },
  "tasha's hideous laughter": { L: 1, k: 'debuff', sv: 'wis', c: true, r: 30, t: 1, ut: 1, b: { duration: 'repeat the save each round', condition: 'Incapacitated' }, e: { saveOnDamage: 'adv' } },
  'hideous laughter': { L: 1, k: 'debuff', sv: 'wis', c: true, r: 30, t: 1, ut: 1, b: { duration: 'repeat the save each round', condition: 'Incapacitated' }, e: { saveOnDamage: 'adv' } },
  'fog cloud':        { L: 1, k: 'debuff', c: true, a: ['sphere', 20], r: 120, t: 4, b: { duration: 'entire encounter', condition: 'Attacks with Disadvantage' }, e: { zone: { fog: true }, wtOnly: true, wtWhen: 'losing' } },
  'thunderwave':      { L: 1, k: 'save', d: '2d8', sv: 'con', h: true, a: ['cube', 15], r: 15, t: 2, u: '1d8', e: { onHit: { push: 10 } } },
  'witch bolt':       { L: 1, k: 'atk', d: '2d12', c: true, r: 60, u: '1d12', e: { wtDpr: '2d12', onHit: { dot: { dice: '1d12', upcast: '1d12' } } } },
  // ---- 2nd level ----
  'aganazzar\'s scorcher': { L: 2, k: 'save', d: '3d8', sv: 'dex', h: true, a: ['line', 30], r: 30, t: 2, u: '1d8' },
  'blindness/deafness': { L: 2, k: 'debuff', sv: 'con', r: 120, t: 1, ut: 1, b: { duration: 'repeat the save each round', condition: 'Blinded' } },
  'blur':             { L: 2, k: 'buff', c: true, tg: 'self', b: { duration: 'entire encounter', condition: 'Is attacked with Disadvantage' } },
  'flaming sphere':   { L: 2, k: 'save', d: '2d6', sv: 'dex', h: true, c: true, a: ['sphere', 5], r: 60, t: 1, u: '1d6', e: { zone: { dmg: true }, hold: 10 } },
  'hold person':      { L: 2, k: 'debuff', sv: 'wis', c: true, r: 60, t: 1, ut: 1, types: ['humanoid'], b: { duration: 'repeat the save each round', condition: 'Paralyzed' } },
  "melf's acid arrow": { L: 2, k: 'atk', d: '4d4 + 2d4', r: 90, u: '1d4' },
  'acid arrow':       { L: 2, k: 'atk', d: '4d4 + 2d4', r: 90, u: '1d4' },
  'misty step':       { L: 2, k: 'buff', bonus: true, tg: 'self', b: { duration: '1 round' }, e: { teleport: 30, wtOnly: true } },
  'mirror image':     { L: 2, k: 'buff', tg: 'self', b: { duration: 'entire encounter', damageTakenMultiplier: 0.29 }, e: { mirror: 3 } },
  'moonbeam':         { L: 2, k: 'save', d: '2d10', sv: 'con', h: true, c: true, a: ['sphere', 5], r: 120, t: 1, u: '1d10', e: { zone: { dmg: true }, hold: 10, sustain: true } },
  'phantasmal force': { L: 2, k: 'save', d: '4d8', sv: 'int', c: true, r: 60, t: 1, e: { wtDpr: '2d8', dot: { dice: '2d8' } } },
  'ray of enfeeblement': { L: 2, k: 'debuff', sv: 'con', c: true, r: 60, t: 1, b: { duration: 'repeat the save each round', condition: 'Attacks with Disadvantage' } },
  'scorching ray':    { L: 2, k: 'atk', d: '2d6', r: 120, hits: 3 },
  'shatter':          { L: 2, k: 'save', d: '3d8', sv: 'con', h: true, a: ['sphere', 10], r: 60, t: 3, u: '1d8' },
  'suggestion':       { L: 2, k: 'debuff', sv: 'wis', c: true, r: 30, t: 1, b: { duration: 'entire encounter', condition: 'Incapacitated' }, e: { endsOnDamage: true } },
  'web':              { L: 2, k: 'debuff', sv: 'dex', c: true, a: ['cube', 20], r: 60, t: 3, b: { duration: 'repeat the save each round', condition: 'Restrained' }, e: { zone: { difficult: true } } },
  // ---- 3rd level ----
  'bestow curse':     { L: 3, k: 'debuff', sv: 'wis', c: true, r: 5, t: 1, b: { duration: 'entire encounter', condition: 'Attacks with Disadvantage' } },
  'call lightning':   { L: 3, k: 'save', d: '3d10', sv: 'dex', h: true, c: true, a: ['sphere', 5], r: 120, t: 1, u: '1d10', e: { hold: 100, sustain: true } },
  'erupting earth':   { L: 3, k: 'save', d: '3d12', sv: 'dex', h: true, a: ['cube', 20], r: 120, t: 3, u: '1d12' },
  'fear':             { L: 3, k: 'debuff', sv: 'wis', c: true, a: ['cone', 30], r: 30, t: 3, b: { duration: 'repeat the save each round', condition: 'Frightened' } },
  'fireball':         { L: 3, k: 'save', d: '8d6', sv: 'dex', h: true, a: ['sphere', 20], r: 150, t: 4, u: '1d6' },
  'hypnotic pattern': { L: 3, k: 'debuff', sv: 'wis', c: true, a: ['cube', 30], r: 120, t: 4, b: { duration: 'entire encounter', condition: 'Incapacitated' }, e: { endsOnDamage: true } },
  'lightning bolt':   { L: 3, k: 'save', d: '8d6', sv: 'dex', h: true, a: ['line', 100], r: 100, t: 2, u: '1d6' },
  'mass healing word': { L: 3, k: 'heal', d: '1d4', mod: true, bonus: true, r: 60, t: 4, u: '1d4' },
  'slow':             { L: 3, k: 'debuff', sv: 'wis', c: true, a: ['cube', 40], r: 120, t: 3, b: { duration: 'repeat the save each round', condition: 'Attacks with Disadvantage', ac: -2 } },
  'spirit guardians': { L: 3, k: 'save', d: '3d8', sv: 'wis', h: true, c: true, a: ['emanation', 15], r: 15, t: 2, u: '1d8', selective: true, e: { zone: { dmg: true, follow: true }, hold: 100 } },
  'stinking cloud':   { L: 3, k: 'debuff', sv: 'con', c: true, a: ['sphere', 20], r: 90, t: 3, b: { duration: 'repeat the save each round', condition: 'Incapacitated' } },
  'vampiric touch':   { L: 3, k: 'atk', d: '3d6', c: true, r: 5, u: '1d6', e: { onHit: { drain: true } } },
  // ---- 4th level ----
  'banishment':       { L: 4, k: 'debuff', sv: 'cha', c: true, r: 60, t: 1, ut: 1, b: { duration: 'entire encounter', condition: 'Incapacitated' } },
  'blight':           { L: 4, k: 'save', d: '8d8', sv: 'con', h: true, r: 30, t: 1, u: '1d8' },
  'confusion':        { L: 4, k: 'debuff', sv: 'wis', c: true, a: ['sphere', 10], r: 90, t: 3, b: { duration: 'repeat the save each round', condition: 'Incapacitated' } },
  "evard's black tentacles": { L: 4, k: 'save', d: '3d6', sv: 'dex', c: true, a: ['cube', 20], r: 90, t: 3, rider: { duration: 'repeat the save each round', condition: 'Restrained' }, e: { zone: { dmg: true, difficult: true }, hold: 10 } },
  'black tentacles':  { L: 4, k: 'save', d: '3d6', sv: 'dex', c: true, a: ['cube', 20], r: 90, t: 3, rider: { duration: 'repeat the save each round', condition: 'Restrained' }, e: { zone: { dmg: true, difficult: true }, hold: 10 } },
  'greater invisibility': { L: 4, k: 'buff', c: true, tg: 'self', b: { duration: 'entire encounter', condition: 'Invisible' } },
  'ice storm':        { L: 4, k: 'save', d: '2d8 + 4d6', sv: 'dex', h: true, a: ['sphere', 20], r: 300, t: 3, u: '1d8' },
  'phantasmal killer': { L: 4, k: 'save', d: '4d10', sv: 'wis', h: true, c: true, r: 120, t: 1, u: '1d10' },
  'stoneskin':        { L: 4, k: 'buff', c: true, tg: 'self', b: { duration: 'entire encounter', damageTakenMultiplier: 0.6 } },
  'wall of fire':     { L: 4, k: 'save', d: '5d8', sv: 'dex', h: true, c: true, a: ['line', 60], r: 120, t: 2, u: '1d8', e: { zone: { dmg: true }, hold: 10 } },
  // ---- 5th level ----
  'cloudkill':        { L: 5, k: 'save', d: '5d8', sv: 'con', h: true, c: true, a: ['sphere', 20], r: 120, t: 3, u: '1d8', e: { zone: { dmg: true }, hold: 10 } },
  'cone of cold':     { L: 5, k: 'save', d: '8d8', sv: 'con', h: true, a: ['cone', 60], r: 60, t: 4, u: '1d8' },
  'destructive wave': { L: 5, k: 'save', d: '10d6', sv: 'con', h: true, a: ['emanation', 30], r: 30, t: 3, selective: true },
  'dominate person':  { L: 5, k: 'debuff', sv: 'wis', c: true, r: 60, t: 1, types: ['humanoid'], b: { duration: 'repeat the save each round', condition: 'Incapacitated' } },
  'flame strike':     { L: 5, k: 'save', d: '8d6', sv: 'dex', h: true, a: ['sphere', 10], r: 60, t: 2, u: '1d6' },
  'hold monster':     { L: 5, k: 'debuff', sv: 'wis', c: true, r: 90, t: 1, ut: 1, b: { duration: 'repeat the save each round', condition: 'Paralyzed' } },
  'insect plague':    { L: 5, k: 'save', d: '4d10', sv: 'con', h: true, c: true, a: ['sphere', 20], r: 300, t: 3, u: '1d10', e: { zone: { dmg: true, difficult: true }, hold: 100 } },
  'mass cure wounds': { L: 5, k: 'heal', d: '3d8', mod: true, r: 60, t: 4, u: '1d8' },
  'synaptic static':  { L: 5, k: 'save', d: '8d6', sv: 'int', h: true, a: ['sphere', 20], r: 120, t: 4 },
  'steel wind strike': { L: 5, k: 'atk', d: '6d10', r: 30, hits: 2 },
  // ---- 6th level ----
  'chain lightning':  { L: 6, k: 'save', d: '10d8', sv: 'dex', h: true, r: 150, t: 4, ut: 1 },
  'circle of death':  { L: 6, k: 'save', d: '8d8', sv: 'con', h: true, a: ['sphere', 60], r: 150, t: 4, u: '2d8' },
  'disintegrate':     { L: 6, k: 'save', d: '10d6 + 40', sv: 'dex', r: 60, t: 1, u: '3d6' },
  'eyebite':          { L: 6, k: 'debuff', sv: 'wis', c: true, r: 60, t: 1, b: { duration: 'entire encounter', condition: 'Incapacitated' } },
  'harm':             { L: 6, k: 'save', d: '14d6', sv: 'con', h: true, r: 60, t: 1 },
  'heal':             { L: 6, k: 'heal', d: '70', r: 60, u: '10' },
  'sunbeam':          { L: 6, k: 'save', d: '6d8', sv: 'con', h: true, c: true, a: ['line', 60], r: 60, t: 2, rider: { duration: '1 round', condition: 'Blinded' }, e: { hold: 10, sustain: true } },
  // ---- 7th–9th level ----
  'delayed blast fireball': { L: 7, k: 'save', d: '12d6', sv: 'dex', h: true, c: true, a: ['sphere', 20], r: 150, t: 4, u: '1d6' },
  'finger of death':  { L: 7, k: 'save', d: '7d8 + 30', sv: 'con', h: true, r: 60, t: 1 },
  'fire storm':       { L: 7, k: 'save', d: '7d10', sv: 'dex', h: true, a: ['cube', 30], r: 150, t: 4 },
  'prismatic spray':  { L: 7, k: 'save', d: '10d6', sv: 'dex', h: true, a: ['cone', 60], r: 60, t: 4 },
  'dominate monster': { L: 8, k: 'debuff', sv: 'wis', c: true, r: 60, t: 1, b: { duration: 'repeat the save each round', condition: 'Incapacitated' } },
  'incendiary cloud': { L: 8, k: 'save', d: '10d8', sv: 'dex', h: true, c: true, a: ['sphere', 20], r: 150, t: 4, e: { zone: { dmg: true }, hold: 10 } },
  'power word stun':  { L: 8, k: 'debuff', sv: 'con', r: 60, t: 1, b: { duration: 'repeat the save each round', condition: 'Stunned' } },
  'sunburst':         { L: 8, k: 'save', d: '12d6', sv: 'con', h: true, a: ['sphere', 60], r: 150, t: 4, rider: { duration: 'repeat the save each round', condition: 'Blinded' } },
  'meteor swarm':     { L: 9, k: 'save', d: '40d6', sv: 'dex', h: true, a: ['sphere', 40], r: 1000, t: 4 },
  'psychic scream':   { L: 9, k: 'save', d: '14d6', sv: 'int', h: true, r: 90, t: 4, rider: { duration: 'repeat the save each round', condition: 'Stunned' } },
};
// damage type of each damage spell: 'a/b/c' = the caster picks one; 'a + b' = half each
const DT = { "acid splash": "acid", "chill touch": "necrotic", "eldritch blast": "force", "fire bolt": "fire", "frostbite": "cold", "infestation": "poison", "mind sliver": "psychic", "poison spray": "poison", "primal savagery": "piercing", "produce flame": "fire", "ray of frost": "cold", "sacred flame": "radiant", "shocking grasp": "lightning", "sorcerous burst": "acid/cold/fire/lightning/poison/psychic/thunder", "starry wisp": "radiant", "sword burst": "force", "thorn whip": "piercing", "toll the dead": "necrotic", "vicious mockery": "psychic", "word of radiance": "radiant", "arms of hadar": "necrotic", "burning hands": "fire", "chromatic orb": "acid/cold/fire/lightning/poison/thunder", "dissonant whispers": "psychic", "guiding bolt": "radiant", "hellish rebuke": "fire", "ice knife": "cold", "inflict wounds": "necrotic", "magic missile": "force", "ray of sickness": "poison", "thunderwave": "thunder", "witch bolt": "lightning", "aganazzar's scorcher": "fire", "flaming sphere": "fire", "melf's acid arrow": "acid", "acid arrow": "acid", "moonbeam": "radiant", "phantasmal force": "psychic", "scorching ray": "fire", "shatter": "thunder", "call lightning": "lightning", "erupting earth": "bludgeoning", "fireball": "fire", "lightning bolt": "lightning", "spirit guardians": "radiant", "vampiric touch": "necrotic", "blight": "necrotic", "evard's black tentacles": "bludgeoning", "black tentacles": "bludgeoning", "ice storm": "bludgeoning + cold", "phantasmal killer": "psychic", "wall of fire": "fire", "cloudkill": "poison", "cone of cold": "cold", "destructive wave": "thunder + radiant", "flame strike": "fire + radiant", "insect plague": "piercing", "synaptic static": "psychic", "steel wind strike": "force", "chain lightning": "lightning", "circle of death": "necrotic", "disintegrate": "force", "harm": "necrotic", "sunbeam": "radiant", "delayed blast fireball": "fire", "finger of death": "necrotic", "fire storm": "fire", "prismatic spray": "fire/acid/lightning/poison/cold", "incendiary cloud": "fire", "sunburst": "radiant", "meteor swarm": "fire + bludgeoning", "psychic scream": "psychic", "armor of agathys": "cold", "hex": "necrotic" };
for (const k in DT) if (S[k]) S[k].dt = DT[k];
root.SpellData = S;
})(typeof window !== 'undefined' ? window : globalThis);
