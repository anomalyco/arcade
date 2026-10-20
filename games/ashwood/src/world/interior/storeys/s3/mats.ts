import * as THREE from "three/webgpu"
import { abs, atan, cos, exp, float, floor, fract, fwidth, hash, max, mix as tslMix, positionWorld, sin, smoothstep, step, time, uv, vec2, vec3 } from "three/tsl"
import { aaFade, aaLines, aaStep, aaWindow } from "../../api"

// Storey 3's few animated surfaces, one shader each, shared by every instance on the floor (per-instance variation
// comes from a hash of the world position, so all copies merge into one draw):
//   REEL   — a tape reel face (quad, 0..1 UVs): flange with three windows, tape pack, hub; shuttles back and forth.
//   SCOPE  — oscilloscope / analyser CRT (quad): graticule and a green trace, the listening room's heartbeat pulse.
//   CHART  — strip-chart paper (quad): pink grid scrolling down with an ink trace.
//   BLINK  — rows of indicator lamps on equipment panels (world-space dots, each its own rate and colour).
//   STATIC — a television tuned to nothing (quad).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any
const mix = tslMix as N

const seedOf = (): N => hash(floor(positionWorld.mul(2.7)).dot(vec3(1, 57, 113)))

export const REEL = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x444444, roughness: 0.35, metalness: 0.4 })
  const p = uv().sub(0.5).mul(2)
  const r = p.length()
  const h = seedOf()
  // Vacuum-column drives shuttle: a slow drift plus back-and-forth bursts, each drive its own phase.
  const t = time.add(h.mul(40))
  const ang = atan(p.y, p.x).add(sin(t.mul(0.55)).mul(5.5)).add(sin(t.mul(2.3)).mul(0.6)).add(t.mul(h.sub(0.5)))
  const pack = mix(float(0.42), float(0.9), h)
  const windows = aaStep(0.55, cos(ang.mul(3))).mul(aaWindow(r, pack.add(0.02), 0.9))
  const slots = aaStep(0.8, cos(ang.mul(3).add(1))).mul(aaWindow(r, 0.14, 0.24))
  const hubC = vec3(0.55, 0.56, 0.55)
  const flange = vec3(0.18, 0.2, 0.22)
  const tape = vec3(0.07, 0.05, 0.035)
  let c: N = mix(flange, tape, float(1).sub(aaStep(pack, r)).mul(aaStep(0.27, r)))
  c = mix(c, hubC, float(1).sub(aaStep(0.27, r)))
  c = mix(c, vec3(0.02, 0.02, 0.02), max(windows, slots))
  m.colorNode = c
  m.roughnessNode = mix(float(0.3), float(0.7), aaWindow(r, 0.27, 0.95))
  m.metalnessNode = float(1).sub(aaStep(0.27, r)).mul(0.8)
  m.opacityNode = float(1).sub(aaStep(0.97, r))
  m.alphaTest = 0.5
  m.name = "s3_reel"
  return m
})()

export const SCOPE = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x020302, roughness: 0.15 })
  const u = uv()
  const h = seedOf()
  const grat = max(aaLines(u.x.mul(10), 0.04), aaLines(u.y.mul(8), 0.04)).mul(aaFade(u.x.mul(10)))
  const centre = aaWindow(u.y, 0.495, 0.505).mul(0.6)
  // Heartbeat-like pulse train sweeping left to right, slowed and shifted per instrument.
  const ph = fract(u.x.mul(mix(float(1.5), float(3), h)).sub(time.mul(mix(float(0.35), float(0.8), h))).add(h))
  const beat = exp(ph.sub(0.3).mul(38).pow(2).negate()).mul(0.28).sub(exp(ph.sub(0.36).mul(26).pow(2).negate()).mul(0.1))
  const ripple = sin(u.x.mul(90).add(time.mul(7))).mul(0.008)
  const y = float(0.45).add(beat).add(ripple)
  const d = abs(u.y.sub(y))
  const w = fwidth(u.y).mul(1.5).add(0.006)
  const trace = float(1).sub(smoothstep(w.mul(0.3), w, d))
  const halo = exp(d.mul(-38)).mul(0.25)
  const edge = aaWindow(u.x, 0.02, 0.98).mul(aaWindow(u.y, 0.03, 0.97))
  m.emissiveNode = vec3(0.25, 1.0, 0.45).mul(trace.mul(1.6).add(halo).add(grat.mul(0.06)).add(centre.mul(0.04))).add(vec3(0.004, 0.012, 0.006)).mul(edge).mul(1.4)
  m.name = "s3_scope"
  return m
})()

export const CHART = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0xd6d2c2, roughness: 0.9 })
  const u = uv()
  const h = seedOf()
  // Paper feeds down (v increases with time); grid fixed to the paper.
  const v = u.y.add(time.mul(0.02))
  const grid = max(aaLines(u.x.mul(20), 0.05), aaLines(v.mul(30), 0.05)).mul(aaFade(v.mul(30)))
  const major = max(aaLines(u.x.mul(4), 0.03), aaLines(v.mul(6), 0.03)).mul(aaFade(v.mul(6)))
  const ph = fract(v.mul(2.2).add(h))
  const beat = exp(ph.sub(0.4).mul(30).pow(2).negate()).mul(0.22).sub(exp(ph.sub(0.46).mul(24).pow(2).negate()).mul(0.08))
  const x = float(0.5).add(beat).add(sin(v.mul(70)).mul(0.006))
  const ink = float(1).sub(smoothstep(0.004, 0.012, abs(u.x.sub(x))))
  const paper = vec3(0.78, 0.76, 0.68)
  const pink = vec3(0.72, 0.48, 0.48)
  m.colorNode = mix(mix(mix(paper, pink, grid.mul(0.35)), pink, major.mul(0.5)), vec3(0.08, 0.1, 0.25), ink)
  m.name = "s3_chart"
  return m
})()

export const BLINK = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x050505, roughness: 0.4 })
  const q = positionWorld.mul(45)
  const c = floor(q)
  const qa = q.x.add(q.z)
  const dot = aaWindow(fract(qa), 0.22, 0.78).mul(aaWindow(fract(q.y), 0.22, 0.78)).mul(aaFade(qa)).add(float(0.31).mul(float(1).sub(aaFade(qa))))
  const h = hash(c.x.add(c.y.mul(31)).add(c.z.mul(17)))
  const blink = step(0.45, fract(time.mul(h.mul(1.8).add(0.15)).add(h.mul(10))))
  const colour = mix(mix(vec3(1, 0.42, 0.08), vec3(0.35, 1, 0.4), step(0.6, h)), vec3(1, 0.12, 0.06), step(0.92, h))
  // Per-lamp colour and blink are hashed per cell: once a lamp is under a pixel (seen across a room or through glass)
  // that turned into rainbow confetti under TAA jitter. Fade to the panel's average glow instead (filtered on all axes).
  const fine = aaFade(qa).mul(aaFade(q.y)).mul(aaFade(qa.mul(4))).mul(aaFade(q.y.mul(4)))
  const lit = colour.mul(blink).mul(step(0.22, h)).mul(dot)
  const average = vec3(0.62, 0.55, 0.2).mul(0.5 * 0.78 * 0.31)
  m.emissiveNode = mix(average, lit, fine).mul(2.4)
  m.name = "s3_blink"
  return m
})()

export const STATIC = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x0a0c0c, roughness: 0.25 })
  const cell = floor(uv().mul(vec2(64, 48)))
  const frame = floor(time.mul(24))
  const n = hash(cell.x.add(cell.y.mul(157)).add(frame.mul(911)))
  const roll = sin(uv().y.mul(7).add(time.mul(2.4))).mul(0.12).add(0.88)
  const grain = mix(float(0.55), n, aaFade(uv().x.mul(64)))
  m.emissiveNode = vec3(0.7, 0.78, 0.9).mul(grain.mul(0.8).add(0.2)).mul(roll).mul(0.9)
  m.name = "s3_static"
  return m
})()

/** Green-phosphor terminal screen (quad, 0..1 UVs): 24 rows of text that scroll a line every few seconds, a blinking
 *  block cursor, scanlines and a dark rounded edge. Glyphs fade to their average brightness when sub-pixel. */
export const TEXT = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x030403, roughness: 0.12 })
  const u = uv()
  const h = seedOf()
  const rows = 24
  const cols = 64
  const scroll = floor(time.mul(mix(float(0.15), float(0.4), h)).add(h.mul(50)))
  const p = vec2(u.x.mul(cols), float(1).sub(u.y).mul(rows))
  const cell = floor(p)
  const line = cell.y.add(scroll)
  // Each line has its own length and indent; a few lines blank.
  const len = hash(line.mul(13.1).add(h.mul(97))).mul(cols * 0.9)
  const indent = step(0.7, hash(line.mul(3.7).add(h))).mul(4)
  const blank = step(0.82, hash(line.mul(7.3).add(h.mul(31))))
  const inLine = step(indent, cell.x).mul(step(cell.x, len)).mul(float(1).sub(blank))
  // Word gaps, then a 3 × 5 glyph inside each character cell.
  const word = step(0.16, hash(cell.x.mul(1.7).add(line.mul(57.3)).add(h.mul(11))))
  const f = fract(p)
  const g = floor(vec2(f.x.mul(4), f.y.mul(7)))
  const inGlyph = step(0.5, g.x).mul(step(g.x, 3.5)).mul(step(0.5, g.y)).mul(step(g.y, 5.5))
  const bit = step(0.45, hash(g.x.add(g.y.mul(5)).add(cell.x.mul(31)).add(line.mul(173))))
  const glyphs = mix(float(0.32), bit.mul(inGlyph), aaFade(p.x.mul(4)))
  const text = inLine.mul(word).mul(glyphs)
  // Cursor on the last line.
  const lastRow = step(rows - 1.5, cell.y)
  const cursor = lastRow.mul(step(float(1), cell.x)).mul(step(cell.x, 1.5)).mul(step(0.5, fract(time.mul(1.6))))
  const scan = mix(float(0.86), sin(u.y.mul(rows * 7 * Math.PI)).mul(0.14).add(0.86), aaFade(u.y.mul(rows * 3.5)))
  const vign = aaWindow(u.x, 0.025, 0.975).mul(aaWindow(u.y, 0.03, 0.97))
  const e = max(text, cursor).mul(scan).add(0.035)
  m.emissiveNode = vec3(0.3, 1.0, 0.42).mul(e).mul(vign).mul(1.3)
  m.name = "s3_text"
  return m
})()

/** A pen-plotter sheet (quad): contour lines of a site plan on white paper, a grid, and one red ring drawn round a
 *  spot north of a rectangle (the building) — the north lot. Static. */
export const PLOT = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0xd9d6ca, roughness: 0.92 })
  const u = uv()
  const c = u.sub(vec2(0.42, 0.38))
  const r = c.length()
  // Wobbly contours round a low hill.
  const field = r.mul(26).add(sin(c.x.mul(17).add(c.y.mul(9))).mul(0.9)).add(sin(c.y.mul(23)).mul(0.5))
  const contours = aaLines(field, 0.06).mul(aaFade(field))
  const grid = max(aaLines(u.x.mul(10), 0.012), aaLines(u.y.mul(7), 0.012)).mul(aaFade(u.x.mul(10)))
  const bx = aaWindow(u.x, 0.55, 0.78).mul(aaWindow(u.y, 0.62, 0.72))
  const bxIn = aaWindow(u.x, 0.556, 0.774).mul(aaWindow(u.y, 0.628, 0.712))
  const building = bx.sub(bxIn).max(0)
  const ring = abs(u.sub(vec2(0.66, 0.42)).length().sub(0.09))
  const red = float(1).sub(smoothstep(0.004, 0.009, ring))
  const ink = max(contours.mul(0.75), max(grid.mul(0.3), building))
  const paper = vec3(0.8, 0.79, 0.74)
  m.colorNode = mix(mix(paper, vec3(0.1, 0.13, 0.3), ink), vec3(0.55, 0.06, 0.05), red)
  m.name = "s3_plot"
  return m
})()
