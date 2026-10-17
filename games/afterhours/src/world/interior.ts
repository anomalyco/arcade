import type * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { BUILDING, ROOF_Y, VIEWPOINTS, type ViewpointName } from "./layout"
import { Builder, STOREY_H } from "./interior/kit"
import { buildCore, buildSlabs } from "./interior/core"
import { buildLift } from "./interior/lift"
import { bakeModels } from "./interior/props"
import { STOREY_MODULES } from "./interior/storeys/index"

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
  // The player's starting storey first (all named viewpoints are on the ground or outside, so normally storey 0).
  const view = VIEWPOINTS[(ctx.params.get("view") ?? "road") as ViewpointName]
  const icamY = Number(ctx.params.get("icam")?.split(",")[1])
  const startY = Number.isFinite(icamY) ? icamY : (view?.pos[1] ?? 0)
  const first = Math.max(0, Math.min(BUILDING.main.storeys - 1, Math.floor((startY - 0.15) / STOREY_H)))

  const groups: THREE.Object3D[] = []
  const builders: Builder[] = []
  const proxies: (THREE.Object3D | null)[] = []
  const updates: ((time: number) => void)[] = []
  const buildOne = async (i: number) => {
    const b = new Builder(ctx, `storey-${i}`, i)
    const h = await STOREY_MODULES[i]!.build(b, { storey: i, pause })
    if (h.update) updates.push(h.update)
    proxies[i] = h.proxy ?? null
    await pause()
    b.flush()
    void bakeModels(b)
    groups[i] = b.group
    builders[i] = b
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
  let propKey = ""
  const NEAR = 18
  return {
    update(dt, time, camera) {
      if (icam && icam.length >= 5) {
        camera.position.set(icam[0]!, icam[1]!, icam[2]!)
        camera.rotation.set((icam[4]! * Math.PI) / 180, (icam[3]! * Math.PI) / 180, 0, "YXZ")
      }
      for (const u of updates) u(time)
      lift.update(dt, time, camera)
      // Inside the block only the player's storey and its neighbours can be seen; outside, every lit window counts.
      const p = camera.position
      const inside = p.x > min[0] && p.x < max[0] && p.z > min[1] && p.z < max[1] + 3.2 && p.y < ROOF_Y
      const s = inside ? Math.max(0, Math.min(groups.length - 1, Math.floor((p.y - 0.15) / STOREY_H))) : -1
      if (s !== shown) {
        shown = s
        groups.forEach((g, i) => (g.visible = s < 0 || Math.abs(i - s) <= 1))
      }
      // Furniture: indoors only the camera's storey; outdoors only storeys level with the camera and within NEAR m
      // of the block (seen through a window at a useful size). Desk-top props: indoors on the camera's storey only.
      // Lit rooms keep a cheap silhouette (proxy) wherever their furniture is hidden.
      const dx = Math.max(min[0] - p.x, 0, p.x - max[0])
      const dz = Math.max(min[1] - p.z, 0, p.z - max[1])
      const dist = Math.hypot(dx, dz)
      const near = !inside && dist < NEAR
      const close = !inside && dist < 8
      let key = ""
      for (let i = 0; i < builders.length; i++) {
        const mid = 0.15 + i * STOREY_H + 1.5
        const on = inside ? i === s : near && Math.abs(mid - p.y) < 9
        key += on ? "1" : "0"
      }
      key += `${s}${close ? 1 : 0}`
      // Outdoors, each instanced stretch of (LOD1) furniture also has to be near the camera itself.
      if (near)
        for (let i = 0; i < builders.length; i++) {
          if (key[i] !== "1") continue
          for (const grp of [builders[i]!.propsLod, builders[i]!.smallLod])
            for (const g of grp.children) {
              const bd = g.userData.bounds as { x0: number; x1: number; z0: number; z1: number } | undefined
              if (!bd) continue
              g.visible = Math.hypot(Math.max(bd.x0 - p.x, 0, p.x - bd.x1), Math.max(bd.z0 - p.z, 0, p.z - bd.z1)) < NEAR
            }
        }
      if (key !== propKey) {
        propKey = key
        builders.forEach((b, i) => {
          const on = key[i] === "1"
          const own = inside && i === s
          // Full models on the camera's own storey; LOD1 copies from outside.
          b.props.visible = own
          b.small.visible = own
          b.propsLod.visible = on && !own
          b.smallLod.visible = on && !own && close
          const px = proxies[i]
          if (px) px.visible = !on
        })
      }
    },
  }
}
