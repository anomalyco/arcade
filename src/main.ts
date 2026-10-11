import "./style.css"
import { Camera } from "./game/camera"
import { Controls } from "./game/input"
import { Scene } from "./game/scene"
import { LocalSession, type Session } from "./game/session"
import { Renderer } from "./render/renderer"
import { Hud } from "./ui/hud"
import { lobby } from "./ui/lobby"

function fail(msg: string) {
  const el = document.getElementById("overlay")!
  el.innerHTML = `<div class="nogpu"><h1>GETAWAY</h1><p>${msg}</p></div>`
}

async function connect(choice: Awaited<ReturnType<typeof lobby>>): Promise<Session> {
  if (choice.mode === "room" && choice.room) {
    const { NetSession } = await import("./game/net")
    return NetSession.connect(choice.room, choice.name, choice.picks)
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

  const choice = await lobby(document.getElementById("overlay")!)
  const session = await connect(choice)
  const scene = new Scene(renderer, session.city)
  const hud = new Hud(document.getElementById("hud")!, session.city)
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
    hud.update(view, { myId: session.myId, cam, width: innerWidth, height: innerHeight, dt, events: session.drainEvents(), players: session.players(), room: session.room, status: session.status() })
    ;(window as unknown as { __view: unknown }).__view = view
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
