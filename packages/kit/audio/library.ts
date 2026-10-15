import { LIBRARY_FILES, type LibraryFile } from "./library-files"
import type { CueRecipe, MixCategory, SampleAssetMeta } from "./types"

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
  | "zombie" | "body" | "ambience" | "ui"

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

export const SFX_SPECS: readonly SfxSpec[] = [
  // Weapons
  {
    id: "gun.pistol.shot", label: "Pistol shot", group: "gun", bus: "weapon", variants: 4, target: -19, gain: 1, pitchJitter: 0.05, gainJitter: 0.08,
    maxVoices: 4, range: { ref: 4, max: 90 }, wet: 0.3, usedBy: OUTBREAK, durationRange: [0.35, 1.6],
    generate: { prompt: `A single 9mm pistol gunshot, close, dry, sharp crack with a punchy low body and short tail. One shot only. No music, no voice.`, duration: 1.5, candidates: 12, influence: 0.5 },
  },
  {
    id: "gun.pistol.reload", label: "Pistol reload", group: "gun", bus: "weapon", variants: 3, target: -22, gain: 0.8, pitchJitter: 0.03, gainJitter: 0.06,
    maxVoices: 2, range: { ref: 2, max: 14 }, wet: 0.12, usedBy: OUTBREAK, durationRange: [0.6, 1.6],
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
  {
    id: "melee.shove", label: "Shove", group: "melee", bus: "foley", variants: 3, target: -20, gain: 0.85, pitchJitter: 0.06, gainJitter: 0.1,
    maxVoices: 2, range: { ref: 2, max: 14 }, wet: 0.08, usedBy: OUTBREAK, durationRange: [0.2, 0.9],
    generate: { prompt: `A hard two-handed shove against a person's chest: quick jacket rustle and whoosh, then a dull heavy body thud. ${NO_SPEECH}`, duration: 0.8, candidates: 4, influence: 0.5 },
  },

  // Footsteps, sliced from recordings of steady walking and running
  ...(["concrete", "grass", "wood"] as const).flatMap(surface => (["walk", "run"] as const).map((gait): SfxSpec => ({
    id: `foot.${surface}.${gait}`, label: `Footstep ${surface} ${gait}`, group: "foot", bus: "foley", variants: 6, target: gait === "walk" ? -27 : -25,
    gain: 1, pitchJitter: 0.06, gainJitter: 0.12, maxVoices: 6, range: { ref: 1.5, max: gait === "walk" ? 12 : 18 }, wet: 0.05, usedBy: OUTBREAK,
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
  {
    id: "flashlight.click", label: "Flashlight click", group: "flashlight", bus: "foley", variants: 3, target: -26, gain: 0.8, pitchJitter: 0.05, gainJitter: 0.06,
    cooldown: 0.08, maxVoices: 2, range: { ref: 1.5, max: 6 }, wet: 0.03, usedBy: OUTBREAK, durationRange: [0.03, 0.4],
    generate: { prompt: `A single click of a metal flashlight's rubber tail switch, tiny and crisp, very close. ${NO_SPEECH}`, duration: 0.5, candidates: 4, influence: 0.6 },
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
    steal: "steal-oldest",
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
