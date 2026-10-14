import type { LabAudioAdapter, LabMix } from "@arcade/kit/lab/audio-adapter"
import { Sound } from "../audio/sound"
import { EV } from "../game/anim"
import { GUN_IDS, SPEED, SPRINT_SPEED, type Gun } from "../../shared/config"

/** What the Lab soldier reports each tick (`LabCharacter.sound`). */
export type BlackoutSoldierSound = { ev: number; gun: Gun; speed: number }

const isSoldier = (state: unknown): state is BlackoutSoldierSound => typeof state === "object" && state !== null && "ev" in state && "gun" in state
const gunOf = (value: unknown): Gun => GUN_IDS.find(gun => gun === value) ?? "rifle"

/**
 * Blackout's own `Sound` in the Lab: the soldier's animation-cued footsteps and gun mechanics exactly as the game cues
 * its own player (`Game.cues`), and the game's gunshot, bullet impact, casing/magazine clink and explosion for effects.
 */
export function blackoutLabAudio() {
  const sound = new Sound()
  let mix: LabMix | undefined
  const levels = () => {
    if (!mix) return
    sound.volume = mix.volume * mix.effects
    sound.setMuted(mix.muted)
  }
  const adapter: LabAudioAdapter & { sound: Sound } = {
    id: "blackout",
    sound,
    attach(ctx) {
      sound.start(ctx as AudioContext)
      levels()
    },
    mix(next) { mix = next; levels() },
    update(frame) {
      for (const { id, state } of frame.characters) {
        if (!id.startsWith("blackout:") || !isSoldier(state) || !state.ev) continue
        // The possessed soldier is "mine": heard from its own position, like the game's player.
        if (state.ev & EV.step) sound.step(0, 0, true, Math.min(SPRINT_SPEED, state.speed) / SPEED)
        sound.cue(state.ev, state.gun, 0, 0, true)
      }
    },
    event(event, listener) {
      const dx = event.x - listener.x, dy = event.z - listener.z, gun = gunOf(event.settings?.weapon)
      switch (event.effect) {
        case "explosion": case "fireball": case "scorch": sound.explode(dx, dy, "frag"); return true
        case "shot": sound.shot(gun, dx, dy, true); if (event.variant !== "glass" && event.variant !== "monitor") sound.impact(dx, dy); return event.variant !== "glass" && event.variant !== "monitor"
        case "muzzle": case "tracer": sound.shot(gun, dx, dy, true); return true
        case "impact": case "holes": sound.impact(dx, dy); return true
        case "casings": sound.clink(dx, dy, false); return true
        case "magazines": sound.clink(dx, dy, true); return true
        default: return false
      }
    },
    silence() {},
  }
  return adapter
}
