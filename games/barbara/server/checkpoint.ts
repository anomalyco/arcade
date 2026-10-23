import { WoodsRoomCore, type NightCheckpoint } from "./room-core"

/** A damaged or incompatible saved night must not prevent anyone joining this room again. */
export function loadNight(code: string, data: string | undefined, discard: () => void, clock = Date.now): WoodsRoomCore {
  if (data !== undefined) {
    try {
      const night: NightCheckpoint = JSON.parse(data)
      if (night.code !== code) throw new Error("Wrong room checkpoint")
      const core = WoodsRoomCore.restore(night, clock)
      if (core.humans) return core
    } catch {
      // JSON errors can include the saved text (and private seat credentials), so don't log the error itself.
      console.warn("BARBARA discarded an unreadable or incompatible night checkpoint")
    }
    discard()
  }
  return new WoodsRoomCore(code, clock)
}
