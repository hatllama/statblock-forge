/* ---------------------------------------------------------
   System prompt for the AI conversion call
--------------------------------------------------------- */
const SYSTEM_PROMPT = `You convert Dungeons & Dragons 5e monster statblocks into JSON objects for a combat simulator. You will be given free text (one or more statblocks, possibly messy or copy-pasted from a PDF or D&D Beyond). Output a JSON ARRAY of monster objects, one per statblock, and nothing else — no markdown fences, no commentary, no explanation.

This schema is validated against a strict set of enums. Do not invent values outside the lists given below — anything else will fail validation.

===========================================================
HOW THE SIMULATOR ACTUALLY PICKS AN ACTION — READ THIS FIRST
===========================================================
Every round, for EACH actionSlot the creature has actions in, the simulator filters that slot's actions (in the exact order they appear in the "actions" array) down to the ones that are currently usable and whose condition is met, and then uses ONLY THE FIRST ONE IN THAT LIST. It does not pick the "best" one, it does not compare them — it is a strict top-to-bottom first-match. This has one massive consequence:

  A "default" action (condition: "default" always matches) placed ABOVE a conditional action in the SAME slot will fire every single round and the conditional action below it will NEVER fire, no matter how good it is.

So the ordering RULE for every slot that has more than one action in it: put the most specific/situational actions FIRST (recharge abilities with condition "is available", execute-style abilities with "is under half HP", group-effect abilities with "enemy count multiple", etc.), and put the generic "default" fallback action LAST. This applies to every slot, but it matters most for:
  - Slot 0 (Action) when a monster has both a recharge/limited ability and a normal at-will attack.
  - Slot 2 (Legendary Action) when a monster has multiple legendary options — the sim only resolves ONE legendary action per round total (a simplification of the real 3-per-round rule), so ordering the most valuable/situational option first matters even more here. Order from most conditional to most generic, "default" always last.
  - Slot 1 (Bonus Action) whenever there's more than one bonus-action-type feature.
Never put two actions with condition "default" in the same slot — the second one is permanently dead weight since the first will always win. If a monster genuinely has two "always available" options in the same slot, give the more important one a real condition if the statblock supports one, or just keep the single most representative option.

SCHEMA for each monster object:
{
  "type": "<one of exactly: aberration, beast, celestial, construct, dragon, elemental, fey, fiend, giant, humanoid, monstrosity, ooze, plant, undead>",
  "cr": "<challenge rating as a STRING, must be exactly one of: 0, 1/8, 1/4, 1/2, 1, 2, 3, ... 30, or — (em dash for no CR)>",
  "src": "<source book and page if known, e.g. \\"MM p.344\\"; otherwise \\"Custom\\">",
  "name": "<monster name>",
  "count": <number of this monster present — default 1 unless the text specifies a quantity>,
  "hp": <average HP as a number>,
  "AC": <armor class as a number>,
  "saveBonus": <the monster's AVERAGE save bonus across all six ability saves — NOT the highest individual save. Compute all six, then divide by 6. For each of STR, DEX, CON, INT, WIS, CHA: take the ability modifier (floor((score-10)/2) from the statblock's ability scores), and add the proficiency bonus ONLY for the saves the statblock explicitly lists as proficient in its "Saving Throws" line (e.g. "Saving Throws Dex +7, Con +9, Wis +6" means only Dex/Con/Wis get +proficiency added on top of their modifier; the other three saves use their plain ability modifier with no proficiency). Where the statblock directly states a save bonus (e.g. "Con +9"), use that exact stated number for that save instead of recomputing it. Proficiency bonus by CR (only needed if you must derive a proficient save's bonus yourself rather than using a stated one): CR 0-4 -> 2, CR 5-8 -> 3, CR 9-12 -> 4, CR 13-16 -> 5, CR 17-20 -> 6, CR 21-24 -> 7, CR 25-28 -> 8, CR 29-30 -> 9. Sum all six save bonuses and divide by 6 (decimals are fine, e.g. 4.3). If the statblock gives no ability scores at all, fall back to the plain proficiency-by-CR number above as a rough approximation.>,
  "actions": [ <action objects, see below — ORDER THEM per the rule above> ]
}

Worked example for "saveBonus": a CR 12 monster (proficiency +4) with STR 22 (+6), DEX 10 (+0), CON 22 (+6), INT 18 (+4), WIS 17 (+3), CHA 20 (+5), and a stated "Saving Throws Str +10, Con +10, Wis +7" line (meaning only Str/Con/Wis are proficient — use the stated +10/+10/+7 directly for those three since they're given): Str 10, Dex 0 (no proficiency, just modifier), Con 10, Int 4 (no proficiency), Wis 7, Cha 5 (no proficiency). Sum = 10+0+10+4+7+5 = 36. 36 / 6 = 6. So "saveBonus": 6.

ACTION SLOTS - actionSlot maps to a REAL action-economy category. Only emit an action for a slot if the statblock actually has that kind of feature. NEVER invent placeholder/empty actions to fill every slot - a monster with only one attack should have exactly ONE action, not seven.
  0 = Action (the monster's main action - multiattack routines, breath weapons, etc.)
  1 = Bonus Action
  2 = Legendary Action (each individual legendary action option gets its own entry, still slot 2 — see ordering rule above)
  3 = Lair Action
  4 = Reaction
  5 = Other 1 - PASSIVE / always-on traits that aren't something the creature spends its turn on: Magic Resistance, an aura that's just always active, Regeneration, innate resistances represented as a permanent buff, etc. Represent these as freq "at will", condition "default", targeting self (or allies if it's a party-wide aura), buff duration "entire encounter" (or the closest equivalent effect: use type "heal" with freq "at will" for Regeneration, target self).
  6 = Other 2 - a second passive slot if the monster has two such traits.
  -3 = Before the Encounter Starts — fires once automatically before round 1 (pre-cast buffs, a "the fight opens with..." effect).
  -1 = When Reduced to 0 HP — fires automatically when this creature drops (death bursts, "when it dies, it explodes...", undying-style self-heals).
  -2 = When Reducing an Enemy to 0 HP — fires automatically when this creature drops an enemy (rampage-style follow-ups, "feeds on the fallen" heals).
  These three negative trigger slots don't consume the creature's turn and aren't limited to one per round; only use them when the statblock describes that exact trigger.
  It is completely normal and expected for a simple monster to have only 1-3 actions total, all in slot 0 or 1. Do not pad.

SCHEMA for each action object:
{
  "name": "<action name - never leave this blank>",
  "actionSlot": <integer from the table above>,
  "freq": one of:
     - "at will"  (unlimited use)
     - "1/day"  (exactly one use per day — for "N/Day" with N > 1, use the {"reset":"lr",...} form below instead so the count is accurate)
     - "1/fight"  (roughly once per encounter, no explicit recharge/rest wording)
     - { "reset": "recharge", "cooldownRounds": <integer> }  - for "Recharge X-Y" abilities. This is a FIXED cooldown timer, not a random roll: after the creature uses this action, it becomes unavailable for exactly cooldownRounds rounds, then automatically becomes usable again (it fills back up by 1/cooldownRounds each round). Set cooldownRounds to the expected-value conversion of the real dice-based recharge, i.e. 6 divided by the number of faces that recharge it: Recharge 6 -> cooldownRounds 6 (6/1 face). Recharge 5-6 -> cooldownRounds 3 (6/2 faces). Recharge 4-6 -> cooldownRounds 2 (6/3 faces). Recharge 3-6 or more frequent -> cooldownRounds 2 (the schema's minimum allowed value).
     - { "reset": "sr", "uses": <integer> } or { "reset": "lr", "uses": <integer> } - for abilities explicitly worded as "X/Short Rest" or "X/Day"/"X/Long Rest" with a stated number of uses greater than 1.
  "condition": "default" normally. Otherwise MUST be exactly one of: "ally at 0 HP", "ally under half HP", "is available" (recharge/limited ability ready — use this to make sure a recharge ability is checked BEFORE the default fallback in the same slot), "is under half HP" (this creature is bloodied), "has no THP", "not used yet", "enemy count one", "enemy count multiple".
  Pick the condition that matches WHEN a sensible creature would use the ability, not just "default". These rules matter most for anything that spends an Action, Bonus Action or a limited use:
    - A buff or debuff whose duration is "entire encounter" or "repeat the save each round" (Bless, Haste, Bane, Hold Person, a battle cry, a lasting curse) → "not used yet". On "default" the sim re-casts it every turn and wastes the turn. (Free passives in slots 5/6 that are at will can stay "default".)
    - A heal on others (Cure Wounds, Healing Word, a healing touch) → "ally under half HP", or "ally at 0 HP" if it's a pick-up spell like Healing Word kept for emergencies. Never "default": the sim would heal allies who are at full HP.
    - A self-heal (Second Wind, a potion, Regeneration-like action that costs a turn) → "is under half HP". A self temp-HP ability (False Life, Armor of Agathys) → "has no THP".
    - A limited-use area attack (breath weapon, Fireball, any useSaves attack with targets > 1 that isn't at will) → "enemy count multiple", unless it's a recharge ability you want fired the moment it's ready ("is available").
    - A big single-target finisher or desperate move → "is under half HP" or "enemy count one" where the statblock implies it.
  "targets": see the MULTIATTACK section below - this is critical and easy to get wrong,
  "type": "atk" | "heal" | "buff" | "debuff",
  "target": for "atk" or "debuff" MUST be exactly one of: "enemy with least HP", "enemy with most HP", "enemy with highest DPR", "enemy with lowest AC", "enemy with highest AC" (almost always "enemy with most HP" for a monster attacking the party). For "heal" or "buff" MUST be exactly one of: "ally with the least HP", "ally with the most HP", "ally with the highest DPR", "ally with the lowest AC", "ally with the highest AC", "self".

  IMPORTANT distinction between "buff" and "debuff": "buff" ALWAYS targets an ally (self or a teammate) — it can never target an enemy. If an ability imposes a condition directly on an ENEMY without being an attack roll (e.g. "each creature within 10ft must succeed on a save or be frightened"), that is a "debuff" action, not a "buff" action. Use "debuff" whenever the effect targets an enemy and there is no dpr/damage roll involved, only a save-or-suffer condition.

  // for type "atk":
  "dpr": <PER-HIT damage — see MULTIATTACK section below, this is the damage of ONE hit, not the whole routine combined>,
  "toHit": "<if this is an attack ROLL, the attack bonus. If this is a SAVING THROW effect (breath weapon, spell save, etc.), put the save DC here instead and set useSaves true>",
  "useSaves": <true if targets make a saving throw instead of being attacked, false/omit otherwise>,
  "halfOnSave": <true if the statblock says "half as much damage on a successful save", false/omit otherwise>,
  "riderEffect": <optional, only when the attack also imposes a secondary lingering effect. { "dc": <the rider's own independent save DC, if the source text describes a genuinely separate roll — OR 99 if the rider is really just part of the SAME effect as the main hit/save (e.g. "the target takes damage AND has its speed reduced to 0" from one single failed save) and should trigger at the same probability as the main effect rather than as a separate roll>, "buff": <a BUFF OBJECT — see BUFF OBJECT FIELDS below> }>,

  // for type "heal":
  "amount": "<HP restored, dice string or number>",
  "tempHP": <true if this grants temporary HP instead of true healing>,

  // for type "buff" (a standalone buff action targeting self/an ally):
  "buff": <a BUFF OBJECT — see BUFF OBJECT FIELDS below>

  // for type "debuff" (a standalone effect targeting an ENEMY directly via a saving throw, with no attack roll and no damage — e.g. a frighten aura, a restraining field):
  "saveDC": <the save DC as a number, required>,
  "buff": <a BUFF OBJECT — see BUFF OBJECT FIELDS below>
}

===========================================================
BUFF OBJECT FIELDS — used by riderEffect.buff, buff-type actions, and debuff-type actions
===========================================================
A buff object always has "duration" plus one or more effect fields. Duration MUST be exactly one of these 5 values, and the two attack-scoped ones are commonly misused, so read carefully:
  - "entire encounter" — lasts the whole fight (permanent auras/passives, most stances).
  - "1 round" — expires at the start of the creature's next turn.
  - "repeat the save each round" — a recurring effect the target keeps re-saving against each round (ongoing poison/burning, etc).
  - "until next attack made" — removed the instant the creature carrying it makes its very next attack. On a self/ally buff: boosts only that creature's own next attack (smite-style "extra damage on my next hit", "advantage on my next attack"). On a debuff: hampers only the enemy's next attack (e.g. "the target has disadvantage on its next attack roll").
  - "until next attack taken" — a buff placed on a creature that is consumed and removed the instant that creature is next attacked. Use this for one-shot DEFENSIVE REACTIONS that only protect against a single incoming attack (a Shield-spell-style "+5 AC until the next hit against me is resolved", a "the next attack against me has disadvantage" reaction). This is what a reaction (actionSlot 4) usually wants, since a reaction is triggered by and consumed on a single attack.

Effect fields (include one or more per buff, whichever the ability actually does):
  - "ac": <flat AC modifier, e.g. "5" for +5 AC, or a negative number/dice string for a penalty>
  - "toHit": <flat attack-roll modifier, positive or negative>
  - "damage": <flat bonus damage ADDED to the buffed creature's own attacks, e.g. "1d6" or "2d8" — this is additive, not a multiplier>
  - "damageReduction": <flat number SUBTRACTED from damage the buffed creature takes on each hit, e.g. 3 means every hit against them does 3 less damage (floored at 0). Use this for flat damage-reduction traits, not percentage resistances.>
  - "damageMultiplier": <a MULTIPLIER on the buffed creature's own OUTGOING damage. 1 = no change (this is the default/baseline if omitted). 1.5 = the creature deals 50% MORE damage. 0.5 = the creature deals 50% LESS damage. Use this for effects like a rage bonus expressed as a percentage, or an aura that weakens an enemy's damage output.>
  - "damageTakenMultiplier": <a MULTIPLIER on damage the buffed creature RECEIVES. 1 = no change (default/baseline if omitted). 0.5 = the creature takes HALF damage (e.g. resistance to a damage type — approximate "resistant to nonmagical bludgeoning/piercing/slashing" this way as a permanent slot-5 passive with duration "entire encounter"). 2 = the creature takes DOUBLE damage (vulnerability). Do not confuse this with damageReduction: this is a percentage/ratio, damageReduction is a flat subtraction.>
  - "condition": <MUST be exactly one of: Blinded, Frightened, Incapacitated, Invisible, Paralyzed, Petrified, Poisoned, Restrained, Stunned, Unconscious, Exhausted, Attacks with Advantage, Attacks with Disadvantage, Is attacked with Advantage, Is attacked with Disadvantage, Attacks and is attacked with Advantage, Attacks and saves with Disadvantage, Saves with Advantage, Save with Disadvantage>

===========================================================
MULTIATTACK: "targets" IS A HIT COUNT, NOT A TARGET COUNT
===========================================================
For an "atk" action WITHOUT useSaves (a normal attack roll), the simulator interprets "targets" as the number of separate attack rolls this action makes, and it keeps aiming ALL of them at the same enemy (whichever one the "target" selector picks) until that enemy dies, only then spilling remaining hits onto the next enemy. This is exactly how a real multiattack works, so:
  - "Multiattack: the creature makes 3 longsword attacks" -> ONE action, "targets": 3, "dpr": the damage of a SINGLE longsword hit (e.g. "1d8 + 4"). Do NOT combine the 3 hits into one action with targets:1 and tripled damage.
  - If a multiattack mixes different weapons/damage dice (e.g. "2 claw attacks (1d6+4 each) and 1 bite attack (2d6+4)"), compute the attack-weighted AVERAGE per-hit damage as a single flat number and use that as "dpr", with "targets" equal to the TOTAL number of attacks (3 in this example): average = (2 * avg(1d6+4) + 1 * avg(2d6+4)) / 3 = (2*7.5 + 1*11)/3 = 8.67, so dpr: 8.67, targets: 3. This is the one case where "dpr" should be a plain number instead of a dice string.
  - A single, non-repeating attack (no multiattack) is just targets: 1.
For an "atk" action WITH useSaves true (an area save-or-suffer effect like a breath weapon), "targets" instead means the number of DIFFERENT enemies it can simultaneously hit — typically the size of the party it's likely to catch (commonly 3-4), since every affected creature rolls its own independent save.
For "debuff" actions (always save-based, never an attack roll), "targets" likewise means the number of different enemies the effect can simultaneously catch.

===========================================================
DEFAULT FREQUENCY: NO EXPLICIT LIMIT = "at will"
===========================================================
If a statblock lists an ability under Actions/Bonus Actions/Reactions with NO explicit frequency note (no "Recharge X-Y", no "X/Day", no "X/Short Rest", no stated limited-use language), its freq is "at will" — full stop. Do not assume something is limited just because a "Multiattack" line frames it as an alternative to the main attack routine (e.g. "the creature makes two Claw attacks, or uses Frost Breath and makes one Claw attack" — if Frost Breath has no recharge/daily note of its own elsewhere in the block, it is just as "at will" as the claws). When a Multiattack line presents a choice like this between two "at will" options, make BOTH into actions in slot 0, both freq "at will", with the more specific/tactical option placed ABOVE the plain fallback multiattack per the ordering rule (pick whatever condition from the fixed list best distinguishes when the tactical option is better — "enemy count multiple" is a reasonable default guess for anything area-effect or control-oriented).

===========================================================
PASSIVE / AMBIENT AREA DAMAGE (auras, hazardous zones)
===========================================================
Some statblocks include an aura or zone that automatically damages creatures based on a condition unrelated to being attacked (e.g. "any creature that ends its turn within 10 ft of the blight without having moved at least 15 ft during that turn takes 7 (2d6) force damage"). NEVER drop this — it is often one of the creature's biggest damage sources. The simulator has no positioning/movement model, so the exact trigger condition can't be checked, but approximate it as a recurring passive attack:
  - type: "atk", useSaves: true (even if the source text doesn't call it a saving throw — treat it as one for modeling purposes)
  - toHit: the DC. If the aura itself doesn't state one, reuse the DC the creature's other save-based abilities use (most homebrew statblocks keep one consistent DC across all their save effects).
  - dpr: the aura's stated damage.
  - targets: your best estimate of how many enemies are simultaneously caught by the aura's radius each round — a tight ~10ft aura usually only catches 1-2 creatures who end up adjacent to the boss; a room-filling 15-20ft+ aura can catch most/all of a 3-4 person party.
  - freq: "at will", condition: "default".
  - actionSlot: 5 or 6 (Other) — this is passive/ambient, not something the creature spends its actual turn on.
  - halfOnSave: usually false (the trigger is binary: you avoided it, or you didn't), unless the source text explicitly describes partial mitigation.

===========================================================
RESOURCE / CHARGE ECONOMIES (build-up-and-spend mechanics)
===========================================================
Some statblocks give a creature a charge/resource pool that fills from triggers (very often the aura above) and can be spent on a menu of tactical options. The schema has NO way to track an accumulating resource pool tied to battle events — you cannot reproduce the exact economy. But per-effect, still try to give it SOME balance representation rather than silently dropping it:
  - If a charge-spent option has a real, modelable combat effect (bonus damage, an extra use of an existing action, a status condition from the fixed CreatureCondition list) — fold it in as its own action in the appropriate slot (often a Bonus Action duplicate of an existing ability, or an Other slot if it doesn't fit a normal economy category), gated by an ESTIMATED freq that approximates how often the resource would realistically be banked and spent in a multi-round fight. A recharge-style {"reset":"recharge","cooldownRounds":N} with N in the 2-4 range is usually a reasonable stand-in for "this needs a couple of rounds of the aura ticking before it's affordable again." Name the action after the source ability so it's traceable.
  - If a charge-spent option ONLY affects something the simulator has literally no field for (extending reach/range, forced repositioning or moving a creature with no attached damage or status, terrain shaping, making a target drop held items) — it genuinely cannot be given a meaningful numeric effect without fabricating mechanics that aren't in the statblock. It is better and more honest to OMIT these than to force a fake approximation. Do not invent a toHit/damage/condition bonus for something that is purely positional.
  - The resource-tracking text itself (e.g. "Kinetic Reserves", "Stasis Reserves") never becomes its own action — it's just the accounting rule; the actual damage that earns the resource is already captured by the aura action above.

===========================================================
DAMAGE RESISTANCE / VULNERABILITY (and why blanket 0.5 can overstate it)
===========================================================
A "Damage Resistances X, Y" or "Damage Vulnerabilities X, Y" line should become a passive self-buff (Other slot, freq "at will", condition "default", duration "entire encounter") using damageTakenMultiplier. But the simulator applies damageTakenMultiplier to ALL incoming damage regardless of type, because it doesn't track damage types — so a flat 0.5 is only honest when the resistance covers damage types that will plausibly make up MOST of a typical party's damage (e.g. "resistant to nonmagical bludgeoning, piercing, and slashing" against a mostly-martial party). If the resistance only covers one or two uncommon/narrow damage types (a specific energy type like Force, Radiant, Necrotic, etc.), a full 0.5 overstates its real impact since most attacks won't be that type — use a smaller adjustment instead, like 0.85-0.9, to reflect that only a fraction of incoming damage is likely to be resisted. Use your judgment on how common the listed damage types are for a typical party. Vulnerability works the same way in reverse with a multiplier > 1.

===========================================================
NON-STANDARD DICE
===========================================================
If a statblock uses a non-standard die size (d3, d7, d9, d11 — anything that isn't d4/d6/d8/d10/d12/d20/d100), do NOT write it as a dice string (e.g. "1d7 + 1") — the simulator's dice parser may not support it and it will fail validation. Instead compute the average value yourself and use a plain flat number (e.g. "1d7 + 1" averages (1+7)/2 + 1 = 5, so use dpr: 5).

===========================================================
EXTENDED MECHANICS ("ext") — grapples, swallowing, size, ambush, blindsight
===========================================================
This tool's simulator supports a few mechanics beyond the base schema, written as optional "ext" objects. Plain exports drop or ignore them, so they never cause a validation failure — use them whenever the statblock has these features instead of approximating:

Creature level (on the monster object):
  "ext": { "size": "Tiny"|"Small"|"Medium"|"Large"|"Huge"|"Gargantuan",  (always include size from the statblock's first line)
           "blindsight": true,  (only if the creature has blindsight)
           "elvenAccuracy": true,  (only if it has the Elven Accuracy feat: its advantage rolls use three d20s)
           "speed": <walking speed in feet; if it burrows/flies/swims faster, use the fastest speed it would use in a fight>,
           "initBonus": <its initiative bonus — the Dex modifier, or the "Initiative" value if the statblock lists one>,
           "bonusDisengage": true,  (only if it can Disengage as a bonus action, e.g. Nimble Escape or Cunning Action)
           "ai": <how it fights: "beast" if INT is 1-3 or it is an animal/mindless creature (attacks the nearest foe, locks onto its prey, turns on whoever hurt it, almost never attacks downed PCs); "tactical" if INT is 10+ and it is a thinking combatant (focuses threats and healers, finishes off the weak, keeps its distance if ranged, and may kill a downed PC who keeps getting back up); otherwise "regular"> }
  And on EVERY action add "ext": { "range": <feet> } giving how far it reaches: melee reach (5, or 10 for "reach 10 ft."), the normal range for ranged attacks ("range 80/320 ft." → 80), the spell's range, the cone/line length for breath weapons and cones, or the aura radius for passive auras. Use 0 for self-only actions. Merge it with any other "ext" keys on that action.
  For an area effect (a save-based attack or debuff that hits everyone in a shape) also add "ext": { "area": { "shape": "sphere" | "cone" | "line" | "cube", "size": <feet> } } — sphere size is the radius (Fireball 20), cone/line size is the length (a 15-ft cone → 15, a 60-ft line → 60), cube size is the side (Thunderwave 15). For a cone, line or cube that starts at the creature, "range" is the same as the size. Keep "targets" as the usual estimate of how many creatures it catches.
  SAVING THROWS: give every creature "ext": { "saves": { "str": n, "dex": n, "con": n, "int": n, "wis": n, "cha": n } } with its real total bonus for each save: the "Saving Throws" line where the statblock lists one (2014 style), the "Save" column of the ability table (2024 style), otherwise the ability modifier. Keep "saveBonus" equal to the average of those six. On every save-forcing action add "ext": { "saveAbility": "dex" } (str/dex/con/int/wis/cha, from the text: "DC 15 Dexterity saving throw" gives "dex"); if a riderEffect uses a different save from the main one, also add "riderSave". A grapple that allows "a Strength or Dexterity saving throw" needs nothing extra.
  FLYING: "Speed 30 ft., fly 60 ft." gives "ext": { "speed": 30, "fly": 60 }.
  SPELLCASTERS: if a creature has a "Spellcasting" trait with spell slots (e.g. "1st level (4 slots): magic missile, shield"), do NOT turn its spells into separate actions. Put them in "ext": { "spellbook": { "slots": [<1st-level slots>, <2nd>, … up to 9 entries, 0 where none], "slotReset": "lr" (or "sr" for warlock Pact Magic), "spells": [ ... ] } } on the creature. Each spell is an ordinary action object (id, name, actionSlot 0/1/4 for action/bonus action/reaction, type, targets, target, dpr/toHit/useSaves/halfOnSave, buff, saveDC, amount, riderEffect, ext.range, ext.area…) WITHOUT "freq" or "condition", plus "level" (0 for cantrips), "concentration": true when the spell needs it, and "upcast": "<dice added per slot level above>" when it scales (Magic Missile "1d4 + 1", Cure Wounds "2d8", Burning Hands "1d6"). Cantrip damage uses the creature's level/CR scaling. Only include spells with a combat effect the schema can express (damage, healing, buffs, conditions); skip utility spells. Spells that only affect some creature types get "ext": { "targetTypes": ["humanoid"] } (Hold Person). Shield can be { "type": "template", "templateOptions": { "templateName": "Shield" }, "level": 1, "actionSlot": 4 }. Innate spellcasting ("3/day each: …") is NOT slots: keep those as normal limited-use actions. Weapon attacks and other non-spell abilities stay in "actions" as usual.

Action level (on an action object), any combination of:
  "ext": {
    "grapple": { "escapeDC": <number>, "maxSize": "<largest size it can grapple, e.g. Medium>", "restrains": <true if the statblock says the grappled target is also restrained, else false>, "dc": <ONLY if the target gets a saving throw to avoid the grapple; omit when the grapple is automatic on a hit> },
    "swallow": { "maxSize": "<largest size it can swallow>", "digest": "<damage dice the swallowed creature takes at the start of each of the swallower's turns, e.g. 2d6>", "capacity": <how many creatures it can hold at once, default 1>,
                 "regurgitate": { "threshold": <damage in a single turn from inside that forces the save>, "dc": <that save's DC>, "saveBonus": <the swallower's bonus for THAT save, computed from the relevant ability score + proficiency if proficient> } },
    "onlyIfEnemiesSurprised": true,  (the action only happens in round 1 when the creature's enemies are surprised — e.g. ambush traits)
    "successChance": <0-1, only for actions that need a check to work at all, e.g. Hide's Stealth check: chance = (21 + check bonus − DC) / 20, clamped to 0-1>
  }

How to model the common patterns:
  - "Bite... the target is grappled (escape DC X)" → put "ext.grapple" on that attack. Don't add a separate "Restrained" riderEffect for it; the grapple itself applies restrained when "restrains" is true.
  - "Swallow. The creature makes one bite attack against a [size] target it is grappling. If the attack hits, the target is also swallowed..." → a SEPARATE "atk" action with the bite's to-hit and damage plus "ext.swallow", in the SAME slot as the grappling attack and placed ABOVE it, both condition "default", freq "at will". The simulator only uses the swallow action in the share of turns where the creature actually has a valid grappled target, and falls through to the grappling attack otherwise — so do NOT invent a condition for it.
  - If a Multiattack includes a grappling attack plus other attacks, keep the grapple on its own action entry as above.
  - "On the first round of combat, the creature has advantage on attack rolls against any creature it surprised" → actionSlot -3 (Before the Encounter Starts), type "buff", target "self", buff { "duration": "1 round", "condition": "Attacks with Advantage" }, plus "ext": { "onlyIfEnemiesSurprised": true }.
  - Purely positional/sensory traits with no combat number (tremorsense, "moves toward vibration", burrowing) have no effect in the sim — omit them.
  - "Cunning Action" / Nimble Escape (Hide as a Bonus Action): model Hide as actionSlot 1, type "buff", target "self", buff { "duration": "1 round", "condition": "Invisible" }, with "ext": { "successChance": <Stealth check vs DC 15> }. Invisible gives advantage on its attacks and disadvantage on attacks against it. Dash and Disengage are movement-only and have no effect in the sim — omit them.

Example (a swallowing frog-like creature, not a real statblock):
{"type":"beast","cr":"2","src":"Custom","name":"Mire Gulper","count":1,"hp":39,"AC":11,"saveBonus":0.5,"ext":{"size":"Large"},"actions":[
  {"name":"Lurking Ambush","actionSlot":-3,"freq":"at will","condition":"default","targets":1,"type":"buff","target":"self","buff":{"duration":"1 round","condition":"Attacks with Advantage"},"ext":{"onlyIfEnemiesSurprised":true}},
  {"name":"Swallow","actionSlot":0,"freq":"at will","condition":"default","targets":1,"type":"atk","dpr":"2d6 + 2","toHit":4,"target":"enemy with most HP","ext":{"swallow":{"maxSize":"Medium","digest":"3d6","capacity":1,"regurgitate":{"threshold":12,"dc":12,"saveBonus":1}}}},
  {"name":"Bite","actionSlot":0,"freq":"at will","condition":"default","targets":1,"type":"atk","dpr":"2d6 + 2","toHit":4,"target":"enemy with most HP","ext":{"grapple":{"escapeDC":12,"maxSize":"Medium","restrains":true}}}
]}

Reference examples (already-converted real monsters — study the ordering, the hit-count multiattack, the recharge math, the legendary-action priority, the passive-trait slot, and (in the last two entries) the attack-scoped durations plus damage-modifier fields):

[{"type":"humanoid","cr":"2","src":"MM p.344","name":"Bandit Captain","count":1,"hp":65,"AC":15,"saveBonus":1,"actions":[{"name":"Scimitar","actionSlot":0,"freq":"at will","condition":"default","targets":1,"type":"atk","dpr":"1d6 + 3","toHit":5,"target":"enemy with most HP"}]},
{"type":"humanoid","cr":"1/8","src":"MM p.343","name":"Bandit","count":6,"hp":22,"AC":14,"saveBonus":0.0625,"actions":[{"name":"Scimitar","actionSlot":0,"freq":"at will","condition":"default","targets":1,"type":"atk","dpr":"1d6 + 2","toHit":"4","target":"enemy with most HP"}]},
{"type":"fiend","cr":"12","src":"Custom","name":"Ashclaw Dominator","count":1,"hp":230,"AC":18,"saveBonus":8,"actions":[
  {"name":"Infernal Breath","actionSlot":0,"freq":{"reset":"recharge","cooldownRounds":3},"condition":"is available","targets":4,"type":"atk","dpr":"8d6","toHit":16,"useSaves":true,"halfOnSave":true,"target":"enemy with most HP"},
  {"name":"Claw Flurry","actionSlot":0,"freq":"at will","condition":"default","targets":3,"type":"atk","dpr":"1d8 + 6","toHit":11,"target":"enemy with most HP"},
  {"name":"Rally Cry","actionSlot":2,"freq":"1/fight","condition":"enemy count multiple","targets":1,"type":"atk","dpr":"2d10 + 6","toHit":11,"target":"enemy with most HP"},
  {"name":"Tail Lash","actionSlot":2,"freq":"at will","condition":"default","targets":1,"type":"atk","dpr":"1d10 + 6","toHit":11,"target":"enemy with most HP"},
  {"name":"Magic Resistance","actionSlot":5,"freq":"at will","condition":"default","targets":1,"type":"buff","target":"self","buff":{"duration":"entire encounter","condition":"Saves with Advantage"}},
  {"name":"Resistant Hide","actionSlot":6,"freq":"at will","condition":"default","targets":1,"type":"buff","target":"self","buff":{"duration":"entire encounter","damageTakenMultiplier":0.5}}
]},
{"type":"celestial","cr":"7","src":"Custom","name":"Aegis Warden","count":1,"hp":110,"AC":17,"saveBonus":5,"actions":[
  {"name":"Radiant Mace","actionSlot":0,"freq":"at will","condition":"default","targets":1,"type":"atk","dpr":"2d6 + 4","toHit":8,"target":"enemy with most HP"},
  {"name":"Smite Charge","actionSlot":1,"freq":{"reset":"lr","uses":3},"condition":"default","targets":1,"type":"buff","target":"self","buff":{"duration":"until next attack made","damage":"3d8"}},
  {"name":"Deflect","actionSlot":4,"freq":{"reset":"lr","uses":3},"condition":"default","targets":1,"type":"buff","target":"self","buff":{"duration":"until next attack taken","ac":"4","damageReduction":5}}
]}]
Note how "Infernal Breath" (condition "is available") sits ABOVE "Claw Flurry" (condition "default") in slot 0 — this ensures the breath weapon is used the instant it's ready, and the sim only falls back to Claw Flurry on rounds when the breath is on cooldown. Same pattern with "Rally Cry" above "Tail Lash" in slot 2. "Magic Resistance" and "Resistant Hide" are passive traits living in slots 5/6 — note "damageTakenMultiplier":0.5 gives 50% damage resistance permanently. "Claw Flurry" is a 3-hit multiattack (targets: 3) with per-hit damage, not summed. In the Aegis Warden example, "Smite Charge" is a bonus action that only boosts the WARDEN'S own next attack (duration "until next attack made", self-targeted, adds flat bonus damage) — it's consumed the instant that next attack lands. "Deflect" is a reaction (slot 4) that only protects against the very next incoming attack (duration "until next attack taken", boosts AC and applies flat damageReduction), then disappears.

Now convert the statblock(s) the user gives you. Multiple statblocks in one message may be separated by blank lines or dashes - return one array entry per creature. Include ONLY actions the statblock actually describes, and order every slot's actions from most-conditional to most-generic. Output ONLY the JSON array.`;

/* ---------------------------------------------------------
   Validation — mirrors the enums of the day save-file format's
   src/model/enums.ts, so problems surface here instead of
   as a bare "Invalid schema" on the actual site.
--------------------------------------------------------- */
const VALID_CREATURE_TYPES = ['aberration','beast','celestial','construct','dragon','elemental','fey','fiend','giant','humanoid','monstrosity','ooze','plant','undead'];
const VALID_CR = ['0','1/8','1/4','1/2','1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30','—'];
const VALID_ENEMY_TARGETS = ['enemy with least HP','enemy with most HP','enemy with highest DPR','enemy with lowest AC','enemy with highest AC'];
const VALID_ALLY_TARGETS = ['ally with the least HP','ally with the most HP','ally with the highest DPR','ally with the lowest AC','ally with the highest AC','self'];
const VALID_CONDITIONS = ['default','ally at 0 HP','ally under half HP','is available','is under half HP','has no THP','not used yet','enemy count one','enemy count multiple'];
const VALID_CREATURE_CONDITIONS = ['Blinded','Frightened','Incapacitated','Invisible','Paralyzed','Petrified','Poisoned','Restrained','Stunned','Unconscious','Exhausted','Attacks with Advantage','Attacks with Disadvantage','Is attacked with Advantage','Is attacked with Disadvantage','Attacks and is attacked with Advantage','Attacks and saves with Disadvantage','Saves with Advantage','Save with Disadvantage'];
const VALID_BUFF_DURATIONS = ['until next attack made','until next attack taken','1 round','repeat the save each round','entire encounter'];
const VALID_FREQ_STRINGS = ['at will','1/fight','1/day'];

function isDiceFormula(v){
  if(typeof v === 'number') return !isNaN(v);
  if(typeof v !== 'string') return false;
  if(v.trim() === '') return false;
  if(!isNaN(+v)) return true;
  // permissive dice-notation check: numbers, d, +, -, *, /, spaces, parens
  // labelled dice like 1d6[HEX] are valid in the save format's dice
  return /^[\d\sd+\-*/().]+$/i.test(v.replace(/\[[^\]]*\]/g,'').trim());
}

function validateFreq(f){
  if(typeof f === 'string') return VALID_FREQ_STRINGS.includes(f);
  if(f && typeof f === 'object'){
    if(f.reset === 'sr' || f.reset === 'lr') return typeof f.uses === 'number' && f.uses >= 1;
    if(f.reset === 'recharge') return typeof f.cooldownRounds === 'number' && f.cooldownRounds >= 2;
  }
  return false;
}

function validateBuffObject(buff, issues, prefix, ax){
  if(!buff){ issues.push(`${prefix} is missing`); return; }
  if(!VALID_BUFF_DURATIONS.includes(buff.duration)) issues.push(`${prefix}.duration is not a recognized value`);
  if(buff.condition && !VALID_CREATURE_CONDITIONS.includes(buff.condition)) issues.push(`${prefix}.condition "${buff.condition}" is not recognized`);
  ['ac','toHit','damage','damageReduction','save'].forEach(f=>{
    if(buff[f] !== undefined && !isDiceFormula(buff[f])) issues.push(`${prefix}.${f} "${buff[f]}" doesn't look like a valid number or dice formula`);
  });
  ['damageMultiplier','damageTakenMultiplier'].forEach(f=>{
    if(buff[f] !== undefined){
      if(typeof buff[f] !== 'number') issues.push(`${prefix}.${f} must be a plain number (1 = no change, 0.5 = half, 2 = double) — not a dice string`);
      else if(buff[f] < 0) issues.push(`${prefix}.${f} is negative — multipliers should be >= 0 (1 = baseline)`);
    }
  });
  const hasEffect = ['ac','toHit','damage','damageReduction','damageMultiplier','damageTakenMultiplier','condition','save'].some(f=>buff[f] !== undefined);
  if(!hasEffect && !(ax && (ax.teleport || ax.grantFly || ax.speedBonus || ax.mirror || ax.concBonus || ax.stepAway))) issues.push(`${prefix} has a duration but no actual effect field (ac/toHit/damage/damageReduction/damageMultiplier/damageTakenMultiplier/condition) — it won't do anything`);
}

function validateAction(a, issues, prefix){
  if(!a.name || !String(a.name).trim()) issues.push(`${prefix}: missing/blank name`);
  if(typeof a.actionSlot !== 'number') issues.push(`${prefix}: actionSlot must be a number`);
  if(!validateFreq(a.freq)) issues.push(`${prefix}: invalid "freq" value`);
  if(!VALID_CONDITIONS.includes(a.condition)) issues.push(`${prefix}: condition "${a.condition}" is not a recognized value`);
  if(typeof a.targets !== 'number') issues.push(`${prefix}: targets must be a number`);

  if(a.type === 'atk'){
    if(!isDiceFormula(a.dpr)) issues.push(`${prefix}: dpr "${a.dpr}" doesn't look like a valid number or dice formula`);
    if(!isDiceFormula(a.toHit)) issues.push(`${prefix}: toHit "${a.toHit}" doesn't look like a valid number or dice formula`);
    if(!VALID_ENEMY_TARGETS.includes(a.target)) issues.push(`${prefix}: target "${a.target}" is not a recognized enemy-target value`);
    if(!a.useSaves && a.targets === 1 && /\bx\s*\d|multiattack|\btwice\b|\bthree times\b/i.test(a.name||'')){
      issues.push(`${prefix}: name suggests a multiattack, but "targets" is 1 — for a non-save attack, "targets" should equal the number of hits (e.g. 3 for a 3-attack multiattack), with "dpr" as the damage of a single hit.`);
    }
    if(a.riderEffect){
      if(typeof a.riderEffect.dc !== 'number') issues.push(`${prefix}: riderEffect.dc must be a number`);
      validateBuffObject(a.riderEffect.buff, issues, `${prefix}: riderEffect.buff`);
    }
  } else if(a.type === 'heal'){
    if(!isDiceFormula(a.amount)) issues.push(`${prefix}: amount "${a.amount}" doesn't look like a valid number or dice formula`);
    if(!VALID_ALLY_TARGETS.includes(a.target)) issues.push(`${prefix}: target "${a.target}" is not a recognized ally-target value`);
  } else if(a.type === 'buff'){
    if(!VALID_ALLY_TARGETS.includes(a.target)) issues.push(`${prefix}: target "${a.target}" is not a recognized ally-target value (buffs can only target allies/self — enemy targets need type "debuff" instead)`);
    validateBuffObject(a.buff, issues, `${prefix}: buff`, a.ext);
  } else if(a.type === 'debuff'){
    if(!VALID_ENEMY_TARGETS.includes(a.target)) issues.push(`${prefix}: target "${a.target}" is not a recognized enemy-target value`);
    if(typeof a.saveDC !== 'number') issues.push(`${prefix}: saveDC must be a number`);
    validateBuffObject(a.buff, issues, `${prefix}: buff`, a.ext);
  } else {
    issues.push(`${prefix}: unrecognized action type "${a.type}"`);
  }
}

function validateOrdering(m, issues){
  // Mirrors simulation.ts: for each actionSlot, the sim filters that slot's
  // actions in array order and uses ONLY the first usable+matching one.
  // A "default" action sitting above other actions in the same slot will
  // always win and starve everything below it.
  const bySlot = {};
  (m.actions||[]).forEach((a,idx)=>{
    if(typeof a.actionSlot !== 'number' || (a.ext && a.ext.wtOnly)) return;
    (bySlot[a.actionSlot] = bySlot[a.actionSlot] || []).push({idx, a});
  });
  Object.entries(bySlot).forEach(([slot, list])=>{
    if(list.length < 2) return;
    // Only an AT-WILL "default" action blocks what's below it forever; a limited-use one
    // stops matching once spent, so the actions under it still get their turn afterwards.
    // gated forge actions (swallow, ambush-only) don't always apply, so they never block what's below
    const isGated = a => !!(a.ext && (a.ext.swallow || a.ext.onlyIfEnemiesSurprised));
    const blocking = list.filter(e=>e.a.condition === 'default' && e.a.freq === 'at will' && !isGated(e.a));
    if(blocking.length > 1){
      issues.push(`Slot ${slot} has ${blocking.length} at-will actions with condition "default" (${blocking.map(e=>e.a.name).join(', ')}) — only the first will ever fire, the rest are permanently dead.`);
    }
    list.forEach((entry, i)=>{
      if(entry.a.condition === 'default' && entry.a.freq === 'at will' && !isGated(entry.a) && i < list.length - 1){
        const shadowed = list.slice(i+1).map(e=>e.a.name).join(', ');
        issues.push(`"${entry.a.name}" (slot ${slot}) has condition "default" but sits above ${list.length - 1 - i} other action(s) in that slot (${shadowed}) — it's at will, so it fires every round and those actions will never trigger. Move it to the bottom of the slot (↓).`);
      }
    });
  });
}

function validateExt(m, issues){
  const acts = m.actions || [];
  const SZ = ['Tiny','Small','Medium','Large','Huge','Gargantuan'];
  if(m.ext && m.ext.size && !SZ.includes(m.ext.size)) issues.push(`Size "${m.ext.size}" isn't one of ${SZ.join(', ')}`);
  acts.forEach(a=>{
    const ex = a.ext; if(!ex) return;
    const nm = a.name || 'unnamed';
    if(ex.saveAbility && !['str','dex','con','int','wis','cha'].includes(ex.saveAbility)) issues.push(`"${nm}": saving throw must be str, dex, con, int, wis or cha`);
    if(ex.area && !['sphere','cone','line','cube','emanation'].includes(ex.area.shape)) issues.push(`"${nm}": area shape must be sphere, cone, line, cube or emanation`);
    if(ex.area && !(a.useSaves || a.type === 'debuff')) issues.push(`"${nm}": an area only applies to save-based attacks and debuffs`);
    if(ex.successChance !== undefined && !(typeof ex.successChance === 'number' && ex.successChance >= 0 && ex.successChance <= 1)) issues.push(`"${nm}": success chance must be between 0 and 1`);
    if(ex.grapple){
      if(typeof ex.grapple.escapeDC !== 'number') issues.push(`"${nm}": grapple needs a numeric escape DC`);
      if(ex.grapple.maxSize && !SZ.includes(ex.grapple.maxSize)) issues.push(`"${nm}": grapple max size isn't a valid size`);
    }
    if(ex.swallow){
      if(a.type !== 'atk') issues.push(`"${nm}": swallow only works on an attack`);
      if(!acts.some(b=>b.ext && b.ext.grapple)) issues.push(`"${nm}": swallows a grappled creature, but none of this creature's attacks grapple — it will never fire`);
      if(ex.swallow.digest !== undefined && !isDiceFormula(ex.swallow.digest)) issues.push(`"${nm}": damage inside "${ex.swallow.digest}" isn't a valid dice formula`);
      const r = ex.swallow.regurgitate;
      if(r && r.threshold !== undefined && typeof r.dc !== 'number') issues.push(`"${nm}": regurgitation has a damage threshold but no save DC`);
      const sameSlot = acts.filter(b=>b.actionSlot === a.actionSlot);
      if(sameSlot.indexOf(a) === sameSlot.length - 1 && sameSlot.length > 1) issues.push(`"${nm}": swallow is the last action in its slot — put it ABOVE the grappling attack, so the creature swallows when it has someone grappled and attacks otherwise`);
    }
  });
}

function validateMonster(m){
  const issues = [];
  if((m.actions||[]).some(a=>a.ext && a.ext.fromSpellbook)) m = Object.assign({}, m, { actions: m.actions.filter(a=>!(a.ext && a.ext.fromSpellbook)) });
  if(!m.name || !String(m.name).trim()) issues.push('Monster name is blank');
  if(m.type && !VALID_CREATURE_TYPES.includes(m.type)) issues.push(`Creature type "${m.type}" is not recognized`);
  if(m.cr && !VALID_CR.includes(String(m.cr))) issues.push(`CR "${m.cr}" is not a recognized value`);
  if(typeof m.hp !== 'number') issues.push('HP must be a number');
  if(typeof m.AC !== 'number') issues.push('AC must be a number');
  if(typeof m.saveBonus !== 'number') issues.push('Save Bonus must be a number');
  if(typeof m.count !== 'number') issues.push('Count must be a number');
  (m.actions||[]).forEach((a,i)=>{ if(a.type !== 'template') validateAction(a, issues, `Action ${i+1} (${a.name||'unnamed'})`); });
  validateOrdering(m, issues);
  validateExt(m, issues);
  validateSpellbook(m, issues);
  return issues;
}

function sanitizeMonster(m){
  // Drop obviously-junk placeholder actions (blank name with zero dpr/toHit) —
  // these come from over-eager slot padding and should never have been generated.
  m.actions = (m.actions||[]).filter(a=>{
    const blankName = !a.name || !String(a.name).trim();
    const zeroAtk = a.type==='atk' && (a.dpr===0 || a.dpr==='0') && (a.toHit===0 || a.toHit==='0');
    return !(blankName && zeroAtk);
  });
  return m;
}

/* ---------------------------------------------------------
   Visual action editor
--------------------------------------------------------- */
const SLOT_DEFS = [
  {v:0,  label:'Action'},
  {v:1,  label:'Bonus Action'},
  {v:4,  label:'Reaction'},
  {v:2,  label:'Legendary Action'},
  {v:3,  label:'Lair Action'},
  {v:5,  label:'Other 1 (passive)'},
  {v:6,  label:'Other 2 (passive)'},
  {v:-3, label:'Before the encounter starts'},
  {v:-1, label:'When reduced to 0 HP'},
  {v:-2, label:'When it drops an enemy to 0 HP'},
];
const SLOT_LABEL = Object.fromEntries(SLOT_DEFS.map(s=>[s.v, s.label]));
const TYPE_LABELS = { atk:'Attack / damage', heal:'Heal', buff:'Buff (self or ally)', debuff:'Debuff (enemy, save-based)' };
const CONDITION_LABELS = {
  'default':'Always (fallback)',
  'is available':'Is available (e.g. recharge ready)',
  'not used yet':'Not used yet this fight',
  'is under half HP':'This creature is under half HP',
  'has no THP':'This creature has no temp HP',
  'ally at 0 HP':'An ally is at 0 HP',
  'ally under half HP':'An ally is under half HP',
  'enemy count one':'Only one enemy left',
  'enemy count multiple':'Multiple enemies left',
};
const FREQ_KINDS = [
  ['at will','At will'], ['1/fight','Once per fight'], ['1/day','Once per day'],
  ['recharge','Recharge (cooldown)'], ['sr','Uses per short rest'], ['lr','Uses per long rest'],
];
const openActions = new Set();
const openJson = new Set();

function freqKind(f){
  if(typeof f === 'string') return f;
  if(f && f.reset) return f.reset;
  return 'at will';
}
function freqLabel(f){
  if(typeof f === 'string') return f === 'at will' ? 'at will' : f === '1/fight' ? '1/fight' : '1/day';
  if(f?.reset === 'recharge') return `recharge every ${f.cooldownRounds} rds`;
  if(f?.reset === 'sr') return `${f.uses}/short rest`;
  if(f?.reset === 'lr') return `${f.uses}/long rest`;
  return '?';
}
function describeBuff(b){
  if(!b) return 'no effect';
  const parts = [];
  const sign = v => (typeof v === 'number' || /^\d/.test(String(v))) ? '+'+v : v;
  if(b.ac !== undefined) parts.push(`${sign(b.ac)} AC`);
  if(b.toHit !== undefined) parts.push(`${sign(b.toHit)} to hit`);
  if(b.save !== undefined) parts.push(`${sign(b.save)} to saves`);
  if(b.damage !== undefined) parts.push(`${sign(b.damage)} dmg`);
  if(b.damageReduction !== undefined) parts.push(`−${b.damageReduction} dmg taken/hit`);
  if(b.damageMultiplier !== undefined) parts.push(`×${b.damageMultiplier} dmg dealt`);
  if(b.damageTakenMultiplier !== undefined) parts.push(`×${b.damageTakenMultiplier} dmg taken`);
  if(b.condition) parts.push(b.condition);
  return (parts.join(', ') || 'no effect') + ` (${b.duration || '?'})`;
}
function describeAction(a){
  if(a.type === 'template') return `Built-in template: ${a.templateOptions?.templateName || '?'}`;
  const bits = [];
  if(a.type === 'atk'){
    if(a.useSaves) bits.push(`DC ${a.toHit} ${a.ext && a.ext.saveAbility ? a.ext.saveAbility.toUpperCase() + ' ' : ''}save, ${a.dpr} dmg${a.halfOnSave?' (half on save)':''} · up to ${a.targets} target${a.targets==1?'':'s'}`);
    else bits.push(`${a.targets > 1 ? a.targets+' hits × ' : ''}${a.dpr} dmg · +${String(a.toHit).replace(/^\+/,'')} to hit`);
    if(a.riderEffect) bits.push(`+ ${describeBuff(a.riderEffect.buff)}`);
  } else if(a.type === 'heal'){
    bits.push(`heals ${a.amount}${a.tempHP?' temp HP':''}`);
  } else if(a.type === 'buff'){
    bits.push(describeBuff(a.buff));
  } else if(a.type === 'debuff'){
    bits.push(`DC ${a.saveDC} ${a.ext && a.ext.saveAbility ? a.ext.saveAbility.toUpperCase() + ' ' : ''}save → ${describeBuff(a.buff)}`);
  }
  const ex = a.ext || {};
  if(ex.grapple) bits.push(`grapples (escape DC ${ex.grapple.escapeDC ?? '?'})`);
  if(ex.swallow) bits.push(`swallows ≤${ex.swallow.maxSize || 'Medium'}${ex.swallow.digest ? `, ${ex.swallow.digest}/turn inside` : ''}${ex.swallow.regurgitate?.threshold ? `, regurgitates on ${ex.swallow.regurgitate.threshold}+ (DC ${ex.swallow.regurgitate.dc ?? '?'})` : ''}`);
  if(ex.onlyIfEnemiesSurprised) bits.push('only if enemies surprised');
  if(ex.successChance !== undefined) bits.push(`works ${Math.round(ex.successChance*100)}% of the time`);
  if(ex.sneak) bits.push('Sneak Attack');
  if(ex.onHit && ex.onHit.vex) bits.push('Vex');
  if(ex.leap) bits.push('leaps');
  if(ex.dot) bits.push(`${ex.dot.dice} each turn`);
  if(ex.speedBonus) bits.push(`${ex.speedBonus > 0 ? '+' : ''}${ex.speedBonus} ft speed`);
  if(ex.mirror) bits.push(`${ex.mirror} duplicates`);
  if(ex.onHit && ex.onHit.push) bits.push(`pushes ${ex.onHit.push} ft`);
  if(ex.legendaryCost > 1) bits.push(`costs ${ex.legendaryCost} legendary actions`);
  if(ex.selfOnly) bits.push('self only');
  if(ex.stepAway) bits.push(`steps ${ex.stepAway} ft away`);
  if(ex.loseAction) bits.push('costs its action');
  if(ex.damageType) bits.push(ex.damageType);
  if(ex.saveOnDamage) bits.push('save again when hurt');
  if(ex.minCatch) bits.push(`needs ${ex.minCatch}+ enemies`);
  if(ex.wtWhen === 'losing') bits.push('when losing');
  if(a.type === 'debuff' && ex.speedBonus < 0) bits.push(ex.speedBonus <= -60 ? 'stops movement' : `speed ${ex.speedBonus} ft`);
  if(a.type === 'debuff' && ex.onHit && ex.onHit.noReactions) bits.push('no reactions');
  if(ex.onHit && ex.onHit.drain) bits.push('drains');
  if(ex.zone && ex.zone.difficult) bits.push('difficult terrain');
  if(ex.zone && ex.zone.fog) bits.push('blocks sight');
  if(ex.endsOnDamage) bits.push('ends on damage');
  if(ex.teleport) bits.push(`teleports ${ex.teleport} ft`);
  if(ex.grantFly) bits.push(`fly ${ex.grantFly} ft`);
  if(ex.pool) bits.push(`pool of ${ex.pool.dice}d${ex.pool.die || 6}`);
  if(ex.aid) bits.push('+max HP');
  if(ex.retaliate) bits.push(`${ex.retaliate.dmg}${ex.retaliate.perLevel ? '/slot level' : ''} back at melee attackers`);
  if(ex.tempBuff && ex.tempBuff.ac) bits.push(`+${ex.tempBuff.ac} AC while temp HP lasts`);
  if(ex.wtOnly) bits.push('War Table only');
  if(ex.wtSkip) bits.push('export only');
  if(typeof ex.range === 'number') bits.push(ex.range <= 5 ? 'melee' : `${ex.range} ft`);
  bits.push(freqLabel(a.freq));
  if(a.condition && a.condition !== 'default') bits.push(`when: ${a.condition}`);
  return bits.join(' · ');
}
function spellIssues(a){
  if(a.type === 'template') return [];
  const out = [];
  validateAction(Object.assign({}, a, { freq: 'at will', condition: 'default', actionSlot: typeof a.actionSlot === 'number' ? a.actionSlot : 0 }), out, '');
  return out.map(x=>x.replace(/^: /,''));
}
function actionIssues(a){
  if(a.type === 'template') return [];
  const out = [];
  validateAction(a, out, '');
  return out.map(s=>s.replace(/^: /,''));
}

function opts(list, cur){
  return list.map(([v,l])=>`<option value="${escapeAttr(String(v))}" ${String(v)===String(cur)?'selected':''}>${escapeHtml(l)}</option>`).join('');
}
function dataAttrs(mi, aid, k, kind, re){
  return `data-mi="${mi}" data-aid="${aid}" data-k="${k}" data-kind="${kind}"${re?' data-re="1"':''}`;
}
function fInput(label, mi, aid, k, kind, val, help, cls){
  const v = (val === undefined || val === null) ? '' : val;
  return `<div class="ae-f ${cls||''}"><label>${label}</label><input ${dataAttrs(mi,aid,k,kind)} value="${escapeAttr(String(v))}">${help?`<div class="help">${help}</div>`:''}</div>`;
}
function fSelect(label, mi, aid, k, kind, list, cur, re, help, cls){
  return `<div class="ae-f ${cls||''}"><label>${label}</label><select ${dataAttrs(mi,aid,k,kind,re)}>${opts(list,cur)}</select>${help?`<div class="help">${help}</div>`:''}</div>`;
}
function fCheck(label, mi, aid, k, checked){
  return `<label class="ae-check"><input type="checkbox" ${dataAttrs(mi,aid,k,'bool',true)} ${checked?'checked':''}> ${label}</label>`;
}

function buffEditor(mi, aid, prefix, b){
  b = b || {};
  return `<div class="ae-grid">
    ${fSelect('Duration', mi, aid, prefix+'.duration', 'str', VALID_BUFF_DURATIONS.map(d=>[d,d]), b.duration)}
    ${fSelect('Condition', mi, aid, prefix+'.condition', 'optstr', [['','— none —'], ...VALID_CREATURE_CONDITIONS.map(c=>[c,c])], b.condition||'')}
    ${fInput('AC bonus', mi, aid, prefix+'.ac', 'optdice', b.ac, 'e.g. 2 or -2')}
    ${fInput('To-hit bonus', mi, aid, prefix+'.toHit', 'optdice', b.toHit, 'e.g. 2 or 1d4')}
    ${fInput('Bonus damage', mi, aid, prefix+'.damage', 'optdice', b.damage, 'Added to its attacks')}
    ${fInput('Damage reduction', mi, aid, prefix+'.damageReduction', 'optdice', b.damageReduction, 'Flat, per hit taken')}
    ${fInput('Saving throw bonus', mi, aid, prefix+'.save', 'optdice', b.save, 'Bless +1d4, Mind Sliver -1d4')}
    ${fInput('Damage dealt ×', mi, aid, prefix+'.damageMultiplier', 'optnum', b.damageMultiplier, '1 normal · 1.5 = +50%')}
    ${fInput('Damage taken ×', mi, aid, prefix+'.damageTakenMultiplier', 'optnum', b.damageTakenMultiplier, '0.5 resist · 2 vulnerable')}
  </div>`;
}

function spellFields(mi, a){
  if(!isSB(mi)) return '';
  const lvls = [[0,'Cantrip']].concat([1,2,3,4,5,6,7,8,9].map(l=>[l,'Level '+l]));
  return `<div class="ae-grid">
    ${fSelect('Spell level', mi, a.id, '__spLevel', 'str', lvls, a.level || 0, true)}
    ${a.level ? fInput('Upcast: extra per slot level', mi, a.id, '__spUpcast', 'str', a.upcast || '', 'e.g. 1d8. Blank = no benefit') : ''}
    ${a.level && (a.type === 'debuff' || a.type === 'buff' || a.type === 'heal') ? fInput('Extra targets per higher slot', mi, a.id, '__spUpT', 'str', a.upcastTargets || '', 'Hold Person: 1') : ''}
    ${a.level ? fCheck('Concentration', mi, a.id, '__spConc', !!a.concentration) : ''}
  </div>`;
}
function actionForm(mi, a){
  if(a.type === 'template' && isSB(mi)){
    return `<div class="ae-form"><div class="help" style="margin-top:8px;font-size:13px;color:var(--parchment-faint);">Built-in template: ${escapeHtml(a.templateOptions?.templateName||'?')}.</div>${spellFields(mi, a)}</div>`;
  }
  if(a.type === 'template'){
    return `<div class="ae-form"><div class="help" style="margin-top:8px;font-size:13px;color:var(--parchment-faint);">This uses one of the save format's built-in templates (${escapeHtml(a.templateOptions?.templateName||'?')}). Only its frequency and condition are editable here; use Advanced JSON for anything else.</div>
      <div class="ae-grid">${freqFields(mi,a)}${fSelect('Use when', mi, a.id, 'condition', 'str', VALID_CONDITIONS.map(c=>[c, CONDITION_LABELS[c]||c]), a.condition)}</div></div>`;
  }
  const isEnemyT = a.type === 'atk' || a.type === 'debuff';
  const targetList = (isEnemyT ? VALID_ENEMY_TARGETS : VALID_ALLY_TARGETS).map(t=>[t,t]);
  let countLabel = 'Targets', countHelp = '';
  if(a.type === 'atk' && !a.useSaves){ countLabel = 'Number of hits'; countHelp = 'Multiattack: 3 attacks = 3'; }
  else if(a.type === 'atk' || a.type === 'debuff'){ countLabel = 'Creatures caught'; countHelp = 'Each rolls its own save'; }

  let typeFields = '';
  if(a.type === 'atk'){
    const rider = a.riderEffect;
    typeFields = `
      <div class="ae-seg">
        <button data-mi="${mi}" data-aid="${a.id}" data-seg="useSaves" data-val="0" class="${!a.useSaves?'on':''}">Attack roll</button>
        <button data-mi="${mi}" data-aid="${a.id}" data-seg="useSaves" data-val="1" class="${a.useSaves?'on':''}">Saving throw</button>
      </div>
      <div class="ae-grid">
        ${fInput(a.useSaves ? 'Save DC' : 'To-hit bonus', mi, a.id, 'toHit', 'dice', a.toHit)}
        ${a.useSaves ? fSelect('Saving throw', mi, a.id, '__saveAb', 'str', SAVE_OPTS, (a.ext && a.ext.saveAbility) || '') : ''}
        ${fInput(a.useSaves ? 'Damage' : 'Damage per hit', mi, a.id, 'dpr', 'dice', a.dpr, 'e.g. 2d6 + 3, or an average like 8.5')}
        ${a.useSaves ? fCheck('Half damage on a save', mi, a.id, 'halfOnSave', !!a.halfOnSave) : ''}
      </div>
      <div class="ae-sub">
        ${fCheck('Also applies a lingering effect on hit / failed save', mi, a.id, '__riderOn', !!rider)}
        ${rider ? `
          <div class="ae-grid">
            ${fCheck('Same roll as the main effect', mi, a.id, '__riderSame', rider.dc === 99)}
            ${rider.dc !== 99 ? fInput('Separate save DC', mi, a.id, 'riderEffect.dc', 'num', rider.dc) : ''}
            ${rider.dc !== 99 ? fSelect('Its saving throw', mi, a.id, '__riderSave', 'str', SAVE_OPTS, (a.ext && a.ext.riderSave) || '') : ''}
          </div>
          ${buffEditor(mi, a.id, 'riderEffect.buff', rider.buff)}` : ''}
      </div>`;
  } else if(a.type === 'heal'){
    typeFields = `<div class="ae-grid">
      ${fInput('Amount healed', mi, a.id, 'amount', 'dice', a.amount, 'e.g. 2d8 + 3')}
      ${fCheck('Grants temporary HP instead', mi, a.id, 'tempHP', !!a.tempHP)}
    </div>`;
  } else if(a.type === 'buff'){
    typeFields = `<div class="ae-sub"><div class="ae-sub-title">Effect</div>${buffEditor(mi, a.id, 'buff', a.buff)}</div>`;
  } else if(a.type === 'debuff'){
    typeFields = `<div class="ae-grid">${fInput('Save DC', mi, a.id, 'saveDC', 'num', a.saveDC)}${fSelect('Saving throw', mi, a.id, '__saveAb', 'str', SAVE_OPTS, (a.ext && a.ext.saveAbility) || '')}</div>
      <div class="ae-sub"><div class="ae-sub-title">Effect on a failed save</div>${buffEditor(mi, a.id, 'buff', a.buff)}</div>`;
  }

  const sb = isSB(mi);
  return `<div class="ae-form">
    <div class="ae-grid">
      ${fInput('Name', mi, a.id, 'name', 'str', a.name, '', 'wide')}
      ${fSelect('Type', mi, a.id, '__type', 'str', Object.entries(TYPE_LABELS), a.type, true)}
      ${fSelect(sb ? 'Casting time' : 'Slot', mi, a.id, 'actionSlot', 'num', (sb ? SLOT_DEFS.filter(s=>[0,1,4].includes(s.v)) : SLOT_DEFS).map(s=>[s.v, s.label]), a.actionSlot, true)}
      ${sb ? '' : fSelect('Use when', mi, a.id, 'condition', 'str', VALID_CONDITIONS.map(c=>[c, CONDITION_LABELS[c]||c]), a.condition)}
      ${fSelect('Aim at', mi, a.id, 'target', 'str', targetList, a.target)}
      ${fInput(countLabel, mi, a.id, 'targets', 'int', a.targets, countHelp)}
      ${sb ? '' : freqFields(mi, a)}
    </div>
    ${spellFields(mi, a)}
    ${typeFields}
    ${mechanicsPanel(mi, a)}
  </div>`;
}

const SIZE_OPTS = ['Tiny','Small','Medium','Large','Huge','Gargantuan'].map(z=>[z,z]);
function mechanicsPanel(mi, a){
  const ex = a.ext || {};
  const g = ex.grapple, sw = ex.swallow;
  let html = `<div class="ae-sub"><div class="ae-sub-title">Special mechanics <span class="ext-note">used by the War Table; the export leaves them out</span></div>`;
  if(a.type === 'atk'){
    html += fCheck('Grapples the target on a hit', mi, a.id, '__grappleOn', !!g);
    if(g) html += `<div class="ae-grid">
      ${fInput('Escape DC', mi, a.id, 'ext.grapple.escapeDC', 'num', g.escapeDC)}
      ${fSelect('Max target size', mi, a.id, 'ext.grapple.maxSize', 'str', SIZE_OPTS, g.maxSize || 'Medium')}
      ${fInput('Save DC to avoid', mi, a.id, 'ext.grapple.dc', 'optnum', g.dc, 'Blank = automatic on hit')}
      ${fCheck('Grappled target is restrained', mi, a.id, 'ext.grapple.restrains', g.restrains !== false)}
    </div>`;
    html += fCheck('Swallows a creature it is grappling (this attack is used on the grappled target)', mi, a.id, '__swallowOn', !!sw);
    if(sw) html += `<div class="ae-grid">
      ${fSelect('Max size swallowed', mi, a.id, 'ext.swallow.maxSize', 'str', SIZE_OPTS, sw.maxSize || 'Medium')}
      ${fInput('Damage each turn inside', mi, a.id, 'ext.swallow.digest', 'optdice', sw.digest, 'e.g. 2d6 (acid)')}
      ${fInput('Can hold at once', mi, a.id, 'ext.swallow.capacity', 'int', sw.capacity || 1)}
      ${fInput('Regurgitate if it takes', mi, a.id, 'ext.swallow.regurgitate.threshold', 'optnum', sw.regurgitate?.threshold, 'damage in one turn from inside')}
      ${fInput('…then makes a save, DC', mi, a.id, 'ext.swallow.regurgitate.dc', 'optnum', sw.regurgitate?.dc)}
      ${fInput('Its bonus to that save', mi, a.id, 'ext.swallow.regurgitate.saveBonus', 'optnum', sw.regurgitate?.saveBonus, 'Blank = its save bonus')}
    </div>`;
  }
  html += fCheck('Only when the enemies are surprised (round 1)', mi, a.id, '__ambush', !!ex.onlyIfEnemiesSurprised);
  const oh = ex.onHit || {};
  if(a.type === 'atk' && !a.useSaves){
    html += `<div class="ae-grid">
      ${fInput('War Table damage', mi, a.id, 'ext.wtDpr', 'optdice', ex.wtDpr, 'What the War Table rolls, when "Damage" above folds in an average (e.g. 1d8 + 4 without Sneak Attack). Blank = same as Damage.')}
      ${fInput('Slows the target (ft)', mi, a.id, 'ext.onHit.slow', 'optnum', oh.slow, 'Ray of Frost, Slow mastery: speed down until your next turn')}
      ${fInput('Splash to a 2nd enemy within 5 ft', mi, a.id, 'ext.onHit.splash.dmg', 'optdice', oh.splash && oh.splash.dmg, 'Green-Flame Blade: e.g. 4')}
      ${fInput('Ongoing damage after a hit', mi, a.id, 'ext.onHit.dot.dice', 'optdice', oh.dot && oh.dot.dice, 'Witch Bolt: 1d12 each turn while concentrating')}
    </div>
    ${fCheck('Sneak Attack can apply (finesse or ranged weapon)', mi, a.id, '__x:sneak', !!ex.sneak)}
    ${fCheck('Vex mastery: a damaging hit gives advantage on your next attack against that target', mi, a.id, '__x:onHit.vex', !!oh.vex)}
    ${fCheck('Target can\'t take reactions after a hit (Shocking Grasp)', mi, a.id, '__x:onHit.noReactions', !!oh.noReactions)}
    ${fCheck('Leaps to another target within 30 ft on doubles (Chromatic Orb)', mi, a.id, '__x:leap', !!ex.leap)}`;
  }
  if(a.type === 'atk'){
    html += `<div class="ae-grid">${fInput('Damage type', mi, a.id, 'ext.damageType', 'optstr', ex.damageType, 'fire · "slashing + fire" for both · "acid/cold/fire" when the attacker picks (Chromatic Orb). Resistances and immunities use it (War Table).')}
      ${fCheck('Magical (beats resistance to nonmagical weapons)', mi, a.id, '__x:magical', !!ex.magical || !!a.level)}</div>`;
    html += `<div class="ae-grid">${fInput('Damage if the target is hurt', mi, a.id, 'ext.dprIfHurt', 'optdice', ex.dprIfHurt, 'Toll the Dead: 1d12 against a creature below max HP')}
      ${fInput('Pushes the target (ft)', mi, a.id, 'ext.onHit.push', 'optnum', oh.push, a.useSaves ? 'On a failed save (Thunderwave 10, Telekinetic Shove 5). War Table: stops at walls and creatures; off a ledge it falls.' : 'On a hit (Shove, Tavern Brawler, Push mastery)')}</div>
    ${fCheck('Heals the attacker for the damage dealt (Vampiric Bite, drain)', mi, a.id, '__x:onHit.drain', !!oh.drain)}`;
  }
  if((a.type === 'atk' || a.type === 'debuff') && ex.area){
    html += `${fCheck('Leaves difficult terrain in the area while concentrating (Entangle, Spike Growth)', mi, a.id, '__x:zone.difficult', !!(ex.zone && ex.zone.difficult))}
    ${fCheck('Heavily obscures the area: nobody sees in, out or through (Fog Cloud, War Table)', mi, a.id, '__x:zone.fog', !!(ex.zone && ex.zone.fog))}`;
  }
  if(a.type === 'debuff'){
    html += fCheck('Ends early if the target takes damage (Suggestion, Sleep)', mi, a.id, '__x:endsOnDamage', !!ex.endsOnDamage);
  }
  if(a.type === 'heal'){
    html += `<div class="ae-grid">
      ${fInput('Dice pool size', mi, a.id, 'ext.pool.dice', 'optnum', ex.pool && ex.pool.dice, 'Healing Light: 1 + warlock level d6s per long rest (War Table spends what the wound needs)')}
      ${ex.pool ? fInput('Pool die', mi, a.id, 'ext.pool.die', 'optnum', ex.pool.die, 'd6 = 6') : ''}
      ${ex.pool ? fInput('Most dice per use', mi, a.id, 'ext.pool.maxPer', 'optnum', ex.pool.maxPer, 'Healing Light: Charisma modifier') : ''}
      ${a.tempHP ? fInput('Damage to melee attackers while temp HP lasts', mi, a.id, 'ext.retaliate.dmg', 'optnum', ex.retaliate && ex.retaliate.dmg, 'Armor of Agathys: 5 cold') : ''}
      ${a.tempHP ? fInput('AC bonus while temp HP lasts', mi, a.id, 'ext.tempBuff.ac', 'optnum', ex.tempBuff && ex.tempBuff.ac, 'e.g. a magic cloak: +2') : ''}
    </div>
    ${fCheck('Raises maximum HP too, for the rest of the day (Aid)', mi, a.id, '__x:aid', !!ex.aid)}
    ${a.tempHP && ex.retaliate ? fCheck('That damage scales with the slot level (Armor of Agathys)', mi, a.id, '__x:retaliate.perLevel', !!ex.retaliate.perLevel) : ''}`;
  }
  if(a.type === 'atk' && a.useSaves){
    html += `<div class="ae-grid">
      ${fInput('Ongoing damage instead', mi, a.id, 'ext.dot.dice', 'optdice', ex.dot && ex.dot.dice, 'Tasha\'s Caustic Brew: 2d4 at the start of each of its turns (War Table). Damage above stays the export estimate.')}
      ${ex.dot ? fInput('Ongoing: extra per higher slot', mi, a.id, 'ext.dot.upcast', 'optdice', ex.dot.upcast) : ''}
    </div>`;
  }
  if(a.type === 'buff'){
    html += `<div class="ae-grid">
      ${fInput('Speed bonus (ft)', mi, a.id, 'ext.speedBonus', 'optnum', ex.speedBonus, 'Bladesong +10, Longstrider +10')}
      ${fInput('Concentration save bonus', mi, a.id, 'ext.concBonus', 'optnum', ex.concBonus, 'Bladesong: + Int modifier')}
      ${fInput('Mirror Image duplicates', mi, a.id, 'ext.mirror', 'optnum', ex.mirror, 'War Table rolls each hit against the duplicates; the export uses the damage-taken × above')}
      ${fInput('Teleport (ft)', mi, a.id, 'ext.teleport', 'optnum', ex.teleport, 'Misty Step 30: the War Table uses it to get out of melee without provoking, then still acts')}
      ${fInput('Grants a fly speed (ft)', mi, a.id, 'ext.grantFly', 'optnum', ex.grantFly, 'Heavenly Wings, Fly: 30 or 60')}
    </div>
    ${fCheck('Ends if the creature is incapacitated or drops to 0 HP', mi, a.id, '__x:endsOnIncap', !!ex.endsOnIncap)}`;
  }
  html += `<div class="ae-grid">
    ${fInput('Turns on a self effect (name)', mi, a.id, '__grantsBuff', 'str', (ex.grantsBuff && ex.grantsBuff.id) || '', 'e.g. wrath-of-the-sea: manifesting it lets other actions that need it be used')}
    ${fInput('Only while this effect is on', mi, a.id, 'ext.requiresBuff', 'optstr', ex.requiresBuff, 'The same name as above (War Table)')}
  </div>`;
  if(a.actionSlot === 2) html += `<div class="ae-grid">${fInput('Legendary action cost', mi, a.id, 'ext.legendaryCost', 'optnum', ex.legendaryCost, 'Costs 2 Actions → 2 (War Table)')}</div>`;
  if(a.actionSlot === 4 && a.type === 'debuff') html += fCheck('Only protects itself (not its allies)', mi, a.id, '__x:selfOnly', !!ex.selfOnly);
  if(a.actionSlot === 4 && a.type === 'buff') html += `<div class="ae-grid">${fInput('Steps away when an enemy ends its turn next to it (ft)', mi, a.id, 'ext.stepAway', 'optnum', ex.stepAway, 'Careful Distance: 10 — moves without provoking (War Table)')}</div>`;
  if(a.type === 'debuff') html += `<div class="ae-grid">${fInput('Target speed change (ft)', mi, a.id, 'ext.speedBonus', 'optnum', ex.speedBonus, 'e.g. -15 for halved speed, -60 to stop movement (War Table)')}</div>
    ${fCheck('Target can\'t take reactions while affected', mi, a.id, '__x:onHit.noReactions', !!(ex.onHit && ex.onHit.noReactions))}
    ${fCheck('Only costs the target its action (it can still move and react), instead of the full condition', mi, a.id, '__x:loseAction', !!ex.loseAction)}
    ${fSelect('Target repeats the save when it takes damage', mi, a.id, '__saveOnDamage', 'str', [['','No'],['true','Yes'],['adv','Yes, with advantage (Hideous Laughter)']], ex.saveOnDamage === true ? 'true' : (ex.saveOnDamage || ''))}
    <div class="ae-grid">${fInput('Extra targets must be within (ft) of the first', mi, a.id, 'ext.pairWithin', 'optnum', ex.pairWithin, 'Grasping Want: 5 (two creatures within reach of each other)')}</div>`;
  if((a.type === 'atk' || a.type === 'debuff') && (ex.area || (a.targets || 1) > 1)) html += `<div class="ae-grid">${fInput('Only worth it on at least (enemies)', mi, a.id, 'ext.minCatch', 'optnum', ex.minCatch, 'Entangle 3: a tool for a crowd of weaker foes, not an opener (War Table)')}</div>`;
  html += fCheck('Only when the fight is going badly for its side (Fog Cloud: a way out, not an opener)', mi, a.id, '__x:wtWhenLosing', ex.wtWhen === 'losing');
  html += fCheck('War Table only (left out of the export)', mi, a.id, '__x:wtOnly', !!ex.wtOnly);
  html += fCheck('Export only (the War Table simulates this natively, e.g. an Assassinate stand-in)', mi, a.id, '__x:wtSkip', !!ex.wtSkip);
  html += `<div class="ae-grid">${fInput('Range / reach (ft)', mi, a.id, 'ext.range', 'optnum', ex.range, 'For the War Table. Blank = guessed from the name')}
    ${(a.type === 'atk' || a.type === 'debuff') ? fInput('Only works on', mi, a.id, '__targetTypes', 'str', (ex.targetTypes || []).join(', '), 'Creature types, e.g. humanoid (Hold Person). Blank = anyone. PCs count as humanoid.') : ''}</div>`;
  if((a.useSaves || a.type === 'debuff') && a.actionSlot !== 5 && a.actionSlot !== 6){
    const ar = ex.area || {};
    let guess = '';
    try{ const g = TacEngine.areaSpec(Object.assign({}, a, { ext: Object.assign({}, ex, { area: undefined }), _range: TacEngine.inferRange(a).range })); guess = g ? ` (looks like a ${g.size}-ft ${g.shape === 'sphere' ? 'burst' : g.shape})` : ' (single target)'; }catch(e){}
    html += `<div class="ae-grid">
      ${fSelect('Area of effect', mi, a.id, '__areaShape', 'str', [['auto','Auto'],['sphere','Burst / sphere (radius)'],['cone','Cone (length)'],['line','Line (length)'],['cube','Cube (side)'],['emanation','Emanation around the caster (radius)']], ar.shape || 'auto', true, 'Auto' + guess + ' hits up to "targets" creatures. Pick a shape to catch everyone inside it on the War Table.')}
      ${ar.shape ? fInput('Area size (ft)', mi, a.id, '__areaSize', 'optnum', ar.size, 'Fireball 20 · Burning Hands 15 · breath cones 15–90') : ''}
    </div>
    ${fCheck('Only affects enemies (Spirit Guardians, Careful Spell). Otherwise the area also hits allies caught in it, and the War Table AI aims to avoid them.', mi, a.id, '__x:area.selective', !!ar.selective)}`;
  }
  html += `<div class="ae-grid">${fInput('Success chance %', mi, a.id, '__successPct', 'str', ex.successChance !== undefined ? Math.round(ex.successChance*1000)/10 : '', 'Blank = always works. e.g. Hide: DC 15 Stealth at +8 = 70. A self-buff that makes you Invisible for 1 round counts as Hide: the War Table only allows it out of every enemy\'s sight.')}</div>`;
  return html + `</div>`;
}

function freqFields(mi, a){
  const k = freqKind(a.freq);
  let extra = '';
  if(k === 'recharge') extra = fInput('Cooldown (rounds)', mi, a.id, 'freq.cooldownRounds', 'int', a.freq.cooldownRounds, 'Recharge 6 → 6 · 5–6 → 3 · 4–6 → 2');
  if(k === 'sr' || k === 'lr') extra = fInput('Uses', mi, a.id, 'freq.uses', 'int', a.freq.uses);
  return fSelect('Frequency', mi, a.id, '__freqKind', 'str', FREQ_KINDS, k, true) + extra;
}

function actionRow(mi, a, posInSlot, slotCount){
  const open = openActions.has(a.id);
  const sb = isSB(mi);
  const issues = sb ? spellIssues(a) : actionIssues(a);
  return `<div class="ae-row ${open?'open':''}">
    <div class="ae-bar" data-ae-toggle="${a.id}" data-mi="${mi}">
      <div class="ae-prio">${sb ? (a.level ? 'L'+a.level : 'C') : slotCount > 1 ? posInSlot+1 : ''}</div>
      <div class="ae-main">
        <div class="ae-name">${escapeHtml(a.name || a.templateOptions?.templateName || 'Unnamed')}<span id="ae-dot-${a.id}">${issues.length ? `<span class="ae-dot" title="${escapeAttr(issues.join('\n'))}"></span>` : ''}</span></div>
        <div class="ae-sum" id="ae-sum-${a.id}">${escapeHtml(sb ? describeSpell(a) : describeAction(a))}</div>
      </div>
      <div class="ae-tools">
        ${sb ? '' : `<button title="Higher priority" data-ae-move="-1" data-aid="${a.id}" data-mi="${mi}" ${posInSlot===0?'disabled':''}>↑</button>
        <button title="Lower priority" data-ae-move="1" data-aid="${a.id}" data-mi="${mi}" ${posInSlot===slotCount-1?'disabled':''}>↓</button>`}
        <button title="Duplicate" data-ae-dup="${a.id}" data-mi="${mi}">⧉</button>
        <button title="Delete" class="del" data-ae-del="${a.id}" data-mi="${mi}">✕</button>
      </div>
    </div>
    ${open ? actionForm(mi, a) : ''}
  </div>`;
}

function slotOf(a){ return a.type === 'template' && typeof a.actionSlot !== 'number' ? 'template' : a.actionSlot; }

function actionEditor(mi, m){
  const sb = isSB(mi);
  const actions = (m.actions || []).filter(a=>!(a.ext && a.ext.fromSpellbook));
  const groups = [];
  const order = [...SLOT_DEFS.map(s=>s.v), 'template'];
  const seen = new Set(actions.map(slotOf));
  // include any unexpected slot numbers too
  seen.forEach(s=>{ if(!order.includes(s)) order.push(s); });
  order.forEach(s=>{
    const list = actions.filter(a=>slotOf(a) === s);
    if(!list.length) return;
    const label = s === 'template' ? 'Templates' : (SLOT_LABEL[s] || `Slot ${s}`);
    let hint = '';
    if(sb) hint = s === 4 ? 'Cast in response, when it matters' : 'Chosen each turn by what the situation needs';
    else if(typeof s === 'number' && s < 0) hint = 'Triggers automatically';
    else if(list.length > 1) hint = 'Checked top to bottom: the first usable one whose condition is met fires';
    groups.push(`<div class="ae-slot"><div class="ae-slot-head">${escapeHtml(label)}<span>${hint}</span></div>
      ${list.map((a,i)=>actionRow(mi, a, i, list.length)).join('')}</div>`);
  });
  return `<div class="ae">
    ${groups.join('') || `<div class="empty-note" style="padding:8px 2px;">${sb ? 'No spells yet.' : 'No actions yet.'}</div>`}
    <div class="ae-add">
      <button class="mini-btn" data-ae-add="atk" data-mi="${mi}">+ Attack</button>
      <button class="mini-btn" data-ae-add="debuff" data-mi="${mi}">+ Debuff</button>
      <button class="mini-btn" data-ae-add="buff" data-mi="${mi}">+ Buff</button>
      <button class="mini-btn" data-ae-add="heal" data-mi="${mi}">+ Heal</button>
    </div>
  </div>`;
}


/* ---------------------------------------------------------
   Spellcasting: spell slots + a spell list (ext.spellbook)
   The War Table picks a spell every turn from the whole list, by what the situation needs and what
   the slot is worth. The exported JSON only understands fixed actions, so on
   export the list is compiled into ordinary limited-use actions (ext.fromSpellbook): the slots are
   shared out between the levelled spells and each gets a sensible "use when" condition.
--------------------------------------------------------- */
const avgD = x => { try{ return TacEngine.avgDice(x); }catch(e){ return parseFloat(x) || 0; } };
function spellCond(sp){
  if(sp.actionSlot === 4) return 'default';
  if(sp.type === 'heal') return sp.target === 'self' ? (sp.tempHP ? 'has no THP' : 'is under half HP') : 'ally under half HP';
  const lasting = sp.buff && (sp.buff.duration === 'entire encounter' || sp.buff.duration === 'repeat the save each round');
  if((sp.type === 'buff' || sp.type === 'debuff') && lasting) return 'not used yet';
  if(sp.type === 'atk' && sp.useSaves && (sp.targets || 1) > 1) return 'enemy count multiple';
  return 'default';
}
function spellDamage(sp){
  if(sp.type !== 'atk') return 0;
  const d = avgD(sp.dpr);
  return sp.useSaves ? d * 0.6 * (sp.targets || 1) : d * 0.65 * (sp.targets || 1);
}
function compileSpellbook(c){
  const own = (c.actions || []).filter(a=>!(a.ext && a.ext.fromSpellbook));
  const sb = c.ext && c.ext.spellbook;
  if(!sb || !Array.isArray(sb.spells) || !sb.spells.length) return own;
  const reset = sb.slotReset === 'sr' ? 'sr' : 'lr';
  const slots = Array.from({ length: 9 }, (_, i) => Math.max(0, parseInt((sb.slots || [])[i], 10) || 0));
  const spells = sb.spells.filter(sp=>sp && sp.type && !(sp.ext && sp.ext.wtOnly));
  const lvl = sp => Math.max(0, Math.min(9, parseInt(sp.level, 10) || 0));
  const levelled = spells.filter(sp=>lvl(sp) > 0);
  const weight = sp => sp.actionSlot === 4 ? 1 : sp.type === 'debuff' ? 3 : sp.type === 'heal' ? 2.5 : sp.type === 'buff' ? 2 : (sp.useSaves && (sp.targets || 1) > 1) ? 2.5 : 1.5;
  const uses = new Map(levelled.map(sp=>[sp.id, 0]));
  for(let L = 9; L >= 1; L--){
    const n = slots[L-1]; if(!n) continue;
    const elig = levelled.filter(sp=>lvl(sp) <= L);
    if(!elig.length) continue;
    const w = elig.map(sp=>weight(sp) * (lvl(sp) === L ? 2 : 1));
    const tot = w.reduce((a,b)=>a+b, 0);
    const share = w.map(x=>x / tot * n), got = share.map(Math.floor);
    let left = n - got.reduce((a,b)=>a+b, 0);
    share.map((x,i)=>[x - got[i], i]).sort((a,b)=>b[0]-a[0]).forEach(([,i])=>{ if(left > 0){ got[i]++; left--; } });
    elig.forEach((sp,i)=>uses.set(sp.id, uses.get(sp.id) + got[i]));
  }
  const mk = (sp, freq) => {
    const ext = Object.assign({}, sp.ext || {}, { fromSpellbook: true });
    if(sp.type === 'template') return { type: 'template', id: 'sbc-' + sp.id, freq, condition: spellCond(sp), templateOptions: sp.templateOptions, ext };
    const { level, concentration, upcast, ...rest } = sp;
    return Object.assign({}, rest, { id: 'sbc-' + sp.id, name: sp.name, actionSlot: typeof sp.actionSlot === 'number' ? sp.actionSlot : 0,
      freq, condition: spellCond(sp), targets: sp.targets || 1, ext });
  };
  const rank = sp => sp.type === 'heal' ? 0 : sp.type === 'debuff' ? 1 : sp.type === 'buff' ? 2 : (sp.useSaves && (sp.targets || 1) > 1) ? 3 : 4;
  const comp = levelled.filter(sp=>uses.get(sp.id) > 0).sort((a,b)=>rank(a) - rank(b) || lvl(b) - lvl(a)).map(sp=>mk(sp, { reset, uses: uses.get(sp.id) }));
  // cantrips: the strongest damage cantrip per slot, if it beats the creature's own at-will attack there
  [0, 1].forEach(slot=>{
    const best = spells.filter(sp=>!lvl(sp) && (sp.actionSlot ?? 0) === slot && sp.type === 'atk').sort((a,b)=>spellDamage(b) - spellDamage(a))[0];
    if(!best) return;
    const mine = own.filter(a=>a.actionSlot === slot && a.type === 'atk' && a.freq === 'at will' && a.condition === 'default').reduce((m,a)=>Math.max(m, spellDamage(a)), 0);
    if(spellDamage(best) > mine) comp.push(mk(best, 'at will'));
  });
  // each compiled action goes above the first at-will "default" action of its slot (the export is read top-down)
  const out = own.slice();
  comp.forEach(ca=>{
    const i = out.findIndex(x=>x.actionSlot === ca.actionSlot && x.freq === 'at will' && x.condition === 'default' && !(x.ext && x.ext.fromSpellbook));
    if(i < 0) out.push(ca); else out.splice(i, 0, ca);
  });
  return out;
}
function exportCreature(m){
  let c = stripInternal(m);
  if((c.actions || []).some(a=>a.ext && a.ext.wtOnly)) c = Object.assign({}, c, { actions: c.actions.filter(a=>!(a.ext && a.ext.wtOnly)) });
  if(!(c.ext && c.ext.spellbook) && !(c.actions || []).some(a=>a.ext && a.ext.fromSpellbook)) return c;
  return Object.assign({}, c, { actions: compileSpellbook(c) });
}
function describeSpell(a){
  const head = (a.level ? `Level ${a.level}` : 'Cantrip') + (a.concentration ? ' · concentration' : '') + (a.upcast ? ` · +${a.upcast} per higher slot` : '');
  if(a.type === 'template') return head + ' · ' + (a.templateOptions?.templateName || 'template');
  const rest = describeAction(Object.assign({}, a, { freq: 'at will', condition: 'default' })).split(' · ');
  rest.pop();   // the frequency
  return [head, ...rest].join(' · ');
}
function validateSpellbook(m, issues){
  const sb = m.ext && m.ext.spellbook;
  if(!sb) return;
  const slots = Array.from({ length: 9 }, (_, i) => parseInt((sb.slots || [])[i], 10) || 0);
  (sb.spells || []).forEach(sp=>{
    const nm = sp.name || sp.templateOptions?.templateName || 'unnamed';
    if(sp.type !== 'template') validateAction(Object.assign({}, sp, { freq: 'at will', condition: 'default', actionSlot: typeof sp.actionSlot === 'number' ? sp.actionSlot : 0 }), issues, `Spell "${nm}"`);
    const L = parseInt(sp.level, 10) || 0;
    if(L > 0 && !slots.slice(L - 1).some(n=>n > 0)) issues.push(`Spell "${nm}" is level ${L}, but there are no level ${L}+ spell slots, so it can never be cast`);
  });
}
function spellbookPanel(key, c){
  const sb = c.ext && c.ext.spellbook;
  if(!sb) return `<div class="sb-box off"><button class="mini-btn" data-sb-on="${key}">+ Spellcasting</button>
    <span class="help">Give it spell slots and a spell list; on the War Table it picks the right spell for the moment instead of following a fixed order.</span></div>`;
  const slots = Array.from({ length: 9 }, (_, i) => parseInt((sb.slots || [])[i], 10) || 0);
  const comp = compileSpellbook(c).filter(a=>a.ext && a.ext.fromSpellbook);
  const total = slots.reduce((t,n)=>t+n, 0);
  return `<div class="sb-box">
    <div class="team-label" style="margin-top:0;">Spellcasting</div>
    <div class="sb-slots">${slots.map((n,i)=>`<label>L${i+1}<input type="number" min="0" max="9" data-sb-slot="${i}" data-owner="${key}" value="${n || ''}" placeholder="0"></label>`).join('')}</div>
    <div class="ae-grid" style="margin-top:6px;">
      <div class="ae-f"><label>Slots come back on</label><select data-sb-reset data-owner="${key}"><option value="lr" ${sb.slotReset !== 'sr' ? 'selected' : ''}>Long rest</option><option value="sr" ${sb.slotReset === 'sr' ? 'selected' : ''}>Short rest (Pact Magic)</option></select></div>
      <div class="ae-f"><label>Recover on a short rest</label><input type="number" min="0" max="9" data-sb-rec data-owner="${key}" value="${sb.recovery && sb.recovery.levels ? sb.recovery.levels : ''}" placeholder="0"><div class="help">Slot levels, once per long rest (Arcane Recovery: half wizard level, rounded up)</div>${sb.recovery ? `<label class="ae-check"><input type="checkbox" data-sb-anybreak data-owner="${key}" ${sb.recovery.anyBreak ? 'checked' : ''}> Between any two fights, no rest needed (Magical Cunning)</label>` : ''}</div>
      <div class="ae-f"><label>Concentration save bonus</label><input type="number" step="0.5" data-sb-con data-owner="${key}" value="${typeof sb.conSave === 'number' ? sb.conSave : ''}" placeholder="= save bonus"><div class="help">Con save + anything that adds to it (Bladesong, War Caster…)</div></div>
    </div>
    ${actionEditor(key + '~sb', { actions: sb.spells || [] })}
    <div class="help" style="margin-top:6px;">${total} slot${total === 1 ? '' : 's'}, ${(sb.spells || []).length} spell${(sb.spells || []).length === 1 ? '' : 's'}. The War Table uses the list and slots directly. In the exported JSON it becomes ${comp.length} fixed action${comp.length === 1 ? '' : 's'}: ${escapeHtml(comp.map(a=>(a.name || a.templateOptions?.templateName) + (a.freq && a.freq.uses ? ' ×' + a.freq.uses : a.freq === 'at will' ? ' (at will)' : '')).join(', ') || 'none')}.</div>
    <div class="row-btns"><button class="mini-btn danger" data-sb-off="${key}">Remove spellcasting</button></div>
  </div>`;
}
['monsterGrid','partyGrid'].forEach(gridId=>{
  const grid = document.getElementById(gridId);
  grid.addEventListener('click', ev=>{
    const on = ev.target.closest('[data-sb-on]'), off = ev.target.closest('[data-sb-off]');
    if(!on && !off) return;
    const key = (on || off).dataset[on ? 'sbOn' : 'sbOff'];
    const c = creatureByKey(key); if(!c) return;
    if(on){ c.ext = c.ext || {}; c.ext.spellbook = { slots: [2,0,0,0,0,0,0,0,0], slotReset: 'lr', spells: [] }; }
    else {
      if(!confirm('Remove the spell slots and spell list?')) return;
      delete c.ext.spellbook; if(!Object.keys(c.ext).length) delete c.ext;
      c.actions = (c.actions || []).filter(a=>!(a.ext && a.ext.fromSpellbook));
    }
    c._warnings = validateMonster(c); rerenderFor(key);
  });
  const onSB = el=>{
    const c = creatureByKey(el.dataset.owner); if(!c || !c.ext || !c.ext.spellbook) return;
    const sb = c.ext.spellbook;
    if(el.dataset.sbSlot !== undefined){ sb.slots = Array.from({ length: 9 }, (_, i) => parseInt((sb.slots || [])[i], 10) || 0); sb.slots[+el.dataset.sbSlot] = Math.max(0, parseInt(el.value, 10) || 0); }
    else if(el.dataset.sbReset !== undefined) sb.slotReset = el.value;
    else if(el.dataset.sbAnybreak !== undefined){ if(sb.recovery){ if(el.checked) sb.recovery.anyBreak = true; else delete sb.recovery.anyBreak; } }
    else if(el.dataset.sbRec !== undefined){ const n = parseInt(el.value, 10); if(n > 0) sb.recovery = Object.assign({ maxSlot: 5 }, sb.recovery || {}, { levels: n }); else delete sb.recovery; }
    else if(el.dataset.sbCon !== undefined){ if(el.value.trim() === '' || isNaN(+el.value)) delete sb.conSave; else sb.conSave = +el.value; }
    c._warnings = validateMonster(c);
    const w = document.getElementById('warn-' + el.dataset.owner); if(w) w.innerHTML = warningsHtml(c, el.dataset.owner);
    refreshPreview();
  };
  grid.addEventListener('change', ev=>{ const el = ev.target; if(el.dataset.sbSlot !== undefined || el.dataset.sbReset !== undefined || el.dataset.sbCon !== undefined || el.dataset.sbRec !== undefined || el.dataset.sbAnybreak !== undefined) onSB(el); });
});

function newAction(type){
  const base = { id: uid(), name: 'New action', actionSlot: 0, freq: 'at will', condition: 'default', targets: 1 };
  return convertType(base, type);
}

function convertType(a, type){
  const keep = { id:a.id, name:a.name, actionSlot:a.actionSlot, freq:a.freq, condition:a.condition, targets:a.targets ?? 1, type };
  if(a.ext){
    const ext = { ...a.ext };
    if(type !== 'atk'){ delete ext.grapple; delete ext.swallow; }
    if(Object.keys(ext).length) keep.ext = ext;
  }
  const oldBuff = a.buff || a.riderEffect?.buff;
  if(type === 'atk'){
    Object.assign(keep, {
      dpr: a.dpr ?? '1d8 + 3',
      toHit: a.toHit ?? (a.type === 'debuff' ? a.saveDC : 5),
      target: VALID_ENEMY_TARGETS.includes(a.target) ? a.target : 'enemy with most HP',
    });
    if(a.type === 'debuff'){ keep.useSaves = true; if(oldBuff) keep.riderEffect = { dc: 99, buff: oldBuff }; }
    else { if(a.useSaves) keep.useSaves = true; if(a.halfOnSave) keep.halfOnSave = true; if(a.riderEffect) keep.riderEffect = a.riderEffect; }
  } else if(type === 'heal'){
    Object.assign(keep, { amount: a.amount ?? '2d8', target: VALID_ALLY_TARGETS.includes(a.target) ? a.target : 'ally with the least HP' });
    if(a.tempHP) keep.tempHP = true;
  } else if(type === 'buff'){
    Object.assign(keep, { target: VALID_ALLY_TARGETS.includes(a.target) ? a.target : 'self', buff: oldBuff || { duration: 'entire encounter', ac: 2 } });
  } else if(type === 'debuff'){
    Object.assign(keep, {
      target: VALID_ENEMY_TARGETS.includes(a.target) ? a.target : 'enemy with most HP',
      saveDC: a.saveDC ?? (a.useSaves && typeof a.toHit === 'number' ? a.toHit : 13),
      buff: oldBuff || { duration: '1 round', condition: 'Frightened' },
    });
    if(keep.buff.duration === 'until next attack made') keep.buff.duration = '1 round';
  }
  return keep;
}

function setPath(obj, path, val){
  const parts = path.split('.');
  let o = obj;
  for(let i=0;i<parts.length-1;i++){
    if(o[parts[i]] === undefined || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  const last = parts[parts.length-1];
  if(val === undefined) delete o[last]; else o[last] = val;
}

function parseVal(raw, kind){
  const t = String(raw).trim();
  switch(kind){
    case 'str': return raw;
    case 'optstr': return t === '' ? undefined : raw;
    case 'num': return t === '' ? 0 : parseFloat(t);
    case 'int': return t === '' ? 1 : Math.max(1, parseInt(t,10) || 1);
    case 'optnum': return t === '' || isNaN(+t) ? undefined : parseFloat(t);
    case 'dice': return t === '' ? '' : (isNaN(+t) ? t : +t);
    case 'optdice': return t === '' ? undefined : (isNaN(+t) ? t : +t);
  }
  return raw;
}

const isSB = key => String(key).endsWith('~sb');
function listOf(key, m){
  if(isSB(key)){ m.ext = m.ext || {}; m.ext.spellbook = m.ext.spellbook || { slots: [0,0,0,0,0,0,0,0,0], spells: [] }; m.ext.spellbook.spells = m.ext.spellbook.spells || []; return m.ext.spellbook.spells; }
  m.actions = m.actions || [];
  return m.actions;
}
function creatureByKey(key){
  key = String(key).replace(/~sb$/, '');
  return key[0] === 'p' ? PARTY_PLAYERS[parseInt(key.slice(1),10)] : encounters[activeIdx].monsters[parseInt(key,10)];
}
function rerenderFor(key){
  if(String(key)[0] === 'p'){ renderParty(); renderPartyBar(); }
  else renderMonsters();
  refreshPreview();
}
function findAction(mi, aid){
  const m = creatureByKey(mi);
  const L = listOf(mi, m);
  const idx = L.findIndex(a=>a.id === aid);
  return { m, idx, a: L[idx], L };
}

function refreshMonsterLive(mi, a){
  const m = creatureByKey(mi);
  m._warnings = validateMonster(m);
  const sum = document.getElementById('ae-sum-'+a.id);
  if(sum) sum.textContent = isSB(mi) ? describeSpell(a) : describeAction(a);
  const dot = document.getElementById('ae-dot-'+a.id);
  if(dot){ const iss = isSB(mi) ? spellIssues(a) : actionIssues(a); dot.innerHTML = iss.length ? `<span class="ae-dot" title="${escapeAttr(iss.join('\n'))}"></span>` : ''; }
  const base = String(mi).replace(/~sb$/, '');
  const w = document.getElementById('warn-'+base);
  if(w) w.innerHTML = warningsHtml(m, base);
  refreshPreview();
}

function handleFieldChange(el){
  const mi = el.dataset.mi, aid = el.dataset.aid, k = el.dataset.k, kind = el.dataset.kind;
  const { m, idx, a, L } = findAction(mi, aid);
  if(!a) return;
  let rerender = !!el.dataset.re;
  if(k === '__type'){
    const sp = isSB(mi) ? { level: a.level, concentration: a.concentration, upcast: a.upcast } : null;
    L[idx] = convertType(a, el.value);
    if(sp){ Object.entries(sp).forEach(([x,v])=>{ if(v !== undefined) L[idx][x] = v; }); delete L[idx].freq; delete L[idx].condition; }
  } else if(k === '__grantsBuff'){
    const t = el.value.trim();
    a.ext = a.ext || {};
    if(t) a.ext.grantsBuff = Object.assign({}, a.ext.grantsBuff || {}, { id: t, name: (a.ext.grantsBuff && a.ext.grantsBuff.name) || a.name }); else delete a.ext.grantsBuff;
  } else if(k.startsWith('__x:')){
    const path = k.slice(4);
    a.ext = a.ext || {};
    if(path === 'wtWhenLosing') setPath(a.ext, 'wtWhen', el.checked ? 'losing' : undefined);
    else setPath(a.ext, path, el.checked ? (path === 'leap' ? { range: 30 } : true) : undefined);
  } else if(k === '__saveOnDamage'){
    a.ext = a.ext || {};
    if(el.value === 'adv') a.ext.saveOnDamage = 'adv'; else if(el.value === 'true') a.ext.saveOnDamage = true; else delete a.ext.saveOnDamage;
  } else if(k === '__saveAb' || k === '__riderSave'){
    const f = k === '__saveAb' ? 'saveAbility' : 'riderSave';
    a.ext = a.ext || {};
    if(el.value) a.ext[f] = el.value; else delete a.ext[f];
    if(!Object.keys(a.ext).length) delete a.ext;
  } else if(k === '__spLevel'){
    a.level = Math.max(0, Math.min(9, parseInt(el.value,10) || 0));
    if(!a.level){ delete a.upcast; delete a.concentration; }
  } else if(k === '__spUpT'){
    const n = parseInt(el.value, 10);
    if(n > 0) a.upcastTargets = n; else delete a.upcastTargets;
  } else if(k === '__spConc'){
    if(el.checked) a.concentration = true; else delete a.concentration;
  } else if(k === '__spUpcast'){
    const t = el.value.trim();
    if(t) a.upcast = t; else delete a.upcast;
  } else if(k === '__targetTypes'){
    const list = el.value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
    a.ext = a.ext || {};
    if(list.length) a.ext.targetTypes = list; else delete a.ext.targetTypes;
  } else if(k === '__freqKind'){
    const v = el.value;
    if(v === 'recharge') a.freq = { reset:'recharge', cooldownRounds: a.freq?.cooldownRounds || 3 };
    else if(v === 'sr' || v === 'lr') a.freq = { reset: v, uses: a.freq?.uses || 1 };
    else a.freq = v;
  } else if(k === 'actionSlot'){
    a.actionSlot = parseInt(el.value, 10);
    L.splice(idx, 1); L.push(a);   // lands at the bottom (lowest priority) of its new slot
  } else if(k === '__grappleOn'){
    a.ext = a.ext || {};
    if(el.checked) a.ext.grapple = { escapeDC: 12, maxSize: 'Medium', restrains: true }; else delete a.ext.grapple;
  } else if(k === '__swallowOn'){
    a.ext = a.ext || {};
    if(el.checked) a.ext.swallow = { maxSize: 'Medium', digest: '2d6', capacity: 1, regurgitate: { threshold: 10, dc: 13 } }; else delete a.ext.swallow;
  } else if(k === '__ambush'){
    a.ext = a.ext || {};
    if(el.checked) a.ext.onlyIfEnemiesSurprised = true; else delete a.ext.onlyIfEnemiesSurprised;
  } else if(k === '__successPct'){
    const t = el.value.trim();
    a.ext = a.ext || {};
    if(t === '' || isNaN(+t)) delete a.ext.successChance; else a.ext.successChance = Math.min(1, Math.max(0, +t/100));
  } else if(k === '__areaShape'){
    a.ext = a.ext || {};
    if(el.value === 'auto') delete a.ext.area;
    else a.ext.area = { shape: el.value, size: (a.ext.area && a.ext.area.size) || { sphere: 20, cone: 15, line: 60, cube: 15, emanation: 10 }[el.value] };
    if(!Object.keys(a.ext).length) delete a.ext;
  } else if(k === '__areaSize'){
    const t = el.value.trim();
    if(a.ext && a.ext.area && t !== '' && !isNaN(+t)) a.ext.area.size = Math.max(5, Math.round(+t / 5) * 5);
  } else if(k === 'ext.grapple.restrains'){
    a.ext.grapple.restrains = el.checked;
  } else if(k === '__riderOn'){
    if(el.checked) a.riderEffect = { dc: 99, buff: { duration: '1 round' } };
    else delete a.riderEffect;
  } else if(k === '__riderSame'){
    a.riderEffect.dc = el.checked ? 99 : 12;
  } else if(kind === 'bool'){
    if(el.checked) a[k] = true; else delete a[k];
  } else if(k === 'condition' || k === 'target' || k.endsWith('.duration')){
    setPath(a, k, el.value);
  } else {
    const val = el.tagName === 'SELECT' && kind === 'num' ? parseInt(el.value,10) : parseVal(el.value, kind);
    setPath(a, k, val);
  }
  const cur = L[idx];
  const prune = o=>{ Object.keys(o).forEach(x=>{ if(o[x] && typeof o[x] === 'object' && !Array.isArray(o[x])){ prune(o[x]); if(!Object.keys(o[x]).length) delete o[x]; } }); };
  if(cur && cur.ext) prune(cur.ext);
  if(cur && cur.ext){
    const r = cur.ext.swallow && cur.ext.swallow.regurgitate;
    if(r){ Object.keys(r).forEach(x=>{ if(r[x]===undefined) delete r[x]; }); if(!Object.keys(r).length) delete cur.ext.swallow.regurgitate; }
    if(!Object.keys(cur.ext).length) delete cur.ext;
  }
  if(rerender){ m._warnings = validateMonster(m); rerenderFor(mi); }
  else refreshMonsterLive(mi, L[idx]);
}

function handleEditorClick(ev){
  const t = ev.target.closest('[data-ae-move],[data-ae-dup],[data-ae-del],[data-ae-add],[data-seg],[data-ae-toggle],[data-json-toggle]');
  if(!t) return;
  const mi = t.dataset.mi;
  const m = creatureByKey(mi);
  if(t.dataset.jsonToggle !== undefined){
    const key = m.id; openJson.has(key) ? openJson.delete(key) : openJson.add(key);
    rerenderFor(mi); return;
  }
  if(t.dataset.aeAdd){
    const a = newAction(t.dataset.aeAdd);
    if(isSB(mi)){ a.level = 1; a.name = 'New spell'; delete a.freq; delete a.condition; }
    listOf(mi, m).push(a); openActions.add(a.id);
  } else if(t.dataset.aeMove){
    const { idx, a, L } = findAction(mi, t.dataset.aid);
    const dir = parseInt(t.dataset.aeMove);
    const same = L.map((x,i)=>[x,i]).filter(([x])=>slotOf(x) === slotOf(a)).map(([,i])=>i);
    const p = same.indexOf(idx), q = p + dir;
    if(q < 0 || q >= same.length) return;
    const j = same[q];
    [L[idx], L[j]] = [L[j], L[idx]];
  } else if(t.dataset.aeDup){
    const { idx, a, L } = findAction(mi, t.dataset.aeDup);
    const copy = JSON.parse(JSON.stringify(a)); copy.id = uid(); if(copy.name) copy.name += ' (copy)';
    L.splice(idx+1, 0, copy); openActions.add(copy.id);
  } else if(t.dataset.aeDel){
    const { idx, a, L } = findAction(mi, t.dataset.aeDel);
    if(!confirm(`Delete "${a.name || 'this action'}"?`)) return;
    L.splice(idx, 1);
  } else if(t.dataset.seg === 'useSaves'){
    const { a } = findAction(mi, t.dataset.aid);
    if(t.dataset.val === '1') a.useSaves = true; else { delete a.useSaves; delete a.halfOnSave; }
  } else if(t.dataset.aeToggle){
    if(ev.target.closest('.ae-tools')) return;
    const id = t.dataset.aeToggle; openActions.has(id) ? openActions.delete(id) : openActions.add(id);
  }
  m._warnings = validateMonster(m);
  rerenderFor(mi);
}

/* ---------- action audit: "when should this fire?" ----------
   The export format uses the first usable action whose condition matches. A lot of statblocks come in
   with everything on "default", which makes creatures re-cast running buffs, heal healthy allies,
   drink potions at full HP or drop an area spell on a lone enemy. Each tip carries a one-click fix
   that only uses conditions the save format accepts. */
function auditActions(c){
  const tips = [];
  (c.actions||[]).forEach(a=>{
    if(!a || a.type === 'template' || a.condition !== 'default' || (a.ext && a.ext.fromSpellbook)) return;
    if(typeof a.actionSlot !== 'number' || a.actionSlot === 4 || a.actionSlot < 0) return;   // reactions and triggers fire on events, not conditions
    if(a.freq === 'at will' && (a.actionSlot === 5 || a.actionSlot === 6)) return;   // free passives cost nothing to re-apply
    const nm = a.name || 'unnamed';
    const lasting = a.buff && (a.buff.duration === 'entire encounter' || a.buff.duration === 'repeat the save each round');
    if((a.type === 'buff' || a.type === 'debuff') && lasting){
      tips.push({ aid:a.id, to:'not used yet', text:`"${nm}" lasts the whole fight but is set to "default", so it gets cast again every turn it's available. Use it once per fight ("not used yet").` });
    } else if(a.type === 'heal' && a.target === 'self'){
      if(a.tempHP) tips.push({ aid:a.id, to:'has no THP', text:`"${nm}" gives temporary HP on "default", so it's used even while the old temp HP is still up. Only use it when out of temp HP ("has no THP").` });
      else tips.push({ aid:a.id, to:'is under half HP', text:`"${nm}" heals itself on "default", so it's used at full HP. Only use it when hurt ("is under half HP").` });
    } else if(a.type === 'heal' && !a.tempHP){
      tips.push({ aid:a.id, to:'ally under half HP', text:`"${nm}" heals on "default", so it's spent on allies who don't need it. Only heal when someone is hurt ("ally under half HP").` });
    } else if(a.type === 'atk' && a.useSaves && (a.targets||1) > 1 && a.freq !== 'at will'){
      tips.push({ aid:a.id, to:'enemy count multiple', text:`"${nm}" hits up to ${a.targets} creatures but is set to "default", so it can be spent on a single enemy. Save it for groups ("enemy count multiple").` });
    }
  });
  return tips;
}
function applyTip(c, aid, to){
  const a = (c.actions||[]).find(x=>x.id === aid);
  if(a && VALID_CONDITIONS.includes(to)) a.condition = to;
}
function tipsHtml(c, key){
  const tips = auditActions(c);
  if(!tips.length || key === undefined) return '';
  return `<div class="tips"><div class="tips-title">✦ ${tips.length} tactics tip${tips.length===1?'':'s'}${tips.length>1?` <button class="mini-btn" data-tipall="${key}">Apply all</button>`:''}</div><ul>${tips.map(t=>`<li>${escapeHtml(t.text)} <button class="mini-btn" data-tipfix="${key}" data-aid="${escapeAttr(t.aid)}" data-to="${escapeAttr(t.to)}">Apply</button></li>`).join('')}</ul></div>`;
}
['monsterGrid','partyGrid'].forEach(gridId=>{
  document.getElementById(gridId).addEventListener('click', ev=>{
    const clr = ev.target.closest('[data-clear-notes]');
    if(clr){ ev.stopPropagation(); const c = creatureByKey(clr.dataset.clearNotes); if(c){ delete c._notes; rerenderFor(clr.dataset.clearNotes); if(typeof scheduleSave === 'function') scheduleSave(); } return; }
    const one = ev.target.closest('[data-tipfix]'), all = ev.target.closest('[data-tipall]');
    if(!one && !all) return;
    ev.stopPropagation();
    const key = (one || all).dataset[one ? 'tipfix' : 'tipall'];
    const c = creatureByKey(key); if(!c) return;
    if(one) applyTip(c, one.dataset.aid, one.dataset.to);
    else auditActions(c).forEach(t=>applyTip(c, t.aid, t.to));
    c._warnings = validateMonster(c);
    rerenderFor(key);
    if(typeof scheduleSave === 'function') scheduleSave();
  });
});

function notesHtml(m, key){
  if(!m._notes || !m._notes.length) return '';
  return `<details class="parse-notes"><summary>${m._notes.length} parser note${m._notes.length===1?'':'s'} — what was assumed or left out</summary><ul>${m._notes.map(n=>`<li>${escapeHtml(n)}</li>`).join('')}</ul>${key !== undefined ? `<button class="mini-btn" data-clear-notes="${escapeAttr(String(key))}">Dismiss</button>` : ''}</details>`;
}
function warningsHtml(m, key){
  const tips = tipsHtml(m, key) + notesHtml(m, key);
  if(!m._warnings || !m._warnings.length) return tips;
  return `<div class="warnings"><div class="warnings-title">⚠ ${m._warnings.length} possible issue${m._warnings.length===1?'':'s'}</div><ul>${m._warnings.map(w=>`<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` + tips;
}


/* ---------- the six saving throws (ext.saves) ----------
   The save format only knows one average "saveBonus". The six real saves live in ext.saves; whenever all six
   are filled in, saveBonus is kept equal to their average so the exported maths stays right. */
const SAVE_ABS = [['str','STR'],['dex','DEX'],['con','CON'],['int','INT'],['wis','WIS'],['cha','CHA']];
function savesField(key, c){
  const sv = (c.ext && c.ext.saves) || {};
  return `<div class="field saves6-field"><label>Saving throws <span class="help" style="text-transform:none;letter-spacing:0;">blank = uses the average save bonus</span></label><div class="saves6">${SAVE_ABS.map(([k,l])=>`<label>${l}<input type="number" data-save="${k}" data-owner="${key}" value="${typeof sv[k] === 'number' ? sv[k] : ''}" placeholder="${c.saveBonus ?? 0}"></label>`).join('')}</div></div>`;
}
['monsterGrid','partyGrid'].forEach(gridId=>{
  document.getElementById(gridId).addEventListener('input', ev=>{
    const el = ev.target; if(el.dataset.save === undefined) return;
    const c = creatureByKey(el.dataset.owner); if(!c) return;
    c.ext = c.ext || {}; c.ext.saves = Object.assign({}, c.ext.saves || {});
    const v = el.value.trim();
    if(v === '' || isNaN(+v)) delete c.ext.saves[el.dataset.save]; else c.ext.saves[el.dataset.save] = +v;
    if(!Object.keys(c.ext.saves).length) delete c.ext.saves;
    if(!Object.keys(c.ext).length) delete c.ext;
    const sv = c.ext && c.ext.saves;
    if(sv && SAVE_ABS.every(([k])=>typeof sv[k] === 'number')){
      c.saveBonus = Math.round(SAVE_ABS.reduce((t,[k])=>t + sv[k], 0) / 6 * 100) / 100;
      const key = String(el.dataset.owner);
      const box = key[0] === 'p' ? document.querySelector(`#partyGrid input[data-pf="saveBonus"][data-pi="${key.slice(1)}"]`) : document.querySelector(`#monsterGrid input[data-f="saveBonus"][data-i="${key}"]`);
      if(box) box.value = c.saveBonus;
    }
    c._warnings = validateMonster(c);
    refreshPreview();
  });
});
const SAVE_OPTS = [['','Average (save bonus)'],['str','Strength'],['dex','Dexterity'],['con','Constitution'],['int','Intelligence'],['wis','Wisdom'],['cha','Charisma']];

function setCreatureExt(c, key, val){
  c.ext = c.ext || {};
  if(val === undefined || val === '' || val === false) delete c.ext[key]; else c.ext[key] = val;
  if(!Object.keys(c.ext).length) delete c.ext;
}
['monsterGrid','partyGrid'].forEach(gridId=>{
  const grid = document.getElementById(gridId);
  const onExt = el=>{
    const c = creatureByKey(el.dataset.owner); if(!c) return;
    const k = el.dataset.ext;
    if(k === 'bonusDisengage'){
      const named = (c.actions||[]).some(a=>a.actionSlot===1&&/cunning action|nimble escape|disengage/i.test(a.name||''));
      c.ext = c.ext || {};
      if(el.checked === named) delete c.ext.bonusDisengage; else c.ext.bonusDisengage = el.checked;   // only store it when it overrides the name
      if(!Object.keys(c.ext).length) delete c.ext;
    }
    else if(k === 'blindsight' || k === 'elvenAccuracy' || k === 'initAdvantage' || k === 'steadyAim' || k === 'packTactics') setCreatureExt(c, k, el.checked || undefined);
    else if(k === 'assassinate'){
      setCreatureExt(c, k, el.checked || undefined);
      if(c.ext && c.ext.sneakAttack){ if(el.checked) c.ext.sneakAttack.assassinate = (c.class && c.class.level) || c.ext.sneakAttack.assassinate || 0; else delete c.ext.sneakAttack.assassinate; }
    }
    else if(k === 'sneakDice'){
      const t = el.value.trim();
      if(!t) setCreatureExt(c, 'sneakAttack', undefined);
      else setCreatureExt(c, 'sneakAttack', Object.assign({}, (c.ext && c.ext.sneakAttack) || {}, { dice: t }, c.ext && c.ext.assassinate ? { assassinate: (c.class && c.class.level) || 0 } : {}));
    }
    else if(k === 'escapeBonus' || k === 'athletics' || k === 'speed' || k === 'initBonus' || k === 'fly' || k === 'climb' || k === 'luck' || k === 'legendaryResistance' || k === 'legendaryActions') setCreatureExt(c, k, el.value.trim() === '' || ((k === 'fly' || k === 'climb' || k === 'luck' || k === 'legendaryResistance') && !(parseFloat(el.value) > 0)) ? undefined : parseFloat(el.value));
    else if(k === 'resist' || k === 'immune' || k === 'vulnerable' || k === 'condImmune'){
      const list = el.value.split(/[,;]/).map(x=>x.trim()).filter(Boolean).map(x=> k === 'condImmune' ? x.charAt(0).toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase());
      setCreatureExt(c, k, list.length ? list : undefined);
    }
    else if(k === 'ai') setCreatureExt(c, k, el.value === 'auto' ? undefined : el.value);
    else setCreatureExt(c, k, el.value === 'Medium' ? undefined : el.value);   // Medium is the default
    c._warnings = validateMonster(c);
    refreshPreview();
  };
  grid.addEventListener('input', ev=>{ if(ev.target.dataset.ext && ev.target.tagName==='INPUT' && ev.target.type!=='checkbox') onExt(ev.target); });
  grid.addEventListener('change', ev=>{ if(ev.target.dataset.ext && (ev.target.tagName==='SELECT' || ev.target.type==='checkbox')) onExt(ev.target); });
});
['monsterGrid','partyGrid'].forEach(function wireEditor(gridId){
  const grid = document.getElementById(gridId);
  grid.addEventListener('click', handleEditorClick);
  grid.addEventListener('input', ev=>{
    const el = ev.target;
    if(el.tagName === 'INPUT' && el.dataset.aid && el.type !== 'checkbox') handleFieldChange(el);
  });
  grid.addEventListener('change', ev=>{
    const el = ev.target;
    if(!el.dataset.aid) return;
    if(el.tagName === 'SELECT' || el.type === 'checkbox') handleFieldChange(el);
  });
});

/* ---------------------------------------------------------
   State
--------------------------------------------------------- */
let encounters = [ freshEncounter() ];
let activeIdx = 0;

function freshEncounter(){
  return { monsters: [], playersSurprised:false, monstersSurprised:false, shortRest:false };
}
function uid(){
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8);
    return v.toString(16);
  });
}

/* ---------------------------------------------------------
   Render: party bar
--------------------------------------------------------- */
function renderPartyBar(){
  const bar = document.getElementById('partyBar');
  bar.innerHTML = PARTY_PLAYERS.map((p,i) =>
    `<div class="chip chip-link" data-chip="${i}" title="Edit ${escapeAttr(p.name)}"><b>${escapeHtml(p.name)}</b> · AC ${p.AC} · ${p.hp} HP · ${escapeHtml(p.class?.type || '')} ${p.class?.level ?? ''}</div>`
  ).join('');
}
document.getElementById('partyBar').addEventListener('click', ev=>{
  const chip = ev.target.closest('[data-chip]');
  if(!chip) return;
  const p = PARTY_PLAYERS[parseInt(chip.dataset.chip,10)];
  if(!p) return;
  if(currentView !== 'forge') document.querySelector('.view-btn[data-view=forge]').click();
  openPlayers.add(p.id);
  renderParty();
  document.getElementById('pcard-'+p.id)?.scrollIntoView({behavior:'smooth', block:'start'});
});

/* ---------------------------------------------------------
   Party editor
--------------------------------------------------------- */
const openPlayers = new Set();
const CLASS_LIST = ['artificer','barbarian','bard','cleric','druid','fighter','monk','paladin','ranger','rogue','sorcerer','warlock','wizard'];

function renderParty(){
  const grid = document.getElementById('partyGrid');
  if(!PARTY_PLAYERS.length){
    grid.innerHTML = `<div class="empty-note">No party members. Add one, or load a day file under Export.</div>`;
    return;
  }
  grid.innerHTML = PARTY_PLAYERS.map((p,i)=>{
    const key = 'p'+i;
    p._warnings = validateMonster(p);
    const open = openPlayers.has(p.id);
    const cls = p.class ? `${p.class.type} ${p.class.level}` : 'no class';
    return `<div class="scroll" id="pcard-${p.id}">
      <div class="scroll-head pc-head" data-ptoggle="${p.id}">
        <div>
          <div class="m-name">${escapeHtml(p.name || 'Unnamed')}${p._warnings.length?'<span class="ae-dot" title="Has issues"></span>':''}</div>
          <div class="m-type">${escapeHtml(cls)} · ${p.hp} HP · AC ${p.AC} · ${(p.actions||[]).length} action${(p.actions||[]).length===1?'':'s'}${p.count>1?` · ×${p.count}`:''}</div>
        </div>
        <div class="pc-chev">${open?'▾':'▸'}</div>
      </div>
      ${open ? `
      <div class="m-fields">
        <div class="field"><label>Name</label><input data-pf="name" data-pi="${i}" value="${escapeAttr(p.name||'')}"></div>
        <div class="field"><label>Class</label><select data-pf="class.type" data-pi="${i}">${CLASS_LIST.map(c=>`<option ${p.class?.type===c?'selected':''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Level</label><input data-pf="class.level" data-pi="${i}" type="number" min="1" max="20" value="${p.class?.level ?? 1}"></div>
        <div class="field"><label>Count</label><input data-pf="count" data-pi="${i}" type="number" min="1" value="${p.count ?? 1}"></div>
        <div class="field"><label>HP</label><input data-pf="hp" data-pi="${i}" type="number" value="${p.hp ?? 0}"></div>
        <div class="field"><label>AC</label><input data-pf="AC" data-pi="${i}" type="number" value="${p.AC ?? 0}"></div>
        <div class="field"><label>Save Bonus</label><input data-pf="saveBonus" data-pi="${i}" type="number" step="0.01" value="${p.saveBonus ?? 0}" title="Average of all six saves"></div>
        <div class="field"><label>Size</label><select data-ext="size" data-owner="p${i}">${['Tiny','Small','Medium','Large','Huge','Gargantuan'].map(z=>`<option ${((p.ext&&p.ext.size)||'Medium')===z?'selected':''}>${z}</option>`).join('')}</select></div>
        <div class="field"><label>Escape bonus</label><input data-ext="escapeBonus" data-owner="p${i}" type="number" placeholder="= save bonus" value="${(p.ext&&p.ext.escapeBonus!==undefined)?p.ext.escapeBonus:''}" title="Athletics/Acrobatics bonus used to break grapples (and to climb, if Athletics is blank). Blank = save bonus."></div>
        <div class="field"><label>Senses</label><label class="ae-check" style="margin-top:4px;"><input type="checkbox" data-ext="blindsight" data-owner="p${i}" ${(p.ext&&p.ext.blindsight)?'checked':''}> Blindsight</label></div>
        <div class="field"><label>Feats</label><label class="ae-check" style="margin-top:4px;" title="Advantage rolls three d20s instead of two (raises hit and crit chance). Only for Dex/Int/Wis/Cha attackers."><input type="checkbox" data-ext="elvenAccuracy" data-owner="p${i}" ${(p.ext&&p.ext.elvenAccuracy)?'checked':''}> Elven Accuracy</label></div>
        <div class="field"><label>Speed (ft)</label><input data-ext="speed" data-owner="p${i}" type="number" step="5" min="0" placeholder="30" value="${(p.ext&&p.ext.speed!==undefined)?p.ext.speed:''}" title="Used by the War Table. Blank = 30 ft."></div>
        <div class="field"><label>Sneak Attack</label><input data-ext="sneakDice" data-owner="p${i}" placeholder="e.g. 2d6" value="${(p.ext&&p.ext.sneakAttack&&p.ext.sneakAttack.dice)||''}" title="Once per turn, on a hit with a Sneak-Attack-able weapon, with advantage or an ally next to the target. War Table."></div>
        <div class="field"><label>Rogue tricks</label><label class="ae-check" style="margin-top:4px;" title="Advantage on attacks against creatures that haven't taken a turn yet, and +rogue level damage on a round-1 Sneak Attack"><input type="checkbox" data-ext="assassinate" data-owner="p${i}" ${(p.ext&&p.ext.assassinate)?'checked':''}> Assassinate</label><label class="ae-check" title="Bonus action: advantage on the next attack this turn if it hasn't moved"><input type="checkbox" data-ext="steadyAim" data-owner="p${i}" ${(p.ext&&p.ext.steadyAim)?'checked':''}> Steady Aim</label></div>
        <div class="field"><label>Fly (ft)</label><input data-ext="fly" data-owner="p${i}" type="number" step="5" min="0" placeholder="—" value="${(p.ext&&p.ext.fly!==undefined)?p.ext.fly:''}" title="Fly speed. Flyers ignore difficult ground, low cover and climbing, and can reach creatures on high ground."></div>
        <div class="field"><label>Climb (ft)</label><input data-ext="climb" data-owner="p${i}" type="number" step="5" min="0" placeholder="—" value="${(p.ext&&p.ext.climb!==undefined)?p.ext.climb:''}" title="Climb speed. Scales ledges of 10 ft or more with no Athletics check and no extra movement (War Table)."></div>
        <div class="field"><label>Athletics</label><input data-ext="athletics" data-owner="p${i}" type="number" placeholder="= escape bonus" value="${(p.ext&&p.ext.athletics!==undefined)?p.ext.athletics:''}" title="Athletics bonus for climbing ledges of 10 ft or more on the War Table. Blank = the escape bonus."></div>
        <div class="field"><label>Resistances</label><input data-ext="resist" data-owner="p${i}" type="text" placeholder="—" value="${escapeHtml(((p.ext&&p.ext.resist)||[]).join(', '))}" title="Damage types it takes half from, comma-separated: fire, cold, nonmagical slashing (War Table)"></div>
        <div class="field"><label>Immunities</label><input data-ext="immune" data-owner="p${i}" type="text" placeholder="—" value="${escapeHtml(((p.ext&&p.ext.immune)||[]).join(', '))}" title="Damage types it takes nothing from: poison, fire (War Table)"></div>
        <div class="field"><label>Vulnerabilities</label><input data-ext="vulnerable" data-owner="p${i}" type="text" placeholder="—" value="${escapeHtml(((p.ext&&p.ext.vulnerable)||[]).join(', '))}" title="Damage types it takes double from (War Table)"></div>
        <div class="field"><label>Condition immunities</label><input data-ext="condImmune" data-owner="p${i}" type="text" placeholder="—" value="${escapeHtml(((p.ext&&p.ext.condImmune)||[]).join(', '))}" title="Conditions it can&#39;t be given: Frightened, Poisoned, Restrained (War Table)"></div>
        <div class="field"><label>Luck points</label><input data-ext="luck" data-owner="p${i}" type="number" step="1" min="0" placeholder="—" value="${(p.ext&&p.ext.luck!==undefined)?p.ext.luck:''}" title="Lucky feat: points per long rest. The War Table spends them to reroll a hit against it or a failed save that matters."></div>
        <div class="field"><label>Legendary resist.</label><input data-ext="legendaryResistance" data-owner="p${i}" type="number" step="1" min="0" placeholder="—" value="${(p.ext&&p.ext.legendaryResistance!==undefined)?p.ext.legendaryResistance:''}" title="Legendary Resistance uses per day. The War Table spends them to turn failed saves that matter (disabling conditions, big damage) into successes."></div>
        <div class="field"><label>Legendary actions</label><input data-ext="legendaryActions" data-owner="p${i}" type="number" step="1" min="0" placeholder="3" value="${(p.ext&&p.ext.legendaryActions!==undefined)?p.ext.legendaryActions:''}" title="Legendary actions per round on the War Table (spent after other creatures\' turns). The export counts one per round."></div>
        ${savesField('p'+i, p)}
        <div class="field"><label>Initiative</label><input data-ext="initBonus" data-owner="p${i}" type="number" placeholder="+0" value="${(p.ext&&p.ext.initBonus!==undefined)?p.ext.initBonus:''}" title="Initiative bonus, used by the War Table."></div>
        <div class="field"><label>Init. advantage</label><label class="ae-check" style="margin-top:4px;"><input type="checkbox" data-ext="initAdvantage" data-owner="p${i}" ${(p.ext&&p.ext.initAdvantage)?'checked':''}> Rolls with adv.</label></div>
        <div class="field"><label>Mobility</label><label class="ae-check" style="margin-top:4px;" title="Can Disengage as a bonus action (Cunning Action, Nimble Escape…). Detected automatically from a bonus action with one of those names."><input type="checkbox" data-ext="bonusDisengage" data-owner="p${i}" ${((p.ext&&p.ext.bonusDisengage===true) || (!(p.ext&&p.ext.bonusDisengage===false) && (p.actions||[]).some(a=>a.actionSlot===1&&/cunning action|nimble escape|disengage/i.test(a.name||''))))?'checked':''}> Bonus Disengage</label></div>
        <div class="field"><label>War Table AI</label><select data-ext="ai" data-owner="p${i}" title="How it fights on the War Table">${[['auto','Auto (party setting)'],['regular','Regular'],['tactical','Tactical'],['beast','Beast']].map(([v,l])=>`<option value="${v}" ${(((p.ext&&p.ext.ai)||'auto')===v)?'selected':''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="team-label" style="margin-top:4px;">Actions</div>
      ${actionEditor(key, p)}
      ${spellbookPanel(key, p)}
      <div class="actions-toggle" data-json-toggle="1" data-mi="${key}" style="margin-top:10px;">${openJson.has(p.id)?'▾':'▸'} Advanced: edit raw JSON</div>
      ${openJson.has(p.id) ? `<div class="actions-json">
        <textarea data-pactions="${i}">${escapeHtml(JSON.stringify(p.actions||[], null, 2))}</textarea>
        <div class="row-btns"><button class="mini-btn" data-papply="${i}">Apply Edits</button></div>
      </div>` : ''}
      <div id="warn-${key}">${warningsHtml(p, key)}</div>
      <div class="row-btns">
        <button class="mini-btn" data-pdup="${i}">Duplicate</button>
        <button class="mini-btn danger" data-premove="${i}">Remove</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

(function wireParty(){
  const grid = document.getElementById('partyGrid');
  const onField = el=>{
    const i = parseInt(el.dataset.pi,10), f = el.dataset.pf, p = PARTY_PLAYERS[i];
    if(!p) return;
    if(f === 'class.type'){ p.class = p.class || { level:1, options:{} }; p.class.type = el.value; p.class.options = p.class.options || {}; }
    else if(f === 'class.level'){ p.class = p.class || { type:'fighter', options:{} }; p.class.level = Math.max(1, parseInt(el.value,10) || 1); }
    else if(['count','hp','AC','saveBonus'].includes(f)) p[f] = el.value === '' ? 0 : parseFloat(el.value);
    else p[f] = el.value;
    p._warnings = validateMonster(p);
    const w = document.getElementById('warn-p'+i); if(w) w.innerHTML = warningsHtml(p, 'p'+i);
    renderPartyBar();
    refreshPreview();
  };
  grid.addEventListener('input', ev=>{ if(ev.target.dataset.pf && ev.target.tagName === 'INPUT') onField(ev.target); });
  grid.addEventListener('change', ev=>{ if(ev.target.dataset.pf && ev.target.tagName === 'SELECT'){ onField(ev.target); renderParty(); } });
  grid.addEventListener('click', ev=>{
    const t = ev.target;
    const tog = t.closest('[data-ptoggle]');
    if(tog){ const id = tog.dataset.ptoggle; openPlayers.has(id) ? openPlayers.delete(id) : openPlayers.add(id); renderParty(); return; }
    if(t.dataset.premove !== undefined){
      const i = parseInt(t.dataset.premove,10);
      if(!confirm(`Remove ${PARTY_PLAYERS[i].name} from the party?`)) return;
      PARTY_PLAYERS.splice(i,1); renderParty(); renderPartyBar(); refreshPreview(); return;
    }
    if(t.dataset.pdup !== undefined){
      const i = parseInt(t.dataset.pdup,10);
      const c = JSON.parse(JSON.stringify(stripInternal(PARTY_PLAYERS[i])));
      c.id = uid(); c.name += ' (copy)'; (c.actions||[]).forEach(a=>a.id = uid());
      PARTY_PLAYERS.splice(i+1, 0, c); openPlayers.add(c.id);
      renderParty(); renderPartyBar(); refreshPreview(); return;
    }
    if(t.dataset.papply !== undefined){
      const i = parseInt(t.dataset.papply,10);
      const ta = grid.querySelector(`textarea[data-pactions="${i}"]`);
      try{
        const parsed = JSON.parse(ta.value);
        parsed.forEach(a=>{ if(!a.id) a.id = uid(); });
        PARTY_PLAYERS[i].actions = parsed;
        renderParty(); renderPartyBar(); refreshPreview();
      }catch(e){ alert('That actions JSON is invalid — fix the syntax and try again.'); }
    }
  });
  document.getElementById('addPlayerBtn').addEventListener('click', ()=>{
    const p = { id: uid(), mode:'custom', class:{ type:'fighter', level:4, options:{} }, name:'New Adventurer', count:1, hp:30, AC:15, saveBonus:2,
      actions:[ { ...newAction('atk'), name:'Weapon Attack', dpr:'1d8 + 3', toHit:5, target:'enemy with least HP' } ] };
    PARTY_PLAYERS.push(p); openPlayers.add(p.id);
    renderParty(); renderPartyBar(); refreshPreview();
    document.getElementById('pcard-'+p.id)?.scrollIntoView({behavior:'smooth', block:'start'});
  });
})();

/* ---------------------------------------------------------
   Render: tabs + options
--------------------------------------------------------- */
function renderTabs(){
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = encounters.map((e,i) =>
    `<div class="tab ${i===activeIdx?'active':''}" data-i="${i}">
       Encounter ${i+1}
       ${encounters.length>1 ? `<span class="rm" data-rm="${i}">✕</span>` : ''}
     </div>`
  ).join('') + `<div class="tab-add" id="addEncounter">+ New Encounter</div>`;

  tabs.querySelectorAll('.tab').forEach(el=>{
    el.addEventListener('click', (ev)=>{
      if(ev.target.dataset.rm !== undefined && ev.target.classList.contains('rm')) return;
      activeIdx = parseInt(el.dataset.i);
      renderAll();
    });
  });
  tabs.querySelectorAll('.rm').forEach(el=>{
    el.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const idx = parseInt(el.dataset.rm);
      encounters.splice(idx,1);
      if(activeIdx >= encounters.length) activeIdx = encounters.length-1;
      renderAll();
    });
  });
  document.getElementById('addEncounter').addEventListener('click', ()=>{
    encounters.push(freshEncounter());
    activeIdx = encounters.length-1;
    renderAll();
  });

  const opts = document.getElementById('encounterOpts');
  const enc = encounters[activeIdx];
  opts.innerHTML = `
    <label><input type="checkbox" id="optPS" ${enc.playersSurprised?'checked':''}> Players surprised</label>
    <label><input type="checkbox" id="optMS" ${enc.monstersSurprised?'checked':''}> Monsters surprised</label>
    <label><input type="checkbox" id="optSR" ${enc.shortRest?'checked':''}> Short rest before this encounter</label>
  `;
  document.getElementById('optPS').addEventListener('change', e=>{ enc.playersSurprised = e.target.checked; refreshPreview(); });
  document.getElementById('optMS').addEventListener('change', e=>{ enc.monstersSurprised = e.target.checked; refreshPreview(); });
  document.getElementById('optSR').addEventListener('change', e=>{ enc.shortRest = e.target.checked; refreshPreview(); });
}

/* ---------------------------------------------------------
   Render: monster cards
--------------------------------------------------------- */
function renderMonsters(){
  const grid = document.getElementById('monsterGrid');
  const enc = encounters[activeIdx];
  if(enc.monsters.length === 0){
    grid.innerHTML = `<div class="empty-note">No monsters in this encounter yet. Paste a statblock below to forge one.</div>`;
    return;
  }
  grid.innerHTML = enc.monsters.map((m,i)=>{
    const crLabel = (m.cr ?? '?').toString();
    return `
    <div class="scroll" data-i="${i}">
      <div class="scroll-head">
        <div>
          <div class="m-name">${escapeHtml(m.name || 'Unnamed')}</div>
          <div class="m-type">${escapeHtml(m.type||'')} · CR ${escapeHtml(crLabel)}</div>
        </div>
        <div class="seal">${escapeHtml(crLabel)}</div>
      </div>
      <div class="m-fields">
        <div class="field"><label>Name</label><input data-f="name" data-i="${i}" value="${escapeAttr(m.name||'')}"></div>
        <div class="field"><label>Count</label><input data-f="count" data-i="${i}" type="number" min="1" value="${m.count ?? 1}"></div>
        <div class="field"><label>HP</label><input data-f="hp" data-i="${i}" type="number" value="${m.hp ?? 0}"></div>
        <div class="field"><label>AC</label><input data-f="AC" data-i="${i}" type="number" value="${m.AC ?? 0}"></div>
        <div class="field"><label>Save Bonus</label><input data-f="saveBonus" data-i="${i}" type="number" value="${m.saveBonus ?? 0}"></div>
        <div class="field"><label>CR</label><input data-f="cr" data-i="${i}" value="${escapeAttr(m.cr||'')}"></div>
        <div class="field"><label>Type</label><input data-f="type" data-i="${i}" value="${escapeAttr(m.type||'')}"></div>
        <div class="field"><label>Source</label><input data-f="src" data-i="${i}" value="${escapeAttr(m.src||'')}"></div>
        <div class="field"><label>Size</label><select data-ext="size" data-owner="${i}">${['Tiny','Small','Medium','Large','Huge','Gargantuan'].map(z=>`<option ${((m.ext&&m.ext.size)||'Medium')===z?'selected':''}>${z}</option>`).join('')}</select></div>
        <div class="field"><label>Escape bonus</label><input data-ext="escapeBonus" data-owner="${i}" type="number" placeholder="= save bonus" value="${(m.ext&&m.ext.escapeBonus!==undefined)?m.ext.escapeBonus:''}" title="Athletics/Acrobatics bonus used to break grapples (and to climb, if Athletics is blank). Blank = save bonus."></div>
        <div class="field"><label>Senses</label><label class="ae-check" style="margin-top:4px;"><input type="checkbox" data-ext="blindsight" data-owner="${i}" ${(m.ext&&m.ext.blindsight)?'checked':''}> Blindsight</label></div>
        <div class="field"><label>Feats</label><label class="ae-check" style="margin-top:4px;" title="Advantage rolls three d20s instead of two (raises hit and crit chance). Only for Dex/Int/Wis/Cha attackers."><input type="checkbox" data-ext="elvenAccuracy" data-owner="${i}" ${(m.ext&&m.ext.elvenAccuracy)?'checked':''}> Elven Accuracy</label></div>
        <div class="field"><label>Speed (ft)</label><input data-ext="speed" data-owner="${i}" type="number" step="5" min="0" placeholder="30" value="${(m.ext&&m.ext.speed!==undefined)?m.ext.speed:''}" title="Used by the War Table. Blank = 30 ft."></div>
        <div class="field"><label>Sneak Attack</label><input data-ext="sneakDice" data-owner="${i}" placeholder="e.g. 2d6" value="${(m.ext&&m.ext.sneakAttack&&m.ext.sneakAttack.dice)||''}" title="Once per turn, on a hit with a Sneak-Attack-able weapon, with advantage or an ally next to the target. War Table."></div>
        <div class="field"><label>Rogue tricks</label><label class="ae-check" style="margin-top:4px;" title="Advantage on attacks against creatures that haven't taken a turn yet, and +rogue level damage on a round-1 Sneak Attack"><input type="checkbox" data-ext="assassinate" data-owner="${i}" ${(m.ext&&m.ext.assassinate)?'checked':''}> Assassinate</label><label class="ae-check" title="Bonus action: advantage on the next attack this turn if it hasn't moved"><input type="checkbox" data-ext="steadyAim" data-owner="${i}" ${(m.ext&&m.ext.steadyAim)?'checked':''}> Steady Aim</label></div>
        <div class="field"><label>Fly (ft)</label><input data-ext="fly" data-owner="${i}" type="number" step="5" min="0" placeholder="—" value="${(m.ext&&m.ext.fly!==undefined)?m.ext.fly:''}" title="Fly speed. Flyers ignore difficult ground, low cover and climbing, and can reach creatures on high ground."></div>
        <div class="field"><label>Climb (ft)</label><input data-ext="climb" data-owner="${i}" type="number" step="5" min="0" placeholder="—" value="${(m.ext&&m.ext.climb!==undefined)?m.ext.climb:''}" title="Climb speed. Scales ledges of 10 ft or more with no Athletics check and no extra movement (War Table)."></div>
        <div class="field"><label>Athletics</label><input data-ext="athletics" data-owner="${i}" type="number" placeholder="= escape bonus" value="${(m.ext&&m.ext.athletics!==undefined)?m.ext.athletics:''}" title="Athletics bonus for climbing ledges of 10 ft or more on the War Table. Blank = the escape bonus."></div>
        <div class="field"><label>Resistances</label><input data-ext="resist" data-owner="${i}" type="text" placeholder="—" value="${escapeHtml(((m.ext&&m.ext.resist)||[]).join(', '))}" title="Damage types it takes half from, comma-separated: fire, cold, nonmagical slashing (War Table)"></div>
        <div class="field"><label>Immunities</label><input data-ext="immune" data-owner="${i}" type="text" placeholder="—" value="${escapeHtml(((m.ext&&m.ext.immune)||[]).join(', '))}" title="Damage types it takes nothing from: poison, fire (War Table)"></div>
        <div class="field"><label>Vulnerabilities</label><input data-ext="vulnerable" data-owner="${i}" type="text" placeholder="—" value="${escapeHtml(((m.ext&&m.ext.vulnerable)||[]).join(', '))}" title="Damage types it takes double from (War Table)"></div>
        <div class="field"><label>Condition immunities</label><input data-ext="condImmune" data-owner="${i}" type="text" placeholder="—" value="${escapeHtml(((m.ext&&m.ext.condImmune)||[]).join(', '))}" title="Conditions it can&#39;t be given: Frightened, Poisoned, Restrained (War Table)"></div>
        <div class="field"><label>Luck points</label><input data-ext="luck" data-owner="${i}" type="number" step="1" min="0" placeholder="—" value="${(m.ext&&m.ext.luck!==undefined)?m.ext.luck:''}" title="Lucky feat: points per long rest. The War Table spends them to reroll a hit against it or a failed save that matters."></div>
        <div class="field"><label>Legendary resist.</label><input data-ext="legendaryResistance" data-owner="${i}" type="number" step="1" min="0" placeholder="—" value="${(m.ext&&m.ext.legendaryResistance!==undefined)?m.ext.legendaryResistance:''}" title="Legendary Resistance uses per day. The War Table spends them to turn failed saves that matter (disabling conditions, big damage) into successes."></div>
        <div class="field"><label>Legendary actions</label><input data-ext="legendaryActions" data-owner="${i}" type="number" step="1" min="0" placeholder="3" value="${(m.ext&&m.ext.legendaryActions!==undefined)?m.ext.legendaryActions:''}" title="Legendary actions per round on the War Table (spent after other creatures\' turns). The export counts one per round."></div>
        ${savesField(String(i), m)}
        <div class="field"><label>Initiative</label><input data-ext="initBonus" data-owner="${i}" type="number" placeholder="+0" value="${(m.ext&&m.ext.initBonus!==undefined)?m.ext.initBonus:''}" title="Initiative bonus, used by the War Table."></div>
        <div class="field"><label>Init. advantage</label><label class="ae-check" style="margin-top:4px;"><input type="checkbox" data-ext="initAdvantage" data-owner="${i}" ${(m.ext&&m.ext.initAdvantage)?'checked':''}> Rolls with adv.</label></div>
        <div class="field"><label>Pack Tactics</label><label class="ae-check" style="margin-top:4px;" title="War Table: advantage on attacks against a creature that has one of its allies (not incapacitated) within 5 ft"><input type="checkbox" data-ext="packTactics" data-owner="${i}" ${(m.ext&&m.ext.packTactics)?'checked':''}> Adv. with an ally close</label></div>
        <div class="field"><label>Mobility</label><label class="ae-check" style="margin-top:4px;" title="Can Disengage as a bonus action (Cunning Action, Nimble Escape…). Detected automatically from a bonus action with one of those names."><input type="checkbox" data-ext="bonusDisengage" data-owner="${i}" ${((m.ext&&m.ext.bonusDisengage===true) || (!(m.ext&&m.ext.bonusDisengage===false) && (m.actions||[]).some(a=>a.actionSlot===1&&/cunning action|nimble escape|disengage/i.test(a.name||''))))?'checked':''}> Bonus Disengage</label></div>
        <div class="field"><label>War Table AI</label><select data-ext="ai" data-owner="${i}" title="How it fights on the War Table">${[['auto','Auto (by type)'],['regular','Regular'],['tactical','Tactical'],['beast','Beast']].map(([v,l])=>`<option value="${v}" ${(((m.ext&&m.ext.ai)||'auto')===v)?'selected':''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="team-label" style="margin-top:4px;">Actions</div>
      ${actionEditor(i, m)}
      ${spellbookPanel(String(i), m)}
      <div class="actions-toggle" data-json-toggle="1" data-mi="${i}" style="margin-top:10px;">${openJson.has(m.id)?'▾':'▸'} Advanced: edit raw JSON</div>
      ${openJson.has(m.id) ? `<div class="actions-json">
        <textarea data-actions="${i}">${escapeHtml(JSON.stringify(m.actions||[], null, 2))}</textarea>
        <div class="row-btns"><button class="mini-btn" data-apply="${i}">Apply Edits</button></div>
      </div>` : ''}
      <div id="warn-${i}">${warningsHtml(m, i)}</div>
      <div class="row-btns">
        <button class="mini-btn" data-revalidate="${i}">Re-check Schema</button>
        <button class="mini-btn danger" data-remove="${i}">Remove Monster</button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('input[data-f]').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const i = parseInt(inp.dataset.i), f = inp.dataset.f;
      const m = enc.monsters[i];
      if(['count','hp','AC','saveBonus'].includes(f)){
        m[f] = inp.value === '' ? 0 : parseFloat(inp.value);
      } else {
        m[f] = inp.value;
      }
      m._warnings = validateMonster(m);
      refreshPreview();
    });
  });
  grid.querySelectorAll('[data-apply]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const i = parseInt(btn.dataset.apply);
      const ta = grid.querySelector(`textarea[data-actions="${i}"]`);
      try{
        const parsed = JSON.parse(ta.value);
        parsed.forEach(a=>{ if(!a.id) a.id = uid(); });
        enc.monsters[i].actions = parsed;
        enc.monsters[i]._warnings = validateMonster(enc.monsters[i]);
        const wc = enc.monsters[i]._warnings.length;
        setStatus('parseStatus', wc ? `Actions updated for ${enc.monsters[i].name} — ${wc} issue${wc===1?'':'s'} flagged.` : `Actions updated for ${enc.monsters[i].name}. No schema issues found.`, wc ? 'err' : 'ok');
        renderMonsters();
        refreshPreview();
      }catch(err){
        setStatus('parseStatus', 'That actions JSON is invalid — fix the syntax and try again.', 'err');
      }
    });
  });
  grid.querySelectorAll('[data-revalidate]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const i = parseInt(btn.dataset.revalidate);
      enc.monsters[i]._warnings = validateMonster(enc.monsters[i]);
      renderMonsters();
    });
  });
  grid.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const i = parseInt(btn.dataset.remove);
      enc.monsters.splice(i,1);
      renderMonsters();
      refreshPreview();
    });
  });
}

/* ---------------------------------------------------------
   Parse statblocks via Claude API
--------------------------------------------------------- */
/* Where the request goes: inside a Claude artifact the page can call the API without a key;
   anywhere else (GitHub Pages, a local copy) it needs the user's own Anthropic API key, which is kept
   only in this browser's localStorage and sent only to api.anthropic.com. */
const API_KEY_STORE = 'forge-anthropic-key', API_MODEL_STORE = 'forge-anthropic-model', API_USE_STORE = 'forge-use-claude';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
function lsGet(k){ try{ return localStorage.getItem(k) || ''; }catch(e){ return ''; } }
function lsSet(k, v){ try{ if(v) localStorage.setItem(k, v); else localStorage.removeItem(k); }catch(e){} }
(function initApiSettings(){
  const key = document.getElementById('apiKeyInput'), model = document.getElementById('apiModelInput');
  if(!key || !model) return;
  key.value = lsGet(API_KEY_STORE);
  const use = document.getElementById('useClaudeInput');
  if(use){ use.checked = lsGet(API_USE_STORE) === '1' && !!key.value; use.addEventListener('change', ()=>{ if(use.checked && !key.value.trim()){ use.checked = false; setStatus('parseStatus', 'Add an API key first to convert with Claude.', 'err'); } lsSet(API_USE_STORE, use.checked ? '1' : ''); }); }
  model.value = lsGet(API_MODEL_STORE) || DEFAULT_MODEL;
  key.addEventListener('change', ()=>{ lsSet(API_KEY_STORE, key.value.trim()); setStatus('parseStatus', key.value.trim() ? 'API key saved in this browser.' : 'API key removed.', 'ok'); });
  model.addEventListener('change', ()=>lsSet(API_MODEL_STORE, model.value.trim()));

})();

/* Split pasted text into separate statblocks on lines of dashes, so each one is its own request
   (long multi-monster pastes no longer run out of room in a single answer). */
function splitStatblocks(text){
  return text.split(/\n\s*-{3,}\s*\n/).map(t=>t.trim()).filter(t=>t.length > 0);
}

async function forgeOne(text){
  const key = lsGet(API_KEY_STORE);
  const headers = { 'Content-Type': 'application/json' };
  if(key){ headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-dangerous-direct-browser-access'] = 'true'; }
  let res;
  try{
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ model: lsGet(API_MODEL_STORE) || DEFAULT_MODEL, max_tokens: 16000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: text }] })
    });
  }catch(err){
    throw new Error(key ? "Couldn't reach the Anthropic API (network or browser blocked the request)." : 'This copy of the site needs an Anthropic API key — add one under "API key" below the box.');
  }
  let data = null;
  try{ data = await res.json(); }catch(e){}
  if(!res.ok || (data && data.type === 'error')){
    const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
    if(res.status === 401 || res.status === 403) throw new Error(key ? `The API key was refused (${msg}).` : 'This copy of the site needs an Anthropic API key — add one under "API key" below the box.');
    throw new Error(`The API returned an error: ${msg}`);
  }
  const out = (data.content || []).filter(b=>b.type === 'text').map(b=>b.text).join('\n');
  if(data.stop_reason === 'max_tokens') throw new Error('The statblock was too long to convert in one go — split it with a line of --- between monsters, or trim lore text.');
  let clean = out.replace(/```json/gi, '').replace(/```/g, '').trim();
  const fb = clean.indexOf('['), lb = clean.lastIndexOf(']'), fo = clean.indexOf('{'), lo = clean.lastIndexOf('}');
  if(fb !== -1 && lb > fb && (fo === -1 || fb < fo)) clean = clean.slice(fb, lb + 1);
  else if(fo !== -1 && lo > fo) clean = clean.slice(fo, lo + 1);
  let parsed;
  try{ parsed = JSON.parse(clean); }
  catch(e){
    try{ parsed = JSON.parse(clean.replace(/,\s*([\]}])/g, '$1')); }      // trailing commas
    catch(e2){ throw new Error('The AI answered, but not with valid JSON (' + e.message + ').'); }
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function finishParsed(monsters){
  monsters.forEach(m=>{
    m.id = uid();
    m.mode = 'custom';
    if(!m.count) m.count = 1;
    sanitizeMonster(m);
    (m.actions||[]).forEach(a=>{ a.id = uid(); });
    if(m.ext && m.ext.spellbook) (m.ext.spellbook.spells||[]).forEach(sp=>{ sp.id = uid(); });
    m._warnings = validateMonster(m);
  });
  return monsters;
}
document.getElementById('parseBtn').addEventListener('click', async ()=>{
  const input = document.getElementById('statblockInput');
  const text = input.value.trim();
  if(!text){
    setStatus('parseStatus', 'Paste a statblock first.', 'err');
    return;
  }
  const btn = document.getElementById('parseBtn');
  const useClaude = document.getElementById('useClaudeInput') && document.getElementById('useClaudeInput').checked;
  let monsters = [], failed = [];
  btn.disabled = true;
  if(!useClaude){
    // built-in parser: instant, offline, free
    if(typeof StatblockParser === 'undefined'){
      setStatus('parseStatus', "The statblock reader didn't load in this browser. Refresh the page (Ctrl+Shift+R, or Cmd+Shift+R on a Mac); if it still fails, update the browser.", 'err');
      btn.disabled = false;
      return;
    }
    try{
      const r = StatblockParser.parse(text);
      monsters = r.monsters;
      failed = r.skipped.map(msg=>({ err: new Error(msg), b: '' }));
    }catch(err){
      console.error(err);
      failed = [{ err, b: text }];
    }
  } else {
    const blocks = splitStatblocks(text);
    document.getElementById('parseStatus').className = 'status';
    document.getElementById('parseStatus').innerHTML = `<span class="spinner"></span>Asking Claude${blocks.length > 1 ? ` about ${blocks.length} statblocks` : ''}...`;
    const results = await Promise.all(blocks.map((b, i)=>
      new Promise(r=>setTimeout(r, i * 400)).then(()=>forgeOne(b)).then(ms=>({ ok: true, ms }), err=>({ ok: false, err, b }))));
    results.forEach(r=>{ if(r.ok) monsters.push(...r.ms); else failed.push(r); });
    failed.forEach(f=>console.error(f.err));
  }
  finishParsed(monsters);
  if(monsters.length) encounters[activeIdx].monsters.push(...monsters);
  // keep only what failed in the box, so it can be retried
  input.value = useClaude ? failed.map(f=>f.b).join('\n\n---\n\n') : (monsters.length ? '' : input.value);

  const totalWarnings = monsters.reduce((sum,m)=>sum+m._warnings.length,0);
  const totalNotes = monsters.reduce((sum,m)=>sum+((m._notes||[]).length),0);
  const parts = [];
  if(monsters.length) parts.push(`Added ${monsters.length} creature${monsters.length===1?'':'s'}: ${monsters.map(m=>escapeHtml(m.name || '?')).join(', ')}.` + (totalWarnings ? ` ${totalWarnings} possible schema issue${totalWarnings===1?'':'s'} flagged.` : '') + (totalNotes ? ` Check the parser notes on the card${monsters.length===1?'':'s'}.` : ''));
  if(failed.length) parts.push(`${failed.length} statblock${failed.length===1?'':'s'} couldn't be converted: ${escapeHtml(failed[0].err.message || String(failed[0].err))}`);
  if(!monsters.length && !failed.length) parts.push("Couldn't find a statblock in that text.");
  setStatus('parseStatus', parts.join(' '), failed.length || totalWarnings || !monsters.length ? 'err' : 'ok');
  if(monsters.length){ renderMonsters(); refreshPreview(); }
  btn.disabled = false;
});

function setStatus(id, html, cls){
  const el = document.getElementById(id);
  el.className = 'status' + (cls ? ' '+cls : '');
  el.innerHTML = html;
}

/* ---------------------------------------------------------
   Export
--------------------------------------------------------- */
function stripInternal(m){
  const { _warnings, _notes, ...clean } = m;
  return clean;
}

function buildDayObject(){
  return {
    updated: Date.now(),
    name: document.getElementById('dayNameInput').value || 'Adventuring Day',
    players: PARTY_PLAYERS.map(exportCreature),
    encounters: encounters.map(e=>({
      monsters: e.monsters.map(exportCreature),
      playersSurprised: !!e.playersSurprised,
      monstersSurprised: !!e.monstersSurprised,
      ...(e.shortRest ? { shortRest: true } : {})
    }))
  };
}

function refreshPreview(){
  updateSchemaStatus();
  scheduleSave();
  const pre = document.getElementById('jsonPreview');
  if(pre.style.display !== 'none'){
    pre.textContent = JSON.stringify(buildDayObject(), null, 2);
  }
}

document.getElementById('previewToggle').addEventListener('click', ()=>{
  const pre = document.getElementById('jsonPreview');
  const showing = pre.style.display !== 'none';
  pre.style.display = showing ? 'none' : 'block';
  document.getElementById('previewToggle').textContent = (showing?'▸':'▾') + ' show JSON preview';
  if(!showing) refreshPreview();
});

document.getElementById('downloadBtn').addEventListener('click', ()=>{
  const obj = buildDayObject();
  const blob = new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (obj.name || 'adventuring-day').replace(/[^a-z0-9\\-_]+/gi,'_') + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById('copyBtn').addEventListener('click', async ()=>{
  const obj = buildDayObject();
  try{
    await navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
    setStatus('parseStatus', 'Copied full day JSON to clipboard.', 'ok');
  }catch(err){
    setStatus('parseStatus', "Couldn't copy — use Download instead.", 'err');
  }
});

document.getElementById('dayNameInput').addEventListener('input', refreshPreview);

/* ---------------------------------------------------------
   Utils
--------------------------------------------------------- */
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(str){ return escapeHtml(str); }

/* ---------------------------------------------------------
   Init
--------------------------------------------------------- */
function renderAll(){
  renderTabs();
  renderMonsters();
  refreshPreview();
}

/* ---------------------------------------------------------
   Real schema check — the Forge's own save-format validators
   in the engine script above, so "valid here" = "loads on the site".
--------------------------------------------------------- */
function describePath(day, path){
  const parts = [];
  let node = day;
  for(let i=0;i<path.length;i++){
    const k = path[i];
    if(k === 'encounters' && typeof path[i+1] === 'number'){ parts.push(`Encounter ${path[i+1]+1}`); node = day.encounters[path[i+1]]; i++; continue; }
    if(k === 'players' && typeof path[i+1] === 'number'){ node = day.players[path[i+1]]; parts.push(node?.name || `Player ${path[i+1]+1}`); i++; continue; }
    if(k === 'monsters' && typeof path[i+1] === 'number'){ node = node?.monsters?.[path[i+1]]; parts.push(node?.name || `Monster ${path[i+1]+1}`); i++; continue; }
    if(k === 'actions' && typeof path[i+1] === 'number'){ node = node?.actions?.[path[i+1]]; parts.push(`"${node?.name || node?.templateOptions?.templateName || 'action '+(path[i+1]+1)}"`); i++; continue; }
    parts.push(String(k));
  }
  return parts.join(' › ');
}

/* Checks a day against the day save-file format using the Forge's own validators
   (the same rules the cards' warnings use: required fields, allowed values, number formats). */
function checkRealSchema(day){
  const errors = [];
  if(!day || typeof day !== 'object') return { ok:false, errors:['Not a day object.'] };
  if(!Array.isArray(day.players)) errors.push('players: missing or not a list');
  if(!Array.isArray(day.encounters)) errors.push('encounters: missing or not a list');
  const checkCreature = (c, where) => {
    if(!c || typeof c !== 'object'){ errors.push(`${where}: not a creature`); return; }
    if(!c.id) errors.push(`${where}: missing id`);
    if(!['custom','monster','player'].includes(c.mode)) errors.push(`${where} (${c.name || '?'}): mode must be custom, monster or player`);
    (c.actions || []).forEach((a, i)=>{ if(!a.id) errors.push(`${where} (${c.name || '?'}) action ${i + 1}: missing id`); });
    validateMonster(c).forEach(w=>errors.push(`${where} (${c.name || '?'}): ${w}`));
  };
  (day.players || []).forEach((p, i)=>checkCreature(p, `players[${i}]`));
  (day.encounters || []).forEach((e, i)=>{
    if(!e || !Array.isArray(e.monsters)){ errors.push(`encounters[${i}]: missing monsters list`); return; }
    e.monsters.forEach((m, j)=>checkCreature(m, `encounters[${i}].monsters[${j}]`));
  });
  return { ok: !errors.length, errors };
}

function updateSchemaStatus(){
  const el = document.getElementById('schemaStatus');
  if(!el) return;
  const res = checkRealSchema(buildDayObject());
  if(res.ok){
    el.className = 'status ok';
    el.innerHTML = '✓ Passes the Forge\'s save-file format checks — ready to export.';
  } else {
    el.className = 'status err';
    el.innerHTML = `✕ This file has ${res.errors.length} format issue${res.errors.length===1?'':'s'}:<ul class="schema-errors">${res.errors.slice(0,12).map(e=>`<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
  }
}

/* ---------------------------------------------------------
   View switching
--------------------------------------------------------- */
let currentView = 'forge';
const PAGES = {
  forge: { title: 'Statblock <span>Forge</span>', sub: 'Paste a monster statblock, get back simulator-ready JSON. Build out full encounters, then play them out on the War Table.' },
  war:   { title: 'War <span>Table</span>', sub: 'Fights played out with real dice, real initiative and real positions. Run a fight hundreds of times for the odds, then watch any one of them unfold.' },
};
function showView(view, fromHash){
  if(!PAGES[view]) view = 'forge';
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(b=>b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('viewForge').style.display = view==='forge' ? '' : 'none';
  document.getElementById('viewWar').style.display = view==='war' ? '' : 'none';
  document.getElementById('siteTitle').innerHTML = PAGES[view].title;
  document.getElementById('siteSub').textContent = PAGES[view].sub;
  document.title = view === 'war' ? 'War Table' : 'Statblock Forge';
  document.body.classList.toggle('wide', view === 'war');
  if(!fromHash){ try{ history.replaceState(null, '', '#' + view); }catch(e){} }
  if(view === 'war' && window.WarTable) window.WarTable.show();
}
document.querySelectorAll('.view-btn').forEach(btn=>btn.addEventListener('click', ()=>showView(btn.dataset.view)));
window.addEventListener('hashchange', ()=>showView(location.hash.slice(1), true));

/* ---------------------------------------------------------
   Load a day file (works for both views)
--------------------------------------------------------- */
document.getElementById('loadDayInput').addEventListener('change', async (ev)=>{
  const file = ev.target.files[0];
  ev.target.value = '';
  if(!file) return;
  let day;
  try{ day = JSON.parse(await file.text()); }
  catch(e){ setStatus('loadStatus', "That file isn't valid JSON.", 'err'); return; }
  const check = checkRealSchema(day);
  if(!check.ok){
    const el = document.getElementById('loadStatus');
    el.className = 'status err';
    el.innerHTML = `"${escapeHtml(file.name)}" doesn't look like a day save file (${check.errors.length} issue${check.errors.length===1?'':'s'}):<ul class="schema-errors">${check.errors.slice(0,12).map(e=>`<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
    return;
  }
  PARTY_PLAYERS.splice(0, PARTY_PLAYERS.length, ...day.players);
  encounters = day.encounters.length ? day.encounters.map(e=>({
    monsters: e.monsters.map(m=>{ const c = JSON.parse(JSON.stringify(m)); c._warnings = validateMonster(c); return c; }),
    playersSurprised: !!e.playersSurprised,
    monstersSurprised: !!e.monstersSurprised,
    shortRest: !!e.shortRest,
  })) : [ freshEncounter() ];
  activeIdx = 0;
  if(day.name) document.getElementById('dayNameInput').value = day.name;
  renderPartyBar();
  renderParty();
  renderAll();
  setStatus('loadStatus', `Loaded "${escapeHtml(file.name)}": ${PARTY_PLAYERS.length} party member${PARTY_PLAYERS.length===1?'':'s'}, ${encounters.length} encounter${encounters.length===1?'':'s'}.`, 'ok');
  if(typeof scheduleSave === 'function') scheduleSave();
});

/* ---------------------------------------------------------
   Init
--------------------------------------------------------- */

/* ---------------------------------------------------------
   Persistence — autosaves the whole workspace.
   Inside Claude, uses the artifact storage API (window.storage).
   Opened as a plain file in a browser, falls back to localStorage.
--------------------------------------------------------- */
const SAVE_KEY = 'forge-workspace-v1';
// Bump PARTY_VERSION when a built-in party member is rebuilt; list which player ids changed in that version.
// Saved workspaces from older versions get exactly those players swapped in, nothing else touched.
const PARTY_VERSION = 9;
// v5: real saving throws for Eldar and Tacitus (from their sheets) and the save each of Eldar's spells calls for; only fills what's missing
const PARTY_FN_UPDATES = { 5: p => {
  const fresh = DEFAULT_PARTY.find(x=>x.id === p.id); if(!fresh || !fresh.ext) return false;
  let changed = false;
  if(fresh.ext.saves && !(p.ext && p.ext.saves)){ p.ext = p.ext || {}; p.ext.saves = Object.assign({}, fresh.ext.saves); p.saveBonus = Math.round(Object.values(p.ext.saves).reduce((t,n)=>t+n,0) / 6 * 100) / 100; changed = true; }
  const fs = fresh.ext.spellbook, ps = p.ext && p.ext.spellbook;
  if(fs && ps) (ps.spells || []).forEach(sp=>{ const f = fs.spells.find(x=>x.id === sp.id); if(f && f.ext && f.ext.saveAbility && !(sp.ext && sp.ext.saveAbility)){ sp.ext = Object.assign({}, sp.ext || {}, { saveAbility: f.ext.saveAbility }); changed = true; } });
  return changed;
} };
const PARTY_UPDATES = { 9: ['0c42f4e7-3115-43c2-88bf-8c83c199fa07', '7ba165da-a21c-4d81-9553-c8acf97f9294', 'f4d574da-e9e2-48be-9857-8cefd726544a', '7157d787-a405-41be-afb8-88bde61ef76f', '269adf29-1d78-49ba-be98-1e71db9f5504', '427e06c2-caa6-474a-9b95-c4aa5c49301f'], 2: ['427e06c2-caa6-474a-9b95-c4aa5c49301f'], 4: ['427e06c2-caa6-474a-9b95-c4aa5c49301f'], 6: ['427e06c2-caa6-474a-9b95-c4aa5c49301f', 'f4d574da-e9e2-48be-9857-8cefd726544a'], 7: ['269adf29-1d78-49ba-be98-1e71db9f5504', '0c42f4e7-3115-43c2-88bf-8c83c199fa07'], 8: ['269adf29-1d78-49ba-be98-1e71db9f5504', '0c42f4e7-3115-43c2-88bf-8c83c199fa07', '7157d787-a405-41be-afb8-88bde61ef76f'] };   // v9: damage types on every attack; Entangle needs a crowd, Fog Cloud is for getting out, Hideous Laughter breaks on damage   // v8: Niko rebuilt from his sheet; Juniper and Faithwalker get pushes, zones, teleports   // v7: Juniper (D&D Beyond) and Faithwalker (Notion sheet)   // v6: Eldar and Tacitus rebuilt from their sheets   // v4: Eldar gets a spell list + slots   // v2: Eldar rebuilt from his character sheet
// v3: initiative from the character sheets; only filled in where the saved creature has none
const PARTY_EXT_UPDATES = { 3: { '427e06c2-caa6-474a-9b95-c4aa5c49301f': { initBonus: 3 }, 'f4d574da-e9e2-48be-9857-8cefd726544a': { initBonus: 6, initAdvantage: true } } };
const DEFAULT_PARTY = JSON.parse(JSON.stringify(PARTY_PLAYERS));
const DEFAULT_DAY_NAME = document.getElementById('dayNameInput').value;
let saveReady = false, saveTimer = null, saveNote = '';

const store = {
  kind: (typeof window.storage !== 'undefined' && window.storage && typeof window.storage.get === 'function') ? 'claude'
      : (()=>{ try{ localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return 'local'; }catch(e){ return 'none'; } })(),
  async get(){
    if(this.kind === 'claude'){
      try{ const r = await window.storage.get(SAVE_KEY, false); return r ? r.value : null; }catch(e){ return null; }  // missing key throws
    }
    if(this.kind === 'local'){ try{ return localStorage.getItem(SAVE_KEY); }catch(e){ return null; } }
    return null;
  },
  async set(v){
    if(this.kind === 'claude'){ const r = await window.storage.set(SAVE_KEY, v, false); if(!r) throw new Error('storage refused the save'); return; }
    if(this.kind === 'local'){ localStorage.setItem(SAVE_KEY, v); return; }
    throw new Error('no storage available');
  },
  async del(){
    if(this.kind === 'claude'){ try{ await window.storage.delete(SAVE_KEY, false); }catch(e){} return; }
    if(this.kind === 'local'){ try{ localStorage.removeItem(SAVE_KEY); }catch(e){} }
  },
};

function setSaveStatus(text, cls){
  const el = document.getElementById('saveStatus');
  el.className = cls || '';
  el.textContent = text;
}

function snapshot(){
  return JSON.stringify({
    v: 1,
    partyVersion: PARTY_VERSION,
    savedAt: Date.now(),
    dayName: document.getElementById('dayNameInput').value,
    activeIdx,
    players: PARTY_PLAYERS.map(stripInternal),
    encounters: encounters.map(e=>({ ...e, monsters: e.monsters.map(stripInternal) })),
  });
}

function scheduleSave(){
  if(!saveReady) return;               // never overwrite saved work before it has been loaded
  if(store.kind === 'none'){ setSaveStatus('Saving unavailable here — export a JSON to keep your work', 'unsaved'); return; }
  setSaveStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async ()=>{
    try{
      await store.set(snapshot());
      const t = new Date();
      setSaveStatus(`✓ Saved ${t.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}${saveNote}`, 'saved');
    }catch(e){
      console.error(e);
      setSaveStatus('✕ Save failed — export a JSON to be safe', 'unsaved');
    }
  }, 600);
}

function applyWorkspace(ws){
  const updated = [];
  if(Array.isArray(ws.players)){
    PARTY_PLAYERS.splice(0, PARTY_PLAYERS.length, ...ws.players);
    for(let v = (ws.partyVersion || 1) + 1; v <= PARTY_VERSION; v++){
      (PARTY_UPDATES[v] || []).forEach(id=>{
        const i = PARTY_PLAYERS.findIndex(x=>x.id === id);
        const fresh = DEFAULT_PARTY.find(x=>x.id === id);
        if(i >= 0 && fresh){ PARTY_PLAYERS[i] = JSON.parse(JSON.stringify(fresh)); updated.push(fresh.name); }
      });
      if(PARTY_FN_UPDATES[v]) PARTY_PLAYERS.forEach(p=>{ if(PARTY_FN_UPDATES[v](p)) updated.push(p.name); });
      Object.entries((PARTY_EXT_UPDATES[v] || {})).forEach(([id, add])=>{
        const p = PARTY_PLAYERS.find(x=>x.id === id); if(!p) return;
        p.ext = p.ext || {};
        Object.entries(add).forEach(([k, val])=>{ if(p.ext[k] === undefined) p.ext[k] = val; });
      });
    }
  }
  if(Array.isArray(ws.encounters) && ws.encounters.length){
    encounters = ws.encounters.map(e=>({
      monsters: (e.monsters||[]).map(m=>{ m._warnings = validateMonster(m); return m; }),
      playersSurprised: !!e.playersSurprised,
      monstersSurprised: !!e.monstersSurprised,
      shortRest: !!e.shortRest,
    }));
  }
  activeIdx = Math.min(Math.max(0, ws.activeIdx|0), encounters.length - 1);
  if(typeof ws.dayName === 'string') document.getElementById('dayNameInput').value = ws.dayName;
  return updated;
}

async function loadWorkspace(){
  try{
    const raw = await store.get();
    if(raw){
      const updated = applyWorkspace(JSON.parse(raw));
      renderPartyBar(); renderParty(); renderAll();
      const ws = JSON.parse(raw);
      setSaveStatus(`✓ Restored work from ${new Date(ws.savedAt).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}${updated.length ? ` · updated ${updated.join(', ')} to the latest sheet build` : ''}`, 'saved');
      if(updated.length) saveNote = ` · updated ${updated.join(', ')} to the latest sheet build`;
      if(updated.length || (ws.partyVersion || 1) < PARTY_VERSION){ saveReady = true; scheduleSave(); }
    } else {
      setSaveStatus(store.kind === 'none' ? 'Saving unavailable here — export a JSON to keep your work' : 'Autosave on', store.kind === 'none' ? 'unsaved' : '');
    }
  }catch(e){
    console.error(e);
    setSaveStatus("✕ Couldn't read saved work — starting fresh", 'unsaved');
  }
  saveReady = true;
}

document.getElementById('resetSavedBtn').addEventListener('click', async ()=>{
  if(!confirm('Reset the party, encounters and settings to the defaults? Your saved work will be deleted (export a JSON first if you want to keep it).')) return;
  await store.del();
  PARTY_PLAYERS.splice(0, PARTY_PLAYERS.length, ...JSON.parse(JSON.stringify(DEFAULT_PARTY)));
  encounters = [ freshEncounter() ];
  activeIdx = 0;
  document.getElementById('dayNameInput').value = DEFAULT_DAY_NAME;
  openPlayers.clear(); openActions.clear(); openJson.clear();
  renderPartyBar(); renderParty(); renderAll();
  setSaveStatus('Reset to defaults', '');
});

renderPartyBar();
renderParty();
renderAll();
loadWorkspace();
