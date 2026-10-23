import { isEditableEventTarget, isMetaKey, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import type { FootSurface } from "@arcade/kit/audio/footsteps"
import { attachLabPanelControl } from "@arcade/kit/dev-control"
import { openGpu } from "@arcade/kit/gpu/boot"
import { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import { FOREST_QUALITY } from "@arcade/kit/forest/settings"
import { ForestStorm, forestRainLightControls, forestStormControls, forestStormEyeControls } from "@arcade/kit/forest/storm"
import type { ForestTorch } from "@arcade/kit/forest/view"
import { createGameShell, createShellQuality } from "@arcade/kit/shell"
import { planCreature, triggerCreature, trunkBetween, type CreatureEvent } from "../shared/creature"
import { answerCall, DISTANT_SOUNDS, MIMIC_LINES, triggerUncanny, UNCANNY_SOUNDS, type UncannySound } from "../shared/distant"
import { VOICE_LINES } from "../shared/lines.gen"
import { CLUE_NAMES, dawnShare, leadText, nextStep } from "../shared/night"
import { ROOM_CODE } from "../shared/protocol"
import { beamLevel, EYE_HEIGHT, TAPE_HEIGHT, FEEL, SIGNAL_HOLD_SECONDS, tapeOnTree, tieTarget, viewDir, type Player, type PlayerInput } from "../shared/sim"
import { dockAt, isDeepWater, lakeDistance, makeWorld, standHeight, trailDistance, type WoodsWorld } from "../shared/world"
import { WoodsAudio } from "./audio"
import { WoodsCamera } from "./camera"
import { CameraLook, stageCameraLab } from "./camera-look"
import { CreatureView } from "./creature-view"
import { FEEL_CONTROLS } from "./feel-controls"
import { FriendsView } from "./friends-view"
import { HeldMap, heldMapControls } from "./held-map"
import { arrangeControl, LOOKS_SECTION, SECTIONS } from "./knobs"
import { applyLook, lookBase, LOOK_IDS, LOOKS, type LookId } from "./looks"
import { PaperMap } from "./map"
import { OnlineSession, SoloSession, type Session } from "./session"
import { NightHud } from "./night-hud"
import { DawnSky, nightTapes, NightView } from "./night-view"
import { StoryHud } from "./story"
import { WorldView } from "./world-view"
import { createLakeEditor } from "@arcade/kit/water/lake-editor"
import { MOONLIT_LAKE } from "@arcade/kit/water/lake-preset"

/** Reduce camera motion is the shell's Settings row (one choice across games); `main` copies it in. */
const WALK = { cameraMotion: 1, reduceMotion: false, stepLength: 0.72, walkSettle: 0.3, footsteps: 0.9, landDip: 0.035 }
const WALK_CONTROLS: LabControl[] = [
  { key: "cameraMotion", label: "Head motion", min: 0, max: 1, step: 0.05, unit: "×", group: "Walking" },
  { key: "stepLength", label: "Step length", min: 0.45, max: 1.1, step: 0.01, unit: "m", group: "Walking" },
  { key: "walkSettle", label: "Start/stop spring", min: 0.1, max: 0.6, step: 0.01, unit: "s", group: "Walking" },
  { key: "footsteps", label: "Footsteps", min: 0, max: 2, step: 0.05, unit: "×", group: "Walking" },
  { key: "landDip", label: "Landing dip", min: 0, max: 0.08, step: 0.001, unit: "m", group: "Walking" },
]
/** Feel knobs the forest renderer's own look settings replace (its Flashlight, Mist, Night and Camera groups). */
const LOOK_KEYS = new Set(["flashReach", "flashCone", "flashPower", "beamHaze", "beamPresence", "ownHaze", "beamLength", "mist", "mistFalloff", "mistBank", "ambient", "exposure", "trunkShadows", "tapeShine"])
/** Your own beam's light id (friends and bots are never 0 in a room; solo you are 0). */
const OWN = 0
const controlsHtml = () => [keyPromptHtml("KeyW", "Walk"), keyPromptHtml("ShiftLeft", "Run", { hold: true }), keyPromptHtml("Space", "Jump"), keyPromptHtml("KeyF", "Flashlight"), keyPromptHtml("KeyE", "Tie tape", { hold: true }), keyPromptHtml("KeyG", "Map", { hold: true }), keyPromptHtml("KeyM", "Mute"), keyPromptHtml("Escape", "Menu")].join(" ")
const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "KeyE", "KeyG"])
/** Solo nights played in this browser: the next night's layout (`?night=` replays one). */
const NIGHT_KEY = "barbara.night"
/** A solo night's seed from its number (rooms seed theirs from the room code the same way). */
const nightSeed = (base: number, night: number) => (base + Math.imul(night, 7919)) >>> 0

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!
  const hud = document.getElementById("hud")!, prompt = document.getElementById("prompt")!, toast = document.getElementById("toast")!
  const params = new URLSearchParams(location.search)
  const smoke = params.has("smoke")
  const roomCode = (params.get("room") ?? "").toLowerCase()
  const online = ROOM_CODE.test(roomCode)
  const lakeLab = params.get("lab") === "water" && !online
  const audio = new WoodsAudio()
  const story = new StoryHud(audio)
  // Filled in once they exist; the shell reads them from its first frame.
  const live: { panel: LabPanel | null; session: Session | null; qualityChanged: () => void; editing: () => boolean; endCard: () => boolean } = { panel: null, session: null, qualityChanged: () => {}, editing: () => false, endCard: () => false }
  // Auto starts at High and steps down on slow frames only (frame time alone: the renderer's GPU reading counts CPU
  // encoding and queue waits, which demoted capable GPUs). Saved per game; `?quality=` pins a mode for automation.
  const quality = createShellQuality({ game: "barbara", tiers: FOREST_QUALITY, params, onChange: () => live.qualityChanged() })
  if (smoke) quality.setMode("low", false)
  const shell = createGameShell({
    game: "barbara", title: "BARBARA", subtitle: online ? "Your friends start at camp too" : "Camp Tamarack, November 1996. Her car is still in the lot.",
    soloLabel: "Play alone", soloNote: "you and three searchers", friendsNote: "a private room, up to 6", playLabel: "Step out of camp", resumeLabel: "Back to the woods", askName: true,
    channels: ["master", "effects", "ambience", "voice"], quality,
    sections: [{ id: "story", title: "Story", rows: [{ kind: "toggle", id: "subtitles", label: "Subtitles", get: () => story.subtitles, set: (on) => { story.subtitles = on; live.panel?.sync() } }] }],
    // The Lab panel stays open while you play (capture "focus"); while it shows, the title and menu stay out of the way.
    pointerLock: canvas, blocked: () => (live.panel?.visible ?? false) || live.editing() || live.endCard(), keysBlocked: () => live.panel?.hasFocus() ?? false,
    loading: smoke ? false : { gpu: 1, world: 4, frame: 1 }, controls: controlsHtml,
    lobby: {
      friends: true,
      // Solo plays the session that's already running; a room is its own page (`?room=`), so joining loads it.
      onSolo: () => {},
      onJoin: (room) => { if (room !== roomCode) location.search = `?room=${room}` },
      onLeaveRoom: () => location.replace(location.pathname),
      onRename: (name) => { if (live.session instanceof OnlineSession) live.session.rename(name) },
    },
  })
  if (online) shell.lobby!.setRoom(roomCode)
  // The shell owns volume, mute and reduce camera motion; the sound bank and the walk read them.
  const syncSound = () => {
    Object.assign(audio.bank.volumes, shell.settings.volumes)
    if (audio.bank.muted !== shell.settings.muted) audio.bank.setMuted(shell.settings.muted)
    audio.bank.applyVolumes()
  }
  syncSound()
  // Nothing sounds before Begin: Play, Resume, a click outside the pause card, or a click on the woods.
  shell.view?.root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act
    if (act === "play" || act === "solo" || act === "resume" || t.classList.contains("as-overlay")) audio.begin()
  }, { capture: true })
  shell.loading?.stage("gpu", "Starting the GPU")
  const gpu = await openGpu(canvas, "BARBARA")
  if (typeof gpu === "string") { hud.textContent = gpu; shell.loading?.fail(gpu); return }
  shell.loading?.done("gpu")
  performance.mark("woods:gpu")
  const { device } = gpu
  const canvasFormat = gpu.format
  const settings = { ...FEEL, ...WALK, reduceMotion: shell.settings.reduceMotion }
  if (smoke) Object.assign(settings, { trunkDensity: 1, botCount: 1 })

  // A room walks the printed forest (default params) so everyone and the server share it; solo follows the knobs.
  let world: WoodsWorld = online ? makeWorld() : makeWorld({ trunkDensity: settings.trunkDensity })
  shell.loading?.stage("world", "Growing the woods")
  const view = await WorldView.create(gpu, world, { smoke, quality: quality.tier })
  shell.loading?.done("world")
  shell.loading?.stage("frame", "Lighting the camp")
  const renderer = view.renderer
  live.qualityChanged = () => { view.forest.setQuality(quality.tier); shell.settings.changed() }
  // Realistic friends by default; the blocky ones are one setting away (Lab › Friends, or `?people=blocky`). The
  // software-GPU smoke draws blocky friends.
  const friends = new FriendsView(renderer, !smoke && params.get("people") !== "blocky")
  const creatures = new CreatureView(renderer)
  if (params.get("smooth") === "0") friends.smooth = false
  const map = new PaperMap(document.body)
  const held = new HeldMap(renderer, import.meta.env.BASE_URL, undefined, !smoke)
  const fp = new FrameParts()
  const nightView = new NightView(renderer)
  const dawn = new DawnSky()

  // Solo: this browser's next night, or the one `?night=N` names (the end card's "Night N"; the same N is the same night).
  // `night` counts from 0.
  const pinned = params.get("night")
  let night = pinned !== null && Number.isFinite(Number(pinned)) ? Math.max(1, Math.floor(Number(pinned))) - 1 : Number(localStorage.getItem(NIGHT_KEY)) || 0
  let session: Session = online ? new OnlineSession(world, roomCode, shell.lobby!.playName) : new SoloSession(world, settings, nightSeed(world.params.seed, night))
  live.session = session
  const useWorld = (w: WoodsWorld, rebuild = true) => {
    world = w
    if (rebuild) view.setWorld(world)
    friends.setLogs(view.forest.build.logs, (x, z) => standHeight(world, x, z))
    map.setWorld(world)
    held.setWorld(world)
  }
  useWorld(world, false)
  performance.mark("woods:world")

  let forcePlay = false
  // The Lab panel stays open while you play (capture "focus"): it takes keys only while it has focus, and a click on the
  // woods hands input back and locks.
  const locked = () => document.pointerLockElement === canvas
  const active = () => forcePlay || (locked() && !document.hidden)
  let lakeEditor: ReturnType<typeof createLakeEditor> | undefined
  const camera = new WoodsCamera(canvas, () => lakeEditor?.state.mode === "edit", settings, active)
  camera.fov = 70; camera.near = 0.08; camera.far = 300; camera.flashlight = true
  const spawn = world.camp.spawn
  camera.yaw = spawn.yaw; camera.pitch = -0.05

  // The storm over the woods (kit weather in the forest renderer): lightning, rain, wet surfaces, storm wind, the eye
  // after a flash. Still and dry until a Look or a knob asks for it.
  const storm = new ForestStorm({}, world.params.seed)
  // Sections with sub-headings, all folded but Looks & Triggers (`src/knobs.ts` places every subsystem's rows).
  const panel = new LabPanel(settings, [...FEEL_CONTROLS.filter((c) => !LOOK_KEYS.has(c.field ?? c.key)), ...WALK_CONTROLS], params, () => { camera.release(); keys.clear() }, { open: false, pill: false, groupActions: false, capture: "focus", openGroups: [lakeLab ? "Camp" : LOOKS_SECTION], arrange: arrangeControl, onToggle: () => syncOverlays() })
  live.panel = panel
  panel.addControls(view.forest.settings as unknown as Record<string, number | string | boolean>, view.forest.controls())
  if (lakeLab) {
    Object.assign(view.forest.settings, MOONLIT_LAKE)
    if (params.get("waterLook") === "today") view.forest.settings.lakeLook = "today"
    const dock = world.buildings.find(b => b.kind === "dock")
    const start = dock ? { x: (dock.rect[0] + dock.rect[2]) / 2, z: dock.rect[3] - 2 }
      : { x: world.lake.x, z: world.lake.z - world.lake.rz - 1 }
    lakeEditor = createLakeEditor(canvas, view.forest, camera, world.lake, start)
    // Edit owns the mouse for dragging the log: no title, pause card or pointer lock while it's on.
    live.editing = () => lakeEditor?.state.mode === "edit"
    if (session instanceof SoloSession) session.teleport(start.x, start.z)
    camera.yaw = Math.PI; camera.pitch = -0.18
    forcePlay = true
    panel.addControls(lakeEditor.state, [
      { key: "lakeInteraction", field: "mode", label: "Log", group: "Water", type: "select", options: [{ value: "edit", label: "Edit" }, { value: "play", label: "Play" }], change: () => { lakeEditor?.stop(); keys.clear(); camera.release(); syncOverlays() } },
      { key: "lakeTorch", field: "torch", label: "Torch", group: "Water", type: "toggle", change: () => { camera.flashlight = lakeEditor!.state.torch } },
    ])
  }
  panel.addControls(friends as unknown as Record<string, boolean>, [
    { key: "woods.realisticPeople", field: "realistic", label: "Realistic people", group: "Friends", subsection: "Drawing", type: "toggle" },
    { key: "woods.smoothFriends", field: "smooth", label: "Smooth friends", group: "Friends", subsection: "Drawing", type: "toggle" },
    { key: "woods.beamSettle", field: "beamSettle", label: "Friend beam settle", group: "Friends", subsection: "Drawing", min: 0.02, max: 0.4, step: 0.01, unit: "s" },
  ])
  panel.addControls({}, [{ key: "creatureTrigger", label: "Trigger now", group: "Creature", type: "action", run: () => { creature.trigger() } }])
  panel.addControls({}, UNCANNY_SOUNDS.map((s) => ({ key: `uncanny.${s}`, label: `Trigger ${s.slice(4)}`, group: "Sound", subsection: "Uncanny", type: "action" as const, run: () => { void uncanny.trigger(s) } })))
  panel.addControls(storm.settings as unknown as Record<string, number | string | boolean>, forestStormControls("Weather", "woods.storm."))
  panel.addControls(storm.rainLighting as unknown as Record<string, number | string | boolean>, forestRainLightControls("Weather", "woods.rainLight."))
  panel.addControls(storm.eye as unknown as Record<string, number | string | boolean>, forestStormEyeControls("Weather", "woods.eye."))
  panel.addControls(held.settings as unknown as Record<string, number | string | boolean>, heldMapControls())
  // Camera looks and realism effects (Lab › Camera look): a post chain after the forest's own camera, all off by default.
  const cameraLook = new CameraLook({ renderer, device, format: canvasFormat, camera, forest: view.forest, panel, params, smoke, seed: world.params.seed })
  audio.bindControls(panel)
  story.bindControls(panel)
  story.onChange = () => shell.settings.changed()
  // Looks: curated bundles of sky, fog, light, weather and exposure (`src/looks.ts`); Today is the game as shipped.
  type Bag = Record<string, unknown>
  const lookTargets = { forest: view.forest.settings as unknown as Bag, storm: storm.settings as unknown as Bag, feel: settings as unknown as Bag }
  const todayLook = lookBase(lookTargets)
  const lookState = { look: "today" as LookId }
  const pickLook = (id: LookId) => {
    if (!LOOKS[id]) return
    lookState.look = id
    applyLook(id, lookTargets, todayLook)
    panel.sync()
  }
  // Triggers: everything the storm and the woods can do, now. A click is a gesture, so the sound can start too.
  const trigger = (what: string) => {
    audio.begin()
    if (what === "near" || what === "mid" || what === "far") storm.strike(what)
    else if (what === "thunder") storm.thunder()
    else if (what === "gust") storm.gust()
    else if (what === "creature") creature.trigger()
    else if (what === "distant") void audio.auditionNow(DISTANT_SOUNDS[Math.floor(Math.random() * DISTANT_SOUNDS.length)]!)
  }
  panel.addControls(lookState as unknown as Bag as Record<string, string>, [
    { key: "woods.look", field: "look", label: "Look", group: LOOKS_SECTION, type: "select", options: LOOK_IDS.map((id) => ({ value: id, label: LOOKS[id].label })), change: (v) => pickLook(String(v) as LookId) },
    { key: "woods.lookNote", label: "This look", group: LOOKS_SECTION, type: "readout", read: () => LOOKS[lookState.look].note },
    { key: "woods.triggers.lightning", label: "Lightning strike", group: LOOKS_SECTION, type: "buttons", items: (["near", "mid", "far"] as const).map((d) => ({ key: `woods.trigger.${d}`, label: d === "near" ? "Near" : d === "mid" ? "Mid" : "Far", run: () => trigger(d) })) },
    { key: "woods.triggers.sound", label: "Sounds", group: LOOKS_SECTION, type: "buttons", items: [{ key: "woods.trigger.thunder", label: "Thunder only", run: () => trigger("thunder") }, { key: "woods.trigger.distant", label: "A distant sound", run: () => trigger("distant") }] },
    { key: "woods.triggers.woods", label: "In the woods", group: LOOKS_SECTION, type: "buttons", items: [{ key: "woods.trigger.gust", label: "A gust", run: () => trigger("gust") }, { key: "woods.trigger.creature", label: "The creature", run: () => trigger("creature") }] },
  ])
  const askedLook = params.get("look") ?? lookState.look
  if (askedLook !== "today" && askedLook in LOOKS) pickLook(askedLook as LookId)
  panel.setView({ order: SECTIONS })
  attachLabPanelControl(panel)
  shell.settings.subscribe(() => { syncSound(); settings.reduceMotion = shell.settings.reduceMotion; panel.sync() })
  let regenAt = 0, worldKey = `${settings.trunkDensity}`

  // Held keys the game reads (walking, tie, map); mouse look and F live in the shared camera. M (mute) and Escape
  // (the menu) are the shell's.
  const keys = new Set<string>()
  let jumpPressed = false, poseVersion = 0
  const release = () => { keys.clear(); jumpPressed = false }
  window.addEventListener("keydown", (e) => {
    if (isEditableEventTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
    if (!locked()) return
    // Tab brings the end card back once a night is over.
    if (e.code === "Tab") { e.preventDefault(); if (endCard.canShow(session.view.night)) endCard.show(); return }
    if (e.code === "Space") { if (!e.repeat) jumpPressed = true; e.preventDefault() }
    if (MOVE_KEYS.has(e.code)) { keys.add(e.code); e.preventDefault() }
  })
  window.addEventListener("keyup", (e) => { keys.delete(e.code); if (isMetaKey(e.code)) release() })
  window.addEventListener("blur", release)
  document.addEventListener("visibilitychange", () => { if (document.hidden) release() })
  // With the Lab panel open the shell's cards stay hidden, so you can tune while looking at the woods; a click on them
  // plays again.
  const tuning = document.getElementById("tuning")!
  function syncOverlays() {
    const free = !forcePlay && !locked()
    tuning.hidden = !free || !panel.visible
    tuning.innerHTML = `Click the woods to play with the knobs open · ${keyPromptHtml("Backquote", "Hide knobs")}`
    shell.flow.changed()
  }
  document.addEventListener("pointerlockchange", () => {
    release()
    syncOverlays()
  })
  canvas.addEventListener("click", () => { if (!lakeLab) audio.begin() })
  syncOverlays()
  if (lakeLab && !panel.visible) panel.toggle()

  const controlsHud = () => { hud.innerHTML = `${controlsHtml()} ${keyPromptHtml("Backquote", "Knobs")}` }
  controlsHud()
  onKeyLayoutChange(controlsHud)

  const goal = document.getElementById("goal")!, goalText = goal.querySelector("span")!
  let goalAt = 0
  let toastUntil = 0
  const say = (text: string, seconds = 3.5) => { toast.textContent = text; toast.style.opacity = "1"; toastUntil = performance.now() + seconds * 1000 }
  if (online) say(`Room ${roomCode}: your friends start at camp too.`, 6)

  const nameOf = (id: number) => session.view.players.find((p) => p.id === id)?.name ?? "Someone"

  /** The next night: a room starts it for everyone; solo, the next layout from camp. */
  function nextNight() {
    if (session instanceof OnlineSession) session.again()
    else {
      night++
      if (pinned === null) localStorage.setItem(NIGHT_KEY, String(night))
      session = new SoloSession(world, settings, nightSeed(world.params.seed, night))
      live.session = session
      camera.yaw = world.camp.spawn.yaw; camera.pitch = -0.05; camera.resetWalk()
    }
  }
  // A new night's seed, whoever started it (in a room, any friend's Search again): the opening plays again.
  let storySeed = NaN
  const endCard = new NightHud({
    again: () => { nextNight(); shell.flow.resume() },
    resume: () => shell.flow.resume(),
    release: () => { if (document.pointerLockElement) document.exitPointerLock(); release(); shell.flow.changed() },
  })
  live.endCard = () => endCard.visible
  // Your torch: in the right hand, low, a quarter metre ahead of the eye (the look's Hand settings).
  const handFrom = (eye: readonly number[], yaw: number, d: readonly number[]): [number, number, number] => {
    const s = view.forest.settings, rx = Math.cos(yaw), rz = -Math.sin(yaw)
    return [eye[0]! + rx * s.torchSide + d[0]! * 0.25, eye[1]! - s.torchDrop, eye[2]! + rz * s.torchSide + d[2]! * 0.25]
  }
  /** The beam trails the view by the hand's lag (s). */
  const lagged: [number, number, number] = [0, 0, -1]
  let laggedReady = false
  const surfaceAt = (x: number, z: number): FootSurface => {
    if (dockAt(world, x, z)) return "wood"
    if (lakeDistance(world.lake, x, z) < 1.02) return "puddle"
    if (Math.hypot(x - world.camp.x, z - world.camp.z) < world.camp.radius * 0.7) return "dirt"
    return trailDistance(world.trail, x, z).d < 1.6 ? "dirt" : "grass"
  }

  let acc = 0, last = performance.now(), time = 0, frames = 0, paused = false, prevLight = camera.flashlight, ownLevel = 1
  /** `dark`: player ids whose torches aren't drawn (captures that count lights; presentation only). */
  const debug = { beams: 0, kbps: 0, dark: [] as number[] }
  let stepping = false, smokeTarget: GPUTexture | null = null
  /** Automation: every friend's drawn position, beam axis and level per drawn frame (`woods.trace`). */
  let trace: { now: number; id: number; x: number; z: number; yaw: number; axis: [number, number, number] | null; level: number }[] | null = null
  /** Automation: walk towards a point (cleared on arrival). */
  let autopilot: { x: number; z: number } | null = null

  /** This tick's controls: WASD relative to where you look, the light, the held tie and map keys. */
  function intent(): PlayerInput {
    if (lakeEditor?.state.mode === "edit") return { yaw: camera.yaw, pitch: camera.pitch, light: lakeEditor.state.torch, tie: false, map: false, mx: 0, mz: 0, sprint: false }
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
    const jump = jumpPressed
    jumpPressed = false
    return { yaw: camera.yaw, pitch: camera.pitch, light: camera.flashlight, tie: keys.has("KeyE"), map: keys.has("KeyG"), mx, mz, sprint: !!k("ShiftLeft", "ShiftRight"), jump }
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
    shell.lobby!.setPlayers(rows.map((r) => ({ id: String(r.pid), name: r.name, you: r.pid === session.me, away: !r.connected })))
    shell.lobby!.setSocketStatus(status)
    roomHud.innerHTML = [`Room <b>${roomCode}</b>${status ? ` · ${esc(status)}` : ""}`, ...rows.map((r) => `<div class="${r.connected ? "" : "away"}">${esc(r.name)}${r.pid === session.me ? " (you)" : ""}${r.connected ? "" : " · dropped"}</div>`)].join("")
    const here = new Set(rows.filter((r) => r.connected).map((r) => r.pid))
    for (const r of rows) if (r.connected && !rosterSeen.has(r.pid) && r.pid !== session.me && rosterSeen.size) say(`${r.name} walked into camp.`, 3)
    rosterSeen = here
  }

  /**
   * The uncanny tier's Lab triggers: solo, placed by the schedule's own rules in the sim (the mimic: a searcher calls
   * from 70–110 m ahead and the sim's mimic answers); in a room, this machine only, placed around you (no mimic).
   */
  const uncanny = {
    call: 0,
    async trigger(sound: UncannySound): Promise<void> {
      if (!(await audio.prepare())) return
      if (!(session instanceof SoloSession)) {
        if (sound === "far.mimic") { say("The mimic answers a searcher's call; trigger it playing alone.", 4); return }
        audio.audition(sound)
        return
      }
      const st = session.state, people = st.players.filter((p) => !p.bot)
      if (sound !== "far.mimic") { const e = triggerUncanny(st.distant, world, people, sound, st.t); if (e) session.inject(e); return }
      const line = VOICE_LINES.find((l) => l.id === MIMIC_LINES[uncanny.call++ % MIMIC_LINES.length])!
      const me = session.self, h = world.params.half - 8
      for (const [off, d] of [[0.5, 90], [0.3, 80], [0.7, 100], [-0.5, 90], [0, 110], [1, 70]] as const) {
        const yaw = camera.yaw + off, x = me.x - Math.sin(yaw) * d, z = me.z - Math.cos(yaw) * d
        if (Math.abs(x) > h || Math.abs(z) > h || isDeepWater(world, x, z)) continue
        session.inject({ kind: "voice", line: line.id, cast: line.cast, by: -1, x, y: standHeight(world, x, z) + 1.6, z, at: st.t, seq: -1 })
        if (answerCall(st.distant, world, people, line.id, { x, z }, line.seconds, st.t, settings, true)) say(`${line.text} … and an answer.`, 3)
        return
      }
    },
  }

  /**
   * The creature's Lab hooks. Trigger now places a sighting at once by the schedule's own rules (solo: in the sim, so it
   * plays like a scheduled one; a room: on this machine only). With no bright light 49 m out to cross (a friend's signal or
   * beam aimed back at you, camp lights from outside camp), solo stages one: a friend 64–96 m ahead holding up a
   * signal, and it triggers a second later.
   */
  const creature = {
    stageAt: 0,
    last: null as CreatureEvent | null,
    trigger(): CreatureEvent | null {
      const state = session instanceof SoloSession ? session.state : session.view
      let e: CreatureEvent | null = null
      if (session instanceof SoloSession) {
        e = triggerCreature(session.state.distant, world, session.state.players, session.state.t, settings, SIGNAL_HOLD_SECONDS)
        if (e) session.inject(e)
      } else {
        const plan = planCreature(world, state.players.map((p) => (p.id === session.me ? { ...p, yaw: camera.yaw, pitch: camera.pitch } : p)), settings, { seed: (time * 1000) | 0 }, SIGNAL_HOLD_SECONDS, true)
        if (plan) { e = { kind: "creature", at: state.t, x0: plan.x0, z0: plan.z0, x1: plan.x1, z1: plan.z1, dur: plan.dur, seed: plan.seed, seq: -1 }; creatures.start(e, time); audio.event(e) }
      }
      if (e) { creature.last = e; return e }
      if (session instanceof SoloSession && !creature.stageAt && creature.stage()) { creature.stageAt = time + 1.2; say("A friend's light, far ahead…", 2); return null }
      say("Nothing for it to cross: it needs a friend's signal or beam aimed at you, or camp lights from outside camp, 49 m or more away in sight.", 5)
      return null
    },
    /** Solo: a friend 64–96 m ahead in sight (farther first, so it cuts more of the shaft) holding up a signal. */
    stage(): boolean {
      if (!(session instanceof SoloSession)) return false
      const st = session.state, me = session.self
      const brain = st.brains[0], bot = brain && st.players.find((p) => p.id === brain.id)
      if (!brain || !bot) return false
      for (const off of [0, 0.08, -0.08, 0.16, -0.16, 0.25, -0.25, 0.35, -0.35]) for (const d of [88, 80, 96, 72, 64]) {
        const yaw = camera.yaw + off, x = me.x - Math.sin(yaw) * d, z = me.z - Math.cos(yaw) * d
        const h = world.params.half - 8
        if (Math.abs(x) > h || Math.abs(z) > h || isDeepWater(world, x, z) || trunkBetween(world, me.x, me.z, x, z, 0.3)) continue
        // A signal: the brightest backdrop a friend makes, held about ten seconds ("found" lifts the beam while its timer is over 8).
        Object.assign(bot, { x, z, vx: 0, vz: 0, light: true })
        brain.mode = "found"; brain.timer = 18
        return true
      }
      return false
    },
    frame() {
      if (creature.stageAt && time >= creature.stageAt) { creature.stageAt = 0; creature.trigger() }
    },
  }

  function loop(now: number) {
    if (paused) last = now
    else frame(now)
    requestAnimationFrame(loop)
  }

  function frame(now: number) {
    const frameMs = now - last
    const dt = Math.min(0.05, frameMs / 1000)
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
      const solo = new SoloSession(world, settings, nightSeed(world.params.seed, night))
      solo.teleport(pos.x, pos.z)
      session = solo
      live.session = session
    }
    shell.tick(now)
    // Only play is the game's real load (not the title, the menu or a synthetic automation clock).
    if (!smoke && playing && !stepping) quality.frame(now); else quality.pause()
    if (quality.fit(canvas, innerWidth, innerHeight)) view.forest.resize(canvas.width, canvas.height)
    const width = canvas.width, height = canvas.height

    // Walk: fixed ticks of the shared sim (solo) or the room's prediction (online); a room keeps ticking while you're
    // on the start screen so friends still see you standing there.
    if (camera.flashlight !== prevLight) { prevLight = camera.flashlight; audio.play("flashlight.click") }
    if (session instanceof OnlineSession && poseVersion !== session.poseVersion) {
      poseVersion = session.poseVersion
      camera.yaw = session.self.yaw; camera.pitch = session.self.pitch; camera.flashlight = session.self.light
      camera.resetWalk(); release(); acc = 0
    }
    acc = Math.min(acc + (playing || online ? dt : 0), 0.25)
    while (acc >= session.dt) {
      acc -= session.dt
      session.tick(intent())
    }
    const alpha = Math.min(1, acc / session.dt)
    if (session instanceof SoloSession) session.smooth = friends.smooth
    session.frame(dt, alpha)
    const state = session.view, meId = session.me
    const at = session.drawn(alpha)
    const vp = camera.place(at.x, at.z, standHeight(world, at.x, at.z) + EYE_HEIGHT, dt, width / height, at.y)
    if (playing) audio.steps(camera.walk.events, surfaceAt(at.x, at.z), camera.walk.time, settings.footsteps)
    roster(now)
    {
      for (const e of session.drain()) {
        if (e.kind === "creature") { creatures.start(e, time, state.t - e.at); audio.event(e); continue }
        audio.event(e)
        if (e.kind === "distant") cameraLook.event(e)
        const mine = "by" in e && e.by === meId
        if (e.kind === "tape-tied") audio.play("pack.close", e.x, e.z, mine ? 1 : 0.6)
        if (e.kind === "tape-removed") audio.play("pack.open", e.x, e.z, mine ? 1 : 0.6)
        if (e.kind === "marker-found" && mine) say(`Survey marker #${e.marker}, pencilled onto your map.`, 3)
        // A clue: everyone hears who found what; only the finder reads what it says (it goes on their map alone).
        if (e.kind === "clue-found") {
          const clue = state.night.layout.clues[e.clue]
          if (mine && clue) { audio.play("ui.ping"); say(`You found ${CLUE_NAMES[e.what]}. ${leadText(clue)} It's on your map.`, 9) }
          else say(`${nameOf(e.by)} found ${CLUE_NAMES[e.what]}.${e.what === "strip" ? "" : e.what === "cassette" ? " Ask them what's on it." : " Ask them where it points."}`, 5)
        }
        if (e.kind === "spare-taken" && mine) { audio.play("pack.open"); say("A spare battery, in your pocket. It goes in when your torch dies.", 4) }
        if (e.kind === "torch" && mine) {
          if (e.state === "low") say("Your torch is starting to dim.", 3)
          if (e.state === "swap") { audio.play("pack.open"); say("Fumbling the spare battery in…", 3) }
          if (e.state === "fresh") { audio.play("flashlight.click"); say("Fresh battery.", 2) }
          if (e.state === "dead") say(session.self.spare ? "Your torch died." : "Your torch is dead. Stay close to someone with a light, or find a spare.", 5)
        }
        // The tape's job, taught once as the search starts.
        if (e.kind === "night" && e.phase === "search") say("Tie tape on trunks where you've searched (hold E). The debrief maps the ground your tape covered.", 8)
        if (e.kind === "night" && (e.phase === "won" || e.phase === "lost")) {
          endCard.ended(e.debrief, e.phase === "won")
          if (!online && pinned === null) localStorage.setItem(NIGHT_KEY, String(night + 1))
        }
        if (e.kind === "maps-compared" && (e.a === meId || e.b === meId)) {
          audio.play("ui.tick")
          say(`Compared maps with ${nameOf(e.a === meId ? e.b : e.a)}: their path and finds are on yours now.`, 4)
        }
        if (e.kind === "signal" && !mine) say(`${nameOf(e.by)} is signalling.`, 2.5)
        if (e.kind === "signal" && mine && state.players.length > 1) say("Friends reply and head your way.", 3)
      }
    }

    const p = session.self
    // The held map and compass (Map style: Held): its hands follow the raise; while up, your torch is the one in its
    // right glove, aimed at the sheet, on its low setting.
    held.tier = quality.tier
    // The props follow the rendered view, so a body camera's mount turns them with it.
    const mount = camera.mount
    held.frame({ state, me: meId, raise: p.mapRaise, eye: camera.eye, yaw: camera.yaw + mount.yaw, pitch: Math.max(-1.5, Math.min(1.5, camera.pitch + mount.pitch)), roll: camera.walk.roll + mount.roll, aspect: width / height, dt, time, walk: camera.walk })
    const heldTorch = held.held ? held.torch() : null
    const heldUp = heldTorch ? held.raiseShare : 0
    // Brightness on the page's own clock: the tick or snapshot time would step a flicker into a strobe.
    const level = beamLevel(p, time, settings) * (heldTorch ? Math.pow(held.settings.readingLevel, held.dimShare) : 1)
    ownLevel += (level - ownLevel) * (1 - Math.exp(-dt / 0.04))
    // Your beam: from the hand, along the view; down onto the sheet while the map is up.
    const lookDir = viewDir(camera.yaw, camera.pitch)
    const reading = viewDir(camera.yaw, -1.05)
    const r = p.mapRaise
    const axis = lookDir.map((v, i) => v + (reading[i]! - v) * (held.held ? 0 : r))
    const k = laggedReady ? 1 - Math.exp(-dt / Math.max(view.forest.settings.torchLag, 0.001)) : 1
    laggedReady = true
    for (let i = 0; i < 3; i++) lagged[i] = lagged[i]! + (axis[i]! - lagged[i]!) * k
    const al = Math.hypot(lagged[0], lagged[1], lagged[2]) || 1
    let ownAxis: [number, number, number] = [lagged[0] / al, lagged[1] / al, lagged[2] / al]
    // The hand stays where it is when a body camera hangs the view lower.
    let ownOrigin = handFrom([camera.eye[0], camera.eye[1] - camera.mount.height, camera.eye[2]], camera.yaw, lookDir)
    if (heldTorch) {
      const mixed = ownAxis.map((v, i) => v + (heldTorch.axis[i]! - v) * heldUp), ml = Math.hypot(mixed[0]!, mixed[1]!, mixed[2]!) || 1
      ownAxis = [mixed[0]! / ml, mixed[1]! / ml, mixed[2]! / ml]
      ownOrigin = ownOrigin.map((v, i) => v + (heldTorch.origin[i]! - v) * heldUp) as [number, number, number]
    }

    fp.begin()
    lakeEditor?.draw(fp, state.t)
    // The extra searcher's strip on the ridge is drawn as a tape like the team's own.
    const strip = nightTapes(state.night, world)
    view.draw(fp, world, strip.length ? { ...state, tapes: [...state.tapes, ...strip] } : state, state.t, camera.eye, settings)
    nightView.draw(fp, state.night, world)
    dawn.apply(view.forest.settings, dawnShare(state.night, state.t))
    friends.eye = [camera.eye[0], camera.eye[1], camera.eye[2]]
    const beams = friends.frame(fp, world, state, meId, dt, (q) => beamLevel(q, time, settings), (q) => {
      const d = Math.hypot(q.x - at.x, q.z - at.z)
      if (d > 14 || !playing) return
      const pan = Math.max(-0.8, Math.min(0.8, ((q.x - at.x) * Math.cos(camera.yaw) - (q.z - at.z) * Math.sin(camera.yaw)) / Math.max(d, 1)))
      audio.steps([{ kind: "step", time: camera.walk.time, gain: 0.5 / (1 + d * d * 0.08), pan, seed: (state.t * 977) | 0 }], surfaceAt(q.x, q.z), camera.walk.time, settings.footsteps)
    })
    if (level > 0) beams.unshift({ id: OWN, origin: ownOrigin, axis: ownAxis, level: ownLevel })

    const place = view.lights(world, state.t, settings)
    // Every torch is a photometric beam: the forest renderer lights, shadows and scatters it (your own gets the
    // shadow map, the exposure and the bounce).
    const torches: ForestTorch[] = beams.filter((b) => !debug.dark.includes(b.id === OWN ? meId : b.id)).map((b) => ({ id: b.id, pos: b.origin, dir: b.axis, on: true, kind: b.id === OWN ? "local" : "remote", level: b.level, ...(b.id === OWN && heldUp > 0.3 ? { shadowNear: 0.04 } : {}) }))
    debug.beams = beams.length
    cameraLook.frame({ t: state.t, dt, eye: camera.eye, yaw: camera.yaw, pitch: camera.pitch, torches, world, fp, place })
    if (trace) {
      const at = performance.now()
      for (const q of state.players) {
        if (q.id === meId) continue
        const b = torches.find((x) => x.id === q.id)
        trace.push({ now: stepping ? time * 1000 : at, id: q.id, x: q.x, z: q.z, yaw: q.yaw, axis: b ? [...b.dir] as [number, number, number] : null, level: b?.level ?? 0 })
      }
      if (trace.length > 20000) trace.splice(0, trace.length - 20000)
    }
    // The smoke draws offscreen and synchronously (a presented frame makes SwiftShader's GPU process wait on it).
    if (smoke && (!smokeTarget || smokeTarget.width !== width || smokeTarget.height !== height)) { smokeTarget?.destroy(); smokeTarget = device.createTexture({ size: [width, height], format: canvasFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT }) }
    creature.frame()
    // The storm: strikes, rain, wind and the eye after a flash for the picture; its thunder and rain for the sound.
    // Scheduled strikes follow the sim clock round camp, so a room on the same Look sees the same ones.
    const sf = storm.frame({ dt, eye: camera.eye, yaw: camera.yaw, groundY: standHeight(world, at.x, at.z), forestWind: view.forest.settings.wind, shared: { time: state.t, anchor: [world.camp.x, world.camp.z] } })
    audio.storm(sf)
    view.frame({ eye: [camera.eye[0], camera.eye[1], camera.eye[2]], viewProj: vp as Float32Array, width, height, time: state.t, dt, fovY: ((camera.fov + camera.mount.fov) * Math.PI) / 180, torches, fp, place, casters: [...friends.casters(ownOrigin, view.forest.settings.torchReach), ...held.casters()], batches: creatures.frame(world, time), storm: smoke ? null : sf.view }, stepping, smokeTarget?.createView())

    // HUD: the tie prompt, the map, toasts.
    const target = playing && p.mapRaise < 0.3 ? tieTarget(world, p, settings.tapeReach) : null
    if (target) {
      const has = !!tapeOnTree(state, target.id)
      const progress = p.tie && p.tie.tree === target.id && keys.has("KeyE") ? p.tie.progress : 0
      prompt.innerHTML = keyPromptHtml("KeyE", has ? "Untie tape" : "Tie tape", { hold: true, progress })
    } else prompt.innerHTML = ""
    const campLight = Math.max(0, 1 - Math.hypot(at.x - world.camp.x, at.z - world.camp.z) / 30) * 0.5 * settings.campGlow
    map.frame(state, meId, held.held ? 0 : p.mapRaise, camera.yaw, ownLevel * r + campLight + 0.04, camera.walk.lateral * 40, dt)
    if (performance.now() > toastUntil) toast.style.opacity = "0"
    if (state.night.seed !== storySeed) {
      if (!Number.isNaN(storySeed)) {
        story.again()
        // Online joins and new nights already restored the authoritative facing through poseVersion above.
        if (!online) { camera.yaw = world.camp.spawn.yaw; camera.pitch = -0.05; camera.resetWalk() }
        shell.flow.changed()
      }
      storySeed = state.night.seed
    }
    // The story: the trailhead opening at your first step out, the FIND BARBARA card, subtitles.
    // Online, not before the room has seated you (until then you'd be nobody, at the room's t 0).
    if (playing && !lakeLab && (!online || meId >= 0)) story.begin(world, state, meId, at.x, at.z, camera.yaw)
    if (playing || (shell.flow.started && panel.visible)) story.frame(dt, state, world)
    // What to do next, from your own map and what you've heard (never a timer).
    if (now >= goalAt) {
      goalAt = now + 250
      goal.classList.toggle("on", playing && story.started && p.mapRaise < 0.5)
      const text = nextStep(state.night, p.map.clues, nameOf)
      if (goalText.textContent !== text) goalText.textContent = text
    }
    endCard.label = online ? `Room ${roomCode}` : `Night ${night + 1}`
    endCard.frame(state, world)
    // You hear the woods while playing, or with the knobs open once you've begun (to tune the mix).
    audio.frame(camera.eye, camera.yaw, dt, world, state, playing || panel.visible)

    frames++
    if (frames <= 2) performance.mark(`woods:frame${frames}`)
    if (frames === 1) shell.loading?.finish()
    if (smoke && frames >= 2) paused = true
  }

  Object.assign(window, {
    woods: {
      get ready() { return true }, get frames() { return frames }, get time() { return time }, get paused() { return paused }, set paused(v: boolean) { paused = v },
      renderer, camera, settings, panel, map, held, debug, audio, story, view, look: view.forest.settings, quality, friends, cameraLook, creature, creatures, lakeEditor, endCard, storm,
      /** Automation: the night (phase, clock, finds, the layout) and the next one. */
      get night() { return session.view.night }, nextNight,
      /** Automation: the curated Looks (`src/looks.ts`) and the Triggers group's buttons. */
      looks: { pick: pickLook, get current() { return lookState.look }, ids: LOOK_IDS },
      trigger,
      measure: (n?: number) => view.forest.measure(n), stats: () => view.forest.stats(),
      get state() { return session instanceof SoloSession ? session.state : session.view }, get world() { return world }, get session() { return session },
      /** Automation: room readout (your id, people and walkers seen, tapes, bytes in, KB/s, connection status). */
      get net() {
        const s = session
        return { online: s.online, me: s.me, status: s.status(), walkers: s.view.players.length, roster: s.roster(), tapes: s.view.tapes.map((t) => t.tree), found: s.view.found, bytesIn: s instanceof OnlineSession ? s.bytesIn : 0, kbps: debug.kbps, self: { x: s.self.x, z: s.self.z }, heard: s.self.map.heard.map((h) => h.from), markers: s.self.map.markers, clues: s.self.map.clues, night: s.view.night.phase }
      },
      /** Automation: stand at (x, z) looking along yaw/pitch (solo); in a room only the look changes. */
      setPose(x: number, z: number, yaw: number, pitch = 0) { if (session instanceof SoloSession) session.teleport(x, z); camera.yaw = yaw; camera.pitch = pitch; camera.resetWalk(); view.forest.resetExposure() },
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
      step(ms: number) { const was = forcePlay; forcePlay = true; stepping = true; try { frame(last + ms) } finally { forcePlay = was; stepping = false } },
      /** Automation: play without pointer lock (the camera then takes no keyboard input; drive it with setPose). */
      set autoplay(v: boolean) { forcePlay = v; syncOverlays() },
      /** Automation: start recording friends as drawn each frame; `traced()` returns and stops. */
      trace() { trace = [] },
      traced() { const t = trace ?? []; trace = null; return t },
      friend(id: number): Player | undefined { return session.view.players.find((p) => p.id === id) },
      /** Automation: a tape on tree `id`, knot facing (fx, fz) from the trunk. */
      addTape(id: number, fx = 0, fz = 1) {
        const t = world.trees[id], state = session instanceof SoloSession ? session.state : session.view
        if (!t || session.online || tapeOnTree(state, id)) return
        const tape = { id: state.nextTape++, tree: id, x: t.x, y: t.y + TAPE_HEIGHT, z: t.z, yaw: Math.atan2(fz, fx), by: 0, at: state.t }
        state.tapes.push(tape)
        session.self.map.tapes.push(tape.id)
      },
    },
  })
  // Automation and the Lab's camera station: the fixed night spot with your torch and two friends'.
  if (params.get("lab") === "camera" && !smoke) stageCameraLab((window as unknown as { woods: Parameters<typeof stageCameraLab>[0] }).woods)
  // The Looks station: the same night spot, the knobs open on Looks & Triggers.
  if (params.get("lab") === "looks" && !smoke) {
    stageCameraLab((window as unknown as { woods: Parameters<typeof stageCameraLab>[0] }).woods)
    if (!panel.visible) panel.toggle()
  }
  requestAnimationFrame(loop)
}

void main().catch((e) => { console.error(e); document.getElementById("hud")!.textContent = String(e) })
