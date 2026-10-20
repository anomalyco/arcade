import { addScapeSound, type ScapeSoundDef } from "./catalog"

/**
 * The soundscape's door for other features (life, zombies, secrets, fire…): ask for an ambient sound at a world
 * position and the soundscape plays it on the Ambience bus, muffled by walls, under the Lab's Ambience levels
 * (Backquote › Sound › Ambience › "Other features"). Ids are soundscape sounds (`scape.*`, `SCAPE_SOUNDS`), sounds you
 * registered with `registerAmbientSound`, or any library id (`dog.bark`, `creature.crow.caw`…). Presentation only:
 * nothing here reaches the zombies' hearing. Safe to call before audio starts or while muted (calls are dropped).
 *
 * ```ts
 * import { holdAmbientSound, playAmbientSound } from "../audio/soundscape/hooks"
 * playAmbientSound("scape.phone.ring", phone.x, phone.y)          // once
 * holdAmbientSound(`radio:${id}`, "scape.wind.whistle", x, y, 0.6) // every frame you want it; stops when you stop
 * ```
 */
export type AmbientCall = { id: string; x: number; y: number; gain: number; rate: number; delay: number }
export type AmbientHoldCall = { key: string; id: string; x: number; y: number; gain: number; rate: number; fresh: number }

const MAX_CALLS = 32
const calls: AmbientCall[] = []
const holdCalls = new Map<string, AmbientHoldCall>()

/** Plays an ambient sound once at a plan position (x, y = world z). */
export function playAmbientSound(id: string, x: number, y: number, opts?: { gain?: number; rate?: number; delay?: number }): void {
  if (calls.length >= MAX_CALLS) return
  calls.push({ id, x, y, gain: opts?.gain ?? 1, rate: opts?.rate ?? 1, delay: opts?.delay ?? 0 })
}

/** Keeps a looping ambient sound playing at (x, y) while you keep calling this every frame (it stops when you stop). */
export function holdAmbientSound(key: string, id: string, x: number, y: number, gain = 1, rate = 1): void {
  const have = holdCalls.get(key)
  if (have) {
    have.id = id
    have.x = x
    have.y = y
    have.gain = gain
    have.rate = rate
    have.fresh = 2
    return
  }
  if (holdCalls.size >= MAX_CALLS) return
  holdCalls.set(key, { key, id, x, y, gain, rate, fresh: 2 })
}

/** Adds a procedural sound (synthesized by your `bake(sampleRate)`) that `playAmbientSound` can then name. */
export function registerAmbientSound(def: Omit<ScapeSoundDef, "layer"> & { layer?: ScapeSoundDef["layer"] }): void {
  addScapeSound({ layer: "hooks", ...def })
}

/**
 * The soundscape's side, once a frame: takes the calls since the last drain. A hold refreshed in either this frame or
 * the last survives, so it does not matter whether its feature runs before or after the soundscape in the frame.
 */
export function drainAmbientCalls(into: (call: AmbientCall) => void, holds: (call: AmbientHoldCall) => void): void {
  for (const c of calls) into(c)
  calls.length = 0
  for (const [key, h] of holdCalls) {
    if (--h.fresh < 0) holdCalls.delete(key)
    else holds(h)
  }
}

/** Forgets pending calls (new session). */
export function clearAmbientCalls(): void {
  calls.length = 0
  holdCalls.clear()
}
