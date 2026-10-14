// Every recorded sound slot in the game (discrete one-shots and ambience beds; nothing that follows live state: jet
// engines, afterburners, cockpit, wind, flybys, the sonic crack, the M61 and rounds zipping past are procedural, see
// jet-engine.ts and gun-audio.ts): what it is, its category (loaded together), whether it loops, how many
// candidate takes it has in public/sfx/v3/<id>-<n>.ogg, and the ElevenLabs prompt each take came from
// (scripts/sfx-cinematic.ts generates and transcodes them). Which take plays is the user's pick (sfx-bank.ts: picks.json,
// overridden in localStorage from the SOUNDS tab). DOM-free data.

export type SlotCategory = "carrier" | "gun" | "missile" | "bomb" | "boom" | "ship" | "sea" | "ui" | "hooks"

export type Slot = {
  id: string
  category: SlotCategory
  label: string
  loop: boolean
  /** Candidate takes (1..count). */
  count: number
  /** Generated duration (s). */
  dur: number
  prompt: string
}

const C = "cinematic, high fidelity, no music, no voice"
const L = "cinematic, high fidelity, seamless loop, steady, no music, no voice"

/** [id, category, label, loop, count, duration, prompt]. */
const RAW: readonly (readonly [string, SlotCategory, string, boolean, number, number, string])[] = [
  // Carrier operations.
  ["trap", "carrier", "Arrested landing", false, 4, 5, `Fighter jet arrested landing on an aircraft carrier: heavy tyre thud and chirp on the steel deck, the arresting cable screaming as it pays out, engines spooling down, deep metallic thump, ${C}`],
  // Gun impacts (the M61 itself is procedural: gun-audio.ts).
  ["impact-water", "gun", "Rounds into water", false, 3, 2, `Bullets ripping into the ocean surface: rapid sharp water splashes and spray, ${C}`],
  ["impact-metal", "gun", "Rounds into metal", false, 3, 2, `Cannon rounds hitting a metal aircraft: sharp metallic impacts, sparks, ringing debris, ${C}`],
  // Missiles and countermeasures.
  ["missile-launch", "missile", "Missile launch", false, 4, 4, `Air-to-air missile launching from a fighter jet rail: ignition pop, ferocious rocket motor whoosh tearing away into the distance, deep sub, ${C}`],
  ["missile-motor", "missile", "Missile motor (loop)", true, 3, 4, `Rocket motor of a missile in flight, ferocious hissing roar, ${L}`],
  ["flares", "missile", "Flares", false, 4, 3, `Fighter jet firing countermeasure flares: rapid sequence of sharp pops and fizzing burning hiss, ${C}`],
  // Bombs.
  ["bomb-release", "bomb", "Bomb release", false, 3, 1.5, `Bomb released from an aircraft pylon: heavy metallic clunk and latch release, close, ${C}`],
  ["bomb-whistle", "bomb", "Bomb whistle", false, 3, 4, `Falling bomb whistle descending in pitch, subtle, ${C}`],
  ["water-geyser", "bomb", "Water geyser", false, 3, 5, `Huge water geyser erupting from the sea after an explosion: massive splash, water falling back like heavy rain, ${C}`],
  // Explosions.
  ["boom-air", "boom", "Jet shot down", false, 4, 6, `Fighter jet exploding in mid-air, film trailer explosion: sharp transient crack, huge fireball whoomp with deep sub, metal debris scattering, long rolling thunder tail echoing across the sky, ${C}`],
  ["boom-missile", "boom", "Missile airburst", false, 4, 4, `Missile proximity warhead detonating in the sky: sharp punchy crack, shrapnel burst, deep sub, short rolling echo, ${C}`],
  ["boom-bomb-land", "boom", "Bomb on land", false, 4, 6, `Heavy bomb exploding on an island, film trailer explosion: devastating transient crack, massive deep body, earth and debris raining down, long rolling rumble tail, ${C}`],
  ["boom-bomb-water", "boom", "Bomb on water", false, 4, 6, `Bomb exploding just under the sea surface: deep concussive underwater thump, huge water geyser eruption, water raining down, deep sub, ${C}`],
  ["boom-crash-sea", "boom", "Crash into sea", false, 4, 5, `Fighter jet slamming into the ocean at high speed: violent impact, tearing metal, enormous water splash, no fire, deep sub, ${C}`],
  ["boom-crash-land", "boom", "Crash into land or ship", false, 4, 6, `Fighter jet crashing into the ground: brutal metal impact crunch, roaring fuel fireball, debris, rolling tail, deep sub, ${C}`],
  ["boom-far", "boom", "Explosion far away", false, 4, 6, `Distant explosion miles away across the ocean: muffled deep boom, long rolling thunder-like rumble echoing off the water, ${C}`],
  // Ship.
  ["carrier-bed", "ship", "Carrier deck ambience", true, 4, 8, `On the deck of an aircraft carrier at sea: deep steady hull hum, distant machinery, sea wind across the deck, waves against the hull far below, ambience, ${L}`],
  ["ship-horn", "ship", "Ship horn", false, 3, 5, `Huge aircraft carrier horn blast, deep and long, echoing across the open ocean, ${C}`],
  ["hull-slam", "ship", "Hull slam", false, 4, 4, `Giant steel warship bow slamming into a big wave: deep booming impact, shuddering steel, heavy spray, ${C}`],
  ["hull-creak", "ship", "Hull creak", false, 3, 5, `Steel hull of a large warship creaking and groaning under stress in a storm, deep metallic moans, ${C}`],
  ["deck-fire", "ship", "Deck fire (loop)", true, 3, 6, `Large fire burning on a steel ship deck, roaring crackling flames, ${L}`],
  ["sinking", "ship", "Ship sinking", false, 3, 6, `Huge warship sinking: deep tortured metal groans, muffled internal explosions, rushing water, ${C}`],
  // Sea and weather.
  ["ocean-calm", "sea", "Ocean calm", true, 4, 8, `Open ocean far from land on a calm day, gentle rolling swells and soft wave wash, wide stereo ambience, no birds, ${L}`],
  ["ocean-rough", "sea", "Ocean rough", true, 4, 8, `Open ocean in a strong breeze, rolling whitecaps, waves breaking and crashing, wide stereo ambience, no birds, ${L}`],
  ["ocean-storm", "sea", "Ocean storm", true, 4, 8, `Violent storm at sea, huge waves crashing, heavy surf, roaring spray, wide stereo, ${L}`],
  ["wind-light", "sea", "Wind light", true, 3, 7, `Steady light sea breeze over open water, soft airy wind, wide stereo ambience, ${L}`],
  ["wind-gale", "sea", "Wind gale", true, 4, 7, `Gale force wind howling over the open ocean, gusting and moaning, wide stereo, ${L}`],
  ["rain-light", "sea", "Rain light", true, 3, 7, `Light rain falling on the ocean surface, soft fine patter, wide stereo ambience, no thunder, ${L}`],
  ["rain-heavy", "sea", "Rain heavy", true, 4, 7, `Heavy downpour on the open ocean, dense roaring rain hiss, wide stereo, no thunder, ${L}`],
  ["rain-canopy", "sea", "Rain on canopy", true, 3, 7, `Heavy rain drumming on a fighter jet canopy and metal fuselage, heard from inside the cockpit, no thunder, ${L}`],
  ["thunder-near", "sea", "Thunder near", false, 4, 7, `Lightning strike very close: blinding sharp crack splitting the air, massive thunder boom, deep sub, long rolling rumble, no rain, ${C}`],
  ["thunder-far", "sea", "Thunder far", false, 4, 8, `Distant thunder over the ocean: deep long rolling rumble, no rain, ${C}`],
  ["lightning-crack", "sea", "Lightning crack", false, 3, 3, `Close lightning bolt crack: violent electric snap and tearing crack, ${C}`],
  // Interface.
  ["ui-click", "ui", "UI click", false, 3, 0.5, "Premium minimal user interface click, soft tactile tick, clean, subtle, no music, no voice"],
  ["ui-kill", "ui", "Kill confirm", false, 3, 1.5, "Satisfying subtle kill confirmation for a military game, deep soft thump with a short clean metallic ping, premium, no music, no voice"],
  // For the gunnery and boat audio (wired by their owners through sfx-bank.ts).
  ["ciws", "hooks", "CIWS (loop)", true, 3, 5, `Phalanx CIWS close-in weapon system firing continuously: brutal tearing brrrt of a 20 mm gatling gun, deep body, ${L}`],
  ["sam-launch", "hooks", "SAM launch", false, 3, 5, `Surface-to-air missile launching from a warship vertical launch cell: explosive ignition blast, roaring rocket climbing away, deep sub, ${C}`],
  ["naval-gun", "hooks", "5-inch gun", false, 3, 4, `Five-inch naval deck gun firing: massive concussive boom, deep sub, rolling echo across the ocean, ${C}`],
  ["boat-engine", "hooks", "Boat engine (loop)", true, 3, 7, `Fast patrol boat with waterjet engines running at speed, exterior: diesel drone, waterjet whine, rushing water and spray, ${L}`],
]

export const SLOTS: readonly Slot[] = RAW.map(([id, category, label, loop, count, dur, prompt]) => ({ id, category, label, loop, count, dur, prompt }))
export const SLOT_BY_ID: ReadonlyMap<string, Slot> = new Map(SLOTS.map((s) => [s.id, s]))
export const CATEGORIES: readonly SlotCategory[] = ["carrier", "gun", "missile", "bomb", "boom", "ship", "sea", "ui", "hooks"]
