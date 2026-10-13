import "./style.css"
import "@fontsource/barlow-condensed/800.css"
import "@fontsource/barlow-condensed/800-italic.css"
import { paintAtlas } from "./render/atlas"
import { Camera } from "./game/camera"
import { Controls } from "./game/input"
import { Scene } from "./game/scene"
import { LocalSession, type Session } from "./game/session"
import { applyStage } from "./game/stage"
import { mulberry32 } from "../shared/sim/rng"
import { GameAudio } from "./audio/game-audio"
import { Radio } from "./audio/radio"
import { Renderer } from "./render/renderer"
import { Chat } from "./ui/chat"
import { Hud } from "./ui/hud"
import { lobby, quickRoom, setRoomParam } from "./ui/lobby"
import { DebugOverlay } from "./ui/debug-overlay"
import { GpuPerf } from "../../../packages/kit/gpu-perf"
import type { WorldView } from "../shared/sim/world"

/** A message for the next lobby (an idle kick reloads the page back to it). */
const NOTICE_KEY = "getaway.notice"

function fail(msg: string) {
  const el = document.getElementById("overlay")!
  el.innerHTML = `<div class="nogpu"><h1>GETAWAY</h1><p>${msg}</p></div>`
}

async function connect(choice: Awaited<ReturnType<typeof lobby>>): Promise<Session> {
  if (choice.mode === "room" && choice.room) {
    const { NetSession, RoomFullError } = await import("./game/net")
    try {
      return await NetSession.connect(choice.room, choice.name, choice.picks, choice.via === "create")
    } catch (e) {
      // Quick join lost the race for the last seat: ask the matchmaker once more.
      if (choice.via !== "quick" || !(e instanceof RoomFullError)) throw e
      choice.room = await quickRoom()
      setRoomParam(choice.room, true)
      return NetSession.connect(choice.room, choice.name, choice.picks)
    }
  }
  return new LocalSession(choice.name, choice.picks)
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  if (!navigator.gpu) return fail("Getaway needs WebGPU. Use a recent Chrome, Edge or Safari, over https or localhost.")
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return fail("No WebGPU adapter is available on this device.")
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [] })
  const telemetry = new GpuPerf(device)
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  const renderer = new Renderer(device, context, format)
  const atlasReady = paintAtlas().then((img) => renderer.setAtlas(img))

  const q = new URLSearchParams(location.search)
  const staged = (import.meta.env.DEV && q.has("stage")) || q.has("solo") || q.get("peaceful") === "1" || q.has("mux")
  const benchMode = q.has("bench")
  let session: Session | null = null
  let choice: Awaited<ReturnType<typeof lobby>> = { mode: "solo", room: null, name: "Dax", picks: { robber: "muscle", cop: "cruiser" } }
  let notice = sessionStorage.getItem(NOTICE_KEY)
  sessionStorage.removeItem(NOTICE_KEY)
  while (!session) {
    if (!staged) choice = await lobby(document.getElementById("overlay")!, notice)
    try {
      session = await connect(choice)
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      notice = /room .* is full|could not reach/i.test(why) ? why : `Could not join room ${choice.room}: ${why}`
      history.replaceState(null, "", location.pathname)
    }
  }
  if (q.has("nohud")) document.getElementById("hud")!.style.display = "none"
  let activeSession: Session = session
  const scene = new Scene(renderer, activeSession.city)
  const hud = new Hud(document.getElementById("hud")!, activeSession.city)
  const sound = new GameAudio(document.getElementById("hud")!)
  const radio = new Radio()
  let cam = new Camera()
  const controls = new Controls()
  const mux = controls.mux
  const debug = new DebugOverlay(q, () => {
    controls.release()
    controls.forward({ type: "mux-release" })
  })
  const chat = activeSession.chat ? new Chat(document.getElementById("hud")!, controls, activeSession) : null
  let snapped = false
  let freeze = 0
  let previousFuel = 1
  let boostingUntil = 0
  let muxTick = 0
  let muxView: WorldView | null = null
  const cameraKeys = ["fx", "fz", "dist", "fov", "lx", "lz", "t", "shake", "landing"] as const
  const cameraState = () => Object.fromEntries(cameraKeys.map((key) => [key, (cam as unknown as Record<string, number>)[key] ?? 0]))
  const ready = () => {
    if (!(activeSession instanceof LocalSession)) return
    muxView = activeSession.update(0, controls.read(0))
    const mine = muxView.cars.find((c) => c.ownerId === activeSession.myId)!
    cam.snap(mine.x, mine.z)
    snapped = true
    controls.forward({ type: "mux-ready", protocol: 1, map: activeSession.city.seed, mode: "peaceful", x: mine.x, y: mine.z, vx: mine.vx, vy: mine.vz, h: mine.h })
  }
  if (mux) addEventListener("message", (event) => {
    if (!controls.accepts(event)) return
    const message = event.data
    if (message.type === "mux-key" && (message.kind === "keydown" || message.kind === "keyup") && typeof message.code === "string" && typeof message.key === "string") {
      if (message.code === "Backquote") {
        if (message.kind === "keydown" && !controls.pressed("Backquote")) debug.toggle()
      }
      controls.key(message.kind, message.code, message.key)
    } else if (message.type === "mux-mouse" && Number.isFinite(message.nx) && Number.isFinite(message.ny)) controls.pointer(message)
    else if (message.type === "mux-release") controls.release()
    else if (message.type === "mux-reset") location.reload()
    else if (message.type === "mux-hello") ready()
    else if ((message.type === "mux-step" || message.type === "mux-sync") && Number.isFinite(message.dt) && Number.isInteger(message.tick) && message.tick === muxTick + 1 && activeSession instanceof LocalSession) {
      const dt = Math.max(0, Math.min(0.1, message.dt))
      if (message.type === "mux-step") {
        muxView = activeSession.update(dt, controls.read(dt))
        const mine = muxView.cars.find((c) => c.ownerId === activeSession.myId)!
        cam.update(mine.x, mine.z, mine.vx, mine.vz, dt)
      } else {
        if (!message.view || !Number.isFinite(message.view.t) || !Array.isArray(message.view.cars) || !cameraKeys.every((key) => Number.isFinite(message.camera?.[key]))) return
        muxView = message.view as WorldView
        activeSession.syncView(muxView)
        Object.assign(cam, message.camera)
      }
      muxTick = message.tick
      const mine = muxView!.cars.find((c) => c.ownerId === activeSession.myId)!
      controls.forward({ type: message.type === "mux-step" ? "mux-state" : "mux-done", tick: muxTick, view: muxView, camera: cameraState(), x: mine.x, y: mine.z, vx: mine.vx, vy: mine.vz, h: mine.h })
    }
    else if (message.type === "mux-sync" && activeSession instanceof LocalSession) {
      const { x, vx, h } = message
      const z = message.z ?? message.y, vz = message.vz ?? message.vy, yaw = message.yaw ?? 0, speed = message.speed ?? Math.hypot(vx, vz)
      if ([x, z, vx, vz, h, yaw, speed].every((v) => typeof v === "number" && Number.isFinite(v))) activeSession.syncCar({ x, z, vx, vz, h, yaw, speed })
    }
  })

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, 2)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
  }
  resize()
  addEventListener("resize", resize)
  if (mux) ready()

  let rafActive = !benchMode
  ;(window as unknown as { __getawayBench: unknown }).__getawayBench = {
    ready: atlasReady.then(() => true),
    adapterInfo: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
    },
    reset() {
      rafActive = false
      const prng = mulberry32(1337)
      Math.random = () => prng()
      const local = new LocalSession("Dax", { robber: "muscle", cop: "cruiser" }, 7)
      applyStage(local.world, "chase")
      const cops = local.world.cops()
      const trail = [
        [225, 139, 0.08],
        [231, 131, -0.06],
        [226, 122, 0.04],
      ] as const
      trail.forEach(([x, z, h], i) => cops[i] && Object.assign(cops[i]!.body, { x, z, h, vx: 0, vz: 28 }))
      local.world.seen = true
      local.world.lastSeen = { x: 226, z: 150, t: local.world.t }
      Object.assign(local.world.heli, { active: true, x: 246, y: 18, z: 162, h: -1.6, sx: 229, sz: 174 })
      local.syncBench()
      activeSession = local
      scene.resetBench()
      cam = new Camera()
      snapped = false
    },
    async step(frameIndex: number, dt = 1 / 30, waitGpu = false) {
      const t0 = performance.now()
      const local = activeSession as LocalSession
      const r = local.world?.robber()?.body
      const rx = r?.x ?? 228
      const rh = r?.h ?? 0
      const ryaw = r?.yaw ?? 0
      const targetX = 228 + Math.sin(frameIndex * 0.085) * 3.4
      const steer = Math.max(-1, Math.min(1, (targetX - rx) * 0.18 - rh * 2.2 - ryaw * 0.35))
      const handbrake = frameIndex >= 3 && frameIndex < 9
      const boost = (frameIndex >= 22 && frameIndex < 52) || (frameIndex >= 115 && frameIndex < 150)
      const input = { throttle: 1, brake: 0, steer, handbrake, boost, gadget: null as 0 | 1 | null, engine: false }
      const view = activeSession.update(dt, input)
      const mine = view.cars.find((c) => c.ownerId === activeSession.myId && !c.ghost)
      const robber = view.cars.find((c) => c.ownerId === view.robberId && !c.ghost)
      const focus = (view.phase === "intro" ? robber : mine) ?? robber ?? view.cars[0] ?? null
      if (focus) {
        if (!snapped) {
          cam.snap(focus.x, focus.z)
          snapped = true
        }
        cam.update(focus.x, focus.z, focus.vx, focus.vz, dt, 0, input.boost && focus.boost > 0 && focus.speed > 4)
      }
      if (scene.shake > 0) {
        cam.bump(scene.shake)
        scene.shake = 0
      }
      scene.input = input
      if (scene.punch > 0) { cam.land(scene.punch); scene.punch = 0 }
      scene.draw(view, cam, canvas.width, canvas.height, dt, focus)
      const events = activeSession.drainEvents()
      hud.update(view, {
        myId: activeSession.myId,
        cam,
        width: innerWidth,
        height: innerHeight,
        dt,
        events,
        players: activeSession.players(),
        room: activeSession.room,
        status: activeSession.status(),
        idleIn: activeSession.idleIn?.(),
      })
      const cpuMs = performance.now() - t0
      let gpuMs = cpuMs
      if (waitGpu) {
        const g0 = performance.now()
        await device.queue.onSubmittedWorkDone()
        gpuMs = performance.now() - g0
      }
      return { cpuMs, gpuMs, stats: { ...renderer.stats } }
    },
  }

  // RAF's timestamp can predate synchronous startup work. Start on its clock,
  // otherwise a negative first delta creates crash/brake/boost and freeze timers.
  let last: number | null = null
  const frame = (now: number) => {
    if (!rafActive) return
    const kicked = activeSession.kicked?.()
    if (kicked) {
      sessionStorage.setItem(NOTICE_KEY, /idle/i.test(kicked) ? "You were kicked for being idle" : kicked)
      location.replace(location.pathname)
      return
    }
    const frameMs = last === null ? 0 : Math.max(0, now - last)
    const dt = Math.min(0.1, frameMs / 1000)
    last = now
    const input = controls.read(mux ? 0 : dt)
    const view = mux && muxView ? muxView : activeSession.update(dt, input)
    const mine = view.cars.find((c) => c.ownerId === activeSession.myId && !c.ghost)
    const robber = view.cars.find((c) => c.ownerId === view.robberId && !c.ghost)
    const focus = (view.phase === "intro" ? robber : mine) ?? robber ?? view.cars[0] ?? null
    if (focus && focus.boost < previousFuel - 1e-4) boostingUntil = now + 80
    previousFuel = focus?.boost ?? 1
    freeze = Math.max(freeze, scene.hitStop)
    scene.hitStop = 0
    const held = freeze > 0
    freeze = Math.max(0, freeze - dt)
    if (focus && !held && !mux) {
      if (!snapped) {
        cam.snap(focus.x, focus.z)
        snapped = true
      }
      cam.update(focus.x, focus.z, focus.vx, focus.vz, dt, 0, now < boostingUntil)
    }
    if (scene.shake > 0 && !mux) {
      cam.bump(scene.shake)
      scene.shake = 0
    }
    scene.input = input
    if (mux) {
      cam.present(dt, now < boostingUntil, scene.shake, scene.punch)
      scene.shake = scene.punch = 0
    }
    if (scene.punch > 0 && !mux) { cam.land(scene.punch); scene.punch = 0 }
    if (!held) scene.draw(view, cam, canvas.width, canvas.height, dt, focus)
    telemetry.enabled = debug.visible || mux
    const report = debug.update(now, frameMs, { gpuMs: telemetry.gpuMs, gpuKind: telemetry.gpuKind, draws: telemetry.draws, verts: telemetry.verts, chunks: renderer.stats.chunksDrawn, lights: scene.lightCount })
    if (parent !== window) {
      const pose = mine ? { x: mine.x, z: mine.z, vx: mine.vx, vz: mine.vz, h: mine.h, yaw: mine.yaw ?? 0, speed: mine.speed } : {}
      if (report) parent.postMessage({ type: "arcade-perf", ...debug.sample, ...pose, y: mine?.z, tick: muxTick, run: controls.muxRun }, controls.parentOrigin)
    }
    const events = activeSession.drainEvents()
    hud.update(view, { myId: activeSession.myId, cam, width: innerWidth, height: innerHeight, dt, events, players: activeSession.players(), room: activeSession.room, status: activeSession.status(), idleIn: activeSession.idleIn?.() })
    chat?.update()
    sound.update(view, { myId: activeSession.myId, cam, dt, events, input })
    radio.update(view, activeSession.myId, events)
    ;(window as unknown as { __view: unknown }).__view = view
    requestAnimationFrame(frame)
  }
  if (rafActive) requestAnimationFrame(frame)
}

void main()
