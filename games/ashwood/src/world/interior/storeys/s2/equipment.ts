import * as THREE from "three/webgpu"
import { type Builder, CEIL_Y, FLOOR_Y, M, T } from "../../api"
import { F, GL, GLASS, type K, P, pt } from "./props"

// Storey 2 lab equipment, procedural (no library model exists): biosafety cabinet, CO₂ incubators, glovebox isolator,
// autoclaves, glasswasher, darkroom enlarger and sink, electron microscope, chart recorder, GC and AA spectrometers.
// Frames: (x, z) on the floor, front faces local −Z, back at +Z against the wall; colliders included.

const mul = (m: THREE.Matrix4, n: THREE.Matrix4) => m.clone().multiply(n)
const coll = (b: Builder, m: THREE.Matrix4, w: number, h: number, d: number, ox = 0, oz = 0) => b.collideLocal(m, [ox - w / 2, 0, oz - d / 2], [ox + w / 2, h, oz + d / 2])

/** Class II biosafety cabinet on its stand. `uv` lights the violet germicidal tube (registers its lamp). */
export function biosafetyCabinet(b: Builder, x: number, z: number, yaw: number, uv: boolean) {
  const m = F(x, z, yaw)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxM(M.darkSteel, m, 0.05, 0.66, 0.05, sx * 0.68, 0.33, sz * 0.32)
  b.boxM(M.darkSteel, m, 1.4, 0.04, 0.04, 0, 0.2, 0.32)
  b.rbox(P.enamel, m, 1.5, 0.14, 0.82, 0.012, 0, 0.73, 0)
  for (const sx of [-1, 1]) b.rbox(P.enamel, m, 0.08, 1.16, 0.82, 0.012, sx * 0.71, 1.38, 0)
  b.boxM(P.enamel, m, 1.42, 1.16, 0.06, 0, 1.38, 0.38)
  b.rbox(P.enamel, m, 1.5, 0.38, 0.82, 0.02, 0, 2.15, 0)
  b.boxM(P.stainless, m, 1.34, 0.02, 0.66, 0, 0.81, 0.02)
  b.boxM(P.stainless, m, 1.34, 1.1, 0.01, 0, 1.36, 0.345)
  b.boxM(P.stainless, m, 1.36, 0.06, 0.12, 0, 0.84, -0.35)
  // Sash: glass tilted back 10°, steel frame on its sides and top.
  const sash = mul(m, T(0, 1.47, -0.37, 0, 0.17))
  b.quad(GLASS, mul(sash, T(0, 0, 0, Math.PI)), 1.36, 0.92, { cast: false })
  b.boxM(P.stainless, sash, 1.4, 0.04, 0.03, 0, 0.46, 0)
  b.boxM(P.stainless, sash, 1.4, 0.05, 0.03, 0, -0.46, 0)
  b.rod(M.steel, pt(sash, -0.4, -0.5, -0.03), pt(sash, 0.4, -0.5, -0.03), 0.01, 6)
  b.boxM(P.dark, m, 1.3, 0.12, 0.004, 0, 2.12, -0.412, { cast: false })
  b.boxM(uv ? GL.ledGreen : M.hazardOff, m, 0.02, 0.02, 0.003, -0.5, 2.12, -0.4195, { cast: false })
  b.boxM(uv ? GL.uv : M.diffuserOff, m, 0.1, 0.03, 0.003, 0.45, 2.12, -0.4195, { cast: false })
  b.cyl("metal_galvanized", T(...pt(m, 0, 2.34, 0.1)).multiply(T(0, (CEIL_Y - 2.34 - FLOOR_Y) / 2, 0)), 0.12, 0.12, CEIL_Y - FLOOR_Y - 2.34, 14)
  if (uv) {
    b.boxM(GL.uv, m, 1.2, 0.022, 0.022, 0, 1.9, -0.05, { cast: false })
    b.boxM(GL.uv, m, 1.3, 0.003, 0.6, 0, 0.822, 0.02, { cast: false })
    const p = pt(m, 0, 1.75, -0.2)
    b.lamp({ kind: "fluorescent", position: p, direction: [0, -1, 0], color: [0.42, 0.18, 1.0], intensity: 16, range: 5.5, angle: 1.45, penumbra: 0.9, size: 0.6 })
  }
  coll(b, m, 1.5, 2.34, 0.82)
}

/** Two stacked CO₂ incubators on a low stand, amber readouts. */
export function incubatorStack(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.boxM(M.darkSteel, m, 0.7, 0.2, 0.68, 0, 0.1, 0)
  for (const [y, on] of [[0.2, true], [1.06, true]] as const) {
    b.rbox(P.enamel, m, 0.72, 0.84, 0.74, 0.02, 0, y + 0.42, 0)
    b.rbox(P.enamel, m, 0.62, 0.62, 0.03, 0.01, -0.02, y + 0.4, -0.38)
    b.boxM(M.steel, m, 0.03, 0.2, 0.03, 0.25, y + 0.4, -0.41)
    b.boxM(P.dark, m, 0.6, 0.11, 0.004, 0, y + 0.78, -0.372, { cast: false })
    b.boxM(on ? GL.amber : M.hazardOff, m, 0.12, 0.035, 0.002, -0.15, y + 0.78, -0.375, { cast: false })
    b.boxM(GL.ledGreen, m, 0.01, 0.01, 0.002, 0.2, y + 0.78, -0.375, { cast: false })
  }
  coll(b, m, 0.72, 1.9, 0.74)
  b.rod(M.steel, pt(m, 0.2, 1.9, 0.3), pt(m, 0.2, CEIL_Y - FLOOR_Y, 0.3), 0.006, 5)
}

/** Floor-standing centrifuge (domed lid, panel). */
export function centrifuge(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(P.enamel, m, 0.7, 0.86, 0.75, 0.04, 0, 0.43, 0)
  b.cyl(P.enamel, mul(m, T(0, 0.88, 0.05)), 0.28, 0.3, 0.05, 24)
  b.boxM(P.blueGrey, m, 0.6, 0.2, 0.08, 0, 0.8, -0.34)
  b.boxM(P.dark, m, 0.3, 0.07, 0.004, -0.1, 0.82, -0.381, { cast: false })
  b.boxM(GL.red, m, 0.08, 0.025, 0.002, -0.15, 0.82, -0.384, { cast: false })
  b.cyl(P.dark, mul(m, T(0.18, 0.82, -0.385, 0, Math.PI / 2)), 0.03, 0.03, 0.02, 12)
  coll(b, m, 0.7, 0.91, 0.75)
}

/**
 * Glovebox isolator on a stand: steel body, sloped window with four glove ports. One glove has been torn and pulled
 * out through its port, hanging inside out (vignette 2-10). The isolator's own tube lights the cabinet.
 */
export function isolator(k: K, x: number, z: number, yaw: number) {
  const b = k.b
  const m = F(x, z, yaw)
  const W = 2.0
  for (const sx of [-1, 0, 1]) for (const sz of [-1, 1]) b.boxM(M.darkSteel, m, 0.05, 0.8, 0.05, sx * 0.94, 0.4, sz * 0.38)
  b.boxM(M.darkSteel, m, W - 0.1, 0.04, 0.04, 0, 0.18, -0.38)
  b.boxM(M.darkSteel, m, W - 0.1, 0.04, 0.04, 0, 0.18, 0.38)
  b.rbox(P.stainless, m, W, 0.1, 0.86, 0.02, 0, 0.85, 0)
  b.rbox(P.stainless, m, W, 0.86, 0.3, 0.03, 0, 1.33, 0.28)
  b.rbox(P.stainless, m, W, 0.16, 0.86, 0.03, 0, 1.84, 0)
  for (const sx of [-1, 1]) b.rbox(P.stainless, m, 0.06, 0.92, 0.86, 0.02, sx * (W / 2 - 0.03), 1.36, 0)
  // Window: tilted 20° back, frame.
  const win = mul(m, T(0, 1.32, -0.2, 0, 0.35))
  b.quad(GLASS, mul(win, T(0, 0, 0, Math.PI)), W - 0.1, 0.92, { cast: false })
  b.boxM(P.stainless, win, W - 0.08, 0.04, 0.04, 0, 0.47, 0)
  b.boxM(P.stainless, win, W - 0.08, 0.04, 0.04, 0, -0.47, 0)
  // Glove ports (rings) and gloves hanging inside; port 3's glove torn and pulled out.
  const ports = [-0.66, -0.22, 0.22, 0.66]
  ports.forEach((u, i) => {
    const pm = mul(win, T(u, -0.08, 0))
    const ring = new THREE.TorusGeometry(0.1, 0.022, 6, 20)
    ring.applyMatrix4(pm)
    b.add(M.darkSteel, ring)
    if (i === 2) {
      // Pulled out inside out: a pale sleeve hanging over the front, ragged tatters at its end.
      const p0 = pt(pm, 0, 0, -0.02)
      const p1: [number, number, number] = [p0[0] + 0.02, p0[1] - 0.25, p0[2] - 0.12]
      const p2: [number, number, number] = [p1[0] - 0.01, FLOOR_Y + 0.62, p1[2] - 0.04]
      b.rod(P.gloveInner, p0, p1, 0.075, 10)
      b.rod(P.gloveInner, p1, p2, 0.065, 10)
      for (let t = 0; t < 4; t++) {
        const a = (t / 4) * Math.PI * 2
        b.rod(P.gloveInner, [p2[0] + Math.cos(a) * 0.04, p2[1], p2[2] + Math.sin(a) * 0.04], [p2[0] + Math.cos(a) * 0.06, p2[1] - 0.08 - t * 0.02, p2[2] + Math.sin(a) * 0.06], 0.012, 4)
      }
    } else {
      const p0 = pt(pm, 0, 0, 0.03)
      const p1 = pt(pm, 0.01 * (i - 1.5), -0.3, 0.32)
      b.rod(P.glove, p0, p1, 0.07, 10)
      b.rod(P.glove, p1, [p1[0], p1[1] - 0.06, p1[2] + 0.04], 0.05, 8)
    }
  })
  // Pass-through port on the right end: drum with a clamp door.
  const pm = mul(m, T(W / 2 + 0.18, 1.3, 0.05, 0, 0, Math.PI / 2))
  b.cyl(P.stainless, pm, 0.2, 0.2, 0.36, 18)
  b.cyl(M.darkSteel, mul(pm, T(0, -0.19, 0)), 0.21, 0.21, 0.03, 18)
  b.rod(M.steel, pt(m, W / 2 + 0.38, 1.25, 0.05), pt(m, W / 2 + 0.38, 1.4, 0.05), 0.012, 6)
  // Isolator tube and its lamp: the blue-white landmark seen through the spine window.
  b.boxM(GL.isolator, m, W - 0.3, 0.03, 0.05, 0, 1.74, 0.05, { cast: false })
  b.boxM(P.stainless, m, W - 0.2, 0.002, 0.6, 0, 0.903, 0.0, { cast: false })
  const lp = pt(m, 0, 1.6, -0.1)
  b.lamp({ kind: "fluorescent", position: lp, direction: [0, -1, 0], color: [0.72, 0.86, 1.0], intensity: 15, range: 6.5, angle: 1.45, penumbra: 0.9, size: 0.9 })
  // Duct and HEPA housing to the ceiling.
  b.rbox(P.stainless, m, 0.5, 0.25, 0.4, 0.02, -0.5, 2.05, 0.15)
  b.cyl("metal_galvanized", T(...pt(m, -0.5, 2.2, 0.15)).multiply(T(0, (CEIL_Y - FLOOR_Y - 2.2) / 2, 0)), 0.1, 0.1, CEIL_Y - FLOOR_Y - 2.2, 12)
  // Control panel on the left end.
  b.rbox(P.blueGrey, m, 0.06, 0.4, 0.3, 0.01, -W / 2 - 0.03, 1.35, -0.05)
  b.boxM(GL.amber, m, 0.004, 0.04, 0.1, -W / 2 - 0.062, 1.45, -0.05, { cast: false })
  b.boxM(GL.red, m, 0.004, 0.02, 0.02, -W / 2 - 0.062, 1.3, -0.12, { cast: false })
  coll(b, m, W + 0.5, 1.92, 0.86, 0.1)
  return m
}

/** Large steam autoclave (front −Z): steel cabinet, round door with a wheel, gauges, vent to the ceiling. */
export function autoclave(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(P.stainless, m, 1.1, 1.8, 1.3, 0.03, 0, 0.9, 0)
  b.boxM(M.rubber, m, 1.0, 0.08, 1.2, 0, 0.04, 0)
  const door = mul(m, T(-0.08, 1.0, -0.67, 0, Math.PI / 2))
  b.cyl(P.stainless, door, 0.38, 0.38, 0.06, 32)
  b.cyl(M.darkSteel, mul(door, T(0, 0.035, 0)), 0.33, 0.33, 0.01, 32)
  const hub = mul(door, T(0, 0.12, 0))
  b.cyl(M.steel, hub, 0.05, 0.05, 0.12, 14)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3
    b.rod(M.steel, pt(hub, 0, 0.05, 0), pt(hub, Math.cos(a) * 0.26, 0.04, Math.sin(a) * 0.26), 0.012, 6)
    b.cyl(M.rubber, mul(hub, T(Math.cos(a) * 0.27, 0.04, Math.sin(a) * 0.27)), 0.022, 0.022, 0.06, 8)
  }
  // Hinge block and control column.
  b.rbox(P.stainless, m, 0.1, 0.5, 0.08, 0.01, -0.5, 1.0, -0.69)
  b.boxM(P.blueGrey, m, 0.22, 1.5, 0.02, 0.43, 1.0, -0.66)
  for (let i = 0; i < 2; i++) {
    const g = mul(m, T(0.43, 1.45 - i * 0.24, -0.685, 0, Math.PI / 2))
    b.cyl(M.steel, g, 0.07, 0.07, 0.03, 18)
    b.cyl(P.enamel, mul(g, T(0, 0.016, 0)), 0.06, 0.06, 0.004, 18, { cast: false })
    b.boxM(P.dark, g, 0.004, 0.003, 0.05, 0.01, 0.019, 0.01, { cast: false })
  }
  b.boxM(GL.amber, m, 0.1, 0.03, 0.003, 0.43, 0.95, -0.672, { cast: false })
  b.boxM(GL.ledGreen, m, 0.015, 0.015, 0.003, 0.43, 0.85, -0.672, { cast: false })
  const top = pt(m, 0.3, 1.8, 0.3)
  b.rod(M.steel, top, [top[0], CEIL_Y, top[2]], 0.04, 10)
  b.cyl(M.darkSteel, T(top[0], FLOOR_Y + 2.1, top[2]), 0.06, 0.06, 0.08, 10)
  coll(b, m, 1.1, 1.8, 1.3)
}

/** Bench-top autoclave (gowning/media prep): drum on a box. */
export function benchAutoclave(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(P.enamel, m, 0.5, 0.36, 0.5, 0.02, 0, 0.18, 0)
  b.cyl(P.stainless, mul(m, T(0, 0.2, -0.26, 0, Math.PI / 2)), 0.16, 0.16, 0.03, 20)
  b.rod(M.steel, pt(m, -0.08, 0.2, -0.29), pt(m, 0.08, 0.2, -0.29), 0.01, 6)
  b.cyl(M.steel, mul(m, T(0.16, 0.32, -0.252, 0, Math.PI / 2)), 0.03, 0.03, 0.01, 12)
}

/** Under-counter laboratory glasswasher (front −Z), stainless. */
export function glasswasher(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(P.stainless, m, 0.6, 0.86, 0.6, 0.01, 0, 0.47, 0)
  b.boxM(M.rubber, m, 0.56, 0.1, 0.5, 0, 0.05, 0.04)
  b.boxM(P.dark, m, 0.56, 0.1, 0.004, 0, 0.82, -0.302, { cast: false })
  b.boxM(GL.ledGreen, m, 0.012, 0.012, 0.003, 0.2, 0.82, -0.305, { cast: false })
  b.rod(M.steel, pt(m, -0.2, 0.7, -0.33), pt(m, 0.2, 0.7, -0.33), 0.01, 6)
  b.rbox(M.epoxy, m, 0.62, 0.035, 0.62, 0.006, 0, 0.917, 0)
  coll(b, m, 0.6, 0.94, 0.6)
}

/** Wall pegboard drying rack over a sink: board, pegs, inverted flasks and cylinders draining. */
export function dryingRack(k: K, x: number, y: number, z: number, nx: number, nz: number, w = 1.2) {
  const m = T(x, y, z, Math.atan2(nx, nz))
  k.b.rbox(P.poly, m, w, 0.8, 0.03, 0.01, 0, 0, 0.015)
  k.b.boxM(P.stainless, m, w, 0.04, 0.12, 0, -0.42, 0.06)
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < Math.floor(w / 0.1); c++) {
      const u = -w / 2 + 0.05 + c * 0.1
      const v = 0.3 - r * 0.2
      const p0 = pt(m, u, v, 0.03)
      const p1 = pt(m, u, v + 0.03, 0.14)
      k.b.rod(P.poly, p0, p1, 0.005, 4)
      if (k.rnd() < 0.45) {
        // Flask upside down on the peg.
        const pm = mul(m, T(u, v - 0.03, 0.1, 0, Math.PI))
        const g = new THREE.CylinderGeometry(0.012, 0.04, 0.09, 10)
        g.applyMatrix4(pm)
        k.s.add(GLASS, g, { cast: false })
      }
    }
}

/** DI water system on a wall: three cartridges, a header pipe, a resistivity meter with a green lamp. */
export function diWater(b: Builder, x: number, y: number, z: number, nx: number, nz: number) {
  const m = T(x, y, z, Math.atan2(nx, nz))
  b.boxM(P.poly, m, 0.9, 0.9, 0.02, 0, 0, 0.01)
  for (let i = 0; i < 3; i++) {
    b.cyl(P.capBlue, mul(m, T(-0.28 + i * 0.22, -0.05, 0.12)), 0.075, 0.075, 0.6, 16)
    b.cyl(P.poly, mul(m, T(-0.28 + i * 0.22, 0.28, 0.12)), 0.08, 0.08, 0.06, 16)
  }
  b.rod(M.steel, pt(m, -0.4, 0.36, 0.12), pt(m, 0.4, 0.36, 0.12), 0.012, 6)
  b.rod(M.steel, pt(m, 0.4, 0.36, 0.12), pt(m, 0.4, -0.7, 0.12), 0.012, 6)
  b.rbox(P.beige, m, 0.18, 0.12, 0.08, 0.01, 0.32, 0.12, 0.06)
  b.boxM(GL.ledGreen, m, 0.06, 0.02, 0.002, 0.3, 0.13, 0.101, { cast: false })
}

/** Photographic enlarger on a dry bench at height y: baseboard, column, head with bellows and lens. */
export function enlarger(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(P.wood, m, 0.5, 0.025, 0.6, 0.005, 0, 0.0125, 0)
  b.boxM(P.enamel, m, 0.36, 0.004, 0.28, 0, 0.027, -0.05, { cast: false })
  b.rbox(M.darkSteel, m, 0.06, 1.0, 0.06, 0.01, 0, 0.53, 0.25)
  b.rbox(P.dark, m, 0.2, 0.22, 0.24, 0.02, 0, 0.82, 0.06)
  b.rbox(P.dark, m, 0.14, 0.1, 0.14, 0.01, 0, 0.66, 0.03)
  b.cyl(P.dark, mul(m, T(0, 0.58, 0.03)), 0.035, 0.035, 0.06, 12)
  b.cyl(M.darkSteel, mul(m, T(0, 0.96, 0.06)), 0.07, 0.09, 0.08, 14)
  b.rod(M.steel, pt(m, 0.04, 0.82, 0.25), pt(m, 0.12, 0.82, 0.32), 0.008, 6)
  b.rod(M.rubber, pt(m, 0, 0.98, 0.06), pt(m, 0.1, 0.0, 0.3), 0.004, 4)
}

/** Darkroom wet sink: counter with a stainless trough, three process trays, a faucet bar and splashback. */
export function darkroomSink(k: K, x: number, z: number, yaw: number, len = 4.2) {
  const b = k.b
  const m = F(x, z, yaw)
  const d = 0.75
  b.rbox(M.cabinet, m, len, 0.78, d - 0.05, 0.01, 0, 0.47, 0.02)
  b.boxM(M.rubber, m, len - 0.1, 0.08, d - 0.15, 0, 0.04, 0.06)
  b.boxM(P.stainless, m, len, 0.02, d, 0, 0.87, 0)
  b.boxM(P.stainless, m, len, 0.14, 0.02, 0, 0.94, -d / 2 + 0.01)
  for (const sx of [-1, 1]) b.boxM(P.stainless, m, 0.02, 0.14, d, sx * (len / 2 - 0.01), 0.94, 0)
  b.boxM(P.stainless, m, len, 0.45, 0.02, 0, 1.1, d / 2 - 0.01)
  b.rod(M.steel, pt(m, -len / 2 + 0.2, 1.25, d / 2 - 0.08), pt(m, len / 2 - 0.2, 1.25, d / 2 - 0.08), 0.015, 8)
  for (let i = 0; i < 3; i++) {
    const p = pt(m, -len / 2 + 0.5 + i * 0.45, 1.25, d / 2 - 0.08)
    b.rod(M.steel, p, [p[0], p[1] - 0.12, p[2]], 0.01, 6)
  }
  const trays = [P.enamel, P.poly, P.enamel]
  trays.forEach((mat, i) => {
    const tm = mul(m, T(-len / 2 + 0.6 + i * 0.6, 0.88, 0))
    k.s.boxM(mat, tm, 0.5, 0.008, 0.4, 0, 0.004, 0)
    k.s.boxM(mat, tm, 0.5, 0.06, 0.008, 0, 0.03, -0.2)
    k.s.boxM(mat, tm, 0.5, 0.06, 0.008, 0, 0.03, 0.2)
    k.s.boxM(mat, tm, 0.008, 0.06, 0.4, -0.25, 0.03, 0)
    k.s.boxM(mat, tm, 0.008, 0.06, 0.4, 0.25, 0.03, 0)
    k.s.boxM(P.dark, tm, 0.48, 0.003, 0.38, 0, 0.03, 0, { cast: false })
  })
  b.collideLocal(m, [-len / 2, 0, -d / 2], [len / 2, 1.01, d / 2])
}

/** Electron microscope: L-shaped console with the column rising through it, viewing CRTs (dim green). */
export function electronMicroscope(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(P.beige, m, 2.6, 0.74, 0.9, 0.01, 0, 0.37, 0)
  b.rbox(P.beige, m, 0.9, 0.74, 1.4, 0.01, 1.75, 0.37, 0.25)
  b.rbox(M.laminateTop, m, 2.62, 0.03, 0.92, 0.005, 0, 0.755, 0)
  // Column: stacked steel stages, gun on top.
  const c = mul(m, T(-0.6, 0.77, 0.05))
  const stages: [number, number, number][] = [[0.28, 0.24, 0.3], [0.2, 0.2, 0.25], [0.18, 0.18, 0.35], [0.16, 0.14, 0.25], [0.12, 0.12, 0.2]]
  let y = 0
  for (const [rb, rt, h] of stages) {
    b.cyl(y > 0.5 ? M.steel : P.enamel, mul(c, T(0, y + h / 2, 0)), rt, rb, h, 20)
    b.cyl(M.darkSteel, mul(c, T(0, y + h, 0)), rt + 0.015, rt + 0.015, 0.02, 20)
    y += h + 0.02
  }
  b.cyl(P.enamel, mul(c, T(0, y + 0.12, 0)), 0.1, 0.13, 0.24, 18)
  b.cyl(P.blueGrey, mul(c, T(0, 0.35, -0.3, 0, Math.PI / 2)), 0.08, 0.1, 0.12, 16)
  // Viewing screens on the console (dim green phosphor, no lamp).
  for (const u of [0.35, 0.95]) {
    b.rbox(P.beige, m, 0.42, 0.36, 0.4, 0.02, u, 0.95, 0.15)
    b.boxM(GL.crt, m, 0.3, 0.24, 0.003, u, 0.96, -0.052, { cast: false })
  }
  b.rbox(P.dark, m, 1.0, 0.04, 0.25, 0.005, 0.6, 0.79, -0.3)
  for (let i = 0; i < 8; i++) b.cyl(M.steel, mul(m, T(0.2 + i * 0.1, 0.82, -0.32)), 0.01, 0.01, 0.02, 8)
  b.collideLocal(m, [-1.3, 0, -0.45], [1.3, 0.77, 0.45])
  b.collideLocal(c, [-0.3, 0, -0.3], [0.3, y + 0.25, 0.3])
  b.collideLocal(m, [1.3, 0, -0.45], [2.2, 0.77, 0.95])
}

/** Strip-chart recorder on a bench at height y; its paper has spooled over the bench edge into a heap on the floor
 *  at local +out (towards −Z). A pen lamp glows; `lamp` registers a tiny warm light. */
export function chartRecorder(k: K, x: number, y: number, z: number, yaw: number, drop: number) {
  const b = k.b
  const m = T(x, y, z, yaw)
  b.rbox(P.beige, m, 0.44, 0.32, 0.4, 0.015, 0, 0.16, 0)
  b.boxM(P.dark, m, 0.36, 0.18, 0.004, 0, 0.19, -0.202, { cast: false })
  b.boxM(P.chart, m, 0.3, 0.16, 0.002, 0, 0.19, -0.205, { cast: false })
  for (let i = 0; i < 3; i++) b.boxM(M.red, m, 0.004, 0.08, 0.002, -0.08 + i * 0.05 + (i === 1 ? 0.02 : 0), 0.2, -0.207, { cast: false })
  b.boxM(GL.amber, m, 0.02, 0.012, 0.003, 0.17, 0.05, -0.203, { cast: false })
  // Paper: from the slot over the front edge down to the floor, then a heap of folds.
  const fl = FLOOR_Y - y
  const strip: [number, number, number][] = [[0, 0.1, -0.2], [0, 0.003, -0.32], [0, 0.003, -drop + 0.01], [0.01, -0.04, -drop - 0.03], [0.0, -0.3, -drop - 0.05], [-0.02, -0.6, -drop - 0.05], [0.03, fl + 0.06, -drop - 0.1]]
  for (let i = 0; i < strip.length - 1; i++) {
    const a = pt(m, ...strip[i]!)
    const c = pt(m, ...strip[i + 1]!)
    const dx = c[0] - a[0]
    const dy = c[1] - a[1]
    const dz = c[2] - a[2]
    const len = Math.hypot(dx, dy, dz)
    const g = new THREE.BoxGeometry(0.28, 0.0015, len)
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dx, dy, dz).normalize())
    const mm = new THREE.Matrix4().compose(new THREE.Vector3((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2), q, new THREE.Vector3(1, 1, 1))
    g.applyMatrix4(mm)
    k.s.add(P.chart, g, { cast: false })
  }
  for (let i = 0; i < 9; i++) {
    const g = new THREE.BoxGeometry(0.28, 0.003, 0.2 + k.rnd() * 0.05)
    g.rotateZ((k.rnd() - 0.5) * 0.2)
    g.rotateY(yaw + (k.rnd() - 0.5) * 0.9)
    const p = pt(m, (k.rnd() - 0.5) * 0.25, fl, -drop - 0.25 + (k.rnd() - 0.5) * 0.25)
    g.translate(p[0], FLOOR_Y + 0.004 + i * 0.006, p[2])
    k.s.add(P.chart, g, { cast: false })
  }
  const lp = pt(m, 0, 0.2, -0.35)
  b.lamp({ kind: "window", position: lp, color: [1, 0.8, 0.55], intensity: 0.5, range: 1.6, size: 0.05 })
}

/** Gas chromatograph (oven door, injector ports on top, display). */
export function gasChromatograph(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(P.beige, m, 0.65, 0.5, 0.55, 0.015, 0, 0.25, 0)
  b.rbox(P.enamel, m, 0.42, 0.38, 0.02, 0.01, -0.08, 0.24, -0.285)
  b.boxM(M.steel, m, 0.03, 0.12, 0.03, 0.12, 0.24, -0.3)
  b.boxM(P.dark, m, 0.16, 0.38, 0.004, 0.23, 0.26, -0.277, { cast: false })
  b.boxM(GL.red, m, 0.1, 0.03, 0.002, 0.23, 0.38, -0.28, { cast: false })
  for (let i = 0; i < 2; i++) b.cyl(M.steel, mul(m, T(-0.15 + i * 0.14, 0.53, 0.0)), 0.025, 0.03, 0.06, 10)
  b.rod(M.steel, pt(m, 0.3, 0.1, 0.27), pt(m, 0.3, -0.2, 0.32), 0.004, 4)
}

/** Atomic absorption spectrometer with its burner compartment and an exhaust canopy ducted to the ceiling. */
export function atomicAbsorption(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(P.beige, m, 1.2, 0.42, 0.55, 0.015, 0, 0.21, 0)
  b.boxM(GLASS, m, 0.3, 0.26, 0.004, -0.38, 0.24, -0.277, { cast: false })
  b.boxM(P.dark, m, 0.5, 0.2, 0.004, 0.25, 0.25, -0.277, { cast: false })
  b.boxM(GL.amber, m, 0.14, 0.04, 0.002, 0.15, 0.3, -0.28, { cast: false })
  b.boxM(M.steel, m, 0.12, 0.02, 0.06, -0.38, 0.2, 0)
  const top = 1.35
  b.rbox(P.stainless, m, 0.5, 0.12, 0.45, 0.02, -0.38, top, 0)
  b.cyl("metal_galvanized", T(...pt(m, -0.38, top + 0.06, 0)).multiply(T(0, (CEIL_Y - FLOOR_Y - (y - FLOOR_Y) - top - 0.06) / 2, 0)), 0.08, 0.08, CEIL_Y - y - top - 0.06, 12)
}
