import { expect, test } from "bun:test"
import { FrameClock, TICK_DT } from "../shared/clock"
import type { Command } from "../shared/session"
import { OutbreakInputController, type OutbreakInputHost } from "../src/input/controller"
import { createOutbreakSettings } from "../src/settings"

for (const reason of ["release", "blur", "hidden", "meta"]) test(`${reason} cancels pending Outbreak actions and tap/hold drops`, () => {
  const win = new EventTarget()
  const doc = Object.assign(new EventTarget(), { referrer: "", hidden: false })
  const globals = { window: win, parent: win, document: doc, innerWidth: 1000, innerHeight: 800,
    location: { search: "", origin: "http://localhost" } }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  try {
    const commands: Command[] = []
    const session = { view: { player: { x: 0, y: 0 }, inventory: { selectedSlot: 0 } }, update: (_dt: number, command: Command) => commands.push(command) }
    const controller = new OutbreakInputController({
      canvas: Object.assign(new EventTarget(), { focus() {} }),
      session: () => session,
      cam: { unproject: () => ({ x: 1, y: 0 }) }, settings: createOutbreakSettings(),
      inventoryHud: { digit: () => ({ hotbarSlot: 2 }) }, map: { key() {} }, incrementFrames() {},
    } as unknown as OutbreakInputHost)
    const key = (code: string, type = "keydown") => win.dispatchEvent(Object.assign(new Event(type), { code, key: "", metaKey: false }))
    for (const code of ["KeyG", "KeyQ", "KeyB", "Digit3", "KeyW"]) key(code)
    if (reason === "release") controller.release()
    if (reason === "blur") win.dispatchEvent(new Event("blur"))
    if (reason === "hidden") { doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange")) }
    if (reason === "meta") key("MetaLeft", "keyup")
    const clock = new FrameClock()
    clock.reset(0, controller.liveMove())
    controller.stepSubsteps(TICK_DT * 1000 + 1, clock)
    expect(commands).toHaveLength(1)
    expect(commands[0]!.drop).not.toBe(true)
    expect(commands[0]!.bundle).not.toBe(true)
    expect(commands[0]!.ping).not.toBe(true)
    expect(commands[0]!.barricade).toBe(false)
    expect(commands[0]!.hotbarSlot).toBeUndefined()
    expect(commands[0]!.mx).toBe(0)
    expect(commands[0]!.my).toBe(0)
    // A deliberate tap still drops exactly once after returning.
    key("KeyG"); key("KeyG", "keyup")
    controller.stepSubsteps(TICK_DT * 2000 + 1, clock)
    expect(commands[1]!.drop).toBe(true)
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
