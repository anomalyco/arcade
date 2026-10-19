import type { SessionView } from "../../shared/session"
import type { DiscoverySettings } from "./settings"

/**
 * The camera leans in at a workbench so the mat and the corkboard can be read, and at a page left in a building: it
 * eases closer and towards the bench or page while the survivor faces it or is trying something on its mat, and
 * eases back out when they turn away.
 */
export class BenchLean {
  blend = 0
  private x = 0
  private y = 0

  step(view: SessionView, settings: DiscoverySettings, dt: number): { blend: number; dx: number; dy: number } {
    const p = view.player
    let bench: { x: number; y: number } | null = null
    if (settings.discoveryBenchFocus && !p.vehicleId) {
      // A page lying in a building gets the same closer look, so its drawing can be made out before reading it.
      if (view.prompt?.kind === "bench" || view.prompt?.kind === "page") bench = { x: view.prompt.worldX, y: view.prompt.worldY }
      else if (p.channel?.kind === "craft" && p.channel.targetId.startsWith("bench:")) bench = { x: p.channel.x, y: p.channel.y }
    }
    if (bench) {
      this.x = bench.x
      this.y = bench.y
    }
    this.blend += ((bench ? 1 : 0) - this.blend) * (1 - Math.exp(-Math.max(0, dt) * 3.5))
    if (this.blend < 1e-3) this.blend = 0
    const k = this.blend * settings.discoveryBenchCentre
    return { blend: this.blend, dx: (this.x - p.x) * k, dy: (this.y - p.y) * k }
  }
}
