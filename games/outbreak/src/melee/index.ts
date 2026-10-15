import { attenuateShake } from "@arcade/kit/client/camera"
import {
  DEFAULT_MELEE_TUNING,
  isMeleeWeapon,
  MELEE_WEAPON_IDS,
  MELEE_WEAPONS,
  meleeControls,
  outbreakMeleeSharedFeature,
  type MeleeWeaponId,
} from "../../shared/melee/index"
import { supportHeight } from "../../shared/terrain"
import { registerOutbreakClientFeature } from "../feature-registry"
import type { OutbreakHarness, OutbreakHarnessHost } from "../harness"

export { outbreakMeleeSharedFeature }
export * from "../../shared/melee/index"

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

export const outbreakMeleeFeature = registerOutbreakClientFeature({
  id: "melee",
  order: 22,
  settingsGroup: {
    subsystem: "combat",
    defaults: DEFAULT_MELEE_TUNING,
  },
  labControls: (host) => [
    ...meleeControls,
    {
      key: "equipNextMeleeWeapon",
      label: "Cycle melee weapon",
      group: "Melee",
      type: "action",
      run: () => {
        if (!host.progressionHost.offline()) return
        const session = host.session()
        const { progression, actorId } = session.view
        const ledger = progression.ledger
        const hb = ledger.store(`${actorId}/hotbar`)
        const curItem = hb?.slots[2]?.item ?? session.view.player.meleeWeapon
        const idx = curItem ? MELEE_WEAPON_IDS.indexOf(curItem as (typeof MELEE_WEAPON_IDS)[number]) : -1
        const nextId = MELEE_WEAPON_IDS[(idx + 1) % MELEE_WEAPON_IDS.length]!
        const def = MELEE_WEAPONS[nextId]
        if (hb) {
          hb.slots[2] = { item: nextId, count: 1, charge: def.durability }
          hb.selected = 2
          hb.rev = ++ledger.rev
        }
        const slot = session.sim.slot(actorId)
        if (slot) progression.project(slot)
      },
    },
    {
      key: "repairMeleeWeapon",
      label: "Repair held weapon",
      group: "Melee",
      type: "action",
      run: () => {
        if (!host.progressionHost.offline()) return
        const session = host.session()
        const { progression, actorId } = session.view
        const ledger = progression.ledger
        const hb = ledger.store(`${actorId}/hotbar`)
        const st = hb?.slots[2]
        if (st && st.item in MELEE_WEAPONS) {
          const def = MELEE_WEAPONS[st.item as keyof typeof MELEE_WEAPONS]
          st.charge = def.durability
          hb.rev = ++ledger.rev
          const slot = session.sim.slot(actorId)
          if (slot) progression.project(slot)
        }
      },
    },
  ],
  gameCommands: (host) => [
    {
      id: "melee.stage",
      label: "Equip Melee Weapon & Stage Arena",
      shortLabel: "Melee Stage",
      category: "Scene",
      undoable: false,
      args: {
        weapon: {
          type: "string",
          description: `Melee weapon ID (${MELEE_WEAPON_IDS.join(", ")})`,
        },
        swing: {
          type: "string",
          description: "Optional swing/state action (none, light, heavy, combo, knockdown, finisher, crawler, limp)",
        },
      },
      enabled: () => !host.coop.net,
      run: async (_ctx, args) => {
        const rawWpn = String(args?.weapon ?? "crowbar")
        const weapon: MeleeWeaponId = isMeleeWeapon(rawWpn) ? rawWpn : "crowbar"
        const swing = String(args?.swing ?? "light") as MeleeStageSwing
        const res = (host.harness() as any).stageMelee(weapon, swing)
        host.draw(1 / 60)
        await host.device.queue.onSubmittedWorkDone()
        return res
      },
    },
  ],
  harnessMethods: (host, harness) => ({
    /** Equips a melee weapon in slot 3 (index 2), positions the survivor, spawns target zombies, and optionally stages combat states. */
    stageMelee(weapon: MeleeWeaponId = "crowbar", swing: MeleeStageSwing = "light") {
      return stageMeleeScene(host, harness, weapon, swing)
    },
  }),
  feel: {
    processFrame: ({ tracker, session, combatFx, zombieCrowd, addSprites, addCount, dt, settings, cam }) => {
      const { player: p, town, time } = session.view
      return combatFx.processMeleeSwings(
        session.view.meleeSwings,
        time,
        dt,
        session.ai,
        zombieCrowd,
        (x, z) => supportHeight(town, x, z),
        addSprites,
        addCount,
        (swing) => {
          const distFromMe = Math.hypot(swing.x - p.x, swing.y - p.y)
          const isLocal = swing.attackerId === session.view.actorId || distFromMe < 1.6
          if (isLocal) {
            const hitCount = swing.hits.length
            const anyKill = swing.hits.some((h) => h.killed)
            const anySever = swing.hits.some((h) => Boolean(h.detachBone))
            const anyHead = swing.hits.some((h) => h.headshot)
            const heavyScale = swing.heavy ? 1.45 + 0.25 * swing.charge : swing.combo === 3 ? 1.25 : 1.0
            if (hitCount > 0 || swing.hitDoorId) {
              const k = heavyScale * (1 + Math.min(2, Math.max(0, hitCount - 1)) * 0.28) * (anySever ? 1.22 : 1.0)
              cam.add((anyKill ? 0.36 : 0.24) * k, swing.aim, (anyKill ? 2.6 : 1.7) * k)
              cam.punch(-0.24 * k, (swing.combo === 2 ? -1 : 1) * 0.011 * k)
              const stopDur = (swing.heavy ? 0.044 : anyKill || anyHead ? 0.036 : 0.026) * (anySever ? 1.15 : 1.0)
              tracker.hitStop.trigger(stopDur, 0.06, !cam.isReducedMotion())
              if (!cam.isReducedMotion()) {
                tracker.motionBurst.add(
                  { dir: swing.aim, directional: 0.0065 * k, radial: 0.0045 * k, boost: 0.45 * k },
                  settings.motion.burst,
                )
              }
            } else {
              cam.add(0.09 * heavyScale, swing.aim, 0.55 * heavyScale)
              cam.punch(-0.07 * heavyScale, (swing.combo === 2 ? -1 : 1) * 0.005 * heavyScale)
            }
          } else if (distFromMe < 14 && (swing.hits.length > 0 || swing.hitDoorId)) {
            const peerAtt = attenuateShake(distFromMe, 14) * 0.35
            cam.add(0.22 * peerAtt, swing.aim, 1.2 * peerAtt)
          }
        },
      )
    },
  },
  netSession: {
    onApplyWorld: (net, s) => {
      if (s.meleeSwings?.length) {
        const swings = net.sim.combat.meleeSwings
        for (const m of s.meleeSwings) if (!swings.some((x) => x.id === m.id)) swings.push(m)
      }
    },
    onSyncFrame: (net) => {
      const melee = net.sim.combat.meleeSwings
      for (let i = melee.length - 1; i >= 0; i--) {
        if (net.sim.time - melee[i]!.time > 0.6) melee.splice(i, 1)
      }
    },
  },
})
