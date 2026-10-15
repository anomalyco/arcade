import { wgslSnippet, wgslStruct } from "@arcade/kit/gpu/wgsl"

export const StyleUniformsStruct = wgslStruct("StyleUniforms", {
  viewport: "vec4f",
  params0: "vec4f",
  params1: "vec4f",
  params2: "vec4f",
  playerWorld: "vec4f",
  playerScreen: "vec4f",
  shotWorld: "vec4f",
  shotScreen: "vec4f",
  shotMeta: "vec4f",
  zombiesWorld: "array<vec4f, 4>",
  zombiesScreen: "array<vec4f, 4>",
  eye: "vec4f",
  invViewProj: "mat4x4f",
})

export const STYLE_UNIFORM_FLOATS = StyleUniformsStruct.floatCount // 88 floats (352 bytes)

export const styleWgslCommonSnippet = wgslSnippet(
  "style-playground-common",
  /* wgsl */ `
@group(0) @binding(0) var<uniform> SU: StyleUniforms;
@group(0) @binding(1) var tScene: texture_2d<f32>;
@group(0) @binding(2) var sLinear: sampler;
@group(0) @binding(3) var tNormalDepth: texture_2d<f32>;
@group(0) @binding(4) var tAux: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let c = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(c[i], 0.0, 1.0);
  o.uv = c[i] * vec2f(0.5, -0.5) + 0.5;
  return o;
}

fn sHash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

fn sNoise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(sHash2(i), sHash2(i + vec2f(1.0, 0.0)), u.x),
    mix(sHash2(i + vec2f(0.0, 1.0)), sHash2(i + vec2f(1.0, 1.0)), u.x),
    u.y
  );
}

fn sBayer4(coord: vec2f) -> f32 {
  let p = vec2u(floor(coord)) % 4u;
  let m = array<f32, 16>(
    0.0,  8.0,  2.0, 10.0,
    12.0, 4.0, 14.0,  6.0,
    3.0, 11.0,  1.0,  9.0,
    15.0, 7.0, 13.0,  5.0
  );
  return (m[p.y * 4u + p.x] + 0.5) / 16.0 - 0.5;
}

fn sBayer8(coord: vec2f) -> f32 {
  let b4 = sBayer4(coord) + 0.5;
  let sub = sBayer4(floor(coord * 0.5)) + 0.5;
  return fract(b4 + sub * 0.25) - 0.5;
}

fn sLuma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn sSampleSceneSrgb(uv: vec2f) -> vec3f {
  return clamp(textureSampleLevel(tScene, sLinear, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0).rgb, vec3f(0.0), vec3f(1.0));
}

fn sSampleNormalDepth(uv: vec2f) -> vec4f {
  let nd = textureSampleLevel(tNormalDepth, sLinear, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0);
  let n = select(vec3f(0.0, 1.0, 0.0), normalize(nd.rgb * 2.0 - 1.0), nd.a > 0.05);
  return vec4f(n, nd.a);
}

fn sSampleAux(uv: vec2f) -> vec4f {
  return textureSampleLevel(tAux, sLinear, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0);
}

fn sReconstructWorld(uv: vec2f, dist: f32) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 1.0, 1.0);
  let q = SU.invViewProj * ndc;
  let worldFar = q.xyz / max(abs(q.w), 1e-5);
  let ray = normalize(worldFar - SU.eye.xyz);
  if (dist > 0.05) {
    return SU.eye.xyz + ray * dist;
  }
  let tFloor = select(22.0, -SU.eye.y / ray.y, ray.y < -1e-4 && -SU.eye.y / ray.y > 0.0);
  return SU.eye.xyz + ray * tFloor;
}

fn sSampleEdges(uv: vec2f, stepUv: vec2f) -> vec3f {
  let c = sSampleNormalDepth(uv);
  let r = sSampleNormalDepth(uv + vec2f(stepUv.x, 0.0));
  let l = sSampleNormalDepth(uv - vec2f(stepUv.x, 0.0));
  let u = sSampleNormalDepth(uv - vec2f(0.0, stepUv.y));
  let d = sSampleNormalDepth(uv + vec2f(0.0, stepUv.y));

  let ac = sSampleAux(uv).g;
  let ar = sSampleAux(uv + vec2f(stepUv.x, 0.0)).g;
  let al = sSampleAux(uv - vec2f(stepUv.x, 0.0)).g;
  let au = sSampleAux(uv - vec2f(0.0, stepUv.y)).g;
  let ad = sSampleAux(uv + vec2f(0.0, stepUv.y)).g;

  let baseDist = max(c.a, 8.0);
  let dGrad = (abs(r.a - l.a) + abs(u.a - d.a)) / (baseDist * 0.055);
  let depthEdge = smoothstep(0.24, 0.72, dGrad);

  let nGrad = length(r.xyz - l.xyz) + length(u.xyz - d.xyz);
  let normalEdge = smoothstep(0.38, 1.05, nGrad);

  let roleDiff = abs(ar - al) + abs(au - ad) + abs(ar - ac) + abs(au - ac);
  let actorEdge = smoothstep(0.08, 0.22, roleDiff);

  return vec3f(depthEdge, normalEdge, actorEdge);
}

fn sSegmentDist(p: vec2f, a: vec2f, b: vec2f, aspect: f32) -> vec2f {
  let pa = (p - a) * vec2f(aspect, 1.0);
  let ba = (b - a) * vec2f(aspect, 1.0);
  let len2 = max(dot(ba, ba), 1e-6);
  let t = clamp(dot(pa, ba) / len2, 0.0, 1.0);
  let d = length(pa - ba * t);
  return vec2f(d, t);
}
`,
  [StyleUniformsStruct],
)
