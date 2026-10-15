import "./style.css"
import "@fontsource/barlow-condensed/600.css"
import "@fontsource/barlow-condensed/800.css"
import { openGpu } from "@arcade/kit/gpu/boot"
import { ARENAS } from "../shared/arena"
import { GAME, MAX_PLAYERS } from "../shared/config"
import { Controls, type Device } from "./game/controls"
import { Game, type Seat } from "./game/game"
import { OnlineSession } from "./net/online"
import { Renderer } from "./render/renderer"
import { Sound } from "./sound"
import { Hud } from "./ui/hud"

const MAX_DPR = 1.5
const BOT_NAMES = ["TEAL", "WINE", "MOSS", "OCHRE"]

/** A room code from the URL, if it looks like one. */
const roomCode = (v: string | null) => (v && /^[a-z0-9]{4,8}$/i.test(v) ? v.toLowerCase() : null)

/**
 * Local couch play. `?watch` is four bots (captures use it); otherwise one keyboard player against bots, with
 * gamepads joining on A and a second keyboard player on Enter (the keyboard splits in two). `?arena=cloister` and
 * `?seed=` pick the arena and the match seed.
 *
 * Online: `?room=code` takes a seat in that room (bots hold the others), `?online` quick-joins an open room or opens
 * one, and P in couch play does the same. The room's first arrival can set `&arena=` and `&private=1`.
 */
async function main() {
  document.title = GAME.title
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const hudEl = document.getElementById("hud")!
  const g = await openGpu(canvas, GAME.title)
  if (typeof g === "string") {
    hudEl.innerHTML = `<div class="notice"><div class="logo">${GAME.title}</div><div>${g}</div></div>`
    return
  }
  const renderer = new Renderer(g.device, g.context, g.format)
  const params = new URLSearchParams(location.search)
  if (params.has("online") && !roomCode(params.get("room"))) {
    try {
      const r = (await (await fetch("api/quick")).json()) as { room: string }
      params.delete("online")
      params.set("room", r.room)
      history.replaceState(null, "", `?${params}`)
    } catch {
      hudEl.innerHTML = `<div class="notice"><div class="logo">${GAME.title}</div><div>Couldn't reach the lobby. Reload to try again.</div></div>`
      return
    }
  }
  const room = roomCode(params.get("room"))
  const seed = Number(params.get("seed")) || ((Math.random() * 1e9) | 0)
  const arena = ARENAS[params.get("arena") ?? ""] ? params.get("arena")! : "belltower"
  const watch = params.has("watch") || !!room
  const sound = new Sound()
  const controls = new Controls()
  const hud = new Hud(hudEl)
  const seats: Seat[] = []
  for (let i = 0; i < MAX_PLAYERS; i++) seats.push({ id: `a${i}`, name: BOT_NAMES[i]!, device: null })
  if (!watch) {
    seats[0]!.device = "kb"
    seats[0]!.name = "P1"
  }
  const game = new Game(renderer, controls, sound, { arena, seats, seed })
  ;(globalThis as { archers?: Game }).archers = game
  if (room) game.online = new OnlineSession(room, undefined, { arena: params.get("arena"), private: params.get("private") })
  const invite = () => {
    const url = new URL(location.href)
    url.search = `?room=${room}`
    void navigator.clipboard?.writeText(url.toString())
  }
  if (params.get("focus")) {
    game.focus = params.get("focus")
    game.focusSpan = Number(params.get("span")) || 6
  }

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.6, Math.min(1, innerWidth / 1500, innerHeight / 950))))
  }
  resize()
  addEventListener("resize", resize)

  const humans = () => seats.filter((s) => s.device).length
  const join = (d: Device) => {
    const seat = game.join(d, `P${humans() + 1}`)
    if (seat) sound.play("ui.ping")
  }

  let last = performance.now()
  let started = performance.now()
  const frame = (now: number) => {
    const realDt = (now - last) / 1000
    const dt = Math.min(0.1, realDt)
    last = now
    if (!watch) {
      const known = new Set(seats.map((s) => s.device).filter((d): d is Device => !!d))
      for (const d of controls.padJoins(known)) join(d)
      if (controls.pressed("Enter") && !known.has("kbR")) {
        const solo = seats.find((s) => s.device === "kb")
        if (solo) {
          solo.device = "kbL"
          join("kbR")
          started = now
        }
      }
      if (controls.pressed("Digit1")) game.setArena("belltower")
      if (controls.pressed("Digit2")) game.setArena("cloister")
      if (controls.pressed("KeyP")) location.search = "?online"
    }
    game.update(realDt)
    renderer.render(game.build(innerWidth, innerHeight, dt))
    sound.listen(game.cam.cx, game.cam.cy)
    const o = game.online
    hud.update(game, innerWidth, innerHeight, (!watch || !!o?.ready) && now - started < 14000)
    if (o) hud.net(room, o.rtt, o.fatal ?? o.socket.status() ?? (o.ready ? null : "Joining…"), invite)
    controls.endFrame()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
