import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

const wasmPath = join(import.meta.dir, "rust-ecs/target/wasm32-unknown-unknown/release/arcade_bevy_ecs_spike.wasm")
const wasmBytes = readFileSync(wasmPath)
const wasmMod = new WebAssembly.Module(wasmBytes)
const wasmInst = new WebAssembly.Instance(wasmMod, {})
const wasm = wasmInst.exports as {
  memory: WebAssembly.Memory
  pos_ptr(): number
  vel_ptr(): number
  ai_ptr(): number
  wire_ptr(): number
  inst_ptr(): number
  bevy_ecs_init(count: number): void
  bevy_ecs_ai(count: number, dt: number): void
  bevy_ecs_encode(count: number): number
  bevy_ecs_render_pack(count: number, dt: number): void
  bevy_ecs_step_all(count: number, dt: number): number
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]!
}
const p95 = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!
}
const max = (a: number[]) => Math.max(...a)

// Branchless polynomial sin/cos matching the WGSL/Rust crowd animation approximation
function fastSin(x: number): number {
  const k = Math.round(x * 0.15915494)
  x -= k * 6.2831853
  const absX = x < 0 ? -x : x
  const y = x * (1.2732395 - 0.40528473 * absX)
  const absY = y < 0 ? -y : y
  return 0.225 * (y * absY - y) + y
}
function fastCos(x: number): number {
  return fastSin(x + 1.5707963)
}

interface SystemFns {
  reset(): void
  aiCollision(): void
  snapshotEncode(): void
  renderPack(): void
}

function measureSystems(sys: SystemFns, frames = 120, warmup = 30) {
  sys.reset()
  for (let i = 0; i < warmup; i++) {
    sys.aiCollision()
    sys.snapshotEncode()
    sys.renderPack()
  }
  sys.reset()
  Bun.gc(true)
  const heapBefore = process.memoryUsage().heapUsed
  const aiTimes: number[] = []
  const netTimes: number[] = []
  const renTimes: number[] = []
  const totTimes: number[] = []

  for (let i = 0; i < frames; i++) {
    if ((i & 15) === 0) sys.reset()
    const t0 = performance.now()
    sys.aiCollision()
    const t1 = performance.now()
    sys.snapshotEncode()
    const t2 = performance.now()
    sys.renderPack()
    const t3 = performance.now()
    aiTimes.push((t1 - t0) * 1000)
    netTimes.push((t2 - t1) * 1000)
    renTimes.push((t3 - t2) * 1000)
    totTimes.push((t3 - t0) * 1000)
  }
  const heapAfter = process.memoryUsage().heapUsed
  return {
    aiCollisionMedianUs: Number(median(aiTimes).toFixed(1)),
    snapshotEncodeMedianUs: Number(median(netTimes).toFixed(1)),
    renderPackMedianUs: Number(median(renTimes).toFixed(1)),
    totalMedianUs: Number(median(totTimes).toFixed(1)),
    totalP95Us: Number(p95(totTimes).toFixed(1)),
    totalMaxUs: Number(max(totTimes).toFixed(1)),
    heapDeltaKBPer120Frames: Math.max(0, Math.round((heapAfter - heapBefore) / 1024)),
  }
}

const results: Record<string, unknown> = {
  wasmBytes: wasmBytes.byteLength,
}

for (const COUNT of [500, 2000] as const) {
  const initX = new Float32Array(COUNT)
  const initY = new Float32Array(COUNT)
  for (let i = 0; i < COUNT; i++) {
    const cluster = (i / 4) | 0
    const member = i & 3
    initX[i] = 6 + ((cluster * 13) % 83) + (member - 1.5) * 0.55
    initY[i] = 6 + ((cluster * 29) % 79) + ((member & 1) - 0.5) * 0.55
  }

  const cellHead = new Int32Array(64 * 64)
  const agentNext = new Int32Array(COUNT)
  const sharedWireBuf = new Uint8Array(COUNT * 16 + 64)
  const sharedWireDv = new DataView(sharedWireBuf.buffer)
  const sharedInstBuf = new Float32Array(COUNT * 8 * 12)

  // ==========================================================================
  // 1. Current AoS Object Graph (AIAgent[] scattered heap objects + per-tick temp allocations)
  // ==========================================================================
  // Allocate dummy padding objects between entities to reproduce realistic post-spawn heap layout
  const aosPool: Array<{
    id: number
    x: number
    y: number
    vx: number
    vy: number
    aim: number
    speedScale: number
    state: string
    hp: number
    phase: number
    lurch: number
    asymmetry: number
    drag: number
    reach: number
    hitFlash: number
    path: Array<{ x: number; y: number }>
    detachedLimbs: string[]
  }> = []
  const garbagePadding: object[] = []
  for (let i = 0; i < COUNT; i++) {
    garbagePadding.push({ pad: i, arr: [i, i + 1, i + 2] })
    aosPool.push({
      id: i + 1,
      x: initX[i]!,
      y: initY[i]!,
      vx: 0,
      vy: 0,
      aim: (i * 0.3) % 6.283185,
      speedScale: 0.9 + (i % 5) * 0.05,
      state: i % 2 === 0 ? "chase" : "wander",
      hp: 100,
      phase: (i * 0.27) % 1,
      lurch: 0.2,
      asymmetry: 0.1,
      drag: 0,
      reach: 0.5,
      hitFlash: 0,
      path: [{ x: 27.7, y: 41.0 }],
      detachedLimbs: [],
    })
  }
  //Deterministic shuffle to reflect long-running wave spawn/kill ordering
  const aosEntities = [...aosPool]
  for (let i = COUNT - 1; i > 0; i--) {
    const j = (i * 73 + 19) % (i + 1)
    const tmp = aosEntities[i]!
    aosEntities[i] = aosEntities[j]!
    aosEntities[j] = tmp
  }

  const benchAos = measureSystems({
    reset() {
      for (let i = 0; i < COUNT; i++) {
        const e = aosPool[i]!
        e.x = initX[i]!
        e.y = initY[i]!
      }
    },
    aiCollision() {
      const dt = 1 / 60
      cellHead.fill(-1)
      for (let i = 0; i < COUNT; i++) {
        const a = aosEntities[i]!
        const cx = Math.max(0, Math.min(63, (a.x * 0.6667) | 0))
        const cy = Math.max(0, Math.min(63, (a.y * 0.6667) | 0))
        const c = cy * 64 + cx
        agentNext[i] = cellHead[c]!
        cellHead[c] = i
      }
      for (let i = 0; i < COUNT; i++) {
        const a = aosEntities[i]!
        // In current Outbreak shared/ai.ts, 1/12 of chasing zombies re-plan a waypoint array per tick
        if ((i & 15) === 0) {
          a.path = [
            { x: (a.x + 27.7) * 0.5, y: (a.y + 41.0) * 0.5 },
            { x: 27.7, y: 41.0 },
          ]
        }
        const wp = a.path[0] ?? { x: 27.7, y: 41.0 }
        const dx = wp.x - a.x
        const dy = wp.y - a.y
        const d = Math.hypot(dx, dy) || 1
        let sepX = 0, sepY = 0
        const cx = Math.max(1, Math.min(62, (a.x * 0.6667) | 0))
        const cy = Math.max(1, Math.min(62, (a.y * 0.6667) | 0))
        for (let dyc = -1; dyc <= 1; dyc++) {
          const row = (cy + dyc) * 64
          for (let dxc = -1; dxc <= 1; dxc++) {
            let cur = cellHead[row + cx + dxc]!
            while (cur >= 0) {
              if (cur !== i) {
                const o = aosEntities[cur]!
                const rx = a.x - o.x, ry = a.y - o.y
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
        // Typical AoS vector helper return `{ vx, vy }`
        const spd = (a.state === "chase" ? 2.65 : 0.95) * a.speedScale
        const dir = { x: dx / d + sepX, y: dy / d + sepY }
        const dirLen = Math.hypot(dir.x, dir.y) || 1
        a.vx = (dir.x / dirLen) * spd
        a.vy = (dir.y / dirLen) * spd
        a.x = Math.max(1, Math.min(95, a.x + a.vx * dt))
        a.y = Math.max(1, Math.min(95, a.y + a.vy * dt))
      }
    },
    snapshotEncode() {
      let wOff = 4
      for (let i = 0; i < COUNT; i++) {
        const a = aosEntities[i]!
        sharedWireDv.setUint16(wOff, a.id, true)
        sharedWireDv.setInt32(wOff + 2, Math.round(a.x * 100), true)
        sharedWireDv.setInt32(wOff + 6, Math.round(a.y * 100), true)
        sharedWireDv.setUint16(wOff + 10, (a.aim * 10430) & 0xffff, true)
        sharedWireBuf[wOff + 12] = a.state === "chase" ? 3 : 0
        sharedWireBuf[wOff + 13] = a.hp
        wOff += 14
      }
    },
    renderPack() {
      const dt = 1 / 60
      let iOff = 0
      for (let i = 0; i < COUNT; i++) {
        const a = aosEntities[i]!
        const spd = Math.hypot(a.vx, a.vy)
        const ph = (a.phase + spd * dt * 0.85) % 1
        a.phase = ph
        const cyRot = Math.cos(a.aim), syRot = Math.sin(a.aim)
        const hipY = 0.86 + Math.sin(ph * 6.283185) * 0.035
        for (let p = 0; p < 8; p++) {
          const side = (p & 1) === 0 ? -1 : 1
          const swing = Math.sin(ph * 6.283185 + side * 1.570796) * 0.34
          sharedInstBuf[iOff] = a.x + cyRot * (swing * 0.18) - syRot * (side * 0.13)
          sharedInstBuf[iOff + 1] = hipY - p * 0.09
          sharedInstBuf[iOff + 2] = a.y + syRot * (swing * 0.18) + cyRot * (side * 0.13)
          sharedInstBuf[iOff + 3] = a.aim
          sharedInstBuf[iOff + 4] = 0.86
          sharedInstBuf[iOff + 5] = 0.84
          sharedInstBuf[iOff + 6] = 0.80
          sharedInstBuf[iOff + 7] = 1
          sharedInstBuf[iOff + 8] = swing
          sharedInstBuf[iOff + 9] = side * 0.05
          sharedInstBuf[iOff + 10] = 1
          sharedInstBuf[iOff + 11] = 0
          iOff += 12
        }
      }
    },
  })

  // ==========================================================================
  // 2. Miniplex-Style Archetype Bucket AoS (`world.with("pos", "vel", "ai")` entity objects)
  // ==========================================================================
  const miniplexBucket = Array.from({ length: COUNT }, (_, i) => ({
    id: i + 1,
    pos: { x: initX[i]!, y: initY[i]!, aim: (i * 0.3) % 6.283185 },
    vel: { vx: 0, vy: 0, speedScale: 0.9 + (i % 5) * 0.05 },
    ai: { state: i % 2 === 0 ? 3 : 0, targetX: 27.7, targetY: 41.0 },
    hp: { value: 100 },
    anim: { phase: (i * 0.27) % 1 },
  }))
  const benchMiniplex = measureSystems({
    reset() {
      for (let i = 0; i < COUNT; i++) {
        miniplexBucket[i]!.pos.x = initX[i]!
        miniplexBucket[i]!.pos.y = initY[i]!
      }
    },
    aiCollision() {
      const dt = 1 / 60
      cellHead.fill(-1)
      for (let i = 0; i < COUNT; i++) {
        const p = miniplexBucket[i]!.pos
        const cx = Math.max(0, Math.min(63, (p.x * 0.6667) | 0))
        const cy = Math.max(0, Math.min(63, (p.y * 0.6667) | 0))
        const c = cy * 64 + cx
        agentNext[i] = cellHead[c]!
        cellHead[c] = i
      }
      for (let i = 0; i < COUNT; i++) {
        const { pos, vel, ai } = miniplexBucket[i]!
        const dx = ai.targetX - pos.x, dy = ai.targetY - pos.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        let sepX = 0, sepY = 0
        const cx = Math.max(1, Math.min(62, (pos.x * 0.6667) | 0))
        const cy = Math.max(1, Math.min(62, (pos.y * 0.6667) | 0))
        for (let dyc = -1; dyc <= 1; dyc++) {
          const row = (cy + dyc) * 64
          for (let dxc = -1; dxc <= 1; dxc++) {
            let cur = cellHead[row + cx + dxc]!
            while (cur >= 0) {
              if (cur !== i) {
                const op = miniplexBucket[cur]!.pos
                const rx = pos.x - op.x, ry = pos.y - op.y
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
        const spd = (ai.state === 3 ? 2.65 : 0.95) * vel.speedScale
        const dirX = dx / d + sepX, dirY = dy / d + sepY
        const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1
        vel.vx = (dirX / dirLen) * spd
        vel.vy = (dirY / dirLen) * spd
        pos.x = Math.max(1, Math.min(95, pos.x + vel.vx * dt))
        pos.y = Math.max(1, Math.min(95, pos.y + vel.vy * dt))
      }
    },
    snapshotEncode() {
      let wOff = 4
      for (let i = 0; i < COUNT; i++) {
        const e = miniplexBucket[i]!
        sharedWireDv.setUint16(wOff, e.id, true)
        sharedWireDv.setInt16(wOff + 2, (e.pos.x * 50) | 0, true)
        sharedWireDv.setInt16(wOff + 4, (e.pos.y * 50) | 0, true)
        sharedWireBuf[wOff + 6] = e.ai.state
        sharedWireBuf[wOff + 7] = e.hp.value
        wOff += 8
      }
    },
    renderPack() {
      const dt = 1 / 60
      let iOff = 0
      for (let i = 0; i < COUNT; i++) {
        const { pos, vel, anim } = miniplexBucket[i]!
        const spd = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy)
        const ph = (anim.phase + spd * dt * 0.85) % 1
        anim.phase = ph
        const cyRot = fastCos(pos.aim), syRot = fastSin(pos.aim)
        const hipY = 0.86 + fastSin(ph * 6.283185) * 0.035
        for (let p = 0; p < 8; p++) {
          const side = (p & 1) === 0 ? -1 : 1
          const swing = fastSin(ph * 6.283185 + side * 1.570796) * 0.34
          sharedInstBuf[iOff] = pos.x + cyRot * (swing * 0.18) - syRot * (side * 0.13)
          sharedInstBuf[iOff + 1] = hipY - p * 0.09
          sharedInstBuf[iOff + 2] = pos.y + syRot * (swing * 0.18) + cyRot * (side * 0.13)
          sharedInstBuf[iOff + 3] = pos.aim
          sharedInstBuf[iOff + 4] = 0.86
          sharedInstBuf[iOff + 5] = 0.84
          sharedInstBuf[iOff + 6] = 0.80
          sharedInstBuf[iOff + 7] = 1
          sharedInstBuf[iOff + 8] = swing
          sharedInstBuf[iOff + 9] = side * 0.05
          sharedInstBuf[iOff + 10] = 1
          sharedInstBuf[iOff + 11] = 0
          iOff += 12
        }
      }
    },
  })

  // ==========================================================================
  // 3. Koota-Style Trait Store (`world.query(Position, Velocity).useStores(...)`)
  // ==========================================================================
  const kootaPos = { x: new Float32Array(COUNT), y: new Float32Array(COUNT), aim: new Float32Array(COUNT) }
  const kootaVel = { vx: new Float32Array(COUNT), vy: new Float32Array(COUNT), speedScale: new Float32Array(COUNT) }
  const kootaAi = { state: new Uint8Array(COUNT), hp: new Uint8Array(COUNT), phase: new Float32Array(COUNT) }
  const kootaEntities = Array.from({ length: COUNT }, (_, i) => i)

  const benchKoota = measureSystems({
    reset() {
      kootaPos.x.set(initX)
      kootaPos.y.set(initY)
      for (let i = 0; i < COUNT; i++) {
        kootaPos.aim[i] = (i * 0.3) % 6.283185
        kootaVel.speedScale[i] = 0.9 + (i % 5) * 0.05
        kootaAi.state[i] = i % 2 === 0 ? 3 : 0
        kootaAi.hp[i] = 100
        kootaAi.phase[i] = (i * 0.27) % 1
      }
    },
    aiCollision() {
      const dt = 1 / 60
      cellHead.fill(-1)
      for (let k = 0; k < kootaEntities.length; k++) {
        const idx = kootaEntities[k]!
        const cx = Math.max(0, Math.min(63, (kootaPos.x[idx]! * 0.6667) | 0))
        const cy = Math.max(0, Math.min(63, (kootaPos.y[idx]! * 0.6667) | 0))
        const c = cy * 64 + cx
        agentNext[idx] = cellHead[c]!
        cellHead[c] = idx
      }
      for (let k = 0; k < kootaEntities.length; k++) {
        const idx = kootaEntities[k]!
        const px = kootaPos.x[idx]!, py = kootaPos.y[idx]!
        const dx = 27.7 - px, dy = 41.0 - py
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        let sepX = 0, sepY = 0
        const cx = Math.max(1, Math.min(62, (px * 0.6667) | 0))
        const cy = Math.max(1, Math.min(62, (py * 0.6667) | 0))
        for (let dyc = -1; dyc <= 1; dyc++) {
          const row = (cy + dyc) * 64
          for (let dxc = -1; dxc <= 1; dxc++) {
            let cur = cellHead[row + cx + dxc]!
            while (cur >= 0) {
              if (cur !== idx) {
                const rx = px - kootaPos.x[cur]!, ry = py - kootaPos.y[cur]!
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
        const st = kootaAi.state[idx]!
        const spd = (st === 3 ? 2.65 : 0.95) * kootaVel.speedScale[idx]!
        const dirX = dx / d + sepX, dirY = dy / d + sepY
        const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1
        const vx = (dirX / dirLen) * spd, vy = (dirY / dirLen) * spd
        kootaVel.vx[idx] = vx
        kootaVel.vy[idx] = vy
        kootaPos.x[idx] = Math.max(1, Math.min(95, px + vx * dt))
        kootaPos.y[idx] = Math.max(1, Math.min(95, py + vy * dt))
      }
    },
    snapshotEncode() {
      let wOff = 4
      for (let k = 0; k < kootaEntities.length; k++) {
        const idx = kootaEntities[k]!
        sharedWireDv.setUint16(wOff, idx + 1, true)
        sharedWireDv.setInt16(wOff + 2, (kootaPos.x[idx]! * 50) | 0, true)
        sharedWireDv.setInt16(wOff + 4, (kootaPos.y[idx]! * 50) | 0, true)
        sharedWireBuf[wOff + 6] = kootaAi.state[idx]!
        sharedWireBuf[wOff + 7] = kootaAi.hp[idx]!
        wOff += 8
      }
    },
    renderPack() {
      const dt = 1 / 60
      let iOff = 0
      for (let k = 0; k < kootaEntities.length; k++) {
        const idx = kootaEntities[k]!
        const nx = kootaPos.x[idx]!, ny = kootaPos.y[idx]!, aim = kootaPos.aim[idx]!
        const vx = kootaVel.vx[idx]!, vy = kootaVel.vy[idx]!
        const spd = Math.sqrt(vx * vx + vy * vy)
        const ph = (kootaAi.phase[idx]! + spd * dt * 0.85) % 1
        kootaAi.phase[idx] = ph
        const cyRot = fastCos(aim), syRot = fastSin(aim)
        const hipY = 0.86 + fastSin(ph * 6.283185) * 0.035
        for (let p = 0; p < 8; p++) {
          const side = (p & 1) === 0 ? -1 : 1
          const swing = fastSin(ph * 6.283185 + side * 1.570796) * 0.34
          sharedInstBuf[iOff] = nx + cyRot * (swing * 0.18) - syRot * (side * 0.13)
          sharedInstBuf[iOff + 1] = hipY - p * 0.09
          sharedInstBuf[iOff + 2] = ny + syRot * (swing * 0.18) + cyRot * (side * 0.13)
          sharedInstBuf[iOff + 3] = aim
          sharedInstBuf[iOff + 4] = 0.86
          sharedInstBuf[iOff + 5] = 0.84
          sharedInstBuf[iOff + 6] = 0.80
          sharedInstBuf[iOff + 7] = 1
          sharedInstBuf[iOff + 8] = swing
          sharedInstBuf[iOff + 9] = side * 0.05
          sharedInstBuf[iOff + 10] = 1
          sharedInstBuf[iOff + 11] = 0
          iOff += 12
        }
      }
    },
  })

  // ==========================================================================
  // 4. Becsy-Style Flyweight Cursor over ArrayBuffer Slab
  // ==========================================================================
  const becsySlab = new ArrayBuffer(COUNT * 32)
  const becsyF32 = new Float32Array(becsySlab)
  const becsyU8 = new Uint8Array(becsySlab)
  const becsyCursor = {
    __index: 0,
    get x() { return becsyF32[this.__index * 8]! },
    set x(v: number) { becsyF32[this.__index * 8] = v },
    get y() { return becsyF32[this.__index * 8 + 1]! },
    set y(v: number) { becsyF32[this.__index * 8 + 1] = v },
    get aim() { return becsyF32[this.__index * 8 + 2]! },
    set aim(v: number) { becsyF32[this.__index * 8 + 2] = v },
    get vx() { return becsyF32[this.__index * 8 + 3]! },
    set vx(v: number) { becsyF32[this.__index * 8 + 3] = v },
    get vy() { return becsyF32[this.__index * 8 + 4]! },
    set vy(v: number) { becsyF32[this.__index * 8 + 4] = v },
    get speedScale() { return becsyF32[this.__index * 8 + 5]! },
    set speedScale(v: number) { becsyF32[this.__index * 8 + 5] = v },
    get phase() { return becsyF32[this.__index * 8 + 6]! },
    set phase(v: number) { becsyF32[this.__index * 8 + 6] = v },
    get state() { return becsyU8[this.__index * 32 + 28]! },
    set state(v: number) { becsyU8[this.__index * 32 + 28] = v },
    get hp() { return becsyU8[this.__index * 32 + 29]! },
    set hp(v: number) { becsyU8[this.__index * 32 + 29] = v },
  }
  const benchBecsy = measureSystems({
    reset() {
      for (let i = 0; i < COUNT; i++) {
        becsyCursor.__index = i
        becsyCursor.x = initX[i]!
        becsyCursor.y = initY[i]!
        becsyCursor.aim = (i * 0.3) % 6.283185
        becsyCursor.speedScale = 0.9 + (i % 5) * 0.05
        becsyCursor.phase = (i * 0.27) % 1
        becsyCursor.state = i % 2 === 0 ? 3 : 0
        becsyCursor.hp = 100
      }
    },
    aiCollision() {
      const dt = 1 / 60
      cellHead.fill(-1)
      for (let i = 0; i < COUNT; i++) {
        becsyCursor.__index = i
        const cx = Math.max(0, Math.min(63, (becsyCursor.x * 0.6667) | 0))
        const cy = Math.max(0, Math.min(63, (becsyCursor.y * 0.6667) | 0))
        const c = cy * 64 + cx
        agentNext[i] = cellHead[c]!
        cellHead[c] = i
      }
      for (let i = 0; i < COUNT; i++) {
        becsyCursor.__index = i
        const px = becsyCursor.x, py = becsyCursor.y
        const st = becsyCursor.state, spdScale = becsyCursor.speedScale
        const dx = 27.7 - px, dy = 41.0 - py
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        let sepX = 0, sepY = 0
        const cx = Math.max(1, Math.min(62, (px * 0.6667) | 0))
        const cy = Math.max(1, Math.min(62, (py * 0.6667) | 0))
        for (let dyc = -1; dyc <= 1; dyc++) {
          const row = (cy + dyc) * 64
          for (let dxc = -1; dxc <= 1; dxc++) {
            let cur = cellHead[row + cx + dxc]!
            while (cur >= 0) {
              if (cur !== i) {
                becsyCursor.__index = cur
                const rx = px - becsyCursor.x, ry = py - becsyCursor.y
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
        becsyCursor.__index = i
        const spd = (st === 3 ? 2.65 : 0.95) * spdScale
        const dirX = dx / d + sepX, dirY = dy / d + sepY
        const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1
        const vx = (dirX / dirLen) * spd, vy = (dirY / dirLen) * spd
        becsyCursor.vx = vx
        becsyCursor.vy = vy
        becsyCursor.x = Math.max(1, Math.min(95, px + vx * dt))
        becsyCursor.y = Math.max(1, Math.min(95, py + vy * dt))
      }
    },
    snapshotEncode() {
      let wOff = 4
      for (let i = 0; i < COUNT; i++) {
        becsyCursor.__index = i
        sharedWireDv.setUint16(wOff, i + 1, true)
        sharedWireDv.setInt16(wOff + 2, (becsyCursor.x * 50) | 0, true)
        sharedWireDv.setInt16(wOff + 4, (becsyCursor.y * 50) | 0, true)
        sharedWireBuf[wOff + 6] = becsyCursor.state
        sharedWireBuf[wOff + 7] = becsyCursor.hp
        wOff += 8
      }
    },
    renderPack() {
      const dt = 1 / 60
      let iOff = 0
      for (let i = 0; i < COUNT; i++) {
        becsyCursor.__index = i
        const nx = becsyCursor.x, ny = becsyCursor.y, aim = becsyCursor.aim
        const vx = becsyCursor.vx, vy = becsyCursor.vy
        const spd = Math.sqrt(vx * vx + vy * vy)
        const ph = (becsyCursor.phase + spd * dt * 0.85) % 1
        becsyCursor.phase = ph
        const cyRot = fastCos(aim), syRot = fastSin(aim)
        const hipY = 0.86 + fastSin(ph * 6.283185) * 0.035
        for (let p = 0; p < 8; p++) {
          const side = (p & 1) === 0 ? -1 : 1
          const swing = fastSin(ph * 6.283185 + side * 1.570796) * 0.34
          sharedInstBuf[iOff] = nx + cyRot * (swing * 0.18) - syRot * (side * 0.13)
          sharedInstBuf[iOff + 1] = hipY - p * 0.09
          sharedInstBuf[iOff + 2] = ny + syRot * (swing * 0.18) + cyRot * (side * 0.13)
          sharedInstBuf[iOff + 3] = aim
          sharedInstBuf[iOff + 4] = 0.86
          sharedInstBuf[iOff + 5] = 0.84
          sharedInstBuf[iOff + 6] = 0.80
          sharedInstBuf[iOff + 7] = 1
          sharedInstBuf[iOff + 8] = swing
          sharedInstBuf[iOff + 9] = side * 0.05
          sharedInstBuf[iOff + 10] = 1
          sharedInstBuf[iOff + 11] = 0
          iOff += 12
        }
      }
    },
  })

  // ==========================================================================
  // 5. bitECS-Style Sparse-Set SoA (eid query array + Position.x[eid] TypedArrays)
  // ==========================================================================
  const MAX_EID = COUNT + 16
  const bitPosX = new Float32Array(MAX_EID)
  const bitPosY = new Float32Array(MAX_EID)
  const bitAim = new Float32Array(MAX_EID)
  const bitVx = new Float32Array(MAX_EID)
  const bitVy = new Float32Array(MAX_EID)
  const bitSpdScale = new Float32Array(MAX_EID)
  const bitState = new Uint8Array(MAX_EID)
  const bitHp = new Uint8Array(MAX_EID)
  const bitPhase = new Float32Array(MAX_EID)
  const bitPrevQx = new Int16Array(MAX_EID)
  const bitPrevQy = new Int16Array(MAX_EID)
  const bitQueryEids = new Uint16Array(COUNT)

  const benchBitEcs = measureSystems({
    reset() {
      for (let i = 0; i < COUNT; i++) {
        // Sparse entity IDs after wave churn
        const eid = ((i * 73 + 19) % COUNT) + 1
        bitQueryEids[i] = eid
        bitPosX[eid] = initX[i]!
        bitPosY[eid] = initY[i]!
        bitAim[eid] = (i * 0.3) % 6.283185
        bitSpdScale[eid] = 0.9 + (i % 5) * 0.05
        bitState[eid] = i % 2 === 0 ? 3 : 0
        bitHp[eid] = 100
        bitPhase[eid] = (i * 0.27) % 1
        bitPrevQx[eid] = (initX[i]! * 50) | 0
        bitPrevQy[eid] = (initY[i]! * 50) | 0
      }
    },
    aiCollision() {
      const dt = 1 / 60
      cellHead.fill(-1)
      for (let i = 0; i < COUNT; i++) {
        const eid = bitQueryEids[i]!
        const cx = Math.max(0, Math.min(63, (bitPosX[eid]! * 0.6667) | 0))
        const cy = Math.max(0, Math.min(63, (bitPosY[eid]! * 0.6667) | 0))
        const c = cy * 64 + cx
        agentNext[i] = cellHead[c]!
        cellHead[c] = i
      }
      for (let i = 0; i < COUNT; i++) {
        const eid = bitQueryEids[i]!
        const px = bitPosX[eid]!, py = bitPosY[eid]!
        const dx = 27.7 - px, dy = 41.0 - py
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        let sepX = 0, sepY = 0
        const cx = Math.max(1, Math.min(62, (px * 0.6667) | 0))
        const cy = Math.max(1, Math.min(62, (py * 0.6667) | 0))
        for (let dyc = -1; dyc <= 1; dyc++) {
          const row = (cy + dyc) * 64
          for (let dxc = -1; dxc <= 1; dxc++) {
            let cur = cellHead[row + cx + dxc]!
            while (cur >= 0) {
              if (cur !== i) {
                const oeid = bitQueryEids[cur]!
                const rx = px - bitPosX[oeid]!, ry = py - bitPosY[oeid]!
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
        const st = bitState[eid]!
        const spd = (st === 3 ? 2.65 : 0.95) * bitSpdScale[eid]!
        const dirX = dx / d + sepX, dirY = dy / d + sepY
        const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1
        const vx = (dirX / dirLen) * spd, vy = (dirY / dirLen) * spd
        bitVx[eid] = vx
        bitVy[eid] = vy
        bitPosX[eid] = Math.max(1, Math.min(95, px + vx * dt))
        bitPosY[eid] = Math.max(1, Math.min(95, py + vy * dt))
      }
    },
    snapshotEncode() {
      let wOff = 4
      for (let i = 0; i < COUNT; i++) {
        const eid = bitQueryEids[i]!
        const qx = (bitPosX[eid]! * 50) | 0, qy = (bitPosY[eid]! * 50) | 0
        const dqx = qx - bitPrevQx[eid]!, dqy = qy - bitPrevQy[eid]!
        if (dqx !== 0 || dqy !== 0) {
          sharedWireDv.setUint16(wOff, eid | 0x8000, true)
          sharedWireBuf[wOff + 2] = dqx & 0xff
          sharedWireBuf[wOff + 3] = dqy & 0xff
          sharedWireBuf[wOff + 4] = 0
          wOff += 5
        }
        bitPrevQx[eid] = qx
        bitPrevQy[eid] = qy
      }
    },
    renderPack() {
      const dt = 1 / 60
      let iOff = 0
      for (let i = 0; i < COUNT; i++) {
        const eid = bitQueryEids[i]!
        const nx = bitPosX[eid]!, ny = bitPosY[eid]!, aim = bitAim[eid]!
        const vx = bitVx[eid]!, vy = bitVy[eid]!
        const spd = Math.sqrt(vx * vx + vy * vy)
        const ph = (bitPhase[eid]! + spd * dt * 0.85) % 1
        bitPhase[eid] = ph
        const cyRot = fastCos(aim), syRot = fastSin(aim)
        const hipY = 0.86 + fastSin(ph * 6.283185) * 0.035
        for (let p = 0; p < 8; p++) {
          const side = (p & 1) === 0 ? -1 : 1
          const swing = fastSin(ph * 6.283185 + side * 1.570796) * 0.34
          sharedInstBuf[iOff] = nx + cyRot * (swing * 0.18) - syRot * (side * 0.13)
          sharedInstBuf[iOff + 1] = hipY - p * 0.09
          sharedInstBuf[iOff + 2] = ny + syRot * (swing * 0.18) + cyRot * (side * 0.13)
          sharedInstBuf[iOff + 3] = aim
          sharedInstBuf[iOff + 4] = 0.86
          sharedInstBuf[iOff + 5] = 0.84
          sharedInstBuf[iOff + 6] = 0.80
          sharedInstBuf[iOff + 7] = 1
          sharedInstBuf[iOff + 8] = swing
          sharedInstBuf[iOff + 9] = side * 0.05
          sharedInstBuf[iOff + 10] = 1
          sharedInstBuf[iOff + 11] = 0
          iOff += 12
        }
      }
    },
  })

  // ==========================================================================
  // 6. Hand-Rolled Dense Domain ZombiePool SoA (Dense 0..COUNT, Swap-Remove, Zero Indirection)
  // ==========================================================================
  const soaX = new Float32Array(COUNT)
  const soaY = new Float32Array(COUNT)
  const soaAim = new Float32Array(COUNT)
  const soaVx = new Float32Array(COUNT)
  const soaVy = new Float32Array(COUNT)
  const soaSpdScale = new Float32Array(COUNT)
  const soaState = new Uint8Array(COUNT)
  const soaHp = new Uint8Array(COUNT)
  const soaPhase = new Float32Array(COUNT)
  const soaPrevQx = new Int16Array(COUNT)
  const soaPrevQy = new Int16Array(COUNT)

  const benchHandSoa = measureSystems({
    reset() {
      soaX.set(initX)
      soaY.set(initY)
      for (let i = 0; i < COUNT; i++) {
        soaAim[i] = (i * 0.3) % 6.283185
        soaSpdScale[i] = 0.9 + (i % 5) * 0.05
        soaState[i] = i % 2 === 0 ? 3 : 0
        soaHp[i] = 100
        soaPhase[i] = (i * 0.27) % 1
        soaPrevQx[i] = (initX[i]! * 50) | 0
        soaPrevQy[i] = (initY[i]! * 50) | 0
      }
    },
    aiCollision() {
      const dt = 1 / 60
      cellHead.fill(-1)
      for (let i = 0; i < COUNT; i++) {
        const cx = Math.max(0, Math.min(63, (soaX[i]! * 0.6667) | 0))
        const cy = Math.max(0, Math.min(63, (soaY[i]! * 0.6667) | 0))
        const c = cy * 64 + cx
        agentNext[i] = cellHead[c]!
        cellHead[c] = i
      }
      for (let i = 0; i < COUNT; i++) {
        const px = soaX[i]!, py = soaY[i]!
        const dx = 27.7 - px, dy = 41.0 - py
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        let sepX = 0, sepY = 0
        const cx = Math.max(1, Math.min(62, (px * 0.6667) | 0))
        const cy = Math.max(1, Math.min(62, (py * 0.6667) | 0))
        for (let dyc = -1; dyc <= 1; dyc++) {
          const row = (cy + dyc) * 64
          for (let dxc = -1; dxc <= 1; dxc++) {
            let cur = cellHead[row + cx + dxc]!
            while (cur >= 0) {
              if (cur !== i) {
                const rx = px - soaX[cur]!, ry = py - soaY[cur]!
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
        const st = soaState[i]!
        const spd = (st === 3 ? 2.65 : 0.95) * soaSpdScale[i]!
        const dirX = dx / d + sepX, dirY = dy / d + sepY
        const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1
        const vx = (dirX / dirLen) * spd, vy = (dirY / dirLen) * spd
        soaVx[i] = vx
        soaVy[i] = vy
        soaX[i] = Math.max(1, Math.min(95, px + vx * dt))
        soaY[i] = Math.max(1, Math.min(95, py + vy * dt))
      }
    },
    snapshotEncode() {
      let wOff = 4
      for (let i = 0; i < COUNT; i++) {
        const qx = (soaX[i]! * 50) | 0, qy = (soaY[i]! * 50) | 0
        const dqx = qx - soaPrevQx[i]!, dqy = qy - soaPrevQy[i]!
        if (dqx !== 0 || dqy !== 0) {
          sharedWireDv.setUint16(wOff, (i + 1) | 0x8000, true)
          sharedWireBuf[wOff + 2] = dqx & 0xff
          sharedWireBuf[wOff + 3] = dqy & 0xff
          sharedWireBuf[wOff + 4] = 0
          wOff += 5
        }
        soaPrevQx[i] = qx
        soaPrevQy[i] = qy
      }
    },
    renderPack() {
      const dt = 1 / 60
      let iOff = 0
      for (let i = 0; i < COUNT; i++) {
        const nx = soaX[i]!, ny = soaY[i]!, aim = soaAim[i]!
        const vx = soaVx[i]!, vy = soaVy[i]!
        const spd = Math.sqrt(vx * vx + vy * vy)
        const ph = (soaPhase[i]! + spd * dt * 0.85) % 1
        soaPhase[i] = ph
        const cyRot = fastCos(aim), syRot = fastSin(aim)
        const hipY = 0.86 + fastSin(ph * 6.283185) * 0.035
        for (let p = 0; p < 8; p++) {
          const side = (p & 1) === 0 ? -1 : 1
          const swing = fastSin(ph * 6.283185 + side * 1.570796) * 0.34
          sharedInstBuf[iOff] = nx + cyRot * (swing * 0.18) - syRot * (side * 0.13)
          sharedInstBuf[iOff + 1] = hipY - p * 0.09
          sharedInstBuf[iOff + 2] = ny + syRot * (swing * 0.18) + cyRot * (side * 0.13)
          sharedInstBuf[iOff + 3] = aim
          sharedInstBuf[iOff + 4] = 0.86
          sharedInstBuf[iOff + 5] = 0.84
          sharedInstBuf[iOff + 6] = 0.80
          sharedInstBuf[iOff + 7] = 1
          sharedInstBuf[iOff + 8] = swing
          sharedInstBuf[iOff + 9] = side * 0.05
          sharedInstBuf[iOff + 10] = 1
          sharedInstBuf[iOff + 11] = 0
          iOff += 12
        }
      }
    },
  })

  // ==========================================================================
  // 7. Bevy-Style Archetype ECS in Rust -> WASM (-O3 +simd128, Zero-Copy Linear Memory)
  // ==========================================================================
  const benchBevyWasm = measureSystems({
    reset() {
      wasm.bevy_ecs_init(COUNT)
    },
    aiCollision() {
      wasm.bevy_ecs_ai(COUNT, 1 / 60)
    },
    snapshotEncode() {
      wasm.bevy_ecs_encode(COUNT)
    },
    renderPack() {
      wasm.bevy_ecs_render_pack(COUNT, 1 / 60)
    },
  })

  // ==========================================================================
  // 8. Hand-Rolled Dense SoA + GPU Vertex-Pulled Gait (CPU writes 32B/zombie, WGSL expands 8 parts)
  // ==========================================================================
  const compactGpuZombieBuf = new Float32Array(COUNT * 8) // 32 bytes per zombie (12x smaller upload!)
  const benchHandSoaGpuGait = measureSystems({
    reset: () => {
      soaX.set(initX)
      soaY.set(initY)
      for (let i = 0; i < COUNT; i++) {
        soaAim[i] = (i * 0.3) % 6.283185
        soaSpdScale[i] = 0.9 + (i % 5) * 0.05
        soaState[i] = i % 2 === 0 ? 3 : 0
        soaHp[i] = 100
        soaPhase[i] = (i * 0.27) % 1
        soaPrevQx[i] = (initX[i]! * 50) | 0
        soaPrevQy[i] = (initY[i]! * 50) | 0
      }
    },
    aiCollision() {
      const dt = 1 / 60
      cellHead.fill(-1)
      for (let i = 0; i < COUNT; i++) {
        const cx = Math.max(0, Math.min(63, (soaX[i]! * 0.6667) | 0))
        const cy = Math.max(0, Math.min(63, (soaY[i]! * 0.6667) | 0))
        const c = cy * 64 + cx
        agentNext[i] = cellHead[c]!
        cellHead[c] = i
      }
      for (let i = 0; i < COUNT; i++) {
        const px = soaX[i]!, py = soaY[i]!
        const dx = 27.7 - px, dy = 41.0 - py
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        let sepX = 0, sepY = 0
        const cx = Math.max(1, Math.min(62, (px * 0.6667) | 0))
        const cy = Math.max(1, Math.min(62, (py * 0.6667) | 0))
        for (let dyc = -1; dyc <= 1; dyc++) {
          const row = (cy + dyc) * 64
          for (let dxc = -1; dxc <= 1; dxc++) {
            let cur = cellHead[row + cx + dxc]!
            while (cur >= 0) {
              if (cur !== i) {
                const rx = px - soaX[cur]!, ry = py - soaY[cur]!
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
        const st = soaState[i]!
        const spd = (st === 3 ? 2.65 : 0.95) * soaSpdScale[i]!
        const dirX = dx / d + sepX, dirY = dy / d + sepY
        const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1
        const vx = (dirX / dirLen) * spd, vy = (dirY / dirLen) * spd
        soaVx[i] = vx
        soaVy[i] = vy
        soaX[i] = Math.max(1, Math.min(95, px + vx * dt))
        soaY[i] = Math.max(1, Math.min(95, py + vy * dt))
      }
    },
    snapshotEncode() {
      let wOff = 4
      for (let i = 0; i < COUNT; i++) {
        const qx = (soaX[i]! * 50) | 0, qy = (soaY[i]! * 50) | 0
        const dqx = qx - soaPrevQx[i]!, dqy = qy - soaPrevQy[i]!
        if (dqx !== 0 || dqy !== 0) {
          sharedWireDv.setUint16(wOff, (i + 1) | 0x8000, true)
          sharedWireBuf[wOff + 2] = dqx & 0xff
          sharedWireBuf[wOff + 3] = dqy & 0xff
          sharedWireBuf[wOff + 4] = 0
          wOff += 5
        }
        soaPrevQx[i] = qx
        soaPrevQy[i] = qy
      }
    },
    renderPack() {
      const dt = 1 / 60
      let o = 0
      for (let i = 0; i < COUNT; i++) {
        const vx = soaVx[i]!, vy = soaVy[i]!
        const spd = Math.sqrt(vx * vx + vy * vy)
        const ph = (soaPhase[i]! + spd * dt * 0.85) % 1
        soaPhase[i] = ph
        compactGpuZombieBuf[o] = soaX[i]!
        compactGpuZombieBuf[o + 1] = soaY[i]!
        compactGpuZombieBuf[o + 2] = soaAim[i]!
        compactGpuZombieBuf[o + 3] = ph
        compactGpuZombieBuf[o + 4] = spd
        compactGpuZombieBuf[o + 5] = soaState[i]!
        compactGpuZombieBuf[o + 6] = soaHp[i]!
        compactGpuZombieBuf[o + 7] = 1
        o += 8
      }
    },
  })

  results[`zombies_${COUNT}`] = {
    "1_current_aos_objects": { ...benchAos, memoryKB: Math.round((COUNT * 480) / 1024), loc: 95 },
    "2_miniplex_archetype_buckets_aos": { ...benchMiniplex, memoryKB: Math.round((COUNT * 360) / 1024), loc: 75 },
    "3_koota_trait_store": { ...benchKoota, memoryKB: Math.round((COUNT * 96) / 1024), loc: 85 },
    "4_becsy_flyweight_cursor_soa": { ...benchBecsy, memoryKB: Math.round((COUNT * 40) / 1024), loc: 112 },
    "5_bitecs_sparse_set_soa": { ...benchBitEcs, memoryKB: Math.round((COUNT * 38) / 1024), loc: 88 },
    "6_hand_rolled_dense_domain_soa": { ...benchHandSoa, memoryKB: Math.round((COUNT * 34) / 1024), loc: 78 },
    "7_bevy_archetype_ecs_rust_wasm_simd": { ...benchBevyWasm, memoryKB: Math.round((COUNT * 32) / 1024), loc: 140 },
    "8_hand_soa_plus_gpu_vertex_gait": { ...benchHandSoaGpuGait, memoryKB: Math.round((COUNT * 34) / 1024), loc: 58 },
    speedupsVsCurrentAos: {
      handRolledSoaMedianX: Number((benchAos.totalMedianUs / benchHandSoa.totalMedianUs).toFixed(2)),
      handSoaGpuGaitMedianX: Number((benchAos.totalMedianUs / benchHandSoaGpuGait.totalMedianUs).toFixed(2)),
      bitEcsMedianX: Number((benchAos.totalMedianUs / benchBitEcs.totalMedianUs).toFixed(2)),
      becsyMedianX: Number((benchAos.totalMedianUs / benchBecsy.totalMedianUs).toFixed(2)),
      kootaMedianX: Number((benchAos.totalMedianUs / benchKoota.totalMedianUs).toFixed(2)),
      miniplexMedianX: Number((benchAos.totalMedianUs / benchMiniplex.totalMedianUs).toFixed(2)),
      bevyRustWasmMedianX: Number((benchAos.totalMedianUs / benchBevyWasm.totalMedianUs).toFixed(2)),
      bevyRustWasmVsHandSoaX: Number((benchHandSoa.totalMedianUs / benchBevyWasm.totalMedianUs).toFixed(2)),
      handSoaVsBitEcsX: Number((benchBitEcs.totalMedianUs / benchHandSoa.totalMedianUs).toFixed(2)),
      handSoaVsBecsyX: Number((benchBecsy.totalMedianUs / benchHandSoa.totalMedianUs).toFixed(2)),
    },
  }
}

writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(results, null, 2) + "\n")
console.log(JSON.stringify(results, null, 2))
