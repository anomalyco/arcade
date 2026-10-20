import { describe, expect, test } from "bun:test"
import { CASE_CLOSE_S, CASE_OPEN_S, caseShut, caseStyle, pieceAt, SHUT, stepCaseMotion, type CaseMotion, type CaseStyle } from "../src/inventory/motion"

// Per-frame traces of the case's open and close (AR-94): Kit's "this doesn't transition in and out". No frame jumps,
// retargeting mid-flight keeps going from where it is, and the timings hold at 60 and 144 Hz.

type Frame = { t: number; m: CaseMotion; s: CaseStyle }

/** Plays `script` (the target at each time) for `seconds` at `hz`, one frame per step. */
function trace(script: (t: number) => 0 | 1, seconds: number, hz = 60, reduced = false, from: CaseMotion = SHUT): Frame[] {
  const out: Frame[] = []
  let m = from
  for (let i = 0; i <= Math.round(seconds * hz); i++) {
    const t = i / hz
    m = stepCaseMotion(m, script(t), 1 / hz, reduced)
    out.push({ t, m, s: caseStyle(m, reduced) })
  }
  return out
}

/** The biggest change of each value between two frames, scaled to a 60 Hz frame. */
function maxSteps(frames: readonly Frame[], hz: number) {
  const keys = ["dim", "opacity", "scale", "squash", "y", "lid", "pieces"] as const
  const max = Object.fromEntries(keys.map((k) => [k, 0])) as Record<(typeof keys)[number], number>
  for (let i = 1; i < frames.length; i++) for (const k of keys) max[k] = Math.max(max[k], (Math.abs(frames[i]!.s[k] - frames[i - 1]!.s[k]) * hz) / 60)
  return max
}

/** Per 60 Hz frame: nothing may move more than this (a pop would be one frame doing it all). */
const CAPS = { dim: 0.3, opacity: 0.4, scale: 0.015, squash: 0.02, y: 4, lid: 24, pieces: 0.3 }

const firstAt = (frames: readonly Frame[], pred: (f: Frame) => boolean) => frames.find(pred)?.t ?? Infinity

describe("the case opens and closes (AR-94)", () => {
  for (const hz of [60, 144]) {
    test(`opens in ~${CASE_OPEN_S * 1000} ms and closes in ~${CASE_CLOSE_S * 1000} ms with no frame jumps at ${hz} Hz`, () => {
      const open = trace(() => 1, 0.6, hz)
      expect(firstAt(open, (f) => f.m.p >= 0.98)).toBeGreaterThan(0.2)
      expect(firstAt(open, (f) => f.m.p >= 0.98)).toBeLessThan(0.3)
      const rest = open.at(-1)!.s
      expect(rest).toEqual({ dim: 1, opacity: 1, scale: 1, squash: 1, y: 0, lid: 0, pieces: 1 })
      // Bounce 0: it never passes open.
      expect(Math.max(...open.map((f) => f.m.p))).toBeLessThanOrEqual(1)
      const close = trace(() => 0, 0.4, hz, false, open.at(-1)!.m)
      expect(firstAt(close, (f) => f.m.p <= 0.02)).toBeGreaterThan(0.11)
      expect(firstAt(close, (f) => f.m.p <= 0.02)).toBeLessThan(0.17)
      expect(caseShut(close.at(-1)!.m)).toBe(true)
      for (const [k, cap] of Object.entries(maxSteps([...open, ...close], hz))) expect([k, cap]).toEqual([k, Math.min(cap, CAPS[k as keyof typeof CAPS])])
    })
  }

  test("the wind-up: the case dips and compresses first, then rises", () => {
    const open = trace(() => 1, 0.3)
    const y = open.map((f) => f.s.y)
    const low = y.indexOf(Math.max(...y))
    // Shut, it rests 14 px down; the wind-up takes it lower before it rises.
    expect(caseStyle(SHUT, false).y).toBe(14)
    expect(y[low]!).toBeGreaterThan(14.3)
    expect(open[low]!.t).toBeLessThan(0.08)
    expect(Math.min(...open.map((f) => f.s.squash))).toBeLessThan(0.99)
    // After the dip, one way up.
    for (let i = low + 1; i < y.length; i++) expect(y[i]!).toBeLessThanOrEqual(y[i - 1]! + 1e-9)
    // The lid swings a beat behind the case.
    const caseHalf = firstAt(open, (f) => f.s.opacity >= 0.5)
    const lidHalf = firstAt(open, (f) => f.s.lid >= -40)
    expect(lidHalf).toBeGreaterThan(caseHalf)
  })

  test("Tab spam: every reversal carries on from where it is, and it ends where the last press says", () => {
    const presses = [0, 0.05, 0.09, 0.16, 0.2, 0.31]
    const target = (t: number) => (presses.filter((p) => p <= t).length % 2 ? 1 : 0) as 0 | 1
    const frames = trace(target, 0.9)
    for (const [k, cap] of Object.entries(maxSteps(frames, 60))) expect([k, cap]).toEqual([k, Math.min(cap, CAPS[k as keyof typeof CAPS])])
    // Velocity carries through a reversal: no frame snaps back toward shut or open.
    expect(frames.every((f) => Number.isFinite(f.m.p) && f.m.p >= -1e-9 && f.m.p <= 1 + 1e-9)).toBe(true)
    expect(caseShut(frames.at(-1)!.m)).toBe(true)
    // No wind-up when it reopens from half open (only from shut).
    const reopen = frames.find((f) => f.t > 0.16 && f.t < 0.2)!
    expect(reopen.s.squash).toBe(1)
  })

  test("the pieces come in staggered and leave last-in first-out", () => {
    const open = trace(() => 1, 0.4)
    const early = 0.22
    const late = 0.46
    const tIn = (d: number) => firstAt(open, (f) => pieceAt(f.s.pieces, d) >= 1)
    expect(tIn(early)).toBeLessThan(tIn(late))
    expect(pieceAt(1, late)).toBe(1)
    const close = trace(() => 0, 0.3, 60, false, open.at(-1)!.m)
    const tOut = (d: number) => firstAt(close, (f) => pieceAt(f.s.pieces, d) <= 0)
    expect(tOut(late)).toBeLessThan(tOut(early))
  })

  test("reduced motion: a short fade, no travel, lid or stagger", () => {
    const frames = [...trace(() => 1, 0.3, 60, true), ...trace(() => 0, 0.3, 60, true, { p: 1, v: 0, target: 1, sinceOpen: 9 })]
    for (const f of frames) expect([f.s.scale, f.s.squash, f.s.y, f.s.lid, f.s.pieces]).toEqual([1, 1, 0, 0, 1])
    expect(firstAt(frames, (f) => f.m.p >= 1)).toBeCloseTo(0.16, 1)
  })
})
