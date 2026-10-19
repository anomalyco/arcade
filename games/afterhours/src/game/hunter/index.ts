import type { World } from "../../boot/world"
import type { Flow } from "../flow"
import { transmitter } from "../../world/interior/storeys/s3/transmitter-state"
import { Hunter, type CatchInfo } from "./brain"
import { HunterDebug, type PlayerTrail } from "./debug"
import { NavGraph, storeyOf } from "./nav"
import { PlayerNoises } from "./senses"
import { emitNoise, lastLoudNoise } from "./noise"
import { hunterControls, num } from "./settings"

// The Wendigo hunter (owner's design, after the 3-08 transmitter shutoff). `installHunter(world)` builds the nav graph
// over the finished building, the (dormant) creature and the player's noise sources; the hunter wakes when the
// transmitter goes off:
//   off +0 s      silence (the interior's transmitter beat ducks the building)
//   off +3.0 s    a huge scream far outside, by the cars (distant, muffled through the shell)
//   crash         the interior's metal crunch (transmitter.ts, phase "aftermath"; we fall back to our own at +6 s)
//   crash +0.35   a car alarm starts honking; +2.2 a second crunch (the car being wrecked)
//   crash +8      the alarm dies mid-honk; +9.5 the lobby glass breaks; +10.5 it is in the lobby, investigating
//                 the last loud noise (the switch in 3-08, unless the player has been louder since)
// From then on everything it does is the hunter's (brain.ts); the random horror layer is held off.
// Debug: `?hunter` starts it in the lobby straight away (`?hunter=x,z,storey` elsewhere); `?hunterDebug` shows the
// overlay (also Lab → Hunter). Automation: `globalThis.__ashwoodHunter`.

/** Where the outside sounds come from: the cars in the lot by the entrance (transmitter.ts CRASH_AT). */
const CAR = { x: 4, y: 1.2, z: 48 }
const SCREAM_AT = { x: 9, y: 2.0, z: 62 }
const LOBBY_GLASS = { x: 0, y: 1.3, z: 21.8 }
const SPAWN = { x: 0, z: 19.2, s: 0 }
/** 3-08's TX POWER switch (transmitter.ts), the default "last loud noise". */
const SWITCH = { x: 10.9, z: -7.68, s: 3 }

export type HunterHandle = {
  readonly hunter: Hunter
  readonly nav: NavGraph
  update(dt: number): void
  /** Start now at (x, z, storey) (default the lobby, investigating the last loud noise). */
  start(x?: number, z?: number, s?: number): void
  /** The entry sequence (as if the transmitter had just been switched off). */
  enter(): void
  /** After a checkpoint load: the creature somewhere far from the player, memory wiped, a grace period. */
  restore(grace?: number): void
  /** What happens when it catches the player (the creature agent's death and jump-scare path). */
  setCatchHandler(fn: (info: CatchInfo) => void): void
  dispose(): void
}

let current: HunterHandle | null = null
/** The live hunter, if one is installed (checkpoints, the death flow). */
export const hunterHandle = () => current

export function installHunter(world: World, o: { flow?: Flow; signal?: AbortSignal; start?: string | null; debug?: boolean } = {}): HunterHandle {
  current?.dispose()
  const { ctx, player } = world
  hunterControls(ctx)
  const nav = new NavGraph(ctx)
  const seed = Number(ctx.params.get("hunterSeed") ?? NaN)
  const hunter = new Hunter(ctx, player, world.scene, nav, Number.isFinite(seed) ? seed : undefined)
  const noises = new PlayerNoises(ctx, player, hunter.ownDoorIds)
  const playerTrail: PlayerTrail = []
  const debug = new HunterDebug(hunter, nav, playerTrail)
  if (o.debug) ctx.settings["hunter.debug"] = 1
  console.info(`hunter: nav ${nav.buildMs.toFixed(0)} ms, ${nav.doors.length} doors, ${nav.rooms.length} rooms`)

  // Catching the player: until the death path lands, a stub (event + a red flash in debug).
  let catchHandler: ((info: CatchInfo) => void) | null = null
  hunter.onCatch = (info) => {
    dispatchEvent(new CustomEvent("ashwood:caught", { detail: info }))
    if (catchHandler) return catchHandler(info)
    console.warn("hunter: caught the player (death path not wired yet)", info)
    flash()
    if (!o.flow) setTimeout(() => hunter.release(), 3000)
  }

  const holdHorror = () => {
    ctx.settings["audio.horrorLayer"] = 0
  }

  // ------------------------------------------------------------------------------------------- the entry
  let entryT = -1
  let crashAt = -1
  let stopAlarm: (() => void) | null = null
  const fired = new Set<string>()
  const once = (k: string, at: number, fn: () => void) => {
    if (entryT >= at && !fired.has(k)) {
      fired.add(k)
      fn()
    }
  }
  const towardLoud = () => {
    const n = lastLoudNoise()
    if (n && performance.now() / 1000 - n.t < 240) {
      const s = storeyOf(n.y)
      const p = nav.snap(s, n.x, n.z, 4)
      if (p) return { x: p.x, z: p.z, s }
    }
    return nav.snap(SWITCH.s, SWITCH.x, SWITCH.z, 4) ? { ...nav.snap(SWITCH.s, SWITCH.x, SWITCH.z, 4)!, s: SWITCH.s } : undefined
  }
  const spawnLobby = () => {
    holdHorror()
    // It comes through the front: the entrance doors fly open.
    for (const d of nav.doors) if (d.s === 0 && Math.hypot(d.cx - LOBBY_GLASS.x, d.cz - LOBBY_GLASS.z) < 4) ctx.doors.drive(d.id, 1, { from: { x: 0, z: 30 }, rate: 4 })
    hunter.mode = "roam"
    hunter.spawn(SPAWN.x, SPAWN.z, SPAWN.s, { toward: towardLoud() })
  }
  const enter = () => {
    if (entryT >= 0 || hunter.mode !== "dormant") return
    holdHorror()
    entryT = 0
    crashAt = -1
    fired.clear()
    console.info("hunter: entry sequence")
  }
  const entry = (dt: number) => {
    if (entryT < 0) return
    entryT += dt
    once("scream", 3.0, () => hunter.voice.farScream(SCREAM_AT))
    if (crashAt < 0 && entryT > 6) {
      crashAt = entryT
      hunter.voice.wreck(CAR)
    }
    if (crashAt < 0) return
    const c = crashAt
    once("alarm", c + 0.35, () => (stopAlarm = hunter.voice.carAlarm(CAR)))
    once("wreck", c + 2.2, () => hunter.voice.wreck(CAR))
    once("alarm-off", c + 8, () => stopAlarm?.())
    once("glass", c + 9.5, () => hunter.voice.glass(LOBBY_GLASS))
    once("spawn", c + 10.5, () => {
      spawnLobby()
      entryT = -1
    })
  }
  const offTx = transmitter.on((phase) => {
    if (phase === "off") {
      // The switch's heavy clunk is the last loud noise it will have heard.
      emitNoise(player.state.pos, 30, "switch")
      enter()
    } else if (phase === "aftermath" && entryT >= 0 && crashAt < 0) crashAt = entryT
  })

  // ------------------------------------------------------------------------------------------- frame
  let clock = 0
  let trailAt = 0
  const update = (dt: number) => {
    clock += dt
    noises.update(dt)
    entry(dt)
    if (hunter.mode !== "dormant") holdHorror()
    hunter.update(dt)
    debug.visible = num(ctx, "hunter.debug") > 0
    debug.update(clock)
    if (clock >= trailAt) {
      trailAt = clock + 0.25
      const p = player.state.pos
      playerTrail.push({ t: +hunter.time.toFixed(2), x: +p.x.toFixed(2), z: +p.z.toFixed(2), s: storeyOf(p.y) })
      if (playerTrail.length > 4000) playerTrail.splice(0, 1000)
    }
  }
  const offFlow = o.flow?.onUpdate((dt) => update(dt))

  const handle: HunterHandle = {
    hunter,
    nav,
    update: (dt) => {
      if (!o.flow) update(dt)
    },
    start(x = SPAWN.x, z = SPAWN.z, s = SPAWN.s) {
      holdHorror()
      entryT = -1
      if (hunter.mode === "dormant") hunter.mode = "roam"
      hunter.spawn(x, z, s, x === SPAWN.x && z === SPAWN.z ? { toward: towardLoud() } : {})
    },
    enter,
    restore(grace) {
      holdHorror()
      entryT = -1
      stopAlarm?.()
      hunter.restore(grace)
    },
    setCatchHandler(fn) {
      catchHandler = fn
    },
    dispose() {
      offTx()
      offFlow?.()
      stopAlarm?.()
      noises.dispose()
      hunter.dispose()
      debug.dispose()
      if (current === handle) current = null
    },
  }
  current = handle
  o.signal?.addEventListener("abort", () => handle.dispose())
  ;(globalThis as { __ashwoodHunter?: unknown }).__ashwoodHunter = {
    handle,
    hunter,
    nav,
    debug,
    playerTrail,
    noise: emitNoise,
    trace: (s?: number, ppm?: number, since?: number) => debug.trace(s, ppm, since),
  }
  if (o.start !== undefined && o.start !== null) {
    const parts = o.start.split(",").map(Number)
    if (parts.length === 3 && parts.every(Number.isFinite)) handle.start(parts[0], parts[1], parts[2])
    else handle.start()
  }
  return handle
}

function flash() {
  const d = document.createElement("div")
  d.textContent = "CAUGHT"
  d.style.cssText =
    "position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(120,0,0,0.55);color:#fff;font:700 64px monospace;letter-spacing:12px;pointer-events:none;transition:opacity 1.2s"
  document.body.appendChild(d)
  setTimeout(() => (d.style.opacity = "0"), 1200)
  setTimeout(() => d.remove(), 2600)
}
