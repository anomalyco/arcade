import { registerOutbreakSharedFeature } from "../feature-registry"

/**
 * Verbs that change how a survivor moves and how the dead perceive them (D-19 slice 4). A survivor in a closet stays
 * put, silent and dark, until E lets them out; a crouching one is a smaller shape and a hidden one is no shape at
 * all. The closet itself is a ledger store, so this feature holds no state of its own.
 */
export const outbreakDiscoverySharedFeature = registerOutbreakSharedFeature({
  id: "discovery",
  // After progression (20), before vehicles take over a seated survivor's movement.
  order: 24,
  stepSurvivorMovement: ({ sim, slot, command, dt, predict }) => {
    const closet = sim.progression.hiddenIn(slot.id)
    if (!closet) return false
    const p = slot.survivor
    p.x = closet.x
    p.y = closet.y
    p.vx = 0
    p.vy = 0
    p.crouching = false
    p.flashlightOn = false
    p.noise = 0
    p.stamina = Math.min(1, p.stamina + 0.22 * dt)
    if (!predict && command.interact) sim.progression.leaveHiding(slot)
    return true
  },
  transformAISurvivor: (sim, slot, view) => {
    if (sim.progression.hiddenIn(slot.id)) return { ...view, visibility: 0, noise: 0, flashlightOn: false }
    if (view.crouching) return { ...view, visibility: sim.progression.tuning.crouchVisibility }
    return view
  },
})
