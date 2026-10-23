import type { FlightModule } from "../flight/seam"
import { BIRDS, Birds } from "../render/birds"
import { CANOPY_RAIN, CanopyRain } from "../render/canopy-rain"
import type { Renderer } from "../render/renderer"
import type { Archipelago } from "../../shared/islands"
import { planeSpeed } from "../../shared/plane"

/** What `Life.update` reads each frame from the game. */
export type LifeFrame = {
  dt: number
  playing: boolean
  eye: ArrayLike<number>
  fov: number
  width: number
  height: number
  /** Weather rain × density (0..2). */
  rain: number
  frame: Float32Array
}

/**
 * Life around you: seabirds over the island shores (src/render/birds.ts) and rain on the canopy and the chase camera's
 * lens (src/render/canopy-rain.ts). One object so main.ts wires it in a few lines.
 */
export class Life {
  readonly birds: Birds
  readonly canopyRain: CanopyRain
  /** The live settings (the dev panel's rows), for scripts: `carrier.life.settings.birds.span = 4`. */
  readonly settings = { birds: BIRDS, canopyRain: CANOPY_RAIN }
  private jets: number[] = []
  private ships: number[] = []

  constructor(renderer: Renderer, private flight: FlightModule) {
    this.birds = new Birds(renderer)
    renderer.addPass("opaque", this.birds)
    this.canopyRain = new CanopyRain(renderer)
    renderer.addPass("alpha", this.canopyRain)
  }

  setWorld(arch: Archipelago): void {
    this.birds.setWorld(arch)
  }

  update(v: LifeFrame): void {
    const f = this.flight.flight
    const w = this.flight.weapons
    const inJet = f.phase !== "idle"
    const flying = f.phase === "flying" || f.phase === "landing"

    // What scares the birds: every jet in the air (ours included) and every carrier.
    const jets = this.jets
    jets.length = 0
    if (flying) jets.push(f.plane.x, f.plane.y, f.plane.z)
    for (const j of w.jets.values()) if (j.alive) jets.push(j.x, j.y, j.z)
    const ships = this.ships
    ships.length = 0
    for (const s of this.flight.carriers) ships.push(s.x, 0, s.z)
    this.birds.update(v.dt, v.eye, jets, ships, v.fov, v.height)

    const cam = f.cam
    const view = inJet && f.phase !== "crashed" && !cam.sighting
    const preview = CANOPY_RAIN.preview
    const cockpit = preview === 1 || (view && cam.mode === "cockpit") ? 1 : 0
    const chase = preview === 2 || (view && cam.mode === "chase")
    const speed = preview ? CANOPY_RAIN.previewSpeed : inJet ? planeSpeed(f.plane) : 0
    this.canopyRain.update(v.dt, v.playing ? v.rain : 0, cockpit, chase, speed, v.width / v.height, v.frame)
  }
}
