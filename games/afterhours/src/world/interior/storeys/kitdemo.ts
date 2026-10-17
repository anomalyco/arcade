import {
  type Builder,
  type StoreyContext,
  type StoreyHandle,
  G,
  ROOM_BANDS,
  WET_BANDS,
  conferenceTable,
  cubiclePod,
  drenchShower,
  eyewashStation,
  fumeHood,
  kitchenette,
  lockers,
  officeSet,
  partition,
  peninsula,
  rect,
  riserW1,
  room,
  serviceStack,
  spine,
  yawToward,
} from "../api"

/**
 * Kit reference layout (automation `kitdemo=<storey>`): a short worked example of every builder storey agents use —
 * spine with the service stack doors, riser W-1, partitions with doors / glazing / clerestory / cased openings / gaps,
 * rooms with lit fittings and windows, an open-plan cubicle area, a lab with its eyewash and drench shower inside.
 * Copy patterns from here; it is not part of the building.
 */
export async function build(b: Builder, { pause }: StoreyContext): Promise<StoreyHandle> {
  const svc = serviceStack(b)
  riserW1(b)
  const north = [
    { kind: "door" as const, at: -50.0, side: "a" as const, door: { id: "N1", state: "open" as const, room: "N1", sign: { number: "101", label: "OFFICE" } } },
    { kind: "glazed" as const, from: -36.0, to: -27.5, blinds: true },
    { kind: "door" as const, at: -27.0, side: "a" as const, door: { id: "N2", state: "closed" as const, room: "N2" } },
    { kind: "gap" as const, from: -15.4, to: 0.8 },
    { kind: "door" as const, at: 3.0, side: "a" as const, door: { id: "LAB", state: "closed" as const, room: "LAB" } },
  ]
  const south = [...svc.spineOpenings, { kind: "clerestory" as const, from: -20.0, to: -6.0, sill: 1.0 }, { kind: "cased" as const, from: 2.0, to: 3.6 }]
  const sp = spine(b, { north, south, nightCircuit: 3 })
  await pause()

  // North bays: a private office, a glazed conference room, an open plan area, a lab.
  const n1 = room(b, { id: "N1", name: "Private office", rect: rect(G[0], G[1], -21.65, -1.75), lit: [[-51, -16]], windows: { radiators: "models" } })
  partition(b, { axis: "z", at: G[1], from: -21.65, to: -1.75, finish: [ROOM_BANDS, ROOM_BANDS] })
  officeSet(b, -51.2, -16.5, yawToward(0, 1), { lamp: true })
  const n2 = room(b, { id: "N2", name: "Conference", rect: rect(G[3], G[5], -11.85, -1.75), lit: "all" })
  partition(b, { axis: "z", at: G[3], from: -11.85, to: -1.75, finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, { axis: "x", at: -11.925, from: G[3], to: G[5], finish: [ROOM_BANDS, ROOM_BANDS], openings: [{ kind: "door", at: -30.0, side: "a", door: { id: "N2b", state: "janitor" } }] })
  partition(b, { axis: "z", at: G[5], from: -21.65, to: -1.75, finish: [ROOM_BANDS, ROOM_BANDS] })
  conferenceTable(b, -31.6, -6.8, 0, 12)
  await pause()
  const open = room(b, { id: "OPEN", name: "Open office", rect: rect(G[7], G[10], -21.65, -1.75), lit: [[-12, -8], [-3, -16]] })
  for (const x of [-12.7, -7.3, -1.9]) cubiclePod(b, x, -7.2, 0, { tubes: [1] })
  cubiclePod(b, -7.3, -16.6, 0)
  partition(b, { axis: "z", at: G[10], from: -21.65, to: -1.75, finish: [ROOM_BANDS, WET_BANDS] })
  const lab = room(b, { id: "LAB", name: "Lab", rect: rect(G[10], G[12], -21.65, -1.75), floor: "linoleum", lit: [[3, -8], [9, -8]] })
  partition(b, { axis: "z", at: G[12], from: -21.65, to: -1.75, finish: [WET_BANDS, ROOM_BANDS] })
  peninsula(b, 4.5, -10.5, Math.PI / 2, 3.6, { sink: true })
  peninsula(b, 8.5, -10.5, Math.PI / 2, 3.6)
  fumeHood(b, 6.2, -20.8, Math.PI, true)
  eyewashStation(b, 1.15, -3.0, -Math.PI / 2)
  drenchShower(b, 1.6, -4.2, -Math.PI / 2)
  await pause()
  // South: break room off the cased opening, lockers.
  const brk = room(b, { id: "BREAK", name: "Break room", rect: rect(G[9], G[11], 1.75, 9.6), lit: "all" })
  partition(b, { axis: "x", at: 9.675, from: G[9], to: G[11], finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, { axis: "z", at: G[9], from: 1.75, to: 9.6, finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, { axis: "z", at: G[11], from: 1.75, to: 9.6, finish: [ROOM_BANDS, ROOM_BANDS] })
  kitchenette(b, -1.0, 9.6 - 0.31, 0, 2.4, { coffeeOn: true })
  lockers(b, 5.5, 2.0, Math.PI, 5)
  const rooms = [n1, n2, open, lab, brk]
  return { update: (t) => [sp, ...rooms].forEach((r) => r.update(t)) }
}
