import { describe, expect, test } from "bun:test"
import { Input } from "@arcade/kit/client/input"
import { FrameClock, MAX_HITCH_SECONDS, MAX_SUBSTEPS, TICK_DT, TICK_MS } from "../shared/clock"
import { LocalSession } from "../shared/session"
import { supportHeight } from "../shared/terrain"
import { Survivor } from "../src/survivor"
import type { Renderer } from "@arcade/kit/gpu/renderer"

describe("fixed-tick clock policy", () => {
  test("2s controlled movement preserves sim/wall ratio across 60 Hz, 20 Hz, and 12 Hz callbacks without losing time > 50 ms", () => {
    for (const stepMs of [TICK_MS, 50, 83.33333333333333]) {
      const session = new LocalSession(7)
      const startX = session.view.player.x
      const clock = new FrameClock()
      clock.reset(0, { mx: 1, my: 0 })

      let now = 0
      while (now < 2000 - 1e-6) {
        now = Math.min(2000, now + stepMs)
        for (const sub of clock.frame(now, { mx: 1, my: 0 })) {
          session.update(sub.dt, { mx: sub.mx, my: sub.my, aim: 0, interact: sub.interact }, 0)
        }
      }

      const simSeconds = session.view.time
      const wallSeconds = 2.0
      const distance = session.view.player.x - startX
      expect(simSeconds).toBeCloseTo(wallSeconds, 6)
      expect(simSeconds / wallSeconds).toBeCloseTo(1.0, 6)
      expect(distance).toBeCloseTo(3.4 * wallSeconds, 5)
    }
  })

  test("120 Hz, 60 Hz, and jittered frame intervals produce identical tick count, sim time, position, and day-cycle hour", () => {
    const runSchedule = (deltasMs: number[]) => {
      const session = new LocalSession(7)
      // Position on open street for unobstructed comparison.
      Object.assign(session.view.player, { x: 30, y: 41, vx: 0, vy: 0, aim: 0 })
      const clock = new FrameClock()
      clock.reset(0, { mx: 1, my: 0 })
      let now = 0
      let ticks = 0
      for (const d of deltasMs) {
        now += d
        for (const sub of clock.frame(now, { mx: 1, my: 0 })) {
          session.update(sub.dt, { mx: sub.mx, my: sub.my, aim: 0, interact: sub.interact }, 120)
          ticks++
        }
      }
      return {
        ticks,
        time: session.view.time,
        hour: session.view.hour,
        x: session.view.player.x,
        y: session.view.player.y,
      }
    }

    const hz60 = runSchedule(Array.from({ length: 120 }, () => TICK_MS))
    const hz120 = runSchedule(Array.from({ length: 240 }, () => TICK_MS / 2))
    // Jittered intervals summing to exactly 2000 ms (120 ticks)
    const pattern = [6, 27, 9, 41, 12, 55, 8, 22, 14, 6] // sums to 200 ms
    const jittered = runSchedule(Array.from({ length: 10 }, () => pattern).flat())

    expect(hz60.ticks).toBe(120)
    expect(hz120.ticks).toBe(120)
    expect(jittered.ticks).toBe(120)
    expect(hz120.time).toBeCloseTo(hz60.time, 10)
    expect(jittered.time).toBeCloseTo(hz60.time, 10)
    expect(hz120.x).toBeCloseTo(hz60.x, 10)
    expect(jittered.x).toBeCloseTo(hz60.x, 10)
    expect(hz120.hour).toBeCloseTo(hz60.hour, 10)
    expect(jittered.hour).toBeCloseTo(hz60.hour, 10)
  })

  test("bounded hitch debt caps single-frame substeps at MAX_SUBSTEPS and recovers remaining debt on following frames", () => {
    const clock = new FrameClock()
    clock.reset(0, { mx: 1, my: 0 })

    // 300 ms hitch (18 ticks): first callback executes MAX_SUBSTEPS (12 ticks = 200 ms) and retains 100 ms debt.
    const first = clock.frame(300, { mx: 1, my: 0 })
    expect(first).toHaveLength(MAX_SUBSTEPS)
    expect(clock.retainedDebtSeconds).toBeCloseTo(0.1, 4)

    // Next normal 16.67 ms callback drains the remaining 6 + 1 = 7 ticks (<= MAX_SUBSTEPS).
    const second = clock.frame(300 + TICK_MS, { mx: 1, my: 0 })
    expect(second).toHaveLength(7)
    expect(clock.retainedDebtSeconds).toBeCloseTo(0, 4)

    // Extreme 2000 ms stall clamps total debt to MAX_HITCH_SECONDS (500 ms = 30 ticks) to prevent an unbounded spiral.
    let totalAfterStall = 0
    let t = 300 + TICK_MS
    totalAfterStall += clock.frame((t += 2000), { mx: 1, my: 0 }).length
    while (clock.retainedDebtSeconds > 1e-4) {
      totalAfterStall += clock.frame(t, { mx: 1, my: 0 }).length
    }
    expect(totalAfterStall).toBe(Math.round(MAX_HITCH_SECONDS / TICK_DT))
  })

  test("new inputs are not replayed retroactively across an earlier elapsed interval, and quick taps are preserved", () => {
    const clock = new FrameClock()
    clock.reset(0, { mx: 0, my: 0 })

    // 150 ms frame gap (9 ticks), key pressed at 135 ms (only held for final 15 ms).
    clock.recordMove(135, { mx: 1, my: 0 })
    const steps = clock.frame(150, { mx: 1, my: 0 })
    expect(steps).toHaveLength(9)
    expect(steps.slice(0, 8).every(s => s.mx === 0 && s.my === 0)).toBe(true)
    expect(steps[8]!.mx).toBe(1)

    // Held from 150 ms, released at 285 ms before callback at 300 ms: first 8 ticks move, 9th tick stops.
    clock.recordMove(285, { mx: 0, my: 0 })
    const releaseSteps = clock.frame(300, { mx: 0, my: 0 })
    expect(releaseSteps).toHaveLength(9)
    expect(releaseSteps.slice(0, 8).every(s => s.mx === 1)).toBe(true)
    expect(releaseSteps[8]!.mx).toBe(0)

    // Quick tap between ticks (press at 304 ms, release at 311 ms, callback at 316.67 ms) moves for 1 tick, then stops.
    clock.recordMove(304, { mx: 1, my: 0 })
    clock.recordMove(311, { mx: 0, my: 0 })
    const tapSteps = clock.frame(300 + TICK_MS, { mx: 0, my: 0 })
    expect(tapSteps).toHaveLength(1)
    expect(tapSteps[0]!.mx).toBe(1)
    const afterTap = clock.frame(300 + TICK_MS * 2, { mx: 0, my: 0 })
    expect(afterTap).toHaveLength(1)
    expect(afterTap[0]!.mx).toBe(0)
  })

  test("hidden-tab pause and resume reset time anchor with zero catch-up ticks", () => {
    const clock = new FrameClock()
    clock.reset(100, { mx: 1, my: 0 })
    expect(clock.frame(100 + TICK_MS, { mx: 1, my: 0 })).toHaveLength(1)

    // Tab hidden for 5 seconds.
    clock.pause(5100)
    expect(clock.retainedDebtSeconds).toBe(0)
    expect(clock.frame(5100, { mx: 1, my: 0 })).toHaveLength(0)

    // First visible frame 16.67 ms after resume advances only 1 normal tick.
    const resumed = clock.frame(5100 + TICK_MS, { mx: 1, my: 0 })
    expect(resumed).toHaveLength(1)
  })

  test("interact and fire press latches survive 120 Hz sub-tick callbacks and respect cooldowns without queueing", () => {
    const clock = new FrameClock()
    clock.reset(0, { mx: 0, my: 0 })
    let latchedInteract = true
    const takeInteract = () => {
      const v = latchedInteract
      latchedInteract = false
      return v
    }

    // At 8.33 ms (120 Hz half-tick), no sim step runs, so takeInteract is not consumed prematurely.
    expect(clock.frame(TICK_MS / 2, { mx: 0, my: 0 }, takeInteract)).toHaveLength(0)
    expect(latchedInteract).toBe(true)

    // At 16.67 ms, 1 sim step runs and consumes the latched interact edge exactly once.
    const step = clock.frame(TICK_MS, { mx: 0, my: 0 }, takeInteract)
    expect(step).toHaveLength(1)
    expect(step[0]!.interact).toBe(true)
    expect(latchedInteract).toBe(false)

    // Verify shared Input fire-press latch expiry and burst cooldown gating semantics remain intact.
    const fakeWin = new EventTarget()
    const globals = {
      window: fakeWin,
      parent: fakeWin,
      innerWidth: 1000,
      innerHeight: 800,
      location: { search: "", origin: "http://localhost" },
      document: { referrer: "" },
    }
    const previous = new Map<string, PropertyDescriptor | undefined>()
    for (const [key, value] of Object.entries(globals)) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, value })
    }
    try {
      const canvas = Object.assign(new EventTarget(), { tabIndex: 0, focus() {} }) as unknown as HTMLElement
      const input = new Input(canvas, ["KeyF"])
      input.enabled = true

      // Quick mouse tap between ticks latches one fire edge.
      canvas.dispatchEvent(Object.assign(new Event("mousedown"), { button: 0, clientX: 500, clientY: 400 }))
      fakeWin.dispatchEvent(Object.assign(new Event("mouseup"), { button: 0, clientX: 500, clientY: 400 }))
      expect(input.firing).toBe(false)
      expect(input.takeFirePress()).toBe(true)
      expect(input.takeFirePress()).toBe(false)

      // Multiple rapid taps during a weapon cooldown coalesce per tick and never queue a shot after cooldown.
      let cooldownUntil = 0.2
      let shots = 0
      for (let tick = 0; tick < 20; tick++) {
        const t = tick * TICK_DT
        if (tick === 2 || tick === 3) {
          canvas.dispatchEvent(Object.assign(new Event("mousedown"), { button: 0, clientX: 500, clientY: 400 }))
          fakeWin.dispatchEvent(Object.assign(new Event("mouseup"), { button: 0, clientX: 500, clientY: 400 }))
        }
        const pressed = input.takeFirePress()
        if ((input.firing || pressed) && t >= cooldownUntil) {
          shots++
          cooldownUntil = t + 0.15
        }
      }
      expect(shots).toBe(0)
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  })

  test("survivor animation substepping keeps finite joints and planted foot support across jittered frame steps", () => {
    const session = new LocalSession(7)
    Object.assign(session.view.player, { x: 30, y: 41, vx: 0, vy: 0, aim: 0 })
    const fakeRenderer = { addModel: () => 0 } as unknown as Renderer
    const survivor60 = new Survivor(fakeRenderer)
    const survivorSubstepped = new Survivor(fakeRenderer)
    const support = (x: number, z: number) => supportHeight(session.view.town, x, z)

    for (let group = 0; group < 20; group++) {
      // Advance 3 ticks (50 ms)
      for (let s = 0; s < 3; s++) {
        session.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false }, 0)
        survivor60.draw(session.view.player, TICK_DT, session.view.time, support)
      }
      const batches = survivorSubstepped.draw(session.view.player, TICK_DT * 3, session.view.time, support)
      expect(batches).toHaveLength(13)
      for (const b of batches) {
        for (let i = 0; i < 12; i++) expect(Number.isFinite(b.data[i])).toBe(true)
      }
    }
    const final60 = survivor60.draw(session.view.player, TICK_DT, session.view.time, support)
    const finalSub = survivorSubstepped.draw(session.view.player, TICK_DT, session.view.time, support)
    // Pelvis height and position agree closely after substepped walk.
    expect(finalSub[0]!.data[0]).toBeCloseTo(final60[0]!.data[0]!, 3)
    expect(finalSub[0]!.data[1]).toBeCloseTo(final60[0]!.data[1]!, 2)
  })
})
