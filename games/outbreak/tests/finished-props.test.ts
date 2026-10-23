import { expect, test } from "bun:test"
import { decodeFinish } from "@arcade/kit/gpu/finish-bake"
import { lookIndex } from "@arcade/kit/gpu/materials/wear"
import { makeTown } from "../shared/map"
import { interiorSettings } from "../src/interiors/plan"
import { buildLevel } from "../src/level"

const VERT = 24

function finished(on: number) {
  const prior = interiorSettings.finish
  interiorSettings.finish = on
  try {
    const level = buildLevel(makeTown(7))
    let count = 0, total = 0, cornerAo = 1, maxEdge = 0
    for (const c of level.chunks) {
      const u = new Uint8Array(c.data)
      for (let o = 0; o < u.length; o += VERT) {
        total++
        const d = decodeFinish(u[o + 15]!, u[o + 19]!)
        if (!d) continue
        count++
        expect(d.look).toBe(lookIndex("old-wood"))
        expect(d.exposure).toBe(0)
        cornerAo = Math.min(cornerAo, d.ao)
        maxEdge = Math.max(maxEdge, d.curvature)
      }
    }
    return { count, total, cornerAo, maxEdge }
  } finally { interiorSettings.finish = prior }
}

test("finished props: the fitted kitchens bake AO and chamfer curvature as old wood; Today leaves every vertex plain", () => {
  expect(finished(0).count).toBe(0)
  const on = finished(1)
  expect(on.count).toBeGreaterThan(5000)
  expect(on.maxEdge).toBe(1)
  expect(on.cornerAo).toBeLessThan(0.5)
}, 60_000)
