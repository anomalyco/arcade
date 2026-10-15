import { defineStation } from "./define"

/** The Noir grade before the v2 pass, applied over today's preset for a before/after. */
const NOIR_V1 = {
  contrast: 1.22,
  toe: 0.24,
  blackCrush: 0.012,
  saturation: 0.04,
  temperature: -0.08,
  shadowTintR: 0.9,
  shadowTintG: 0.96,
  shadowTintB: 1.06,
  highlightTintB: 1.02,
  selectiveColor: 1.24,
  grain: 0.38,
}

const looks = [
  ["current", "Current"],
  ["noir", "Noir v2 (after)"],
  ["painterly", "Painterly"],
  ["cinematic_dusk", "Dusk"],
  ["sodium_70s", "70s sodium"],
  ["cozy_golden_hour", "Golden hour"],
] as const

export default defineStation({
  id: "looks",
  title: "Looks",
  summary: "The shared look presets (grade, fog, bloom, outline) on the debug room. Every game's post pass reads these settings.",
  order: 50,
  prop: "panels",
  color: 0xc77dff,
  status: "in-progress",
  demo: { kind: "section", section: "looks", setup: [{ command: "look.preset", args: { preset: "noir" } }] },
  defaultVariant: "noir",
  variants: [
    ...looks.map(([id, label]) => ({ id, label, setup: [{ command: "look.preset", args: { preset: id } }] })),
    {
      id: "noir-v1",
      label: "Noir v1 (before)",
      note: "PR #40's grade: near-monochrome, cold, crushed toe, film grain, hard selective colour",
      setup: [
        { command: "look.preset", args: { preset: "noir" } },
        ...Object.entries(NOIR_V1).map(([key, value]) => ({ command: "look.set", args: { key, value } })),
      ],
    },
  ],
  grid: "looks",
  board: { feature: "AR-12" },
  metrics: [
    { label: "Noir selective-colour edge, 10–90% width across the flashlight at 5 m (Outbreak street, aimed down the road)", value: "10.5° → 39°", source: "games/outbreak/scripts/noir-profile.py" },
    { label: "ΔE2000 to the 70s sodium paint-over, Outbreak street and interior", value: "13.8 → 6.7", source: "docs/integration.md (release 5)" },
    { label: "debug-room GPU, Current look, 1280×800", value: "1.02 ms", source: "perf/looks.json" },
  ],
  paths: ["packages/kit/gpu/look.ts", "packages/kit/gpu/look-shaders.ts", "packages/kit/lab/looks.ts"],
  branches: ["looks", "outbreak-noir", "noir-v2"],
})
