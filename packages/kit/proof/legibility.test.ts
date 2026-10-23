import { describe, expect, test } from "bun:test"
import { albedoMetrics, counterfactual, qualityGates, slabMetrics, type Frame } from "./legibility"

function frame(w = 100, h = 100, sample: (x: number, y: number) => number = () => 100): Frame {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4, v = sample(x, y)
    data.set([v, v, v, 255], k)
  }
  return { width: w, height: h, data }
}
const failures = (f: Frame) => qualityGates(f).gates.filter(g => g.status === "fail").map(g => g.id)
describe("render preflight", () => {
  test("rejects black, flat and clipped frames; preserves a dark textured scene", () => {
    expect(failures(frame(100, 100, () => 0))).toContain("near-black")
    expect(failures(frame())).toContain("blank")
    expect(failures(frame(100, 100, () => 255))).toContain("washout")
    expect(failures(frame(100, 100, (x, y) => 12 + (x * 17 + y * 31) % 60))).toEqual([])
  })
  test("catches a lifted low-contrast wash without mistaking a textured lit wall for one", () => {
    expect(failures(frame(100, 100, (x, y) => 160 + (x + y) % 3))).toContain("milky-wash")
    expect(failures(frame(100, 100, (x, y) => 120 + (x * 17 + y * 31) % 80))).not.toContain("milky-wash")
  })
  test("Weber is linear-light, detects both dark and bright subjects, and requires area", () => {
    const off = frame(), on = frame(100, 100, (x, y) => x >= 30 && x < 50 && y >= 30 && y < 50 ? 150 : 100)
    const p = counterfactual(on, off)
    expect(p.changedPixels).toBe(400)
    expect(p.weber).toBeCloseTo(1.391, 2) // sRGB 150 vs 100; encoded-space Weber would be only 0.5.
    expect(qualityGates(on, { without: off }).gates.find(g => g.id === "subject-weber")?.status).toBe("pass")
    expect(counterfactual(off, on).weber).toBeLessThan(-0.5)
    expect(qualityGates(off, { without: off }).gates.find(g => g.id === "subject-area")?.status).toBe("fail")
  })
  test("ROI excludes unrelated change; single quantisation steps do not count", () => {
    const off = frame(), on = frame(100, 100, x => x < 50 ? 101 : 180)
    expect(counterfactual(on, off, { x: 0, y: 0, width: 50, height: 100 }).changedPixels).toBe(0)
    expect(() => counterfactual(on, frame(99))).toThrow("dimensions")
    expect(() => counterfactual(on, off, { x: 200, y: 0, width: 1, height: 1 })).toThrow("region")
  })
  test("flat bright slab must move, unlike a distant rectangle or high-variance highlight", () => {
    const slab = (offset: number) => frame(100, 100, (x, y) => x >= 20 + offset && x < 40 + offset && y >= 20 && y < 60 ? 240 : 30)
    expect(slabMetrics(slab(0)).tested).toBe(false)
    expect(slabMetrics(slab(0), slab(0)).moving).toHaveLength(0)
    expect(slabMetrics(slab(0), slab(12)).moving).toHaveLength(1)
    const advisory = qualityGates(slab(0), { shifted: slab(12) })
    expect(advisory.pass).toBe(true)
    expect(advisory.gates.find(g => g.id === "near-camera-slab")?.status).toBe("warn")
    expect(qualityGates(slab(0)).gates.find(g => g.id === "slab-needs-probe")?.status).toBe("warn")
    expect(qualityGates(slab(0), { shifted: slab(12) }, {}, "fail").pass).toBe(false)
    expect(qualityGates(slab(0), {}, {}, "fail").gates.find(g => g.id === "slab-needs-probe")?.status).toBe("fail")
  })
  test("albedo only judges the explicit diffuse material mask", () => {
    const f = frame(100, 100, x => x < 50 ? 10 : 180)
    const mask = Array.from({ length: 10000 }, (_, i) => i % 100 >= 50 ? 1 : 0)
    expect(albedoMetrics(f, mask).outsideShare).toBe(0)
    expect(albedoMetrics(f, mask.map(() => 1)).outsideShare).toBe(0.5)
    expect(albedoMetrics(f, mask.map(() => 0)).outsideShare).toBeNull()
    expect(qualityGates(f, { albedo: { frame: f, mask: mask.map(() => 0) } }).gates.find(g => g.id === "albedo-samples")?.status).toBe("fail")
  })
  test("malformed and transparent frames fail closed", () => {
    expect(() => qualityGates({ width: 10, height: 10, data: [] })).toThrow()
    expect(() => qualityGates({ width: 1, height: 1, data: [0, 0, NaN, 255] })).toThrow()
    expect(() => qualityGates({ width: 1, height: 1, data: [0, 0, 0, 0] })).toThrow()
  })
})
