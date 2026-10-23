import { expect, spyOn, test } from "bun:test"
import { RoomSocket } from "./room-socket"

/** Simulate page reloads with persistent tab storage and a controllable clock, without sleeping or a browser. */
function browser(run: (env: { connect: (automatic?: boolean, room?: string) => RoomSocket<unknown>; frame: (msg: object) => void; advance: (ms: number) => void; reloads: number[]; fatal: string[]; storage: Map<string, string> }) => void) {
  let now = 100_000, serial = 0
  const timers = new Map<number, { at: number; fn: () => void }>(), sockets: Socket[] = []
  const storage = new Map<string, string>(), reloads: number[] = [], fatal: string[] = []
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    constructor() { sockets.push(this) }
    send() {}
    close() { this.onclose?.() }
  }
  const globals = {
    WebSocket: Socket,
    location: { pathname: "/arcade/barbara/", protocol: "https:", host: "test.invalid", reload: () => reloads.push(now) },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    setTimeout: (fn: () => void, ms: number) => { const id = ++serial; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (id: number) => timers.delete(id),
  }
  const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    run({
      connect: (automatic = true, room = "proof") => new RoomSocket({ game: "test", room, automaticReload: automatic, hello: () => ({}), receive() {}, fatal: (text) => fatal.push(text), encode: JSON.stringify, decode: JSON.parse }),
      frame: (msg) => sockets.at(-1)!.onmessage?.({ data: JSON.stringify(msg) }),
      advance: (ms) => { now += ms; for (const [id, t] of timers) if (t.at <= now) { timers.delete(id); t.fn() } },
      reloads, fatal, storage,
    })
  } finally {
    clock.mockRestore()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test("a stale CDN gets five reloads across page loads with exponential backoff, then a fatal message", () => browser((b) => {
  for (const [i, delay] of [0, 5000, 10_000, 20_000, 40_000].entries()) {
    b.connect(); b.frame({ type: "reload" })
    if (delay) { b.advance(delay - 1); expect(b.reloads).toHaveLength(i); b.advance(1) }
    expect(b.reloads).toHaveLength(i + 1)
    // Duplicate frames must not schedule another timer or consume another attempt.
    b.frame({ type: "reload" })
  }
  b.connect(); b.frame({ type: "reload" }); b.advance(120_000)
  expect(b.reloads).toHaveLength(5)
  expect(b.fatal).toEqual(["A new version is available. Reload the page to continue."])
  expect(b.storage.get("test.rejoin")).toBe("proof")
}))

test("a successful welcome clears reload attempts; another room has an independent allowance", () => browser((b) => {
  b.connect(); b.frame({ type: "reload" })
  b.connect(); b.frame({ type: "welcome", id: "seat", token: "private" })
  expect(b.storage.has("test.reloadAttempts.proof")).toBe(false)
  b.frame({ type: "reload" })
  expect(b.reloads).toHaveLength(2)
  b.connect(true, "other"); b.frame({ type: "reload" })
  expect(b.reloads).toHaveLength(3)
  expect(b.fatal).toHaveLength(0)
}))

test("closing cancels a pending reload; games without the opt-in keep their one-reload guard", () => browser((b) => {
  b.connect(); b.frame({ type: "reload" })
  const pending = b.connect(); b.frame({ type: "reload" }); pending.close(); b.advance(5000)
  expect(b.reloads).toHaveLength(1)
  b.connect(false); b.frame({ type: "reload" })
  expect(b.reloads).toHaveLength(2)
  b.connect(false); b.frame({ type: "reload" })
  expect(b.fatal).toEqual(["A new version is rolling out. Reload the page in a moment."])
}))
