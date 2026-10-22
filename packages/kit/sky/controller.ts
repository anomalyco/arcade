import type { Renderer } from "../gpu/renderer"
import type { ScenePass } from "../gpu/pass-graph"
import type { SkyAssets } from "./assets"
import type { SkySettings } from "./settings"
import type { SkyFrame, SkyPass } from "./pass"
import { loadSkyResources } from "./resources"

/** Lazy adoption boundary. Today does not fetch assets or compile the physical sky. */
export function attachSky(renderer: Renderer, settings: SkySettings, today?: ScenePass) {
  let pass: SkyPass | undefined, assets: SkyAssets | undefined
  let loading: Promise<void> | undefined, disposed = false, failure: unknown
  let last: SkyFrame | undefined
  let previousMode = settings.skyMode
  const active = () => !disposed && settings.skyMode === "physical" && !!pass
  const slot: ScenePass = { draw(encoder) { if (active()) pass!.draw(encoder); else today?.draw(encoder) } }
  renderer.addPass("sky", slot)
  async function load(): Promise<void> {
    if (disposed || settings.skyMode === "today" || pass) return
    if (loading) return loading
    failure = undefined
    loading = (async () => {
      const [{ SkyPass }, loaded] = await loadSkyResources(import("./pass"), import("./assets").then(m => m.acquireSkyAssets(renderer.passContext.device)))
      if (disposed) { loaded.dispose(); return }
      assets = loaded
      try { pass = new SkyPass(renderer.passContext, loaded, settings) }
      catch (error) { loaded.dispose(); assets = undefined; throw error }
      if (last) pass.update(last)
      renderer.setInfiniteSky(active())
    })().catch(error => { failure = error; throw error }).finally(() => { loading = undefined })
    return loading
  }
  return {
    settings,
    get active() { return active() },
    get error() { return failure },
    load,
    update(frame: SkyFrame): void {
      if (disposed) return
      last = frame
      // Retry on an explicit Today → Physical transition or a direct load() call,
      // rather than starting another network request on every failed frame.
      if (settings.skyMode !== previousMode) { failure = undefined; previousMode = settings.skyMode }
      if (settings.skyMode === "physical" && !pass && !loading && !failure) void load().catch(error => console.error("Sky load failed", error))
      pass?.update(frame)
      renderer.setInfiniteSky(active())
    },
    dispose(): void {
      disposed = true
      renderer.removePass(slot)
      renderer.setInfiniteSky(false)
      pass?.dispose(); assets?.dispose()
    },
  }
}
