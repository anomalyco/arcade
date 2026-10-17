import type * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { BUILDING, ROOF_Y } from "./layout"
import { Builder, STOREY_H } from "./interior/kit"
import { buildCore, buildSlabs } from "./interior/core"
import { buildCorridor } from "./interior/corridor"
import { buildLift } from "./interior/lift"
import { buildLobby } from "./interior/lobby"
import { placeProps } from "./interior/props"
import { buildCloset, buildLab } from "./interior/rooms"
import { buildStorey } from "./interior/storeys"
import { resetFurnish } from "./interior/furnish"

// Everything inside the main block's shell: the ground floor (lobby, link, corridor, lab, closet), storeys 1–4, the
// slabs between them, the stair core from the ground to the roof and the lift. Each storey is its own group so only
// the storeys near the player draw while they're inside; the core is always drawn (the stairwell sees them all).

export function build(ctx: WorldContext): WorldModule {
  resetFurnish()
  const core = new Builder(ctx, "core")
  buildSlabs(core)
  buildCore(core)
  core.flush()

  const ground = new Builder(ctx, "storey-0", 0)
  buildLobby(ground)
  const corridor = buildCorridor(ground)
  buildLab(ground)
  buildCloset(ground)
  placeProps(ground)
  ground.flush()

  const groups: THREE.Object3D[] = [ground.group]
  const upper: { update(time: number): void }[] = []
  for (let i = 1; i < BUILDING.main.storeys; i++) {
    const b = new Builder(ctx, `storey-${i}`, i)
    upper.push(buildStorey(b, i))
    b.flush()
    groups.push(b.group)
  }
  const lift = buildLift(ctx, ctx.scene)

  const { min, max } = BUILDING.main
  // Automation only: `icam=x,y,z,yawDeg,pitchDeg` pins the camera for captures of rooms with no named viewpoint.
  const icam = ctx.params.get("icam")?.split(",").map(Number)
  ;(globalThis as { __interior?: unknown }).__interior = { lift, ctx }
  let shown = -2
  return {
    update(dt, time, camera) {
      if (icam && icam.length >= 5) {
        camera.position.set(icam[0]!, icam[1]!, icam[2]!)
        camera.rotation.set((icam[4]! * Math.PI) / 180, (icam[3]! * Math.PI) / 180, 0, "YXZ")
      }
      corridor.update(time)
      for (const u of upper) u.update(time)
      lift.update(dt, time, camera)
      // Inside the block only the player's storey and its neighbours can be seen; outside, every lit window counts.
      const p = camera.position
      const inside = p.x > min[0] && p.x < max[0] && p.z > min[1] && p.z < max[1] + 3.2 && p.y < ROOF_Y
      const s = inside ? Math.max(0, Math.min(groups.length - 1, Math.floor((p.y - 0.15) / STOREY_H))) : -1
      if (s !== shown) {
        shown = s
        groups.forEach((g, i) => (g.visible = s < 0 || Math.abs(i - s) <= 1))
      }
    },
  }
}
