import type { Aim, FallingChunk, FeedEntry, Frame, LiveProjectile, Screen, UIState } from "./contracts"
import { createRenderer } from "./render/index"
import { createUI } from "./ui/index"
import { connectOnline, createLocal, createRoom, roomFromLocation, roomLink, type Transport } from "./net"
import { loadProfile, saveProfile } from "./profile"
import { TEAM_COLORS, type MatchView, type PathOut, type ServerMsg, type Shot, type SimEvent, type Unit, type VolleyResult } from "../sim/protocol"
import { generateTerrain, spawnPoints, unpackMask, type Mask } from "../sim/terrain"
import { chunkLand, chunkRemove, decodeChunk, applyTerrainEvent } from "../sim/replay"
import { predictPath } from "../sim/predict"
import { clampAngle, clampPower } from "../sim/volley"
import { WEAPON_IDS, type WeaponId } from "../sim/weapons"

const canvas = document.getElementById("world") as HTMLCanvasElement
const root = document.getElementById("ui") as HTMLElement
const renderer = createRenderer(canvas)

let profile = loadProfile()
let transport: Transport | null = null
let you: string | null = null
let view: MatchView | null = null
let pendingView: MatchView | null = null
let mask: Mask | null = null
let aim: Aim | null = null
let aimSent = ""
let aimSentAt = 0
let feed: FeedEntry[] = []
let feedId = 0
let lastPickup: UIState["lastPickup"] = null
let lastVolleyKey = ""

interface Pending {
  at: number
  run: () => void
}

interface Playback {
  shots: Shot[]
  result: VolleyResult
  after: MatchView
  units: Unit[]
  t: number
  idx: number
  pending: Pending[]
  chunks: FallingChunk[]
  chunkMeta: Map<number, { y0: number; dy: number; t0: number; dur: number }>
  fires: Frame["fires"]
  wells: Frame["wells"]
  moves: Map<number, { x0: number; y0: number; x1: number; y1: number; t0: number; dur: number }>
  timeScale: number
  slowUntil: number
  stopUntil: number
  kills: number
}

let playback: Playback | null = null

function me(): MatchView["players"][number] | undefined {
  return view?.players.find((p) => p.id === you)
}

function myUnit(units: Unit[] | undefined = view?.units): Unit | undefined {
  const p = me()
  if (!p || p.spectator) return undefined
  return units?.find((u) => u.id === p.unit)
}

function setMask(packed: string | undefined): void {
  if (!packed) return
  mask = unpackMask(packed)
  renderer.setTerrain(mask)
}

function applyView(next: MatchView): void {
  const prev = view
  view = next
  if (next.mask) setMask(next.mask)
  if (next.phase === "aim" && (prev?.phase !== "aim" || prev?.volley !== next.volley || !aim)) {
    const u = myUnit()
    const weapon = aim && u && u.ammo[aim.weapon] > 0 ? aim.weapon : "shell"
    aim = { angle: u?.angle ?? Math.PI / 4, power: aim?.power ?? 62, weapon }
    aimSent = ""
  }
}

function onMessage(msg: ServerMsg): void {
  switch (msg.type) {
    case "welcome":
      you = msg.you
      playback = null
      applyView(msg.view)
      break
    case "state":
      if (playback) pendingView = msg.view
      else applyView(msg.view)
      break
    case "ghosts":
      if (view) view = { ...view, ghosts: msg.ghosts }
      break
    case "volley": {
      const key = `${msg.before.seed}:${msg.before.battle}:${msg.before.volley}`
      if (key === lastVolleyKey) break
      lastVolleyKey = key
      startPlayback(msg.shots, msg.result, msg.before, msg.after)
      break
    }
    case "notice":
      pushFeed({ text: msg.text })
      break
    case "error":
      pushFeed({ text: msg.message })
      break
    case "pong":
      break
  }
}

function pushFeed(entry: Omit<FeedEntry, "id" | "at">): void {
  feed = [...feed.slice(-5), { id: ++feedId, at: performance.now(), ...entry }]
}

function startPlayback(shots: Shot[], result: VolleyResult, before: MatchView, after: MatchView): void {
  pendingView = null
  applyView(before)
  setMask(before.mask)
  aim = aim ? { ...aim } : null
  playback = {
    shots,
    result,
    after,
    units: before.units.map((u) => ({ ...u })),
    t: 0,
    idx: 0,
    pending: [],
    chunks: [],
    chunkMeta: new Map(),
    fires: [],
    wells: [],
    moves: new Map(),
    timeScale: 1,
    slowUntil: 0,
    stopUntil: 0,
    kills: 0,
  }
}

function dirty(rect: { x0: number; y0: number; x1: number; y1: number } | null): void {
  if (rect) renderer.terrainChanged(rect.x0, rect.y0, rect.x1, rect.y1)
}

function chunkCanvas(ev: Extract<SimEvent, { type: "chunk" }>): HTMLCanvasElement {
  const bits = decodeChunk(ev)
  const c = document.createElement("canvas")
  c.width = ev.w
  c.height = ev.h
  const g = c.getContext("2d")!
  const img = g.createImageData(ev.w, ev.h)
  for (let i = 0; i < bits.length; i++) {
    if (!bits[i]) continue
    const y = Math.floor(i / ev.w)
    const shade = 18 + ((y >> 2) % 3) * 4
    img.data[i * 4] = shade
    img.data[i * 4 + 1] = shade + 4
    img.data[i * 4 + 2] = shade + 12
    img.data[i * 4 + 3] = 255
  }
  for (let i = 0; i < bits.length; i++) {
    if (!bits[i]) continue
    const x = i % ev.w
    const y = Math.floor(i / ev.w)
    const edge = x === 0 || y === 0 || x === ev.w - 1 || y === ev.h - 1 || !bits[i - 1] || !bits[i + 1] || !bits[i - ev.w] || !bits[i + ev.w]
    if (edge) {
      img.data[i * 4] = 120
      img.data[i * 4 + 1] = 210
      img.data[i * 4 + 2] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return c
}

function frameFor(now: number, dt: number): Frame | null {
  if (!view) return null
  const pb = playback
  const units = pb ? pb.units : view.units
  const mu = myUnit(units)
  const resolving = !!pb
  let preview: number[] | null = null
  const ghostArcs: Frame["ghostArcs"] = []
  if (!pb && view.phase === "aim" && mask) {
    if (mu && mu.alive && aim) {
      const len = 46 + (mu.preview ?? 0) * 30
      preview = predictPath(mask, mu, aim.angle, aim.power, view.wind, aim.weapon, len)
    }
    for (const g of view.ghosts) {
      if (mu && g.unit === mu.id) continue
      const u = units.find((x) => x.id === g.unit)
      if (!u || !u.alive) continue
      ghostArcs.push({ unit: g.unit, pts: predictPath(mask, u, g.angle, g.power, view.wind, "shell", 14), locked: g.locked })
    }
  }
  return {
    now,
    dt,
    view,
    you,
    yourUnit: mu?.id ?? -1,
    units,
    aim: !pb && view.phase === "aim" && mu?.alive ? aim : null,
    preview,
    ghostArcs,
    ghosts: view.ghosts,
    projectiles: pb ? projectilesAt(pb.result.paths, pb.t) : [],
    chunks: pb ? pb.chunks : [],
    fires: pb ? pb.fires : [],
    wells: pb ? pb.wells : [],
    timeScale: pb ? pb.timeScale : 1,
    resolving,
  }
}

function projectilesAt(paths: PathOut[], t: number): LiveProjectile[] {
  const out: LiveProjectile[] = []
  for (const p of paths) {
    const n = p.pts.length / 2
    if (n < 2) continue
    const local = (t - p.t0) / p.dt
    if (local < 0 || local > n - 1) continue
    const i = Math.min(n - 2, Math.floor(local))
    const f = local - i
    const x0 = p.pts[i * 2]!
    const y0 = p.pts[i * 2 + 1]!
    const x1 = p.pts[i * 2 + 2]!
    const y1 = p.pts[i * 2 + 3]!
    const x = x0 + (x1 - x0) * f
    const y = y0 + (y1 - y0) * f
    const from = Math.max(0, i - 14)
    const trail = p.pts.slice(from * 2, (i + 1) * 2)
    trail.push(x, y)
    out.push({ id: p.id, owner: p.owner, kind: p.kind, x, y, vx: (x1 - x0) / (p.dt / 1000), vy: (y1 - y0) / (p.dt / 1000), trail })
  }
  return out
}

function runEvent(pb: Playback, ev: SimEvent, frame: Frame, now: number): void {
  if (!mask) return
  switch (ev.type) {
    case "carve":
    case "fill":
      dirty(applyTerrainEvent(mask, ev))
      break
    case "chunk": {
      dirty(chunkRemove(mask, ev))
      const c: FallingChunk = { id: ev.id, canvas: chunkCanvas(ev), x: ev.x, y: ev.y }
      pb.chunks.push(c)
      pb.chunkMeta.set(ev.id, { y0: ev.y, dy: ev.dy, t0: ev.t, dur: ev.dur })
      pb.pending.push({
        at: ev.t + ev.dur,
        run: () => {
          if (!mask) return
          dirty(chunkLand(mask, ev))
          pb.chunks = pb.chunks.filter((x) => x.id !== ev.id)
          renderer.shake(Math.min(1, 0.25 + (ev.w * ev.h) / 6000))
        },
      })
      break
    }
    case "hit": {
      const u = pb.units.find((x) => x.id === ev.unit)
      if (u) {
        u.hp = Math.max(0, u.hp - ev.amount)
        if (ev.kill) {
          u.alive = false
          u.hp = 0
          pb.kills++
          pb.stopUntil = now + 90
          pb.slowUntil = now + (pb.kills > 1 ? 1100 : 650)
          const killer = pb.units.find((x) => x.id === ev.killer)
          pushFeed({
            text: killer && killer.id !== u.id ? `${killer.name} ▸ ${u.name}` : `${u.name} was destroyed`,
            killer: killer && killer.id !== u.id ? killer.name : undefined,
            victim: u.name,
            killerColor: killer ? TEAM_COLORS[killer.team % TEAM_COLORS.length] : undefined,
            victimColor: TEAM_COLORS[u.team % TEAM_COLORS.length],
            weapon: shotWeapon(pb, ev.killer),
          })
        }
      }
      break
    }
    case "absorb": {
      const u = pb.units.find((x) => x.id === ev.unit)
      if (u) u.shield = Math.max(0, u.shield - ev.amount)
      break
    }
    case "shieldUp": {
      const u = pb.units.find((x) => x.id === ev.unit)
      if (u) u.shield = ev.hp
      break
    }
    case "move": {
      const u = pb.units.find((x) => x.id === ev.unit)
      if (u) pb.moves.set(u.id, { x0: u.x, y0: u.y, x1: ev.x, y1: ev.y, t0: ev.t, dur: Math.max(1, ev.dur) })
      break
    }
    case "fall": {
      const u = pb.units.find((x) => x.id === ev.unit)
      if (u) pb.moves.set(u.id, { x0: u.x, y0: u.y, x1: ev.x, y1: ev.y, t0: ev.t, dur: Math.min(500, 80 + Math.sqrt(ev.dy) * 30) })
      break
    }
    case "teleport": {
      const u = pb.units.find((x) => x.id === ev.unit)
      if (u) {
        pb.moves.delete(u.id)
        u.x = ev.x
        u.y = ev.y
      }
      break
    }
    case "fire":
      pb.fires.push({ x0: ev.x0, x1: ev.x1, y: ev.y, until: ev.t + ev.dur })
      break
    case "well":
      pb.wells.push({ x: ev.x, y: ev.y, r: ev.r, until: ev.t + ev.dur })
      break
    case "collide":
      pb.slowUntil = Math.max(pb.slowUntil, now + 380)
      break
    case "crate": {
      const u = pb.units.find((x) => x.id === ev.unit)
      if (u && u.id === myUnit(pb.units)?.id) lastPickup = { kind: ev.kind, detail: ev.detail, at: performance.now() }
      if (u) pushFeed({ text: `${u.name} claimed ${ev.detail}`, killerColor: TEAM_COLORS[u.team % TEAM_COLORS.length] })
      break
    }
    case "boom":
      if (ev.r >= 40) pb.stopUntil = Math.max(pb.stopUntil, now + 50)
      break
    case "builder":
    case "hazard":
      break
  }
  renderer.event(ev, frame)
}

function shotWeapon(pb: Playback, unit: number): WeaponId | undefined {
  return pb.shots.find((s) => s.unit === unit)?.weapon
}

function stepPlayback(pb: Playback, dtMs: number, now: number): void {
  if (now < pb.stopUntil) pb.timeScale = 0.02
  else if (now < pb.slowUntil) pb.timeScale = 0.3
  else pb.timeScale = Math.min(1, pb.timeScale + dtMs / 250)
  pb.t += dtMs * pb.timeScale
  const frame = frameFor(now, dtMs / 1000)
  if (!frame) return
  const events = pb.result.events
  for (;;) {
    const nextEv = pb.idx < events.length ? events[pb.idx]! : null
    pb.pending.sort((a, b) => a.at - b.at)
    const nextPend = pb.pending[0]
    const evAt = nextEv && nextEv.t <= pb.t ? nextEv.t : Infinity
    const pendAt = nextPend && nextPend.at <= pb.t ? nextPend.at : Infinity
    if (evAt === Infinity && pendAt === Infinity) break
    if (pendAt <= evAt) {
      pb.pending.shift()
      nextPend!.run()
    } else {
      pb.idx++
      runEvent(pb, nextEv!, frame, now)
    }
  }
  for (const [id, m] of pb.moves) {
    const u = pb.units.find((x) => x.id === id)
    if (!u) continue
    const f = Math.min(1, Math.max(0, (pb.t - m.t0) / m.dur))
    const e = f * f
    u.x = m.x0 + (m.x1 - m.x0) * f
    u.y = m.y0 + (m.y1 - m.y0) * e
    if (f >= 1) pb.moves.delete(id)
  }
  for (const c of pb.chunks) {
    const m = pb.chunkMeta.get(c.id)
    if (!m) continue
    const f = Math.min(1, Math.max(0, (pb.t - m.t0) / m.dur))
    c.y = m.y0 + m.dy * f * f
  }
  pb.fires = pb.fires.filter((f) => f.until > pb.t)
  pb.wells = pb.wells.filter((w) => w.until > pb.t)
  if (pb.idx >= events.length && pb.pending.length === 0 && pb.t > pb.result.durationMs + 350) finishPlayback(pb)
}

function finishPlayback(pb: Playback): void {
  playback = null
  const next = pendingView && pendingView.now >= pb.after.now ? pendingView : pb.after
  pendingView = null
  applyView({ ...next, mask: next.mask ?? pb.after.mask })
}

function sendAim(force = false): void {
  if (!transport || !aim || !view || view.phase !== "aim" || playback) return
  const key = `${aim.angle.toFixed(3)}:${aim.power.toFixed(1)}:${aim.weapon}`
  const now = performance.now()
  if (!force && (key === aimSent || now - aimSentAt < 70)) return
  aimSent = key
  aimSentAt = now
  transport.send({ type: "aim", angle: aim.angle, power: aim.power, weapon: aim.weapon })
}

function setAim(patch: Partial<Aim>): void {
  if (!aim) return
  const u = myUnit()
  if (patch.weapon && u && u.ammo[patch.weapon] <= 0) delete patch.weapon
  aim = {
    angle: clampAngle(patch.angle ?? aim.angle),
    power: clampPower(patch.power ?? aim.power),
    weapon: patch.weapon ?? aim.weapon,
  }
  sendAim()
}

function locked(): boolean {
  return !!me()?.locked
}

function canAct(): boolean {
  return !!view && view.phase === "aim" && !playback && !!myUnit()?.alive && !locked()
}

function lock(): void {
  if (!canAct() || !transport) return
  sendAim(true)
  transport.send({ type: "lock" })
}

async function play(opts: { online: boolean; room?: string }): Promise<void> {
  if (!profile.name.trim()) return
  transport?.close()
  view = null
  you = null
  playback = null
  if (opts.online) {
    const room = opts.room ?? roomFromLocation() ?? (await createRoom())
    history.replaceState(null, "", roomLink(room))
    transport = connectOnline(room)
  } else {
    transport = createLocal()
  }
  const t = transport
  t.onMessage(onMessage)
  let joined = false
  t.onStatus((s) => {
    if (s === "open" && !joined) {
      joined = true
      t.send({ type: "join", name: profile.name.trim().slice(0, 16) })
      if (!t.online) t.send({ type: "start", mode: "ffa", bots: 5, battles: 3 })
    } else if (s === "open") {
      t.send({ type: "join", name: profile.name.trim().slice(0, 16) })
    }
  })
}

const ui = createUI(root, {
  setName(name) {
    profile = { ...profile, name: name.slice(0, 16) }
    saveProfile(profile)
  },
  play(opts) {
    void play(opts)
  },
  start(opts) {
    transport?.send({ type: "start", ...opts })
  },
  aim(patch) {
    setAim(patch)
  },
  move(dir) {
    if (canAct()) transport?.send({ type: "move", dir })
  },
  lock,
  buy(item) {
    transport?.send({ type: "buy", item })
  },
  ready() {
    transport?.send({ type: "ready" })
  },
  leave() {
    transport?.close()
    transport = null
    view = null
    you = null
    playback = null
    history.replaceState(null, "", roomLink("").replace(/\/r\/?$/, "/"))
  },
})

// Input
const keys = new Set<string>()
let dragging = false

function aimFromPointer(e: PointerEvent): void {
  const u = myUnit()
  if (!u || !canAct()) return
  const rect = canvas.getBoundingClientRect()
  const w = renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  const dx = w.x - u.x
  const dy = u.y - w.y
  const angle = Math.atan2(Math.max(dy, 2), dx)
  const power = Math.hypot(dx, dy) / 3.2
  setAim({ angle, power })
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return
  dragging = true
  canvas.setPointerCapture(e.pointerId)
  aimFromPointer(e)
})
canvas.addEventListener("pointermove", (e) => {
  if (dragging) aimFromPointer(e)
})
canvas.addEventListener("pointerup", (e) => {
  dragging = false
  canvas.releasePointerCapture(e.pointerId)
})
canvas.addEventListener(
  "wheel",
  (e) => {
    if (!aim || !canAct()) return
    e.preventDefault()
    setAim({ power: aim.power - Math.sign(e.deltaY) * 2 })
  },
  { passive: false },
)

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return
  keys.add(e.code)
  if (e.code === "Space") {
    e.preventDefault()
    lock()
  }
  if (!aim || !canAct()) return
  const digit = e.code.match(/^Digit(\d)$/)
  if (digit) {
    const n = digit[1] === "0" ? 9 : Number(digit[1]) - 1
    const id = WEAPON_IDS[n]
    if (id) setAim({ weapon: id })
  }
  if (e.code === "KeyQ" || e.code === "KeyE") {
    const u = myUnit()
    const owned = WEAPON_IDS.filter((id) => (u?.ammo[id] ?? 0) > 0)
    const i = owned.indexOf(aim.weapon)
    const next = owned[(i + (e.code === "KeyE" ? 1 : owned.length - 1)) % owned.length]
    if (next) setAim({ weapon: next })
  }
})
window.addEventListener("keyup", (e) => keys.delete(e.code))
window.addEventListener("blur", () => keys.clear())

let moveAt = 0
function handleHeldKeys(dt: number, now: number): void {
  if (!aim || !canAct()) return
  const fast = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 3 : 1
  const da = (keys.has("ArrowLeft") ? 1 : 0) - (keys.has("ArrowRight") ? 1 : 0)
  const dp = (keys.has("ArrowUp") ? 1 : 0) - (keys.has("ArrowDown") ? 1 : 0)
  if (da || dp) setAim({ angle: aim.angle + da * dt * 0.9 * fast, power: aim.power + dp * dt * 30 * fast })
  const dir = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0)
  if (dir && now - moveAt > 45) {
    moveAt = now
    transport?.send({ type: "move", dir: dir as -1 | 1 })
  }
}

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(window.innerWidth * dpr)
  canvas.height = Math.round(window.innerHeight * dpr)
  renderer.resize(window.innerWidth, window.innerHeight, dpr)
}
window.addEventListener("resize", resize)
resize()

function screen(): Screen {
  if (!transport || !view) return "title"
  if (view.phase === "lobby") return "lobby"
  if (view.phase === "shop") return "shop"
  if (view.phase === "over") return "results"
  return "game"
}

let last = performance.now()
function loop(now: number): void {
  const dtMs = Math.min(50, now - last)
  last = now
  handleHeldKeys(dtMs / 1000, now)
  if (playback) stepPlayback(playback, dtMs, now)
  const frame = frameFor(now, dtMs / 1000)
  if (frame) renderer.draw(frame)
  else renderer.draw(idleFrame(now, dtMs / 1000))
  const p = me()
  feed = feed.filter((f) => now - f.at < 7000)
  ui.update({
    screen: screen(),
    view: playback && view ? { ...view, units: playback.units, phase: "resolve" } : view,
    you,
    aim,
    profile,
    feed,
    roomLink: transport?.online ? roomLink(transport.room) : roomFromLocation() ? roomLink(roomFromLocation()!) : "",
    online: !!transport?.online,
    spectating: !!p?.spectator,
    serverNow: transport ? transport.serverNow() : Date.now(),
    lastPickup,
  })
  requestAnimationFrame(loop)
}

// Title screen backdrop: a live procedural battlefield with no players.
const idleSeed = (Date.now() / 86400000) | 0
let idleView: MatchView | null = null
function idleFrame(now: number, dt: number): Frame {
  if (!idleView) {
    const xs = spawnPoints(idleSeed, 6)
    mask = generateTerrain(idleSeed, xs)
    renderer.setTerrain(mask)
    idleView = {
      room: "",
      mode: "ffa",
      phase: "lobby",
      phaseEndsAt: 0,
      now: 0,
      battle: 0,
      battles: 0,
      volley: 0,
      seed: idleSeed,
      wind: 8,
      hazardY: 9999,
      units: [],
      players: [],
      crates: [],
      ghosts: [],
      battleWinner: null,
      matchWinner: null,
    }
  }
  return { now, dt, view: idleView, you: null, yourUnit: -1, units: [], aim: null, preview: null, ghostArcs: [], ghosts: [], projectiles: [], chunks: [], fires: [], wells: [], timeScale: 1, resolving: false }
}

requestAnimationFrame(loop)

const autoRoom = roomFromLocation()
if (autoRoom && profile.name.trim()) void play({ online: true, room: autoRoom })
