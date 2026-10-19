import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { radioSites, radioState, type RadioSite } from "../../shared/radios/radios"
import type { SessionView } from "../../shared/session"
import { hex } from "../level"

const MAX = 64
const RANGE = 30
/** The dial's amber, as the instance tint the accent material glows with. */
const AMBER = [1, 0.55, 0.16] as const

export type RadioLook = { radioDialGlow: number; radioShake: number }

/**
 * The house radios (AR-56): a bakelite set on the living-room table, its dial glowing amber and the cabinet buzzing a
 * little while it plays, dark when it is off or flat, and tipped over on the floor once the dead have knocked it down.
 * Reads the ledger's `radio:*` stores only, so every co-op client sees the same.
 */
export class RadioProps {
  private readonly model: number
  private readonly data = new Float32Array(MAX * INST_FLOATS)
  private readonly out: Batch[] = []
  private sites: RadioSite[] = []
  private key = ""
  /** Proof readout: radios drawn last frame by state. */
  readonly shown = { playing: [] as string[], off: [] as string[], broken: [] as string[] }

  constructor(renderer: Pick<Renderer, "addModel">) {
    const m = new Mesh()
    const body = hex(0x6a4128)
    const trim = hex(0xc9b48a)
    // Cabinet, front +z (the camera's side), 34 × 20 × 18 cm.
    m.box(-0.17, 0, -0.09, 0.17, 0.2, 0.09, body, MAT.timber)
    m.box(-0.175, 0.2, -0.095, 0.175, 0.215, 0.095, hex(0x4e2f1c), MAT.timber)
    // Speaker cloth and its slats on the left of the front.
    m.box(-0.15, 0.03, 0.09, -0.01, 0.17, 0.096, hex(0x2a2018), MAT.lit)
    for (const x of [-0.13, -0.1, -0.07, -0.04]) m.box(x - 0.006, 0.03, 0.096, x + 0.006, 0.17, 0.1, trim, MAT.shiny)
    // Dial window on the front and across the top, so the camera sees it from above.
    m.box(0.01, 0.1, 0.09, 0.15, 0.16, 0.1, hex(0xffa040), MAT.accent)
    m.box(0.02, 0.2, 0.0, 0.15, 0.218, 0.07, hex(0xffa040), MAT.accent)
    // Knobs and a whip aerial leaning back.
    m.prism(0.05, 0.075, 0.018, 0.018, 0.09, 0.115, 10, trim, MAT.shiny)
    m.prism(0.11, 0.075, 0.018, 0.018, 0.09, 0.115, 10, trim, MAT.shiny)
    m.box(0.12, 0.215, -0.06, 0.13, 0.48, -0.05, hex(0xb8bcbc), MAT.shiny)
    this.model = renderer.addModel(m)
  }

  collect(view: SessionView, time: number, look: RadioLook, support: (x: number, z: number) => number): readonly Batch[] {
    const { town, player: p, progression } = view
    const key = `${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}`
    if (key !== this.key) {
      this.key = key
      this.sites = radioSites(town)
    }
    const shown = this.shown
    shown.playing.length = shown.off.length = shown.broken.length = 0
    this.out.length = 0
    let n = 0
    for (const site of this.sites) {
      if (n >= MAX) break
      if (Math.abs(site.x - p.x) > RANGE || Math.abs(site.y - p.y) > RANGE) continue
      const state = radioState(progression.ledger.store(site.id), time)
      const ground = support(site.x, site.y)
      let x = site.x
      let y = ground + site.z
      let z = site.y
      let yaw = site.yaw
      let pitch = 0
      let roll = 0
      let glow = 0.04
      if (state === "broken") {
        // Knocked off the table onto its back, a stride south of it, where the camera sees it.
        shown.broken.push(site.id)
        y = ground + 0.09
        z += 0.72
        yaw += 0.7
        pitch = -Math.PI / 2
      } else if (state === "playing") {
        shown.playing.push(site.id)
        glow = look.radioDialGlow
        // A tinny cabinet buzzes with the bass: a few millimetres of shake and the faintest rock.
        const s = look.radioShake
        x += Math.sin(time * 41) * 0.003 * s
        y += Math.abs(Math.sin(time * 9.4)) * 0.004 * s
        roll = Math.sin(time * 23) * 0.012 * s
      } else {
        shown.off.push(site.id)
      }
      this.data.set([x, y, z, yaw, AMBER[0] * glow, AMBER[1] * glow, AMBER[2] * glow, 1, pitch, roll, 1, 0], n++ * INST_FLOATS)
    }
    if (n) this.out.push({ model: this.model, data: this.data, count: n })
    return this.out
  }
}
