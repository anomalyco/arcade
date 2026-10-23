import { describe, expect, test } from "bun:test"
import { Mixer } from "../src/audio/mixer"
import { RADIO, Radio, type RadioLine } from "../src/audio/radio"
import { RadioDirector, type RadioWorld } from "../src/audio/radio-director"
import { SfxBank } from "../src/audio/sfx-bank"

const radio = () => {
  const m = new Mixer(false)
  return new Radio(m, new SfxBank(m), false)
}
const run = (r: Radio, s: number) => {
  for (let t = 0; t < s; t += 0.05) r.update(0.05)
}

describe("radio chatter", () => {
  test("one line at a time: urgent lines cut in, lesser ones wait, cooldowns drop repeats", () => {
    const r = radio()
    expect(r.say("zone-captured")).toBe(true)
    expect(r.current).toBe("zone-captured")
    // A missile cuts a routine call off at once.
    expect(r.say("break-left")).toBe(true)
    expect(r.current).toBe("break-left")
    // A kill call waits for the air, then is said.
    expect(r.say("splash")).toBe(true)
    expect(r.current).toBe("break-left")
    run(r, 4)
    expect(r.said.map((s) => s.line)).toEqual(["zone-captured", "break-left", "splash"])
    // Within its cooldown a line is dropped.
    run(r, 2)
    expect(r.say("break-left")).toBe(true)
    run(r, 3)
    expect(r.say("break-left")).toBe(false)
  })

  test("a waiting line that went stale is never said", () => {
    const r = radio()
    r.say("break-right")
    r.say("mother")
    run(r, 0.2)
    r.say("spike")
    run(r, 6)
    // The spike outranked the waiting carrier call; the carrier call was dropped.
    expect(r.said.map((s) => s.line)).toEqual(["break-right", "spike"])
  })

  test("off means silent", () => {
    const r = radio()
    RADIO.enabled = false
    expect(r.say("spike")).toBe(false)
    RADIO.enabled = true
  })
})

describe("radio director", () => {
  const world = (o: Partial<RadioWorld> = {}): RadioWorld => ({
    playing: true,
    phase: "deck",
    warn: 0,
    hp: 100,
    own: { x: 0, y: 100, z: 0 },
    right: [1, 0, 0],
    missiles: [],
    me: 1,
    shipHp: 1,
    zones: [],
    team: 0,
    ...o,
  })
  const said = (d: RadioDirector): RadioLine[] => d.radio.said.map((s) => s.line)

  test("own moments become lines; the first frame only primes", () => {
    const d = new RadioDirector(radio())
    d.update(0.05, world({ warn: 1, shipHp: 0.5 }))
    expect(said(d)).toEqual([])
    d.update(0.05, world({ phase: "launching" }))
    expect(said(d)).toEqual(["launch"])
    const missile = { phase: "flying", warn: 2 as const, missiles: [{ alive: true, kind: "missile", target: 1, x: -300, y: 100, z: 0 }] }
    d.update(5, world(missile))
    // Said once the quiet after the last line has passed.
    d.update(1, world(missile))
    expect(said(d).at(-1)).toBe("break-left")
    d.update(5, world({ phase: "flying" }))
    d.kill()
    d.update(1, world({ phase: "flying" }))
    expect(said(d).at(-1)).toBe("splash")
    d.update(5, world({ phase: "flying", shipHp: 0.9 }))
    d.update(1, world({ phase: "flying", shipHp: 0.9 }))
    expect(said(d).at(-1)).toBe("mother")
  })
})
