import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Input } from "../src/game/input"
import { DT, GUNS } from "../shared/config"
import { decodeClient, encodeClient } from "../shared/protocol"
import { NO_INTENT, type Intent } from "../shared/sim/world"
import { world } from "./helpers"

let input: Input
let canvas: EventTarget
let win: EventTarget
let now = 0
let clock: ReturnType<typeof spyOn>
const previous = new Map<string, PropertyDescriptor | undefined>()

beforeEach(() => {
  now = 0
  clock = spyOn(performance, "now").mockImplementation(() => now)
  win = new EventTarget()
  canvas = Object.assign(new EventTarget(), { focus() {} })
  const globals = { window: win, parent: win, innerWidth: 800, innerHeight: 600,
    location: { search: "", origin: "http://localhost" }, document: { referrer: "" },
    addEventListener: win.addEventListener.bind(win) }
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  input = new Input(canvas as HTMLElement)
  input.enabled = true
})

afterEach(() => {
  clock.mockRestore()
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  previous.clear()
})

function mouse(type: "mousedown" | "mouseup", button = 0, detail = 1) {
  const e = Object.assign(new Event(type, { cancelable: true }), { button, detail, clientX: 500, clientY: 300 })
  ;(type === "mousedown" ? canvas : win).dispatchEvent(e)
}
function tap(detail = 1) { mouse("mousedown", 0, detail); mouse("mouseup", 0, detail) }
function tick(): Intent {
  const firePressed = input.takeFirePress()
  return { ...NO_INTENT, fire: input.enabled && (input.firing || firePressed), ...(firePressed ? { firePressed: true } : {}) }
}
function sniper() {
  const w = world(["a"])
  w.pickGun("a", "sniper")
  const p = w.players.get("a")!
  w.spawn(p)
  p.cooldownUntil = 0
  let seq = 0
  const send = (i = tick()) => {
    // Exercise the actual network sanitizer, then the server's one-input-per-tick queue.
    const message = decodeClient(encodeClient({ type: "intent", seq: ++seq, i }))!
    if (message.type !== "intent") throw new Error("invalid intent")
    w.push("a", message.seq, message.i)
    w.step()
    now += DT * 1000
  }
  return { w, p, send }
}

test("a complete tap between ticks reaches the server exactly once", () => {
  const { p, send } = sniper()
  tap()
  expect(input.firing).toBe(false) // The old level-only sample loses this tap.
  send()
  expect(p.mag).toBe(GUNS.sniper.mag - 1)
  send()
  expect(p.mag).toBe(GUNS.sniper.mag - 1)
})

test("consecutive tick taps retain edges, including a ready tap immediately after a rejected cooldown tap", () => {
  const { w, p, send } = sniper()
  tap(); send()
  while (w.time + DT < p.cooldownUntil) send()
  // Put one rejected tap just before readiness, and one accepted tap in the very next tick: no false tick between.
  p.cooldownUntil = w.time + DT * 1.5
  tap(); send()
  expect(p.mag).toBe(GUNS.sniper.mag - 1)
  tap(2); send()
  expect(p.mag).toBe(GUNS.sniper.mag - 2)
})

test("a sniper hold fires once; a rifle hold remains automatic", () => {
  for (const gun of ["sniper", "rifle"] as const) {
    input.release()
    const { w, p, send } = sniper()
    w.pickGun("a", gun); w.spawn(p); p.cooldownUntil = 0
    mouse("mousedown")
    for (let n = 0; n < 50; n++) send()
    expect(GUNS[gun].mag - p.mag).toBe(gun === "sniper" ? 1 : 17)
    mouse("mouseup")
    expect(tick().fire).toBe(false)
  }
})

test("multiple taps within one tick coalesce, never queue behind cooldown or reload", () => {
  const { w, p, send } = sniper()
  tap(); tap(2); send()
  expect(p.mag).toBe(GUNS.sniper.mag - 1)
  tap(); send()
  for (let n = 0; n < 50; n++) send()
  expect(p.mag).toBe(GUNS.sniper.mag - 1)
  p.reloadUntil = w.time + 0.2
  tap(); send()
  for (let n = 0; n < 50; n++) send()
  expect(p.mag).toBe(GUNS.sniper.mag)
})

test("disabled gameplay rejects presses and clears a pending tap on disable", () => {
  input.enabled = false
  tap()
  input.enabled = true
  expect(tick().fire).toBe(false)
  tap()
  input.enabled = false
  input.enabled = true
  expect(tick().fire).toBe(false)
})

test("pressing and holding during cooldown or reload never schedules a later sniper shot", () => {
  for (const gate of ["cooldownUntil", "reloadUntil"] as const) {
    input.release()
    const { w, p, send } = sniper()
    p[gate] = w.time + 0.2
    mouse("mousedown")
    for (let n = 0; n < 60; n++) send()
    expect(p.mag).toBe(GUNS.sniper.mag)
    mouse("mouseup")
    tap(); send()
    expect(p.mag).toBe(GUNS.sniper.mag - 1)
  }
})

test("press and release packets arriving together retain the tap in the server tick queue", () => {
  const { w, p } = sniper()
  tap()
  const pressed = tick()
  const released = tick()
  for (const [index, i] of [pressed, released].entries()) {
    const message = decodeClient(encodeClient({ type: "intent", seq: index + 1, i }))!
    if (message.type === "intent") w.push("a", message.seq, message.i)
  }
  expect(p.mag).toBe(GUNS.sniper.mag)
  w.step()
  expect(p.mag).toBe(GUNS.sniper.mag - 1)
  w.step()
  expect(p.mag).toBe(GUNS.sniper.mag - 1)
  expect(p.triggerHeld).toBe(false)
})

test("lab release and blur clear both held trigger and unconsumed edge", () => {
  mouse("mousedown")
  input.release() // LabPanel's onCapture callback.
  expect(tick().fire).toBe(false)
  tap()
  win.dispatchEvent(new Event("blur"))
  expect(tick().fire).toBe(false)
  mouse("mousedown")
  win.dispatchEvent(new Event("blur"))
  expect(input.firing).toBe(false)
})

test("an unsampled released tap expires after 100 ms, without affecting a held trigger", () => {
  tap()
  now = 101
  expect(tick().fire).toBe(false)
  mouse("mousedown")
  now += 101
  expect(tick()).toEqual({ ...NO_INTENT, fire: true })
})

test("right click does not fire and browser double-click detail does not suppress a press", () => {
  mouse("mousedown", 2); mouse("mouseup", 2)
  expect(tick().fire).toBe(false)
  tap(1)
  expect(tick().firePressed).toBe(true)
  tap(2)
  expect(tick().firePressed).toBe(true)
})

test("the protocol only accepts boolean press edges", () => {
  for (const value of ["true", 1, {}, null, false]) {
    const msg = decodeClient(JSON.stringify({ type: "intent", seq: 1, i: { ...NO_INTENT, firePressed: value } }))
    expect(msg?.type === "intent" && msg.i.firePressed === true).toBe(false)
  }
})
