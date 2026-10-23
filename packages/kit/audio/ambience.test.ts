import { expect, test } from "bun:test"
import { ambiencePcm, type AmbientSound } from "./ambience"

const KINDS: AmbientSound[] = ["wind", "traffic", "buzz", "hvac", "drip", "owl", "dog"]

test("each ambient sound is seeded, finite and leaves headroom", () => {
  for (const kind of KINDS) {
    const a = ambiencePcm(kind, 3), b = ambiencePcm(kind, 3)
    expect([...a]).toEqual([...b])
    expect(a.every(Number.isFinite)).toBe(true)
    expect(Math.max(...a.map(Math.abs))).toBeLessThan(0.5)
    if (kind !== "owl") expect([...ambiencePcm(kind, 4)]).not.toEqual([...a])
  }
})

test("loops are crossfaded to 7.75 s at 24 kHz and one-shots keep their length", () => {
  for (const kind of ["wind", "traffic", "buzz", "hvac"] as const) expect(ambiencePcm(kind).length).toBe(8 * 24000 - 6000)
  expect(ambiencePcm("drip").length).toBe(Math.round(0.45 * 24000))
  expect(ambiencePcm("owl").length).toBe(2 * 24000)
})
