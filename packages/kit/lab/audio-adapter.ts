import type { LabEvent } from "./types"

/** The Lab's listener-facing mix: master volume and mute plus four category levels, all 0..1. */
export type LabMix = { muted: boolean; volume: number; vehicles: number; effects: number; ambience: number; ui: number }

export type LabAudioFrame = {
  dt: number
  listener: { x: number; z: number; rightX: number; rightZ: number }
  /** Street ambience wanted by the current scene, 0..1. */
  ambience: number
  /** Characters simulated since the last frame, with their `LabCharacter.sound()` state. */
  characters: readonly { id: string; state: unknown }[]
}

/**
 * A game's own sound code, driven by the Lab. Loaded with the game's Lab adapters; silent until `attach` hands it the
 * Lab's single context after the first user gesture.
 */
export type LabAudioAdapter = {
  id: string
  attach(ctx: AudioContext | OfflineAudioContext): Promise<void> | void
  mix(mix: LabMix): void
  update(frame: LabAudioFrame): void
  /** Plays the game's sound for an effect. Returns false when the game has none, so a shared sound can stand in. */
  event?(event: LabEvent, listener: { x: number; z: number }): boolean
  silence(): void
  inspect?(): unknown
}
