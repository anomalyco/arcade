import { defineStation } from "./define"

const trees = [
  ["oak", "Oak"],
  ["maple", "Maple"],
  ["birch", "Birch"],
  ["pine", "Pine"],
  ["hydrangea", "Hydrangea"],
] as const

export default defineStation({
  id: "vegetation",
  title: "Vegetation",
  summary: "Trees, bushes and grass from the shared foliage kit on an Outbreak house lot at dusk, the way the game draws them.",
  order: 40,
  prop: "tree",
  color: 0x5fae4e,
  status: "in-progress",
  statusNote: "vegetation-lab branch",
  demo: {
    kind: "section",
    section: "foliage",
    setup: [{ command: "foliage.preset", args: { preset: "oak", stageMode: "lot", lighting: "outbreak_dusk", cameraMode: "close" } }],
  },
  defaultVariant: "oak",
  variants: [
    ...trees.map(([id, label]) => ({ id, label, setup: [{ command: "foliage.preset", args: { preset: id } }] })),
    { id: "game-camera", label: "Game camera", note: "Same lot from Outbreak's camera height", setup: [{ command: "foliage.preset", args: { cameraMode: "game" } }] },
    { id: "night", label: "Night", setup: [{ command: "foliage.preset", args: { lighting: "outbreak_night" } }] },
  ],
  grid: "foliage",
  board: { feature: "AR-12" },
  paths: ["packages/kit/gpu/foliage.ts", "packages/kit/lab/foliage.ts"],
  branches: ["vegetation-*", "foliage-*"],
})
