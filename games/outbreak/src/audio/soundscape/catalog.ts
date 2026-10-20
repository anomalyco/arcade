import * as dsp from "./dsp"

/** Sample rate the soundscape bakes at: the layer is quiet, far-off and filtered, so 24 kHz is plenty (half the memory). */
export const SCAPE_SAMPLE_RATE = 24000

/** Which Lab toggle (Backquote › Sound › Ambience) gates a sound. */
export const SCAPE_LAYERS = [
  "clocks",
  "taps",
  "fridge",
  "creaks",
  "wind",
  "oddities",
  "sirens",
  "gunfire",
  "carAlarm",
  "chimes",
  "rain",
  "gutters",
  "insects",
  "owl",
  "electrics",
  "hooks",
] as const
export type ScapeLayer = (typeof SCAPE_LAYERS)[number]

/** Interior layers are scaled by the Interiors level, the rest by Exteriors or Distance. */
export const SCAPE_LAYER_GROUP: Record<ScapeLayer, "interior" | "exterior" | "distant"> = {
  clocks: "interior",
  taps: "interior",
  fridge: "interior",
  creaks: "interior",
  wind: "interior",
  oddities: "interior",
  sirens: "distant",
  gunfire: "distant",
  carAlarm: "distant",
  chimes: "exterior",
  rain: "exterior",
  gutters: "exterior",
  insects: "exterior",
  owl: "distant",
  electrics: "exterior",
  hooks: "exterior",
}

export type ScapeSoundDef = {
  id: string
  label: string
  layer: ScapeLayer
  /** Synthesizes the sound's mono PCM at `sr`. */
  bake: (sr: number) => Float32Array
  loop?: boolean
  /** Linear level of the cue at its reference distance. */
  gain: number
  /** Positional range in metres (`ref` full level, `max` silent); distant sounds are placed by bearing instead. */
  range: { ref: number; max: number }
  /** Reverb send. */
  wet?: number
  /** Simultaneous voices of this cue. */
  maxVoices?: number
  /** One of a set of which a run only ever uses one (the 3 AM message per cellar number). */
  perRun?: boolean
}

/**
 * Every sound the soundscape can make. Levels are tuned against the night bed by the offline reel
 * (`scripts/soundscape-reel.ts`): interior touches sit 6–14 LU under it at a few metres, the distance under that.
 */
export const SCAPE_SOUNDS: readonly ScapeSoundDef[] = [
  { id: "scape.clock.tick", label: "Clock ticking", layer: "clocks", bake: (sr) => dsp.clockTick(sr), loop: true, gain: 0.36, range: { ref: 0.6, max: 11 }, wet: 0.12 },
  { id: "scape.clock.limp", label: "A clock that limps", layer: "clocks", bake: (sr) => dsp.clockLimp(sr), loop: true, gain: 0.36, range: { ref: 0.6, max: 11 }, wet: 0.12 },
  { id: "scape.clock.chime", label: "Mantel clock striking", layer: "clocks", bake: (sr) => dsp.clockChime(sr), gain: 0.3, range: { ref: 1, max: 22 }, wet: 0.25, maxVoices: 2 },
  { id: "scape.tap.drip", label: "Dripping tap", layer: "taps", bake: (sr) => dsp.tapDrip(sr), gain: 0.3, range: { ref: 0.6, max: 10 }, wet: 0.2, maxVoices: 3 },
  { id: "scape.fridge.hum", label: "Fridge hum", layer: "fridge", bake: (sr) => dsp.fridgeHum(sr), loop: true, gain: 0.2, range: { ref: 0.8, max: 8 }, wet: 0.05 },
  { id: "scape.fridge.off", label: "Fridge dying with the power", layer: "fridge", bake: (sr) => dsp.fridgeOff(sr), gain: 0.32, range: { ref: 0.8, max: 14 }, wet: 0.15, maxVoices: 1 },
  { id: "scape.house.creak.0", label: "House creak", layer: "creaks", bake: (sr) => dsp.creak(sr, 81), gain: 0.2, range: { ref: 1, max: 14 }, wet: 0.25, maxVoices: 2 },
  { id: "scape.house.creak.1", label: "House creak", layer: "creaks", bake: (sr) => dsp.creak(sr, 82), gain: 0.2, range: { ref: 1, max: 14 }, wet: 0.25, maxVoices: 2 },
  { id: "scape.house.creak.2", label: "House creak", layer: "creaks", bake: (sr) => dsp.creak(sr, 83), gain: 0.2, range: { ref: 1, max: 14 }, wet: 0.25, maxVoices: 2 },
  { id: "scape.house.settle", label: "House settling", layer: "creaks", bake: (sr) => dsp.settle(sr), gain: 0.24, range: { ref: 1, max: 16 }, wet: 0.3, maxVoices: 2 },
  { id: "scape.pipe.knock", label: "Pipe knocking", layer: "creaks", bake: (sr) => dsp.pipeKnock(sr), gain: 0.2, range: { ref: 1, max: 16 }, wet: 0.25, maxVoices: 1 },
  { id: "scape.wind.whistle", label: "Wind through a window", layer: "wind", bake: (sr) => dsp.windWhistle(sr), loop: true, gain: 0.16, range: { ref: 0.8, max: 12 }, wet: 0.2 },
  { id: "scape.curtain", label: "Curtain in a draught", layer: "wind", bake: (sr) => dsp.curtain(sr), gain: 0.2, range: { ref: 0.8, max: 9 }, wet: 0.15, maxVoices: 2 },
  { id: "scape.musicbox", label: "Music box", layer: "oddities", bake: (sr) => dsp.musicBox(sr), gain: 0.26, range: { ref: 0.8, max: 16 }, wet: 0.3, maxVoices: 1 },
  { id: "scape.phone.ring", label: "Phone ringing", layer: "oddities", bake: (sr) => dsp.phoneRing(sr), gain: 0.3, range: { ref: 1, max: 26 }, wet: 0.3, maxVoices: 2 },
  { id: "scape.phone.machine", label: "Answering machine", layer: "oddities", bake: (sr) => dsp.answeringMachine(sr), gain: 0.28, range: { ref: 0.8, max: 14 }, wet: 0.25, maxVoices: 1 },
  { id: "scape.siren", label: "Distant siren", layer: "sirens", bake: (sr) => dsp.sirenWail(sr), loop: true, gain: 0.16, range: { ref: 0, max: 0 }, wet: 0.45 },
  { id: "scape.gunshot.pistol", label: "Far-off pistol", layer: "gunfire", bake: (sr) => dsp.gunshotFar(sr, 171, "pistol"), gain: 0.24, range: { ref: 0, max: 0 }, wet: 0.4, maxVoices: 4 },
  { id: "scape.gunshot.shotgun", label: "Far-off shotgun", layer: "gunfire", bake: (sr) => dsp.gunshotFar(sr, 172, "shotgun"), gain: 0.26, range: { ref: 0, max: 0 }, wet: 0.4, maxVoices: 3 },
  { id: "scape.gunshot.rifle", label: "Far-off rifle", layer: "gunfire", bake: (sr) => dsp.gunshotFar(sr, 173, "rifle"), gain: 0.21, range: { ref: 0, max: 0 }, wet: 0.4, maxVoices: 3 },
  { id: "scape.caralarm", label: "Car alarm streets away", layer: "carAlarm", bake: (sr) => dsp.carAlarmFar(sr), loop: true, gain: 0.1, range: { ref: 0, max: 0 }, wet: 0.45 },
  { id: "scape.chime", label: "Wind chime", layer: "chimes", bake: (sr) => dsp.chimeTube(sr), gain: 0.18, range: { ref: 1, max: 20 }, wet: 0.3, maxVoices: 4 },
  { id: "scape.rain.metal", label: "Rain on a car", layer: "rain", bake: (sr) => dsp.rainMetal(sr), loop: true, gain: 0.5, range: { ref: 1.2, max: 13 }, wet: 0.15 },
  { id: "scape.rain.puddle", label: "Rain in puddles", layer: "rain", bake: (sr) => dsp.rainPuddle(sr), loop: true, gain: 0.38, range: { ref: 1.2, max: 11 }, wet: 0.12 },
  { id: "scape.rain.leaves", label: "Rain on leaves", layer: "rain", bake: (sr) => dsp.rainLeaves(sr), loop: true, gain: 0.32, range: { ref: 1.5, max: 14 }, wet: 0.15 },
  { id: "scape.gutter.drip", label: "Gutter dripping", layer: "gutters", bake: (sr) => dsp.gutterDrip(sr), gain: 0.24, range: { ref: 0.8, max: 12 }, wet: 0.2, maxVoices: 3 },
  { id: "scape.insects", label: "Insects by day", layer: "insects", bake: (sr) => dsp.insectsDay(sr), loop: true, gain: 0.07, range: { ref: 2, max: 22 }, wet: 0.1 },
  { id: "scape.owl", label: "Owl", layer: "owl", bake: (sr) => dsp.owl(sr), gain: 0.18, range: { ref: 0, max: 0 }, wet: 0.45, maxVoices: 1 },
  { id: "scape.bird.0", label: "Songbird at dawn", layer: "insects", bake: (sr) => dsp.birdSong(sr, 40), gain: 0.28, range: { ref: 2, max: 30 }, wet: 0.3, maxVoices: 2 },
  { id: "scape.bird.1", label: "Songbird at dawn", layer: "insects", bake: (sr) => dsp.birdSong(sr, 41), gain: 0.28, range: { ref: 2, max: 30 }, wet: 0.3, maxVoices: 2 },
  { id: "scape.bird.2", label: "Songbird at dawn", layer: "insects", bake: (sr) => dsp.birdSong(sr, 42), gain: 0.28, range: { ref: 2, max: 30 }, wet: 0.3, maxVoices: 2 },
  { id: "scape.church.bell", label: "Church bell striking the hour", layer: "clocks", bake: (sr) => dsp.churchBell(sr), gain: 0.3, range: { ref: 8, max: 150 }, wet: 0.5, maxVoices: 3 },
  { id: "scape.radio.call", label: "Police radio in an empty cruiser", layer: "electrics", bake: (sr) => dsp.radioCall(sr), gain: 0.22, range: { ref: 1.5, max: 22 }, wet: 0.2, maxVoices: 2 },
  { id: "scape.neon.buzz", label: "Neon sign buzz", layer: "electrics", bake: (sr) => dsp.neonBuzz(sr), loop: true, gain: 0.12, range: { ref: 1, max: 10 }, wet: 0.1 },
  { id: "scape.lamp.buzz", label: "Street lamp hum", layer: "electrics", bake: (sr) => dsp.lampBuzz(sr), loop: true, gain: 0.07, range: { ref: 1.5, max: 9 }, wet: 0.1 },
  { id: "scape.alarm.bell", label: "Shop alarm bell", layer: "electrics", bake: (sr) => dsp.alarmBell(sr), loop: true, gain: 0.1, range: { ref: 2, max: 45 }, wet: 0.35 },
  { id: "scape.smoke.chirp", label: "Smoke alarm low battery", layer: "oddities", bake: (sr) => dsp.smokeChirp(sr), gain: 0.16, range: { ref: 1, max: 16 }, wet: 0.25, maxVoices: 2 },
  { id: "scape.door.creak", label: "Open door swinging on its hinge", layer: "wind", bake: (sr) => dsp.doorCreak(sr), gain: 0.16, range: { ref: 1, max: 14 }, wet: 0.25, maxVoices: 2 },
  // For other features, through `hooks.ts` (the life layer, the dead's habits).
  { id: "scape.tv", label: "Television left on", layer: "hooks", bake: (sr) => dsp.tvLeftOn(sr), loop: true, gain: 0.16, range: { ref: 0.8, max: 12 }, wet: 0.2 },
  { id: "scape.life.rustle", label: "Something bolting through a shrub", layer: "hooks", bake: (sr) => dsp.rustle(sr), gain: 0.3, range: { ref: 1, max: 22 }, wet: 0.2, maxVoices: 2 },
  { id: "scape.life.scurry", label: "A fox scurrying off", layer: "hooks", bake: (sr) => dsp.scurry(sr), gain: 0.26, range: { ref: 1, max: 20 }, wet: 0.2, maxVoices: 2 },
  { id: "scape.life.hooves", label: "A deer crashing away", layer: "hooks", bake: (sr) => dsp.hooves(sr), gain: 0.32, range: { ref: 1.5, max: 30 }, wet: 0.3, maxVoices: 1 },
  { id: "scape.habit.knock", label: "The dead knocking at a door", layer: "hooks", bake: (sr) => dsp.knock(sr), gain: 0.34, range: { ref: 1, max: 26 }, wet: 0.25, maxVoices: 3 },
  { id: "scape.habit.pans", label: "The dead at a stove", layer: "hooks", bake: (sr) => dsp.pans(sr), gain: 0.24, range: { ref: 1, max: 20 }, wet: 0.25, maxVoices: 2 },
  { id: "scape.habit.bedsprings", label: "The dead in a bed", layer: "hooks", bake: (sr) => dsp.bedsprings(sr), gain: 0.2, range: { ref: 1, max: 14 }, wet: 0.2, maxVoices: 2 },
  { id: "scape.habit.fence", label: "The dead rattling a fence", layer: "hooks", bake: (sr) => dsp.fenceRattle(sr), gain: 0.26, range: { ref: 1, max: 24 }, wet: 0.2, maxVoices: 2 },
  { id: "scape.sprinkler", label: "A lawn sprinkler at dawn", layer: "hooks", bake: (sr) => dsp.sprinkler(sr), loop: true, gain: 0.2, range: { ref: 1.5, max: 22 }, wet: 0.15 },
  { id: "scape.car.chime", label: "A car's door-open chime", layer: "hooks", bake: (sr) => dsp.doorChime(sr), loop: true, gain: 0.1, range: { ref: 1, max: 14 }, wet: 0.15 },
  { id: "scape.washing.flap", label: "Washing snapping on the line", layer: "hooks", bake: (sr) => dsp.washingFlap(sr), gain: 0.22, range: { ref: 1, max: 16 }, wet: 0.15, maxVoices: 2 },
  { id: "scape.secret.twitch", label: "A stopped clock's twitching hand", layer: "hooks", bake: (sr) => dsp.clockTwitch(sr), loop: true, gain: 0.26, range: { ref: 0.5, max: 7 }, wet: 0.1 },
  { id: "scape.secret.static", label: "A set between stations", layer: "hooks", bake: (sr) => dsp.radioStatic(sr), loop: true, gain: 0.12, range: { ref: 0.8, max: 12 }, wet: 0.15 },
  { id: "scape.secret.pip", label: "The station that is not there", layer: "hooks", bake: (sr) => dsp.radioPip(sr), gain: 0.18, range: { ref: 0.8, max: 12 }, wet: 0.15, maxVoices: 2 },
  { id: "scape.secret.rocking", label: "A rocking chair on a porch", layer: "hooks", bake: (sr) => dsp.rockingChair(sr), loop: true, gain: 0.22, range: { ref: 1, max: 18 }, wet: 0.25 },
  ...Array.from({ length: 9 }, (_, i): ScapeSoundDef => ({
    id: `scape.phone.machine.${i + 1}`,
    label: `Answering machine (${i + 1})`,
    layer: "oddities",
    bake: (sr) => dsp.answeringMachineCount(sr, i + 1),
    gain: 0.28,
    range: { ref: 0.8, max: 14 },
    wet: 0.25,
    maxVoices: 1,
    perRun: true,
  })),
  { id: "scape.habit.dance", label: "A gramophone waltz outside the church", layer: "hooks", bake: (sr) => dsp.lastDance(sr), loop: true, gain: 0.18, range: { ref: 1.5, max: 26 }, wet: 0.35 },
]

const BY_ID = new Map<string, ScapeSoundDef>(SCAPE_SOUNDS.map((s) => [s.id, s]))

/** A soundscape sound by id, including ones other features registered (`registerAmbientSound`). */
export function scapeSound(id: string): ScapeSoundDef | undefined {
  return BY_ID.get(id)
}

/** Adds or replaces a procedural sound (other features' ambient sounds go through here). */
export function addScapeSound(def: ScapeSoundDef): void {
  BY_ID.set(def.id, def)
}

export function scapeSoundIds(): string[] {
  return [...BY_ID.keys()]
}
