// Flight test harness (flight.html): the real sea, sky, islands and the sailing carrier, with a jet on its catapult.
// Enter runs the takeoff, then you fly; a crash (or R near the carrier, the landing) puts you back on the deck. Offline, no
// network. URL: ?seed=N (world, default 7), ?ship=0.6 (carrier throttle), ?rudder=0 (carrier rudder -1..1),
// ?invert (mouse pitch), ?cockpit, ?team=0|1 (accent colour of the jet and the carrier), ?f35 (fly the F-35C). `globalThis.carrier.flight` exposes everything for scripts/flight-shot.ts.
import "../style.css"
import "@fontsource/ibm-plex-mono/300.css"
import { makeArchipelago, type Archipelago } from "../../shared/islands"
import { landTarget } from "../../shared/landing"
import { copyPlane, makePlane, quatAxis, quatMul, setPlaneQuat } from "../../shared/plane"
import { makeSea, seaHeight, type Sea } from "../../shared/sea"
import { bakeSeabed } from "../../shared/seabed"
import { SHIP, type Ship, copyShip, headingTo, lerpShip, makeShip, shipStep } from "../../shared/ship"
import { VEHICLES, type VehicleKind, landingVehicle } from "../../shared/vehicles"
import { Wake } from "../game/wake"
import { ATMOSPHERE, fillAtmosphere } from "../render/atmosphere"
import { buildCarrier } from "../render/carrier-mesh"
import { Clouds } from "../render/clouds"
import { FRAME, FRAME_FLOATS, TIME_WRAP } from "../render/frame"
import { buildIslandMesh } from "../render/island-mesh"
import { Ocean } from "../render/ocean"
import { PlaneFx } from "../render/plane-fx"
import { loadPlaneModels } from "../render/plane-glb"
import { type PlaneDrawPose, PlanePass } from "../render/plane-pass"
import { teamColor } from "../render/team"
import { TEAMS } from "../../shared/crew"
import { DEFAULT_GRADE } from "../render/post"
import { Renderer } from "../render/renderer"
import { ShipPass, type ShipDrawPose } from "../render/ship-pass"
import { Sky } from "../render/sky"
import { FlightView } from "./camera"
import { Flight } from "./flight"
import { FlightHud } from "./hud"
import { FlightInput } from "./input"

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
  const num = (k: string, d: number) => (params.get(k) !== null && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d)
  const seed = num("seed", 7) >>> 0
  const shipThrottle = num("ship", 0.6)
  const shipRudder = num("rudder", 0)

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
  const planePass = new PlanePass(renderer, models)
  const fx = new PlaneFx(renderer, models)
  renderer.addPass("sky", sky)
  renderer.addPass("opaque", shipPass)
  renderer.addPass("opaque", planePass)
  renderer.addPass("opaque", ocean)
  renderer.addPass("opaque", clouds)
  renderer.addPass("alpha", wake)
  renderer.addPass("alpha", fx)

  const input = new FlightInput(canvas)
  input.invert = params.has("invert")
  const hud = new FlightHud()
  const flight = new Flight(input, hud, models[vehicle].eye)
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
  const t0 = num("t0", 0)
  const seaTime = () => t0 + (performance.now() - start) / 1000
  const goal = arch.islands[0]
  const ship: Ship & { id: number; team: number } = Object.assign(makeShip(0, 0, goal ? headingTo(0, 0, goal.x, goal.z) : 0, seaTime()), { id: 0, team: num("team", 0) })
  const shipPrev: Ship = makeShip(0, 0, 0)
  copyShip(ship, shipPrev)
  const shipDraw: Ship = makeShip(0, 0, 0)
  const shipControls = { throttle: shipThrottle, rudder: shipRudder }
  const team = ship.team
  // Let the carrier work up speed and settle on the swell before the jet appears.
  for (let i = 0; i < num("warmup", 40) / SHIP.tick; i++) shipStep(ship, shipControls, sea, arch, SHIP.tick)
  ship.t = seaTime()
  flight.toDeck(ship)
  const world = { sea, arch, ships: [ship] }

  const shipPose: ShipDrawPose = { x: 0, heave: 0, z: 0, heading: 0, pitch: 0, roll: 0, radar: 0 }
  /** Test warp: puts the jet in free flight at (x, y, z), nose along compass `heading` and `pitch` (rad), at `speed`. */
  const warp = (x: number, y: number, z: number, heading: number, pitch: number, speed: number) => {
    const p = flight.plane
    Object.assign(p, makePlane(ship.t), { x, y, z, throttle: VEHICLES[flight.vehicle].flight.cruise })
    const q = quatMul(quatAxis(0, 1, 0, Math.PI - heading), quatAxis(1, 0, 0, -pitch))
    setPlaneQuat(p, q)
    p.vx = speed * Math.cos(pitch) * Math.sin(heading)
    p.vy = speed * Math.sin(pitch)
    p.vz = -speed * Math.cos(pitch) * Math.cos(heading)
    copyPlane(p, flight.prev)
    flight.phase = "flying"
    flight.airborne = 10
    flight.cam.reset()
  }
  /** Screenshot helpers: `inspect` orbits the camera round the jet (yaw from the nose, pitch up, distance); `wing` draws
   *  a second jet offset in the jet's frame (x left, y up, z ahead) wearing another team's colour (and type, `kind`);
   *  `doors` (0..1) and `stores` (bombs aboard) pose the jet's bay. */
  const debug = {
    renderer,
    frame,
    grade,
    atmosphere,
    flight,
    ship,
    sea,
    arch,
    input,
    world,
    shipControls,
    paused: false,
    warp,
    team,
    inspect: null as { yaw: number; pitch: number; dist: number } | null,
    wing: null as { x: number; y: number; z: number; team: number; kind?: VehicleKind } | null,
    doors: 0,
    stores: undefined as number | undefined,
  }
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

  let last = performance.now()
  let simT = ship.t
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const target = debug.paused ? simT : seaTime()
    if (target - ship.t > 4) ship.t = target - SHIP.tick
    flight.readInput(dt)
    // "R LAND" near the carrier, as in the game (src/flight/seam.ts).
    flight.landPrompt = flight.phase === "flying" && !!landTarget(flight.plane, flight.airborne, ship, undefined, target, landingVehicle(flight.vehicle))
    if (flight.landPrompt && input.land) flight.land(ship)
    while (ship.t + SHIP.tick <= target) {
      copyShip(ship, shipPrev)
      shipStep(ship, shipControls, sea, arch, SHIP.tick)
      flight.tick(ship, world)
    }
    simT = ship.t
    const k = Math.max(0, Math.min(1, (target - ship.t) / SHIP.tick))
    lerpShip(shipPrev, ship, k, shipDraw)
    const aspect = canvas.width / canvas.height
    const pose = flight.frame(dt, k, aspect, (x, z) => seaHeight(sea, x, z, target), { w: innerWidth, h: innerHeight }, shipDraw)
    hud.homeColor = TEAMS[debug.team]?.color ?? "#f4f7fb"
    if (flight.phase === "deck" && input.launch) flight.requestLaunch()
    input.endFrame()

    const cam = flight.cam
    shipPose.x = shipDraw.x
    shipPose.z = shipDraw.z
    shipPose.heave = shipDraw.heave
    shipPose.heading = shipDraw.heading
    shipPose.pitch = shipDraw.pitch
    shipPose.roll = shipDraw.roll
    shipPose.radar = (target * RADAR_RPS * Math.PI * 2) % (Math.PI * 2)
    shipPose.accent = teamColor(debug.team)
    if (debug.inspect) {
      const d = debug.inspect
      const p = flight.draw
      const qx = p.qx, qy = p.qy, qz = p.qz, qw = p.qw
      const rot = (x: number, y: number, z: number): [number, number, number] => {
        const tx = 2 * (qy * z - qz * y)
        const ty = 2 * (qz * x - qx * z)
        const tz = 2 * (qx * y - qy * x)
        return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)]
      }
      const off = rot(Math.sin(d.yaw) * Math.cos(d.pitch) * d.dist, Math.sin(d.pitch) * d.dist, Math.cos(d.yaw) * Math.cos(d.pitch) * d.dist)
      cam.eye[0] = p.x + off[0]
      cam.eye[1] = p.y + off[1]
      cam.eye[2] = p.z + off[2]
      const l = Math.hypot(...off)
      cam.forward[0] = -off[0] / l
      cam.forward[1] = -off[1] / l
      cam.forward[2] = -off[2] / l
      const up = rot(0, 1, 0)
      cam.up[0] = up[0]
      cam.up[1] = up[1]
      cam.up[2] = up[2]
      cam.fov = (40 * Math.PI) / 180
      cam.compute(aspect)
    }
    shipPass.begin()
    shipPass.add(shipPose)
    shipPass.upload()
    wake.begin(sea, shipDraw.t, cam.eye)
    wake.ship(-1, shipDraw)
    wake.upload()
    planePass.begin()
    fx.begin(cam.eye, target)
    if (flight.phase === "crashed") fx.burst(flight.plane.x, flight.plane.y, flight.plane.z, flight.crashTime, flight.plane.crashed === "sea")
    if (pose && debug.wing) {
      const w = debug.wing
      const p = flight.draw
      const qx = p.qx, qy = p.qy, qz = p.qz, qw = p.qw
      const tx = 2 * (qy * w.z - qz * w.y)
      const ty = 2 * (qz * w.x - qx * w.z)
      const tz = 2 * (qx * w.y - qy * w.x)
      const wingPose: PlaneDrawPose = { ...pose, accent: teamColor(w.team), noCanopy: false, kind: w.kind ?? "hornet", doors: 0, stores: undefined }
      wingPose.x += w.x + qw * tx + (qy * tz - qz * ty)
      wingPose.y += w.y + qw * ty + (qz * tx - qx * tz)
      wingPose.z += w.z + qw * tz + (qx * ty - qy * tx)
      planePass.add(wingPose)
      fx.plane(1, planePass.modelMatrix(wingPose, new Float32Array(16)), wingPose.throttle, wingPose.burner, 0, wingPose.kind)
    }
    if (pose) {
      pose.accent = teamColor(debug.team)
      pose.kind = flight.vehicle
      pose.doors = debug.doors
      pose.stores = debug.stores
      planePass.add(pose)
      const m = planePass.modelMatrix(pose, new Float32Array(16))
      fx.plane(0, m, pose.throttle, pose.burner, flight.vapour, flight.vehicle)
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

