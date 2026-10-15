import { createAudioLab } from "@arcade/kit/audio/lab"
import type { LabControl, LabSettings } from "@arcade/kit/lab-panel"
import type { CharacterSpawnable } from "@arcade/kit/lab/spawn-types"
import type { LabSection, SectionFactory } from "@arcade/kit/lab/types"
import type { Stage } from "@arcade/kit/lab/stage"
import { effectBed } from "./cues"
import { MIX_GROUPS, MIX_GROUP_IDS, type MixState } from "./mix"
import type { SceneAudio, SceneView } from "./scene-audio"

const percent = (value: number) => Math.round(value * 100)

/** The Audio section with the Lab's own mix (master, mute and per-category volumes) as its first group. */
export function audioSection(sound: SceneAudio): SectionFactory {
  return context => {
    const section = createAudioLab(context)
    sound.attachAudioLab(section.controller)
    const settings = section.settings as LabSettings
    const write = (mix: MixState) => {
      settings.labMuted = mix.muted
      settings.labVolume = percent(mix.volume)
      for (const group of MIX_GROUP_IDS) settings[`lab_${group}`] = percent(mix[group])
    }
    write(sound.mix)
    sound.onChange(mix => { write(mix); context.sync() })
    const range = { type: "range", min: 0, max: 100, step: 5, unit: "%" } as const
    const mix: LabControl[] = [
      { key: "labMuted", label: "Mute (M)", group: "Lab volume", change: value => sound.set({ muted: Boolean(value) }) },
      { key: "labVolume", label: "Master", group: "Lab volume", ...range, change: value => sound.set({ volume: Number(value) / 100 }) },
      ...MIX_GROUP_IDS.map((group): LabControl => ({ key: `lab_${group}`, label: MIX_GROUPS[group].label, group: "Lab volume", ...range, change: value => sound.set({ [group]: Number(value) / 100 }) })),
    ]
    // The Lab volume's mute replaces the audition runtime's own mute toggle.
    return { ...section, controls: [...mix, ...section.controls.filter(control => control.key !== "muted")] }
  }
}

/** Characters hand their `sound()` state to the games' audio adapters after every simulated tick. */
export function withSound(character: CharacterSpawnable, sound: SceneAudio): CharacterSpawnable {
  return {
    ...character,
    create(context, at) {
      const live = character.create(context, at)
      return {
        ...live,
        update(dt, input) {
          live.update(dt, input)
          sound.character(character.id, live.sound?.())
        },
      }
    },
  }
}

type LabView = { context: { stage: Stage }; sections: readonly LabSection[]; settings: { section: string } }

const PLAYGROUND = new Set(["spawn", "physics", "lighting", "effects"])
const STREET = new Set(["fire-water", "getaway-effects", "outbreak-vignette"])

/** Listener at the camera focus (right vector from the view), plus whichever bed the active section's effect needs. */
export function sceneView(lab: LabView): SceneView {
  const { eye, focus } = lab.context.stage
  const fx = focus[0]! - eye[0]!, fz = focus[2]! - eye[2]!, flat = Math.hypot(fx, fz) || 1
  const distance = Math.hypot(fx, focus[1]! - eye[1]!, fz)
  const id = lab.settings.section
  const section = lab.sections.find(candidate => candidate.id === id)
  const settings = section?.settings ?? {}
  const kind = settings.playing === false ? null : effectBed(String(settings.effect ?? ""), id)
  const emitter = kind && (section?.objects?.().find(object => object.category === "emitter") ?? section?.frameTarget?.())
  const at = emitter ? { x: emitter.x, y: emitter.y, z: emitter.z } : { x: focus[0]!, y: 0, z: focus[2]! }
  const spawnEnvironment = lab.sections.find(candidate => candidate.id === "spawn")?.settings.environment
  return {
    listener: { x: focus[0]!, z: focus[2]!, rightX: -fz / flat, rightZ: fx / flat, earHeight: Math.min(20, Math.max(6, distance * 0.45)) },
    bed: kind ? { kind, ...at } : null,
    ambience: PLAYGROUND.has(id) && spawnEnvironment !== undefined ? (spawnEnvironment === "yard" ? 0.25 : 0.8) : STREET.has(id) ? 0.5 : 0,
  }
}

const editable = (target: EventTarget | null) => {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  // Lists with type-to-filter (the Library) own printable keys like a text field.
  if (element.closest("[data-typeahead]")) return true
  if (element.isContentEditable || element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true
  return element.tagName === "INPUT" && (element as HTMLInputElement).type !== "range" && (element as HTMLInputElement).type !== "checkbox"
}

/** `M` (physical KeyM) toggles mute in Edit mode, never while typing or in Play. Registered before the workbench. */
export function bindMuteKey(sound: SceneAudio, mode: () => "edit" | "play" | undefined) {
  window.addEventListener("keydown", event => {
    if (event.code !== "KeyM" || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (mode() !== "edit" || editable(event.composedPath()[0] ?? event.target)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    sound.toggleMute()
  }, { capture: true })
}
