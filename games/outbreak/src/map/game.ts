import type { Camera } from "@arcade/kit/client/camera"
import type { CoopSim } from "../../shared/coop-sim"
import type { SessionView } from "../../shared/session"
import type { Vision } from "../../shared/vision"
import { chunkKey, generateWorldChunk } from "../../shared/world"
import type { CoopView } from "../coop-view"
import { SURVIVOR_COLOURS } from "../net-session"
import type { MapFrame } from "./map"
import type { MapVehicle } from "./screen"

export type MapGameInput = {
  session: { readonly view: SessionView; readonly sim: CoopSim }
  coop: CoopView
  vision: Vision
  cam: Camera
  w: number
  h: number
  ground: number
  visionChanged: boolean
  windowChanged: boolean
  /** Overrides the sim's vehicles (proofs). */
  vehicles?: readonly MapVehicle[]
}

const colour = (index: number) => SURVIVOR_COLOURS[index % SURVIVOR_COLOURS.length]!.css

/** Gathers what the map needs from the running game for one frame. Read-only: the map never touches the sim. */
export function gameMapFrame(g: MapGameInput): MapFrame {
  const { session, coop, vision, cam } = g
  const view = session.view
  const sim = session.sim
  const town = view.town
  const stream = sim.worldStream
  const p = coop.pose(view.player)
  const time = view.time
  const seatColour = (seatIndex: number) => colour(coop.net ? coop.net.variantOfSeat(seatIndex) : seatIndex)
  return {
    now: performance.now(),
    time,
    seed: town.seed,
    houseSeed: town.houseSeed,
    mode: stream.mode,
    vision,
    visionChanged: g.visionChanged,
    windowChanged: g.windowChanged,
    source: (cx, cy) => stream.activeChunks.get(chunkKey(cx, cy)) ?? generateWorldChunk(town.seed, town.houseSeed, cx, cy, stream.mode),
    zombies: view.zombies,
    sees: (x, y) => vision.actorVisible(x, y) > 0.3,
    self: {
      x: p.x,
      y: p.y,
      aim: p.aim,
      colour: colour(coop.localVariant),
      name: coop.net || coop.lobby ? coop.localName : "You",
      self: true,
    },
    teammates: coop.others.map((s) => ({
      x: s.survivor.x,
      y: s.survivor.y,
      aim: s.survivor.aim,
      colour: seatColour(s.index),
      name: coop.net ? coop.net.nameOf(s.index) : s.id,
    })),
    pings: view.progression.pings
      .filter((ping) => time < ping.until)
      .map((ping) => ({ x: ping.x, y: ping.y, label: ping.label, colour: seatColour(ping.by), left: ping.until - time })),
    vehicles:
      g.vehicles ??
      sim.vehicles.list.map((v) => ({ x: v.x, y: v.y, heading: v.h, length: v.spec.length, width: v.spec.width, colour: v.wreck ? "#7a6e62" : undefined })),
    project: (x, y, z) => cam.project(x, y, z, g.w, g.h),
    ground: g.ground,
  }
}
