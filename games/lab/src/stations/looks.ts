import { defineStation } from "./define"

const looks = [
  ["current", "Current"],
  ["noir", "Noir"],
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
  variants: looks.map(([id, label]) => ({ id, label, setup: [{ command: "look.preset", args: { preset: id } }] })),
  grid: "looks",
  board: { feature: "AR-12" },
  metrics: [
    { label: "ΔE2000 to the 70s sodium paint-over, Outbreak street and interior", value: "13.8 → 6.7", source: "docs/integration.md (release 5)" },
    { label: "debug-room GPU, Current look, 1280×800", value: "1.02 ms", source: "perf/looks.json" },
  ],
  paths: ["packages/kit/gpu/look.ts", "packages/kit/gpu/look-shaders.ts", "packages/kit/lab/looks.ts"],
  branches: ["looks", "outbreak-noir"],
})
