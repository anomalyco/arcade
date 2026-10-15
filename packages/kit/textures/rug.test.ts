import { describe, expect, test } from "bun:test"
import { bakeRug, rugFringeFraction, rugSpecFor, rugSpecKey, RUG_STYLES, type RugSpec } from "./rug"
import { RUG_PALETTE_IDS, RUG_PALETTES } from "./rug-palettes"

const small: Partial<RugSpec> = { width: 1.4, length: 2.0, knotMm: 9 }

describe("procedural rugs", () => {
  test("every style bakes a full mip chain", () => {
    for (const style of RUG_STYLES) {
      const bake = bakeRug({ ...small, style }, 128)
      expect(bake.mips.length).toBe(8)
      expect(bake.mips[0]!.length).toBe(128 * 128 * 4)
      expect(bake.mips.at(-1)!.length).toBe(4)
    }
  })

  test("the same spec bakes the same pixels; another seed changes the design", () => {
    const a = bakeRug({ ...small, seed: 11 }, 96).mips[0]!
    const b = bakeRug({ ...small, seed: 11 }, 96).mips[0]!
    const c = bakeRug({ ...small, seed: 12 }, 96).mips[0]!
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false)
  })

  test("fringe gaps and the area around an oval are transparent; the body is not", () => {
    const size = 128
    const persian = bakeRug({ ...small, style: "persian", fringe: true }, size).mips[0]!
    const f = rugFringeFraction({ style: "persian", fringe: true, length: small.length! })
    expect(f).toBeGreaterThan(0)
    let holes = 0
    for (let x = 0; x < size; x++) if (persian[(1 * size + x) * 4 + 3] === 0) holes++
    expect(holes).toBeGreaterThan(size * 0.2)
    expect(persian[((size / 2) * size + size / 2) * 4 + 3]).toBeGreaterThan(60)
    const oval = bakeRug({ ...small, style: "braided" }, size).mips[0]!
    expect(oval[3]).toBe(0)
    expect(oval[((size / 2) * size + size / 2) * 4 + 3]).toBeGreaterThan(60)
  })

  test("wear lowers the pile", () => {
    const pile = (wear: number) => {
      const m = bakeRug({ ...small, wear, fade: 0, stains: 0 }, 96).mips[0]!
      let sum = 0
      for (let i = 3; i < m.length; i += 4) sum += m[i]!
      return sum
    }
    expect(pile(1)).toBeLessThan(pile(0) * 0.95)
  })

  test("room picks are deterministic and keys are stable", () => {
    expect(rugSpecFor(42, "living", 2, 3)).toEqual(rugSpecFor(42, "living", 2, 3))
    const spec = rugSpecFor(42, "hall", 0.8, 3)
    expect(rugSpecKey(spec, 512)).toBe(rugSpecKey({ ...spec }, 512))
    const styles = new Set(Array.from({ length: 40 }, (_, i) => rugSpecFor(i, "bedroom", 1.6, 2.2).style))
    expect(styles.size).toBeGreaterThan(2)
  })

  test("palettes fill all twelve roles", () => {
    for (const id of RUG_PALETTE_IDS) expect(RUG_PALETTES[id].colors.length).toBe(12)
  })
})
