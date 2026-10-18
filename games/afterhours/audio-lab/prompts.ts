// Candidate SFX prompts for the Afterhours audio lab.
//
// ElevenLabs does best with literal sound-design descriptions: the exact object, its material, the action, the
// consequence sound, mic perspective, the space, and the length; no music or voices unless intended. The model
// prompt for this file is breaker v3 ("industrial knife switch pulled, power shuts off with descending hum"):
// one object, one action, one consequence.
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
}

export interface CategorySpec {
  id: string
  group: string
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

export const CATEGORIES: CategorySpec[] = [
  // Footsteps
  {
    id: "foot-linoleum",
    group: "footsteps",
    label: "Footsteps: waxed linoleum corridor",
    intent: "one person walking at a slow steady pace in leather work boots on a waxed linoleum hallway floor, indoor corridor reverb, no music",
    variants: [
      v("Footsteps: leather work boots walking slowly on waxed linoleum, hard heel taps, long empty institutional hallway, short reverb, close-mic, 5 seconds", 5, 0.6),
      v("Rubber-soled boots walking steadily on polished vinyl floor tiles, soft squeak every few steps, empty concrete corridor reverb, 5 seconds", 5, 0.5),
      v("Single person walking on linoleum floor, one step per half second, heel then sole contact, tiled hallway echo, medium distance", 5, 0.6),
      v("Slow cautious footsteps on waxed linoleum, sneaker rubber squeaks, quiet empty hallway, close-mic", 5, 0.45),
    ],
  },
  {
    id: "foot-carpet",
    group: "footsteps",
    label: "Footsteps: office carpet",
    intent: "one person walking slowly in boots on thin commercial office carpet, muffled soft thuds, small quiet room",
    variants: [
      v("Footsteps: work boots walking slowly on thin low-pile office carpet, muffled soft thuds with faint fabric scuff, small quiet office, close-mic, 4 seconds", 4, 0.6),
      v("Person walking on carpet tiles over a concrete floor, dull padded footfalls, dead dry room, 4 seconds", 4, 0.5),
      v("Slow heavy steps on commercial carpet, soft thump and slight shoe scrape, quiet carpeted room, close-mic", 4, 0.65),
    ],
  },
  {
    id: "foot-stairwell",
    group: "footsteps",
    label: "Footsteps: concrete stairwell",
    intent: "one person walking on concrete stairs inside a hard, echoing concrete fire stairwell, boots on concrete steps",
    variants: [
      v("Footsteps: boots walking down concrete stairs, regular step rhythm, gritty concrete contact, big hard concrete stairwell echo, 6 seconds", 6, 0.6),
      v("Footsteps climbing concrete stairs in a fire stairwell, occasional hand tap on a steel handrail, hollow reverberant space, 6 seconds", 6, 0.5),
      v("Person running up concrete stairs, fast boot steps, loud stairwell reverb, 5 seconds", 5, 0.5),
      v("Slow heavy boot steps on concrete stair treads with grit scrape, close-mic, concrete stairwell reverb tail", 5, 0.65),
    ],
  },
  {
    id: "foot-grating",
    group: "footsteps",
    label: "Footsteps: metal grating catwalk",
    intent: "one person walking in boots on a steel grating catwalk, metallic clank and ring per step, industrial room",
    variants: [
      v("Footsteps: boots walking on a steel bar-grating catwalk, metallic clank and short ring with each step, loose panel rattle, large machine room, 5 seconds", 5, 0.6),
      v("Person walking across a metal mesh walkway, hollow metal footfalls, grate panels rattling in frames, industrial hall reverb", 5, 0.5),
      v("Slow boot steps on steel diamond plate floor over a hollow space, dull metallic thud per step, close-mic", 5, 0.6),
    ],
  },
  {
    id: "foot-wet-asphalt",
    group: "footsteps",
    label: "Footsteps: wet asphalt",
    intent: "one person walking on wet asphalt outdoors at night, wet splashy shoe contacts, open outdoor space",
    variants: [
      v("Footsteps: boots walking on wet asphalt, wet slap and splash of each step, thin water layer, open outdoor parking lot, no rain, 5 seconds", 5, 0.6),
      v("Person walking slowly through shallow puddles on a wet road, splashing steps, quiet outdoors, close-mic", 5, 0.5),
      v("Shoes walking on damp gritty asphalt, light wet scuff per step, outdoor open air, medium distance", 5, 0.6),
    ],
  },
  {
    id: "foot-gravel",
    group: "footsteps",
    label: "Footsteps: gravel",
    intent: "one person walking on loose gravel outdoors, crunchy stone steps",
    variants: [
      v("Footsteps: boots walking slowly on loose gravel, crisp stone crunch with each step, outdoors, close-mic, 5 seconds", 5, 0.6),
      v("Person walking on a gravel road shoulder, steady crunching footsteps, open air", 5, 0.5),
      v("Slow careful steps on coarse gravel, individual stones shifting underfoot, close-mic", 5, 0.65),
    ],
  },
  {
    id: "foot-forest",
    group: "footsteps",
    label: "Footsteps: forest floor",
    intent: "one person walking on a damp pine forest floor: soft needles, earth, occasional twig snap, outdoors",
    variants: [
      v("Footsteps: boots walking on damp pine needles and soft earth, quiet crunch, one small twig snaps, outdoor forest, close-mic, 6 seconds", 6, 0.6),
      v("Person walking through damp forest undergrowth, soft leafy footfalls and brushing low plants, quiet outdoors", 6, 0.5),
      v("Slow steps on wet forest floor with fallen pine needles, muffled soft footfalls, a dry stick cracks underfoot", 6, 0.6),
    ],
  },

  // Doors
  {
    id: "door-fire-steel",
    group: "doors",
    label: "Heavy steel fire door open/close",
    intent: "a heavy steel fire door in a concrete corridor opening on a hydraulic closer and closing with a heavy metallic latch slam",
    variants: [
      v("Heavy steel fire door: lever handle turns, door swings open with closer hiss, then swings shut with a deep metallic boom and latch click, concrete hallway reverb, 4 seconds", 4, 0.6),
      v("Heavy steel door closing slowly on a hydraulic door closer, ends with a loud metal latch clunk, echoing concrete corridor", 3.5, 0.6),
      v("Hollow steel security door slammed shut, heavy metallic bang and latch, short concrete room reverb", 2.5, 0.6),
      v("Steel fire door pushed open, hinges groan, closer arm creaks, door thuds closed against its metal frame", 4, 0.5),
    ],
  },
  {
    id: "door-office-wood",
    group: "doors",
    label: "Wooden office door creak",
    intent: "an old wooden office door opening slowly with a creaking hinge, small quiet room",
    variants: [
      v("Old wooden office door opens slowly, dry metal hinge creaks for two seconds, small quiet room, close-mic", 3.5, 0.6),
      v("Wooden door with squeaky hinges creaking open slowly, long drawn-out hinge creak, quiet interior", 4, 0.5),
      v("Brass doorknob turns, latch clicks, wooden door opens with a short creak and closes softly with a latch click", 3, 0.6),
    ],
  },
  {
    id: "door-panic-bar",
    group: "doors",
    label: "Panic bar push",
    intent: "pushing the metal panic/crash bar of an emergency exit door: loud spring latch clack and the steel door swinging open",
    variants: [
      v("Push bar on a steel emergency exit door pressed hard: loud spring-loaded latch clack, metal rattle, door swings open, close-mic", 2.5, 0.65),
      v("Crash bar exit door: metal bar depressed with a clunk, latch releases, steel door opens to outdoors", 2.5, 0.55),
      v("Panic bar door pushed open with a clack, heavy steel door swings, then closes behind with a metallic thud", 4, 0.5),
    ],
  },
  {
    id: "door-rollup-dock",
    group: "doors",
    label: "Roll-up loading dock door",
    intent: "a large corrugated steel roll-up loading dock door being raised or lowered: rumbling, rattling metal slats",
    variants: [
      v("Corrugated steel roll-up loading dock door pulled open by hand chain, clinking chain and rumbling rattling steel slats, warehouse, 6 seconds", 6, 0.6),
      v("Rolling steel shutter door rising on an electric motor, motor whine and clattering slats, warehouse reverb, 7 seconds", 7, 0.55),
      v("Roll-up steel garage door pulled down and slammed shut on concrete, metal crash and slat rattle", 3, 0.6),
    ],
  },
  {
    id: "gate-chainlink",
    group: "doors",
    label: "Chain-link gate rattle",
    intent: "a chain-link fence gate rattling and swinging, metal chain and fence wire jingling, outdoors at night",
    variants: [
      v("Chain-link fence gate swung open by hand, wire mesh rattle, loose chain jingling against the steel post, outdoors, close-mic", 4, 0.6),
      v("Shaking a locked chain-link gate, padlock and steel chain clanking against the mesh, outdoors", 3, 0.6),
      v("Wind rattling a loose chain-link gate against its post, intermittent metallic clinks, distant, outdoors", 5, 0.45),
    ],
  },
  {
    id: "gate-motorized",
    group: "doors",
    label: "Motorized sliding gate",
    intent: "a motorized steel security sliding gate rolling along its ground track, electric motor hum, ends with a stop clunk, outdoors",
    variants: [
      v("Motorized steel sliding security gate opening: relay click, electric gear motor hum, steel wheels rolling on a ground rail, stops with a clunk, outdoors, 8 seconds", 8, 0.6),
      v("Chain-driven sliding steel gate moving along a track, grinding rollers and chain rattle, outdoor parking lot", 8, 0.5),
      v("Old electric gate operator starting with a relay clack, slow rumbling slide, stopping with a heavy metal clunk", 6, 0.6),
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
      loopV("Inside an old elevator car moving between floors: steady low electric motor hum, faint cable whir, gentle cabin rumble, loopable", 10, 0.6),
      loopV("Freight elevator traveling: constant motor drone, cabin walls rattling softly, steady, loopable", 10, 0.5),
      loopV("Elevator machine room: hoist motor running at constant speed, deep electric hum, occasional relay click, loopable", 10, 0.55),
    ],
  },
  {
    id: "lift-cable",
    group: "lift",
    label: "Lift cable creak",
    intent: "steel elevator cables and pulleys creaking and groaning under tension inside an elevator shaft",
    variants: [
      v("Steel elevator cables creaking and groaning under tension inside a tall shaft, slow metal stress sounds, hollow shaft reverb", 6, 0.6),
      v("Elevator pulley sheave turning slowly, steel cable creak and metallic groan, shaft echo", 6, 0.5),
      v("Old elevator car swaying slightly on its cables, metal creak and small ticks, inside the car", 5, 0.6),
    ],
  },
  {
    id: "lift-ding",
    group: "lift",
    label: "Lift arrival ding (1980s)",
    intent: "a single mechanical elevator arrival bell ding from an 1980s office building elevator",
    variants: [
      v("Single elevator arrival bell: one mechanical ding from a small metal bell, short ring-out, 1980s office building", 2, 0.7),
      v("Old elevator hall lantern chime, one electronic bing tone, office lobby", 2, 0.6),
      v("Vintage elevator floor bell, one soft ding with brief ring-out, quiet hallway", 2, 0.5),
    ],
  },
  {
    id: "lift-stall",
    group: "lift",
    label: "Lift stall / clunk",
    intent: "an elevator car stopping suddenly between floors: heavy mechanical clunk/jolt, motor winding down",
    variants: [
      v("Elevator car stops suddenly between floors: heavy brake clamp clunk, cabin jolts, motor hum winds down to silence, inside the car", 4, 0.6),
      v("Elevator jolting to a halt, loud mechanical thud, steel cable twang, cabin rattle", 3, 0.55),
      v("Old elevator shuddering to a stop, metal grinding then a heavy clunk, then silence", 4, 0.6),
    ],
  },
  {
    id: "lift-scissor-gate",
    group: "lift",
    label: "Lift scissor gate",
    intent: "an old freight elevator's collapsible steel scissor/accordion gate being pulled open or shut, rattling metal lattice and latch",
    variants: [
      v("Freight elevator collapsible steel scissor gate pulled shut by hand, metal lattice clattering, latch snaps closed, close-mic", 3, 0.65),
      v("Accordion steel elevator gate pulled open, folding metal lattice rattling and squeaking", 3, 0.6),
      v("Steel scissor gate slammed closed, metal crash and rattle, freight elevator", 2.5, 0.6),
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
      loopV("Overhead fluorescent tube lights: steady 60 hertz electrical hum and ballast buzz, quiet room, loopable", 10, 0.65),
      loopV("Buzzing fluorescent light fixture in an empty office, constant electrical hum, close-mic, loopable", 10, 0.55),
      loopV("Old magnetic fluorescent ballast drone with a faint high-pitched whine, loopable", 10, 0.5),
    ],
  },
  {
    id: "light-fluoro-flicker",
    group: "lights",
    label: "Fluorescent flicker / starter tick",
    intent: "a fluorescent tube light flickering on: starter ticking, buzzing pings, then steady hum",
    variants: [
      v("Fluorescent tube light switching on: starter clicks tick tick, tube buzzes and pings while flickering, then settles into a steady hum", 4, 0.6),
      v("Faulty fluorescent light flickering, irregular electrical buzz bursts and pings, close-mic", 5, 0.5),
      v("Fluorescent starter clicking repeatedly, tube struggling to light with short buzzes", 4, 0.6),
    ],
  },
  {
    id: "light-sodium-buzz",
    group: "lights",
    label: "Sodium lamp buzz",
    intent: "outdoor high-pressure sodium street/parking lamp humming overhead at night, steady electrical buzz, loopable",
    loop: true,
    variants: [
      loopV("Outdoor sodium vapor street lamp humming overhead at night, steady electrical buzz from the pole-top ballast, quiet open air, loopable", 10, 0.6),
      loopV("Parking lot light pole buzzing, constant high-voltage hum, quiet night outdoors, loopable", 10, 0.5),
      loopV("Close-mic streetlight ballast hum, low steady electrical drone, loopable", 10, 0.6),
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
    label: "Night pine forest, distant wind",
    intent: "quiet night pine forest ambience with distant wind in the trees, sparse and cold, no music, loopable",
    loop: true,
    variants: [
      loopV("Night pine forest ambience: distant wind moving through pine treetops, soft swells, sparse quiet crickets, still and cold, loopable", 22, 0.5),
      loopV("Foggy night in a pine forest: gentle gusts in the branches, very occasional distant owl hoot, loopable", 22, 0.45),
      loopV("Still night forest: faint breeze, water drips from branches onto needles, no animals, loopable", 22, 0.55),
    ],
  },
  {
    id: "amb-rain-asphalt",
    group: "ambience",
    label: "Rain drizzle on asphalt",
    intent: "light rain drizzle falling on an asphalt parking lot at night, steady gentle patter, loopable",
    loop: true,
    variants: [
      loopV("Light rain drizzle on an asphalt parking lot at night: steady gentle patter, small puddle drips, no thunder, loopable", 20, 0.6),
      loopV("Soft drizzle on a wet road and parked car roofs, a gutter dripping nearby, loopable", 20, 0.5),
      loopV("Misty light rain hissing softly on pavement, outdoors, no thunder, loopable", 20, 0.6),
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
      loopV("Room tone of an empty tiled hallway at night: very quiet air hiss, faint distant fluorescent hum, loopable", 20, 0.6),
      loopV("Silent empty institutional corridor: subtle air movement, faint far-off ventilation, loopable", 20, 0.5),
      loopV("Quiet hallway room tone, low faint electrical hum, occasional soft building creak, loopable", 20, 0.55),
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
      v("Janitor's yellow plastic mop bucket on casters pushed across a tile floor: small wheels rattle, water sloshes inside, hallway, 5 seconds", 5, 0.6),
      v("Squeaky caster wheels of a janitor cart rolling along a tiled corridor", 5, 0.5),
      v("Mop pushed into a bucket wringer and squeezed: water squelch and drips into the bucket", 3, 0.6),
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
      v("Electric typewriter typing a short sentence: rapid mechanical key strikes, motor hum, carriage return and bell, close-mic", 5, 0.6),
      v("Manual typewriter typing slowly: loud individual key strikes, close-mic", 4, 0.55),
      v("IBM Selectric burst of typing: golf-ball strikes and motor hum, office", 4, 0.6),
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
      loopV("Low dark ambient drone: deep sustained tone slowly evolving, no melody, unsettling, loopable", 20, 0.5),
      loopV("Deep sustained hum with slow beating between two close low frequencies, tense, no melody, loopable", 20, 0.55),
      loopV("Dark ambient drone with faint metallic resonance and slow swells, no melody, loopable", 20, 0.45),
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

  // UI
  {
    id: "ui-notify",
    group: "ui",
    label: "Subtle notification",
    intent: "a subtle short soft interface notification blip, retro electronic, unobtrusive",
    variants: [
      v("Subtle soft UI notification: one gentle short electronic blip, retro", 1, 0.6),
      v("Quiet single analog beep from a 1980s computer terminal", 1, 0.65),
      v("Short soft two-note electronic chime, minimal interface sound", 1.5, 0.5),
      v("Pager beep: one short soft electronic chirp", 1, 0.6),
    ],
  },
]
