import { expect, test } from "bun:test"
import {
  applyClickSelection,
  applyMarqueeSelection,
  computeSelectionCentroid,
  normalizeMarqueeRect,
  pickObjectsInMarquee,
} from "./selection"
import type { LabWorldObject } from "./types"

test("click selection, Shift toggle add/remove, and empty-ground clear", () => {
  const s1 = applyClickSelection([], "prop:1", false)
  expect(s1).toEqual({ ids: ["prop:1"], primaryId: "prop:1" })

  const s2 = applyClickSelection(s1.ids, "prop:2", true)
  expect(s2).toEqual({ ids: ["prop:1", "prop:2"], primaryId: "prop:2" })

  const s3 = applyClickSelection(s2.ids, "prop:1", true)
  expect(s3).toEqual({ ids: ["prop:2"], primaryId: "prop:2" })

  const s4 = applyClickSelection(s2.ids, null, true)
  expect(s4).toEqual({ ids: ["prop:1", "prop:2"], primaryId: "prop:2" })

  const s5 = applyClickSelection(s2.ids, null, false)
  expect(s5).toEqual({ ids: [], primaryId: null })
})

test("marquee rect normalization, object projection filtering, and additive marquee", () => {
  const rect = normalizeMarqueeRect(400, 300, 100, 100, 800, 600)
  expect(rect).toEqual({
    left: 100,
    top: 100,
    width: 300,
    height: 200,
    u0: 0.125,
    v0: 100 / 600,
    u1: 0.5,
    v1: 0.5,
  })

  const objects: LabWorldObject[] = [
    { id: "character:active", label: "Muscle", category: "character", x: 0, y: 0, z: 8 },
    { id: "prop:1", label: "Cone #1", category: "prop", x: -2, y: 0, z: 2, yaw: 0.5 },
    { id: "prop:2", label: "Cone #2", category: "prop", x: 0, y: 0, z: 2, yaw: 0.5 },
    { id: "prop:3", label: "Cone #3", category: "prop", x: 8, y: 0, z: 2, yaw: 0.5 },
  ]
  const project = (x: number, _y: number, z: number) => ({
    u: (x + 10) / 20,
    v: (z + 10) / 20,
    visible: true,
  })
  const fullRect = normalizeMarqueeRect(0, 0, 560, 600, 800, 600) // u <= 0.7 -> x <= 4
  const picked = pickObjectsInMarquee(objects, project, fullRect)
  expect(picked.map(o => o.id)).toEqual(["prop:1", "prop:2"])

  const m1 = applyMarqueeSelection(["prop:0"], picked.map(o => o.id), false)
  expect(m1).toEqual({ ids: ["prop:1", "prop:2"], primaryId: "prop:2" })

  const m2 = applyMarqueeSelection(["prop:0"], picked.map(o => o.id), true)
  expect(m2).toEqual({ ids: ["prop:0", "prop:1", "prop:2"], primaryId: "prop:2" })

  const centroid = computeSelectionCentroid(picked)
  expect(centroid).toEqual({ x: -1, y: 0, z: 2, yaw: 0.5, count: 2 })
})
