import { animate, type Avatar, EV, newAvatar, pose } from "@arcade/kit/avatar/anim"
import { registerPersonModels } from "@arcade/kit/avatar/soldier"
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { SpotShadowCaster } from "@arcade/kit/gpu/shadows/spot-shadows"
import { torchCarry } from "@arcade/kit/people/retarget"
import { RIG, type V3 } from "@arcade/kit/rig"
import { SIGNAL_PITCH, viewDir, type Player, type WoodsState } from "../shared/sim"
import { standHeight, type WoodsWorld } from "../shared/world"
import { PeopleView, type Log } from "./people-view"

/** Raincoats in the dark: muted yellow, olive, rust, navy, grey. */
const COATS: readonly (readonly [number, number, number])[] = [[0.62, 0.48, 0.12], [0.24, 0.28, 0.14], [0.45, 0.16, 0.08], [0.12, 0.15, 0.26], [0.3, 0.3, 0.3]]

export type Beam = { id: number; origin: [number, number, number]; axis: [number, number, number]; level: number }

/** A friend's beam as drawn: its direction on a critically damped spring and its brightness eased. */
type Aim = { axis: V3; vel: V3; level: number }

/**
 * Friends drawn with the shared human rig, holding their flashlights where their beams start: blocky parts (today) or,
 * with `realistic` (the Lab's "Realistic people", `?people=real`), skinned people from `@arcade/kit/people`, each
 * drawn blocky until their person has loaded.
 */
export class FriendsView {
  private parts: ReturnType<typeof registerPersonModels>
  private torch: number
  private avatars = new Map<number, Avatar>()
  private real: PeopleView | null = null
  /** Camera position, for the people's level of detail. */
  eye: V3 | null = null
  /** Ease friends' beams: their direction settles in `beamSettle` seconds and brightness changes soften. */
  smooth = true
  beamSettle = 0.12
  private aims = new Map<number, Aim>()

  constructor(private renderer: Renderer, public realistic = false) {
    this.parts = registerPersonModels((m) => renderer.addModel(m))
    const torch = new Mesh()
    torch.box(-0.1, -0.022, -0.022, 0.06, 0.022, 0.022, [0.05, 0.05, 0.055], MAT.shiny)
    torch.prism(0.065, 0, 0.03, 0.03, -0.03, 0.03, 8, [1, 1, 1], MAT.accent)
    this.torch = renderer.addModel(torch)
  }

  private avatar(p: Player): Avatar {
    let a = this.avatars.get(p.id)
    if (!a) {
      a = newAvatar(`friend-${p.id}`, p.x, p.z, 0, "rifle")
      a.unarmed = true
      this.avatars.set(p.id, a)
    }
    return a
  }

  /** The realistic people (created on first use, so blocky mode loads nothing). */
  realPeople(): PeopleView {
    return (this.real ??= new PeopleView(this.renderer, this.logs))
  }

  /** Deadfall the realistic people step over: the forest's logs (centre, plan yaw, length, radius) on `ground`. */
  logs: Log[] = []
  setLogs(logs: readonly { x: number; z: number; yaw: number; length: number; r: number }[], ground: (x: number, z: number) => number): void {
    this.logs = logs.map((l) => {
      const ca = Math.cos(l.yaw), sa = Math.sin(l.yaw)
      let g = -Infinity
      for (let k = -2; k <= 2; k++) g = Math.max(g, ground(l.x + ca * l.length * k / 4, l.z + sa * l.length * k / 4))
      // As the forest bakes them: resting on the highest ground under them, sunk a third of their radius.
      return { ...l, y: g + l.r * 0.65 }
    })
    if (this.real) this.real.logs = this.logs
  }

  /** Torch-shadow casters for your torch at `from`: the realistic people within `reach` (none when blocky). */
  casters(from: V3, reach: number): SpotShadowCaster[] {
    return this.realistic && this.real ? this.real.casters(from, reach) : []
  }

  /** Actual displayed head, for positional chat and its speaking marker. */
  head(id: number, world: WoodsWorld): V3 | null {
    const real = this.realistic ? this.real?.head(id) : null
    if (real) return real
    const a = this.avatars.get(id), h = a?.body?.head.p
    return a && h ? [h[0], h[1] + standHeight(world, a.x, a.y), h[2]] : null
  }

  /** Where `p`'s beam points and how bright it is this frame, eased unless `smooth` is off. */
  private aim(p: Player, level: number, dt: number): Aim {
    const target = viewDir(p.yaw, p.pitch)
    let a = this.aims.get(p.id)
    if (!a || !this.smooth || a.axis[0] * target[0] + a.axis[1] * target[1] + a.axis[2] * target[2] < 0) {
      a = { axis: [target[0], target[1], target[2]], vel: [0, 0, 0], level }
      this.aims.set(p.id, a)
      return a
    }
    // Exact critically damped step towards the target (it holds still between steps, so this is stable at any dt).
    const w = 4 / Math.max(this.beamSettle, 0.01), e = Math.exp(-w * dt)
    for (let i = 0; i < 3; i++) {
      const x0 = a.axis[i]! - target[i]!, v0 = a.vel[i]!, c = v0 + w * x0
      a.axis[i] = target[i]! + (x0 + c * dt) * e
      a.vel[i] = (v0 - w * c * dt) * e
    }
    const n = Math.hypot(a.axis[0], a.axis[1], a.axis[2]) || 1
    for (let i = 0; i < 3; i++) a.axis[i] = a.axis[i]! / n
    a.level += (level - a.level) * (1 - Math.exp(-dt / 0.04))
    return a
  }

  /**
   * Poses every friend (not `me`) for this frame and returns their beams. `steps` reports footfalls near the listener.
   */
  frame(fp: FrameParts, world: WoodsWorld, state: WoodsState, me: number, dt: number, beamLevel: (p: Player) => number, steps: (p: Player) => void): Beam[] {
    const beams: Beam[] = []
    const real = this.realistic ? this.realPeople() : null
    if (!real) this.real?.hideAll()
    else real.keep(new Set(state.players.map((p) => p.id)))
    for (const p of state.players) {
      if (p.id === me) continue
      const aim = this.aim(p, beamLevel(p), dt)
      const level = aim.level
      const [dx, dy, dz] = aim.axis
      if (real) {
        const knot = p.tie && p.tie.progress < 1 ? Math.sin(state.t * 9) * 0.04 : 0
        const up = Math.max(-0.4, Math.min(1, p.pitch))
        const reach = p.tie && p.tie.progress < 1
          ? { l: [0.42, 0.18, -0.08] as V3, r: [0.44, 0.2 + knot, 0.06] as V3, k: 1 }
          : { r: (p.pitch > SIGNAL_PITCH ? [0.12, 0.78, 0.16] : torchCarry(up)) as V3, k: 1 }
        const torch = real.frame(p, state.t, dt, Math.atan2(dz, dx), [dx, dy, dz], reach, (x, z) => standHeight(world, x, z), this.eye, () => steps(p))
        if (torch) {
          fp.push(this.torch, torch.p[0], torch.p[1], torch.p[2], Math.atan2(torch.x[2], torch.x[0]), [3 * level + 0.02, 2.8 * level + 0.02, 2.4 * level + 0.02], Math.asin(Math.max(-1, Math.min(1, torch.x[1]))), 0, 0)
          if (level > 0.01) beams.push({ id: p.id, origin: [torch.p[0] + torch.x[0] * 0.1, torch.p[1] + torch.x[1] * 0.1, torch.p[2] + torch.x[2] * 0.1], axis: [dx, dy, dz], level })
          continue
        }
      }
      const a = this.avatar(p)
      const signalling = p.pitch > SIGNAL_PITCH
      // Torso space: x forward, y up, z right. The torch hand follows the beam's pitch; straight up when signalling.
      const up = Math.max(-0.4, Math.min(1, p.pitch))
      // Tying: both hands forward round the trunk, the torch hand working the knot.
      const knot = p.tie && p.tie.progress < 1 ? Math.sin(state.t * 9) * 0.04 : 0
      a.reach = p.tie && p.tie.progress < 1
        ? { l: [0.42, 0.18, -0.08], r: [0.44, 0.2 + knot, 0.06], k: 1 }
        : { r: signalling ? [0.12, 0.78, 0.16] : [0.4, 0.12 + up * 0.32, 0.17], k: 1 }
      const heading = Math.atan2(dz, dx)
      const cues = animate(a, dt, state.t, p.x, p.z, p.vx, p.vz, heading)
      if ((cues & EV.step) && !p.air.airborne) steps(p)
      const ground = standHeight(world, a.x, a.y) + p.air.y
      const push = fp.scaled(1, 0, 0, ground)
      pose(push, a, COATS[(p.id - 1) % COATS.length]!, this.parts)
      const fa = a.body?.fa[1]
      if (!fa) continue
      const hand: V3 = [fa.p[0] - fa.y[0] * RIG.fore, fa.p[1] - fa.y[1] * RIG.fore + ground, fa.p[2] - fa.y[2] * RIG.fore]
      const pitch = Math.asin(Math.max(-1, Math.min(1, dy)))
      fp.push(this.torch, hand[0], hand[1], hand[2], heading, [3 * level + 0.02, 2.8 * level + 0.02, 2.4 * level + 0.02], pitch, 0, 0)
      if (level > 0.01) beams.push({ id: p.id, origin: [hand[0] + dx * 0.1, hand[1] + dy * 0.1, hand[2] + dz * 0.1], axis: [dx, dy, dz], level })
    }
    for (const id of this.avatars.keys()) if (!state.players.some((p) => p.id === id)) this.avatars.delete(id)
    for (const id of this.aims.keys()) if (!state.players.some((p) => p.id === id)) this.aims.delete(id)
    return beams
  }
}
