import {
  type ByteReader,
  type ByteWriter,
  packAngle,
  packNibblePair,
  unpackAngle,
  unpackNibblePair,
} from "@arcade/kit/net/bytes"
import { inInterestBubble } from "@arcade/kit/net/interest"
import { registerOutbreakSharedFeature } from "../feature-registry"
import { toggleFlashlight } from "../flashlight"
import { sightRects } from "../map"
import type { VehicleState } from "../net-protocol"
import { stepStamina } from "../stamina"
import {
  boxOf,
  DEFAULT_VEHICLE_TUNING,
  pushOutBox,
  VEHICLE_KINDS,
  vehicleSolidRects,
  type VehicleTuning,
} from "../vehicles"

export * from "../vehicles"

const SEC_VEHICLES = 64
const cm = (v: number) => Math.round(v * 100)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function sameVehicleState(a: VehicleState, b: VehicleState): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    cm(a.x) === cm(b.x) &&
    cm(a.y) === cm(b.y) &&
    packAngle(a.h) === packAngle(b.h) &&
    Math.round(a.vx * 100) === Math.round(b.vx * 100) &&
    Math.round(a.vy * 100) === Math.round(b.vy * 100) &&
    Math.round(a.w * 100) === Math.round(b.w * 100) &&
    a.hp === b.hp &&
    a.fuel === b.fuel &&
    a.hasBattery === b.hasBattery &&
    a.hasKeys === b.hasKeys &&
    a.headlights === b.headlights &&
    a.engineOn === b.engineOn &&
    a.horn === b.horn &&
    a.wreck === b.wreck &&
    a.handbrake === b.handbrake &&
    Math.round(a.throttle * 7) === Math.round(b.throttle * 7) &&
    Math.round(a.steer * 7) === Math.round(b.steer * 7) &&
    a.seats.length === b.seats.length &&
    a.seats.every((s, i) => s === b.seats[i])
  )
}

export function writeVehicleState(w: ByteWriter, v: VehicleState): void {
  const kindIdx = Math.max(0, VEHICLE_KINDS.indexOf(v.kind))
  const vFlags =
    (v.hasBattery ? 1 : 0) |
    (v.hasKeys ? 2 : 0) |
    (v.headlights ? 4 : 0) |
    (v.engineOn ? 8 : 0) |
    (v.horn ? 16 : 0) |
    (v.wreck ? 32 : 0) |
    (v.handbrake ? 64 : 0)
  const vxI = Math.round(clamp(v.vx, -320, 320) * 100)
  const vyI = Math.round(clamp(v.vy, -320, 320) * 100)
  const wI = Math.round(clamp(v.w, -30, 30) * 100)
  const thrQ = Math.round(clamp(v.throttle, -1, 1) * 7)
  const strQ = Math.round(clamp(v.steer, -1, 1) * 7)
  const moving = vxI !== 0 || vyI !== 0 || wI !== 0 || thrQ !== 0 || strQ !== 0
  const occupied = v.seats.some((s) => s >= 0)
  w.u16(v.id)
  w.u8((kindIdx & 7) | (moving ? 8 : 0) | (occupied ? 16 : 0))
  w.u8(vFlags)
  w.i32(cm(v.x)).i32(cm(v.y)).u16(packAngle(v.h))
  w.u16(Math.round(clamp(v.hp, 0, 65535))).u8(Math.round(clamp(v.fuel, 0, 255)))
  if (moving) {
    w.i16(vxI).i16(vyI).i16(wI)
    w.u8(packNibblePair(thrQ, strQ))
  }
  if (occupied) {
    let packedSeats = 0
    for (let i = 0; i < 4; i++) {
      const s = v.seats[i] ?? -1
      const nib = s >= 0 && s <= 7 ? s : 0x0f
      packedSeats |= nib << (i * 4)
    }
    w.u16(packedSeats)
  }
}

export function readVehicleState(r: ByteReader): VehicleState {
  const id = r.u16()
  const hdr = r.u8()
  const kind = VEHICLE_KINDS[hdr & 7] ?? "sedan"
  const moving = Boolean(hdr & 8)
  const occupied = Boolean(hdr & 16)
  const vFlags = r.u8()
  const x = r.i32() / 100
  const y = r.i32() / 100
  const h = unpackAngle(r.u16())
  const hp = r.u16()
  const fuel = r.u8()
  let vx = 0
  let vy = 0
  let w = 0
  let throttle = 0
  let steer = 0
  if (moving) {
    vx = r.i16() / 100
    vy = r.i16() / 100
    w = r.i16() / 100
    const [thrQ, strQ] = unpackNibblePair(r.u8())
    throttle = thrQ / 7
    steer = strQ / 7
  }
  const seats = [-1, -1, -1, -1]
  if (occupied) {
    const packedSeats = r.u16()
    for (let i = 0; i < 4; i++) {
      const nib = (packedSeats >>> (i * 4)) & 0x0f
      seats[i] = nib === 0x0f ? -1 : nib
    }
  }
  return {
    id,
    kind,
    x,
    y,
    h,
    vx,
    vy,
    w,
    hp,
    fuel,
    hasBattery: Boolean(vFlags & 1),
    hasKeys: Boolean(vFlags & 2),
    headlights: Boolean(vFlags & 4),
    engineOn: Boolean(vFlags & 8),
    horn: Boolean(vFlags & 16),
    wreck: Boolean(vFlags & 32),
    handbrake: Boolean(vFlags & 64),
    throttle,
    steer,
    seats,
  }
}

export const outbreakVehiclesSharedFeature = registerOutbreakSharedFeature<
  undefined,
  VehicleState[],
  VehicleTuning,
  VehicleState[]
>({
  id: "vehicles",
  order: 25,
  tuning: {
    namespace: "vehicle",
    defaults: DEFAULT_VEHICLE_TUNING,
  },
  onChunkSync: (sim) => {
    sim.vehicles.syncChunks(sim.worldStream, sim.town)
    sim.vehicleSolids = vehicleSolidRects(sim.town)
  },
  onTopologyChanged: (sim) => {
    sim.vehicles.syncChunks(sim.worldStream, sim.town)
    sim.vehicleSolids = vehicleSolidRects(sim.town)
  },
  stepSurvivorMovement: ({ sim, slot, command, dt, resolved, predict, clampClassic, viewTime }) => {
    Object.assign(sim.vehicles.tuning, resolved.vehicle)
    const p = slot.survivor
    if (!p.vehicleId) return false
    const wasPassenger = (p.seatIndex ?? 0) > 0
    const handled = sim.vehicles.stepSeatedSurvivor(
      slot,
      command,
      dt,
      sim.vehicleSolids,
      sim.progression,
      sim.ai,
      sim.time,
      predict,
    )
    if (!handled) return false
    stepStamina(p, false, false, dt, resolved.stamina)
    if (p.vehicleId && wasPassenger && (p.seatIndex ?? 0) > 0) {
      if (!predict && command.hotbarSlot !== undefined) {
        sim.progression.select(slot, command.hotbarSlot)
        sim.progression.project(slot)
      }
      if (!predict && command.hotbarDelta) {
        sim.progression.select(slot, undefined, command.hotbarDelta)
        sim.progression.project(slot)
      }
      if (command.flashlight) toggleFlashlight(p)
      if (!predict) {
        const ammo = sim.progression.pistol(slot.id)
        const use = sim.progression.heldUse(slot.id)
        const blockers = sightRects(sim.town)
        if (command.reload) sim.combat.startReload(p, sim.ai, sim.time, ammo)
        if (command.fire && use === "fire") {
          if (resolved.infiniteAmmo) ammo.fill()
          if (viewTime !== undefined && viewTime < sim.time) {
            sim.rewind.withRewoundPositions(sim.ai.agents, viewTime, () =>
              sim.combat.firePistol(p, sim.ai, blockers, sim.time, ammo),
            )
          } else {
            sim.combat.firePistol(p, sim.ai, blockers, sim.time, ammo)
          }
        }
      }
    }
    if (predict && !clampClassic) {
      sim.syncWorldChunks()
    }
    return true
  },
  pushOutSurvivor: (sim, survivor, radius) => {
    for (const v of sim.vehicles.list) pushOutBox(survivor, radius, boxOf(v, v.spec))
  },
  stepWorld: ({ sim, dt, resolved }) => {
    Object.assign(sim.vehicles.tuning, resolved.vehicle)
    sim.vehicles.stepWorld(dt, sim.time, sim.town, sim.vehicleSolids, sim.slots, sim.ai, sim.progression)
  },
  transformAISurvivor: (sim, slot, view) => {
    const p = slot.survivor
    const v = sim.vehicles.vehicleOf(p)
    if (v && (p.seatIndex ?? 0) === 0) {
      const hlOn = v.headlights && v.hasBattery && !v.wreck
      return {
        ...view,
        aim: hlOn ? v.h : p.aim,
        flashlightOn: hlOn || p.flashlightOn,
        flashlightOutput: hlOn ? 1 : p.flashlightOutput,
        lightSignature: hlOn ? sim.vehicles.tuning.headlightRange : p.lightSignature,
        noise: v.engineOn ? Math.max(p.noise, sim.vehicles.tuning.engineNoise * 0.45) : p.noise,
      }
    }
    return view
  },
  modifySurvivorDamage: (sim, slot, damage) => {
    const v = sim.vehicles.vehicleOf(slot.survivor)
    if (!v) return damage
    const armor = v.spec.seats[slot.survivor.seatIndex ?? 0]?.armor ?? 0.4
    return damage * armor
  },
  refreshPrompt: (_sim, slot) => {
    if (!slot.survivor.vehicleId) return false
    slot.peek = null
    slot.prompt = undefined
    return true
  },
  netSection: {
    bit: SEC_VEHICLES,
    key: "vehicles",
    collect: ({ sim, isDelta, baseSnap, viewerCenter, interest, bubbleCx, bubbleCy }) => {
      const encodeSlotIndexById = new Map<string, number>()
      for (let i = 0; i < sim.slots.length; i++) {
        const s = sim.slots[i]!
        encodeSlotIndexById.set(s.id, s.index)
      }
      const emittedVehicles: VehicleState[] = []
      for (const v of sim.vehicles.list) {
        if (viewerCenter && !inInterestBubble(v.x, v.y, bubbleCx, bubbleCy, interest.bubbleHalfExtent + 16)) continue
        const thrQ = Math.round(clamp(v.drive.throttle, -1, 1) * 7)
        const strQ = Math.round(clamp(v.drive.steer, -1, 1) * 7)
        emittedVehicles.push({
          id: v.id,
          kind: v.kind,
          x: cm(v.x) / 100,
          y: cm(v.y) / 100,
          h: unpackAngle(packAngle(v.h)),
          vx: Math.round(clamp(v.vx, -320, 320) * 100) / 100,
          vy: Math.round(clamp(v.vy, -320, 320) * 100) / 100,
          w: Math.round(clamp(v.w, -30, 30) * 100) / 100,
          hp: Math.round(clamp(v.hp, 0, 65535)),
          fuel: Math.round(clamp(v.fuel, 0, 255)),
          hasBattery: v.hasBattery,
          hasKeys: v.hasKeys,
          headlights: v.headlights,
          engineOn: v.engineOn,
          horn: v.horn,
          wreck: v.wreck,
          handbrake: v.drive.handbrake,
          throttle: thrQ / 7,
          steer: strQ / 7,
          seats: v.seats.map((sid) => (sid ? (encodeSlotIndexById.get(sid) ?? -1) : -1)),
        })
      }
      const baseVehicles = baseSnap?.vehicles ?? []
      const hasVehicles =
        !isDelta
          ? emittedVehicles.length > 0
          : emittedVehicles.length !== baseVehicles.length ||
            emittedVehicles.some((v, i) => !sameVehicleState(v, baseVehicles[i]!))
      return {
        snapshotValue: emittedVehicles,
        shouldWrite: hasVehicles,
        writePayload: emittedVehicles,
      }
    },
    encode: (w, emittedVehicles) => {
      w.u8(emittedVehicles.length)
      for (const v of emittedVehicles) writeVehicleState(w, v)
    },
    decode: (r) => {
      const vehicles: VehicleState[] = []
      for (let n = r.u8(), i = 0; i < n; i++) vehicles.push(readVehicleState(r))
      return vehicles
    },
  },
})
