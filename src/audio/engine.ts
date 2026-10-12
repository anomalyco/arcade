// Wings audio engine: wires Core + engine voices + SFX behind the GameAudio contract.
import type { GameAudio } from "../audio"
import type { GameEvent, Vec3, VehicleEntity } from "../sim/types"
import { Core, MASTER_TRIM } from "./core"
import { Storm, type StormSettings, thunder } from "./ambience"
import { ENGINE_LOUDNESS, ENGINE_REF, EngineVoice } from "./engines"
import * as sfx from "./sfx"

/** Max simultaneous engine voices (own vehicle included). */
const MAX_ENGINE_VOICES = 8
/** Nearest N remote engines get HRTF; the rest use cheap equal-power panning. */
const HRTF_ENGINES = 3
/** Don't build more than this many engine graphs per frame (avoids spikes on mass spawn). */
const MAX_NEW_VOICES_PER_FRAME = 2

export interface AudioStats {
  state: AudioContextState | "unavailable" | "locked" | "disposed"
  muted: boolean
  volume: number
  engineVoices: number
  oneShots: number
  held: number
  hrtf: number
  /** Active one-shots per category (e.g. "flak", "explosion", "thunder"). */
  categories: Record<string, number>
}

export interface GameAudioEngine extends GameAudio {
  /** Optional: local player id, so `hit.by` / `kill.killer` can trigger shooter feedback. */
  setLocalPlayer(playerId: string | null): void
  /** Peak absolute sample of the master output over the last ~43 ms (0 when silent/locked). */
  peak(): number
  /** Current master-output spectrum in dB per FFT bin (bin width = sampleRate / 2048). Debug/tests. */
  spectrum(): Float32Array
  stats(): AudioStats
  readonly context: AudioContext | null
}

interface Candidate { v: VehicleEntity; score: number; own: boolean }

export function createAudio(): GameAudioEngine {
  const AC: typeof AudioContext | undefined = typeof window !== "undefined"
    ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    : undefined
  let core: Core | null = null
  let storm: Storm | null = null
  const stormSettings: StormSettings = {}
  /** Recent 5-inch aim points: an explosion near one is a flak burst. */
  const flakAims: { p: Vec3; t: number }[] = []
  let failed = !AC
  let disposed = false
  let muted = false
  let volume = 0.8
  let ownId: string | null = null
  let localPlayer: string | null = null
  let lastVehicleUpdate = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let peakBuf: Float32Array<ArrayBuffer> | null = null
  let specBuf: Float32Array<ArrayBuffer> | null = null
  const lastListener: Vec3 = [0, 0, 0]
  let lastListenerTime = -1
  const voices = new Map<string, EngineVoice>()
  const dying: EngineVoice[] = []
  const vehicles = new Map<string, VehicleEntity>()
  const candidates: Candidate[] = []
  const candidatePool: Candidate[] = []

  const gestureEvents = ["pointerdown", "keydown", "touchend"] as const
  const onGesture = () => api.unlock()
  const onVisibility = () => {
    if (!core) return
    // Hidden tabs stop rAF, which would freeze engine loops at their last state: suspend instead.
    if (document.hidden) void core.ctx.suspend().catch(() => undefined)
    else if (!disposed) void core.ctx.resume().catch(() => undefined)
  }
  if (typeof document !== "undefined" && !failed) {
    for (const e of gestureEvents) document.addEventListener(e, onGesture, { capture: true })
    document.addEventListener("visibilitychange", onVisibility)
  }

  function removeGestureListeners(): void {
    if (typeof document === "undefined") return
    for (const e of gestureEvents) document.removeEventListener(e, onGesture, { capture: true })
  }

  /** Live core only when unlocked, running and audible. */
  function live(): Core | null {
    if (!core || disposed || muted || core.ctx.state !== "running") return null
    return core
  }

  function guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      if (failed || disposed) return
      try { fn(...args) } catch (err) {
        console.warn("[audio]", err)
      }
    }
  }

  function housekeep(): void {
    if (!core) return
    const now = core.now
    // Watchdog: if the game stopped calling updateVehicles (menu, disconnect), fade engines out.
    if (performance.now() - lastVehicleUpdate > 500) {
      if (voices.size) {
        for (const voice of voices.values()) { voice.release(); dying.push(voice) }
        voices.clear()
      }
      // Keep the storm bed (gusts, background thunder) alive in menus.
      storm?.update(0, muted)
    }
    for (let i = dying.length - 1; i >= 0; i--) {
      if (now >= dying[i].stopAt) {
        dying[i].dispose()
        dying[i] = dying[dying.length - 1]
        dying.pop()
      }
    }
    // Moving gun loops follow their vehicle.
    for (const h of core.helds.values()) {
      if (!h.vehicleId || !h.spatial) continue
      const v = vehicles.get(h.vehicleId)
      if (v) h.moveTo(v.flight.position)
    }
    core.housekeep()
  }

  function releaseAllVoices(): void {
    for (const voice of voices.values()) { voice.release(); dying.push(voice) }
    voices.clear()
  }

  function positionOf(id: string): Vec3 | null {
    return vehicles.get(id)?.flight.position ?? null
  }

  /** True (and consumes the aim) if a 5-inch shell aimed near `at` was fired in the last 8 s. */
  function takeFlakAim(at: Vec3, now: number): boolean {
    for (let i = flakAims.length - 1; i >= 0; i--) {
      const a = flakAims[i]
      if (now - a.t > 8) { flakAims.splice(0, i + 1); break }
      const dx = a.p[0] - at[0], dy = a.p[1] - at[1], dz = a.p[2] - at[2]
      if (dx * dx + dy * dy + dz * dz < 150 * 150) { flakAims.splice(i, 1); return true }
    }
    return false
  }

  function isOwnVehicle(id: string): boolean {
    return id === ownId
  }

  const api: GameAudioEngine = {
    get context() {
      return core?.ctx ?? null
    },

    unlock: guard(() => {
      if (!core) {
        try {
          core = new Core(new AC!({ latencyHint: "interactive" }))
        } catch (err) {
          failed = true
          removeGestureListeners()
          console.warn("[audio] Web Audio unavailable, running silent", err)
          return
        }
        core.master.gain.value = muted ? 0 : volume * MASTER_TRIM
        storm = new Storm(core)
        storm.configure(stormSettings)
        timer = setInterval(() => { try { housekeep() } catch { /* ignore */ } }, 250)
      }
      if (core.ctx.state !== "running") {
        void core.ctx.resume().then(() => {
          if (core?.ctx.state === "running") removeGestureListeners()
        }).catch(() => undefined)
      } else removeGestureListeners()
    }),

    setListener: guard((position: Vec3, forward: Vec3, up: Vec3) => {
      if (!core) return
      const t = performance.now() / 1000
      const lv = core.listenerVelocity
      if (lastListenerTime > 0) {
        const dt = t - lastListenerTime
        if (dt > 0.001 && dt < 0.5) {
          for (let i = 0; i < 3; i++) {
            const v = (position[i] - lastListener[i]) / dt
            lv[i] += (v - lv[i]) * 0.3
          }
          // Camera cuts/respawns would read as Mach 10: clamp.
          const m = Math.hypot(lv[0], lv[1], lv[2])
          if (m > 400) for (let i = 0; i < 3; i++) lv[i] *= 400 / m
        }
      }
      lastListenerTime = t
      for (let i = 0; i < 3; i++) {
        lastListener[i] = position[i]
        core.listener[i] = position[i]
      }
      const l = core.ctx.listener
      if (l.positionX) {
        l.positionX.value = position[0]; l.positionY.value = position[1]; l.positionZ.value = position[2]
        l.forwardX.value = forward[0]; l.forwardY.value = forward[1]; l.forwardZ.value = forward[2]
        l.upX.value = up[0]; l.upY.value = up[1]; l.upZ.value = up[2]
      } else {
        l.setPosition(position[0], position[1], position[2])
        l.setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2])
      }
    }),

    updateVehicles: guard((list: VehicleEntity[], own: string | null) => {
      ownId = own
      lastVehicleUpdate = performance.now()
      vehicles.clear()
      for (const v of list) vehicles.set(v.id, v)
      const c = live()
      if (!c) {
        if (voices.size) releaseAllVoices()
        storm?.update(0, true)
        housekeep()
        return
      }
      // Score: estimated loudness at the listener. Existing voices get a hysteresis bonus so
      // two similar vehicles don't keep swapping voices (which would click).
      candidates.length = 0
      let pi = 0
      let ownSpeed = 0
      for (const v of list) {
        if (!v.alive) continue
        const isOwn = v.id === own
        let score: number
        if (isOwn) {
          score = Infinity
          const vel = v.flight.velocity
          ownSpeed = Math.hypot(vel[0], vel[1], vel[2])
        } else {
          const d = c.distanceTo(v.flight.position)
          const ref = ENGINE_REF[v.kind]
          score = ENGINE_LOUDNESS[v.kind] * (0.5 + 0.5 * v.flight.throttle) * (ref / (ref + Math.max(0, d - ref)))
          if (score < 0.004) continue
          if (voices.has(v.id)) score *= 1.4
        }
        const cand = candidatePool[pi] ?? (candidatePool[pi] = { v, score, own: isOwn })
        pi++
        cand.v = v; cand.score = score; cand.own = isOwn
        candidates.push(cand)
      }
      candidates.sort((a, b) => b.score - a.score)
      if (candidates.length > MAX_ENGINE_VOICES) candidates.length = MAX_ENGINE_VOICES

      // Release voices that fell out of the selection (or whose vehicle changed type/died).
      for (const [id, voice] of voices) {
        let keep = false
        for (const cand of candidates) if (cand.v.id === id && cand.v.kind === voice.kind) { keep = true; break }
        if (!keep) { voice.release(); dying.push(voice); voices.delete(id) }
      }
      let created = 0
      let rank = 0
      for (const cand of candidates) {
        let voice = voices.get(cand.v.id)
        if (!voice) {
          if (created >= MAX_NEW_VOICES_PER_FRAME) continue
          voice = new EngineVoice(c, cand.v.id, cand.v.kind, cand.v)
          voices.set(cand.v.id, voice)
          created++
        }
        voice.update(cand.v, cand.own, !cand.own && rank < HRTF_ENGINES)
        if (!cand.own) rank++
      }
      storm?.update(own && vehicles.get(own)?.alive ? ownSpeed : 0, false)
      housekeep()
    }),

    event: guard((e: GameEvent, position: Vec3 | null, local: boolean) => {
      const c = live()
      if (!c) return
      switch (e.type) {
        case "fire": {
          const own = local || isOwnVehicle(e.vehicle)
          const at = position ?? positionOf(e.vehicle)
          // Legacy client path: fleet AA forwarded as fire events with an "aa:<ship>:<turret>" vehicle id.
          if (e.vehicle.startsWith("aa:")) {
            if (!at) break
            if (e.weapon === "gau8") sfx.ciws(c, e.vehicle, at)
            else if (c.allow(e.vehicle, 0.3)) sfx.navalGun(c, at)
            break
          }
          switch (e.weapon) {
            case "cannon20":
            case "gau8":
              sfx.rotaryGun(c, e.vehicle, e.weapon, at, own)
              break
            case "chaingun30":
              if (c.allow(`cg:${e.vehicle}`, 0.05)) sfx.chaingun(c, at, own)
              break
            case "rockets":
              if (c.allow(`rk:${e.vehicle}`, 0.06)) sfx.rocket(c, at, own)
              break
            case "bomb":
              if (c.allow(`bomb:${e.vehicle}`, 0.3)) sfx.bombWhistle(c, at, own)
              break
            case "radarpulse":
              if (c.allow(`pulse:${e.vehicle}`, 1)) sfx.radarPulse(c, at, own)
              break
            default:
              if (c.allow(`ms:${e.vehicle}`, 0.15)) sfx.missile(c, e.weapon, at, own)
          }
          break
        }
        case "hit": {
          const weGotHit = local || isOwnVehicle(e.target)
          if (weGotHit) sfx.hitLocal(c, e.damage)
          else {
            if (c.allow(`hit:${e.target}`, 0.03)) sfx.hitRemote(c, position ?? e.position, e.damage >= 50)
            if ((localPlayer && e.by === localPlayer) || (ownId && e.by === ownId)) sfx.hitMarker(c)
          }
          break
        }
        case "kill":
          if (ownId && e.victim === ownId) sfx.deathSting(c)
          else if (local || (localPlayer !== null && e.killer === localPlayer)) sfx.killSting(c)
          break
        case "aa": {
          const at = position ?? e.position
          if (e.kind === "ciws") sfx.ciws(c, `aa:${e.ship}:${e.turret}`, at)
          else {
            if (c.allow(`aa:${e.ship}:${e.turret}`, 0.3)) sfx.navalGun(c, at)
            flakAims.push({ p: e.aim, t: c.now })
            if (flakAims.length > 32) flakAims.shift()
          }
          break
        }
        case "explosion": {
          const at = position ?? e.position
          if ((e as { kind?: string }).kind === "flak" || takeFlakAim(at, c.now)) sfx.flakBurst(c, at)
          else sfx.explosion(c, at, e.size)
          break
        }
        case "flares":
          if (c.allow(`fl:${e.vehicle}`, 0.4)) sfx.flares(c, position ?? positionOf(e.vehicle), local || isOwnVehicle(e.vehicle))
          break
        case "lock":
          if (ownId && e.target === ownId) {
            // Being locked: solid warble when the enemy has a lock, a soft chirp while they track.
            if (e.locked) sfx.cockpitTone(c, "warning")
            else if (c.allow("tracked", 0.8)) sfx.uiBlip(c, "hover")
          } else if (local || isOwnVehicle(e.vehicle)) {
            sfx.cockpitTone(c, e.locked ? "locked" : "lock-tone")
          }
          break
        case "pulse":
          if (c.allow(`pulse:${e.vehicle}`, 1)) sfx.radarPulse(c, position ?? e.position, local || isOwnVehicle(e.vehicle))
          break
        case "chat":
          sfx.uiBlip(c, "chat")
          break
        case "match-end":
          sfx.matchEnd(c)
          break
        case "score":
          break
      }
    }),

    ui: guard((name) => {
      const c = live()
      if (!c) return
      if (name === "lock-tone" || name === "locked" || name === "warning") sfx.cockpitTone(c, name)
      else sfx.uiBlip(c, name)
    }),

    thunder: guard((delaySeconds: number, intensity: number) => {
      const c = live()
      if (c) thunder(c, delaySeconds, intensity)
    }),

    setStorm: guard((settings: StormSettings) => {
      Object.assign(stormSettings, settings)
      storm?.configure(settings)
    }),

    setMuted: guard((m: boolean) => {
      muted = m
      if (!core) return
      core.master.gain.setTargetAtTime(m ? 0 : volume * MASTER_TRIM, core.now, 0.02)
      // Muted = no new graphs at all; existing loops fade and are collected.
      if (m) releaseAllVoices()
    }),

    setVolume: guard((v: number) => {
      volume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.8))
      if (core && !muted) core.master.gain.setTargetAtTime(volume * MASTER_TRIM, core.now, 0.02)
    }),

    setLocalPlayer(playerId) {
      localPlayer = playerId
    },

    peak() {
      if (!core) return 0
      const a = core.analyser
      if (!peakBuf || peakBuf.length !== a.fftSize) peakBuf = new Float32Array(a.fftSize)
      a.getFloatTimeDomainData(peakBuf)
      let m = 0
      for (let i = 0; i < peakBuf.length; i++) {
        const v = Math.abs(peakBuf[i])
        if (v > m) m = v
      }
      return m
    },

    spectrum() {
      if (!core) return new Float32Array(0)
      const a = core.analyser
      if (!specBuf || specBuf.length !== a.frequencyBinCount) specBuf = new Float32Array(a.frequencyBinCount)
      a.getFloatFrequencyData(specBuf)
      return specBuf
    },

    stats() {
      return {
        state: disposed ? "disposed" : failed ? "unavailable" : core ? core.ctx.state : "locked",
        muted, volume,
        engineVoices: voices.size,
        oneShots: core?.shots.length ?? 0,
        held: core?.helds.size ?? 0,
        hrtf: core?.hrtfInUse ?? 0,
        categories: Object.fromEntries([...(core?.categoryCount ?? [])].filter(([, n]) => n > 0)),
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      removeGestureListeners()
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility)
      if (timer) clearInterval(timer)
      try {
        for (const v of voices.values()) v.dispose()
        for (const v of dying) v.dispose()
        voices.clear()
        dying.length = 0
        storm?.dispose()
        core?.dispose()
        void core?.ctx.close().catch(() => undefined)
      } catch { /* never throw on teardown */ }
      core = null
    },
  }
  return api
}
