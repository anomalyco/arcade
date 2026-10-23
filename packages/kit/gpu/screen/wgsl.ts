/**
 * WGSL for the shared screen display. Two stages:
 *
 * 1. Signal (`SIGNAL_WGSL`, offscreen at the signal's own size): the source picture, fitted, decoded from its video
 *    gamma to linear light, buried in snow as the signal weakens, held up by phosphor afterglow; then a mip chain
 *    (`MIP_WGSL`) that feeds the tube's halation and the light probe.
 * 2. Tube (`screenTubeWgsl`, per fragment where the screen is drawn): the raster bowed on the curved tube, Gaussian
 *    scanline beams that widen when bright, misconverged guns, the phosphor mask fixed to the glass (filtered by the
 *    pixel footprint so it never moirés), halation, vignette, the power and degauss animations; or an LCD's pixel grid,
 *    backlight bleed and viewing-angle loss. Light is linear throughout; the output is HDR emission.
 *
 * The tube functions only need the display's own bindings (`screenBindingsWgsl`), so any renderer can include them:
 * the kit's quad pass (`display.ts`) adds the glass lighting from the kit's lights, a game with its own renderer adds
 * its own.
 *
 * Technique after Timothy Lottes' public-domain CRT shader (raster warp, Gaussian scanlines, mask layouts), with the
 * brightness-dependent beam, halation and convergence documented for crt-royale and guest-advanced; none of their GPL
 * code. Mask filtering by screen-space footprint is the standard procedural-texture anti-aliasing (Ebert et al.).
 */

/** The `Display` uniform (see `packDisplayUniform`). */
export const displayStructWgsl = /* wgsl */ `
struct Display {
  a: vec4f,     // time s, dt s, kind (0 CRT, 1 LCD), peak white × power level
  sig: vec4f,   // signal width, height, source linear (1) or video gamma (0), signal strength (1 clean, 0 snow)
  fit: vec4f,   // source uv = signal uv × xy + zw
  t0: vec4f,    // scanlines, gap depth, beam widening, sharpness
  t1: vec4f,    // mask type, mask strength, triads across, raster bow
  t2: vec4f,    // convergence, glow, vignette, overscan
  t3: vec4f,    // corner radius, face aspect, -, -
  g0: vec4f,    // glass reflections, face grey, bulge m, room reflection
  p0: vec4f,    // raster width, raster height, dot brightness, power level
  dg: vec4f,    // degauss wobble, purity, seconds since, -
  lcd: vec4f,   // pixel grid, backlight bleed, viewing-angle loss, pixels across
  dec: vec4f,   // afterglow kept per frame r, g, b, smudge
  light: vec4f, // average emitted radiance rgb (scene units), -
}
`

/** Declares the display's uniform, signal texture (with mips) and sampler at `group`, bindings `base`..`base + 2`. */
export function screenBindingsWgsl(group: number, base = 0): string {
  return `${displayStructWgsl}
@group(${group}) @binding(${base}) var<uniform> D: Display;
@group(${group}) @binding(${base + 1}) var screenSignal: texture_2d<f32>;
@group(${group}) @binding(${base + 2}) var screenSamp: sampler;
`
}

const FULLSCREEN_VS = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VSOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
`

const HASH = /* wgsl */ `
fn scrPcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn scrHash(x: f32, y: f32, z: u32) -> f32 {
  return f32(scrPcg(bitcast<u32>(i32(floor(x))) ^ scrPcg(bitcast<u32>(i32(floor(y))) ^ scrPcg(z)))) / 4294967295.0;
}
fn scrNoise(p: vec2f, z: u32) -> f32 {
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(scrHash(p.x, p.y, z), scrHash(p.x + 1.0, p.y, z), s.x), mix(scrHash(p.x, p.y + 1.0, z), scrHash(p.x + 1.0, p.y + 1.0, z), s.x), s.y);
}
`

/**
 * Signal stage: one fullscreen pass at the signal's size. Group 0: Display (0), source (1), last frame's signal (2),
 * sampler (3). Writes linear rgba16float.
 */
export const SIGNAL_WGSL = `${displayStructWgsl}
@group(0) @binding(0) var<uniform> D: Display;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var prevTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
${FULLSCREEN_VS}
${HASH}
@fragment fn fs(v: VSOut) -> @location(0) vec4f {
  let size = D.sig.xy;
  let uv = v.pos.xy / size;
  let suv = uv * D.fit.xy + D.fit.zw;
  var c = textureSampleLevel(srcTex, samp, clamp(suv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  // Video is gamma-encoded; the tube's response (BT.1886, gamma 2.4) turns it back into light.
  if (D.sig.z < 0.5) { c = pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(2.4)); }
  // A weak signal: the picture sinks into snow, streaked along the line, and loses its colour first.
  let strength = D.sig.w;
  if (strength < 0.999) {
    let tick = u32(D.a.x * 60.0);
    let x = v.pos.x / 1.6;
    let n = mix(scrHash(x, v.pos.y, tick), scrHash(x + 1.0, v.pos.y, tick), fract(x));
    let snow = vec3f(pow(n, 2.2) * 0.55 + scrHash(v.pos.x, v.pos.y, tick + 7u) * 0.08);
    let y = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let faded = mix(vec3f(y), c, smoothstep(0.35, 0.9, strength)) * strength * strength;
    c = faded + snow * (1.0 - strength);
  }
  // Phosphor afterglow: what the beam lit last frame is still fading.
  let prev = textureLoad(prevTex, vec2i(v.pos.xy), 0).rgb;
  c = max(c, prev * D.dec.xyz);
  return vec4f(c, 1.0);
}
`

/** One mip level from the level above (a 2×2 box through the bilinear sampler). */
export const MIP_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
${FULLSCREEN_VS}
@fragment fn fs(v: VSOut) -> @location(0) vec4f {
  let size = max(vec2f(textureDimensions(src)) * 0.5, vec2f(1.0));
  return textureSampleLevel(src, samp, v.pos.xy / floor(size), 0.0);
}
`

/** Copies a source into the VHS filter's input, re-encoding linear sources to video gamma. */
export const BLIT_WGSL = `${displayStructWgsl}
@group(0) @binding(0) var<uniform> D: Display;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
${FULLSCREEN_VS}
@fragment fn fs(v: VSOut) -> @location(0) vec4f {
  let uv = v.pos.xy / D.sig.xy * D.fit.xy + D.fit.zw;
  var c = textureSampleLevel(srcTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  if (D.sig.z > 0.5) { c = pow(clamp(c / (1.0 + c), vec3f(0.0), vec3f(1.0)) * 2.0, vec3f(1.0 / 2.4)); }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`

/**
 * The tube, given the display bindings (`screenBindingsWgsl`). `face` runs 0..1 across the visible glass, y down;
 * `fw` is `fwidth(face)`, taken by the caller in uniform control flow; `viewCos` is the cosine between the view and
 * the glass normal (1 head-on). Returns linear HDR emission.
 */
export const screenTubeWgsl = `${HASH}
fn scrS(uv: vec2f, lod: f32) -> vec3f { return textureSampleLevel(screenSignal, screenSamp, uv, lod).rgb; }
fn scrLum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

/** Coverage of the visible face: a rounded rectangle, anti-aliased by the footprint. */
fn screenFaceMask(face: vec2f, fw: vec2f) -> f32 {
  let a = vec2f(D.t3.y, 1.0);
  let r = max(D.t3.x, 1e-4);
  let q = abs(face * 2.0 - 1.0) * a - (a - r);
  let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
  let px = max(fw.y * 2.0, 1e-4);
  return 1.0 - smoothstep(-px, px, d);
}

/** Face position (-1..1) to signal uv, after the raster's bow, the degauss shake, overscan and the power collapse. */
fn screenRasterUv(p0: vec2f) -> vec2f {
  var p = p0;
  let k = D.t1.w;
  p = p * vec2f(1.0 + p.y * p.y * 0.075 * k, 1.0 + p.x * p.x * 0.11 * k);
  let w = D.dg.x;
  if (w > 0.0) {
    let t = D.dg.z;
    p += w * vec2f(sin(t * 47.0 + p.y * 6.0) + 0.5 * sin(t * 83.0), cos(t * 39.0 + p.x * 5.0)) * 0.035;
  }
  p = p * (1.0 - 2.0 * D.t2.w) / max(D.p0.xy, vec2f(1e-4));
  return p * 0.5 + 0.5;
}

/** Phosphor layout fixed to the glass at \`face\`, normalised to an average of 1 and faded by the pixel footprint. */
fn screenMask(face: vec2f, fw: vec2f) -> vec3f {
  let kind = D.t1.x;
  let pitch = D.t1.z;
  let aspect = D.t3.y;
  var w = vec3f(0.0);
  var foot = fw.x * pitch;
  if (kind < 1.5) {
    // Stripes (grille), cut into staggered slots for the slot mask. Units: triads across, square cells down.
    let m = face * vec2f(pitch, pitch / aspect);
    let sigma = 0.085;
    for (var c = 0; c < 3; c++) {
      let d = fract(m.x - (f32(c) + 0.5) / 3.0 + 0.5) - 0.5;
      w[c] = exp(-0.5 * d * d / (sigma * sigma)) / (sigma * 2.5066);
    }
    if (kind > 0.5) {
      let col = floor(m.x);
      let y = fract(m.y * 0.5 + (col % 2.0) * 0.5);
      w *= mix(0.15, 1.0, smoothstep(0.0, 0.08, y) * smoothstep(0.0, 0.08, 1.0 - y)) / 0.85;
      foot = max(foot, fw.y * pitch / aspect * 0.5);
    }
  } else {
    // Delta triads on a hexagonal lattice: dots one spacing s = 1/3 triad apart along a row, rows 0.866 s apart and
    // shifted half a triad, so each R, G, B forms a triangle. Units of s.
    let rows = pitch * 3.0 / (aspect * 0.866);
    let row = floor(face.y * rows);
    let fy = (fract(face.y * rows) - 0.5) * 0.866;
    let shift = (row % 2.0) * 0.5;
    let sigma = 0.3;
    for (var c = 0; c < 3; c++) {
      let dx = (fract(face.x * pitch - shift - (f32(c) + 0.5) / 3.0 + 0.5) - 0.5) * 3.0;
      let d2 = dx * dx + fy * fy;
      w[c] = exp(-0.5 * d2 / (sigma * sigma)) / (6.2832 * sigma * sigma / 2.598);
    }
    foot = max(foot * 3.0, fw.y * rows) / 3.0;
  }
  let strength = D.t1.y * (1.0 - smoothstep(0.28, 0.6, foot));
  if (strength <= 0.001 || kind > 2.5) { return vec3f(1.0); }
  return mix(vec3f(1.0), w, strength);
}

/** The CRT: scanline beams, convergence, mask, halation, vignette, degauss purity and the power dot. */
fn screenCrt(face: vec2f, fw: vec2f) -> vec3f {
  let p = face * 2.0 - 1.0;
  let uv = screenRasterUv(p);
  let lines = D.t0.x;
  let size = D.sig.xy;
  let scale = max(D.p0.xy, vec2f(1e-4));
  // The raster squeezed by the power animation concentrates the same beam current: a line, then a dot, glows bright.
  let squeeze = min(1.0 / (scale.x * scale.y), 40.0);
  let edge = max(fw / scale * 1.5, vec2f(1e-5));
  let inside = smoothstep(vec2f(0.0), edge, uv) * smoothstep(vec2f(0.0), edge, 1.0 - uv);
  var c = vec3f(0.0);
  if (inside.x * inside.y > 0.0) {
    let footLines = fw.y * lines / scale.y;
    let y = uv.y * lines - 0.5;
    let row = floor(y);
    let f = y - row;
    // Horizontal bandwidth: softer signal reads from a coarser mip, and minification picks its own.
    let lod = (1.0 - D.t0.w) * 1.5 + max(log2(fw.x * size.x / scale.x), 0.0);
    let r2 = dot(p, p);
    let conv = D.t2.x * (0.6 + r2) * 1.6 / size.x;
    var beam = vec3f(0.0);
    var plain = vec3f(0.0);
    for (var j = 0; j < 2; j++) {
      let ly = (row + f32(j) + 0.5) / lines;
      let col = vec3f(
        scrS(vec2f(uv.x + conv, ly + conv * 0.4), lod).r,
        scrS(vec2f(uv.x, ly), lod).g,
        scrS(vec2f(uv.x - conv, ly - conv * 0.3), lod).b,
      );
      // A Gaussian beam per line, wider where brighter; normalised so the line's light is kept.
      let sigma = mix(vec3f(0.17), vec3f(0.48), clamp(sqrt(col) * D.t0.z * 1.2, vec3f(0.0), vec3f(1.0)));
      let d = f - f32(j);
      beam += col * exp(-0.5 * d * d / (sigma * sigma)) / (sigma * 2.5066);
      plain += col * select(f, 1.0 - f, j == 0);
    }
    // Lines finer than about two pixels fade to their average rather than alias.
    c = mix(plain, beam, D.t0.y * (1.0 - smoothstep(0.3, 0.6, footLines)));
    let g = D.t2.y;
    if (g > 0.001) {
      c += (scrS(uv, 3.5) * 0.55 + scrS(uv, 5.5) * 0.45) * g * 0.35;
    }
    c *= inside.x * inside.y;
  }
  // Degauss: rainbow blotches that swirl and settle.
  let pur = D.dg.y;
  if (pur > 0.001) {
    let t = D.dg.z;
    let q = p * 1.3 + vec2f(sin(t * 2.1), cos(t * 1.7)) * 0.6;
    let blot = vec3f(scrNoise(q * 1.7 + 3.0, 1u), scrNoise(q * 1.7 + 11.0, 2u), scrNoise(q * 1.7 + 19.0, 3u)) - 0.5;
    c *= max(vec3f(0.0), 1.0 + blot * pur * 2.4);
    c += max(blot, vec3f(0.0)) * pur * 0.06 * D.a.w;
  }
  let a = vec2f(D.t3.y, 1.0);
  c *= screenMask(face, fw);
  // Trinitron-style damper wires: two faint horizontal lines across a grille.
  if (D.t1.x < 0.5 && D.t1.y > 0.0) {
    let wire = min(abs(face.y - 0.333), abs(face.y - 0.667)) / max(fw.y, 1e-5);
    c *= 1.0 - 0.35 * D.t1.y * (1.0 - smoothstep(0.0, 1.0, wire));
  }
  c *= 1.0 - D.t2.z * 0.6 * smoothstep(0.35, 1.25, length(p * vec2f(1.0, 0.9)));
  var e = c * D.a.w * squeeze;
  // The spot left when the raster has collapsed.
  let dot = D.p0.z;
  if (dot > 0.0) {
    let r = length(p * a);
    e += vec3f(0.85, 0.92, 1.0) * dot * (exp(-r * r * 900.0) * 6.0 + exp(-r * r * 60.0) * 0.4);
  }
  return e;
}

/** The LCD: pixels at their centres up close, the RGB stripes and black matrix, backlight bleed, viewing-angle loss. */
fn screenLcd(face: vec2f, fw: vec2f, viewCos: f32) -> vec3f {
  let px = D.lcd.w;
  let res = vec2f(px, px / D.t3.y);
  let cell = face * res;
  let foot = fw.x * px;
  let centre = (floor(cell) + 0.5) / res;
  let lod = (1.0 - D.t0.w) * 0.8 + max(log2(fw.x * D.sig.x), 0.0);
  var c = mix(scrS(centre, 0.0), scrS(face, lod), smoothstep(0.45, 1.0, foot));
  let g = D.t2.y;
  if (g > 0.001) { c += scrS(face, 4.5) * g * 0.2; }
  // Subpixel stripes with dark gaps and the black matrix, faded out by the footprint so they never moiré.
  let grid = D.lcd.x * (1.0 - smoothstep(0.25, 0.55, foot));
  if (grid > 0.001) {
    let f = fract(cell);
    let sub = f.x * 3.0;
    let s = fract(sub);
    let open = smoothstep(0.0, 0.12, s) * smoothstep(0.0, 0.12, 1.0 - s) * smoothstep(0.0, 0.08, f.y) * smoothstep(0.0, 0.08, 1.0 - f.y);
    let k = floor(sub);
    let stripe = vec3f(select(0.0, 1.0, k < 0.5), select(0.0, 1.0, k > 0.5 && k < 1.5), select(0.0, 1.0, k > 1.5)) * 3.0 * open / 0.72;
    c *= mix(vec3f(1.0), stripe, grid);
  }
  let p = face * 2.0 - 1.0;
  c *= 1.0 - D.t2.z * 0.25 * smoothstep(0.5, 1.4, length(p));
  var e = c * D.a.w;
  // The backlight leaks at the edges and corners; it shows in the dark parts of the picture.
  let edge = max(abs(p.x), abs(p.y));
  let bleed = D.lcd.y * (smoothstep(0.82, 1.0, edge) * 0.03 + 0.006 + 0.02 * scrNoise(p * vec2f(3.0, 2.0) + 5.0, 9u) * smoothstep(0.6, 1.0, edge));
  e += vec3f(0.85, 0.9, 1.0) * bleed * D.a.w;
  // Off axis the panel loses contrast and its gamma washes out.
  let off = D.lcd.z * pow(1.0 - clamp(viewCos, 0.0, 1.0), 1.5);
  e = mix(e, pow(max(e, vec3f(0.0)) / max(D.a.w, 1e-4), vec3f(0.6)) * D.a.w * 0.55 + 0.01 * D.a.w, clamp(off, 0.0, 0.85));
  return e;
}

/** The picture's emission at a point on the glass. */
fn screenTube(face: vec2f, fw: vec2f, viewCos: f32) -> vec3f {
  if (D.a.z > 0.5) { return screenLcd(face, fw, viewCos); }
  return screenCrt(face, fw);
}

/** Schlick Fresnel of the faceplate (n ≈ 1.52) at \`cosv\`, scaled by the reflections knob. */
fn screenFresnel(cosv: f32) -> f32 {
  let x = 1.0 - clamp(cosv, 0.0, 1.0);
  return (0.04 + 0.96 * x * x * x * x * x) * D.g0.x;
}
`

/**
 * The room as a box (`min`, `max`, world metres, from the inside) seen in the glass along `R` from `p`: walls lit by
 * the screen's own average light (`D.light`) and a little ambient, floor and ceiling a shade darker, so the corners read
 * as a room. `screen` is the glass centre and `n` its normal.
 */
export const screenRoomWgsl = /* wgsl */ `
fn screenRoom(p: vec3f, R: vec3f, roomMin: vec3f, roomMax: vec3f, screen: vec3f, n: vec3f, area: f32, ambient: vec3f, albedo: f32) -> vec3f {
  let far = select(roomMin, roomMax, R > vec3f(0.0));
  let tt = (far - p) / select(R, vec3f(1e-6), abs(R) < vec3f(1e-6));
  let t = max(min(tt.x, min(tt.y, tt.z)), 0.05);
  let hit = p + R * t;
  // Which face: floor and ceiling darker, walls lit.
  let span = max(roomMax - roomMin, vec3f(1e-3));
  let rel = (hit - roomMin) / span;
  var shade = 1.0;
  if (rel.y < 0.01) { shade = 0.55; } else if (rel.y > 0.99) { shade = 0.7; }
  let toHit = hit - screen;
  let d2 = max(dot(toHit, toHit), 0.04);
  let cosE = max(dot(normalize(toHit), n), 0.0);
  // Irradiance from the screen as a small area light, cosine at the wall taken as an average 0.6.
  let e = D.light.rgb * area * cosE * 0.6 / d2 + ambient;
  return e * albedo * shade / 3.14159265;
}
`

/**
 * Full-screen display (`ScreenFinalPass`): the tube fills the view inside a dark bezel. Group 0: the display bindings
 * plus `Q` (bezel margin, aspect, -, -) at binding 3.
 */
export const FULLSCREEN_WGSL = `${screenBindingsWgsl(0, 0)}
struct ScreenFull { a: vec4f }
@group(0) @binding(3) var<uniform> Q: ScreenFull;
${FULLSCREEN_VS}
${screenTubeWgsl}
@fragment fn fs(v: VSOut) -> @location(0) vec4f {
  let size = Q.a.zw;
  let uv = v.pos.xy / size;
  let margin = Q.a.x;
  let face = (uv - 0.5) / (1.0 - 2.0 * margin) + 0.5;
  let fw = fwidth(face);
  let mask = screenFaceMask(face, fw);
  var c = vec3f(0.0);
  if (mask > 0.0) {
    c = screenTube(clamp(face, vec2f(0.0), vec2f(1.0)), fw, 1.0) * mask;
  }
  // Glass: the grey phosphor face under the room's light, a soft window highlight high on the left, the room
  // faintly lit by the picture.
  let p = face * 2.0 - 1.0;
  let hp = (face - vec2f(0.24, 0.2)) * vec2f(Q.a.y, 1.0);
  let glass = (vec3f(0.0016, 0.0018, 0.002) * D.g0.y * 20.0 + vec3f(0.02, 0.022, 0.024) * exp(-dot(hp, hp) * 10.0) * D.g0.x
    + D.light.rgb * 0.02 * D.g0.w * (1.0 - 0.5 * length(p))) * mask;
  // Plastic bezel catching a little of the picture near its edge.
  let bezel = (vec3f(0.006, 0.0058, 0.0055) + D.light.rgb * 0.03) * (1.0 - mask);
  let hdr = c + glass + bezel;
  // Display-referred output: a gentle shoulder, then sRGB.
  let ldr = hdr / (1.0 + hdr * 0.15);
  let x = clamp(ldr, vec3f(0.0), vec3f(1.0));
  let srgb = select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
  return vec4f(srgb, 1.0);
}
`
