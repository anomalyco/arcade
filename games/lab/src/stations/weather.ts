import { defineStation } from "./define"

export default defineStation({
  id: "weather",
  title: "Weather",
  summary: "Rain, fog and wind from the shared weather kit, shown in the Looks room so you can judge them against each look.",
  order: 30,
  prop: "cloud",
  color: 0x6f9fd8,
  status: "in-progress",
  statusNote: "weather-lab branch",
  demo: { kind: "section", section: "weather" },
  board: { feature: "AR-19" },
  paths: ["packages/kit/weather.ts", "packages/kit/fx/weather.ts", "packages/kit/lab/weather.ts"],
  branches: ["weather-*"],
  links: [{ label: "Outbreak street", href: "/arcade/outbreak/?peaceful=1&seed=7" }],
})
