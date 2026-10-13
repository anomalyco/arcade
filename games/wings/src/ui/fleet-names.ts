// Display names for ships and turrets (shared by the spawn screen, HUD and kill feed).
import { FLEET, SHIP_SPECS, type Ship } from "../sim/fleet"
import { TEAM_NAMES } from "./lobby"

const BY_ID = new Map(FLEET.map(s => [s.id, s]))

export function shipById(id: string): Ship | undefined {
  return BY_ID.get(id)
}

/** "amber carrier 2", "cobalt destroyer 1". */
export function shipName(id: string): string {
  const s = BY_ID.get(id)
  if (!s) return id
  const same = FLEET.filter(x => x.team === s.team && x.kind === s.kind)
  const n = same.indexOf(s) + 1
  return `${TEAM_NAMES[s.team].toLowerCase()} ${s.kind}${same.length > 1 ? ` ${n}` : ""}`
}

/** "ciws · bow port", "5-inch · fwd". */
export function turretName(shipId: string, turretId: string): string {
  const s = BY_ID.get(shipId)
  const t = s ? SHIP_SPECS[s.kind].turrets.find(x => x.id === turretId) : undefined
  const kind = t?.kind === "gun" ? "5-inch" : "ciws"
  const where = turretId.replace(/^(ciws|gun)_?/, "").replace(/_/g, " ").replace("stbd", "starboard").replace("fwd", "forward") || "mount"
  return `${kind} · ${where}`
}

export function turretKind(shipId: string, turretId: string): "ciws" | "gun" {
  const s = BY_ID.get(shipId)
  return (s ? SHIP_SPECS[s.kind].turrets.find(x => x.id === turretId)?.kind : undefined) ?? "ciws"
}
