import "./style.css"
import "@fontsource/ibm-plex-mono/300.css"
import { makeArchipelago, type Archipelago } from "../shared/islands"
import { TEAMS, playerOf, shipOf } from "../shared/crew"
import { playerBoat, shipOps } from "../shared/ops"
import { FLEET } from "../shared/fleet"
import { PLANE_MODE } from "../shared/protocol"
import { makeSea } from "../shared/sea"
import { bakeSeabed } from "../shared/seabed"
import { WEATHER_KINDS, type WeatherKind } from "../shared/weather"
import { WeatherAudio } from "./audio/weather-audio"
import { DebugMenu } from "./dev/debug-menu"
import { MixerLab } from "./audio/mixer-lab"
import { mixer } from "./audio/mixer"
import { SoundsLab } from "./audio/sounds-lab"
import { WeatherLab } from "./dev/weather-lab"
import { FlightView } from "./flight/camera"
import { FlightModule } from "./flight/seam"
import { BoatModule } from "./boat/seam"
import { BOAT_MODE } from "../shared/boat"
import { Gunnery, type GunneryNet } from "./gunnery/gunnery"
import { createGame } from "./game/game"
import { Input } from "./input"
import { connect } from "./net"
import { ATMOSPHERE, fillAtmosphere } from "./render/atmosphere"
import { Camera, parseCam } from "./render/camera"
import { Clouds } from "./render/clouds"
import { DayNight } from "./render/daynight"
import { TimeLab } from "./render/daynight-lab"
import { FRAME, FRAME_FLOATS, TIME_WRAP } from "./render/frame"
import { buildIslandMesh } from "./render/island-mesh"
import { Lights } from "./render/lights"
import { DEFAULT_GRADE } from "./render/post"
import { Ocean, type OceanLook } from "./render/ocean"
import { Renderer } from "./render/renderer"
import { Sky } from "./render/sky"
import { Stars } from "./render/stars"
import { WeatherSystem } from "./render/weather-system"
import { Hud } from "./ui/hud"
import { type Start, startFromUrl, storedName } from "./ui/lobby"
import { showMenu } from "./ui/menu"
import { OpsMenu } from "./ui/ops-menu"
import { TeamMenu } from "./ui/team-menu"

const MAX_DPR = 1.5
/** The quiet sea behind the load screen (offline, until a room is chosen). */
const MENU_SEED = 7

async function gpu(canvas: HTMLCanvasElement): Promise<Renderer | string> {
  if (!navigator.gpu) return "Carrier needs WebGPU. Use a recent Chrome, Edge or Safari over https or localhost."
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return "No WebGPU adapter is available on this device."
  const device = await adapter.requestDevice()
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  const context = canvas.getContext("webgpu")
  if (!context) return "WebGPU could not start on this canvas."
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  return new Renderer(device, context, format)
}

/** A full-screen message over everything else (the menus included): no WebGPU, or the GPU gave out. */
function showNotice(hudEl: HTMLElement, message: string): void {
  document.body.classList.remove("mn-open")
  hudEl.style.zIndex = "2000"
  hudEl.innerHTML = `<div class="notice"><div class="brand">CARRIER</div><div>${message}</div></div>`
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const hudEl = document.getElementById("hud")!
  const renderer = await gpu(canvas)
  if (typeof renderer === "string") return showNotice(hudEl, renderer)
  // A lost device (driver reset, GPU process crash) ends the session: stop the frame loop and say so.
  let lost = false
  void renderer.context.device.lost.then((info) => {
    lost = true
    console.error(`[gpu] device lost (${info.reason}): ${info.message}`)
    document.exitPointerLock()
    const audio = mixer().ctx
    if (audio instanceof AudioContext) void audio.suspend().catch(() => undefined)
    showNotice(hudEl, "The GPU stopped responding. Reload to try again.")
  })
  const params = new URLSearchParams(location.search)
  const tParam = params.get("t")
  const frozen = tParam !== null && Number.isFinite(Number(tParam)) ? Number(tParam) : null
  // `?seed` plays offline and `?room=` joins straight away; otherwise the menu picks a room over an offline sea.
  const start = startFromUrl(params)
  const netFor = (s: Start | null) =>
    s?.mode === "room" ? connect({ room: s.room, name: s.name, private: s.private, onFull: () => menu("That game is full. Pick another.") }) : connect({ seed: s?.mode === "offline" ? s.seed : MENU_SEED, name: storedName() })
  let net = netFor(start)
  const camera = new Camera()
  const cam = parseCam(params.get("cam"))
  if (cam) camera.set(cam)
  const input = new Input(canvas)
  const hud = new Hud(hudEl)
  const grade = { ...DEFAULT_GRADE }
  const atmosphere = { ...ATMOSPHERE }
  const frame = new Float32Array(FRAME_FLOATS)

  // Sea and sky: the ocean draws after the static islands so early-z rejects water under them.
  // Rolls and zooms with the jet cameras (a RelView with a free up vector and field of view).
  const view = new FlightView()
  const sky = new Sky(renderer)
  const ocean = new Ocean(renderer)
  const clouds = new Clouds(renderer)
  // Night lights on every carrier and jet: made before the game and the jets so their passes hang their lights on it.
  const lights = new Lights(renderer)
  const stars = new Stars(renderer)
  // The player's carrier (and other players'): its opaque pass goes before the ocean so early-z rejects water under it.
  const game = createGame({ renderer, camera, input, hud, net, params })
  // Jets: the flight module's passes join the opaque and alpha slots once the Hornet model has loaded.
  const flight = new FlightModule(renderer, camera, canvas, net)
  // One Pointer Lock for the ship's camera and the flight stick, owned by `input`; ?invert flips only the stick.
  flight.input.grab = false
  flight.input.invert = params.has("invert")
  game.setFlight(flight)
  // Ship guns: a gunner's first-person turret (SHIP OPERATIONS → CIWS / SAM / 5-INCH), everyone's turrets and fire.
  const gunnery = new Gunnery(renderer, canvas)
  const gunneryNet: GunneryNet = {
    aim: (a) => net.sendAim(a),
    fire: (g) => net.sendGunFire(g),
    hits: (on, n) => net.sendTurretHits(on, n),
    shipHits: (ship, n) => net.sendTurretShipHits(ship, n),
    intercept: (i) => net.sendIntercept(i),
  }
  // Offline the local gunnery world decides: its damage lands in the jets' local world.
  gunnery.onEvent = (e) => {
    if (e.k === "hurt") flight.weapons.world.hurt(e.on, e.dmg, e.by, e.w)
    else if (e.k === "intercept" && e.store === 0) flight.weapons.world.intercept(e.owner, e.seq)
  }
  gunnery.teamOf = (id) => (net.crew ? (playerOf(net.crew, id)?.team ?? -1) : -1)
  game.setGunnery(gunnery)
  // The boat (SHIP OPERATIONS → LAUNCH BOAT): a driver's boat on the shared camera and mouse, everyone's boats; health,
  // the kill feed and being a target for the jets' guns go through the jets' weapons.
  const boat = new BoatModule(renderer, input, canvas, net)
  boat.weapons = flight.weapons
  game.setBoat(boat)
  renderer.addPass("sky", sky)
  renderer.addPass("sky", stars)
  renderer.addPass("opaque", ocean)
  renderer.addPass("opaque", clouds)
  renderer.addPass("alpha", lights)

  // Weather (shared/weather.ts): the room's synced rain, wind and storm seas, applied to the sea every hull floats on,
  // the rain pass, and the look (`atmosphere`, `grade` and the ocean look stay the editable sunny bases).
  const weather = new WeatherSystem(renderer)
  clouds.storm = weather.clouds
  weather.sound = new WeatherAudio()
  const shownAtmosphere = { ...atmosphere }
  const shownGrade = { ...grade }
  const baseOcean: OceanLook = { ...ocean.look, deep: [...ocean.look.deep], scatter: [...ocean.look.scatter], foam: [...ocean.look.foam] }
  // Time of day (shared/daycycle.ts, src/render/daynight.ts): the room's synced clock turns the sunny bases into this
  // moment's look, which the weather then takes as its bases. ?tod=H freezes the local clock at hour H (captures).
  const dayBases = { atmosphere, grade, ocean: baseOcean }
  const daynight = new DayNight(dayBases)
  const tod = Number(params.get("tod") ?? Number.NaN)
  if (params.has("tod") && Number.isFinite(tod)) daynight.setManual(tod, 0)
  // The debug menu (` or F2) and its WEATHER tab. ?lab=weather opens it; ?weather=clear|light|medium|heavy previews a
  // weather locally from the start (scripted captures).
  const lab = new WeatherLab({
    system: weather,
    device: renderer.context.device,
    focus: () => [camera.eye[0]! + camera.forward[0]! * 200, camera.eye[2]! + camera.forward[2]! * 200],
    broadcast: (to, fade) => net.sendWeather(to, fade),
    ship: () => game.state.ship,
  })
  const debugMenu = new DebugMenu({
    release: () => {
      input.suspend()
      input.release()
    },
    open: params.get("lab") === "weather",
    tab: "weather",
  })
  debugMenu.addTab(lab.tab)
  debugMenu.addTab(new TimeLab({ daynight, broadcast: (hour, speed, fade) => net.sendTime(hour, speed, fade) }).tab)
  // AUDIO: levels, jet sound tuning and test buttons (M mutes anywhere).
  debugMenu.addTab(new MixerLab(flight.audio).tab)
  // SOUNDS: the audition board (every sound slot's candidate takes; pick by ear). ?sounds=1 opens it.
  debugMenu.addTab(new SoundsLab().tab)
  if (params.has("sounds")) debugMenu.open("sounds")
  const forced = params.get("weather")
  if (forced && (WEATHER_KINDS as readonly string[]).includes(forced)) lab.force(forced as WeatherKind, 0)

  // Tab: players and ships, switching ships and teams, captain powers. E: SHIP OPERATIONS (take the helm, launch).
  const teams = new TeamMenu(document.body, {
    join: (ship) => net.board(ship),
    create: (team) => net.newShip(team),
    promote: (player) => net.promote(player),
    kick: (player) => net.kick(player),
    lock: (locked) => net.lock(locked),
  })
  // Pilot status: on deck without a jet; my own jet from the flight module, everyone else's from the relayed mode.
  teams.jet = (id) => {
    const p = net.crew && playerOf(net.crew, id)
    if (!p || p.role !== "pilot") return null
    if (p.plane < 0) return "deck"
    if (playerBoat(net.crew, id)) return net.boats.get(id)?.[12] === BOAT_MODE.sunk ? "down" : "boat"
    const mode = id === net.id ? flight.flight.mode : net.planes.get(id)?.[1]
    return mode === PLANE_MODE.flying ? "air" : mode === PLANE_MODE.crashed ? "down" : "deck"
  }
  // Kills and deaths as the room counts them (shared/combat.ts via server/core.ts); no column offline.
  const stats = (id: number) => net.stats.get(id) ?? { kills: 0, deaths: 0 }
  const ops = new OpsMenu(document.body, (id) => net.op(id))
  // A menu frees the cursor; when the last one closes, the lock comes back if it was held (see Input.resume).
  teams.onToggle = (open) => {
    if (!open) return
    input.suspend()
    ops.close()
  }
  ops.onToggle = (open) => {
    if (!open) return
    input.suspend()
    teams.pin(false)
  }
  let menuOpen = false
  const menu = (notice?: string) => {
    if (lost) return
    menuOpen = true
    teams.enabled = false
    ops.enabled = false
    void showMenu(document.body, { notice }).then((s) => {
      menuOpen = false
      teams.enabled = true
      ops.enabled = true
      net.close()
      useNet(netFor(s))
    })
  }

  const debug: { renderer: Renderer; camera: Camera; net: typeof net; input: Input; frame: Float32Array; grade: typeof grade; atmosphere: typeof atmosphere; arch: Archipelago | null; ocean: Ocean; clouds: Clouds } = { renderer, camera, net, input, frame, grade, atmosphere, arch: null, ocean, clouds }
  Object.assign(globalThis, { carrier: Object.assign(debug, { game, gunnery, boat, roster: teams, teams, ops, flight, weather, lab, debugMenu, baseOcean, daynight, stars, lights }) })

  let builtSeed: number | null = null
  const buildWorld = (seed: number) => {
    if (seed === builtSeed) return
    builtSeed = seed
    const arch = makeArchipelago(seed)
    debug.arch = arch
    renderer.setStatic(buildIslandMesh(arch))
    const sea = weather.setWorld(seed, makeSea(seed))
    ocean.setSea(sea)
    clouds.setWorld(seed, sea.wind)
    ocean.setClouds(seed, (t, out) => clouds.drift(t, out))
    ocean.setSeabed(bakeSeabed(arch, 2048))
    game.setWorld(sea, arch)
    flight.setWorld(sea, arch)
    boat.setWorld(sea, arch)
    gunnery.setGround({ sea, arch, ships: [] })
  }
  const useNet = (n: typeof net) => {
    net = n
    debug.net = n
    weather.room = n.weather
    daynight.room = n.time
    game.setNet(n)
    flight.setNet(n)
    boat.setNet(n)
    void n.ready.then(() => net === n && buildWorld(n.seed))
  }
  useNet(net)
  if (!start) menu()

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
  const tick = (now: number) => {
    if (lost) return
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const t = lab.time(frozen ?? net.seaTime(), dt)
    const menus = menuOpen || teams.open || ops.open || debugMenu.visible
    if (!menus) input.resume()
    game.paused = menuOpen || teams.open || ops.open || debugMenu.wantsInput
    lab.frame(dt, t)
    debugMenu.frame(dt)
    daynight.update(dt, t, dayBases, ocean.look)
    weather.update(dt, t, {
      baseAtmosphere: daynight.atmosphere,
      atmosphere: shownAtmosphere,
      baseGrade: daynight.grade,
      grade: shownGrade,
      baseOcean: daynight.ocean,
      ocean: ocean.look,
      daylight: daynight.state.daylight,
    })
    const crew = net.crew
    const serverNow = net.serverNow()
    teams.stats = net.state === "offline" ? null : stats
    teams.hull = net.state === "offline" || !net.hulls.size ? null : (id) => {
      const h = net.hulls.get(id)
      return h ? { hp: h.hp / FLEET.hp, sinking: h.sinkAt !== -1 } : null
    }
    teams.update(crew, net.id, net.room, serverNow)
    const me = crew ? playerOf(crew, net.id) : undefined
    const myShip = crew ? shipOf(crew, me?.ship ?? -1) : undefined
    // In the air E is the jet's rudder (the menu stays shut); at sea in the boat it opens read-only.
    const inBoat = !!net.crew && !!me && playerBoat(net.crew, me.id)
    ops.airborne = me?.role === "pilot" && me.plane >= 0 && !inBoat
    ops.atSea = inBoat
    // The guns act for this player: online the room decides, offline the local world. A gunner's kills read as theirs
    // in the jets' kill feed.
    gunnery.setNet(net.state === "offline" ? null : gunneryNet)
    if (me) gunnery.setPlayer(net.id, me.team)
    if (me?.role === "gunner" && flight.weapons.id !== net.id) flight.weapons.setPilot(net.id, me.team, me.name, TEAMS[me.team]?.color ?? "#f4f7fb")
    ops.update(crew && myShip ? shipOps(crew, net.id, serverNow) : null, crew && myShip ? { ship: myShip.name, color: TEAMS[myShip.team]?.color ?? "", name: (id) => playerOf(crew, id)?.name ?? "?" } : null)
    if (!game.update(dt, t, canvas.width / canvas.height)) {
      const free = !game.paused
      if (free) camera.orbit(input.dragX, input.dragY)
      if (free) camera.zoom(input.wheel)
      camera.update(dt, free ? input.right : 0, free ? input.ahead : 0, input.fast, canvas.width / canvas.height)
    }
    input.endFrame()
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
    view.set(camera.eye, camera.forward, camera.upDir, camera.fov, canvas.width / canvas.height)
    const sunView = shownAtmosphere.sunView ?? shownAtmosphere.sunDir
    sky.update(view, sunView)
    const w = weather.current
    daynight.passes(view, stars, lights, { fov: camera.fov, height: canvas.height, overcast: shownAtmosphere.overcast ?? 0, storm: Math.min(1, w.cloud * w.dark * 1.2) })
    ocean.update(t, view, sunView)
    clouds.update(t, view)
    weather.draw(dt, t, view, frame, camera.fov)
    renderer.render(frame, shownGrade)
    hud.update(net)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void main()
