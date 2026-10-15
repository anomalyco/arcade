import { keyLabelSetting } from "@arcade/kit/client/controls"
import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import { PerfSampler, type FramePerfSample } from "@arcade/kit/gpu-perf"
import { chassisSettings } from "../game/chassis"
import { vehicleEffects } from "../game/vehicle-emissions"
import type { Scene } from "../game/scene"
import type { GameAudio } from "../audio/game-audio"
import type { LightSettings, LightStyle } from "../render/car-lights"
import { motionBlur } from "../render/motion"
import { lightControls } from "@arcade/kit/vehicle/lab"

/** Presentation only; these values never enter shared vehicle physics. */
export const juice = { ...chassisSettings(true), clutter: true, explosions: true, physicsDebug: false }
const controls: LabControl[] = [
  { key: "emissions", label: "Vehicle emissions", group: "Emissions" },
  { key: "coldExhaust", label: "Cold exhaust", group: "Emissions" },
  { key: "clutter", label: "Street clutter", group: "Props" },
  { key: "explosions", label: "Explosions", group: "Props" },
  { key: "physicsDebug", label: "Physics debug", group: "Props" },
  ...([
    ["suspension", "Suspension springs"],
    ["wheelContact", "Per-wheel contact"],
    ["visibleWheels", "Steer & spin wheels"],
    ["vehicleFeel", "Vehicle-specific feel"],
  ] as const).map(([key, label]) => ({ key, label, group: "Chassis" })),
]

export type PerfSample = FramePerfSample
export class DebugOverlay extends LabPanel {
  private readonly sampler = new PerfSampler(120)
  get sample(): PerfSample { return this.sampler.sample }
  constructor(q: URLSearchParams, release: () => void, scene: Scene, sound?: GameAudio) {
    super({ ...juice, ...scene.lightSettings, emissions: scene.emissions.visible, coldExhaust: vehicleEffects.coldExhaust, proceduralAudio: sound?.procedural ?? true }, [
      ...lightControls.map(control => "min" in control ? { ...control, enabled: (settings: Readonly<Record<string, boolean | number | string>>) => settings.style === 4 } : control),
      ...controls,
      ...(sound ? [{ key: "proceduralAudio", label: "Procedural audio", group: "Audio" }] : []),
    ], q, release, (key, value) => {
      if (key === "style") scene.setLightStyle(value as LightStyle)
      else if (key in scene.lightSettings) Object.assign(scene.lightSettings, { [key]: value })
      else if (key === "emissions") scene.emissions.visible = Boolean(value)
      else if (key === "coldExhaust") vehicleEffects.coldExhaust = Boolean(value)
      else if (key === "proceduralAudio" && sound) { sound.reset(); sound.procedural = Boolean(value) }
      else Object.assign(juice, { [key]: value })
    })
    this.addControls(motionBlur, [
      {key:"enabled",label:"Motion blur",group:"Motion"},
      {key:"strength",label:"Strength",group:"Motion",min:0,max:2,step:.05},
      {key:"shutter",label:"Shutter",group:"Motion",min:0,max:1,step:.05},
    ])
    const keyLabels = keyLabelSetting()
    this.addControls(keyLabels.settings, [keyLabels.control], keyLabels.defaults)
  }
  reset() { this.sampler.reset() }
  update(now: number, frameMs: number, stats: Pick<PerfSample, "gpuMs" | "gpuKind" | "draws" | "verts" | "chunks" | "lights">) {
    return this.sampler.update(now, frameMs, stats, this.header) !== null
  }
}
