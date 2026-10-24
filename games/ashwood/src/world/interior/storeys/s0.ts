import { MODELS } from "../../../render/models"
import {
  type Builder,
  type RoomHandle,
  type StoreyContext,
  type StoreyHandle,
  CEIL_Y,
  FLOOR_Y,
  SHELL,
  STYLES,
  WINDOWS,
  dressWindow,
  placeModels,
  serviceStack,
  spine,
  wall,
} from "../api"
import { Docs, conduit, hazardLight, rng } from "./s0/common"
import { buildEast } from "./s0/east"
import { buildLink, buildLobby } from "./s0/lobby"
import { buildSouth } from "./s0/south"
import { buildWest, door } from "./s0/west"

/**
 * Storey 0 — front of house, security, receiving, food (docs/building-program.md §2, storey 0). One spine runs the
 * whole block (x −54.65..34.65, concept r3-02 finish); the lobby (r5-02) opens north up the link to the junction
 * landmark. North of the spine, west to east: staff entrance + time clock, health unit, change rooms, decon showers,
 * clean side, freight lift FL-1, receiving, the intake lab (r5-05) and core store, reprographics, mail, PBX, building
 * control, dry stores. South: facilities office and workshop (the player's base), the service stack, the briefing
 * auditorium, personnel, the lobby, the guard ready room, the security office (r4-08) and the cafeteria (r4-03).
 * Room files: s0/west.ts, s0/south.ts, s0/east.ts, s0/lobby.ts; local helpers in s0/common.ts.
 */
export async function build(b: Builder, { pause }: StoreyContext): Promise<StoreyHandle> {
  const docs = new Docs()
  const st = STYLES[0]!
  // Service stack (EL-0, TC-0, WCs, JC-0 — the closet the night janitor works from —, store, fountain).
  const svc = serviceStack(b)
  const north = [
    door(-52.2, "b", { id: "0-10", state: "open", room: "0-10", sign: { number: "0-10", label: "STAFF ENTRANCE" } }),
    door(-46.0, "b", { id: "0-12", state: "closed", room: "0-12", sign: { number: "0-12", label: "MEN · CHANGE" } }),
    door(-40.0, "b", { id: "0-13", state: "closed", room: "0-13", sign: { number: "0-13", label: "WOMEN · CHANGE" } }),
    door(-28.0, "b", { id: "0-16", state: "open", room: "0-16b", double: true, open: 1.45, sign: { number: "0-16", label: "RECEIVING" } }),
    door(-21.0, "b", { id: "0-17", state: "open", room: "0-17", open: 1.6, sign: { number: "0-17", label: "SAMPLE INTAKE" } }),
    door(-14.0, "b", { id: "0-18", state: "closed", room: "0-18", sign: { number: "0-18", label: "REPROGRAPHICS" } }),
    door(3.5, "b", { id: "0-19", state: "closed", room: "0-19", dutch: true, sign: { number: "0-19", label: "MAIL" } }),
    door(9.0, "b", { id: "0-20", state: "closed", room: "0-20", sign: { number: "0-20", label: "PBX" } }),
    door(13.6, "b", { id: "0-21", state: "janitor", room: "0-21", sign: { number: "0-21", label: "BUILDING CONTROL" } }),
    door(24.6, "b", { id: "0-22", state: "closed", room: "0-22", sign: { number: "0-22", label: "DRY STORES" } }),
  ]
  const south = [
    ...svc.spineOpenings,
    door(-51.0, "a", { id: "0-30", state: "open", room: "0-30", sign: { number: "0-30", label: "FACILITIES" } }),
    door(-23.5, "a", { id: "0-35f", state: "open", room: "0-35f", double: true, open: 1.5, sign: { number: "0-35", label: "AUDITORIUM" } }),
    door(-17.0, "a", { id: "0-36", state: "closed", room: "0-36", sign: { number: "0-36", label: "PERSONNEL" } }),
    { kind: "gap" as const, from: -1.6, to: 1.6 },
    door(5.0, "a", { id: "0-37", state: "closed", room: "0-37", sign: { number: "0-37", label: "GUARD ROOM" } }),
    door(19.0, "a", { id: "0-39", state: "open", room: "0-39s", double: true, open: 1.5, sign: { number: "0-39", label: "CAFETERIA" } }),
    door(30.0, "a", { id: "0-39k", state: "closed", room: "0-39k", sign: { number: "0-39K", label: "KITCHEN" } }),
  ]
  const sp = spine(b, {
    north,
    south,
    nightCircuit: 2,
    intensity: 7,
    flicker: [
      { x: -30, amount: 0.85 },
      { x: -33, amount: 0.65 },
    ],
    west: "open",
    extinguishers: [
      { x: -19.0, side: "north" },
      { x: 17.4, side: "south" },
    ],
    // Fire-door baffles, door halves alternating: no straight line down the 89 m spine.
    baffles: [
      { x: -48.5, side: "south", swing: 1 },
      { x: -37.5, side: "north", swing: -1 },
      { x: -7.5, side: "south", swing: -1 },
      { x: 16.5, side: "north", swing: 1 },
    ],
  })
  // West end: the facade window at the end of the corridor (blind down), tiled lining.
  const endWin = WINDOWS(0, "west").filter((w) => w.u0 > -2 && w.u1 < 2)
  wall(b, "z", -1.6, 1.6, SHELL.x0, SHELL.x0 + 0.04, st.bands, endWin.map((w) => ({ a0: -1.6, a1: 1.6, bottom: w.sill, top: w.head })), { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  for (const w of endWin) dressWindow(b, w, { blinds: "closed", radiators: "convector" }, rng(5))
  // Corridor character kept from r3-02: exposed conduit along both wall tops, caged hazard lights, the CCTV camera.
  conduit(b, SHELL.x0 + 0.2, SHELL.x1 - 0.2, -1.6, 1)
  conduit(b, SHELL.x0 + 0.2, -1.8, 1.6, -1)
  conduit(b, 1.8, SHELL.x1 - 0.2, 1.6, -1)
  hazardLight(b, -18.0, -1.6, false)
  hazardLight(b, -36.5, -1.6, false)
  hazardLight(b, -49.6, -1.6, true)
  hazardLight(b, 21.4, -1.6, false)
  placeModels(b, "security_camera", [{ position: [-12.5, 2.62, 1.6 - MODELS.security_camera.size[2] / 2], yaw: 0.55, collide: false }])
  placeModels(b, "wet_floor_sign", [{ position: [-30.6, FLOOR_Y, 0.9], yaw: 0.5, inset: 0.05 }])
  // Spine paper: evacuation maps by the hall and the junction, a notice board outside the cafeteria.
  docs.wall("map_evac_0", -43.6, FLOOR_Y + 1.5, -1.598, 0, 1, { pin: "tack" })
  docs.wall("map_evac_0", 12.0, FLOOR_Y + 1.5, 1.598, 0, -1, { pin: "tack" })
  docs.wall("notice_firedoors", -36.3, FLOOR_Y + 1.55, 1.598, 0, -1, { pin: "tape" })
  docs.wall("menu_cafeteria", 21.0, FLOOR_Y + 1.5, 1.598, 0, -1, { pin: "tape" })
  await pause()

  const rooms: RoomHandle[] = []
  buildLobby(b, docs)
  buildLink(b, docs)
  await pause()
  rooms.push(...(await buildWest(b, docs, pause)))
  await pause()
  rooms.push(...(await buildSouth(b, docs, pause)))
  await pause()
  rooms.push(...(await buildEast(b, docs, pause)))
  docs.flush(b)

  return {
    update: (t) => {
      sp.update(t)
      for (const r of rooms) r.update(t)
    },
    proxy: null,
  }
}

