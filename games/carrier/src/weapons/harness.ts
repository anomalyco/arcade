// Weapons test harness (weapons.html, dev only, not built): the flight harness's world (sea, sky, islands, the sailing
// carrier, a jet on the catapult) plus the weapons, offline, against AI target drones. Same controls as flight.html
// (Enter launches), plus Space / left mouse fire, 1/2/3 select, wheel or V cycle, F flares.
// URL: ?seed=N (world, default 7) ?drone=N (target drones, default 3) ?hostile (drones lock on and fire missiles)
// ?flares (drones flare at inbound missiles) ?air (start airborne behind the first drone) ?f35 (fly the F-35C: its model,
// flight tuning and loadout) ?invert ?cockpit ?ship=0.6.
// `globalThis.carrier` exposes everything for scripts/weapons-shot.ts: weapons, drones, flight, warp, behind(id, m),
// incoming(id), and the FlightInput (stick override) and WeaponInput (trigger override).
import "../style.css"
import "@fontsource/ibm-plex-mono/300.css"
import { makeArchipelago, type Archipelago } from "../../shared/islands"
import { copyPlane, makePlane, quatAxis, quatMul, quatRotate, setPlaneQuat } from "../../shared/plane"
import { VEHICLES, type VehicleKind } from "../../shared/vehicles"
import { makeSea, seaHeight, type Sea } from "../../shared/sea"
import { bakeSeabed } from "../../shared/seabed"
import { SHIP, type Ship, copyShip, headingTo, lerpShip, makeShip, shipStep } from "../../shared/ship"
import { TEAMS } from "../../shared/crew"
import { WeaponAudio } from "../audio/weapon-audio"
import { FlightView } from "../flight/camera"
import { Flight } from "../flight/flight"
import { FlightHud } from "../flight/hud"
import { FlightInput } from "../flight/input"
import { Wake } from "../game/wake"
import { ATMOSPHERE, fillAtmosphere } from "../render/atmosphere"
import { buildCarrier } from "../render/carrier-mesh"
import { Clouds } from "../render/clouds"
import { FRAME, FRAME_FLOATS, TIME_WRAP } from "../render/frame"
import { buildIslandMesh } from "../render/island-mesh"
import { Ocean } from "../render/ocean"
import { PlaneFx } from "../render/plane-fx"
import { loadPlaneModels } from "../render/plane-glb"
import { PlanePass } from "../render/plane-pass"
import { DEFAULT_GRADE } from "../render/post"
import { Renderer } from "../render/renderer"
import { ShipPass, type ShipDrawPose } from "../render/ship-pass"
import { Sky } from "../render/sky"
import { teamColor } from "../render/team"
import { WeaponFx } from "../render/weapon-fx"
import { Drones } from "./drones"
import { WeaponHud } from "./hud"
import { WeaponInput } from "./input"
import { Weapons } from "./weapons"

const MAX_DPR = 1.5
const RADAR_RPS = 0.25

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

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const hudEl = document.getElementById("hud")!
  const renderer = await gpu(canvas)
  if (typeof renderer === "string") {
    hudEl.innerHTML = `<div class="notice"><div class="brand">CARRIER</div><div>${renderer}</div></div>`
    return
  }
  hudEl.innerHTML = `<div id="tl" class="brand">CARRIER</div>`
  const params = new URLSearchParams(location.search)
  const num = (k: string, d: number) => (params.get(k) !== null && params.get(k) !== "" && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d)
  const seed = num("seed", 7) >>> 0

  const grade = { ...DEFAULT_GRADE }
  const atmosphere = { ...ATMOSPHERE }
  const frame = new Float32Array(FRAME_FLOATS)
  const view = new FlightView()
  const sky = new Sky(renderer)
  const ocean = new Ocean(renderer)
  const clouds = new Clouds(renderer)
  const shipPass = new ShipPass(renderer, buildCarrier())
  const wake = new Wake(renderer)
  const models = await loadPlaneModels()
  const vehicle: VehicleKind = params.has("f35") ? "f35" : "hornet"
  const model = models[vehicle]
  const planePass = new PlanePass(renderer, models)
  const fx = new PlaneFx(renderer, models)
  const wfx = new WeaponFx(renderer)
  renderer.addPass("sky", sky)
  renderer.addPass("opaque", shipPass)
  renderer.addPass("opaque", planePass)
  renderer.addPass("opaque", ocean)
  renderer.addPass("opaque", clouds)
  renderer.addPass("alpha", wake)
  renderer.addPass("alpha", fx)
  renderer.addPass("alpha", wfx)

  const winput = new WeaponInput(canvas)
  const input = new FlightInput(canvas)
  input.invert = params.has("invert")
  const hud = new FlightHud()
  const flight = new Flight(input, hud, model.eye)
  flight.vehicle = vehicle
  if (params.has("cockpit")) flight.cam.mode = "cockpit"

  const arch: Archipelago = makeArchipelago(seed)
  renderer.setStatic(buildIslandMesh(arch))
  const sea: Sea = makeSea(seed)
  ocean.setSea(sea)
  clouds.setWorld(seed, sea.wind)
  ocean.setClouds(seed, (t, out) => clouds.drift(t, out))
  ocean.setSeabed(bakeSeabed(arch, 2048))

  const start = performance.now()
  const seaTime = () => (performance.now() - start) / 1000
  const goal = arch.islands[0]
  const ship: Ship = makeShip(0, 0, goal ? headingTo(0, 0, goal.x, goal.z) : 0, seaTime())
  const shipPrev: Ship = makeShip(0, 0, 0)
  copyShip(ship, shipPrev)
  const shipDraw: Ship = makeShip(0, 0, 0)
  const shipControls = { throttle: num("ship", 0.6), rudder: 0 }
  for (let i = 0; i < 40 / SHIP.tick; i++) shipStep(ship, shipControls, sea, arch, SHIP.tick)
  ship.t = seaTime()
  flight.toDeck(ship)
  const world = { sea, arch, ships: [ship] }

  const weapons = new Weapons(wfx, new WeaponHud(), new WeaponAudio(), winput, null, world)
  weapons.setPilot(1, 0, "YOU", TEAMS[0]!.color)
  weapons.sortie(vehicle)
  // Falling bombs wear the F-35C's own store mesh.
  weapons.drawBomb = (x, y, z, vx, vy, vz) => {
    planePass.addStore("f35", 0, x, y, z, vx, vy, vz)
    return true
  }
  const droneCount = params.has("drone") ? num("drone", 3) : 3
  const drones = new Drones(droneCount, { centre: [ship.x, ship.z - 1500], hostile: params.has("hostile"), flares: params.has("flares"), team: 1 })
  drones.enlist(weapons.world)

  // Shot down: the jet is lost like a crash (the flight's crash flow and respawn take over).
  weapons.onDestroyed = () => flight.shootDown()

  const shipPose: ShipDrawPose = { x: 0, heave: 0, z: 0, heading: 0, pitch: 0, roll: 0, radar: 0 }
  const warp = (x: number, y: number, z: number, heading: number, pitch: number, speed: number) => {
    const p = flight.plane
    Object.assign(p, makePlane(ship.t), { x, y, z, throttle: VEHICLES[vehicle].flight.cruise })
    setPlaneQuat(p, quatMul(quatAxis(0, 1, 0, Math.PI - heading), quatAxis(1, 0, 0, -pitch)))
    p.vx = speed * Math.cos(pitch) * Math.sin(heading)
    p.vy = speed * Math.sin(pitch)
    p.vz = -speed * Math.cos(pitch) * Math.cos(heading)
    copyPlane(p, flight.prev)
    flight.phase = "flying"
    flight.airborne = 10
    flight.cam.reset()
  }
  /** Warps our jet `dist` metres behind drone `id`, matching its heading and speed. */
  const behind = (id = 100, dist = 500, up = 0) => {
    const d = drones.list.find((x) => x.id === id)
    if (!d) return
    const p = d.plane
    const s = Math.hypot(p.vx, p.vz) || 1
    const heading = Math.atan2(p.vx, -p.vz)
    if (flight.phase !== "flying") weapons.sortie()
    warp(p.x - (p.vx / s) * dist, p.y + up, p.z - (p.vz / s) * dist, heading, 0, Math.hypot(p.vx, p.vy, p.vz))
  }
  /** Drone `id` fires a missile at us right now, from `dist` metres behind us (a tail shot), as if it were there. */
  const incoming = (id = 100, dist = 1800) => {
    const p = flight.plane
    const s = Math.hypot(p.vx, p.vy, p.vz) || 1
    const f = weapons.world.fighters.get(id)
    if (f) f.missiles = 2
    const ux = p.vx / s
    const uy = p.vy / s
    const uz = p.vz / s
    weapons.world.fire({ owner: id, seq: 1000 + Math.floor(Math.random() * 1e6), t: weapons.world.t, x: p.x - ux * dist, y: p.y - uy * dist + 20, z: p.z - uz * dist, vx: ux * (s + 20), vy: uy * (s + 20), vz: uz * (s + 20), target: weapons.id })
  }
  /** Test autopilot: steers our nose at drone `aim` (with a little lead) through the stick override. */
  const steer = () => {
    const d = debug.aim === null ? null : drones.list.find((x) => x.id === debug.aim && x.dead < 0)
    if (!d || flight.phase !== "flying") return
    const p = flight.plane
    const lead = Math.hypot(d.plane.x - p.x, d.plane.y - p.y, d.plane.z - p.z) / 1150
    const dx = d.plane.x + d.plane.vx * lead - p.x
    const dy = d.plane.y + d.plane.vy * lead + 0.5 * 9.81 * lead * lead - p.y
    const dz = d.plane.z + d.plane.vz * lead - p.z
    // Into the body frame (inverse rotation): +X left, +Y up, +Z nose.
    const b = quatRotate(-p.qx, -p.qy, -p.qz, p.qw, dx, dy, dz, [0, 0, 0])
    const off = Math.atan2(Math.hypot(b[0], b[1]), b[2])
    const roll = Math.atan2(-b[0], b[1])
    const k = Math.min(1, off / 0.15)
    input.override = {
      pitch: Math.max(-1, Math.min(1, Math.atan2(b[1], b[2]) * 6)),
      roll: Math.max(-1, Math.min(1, roll * 1.5 * k)),
      yaw: Math.max(-1, Math.min(1, Math.atan2(-b[0], b[2]) * 5)),
    }
  }
  const debug = { aim: null as number | null, inspect: null as { yaw: number; pitch: number; dist: number } | null, renderer, frame, grade, atmosphere, flight, ship, sea, arch, input, winput, world, weapons, drones, wfx, warp, behind, incoming, paused: false }
  Object.assign(globalThis, { carrier: Object.assign(debug, { camera: flight.cam, game: { state: { ship } } }) })

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.6, Math.min(1, innerWidth / 1500, innerHeight / 950))))
  }
  resize()
  addEventListener("resize", resize)

  const matrix = new Float32Array(16)
  const accent = teamColor(0)
  const enemy = teamColor(1)
  const enemyCss = TEAMS[1]!.color
  let wasFlying = false
  let last = performance.now()
  let simT = ship.t
  if (params.has("air")) setTimeout(() => behind(100, 700), 50)
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const target = debug.paused ? simT : seaTime()
    if (target - ship.t > 4) ship.t = target - SHIP.tick
    if (debug.aim !== null) steer()
    flight.readInput(dt)
    while (ship.t + SHIP.tick <= target) {
      copyShip(ship, shipPrev)
      shipStep(ship, shipControls, sea, arch, SHIP.tick)
      flight.tick(ship, world)
      const flying = flight.phase === "flying" || flight.phase === "landing"
      if (flying) weapons.tick(flight.plane, flight.phase === "flying")
      else if (wasFlying) {
        // Crashed on our own: the world credits whoever damaged us lately.
        if (flight.plane.crashed && flight.plane.crashed !== "shot") weapons.crashed()
        else weapons.land()
      }
      if (!wasFlying && flying && flight.airborne < 1) weapons.sortie()
      wasFlying = flying
      drones.tick(weapons.world, { sea, arch }, flying ? { id: weapons.id, team: 0, x: flight.plane.x, y: flight.plane.y, z: flight.plane.z, vx: flight.plane.vx, vy: flight.plane.vy, vz: flight.plane.vz, alive: true } : null, (id, s) => weapons.lockedBy(id, s))
    }
    simT = ship.t
    const k = Math.max(0, Math.min(1, (target - ship.t) / SHIP.tick))
    lerpShip(shipPrev, ship, k, shipDraw)
    const aspect = canvas.width / canvas.height
    const pose = flight.frame(dt, k, aspect, (x, z) => seaHeight(sea, x, z, target), { w: innerWidth, h: innerHeight }, shipDraw)
    if (flight.phase === "deck" && input.launch) flight.requestLaunch()
    input.endFrame()
    if (weapons.trauma > 0) {
      // Hits shake the camera (trauma², camera.ts); presentation only.
      flight.shake(weapons.trauma)
      weapons.trauma = 0
    }

    const cam = flight.cam
    if (debug.inspect) {
      // Screenshot orbit round our jet: yaw from the nose, pitch up, distance (in the jet's frame).
      const d = debug.inspect
      const p = flight.draw
      const off = quatRotate(p.qx, p.qy, p.qz, p.qw, Math.sin(d.yaw) * Math.cos(d.pitch) * d.dist, Math.sin(d.pitch) * d.dist, Math.cos(d.yaw) * Math.cos(d.pitch) * d.dist, [0, 0, 0])
      const u = quatRotate(p.qx, p.qy, p.qz, p.qw, 0, 1, 0, [0, 0, 0])
      const l = Math.hypot(...off)
      for (let i = 0; i < 3; i++) {
        cam.eye[i] = [p.x, p.y, p.z][i]! + off[i]!
        cam.forward[i] = -off[i]! / l
        cam.up[i] = u[i]!
      }
      cam.fov = (40 * Math.PI) / 180
      cam.compute(aspect)
    }
    shipPose.x = shipDraw.x
    shipPose.z = shipDraw.z
    shipPose.heave = shipDraw.heave
    shipPose.heading = shipDraw.heading
    shipPose.pitch = shipDraw.pitch
    shipPose.roll = shipDraw.roll
    shipPose.radar = (target * RADAR_RPS * Math.PI * 2) % (Math.PI * 2)
    shipPose.accent = accent
    shipPass.begin()
    shipPass.add(shipPose)
    shipPass.upload()
    wake.begin(sea, shipDraw.t, cam.eye)
    wake.ship(-1, shipDraw)
    wake.upload()
    planePass.begin()
    fx.begin(cam.eye, target)
    if (flight.phase === "crashed" && flight.plane.crashed !== "shot") fx.burst(flight.plane.x, flight.plane.y, flight.plane.z, flight.crashTime, flight.plane.crashed === "sea")
    weapons.beginJets()
    for (const [d, dp] of drones.poses(k)) {
      dp.accent = enemy
      planePass.add(dp)
      const m = planePass.modelMatrix(dp, matrix)
      fx.plane(d.id, m, dp.throttle, dp.burner, 0)
      const p = d.plane
      weapons.jet(d.id, 1, dp, p.vx, p.vy, p.vz, true, `DRONE ${d.id - 99}`, enemyCss, "hornet", m)
    }
    if (pose) {
      pose.accent = accent
      pose.kind = vehicle
      pose.doors = weapons.doors
      pose.stores = weapons.loadout.bombs
      planePass.add(pose)
      const m = planePass.modelMatrix(pose, matrix)
      fx.plane(0, m, pose.throttle, pose.burner, flight.vapour, vehicle)
      weapons.setOwnModel(flight.phase === "flying" ? m : null)
    } else weapons.setOwnModel(null)
    for (const [id, w] of weapons.wreckPoses()) {
      w.accent = id === weapons.id ? accent : enemy
      planePass.add(w)
    }
    weapons.frame(dt, target, cam.eye, cam.fov, innerHeight, (x, y, z) => cam.project(x, y, z, innerWidth, innerHeight))
    // Our wreck falling: the crash camera follows it.
    const wreck = weapons.ownWreck
    if (flight.phase === "crashed" && wreck) {
      for (const p of [flight.plane, flight.prev]) {
        p.x = wreck.x
        p.y = wreck.y
        p.z = wreck.z
      }
    }
    planePass.upload()
    fx.upload()

    frame.set(cam.viewProj, FRAME.viewProj)
    frame.set(cam.eye, FRAME.eye)
    frame[FRAME.eye + 3] = ((target % TIME_WRAP) + TIME_WRAP) % TIME_WRAP
    fillAtmosphere(frame, atmosphere)
    frame[FRAME.viewport] = canvas.width
    frame[FRAME.viewport + 1] = canvas.height
    frame[FRAME.viewport + 2] = 1 / canvas.width
    frame[FRAME.viewport + 3] = 1 / canvas.height
    frame.set(cam.forward, FRAME.forward)
    view.set(cam.eye, cam.forward, cam.up, cam.fov, aspect)
    const sunView = atmosphere.sunView ?? atmosphere.sunDir
    sky.update(view, sunView)
    ocean.update(target, view, sunView)
    clouds.update(target, view)
    renderer.render(frame, grade)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void main()
