import { afterEach, expect, test } from "bun:test"
import { LuminanceMeter } from "./meter"

const mapMode = Object.getOwnPropertyDescriptor(globalThis, "GPUMapMode")
afterEach(() => {
  if (mapMode) Object.defineProperty(globalThis, "GPUMapMode", mapMode)
  else Reflect.deleteProperty(globalThis, "GPUMapMode")
})

/** Only the readback boundary is faked; exercise the real callbacks, reset and public status. */
function readback() {
  Object.defineProperty(globalThis, "GPUMapMode", { configurable: true, value: { READ: 1 } })
  const mapping = Promise.withResolvers<void>()
  const slot = { busy: false, frame: 0, buf: {
    mapAsync: () => mapping.promise,
    getMappedRange: () => new ArrayBuffer(64 * 36 * 8),
    unmap() {},
  } }
  const meter: LuminanceMeter = Object.assign(Object.create(LuminanceMeter.prototype), {
    ring: [slot], pending: 0, frame: 1, generation: 0, failed: false, last: null,
  })
  meter.afterSubmit()
  return { meter, slot, mapping }
}

test("mapAsync rejection marks the current meter failed and frees its slot", async () => {
  const { meter, slot, mapping } = readback()
  expect(meter.status).toBe("pending")
  expect(slot.busy).toBe(true)
  mapping.reject(new Error("readback failed"))
  await Promise.resolve()
  expect(meter.status).toBe("failed")
  expect(meter.last).toBeNull()
  expect(slot.busy).toBe(false)
  meter.reset()
  expect(meter.status).toBe("pending")
})

test("a stale rejection cannot fail the meter after a camera cut", async () => {
  const { meter, slot, mapping } = readback()
  meter.reset()
  mapping.reject(new Error("old readback failed"))
  await Promise.resolve()
  expect(meter.status).toBe("pending")
  expect(slot.busy).toBe(false)
})

test("a successful readback clears failure and publishes a reading", async () => {
  const { meter, mapping } = readback()
  Reflect.set(meter, "failed", true)
  mapping.resolve()
  await Promise.resolve()
  expect(meter.status).toBe("ready")
  expect(meter.last).not.toBeNull()
})
