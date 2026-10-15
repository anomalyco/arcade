import "./style.css"
import "@fontsource/ibm-plex-mono/300.css"
import { makeArchipelago, type Archipelago } from "../shared/islands"
import { teamCss, playerOf, shipOf } from "../shared/crew"
import { playerBoat, shipOps } from "../shared/ops"
import { FLEET } from "../shared/fleet"
import { PLANE_MODE } from "../shared/protocol"
import { makeSea } from "../shared/sea"
import { bakeSeabed } from "../shared/seabed"
import { WeatherAudio } from "./audio/weather-audio"
import { mixer } from "./audio/mixer"
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
import { Zones } from "./objective/zones"
import { type Start, startFromUrl, storedName } from "./ui/lobby"
import { showMenu } from "./ui/menu"
import { OpsMenu } from "./ui/ops-menu"
import { TeamMenu } from "./ui/team-menu"
import { Chat } from "./ui/chat"
import { registerGameCommands } from "@arcade/kit/dev-control"
import { GameQuality } from "@arcade/kit/client/quality"
import { GpuPerf } from "@arcade/kit/gpu-perf"
import { CARRIER_QUALITY } from "./quality"

/** The quiet sea behind the load screen (offline, until a room is chosen). */
const MENU_SEED = 7

async function gpu(canvas: HTMLCanvasElement): Promise<{ renderer: Renderer; perf: GpuPerf } | string> {
  if (!navigator.gpu) return "Carrier needs WebGPU. Use a recent Chrome, Edge or Safari over https or localhost."
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return "No WebGPU adapter is available on this device."
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [] })
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  const context = canvas.getContext("webgpu")
  if (!context) return "WebGPU could not start on this canvas."
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  return { renderer: new Renderer(device, context, format), perf: new GpuPerf(device) }
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
  const graphics = await gpu(canvas)
  if (typeof graphics === "string") return showNotice(hudEl, graphics)
  const { renderer, perf } = graphics
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
  // Resolution and bloom follow the quality tier (Auto by default; the dev menu's VIEW tab sets the saved choice).
  const quality = new GameQuality({
    game: "carrier",
    tiers: CARRIER_QUALITY,
    params,
    gpuMs: () => perf.gpuMs,
    onChange: (tier) => renderer.setBloomLevels(tier.bloomLevels),
  }).expose()
  renderer.setBloomLevels(quality.profile.bloomLevels)
  const tParam = params.get("t")
  const frozen = tParam !== null && Number.isFinite(Number(tParam)) ? Number(tParam) : null
  // `?seed` plays offline and `?room=` joins straight away; otherwise the menu picks a room over an offline sea.
  const start = startFromUrl(params)
  // Dev builds only (Vite drops this import from production bundles): the debug menu, its tabs and the bots.
  const devTools = import.meta.env.DEV ? await import("./dev/dev-tools") : null
  // Dev: `?seed=N&bots` plays offline on a room inside the page (src/dev/local-room.ts), so bots have a room to live in.
  const localRoom = devTools && params.has("bots") && start?.mode === "offline" ? devTools.localRoom() : null
  const netFor = (s: Start | null) =>
    s?.mode === "room"
      ? connect({ room: s.room, name: s.name, private: s.private, onFull: () => menu("That game is full. Pick another.") })
      : localRoom && s?.mode === "offline"
        ? connect({ room: "local", name: storedName(), socket: localRoom, world: { seed: s.seed >>> 0, epoch: Date.now() } })
        : connect({ seed: s?.mode === "offline" ? s.seed : MENU_SEED, name: storedName() })
  let net = netFor(start)
  const camera = new Camera()
  const cam = parseCam(params.get("cam"))
  if (cam) camera.set(cam)
  const input = new Input(canvas)
  const hud = new Hud(hudEl)
  // The objective (shared/objective.ts): zones on the sea, the scoreboard, objectiveZones() for the radar.
  const zones = new Zones(renderer, hudEl)
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
  // Ship guns: a gunner's first-person turret (DEPLOY → CIWS / SAM / 5-INCH), everyone's turrets and fire.
  const gunnery = new Gunnery(renderer, canvas)
  const gunneryNet: GunneryNet = {
    aim: (a) => net.sendAim(a),
    fire: (g) => net.sendGunFire(g),
    hits: (on, n) => net.sendTurretHits(on, n),
    shipHits: (ship, n) => net.sendTurretShipHits(ship, n),
    intercept: (i) => net.sendIntercept(i),
    lock: (on, locked) => net.sendSeek(on, locked),
  }
  // SAM locks and SAMs in flight warn a pilot like missiles do (src/weapons/weapons.ts).
  flight.weapons.sams = {
    inbound: (id, x, y, z) => gunnery.world.inbound(id, x, y, z),
    gunner: (id) => {
      const c = net.crew
      return !!c && playerOf(c, id)?.role === "gunner"
    },
  }
  // Offline the local gunnery world decides: its damage lands in the jets' local world.
  gunnery.onEvent = (e) => {
    if (e.k === "hurt") flight.weapons.world.hurt(e.on, e.dmg, e.by, e.w)
    else if (e.k === "intercept" && e.store === 0) flight.weapons.world.intercept(e.owner, e.seq)
  }
  gunnery.teamOf = (id) => (net.crew ? (playerOf(net.crew, id)?.team ?? -1) : -1)
  game.setGunnery(gunnery)
  // The boat (DEPLOY → LAUNCH BOAT): a driver's boat on the shared camera and mouse, everyone's boats; health,
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
  // Dev builds: the debug menu (` or F2) with its tabs (src/dev/dev-tools.ts: add dev tabs there, never statically here,
  // so production bundles stay free of them). ?lab=weather, ?sounds=1, ?bots open it; ?weather=kind previews a weather.
  const dev = devTools?.installDevTools({
    params,
    device: renderer.context.device,
    camera,
    input,
    weather,
    daynight,
    game,
    audio: flight.audio,
    net: () => net,
    quality,
    bots: {
      me: () => {
        const f = flight.flight
        if (f.mode === 1 || f.mode === 3) {
          const p = f.plane
          return { x: p.x, y: p.y, z: p.z, heading: Math.atan2(p.vx, -p.vz), flying: true }
        }
        const s = game.state.ship
        if (s) return { x: s.x, y: 0, z: s.z, heading: s.heading, flying: false }
        return { x: camera.eye[0]!, y: camera.eye[1]!, z: camera.eye[2]!, heading: Math.atan2(camera.forward[0]!, -camera.forward[2]!), flying: false }
      },
    },
  })

  // Tab: players and ships (every carrier its own side), switching ships, captain powers. E: DEPLOY (take the helm, launch).
  const teams = new TeamMenu(document.body, {
    join: (ship) => net.board(ship),
    create: () => net.newShip(),
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
  // T: chat to everyone, Y: to my carrier's crew. While its input is open it owns the keyboard: the game pauses, held
  // keys let go, the cursor is freed (and comes back with the other menus, see Input.resume).
  const chat = new Chat(document.body)
  chat.send = (text, channel) => net.sendChat(text, channel === "crew")
  chat.onToggle = (open) => {
    if (!open) return
    input.suspend()
    input.release()
    ops.close()
    teams.pin(false)
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
    chat.hide()
    chat.enabled = false
    teams.enabled = false
    ops.enabled = false
    void showMenu(document.body, { notice }).then((s) => {
      menuOpen = false
      chat.enabled = true
      teams.enabled = true
      ops.enabled = true
      net.close()
      useNet(netFor(s))
    })
  }

  const debug: { renderer: Renderer; camera: Camera; net: typeof net; input: Input; frame: Float32Array; grade: typeof grade; atmosphere: typeof atmosphere; arch: Archipelago | null; ocean: Ocean; clouds: Clouds } = { renderer, camera, net, input, frame, grade, atmosphere, arch: null, ocean, clouds }
  Object.assign(globalThis, { carrier: Object.assign(debug, { game, gunnery, boat, roster: teams, teams, ops, flight, weather, baseOcean, daynight, stars, lights, zones, chat }, dev ? { lab: dev.lab, debugMenu: dev.menu, bots: dev.bots } : {}) })

  let carrierBlastTimer = 0
  registerGameCommands(commands => {
    commands.registerAll([
      {
        id: "explosion.trigger",
        label: "Trigger Explosion",
        shortLabel: "Explosion",
        category: "Scene",
        undoable: false,
        args: {
          preset: { type: "string", description: "Explosion scenario (ship, missile, boat)" },
          repeat: { type: "boolean", description: "Repeat explosion every 2.4s (4.5s for the ship hit)" },
        },
        enabled: () => true,
        run: (_ctx, args) => {
          if (carrierBlastTimer) {
            window.clearInterval(carrierBlastTimer)
            carrierBlastTimer = 0
          }
          const preset = String(args?.preset ?? "ship")
          const DEG = Math.PI / 180
          const fire = () => {
            const s = game.state.ship
            if (!s) return
            game.state.free = true
            if (preset === "missile") {
              camera.set({ x: s.x, z: s.z - 220, yaw: 180 * DEG, pitch: 15 * DEG, dist: 95 })
              flight.weapons.fx.explosion(s.x, 22, s.z - 220, 0, 0, 0, 1.2, false, "missile")
            } else if (preset === "boat") {
              camera.set({ x: s.x + 85, z: s.z - 60, yaw: 25 * DEG, pitch: 16 * DEG, dist: 75 })
              flight.weapons.fx.explosion(s.x + 85, 2.2, s.z - 60, 0, 2, 0, 1.15, true, "car")
            } else {
              camera.set({ x: s.x, z: s.z + 15, yaw: 35 * DEG, pitch: 42 * DEG, dist: 160 })
              flight.weapons.fx.explosion(s.x, s.heave + 28, s.z + 15, 0, 0, 0, 1.8, false, "ship")
            }
          }
          fire()
          if (args?.repeat !== false) {
            carrierBlastTimer = window.setInterval(fire, preset === "missile" || preset === "boat" ? 2400 : 4500)
          }
          return { triggered: preset, repeat: args?.repeat !== false }
        },
      },
    ])
  })

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
    zones.setWorld(sea, arch)
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
    if (quality.fit(canvas, innerWidth, innerHeight)) renderer.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.6, Math.min(1, innerWidth / 1500, innerHeight / 950))))
  }
  resize()
  addEventListener("resize", resize)

  let last = performance.now()
  const tick = (now: number) => {
    if (lost) return
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    quality.frame(now)
    perf.enabled = quality.wantsGpuTiming
    if (quality.fit(canvas, innerWidth, innerHeight)) renderer.resize(canvas.width, canvas.height)
    const t = dev ? dev.time(frozen ?? net.seaTime(), dt) : (frozen ?? net.seaTime())
    const menus = menuOpen || teams.open || ops.open || chat.open || !!dev?.visible
    if (!menus) input.resume()
    game.paused = menuOpen || teams.open || ops.open || chat.open || !!dev?.wantsInput
    dev?.frame(dt, t)
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
    chat.update(net.chat, crew, net.id, net)
    const me = crew ? playerOf(crew, net.id) : undefined
    const myShip = crew ? shipOf(crew, me?.ship ?? -1) : undefined
    // In a jet (catapult, flight, landing, the wait after a crash) E is the rudder: no DEPLOY menu and no "E DEPLOY"
    // prompt. On deck, at the helm, in a gun seat and in the boat (read-only there) E opens it.
    const inBoat = !!net.crew && !!me && playerBoat(net.crew, me.id)
    const inJet = me?.role === "pilot" && me.plane >= 0 && !inBoat
    ops.airborne = inJet
    hud.deployKey = !inJet
    ops.atSea = inBoat
    // The guns act for this player: online the room decides, offline the local world. A gunner's kills read as theirs
    // in the jets' kill feed.
    gunnery.setNet(net.state === "offline" ? null : gunneryNet)
    if (me) gunnery.setPlayer(net.id, me.team)
    if (me?.role === "gunner" && flight.weapons.id !== net.id) flight.weapons.setPilot(net.id, me.team, me.name, teamCss(me.team))
    ops.update(crew && myShip ? shipOps(crew, net.id, serverNow) : null, crew && myShip ? { ship: myShip.name, color: teamCss(myShip.team), name: (id) => playerOf(crew, id)?.name ?? "?" } : null)
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
    zones.update(t, camera.eye, net, game.state.ship, menuOpen)
    renderer.render(frame, shownGrade)
    hud.update(net)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void main()
