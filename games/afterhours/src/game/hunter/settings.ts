import type { WorldContext } from "../../world/context"

// The hunter's Lab controls (group "Hunter"). Registered before the Lab panel is built (main.ts calls this right after
// the world boots); the hunter itself loads later. Defaults are the approved design values.

export const HUNTER_DEFAULTS = {
  "hunter.debug": 0,
  "hunter.hearing": 1,
  "hunter.sight": 1,
  "hunter.speedRoam": 1.2,
  "hunter.speedInvestigate": 1.8,
  "hunter.speedSearch": 2.2,
  "hunter.speedHunt": 4.6,
  "hunter.speedRush": 5.6,
  "hunter.searchTime": 35,
  "hunter.grace": 8,
  "hunter.catch": 1.5,
  "hunter.scale": 0.85,
  "hunter.lights": 1,
} as const

let registered = false

export function hunterControls(ctx: WorldContext) {
  if (registered) return
  registered = true
  for (const [k, v] of Object.entries(HUNTER_DEFAULTS)) ctx.settings[k] ??= v
  ctx.controls.push(
    { key: "hunter.debug", label: "Hunter debug overlay (nav, path, senses)", group: "Hunter", type: "toggle", on: 1, off: 0 },
    { key: "hunter.hearing", label: "Hearing", group: "Hunter", unit: "×", min: 0, max: 3, step: 0.05 },
    { key: "hunter.sight", label: "Sight range", group: "Hunter", unit: "×", min: 0, max: 3, step: 0.05 },
    { key: "hunter.speedRoam", label: "Roam speed", group: "Hunter", unit: "m/s", min: 0.4, max: 3, step: 0.05 },
    { key: "hunter.speedInvestigate", label: "Investigate speed", group: "Hunter", unit: "m/s", min: 0.6, max: 4, step: 0.05 },
    { key: "hunter.speedSearch", label: "Search speed", group: "Hunter", unit: "m/s", min: 0.6, max: 4, step: 0.05 },
    { key: "hunter.speedHunt", label: "Hunt speed (player runs 4.5)", group: "Hunter", unit: "m/s", min: 2, max: 7, step: 0.05 },
    { key: "hunter.speedRush", label: "Rush speed (a hunt begun by hearing a sprint, out of sight)", group: "Hunter", unit: "m/s", min: 2, max: 8, step: 0.05 },
    { key: "hunter.searchTime", label: "Search before giving up", group: "Hunter", unit: "s", min: 5, max: 120, step: 1 },
    { key: "hunter.grace", label: "Grace after a checkpoint", group: "Hunter", unit: "s", min: 0, max: 30, step: 0.5 },
    { key: "hunter.catch", label: "Catch distance", group: "Hunter", unit: "m", min: 0.8, max: 3, step: 0.05 },
    { key: "hunter.scale", label: "Creature size", group: "Hunter", unit: "×", min: 0.6, max: 1.1, step: 0.01 },
    { key: "hunter.lights", label: "Lights flicker near it", group: "Hunter", unit: "×", min: 0, max: 2, step: 0.05 },
  )
}

export const num = (ctx: WorldContext, key: keyof typeof HUNTER_DEFAULTS) => Number(ctx.settings[key] ?? HUNTER_DEFAULTS[key])
