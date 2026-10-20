import { expect, test } from "bun:test"
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { strikesBetween } from "../shared/weather/lightning"
import { DEFAULT_WEATHER_TUNING } from "../shared/weather/schedule"
import { outbreakClientFeatures as features } from "../src/features"
import { NetSession } from "../src/net-session"
import { OutbreakWeatherController } from "../src/weather/controller"
import { DEFAULT_OUTBREAK_WEATHER } from "../src/weather/settings"
import { CrowFlocks } from "../src/details/crows"
import { featureRoom } from "./coop-feature-room"
import { Loopback } from "./loopback"

/** These checks record intentional/current design limits, not claims that these features have state parity. */
test("New town is not supported by co-op: both real clients reject another room seed", () => {
  const core = new CoopRoomCore("other", { ...DEFAULT_COOP_ROOM, seed: 8, houseSeed: 8, zombieCount: 0 }, () => 0, BUILD)
  const loop = new Loopback(core, 1)
  const clients = ["Ann", "Bob"].map((name) => new NetSession({ features, url: "loop", room: "other", name, now: () => loop.now, WebSocket: loop.socketClass() }))
  try {
    for (let i = 0; i < 10; i++) loop.step()
    for (const c of clients) {
      expect(c.connected).toBe(false)
      expect(c.status).toContain("different neighbourhood")
    }
  } finally { for (const c of clients) c.close() }
})

test("one scheduled near lightning strike lands at different positions for separated co-op viewers", () => {
  const r = featureRoom()
  try {
    r.place(r.a, 30, 46)
    r.place(r.b, 330, 46)
    const strike = Array.from({ length: 1200 }, (_, i) => 1400 + i)
      .flatMap((t) => strikesBetween(7, t, t + 1, 22, DEFAULT_WEATHER_TUNING)).find((s) => s.dist < 100)!
    expect(strike).toBeDefined()
    const controllers = r.clients.map(() => new OutbreakWeatherController())
    const frame = (c: NetSession, simTime: number) => ({ dt: 1 / 60, town: c.sim.town, settings: DEFAULT_OUTBREAK_WEATHER,
      viewProj: new Float32Array(16), eye: new Float32Array([30, 22, 55]), playerX: c.local.survivor.x, playerY: c.local.survivor.y,
      playerGroundY: 0, canvasWidth: 800, canvasHeight: 600, zoom: 42, lights: new Float32Array(64 * 16), lightCount: 0, maxLights: 64,
      ambientLum: 0.2, simTime, hour: 22 })
    for (const [i, c] of r.clients.entries()) controllers[i]!.stepAndPrepare(frame(c, strike.t - 0.05))
    r.core.sim.time = strike.t
    r.core.sim.hour = 22
    r.tick(6)
    r.flush()
    for (const [i, c] of r.clients.entries()) {
      controllers[i]!.stepAndPrepare(frame(c, c.snapHistory.get(c.lastServerTick)!.time))
      expect(controllers[i]!.marks).toHaveLength(1)
      expect(controllers[i]!.marks[0]!.seed).toBe(strike.id)
    }
    const [a, b] = controllers.map((c) => c.marks[0]!)
    expect(Math.hypot(a!.x - b!.x, a!.z - b!.z)).toBeGreaterThan(200)
  } finally { r.close() }
})

test("a late joiner has no crow-flight history after a shot's noise expires", () => {
  const r = featureRoom()
  try {
    r.place(r.a, 30, 46)
    r.act(r.a, { fire: true })
    r.tick(6)
    r.flush()
    const active = new CrowFlocks()
    const flock = [{ key: "flock", x: 32, z: 46, birds: 3, seed: 7 }]
    active.setFlocks("parity", flock)
    let activeScatters = 0
    active.onScatter = () => { activeScatters++ }
    active.step(1 / 60, r.a.sim.time, 5.5, [], r.a.sim.ai.noiseBus.events)
    expect(activeScatters).toBe(1)
    r.tick(120)
    const late = r.join()
    r.tick(12)
    r.flush()
    const fresh = new CrowFlocks()
    fresh.setFlocks("parity", flock)
    let lateScatters = 0
    fresh.onScatter = () => { lateScatters++ }
    fresh.step(1 / 60, late.sim.time, 5.5, [], late.sim.ai.noiseBus.events)
    expect(lateScatters).toBe(0)
  } finally { r.close() }
})
