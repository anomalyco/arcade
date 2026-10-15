import { dieSamples, HEADER_DIE } from "../die.js"
import { DIE_WGSL } from "./die.wgsl.js"

export const FLOATS_PER_PRIM = 40

export const panelWgsl = /* wgsl */ `
${DIE_WGSL}

// kind 11: The Random button's die mid-roll, traced like the DOM canvas. extra = (rx, ry, energy,
// size), aux = (perspective, lift, cos bevel, fill), look.y = shade.
fn shadeDie(p: Prim, rect: vec4f, frag: vec2f) -> vec4f {
  let origin = (rect.xy + rect.zw * 0.5) * view.dpr;
  let a = die_coverage(frag, origin, view.dpr, ${dieSamples(HEADER_DIE)}u, p.extra.w, p.extra.xy, p.extra.z, p.aux, p.look.y) * p.color.a;
  return vec4f(p.color.rgb * a, a);
}

struct Prim {
  rect: vec4f,    // x, y, w, h in viewport CSS px
  clip: vec4f,    // minX, minY, maxX, maxY in viewport CSS px
  uv: vec4f,      // u0, v0, u1, v1 (atlas UVs), or corner radii tl, tr, br, bl when motion.w is odd
  color: vec4f,   // primary r, g, b, a
  color2: vec4f,  // secondary r, g, b, a (border / handle / thumb / glow)
  look: vec4f,    // radius, strokeWidth, glowOrBlur, kind
  motion: vec4f,  // blurX, blurY, unused, cornersInUv + 2 * (mask index + 1)
  extra: vec4f,   // kind-specific params
  aux: vec4f,     // kind-specific params
  aux2: vec4f,    // kind-specific color
}

// A panel morphing out of its chip clips its content to the shape and reveals it top first.
struct Mask {
  rect: vec4f,    // x, y, w, h in viewport CSS px
  look: vec4f,    // radius, fully shown above y, hidden below y, unused
}

struct View {
  size: vec2f,
  dpr: f32,
  time: f32,
}

@group(0) @binding(0) var<storage, read> prims: array<Prim>;
@group(0) @binding(1) var<uniform> view: View;
@group(0) @binding(2) var labels: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
@group(0) @binding(4) var<storage, read> pts: array<vec2f>;
@group(0) @binding(5) var<storage, read> masks: array<Mask>;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) screenPx: vec2f,
  @location(1) @interpolate(flat) id: u32,
  @location(2) @interpolate(flat) rect: vec4f,
}

@vertex fn vs_main(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let p = prims[i];
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0)
  );
  let c = corners[v];

  let r = p.rect;

  // Shadows and the pill/switch glows reach ~14px past their shapes.
  let wide = p.look.w == 0.0 || p.look.w == 3.0 || p.look.w == 4.0 || p.look.w == 10.0;
  let padGlow = select(p.look.z * 1.6, p.look.z * 2.2 + 8.0, wide);
  let pad = vec2f(padGlow + 2.0) + abs(p.motion.xy) * 0.65;
  let screenPx = (r.xy - pad) + c * (r.zw + pad * 2.0);

  var o: Out;
  o.pos = vec4f(screenPx / view.size * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
  o.screenPx = screenPx;
  o.id = i;
  o.rect = r;
  return o;
}

fn roundedBox(p: vec2f, size: vec2f, r: f32) -> f32 {
  let rad = min(r, min(size.x, size.y) * 0.5);
  let q = abs(p - size * 0.5) - size * 0.5 + rad;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rad;
}

// Per-corner radii (tl, tr, br, bl), e.g. the first and last rows of a grouped card.
fn roundedBox4(p: vec2f, size: vec2f, radii: vec4f) -> f32 {
  let c = p - size * 0.5;
  let top = select(radii.x, radii.y, c.x > 0.0);
  let bottom = select(radii.w, radii.z, c.x > 0.0);
  let rad = min(select(top, bottom, c.y > 0.0), min(size.x, size.y) * 0.5);
  let q = abs(c) - size * 0.5 + rad;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rad;
}

fn radiiOf(p: Prim) -> vec4f {
  return select(vec4f(p.look.x), p.uv, (u32(p.motion.w) & 1u) == 1u);
}

fn covSd(dist: f32) -> f32 {
  return clamp(0.5 - dist * view.dpr, 0.0, 1.0);
}

fn hairline(dist: f32, w: f32) -> f32 {
  return clamp(0.5 - (abs(dist + w * 0.5) - w * 0.5) * view.dpr, 0.0, 1.0);
}

fn premul(c: vec4f) -> vec4f {
  return vec4f(c.rgb * c.a, c.a);
}

fn over(dst: vec4f, src: vec4f) -> vec4f {
  return src + dst * (1.0 - src.a);
}

fn hash21(q: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(q, vec2f(0.06711056, 0.00583715))));
}

// kind 0: Panel card surface + elevation shadow + border + specular rim
fn shadePanel(p: Prim, local: vec2f, size: vec2f) -> vec4f {
  let r = p.look.x;
  let dist = roundedBox(local, size, r);
  let bodyCov = covSd(dist);
  var out = vec4f(0.0);

  // Floating drop shadow when glowOrBlur (look.z) > 0; like box-shadow, never under the card.
  if (p.look.z > 0.5 && dist > -1.0) {
    let shDist = roundedBox(local - vec2f(0.0, 6.0), size, r);
    let shBlur = max(p.look.z, 2.0);
    let shA = pow(clamp(1.0 - smoothstep(-shBlur * 0.3, shBlur * 1.5, shDist), 0.0, 1.0), 1.8) * p.extra.x;
    out = vec4f(0.0, 0.0, 0.0, shA * (1.0 - bodyCov));
  }
  if (bodyCov <= 0.0) { return out; }

  var card = premul(p.color) * bodyCov;

  // The rim, built like CSS's inset 0 1px 0: inside the border, minus that shape moved down 1px.
  let inner = local - vec2f(1.0);
  let innerSize = size - vec2f(2.0);
  let rimCov = covSd(roundedBox(inner, innerSize, r - 1.0)) *
    (1.0 - covSd(roundedBox(inner - vec2f(0.0, 1.0), innerSize, r - 1.0)));
  card = over(card, premul(p.aux2) * rimCov);

  // 1px border
  let borderCov = hairline(dist, max(p.look.y, 1.0));
  card = over(card, premul(p.color2) * borderCov);

  return over(out, card);
}

// kind 1: Control surface (slider track, button, preset strip, segmented tray)
fn shadeTrack(p: Prim, local: vec2f, size: vec2f) -> vec4f {
  let dist = roundedBox4(local, size, radiiOf(p));
  var out = vec4f(0.0);

  // Focus ring + optical glow
  let focus = clamp(p.extra.y, 0.0, 1.0);
  if (focus > 0.005) {
    let glowR = max(2.0, p.look.z);
    if (dist > -2.0 && dist < glowR * 2.2) {
      let halo = exp(-max(dist, 0.0) / (glowR * 0.55)) * 0.24 * focus * clamp(p.look.z / 8.0, 0.0, 1.5);
      out = over(out, vec4f(p.color2.rgb * halo, halo));
    }
  }

  let cov = covSd(dist);
  if (cov > 0.0) {
    let hover = clamp(p.extra.x, 0.0, 1.0);
    let top = 1.0 - smoothstep(0.0, size.y * 0.65, local.y);
    let rgb = clamp(p.color.rgb + vec3f(hover * 0.03 + top * 0.012), vec3f(0.0), vec3f(1.0));
    let a = clamp(p.color.a + hover * 0.035, 0.0, 1.0);
    out = over(out, vec4f(rgb * a, a) * cov);

    if (p.look.y > 0.0) {
      let bCov = hairline(dist, p.look.y);
      out = over(out, premul(p.color2) * bCov);
    }
  }

  if (focus > 0.005) {
    let ringCov = clamp(0.5 - (abs(dist + 0.75) - 0.85) * view.dpr, 0.0, 1.0) * focus;
    out = over(out, vec4f(p.color2.rgb * ringCov, ringCov));
  }
  return out;
}

// Where text sits, the handle and ticks fade: clear of the label (aux.w, its right edge) and the
// readout (aux.x, its width from the right), over 8px a few px out, like the DOM's text mask.
fn clearOfText(p: Prim, x: f32, width: f32) -> f32 {
  return clamp((x - p.aux.w - 4.0) / 8.0, 0.0, 1.0) * clamp((width - p.aux.x - 4.0 - x) / 8.0, 0.0, 1.0);
}

// Single sample of slider fill + handle at local coordinate
fn sampleSliderAt(p: Prim, local: vec2f, size: vec2f) -> vec4f {
  let fillRatio = clamp(p.extra.x, 0.0, 1.0);
  let fillX = fillRatio * size.x;
  var out = vec4f(0.0);

  // One flat, monochrome fill.
  let fillCov = clamp(0.5 - (local.x - fillX) * view.dpr, 0.0, 1.0);
  if (fillCov > 0.0) {
    out = premul(p.color) * fillCov;
  }

  // Handle pill centred on the fill's edge.
  let handleScale = clamp(p.extra.y, 0.0, 1.0);
  if (handleScale > 0.01) {
    let fade = clearOfText(p, local.x, size.x);
    // Like the CSS handle: 3px wide at rest, scaled from 25% width as it appears.
    let hw = 3.0 * clamp(0.25 + handleScale * 1.15, 0.25, 1.0);
    let hh = max(6.0, size.y - 12.0);
    // motion.y: how far inside the fill's edge the handle sits (--k-handle-inset).
    let hp = local - vec2f(fillX - hw * 0.5 - p.motion.y, (size.y - hh) * 0.5);
    // look.y: 1 rounds the handle's ends, 0 squares them (--k-round).
    let hDist = roundedBox(hp, vec2f(hw, hh), select(0.0, hw * 0.5, p.look.y > 0.5));
    let hCov = covSd(hDist);
    let hAlpha = p.color2.a * handleScale * fade;
    if (hCov > 0.0) {
      out = over(out, vec4f(p.color2.rgb * hAlpha * hCov, hAlpha * hCov));
    }
    // Handle glow like its box-shadow: a blur of glow × 8 px (σ is half) at 60% accent.
    // look.z = --k-glow.
    let sigma = max(0.5, p.look.z * 4.0);
    if (p.look.z > 0.01 && hDist > 0.0 && hDist < sigma * 3.0) {
      let fall = exp(-0.5 * (hDist / sigma) * (hDist / sigma));
      let glow = fall * 0.6 * 0.32 * min(1.0, p.look.z * 4.0) * handleScale * fade;
      out = over(out, vec4f(p.color2.rgb * glow, glow));
    }
  }
  return out;
}

// kind 2: Slider fill + tick marks + hairline handle with horizontal motion blur
fn shadeSlider(p: Prim, local: vec2f, size: vec2f, fragPos: vec2f) -> vec4f {
  let trackDist = roundedBox4(local, size, radiiOf(p));
  let trackCov = covSd(trackDist);
  if (trackCov <= 0.0) { return vec4f(0.0); }

  let blurX = p.motion.x;
  var acc = vec4f(0.0);
  if (abs(blurX) < 0.6) {
    acc = sampleSliderAt(p, local, size);
  } else {
    let n = clamp(i32(abs(blurX) / 1.8) + 3, 4, 14);
    let j = hash21(fragPos);
    for (var k = 0; k < n; k++) {
      let f = (f32(k) + j) / f32(n) - 0.5;
      acc += sampleSliderAt(p, local - vec2f(blurX * f, 0.0), size);
    }
    acc = acc / f32(n);
  }

  // Tick marks and default-value notch on the centerline, clear of the label and readout.
  let clear = clearOfText(p, local.x, size.x);
  let nx = clamp(p.aux.y * size.x, 1.0, size.x - 1.0);
  let tickAlpha = clamp(p.extra.w, 0.0, 1.0);
  let tickCount = p.extra.z;
  if (tickAlpha > 0.01 && tickCount >= 2.0 && clear > 0.0) {
    let span = max(1.0, size.x);
    let u = clamp(local.x / span, 0.0, 1.0);
    let stepU = 1.0 / (tickCount - 1.0);
    let nearestIdx = round(u / stepU);
    let tickX = nearestIdx * stepU * span;
    if (p.aux.z <= 0.005 || abs(tickX - nx) >= 3.0) {
      let dx = abs(local.x - tickX);
      let dy = abs(local.y - size.y * 0.5);
      let tDist = max(dx - 0.5, dy - 3.5);
      let tCov = covSd(tDist) * clear;
      if (tCov > 0.0) {
        let ta = tCov * tickAlpha * 0.22;
        acc = over(acc, vec4f(p.aux2.rgb * ta, ta));
      }
    }
  }

  // Default notch: a slightly taller, brighter centerline tick among the scale ticks.
  if (p.aux.z > 0.005 && clear > 0.0) {
    let nh = select(9.0, 11.0, p.aux.z > 0.8);
    let nCov = covSd(roundedBox(local - vec2f(nx - 0.75, (size.y - nh) * 0.5), vec2f(1.5, nh), 0.75)) * clear;
    let na = nCov * p.aux2.a * p.aux.z;
    acc = over(acc, vec4f(p.aux2.rgb * na, na));
  }

  return acc * trackCov;
}

// Single sample of a morphing pill
fn samplePillAt(p: Prim, local: vec2f, size: vec2f) -> vec4f {
  let r = p.look.x;
  let dist = roundedBox(local, size, r);
  var out = vec4f(0.0);
  if (p.look.z > 0.05 && dist > -1.0 && dist < 14.0) {
    let glow = exp(-max(dist, 0.0) / 4.5) * 0.16 * clamp(p.look.z, 0.0, 1.5) * p.color.a;
    out = vec4f(p.color2.rgb * glow, glow);
  }
  let cov = covSd(dist);
  if (cov <= 0.0) { return out; }
  var pill = premul(p.color) * cov;
  let rimCov = hairline(dist, 1.0);
  pill = over(pill, vec4f(p.color2.rgb * p.color2.a * rimCov, p.color2.a * rimCov));
  return over(out, pill);
}

// kind 3: Morphing pill indicator (preset selector pill, segmented control active pill)
fn shadePill(p: Prim, local: vec2f, size: vec2f, fragPos: vec2f) -> vec4f {
  let blur = p.motion.xy;
  let len = length(blur);
  if (len < 0.6) {
    return samplePillAt(p, local, size);
  }
  let n = clamp(i32(len / 1.8) + 3, 4, 14);
  let j = hash21(fragPos);
  var acc = vec4f(0.0);
  for (var k = 0; k < n; k++) {
    let f = (f32(k) + j) / f32(n) - 0.5;
    acc += samplePillAt(p, local - blur * f, size);
  }
  return acc / f32(n);
}

// kind 4: Toggle switch track + spring-driven thumb with velocity elongation
fn shadeToggle(p: Prim, local: vec2f, size: vec2f) -> vec4f {
  // look.x: the corner radius (--k-round), a capsule at most; look.y: the thumb shadow (--k-lift).
  let r = min(p.look.x, size.y * 0.5);
  let trackDist = roundedBox(local, size, r);
  var out = vec4f(0.0);

  let prog = clamp(p.extra.x, 0.0, 1.0);
  if (prog > 0.05 && p.look.z > 0.05 && trackDist > -1.0 && trackDist < 14.0) {
    let glow = exp(-max(trackDist, 0.0) / 4.2) * 0.22 * prog * clamp(p.look.z, 0.0, 1.5);
    out = over(out, vec4f(p.color.rgb * glow, glow));
  }

  let focus = clamp(p.extra.y, 0.0, 1.0);
  if (focus > 0.005) {
    let ringCov = clamp(0.5 - (abs(trackDist + 0.5) - 0.85) * view.dpr, 0.0, 1.0) * focus;
    out = over(out, vec4f(p.color2.rgb * ringCov, ringCov));
  }

  let trackCov = covSd(trackDist);
  if (trackCov <= 0.0) { return out; }

  out = over(out, premul(p.color) * trackCov);

  // Thumb capsule spanning its two edges (extra.z, extra.w), which stretch it while it travels
  let pad = 2.0;
  let baseD = max(8.0, size.y - pad * 2.0);
  let thumbX = p.extra.z;
  let thumbW = max(baseD, p.extra.w - p.extra.z);
  let tp = local - vec2f(thumbX, pad);
  let tr = min(p.look.x, baseD * 0.5);
  let tDist = roundedBox(tp, vec2f(thumbW, baseD), tr);

  // Subtle thumb drop shadow
  let shDist = roundedBox(tp - vec2f(0.0, 1.0), vec2f(thumbW, baseD), tr);
  let shA = smoothstep(2.0, -0.5, shDist) * 0.25 * p.look.y * trackCov;
  out = over(out, vec4f(0.0, 0.0, 0.0, shA));

  let tCov = covSd(tDist) * trackCov;
  if (tCov > 0.0) {
    out = over(out, premul(p.color2) * tCov);
  }
  return out;
}

fn sampleAtlasAlpha(p: Prim, local: vec2f, size: vec2f) -> f32 {
  if (any(local < vec2f(0.0)) || any(local > size)) { return 0.0; }
  let uv = mix(p.uv.xy, p.uv.zw, local / size);
  return textureSampleLevel(labels, smp, uv, 0.0).a;
}

// kind 5: Native-rasterized atlas text & hint badges with directional motion blur
fn shadeText(p: Prim, local: vec2f, size: vec2f, fragPos: vec2f) -> vec4f {
  let blur = p.motion.xy;
  let len = length(blur);
  var a = 0.0;
  if (len < 0.45) {
    a = sampleAtlasAlpha(p, local, size);
  } else {
    let n = clamp(i32(len / 1.5) + 3, 4, 12);
    let j = hash21(fragPos);
    for (var k = 0; k < n; k++) {
      let f = (f32(k) + j) / f32(n) - 0.5;
      a += sampleAtlasAlpha(p, local - blur * f, size);
    }
    a = a / f32(n);
  }
  let finalA = a * p.color.a;
  return vec4f(p.color.rgb * finalA, finalA);
}

// kind 7: Anti-aliased SDF dot with subtle radial bloom
fn shadeDot(p: Prim, local: vec2f, size: vec2f) -> vec4f {
  let center = size * 0.5;
  let r = min(size.x, size.y) * 0.5;
  let d = length(local - center) - r;
  let cov = covSd(d);
  let glow = exp(-max(d, 0.0) / max(1.2, p.look.z)) * 0.32 * clamp(p.look.z * 0.5, 0.0, 1.0);
  let a = clamp(cov + glow, 0.0, 1.0) * p.color.a;
  return vec4f(p.color.rgb * a, a);
}

// kind 8: Polyline stroke through pts[extra.x .. extra.x + extra.y] (viewport px), look.y wide.
fn shadeLine(p: Prim, screen: vec2f) -> vec4f {
  let start = u32(p.extra.x);
  let count = u32(p.extra.y);
  var d = 1e5;
  for (var i = 1u; i < count; i++) {
    let a = pts[start + i - 1u];
    let b = pts[start + i];
    let ab = b - a;
    let t = clamp(dot(screen - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    d = min(d, length(screen - a - ab * t));
  }
  let a = covSd(d - p.look.y * 0.5) * p.color.a;
  return vec4f(p.color.rgb * a, a);
}

// OKLCH → gamma sRGB, with chroma trimmed until the colour fits (as core/color.ts does).
fn oklchLinear(l: f32, c: f32, h: f32) -> vec3f {
  let a = c * cos(radians(h));
  let b = c * sin(radians(h));
  let l1 = l + 0.3963377774 * a + 0.2158037573 * b;
  let m1 = l - 0.1055613458 * a - 0.0638541728 * b;
  let s1 = l - 0.0894841775 * a - 1.291485548 * b;
  let L = l1 * l1 * l1;
  let M = m1 * m1 * m1;
  let S = s1 * s1 * s1;
  return vec3f(
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S
  );
}
fn fits(rgb: vec3f) -> bool {
  return all(rgb >= vec3f(-1e-4)) && all(rgb <= vec3f(1.0 + 1e-4));
}
fn maxChroma(l: f32, h: f32) -> f32 {
  if (l <= 0.0 || l >= 1.0) { return 0.0; }
  var lo = 0.0;
  var hi = 0.37;
  if (fits(oklchLinear(l, hi, h))) { return hi; }
  for (var i = 0; i < 18; i++) {
    let mid = (lo + hi) * 0.5;
    if (fits(oklchLinear(l, mid, h))) { lo = mid; } else { hi = mid; }
  }
  return lo;
}
fn encode(c: f32) -> f32 {
  let v = clamp(c, 0.0, 1.0);
  return select(1.055 * pow(v, 1.0 / 2.4) - 0.055, 12.92 * v, v <= 0.0031308);
}
fn oklchRgb(l: f32, c: f32, h: f32) -> vec3f {
  let rgb = oklchLinear(l, min(c, maxChroma(l, h)), h);
  return vec3f(encode(rgb.x), encode(rgb.y), encode(rgb.z));
}
fn stripColor(p: Prim, r: f32) -> vec3f {
  let mode = i32(p.extra.x + 0.5);
  if (mode == 0) { return oklchRgb(p.aux.x, p.aux.y, r * 360.0); }
  if (mode == 1) { return oklchRgb(p.aux.x, r * p.aux.w, p.aux.z); }
  return oklchRgb(r, p.aux.y, p.aux.z);
}

// kind 9: OKLCH strip. Like the DOM's gradient: 25 stops, a radius (extra.y) in from each end,
// blended in sRGB; the C strip (mode 1) spans 0 to maxChroma(l, h) (aux.w). color2 rims it.
fn shadeStrip(p: Prim, local: vec2f, size: vec2f) -> vec4f {
  let dist = roundedBox(local, size, size.y * 0.5);
  let cov = covSd(dist);
  if (cov <= 0.0) { return vec4f(0.0); }
  let r = clamp((local.x - p.extra.y) / max(1.0, size.x - p.extra.y * 2.0), 0.0, 1.0);
  let f = r * 24.0;
  let i = min(floor(f), 23.0);
  let rgb = mix(stripColor(p, i / 24.0), stripColor(p, (i + 1.0) / 24.0), f - i);
  var out = vec4f(rgb * p.color.a, p.color.a) * cov;
  out = over(out, premul(p.color2) * hairline(dist, 1.0));
  return out;
}

// kind 10: Plain shape (swatch, thumb, puck, handle): drop shadow, glow, an outer ring
// (look.y > 0) or inner ring (look.y < 0) in color2, fill in color. extra = shadow a, blur, dy.
fn shadeShape(p: Prim, local: vec2f, size: vec2f) -> vec4f {
  let r = p.look.x;
  let d = roundedBox(local, size, r);
  let ring = p.look.y;
  var out = vec4f(0.0);
  let grown = d - max(ring, 0.0);
  if (p.extra.x > 0.0) {
    let sd = roundedBox(local - vec2f(0.0, p.extra.z), size, r) - max(ring, 0.0);
    let sigma = max(0.5, p.extra.y * 0.5);
    let sh = p.extra.x * (1.0 - smoothstep(-sigma * 1.5, sigma * 2.0, sd));
    out = vec4f(0.0, 0.0, 0.0, sh * (1.0 - covSd(grown)));
  }
  // Like box-shadow's blur around a small shape: a faint gaussian (σ = blur / 2).
  if (p.look.z > 0.01 && grown > 0.0) {
    let k = grown / (p.look.z * 0.5);
    let glow = 0.3 * exp(-0.5 * k * k) * p.aux2.a;
    out = over(out, vec4f(p.aux2.rgb * glow, glow));
  }
  if (ring > 0.0) { out = over(out, premul(p.color2) * covSd(grown)); }
  out = over(out, premul(p.color) * covSd(d));
  if (ring < 0.0) {
    let band = clamp(0.5 - (abs(d - ring * 0.5) + ring * 0.5) * view.dpr, 0.0, 1.0);
    out = over(out, premul(p.color2) * band);
  }
  return out;
}

@fragment fn fs_main(in: Out) -> @location(0) vec4f {
  let p = prims[in.id];
  let clipDist = min(
    min(in.screenPx.x - p.clip.x, p.clip.z - in.screenPx.x),
    min(in.screenPx.y - p.clip.y, p.clip.w - in.screenPx.y)
  );
  let clipCov = clamp(clipDist * view.dpr + 0.5, 0.0, 1.0);
  if (clipCov <= 0.0) { return vec4f(0.0); }
  var maskCov = 1.0;
  let mi = u32(p.motion.w) >> 1u;
  if (mi > 0u) {
    let m = masks[mi - 1u];
    maskCov = covSd(roundedBox(in.screenPx - m.rect.xy, m.rect.zw, m.look.x));
    if (m.look.z > m.look.y) {
      maskCov *= clamp((m.look.z - in.screenPx.y) / (m.look.z - m.look.y), 0.0, 1.0);
    }
    if (maskCov <= 0.0) { return vec4f(0.0); }
  }

  let local = in.screenPx - in.rect.xy;
  let size = max(in.rect.zw, vec2f(1.0));
  let kind = i32(p.look.w + 0.5);

  var out = vec4f(0.0);
  switch (kind) {
    case 0: { out = shadePanel(p, local, size); }
    case 1: { out = shadeTrack(p, local, size); }
    case 2: { out = shadeSlider(p, local, size, in.pos.xy); }
    case 3: { out = shadePill(p, local, size, in.pos.xy); }
    case 4: { out = shadeToggle(p, local, size); }
    case 5: {
      out = shadeText(p, local, size, in.pos.xy);
      // Feathered slot for rolling digits: fade toward the clip's top and bottom edges.
      if (p.extra.x > 0.0) {
        let edge = min(in.screenPx.y - p.clip.y, p.clip.w - in.screenPx.y);
        out = out * smoothstep(0.0, p.extra.x, edge);
      }
    }
    case 8: { out = shadeLine(p, in.screenPx); }
    case 9: { out = shadeStrip(p, local, size); }
    case 10: { out = shadeShape(p, local, size); }
    case 11: { out = shadeDie(p, in.rect, in.pos.xy); }
    default: { out = shadeDot(p, local, size); }
  }
  return out * (clipCov * maskCov);
}
`
