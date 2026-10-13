import { SEA_MAX_WAVES } from "./sea"

/**
 * WGSL mirror of shared/sea.ts. Declares `struct SeaUniform` and functions only; the consumer declares
 *   @group(1) @binding(0) var<uniform> sea: SeaUniform;
 * and fills it every frame with packSea(sea, t, floats, originX, originZ) (SEA_UNIFORM_FLOATS floats, 544 bytes).
 *
 * Large worlds: the functions take p = rest position MINUS sea.origin.xy. Snap the origin to SEA_ORIGIN_GRID (1024 m)
 * near the camera with snapSeaOrigin, and build p in f32 from small numbers (e.g. a camera-centred grid plus the
 * camera offset from the origin), never by subtracting two large f32 world coordinates. packSea folds k (d · origin)
 * and ω t into each phase in float64, so the GPU only ever multiplies k by the offset from the origin. Emulated f32
 * agrees with the float64 CPU to 0.2 mm within 8 km of the origin and 0.8 mm at 32 km (tests/sea.test.ts), after days
 * of sea time. Each phase is reduced to [-π, π] before sin/cos, where WGSL guarantees their accuracy.
 *
 * Add the returned offset to the rest position: world = origin + p + seaDisplace(p).xz, height = seaDisplace(p).y.
 */
export const SEA_WGSL = /* wgsl */ `
struct SeaUniform {
  waves: array<vec4f, ${SEA_MAX_WAVES}>, // dirX, dirZ, k (rad/m), phase at p = 0 (rad, [0, 2pi))
  shape: array<vec4f, ${SEA_MAX_WAVES}>, // A, Q*A, Q*A*k, A*k
  origin: vec4f,                         // origin x, z (world metres), wave count, 0
  foam: vec4f,                           // lo, hi, height weight (1/m), 0
}

const SEA_TAU: f32 = 6.283185307179586;

fn seaPhase(w: vec4f, p: vec2f) -> f32 {
  let th = w.z * dot(w.xy, p) + w.w;
  return th - SEA_TAU * round(th / SEA_TAU);
}

// Surface offset (dx, y, dz) for rest position p (relative to sea.origin).
fn seaDisplace(p: vec2f) -> vec3f {
  var d = vec3f(0.0);
  let n = u32(sea.origin.z);
  for (var i = 0u; i < n; i = i + 1u) {
    let w = sea.waves[i];
    let s = sea.shape[i];
    let th = seaPhase(w, p);
    let c = cos(th);
    d = d + vec3f(w.x * s.y * c, s.x * sin(th), w.y * s.y * c);
  }
  return d;
}

// For rest position p (relative to sea.origin): xy = gradient (dh/dx, dh/dz) of the displaced surface at the point p
// moves to (normal = normalize(vec3f(-g.x, 1, -g.y))), z = crest foam 0..1 from the Jacobian and height, w = 0.
fn seaSlope(p: vec2f) -> vec4f {
  var jxx: f32 = 0.0;
  var jxz: f32 = 0.0;
  var jzz: f32 = 0.0;
  var gx: f32 = 0.0;
  var gz: f32 = 0.0;
  var y: f32 = 0.0;
  let n = u32(sea.origin.z);
  for (var i = 0u; i < n; i = i + 1u) {
    let w = sea.waves[i];
    let s = sea.shape[i];
    let th = seaPhase(w, p);
    let c = cos(th);
    let sn = sin(th);
    let j = s.z * sn;
    jxx = jxx - j * w.x * w.x;
    jxz = jxz - j * w.x * w.y;
    jzz = jzz - j * w.y * w.y;
    let g = s.w * c;
    gx = gx + g * w.x;
    gz = gz + g * w.y;
    y = y + s.x * sn;
  }
  let xx = 1.0 + jxx;
  let zz = 1.0 + jzz;
  let det = xx * zz - jxz * jxz;
  let hx = (zz * gx - jxz * gz) / det;
  let hz = (xx * gz - jxz * gx) / det;
  let foam = smoothstep(sea.foam.x, sea.foam.y, 1.0 - det + sea.foam.z * y);
  return vec4f(hx, hz, foam, 0.0);
}
`
