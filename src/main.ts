// Entry point. Kept tiny: the lobby is plain HTML/CSS in index.html; three.js, the world, aircraft,
// audio and the game controller are all dynamically imported after first paint.
import { initLobby, toast, type StartRequest } from "./ui/lobby"
import { callsign, settings, onSettings } from "./ui/settings"
import type { SceneHost } from "./render/scene"
import type { GameAudio } from "./audio"
import type { GameHandle } from "./ui/game"

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
    return host
  }).catch(err => {
    console.error(err)
    lobby.status("<b>3D</b> unavailable — WebGL failed to start")
    hostPromise = null
    throw err
  }))
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
