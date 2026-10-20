// Rust port of bench/kernels/terrain-js.ts (the game's terrain bake, heightAt, near-patch fill and far-mesh loop),
// built for wasm32-unknown-unknown with no dependencies (no wasm-bindgen; std only for f64 floor/sqrt, which lower
// to single wasm instructions): JS writes inputs into `input_ptr()`,
// calls the exports and reads the outputs through the exported pointers into linear memory.
//
// The scalar path uses f64 like JS so outputs match bit-for-bit-ish; `bake_simd` evaluates the hill fbm four cells at
// a time in f32x4 (wasm SIMD128) when built with `-C target-feature=+simd128`.
#![allow(static_mut_refs, clippy::missing_safety_doc)]

const GRID_N: usize = 512;
const MICRO_N: usize = 256;
const MICRO_SIZE: f64 = 64.0;
const ROAD_DIST_MAX: f64 = 96.0;
const SHOULDER: f64 = 1.5;
const DITCH_CENTER: f64 = SHOULDER + 2.3;
const DITCH_HALF: f64 = 1.9;
const DITCH_DEPTH: f64 = 0.42;
const HILL_AMP: f64 = 19.0;
const NEAR_SPACING: f64 = 0.5;
const NEAR_HALF: f64 = 64.0;
const NEAR_N: usize = 257;
const P: usize = NEAR_N + 2;
const FAR_SEG: usize = 320;
const FAR_N: usize = FAR_SEG + 1;

static mut COARSE: [f32; GRID_N * GRID_N] = [0.0; GRID_N * GRID_N];
static mut ROAD: [f32; GRID_N * GRID_N] = [0.0; GRID_N * GRID_N];
static mut MICRO: [f32; MICRO_N * MICRO_N] = [0.0; MICRO_N * MICRO_N];
static mut HEIGHTS: [f32; P * P] = [0.0; P * P];
static mut POS: [f32; NEAR_N * NEAR_N * 3] = [0.0; NEAR_N * NEAR_N * 3];
static mut NOR: [f32; NEAR_N * NEAR_N * 3] = [0.0; NEAR_N * NEAR_N * 3];
static mut UV: [f32; NEAR_N * NEAR_N * 2] = [0.0; NEAR_N * NEAR_N * 2];
static mut SURF: [f32; NEAR_N * NEAR_N * 2] = [0.0; NEAR_N * NEAR_N * 2];
static mut FAR_POS: [f32; FAR_N * FAR_N * 3] = [0.0; FAR_N * FAR_N * 3];
static mut FAR_SURF: [f32; FAR_N * FAR_N * 2] = [0.0; FAR_N * FAR_N * 2];
/// Input: [worldHalf, accessHalfW, countyHalfW, fence x0 z0 x1 z1, apron x0 z0 x1 z1, nAccess, nCounty, access..., county...]
static mut INPUT: [f64; 8192] = [0.0; 8192];

struct Cfg {
    wh: f64,
    cell: f64,
    fence: [f64; 4],
    apron: [f64; 4],
}
static mut CFG: Cfg = Cfg { wh: 700.0, cell: 1400.0 / 511.0, fence: [0.0; 4], apron: [0.0; 4] };

macro_rules! export_ptr {
    ($name:ident, $arr:ident) => {
        #[no_mangle]
        pub unsafe extern "C" fn $name() -> *const f32 {
            $arr.as_ptr()
        }
    };
}
export_ptr!(coarse_ptr, COARSE);
export_ptr!(road_ptr, ROAD);
export_ptr!(micro_ptr, MICRO);
export_ptr!(pos_ptr, POS);
export_ptr!(nor_ptr, NOR);
export_ptr!(uv_ptr, UV);
export_ptr!(surf_ptr, SURF);
export_ptr!(far_pos_ptr, FAR_POS);
export_ptr!(far_surf_ptr, FAR_SURF);
#[no_mangle]
pub unsafe extern "C" fn input_ptr() -> *mut f64 {
    INPUT.as_mut_ptr()
}

#[inline(always)]
fn floor(x: f64) -> f64 {
    x.floor()
}
#[inline(always)]
fn sqrt(x: f64) -> f64 {
    x.sqrt()
}
#[inline(always)]
fn hypot(a: f64, b: f64) -> f64 {
    sqrt(a * a + b * b)
}
#[inline(always)]
fn clamp01(t: f64) -> f64 {
    if t < 0.0 { 0.0 } else if t > 1.0 { 1.0 } else { t }
}
#[inline(always)]
fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = clamp01((x - a) / (b - a));
    t * t * (3.0 - 2.0 * t)
}
#[inline(always)]
fn ihash(x: i32, z: i32, seed: i32) -> f64 {
    let mut h = x.wrapping_mul(0x27d4eb2d) ^ z.wrapping_mul(0x165667b1) ^ seed.wrapping_mul(0x9e3779b1u32 as i32);
    h = (h ^ ((h as u32) >> 15) as i32).wrapping_mul(0x85ebca6bu32 as i32);
    h = (h ^ ((h as u32) >> 13) as i32).wrapping_mul(0xc2b2ae35u32 as i32);
    h ^= ((h as u32) >> 16) as i32;
    (h as u32) as f64 / 4294967296.0
}
#[inline(always)]
fn value_noise(x: f64, z: f64, seed: i32, period: f64) -> f64 {
    let xi = floor(x);
    let zi = floor(z);
    let fx = x - xi;
    let fz = z - zi;
    let u = fx * fx * (3.0 - 2.0 * fx);
    let v = fz * fz * (3.0 - 2.0 * fz);
    let (mut x0, mut z0, mut x1, mut z1) = (xi, zi, xi + 1.0, zi + 1.0);
    if period != 0.0 {
        x0 = ((x0 % period) + period) % period;
        z0 = ((z0 % period) + period) % period;
        x1 = ((x1 % period) + period) % period;
        z1 = ((z1 % period) + period) % period;
    }
    let a = ihash(x0 as i32, z0 as i32, seed);
    let b = ihash(x1 as i32, z0 as i32, seed);
    let c = ihash(x0 as i32, z1 as i32, seed);
    let d = ihash(x1 as i32, z1 as i32, seed);
    a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
#[inline(always)]
fn fbm(x: f64, z: f64, octaves: i32, mut freq: f64, seed: i32) -> f64 {
    let (mut sum, mut amp, mut norm) = (0.0, 1.0, 0.0);
    for i in 0..octaves {
        sum += (value_noise(x * freq, z * freq, seed + i * 17, 0.0) - 0.5) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.03;
    }
    sum / norm * 2.0
}
#[inline(always)]
fn box_sdf(x: f64, z: f64, b: &[f64; 4]) -> f64 {
    let cx = (b[0] + b[2]) / 2.0;
    let cz = (b[1] + b[3]) / 2.0;
    let qx = (x - cx).abs() - (b[2] - b[0]) / 2.0;
    let qz = (z - cz).abs() - (b[3] - b[1]) / 2.0;
    hypot(qx.max(0.0), qz.max(0.0)) + qx.max(qz).min(0.0)
}
#[inline(always)]
unsafe fn compound_distance(x: f64, z: f64) -> f64 {
    box_sdf(x, z, &CFG.fence).min(box_sdf(x, z, &CFG.apron))
}
#[inline(always)]
fn hill_mask(road: f64, comp: f64) -> f64 {
    smoothstep(7.0, 48.0, road) * smoothstep(12.0, 70.0, comp)
}
#[inline(always)]
fn ditch_at(road: f64, comp: f64) -> f64 {
    let t = (road - DITCH_CENTER) / DITCH_HALF;
    if t <= -1.0 || t >= 1.0 {
        return 0.0;
    }
    let b = 1.0 - t * t;
    -DITCH_DEPTH * b * b * smoothstep(2.0, 9.0, comp)
}
#[inline(always)]
fn micro_mask(road: f64, comp: f64) -> f64 {
    smoothstep(SHOULDER + 0.6, SHOULDER + 5.0, road) * smoothstep(1.0, 8.0, comp)
}
#[inline(always)]
unsafe fn sample_micro(x: f64, z: f64) -> f64 {
    let s = MICRO_N as f64 / MICRO_SIZE;
    let gx = x * s;
    let gz = z * s;
    let fi = floor(gx);
    let fj = floor(gz);
    let fx = gx - fi;
    let fz = gz - fj;
    let m = (MICRO_N - 1) as i32;
    let i0 = (fi as i32 & m) as usize;
    let j0 = (fj as i32 & m) as usize;
    let i1 = (i0 + 1) & (MICRO_N - 1);
    let j1 = (j0 + 1) & (MICRO_N - 1);
    let a = *MICRO.get_unchecked(j0 * MICRO_N + i0) as f64;
    let b = *MICRO.get_unchecked(j0 * MICRO_N + i1) as f64;
    let c = *MICRO.get_unchecked(j1 * MICRO_N + i0) as f64;
    let d = *MICRO.get_unchecked(j1 * MICRO_N + i1) as f64;
    a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}
#[inline(always)]
unsafe fn micro_at(x: f64, z: f64) -> f64 {
    sample_micro(x, z) * 0.11 + sample_micro(x * 0.6 - z * 0.8 + 17.3, x * 0.8 + z * 0.6 - 5.1) * 0.16
}
#[inline(always)]
unsafe fn sample_grid(grid: &[f32; GRID_N * GRID_N], x: f64, z: f64) -> f64 {
    let gx = ((x + CFG.wh) / CFG.cell).max(0.0).min(GRID_N as f64 - 1.001);
    let gz = ((z + CFG.wh) / CFG.cell).max(0.0).min(GRID_N as f64 - 1.001);
    let i = floor(gx);
    let j = floor(gz);
    let fx = gx - i;
    let fz = gz - j;
    let k = j as usize * GRID_N + i as usize;
    let a = *grid.get_unchecked(k) as f64;
    let b = *grid.get_unchecked(k + 1) as f64;
    let c = *grid.get_unchecked(k + GRID_N) as f64;
    let d = *grid.get_unchecked(k + GRID_N + 1) as f64;
    a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}
#[no_mangle]
pub unsafe extern "C" fn height_at(x: f64, z: f64) -> f64 {
    let road = sample_grid(&ROAD, x, z);
    let comp = compound_distance(x, z);
    let mut h = sample_grid(&COARSE, x, z);
    if road > DITCH_CENTER - DITCH_HALF {
        h += ditch_at(road, comp);
    }
    let m = micro_mask(road, comp);
    if m > 0.0 {
        h += micro_at(x, z) * m;
    }
    h
}
#[inline(always)]
unsafe fn surface_weights(x: f64, z: f64, road: f64, comp: f64, out: &mut [f32], o: usize) {
    let n = micro_at(x * 0.37 + 11.0, z * 0.37 - 7.0) * 6.0;
    let dirt = (1.0 - smoothstep(SHOULDER - 0.3, SHOULDER + 0.9 + n * 0.3, road)).max(ditch_at(road, comp) / -DITCH_DEPTH * 0.45);
    let mut grass = smoothstep(SHOULDER - 0.2, SHOULDER + 1.2, road) * (1.0 - smoothstep(5.5 + n, 9.5 + n * 1.5, road));
    grass = grass.max(1.0 - smoothstep(1.0 + n * 0.5, 7.0 + n, comp));
    *out.get_unchecked_mut(o) = grass as f32;
    *out.get_unchecked_mut(o + 1) = dirt as f32;
}

unsafe fn stamp_road(s: &[f64], half_width: f64) {
    let wh = CFG.wh;
    let cell = CFG.cell;
    let r = ROAD_DIST_MAX;
    let n = s.len() / 2;
    for k in 0..n - 1 {
        let (ax, az, bx, bz) = (s[k * 2], s[k * 2 + 1], s[k * 2 + 2], s[k * 2 + 3]);
        let abx = bx - ax;
        let abz = bz - az;
        let mut len2 = abx * abx + abz * abz;
        if len2 == 0.0 {
            len2 = 1.0;
        }
        let i0 = floor((ax.min(bx) - r + wh) / cell).max(0.0) as usize;
        let i1 = (-floor(-((ax.max(bx) + r + wh) / cell))).min((GRID_N - 1) as f64) as usize;
        let j0 = floor((az.min(bz) - r + wh) / cell).max(0.0) as usize;
        let j1 = (-floor(-((az.max(bz) + r + wh) / cell))).min((GRID_N - 1) as f64) as usize;
        for j in j0..=j1 {
            let z = -wh + j as f64 * cell;
            let row = j * GRID_N;
            for i in i0..=i1 {
                let x = -wh + i as f64 * cell;
                let t = clamp01(((x - ax) * abx + (z - az) * abz) / len2);
                let dx = x - ax - abx * t;
                let dz = z - az - abz * t;
                let d = sqrt(dx * dx + dz * dz) - half_width;
                let cellp = ROAD.get_unchecked_mut(row + i);
                if d < (*cellp as f64) {
                    *cellp = d as f32;
                }
            }
        }
    }
}

unsafe fn setup() -> (usize, usize) {
    let inp = &INPUT;
    CFG.wh = inp[0];
    CFG.cell = inp[0] * 2.0 / (GRID_N - 1) as f64;
    CFG.fence = [inp[3], inp[4], inp[5], inp[6]];
    CFG.apron = [inp[7], inp[8], inp[9], inp[10]];
    (inp[11] as usize, inp[12] as usize)
}

unsafe fn bake_roads_micro() {
    let (na, nc) = setup();
    for v in ROAD.iter_mut() {
        *v = ROAD_DIST_MAX as f32;
    }
    let base = 13;
    stamp_road(&INPUT[base..base + na * 2], INPUT[1]);
    stamp_road(&INPUT[base + na * 2..base + na * 2 + nc * 2], INPUT[2]);
    for j in 0..MICRO_N {
        for i in 0..MICRO_N {
            let x = i as f64 / MICRO_N as f64 * MICRO_SIZE;
            let z = j as f64 / MICRO_N as f64 * MICRO_SIZE;
            let (mut h, mut amp, mut cells) = (0.0, 1.0, 8.0);
            for o in 0..5 {
                h += (value_noise(x / MICRO_SIZE * cells, z / MICRO_SIZE * cells, 91 + o, cells) - 0.5) * amp;
                amp *= 0.5;
                cells *= 2.0;
            }
            MICRO[j * MICRO_N + i] = (h * 2.0) as f32;
        }
    }
}

/// height.ts bake(), scalar f64.
#[no_mangle]
pub unsafe extern "C" fn bake() {
    bake_roads_micro();
    let wh = CFG.wh;
    let cell = CFG.cell;
    for j in 0..GRID_N {
        let z = -wh + j as f64 * cell;
        for i in 0..GRID_N {
            let x = -wh + i as f64 * cell;
            let k = j * GRID_N + i;
            let mask = hill_mask(ROAD[k] as f64, compound_distance(x, z));
            COARSE[k] = if mask > 0.0 { ((fbm(x, z, 5, 1.0 / 230.0, 3) * HILL_AMP + 2.2) * mask) as f32 } else { 0.0 };
        }
    }
}

#[cfg(target_feature = "simd128")]
mod simd {
    use core::arch::wasm32::*;
    #[inline(always)]
    unsafe fn ihash4(x: v128, z: v128, seed: i32) -> v128 {
        let mut h = v128_xor(v128_xor(i32x4_mul(x, i32x4_splat(0x27d4eb2d)), i32x4_mul(z, i32x4_splat(0x165667b1))), i32x4_splat(seed.wrapping_mul(0x9e3779b1u32 as i32)));
        h = i32x4_mul(v128_xor(h, u32x4_shr(h, 15)), i32x4_splat(0x85ebca6bu32 as i32));
        h = i32x4_mul(v128_xor(h, u32x4_shr(h, 13)), i32x4_splat(0xc2b2ae35u32 as i32));
        h = v128_xor(h, u32x4_shr(h, 16));
        f32x4_mul(f32x4_convert_u32x4(h), f32x4_splat(1.0 / 4294967296.0))
    }
    /// fbm for four (x, z) points at once in f32.
    #[inline(always)]
    pub unsafe fn fbm4(x: v128, z: v128, octaves: i32, freq0: f32, seed: i32) -> v128 {
        let mut sum = f32x4_splat(0.0);
        let (mut amp, mut norm, mut freq) = (1.0f32, 0.0f32, freq0);
        let one = f32x4_splat(1.0);
        let three = f32x4_splat(3.0);
        let two = f32x4_splat(2.0);
        for o in 0..octaves {
            let px = f32x4_mul(x, f32x4_splat(freq));
            let pz = f32x4_mul(z, f32x4_splat(freq));
            let fxi = f32x4_floor(px);
            let fzi = f32x4_floor(pz);
            let fx = f32x4_sub(px, fxi);
            let fz = f32x4_sub(pz, fzi);
            let u = f32x4_mul(f32x4_mul(fx, fx), f32x4_sub(three, f32x4_mul(two, fx)));
            let v = f32x4_mul(f32x4_mul(fz, fz), f32x4_sub(three, f32x4_mul(two, fz)));
            let xi = i32x4_trunc_sat_f32x4(fxi);
            let zi = i32x4_trunc_sat_f32x4(fzi);
            let xi1 = i32x4_add(xi, i32x4_splat(1));
            let zi1 = i32x4_add(zi, i32x4_splat(1));
            let s = seed + o * 17;
            let a = ihash4(xi, zi, s);
            let b = ihash4(xi1, zi, s);
            let c = ihash4(xi, zi1, s);
            let d = ihash4(xi1, zi1, s);
            let n = f32x4_add(
                f32x4_add(a, f32x4_mul(f32x4_sub(b, a), u)),
                f32x4_add(f32x4_mul(f32x4_sub(c, a), v), f32x4_mul(f32x4_mul(f32x4_sub(f32x4_sub(a, b), f32x4_sub(c, d)), u), v)),
            );
            sum = f32x4_add(sum, f32x4_mul(f32x4_sub(n, f32x4_splat(0.5)), f32x4_splat(amp)));
            norm += amp;
            amp *= 0.5;
            freq *= 2.03;
        }
        let _ = one;
        f32x4_mul(sum, f32x4_splat(2.0 / norm))
    }
}

/// height.ts bake() with the hill fbm evaluated four cells at a time (f32x4). Needs +simd128.
#[cfg(target_feature = "simd128")]
#[no_mangle]
pub unsafe extern "C" fn bake_simd() {
    use core::arch::wasm32::*;
    bake_roads_micro();
    let wh = CFG.wh;
    let cell = CFG.cell;
    let mut masks = [0.0f64; 4];
    for j in 0..GRID_N {
        let z = -wh + j as f64 * cell;
        let mut i = 0;
        while i < GRID_N {
            let mut any = false;
            for l in 0..4 {
                let x = -wh + (i + l) as f64 * cell;
                masks[l] = hill_mask(ROAD[j * GRID_N + i + l] as f64, compound_distance(x, z));
                any |= masks[l] > 0.0;
            }
            let k = j * GRID_N + i;
            if any {
                let x0 = (-wh + i as f64 * cell) as f32;
                let c = cell as f32;
                let xs = f32x4(x0, x0 + c, x0 + 2.0 * c, x0 + 3.0 * c);
                let f = simd::fbm4(xs, f32x4_splat(z as f32), 5, 1.0 / 230.0, 3);
                let vals = [f32x4_extract_lane::<0>(f), f32x4_extract_lane::<1>(f), f32x4_extract_lane::<2>(f), f32x4_extract_lane::<3>(f)];
                for l in 0..4 {
                    COARSE[k + l] = if masks[l] > 0.0 { ((vals[l] as f64 * HILL_AMP + 2.2) * masks[l]) as f32 } else { 0.0 };
                }
            } else {
                for l in 0..4 {
                    COARSE[k + l] = 0.0;
                }
            }
            i += 4;
        }
    }
}

/// terrain.ts fillPatch around (cx, cz).
#[no_mangle]
pub unsafe extern "C" fn fill_patch(cx: f64, cz: f64) {
    let x0 = cx - NEAR_HALF;
    let z0 = cz - NEAR_HALF;
    for j in 0..P {
        let z = z0 + (j as f64 - 1.0) * NEAR_SPACING;
        for i in 0..P {
            HEIGHTS[j * P + i] = height_at(x0 + (i as f64 - 1.0) * NEAR_SPACING, z) as f32;
        }
    }
    let inv = 1.0 / (2.0 * NEAR_SPACING);
    for j in 0..NEAR_N {
        let z = z0 + j as f64 * NEAR_SPACING;
        for i in 0..NEAR_N {
            let x = x0 + i as f64 * NEAR_SPACING;
            let k = j * NEAR_N + i;
            let h = (j + 1) * P + i + 1;
            POS[k * 3] = x as f32;
            POS[k * 3 + 1] = HEIGHTS[h];
            POS[k * 3 + 2] = z as f32;
            let dx = (HEIGHTS[h + 1] as f64 - HEIGHTS[h - 1] as f64) * inv;
            let dz = (HEIGHTS[h + P] as f64 - HEIGHTS[h - P] as f64) * inv;
            let l = 1.0 / sqrt(dx * dx + 1.0 + dz * dz);
            NOR[k * 3] = (-dx * l) as f32;
            NOR[k * 3 + 1] = l as f32;
            NOR[k * 3 + 2] = (-dz * l) as f32;
            UV[k * 2] = x as f32;
            UV[k * 2 + 1] = -z as f32;
            surface_weights(x, z, sample_grid(&ROAD, x, z), compound_distance(x, z), &mut SURF, k * 2);
        }
    }
}

/// terrain.ts buildFar's CPU loop.
#[no_mangle]
pub unsafe extern "C" fn fill_far() {
    let wh = CFG.wh;
    let size = wh * 2.0;
    for j in 0..FAR_N {
        for i in 0..FAR_N {
            let k = j * FAR_N + i;
            let x = -wh + i as f64 / FAR_SEG as f64 * size;
            let z = -wh + j as f64 / FAR_SEG as f64 * size;
            FAR_POS[k * 3] = x as f32;
            FAR_POS[k * 3 + 1] = height_at(x, z) as f32;
            FAR_POS[k * 3 + 2] = z as f32;
            surface_weights(x, z, sample_grid(&ROAD, x, z), compound_distance(x, z), &mut FAR_SURF, k * 2);
        }
    }
}
