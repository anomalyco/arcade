import * as THREE from "three/webgpu"

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
  /** Compiles every drawable in `root` (detached from the scene) in the background. */
  warm(root: THREE.Object3D): Promise<void>
  /** Runs one frame of the render loop with the renderer's normal top-level state. */
  frame(fn: () => void): void
  /** Warm up objects added under `root` from now on before they are drawn (with `root` itself while it waits). */
  track(root: THREE.Object3D): void
  /** Resolves when no late arrival is being warmed. */
  idle(): Promise<void>
}

/** Materials compiled concurrently per warm-up. */
const CHAINS = 6

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
  const politeYield = () =>
    nativeYield && performance.now() - frameEnd < sliceMs
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
  const lateArrival = (obj: THREE.Object3D, root: { waiting: boolean; held: THREE.Object3D[] }) => {
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
    async warm(root) {
      const t = tracked.get(root)
      if (t) t.waiting = false
      try {
        await warmRoot(root)
      } finally {
        if (t) unhide(t.held.splice(0))
      }
    },
    track(root) {
      if (!tracked.has(root)) tracked.set(root, { waiting: true, held: [] })
    },
    async idle() {
      while (late.size) await Promise.all(late)
    },
  }

  async function warmRoot(root: THREE.Object3D) {
    if (!ready) return
    root.updateMatrixWorld(true)
    // Objects grouped by material: different materials compile concurrently (node building interleaves on the main
    // thread, pipelines compile in parallel on the GPU process), objects sharing a material go one after another so
    // the second one hits the first one's cached shaders instead of building them again.
    const groups = new Map<string, THREE.Object3D[]>()
    root.traverse((o) => {
      if (!isDrawable(o)) return
      const m = (o as Any).material
      const key = Array.isArray(m) ? m.map((x: Any) => x.uuid).join() : m.uuid
      let list = groups.get(key)
      if (!list) groups.set(key, (list = []))
      list.push(o)
    })
    const chains = [...groups.values()]
    enter()
    try {
      await Promise.all(
        Array.from({ length: Math.min(CHAINS, chains.length) }, async () => {
          for (let list = chains.shift(); list; list = chains.shift()) for (const o of list) await compileOne(o)
        }),
      )
    } finally {
      leave()
    }
  }
}
