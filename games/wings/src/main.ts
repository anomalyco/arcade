// Entry point. Kept tiny: the lobby is plain HTML/CSS in index.html; three.js, the world, aircraft,
// audio and the game controller are all dynamically imported after first paint.
import { initLobby, toast, type StartRequest } from "./ui/lobby"
import { callsign, settings, onSettings, updateSettings } from "./ui/settings"
import type { SceneHost } from "./render/scene"
import type { GameAudio } from "./audio"
import type { GameHandle } from "./ui/game"

// First launch (no saved settings): pick Low/Balanced from a quick GPU benchmark once the world is up.
const firstLaunch = (() => { try { return !localStorage.getItem("wings.settings") && !localStorage.getItem("wings.autoQuality") } catch { return false } })()
const perf = { start: performance.timeOrigin, menuMs: 0, sceneMs: 0, worldMs: 0, aircraftMs: 0 }
;(window as unknown as { __wings: unknown }).__wings = { perf, get stats() { return hostRef?.stats }, get game() { return game?.debug() } }

let hostRef: SceneHost | null = null
let hostPromise: Promise<SceneHost> | null = null
let audio: GameAudio | null = null
let audioPromise: Promise<GameAudio | null> | null = null
let game: GameHandle | null = null
let starting = false

const lobby = initLobby({
  onStart: start,
  onQuality: q => hostRef?.setQuality(q),
  onClick: () => audio?.ui("click"),
})
perf.menuMs = performance.now()

function bootScene(): Promise<SceneHost> {
  return (hostPromise ??= import("./render/scene").then(async m => {
    const canvas = document.getElementById("view") as HTMLCanvasElement
    const host = await m.createSceneHost(canvas, settings.quality, s => {
      if (s === "world") { perf.worldMs = performance.now(); lobby.status("<b>World</b> awake") }
      if (s === "aircraft") { perf.aircraftMs = performance.now(); lobby.status("<b>World</b> awake · <b>Hangar</b> ready") }
    })
    perf.sceneMs = performance.now()
    hostRef = host
    if (firstLaunch) autoQuality(host)
    return host
  }).catch(err => {
    console.error(err)
    lobby.status("<b>3D</b> unavailable — WebGL failed to start")
    hostPromise = null
    throw err
  }))
}

function autoQuality(host: SceneHost): void {
  try { localStorage.setItem("wings.autoQuality", "1") } catch {}
  const run = () => {
    if (game || starting || settings.quality === "high") return
    host.benchmark().then(q => {
      if (game || starting || q === settings.quality) return
      updateSettings({ quality: q })
      host.setQuality(q)
    }).catch(() => {})
  }
  // Wait for the world to stream in so the benchmark sees a representative frame.
  let tries = 0
  const wait = () => { if (host.world.ready() || ++tries > 40) setTimeout(run, 800); else setTimeout(wait, 250) }
  wait()
}

function bootAudio(): Promise<GameAudio | null> {
  return (audioPromise ??= import("./audio").then(m => {
    audio = m.createAudio()
    audio.setMuted(settings.muted)
    audio.setVolume(settings.volume)
    return audio
  }).catch(err => { console.warn("audio unavailable", err); return null }))
}

onSettings(s => { audio?.setMuted(s.muted); audio?.setVolume(s.volume) })

const unlock = () => {
  bootAudio().then(a => a?.unlock())
  window.removeEventListener("pointerdown", unlock, true)
  window.removeEventListener("keydown", unlock, true)
}
window.addEventListener("pointerdown", unlock, true)
window.addEventListener("keydown", unlock, true)

// After first paint: start the 3D backdrop, aircraft preload and audio in the background.
requestAnimationFrame(() => setTimeout(() => {
  bootScene().catch(() => {})
  bootAudio()
  // Warm the game controller chunk while the player reads the menu.
  const idle = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 600))
  idle(() => { import("./ui/game").catch(() => {}) })
}, 0))

async function start(req: StartRequest): Promise<void> {
  if (game || starting) return
  starting = true
  lobby.busy(req.mode === "offline" ? "Clearing the runway" : "Connecting")
  try {
    const [{ startGame }, host, a] = await Promise.all([import("./ui/game"), bootScene(), bootAudio()])
    a?.unlock()
    game = await startGame({
      host, audio: a, req, name: callsign(),
      onExit(reason) {
        game = null
        lobby.show()
        if (reason) toast(reason, true)
      },
    })
    lobby.hide()
  } catch (err) {
    console.warn(err)
    const msg = err instanceof Error ? err.message : String(err)
    toast(req.mode === "offline" ? `Practice failed to start: ${msg}` : `Couldn't reach the room: ${msg}`, true)
  } finally {
    starting = false
    lobby.busy(null)
  }
}
