import type * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { BUILDING, ROOF_Y, VIEWPOINTS, type ViewpointName } from "./layout"
import { Builder, STOREY_H } from "./interior/kit"
import { buildCore, buildSlabs } from "./interior/core"
import { buildCorridor } from "./interior/corridor"
import { buildLift } from "./interior/lift"
import { buildLobby } from "./interior/lobby"
import { placeProps } from "./interior/props"
import { buildCloset, buildLab } from "./interior/rooms"
import { buildStorey, groundWindows } from "./interior/storeys"
import { resetFurnish } from "./interior/furnish"

// Everything inside the main block's shell: the ground floor (lobby, link, corridor, lab, closet), storeys 1–4, the
// slabs between them, the stair core from the ground to the roof and the lift. Each storey is its own group so only
// the storeys near the player draw while they're inside; the core is always drawn (the stairwell sees them all).

/** Yields to the browser between chunks so the build never blocks a frame for long. */
const pause = () =>
  new Promise<void>((r) => {
    const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
    if (s?.yield) s.yield().then(r)
    else setTimeout(r)
  })

export async function build(ctx: WorldContext): Promise<WorldModule> {
  resetFurnish()
  // The player's starting storey first (all named viewpoints are on the ground or outside, so normally storey 0).
  const view = VIEWPOINTS[(ctx.params.get("view") ?? "road") as ViewpointName]
  const icamY = Number(ctx.params.get("icam")?.split(",")[1])
  const startY = Number.isFinite(icamY) ? icamY : (view?.pos[1] ?? 0)
  const first = Math.max(0, Math.min(BUILDING.main.storeys - 1, Math.floor((startY - 0.15) / STOREY_H)))

  const groups: THREE.Object3D[] = []
  const upper: { update(time: number): void }[] = []
  let corridor: { update(time: number): void } | null = null
  const buildOne = async (i: number) => {
    const b = new Builder(ctx, `storey-${i}`, i)
    if (i === 0) {
      buildLobby(b)
      await pause()
      corridor = buildCorridor(b)
      await pause()
      buildLab(b)
      await pause()
      buildCloset(b)
      groundWindows(b)
      placeProps(b)
    } else upper.push(await buildStorey(b, i, pause))
    await pause()
    b.flush()
    groups[i] = b.group
    await pause()
  }
  await buildOne(first)
  const core = new Builder(ctx, "core")
  buildSlabs(core)
  await buildCore(core, pause)
  core.flush()
  await pause()
  const lift = buildLift(ctx, ctx.scene)
  for (let i = 0; i < BUILDING.main.storeys; i++) if (i !== first) await buildOne(i)

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
      corridor?.update(time)
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
