import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { buildFence } from "./compound/fence"
import { buildGate } from "./compound/gate"
import { buildNorth } from "./compound/north"
import { buildBooth } from "./compound/booth"
import { buildLot, WALK_Y } from "./compound/lot"
import { buildProps } from "./compound/props"
import { buildModels } from "./compound/models"

// The compound around the building: perimeter fence and gate, guard booth, parking lot with its sodium poles, the
// parked cars and outdoor props (real models, streamed in after the first frame) and procedural clutter. Each part builds independently so one failure leaves the rest standing.

export function build(ctx: WorldContext): WorldModule | void {
  const root = new THREE.Group()
  root.name = "compound"
  ctx.scene.add(root)

  const ticks: ((dt: number) => void)[] = []
  const parts: [string, () => void][] = [
    ["fence", () => buildFence(ctx, root)],
    ["gate", () => void ticks.push(buildGate(ctx, root))],
    ["north", () => buildNorth(ctx, root)],
    ["booth", () => buildBooth(ctx, root)],
    [
      "lot",
      () => {
        const follow = buildLot(ctx, root)
        if (follow) ticks.push(follow)
      },
    ],
    ["props", () => buildProps(ctx, root, WALK_Y)],
    ["models", () => buildModels(ctx, root)],
  ]
  for (const [name, run] of parts) {
    try {
      run()
    } catch (e) {
      console.error(`compound/${name}: ${e instanceof Error ? (e.stack ?? e.message) : e}`)
    }
  }
  root.updateMatrixWorld(true)

  // Automation only: `ccam=x,y,z,yaw,pitch` pins the camera for close-up captures of compound details.
  // `cev=<EV>` overrides the camera exposure so dark details can be inspected in captures.
  const ev = ctx.params.has("cev") ? Number(ctx.params.get("cev")) : NaN
  const pin = ctx.params.get("ccam")?.split(",").map(Number)
  const pinned = pin && pin.length >= 5 && pin.every(Number.isFinite) ? pin : null
  // `copen=booth,ctl-gate,ctl-boom` opens those doors / presses those controls once the world is up (captures of the
  // open states); `cdoor=1` is short for `copen=booth`.
  const openIds = [...(ctx.params.get("copen")?.split(",").filter(Boolean) ?? []), ...(ctx.params.get("cdoor") === "1" ? ["booth"] : [])]
  return {
    update(_dt, _time, camera) {
      for (const t of ticks) t(_dt)
      if (openIds.length) {
        // Shot mode doesn't step the player, which normally drives the door system; step it here instead.
        for (const id of openIds) {
          const d = ctx.doors.get(id)
          if (d && !d.isOpen) d.open()
        }
        ctx.doors.update(_dt)
      }
      if (Number.isFinite(ev)) ctx.settings["post.exposure"] = ev
      if (pinned) {
        camera.position.set(pinned[0]!, pinned[1]!, pinned[2]!)
        camera.rotation.set(pinned[4]!, pinned[3]!, 0, "YXZ")
      }
    },
  }
}
