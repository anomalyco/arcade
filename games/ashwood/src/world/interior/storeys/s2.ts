import { type Builder, type POpening, type StoreyContext, type StoreyHandle, FLOOR_Y, serviceStack, spine } from "../api"
import { type K, flushDocs, hazardDiamond, plate, wallDoc } from "./s2/props"
import { buildNorth } from "./s2/north"
import { buildSouth } from "./s2/south"

/**
 * Storey 2 — Sample Sciences (docs/building-program.md §2): lab suites off the spine, every eyewash and drench shower
 * inside its lab within 3 m of the exit (none in the corridor), the cold room, specimen archive, darkroom, containment
 * suite with its observation window (the floor's landmark at the east end), Analytical Lab 4 lit with the hot-plate
 * vignette, 2-04's hood glowing on the north facade. Rooms are in s2/north.ts and s2/south.ts; bench clutter and
 * paperwork go into a second builder flushed into `b.small` (camera storey only).
 */
export async function build(b: Builder, { pause }: StoreyContext): Promise<StoreyHandle> {
  let seed = 20402
  const k: K = { b, s: b.smallBuilder, docs: [], rnd: () => ((seed = (seed * 16807) % 2147483647) / 2147483647), updates: [] }
  const svc = serviceStack(b)
  const door = (at: number, side: "a" | "b", id: string, state: "open" | "closed" | `keycard:${string}`, label: string): POpening => ({
    kind: "door",
    at,
    side,
    door: { id, state, room: id, sign: { number: id, label } },
  })
  const north: POpening[] = [
    door(-50.0, "b", "2-01", "keycard:chemkey", "CHEMICAL STORE"),
    door(-45.0, "b", "2-03", "open", "INSTRUMENTS"),
    door(-40.0, "b", "2-04", "closed", "GEOCHEMISTRY 2"),
    door(-29.0, "b", "2-05", "closed", "MICROBIOLOGY"),
    { kind: "glazed", from: -25.7, to: -23.9, sill: 1.0, head: 2.0 },
    door(-17.0, "b", "2-06", "closed", "COLD ROOM"),
    door(-10.0, "b", "2-07", "closed", "SPECIMEN ARCHIVE"),
    door(-2.0, "b", "2-08", "open", "LAB MANAGER"),
    door(15.2, "b", "2-09a", "closed", "DARKROOM"),
    door(19.7, "b", "2-10a", "keycard:containment", "CONTAINMENT"),
    { kind: "glazed", from: 24.0, to: 32.0, sill: 0.9, head: 2.1, mullion: 2.0 },
  ]
  const south: POpening[] = [
    ...svc.spineOpenings,
    door(-51.0, "a", "2-20", "closed", "LAB SAFETY"),
    door(-23.5, "a", "2-24f", "closed", "TEACHING LAB"),
    door(-13.0, "a", "2-25", "open", "ELECTRONICS"),
    { kind: "cased", from: -3.4, to: -0.2 },
    door(8.0, "a", "2-27", "open", "ANALYTICAL 4"),
    door(20.0, "a", "2-27b", "closed", "ANALYTICAL 4"),
    { kind: "door", at: 26.0, side: "a", door: { id: "2-28", state: "open", room: "2-28", open: 1.5, sign: { number: "2-28", label: "GLASSWASH" } } },
  ]
  const sp = spine(b, {
    north,
    south,
    nightCircuit: 2,
    flicker: [
      { x: -18, amount: 0.6 },
      { x: 12, amount: 0.35 },
    ],
    extinguishers: [
      { x: -41.4, side: "north" },
      { x: -27.6, side: "north" },
      { x: 9.6, side: "south" },
      { x: 18.2, side: "north" },
    ],
    // Fire-door baffles, door halves alternating: no straight line down the spine.
    baffles: [
      { x: -37.5, side: "north", swing: -1 },
      { x: -20.5, side: "south", swing: 1 },
      { x: 4.5, side: "north", swing: 1 },
      { x: 22.5, side: "south", swing: -1 },
    ],
  })
  // Corridor signage: hazard diamond at the chem store, evacuation maps, notices (doors' own plates are the kit's).
  hazardDiamond(b, -48.85, FLOOR_Y + 1.75, -1.598, 0, 1)
  plate(b, -48.85, FLOOR_Y + 1.42, -1.598, 0, 1, 0.3, 0.09, undefined, "sign_chem_store")
  wallDoc(k, "map_evac_2", -36.6, FLOOR_Y + 1.5, -1.598, 0, 1, { pin: "tape" })
  wallDoc(k, "map_evac_2", 30.4, FLOOR_Y + 1.5, 1.598, 0, -1, { pin: "tape" })
  wallDoc(k, "notice_firedoors", -53.6, FLOOR_Y + 1.5, -1.598, 0, 1, { pin: "tape" })
  wallDoc(k, "notice_north_array", 23.2, FLOOR_Y + 1.55, -1.598, 0, 1, { pin: "tack" })
  wallDoc(k, "poster_chemical", -7.0, FLOOR_Y + 1.5, 1.598, 0, -1, { pin: "tape" })
  await pause()

  const rooms = [...(await buildNorth(k, pause))]
  await pause()
  rooms.push(...(await buildSouth(k, pause)))
  await pause()

  flushDocs(k)
  const ups = [sp.update, ...rooms.map((r) => r.update), ...k.updates]
  return { update: (t) => ups.forEach((u) => u(t)), proxy: null }
}
