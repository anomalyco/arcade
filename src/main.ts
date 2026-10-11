import "./style.css"
import "@fontsource/barlow-condensed/800.css"
import "@fontsource/barlow-condensed/800-italic.css"
import { paintAtlas } from "./render/atlas"
import { Camera } from "./game/camera"
import { Controls } from "./game/input"
import { Scene } from "./game/scene"
import { LocalSession, type Session } from "./game/session"
import { GameAudio } from "./audio/game-audio"
import { Radio } from "./audio/radio"
import { Renderer } from "./render/renderer"
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
  void paintAtlas().then((img) => renderer.setAtlas(img))

  const q = new URLSearchParams(location.search)
  const staged = import.meta.env.DEV && q.has("stage")
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
  const scene = new Scene(renderer, session.city)
  const hud = new Hud(document.getElementById("hud")!, session.city)
  const sound = new GameAudio(document.getElementById("hud")!)
  const radio = new Radio()
  const cam = new Camera()
  const controls = new Controls()
  let snapped = false

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, 2)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
  }
  resize()
  addEventListener("resize", resize)

  let last = performance.now()
  const frame = (now: number) => {
    const kicked = session.kicked?.()
    if (kicked) {
      sessionStorage.setItem(NOTICE_KEY, /idle/i.test(kicked) ? "You were kicked for being idle" : kicked)
      location.replace(location.pathname)
      return
    }
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const input = controls.read(dt)
    const view = session.update(dt, input)
    const mine = view.cars.find((c) => c.ownerId === session.myId && !c.ghost)
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
    const events = session.drainEvents()
    hud.update(view, { myId: session.myId, cam, width: innerWidth, height: innerHeight, dt, events, players: session.players(), room: session.room, status: session.status(), idleIn: session.idleIn?.() })
    sound.update(view, { myId: session.myId, cam, dt, events, input })
    radio.update(view, session.myId, events)
    ;(window as unknown as { __view: unknown }).__view = view
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
