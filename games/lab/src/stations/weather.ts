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
  status: "in-progress",
  demo: { kind: "section", section: "weather", setup: [{ command: "weather.preset", args: { preset: "rain" } }] },
  defaultVariant: "rain",
  variants: presets.map(([id, label]) => ({ id, label, setup: [{ command: "weather.preset", args: { preset: id } }] })),
  board: { feature: "AR-19" },
  metrics: [{ label: "Outbreak street GPU across the six presets, 1000×680; the differences are inside the spread", value: "3.0–3.9 ms", source: "perf/weather-lab.json" }],
  paths: ["packages/kit/weather", "packages/kit/fx/weather.ts", "packages/kit/lab/weather.ts", "games/outbreak/src/weather.ts"],
  branches: ["weather-*"],
  links: [{ label: "Outbreak street", href: "/arcade/outbreak/?peaceful=1&seed=7" }],
})
