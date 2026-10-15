import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright-core"

const wasmPath = join(import.meta.dir, "target/wasm32-unknown-unknown/release/arcade_net_spike.wasm")
const wasmBytes = readFileSync(wasmPath)
const wasmBase64 = wasmBytes.toString("base64")

function computeFloatTranscendentalDigest(): { digestHex: string; finalVal: number; sampleSin: number; sampleAtan2: number } {
  let x = 0.123456789
  let y = 0.987654321
  const buf = new Float64Array(1)
  const u32 = new Uint32Array(buf.buffer)
  let h = 2166136261 >>> 0
  for (let i = 0; i < 10000; i++) {
    const a = Math.atan2(y, x)
    x = Math.sin(a + i * 0.0013) * Math.exp(-0.0001 * (i % 100))
    y = Math.cos(a - i * 0.0017) + x * 0.05
    buf[0] = x + y
    h ^= u32[0]!
    h = Math.imul(h, 16777619) >>> 0
    h ^= u32[1]!
    h = Math.imul(h, 16777619) >>> 0
  }
  return {
    digestHex: `0x${(h >>> 0).toString(16).padStart(8, "0")}`,
    finalVal: x + y,
    sampleSin: Math.sin(1.2345678901234567),
    sampleAtan2: Math.atan2(0.3333333333333333, 0.7777777777777778),
  }
}

const jscFloat = computeFloatTranscendentalDigest()

const browser = await chromium.launch({
  headless: true,
  args: ["--mute-audio", "--disable-gpu"],
})
const page = await browser.newPage()

const v8Results = await page.evaluate(async (b64: string) => {
  const binStr = atob(b64)
  const wasmBytes = new Uint8Array(binStr.length)
  for (let i = 0; i < binStr.length; i++) wasmBytes[i] = binStr.charCodeAt(i)

  // Batch 20 compiles to overcome Chrome's 100us timer quantization
  const coldT0 = performance.now()
  for (let i = 0; i < 20; i++) {
    const mod = new WebAssembly.Module(wasmBytes)
    const inst = new WebAssembly.Instance(mod, {})
    void inst.exports
  }
  const coldCompileMeanMs = Number(((performance.now() - coldT0) / 20).toFixed(3))

  const mod = new WebAssembly.Module(wasmBytes)
  const inst = new WebAssembly.Instance(mod, {})
  const wasm = inst.exports as any

  const median = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y)
    return s[Math.floor(s.length / 2)]!
  }
  const p95 = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y)
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!
  }
  // Use batch=250 so each sample takes ~1-5ms (well above Chrome's 100us timer resolution)
  const measure = (fn: () => void, runs = 40, batch = 250, warmup = 10) => {
    for (let i = 0; i < warmup * batch; i++) fn()
    const times: number[] = []
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      for (let b = 0; b < batch; b++) fn()
      times.push((performance.now() - t0) / batch)
    }
    return {
      medianUs: Number((median(times) * 1000).toFixed(2)),
      p95Us: Number((p95(times) * 1000).toFixed(2)),
    }
  }

  const N = 300
  const RAW_ZOMBIE_BYTES = 44
  const zPtr = wasm.zombies_ptr()
  const decPtr = wasm.decoded_zombies_ptr()

  const jsZombies = Array.from({ length: N }, (_, i) => ({
    id: i + 1,
    state: i % 2 === 0 ? 3 : 0,
    hp: 100,
    seed: 7,
    x: 6 + ((i * 17) % 84),
    y: 6 + ((i * 29) % 84),
    vx: i % 2 === 0 ? 1.8 : 0,
    vy: i % 2 === 0 ? 1.2 : 0,
    aim: (i * 0.25) % 6.28,
    hitFlash: 0,
    stateTime: 1.2,
    timer: 0.3,
    clamber: 0,
  }))

  const marshalToWasm = () => {
    const dv = new DataView(wasm.memory.buffer, zPtr, N * RAW_ZOMBIE_BYTES)
    let off = 0
    for (let i = 0; i < N; i++) {
      const a = jsZombies[i]!
      dv.setUint16(off, a.id, true)
      dv.setUint8(off + 2, a.state)
      dv.setUint8(off + 3, a.hp)
      dv.setUint32(off + 4, a.seed, true)
      dv.setFloat32(off + 8, a.x, true)
      dv.setFloat32(off + 12, a.y, true)
      dv.setFloat32(off + 16, a.vx, true)
      dv.setFloat32(off + 20, a.vy, true)
      dv.setFloat32(off + 24, a.aim, true)
      dv.setFloat32(off + 28, a.hitFlash, true)
      dv.setFloat32(off + 32, a.stateTime, true)
      dv.setFloat32(off + 36, a.timer, true)
      dv.setFloat32(off + 40, a.clamber, true)
      off += RAW_ZOMBIE_BYTES
    }
  }

  const unmarshalFromWasm = (count: number) => {
    const dv = new DataView(wasm.memory.buffer, decPtr, count * RAW_ZOMBIE_BYTES)
    let off = 0
    for (let i = 0; i < count; i++) {
      const dst = jsZombies[i]!
      dst.id = dv.getUint16(off, true)
      dst.state = dv.getUint8(off + 2)
      dst.hp = dv.getUint8(off + 3)
      dst.x = dv.getFloat32(off + 8, true)
      dst.y = dv.getFloat32(off + 12, true)
      dst.aim = dv.getFloat32(off + 24, true)
      off += RAW_ZOMBIE_BYTES
    }
  }

  marshalToWasm()
  wasm.rust_record_history(N, 97)
  for (let i = 0; i < N; i++) {
    if (i % 2 === 0) {
      jsZombies[i]!.x += 0.09
      jsZombies[i]!.y += 0.06
    }
  }
  marshalToWasm()
  wasm.rust_record_history(N, 100)

  // TS DataView full encode/decode in V8
  const tsBuf = new Uint8Array(8192)
  const tsDv = new DataView(tsBuf.buffer)
  const v8TsFullEncode = measure(() => {
    tsDv.setUint32(0, 100, true)
    tsDv.setUint16(4, N, true)
    let off = 6
    for (let i = 0; i < N; i++) {
      const z = jsZombies[i]!
      tsDv.setUint16(off, z.id, true)
      tsBuf[off + 2] = z.state
      tsDv.setInt32(off + 3, (z.x * 100) | 0, true)
      tsDv.setInt32(off + 7, (z.y * 100) | 0, true)
      tsDv.setUint16(off + 11, ((z.aim * 10430.378) | 0) & 0xffff, true)
      tsBuf[off + 13] = z.hp
      tsBuf[off + 14] = 0
      off += 15
    }
  })
  const v8TsFullDecode = measure(() => {
    const count = tsDv.getUint16(4, true)
    let off = 6
    for (let i = 0; i < count; i++) {
      const dst = jsZombies[i]!
      dst.id = tsDv.getUint16(off, true)
      dst.state = tsBuf[off + 2]!
      dst.x = tsDv.getInt32(off + 3, true) * 0.01
      dst.y = tsDv.getInt32(off + 7, true) * 0.01
      dst.aim = tsDv.getUint16(off + 11, true) * (6.2831853 / 65536)
      dst.hp = tsBuf[off + 13]!
      off += 15
    }
  })

  // Rust Bincode in V8
  const v8RustBincodeZeroCopyEncode = measure(() => {
    wasm.rust_encode_bincode(N, 100, 7)
  })
  const v8RustBincodeMarshalEncode = measure(() => {
    marshalToWasm()
    wasm.rust_encode_bincode(N, 100, 7)
  })
  const v8RustBincodeZeroCopyDecode = measure(() => {
    wasm.rust_decode_bincode(7)
  })
  const v8RustBincodeMarshalDecode = measure(() => {
    const c = wasm.rust_decode_bincode(7)
    unmarshalFromWasm(c)
  })

  // Rust Postcard in V8
  const v8RustPostcardZeroCopyEncode = measure(() => {
    wasm.rust_encode_postcard(N, 100)
  })
  const v8RustPostcardMarshalEncode = measure(() => {
    marshalToWasm()
    wasm.rust_encode_postcard(N, 100)
  })

  // Rust Delta Bitpack in V8
  const v8RustDeltaZeroCopyEncode = measure(() => {
    wasm.rust_record_history(N, 100)
    wasm.rust_encode_delta_bitpack(N, 100, 97, 27.7, 41.0, 60.0)
  })
  const v8RustDeltaMarshalEncode = measure(() => {
    marshalToWasm()
    wasm.rust_record_history(N, 100)
    wasm.rust_encode_delta_bitpack(N, 100, 97, 27.7, 41.0, 60.0)
  })
  const v8RustDeltaZeroCopyDecode = measure(() => {
    wasm.rust_decode_delta_bitpack(97)
  })
  const v8RustDeltaMarshalDecode = measure(() => {
    const c = wasm.rust_decode_delta_bitpack(97)
    unmarshalFromWasm(c)
  })

  // Full Rust-WASM Room Tick in V8
  let rTick = 100
  const v8RustRoomTick = measure(() => {
    rTick++
    wasm.rust_step_world_and_encode_room(N, rTick, 1 / 60)
  }, 40, 100, 10)

  // V8 Transcendental float check
  let fx = 0.123456789
  let fy = 0.987654321
  const fbuf = new Float64Array(1)
  const fu32 = new Uint32Array(fbuf.buffer)
  let fh = 2166136261 >>> 0
  for (let i = 0; i < 10000; i++) {
    const a = Math.atan2(fy, fx)
    fx = Math.sin(a + i * 0.0013) * Math.exp(-0.0001 * (i % 100))
    fy = Math.cos(a - i * 0.0017) + fx * 0.05
    fbuf[0] = fx + fy
    fh ^= fu32[0]!
    fh = Math.imul(fh, 16777619) >>> 0
    fh ^= fu32[1]!
    fh = Math.imul(fh, 16777619) >>> 0
  }

  wasm.rust_init_fixed_point(N)
  const v8FpHash = wasm.rust_step_fixed_point(N, 1000) >>> 0

  return {
    userAgent: navigator.userAgent,
    wasmColdStartCompileInstantiateMeanMs: coldCompileMeanMs,
    v8TsFullEncode,
    v8TsFullDecode,
    v8RustBincodeZeroCopyEncode,
    v8RustBincodeMarshalEncode,
    v8RustBincodeZeroCopyDecode,
    v8RustBincodeMarshalDecode,
    v8RustPostcardZeroCopyEncode,
    v8RustPostcardMarshalEncode,
    v8RustDeltaZeroCopyEncode,
    v8RustDeltaMarshalEncode,
    v8RustDeltaZeroCopyDecode,
    v8RustDeltaMarshalDecode,
    v8RustRoomTick,
    v8TranscendentalFloat: {
      digestHex: `0x${(fh >>> 0).toString(16).padStart(8, "0")}`,
      finalVal: fx + fy,
      sampleSin: Math.sin(1.2345678901234567),
      sampleAtan2: Math.atan2(0.3333333333333333, 0.7777777777777778),
    },
    v8FixedPointQ16_16DigestHex: `0x${v8FpHash.toString(16).padStart(8, "0")}`,
  }
}, wasmBase64)

await browser.close()

const combined = {
  jscTranscendentalFloat: jscFloat,
  v8Chromium: v8Results,
  floatTranscendentalMatchBetweenJscAndV8: jscFloat.digestHex === v8Results.v8TranscendentalFloat.digestHex,
}

writeFileSync(join(import.meta.dir, "results-v8-browser.json"), JSON.stringify(combined, null, 2) + "\n")
console.log(JSON.stringify(combined, null, 2))
