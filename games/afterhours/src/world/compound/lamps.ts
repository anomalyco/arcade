import * as THREE from "three/webgpu"
import type { Lamp, WorldContext } from "../context"
import { heightAt } from "../height"
import { material } from "../../render/materials"
import { Batch, box, cyl, matrix, sphere, tube } from "./geo"
import { renderState } from "../../render/shared"

// Sodium lamp poles: a tapered steel pole with either a curved davit arm and cobra head (by the booth, as in the
// concept) or a straight arm and shoebox head (parking lot). The visible lens is emissive; the light itself is
// registered in ctx.lamps for render/lighting.ts.

export type PoleState = "on" | "dead" | "flicker"

export type PoleSpec = {
  x: number
  z: number
  /** Lens height above the ground. */
  height: number
  /** Arm direction in the XZ plane (radians, 0 = +X). */
  heading: number
  arm: number
  style: "cobra" | "shoebox"
  state: PoleState
  shadow?: boolean
  intensity?: number
  range?: number
  /** Concrete footing height (parking lots raise poles on a pier). */
  footing?: number
}

export const SODIUM: readonly [number, number, number] = [1, 0.55, 0.18]

export function sodiumPole(ctx: WorldContext, batch: Batch, spec: PoleSpec) {
  const steel = material("metal_dark")
  const dark = material("metal_dark")
  let lens = spec.state === "dead" ? material("glass_dark") : material("emissive_sodium")
  // A failing lamp gets its own lens material so its glow can follow the light rig's flicker.
  if (spec.state === "flicker") lens = lens.clone()
  const y0 = heightAt(spec.x, spec.z)
  const b = batch.child(matrix(spec.x, y0, spec.z, -spec.heading))
  const foot = spec.footing ?? 0
  const h = spec.height
  if (foot > 0) {
    b.at(material("concrete_wall"), cyl(0.28, 0.3, foot + 0.1, 20), 0, (foot - 0.1) / 2, 0)
    b.at(dark, box(0.34, 0.03, 0.34), 0, foot + 0.015, 0)
  } else {
    b.at(material("concrete_dark"), cyl(0.3, 0.34, 0.16, 20), 0, 0.02, 0)
  }
  const bend = spec.style === "cobra" ? 1.1 : 0
  const shaftTop = h + 0.12 - bend
  b.at(steel, cyl(0.075, 0.115, shaftTop - foot, 20, true), 0, foot + (shaftTop - foot) / 2, 0)
  // Base plate and access hatch.
  b.at(steel, cyl(0.15, 0.15, 0.05, 8), 0, foot + 0.025, 0)
  b.at(dark, box(0.012, 0.22, 0.09), -0.11, foot + 0.6, 0)
  const headX = spec.arm
  if (spec.style === "cobra") {
    const curve = new THREE.CurvePath<THREE.Vector3>()
    curve.add(new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, shaftTop, 0), new THREE.Vector3(0, h + 0.15, 0), new THREE.Vector3(bend, h + 0.12, 0)))
    curve.add(new THREE.LineCurve3(new THREE.Vector3(bend, h + 0.12, 0), new THREE.Vector3(headX - 0.25, h + 0.08, 0)))
    b.add(steel, tube(curve, 0.055, 32, 14))
    // Cobra head: long tapering housing with a sag lens underneath.
    const housing = sphere(1, 12, 8)
    housing.scale(0.42, 0.1, 0.19)
    b.at(steel, housing, headX, h + 0.08, 0, 0, 0, -0.06)
    const bowl = sphere(1, 12, 4, Math.PI / 2, Math.PI / 2)
    bowl.scale(0.3, 0.075, 0.14)
    b.at(lens, bowl, headX + 0.06, h + 0.05, 0, 0, 0, -0.06)
  } else {
    b.at(steel, box(headX, 0.08, 0.08), headX / 2, h + 0.22, 0)
    b.at(dark, box(0.68, 0.17, 0.44), headX + 0.2, h + 0.18, 0)
    b.at(dark, box(0.7, 0.03, 0.46), headX + 0.2, h + 0.28, 0)
    b.at(lens, box(0.56, 0.02, 0.34), headX + 0.2, h + 0.09, 0)
  }
  const lx = spec.x + Math.cos(spec.heading) * (headX + (spec.style === "cobra" ? 0.06 : 0.2))
  const lz = spec.z + Math.sin(spec.heading) * (headX + (spec.style === "cobra" ? 0.06 : 0.2))
  const r = foot > 0 ? 0.3 : 0.12
  ctx.colliders.push({ min: [spec.x - r, y0, spec.z - r], max: [spec.x + r, y0 + h, spec.z + r] })
  if (spec.state !== "dead") {
    const lamp: Lamp = {
      kind: "sodium",
      position: [lx, y0 + h, lz],
      direction: [0, -1, 0],
      color: SODIUM,
      intensity: spec.intensity ?? 7000,
      range: spec.range ?? 40,
      angle: 1.1,
      penumbra: 0.55,
      shadow: spec.shadow ?? false,
      size: 0.45,
      ...(spec.state === "flicker" ? { flicker: 0.6 } : {}),
    }
    ctx.lamps.push(lamp)
    if (spec.state === "flicker") return { lamp, lens: lens as THREE.MeshStandardMaterial }
  }
  return null
}

/** Keeps a failing lamp's lens in step with the light rig's flicker level for that lamp. */
export function lensFollower(target: { lamp: Lamp; lens: THREE.MeshStandardMaterial }) {
  const base = target.lens.emissiveIntensity
  let runtime: { lamp: Lamp; level: number } | undefined
  return () => {
    runtime ??= renderState.lamps.find((r) => r.lamp === target.lamp)
    if (runtime) target.lens.emissiveIntensity = base * Math.max(runtime.level, 0.02)
  }
}
