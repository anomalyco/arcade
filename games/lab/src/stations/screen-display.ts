import { SCREEN_PRESETS } from "@arcade/kit/gpu/screen/settings"
import { PROGRAMME_OPTIONS } from "@arcade/kit/gpu/screen/programme"
import { defineStation, type StationVariant } from "./define"

// The base debug world's screen bench: midnight inside the house, lamps off, a CRT on a workbench the only light.
const set = (key: string, value: string | number | boolean) => ({ command: "world.set", args: { key, value } })
const display = (id: string): StationVariant => ({ id: `display-${id}`, group: "Display", label: SCREEN_PRESETS[id]!.label, setup: [set("screen.preset", id)] })

export default defineStation({
  id: "screen-display",
  title: "CRT and screen light",
  summary:
    "The shared screen display (`@arcade/kit/gpu/screen`) on a bench in a dark room: scanline beams, phosphor mask, convergence, afterglow, curved glass with the room in it, power and degauss, an LCD variant. The picture's live average lights the room, with a failing tube and a caged bulb to switch on.",
  order: 8.6,
  color: 0x7fd6ff,
  status: "review",
  demo: { kind: "section", section: "world", setup: [{ command: "world.preset", args: { preset: "screen-bench" } }] },
  defaultVariant: ["display-tv", "show-show", "light-screen", "signal-clean"],
  variants: [
    ...Object.keys(SCREEN_PRESETS).map(display),
    ...PROGRAMME_OPTIONS.map((p): StationVariant => ({ id: `show-${p.value}`, group: "Showing", label: p.label, setup: [set("programme", p.value)] })),
    { id: "light-screen", group: "Room light", label: "Screen only", note: "The picture is the only light: walls, bench and floor follow its colour and its cuts.", setup: [set("tube", false), set("bulb", false)] },
    { id: "light-tube", group: "Room light", label: "Failing tube", note: "A fluorescent batten over the bench that stutters and drops out (the shared flicker), as a long downward area light.", setup: [set("tube", true), set("bulb", false)] },
    { id: "light-bulb", group: "Room light", label: "Caged bulb", note: "A bare tungsten bulb in a wire cage on the wall: a small hot point with crisp shadows and a tired circuit's wander.", setup: [set("tube", false), set("bulb", true)] },
    { id: "signal-clean", group: "Signal", label: "Clean", setup: [set("screen.vhs", false), set("screen.snow", 0)] },
    { id: "signal-vhs", group: "Signal", label: "Played from tape", note: "Through the kit's VHS camera filter first: tracking, head-switch tearing, chroma bleed.", setup: [set("screen.vhs", true), set("screen.snow", 0)] },
    { id: "signal-weak", group: "Signal", label: "Weak aerial", note: "The picture sinking into snow.", setup: [set("screen.vhs", false), set("screen.snow", 0.55)] },
  ],
  metrics: [
    { label: "Light readback", value: "4×3 mip, 3-slot ring, 1–3 frames late, no stall", source: "packages/kit/gpu/screen/display.ts" },
    { label: "Panel light vs area integral", value: "within 0.2%", source: "packages/kit/gpu/screen/screen.test.ts" },
  ],
  paths: ["packages/kit/gpu/screen", "packages/kit/gpu/lights/panel.ts", "packages/kit/gpu/lights/practicals.ts", "packages/kit/lab/world/scene.ts"],
  branches: ["kit-crt"],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    right: [{ widget: "controls", groups: ["Screen"], title: "Screen" }],
    dock: [{ widget: "variants" }],
  },
})
