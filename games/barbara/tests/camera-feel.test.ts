import { expect, test } from "bun:test"
import { FEEL, newPlayer, stepMotion } from "../shared/sim"
import { makeWorld } from "../shared/world"
import { CameraFeel } from "../src/camera-feel"
import { synthFoleySound, type FoleyKind } from "../src/audio/foley"

const noop = () => {}
Object.assign(globalThis, { window: globalThis.window ?? { addEventListener: noop }, document: globalThis.document ?? { addEventListener: noop, pointerLockElement: null } })
const { WoodsCamera } = await import("../src/camera")
const canvas = { addEventListener: noop } as unknown as HTMLCanvasElement
const world = makeWorld()
const DEG = Math.PI / 180

/** Walks (or runs) straight ahead for `seconds` at `hz`, jumping on the given frame, recording the camera's mount. */
function walk(opts: { hz?: number; seconds?: number; reduced?: boolean; sprint?: boolean; jumpAt?: number; strafe?: boolean; before?: (feel: CameraFeel, i: number) => void }) {
  const hz = opts.hz ?? 60, camera = new WoodsCamera(canvas, () => false, { cameraMotion: 1, reduceMotion: !!opts.reduced, stepLength: 0.72, walkSettle: 0.3, landDip: 0.035 }, () => true)
  const feel = new CameraFeel()
  camera.feel = feel
  const p = newPlayer(1, false, "A", world.camp.spawn.x, world.camp.spawn.z, 0)
  const rows: { yaw: number; pitch: number; roll: number; fov: number; eye: number }[] = []
  for (let i = 0; i < hz * (opts.seconds ?? 3); i++) {
    opts.before?.(feel, i)
    const move = opts.strafe ? { mx: 1, mz: 0 } : { mx: 0, mz: -1 }
    stepMotion(world, p, { yaw: 0, pitch: 0, light: true, ...move, map: false, tie: false, sprint: !!opts.sprint, jump: i === opts.jumpAt }, FEEL, 1 / hz)
    camera.place(p.x, p.z, 1.68, 1 / hz, 16 / 9, p.air.y)
    rows.push({ yaw: camera.mount.yaw, pitch: camera.mount.pitch, roll: camera.mount.roll, fov: camera.mount.fov, eye: camera.eye[1] })
  }
  return { rows, feel, camera }
}
const maxAbs = (xs: number[]) => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0)

test("walking never shakes: no yaw from the feel without a turn or an event", () => {
  const { rows, feel } = walk({})
  expect(maxAbs(rows.map((r) => r.yaw))).toBeLessThan(1e-6)
  expect(feel.jolt.trauma + feel.rumble.trauma).toBe(0)
})

test("running pushes the FOV a few degrees, walking doesn't", () => {
  expect(maxAbs(walk({}).rows.map((r) => r.fov))).toBeLessThan(0.2)
  const run = walk({ sprint: true }).rows.slice(-30).map((r) => r.fov)
  expect(Math.min(...run)).toBeGreaterThan(3)
  expect(Math.max(...run)).toBeLessThan(4.2)
})

test("landing a jump pitches the view down briefly and comes back", () => {
  const { rows } = walk({ seconds: 2, jumpAt: 30 })
  const low = Math.min(...rows.map((r) => r.pitch))
  expect(low).toBeLessThan(-0.6 * DEG)
  expect(low).toBeGreaterThan(-3 * DEG)
  expect(Math.abs(rows.at(-1)!.pitch)).toBeLessThan(0.3 * DEG)
})

test("strafing leans the view; reduce camera motion keeps it level and still", () => {
  const lean = walk({ strafe: true }).rows.slice(-30).map((r) => r.roll)
  expect(Math.min(...lean.map(Math.abs))).toBeGreaterThan(0.3 * DEG)
  const reduced = walk({ strafe: true, reduced: true, jumpAt: 20, before: (f, i) => { if (i === 40) f.kick(1) } }).rows
  expect(maxAbs(reduced.map((r) => r.roll))).toBe(0)
  expect(maxAbs(reduced.map((r) => r.pitch))).toBe(0)
  expect(maxAbs(reduced.map((r) => r.yaw))).toBe(0)
})

test("near thunder rumbles when it arrives, not before, and dies away", () => {
  const thunder = { id: 1, kind: "cg" as const, distance: 350, bearing: 0, position: [0, 0, 0] as const, emitted: 0, arrives: 1, power: 1 }
  const { rows } = walk({ seconds: 6, before: (f, i) => f.storm(i === 0 ? [thunder as never] : [], i / 60) })
  expect(maxAbs(rows.slice(0, 55).map((r) => r.yaw))).toBe(0)
  expect(maxAbs(rows.slice(60, 120).map((r) => r.yaw))).toBeGreaterThan(0.1 * DEG)
  expect(maxAbs(rows.slice(-20).map((r) => r.yaw))).toBeLessThan(0.05 * DEG)
})

test("the creature crossing in front of you freezes the view a beat and sets your heart going", () => {
  const feel = new CameraFeel()
  feel.creature(55, true)
  expect(feel.fear).toBeGreaterThan(0.6)
  expect(feel.stopped(1 / 60, false)).toBeLessThan(1 / 120)
  const calm = new CameraFeel()
  calm.creature(130, false)
  expect(calm.fear).toBe(0)
  expect(calm.stopped(1 / 60, false)).toBe(1 / 60)
})

test("foley takes are deterministic and quiet", () => {
  for (const k of ["leaves", "paper.up", "paper.down", "tape.pull", "tape.tear", "heart", "zoom", "ir.click"] as FoleyKind[]) {
    const a = synthFoleySound(k, 3), b = synthFoleySound(k, 3)
    expect(a).toEqual(b)
    let peak = 0
    for (const x of a) peak = Math.max(peak, Math.abs(x))
    expect([k, peak > 0.01 && peak < 0.7]).toEqual([k, true])
  }
})
