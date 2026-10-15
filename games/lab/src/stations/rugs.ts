import { defineStation } from "./define"

export default defineStation({
  id: "rugs",
  title: "Rugs & RE Interiors",
  summary:
    "High-resolution GPU-baked procedural Persian, Turkmen, Kilim, Art Deco, Braided Oval & Shag rugs (1024–2048 px + mips & pile normal) and Resident Evil house interiors.",
  order: 72,
  prop: "swatches",
  color: 0x8c2d24,
  status: "review",
  demo: {
    kind: "section",
    section: "rugs",
    setup: [{ command: "rug.preset", args: { style: "persian_medallion", palette: "madder_indigo", swatch: "parlor", compare: 1 } }],
  },
  defaultVariant: "persian",
  variants: [
    {
      id: "persian",
      label: "Persian Medallion",
      setup: [{ command: "rug.preset", args: { style: "persian_medallion", palette: "madder_indigo", swatch: "parlor", compare: 1 } }],
    },
    {
      id: "ab-boxes",
      label: "Split vs Concentric Boxes",
      setup: [{ command: "rug.preset", args: { style: "persian_medallion", palette: "madder_indigo", swatch: "flat", compare: 2 } }],
    },
    {
      id: "turkmen",
      label: "Turkmen Bokhara Gul",
      setup: [{ command: "rug.preset", args: { style: "turkmen_gul", palette: "turkmen_oxblood", swatch: "parlor", compare: 1 } }],
    },
    {
      id: "kilim",
      label: "Anatolian Kilim",
      setup: [{ command: "rug.preset", args: { style: "kilim_geometric", palette: "saffron_walnut", swatch: "parlor", compare: 1 } }],
    },
    {
      id: "deco",
      label: "Spencer Art Deco",
      setup: [{ command: "rug.preset", args: { style: "art_deco", palette: "emerald_crimson", swatch: "parlor", compare: 1 } }],
    },
    {
      id: "gallery",
      label: "6-Tradition Gallery",
      setup: [{ command: "rug.preset", args: { swatch: "gallery", compare: 1 } }],
    },
  ],
  board: { feature: "AR-3" },
  paths: [
    "packages/kit/rugs.ts",
    "packages/kit/lab/rugs.ts",
    "games/outbreak/src/re-interiors.ts",
    "games/outbreak/src/architecture.ts",
  ],
  branches: ["rugs-interiors"],
  links: [{ label: "Outbreak RE Houses", href: "/arcade/outbreak/?peaceful=1&seed=7" }],
})
