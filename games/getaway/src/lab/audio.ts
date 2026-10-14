import type { LabAudioAdapter, LabAudioFrame, LabMix } from "@arcade/kit/lab/audio-adapter"
import { AudioEngine } from "../audio/engine"
import { GameAudio } from "../audio/game-audio"
import { Transients } from "../audio/synth"
import type { Input } from "../../shared/sim/vehicle"
import type { CarView, WorldView } from "../../shared/sim/world"
import type { Camera } from "../game/camera"
import type { City } from "../../shared/sim/city"

/** What a Lab car reports each tick (`LabCharacter.sound`). */
export type GetawayCarSound = { car: CarView; input: Input }

const isCar = (state: unknown): state is GetawayCarSound => typeof state === "object" && state !== null && "car" in state && "input" in state

/**
 * Getaway's own audio in the Lab: the game's `GameAudio` (procedural DriverVoice engine, gearbox, tyre squeal and scrub,
 * nitro, crash and scrape samples, city bed) on its own `AudioEngine`, fed the Lab car as the local player's car.
 */
export function getawayLabAudio(options: { city?: City } = {}) {
  const engine = new AudioEngine(undefined, { bindDom: false })
  const game = new GameAudio(undefined, options.city, engine)
  let transients: Transients | undefined
  let mix: LabMix | undefined
  let ambience = 1
  let t = 0
  // A round already under way with no sirens: the car drives, nothing stings.
  const view = {
    t: 0, round: 0, phase: "headstart", phaseT: 0, robberId: "lab", bust: 0, best: 0, survived: 0, busted: false,
    heli: { active: false, x: 0, z: 0, y: 0, lock: 0 }, cars: [] as CarView[],
  } as unknown as WorldView
  const cam = { fx: 0, fz: 0, right: [1, 0] as [number, number], axes() { return { fwd: [this.right[1], -this.right[0]], right: this.right } } }

  // Bus levels last written; the engine starts at unity, and only changes are scheduled.
  const applied = { master: 1, sfx: 1, sting: 1, amb: 1 }
  const level = (bus: keyof typeof applied, value: number, tau: number) => {
    if (applied[bus] === value) return
    applied[bus] = value
    engine[bus].gain.setTargetAtTime(value, engine.now, tau)
  }
  const levels = () => {
    if (!engine.ctx || !mix) return
    level("master", mix.muted ? 0 : mix.volume, 0.04)
    // The game's sfx bus carries engines, tyres and other cars' crashes; the sting bus carries your own crashes.
    level("sfx", mix.vehicles, 0.04)
    level("sting", mix.vehicles, 0.04)
    level("amb", mix.ambience * ambience, 0.4)
  }

  const adapter: LabAudioAdapter & { engine: AudioEngine; game: GameAudio } = {
    id: "getaway",
    engine,
    game,
    async attach(ctx) {
      await engine.attach(ctx)
      transients = new Transients(engine)
      levels()
    },
    mix(next) { mix = next; levels() },
    update(frame: LabAudioFrame) {
      if (!engine.ctx) return
      const wanted = Math.min(1, frame.ambience / 0.8)
      if (wanted !== ambience) { ambience = wanted; levels() }
      const sample = frame.characters.find(c => c.id.startsWith("getaway:") && isCar(c.state))?.state as GetawayCarSound | undefined
      t += frame.dt
      cam.fx = frame.listener.x; cam.fz = frame.listener.z; cam.right = [frame.listener.rightX, frame.listener.rightZ]
      view.t = t
      view.cars = sample ? [sample.car] : []
      game.update(view, { myId: "lab", cam: cam as unknown as Camera, dt: frame.dt, events: [], input: sample?.input, paused: !sample })
    },
    event(event) {
      if (!transients || !engine.ctx) return false
      // The game's own sounds for these: a landing thump and an exhaust backfire pop.
      if (event.effect === "landing") return engine.play("crash_thump_1", { gain: 0.6, wet: 0.1, rate: 0.85, cutoff: 1800 }) || true
      if (event.effect === "pops") { transients.burst("pop", 0.45); return true }
      return false
    },
    silence() { game.reset() },
    inspect() { return { attached: Boolean(engine.ctx), ready: engine.ready, nitro: game.nitroState } },
  }
  return adapter
}
