/**
 * The forest build off the main thread (`buildForestOffThread`): the world arrives without its height function and
 * stands on the grid sampled on the main thread, so the geometry is byte for byte the main thread's. The models move
 * here and back (the page keeps them to rebuild a regenerated world).
 */
import { buildForest, clampedGridHeight, type BuildOptions, type ForestBuild, type HeightGrid } from "./build"
import type { ForestModels } from "./assets"
import type { ForestWorld } from "../sim/forest-world"

export type BuildRequest = { world: Omit<ForestWorld, "height">; models: ForestModels; opts: BuildOptions; ground: HeightGrid }
export type BuildReply = { build: ForestBuild; models: ForestModels; started: number; ms: number } | { error: string; models: ForestModels }

/** Every model part's vertex buffer, moved rather than copied. */
export function modelTransfers(models: ForestModels): ArrayBuffer[] {
  return [...new Set(Object.values(models).flatMap((parts) => parts.map((p) => p.vertices)))]
}

/** Every buffer the build holds, moved back to the page instead of copied. */
export function buildTransfers(build: ForestBuild): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>([build.water, build.trunks.buffer as ArrayBuffer, build.rocks.buffer as ArrayBuffer, build.field.buffer as ArrayBuffer])
  for (const t of build.templates) for (const m of [t.near, t.far]) if (m) { out.add(m.opaque); out.add(m.masked) }
  for (const c of build.chunks) {
    for (const m of [c.near, c.far]) { out.add(m.opaque); out.add(m.masked) }
    for (const g of c.groups) out.add(g.data.buffer as ArrayBuffer)
  }
  return [...out]
}

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<BuildRequest>) => void) | null; postMessage(m: BuildReply, transfer: Transferable[]): void }
scope.onmessage = ({ data: { world, models, opts, ground } }) => {
  try {
    const t = performance.now()
    const build = buildForest({ ...world, height: clampedGridHeight(ground) }, models, opts, ground)
    const ms = Math.round(performance.now() - t)
    // A template may reuse a model's buffer: each buffer moves once.
    scope.postMessage({ build, models, started: performance.timeOrigin + t, ms }, [...new Set([...buildTransfers(build), ...modelTransfers(models)])])
  } catch (error) {
    scope.postMessage({ error: String((error as Error)?.stack ?? error), models }, modelTransfers(models))
  }
}
