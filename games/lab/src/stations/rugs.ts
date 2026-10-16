import { defineStation } from "./define"

const set = (key: string, value: number | string | boolean) => ({ command: "scene.set-param", args: { key, value } })
const one = (style: string, palette: string) => [set("view", "single"), set("style", style), set("palette", palette)]
const condition = (wear: number, fade: number, stains: number) => [set("wear", wear), set("fade", fade), set("stains", stains)]

export default defineStation({
  id: "rugs",
  title: "Rugs",
  summary:
    "The procedural rug generator Outbreak bakes: Persian medallion, Turkmen gul, kilim, Art Deco, braided oval and 70s shag, with dye palettes, knot pitch, abrash, wear, fade and stains. Randomize draws parameters from the tuning seed; the design seed stays put.",
  order: 71,
  prop: "swatches",
  color: 0x7e2419,
  status: "review",
  demo: { kind: "section", section: "rugs", setup: one("persian", "madder") },
  defaultVariant: ["persian", "as-baked"],
  // Two groups that compose: the rug's style (or all six side by side), and how worn it is.
  variants: [
    { id: "persian", group: "Style", label: "Persian medallion", setup: one("persian", "madder") },
    { id: "turkmen", group: "Style", label: "Turkmen gul", setup: one("turkmen", "tekke") },
    { id: "kilim", group: "Style", label: "Kilim", setup: one("kilim", "kilim") },
    { id: "deco", group: "Style", label: "Art Deco", setup: one("deco", "deco") },
    { id: "braided", group: "Style", label: "Braided oval", setup: one("braided", "braid") },
    { id: "shag", group: "Style", label: "70s shag", setup: one("shag", "shag70s") },
    { id: "gallery", group: "Style", label: "All six styles", setup: [set("view", "gallery")] },
    { id: "as-baked", group: "Wear", label: "As baked", note: "Wear 0.25, fade 0.2, stains 0.1.", setup: condition(0.25, 0.2, 0.1) },
    { id: "worn", group: "Wear", label: "Worn and faded", note: "Wear 0.8, fade 0.6, stains 0.4.", setup: condition(0.8, 0.6, 0.4) },
  ],
  board: { feature: "AR-3" },
  paths: ["packages/kit/textures/rug.ts", "packages/kit/textures/rug-worker.ts", "packages/kit/lab/rugs.ts"],
  branches: ["rugs-interiors"],
  links: [{ label: "Rugs & interiors in Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
