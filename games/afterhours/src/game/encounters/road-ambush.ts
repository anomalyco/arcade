import * as THREE from "three/webgpu"
import type { GameContext } from "../flow"
import type { World } from "../../boot/world"
import { createWendigo, type Wendigo } from "../../creatures/wendigo"
import { audio } from "../../audio/context"
import { hooks as audioHooks } from "../../audio/hooks"
import { heightAt } from "../../world/height"
import { northTrackSamples } from "../../world/layout"
import { installHudType } from "../../world/doors/hud"
import { aimBone } from "../../creatures/kit/ik"

// The ending (fixed for now: the player always dies). The escape truck (the intro agent's) gets out the north gate
// onto the logging road; ~20–25 s in it calls `runRoadAmbush(ctx, vehicle)`. A quiet stretch, then the Wendigo is in
// the road in the headlights, ~17 m ahead, upright, arms spread. Input locks the instant it appears. It comes at the
// glass: the skull hits the windscreen (cracks across the screen, a hard jolt, the scream), the headlights flicker
// and die with the skull still at the glass, then a cut to black and the end card, typed like the prelude, and its
// two options (Play again, Main menu).
//
// The vehicle API (agreed with the truck's side; everything but `root` and `speed` is optional):
//   root         the truck (world transform; +Z of `root` is forward unless `forward()` is given)
//   speed        forward speed, m/s
//   forward(out) unit forward in world space
//   headlights   the headlight lights (their intensity is driven here from the impact on)
//   setHeadlights(level)  0..1, for the emissive lenses / any extra glow (called with the same flicker)
//   takeControl()         stop reading the player's steering and pedals (from the instant it appears)
//   brake(amount)         0..1 brake (the driver stamps on it); without it the truck coasts
//   eye          the driver's eye (default: the game camera), for where the windscreen is
//
// Warm-up: `prepareRoadAmbush(world)` loads the creature and the scream and compiles them; the truck's side calls it
// when the drive starts (and runRoadAmbush calls it too, just in case). Automation: `__ashwoodRoad`.

export type RoadVehicle = {
  root: THREE.Object3D
  readonly speed: number
  forward?: (out: THREE.Vector3) => THREE.Vector3
  headlights?: THREE.Light[]
  setHeadlights?: (level: number) => void
  takeControl?: () => void
  brake?: (amount: number) => void
  eye?: THREE.Object3D
}

const SCREAM_URL = "sfx/monsters/wen2-huge-scream.mp3"
/** Where it stands in the road ahead of the eye (m). */
const AHEAD = 17
/** Appear → skull at the glass (s): no time to react. */
const RUSH_S = 0.62
/** Skull at the glass, headlights dying (s), then the cut. */
const HOLD_S = 1.7
/** The skull stops this far in front of the eye (the windscreen). */
const GLASS_D = 0.75

export const END_CARD = {
  lines: ["October 20, 1984.", "", "County units reached Ashwood Station at 6:12 a.m.", "No survivors were found."],
  typeRate: 14,
  lead: 1.2,
  lineEnd: 6,
  hold: 2.6,
}

type Prepared = { w: Wendigo; scream: AudioBuffer | null; fill: THREE.PointLight; beam: THREE.SpotLight }
let prepared: Promise<Prepared> | null = null

/** Loads, compiles and draws the creature once out of sight, and decodes the scream. Call when the drive starts. */
export function prepareRoadAmbush(world: World) {
  if (prepared) return prepared
  prepared = (async () => {
    // Its two lights join the scene now, dark: adding a light later recompiles every lit material (a long stall).
    const fill = new THREE.PointLight(0xb8c4cc, 0, 3, 2)
    const beam = new THREE.SpotLight(0xfff0d6, 0, 30, 0.16, 0.5, 1.4)
    fill.position.set(0, -80, -60)
    beam.position.set(0, -80, -60)
    world.scene.add(fill, beam, beam.target)
    const w = createWendigo({ ground: (x, z) => heightAt(x, z) })
    w.root.visible = false
    world.scene.add(w.root)
    await w.ready
    w.root.traverse((o) => {
      o.castShadow = true
      o.frustumCulled = false
    })
    w.animator!.snapStance("biped")
    for (let i = 0; i < 90; i++) w.update(1 / 30, { mode: "rear", stance: "biped" })
    const meshes: THREE.Object3D[] = []
    w.root.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o))
    await world.warmup.warmObjects(meshes).catch(() => {})
    w.root.position.set(0, -80, -60)
    w.root.visible = true
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r))
    w.root.visible = false
    let scream: AudioBuffer | null = null
    try {
      const bytes = await (await fetch(new URL(SCREAM_URL, document.baseURI).href)).arrayBuffer()
      scream = await (audio()?.ctx ?? new OfflineAudioContext(2, 1, 48000)).decodeAudioData(bytes)
    } catch (e) {
      console.warn("road ambush: scream not loaded", e)
    }
    return { w, scream, fill, beam }
  })()
  return prepared
}

let bound: GameContext | null = null
/** The run's context (encounters bind it at explore), for the chapter's drive. */
export function bindRoadAmbush(g: GameContext) {
  bound = g
}

type Drive = (g: GameContext, lead: number) => Promise<void> | void
let endingDrive: Drive | null = null
/** The truck's side registers its drive so the `ending` chapter can start it `lead` seconds before the ambush. */
export function setEndingDrive(fn: Drive) {
  endingDrive = fn
}
/** Chapter `ending`: the drive, `lead` s before the ambush (the truck's own, or a stand-in until it lands). */
export function startEndingDrive(lead = 5) {
  const g = bound
  if (!g) return console.warn("ending: no run")
  if (endingDrive) return endingDrive(g, lead)
  return standInDrive(g, lead)
}

export async function runRoadAmbush(g: GameContext, v: RoadVehicle) {
  const { camera, flow } = g
  const { w, scream, fill, beam } = await prepareRoadAmbush(g.world)
  const stats = { appearAt: 0, impactAt: 0, cutAt: 0, frameMs: [] as number[] }
  const api = { phase: "rush" as "rush" | "glass" | "cut" | "card", stats }
  ;(globalThis as { __ashwoodRoad?: typeof api }).__ashwoodRoad = api

  // ---- it appears: input locks now; the HUD goes.
  hideHud(true)
  flow.hold = true
  g.player.release()
  v.takeControl?.()
  v.brake?.(0.35)
  const eyeObj = v.eye ?? camera
  const eye = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const forward = () => {
    if (v.forward) v.forward(fwd)
    else fwd.set(0, 0, 1).applyQuaternion(v.root.getWorldQuaternion(new THREE.Quaternion()))
    fwd.y = 0
    return fwd.normalize()
  }
  eyeObj.getWorldPosition(eye)
  forward()
  const start = eye.clone().addScaledVector(fwd, AHEAD)
  const ground = heightAt(start.x, start.z)
  w.animator!.snapStance("biped")
  w.animator!.stoop = 0
  w.animator!.lungeStop = 0.1
  w.root.position.set(start.x, ground, start.z)
  w.root.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0)
  for (let i = 0; i < 30; i++) w.update(1 / 30, { mode: "rear", stance: "biped", target: eye })
  w.root.visible = true
  w.setShade(1)
  stats.appearAt = performance.now()

  const head = new THREE.Vector3()
  const from = new THREE.Vector3()
  const want = new THREE.Vector3()
  const glass = new THREE.Vector3()
  let fromSet = false
  const headLevel = (v.headlights ?? []).map((l) => l.intensity)
  // A faint cold fill at the glass, so the skull still reads as the headlights die.
  // The headlights catch it: a narrow beam from the bumper onto it (the truck's own lights stay low on the road).
  beam.intensity = 40
  beam.position.copy(eye).addScaledVector(fwd, 1.8)
  beam.position.y -= 0.9
  beam.target.position.set(start.x, ground + 1.8, start.z)

  const crack = createCrack()
  let t = 0
  let impacted = false

  const playScream = () => {
    const a = audio()
    if (!a || !scream) return
    const src = a.ctx.createBufferSource()
    src.buffer = scream
    const gain = a.ctx.createGain()
    gain.gain.value = 1.7
    src.connect(gain).connect(a.buses.horror)
    src.start()
  }

  await new Promise<void>((done) => {
    const off = flow.onUpdate((dt) => {
      t += dt
      stats.frameMs.push(Math.round(dt * 1000))
      eyeObj.getWorldPosition(eye)
      forward()
      glass.copy(eye).addScaledVector(fwd, GLASS_D)
      glass.y -= 0.08
      w.root.updateMatrixWorld(true)
      w.rig!.byName.get("head")!.getWorldPosition(head)
      if (!fromSet) {
        from.copy(head)
        fromSet = true
      }
      if (!impacted) {
        // Arms spread, then it launches: the skull from where it stood straight to the glass.
        const k = Math.min(1, t / RUSH_S)
        const e = k < 0.35 ? 0.04 * (k / 0.35) : 0.04 + 0.96 * ((k - 0.35) / 0.65) ** 1.6
        want.lerpVectors(from, glass, e)
        w.update(dt, { mode: k < 0.4 ? "rear" : "lunge", stance: "biped", target: eye })
        w.root.updateMatrixWorld(true)
        w.rig!.byName.get("head")!.getWorldPosition(head)
        w.root.position.add(want.sub(head))
        w.root.rotation.y = Math.atan2(-fwd.x, -fwd.z)
        beam.position.copy(eye).addScaledVector(fwd, 1.8)
        beam.position.y -= 0.9
        beam.target.position.copy(head)
        // Face first in the last half of the rush: the snout at the lens.
        if (k > 0.5) faceIn()
        if (k >= 1) {
          impacted = true
          api.phase = "glass"
          stats.impactAt = performance.now()
          t = 0
          // The hit: the glass goes, the jolt, the scream.
          crack.hit()
          jolt(g.world.renderer.domElement)
          playScream()
          audioHooks.sfx?.play("hor-metal-bang", { bus: "horror", gain: 1.4, rate: 0.85, lowBoost: 8 })
          audioHooks.sfx?.play("int-lab-glass", { bus: "horror", gain: 1.6, rate: 0.7 })
          v.brake?.(1)
          w.update(1 / 60, { mode: "freeze" })
        }
      } else {
        // Skull at the glass, riding with the truck; the headlights flicker and die.
        w.rig!.byName.get("head")!.getWorldPosition(head)
        w.root.position.add(want.copy(glass).sub(head))
        faceIn()
        beam.intensity = 40 * (t < 0.25 ? 1 : t < 1.2 ? (Math.sin(t * 47) > 0.1 ? 0.5 : 0.03) : 0)
        const live = t < 0.25 ? 1 : t < 1.2 ? (Math.sin(t * 47) > 0.1 ? 0.55 - (t - 0.25) * 0.5 : 0.04) : 0
        ;(v.headlights ?? []).forEach((l, i) => (l.intensity = headLevel[i]! * live))
        v.setHeadlights?.(live)
        fill.position.copy(eye).addScaledVector(fwd, 0.3)
        fill.position.y += 0.35
        fill.intensity = 0.6 + 1.2 * live
        w.setShade(0.55 + 0.45 * live)
        if (t > HOLD_S) {
          off()
          done()
        }
      }
    })
  })

  function faceIn() {
    const rig = w.rig!
    const hb = rig.byName.get("head")!
    w.root.updateMatrixWorld(true)
    hb.getWorldPosition(head)
    aimBone(rig, rig.bones.indexOf(hb), new THREE.Vector3().subVectors(eye, head).add(new THREE.Vector3(0, -0.15, 0)))
  }

  // ---- the cut.
  api.phase = "cut"
  stats.cutAt = performance.now()
  const black = document.createElement("div")
  black.style.cssText = "position:fixed;inset:0;background:#000;z-index:40"
  document.body.appendChild(black)
  crack.remove()
  fill.intensity = 0
  beam.intensity = 0
  flow.setPaused(true)
  document.body.dataset.modal = "ending"
  if (document.pointerLockElement) document.exitPointerLock()
  const hunter = (await import("../hunter")).hunterHandle()
  hunter?.sleep()
  await new Promise((r) => setTimeout(r, 900))
  api.phase = "card"
  await endCard()
}

// ------------------------------------------------------------------------------------------------- impact effects

const hudStyle = document.createElement("style")
hudStyle.textContent = `body[data-ending] :is(.lift-stops, .door-prompt, .hints, .objective, #hud > *) { opacity: 0 !important; transition: none !important; }`
/** The ending owns the screen: no objective, hints or prompts from the moment it appears. */
function hideHud(on: boolean) {
  if (!hudStyle.isConnected) document.head.appendChild(hudStyle)
  if (on) document.body.dataset.ending = "1"
  else delete document.body.dataset.ending
}

/** The windscreen cracking across the screen: a star of jagged cracks and rings from the hit, drawn in ~0.12 s. */
function createCrack() {
  const c = document.createElement("canvas")
  c.width = innerWidth
  c.height = innerHeight
  c.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:25;opacity:0"
  document.body.appendChild(c)
  const g = c.getContext("2d")!
  const cx = c.width * 0.52
  const cy = c.height * 0.42
  let r = 1984
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280)
  const paths: [number, number][][] = []
  const R = Math.hypot(c.width, c.height)
  for (let i = 0; i < 17; i++) {
    let a = (i / 17) * Math.PI * 2 + rnd() * 0.3
    let x = cx
    let y = cy
    const pts: [number, number][] = [[x, y]]
    let len = 0
    const max = R * (0.35 + rnd() * 0.5)
    while (len < max) {
      const s = 14 + rnd() * 40
      a += (rnd() - 0.5) * 0.5
      x += Math.cos(a) * s
      y += Math.sin(a) * s
      len += s
      pts.push([x, y])
    }
    paths.push(pts)
  }
  const rings: { r: number; a0: number; a1: number }[] = []
  for (let i = 0; i < 26; i++) rings.push({ r: 18 + rnd() ** 1.5 * R * 0.3, a0: rnd() * 6.28, a1: 0.3 + rnd() * 1.1 })
  const draw = (f: number) => {
    g.clearRect(0, 0, c.width, c.height)
    // Crushed centre.
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, 60)
    grad.addColorStop(0, "rgba(230,235,240,0.35)")
    grad.addColorStop(1, "rgba(230,235,240,0)")
    g.fillStyle = grad
    g.fillRect(cx - 60, cy - 60, 120, 120)
    g.lineCap = "round"
    for (const pts of paths) {
      const n = Math.max(2, Math.round(pts.length * f))
      g.beginPath()
      g.moveTo(pts[0]![0], pts[0]![1])
      for (let k = 1; k < n; k++) g.lineTo(pts[k]![0], pts[k]![1])
      g.strokeStyle = "rgba(0,0,0,0.55)"
      g.lineWidth = 3
      g.stroke()
      g.strokeStyle = "rgba(225,232,236,0.7)"
      g.lineWidth = 1.1
      g.stroke()
    }
    for (const ring of rings) {
      if (ring.r > R * 0.3 * f + 30) continue
      g.beginPath()
      g.arc(cx, cy, ring.r, ring.a0, ring.a0 + ring.a1)
      g.strokeStyle = "rgba(220,228,232,0.45)"
      g.lineWidth = 1
      g.stroke()
    }
  }
  return {
    hit() {
      c.style.opacity = "1"
      const t0 = performance.now()
      const step = () => {
        const f = Math.min(1, (performance.now() - t0) / 120)
        draw(0.2 + 0.8 * f)
        if (f < 1) requestAnimationFrame(step)
      }
      step()
    },
    remove: () => c.remove(),
  }
}

/** A hard jolt of the whole picture (the cab hit), settling over ~0.6 s. */
function jolt(el: HTMLElement) {
  const t0 = performance.now()
  const step = () => {
    const t = (performance.now() - t0) / 1000
    const k = Math.exp(-t * 7)
    el.style.transform = `translate(${Math.sin(t * 71) * 26 * k}px, ${(18 + Math.sin(t * 53) * 22) * k}px) rotate(${Math.sin(t * 37) * 1.6 * k}deg) scale(${1 + 0.05 * k})`
    if (t < 0.7) requestAnimationFrame(step)
    else el.style.transform = ""
  }
  step()
}

// ------------------------------------------------------------------------------------------------- end card

/** The end card: typed like the prelude (title-card styles: 14 cps, even rhythm, block cursor), then the options. */
function endCard() {
  installHudType()
  const el = document.createElement("div")
  el.className = "title-card on ending-card"
  el.style.zIndex = "45"
  el.innerHTML = `<div class="title-card-text"></div>`
  document.body.appendChild(el)
  const text = el.firstElementChild as HTMLDivElement
  const rows = END_CARD.lines.map((line) => {
    const p = document.createElement("p")
    if (!line) p.className = "blank"
    const typed = document.createElement("span")
    const caret = document.createElement("i")
    const rest = document.createElement("span")
    rest.className = "rest"
    rest.textContent = line
    p.append(typed, caret, rest)
    text.append(p)
    return { p, typed, rest, line }
  })
  const at = (i: number) => rows.forEach((r, k) => r.p.classList.toggle("at", k === i))
  const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))
  const base = 1 / END_CARD.typeRate
  return (async () => {
    at(0)
    text.classList.add("idle")
    await sleep(END_CARD.lead)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!
      at(i)
      text.classList.remove("idle")
      for (let c = 1; c <= r.line.length; c++) {
        r.typed.textContent = r.line.slice(0, c)
        r.rest.textContent = r.line.slice(c)
        await sleep(base)
      }
      text.classList.add("idle")
      await sleep(base * END_CARD.lineEnd)
    }
    await sleep(END_CARD.hold)
    const opts = document.createElement("div")
    opts.style.cssText = "position:absolute;left:50%;bottom:16vh;transform:translate(-50%,0);display:flex;gap:56px;opacity:0;transition:opacity 1.4s ease;cursor:default"
    const option = (label: string, act: () => void) => {
      const b = document.createElement("button")
      b.type = "button"
      b.textContent = label
      b.style.cssText =
        'all:unset;cursor:pointer;padding:6px 4px;font:13px/1.2 "Afterhours Type","Static Type","American Typewriter","Courier New",monospace;letter-spacing:0.34em;text-transform:uppercase;color:rgba(222,226,214,0.55);transition:color .25s ease'
      b.onpointerenter = () => (b.style.color = "#e8a254")
      b.onpointerleave = () => (b.style.color = "rgba(222,226,214,0.55)")
      b.onclick = act
      opts.appendChild(b)
    }
    option("Play again", () => {
      try {
        sessionStorage.removeItem("afterhours.checkpoint")
        sessionStorage.setItem("afterhours.autoplay", "1")
      } catch {}
      // A clean page (drops a dev `?start=` chapter, so it really starts over).
      location.href = location.pathname
    })
    option("Main menu", () => {
      try {
        sessionStorage.removeItem("afterhours.checkpoint")
      } catch {}
      // A clean page (drops a dev `?start=` chapter, so it really starts over).
      location.href = location.pathname
    })
    el.appendChild(opts)
    el.style.cursor = "default"
    void opts.offsetWidth
    opts.style.opacity = "1"
  })()
}

// ------------------------------------------------------------------------------------------------- stand-in drive

/**
 * Until the truck lands: a camera-only "truck" with two headlights rolling up the north track at ~7 m/s from
 * `lead` seconds before the ambush point. Exercises runRoadAmbush with the agreed vehicle API.
 */
async function standInDrive(g: GameContext, lead: number) {
  const { camera, flow, scene } = g
  void prepareRoadAmbush(g.world)
  const pts = northTrackSamples(0.5)
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]))
  const at = (s: number) => {
    let i = cum.findIndex((c) => c >= s)
    if (i <= 0) i = 1
    const k = (s - cum[i - 1]!) / Math.max(1e-6, cum[i]! - cum[i - 1]!)
    const a = pts[i - 1]!
    const b = pts[i]!
    return { x: a[0] + (b[0] - a[0]) * k, z: a[1] + (b[1] - a[1]) * k, dx: b[0] - a[0], dz: b[1] - a[1] }
  }
  let speed = 7
  const ambushS = Math.min(cum[cum.length - 1]! - AHEAD - 6, 52)
  let s = ambushS - lead * speed
  const root = new THREE.Group()
  root.name = "truck-stand-in"
  const lights: THREE.SpotLight[] = []
  for (const x of [-0.75, 0.75]) {
    const l = new THREE.SpotLight(0xfff1d6, 60, 60, 0.42, 0.55, 1.6)
    l.position.set(x, 1.0, 2.2)
    l.target.position.set(x * 2, 0, 30)
    root.add(l, l.target)
    lights.push(l)
  }
  scene.add(root)
  flow.hold = true
  g.player.release()
  let locked = false
  let brake = 0
  const v: RoadVehicle = {
    root,
    get speed() {
      return speed
    },
    headlights: lights,
    takeControl: () => (locked = true),
    brake: (a) => (brake = a),
  }
  let fired = false
  const off = flow.onUpdate((dt) => {
    speed = Math.max(0, speed - brake * 9 * dt)
    s += speed * dt
    const p = at(s)
    const y = heightAt(p.x, p.z)
    root.position.set(p.x, y, p.z)
    root.rotation.set(0, Math.atan2(p.dx, p.dz), 0)
    root.updateMatrixWorld(true)
    // The eye in the cab, a little bounce from the dirt road.
    camera.position.set(p.x, y + 1.95 + Math.sin(s * 2.1) * 0.012 + Math.sin(s * 5.3) * 0.006, p.z).addScaledVector(new THREE.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y)), 0.3)
    camera.rotation.set(-0.05, root.rotation.y + Math.PI, Math.sin(s * 1.7) * 0.004, "YXZ")
    camera.updateMatrixWorld(true)
    if (!fired && s >= ambushS) {
      fired = true
      void runRoadAmbush(g, v).finally(() => off())
    }
  })
  void locked
}

