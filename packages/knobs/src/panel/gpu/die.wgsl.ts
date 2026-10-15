import { DIE, DIE_BOX, DIE_FEATHER, DIE_LIGHT, FACES, PIPS } from "../die.js"

// The rounded-cube die, traced exactly as `dieTracer` in die.ts does (same constants, same steps),
// so the GPU and the DOM canvas draw identical pixels.

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n))
const v3 = (v: readonly number[]) => `vec3f(${v.map(f).join(", ")})`

const pipBranches = FACES.map(({ value }, i) => {
  const d = PIPS[value]!.map(([x, y]) => `length(uv - vec2f(${f(x)}, ${f(y)}))`)
  return `  if (face == ${i}u) { return ${d.reduce((acc, e) => `min(${acc}, ${e})`)}; }`
}).join("\n")

const INNER = DIE.half - DIE.round
const BOUND = +(INNER * Math.sqrt(3) + DIE.round + 1).toFixed(4)

export const DIE_WGSL = /* wgsl */ `
const DIE_N = array<vec3f, 6>(${FACES.map((x) => v3(x.n)).join(", ")});
const DIE_U = array<vec3f, 6>(${FACES.map((x) => v3(x.u)).join(", ")});
const DIE_V = array<vec3f, 6>(${FACES.map((x) => v3(x.v)).join(", ")});
const DIE_LIGHT = ${v3(DIE_LIGHT)};

fn die_pips(face: u32, uv: vec2f) -> f32 {
${pipBranches}
  return 1e9;
}

// CSS rotateX(a.x) rotateY(a.y) on a vector (y down, z towards the viewer).
fn die_to_world(v: vec3f, a: vec2f) -> vec3f {
  let x1 = v.x * cos(a.y) + v.z * sin(a.y);
  let z1 = -v.x * sin(a.y) + v.z * cos(a.y);
  return vec3f(x1, v.y * cos(a.x) - z1 * sin(a.x), v.y * sin(a.x) + z1 * cos(a.x));
}
fn die_to_local(v: vec3f, a: vec2f) -> vec3f {
  let y1 = v.y * cos(a.x) + v.z * sin(a.x);
  let z1 = -v.y * sin(a.x) + v.z * cos(a.x);
  return vec3f(v.x * cos(a.y) - z1 * sin(a.y), y1, v.x * sin(a.y) + z1 * cos(a.y));
}

// One ray through offset p (px from the die centre). look = (perspective, lift, cos bevel, fill).
fn die_trace(p: vec2f, size: f32, rot: vec2f, energy: f32, look: vec4f, shade: f32) -> f32 {
  let unit = size / 256.0;
  let k = energy / (look.x * 256.0);
  let cz = look.y * energy * 256.0 - ${f(+DIE.half.toFixed(4))};
  let dw = normalize(vec3f(p / unit * k, -1.0));
  let ow = vec3f(p / unit, 0.0) - dw * 512.0 - vec3f(0.0, 0.0, cz);
  let b = dot(ow, dw);
  let disc = b * b - (dot(ow, ow) - ${f(BOUND)} * ${f(BOUND)});
  if (disc < 0.0) { return 0.0; }
  let o = die_to_local(ow, rot);
  let d = die_to_local(dw, rot);
  var t = max(0.0, -b - sqrt(disc));
  let far = -b + sqrt(disc);
  var q = vec3f(0.0);
  var hit = false;
  for (var i = 0; i < 48 && t < far; i++) {
    q = o + t * d;
    let e = abs(q) - vec3f(${f(INNER)});
    let dist = length(max(e, vec3f(0.0))) + min(max(e.x, max(e.y, e.z)), 0.0) - ${f(+DIE.round.toFixed(4))};
    if (dist < 0.02) { hit = true; break; }
    t += dist;
  }
  if (!hit) { return 0.0; }
  let raw = max(abs(q) - vec3f(${f(INNER)}), vec3f(0.0)) * sign(q);
  let n = select(raw / length(raw), vec3f(0.0, 0.0, 1.0), length(raw) == 0.0);
  if (max(abs(n.x), max(abs(n.y), abs(n.z))) < look.z) { return 1.0; }
  var best = 0u;
  var score = -2.0;
  for (var k = 0u; k < 6u; k++) {
    let s = dot(DIE_N[k], n);
    if (s > score) { score = s; best = k; }
  }
  let uv = vec2f(dot(DIE_U[best], q), dot(DIE_V[best], q));
  if (die_pips(best, uv) < ${f(DIE.pip)}) { return 1.0; }
  let lambert = max(0.0, dot(die_to_world(n, rot), DIE_LIGHT));
  return energy * (look.w + shade * lambert);
}

// Supersampled coverage of the device pixel whose centre is at frag (device px); origin is the
// device-px position of the die centre. Feathered out toward the edge of its box, like the canvas.
fn die_coverage(frag: vec2f, origin: vec2f, dpr: f32, samples: u32, size: f32, rot: vec2f, energy: f32, look: vec4f, shade: f32) -> f32 {
  let half = ceil(size * ${f(DIE_BOX)}) * 0.5;
  let feather = 1.0 - smoothstep(half * ${f(DIE_FEATHER)}, half, length(frag - origin) / dpr);
  if (feather <= 0.0) { return 0.0; }
  let s = f32(samples);
  var cov = 0.0;
  for (var j = 0u; j < samples; j++) {
    for (var i = 0u; i < samples; i++) {
      let dev = frag - vec2f(0.5) + (vec2f(f32(i), f32(j)) + 0.5) / s;
      cov += die_trace((dev - origin) / dpr, size, rot, energy, look, shade);
    }
  }
  return cov / (s * s) * feather;
}
`
