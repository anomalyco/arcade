import { defineStation } from "./define"

export default defineStation({
  id: "carrier",
  title: "Carrier",
  summary: "Carrier has no Lab adapters yet, so this station runs the game itself in free camera at 10:30.",
  order: 130,
  prop: "ship",
  color: 0x7c8aa0,
  status: "planned",
  statusNote: "no Lab adapters yet",
  demo: { kind: "page", url: "/arcade/carrier/?seed=7&tod=10.5&free=1" },
  defaultVariant: "morning",
  variants: [
    { id: "morning", label: "10:30", url: "/arcade/carrier/?seed=7&tod=10.5&free=1" },
    { id: "dusk", label: "Dusk", url: "/arcade/carrier/?seed=7&tod=18.5&free=1" },
  ],
  board: { feature: "AR-15" },
  paths: ["games/carrier/src"],
  links: [{ label: "Play Carrier", href: "/arcade/carrier/" }],
})
