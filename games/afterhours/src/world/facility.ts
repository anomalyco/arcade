import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { BUILDING } from "./layout"
import { Batch, flushWorld } from "./facility/geo"
import { buildShell } from "./facility/shell"
import { buildDish } from "./facility/dish"
import { buildRoof } from "./facility/roof"
import { buildDock } from "./facility/dock"
import { buildGrounds } from "./facility/grounds"
import { buildAnnex } from "./facility/annex"
import { windowGlow } from "./facility/windows"
import { buildProps } from "./facility/props"

// The facility exterior (concept r3-01, r5-01, r5-06): the two-storey board-formed concrete block and its annex,
// window rows with a few rooms still lit, the glazed lobby front, the rooftop radio dish, the loading dock and the
// plant and paving around the building. Static geometry is merged into one mesh per material.

const DEFAULTS = {
  "facility.windowGlow": 1,
  "facility.dishTilt": 1.05,
  "facility.dishYaw": -2.75,
  "facility.beaconPeriod": 2.2,
}

export function build(ctx: WorldContext): WorldModule {
  for (const [k, v] of Object.entries(DEFAULTS)) if (ctx.settings[k] === undefined) ctx.settings[k] = v
  ctx.controls.push(
    { key: "facility.windowGlow", label: "Lit window brightness", group: "Facility", min: 0, max: 3, step: 0.05 },
    { key: "facility.dishTilt", label: "Dish tilt from vertical", group: "Facility", unit: "rad", min: 0.2, max: 1.5, step: 0.01 },
    { key: "facility.dishYaw", label: "Dish azimuth (0 = north)", group: "Facility", unit: "rad", min: -Math.PI, max: Math.PI, step: 0.01 },
    { key: "facility.beaconPeriod", label: "Obstruction light blink period", group: "Facility", unit: "s", min: 0.8, max: 5, step: 0.1 },
  )

  const root = new THREE.Group()
  root.name = "facility"
  ctx.scene.add(root)

  const shell = buildShell(ctx, root)

  const b = new Batch(true)
  const dish = buildDish(ctx, root, b)
  buildRoof(ctx, b)
  buildDock(ctx, b, root)
  buildGrounds(ctx, b, root)
  buildAnnex(ctx, b)
  b.flush(root, { name: "facility-details" })
  // Build every world-frame batch together, with near-coplanar faces separated (no z-fighting anywhere).
  flushWorld()
  // Models stream in after the first frame; colliders and contact shadows are already in place.
  void buildProps(ctx, root)

  // Window spill: a dim light just outside a few lit ground-floor windows, enough to pool on the paving.
  const spill = shell.litPanes.filter((p) => p.row === "ground" && (p.facade.startsWith("main-") || p.facade === "annex-south:ground:3"))
  for (const p of spill) {
    const pos = p.center.clone().addScaledVector(p.normal, 0.45)
    ctx.lamps.push({
      kind: "window",
      position: [pos.x, pos.y + 0.5, pos.z],
      direction: [p.normal.x * 0.55, -0.83, p.normal.z * 0.55],
      color: [p.color[0] / 1.4, p.color[1] / 1.4, p.color[2] / 1.4],
      intensity: 18,
      range: 9,
      angle: 1.05,
      penumbra: 0.9,
      size: 1.2,
    })
  }

  const num = (k: keyof typeof DEFAULTS) => {
    const v = Number(ctx.settings[k])
    return Number.isFinite(v) ? v : DEFAULTS[k]
  }
  const controls = { tilt: 0, yaw: 0 }
  // Automation only: `fcam=x,y,z,yaw,pitch` pins the camera for facility review captures.
  const fcam = ctx.params.get("fcam")?.split(",").map(Number)
  // Automation only: `fdoors=open|closed` commands every facility door once after load (captures of door states).
  const fdoors = ctx.params.get("fdoors")
  let doorsDone = !fdoors
  // Automation only: `fdebug=1` with `fcam` drops the fog and adds flat fill light to judge geometry.
  const debugLight = ctx.params.get("fdebug") === "1"
  if (debugLight) ctx.scene.add(new THREE.HemisphereLight(0xc8d4d0, 0x30302c, 2.5))
  return {
    update(_dt, time, camera) {
      // (Shot mode doesn't run the player, which normally steps the doors: step them here for these captures.)
      if (fdoors && ctx.params.has("shot")) ctx.doors.update(_dt)
      if (!doorsDone && time > 1) {
        doorsDone = true
        for (const d of ctx.doors.all()) if (/^(dock|door-|fire|roof|annex|entrance)/.test(d.id)) fdoors === "open" ? d.open() : d.close()
      }
      if (fcam && fcam.length >= 5) {
        camera.position.set(fcam[0]!, fcam[1]!, fcam[2]!)
        camera.rotation.set(fcam[4]!, fcam[3]!, 0, "YXZ")
        if (debugLight) ctx.settings["fog.density"] = 0.0004
      }
      windowGlow.value = num("facility.windowGlow")
      controls.tilt = num("facility.dishTilt")
      controls.yaw = num("facility.dishYaw")
      dish.update(time, controls, Math.max(0.2, num("facility.beaconPeriod")))
    },
  }
}
