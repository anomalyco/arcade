import type * as THREE from "three/webgpu"
import { Group } from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { BUILDING, ROOF_Y, VIEWPOINTS, type ViewpointName } from "./layout"
import { Builder, STOREY_H, releaseDepthRegistry, solidsOf } from "./interior/kit"
import { interiorDoors as _doors, interiorRooms as _rooms } from "./interior/registry"
const interiorRooms = _rooms
const interiorDoors = _doors
import { buildCore, buildSlabs } from "./interior/core"
import { buildLift } from "./interior/lift"
import { bakeModels } from "./interior/props"
import { STOREY_MODULES } from "./interior/storeys/index"
import { buildWindowProxies } from "./interior/windowproxy"
import { checkNightState } from "./interior/lighting-state"
import * as kitDemo from "./interior/storeys/kitdemo"

export { interiorRooms, interiorDoors } from "./interior/registry"

// Everything inside the main block's shell: the ground floor (lobby, link, corridor, lab, closet), storeys 1–4, the
// slabs between them, the stair core from the ground to the roof and the lift. Each storey is its own group so only
// the storeys near the player draw while they're inside; the core is always drawn (the stairwell sees them all).

/** Build profile (automation): busy ms per phase between yields, in `__interiorProfile`. */
const prof: Record<string, number> = ((globalThis as { __interiorProfile?: Record<string, number> }).__interiorProfile = {})
let profLabel = "start"
let profT = performance.now()
const phase = (label: string) => {
  const t = performance.now()
  prof[profLabel] = (prof[profLabel] ?? 0) + t - profT
  profLabel = label
  profT = t
}
/** Yields to the browser between chunks so the build never blocks a frame for long. */
const pause = () => {
  const t = performance.now()
  prof[profLabel] = (prof[profLabel] ?? 0) + t - profT
  return pauseRaw().then(() => {
    profT = performance.now()
  })
}
const pauseRaw = () =>
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
    // Automation only: `kitdemo=<storey>` replaces that storey with the kit's reference layout (API check).
    const mod = Number(ctx.params.get("kitdemo") ?? -1) === i ? kitDemo : STOREY_MODULES[i]!
    phase(`s${i}:gen`)
    const h = await mod.build(b, { storey: i, pause })
    if (h.update) updates.push(h.update)
    proxies[i] = h.proxy ?? null
    await pause()
    phase(`s${i}:flush`)
    await b.flushAsync(ctx.scene, pause)
    phase(`s${i}:after`)
    void bakeModels(b)
    groups[i] = b.group
    builders[i] = b
    await pause()
  }
  // Core and lift first: storey walls resolve their joints against the core's colliders when they flush.
  phase("core")
  const core = new Builder(ctx, "core")
  buildSlabs(core)
  await buildCore(core, pause)
  await core.flushAsync(ctx.scene, pause)
  const coreGroup = core.group
  await pause()
  // Core and lift share one group so they can be hidden from far outside with the storeys.
  const coreLift = new Group()
  coreLift.name = "interior:core-lift"
  ctx.scene.add(coreLift)
  phase("lift")
  const lift = buildLift(ctx, coreLift)
  await buildOne(first)
  for (let i = 0; i < BUILDING.main.storeys; i++) if (i !== first) await buildOne(i)
  releaseDepthRegistry(ctx)
  // Lit-window cards shown from outside instead of the storeys (after every storey registered its lamps).
  phase("proxies")
  const windowProxies = await buildWindowProxies(ctx, BUILDING.main.storeys, pause)
  phase("tail")
  for (const [k, v] of Object.entries((globalThis as { __interiorDepthPhase?: Record<string, number> }).__interiorDepthPhase ?? {})) prof[`depth:${k}`] = v
  // The 3 a.m. lighting state is the one truth for lamps and windows: report drift (a listed source with no lamp).
  for (const m of checkNightState(ctx.lamps)) console.warn(`interior lighting state: ${m}`)

  const { min, max } = BUILDING.main
  // Automation only: `icam=x,y,z,yawDeg,pitchDeg` pins the camera for captures of rooms with no named viewpoint.
  const icam = ctx.params.get("icam")?.split(",").map(Number)
  ;(globalThis as { __interior?: unknown }).__interior = { lift, ctx, solids: solidsOf(ctx), rooms: interiorRooms, doors: interiorDoors }
  let shown = -2
  let shownKey = ""
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
      // Outside, a storey (walls, doors, washrooms) draws only while the camera is near and level with it; otherwise
      // its windows show lit/dark proxy cards.
      const dxs = Math.max(min[0] - p.x, 0, p.x - max[0])
      const dzs = Math.max(min[1] - p.z, 0, p.z - max[1])
      const outNear = !inside && Math.hypot(dxs, dzs) < NEAR
      let vis = `${s}`
      for (let i = 0; i < groups.length; i++) vis += inside ? (Math.abs(i - s) <= 1 ? "1" : "0") : outNear && Math.abs(0.15 + i * STOREY_H + 1.5 - p.y) < 9 ? "1" : "0"
      if (vis !== shownKey) {
        shownKey = vis
        shown = s
        coreGroup.visible = coreLift.visible = inside || outNear
        groups.forEach((g, i) => {
          g.visible = vis[i + `${s}`.length] === "1"
          const w = windowProxies[i]
          if (w) w.visible = !inside && !g.visible
        })
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
