import { expect, test } from "bun:test"
import { FEEL, newPlayer, stepMotion } from "../shared/sim"
import { makeWorld } from "../shared/world"
import type { FootEvent } from "@arcade/kit/audio/footsteps"

const noop = () => {}
Object.assign(globalThis, { window: globalThis.window ?? { addEventListener: noop }, document: globalThis.document ?? { addEventListener: noop, pointerLockElement: null } })
const { WoodsCamera } = await import("../src/camera")
const canvas = { addEventListener: noop } as unknown as HTMLCanvasElement
const world = makeWorld()

test("the shared sim hop raises the camera, suppresses air steps and lands softly at every display rate", () => {
  for (const hz of [30, 60, 144]) for (const reduced of [false, true]) {
    const camera = new WoodsCamera(canvas, () => false, { cameraMotion: 1, reduceMotion: reduced, stepLength: 0.72, walkSettle: 0.3, landDip: 0.035 }, () => true)
    const p = newPlayer(1, false, "A", world.camp.spawn.x, world.camp.spawn.z, 0)
    const events: FootEvent[] = []
    let peak = 0, dip = 0
    for (let i = 0; i < hz * 1.5; i++) {
      stepMotion(world, p, { yaw: 0, pitch: 0, light: true, mx: 0, mz: 0, map: false, tie: false, jump: i === 0 }, FEEL, 1 / hz)
      camera.place(p.x, p.z, 1.68, 1 / hz, 16 / 9, p.air.y)
      if (p.air.airborne) expect(camera.walk.events).toEqual([])
      events.push(...camera.walk.events)
      peak = Math.max(peak, camera.eye[1] - 1.68)
      dip = Math.min(dip, camera.eye[1] - 1.68)
    }
    expect(peak).toBeGreaterThan(0.29)
    expect(peak).toBeLessThan(0.31)
    expect(dip).toBeGreaterThan(-0.04)
    if (reduced) expect(dip).toBeGreaterThan(-1e-6)
    else expect(dip).toBeLessThan(-0.025)
    const feet = events.filter((e) => e.kind === "step")
    expect(feet).toHaveLength(2)
    expect(feet.every((e) => e.gain <= 0.2)).toBe(true)
    expect(Math.abs(camera.eye[1] - 1.68)).toBeLessThan(0.002)
  }
})
