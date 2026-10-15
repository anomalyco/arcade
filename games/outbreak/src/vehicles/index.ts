import { lerp, lerpAngle } from "@arcade/kit/net/interpolate"
import type { VehicleState } from "../../shared/net-protocol"
import { supportHeight } from "../../shared/terrain"
import {
  createVehicleFromSpawn,
  DEFAULT_VEHICLE_TUNING,
  outbreakVehiclesSharedFeature,
  seatPos,
  VEHICLES,
} from "../../shared/vehicles/index"
import { chunkKey, worldToChunk } from "../../shared/world"
import { registerOutbreakClientFeature } from "../feature-registry"
import type { OutbreakFeelTracker } from "../feel-events"
import type { NetSession } from "../net-session"
import {
  stageVehicleScene,
  VEHICLE_SCENES,
  vehicleLabControls,
  type VehicleLabHost,
  type VehicleScene,
} from "../vehicle-lab"

export {
  outbreakVehiclesSharedFeature,
  stageVehicleScene,
  VEHICLE_SCENES,
  vehicleLabControls,
  type VehicleLabHost,
  type VehicleScene,
}
export * from "../vehicles"

const processedVehicleHitsByTracker = new WeakMap<OutbreakFeelTracker, Set<string>>()
const netVehicleTablesBySession = new WeakMap<
  NetSession,
  { prevVehicles: Map<number, VehicleState>; slotIdByIndex: Map<number, string> }
>()

function getProcessedHits(tracker: OutbreakFeelTracker): Set<string> {
  let set = processedVehicleHitsByTracker.get(tracker)
  if (!set) {
    set = new Set<string>()
    processedVehicleHitsByTracker.set(tracker, set)
  }
  return set
}

function getNetTables(net: NetSession) {
  let tables = netVehicleTablesBySession.get(net)
  if (!tables) {
    tables = {
      prevVehicles: new Map<number, VehicleState>(),
      slotIdByIndex: new Map<number, string>(),
    }
    netVehicleTablesBySession.set(net, tables)
  }
  return tables
}

export const outbreakVehiclesFeature = registerOutbreakClientFeature({
  id: "vehicles",
  order: 25,
  settingsGroup: {
    subsystem: "vehicle",
    defaults: DEFAULT_VEHICLE_TUNING,
  },
  labControls: (host) => (host.vehicleHost ? vehicleLabControls(host.vehicleHost) : []),
  gameCommands: (host) => [
    {
      id: "vehicle.stage",
      label: "Stage a Vehicle Scene",
      shortLabel: "Vehicle Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${VEHICLE_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "driveway") as VehicleScene
        if (!VEHICLE_SCENES.includes(scene)) throw new Error(`Unknown vehicle scene ${scene}`)
        stageVehicleScene(host.vehicleHost, scene)
        return { scene }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a vehicle scene (`vehicle.stage`): driveway, night-headlights, need-battery, need-keys, police-cruiser, horde-runover. */
    stageVehicle(scene: VehicleScene) {
      stageVehicleScene(host.vehicleHost, scene)
    },
  }),
  harnessState: (host) => ({
    vehicles: host.session().view.vehicles.map((v) => ({
      id: v.id,
      kind: v.kind,
      label: v.spec.label,
      x: v.x,
      y: v.y,
      h: v.h,
      vx: v.vx,
      vy: v.vy,
      speed: Math.hypot(v.vx, v.vy),
      hp: v.hp,
      maxHp: v.maxHp,
      fuel: v.fuel,
      maxFuel: v.maxFuel,
      hasBattery: v.hasBattery,
      hasKeys: v.hasKeys,
      headlights: v.headlights,
      engineOn: v.engineOn,
      horn: v.horn,
      wreck: v.wreck,
      seats: [...v.seats],
      zombieHits: v.zombieHits,
      zombieKills: v.zombieKills,
      grabbingZombies: v.grabbingZombies,
      bangCount: v.bangCount,
    })),
  }),
  feel: {
    reset: (tracker) => {
      getProcessedHits(tracker).clear()
    },
    processFrame: ({ tracker, session, combatFx, addCount, settings, cam }) => {
      const { player: p, town } = session.view
      const processed = getProcessedHits(tracker)
      combatFx.legacyMode = settings.combat.bloodStyle === 2
      for (const hit of session.sim.vehicles.recentHits) {
        const hitKey = `${hit.vehicleId}:${hit.zombieId}:${hit.time.toFixed(3)}`
        if (processed.has(hitKey)) continue
        processed.add(hitKey)
        if (processed.size > 128) {
          processed.delete(processed.keys().next().value!)
        }
        if (settings.combat.bloodStyle !== 0) {
          combatFx.emitShoveHit(
            hit.x,
            hit.y,
            Math.atan2(hit.dirY, hit.dirX),
            supportHeight(town, hit.x, hit.y),
            hit.killed ? 3 : 1,
            Math.floor(hit.time * 1000) + hit.zombieId,
          )
        }
        if (hit.vehicleId === p.vehicleId) {
          const pwr = Math.min(1.4, 0.65 + hit.speed * 0.08)
          const dir = Math.atan2(hit.dirY, hit.dirX)
          cam.add((hit.killed ? 0.24 : 0.14) * pwr, dir, (hit.killed ? 0.9 : 0.5) * pwr)
          if (hit.killed) {
            cam.punch(-0.16 * pwr, 0)
          }
        }
      }
      return addCount
    },
  },
  netSession: {
    onApplyWorld: (net, s) => {
      const netVehicles = s.vehicles
      if (!netVehicles) return
      const sim = net.sim
      const { slotIdByIndex } = getNetTables(net)
      slotIdByIndex.clear()
      for (let i = 0; i < sim.slots.length; i++) {
        const sl = sim.slots[i]!
        slotIdByIndex.set(sl.index, sl.id)
      }
      const localDrivenId =
        net.local.survivor.vehicleId && (net.local.survivor.seatIndex ?? 0) === 0
          ? net.local.survivor.vehicleId
          : null
      for (const sv of netVehicles) {
        let lv = sim.vehicles.byId(sv.id)
        if (!lv) {
          const coord = worldToChunk(sv.x, sv.y)
          lv = createVehicleFromSpawn({
            id: sv.id,
            kind: sv.kind,
            originChunkKey: chunkKey(coord.cx, coord.cy),
            x: sv.x,
            y: sv.y,
            h: sv.h,
            fuel: sv.fuel,
            hasBattery: sv.hasBattery,
            hasKeys: sv.hasKeys,
            headlights: sv.headlights,
          })
          sim.vehicles.list.push(lv)
        }
        lv.kind = sv.kind
        lv.spec = VEHICLES[sv.kind]
        lv.hp = sv.hp
        lv.fuel = sv.fuel
        lv.hasBattery = sv.hasBattery
        lv.hasKeys = sv.hasKeys
        lv.headlights = sv.headlights
        lv.engineOn = sv.engineOn
        lv.horn = sv.horn
        lv.wreck = sv.wreck
        lv.seats = sv.seats.map((idx) => (idx >= 0 ? (slotIdByIndex.get(idx) ?? `remote${idx}`) : ""))
        if (lv.id !== localDrivenId) {
          lv.x = sv.x
          lv.y = sv.y
          lv.h = sv.h
          lv.vx = sv.vx
          lv.vy = sv.vy
          lv.w = sv.w
          lv.drive = { throttle: sv.throttle, steer: sv.steer, handbrake: sv.handbrake }
        }
      }
    },
    onReconcileLocal: (net, _personal, shared) => {
      const p = net.local.survivor
      if (!p.vehicleId) return
      const sv = shared.vehicles?.find((x) => x.id === p.vehicleId)
      const lv = net.sim.vehicles.byId(p.vehicleId)
      if (sv && lv) {
        lv.x = sv.x
        lv.y = sv.y
        lv.h = sv.h
        lv.vx = sv.vx
        lv.vy = sv.vy
        lv.w = sv.w
        lv.hp = sv.hp
        lv.fuel = sv.fuel
        lv.hasBattery = sv.hasBattery
        lv.hasKeys = sv.hasKeys
        lv.headlights = sv.headlights
        lv.engineOn = sv.engineOn
        lv.horn = sv.horn
        lv.wreck = sv.wreck
        lv.drive = { throttle: sv.throttle, steer: sv.steer, handbrake: sv.handbrake }
        lv.seats[p.seatIndex ?? 0] = net.local.id
      }
    },
    onSyncFrame: (net, a, b, t, span) => {
      if (!b.vehicles) return
      const { prevVehicles: prev } = getNetTables(net)
      prev.clear()
      const aVehicles = a.vehicles
      if (aVehicles) {
        for (let i = 0; i < aVehicles.length; i++) {
          const v = aVehicles[i]!
          prev.set(v.id, v)
        }
      }
      const localDrivenId =
        net.local.survivor.vehicleId && (net.local.survivor.seatIndex ?? 0) === 0
          ? net.local.survivor.vehicleId
          : null
      for (const vb of b.vehicles) {
        const lv = net.sim.vehicles.byId(vb.id)
        if (!lv || lv.id === localDrivenId) continue
        const va = prev.get(vb.id) ?? vb
        const teleport = Math.hypot(vb.x - va.x, vb.y - va.y) > 8
        lv.x = teleport ? vb.x : lerp(va.x, vb.x, t)
        lv.y = teleport ? vb.y : lerp(va.y, vb.y, t)
        lv.h = lerpAngle(va.h, vb.h, t)
        lv.vx = teleport ? vb.vx : (vb.x - va.x) / span
        lv.vy = teleport ? vb.vy : (vb.y - va.y) / span
        for (let s = 0; s < lv.seats.length; s++) {
          const sid = lv.seats[s]!
          if (!sid) continue
          const slot = net.sim.slots.find((sl) => sl.id === sid)
          if (slot && (slot !== net.local || s > 0)) {
            const sp = seatPos(lv, lv.spec, s)
            slot.survivor.x = sp.x
            slot.survivor.y = sp.y
            slot.survivor.vx = lv.vx
            slot.survivor.vy = lv.vy
            slot.survivor.vehicleId = lv.id
            slot.survivor.seatIndex = s
          }
        }
      }
    },
  },
})
