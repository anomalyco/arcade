import { buildShipWeapons } from "./ship-weapons"

/** The fixed pedestals of every ship weapon, ship-local: what the hull buffer bakes (src/render/turret-pass.ts draws
 *  the turrets and barrels that train and elevate). */
export function turretMountVerts(): number[] {
  const out: number[] = []
  for (const w of buildShipWeapons()) for (const v of w.mount.v) out.push(v)
  return out
}
