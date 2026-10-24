// TIMBER's people: Microsoft Rocketbox avatars (MIT, `docs/people.md`) on the kit's people rig, as in BARBARA. The
// lumberjack is big, in buffalo-check flannel under a black work vest, both hands on the saw; survivors are campers
// with a torch in the right hand and the axe in the left. The downed and the dead are the game's ragdolls posed onto the
// person. The blocky rig draws anyone whose person is still loading, and everyone with Realistic people off.
import { animate, type Avatar, newAvatar } from "@arcade/kit/avatar/anim"
import { ragdollBody, type Ragdoll } from "@arcade/kit/avatar/ragdoll"
import { batchHooks } from "@arcade/kit/forest/shaders"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import type { HumanBody } from "@arcade/kit/human-pose"
import { CAST } from "@arcade/kit/people/cast/rocketbox.gen"
import { posePerson, skinMatrices } from "@arcade/kit/people/retarget"
import { People, type CastMember, type Person } from "@arcade/kit/people/view"
import type { Frame, V3 } from "@arcade/kit/rig"
import type { Jack } from "../shared/sim"

/**
 * Rocketbox members by role: the lumberjack is m05 repainted (`public/people/lumberjack.glb`, `scripts/lumberjack.ts`):
 * a red and black buffalo-check flannel shirt under a black canvas work vest, dark work trousers and boots. The
 * survivors are the rest of the cast.
 */
const M05 = CAST.find((m) => m.person === "m05") ?? CAST[0]!
const JACK: CastMember = { ...M05, id: "timber-lumberjack", url: `${import.meta.env.BASE_URL}people/lumberjack.glb`, outfit: "buffalo-check flannel shirt, black canvas work vest, dark work trousers, boots" }
const CAMPERS = CAST.filter((m) => m !== M05)

/**
 * Two hands on a chainsaw held across the belly, torso-local (x forward, y up, z right): the rear handle in front of the
 * right hip, and the wrap handle where it sits on the scanned saw (`public/saw/saw.glb`: 0.3 m ahead, 0.12 m up and
 * 0.07 m left of the rear grip), the bar turned 0.2 rad left across him. Both within 95% of the rig's arm from its
 * shoulder, where the people rig starts easing the reach: further, the left hand stops short of the handle.
 */
export const SAW_PITCH = -0.05
const SAW_HANDS = { r: [0.14, 0.04, 0.06] as V3, l: [0.42, 0.16, -0.068] as V3 }
/** The wrap handle's bearing from the rear grip, left of the bar. */
const SAW_WRAP_YAW = Math.atan2(0.07, 0.3)

/** Scales every frame's position in a body by `s` (world ↔ rig space). */
function scaleBody(b: HumanBody, s: number): HumanBody {
  const f = (fr: Frame): Frame => ({ ...fr, p: [fr.p[0] * s, fr.p[1] * s, fr.p[2] * s] })
  const pair = (p: [Frame, Frame]): [Frame, Frame] => [f(p[0]), f(p[1])]
  return { pelvis: f(b.pelvis), torso: f(b.torso), head: f(b.head), ua: pair(b.ua), fa: pair(b.fa), th: pair(b.th), sh: pair(b.sh), ft: pair(b.ft), ...(b.toe ? { toe: pair(b.toe) } : {}) }
}

/** Scales a person's skinning matrices by `k` about the floor under (x, z), after skinning: a bigger man. */
function grow(m: Float32Array, k: number, x: number, z: number): void {
  if (k === 1) return
  const o = [x, 0, z]
  for (let i = 0; i < m.length; i += 16) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) m[i + c * 4 + r]! *= k
    for (let r = 0; r < 3; r++) m[i + 12 + r]! += (1 - k) * o[r]!
  }
}

export type Held = { saw?: { p: V3; aim: number }; axe?: { p: V3 }; torch?: Frame }

export class TimberPeople {
  readonly people: People
  private avatars = new Map<number, Avatar>()
  private persons = new Map<number, Person>()
  private cast = new Map<number, CastMember>()

  constructor(renderer: Renderer) {
    this.people = new People(renderer.passContext, batchHooks)
    renderer.addPass("opaque", this.people.pass)
  }

  private member(j: Jack): CastMember {
    let m = this.cast.get(j.id)
    if (!m || (j.role === "lumberjack") !== (m === JACK)) {
      m = j.role === "lumberjack" ? JACK : CAMPERS[j.id % CAMPERS.length]!
      this.cast.set(j.id, m)
      const old = this.persons.get(j.id)
      if (old) {
        this.people.remove(old)
        this.persons.delete(j.id)
        this.avatars.delete(j.id)
      }
      const mm = m
      this.people.load(mm).catch((e) => console.error(`people: ${mm.id} failed to load`, e))
    }
    return m
  }

  /** Fetches every member TIMBER uses; resolves when they can be drawn (never rejects). */
  preload(): Promise<void> {
    return Promise.all([JACK, ...CAMPERS].map((m) => this.people.load(m).catch(() => {}))).then(() => {})
  }

  private person(j: Jack, aim: number): { person: Person; a: Avatar; s: number } | null {
    const m = this.member(j)
    const s = this.people.scale(m)
    if (s === null) return null
    let a = this.avatars.get(j.id)
    let person = this.persons.get(j.id)
    if (!a || !person) {
      a = newAvatar(`person-${j.id}`, j.x / s, j.y / s, aim, "rifle")
      person = this.people.spawn(m)!
      this.avatars.set(j.id, a)
      this.persons.set(j.id, person)
    }
    return { person, a, s }
  }

  /**
   * Poses `j` standing and moving, or returns null while their person loads (draw them blocky). `hidden` keeps them
   * out of the frame (you, in first person) while still posing them. Returns where the held things go.
   */
  stand(j: Jack, o: { dt: number; t: number; scale: number; torchDir: V3 | null; chop: number; cutting: boolean; eye: V3; hidden: boolean; lift: number }): Held | null {
    const got = this.person(j, j.aim)
    if (!got) return null
    const { person, a, s } = got
    const lj = j.role === "lumberjack"
    if (lj) a.reach = { ...SAW_HANDS, k: 1 }
    else if (o.chop > 0) {
      // Both hands on the axe and a swing at the trunk.
      const sw = Math.sin(o.chop * Math.PI * 2)
      a.reach = { l: [0.35 + sw * 0.12, 0.3 + sw * 0.25, 0.05], r: [0.32 + sw * 0.12, 0.22 + sw * 0.25, 0.12], k: 1 }
    } else a.reach = undefined
    animate(a, o.dt, o.t, j.x / s, j.y / s, j.vx / s, j.vy / s, j.aim)
    const torch = this.people.drive(person, a, {
      dt: o.dt, time: o.t, rise: o.lift, eye: o.eye, look: { yaw: 0, pitch: o.cutting ? -0.35 : 0 },
      ...(o.torchDir && o.chop <= 0 ? { torch: { side: 1 as const, dir: o.torchDir } } : {}),
    })
    if (lj) grow(person.inst.matrices, o.scale, j.x, j.y)
    person.inst.visible = !o.hidden
    const handR = this.hand(person, 1, lj ? o.scale : 1, j)
    const handL = this.hand(person, 0, lj ? o.scale : 1, j)
    // The saw follows his hands, not his aim (the body turns after it): the wrap handle sits 0.23 rad left of the bar.
    if (lj) return { saw: { p: handR, aim: Math.atan2(handL[2] - handR[2], handL[0] - handR[0]) + SAW_WRAP_YAW } }
    return { axe: { p: handL }, ...(torch ? { torch } : {}) }
  }

  private hand(person: Person, side: 0 | 1, k: number, j: Jack): V3 {
    const p = person.pose.pos[person.rest.arms[side]!.end]!
    return [j.x + (p[0] - j.x) * k, p[1] * k, j.y + (p[2] - j.y) * k]
  }

  /** Poses `j` from their ragdoll (downed or dead), world space, the head raised by `look` (rad). False while their
   * person loads. */
  lie(j: Jack, rd: Ragdoll, dt: number, scale: number, eye: V3, look = 0): boolean {
    const got = this.person(j, j.aim)
    if (!got) return false
    const { person, s } = got
    const body = scaleBody(ragdollBody(rd, 0, "rifle"), 1 / s)
    posePerson(person.rest, { body, lift: 0, dt, look: { yaw: 0, pitch: look } }, person.pose)
    skinMatrices(person.rest, person.pose, person.inst.matrices)
    if (j.role === "lumberjack") grow(person.inst.matrices, scale, j.x, j.y)
    person.inst.lod = 0
    person.inst.visible = true
    void eye
    return true
  }

  /** Hides everyone not drawn this frame. */
  hideExcept(ids: Set<number>): void {
    for (const [id, p] of this.persons) if (!ids.has(id)) p.inst.visible = false
  }

  reset(): void {
    for (const p of this.persons.values()) this.people.remove(p)
    this.persons.clear()
    this.avatars.clear()
    this.cast.clear()
  }
}
