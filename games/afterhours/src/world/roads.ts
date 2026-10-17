import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { WORLD_HALF, accessRoadSamples, countyRoadSamples } from "./layout"
import { Line, Parts } from "./roads/util"
import { Wires } from "./roads/wires"
import { loadModel, modelCollider, yawToward, type Placement } from "../render/models"
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
  const wires = new Wires()
  const power = buildPower(ctx, parts, wires, access, junction)
  buildLights(ctx, parts, wires, access, county, junction, power.corner, power.countyPoles)
  buildFurniture(ctx, parts, access, county, junction, power.accessPoles)
  parts.build(root, "roads", { castShadow: true })
  const updateWires = wires.build(root, ctx.renderer)

  // Electrical cabinet at the foot of the last pole before the gate (streams in; not needed for the first frame).
  const last = power.accessPoles[power.accessPoles.length - 1]!
  const cab: Placement = { position: [last.x + 0.75, heightAt(last.x + 0.75, last.z), last.z + 0.2], yaw: yawToward(-1, 0) }
  ctx.colliders.push(modelCollider("utility_box_b", cab))
  // A single plain-mesh clone: an InstancedMesh of one would cost its own shader for nothing.
  void loadModel("utility_box_b")
    .then((g) => {
      g.position.set(...cab.position)
      g.rotation.y = cab.yaw ?? 0
      g.traverse((o) => {
        o.castShadow = false
        o.receiveShadow = true
      })
      g.updateMatrixWorld(true)
      g.traverse((o) => (o.matrixAutoUpdate = false))
      root.add(g)
    })
    .catch(() => {})

  return { update: (_dt, _t, camera) => updateWires(camera) }
}
