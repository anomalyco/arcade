import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Lit rooms behind the windows (Lab › Look · Lit rooms; on by default since Kit's pick, D-51, `windowRoomStyle` 0 is Today): the Lot's interior mapping (#356,
 * van Dongen's ray–box room behind each pane) on Outbreak's house glass, drawn analytically instead of from an atlas:
 * floor, back and side walls and ceiling of a room box behind the wall, lit from the house's own room lamp
 * (`resolveLampLight`'s per-room practicals: the living room and kitchen behind the front windows), so a pane looks
 * into a lamp pool on the floor with depth that slides as the camera passes. Only houses with a lamp left on
 * (`look/lit-windows.ts`) light up, and inside those each room's lamp is on or off by a stable roll, so neighbouring
 * panes into the same room agree.
 */
export type OutbreakWindowRoomSettings = {
  /** 0 Today (flat tungsten glass), 1 rooms behind the glass (default). */
  windowRoomStyle: number
  /** Room depth behind the wall, metres. */
  roomDepth: number
  /** Lamp pool brightness, × Today's lit glass. */
  roomBrightness: number
  /** Share of a lit house's rooms whose lamp is on. */
  roomLitShare: number
  /** How much half-drawn curtains cover the pane. */
  roomCurtains: number
  /** Light on the far walls (wall wash), × the floor pool. */
  roomWalls: number
}

export const DEFAULT_WINDOW_ROOM_SETTINGS: OutbreakWindowRoomSettings = {
  windowRoomStyle: 1,
  roomDepth: 3.4,
  roomBrightness: 1,
  roomLitShare: 0.75,
  roomCurtains: 0.6,
  roomWalls: 0.7,
}

const G = "Look · Lit rooms"

export const windowRoomControls: readonly LabControl[] = [
  {
    key: "windowRoomStyle",
    label: "Lit windows",
    group: G,
    type: "select",
    options: [
      { value: 0, label: "Today (flat tungsten glass)" },
      { value: 1, label: "Rooms behind the glass" },
    ],
  },
  { key: "roomDepth", label: "Room depth", group: G, min: 1, max: 6, step: 0.1, unit: "m" },
  { key: "roomBrightness", label: "Room light", group: G, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "roomLitShare", label: "Rooms with the lamp on", group: G, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "roomCurtains", label: "Curtains", group: G, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "roomWalls", label: "Wall wash", group: G, min: 0, max: 2, step: 0.05, unit: "×" },
]

export const WINDOW_ROOM_UNIFORM_FLOATS = 8

/** (on, depth, brightness, lit share), (curtains, walls, 0, 0). */
export function packWindowRoomUniforms(s: OutbreakWindowRoomSettings | undefined, out: Float32Array, offset: number): void {
  const v = s ?? DEFAULT_WINDOW_ROOM_SETTINGS
  out.set([v.windowRoomStyle > 0.5 ? 1 : 0, v.roomDepth, v.roomBrightness, v.roomLitShare], offset)
  out.set([v.roomCurtains, v.roomWalls, 0, 0], offset + 4)
}
