import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

// BARBARA at the camera lab's fixed night spot (`?lab=looks`: 70 m north of camp, your torch on, two friends searching
// with theirs, the Lab panel open on Looks & Triggers). Pick a Look; the Triggers fire lightning, thunder, a gust, the
// creature or a distant sound now. Click the woods to walk and look.
const page = "/arcade/barbara/?lab=looks"
const set = (key: string, value: number | boolean | string): StationCommand => ({ command: "scene.set-param", args: { key, value } })

const look = (id: string, label: string, note: string): StationVariant => ({ id, group: "Look", label, note, setup: [set("woods.look", id)] })

const variants: StationVariant[] = [
  look("today", "Today", "BARBARA as shipped: the catalogue night sky with no moon, mist in the hollows, torches and camp lights."),
  look("moonlit", "Clear moonlit", "A full moon low in the south-west: moonlight and its shadows through the canopy, clearer air."),
  look("newmoon", "New moon, pitch black", "No moon, a faint sky, the camp's power out and the ridge beacon dark: only torches."),
  look("groundfog", "Ground fog", "A low fog bank in every hollow, glowing only where a beam or the camp lights it."),
  look("stormcoming", "Storm coming", "Overcast. Lightning along the horizon kilometres off, thunder long after; the wind rising, no rain yet."),
  look("downpour", "Downpour", "Heavy rain in every beam and window, drips under the trees, lightning close by, everything soaked."),
]

export default defineStation({
  id: "barbara-looks",
  title: "BARBARA looks",
  summary:
    "Curated looks for BARBARA's night (Today, Clear moonlit, New moon, Ground fog, Storm coming, Downpour) with a real storm: lightning that lights the forest from where it struck, the eye darker after, rain in the beams, thunder after its real travel. Triggers in the panel.",
  order: 201,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: ["today"],
  variants: variants.map((v) => ({ ...v, url: page })),
  metrics: [
    { label: "Downpour at High", value: "about +0.6–1.4 ms GPU", source: "games/barbara/scripts/looks-proof.ts" },
    { label: "Downpour at Low", value: "about +0.3–0.4 ms GPU", source: "games/barbara/scripts/looks-proof.ts" },
  ],
  paths: ["games/barbara/src/looks.ts", "games/barbara/src/knobs.ts", "packages/kit/forest/storm.ts", "packages/kit/weather/storm.ts", "games/barbara/src/audio/storm.ts"],
  branches: ["barbara-looks"],
  links: [{ label: "Play Barbara", href: "/arcade/barbara/" }],
  layout: {
    right: [{ widget: "controls", groups: ["Looks & Triggers"], title: "Looks & Triggers" }],
    dock: [{ widget: "variants" }],
  },
})
