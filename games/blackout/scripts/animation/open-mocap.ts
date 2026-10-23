// Openly licensed reference motion for pose-diff and the Characters page's reference ghost.
//
// - 100STYLE (Mason, Starke, Komura 2022), CC BY 4.0, https://zenodo.org/records/8127870: 100 locomotion styles
//   (Neutral, Zombie, Crouched, DragLeftLeg, Swat, ...) as BVH. The 1.4 GB zip is read with parallel HTTP range
//   requests, so only the takes we use are downloaded.
// - Quaternius Universal Animation Library 1 and 2 (Standard), CC0, https://quaternius.com: keyframed game clips
//   (Walk_Loop, Crouch_Fwd_Loop, Zombie_Walk_Fwd_Loop, Zombie_Scratch, Hit_Chest, Death01, ...) as glTF.
//
// Both are converted to the joint names `retargetBvhFrame` reads (Hips, Chest, Neck, Head, UpperArm_L, LowerArm_L,
// Hand_L, UpperLeg_L, LowerLeg_L, Foot_L, Toes_L, ...) in canonical axes (+X forward, +Y up, +Z right).
// Never add Mixamo clips here: Adobe's terms forbid redistributing them and feeding them to anything learned.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { parseBvh, type BvhClip } from "@arcade/kit/pose-diff"
import { fixturesDir } from "./common"

type V3 = [number, number, number]
type Q = [number, number, number, number]

export const OPEN_MOCAP_CREDITS = {
  "100style":
    "100STYLE dataset: Ian Mason, Sebastian Starke, Taku Komura, Real-Time Style Modelling of Human Locomotion via Feature-Wise Transformations and Local Motion Phases (2022). CC BY 4.0, https://zenodo.org/records/8127870. Changes: one gait cycle cut, retargeted onto the arcade rig.",
  cmu: "CMU Graphics Lab Motion Capture Database, http://mocap.cs.cmu.edu (created with funding from NSF EIA-0196217), free for all uses; BVH conversion by Bruce Hahne (cgspeed). Changes: one gait cycle cut, retargeted onto the arcade rig.",
  ual: "Universal Animation Library 1 and 2 by Quaternius. CC0 1.0, https://quaternius.com/packs/universalanimationlibrary.html",
} as const

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex")

// ---------------------------------------------------------------------------------------------- zip over HTTP
type ZipEntry = { name: string; method: number; csize: number; size: number; offset: number }

async function range(url: string, start: number, end: number): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`)
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.length !== end - start + 1) throw new Error(`short read ${buf.length}`)
      return buf
    } catch (e) {
      if (attempt >= 5) throw new Error(`range ${start}-${end} of ${url}: ${(e as Error).message}`)
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
    }
  }
}

/** Zenodo throttles each connection (~20 kB/s); 16 parallel 256 kB ranges reach ~250 kB/s. */
async function parallelRange(url: string, start: number, length: number): Promise<Uint8Array> {
  const chunk = 256 * 1024
  const out = new Uint8Array(length)
  const jobs: [number, number][] = []
  for (let o = 0; o < length; o += chunk) jobs.push([o, Math.min(length, o + chunk) - 1])
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const [a, b] = jobs[next++]!
      out.set(await range(url, start + a, start + b), a)
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker))
  return out
}

async function zipIndex(url: string, cachePath: string): Promise<ZipEntry[]> {
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8"))
  const head = await fetch(url, { method: "HEAD" })
  const size = Number(head.headers.get("content-length"))
  const tail = await range(url, size - 65557, size - 1)
  const dv = new DataView(tail.buffer)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error("no zip end record")
  const cdSize = dv.getUint32(eocd + 12, true), cdOffset = dv.getUint32(eocd + 16, true)
  const cd = await parallelRange(url, cdOffset, cdSize)
  const cv = new DataView(cd.buffer)
  const entries: ZipEntry[] = []
  for (let p = 0; p < cd.length && cv.getUint32(p, true) === 0x02014b50; ) {
    const nameLen = cv.getUint16(p + 28, true), extraLen = cv.getUint16(p + 30, true), commentLen = cv.getUint16(p + 32, true)
    entries.push({
      name: new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen)),
      method: cv.getUint16(p + 10, true),
      csize: cv.getUint32(p + 20, true),
      size: cv.getUint32(p + 24, true),
      offset: cv.getUint32(p + 42, true),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  mkdirSync(join(cachePath, ".."), { recursive: true })
  writeFileSync(cachePath, JSON.stringify(entries))
  return entries
}

async function zipRead(url: string, e: ZipEntry): Promise<Uint8Array> {
  const lh = await range(url, e.offset, e.offset + 29)
  const lv = new DataView(lh.buffer)
  const dataStart = e.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true)
  const raw = await parallelRange(url, dataStart, e.csize)
  return e.method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw
}

function readLocalZip(buf: Uint8Array, suffix: string): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  let p = dv.getUint32(eocd + 16, true)
  while (dv.getUint32(p, true) === 0x02014b50) {
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true)
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen))
    if (name.endsWith(suffix)) {
      const csize = dv.getUint32(p + 20, true), off = dv.getUint32(p + 42, true), method = dv.getUint16(p + 10, true)
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true)
      const raw = buf.subarray(start, start + csize)
      return method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`${suffix} not in zip`)
}

// ---------------------------------------------------------------------------------------------- 100STYLE
const STYLE_URL = "https://zenodo.org/records/8127870/files/100STYLE.zip?download=1"

/** Pinned hashes of the takes we use; a new take prints its hash on first download. */
export const STYLE_SHA: Record<string, string> = {
  Neutral_FW: "2f28800baa299547c42c257d1c926172542a1e69b46a3d3e6aa0aded0e9b40f6",
  Zombie_FW: "de7e80f07d879e7541aa75cc7eac2e3a6318d1b116bec9376ae309e024028d12",
  Crouched_FW: "e4242640c94810a6c5f1df0d0d0bb78c8ffaed4bb79a7569ba3391e57a34ac8a",
  DragLeftLeg_FW: "33a6b97e05e162cb3013ff9bfd626a5163795d413c68bfee8cd58bb3ee9d4610",
  Swat_FW: "82f4d6ae94a07aafd7da538bbed8761f85518564e5ed311fad1ed81ff511f3f9",
  Neutral_SW: "07225ded6df11c4eb97a7b42e6121a9e985ae7e8d0f56f9ca971429f9c507ad9",
  Neutral_SR: "804046d4d29109515fa3f6268f85873bab1dc3d08b87dabbe644eddbf00aec71",
  Neutral_BW: "cfa225ff3a29a38d11ecd1b72fa0d917ca6c3dc3b24b3d09a4cb5c28ee9dc5b9",
  Neutral_BR: "5661951058a5ec50e02a6708a5f9d3ccd09ff768051584cac9611aee8402ea13",
  Neutral_FR: "f46ca526027a3654c8939a0123413f6008906fb32125d5e885eafcaa830831cb",
  Neutral_ID: "71aead2e3246bdb47a5b839cb3e60e0574e9a1a046c071cc147e2922a35f259f",
}

/** One 100STYLE take (e.g. "Zombie_FW": FW forward walk, FR forward run, ID idle), cached under fixtures. */
export async function load100Style(take: string, dir = join(fixturesDir, "100style")): Promise<string> {
  const path = join(dir, `${take}.bvh`)
  if (!existsSync(path)) {
    const style = take.split("_")[0]!
    const entries = await zipIndex(STYLE_URL, join(dir, "index.json"))
    const e = entries.find(x => x.name === `100STYLE/${style}/${take}.bvh`)
    if (!e) throw new Error(`100STYLE has no ${take}`)
    console.log(`fetching 100STYLE ${take} (${(e.csize / 1e6).toFixed(1)} MB compressed)…`)
    const data = await zipRead(STYLE_URL, e)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, data)
  }
  const text = readFileSync(path, "utf8")
  const want = STYLE_SHA[take]
  const got = sha256(text)
  if (want && got !== want) throw new Error(`${path} does not match its pinned hash`)
  if (!want) console.log(`  ${take} sha256 ${got} (pin it in STYLE_SHA)`)
  return text
}

const STYLE_NAMES: Record<string, string> = {
  LeftShoulder: "UpperArm_L", LeftElbow: "LowerArm_L", LeftWrist: "Hand_L",
  RightShoulder: "UpperArm_R", RightElbow: "LowerArm_R", RightWrist: "Hand_R",
  LeftHip: "UpperLeg_L", LeftKnee: "LowerLeg_L", LeftAnkle: "Foot_L", LeftToe: "Toes_L",
  RightHip: "UpperLeg_R", RightKnee: "LowerLeg_R", RightAnkle: "Foot_R", RightToe: "Toes_R",
}

/** 100STYLE BVH in the joint names `retargetBvhFrame` reads. Chest is the mid-thorax (Chest3). */
export function parse100Style(text: string): BvhClip {
  const clip = parseBvh(text)
  return {
    dt: clip.dt,
    frames: clip.frames.map(f => {
      const out: Record<string, V3> = { Hips: f.Hips!, Chest: f.Chest3!, Neck: f.Neck!, Head: f.Head!, Head_End: f.Head_End! }
      for (const [src, dst] of Object.entries(STYLE_NAMES)) out[dst] = f[src]!
      return out
    }),
  }
}

// ---------------------------------------------------------------------------------------------- CMU
const CMU_URL = "https://raw.githubusercontent.com/una-dinosauria/cmu-mocap/master/data"

/** Pinned hashes of the CMU trials we use (Bruce Hahne's cgspeed BVH conversion); a new trial prints its hash. */
export const CMU_SHA: Record<string, string> = {
  "07_12": "704b63c1ecb291cde10625d2cd6b90d8f77d14763ba9931233ab2dc02148a578",
  "09_11": "1ecc12d8ae242f271d8e1b17ac9b204d1c71cb17d06ba881bc1915a5b72dc712",
}

/** One CMU trial (e.g. "07_12", subject 07 trial 12), cached under fixtures. Free for all uses. */
export async function loadCmu(trial: string, dir = join(fixturesDir, "cmu")): Promise<string> {
  const path = join(dir, `${trial}.bvh`)
  if (!existsSync(path)) {
    const url = `${CMU_URL}/${trial.split("_")[0]!.padStart(3, "0")}/${trial}.bvh`
    console.log(`fetching CMU ${trial}…`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Could not download ${url} (${res.status})`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, await res.text())
  }
  const text = readFileSync(path, "utf8")
  const want = CMU_SHA[trial], got = sha256(text)
  if (want && got !== want) throw new Error(`${path} does not match its pinned hash`)
  if (!want) console.log(`  CMU ${trial} sha256 ${got} (pin it in CMU_SHA)`)
  return text
}

const CMU_NAMES: Record<string, string> = {
  LeftArm: "UpperArm_L", LeftForeArm: "LowerArm_L", LeftHand: "Hand_L",
  RightArm: "UpperArm_R", RightForeArm: "LowerArm_R", RightHand: "Hand_R",
  LeftUpLeg: "UpperLeg_L", LeftLeg: "LowerLeg_L", LeftFoot: "Foot_L", LeftToeBase: "Toes_L",
  RightUpLeg: "UpperLeg_R", RightLeg: "LowerLeg_R", RightFoot: "Foot_R", RightToeBase: "Toes_R",
}

/**
 * A CMU BVH in the joint names `retargetBvhFrame` reads, rescaled to metres from its hip height (cgspeed's units are
 * not metres; `hipM` is the performer's assumed hip height). Chest is the upper spine (Spine1).
 */
export function parseCmu(text: string, hipM = 0.92): BvhClip {
  const clip = parseBvh(text)
  const f0 = clip.frames[0]!
  const legLen = (sd: string) => { const a = f0[`${sd}UpLeg`]!, b = f0[`${sd}Leg`]!, c = f0[`${sd}Foot`]!; return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) + Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]) }
  // Hip joint to ankle is the hip height less the ankle's height above the floor (~8 cm).
  const k = (hipM - 0.08) / ((legLen("Left") + legLen("Right")) / 2)
  return {
    dt: clip.dt,
    frames: clip.frames.map(f => {
      const sc = (v: V3): V3 => [v[0] * k, v[1] * k, v[2] * k]
      const out: Record<string, V3> = { Hips: sc(f.Hips!), Chest: sc(f.Spine1!), Neck: sc(f.Neck1!), Head: sc(f.Head!), Head_End: sc(f.Head_End!) }
      for (const [src, dst] of Object.entries(CMU_NAMES)) out[dst] = sc(f[src]!)
      return out
    }),
  }
}

// ---------------------------------------------------------------------------------------------- Quaternius UAL
const UAL = {
  ual1: { url: "https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip", glb: "AnimationLibrary_Godot_Standard.glb" },
  ual2: { url: "https://opengameart.org/sites/default/files/universal_animation_library_2standard.zip", glb: "UAL2_Standard.glb" },
} as const

export async function loadUal(pack: keyof typeof UAL, dir = join(fixturesDir, "ual")): Promise<Uint8Array> {
  const path = join(dir, UAL[pack].glb)
  if (!existsSync(path)) {
    console.log(`fetching Quaternius ${pack}…`)
    const res = await fetch(UAL[pack].url)
    if (!res.ok) throw new Error(`Could not download ${UAL[pack].url} (${res.status})`)
    const glb = readLocalZip(new Uint8Array(await res.arrayBuffer()), UAL[pack].glb)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, glb)
  }
  return new Uint8Array(readFileSync(path))
}

type Gltf = {
  nodes: { name: string; children?: number[]; translation?: V3; rotation?: Q; scale?: V3 }[]
  animations: { name: string; channels: { sampler: number; target: { node: number; path: string } }[]; samplers: { input: number; output: number; interpolation?: string }[] }[]
  accessors: { bufferView: number; byteOffset?: number; count: number; type: string; componentType: number }[]
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[]
}

const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]
const qrot = (q: Q, v: V3): V3 => {
  const [x, y, z, w] = q
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0])
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]
}
const qslerp = (a: Q, b: Q, t: number): Q => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const s = d < 0 ? -1 : 1
  d = Math.abs(d)
  if (d > 0.9995) {
    const r: Q = [a[0] + (s * b[0] - a[0]) * t, a[1] + (s * b[1] - a[1]) * t, a[2] + (s * b[2] - a[2]) * t, a[3] + (s * b[3] - a[3]) * t]
    const n = Math.hypot(...r)
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n]
  }
  const th = Math.acos(d), k0 = Math.sin((1 - t) * th) / Math.sin(th), k1 = (s * Math.sin(t * th)) / Math.sin(th)
  return [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1, a[3] * k0 + b[3] * k1]
}

const UAL_NAMES: Record<string, string> = {
  pelvis: "Hips", spine_02: "Chest", neck_01: "Neck", Head: "Head",
  upperarm_l: "UpperArm_L", lowerarm_l: "LowerArm_L", hand_l: "Hand_L",
  upperarm_r: "UpperArm_R", lowerarm_r: "LowerArm_R", hand_r: "Hand_R",
  thigh_l: "UpperLeg_L", calf_l: "LowerLeg_L", foot_l: "Foot_L", ball_l: "Toes_L",
  thigh_r: "UpperLeg_R", calf_r: "LowerLeg_R", foot_r: "Foot_R", ball_r: "Toes_R",
  // UAL1's Godot export keeps Rigify deform names.
  "DEF-hips": "Hips", "DEF-spine.002": "Chest", "DEF-neck": "Neck", "DEF-head": "Head",
  "DEF-upper_arm.L": "UpperArm_L", "DEF-forearm.L": "LowerArm_L", "DEF-hand.L": "Hand_L",
  "DEF-upper_arm.R": "UpperArm_R", "DEF-forearm.R": "LowerArm_R", "DEF-hand.R": "Hand_R",
  "DEF-thigh.L": "UpperLeg_L", "DEF-shin.L": "LowerLeg_L", "DEF-foot.L": "Foot_L", "DEF-toe.L": "Toes_L",
  "DEF-thigh.R": "UpperLeg_R", "DEF-shin.R": "LowerLeg_R", "DEF-foot.R": "Foot_R", "DEF-toe.R": "Toes_R",
}

export function ualClipNames(glb: Uint8Array): string[] {
  return parseGlb(glb).json.animations.map(a => a.name)
}

function parseGlb(glb: Uint8Array): { json: Gltf; bin: Uint8Array } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLen = dv.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as Gltf
  const binStart = 20 + jsonLen + 8
  return { json, bin: glb.subarray(binStart, binStart + dv.getUint32(20 + jsonLen, true)) }
}

/** Samples a glTF clip at `fps` through forward kinematics; root motion is kept when the clip has it. */
export function ualClip(glb: Uint8Array, clipName: string, fps = 60): BvhClip {
  const { json, bin } = parseGlb(glb)
  const anim = json.animations.find(a => a.name === clipName)
  if (!anim) throw new Error(`no clip ${clipName}`)
  const read = (i: number): Float32Array => {
    const acc = json.accessors[i]!
    if (acc.componentType !== 5126) throw new Error("only float accessors are supported")
    const bv = json.bufferViews[acc.bufferView]!
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type as "SCALAR"]!
    const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    const out = new Float32Array(acc.count * n)
    const view = new DataView(bin.buffer, bin.byteOffset)
    const stride = bv.byteStride ?? n * 4
    for (let k = 0; k < acc.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = view.getFloat32(start + k * stride + c * 4, true)
    return out
  }
  const tracks = anim.channels.map(ch => {
    const s = anim.samplers[ch.sampler]!
    return { node: ch.target.node, path: ch.target.path, t: read(s.input), v: read(s.output), step: s.interpolation === "STEP" }
  })
  const duration = Math.max(...tracks.map(t => t.t[t.t.length - 1]!))
  const parent = new Map<number, number>()
  json.nodes.forEach((n, i) => n.children?.forEach(c => parent.set(c, i)))
  const order: number[] = []
  const visit = (i: number) => { order.push(i); json.nodes[i]!.children?.forEach(visit) }
  json.nodes.forEach((_, i) => { if (!parent.has(i)) visit(i) })

  const sample = (tr: (typeof tracks)[number], time: number, n: number): number[] => {
    const t = tr.t
    let k = 0
    while (k < t.length - 1 && t[k + 1]! <= time) k++
    const k1 = Math.min(t.length - 1, k + 1)
    const u = tr.step || k1 === k ? 0 : Math.max(0, Math.min(1, (time - t[k]!) / (t[k1]! - t[k]!)))
    const a = Array.from(tr.v.subarray(k * n, k * n + n)), b = Array.from(tr.v.subarray(k1 * n, k1 * n + n))
    if (n === 4) return qslerp(a as Q, b as Q, u)
    return a.map((x, c) => x + (b[c]! - x) * u)
  }

  const frames: Record<string, V3>[] = []
  const nFrames = Math.max(2, Math.round(duration * fps) + 1)
  for (let f = 0; f < nFrames; f++) {
    const time = Math.min(duration, f / fps)
    const local = json.nodes.map(n => ({ t: [...(n.translation ?? [0, 0, 0])] as V3, r: [...(n.rotation ?? [0, 0, 0, 1])] as Q, s: [...(n.scale ?? [1, 1, 1])] as V3 }))
    for (const tr of tracks) {
      if (tr.path === "translation") local[tr.node]!.t = sample(tr, time, 3) as V3
      else if (tr.path === "rotation") local[tr.node]!.r = sample(tr, time, 4) as Q
      else if (tr.path === "scale") local[tr.node]!.s = sample(tr, time, 3) as V3
    }
    const world: { p: V3; r: Q; s: V3 }[] = []
    for (const i of order) {
      const l = local[i]!
      const pi = parent.get(i)
      if (pi === undefined) world[i] = { p: l.t, r: l.r, s: l.s }
      else {
        const pw = world[pi]!
        const scaled: V3 = [l.t[0] * pw.s[0], l.t[1] * pw.s[1], l.t[2] * pw.s[2]]
        const d = qrot(pw.r, scaled)
        world[i] = { p: [pw.p[0] + d[0], pw.p[1] + d[1], pw.p[2] + d[2]], r: qmul(pw.r, l.r), s: [pw.s[0] * l.s[0], pw.s[1] * l.s[1], pw.s[2] * l.s[2]] }
      }
    }
    const out: Record<string, V3> = {}
    json.nodes.forEach((n, i) => {
      const k = UAL_NAMES[n.name]
      // glTF characters face +Z with +X to their left; canonical is +X forward, +Z right.
      if (k) out[k] = [world[i]!.p[2], world[i]!.p[1], -world[i]!.p[0]]
    })
    frames.push(out)
  }
  return { dt: 1 / fps, frames }
}

// ---------------------------------------------------------------------------------------------- normalisation
const BANDAI_FOOT_SLOPE = (-38.97 * Math.PI) / 180

/**
 * Prepares a source clip for `retargetBvhFrame`: rotates it about Y so the body faces +X (from the mean hip bar),
 * and re-pitches each Foot→Toes vector so its flat-stance slope equals the Bandai rest slope `retargetBvhFrame`
 * assumes (100STYLE's ankle→toe and UAL's foot→ball sit at different angles).
 */
export function normaliseClip(clip: BvhClip, start = 0, end = clip.frames.length): BvhClip & { footSlopeDeg: [number, number] } {
  const frames = clip.frames.slice(start, end)
  let fx = 0, fz = 0
  for (const f of frames) {
    const bar = [f.UpperLeg_R![0] - f.UpperLeg_L![0], f.UpperLeg_R![2] - f.UpperLeg_L![2]]
    // forward = up × hipBar(L→R): (bz, -bx) in (x, z)
    fx += bar[1]!
    fz += -bar[0]!
  }
  const yaw = Math.atan2(fz, fx)
  const c = Math.cos(-yaw), s = Math.sin(-yaw)
  const turn = (v: V3): V3 => [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c]
  const rotated = frames.map(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, turn(v)])) as Record<string, V3>)
  const slopes: [number, number] = [0, 0]
  for (const [side, i] of [["L", 0], ["R", 1]] as const) {
    const foot = `Foot_${side}`, toe = `Toes_${side}`
    const minToe = Math.min(...rotated.map(f => f[toe]![1]))
    const minFoot = Math.min(...rotated.map(f => f[foot]![1]))
    const flat = rotated.filter(f => f[toe]![1] < minToe + 0.015 && f[foot]![1] < minFoot + 0.015)
    const pitchOf = (f: Record<string, V3>) => {
      const d = [f[toe]![0] - f[foot]![0], f[toe]![1] - f[foot]![1], f[toe]![2] - f[foot]![2]]
      return Math.atan2(d[1]!, Math.hypot(d[0]!, d[2]!))
    }
    const rest = flat.length ? flat.reduce((a, f) => a + pitchOf(f), 0) / flat.length : BANDAI_FOOT_SLOPE
    slopes[i] = Math.round(((rest * 180) / Math.PI) * 100) / 100
    const delta = BANDAI_FOOT_SLOPE - rest
    for (const f of rotated) {
      const a = f[foot]!, b = f[toe]!
      const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const h = Math.hypot(d[0], d[2]), L = Math.hypot(h, d[1])
      const p = Math.atan2(d[1], h) + delta
      const hx = h > 1e-6 ? d[0] / h : 1, hz = h > 1e-6 ? d[2] / h : 0
      f[toe] = [a[0] + hx * Math.cos(p) * L, a[1] + Math.sin(p) * L, a[2] + hz * Math.cos(p) * L]
    }
  }
  return { dt: clip.dt, frames: rotated, footSlopeDeg: slopes }
}

/** Ground speed of an in-place or travelling clip from the planted (lowest) foot's backward speed relative to the hips. */
export function clipGroundSpeed(clip: BvhClip): number {
  let sum = 0, n = 0
  for (let i = 1; i < clip.frames.length; i++) {
    const a = clip.frames[i - 1]!, b = clip.frames[i]!
    const side = b.Foot_L![1] < b.Foot_R![1] ? "L" : "R"
    const rel = (f: Record<string, V3>) => f[`Foot_${side}`]![0] - f.Hips![0]
    const prevSide = a.Foot_L![1] < a.Foot_R![1] ? "L" : "R"
    if (side !== prevSide) continue
    sum += -(rel(b) - rel(a)) / clip.dt
    n++
  }
  return n ? sum / n : 0
}

/** Windowed hips speed (m/s along the facing) over a long take, to pick a steady stretch at a target speed. */
export function findSteadyWindow(clip: BvhClip, targetSpeed: number, windowSec = 2.5): { start: number; end: number; speed: number } {
  const w = Math.round(windowSec / clip.dt)
  let best = { start: 0, end: Math.min(clip.frames.length, w), speed: 0, score: Infinity }
  for (let s = 0; s + w < clip.frames.length; s += Math.round(0.25 / clip.dt)) {
    const a = clip.frames[s]!.Hips!, b = clip.frames[s + w]!.Hips!
    const dist = Math.hypot(b[0] - a[0], b[2] - a[2])
    const speed = dist / (w * clip.dt)
    // Straightness: the path length over the window should equal its chord.
    let path = 0
    for (let k = s + 6; k <= s + w; k += 6) {
      const p = clip.frames[k - 6]!.Hips!, q = clip.frames[k]!.Hips!
      path += Math.hypot(q[0] - p[0], q[2] - p[2])
    }
    const straight = dist / Math.max(1e-6, path)
    const score = Math.abs(speed - targetSpeed) + (1 - straight) * 4
    if (score < best.score) best = { start: s, end: s + w, speed, score }
  }
  return { start: best.start, end: best.end, speed: Math.round(best.speed * 100) / 100 }
}
