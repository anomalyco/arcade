import * as THREE from "three/webgpu"
import {
  Fn as TslFn,
  float,
  fract,
  mix,
  positionWorld,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  dot,
  floor,
  min,
  output,
} from "three/tsl"
import type { WorldContext } from "../world/context"
import { addControls, flag, num, renderState } from "./shared"

// Planar mirrors with a real reflection. Owners call `createMirror(ctx, { width, height, position, normal, up })`
// and get a mesh (already added to ctx.scene). Budget: only the nearest mirror that is within range, faces the camera
// and is on screen renders, every frame, into one shared reduced-resolution target; the others show dull glass.
//
// The reflection is rendered just before the post pipeline runs, from the un-jittered camera (TAAU only jitters the
// camera inside the pipeline), and the mirror surface samples it by projecting its own world position with the
// virtual camera's matrix rather than with screen UVs, so the image is stable under temporal AA (no shimmer) and the
// parallax is exact. The virtual camera also sees the player's head layer (hidden from the view camera).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any
const Fn = TslFn as N

/** player/body.ts: HEAD_LAYER (head, neck, hair: hidden from the view camera, wanted in mirrors). */
const HEAD_LAYER = 4
/** player/body.ts: BODY_LAYER (body and held torch). */
const BODY_LAYER = 3

export type MirrorOptions = {
  width: number
  height: number
  /** Centre of the glass (world). */
  position: readonly [number, number, number]
  /** Outward normal (the side the reflection is seen from). */
  normal: readonly [number, number, number]
  /** Up direction in the glass plane (default world up). */
  up?: readonly [number, number, number]
  /** Aging 0 (new) .. 1 (badly desilvered). Default 0.45. */
  age?: number
}

type Mirror = {
  mesh: THREE.Mesh
  center: THREE.Vector3
  normal: THREE.Vector3
  box: THREE.Box3
  live: THREE.UniformNode<"float", number>
}

const mirrors: Mirror[] = []
const shared = {
  rt: new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true }),
  viewProj: uniform(new THREE.Matrix4()),
  blur: uniform(1),
  texel: uniform(new THREE.Vector2(1, 1)),
}
shared.rt.texture.name = "Ashwood.Mirror"
const reflectionTex = texture(shared.rt.texture)

const hash = (p: N): N => (fract as N)(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453))
const vnoise = (p: N) => {
  const i: N = (floor as N)(p)
  const f: N = (fract as N)(p)
  const u: N = f.mul(f).mul(f.mul(-2).add(3))
  const a = hash(i)
  const b = hash(i.add(vec2(1, 0)))
  const c = hash(i.add(vec2(0, 1)))
  const d = hash(i.add(vec2(1, 1)))
  return (mix as N)((mix as N)(a, b, u.x), (mix as N)(c, d, u.x), u.y)
}

function mirrorMaterial(width: number, height: number, age: number, live: N) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0 })
  m.name = "mirror_glass"
  const reflection = Fn(() => {
    // Project this fragment with the mirror camera: exact, jitter-free lookup.
    const clip = shared.viewProj.mul(vec4(positionWorld, 1))
    const ndc = clip.xy.div(clip.w)
    const ruv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)).toVar()
    // Surface metres → aging pattern (UV 0..1 across the glass).
    const p = uv().mul(vec2(width, height))
    const e = min(min(uv().x, uv().x.oneMinus()).mul(width), min(uv().y, uv().y.oneMinus()).mul(height))
    const n1 = vnoise(p.mul(9))
    const n2 = vnoise(p.mul(31).add(7.3))
    // Desilvering creeps in from the edges in ragged patches; small foxing spots scattered over the glass.
    const edgeLoss = smoothstep(0.02 + 0.09 * age, 0.0, e.sub(n1.mul(0.05 * age)))
    const spots = smoothstep(0.86 - 0.12 * age, 0.97, n2.mul(0.6).add(n1.mul(0.4))).mul(age)
    const silver = float(1).sub(edgeLoss.mul(0.85)).sub(spots.mul(0.7)).clamp(0, 1)
    // Slight haze: a 5-tap blur whose radius grows with grime, plus a faint grey veil.
    const r = shared.texel.mul(shared.blur.mul(n1.mul(0.8).add(0.6)))
    const c = reflectionTex.sample(ruv).rgb.mul(0.4)
      .add(reflectionTex.sample(ruv.add(vec2(r.x, 0))).rgb.mul(0.15))
      .add(reflectionTex.sample(ruv.sub(vec2(r.x, 0))).rgb.mul(0.15))
      .add(reflectionTex.sample(ruv.add(vec2(0, r.y))).rgb.mul(0.15))
      .add(reflectionTex.sample(ruv.sub(vec2(0, r.y))).rgb.mul(0.15))
    // Silvered glass reflects ~85 %, slightly warm-green from the glass body.
    return c.mul(vec3(0.84, 0.87, 0.83)).mul(silver).mul(live)
  })()
  m.emissiveNode = reflection
  // While live the glass shows only its reflection: no direct lighting on top (a torch or lamp highlight on the
  // surface washed the reflected room out to a bright disc and hid the player's reflection).
  ;(m as unknown as { outputNode: unknown }).outputNode = mix(output, vec4(reflection, 1), live)
  // Where the silver is gone you see the dark backing; when not live, a dull grey sheen from the room's light.
  // Silvered glass has no diffuse and its specular IS the reflection: while live, lamps and the flashlight add nothing
  // to the surface (their highlight on the glass washed the reflected room out to a bright disc); a dull grey
  // sheen only when the glass isn't rendering.
  m.colorNode = vec3(0.025, 0.027, 0.026).add(vec3(0.06).mul(live.oneMinus()))
  m.roughnessNode = float(0.22)
  return m
}

export function createMirror(ctx: WorldContext, o: MirrorOptions): THREE.Mesh {
  const normal = new THREE.Vector3(...o.normal).normalize()
  const up = new THREE.Vector3(...(o.up ?? [0, 1, 0]))
  const right = new THREE.Vector3().crossVectors(up, normal).normalize()
  up.crossVectors(normal, right).normalize()
  const live = uniform(0)
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(o.width, o.height), mirrorMaterial(o.width, o.height, o.age ?? 0.45, live))
  mesh.matrix.makeBasis(right, up, normal).setPosition(...o.position)
  mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale)
  mesh.name = "mirror"
  mesh.castShadow = false
  mesh.receiveShadow = false
  ctx.scene.add(mesh)
  const center = new THREE.Vector3(...o.position)
  const box = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(o.width, o.height, o.width).multiplyScalar(1.05))
  mirrors.push({ mesh, center, normal, box, live })
  return mesh
}

/** Installs the per-frame mirror renderer (called once by the lighting rig, with the real scene). */
export function initMirrors(ctx: WorldContext, extraHidden: () => THREE.Object3D[], player?: unknown) {
  addControls(ctx, [
    { key: "mirror.on", label: "Live mirror reflections", group: "Mirrors", type: "toggle", value: true },
    { key: "mirror.range", label: "Render within", group: "Mirrors", unit: "m", min: 2, max: 20, step: 0.5, value: 8 },
    { key: "mirror.scale", label: "Resolution", group: "Mirrors", unit: "× screen", min: 0.25, max: 1, step: 0.05, value: 0.5 },
    { key: "mirror.far", label: "Reflected distance", group: "Mirrors", unit: "m", min: 5, max: 200, step: 1, value: 40 },
    { key: "mirror.blur", label: "Haze", group: "Mirrors", unit: "texels", min: 0, max: 4, step: 0.1, value: 1 },
  ])
  const { renderer, camera } = ctx

  if (ctx.params.has("mirrortest")) {
    // Automation only: a washroom-sized mirror on the north wall of the ground-floor corridor.
    createMirror(ctx, { width: 1.4, height: 1.0, position: [-20, 1.6, -1.58], normal: [0, 0, 1] })
  }

  const virtualCam = new THREE.PerspectiveCamera()
  const frustum = new THREE.Frustum()
  const pv = new THREE.Matrix4()
  const camPos = new THREE.Vector3()
  const toCam = new THREE.Vector3()
  const plane = new THREE.Plane()
  const clip = new THREE.Vector4()
  const q = new THREE.Vector4()
  const size = new THREE.Vector2()
  const lookAt = new THREE.Vector3()
  const rot = new THREE.Matrix4()
  const _inv = new THREE.Matrix4()
  const _p = new THREE.Vector3()
  let lastMs = 0

  const sceneOf = (o: THREE.Object3D) => {
    let p: THREE.Object3D | null = o
    while (p && !(p as THREE.Scene).isScene) p = p.parent
    return p as THREE.Scene | null
  }
  const shownInScene = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false
    return true
  }

  const mirrorFrustum = new THREE.Frustum()
  let frameNo = 0
  let taggedFor = -1
  // The flashlight's beam bounced off the live glass: a real spot light at the torch's mirror image, aimed along the
  // reflected beam, so you see yourself (and the room behind you) lit by your own torch in the mirror. Always in the
  // light list (adding it later would recompile every material); zero when unused.
  const bounce = new THREE.SpotLight(0xffffff, 0, 30, 0.4, 0.6, 2)
  bounce.castShadow = false
  ctx.scene.add(bounce, bounce.target)
  const hitP = new THREE.Vector3()
  const ray = new THREE.Ray()
  const local = new THREE.Vector3()
  const inv = new THREE.Matrix4()
  renderState.beforeRender.push(() => {
    for (const m of mirrors) m.live.value = 0
    renderState.mirrorFrustum = null
    bounce.intensity = 0
    if (!mirrors.length || !flag(ctx, "mirror.on")) return
    camera.updateMatrixWorld()
    camPos.setFromMatrixPosition(camera.matrixWorld)
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(pv)
    const range = num(ctx, "mirror.range")
    let best: Mirror | null = null
    let bestD = Infinity
    for (const m of mirrors) {
      toCam.subVectors(camPos, m.center)
      const d = toCam.length()
      if (d > range || d >= bestD || toCam.dot(m.normal) <= 0.01) continue
      if (!frustum.intersectsBox(m.box) || !shownInScene(m.mesh)) continue
      best = m
      bestD = d
    }
    if (!best) return
    const scene = sceneOf(best.mesh)
    if (!scene) return
    const t0 = performance.now()

    // Mirror the view camera across the glass plane (same projection; the image is flipped by the reflection).
    plane.setFromNormalAndCoplanarPoint(best.normal, best.center)
    virtualCam.copy(camera as THREE.PerspectiveCamera, false)
    // Must match the renderer's, or render() re-derives the projection and drops the oblique clip below.
    virtualCam.coordinateSystem = camera.coordinateSystem
    const reflectPoint = (v: THREE.Vector3) => v.sub(best!.normal.clone().multiplyScalar(2 * plane.distanceToPoint(v)))
    virtualCam.position.copy(reflectPoint(camPos.clone()))
    rot.extractRotation(camera.matrixWorld)
    lookAt.set(0, 0, -1).applyMatrix4(rot).add(camPos)
    reflectPoint(lookAt)
    virtualCam.up.set(0, 1, 0).applyMatrix4(rot).reflect(best.normal)
    virtualCam.lookAt(lookAt)
    virtualCam.near = camera.near
    virtualCam.far = Math.min(camera.far, num(ctx, "mirror.far"))
    virtualCam.updateProjectionMatrix()
    virtualCam.updateMatrixWorld()
    // Body and head both visible in the mirror.
    // A glass with `userData.reflectLayer` (washrooms) reflects only that layer plus the player (body + head): the
    // rest of the world never reaches it anyway and skipping it roughly halves the cost. Lights are unaffected.
    const only = best.mesh.userData.reflectLayer as number | undefined
    // three only renders lights whose layers the camera sees: a layer-limited mirror camera must still see the
    // lamps, the torch and its bounce (they live on layer 0), or the reflection is lit by ambient alone (the player
    // reflected as a black silhouette). Lights stream in with modules, so re-tag now and then.
    if (only !== undefined && (frameNo++ % 30 === 0 || taggedFor !== only)) {
      taggedFor = only
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight) o.layers.enable(only)
      })
    }
    virtualCam.layers.mask =
      only !== undefined ? (1 << only) | (1 << BODY_LAYER) | (1 << HEAD_LAYER) : camera.layers.mask | (1 << HEAD_LAYER)
    // Sampling matrix: plain projection × view (before the oblique clip below, which only trims geometry behind
    // the glass and leaves x/y untouched).
    shared.viewProj.value.multiplyMatrices(virtualCam.projectionMatrix, virtualCam.matrixWorldInverse)
    mirrorFrustum.setFromProjectionMatrix(shared.viewProj.value)
    renderState.mirrorFrustum = mirrorFrustum

    // Oblique near plane = the glass, so nothing behind the mirror (the wall, the next room) is rendered into it.
    plane.applyMatrix4(virtualCam.matrixWorldInverse)
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant)
    // Orient it so the room side (in front of the glass) is positive.
    _p.copy(best.center).addScaledVector(best.normal, 1).applyMatrix4(virtualCam.matrixWorldInverse)
    if (clip.x * _p.x + clip.y * _p.y + clip.z * _p.z + clip.w < 0) clip.negate()
    // Oblique near plane = the glass. The renderer uses a reversed, infinite-far depth buffer (near → 1, far → 0), so
    // the depth row becomes w − k·(C·v): exactly 1 on the glass (the new near plane), > 1 behind it (clipped), and
    // falling towards 0 into the room. C is normalised so k = 0.5 keeps every visible point inside [0, 1].
    const pm = virtualCam.projectionMatrix
    const len = Math.hypot(clip.x, clip.y, clip.z)
    clip.multiplyScalar(1 / len)
    if ((renderer as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer) {
      const k = 0.5
      pm.elements[2] = pm.elements[3]! - k * clip.x
      pm.elements[6] = pm.elements[7]! - k * clip.y
      pm.elements[10] = pm.elements[11]! - k * clip.z
      pm.elements[14] = pm.elements[15]! - k * clip.w
    } else {
      // Standard [0, 1] depth: Lengyel's construction with the far corner q on the plane's side.
      clip.negate()
      q.set(Math.sign(clip.x), Math.sign(clip.y), 1, 1).applyMatrix4(_inv.copy(pm).invert())
      clip.multiplyScalar(1 / clip.dot(q))
      pm.elements[2] = clip.x
      pm.elements[6] = clip.y
      pm.elements[10] = clip.z
      pm.elements[14] = clip.w
    }
    virtualCam.projectionMatrixInverse.copy(pm).invert()

    renderer.getDrawingBufferSize(size)
    const s = num(ctx, "mirror.scale")
    const w = Math.max(16, Math.round(size.x * s))
    const h = Math.max(16, Math.round(size.y * s))
    if (shared.rt.width !== w || shared.rt.height !== h) shared.rt.setSize(w, h)
    shared.texel.value.set(1 / w, 1 / h)
    shared.blur.value = num(ctx, "mirror.blur")

    // Torch bounce: where the beam's axis meets the glass (inside its rectangle, with a soft margin).
    const f = renderState.flash
    if (f.on && f.candela && f.light) {
      ray.set(f.pos, f.dir)
      plane.setFromNormalAndCoplanarPoint(best!.normal, best!.center)
      if (f.dir.dot(best!.normal) < -0.05 && ray.intersectPlane(plane, hitP)) {
        inv.copy(best!.mesh.matrixWorld).invert()
        local.copy(hitP).applyMatrix4(inv)
        const g = best!.mesh.geometry as THREE.PlaneGeometry
        const hw = g.parameters.width / 2 + 0.4
        const hh = g.parameters.height / 2 + 0.4
        const inside = Math.max(0, 1 - Math.max(Math.abs(local.x) / hw, Math.abs(local.y) / hh)) ** 0.5
        if (inside > 0) {
          const d = plane.distanceToPoint(f.pos)
          bounce.position.copy(f.pos).addScaledVector(best!.normal, -2 * d)
          bounce.target.position.copy(bounce.position).add(_p.copy(f.dir).reflect(best!.normal))
          bounce.angle = f.angle ?? 0.4
          bounce.penumbra = f.light.penumbra
          bounce.distance = f.light.distance
          bounce.color.copy(f.light.color)
          // ~85 % reflectance, less where the silver has gone; only the part of the beam that lands on the glass.
          bounce.intensity = f.candela * 0.8 * inside
          bounce.target.updateMatrixWorld()
        }
      }
    }

    // Hide what must not appear in the reflection: every mirror (no feedback) and the lamp glow sprites (their
    // G-buffer MRT override would replace the colour in a single-target render).
    const hidden: THREE.Object3D[] = [...mirrors.map((m) => m.mesh), ...extraHidden()]
    const was = hidden.map((o) => o.visible)
    for (const o of hidden) o.visible = false
    const prevTarget = renderer.getRenderTarget()
    const prevMRT = renderer.getMRT()
    const prevClear = renderer.autoClear
    renderer.setMRT(null)
    renderer.setRenderTarget(shared.rt)
    renderer.autoClear = true
    renderer.render(scene, virtualCam)
    renderer.setRenderTarget(prevTarget)
    renderer.setMRT(prevMRT)
    renderer.autoClear = prevClear
    hidden.forEach((o, i) => (o.visible = was[i]!))
    best.live.value = 1


    lastMs = performance.now() - t0
  })

  const api = { cpuMs: () => lastMs, count: () => mirrors.length, rt: shared.rt, mirrors, virtualCam, player, bounce }
  if (ctx.params.has("perf") || import.meta.env.DEV) (globalThis as { __afterhoursMirrors?: unknown }).__afterhoursMirrors = api
  return api
}
