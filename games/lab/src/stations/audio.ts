import { defineStation } from "./define"

export default defineStation({
  id: "audio",
  title: "Audio",
  summary: "The Lab mixer and each game's sound engine. Nothing plays until you audition it.",
  order: 90,
  prop: "speaker",
  color: 0xe25d8f,
  status: "live",
  demo: { kind: "section", section: "audio" },
  board: { feature: "AR-20" },
  paths: ["packages/kit/audio", "games/lab/src/sound", "docs/audio-design.md"],
})
