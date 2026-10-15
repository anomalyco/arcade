import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { NetSession } from "../src/net-session"
import { Loopback } from "../tests/loopback"

const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-vehicles")
mkdirSync(out, { recursive: true })

const build = Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" })
assert.equal(build.exitCode, 0, "Production build failed")

const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/favicon.ico") return new Response(null, { status: 204 })
    const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
  },
})

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(chrome, "Install Chromium before running prove-vehicles.ts")

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--use-angle=metal",
    "--ignore-gpu-blocklist",
    "--mute-audio",
  ],
})

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })

  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)

  // 1. Capture staged vehicle stills
  const scenes: { name: string; scene: string; steps: number; cmd?: Record<string, unknown> }[] = [
    { name: "01-starter-sedan-prompt", scene: "driveway", steps: 6 },
    { name: "02-noir-night-headlights", scene: "night-headlights", steps: 12 },
    { name: "03-police-cruiser-lightbar", scene: "police-cruiser", steps: 12 },
    { name: "04-zombie-roadkill", scene: "horde-runover", steps: 55, cmd: { mx: 0, my: -1, aim: 0 } },
  ]

  for (const s of scenes) {
    await page.evaluate(async (cfg) => {
      const h = (window as any).__arcadeHarness
      h.reset(7)
      h.setLab("timeScale", 0)
      h.stageVehicle(cfg.scene)
      for (let i = 0; i < cfg.steps; i++) {
        await h.step(1 / 60, cfg.cmd ?? { mx: 0, my: 0 })
      }
    }, s)
    await page.screenshot({ path: resolve(out, `${s.name}.png`) })
  }

  // 2. Measure zombie hits & grabbing/banging in browser
  const zombieMetrics = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("zombieCount", 0)
    h.stageVehicle("horde-runover")
    for (let i = 0; i < 95; i++) {
      await h.step(1 / 60, { mx: 0, my: -1, aim: 0 })
    }
    const afterRun = h.state().vehicles.find((v: any) => v.seats[0] === "player")!
    const roadkillHits = afterRun.zombieHits
    const roadkillKills = afterRun.zombieKills

    // Now stop and spawn 3 zombies beside the car to measure grabbing & banging
    h.spawnZombie(afterRun.x, afterRun.y - 1.15, "chase", Math.PI / 2)
    h.spawnZombie(afterRun.x, afterRun.y + 1.15, "chase", -Math.PI / 2)
    h.spawnZombie(afterRun.x + 1.2, afterRun.y - 1.1, "chase", Math.PI)
    for (let i = 0; i < 90; i++) {
      await h.step(1 / 60, { mx: 0, my: 0, sprint: true })
    }
    const afterBang = h.state().vehicles.find((v: any) => v.id === afterRun.id)!
    return {
      roadkillHits,
      roadkillKills,
      grabbingZombies: afterBang.grabbingZombies,
      bangCount: afterBang.bangCount,
      hpRemaining: afterBang.hp,
      maxHp: afterBang.maxHp,
    }
  })

  // 3. Measure 1 km scripted high-speed vehicle drive through the streaming world (x = 26 m -> x = 1,050 m along y = 44 m)
  const routeMetrics = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", 21.5)
    h.setLab("zombieCount", 14)
    h.setLab("fuelBurnRate", 0.4)

    // Stage cruiser on the main East-West arterial road at (26, 44) facing East (0)
    h.stageVehicle("police-cruiser")
    const st0 = h.state()
    const carId = st0.player.vehicleId
    // Warm up initial window
    for (let w = 0; w < 20; w++) await h.step(1 / 60, { mx: 0, my: 0 })

    const frameTimesMs: number[] = []
    const transitionFrameTimesMs: number[] = []
    const visitedChunks = new Set<string>()
    const visitedDistricts = new Set<string>()
    let prevWinOriginX = h.state().world.windowOrigin[0]
    const startX = h.state().player.x
    let maxSpeedMps = 0
    let maxZoomDist = 0
    let totalZombieHits = 0
    let totalZombieKills = 0

    // Drive east > 1,000 m with proportional steering keeping y = 44.0
    let steps = 0
    while (steps < 4800) {
      steps++
      const pre = h.state()
      const car = pre.vehicles.find((v: any) => v.id === carId)!
      if (car.x - startX >= 1024) break
      // Gentle lane-keeping steer toward y = 44.0
      const yErr = 44.0 - car.y
      const wantHeading = Math.max(-0.25, Math.min(0.25, yErr * 0.18))
      let hErr = wantHeading - car.h
      while (hErr > Math.PI) hErr -= Math.PI * 2
      while (hErr < -Math.PI) hErr += Math.PI * 2
      const steer = Math.max(-1, Math.min(1, hErr * 2.5))

      const t0 = performance.now()
      const st = await h.step(1 / 60, { mx: steer, my: -1, aim: 0 })
      const dtMs = performance.now() - t0
      frameTimesMs.push(dtMs)

      const curCar = st.vehicles.find((v: any) => v.id === carId)!
      if (curCar.speed > maxSpeedMps) maxSpeedMps = curCar.speed
      totalZombieHits = curCar.zombieHits
      totalZombieKills = curCar.zombieKills

      for (const k of st.world.activeChunks) visitedChunks.add(k)
      visitedDistricts.add(st.world.district)

      if (st.world.windowOrigin[0] !== prevWinOriginX) {
        transitionFrameTimesMs.push(dtMs)
        prevWinOriginX = st.world.windowOrigin[0]
      }
      maxZoomDist = Math.max(maxZoomDist, st.world.cachedRenderChunks)
    }

    // Brake to a stop at x > 1,050 m and exit the vehicle to verify ChunkDelta persistence
    for (let i = 0; i < 60; i++) {
      await h.step(1 / 60, { mx: 0, my: 0, sprint: true })
    }
    const beforeExit = h.state().vehicles.find((v: any) => v.id === carId)!
    const parkedX = beforeExit.x
    const parkedY = beforeExit.y
    const parkedChunkKey = `${Math.floor(parkedX / 32)},${Math.floor(parkedY / 32)}`
    await h.step(1 / 60, { mx: 0, my: 0, interact: true })

    // Teleport back to origin (28, 41) so the far-east chunk unloads
    h.pose(28, 41, 0)
    for (let i = 0; i < 5; i++) await h.step(1 / 60)
    const unloadedAtOrigin = !h.state().world.activeChunks.includes(parkedChunkKey)

    // Teleport back to (parkedX - 2, parkedY) and verify the cruiser is restored from ChunkDelta
    h.pose(parkedX - 2, parkedY, 0)
    for (let i = 0; i < 5; i++) await h.step(1 / 60)
    const reloadedCar = h.state().vehicles.find((v: any) => v.id === carId)

    return {
      distanceDrivenM: Number((parkedX - startX).toFixed(1)),
      steps,
      maxSpeedMps: Number(maxSpeedMps.toFixed(2)),
      visitedChunkCount: visitedChunks.size,
      visitedDistricts: [...visitedDistricts],
      frameTimesMs,
      transitionFrameTimesMs,
      zombieHitsOnRoute: totalZombieHits,
      zombieKillsOnRoute: totalZombieKills,
      deltaPersistence: {
        parkedChunkKey,
        unloadedAtOrigin,
        reloaded: Boolean(reloadedCar),
        reloadedX: reloadedCar ? Number(reloadedCar.x.toFixed(2)) : null,
        expectedX: Number(parkedX.toFixed(2)),
      },
    }
  })

  // 4. Co-op driver + passenger test over Loopback
  let virtualMs = 0
  const room = new CoopRoomCore("proofveh", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, () => virtualMs, BUILD)
  const loopback = new Loopback(room, 2)
  const netDriver = new NetSession({
    url: "loop",
    room: "proofveh",
    name: "Driver",
    now: () => loopback.now,
    WebSocket: loopback.socketClass(),
  })
  const netPassenger = new NetSession({
    url: "loop",
    room: "proofveh",
    name: "Passenger",
    now: () => loopback.now,
    WebSocket: loopback.socketClass(),
  })
  for (let i = 0; i < 10; i++) {
    virtualMs = loopback.now * 1000
    loopback.step()
    netDriver.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false })
    netPassenger.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false })
    netDriver.sync(TICK_DT)
    netPassenger.sync(TICK_DT)
  }
  const srvCar = room.sim.vehicles.byId(1)!
  Object.assign(srvCar, { x: 26, y: 44, h: 0 })
  const slotD = room.sim.slot(netDriver.id)!
  const slotP = room.sim.slot(netPassenger.id)!
  Object.assign(slotD.survivor, { x: 26, y: 42.7 })
  Object.assign(slotP.survivor, { x: 26, y: 45.3 })
  Object.assign(netDriver.view.player, { x: 26, y: 42.7 })
  Object.assign(netPassenger.view.player, { x: 26, y: 45.3 })

  for (let i = 0; i < 12; i++) {
    virtualMs = loopback.now * 1000
    loopback.step()
    netDriver.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: i === 0 })
    netPassenger.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: i === 3 })
    netDriver.sync(TICK_DT)
    netPassenger.sync(TICK_DT)
  }

  room.sim.ai.spawnZombie(room.sim.town, 45, 44, "chase", Math.PI)
  for (let i = 0; i < 180; i++) {
    virtualMs = loopback.now * 1000
    loopback.step()
    const driving = i < 120
    netDriver.update(TICK_DT, { mx: 0, my: driving ? -1 : 0, aim: 0, interact: false, sprint: !driving })
    netPassenger.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, fire: i === 25 })
    netDriver.sync(TICK_DT)
    netPassenger.sync(TICK_DT)
  }

  const predCar = netDriver.vehicles.byId(1)!
  const passCar = netPassenger.vehicles.byId(1)!
  const driverDriftM = Math.hypot(predCar.x - srvCar.x, predCar.y - srvCar.y)
  const passengerCarDriftM = Math.hypot(passCar.x - srvCar.x, passCar.y - srvCar.y)
  netDriver.close()
  netPassenger.close()

  const sortedFrames = [...routeMetrics.frameTimesMs].sort((a, b) => a - b)
  const sortedTrans = [...routeMetrics.transitionFrameTimesMs].sort((a, b) => a - b)
  const p50 = sortedFrames[Math.floor(sortedFrames.length * 0.5)]!
  const p95 = sortedFrames[Math.floor(sortedFrames.length * 0.95)]!
  const worstFrame = sortedFrames[sortedFrames.length - 1]!
  const transP95 = sortedTrans[Math.floor(sortedTrans.length * 0.95)] ?? p95

  assert(routeMetrics.distanceDrivenM >= 1000, `Expected >= 1000 m driven, got ${routeMetrics.distanceDrivenM}`)
  assert.equal(routeMetrics.deltaPersistence.unloadedAtOrigin, true)
  assert.equal(routeMetrics.deltaPersistence.reloaded, true)
  assert(zombieMetrics.roadkillHits >= 2, `Expected >= 2 zombie hits, got ${zombieMetrics.roadkillHits}`)
  assert(zombieMetrics.grabbingZombies >= 1, `Expected grabbing zombies >= 1`)
  assert(zombieMetrics.bangCount >= 1, `Expected zombie bang count >= 1`)
  assert(driverDriftM < 0.08, `Expected co-op driver drift < 0.08 m, got ${driverDriftM}`)
  assert.deepEqual(errors, [])

  const summary = {
    adapter,
    route1km: {
      distanceDrivenM: routeMetrics.distanceDrivenM,
      steps: routeMetrics.steps,
      maxSpeedMps: routeMetrics.maxSpeedMps,
      visitedChunkCount: routeMetrics.visitedChunkCount,
      visitedDistricts: routeMetrics.visitedDistricts,
      frameTimeMs: {
        p50: Number(p50.toFixed(2)),
        p95: Number(p95.toFixed(2)),
        worstFrame: Number(worstFrame.toFixed(2)),
        chunkTransitionCount: routeMetrics.transitionFrameTimesMs.length,
        chunkTransitionP95: Number(transP95.toFixed(2)),
      },
      deltaPersistence: routeMetrics.deltaPersistence,
    },
    zombieInteractions: zombieMetrics,
    coopDriverPassenger: {
      distanceDrivenM: Number((srvCar.x - 26).toFixed(1)),
      driverSeat: slotD.survivor.seatIndex,
      passengerSeat: slotP.survivor.seatIndex,
      driverPredictionDriftM: Number(driverDriftM.toFixed(4)),
      passengerCarDriftM: Number(passengerCarDriftM.toFixed(4)),
      zombieHits: srvCar.zombieHits,
      passengerShotsFired: 6 - slotP.survivor.magAmmo,
    },
    captures: scenes.map((s) => `${s.name}.png`),
    errors,
  }

  await Bun.write(resolve(out, "proof.json"), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
} finally {
  await browser.close()
  fixture.stop(true)
}
