import type { LabControl } from "@arcade/kit/lab-panel"

/** Presentation only. Shared by the game, animation viewer and the Lab. */
export const animation = {
  animationMode: "new",
  strideScale: 1,
  swayScale: 1.6,
  twistScale: 1.6,
  leanScale: 1,
  runPosture: 0.18,
  bodyHz: 3,
  footCentreHz: 4,
  chestHz: 5,
  headHz: 7,
  weaponHz: 6,
  recoilScale: 1,
  recoilHold: 2,
  rifleErgonomics: 1,
  shotgunErgonomics: 0.8,
  sniperErgonomics: 0.65,
}

const range = (key: keyof typeof animation, label: string, min: number, max: number, step: number): LabControl => ({ key, label, group: "Animation", min, max, step })
export const animationControls: LabControl[] = [
  { key: "animationMode", label: "Animation", group: "Animation", options: [{ label: "Old", value: "old" }, { label: "New", value: "new" }] },
  range("strideScale", "Stride", 0.6, 1.4, 0.05),
  range("swayScale", "Sway", 0, 2, 0.1),
  range("twistScale", "Twist", 0, 2, 0.1),
  range("leanScale", "Lean", 0, 1.5, 0.1),
  range("runPosture", "Run posture · rad", 0, 0.3, 0.01),
  range("bodyHz", "Pelvis spring · Hz", 1, 8, 0.25),
  range("footCentreHz", "Foot centre · Hz", 2, 8, 0.25),
  range("chestHz", "Chest spring · Hz", 2, 10, 0.25),
  range("headHz", "Head spring · Hz", 3, 12, 0.25),
  range("weaponHz", "Weapon spring · Hz", 2, 12, 0.25),
  range("recoilScale", "Recoil", 0, 2, 0.1),
  range("recoilHold", "Recoil hold · frames", 1, 3, 1),
  range("rifleErgonomics", "Rifle ergonomics", 0.4, 1.5, 0.05),
  range("shotgunErgonomics", "Shotgun ergonomics", 0.4, 1.5, 0.05),
  range("sniperErgonomics", "Sniper ergonomics", 0.4, 1.5, 0.05),
]

/** Accessors keep the existing effects settings and animation singleton live in one Lab. */
export function animationLab<T extends Record<string, boolean | number | string>>(settings: T, params: URLSearchParams): T & typeof animation {
  if (params.has("manual") || params.has("mux") || params.has("bench")) {
    const mode = params.get("animation")
    if (mode === "old" || mode === "new") animation.animationMode = mode
    const posture = Number(params.get("runPosture"))
    if (params.has("runPosture") && Number.isFinite(posture)) animation.runPosture = Math.max(0, Math.min(0.3, posture))
  }
  for (const key of Object.keys(animation) as (keyof typeof animation)[]) Object.defineProperty(settings, key, {
    enumerable: true, configurable: true,
    get: () => animation[key],
    set: (value) => { Object.assign(animation, { [key]: value }) },
  })
  return settings as T & typeof animation
}
