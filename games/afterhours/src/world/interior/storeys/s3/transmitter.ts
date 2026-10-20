import * as THREE from "three/webgpu"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { hooks } from "../../../../audio/hooks"
import type { LoopVoice } from "../../../../audio/engine"
import { SFX, type SfxId } from "../../../../audio/sfx-manifest"
import { playCarDestroyed, playerVoice } from "../../../../audio/story"
import { showSubtitle } from "../../../../game/shell/subtitles"
import { type Builder, CEIL_Y, FLOOR_Y, M, T, paint, yawToward } from "../../api"
import { type BloodSpot, HAND_SIZE, bloodMesh } from "../../blood"
import { transmitter } from "./transmitter-state"

// The 3-08 radio-room beat (story state: ./transmitter-state.ts). The station's radio went silent two days ago: TX-1,
// the transmitter on the east wall, is OFF when the player arrives (lamp dark, needle at rest, no carrier). Three
// interactions, each aim + E:
//   1. TX POWER switch → heavy clunk, ~2 s warm-up hum, the ON AIR lamp lights, the needle rises.
//   2. the desk mic → the player's report and County's crackled reply, as subtitles with static bursts (and the
//      voice takes `story-call-player-m` / `story-call-reply` once they're in the manifest) → onTransmitted().
//   3. the operator slumped over the desk → a push; he slides off the chair to the floor and the warning scrawled on
//      the blotter under him shows (TRANSMITTING WAKES IT …) → onReveal(); a beat of silence, then the turn (the
//      hunter's scream and glass, the car destroyed: src/audio/story.ts).

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
/** Warm-up after the switch is thrown (s). */
const WARM_UP = 2.1
/** The beat of silence after the reveal before the car goes (s); the hunter's scream lands inside it. */
const TURN_CAR = 5.5
/** Desk mic on the operator desk (world x/z, storey-3 frame y = desk top). */
export const MIC = { x: 9.0, z: -14.02 }
/** The receiver on the desk (County's voice comes out of it; listening.ts LISTENING_ROOM_RADIO). */
const RX = { x: 9.4, y: FLOOR_Y + 0.85 + 3 * 3.8, z: -14.15 }

const CAB = paint(0x3d4440, 0.55, 0.3)
const DARK = paint(0x16181a, 0.5, 0.3)
const CHROME = paint(0xb8bcbc, 0.25, 0.9)

/** The radio call (s from keying): the player's report (their character's voice, `playerVoice("call-player")`), static,
 *  then County (`story-call-reply`). Subtitle lines are timed to the clips: each clip's lines share its length by
 *  text length. Without a shipped clip the line plays as subtitles only, at a reading pace. */
type CallLine = { who: string; text: string; at: number; dur: number; sfx?: SfxId; static?: number }
/** Line 3 of the player's report as each character's take says it (the rest is the same for everyone). */
const PLAYER_LINE3: Record<string, string> = {
  james: "There's two more I can't find.",
  louise: "There are two more I can't find anywhere.",
  megan: "Two more, I don't know where they are.",
}
const playerLines = (sfx: SfxId | null) => [
  "County, County, this is Ashwood Outpost, do you read?",
  "I'm up at the station and they're... they're all dead. Four of them.",
  PLAYER_LINE3[sfx?.replace(/^story-call-player-/, "") ?? ""] ?? "There's two more I can't find anywhere.",
  "Please, I need somebody out here.",
]
const REPLY_LINES = ["Ashwood, County dispatch, copy.", "Units are on the way. I need you to stay right where you are. Do not move."]
const clipLength = (id: SfxId | null) => (id ? (SFX[id]?.variants[0]?.duration ?? 0) : 0)
/** Lines spread over a clip of length `len` from `at` (by characters), or at ~14 chars/s with no clip. */
function spread(who: string, lines: string[], at: number, len: number, sfx: SfxId | null, staticOn?: number): CallLine[] {
  const chars = lines.reduce((n, l) => n + l.length, 0)
  const total = len > 0 ? len : chars / 14 + 0.4 * lines.length
  let t = at
  return lines.map((text, i) => {
    const dur = (total * text.length) / chars
    const l: CallLine = { who, text, at: t, dur: dur + 0.15, ...(i === 0 && sfx ? { sfx } : {}), ...(i === 0 && staticOn ? { static: staticOn } : {}) }
    t += dur
    return l
  })
}
function buildCall(): { lines: CallLine[]; end: number; keyedUntil: number } {
  const pv = playerVoice("call-player")
  const pLen = clipLength(pv)
  const rLen = clipLength("story-call-reply")
  const pAt = 1.0
  const player = spread("YOU", playerLines(pv), pAt, pLen, pv)
  const pEnd = pAt + (pLen > 0 ? pLen : player.reduce((n, l) => n + l.dur, 0))
  const rAt = pEnd + 1.3
  const reply = spread("COUNTY", REPLY_LINES, rAt, rLen, rLen > 0 ? "story-call-reply" : null, 0.25)
  const rEnd = rAt + (rLen > 0 ? rLen : reply.reduce((n, l) => n + l.dur, 0))
  return {
    lines: [{ who: "", text: "*click* keyed", at: 0, dur: 0.9, static: 0.35 }, ...player, { who: "", text: "*static*", at: pEnd + 0.1, dur: 1.1, static: 1.1 }, ...reply, { who: "", text: "*static*", at: rEnd, dur: 0.8, static: 0.5 }],
    end: rEnd + 1.2,
    keyedUntil: pEnd,
  }
}

export type RadioRoom = {
  update(t: number, level: number): void
  /** True while the carrier is on the air (the receiver's static follows it). */
  readonly carrier: boolean
  /** The operator slumped over the desk (corpse root) and his pose on the floor (hidden until he falls). */
  setOperator(seated: THREE.Object3D, onFloor: THREE.Object3D | null, chest: THREE.Vector3): void
  /** The blotter warning (hidden under him until he's moved). */
  setWarning(o: THREE.Object3D): void
}

type Body = { interact?: (k: string, t?: unknown) => void }
const body = () => (globalThis as { __afterhoursBody?: { body?: Body } }).__afterhoursBody?.body

export function transmitterRack(b: Builder): RadioRoom {
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

  // Faceplate legend (canvas), with the unlit ON AIR lens and the meter face printed on it.
  const plate = faceplate()
  const toWorld = (u: number, v: number, w: number) => new THREE.Vector3(u, v, w).applyMatrix4(m)
  const place = (o: THREE.Object3D, u: number, v: number, w: number) => {
    const p = toWorld(u, v, w)
    o.position.set(p.x, p.y + b.oy, p.z)
    o.rotation.y = yaw + Math.PI
  }
  place(plate, 0, H / 2 + 0.02, FRONT - 0.0048)
  b.small.add(plate)
  // ON AIR lamp: lit lens over the printed one (shown once the carrier is up).
  const onAir = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.13), lampMaterial())
  place(onAir, 0, ONAIR_V, FRONT - 0.0095)
  onAir.renderOrder = 2
  onAir.visible = false
  b.small.add(onAir)
  // VU meter: face (dim until warm) and its needle (pivot below the scale).
  const meterMat = meterMaterial()
  const vu = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.16), meterMat)
  place(vu, -0.02, VU_V, FRONT - 0.0095)
  b.small.add(vu)
  const needle = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.12, 0.002).translate(0, 0.06, 0), new THREE.MeshBasicNodeMaterial({ color: 0x0a0a0a }))
  const pivot = new THREE.Group()
  place(pivot, -0.02, VU_V - 0.07, FRONT - 0.014)
  pivot.add(needle)
  pivot.rotation.z = 0.8
  b.small.add(pivot)
  // The handle: a long bakelite bar on a hub; ON is vertical, OFF a quarter-turn to the left. Starts OFF.
  const handle = new THREE.Group()
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.2, 0.04).translate(0, 0.03, 0), handleMaterial())
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 20).rotateX(Math.PI / 2), handleMaterial())
  handle.add(bar, hub)
  for (const c of handle.children) c.castShadow = true
  place(handle, SW_U, SW_Y, FRONT - 0.06)
  handle.rotation.z = Math.PI / 2
  b.small.add(handle)
  b.collide(TX_X - D / 2, FLOOR_Y, TX_Z - W / 2, TX_X + D / 2, FLOOR_Y + H, TX_Z + W / 2)

  // Blood: Hargrove's hands on the cabinet under the switch, smeared down as he fell.
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

  // Desk mic: a chrome stand mic with a push-to-talk bar on its base, on the operator desk by the receiver.
  const deskY = FLOOR_Y + 0.79
  const mm = T(MIC.x, deskY, MIC.z, yawToward(0, 1))
  b.cyl(DARK, mm, 0.065, 0.075, 0.025, 20)
  b.boxM(CHROME, mm, 0.05, 0.012, 0.03, 0, 0.03, -0.03)
  b.cyl(CHROME, mm.clone().multiply(T(0, 0.12, 0)), 0.008, 0.008, 0.2, 10)
  b.cyl(CHROME, mm.clone().multiply(T(0, 0.24, -0.01, 0, 1.2)), 0.024, 0.03, 0.08, 16)
  b.cyl(DARK, mm.clone().multiply(T(0, 0.255, -0.045, 0, 1.2)), 0.022, 0.022, 0.006, 16)
  const micWorld = new THREE.Vector3(MIC.x, deskY + 0.17 + b.oy, MIC.z)
  const swWorld = (() => {
    const p = toWorld(SW_U, SW_Y, FRONT - 0.06)
    return new THREE.Vector3(p.x, p.y + b.oy, p.z)
  })()

  // ---- HUD: prompt and subtitles
  const shot = b.ctx.params.has("shot")
  const prompt = shot ? null : document.createElement("div")
  if (prompt) {
    prompt.className = "door-prompt akc-minimal"
    prompt.style.cssText = "position:fixed;left:50%;top:58%;transform:translate(-50%,0);pointer-events:none;opacity:0"
    document.body.appendChild(prompt)
  }

  // ---- state
  const cam = b.ctx.camera
  const dir = new THREE.Vector3()
  const to = new THREE.Vector3()
  let now = 0
  let switchedAt = -1
  let callAt = -1
  let call = buildCall()
  let revealAt = -1
  let carGone = false
  let carrier = false
  let hum: LoopVoice | null = null
  const fired = new Set<number>()
  let operator: { seated: THREE.Object3D; onFloor: THREE.Object3D | null; chest: THREE.Vector3; pivot: THREE.Group | null; t: number } | null = null
  let warning: THREE.Object3D | null = null

  const staticBurst = (len: number, gain = 0.9) => {
    const sfx = hooks.sfx
    if (!sfx) return
    const v = sfx.loop("amb-radio-static", { bus: "horror", positional: true, ref: 2, rolloff: 0.6 })
    v.at(MIC.x, micWorld.y, MIC.z)
    v.set(gain)
    let t = 0
    const tick = () => {
      t += 0.05
      v.update(0.05, now)
      if (t < len) setTimeout(tick, 50)
      else v.stop()
    }
    tick()
  }

  const switchOn = () => {
    if (transmitter.phase !== "off") return
    switchedAt = now
    body()?.interact?.("button", { x: swWorld.x, y: swWorld.y, z: swWorld.z })
    const p = { x: swWorld.x, y: swWorld.y, z: swWorld.z }
    hooks.sfx?.play("light-switch", { bus: "doors", pos: p, ref: 3, gain: 1.6, rate: 0.5, lowBoost: 9 })
    hooks.sfx?.play("door-fire-steel", { bus: "doors", pos: p, ref: 2, gain: 0.5, rate: 0.7, offset: 0.55, lowBoost: 6 })
    const sfx = hooks.sfx
    if (sfx) {
      // Valve warm-up: a transformer hum swelling under the cabinet, settling to a low idle once on the air.
      hum = sfx.loop("light-fluoro-hum", { bus: "ambience", positional: true, ref: 1.5, rolloff: 1.2 })
      const c = toWorld(0, 0.9, FRONT)
      hum.at(c.x, c.y + b.oy, c.z)
    }
    transmitter.set("warming")
  }
  const transmit = () => {
    if (transmitter.phase !== "on") return
    callAt = now
    call = buildCall()
    fired.clear()
    body()?.interact?.("button", { x: micWorld.x, y: micWorld.y - 0.14, z: micWorld.z + 0.02 })
    hooks.sfx?.play("light-switch", { bus: "doors", pos: { x: micWorld.x, y: micWorld.y, z: micWorld.z }, ref: 1.5, gain: 0.8, rate: 1.4 })
    transmitter.set("transmitting")
  }
  const reveal = () => {
    if (transmitter.phase !== "transmitted" || !operator || operator.pivot) return
    revealAt = now
    body()?.interact?.("button", { x: operator.chest.x, y: operator.chest.y, z: operator.chest.z })
    // Pivot on the floor at the chair's open side: he slides back off the desk, then tips off the seat.
    const seat = operator.seated
    const pv = new THREE.Group()
    pv.position.set(seat.position.x + 0.42, seat.position.y, seat.position.z + 0.1)
    seat.parent?.add(pv)
    pv.attach(seat)
    operator.pivot = pv
    operator.t = 0
  }
  transmitter.bind("switchOn", switchOn)
  transmitter.bind("transmit", transmit)
  transmitter.bind("reveal", reveal)

  type Target = { at: THREE.Vector3; label: string; act: () => void; r: number } | null
  const targets = (): Target[] => [
    transmitter.phase === "off" ? { at: swWorld, label: "TX power: switch on", act: switchOn, r: 0.09 } : null,
    transmitter.phase === "off" || transmitter.phase === "warming"
      ? { at: micWorld, label: transmitter.phase === "off" ? "Mic: dead, no carrier (TX-1 is off)" : "Mic: warming up…", act: noop, r: 0.12 }
      : null,
    transmitter.phase === "on" ? { at: micWorld, label: "Mic: key and report", act: transmit, r: 0.12 } : null,
    transmitter.phase === "transmitted" && operator ? { at: operator.chest, label: "Move the body", act: reveal, r: 0.18 } : null,
  ]
  let aimed: Target = null
  let shownLabel = ""
  addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.code !== "KeyE" || e.repeat || !aimed) return
    aimed.act()
  })

  const update = (t: number, level: number) => {
    const dt = Math.min(0.1, Math.max(0, t - now))
    now = t
    const ph = transmitter.phase
    // Warm-up, then on the air.
    if (ph === "warming") {
      const k = Math.min(1, (t - switchedAt) / WARM_UP)
      hum?.set(0.25 + 0.9 * k, 400 + 3000 * k)
      if (k >= 1) {
        carrier = true
        transmitter.set("on")
      }
    } else if (carrier) hum?.set(0.3, 900)
    hum?.update(dt, t)
    const up = ph === "warming" ? Math.max(0, (t - switchedAt) / WARM_UP - 0.6) / 0.4 : carrier ? 1 : 0
    onAir.visible = carrier || (ph === "warming" && up > 0 && Math.random() < up)
    meterMat.color.setScalar(0.35 + 0.8 * Math.min(1, up))
    const keyed = ph === "transmitting" && t - callAt < call.keyedUntil
    const want = carrier ? 0.55 - (keyed ? 0.85 + level * 0.25 : 0.35 + level * 0.15) + Math.sin(t * 31) * 0.03 : 0.8
    pivot.rotation.z += (want - pivot.rotation.z) * 0.15
    const turn = ph === "off" ? 1 : 0
    handle.rotation.z += (turn * (Math.PI / 2) - handle.rotation.z) * 0.35

    // The call.
    if (ph === "transmitting") {
      const ct = t - callAt
      call.lines.forEach((l, i) => {
        if (ct < l.at || fired.has(i)) return
        fired.add(i)
        if (!shot) showSubtitle(l.who, l.text, l.dur)
        if (l.static) staticBurst(l.static, l.who === "COUNTY" ? 0.7 : 0.9)
        // The player's own voice is close (the mic is at their mouth); County comes out of the receiver.
        if (l.sfx) hooks.sfx?.play(l.sfx, l.who === "YOU" ? { bus: "horror", pos: { x: cam.position.x, y: cam.position.y, z: cam.position.z }, ref: 1.2, occlude: false } : { bus: "horror", pos: RX, ref: 2, rolloff: 0.6 })
      })
      if (ct > call.end) transmitter.set("transmitted")
    }

    // The reveal: slide back (0–0.35 s), tip off the chair to the floor (to 1.0 s), then the pose on the floor.
    if (operator?.pivot) {
      const o = operator
      o.t += dt
      const pv = o.pivot!
      const s = Math.min(1, o.t / 0.35)
      const tip = Math.max(0, Math.min(1, (o.t - 0.3) / 0.7))
      o.seated.position.z = (o.seated.userData.z0 ??= o.seated.position.z) + 0.22 * (s * s * (3 - 2 * s))
      pv.rotation.z = -1.35 * tip * tip
      // The warning shows only once his head and arms have slid clear of the pad.
      if (warning && !warning.visible && o.t > 0.3) warning.visible = true
      if (o.t > 1.0 && o.seated.visible) {
        if (o.onFloor) {
          o.seated.visible = false
          o.onFloor.visible = true
        }
        hooks.sfx?.play("hor-knock", { bus: "horror", pos: { x: o.chest.x, y: o.chest.y - 0.7, z: o.chest.z }, ref: 2, gain: 1.1, rate: 0.55, lowBoost: 8 })
        transmitter.set("revealed")
      }
    }
    // The turn: a beat of silence, then the car (the hunter's scream and the lobby glass land around it).
    if (revealAt >= 0 && !carGone && t - revealAt > TURN_CAR) {
      carGone = true
      playCarDestroyed()
      transmitter.set("aftermath")
    }

    // Aim.
    cam.getWorldDirection(dir)
    aimed = null
    let best = Infinity
    for (const tg of targets()) {
      if (!tg) continue
      to.copy(tg.at).sub(cam.position)
      const dist = to.length()
      const along = to.dot(dir)
      if (dist > 1.9 || along < 0.2) continue
      const off = to.addScaledVector(dir, -along).length() / Math.max(0.6, along)
      if (off < tg.r && off < best) {
        best = off
        aimed = tg
      }
    }
    const label = aimed?.label ?? ""
    if (prompt && label !== shownLabel) {
      shownLabel = label
      if (label) {
        const shared = [...document.querySelectorAll<HTMLElement>(".door-prompt")].find((el) => el !== prompt)
        if (shared) {
          prompt.style.cssText = shared.style.cssText
          prompt.style.transform = "translate(-50%, 0)"
        }
        prompt.innerHTML = aimed!.act === noop ? `<span class="akp-label">${label}</span>` : keyPromptHtml("KeyE", label)
      }
      prompt.style.opacity = label ? "1" : "0"
    }
  }

  return {
    update,
    get carrier() {
      return carrier
    },
    setOperator(seated, onFloor, chest) {
      operator = { seated, onFloor, chest, pivot: null, t: 0 }
      if (onFloor) onFloor.visible = false
    },
    setWarning(o) {
      warning = o
      o.visible = transmitter.reached("revealed")
    },
  }
}
const noop = () => {}


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
    // Hazard strip: high voltage, operators only (nothing about the carrier).
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
    text("DANGER 2 kV. AUTHORIZED OPERATORS ONLY", w / 2, sy + 0.205, 0.026, "#1a1a1a", 900)
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
