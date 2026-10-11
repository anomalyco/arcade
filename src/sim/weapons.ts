export type WeaponId =
  | "shell"
  | "cluster"
  | "mirv"
  | "drill"
  | "napalm"
  | "gravity"
  | "builder"
  | "airstrike"
  | "bouncer"
  | "buster"
  | "shield"
  | "teleport"

export interface WeaponDef {
  id: WeaponId
  name: string
  color: string
  ammo: number
  price: number
  damage: number
  radius: number
  terrain: number
  blurb: string
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  shell: { id: "shell", name: "SHELL", color: "#ffb14a", ammo: 999, price: 0, damage: 44, radius: 30, terrain: 2, blurb: "High-explosive round. Reliable and always loaded." },
  cluster: { id: "cluster", name: "CLUSTER", color: "#ff6ad5", ammo: 2, price: 220, damage: 22, radius: 16, terrain: 1, blurb: "Splits at apex into six bomblets that scatter across the target." },
  mirv: { id: "mirv", name: "MIRV", color: "#9b8cff", ammo: 1, price: 340, damage: 34, radius: 24, terrain: 2, blurb: "Three independent warheads from the apex." },
  drill: { id: "drill", name: "DRILL", color: "#3ee8ff", ammo: 2, price: 200, damage: 26, radius: 20, terrain: 3, blurb: "Bores a tunnel for three seconds, then detonates underground." },
  napalm: { id: "napalm", name: "NAPALM", color: "#ff5a2e", ammo: 2, price: 240, damage: 9, radius: 14, terrain: 0, blurb: "Burning pool on impact. Scorches anything standing in it." },
  gravity: { id: "gravity", name: "GRAVITY WELL", color: "#c06bff", ammo: 1, price: 300, damage: 30, radius: 46, terrain: 4, blurb: "Opens a vortex that drags shells and units inward, then implodes." },
  builder: { id: "builder", name: "BUILDER", color: "#a6ff4d", ammo: 2, price: 120, damage: 0, radius: 0, terrain: 4, blurb: "Raises a rock wall at the impact point." },
  airstrike: { id: "airstrike", name: "AIRSTRIKE", color: "#ffe16a", ammo: 1, price: 380, damage: 40, radius: 28, terrain: 3, blurb: "Four bombs in a line from above, each one a crater." },
  bouncer: { id: "bouncer", name: "BOUNCER", color: "#5dffb0", ammo: 2, price: 160, damage: 36, radius: 24, terrain: 2, blurb: "Ricochets off terrain three times before detonating." },
  buster: { id: "buster", name: "BUNKER BUSTER", color: "#ff3d6e", ammo: 1, price: 280, damage: 52, radius: 22, terrain: 5, blurb: "Penetrates deep before a heavy delayed blast." },
  shield: { id: "shield", name: "SHIELD", color: "#5ac8ff", ammo: 1, price: 180, damage: 0, radius: 0, terrain: 0, blurb: "Instead of firing, projects a 40 HP barrier for this volley." },
  teleport: { id: "teleport", name: "TELEPORT", color: "#e8f0ff", ammo: 1, price: 200, damage: 0, radius: 0, terrain: 0, blurb: "Fires a beacon. Your unit relocates where it lands." },
}

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[]
