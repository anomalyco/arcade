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
  const device = await adapter.requestDevice()
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  const renderer = new Renderer(device, context, format)
  const atlasReady = paintAtlas().then((img) => renderer.setAtlas(img))

  const q = new URLSearchParams(location.search)
  const staged = (import.meta.env.DEV && q.has("stage")) || q.has("solo")
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
  const chat = activeSession.chat ? new Chat(document.getElementById("hud")!, controls, activeSession) : null
  let snapped = false

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, 2)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
  }
  resize()
  addEventListener("resize", resize)

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
        cam.update(focus.x, focus.z, focus.vx, focus.vz, dt)
      }
      if (scene.shake > 0) {
        cam.bump(scene.shake)
        scene.shake = 0
      }
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

  let last = performance.now()
  const frame = (now: number) => {
    if (!rafActive) return
    const kicked = activeSession.kicked?.()
    if (kicked) {
      sessionStorage.setItem(NOTICE_KEY, /idle/i.test(kicked) ? "You were kicked for being idle" : kicked)
      location.replace(location.pathname)
      return
    }
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const input = controls.read(dt)
    const view = activeSession.update(dt, input)
    const mine = view.cars.find((c) => c.ownerId === activeSession.myId && !c.ghost)
    const robber = view.cars.find((c) => c.ownerId === view.robberId && !c.ghost)
    const focus = (view.phase === "intro" ? robber : mine) ?? robber ?? view.cars[0] ?? null
    if (focus) {
      if (!snapped) {
        cam.snap(focus.x, focus.z)
        snapped = true
      }
      cam.update(focus.x, focus.z, focus.vx, focus.vz, dt)
    }
    if (scene.shake > 0) {
      cam.bump(scene.shake)
      scene.shake = 0
    }
    scene.draw(view, cam, canvas.width, canvas.height, dt, focus)
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
