import { join } from "node:path"
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder } from "meshoptimizer"
import { extractBodyJoints, extractBonePoseJoints, type RigJointMap } from "../../packages/kit/pose-diff"
import { at, RIG, type V3 } from "../../packages/kit/rig"
import { SnapshotBuffer, hermite2, lerpAngle } from "../../packages/kit/net/interpolate"
import type { MotionFrame } from "../../packages/kit/motion-check"
import type { Person } from "../../packages/kit/people/view"
import type { PersonRest } from "../../packages/kit/people/retarget"

export type Sample = MotionFrame & { scenario: string; time: number }
export const DURATION = 30
export type Input = { speed: number; direction: number; aim: number; crouching: boolean; map: number }
/** Changes are input events; animation is always production animate/draw/People.drive. */
export function inputAt(t: number): Input & { scenario: string } {
  let speed = 0, direction = 0, aim = 0, crouching = false, map = 0, scenario = "idle"
  if (t >= 1 && t < 3) { speed = 1.4; scenario = "start-walk" }
  if (t >= 3 && t < 5) { speed = 4.2; scenario = "walk-run" }
  if (t >= 5 && t < 7) { speed = 6.3; scenario = "run-sprint" }
  if (t >= 7 && t < 8) { speed = 4.2; scenario = "sprint-run" }
  if (t >= 8 && t < 9) { speed = 1.4; scenario = "run-walk" }
  if (t >= 9 && t < 10) scenario = "stop"
  if (t >= 10 && t < 12) { aim = Math.PI * (t - 10); scenario = "turn-on-spot" }
  if (t >= 12 && t < 14) { speed = 1.4; direction = Math.PI; scenario = "backpedal" }
  if (t >= 14 && t < 16) { speed = 3.4; direction = Math.PI / 2; scenario = "strafe" }
  if (t >= 16 && t < 18) { speed = 3.4; direction = Math.floor((t - 16) / 0.4) % 2 ? -Math.PI / 2 : Math.PI / 2; scenario = "reversals" }
  if (t >= 18 && t < 20) { speed = 1.7; crouching = true; scenario = "crouch" }
  if (t >= 20 && t < 23) { map = Math.min(1, (t - 20) / 0.25, (23 - t) / 0.25); scenario = "woods-map-raise" }
  if (t >= 23 && t < 24) scenario = "settle"
  if (t >= 24 && t < 27) { aim = Math.PI * Math.min(1, t - 24); scenario = "turn-before-start" }
  if (t >= 27 && t < 29) { aim = direction = Math.PI; speed = 1.9; scenario = "turned-walk-start" }
  if (t >= 29) { aim = Math.PI; scenario = "turned-stop" }
  return { speed, direction, aim, crouching, map, scenario }
}

const cache = new Map<string, Promise<PersonRest>>()
async function castRest(root: string, id: string) {
  const key = `${root}/${id}`
  if (!cache.has(key)) cache.set(key, (async () => {
    const asset = await import(join(root, "packages/kit/people/asset.ts")) as typeof import("../../packages/kit/people/asset")
    const retarget = await import(join(root, "packages/kit/people/retarget.ts")) as typeof import("../../packages/kit/people/retarget")
    await MeshoptDecoder.ready
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder })
    return retarget.personRest(asset.readPerson(await io.read(join(root, `packages/kit/people/assets/${id}.glb`)), id).skeleton)
  })())
  return cache.get(key)!
}

export const ACTORS = ["blackout-survivor", "soldier", "outbreak-survivor", "outbreak-zombie",
  ...["woods", "survivor", "office"].flatMap(look => "abcdef".split("").map(id => `${id}-${look}`))]

/** Actual render joint positions from each production adapter. No meshes/GPU are constructed. */
export async function sampleMotion(root: string, actor: string, fps: number, hitch: boolean, remote = false, duration = DURATION): Promise<Sample[]> {
  if (!ACTORS.includes(actor) || !Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0)
    throw new Error(`Invalid motion sample: ${actor}, ${fps}fps, ${duration}s`)
  const anim = await import(join(root, "packages/kit/avatar/anim.ts")) as typeof import("../../packages/kit/avatar/anim")
  const a = anim.newAvatar("motion-invariants", 0, 0, 0, "rifle")
  a.unarmed = actor !== "soldier"
  let survivor: import("../../games/outbreak/src/survivor").Survivor | undefined
  let zombie: import("../../games/outbreak/src/zombies").ZombieCrowdRenderer | undefined
  let agent: ReturnType<typeof import("../../packages/kit/sim/ai").createAIAgent> | undefined
  let tuning: typeof import("../../games/outbreak/src/zombie-profile").zombieTuning | undefined
  if (actor === "outbreak-survivor") {
    const mod = await import(join(root, "games/outbreak/src/survivor.ts")) as typeof import("../../games/outbreak/src/survivor")
    survivor = new mod.Survivor({ addModel: () => 0 })
  }
  if (actor === "outbreak-zombie") {
    const mod = await import(join(root, "games/outbreak/src/zombies.ts")) as typeof import("../../games/outbreak/src/zombies")
    const ai = await import(join(root, "packages/kit/sim/ai.ts")) as typeof import("../../packages/kit/sim/ai")
    tuning = (await import(join(root, "games/outbreak/src/zombie-profile.ts"))).zombieTuning
    zombie = new mod.ZombieCrowdRenderer({ addModel: () => 0 })
    agent = ai.createAIAgent(1, 7, 0, 0, 0)
    Object.assign(agent, { lurch: 0.85, asymmetry: 0.85, drag: 0.9, reach: 0.8, state: "wander" })
  }
  const isPerson = /^[a-f]-(woods|survivor|office)$/.test(actor)
  const rest = isPerson ? await castRest(root, actor) : undefined
  const s = rest?.scale ?? 1
  let person: (Person & { gait?: { loco: { feet: { planted: boolean }[] } } }) | undefined
  let people: typeof import("../../packages/kit/people/view") | undefined
  let carry: ((pitch: number) => V3) | undefined
  let qRot: typeof import("../../packages/kit/people/quat").qRot | undefined
  if (rest) {
    const retarget = await import(join(root, "packages/kit/people/retarget.ts")) as typeof import("../../packages/kit/people/retarget") & { torchCarry?: (pitch: number) => V3 }
    people = await import(join(root, "packages/kit/people/view.ts")) as typeof import("../../packages/kit/people/view")
    qRot = (await import(join(root, "packages/kit/people/quat.ts"))).qRot
    carry = retarget.torchCarry
    // Use production spawn as well as drive. Only its GPU allocation is replaced; both the main and people-real
    // revisions initialize their own animation state, without a second copy of the initializer here.
    const cast = { id: actor, url: "", person: actor[0]!, look: actor.slice(2), outfit: "" }
    const headless = Object.assign(Object.create(people.People.prototype), {
      ready: new Map([[cast, { rest, model: null }]]), spawned: 0,
      pass: { spawn: () => ({ visible: true, matrices: new Float32Array(rest.skeleton.names.length * 16) }) },
    }) as import("../../packages/kit/people/view").People
    person = headless.spawn(cast)!
  }
  const frames: Sample[] = []
  const buffer = new SnapshotBuffer<{ x: number; y: number; vx: number; vy: number; aim: number }>(0.1)
  let x = 0, z = 0, time = 0, hit = false, serverT = 0, sx = 0, sz = 0
  while (time < duration - 1e-9) {
    const dt = hitch && !hit && time >= 3.05 ? (hit = true, 0.1) : 1 / fps
    time += dt
    const input = inputAt(time)
    let vx = input.speed * Math.cos(input.direction), vz = input.speed * Math.sin(input.direction), aim = input.aim
    x += vx * dt; z += vz * dt
    if (remote) {
      while (serverT <= time) {
        const p = inputAt(serverT), svx = p.speed * Math.cos(p.direction), svz = p.speed * Math.sin(p.direction)
        sx += svx * 0.05; sz += svz * 0.05
        buffer.push(serverT, { x: sx, y: sz, vx: svx, vy: svz, aim: p.aim }, serverT + 0.04)
        serverT += 0.05
      }
      const br = buffer.sample(time)!
      const p = hermite2(br.a, br.b, br.span, br.t, br.over)
      x = p.x; z = p.y; vx = p.vx; vz = p.vy; aim = lerpAngle(br.a.aim, br.b.aim, br.t)
    }
    let joints: RigJointMap, planted: boolean[], grips: MotionFrame["grips"], contacts: MotionFrame["contacts"], numbers: MotionFrame["numbers"]
    if (survivor) {
      survivor.draw({ x, y: z, vx, vy: vz, aim, crouching: input.crouching } as never, dt, time, () => 0)
      joints = extractBonePoseJoints(survivor.bones)
      planted = (survivor as unknown as { loco: { feet: { planted: boolean }[] } }).loco.feet.map(f => f.planted)
    } else if (zombie && agent) {
      Object.assign(agent, { x, y: z, vx, vy: vz, aim })
      zombie.draw([agent], dt, () => 0, { visible: () => true, actorVisible: () => 1 } as never, [-200, -200, 200, 200], tuning!, false, time)
      const b = zombie.getAgentBones(1)!
      joints = extractBonePoseJoints(b.bones); planted = [...(b.planted ?? [false, false])]
    } else {
      // Woods main lowers the beam while reading; friends-view keeps the carry target from player pitch.
      // There is no map-hand pose in that adapter. Exercise exactly the torch-axis change, not an invented left reach.
      if (person && carry) a.reach = { r: carry(-0.25), k: 1 }
      anim.animate(a, dt, time, x / s, z / s, vx / s, vz / s, aim)
      joints = extractBodyJoints(a.body!)
      planted = a.feet.map(f => f.planted)
      if (a.body!.gun && actor === "soldier") grips = { rifle: { hand: "wristR", anchor: at(a.body!.gun, 0, 0, 0) } }
      if (person && rest && people) {
        // Call the production method itself, including gait blend, terrain, idle and IK. drive uses no GPU without eye.
        people.People.prototype.drive.call({ lodDistance: 9 } as import("../../packages/kit/people/view").People, person, a,
          { dt, time, torch: { side: 1, dir: [Math.cos(aim), -0.25 - input.map * 0.8, Math.sin(aim)] } })
        const P = (name: string): V3 => [...person!.pose.pos[rest.idx[name]!]!]
        joints = { pelvis: P("pelvis"), waist: P("spine_01"), chest: P("spine_03"), neck: P("neck_01"), headTop: P("head") } as RigJointMap
        for (const [sd, suffix] of [["L", "l"], ["R", "r"]] as const) {
          for (const [joint, bone] of [["hip", "thigh"], ["knee", "calf"], ["ankle", "foot"], ["ball", "ball"], ["shoulder", "upperarm"], ["elbow", "lowerarm"], ["wrist", "hand"]] as const)
            joints[`${joint}${sd}`] = P(`${bone}_${suffix}`)
          const ball = joints[`ball${sd}`], ankle = joints[`ankle${sd}`]
          const d = Math.hypot(...ball.map((v, k) => v - ankle[k]!))
          const ballIndex = rest.idx[`ball_${suffix}`]!, ankleIndex = rest.idx[`foot_${suffix}`]!
          const bindQ = rest.skeleton.bindRot[ballIndex]!
          const bindDir = rest.skeleton.bindPos[ballIndex]!.map((v, k) => v - rest.skeleton.bindPos[ankleIndex]![k]!) as V3
          const local = qRot!([-bindQ[0], -bindQ[1], -bindQ[2], bindQ[3]], bindDir)
          const direction = qRot!(person.pose.rot[ballIndex]!, local).map(v => v / Math.hypot(...bindDir)) as V3
          // Toe endpoint follows the actual toe bone's rotation, with the rig's toe-to-foot proportion.
          joints[`toe${sd}`] = ball.map((v, k) => v + direction[k]! * d * RIG.toe / Math.hypot(RIG.foot, RIG.ankle)) as V3
        }
        planted = (person.gait?.loco.feet ?? a.feet).map(f => f.planted)
        numbers = Object.fromEntries(rest.skeleton.names.map((name, i) => [name, [...person!.pose.pos[i]!, ...person!.pose.rot[i]!]]))
        contacts = Object.fromEntries((["L", "R"] as const).map((sd, k) => {
          const suffix = k ? "r" : "l", b = joints[`ball${sd}`], foot = P(`foot_${suffix}`)
          const off = qRot!(person!.pose.rot[rest.idx[`foot_${suffix}`]!]!, rest.heel[k]!)
          const heel: V3 = foot.map((v, n) => v + off[n]!) as V3
          const sole: V3 = [b[0], b[1] - rest.ballHeight, b[2]]
          return [`ball${sd}`, { point: sole, surfaceY: Math.min(sole[1], heel[1]), ground: 0, planted: planted[k]! }]
        }))
        if (person.pose.torch) grips = { torch: { hand: "wristR", anchor: [...person.pose.torch.p] } }
      }
    }
    contacts ??= Object.fromEntries((["L", "R"] as const).map((sd, k) => [`ball${sd}`, { point: joints[`ball${sd}`], ground: 0, planted: planted[k]! }]))
    frames.push({ dt, time, scenario: input.scenario, joints, speed: Math.hypot(vx, vz), contacts, grips, numbers })
  }
  return frames
}
