import { defineStation } from "./define"

const set = (key: string, value: string | number | boolean) => ({ command: "scene.set-param", args: { key, value } })
const trigger = { command: "effect.trigger", args: { seed: 7 } }

export default defineStation({
  id: "road-flare",
  title: "Road flare",
  summary:
    "A 1990s fusee from the shared FX kit: strontium red with a pinkish-white core, a sputtering flicker, sparks, dripping slag and a smoke column lit red from below. Struck in the hand, thrown, bouncing and rolling to rest, lighting the street at midnight with the lamps off.",
  order: 8.5,
  prop: "burst",
  color: 0xff2a3a,
  status: "review",
  demo: {
    kind: "section",
    section: "effects",
    setup: [set("backdrop", "world"), set("worldHour", 0), set("worldLook", "current"), set("worldLamps", 0), set("effect", "flare"), set("flareStart", "throw"), set("loop", false), trigger],
  },
  defaultVariant: ["lamps-off", "throw"],
  variants: [
    { id: "lamps-off", group: "Light", label: "Lamps off", note: "Midnight with the street lamps out: the flare is the only light.", setup: [set("worldHour", 0), set("worldLamps", 0)] },
    { id: "lamps-on", group: "Light", label: "Lamps on", note: "Midnight with the street lamps: how red reads beside sodium.", setup: [set("worldHour", 0), set("worldLamps", 1)] },
    { id: "throw", group: "Flare", label: "Strike and throw", note: "Struck in the hand for a beat, lobbed, bouncing and rolling to rest.", setup: [set("effect", "flare"), set("flareStart", "throw"), trigger] },
    { id: "burning", group: "Flare", label: "Burning", note: "Twenty seconds in, lying where it landed.", setup: [set("effect", "flare"), set("flareStart", "burning"), trigger] },
    { id: "gutter", group: "Flare", label: "Guttering out", note: "The last ten seconds: sputtering, warming to orange, then embers.", setup: [set("effect", "flare"), set("flareStart", "gutter"), trigger] },
    { id: "wet", group: "Flare", label: "Wet flare", note: "Twice the sputter, half the sparks.", setup: [set("effect", "flare"), set("flareStart", "burning"), set("flareFlicker", 2), set("flareSparkRate", 12), trigger] },
  ],
  board: { feature: "AR-15" },
  paths: ["packages/kit/fx/flare.ts", "packages/kit/sim/thrown.ts", "packages/kit/fx/particle-renderer.ts", "packages/kit/lab/effects.ts"],
  branches: ["kit-flare", "barbara-flare"],
  layout: {
    right: [{ widget: "controls", groups: ["Flare", "Smoke & sparks"], title: "Road flare" }],
    dock: [{ widget: "variants" }],
  },
})
