import "./style.css"
import "@fontsource/barlow-condensed/600.css"
import "@fontsource/barlow-condensed/800.css"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { openGpu } from "@arcade/kit/gpu/boot"
import { audioRuntimeSync, createGameShell, createShellQuality } from "@arcade/kit/shell"
import type { QualityScaling, QualityTiers } from "@arcade/kit/quality"
import { ARENAS } from "../shared/arena"
import { GAME, MAX_PLAYERS } from "../shared/config"
import { Controls, type Device } from "./game/controls"
import { Game, type Seat } from "./game/game"
import { OnlineSession } from "./net/online"
import { Renderer } from "./render/renderer"
import { Sound } from "./sound"
import { Hud } from "./ui/hud"

/** Resolution only; High is the 1.5× cap Archers always drew at. */
const ARCHERS_QUALITY: QualityTiers<QualityScaling> = {
  high: { tier: "high", label: "High (1.5×)", dprCap: 1.5, minScale: 0.75 },
  balanced: { tier: "balanced", label: "Balanced (1.25×)", dprCap: 1.25, minScale: 0.7 },
  low: { tier: "low", label: "Low (1×)", dprCap: 1, minScale: 0.6 },
}
const BOT_NAMES = ["TEAL", "WINE", "MOSS", "OCHRE"]

/** A room code from the URL, if it looks like one. */
const roomCode = (v: string | null) => (v && /^[a-z0-9]{4,8}$/i.test(v) ? v.toLowerCase() : null)

/**
 * Local couch play. `?watch` is four bots (captures use it); otherwise one keyboard player against bots, with
 * gamepads joining on A and a second keyboard player on Enter (the keyboard splits in two). `?arena=cloister|aqueduct` and
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
  const invite = () => void shell.lobby!.copyInvite()
  // The title, Escape menu and Settings are the kit game shell. Couch play pauses behind the menu; a room keeps going.
  // Joining a room reloads into it (`?room=`), as P always did.
  const quality = createShellQuality({ game: GAME.id, tiers: ARCHERS_QUALITY, params, onChange: () => shell.settings.changed() })
  const split = () => seats.some((s) => s.device === "kbR")
  let creating = false
  const shell = createGameShell({
    game: GAME.id, title: GAME.title, subtitle: "Arena archery for up to four", soloLabel: "Play", soloNote: "you and bots; pads join with A",
    quickLabel: "Play online", friendsNote: "a private room", quality, channels: ["master", "effects"],
    // M is the right-hand player's jump once Enter splits the keyboard.
    muteKey: () => !split(),
    start: watch ? "playing" : undefined,
    controls: () => [keyPromptHtml("KeyW", "Move"), keyPromptHtml("Space", "Jump"), keyPromptHtml("ShiftLeft", "Shoot"), keyPromptHtml("KeyE", "Dodge"), keyPromptHtml("Enter", "Split keyboard"), keyPromptHtml("KeyM", "Mute"), keyPromptHtml("Escape", "Menu")].join(" "),
    lobby: {
      friends: true, quick: true,
      // Play is couch play right here (the shell plays on); without onSolo the title would offer rooms only.
      onSolo: () => {},
      // Play with friends makes a private room (kept out of Play online's matchmaking).
      createRoom: () => {
        creating = true
        return fetch(`${location.pathname.replace(/[^/]*$/, "")}api/create`, { method: "POST", cache: "no-store" })
          .then((r) => r.json() as Promise<{ room?: string }>)
          .then((r) => r.room ?? "")
      },
      onJoin: (code) => (location.search = `?room=${code}${creating ? "&private=1" : ""}`),
    },
    onLeave: () => {
      if (room) location.search = ""
    },
  })
  if (room) shell.lobby!.setRoom(room)
  // Keys drive a seat only in play: paused (a room keeps going behind the menu), nobody's held keys act.
  const syncControls = () => {
    controls.enabled = shell.playing
    if (!shell.playing) controls.release()
  }
  shell.flow.subscribe(syncControls)
  syncControls()
  const syncAudio = audioRuntimeSync(shell.settings, sound.runtime)
  if (params.get("focus")) {
    game.focus = params.get("focus")
    game.focusSpan = Number(params.get("span")) || 6
  }

  const resize = () => {
    if (quality.fit(canvas, innerWidth, innerHeight)) renderer.resize(canvas.width, canvas.height)
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
    shell.tick(now)
    syncAudio()
    if (shell.playing) quality.frame(now)
    else quality.pause()
    if (quality.fit(canvas, innerWidth, innerHeight)) renderer.resize(canvas.width, canvas.height)
    // Couch play holds still on the title and behind the menu; a room's clock is the room's.
    const live = shell.playing || !!game.online
    if (!watch && shell.playing) {
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
      if (controls.pressed("Digit3")) game.setArena("aqueduct")
      if (controls.pressed("KeyP")) void shell.lobby!.quickMatch()
    }
    if (live) game.update(realDt)
    renderer.render(game.build(innerWidth, innerHeight, live ? dt : 0))
    sound.listen(game.cam.cx, game.cam.cy)
    const o = game.online
    hud.update(game, innerWidth, innerHeight, (!watch || !!o?.ready) && now - started < 14000)
    if (o) {
      hud.net(room, o.rtt, o.fatal, invite)
      if (o.fatal) shell.lobby!.setConnection("lost", o.fatal)
      else shell.lobby!.setSocketStatus(o.socket.status() ?? (o.ready ? null : "Connecting…"))
    }
    controls.endFrame()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
