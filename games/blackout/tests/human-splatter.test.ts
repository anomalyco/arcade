import { expect, test } from "bun:test"
import { detachedSplatter } from "../src/game/human-splatter"
import { yawFrame } from "@arcade/kit/rig"
import { Splatter, splatterPresets, type SplatterImpact } from "@arcade/kit/fx/splatter"
import { SplatterSurfaces } from "@arcade/kit/fx/splatter-surfaces"

test("detached wound forwards stable identity, world position and offset velocity once", () => {
  const part = { bone: "right.foreArm" as const, frame: yawFrame([10, 2, 4], 0),
    linear: [1, 0, 0] as [number, number, number], angular: [0, 0, 2] as [number, number, number] }
  const before = JSON.stringify(part), events: SplatterImpact[] = []
  const fx = new Splatter(new SplatterSurfaces([]))
  const emit = (event: SplatterImpact) => { events.push(event); return fx.emit(event, splatterPresets.blood) }
  const impact = { id: 71, seed: 19, direction: [0, 1, 0] as [number, number, number], point: [10, 1.5, 4] as [number, number, number] }
  expect(detachedSplatter(emit, part, impact)).toBe(true)
  expect(detachedSplatter(emit, part, impact)).toBe(false)
  expect(events[0]).toMatchObject({ id: 71, limbId: 6, seed: 19, x: 10, y: 1.5, z: 4, dx: 0, dy: 1, dz: 0, vx: 2, vy: 0, vz: 0 })
  expect(JSON.stringify(part)).toBe(before)
})
