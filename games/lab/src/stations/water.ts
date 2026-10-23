import { defineStation } from "./define"

const ocean = "/arcade/carrier/water.html?seed=7&waterLook=continuous"
export default defineStation({
  id: "water",
  title: "Water",
  summary: "Ocean waves and surface wakes. Drag the boat or drive it.",
  order: 134,
  status: "in-progress",
  demo: { kind: "page", url: ocean },
  defaultVariant: "ocean",
  variants: [
    { id: "ocean", label: "Ocean", url: ocean },
    { id: "today", label: "Today (ocean)", url: "/arcade/carrier/water.html?seed=7" },
  ],
  paths: ["packages/kit/water", "games/carrier/src/render/ocean.ts", "games/carrier/src/boat/water-editor.ts"],
  branches: ["kit-water"],
  links: [{ label: "Carrier", href: "/arcade/carrier/?seed=7&water=continuous&lab=water" }],
})
