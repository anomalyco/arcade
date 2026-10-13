import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import { animationControls, animationLab } from "../game/anim-settings"
import { motionSettings } from "../render/motion"
import { bloodSplatterSettings } from "../game/splatter"
import { LIGHT_DEFAULTS, type LightSettings } from "@arcade/kit/vehicle/lights"
import { lightControls } from "@arcade/kit/vehicle/lab"
import { SPELL_CONTROLS, spellDefaults, type SpellConfig } from "../../shared/sim/spell-config"

export const JUICE_LABELS = {
  volumes: "Volume Smoke",
  wizards: "Wizards",
  monitors: "Monitor Lights", chairs: "Chair Shadows", ao: "Multi-Bounce AO",
  paper: "Fluttering Paper", glass: "Glass Shards",
  sparks: "Monitor Sparks", casings: "Shell Casings", trauma: "Shake & Kill Punch",
  vehicleSprings: "Chassis springs", vehicleWheels: "Vehicle wheels", vehicleLamps: "Vehicle lamps",
  vehicleSkids: "Tyre skids", tyreSmoke: "Tyre smoke", vehicleSparks: "Contact sparks",
  backfire: "Exhaust pops", vehicleImpact: "Vehicle impact", vehicleAudio: "Vehicle audio",
} as const
export const LOOK_LABELS = {
  lookGrade: "Teal & Warm Grade", lookPractical: "Warm Practicals", lookWalls: "Warm Wall Faces",
  lookAO: "Corner & Contact AO", lookCaps: "Blue Cap Rims", lookFloors: "Floor Weave & Tile",
  lookCity: "City Depth", lookGloss: "Tile Reflections", lookShadows: "Long Furniture Shadows",
  lookShadowFilter: "Smooth Polar Shadows", lookMotion: "Motion Blur",
} as const
export type Juice = Record<keyof typeof JUICE_LABELS | keyof typeof LOOK_LABELS, boolean> & LightSettings & SpellConfig & { wizardPitch: number; monitorIntensity: number; aoStrength: number }
export const juiceSettings = (enabled = true): Juice => ({ volumes: enabled, monitors: enabled, chairs: enabled, ao: enabled, monitorIntensity: 1, aoStrength: 1, paper: enabled, glass: enabled, sparks: enabled, casings: enabled, trauma: enabled,
  lookGrade: enabled, lookPractical: enabled, lookWalls: enabled, lookAO: enabled, lookCaps: enabled, lookFloors: enabled, lookCity: enabled, lookGloss: enabled, lookShadows: false,
  lookShadowFilter: enabled, lookMotion: false,
  vehicleSprings: enabled, vehicleWheels: enabled, vehicleLamps: enabled, vehicleSkids: enabled, tyreSmoke: enabled,
  vehicleSparks: enabled, backfire: enabled, vehicleImpact: enabled, vehicleAudio: enabled, ...LIGHT_DEFAULTS, style: 4,
  ...spellDefaults(), wizardPitch: 0.9, wizards: false,
})
/** Bit layout shared with sceneShader; grade also uses bit zero in the composite. */
const LOOK_KEYS = Object.keys(LOOK_LABELS) as (keyof typeof LOOK_LABELS)[]
export function lookMask(settings: Juice): number {
  let bits = 0
  for (let i = 0; i < LOOK_KEYS.length; i++) if (settings[LOOK_KEYS[i]!]) bits |= 1 << i
  return bits
}
export type Perf = { fps: number; frameMs: number; p95Ms: number; gpuMs: number | null; gpuKind: string; draws: number; verts: number; chunks: number; lights: number }
const controls: LabControl[] = [
  {key:"wizardPitch",label:"Camera angle",min:0.7,max:1.2,step:0.05,group:"Spells"},
  ...Object.entries(SPELL_CONTROLS).filter(([key])=>!key.endsWith("Threshold")).map(([key,c]) => ({ key, label: c.label, min: c.min, max: c.max, step: c.step, group: "Spells" })),
  ...Object.entries(JUICE_LABELS).map(([key, label]) => ({ key, label })),
  ...Object.entries(LOOK_LABELS).map(([key, label]) => ({ key, label, group: "Look" })),
]

export class DebugOverlay extends LabPanel {
  private samples: number[] = []
  private lastReport = 0
  constructor(settings: Juice, params: URLSearchParams, release: () => void = () => {}) {
    super(animationLab(settings, params), [...controls, ...animationControls], params, release)
    this.addControls(settings, lightControls.filter(c => c.key !== "style").map(c => ({ ...c, group: "Vehicle lights" })))
    this.addControls(bloodSplatterSettings,[{key:"style",label:"Style",group:"Blood",type:"select",options:[{value:0,label:"Current"},{value:1,label:"Surface splatter"}]}])
    this.addControls(motionSettings,[
      {key:"strength",label:"Strength",group:"Motion",min:0,max:2,step:.05},
      {key:"shutter",label:"Shutter",group:"Motion",min:0,max:1,step:.05},
    ])
  }
  sample(now: number, elapsed: number, gpu: Pick<Perf, "gpuMs" | "gpuKind" | "draws" | "verts">, chunks: number, lights: number): Perf | null {
    if (elapsed > 0 && Number.isFinite(elapsed)) this.samples.push(elapsed)
    if (this.samples.length > 180) this.samples.shift()
    if (document.hidden) { this.samples = []; return null }
    if (now - this.lastReport < 150 || !this.samples.length) return null
    this.lastReport = now
    const sorted = [...this.samples].sort((a, b) => a - b)
    const frameMs = sorted[Math.floor((sorted.length - 1) * 0.5)]!
    const p95Ms = sorted[Math.floor((sorted.length - 1) * 0.95)]!
    const fps = 1000 * this.samples.length / this.samples.reduce((a, b) => a + b, 0)
    const perf = { fps, frameMs, p95Ms, ...gpu, chunks, lights }
    this.header.textContent = `FPS ${fps.toFixed(0)} · Frame ms ${frameMs.toFixed(1)} / ${p95Ms.toFixed(1)}\nGPU ${gpu.gpuKind === "timestamp" ? "HW" : "queue-wait"} ms ${gpu.gpuMs?.toFixed(2) ?? "—"}`
    return perf
  }
}
