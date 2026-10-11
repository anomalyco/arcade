import type { ClassId } from "./protocol"

export interface ClassDef {
  id: ClassId
  name: string
  role: string
  maxHp: number
  fuel: number
  power: number
  passive: string
  desc: string
}

export const CLASSES: Record<ClassId, ClassDef> = {
  crawler: { id: "crawler", name: "Mortar Crawler", role: "Bruiser", maxHp: 110, fuel: 90, power: 0.97, passive: "Starts every battle with a 15 HP shield.", desc: "Tracked mortar carrier. Tough, steady and hard to dislodge." },
  howitzer: { id: "howitzer", name: "Wheeled Howitzer", role: "All-rounder", maxHp: 100, fuel: 110, power: 1, passive: "Gains +1 cluster round at the start of every battle.", desc: "Balanced field gun with a generous ammo locker." },
  buggy: { id: "buggy", name: "Rocket Buggy", role: "Skirmisher", maxHp: 85, fuel: 220, power: 0.96, passive: "Double fuel: drives twice as far every volley.", desc: "Six-wheel launcher that never stops moving." },
  rail: { id: "rail", name: "Rail Cannon", role: "Sniper", maxHp: 85, fuel: 80, power: 1.16, passive: "Higher maximum launch speed for flat, long shots.", desc: "Magnetic accelerator that reaches across the whole map." },
  drone: { id: "drone", name: "Hover Drone", role: "Scout", maxHp: 80, fuel: 140, power: 0.98, passive: "Never takes fall damage.", desc: "Hovering platform that shrugs off collapses and drops." },
  walker: { id: "walker", name: "Missile Walker", role: "Climber", maxHp: 95, fuel: 120, power: 1.02, passive: "Climbs and holds much steeper slopes without sliding.", desc: "Legged launcher that perches where tanks cannot." },
  siege: { id: "siege", name: "Siege Tank", role: "Heavy", maxHp: 140, fuel: 55, power: 1, passive: "+20% damage on everything it fires.", desc: "Double-barrel monster. Slow, heavy, devastating." },
  catapult: { id: "catapult", name: "Mast Catapult", role: "Artillerist", maxHp: 95, fuel: 90, power: 1.05, passive: "Shots feel only half the wind.", desc: "Tall mast thrower whose heavy payloads cut through gusts." },
}

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[]

// mechanical modifiers behind each passive, used by the sim
export interface Passive {
  damage: number
  wind: number
  fallDamage: number
  // max rise in px per 1px of walking
  climb: number
  // max surface slope (dy/dx) before the unit slides
  slide: number
  startShield: number
  startCluster: number
}

const BASE: Passive = { damage: 1, wind: 1, fallDamage: 1, climb: 2, slide: 1.5, startShield: 0, startCluster: 0 }

export const PASSIVES: Record<ClassId, Passive> = {
  crawler: { ...BASE, startShield: 15 },
  howitzer: { ...BASE, startCluster: 1 },
  buggy: { ...BASE },
  rail: { ...BASE },
  drone: { ...BASE, fallDamage: 0 },
  walker: { ...BASE, climb: 4, slide: 3 },
  siege: { ...BASE, damage: 1.2 },
  catapult: { ...BASE, wind: 0.5 },
}

export function classOf(cls: ClassId | undefined): ClassDef {
  return CLASSES[cls ?? "howitzer"] ?? CLASSES.howitzer
}

export function passiveOf(cls: ClassId | undefined): Passive {
  return PASSIVES[cls ?? "howitzer"] ?? PASSIVES.howitzer
}
