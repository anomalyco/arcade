import "./style.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import { cleanName } from "../shared/protocol"
import { Sound } from "./audio/sound"
import { Game } from "./game/game"
import { Input } from "./game/input"
import { NetSession } from "./game/net"
import { LocalSession, type Session } from "./game/session"
import { loadProfile, recordMatch, saveProfile } from "./profile"
import { Camera } from "./render/camera"
import { Renderer } from "./render/renderer"
import { Hud } from "./ui/hud"
import { Menus } from "./ui/menus"

const MAX_DPR = 1.5

async function gpu(canvas: HTMLCanvasElement): Promise<Renderer | string> {
  if (!navigator.gpu) return "BLACKOUT needs WebGPU. Use a recent Chrome, Edge or Safari over https or localhost."
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return "No WebGPU adapter is available on this device."
  const device = await adapter.requestDevice()
  device.addEventListener("uncapturederror", (e) => console.error(`[gpu] ${e.error.message}`))
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  return new Renderer(device, context, format)
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const menuEl = document.getElementById("menu")!
  const renderer = await gpu(canvas)
  if (typeof renderer === "string") {
    menuEl.className = "full"
    menuEl.innerHTML = `<div class="landing"><div class="logo">BLACKOUT</div><div class="notice">${renderer}</div></div>`
    return
  }
  const params = new URLSearchParams(location.search)
  const roomParam = (params.get("room") ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || null
  const profile = loadProfile()
  const sound = new Sound()
  const input = new Input(canvas)
  const cam = new Camera()
  const hud = new Hud(document.getElementById("hud")!)
  let session: Session | null = null
  let game: Game | null = null
  let recorded = false

  const begin = (s: Session) => {
    session = s
    game = new Game(renderer, s, (r, me) => {
      if (me) sound.ring(r.x - me.x, r.y - me.y, r.r, r.kind, Math.hypot(r.x - me.x, r.y - me.y) < 0.6)
    })
    menus.hide()
    hud.show(true)
  }
  const named = (n: string) => {
    profile.name = cleanName(n)
    saveProfile(profile)
    sound.start()
    return profile.name
  }
  const menus = new Menus(menuEl, profile, profile.lastLoadout, {
    practice: (n) => begin(new LocalSession(named(n), profile.lastLoadout)),
    create: async (n) => {
      const name = named(n)
      const base = location.pathname.replace(/[^/]*$/, "")
      const res = await fetch(`${base}api/create`, { method: "POST" }).then((r) => r.json() as Promise<{ room: string }>)
      history.replaceState(null, "", `?room=${res.room}`)
      begin(new NetSession(res.room, name, profile.lastLoadout, fatal))
    },
    join: (n, room) => {
      const name = named(n)
      history.replaceState(null, "", `?room=${room}`)
      begin(new NetSession(room, name, profile.lastLoadout, fatal))
    },
    loadout: (l) => {
      profile.lastLoadout = l
      saveProfile(profile)
      session?.send({ type: "loadout", loadout: l })
    },
    start: (mode, rounds) => session?.send({ type: "start", mode, rounds }),
    leave: () => {
      session?.close()
      location.href = location.pathname
    },
  })
  const fatal = (message: string) => {
    session?.close()
    session = null
    game = null
    hud.show(false)
    history.replaceState(null, "", location.pathname)
    menus.landing(null, message)
  }
  input.onKey = (code) => {
    if (code === "KeyM") sound.setMuted(!sound.muted)
  }
  menus.landing(roomParam)
  if (params.has("practice")) begin(new LocalSession(profile.name || "you", profile.lastLoadout))

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    renderer.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.55, Math.min(1, innerWidth / 1500, innerHeight / 950))))
  }
  resize()
  addEventListener("resize", resize)

  const perf = { update: 0, build: 0, render: 0, ui: 0, frames: 0, gpu: 0 }
  ;(window as unknown as { __perf: typeof perf }).__perf = perf
  let last = performance.now()
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const w = innerWidth
    const h = innerHeight
    if (game && session) {
      const s = game.snap
      input.enabled = !!s && (s.phase === "live" || s.phase === "loadout")
      menus.setScoreboard(input.held("Tab"))
      const t0 = performance.now()
      game.update(dt, input, cam, w, h, now)
      const t1 = performance.now()
      const snap = game.snap
      const body = game.body
      let fx = game.map.size[0] / 2
      let fz = game.map.size[1] / 2
      let wide = true
      if (snap && body && snap.you?.alive && (snap.phase === "live" || snap.phase === "loadout")) {
        fx = body.x
        fz = body.y
        wide = false
      } else if (snap?.phase === "live") {
        const mate = [...game.shown.values()][0]
        if (mate) {
          fx = mate.sx
          fz = mate.sy
          wide = false
        }
      }
      const lean = !wide && body ? Math.min(1, Math.hypot(game.cursor.x - body.x, game.cursor.y - body.y) / 10) : 0
      cam.follow(fx, fz, wide ? 0 : Math.cos(game.aim) * 3 * lean, wide ? 0 : Math.sin(game.aim) * 3 * lean, dt, wide)
      const fi = game.build(cam, w, h, now)
      const t2 = performance.now()
      renderer.render(fi)
      const t3 = performance.now()
      hud.update(game, cam, w, h, now, session.status())
      menus.lastAwards = game.awards
      menus.update(snap, game.roster, session.myId, session.room)
      if (snap?.phase === "match" && !recorded) {
        recorded = true
        const me = game.roster.find((r) => r.id === session!.myId)
        if (me) {
          const key = snap.mode === "ffa" ? me.id : me.key
          const best = Object.entries(snap.wins).sort((a, b) => b[1] - a[1])[0]
          const r = recordMatch(profile, { id: me.id, stats: me.stats, won: !!best && best[0] === key, roundWins: snap.wins[key] ?? 0 }, game.awards)
          menus.setXp(`+${r.gained} XP${r.levelUp ? ` · LEVEL ${r.level} UNLOCKED` : ""}`)
        }
      }
      if (snap?.phase !== "match") recorded = false
      perf.update += t1 - t0
      perf.build += t2 - t1
      perf.render += t3 - t2
      perf.ui += performance.now() - t3
      perf.frames++
      const near = game.near
      const t = now / 1000
      sound.heart(game.alive && near.d < 14 && t - near.t < 1.2 ? 56 + 70 * (1 - near.d / 14) : 0)
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
