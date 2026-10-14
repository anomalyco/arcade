import {
  DEFAULT_LEDGER_TUNING,
  Ledger,
  type ActorId,
  type ActorStoreTemplate,
  type ItemDef,
  type LedgerCatalog,
  type LedgerEvent,
  type LedgerTuning,
  type Rule,
  type SkillTrack,
  type StoreSpec,
} from "@arcade/kit/sim/ledger"

export {
  DEFAULT_LEDGER_TUNING,
  Ledger,
  type ActorId,
  type ItemDef,
  type LedgerCatalog,
  type LedgerEvent,
  type LedgerTuning,
  type Rule,
  type SkillTrack,
  type StoreSpec,
}

export const progressionControls = [
  { key: "searchQuietTime", label: "Quiet search time", group: "Progression", min: 0.2, max: 3.0, step: 0.1, unit: "s" },
  { key: "searchQuietNoise", label: "Quiet search noise", group: "Progression", min: 0, max: 20, step: 0.5, unit: "m" },
  { key: "searchSmashTime", label: "Smash search time", group: "Progression", min: 0.1, max: 1.5, step: 0.05, unit: "s" },
  { key: "searchSmashNoise", label: "Smash search noise", group: "Progression", min: 2, max: 35, step: 1, unit: "m" },
  { key: "reloadTime", label: "Base reload time", group: "Progression", min: 0.3, max: 2.5, step: 0.05, unit: "s" },
  { key: "craftTimeScale", label: "Craft time scale", group: "Progression", min: 0.2, max: 2.5, step: 0.1, unit: "×" },
  { key: "studyLightMin", label: "Research light min", group: "Progression", min: 0, max: 1.0, step: 0.05, unit: "" },
  { key: "nightXpMultiplier", label: "Night mastery boost", group: "Progression", min: 1.0, max: 4.0, step: 0.25, unit: "×" },
] as const

export const OUTBREAK_ACTOR_STORES: readonly ActorStoreTemplate[] = [
  {
    suffix: "belt",
    mode: "counters",
    accepts: ["ammo", "resource", "key"],
    caps: {
      ammo: 24,
      shells: 16,
      plank: 6,
      scrap: 10,
      chem: 6,
      battery: 4,
      supplement: 8,
      key: 4,
    },
    depositable: true,
  },
  {
    suffix: "hotbar",
    mode: "slots",
    size: 5,
    accepts: ["tool"],
  },
  {
    suffix: "pack",
    mode: "slots",
    size: 4,
    accepts: ["part", "manual", "tool"],
    depositable: true,
  },
  {
    suffix: "skills",
    mode: "counters",
    accepts: ["skill"],
  },
]

export const OUTBREAK_ITEMS: readonly ItemDef[] = [
  // Active Hotbar Tools & Weapons
  {
    id: "flashlight",
    label: "Flashlight",
    shortLabel: "LIGHT",
    tag: "tool",
    stack: 1,
    charge: { max: 1, initial: 1 },
  },
  {
    id: "pistol",
    label: "9mm Pistol",
    shortLabel: "9MM",
    tag: "tool",
    stack: 1,
    charge: { max: 8, initial: 6, ammo: "ammo" },
  },
  {
    id: "shotgun",
    label: "Pump Shotgun",
    shortLabel: "12GA",
    tag: "tool",
    stack: 1,
    charge: { max: 6, initial: 6, ammo: "shells" },
  },
  {
    id: "crowbar",
    label: "Crowbar",
    shortLabel: "PRY",
    tag: "tool",
    stack: 1,
    charge: { max: 1, initial: 1 },
    mods: { shoveDamage: { add: 15 }, shoveStagger: { mul: 1.4 }, canPry: 1 },
  },
  {
    id: "spiked-board",
    label: "Spiked Board",
    shortLabel: "SPIKE",
    tag: "tool",
    stack: 1,
    mods: { shoveDamage: { add: 25 }, shoveStagger: { mul: 1.8 } },
  },
  {
    id: "medkit",
    label: "First Aid Kit",
    shortLabel: "MED",
    tag: "tool",
    stack: 3,
  },
  {
    id: "bandage",
    label: "Bandage",
    shortLabel: "BAND",
    tag: "tool",
    stack: 3,
  },
  {
    id: "syringe",
    label: "Adrenaline Syringe",
    shortLabel: "STIM",
    tag: "tool",
    stack: 2,
  },
  {
    id: "noisemaker",
    label: "Alarm Timer",
    shortLabel: "LURE",
    tag: "tool",
    stack: 3,
  },
  {
    id: "molotov",
    label: "Molotov Cocktail",
    shortLabel: "FIRE",
    tag: "tool",
    stack: 3,
  },

  // Passive Belt Supplies
  { id: "ammo", label: "9mm Ammo", shortLabel: "AMMO", tag: "ammo", maxCount: 24 },
  { id: "shells", label: "12ga Shells", shortLabel: "SHELLS", tag: "ammo", maxCount: 16 },
  {
    id: "plank",
    label: "Wood Plank",
    shortLabel: "PLANK",
    tag: "resource",
    maxCount: 6,
    discovers: ["known:plank"],
  },
  {
    id: "scrap",
    label: "Scrap & Nails",
    shortLabel: "SCRAP",
    tag: "resource",
    maxCount: 10,
    discovers: ["known:scrap"],
  },
  {
    id: "chem",
    label: "Cloth & Alcohol",
    shortLabel: "CHEM",
    tag: "resource",
    maxCount: 6,
    discovers: ["known:chem", "proto:bandage", "proto:molotov"],
  },
  {
    id: "battery",
    label: "Spare Battery",
    shortLabel: "BAT",
    tag: "resource",
    maxCount: 4,
    discovers: ["known:battery"],
  },
  { id: "supplement", label: "Supplements", shortLabel: "SUPP", tag: "resource", maxCount: 8 },
  { id: "key", label: "House Key", shortLabel: "KEY", tag: "key", maxCount: 4 },
  { id: "sample", label: "Research Sample", shortLabel: "SAMPLE", tag: "sample" },

  // Pack Upgrade Parts & Field Manuals
  { id: "toolbox", label: "Hardware Toolbox", shortLabel: "TOOLS", tag: "part", stack: 1, slots: 1 },
  {
    id: "car-battery",
    label: "Car Battery",
    shortLabel: "CARBAT",
    tag: "part",
    stack: 1,
    slots: 2,
    mods: { sprintSpeed: { mul: 0.8 } },
  },
  { id: "manual:trauma", label: "Emergency Trauma Manual", shortLabel: "MAN:MED", tag: "manual", stack: 1 },
  { id: "manual:carpentry", label: "Carpentry & Traps Manual", shortLabel: "MAN:CARP", tag: "manual", stack: 1 },
  { id: "manual:marksman", label: "Marksman & Suppressor Manual", shortLabel: "MAN:GUN", tag: "manual", stack: 1 },

  // Knowledge, Prototypes, Perks, Skill Ranks, and Meta Upgrades
  { id: "known:plank", label: "Discovered Wood Planks", tag: "knowledge" },
  { id: "known:scrap", label: "Discovered Scrap & Nails", tag: "knowledge" },
  { id: "known:chem", label: "Discovered Cloth & Alcohol", tag: "knowledge" },
  { id: "known:battery", label: "Discovered Spare Battery", tag: "knowledge" },
  { id: "proto:bandage", label: "Recipe: Bandage", tag: "knowledge" },
  { id: "proto:molotov", label: "Recipe: Molotov", tag: "knowledge" },
  { id: "proto:spiked-board", label: "Recipe: Spiked Board", tag: "knowledge" },
  {
    id: "proto:reinforced-barricade",
    label: "Reinforced Peephole Barricade",
    tag: "knowledge",
    mods: { barricadeHp: { add: 80 } },
  },
  {
    id: "proto:uv-stun",
    label: "UV Stun Capacitor",
    tag: "knowledge",
    mods: { uvStunBurst: 1 },
  },
  {
    id: "proto:suppressor",
    label: "Oil-Filter Suppressor",
    tag: "knowledge",
    mods: { pistolNoise: { mul: 0.34375 } },
  },
  { id: "proto:syringe", label: "Recipe: Adrenaline Syringe", tag: "knowledge" },
  {
    id: "perk:fast-triage",
    label: "Fast Triage",
    tag: "knowledge",
    mods: { healTime: { mul: 0.55 } },
  },
  {
    id: "perk:ext-mag",
    label: "Extended 9mm Magazine",
    tag: "knowledge",
    mods: { magCapacity: { add: 4 } },
  },

  // Action Mastery XP & Ranks (Direction 2)
  { id: "xp:firearms", label: "Firearms XP", tag: "skill" },
  { id: "rank:firearms:1", label: "Firearms I", tag: "skill" },
  {
    id: "rank:firearms:2",
    label: "Firearms II",
    tag: "skill",
    mods: { reloadTime: { mul: 0.75 }, moveReload: 1 },
  },
  {
    id: "rank:firearms:3",
    label: "Firearms III",
    tag: "skill",
    mods: { detachChance: { add: 0.2 } },
  },
  { id: "xp:stealth", label: "Stealth & Mobility XP", tag: "skill" },
  { id: "rank:stealth:1", label: "Stealth & Mobility I", tag: "skill" },
  {
    id: "rank:stealth:2",
    label: "Stealth & Mobility II",
    tag: "skill",
    mods: { vaultNoise: { mul: 0.6 }, vaultStamina: { mul: 0.611111 }, acousticPeek: 1 },
  },
  {
    id: "rank:stealth:3",
    label: "Stealth & Mobility III",
    tag: "skill",
    mods: { searchNoise: { mul: 0.5 } },
  },
  { id: "xp:fortify", label: "Fortification XP", tag: "skill" },
  { id: "rank:fortify:1", label: "Fortification I", tag: "skill" },
  {
    id: "rank:fortify:2",
    label: "Fortification II",
    tag: "skill",
    mods: { barricadeTime: { mul: 0.642857 }, barricadeHp: { add: 40 } },
  },
  {
    id: "rank:fortify:3",
    label: "Fortification III",
    tag: "skill",
    mods: { shoveStamina: { mul: 0.5 }, shoveKnockdown: { add: 1.4 } },
  },

  // Dusk Supply Locker Racks & Persistent Meta Upgrades (Direction 3)
  {
    id: "rack:shotgun",
    label: "Pump Shotgun + 12 Shells",
    tag: "bundle",
    grants: { shotgun: 1, shells: 12 },
  },
  {
    id: "rack:nailgun",
    label: "Spiked Board + 6 Planks",
    tag: "bundle",
    grants: { "spiked-board": 1, plank: 6 },
  },
  {
    id: "rack:trauma",
    label: "Trauma Kit & Syringe",
    tag: "bundle",
    grants: { medkit: 2, syringe: 1 },
  },
  {
    id: "upgrade:battery-bank",
    label: "Backup Battery Bank",
    tag: "upgrade",
    mods: { safehouseLampHours: { add: 3 } },
  },
  {
    id: "upgrade:porch-planks",
    label: "Porch Plank Crate",
    tag: "upgrade",
  },
  {
    id: "upgrade:belt-pouch",
    label: "Expanded Ammo Belt",
    tag: "upgrade",
    mods: { "cap:ammo": { add: 12 } },
  },
]

export const CORE_ACTION_RULES: readonly Rule[] = [
  {
    id: "barricade",
    label: "Board up opening",
    duration: 0.7,
    durationStat: "barricadeTime",
    noise: 9.5,
    noiseStat: "barricadeNoise",
    consume: { plank: 1 },
    produce: { plank: 1 },
    produceTo: "target",
  },
  {
    id: "heal:medkit",
    label: "Apply First Aid Kit",
    duration: 2.0,
    durationStat: "healTime",
    consume: { medkit: 1 },
  },
  {
    id: "heal:bandage",
    label: "Apply Bandage",
    duration: 1.5,
    durationStat: "healTime",
    consume: { bandage: 1 },
  },
]

/** Direction 1: Safehouse Workbench & Discover-to-Prototype rules. */
export const WORKBENCH_RULES: readonly Rule[] = [
  {
    id: "proto:uv-stun",
    label: "Prototype UV Stun Capacitor",
    duration: 2.0,
    lightMin: 0.35,
    station: "bench",
    requires: { toolbox: 1 },
    forbids: { "proto:uv-stun": 1 },
    consume: { scrap: 3, battery: 1 },
    produce: { "proto:uv-stun": 1 },
    produceTo: "team/known",
  },
  {
    id: "proto:suppressor",
    label: "Prototype Oil-Filter Suppressor",
    duration: 2.0,
    lightMin: 0.35,
    station: "bench",
    requires: { toolbox: 1 },
    forbids: { "proto:suppressor": 1 },
    consume: { scrap: 3 },
    produce: { "proto:suppressor": 1 },
    produceTo: "team/known",
  },
  {
    id: "proto:spiked-board",
    label: "Prototype Spiked Board",
    duration: 2.0,
    lightMin: 0.35,
    station: "bench",
    forbids: { "proto:spiked-board": 1 },
    consume: { plank: 1, scrap: 2 },
    produce: { "proto:spiked-board": 1, "spiked-board": 1 },
    produceTo: "actor",
  },
  {
    id: "proto:reinforced-barricade",
    label: "Prototype Reinforced Barricade",
    duration: 2.0,
    lightMin: 0.35,
    station: "bench",
    forbids: { "proto:reinforced-barricade": 1 },
    consume: { plank: 1, scrap: 2 },
    produce: { "proto:reinforced-barricade": 1 },
    produceTo: "team/known",
  },
  {
    id: "craft:bandage",
    label: "Field-craft Bandage",
    duration: 2.0,
    durationStat: "craftTime",
    requires: { "proto:bandage": 1 },
    consume: { chem: 1 },
    produce: { bandage: 1 },
    produceTo: "actor",
  },
  {
    id: "craft:molotov",
    label: "Field-craft Molotov",
    duration: 2.0,
    durationStat: "craftTime",
    requires: { "proto:molotov": 1 },
    consume: { chem: 1 },
    produce: { molotov: 1 },
    produceTo: "actor",
  },
  {
    id: "craft:spiked-board",
    label: "Field-craft Spiked Board",
    duration: 2.0,
    durationStat: "craftTime",
    requires: { "proto:spiked-board": 1 },
    consume: { plank: 1, scrap: 2 },
    produce: { "spiked-board": 1 },
    produceTo: "actor",
  },
]

/** Direction 2: Field Manuals & Action Mastery rules. */
export const MANUAL_RULES: readonly Rule[] = [
  {
    id: "study:trauma",
    label: "Study Emergency Trauma Manual",
    duration: 4.0,
    durationStat: "studyTime",
    lightMin: 0.35,
    forbids: { "perk:fast-triage": 1 },
    consume: { "manual:trauma": 1 },
    produce: { "proto:syringe": 1, "perk:fast-triage": 1 },
    produceTo: "team/known",
  },
  {
    id: "study:carpentry",
    label: "Study Carpentry & Traps Manual",
    duration: 4.0,
    durationStat: "studyTime",
    lightMin: 0.35,
    forbids: { "proto:reinforced-barricade": 1 },
    consume: { "manual:carpentry": 1 },
    produce: { "proto:reinforced-barricade": 1, "proto:spiked-board": 1 },
    produceTo: "team/known",
  },
  {
    id: "study:marksman",
    label: "Study Marksman & Suppressor Manual",
    duration: 4.0,
    durationStat: "studyTime",
    lightMin: 0.35,
    forbids: { "proto:suppressor": 1 },
    consume: { "manual:marksman": 1 },
    produce: { "proto:suppressor": 1, "perk:ext-mag": 1 },
    produceTo: "team/known",
  },
  {
    id: "craft:syringe",
    label: "Craft Adrenaline Syringe",
    duration: 2.0,
    durationStat: "craftTime",
    requires: { "proto:syringe": 1 },
    consume: { chem: 2, scrap: 1 },
    produce: { syringe: 1 },
    produceTo: "actor",
  },
]

/** Direction 3: Threat-Escalation Runs & Persistent Safehouse Meta rules. */
export const META_RULES: readonly Rule[] = [
  {
    id: "meta:battery-bank",
    label: "Unlock Backup Battery Bank",
    station: "profile",
    forbids: { "upgrade:battery-bank": 1 },
    consume: { sample: 60 },
    produce: { "upgrade:battery-bank": 1 },
    produceTo: "station",
  },
  {
    id: "meta:porch-planks",
    label: "Unlock Porch Plank Crate",
    station: "profile",
    forbids: { "upgrade:porch-planks": 1 },
    consume: { sample: 45 },
    produce: { "upgrade:porch-planks": 1 },
    produceTo: "station",
  },
  {
    id: "meta:belt-pouch",
    label: "Unlock Expanded Ammo Belt",
    station: "profile",
    forbids: { "upgrade:belt-pouch": 1 },
    consume: { sample: 50 },
    produce: { "upgrade:belt-pouch": 1 },
    produceTo: "station",
  },
]

export const OUTBREAK_SKILLS: readonly SkillTrack[] = [
  {
    xpItem: "xp:firearms",
    ranks: [
      { xp: 50, grants: "rank:firearms:1" },
      { xp: 100, grants: "rank:firearms:2" },
      { xp: 200, grants: "rank:firearms:3" },
    ],
  },
  {
    xpItem: "xp:stealth",
    ranks: [
      { xp: 50, grants: "rank:stealth:1" },
      { xp: 100, grants: "rank:stealth:2" },
      { xp: 200, grants: "rank:stealth:3" },
    ],
  },
  {
    xpItem: "xp:fortify",
    ranks: [
      { xp: 50, grants: "rank:fortify:1" },
      { xp: 100, grants: "rank:fortify:2" },
      { xp: 200, grants: "rank:fortify:3" },
    ],
  },
]

export function createOutbreakLedger(
  extraStores: readonly StoreSpec[] = [],
  tuning?: Partial<LedgerTuning>,
): Ledger {
  const catalog: LedgerCatalog = {
    items: OUTBREAK_ITEMS,
    actorStores: OUTBREAK_ACTOR_STORES,
    stores: [
      { id: "team/known", mode: "counters", scope: "shared", accepts: ["knowledge", "upgrade"] },
      { id: "team/bag", mode: "counters", scope: "shared", accepts: ["sample"] },
      { id: "bench:ash", mode: "counters", scope: "shared", accepts: ["resource", "part"], at: { x: 25.0, y: 38.0 } },
      { id: "portal:win-1", mode: "counters", scope: "shared", accepts: ["resource"], caps: { plank: 3 } },
      ...extraStores,
    ],
    rules: [...CORE_ACTION_RULES, ...WORKBENCH_RULES, ...MANUAL_RULES, ...META_RULES],
    skills: OUTBREAK_SKILLS,
    discoverStore: "team/known",
    sharedKnowledgeStores: ["team/known"],
  }
  return new Ledger(catalog, tuning)
}

/** Seeds a survivor with Outbreak's default starter loadout (`Flashlight`, `9mm Pistol 6/8`, `+6 9mm Ammo`, `+2 Planks`). */
export function addOutbreakSurvivor(ledger: Ledger, actor: ActorId): void {
  ledger.addActor(actor)
  const hotbar = ledger.store(`${actor}/hotbar`)!
  hotbar.slots[0] = { item: "flashlight", count: 1, charge: 1, active: true }
  hotbar.slots[1] = { item: "pistol", count: 1, charge: 6 }
  hotbar.selected = 1
  const belt = ledger.store(`${actor}/belt`)!
  belt.counts.ammo = 6
  belt.counts.plank = 2
}
