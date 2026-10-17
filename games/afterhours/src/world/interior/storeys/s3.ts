import { type Builder, type POpening, type StoreyContext, type StoreyHandle, FLOOR_Y, M, T, beacon, serviceStack, spine } from "../api"
import { S3 } from "./s3/common"
import { buildNorth } from "./s3/north"
import { buildSouth } from "./s3/south"

/**
 * Storey 3 — Computing & Signal Processing Centre (building program §2). North of the spine: data control, keypunch,
 * UPS, the glazed machine room (raised floor, tape drives, processor and disk strings, CRACs, halon) with its secure
 * tape library and operations console, the plotter room, the listening room under the dish (riser W-1, recorders,
 * scopes, the booth), and the open analysis bullpen. South: the service stack, operators' rest room, the computing
 * manager, the terminal pool behind a glazed corridor wall, and the programmers' wing with its racetrack corridor.
 */
export async function build(b: Builder, { pause }: StoreyContext): Promise<StoreyHandle> {
  const s = new S3(b)
  const svc = serviceStack(b)

  const north: POpening[] = [
    { kind: "door", at: -50.5, side: "b", door: { id: "3-01", state: "closed", room: "3-01", dutch: true, sign: { number: "3-01", label: "DATA CONTROL" } } },
    { kind: "door", at: -44.5, side: "b", door: { id: "3-02", state: "closed", room: "3-02", sign: { number: "3-02", label: "KEYPUNCH" } } },
    { kind: "door", at: -34.3, side: "b", door: { id: "3-03", state: "keycard:server", room: "3-03", glass: "none", sign: { number: "3-03", label: "HIGH VOLTAGE" } } },
    { kind: "glazed", from: -30.0, to: -18.95, sill: 0.9, head: 2.3, mullion: 1.2 },
    { kind: "door", at: -18.0, side: "b", door: { id: "3-04", state: "keycard:server", room: "3-04", double: true, sign: { number: "3-04", label: "COMPUTER ROOM" } } },
    { kind: "glazed", from: -17.05, to: -6.0, sill: 0.9, head: 2.3, mullion: 1.2 },
    { kind: "door", at: -2.5, side: "b", door: { id: "3-07", state: "closed", room: "3-07", sign: { number: "3-07", label: "PLOTTERS" } } },
    { kind: "door", at: 2.8, side: "b", door: { id: "3-08", state: "open", room: "3-08", open: 1.25, sign: { number: "3-08", label: "SIGNAL ANALYSIS" } } },
    { kind: "gap", from: 13.0, to: 33.0 },
  ]
  const south: POpening[] = [
    ...svc.spineOpenings,
    { kind: "door", at: -49.0, side: "a", door: { id: "3-20", state: "closed", room: "3-20", sign: { number: "3-20", label: "OPERATORS" } } },
    { kind: "glazed", from: -25.9, to: -20.95, sill: 1.1, head: 2.3, mullion: 1.25 },
    { kind: "door", at: -20.0, side: "a", door: { id: "3-24", state: "open", room: "3-24", sign: { number: "3-24", label: "TERMINALS" } } },
    { kind: "glazed", from: -19.05, to: -8.95, sill: 1.1, head: 2.3, mullion: 1.25 },
    { kind: "door", at: -8.0, side: "a", door: { id: "3-24b", state: "open", room: "3-24" } },
    { kind: "glazed", from: -7.05, to: -4.85, sill: 1.1, head: 2.3 },
    { kind: "cased", from: 0.86, to: 2.64 },
    { kind: "door", at: 5.0, side: "a", door: { id: "3-25p", state: "open", room: "3-25p", sign: { number: "3-25P", label: "PRINT ROOM" } } },
    { kind: "cased", from: 13.0, to: 14.8 },
    { kind: "door", at: 30.0, side: "a", door: { id: "3-25s", state: "janitor", room: "3-25s", sign: { number: "3-25S", label: "SUPPLIES" } } },
  ]
  const lit: number[] = []
  for (let x = -30; x <= -6; x += 3) lit.push(x)
  const sp = spine(b, {
    north,
    south,
    nightCircuit: 3,
    lit,
    intensity: 6,
    raised: [[-31.6, -4.6]],
    tray: true,
    extinguishers: [{ x: 9.8, side: "north" }, { x: -24.0, side: "south" }],
    bulletins: [{ x: -39.5, side: "north" }, { x: 9.0, side: "south" }],
  })
  // Halon discharge beacons over the machine-room doors (amber lit: system armed; red: discharge, off).
  b.box(M.darkSteel, -18.75, FLOOR_Y + 2.38, -1.6, -17.25, FLOOR_Y + 2.42, -1.48)
  beacon(b, -18.4, FLOOR_Y + 2.42, -1.54, "amber")
  beacon(b, -17.6, FLOOR_Y + 2.42, -1.54, "red", false)
  b.rbox(M.safety, T(-16.75, FLOOR_Y + 1.6, -1.594), 0.32, 0.42, 0.012, 0.004)
  b.box(M.felt, -16.88, FLOOR_Y + 1.44, -1.588, -16.62, FLOOR_Y + 1.76, -1.584, { cast: false })
  s.doc("map_evac_3", [-37.6, FLOOR_Y + 1.55, -1.598], [0, 0, 1], { pin: "tape" })
  s.doc("plate_el3", [-45.68, FLOOR_Y + 1.5, 1.586], [0, 0, -1], { pin: "none", scale: 0.75, curl: 0 })
  s.doc("plate_jc", [-32.68, FLOOR_Y + 1.5, 1.586], [0, 0, -1], { pin: "none", scale: 0.75, curl: 0 })
  await pause()

  await buildNorth(s, pause)
  await pause()
  await buildSouth(s, pause)
  s.flushDocs()

  const rooms = s.rooms
  return {
    update(t) {
      sp.update(t)
      for (const r of rooms) r.update(t)
    },
    proxy: null,
  }
}
