import { defineStation } from "./define"

const ocean = "/arcade/carrier/water.html?seed=7&waterLook=continuous"
export default defineStation({
  id: "water",
  title: "Water",
  summary: "Ocean wakes and a moonlit forest lake. Drag the boat or log.",
  order: 134,
  status: "in-progress",
  demo: { kind: "page", url: ocean },
  defaultVariant: "ocean",
  variants: [
    { id: "ocean", label: "Ocean", url: ocean },
    { id: "today", label: "Today (ocean)", url: "/arcade/carrier/water.html?seed=7" },
    { id: "lake", label: "Lake (woods-water)", url: "/arcade/woods/?lab=water" },
    { id: "lake-today", label: "Today (lake)", url: "/arcade/woods/?lab=water&waterLook=today" },
  ],
  paths: ["packages/kit/water", "games/carrier/src/render/ocean.ts", "games/carrier/src/boat/water-editor.ts"],
  branches: ["kit-water", "woods-water"],
  links: [{ label: "Carrier", href: "/arcade/carrier/?seed=7&water=continuous&lab=water" }],
})
