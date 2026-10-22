/**
 * The compass's printed markings as one 2048² vector atlas (crisp at any distance with mips and anisotropy):
 * - left half: the baseplate's underside print (mm and inch rulers, a 1:25 000 romer and this sheet's own scale, the
 *   direction-of-travel arrow and index line, the magnifier ring and the lanyard hole), black ink with alpha;
 * - top right: the bezel's top face (black, white graduations every 2°, numbers every 20°, N E S W);
 * - bottom right: the capsule floor (black meridian lines and the red orienting arrow).
 * Dimensions in millimetres match the mesh (`COMPASS`).
 */

export const COMPASS = {
  plate: { w: 58, l: 118, t: 2.2, r: 5 },
  /** Bezel centre on the plate (mm from plate centre, +y towards the front) and its radii and height. */
  bezel: { y: -25, outer: 22.5, inner: 18.9, h: 5.4 },
  capsule: { r: 18.4, depth: 4.2 },
  needle: { len: 14.5, w: 2.1 },
  magnifier: { y: 32, r: 9 },
  hole: { y: -54, r: 2.2 },
} as const

export const ATLAS = 2048
export const PLATE_PX = 17.3
export const RING_PX = 512 / 23.5

/** UV of a plate point (mm, plate centre origin, +y front). */
export const plateUv = (x: number, y: number): [number, number] => [(512 + x * PLATE_PX) / ATLAS, (1024 - y * PLATE_PX) / ATLAS]
/** UV of a bezel-top point (mm, bezel centre). */
export const bezelUv = (x: number, y: number): [number, number] => [(1536 + x * RING_PX) / ATLAS, (512 - y * RING_PX) / ATLAS]
/** UV of a capsule-floor point (mm, capsule centre). */
export const floorUv = (x: number, y: number): [number, number] => [(1536 + x * RING_PX) / ATLAS, (1536 - y * RING_PX) / ATLAS]

const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif"

export function drawCompassAtlas(scaleDenominator: number): OffscreenCanvas {
  const c = new OffscreenCanvas(ATLAS, ATLAS)
  const g = c.getContext("2d")!
  g.clearRect(0, 0, ATLAS, ATLAS)
  const P = COMPASS.plate

  // ---- Baseplate (plate mm → px, +y up the plate).
  g.save()
  g.translate(512, 1024)
  g.scale(PLATE_PX, -PLATE_PX)
  const ink = "rgba(18,18,20,0.95)"
  g.fillStyle = ink; g.strokeStyle = ink
  const text = (s: string, x: number, y: number, size: number, align: CanvasTextAlign = "center", rot = 0, weight = 500) => {
    g.save(); g.translate(x, y); g.scale(1, -1); g.rotate(rot)
    g.font = `${weight} ${size}px ${SANS}`; g.textAlign = align; g.textBaseline = "middle"; g.fillText(s, 0, 0); g.restore()
  }
  const RED = "rgba(200,28,24,0.97)"
  // mm ruler down the right edge, from the front corner (black, cm numbers).
  const right = P.w / 2 - 0.6, front = P.l / 2 - 3
  for (let mm = 0; mm <= 80; mm++) {
    const y = front - 4 - mm, len = mm % 10 === 0 ? 3.6 : mm % 5 === 0 ? 2.6 : 1.6
    g.lineWidth = mm % 10 === 0 ? 0.26 : 0.18
    g.beginPath(); g.moveTo(right, y); g.lineTo(right - len, y); g.stroke()
    if (mm % 10 === 0 && mm) text(`${mm / 10}`, right - 5.4, y, 2.4, "center", -Math.PI / 2, 700)
  }
  text("cm", right - 5.4, front - 1.5, 2, "center", -Math.PI / 2, 600)
  // Romer scales down the left edge in red: 1:25 000 (100 m = 4 mm) and this sheet's own (10 m steps).
  const left = -P.w / 2 + 0.6
  g.fillStyle = RED; g.strokeStyle = RED
  for (let i = 0; i <= 40; i++) {
    const y = front - 4 - i * 2, len = i % 5 === 0 ? 3.2 : 1.8
    g.lineWidth = i % 5 === 0 ? 0.26 : 0.18
    g.beginPath(); g.moveTo(left, y); g.lineTo(left + len, y); g.stroke()
    if (i % 10 === 0) text(`${i / 20}`, left + 5.2, y, 2.2, "center", Math.PI / 2, 700)
  }
  text("1:25 000 km", left + 5.2, front - 4 - 84, 1.8, "center", Math.PI / 2, 600)
  g.fillStyle = ink; g.strokeStyle = ink
  const own = 10 * 1000 / scaleDenominator // mm per 10 m on this sheet
  for (let i = 0; i <= 5; i++) {
    const y = -P.l / 2 + 22 + i * own, len = 2.6
    if (y > front - 92) break
    g.lineWidth = 0.24
    g.beginPath(); g.moveTo(left, y); g.lineTo(left + len, y); g.stroke()
    text(`${i * 10}`, left + 4.8, y, 1.8, "center", Math.PI / 2, 700)
  }
  text(`1:${scaleDenominator} m`, left + 4.8, -P.l / 2 + 15, 1.6, "center", Math.PI / 2, 600)
  // Inch ruler across the front.
  for (let i = 0; i <= 16; i++) {
    const x = -P.w / 2 + 6 + i * 25.4 / 8, len = i % 8 === 0 ? 2.8 : i % 4 === 0 ? 2.1 : 1.3
    if (x > P.w / 2 - 7) break
    g.lineWidth = 0.18
    g.beginPath(); g.moveTo(x, P.l / 2 - 0.6); g.lineTo(x, P.l / 2 - 0.6 - len); g.stroke()
  }
  text("in", P.w / 2 - 9, P.l / 2 - 2.8, 1.9, "center", 0, 600)
  // Direction-of-travel arrow and its index line, red, filled head.
  const by = COMPASS.bezel.y + COMPASS.bezel.outer + 2
  g.strokeStyle = RED; g.fillStyle = RED; g.lineWidth = 0.5
  g.beginPath(); g.moveTo(-1.8, by); g.lineTo(-1.8, P.l / 2 - 16); g.lineTo(-4.4, P.l / 2 - 16); g.lineTo(0, P.l / 2 - 8.5); g.lineTo(4.4, P.l / 2 - 16); g.lineTo(1.8, P.l / 2 - 16); g.lineTo(1.8, by); g.stroke()
  g.beginPath(); g.moveTo(-4.4, P.l / 2 - 16); g.lineTo(0, P.l / 2 - 8.5); g.lineTo(4.4, P.l / 2 - 16); g.closePath(); g.fill()
  g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 0.26
  g.beginPath(); g.moveTo(0, COMPASS.bezel.y + COMPASS.bezel.outer + 0.3); g.lineTo(0, by - 0.4); g.stroke()
  // Parallel orienting lines along the plate (for laying a bearing along a line).
  g.lineWidth = 0.16
  for (const x of [-13, 13]) { g.beginPath(); g.moveTo(x, -P.l / 2 + 6); g.lineTo(x, P.l / 2 - 20); g.stroke() }
  // Magnifier ring and lanyard hole.
  g.lineWidth = 0.32
  g.beginPath(); g.arc(0, COMPASS.magnifier.y, COMPASS.magnifier.r, 0, Math.PI * 2); g.stroke()
  g.lineWidth = 0.5
  g.beginPath(); g.arc(0, COMPASS.hole.y, COMPASS.hole.r, 0, Math.PI * 2); g.stroke()
  // Printed text: maker, model and the declination note.
  text("SURVEYOR 7", 0, P.l / 2 - 21.5, 2.6, "center", 0, 800)
  text("LIQUID FILLED · ORIENTEERING", 0, P.l / 2 - 24.6, 1.4, "center", 0, 600)
  text("DECLINATION 2° W", 0, -P.l / 2 + 9.5, 1.7, "center", 0, 700)
  text("MADE IN FINLAND", 0, -P.l / 2 + 12.2, 1.3, "center", 0, 500)
  g.restore()

  // ---- Bezel top: black ring with crisp white graduations every 2° and numbers every 20°.
  g.save()
  g.translate(1536, 512)
  g.scale(RING_PX, RING_PX)
  const B = COMPASS.bezel
  g.fillStyle = "#0e0e10"
  g.beginPath(); g.arc(0, 0, B.outer + 0.5, 0, Math.PI * 2); g.fill()
  g.strokeStyle = "#f4f1e8"; g.fillStyle = "#f4f1e8"
  for (let d = 0; d < 360; d += 2) {
    const a = (d * Math.PI) / 180, major = d % 10 === 0
    const r0 = B.outer - 0.35, r1 = r0 - (major ? 1.25 : 0.75)
    g.lineWidth = major ? 0.2 : 0.12
    g.beginPath(); g.moveTo(Math.sin(a) * r0, -Math.cos(a) * r0); g.lineTo(Math.sin(a) * r1, -Math.cos(a) * r1); g.stroke()
  }
  const label = (s: string, d: number, size: number, color = "#f4f1e8") => {
    const a = (d * Math.PI) / 180, r = B.inner + 0.95
    g.save(); g.translate(Math.sin(a) * r, -Math.cos(a) * r); g.rotate(a)
    g.fillStyle = color; g.font = `700 ${size}px ${SANS}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(s, 0, 0); g.restore()
  }
  for (let d = 20; d < 360; d += 20) if (d % 90 !== 0) label(`${d}`, d, 1.3)
  label("N", 0, 1.6, "#ff4a3a"); label("E", 90, 1.5); label("S", 180, 1.5); label("W", 270, 1.5)
  g.restore()

  // ---- Capsule floor: meridian lines and the orienting arrow (transparent elsewhere).
  g.save()
  g.translate(1536, 1536)
  g.scale(RING_PX, -RING_PX)
  const R = COMPASS.capsule.r
  g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.clip()
  g.strokeStyle = "rgba(14,14,16,0.9)"; g.lineWidth = 0.2
  for (let x = -16; x <= 16; x += 4) {
    if (Math.abs(x) < 3) continue
    g.beginPath(); g.moveTo(x, -R); g.lineTo(x, R); g.stroke()
  }
  g.strokeStyle = "rgba(205,32,28,0.95)"; g.lineWidth = 0.5
  g.beginPath(); g.moveTo(-2.6, -9); g.lineTo(-2.6, 7.5); g.lineTo(-5, 7.5); g.lineTo(0, 14); g.lineTo(5, 7.5); g.lineTo(2.6, 7.5); g.lineTo(2.6, -9); g.stroke()
  g.fillStyle = "rgba(205,32,28,0.35)"
  g.beginPath(); g.moveTo(-5, 7.5); g.lineTo(0, 14); g.lineTo(5, 7.5); g.closePath(); g.fill()
  g.restore()
  return c
}
