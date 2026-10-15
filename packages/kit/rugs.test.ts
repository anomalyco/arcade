import { describe, expect, test } from "bun:test"
import {
  RUG_MOTIF_IDS,
  RUG_PALETTE_IDS,
  RUG_STYLE_IDS,
  bakeRugRgbaCpu,
  bakeRugWithMipsCpu,
  createDefaultRugParams,
  deriveRugPileNormalCpu,
  evaluateRugTexelCpu,
  exportRugPreset,
  importRugPreset,
  packRugBakeUniforms,
  randomizeRugParams,
  seededRugParamsForSlot,
  validateRugParams,
} from "./rugs"

describe("procedural rug generator (@arcade/kit/rugs)", () => {
  test("evaluates all 6 rug styles, 6 palettes, and 6 motif modes deterministically", () => {
    for (const style of RUG_STYLE_IDS) {
      const p0 = createDefaultRugParams(style, 17)
      const a = evaluateRugTexelCpu(0.32, 0.41, p0)
      const b = evaluateRugTexelCpu(0.32, 0.41, p0)
      expect(a).toEqual(b)
      expect(a.r).toBeGreaterThanOrEqual(0)
      expect(a.r).toBeLessThanOrEqual(255)
      expect(a.a).toBeGreaterThan(0)
    }

    for (const palette of RUG_PALETTE_IDS) {
      const p = { ...createDefaultRugParams("persian_medallion", 23), palette }
      const center = evaluateRugTexelCpu(0.5, 0.5, p)
      const border = evaluateRugTexelCpu(0.08, 0.5, p)
      expect(center.r + center.g + center.b).toBeGreaterThan(10)
      expect(border.r + border.g + border.b).toBeGreaterThan(10)
    }

    for (const motif of RUG_MOTIF_IDS) {
      const p = { ...createDefaultRugParams("persian_medallion", 31), motif }
      const border = evaluateRugTexelCpu(0.09, 0.35, p)
      expect(border.a).toBeGreaterThan(40)
    }
  })

  test("enforces 4-fold vs 2-fold symmetry on interior pattern coordinates", () => {
    const p4 = {
      ...createDefaultRugParams("persian_medallion", 11),
      symmetry: 4 as const,
      abrash: 0,
      wear: 0,
      knotDensity: 1.0,
    }
    // Check that 4-fold symmetry mirrors across v=0.5 when abrash/wear are zero
    const top = evaluateRugTexelCpu(0.35, 0.28, p4)
    const bot = evaluateRugTexelCpu(0.35, 1 - 0.28, p4)
    expect(Math.abs(top.r - bot.r)).toBeLessThanOrEqual(6)
    expect(Math.abs(top.g - bot.g)).toBeLessThanOrEqual(6)

    // 2-fold kilim prayer arch differs between top (v=0.25) and bottom (v=0.75)
    const p2 = {
      ...createDefaultRugParams("kilim_geometric", 11),
      symmetry: 2 as const,
      abrash: 0,
      wear: 0,
    }
    let diffSum = 0
    for (let i = 1; i <= 8; i++) {
      const u = 0.25 + i * 0.03
      const t = evaluateRugTexelCpu(u, 0.24, p2)
      const b = evaluateRugTexelCpu(u, 0.76, p2)
      diffSum += Math.abs(t.r - b.r) + Math.abs(t.g - b.g) + Math.abs(t.b - b.b)
    }
    expect(diffSum).toBeGreaterThan(20)
  })

  test("bakes mip chain in linear light and derives finite unit normals from pile height", () => {
    const params = createDefaultRugParams("persian_medallion", 7)
    const mips = bakeRugWithMipsCpu(params, 64)
    expect(mips.length).toBe(7)
    expect(mips[0]!.width).toBe(64)
    expect(mips[6]!.width).toBe(1)

    const mip0 = mips[0]!.data
    const n = deriveRugPileNormalCpu(mip0, 64, 64, 16, 24)
    const len = Math.hypot(n[0], n[1], n[2])
    expect(len).toBeCloseTo(1, 5)
    expect(n[1]).toBeGreaterThan(0.2)
  })

  test("seededRugParamsForSlot produces varied recipes across house seeds and room slots", () => {
    const slot0House7 = seededRugParamsForSlot(7, 0, "house")
    const slot1House7 = seededRugParamsForSlot(7, 1, "house")
    const slot2House7 = seededRugParamsForSlot(7, 2, "house")
    const slot0House12 = seededRugParamsForSlot(12, 0, "house")

    expect(slot0House7.seed).not.toBe(slot1House7.seed)
    expect(slot2House7.aspect).toBeGreaterThan(2.5) // Hallway runner aspect ratio
    expect(slot0House7).not.toEqual(slot0House12)
  })

  test("randomizeRugParams uses isolated tuningSeed without mutating structural seed", () => {
    const base = createDefaultRugParams("persian_medallion", 77)
    const r1 = randomizeRugParams(base, 101)
    const r2 = randomizeRugParams(base, 101)
    const r3 = randomizeRugParams(base, 202)
    expect(r1).toEqual(r2)
    expect(r1.seed).toBe(77)
    expect(r1).not.toEqual(r3)
  })

  test("validates and round-trips versioned RugPresetV1 JSON", () => {
    const base = createDefaultRugParams("turkmen_gul", 42)
    const preset = exportRugPreset(base)
    const json = JSON.stringify(preset)
    const imported = importRugPreset(json)
    expect(imported.ok).toBe(true)
    if (imported.ok) {
      expect(imported.value.params).toEqual(base)
    }

    expect(importRugPreset("{bad json").ok).toBe(false)
    expect(importRugPreset(JSON.stringify({ version: 99, params: base })).ok).toBe(false)
    expect(validateRugParams({ ...base, style: "unknown_style" }).ok).toBe(false)

    const buf = packRugBakeUniforms(base, 1024)
    expect(buf[0]).toBe(1024)
  })
})
