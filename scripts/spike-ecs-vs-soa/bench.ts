import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { plugin } from "bun"

plugin({
  name: "mock-build-gen",
  setup(build) {
    build.onResolve({ filter: /build\.gen$/ }, (args) => ({ path: args.path, namespace: "build-gen" }))
    build.onLoad({ filter: /.*/, namespace: "build-gen" }, () => ({
      contents: `export const BUILD = "ecs000"\n`,
      loader: "ts",
    }))
  },
})

const { ByteWriter, packAngle } = await import("../../packages/kit/net/bytes")
const { createAIAgent, GridNav } = await import("../../packages/kit/sim/ai")
const { FlowFieldNav } = await import("../../packages/kit/sim/flow-field")
const { makeTown, solidRects } = await import("../../games/outbreak/shared/map")

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]!
}
const p95 = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!
}

function measure(fn: () => void, runs = 60, batch = 10, warmup = 15) {
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
    medianMs: Number(median(times).toFixed(4)),
  }
}

const town = makeTown(7, 7, 0.22)
const solids = solidRects(town)
const portals = town.doors.map((d) => ({ id: d.id, kind: "door" as const, rect: d.rect, open: d.open }))
const gridNav = new GridNav(96, 0.5)
gridNav.rebuild(solids, portals, 0.28)
const flow = new FlowFieldNav(96, 96, 0.5, 6)
flow.rebuildTopology(solids, portals, 0.28)
const costField = flow.ensureField(27.7, 41.0, true)

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

const report: Record<string, unknown> = {}

for (const COUNT of [500, 1000] as const) {
  // Deterministic initial positions distributed across the 96x96m town (with loose 3-5 zombie street clusters)
  const initX = new Float32Array(COUNT)
  const initY = new Float32Array(COUNT)
  for (let i = 0; i < COUNT; i++) {
    const cluster = (i / 4) | 0
    const member = i & 3
    initX[i] = 6 + ((cluster * 13) % 82) + (member - 1.5) * 0.55
    initY[i] = 6 + ((cluster * 29) % 82) + ((member & 1) - 0.5) * 0.55
  }

  // ==========================================================================
  // 1. CURRENT AoS OBJECT GRAPH (41-field AIAgent[] + Vec[] path + ByteWriter)
  // ==========================================================================
  const aosAgents = Array.from({ length: COUNT }, (_, i) => {
    const a = createAIAgent(i + 1, 7, initX[i]!, initY[i]!, (i * 0.3) % 6.28)
    a.state = i % 2 === 0 ? "chase" : "wander"
    a.targetX = 27.7
    a.targetY = 41.0
    a.path = [{ x: 27.7, y: 41.0 }, { x: 28.5, y: 41.5 }]
    return a
  })
  const aosCellHead = new Int32Array(64 * 64)
  const aosNext = new Int32Array(COUNT)
  const aosWriter = new ByteWriter(32768)

  // 1a. AoS kinematics + spatial-hash separation (with periodic position reset so crowd density stays identical)
  let aosTick = 0
  const aosKinematicsStep = measure(() => {
    if ((++aosTick & 15) === 0) {
      for (let i = 0; i < COUNT; i++) {
        aosAgents[i]!.x = initX[i]!
        aosAgents[i]!.y = initY[i]!
      }
    }
    const dt = 1 / 60
    aosCellHead.fill(-1)
    for (let i = 0; i < COUNT; i++) {
      const a = aosAgents[i]!
      if (a.state === "dead") continue
      const cx = Math.max(0, Math.min(63, (a.x * 0.6667) | 0))
      const cy = Math.max(0, Math.min(63, (a.y * 0.6667) | 0))
      const c = cy * 64 + cx
      aosNext[i] = aosCellHead[c]!
      aosCellHead[c] = i
    }
    for (let i = 0; i < COUNT; i++) {
      const a = aosAgents[i]!
      if (a.state === "dead") continue
      a.stateTime += dt
      a.hitFlash = Math.max(0, a.hitFlash - dt * 4.5)
      const wp = a.path[0] ?? { x: a.targetX, y: a.targetY }
      const dx = wp.x - a.x
      const dy = wp.y - a.y
      const d = Math.hypot(dx, dy) || 1
      let sepX = 0
      let sepY = 0
      const cx = Math.max(1, Math.min(62, (a.x * 0.6667) | 0))
      const cy = Math.max(1, Math.min(62, (a.y * 0.6667) | 0))
      for (let dyc = -1; dyc <= 1; dyc++) {
        const row = (cy + dyc) * 64
        for (let dxc = -1; dxc <= 1; dxc++) {
          let cur = aosCellHead[row + cx + dxc]!
          while (cur >= 0) {
            if (cur !== i) {
              const o = aosAgents[cur]!
              const rx = a.x - o.x
              const ry = a.y - o.y
              const d2 = rx * rx + ry * ry
              if (d2 > 1e-4 && d2 < 0.64) {
                const inv = 1 / Math.sqrt(d2)
                const push = (0.8 - d2 * inv) * 1.4
                sepX += rx * inv * push
                sepY += ry * inv * push
              }
            }
            cur = aosNext[cur]!
          }
        }
      }
      const spd = (a.state === "chase" ? 2.65 : 0.95) * a.speedScale
      const dirX = dx / d + sepX
      const dirY = dy / d + sepY
      const dirLen = Math.hypot(dirX, dirY) || 1
      a.vx = (dirX / dirLen) * spd
      a.vy = (dirY / dirLen) * spd
      a.x = Math.max(1, Math.min(95, a.x + a.vx * dt))
      a.y = Math.max(1, Math.min(95, a.y + a.vy * dt))
      a.aim = Math.atan2(a.vy, a.vx)
    }
  })

  // 1b. AoS + 4-repath-per-tick A* cap (current packages/kit/sim/ai.ts behavior)
  let repathCursor = 0
  const aosWithCappedAStarStep = measure(() => {
    for (let r = 0; r < 4; r++) {
      const a = aosAgents[repathCursor++ % COUNT]!
      a.path = gridNav.path(a, { x: 27.7, y: 41.0 }, 800) ?? [{ x: 27.7, y: 41.0 }]
    }
  }, 30, 2, 5)

  const aosHitscan = measure(() => {
    const ox = 27.7, oy = 41.0, dx = 0.7071, dy = -0.7071
    let bestT = 26.0
    let hitId = -1
    for (let i = 0; i < COUNT; i++) {
      const z = aosAgents[i]!
      if (z.state === "dead") continue
      const fx = z.x - ox
      const fy = z.y - oy
      const proj = fx * dx + fy * dy
      if (proj < 0 || proj >= bestT) continue
      const perp2 = fx * fx + fy * fy - proj * proj
      if (perp2 <= 0.1296) {
        const t = Math.max(0, proj - Math.sqrt(0.1296 - perp2))
        if (t < bestT) {
          bestT = t
          hitId = z.id
        }
      }
    }
    return hitId
  }, 60, 40)

  const aosSnapEncode = measure(() => {
    aosWriter.reset()
    aosWriter.u16(COUNT)
    for (let i = 0; i < COUNT; i++) {
      const a = aosAgents[i]!
      aosWriter
        .u16(a.id)
        .u8(STATE_MAP[a.state] ?? 0)
        .i32(Math.round(a.x * 100))
        .i32(Math.round(a.y * 100))
        .u16(packAngle(a.aim))
        .u8(Math.round(a.hp))
        .u8(Math.round(a.hitFlash * 255))
        .u8(Math.min(255, Math.round(a.stateTime * 20)))
        .u8(Math.round((a.timer / 0.75) * 255))
        .u8(0)
    }
    return aosWriter.length
  })

  // ==========================================================================
  // 2. GENERAL ARCHETYPE / BITMASK ECS (Dynamic Component Stores + Query Iteration)
  // ==========================================================================
  const COMP_POS = 1 << 0
  const COMP_VEL = 1 << 1
  const COMP_AI = 1 << 2
  const COMP_HP = 1 << 3
  const COMP_TRAIT = 1 << 4
  const ALL_ZOMBIE_MASK = COMP_POS | COMP_VEL | COMP_AI | COMP_HP | COMP_TRAIT

  const MAX_ENTITIES = COUNT + 64
  const ecsMasks = new Uint32Array(MAX_ENTITIES)
  const ecsPos = Array.from({ length: MAX_ENTITIES }, () => ({ x: 0, y: 0, aim: 0 }))
  const ecsVel = Array.from({ length: MAX_ENTITIES }, () => ({ vx: 0, vy: 0 }))
  const ecsAi = Array.from({ length: MAX_ENTITIES }, () => ({ state: 0, stateTime: 0, timer: 0, targetX: 27.7, targetY: 41.0 }))
  const ecsHp = Array.from({ length: MAX_ENTITIES }, () => ({ hp: 100, hitFlash: 0 }))
  const ecsTrait = Array.from({ length: MAX_ENTITIES }, () => ({ speedScale: 1.0 }))

  for (let i = 0; i < COUNT; i++) {
    const src = aosAgents[i]!
    ecsMasks[i] = ALL_ZOMBIE_MASK
    ecsPos[i]!.x = initX[i]!
    ecsPos[i]!.y = initY[i]!
    ecsPos[i]!.aim = src.aim
    ecsAi[i]!.state = i % 2 === 0 ? 3 : 0
    ecsTrait[i]!.speedScale = src.speedScale
  }

  const ecsQueryOut = new Int32Array(MAX_ENTITIES)
  function ecsQuery(mask: number): number {
    let n = 0
    for (let e = 0; e < MAX_ENTITIES; e++) {
      if ((ecsMasks[e]! & mask) === mask) ecsQueryOut[n++] = e
    }
    return n
  }

  let ecsTick = 0
  const ecsKinematicsStep = measure(() => {
    if ((++ecsTick & 15) === 0) {
      for (let i = 0; i < COUNT; i++) {
        ecsPos[i]!.x = initX[i]!
        ecsPos[i]!.y = initY[i]!
      }
    }
    const dt = 1 / 60
    const n = ecsQuery(COMP_POS | COMP_VEL | COMP_AI | COMP_TRAIT)
    aosCellHead.fill(-1)
    for (let k = 0; k < n; k++) {
      const e = ecsQueryOut[k]!
      const p = ecsPos[e]!
      const cx = Math.max(0, Math.min(63, (p.x * 0.6667) | 0))
      const cy = Math.max(0, Math.min(63, (p.y * 0.6667) | 0))
      const c = cy * 64 + cx
      aosNext[k] = aosCellHead[c]!
      aosCellHead[c] = k
    }
    for (let k = 0; k < n; k++) {
      const e = ecsQueryOut[k]!
      const p = ecsPos[e]!
      const v = ecsVel[e]!
      const ai = ecsAi[e]!
      const tr = ecsTrait[e]!
      ai.stateTime += dt
      const dx = ai.targetX - p.x
      const dy = ai.targetY - p.y
      const d = Math.hypot(dx, dy) || 1
      let sepX = 0, sepY = 0
      const cx = Math.max(1, Math.min(62, (p.x * 0.6667) | 0))
      const cy = Math.max(1, Math.min(62, (p.y * 0.6667) | 0))
      for (let dyc = -1; dyc <= 1; dyc++) {
        const row = (cy + dyc) * 64
        for (let dxc = -1; dxc <= 1; dxc++) {
          let cur = aosCellHead[row + cx + dxc]!
          while (cur >= 0) {
            if (cur !== k) {
              const op = ecsPos[ecsQueryOut[cur]!]!
              const rx = p.x - op.x
              const ry = p.y - op.y
              const d2 = rx * rx + ry * ry
              if (d2 > 1e-4 && d2 < 0.64) {
                const inv = 1 / Math.sqrt(d2)
                const push = (0.8 - d2 * inv) * 1.4
                sepX += rx * inv * push
                sepY += ry * inv * push
              }
            }
            cur = aosNext[cur]!
          }
        }
      }
      const spd = (ai.state === 3 ? 2.65 : 0.95) * tr.speedScale
      const dirX = dx / d + sepX
      const dirY = dy / d + sepY
      const dirLen = Math.hypot(dirX, dirY) || 1
      v.vx = (dirX / dirLen) * spd
      v.vy = (dirY / dirLen) * spd
      p.x = Math.max(1, Math.min(95, p.x + v.vx * dt))
      p.y = Math.max(1, Math.min(95, p.y + v.vy * dt))
      p.aim = Math.atan2(v.vy, v.vx)
    }
  })

  // ==========================================================================
  // 3. SELECTIVE DOMAIN SoA POOL (ZombiePool flat typed arrays + O(1) FlowField gradient)
  // ==========================================================================
  const soaId = new Uint16Array(COUNT)
  const soaX = new Float32Array(COUNT)
  const soaY = new Float32Array(COUNT)
  const soaVx = new Float32Array(COUNT)
  const soaVy = new Float32Array(COUNT)
  const soaAim = new Float32Array(COUNT)
  const soaSpeedScale = new Float32Array(COUNT)
  const soaState = new Uint8Array(COUNT)
  const soaHp = new Uint8Array(COUNT)

  for (let i = 0; i < COUNT; i++) {
    const src = aosAgents[i]!
    soaId[i] = src.id
    soaX[i] = initX[i]!
    soaY[i] = initY[i]!
    soaVx[i] = src.vx
    soaVy[i] = src.vy
    soaAim[i] = src.aim
    soaSpeedScale[i] = src.speedScale
    soaState[i] = i % 2 === 0 ? 3 : 0
    soaHp[i] = 100
  }

  let soaTick = 0
  const soaKinematicsAndFlowStep = measure(() => {
    if ((++soaTick & 15) === 0) {
      soaX.set(initX)
      soaY.set(initY)
    }
    const dt = 1 / 60
    aosCellHead.fill(-1)
    for (let i = 0; i < COUNT; i++) {
      if (soaState[i] === 7) continue
      const cx = Math.max(0, Math.min(63, (soaX[i]! * 0.6667) | 0))
      const cy = Math.max(0, Math.min(63, (soaY[i]! * 0.6667) | 0))
      const c = cy * 64 + cx
      aosNext[i] = aosCellHead[c]!
      aosCellHead[c] = i
    }
    for (let i = 0; i < COUNT; i++) {
      const st = soaState[i]!
      if (st === 7) continue
      const zx = soaX[i]!
      const zy = soaY[i]!
      // Direct O(1) 4-neighbor flow gradient read from pre-ensured costField
      const gx = Math.max(1, Math.min(190, (zx * 2) | 0))
      const gy = Math.max(1, Math.min(190, (zy * 2) | 0))
      const gIdx = gy * 192 + gx
      const cL = costField[gIdx - 1]!
      const cR = costField[gIdx + 1]!
      const cU = costField[gIdx - 192]!
      const cD = costField[gIdx + 192]!
      const fx = cL < cR ? -1 : cR < cL ? 1 : (27.7 - zx)
      const fy = cU < cD ? -1 : cD < cU ? 1 : (41.0 - zy)
      const fl = Math.hypot(fx, fy) || 1

      let sepX = 0
      let sepY = 0
      const cx = Math.max(1, Math.min(62, (zx * 0.6667) | 0))
      const cy = Math.max(1, Math.min(62, (zy * 0.6667) | 0))
      for (let dyc = -1; dyc <= 1; dyc++) {
        const row = (cy + dyc) * 64
        for (let dxc = -1; dxc <= 1; dxc++) {
          let cur = aosCellHead[row + cx + dxc]!
          while (cur >= 0) {
            if (cur !== i) {
              const rx = zx - soaX[cur]!
              const ry = zy - soaY[cur]!
              const d2 = rx * rx + ry * ry
              if (d2 > 1e-4 && d2 < 0.64) {
                const inv = 1 / Math.sqrt(d2)
                const push = (0.8 - d2 * inv) * 1.4
                sepX += rx * inv * push
                sepY += ry * inv * push
              }
            }
            cur = aosNext[cur]!
          }
        }
      }
      const spd = (st === 3 ? 2.65 : 0.95) * soaSpeedScale[i]!
      const dirX = fx / fl + sepX
      const dirY = fy / fl + sepY
      const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1
      const vx = (dirX / dirLen) * spd
      const vy = (dirY / dirLen) * spd
      soaVx[i] = vx
      soaVy[i] = vy
      soaX[i] = Math.max(1, Math.min(95, zx + vx * dt))
      soaY[i] = Math.max(1, Math.min(95, zy + vy * dt))
      soaAim[i] = Math.atan2(vy, vx)
    }
  })

  const soaHitscan = measure(() => {
    const ox = 27.7, oy = 41.0, dx = 0.7071, dy = -0.7071
    let bestT = 26.0
    let hitId = -1
    for (let i = 0; i < COUNT; i++) {
      if (soaState[i] === 7) continue
      const fx = soaX[i]! - ox
      const fy = soaY[i]! - oy
      const proj = fx * dx + fy * dy
      if (proj < 0 || proj >= bestT) continue
      const perp2 = fx * fx + fy * fy - proj * proj
      if (perp2 <= 0.1296) {
        const t = Math.max(0, proj - Math.sqrt(0.1296 - perp2))
        if (t < bestT) {
          bestT = t
          hitId = soaId[i]!
        }
      }
    }
    return hitId
  }, 60, 40)

  const soaSnapBuf = new Uint8Array(COUNT * 9 + 16)
  const soaSnapDv = new DataView(soaSnapBuf.buffer)
  const soaSnapEncode = measure(() => {
    soaSnapDv.setUint16(0, COUNT, true)
    let off = 2
    for (let i = 0; i < COUNT; i++) {
      soaSnapDv.setUint16(off, soaId[i]!, true)
      soaSnapDv.setInt16(off + 2, (soaX[i]! * 50) | 0, true)
      soaSnapDv.setInt16(off + 4, (soaY[i]! * 50) | 0, true)
      soaSnapBuf[off + 6] = ((soaAim[i]! * 40.743665) | 0) & 0xff
      soaSnapBuf[off + 7] = soaState[i]!
      soaSnapBuf[off + 8] = soaHp[i]!
      off += 9
    }
    return off
  })

  report[`zombies_${COUNT}`] = {
    "1_current_aos_objects": {
      kinematicsAndSeparationStep: aosKinematicsStep,
      fourAStarRepathsPerTick: aosWithCappedAStarStep,
      totalAiTickWithAStarUs: Number((aosKinematicsStep.medianUs + aosWithCappedAStarStep.medianUs).toFixed(2)),
      hitscanRaycast: aosHitscan,
      snapshotEncode: aosSnapEncode,
      approxMemoryBytes: COUNT * 480,
    },
    "2_general_bitmask_ecs": {
      kinematicsAndSeparationStep: ecsKinematicsStep,
      approxMemoryBytes: COUNT * 220,
    },
    "3_selective_domain_soa_pool": {
      kinematicsFlowAndSeparationStep: soaKinematicsAndFlowStep,
      hitscanRaycast: soaHitscan,
      snapshotEncode: soaSnapEncode,
      approxMemoryBytes: COUNT * 28,
      speedupVsCurrentAosWithAStar: {
        totalAiStep: Number(((aosKinematicsStep.medianUs + aosWithCappedAStarStep.medianUs) / soaKinematicsAndFlowStep.medianUs).toFixed(2)),
        kinematicsOnly: Number((aosKinematicsStep.medianUs / soaKinematicsAndFlowStep.medianUs).toFixed(2)),
        hitscanRaycast: Number((aosHitscan.medianUs / soaHitscan.medianUs).toFixed(2)),
        snapshotEncode: Number((aosSnapEncode.medianUs / soaSnapEncode.medianUs).toFixed(2)),
        memoryReduction: Number(((COUNT * 480) / (COUNT * 28)).toFixed(1)),
      },
    },
  }
}

writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
