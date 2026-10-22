import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

// The woods game itself at the camera lab's fixed night spot (`?lab=camera` runs `stageCameraLab`: 70 m north of camp,
// your torch on, two friends searching with theirs, the sim running without pointer lock; the `woods.camera.stage`
// command puts you back). Click the woods to walk and look.
const page = "/arcade/woods/?lab=camera"
const set = (key: string, value: number | boolean | string): StationCommand => ({ command: "scene.set-param", args: { key, value } })

// Two groups that compose: a Look (resets every camera setting, then its preset), then one realism effect on top.
const look = (id: string, label: string, note: string): StationVariant => ({ id, group: "Look", label, note, setup: [set("woods.cameraLook", id)] })
const effect = (id: string, label: string, note: string, ...setup: StationCommand[]): StationVariant => ({ id: `fx-${id}`, group: "Effect", label, note, setup })

const variants: StationVariant[] = [
  look("eyes", "Eyes (today)", "Today's look: the forest renderer's own camera, nothing added."),
  look("bodycam", "Body cam, night", "Chest mount, 140° fisheye, rolling shutter, auto-gain hunting, a starved encoder, a friend's LED torch banding."),
  look("nightshot", "Camcorder NightShot", "A '90s Sony in infrared (Blair Witch): green monochrome, the IR lamp's hotspot, blooming whites, crushed blacks, eyeshine."),
  look("phone", "Phone night mode", "Temporal denoise that ghosts on motion, sharpening halos, noise growing in the dark."),
  look("vhs", "VHS camcorder", "An '80s VHS camcorder with gain-up in the dark and lazy autofocus."),
  effect("look", "From the look", "Only what the Look sets."),
  effect("compression", "Compression starvation", "Macroblocks and banding in dark gradients, worse while the camera moves; stale blocks drag; quality pumps each second.", set("woods.artifacts.compression", true)),
  effect("focus", "Autofocus hunting", "Sweep the beam from near to far: focus waits, starts the wrong way, swings past and settles.", set("woods.artifacts.focusHunt", true)),
  effect("gain", "Sensor gain in the dark", "Grain, chroma blotches and denoise smear that grow as the scene darkens.", set("woods.artifacts.sensorGain", true)),
  effect("pwm", "LED PWM banding", "The friends' LED torches blink at a few hundred hertz; the rolling shutter turns that into bands.", set("woods.artifacts.pwm", true)),
  effect("flare", "Lens flare from torches", "When a friend's beam sweeps across you: aperture ghosts and a six-blade starburst.", set("woods.artifacts.flare", true)),
  effect("dirt", "Lens dirt", "Smudges, specks and a thumb print, lit only by bright light.", set("woods.artifacts.dirt", true)),
  effect("condensation", "Condensation", "Fog creeping in from the lens edges.", set("woods.artifacts.condensation", true)),
  effect("eyeshine", "Eyeshine", "A deer's eyes about 16 m out in your beam.", set("woods.eyeshine", true), set("woods.eyeshineNow", true)),
]

export default defineStation({
  id: "woods-camera",
  title: "Woods camera lab",
  summary:
    "The night forest through different cameras: Eyes (today), a night body cam, a '90s NightShot camcorder, a phone's night mode and VHS, plus eight realism effects each on its own switch (Camera look in the panel). Fixed spot, your torch and two friends' on.",
  order: 200,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: ["eyes", "fx-look"],
  variants: variants.map((v) => ({ ...v, url: page })),
  metrics: [
    { label: "Effects, GPU each (mini, paired)", value: "+0.09–0.34 ms", source: "~/code/home/artifacts/woods-2026-10-21/camera-lab/index.html" },
    { label: "Looks, GPU (mini, paired)", value: "+0.22–0.61 ms", source: "~/code/home/artifacts/woods-2026-10-21/camera-lab/index.html" },
    { label: "Eyes vs no final pass", value: "42.5 dB PSNR (grain only)", source: "games/woods/scripts/camera-lab.ts" },
  ],
  paths: ["games/woods/src/camera-look.ts", "games/woods/src/eyeshine.ts", "packages/kit/gpu/post/camera-artifacts.ts", "packages/kit/gpu/post/final-chain.ts"],
  branches: ["woods-camera"],
  links: [{ label: "Play the woods", href: "/arcade/woods/" }],
  layout: {
    right: [{ widget: "controls", groups: ["Camera look"], title: "Camera look" }],
    dock: [{ widget: "variants" }],
  },
})
