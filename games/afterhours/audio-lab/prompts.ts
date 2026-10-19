// Candidate SFX prompts for the Afterhours audio lab.
//
// House style, taken from the takes the user approved by ear (picks-*.json, lib/approved.ts): short, lowercase,
// comma-separated literal descriptions with one concrete object/material/action, the space, and close mic or
// distant, e.g. "light switch flicked on and off twice, close mic", "industrial knife switch pulled, power shuts off
// with descending hum", "far away loud metallic slam somewhere in a concrete basement, long echo". No durations or
// "loopable" in the text (duration and loop are request fields); no music or voices unless intended.
//
// `intent` is what the listening QA (qa.ts) judges every take against. `keep` locks a take the user approved.
// Edit a category, then `bun audio-lab/generate.ts --category <id> --force` or let `bun audio-lab/improve.ts` fix
// only the weak takes.

export interface VariantSpec {
  prompt: string
  duration?: number
  influence?: number
  loop?: boolean
  keep?: boolean
  /** Overrides the category intent for QA when this slot aims at something different (e.g. drizzle vs dry night). */
  intent?: string
}

export interface CategorySpec {
  id: string
  group: string
  /** Optional sub-header on the audition page (e.g. one per monster). */
  subgroup?: string
  label: string
  intent: string
  loop?: boolean
  variants: VariantSpec[]
}

const v = (prompt: string, duration?: number, influence = 0.5, loop?: boolean): VariantSpec => ({
  prompt,
  duration,
  influence,
  loop,
})
const loopV = (prompt: string, duration: number, influence = 0.5) => v(prompt, duration, influence, true)
const withIntent = (spec: VariantSpec, intent: string): VariantSpec => ({ ...spec, intent })

const DRIZZLE_INTENT =
  "light drizzle on pine needles in a quiet pine forest at night: soft patter on needles and branches and slow drips, low level; no traffic, road or highway hum, no crickets or birds, no heavy rain wash, no music"

export const CATEGORIES: CategorySpec[] = [
  // Footsteps
  {
    id: "foot-linoleum",
    group: "footsteps",
    label: "Footsteps: waxed linoleum corridor",
    intent: "one person walking at a slow steady pace in leather work boots on a waxed linoleum hallway floor, indoor corridor reverb, no music",
    variants: [
      v("slow footsteps in work boots on waxed linoleum, long empty hallway, close mic", 5, 0.45),
      v("footsteps walking down a tiled school corridor at night, hard soles, echoing", 5, 0.4),
      v("one person walking on polished vinyl floor, rubber soles, faint squeak, empty hallway", 5, 0.5),
      v("cautious footsteps on linoleum, stopping and starting, quiet empty building at night", 5, 0.35),
    ],
  },
  {
    id: "foot-carpet",
    group: "footsteps",
    label: "Footsteps: office carpet",
    intent: "one person walking slowly in boots on thin commercial office carpet, muffled soft thuds, small quiet room",
    variants: [
      v("heavy boots on low pile office carpet, muffled soft thuds, quiet office, close mic", 4, 0.55),
      v("slow heavy footsteps on thin office carpet, dull padded thumps, quiet room at night", 4, 0.5),
      v("work boots walking across a carpeted office floor, soft muffled steps, faint fabric scuff, quiet", 4, 0.5),
    ],
  },
  {
    id: "foot-stairwell",
    group: "footsteps",
    label: "Footsteps: concrete stairwell",
    intent: "one person in hard rubber-soled work boots walking on bare concrete stair steps inside a concrete stairwell with stairwell reverb; not dress shoes or heels, not a wooden floor, not metal stairs",
    variants: [
      v("heavy rubber work boots on bare concrete stairs, dull gritty thuds, concrete stairwell echo", 6, 0.6),
      v("work boots climbing bare concrete steps, rubber soles scuffing grit, cold stairwell reverb, close mic", 6, 0.55),
      v("rubber boots walking down concrete stair steps, heavy flat thuds, no heels, echoing stairwell", 6, 0.6),
      v("slow heavy work boot steps on concrete stairs far below, rubber soles, stairwell echo, distant", 6, 0.5),
    ],
  },
  {
    id: "foot-grating",
    group: "footsteps",
    label: "Footsteps: metal grating catwalk",
    intent: "one person walking in boots on a steel grating catwalk, metallic clank and ring per step, industrial room",
    variants: [
      v("footsteps on a steel grating catwalk, metallic clank each step, machine room, close mic", 5, 0.5),
      v("boots walking across a metal mesh walkway, rattling grate panels, industrial echo", 5, 0.4),
      v("slow footsteps on diamond plate steel floor, hollow metallic thud, basement plant room", 5, 0.45),
    ],
  },
  {
    id: "foot-wet-asphalt",
    group: "footsteps",
    label: "Footsteps: wet asphalt",
    intent: "one person walking on wet asphalt outdoors at night, wet splashy shoe contacts, open outdoor space",
    variants: [
      v("footsteps on wet asphalt at night, wet slapping soles, parking lot, close mic", 5, 0.5),
      v("boots splashing through shallow puddles on a wet road, slow walk", 5, 0.4),
      v("slow footsteps on rain soaked pavement, wet scuffs, quiet street at night", 5, 0.45),
    ],
  },
  {
    id: "foot-gravel",
    group: "footsteps",
    label: "Footsteps: gravel",
    intent: "one person walking on loose gravel outdoors, crunchy stone steps",
    variants: [
      v("slow footsteps on loose gravel, crunchy steps, outdoors at night, close mic", 5, 0.5),
      v("boots crunching on a gravel road shoulder, steady walk", 5, 0.4),
      v("careful steps on coarse gravel, stones shifting underfoot, distant", 5, 0.45),
    ],
  },
  {
    id: "foot-forest",
    group: "footsteps",
    label: "Footsteps: forest floor",
    intent: "one person walking on soft damp moss, wet pine needles and soft earth in a pine forest at night: muffled soft steps; no dry leaves, no crunchy twigs, no gravel",
    variants: [
      v("slow footsteps on soft wet moss and damp pine needles, muffled squelchy steps, no dry leaves", 6, 0.6),
      v("boots sinking into soft damp forest soil and wet needles, quiet soft thuds, night woods, close mic", 6, 0.55),
      v("walking on a wet mossy forest floor after rain, soft spongy steps, no crunching", 6, 0.6),
    ],
  },

  // Doors
  {
    id: "door-fire-steel",
    group: "doors",
    label: "Heavy steel fire door open/close",
    intent: "a heavy solid steel fire door: door closer hiss, heavy swing and a loud solid latch clack/boom in a concrete corridor; heavy and solid, no hinge squeak, not a light door",
    variants: [
      v("heavy solid steel fire door closing on a hydraulic closer, air hiss, loud latch clack, concrete corridor, no squeak", 4, 0.6),
      v("heavy steel fire door pushed open and swinging shut, deep solid boom and latch clack, echoing concrete hallway", 4, 0.55),
      v("thick steel door slammed shut, heavy solid metal boom, latch bolt clack, empty concrete building", 3, 0.6),
      v("heavy fire door closer hissing, steel door thuds into its frame, latch clacks, close mic", 4, 0.55),
    ],
  },
  {
    id: "door-office-wood",
    group: "doors",
    label: "Wooden office door creak",
    intent: "an old wooden office door opening slowly with a creaking hinge, small quiet room",
    variants: [
      v("old wooden office door creaking open slowly, squeaky hinges, quiet room", 3.5, 0.5),
      v("wooden door handle turning, door opens with a short creak, closes softly", 3, 0.45),
      v("wooden office door shut firmly, latch click, small room, close mic", 2, 0.5),
    ],
  },
  {
    id: "door-panic-bar",
    group: "doors",
    label: "Panic bar push",
    intent: "pushing the panic bar of a heavy steel emergency exit door: loud solid latch clack, heavy door swing, door closer hiss; heavy and solid, no hinge squeak",
    variants: [
      v("heavy steel exit door panic bar pushed, loud solid latch clack, door swings open, no squeak", 2.5, 0.6),
      v("emergency exit crash bar slammed down, heavy metal clack, door closer hiss, concrete stairwell", 3, 0.55),
      v("panic bar released on a heavy steel door, latch clack, door closer hisses it shut with a solid thud", 4, 0.55),
    ],
  },
  {
    id: "door-rollup-dock",
    group: "doors",
    label: "Roll-up loading dock door",
    intent: "a large corrugated steel roll-up loading dock door being raised or lowered: rumbling, rattling metal slats",
    variants: [
      v("corrugated steel roll up door pulled open by hand, rattling chain and slats, loading dock", 6, 0.5),
      v("rolling steel shutter door opening on a motor, clattering slats, warehouse", 7, 0.45),
      v("roll up loading dock door pulled down and slammed shut, metal crash, echo", 3, 0.5),
    ],
  },
  {
    id: "gate-chainlink",
    group: "doors",
    label: "Chain-link gate rattle",
    intent: "a chain-link fence gate rattling and swinging, metal chain and fence wire jingling, outdoors at night",
    variants: [
      v("chain link fence gate swinging open, wire mesh rattle, chain jingling, outdoors at night", 4, 0.5),
      v("shaking a locked chain link gate, padlock and chain clanking", 3, 0.5),
      v("chain link gate slammed shut against its post, metal rattle, distant", 3, 0.45),
    ],
  },
  {
    id: "gate-motorized",
    group: "doors",
    label: "Motorized sliding gate",
    intent: "a motorized steel security sliding gate rolling along its ground track, electric motor hum, ends with a stop clunk, outdoors",
    variants: [
      v("motorized steel sliding gate opening, motor hum, wheels rolling on track, clunk at the end", 8, 0.5),
      v("old electric security gate sliding closed, grinding rollers, chain rattle, outdoors", 8, 0.45),
      v("sliding gate motor starting with a relay click, slow rumbling slide, distant", 6, 0.4),
    ],
  },

  // Lift
  {
    id: "lift-motor",
    group: "lift",
    label: "Lift motor hum",
    intent: "inside an old elevator car while it travels: steady electric motor hum and gentle cabin rumble, loopable",
    loop: true,
    variants: [
      loopV("old elevator moving between floors, low motor hum, cabin rumble, inside the car", 10, 0.5),
      loopV("freight elevator travelling, steady motor drone, cabin rattle", 10, 0.45),
      loopV("elevator machine room, hoist motor running, deep hum and relay clicks", 10, 0.5),
    ],
  },
  {
    id: "lift-cable",
    group: "lift",
    label: "Lift cable creak",
    intent: "steel elevator cables and pulleys creaking and groaning under tension inside an elevator shaft",
    variants: [
      v("elevator cables creaking in the shaft, steel cable groan, hollow echo", 6, 0.5),
      v("old elevator car swaying, cable creak and metal ticks, inside the car", 5, 0.45),
      v("elevator pulley turning slowly, cable strain and creak, machine room", 6, 0.4),
    ],
  },
  {
    id: "lift-ding",
    group: "lift",
    label: "Lift arrival ding (1980s)",
    intent: "a single mechanical elevator arrival bell ding from an 1980s office building elevator",
    variants: [
      v("old elevator arrival bell, single mechanical ding, office lobby", 2, 0.55),
      v("1980s elevator chime, one soft bing, empty hallway", 2, 0.5),
      v("elevator floor bell ringing once, small metal bell, close mic", 2, 0.45),
    ],
  },
  {
    id: "lift-stall",
    group: "lift",
    label: "Lift stall / clunk",
    intent: "an elevator car stopping suddenly between floors: heavy mechanical clunk/jolt, motor winding down",
    variants: [
      v("elevator stopping suddenly between floors, heavy mechanical clunk, motor winding down", 4, 0.5),
      v("old elevator jolting to a halt, loud brake thud, cabin rattle", 3, 0.45),
      v("elevator stalls, metal grinding then a heavy clunk, then silence", 4, 0.4),
    ],
  },
  {
    id: "lift-scissor-gate",
    group: "lift",
    label: "Lift scissor gate",
    intent: "an old freight elevator's collapsible steel scissor/accordion gate being pulled open or shut, rattling metal lattice and latch",
    variants: [
      v("freight elevator scissor gate pulled shut, metal lattice clatter, latch, close mic", 3, 0.5),
      v("old elevator accordion gate pulled open, rattling folding metal gate", 3, 0.45),
      v("elevator scissor gate slammed closed, metal crash and rattle", 2.5, 0.5),
    ],
  },

  // Lights
  {
    id: "light-fluoro-hum",
    group: "lights",
    label: "Fluorescent hum",
    intent: "steady electrical hum/buzz of overhead fluorescent tube lights in a quiet room, loopable",
    loop: true,
    variants: [
      loopV("fluorescent lights humming in an empty office at night, steady electrical buzz", 10, 0.5),
      loopV("old fluorescent tube fixture buzzing overhead, close mic", 10, 0.5),
      loopV("fluorescent ballast hum with faint high whine, quiet hallway", 10, 0.45),
    ],
  },
  {
    id: "light-fluoro-flicker",
    group: "lights",
    label: "Fluorescent flicker / starter tick",
    intent: "a fluorescent tube light flickering on: starter ticking, buzzing pings, then steady hum",
    variants: [
      v("fluorescent tube flickering on, starter ticking, buzzing, then steady hum", 4, 0.5),
      v("faulty fluorescent light flickering, irregular buzz and pings, empty room", 5, 0.45),
      v("fluorescent starter clicking, tube struggling to light, close mic", 4, 0.5),
    ],
  },
  {
    id: "light-sodium-buzz",
    group: "lights",
    label: "Sodium lamp buzz",
    intent: "outdoor high-pressure sodium street/parking lamp humming overhead at night, steady electrical buzz, loopable",
    loop: true,
    variants: [
      loopV("sodium street lamp buzzing overhead at night, steady electrical hum, quiet parking lot", 10, 0.5),
      loopV("parking lot light pole humming, high voltage buzz, distant crickets", 10, 0.45),
      loopV("streetlight ballast hum, low steady drone, close mic", 10, 0.5),
    ],
  },
  {
    id: "light-switch",
    group: "lights",
    label: "Light switch",
    intent: "a single 1980s plastic wall toggle light switch being flipped, one click",
    variants: [
      v("Single wall light switch flipped on: one plastic toggle click, close-mic, dry", 1, 0.7),
      v("Old toggle light switch flipped off: one hard plastic snap, close-mic", 1, 0.6),
      v("Light switch flicked on then off: two plastic clicks, close-mic, small room", 2, 0.6),
    ],
  },
  {
    id: "light-breaker",
    group: "lights",
    label: "Breaker thunk",
    intent: "a real 1980s commercial electrical panel breaker or knife switch being thrown by hand: heavy spring-loaded snap with metal panel resonance",
    variants: [
      v("Large commercial circuit breaker in a steel electrical panel thrown by hand: heavy spring-loaded mechanical snap, sheet-metal panel rings briefly, close-mic, utility room", 2.5, 0.65),
      v("Heavy industrial breaker lever pulled down: stiff spring tension then a loud metallic clack, steel cabinet resonance, power hum cuts out", 3, 0.6),
      { prompt: "industrial knife switch pulled, power shuts off with descending hum", duration: 3, influence: 0.6, keep: true },
    ],
  },

  // Ambience
  {
    id: "amb-forest-night",
    group: "ambience",
    label: "Night pine forest",
    intent: "a quiet pine forest at night, very low level and sparse: soft needle rustle in light gusts, occasional trunk creak, branch drips, maybe one distant owl or light drizzle on needles; NO traffic, road or highway noise, no constant wind roar or broadband wash, no crickets, no music",
    loop: true,
    // v1–v3: round 1 (v1 approved, though the user hears highway noise in it); v4–v7 sparse night, v8–v9 drizzle.
    variants: [
      loopV("pine forest at night, distant wind in the treetops, quiet and cold", 22, 0.45),
      loopV("foggy night in the woods, soft gusts through pine branches, very quiet", 22, 0.4),
      loopV("still night forest, water dripping from branches, faint distant wind", 22, 0.45),
      // Positive-only wording: naming a sound to avoid ("no traffic", "no crickets") tends to make the model add it.
      loopV("quiet pine forest at night, occasional soft rustle of pine needles, a slow wooden creak of a tall trunk, long silences", 22, 0.65),
      loopV("cold still night in a pine forest, single water drops falling from branches onto needles, a faint creak, near silence", 22, 0.65),
      loopV("a distant owl hooting once in a quiet pine forest at night, soft rustle of needles in a light gust, long pauses", 22, 0.65),
      loopV("very quiet pine forest after rain at night, sparse drips from needles, a soft gust through branches, then stillness", 22, 0.6),
      withIntent(loopV("light drizzle pattering softly on pine needles and branches at night, slow drips, close, quiet forest", 22, 0.65), DRIZZLE_INTENT),
      withIntent(loopV("fine misty rain on a pine forest canopy at night, soft gentle patter on needles, slow large drips", 22, 0.6), DRIZZLE_INTENT),
    ],
  },
  {
    id: "amb-rain-asphalt",
    group: "ambience",
    label: "Rain drizzle on asphalt",
    intent: "light rain drizzle falling on an asphalt parking lot at night, steady gentle patter, loopable",
    loop: true,
    variants: [
      loopV("light rain drizzle on an asphalt parking lot at night, steady patter, puddles", 20, 0.5),
      loopV("soft rain on a wet road and parked car roofs, gutter dripping", 20, 0.45),
      loopV("misty drizzle hissing on pavement, quiet night, distant", 20, 0.45),
    ],
  },
  {
    id: "amb-rain-thunder",
    group: "ambience",
    label: "Rain with distant thunder",
    intent: "steady rain or drizzle outdoors at night (on asphalt or in a pine forest) with occasional distant rolling thunder, realistic field recording, no music, loopable",
    loop: true,
    variants: [
      loopV("Steady light rain falling on an asphalt parking lot at night, constant patter and puddle drips, one distant low rolling thunder rumble in the middle, no music, loopable", 26, 0.55),
      loopV("Rain falling through a pine forest at night: soft hiss on needles and branches, drips, two far-off rolling thunder rumbles, field recording, loopable", 28, 0.5),
      loopV("Moderate rain on wet pavement and parked car roofs, gutter running, occasional distant thunder rolling across the sky, outdoors at night, loopable", 24, 0.55),
      loopV("Drizzle on asphalt with a long slow thunder roll far away behind low clouds, quiet night, realistic, loopable", 30, 0.45),
    ],
  },
  {
    id: "amb-thunder",
    group: "ambience",
    label: "Thunder one-shots (layer over rain)",
    intent: "a single realistic thunder event for layering over rain: distant roll, closer crack-and-roll, rumble heard indoors through walls, or a sharp nearby lightning strike; no rain bed dominating, no music",
    variants: [
      v("Single distant thunder: a long low rolling rumble far away across the sky, slowly fading out, no rain, field recording", 9, 0.6),
      v("Thunder clap at medium distance: a sharp crack followed by a deep rolling rumble that fades over several seconds, no rain", 8, 0.6),
      v("Thunder heard from inside a concrete building: muffled low rumble through the walls, windows faintly rattle, no rain", 8, 0.55),
      v("Very close lightning strike: an explosive sharp crack and boom right overhead, then a short heavy rumble, no rain", 6, 0.6),
      v("Faint very distant thunder: a soft low grumble on the horizon, barely audible, short, no rain", 6, 0.5),
      v("Rolling thunder at medium distance: several overlapping booms and a long grumbling roll echoing off hills and trees, no rain", 10, 0.55),
    ],
  },
  {
    id: "amb-hvac",
    group: "ambience",
    label: "Building HVAC rumble",
    intent: "large building HVAC: low steady ventilation rumble and air through ducts, loopable",
    loop: true,
    variants: [
      loopV("Building HVAC air handler: low steady rumble and air rushing through sheet-metal ducts, heard through a ceiling vent, loopable", 20, 0.6),
      loopV("Large building ventilation running at night, constant airflow from vents, deep fan hum, loopable", 20, 0.5),
      loopV("Old ceiling air conditioning unit humming steadily, occasional sheet-metal duct tick, loopable", 20, 0.6),
    ],
  },
  {
    id: "amb-corridor-tone",
    group: "ambience",
    label: "Empty corridor room tone",
    intent: "near-silent room tone of an empty tiled institutional corridor at night: faint air and distant electrical hum, loopable",
    loop: true,
    variants: [
      loopV("empty hallway at night, quiet room tone, faint distant ventilation hum", 20, 0.45),
      loopV("silent institutional corridor, subtle air hiss, far off fluorescent buzz", 20, 0.45),
      loopV("empty office building at night, very quiet, faint electrical hum, occasional creak", 20, 0.4),
    ],
  },
  {
    id: "amb-machine-room",
    group: "ambience",
    label: "1984 computer room, tape drives",
    intent: "1980s mainframe computer room: cooling fan roar, reel-to-reel tape drives spinning and stopping, relay clicks, loopable",
    loop: true,
    variants: [
      loopV("1980s mainframe computer room: steady cooling fan roar, reel-to-reel tape drives spinning up and stopping, relay clicks, loopable", 20, 0.6),
      loopV("Vintage computer room: magnetic tape reels whirring and shuttling, a dot-matrix printer in the distance, constant fan noise, loopable", 20, 0.5),
      loopV("Old data center: steady equipment hum and fan noise, occasional disk drive seek chatter, loopable", 20, 0.6),
    ],
  },
  {
    id: "amb-radio-static",
    group: "ambience",
    label: "Radio static",
    intent: "analog radio receiver static and hiss with slow tuning drift, loopable",
    loop: true,
    variants: [
      loopV("Analog shortwave radio receiver static: steady hiss with slow tuning drift and faint whistle tones, loopable", 15, 0.6),
      loopV("AM radio between stations: white noise with occasional crackle, loopable", 15, 0.5),
      loopV("CB radio squelch hiss and static bursts, intermittent carrier hum, loopable", 15, 0.6),
    ],
  },

  // Interactions
  {
    id: "int-flashlight",
    group: "interactions",
    label: "Flashlight click on/off",
    intent: "a handheld flashlight's switch being clicked, a single tactile click",
    variants: [
      v("Metal flashlight tail button pressed: one firm tactile click, close-mic, dry", 1, 0.7),
      v("Plastic flashlight slide switch clicked on then off: two clicks, close-mic", 1.5, 0.6),
      v("Heavy aluminium police flashlight rubber button click, one muted click, close-mic", 1, 0.6),
    ],
  },
  {
    id: "int-keys",
    group: "interactions",
    label: "Keys jingle",
    intent: "a large ring of metal keys jingling (janitor's key ring)",
    variants: [
      v("Large steel key ring with many keys lifted and jingled in hand, bright metal jingle, close-mic", 2.5, 0.6),
      v("Keys pulled from a pocket, jingle, one key slides into a lock and turns with a click", 3, 0.6),
      v("Key ring jingling on a belt clip while walking, rhythmic jingle", 3, 0.5),
    ],
  },
  {
    id: "int-mop-bucket",
    group: "interactions",
    label: "Mop bucket wheels",
    intent: "a janitor's wheeled mop bucket rolling on a tile floor: plastic caster rattle and water slosh",
    variants: [
      v("pushing a janitor mop bucket on squeaky wheels across a tile floor, water sloshing", 5, 0.5),
      v("janitor cart rolling down a hallway, rattling plastic casters", 5, 0.45),
      v("wringing a mop in a bucket wringer, water squeeze and drips, close mic", 3, 0.5),
    ],
  },
  {
    id: "int-paper",
    group: "interactions",
    label: "Paper rustle",
    intent: "handling paper documents: page flipping and rustling",
    variants: [
      v("Flipping through a stack of typed paper documents, crisp page turns and rustle, close-mic", 2.5, 0.6),
      v("Single sheet of paper picked up and unfolded, crisp crinkle, close-mic", 2, 0.65),
      v("Manila folder opened on a desk, papers slide out, close-mic", 2, 0.5),
    ],
  },
  {
    id: "int-typewriter",
    group: "interactions",
    label: "Typewriter",
    intent: "a 1980s typewriter typing: mechanical key strikes, possibly carriage return bell",
    variants: [
      v("electric typewriter typing a short line, carriage return bell, office", 5, 0.5),
      v("old manual typewriter, slow key strikes, close mic", 4, 0.45),
      v("IBM Selectric typing, motor hum and ball strikes, quiet office at night", 4, 0.5),
    ],
  },
  {
    id: "int-phone-ring",
    group: "interactions",
    label: "Rotary phone ring",
    intent: "an old rotary desk telephone ringing with its mechanical double bell",
    variants: [
      v("Old rotary desk telephone ringing: mechanical double-bell ring, two rings with a pause, empty office", 6, 0.65),
      v("1970s desk telephone bell ringing in a distant empty room, reverberant", 6, 0.5),
      v("Single ring of a rotary telephone, loud metal bell clapper, close-mic", 3, 0.6),
    ],
  },
  {
    id: "int-phone-offhook",
    group: "interactions",
    label: "Phone off-the-hook tone",
    intent: "an analog landline telephone tone from the handset (off-hook howler, dial tone or busy signal), loopable",
    loop: true,
    variants: [
      loopV("Telephone off-hook warning tone: loud repeating electronic howler beeps through a handset earpiece, loopable", 6, 0.6),
      loopV("Analog telephone dial tone, steady tone through a handset receiver, loopable", 6, 0.65),
      loopV("Landline busy signal, repeating beep beep through a handset, loopable", 6, 0.6),
    ],
  },
  {
    id: "int-crt-whine",
    group: "interactions",
    label: "CRT whine",
    intent: "an old CRT monitor or TV powering on or off: high-pitched flyback whine, static crackle, degauss thunk",
    variants: [
      v("Old CRT monitor powering on: static crackle, degauss thunk, then a high-pitched flyback whine, close-mic", 3, 0.6),
      v("CRT television switched on: static pop and steady high-frequency whine", 3, 0.6),
      v("CRT screen switching off: static pop and a fading whine", 2.5, 0.55),
    ],
  },
  {
    id: "int-lab-glass",
    group: "interactions",
    label: "Lab glass clink",
    intent: "laboratory glassware clinking: beakers, test tubes or flasks touching, set down on a bench",
    variants: [
      v("Glass laboratory beakers clinking together on a metal tray, bright glass clinks, close-mic", 2, 0.6),
      v("Glass test tubes rattling in a wire rack, close-mic", 2, 0.55),
      v("Single glass flask set down on a lab bench, clear glass ring, close-mic", 1.5, 0.65),
    ],
  },

  // Horror stingers
  {
    id: "hor-metal-bang",
    group: "horror",
    label: "Distant metal bang",
    intent: "a single heavy metal bang somewhere far away inside a large empty building, long reverberant echo tail",
    variants: [
      v("Distant heavy metal bang inside a large empty concrete building: one impact far down a hallway, long reverb tail", 5, 0.6),
      v("Far away steel door slamming once in a concrete basement, booming echo", 5, 0.55),
      v("A steel pipe struck once in the distance, ringing metal echo through an industrial building", 5, 0.6),
    ],
  },
  {
    id: "hor-knock",
    group: "horror",
    label: "Unexplained knock",
    intent: "slow knocking on a door or wall from the other side, in a quiet empty building, unsettling",
    variants: [
      v("Three slow knocks with a knuckle on a heavy door, heard from the other side, quiet empty building", 4, 0.65),
      v("Single muffled knock from inside a wall, dull thud, quiet room", 3, 0.6),
      v("Slow knuckle knocks on a steel door, hollow metallic knocks, corridor reverb", 4, 0.6),
    ],
  },
  {
    id: "hor-drone",
    group: "horror",
    label: "Low drone",
    intent: "a low, dark, unsettling ambient drone for horror tension, no melody, loopable",
    loop: true,
    variants: [
      loopV("low ominous drone, deep sustained hum, slowly evolving, no melody", 20, 0.45),
      loopV("deep unsettling hum from far below, low frequency, no melody", 20, 0.45),
      loopV("dark low drone with faint metallic resonance, slow swells, no melody", 20, 0.4),
    ],
  },
  {
    id: "hor-radio-whisper",
    group: "horror",
    label: "Whisper-like radio interference",
    intent: "radio static with garbled, unintelligible whisper-like voices drifting in and out, eerie",
    variants: [
      v("Radio static with garbled unintelligible whispering voices fading in and out of the noise", 8, 0.55),
      v("Shortwave radio interference that sounds like breathing and whispers buried in the static", 8, 0.45),
      v("Distorted radio transmission with a faint distant voice buried in static, words impossible to make out", 8, 0.6),
    ],
  },
  {
    id: "hor-footsteps-other",
    group: "horror",
    label: "Footsteps not yours",
    intent: "someone else's slow footsteps heard at a distance: another hallway or the floor above, then stopping",
    variants: [
      v("Distant footsteps: someone walking slowly down another hallway, hard floor, heard far away through corridor reverb, then they stop", 6, 0.6),
      v("Footsteps on the floor above, muffled through the ceiling, slow pacing then stopping", 6, 0.55),
      v("Slow footsteps approaching from behind on a hard floor, then stopping abruptly, reverb", 5, 0.6),
    ],
  },
  {
    id: "hor-sub-rumble",
    group: "horror",
    label: "Deep sub-rumble from below",
    intent: "a deep low-frequency rumble coming from underground / below the floor, like huge machinery or a tremor",
    variants: [
      v("Deep sub-bass rumble from underground, low frequency tremor rising and fading, building floor vibrating", 8, 0.6),
      v("Massive machinery rumbling far below the floor, low vibration and metallic groan", 8, 0.5),
      v("Low rumble swells up from below then fades, small loose objects rattle faintly", 7, 0.6),
    ],
  },

  // Outdoor night, built from parts: a quiet airy wind bed plus sparse positional one-shots placed in the trees.
  {
    id: "amb-pine-wind",
    group: "outdoor",
    label: "Wind in the pines (bed)",
    intent: "very quiet gusting wind in pine trees at night: airy, high-frequency needle hiss that swells and fades with calm gaps between gusts; no low steady roar, no traffic or highway hum, no rain, no birds or insects, no music",
    loop: true,
    variants: [
      loopV("soft wind gusts through pine needles high in the treetops, airy breathy hiss rising and falling, calm pauses between gusts", 20, 0.6),
      loopV("light breeze sighing through pine branches, gentle airy whoosh that swells and fades, quiet", 20, 0.55),
      loopV("gusts of wind in tall pine trees, soft needle hiss far overhead, slow swells with near silence between", 20, 0.6),
    ],
  },
  {
    id: "out-owl",
    group: "outdoor",
    label: "Owl, distant",
    intent: "a single owl call (one or two soft hoots) far away in a forest at night, natural, no other animals, no music",
    variants: [
      v("a great horned owl hooting once in the distance at night, deep soft hoo hoo, forest echo", 3, 0.6),
      v("barred owl calling once far away in a pine forest at night", 3.5, 0.55),
      v("distant owl hoot, two soft low notes, cold still night, far away", 3, 0.6),
    ],
  },
  {
    id: "out-twig",
    group: "outdoor",
    label: "Twig snap",
    intent: "one twig or small branch snapping in a forest, a single dry crack, outdoors; not a gunshot, not a footstep sequence",
    variants: [
      v("single dry twig snapping in a forest, one sharp crack, medium distance", 1, 0.6),
      v("a branch snapping in the woods some distance away, one crack", 1.2, 0.55),
      v("small stick breaking on the forest floor, one snap, close mic", 1, 0.6),
    ],
  },
  {
    id: "out-cone",
    group: "outdoor",
    label: "Pine cone drop",
    intent: "a pine cone falling from a tree: maybe a tap on a branch, then a soft thud on needles or earth; one event",
    variants: [
      v("a pine cone falling through branches and landing softly on pine needles", 1.5, 0.6),
      v("pine cone dropping from a tree, one tap on a branch, then a thud on the forest floor", 1.5, 0.55),
      v("small pine cone hitting the ground, soft thump on needles, close mic", 1, 0.6),
    ],
  },
  {
    id: "out-creak",
    group: "outdoor",
    label: "Trunk creak",
    intent: "a tall tree trunk or branches creaking slowly in the wind: a wooden creak or groan, outdoors; not a door hinge",
    variants: [
      v("tall pine trunk creaking slowly in the wind, deep wooden groan", 3, 0.6),
      v("two tree branches rubbing together in the wind, slow wooden creak", 3, 0.55),
      v("old pine tree creaking under its own weight, one long wooden creak, distant", 3, 0.6),
    ],
  },
  {
    id: "out-rustle",
    group: "outdoor",
    label: "Leaf and needle rustle",
    intent: "a brief rustle of pine branches or undergrowth outdoors: needles shaking in a gust or a small animal moving through brush; short",
    variants: [
      v("brief rustle of pine branches in a gust, needles shaking", 2, 0.6),
      v("something small moving through undergrowth, short rustle, medium distance", 2, 0.55),
      v("pine boughs swaying, soft needle rustle, one gust", 2, 0.6),
    ],
  },
  {
    id: "out-far-animal",
    group: "outdoor",
    label: "Far-off dog / coyote",
    intent: "a dog barking or a coyote howling very far away at night, faint, with distance echo; no music",
    variants: [
      v("a dog barking twice far away across a valley at night, faint distant echo", 3.5, 0.6),
      v("lone coyote howl far in the distance at night, faint echo", 4, 0.6),
      v("farm dog barking three times very far away, faint", 3.5, 0.55),
    ],
  },

  // Monsters (ASHWOOD): banshee, skinwalker, wendigo. Audition only; not wired into the game.
  {
    id: "ban-keen-wail",
    group: "monsters",
    subgroup: "Banshee",
    label: "Keening wail",
    intent: "a long mournful female keening wail rising like an Irish lament, distant and reverberant, eerie; no music or instruments",
    variants: [
      v("long mournful female keening wail rising and falling, Irish lament, distant, reverberant, night", 6, 0.6),
      v("distant woman keening, a slow rising wail of grief, echoing across a misty valley", 6, 0.55),
      v("ghostly female wail, long and rising, sorrowful, far away in a stone hall, long reverb", 5, 0.6),
    ],
  },
  {
    id: "ban-scream-near",
    group: "monsters",
    subgroup: "Banshee",
    label: "Scream, near",
    intent: "a close, piercing, unnatural female shriek that breaks into harsh distortion, horror; short",
    variants: [
      v("close piercing female shriek, unnatural and inhuman, breaking into harsh distortion", 2.5, 0.6),
      v("banshee scream right in front of you, shrill, cracking into a distorted screech", 2.5, 0.55),
      v("sudden shrill ghostly female scream, very close, ragged and distorted at the peak", 2, 0.6),
    ],
  },
  {
    id: "ban-scream-far",
    group: "monsters",
    subgroup: "Banshee",
    label: "Scream, far",
    intent: "the same unnatural female shriek heard far away, through a building or across woods: muffled, distant, reverberant",
    variants: [
      v("distant unnatural female shriek far across the woods at night, faint echo", 4, 0.6),
      v("a woman screaming somewhere far away inside a concrete building, muffled through walls", 4, 0.55),
      v("faint ghostly scream from far off in a misty forest, long reverberant tail", 4.5, 0.6),
    ],
  },
  {
    id: "ban-weeping",
    group: "monsters",
    subgroup: "Banshee",
    label: "Weeping (loop)",
    intent: "soft female sobbing and breathy weeping just out of sight, quiet, intimate, eerie, loopable; no music",
    loop: true,
    variants: [
      loopV("soft female sobbing and breathy weeping, quiet, just out of sight, empty room", 6, 0.6),
      loopV("a woman weeping quietly in the dark, shaky breaths and soft sobs, slight echo", 6, 0.55),
      loopV("faint ghostly weeping, breathy sobs drifting in a cold hallway, distant", 5, 0.55),
    ],
  },
  {
    id: "ban-whisper-breath",
    group: "monsters",
    subgroup: "Banshee",
    label: "Whisper and breath",
    intent: "a cold breathy exhale and one faint whispered word right at the ear, very close; short",
    variants: [
      v("cold breathy exhale and a faint whispered word right at the ear, very close", 1.5, 0.6),
      v("a woman's whisper in your ear, one word, breathy and cold, close mic", 1.5, 0.55),
      v("slow ghostly breath on the ear followed by a soft unintelligible whisper", 2, 0.6),
    ],
  },
  {
    id: "ban-presence",
    group: "monsters",
    subgroup: "Banshee",
    label: "Presence drone (loop)",
    intent: "a low eerie airy tone with faint choral breath, sustained, for when a ghostly woman is near, loopable; no melody, no beat",
    loop: true,
    variants: [
      loopV("low eerie airy tone with faint breathy female choir, sustained, haunting, no melody", 8, 0.55),
      loopV("cold ghostly drone, soft airy hum with distant breathing voices, slow swells", 8, 0.5),
      loopV("dark sustained pad of breath and faint female voices, very low, unsettling, still", 8, 0.55),
    ],
  },
  {
    id: "skin-wrong-laugh",
    group: "monsters",
    subgroup: "Skinwalker",
    label: "Wrong laugh",
    intent: "a human laugh that is slightly off in pitch and timing, too long and repeated, uncanny; almost human but not quite",
    variants: [
      v("a man's laugh slightly off in pitch and timing, going on too long, repeating, uncanny", 4, 0.6),
      v("unnatural human laughter in the dark woods, flat and repetitive, wrong rhythm", 4, 0.55),
      v("distant laugh that repeats the same way over and over, slightly warped pitch, creepy", 4, 0.6),
    ],
  },
  {
    id: "skin-call-far",
    group: "monsters",
    subgroup: "Skinwalker",
    label: "Far call",
    intent: "a distant human-like call in the woods at night that is subtly wrong, almost human but not quite",
    variants: [
      v("a man calling hello in the distant woods at night, unnatural cadence, slightly wrong voice", 3.5, 0.6),
      v("distant voice calling help me from the trees, flat and slightly warped, uncanny", 3.5, 0.55),
      v("faraway shout of hello, repeated with the exact same wrong intonation, echoing forest", 4, 0.6),
    ],
  },
  {
    id: "skin-cry-growl",
    group: "monsters",
    subgroup: "Skinwalker",
    label: "Cry into growl",
    intent: "a baby or child crying that gradually turns into an animal sound; horror; no music",
    variants: [
      v("a baby crying in the dark woods that slowly turns into an animal screech", 4, 0.6),
      v("child sobbing in the distance, the cry warping into a wild animal howl", 4, 0.55),
      v("infant wail at night that becomes a guttural animal cry, distant, eerie", 4, 0.6),
    ],
  },
  {
    id: "skin-animal-human",
    group: "monsters",
    subgroup: "Skinwalker",
    label: "Animal-human scream",
    intent: "a coyote or elk-like scream that ends in a human gasp; uncanny",
    variants: [
      v("coyote scream in the night forest ending in a sharp human gasp", 3, 0.6),
      v("elk bugle scream that breaks into a human gasp, distant, eerie", 3, 0.55),
      v("wild animal shriek that ends with a man's sudden intake of breath, close", 2.5, 0.6),
    ],
  },
  {
    id: "skin-clicks-breath",
    group: "monsters",
    subgroup: "Skinwalker",
    label: "Clicks and breath",
    intent: "wet throat clicks and fast huffing breaths of a creature, very close; no voice words",
    variants: [
      v("wet throat clicks and fast huffing breaths of a creature, very close, dark", 2.5, 0.6),
      v("creature breathing fast through its nose with wet clicking in the throat, close mic", 2.5, 0.55),
      v("rapid animal huffing and moist clicking sounds right behind you", 2, 0.6),
    ],
  },
  {
    id: "skin-footsteps-wrong",
    group: "monsters",
    subgroup: "Skinwalker",
    label: "Footsteps that change",
    intent: "bipedal footsteps on a forest floor that shift into a four-legged gallop; uncanny",
    variants: [
      v("footsteps walking on forest floor that suddenly change into a four-legged gallop", 4, 0.6),
      v("a person walking through leaves, then breaking into a fast animal gallop on all fours", 4, 0.55),
      v("two-legged steps on dirt and needles turning into heavy quadruped running, close", 4, 0.6),
    ],
  },
  {
    id: "wen-bone-creak",
    group: "monsters",
    subgroup: "Wendigo",
    label: "Bone creak",
    intent: "dry joint and bone cracking and creaking as something very tall moves slowly, close; horror foley",
    variants: [
      v("dry bones and joints cracking and creaking slowly as something very tall moves, close mic", 3, 0.6),
      v("slow knuckle and spine cracking, brittle bone creaks, close, quiet room", 3, 0.55),
      v("long creaking of stiff joints and popping bones, a gaunt creature unfolding", 3, 0.6),
    ],
  },
  {
    id: "wen-clicks",
    group: "monsters",
    subgroup: "Wendigo",
    label: "Clicks",
    intent: "rapid dry clicking or chattering teeth like a predator in the dark; short",
    variants: [
      v("rapid dry clicking and chattering teeth in the dark, predator, close", 2.5, 0.6),
      v("teeth chattering fast, dry clicks from the dark woods, medium distance", 2.5, 0.55),
      v("bony clicking sounds in quick bursts, like a creature's jaw, eerie", 2, 0.6),
    ],
  },
  {
    id: "wen-starving-breath",
    group: "monsters",
    subgroup: "Wendigo",
    label: "Starving breath",
    intent: "ragged deep hungry breathing with a faint rattle, close behind the listener; no words",
    variants: [
      v("ragged deep hungry breathing with a faint rattle, close behind you", 4, 0.6),
      v("slow starving breaths of a large creature, wheezing rattle in the chest, close mic", 4, 0.55),
      v("heavy hollow breathing in the dark, raspy rattle, right behind your head", 3.5, 0.6),
    ],
  },
  {
    id: "wen-antler-scrape",
    group: "monsters",
    subgroup: "Wendigo",
    label: "Antler scrape",
    intent: "antlers or bone dragging and scraping along wood, a tree trunk or a wall; slow",
    variants: [
      v("antlers scraping slowly along a tree trunk, bone on bark, forest at night", 3, 0.6),
      v("bone dragging along a wooden wall, long scrape and knock, empty building", 3, 0.55),
      v("antlers scratching against wood planks, slow grinding scrape, close", 3, 0.6),
    ],
  },
  {
    id: "wen-distant-moan",
    group: "monsters",
    subgroup: "Wendigo",
    label: "Distant moan",
    intent: "a long hollow starving moan far off in the woods, almost like wind; eerie, no music",
    variants: [
      v("long hollow moan far off in the woods at night, almost like wind, starving", 6, 0.6),
      v("distant mournful creature moan drifting through the trees, airy, faint", 6, 0.55),
      v("faraway hollow groan rising and fading into the wind, cold forest", 6, 0.6),
    ],
  },
  {
    id: "wen-feeding",
    group: "monsters",
    subgroup: "Wendigo",
    label: "Feeding (other room)",
    intent: "muffled wet tearing and crunching heard from another room, restrained, horror",
    variants: [
      v("muffled wet tearing and crunching heard from another room, restrained", 4, 0.6),
      v("something eating behind a closed door, wet chewing and bone crunching, muffled", 4, 0.55),
      v("faint gruesome feeding sounds through a wall, tearing and cracking, quiet", 4, 0.6),
    ],
  },
  {
    id: "wen-silence-sting",
    group: "monsters",
    subgroup: "Wendigo",
    label: "Silence sting",
    intent: "a sudden drop to near silence with a high thin ringing tone, for the moment the forest goes quiet; 3 s",
    variants: [
      v("sudden drop to near silence, a high thin ringing tone in the ears", 3, 0.6),
      v("all sound cuts out, faint high pitched tinnitus ring, eerie stillness", 3, 0.55),
      v("forest goes silent, soft whoosh then a thin high ringing tone", 3, 0.6),
    ],
  },

  // UI
  {
    id: "ui-notify",
    group: "ui",
    label: "Subtle notification",
    intent: "a subtle short soft interface notification blip, retro electronic, unobtrusive",
    variants: [
      v("soft single electronic blip, quiet, 1980s computer terminal", 1, 0.5),
      v("subtle short beep from an old terminal, close mic", 1, 0.45),
      v("gentle two note electronic chime, quiet, minimal", 1.5, 0.45),
      v("soft pager chirp, short, quiet", 1, 0.45),
    ],
  },
]

export function intentFor(categoryId: string, variant: string): string {
  const cat = CATEGORIES.find((c) => c.id === categoryId)
  if (!cat) return ""
  return cat.variants[Number(variant.slice(1)) - 1]?.intent ?? cat.intent
}
