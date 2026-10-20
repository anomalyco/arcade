import * as THREE from "three/webgpu"
import type { GameContext } from "../flow"
import { story } from "../objectives"
import { liftEvents } from "../../world/interior/lift-events"
import { CORE } from "../../world/layout"
import { FLOOR_Y, STOREY_H } from "../../world/interior/api"
import { createWendigo, type Wendigo } from "../../creatures/wendigo"
import { audio } from "../../audio/context"
import { aimBone } from "../../creatures/kit/ik"

// The lift ambush (the first Wendigo beat). Once the player has been in the radio room (3-08), riding the lift is
// fatal, but nothing says so: the ride and the doors opening are perfectly normal and the lobby looks empty. The
// Wendigo is out of sight beside the opening (flat against the lobby wall, never drawn until it moves). The moment
// the player steps out over the threshold (or, if they wait inside, a short random delay after the doors are fully
// open, or as soon as they try to close them) it comes in from the side: the skull fills the view in ~0.25 s, the
// scream hits on the same frame, a hard jolt, the red flood, the death screen (src/game/death). No camera takeover,
// no held beat, no hidden HUD: the player has control until the hit.
// (The hunter's catch, `killFrom`, keeps its short turn-and-beat version.)
//
// The creature, its shaders and the scream are loaded and warmed when the player first enters 3-08, so the scare
// never hitches. Automation: `__ashwoodAmbush` (state, `arm()`, `trigger(storey)`).

/** Scream file, shipped as-is (approved take: audio-lab/sfx/wen2-huge-scream/v1.mp3). */
const SCREAM_URL = "sfx/monsters/wen2-huge-scream.mp3"
/** Seconds between the doors opening enough to see it and the lunge. */
const BEAT = 0.6
/** Where it stands: centred on the lift doors, ~1.9 m out into the lobby (skull hangs ~0.5 m further forward). */
const DOOR_X = -37.85
const STAND_Z = CORE.liftLobby.min[1] + 1.05
const floorY = (s: number) => FLOOR_Y + s * STOREY_H

export type AmbushHooks = {
  /** Called at the kill (the red flood is up): the caller shows the death screen. */
  onKill: () => void
  /** The red flood, started at the moment of impact. */
  flood: () => void
  /** True while another death is under way (the lift ambush then stands down). */
  busy?: () => boolean
  /** The lift ambush has started (the caller quiets the hunter). */
  onAmbush?: () => void
}

export type AmbushPhase = "idle" | "loading" | "armed" | "lurk" | "pounce" | "waiting" | "beat" | "lunge" | "dead"
/** Seconds the skull takes from beside the door into the lens. */
const _dn = new THREE.Vector3(0, -0.12, 0)
const POUNCE_S = 0.35
/** Where the neck joint ends up in front of the eye (m); the skull, snout first, reaches to ~0.15 m. */
const END_D = 0.85
/** The landing doors' lobby face (the threshold the player steps over). */
const THRESHOLD_Z = 19.45

export function startLiftAmbush(g: GameContext, hooks: AmbushHooks) {
  const { scene, camera, flow, world } = g
  let wendigo: Wendigo | null = null
  let loading: Promise<void> | null = null
  let scream: AudioBuffer | null = null
  let phase: AmbushPhase = "idle"
  let storey = 0
  let t = 0
  let ground = 0
  const look = new THREE.Vector3()
  const vel = new THREE.Vector3()
  const head = new THREE.Vector3()
  const camBase = new THREE.Vector3()
  const q0 = new THREE.Quaternion()
  const q1 = new THREE.Quaternion()
  const m = new THREE.Matrix4()
  const fov0 = camera.fov
  let shake = 0
  let jolt = 0
  const stats = { warmMs: 0, maxFrameMs: 0, frames: 0, ambushAt: 0, frameMs: [] as number[] }

  /** Loads the creature and the scream, compiles its pipelines and draws it once out of sight. */
  const preload = () => {
    if (loading) return loading
    phase = "loading"
    const t0 = performance.now()
    loading = (async () => {
      const w = createWendigo({ ground: () => ground })
      w.root.visible = false
      scene.add(w.root)
      await w.ready
      w.root.traverse((o) => {
        o.castShadow = true
        o.frustumCulled = false
      })
      // Settle a pose so the first visible frame isn't the bind pose.
      w.update(1 / 30, { mode: "idle", stance: "biped" })
      // Pipelines: compile now (in slices around frames), then draw it a few frames far under the ground so every pass
      // that will draw it (scene, depth, shadows) has met it before the scare.
      const meshes: THREE.Object3D[] = []
      w.root.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o))
      await world.warmup.warmObjects(meshes).catch(() => {})
      w.root.position.set(DOOR_X, -60, STAND_Z)
      w.root.visible = true
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r))
      w.root.visible = false
      wendigo = w
      // The scream: decoded now (an offline context if the game's isn't running yet; buffers play in any context).
      try {
        const bytes = await (await fetch(new URL(SCREAM_URL, document.baseURI).href)).arrayBuffer()
        const ctx = audio()?.ctx ?? new OfflineAudioContext(2, 1, 48000)
        scream = await ctx.decodeAudioData(bytes)
      } catch (e) {
        console.warn("ambush: scream not loaded", e)
      }
      stats.warmMs = Math.round(performance.now() - t0)
      phase = "armed"
    })()
    return loading
  }

  const playScream = () => {
    const a = audio()
    if (!a || !scream) return
    const src = a.ctx.createBufferSource()
    src.buffer = scream
    const gain = a.ctx.createGain()
    gain.gain.value = 1.6
    src.connect(gain).connect(a.buses.horror)
    src.start()
  }

  let stance: "quad" | "biped" = "biped"
  /** Kill light: a low, cold fill from the eye so the body reads in an unlit corridor (lift lobbies are lit). */
  const killLight = new THREE.PointLight(0xc8d4dc, 0, 6, 2)
  killLight.castShadow = false
  camera.add(killLight)
  killLight.position.set(0, 0.25, -0.3)
  let beat = BEAT
  /** What killed the player this time ("lift" or "hunter"), for automation. */
  let cause = ""

  let waitLeft = Infinity
  const from = new THREE.Vector3()
  const to = new THREE.Vector3()
  const want = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const side = new THREE.Vector3()

  /** The car has levelled at storey `s` with the doors opening: it waits beside them, unseen. */
  const trigger = (s: number) => {
    if (!wendigo || phase !== "armed") return false
    storey = s
    ground = floorY(s)
    stance = "biped"
    cause = "lift"
    phase = "lurk"
    waitLeft = Infinity
    t = 0
    const w = wendigo
    const a = w.animator!
    a.stoop = 1
    a.lungeStop = 0.15
    w.root.visible = false
    w.root.position.set(DOOR_X, ground, STAND_Z)
    for (let i = 0; i < 40; i++) w.update(1 / 30, { mode: "idle", stance: "biped" })
    return true
  }

  /**
   * It comes from beside the opening (the side the view points away from), already in the air: it appears ~2.8 m out
   * and 30° off centre, face first, and rushes straight at the eye.
   */
  const pounce = () => {
    phase = "pounce"
    t = 0
    stats.ambushAt = performance.now()
    const eye = camera.position
    camera.getWorldDirection(fwd)
    fwd.y = 0
    fwd.normalize()
    side.set(-fwd.z, 0, fwd.x)
    const sgn = eye.x > DOOR_X ? -1 : 1
    const a = 0.55 * sgn
    from.set(fwd.x * Math.cos(a) - fwd.z * Math.sin(a), 0, fwd.x * Math.sin(a) + fwd.z * Math.cos(a)).multiplyScalar(2.8).add(eye)
    from.x = Math.min(CORE.liftLobby.max[0] - 0.3, Math.max(CORE.liftLobby.min[0] + 0.3, from.x))
    from.z = Math.min(from.z, THRESHOLD_Z - 0.3)
    from.y = eye.y - 0.05
    const w = wendigo!
    // On all fours, head low and forward: the skull leads, the body springs up behind it, the antlers trail.
    stance = "quad"
    w.animator!.stoop = 0
    w.animator!.snapStance("quad")
    w.root.rotation.set(0, Math.atan2(eye.x - from.x, eye.z - from.z), 0)
    w.root.position.set(from.x, ground, from.z)
    w.update(1 / 60, { mode: "lunge", stance, target: eye, velocity: vel.set(0, 0, 0) })
    w.root.visible = true
    w.setShade(1)
    // Cold key from just above the eye: the pale skull pops against the dark lobby.
    killLight.intensity = 10
    killLight.distance = 4
    playScream()
  }

  const offArrive = liftEvents.on((e, s) => {
    if (e !== "arrive" || !story.visited308 || phase !== "armed") return
    if (!liftEvents.state?.()?.inCar) return
    // One death at a time: if the hunter is already on the player (caught), it has the kill.
    if (hooks.busy?.()) return
    if (trigger(s)) hooks.onAmbush?.()
  })

  /**
   * The hunter caught the player: the same jump scare from where it actually stands and the way it faces. The hunting
   * body is put to sleep by the caller; this one takes its place (same stance), whips the view round to it, a short
   * beat, then the rush into the lens. Returns false if a kill is already playing or the body isn't ready yet.
   */
  const killFrom = (at: { x: number; y: number; z: number }, heading: number, st: "quad" | "biped") => {
    if (!wendigo || phase !== "armed") return false
    ground = at.y
    stance = st
    beat = 0.55
    cause = "hunter"
    killLight.intensity = 2.2
    phase = "beat"
    t = 0
    stats.ambushAt = performance.now()
    flow.hold = true
    g.player.release()
    hud(true)
    const w = wendigo
    const a = w.animator!
    a.stoop = 0
    a.lungeStop = 0.15
    // From the side it actually came from, but stepped back to ~2.3 m so the rush reads, and turned to face the eye.
    const dx = at.x - camera.position.x
    const dz = at.z - camera.position.z
    const d = Math.hypot(dx, dz) || 1
    const back = Math.max(d, 2.3) / d
    w.root.position.set(camera.position.x + dx * back, at.y, camera.position.z + dz * back)
    w.root.rotation.set(0, Math.atan2(-dx, -dz), 0)
    void heading
    w.root.visible = true
    for (let i = 0; i < 20; i++) w.update(1 / 30, { mode: "idle", stance: st, target: camera.position })
    camBase.copy(camera.position)
    return true
  }

  const offUpdate = flow.onUpdate((dt) => {
    // Load and warm as soon as the radio room has been visited (in idle time while the player is in there).
    if (phase === "idle" && story.visited308) void preload()
    if (!wendigo || phase === "idle" || phase === "loading" || phase === "armed" || phase === "dead") return
    stats.frames++
    stats.maxFrameMs = Math.max(stats.maxFrameMs, dt * 1000)
    stats.frameMs.push(Math.round(dt * 1000))
    t += dt
    const w = wendigo
    const lift = liftEvents.state?.()
    const doorT = lift?.doorT ?? 1
    w.root.updateMatrixWorld(true)
    w.rig!.byName.get("head")!.getWorldPosition(head)
    if (phase === "lurk") {
      // Unseen beside the doors until the player steps out, waits too long, or tries to shut the doors.
      const eye = camera.position
      const out = eye.z < THRESHOLD_Z && Math.abs(eye.y - (ground + 1.6)) < 1.2
      if (doorT >= 0.999 && waitLeft === Infinity) waitLeft = 0.8 + Math.random() * 1.7
      waitLeft -= dt
      if (out || waitLeft <= 0 || lift?.phase === "closing") pounce()
      else return
    }
    if (phase === "pounce") {
      // The skull from beside the door into the lens in POUNCE_S, easing in hard (it's already at speed when seen).
      if (api.freezeAt !== null && t / POUNCE_S >= api.freezeAt) t = api.freezeAt * POUNCE_S
      const k = Math.min(1, t / POUNCE_S)
      const e = 1 - (1 - k) ** 2
      to.copy(camera.position).addScaledVector(fwd, END_D)
      to.y -= 0.05
      want.lerpVectors(from, to, e)
      vel.subVectors(want, head).divideScalar(Math.max(dt, 1e-3))
      vel.y = 0
      w.update(dt, { mode: "lunge", stance, target: camera.position, velocity: vel })
      w.root.updateMatrixWorld(true)
      w.rig!.byName.get("head")!.getWorldPosition(head)
      // Place the body so the skull is on its path (the feet leave the floor: it springs).
      w.root.position.add(vel.subVectors(want, head))
      w.root.position.y = Math.max(ground, Math.min(ground + 0.9, w.root.position.y))
      w.root.rotation.y = Math.atan2(camera.position.x - want.x, camera.position.z - want.z)
      // Face first: the skull's snout points into the lens (the antlers trail above and behind it), jaw wide.
      w.root.updateMatrixWorld(true)
      const rig = w.rig!
      const hi = rig.bones.indexOf(rig.byName.get("head")!)
      rig.byName.get("head")!.getWorldPosition(head)
      aimBone(rig, hi, look.subVectors(camera.position, head).add(_dn))
      const dist = want.distanceTo(camera.position)
      // Only the last few centimetres dim (so the contact frame never burns out); the key light does the rest.
      const sh = Math.min(1, Math.max(0, (dist - END_D) / 0.8))
      w.setShade(0.6 + 0.4 * sh)
      if (k >= 1) {
        // The hit: control ends here.
        phase = "dead"
        flow.hold = true
        g.player.release()
        camBase.copy(camera.position)
        jolt = 1
        hooks.flood()
        w.update(1 / 60, { mode: "freeze" })
        let n = 0
        const hit = () => {
          n++
          jolt *= 0.84
          applyShake(3.5 * jolt)
          if (n < 22) requestAnimationFrame(hit)
          else hooks.onKill()
        }
        requestAnimationFrame(hit)
      }
      return
    }
    if (phase === "waiting") {
      w.update(dt, { mode: "idle", stance: "biped", target: camera.position })
      // Turn the view to the doors as they open (the player looks up from the panel).
      look.set(DOOR_X, ground + 1.55, STAND_Z)
      aim(look, 1 - Math.exp(-dt * 2.5))
      if (doorT > 0.78) {
        phase = "beat"
        t = 0
      }
    } else if (phase === "beat") {
      // It's there. Still. The head cants toward the light.
      w.update(dt, { mode: "idle", stance, target: camera.position })
      aim(head, 1 - Math.exp(-dt * (cause === "hunter" ? 12 : 4)))
      if (t > beat) {
        phase = "lunge"
        t = 0
        playScream()
        shake = 0.25
      }
    } else if (phase === "lunge") {
      // The rush is driven here (straight at the eye, faster than its own lunge): skull into the lens in ~0.5 s.
      vel.set(camera.position.x - head.x, 0, camera.position.z - head.z)
      const left = vel.length()
      // From close by (a hunter catch) the rush slows so it still takes ~0.35 s to arrive.
      const speed = Math.min(1, t / 0.12) ** 2 * Math.min(7.5, Math.max(2.5, left / 0.35))
      vel.multiplyScalar(left > 1e-3 ? Math.min(speed, left / Math.max(dt, 1e-3)) / left : 0)
      w.root.position.addScaledVector(vel, dt)
      w.update(dt, { mode: "lunge", stance, target: camera.position, velocity: vel })
      // The camera flinches back and tracks the skull as it comes; shake builds into the hit.
      const dist = head.distanceTo(camera.position)
      // Filling the lens it would blow out under the light: darken it as it comes (shade 1 → 0.3 inside ~2 m).
      const k = Math.min(1, Math.max(0, (dist - 0.7) / 1.5))
      w.setShade(0.3 + 0.7 * k * k * (3 - 2 * k))
      shake = Math.min(1.6, shake + dt * 4)
      camera.fov += (fov0 + 14 - camera.fov) * (1 - Math.exp(-dt * 6))
      aim(head, 1 - Math.exp(-dt * 14))
      if (dist < 0.75 || t > 0.95) {
        phase = "dead"
        jolt = 1
        hooks.flood()
        w.update(1 / 60, { mode: "freeze" })
        // Hold the impact a moment, then hand over.
        let k = 0
        const hit = () => {
          k++
          jolt *= 0.86
          applyShake(3 * jolt)
          if (k < 22) requestAnimationFrame(hit)
          else {
            camera.fov = fov0
            camera.updateProjectionMatrix()
            hooks.onKill()
          }
        }
        requestAnimationFrame(hit)
        return
      }
    }
    camera.updateProjectionMatrix()
    applyShake(shake)
  })

  /** Hides the game's HUD layers for the scare (a stylesheet rule on a body flag). */
  function hud(off: boolean) {
    if (off) document.body.dataset.scare = "1"
    else delete document.body.dataset.scare
  }
  const style = document.createElement("style")
  style.textContent = `body[data-scare] :is(.lift-stops, .door-prompt, .hints, .objective, #hud > *) { opacity: 0 !important; transition: none !important; }`
  document.head.appendChild(style)

  /** Eases the camera's view toward a point. */
  function aim(p: THREE.Vector3, k: number) {
    q0.copy(camera.quaternion)
    m.lookAt(camera.position, p, camera.up)
    q1.setFromRotationMatrix(m)
    camera.quaternion.copy(q0).slerp(q1, k)
  }

  /** Positional shake and a little roll (amount in "units": 1 ≈ 1.5 cm and 1°). */
  function applyShake(amount: number) {
    const tt = performance.now() / 1000
    camera.position.set(
      camBase.x + (Math.sin(tt * 61) + Math.sin(tt * 37.3)) * 0.0075 * amount,
      camBase.y + (Math.sin(tt * 53.1) + Math.sin(tt * 29.7)) * 0.0075 * amount - jolt * 0.06,
      camBase.z + Math.sin(tt * 47.9) * 0.008 * amount + jolt * 0.05,
    )
    camera.rotateZ(Math.sin(tt * 43) * 0.012 * amount)
    camera.rotateX(Math.sin(tt * 31) * 0.008 * amount + jolt * 0.05)
    camera.updateMatrixWorld()
  }

  /** After a restart from the checkpoint: hide it and wait for the next lift ride. */
  const reset = () => {
    hud(false)
    flow.hold = false
    camera.fov = fov0
    camera.updateProjectionMatrix()
    shake = jolt = 0
    if (wendigo) {
      wendigo.root.visible = false
      wendigo.setShade(1)
      killLight.intensity = 0
      killLight.distance = 6
      wendigo.animator!.stoop = 0
      wendigo.animator!.lungeStop = 3
    }
    phase = wendigo ? "armed" : story.visited308 ? "idle" : "idle"
  }

  const api = {
    get phase() {
      return phase
    },
    /** Automation: hold the pounce at this fraction (0..1) for a still; null runs it. */
    freezeAt: null as number | null,
    /** Automation: is the creature drawn right now. */
    get visible() {
      return !!wendigo?.root.visible
    },
    stats,
    preload,
    trigger: (s: number) => trigger(s),
    killFrom,
    get cause() {
      return cause
    },
    reset,
    /** Automation: arm as if 3-08 had been visited. */
    arm() {
      story.visited308 = true
      return preload()
    },
  }
  ;(globalThis as { __ashwoodAmbush?: typeof api }).__ashwoodAmbush = api
  const stop = () => {
    hud(false)
    style.remove()
    killLight.removeFromParent()
    offArrive()
    offUpdate()
    flow.hold = false
    if (wendigo) scene.remove(wendigo.root)
  }
  g.signal.addEventListener("abort", stop)
  return api
}
