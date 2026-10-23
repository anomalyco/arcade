import { buildForest, forestHeightGrid, type BuildOptions, type ForestBuild, type HeightGrid } from "./build"
import type { ForestModels } from "./assets"
import type { ForestWorld } from "../sim/forest-world"
import { modelTransfers, type BuildReply, type BuildRequest } from "./build-worker"

/**
 * `buildForest` on a worker, so the page keeps decoding textures and drawing its loading screen meanwhile. Start it
 * before the asset fetches: its script then loads first instead of queueing behind the images on the host's few
 * connections. Without workers it builds on the main thread.
 */
export class ForestBuilder {
  private worker?: Worker

  constructor() {
    if (typeof Worker === "undefined") return
    try {
      this.worker = new Worker(new URL("./build-worker.ts", import.meta.url), { type: "module" })
    } catch (error) {
      console.warn("forest: no build worker:", error)
    }
  }

  /**
   * Builds `world`. `ground` is the game's height sampled here (`forestHeightGrid`, which needs the game's function);
   * the worker builds on it, byte for byte the main thread's build. The models move to the worker and back: use the
   * returned ones afterwards. Rejects only if the worker dies holding the models; any other failure builds here.
   * `onStart` gets the page time at which the worker began building.
   */
  async build(world: ForestWorld, models: ForestModels, opts: BuildOptions, ground: HeightGrid = forestHeightGrid(world), onStart?: (time: number) => void): Promise<{ build: ForestBuild; models: ForestModels }> {
    const worker = this.worker
    this.worker = undefined
    if (!worker) return { build: buildForest(world, models, opts, ground), models }
    const { height: _height, ...data } = world
    let sent = false
    try {
      const reply = await new Promise<BuildReply>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<BuildReply>) => resolve(e.data)
        worker.onerror = (e) => { e.preventDefault(); reject(new Error(e.message || "the build worker failed")) }
        worker.onmessageerror = () => reject(new Error("the build couldn't be received"))
        worker.postMessage({ world: data, models, opts, ground } satisfies BuildRequest, modelTransfers(models))
        sent = true
      })
      if ("build" in reply) {
        onStart?.(reply.started - performance.timeOrigin)
        return { build: reply.build, models: reply.models }
      }
      models = reply.models
      throw new Error(reply.error)
    } catch (error) {
      if (sent && modelTransfers(models).some((b) => b.byteLength === 0)) throw error
      console.warn("forest: building on the main thread:", error)
      return { build: buildForest(world, models, opts, ground), models }
    } finally {
      worker.terminate()
    }
  }

  /** Drops the worker unused. */
  dispose(): void {
    this.worker?.terminate()
    this.worker = undefined
  }
}
