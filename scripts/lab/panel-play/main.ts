// A stand-in game for prove-panel-play.ts: a canvas that locks the pointer on click and counts the keys it takes, gated
// on `panel.holdsInput` the way the games are, under a capture "focus" LabPanel with groups, sub-headings and Volume.
// It also runs the kit's `Input` blocked on `holdsInput` (Outbreak's wiring) and a window-capture key listener that
// swallows Enter and Escape the way Outbreak's lobby does. `?capture=open` and `?open=<group>` change the panel.
import { isEditableEventTarget, isLabPanelEventTarget } from "@arcade/kit/client/controls"
import { Input } from "@arcade/kit/client/input"
import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"

const canvas = document.querySelector<HTMLCanvasElement>("#game")!
const settings = {
  walkSpeed: 1.9, stepLength: 0.72, headMotion: 1,
  power: 70, reach: 40, shafts: true, hotSpot: 0.9, hotSpotWidth: 0.42, lensRight: 0.3, lensDown: 0.28,
  density: 4.5, ferns: 1, moss: 1,
  exposure: 1.6, vignette: 0.35, bloom: 0.22, noise: 1, chroma: 0.35,
  master: 0.8, effects: 1, ambience: 1,
}
const range = (key: keyof typeof settings, label: string, group: string, min: number, max: number, step: number, subsection?: string): LabControl =>
  ({ key, label, group, min, max, step, ...(subsection ? { subsection } : {}) })
const controls: LabControl[] = [
  range("walkSpeed", "Walk speed", "Walking", 1, 4, 0.05),
  range("stepLength", "Step length", "Walking", 0.4, 1.2, 0.01),
  range("headMotion", "Head motion", "Walking", 0, 2, 0.05),
  range("power", "Beam intensity", "Flashlight", 0, 200, 1),
  range("reach", "Reach", "Flashlight", 10, 70, 1),
  { key: "shafts", label: "Shafts in the mist", group: "Flashlight", type: "toggle" },
  range("hotSpot", "Hot spot", "Flashlight", 0, 3, 0.05, "Beam profile"),
  range("hotSpotWidth", "Hot spot width", "Flashlight", 0.1, 1, 0.01, "Beam profile"),
  range("lensRight", "Lens offset right", "Flashlight", 0, 0.6, 0.01, "Hand"),
  range("lensDown", "Lens offset down", "Flashlight", 0, 0.6, 0.01, "Hand"),
  range("density", "Trunk density", "Forest", 1, 10, 0.25),
  range("ferns", "Ferns", "Forest", 0, 2, 0.05, "Floor"),
  range("moss", "Moss", "Forest", 0, 2, 0.05, "Floor"),
  range("exposure", "Exposure", "Camera", 0.2, 6, 0.05),
  range("vignette", "Vignette", "Camera", 0, 1, 0.01, "Lens"),
  range("bloom", "Bloom", "Camera", 0, 1, 0.01, "Lens"),
  range("noise", "Sensor noise", "Camera", 0, 3, 0.05, "Sensor"),
  range("chroma", "Colour noise", "Camera", 0, 1, 0.05, "Sensor"),
  range("master", "Master", "Volume", 0, 1, 0.05),
  range("effects", "Effects", "Volume", 0, 1, 0.05),
  range("ambience", "Ambience", "Volume", 0, 1, 0.05),
]

const params = new URLSearchParams(location.search)
const game = { accepted: [] as string[], released: 0, input: [] as string[], lobby: [] as string[], clicks: [] as string[] }
const panel = new LabPanel(settings, controls, params, () => { game.released++ }, {
  open: false, pill: false, groupActions: false, capture: params.get("capture") === "open" ? "open" : "focus",
  openGroups: [params.get("open") ?? "Walking"],
})
const input = new Input(canvas, ["KeyE"])
input.blocked = () => panel.holdsInput
input.onKey = code => game.input.push(code)
window.addEventListener("keydown", e => {
  if (isLabPanelEventTarget(e.target) || (e.code !== "Enter" && e.code !== "Escape")) return
  e.stopImmediatePropagation()
  game.lobby.push(e.code)
}, true)
canvas.addEventListener("click", () => {
  game.clicks.push(panel.holdsInput ? "held" : "lock")
  if (!panel.holdsInput) canvas.requestPointerLock()?.catch?.((e: unknown) => game.clicks.push(String(e)))
})
window.addEventListener("keydown", e => {
  if (e.code === "Backquote" || isEditableEventTarget(e.target) || panel.holdsInput || document.pointerLockElement !== canvas) return
  game.accepted.push(e.code)
})
Object.assign(window, { harness: { panel, game, settings, input } })
