import type { FlightModule } from "../flight/seam"
import { FEEDBACK, FEEDBACK_CONTROLS, FEEDBACK_DEFAULTS } from "../feedback/settings"
import type { DevSection } from "./dev-panel"

/**
 * FEEDBACK: damage and reward feedback (src/feedback/settings.ts FEEDBACK) on the dev panel's Flight tab, with the
 * approved defaults and Reset, and buttons that preview each moment on your own jet while flying (a hit goes through
 * the normal `hp` path, so online the room's next update puts the real health back).
 */
export function feedbackSection(flight: FlightModule): DevSection {
  const w = flight.weapons
  const fb = flight.feedback
  const hurt = (amount: number) => {
    const hp = Math.max(1, w.world.hp(w.id) - amount)
    w.apply({ k: "hp", on: w.id, hp, by: -1, w: "" })
  }
  const ahead = (d: number) => {
    const p = flight.flight.draw
    const s = Math.hypot(p.vx, p.vy, p.vz) || 1
    return { id: -1, team: -1, alive: true, x: p.x + (p.vx / s) * d + 8, y: p.y + (p.vy / s) * d + 3, z: p.z + (p.vz / s) * d, vx: p.vx * 0.4, vy: 0, vz: p.vz * 0.4 }
  }
  const flying = () => flight.phase === "flying"
  return {
    id: "feedback",
    tab: "Flight",
    bind: (panel) => {
      panel.addControls(FEEDBACK, FEEDBACK_CONTROLS, FEEDBACK_DEFAULTS)
      panel.addControls({}, [
        {
          key: "fb-hits",
          label: "Take a hit",
          group: "Preview (flying)",
          type: "buttons",
          items: [
            { key: "fb-gun", label: "Gun −6", run: () => hurt(6), enabled: flying },
            { key: "fb-missile", label: "Missile −30", run: () => hurt(30), enabled: flying },
            { key: "fb-clean", label: "Clean canopy", run: () => fb.canopy.clear(), enabled: flying },
          ],
        },
        {
          key: "fb-rewards",
          label: "Rewards",
          group: "Preview (flying)",
          type: "buttons",
          items: [
            { key: "fb-kill", label: "Kill", run: () => w.hud.hit(true, !fb.kill(true, ahead(120))), enabled: flying },
            { key: "fb-ship", label: "Ship hit", run: () => fb.preview("ship-hit"), enabled: flying },
            { key: "fb-close", label: "Close call", run: () => fb.preview("close-call"), enabled: flying },
          ],
        },
      ])
    },
  }
}
