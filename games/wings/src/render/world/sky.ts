// Storm sky (TSL): a camera-centred dome with layered moving storm clouds and bright breaks near the
// horizon, optional cloud-deck layers you can fly above/below/through, and lightning (bolt mesh +
// cloud/sea illumination via shared uniforms + a flash value the post pipeline can read).
import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, PlaneGeometry, SphereGeometry, Vector3,
} from "three"
import { MeshBasicNodeMaterial } from "three/webgpu"
import {
  abs, cameraPosition, clamp, dot, float, length, max, mix, normalize, positionLocal, positionWorld, pow, smoothstep, time, uniform,
  vec2, vec3,
} from "three/tsl"
import { STORM, fbm, stormSky, type N } from "./atmosphere"
import { CLOUD_DARK, CLOUD_LIGHT, LIGHTNING_COLOR } from "./palette"
import { linear } from "./atmosphere"

export function createSky() {
  const geometry = new SphereGeometry(1000, 48, 24)
  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, depthTest: false, fog: false })
  material.name = "World · storm sky"
  material.colorNode = stormSky(normalize(positionLocal), 5)
  const mesh = new Mesh(geometry, material)
  mesh.name = "World · sky dome"
  mesh.renderOrder = -1000
  mesh.frustumCulled = false
  return {
    mesh,
    update(camera: Vector3, _time: number) { mesh.position.copy(camera) },
    dispose() { geometry.dispose(); material.dispose() },
  }
}

/** Big translucent cloud-deck layers (follow the camera, fade when you fly through them). */
export function createCloudLayers(count: number, octaves = 5) {
  const group = new Group()
  group.name = "World · cloud decks"
  const layers: { mesh: Mesh; alt: number }[] = []
  const geometry = new PlaneGeometry(60_000, 60_000, 1, 1)
  geometry.rotateX(-Math.PI / 2)
  const alts = [1150, 1900]
  for (let i = 0; i < count; i++) {
    const alt = alts[i] ?? 1150 + i * 700
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide, fog: true })
    mat.name = `World · cloud deck ${i}`
    const p: N = positionWorld.xz
    const drift: N = STORM.wind.mul(time).mul(1 + i * 0.4)
    const d1: N = fbm(p.add(drift).mul(0.00042 + i * 0.00013).add(vec2(i * 17.3, i * 5.1)), octaves)
    const d2: N = fbm(p.add(drift.mul(1.3)).mul(0.0019).add(vec2(3.1, i * 9.7)), 3)
    const dens: N = smoothstep(0.42, 0.75, d1.mul(0.8).add(d2.mul(0.25)))
    const below: N = smoothstep(alt + 30, alt - 30, cameraPosition.y)
    const dark = linear(CLOUD_DARK).multiplyScalar(0.85), light = linear(CLOUD_LIGHT).multiplyScalar(1.25)
    // Bellies (seen from below) are dark; tops (from above) pick up the diffuse light.
    let col: N = mix(vec3(light.r, light.g, light.b), vec3(dark.r, dark.g, dark.b), below.mul(0.8).add(d2.mul(0.2)))
    const toP: N = positionWorld.sub(cameraPosition)
    const dist: N = length(toP)
    const fl: N = max(dot(normalize(toP), STORM.flashDir), 0)
    col = col.add(STORM.lightning.mul(STORM.flash).mul(pow(fl, 8).mul(1.6).add(0.15)))
    mat.colorNode = col
    // Thin out when the camera is inside the layer, and toward the horizon.
    const inside: N = smoothstep(25, 140, abs(cameraPosition.y.sub(alt)))
    const far: N = smoothstep(14_000, 6_000, dist)
    mat.opacityNode = clamp(dens.mul(0.88).mul(inside).mul(far), 0, 1)
    const mesh = new Mesh(geometry, mat)
    mesh.position.y = alt
    mesh.frustumCulled = false
    mesh.renderOrder = 4
    group.add(mesh)
    layers.push({ mesh, alt })
  }
  return {
    group,
    update(camera: Vector3) {
      for (const l of layers) l.mesh.position.set(Math.round(camera.x / 50) * 50, l.alt, Math.round(camera.z / 50) * 50)
    },
    dispose() {
      geometry.dispose()
      for (const l of layers) (l.mesh.material as MeshBasicNodeMaterial).dispose()
    },
  }
}

/** Lightning: random strikes every 8–25 s; a jagged bolt mesh and a flash envelope (0..1). */
export function createLightning() {
  const boltIntensity = uniform(0)
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false, side: DoubleSide })
  material.name = "World · lightning bolt"
  const lc = linear(LIGHTNING_COLOR)
  material.colorNode = vec3(lc.r, lc.g, lc.b).mul(boltIntensity.mul(40))
  material.opacityNode = float(1)
  const geometry = new BufferGeometry()
  const mesh = new Mesh(geometry, material)
  mesh.name = "World · lightning"
  mesh.frustumCulled = false
  mesh.visible = false
  mesh.renderOrder = 6

  let next = 3 + Math.random() * 4
  let clock = 0, strikeAt = -100
  let flash = 0
  const strikeDir = new Vector3()
  const strikePos = new Vector3()
  const listeners = new Set<(intensity: number, direction: Vector3) => void>()

  function buildBolt(camera: Vector3) {
    const ang = Math.random() * Math.PI * 2, dist = 2200 + Math.random() * 5000
    const x0 = camera.x + Math.cos(ang) * dist, z0 = camera.z + Math.sin(ang) * dist
    const top = 1100 + Math.random() * 500
    strikeDir.set(x0 - camera.x, top * 0.7 - camera.y, z0 - camera.z).normalize()
    strikePos.set(x0, top * 0.5, z0)
    const segs: [Vector3, Vector3, number][] = []
    const walk = (start: Vector3, endY: number, steps: number, width: number, branchChance: number) => {
      let p = start.clone()
      const stepY = (start.y - endY) / steps
      for (let i = 0; i < steps; i++) {
        const q = new Vector3(p.x + (Math.random() - 0.5) * stepY * 0.9, p.y - stepY * (0.7 + Math.random() * 0.6), p.z + (Math.random() - 0.5) * stepY * 0.9)
        if (i === steps - 1) q.y = endY
        segs.push([p, q, width])
        if (Math.random() < branchChance) walk(q, Math.max(endY, q.y - stepY * (3 + Math.random() * 5)), 4 + Math.floor(Math.random() * 4), width * 0.55, 0)
        p = q
      }
    }
    walk(new Vector3(x0, top, z0), 0, 18, 1, 0.22)
    const pos = new Float32Array(segs.length * 18)
    let o = 0
    const dir = new Vector3(), toCam = new Vector3(), side = new Vector3()
    for (const [a, b, w] of segs) {
      dir.subVectors(b, a).normalize()
      toCam.subVectors(camera, a).normalize()
      const width = w * Math.max(2, a.distanceTo(camera) * 0.0016)
      side.crossVectors(dir, toCam).normalize().multiplyScalar(width)
      const v = [a.clone().sub(side), a.clone().add(side), b.clone().add(side), a.clone().sub(side), b.clone().add(side), b.clone().sub(side)]
      for (const p of v) { pos[o++] = p.x; pos[o++] = p.y; pos[o++] = p.z }
    }
    geometry.setAttribute("position", new BufferAttribute(pos, 3))
    geometry.computeBoundingSphere()
  }

  /** Flash envelope: a bright stroke, a flicker and a re-strike, then a fading afterglow. */
  function envelope(t: number): number {
    if (t < 0) return 0
    if (t < 0.07) return 1
    if (t < 0.13) return 0.25
    if (t < 0.21) return 0.85
    if (t < 0.26) return 0.3
    if (t < 0.32) return 0.6
    return Math.max(0, 0.45 * Math.exp(-(t - 0.32) * 7))
  }

  return {
    mesh,
    /** Current flash intensity 0..1. */
    get value() { return flash },
    get direction() { return strikeDir },
    /** World position of the current/last strike (mid-bolt) and seconds since it happened. */
    get position() { return strikePos },
    get age() { return clock - strikeAt },
    onStrike(cb: (intensity: number, direction: Vector3) => void) { listeners.add(cb); return () => listeners.delete(cb) },
    /** Force a strike now (debug / preview). */
    strike(camera: Vector3) { next = clock; void camera },
    update(dt: number, camera: Vector3) {
      clock += dt
      if (clock >= next) {
        strikeAt = clock
        next = clock + 8 + Math.random() * 17
        buildBolt(camera)
        for (const l of listeners) l(1, strikeDir)
      }
      const t = clock - strikeAt
      flash = envelope(t)
      mesh.visible = t < 0.34
      boltIntensity.value = mesh.visible ? Math.max(0.15, flash) : 0
      STORM.flash.value = flash
      STORM.flashDir.value.copy(strikeDir)
      return flash
    },
    dispose() { geometry.dispose(); material.dispose() },
  }
}
