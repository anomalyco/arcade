import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { plugin } from "bun"

plugin({
  name: "mock-build-gen",
  setup(build) {
    build.onResolve({ filter: /build\.gen$/ }, (args) => ({ path: args.path, namespace: "build-gen" }))
    build.onLoad({ filter: /.*/, namespace: "build-gen" }, () => ({
      contents: `export const BUILD = "spike000"\n`,
      loader: "ts",
    }))
  },
})

const { ByteWriter, frame } = await import("../../packages/kit/net/bytes")
const { CoopSim } = await import("../../games/outbreak/shared/coop-sim")
const {
  decodeShared,
  decodeSnapshot,
  encodePersonal,
  encodeShared,
} = await import("../../games/outbreak/shared/net-protocol")

const wasmPath = join(import.meta.dir, "target/wasm32-unknown-unknown/release/arcade_net_spike.wasm")
const wasmBytes = readFileSync(wasmPath)

interface WasmExports {
  memory: WebAssembly.Memory
  zombies_ptr(): number
  decoded_zombies_ptr(): number
  wire_out_ptr(): number
  instance_out_ptr(): number
  rust_encode_bincode(count: number, tick: number, town_seed: number): number
  rust_decode_bincode(town_seed: number): number
  rust_encode_postcard(count: number, tick: number): number
  rust_decode_postcard(): number
  rust_record_history(count: number, tick: number): void
  rust_encode_delta_bitpack(
    count: number,
    tick: number,
    base_tick: number,
    viewer_x: number,
    viewer_y: number,
    interest_radius: number,
  ): number
  rust_decode_delta_bitpack(base_tick: number): number
  rust_step_world_and_encode_room(count: number, tick: number, dt: number): number
  rust_init_fixed_point(count: number): void
  rust_step_fixed_point(count: number, ticks: number): number
}

// Measure WASM cold-start compile + instantiate time
const coldCompileSamples: number[] = []
for (let i = 0; i < 15; i++) {
  const t0 = performance.now()
  const mod = new WebAssembly.Module(wasmBytes)
  const inst = new WebAssembly.Instance(mod, {})
  void inst.exports
  coldCompileSamples.push(performance.now() - t0)
}

const wasmMod = new WebAssembly.Module(wasmBytes)
const wasmInst = new WebAssembly.Instance(wasmMod, {})
const wasm = wasmInst.exports as unknown as WasmExports

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]!
}
const mad = (a: number[]) => {
  const m = median(a)
  return median(a.map((x) => Math.abs(x - m)))
}
const p95 = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!
}

function measure(fn: () => void, runs = 60, batch = 25, warmup = 20) {
  for (let i = 0; i < warmup * batch; i++) fn()
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    for (let b = 0; b < batch; b++) fn()
    times.push((performance.now() - t0) / batch)
  }
  return {
    medianUs: Number((median(times) * 1000).toFixed(2)),
    madUs: Number((mad(times) * 1000).toFixed(2)),
    p95Us: Number((p95(times) * 1000).toFixed(2)),
    medianMs: Number(median(times).toFixed(4)),
  }
}

// Setup realistic 300-zombie + 4-survivor Outbreak CoopSim
const N_ZOMBIES = 300
const sim = new CoopSim(7, 7, 0.22, { zombieCount: N_ZOMBIES }, undefined, "classic")
for (let i = 0; i < 4; i++) sim.addSurvivor(`p${i}`, i)

while (sim.ai.agents.length < N_ZOMBIES) {
  const idx = sim.ai.agents.length
  const zx = 6 + ((idx * 17) % 84)
  const zy = 6 + ((idx * 29) % 84)
  sim.ai.spawnZombie(sim.town, zx, zy, idx % 3 === 0 ? "chase" : idx % 5 === 0 ? "investigate" : "wander")
}
sim.ai.agents.length = N_ZOMBIES

const STATE_MAP: Record<string, number> = {
  wander: 0,
  investigate: 1,
  alert: 2,
  chase: 3,
  bash: 4,
  search: 5,
  stagger: 6,
  dead: 7,
}
const STATE_NAMES = ["wander", "investigate", "alert", "chase", "bash", "search", "stagger", "dead"] as const

for (let t = 0; t < 10; t++) {
  sim.stepWorld(1 / 60, 1)
}

const initialPos = sim.ai.agents.map((a, i) => ({
  id: i + 1,
  seed: 7,
  x: a.x,
  y: a.y,
  vx: i % 2 === 0 ? Math.cos(a.aim) * 2.4 : 0,
  vy: i % 2 === 0 ? Math.sin(a.aim) * 2.4 : 0,
  aim: a.aim,
  state: (i % 2 === 0 ? "chase" : "wander") as "chase" | "wander",
  hp: 100,
}))

function resetAgentsToSnapshotState() {
  for (let i = 0; i < N_ZOMBIES; i++) {
    const a = sim.ai.agents[i]!
    const src = initialPos[i]!
    a.id = src.id
    a.seed = src.seed
    a.x = src.x + src.vx * (3 / 60)
    a.y = src.y + src.vy * (3 / 60)
    a.vx = src.vx
    a.vy = src.vy
    a.aim = src.aim + (i % 2 === 0 ? 0.04 : 0)
    a.state = src.state
    a.hp = src.hp
  }
}
resetAgentsToSnapshotState()

// RawZombie is 44 bytes in WASM linear memory
const RAW_ZOMBIE_BYTES = 44
const zPtr = wasm.zombies_ptr()
const decPtr = wasm.decoded_zombies_ptr()

function marshalJsAgentsToWasm(agents: typeof sim.ai.agents) {
  const dv = new DataView(wasm.memory.buffer, zPtr, agents.length * RAW_ZOMBIE_BYTES)
  let off = 0
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!
    dv.setUint16(off, a.id, true)
    dv.setUint8(off + 2, STATE_MAP[a.state] ?? 0)
    dv.setUint8(off + 3, Math.round(a.hp))
    dv.setUint32(off + 4, a.seed, true)
    dv.setFloat32(off + 8, a.x, true)
    dv.setFloat32(off + 12, a.y, true)
    dv.setFloat32(off + 16, a.vx, true)
    dv.setFloat32(off + 20, a.vy, true)
    dv.setFloat32(off + 24, a.aim, true)
    dv.setFloat32(off + 28, a.hitFlash, true)
    dv.setFloat32(off + 32, a.stateTime, true)
    dv.setFloat32(off + 36, a.timer, true)
    dv.setFloat32(off + 40, a.clamberWindowId ? 0.5 : 0, true)
    off += RAW_ZOMBIE_BYTES
  }
}

const decodedJsPool = Array.from({ length: N_ZOMBIES }, (_, i) => ({
  id: i + 1,
  seed: 7,
  x: 0,
  y: 0,
  aim: 0,
  state: "wander" as (typeof STATE_NAMES)[number],
  hp: 100,
  hitFlash: 0,
  stateTime: 0,
  timer: 0,
  clamber: 0,
}))

function unmarshalWasmToJsObjects(count: number) {
  const dv = new DataView(wasm.memory.buffer, decPtr, count * RAW_ZOMBIE_BYTES)
  let off = 0
  for (let i = 0; i < count; i++) {
    const dst = decodedJsPool[i]!
    dst.id = dv.getUint16(off, true)
    dst.state = STATE_NAMES[dv.getUint8(off + 2) & 7] ?? "wander"
    dst.hp = dv.getUint8(off + 3)
    dst.seed = dv.getUint32(off + 4, true)
    dst.x = dv.getFloat32(off + 8, true)
    dst.y = dv.getFloat32(off + 12, true)
    dst.aim = dv.getFloat32(off + 24, true)
    dst.hitFlash = dv.getFloat32(off + 28, true)
    dst.stateTime = dv.getFloat32(off + 32, true)
    dst.timer = dv.getFloat32(off + 36, true)
    dst.clamber = dv.getFloat32(off + 40, true)
    off += RAW_ZOMBIE_BYTES
  }
}

// Seed baseline tick 97 and current tick 100 in both WASM and TS histories
for (let i = 0; i < N_ZOMBIES; i++) {
  const a = sim.ai.agents[i]!
  const src = initialPos[i]!
  a.x = src.x
  a.y = src.y
  a.aim = src.aim
}
marshalJsAgentsToWasm(sim.ai.agents)
wasm.rust_record_history(N_ZOMBIES, 97)

resetAgentsToSnapshotState()
marshalJsAgentsToWasm(sim.ai.agents)
wasm.rust_record_history(N_ZOMBIES, 100)

// Build TS 32-tick history ring buffer for Ideal TS Delta + Interest Bitpack comparison
const HISTORY_TICKS = 32
const tsHistQx = new Int16Array(HISTORY_TICKS * N_ZOMBIES)
const tsHistQy = new Int16Array(HISTORY_TICKS * N_ZOMBIES)
const tsHistQaim = new Uint8Array(HISTORY_TICKS * N_ZOMBIES)
const tsHistFlags = new Uint8Array(HISTORY_TICKS * N_ZOMBIES)
const tsHistHp = new Uint8Array(HISTORY_TICKS * N_ZOMBIES)

function tsRecordHistory(tick: number) {
  const base = (tick & 31) * N_ZOMBIES
  const agents = sim.ai.agents
  for (let i = 0; i < N_ZOMBIES; i++) {
    const a = agents[i]!
    tsHistQx[base + i] = Math.round(a.x * 50)
    tsHistQy[base + i] = Math.round(a.y * 50)
    tsHistQaim[base + i] = Math.round((((a.aim / (Math.PI * 2)) % 1) + 1) % 1 * 256) & 0xff
    tsHistFlags[base + i] = (STATE_MAP[a.state] ?? 0) | (a.hitFlash > 0.02 ? 8 : 0) | (a.clamberWindowId ? 16 : 0)
    tsHistHp[base + i] = Math.round(a.hp)
  }
}

for (let i = 0; i < N_ZOMBIES; i++) {
  const src = initialPos[i]!
  const base97 = (97 & 31) * N_ZOMBIES
  tsHistQx[base97 + i] = Math.round(src.x * 50)
  tsHistQy[base97 + i] = Math.round(src.y * 50)
  tsHistQaim[base97 + i] = Math.round((((src.aim / (Math.PI * 2)) % 1) + 1) % 1 * 256) & 0xff
  tsHistFlags[base97 + i] = STATE_MAP[src.state] ?? 0
  tsHistHp[base97 + i] = src.hp
}
tsRecordHistory(100)

const tsDeltaBuf = new Uint8Array(16384)
const tsDeltaView = new DataView(tsDeltaBuf.buffer)

function tsEncodeDeltaBitpack(tick: number, baseTick: number, vx: number, vy: number, radius: number): Uint8Array {
  const curBase = (tick & 31) * N_ZOMBIES
  const oldBase = (baseTick & 31) * N_ZOMBIES
  const hasBase = baseTick < tick && tick - baseTick < 32
  const qvx = Math.round(vx * 50)
  const qvy = Math.round(vy * 50)
  const qr2 = Math.round(radius * radius * 2500)

  tsDeltaView.setUint32(0, tick, true)
  tsDeltaView.setUint32(4, hasBase ? baseTick : 0xffffffff, true)
  let off = 10
  let written = 0

  for (let i = 0; i < N_ZOMBIES; i++) {
    const ci = curBase + i
    const qx = tsHistQx[ci]!
    const qy = tsHistQy[ci]!
    const dxv = qx - qvx
    const dyv = qy - qvy
    if (dxv * dxv + dyv * dyv > qr2) continue

    const qaim = tsHistQaim[ci]!
    const sf = tsHistFlags[ci]!
    const hp = tsHistHp[ci]!

    if (hasBase) {
      const bi = oldBase + i
      const dx = qx - tsHistQx[bi]!
      const dy = qy - tsHistQy[bi]!
      const daim = ((qaim - tsHistQaim[bi]!) << 24) >> 24
      const sameMeta = sf === tsHistFlags[bi]! && hp === tsHistHp[bi]!
      if (dx === 0 && dy === 0 && daim === 0 && sameMeta) continue
      if (dx >= -127 && dx <= 127 && dy >= -127 && dy <= 127 && sameMeta) {
        tsDeltaView.setUint16(off, (i + 1) | 0x8000, true)
        tsDeltaBuf[off + 2] = dx & 0xff
        tsDeltaBuf[off + 3] = dy & 0xff
        tsDeltaBuf[off + 4] = daim & 0xff
        off += 5
        written++
        continue
      }
    }
    tsDeltaView.setUint16(off, (i + 1) & 0x7fff, true)
    tsDeltaView.setInt16(off + 2, qx, true)
    tsDeltaView.setInt16(off + 4, qy, true)
    tsDeltaBuf[off + 6] = qaim
    tsDeltaBuf[off + 7] = sf
    tsDeltaBuf[off + 8] = hp
    off += 9
    written++
  }
  tsDeltaView.setUint16(8, written, true)
  return tsDeltaBuf.subarray(0, off)
}

function tsDecodeDeltaBitpack(pkt: Uint8Array, baseTick: number): number {
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength)
  const written = dv.getUint16(8, true)
  const oldBase = (baseTick & 31) * N_ZOMBIES
  let off = 10
  for (let i = 0; i < written; i++) {
    const rawId = dv.getUint16(off, true)
    const isDelta = (rawId & 0x8000) !== 0
    const id = rawId & 0x7fff
    const idx = id - 1
    const dst = decodedJsPool[i]!
    dst.id = id
    if (isDelta) {
      const bi = oldBase + idx
      const dx = (pkt[off + 2]! << 24) >> 24
      const dy = (pkt[off + 3]! << 24) >> 24
      const daim = (pkt[off + 4]! << 24) >> 24
      off += 5
      dst.x = (tsHistQx[bi]! + dx) * 0.02
      dst.y = (tsHistQy[bi]! + dy) * 0.02
      dst.aim = (((tsHistQaim[bi]! + daim) & 0xff) / 256) * Math.PI * 2
      dst.state = STATE_NAMES[tsHistFlags[bi]! & 7] ?? "wander"
      dst.hp = tsHistHp[bi]!
    } else {
      const qx = dv.getInt16(off + 2, true)
      const qy = dv.getInt16(off + 4, true)
      const qaim = pkt[off + 6]!
      const sf = pkt[off + 7]!
      const hp = pkt[off + 8]!
      off += 9
      dst.x = qx * 0.02
      dst.y = qy * 0.02
      dst.aim = (qaim / 256) * Math.PI * 2
      dst.state = STATE_NAMES[sf & 7] ?? "wander"
      dst.hp = hp
    }
  }
  return written
}

const personalBuf = new Uint8Array(64)
const personalDv = new DataView(personalBuf.buffer)
function encodePersonalBinary(ack: number, s: (typeof sim.slots)[0]["survivor"]): Uint8Array {
  personalDv.setUint32(0, ack < 0 ? 0xffffffff : ack, true)
  personalDv.setFloat32(4, s.x, true)
  personalDv.setFloat32(8, s.y, true)
  personalDv.setFloat32(12, s.aim, true)
  personalDv.setFloat32(16, s.stamina, true)
  personalDv.setFloat32(20, s.battery, true)
  personalDv.setFloat32(24, s.flashlightOutput, true)
  personalDv.setFloat32(28, s.reloadRemaining, true)
  personalDv.setFloat32(32, s.fireCooldown, true)
  personalDv.setFloat32(36, s.shoveCooldown, true)
  personalBuf[40] = Math.round(s.health)
  personalBuf[41] = s.magAmmo
  personalBuf[42] = s.reserveAmmo
  personalBuf[43] = s.planks
  personalBuf[44] = (s.flashlightOn ? 1 : 0) | (s.sprinting ? 2 : 0) | (s.exhausted ? 4 : 0) | (s.batteryDepleted ? 8 : 0)
  return personalBuf.subarray(0, 48)
}

// ============================================================================
// RUN ALL CODEC BENCHMARKS (300 ZOMBIES, 4 SURVIVORS)
// ============================================================================
const sharedWriter = new ByteWriter(8192)
const shooters = new Map<number, number>()

// 1. Current Outbreak TS (encodeShared + 4x encodePersonal JSON + decodeSnapshot)
let curSnapBytes = 0
let curSharedBytes = 0
const curEncodeBench = measure(() => {
  const shared = encodeShared(sim, 100, shooters, sharedWriter)
  curSharedBytes = shared.byteLength
  let total = 0
  for (const slot of sim.slots) {
    const pkt = frame(encodePersonal(100, slot.survivor, null, []), shared)
    total += pkt.byteLength
  }
  curSnapBytes = Math.round(total / sim.slots.length)
})
const sampleCurPkt = frame(encodePersonal(100, sim.slots[0]!.survivor, null, []), encodeShared(sim, 100, shooters, sharedWriter))
const curDecodeBench = measure(() => {
  decodeSnapshot(sampleCurPkt, 7)
})

// 2. Hand-Rolled TS Binary (encodeShared + 4x encodePersonalBinary, no JSON)
let binPersonalSnapBytes = 0
const tsBinFullEncodeBench = measure(() => {
  const shared = encodeShared(sim, 100, shooters, sharedWriter)
  let total = 0
  for (const slot of sim.slots) {
    const pkt = frame(encodePersonalBinary(100, slot.survivor), shared)
    total += pkt.byteLength
  }
  binPersonalSnapBytes = Math.round(total / sim.slots.length)
})
const sampleSharedOnly = encodeShared(sim, 100, shooters, sharedWriter)
const tsBinFullDecodeBench = measure(() => {
  decodeShared(sampleSharedOnly, 7)
})

// 3. Ideal TS Binary (60m Interest + 32-tick Acked Delta + 2cm Quantized Bit-Pack)
let tsDeltaKeyframeBytes = 0
let tsDeltaAckedBytes = 0
const tsDeltaKeyframeEncodeBench = measure(() => {
  tsRecordHistory(100)
  const pkt = tsEncodeDeltaBitpack(100, 0xffffffff, 27.7, 41.0, 60.0)
  tsDeltaKeyframeBytes = pkt.byteLength + 48
})
const tsDeltaAckedEncodeBench = measure(() => {
  tsRecordHistory(100)
  const pkt = tsEncodeDeltaBitpack(100, 97, 27.7, 41.0, 60.0)
  tsDeltaAckedBytes = pkt.byteLength + 48
})
const sampleTsDeltaPkt = tsEncodeDeltaBitpack(100, 97, 27.7, 41.0, 60.0).slice()
const tsDeltaAckedDecodeBench = measure(() => {
  tsDecodeDeltaBitpack(sampleTsDeltaPkt, 97)
})

// 4a. Rust-WASM Bincode (Zero-Copy vs With JS <-> WASM Marshaling)
let rustBincodeBytes = 0
const rustBincodeZeroCopyEncode = measure(() => {
  rustBincodeBytes = wasm.rust_encode_bincode(N_ZOMBIES, 100, 7) + 48
})
const rustBincodeWithMarshalEncode = measure(() => {
  marshalJsAgentsToWasm(sim.ai.agents)
  rustBincodeBytes = wasm.rust_encode_bincode(N_ZOMBIES, 100, 7) + 48
})
wasm.rust_encode_bincode(N_ZOMBIES, 100, 7)
const rustBincodeZeroCopyDecode = measure(() => {
  wasm.rust_decode_bincode(7)
})
const rustBincodeWithMarshalDecode = measure(() => {
  const n = wasm.rust_decode_bincode(7)
  unmarshalWasmToJsObjects(n)
})

// 4b. Rust-WASM Postcard ZigZag Varint (Zero-Copy vs With JS <-> WASM Marshaling)
let rustPostcardBytes = 0
const rustPostcardZeroCopyEncode = measure(() => {
  rustPostcardBytes = wasm.rust_encode_postcard(N_ZOMBIES, 100) + 48
})
const rustPostcardWithMarshalEncode = measure(() => {
  marshalJsAgentsToWasm(sim.ai.agents)
  rustPostcardBytes = wasm.rust_encode_postcard(N_ZOMBIES, 100) + 48
})
wasm.rust_encode_postcard(N_ZOMBIES, 100)
const rustPostcardZeroCopyDecode = measure(() => {
  wasm.rust_decode_postcard()
})
const rustPostcardWithMarshalDecode = measure(() => {
  const n = wasm.rust_decode_postcard()
  unmarshalWasmToJsObjects(n)
})

// 4c. Rust-WASM Bitcode-Style Delta + Interest Bit-Pack (Zero-Copy vs With JS <-> WASM Marshaling)
let rustDeltaBytes = 0
const rustDeltaZeroCopyEncode = measure(() => {
  wasm.rust_record_history(N_ZOMBIES, 100)
  rustDeltaBytes = wasm.rust_encode_delta_bitpack(N_ZOMBIES, 100, 97, 27.7, 41.0, 60.0) + 48
})
const rustDeltaWithMarshalEncode = measure(() => {
  marshalJsAgentsToWasm(sim.ai.agents)
  wasm.rust_record_history(N_ZOMBIES, 100)
  rustDeltaBytes = wasm.rust_encode_delta_bitpack(N_ZOMBIES, 100, 97, 27.7, 41.0, 60.0) + 48
})
wasm.rust_encode_delta_bitpack(N_ZOMBIES, 100, 97, 27.7, 41.0, 60.0)
const rustDeltaZeroCopyDecode = measure(() => {
  wasm.rust_decode_delta_bitpack(97)
})
const rustDeltaWithMarshalDecode = measure(() => {
  const n = wasm.rust_decode_delta_bitpack(97)
  unmarshalWasmToJsObjects(n)
})

// ============================================================================
// 5. FULL 60 HZ DURABLE OBJECT ROOM TICK (300 ZOMBIES, 4 SURVIVORS, SNAPSHOTS)
// ============================================================================
// 5a. Data-Oriented TS Room Tick (SoA spatial hash separation + steering + Ideal TS Delta/Interest Codec)
const soaX = new Float32Array(N_ZOMBIES)
const soaY = new Float32Array(N_ZOMBIES)
const soaVx = new Float32Array(N_ZOMBIES)
const soaVy = new Float32Array(N_ZOMBIES)
const soaState = new Uint8Array(N_ZOMBIES)
const cellHead = new Int16Array(64 * 64)
const agentNext = new Int16Array(N_ZOMBIES)
for (let i = 0; i < N_ZOMBIES; i++) {
  soaX[i] = initialPos[i]!.x
  soaY[i] = initialPos[i]!.y
  soaVx[i] = initialPos[i]!.vx
  soaVy[i] = initialPos[i]!.vy
  soaState[i] = i % 2 === 0 ? 3 : 0
}
let soaTick = 100
const fullTickDataOrientedTS = measure(() => {
  soaTick++
  const dt = 1 / 60
  cellHead.fill(-1)
  for (let i = 0; i < N_ZOMBIES; i++) {
    const cx = Math.max(0, Math.min(63, (soaX[i]! * 0.6666667) | 0))
    const cy = Math.max(0, Math.min(63, (soaY[i]! * 0.6666667) | 0))
    const cell = cy * 64 + cx
    agentNext[i] = cellHead[cell]!
    cellHead[cell] = i
  }
  for (let i = 0; i < N_ZOMBIES; i++) {
    const zx = soaX[i]!, zy = soaY[i]!
    const bdx = 27.7 - zx, bdy = 41.0 - zy
    const bd2 = bdx * bdx + bdy * bdy
    const cx = Math.max(1, Math.min(62, (zx * 0.6666667) | 0))
    const cy = Math.max(1, Math.min(62, (zy * 0.6666667) | 0))
    let sepX = 0, sepY = 0
    for (let dyc = -1; dyc <= 1; dyc++) {
      const row = (cy + dyc) * 64
      for (let dxc = -1; dxc <= 1; dxc++) {
        let cur = cellHead[row + cx + dxc]!
        while (cur >= 0) {
          if (cur !== i) {
            const rx = zx - soaX[cur]!, ry = zy - soaY[cur]!
            const d2 = rx * rx + ry * ry
            if (d2 > 1e-4 && d2 < 0.64) {
              const inv = 1 / Math.sqrt(d2)
              const push = (0.8 - d2 * inv) * 1.4
              sepX += rx * inv * push
              sepY += ry * inv * push
            }
          }
          cur = agentNext[cur]!
        }
      }
    }
    const d = Math.max(1e-3, Math.sqrt(bd2))
    const spd = soaState[i] === 3 ? 2.65 : 0.95
    const dirX = bdx / d + sepX, dirY = bdy / d + sepY
    const dirLen = Math.max(1e-3, Math.sqrt(dirX * dirX + dirY * dirY))
    soaVx[i] = (dirX / dirLen) * spd
    soaVy[i] = (dirY / dirLen) * spd
    soaX[i] = Math.max(1, Math.min(95, zx + soaVx[i]! * dt))
    soaY[i] = Math.max(1, Math.min(95, zy + soaVy[i]! * dt))
  }
  const base = (soaTick & 31) * N_ZOMBIES
  for (let i = 0; i < N_ZOMBIES; i++) {
    tsHistQx[base + i] = Math.round(soaX[i]! * 50)
    tsHistQy[base + i] = Math.round(soaY[i]! * 50)
  }
  if (soaTick % 3 === 0) {
    for (let s = 0; s < 4; s++) {
      tsEncodeDeltaBitpack(soaTick, soaTick - 3, 27.7, 41.0, 60.0)
    }
  }
}, 40, 10, 10)

let rustRoomTick = 100
const fullTickSharedRustWasm = measure(() => {
  rustRoomTick++
  wasm.rust_step_world_and_encode_room(N_ZOMBIES, rustRoomTick, 1 / 60)
}, 40, 10, 10)

let simTick = 100
const fullTickCurrentTS = measure(() => {
  simTick++
  sim.stepWorld(1 / 60, 1)
  if (simTick % 3 === 0) {
    const shared = encodeShared(sim, simTick, shooters, sharedWriter)
    for (const slot of sim.slots) {
      void frame(encodePersonal(simTick, slot.survivor, null, []), shared)
    }
  }
}, 30, 3, 5)

// ============================================================================
// 6. FIXED-POINT Q16.16 DETERMINISM PROOF (1,000 TICKS x 300 ZOMBIES)
// ============================================================================
wasm.rust_init_fixed_point(N_ZOMBIES)
const fpRustHash = wasm.rust_step_fixed_point(N_ZOMBIES, 1000) >>> 0

const tsFpX = new Int32Array(N_ZOMBIES)
const tsFpY = new Int32Array(N_ZOMBIES)
const tsFpVx = new Int32Array(N_ZOMBIES)
const tsFpVy = new Int32Array(N_ZOMBIES)
const tsFpAim = new Uint16Array(N_ZOMBIES)

function initTsFixedPoint() {
  for (let i = 0; i < N_ZOMBIES; i++) {
    const zx = 6 + ((i * 17) % 84)
    const zy = 6 + ((i * 29) % 84)
    tsFpX[i] = zx << 16
    tsFpY[i] = zy << 16
    tsFpVx[i] = 0
    tsFpVy[i] = 0
    tsFpAim[i] = (i * 2600) & 0xffff
  }
}

function stepTsFixedPoint(ticks: number): number {
  const targetX = (27.7 * 65536.0) | 0
  const targetY = (41.0 * 65536.0) | 0
  for (let t = 0; t < ticks; t++) {
    for (let i = 0; i < N_ZOMBIES; i++) {
      const dx = (targetX - tsFpX[i]!) >> 8
      const dy = (targetY - tsFpY[i]!) >> 8
      const adx = Math.abs(dx)
      const ady = Math.abs(dy)
      const distApprox = Math.max(adx, ady) + (Math.min(adx, ady) >> 1)
      if (distApprox > 16) {
        const vx = ((dx * 2185) / distApprox) | 0
        const vy = ((dy * 2185) / distApprox) | 0
        tsFpVx[i] = vx
        tsFpVy[i] = vy
        tsFpX[i] = (tsFpX[i]! + vx) | 0
        tsFpY[i] = (tsFpY[i]! + vy) | 0
        tsFpAim[i] = (tsFpAim[i]! + 91) & 0xffff
      }
    }
  }
  let h = 2166136261 >>> 0
  for (let i = 0; i < N_ZOMBIES; i++) {
    h ^= tsFpX[i]! >>> 0
    h = Math.imul(h, 16777619) >>> 0
    h ^= tsFpY[i]! >>> 0
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

initTsFixedPoint()
const fpTsHash = stepTsFixedPoint(1000)

const fpRustBench = measure(() => {
  wasm.rust_step_fixed_point(N_ZOMBIES, 1)
})
const fpTsBench = measure(() => {
  stepTsFixedPoint(1)
})

const results = {
  runtime: `Bun ${Bun.version} (JavaScriptCore)`,
  wasmBinaryBytes: wasmBytes.byteLength,
  wasmColdStartCompileInstantiateMs: {
    medianMs: Number(median(coldCompileSamples).toFixed(3)),
    p95Ms: Number(p95(coldCompileSamples).toFixed(3)),
  },
  scenario: {
    zombies: N_ZOMBIES,
    survivors: 4,
    snapshotHz: 20,
    simHz: 60,
  },
  codecs300Zombies: {
    "1_current_outbreak_ts_json_personal": {
      encode: curEncodeBench,
      decode: curDecodeBench,
      bytesPerPlayerSnap: curSnapBytes,
      sharedBytes: curSharedBytes,
      perClientKBpsAt20Hz: Number(((curSnapBytes * 20) / 1024).toFixed(2)),
      room4pEgressKBpsAt20Hz: Number(((curSnapBytes * 4 * 20) / 1024).toFixed(2)),
    },
    "2_ts_dataview_binary_full": {
      encode: tsBinFullEncodeBench,
      decode: tsBinFullDecodeBench,
      bytesPerPlayerSnap: binPersonalSnapBytes,
      perClientKBpsAt20Hz: Number(((binPersonalSnapBytes * 20) / 1024).toFixed(2)),
      room4pEgressKBpsAt20Hz: Number(((binPersonalSnapBytes * 4 * 20) / 1024).toFixed(2)),
    },
    "3_ideal_ts_interest60m_delta_bitpack": {
      encodeKeyframe: tsDeltaKeyframeEncodeBench,
      encodeDelta: tsDeltaAckedEncodeBench,
      decodeDelta: tsDeltaAckedDecodeBench,
      keyframeBytesPerSnap: tsDeltaKeyframeBytes,
      deltaBytesPerSnap: tsDeltaAckedBytes,
      perClientKBpsAt20Hz: Number(((tsDeltaAckedBytes * 20) / 1024).toFixed(2)),
      room4pEgressKBpsAt20Hz: Number(((tsDeltaAckedBytes * 4 * 20) / 1024).toFixed(2)),
    },
    "4a_rust_wasm_bincode": {
      encodeZeroCopy: rustBincodeZeroCopyEncode,
      encodeWithJsMarshal: rustBincodeWithMarshalEncode,
      decodeZeroCopy: rustBincodeZeroCopyDecode,
      decodeWithJsMarshal: rustBincodeWithMarshalDecode,
      bytesPerPlayerSnap: rustBincodeBytes,
      perClientKBpsAt20Hz: Number(((rustBincodeBytes * 20) / 1024).toFixed(2)),
    },
    "4b_rust_wasm_postcard_varint": {
      encodeZeroCopy: rustPostcardZeroCopyEncode,
      encodeWithJsMarshal: rustPostcardWithMarshalEncode,
      decodeZeroCopy: rustPostcardZeroCopyDecode,
      decodeWithJsMarshal: rustPostcardWithMarshalDecode,
      bytesPerPlayerSnap: rustPostcardBytes,
      perClientKBpsAt20Hz: Number(((rustPostcardBytes * 20) / 1024).toFixed(2)),
    },
    "4c_rust_wasm_bitcode_delta_interest": {
      encodeZeroCopy: rustDeltaZeroCopyEncode,
      encodeWithJsMarshal: rustDeltaWithMarshalEncode,
      decodeZeroCopy: rustDeltaZeroCopyDecode,
      decodeWithJsMarshal: rustDeltaWithMarshalDecode,
      bytesPerPlayerSnap: rustDeltaBytes,
      perClientKBpsAt20Hz: Number(((rustDeltaBytes * 20) / 1024).toFixed(2)),
      room4pEgressKBpsAt20Hz: Number(((rustDeltaBytes * 4 * 20) / 1024).toFixed(2)),
    },
  },
  durableObjectRoomTick300Zombies: {
    currentOutbreakTs60HzTick: fullTickCurrentTS,
    dataOrientedTs60HzTick: fullTickDataOrientedTS,
    sharedRustWasm60HzTick: fullTickSharedRustWasm,
    dataOrientedTsVsCurrentSpeedup: Number((fullTickCurrentTS.medianUs / fullTickDataOrientedTS.medianUs).toFixed(2)),
    rustWasmVsDataOrientedTsSpeedup: Number((fullTickDataOrientedTS.medianUs / fullTickSharedRustWasm.medianUs).toFixed(2)),
    rustWasmVsCurrentTsSpeedup: Number((fullTickCurrentTS.medianUs / fullTickSharedRustWasm.medianUs).toFixed(2)),
  },
  fixedPointQ16_16Determinism1000Ticks: {
    rustWasmDigestHex: `0x${fpRustHash.toString(16).padStart(8, "0")}`,
    tsInt32DigestHex: `0x${fpTsHash.toString(16).padStart(8, "0")}`,
    bitExactMatch: fpRustHash === fpTsHash,
    rustStepPerTick: fpRustBench,
    tsStepPerTick: fpTsBench,
  },
}

writeFileSync(join(import.meta.dir, "results-bun.json"), JSON.stringify(results, null, 2) + "\n")
console.log(JSON.stringify(results, null, 2))
