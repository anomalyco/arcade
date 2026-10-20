// Off-main-thread forest generation. textures.ts runs two of these in parallel as soon as forest.ts is imported:
//   "textures":  foliage + undergrowth atlases with mip chains, then later
//   "impostors": the far-tree atlas, painted from the tree models the main thread built meanwhile
//   "trees":     tree placement (this worker bakes its own copy of the terrain height grids)
import { foliageAtlas, mipChain, paintImpostors, undergrowthAtlas, type ImpostorInput, type Level } from "./paint"
import { placeTrees, type Trees } from "./placement"

export type Request =
  | { kind: "textures" }
  | { kind: "impostors"; impostors: ImpostorInput[] }
  | { kind: "trees"; seed: number; density: number }
export type Response =
  | { kind: "textures"; foliage: Level[]; undergrowth: Level[]; ms: number }
  | { kind: "impostors"; impostors: Level[]; ms: number }
  | { kind: "trees"; trees: Trees; ms: number }
  | { kind: "error"; error: string }

const post = (msg: Response, transfer: ArrayBuffer[] = []) => (self as unknown as Worker).postMessage(msg, transfer)
const buffers = (l: Level[]) => l.map((x) => x.data.buffer as ArrayBuffer)
let foliage: OffscreenCanvas | null = null

self.onmessage = (e: MessageEvent<Request>) => {
  const t0 = performance.now()
  const req = e.data
  try {
    if (req.kind === "textures") {
      foliage = foliageAtlas()
      const f = mipChain(foliage)
      const u = mipChain(undergrowthAtlas())
      post({ kind: "textures", foliage: f, undergrowth: u, ms: performance.now() - t0 }, [...buffers(f), ...buffers(u)])
    } else if (req.kind === "impostors") {
      const i = mipChain(paintImpostors(req.impostors, foliage ?? foliageAtlas()))
      post({ kind: "impostors", impostors: i, ms: performance.now() - t0 }, buffers(i))
    } else {
      const trees = placeTrees({ density: req.density, seed: req.seed })
      const arrays = [trees.x, trees.y, trees.z, trees.scale, trees.yaw, trees.tint, trees.phase, trees.variant, trees.grid.cellStart, trees.grid.order]
      post({ kind: "trees", trees, ms: performance.now() - t0 }, arrays.map((a) => a.buffer as ArrayBuffer))
    }
  } catch (err) {
    post({ kind: "error", error: String(err instanceof Error ? (err.stack ?? err.message) : err) })
  }
}
