import { WEAPONS, WEAPON_IDS, type WeaponId } from "./weapons"

export interface ShopItem {
  id: string
  name: string
  kind: "weapon" | "upgrade"
  weapon?: WeaponId
  price: number
  desc: string
  stats?: { damage: number; radius: number; terrain: number }
}

export const SHOP: ShopItem[] = [
  ...WEAPON_IDS.filter((id) => id !== "shell").map(
    (id): ShopItem => ({
      id,
      name: WEAPONS[id].name,
      kind: "weapon",
      weapon: id,
      price: WEAPONS[id].price,
      desc: `+1 ammo. ${WEAPONS[id].blurb}`,
      stats: { damage: WEAPONS[id].damage, radius: WEAPONS[id].radius, terrain: WEAPONS[id].terrain },
    }),
  ),
  { id: "armor", name: "ARMOR PLATING", kind: "upgrade", price: 200, desc: "+20 max HP for the rest of the match. Stacks 3 times." },
  { id: "fuel", name: "FUEL TANK", kind: "upgrade", price: 150, desc: "+50% fuel every volley for the rest of the match. Stacks twice." },
  { id: "lens", name: "TARGETING LENS", kind: "upgrade", price: 160, desc: "Longer aim preview for the rest of the match. Stacks 3 times." },
  { id: "boost", name: "DAMAGE BOOST", kind: "upgrade", price: 250, desc: "Your first volley next battle deals x1.5 damage." },
  { id: "repair", name: "REPAIR KIT", kind: "upgrade", price: 140, desc: "+40 HP, applied automatically at the start of a volley once you are down 40 HP. Carry up to 3." },
]

export const SHOP_BY_ID: Record<string, ShopItem> = Object.fromEntries(SHOP.map((i) => [i.id, i]))

// per-player persistent match inventory
export interface Loadout {
  credits: number
  ammo: Record<WeaponId, number>
  armor: number
  fuelTank: number
  lens: number
  boost: number
  repair: number
}

export const LIMITS: Record<string, number> = { armor: 3, fuel: 2, lens: 3, boost: 1, repair: 3 }
export const MAX_AMMO = 9

export function newLoadout(credits = 0): Loadout {
  const ammo = Object.fromEntries(WEAPON_IDS.map((id) => [id, WEAPONS[id].ammo])) as Record<WeaponId, number>
  return { credits, ammo, armor: 0, fuelTank: 0, lens: 0, boost: 0, repair: 0 }
}

// mutates the loadout; returns an error message, or null on success
export function applyPurchase(l: Loadout, itemId: string): string | null {
  const item = SHOP_BY_ID[itemId]
  if (!item) return "Unknown item"
  if (l.credits < item.price) return "Not enough credits"
  if (item.kind === "weapon" && item.weapon) {
    if ((l.ammo[item.weapon] ?? 0) >= MAX_AMMO) return "Ammo full"
    l.ammo[item.weapon] = (l.ammo[item.weapon] ?? 0) + 1
  } else {
    const key = item.id === "fuel" ? "fuelTank" : (item.id as "armor" | "lens" | "boost" | "repair")
    if (l[key] >= (LIMITS[item.id] ?? 1)) return "Maxed out"
    l[key]++
  }
  l.credits -= item.price
  return null
}
