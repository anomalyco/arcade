import { defineStation } from "./define"

/** Opens the Audio section on one shared-library sound. Selecting a variant never plays it: Audition does. */
const sound = (id: string, label: string, note: string, librarySound: string) => ({
  id,
  label,
  note,
  setup: [
    { command: "scene.set-param", args: { key: "source", value: "library" } },
    { command: "scene.set-param", args: { key: "librarySound", value: librarySound } },
    { command: "scene.set-param", args: { key: "libraryVariant", value: 0 } },
  ],
})

export default defineStation({
  id: "audio",
  title: "Audio",
  summary: "The Lab mixer, each game's sound engine and the shared sound library. Nothing plays until you audition it.",
  order: 90,
  prop: "speaker",
  color: 0xe25d8f,
  status: "live",
  demo: {
    kind: "section",
    section: "audio",
    setup: [
      { command: "scene.set-param", args: { key: "source", value: "library" } },
      { command: "scene.set-param", args: { key: "librarySound", value: "zombie.groan.idle" } },
    ],
  },
  variants: [
    sound("zombies", "Zombies", "Idle groans: six variants, seeded round-robin with pitch jitter", "zombie.groan.idle"),
    sound("alert", "Zombie alert", "The snarl when a zombie notices you", "zombie.alert"),
    sound("pistol", "Pistol", "Shot, then reload and dry fire in the same group", "gun.pistol.shot"),
    sound("footsteps", "Footsteps", "Wood, concrete and grass, walk and run, sliced on the transient", "foot.wood.walk"),
    sound("doors", "Doors", "Open, close, locked rattle and the zombie bash", "door.wood.open"),
    sound("barricade", "Barricade", "Hammering a plank onto a window", "barricade.hammer"),
    sound("night", "Night bed", "The suburb at night: a seamless loop", "ambience.night.suburb"),
  ],
  defaultVariant: "zombies",
  board: { feature: "AR-20" },
  metrics: [
    { label: "Library", value: "36 ids · 124 files", source: "packages/kit/audio/library-files.ts" },
    { label: "Library size", value: "1.33 MB Ogg Opus", source: "scripts/sfx/library.ts build" },
  ],
  paths: ["packages/kit/audio", "games/lab/src/sound", "games/outbreak/src/audio", "docs/audio-design.md", "docs/sfx-library.md"],
  branches: ["sfx-library"],
})
