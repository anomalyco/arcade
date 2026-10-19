import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { dogSites, dogState, type DogSite, type DogState } from "../../shared/dogs/dogs"
import type { SessionView } from "../../shared/session"
import { hex } from "../level"

const MAX = 24
const RANGE = 32
const LINKS = 9

type Pool = Map<number, { data: Float32Array<ArrayBuffer>; count: number }>
type Pose = { x: number; y: number; yaw: number; t: number }
export type DogLook = { dogLunge: number; dogWag: number }

/** Coats, as the cloth tint: brown, black, tan, grey and a ruddy red, fixed per dog. */
const COATS: readonly (readonly [number, number, number])[] = [
  [0.42, 0.27, 0.15],
  [0.11, 0.1, 0.09],
  [0.66, 0.5, 0.3],
  [0.38, 0.38, 0.39],
  [0.55, 0.26, 0.12],
]

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

const COAT = hex(0xffffff)
const DARK = hex(0x1a1512)

/** A dog standing, head along +x, the origin on the ground under its middle. Coat parts take the instance tint. */
function standing(): Mesh {
  const m = new Mesh()
  m.box(-0.3, 0.27, -0.11, 0.22, 0.49, 0.11, COAT, MAT.cloth)
  m.box(0.14, 0.25, -0.12, 0.32, 0.52, 0.12, COAT, MAT.cloth)
  m.box(0.28, 0.44, -0.085, 0.47, 0.63, 0.085, COAT, MAT.cloth)
  m.box(0.47, 0.46, -0.05, 0.6, 0.56, 0.05, COAT, MAT.cloth)
  m.box(0.59, 0.51, -0.025, 0.62, 0.555, 0.025, DARK)
  for (const z of [-0.06, 0.06]) m.box(0.31, 0.62, z - 0.025, 0.36, 0.7, z + 0.025, COAT, MAT.cloth)
  m.box(0.26, 0.46, -0.095, 0.3, 0.52, 0.095, hex(0x9a1f1a))
  for (const [x, z] of [[-0.24, -0.07], [-0.24, 0.07], [0.2, -0.07], [0.2, 0.07]] as const) m.box(x - 0.03, 0, z - 0.03, x + 0.03, 0.29, z + 0.03, COAT, MAT.cloth)
  return m
}

/** A dog lying down, chin on its front paws. */
function lying(): Mesh {
  const m = new Mesh()
  m.box(-0.32, 0.02, -0.13, 0.2, 0.23, 0.13, COAT, MAT.cloth)
  m.box(0.14, 0.04, -0.12, 0.3, 0.26, 0.12, COAT, MAT.cloth)
  m.box(0.3, 0.06, -0.085, 0.49, 0.24, 0.085, COAT, MAT.cloth)
  m.box(0.49, 0.07, -0.05, 0.61, 0.17, 0.05, COAT, MAT.cloth)
  m.box(0.6, 0.12, -0.025, 0.63, 0.165, 0.025, DARK)
  for (const z of [-0.06, 0.06]) m.box(0.33, 0.24, z - 0.025, 0.38, 0.3, z + 0.025, COAT, MAT.cloth)
  for (const z of [-0.07, 0.07]) m.box(0.3, 0, z - 0.03, 0.62, 0.05, z + 0.03, COAT, MAT.cloth)
  m.box(-0.36, 0, -0.16, -0.12, 0.08, 0.16, COAT, MAT.cloth)
  return m
}

/** The tail, from its root at the origin back along -x. */
function tail(): Mesh {
  const m = new Mesh()
  m.box(-0.24, -0.02, -0.022, 0, 0.025, 0.022, COAT, MAT.cloth)
  return m
}

/** A plank kennel with a pitched roof, its door on +x. */
function kennel(): Mesh {
  const m = new Mesh()
  const wood = hex(0x6b4a2c)
  m.box(-0.42, 0, -0.4, 0.42, 0.62, 0.4, wood, MAT.timber)
  m.box(0.42, 0.0, -0.17, 0.43, 0.42, 0.17, hex(0x120d0a))
  m.yawBox(0, -0.24, 0.98, 0.5, 0.62, 0.66, 0, hex(0x4a3020), MAT.timber)
  m.yawBox(0, 0.24, 0.98, 0.5, 0.62, 0.66, 0, hex(0x4a3020), MAT.timber)
  m.box(-0.49, 0.66, -0.12, 0.49, 0.8, 0.12, hex(0x3e2818), MAT.timber)
  return m
}

/**
 * Chained dogs (AR-56): a kennel and stake in the yard and a dog on its chain. Barking, it strains to the end of the
 * chain towards whatever it barks at, lunging and tossing its head, tail stiff; quiet, it lies at the kennel door and
 * gets up to watch anyone who comes near; fed, it comes to them wagging (and its empty bowl sits by the kennel); dead,
 * it lies on its side. The where-and-what is from the ledger (`dog:*`); which way it pulls is read from the dead and
 * the survivor nearby, so it is presentation only.
 */
export class DogProps {
  private readonly models: { standing: number; lying: number; tail: number; kennel: number; stake: number; link: number; bowl: number }
  private readonly pool: Pool = new Map()
  private readonly out: Batch[] = []
  private readonly poses = new Map<string, Pose>()
  private sites: DogSite[] = []
  private key = ""
  /** Proof readout: dogs drawn last frame and what each is doing. */
  readonly shown: Record<string, DogState> = {}

  constructor(renderer: Pick<Renderer, "addModel">) {
    const stake = new Mesh()
    stake.prism(0, 0, 0.025, 0.02, 0, 0.32, 6, hex(0x5a5a58), MAT.shiny)
    stake.prism(0, 0, 0.045, 0.045, 0.3, 0.33, 8, hex(0x6a6a66), MAT.shiny)
    const link = new Mesh()
    link.box(-0.045, -0.01, -0.012, 0.045, 0.01, 0.012, hex(0x8a8a86), MAT.shiny)
    const bowl = new Mesh()
    bowl.prism(0, 0, 0.12, 0.09, 0, 0.06, 10, hex(0x9a2a22), MAT.shiny)
    bowl.prism(0, 0, 0.1, 0.1, 0.055, 0.058, 10, hex(0x221a14))
    this.models = {
      standing: renderer.addModel(standing()),
      lying: renderer.addModel(lying()),
      tail: renderer.addModel(tail()),
      kennel: renderer.addModel(kennel()),
      stake: renderer.addModel(stake),
      link: renderer.addModel(link),
      bowl: renderer.addModel(bowl),
    }
  }

  collect(view: SessionView, zombies: readonly { x: number; y: number; state: string }[], look: DogLook, support: (x: number, z: number) => number): readonly Batch[] {
    for (const v of this.pool.values()) v.count = 0
    this.out.length = 0
    const { town, progression, player: p, time } = view
    const key = `${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}`
    if (key !== this.key) {
      this.key = key
      this.sites = dogSites(town)
    }
    for (const k of Object.keys(this.shown)) delete this.shown[k]
    for (const d of this.sites) {
      if (Math.abs(d.x - p.x) > RANGE || Math.abs(d.y - p.y) > RANGE) continue
      const st = progression.ledger.store(d.id)
      const state = dogState(st, time)
      this.shown[d.id] = state
      const g = support(d.x, d.y)
      const coat = COATS[Math.floor(hash01(d.id) * COATS.length) % COATS.length]!
      this.put(this.models.kennel, d.kennel.x, support(d.kennel.x, d.kennel.y), d.kennel.y, d.kennel.yaw, 1, 0, 0, [1, 1, 1])
      this.put(this.models.stake, d.x, g, d.y, 0, 1, 0, 0, [1, 1, 1])
      if (st?.counts.fed) this.put(this.models.bowl, d.kennel.x - Math.cos(d.kennel.yaw) * 0.1, support(d.kennel.x, d.kennel.y), d.kennel.y + 0.62, 0, 1, 0, 0, [1, 1, 1])

      // Where it wants to be: at the end of the chain towards what it barks at, at the kennel door, or by its friend.
      let target: { x: number; y: number } | null = null
      let best = Infinity
      for (const z of zombies) {
        if (z.state === "dead") continue
        const dd = Math.hypot(z.x - d.x, z.y - d.y)
        if (dd < best) (best = dd), (target = z)
      }
      const pd = Math.hypot(p.x - d.x, p.y - d.y)
      if (state !== "barking" || (!st?.counts.fed && pd < best)) {
        if (pd < 7 && (state !== "barking" || pd < best)) target = p
      }
      const door = { x: d.kennel.x + Math.cos(d.kennel.yaw) * 0.6, y: d.kennel.y + Math.sin(d.kennel.yaw) * 0.6 }
      let want = { x: door.x, y: door.y, yaw: d.kennel.yaw }
      if (target && (state === "barking" || state === "fed" || pd < 7)) {
        const a = Math.atan2(target.y - d.y, target.x - d.x)
        const reach = state === "barking" ? d.chain - 0.12 : state === "fed" ? Math.min(d.chain - 0.3, Math.max(0, Math.hypot(target.x - d.x, target.y - d.y) - 0.8)) : 0.9
        want = { x: d.x + Math.cos(a) * reach, y: d.y + Math.sin(a) * reach, yaw: a }
      }
      let pose = this.poses.get(d.id)
      if (!pose) this.poses.set(d.id, (pose = { x: want.x, y: want.y, yaw: want.yaw, t: time }))
      const dt = Math.max(0, Math.min(0.1, time - pose.t))
      pose.t = time
      if (state !== "dead") {
        const k = 1 - Math.exp(-dt * (state === "barking" ? 9 : 4))
        pose.x += (want.x - pose.x) * k
        pose.y += (want.y - pose.y) * k
        const turn = Math.atan2(Math.sin(want.yaw - pose.yaw), Math.cos(want.yaw - pose.yaw))
        pose.yaw += turn * Math.min(1, dt * 8)
      }

      let x = pose.x
      let y = pose.y
      let pitch = 0
      let roll = 0
      let wag = 0
      let tailPitch = 0.5
      let collarY = 0.48
      let model = this.models.standing
      if (state === "barking") {
        // A lunge against the chain with every bark, the head tossing up.
        const beat = Math.abs(Math.sin(time * 5.6 + d.x))
        x += Math.cos(pose.yaw) * 0.07 * beat * look.dogLunge
        y += Math.sin(pose.yaw) * 0.07 * beat * look.dogLunge
        pitch = 0.12 * beat * look.dogLunge
        tailPitch = 0.9
        wag = Math.sin(time * 3) * 0.08
      } else if (state === "fed") {
        wag = Math.sin(time * 17) * 0.55 * look.dogWag
      } else if (state === "dead") {
        model = this.models.lying
        roll = Math.PI / 2
        collarY = 0.12
      } else if (!target || pd >= 7) {
        model = this.models.lying
        collarY = 0.16
        wag = Math.sin(time * 1.3) * 0.1 * look.dogWag
        tailPitch = 0
      } else {
        wag = Math.sin(time * 6) * 0.25 * look.dogWag
      }
      const gy = support(x, y)
      this.put(model, x, gy + (state === "dead" ? 0.12 : 0), y, pose.yaw, 1, pitch, roll, coat)
      if (state !== "dead") {
        const rx = x - Math.cos(pose.yaw) * (model === this.models.lying ? 0.33 : 0.3)
        const ry = y - Math.sin(pose.yaw) * (model === this.models.lying ? 0.33 : 0.3)
        this.put(this.models.tail, rx, gy + (model === this.models.lying ? 0.12 : 0.46), ry, pose.yaw + wag, 1, -tailPitch, 0, coat)
      }
      // The chain: from the stake's ring to the collar, sagging to the ground when slack.
      const cx = x + Math.cos(pose.yaw) * 0.28
      const cy = y + Math.sin(pose.yaw) * 0.28
      const span = Math.hypot(cx - d.x, cy - d.y)
      const slack = Math.max(0, 1 - span / d.chain)
      const yaw = Math.atan2(cy - d.y, cx - d.x)
      for (let i = 0; i < LINKS; i++) {
        const u = (i + 0.5) / LINKS
        const h = g + 0.32 + (collarY - 0.32) * u - Math.sin(u * Math.PI) * (0.06 + slack * 0.3)
        this.put(this.models.link, d.x + (cx - d.x) * u, Math.max(g + 0.01, h), d.y + (cy - d.y) * u, yaw + (i % 2) * 0.4, 1, 0, (i % 2) * 1.2, [1, 1, 1])
      }
    }
    for (const [model, v] of this.pool) if (v.count) this.out.push({ model, data: v.data, count: v.count })
    return this.out
  }

  private put(model: number, x: number, y: number, z: number, yaw: number, scale: number, pitch: number, roll: number, tint: readonly [number, number, number]): void {
    let v = this.pool.get(model)
    if (!v) this.pool.set(model, (v = { data: new Float32Array(MAX * 12 * INST_FLOATS), count: 0 }))
    if (v.count >= MAX * 12) return
    v.data.set([x, y, z, yaw, tint[0], tint[1], tint[2], scale, pitch, roll, 1, 0], v.count++ * INST_FLOATS)
  }
}
