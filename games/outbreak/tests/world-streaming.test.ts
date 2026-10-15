import { describe, expect, test } from "bun:test"
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { makeTown, SIZE } from "../shared/map"
import { LocalSession } from "../shared/session"
import { supportHeight, terrainVertex } from "../shared/terrain"
import {
  chunkKey,
  districtAtBlock,
  generateWorldChunk,
  type BuildingArchetype,
  type DistrictKind,
} from "../shared/world"
import { NetSession } from "../src/net-session"
import { WorldClientStreamer, compileSingleWorldChunk, ensurePropTemplates, recycleCompiledChunk } from "../src/world-streamer"
import { Loopback } from "./loopback"

describe("Procedural world generation & chunk streaming", () => {
  test("per-chunk generation is 100% deterministic from (seed, houseSeed, cx, cy) regardless of order", () => {
    const coords = [
      [0, 0],
      [1, 1],
      [3, 1],
      [-2, 4],
      [12, -7],
      [32, 0],
    ] as const

    const forward = coords.map(([cx, cy]) => generateWorldChunk(7, 7, cx, cy, "streaming"))
    const reverse = [...coords].reverse().map(([cx, cy]) => generateWorldChunk(7, 7, cx, cy, "streaming")).reverse()

    for (let i = 0; i < coords.length; i++) {
      expect(forward[i]!.hash).toBe(reverse[i]!.hash)
      expect(forward[i]).toEqual(reverse[i])
    }

    // Different seeds or coordinates produce different chunk hashes
    const cA = generateWorldChunk(7, 7, 4, 1, "streaming")
    const cB = generateWorldChunk(8, 8, 4, 1, "streaming")
    const cC = generateWorldChunk(7, 7, 5, 1, "streaming")
    expect(cA.hash).not.toBe(cB.hash)
    expect(cA.hash).not.toBe(cC.hash)
  })

  test("generates all 5 district types and 8+ building/POI archetypes across a 1.2 km region", () => {
    const districts = new Set<DistrictKind>()
    const archetypes = new Set<BuildingArchetype | string>()
    let totalBuildings = 0
    let totalContainers = 0

    for (let cy = -6; cy <= 12; cy++) {
      for (let cx = -6; cx <= 12; cx++) {
        const ch = generateWorldChunk(7, 7, cx, cy, "streaming")
        districts.add(ch.district)
        for (const b of ch.buildings) {
          totalBuildings++
          archetypes.add(b.archetype ?? b.kind)
          const isClassicOrigin = cx >= 0 && cx < 3 && cy >= 0 && cy < 3
          if (!isClassicOrigin) {
            // Every procedural building stays strictly inside its 32×32 m chunk bounds
            expect(b.rect[0]).toBeGreaterThanOrEqual(ch.bounds[0])
            expect(b.rect[2]).toBeLessThanOrEqual(ch.bounds[2])
            expect(b.rect[1]).toBeGreaterThanOrEqual(ch.bounds[1])
            expect(b.rect[3]).toBeLessThanOrEqual(ch.bounds[3])
          }
        }
        totalContainers += ch.containers.length
      }
    }

    expect(districts).toEqual(new Set(["suburb", "commercial", "civic", "industrial", "woodland"]))
    expect(archetypes.size).toBeGreaterThanOrEqual(9)
    expect(archetypes.has("house")).toBe(true)
    expect(archetypes.has("hardware")).toBe(true)
    expect(archetypes.has("pharmacy")).toBe(true)
    expect(archetypes.has("police")).toBe(true)
    expect(archetypes.has("clinic")).toBe(true)
    expect(archetypes.has("warehouse")).toBe(true)
    expect(totalBuildings).toBeGreaterThan(100)
    expect(totalContainers).toBeGreaterThan(200)
    expect(districtAtBlock(7, 1, 0)).toBe("commercial")
    expect(districtAtBlock(7, 2, 0)).toBe("civic")
    expect(districtAtBlock(7, 3, 0)).toBe("industrial")
    expect(districtAtBlock(7, 4, 0)).toBe("woodland")
  })

  test("road network and terrain height remain continuous across chunk borders over 1+ km", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const town = session.view.town

    // Walk along the east-west arterial road (y = 44) across 1,100 m (from x = 30 to x = 1130)
    for (let x = 30; x <= 1130; x += 25) {
      session.view.player.x = x
      session.view.player.y = 44
      session.rebuildCollision()
      // Arterial road surface at y = 44 is always flat asphalt (0.014 m)
      expect(supportHeight(town, x, 44)).toBeCloseTo(0.014, 5)
      // Sidewalks at y = 39 (outside N-S road intersections lx in 38..50) are elevated curb height (0.10 m)
      const lx = ((x % 96) + 96) % 96
      if (lx < 37 || lx > 51) {
        expect(supportHeight(town, x, 39)).toBeGreaterThanOrEqual(0.08)
      }
    }

    // Check terrain vertex continuity at chunk boundary x = 128, 160, 192
    for (const borderX of [96, 128, 160, 192]) {
      session.view.player.x = borderX
      session.view.player.y = 44
      session.rebuildCollision()
      for (let z = 4; z <= 88; z += 12) {
        const hLeft = terrainVertex(town, borderX, z)
        const hRight = terrainVertex(town, borderX, z)
        expect(hLeft).toBe(hRight)
      }
    }
  })

  test("chunk deltas (doors, barricades, containers, dead zombies) persist across chunk unload and reload", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const p = session.view.player

    // Move survivor to procedural chunk (3, 0) in Commercial block (bx=1, by=0 -> x in 96..128, y in 0..32)
    Object.assign(p, { x: 108, y: 28, vx: 0, vy: 0 })
    session.rebuildCollision()
    expect(session.world.activeChunks.has(chunkKey(3, 0))).toBe(true)

    const targetChunk = session.world.activeChunks.get(chunkKey(3, 0))!
    expect(targetChunk.doors.length).toBeGreaterThan(0)
    const doorId = targetChunk.doors[0]!.id
    const winId = targetChunk.windows[0]!.id
    const containerId = targetChunk.containers[0]!.id

    // Modify door (open & lock), window (open + 2 barricade planks), container (searched), and kill a zombie in chunk (3, 0)
    const liveDoor = session.view.town.doors.find((d) => d.id === doorId)!
    liveDoor.open = true
    liveDoor.locked = true

    const liveWin = session.view.town.windows.find((w) => w.id === winId)!
    liveWin.open = true
    session.ai.addBarricadePlank(winId)
    session.ai.addBarricadePlank(winId)

    const liveContainer = session.view.containers.find((c) => c.id === containerId)!
    liveContainer.searched = true

    const killedZombie = session.ai.spawnZombie(session.view.town, 110, 26, "chase")
    killedZombie.hp = 0
    killedZombie.state = "dead"
    killedZombie.detachedLimbs = ["left.upperArm"]
    const killedId = killedZombie.id

    // Now move survivor 1,100 m away to (1220, 44) so chunk (3, 0) unloads completely
    Object.assign(p, { x: 1220, y: 44, vx: 0, vy: 0 })
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
    expect(session.world.activeChunks.has(chunkKey(3, 0))).toBe(false)
    expect(session.view.town.doors.some((d) => d.id === doorId)).toBe(false)
    expect(session.view.zombies.some((z) => z.id === killedId)).toBe(false)

    // Walk back to (108, 28) so chunk (3, 0) reloads from deterministic generator + ChunkDelta
    Object.assign(p, { x: 108, y: 28, vx: 0, vy: 0 })
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
    expect(session.world.activeChunks.has(chunkKey(3, 0))).toBe(true)

    const reloadedDoor = session.view.town.doors.find((d) => d.id === doorId)!
    expect(reloadedDoor.open).toBe(true)
    expect(reloadedDoor.locked).toBe(true)

    const reloadedWin = session.view.town.windows.find((w) => w.id === winId)!
    expect(reloadedWin.open).toBe(true)
    expect(session.ai.getBarricadePlanks(winId)).toBe(2)

    const reloadedContainer = session.view.containers.find((c) => c.id === containerId)!
    expect(reloadedContainer.searched).toBe(true)

    const reloadedZombie = session.view.zombies.find((z) => z.id === killedId)!
    expect(reloadedZombie).toBeDefined()
    expect(reloadedZombie.state).toBe("dead")
    expect(reloadedZombie.detachedLimbs).toEqual(["left.upperArm"])
  })

  test("per-chunk GridNav tiles allow zombies to pathfind and chase seamlessly across chunk borders", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const p = session.view.player
    // Place survivor at x = 134, y = 44 (chunk 4, 1) and zombie across two chunk borders at x = 90, y = 44 (chunk 2, 1)
    Object.assign(p, { x: 134, y: 44, vx: 0, vy: 0, aim: Math.PI })
    session.rebuildCollision()

    const z = session.ai.spawnZombie(session.view.town, 90, 44, "chase", 0)
    z.targetX = p.x
    z.targetY = p.y

    const path = session.ai.nav.path({ x: 90, y: 44 }, { x: 134, y: 44 })
    expect(path).not.toBeNull()
    expect(path!.length).toBeGreaterThan(0)

    for (let i = 0; i < 180; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI, interact: false }, 0)
    }
    // Zombie crossed chunk border x = 96 and x = 128 toward the survivor
    expect(z.x).toBeGreaterThan(96.5)
  })

  test("co-op works across a wide map with two clients 1,200 m apart without i16 coordinate overflow", () => {
    let virtualMs = 0
    const core = new CoopRoomCore("wide", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, () => virtualMs, BUILD)
    const net = new Loopback(core, 2)

    const clientA = new NetSession({
      url: "loop",
      room: "wide",
      name: "Alice",
      now: () => net.now,
      WebSocket: net.socketClass(),
    })
    const clientB = new NetSession({
      url: "loop",
      room: "wide",
      name: "Bob",
      now: () => net.now,
      WebSocket: net.socketClass(),
    })

    for (let i = 0; i < 10; i++) {
      virtualMs = net.now * 1000
      net.step()
      clientA.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false })
      clientB.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false })
      clientA.sync(TICK_DT)
      clientB.sync(TICK_DT)
    }

    expect(clientA.connected).toBe(true)
    expect(clientB.connected).toBe(true)

    // Place Alice at (30, 41) in chunk (0, 1) and Bob 1,200 m east at (1230, 44) in chunk (38, 1)
    const slotA = core.sim.slot(clientA.id)!
    const slotB = core.sim.slot(clientB.id)!
    Object.assign(slotA.survivor, { x: 30, y: 41 })
    Object.assign(slotB.survivor, { x: 1230, y: 44 })
    Object.assign(clientA.view.player, { x: 30, y: 41 })
    Object.assign(clientB.view.player, { x: 1230, y: 44 })
    core.sim.syncWorldChunks()

    // Both Alice's 3×3 chunks (around 0,1) and Bob's 3×3 chunks (around 38,1) are active simultaneously on the room
    expect(core.sim.worldStream.activeChunks.has(chunkKey(0, 1))).toBe(true)
    expect(core.sim.worldStream.activeChunks.has(chunkKey(38, 1))).toBe(true)
    expect(core.sim.worldStream.activeChunks.size).toBe(18)

    for (let i = 0; i < 80; i++) {
      virtualMs = net.now * 1000
      net.step()
      const moving = i < 60
      clientA.update(TICK_DT, { mx: moving ? 1 : 0, my: 0, aim: 0, interact: false, sprint: moving })
      clientB.update(TICK_DT, { mx: moving ? 1 : 0, my: 0, aim: 0, interact: false, sprint: moving })
      clientA.sync(TICK_DT)
      clientB.sync(TICK_DT)
    }

    // Both clients accurately predict and reconcile their own positions > 1,200 m apart
    expect(Math.hypot(clientA.view.player.x - slotA.survivor.x, clientA.view.player.y - slotA.survivor.y)).toBeLessThan(0.05)
    expect(Math.hypot(clientB.view.player.x - slotB.survivor.x, clientB.view.player.y - slotB.survivor.y)).toBeLessThan(0.05)
    expect(clientB.view.player.x).toBeGreaterThan(1235)
    // Alice sees Bob's remote survivor at > 1,234 m (no i16 wrap at 327.67 m!)
    const remoteBobOnA = clientA.remotes.find((r) => r.index === clientB.index)!
    expect(remoteBobOnA.survivor.x).toBeGreaterThan(1234)

    clientA.close()
    clientB.close()
  })

  test("Classic 96 m mode reproduces makeTown(7) identically and clamps to 96 m bounds", () => {
    const classic = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "classic")
    const ref = makeTown(7, 7, 0.22)
    expect(classic.view.town.buildings).toEqual(ref.buildings)
    expect(classic.view.town.doors).toEqual(ref.doors)
    expect(classic.view.town.windows).toEqual(ref.windows)

    Object.assign(classic.view.player, { x: 95.5, y: 44 })
    for (let i = 0; i < 30; i++) {
      classic.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: true }, 0)
    }
    expect(classic.view.player.x).toBeLessThanOrEqual(SIZE - 0.4)
  })

  test("WorldClientStreamer directional pre-warming, buffer pooling, and sparse ChunkDeltas prevent churn", () => {
    ensurePropTemplates()
    const wc = generateWorldChunk(7, 7, 4, 1, "streaming")
    const c1 = compileSingleWorldChunk(wc, 7, 7, 0.22, 1)
    const bufRef = c1.staticOpaqueChunks[0]!.data
    const floorRef = c1.floorTile
    expect(c1.staticOpaqueChunks[0]!.byteLength).toBeGreaterThan(0)
    expect(c1.staticOpaqueChunks[0]!.byteLength).toBeLessThanOrEqual(bufRef.byteLength)

    // Recycling returns tile and vertex ArrayBuffers to the pool for reuse on the next compilation
    recycleCompiledChunk(c1)
    const c2 = compileSingleWorldChunk(wc, 7, 7, 0.22, 1)
    expect(c2.floorTile).toBe(floorRef)
    expect(c2.staticOpaqueChunks[0]!.data).toBe(bufRef)
    recycleCompiledChunk(c2)

    // Walking across unmodified chunks keeps deltas sparse (0 bytes for unmodified chunks)
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const streamer = new WorldClientStreamer()
    for (let step = 0; step <= 60; step++) {
      const x = 28 + step * 4.8
      session.view.player.x = x
      session.view.player.y = 44
      session.rebuildCollision()
      streamer.updateWindow(x, 44, session.view.town, "streaming")
    }
    expect(session.world.deltas.size).toBe(0)
    expect(streamer.cachedChunkCount).toBeLessThanOrEqual(48)
  })

  test("entering a building in streamed chunks at positive and negative offsets hides its roof (shingles & chimney) and keeps neighbours' roofs visible", () => {
    const streamer = new WorldClientStreamer()
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")

    // Add a simulated co-op remote survivor in another macro-block to ensure multi-survivor building lists never break local cutaway
    const remoteSlot = session.sim.addSurvivor("remote-peer", 1)
    Object.assign(remoteSlot.survivor, { x: -160, y: -120 })

    const testChunkOffsets = [
      [3, 0],
      [4, -1],
      [8, 2],
      [-1, -1],
      [-3, -2],
      [-5, -3],
      [10, -3],
    ] as const

    const isRoofChunkHidden = (c: { cutBox?: readonly number[]; customCutaway?: boolean | "outside" | "a2c" | "fade" }, px: number, py: number, peeking = false) => {
      if (c.customCutaway !== "outside" || peeking) return false
      const box = c.cutBox
      if (!box) return true
      return px > box[0]! && px < box[3]! && py > box[2]! && py < box[5]!
    }

    for (const [cx, cy] of testChunkOffsets) {
      const wChunk = generateWorldChunk(7, 7, cx, cy, "streaming")
      expect(wChunk.buildings.length).toBeGreaterThan(0)
      const targetBld = wChunk.buildings[0]!
      const compiled = compileSingleWorldChunk(wChunk, 7, 7, 0.22, 1)

      // 1. Verify roof chunk exists for the building and contains both shingles and high rooftop geometry (e.g. chimney)
      expect(compiled.roofChunks?.length).toBe(wChunk.buildings.length)
      // Verify no roof or high chimney vertices (> 2.81m inside building footprint) leaked into staticOpaqueChunks
      const staticBuf = compiled.staticOpaqueChunks[0]!.data
      const staticBytes = compiled.staticOpaqueChunks[0]!.byteLength ?? staticBuf.byteLength
      const staticF32 = new Float32Array(staticBuf, 0, staticBytes / 4)
      for (let v = 0; v < staticBytes / 24; v++) {
        const vx = staticF32[v * 6]!
        const vy = staticF32[v * 6 + 1]!
        const vz = staticF32[v * 6 + 2]!
        if (vx > targetBld.rect[0] && vx < targetBld.rect[2] && vz > targetBld.rect[1] && vz < targetBld.rect[3]) {
          expect(vy).toBeLessThanOrEqual(2.81)
        }
      }

      // 2. Place player inside the building and update the 5×5 streaming window
      const insideX = (targetBld.rect[0] + targetBld.rect[2]) * 0.5
      const insideY = (targetBld.rect[1] + targetBld.rect[3]) * 0.5
      Object.assign(session.view.player, { x: insideX, y: insideY })
      session.sim.syncWorldChunks()

      const viewRect: [number, number, number, number] = [insideX - 36, insideY - 22, insideX + 36, insideY + 22]
      const res = streamer.updateWindow(insideX, insideY, session.view.town, "streaming", viewRect, 0, 0, 1.0)
      expect(res.changed).toBe(true)
      expect(res.level).toBeDefined()

      // Building the player is inside must be in windowBuildings (OL.bldRects[0..7])
      expect(res.buildings.some((b) => b.id === targetBld.id)).toBe(true)

      const roofLevelChunks = res.level!.chunks.filter((c) => c.customCutaway === "outside")
      expect(roofLevelChunks.length).toBeGreaterThan(1)

      let ownRoofHiddenCount = 0
      let neighbourRoofCount = 0
      for (const rc of roofLevelChunks) {
        const hiddenInside = isRoofChunkHidden(rc, insideX, insideY, false)
        const isTargetBuildingRoof =
          Math.abs(rc.cutBox![0]! - (targetBld.rect[0] - 0.1)) < 1e-3 &&
          Math.abs(rc.cutBox![2]! - (targetBld.rect[1] - 0.1)) < 1e-3
        if (isTargetBuildingRoof) {
          expect(hiddenInside).toBe(true)
          // Standing 3m outside the building in the street/yard must NOT hide its roof
          expect(isRoofChunkHidden(rc, targetBld.rect[0] - 3.0, insideY, false)).toBe(false)
          ownRoofHiddenCount++
        } else {
          // Neighbouring buildings' roofs in the 5×5 window must remain visible!
          expect(hiddenInside).toBe(false)
          neighbourRoofCount++
        }
      }
      expect(ownRoofHiddenCount).toBe(1)
      expect(neighbourRoofCount).toBeGreaterThan(0)
    }
  })

  test("5×5 frustum window covers max zoom-out off-screen, scales lookahead with speed, and fades late chunks", () => {
    const streamer = new WorldClientStreamer()
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")

    // Max zoom-out (zoom = 65) camera ground footprint spans ±35.6 m in X and ±22.4 m in Z
    const px = 148
    const py = 44
    const maxZoomView: [number, number, number, number] = [px - 35.6, py - 22.4, px + 35.6, py + 18.3]
    const res = streamer.updateWindow(px, py, session.view.town, "streaming", maxZoomView, 18, 0, 1.0)
    expect(res.changed).toBe(true)

    // Verify rendered chunks cover the entire max-zoom-out frustum plus an off-screen margin on all 4 sides
    let minChunkX = Infinity, maxChunkX = -Infinity, minChunkZ = Infinity, maxChunkZ = -Infinity
    for (const c of res.level!.chunks) {
      if (c.box[0] < minChunkX) minChunkX = c.box[0]
      if (c.box[2] > maxChunkX) maxChunkX = c.box[2]
      if (c.box[1] < minChunkZ) minChunkZ = c.box[1]
      if (c.box[3] > maxChunkZ) maxChunkZ = c.box[3]
    }
    expect(minChunkX).toBeLessThanOrEqual(maxZoomView[0] - 12)
    expect(maxChunkX).toBeGreaterThanOrEqual(maxZoomView[2] + 12)
    expect(minChunkZ).toBeLessThanOrEqual(maxZoomView[1] - 12)
    expect(maxChunkZ).toBeGreaterThanOrEqual(maxZoomView[3] + 12)

    // Speed-scaled lookahead queues more chunks at vehicle speed (20 m/s) than walking speed (3 m/s)
    const walkStreamer = new WorldClientStreamer()
    walkStreamer.prewarmAround(148, 44, 7, 7, 0.22, 1, "streaming", 3, 0)
    const walkPending = walkStreamer.pendingBakeCount

    const vehicleStreamer = new WorldClientStreamer()
    vehicleStreamer.prewarmAround(148, 44, 7, 7, 0.22, 1, "streaming", 20, 0)
    const vehiclePending = vehicleStreamer.pendingBakeCount
    expect(vehiclePending).toBeGreaterThan(walkPending)

    // Late-arriving chunk fade ramps chunkFadeAlpha from >0 to 1 over 0.28s and clears
    streamer.triggerChunkFade("4,1", 10.0)
    const fadeMid = streamer.updateWindow(px, py, session.view.town, "streaming", maxZoomView, 0, 0, 10.14)
    expect(streamer.chunkFadeAlpha).toBeGreaterThan(0.4)
    expect(streamer.chunkFadeAlpha).toBeLessThan(0.6)
    expect(fadeMid.level!.chunks.some((c) => c.customCutaway === "fade")).toBe(true)

    const fadeDone = streamer.updateWindow(px, py, session.view.town, "streaming", maxZoomView, 0, 0, 10.35)
    expect(streamer.chunkFadeAlpha).toBe(0)
    expect(fadeDone.level!.chunks.some((c) => c.customCutaway === "fade")).toBe(false)
  })
})
