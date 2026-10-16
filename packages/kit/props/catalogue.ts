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
  /** A lamp's shade starts at this fraction of the height: faces above it can glow (`PropModelOptions.lampAux`). */
  shade?: number
}

const anchor = (id: string, label: string, size: PropSpec["size"], placement: PropPlacement, rooms: PropRoom[], lod: PropSpec["lod"], surface?: number): PropSpec =>
  ({ id, label, size, role: "anchor", placement, rooms, lod, surface })
const clutter = (id: string, label: string, size: PropSpec["size"], placement: PropPlacement, rooms: PropRoom[], lod: PropSpec["lod"] = [3000, 600]): PropSpec =>
  ({ id, label, size, role: "clutter", placement, rooms, lod })

export const PROP_SPECS: readonly PropSpec[] = [
  anchor("chesterfield-sofa", "Chesterfield sofa", [2.2, 0.82, 0.9], "wall", ["living", "study"], [12000, 3000]),
  anchor("leather-armchair", "Leather armchair", [0.92, 0.98, 0.88], "floor", ["living", "study", "bedroom"], [9000, 2200]),
  anchor("coffee-table", "Coffee table", [1.2, 0.46, 0.65], "floor", ["living"], [6000, 1500], 0.46),
  anchor("bookcase", "Bookcase", [1.1, 1.95, 0.38], "wall", ["living", "study", "hall", "bedroom"], [14000, 3500]),
  anchor("sideboard", "Sideboard", [1.4, 0.86, 0.5], "wall", ["living", "dining", "hall"], [9000, 2200], 0.86),
  anchor("dining-table", "Dining table", [1.5, 0.76, 0.9], "floor", ["dining", "kitchen"], [6000, 1500], 0.76),
  anchor("dining-chair", "Dining chair", [0.48, 1.0, 0.5], "floor", ["dining", "kitchen", "study"], [6000, 1500]),
  anchor("kitchen-counter", "Kitchen counter", [1.8, 0.92, 0.65], "wall", ["kitchen"], [12000, 3000], 0.92),
  anchor("fridge-1970s", "1970s fridge", [0.76, 1.7, 0.72], "wall", ["kitchen"], [6000, 1500]),
  anchor("stove", "Enamel stove", [0.76, 0.92, 0.66], "wall", ["kitchen"], [9000, 2200], 0.92),
  anchor("bed", "Wooden bed", [1.5, 1.1, 2.1], "wall", ["bedroom"], [15000, 4000], 0.6),
  anchor("dresser", "Dresser", [1.2, 1.05, 0.5], "wall", ["bedroom", "hall"], [9000, 2200], 1.05),
  anchor("nightstand", "Nightstand", [0.5, 0.62, 0.42], "wall", ["bedroom"], [6000, 1500], 0.62),
  anchor("grandfather-clock", "Grandfather clock", [0.52, 2.05, 0.32], "wall", ["hall", "living", "study"], [8000, 2000]),
  anchor("upright-piano", "Upright piano", [1.48, 1.25, 0.6], "wall", ["living", "study"], [12000, 3000], 1.25),
  anchor("tv-set", "1970s TV set", [0.82, 0.82, 0.5], "wall", ["living"], [7000, 1800], 0.82),
  anchor("radiator", "Cast-iron radiator", [0.75, 0.72, 0.2], "wall", ["any"], [7000, 1800]),
  { ...clutter("table-lamp", "Brass table lamp", [0.31, 0.59, 0.31], "tabletop", ["living", "bedroom", "study", "hall"]), shade: 0.48 },
  clutter("potted-plant", "Dead potted plant", [0.5, 0.76, 0.49], "corner", ["living", "hall", "study"], [4000, 800]),
  clutter("wooden-crate", "Wooden crate", [0.49, 0.49, 0.61], "floor", ["store", "kitchen", "hall", "any"], [2000, 400]),
  clutter("cardboard-boxes", "Cardboard boxes", [0.6, 0.76, 0.45], "floor", ["store", "bedroom", "hall", "any"], [3000, 600]),
  clutter("book-stack", "Stack of books", [0.28, 0.21, 0.24], "tabletop", ["living", "study", "bedroom"], [3000, 600]),
  clutter("bottles", "Bottles", [0.25, 0.3, 0.21], "tabletop", ["kitchen", "dining", "living"]),
  clutter("typewriter", "Typewriter", [0.48, 0.2, 0.38], "tabletop", ["study", "living"]),
  clutter("rotary-phone", "Rotary phone", [0.24, 0.16, 0.19], "tabletop", ["hall", "living", "study"], [3000, 600]),
  clutter("plate-stack", "Dirty plates", [0.27, 0.16, 0.26], "tabletop", ["kitchen", "dining"], [3000, 600]),
]

export const PROP_IDS = PROP_SPECS.map(s => s.id)
const byId = new Map(PROP_SPECS.map(s => [s.id, s]))

export function propSpec(id: string): PropSpec {
  const s = byId.get(id)
  if (!s) throw new Error(`unknown prop ${id}`)
  return s
}
