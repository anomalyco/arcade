import { defineStation } from "./define"

/** Opens the Audio section on one shared-library sound and renders it offline. Nothing plays until Audition. */
const sound = (id: string, label: string, note: string, librarySound: string) => ({
  id,
  label,
  note,
  setup: [
    { command: "scene.set-param", args: { key: "source", value: "library" } },
    { command: "scene.set-param", args: { key: "librarySound", value: librarySound } },
    { command: "scene.set-param", args: { key: "libraryVariant", value: 0 } },
    // Render offline (silent) so the waveform and spectrogram show the sound before anyone auditions it.
    { command: "scene.set-param", args: { key: "retrigger", value: true } },
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
      { command: "scene.set-param", args: { key: "retrigger", value: true } },
    ],
  },
  variants: [
    sound("zombies", "Zombies", "Idle groans: six variants, seeded round-robin with pitch jitter", "zombie.groan.idle"),
    sound("alert", "Zombie alert", "The snarl when a zombie notices you", "zombie.alert"),
    sound("pistol", "Pistol", "Shot, then reload and dry fire in the same group", "gun.pistol.shot"),
    sound("reload", "Reload parts", "Magazine release, out, in and the slide: each lands on its reload-pose event", "gun.pistol.slide"),
    sound("impacts", "Bullet impacts", "Wood, plaster, brick and concrete, metal and glass, where a missed shot lands", "impact.bullet.concrete"),
    sound("zombie-feet", "Zombie feet", "Stomp, shuffle and drag on wood, concrete and grass; the nearest four step, the rest is the horde", "zombie.foot.drag.concrete"),
    sound("horde", "Horde bed", "Many feet shuffling: rises with the moving crowd near you", "zombie.horde.shuffle"),
    sound("pickups", "Pickups", "One sound per item class: tool, ammo, medical, part, key, battery, scrap, plank", "pickup.tool"),
    sound("crafting", "Crafting", "Medical, tinkering and woodwork loops while a craft runs, and their finishing sounds", "craft.tinker.loop"),
    sound("bench", "Workbench", "Deposits and the generator at night", "bench.research.loop"),
    sound("footsteps", "Footsteps", "Wood, concrete and grass, walk and run, sliced on the transient", "foot.wood.walk"),
    sound("doors", "Doors", "Open, close, locked rattle and the zombie bash", "door.wood.open"),
    sound("barricade", "Barricade", "Hammering a plank onto a window", "barricade.hammer"),
    sound("night", "Night bed", "The suburb at night: a seamless loop", "ambience.night.suburb"),
  ],
  defaultVariant: "zombies",
  board: { feature: "AR-20" },
  metrics: [
    { label: "Library", value: "80 ids · 253 files", source: "packages/kit/audio/library-files.ts" },
    { label: "Library size", value: "2.12 MB Ogg Opus", source: "scripts/sfx/library.ts build" },
  ],
  paths: ["packages/kit/audio", "games/lab/src/sound", "games/outbreak/src/audio", "docs/audio-design.md", "docs/sfx-library.md"],
  branches: ["sfx-library", "sfx-gaps"],
})
