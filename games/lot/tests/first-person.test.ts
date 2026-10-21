import { expect, test } from "bun:test"
import { FirstPerson } from "@arcade/kit/client/first-person"

test("physical keys respect pointer/panel ownership, collide, and release on blur", () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const win = new EventTarget()
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: null as EventTarget | null,
    hidden: false,
    exitPointerLock() { doc.pointerLockElement = null; doc.dispatchEvent(new Event("pointerlockchange")) },
  })
  const canvas = Object.assign(new EventTarget(), {
    requestPointerLock() { doc.pointerLockElement = canvas; doc.dispatchEvent(new Event("pointerlockchange")) },
  })
  Object.defineProperty(globalThis, "window", { configurable: true, value: win })
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc })
  let panel = false
  // DOM boundary only: the test provides the EventTarget and pointer-lock API used by the controller.
  const camera = new FirstPerson(canvas as unknown as HTMLCanvasElement, () => panel)
  const key = (type: string, code: string, key: string, extra = {}) => win.dispatchEvent(Object.assign(new Event(type), { code, key, ...extra }))
  const step = () => camera.update(1 / 60, 1.5, [[-5, -2, 5, -1]])
  try {
    key("keydown", "KeyW", ",") // Dvorak: same physical key.
    for (let i = 0; i < 30; i++) step()
    expect(camera.body.y).toBe(0) // No capture, no gameplay input.
    canvas.dispatchEvent(new Event("click"))
    key("keydown", "KeyW", ",")
    for (let i = 0; i < 120; i++) step()
    expect(camera.body.y).toBeLessThan(-0.5)
    expect(camera.body.y).toBeGreaterThanOrEqual(-0.721) // radius stops at the wall
    expect(camera.eye[2]).toBe(camera.body.y)
    key("keydown", "KeyF", "u")
    expect(camera.flashlight).toBe(true)
    key("keydown", "KeyF", "u", { repeat: true })
    expect(camera.flashlight).toBe(true)
    panel = true; step()
    expect(doc.pointerLockElement).toBeNull()
    key("keydown", "KeyF", "u")
    expect(camera.flashlight).toBe(true)
    panel = false; canvas.dispatchEvent(new Event("click"))
    key("keydown", "KeyD", "e")
    step()
    expect(camera.body.x).toBeGreaterThan(0)
    win.dispatchEvent(new Event("blur"))
    const x = camera.body.x
    for (let i = 0; i < 30; i++) step()
    expect(camera.body.x).toBe(x)
  } finally {
    camera.dispose()
    for (const [name, value] of [["window", priorWindow], ["document", priorDocument]] as const) {
      if (value) Object.defineProperty(globalThis, name, value)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
