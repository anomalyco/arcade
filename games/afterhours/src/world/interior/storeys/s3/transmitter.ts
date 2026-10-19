import * as THREE from "three/webgpu"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { hooks } from "../../../../audio/hooks"
import { duck } from "../../../../audio/context"
import { playCarDestroyed } from "../../../../audio/story"
import { type Builder, CEIL_Y, FLOOR_Y, M, T, paint, yawToward } from "../../api"
import { type BloodSpot, HAND_SIZE, bloodMesh } from "../../blood"
import { transmitter } from "./transmitter-state"

// TX-1, the carrier transmitter on the east wall of 3-08: still on the air, on a loop, the signal the town picked up.
// A tall rack with a lit ON AIR lamp, a swinging VU meter and the big TX POWER rotary switch. Aim at the switch and
// press E: the hand reaches, a heavy clunk, the lamp dies, the needle drops and the static (listening.ts) stops dead;
// a few seconds of silence, then one heavy crash outside ("aftermath": game/objectives.ts → "Get out.").

/** Rack: front face on x = FRONT_X (facing −x, into the room), centred on z = TX_Z. World x/z, storey-3 frame y. */
const TX_X = 11.21
const TX_Z = -7.9
const W = 0.95
const H = 1.95
const D = 0.62
const FRONT = -D / 2
/** The switch (local, on the front): centre height, and its world position for aiming and the hand reach. */
const SW_Y = 1.08
const SW_U = 0.22
/** Silence before the crash (s), and how long the building stays hushed. */
const SILENCE = 3.6

const CAB = paint(0x3d4440, 0.55, 0.3)
const DARK = paint(0x16181a, 0.5, 0.3)

export type Transmitter = { update(t: number, level: number): void; readonly on: boolean; onCut(fn: () => void): void }

export function transmitterRack(b: Builder): Transmitter {
  const yaw = yawToward(-1, 0)
  const m = T(TX_X, FLOOR_Y, TX_Z, yaw)
  b.rbox(CAB, m, W, H, D, 0.02, 0, H / 2, 0)
  // Plinth, the cable gland and conduit up into the ceiling (W-1 trunk).
  b.boxM(DARK, m, W - 0.04, 0.08, D - 0.04, 0, 0.04, 0)
  b.rbox(DARK, m, 0.14, 0.14, 0.14, 0.01, 0, H + 0.07, 0.05)
  const c0 = new THREE.Vector3(0, H + 0.14, 0.05).applyMatrix4(m)
  b.rod(M.darkSteel, [c0.x, c0.y, c0.z], [c0.x, CEIL_Y, c0.z], 0.03, 10)
  // Switch: a round steel boss, the bakelite T-handle in front of it (its own mesh: it turns).
  b.cyl(M.steel, m.clone().multiply(T(SW_U, SW_Y, FRONT - 0.012, 0, Math.PI / 2)), 0.075, 0.075, 0.024, 28)
  b.cyl(DARK, m.clone().multiply(T(SW_U, SW_Y, FRONT - 0.03, 0, Math.PI / 2)), 0.028, 0.028, 0.02, 16)

  // Faceplate legend (canvas, 1 px = 2 mm), with the unlit ON AIR lens and the meter face printed on it.
  const plate = faceplate()
  const toWorld = (u: number, v: number, w: number) => new THREE.Vector3(u, v, w).applyMatrix4(m)
  const place = (o: THREE.Object3D, u: number, v: number, w: number) => {
    const p = toWorld(u, v, w)
    o.position.set(p.x, p.y + b.oy, p.z)
    o.rotation.y = yaw + Math.PI
  }
  place(plate, 0, H / 2 + 0.02, FRONT - 0.0048)
  b.small.add(plate)

  // ON AIR lamp: lit lens over the printed one (hidden when the carrier stops).
  const onAir = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.13), lampMaterial())
  place(onAir, 0, ONAIR_V, FRONT - 0.0095)
  onAir.renderOrder = 2
  b.small.add(onAir)
  // VU meter: lit face and its needle (pivot below the scale).
  const vu = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.16), meterMaterial())
  place(vu, -0.02, VU_V, FRONT - 0.0095)
  b.small.add(vu)
  const needle = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.12, 0.002).translate(0, 0.06, 0), new THREE.MeshBasicNodeMaterial({ color: 0x0a0a0a }))
  const pivot = new THREE.Group()
  place(pivot, -0.02, VU_V - 0.07, FRONT - 0.014)
  pivot.add(needle)
  b.small.add(pivot)
  // The handle: a long bakelite bar on a hub; ON is vertical, OFF a quarter-turn to the left.
  const handle = new THREE.Group()
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.2, 0.04).translate(0, 0.03, 0), handleMaterial())
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 20).rotateX(Math.PI / 2), handleMaterial())
  handle.add(bar, hub)
  for (const c of handle.children) c.castShadow = true
  place(handle, SW_U, SW_Y, FRONT - 0.06)
  b.small.add(handle)
  b.collide(TX_X - D / 2, FLOOR_Y, TX_Z - W / 2, TX_X + D / 2, FLOOR_Y + H, TX_Z + W / 2)

  // Blood: Hargrove's hand on the cabinet under the switch, smeared down as he fell.
  const n = toWorld(0, 0, -1).sub(toWorld(0, 0, 0)).normalize()
  const hp = toWorld(SW_U - 0.06, 0.62, FRONT - 0.0085)
  const hp2 = toWorld(SW_U + 0.05, 0.83, FRONT - 0.0085)
  const spots: BloodSpot[] = [
    { kind: "hand", at: [hp.x, hp.y, hp.z], normal: [n.x, n.y, n.z], size: HAND_SIZE, rot: 0.15, seed: 41, age: 0.5 },
    { kind: "hand", at: [hp2.x, hp2.y, hp2.z], normal: [n.x, n.y, n.z], size: HAND_SIZE, rot: -0.3, seed: 43, age: 0.55, alpha: 0.75 },
  ]
  const blood = bloodMesh(spots, "blood:3-08-tx")
  blood.position.y = b.oy
  b.small.add(blood)

  // ---- interaction
  const sw = toWorld(SW_U, SW_Y, FRONT - 0.06)
  const swWorld = new THREE.Vector3(sw.x, sw.y + b.oy, sw.z)
  const cam = b.ctx.camera
  const dir = new THREE.Vector3()
  const to = new THREE.Vector3()
  const shot = b.ctx.params.has("shot")
  const prompt = shot ? null : document.createElement("div")
  if (prompt) {
    prompt.className = "door-prompt akc-minimal"
    prompt.style.cssText = "position:fixed;left:50%;top:58%;transform:translate(-50%,0);pointer-events:none;opacity:0"
    document.body.appendChild(prompt)
  }
  let shown = false
  let aimed = false
  let on = true
  let turn = 0
  let cutAt = -1
  let now = 0
  let crashed = false
  const cutListeners: (() => void)[] = []

  const cut = () => {
    if (!on) return
    on = false
    cutAt = now
    onAir.visible = false
    const body = (globalThis as { __afterhoursBody?: { body?: { interact?: (k: string, t?: unknown) => void } } }).__afterhoursBody?.body
    body?.interact?.("button", { x: swWorld.x, y: swWorld.y, z: swWorld.z })
    const sfx = hooks.sfx
    sfx?.play("light-switch", { bus: "doors", pos: { x: swWorld.x, y: swWorld.y, z: swWorld.z }, ref: 3, gain: 1.6, rate: 0.5, lowBoost: 9 })
    sfx?.play("door-fire-steel", { bus: "doors", pos: { x: swWorld.x, y: swWorld.y, z: swWorld.z }, ref: 2, gain: 0.5, rate: 0.7, offset: 0.55, lowBoost: 6 })
    // The building goes quiet: the ambience bus ducks to near silence with the carrier, holds ~20 s and comes back
    // over 5 s (the audio's duck stage; the player's Ambience setting is never touched).
    duck("ambience", 0.03, 1.2, 20, 5)
    for (const f of cutListeners) f()
    transmitter.set("off")
  }
  transmitter.bind(cut)
  addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.code !== "KeyE" || e.repeat || !aimed || !on) return
    cut()
  })

  return {
    get on() {
      return on
    },
    onCut(fn) {
      cutListeners.push(fn)
    },
    update(t, level) {
      now = t
      // Needle: the carrier's level with a fast jitter while on; falls to the stop when cut.
      // (rotation.z > 0 swings it to the left, the scale's −20 end, as seen from the room.)
      const want = on ? 0.55 - level * 1.1 + Math.sin(t * 31) * 0.04 : 0.8
      pivot.rotation.z += (want - pivot.rotation.z) * (on ? 0.35 : 0.12)
      onAir.visible = on && Math.sin(t * 2.1) > -0.995
      turn += ((on ? 0 : 1) - turn) * 0.35
      handle.rotation.z = turn * (Math.PI / 2)
      // Aim: within reach and roughly at the switch.
      cam.getWorldDirection(dir)
      to.copy(swWorld).sub(cam.position)
      const dist = to.length()
      const along = to.dot(dir)
      aimed = on && dist < 1.8 && along > 0.2 && to.addScaledVector(dir, -along).length() / Math.max(0.6, along) < 0.09
      if (prompt && aimed !== shown) {
        shown = aimed
        if (aimed) {
          const shared = [...document.querySelectorAll<HTMLElement>(".door-prompt")].find((el) => el !== prompt)
          if (shared) {
            prompt.style.cssText = shared.style.cssText
            prompt.style.transform = "translate(-50%, 0)"
          }
          prompt.innerHTML = keyPromptHtml("KeyE", "TX power: switch off")
        }
        prompt.style.opacity = aimed ? "1" : "0"
      }
      // Silence, then the crash outside.
      if (!on && !crashed && t - cutAt > SILENCE) {
        crashed = true
        // The crunch, the car alarm cut dead, the second crunch (src/audio/story.ts; plays once, whoever calls first).
        playCarDestroyed()
        transmitter.set("aftermath")
      }
    },
  }
}

// ------------------------------------------------------------------------------------------------ the faceplate

/** Heights (local, from the floor) of the lamp and the meter on the faceplate. */
const ONAIR_V = 1.66
const VU_V = 1.36
const PX = 500 // px per metre

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas")
  c.width = Math.round(w * PX)
  c.height = Math.round(h * PX)
  const g = c.getContext("2d")!
  g.scale(PX, PX)
  draw(g)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function faceplate() {
  const w = W - 0.06
  const h = H - 0.12
  // Canvas y runs down from the plate's top edge; the plate is centred at H / 2 + 0.02.
  const top = H / 2 + 0.02 + h / 2
  const y = (v: number) => top - v
  const tex = canvasTex(w, h, (g) => {
    g.fillStyle = "#525a55"
    g.fillRect(0, 0, w, h)
    for (let k = 0; k < h; k += 0.004) {
      g.fillStyle = `rgba(255,255,255,${0.015 + ((k * 7919) % 1) * 0.02})`
      g.fillRect(0, k, w, 0.0015)
    }
    const text = (s: string, x: number, yy: number, size: number, color = "#e9e4d4", weight = 800, align: CanvasTextAlign = "center") => {
      g.font = `${weight} ${size}px Helvetica, Arial, sans-serif`
      g.textAlign = align
      g.textBaseline = "middle"
      g.fillStyle = color
      g.fillText(s, x, yy)
    }
    // Header band.
    g.fillStyle = "#1c2024"
    g.fillRect(0.02, 0.03, w - 0.04, 0.14)
    text("TX-1  CARRIER TRANSMITTER", w / 2, 0.075, 0.045)
    text("11.905 kHz  ·  W-1 TRUNK → NORTH ARRAY  ·  1 kW", w / 2, 0.135, 0.022, "#b9b6aa", 600)
    // Canvas x runs to the viewer's right, which is local −u on the rack: a part at local u is drawn at w/2 − u.
    // ON AIR lens (unlit look: dark red glass with the words).
    const lx = w / 2
    const ly = y(ONAIR_V)
    g.fillStyle = "#2a0d0b"
    g.fillRect(lx - 0.22, ly - 0.075, 0.44, 0.15)
    g.strokeStyle = "#111"
    g.lineWidth = 0.012
    g.strokeRect(lx - 0.22, ly - 0.075, 0.44, 0.15)
    text("ON AIR", lx, ly + 0.004, 0.085, "#4a1814", 900)
    // Meter bezel.
    g.fillStyle = "#111"
    g.fillRect(lx + 0.02 - 0.17, y(VU_V) - 0.095, 0.34, 0.19)
    text("CARRIER LEVEL", lx + 0.02, y(VU_V) + 0.12, 0.024, "#e9e4d4", 700)
    // TX POWER.
    const sx = w / 2 - SW_U
    const sy = y(SW_Y)
    text("TX POWER", sx, sy - 0.17, 0.05, "#f2ead6", 900)
    text("ON", sx, sy - 0.115, 0.034, "#f2ead6", 800)
    text("OFF", sx - 0.13, sy, 0.034, "#f2ead6", 800)
    g.strokeStyle = "#f2ead6"
    g.lineWidth = 0.006
    g.beginPath()
    g.arc(sx, sy, 0.095, -Math.PI / 2, -Math.PI, true)
    g.stroke()
    // Vent grille low on the front.
    for (let k = 0; k < 8; k++) {
      g.fillStyle = "#1a1d1c"
      g.fillRect(0.1, h - 0.07 - k * 0.035, w - 0.2, 0.014)
    }
    // Warning strip and the director's order, taped on.
    g.fillStyle = "#d9b31f"
    g.fillRect(0.06, sy + 0.16, w - 0.12, 0.09)
    for (let x = 0.06; x < w - 0.06; x += 0.05) {
      g.fillStyle = "#151515"
      g.beginPath()
      g.moveTo(x, sy + 0.25)
      g.lineTo(x + 0.025, sy + 0.16)
      g.lineTo(x + 0.04, sy + 0.16)
      g.lineTo(x + 0.015, sy + 0.25)
      g.fill()
    }
    g.fillStyle = "#ece6d4"
    g.fillRect(0.12, sy + 0.175, w - 0.24, 0.06)
    text("CARRIER MUST NOT BE INTERRUPTED — DIR. 10/84", w / 2, sy + 0.205, 0.026, "#1a1a1a", 900)
    // Small dials on the right of the switch.
    for (let k = 0; k < 3; k++) {
      const dx = w / 2 + 0.06 + k * 0.1
      g.fillStyle = "#1a1a1a"
      g.beginPath()
      g.arc(dx, sy, 0.03, 0, Math.PI * 2)
      g.fill()
      text(["PLATE", "GRID", "FIL."][k]!, dx, sy + 0.05, 0.016, "#d8d2c2", 700)
    }
  })
  const mat = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.55, metalness: 0.35 })
  mat.name = "interior_tx_faceplate"
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
  mesh.receiveShadow = true
  return mesh
}

function lampMaterial() {
  const tex = canvasTex(0.42, 0.13, (g) => {
    const grd = g.createRadialGradient(0.21, 0.065, 0.01, 0.21, 0.065, 0.24)
    grd.addColorStop(0, "#ff3a26")
    grd.addColorStop(1, "#b0140c")
    g.fillStyle = grd
    g.fillRect(0, 0, 0.42, 0.13)
    g.font = "900 0.085px Helvetica, Arial, sans-serif"
    g.textAlign = "center"
    g.textBaseline = "middle"
    g.fillStyle = "#fff1dc"
    g.fillText("ON AIR", 0.21, 0.069)
  })
  const m = new THREE.MeshBasicNodeMaterial({ map: tex, color: new THREE.Color(2.6, 2.6, 2.6) })
  m.name = "interior_tx_onair"
  return m
}

function meterMaterial() {
  const tex = canvasTex(0.3, 0.16, (g) => {
    g.fillStyle = "#f0e2b8"
    g.fillRect(0, 0, 0.3, 0.16)
    g.strokeStyle = "#1a1a1a"
    g.lineWidth = 0.003
    g.beginPath()
    g.arc(0.15, 0.2, 0.13, -Math.PI * 0.78, -Math.PI * 0.22)
    g.stroke()
    g.strokeStyle = "#b31d12"
    g.lineWidth = 0.006
    g.beginPath()
    g.arc(0.15, 0.2, 0.13, -Math.PI * 0.36, -Math.PI * 0.22)
    g.stroke()
    g.font = "700 0.016px Helvetica, Arial, sans-serif"
    g.textAlign = "center"
    g.fillStyle = "#1a1a1a"
    ;["-20", "-10", "-5", "0", "+3"].forEach((s, i) => {
      const a = -Math.PI * 0.76 + i * Math.PI * 0.13
      g.fillText(s, 0.15 + Math.cos(a) * 0.15, 0.2 + Math.sin(a) * 0.15)
    })
    g.font = "900 0.026px Helvetica, Arial, sans-serif"
    g.fillText("VU", 0.15, 0.135)
  })
  const m = new THREE.MeshBasicNodeMaterial({ map: tex, color: new THREE.Color(1.15, 1.1, 0.95) })
  m.name = "interior_tx_meter"
  return m
}

function handleMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x1a1210, roughness: 0.35, metalness: 0.05 })
  m.name = "interior_tx_handle"
  return m
}
