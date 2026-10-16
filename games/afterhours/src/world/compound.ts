import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { buildFence } from "./compound/fence"
import { buildBooth } from "./compound/booth"
import { buildLot, stall, WALK_Y } from "./compound/lot"
import { buildVehicles } from "./compound/vehicles"
import { buildProps } from "./compound/props"

// The compound around the building: perimeter fence and gate, guard booth, parking lot with its sodium poles, the
// parked cars and the outdoor clutter. Each part builds independently so one failure leaves the rest standing.

export function build(ctx: WorldContext): WorldModule | void {
  const root = new THREE.Group()
  root.name = "compound"
  ctx.scene.add(root)

  const ticks: (() => void)[] = []
  const parts: [string, () => void][] = [
    ["fence", () => buildFence(ctx, root)],
    ["booth", () => buildBooth(ctx, root)],
    [
      "lot",
      () => {
        const follow = buildLot(ctx, root)
        if (follow) ticks.push(follow)
      },
    ],
    [
      "vehicles",
      () => {
        const coupe = stall(1, 1, 1)
        const truck = stall(0, -1, 1)
        buildVehicles(ctx, root, [
          { kind: "wagon", x: -19.5, z: 90.6, heading: -0.18, paint: 0x3a2318 },
          { kind: "coupe", x: coupe.x - 0.1, z: coupe.z, heading: coupe.heading - 0.02, paint: 0x7e745c },
          { kind: "pickup", x: truck.x, z: truck.z + 0.3, heading: truck.heading, paint: "library" },
        ])
      },
    ],
    ["props", () => buildProps(ctx, root, WALK_Y)],
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
  return {
    update(_dt, _time, camera) {
      for (const t of ticks) t()
      if (Number.isFinite(ev)) ctx.settings["post.exposure"] = ev
      if (pinned) {
        camera.position.set(pinned[0]!, pinned[1]!, pinned[2]!)
        camera.rotation.set(pinned[4]!, pinned[3]!, 0, "YXZ")
      }
    },
  }
}
