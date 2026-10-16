import { ACCESS_ROAD, COUNTY_ROAD, FENCE, WORLD_HALF, accessRoadSamples, countyRoadSamples } from "./layout"

// Terrain height. Roads and the compound sit on flat ground at y = 0; rolling hills rise away from them. Baked once
// into a grid at module load and sampled bilinearly, so placement code and the player can call it freely.

const N = 512
const CELL = (WORLD_HALF * 2) / (N - 1)
const grid = new Float32Array(N * N)

function hash(x: number, z: number) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function valueNoise(x: number, z: number) {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const fx = x - xi
  const fz = z - zi
  const u = fx * fx * (3 - 2 * fx)
  const v = fz * fz * (3 - 2 * fz)
  const a = hash(xi, zi)
  const b = hash(xi + 1, zi)
  const c = hash(xi, zi + 1)
  const d = hash(xi + 1, zi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

function fbm(x: number, z: number) {
  let sum = 0
  let amp = 1
  let freq = 1 / 160
  for (let i = 0; i < 5; i++) {
    sum += (valueNoise(x * freq, z * freq) - 0.5) * amp
    amp *= 0.5
    freq *= 2.03
  }
  return sum
}

function build() {
  const roads = [...accessRoadSamples(4), ...countyRoadSamples(-WORLD_HALF, WORLD_HALF, 6)]
  const roadHalf = Math.max(ACCESS_ROAD.width, COUNTY_ROAD.width) / 2 + 4
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -WORLD_HALF + i * CELL
      const z = -WORLD_HALF + j * CELL
      const dx = Math.max(FENCE.min[0] - x, 0, x - FENCE.max[0])
      const dz = Math.max(FENCE.min[1] - z, 0, z - FENCE.max[1])
      let d = Math.hypot(dx, dz)
      for (const r of roads) {
        const rd = Math.hypot(x - r[0], z - r[1]) - roadHalf
        if (rd < d) d = rd
      }
      const mask = smoothstep(4, 70, d)
      grid[j * N + i] = fbm(x, z) * 26 * mask + mask * 1.5
    }
  }
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

build()

export function heightAt(x: number, z: number) {
  const gx = Math.min(Math.max((x + WORLD_HALF) / CELL, 0), N - 1.001)
  const gz = Math.min(Math.max((z + WORLD_HALF) / CELL, 0), N - 1.001)
  const i = Math.floor(gx)
  const j = Math.floor(gz)
  const fx = gx - i
  const fz = gz - j
  const a = grid[j * N + i]!
  const b = grid[j * N + i + 1]!
  const c = grid[(j + 1) * N + i]!
  const d = grid[(j + 1) * N + i + 1]!
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}
