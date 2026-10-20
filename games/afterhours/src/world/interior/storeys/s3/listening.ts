import * as THREE from "three/webgpu"
import { hooks } from "../../../../audio/hooks"
import type { LoopVoice } from "../../../../audio/engine"
import { materialFor } from "../../../../render/materials"
import { storeyY } from "../../../layout"
import { type Builder, FLOOR_Y, M, T, glow, paint, placeModels, yawToward } from "../../api"
import { decal } from "../../finishes"
import { type BloodSpot, FOOT_SIZE, HAND_SIZE, bloodMesh } from "../../blood"
import type { CorpseBlood } from "../../../npc/blood"
import { type DocumentId, documentMesh } from "../../../../render/documents"
import { type CorpseCharacter, type CorpsePose, corpseInfo, spawnCorpse } from "../../../npc/corpse"
import type { S3 } from "./common"
import { headphones, sub } from "./equipment"
import { transmitter } from "./transmitter-state"
import { glassCrack } from "./glass-crack"
import { type RadioRoom, transmitterRack } from "./transmitter"

// The listening room 3-08, two days after the station's radio went silent. TX-1 (./transmitter.ts) is off and the
// receiver is quiet; once the player switches the transmitter back on, the receiver hisses with the carrier (static
// that swells, now and then a broken voice). Under the one pendant: the operator slumped at the console, the others where they fell, chairs knocked over,
// headphones hanging by their cord, the strip chart heaped on the floor, a spilled coffee, the log, and blood:
// pools under every body, soaked clothes, handprints, a drag, cast-off spatter, and a trail of wrong footprints out.
// Four of the six on the station's duty roster (`LISTENING_ROOM_BODIES`; Marsh and Delacroix are unaccounted for) are posed corpses (world/npc/corpse.ts), streamed in when storey 3 is
// near; each wears its ID badge and its wounds (corpse blood overlay), and lies in its own pool. The GLBs are gitignored: a failed load leaves
// nothing (no body, no badge, no blood pool, no error). `?bodies` draws the anchors as debug boxes.

/** Storey 3 finished floor, world (FLOOR_Y is the finished floor above the structural storeyY). */
const Y3 = FLOOR_Y + storeyY(3) - storeyY(0)
/** The warning blotter on the operator desk, under Kessler's head and arms (world x/z). */
const BLOTTER = { x: 8.27, z: -13.85 }
/** The vehicle sign-out clipboard on the corridor face of the 3-08 wall (world x/z, height over the floor). */
export const SIGNOUT = { x: 3.95, y: 1.45, z: -1.6 + 0.012 }
/** The note under Kessler's head and folded arms (world x/z, on the blotter). */
const NOTE = { x: 8.4, z: -13.68 }
/** Where Kessler lies after he's pushed off the desk (body centre, world x/z). */
const OPERATOR_FLOOR = { x: 9.95, z: -12.8 } // clear of the chair base (its feet towards it)
/** Operator desk top (lewis's slump-chair pose wants 0.79) and the office chair under him. */
export const OPERATOR_DESK_H = 0.79
/** Office chair: `dy` sinks it so its seat sits at the pose's 0.486 m (measured seat top 0.5 m). */
export const OPERATOR_CHAIR = { x: 8.4, z: -13.18, yaw: yawToward(0, -1), dy: 0 }
const DESK_Y = Y3 + OPERATOR_DESK_H // operator desk at (8.3, −13.95), 3.0 × 0.86, facing the booth window

/**
 * A body in 3-08, in world coordinates (storey 3 finished floor at y = 11.56), in corpse.ts's anchor convention:
 * lying poses: `position` is the body centre on the floor and `yaw` turns the head (+Z) towards `facing`;
 * slump-wall: the hips, `wallBehind` out from the wall, facing away from it; slump-chair: the floor under the hips,
 * facing the desk (near edge ~0.27 m ahead). `contact` records what the body rests on and its world height.
 */
export type BodyAnchor = {
  id: string
  room: string
  character: CorpseCharacter
  pose: CorpsePose
  name: string
  role: string
  badge: DocumentId
  /** Wounds (bone space) for the corpse's blood overlay. */
  wounds: CorpseBlood["wounds"]
  /** Where the badge lies when it came off (floor, world x/z); otherwise it is clipped to the chest. */
  badgeAt?: readonly [number, number]
  position: readonly [number, number, number]
  yaw: number
  facing: readonly [number, number]
  contact: { surface: "chair-seat" | "floor"; y: number; /** Second support: chest/arms on the desk, back on the wall. */ also?: { surface: "desk" | "wall"; y?: number; x?: number; z?: number } }
  note: string
}

const face = (dx: number, dz: number) => {
  const l = Math.hypot(dx, dz)
  return [dx / l, dz / l] as const
}
/** corpse.ts yaw: rotation.y turning +Z to (dx, dz). */
const yawZ = (dx: number, dz: number) => Math.atan2(dx, dz)
const WEST_WALL_X = 0.86

export const LISTENING_ROOM_BODIES: readonly BodyAnchor[] = [
  {
    id: "3-08-operator",
    room: "3-08",
    character: "lewis",
    pose: "slump-chair",
    name: "D. Kessler",
    role: "Radio operator",
    badge: "badge_kessler",
    // Throat and the left side of the head, face down on the desk: shirt front soaked, blood on both hands.
    wounds: [
      { bone: "Neck", offset: [0, 0.02, 0.06], radius: 0.16, run: 2.4 },
      { bone: "Head", offset: [0.05, 0.08, 0.05], radius: 0.13, run: 1.6 },
      { bone: "Spine2", offset: [0, 0.05, 0.12], radius: 0.22, run: 2.2, strength: 0.9 },
      { bone: "LeftHand", radius: 0.1, run: 1.2, strength: 0.85 },
      { bone: "RightHand", radius: 0.08, run: 1.2, strength: 0.7 },
    ],
    position: [OPERATOR_CHAIR.x, Y3, -13.52 + 0.27],
    yaw: yawZ(0, -1),
    facing: face(0, -1),
    contact: { surface: "chair-seat", y: Y3 + 0.486, also: { surface: "desk", y: DESK_Y } },
    note: "At the console in the office chair, folded forward onto the desk beside the receiver; headphones pulled off, hanging off the desk edge.",
  },
  {
    id: "3-08-door",
    room: "3-08",
    character: "brian",
    pose: "face-down",
    name: "R. Hargrove",
    role: "Systems analyst",
    badge: "badge_hargrove",
    // Chest wound, soaked through to the floor; face and hands bloodied from crawling through it.
    wounds: [
      { bone: "Spine1", offset: [0, 0.05, 0.12], radius: 0.28, run: 1.8 },
      { bone: "Spine1", offset: [0.04, 0.08, -0.12], radius: 0.2, run: 1.4, strength: 0.9 },
      { bone: "Head", offset: [0, 0.06, 0.09], radius: 0.12, run: 1.4 },
      { bone: "LeftHand", radius: 0.11, run: 1.2 },
      { bone: "RightHand", radius: 0.11, run: 1.2 },
      { bone: "LeftForeArm", offset: [0, 0.1, 0], radius: 0.12, run: 1, strength: 0.7 },
    ],
    position: [9.7, Y3, -7.95],
    yaw: yawZ(1, 0.06),
    facing: face(1, 0.06),
    contact: { surface: "floor", y: Y3 },
    note: "Face down at the foot of the transmitter (TX-1), a reaching arm towards it: he dragged himself from the console to it and didn't get there, or tried to keep it on (up from 3-09). His bloody handprints are on the cabinet under the TX POWER switch.",
  },
  {
    id: "3-08-wall",
    room: "3-08",
    character: "joe",
    pose: "slump-wall",
    name: "N. Bellamy",
    role: "Programmer",
    badge: "badge_bellamy",
    // Head wound against the wall, run down the neck and shirt; hands where he held his head.
    wounds: [
      { bone: "Head", offset: [-0.03, 0.1, -0.06], radius: 0.14, run: 2.2 },
      { bone: "Neck", offset: [0, 0, 0.04], radius: 0.14, run: 3.0 },
      { bone: "Spine2", offset: [0.06, 0.08, 0.12], radius: 0.2, run: 2.4, strength: 0.85 },
      { bone: "RightHand", radius: 0.1, run: 1.2 },
      { bone: "LeftHand", radius: 0.07, run: 1.2, strength: 0.6 },
    ],
    position: [WEST_WALL_X + 0.331, Y3, -12.6],
    yaw: yawZ(1, 0),
    facing: face(1, 0),
    contact: { surface: "floor", y: Y3, also: { surface: "wall", x: WEST_WALL_X } },
    note: "Slid down the west wall, legs out, head dropped (up from 3-09). x is refined from corpseInfo().wallBehind.",
  },
  {
    id: "3-08w-chart",
    room: "3-08w",
    character: "martha",
    pose: "electrocuted",
    name: "C. Whitlock",
    role: "Signal technician",
    badge: "badge_whitlock",
    // Neck and shoulder, the blouse soaked down one side; blood on her face and the reaching hand.
    wounds: [
      { bone: "Neck", offset: [0.04, 0.02, 0.03], radius: 0.16, run: 2.4 },
      { bone: "RightShoulder", offset: [0, 0.08, 0.06], radius: 0.18, run: 2.2, strength: 0.9 },
      { bone: "Head", offset: [0.04, 0.05, 0.08], radius: 0.11, run: 1.4, strength: 0.8 },
      { bone: "RightHand", radius: 0.1, run: 1.2 },
      { bone: "LeftHand", radius: 0.08, run: 1.2, strength: 0.7 },
    ],
    badgeAt: [2.3, -15.95],
    position: [2.75, Y3, -16.55],
    yaw: yawZ(-1, -0.3),
    facing: face(-1, -0.3),
    contact: { surface: "floor", y: Y3 },
    note: "On the floor by the strip-chart bench in the chart paper, head towards the recorders (the voice said her name).",
  },
]

/** The receiver that plays (world): source of the static and the voice. */
export const LISTENING_ROOM_RADIO = { x: 9.4, y: Y3 + 0.85, z: -14.15 } as const

const COFFEE = decal(0x3c2410, 0.56, 0.9, "coffee_spill")
const DIAL = glow(0x1a1206, 0xffb050, 1.4, "s3_receiver_dial")
const METER = glow(0x101410, 0xd8e8c0, 1.1, "s3_receiver_meter")
const CHASSIS = paint(0x50544e, 0.5, 0.35)
const KNOB = paint(0x18191a, 0.4, 0.2)

/** Builds the scene; returns the per-frame update (radio sound, meter needle). */
export function stageListeningRoom(s: S3): (t: number) => void {
  const b = s.b
  const od = FLOOR_Y + OPERATOR_DESK_H
  const rnd = s.rnd
  // ---- the receiver, still on (front faces the operator, +z)
  const R = T(9.4, od, -14.15, yawToward(0, 1))
  b.rbox(CHASSIS, R, 0.5, 0.21, 0.34, 0.003, 0, 0.105, 0)
  b.boxM(M.darkSteel, R, 0.48, 0.17, 0.006, 0, 0.11, -0.171)
  b.boxM(DIAL, R, 0.24, 0.05, 0.004, -0.07, 0.15, -0.176, { cast: false })
  b.boxM(METER, R, 0.08, 0.055, 0.004, 0.15, 0.15, -0.176, { cast: false })
  for (const [x, y, r] of [[-0.17, 0.06, 0.02], [-0.07, 0.06, 0.026], [0.04, 0.06, 0.02], [0.15, 0.07, 0.016]] as const)
    b.cyl(KNOB, sub(R, x, y, -0.18, 0, Math.PI / 2), r, r, 0.022, 14)
  // Tuning pointer over the dial, and the VU needle (moves with the static).
  b.boxM(M.red, R, 0.003, 0.046, 0.003, -0.02, 0.15, -0.18, { cast: false })
  const needleMat = materialFor("flat", { color: 0x111111, roughness: 0.5, name: "s3_vu_needle" })
  const needle = new THREE.Mesh(new THREE.BoxGeometry(0.0018, 0.045, 0.001).translate(0, 0.0225, 0), needleMat)
  const np = new THREE.Vector3(0.15, 0.13, -0.18).applyMatrix4(R)
  needle.position.set(np.x, np.y + b.oy, np.z)
  needle.rotation.y = yawToward(0, 1)
  b.small.add(needle)
  s.doc("sticky_frequency", [9.53, od + 0.211, -14.1], [0, 1, 0], { rotation: 0.3 })

  // ---- the operator's desk the morning after
  s.doc("log_3_08_night", [7.56, od, -13.86], [0, 1, 0], { rotation: -0.08, curl: 0.05 })
  // Corridor side of the 3-08 door: the vehicle sign-out clipboard (src/game/search: the key trail starts here).
  b.rbox(paint(0x6b5236, 0.7, 0), T(SIGNOUT.x, FLOOR_Y + SIGNOUT.y, -1.6 + 0.004), 0.24, 0.33, 0.006, 0.003)
  b.boxM("metal_galvanized", T(SIGNOUT.x, FLOOR_Y + SIGNOUT.y + 0.15, -1.6 + 0.012), 0.09, 0.02, 0.01, 0, 0, 0)
  s.doc("vehicle_signout", [SIGNOUT.x, FLOOR_Y + SIGNOUT.y - 0.015, -1.6 + 0.0075], [0, 0, 1], { pin: "none", curl: 0.03 })
  // The night's duty roster by the door: six names, the four here and the two sent out to the array.
  s.doc("roster_3_08_duty", [4.1, FLOOR_Y + 1.5, -1.75 - 0.002], [0, 0, -1], { pin: "tape", rotation: 0.02 })
  s.doc("note_coming_from_woods", [6.9, FLOOR_Y, -12.6], [0, 1, 0], { rotation: 2.6 })
  // Headphones pulled off, hanging by the cord from the desk edge.
  headphones(b, 8.98, od, -13.53, 0.5, 0.44)
  // The coffee cup on its side, the spill across the desk and dripped onto the floor.
  placeModels(b, "mug", [{ position: [9.1, od + 0.0385, -13.72], yaw: 0.86, tilt: new THREE.Euler(0, 0, Math.PI / 2), collide: false, blob: 0 }])
  b.quad(COFFEE, T(9.0, od + 0.002, -13.6, 0.4, -Math.PI / 2), 0.36, 0.2, { cast: false })
  b.quad(COFFEE, T(9.12, FLOOR_Y, -13.32, 1.2, -Math.PI / 2), 0.22, 0.16, { cast: false })
  // Blood in the room (the pools under the bodies come with them): handprints, Hargrove's drag, cast-off spatter
  // over Bellamy and the console, and the trail of footprints out of the room.
  // (roomBlood is in world coordinates, like the mesh: the desk top is DESK_Y, not the builder-frame `od`.)
  b.small.add(bloodMesh(roomBlood(DESK_Y, floorAt(b)), "blood:3-08-room"))
  // Chairs knocked over: the stack chairs on their sides, one by the bench, one in the middle of the room.
  placeModels(b, "stack_chair", [
    { position: [3.6, FLOOR_Y + 0.22, -12.3], yaw: 1.9, tilt: new THREE.Euler(0, 0, Math.PI / 2), collide: false, blob: 0 },
    { position: [5.3, FLOOR_Y + 0.27, -7.6], yaw: -0.6, tilt: new THREE.Euler(Math.PI / 2, 0, 0), collide: false, blob: 0 },
  ])
  b.collide(3.2, FLOOR_Y, -12.7, 4.0, FLOOR_Y + 0.45, -11.9)
  b.collide(4.9, FLOOR_Y, -8.0, 5.7, FLOOR_Y + 0.45, -7.2)
  // The last metre of chart, torn off and dropped on the heap; more greenbar kicked across the floor.
  s.doc("chart_heartbeat", [2.4, FLOOR_Y + 0.03, -16.9], [0, 1, 0], { rotation: 1.35, curl: 0.35 })
  s.doc("printout_greenbar", [3.6, FLOOR_Y, -15.6], [0, 1, 0], { rotation: 0.4, curl: 0.4 })
  // The booth window: an impact crack low on the left pane, on both faces of the glass (./glass-crack.ts).
  for (const side of [-1, 1]) {
    const crack = glassCrack(0.9, 31)
    crack.position.set(7.6, FLOOR_Y + 1.22 + b.oy, -14.925 + side * 0.0065)
    if (side < 0) crack.rotation.y = Math.PI
    b.small.add(crack)
  }

  // ---- debug markers for the body anchors (`?bodies`)
  if (b.ctx.params.has("bodies")) {
    const mat = new THREE.LineBasicMaterial({ color: 0xff2a8a })
    for (const a of LISTENING_ROOM_BODIES) {
      const lying = a.pose !== "slump-chair" && a.pose !== "slump-wall" && a.pose !== "slump-wall-idle"
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.5, lying ? 0.25 : 0.9, lying ? 1.7 : 0.5)), mat)
      l.position.set(a.position[0], a.position[1] + (lying ? 0.13 : 0.45), a.position[2])
      l.rotation.y = a.yaw
      b.ctx.scene.add(l)
    }
  }
  // ---- TX-1 (off on arrival), the desk mic, the operator over the warning: ./transmitter.ts
  const tx = transmitterRack(b)
  const bodies = streamBodies(b, tx)
  // The warning on the blotter under Kessler, shown when he's moved (marker on the desk blotter, his blood on it).
  // A plain desk blotter (no writing) is always there. The note is a single torn sheet that lay under his head and
  // folded arms, so it's hidden until he's moved (it only shows then); his blood smeared across it.
  const plainPad = documentMesh([{ id: "blotter_plain", position: [BLOTTER.x, DESK_Y, BLOTTER.z], normal: [0, 1, 0], rotation: -0.03, offset: 0.0055, curl: 0, pin: "none" }])
  plainPad.name = "doc:blotter_plain"
  b.small.add(plainPad)
  const warn = documentMesh([{ id: "note_dont_turn_on", position: [NOTE.x, DESK_Y, NOTE.z], normal: [0, 1, 0], rotation: 0.18, offset: 0.0085, curl: 0.04, pin: "none" }])
  warn.name = "doc:note_dont_turn_on"
  const by = DESK_Y - b.oy
  const noteBlood = bloodMesh(
    [
      { kind: "smear", at: [NOTE.x + 0.08, by + 0.0095, NOTE.z + 0.1], size: [0.14, 0.05], rot: 0.5, seed: 61, age: 0.8, clip: DESK_TOP, alpha: 0.8 },
      { kind: "spray", at: [NOTE.x + 0.1, by + 0.0095, NOTE.z - 0.1], size: [0.08, 0.07], seed: 62, age: 0.8, clip: DESK_TOP, alpha: 0.85 },
    ],
    "blood:3-08-note",
  )
  noteBlood.position.y = b.oy
  const pad = new THREE.Group()
  pad.add(warn, noteBlood)
  b.small.add(pad)
  tx.setWarning(pad)

  // ---- the radio: static that swells, and now and then a broken voice
  let voice: LoopVoice | null = null
  let last = 0
  let nextVoice = 12
  let swell = 0.5
  let target = 0.5
  let retarget = 0
  const src = LISTENING_ROOM_RADIO
  return (t: number) => {
    const dt = Math.min(0.1, Math.max(0, t - last))
    last = t
    // Swell: wander towards a new target every few seconds, with fast flutter on top.
    if (t > retarget) {
      retarget = t + 2 + Math.random() * 5
      target = 0.25 + Math.random() * 0.75
    }
    swell += (target - swell) * Math.min(1, dt * 0.8)
    const flutter = 0.85 + 0.15 * Math.sin(t * 23.1) * Math.sin(t * 7.3)
    const level = swell * flutter
    bodies()
    tx.update(t, level)
    if (!tx.carrier) {
      // No carrier: the receiver's needle rests on its stop, no static, no voices.
      needle.rotation.z += (0.75 - needle.rotation.z) * 0.15
      voice?.set(0)
      voice?.update(dt, t)
      return
    }
    needle.rotation.z = 0.75 - level * 1.4
    const sfx = hooks.sfx
    if (!sfx) return
    if (!voice) {
      // Heard only in 3-08 and faintly at its corridor door (the radio stands ~15 m in from it): an 18 m range,
      // fading from 12.6 m, silent beyond it and on other floors; full wall muffling, so only the open doorway lets it
      // out (scripts/audio-radio.ts). Only once TX-1 is back on the air.
      voice = sfx.loop("amb-radio-static", { bus: "ambience", positional: true, ref: 2.5, rolloff: 0.5, range: 18 })
      voice.at(src.x, src.y, src.z)
    }
    voice.set(0.72 + 1.44 * level)
    voice.update(dt, t)
    // The whispers end once the warning has been read (the room's last voice was the call).
    if (t > nextVoice && !transmitter.reached("revealed")) {
      nextVoice = t + 22 + Math.random() * 30
      sfx.play("hor-radio-whisper", { bus: "horror", pos: { x: src.x, y: src.y, z: src.z }, ref: 2.5, rolloff: 0.5, range: 18, gain: 0.5, jitter: 0.05 })
    }
  }
}

// ------------------------------------------------------------------------------------------------ the bodies

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const bone = (root: THREE.Object3D, name: string) => {
  let hit: THREE.Object3D | undefined
  root.traverse((o) => {
    if (!hit && (o as THREE.Bone).isBone && (o.name === name || o.name.endsWith(`:${name}`) || o.name.endsWith(name))) hit = o
  })
  return hit
}
const wp = (o: THREE.Object3D | undefined) => (o ? new THREE.Vector3().setFromMatrixPosition(o.matrixWorld) : null)

/**
 * Loads the four bodies the first time the camera is on (or next to) storey 3, one per frame step, into the storey's
 * small-prop group: drawn only on the camera's own storey, warmed by the boot warm-up before they first draw (it
 * tracks late arrivals under the interior root). Returns the per-frame check.
 */
function streamBodies(b: Builder, tx: RadioRoom) {
  let started = false
  const cam = b.ctx.camera
  return () => {
    if (started) return
    const p = cam.position
    const level = Math.abs(p.y - (Y3 + 1.5)) < 5.5
    const near = Math.hypot(p.x - 6, p.z + 11) < 45
    if (!level || !near) return
    started = true
    void (async () => {
      for (const a of LISTENING_ROOM_BODIES) {
        try {
          await placeBody(b, a, tx)
        } catch {
          // Corpse GLBs are gitignored: no file, no body.
        }
        await nextFrame()
      }
    })()
  }
}

const UP = new THREE.Vector3(0, 1, 0)

async function placeBody(b: Builder, a: BodyAnchor, tx: RadioRoom) {
  let [x, y, z] = a.position
  if (a.pose === "slump-wall" || a.pose === "slump-wall-idle") {
    const info = await corpseInfo(a.character, a.pose)
    if (info.wallBehind !== undefined) x = WEST_WALL_X + info.wallBehind + 0.01
  }
  const root = await spawnCorpse(a.character, a.pose, { x, y, z, yaw: a.yaw }, { blood: { wounds: a.wounds } })
  root.name = `body:${a.id}`
  await nextFrame()
  // Body landmarks from the frozen pose.
  const head = wp(bone(root, "Head"))
  const chest = wp(bone(root, "Spine2")) ?? wp(bone(root, "Spine1"))
  const neck = wp(bone(root, "Neck"))
  const ls = wp(bone(root, "LeftShoulder"))
  const rs = wp(bone(root, "RightShoulder"))
  const extras: THREE.Object3D[] = []
  // ID badge: clipped to the left breast pocket where the chest faces up or out; where the body lies on its front the
  // clip has let go and the badge lies on the floor beside the chest.
  if (chest && neck && ls && rs) {
    const up = neck.clone().sub(chest).normalize()
    const left = ls.clone().sub(rs).normalize()
    const fwd = new THREE.Vector3().crossVectors(left, up).normalize()
    const meshes: THREE.Object3D[] = []
    root.traverse((o) => (o as THREE.SkinnedMesh).isSkinnedMesh && meshes.push(o))
    const target = chest.clone().addScaledVector(up, 0.07).addScaledVector(left, 0.09)
    let placed = false
    if (a.badgeAt) {
      extras.push(documentMesh([{ id: a.badge, position: [a.badgeAt[0], Y3, a.badgeAt[1]], normal: [0, 1, 0], rotation: 0.9, offset: 0.004, curl: 0.04, pin: "none" }]))
      placed = true
    } else if (fwd.y > -0.35) {
      const ray = new THREE.Raycaster(target.clone().addScaledVector(fwd, 0.4), fwd.clone().negate(), 0, 0.6)
      const hit = ray.intersectObjects(meshes, false)[0]
      if (hit) {
        // The face normal is the bind pose's, not the posed one: use the chest's facing.
        const n = fwd
        const u = up.clone().addScaledVector(n, -up.dot(n)).normalize()
        extras.push(documentMesh([{ id: a.badge, position: [hit.point.x, hit.point.y, hit.point.z], normal: [n.x, n.y, n.z], up: [u.x, u.y, u.z], rotation: 0.12, offset: 0.01, curl: 0.04, pin: "none" }]))
        placed = true
      }
    }
    if (!placed && a.pose === "slump-chair") {
      // Folded over the desk: the badge came off and lies on the desk top by his left elbow.
      const side = left.clone().setY(0).normalize()
      const at = chest.clone().addScaledVector(side, 0.42)
      extras.push(documentMesh([{ id: a.badge, position: [at.x, DESK_Y, Math.max(-14.25, Math.min(-13.62, at.z - 0.1))], normal: [0, 1, 0], rotation: 0.5, offset: 0.004, curl: 0.03, pin: "none" }]))
    } else if (!placed) {
      const side = left.clone().setY(0).normalize()
      // Clear of the arms: on the side away from the head, past the hip.
      const at = chest.clone().addScaledVector(side, -0.3).addScaledVector(new THREE.Vector3(Math.sin(a.yaw), 0, Math.cos(a.yaw)), -0.45)
      extras.push(documentMesh([{ id: a.badge, position: [at.x, Y3, at.z], normal: [0, 1, 0], rotation: a.yaw + 2.2, offset: 0.004, curl: 0.05, pin: "none" }]))
    }
  }
  // Blood: the pool it lies in (the operator's on the desk, run off the edge into a pool under his chair).
  if (head && chest) extras.push(bloodMesh(bodyPools(a, head, chest), `blood:${a.id}`))
  b.small.add(root, ...extras)
  if (a.pose === "slump-chair" && chest) {
    // The same man on the floor beside the chair, for when the player pushes him off the desk (./transmitter.ts tips
    // the seated body off the chair, then swaps to this one at the floor contact). Hidden until then.
    let onFloor: THREE.Object3D | null = null
    try {
      onFloor = await spawnCorpse(a.character, "collapse-back", { x: OPERATOR_FLOOR.x, y: Y3, z: OPERATOR_FLOOR.z, yaw: yawZ(1, 0.12) }, { blood: { wounds: a.wounds } })
      onFloor.name = `body:${a.id}:floor`
      onFloor.visible = false
      b.small.add(onFloor)
    } catch {
      // no floor pose: he stays where he tipped
    }
    tx.setOperator(root, onFloor, chest)
  }
  // A low invisible block around lying and wall bodies (above the 0.45 m step-up): walk around them, not through.
  if (a.pose !== "slump-chair") {
    const box = new THREE.Box3()
    root.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (!m.isSkinnedMesh) return
      m.computeBoundingBox()
      box.union(m.boundingBox!.clone().applyMatrix4(m.matrixWorld))
    })
    if (!box.isEmpty())
      b.ctx.colliders.push({ min: [box.min.x + 0.12, Y3, box.min.z + 0.12], max: [box.max.x - 0.12, Y3 + 0.55, box.max.z - 0.12] })
  }
}

// ------------------------------------------------------------------------------------------------ blood

const DESK_FRONT_Z = -13.95 + 0.43 // operator desk near edge (laminate face); the steel apron is 4 cm further in
const DESK_APRON_Z = -13.95 + 0.39
/** Operator desk top, world x/z [x0, z0, x1, z1] (workTable 3.0 × 0.86 at (8.3, −13.95)), 1 cm in from the edges. */
const DESK_TOP = [6.81, -14.37, 9.79, -13.53] as const

/** Blood that went over the desk's front edge at x: runs down the laminate edge and the apron, drops on the floor
 *  below it (the floor drops spread a little in front, where they fell). */
function spill(x: number, w: number, seed: number): BloodSpot[] {
  return [
    { kind: "drips", at: [x, DESK_Y - 0.015, DESK_FRONT_Z + 0.0005], normal: [0, 0, 1], size: [w, 0.03], seed, age: 0.75 },
    { kind: "drips", at: [x, DESK_Y - 0.07, DESK_APRON_Z + 0.0005], normal: [0, 0, 1], size: [w * 0.85, 0.07], seed: seed + 1, age: 0.75 },
    { kind: "spray", at: [x, Y3, DESK_FRONT_Z + 0.12], size: [w * 1.3, 0.3], seed: seed + 2, age: 0.75 },
  ]
}

/** The pools under a body, from its posed head and chest (world). */
function bodyPools(a: BodyAnchor, head: THREE.Vector3, chest: THREE.Vector3): BloodSpot[] {
  const seed = a.id.length * 3.7 + a.position[0]
  const dx = head.x - chest.x
  const dz = head.z - chest.z
  const rot = Math.atan2(dx, -dz) // quad +v along chest → head
  const mid = (t: number) => [chest.x + dx * t, chest.z + dz * t] as const
  if (a.pose === "slump-chair") {
    const [hx, hz] = [head.x, Math.max(head.z, DESK_FRONT_Z - 0.32)]
    return [
      // Under his head and arms on the desk, run to the front edge, down the edge and the apron, a pool below.
      { kind: "pool", at: [hx + 0.36, DESK_Y, hz + 0.08], size: [0.3, 0.24], rot: 0.3, seed, age: 0.95, clip: DESK_TOP },
      { kind: "pool", at: [hx + 0.08, DESK_Y, DESK_FRONT_Z - 0.09], size: [0.24, 0.14], rot: 0.1, seed: seed + 1, age: 0.95, clip: DESK_TOP },
      { kind: "spray", at: [hx + 0.55, DESK_Y, hz + 0.05], size: [0.4, 0.4], seed: seed + 7, age: 0.75, clip: DESK_TOP },
      // What the spray threw past the edge: runs down the front and drops on the floor under it.
      ...spill(hx + 0.55, 0.32, seed + 8),
      { kind: "drips", at: [hx + 0.08, DESK_Y - 0.015, DESK_FRONT_Z], normal: [0, 0, 1], size: [0.3, 0.03], seed: seed + 2, age: 0.75 },
      { kind: "drips", at: [hx + 0.08, DESK_Y - 0.07, DESK_APRON_Z], normal: [0, 0, 1], size: [0.3, 0.07], seed: seed + 3, age: 0.75 },
      { kind: "pool", at: [hx + 0.1, Y3, DESK_FRONT_Z + 0.2], size: [0.5, 0.42], rot: 0.7, seed: seed + 4, age: 0.75 },
      { kind: "trail", at: [hx - 0.1, Y3, DESK_FRONT_Z + 0.5], size: [0.7, 0.2], rot: 0.4, seed: seed + 5, age: 0.75 },
    ]
  }
  if (a.pose === "slump-wall" || a.pose === "slump-wall-idle") {
    return [
      { kind: "pool", at: [chest.x + 0.3, Y3, chest.z + 0.08], size: [0.7, 0.55], rot: 0.4, seed, age: 0.35 },
      { kind: "spray", at: [chest.x + 0.7, Y3, chest.z], size: [0.9, 1.0], seed: seed + 1, age: 0.45 },
    ]
  }
  // Lying: the main pool spreads from under the chest past one side; a second from the head; a satellite beyond.
  const [cx, cz] = mid(0.3)
  const l = Math.hypot(dx, dz) || 1
  const sx = -dz / l
  const sz = dx / l
  return [
    { kind: "pool", at: [cx + sx * 0.22, Y3, cz + sz * 0.22], size: [0.75, 0.85], rot, seed, age: 0.3 },
    { kind: "pool", at: [head.x + dx * (a.pose === "face-down" ? 0.04 : 0.3) - sx * 0.1, Y3, head.z + dz * (a.pose === "face-down" ? 0.04 : 0.3) - sz * 0.1], size: [0.42, 0.36], rot: rot + 0.8, seed: seed + 1, age: 0.2 },
    { kind: "spray", at: [cx + sx * 0.5, Y3, cz + sz * 0.5], size: [1.6, 1.4], rot, seed: seed + 2, age: 0.45 },
  ]
}

/** A drag smear from `a` (wet end) to `b` on the floor, `w` wide. */
function drag(a: readonly [number, number], b: readonly [number, number], w: number, seed: number): BloodSpot[] {
  // A body dragged (or dragging itself): not one straight band. Overlapping segments along a wandering line, each
  // narrower and drier than the last, with gaps, smeared handprints where he pulled himself along, and drops.
  let r = seed * 7919
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647)
  const out: BloodSpot[] = []
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const l = Math.hypot(dx, dz)
  const ux = dx / l
  const uz = dz / l
  const n = 5
  for (let i = 0; i < n; i++) {
    const t0 = i / n + (rnd() - 0.5) * 0.04
    const t1 = (i + 1) / n + 0.05
    const side = (rnd() - 0.5) * 0.18 + Math.sin(i * 1.7 + seed) * 0.08
    const x0 = a[0] + dx * t0 - uz * side
    const z0 = a[1] + dz * t0 + ux * side
    const x1 = a[0] + dx * t1 - uz * (side + (rnd() - 0.5) * 0.1)
    const z1 = a[1] + dz * t1 + ux * (side + (rnd() - 0.5) * 0.1)
    const sl = Math.hypot(x1 - x0, z1 - z0)
    const rot = Math.atan2(-(z1 - z0), x1 - x0)
    if (i === 3 && rnd() < 0.8) continue // a gap where he lifted off the floor
    out.push({ kind: "smear", at: [(x0 + x1) / 2, Y3, (z0 + z1) / 2], size: [sl, w * (1 - i * 0.12) * (0.8 + rnd() * 0.3)], rot, seed: seed + i * 3.1, age: 0.62 + i * 0.05, alpha: 0.9 - i * 0.08 })
    // His hands, reaching ahead and pulling: smeared prints either side of the line.
    const hx = a[0] + dx * (t1 - 0.02)
    const hz = a[1] + dz * (t1 - 0.02)
    for (const s of [1, -1])
      if (rnd() < 0.7)
        out.push({ kind: "hand", at: [hx - uz * s * (w * 0.55 + rnd() * 0.1), Y3, hz + ux * s * (w * 0.55 + rnd() * 0.1)], up: [ux, 0, uz], rot: (rnd() - 0.5) * 0.6, size: [HAND_SIZE[0] * s, HAND_SIZE[1] * 1.3], seed: seed + i * 5 + s, age: 0.7, alpha: 0.75 })
  }
  out.push({ kind: "trail", at: [(a[0] + b[0]) / 2, Y3, (a[1] + b[1]) / 2], size: [l, w * 1.6], rot: Math.atan2(-dz, dx), seed: seed + 50, age: 0.65 })
  return out
}

/** Blood in the room that doesn't move with a body. */
/** Floor height at (x, z) for the footprints: storey 3's corridor west of the riser (x < −4.6) is raised access floor,
 *  tile tops 9 mm above the finished floor (measured; its seam ribs stand a little higher and pass over the prints). */
const floorAt = (_b: Builder) => (x: number, _z: number) => (x < -4.62 ? Y3 + 0.009 : Y3)

function roomBlood(od: number, floor: (x: number, z: number) => number): BloodSpot[] {
  const y = Y3
  const out: BloodSpot[] = [
    // Handprints: on the wall by the door (reaching for the jamb), on the jamb itself, on the booth window.
    { kind: "hand", at: [2.12, y + 1.05, -1.75], normal: [0, 0, -1], size: HAND_SIZE, rot: 0.25, seed: 3, age: 0.6 },
    { kind: "hand", at: [2.341, y + 1.18, -1.8], normal: [1, 0, 0], up: [0, 1, 0.25], size: [0.1, 0.27], seed: 5, age: 0.6 },
    { kind: "hand", at: [1.88, y + 0.62, -1.75], normal: [0, 0, -1], size: HAND_SIZE, rot: -0.5, seed: 7, age: 0.7, alpha: 0.85 },
    { kind: "hand", at: [7.95, y + 1.32, -14.925], normal: [0, 0, 1], size: HAND_SIZE, rot: -0.15, seed: 9, age: 0.55, alpha: 0.85 },
    // Hargrove dragged himself from by the console to the transmitter: a long drag, wettest where he started, and
    // his hands' smears ahead of him at the foot of the rack.
    // (The smear's wet end, −u, is where he started; +u runs towards his feet.)
    ...drag([7.75, -12.85], [8.75, -8.35], 0.55, 13),
    { kind: "pool", at: [7.6, y, -12.9], size: [0.42, 0.34], rot: 0.5, seed: 14, age: 0.45 },
    { kind: "spray", at: [7.3, y, -13.0], size: [1.2, 0.9], rot: 0.5, seed: 36, age: 0.45 },
    // His hands' last smears, reaching past his head towards the door.
    { kind: "smear", at: [10.62, y, -7.8], size: [0.42, 0.14], rot: Math.atan2(-0.08, 1) + 0.15, seed: 15, age: 0.5 },
    { kind: "smear", at: [10.55, y, -8.15], size: [0.36, 0.12], rot: Math.atan2(-0.08, 1) - 0.12, seed: 16, age: 0.5 },
    // Bellamy: the smear where he slid down the west wall, impact spray where his head hit it, cast-off arcs above.
    { kind: "smear", at: [0.86, y + 0.55, -12.62], normal: [1, 0, 0], up: [0, 0, 1], size: [0.6, 0.42], seed: 18, age: 0.75, alpha: 0.7 },
    { kind: "spray", at: [0.86, y + 0.92, -12.6], normal: [1, 0, 0], size: [0.6, 0.5], seed: 23, age: 0.7, alpha: 0.8 },
    { kind: "spatter", at: [0.86, y + 1.4, -12.4], normal: [1, 0, 0], size: [1.1, 0.7], seed: 17, age: 0.75, alpha: 0.6 },
    { kind: "spatter", at: [0.86, y + 1.9, -10.6], normal: [1, 0, 0], up: [0, 1, 0.5], size: [1.8, 0.8], seed: 24, age: 0.6 },
    // West wall further on: a long cast-off line, as if swung from the middle of the room.
    { kind: "spatter", at: [0.86, y + 1.75, -7.4], normal: [1, 0, 0], up: [0, 1, -0.35], size: [2.4, 1.1], seed: 25, age: 0.6 },
    // East wall over the recorders and beyond them, and the north (spine) wall: arcs and sprays.
    { kind: "spray", at: [11.54, y + 1.5, -6.6], normal: [-1, 0, 0], size: [1.1, 1.0], seed: 26, age: 0.45 },
    { kind: "spatter", at: [11.54, y + 2.1, -5.0], normal: [-1, 0, 0], up: [0, 1, 0.3], size: [2.2, 0.9], seed: 27, age: 0.55 },
    { kind: "spatter", at: [11.54, y + 2.15, -11.4], normal: [-1, 0, 0], size: [2.0, 0.6], seed: 28, age: 0.55 },
    { kind: "spatter", at: [7.4, y + 1.7, -1.75], normal: [0, 0, -1], up: [0.3, 1, 0], size: [2.4, 1.0], seed: 29, age: 0.55 },
    { kind: "spray", at: [5.0, y + 1.1, -1.75], normal: [0, 0, -1], size: [0.8, 0.7], seed: 31, age: 0.5 },
    // The console: spray across the desk and the receiver's face, cast-off over the analyser rack front.
    { kind: "spray", at: [9.45, od, -13.72], size: [0.6, 0.35], rot: Math.PI, seed: 19, age: 0.8, clip: DESK_TOP },
    ...spill(9.45, 0.5, 23),
    { kind: "spatter", at: [9.4, od + 0.105, -13.974], normal: [0, 0, 1], size: [0.42, 0.17], seed: 20, age: 0.5 },
    // Floor: cast-off thrown across the room, and droplet trails between the bodies.
    { kind: "spatter", at: [6.2, y, -10.6], size: [2.2, 1.2], rot: 0.6, seed: 32, age: 0.5 },
    { kind: "trail", at: [5.2, y, -12.2], size: [3.2, 0.3], rot: 0.35, seed: 33, age: 0.5 },
    { kind: "trail", at: [3.0, y, -14.0], size: [2.6, 0.25], rot: -0.6, seed: 34, age: 0.55 },
    { kind: "trail", at: [9.6, y, -9.5], size: [2.4, 0.3], rot: 1.9, seed: 35, age: 0.5 },
  ]
  // The footprints: something walked out through the blood. Out of the pool under Kessler's chair, around Hargrove,
  // through the door and west along the corridor towards the stair, fading as the blood wore off its feet. Too long,
  // too narrow, three long toes; the stride doesn't settle (long, short, long-long).
  const path: [number, number][] = [[8.1, -12.75], [7.6, -10.6], [7.2, -8.4], [6.0, -6.3], [4.0, -4.6], [2.6, -3.4], [2.5, -2.6], [2.55, -1.2], [1.6, -0.1], [-0.5, 0.35], [-6.0, 0.5], [-12.5, 0.3]]
  const lens: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const l = Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1])
    lens.push(l)
    total += l
  }
  const at = (d: number) => {
    let i = 0
    while (i < lens.length - 1 && d > lens[i]!) d -= lens[i++]!
    const [x0, z0] = path[i]!
    const [x1, z1] = path[i + 1]!
    const t = Math.min(1, d / lens[i]!)
    return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, dx: (x1 - x0) / lens[i]!, dz: (z1 - z0) / lens[i]! }
  }
  const strides = [0.98, 0.64, 1.12, 1.08, 0.7, 0.92, 1.18, 0.6]
  let d = 0.3
  for (let k = 0; d < total - 0.2; k++) {
    const p = at(d)
    const side = k % 2 ? 1 : -1
    const fade = Math.max(0, 1 - d / total) ** 0.6
    // Skip a few: the feet missed, or no blood was left on that one.
    if (fade > 0.06 && !(k % 7 === 5) && !(d > total * 0.6 && k % 3 === 1)) {
      const w = 0.075 * side
      out.push({
        kind: "foot",
        at: [p.x - p.dz * w, floor(p.x - p.dz * w, p.z + p.dx * w), p.z + p.dx * w],
        // +v (toes) along the walk; the left foot is the mirror image.
        up: [p.dx, 0, p.dz],
        rot: side * 0.06,
        size: [FOOT_SIZE[0] * side, FOOT_SIZE[1]],
        seed: 30 + k,
        age: 0.7,
        alpha: 0.45 + 0.4 * fade,
      })
    }
    d += strides[k % strides.length]!
  }
  return out
}
