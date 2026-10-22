import { WalkCamera } from "@arcade/kit/client/walk-camera"
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
import { beamLevel, createWoods, EYE_HEIGHT, TAPE_HEIGHT, FEEL, setBotCount, stepWoods, tapeOnTree, tieTarget, viewDir, type Player, type PlayerInput, type WoodsState } from "../shared/sim"
import { dockAt, isDeepWater, lakeDistance, makeWorld, solidsNear, standHeight, trailDistance, type WoodsWorld } from "../shared/world"
import { WoodsAudio } from "./audio"
import { FEEL_CONTROLS } from "./feel-controls"
import { FriendsView } from "./friends-view"
import { PaperMap } from "./map"
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

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!
  const hud = document.getElementById("hud")!, prompt = document.getElementById("prompt")!, toast = document.getElementById("toast")!, start = document.getElementById("start")!
  const params = new URLSearchParams(location.search)
  const smoke = params.has("smoke")
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

  let world: WoodsWorld = makeWorld({ trunkDensity: settings.trunkDensity })
  let state: WoodsState = createWoods(world, settings.botCount)
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
  const camera = new WalkCamera(canvas, () => panel.visible, settings, active)
  camera.fov = 70; camera.near = 0.08; camera.far = 300; camera.flashlight = true
  const spawn = world.camp.spawn
  camera.body.x = spawn.x; camera.body.y = spawn.z; camera.yaw = spawn.yaw; camera.pitch = -0.05

  const panel = new LabPanel(settings, [...FEEL_CONTROLS, ...WALK_CONTROLS], params, () => { camera.release(); keys.clear() }, { open: false, pill: false, groupActions: false, onToggle: () => syncStart() })
  audio.bank.bindControls(panel)
  attachLabPanelControl(panel)
  let regenAt = 0, worldKey = `${settings.trunkDensity}`, shadowKey = settings.trunkShadows

  // Hold keys owned by the game (WASD, mouse and F live in the shared walking camera).
  const keys = new Set<string>()
  const release = () => keys.clear()
  window.addEventListener("keydown", (e) => {
    if (isEditableEventTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
    if (document.pointerLockElement !== canvas || panel.visible) return
    if (e.code === "KeyM" && !e.repeat) audio.bank.toggleMute()
    if (e.code === "KeyE" || e.code === "KeyG") { keys.add(e.code); e.preventDefault() }
  })
  window.addEventListener("keyup", (e) => { keys.delete(e.code); if (isMetaKey(e.code)) release() })
  window.addEventListener("blur", release)
  document.addEventListener("visibilitychange", () => { if (document.hidden) release() })
  function syncStart() { start.style.display = forcePlay || document.pointerLockElement === canvas || panel.visible ? "none" : "flex" }
  document.addEventListener("pointerlockchange", () => { release(); syncStart() })
  start.addEventListener("click", () => { if (!panel.visible) canvas.requestPointerLock() })

  const controlsHud = () => {
    hud.innerHTML = [keyPromptHtml("KeyW", "Walk"), keyPromptHtml("KeyF", "Flashlight"), keyPromptHtml("KeyE", "Tie tape", { hold: true }), keyPromptHtml("KeyG", "Map", { hold: true }), keyPromptHtml("KeyM", "Mute"), keyPromptHtml("Backquote", "Knobs")].join(" ")
  }
  controlsHud()
  onKeyLayoutChange(controlsHud)

  let toastUntil = 0
  const say = (text: string, seconds = 3.5) => { toast.textContent = text; toast.style.opacity = "1"; toastUntil = performance.now() + seconds * 1000 }
  say("Camp Tamarack, nightfall. Find the old survey markers in the woods.", 6)

  const nameOf = (id: number) => state.players.find((p) => p.id === id)?.name ?? "Someone"
  const me = () => state.players[0]!
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

  const DT = 1 / 60
  let acc = 0, last = performance.now(), time = 0, frames = 0, paused = false, prevLight = camera.flashlight
  const inputs = new Map<number, PlayerInput>()
  const debug = { beams: 0, fogLamps: 0, picked: 0, lights: 0 }

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
    if (regenAt && now > regenAt) {
      regenAt = 0
      const pos = { x: camera.body.x, z: camera.body.y }
      useWorld(makeWorld({ trunkDensity: settings.trunkDensity }))
      state = createWoods(world, settings.botCount)
      camera.body.x = pos.x; camera.body.y = pos.z
    }
    if (shadowKey !== settings.trunkShadows) { shadowKey = settings.trunkShadows; lights.setBoxes(settings.trunkShadows ? view.occluders(world) : []) }
    if (state.brains.length !== settings.botCount) setBotCount(state, world, settings.botCount)

    const width = Math.max(1, Math.round(innerWidth * Math.min(devicePixelRatio, 1.5))), height = Math.max(1, Math.round(innerHeight * Math.min(devicePixelRatio, 1.5)))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; renderer.resize(width, height) }

    // Walk: the shared camera moves you through the trunks; the ground and the lake decide where you stand.
    const p0 = me()
    camera.speed = settings.walkSpeed * (p0.mapRaise > 0.5 ? settings.mapWalk : 1)
    camera.height = standHeight(world, camera.body.x, camera.body.y) + EYE_HEIGHT
    const before = { x: camera.body.x, y: camera.body.y }
    const vp = camera.update(dt, width / height, solidsNear(world, camera.body.x, camera.body.y, 3))
    if (isDeepWater(world, camera.body.x, camera.body.y)) { camera.body.x = before.x; camera.body.y = before.y; camera.body.vx = camera.body.vy = 0 }
    if (playing) audio.steps(camera.walk.events, surfaceAt(camera.body.x, camera.body.y), camera.walk.time, settings.footsteps)
    if (camera.flashlight !== prevLight) { prevLight = camera.flashlight; audio.play("flashlight.click") }

    acc += playing ? dt : 0
    while (acc >= DT) {
      acc -= DT
      inputs.set(0, { yaw: camera.yaw, pitch: camera.pitch, light: camera.flashlight, tie: keys.has("KeyE"), map: keys.has("KeyG"), pos: { x: camera.body.x, z: camera.body.y, vx: camera.body.vx, vz: camera.body.vy } })
      stepWoods(state, world, inputs, DT, settings)
      for (const e of state.events) {
        const mine = "by" in e && e.by === 0
        if (e.kind === "tape-tied") audio.play("pack.close", e.x, e.z, mine ? 1 : 0.6)
        if (e.kind === "tape-removed") audio.play("pack.open", e.x, e.z, mine ? 1 : 0.6)
        if (e.kind === "marker-found" && mine) {
          audio.play("ui.ping")
          const n = me().map.markers.length
          say(n >= world.markers.length ? `Survey marker #${e.marker}. That's all ${n} on your map. Head back to camp — the mess hall light is on.` : `Survey marker #${e.marker} — pencilled onto your map. ${n} of ${world.markers.length}.`, 6)
        }
        if (e.kind === "marker-found" && !mine) say(`${nameOf(e.by)} found something. Look for their beam.`, 4)
        if (e.kind === "maps-compared" && (e.a === 0 || e.b === 0)) {
          audio.play("ui.tick")
          say(`Compared maps with ${nameOf(e.a === 0 ? e.b : e.a)}: their path and finds are on yours now.`, 4)
        }
        if (e.kind === "signal" && !mine) say(`${nameOf(e.by)} is signalling.`, 2.5)
        if (e.kind === "signal" && mine && state.players.length > 1) say("Friends reply and head your way.", 3)
      }
    }

    const p = me()
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
    const beams = friends.frame(fp, world, state, 0, dt, (q) => beamLevel(q, state.t, settings), (q) => {
      const d = Math.hypot(q.x - camera.body.x, q.z - camera.body.y)
      if (d > 14 || !playing) return
      const pan = Math.max(-0.8, Math.min(0.8, ((q.x - camera.body.x) * Math.cos(camera.yaw) - (q.z - camera.body.y) * Math.sin(camera.yaw)) / Math.max(d, 1)))
      audio.steps([{ kind: "step", time: camera.walk.time, gain: 0.5 / (1 + d * d * 0.08), pan, seed: (state.t * 977) | 0 }], surfaceAt(q.x, q.z), camera.walk.time, settings.footsteps)
    })
    if (level > 0) beams.unshift({ id: 0, origin: ownOrigin, axis: ownAxis })

    const place = view.lights(world, state.t, settings)
    const sceneLights: SceneLight[] = []
    const fogLamps: FogLamp[] = []
    const cone = fogCone(settings.flashCone, 0.45)
    for (const b of beams) {
      const q = state.players.find((x) => x.id === b.id)!
      const k = beamLevel(q, state.t, settings)
      sceneLights.push({ id: b.id, x: b.origin[0], y: b.origin[2], h: b.origin[1], r: settings.flashReach, color: [0.86, 0.92, 1], power: settings.flashPower * k, size: 0.04, beam: { axis: b.axis, halfAngle: settings.flashCone }, unshadowed: !settings.trunkShadows })
      // Your own beam starts its haze a little ahead of you and fainter (`ownHaze`): in first person the near cone otherwise fills the view.
      fogLamps.push({ id: b.id, x: b.origin[0], y: b.origin[1], z: b.origin[2], range: settings.flashReach, color: [0.86, 0.92, 1], intensity: settings.flashPower * k * settings.beamHaze * (b.id === 0 ? settings.ownHaze : 1), axis: b.axis, ...cone, size: b.id === 0 ? 1.6 : 0.6, visibility: 1 })
    }
    debug.beams = beams.length; debug.fogLamps = fogLamps.length
    sceneLights.push(...place.scene)
    fogLamps.push(...place.fog)
    // Readability over physics: in-scatter falls off as 1/distance, so far beams vanish while a friend's beam beside
    // you floods the view. `beamPresence` evens that out (0 = physical).
    for (const l of fogLamps) {
      if (l.id === 0) continue
      const d = Math.hypot(l.x - camera.eye[0], l.y - camera.eye[1], l.z - camera.eye[2])
      l.intensity *= Math.min(8, Math.max(0.02, (d / 12) ** settings.beamPresence))
    }
    lights.update(sceneLights, state.players.filter((q) => q.id !== 0).map((q) => ({ x: q.x, y: q.z, r: 0.25, h: standHeight(world, q.x, q.z) + 1.8 })))

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
    const campLight = Math.max(0, 1 - Math.hypot(camera.body.x - world.camp.x, camera.body.y - world.camp.z) / 30) * 0.5 * settings.campGlow
    map.frame(state, 0, p.mapRaise, camera.yaw, level * r + campLight + 0.04, camera.walk.lateral * 40, dt)
    if (performance.now() > toastUntil) toast.style.opacity = "0"
    audio.frame(camera.body.x, camera.body.y)

    frames++
    if (smoke && frames >= 2) paused = true
  }

  Object.assign(window, {
    woods: {
      get ready() { return true }, get frames() { return frames }, get paused() { return paused }, set paused(v: boolean) { paused = v },
      renderer, camera, settings, panel, map, debug,
      get state() { return state }, get world() { return world },
      /** Automation: stand at (x, z) looking along yaw/pitch. */
      setPose(x: number, z: number, yaw: number, pitch = 0) { camera.body.x = x; camera.body.y = z; camera.body.vx = camera.body.vy = 0; camera.yaw = yaw; camera.pitch = pitch; camera.resetWalk() },
      /** Automation: hold or release a game key (KeyE, KeyG) without pointer lock. */
      hold(code: string, down: boolean) { if (down) keys.add(code); else keys.delete(code) },
      /** Automation: step the sim and draw `ms` later on a synthetic clock even without pointer lock. */
      step(ms: number) { const was = forcePlay; forcePlay = true; try { frame(last + ms) } finally { forcePlay = was } },
      /** Automation: play without pointer lock (the camera then takes no keyboard input; drive it with setPose). */
      set autoplay(v: boolean) { forcePlay = v; syncStart() },
      friend(id: number): Player | undefined { return state.players.find((p) => p.id === id) },
      /** Automation: a tape on tree `id`, knot facing (fx, fz) from the trunk. */
      addTape(id: number, fx = 0, fz = 1) {
        const t = world.trees[id]
        if (!t || tapeOnTree(state, id)) return
        const tape = { id: state.nextTape++, tree: id, x: t.x, y: t.y + TAPE_HEIGHT, z: t.z, yaw: Math.atan2(fz, fx), by: 0, at: state.t }
        state.tapes.push(tape)
        me().map.tapes.push(tape.id)
      },
    },
  })
  requestAnimationFrame(loop)
}

void main().catch((e) => { console.error(e); document.getElementById("hud")!.textContent = String(e) })
