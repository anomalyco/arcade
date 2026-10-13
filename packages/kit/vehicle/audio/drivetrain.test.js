import { describe, expect, test } from "bun:test"
import { character, characters, Gearbox, tyreSlip } from "./drivetrain"

describe("automatic gearbox", () => {
  test("idles and bounds every vehicle at launch and overspeed", () => {
    for (const s of Object.values(characters)) {
      const g = new Gearbox(s)
      for (let i = 0; i < 120; i++) g.update(0, 0, false, 1 / 60)
      expect(g.rpm).toBe(s.idle)
      for (let i = 0; i < 900; i++) {
        g.update(i / 5, 1, true, 1 / 60)
        expect(g.rpm).toBeGreaterThanOrEqual(s.idle)
        expect(g.rpm).toBeLessThanOrEqual(s.redline)
      }
      expect(g.gear).toBe(s.ratios.length - 1)
    }
  })
  test("upshift drops RPM, and a steady boundary does not hunt", () => {
    const g = new Gearbox(character("muscle"))
    let before = 0, shiftedAt = 0
    for (let i = 0; i < 900; i++) {
      before = g.rpm; g.update(i / 40, 1, false, 1 / 60)
      if (g.shifted) { shiftedAt = i; break }
    }
    expect(shiftedAt).toBeGreaterThan(0)
    for (let i = 0; i < 20; i++) g.update(shiftedAt / 40, 1, false, 1 / 60)
    expect(g.rpm).toBeLessThan(before * 0.8)
    let shifts = 0
    for (let i = 0; i < 600; i++) { g.update(shiftedAt / 40 + Math.sin(i) * 0.1, 1, false, 1 / 60); shifts += Number(g.shifted) }
    expect(shifts).toBe(0)
    for (let i = 0; i < 600; i++) g.update(0, 0, false, 1 / 60)
    expect(g.gear).toBe(0)
    expect(g.rpm).toBeCloseTo(g.spec.idle, 3)
  })
  test("reverse stays in first and frame-rate changes stay close", () => {
    const a = new Gearbox(character("compact")), b = new Gearbox(character("compact"))
    for (let i = 0; i < 600; i++) a.update(8, 0.6, false, 1 / 60)
    for (let i = 0; i < 300; i++) b.update(8, 0.6, false, 1 / 30)
    expect(a.rpm).toBeCloseTo(b.rpm, 2)
    for (let i = 0; i < 300; i++) a.update(-30, 1, false, 1 / 60)
    expect(a.gear).toBe(0)
  })
})

describe("tyres", () => {
  test("straight driving is silent; gentle scrub precedes rising squeal", () => {
    expect(tyreSlip(30, 0, 0, false).squeal).toBe(0)
    expect(tyreSlip(30, 0, 0, false).scrub).toBe(0)
    const gentle = tyreSlip(20, 2, 0, false), drift = tyreSlip(20, 8, 0, false), hard = tyreSlip(20, 14, 0, false)
    expect(gentle.scrub).toBeGreaterThan(0)
    expect(gentle.squeal).toBe(0)
    expect(drift.squeal).toBeGreaterThan(gentle.squeal)
    expect(hard.squeal).toBeGreaterThan(drift.squeal)
    expect(hard.hz).toBeGreaterThan(drift.hz)
  })
  test("launch slip chirps, air is silent, grass suppresses tonal squeal", () => {
    expect(tyreSlip(1, 0, 1, false).squeal).toBeGreaterThan(0)
    expect(tyreSlip(30, 15, 1, true, true).squeal).toBe(0)
    expect(tyreSlip(30, 15, 1, true, true).scrub).toBe(0)
    expect(tyreSlip(30, 15, 0, true, false, "grass").squeal).toBeLessThan(0.1)
  })
})
