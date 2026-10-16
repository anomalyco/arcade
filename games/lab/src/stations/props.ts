import { defineStation } from "./define"

const set = (key: string, value: number | string | boolean) => ({ command: "scene.set-param", args: { key, value } })
const one = (prop: string) => [set("view", "single"), set("prop", prop)]

export default defineStation({
  id: "props",
  title: "Furniture & props",
  summary:
    "The shared RE-mansion furniture and prop library (@arcade/kit/props): product shots from the image model, turned into textured meshes by Microsoft TRELLIS.2 on the Mac Studio, then cleaned, scaled to metres, decimated to two LODs and colour/AO-baked in Blender. Outbreak's start house can be furnished with them behind Backquote › Props.",
  order: 73,
  prop: "house",
  color: 0x5a2a22,
  status: "review",
  demo: { kind: "section", section: "props", setup: [set("view", "grid")] },
  defaultVariant: ["grid", "lod0"],
  variants: [
    { id: "grid", group: "View", label: "Every prop", setup: [set("view", "grid")] },
    { id: "sofa", group: "View", label: "Chesterfield sofa", setup: one("chesterfield-sofa") },
    { id: "bookcase", group: "View", label: "Bookcase", setup: one("bookcase") },
    { id: "clock", group: "View", label: "Grandfather clock", setup: one("grandfather-clock") },
    { id: "stove", group: "View", label: "Enamel stove", setup: one("stove") },
    { id: "lod0", group: "Detail", label: "LOD0 (close)", setup: [set("lod", 0)] },
    { id: "lod1", group: "Detail", label: "LOD1 (far)", setup: [set("lod", 1)] },
    { id: "baked", group: "Detail", label: "Baked colour only", note: "No Lab light: the colour and AO a game receives.", setup: [set("shading", 1)] },
  ],
  paths: ["packages/kit/props", "packages/kit/lab/props.ts", "scripts/props", "games/outbreak/src/props"],
  links: [
    { label: "Outbreak start house (Backquote › Props)", href: "/arcade/outbreak/?seed=7" },
  ],
  layout: {
    left: [{ widget: "status" }],
    dock: [{ widget: "variants" }],
  },
})
