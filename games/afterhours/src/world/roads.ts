import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { WORLD_HALF, accessRoadSamples, countyRoadSamples } from "./layout"
import { Line, Parts } from "./roads/util"
import { instanceModel, modelCollider, yawToward, type Placement } from "../render/models"
import { heightAt } from "./height"
import { buildSurface, junctionFor } from "./roads/surface"
import { buildPower } from "./roads/power"
import { buildLights } from "./roads/lights"
import { buildFurniture } from "./roads/furniture"

// The county road across the world, the access road north to the gate, utility poles and wires, sodium
// streetlights and road furniture. All static: a few merged meshes, no per-frame work.

export function build(ctx: WorldContext): WorldModule | void {
  const root = new THREE.Group()
  root.name = "roads"
  root.matrixAutoUpdate = false
  ctx.scene.add(root)

  const access = new Line(accessRoadSamples(1))
  const county = new Line(countyRoadSamples(-WORLD_HALF, WORLD_HALF, 1))
  const junction = junctionFor(access, county)

  buildSurface(root, access, county, junction)
  // Poles, fixtures and furniture share one merge bucket per material.
  const parts = new Parts()
  const power = buildPower(ctx, root, parts, access, junction)
  buildLights(ctx, parts, access, county, junction, power.corner)
  buildFurniture(ctx, parts, access, county, junction, power.accessPoles)
  parts.build(root, "roads", { castShadow: true })

  // Electrical cabinet at the foot of the last pole before the gate (streams in; not needed for the first frame).
  const last = power.accessPoles[power.accessPoles.length - 1]!
  const cab: Placement = { position: [last.x + 0.75, heightAt(last.x + 0.75, last.z), last.z + 0.2], yaw: yawToward(-1, 0) }
  ctx.colliders.push(modelCollider("utility_box_b", cab))
  void instanceModel("utility_box_b", [cab])
    .then((g) => root.add(g))
    .catch(() => {})
}
