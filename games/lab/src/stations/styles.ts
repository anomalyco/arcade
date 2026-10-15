import { STYLE_LIST } from "../styles"
import { defineStation } from "./define"

export default defineStation({
  id: "styles",
  title: "Styles",
  summary:
    "Nine rendering styles (Tiny Pixel, 1-Bit Game Boy, Comic Cel, Papercraft, Ink Hatching, Watercolour, Tactical Breach, Hotline Neon, ASCII Terminal) presenting the exact same Outbreak room combat sim.",
  order: 55,
  prop: "panels",
  color: 0xff7b54,
  status: "in-progress",
  demo: {
    kind: "section",
    section: "styles",
    game: "outbreak",
    setup: [
      { command: "style.preset", args: { style: "tiny-pixel", focus: false } },
      { command: "grid.open", args: { preset: "styles" } },
    ],
  },
  defaultVariant: "tiny-pixel",
  variants: [
    ...STYLE_LIST.map((m, i) => ({
      id: m.id,
      label: m.name,
      note: `${m.tagline} · ${m.scaling.verdict === "scales" ? "Scales to Outbreak" : m.scaling.verdict === "partial" ? "Partial scale" : "Room-only"}`,
      boardOption: String(i + 1),
      setup: [{ command: "style.preset", args: { style: m.id } }],
    })),
    {
      id: "grid-all",
      label: "3×3 Grid (All 9)",
      note: "All 9 styles synchronized on one Outbreak SessionView timeline (press 1–9 to focus)",
      setup: [{ command: "grid.open", args: { preset: "styles" } }],
    },
  ],
  grid: "styles",
  board: { feature: "AR-26", decision: "D-17" },
  metrics: [
    { label: "Style pass GPU across the 9 styles at 1536×1024 (Apple Metal)", value: "0.32–0.71 ms", source: "perf/style-playground.json" },
    { label: "3×3 variation grid (shared Outbreak sim + 9 live style passes)", value: "1.6–1.8 ms", source: "perf/style-playground.json" },
  ],
  paths: ["games/lab/src/styles", "games/lab/src/stations/styles.ts"],
  branches: ["style-playground"],
  links: [
    { label: "Outbreak scenes", href: "/arcade/lab/?station=outbreak" },
    { label: "Looks station", href: "/arcade/lab/?station=looks" },
  ],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }, { widget: "notes" }],
    right: [
      {
        widget: "controls",
        groups: ["Style & Scene", "Style Parameters"],
        title: "Style Knobs",
      },
    ],
    dock: [{ widget: "variants" }, { widget: "compare" }, { widget: "perf" }, { widget: "voice" }],
  },
})
