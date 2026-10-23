/**
 * What the woods sound pipeline asks ElevenLabs for (`eleven_text_to_sound_v2`). Prompts ask for clean, close-ish sources:
 * distance, forest reverb and air absorption are added at runtime (`src/audio/`), so each event can sit anywhere.
 */
export type WoodsSoundSpec = {
  id: string
  prompt: string
  /** Requested seconds. */
  duration: number
  influence: number
  /** Takes generated, takes kept. */
  takes: number
  keep: number
  /** In-file loudness: integrated LUFS for loops, momentary-max LUFS for one-shots. The runtime sets the mix level. */
  target: number
  loop?: boolean
  stereo?: boolean
  /** Acceptable trimmed duration (s). */
  range: [number, number]
  /** Hand edits: take → [start, end] seconds kept before trimming (e.g. the first three of four knocks). */
  cuts?: Record<number, [number, number]>
  /** Hand picks (take numbers) after reading the contact sheets, Scribe's audio-event tags and pitch tracks; overrides the score. */
  picks?: number[]
}

const BED = { duration: 22, influence: 0.45, takes: 3, keep: 1, target: -24, loop: true, range: [18, 23] as [number, number] }

export const WOODS_SOUND_SPECS: WoodsSoundSpec[] = [
  // ── beds ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: "bed.canopy", ...BED, stereo: true, prompt: "Night wind high in tall pine treetops, slow rising and falling gusts rushing through the needles far overhead, deep forest, steady, no rain, no birds, no music" },
  { id: "bed.leaves", ...BED, stereo: true, prompt: "Close soft hiss of dry leaves and pine needles stirring on the forest floor in a light breeze at night, gentle steady rustle, no howling wind, no birds, no footsteps" },
  { id: "bed.crickets", ...BED, stereo: true, prompt: "Loud dense chorus of field crickets and katydids on a warm summer night in a forest clearing, steady chirping, no wind, no birds, no frogs, no music" },
  { id: "bed.lake", ...BED, prompt: "Small gentle waves lapping against a wooden dock post and a pebble lake shore at night, close, slow irregular wet slaps and trickles, no wind, no birds, no insects" },
  { id: "bed.walls", ...BED, takes: 6, stereo: true, prompt: "Inside a dark wooden cabin on a windy night: muffled gusts of wind pushing against the walls and windows, a low hollow roar that rises and falls, an occasional creak of timber, no music, no rain, no voices", picks: [5] },
  // ── one-shots in the bed ─────────────────────────────────────────────────────────────────────────────────────
  { id: "tree.creak", prompt: "A single long slow creak of a tall tree trunk swaying in the wind, deep woody groan, outdoors at night", duration: 3, influence: 0.55, takes: 6, keep: 4, target: -20, range: [0.8, 3.2] },
  { id: "tree.knock", prompt: "Hollow knock of one wooden tree branch striking another in the wind, a dull woody clack, high in a pine tree, outdoors at night", duration: 1.5, influence: 0.55, takes: 12, keep: 4, target: -20, range: [0.3, 1.6], picks: [12, 10, 11, 9], cuts: { 12: [0.5, 1.15], 10: [0, 0.65], 11: [0, 0.6], 9: [0.6, 1.48] } },
  { id: "dock.creak", prompt: "Old wooden dock boards creaking once as the water shifts underneath, slow single creak of wet planks, lake at night", duration: 2, influence: 0.55, takes: 5, keep: 3, target: -20, range: [0.5, 2.2] },
  // ── distant events (the dread) ───────────────────────────────────────────────────────────────────────────────
  { id: "far.loon", prompt: "Common loon wail at night across a lake, a long eerie two-note call that rises and falls, natural wildlife field recording, no music", duration: 5, influence: 0.5, takes: 9, keep: 3, target: -18, range: [1.5, 5.2], picks: [4, 5, 1] },
  { id: "far.fox", prompt: "Red fox scream at night in the woods, a single harsh hoarse shriek, natural field recording", duration: 3, influence: 0.5, takes: 5, keep: 3, target: -18, range: [0.5, 3.2] },
  { id: "far.owl", prompt: "Great horned owl hooting at night in a forest, deep soft hoo hoo-hoo hoo hoo, natural field recording", duration: 4, influence: 0.5, takes: 5, keep: 3, target: -18, range: [1, 4.2] },
  { id: "far.snap", prompt: "A big dead tree branch cracking loudly and snapping off, then crashing down through branches onto the forest floor, at night", duration: 3, influence: 0.5, takes: 5, keep: 3, target: -18, range: [0.8, 3.2] },
  { id: "far.steps", prompt: "Heavy slow footsteps of a large animal walking through a forest at night, four deep thuds on soft ground with twigs snapping under its weight, then it stops and there is silence", duration: 6, influence: 0.5, takes: 11, keep: 3, target: -18, range: [2, 6.2], picks: [6, 8, 10], cuts: { 8: [0, 3.5], 10: [0.5, 3.95] } },
  { id: "far.knock", prompt: "Exactly three slow knocks of a thick stick against a hollow tree trunk, about one second apart, then silence, outdoors at night", duration: 3.5, influence: 0.6, takes: 10, keep: 3, target: -18, range: [1, 3.7], picks: [3, 8, 10], cuts: { 3: [0.5, 2.42], 8: [0.1, 2.6], 10: [0.75, 2.12] } },
  { id: "far.whistle", prompt: "A single long human whistle, two clear notes, someone whistling outdoors at night, no music", duration: 3, influence: 0.55, takes: 5, keep: 3, target: -18, range: [0.6, 3.2] },
  { id: "far.radio", prompt: "Short burst of walkie-talkie radio squelch, a click, a crackle of static hiss and a click off, no voice", duration: 2, influence: 0.55, takes: 5, keep: 3, target: -18, range: [0.3, 2.2] },
  { id: "far.cardoor", prompt: "A car door slamming shut once, outdoors at night, solid metallic thunk", duration: 2, influence: 0.55, takes: 5, keep: 3, target: -18, range: [0.3, 2.2] },
  { id: "far.screendoor", prompt: "A wooden screen door on a spring snapping shut against its wooden frame, a hollow wooden slap and a short rattle as it bounces, outdoors at night", duration: 2, influence: 0.55, takes: 9, keep: 3, target: -18, range: [0.3, 2.2], picks: [2, 3, 1] },
  // ── road flares (`src/audio/flares.ts`) ──────────────────────────────────────────────────────────────────────────
  { id: "flare.strike", prompt: "Striking a highway road flare to light it: the plastic striker cap scraped hard across the rough end of the flare, one dry gritty scratch, close, no ignition, no fire, no music", duration: 1.2, influence: 0.6, takes: 6, keep: 3, target: -18, range: [0.25, 1.3], picks: [3, 4, 2] },
  { id: "flare.ignite", prompt: "A red road flare igniting: a sharp fizzing pop and a hissing whoosh as it catches and flares up into a fierce sputtering burn, close, outdoors at night, no music", duration: 2, influence: 0.55, takes: 6, keep: 3, target: -18, range: [0.8, 2.2], picks: [4, 3, 1] },
  { id: "flare.burn", prompt: "Close steady fierce hiss of a burning red road flare lying on the ground, a rough sizzling roar with small irregular pops and sputters, constant, no wind, no music", duration: 10, influence: 0.45, takes: 4, keep: 1, target: -24, loop: true, range: [6, 11], picks: [2], cuts: { 2: [0.2, 7.6] } },
]

/**
 * Ingredients for the uncanny tier (`scripts/audio/uncanny.ts` composes them into the shipped `odd.*` files): generated
 * and curated like the rest, never shipped on their own. Real animals and real people, recorded close and dry.
 */
const SRC = { influence: 0.55, keep: 3, target: -18 }
/** What uncanny.ts composes (`$WORK/composed/<id>/<n>.f32`), encoded by `sounds.ts build` alongside the specs. */
export const UNCANNY_IDS = ["far.howl", "far.taken", "far.mimic", "far.echo", "far.climb", "far.stop"] as const
export const UNCANNY_SOURCE_SPECS: WoodsSoundSpec[] = [
  { id: "src.coyote", ...SRC, prompt: "A single lone coyote howling at night, one long sustained mournful howl that rises and holds a high note for several seconds, no yips, no barking, no other animals, natural wildlife field recording, close, quiet background, no music", duration: 9, takes: 5, range: [2.5, 9.2] },
  { id: "src.wolf", ...SRC, prompt: "A lone gray wolf howling at night, one long low sustained howl that slowly rises and falls, a single animal, no other wolves, natural wildlife field recording, close, quiet background, no music", duration: 9, takes: 4, range: [2.5, 9.2] },
  { id: "src.wail", ...SRC, influence: 0.6, prompt: "A woman's voice holding one long sustained wordless wail, a single open aaah vowel held for many seconds without a breath, mournful and strained, no words, no music, dry close recording, quiet background", duration: 7, takes: 5, range: [2, 7.2] },
  { id: "src.deer", ...SRC, prompt: "A deer in distress at night, a doe's loud harsh bleating scream, two desperate cries, natural wildlife field recording, no music", duration: 3, takes: 5, range: [0.6, 3.2] },
  { id: "src.rabbit", ...SRC, prompt: "A wild rabbit's distress scream, a shrill piercing shriek like a crying child, in grass at night, natural field recording, no music", duration: 3, takes: 4, range: [0.6, 3.2] },
  { id: "src.thrash", ...SRC, prompt: "A short violent struggle in dry undergrowth at night: an animal thrashing and kicking through brush and dead leaves for a second or two, branches whipping, then it stops dead, close, no voices, no music", duration: 2.5, takes: 6, range: [0.6, 2.7] },
  { id: "src.impact", ...SRC, prompt: "One heavy dull thud of a large body slammed onto the forest floor with a single wet crack like a thick bone breaking, close, dry, no reverb, no music", duration: 1.5, takes: 6, range: [0.2, 1.6] },
  { id: "src.crack", ...SRC, prompt: "A single sharp wet crack of a thick bone snapping, close, dry, very short, no reverb, no music", duration: 1, takes: 4, range: [0.1, 1.1] },
  { id: "src.climb", ...SRC, prompt: "A huge old pine tree creaking and groaning slowly under a heavy weight, deep strained woody creaks a few seconds apart as the trunk bends, as if something very heavy is slowly climbing it, a little bark scraping, then silence, at night, no wind, no music", duration: 10, takes: 6, range: [3, 10.2] },
  { id: "src.knock", ...SRC, prompt: "One single hard knock of a thick piece of wood struck once against a hollow tree trunk, outdoors at night, then silence", duration: 1.5, takes: 6, range: [0.15, 1.6] },
  { id: "src.morph", ...SRC, prompt: "A lone coyote howl at night that goes on far too long and slowly turns into a woman's long scream, then stops suddenly, natural field recording, no music", duration: 12, takes: 3, range: [4, 12.2] },
]
