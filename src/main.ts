import "./style.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "@fontsource/ibm-plex-mono/600.css"
import { DT, WEAPONS } from "../shared/config"
import { cleanName } from "../shared/protocol"
import type { Intent, SimEvent } from "../shared/sim/world"
import type { Snapshot } from "../shared/sim/view"
import { Sound } from "./audio/sound"
import { Camera } from "./game/camera"
import { Controls } from "./game/controls"
import { type Actor, buildFrame, colorOf } from "./game/draw"
import { Net } from "./game/net"
import { Predictor } from "./game/predict"
import { GameState } from "./game/state"
import { Instances, Renderer } from "./render/renderer"
import { type Loadout, type Profile, levelOf, loadProfile, recordMatch, saveProfile } from "./profile/profile"
import { Hud } from "./ui/hud"
import { Panels } from "./ui/panels"

const NAME_KEY = "blackout.name"
const MAX_DPR = 1.5

async function gpu(canvas: HTMLCanvasElement): Promise<Renderer | null> {
  if (!navigator.gpu) return null
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) return null
  const device = await adapter.requestDevice()
  const context = canvas.getContext("webgpu")!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: "opaque" })
  return new Renderer(device, context, format)
}

function fail(msg: string) {
  const el = document.getElementById("overlay")!
  el.innerHTML = `<div class="card-wrap"><div class="card"><div class="title small-t">BLACKOUT</div><p>${msg}</p></div></div>`
  el.classList.add("show")
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const overlayEl = document.getElementById("overlay")!
  const hudEl = document.getElementById("hud")!
  const room = (new URLSearchParams(location.search).get("room") ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)
  const profile: Profile = loadProfile()
  let name = cleanName(localStorage.getItem(NAME_KEY) ?? profile.name)
  let loadout: Loadout = profile.lastLoadout

  const renderer = await gpu(canvas)
  if (!renderer) {
    fail("BLACKOUT needs WebGPU. Use a recent Chrome, Edge or Safari, over https or localhost.")
    return
  }

  const sound = new Sound()
  const gs = new GameState()
  const pred = new Predictor()
  const cam = new Camera()
  const controls = new Controls(canvas)
  const inst = new Instances()
  const hud = new Hud(hudEl)
  const shown = new Map<string, { x: number; y: number; aim: number; alpha: number }>()
  const notice = hudEl.querySelector<HTMLElement>("#notice")!
  let net: Net | null = null
  let myId = ""
  let lastSnap: Snapshot | null = null
  let matchRecorded = false
  let noticeUntil = 0

  const say = (text: string, ms = 1800) => {
    notice.textContent = text
    noticeUntil = performance.now() + ms
  }

  const panels = new Panels(overlayEl, {
    create: async () => {
      const base = location.pathname.replace(/[^/]*$/, "")
      const r = await fetch(`${base}api/create`, { method: "POST" }).then((x) => x.json() as Promise<{ room: string }>)
      location.search = `?room=${r.room}`
    },
    enter: (n) => {
      name = cleanName(n)
      localStorage.setItem(NAME_KEY, name)
      profile.name = name
      saveProfile(profile)
      sound.start()
      connect()
    },
    loadout: (l) => {
      loadout = l
      net?.send({ type: "loadout", loadout: l })
    },
    start: (mode, rounds) => net?.send({ type: "start", mode, rounds, map: "warehouse" }),
    copy: (url) => {
      void navigator.clipboard?.writeText(url)
      say("Link copied")
    },
    setName: (v) => (name = cleanName(v)),
  })

  const resize = () => {
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    canvas.width = Math.max(1, Math.floor(innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(innerHeight * dpr))
    canvas.style.width = `${innerWidth}px`
    canvas.style.height = `${innerHeight}px`
  }
  resize()
  addEventListener("resize", resize)

  function matchWon(s: Snapshot, id: string): boolean {
    const me = s.roster.find((r) => r.id === id)
    if (!me) return false
    const key = s.mode === "ffa" ? id : me.key
    const best = Object.entries(s.wins).sort((a, b) => b[1] - a[1])[0]
    return best !== undefined && best[0] === key
  }

  function recordEnd(s: Snapshot) {
    const me = s.roster.find((r) => r.id === myId)
    if (!me) return
    const roundWins = s.wins[s.mode === "ffa" ? myId : me.key] ?? 0
    const r = recordMatch(profile, { id: myId, stats: me.stats, won: matchWon(s, myId), roundWins }, s.awards)
    say(`+${r.gained} XP${r.levelUp ? ` · LEVEL ${r.level}` : ""}`, 4000)
    panels.setProfile(profile, loadout)
  }

  function connect() {
    if (!room) return
    panels.connecting(room)
    net = new Net(room, {
      welcome(id) {
        myId = id
        pred.reset()
        panels.setProfile(profile, loadout)
      },
      snap(s) {
        lastSnap = s
        gs.onSnap(s, myId, performance.now() / 1000)
        if (s.you) pred.reconcile(s.you, s.ack, gs.walls)
        const roster = s.roster.map((r) => `${r.id}:${r.alive}:${r.team}`).join(",")
        panels.update(s, myId, room, roster)
        if (s.phase === "match" && !matchRecorded) {
          matchRecorded = true
          recordEnd(s)
        }
        if (s.phase !== "match") matchRecorded = false
      },
      events(ev: SimEvent[]) {
        const now = performance.now() / 1000
        const body = pred.body
        gs.onEvents(ev, now, body && lastSnap?.you?.alive ? { x: body.x, y: body.y } : null)
        for (const e of ev) {
          if (e.k === "ripple" && body) sound.ring(e.x - body.x, e.y - body.y, e.r, e.kind, Math.hypot(e.x - body.x, e.y - body.y) < 0.5)
          if (e.k === "kill") sound.kill()
          if (e.k === "shot" && e.to.includes(myId)) sound.shot(WEAPONS[lastSnap?.you?.weapon ?? "pistol"].noise < 5)
        }
      },
      error(code, message) {
        panels.message(code === "full" ? "ROOM FULL" : "CAN'T JOIN", message)
      },
      status(text) {
        if (text) say(text, 60_000)
        else notice.textContent = ""
      },
    })
    net.connect(name, loadout)
  }

  let last = performance.now()
  let acc = 0
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const seconds = now / 1000
    const dpr = Math.min(devicePixelRatio, MAX_DPR)
    const w = canvas.width / dpr
    const h = canvas.height / dpr
    const snap = lastSnap
    const body = pred.body
    const alive = !!snap?.you?.alive && snap.phase === "live"
    const mapCenter = { x: gs.map.size[0] / 2, y: gs.map.size[1] / 2 }

    if (seconds < gs.freezeUntil) acc = 0
    else acc += dt
    cam.fit(w, h, gs.map.size[0], gs.map.size[1], !alive)
    controls.cursor = cam.toWorld(controls.mouse.x, controls.mouse.y, w, h)
    while (acc >= DT) {
      acc -= DT
      const origin = body ?? mapCenter
      controls.cursor = cam.toWorld(controls.mouse.x, controls.mouse.y, w, h)
      let intent: Intent = controls.sample(origin)
      if (!alive) intent = { ...intent, mx: 0, my: 0, fire: false, gadget: -1, use: false }
      const sent = pred.step(intent, gs.walls)
      if (net) net.send({ type: "intent", seq: sent.seq, i: sent.i })
    }

    const focus = (alive || snap?.phase === "loadout") && body ? body : mapCenter
    cam.follow(focus.x, focus.y, dt)
    cam.fit(w, h, gs.map.size[0], gs.map.size[1], !alive)

    const actors: Actor[] = []
    const keep = new Set<string>()
    if (snap) {
      for (const o of snap.others) {
        const k = shown.get(o.id) ?? { x: o.x, y: o.y, aim: o.aim, alpha: 0 }
        const f = 1 - Math.exp(-dt * 18)
        k.x += (o.x - k.x) * f
        k.y += (o.y - k.y) * f
        k.aim = o.aim
        k.alpha = Math.min(1, k.alpha + dt * 8)
        shown.set(o.id, k)
        const color = colorOf(snap, o.id, o.team, o.key)
        actors.push({ id: o.id, x: k.x, y: k.y, aim: k.aim, color })
      }
      for (const id of [...shown.keys()]) if (!snap.others.some((o) => o.id === id)) shown.delete(id)
    }
    const meRow = snap?.roster.find((r) => r.id === myId)
    const meColor = meRow ? colorOf(snap, myId, meRow.team, meRow.key) : ([1, 1, 1] as [number, number, number])
    const me =
      alive && body
        ? { x: body.x, y: body.y, aim: Math.atan2(controls.cursor.y - body.y, controls.cursor.x - body.x), color: meColor, alive: true }
        : null

    gs.prune(seconds)
    renderer.render(buildFrame({ g: gs, cam, inst, now: seconds, width: w, height: h, me, actors }))
    hud.update(gs, snap, seconds, myId, !!snap && snap.phase === "live" && !alive && !!snap.you)
    hud.killcam(gs, snap, seconds)

    if (snap) {
      for (const o of snap.others) {
        const k = shown.get(o.id)
        if (!k) continue
        keep.add(o.id)
        hud.setLabel(o.id, o.name, w / 2 + (k.x - cam.x) * cam.ppm, h / 2 + (k.y - cam.y) * cam.ppm - 26, k.alpha > 0.5, false, colorOf(snap, o.id, o.team, o.key))
      }
      if (me) {
        keep.add(myId)
        hud.setLabel(myId, name, w / 2 + (me.x - cam.x) * cam.ppm, h / 2 + (me.y - cam.y) * cam.ppm - 26, true, true, meColor)
      }
    }
    hud.clearLabels(keep)
    hud.minimap(gs, snap, seconds, me ? { x: me.x, y: me.y, aim: me.aim } : null, snap?.others ?? [])
    const near = gs.nearRing
    sound.heart(near.d < 12 && seconds - near.t < 1 && alive ? 60 + 70 * (1 - near.d / 12) : 0)
    if (noticeUntil && performance.now() > noticeUntil && notice.textContent) {
      notice.textContent = ""
      noticeUntil = 0
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  panels.landing(room, name)
}

void main()
