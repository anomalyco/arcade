import { captureCanvas, controlPatch, settleFrames, type LookState } from "@arcade/kit/proof/look"
import type { LabPanel } from "@arcade/kit/lab-panel"
import type { ForestView } from "@arcade/kit/forest/view"
import type { ForestStorm } from "@arcade/kit/forest/storm"
import { LOOKS, type LookId } from "./looks"

type Woods = {
  paused: boolean; panel: LabPanel
  looks: { pick(id: LookId): void; ids: readonly string[] }
  camera: { flashlight: boolean }; storm: ForestStorm; view: { forest: ForestView }
  state: { t: number; players: { id: number; x: number; z: number }[] }
  world: { camp: { x: number; z: number }; buildings: { kind: string; rect: readonly number[] }[] }
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
}

/** Only installed with ?qualityGate. Same Looks and Lab control writes as the game, at its own exposure. */
export function installBarbaraLook(w: Woods, canvas: HTMLCanvasElement, hooks: { translate(x: number, z: number): void; torch(on: boolean): void }) {
  const forest = w.view.forest, base = { ...forest.settings }
  const stormBase = { ...w.storm.settings }, nav = w.panel.navigation
  // Only the curated Looks' presentation fields are reversible within this adapter.
  const fields = new Set(Object.values(LOOKS).flatMap(look => [...Object.keys(look.forest), ...Object.keys(look.storm)]))
  let prior: LookState = {}, pose = { x: 0, z: 0, yaw: 0.08, pitch: 0.02 }
  let meterPending = false
  const draw = () => w.step(0)
  const setPose = (offset: number) => w.setPose(pose.x + Math.cos(pose.yaw) * offset, pose.z - Math.sin(pose.yaw) * offset, pose.yaw, pose.pitch)
  window.look = {
    version: 1, capabilities: { subject: true, shift: true, albedo: false },
    apply(state) {
      if (!w.looks.ids.includes(state.look ?? "today")) throw new Error(`Unknown Look ${state.look}`)
      if (!["trail", "left", "right", "lake"].includes(state.camera ?? "trail")) throw new Error(`Unknown camera ${state.camera}`)
      if (state.time !== undefined && state.time !== w.state.t) throw new Error("BARBARA sweep holds its staged simulation time; omit time")
      for (const key of Object.keys(state.settings ?? {})) {
        const c = nav.rows.find(r => r.control?.key === key)?.control
        if (!key.startsWith("woods.") || !fields.has(c?.field ?? key.slice(6))) throw new Error(`Unsupported proof setting: ${key}`)
      }
      const patch = controlPatch(nav, state.settings)
      const reset = controlPatch(nav, Object.fromEntries(Object.keys(prior.settings ?? {}).map(k => [k, nav.defaults[k]!])))
      reset(); Object.assign(forest.settings, base); Object.assign(w.storm.settings, stormBase)
      w.looks.pick((state.look ?? "today") as LookId); patch()
      // Scheduled flashes are excluded from static comparisons, not re-timed differently for every state.
      w.storm.settings.strikes = 0; w.storm.settle()
      const c = w.world.camp
      pose = { x: c.x + 10, z: c.z - 70, yaw: state.camera === "left" ? -0.5 : state.camera === "right" ? 0.6 : 0.08, pitch: 0.02 }
      if (state.camera === "lake") {
        const d = w.world.buildings.find(b => b.kind === "dock")
        if (!d) throw new Error("Dock camera unavailable")
        pose = { x: (d.rect[0]! + d.rect[2]!) / 2, z: d.rect[3]! - 2, yaw: Math.PI, pitch: -0.12 }
      }
      hooks.torch(state.torch ?? true)
      setPose(0); prior = structuredClone(state); meterPending = true
    },
    async settle(n) {
      forest.renderer.resetProofHistory()
      await settleFrames(n, draw, forest.renderer.passContext.device.queue)
      // The first draw after apply can still see the previous state's async meter readback.
      // Snap once after warming this state's meter; counterfactual settles must retain that exposure.
      if (meterPending) { forest.resetExposure(); meterPending = false }
    },
    grab: () => captureCanvas(canvas, draw, () => ({ exposure: forest.settings.exposure * forest.camera.exposure, time: w.state.t })),
    // Torch counterfactual: hold the base frame's exposure; dt=0 prevents adaptation while it is toggled.
    subject: visible => { hooks.torch(visible && (prior.torch ?? true)); forest.renderer.resetTemporalHistory() },
    shift: metres => {
      hooks.translate(pose.x + Math.cos(pose.yaw) * metres, pose.z - Math.sin(pose.yaw) * metres)
      forest.renderer.resetTemporalHistory()
    },
  }
}
