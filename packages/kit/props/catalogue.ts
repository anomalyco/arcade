/**
 * The furniture and prop catalogue: one entry per prop, shared by every game.
 *
 * Model space: metres, +Y up, the prop's front faces +Z and its back sits at -Z, so a wall piece is placed with its
 * back to the wall. The pivot is the centre of the footprint on the floor (y = 0). `size` is the real-world bounding
 * box [width (x), height (y), depth (z)] the pipeline scales the generated mesh to (`scripts/props/`).
 *
 * Meshes are generated (image → TRELLIS.2 → Blender cleanup) and shipped as `assets/<id>.prop` (see `format.ts`).
 * Everything here is plain data; it never touches the GPU, so `shared/` code may import it.
 */

/** Where a prop goes: against a wall, free on the floor, in a corner, or on a table/counter top. */
export type PropPlacement = "wall" | "floor" | "corner" | "tabletop"
/** Room themes the seeded furnisher draws from. */
export type PropRoom = "living" | "dining" | "kitchen" | "bedroom" | "study" | "hall" | "store" | "any"
/** Anchor props are the large pieces a room is planned around; clutter fills surfaces and floor. */
export type PropRole = "anchor" | "clutter"

export type PropSpec = {
  id: string
  label: string
  /** Bounding box in metres: [width x, height y, depth z]. */
  size: readonly [number, number, number]
  role: PropRole
  placement: PropPlacement
  rooms: readonly PropRoom[]
  /** Height (m) of a usable top surface for tabletop clutter, if any. */
  surface?: number
  /** Triangle budgets for LOD0 (close) and LOD1 (far). */
  lod: readonly [number, number]
}

const anchor = (id: string, label: string, size: PropSpec["size"], placement: PropPlacement, rooms: PropRoom[], lod: PropSpec["lod"], surface?: number): PropSpec =>
  ({ id, label, size, role: "anchor", placement, rooms, lod, surface })
const clutter = (id: string, label: string, size: PropSpec["size"], placement: PropPlacement, rooms: PropRoom[], lod: PropSpec["lod"] = [600, 200]): PropSpec =>
  ({ id, label, size, role: "clutter", placement, rooms, lod })

export const PROP_SPECS: readonly PropSpec[] = [
  anchor("chesterfield-sofa", "Chesterfield sofa", [2.2, 0.82, 0.9], "wall", ["living", "study"], [3000, 900]),
  anchor("leather-armchair", "Leather armchair", [0.92, 0.98, 0.88], "floor", ["living", "study", "bedroom"], [2200, 700]),
  anchor("coffee-table", "Coffee table", [1.2, 0.46, 0.65], "floor", ["living"], [1400, 400], 0.46),
  anchor("bookcase", "Bookcase", [1.1, 1.95, 0.38], "wall", ["living", "study", "hall", "bedroom"], [3000, 900]),
  anchor("sideboard", "Sideboard", [1.4, 0.86, 0.5], "wall", ["living", "dining", "hall"], [1800, 500], 0.86),
  anchor("dining-table", "Dining table", [1.5, 0.76, 0.9], "floor", ["dining", "kitchen"], [1600, 500], 0.76),
  anchor("dining-chair", "Dining chair", [0.48, 1.0, 0.5], "floor", ["dining", "kitchen", "study"], [1200, 400]),
  anchor("kitchen-counter", "Kitchen counter", [1.8, 0.92, 0.65], "wall", ["kitchen"], [2400, 700], 0.92),
  anchor("fridge-1970s", "1970s fridge", [0.76, 1.7, 0.72], "wall", ["kitchen"], [1400, 400]),
  anchor("stove", "Enamel stove", [0.76, 0.92, 0.66], "wall", ["kitchen"], [1800, 500], 0.92),
  anchor("bed", "Wooden bed", [1.5, 1.1, 2.1], "wall", ["bedroom"], [3000, 900], 0.6),
  anchor("dresser", "Dresser", [1.2, 1.05, 0.5], "wall", ["bedroom", "hall"], [1800, 500], 1.05),
  anchor("nightstand", "Nightstand", [0.5, 0.62, 0.42], "wall", ["bedroom"], [1000, 300], 0.62),
  anchor("grandfather-clock", "Grandfather clock", [0.52, 2.05, 0.32], "wall", ["hall", "living", "study"], [1600, 500]),
  anchor("upright-piano", "Upright piano", [1.48, 1.25, 0.6], "wall", ["living", "study"], [2400, 700], 1.25),
  anchor("tv-set", "1970s TV set", [0.82, 0.82, 0.5], "wall", ["living"], [1400, 400], 0.82),
  anchor("radiator", "Cast-iron radiator", [0.75, 0.72, 0.2], "wall", ["any"], [1200, 400]),
  clutter("table-lamp", "Brass table lamp", [0.32, 0.56, 0.32], "tabletop", ["living", "bedroom", "study", "hall"]),
  clutter("potted-plant", "Cracked plant pot", [0.42, 0.5, 0.42], "corner", ["living", "hall", "study"], [1200, 400]),
  clutter("wooden-crate", "Wooden crate", [0.62, 0.48, 0.5], "floor", ["store", "kitchen", "hall", "any"], [500, 150]),
  clutter("cardboard-boxes", "Cardboard boxes", [0.66, 0.62, 0.5], "floor", ["store", "bedroom", "hall", "any"], [850, 250]),
  clutter("book-stack", "Stack of books", [0.3, 0.2, 0.24], "tabletop", ["living", "study", "bedroom"], [400, 120]),
  clutter("bottles", "Bottles", [0.3, 0.32, 0.16], "tabletop", ["kitchen", "dining", "living"]),
  clutter("typewriter", "Typewriter", [0.46, 0.2, 0.4], "tabletop", ["study", "living"]),
  clutter("rotary-phone", "Rotary phone", [0.22, 0.14, 0.24], "tabletop", ["hall", "living", "study"], [400, 120]),
  clutter("plate-stack", "Dirty plates", [0.3, 0.12, 0.3], "tabletop", ["kitchen", "dining"], [400, 120]),
]

export const PROP_IDS = PROP_SPECS.map(s => s.id)
const byId = new Map(PROP_SPECS.map(s => [s.id, s]))

export function propSpec(id: string): PropSpec {
  const s = byId.get(id)
  if (!s) throw new Error(`unknown prop ${id}`)
  return s
}
