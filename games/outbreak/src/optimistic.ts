import { OptimisticEvents } from "@arcade/kit/net/prediction"
import { raycast } from "@arcade/kit/sim/geom"
import type { StoreState } from "@arcade/kit/sim/ledger"
import {
  DEFAULT_MELEE_TUNING,
  isMeleeWeapon,
  MELEE_WEAPONS,
  PISTOL_FIRE_COOLDOWN,
  PISTOL_MAG_SIZE,
  PISTOL_RANGE,
  PISTOL_RELOAD_TIME,
  SHOVE_COOLDOWN,
  ZOMBIE_CAPSULE_RADIUS,
  type CombatMeleeEvent,
  type CombatShotEvent,
  type MeleeWeaponId,
} from "../shared/combat"
import type { CoopSim, SurvivorSlot } from "../shared/coop-sim"
import { selectInteractTarget } from "../shared/interact"
import { sightRects } from "../shared/map"
import type { PersonalSnapshot, SharedSnapshot } from "../shared/net-protocol"
import type { Command } from "../shared/session"

export type OutbreakOptimisticKind = "shot" | "melee" | "shove" | "reload" | "door" | "window" | "pickup"

export type OutbreakOptimisticPayload = {
  shotId?: number
  swingId?: number
  tentativeHit?: boolean
  doorId?: string
  windowId?: string
  open?: boolean
  prevOpen?: boolean
  storeId?: string
  gained?: Record<string, number>
  expectedTotals?: Record<string, number>
  restoreBaseline?: () => void
}

export interface OutbreakOptimisticHost {
  readonly sim: CoopSim
  readonly local: SurvivorSlot
  readonly optimistic: OptimisticEvents<OutbreakOptimisticKind, OutbreakOptimisticPayload>
  readonly pendingPickupItems: Set<string>
  readonly hitStats: {
    predicted: number
    truePositive: number
    trueNegative: number
    falsePositive: number
    falseNegative: number
  }
  nextLocalEventId: number
  tentativeHitUntil: number
  confirmedHitUntil: number
}

const PERSONAL_STORES = ["belt", "hotbar", "pack"] as const
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function cloneStore(st: StoreState | undefined): StoreState | null {
  if (!st) return null
  return {
    id: st.id,
    mode: st.mode,
    scope: st.scope,
    ...(st.owner !== undefined ? { owner: st.owner } : {}),
    size: st.size,
    accepts: [...st.accepts],
    caps: { ...st.caps },
    selected: st.selected,
    revealed: st.revealed,
    ...(st.preferSlots ? { preferSlots: true } : {}),
    ...(st.at ? { at: { ...st.at } } : {}),
    slots: st.slots.map((s) => (s ? { ...s } : null)),
    counts: { ...st.counts },
    rev: st.rev,
  }
}

function restoreStore(sim: CoopSim, snap: StoreState | null, storeId: string): void {
  const ledger = sim.progression.ledger
  if (!snap) {
    ledger.stores.delete(storeId)
    return
  }
  ledger.stores.set(storeId, cloneStore(snap)!)
}

function actorTotals(sim: CoopSim, actorId: string): Map<string, number> {
  const out = new Map<string, number>()
  const ledger = sim.progression.ledger
  for (const suffix of PERSONAL_STORES) {
    const st = ledger.store(`${actorId}/${suffix}`)
    if (!st) continue
    if (st.mode === "counters") {
      for (const [k, v] of Object.entries(st.counts)) if (v > 0) out.set(k, (out.get(k) ?? 0) + v)
    } else {
      for (const s of st.slots) if (s && s.count > 0) out.set(s.item, (out.get(s.item) ?? 0) + s.count)
    }
  }
  return out
}

export function refreshPendingPickupItems(host: OutbreakOptimisticHost): void {
  host.pendingPickupItems.clear()
  for (const ev of host.optimistic.entries) {
    if (ev.kind === "pickup" && ev.payload.gained) {
      for (const item of Object.keys(ev.payload.gained)) host.pendingPickupItems.add(item)
    }
  }
}

function startOptimisticMelee(host: OutbreakOptimisticHost, weaponId: MeleeWeaponId): boolean {
  const p = host.local.survivor
  const time = host.sim.time
  if (p.vault) return false
  const weapon = MELEE_WEAPONS[weaponId]
  const tuning = DEFAULT_MELEE_TUNING
  if (p.meleePhase === "active" || p.meleePhase === "recovery") {
    if (weapon.comboLength > 1 && p.meleeCombo < weapon.comboLength) {
      p.meleeComboQueued = true
      return true
    }
    return false
  }
  if (p.meleePhase !== "idle") return false
  const canChain = weapon.comboLength > 1 && time <= p.meleeComboUntil && p.meleeCombo < weapon.comboLength && !p.meleeHeavy
  const nextCombo = (canChain ? p.meleeCombo + 1 : 1) as 1 | 2 | 3
  const exhScale = p.exhausted ? 0.68 : 1.0
  const comboSpeed = nextCombo === 2 ? 1.14 : nextCombo === 3 ? 0.88 : 1.0
  const effSpeed = Math.max(0.4, weapon.speed * tuning.meleeSpeedScale * exhScale * comboSpeed)
  const windupDuration = clamp(0.16 / effSpeed, 0.06, 0.2) * (nextCombo === 3 ? 1.18 : 1.0)
  p.meleeWeapon = weaponId
  p.equippedItem = weaponId
  p.meleeCombo = nextCombo
  p.meleePhase = "windup"
  p.meleePhaseTime = 0
  p.meleePhaseDuration = windupDuration
  p.meleeCharge = 0
  p.meleeHeavy = false
  p.meleeFinisher = false
  p.meleeComboQueued = false
  p.reloadRemaining = 0
  return true
}

function stepOptimisticMelee(
  host: OutbreakOptimisticHost,
  seq: number,
  dt: number,
  fireHeld: boolean,
  firstPass: boolean,
): void {
  const p = host.local.survivor
  const weaponId = p.meleeWeapon ?? (isMeleeWeapon(p.equippedItem) ? p.equippedItem : null)
  if (!weaponId || p.vault) {
    if (p.meleePhase !== "idle") {
      p.meleePhase = "idle"
      p.meleePhaseTime = 0
      p.meleeCharge = 0
      p.meleeHeavy = false
      p.meleeComboQueued = false
    }
    return
  }
  const weapon = MELEE_WEAPONS[weaponId]
  const tuning = DEFAULT_MELEE_TUNING
  const exhScale = p.exhausted ? 0.68 : 1.0
  const comboSpeed = p.meleeCombo === 2 ? 1.14 : p.meleeCombo === 3 ? 0.88 : 1.0
  const effSpeed = Math.max(0.4, weapon.speed * tuning.meleeSpeedScale * exhScale * comboSpeed)

  if (p.meleePhase === "windup") {
    p.meleePhaseTime += dt
    const baseWindup = p.meleePhaseDuration
    const chargeWindow = Math.max(0.12, tuning.meleeChargeTime)
    if (fireHeld && p.meleePhaseTime >= baseWindup * 0.85) {
      const extra = p.meleePhaseTime - baseWindup * 0.85
      p.meleeCharge = clamp(extra / chargeWindow, 0, 1)
      if (p.meleeCharge >= 0.25) p.meleeHeavy = true
    }
    const maxHoldTime = baseWindup + chargeWindow * 1.35
    if (p.meleePhaseTime >= baseWindup && (!fireHeld || p.meleePhaseTime >= maxHoldTime)) {
      const activeDuration = clamp(0.16 / effSpeed, 0.07, 0.16) * (p.meleeHeavy ? 1.12 : 1.0)
      p.meleePhase = "active"
      p.meleePhaseTime = 0
      p.meleePhaseDuration = activeDuration
      p.meleeSwingId = (p.meleeSwingId + 1) | 0
      if (firstPass) {
        const swingId = -(++host.nextLocalEventId)
        const ev: CombatMeleeEvent = {
          id: swingId,
          time: host.sim.time,
          attackerId: host.local.id,
          attackerIndex: host.local.index,
          weapon: weapon.id,
          x: p.x,
          y: p.y,
          aim: p.aim,
          arc: weapon.arc * tuning.meleeArcScale * (p.meleeHeavy ? 1.15 : 1.0),
          reach: weapon.reach * tuning.meleeReachScale,
          combo: p.meleeCombo,
          heavy: p.meleeHeavy,
          charge: Number(p.meleeCharge.toFixed(3)),
          hits: [],
          hitDoorId: null,
          doorBroke: false,
          weaponBroke: false,
          durabilityLow: false,
          seed: ((swingId * 0x85ebca6b) ^ Math.floor(host.sim.time * 1000)) >>> 0,
          predicted: true,
        }
        host.sim.combat.meleeSwings.push(ev)
        host.optimistic.predict({
          seq,
          kind: "melee",
          payload: { swingId },
        })
      }
    }
    return
  }

  if (p.meleePhase === "active") {
    p.meleePhaseTime += dt
    if (p.meleePhaseTime >= p.meleePhaseDuration) {
      const isFinalCombo = p.meleeCombo >= weapon.comboLength || p.meleeHeavy
      p.meleePhase = "recovery"
      p.meleePhaseTime = 0
      p.meleePhaseDuration = clamp(0.22 / effSpeed, 0.1, 0.28) * (isFinalCombo ? 1.25 : 1.0)
    }
    return
  }

  if (p.meleePhase === "recovery") {
    p.meleePhaseTime += dt
    if (
      p.meleeComboQueued &&
      p.meleePhaseTime >= p.meleePhaseDuration * 0.45 &&
      weapon.comboLength > 1 &&
      p.meleeCombo < weapon.comboLength &&
      !p.meleeHeavy
    ) {
      const nextCombo = (p.meleeCombo + 1) as 1 | 2 | 3
      const nextSpeed = Math.max(
        0.4,
        weapon.speed * tuning.meleeSpeedScale * exhScale * (nextCombo === 2 ? 1.14 : nextCombo === 3 ? 0.88 : 1.0),
      )
      p.meleeCombo = nextCombo
      p.meleePhase = "windup"
      p.meleePhaseTime = 0
      p.meleePhaseDuration = clamp(0.13 / nextSpeed, 0.05, 0.17) * (nextCombo === 3 ? 1.15 : 1.0)
      p.meleeCharge = 0
      p.meleeHeavy = false
      p.meleeFinisher = false
      p.meleeComboQueued = false
      return
    }
    if (p.meleePhaseTime >= p.meleePhaseDuration) {
      const finishedCombo = p.meleeCombo
      const wasHeavy = p.meleeHeavy
      p.meleePhase = "idle"
      p.meleePhaseTime = 0
      p.meleePhaseDuration = 0
      p.meleeCharge = 0
      p.meleeHeavy = false
      p.meleeFinisher = false
      p.meleeComboQueued = false
      if (!wasHeavy && weapon.comboLength > 1 && finishedCombo < weapon.comboLength) {
        p.meleeComboUntil = host.sim.time + Math.max(0.08, tuning.meleeComboWindow)
      } else {
        p.meleeCombo = 1
        p.meleeComboUntil = -Infinity
      }
    }
  }
}

/**
 * Steps one 60 Hz client tick of optimistic feedback for the local co-op survivor.
 * When `firstPass` is true (the press frame), cosmetic events (shots, melee swings, shoves, reloads, doors, windows,
 * item pickups) fire immediately at 0 ms and register in `host.optimistic`. During `Predictor.reconcile` replay
 * (`firstPass === false`), timers and state machines advance deterministically without re-emitting one-shot FX.
 */
export function stepOutbreakOptimisticTick(
  host: OutbreakOptimisticHost,
  seq: number,
  command: Command,
  dt: number,
  firstPass: boolean,
): void {
  const sim = host.sim
  const slot = host.local
  const p = slot.survivor
  const progression = sim.progression
  const town = sim.town

  if (p.vehicleId !== null && p.vehicleId !== undefined) return

  if (command.hotbarSlot !== undefined) {
    const prevMag = p.magAmmo
    progression.select(slot, command.hotbarSlot)
    progression.project(slot)
    if (p.equippedItem === "pistol") p.magAmmo = prevMag
  }
  if (command.hotbarDelta) {
    const prevMag = p.magAmmo
    progression.select(slot, undefined, command.hotbarDelta)
    progression.project(slot)
    if (p.equippedItem === "pistol") p.magAmmo = prevMag
  }

  p.fireCooldown = Math.max(0, p.fireCooldown - dt)
  p.recoil = Math.max(0, p.recoil - dt * 5.5)
  p.shoveCooldown = Math.max(0, p.shoveCooldown - dt)
  p.shoveAnim = Math.max(0, p.shoveAnim - dt * 3.8)
  if (p.reloadRemaining > 0) {
    if (p.vault) {
      p.reloadRemaining = 0
    } else {
      p.reloadRemaining = Math.max(0, p.reloadRemaining - dt)
      if (p.reloadRemaining <= 0) {
        const needed = Math.max(0, PISTOL_MAG_SIZE - p.magAmmo)
        const transfer = Math.min(needed, p.reserveAmmo)
        p.magAmmo += transfer
        p.reserveAmmo -= transfer
      }
    }
  }

  // Optimistic door, window, and item pickup on the press frame
  if (firstPass && (command.interact || command.pick?.mode === "take") && !p.vault) {
    const target = selectInteractTarget(town, p, sim.registry)
    const action = command.interactAction ?? (command.sprint && target?.alt ? target.alt.id : target?.primary.id)
    if (command.interact && target?.kind === "door" && (action === "toggle" || action === undefined)) {
      const door = town.doors.find((d) => d.id === target.id)
      if (door && !door.locked && sim.ai.getBarricadePlanks(door.id) === 0) {
        const prevOpen = door.open
        const nextOpen = !door.open
        door.open = nextOpen
        sim.rebuildSolids()
        host.optimistic.predict({
          seq,
          kind: "door",
          key: `door:${door.id}`,
          payload: { doorId: door.id, open: nextOpen, prevOpen },
          reapply: () => {
            if (door.open !== nextOpen) {
              door.open = nextOpen
              sim.rebuildSolids()
            }
          },
          rollback: () => {
            if (door.open !== prevOpen) {
              door.open = prevOpen
              sim.rebuildSolids()
            }
          },
        })
      }
    } else if (command.interact && target?.kind === "window" && (action === "toggle" || action === undefined)) {
      const win = town.windows.find((w) => w.id === target.id)
      if (win && win.openable !== false && sim.ai.getBarricadePlanks(win.id) === 0) {
        const prevOpen = win.open
        const nextOpen = !win.open
        win.open = nextOpen
        sim.rebuildSolids()
        host.optimistic.predict({
          seq,
          kind: "window",
          key: `window:${win.id}`,
          payload: { windowId: win.id, open: nextOpen, prevOpen },
          reapply: () => {
            if (win.open !== nextOpen) {
              win.open = nextOpen
              sim.rebuildSolids()
            }
          },
          rollback: () => {
            if (win.open !== prevOpen) {
              win.open = prevOpen
              sim.rebuildSolids()
            }
          },
        })
      }
    } else if (
      command.pick?.mode === "take" ||
      (command.interact && action === "take" && target && (target.kind === "drop" || target.kind === "container"))
    ) {
      const storeId = (target ? progression.storeFor(target) : null) ?? target?.id ?? ""
      if (storeId) {
        const ledger = progression.ledger
        const targetBefore = cloneStore(ledger.store(storeId))
        const beltBefore = cloneStore(ledger.store(`${slot.id}/belt`))
        const hotbarBefore = cloneStore(ledger.store(`${slot.id}/hotbar`))
        const packBefore = cloneStore(ledger.store(`${slot.id}/pack`))
        const totalsBefore = actorTotals(sim, slot.id)
        const took =
          command.pick?.mode === "take"
            ? progression.take(slot, storeId, command.pick.index)
            : progression.take(slot, storeId)
        if (took) {
          const totalsAfter = actorTotals(sim, slot.id)
          const gained: Record<string, number> = {}
          const expectedTotals: Record<string, number> = {}
          for (const [item, afterCount] of totalsAfter) {
            const beforeCount = totalsBefore.get(item) ?? 0
            if (afterCount > beforeCount) {
              gained[item] = afterCount - beforeCount
              expectedTotals[item] = afterCount
            }
          }
          if (Object.keys(gained).length > 0) {
            const targetAfter = cloneStore(ledger.store(storeId))
            const beltAfter = cloneStore(ledger.store(`${slot.id}/belt`))
            const hotbarAfter = cloneStore(ledger.store(`${slot.id}/hotbar`))
            const packAfter = cloneStore(ledger.store(`${slot.id}/pack`))
            const restoreBaseline = () => {
              restoreStore(sim, targetBefore, storeId)
              restoreStore(sim, beltBefore, `${slot.id}/belt`)
              restoreStore(sim, hotbarBefore, `${slot.id}/hotbar`)
              restoreStore(sim, packBefore, `${slot.id}/pack`)
            }
            host.optimistic.predict({
              seq,
              kind: "pickup",
              key: `pickup:${storeId}`,
              payload: { storeId, gained, expectedTotals, restoreBaseline },
              reapply: () => {
                restoreStore(sim, targetAfter, storeId)
                restoreStore(sim, beltAfter, `${slot.id}/belt`)
                restoreStore(sim, hotbarAfter, `${slot.id}/hotbar`)
                restoreStore(sim, packAfter, `${slot.id}/pack`)
                progression.project(slot)
              },
              rollback: () => {
                restoreStore(sim, targetBefore, storeId)
                progression.project(slot)
              },
            })
            refreshPendingPickupItems(host)
          }
        }
      }
    }
  }

  const held = progression.selected(slot.id)?.item
  const use = progression.heldUse(slot.id)
  if (command.reload && held !== "flashlight") {
    if (p.reloadRemaining <= 0 && !p.vault && p.magAmmo < PISTOL_MAG_SIZE && p.reserveAmmo > 0) {
      p.reloadRemaining = PISTOL_RELOAD_TIME
      if (firstPass) {
        host.optimistic.predict({
          seq,
          kind: "reload",
          key: "reload",
          payload: {},
          rollback: () => {
            p.reloadRemaining = 0
          },
        })
      }
    }
  }

  const triggerShove = () => {
    if (p.shoveCooldown <= 0 && !p.vault) {
      p.shoveCooldown = SHOVE_COOLDOWN
      p.shoveAnim = 1.0
      if (firstPass) {
        host.optimistic.predict({
          seq,
          kind: "shove",
          key: "shove",
          payload: {},
          rollback: () => {
            p.shoveAnim = 0
            p.shoveCooldown = 0
          },
        })
      }
    }
  }

  if (command.melee) triggerShove()

  if (command.fire) {
    if (use === "fire") {
      if (p.reloadRemaining <= 0 && p.fireCooldown <= 0 && !p.vault) {
        if (p.magAmmo <= 0) {
          if (p.reserveAmmo > 0) {
            p.reloadRemaining = PISTOL_RELOAD_TIME
            if (firstPass) {
              host.optimistic.predict({
                seq,
                kind: "reload",
                key: "reload",
                payload: {},
                rollback: () => {
                  p.reloadRemaining = 0
                },
              })
            }
          } else if (firstPass) {
            p.lootMessage = "Out of 9mm ammo! Search houses (E) or shove (V)"
            p.lootMessageUntil = sim.time + 2.2
          }
        } else {
          p.magAmmo--
          p.fireCooldown = PISTOL_FIRE_COOLDOWN
          p.recoil = 1.0
          if (firstPass) {
            const dx = Math.cos(p.aim)
            const dy = Math.sin(p.aim)
            const ox = p.x + dx * 0.32
            const oy = p.y + dy * 0.32
            const blockers = sightRects(town)
            const wallT = Math.min(PISTOL_RANGE, raycast(ox, oy, dx, dy, blockers, PISTOL_RANGE))
            let bestT = wallT
            let hitZombie = false
            for (const z of sim.ai.agents) {
              if (z.state === "dead") continue
              const fx = z.x - ox
              const fy = z.y - oy
              const proj = fx * dx + fy * dy
              if (proj < 0 || proj > bestT) continue
              const perpSq = fx * fx + fy * fy - proj * proj
              const effR = ZOMBIE_CAPSULE_RADIUS + (proj > 4.0 ? 0.08 : 0.04)
              if (perpSq <= effR * effR) {
                bestT = proj
                hitZombie = true
              }
            }
            const shotId = -(++host.nextLocalEventId)
            const localShot: CombatShotEvent = {
              id: shotId,
              time: sim.time,
              fromX: ox,
              fromY: oy,
              toX: ox + dx * bestT,
              toY: oy + dy * bestT,
              aim: p.aim,
              hitZombieId: null,
              killed: false,
              detachBone: null,
              seed: ((shotId * 0x9e3779b9) ^ Math.floor(sim.time * 1000)) >>> 0,
              predicted: true,
              tentativeHit: hitZombie,
            }
            sim.combat.shots.push(localShot)
            host.hitStats.predicted++
            if (hitZombie) host.tentativeHitUntil = sim.time + 0.22
            host.optimistic.predict({
              seq,
              kind: "shot",
              payload: { shotId, tentativeHit: hitZombie },
              rollback: () => {
                p.magAmmo = Math.min(p.magCapacity, p.magAmmo + 1)
                host.tentativeHitUntil = 0
              },
            })
          }
        }
      }
    } else if (use === "melee") {
      const wpn =
        progression.heldMeleeWeapon(slot.id) ??
        p.meleeWeapon ??
        (isMeleeWeapon(p.equippedItem) ? p.equippedItem : null)
      if (wpn) startOptimisticMelee(host, wpn)
    } else if (use === "shove") {
      triggerShove()
    }
  }

  stepOptimisticMelee(host, seq, dt, Boolean(command.fireHeld ?? command.fire), firstPass)
}

/**
 * Matches newly arrived server shots and melee swings from `shared` against the local player's pending optimistic
 * predictions, marking `confirmedLocal = true` so press-frame cosmetics never double-fire while server-confirmed
 * outcomes (blood splatter, limb severing, hit-stop, zombie hit/death sounds) run on confirmation.
 */
export function matchServerCombatEvents(host: OutbreakOptimisticHost, shared: SharedSnapshot): void {
  const existingShots = host.sim.combat.shots
  for (const shot of shared.shots) {
    if (existingShots.some((x) => x.id === shot.id)) continue
    if (shot.shooter === host.local.index) {
      const matched = host.optimistic.confirmWhere((e) => e.kind === "shot")
      if (matched) {
        ;(shot as CombatShotEvent).confirmedLocal = true
        const serverHit = shot.hitZombieId !== null
        const clientHit = Boolean(matched.payload.tentativeHit)
        if (clientHit && serverHit) host.hitStats.truePositive++
        else if (!clientHit && !serverHit) host.hitStats.trueNegative++
        else if (clientHit && !serverHit) host.hitStats.falsePositive++
        else host.hitStats.falseNegative++
        if (serverHit) {
          host.confirmedHitUntil = host.sim.time + 0.18
          host.tentativeHitUntil = 0
        } else {
          host.tentativeHitUntil = 0
        }
      }
    }
    existingShots.push(shot)
  }

  if (shared.meleeSwings?.length) {
    const existingSwings = host.sim.combat.meleeSwings
    for (const m of shared.meleeSwings) {
      if (existingSwings.some((x) => x.id === m.id)) continue
      if (m.attackerIndex === host.local.index) {
        const matched = host.optimistic.confirmWhere((e) => e.kind === "melee")
        if (matched) {
          m.confirmedLocal = true
        }
      }
      existingSwings.push(m)
    }
  }
}

/** Restores any pre-pickup ledger baselines before applying `personal.ledger` so server deltas apply cleanly. */
export function prepareOutbreakLedgerReconcile(host: OutbreakOptimisticHost): void {
  for (const ev of host.optimistic.entries) {
    if (ev.kind === "pickup") ev.payload.restoreBaseline?.()
  }
}

/** Reconciles optimistic predictions up to `personal.ack` and re-applies in-flight world overlays. */
export function reconcileOutbreakOptimistic(
  host: OutbreakOptimisticHost,
  personal: PersonalSnapshot,
  shared: SharedSnapshot,
): void {
  const sim = host.sim
  const slot = host.local
  const p = slot.survivor
  const town = sim.town

  host.optimistic.reconcile(personal.ack, (ev) => {
    switch (ev.kind) {
      case "door": {
        const idx = town.doors.findIndex((d) => d.id === ev.payload.doorId)
        return idx >= 0 && shared.doors[idx]?.open === ev.payload.open
      }
      case "window": {
        const idx = town.windows.findIndex((w) => w.id === ev.payload.windowId)
        return idx >= 0 && shared.windows[idx]?.open === ev.payload.open
      }
      case "pickup": {
        const expected = ev.payload.expectedTotals
        if (!expected) return false
        const totals = actorTotals(sim, slot.id)
        return Object.entries(expected).every(([item, min]) => (totals.get(item) ?? 0) >= min)
      }
      case "reload":
        return (personal.survivor.reloadRemaining ?? 0) > 0 || (personal.survivor.magAmmo ?? 0) >= PISTOL_MAG_SIZE
      case "shove":
        return (personal.survivor.shoveCooldown ?? 0) > 0 || (personal.survivor.shoveAnim ?? 0) > 0
      case "shot":
        return (personal.survivor.fireCooldown ?? 0) > 0 || (personal.survivor.recoil ?? 0) > 0
      case "melee":
        return (personal.survivor.meleePhase ?? "idle") !== "idle" || (personal.survivor.meleeSwingId ?? 0) > 0
    }
  })
  refreshPendingPickupItems(host)
  void p
}

/** Smoothly eases door swing angles in co-op so press-frame toggles and rare rejections never pop. */
export function stepOutbreakDoorAngles(host: OutbreakOptimisticHost, dt: number): void {
  const alpha = 1 - Math.exp(-18 * Math.max(0, dt))
  for (const d of host.sim.town.doors) {
    const target = d.open ? -Math.PI / 2 : 0
    const cur = (d as { angle?: number }).angle
    if (cur === undefined) {
      ;(d as { angle?: number }).angle = target
      continue
    }
    const next = cur + (target - cur) * alpha
    ;(d as { angle?: number }).angle = Math.abs(target - next) < 1e-3 ? target : next
  }
}
