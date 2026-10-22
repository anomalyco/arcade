import { isEditableEventTarget, isMetaKey, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { keyCapHtml, keyPromptHtml } from "@arcade/kit/client/key-cap"
import type { FootSurface } from "@arcade/kit/audio/footsteps"
import { attachLabPanelControl } from "@arcade/kit/dev-control"
import { openGpu } from "@arcade/kit/gpu/boot"
import { FogScatter, createFogSettings, fogCone, type FogLamp } from "@arcade/kit/gpu/fog-scatter"
import { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { Renderer, type FrameInput } from "@arcade/kit/gpu/renderer"
import { newSceneFrame, packSceneFrame, SceneLights, type SceneLight } from "@arcade/kit/gpu/scene-frame"
import { makeSceneShader, spriteShader } from "@arcade/kit/gpu/shaders"
import { TEMPORAL_DEFAULTS } from "@arcade/kit/gpu/temporal"
import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import { randomRoomCode } from "@arcade/kit/sim/matchmaking"
import { ROOM_CODE } from "../shared/protocol"
import { beamLevel, EYE_HEIGHT, TAPE_HEIGHT, FEEL, tapeOnTree, tieTarget, viewDir, type Player, type PlayerInput } from "../shared/sim"
import { dockAt, lakeDistance, makeWorld, standHeight, trailDistance, type WoodsWorld } from "../shared/world"
import { WoodsAudio } from "./audio"
import { WoodsCamera } from "./camera"
import { FEEL_CONTROLS } from "./feel-controls"
import { FriendsView } from "./friends-view"
import { PaperMap } from "./map"
import { OnlineSession, SoloSession, type Session } from "./session"
import { fogVolume, hooks, post, WOODS_FLOATS } from "./shaders"
import { viewRect, WorldView } from "./world-view"

const WALK = { cameraMotion: 1, reduceMotion: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, stepLength: 0.72, walkSettle: 0.3, footsteps: 0.9 }
const WALK_CONTROLS: LabControl[] = [
  { key: "reduceMotion", label: "Reduce camera motion", type: "toggle", group: "Walking" },
  { key: "cameraMotion", label: "Head motion", min: 0, max: 1, step: 0.05, unit: "×", group: "Walking" },
  { key: "stepLength", label: "Step length", min: 0.45, max: 1.1, step: 0.01, unit: "m", group: "Walking" },
  { key: "walkSettle", label: "Start/stop spring", min: 0.1, max: 0.6, step: 0.01, unit: "s", group: "Walking" },
  { key: "footsteps", label: "Footsteps", min: 0, max: 2, step: 0.05, unit: "×", group: "Walking" },
]
/** Lit tape colour gain (cheap retroreflection) and own-beam offset from the eye (right, down, forward; m). */
const TAPE_GAIN = 1
const HAND = [0.2, -0.3, 0.2] as const
/** Your own beam's light id (friends and bots are never 0 in a room; solo you are 0). */
const OWN = 0
const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "KeyE", "KeyG"])

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!
  const hud = document.getElementById("hud")!, prompt = document.getElementById("prompt")!, toast = document.getElementById("toast")!, start = document.getElementById("start")!
  const params = new URLSearchParams(location.search)
  const smoke = params.has("smoke")
  const roomCode = (params.get("room") ?? "").toLowerCase()
  const online = ROOM_CODE.test(roomCode)
  const nameInput = document.getElementById("name") as HTMLInputElement
  nameInput.value = params.get("name") ?? localStorage.getItem("woods.name") ?? ""
  const gpu = await openGpu(canvas, "WOODS")
  if (typeof gpu === "string") { hud.textContent = gpu; return }
  performance.mark("woods:gpu")
  const { device } = gpu
  const settings = { ...FEEL, ...WALK }
  if (smoke) Object.assign(settings, { trunkDensity: 1, botCount: 1 })

  const renderer = new Renderer(device, gpu.context, gpu.format, { scene: makeSceneShader(hooks), sprite: spriteShader(), post, volume: [fogVolume(!smoke)] })
  renderer.setTemporal({ ...TEMPORAL_DEFAULTS, mode: "taa", sharpen: 0.15 })
  const view = new WorldView(renderer)
  const friends = new FriendsView(renderer)
  const map = new PaperMap(document.body)
  const audio = new WoodsAudio()
  const fog = new FogScatter(createFogSettings({ hue: 205, saturation: 0.25, brightness: 0.0009, skyDark: 0.55, horizonGlow: 0.25, ground: 0.1, leak: 0.004, phaseG: 0.55, samples: 6 }))
  const lights = new SceneLights()
  const fp = new FrameParts()
  const frameData = newSceneFrame()
  const custom = new Float32Array(WOODS_FLOATS)

  // A room walks the printed forest (default params) so everyone and the server share it; solo follows the knobs.
  let world: WoodsWorld = online ? makeWorld() : makeWorld({ trunkDensity: settings.trunkDensity })
  let session: Session = online ? new OnlineSession(world, roomCode, nameInput.value.trim()) : new SoloSession(world, settings)
  const useWorld = (w: WoodsWorld) => {
    world = w
    view.setWorld(world)
    map.setWorld(world)
    lights.setBoxes(settings.trunkShadows ? view.occluders(world) : [])
  }
  useWorld(world)
  performance.mark("woods:world")

  let forcePlay = false
  const active = () => forcePlay || (document.pointerLockElement === canvas && !document.hidden && !panel.visible)
  const camera = new WoodsCamera(canvas, () => panel.visible, settings, active)
  camera.fov = 70; camera.near = 0.08; camera.far = 300; camera.flashlight = true
  const spawn = world.camp.spawn
  camera.yaw = spawn.yaw; camera.pitch = -0.05

  const panel = new LabPanel(settings, [...FEEL_CONTROLS, ...WALK_CONTROLS], params, () => { camera.release(); keys.clear() }, { open: false, pill: false, groupActions: false, onToggle: () => syncStart() })
  audio.bank.bindControls(panel)
  attachLabPanelControl(panel)
  let regenAt = 0, worldKey = `${settings.trunkDensity}`, shadowKey = settings.trunkShadows

  // Held keys the game reads (walking, tie, map); mouse look and F live in the shared camera.
  const keys = new Set<string>()
  const release = () => keys.clear()
  window.addEventListener("keydown", (e) => {
    if (isEditableEventTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
    if (document.pointerLockElement !== canvas || panel.visible) return
    if (e.code === "KeyM" && !e.repeat) audio.bank.toggleMute()
    if (MOVE_KEYS.has(e.code)) { keys.add(e.code); e.preventDefault() }
  })
  window.addEventListener("keyup", (e) => { keys.delete(e.code); if (isMetaKey(e.code)) release() })
  window.addEventListener("blur", release)
  document.addEventListener("visibilitychange", () => { if (document.hidden) release() })
  function syncStart() { start.style.display = forcePlay || document.pointerLockElement === canvas || panel.visible ? "none" : "flex" }
  document.addEventListener("pointerlockchange", () => { release(); syncStart() })
  start.addEventListener("click", (e) => { if (!panel.visible && !(e.target as HTMLElement).closest("input, button, a")) canvas.requestPointerLock() })
  nameInput.addEventListener("change", () => {
    const name = nameInput.value.trim().slice(0, 16)
    localStorage.setItem("woods.name", name)
    if (session instanceof OnlineSession && name) session.rename(name)
  })
  const friendsButton = document.getElementById("friends") as HTMLButtonElement
  const inviteLink = () => `${location.origin}${location.pathname}?room=${roomCode}`
  if (online) {
    friendsButton.hidden = true
    document.getElementById("invite")!.hidden = false
    document.getElementById("code")!.textContent = roomCode
    document.getElementById("start-sub")!.textContent = "Click to step out of camp with the others"
    const copy = document.getElementById("copy") as HTMLButtonElement
    copy.addEventListener("click", () => void navigator.clipboard?.writeText(inviteLink()).then(() => { copy.textContent = "Copied" }, () => { copy.textContent = inviteLink() }))
  }
  friendsButton.addEventListener("click", async () => {
    localStorage.setItem("woods.name", nameInput.value.trim().slice(0, 16))
    friendsButton.disabled = true
    let code = ""
    try { code = ((await (await fetch("api/create", { method: "POST" })).json()) as { room?: string }).room ?? "" } catch {}
    location.search = `?room=${ROOM_CODE.test(code) ? code : randomRoomCode()}`
  })

  const controlsHud = () => {
    hud.innerHTML = [keyPromptHtml("KeyW", "Walk"), keyPromptHtml("ShiftLeft", "Run", { hold: true }), keyPromptHtml("KeyF", "Flashlight"), keyPromptHtml("KeyE", "Tie tape", { hold: true }), keyPromptHtml("KeyG", "Map", { hold: true }), keyPromptHtml("KeyM", "Mute"), keyPromptHtml("Backquote", "Knobs")].join(" ")
  }
  controlsHud()
  onKeyLayoutChange(controlsHud)

  let toastUntil = 0
  const say = (text: string, seconds = 3.5) => { toast.textContent = text; toast.style.opacity = "1"; toastUntil = performance.now() + seconds * 1000 }
  say(online ? `Camp Tamarack, nightfall. Room ${roomCode}: your friends start at camp too. Find the old survey markers together.` : "Camp Tamarack, nightfall. Find the old survey markers in the woods.", 6)

  const nameOf = (id: number) => session.view.players.find((p) => p.id === id)?.name ?? "Someone"
  const handFrom = (eye: readonly number[], yaw: number, d: readonly number[]): [number, number, number] => {
    const rx = Math.cos(yaw), rz = -Math.sin(yaw)
    return [eye[0]! + rx * HAND[0] + d[0]! * HAND[2], eye[1]! + HAND[1], eye[2]! + rz * HAND[0] + d[2]! * HAND[2]]
  }
  const surfaceAt = (x: number, z: number): FootSurface => {
    if (dockAt(world, x, z)) return "wood"
    if (lakeDistance(world.lake, x, z) < 1.02) return "puddle"
    if (Math.hypot(x - world.camp.x, z - world.camp.z) < world.camp.radius * 0.7) return "dirt"
    return trailDistance(world.trail, x, z).d < 1.6 ? "dirt" : "grass"
  }

  let acc = 0, last = performance.now(), time = 0, frames = 0, paused = false, prevLight = camera.flashlight
  const debug = { beams: 0, fogLamps: 0, picked: 0, lights: 0, kbps: 0 }
  /** Automation: walk towards a point (cleared on arrival). */
  let autopilot: { x: number; z: number } | null = null

  /** This tick's controls: WASD relative to where you look, the light, the held tie and map keys. */
  function intent(): PlayerInput {
    const k = (...c: string[]) => (c.some((x) => keys.has(x)) ? 1 : 0)
    const f = k("KeyW", "ArrowUp") - k("KeyS", "ArrowDown"), r = k("KeyD", "ArrowRight") - k("KeyA", "ArrowLeft")
    const sy = Math.sin(camera.yaw), cy = Math.cos(camera.yaw)
    let mx = -sy * f + cy * r, mz = -cy * f - sy * r
    if (autopilot) {
      const self = session.self, dx = autopilot.x - self.x, dz = autopilot.z - self.z, d = Math.hypot(dx, dz)
      if (d < 0.25) autopilot = null
      else { mx = dx / d; mz = dz / d }
    }
    const len = Math.hypot(mx, mz)
    if (len > 1) { mx /= len; mz /= len }
    return { yaw: camera.yaw, pitch: camera.pitch, light: camera.flashlight, tie: keys.has("KeyE"), map: keys.has("KeyG"), mx, mz, sprint: !!k("ShiftLeft", "ShiftRight") }
  }

  // The room's roster: who is here, who dropped, who just walked in.
  const roomHud = document.getElementById("room")!
  let rosterKey = "", rosterSeen = new Set<number>(), rosterAt = 0, bytesAt = 0, bytesMark = 0
  function roster(now: number) {
    if (!(session instanceof OnlineSession) || now < rosterAt) return
    rosterAt = now + 250
    const rows = session.roster()
    const status = session.status()
    if (now - bytesMark > 2000) { debug.kbps = (session.bytesIn - bytesAt) / ((now - bytesMark) / 1000) / 1024; bytesAt = session.bytesIn; bytesMark = now }
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)
    const key = JSON.stringify([rows, status])
    if (key === rosterKey) return
    rosterKey = key
    roomHud.innerHTML = [`Room <b>${roomCode}</b>${status ? ` · ${esc(status)}` : ""}`, ...rows.map((r) => `<div class="${r.connected ? "" : "away"}">${esc(r.name)}${r.pid === session.me ? " (you)" : ""}${r.connected ? "" : " · dropped"}</div>`)].join("")
    const here = new Set(rows.filter((r) => r.connected).map((r) => r.pid))
    for (const r of rows) if (r.connected && !rosterSeen.has(r.pid) && r.pid !== session.me && rosterSeen.size) say(`${r.name} walked into camp.`, 3)
    rosterSeen = here
  }

  function loop(now: number) {
    if (paused) last = now
    else frame(now)
    requestAnimationFrame(loop)
  }

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const playing = active()
    time += dt

    // Settings that rebuild the world, debounced so a slider drag regenerates once.
    const key = `${settings.trunkDensity}`
    if (key !== worldKey) { worldKey = key; regenAt = now + 250 }
    if (regenAt && now > regenAt && !online) {
      regenAt = 0
      const pos = { x: session.self.x, z: session.self.z }
      useWorld(makeWorld({ trunkDensity: settings.trunkDensity }))
      const solo = new SoloSession(world, settings)
      solo.teleport(pos.x, pos.z)
      session = solo
    }
    if (shadowKey !== settings.trunkShadows) { shadowKey = settings.trunkShadows; lights.setBoxes(settings.trunkShadows ? view.occluders(world) : []) }

    const width = Math.max(1, Math.round(innerWidth * Math.min(devicePixelRatio, 1.5))), height = Math.max(1, Math.round(innerHeight * Math.min(devicePixelRatio, 1.5)))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; renderer.resize(width, height) }

    // Walk: fixed ticks of the shared sim (solo) or the room's prediction (online); a room keeps ticking while you're
    // on the start screen so friends still see you standing there.
    if (camera.flashlight !== prevLight) { prevLight = camera.flashlight; audio.play("flashlight.click") }
    acc = Math.min(acc + (playing || online ? dt : 0), 0.25)
    while (acc >= session.dt) {
      acc -= session.dt
      session.tick(intent())
    }
    session.frame(dt)
    const state = session.view, meId = session.me
    const at = session.drawn(Math.min(1, acc / session.dt))
    const vp = camera.place(at.x, at.z, standHeight(world, at.x, at.z) + EYE_HEIGHT, dt, width / height)
    if (playing) audio.steps(camera.walk.events, surfaceAt(at.x, at.z), camera.walk.time, settings.footsteps)
    roster(now)
    {
      for (const e of session.drain()) {
        const mine = "by" in e && e.by === meId
        if (e.kind === "tape-tied") audio.play("pack.close", e.x, e.z, mine ? 1 : 0.6)
        if (e.kind === "tape-removed") audio.play("pack.open", e.x, e.z, mine ? 1 : 0.6)
        if (e.kind === "marker-found" && mine) {
          audio.play("ui.ping")
          const n = session.self.map.markers.length
          say(n >= world.markers.length ? `Survey marker #${e.marker}. That's all ${n} on your map. Head back to camp — the mess hall light is on.` : `Survey marker #${e.marker} — pencilled onto your map. ${n} of ${world.markers.length}.`, 6)
        }
        if (e.kind === "marker-found" && !mine) say(`${nameOf(e.by)} found something. Look for their beam.`, 4)
        if (e.kind === "maps-compared" && (e.a === meId || e.b === meId)) {
          audio.play("ui.tick")
          say(`Compared maps with ${nameOf(e.a === meId ? e.b : e.a)}: their path and finds are on yours now.`, 4)
        }
        if (e.kind === "signal" && !mine) say(`${nameOf(e.by)} is signalling.`, 2.5)
        if (e.kind === "signal" && mine && state.players.length > 1) say("Friends reply and head your way.", 3)
      }
    }

    const p = session.self
    const level = beamLevel(p, state.t, settings)
    // Your beam: from the hand, along the view; down onto the sheet while the map is up.
    const look = viewDir(camera.yaw, camera.pitch)
    const reading = viewDir(camera.yaw, -1.05)
    const r = p.mapRaise
    const axis = look.map((v, i) => v + (reading[i]! - v) * r)
    const al = Math.hypot(axis[0]!, axis[1]!, axis[2]!)
    const ownAxis: [number, number, number] = [axis[0]! / al, axis[1]! / al, axis[2]! / al]
    const ownOrigin = handFrom(camera.eye, camera.yaw, look)

    fp.begin()
    view.draw(fp, world, state, state.t, camera.eye, settings)
    const beams = friends.frame(fp, world, state, meId, dt, (q) => beamLevel(q, state.t, settings), (q) => {
      const d = Math.hypot(q.x - at.x, q.z - at.z)
      if (d > 14 || !playing) return
      const pan = Math.max(-0.8, Math.min(0.8, ((q.x - at.x) * Math.cos(camera.yaw) - (q.z - at.z) * Math.sin(camera.yaw)) / Math.max(d, 1)))
      audio.steps([{ kind: "step", time: camera.walk.time, gain: 0.5 / (1 + d * d * 0.08), pan, seed: (state.t * 977) | 0 }], surfaceAt(q.x, q.z), camera.walk.time, settings.footsteps)
    })
    if (level > 0) beams.unshift({ id: OWN, origin: ownOrigin, axis: ownAxis })

    const place = view.lights(world, state.t, settings)
    const sceneLights: SceneLight[] = []
    const fogLamps: FogLamp[] = []
    const cone = fogCone(settings.flashCone, 0.45)
    for (const b of beams) {
      const q = b.id === OWN ? p : state.players.find((x) => x.id === b.id)!
      const k = beamLevel(q, state.t, settings)
      sceneLights.push({ id: b.id, x: b.origin[0], y: b.origin[2], h: b.origin[1], r: settings.flashReach, color: [0.86, 0.92, 1], power: settings.flashPower * k, size: 0.04, beam: { axis: b.axis, halfAngle: settings.flashCone }, unshadowed: !settings.trunkShadows })
      // Your own beam starts its haze a little ahead of you and fainter (`ownHaze`): in first person the near cone otherwise fills the view.
      fogLamps.push({ id: b.id, x: b.origin[0], y: b.origin[1], z: b.origin[2], range: settings.flashReach, color: [0.86, 0.92, 1], intensity: settings.flashPower * k * settings.beamHaze * (b.id === OWN ? settings.ownHaze : 1), axis: b.axis, ...cone, size: b.id === OWN ? 1.6 : 0.6, visibility: 1 })
    }
    debug.beams = beams.length; debug.fogLamps = fogLamps.length
    sceneLights.push(...place.scene)
    fogLamps.push(...place.fog)
    // Readability over physics: in-scatter falls off as 1/distance, so far beams vanish while a friend's beam beside
    // you floods the view. `beamPresence` evens that out (0 = physical).
    for (const l of fogLamps) {
      if (l.id === OWN) continue
      const d = Math.hypot(l.x - camera.eye[0], l.y - camera.eye[1], l.z - camera.eye[2])
      l.intensity *= Math.min(8, Math.max(0.02, (d / 12) ** settings.beamPresence))
    }
    lights.update(sceneLights, state.players.filter((q) => q !== p).map((q) => ({ x: q.x, y: q.z, r: 0.25, h: standHeight(world, q.x, q.z) + 1.8 })))

    Object.assign(fog.settings, { density: settings.mist, falloff: settings.mistFalloff, brightness: 0.0009 * settings.ambient, strength: 1, coneLength: settings.beamLength, bank: settings.mistBank > 0 && !smoke ? "drift" : "today", bankDensity: settings.mistBank, bankHeight: 3, bankScale: 14, bankWind: 0.35 })
    custom.set([1, TAPE_GAIN, settings.tapeShine, 0])
    renderer.setCustomUniforms(custom)
    packSceneFrame(frameData, { viewProj: vp, eye: camera.eye, time: state.t, width, height, lightCount: lights.lightCount, ambient: [0, 0, 0, 0], mapSize: [world.params.half * 2 + 40, world.params.half * 2 + 40], ao: 0 })
    const input: FrameInput = {
      frame: frameData, lights: lights.lights, lightCount: lights.lightCount, shadowLightCount: lights.shadowLightCount, occluders: lights.occ, occluderCount: lights.occCount,
      lampPower: lights.power, lampCount: 0, view: viewRect(camera.eye, camera.yaw, camera.pitch, camera.far, (camera.fov * Math.PI / 180) * (width / height)),
      batches: fp.batches(), alphaSprites: fp.alpha, alphaCount: fp.nAlpha, addSprites: fp.add, addCount: fp.nAdd, grade: [state.t, 0, 0, settings.exposure],
      fog: fog.update({ eye: camera.eye, viewProj: vp, lamps: fogLamps, time: state.t }), volume: [fog.volumeInput()],
    }
    debug.picked = fog.frame.lampCount; debug.lights = lights.lightCount
    renderer.render(input)

    // HUD: the tie prompt, the map, toasts.
    const target = playing && p.mapRaise < 0.3 ? tieTarget(world, p, settings.tapeReach) : null
    if (target) {
      const has = !!tapeOnTree(state, target.id)
      const progress = p.tie && p.tie.tree === target.id && keys.has("KeyE") ? p.tie.progress : 0
      prompt.innerHTML = keyPromptHtml("KeyE", has ? "Untie tape" : "Tie tape", { hold: true, progress })
    } else prompt.innerHTML = ""
    const campLight = Math.max(0, 1 - Math.hypot(at.x - world.camp.x, at.z - world.camp.z) / 30) * 0.5 * settings.campGlow
    map.frame(state, meId, p.mapRaise, camera.yaw, level * r + campLight + 0.04, camera.walk.lateral * 40, dt)
    if (performance.now() > toastUntil) toast.style.opacity = "0"
    audio.frame(at.x, at.z)

    frames++
    if (smoke && frames >= 2) paused = true
  }

  Object.assign(window, {
    woods: {
      get ready() { return true }, get frames() { return frames }, get paused() { return paused }, set paused(v: boolean) { paused = v },
      renderer, camera, settings, panel, map, debug,
      get state() { return session.view }, get world() { return world }, get session() { return session },
      /** Automation: room readout (your id, people and walkers seen, tapes, bytes in, KB/s, connection status). */
      get net() {
        const s = session
        return { online: s.online, me: s.me, status: s.status(), walkers: s.view.players.length, roster: s.roster(), tapes: s.view.tapes.map((t) => t.tree), found: s.view.found, bytesIn: s instanceof OnlineSession ? s.bytesIn : 0, kbps: debug.kbps, self: { x: s.self.x, z: s.self.z }, heard: s.self.map.heard.map((h) => h.from), markers: s.self.map.markers }
      },
      /** Automation: stand at (x, z) looking along yaw/pitch (solo); in a room only the look changes. */
      setPose(x: number, z: number, yaw: number, pitch = 0) { if (session instanceof SoloSession) session.teleport(x, z); camera.yaw = yaw; camera.pitch = pitch; camera.resetWalk() },
      /** Automation: walk to (x, z) with real inputs (works in a room). */
      walkTo(x: number, z: number) { autopilot = { x, z } },
      get walking() { return !!autopilot },
      /** Automation: look at (x, z). */
      face(x: number, z: number, pitch = 0) { const s = session.self; camera.yaw = Math.atan2(-(x - s.x), -(z - s.z)); camera.pitch = pitch },
      /** Automation: cut the room socket (it reconnects with the held seat). */
      drop() { if (session instanceof OnlineSession) session.drop() },
      /** Automation: hold or release a game key (KeyE, KeyG) without pointer lock. */
      hold(code: string, down: boolean) { if (down) keys.add(code); else keys.delete(code) },
      /** Automation: step the sim and draw `ms` later on a synthetic clock even without pointer lock. */
      step(ms: number) { const was = forcePlay; forcePlay = true; try { frame(last + ms) } finally { forcePlay = was } },
      /** Automation: play without pointer lock (the camera then takes no keyboard input; drive it with setPose). */
      set autoplay(v: boolean) { forcePlay = v; syncStart() },
      friend(id: number): Player | undefined { return session.view.players.find((p) => p.id === id) },
      /** Automation: a tape on tree `id`, knot facing (fx, fz) from the trunk. */
      addTape(id: number, fx = 0, fz = 1) {
        const t = world.trees[id], state = session.view
        if (!t || session.online || tapeOnTree(state, id)) return
        const tape = { id: state.nextTape++, tree: id, x: t.x, y: t.y + TAPE_HEIGHT, z: t.z, yaw: Math.atan2(fz, fx), by: 0, at: state.t }
        state.tapes.push(tape)
        session.self.map.tapes.push(tape.id)
      },
    },
  })
  requestAnimationFrame(loop)
}

void main().catch((e) => { console.error(e); document.getElementById("hud")!.textContent = String(e) })
