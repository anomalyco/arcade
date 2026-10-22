import type { Renderer } from "../gpu/renderer"
import type { ScenePass } from "../gpu/pass-graph"
import { loadSkyAssets, type SkyAssets } from "./assets"
import type { SkySettings } from "./settings"
import type { SkyFrame, SkyPass } from "./pass"

/** Lazy adoption boundary. Today does not fetch assets or compile the physical sky. */
export function attachSky(renderer: Renderer, settings: SkySettings, today?: ScenePass) {
  let pass: SkyPass | undefined, assets: SkyAssets | undefined
  let loading: Promise<void> | undefined, disposed = false, failure: unknown
  let last: SkyFrame | undefined
  const active = () => !disposed && settings.skyMode === "physical" && !!pass
  const slot: ScenePass = { draw(encoder) { if (active()) pass!.draw(encoder); else today?.draw(encoder) } }
  renderer.addPass("sky", slot)
  async function load(): Promise<void> {
    if (disposed || settings.skyMode === "today" || pass) return
    if (loading) return loading
    loading = (async () => {
      const [{ SkyPass }, loaded] = await Promise.all([import("./pass"), loadSkyAssets(renderer.passContext.device)])
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
