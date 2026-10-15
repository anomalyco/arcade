import type { LabControl } from "@arcade/kit/lab-panel"
import type { CoopSim } from "../shared/coop-sim"
import type { SessionView } from "../shared/session"
import { vehicleControls, VEHICLES, type VehicleKind } from "../shared/vehicles"

export const VEHICLE_SCENES = [
  "driveway",
  "night-headlights",
  "need-battery",
  "need-keys",
  "horde-runover",
  "police-cruiser",
] as const

export type VehicleScene = (typeof VEHICLE_SCENES)[number]

export type VehicleLabHost = {
  sim: () => CoopSim
  view: () => SessionView
  pose: (x: number, y: number, aim: number) => void
  setHour: (hour: number) => void
  offline: () => boolean
}

function giveParts(view: SessionView): void {
  const l = view.progression.ledger
  l.apply({ kind: "grant", actor: view.actorId, item: "car-battery", count: 1 })
  l.apply({ kind: "grant", actor: view.actorId, item: "key", count: 2 })
  l.apply({ kind: "grant", actor: view.actorId, item: "chem", count: 4 })
}

export function stageVehicleScene(host: VehicleLabHost, scene: VehicleScene): void {
  const sim = host.sim()
  const view = host.view()
  const slot = sim.slot(view.actorId)
  if (slot) sim.vehicles.leaveSeat(slot.id, slot.survivor)

  // Clear nearby zombies around the staged spot first
  const clearNear = (cx: number, cy: number, r = 18) => {
    for (const z of sim.ai.agents) {
      if (Math.hypot(z.x - cx, z.y - cy) < r) {
        z.x = 6
        z.y = 6
        z.state = "wander"
      }
    }
  }

  switch (scene) {
    case "driveway": {
      host.setHour(18.0)
      clearNear(23, 41)
      const v = sim.vehicles.byId(1) ?? sim.vehicles.spawnVehicle("sedan", 22.8, 41.2, 0)
      Object.assign(v, { x: 22.8, y: 41.2, h: 0, vx: 0, vy: 0, w: 0, fuel: 85, hasBattery: true, hasKeys: true, headlights: true, wreck: false, hp: v.maxHp })
      host.pose(25.2, 41.2, Math.PI)
      return
    }
    case "night-headlights": {
      host.setHour(23.0)
      clearNear(30, 44, 24)
      const v = sim.vehicles.byId(1) ?? sim.vehicles.spawnVehicle("sedan", 28.0, 44.0, 0)
      Object.assign(v, { x: 28.0, y: 44.0, h: 0, vx: 0, vy: 0, w: 0, fuel: 90, hasBattery: true, hasKeys: true, headlights: true, wreck: false, hp: v.maxHp })
      if (slot) sim.vehicles.enter(slot, v, sim.progression, sim.ai, sim.time)
      sim.ai.spawnZombie(sim.town, 37.5, 43.6, "chase", Math.PI)
      sim.ai.spawnZombie(sim.town, 39.2, 44.6, "chase", Math.PI)
      return
    }
    case "need-battery": {
      host.setHour(17.5)
      clearNear(50, 31)
      giveParts(view)
      const v = sim.vehicles.byId(2) ?? sim.vehicles.spawnVehicle("pickup", 50.6, 30.5, Math.PI / 2, { hasBattery: false })
      Object.assign(v, { x: 50.6, y: 30.5, h: Math.PI / 2, vx: 0, vy: 0, w: 0, fuel: 85, hasBattery: false, hasKeys: true, wreck: false, hp: v.maxHp })
      host.pose(49.2, 30.5, 0)
      return
    }
    case "need-keys": {
      host.setHour(18.2)
      clearNear(62, 51)
      giveParts(view)
      const v = sim.vehicles.byId(3) ?? sim.vehicles.spawnVehicle("cruiser", 62.0, 51.2, Math.PI, { hasKeys: false })
      Object.assign(v, { x: 62.0, y: 51.2, h: Math.PI, vx: 0, vy: 0, w: 0, fuel: 75, hasBattery: true, hasKeys: false, wreck: false, hp: v.maxHp })
      host.pose(62.0, 49.6, Math.PI / 2)
      return
    }
    case "police-cruiser": {
      host.setHour(21.5)
      clearNear(44, 44, 20)
      const v = sim.vehicles.byId(3) ?? sim.vehicles.spawnVehicle("cruiser", 40.0, 44.0, 0)
      Object.assign(v, { x: 40.0, y: 44.0, h: 0, vx: 0, vy: 0, w: 0, fuel: 100, hasBattery: true, hasKeys: true, headlights: true, wreck: false, hp: v.maxHp })
      if (slot) sim.vehicles.enter(slot, v, sim.progression, sim.ai, sim.time)
      return
    }
    case "horde-runover": {
      host.setHour(20.0)
      clearNear(36, 44, 24)
      const v = sim.vehicles.byId(1) ?? sim.vehicles.spawnVehicle("pickup", 26.0, 44.0, 0)
      Object.assign(v, {
        kind: "pickup",
        spec: VEHICLES.pickup,
        x: 26.0,
        y: 44.0,
        h: 0,
        vx: 0,
        vy: 0,
        w: 0,
        fuel: 100,
        hasBattery: true,
        hasKeys: true,
        headlights: true,
        wreck: false,
        hp: VEHICLES.pickup.hp,
        maxHp: VEHICLES.pickup.hp,
      })
      if (slot) sim.vehicles.enter(slot, v, sim.progression, sim.ai, sim.time)
      for (const [zx, zy] of [
        [34.5, 43.8],
        [36.0, 44.3],
        [37.8, 43.6],
        [39.5, 44.2],
      ] as const) {
        sim.ai.spawnZombie(sim.town, zx, zy, "chase", Math.PI)
      }
      return
    }
  }
}

export function vehicleLabControls(host: VehicleLabHost): LabControl[] {
  const action = (key: string, label: string, run: () => void): LabControl => ({
    key,
    label,
    group: "Vehicle",
    type: "action",
    run,
  })
  return [
    ...vehicleControls.map((c) => ({ ...c })),
    action("vehicleSpawnStarter", "Spawn working car ahead", () => {
      if (!host.offline()) return
      const sim = host.sim()
      const p = host.view().player
      const kinds: readonly VehicleKind[] = ["sedan", "cruiser", "pickup", "van"]
      const kind = kinds[sim.vehicles.list.length % kinds.length]!
      sim.vehicles.spawnVehicle(kind, p.x + Math.cos(p.aim) * 4.2, p.y + Math.sin(p.aim) * 4.2, p.aim)
    }),
    action("vehicleRefuelRepair", "Refuel & repair vehicle", () => {
      if (!host.offline()) return
      const sim = host.sim()
      const p = host.view().player
      const v = sim.vehicles.vehicleOf(p) ?? sim.vehicles.enterable(p.x, p.y) ?? sim.vehicles.list[0]
      if (!v) return
      v.hp = VEHICLES[v.kind].hp
      v.fuel = VEHICLES[v.kind].maxFuel
      v.hasBattery = true
      v.hasKeys = true
      v.wreck = false
    }),
    action("vehicleGiveParts", "Give car battery, keys & fuel", () => {
      if (!host.offline()) return
      giveParts(host.view())
      const slot = host.sim().slot(host.view().actorId)
      if (slot) host.sim().progression.project(slot)
    }),
    action("vehicleStageHorde", "Stage roadkill & horde test", () => {
      if (!host.offline()) return
      stageVehicleScene(host, "horde-runover")
    }),
  ]
}
