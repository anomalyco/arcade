import { MELEE_WEAPONS, type MeleeWeaponId } from "../../shared/melee/index"
import type { OutbreakHarness, OutbreakHarnessHost } from "../harness"

export type MeleeStageSwing =
  | "none"
  | "light"
  | "heavy"
  | "combo"
  | "knockdown"
  | "finisher"
  | "crawler"
  | "limp"

export function stageMeleeScene(
  host: OutbreakHarnessHost,
  harness: OutbreakHarness,
  weapon: MeleeWeaponId = "crowbar",
  swing: MeleeStageSwing = "light",
) {
  const { settings } = host
  const session = host.session()
  const { progression, actorId } = session.view
  const ledger = progression.ledger
  const def = MELEE_WEAPONS[weapon] ?? MELEE_WEAPONS.crowbar
  const hb = ledger.store(`${actorId}/hotbar`)
  if (hb) {
    hb.slots[2] = { item: def.id, count: 1, charge: def.durability }
    hb.selected = 2
    hb.rev = ++ledger.rev
  }
  const slot = session.sim.slot(actorId)
  if (slot) {
    slot.survivor.meleePhase = "idle"
    slot.survivor.meleePhaseTime = 0
    slot.survivor.meleePhaseDuration = 0
    slot.survivor.meleeCombo = 1
    slot.survivor.meleeCharge = 0
    slot.survivor.meleeHeavy = false
    slot.survivor.meleeComboQueued = false
    slot.survivor.meleeComboUntil = 0
    slot.survivor.stamina = 1
    slot.survivor.exhausted = false
    progression.project(slot)
  }

  harness.pose(44, 44, 0)
  session.ai.agents.length = 0
  const z1 = session.ai.spawnZombie(session.view.town, 44 + Math.min(1.6, def.reach * 0.78), 43.85, "chase", Math.PI)
  const z2 = session.ai.spawnZombie(session.view.town, 44 + Math.min(1.75, def.reach * 0.85), 44.32, "chase", Math.PI)
  z1.targetX = z2.targetX = 44
  z1.targetY = z2.targetY = 44

  if (swing === "light") {
    session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false, fire: true }, 0, settings)
    for (let i = 0; i < 6; i++) {
      session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false }, 0, settings)
    }
  } else if (swing === "heavy") {
    session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false, fire: true, fireHeld: true }, 0, settings)
    for (let i = 0; i < 24; i++) {
      session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false, fireHeld: true }, 0, settings)
    }
    for (let i = 0; i < 5; i++) {
      session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false, fireHeld: false }, 0, settings)
    }
  } else if (swing === "combo") {
    session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false, fire: true }, 0, settings)
    for (let i = 0; i < 16; i++) {
      session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false, fire: i === 9 }, 0, settings)
    }
  } else if (swing === "knockdown") {
    z1.x = 44 + 1.05
    z1.y = 44
    z1.state = "knockdown"
    z1.timer = 2.2
    z1.hp = 42
    z2.x = 44 + 2.2
    z2.y = 44.55
    z2.state = "knockdown"
    z2.timer = 1.9
    z2.hp = 50
    session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false }, 0, settings)
  } else if (swing === "finisher") {
    z1.x = 44 + 0.95
    z1.y = 44
    z1.state = "knockdown"
    z1.timer = 2.1
    z1.hp = 38
    z2.x = 44 + 2.4
    z2.y = 44.6
    session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false, fire: true }, 0, settings)
    for (let i = 0; i < 4; i++) {
      session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false }, 0, settings)
    }
  } else if (swing === "crawler") {
    z1.x = 44 + 1.55
    z1.y = 43.82
    z1.detachedLimbs = ["right.thigh"]
    z1.state = "crawler"
    z1.hp = 48
    z2.x = 44 + 2.1
    z2.y = 44.38
    z2.detachedLimbs = ["left.thigh", "right.thigh"]
    z2.state = "crawler"
    z2.hp = 36
    for (let i = 0; i < 12; i++) {
      session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false }, 0, settings)
    }
  } else if (swing === "limp") {
    z1.x = 44 + 1.85
    z1.y = 43.82
    z1.limping = true
    z1.detachedLimbs = ["left.upperArm"]
    z1.hp = 54
    z2.x = 44 + 2.35
    z2.y = 44.38
    z2.limping = true
    z2.detachedLimbs = ["right.foreArm"]
    z2.hp = 62
    for (let i = 0; i < 15; i++) {
      session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false }, 0, settings)
    }
  } else {
    session.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false }, 0, settings)
  }

  const p = session.view.player
  return {
    weapon: p.meleeWeapon,
    label: def.label,
    weaponClass: def.weaponClass,
    durability: p.meleeDurability,
    maxDurability: p.meleeMaxDurability,
    phase: p.meleePhase,
    combo: p.meleeCombo,
    heavy: p.meleeHeavy,
    charge: p.meleeCharge,
    stamina: p.stamina,
    zombies: session.view.zombies.map((z) => ({
      id: z.id,
      hp: z.hp,
      state: z.state,
      limping: Boolean(z.limping),
      toughness: z.toughness,
      hitReaction: z.hitReaction,
      deathVariant: z.deathVariant,
      detached: z.detachedLimbs,
    })),
  }
}
