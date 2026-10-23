// Browser fixture for restart-proof.ts: production session/socket/prediction without a GPU renderer.
import { OnlineSession } from "../src/session"
import { BUILD } from "../shared/build.gen"
import { makeWorld } from "../shared/world"
import type { PlayerInput } from "../shared/sim"

const room = new URLSearchParams(location.search).get("room")!
const session = new OnlineSession(makeWorld(), room, "Restart proof")
const input: PlayerInput = { yaw: 0, pitch: 0, light: true, mx: 0, mz: 0, tie: false, map: false }
const loads = Number(sessionStorage.getItem("proof.loads") ?? 0) + 1
sessionStorage.setItem("proof.loads", String(loads))
let version = 0
setInterval(() => {
  if (version !== session.poseVersion) {
    version = session.poseVersion
    input.yaw = session.self.yaw; input.pitch = session.self.pitch; input.light = session.self.light
  }
  session.tick(input)
  input.jump = false
  session.frame(1 / 30)
}, 1000 / 30)
Object.assign(window, { probe: { session, input, loads, build: BUILD } })
