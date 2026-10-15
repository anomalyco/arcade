import { defineStation } from "./define"

const presets = [
  ["rain", "Rain"],
  ["drizzle", "Drizzle"],
  ["storm", "Storm"],
  ["fog", "Fog"],
  ["snow", "Snow"],
  ["clear", "Clear"],
] as const

export default defineStation({
  id: "weather",
  title: "Weather",
  summary: "Rain, fog, snow and wind from the shared weather kit, shown in the Looks room so you can judge them against each look.",
  order: 30,
  prop: "cloud",
  color: 0x6f9fd8,
  status: "review",
  demo: { kind: "section", section: "weather", setup: [{ command: "weather.preset", args: { preset: "rain" } }] },
  defaultVariant: "rain",
  grid: "weather",
  variants: presets.map(([id, label]) => ({ id, label, setup: [{ command: "weather.preset", args: { preset: id } }] })),
  board: { feature: "AR-19" },
  metrics: [
    { label: "Outbreak street GPU across the six presets, 1000×680 (command-buffer envelope)", value: "2.5–2.7 ms", source: "perf/weather-lab.json" },
    { label: "Lab Weather GPU across the six presets, 1280×800 (command-buffer envelope)", value: "1.1–1.4 ms", source: "perf/weather-lab.json" },
    { label: "Outbreak 3456×1894 bench-outbreak p95 (Rain / Storm, street & interior)", value: "18.0–18.4 ms", source: "games/outbreak/scripts/bench-outbreak.ts" },
  ],
  paths: ["packages/kit/weather", "packages/kit/fx/weather.ts", "packages/kit/lab/weather.ts", "games/outbreak/src/weather.ts"],
  branches: ["weather-*"],
  links: [{ label: "Outbreak street", href: "/arcade/outbreak/?peaceful=1&seed=7" }],
})
