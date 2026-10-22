// Boat test harness (boat.html, dev only, not built): the real sea, sky, islands, weather and time of day, the sailing
// carrier, and the Mk VII interceptor craned off its port elevator. Drive and shoot it against low-flying target drones
// and enemy boats circling nearby; bring it back alongside slowly to be picked up. Offline, no network.
// Keys: W/S, A/D, Shift boost, mouse aim (click for Pointer Lock), Space/LMB fire, Enter launches again once recovered.
// URL: ?seed=N (world, default 7) ?weather=clear|light|medium|heavy ?tod=H (frozen hour) ?ship=0.3 (carrier throttle)
// ?drone=N (target drones, default 2) ?targets=N (enemy boats, default 2) ?team=0|1 ?water (start in the water, no
// crane) ?t0=S (sea time at load). `globalThis.carrier` exposes everything for scripts/boat-shot.ts.
import "../style.css"
import "@fontsource/ibm-plex-mono/300.css"
import { BOAT, BOAT_HEALTH, BoatCombat, type BoatControls, type BoatTarget, boatDamage, boatStep, copyBoat, lerpBoat, makeBoat, releaseBoat, GUN } from "../../shared/boat"
import { CombatWorld } from "../../shared/combat"
import { teamCss } from "../../shared/crew"
import { makeArchipelago, type Archipelago } from "../../shared/islands"
import { shipToWorld } from "../../shared/plane"
import { makeSea, seaHeight } from "../../shared/sea"
import { bakeSeabed } from "../../shared/seabed"
import { SHIP, type Ship, copyShip, headingTo, lerpShip, makeShip, shipStep } from "../../shared/ship"
import { makeWeather, WEATHER_KINDS, WEATHER_PRESETS, type WeatherKind } from "../../shared/weather"
import { WEAPONS, type Target } from "../../shared/weapons"
import { BoatAudio } from "../audio/boat-audio"
import { WeaponAudio } from "../audio/weapon-audio"
import { FlightView } from "../flight/camera"
import { ChaseCam } from "../game/chase"
import { Wake } from "../game/wake"
import { Input } from "../input"
import { ATMOSPHERE, fillAtmosphere } from "../render/atmosphere"
import { BoatFx } from "../render/boat-fx"
import { loadBoatModel } from "../render/boat-glb"
import { type BoatDrawPose, BoatPass } from "../render/boat-pass"
import { BoatWake } from "../render/boat-wake"
import { Camera } from "../render/camera"
import { buildCarrier } from "../render/carrier-mesh"
import { Clouds } from "../render/clouds"
import { DayNight } from "../render/daynight"
import { FRAME, FRAME_FLOATS, TIME_WRAP } from "../render/frame"
import { buildIslandMesh } from "../render/island-mesh"
import { Lights } from "../render/lights"
import { Ocean, type OceanLook } from "../render/ocean"
import { PlaneFx } from "../render/plane-fx"
import { loadPlaneModels } from "../render/plane-glb"
import { PlanePass } from "../render/plane-pass"
import { DEFAULT_GRADE } from "../render/post"
import { Renderer } from "../render/renderer"
import { ShipPass, type ShipDrawPose } from "../render/ship-pass"
import { Sky } from "../render/sky"
import { Stars } from "../render/stars"
import { teamColor } from "../render/team"
import { WeaponFx } from "../render/weapon-fx"
import { WeatherSystem } from "../render/weather-system"
import { Drones } from "../weapons/drones"
import { BOAT_RADAR_RPS, BoatDriver, type BoatShip, type BoatWorld } from "./boat"
import { BoatInput } from "./input"

const MAX_DPR = 1.5
const RADAR_RPS = 0.25
const ME = 1
const SHIP_ID = 1

async function gpu(canvas: HTMLCanvasElement): Promise<Renderer | string> {
  if (!navigator.gpu) return "Carrier needs WebGPU."
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return "No WebGPU adapter."
  const device = await adapter.requestDevice()
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  const context = canvas.getContext("webgpu")
  if (!context) return "WebGPU could not start on this canvas."
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  return new Renderer(device, context, format)
}

/** An enemy boat circling a point (the targets). */
type Enemy = { id: number; boat: ReturnType<typeof makeBoat>; prev: ReturnType<typeof makeBoat>; draw: ReturnType<typeof makeBoat>; cx: number; cz: number; radius: number; dir: number; dead: number; pose: BoatDrawPose; target: BoatTarget }

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const hudEl = document.getElementById("hud")!
  const renderer = await gpu(canvas)
  if (typeof renderer === "string") {
    hudEl.innerHTML = `<div class="notice"><div class="brand">CARRIER</div><div>${renderer}</div></div>`
    return
  }
  hudEl.innerHTML = `<div id="tl" class="brand">CARRIER · BOAT</div>`
  const params = new URLSearchParams(location.search)
  const waterLab = location.pathname.endsWith("/water.html")
  if (waterLab) for (const [key, value] of Object.entries({ water: "1", drone: "0", targets: "0", ship: "0", tod: "15" })) {
    if (!params.has(key)) params.set(key, value)
  }
  const num = (k: string, d: number) => (params.get(k) !== null && params.get(k) !== "" && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d)
  const seed = num("seed", 7) >>> 0
  const team = num("team", 0)

  const grade = { ...DEFAULT_GRADE }
  const atmosphere = { ...ATMOSPHERE }
  const frame = new Float32Array(FRAME_FLOATS)
  const view = new FlightView()
  const camera = new Camera()
  const sky = new Sky(renderer)
  const ocean = new Ocean(renderer)
  const clouds = new Clouds(renderer)
  const lights = new Lights(renderer)
  const stars = new Stars(renderer)
  const shipPass = new ShipPass(renderer, buildCarrier())
  const wake = new Wake(renderer)
  const boatWake = new BoatWake(renderer)
  const boatPass = new BoatPass(renderer, await loadBoatModel())
  const models = await loadPlaneModels()
  const planePass = new PlanePass(renderer, models)
  const planeFx = new PlaneFx(renderer, models)
  const wfx = new WeaponFx(renderer)
  const fx = new BoatFx(wfx, () => ocean.water)
  renderer.addPass("sky", sky)
  renderer.addPass("sky", stars)
  renderer.addPass("opaque", shipPass)
  renderer.addPass("opaque", boatPass)
  renderer.addPass("opaque", planePass)
  renderer.addPass("opaque", ocean)
  renderer.addPass("opaque", clouds)
  renderer.addPass("alpha", wake)
  renderer.addPass("alpha", boatWake)
  renderer.addPass("alpha", planeFx)
  renderer.addPass("alpha", wfx)
  renderer.addPass("alpha", lights)

  const weather = new WeatherSystem(renderer)
  clouds.storm = weather.clouds
  const shownAtmosphere = { ...atmosphere }
  const shownGrade = { ...grade }
  const baseOcean: OceanLook = { ...ocean.look, deep: [...ocean.look.deep], scatter: [...ocean.look.scatter], foam: [...ocean.look.foam] }
  const dayBases = { atmosphere, grade, ocean: baseOcean }
  const daynight = new DayNight(dayBases)
  daynight.setWorld(seed)
  if (params.has("tod")) daynight.setManual(num("tod", 12), 0)
  const forced = params.get("weather")
  if (forced && (WEATHER_KINDS as readonly string[]).includes(forced)) weather.manual = makeWeather(WEATHER_PRESETS[forced as WeatherKind])

  const arch: Archipelago = makeArchipelago(seed)
  renderer.setStatic(buildIslandMesh(arch))
  const sea = weather.setWorld(seed, makeSea(seed))
  ocean.setSea(sea)
  clouds.setWorld(seed, sea.wind)
  ocean.setClouds(seed, (t, out) => clouds.drift(t, out))
  ocean.setSeabed(bakeSeabed(arch, 2048))

  const start = performance.now()
  const t0 = num("t0", 20)
  let clock = t0
  let lastNow = start
  const goal = arch.islands[0]
  const ship: Ship = makeShip(0, 0, goal ? headingTo(0, 0, goal.x, goal.z) : 0, clock)
  const shipPrev: Ship = makeShip(0, 0, 0)
  const shipDraw: Ship = makeShip(0, 0, 0)
  const shipControls = { throttle: num("ship", 0.3), rudder: 0 }
  weather.update(0, clock)
  for (let i = 0; i < 30 / SHIP.tick; i++) shipStep(ship, shipControls, sea, arch, SHIP.tick)
  ship.t = clock
  copyShip(ship, shipPrev)
  const home: BoatShip = Object.assign(makeShip(0, 0, 0), { id: SHIP_ID, team })
  const homeDraw: BoatShip = Object.assign(makeShip(0, 0, 0), { id: SHIP_ID, team })

  const input = new Input(canvas)
  input.lockable = true
  const audio = waterLab ? null : new BoatAudio()
  const weaponAudio = waterLab ? null : new WeaponAudio()
  const driver = new BoatDriver(new BoatInput(input, canvas), undefined, audio)
  driver.id = ME
  driver.team = team
  driver.hud.homeColor = teamCss(team)

  // Health: drones in a combat world (the 25 mm hits them through its gun-hit path), boats in a BoatCombat.
  const combat = new CombatWorld({ sea, arch, ships: [] }, true)
  combat.spawn(ME, team, "hornet")
  const boats = new BoatCombat()
  boats.spawn(ME, team)
  const enemyTeam = team === 0 ? 1 : 0
  const drones = new Drones(params.has("drone") ? num("drone", 2) : 2, { centre: [ship.x, ship.z - 1200], hostile: false, flares: false, team: enemyTeam })
  drones.enlist(combat)
  const lowDrones = () => drones.list.forEach((d, i) => (d.alt = 110 + 50 * i))
  lowDrones()

  const enemies: Enemy[] = []
  const nTargets = params.has("targets") ? num("targets", 2) : 2
  const fwd = { x: Math.sin(ship.heading), z: -Math.cos(ship.heading) }
  for (let i = 0; i < nTargets; i++) {
    const cx = ship.x + fwd.x * (500 + 250 * i) + fwd.z * (i % 2 ? 260 : -260)
    const cz = ship.z + fwd.z * (500 + 250 * i) - fwd.x * (i % 2 ? 260 : -260)
    const b = makeBoat(cx + 220, cz, 0, clock)
    const e: Enemy = { id: 200 + i, boat: b, prev: makeBoat(0, 0, 0), draw: makeBoat(0, 0, 0), cx, cz, radius: 220, dir: i % 2 ? 1 : -1, dead: -1, pose: { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, radar: 0, yaw: 0, gun: 0, nozzle: 0 }, target: { id: 200 + i, team: enemyTeam, pose: b, vx: 0, vz: 0, alive: true } }
    b.heading = Math.atan2(-e.dir * 0, 0) + (e.dir > 0 ? Math.PI : 0)
    copyBoat(b, e.prev)
    boats.spawn(e.id, enemyTeam)
    enemies.push(e)
  }
  const enemyControls: BoatControls = { throttle: 0.6, steer: 0, boost: false }

  driver.onHit = (kind, id, x, _y, z) => {
    if (kind === "jet") {
      const d = drones.list.find((q) => q.id === id)
      const dist = d ? Math.hypot(d.plane.x - x, d.plane.z - z) : 0
      combat.gunHit(ME, id, Math.max(1, Math.round(7 / WEAPONS.gun.damage)), dist)
      driver.hud.hit(false)
    } else if (kind === "boat") {
      boats.hit(id, ME, team, "cannon", boatDamage("cannon"))
      driver.hud.hit(false)
    }
  }
  const relaunch = () => {
    driver.launch(clock)
    boats.spawn(ME, team, clock)
  }
  driver.onRecovered = () => setTimeout(() => debug.autoRelaunch && relaunch(), 1500)
  driver.onLost = () => setTimeout(() => debug.autoRelaunch && relaunch(), 1500)
  if (params.has("water")) {
    weather.update(0, clock)
    releaseBoat(driver.boat, ship, seaHeight(sea, ship.x, ship.z, clock), clock)
    // Out on the water ahead of the carrier's beam.
    driver.boat.x += Math.cos(ship.heading) * -120 + Math.sin(ship.heading) * 200
    driver.boat.z += Math.sin(ship.heading) * -120 - Math.cos(ship.heading) * 200
    driver.boat.heave = seaHeight(sea, driver.boat.x, driver.boat.z, clock)
    copyBoat(driver.boat, driver.prev)
    driver.phase = "drive"
    driver.phaseAt = clock
  } else relaunch()

  const chase = new ChaseCam()
  const shipPose: ShipDrawPose = { x: 0, heave: 0, z: 0, heading: 0, pitch: 0, roll: 0, radar: 0 }
  const matrix = new Float32Array(16)
  const accent = teamColor(team)
  const enemyAccent = teamColor(enemyTeam)
  const enemyCss = teamCss(enemyTeam)
  void enemyCss
  /** Screenshot helpers: `inspect` orbits the camera round the boat (yaw from the bow, pitch up, distance); `paused`
   *  freezes the clock; `speed` scales it. */
  const debug = {
    renderer,
    ocean,
    frame,
    grade,
    atmosphere,
    camera,
    driver,
    ship,
    shipControls,
    sea,
    arch,
    weather,
    daynight,
    lights,
    drones,
    enemies,
    boats,
    combat,
    input,
    wfx,
    paused: false,
    speed: 1,
    autoRelaunch: true,
    inspect: null as { yaw: number; pitch: number; dist: number; y?: number } | null,
    /** A camera fixed in the carrier's frame: eye and target in ship-local metres (+X port, +Z bow). */
    shipCam: null as { eye: [number, number, number]; at: [number, number, number] } | null,
    /** Puts the boat in the water `ahead` m ahead and `side` m to starboard of the carrier, moving at `knots`. */
    place(ahead: number, side: number, knots = 0, heading = ship.heading) {
      const s = Math.sin(ship.heading)
      const c = Math.cos(ship.heading)
      releaseBoat(driver.boat, ship, 0, ship.t)
      driver.boat.x = ship.x + s * ahead + c * side
      driver.boat.z = ship.z - c * ahead + s * side
      driver.boat.heading = heading
      driver.boat.u = (knots * 0.514444)
      driver.boat.v = 0
      driver.boat.r = 0
      driver.boat.heave = seaHeight(sea, driver.boat.x, driver.boat.z, ship.t)
      driver.boat.wy = Number.NaN
      copyBoat(driver.boat, driver.prev)
      driver.phase = "drive"
      driver.phaseT = 0
      driver.armed = true
      driver.cam.reset()
    },
    relaunch,
    boatHp: (hp: number) => {
      const b = boats.boats.get(ME)
      if (b) b.hp = hp
      driver.hp = hp
    },
    /** Lead aim at drone `id` (or boat) for captures: the turret tracks it. */
    aimDrone(id: number | null) {
      debug.aimId = id
    },
    aimId: null as number | null,
  }
  Object.assign(globalThis, { carrier: debug })
  const waterEditor = waterLab ? (await import("./water-editor")).createWaterEditor(canvas, debug, params) : null

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.6, Math.min(1, innerWidth / 1500, innerHeight / 950))))
  }
  resize()
  addEventListener("resize", resize)

  const jets: Target[] = []
  const boatTargets: BoatTarget[] = []
  const world: BoatWorld = { sea, arch, ships: [home], home, jets, boats: boatTargets }
  const myTarget: BoatTarget = { id: ME, team, pose: driver.boat, vx: 0, vz: 0, alive: true }
  void myTarget

  const steerEnemy = (e: Enemy) => {
    const b = e.boat
    const rx = b.x - e.cx
    const rz = b.z - e.cz
    const r = Math.hypot(rx, rz) || 1
    let tx = (-rz / r) * e.dir
    let tz = (rx / r) * e.dir
    const err = Math.max(-1, Math.min(1, (r - e.radius) / 120))
    tx -= (rx / r) * err
    tz -= (rz / r) * err
    const want = Math.atan2(tx, -tz)
    const dh = Math.atan2(Math.sin(want - b.heading), Math.cos(want - b.heading))
    enemyControls.steer = Math.max(-1, Math.min(1, dh * 2))
  }

  let last = performance.now()
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    if (!debug.paused) clock += ((now - lastNow) / 1000) * debug.speed
    lastNow = now
    const t = clock
    daynight.update(dt, t, dayBases, ocean.look)
    weather.update(dt, t, { baseAtmosphere: daynight.atmosphere, atmosphere: shownAtmosphere, baseGrade: daynight.grade, grade: shownGrade, baseOcean: daynight.ocean, ocean: ocean.look, daylight: daynight.state.daylight })
    if (input.pressed("Enter") && !driver.active) relaunch()
    driver.readInput()
    if (t - ship.t > 4) ship.t = t - SHIP.tick
    lowDrones()
    while (ship.t + SHIP.tick <= t) {
      copyShip(ship, shipPrev)
      shipStep(ship, shipControls, sea, arch, SHIP.tick)
      Object.assign(home, ship, { id: SHIP_ID, team })
      jets.length = 0
      for (const d of drones.list) {
        const f = combat.fighters.get(d.id)
        if (d.dead >= 0 || !f?.alive) continue
        jets.push({ id: d.id, team: enemyTeam, x: d.plane.x, y: d.plane.y, z: d.plane.z, vx: d.plane.vx, vy: d.plane.vy, vz: d.plane.vz, alive: true })
      }
      boatTargets.length = 0
      for (const e of enemies) {
        e.target.alive = e.dead < 0
        e.target.pose = e.boat
        if (e.dead < 0) boatTargets.push(e.target)
      }
      // Aim helper for captures: lead the chosen drone or boat.
      if (debug.aimId !== null) {
        const d = drones.list.find((q) => q.id === debug.aimId && q.dead < 0)
        const e = enemies.find((q) => q.id === debug.aimId && q.dead < 0)
        const b = driver.boat
        if (d) {
          const dist = Math.hypot(d.plane.x - b.x, d.plane.y - b.heave, d.plane.z - b.z)
          const lead = dist / GUN.muzzle
          driver.aimAt = [d.plane.x + d.plane.vx * lead, d.plane.y + d.plane.vy * lead + 0.5 * 9.81 * lead * lead, d.plane.z + d.plane.vz * lead]
        } else if (e) {
          const dist = Math.hypot(e.boat.x - b.x, e.boat.z - b.z)
          const lead = dist / GUN.muzzle
          const s = Math.sin(e.boat.heading)
          const c = Math.cos(e.boat.heading)
          driver.aimAt = [e.boat.x + e.boat.u * s * lead, e.boat.heave + 1.5 + 0.5 * 9.81 * lead * lead, e.boat.z - e.boat.u * c * lead]
        } else driver.aimAt = null
      } else driver.aimAt = null
      if (!waterEditor?.editing) driver.fixed(world)
      for (const e of enemies) {
        copyBoat(e.boat, e.prev)
        if (e.dead >= 0) {
          e.dead += SHIP.tick
          e.boat.t += SHIP.tick
          if (e.dead > BOAT_HEALTH.sink + 3) {
            e.dead = -1
            boats.spawn(e.id, enemyTeam, e.boat.t)
            Object.assign(e.boat, makeBoat(e.cx + e.radius, e.cz, e.dir > 0 ? Math.PI : 0, e.boat.t))
            copyBoat(e.boat, e.prev)
          } else {
            e.boat.heave -= SHIP.tick * 1.2
            e.boat.u *= 0.98
          }
          continue
        }
        steerEnemy(e)
        boatStep(e.boat, enemyControls, sea, arch, [home], BOAT.tick)
      }
      drones.tick(combat, { sea, arch }, null, () => {})
      combat.step(ship.t, jets)
      boats.step(ship.t)
      for (const ev of combat.events) {
        if (ev.k === "kill") {
          const d = drones.list.find((q) => q.id === ev.on)
          if (d) {
            wfx.explosion(d.plane.x, d.plane.y, d.plane.z, d.plane.vx * 0.5, d.plane.vy * 0.5, d.plane.vz * 0.5, 1.4)
            driver.hud.hit(true)
            weaponAudio?.explosion(Math.hypot(d.plane.x - camera.eye[0], d.plane.y - camera.eye[1], d.plane.z - camera.eye[2]), 1.2, "air-kill")
          }
        }
      }
      combat.events.length = 0
      for (const ev of boats.events) {
        if (ev.k === "bhp" && ev.on === ME) driver.hp = ev.hp
        if (ev.k === "bkill") {
          if (ev.on === ME) driver.destroy()
          const e = enemies.find((q) => q.id === ev.on)
          if (e && e.dead < 0) {
            e.dead = 0
            fx.explode({ x: e.boat.x, z: e.boat.z, heave: e.boat.heave, heading: e.boat.heading, pitch: 0, roll: 0, u: e.boat.u, v: e.boat.v })
            driver.hud.hit(true)
            weaponAudio?.explosion(Math.hypot(e.boat.x - camera.eye[0], e.boat.z - camera.eye[2]), 1, "missile")
          }
        }
      }
      boats.events.length = 0
    }
    waterEditor?.update(t, dt)
    const k = Math.max(0, Math.min(1, (t - ship.t) / SHIP.tick))
    lerpShip(shipPrev, ship, k, shipDraw)
    Object.assign(homeDraw, shipDraw, { id: SHIP_ID, team, u: ship.u, v: ship.v, r: ship.r })
    const aspect = canvas.width / canvas.height
    const size = { w: innerWidth, h: innerHeight }
    if (driver.active) {
      driver.frame(dt, k, debug.inspect ? null : camera, aspect, size, homeDraw, sea)
    } else {
      chase.update(camera, { x: shipDraw.x, z: shipDraw.z, heave: shipDraw.heave, heading: shipDraw.heading, speed: shipDraw.u, topSpeed: SHIP.topSpeed, trauma: 0 }, dt, aspect, { dx: input.dragX, dy: input.dragY, wheel: 0, dragging: input.dragging })
      driver.frame(dt, k, null, aspect, size, homeDraw, sea)
    }
    if (debug.inspect) {
      const d = debug.inspect
      const s = driver.shown
      const yaw = s.heading + d.yaw
      const eye = [s.x - Math.sin(yaw) * Math.cos(d.pitch) * d.dist, s.heave + (d.y ?? 2) + Math.sin(d.pitch) * d.dist, s.z + Math.cos(yaw) * Math.cos(d.pitch) * d.dist]
      const fwd3 = [s.x - eye[0]!, s.heave + (d.y ?? 2) - eye[1]!, s.z - eye[2]!]
      const l = Math.hypot(fwd3[0]!, fwd3[1]!, fwd3[2]!)
      camera.lookAlong(eye, [fwd3[0]! / l, fwd3[1]! / l, fwd3[2]! / l], [0, 1, 0], (45 * Math.PI) / 180, aspect)
    }
    if (debug.shipCam) {
      const c = debug.shipCam
      const e = shipToWorld(shipDraw, c.eye[0], c.eye[1], c.eye[2])
      const a = shipToWorld(shipDraw, c.at[0], c.at[1], c.at[2])
      const f = [a[0] - e[0], a[1] - e[1], a[2] - e[2]]
      const l = Math.hypot(f[0]!, f[1]!, f[2]!)
      camera.lookAlong(e, [f[0]! / l, f[1]! / l, f[2]! / l], [0, 1, 0], (45 * Math.PI) / 180, aspect)
    }
    input.endFrame()

    shipPose.x = shipDraw.x
    shipPose.z = shipDraw.z
    shipPose.heave = shipDraw.heave
    shipPose.heading = shipDraw.heading
    shipPose.pitch = shipDraw.pitch
    shipPose.roll = shipDraw.roll
    shipPose.radar = (t * RADAR_RPS * Math.PI * 2) % (Math.PI * 2)
    shipPose.accent = accent
    shipPass.begin()
    shipPass.add(shipPose)
    shipPass.upload()
    wake.begin(sea, shipDraw.t, camera.eye)
    wake.ship(-1, shipDraw)
    wake.upload()
    wfx.begin(camera.eye, t, dt, camera.fov, canvas.height)
    planePass.begin()
    planeFx.begin(camera.eye, t)
    for (const [d, dp] of drones.poses(k)) {
      dp.accent = enemyAccent
      planePass.add(dp)
      planeFx.plane(d.id, planePass.modelMatrix(dp, matrix), dp.throttle, dp.burner, 0)
      const hp = combat.hp(d.id)
      if (hp < WEAPONS.health.max * WEAPONS.health.smoke) wfx.damage(d.id, dp.x, dp.y, dp.z, d.plane.vx, d.plane.vy, d.plane.vz, hp < WEAPONS.health.max * WEAPONS.health.fire ? 2 : 1)
    }
    planePass.upload()
    planeFx.upload()
    boatPass.begin()
    boatWake.begin(t)
    driver.render(boatPass, fx, boatWake, t, accent, dt)
    for (const e of enemies) {
      const b = lerpBoat(e.prev, e.boat, k, e.draw)
      if (e.dead > BOAT_HEALTH.sink) continue
      const p = e.pose
      Object.assign(p, { x: b.x, y: b.heave, z: b.z, heading: b.heading, pitch: b.pitch, roll: b.roll, radar: (t * BOAT_RADAR_RPS * Math.PI * 2) % (Math.PI * 2), yaw: Math.sin(t * 0.4 + e.id) * 0.6, gun: 0.05, nozzle: b.rudder, accent: enemyAccent })
      boatPass.add(p, e.id)
      if (e.dead < 0) boatWake.boat(e.id, b)
      fx.boat(e.id, { x: b.x, z: b.z, heave: b.heave, heading: b.heading, pitch: b.pitch, roll: b.roll, u: b.u, v: b.v, power: b.power, wet: b.wet, wetAft: b.wetAft, slams: b.slams, boosting: false }, e.dead >= 0 ? 0 : boats.hp(e.id), dt, e.dead >= 0 ? Math.min(1, e.dead / BOAT_HEALTH.sink) : 0)
    }
    fx.prune()
    boatPass.upload()
    boatWake.upload()
    wfx.upload()

    frame.set(camera.viewProj, FRAME.viewProj)
    frame.set(camera.eye, FRAME.eye)
    frame[FRAME.eye + 3] = ((t % TIME_WRAP) + TIME_WRAP) % TIME_WRAP
    fillAtmosphere(frame, shownAtmosphere)
    daynight.fill(frame)
    frame[FRAME.viewport] = canvas.width
    frame[FRAME.viewport + 1] = canvas.height
    frame[FRAME.viewport + 2] = 1 / canvas.width
    frame[FRAME.viewport + 3] = 1 / canvas.height
    frame.set(camera.forward, FRAME.forward)
    view.set(camera.eye, camera.forward, camera.upDir, camera.fov, aspect)
    const sunView = shownAtmosphere.sunView ?? shownAtmosphere.sunDir
    sky.update(view, sunView)
    const w = weather.current
    daynight.passes(view, stars, lights, { fov: camera.fov, height: canvas.height, overcast: shownAtmosphere.overcast ?? 0, storm: Math.min(1, w.cloud * w.dark * 1.2) })
    ocean.update(t, view, sunView)
    clouds.update(t, view)
    weather.draw(dt, t, view, frame, camera.fov)
    renderer.render(frame, shownGrade)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void main()
