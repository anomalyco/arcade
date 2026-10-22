import { animate, type Avatar, EV, newAvatar, pose } from "@arcade/kit/avatar/anim"
import { registerPersonModels } from "@arcade/kit/avatar/soldier"
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { RIG, type V3 } from "@arcade/kit/rig"
import { SIGNAL_PITCH, viewDir, type Player, type WoodsState } from "../shared/sim"
import { standHeight, type WoodsWorld } from "../shared/world"

/** Raincoats in the dark: muted yellow, olive, rust, navy, grey. */
const COATS: readonly (readonly [number, number, number])[] = [[0.62, 0.48, 0.12], [0.24, 0.28, 0.14], [0.45, 0.16, 0.08], [0.12, 0.15, 0.26], [0.3, 0.3, 0.3]]

export type Beam = { id: number; origin: [number, number, number]; axis: [number, number, number] }

/** Friends drawn with the shared human rig, holding their flashlights where their beams start. */
export class FriendsView {
  private parts: ReturnType<typeof registerPersonModels>
  private torch: number
  private avatars = new Map<number, Avatar>()

  constructor(renderer: Renderer) {
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

  /**
   * Poses every friend (not `me`) for this frame and returns their beams. `steps` reports footfalls near the listener.
   */
  frame(fp: FrameParts, world: WoodsWorld, state: WoodsState, me: number, dt: number, beamLevel: (p: Player) => number, steps: (p: Player) => void): Beam[] {
    const beams: Beam[] = []
    for (const p of state.players) {
      if (p.id === me) continue
      const a = this.avatar(p)
      const [dx, dy, dz] = viewDir(p.yaw, p.pitch)
      const signalling = p.pitch > SIGNAL_PITCH
      // Torso space: x forward, y up, z right. The torch hand follows the beam's pitch; straight up when signalling.
      const up = Math.max(-0.4, Math.min(1, p.pitch))
      // Tying: both hands forward round the trunk, the torch hand working the knot.
      const knot = p.tie && p.tie.progress < 1 ? Math.sin(state.t * 9) * 0.04 : 0
      a.reach = p.tie && p.tie.progress < 1
        ? { l: [0.42, 0.18, -0.08], r: [0.44, 0.2 + knot, 0.06], k: 1 }
        : { r: signalling ? [0.12, 0.78, 0.16] : [0.4, 0.12 + up * 0.32, 0.17], k: 1 }
      const aim = Math.atan2(dz, dx)
      const cues = animate(a, dt, state.t, p.x, p.z, p.vx, p.vz, aim)
      if (cues & EV.step) steps(p)
      const ground = standHeight(world, a.x, a.y)
      const push = fp.scaled(1, 0, 0, ground)
      pose(push, a, COATS[(p.id - 1) % COATS.length]!, this.parts)
      const fa = a.body?.fa[1]
      if (!fa) continue
      const hand: V3 = [fa.p[0] - fa.y[0] * RIG.fore, fa.p[1] - fa.y[1] * RIG.fore + ground, fa.p[2] - fa.y[2] * RIG.fore]
      const level = beamLevel(p)
      const pitch = Math.asin(Math.max(-1, Math.min(1, dy)))
      fp.push(this.torch, hand[0], hand[1], hand[2], aim, [3 * level + 0.02, 2.8 * level + 0.02, 2.4 * level + 0.02], pitch, 0, 0)
      if (level > 0) beams.push({ id: p.id, origin: [hand[0] + dx * 0.1, hand[1] + dy * 0.1, hand[2] + dz * 0.1], axis: [dx, dy, dz] })
    }
    for (const id of this.avatars.keys()) if (!state.players.some((p) => p.id === id)) this.avatars.delete(id)
    return beams
  }
}
