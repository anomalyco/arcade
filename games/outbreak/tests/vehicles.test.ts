import { describe, expect, test } from "bun:test"
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { LocalSession } from "../shared/session"
import { generateChunkVehicleSpawns } from "../shared/vehicles"
import { chunkKey, generateWorldChunk } from "../shared/world"
import { NetSession } from "../src/net-session"
import { Loopback } from "./loopback"

describe("Outbreak vehicles", () => {
  test("world generator places a ready-to-start vehicle near spawn and varied vehicles across districts", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const vehicles = session.view.vehicles
    expect(vehicles.length).toBeGreaterThanOrEqual(4)

    // Vehicle #1 near spawn (27.7, 41) is ready to start immediately
    const starter = vehicles.find((v) => v.id === 1)!
    expect(starter).toBeDefined()
    expect(starter.hasBattery).toBe(true)
    expect(starter.hasKeys).toBe(true)
    expect(starter.fuel).toBeGreaterThan(50)
    expect(Math.hypot(starter.x - 27.7, starter.y - 41)).toBeLessThan(6.0)

    // Other origin vehicles require battery, keys, or fuel
    expect(vehicles.some((v) => !v.hasBattery)).toBe(true)
    expect(vehicles.some((v) => !v.hasKeys)).toBe(true)
    expect(vehicles.some((v) => v.fuel === 0)).toBe(true)

    // Procedural districts across a 1 km region spawn parked vehicles (driveways, gas station, police station, streets)
    const kinds = new Set<string>()
    let proceduralCount = 0
    for (let cy = -3; cy <= 6; cy++) {
      for (let cx = 3; cx <= 14; cx++) {
        const ch = generateWorldChunk(7, 7, cx, cy, "streaming")
        const spawns = generateChunkVehicleSpawns(7, 7, cx, cy, "streaming", ch.buildings, ch.vehicles)
        for (const sp of spawns) {
          proceduralCount++
          kinds.add(sp.kind)
          // Never blocks the center East-West arterial lane y = 44 (locZ = 12 in ly = 1 chunks)
          if (ch.ly === 1) {
            const locZ = sp.y - cy * 32
            expect(Math.abs(locZ - 12)).toBeGreaterThan(2.2)
          }
        }
      }
    }
    expect(proceduralCount).toBeGreaterThan(15)
    expect(kinds.has("sedan")).toBe(true)
    expect(kinds.has("cruiser")).toBe(true)
    expect(kinds.has("pickup")).toBe(true)
  })

  test("enter/exit with E, cycle seats with C, drive with WASD/Space/H/F, and consume fuel", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const p = session.view.player
    const starter = session.vehicles.byId(1)!

    // Walk up to the starter sedan and press E
    Object.assign(p, { x: starter.x, y: starter.y + 1.35, aim: -Math.PI / 2 })
    session.rebuildCollision()
    expect(session.view.prompt?.kind).toBe("vehicle")

    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: true }, 0)
    expect(p.vehicleId).toBe(starter.id)
    expect(p.seatIndex).toBe(0)
    expect(starter.engineOn).toBe(true)
    expect(starter.seats[0]).toBe("player")

    // Drive east along the street with W (my = -1) and honk horn (horn = true)
    const startX = starter.x
    const startFuel = starter.fuel
    for (let i = 0; i < 90; i++) {
      session.update(TICK_DT, { mx: 0, my: -1, aim: 0, interact: false, horn: i < 10 }, 0)
    }
    expect(starter.x).toBeGreaterThan(startX + 6)
    expect(starter.fuel).toBeLessThan(startFuel)
    expect(session.view.noises.some((n) => n.kind === "engine")).toBe(true)
    expect(session.view.noises.some((n) => n.kind === "horn")).toBe(true)

    // Toggle headlights with F
    const lightsBefore = starter.headlights
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, flashlight: true }, 0)
    expect(starter.headlights).toBe(!lightsBefore)

    // Handbrake with Space (jump = true) brings the car to a stop
    for (let i = 0; i < 60; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, jump: true }, 0)
    }
    expect(Math.hypot(starter.vx, starter.vy)).toBeLessThan(0.5)

    // Cycle seats with C (0 -> 1)
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, seat: true }, 0)
    expect(p.seatIndex).toBe(1)
    expect(starter.seats[0]).toBe("")
    expect(starter.seats[1]).toBe("player")
    expect(starter.engineOn).toBe(false)

    // Exit vehicle with E
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: true }, 0)
    expect(p.vehicleId).toBeNull()
    expect(starter.seats.every((s) => s === "")).toBe(true)
  })

  test("vehicles needing a car battery or keys are repaired/unlocked when the survivor carries the item", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const p = session.view.player
    const pickup = session.vehicles.byId(2)!
    expect(pickup.hasBattery).toBe(false)

    // Approach without a car battery: enters seat 0, but engine cannot start
    Object.assign(p, { x: pickup.x - 1.35, y: pickup.y, aim: 0 })
    session.rebuildCollision()
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: true }, 0)
    expect(p.vehicleId).toBe(pickup.id)
    expect(pickup.engineOn).toBe(false)
    session.update(TICK_DT, { mx: 0, my: -1, aim: 0, interact: false }, 0)
    expect(pickup.engineOn).toBe(false)

    // Give the survivor a car-battery and press throttle: installs battery and starts engine!
    session.view.progression.ledger.apply({ kind: "grant", actor: session.view.actorId, item: "car-battery", count: 1 })
    expect(session.view.progression.ledger.count(session.view.actorId, "car-battery")).toBe(1)
    session.update(TICK_DT, { mx: 0, my: -1, aim: 0, interact: false }, 0)
    expect(pickup.hasBattery).toBe(true)
    expect(pickup.engineOn).toBe(true)
    expect(session.view.progression.ledger.count(session.view.actorId, "car-battery")).toBe(0)

    // Exit pickup and test Cruiser (#3) that needs keys
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: true }, 0)
    const cruiser = session.vehicles.byId(3)!
    expect(cruiser.hasKeys).toBe(false)
    session.view.progression.ledger.apply({ kind: "grant", actor: session.view.actorId, item: "key", count: 1 })
    Object.assign(p, { x: cruiser.x, y: cruiser.y - 1.35, aim: Math.PI / 2 })
    session.rebuildCollision()
    session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: true }, 0)
    expect(cruiser.hasKeys).toBe(true)
    expect(cruiser.engineOn).toBe(true)
    expect(session.view.progression.ledger.count(session.view.actorId, "key")).toBe(0)
  })

  test("running over zombies deals damage/roadkill, and zombies grab and bang on a stopped occupied car", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const p = session.view.player
    const starter = session.vehicles.byId(1)!

    // Place starter car at (26, 44) facing East (0) and enter it
    Object.assign(starter, { x: 26, y: 44, h: 0, vx: 0, vy: 0, w: 0 })
    Object.assign(p, { x: 26, y: 42.7, aim: Math.PI / 2 })
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: true }, 0)
    expect(p.vehicleId).toBe(starter.id)

    // Spawn two zombies in the driving lane ahead
    const z1 = session.ai.spawnZombie(session.view.town, 35, 44, "chase", Math.PI)
    const z2 = session.ai.spawnZombie(session.view.town, 38, 44, "chase", Math.PI)

    // Accelerate through both zombies
    for (let i = 0; i < 120; i++) {
      session.update(TICK_DT, { mx: 0, my: -1, aim: 0, interact: false }, 0)
    }
    expect(starter.zombieHits).toBeGreaterThanOrEqual(2)
    expect(starter.zombieKills).toBeGreaterThanOrEqual(1)
    expect(z1.state === "dead" || z2.state === "dead").toBe(true)

    // Now stop the car and place 3 chasing zombies right alongside the doors to test grabbing & banging
    starter.vx = 0
    starter.vy = 0
    const hpBefore = starter.hp
    const b1 = session.ai.spawnZombie(session.view.town, starter.x, starter.y - 1.15, "chase", Math.PI / 2)
    const b2 = session.ai.spawnZombie(session.view.town, starter.x, starter.y + 1.15, "chase", -Math.PI / 2)
    b1.seesTarget = true
    b2.seesTarget = true
    for (let i = 0; i < 90; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, jump: true }, 0)
    }
    expect(starter.grabbingZombies).toBeGreaterThan(0)
    expect(starter.bangCount).toBeGreaterThan(0)
    expect(starter.hp).toBeLessThan(hpBefore)
  })

  test("vehicle state persists in ChunkDelta when driven to another chunk, unloaded, and reloaded", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const p = session.view.player
    const starter = session.vehicles.byId(1)!

    // Enter starter car in chunk (0, 1) and drive it into chunk (3, 1) at (112, 44)
    Object.assign(p, { x: starter.x, y: starter.y + 1.35, aim: -Math.PI / 2 })
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: true }, 0)
    Object.assign(starter, { x: 26, y: 44, h: 0 })
    while (starter.x < 112) {
      session.update(TICK_DT, { mx: 0, my: -1, aim: 0, interact: false }, 0)
    }
    // Stop and exit in chunk (3, 1)
    starter.vx = 0
    starter.vy = 0
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: true }, 0)
    expect(p.vehicleId).toBeNull()
    const parkedX = starter.x
    const parkedY = starter.y
    const parkedFuel = starter.fuel
    expect(Math.floor(parkedX / 32)).toBe(3)
    expect(Math.floor(parkedY / 32)).toBe(1)

    // Move survivor 1,000 m east to (1150, 44) so both chunk (0, 1) and chunk (3, 1) unload
    Object.assign(p, { x: 1150, y: 44, vx: 0, vy: 0 })
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
    expect(session.world.activeChunks.has(chunkKey(0, 1))).toBe(false)
    expect(session.world.activeChunks.has(chunkKey(3, 1))).toBe(false)
    expect(session.vehicles.byId(1)).toBeUndefined()

    // Return to origin chunk (0, 1): starter car is NOT duplicated at its old spawn
    Object.assign(p, { x: 28, y: 41, vx: 0, vy: 0 })
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
    expect(session.world.activeChunks.has(chunkKey(0, 1))).toBe(true)
    expect(session.vehicles.byId(1)).toBeUndefined()

    // Walk to chunk (3, 1): starter car re-materializes right where we parked it!
    Object.assign(p, { x: 110, y: 44, vx: 0, vy: 0 })
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
    expect(session.world.activeChunks.has(chunkKey(3, 1))).toBe(true)
    const reloaded = session.vehicles.byId(1)!
    expect(reloaded).toBeDefined()
    expect(reloaded.x).toBeCloseTo(parkedX, 1)
    expect(reloaded.y).toBeCloseTo(parkedY, 1)
    expect(reloaded.fuel).toBeCloseTo(parkedFuel, 1)
  })

  test("co-op driver prediction and passenger riding work authoritatively across room snapshots", () => {
    let virtualMs = 0
    const room = new CoopRoomCore("coopveh", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, () => virtualMs, BUILD)
    const net = new Loopback(room, 2)

    const driverClient = new NetSession({
      url: "loop",
      room: "coopveh",
      name: "Driver",
      now: () => net.now,
      WebSocket: net.socketClass(),
    })
    const passengerClient = new NetSession({
      url: "loop",
      room: "coopveh",
      name: "Passenger",
      now: () => net.now,
      WebSocket: net.socketClass(),
    })

    for (let i = 0; i < 10; i++) {
      virtualMs = net.now * 1000
      net.step()
      driverClient.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false })
      passengerClient.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false })
      driverClient.sync(TICK_DT)
      passengerClient.sync(TICK_DT)
    }

    const srvCar = room.sim.vehicles.byId(1)!
    Object.assign(srvCar, { x: 26, y: 44, h: 0 })
    const slotDriver = room.sim.slot(driverClient.id)!
    const slotPass = room.sim.slot(passengerClient.id)!
    Object.assign(slotDriver.survivor, { x: 26, y: 42.7 })
    Object.assign(slotPass.survivor, { x: 26, y: 45.3 })
    Object.assign(driverClient.view.player, { x: 26, y: 42.7 })
    Object.assign(passengerClient.view.player, { x: 26, y: 45.3 })

    // Driver enters seat 0, then Passenger enters seat 1
    for (let i = 0; i < 12; i++) {
      virtualMs = net.now * 1000
      net.step()
      driverClient.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: i === 0 })
      passengerClient.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: i === 3 })
      driverClient.sync(TICK_DT)
      passengerClient.sync(TICK_DT)
    }

    expect(slotDriver.survivor.vehicleId).toBe(1)
    expect(slotDriver.survivor.seatIndex).toBe(0)
    expect(slotPass.survivor.vehicleId).toBe(1)
    expect(slotPass.survivor.seatIndex).toBeGreaterThan(0)

    // Spawn a zombie ahead and drive forward for 90 ticks, then brake to a stop and let snapshots settle
    const targetZombie = room.sim.ai.spawnZombie(room.sim.town, 42, 42.5, "wander", Math.PI)
    for (let i = 0; i < 160; i++) {
      virtualMs = net.now * 1000
      net.step()
      const driving = i < 90
      driverClient.update(TICK_DT, { mx: 0, my: driving ? -1 : 0, aim: 0, interact: false, sprint: !driving })
      const aimToZombie = Math.atan2(targetZombie.y - passengerClient.view.player.y, targetZombie.x - passengerClient.view.player.x)
      passengerClient.update(TICK_DT, { mx: 0, my: 0, aim: aimToZombie, interact: false, fire: i === 30 })
      driverClient.sync(TICK_DT)
      passengerClient.sync(TICK_DT)
    }

    // Vehicle moved > 12 m east, driver prediction converged with server, and passenger rode along & fired
    expect(srvCar.x).toBeGreaterThan(38)
    const predCar = driverClient.vehicles.byId(1)!
    expect(Math.hypot(predCar.x - srvCar.x, predCar.y - srvCar.y)).toBeLessThan(0.08)
    expect(Math.hypot(driverClient.view.player.x - slotDriver.survivor.x, driverClient.view.player.y - slotDriver.survivor.y)).toBeLessThan(0.08)
    expect(passengerClient.view.player.x).toBeGreaterThan(36)
    expect(slotPass.survivor.magAmmo).toBe(5)

    driverClient.close()
    passengerClient.close()
  })
})
