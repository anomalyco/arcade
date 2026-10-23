import "./style.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import { EQUIP_IDS, type Equip, GUN_IDS, type Gun } from "../shared/config"
import type { MapChoice } from "../shared/maps"
import { cleanName, NAME_MAX } from "../shared/protocol"
import { modeChoices, type ModeId, modeOf } from "../shared/sim/modes"
import { Sound } from "./audio/sound"
import { Game, SandboxSession } from "./game/game"
import { Input, type MuxState } from "./game/input"
import { NetSession, REJOIN_KEY } from "./game/net"
import { LocalSession, type Session } from "./game/session"
import { Camera } from "./render/camera"
import { Renderer } from "./render/renderer"
import { Hud } from "./ui/hud"
import { LandingPicks, Menus } from "./ui/menus"
import { ModeHud } from "./ui/modes-hud"
import { cameraShakeSettings, DebugOverlay, juiceSettings, LOOK_LABELS } from "./ui/debug-overlay"
import { GpuPerf } from "@arcade/kit/gpu-perf"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { createGameShell, createShellQuality, type GameShell } from "@arcade/kit/shell"
import { BLACKOUT_QUALITY } from "./quality"
import { openGpu } from "@arcade/kit/gpu/boot"
import { registerGameCommands } from "@arcade/kit/dev-control"
import { Rng } from "../shared/rng"
import { SpellHud } from "./ui/spell-hud"

const GUN_KEY = "blackout.gun"
const EQUIP_KEY = "blackout.equip"

async function gpu(canvas: HTMLCanvasElement): Promise<{ renderer: Renderer; telemetry: GpuPerf } | string> {
  const g = await openGpu(canvas, "BLACKOUT")
  if (typeof g === "string") return g
  const telemetry = new GpuPerf(g.device)
  return { renderer: new Renderer(g.device, g.context, g.format), telemetry }
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const menuEl = document.getElementById("menu")!
  const graphics = await gpu(canvas)
  if (typeof graphics === "string") {
    menuEl.className = "full"
    menuEl.innerHTML = `<div class="landing"><div class="logo">BLACKOUT</div><div class="notice">${graphics}</div></div>`
    return
  }
  const params = new URLSearchParams(location.search)
  const { renderer, telemetry } = graphics
  const roomParam = (params.get("room") ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || null
  const storedGun = localStorage.getItem(GUN_KEY) as Gun | null
  let gun: Gun = storedGun && GUN_IDS.includes(storedGun) ? storedGun : "rifle"
  const storedEquip = localStorage.getItem(EQUIP_KEY) as Equip | null
  let equip: Equip = storedEquip && EQUIP_IDS.includes(storedEquip) ? storedEquip : "frag"
  const sound = new Sound()
  const input = new Input(canvas)
  const cam = new Camera()
  const settings = juiceSettings(params.get("vanilla") !== "1")
  // The panel owns presentation controls; comparison/capture automation can request the baseline.
  const automatedLook = params.get("mux") === "1" || params.has("bench") || params.has("manualVideo")
  if (automatedLook && params.get("look") === "0") for (const key of Object.keys(LOOK_LABELS) as (keyof typeof LOOK_LABELS)[]) settings[key] = false
  if (params.has("monitors")) settings.monitors = params.get("monitors") === "1"
  const debug = new DebugOverlay(settings, params, () => { input.release(); input.forward({ type: "mux-release" }) })
  // Resolution, bloom and smoke volumes follow the quality tier: Auto starts High and steps down only on slow frames (Settings).
  let shell: GameShell | null = null
  const quality = createShellQuality({
    game: "blackout",
    tiers: BLACKOUT_QUALITY,
    params,
    gpuMs: () => telemetry.gpuMs ?? renderer.lastGpuMs,
    onChange: (tier) => {
      renderer.setBloomLevels(tier.bloomLevels)
      shell?.settings.changed()
    },
  }).expose()
  renderer.setBloomLevels(quality.profile.bloomLevels)
  input.onWheel = (delta) => {
    if (game?.snap?.spells) { if (delta) game.selectedSpell = game.selectedSpell === "moon" ? "necromancy" : "moon"; return }
    cam.zoomOffset = Math.max(-10, Math.min(24, cam.zoomOffset + Math.sign(delta)))
  }
  const hud = new Hud(document.getElementById("hud")!)
  const spellHud = new SpellHud(document.getElementById("hud")!)
  const modeHud = new ModeHud(document.getElementById("hud")!)
  let session: Session | null = null
  let game: Game | null = null
  input.castSpell = () => game?.selectedSpell ?? "moon"

  const begin = (name: string, s: (name: string) => Session) => {
    const clean = cleanName(name)
    sound.start()
    session?.close()
    input.release()
    session = s(clean)
    game = new Game(renderer, session, sound, settings)
    menus.hide()
    hud.show(true)
  }
  const stop = () => {
    session?.close()
    session = null
    game = null
    scores = false
    hud.show(false)
    menus.hide()
  }
  const fatal = (message: string) => {
    shell?.flow.leave()
    stop()
    shell?.lobby?.setRoom(null)
    shell?.lobby?.setConnection("offline", message)
  }
  const base = location.pathname.replace(/[^/]*$/, "")
  const api = (path: string) => fetch(`${base}api/${path}`, { method: "POST" }).then((r) => r.json() as Promise<{ room: string }>)
  const enter = (name: string, room: string, priv = false, mode: ModeId | null = null, maps: MapChoice | null = null) => {
    begin(name, (n) => new NetSession(room, n, gun, equip, fatal, priv, mode, maps))
  }
  const vote = (mode: ModeId) => session?.send({ type: "vote", mode })
  const rawSeed = Number(params.get("seed") ?? 1)
  const seed = Number.isFinite(rawSeed) ? rawSeed : 1
  const sandbox = (name: string) => {
    const random = new Rng(seed)
    Math.random = () => random.next()
    begin(name, (n) => new SandboxSession(n, input.mux ? "rifle" : gun, input.mux ? "frag" : equip, seed, modeOf(params.get("mode")) ?? "ffa"))
    if (session instanceof SandboxSession) (globalThis as { practice?: unknown }).practice = session.world
    cam.zoomOffset = 0
    game!.update(0, input, cam, innerWidth, innerHeight, 0)
    if (game!.body) cam.snap(game!.body.x, game!.body.y)
    cam.update(innerWidth / innerHeight)
  }
  let scores = false
  const menus = new Menus(menuEl, {
    vote,
    team: (id, team) => session?.send({ type: "team", id, team }),
    shuffle: () => session?.send({ type: "shuffle" }),
    maps: (maps) => session?.send({ type: "host", action: "maps", maps }),
    host: (mode, newFloor) => session?.send(mode ? { type: "host", action: "mode", mode, newFloor } : { type: "host", action: "reset", newFloor }),
  })
  // Back from a version reload: straight into the same room.
  const rejoin = sessionStorage.getItem(REJOIN_KEY)
  sessionStorage.removeItem(REJOIN_KEY)
  const direct = params.get("peaceful") === "1" || params.get("sandbox") === "1" || input.mux || params.has("practice") || Boolean(rejoin && rejoin === roomParam)
  // The title, lobby, Escape menu and Settings are the kit game shell; mode and map picks sit in its title slot.
  // Creating a room passes the picks to the server with the first join.
  let creating = false
  const picks = new LandingPicks(() => {
    sandbox(gameShell.lobby!.playName)
    gameShell.flow.play()
  })
  const gameShell = createGameShell({
    game: "blackout", title: "BLACKOUT", subtitle: "Firefights at night: office floors and downtown streets.",
    quickLabel: "Quick join", soloLabel: "Bot practice", friendsNote: "a private room",
    askName: true, quality, channels: ["master", "effects", "ambience"],
    hidden: input.mux ? true : undefined,
    keysBlocked: () => debug.hasFocus(),
    start: direct ? "playing" : "title",
    controls: () => [keyPromptHtml("KeyW", "Move"), keyPromptHtml("Mouse0", "Shoot"), keyPromptHtml("Mouse2", "Look"), keyPromptHtml("Tab", "Scores"), keyPromptHtml("KeyM", "Mute"), keyPromptHtml("Escape", "Menu")].join(" "),
    lobby: {
      friends: true, quick: true, maxName: NAME_MAX, fallbackName: "stranger",
      createRoom: () => {
        creating = true
        return api("create").then((r) => r.room)
      },
      onSolo: (name) => {
        begin(name, (n) => new LocalSession(n, gun, equip, picks.mode))
        gameShell.flow.play()
      },
      onJoin: (room, name) => {
        enter(name, room, creating, creating ? picks.mode : null, creating ? picks.maps : null)
        creating = false
        gameShell.flow.play()
      },
    },
    onLeave: () => {
      stop()
      gameShell.lobby!.setRoom(null)
    },
  })
  shell = gameShell
  // Keys and the mouse drive only in play: not behind the title or menu, nor while the Lab panel holds input.
  input.blocked = () => !gameShell.playing || debug.holdsInput
  gameShell.flow.subscribe(() => {
    if (!gameShell.playing) input.release()
  })
  const lobby = gameShell.lobby!
  gameShell.view?.titleSlot.append(picks.el)
  // The shell owns volume, mute and Reduce camera motion (the shake settings' switch).
  const syncSound = () => {
    sound.setVolumes(gameShell.settings.volumes)
    sound.setMuted(gameShell.settings.muted)
    cameraShakeSettings.reduceMotion = gameShell.settings.reduceMotion ? 1 : 0
    debug.refresh()
  }
  gameShell.settings.subscribe(syncSound)
  syncSound()
  if (!direct) fetch(`${base}api/stats`)
    .then((r) => r.json() as Promise<{ players: number; games: number }>)
    .then((s) => picks.stats(s.players, s.games))
    .catch(() => {})
  input.onKey = (code) => {
    if (code === "Backquote") debug.toggle()
    if (!gameShell.playing) return
    if (code === "KeyB" && params.get("peaceful") !== "1" && session instanceof SandboxSession) session.toggleBots()
    // T keeps the scoreboard open (the host picks teams there) until pressed again.
    if (code === "KeyT") scores = !scores
    // Between floors the number keys vote for the next mode.
    if (game?.snap?.phase === "end") {
      const v = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(code)
      const choices = modeChoices(game.snap.mode.id)
      const offer = (game.snap.mode.votes?.options ?? choices).filter((id) => choices.includes(id))
      if (v >= 0 && offer[v]) vote(offer[v])
      return
    }
    const i = ["Digit1", "Digit2", "Digit3"].indexOf(code)
    if (game?.snap?.spells && code.startsWith("Digit")) {
      if (i === 0 || i === 1) game.selectedSpell = i === 0 ? "moon" : "necromancy"
      return
    }
    if (i >= 0 && session) {
      gun = GUN_IDS[i]!
      localStorage.setItem(GUN_KEY, gun)
      session.send({ type: "gun", gun })
    }
    const e = ["Digit4", "Digit5"].indexOf(code)
    if (e >= 0 && session) {
      equip = EQUIP_IDS[e]!
      localStorage.setItem(EQUIP_KEY, equip)
      session.send({ type: "equip", equip })
    }
  }
  if (rejoin && rejoin === roomParam) {
    enter(lobby.name, rejoin)
    lobby.setRoom(rejoin)
  }
  // Dev and screenshots: a local match against bots, no server.
  if (params.get("peaceful") === "1" || params.get("sandbox") === "1" || input.mux) sandbox(lobby.name || "you")
  else if (params.has("practice")) begin(lobby.name || "you", (n) => new LocalSession(n, gun, equip, modeOf(params.get("mode")) ?? "ffa", params.get("map")))

  let blackoutBlastTimer = 0
  registerGameCommands(commands => {
    commands.registerAll([
      {
        id: "explosion.trigger",
        label: "Trigger Explosion",
        shortLabel: "Explosion",
        category: "Scene",
        undoable: false,
        args: {
          preset: { type: "string", description: "Explosion preset (grenade, car, pop)" },
          repeat: { type: "boolean", description: "Repeat explosion every 2.2s" },
        },
        enabled: () => true,
        run: (_ctx, args) => {
          if (blackoutBlastTimer) {
            window.clearInterval(blackoutBlastTimer)
            blackoutBlastTimer = 0
          }
          const preset = String(args?.preset ?? "grenade")
          const fire = () => {
            if (!game) return
            const b = game.body
            const aim = game.aim
            const bx = b ? b.x + Math.cos(aim) * 3.6 : game.map.size[0] / 2
            const by = b ? b.y + Math.sin(aim) * 3.6 : game.map.size[1] / 2
            ;(game as unknown as { explode(e: unknown, p?: string): void }).explode(
              { k: "explode", id: -1, by: "tour", x: bx, y: by, kind: preset === "pop" ? "claymore" : "frag", aim },
              preset === "car" ? "car" : preset === "pop" ? "pop" : "grenade",
            )
          }
          fire()
          if (args?.repeat !== false) {
            blackoutBlastTimer = window.setInterval(fire, 2200)
          }
          return { triggered: preset, repeat: args?.repeat !== false }
        },
      },
    ])
  })

  const resize = () => {
    if (quality.fit(canvas, innerWidth, innerHeight)) renderer.resize(canvas.width, canvas.height)
    document.documentElement.style.setProperty("--hud", String(Math.max(0.55, Math.min(1, innerWidth / 1500, innerHeight / 950))))
  }
  resize()
  addEventListener("resize", resize)

  let last = performance.now()
  let muxTick = 0
  const ready = () => input.forward({ type: "mux-ready", protocol: 1, map: game?.map.seed, mode: game?.snap?.mode.id, ...game?.muxState() })
  const validState = (s: unknown): s is MuxState => {
    if (!s || typeof s !== "object") return false
    return ["x", "y", "vx", "vy", "aim", "tx", "ty"].every((key) => Number.isFinite((s as Record<string, unknown>)[key]))
  }
  addEventListener("message", (event) => {
    if (!input.accepts(event)) return
    const m = event.data
    if (m?.type === "mux-reset") { location.reload(); return }
    if (m?.type === "mux-hello") { ready(); return }
    if (!game || !session) return
    // The parent clocks simulation; rendering still runs independently for honest frame-rate measurements.
    if ((m?.type === "mux-step" || m?.type === "mux-sync") && Number.isFinite(m.dt) && Number.isFinite(m.now)) {
      if (!Number.isInteger(m.tick) || m.tick !== muxTick + 1) return
      muxTick = m.tick
      const dt = Math.max(0, Math.min(0.1, m.dt))
      input.enabled = game.snap?.phase === "play" || session instanceof SandboxSession
      game.update(dt, input, cam, innerWidth, innerHeight, m.now, m.type === "mux-sync" && validState(m) ? m : undefined)
      if (m.type === "mux-sync" && validState(m)) game.sync(m, false)
      else if (game.body) game.drawn.reset(game.body)
      if (game.body) cam.snap(game.body.x, game.body.y)
      input.forward({ type: m.type === "mux-step" ? "mux-state" : "mux-done", tick: m.tick, ...game.muxState() })
    } else if (m?.type === "mux-sync" && validState(m)) game.sync(m)
  })
  ready()
  // Automation clock: scripted mouse paths still use real Input and shared simulation.
  const manual = params.has("manual") && params.get("sandbox") === "1"
  let manualNow = 0
  let manualRenderDt = 0
  if (params.has("bench")) Object.assign(globalThis, { wizardProof: { get game() { return game }, cam, input } })
  if (manual) Object.assign(globalThis, { advance: async (ms: number) => {
    for (let i=0;i<Math.ceil(ms/(1000/60));i++) {
      manualNow+=1000/60
      manualRenderDt+=1/60
      input.enabled=game?.snap?.phase==="play"
      game?.update(1/60,input,cam,innerWidth,innerHeight,manualNow)
      if (game?.body) cam.snap(game.body.x,game.body.y)
      if (i%3===2) await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
    }
    if (game?.body) cam.snap(game.body.x,game.body.y)
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
  } })
  const frame = (now: number) => {
    if (manual) now=manualNow
    const elapsed = manual ? 0 : now - last
    const dt = Math.min(0.1, elapsed / 1000)
    last = now
    const w = innerWidth
    const h = innerHeight
    gameShell.tick(now)
    if (manual || !gameShell.playing) quality.pause()
    else quality.frame(now)
    if (quality.fit(canvas, w, h)) renderer.resize(canvas.width, canvas.height)
    if (game && session) {
      cam.pitch = game.snap?.spells ? settings.wizardPitch : 1.1
      // Paused bot practice and the sandbox stop the clock; a room keeps playing behind the menu.
      const frozen = !gameShell.playing && !session.room
      input.enabled = gameShell.playing && game.snap?.phase === "play"
      if (!input.mux && !frozen) game.update(dt, input, cam, w, h, now)
      const body = game.body ? game.drawn : null
      const alive = game.alive
      // Out for the round in search and destroy: watch a teammate.
      const spec = modeHud.spectate(game)
      const fx = spec?.x ?? body?.x ?? game.map.size[0] / 2
      const fz = spec?.y ?? body?.y ?? game.map.size[1] / 2
      // Look-ahead: the view leans toward the cursor; holding right click leans much further (scouting, sniping).
      const far = input.looking && alive
      const k = far ? 0.65 : 0.35
      const cap = far ? 11 : 5
      // Driving, it leads ahead along the road instead.
      const lead = alive && !far ? game.vehicleLead() : null
      const lx = lead ? lead.x : alive && body ? Math.max(-cap, Math.min(cap, (game.cursor.x - body.x) * k)) : 0
      const lz = lead ? lead.y : alive && body ? Math.max(-cap * 0.7, Math.min(cap * 0.7, (game.cursor.y - body.y) * k)) : 0
      cam.follow(fx, fz, input.mux ? 0 : lx, input.mux ? 0 : lz, dt, !body, alive && !!game.riding)
      if (input.mux && body) { cam.snap(body.x, body.y); cam.dist = 24 + cam.zoomOffset }
      const scene = game.build(cam, w, h, manual ? manualRenderDt : frozen ? 0 : dt)
      if (!quality.profile.volumes) scene.smokeEnabled = false
      renderer.render(scene)
      manualRenderDt=0
      const status = session.status()
      // The HUD shows the idle warning itself; the shell's pill shows connection trouble.
      const idle = status && /idle/i.test(status) ? status : null
      if (session.room) lobby.setSocketStatus(idle ? null : status)
      hud.update(game, cam, w, h, input.mouse, idle)
      spellHud.draw(game)
      modeHud.update(game, cam, w, h)
      menus.update(game.snap, game.roster, session.myId, session.room, gameShell.playing && (input.held("Tab") || scores), (id) => game!.colorOf(id))
      telemetry.enabled = debug.visible || input.mux || quality.wantsGpuTiming
      const chunks = renderer.drawnChunks
      const perf = debug.sample(now, elapsed, telemetry, chunks, game.lightCount)
      if (perf && parent !== window) {
        const screen = body ? cam.project(body.x, 0.85, body.y, w, h) : null
        parent.postMessage({ type: "arcade-perf", ...perf, ...game.muxState(), tick: muxTick, map: game.map.seed, alive, screenX: screen ? screen.x / w : null, screenY: screen ? screen.y / h : null, run: input.muxRun }, input.parentOrigin)
      }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
