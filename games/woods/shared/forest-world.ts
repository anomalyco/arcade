import type { Tape } from "./sim"
import { TAPE_HEIGHT } from "./sim"
import { terrainHeight, type WoodsWorld } from "./world"

/**
 * The woods as the forest renderer's `ForestWorld` (the look agent's `@arcade/kit/sim/forest-world`, proposed in
 * branch `woods-look`). The types below mirror that file structurally so nothing here conflicts before it merges;
 * once it lands, replace them with `import type { ForestWorld } from "@arcade/kit/sim/forest-world"`.
 * Building/dock yaw is about +y with 0 facing +z (south here, towards the lake); flag yaw is atan2(dz, dx). The dock's
 * x, z is its shore end. String-light points are support posts. x east, z south, metres.
 */
type Vec2 = readonly [number, number]
type Vec3 = readonly [number, number, number]
export type ForestWorld = {
  seed: number
  half: number
  height(x: number, z: number): number
  trees: readonly { x: number; z: number; species: "pine" | "spruce" | "birch" | "snag"; r: number; h: number; lean?: number; leanYaw?: number; seed: number }[]
  rocks: readonly { x: number; z: number; r: number; h: number; yaw: number; seed: number; moss?: number }[]
  logs: readonly { x: number; z: number; yaw: number; length: number; r: number; seed: number }[]
  paths?: readonly { points: readonly Vec2[]; width: number }[]
  clearings?: readonly { x: number; z: number; r: number }[]
  lake?: { x: number; z: number; rx: number; rz: number; level: number }
  camp?: {
    buildings: readonly { kind: "mess-hall" | "cabin" | "shed"; x: number; z: number; yaw: number; w: number; d: number; h: number; lit: number; porch?: boolean }[]
    dock?: { x: number; z: number; yaw: number; length: number; width: number }
    stringLights?: readonly { points: readonly Vec3[]; bulbs: number }[]
    props?: readonly { kind: "canoe" | "bench" | "picnic-table" | "fire-pit" | "flagpole" | "stump"; x: number; z: number; yaw: number }[]
  }
  flags?: readonly { x: number; z: number; y: number; yaw: number; r: number }[]
}

/** Tapes as renderer flags: wrapped round their trunk `TAPE_HEIGHT` above the ground; yaw is `Tape.yaw` (atan2(dz, dx) of the knot), as build.ts reads it. */
export function forestFlags(world: WoodsWorld, tapes: readonly Tape[]): NonNullable<ForestWorld["flags"]> {
  return tapes.map((t) => ({ x: t.x, z: t.z, y: TAPE_HEIGHT, yaw: t.yaw, r: world.trees[t.tree]?.radius ?? 0 }))
}

/** The static world (plus current tapes) in the renderer's shape. Buildings face the lake (+z), so their yaw is 0. */
export function toForestWorld(world: WoodsWorld, tapes: readonly Tape[] = []): ForestWorld {
  const centre = (r: readonly number[]) => ({ x: (r[0]! + r[2]!) / 2, z: (r[1]! + r[3]!) / 2, w: r[2]! - r[0]!, d: r[3]! - r[1]! })
  const buildings = world.buildings.flatMap((b) => {
    if (b.kind !== "cabin" && b.kind !== "mess-hall") return []
    const c = centre(b.rect)
    return [{ kind: b.kind, x: c.x, z: c.z, yaw: 0, w: c.w, d: c.d, h: b.h, lit: b.kind === "mess-hall" ? 1 : 0, porch: b.kind === "cabin" }]
  })
  const dock = world.buildings.find((b) => b.kind === "dock")
  const strings = world.lamps.filter((l) => l.kind === "string")
  return {
    seed: world.params.seed,
    half: world.params.half,
    height: (x, z) => terrainHeight(world.terrain, x, z),
    trees: world.trees.map((t) => ({ x: t.x, z: t.z, species: t.species === "fir" ? "spruce" : t.species, r: t.radius, h: t.height, seed: t.seed })),
    rocks: world.rocks.map((k) => ({ x: k.x, z: k.z, r: Math.max(k.w, k.d) / 2, h: k.h, yaw: k.yaw, seed: k.seed })),
    logs: [],
    paths: [{ points: world.trail.points, width: 1.6 }],
    clearings: [{ x: world.camp.x, z: world.camp.z, r: world.camp.radius }],
    lake: { x: world.lake.x, z: world.lake.z, rx: world.lake.rx, rz: world.lake.rz, level: world.lake.level },
    camp: {
      buildings,
      dock: dock && { x: (dock.rect[0] + dock.rect[2]) / 2, z: dock.rect[1], yaw: 0, length: dock.rect[3] - dock.rect[1], width: dock.rect[2] - dock.rect[0] },
      stringLights: world.stringPosts.length > 1 ? [{ points: world.stringPosts, bulbs: strings.length }] : [],
      props: world.buildings.flatMap((b): NonNullable<NonNullable<ForestWorld["camp"]>["props"]>[number][] => {
        const c = centre(b.rect)
        return b.kind === "canoe" ? [{ kind: "canoe", x: c.x, z: c.z, yaw: 0 }] : b.kind === "table" ? [{ kind: "picnic-table", x: c.x, z: c.z, yaw: Math.PI / 2 }] : []
      }),
    },
    flags: forestFlags(world, tapes),
  }
}
