import { describe, expect, test } from "bun:test"
import { LINKS, LinkQueue, TcpLink } from "./net/link-sim"
import { mulberry32 } from "./sim/rng"

const soak = process.env.ARCADE_TEST_SOAK === "1"

describe("TcpLink", () => {
  test("delivers in send order, at least half the RTT later", () => {
    const link = new TcpLink(LINKS.bad, mulberry32(1))
    let last = 0
    let held = 0
    for (let t = 0; t < (soak ? 60_000 : 5_000); t += 33) {
      const at = link.deliver(t)
      if (at === last) held++
      expect(at).toBeGreaterThanOrEqual(last)
      expect(at).toBeGreaterThanOrEqual(t + LINKS.bad.rttMs / 2 - LINKS.bad.jitterMs)
      last = at
    }
    expect(held).toBeGreaterThan(0)
  })

  test("a clean link only jitters", () => {
    const link = new TcpLink(LINKS.good, mulberry32(2))
    for (let t = 0; t < (soak ? 10_000 : 4_000); t += 33) {
      const late = link.deliver(t) - t
      expect(late).toBeLessThanOrEqual(LINKS.good.rttMs / 2 + LINKS.good.jitterMs)
    }
  })

  test("stalls and retransmits hold everything behind them", () => {
    const link = new TcpLink(LINKS.wifi, mulberry32(3))
    let held = 0
    const duration = soak ? 120_000 : 10_000
    for (let t = 0; t < duration; t += 33) if (link.deliver(t) - t > 100) held++
    // About 1% losses (a 200 ms retransmit) and a 150 ms stall every ~10 s, each holding several messages.
    expect(held).toBeGreaterThan(50 * duration / 120_000)
    expect(held).toBeLessThan(600 * duration / 120_000)
  })

  test.each(["loss", "stall"] as const)("the short window exercises %s head-of-line blocking", (cause) => {
    // Isolate each cause: TCP hides loss/reordering by releasing later messages in a burst.
    const profile = { ...LINKS.wifi, loss: cause === "loss" ? LINKS.wifi.loss : 0,
      stallEveryMs: cause === "stall" ? LINKS.wifi.stallEveryMs : 0 }
    const link = new TcpLink(profile, mulberry32(7))
    let previous = -1
    let held = 0
    for (let t = 0; t < 10_000; t += 33) {
      const at = link.deliver(t)
      if (at === previous) held++
      previous = at
    }
    expect(held).toBeGreaterThanOrEqual(2)
  })
})

test("LinkQueue hands over what has arrived, in order", () => {
  const q = new LinkQueue<number>(new TcpLink(LINKS.good, mulberry32(4)))
  for (let i = 0; i < 10; i++) q.send(i * 10, i)
  expect([...q.arrived(5)]).toEqual([])
  const got = [...q.arrived(1_000)]
  expect(got).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(q.size).toBe(0)
})
