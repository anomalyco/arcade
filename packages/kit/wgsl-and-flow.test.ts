import { describe, expect, test } from "bun:test"
import { resolveWgsl, wgslSlot, wgslSnippet, wgslStruct } from "./gpu/wgsl"
import { FlowFieldNav } from "./sim/flow-field"

describe("wgslStruct & resolveWgsl", () => {
  test("handles WGSL vec3f 16-byte alignment and struct tail padding", () => {
    const S = wgslStruct("TestAlign", {
      a: "f32",
      b: "vec3f",
      c: "f32",
    })
    expect(S.byteSize).toBe(32)
    expect(S.offsetOf("a")).toBe(0)
    expect(S.offsetOf("b")).toBe(4) // aligned to 16 bytes (float offset 4)
    expect(S.offsetOf("c")).toBe(7) // immediately follows vec3f (bytes 16..28 -> float offset 7)
    const buf = S.pack({ a: 1.5, b: [2, 3, 4], c: 9 })
    expect(Array.from(buf)).toEqual([1.5, 0, 0, 0, 2, 3, 4, 9])
  })

  test("resolves transitive dependencies once and applies slot overrides", () => {
    const modeSlot = wgslSlot("mode", "fast" as "fast" | "hq")
    const base = wgslSnippet("base", "fn helper() -> f32 { return 1.0; }")
    const main = wgslSnippet(
      "main",
      (ctx) => `fn run() -> f32 { return helper() * ${ctx.get(modeSlot) === "hq" ? "2.0" : "1.0"}; }`,
      [base],
    )
    expect(resolveWgsl(main)).toContain("helper() * 1.0")
    expect(resolveWgsl(main, [[modeSlot, "hq"]])).toContain("helper() * 2.0")
  })
})

describe("FlowFieldNav", () => {
  test("computes portal-aware flow field and caches across repeated queries", () => {
    const flow = new FlowFieldNav(32, 32, 0.5, 4)
    flow.rebuildTopology(
      [[10, 0, 11, 20]],
      [{ id: "d0", kind: "door", rect: [10, 8, 11, 10], open: true }],
      0.28,
    )
    const dir = { x: 0, y: 0 }
    flow.sampleDirection(4, 9, 20, 9, dir)
    expect(dir.x).toBeGreaterThan(0.5)
    expect(flow.rebuildCount).toBe(1)

    // Second query to same goal cell hits cache
    flow.sampleDirection(6, 14, 20, 9, dir)
    expect(flow.rebuildCount).toBe(1)
    expect(flow.cacheHitCount).toBe(1)
  })
})
