import { expect, test } from "bun:test"
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { outbreakClientFeatures as features } from "../src/features"
import { NetSession } from "../src/net-session"
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
