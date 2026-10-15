import type { Building, Prop, Town } from "../map"
import { propShape } from "../map"

/**
 * Found knowledge (D-19 slice 3): wordless pages left in buildings by type, practice that makes boarding faster and
 * quieter, and lessons picked up by watching. Pure helpers; the state lives in the progression ledger and snapshot.
 */

/** Which recipe's page each kind of building holds: a flyer, a chart, a photo. Houses hold none. */
export const PAGE_BY_ARCHETYPE: Readonly<Record<string, string>> = {
  hardware: "reinforced",
  pharmacy: "bandage",
  gas_station: "battery",
  police: "lure",
  garage: "spiked-board",
  warehouse: "reinforced",
}

/** What a page looks like on the board and in the world. */
export const PAGE_STYLE: Readonly<Record<string, "flyer" | "chart" | "photo">> = {
  hardware: "flyer",
  warehouse: "flyer",
  pharmacy: "chart",
  gas_station: "flyer",
  police: "photo",
  garage: "photo",
}

export type PageSite = { id: string; buildingId: string; recipe: string; style: "flyer" | "chart" | "photo"; x: number; y: number; z: number; yaw: number }

/** A found page's style as the pin store's `found` count (see `PIN_SOURCES`; 0 is a sketch). */
export const PIN_FOUND: Readonly<Record<PageSite["style"], number>> = { flyer: 1, chart: 2, photo: 3 }

export const pageStoreId = (buildingId: string) => `page:${buildingId}`

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

const PAGE_PROPS: readonly Prop["kind"][] = ["counter", "shelf", "table", "dresser"]
const TOPS: Partial<Record<Prop["kind"], number>> = { counter: 1.02, shelf: 1.8, table: 0.82, dresser: 1.1 }

/** Where a building's page lies: on top of its first counter, shelf, table or dresser, a little off centre. */
export function pageSite(town: Town, b: Building): PageSite | null {
  const recipe = PAGE_BY_ARCHETYPE[b.archetype ?? b.kind]
  if (!recipe) return null
  const inside = (p: Prop) => p.x >= b.rect[0] && p.x <= b.rect[2] && p.y >= b.rect[1] && p.y <= b.rect[3]
  let host: Prop | undefined
  for (const kind of PAGE_PROPS) {
    host = town.props.find((p) => p.kind === kind && inside(p))
    if (host) break
  }
  const shape = host ? propShape(host) : undefined
  const x = host ? host.x : (b.rect[0] + b.rect[2]) / 2
  const y = host ? host.y : (b.rect[1] + b.rect[3]) / 2
  return {
    id: pageStoreId(b.id),
    buildingId: b.id,
    recipe,
    style: PAGE_STYLE[b.archetype ?? b.kind] ?? "flyer",
    x: Number((x + (shape ? (shape.rect[2] - shape.rect[0]) * 0.18 : 0)).toFixed(3)),
    y: Number(y.toFixed(3)),
    z: host ? (TOPS[host.kind] ?? 1) : 0.01,
    yaw: Number((hash01(b.id) * 0.8 - 0.4).toFixed(3)),
  }
}

/**
 * Buildings someone already held out in: one window left reinforced, for a survivor to look at and learn from.
 * Streamed warehouses only. Boards make a window bashable, so a boarded window is a way in for the dead; the classic
 * town's hardware store stays as its horde routes were tuned (it teaches reinforcing with its flyer instead).
 */
export const HELD_OUT_ARCHETYPES: readonly string[] = ["warehouse"]
export const HELD_OUT_PLANKS = 2

/** The window a held-out building was boarded from inside: its southernmost (the face the camera sees), first by id. */
export function heldOutWindow(town: Town, b: Building): string | null {
  if (!b.archetype || !HELD_OUT_ARCHETYPES.includes(b.archetype)) return null
  const windows = town.windows.filter((w) => w.buildingId === b.id)
  windows.sort((p, q) => q.rect[3] - p.rect[3] || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
  return windows[0]?.id ?? null
}

/** Practice at boarding up: how much faster and quieter the next board goes, from nothing to fully practised. */
export const PRACTICE_FULL = 10
export function practiceFactor(practice: number, floor: number): number {
  const k = Math.max(0, Math.min(1, practice / PRACTICE_FULL))
  return 1 - (1 - floor) * k
}

/**
 * A reinforced barricade still shows its strapping while it holds clearly more than plain boards could (a tenth
 * over, so the wire byte's rounding never makes plain boards look reinforced).
 */
export function looksReinforced(planks: number, hp: number, plainHp = 100): boolean {
  return planks > 0 && hp > planks * plainHp * 1.1
}
