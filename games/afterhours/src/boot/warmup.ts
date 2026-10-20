import * as THREE from "three/webgpu"
import { touch } from "./schedule"

// Background pipeline warm-up for objects that are about to join the scene.
//
// The post stack renders the scene through a pass with a G-buffer MRT into its own render target, and materials
// build their fragment outputs from whatever render target and MRT are current when their nodes are built. r186's
// `renderer.compileAsync` builds nodes asynchronously (yielding between objects and shader stages), so it reads that
// global state long after the call returns. So: the first time the scene pass renders, capture its target and MRT;
// while any warm-up is running, keep them current between frames and switch back to the normal top-level state for
// the duration of each frame (`frame(fn)` wraps the render loop). Pipelines are created with
// createRenderPipelineAsync; when `warm` resolves, adding the group draws it without compiling in the frame
// (shadow-map pipelines are the exception: those compile on the first shadow refresh that sees the object).
//
// Builders also attach objects after `build` returns (GLB models resolve later). Anything added under a tracked module
// root once warm-up is ready is kept off every camera layer until its own warm-up finishes, so a late model appears a
// moment later instead of stalling the frame that first draws it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type Warmup = {
  /** True once the scene pass has rendered at least once (warm-up needs its render context). */
  readonly ready: boolean
  /**
   * Compiles every drawable in `root`. `progressive`: `root` may already be in the scene; its drawables are hidden now
   * and revealed one by one as their pipelines are ready (`onReveal` fires after each), nearest/visible first.
   * `visibleOnly`: only what the game draws right now (every ancestor visible); resolves with the drawables it hides
   * (other storeys, far furniture...) so they can be warmed later with `warmObjects`.
   */
  warm(root: THREE.Object3D, options?: { progressive?: boolean; onReveal?: () => void; visibleOnly?: boolean }): Promise<THREE.Object3D[]>
  /** Compiles these objects (e.g. what `warm({ visibleOnly })` left for later), nearest first; visibility untouched. */
  warmObjects(objects: THREE.Object3D[]): Promise<void>
  /**
   * Compiles these objects for another pass that renders the scene: `target` only needs the same attachment layout as
   * that pass's (render contexts are keyed by format, not instance), `mrt` its MRT (null for a plain colour pass) and
   * `depth` its nesting depth (0 = called at the top level). Waits for other warm-ups to finish first.
   */
  warmIn(objects: THREE.Object3D[], pass: { target: THREE.RenderTarget; mrt: unknown; depth: number; layers?: number }): Promise<void>
  /** Runs one frame of the render loop with the renderer's normal top-level state. */
  frame(fn: () => void): void
  /** Warm up objects added under `root` from now on before they are drawn (with `root` itself while it waits). */
  track(root: THREE.Object3D): void
  /** Resolves when no late arrival is being warmed. */
  idle(): Promise<void>
  /**
   * Creates the GPU vertex/index buffers of these objects now (cheap behind the loading screen), so compiling them later
   * during play doesn't upload big merged meshes in a frame.
   */
  uploadGeometry(objects: THREE.Object3D[]): void
  /** Hidden late arrivals since the last call (see `lateArrival`). */
  takeHidden(): THREE.Object3D[]
  /** performance.now() of the last object added under a tracked root after its build (0 if none yet). */
  readonly lastArrival: number
  /**
   * Behind a loading screen nothing on screen needs protecting: compile at full throughput (more materials in flight,
   * yields never wait for a frame). Off: sliced around frames, fewer in flight, nearest first.
   */
  setCovered(on: boolean): void
}

/** Materials compiled concurrently per warm-up (behind the loading screen / during play). */
const CHAINS_COVERED = 10
const CHAINS_PLAY = 1

/**
 * @param sliceMs main-thread time per frame that background compiles may take before yielding to rendering
 *   (0 = three's default scheduler.yield everywhere).
 */
export function createWarmup(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, sliceMs = 8): Warmup {
  const r = renderer as Any
  let target: THREE.RenderTarget | null = null
  let mrt: Any = null
  let ready = false
  let active = 0
  let depth = 0

  // Capture the scene pass's render context on its first render, then step out of the way.
  r.render = function (this: Any, s: THREE.Object3D, c: THREE.Camera) {
    if (s === scene && renderer.getMRT() !== null) {
      target = renderer.getRenderTarget()
      mrt = renderer.getMRT()
      // Render contexts are keyed by nesting depth too; the scene pass renders inside the post quad's render.
      depth = r._callDepth + 1
      performance.mark(`warmup:capture:depth${depth}`)
      ready = true
      delete r.render
    }
    return Object.getPrototypeOf(r).render.call(this, s, c)
  }

  // three yields between objects and shader stages with scheduler.yield(), whose continuations outrank rendering:
  // with several compiles in flight the page then only paints when Chrome's anti-starvation kicks in (~100 ms). While
  // warming, yields stay fast until `sliceMs` have passed since the last frame ended, then become ordinary tasks so
  // the next frame gets in first.
  const sched = (globalThis as { scheduler?: Any }).scheduler
  const nativeYield = sched?.yield as (() => Promise<void>) | undefined
  let frameEnd = performance.now()
  let covered = false
  const politeYield = () =>
    nativeYield && (covered || performance.now() - frameEnd < sliceMs)
      ? nativeYield.call(sched)
      : sched?.postTask
        ? sched.postTask(() => {}, { priority: "user-visible" })
        : new Promise((resolve) => setTimeout(resolve, 0))
  const enter = () => {
    if (active++ > 0) return
    renderer.setRenderTarget(target)
    renderer.setMRT(mrt)
    if (nativeYield && sliceMs > 0) sched.yield = politeYield
  }
  const leave = () => {
    if (--active > 0) return
    renderer.setRenderTarget(null)
    renderer.setMRT(null)
    if (sched && Object.hasOwn(sched, "yield")) delete sched.yield
  }

  // Layer masks of late arrivals hidden until warmed (mask 0 = drawn by no camera, shadow cameras included).
  const hiddenMask = new Map<THREE.Object3D, number>()
  // Tracked module roots. While a root waits for its turn, late arrivals under it are only hidden (its own warm-up
  // compiles them with the rest); once it is warming or shown they are warmed individually.
  const tracked = new WeakMap<THREE.Object3D, { waiting: boolean; held: THREE.Object3D[] }>()
  const late = new Set<Promise<void>>()

  const compileOne = (obj: THREE.Object3D): Promise<void> => {
    const nodeFrame = r._nodes.nodeFrame
    const saved = { frameId: nodeFrame.frameId, time: nodeFrame.time, deltaTime: nodeFrame.deltaTime, lastTime: nodeFrame.lastTime }
    // Compile what the camera can't see yet too (the player turns around; LOD levels and toggled parts appear
    // later). Projection happens synchronously, so the flags are restored before the call returns.
    const culled: THREE.Object3D[] = []
    const hidden: THREE.Object3D[] = []
    obj.traverse((o) => {
      if (o.frustumCulled) {
        o.frustumCulled = false
        culled.push(o)
      }
      if (!o.visible) {
        o.visible = true
        hidden.push(o)
      }
      const mask = hiddenMask.get(o)
      if (mask !== undefined) o.layers.mask = mask
    })
    const contexts = r._renderContexts
    const get = contexts.get
    contexts.get = (rt: unknown, m: unknown, d = depth) => get.call(contexts, rt, m, d)
    try {
      return renderer.compileAsync(obj, camera, scene).catch(() => {})
    } finally {
      delete contexts.get
      for (const o of culled) o.frustumCulled = true
      for (const o of hidden) o.visible = false
      obj.traverse((o) => {
        if (hiddenMask.has(o)) o.layers.mask = 0
      })
      // compileAsync advances the node frame; restore it so per-frame nodes (velocity, TRAA) don't skip a beat.
      Object.assign(nodeFrame, saved)
    }
  }

  const isDrawable = (o: THREE.Object3D) => {
    const d = o as Any
    return (d.isMesh || d.isSprite || d.isLine || d.isPoints) && !!d.material
  }
  const unhide = (list: THREE.Object3D[]) => {
    for (const o of list) {
      // Leave the mask alone if the builder changed it meanwhile.
      if (o.layers.mask === 0) o.layers.mask = hiddenMask.get(o)!
      hiddenMask.delete(o)
    }
  }
  const trackedRoot = (o: THREE.Object3D | null) => {
    for (; o; o = o.parent) {
      const t = tracked.get(o)
      if (t) return t
    }
    return null
  }
  let lastArrival = 0
  // Late arrivals the game hides (under a hidden storey, far furniture): not waited for and not masked; queued for
  // `takeHidden()` so they can warm in the background like what `warm({ visibleOnly })` left over.
  const hiddenLate: THREE.Object3D[] = []
  const lateArrival = (obj: THREE.Object3D, root: { waiting: boolean; held: THREE.Object3D[] }) => {
    // Builders' follow-up work (the interior bakes furniture after build) is CPU that would otherwise run during play:
    // every arrival, hidden or not, holds the loading screen until they stop.
    lastArrival = performance.now()
    touch()
    let shown = true
    for (let a: THREE.Object3D | null = obj; a && shown; a = a.parent) shown = a.visible
    if (!shown) {
      obj.traverse((o) => {
        if (isDrawable(o)) hiddenLate.push(o)
      })
      return
    }
    const mine: THREE.Object3D[] = []
    obj.traverse((o) => {
      if (isDrawable(o) && !hiddenMask.has(o)) {
        hiddenMask.set(o, o.layers.mask)
        o.layers.mask = 0
        mine.push(o)
      }
    })
    if (!mine.length) return
    if (root.waiting) {
      root.held.push(...mine)
      return
    }
    const job = warmRoot(obj)
      .catch(() => {})
      .then(() => {
        unhide(mine)
        const seen = mine.find((o) => inView(o))
        if (seen) performance.mark(`pop:late:${seen.name || seen.type}`)
        late.delete(job)
      })
    late.add(job)
  }
  const add = THREE.Object3D.prototype.add
  THREE.Object3D.prototype.add = function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
    const result = add.apply(this, objects)
    // Multi-argument adds recurse into single ones.
    if (ready && objects.length === 1 && objects[0] !== this) {
      const root = trackedRoot(this)
      if (root) lateArrival(objects[0]!, root)
    }
    return result
  }

  const frustum = new THREE.Frustum()
  const projView = new THREE.Matrix4()
  const sphere = new THREE.Sphere()
  const eye = new THREE.Vector3()
  /** Whether `o` is in the camera's view right now (for pop-in accounting). */
  const inView = (o: THREE.Object3D) => {
    for (let a: THREE.Object3D | null = o; a; a = a.parent) if (!a.visible) return false
    camera.updateMatrixWorld()
    camera.getWorldPosition(eye)
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projView)
    return priority(o) < 300
  }
  /** Lower is sooner: in view first, then by distance from the camera. */
  const priority = (o: THREE.Object3D) => {
    if (!o.frustumCulled) return 0
    const d = o as Any
    const bounds = d.isInstancedMesh ? (d.boundingSphere ?? (d.computeBoundingSphere(), d.boundingSphere)) : d.geometry?.boundingSphere ?? (d.geometry?.computeBoundingSphere(), d.geometry?.boundingSphere)
    if (!bounds) return 1e6
    sphere.copy(bounds).applyMatrix4(o.matrixWorld)
    const dist = Math.max(0, sphere.distanceToPoint(eye))
    return frustum.intersectsSphere(sphere) ? dist : 1e4 + dist
  }

  return {
    get ready() {
      return ready
    },
    frame(fn) {
      if (active === 0) {
        fn()
      } else {
        renderer.setRenderTarget(null)
        renderer.setMRT(null)
        try {
          fn()
        } finally {
          renderer.setRenderTarget(target)
          renderer.setMRT(mrt)
        }
      }
      frameEnd = performance.now()
    },
    async warm(root, options = {}) {
      const t = tracked.get(root)
      if (t) t.waiting = false
      const mine = new Set<THREE.Object3D>()
      if (options.progressive) {
        root.traverse((o) => {
          if (isDrawable(o) && !hiddenMask.has(o)) {
            hiddenMask.set(o, o.layers.mask)
            o.layers.mask = 0
            mine.add(o)
          }
        })
      }
      const reveal = (o: THREE.Object3D) => {
        if (!mine.delete(o)) return
        unhide([o])
        if (inView(o)) performance.mark(`pop:${o.name || o.type}`)
        options.onReveal?.()
      }
      const { now, later } = drawables(root, !!options.visibleOnly)
      try {
        await warmRoot(root, reveal, now)
      } finally {
        unhide([...mine])
        if (t) unhide(t.held.splice(0))
      }
      return later
    },
    async warmObjects(objects) {
      const byRoot = new Map<THREE.Object3D, THREE.Object3D[]>()
      for (const o of objects) {
        let r = o
        while (r.parent) r = r.parent
        let l = byRoot.get(r)
        if (!l) byRoot.set(r, (l = []))
        l.push(o)
      }
      for (const [r, l] of byRoot) await warmRoot(r, undefined, l)
    },
    track(root) {
      if (!tracked.has(root)) tracked.set(root, { waiting: true, held: [] })
    },
    uploadGeometry(objects) {
      const attrs = r._attributes
      const seen = new Set<unknown>()
      for (const o of objects) {
        const g = (o as Any).geometry as THREE.BufferGeometry | undefined
        if (!g || seen.has(g)) continue
        seen.add(g)
        for (const a of Object.values(g.attributes)) attrs.update(a, 1)
        if (g.index) attrs.update(g.index, 2)
      }
    },
    async warmIn(objects, pass) {
      if (!ready || !objects.length) return
      while (active > 0) await new Promise((r) => setTimeout(r, 20))
      const saved = { target, mrt, depth, layers: camera.layers.mask }
      target = pass.target
      mrt = pass.mrt
      depth = pass.depth
      if (pass.layers !== undefined) camera.layers.mask = pass.layers
      try {
        await this.warmObjects(objects)
      } finally {
        target = saved.target
        mrt = saved.mrt
        depth = saved.depth
        camera.layers.mask = saved.layers
      }
    },
    takeHidden() {
      return hiddenLate.splice(0)
    },
    get lastArrival() {
      return lastArrival
    },
    setCovered(on) {
      covered = on
    },
    async idle() {
      while (late.size) await Promise.all(late)
    },
  }

  /** Drawables under `root`; with `visibleOnly`, split into the ones the game draws now and the ones it hides. */
  function drawables(root: THREE.Object3D, visibleOnly: boolean) {
    const now: THREE.Object3D[] = []
    const later: THREE.Object3D[] = []
    const walk = (o: THREE.Object3D, shown: boolean) => {
      const vis = shown && o.visible
      if (isDrawable(o)) (vis || !visibleOnly ? now : later).push(o)
      for (const c of o.children) walk(c, vis)
    }
    walk(root, true)
    return { now, later }
  }

  async function warmRoot(root: THREE.Object3D, onCompiled: (o: THREE.Object3D) => void = () => {}, list?: THREE.Object3D[]) {
    if (!ready) return
    root.updateMatrixWorld(true)
    camera.updateMatrixWorld()
    camera.getWorldPosition(eye)
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projView)
    // Objects grouped by material: different materials compile concurrently (node building interleaves on the main
    // thread, pipelines compile in parallel on the GPU process), objects sharing a material go one after another so
    // the second one hits the first one's cached shaders instead of building them again.
    const groups = new Map<string, THREE.Object3D[]>()
    for (const o of list ?? drawables(root, false).now) {
      const m = (o as Any).material
      const key = Array.isArray(m) ? m.map((x: Any) => x.uuid).join() : m.uuid
      let g = groups.get(key)
      if (!g) groups.set(key, (g = []))
      g.push(o)
    }
    // What the player can see first, within and across material groups.
    const score = new Map<THREE.Object3D, number>()
    const chains = [...groups.values()].map((list) => {
      for (const o of list) score.set(o, priority(o))
      return list.sort((a, b) => score.get(a)! - score.get(b)!)
    })
    chains.sort((a, b) => score.get(a[0]!)! - score.get(b[0]!)!)
    enter()
    try {
      await Promise.all(
        Array.from({ length: Math.min(covered ? CHAINS_COVERED : CHAINS_PLAY, chains.length) }, async () => {
          for (let list = chains.shift(); list; list = chains.shift())
            for (const o of list) {
              await compileOne(o)
              touch()
              onCompiled(o)
            }
        }),
      )
    } finally {
      leave()
    }
  }
}
