import { LIBRARY_FILES, type LibraryFile } from "./library-files"
import type { CueRecipe, MixCategory, SampleAssetMeta, StealPolicy } from "./types"

/**
 * The shared sound library: every game sound keyed by a semantic id (`gun.pistol.shot`, `door.wood.open`), each with
 * several loudness-normalised variations, a licence per file and the mix defaults a game starts from. Files live once
 * in `packages/kit/audio/sfx/` (or stay where an existing game already keeps them) and reach each game through the
 * `audioAssets({ sfx })` Vite plugin, which emits only the ids that game asks for under its own `audio-assets/sfx/`.
 *
 * Generation and curation are offline (`scripts/sfx/library.ts`); `library-files.ts` is its generated output.
 */
export type SfxGroup =
  | "gun" | "melee" | "foot" | "door" | "window" | "glass" | "barricade" | "search" | "pickup" | "flashlight"
  | "zombie" | "body" | "ambience" | "ui" | "impact" | "craft" | "bench" | "item" | "pack" | "lure" | "generator" | "radio" | "vehicle"
  | "flare" | "dog" | "creature" | "crowd" | "cooking" | "bow"

export type SfxSurface = "concrete" | "grass" | "wood"

/** How the offline pipeline makes candidates for an id. Absent for ids that reuse existing project files. */
export type SfxGeneration = {
  prompt: string
  /** Seconds requested from the generator (0.5–30). */
  duration: number
  /** Candidates to generate; the curator keeps `variants` of them. */
  candidates: number
  /** Seamless loop (ambience beds). */
  loop?: boolean
  /** Slice a recording of repeated events (footsteps) into single events instead of keeping whole takes. */
  slice?: { minGapSeconds: number; maxSeconds: number }
  /** Prompt influence, 0..1 (API default 0.3). */
  influence?: number
}

export type SfxSpec = {
  id: string
  label: string
  group: SfxGroup
  bus: MixCategory
  /** Variants the library keeps. */
  variants: number
  loop?: boolean
  /** Loudness the files are normalised to: momentary-max LUFS for one-shots, integrated LUFS for loops. */
  target: number
  /** Linear mix gain at playback, on top of the normalised file. */
  gain: number
  /** ± fraction of playback rate (pitch and duration together) per trigger. */
  pitchJitter: number
  /** ± fraction of gain per trigger. */
  gainJitter: number
  cooldown?: number
  maxVoices?: number
  /** Voice priority (0..100). Higher-priority voices steal lower-priority ones and are never stolen by them. */
  priority?: number
  /** Brief non-UI bus ducking when this cue fires at high intensity (e.g. gunshots, explosions). */
  duck?: { seconds: number; depth: number }
  /** What happens when the id or the runtime is out of voices (default: steal the oldest). Crowd sounds drop. */
  steal?: StealPolicy
  /** Full level inside `ref` metres, silent beyond `max`. */
  range: { ref: number; max: number }
  /** Reverb send. */
  wet: number
  /** Games that play this id. The Lab browses all of them. */
  usedBy: readonly string[]
  /** Accepted duration range for curated variants, seconds. */
  durationRange: readonly [number, number]
  generate?: SfxGeneration
  /** Existing project files used as-is (normalised at playback through each variant's gain). */
  reuse?: readonly { path: string; license: string; provenance: string }[]
}

export type SfxEntry = SfxSpec & { files: readonly LibraryFile[] }

const NO_SPEECH = "No music, no speech, no voice-over."
const step = (surface: string, gait: "walk" | "run") =>
  `One adult in sturdy shoes ${gait === "walk" ? "walking at a steady relaxed pace" : "running fast"} on ${surface}, recorded close, dry, every footstep distinct and evenly spaced. ${NO_SPEECH}`

const OUTBREAK = ["outbreak"] as const
const BRAWL = ["brawl"] as const
const ARCHERS = ["archers"] as const

const SURFACE_PHRASE: Record<SfxSurface, string> = { concrete: "a gritty concrete sidewalk", grass: "short dry grass and soft earth", wood: "old wooden floorboards inside a house" }

/** Zombie gait sounds: a limper's heavy uneven stomp, a shambler's scuffing shuffle, the long scrape of a dragged foot. */
export type ZombieStep = "step" | "shuffle" | "drag"
const ZOMBIE_STEP: Record<ZombieStep, { label: string; prompt: (surface: string) => string; gap: number; max: number; target: number; range: readonly [number, number] }> = {
  step: {
    label: "stomp", gap: 0.45, max: 0.4, target: -28, range: [0.12, 0.45],
    prompt: s => `One injured person limping slowly and unevenly on ${s}: heavy flat-footed thudding steps in torn shoes with a long pause between steps, recorded close and dry, each step distinct. ${NO_SPEECH}`,
  },
  shuffle: {
    label: "shuffle", gap: 0.4, max: 0.45, target: -30, range: [0.12, 0.5],
    prompt: s => `One person shuffling slowly on ${s}: worn shoes scuffing and sliding briefly with each step, dull and soft, recorded close and dry, each scuff distinct with a pause between. ${NO_SPEECH}`,
  },
  drag: {
    label: "drag", gap: 0.7, max: 0.75, target: -30, range: [0.2, 0.8],
    prompt: s => `One person slowly dragging an injured foot across ${s}: a long rough scraping drag of a shoe, then a pause, repeated, recorded close and dry, each drag distinct. ${NO_SPEECH}`,
  },
}

/** A bullet striking a surface: what the shot's ray stops on, or a pane or car body it passes through. */
export type ImpactSurface = "wood" | "plaster" | "concrete" | "metal" | "glass"
const IMPACT: Record<ImpactSurface, { label: string; prompt: string; target: number; range: readonly [number, number]; duration: number; candidates?: number }> = {
  // The first wood prompt ("…striking a wooden house wall…") returned four near-silent takes of six.
  wood: { label: "wood", target: -24.5, range: [0.08, 0.9], duration: 0.8, candidates: 12, prompt: `A single bullet hitting a thick wooden plank wall, close: a loud sharp crack and splintering thud, short dry tail. One impact only. ${NO_SPEECH}` },
  plaster: { label: "plaster", target: -22, range: [0.08, 0.9], duration: 0.8, prompt: `A single bullet hitting an interior plaster wall: a dull hard puff and thud, then crumbling plaster dust trickling, short. One impact only. ${NO_SPEECH}` },
  concrete: { label: "brick and concrete", target: -20, range: [0.08, 0.9], duration: 0.8, prompt: `A single bullet hitting a brick and concrete wall: a sharp hard chipping crack with a short ricochet whine and grit falling. One impact only. ${NO_SPEECH}` },
  metal: { label: "metal", target: -19, range: [0.08, 1.1], duration: 0.9, prompt: `A single bullet striking a car's sheet-metal body panel: a loud bright metallic clang and ping with a short ringing tail. One impact only. ${NO_SPEECH}` },
  glass: { label: "glass", target: -19, range: [0.2, 1.4], duration: 1.1, prompt: `A single bullet punching through a window pane: a sharp glass crack and a small spray of shards tinkling down. One impact only. ${NO_SPEECH}` },
}

/** Melee impact material classes. */
export type MeleeHitMaterial = "wood" | "metal" | "blade"
const MELEE_HIT: Record<MeleeHitMaterial, { label: string; prompt: string; maxRange: number }> = {
  wood: {
    label: "Wooden club hits flesh",
    maxRange: 24,
    prompt: `A single heavy wooden baseball bat hitting flesh and bone: a solid hardwood crack with a wet meaty body thud, close and dry. One impact only. ${NO_SPEECH}`,
  },
  metal: {
    label: "Metal tool hits flesh",
    maxRange: 26,
    prompt: `A single heavy steel crowbar or iron pipe striking flesh and bone: a dull metallic ring and crunch with a heavy wet body thud, close and dry. One impact only. ${NO_SPEECH}`,
  },
  blade: {
    label: "Blade slashes flesh",
    maxRange: 22,
    prompt: `A single sharp machete or axe cleaving into flesh: a fast wet slicing hack and deep meaty chop, close and dry. One impact only. ${NO_SPEECH}`,
  },
}

/** Item classes a pickup sounds like. Ammo and generic items predate this table. */
export type PickupClass = "tool" | "medical" | "part" | "key" | "battery" | "scrap" | "plank"
const PICKUP: Record<PickupClass, { label: string; prompt: string; target: number; duration: number }> = {
  tool: { label: "tool", target: -22, duration: 0.8, prompt: `Picking up a heavy steel crowbar from a wooden floor: a short metallic scrape and clank, then a hand gripping it. ${NO_SPEECH}` },
  medical: { label: "medical", target: -23, duration: 0.7, prompt: `Picking up a small plastic first aid kit: the plastic case rattles, pills shake inside, a soft fabric rustle. ${NO_SPEECH}` },
  part: { label: "part", target: -21, duration: 0.9, prompt: `Lifting a heavy metal toolbox off a shelf: tools clank and rattle inside, the handle and latch jingle. ${NO_SPEECH}` },
  key: { label: "key", target: -25, duration: 0.6, prompt: `Picking up a small ring of metal house keys: one short bright jingle. ${NO_SPEECH}` },
  battery: { label: "battery", target: -25, duration: 0.6, prompt: `Picking up a few AA batteries: small dry cylindrical clicks as they knock together in a hand. ${NO_SPEECH}` },
  scrap: { label: "scrap", target: -23, duration: 0.7, prompt: `Scooping up a handful of loose nails and small scrap metal: quick metallic clinking and rattling. ${NO_SPEECH}` },
  plank: { label: "plank", target: -23, duration: 0.8, prompt: `Picking up a wooden plank from the floor: a hollow wooden knock and short scrape as it is lifted. ${NO_SPEECH}` },
}

/** Crafting kinds: every recipe sounds like one of these while it is made and when it is finished. */
export type CraftKind = "medical" | "tinker" | "wood"
const CRAFT: Record<CraftKind, { label: string; loop: string; done: string }> = {
  medical: {
    label: "medical",
    loop: `Close foley of hands making bandages: tearing strips of cloth, unrolling gauze, medical tape ripping, a bottle of alcohol sloshing, busy and continuous. ${NO_SPEECH}`,
    done: `Finishing a bandage: one final firm rip of medical tape and a pat on the cloth. Short. ${NO_SPEECH}`,
  },
  tinker: {
    label: "tinkering",
    loop: `Close foley of tinkering on a workbench: small metal parts and wires handled, a screwdriver turning, tiny clicks and rattles, busy and continuous. ${NO_SPEECH}`,
    done: `Finishing a small gadget: a last screw tightened and a plastic case snapping shut with a satisfying click. Short. ${NO_SPEECH}`,
  },
  wood: {
    label: "woodwork",
    loop: `Close foley of hammering nails into a wooden board: steady light hammer taps, wood creaking, loose nails rattling, continuous. ${NO_SPEECH}`,
    done: `Finishing a spiked club: one last heavy hammer blow driving a nail home into wood, ringing briefly. Short. ${NO_SPEECH}`,
  },
}

export const SFX_SPECS: readonly SfxSpec[] = [
  // Weapons
  {
    id: "gun.pistol.shot", label: "Pistol shot", group: "gun", bus: "weapon", variants: 4, target: -19, gain: 1.15, pitchJitter: 0.05, gainJitter: 0.08,
    maxVoices: 4, priority: 92, duck: { seconds: 0.14, depth: 0.72 }, range: { ref: 4, max: 90 }, wet: 0.3, usedBy: OUTBREAK, durationRange: [0.35, 1.6],
    generate: { prompt: `A single 9mm pistol gunshot, close, dry, sharp crack with a punchy low body and short tail. One shot only. No music, no voice.`, duration: 1.5, candidates: 12, influence: 0.5 },
  },
  {
    // Whole-reload clip, superseded in Outbreak by the four parts below timed to the reload pose.
    id: "gun.pistol.reload", label: "Pistol reload (whole)", group: "gun", bus: "weapon", variants: 3, target: -22, gain: 0.8, pitchJitter: 0.03, gainJitter: 0.06,
    maxVoices: 2, range: { ref: 2, max: 14 }, wet: 0.12, usedBy: [], durationRange: [0.6, 1.6],
    generate: { prompt: `Pistol reload foley, close and dry: magazine released and pulled out, fresh magazine slapped in, slide racked forward with a metallic snap. ${NO_SPEECH}`, duration: 1.5, candidates: 4, influence: 0.5 },
  },
  {
    id: "gun.dry-fire", label: "Dry fire", group: "gun", bus: "weapon", variants: 3, target: -24, gain: 0.8, pitchJitter: 0.04, gainJitter: 0.06,
    cooldown: 0.12, maxVoices: 2, range: { ref: 2, max: 10 }, wet: 0.06, usedBy: OUTBREAK, durationRange: [0.06, 0.5],
    generate: { prompt: `Empty pistol dry fire: one crisp small metallic trigger and hammer click, nothing else, very close and dry. ${NO_SPEECH}`, duration: 0.5, candidates: 4, influence: 0.6 },
  },
  {
    id: "gun.casing", label: "Shell casing", group: "gun", bus: "foley", variants: 3, target: -24, gain: 0.6, pitchJitter: 0.08, gainJitter: 0.15,
    maxVoices: 3, range: { ref: 1.5, max: 10 }, wet: 0.05, usedBy: OUTBREAK, durationRange: [0.15, 0.9],
    generate: { prompt: `A single small brass pistol shell casing dropping onto concrete, two or three tiny bright metallic tinks as it bounces. ${NO_SPEECH}`, duration: 0.8, candidates: 4, influence: 0.55 },
  },
  // Reload in parts, each played on its own event in the reload pose (magazine release, out, in, slide).
  {
    id: "gun.pistol.mag-release", label: "Magazine release", group: "gun", bus: "weapon", variants: 3, target: -26, gain: 0.8, pitchJitter: 0.04, gainJitter: 0.06,
    maxVoices: 2, range: { ref: 1.5, max: 10 }, wet: 0.05, usedBy: OUTBREAK, durationRange: [0.03, 0.5],
    generate: { prompt: `A pistol's magazine release button pressed: one small crisp metallic click, very close and dry. One click only. ${NO_SPEECH}`, duration: 0.5, candidates: 4, influence: 0.6 },
  },
  {
    id: "gun.pistol.mag-out", label: "Magazine out", group: "gun", bus: "weapon", variants: 3, target: -25, gain: 0.8, pitchJitter: 0.04, gainJitter: 0.06,
    maxVoices: 2, range: { ref: 1.5, max: 12 }, wet: 0.06, usedBy: OUTBREAK, durationRange: [0.1, 0.8],
    generate: { prompt: `An empty pistol magazine sliding out of the grip: a short metallic scrape and rattle as it drops free into a hand, close and dry. ${NO_SPEECH}`, duration: 0.7, candidates: 4, influence: 0.55 },
  },
  {
    id: "gun.pistol.mag-in", label: "Magazine in", group: "gun", bus: "weapon", variants: 3, target: -22, gain: 0.85, pitchJitter: 0.03, gainJitter: 0.06,
    maxVoices: 2, range: { ref: 1.5, max: 14 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [0.08, 0.7],
    generate: { prompt: `A loaded pistol magazine pushed into the grip and seated: a short sliding scrape then one firm solid metallic click, close and dry. Nothing else. ${NO_SPEECH}`, duration: 0.6, candidates: 4, influence: 0.6 },
  },
  {
    id: "gun.pistol.slide", label: "Slide racked", group: "gun", bus: "weapon", variants: 3, target: -21, gain: 0.85, pitchJitter: 0.03, gainJitter: 0.06,
    maxVoices: 2, range: { ref: 1.5, max: 16 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [0.1, 0.7],
    generate: { prompt: `A pistol slide racked once: pulled back with a metallic scrape and released, snapping forward with a sharp heavy metallic clack, close and dry. One rack only. ${NO_SPEECH}`, duration: 0.6, candidates: 4, influence: 0.6 },
  },

  // Bullet impacts by surface. Flesh is `zombie.hit`.
  ...(Object.keys(IMPACT) as ImpactSurface[]).map((surface): SfxSpec => ({
    id: `impact.bullet.${surface}`, label: `Bullet hits ${IMPACT[surface].label}`, group: "impact", bus: "impact", variants: 4, target: IMPACT[surface].target, gain: 0.85,
    pitchJitter: 0.07, gainJitter: 0.1, maxVoices: 3, range: { ref: 2, max: 30 }, wet: 0.15, usedBy: OUTBREAK, durationRange: IMPACT[surface].range,
    generate: { prompt: IMPACT[surface].prompt, duration: IMPACT[surface].duration, candidates: IMPACT[surface].candidates ?? 6, influence: 0.55 },
  })),
  {
    id: "melee.shove", label: "Shove", group: "melee", bus: "foley", variants: 3, target: -20, gain: 0.85, pitchJitter: 0.06, gainJitter: 0.1,
    maxVoices: 2, range: { ref: 2, max: 14 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [0.2, 0.9],
    generate: { prompt: `A hard two-handed shove against a person's chest: quick jacket rustle and whoosh, then a dull heavy body thud. ${NO_SPEECH}`, duration: 0.8, candidates: 4, influence: 0.5 },
  },
  {
    id: "melee.swing.light", label: "Melee swing (light)", group: "melee", bus: "weapon", variants: 3, target: -22, gain: 0.85, pitchJitter: 0.06, gainJitter: 0.1,
    maxVoices: 3, range: { ref: 2, max: 14 }, wet: 0.06, usedBy: OUTBREAK, durationRange: [0.12, 0.7],
    generate: { prompt: `A single fast melee weapon swing cutting through the air: a sharp crisp whoosh and jacket sleeve snap, close and dry. One swing only. ${NO_SPEECH}`, duration: 0.6, candidates: 4, influence: 0.55 },
  },
  {
    id: "melee.swing.heavy", label: "Melee swing (heavy)", group: "melee", bus: "weapon", variants: 3, target: -20, gain: 0.9, pitchJitter: 0.05, gainJitter: 0.1,
    maxVoices: 3, range: { ref: 2, max: 16 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [0.18, 0.9],
    generate: { prompt: `A single heavy two-handed baseball bat or axe swung hard through the air: a deep forceful low whoosh with a fabric rustle, close and dry. One swing only. ${NO_SPEECH}`, duration: 0.8, candidates: 7, influence: 0.55 },
  },
  ...(Object.keys(MELEE_HIT) as MeleeHitMaterial[]).map((mat): SfxSpec => ({
    id: `melee.hit.${mat}`, label: MELEE_HIT[mat].label, group: "melee", bus: "impact", variants: 3, target: -18, gain: 0.95,
    pitchJitter: 0.06, gainJitter: 0.1, maxVoices: 3, range: { ref: 2.5, max: MELEE_HIT[mat].maxRange }, wet: 0.12, usedBy: OUTBREAK, durationRange: [0.1, 0.95],
    generate: { prompt: MELEE_HIT[mat].prompt, duration: 0.8, candidates: 5, influence: 0.55 },
  })),
  {
    id: "melee.break", label: "Melee weapon breaks", group: "melee", bus: "impact", variants: 2, target: -18, gain: 0.95, pitchJitter: 0.05, gainJitter: 0.08,
    maxVoices: 2, range: { ref: 2.5, max: 22 }, wet: 0.14, usedBy: OUTBREAK, durationRange: [0.25, 1.3],
    generate: { prompt: `A worn wooden and metal melee weapon snapping and breaking apart on impact: a sharp splintering wood crack and broken metal pieces clattering to the floor, close and dry. ${NO_SPEECH}`, duration: 1.1, candidates: 4, influence: 0.55 },
  },

  // Footsteps, sliced from recordings of steady walking and running
  ...(["concrete", "grass", "wood"] as const).flatMap(surface => (["walk", "run"] as const).map((gait): SfxSpec => ({
    id: `foot.${surface}.${gait}`, label: `Footstep ${surface} ${gait}`, group: "foot", bus: "foley", variants: 6, target: gait === "walk" ? -27 : -25,
    gain: gait === "walk" ? 0.42 : 0.58, pitchJitter: 0.06, gainJitter: 0.12, maxVoices: 5, priority: 35, range: { ref: 1.5, max: gait === "walk" ? 12 : 18 }, wet: 0.05, usedBy: OUTBREAK,
    durationRange: [0.12, 0.45],
    generate: {
      prompt: step({ concrete: "a concrete sidewalk", grass: "short dry grass and soft earth", wood: "old wooden floorboards inside a house" }[surface], gait),
      duration: 6, candidates: 2, influence: 0.45, slice: { minGapSeconds: gait === "walk" ? 0.32 : 0.2, maxSeconds: gait === "walk" ? 0.42 : 0.3 },
    },
  }))),

  // Doors, windows, barricades
  {
    id: "door.wood.open", label: "Wooden door opens", group: "door", bus: "foley", variants: 3, target: -19, gain: 0.9, pitchJitter: 0.04, gainJitter: 0.08,
    range: { ref: 2, max: 22 }, wet: 0.15, usedBy: OUTBREAK, durationRange: [0.4, 1.5],
    generate: { prompt: `An old wooden house door opening: latch clicks, short dry hinge creak as it swings. Close perspective. ${NO_SPEECH}`, duration: 1.2, candidates: 4, influence: 0.5 },
  },
  {
    id: "door.wood.close", label: "Wooden door closes", group: "door", bus: "foley", variants: 3, target: -21, gain: 0.9, pitchJitter: 0.04, gainJitter: 0.08,
    range: { ref: 2, max: 22 }, wet: 0.15, usedBy: OUTBREAK, durationRange: [0.3, 1.3],
    generate: { prompt: `An old wooden house door pushed shut: brief swing, solid wooden thud and the latch clicking into place. ${NO_SPEECH}`, duration: 1, candidates: 4, influence: 0.5 },
  },
  {
    id: "door.locked", label: "Locked door rattle", group: "door", bus: "foley", variants: 3, target: -23, gain: 0.85, pitchJitter: 0.04, gainJitter: 0.08,
    cooldown: 0.4, range: { ref: 2, max: 16 }, wet: 0.1, usedBy: OUTBREAK, durationRange: [0.3, 1.2],
    generate: { prompt: `A locked door: round metal doorknob turned and jiggled hard twice, the latch rattles against the frame but does not open. ${NO_SPEECH}`, duration: 1, candidates: 4, influence: 0.5 },
  },
  {
    id: "door.bash", label: "Zombie bashes door", group: "door", bus: "impact", variants: 4, target: -20, gain: 0.9, pitchJitter: 0.06, gainJitter: 0.12,
    cooldown: 0.25, maxVoices: 3, range: { ref: 3, max: 40 }, wet: 0.25, usedBy: OUTBREAK, durationRange: [0.25, 1.3],
    generate: { prompt: `Fists pounding once on a closed wooden door from the other side: a heavy dull thud, the door shaking in its frame and rattling. ${NO_SPEECH}`, duration: 1.2, candidates: 5, influence: 0.5 },
  },
  {
    id: "window.slide", label: "Sash window slides", group: "window", bus: "foley", variants: 3, target: -20, gain: 0.85, pitchJitter: 0.05, gainJitter: 0.08,
    range: { ref: 2, max: 18 }, wet: 0.12, usedBy: OUTBREAK, durationRange: [0.4, 1.4],
    generate: { prompt: `An old wooden sash window sliding open in its frame: wood-on-wood friction, a short squeak, a soft knock at the end. ${NO_SPEECH}`, duration: 1.2, candidates: 4, influence: 0.5 },
  },
  {
    id: "glass.break", label: "Window glass breaks", group: "glass", bus: "impact", variants: 2, target: -16, gain: 0.9, pitchJitter: 0.05, gainJitter: 0.08,
    range: { ref: 3, max: 45 }, wet: 0.25, usedBy: OUTBREAK, durationRange: [0.5, 1.8],
    generate: { prompt: `A house window pane smashed: sharp glass shatter followed by shards tinkling onto a wooden floor. ${NO_SPEECH}`, duration: 1.6, candidates: 3, influence: 0.5 },
  },
  {
    id: "barricade.hammer", label: "Hammering a plank", group: "barricade", bus: "foley", variants: 4, target: -18, gain: 0.9, pitchJitter: 0.05, gainJitter: 0.1,
    cooldown: 0.2, maxVoices: 2, range: { ref: 3, max: 30 }, wet: 0.2, usedBy: OUTBREAK, durationRange: [0.4, 1.6],
    generate: { prompt: `Boarding up a window: a hammer driving a nail through a wooden plank, three quick firm hammer blows, wood resonating. ${NO_SPEECH}`, duration: 1.5, candidates: 5, influence: 0.5 },
  },
  {
    id: "barricade.break", label: "Plank torn off", group: "barricade", bus: "impact", variants: 3, target: -23, gain: 0.9, pitchJitter: 0.05, gainJitter: 0.1,
    range: { ref: 3, max: 35 }, wet: 0.22, usedBy: OUTBREAK, durationRange: [0.3, 1.4],
    generate: { prompt: `A wooden plank splintering and cracking as it is ripped off a boarded-up window, nails screeching out. ${NO_SPEECH}`, duration: 1.2, candidates: 4, influence: 0.5 },
  },

  // Looting
  {
    id: "search.rummage", label: "Rummaging", group: "search", bus: "foley", variants: 3, target: -21, gain: 0.85, pitchJitter: 0.04, gainJitter: 0.1,
    maxVoices: 2, range: { ref: 2, max: 14 }, wet: 0.1, usedBy: OUTBREAK, durationRange: [0.6, 2.2],
    generate: { prompt: `Hands rummaging quickly through a kitchen drawer: cutlery, cardboard boxes and small objects shuffled and pushed aside. ${NO_SPEECH}`, duration: 2, candidates: 4, influence: 0.5 },
  },
  {
    id: "pickup.ammo", label: "Pick up ammo", group: "pickup", bus: "foley", variants: 3, target: -24, gain: 0.85, pitchJitter: 0.05, gainJitter: 0.08,
    maxVoices: 2, range: { ref: 1.5, max: 8 }, wet: 0.05, usedBy: OUTBREAK, durationRange: [0.15, 0.8],
    generate: { prompt: `Picking up a small cardboard box of pistol cartridges: the brass rounds rattle and clink inside the box. ${NO_SPEECH}`, duration: 0.7, candidates: 4, influence: 0.55 },
  },
  {
    id: "pickup.item", label: "Pick up item", group: "pickup", bus: "foley", variants: 3, target: -22, gain: 0.8, pitchJitter: 0.06, gainJitter: 0.08,
    maxVoices: 2, range: { ref: 1.5, max: 8 }, wet: 0.05, usedBy: OUTBREAK, durationRange: [0.12, 0.8],
    generate: { prompt: `Grabbing a small object and stuffing it into a canvas backpack: quick fabric rustle and a soft zip tug. ${NO_SPEECH}`, duration: 0.6, candidates: 4, influence: 0.5 },
  },
  ...(Object.keys(PICKUP) as PickupClass[]).map((kind): SfxSpec => ({
    id: `pickup.${kind}`, label: `Pick up ${PICKUP[kind].label}`, group: "pickup", bus: "foley", variants: 3, target: PICKUP[kind].target, gain: 0.85,
    pitchJitter: 0.05, gainJitter: 0.08, maxVoices: 2, range: { ref: 1.5, max: 8 }, wet: 0.05, usedBy: OUTBREAK, durationRange: [0.12, 1.0],
    generate: { prompt: PICKUP[kind].prompt, duration: PICKUP[kind].duration, candidates: 4, influence: 0.55 },
  })),
  {
    id: "item.drop", label: "Drop an item", group: "item", bus: "foley", variants: 2, target: -27, gain: 1, pitchJitter: 0.06, gainJitter: 0.1,
    maxVoices: 2, range: { ref: 1.5, max: 10 }, wet: 0.06, usedBy: OUTBREAK, durationRange: [0.1, 0.8],
    generate: { prompt: `A small bundle of supplies dropped onto a floor: one dull soft thud with a little rattle. Short. ${NO_SPEECH}`, duration: 0.6, candidates: 4, influence: 0.55 },
  },
  {
    id: "pack.open", label: "Open the pack", group: "pack", bus: "ui", variants: 2, target: -26, gain: 0.7, pitchJitter: 0.04, gainJitter: 0.06,
    cooldown: 0.15, maxVoices: 1, range: { ref: 0, max: 0 }, wet: 0, usedBy: OUTBREAK, durationRange: [0.15, 0.9],
    generate: { prompt: `Opening a canvas backpack: one quick zipper pulled open and a fabric flap rustle. Short, close and dry. ${NO_SPEECH}`, duration: 0.7, candidates: 4, influence: 0.55 },
  },
  {
    id: "pack.close", label: "Close the pack", group: "pack", bus: "ui", variants: 2, target: -27, gain: 0.7, pitchJitter: 0.04, gainJitter: 0.06,
    cooldown: 0.15, maxVoices: 1, range: { ref: 0, max: 0 }, wet: 0, usedBy: OUTBREAK, durationRange: [0.15, 0.9],
    generate: { prompt: `Closing a canvas backpack: one quick zipper pulled shut and a soft pat on the fabric. Short, close and dry. ${NO_SPEECH}`, duration: 0.7, candidates: 4, influence: 0.55 },
  },
  {
    id: "ui.ping", label: "Squad ping", group: "ui", bus: "ui", variants: 2, target: -24, gain: 0.7, pitchJitter: 0.02, gainJitter: 0.04,
    cooldown: 0.2, maxVoices: 2, range: { ref: 0, max: 0 }, wet: 0, usedBy: OUTBREAK, durationRange: [0.1, 0.9],
    generate: { prompt: `A soft clean interface ping for marking a spot: one short bright two-tone chime, gentle, dry, no long tail. ${NO_SPEECH}`, duration: 0.6, candidates: 4, influence: 0.6 },
  },
  {
    id: "flashlight.battery", label: "Flashlight battery swap", group: "flashlight", bus: "foley", variants: 2, target: -26, gain: 0.8, pitchJitter: 0.04, gainJitter: 0.06,
    cooldown: 0.3, maxVoices: 1, range: { ref: 1.5, max: 8 }, wet: 0.04, usedBy: OUTBREAK, durationRange: [0.3, 1.5],
    generate: { prompt: `Swapping a flashlight battery: the tail cap unscrewed, an old battery sliding out, a fresh one dropped in and the cap screwed tight with a click. ${NO_SPEECH}`, duration: 1.2, candidates: 4, influence: 0.5 },
  },

  // Crafting, research and the workbench
  ...(Object.keys(CRAFT) as CraftKind[]).flatMap((kind): SfxSpec[] => [
    {
      id: `craft.${kind}.loop`, label: `Crafting (${CRAFT[kind].label})`, group: "craft", bus: "foley", variants: 1, loop: true, target: -26, gain: 0.85, pitchJitter: 0, gainJitter: 0,
      maxVoices: 2, range: { ref: 1.5, max: 12 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [3, 7],
      generate: { prompt: CRAFT[kind].loop, duration: 6, candidates: 2, loop: true, influence: 0.45 },
    },
    {
      id: `craft.${kind}.done`, label: `Crafted (${CRAFT[kind].label})`, group: "craft", bus: "foley", variants: 2, target: -22, gain: 0.85, pitchJitter: 0.04, gainJitter: 0.06,
      maxVoices: 2, range: { ref: 1.5, max: 12 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [0.15, 1.2],
      generate: { prompt: CRAFT[kind].done, duration: 0.8, candidates: 4, influence: 0.55 },
    },
  ]),
  {
    id: "bench.research.loop", label: "Researching at the bench", group: "bench", bus: "foley", variants: 1, loop: true, target: -27, gain: 0.85, pitchJitter: 0, gainJitter: 0,
    maxVoices: 2, range: { ref: 1.5, max: 10 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [3, 7],
    generate: { prompt: `Close foley of someone studying at a wooden workbench: a pencil scribbling notes on paper, notebook pages turning, small parts turned over in the hands, continuous. ${NO_SPEECH}`, duration: 6, candidates: 2, loop: true, influence: 0.45 },
  },
  {
    id: "bench.research.done", label: "Recipe learned", group: "bench", bus: "foley", variants: 2, target: -22, gain: 0.85, pitchJitter: 0.03, gainJitter: 0.05,
    maxVoices: 1, range: { ref: 1.5, max: 10 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [0.15, 1.2],
    generate: { prompt: `A notebook snapped shut with a firm paper thump, then a pencil set down on a wooden table. Short. ${NO_SPEECH}`, duration: 0.8, candidates: 4, influence: 0.55 },
  },
  {
    id: "bench.deposit", label: "Deposit at the bench", group: "bench", bus: "foley", variants: 3, target: -21, gain: 0.85, pitchJitter: 0.04, gainJitter: 0.08,
    cooldown: 0.25, maxVoices: 2, range: { ref: 2, max: 14 }, wet: 0.1, usedBy: OUTBREAK, durationRange: [0.3, 1.5],
    generate: { prompt: `Unloading supplies onto a wooden workbench: planks, scrap metal and a bottle set down together with a clattering thump. ${NO_SPEECH}`, duration: 1.2, candidates: 4, influence: 0.5 },
  },
  {
    id: "generator.loop", label: "Generator running", group: "generator", bus: "foley", variants: 1, loop: true, target: -26, gain: 0.8, pitchJitter: 0, gainJitter: 0,
    maxVoices: 2, range: { ref: 3, max: 24 }, wet: 0.12, usedBy: OUTBREAK, durationRange: [3, 7],
    generate: { prompt: `A small portable petrol generator running steadily: a chugging single-cylinder engine with a low electrical hum, constant. ${NO_SPEECH}`, duration: 6, candidates: 2, loop: true, influence: 0.45 },
  },
  {
    id: "door.pry.loop", label: "Prying a door", group: "door", bus: "foley", variants: 1, loop: true, target: -24, gain: 0.85, pitchJitter: 0, gainJitter: 0,
    maxVoices: 2, range: { ref: 2, max: 22 }, wet: 0.15, usedBy: OUTBREAK, durationRange: [3, 7],
    generate: { prompt: `A crowbar prying at a locked wooden door: strained wood creaking and groaning, metal scraping against the frame, continuous effort. ${NO_SPEECH}`, duration: 5, candidates: 2, loop: true, influence: 0.45 },
  },
  {
    id: "lure.land", label: "Noisemaker lands", group: "lure", bus: "foley", variants: 2, target: -21, gain: 0.85, pitchJitter: 0.05, gainJitter: 0.08,
    maxVoices: 2, range: { ref: 2, max: 20 }, wet: 0.12, usedBy: OUTBREAK, durationRange: [0.15, 1.0],
    generate: { prompt: `A small tin can noisemaker thrown onto the ground: a metallic clatter and two bounces with tiny parts rattling inside. ${NO_SPEECH}`, duration: 0.8, candidates: 4, influence: 0.55 },
  },
  {
    id: "lure.loop", label: "Noisemaker going off", group: "lure", bus: "foley", variants: 1, loop: true, target: -24, gain: 0.85, pitchJitter: 0, gainJitter: 0,
    maxVoices: 3, range: { ref: 2, max: 30 }, wet: 0.15, usedBy: OUTBREAK, durationRange: [2, 7],
    generate: { prompt: `A cheap battery-powered noisemaker lying on the ground: rapid harsh electronic beeping and a buzzing tin rattle, loud and repetitive, constant. ${NO_SPEECH}`, duration: 4, candidates: 2, loop: true, influence: 0.5 },
  },
  {
    id: "radio.loop", label: "Old radio playing", group: "radio", bus: "foley", variants: 1, loop: true, target: -24, gain: 0.85, pitchJitter: 0, gainJitter: 0,
    maxVoices: 3, range: { ref: 2, max: 30 }, wet: 0.2, usedBy: OUTBREAK, durationRange: [3, 8],
    generate: { prompt: `An old tabletop valve radio in an empty house playing a scratchy 1940s big-band song, thin and tinny through a small speaker, with crackle and hiss of static drifting over it, constant. ${NO_SPEECH}`, duration: 6, candidates: 3, loop: true, influence: 0.5 },
  },
  {
    id: "flashlight.click", label: "Flashlight click", group: "flashlight", bus: "foley", variants: 3, target: -26, gain: 0.8, pitchJitter: 0.05, gainJitter: 0.06,
    cooldown: 0.08, maxVoices: 2, range: { ref: 1.5, max: 6 }, wet: 0.03, usedBy: OUTBREAK, durationRange: [0.03, 0.4],
    generate: { prompt: `A single click of a metal flashlight's rubber tail switch, tiny and crisp, very close. ${NO_SPEECH}`, duration: 0.5, candidates: 4, influence: 0.6 },
  },

  // World interactions (AR-56): road flares and chained dogs
  {
    id: "flare.ignite", label: "Road flare struck", group: "flare", bus: "foley", variants: 2, target: -19, gain: 0.85, pitchJitter: 0.05, gainJitter: 0.08,
    maxVoices: 2, range: { ref: 2, max: 18 }, wet: 0.12, usedBy: OUTBREAK, durationRange: [0.4, 1.8],
    generate: { prompt: `A road safety flare struck and igniting: a scratchy strike, a sharp fizzing whoosh as it catches, then a fierce sputtering hiss. ${NO_SPEECH}`, duration: 1.5, candidates: 4, influence: 0.55 },
  },
  {
    id: "flare.loop", label: "Road flare burning", group: "flare", bus: "foley", variants: 1, loop: true, target: -27, gain: 0.8, pitchJitter: 0, gainJitter: 0,
    maxVoices: 3, range: { ref: 1.5, max: 14 }, wet: 0.1, usedBy: OUTBREAK, durationRange: [2, 7],
    generate: { prompt: `A red road flare burning on asphalt: a steady harsh fizzing hiss with little crackles and sputters, constant. ${NO_SPEECH}`, duration: 4, candidates: 2, loop: true, influence: 0.5 },
  },
  {
    id: "dog.bark", label: "Chained dog barking", group: "dog", bus: "voice", variants: 4, target: -16, gain: 0.95, pitchJitter: 0.06, gainJitter: 0.1,
    cooldown: 0.25, maxVoices: 3, range: { ref: 3, max: 40 }, wet: 0.25, usedBy: OUTBREAK, durationRange: [0.2, 1.2],
    generate: { prompt: `A big guard dog on a chain barking hard at a stranger outdoors at night: two loud aggressive barks, deep and hoarse. ${NO_SPEECH}`, duration: 1, candidates: 6, influence: 0.55 },
  },
  {
    id: "dog.yelp", label: "Dog yelps and goes quiet", group: "dog", bus: "voice", variants: 2, target: -17, gain: 0.9, pitchJitter: 0.05, gainJitter: 0.08,
    maxVoices: 2, range: { ref: 3, max: 30 }, wet: 0.25, usedBy: OUTBREAK, durationRange: [0.3, 1.6],
    generate: { prompt: `A dog yelping sharply in pain, a short whimper, then silence. ${NO_SPEECH}`, duration: 1.2, candidates: 4, influence: 0.5 },
  },
  {
    id: "dog.eat", label: "Dog wolfing food", group: "dog", bus: "foley", variants: 2, target: -22, gain: 0.85, pitchJitter: 0.05, gainJitter: 0.08,
    maxVoices: 2, range: { ref: 1.5, max: 10 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [0.5, 2.2],
    generate: { prompt: `A hungry dog wolfing down food from a tin bowl: eager chomping, licking and the bowl scraping, close up. ${NO_SPEECH}`, duration: 1.8, candidates: 4, influence: 0.5 },
  },

  // Zombies and bodies
  {
    id: "zombie.groan.idle", label: "Zombie idle groan", group: "zombie", bus: "voice", variants: 6, target: -20, gain: 0.8, pitchJitter: 0.08, gainJitter: 0.15,
    maxVoices: 4, range: { ref: 2.5, max: 28 }, wet: 0.2, usedBy: OUTBREAK, durationRange: [0.8, 3],
    generate: { prompt: `A zombie's low idle groan: slow raspy rattling moan from a dry decayed throat, wet and guttural, no words. ${NO_SPEECH}`, duration: 2.5, candidates: 8, influence: 0.5 },
  },
  {
    id: "zombie.alert", label: "Zombie alert", group: "zombie", bus: "voice", variants: 4, target: -16, gain: 0.95, pitchJitter: 0.07, gainJitter: 0.1,
    cooldown: 0.35, maxVoices: 3, range: { ref: 3, max: 34 }, wet: 0.22, usedBy: OUTBREAK, durationRange: [0.5, 1.8],
    generate: { prompt: `A zombie spotting its prey: a sudden sharp hoarse snarl rising into an aggressive shriek, short. No words. ${NO_SPEECH}`, duration: 1.5, candidates: 6, influence: 0.5 },
  },
  {
    id: "zombie.attack", label: "Zombie attack", group: "zombie", bus: "voice", variants: 4, target: -17, gain: 0.95, pitchJitter: 0.06, gainJitter: 0.1,
    cooldown: 0.3, maxVoices: 3, range: { ref: 2.5, max: 24 }, wet: 0.15, usedBy: OUTBREAK, durationRange: [0.3, 1.2],
    generate: { prompt: `A zombie lunging to bite: vicious short growl with a wet snap of teeth, close. No words. ${NO_SPEECH}`, duration: 1, candidates: 5, influence: 0.5 },
  },
  {
    id: "zombie.hit", label: "Bullet hits flesh", group: "zombie", bus: "impact", variants: 4, target: -21, gain: 0.85, pitchJitter: 0.07, gainJitter: 0.1,
    maxVoices: 3, range: { ref: 2, max: 22 }, wet: 0.1, usedBy: OUTBREAK, durationRange: [0.1, 0.7],
    generate: { prompt: `Bullet impact into flesh: one short wet meaty thwack with a dull body thud, close. No music, no voice.`, duration: 0.6, candidates: 6, influence: 0.5 },
  },
  {
    id: "zombie.death", label: "Zombie death", group: "zombie", bus: "voice", variants: 4, target: -18, gain: 0.9, pitchJitter: 0.06, gainJitter: 0.08,
    maxVoices: 3, range: { ref: 2.5, max: 26 }, wet: 0.2, usedBy: OUTBREAK, durationRange: [0.6, 2.2],
    generate: { prompt: `A zombie dying: a final choked gurgling moan that cuts off, then the body collapsing heavily onto the ground. No words. ${NO_SPEECH}`, duration: 2, candidates: 5, influence: 0.5 },
  },
  // Zombie feet: the gait kind per shamble variant and foot, on each surface. Quieter than a survivor's step, and they
  // drop rather than steal when voices run out, so a crowd never pushes out a shot.
  ...(Object.keys(ZOMBIE_STEP) as ZombieStep[]).flatMap(kind => (["concrete", "grass", "wood"] as const).map((surface): SfxSpec => ({
    id: `zombie.foot.${kind}.${surface}`, label: `Zombie ${ZOMBIE_STEP[kind].label} on ${surface}`, group: "zombie", bus: "impact", variants: 5,
    target: ZOMBIE_STEP[kind].target, gain: 0.55, pitchJitter: 0.08, gainJitter: 0.15, maxVoices: 3, priority: 15, steal: "drop", range: { ref: 1.5, max: 14 }, wet: 0.06,
    usedBy: OUTBREAK, durationRange: ZOMBIE_STEP[kind].range,
    generate: {
      prompt: ZOMBIE_STEP[kind].prompt(SURFACE_PHRASE[surface]), duration: 8, candidates: 2, influence: 0.45,
      slice: { minGapSeconds: ZOMBIE_STEP[kind].gap, maxSeconds: ZOMBIE_STEP[kind].max },
    },
  }))),
  {
    id: "zombie.horde.shuffle", label: "Horde shuffling", group: "zombie", bus: "impact", variants: 1, loop: true, target: -28, gain: 0.68, pitchJitter: 0, gainJitter: 0,
    maxVoices: 1, priority: 100, steal: "drop", range: { ref: 0, max: 0 }, wet: 0, usedBy: OUTBREAK, durationRange: [4, 9],
    generate: { prompt: `A crowd of many people shuffling and dragging their feet slowly across a street a few metres away: dense overlapping scuffs and scrapes, low raspy breathing, no words. ${NO_SPEECH}`, duration: 8, candidates: 3, loop: true, influence: 0.45 },
  },
  {
    id: "body.hurt", label: "Survivor hurt", group: "body", bus: "voice", variants: 4, target: -18, gain: 0.9, pitchJitter: 0.04, gainJitter: 0.08,
    cooldown: 0.35, maxVoices: 1, range: { ref: 2, max: 18 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [0.2, 0.9],
    generate: { prompt: `A man taking a hit: one short pained grunt through clenched teeth, close. No words. ${NO_SPEECH}`, duration: 0.7, candidates: 5, influence: 0.5 },
  },
  {
    id: "body.vault", label: "Climb through window", group: "body", bus: "foley", variants: 2, target: -23, gain: 0.8, pitchJitter: 0.04, gainJitter: 0.08,
    maxVoices: 2, range: { ref: 2, max: 14 }, wet: 0.1, usedBy: OUTBREAK, durationRange: [0.5, 1.5],
    generate: { prompt: `A person climbing through a window: hands on a wooden sill, jacket scraping, boots landing on a floor. ${NO_SPEECH}`, duration: 1.2, candidates: 3, influence: 0.5 },
  },
  {
    id: "body.breath.exhausted", label: "Out of breath", group: "body", bus: "voice", variants: 2, target: -24, gain: 0.75, pitchJitter: 0.03, gainJitter: 0.06,
    cooldown: 3, maxVoices: 1, range: { ref: 1.5, max: 8 }, wet: 0.05, usedBy: OUTBREAK, durationRange: [1, 3],
    generate: { prompt: `A man out of breath after sprinting: three heavy ragged pants, close and dry. No words. ${NO_SPEECH}`, duration: 2.5, candidates: 3, influence: 0.5 },
  },

  // Ambience beds (seamless loops)
  {
    id: "ambience.night.suburb", label: "Suburb at night", group: "ambience", bus: "ambience", variants: 1, loop: true, target: -30, gain: 1, pitchJitter: 0, gainJitter: 0,
    range: { ref: 0, max: 0 }, wet: 0, usedBy: OUTBREAK, durationRange: [10, 31],
    generate: { prompt: `Night-time field recording in a suburban backyard: loud dense chorus of crickets and katydids close by, wind gusting through tree leaves, an owl hooting in the distance. Clearly audible, full and rich. No traffic, no people. ${NO_SPEECH}`, duration: 24, candidates: 3, loop: true, influence: 0.4 },
  },
  {
    id: "ambience.day.suburb", label: "Suburb by day", group: "ambience", bus: "ambience", variants: 1, loop: true, target: -30, gain: 1, pitchJitter: 0, gainJitter: 0,
    range: { ref: 0, max: 0 }, wet: 0, usedBy: OUTBREAK, durationRange: [10, 31],
    generate: { prompt: `Daytime field recording in an empty suburban neighbourhood: songbirds chirping in nearby trees, crows calling, a steady breeze rustling leaves. Clearly audible, full and rich. No traffic, no people. ${NO_SPEECH}`, duration: 24, candidates: 3, loop: true, influence: 0.4 },
  },
  {
    id: "ambience.threat", label: "Threat drone", group: "ambience", bus: "ambience", variants: 1, loop: true, target: -32, gain: 1, pitchJitter: 0, gainJitter: 0,
    range: { ref: 0, max: 0 }, wet: 0, usedBy: OUTBREAK, durationRange: [10, 31],
    generate: { prompt: `Ominous low ambient drone for a horror game: deep slow rumbling tone, hollow wind, faint distant moans echoing across empty streets. ${NO_SPEECH}`, duration: 24, candidates: 2, loop: true, influence: 0.4 },
  },

  // Party brawler powers
  {
    id: "creature.bees.swarm", label: "Bee swarm", group: "creature", bus: "foley", variants: 3, target: -24, gain: 0.8, pitchJitter: 0.08, gainJitter: 0.1,
    cooldown: 0.4, maxVoices: 3, steal: "drop", range: { ref: 2, max: 18 }, wet: 0.05, usedBy: BRAWL, durationRange: [0.8, 2.2],
    generate: { prompt: `A small angry swarm of honey bees buzzing close past the microphone: a dense rising and falling buzz with a few bees zipping by, dry, cartoonish and lively. ${NO_SPEECH}`, duration: 1.6, candidates: 4, influence: 0.5 },
  },
  {
    id: "crowd.applause", label: "Studio applause", group: "crowd", bus: "foley", variants: 3, target: -20, gain: 0.85, pitchJitter: 0.03, gainJitter: 0.08,
    cooldown: 0.5, maxVoices: 2, range: { ref: 4, max: 30 }, wet: 0.15, usedBy: BRAWL, durationRange: [1, 2.6],
    generate: { prompt: `A television studio audience bursting into a short enthusiastic round of applause with cheers and whistles, starting loud at once and fading quickly. No words, no music, no voice-over.`, duration: 2.2, candidates: 4, influence: 0.5 },
  },
  {
    id: "cooking.sizzle", label: "Pan sizzle", group: "cooking", bus: "foley", variants: 3, target: -22, gain: 0.8, pitchJitter: 0.06, gainJitter: 0.1,
    cooldown: 0.15, maxVoices: 3, range: { ref: 2, max: 18 }, wet: 0.05, usedBy: [...BRAWL, ...OUTBREAK], durationRange: [0.6, 1.8],
    generate: { prompt: `A hot oily frying pan slapped down on a surface: a sharp burst of loud sizzling hiss and crackling fat that dies away quickly, close and dry. ${NO_SPEECH}`, duration: 1.3, candidates: 4, influence: 0.55 },
  },

  // Arena archery
  {
    id: "bow.draw", label: "Bow draw", group: "bow", bus: "weapon", variants: 3, target: -26, gain: 0.7, pitchJitter: 0.06, gainJitter: 0.1,
    cooldown: 0.08, maxVoices: 4, range: { ref: 2, max: 16 }, wet: 0.05, usedBy: ARCHERS, durationRange: [0.2, 0.8],
    generate: { prompt: `A wooden recurve bow being drawn back quickly: a short taut creak of wood and a stretching bowstring, close and dry. One draw only. ${NO_SPEECH}`, duration: 0.6, candidates: 4, influence: 0.55 },
  },
  {
    id: "bow.release", label: "Bow release", group: "bow", bus: "weapon", variants: 4, target: -20, gain: 0.85, pitchJitter: 0.07, gainJitter: 0.1,
    maxVoices: 4, range: { ref: 3, max: 26 }, wet: 0.08, usedBy: ARCHERS, durationRange: [0.12, 0.7],
    generate: { prompt: `A single arrow loosed from a recurve bow: a sharp deep bowstring twang and a fast arrow whoosh flying away, close and dry. One shot only. ${NO_SPEECH}`, duration: 0.6, candidates: 5, influence: 0.55 },
  },
  {
    id: "arrow.thunk", label: "Arrow thunk (stone)", group: "bow", bus: "impact", variants: 4, target: -22.5, gain: 1.2, pitchJitter: 0.08, gainJitter: 0.1,
    maxVoices: 5, range: { ref: 3, max: 30 }, wet: 0.1, usedBy: ARCHERS, durationRange: [0.1, 0.7],
    generate: { prompt: `A single arrow striking and sticking into old mossy stone masonry: a hard punchy thunk with the wooden shaft quivering briefly and a few grains of grit, close and dry. One impact only. ${NO_SPEECH}`, duration: 0.6, candidates: 6, influence: 0.6 },
  },
  {
    id: "arrow.hit", label: "Arrow hits body", group: "bow", bus: "impact", variants: 3, target: -20.5, gain: 1.2, pitchJitter: 0.06, gainJitter: 0.1,
    maxVoices: 3, range: { ref: 3, max: 30 }, wet: 0.1, usedBy: ARCHERS, durationRange: [0.12, 0.8],
    generate: { prompt: `A single arrow hitting a person wearing a heavy cloth cloak: a deep muffled thud with a sharp cloth snap and a short grunt-free body impact, close and dry. One impact only. No speech, no voice, no music.`, duration: 0.6, candidates: 4, influence: 0.55 },
  },
  {
    id: "arrow.catch", label: "Arrow caught", group: "bow", bus: "foley", variants: 3, target: -21, gain: 0.85, pitchJitter: 0.06, gainJitter: 0.1,
    maxVoices: 3, range: { ref: 2, max: 20 }, wet: 0.06, usedBy: ARCHERS, durationRange: [0.1, 0.6],
    generate: { prompt: `A hand snatching a flying arrow out of the air: a fast whoosh ending in a sharp leather glove slap on a wooden shaft, close and dry. One catch only. ${NO_SPEECH}`, duration: 0.5, candidates: 4, influence: 0.55 },
  },
  {
    id: "arrow.pickup", label: "Arrow into quiver", group: "bow", bus: "foley", variants: 3, target: -25, gain: 0.7, pitchJitter: 0.08, gainJitter: 0.1,
    cooldown: 0.05, maxVoices: 3, range: { ref: 2, max: 14 }, wet: 0.04, usedBy: ARCHERS, durationRange: [0.1, 0.6],
    generate: { prompt: `A single wooden arrow being dropped into a leather quiver full of arrows: a quick light wooden rattle and clack, close and dry. ${NO_SPEECH}`, duration: 0.5, candidates: 4, influence: 0.55 },
  },
  {
    id: "archer.dodge", label: "Cloak dodge", group: "bow", bus: "foley", variants: 3, target: -24, gain: 0.75, pitchJitter: 0.08, gainJitter: 0.1,
    maxVoices: 4, range: { ref: 2, max: 16 }, wet: 0.05, usedBy: ARCHERS, durationRange: [0.1, 0.6],
    generate: { prompt: `A person diving into a fast roll in a heavy cloak: a quick whooshing cloth flap and rustle, close and dry. One movement only. ${NO_SPEECH}`, duration: 0.5, candidates: 4, influence: 0.55 },
  },
  {
    id: "archer.feathers", label: "Feather burst", group: "bow", bus: "foley", variants: 3, target: -22, gain: 0.8, pitchJitter: 0.06, gainJitter: 0.1,
    maxVoices: 3, range: { ref: 3, max: 24 }, wet: 0.08, usedBy: ARCHERS, durationRange: [0.2, 1.2],
    generate: { prompt: `A sudden burst of feathers and a cloak tearing: a soft explosive flutter of many feathers with a sharp cloth rip, close and dry. ${NO_SPEECH}`, duration: 0.9, candidates: 4, influence: 0.5 },
  },
  {
    id: "chest.open", label: "Treasure chest opens", group: "bow", bus: "foley", variants: 2, target: -22, gain: 0.8, pitchJitter: 0.04, gainJitter: 0.08,
    maxVoices: 2, range: { ref: 3, max: 26 }, wet: 0.1, usedBy: ARCHERS, durationRange: [0.4, 1.6],
    generate: { prompt: `An old wooden treasure chest lid flung open: a short creak of iron hinges and a bright magical shimmer chime, close. ${NO_SPEECH}`, duration: 1.2, candidates: 4, influence: 0.5 },
  },
  {
    id: "bomb.explode", label: "Bomb arrow explosion", group: "bow", bus: "impact", variants: 3, target: -16, gain: 1.18, pitchJitter: 0.05, gainJitter: 0.08,
    maxVoices: 3, priority: 95, duck: { seconds: 0.32, depth: 0.58 }, range: { ref: 5, max: 60 }, wet: 0.2, usedBy: [...ARCHERS, ...OUTBREAK], durationRange: [0.6, 2.2],
    generate: { prompt: `A small black-powder bomb exploding against a stone wall in a ruined courtyard: a punchy boom with crumbling stone debris raining down and a short echo. ${NO_SPEECH}`, duration: 1.8, candidates: 4, influence: 0.5 },
  },
  {
    id: "laser.beam", label: "Laser arrow beam", group: "bow", bus: "spell", variants: 3, target: -20, gain: 0.8, pitchJitter: 0.06, gainJitter: 0.1,
    maxVoices: 2, range: { ref: 4, max: 40 }, wet: 0.12, usedBy: ARCHERS, durationRange: [0.2, 1.2],
    generate: { prompt: `A magical beam of light fired from a bow: a bright crackling energy zap that sizzles and rings briefly as it ricochets, close. ${NO_SPEECH}`, duration: 0.9, candidates: 4, influence: 0.5 },
  },
  {
    id: "bramble.grow", label: "Bramble grows", group: "bow", bus: "foley", variants: 2, target: -24.5, gain: 1.05, pitchJitter: 0.06, gainJitter: 0.1,
    maxVoices: 2, range: { ref: 3, max: 26 }, wet: 0.08, usedBy: ARCHERS, durationRange: [0.3, 1.4],
    generate: { prompt: `Thorny vines bursting out of stone and growing in an instant: fast creaking, cracking and rustling wood and leaves, close and dry. ${NO_SPEECH}`, duration: 1, candidates: 4, influence: 0.5 },
  },
  {
    id: "shield.break", label: "Shield breaks", group: "bow", bus: "spell", variants: 2, target: -20, gain: 0.85, pitchJitter: 0.05, gainJitter: 0.08,
    maxVoices: 2, range: { ref: 3, max: 30 }, wet: 0.12, usedBy: ARCHERS, durationRange: [0.3, 1.4],
    generate: { prompt: `A magical protective bubble shattering: a bright crystalline glassy crack with a shimmering chime tail, close. ${NO_SPEECH}`, duration: 1, candidates: 4, influence: 0.5 },
  },
  {
    id: "wings.flap", label: "Wing flap", group: "bow", bus: "foley", variants: 3, target: -24, gain: 0.75, pitchJitter: 0.08, gainJitter: 0.1,
    cooldown: 0.06, maxVoices: 3, range: { ref: 2, max: 18 }, wet: 0.05, usedBy: ["archers", "outbreak"], durationRange: [0.12, 0.6],
    generate: { prompt: `A single powerful flap of large feathered wings: a deep soft whump of air and feathers, close and dry. One flap only. ${NO_SPEECH}`, duration: 0.5, candidates: 4, influence: 0.55 },
  },


  // Tyres, reusing Getaway's recordings in place; driven by per-wheel slip (`@arcade/kit/vehicle/slip`)
  {
    id: "vehicle.tyre.screech", label: "Tyre screech", group: "vehicle", bus: "tyre", variants: 1, loop: true, target: -24, gain: 0.8, pitchJitter: 0, gainJitter: 0,
    range: { ref: 4, max: 60 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [1, 8],
    reuse: [{ path: "games/getaway/public/sfx/tire_screech_loop.mp3", license: "Proprietary project asset (Getaway public/sfx)", provenance: "Getaway's tyre screech loop" }],
  },
  {
    id: "vehicle.tyre.chirp", label: "Tyre chirp", group: "vehicle", bus: "tyre", variants: 1, target: -22, gain: 0.7, pitchJitter: 0.05, gainJitter: 0.1,
    cooldown: 1.2, range: { ref: 4, max: 50 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [0.1, 1],
    reuse: [{ path: "games/getaway/public/sfx/skid_short.mp3", license: "Proprietary project asset (Getaway public/sfx)", provenance: "Getaway's short skid" }],
  },

  // Interface, reusing existing project files in place
  {
    id: "ui.click", label: "UI click", group: "ui", bus: "ui", variants: 1, target: -24, gain: 0.7, pitchJitter: 0.03, gainJitter: 0.05,
    cooldown: 0.05, range: { ref: 0, max: 0 }, wet: 0, usedBy: ["getaway", "outbreak"], durationRange: [0.03, 0.6],
    reuse: [{ path: "games/getaway/public/sfx/ui_click.mp3", license: "Proprietary project asset (Getaway public/sfx)", provenance: "Getaway's interface click" }],
  },
  {
    id: "ui.tick", label: "UI tick", group: "ui", bus: "ui", variants: 1, target: -24, gain: 0.7, pitchJitter: 0.03, gainJitter: 0.05,
    cooldown: 0.05, range: { ref: 0, max: 0 }, wet: 0, usedBy: ["carrier", "outbreak"], durationRange: [0.03, 1],
    reuse: [{ path: "games/carrier/public/sfx/v3/ui-click-1.ogg", license: "ElevenLabs commercial sound-generation license (Anomaly)", provenance: "Carrier's picked interface click take (eleven_text_to_sound_v2)" }],
  },
]

export const SFX_LIBRARY: readonly SfxEntry[] = SFX_SPECS.map(spec => ({ ...spec, files: LIBRARY_FILES[spec.id] ?? [] }))
export const SFX_BY_ID: ReadonlyMap<string, SfxEntry> = new Map(SFX_LIBRARY.map(entry => [entry.id, entry]))

export function sfxEntry(id: string): SfxEntry {
  const entry = SFX_BY_ID.get(id)
  if (!entry) throw new Error(`Unknown sound "${id}"`)
  return entry
}

/** Library ids for a selection: exact ids, `group.*` prefixes, or games by name (`game:outbreak`); undefined = none. */
export function selectSfx(selection: readonly string[] | "all" | undefined): SfxEntry[] {
  if (!selection) return []
  if (selection === "all") return [...SFX_LIBRARY]
  return SFX_LIBRARY.filter(entry => selection.some(s => s === entry.id || (s.endsWith(".*") && entry.id.startsWith(s.slice(0, -1))) || (s.startsWith("game:") && entry.usedBy.includes(s.slice(5)))))
}

/** Asset URL of a library file under a host's `audio-assets/`. */
export const sfxUrl = (file: LibraryFile) => `sfx/${file.file}`

/** Sample-bank id of one variant. */
export const variantId = (id: string, index: number) => `${id}#${index + 1}`

/** `SampleAssetMeta` for the runtime's sample bank. Each variant keeps its own licence and provenance. */
export function sfxManifest(entries: readonly SfxEntry[]): SampleAssetMeta[] {
  return entries.flatMap(entry => entry.files.map((file, i): SampleAssetMeta => ({
    id: variantId(entry.id, i),
    url: sfxUrl(file),
    category: entry.bus,
    source: file.source,
    prompt: entry.generate?.prompt,
    modelId: file.source === "elevenlabs-sound-v2" ? "eleven_text_to_sound_v2" : undefined,
    requestId: file.requestId,
    license: file.license,
    provenance: file.provenance,
    durationSeconds: file.durationSeconds,
    ...(file.loopEnd ? { loopStart: file.loopStart ?? 0, loopEnd: file.loopEnd } : {}),
    fallbackSynth: { durationSeconds: Math.min(2, file.durationSeconds), baseHz: 180, endHz: 90, noiseMix: 0.6, cutoffHz: 2400, decayRate: 6, loop: entry.loop },
  })))
}

/**
 * One runtime cue per id: a sample layer over every variant, seeded round-robin without immediate repeats, with the
 * entry's pitch and gain jitter. Each variant's gain brings it to the entry's loudness target.
 */
export function sfxCues(entries: readonly SfxEntry[]): CueRecipe[] {
  return entries.map(entry => ({
    id: entry.id,
    label: entry.label,
    category: entry.bus,
    masterGain: entry.gain,
    wet: entry.wet,
    loop: entry.loop,
    cooldownSeconds: entry.cooldown,
    maxVoices: entry.maxVoices,
    priority: entry.priority,
    duck: entry.duck,
    steal: entry.steal ?? "steal-oldest",
    pitchVariation: entry.pitchJitter,
    gainVariation: entry.gainJitter,
    layers: [{
      kind: "sample",
      samples: entry.files.map((file, i) => ({ id: variantId(entry.id, i), gain: file.gain })),
      selection: "round-robin",
      loop: entry.loop,
    }],
  }))
}
