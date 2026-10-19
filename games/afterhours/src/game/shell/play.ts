import type { World } from "../../boot/world"
import { heightAt } from "../../world/height"
import { Flow, type GameContext } from "../flow"
import { createMap, type MapHandle } from "../map"
import { startObjectives } from "../objectives"
import { prepareIntro, runIntro } from "../intro"
import { HINT, HOME } from "./copy"
import { createMenu } from "./menu"
import { createSettingsApplier, loadSettings, saveSettings } from "./settings"
import { createTitleCard } from "./title"
import { createTunerAudio } from "./tuner-audio"
import { createHints } from "./hints"

// Play mode: the home screen over a slow drift past the foggy station while the world loads behind it, then
// Play → title card → intro (src/game/intro) → explore, with an Esc pause menu. Owns input gating: the controller's
// `inputEnabled` follows active play (keys, mouse look and pointer capture), its `debugKeys` (N fly, digit viewpoints)
// are off, and outside active play no key reaches the other game listeners (the lift's) either.

/** Seconds the pause menu ducks the master volume to. */
const PAUSE_DUCK = 0.35
/** The night ambience (wind, rain, forest) under the home screen and the title card: −12 dB. */
const MENU_AMBIENCE = 0.25
/** The ui bus's default level (src/audio/game.ts), scaled by the SFX slider as settings.ts does. */
const UI_LEVEL = 0.6
/** Seconds into the lock's vertical roll when the picture catches (the thunk). */
const LOCK_THUNK_S = 0.35

export type PlayShell = ReturnType<typeof createPlayShell>

export function createPlayShell(canvas: HTMLCanvasElement, hud: HTMLElement) {
  const flow = new Flow()
  const settings = loadSettings()
  let world: World | null = null
  let apply: ReturnType<typeof createSettingsApplier> | null = null
  let worldReady = false
  let pendingPlay = false
  let run: AbortController | null = null
  let skip: AbortController | null = null
  /** Control hints (the bottom-left strip and the one-time contextual hints), created with the world. */
  let hints: ReturnType<typeof createHints> | null = null
  /** The loading screen's static: started by the first input, stopped for good at Play. */
  const tunerAudio = createTunerAudio()
  let tunerDone = false
  /** The clipboard map (src/game/map), created the first time a run reaches explore. Esc lowers it before pausing. */
  let map: MapHandle | null = null
  flow.onPhase((to) => {
    if (to === "explore" && world) {
      map ??= createMap(world, { active: () => flow.playerActive })
      startObjectives(flow, world.camera, run?.signal)
    }
    if (to !== "explore") map?.lower()
  })

  /** Applies the player's settings with the ducks for where the run is (pause, the menus). */
  const levels = () => apply?.(settings, flow.paused ? PAUSE_DUCK : 1, flow.phase === "menu" || flow.phase === "title" ? MENU_AMBIENCE : 1)
  flow.onPhase(() => levels())
  const menu = createMenu(document.body, settings, {
    play,
    resume,
    quit,
    settingsChanged(s) {
      saveSettings(s)
      hints?.setMode(s.controls)
      tunerAudio.setVolume(s.menuStatic)
      levels()
    },
    characterChanged(id) {
      if (world) world.ctx.settings["player.character"] = id
    },
    input() {
      if (!tunerDone && !tunerAudio.playing) {
        tunerAudio.start({ master: settings.master, ui: UI_LEVEL * settings.sfx, menuStatic: settings.menuStatic })
        menu.soundOn()
      }
      world?.player.audio?.unlock()
    },
    tunerFrame(signal) {
      tunerAudio.update(signal)
    },
  })
  const title = createTitleCard(document.body)
  title.el.addEventListener("click", () => skip?.abort())
  const locked = () => document.pointerLockElement === canvas
  /**
   * Input reaches the controller in active play, and in the intro (its cutscene stands in for `player.update` and reads
   * the mouse look and its skip keys).
   */
  const inputOpen = () => flow.playerActive || (flow.phase === "intro" && !flow.paused)
  const lock = () => {
    try {
      const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined
      p?.catch?.(() => updateHint())
    } catch {}
  }

  // Input gating. Window capture runs ahead of every game listener (the controller's are window/document bubble).
  addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (menu.screen !== "none") {
        menu.key(e)
        e.stopImmediatePropagation()
        return
      }
      if (flow.phase === "title") {
        if (e.code === "Space" || e.code === "Enter" || e.code === "Escape") skip?.abort()
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      // The intro owns its keys (hold Space/Esc to skip); Esc pauses only in explore (or the pointer-lock loss does).
      if (flow.phase === "explore" && !flow.paused && e.code === "KeyH" && !e.repeat) hints?.toggle()
      if (flow.phase === "explore" && e.code === "Escape" && !e.repeat) {
        if (map?.raised) map.lower()
        else pause()
        e.stopImmediatePropagation()
        return
      }
      if (!inputOpen()) e.stopImmediatePropagation()
    },
    { capture: true },
  )
  document.addEventListener("pointerlockchange", () => {
    if (!locked()) {
      // Esc with the map up releases the pointer lock first: it lowers the map instead of opening the pause menu.
      if (map?.raised && !flow.paused) map.lower()
      else if (flow.phase === "title") skip?.abort()
      else if ((flow.phase === "intro" || flow.phase === "explore") && !flow.paused) pause()
    }
    updateHint()
  })

  function play() {
    if (!worldReady || !world) {
      pendingPlay = true
      menu.setWaiting(true)
      return
    }
    void start(world)
  }

  async function start(w: World) {
    pendingPlay = false
    menu.setWaiting(false)
    tunerDone = true
    tunerAudio.stop()
    w.player.audio?.unlock()
    lock()
    menu.show("none")
    run?.abort()
    const r = (run = new AbortController())
    skip = new AbortController()
    r.signal.addEventListener("abort", () => skip?.abort())
    flow.set("title")
    await title.play(skip.signal)
    if (r.signal.aborted) return
    flow.set("intro")
    w.ctx.settings["body.show"] = true
    const ctx: GameContext = { world: w, ctx: w.ctx, player: w.player, camera: w.camera, scene: w.scene, flow, hud, signal: r.signal }
    title.fadeOut()
    try {
      await runIntro(ctx)
    } catch (e) {
      console.error("intro:", e)
      w.player.teleport("lot")
    }
    if (r.signal.aborted) return
    flow.set("explore")
    hints?.setActive(true)
    updateHint()
  }

  function pause() {
    if (flow.paused || flow.phase === "menu") return
    flow.setPaused(true)
    world?.player.release()
    levels()
    menu.show("pause")
    updateHint()
    if (locked()) document.exitPointerLock()
  }

  function resume() {
    menu.show("none")
    flow.setPaused(false)
    levels()
    lock()
    updateHint()
  }

  function quit() {
    hints?.setActive(false)
    run?.abort()
    run = null
    title.hide()
    flow.set("menu")
    world?.player.release()
    if (world) world.ctx.settings["body.show"] = false
    levels()
    if (locked()) document.exitPointerLock()
    menu.show("home")
    updateHint()
  }

  function updateHint() {
    if (flow.phase !== "explore" || flow.paused) {
      hud.innerHTML = ""
      return
    }
    hud.innerHTML = locked() ? "" : `<div class="hint">${HINT.look}</div>`
  }

  /** The home screen's camera: a slow sway up the access road towards the gate, the dish in the fog beyond it. */
  function drift(w: World, time: number) {
    const x = -2.5 + 2.2 * Math.sin(time * 0.021)
    const z = 154 + 5 * Math.sin(time * 0.013 + 1)
    const cam = w.camera
    cam.position.set(x, heightAt(x, z) + 1.9 + 0.15 * Math.sin(time * 0.031), z)
    cam.rotation.set(0.035 + 0.008 * Math.sin(time * 0.027), -0.05 + 0.05 * Math.sin(time * 0.017 + 0.5), 0, "YXZ")
    cam.updateMatrixWorld()
  }

  ;(globalThis as { __static?: unknown }).__static = { mode: "play", flow, settings, play, pause, resume, quit, skip: () => skip?.abort(), tuner: { level: () => tunerAudio.level(), playing: () => tunerAudio.playing }, get map() { return map }, get hints() { return hints } }

  return {
    flow,
    progress: (label: string, f: number) => menu.progress(label, f),
    fail: (message: string) => menu.fail(message || HOME.failed),
    /** The world exists (first frame drawable): apply settings (invert Y included), hide the body for the menu camera,
     *  drop the debug keys and close input until a run starts. */
    attach(w: World) {
      world = w
      apply = createSettingsApplier(w.ctx, w.camera)
      levels()
      w.ctx.settings["body.show"] = false
      w.player.debugKeys = false
      w.player.inputEnabled = inputOpen()
      hints = createHints(w.ctx, w.player)
      hints.setMode(settings.controls)
    },
    /** After the world drew a frame (same task): the loading screen's picture, the hints' darkness check. */
    afterRender(source: HTMLCanvasElement) {
      menu.snapshot(source)
      hints?.afterRender(source)
    },
    /** Everything is streamed and warm: Play can start. */
    ready() {
      worldReady = true
      void menu.lock()
      setTimeout(() => {
        if (!tunerDone) tunerAudio.lock()
      }, LOCK_THUNK_S * 1000)
      // The intro's car loads and compiles while the home screen is up (idle time), not under the title card.
      if (world) void prepareIntro(world).catch((e: unknown) => console.error("intro prepare:", e))
      if (pendingPlay && world) void start(world)
    },
    /** One frame of the shell before the world renders: menu camera, controller, then the run's hooks. */
    frame(dt: number, time: number) {
      if (!world) return
      if (flow.phase === "menu") drift(world, time)
      // In the intro, `player.update` is the cutscene's frame (src/game/intro), so it runs there too.
      const open = inputOpen()
      world.player.inputEnabled = open
      if (open) world.player.update(dt)
      // Outside play the controller doesn't step, so its audio (levels, listener, night ambience) is stepped here.
      else world.player.audio?.update(dt, world.camera)
      flow.update(dt, time)
      hints?.update(dt, flow.phase === "explore" && !flow.paused)
    },
  }
}
