import { animate, type Avatar, EV, newAvatar } from "@arcade/kit/avatar/anim"
import { batchHooks } from "@arcade/kit/forest/shaders"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { SpotShadowCaster } from "@arcade/kit/gpu/shadows/spot-shadows"
import { CAST } from "@arcade/kit/people/cast/woods.gen"
import { People, type CastMember, type Person } from "@arcade/kit/people/view"
import type { HandPose } from "@arcade/kit/people/retarget"
import type { V3 } from "@arcade/kit/rig"
import type { Player } from "../shared/sim"

/** The left hand on a map's edge: fingers flat under the sheet, the thumb on top. */
const SHEET_GRIP: HandPose = { index: [12, 18, 8], middle: [14, 20, 10], ring: [18, 24, 12], pinky: [22, 28, 14], thumbOppose: 25, thumbAlong: 15, thumb: [5, 8, 6], together: 0 }

export type Log = { x: number; z: number; yaw: number; length: number; r: number; y: number }

/**
 * Woods' adapter onto `@arcade/kit/people`: realistic friends on the shared rig, each a different member of the woods
 * cast (`scripts/people/cast.json`) in their own jacket, beanie, headlamp and pack. The rig walks in the person's rig
 * space (world / scale); the kit adds the ground under each foot (terrain, the dock and the forest's logs), the
 * standing weight shift and the torch hand. Swappable: `FriendsView` keeps drawing blocky friends whenever this is off
 * or a friend's person is still loading.
 */
export class PeopleView {
  readonly people: People
  private avatars = new Map<number, Avatar>()
  private persons = new Map<number, Person>()
  /** Cast member per friend, in order of arrival, so the first friend you meet wears yellow. */
  private assigned = new Map<number, CastMember>()
  constructor(renderer: Renderer, public logs: Log[] = []) {
    this.people = new People(renderer.passContext, batchHooks)
    renderer.addPass("opaque", this.people.pass)
  }

  private member(id: number): CastMember {
    let m = this.assigned.get(id)
    if (!m) {
      m = CAST[this.assigned.size % CAST.length]!
      this.assigned.set(id, m)
      this.people.load(m).catch((e) => console.error(`people: ${m!.id} failed to load`, e))
    }
    return m
  }

  /**
   * Fetches the first `n` cast members (the first friends you meet wear them) and resolves when they can be drawn, so
   * Play shows them at once instead of popping them in; the rest start loading behind. Never rejects.
   */
  preload(n: number): Promise<void> {
    const all = CAST.map((m) => this.people.load(m).catch((e) => console.error(`people: ${m.id} failed to load`, e)))
    return Promise.all(all.slice(0, n)).then(() => {})
  }

  /** Ground under (x, z): the terrain/dock height, raised over any log's round top. */
  ground(stand: (x: number, z: number) => number, x: number, z: number): number {
    let g = stand(x, z)
    for (const l of this.logs) {
      const dx = x - l.x, dz = z - l.z
      if (Math.abs(dx) > l.length && Math.abs(dz) > l.length) continue
      const ca = Math.cos(l.yaw), sa = Math.sin(l.yaw)
      const along = Math.max(-l.length / 2, Math.min(l.length / 2, dx * ca + dz * sa))
      const d = Math.hypot(dx - ca * along, dz - sa * along)
      if (d < l.r) g = Math.max(g, l.y + Math.sqrt(l.r * l.r - d * d))
    }
    return g
  }

  /**
   * Poses friend `p` and returns its torch frame for the beam and where its left hand is, or null while its person
   * loads (draw it blocky). `read` (0..1) bows the head over a map held in the left hand.
   */
  frame(p: Player, t: number, dt: number, aim: number, dir: V3, reach: Avatar["reach"], stand: (x: number, z: number) => number, eye: V3 | null, steps: () => void, read = 0): { p: V3; x: V3; left: V3 } | null {
    const m = this.member(p.id)
    const s = this.people.scale(m)
    if (s === null) return null
    let a = this.avatars.get(p.id), person = this.persons.get(p.id)
    if (!a || !person) {
      a = newAvatar(`friend-${p.id}`, p.x / s, p.z / s, aim, "rifle")
      a.unarmed = true
      person = this.people.spawn(m)!
      this.avatars.set(p.id, a)
      this.persons.set(p.id, person)
    }
    a.reach = reach
    if ((animate(a, dt, t, p.x / s, p.z / s, p.vx / s, p.vz / s, aim) & EV.step) && !p.air.airborne) steps()
    const pitch = Math.max(-0.5, Math.min(0.6, p.pitch * 0.55))
    const torch = this.people.drive(person, a, { dt, time: t, ground: (x, z) => this.ground(stand, x, z), rise: p.air.y, torch: { side: 1, dir }, look: { yaw: 0, pitch: pitch + (-0.6 - pitch) * read },
      grip: [read > 0.3 ? SHEET_GRIP : null, null], eye: eye ?? undefined })
    return torch && { p: torch.p, x: torch.x, left: person.pose.pos[person.rest.arms[0].end]! }
  }

  /** Torch-shadow casters: every drawn person within `reach` of `from` (your torch). */
  casters(from: V3, reach: number): SpotShadowCaster[] {
    const near = [...this.persons.values()].filter((q) => {
      const h = q.pose.pos[q.rest.idx.pelvis!]!
      return q.inst.visible && Math.hypot(h[0] - from[0], h[1] - from[1], h[2] - from[2]) < reach
    })
    return this.people.pass.shadowCasters(near.map((q) => q.inst))
  }

  /** Friends drawn as their person so far (automation). */
  get drawn(): number { return this.persons.size }

  /** Drops friends who left. */
  keep(ids: Set<number>): void {
    for (const [id, person] of this.persons) if (!ids.has(id)) { this.people.remove(person); this.persons.delete(id); this.avatars.delete(id) }
  }

  hideAll(): void {
    for (const person of this.persons.values()) person.inst.visible = false
  }
}
