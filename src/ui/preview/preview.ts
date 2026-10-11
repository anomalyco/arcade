/**
 * Dev-only HUD harness (not part of the build): runs the shared sim without WebGPU, draws a flat projected city
 * on a 2D canvas and drives the real HUD. Open /src/ui/preview/?role=cop&skip=60&speed=4 on the Vite dev server.
 */
import "../../style.css"
import { DT } from "../../../shared/config"
import { BOT_NAMES } from "../../../shared/names"
import { type Participant, World } from "../../../shared/sim/world"
import { Camera } from "../../game/camera"
import { Hud } from "../hud"
import { lobby } from "../lobby"

const q = new URLSearchParams(location.search)
const role = q.get("role") ?? "robber"
const speed = Number(q.get("speed") ?? 1)
const skip = Number(q.get("skip") ?? 0)
const bust = q.get("bust")
const showLobby = q.has("lobby")

async function main() {
  if (showLobby) await lobby(document.getElementById("overlay")!)
  const me: Participant = { id: "me", name: "Vex", human: false, picks: { robber: "muscle", cop: "cruiser" } }
  const bots: Participant[] = BOT_NAMES.slice(0, 4).map((name, i) => ({ id: `bot${i}`, name, human: false, picks: { robber: "compact", cop: i === 1 ? "interceptor" : "cruiser" } }))
  const ps = role === "cop" ? [bots[0]!, me, ...bots.slice(1)] : [me, ...bots]
  const world = new World(7, ps)
  for (let i = 0; i < skip / DT; i++) world.step(DT)
  world.drainEvents()
  // ?end runs the round to its finish and keeps the end-of-round events so the results card has awards.
  let early: ReturnType<World["drainEvents"]> = []
  if (q.has("end")) {
    for (let i = 0; i < 400 / DT && world.phase !== "end"; i++) world.step(DT)
    early = world.drainEvents().slice(-6)
  }

  const canvas = document.getElementById("view") as HTMLCanvasElement
  const g = canvas.getContext("2d")!
  const hud = new Hud(document.getElementById("hud")!, world.city)
  const cam = new Camera()
  let snapped = false
  let last = performance.now()
  let acc = 0

  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    acc += dt * speed
    while (acc >= DT) {
      world.step(DT)
      acc -= DT
    }
    if (bust !== null && world.phase === "chase") world.bust = Number(bust)
    const view = world.view("me")
    const mine = view.cars.find((c) => c.ownerId === "me" && !c.ghost)
    const robber = view.cars.find((c) => c.ownerId === view.robberId && !c.ghost)
    const focus = (view.phase === "intro" ? robber : mine) ?? robber ?? view.cars[0]!
    if (!snapped) {
      cam.snap(focus.x, focus.z)
      snapped = true
    }
    cam.update(focus.x, focus.z, focus.vx, focus.vz, dt)
    const W = innerWidth
    const H = innerHeight
    if (canvas.width !== W) canvas.width = W
    if (canvas.height !== H) canvas.height = H
    cam.matrices(W / H)
    g.fillStyle = "#121620"
    g.fillRect(0, 0, W, H)
    const poly = (pts: [number, number, number][], fill: string) => {
      g.beginPath()
      for (const [x, y, z] of pts) {
        const p = cam.project(x, y, z, W, H)
        g.lineTo(p[0], p[1])
      }
      g.closePath()
      g.fillStyle = fill
      g.fill()
    }
    for (let i = 0; i < world.city.adj.length; i++)
      for (const j of world.city.adj[i]!) {
        if (j < i) continue
        const a = world.city.nodes[i]!
        const b = world.city.nodes[j]!
        const x0 = Math.min(a.x, b.x) - 8
        const x1 = Math.max(a.x, b.x) + 8
        const z0 = Math.min(a.z, b.z) - 8
        const z1 = Math.max(a.z, b.z) + 8
        poly([[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]], "#262c38")
      }
    for (const b of world.city.boxes) {
      if (b.kind === "wall") continue
      const c = b.color
      poly([[b.x0, b.h, b.z0], [b.x1, b.h, b.z0], [b.x1, b.h, b.z1], [b.x0, b.h, b.z1]], `rgb(${c.map((v) => Math.round(v * 120)).join(",")})`)
    }
    for (const c of view.cars) {
      const p = cam.project(c.x, 0.5, c.z, W, H)
      g.fillStyle = c.ghost ? "rgba(255,59,59,0.4)" : c.role === "robber" ? "#d23" : "#eef"
      g.beginPath()
      g.arc(p[0], p[1], 9, 0, Math.PI * 2)
      g.fill()
    }
    hud.update(view, { myId: "me", cam, width: W, height: H, dt, events: [...early.splice(0), ...world.drainEvents()], players: ps.map((p) => ({ id: p.id, name: p.name, human: p.id === "me" })), room: q.get("room"), status: q.get("room") ? "connected" : "solo" })
    ;(window as unknown as { __view: unknown }).__view = view
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
