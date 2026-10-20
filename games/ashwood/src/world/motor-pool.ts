import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { buildMotorPool } from "../game/escape/yard"

// The motor-pool shed in the dock court with Truck 2 parked inside (src/game/escape/yard.ts): built with the world so
// it is warmed behind the loading screen; the escape gameplay (src/game/escape) finds it through `motorPool`.

export function build(ctx: WorldContext): WorldModule | void {
  const root = new THREE.Group()
  root.name = "motorPool"
  ctx.scene.add(root)
  const pool = buildMotorPool(ctx, root)
  return { update: (dt) => pool.update(dt) }
}
