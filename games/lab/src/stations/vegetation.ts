import { defineStation } from "./define"

const presets = [
  ["tree", "oak", "Oak"],
  ["tree", "maple", "Maple"],
  ["tree", "pine", "Pine"],
  ["tree", "birch", "Birch"],
  ["bush", "hedge", "Clipped hedge"],
  ["bush", "overgrown", "Overgrown shrub"],
  ["bush", "hydrangea", "Hydrangea"],
  ["grass", "lawn", "Lawn"],
  ["grass", "overgrown", "Overgrown lawn"],
  ["grass", "weeds", "Weeds / dead grass"],
] as const

export default defineStation({
  id: "vegetation",
  title: "Vegetation",
  summary: "Trees, bushes and grass from the shared foliage kit, each with its own tool, presets and test room. Walkers bend the grass and bushes the way the player and zombies do in Outbreak.",
  order: 40,
  prop: "tree",
  color: 0x5fae4e,
  status: "live",
  demo: {
    kind: "section",
    section: "foliage",
    setup: [
      { command: "foliage.preset", args: { tool: "tree", kind: "tree", preset: "oak", lighting: "night", look: "sodium_70s", cameraMode: "game" } },
      { command: "foliage.set", args: { walker: true, flashlight: true } },
    ],
  },
  defaultVariant: "tree-oak",
  variants: [
    ...presets.map(([kind, id, label]) => ({
      id: `${kind}-${id}`,
      label,
      note: `${kind[0]!.toUpperCase()}${kind.slice(1)} tool`,
      setup: [{ command: "foliage.preset", args: { tool: kind, kind, preset: id } }],
    })),
    { id: "lot", label: "Outbreak lot", note: "All three looks around a bungalow", setup: [{ command: "foliage.preset", args: { tool: "lot" } }] },
    { id: "day", label: "Day", note: "Neutral daylight, no grade", setup: [{ command: "foliage.preset", args: { lighting: "day", look: "current" } }] },
    { id: "noir", label: "Night · Noir", setup: [{ command: "foliage.preset", args: { lighting: "night", look: "noir" } }] },
    { id: "close", label: "Close inspect", setup: [{ command: "foliage.preset", args: { cameraMode: "close" } }] },
  ],
  grid: "foliage",
  board: { feature: "AR-23" },
  metrics: [
    { label: "Outbreak street GPU, main → vegetation (Mac Studio, Metal, alternating runs)", value: "17.09 → 17.69 ms", source: "perf/outbreak-vegetation-paired.json" },
    { label: "Outbreak interior GPU, main → vegetation", value: "17.44 → 18.09 ms", source: "perf/outbreak-vegetation-paired.json" },
    { label: "Outbreak static vertices", value: "294k → 321k", source: "games/outbreak/tests/cutaway.test.ts" },
    { label: "Pixels changed by actor bending at the same tick (strength 0 vs 1)", value: "8,205", source: "packages/kit/lab/prove-foliage.ts (grass-bend-off/on)" },
  ],
  paths: ["packages/kit/gpu/foliage.ts", "packages/kit/lab/foliage.ts", "games/outbreak/src/architecture.ts"],
  branches: ["vegetation-*", "foliage-*"],
  links: [
    { label: "Outbreak yard at night", href: "/arcade/outbreak/?peaceful=1&seed=7" },
    { label: "PR #41", href: "https://github.com/anomalyco/arcade/pull/41" },
  ],
})
