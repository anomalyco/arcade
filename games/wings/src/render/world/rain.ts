// Rain streaks and sea spray (TSL, fully GPU-procedural): every particle's world position is a pure
// function of its seed, time and the camera — drops stay fixed in the world and wrap in a box around
// the camera, so there is no CPU work and no simulation state. Streaks stretch along the drop's
// velocity *relative to the camera*, so at 150+ m/s they become long motion-blurred lines.
import { AdditiveBlending, BufferAttribute, BufferGeometry, Mesh, Vector3 } from "three"
import { MeshBasicNodeMaterial } from "three/webgpu"
import {
  attribute, cameraPosition, clamp, cross, float, length, max, mod, normalize, smoothstep, time, uniform, vec3,
} from "three/tsl"
import { STORM, linear, type N } from "./atmosphere"
import { RAIN_COLOR } from "./palette"

export interface ParticleOptions {
  count: number
  /** Box edge (m) around the camera. */
  box: number
  /** Base fall velocity (m/s) before wind. */
  fall: number
  /** Streak brightness. */
  brightness: number
  /** Streak width (m) near the camera. */
  width: number
  /** Spray mode: particles hug the sea surface and are blown by the wind. */
  spray?: boolean
}

function seedGeometry(count: number): BufferGeometry {
  const seed = new Float32Array(count * 4 * 4)
  const corner = new Float32Array(count * 4 * 2)
  const idx = new Uint32Array(count * 6)
  for (let i = 0; i < count; i++) {
    const s = [Math.random(), Math.random(), Math.random(), Math.random()]
    for (let c = 0; c < 4; c++) {
      seed.set(s, (i * 4 + c) * 4)
      corner[(i * 4 + c) * 2] = c & 1 ? 1 : -1
      corner[(i * 4 + c) * 2 + 1] = c & 2 ? 1 : 0
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6)
  }
  const g = new BufferGeometry()
  g.setAttribute("position", new BufferAttribute(new Float32Array(count * 4 * 3), 3))
  g.setAttribute("seed", new BufferAttribute(seed, 4))
  g.setAttribute("corner", new BufferAttribute(corner, 2))
  g.setIndex(new BufferAttribute(idx, 1))
  return g
}

export function createParticles(opts: ParticleOptions) {
  const camVel = uniform(new Vector3())
  const visibility = uniform(1)
  const seed: N = attribute("seed", "vec4")
  const corner: N = attribute("corner", "vec2")
  const B = opts.box
  const wind: N = vec3(STORM.wind.x, 0, STORM.wind.y)
  const fallSpeed: N = float(opts.fall).mul(seed.w.mul(0.35).add(0.8))
  const vel: N = opts.spray ? wind.mul(2.2).add(vec3(0, seed.w.mul(3).sub(1), 0)) : wind.mul(0.9).add(vec3(0, fallSpeed.negate(), 0))
  const base: N = seed.xyz.mul(B).add(vel.mul(time))
  let rel: N = mod(base.sub(cameraPosition).add(B / 2), B).sub(B / 2)
  if (opts.spray) {
    // Spray lives in the first few metres above the sea, whatever the camera altitude.
    rel = vec3(rel.x, seed.y.mul(seed.y).mul(7).add(0.3).sub(cameraPosition.y), rel.z)
  }
  const world: N = cameraPosition.add(rel)
  const relVel: N = vel.sub(camVel)
  const speed: N = max(length(relVel), 1)
  const dir: N = relVel.div(speed)
  const len: N = clamp(speed.mul(0.028), opts.spray ? 0.4 : 0.7, 14)
  const toCam: N = cameraPosition.sub(world)
  const dist: N = max(length(toCam), 0.5)
  const side: N = normalize(cross(dir, toCam.div(dist))).mul(max(float(opts.width), dist.mul(0.0012)))
  const pos: N = world.add(dir.mul(corner.y.sub(0.5).mul(len))).add(side.mul(corner.x))

  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, fog: true })
  material.name = opts.spray ? "World · sea spray" : "World · rain"
  material.positionNode = pos
  const c = linear(RAIN_COLOR)
  // Fade at the wrap box edges and right at the lens; taper toward the streak tail.
  const edge: N = smoothstep(B * 0.5, B * 0.3, length(rel))
  const near: N = smoothstep(0.6, 3, dist)
  const taper: N = corner.y.mul(0.7).add(0.3)
  const flashLift: N = STORM.flash.mul(1.5).add(1)
  material.colorNode = vec3(c.r, c.g, c.b).mul(opts.brightness).mul(edge).mul(near).mul(taper).mul(flashLift).mul(visibility)
  const mesh = new Mesh(seedGeometry(opts.count), material)
  mesh.name = material.name
  mesh.frustumCulled = false
  mesh.renderOrder = 8

  return {
    mesh,
    /** Camera velocity (m/s) for streak orientation. */
    setCameraVelocity(v: Vector3) { camVel.value.copy(v) },
    setVisibility(v: number) { visibility.value = v; mesh.visible = v > 0.01 },
    dispose() { mesh.geometry.dispose(); material.dispose() },
  }
}
