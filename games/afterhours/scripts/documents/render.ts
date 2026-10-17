// Browser-side renderer for the set-dressing document atlas (bundled and run headless by scripts/build-documents.ts).
// Every document is drawn with Canvas 2D in millimetres: typewriter/print/handwriting text, stamps, forms, then paper
// ageing (grain, yellowing, foxing, creases, pin holes, coffee rings). Outputs three atlases — base colour, a height
// map turned into a normal map (creases, grain), ORM (roughness per material) — and a manifest of UV rects.
// All content is original and follows docs/building-program.md (Pine Hollow Station, the Sublevel); everyone is invented.

type Ctx = CanvasRenderingContext2D
type Paper = "white" | "onion" | "yellow" | "goldenrod" | "pink" | "green" | "manila" | "card" | "legal" | "greenbar" | "polaroid" | "poster" | "sticky" | "plate" | "timecard" | "chalk" | "white_board" | "gypsum" | "felt" | "bronze" | "newsprint" | "blueprint" | "concrete" | "brass_plate"
type Tag = "wall" | "board" | "desk" | "clipboard" | "creepy" | "floor"

type DocSpec = {
  id: string
  title: string
  size: [number, number] // metres (width, height)
  paper: Paper
  tags: Tag[]
  /** Pixels per millimetre (default 3.4). */
  density?: number
  /** Photocopy look: grey toner speckle and edge shadow. */
  copy?: boolean
  draw: (d: Draw) => void
}

const IMAGES = (globalThis as { __images?: Record<string, string> }).__images ?? {}
const loaded: Record<string, HTMLImageElement> = {}

let seed = 1
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const rr = (a: number, b: number) => a + (b - a) * rand()
const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!

const PT = 0.3528 // mm per point
const INK = { black: "#1d1b1e", ribbon: "#242022", blue: "#1f3a8a", ballBlue: "#23347a", red: "#a3241c", carbon: "#3a3f8f", pencil: "#4a4a4c", stamp: "#7a2a6e", green: "#2d5a3a" }
const HANDS = ["Caveat", "Reenie Beanie", "Nothing You Could Do"] as const

class Draw {
  readonly W: number
  readonly H: number
  readonly creases: [number, number, number, number, number][] = []
  readonly gloss: [number, number, number, number, number][] = []
  constructor(
    readonly ctx: Ctx,
    readonly mm: number,
    readonly wmm: number,
    readonly hmm: number,
  ) {
    this.W = ctx.canvas.width
    this.H = ctx.canvas.height
    ctx.scale(mm, mm)
    ctx.textBaseline = "alphabetic"
  }
  font(f: string, pt: number, weight = 400) {
    this.ctx.font = `${weight} ${pt * PT}px "${f}"`
  }
  /** Typewriter text: per-character jitter, uneven ribbon density, occasional over-strike. */
  type(s: string, x: number, y: number, o: { pt?: number; color?: string; font?: string; bold?: boolean; fade?: number; carbon?: boolean } = {}) {
    const c = this.ctx
    const pt = o.pt ?? 10.5
    this.font(o.font ?? "Special Elite", pt, o.bold ? 700 : 400)
    const adv = c.measureText("M").width
    c.save()
    c.fillStyle = o.color ?? INK.ribbon
    if (o.carbon) {
      c.shadowColor = o.color ?? INK.carbon
      c.shadowBlur = 0.35 * this.mm
    } else {
      c.shadowColor = c.fillStyle as string
      c.shadowBlur = 0.12 * this.mm
    }
    let cx = x
    for (const ch of s) {
      if (ch !== " ") {
        c.globalAlpha = Math.min(1, rr(0.62, 1) * (o.fade ?? 1))
        const jx = rr(-0.08, 0.08)
        const jy = rr(-0.1, 0.1)
        c.fillText(ch, cx + jx, y + jy)
        if (rand() < 0.04) c.fillText(ch, cx + jx + 0.12, y + jy + 0.05)
      }
      cx += adv
    }
    c.restore()
    return cx
  }
  typeLines(lines: string[], x: number, y: number, lh = 4.4, o: Parameters<Draw["type"]>[3] = {}) {
    lines.forEach((l, i) => this.type(l, x, y + i * lh, o))
    return y + lines.length * lh
  }
  /** Wraps typewriter prose at a column count. */
  wrap(text: string, cols: number) {
    const out: string[] = []
    for (const [pi, para] of text.split("\n").entries()) {
      if (pi) out.push("")
      let line = ""
      for (const w of para.split(" ")) {
        if ((line + " " + w).trim().length > cols) {
          out.push(line)
          line = w
        } else line = (line + " " + w).trim()
      }
      out.push(line)
    }
    return out
  }
  /** Clean printed text (typeset notices, posters, forms). */
  print(s: string, x: number, y: number, o: { pt?: number; font?: string; weight?: number; color?: string; align?: CanvasTextAlign; spacing?: number; alpha?: number } = {}) {
    const c = this.ctx
    c.save()
    this.font(o.font ?? "Libre Franklin", o.pt ?? 10, o.weight ?? 400)
    c.fillStyle = o.color ?? INK.black
    c.globalAlpha = o.alpha ?? 0.94
    c.textAlign = o.align ?? "left"
    if (o.spacing) (c as Ctx & { letterSpacing: string }).letterSpacing = `${o.spacing}px`
    c.shadowColor = c.fillStyle as string
    c.shadowBlur = 0.1 * this.mm
    c.fillText(s, x, y)
    c.restore()
  }
  /** Handwriting: a slight per-word wobble and drift, ballpoint pressure variation. */
  hand(s: string, x: number, y: number, o: { pt?: number; font?: (typeof HANDS)[number] | "Permanent Marker"; color?: string; slant?: number; drift?: number } = {}) {
    const c = this.ctx
    const pt = o.pt ?? 14
    const f = o.font ?? "Caveat"
    c.save()
    this.font(f, pt, f === "Caveat" ? 500 : 400)
    c.fillStyle = o.color ?? INK.ballBlue
    c.shadowColor = c.fillStyle as string
    c.shadowBlur = 0.08 * this.mm
    let cx = x
    let cy = y
    for (const w of s.split(" ")) {
      c.save()
      c.translate(cx, cy + rr(-0.25, 0.25))
      c.rotate((o.slant ?? 0) + rr(-0.025, 0.025))
      c.globalAlpha = rr(0.78, 0.97)
      c.fillText(w, 0, 0)
      c.restore()
      cx += c.measureText(w + " ").width * rr(0.97, 1.05)
      cy += (o.drift ?? 0) * c.measureText(w + " ").width
    }
    c.restore()
    return cx
  }
  line(x0: number, y0: number, x1: number, y1: number, w = 0.2, color = INK.black, alpha = 0.85) {
    const c = this.ctx
    c.save()
    c.strokeStyle = color
    c.globalAlpha = alpha
    c.lineWidth = w
    c.beginPath()
    c.moveTo(x0, y0)
    c.lineTo(x1, y1)
    c.stroke()
    c.restore()
  }
  /** Hand-drawn line (wobbly), e.g. strike-throughs and underlines. */
  scribble(x0: number, y0: number, x1: number, y1: number, w = 0.35, color = INK.ballBlue) {
    const c = this.ctx
    c.save()
    c.strokeStyle = color
    c.lineWidth = w
    c.lineCap = "round"
    c.globalAlpha = 0.85
    c.beginPath()
    const n = 8
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const px = x0 + (x1 - x0) * t + rr(-0.3, 0.3)
      const py = y0 + (y1 - y0) * t + rr(-0.35, 0.35)
      i ? c.lineTo(px, py) : c.moveTo(px, py)
    }
    c.stroke()
    c.restore()
  }
  rect(x: number, y: number, w: number, h: number, lw = 0.25, color = INK.black, fill?: string) {
    const c = this.ctx
    c.save()
    if (fill) {
      c.fillStyle = fill
      c.fillRect(x, y, w, h)
    }
    if (lw > 0) {
      c.strokeStyle = color
      c.lineWidth = lw
      c.globalAlpha = 0.85
      c.strokeRect(x, y, w, h)
    }
    c.restore()
  }
  fill(x: number, y: number, w: number, h: number, color: string, alpha = 1) {
    const c = this.ctx
    c.save()
    c.globalAlpha = alpha
    c.fillStyle = color
    c.fillRect(x, y, w, h)
    c.restore()
  }
  /** Rubber stamp: double-ruled box, uneven inking with dropouts. */
  stamp(lines: string[], x: number, y: number, rot: number, color = INK.stamp, pt = 11) {
    const c = this.ctx
    const off = document.createElement("canvas")
    const s = this.mm
    this.font("Archivo Black", pt)
    const tw = Math.max(...lines.map((l) => c.measureText(l).width)) + 6
    const th = lines.length * pt * PT * 1.25 + 4
    off.width = Math.ceil(tw * s)
    off.height = Math.ceil(th * s)
    const o = off.getContext("2d")!
    o.scale(s, s)
    o.strokeStyle = o.fillStyle = color
    o.lineWidth = 0.6
    o.strokeRect(0.6, 0.6, tw - 1.2, th - 1.2)
    o.lineWidth = 0.25
    o.strokeRect(1.5, 1.5, tw - 3, th - 3)
    o.font = `400 ${pt * PT}px "Archivo Black"`
    o.textAlign = "center"
    lines.forEach((l, i) => o.fillText(l, tw / 2, 2.2 + (i + 0.82) * pt * PT * 1.22))
    // Dropouts: speckle erase and one weaker side.
    o.setTransform(1, 0, 0, 1, 0, 0)
    o.globalCompositeOperation = "destination-out"
    const g = o.createLinearGradient(0, 0, off.width, 0)
    g.addColorStop(0, "rgba(0,0,0,0)")
    g.addColorStop(1, `rgba(0,0,0,${rr(0.2, 0.55)})`)
    o.fillStyle = g
    o.fillRect(0, 0, off.width, off.height)
    for (let i = 0; i < off.width * off.height * 0.04; i++) {
      o.fillStyle = `rgba(0,0,0,${rr(0.3, 1)})`
      o.fillRect(rand() * off.width, rand() * off.height, rr(0.5, 2.2), rr(0.5, 2.2))
    }
    c.save()
    c.translate(x, y)
    c.rotate(rot)
    c.globalAlpha = 0.82
    c.globalCompositeOperation = "multiply"
    c.drawImage(off, -tw / 2, -th / 2, tw, th)
    c.restore()
  }
  redact(x: number, y: number, w: number, h = 3.4) {
    const c = this.ctx
    c.save()
    c.fillStyle = "#0e0e10"
    c.globalAlpha = 0.95
    c.beginPath()
    c.moveTo(x, y + rr(-0.3, 0.3))
    for (let t = 0; t <= w; t += 3) c.lineTo(x + t, y + rr(-0.4, 0.2))
    for (let t = w; t >= 0; t -= 3) c.lineTo(x + t, y + h + rr(-0.2, 0.4))
    c.fill()
    c.restore()
  }
  image(name: string, x: number, y: number, w: number, h: number, filter = "none", alpha = 1) {
    const img = loaded[name]
    if (!img) return
    const c = this.ctx
    c.save()
    c.filter = filter
    c.globalAlpha = alpha
    // Cover-fit.
    const ar = w / h
    const iar = img.width / img.height
    let sw = img.width
    let sh = img.height
    if (iar > ar) sw = sh * ar
    else sh = sw / ar
    c.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h)
    c.restore()
  }
  holes(x: number, y: number) {
    const c = this.ctx
    for (let i = 0; i < 1 + Math.floor(rand() * 3); i++) {
      const hx = x + rr(-2.5, 2.5)
      const hy = y + rr(-1.5, 1.5)
      c.save()
      c.fillStyle = "rgba(40,30,20,0.55)"
      c.beginPath()
      c.arc(hx, hy, rr(0.35, 0.6), 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = "rgba(90,70,40,0.25)"
      c.lineWidth = 0.3
      c.beginPath()
      c.arc(hx, hy, 1.1, 0, Math.PI * 2)
      c.stroke()
      c.restore()
    }
  }
  coffee(x: number, y: number, r = 38, a = 0.35) {
    const c = this.ctx
    c.save()
    c.globalCompositeOperation = "multiply"
    for (let k = 0; k < 2; k++) {
      c.strokeStyle = `rgba(120,78,38,${a * (k ? 0.5 : 1)})`
      c.lineWidth = rr(0.6, 1.4)
      c.beginPath()
      const start = rr(0, 6.28)
      const len = rr(3.6, 6.2)
      for (let t = 0; t <= len; t += 0.08) {
        const rad = r + Math.sin(t * 3 + k) * 0.6 + rr(-0.15, 0.15) + k * 1.2
        const px = x + Math.cos(start + t) * rad
        const py = y + Math.sin(start + t) * rad
        t ? c.lineTo(px, py) : c.moveTo(px, py)
      }
      c.stroke()
    }
    const g = c.createRadialGradient(x, y, r * 0.2, x, y, r)
    g.addColorStop(0, "rgba(150,100,50,0)")
    g.addColorStop(1, `rgba(150,100,50,${a * 0.18})`)
    c.fillStyle = g
    c.beginPath()
    c.arc(x, y, r, 0, Math.PI * 2)
    c.fill()
    c.restore()
  }
  staple(x: number, y: number, rot = -0.6) {
    const c = this.ctx
    c.save()
    c.translate(x, y)
    c.rotate(rot)
    c.fillStyle = "rgba(60,60,64,0.35)"
    c.fillRect(-6.3, -0.2, 12.6, 1.1)
    c.fillStyle = "#9a9ca0"
    c.fillRect(-6, -0.5, 12, 0.9)
    c.restore()
    this.gloss.push([x - 6, y - 2, 12, 4, 0])
  }
  crease(x0: number, y0: number, x1: number, y1: number, strength = 1) {
    this.creases.push([x0, y0, x1, y1, strength])
  }
  checkbox(x: number, y: number, s = 3.2, checked = false, color = INK.ballBlue) {
    this.rect(x, y - s + 0.4, s, s, 0.22)
    if (checked) {
      this.scribble(x + 0.5, y - s * 0.4, x + s * 0.4, y + 0.2, 0.4, color)
      this.scribble(x + s * 0.4, y + 0.2, x + s + 0.8, y - s - 0.4, 0.4, color)
    }
  }
}

// ---------------------------------------------------------------------------------------------------- content
// Lore follows docs/building-program.md: Pine Hollow Station (Atmospheric Propagation Research Facility) of the
// fictional Interagency Office of Propagation Studies (IOPS); the Sublevel (SL), freight lift FL-1, riser W-1, the six
// "SL" time cards punched IN at 22:58, keycards (Comms, Sublevel, Server, Signal, Containment, Plant), room numbers
// (storey-room, e.g. 0-38 Security office) and the per-floor vignettes.
const STATION = "PINE HOLLOW STATION"
const AGENCY = "INTERAGENCY OFFICE OF PROPAGATION STUDIES"
const FACILITY = "ATMOSPHERIC PROPAGATION RESEARCH FACILITY"
/** Telephone extensions, shared by every document that quotes one. Ext. 300 (Field Operations / FL-1) is "disconnected". */
const EXT = {
  operator: "0", lobby: "200", director: "214", execSec: "215", records: "211", progChief: "217", payroll: "219",
  facilities: "230", receiving: "236", badges: "238", cafeteria: "240", ops: "246", compMgr: "262", labMgr: "268",
  labSafety: "270", lab4: "275", listening: "288", security: "299", fieldOps: "300", emergency: "333",
}
/** The six on the Sublevel rotation (cards punched IN 22:58, never out). */
const SL_SIX = ["D. Halverson", "E. Lindqvist", "P. Moreau", "B. Szabo", "K. Dorsey", "A. Nakamura"]
const letterhead = (d: Draw, y = 18) => {
  d.print(AGENCY, d.wmm / 2, y, { font: "Libre Franklin", pt: 9.5, weight: 700, align: "center", spacing: 0.5 })
  d.print(STATION + " · " + FACILITY, d.wmm / 2, y + 5, { pt: 6.8, align: "center", spacing: 0.3 })
  d.line(22, y + 8, d.wmm - 22, y + 8, 0.35)
  d.line(22, y + 9, d.wmm - 22, y + 9, 0.15)
}
const memoHead = (d: Draw, to: string, from: string, date: string, subj: string, y = 40, o: Parameters<Draw["type"]>[3] = {}) => {
  d.type("MEMORANDUM", 25, y, { ...o, pt: 12 })
  const rows: [string, string][] = [["TO:", to], ["FROM:", from], ["DATE:", date], ["SUBJECT:", subj]]
  rows.forEach(([k, v], i) => {
    d.type(k, 25, y + 10 + i * 5.2, o)
    d.type(v, 52, y + 10 + i * 5.2, o)
  })
  d.line(25, y + 33, d.wmm - 25, y + 33, 0.2, o.color ?? INK.ribbon, 0.6)
  return y + 42
}
const LETTER: [number, number] = [0.216, 0.279]
const LEGAL_PAD: [number, number] = [0.216, 0.297]
const HALF: [number, number] = [0.216, 0.14]
const TABLOID: [number, number] = [0.279, 0.432]
const PLATE: [number, number] = [0.2, 0.075]

/** Tear-off tabs along the bottom of a flyer; `torn` tabs are missing (dark wall showing through). */
function tabs(d: Draw, n: number, y0: number, text: string, torn: number[], weight = 400) {
  const tw = (d.wmm - 8) / n
  for (let i = 0; i < n; i++) {
    const x = 4 + i * tw
    if (torn.includes(i)) {
      d.scribble(x, y0 + 2 + rr(-1, 1), x + tw, y0 + 2 + rr(-1, 1), 0.2, "#7a6a50")
      d.fill(x + 0.3, y0 + 3, tw - 0.6, d.hmm - y0 - 3, "#1a1814", 0.9)
      continue
    }
    d.line(x, y0, x, d.hmm, 0.25, INK.black, 0.5)
    d.ctx.save()
    d.ctx.translate(x + tw / 2 + 1.3, d.hmm - 4)
    d.ctx.rotate(-Math.PI / 2)
    d.print(text, 0, 0, { pt: 7.5, weight })
    d.ctx.restore()
  }
  d.line(4, y0, d.wmm - 4, y0, 0.2, INK.black, 0.4)
}

// Evacuation maps: plan of the main block per storey (x −54.65..34.65, z −21.65..21.65; north up), rooms from the
// building program, routes to the core stair and the west fire escape (ground: lobby, staff entrance, dock).
type R = [x0: number, x1: number, z0: number, z1: number, label: string]
const SERVICE: R[] = [[-47.8, -42.15, 1.75, 6.4, "EL"], [-47.8, -42.15, 6.55, 10.6, "TC"], [-36, -32.75, 1.75, 9.6, "WC-M"], [-32.6, -29.4, 1.75, 5, "JC"], [-32.6, -29.4, 5.15, 9.6, "ST"], [-29.25, -26.2, 1.75, 9.6, "WC-W"]]
const FLOORS: Record<number, { name: string; rooms: R[] }> = {
  0: {
    name: "GROUND FLOOR — FRONT OF HOUSE, SECURITY, RECEIVING",
    rooms: [
      [-54.65, -47.8, -13, -1.75, "0-10 STAFF ENT."], [-54.65, -47.8, -21.65, -13.15, "0-11 HEALTH"], [-47.8, -42.4, -14, -1.75, "0-12"], [-42.4, -37, -14, -1.75, "0-13"],
      [-47.8, -40, -21.65, -14.15, "0-14 DECON"], [-40, -37, -21.65, -14.15, "0-15"], [-37, -25.65, -21.65, -1.75, "0-16 RECEIVING"], [-25.5, -17, -9.6, -1.75, "0-17 LAB"],
      [-25.5, -15.4, -21.65, -9.75, "0-17 CORE STORE"], [-15.4, -4.6, -21.65, -1.75, "0-18 REPRO"], [-4.6, 6.2, -21.65, -1.75, "0-19 MAIL"], [6.2, 11.6, -21.65, -1.75, "0-20 PBX"],
      [11.6, 22.4, -21.65, -1.75, "0-21 BLDG CTRL"], [22.4, 34.65, -21.65, -1.75, "0-22 STORES"], [-54.65, -47.8, 1.75, 10.6, "0-30 FACILITIES"], [-54.65, -47.8, 10.75, 21.65, "0-31 SHOP"],
      [-36, -20.8, 9.75, 21.65, "0-35 AUDITORIUM"], [-20.8, -9.15, 1.75, 21.65, "0-36 BADGES"], [-9, 9, 9, 21.65, "0-01 LOBBY"], [1.75, 17, 1.75, 8.85, "0-37 GUARDS"],
      [9.15, 17, 9, 21.65, "0-38 SECURITY"], [17, 34.65, 1.75, 21.65, "0-39 CAFETERIA"],
    ],
  },
  1: {
    name: "FIRST FLOOR — PROGRAM ADMINISTRATION",
    rooms: [
      [-54.65, -37, -21.65, -1.75, "1-01 RECORDS"], [-37, -26.2, -11.85, -1.75, "1-02 CONF A"], [-26.2, -15.4, -11.85, -1.75, "1-03 CONTRACTS"], [-37, -15.4, -21.65, -12, "1-04..07"],
      [-15.4, -10, -11.85, -1.75, "1-08"], [-10, 11.6, -21.65, -1.75, "1-09 PERSONNEL & PAYROLL"], [17, 34.65, -21.65, -1.75, "1-10 LIBRARY"], [-54.65, -47.8, 1.75, 21.65, "1-20 WORD PROC."],
      [-47.8, -42.15, 10.75, 21.65, "1-22"], [-26.2, 22.4, 1.75, 21.65, "1-24 PROGRAM OFFICE"], [22.4, 34.65, 9.75, 21.65, "1-25 CONF B"], [22.4, 34.65, 1.75, 9.6, "1-26"],
    ],
  },
  2: {
    name: "SECOND FLOOR — SAMPLE SCIENCES",
    rooms: [
      [-54.65, -47.8, -11.85, -1.75, "2-01 CHEM"], [-54.65, -42.4, -21.65, -12, "2-02 GEOCHEM 1"], [-47.8, -42.4, -11.85, -1.75, "2-03"], [-42.4, -31.6, -21.65, -1.75, "2-04 GEOCHEM 2"],
      [-31.6, -20.8, -21.65, -1.75, "2-05 MICRO"], [-20.8, -15.4, -11.85, -1.75, "2-06 COLD"], [-15.4, -4.6, -21.65, -1.75, "2-07 ARCHIVE"], [-4.6, 6.2, -21.65, -1.75, "2-08"],
      [6.2, 17, -21.65, -1.75, "2-09 DARKROOM"], [17, 34.65, -21.65, -1.75, "2-10 CONTAINMENT"], [-54.65, -47.8, 1.75, 21.65, "2-20 SAFETY"], [-47.8, -42.15, 10.75, 21.65, "2-22 GAS"],
      [-36, -20.8, 9.75, 21.65, "2-24 TEACHING"], [-20.8, -4.6, 1.75, 21.65, "2-25 ELECTRONICS"], [-4.6, 6.2, 1.75, 21.65, "2-26 BREAK"], [6.2, 22.4, 1.75, 21.65, "2-27 ANALYTICAL 4"],
      [22.4, 34.65, 1.75, 9.6, "2-28"], [22.4, 34.65, 9.75, 21.65, "2-29"],
    ],
  },
  3: {
    name: "THIRD FLOOR — COMPUTING & SIGNAL PROCESSING",
    rooms: [
      [-54.65, -47.8, -21.65, -1.75, "3-01 DATA CTRL"], [-47.8, -37, -21.65, -1.75, "3-02 KEYPUNCH"], [-37, -31.6, -21.65, -1.75, "3-03 UPS"], [-31.6, -4.6, -11.85, -1.75, "3-04 MACHINE ROOM"],
      [-31.6, -15.4, -21.65, -12, "3-05 TAPES"], [-15.4, -4.6, -21.65, -12, "3-06 OPS"], [-4.6, 0.8, -21.65, -1.75, "3-07"], [0.8, 11.6, -21.65, -1.75, "3-08 LISTENING"],
      [11.6, 34.65, -21.65, -1.75, "3-09 ANALYSIS"], [-54.65, -47.8, 1.75, 21.65, "3-20 REST"], [-47.8, -42.15, 10.75, 21.65, "3-22"], [-26.2, -4.6, 1.75, 21.65, "3-24 TERMINALS"],
      [-4.6, 34.65, 1.75, 21.65, "3-25 PROGRAMMERS"],
    ],
  },
  4: {
    name: "FOURTH FLOOR — DIRECTORATE (WEST: CLOSED FOR REFURBISHMENT)",
    rooms: [
      [-54.65, -4.6, -21.65, -1.75, "4-01  NO ENTRY — CONSTRUCTION"], [-36, -4.6, 9.75, 21.65, "4-02  NO ENTRY"], [-54.65, -47.8, 1.75, 21.65, "4-04"], [-4.6, 0.8, -21.65, -1.75, "4-16"],
      [0.8, 11.6, -21.65, -1.75, "4-11 RECEIVER"], [11.6, 34.65, -21.65, -1.75, "4-12 CONFERENCE"], [-4.6, 0.8, 1.75, 21.65, "4-15"], [0.8, 11.6, 1.75, 21.65, "4-10 RECEPTION"],
      [11.6, 22.4, 12.15, 21.65, "4-13"], [22.4, 34.65, 9.75, 21.65, "4-14 DIRECTOR"],
    ],
  },
}

function evacMap(storey: number): DocSpec {
  const f = FLOORS[storey]!
  return {
    id: `map_evac_${storey}`,
    title: `Evacuation route map, storey ${storey}`,
    size: [0.279, 0.216],
    paper: "white",
    tags: ["wall"],
    density: 2.9,
    draw(d) {
      d.print("EMERGENCY EVACUATION ROUTE", 12, 13, { pt: 15, weight: 800 })
      d.print(`${STATION} · MAIN BLOCK · ${f.name}`, 12, 19, { pt: 7 })
      d.print("IN CASE OF FIRE USE STAIRS · DO NOT USE ELEVATOR OR FREIGHT LIFT", d.wmm - 12, 13, { pt: 6.5, weight: 700, align: "right", color: "#b3261e" })
      const s = (d.wmm - 24) / 89.3
      const X = (x: number) => 12 + (x + 54.65) * s
      const Z = (z: number) => 30 + (z + 21.65) * s
      const box = ([x0, x1, z0, z1, label]: R, fill?: string, pt = 4.6) => {
        d.rect(X(x0), Z(z0), (x1 - x0) * s, (z1 - z0) * s, 0.25, INK.black, fill)
        const w = (x1 - x0) * s
        const words = label.split(" ")
        const lines = w < 20 && words.length > 1 ? [words[0]!, words.slice(1).join(" ")] : [label]
        lines.forEach((l, i) => d.print(l, X((x0 + x1) / 2), Z((z0 + z1) / 2) + 1 + (i - (lines.length - 1) / 2) * 2.2, { pt: w < 12 ? pt * 0.8 : pt, align: "center", alpha: 0.85 }))
      }
      d.rect(X(-54.65), Z(-21.65), 89.3 * s, 43.3 * s, 0.9)
      for (const r of f.rooms) box(r, storey === 4 && r[4].includes("NO ENTRY") ? "#dcd6c8" : undefined)
      for (const r of SERVICE) box(r, "#e4dfd2", 3.6)
      // Core: stair, lift; spine.
      box([-43.25, -36.15, 1.75, 9.6, "STAIR · ELEV"], "#cfc9bb", 4)
      d.line(X(-54.65), Z(-1.6), X(34.65), Z(-1.6), 0.15)
      d.line(X(-54.65), Z(1.6), X(34.65), Z(1.6), 0.15)
      box([5.4, 6.6, -4.6, -3.4, ""], "#9a9488")
      d.print("W-1", X(6), Z(-5.4), { pt: 3.6, align: "center" })
      if (storey === 0) {
        box([-36.85, -33.25, -20.5, -15.5, "FL-1"], "#9a9488", 3.6)
      }
      // Fire escape (west end of the spine) and the route arrows along the spine.
      d.fill(X(-54.65) - 4, Z(-1.6), 4, 3.2 * s, "#b3261e")
      d.print("FIRE ESC.", X(-54.65) - 2, Z(-1.6) - 1.2, { pt: 4.2, align: "center", color: "#b3261e", weight: 700 })
      const here = storey === 0 ? 0 : -39.5
      const route = (x0: number, x1: number) => {
        d.line(X(x0), Z(0), X(x1), Z(0), 1.1, "#b3261e", 0.95)
        const sgn = Math.sign(x1 - x0)
        d.ctx.save()
        d.ctx.fillStyle = "#b3261e"
        d.ctx.beginPath()
        d.ctx.moveTo(X(x1) + sgn * 2.4, Z(0))
        d.ctx.lineTo(X(x1) - sgn * 0.8, Z(0) - 1.9)
        d.ctx.lineTo(X(x1) - sgn * 0.8, Z(0) + 1.9)
        d.ctx.fill()
        d.ctx.restore()
      }
      route(34, -38.5)
      route(-43, -54)
      if (storey === 0) {
        d.line(X(0), Z(0), X(0), Z(21.4), 1.1, "#b3261e", 0.95)
        d.print("MAIN EXIT", X(0), Z(21.65) + 3.5, { pt: 5.5, weight: 800, align: "center", color: "#b3261e" })
      }
      d.ctx.save()
      d.ctx.fillStyle = "#b3261e"
      d.ctx.beginPath()
      d.ctx.arc(X(here), Z(storey === 0 ? 18.5 : 12), 2.2, 0, Math.PI * 2)
      d.ctx.fill()
      d.ctx.restore()
      d.print("YOU ARE HERE", X(here) + 3.5, Z(storey === 0 ? 18.5 : 12) + 1.2, { pt: 6, weight: 800, color: "#b3261e" })
      d.print("ASSEMBLY POINT: SOUTH LOT, BY THE FLAGPOLE.  DO NOT ASSEMBLE IN THE NORTH LOT.", 12, d.hmm - 14, { pt: 7.5, weight: 700 })
      d.print(`Protective Services ext. ${EXT.security} · Emergency ext. ${EXT.emergency} · Plan rev. 6/84`, 12, d.hmm - 9, { pt: 6.5 })
      if (storey === 0) d.print("FL-1 and the Sublevel are not exits.", d.wmm - 12, d.hmm - 9, { pt: 6.5, align: "right" })
      if (storey === 4) d.hand("west side — keep out (by order)", 30, Z(-12), { pt: 13, color: INK.black, font: "Caveat", slant: -0.03 })
    },
  }
}

/** Engraved plastic door plate: white letters on charcoal, two screws. */
function plate(id: string, title: string, lines: [string, string?], o: { sub?: string; color?: string } = {}): DocSpec {
  return {
    id,
    title,
    size: PLATE,
    paper: "plate",
    tags: ["wall"],
    density: 1.9,
    draw(d) {
      d.fill(0, 0, d.wmm, d.hmm, o.color ?? "#2b2e31")
      d.rect(2, 2, d.wmm - 4, d.hmm - 4, 0.5, "#c9c6bd")
      d.print(lines[0], d.wmm / 2, lines[1] ? 32 : 44, { pt: 44, font: "Archivo Black", align: "center", color: "#e9e6dc" })
      if (lines[1]) d.print(lines[1], d.wmm / 2, 52, { pt: 17, font: "Libre Franklin", weight: 700, align: "center", color: "#e9e6dc", spacing: 1.2 })
      if (o.sub) d.print(o.sub, d.wmm / 2, 66, { pt: 10, font: "Libre Franklin", weight: 600, align: "center", color: "#e0b34a", spacing: 0.6 })
      for (const x of [8, d.wmm - 8]) {
        d.ctx.save()
        d.ctx.fillStyle = "#9a9ca0"
        d.ctx.beginPath()
        d.ctx.arc(x, d.hmm / 2, 2.2, 0, Math.PI * 2)
        d.ctx.fill()
        d.line(x - 1.6, d.hmm / 2, x + 1.6, d.hmm / 2, 0.5, "#444", 0.8)
        d.ctx.restore()
        d.gloss.push([x - 3, d.hmm / 2 - 3, 6, 6, 0])
      }
    },
  }
}

/** Punched time card (one of the six "SL" cards: IN 22:58, never OUT). */
function timeCard(id: string, name: string, number: string): DocSpec {
  return {
    id,
    title: `Time card: ${name} (SL, punched IN 22:58)`,
    size: [0.0825, 0.187],
    paper: "timecard",
    tags: ["wall", "desk", "creepy"],
    density: 4.2,
    draw(d) {
      d.print("PINE HOLLOW STA.", d.wmm / 2, 8, { pt: 8, weight: 800, align: "center" })
      d.print("WEEKLY TIME CARD", d.wmm / 2, 12.5, { pt: 6, align: "center" })
      d.print("NO.", 5, 20, { pt: 6, weight: 700 })
      d.type(number, 14, 20.5, { pt: 11, font: "Courier Prime" })
      d.print("NAME", 5, 27, { pt: 6, weight: 700 })
      d.hand(name, 16, 27.5, { pt: 15, color: INK.black })
      d.print("DEPT.", 5, 34, { pt: 6, weight: 700 })
      d.hand("Field Ops — SL", 18, 34.5, { pt: 13, color: INK.black })
      d.print("WEEK ENDING  OCT 20 1984", 5, 41, { pt: 6, weight: 700 })
      const cols = ["IN", "OUT", "IN", "OUT"]
      cols.forEach((c, i) => d.print(c, 14 + i * 16 + 6, 49, { pt: 6, weight: 700, align: "center" }))
      const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
      for (let r = 0; r <= 7; r++) d.line(4, 50.5 + r * 17, d.wmm - 4, 50.5 + r * 17, 0.2)
      for (let c = 0; c <= 4; c++) d.line(14 + c * 16, 46, 14 + c * 16, 50.5 + 7 * 17, 0.2)
      days.forEach((s, r) => d.print(s, 4.5, 50.5 + r * 17 + 9.5, { pt: 5.5, weight: 700 }))
      const punch = (r: number, c: number, t: string, day: string, color = "#5a2a6a") =>
        d.type(`${day} ${t}`, 14 + c * 16 + 1.2, 50.5 + r * 17 + 10, { pt: 7.5, font: "Courier Prime", color, fade: 0.9 })
      punch(0, 0, "06:56", "M", INK.black)
      punch(0, 1, "15:04", "M", INK.black)
      punch(1, 0, "06:58", "T", INK.black)
      punch(1, 1, "15:01", "T", INK.black)
      punch(2, 0, "22:58", "W")
      d.print("SL", d.wmm - 8, 21, { pt: 16, font: "Archivo Black", align: "center", color: "#a3241c" })
    },
  }
}

const DOCS: DocSpec[] = [
  {
    id: "memo_signin",
    title: "Memo: night sign-in at the lobby guard desk",
    size: LETTER,
    paper: "white",
    tags: ["board", "desk", "clipboard"],
    draw(d) {
      letterhead(d)
      const y = memoHead(d, "All Station Personnel", "G. Pruitt, Chief, Protective Services", "October 9, 1984", "Night sign-in (after 2200)")
      const body =
        "Effective Monday 15 October, all personnel remaining on station after 2200 hours will sign in AND out at the lobby guard desk (0-01). This includes contractors on the fourth floor and visiting staff from IOPS.\n" +
        "Receiving (0-16), the FL-1 gates and the W-1 riser cupboards are to be shut and locked overnight on every floor. If you find any of them open, do not go in. Close what you can and call Protective Services, ext. " + EXT.security + ".\n" +
        "Several entries last week showed a sign-in with no sign-out. I am sure these are oversights. Please be careful.\n" +
        "Questions to my office, 0-38."
      const yy = d.typeLines(d.wrap(body, 62), 25, y, 4.5)
      d.hand("GP", 128, yy + 10, { pt: 22, font: "Nothing You Could Do", color: INK.black })
      d.type("GP/dla", 25, yy + 22, { pt: 9 })
      d.type("cc: Director (4-14), Facilities & Plant, File PS-117", 25, yy + 27, { pt: 9 })
      d.stamp(["RECEIVED", "OCT 11 1984", "FACILITIES"], 160, 34, -0.12)
      d.holes(d.wmm / 2, 6)
      d.crease(0, d.hmm / 3, d.wmm, d.hmm / 3)
      d.crease(0, (d.hmm * 2) / 3, d.wmm, (d.hmm * 2) / 3)
    },
  },
  {
    id: "memo_carbon_inventory",
    title: "Carbon copy: Sublevel equipment inventory",
    size: LETTER,
    paper: "onion",
    tags: ["desk", "clipboard"],
    draw(d) {
      const o = { color: INK.carbon, carbon: true, fade: 0.85 }
      d.type(AGENCY + " - " + STATION, 25, 20, { ...o, pt: 8.5 })
      const y = memoHead(d, "H. Yost, Property Control", "P. Moreau, Field Operations (SL)", "Oct. 3, 1984", "Inventory, Sublevel (SL)", 32, o)
      const items = [
        "QTY  DESCRIPTION                           TAG NO.",
        " 6   Dosimeter, film badge                 PHS-40871..76",
        " 1   Sensor head, SL-ARRAY 2               PHS-40904",
        " 4   Headset, closed back                  PHS-41022",
        " 1   Strip-chart recorder, 6-ch.           PHS-38815",
        " 1   Lamp, caged, 24 V (FL-1 car)          PHS-39760",
        " 12  Core trays, 1 m                       --",
        " 6   Cot, folding                          PHS-12002..07",
        " 1   Cot, folding                          MISSING",
      ]
      let yy = d.typeLines(items, 25, y, 4.6, { ...o, font: "Courier Prime" })
      yy = d.typeLines(d.wrap("Item tagged MISSING last signed for on the night of 9/28. FL-1 inner gate latch replaced 10/2. Recommend the W-1 trunk cupboard alarm on 3 and 4 be reconnected. Request 6 replacement badges (see Lab Safety, 2-20).", 62), 25, yy + 6, 4.6, o)
      d.type("PM:dk     cc: File, Protective Services (2)", 25, yy + 10, { ...o, pt: 9 })
      d.crease(0, d.hmm / 2, d.wmm, d.hmm / 2, 0.6)
    },
  },
  {
    id: "notice_sublevel",
    title: "Notice: unauthorized access to the Sublevel",
    size: LETTER,
    paper: "white",
    tags: ["board", "wall", "creepy"],
    copy: true,
    draw(d) {
      letterhead(d)
      d.print("NOTICE TO ALL PERSONNEL", d.wmm / 2, 48, { pt: 18, weight: 800, align: "center", spacing: 0.8 })
      d.print("Unauthorized access to the Sublevel (SL)", d.wmm / 2, 58, { pt: 12, weight: 600, align: "center" })
      const body = [
        "Freight lift FL-1 serves the Sublevel ONLY and is restricted to",
        "Field Operations staff holding a SUBLEVEL keycard and a dosimeter.",
        "Passenger lift and stair users: there is no SL stop. Do not ask.",
        "",
        "Sounds reported from the FL-1 shaft or from the W-1 riser",
        "cupboards on any floor are to be logged on IOPS Form 41-C and",
        "are NOT to be investigated. Do not open a W-1 cupboard to check",
        "on anyone. Telephone Protective Services, ext. " + EXT.security + ", instead.",
        "",
        "If FL-1 is called to the ground floor and no one is in the car,",
        "close both gates and                                                    .",
      ]
      body.forEach((l, i) => d.print(l, 28, 76 + i * 5.6, { pt: 10 }))
      d.redact(58, 76 + 10 * 5.6 - 3.6, 100)
      d.redact(28, 76 + 11 * 5.6 - 3.6, 152)
      d.redact(28, 76 + 12 * 5.6 - 3.6, 74)
      d.print("By order of the Director · Station Order 84-31", d.wmm / 2, 168, { pt: 8.5, align: "center" })
      d.stamp(["RESTRICTED", "FIELD OPERATIONS"], 150, 196, 0.1, INK.red, 13)
      d.hand("who answers ext 300?", 34, 214, { pt: 15, color: INK.pencil, font: "Reenie Beanie", slant: -0.04 })
      d.holes(d.wmm / 2, 7)
    },
  },
  {
    id: "notice_north_lot",
    title: "Notice: north lot closed",
    size: LETTER,
    paper: "white",
    tags: ["board", "wall"],
    copy: true,
    draw(d) {
      d.print("NORTH LOT", d.wmm / 2, 52, { pt: 50, font: "Oswald", weight: 700, align: "center" })
      d.print("CLOSED", d.wmm / 2, 82, { pt: 44, font: "Oswald", weight: 700, align: "center" })
      d.print("Until further notice", d.wmm / 2, 98, { pt: 14, weight: 600, align: "center" })
      const l = [
        "A ground survey is in progress in the north lot.",
        "Do not park, walk or let pets out on the north lot or the",
        "grass between it and the building. Vehicles left there",
        "will be moved by Protective Services.",
        "",
        "Please use the south lot. Night staff: walk in pairs.",
        "Report anyone on the north lot after dark to ext. " + EXT.security + ".",
      ]
      l.forEach((s, i) => d.print(s, d.wmm / 2, 120 + i * 6.4, { pt: 11, align: "center" }))
      d.print("— Facilities & Plant, ext. " + EXT.facilities, d.wmm / 2, 180, { pt: 10, align: "center" })
      d.hand("survey since 1981?", 120, 214, { pt: 14, color: INK.pencil, font: "Reenie Beanie", slant: 0.03 })
      d.holes(d.wmm / 2, 6)
      d.holes(12, 8)
    },
  },
  {
    id: "notice_firedoors",
    title: "Notice: do not prop fire doors",
    size: LETTER,
    paper: "white",
    tags: ["wall", "board"],
    draw(d) {
      d.fill(14, 14, d.wmm - 28, 46, "#a3241c", 0.95)
      d.print("DO NOT", d.wmm / 2, 34, { pt: 34, font: "Archivo Black", align: "center", color: "#f1ece0" })
      d.print("PROP FIRE DOORS", d.wmm / 2, 53, { pt: 26, font: "Archivo Black", align: "center", color: "#f1ece0" })
      const l = [
        "Fire doors must be kept closed at all times.",
        "Propping a fire door with wedges, chairs or",
        "extinguishers is a violation of Station Order 12-7.",
        "",
        "Core stair and west fire-escape doors are alarmed",
        "after 2200. If a door will not latch, report it to",
        "Facilities & Plant (ext. " + EXT.facilities + ") at once. Do not leave it.",
      ]
      l.forEach((s, i) => d.print(s, d.wmm / 2, 82 + i * 6.6, { pt: 12, align: "center" }))
      d.print("THIS DOOR TO REMAIN CLOSED", d.wmm / 2, 160, { pt: 16, weight: 800, align: "center", spacing: 0.8 })
      d.rect(14, 14, d.wmm - 28, d.hmm - 28, 0.8, "#a3241c")
      d.hand("someone keeps opening it", 40, 230, { pt: 15, color: INK.black, font: "Caveat", slant: -0.05 })
    },
  },
  {
    id: "notice_nightshift",
    title: "Notice: night shift sign in at the lobby guard desk",
    size: HALF,
    paper: "goldenrod",
    tags: ["board", "wall"],
    copy: true,
    draw(d) {
      d.print("NIGHT SHIFT", d.wmm / 2, 32, { pt: 34, font: "Oswald", weight: 700, align: "center" })
      d.print("SIGN IN AT THE LOBBY GUARD DESK AFTER 2200", d.wmm / 2, 50, { pt: 12, weight: 700, align: "center" })
      d.print("Badges visible at all times. Keycards are not to be lent.", d.wmm / 2, 64, { pt: 10, align: "center" })
      d.print("Sign OUT when you leave. Every time.", d.wmm / 2, 74, { pt: 10, weight: 700, align: "center" })
      d.print("Protective Services · ext. " + EXT.security, d.wmm / 2, 112, { pt: 8, align: "center" })
      d.holes(8, 6)
      d.holes(d.wmm - 8, 6)
    },
  },
  {
    id: "signin_sheet",
    title: "Night sign-in sheet (handwritten)",
    size: LETTER,
    paper: "white",
    tags: ["clipboard", "desk", "creepy"],
    draw(d) {
      d.print("NIGHT SIGN-IN / SIGN-OUT", d.wmm / 2, 20, { pt: 14, weight: 800, align: "center" })
      d.print("IOPS Form 41-A (Rev. 8-83) · Lobby guard desk 0-01 · Retain 90 days", d.wmm / 2, 26, { pt: 7.5, align: "center" })
      const cols = [14, 38, 92, 120, 148, 176, 202]
      const heads = ["DATE", "NAME (PRINT)", "BADGE", "TIME IN", "TIME OUT", "INIT."]
      heads.forEach((h, i) => d.print(h, cols[i]! + 1.5, 36, { pt: 7, weight: 700 }))
      for (let r = 0; r <= 26; r++) d.line(14, 38 + r * 8.6, 202, 38 + r * 8.6, r === 0 ? 0.4 : 0.18)
      for (const x of cols) d.line(x, 31, x, 38 + 26 * 8.6, 0.2)
      d.line(14, 31, 202, 31, 0.4)
      const rows: [string, string, string, string, string, string][] = [
        ["10/15", "T. Okafor", "4417", "2215", "0140", "TO"],
        ["10/15", "J. Kowalski", "4402", "2230", "0315", "JK"],
        ["10/15", "M. Brandt", "4388", "2205", "2350", "MB"],
        ["10/16", "S. Vance", "4425", "2300", "0410", "SV"],
        ["10/16", "T. Okafor", "4417", "2210", "0122", "TO"],
        ["10/17", "D. Halverson", "SL-1", "2258", "", ""],
        ["10/17", "E. Lindqvist", "SL-2", "2258", "", ""],
        ["10/17", "P. Moreau", "SL-3", "2258", "", ""],
        ["10/17", "B. Szabo", "SL-4", "2258", "", ""],
        ["10/17", "K. Dorsey", "SL-5", "2258", "", ""],
        ["10/17", "A. Nakamura", "SL-6", "2258", "", ""],
        ["10/17", "W. Farris (contr. 4th fl.)", "V-12", "2330", "0200", "WF"],
        ["10/18", "S. Vance", "4425", "2310", "", ""],
      ]
      const hands = new Map<string, { font: (typeof HANDS)[number]; color: string; slant: number }>()
      rows.forEach((row, r) => {
        const who = row[1].split(" (")[0]!
        if (!hands.has(who)) hands.set(who, { font: pick(HANDS), color: pick([INK.ballBlue, INK.black, INK.blue, INK.pencil]), slant: rr(-0.06, 0.03) })
        const h = hands.get(who)!
        const y = 38 + (r + 1) * 8.6 - 2.2
        row.forEach((v, i) => v && d.hand(v, cols[i]! + 2, y, { pt: h.font === "Caveat" ? 14 : 15, ...h }))
      })
      d.ctx.save()
      d.ctx.strokeStyle = INK.red
      d.ctx.lineWidth = 0.45
      d.ctx.globalAlpha = 0.8
      d.ctx.beginPath()
      d.ctx.moveTo(150, 38 + 6 * 8.6 - 7)
      d.ctx.bezierCurveTo(206, 38 + 6 * 8.6 - 7, 206, 38 + 11 * 8.6, 150, 38 + 11 * 8.6)
      d.ctx.stroke()
      d.ctx.restore()
      d.hand("6 down FL-1 — none out", 150, 38 + 15 * 8.6, { pt: 14, color: INK.red, font: "Caveat", slant: -0.04 })
      d.hand("see me — GP", 160, 38 + 17 * 8.6, { pt: 14, color: INK.red, font: "Caveat" })
      d.holes(d.wmm / 2, 6)
    },
  },
  {
    id: "roster_operators",
    title: "Operator watch roster, week of Oct 15 (SL names struck out)",
    size: LETTER,
    paper: "white",
    tags: ["board", "wall", "creepy"],
    draw(d) {
      letterhead(d, 16)
      d.type("COMPUTING & SIGNAL PROCESSING - OPERATOR WATCH ROSTER", 25, 38, { pt: 10.5 })
      d.type("Ops console 3-06 / Listening room 3-08 - week of 15 Oct. 1984", 25, 44, { pt: 9.5 })
      const days = ["MON 15", "TUE 16", "WED 17", "THU 18", "FRI 19", "SAT 20", "SUN 21"]
      const x0 = 22
      const cw = 24
      days.forEach((s, i) => d.type(s, x0 + 30 + i * cw, 56, { pt: 8.5 }))
      const watches = ["0700-1500", "1500-2300", "2300-0700"]
      const crew = [["Okafor", "Brandt", "Vance"], ["Kowalski", "Pell", "Lindqvist"], ["Halverson", "Szabo", "Dorsey"]]
      const sl = new Set(["Lindqvist", "Halverson", "Szabo", "Dorsey"])
      for (let w = 0; w < 3; w++) {
        d.type(watches[w]!, x0, 66 + w * 22, { pt: 9 })
        for (let i = 0; i < 7; i++)
          for (let k = 0; k < 2; k++) {
            const name = crew[w]![(i + k + w) % 3]!
            const y = 66 + w * 22 + k * 6
            d.type(name, x0 + 30 + i * cw, y, { pt: 8, font: "Courier Prime" })
            if (sl.has(name) && i >= 2) {
              d.scribble(x0 + 29 + i * cw, y - 1.2, x0 + 50 + i * cw, y - 1.4, 0.55, INK.red)
              d.scribble(x0 + 29 + i * cw, y - 0.6, x0 + 50 + i * cw, y - 1.8, 0.55, INK.red)
            }
          }
      }
      for (let w = 0; w <= 3; w++) d.line(x0, 60 + w * 22, d.wmm - 18, 60 + w * 22, 0.2)
      d.type("Swaps must be approved by the Manager, Computing (3-22).", 25, 140, { pt: 9.5 })
      d.type("Third watch: two on the console at all times. No exceptions.", 25, 145, { pt: 9.5 })
      d.hand("struck = SL rotation from Wed. Do not schedule. Do not call.", 26, 162, { pt: 14, color: INK.red, font: "Caveat", slant: -0.02 })
      d.hand("Lindqvist called the console Thurs 0300 from x300??", 30, 174, { pt: 14, color: INK.ballBlue, font: "Reenie Beanie", slant: 0.03 })
      d.holes(15, 7)
      d.holes(d.wmm - 15, 7)
      d.crease(d.wmm / 2, 0, d.wmm / 2, d.hmm, 0.5)
    },
  },
  {
    id: "roster_sl_rotation",
    title: "Records: SL rotation roster 1981–84, names crossed out in red",
    size: LETTER,
    paper: "white",
    tags: ["desk", "creepy"],
    copy: true,
    draw(d) {
      letterhead(d, 16)
      d.type("PERSONNEL - SL ROTATION 1981-84 (FIELD OPERATIONS)", 25, 38, { pt: 10.5 })
      d.type("PROGRAM ADMINISTRATION - RECORDS CENTER 1-01 - DO NOT REMOVE", 25, 43.5, { pt: 8.5 })
      const names = [
        "Abernathy, C.", "Brennan, M.", "Castellanos, R.", "Dahl, P.", "Eckhart, J.", "Fenwick, S.", "Grady, T.", "Hollis, A.",
        "Ivers, N.", "Jessup, L.", "Kranz, O.", "Lomax, B.", "Mercer, F.", "Novak, H.", "Ortega, V.", "Pace, W.", "Quill, D.", "Rourke, E.",
        "Halverson, D.", "Lindqvist, E.", "Moreau, P.", "Szabo, B.", "Dorsey, K.", "Nakamura, A.",
      ]
      d.type("ROT.  NAME              BADGE   IN       OUT", 25, 54, { pt: 9, font: "Courier Prime" })
      names.forEach((n, i) => {
        const rot = String(Math.floor(i / 6) + 1).padStart(2, "0")
        const cur = i >= 18
        const yr = ["81", "82", "83", "84"][Math.floor(i / 6)]!
        const line = `${rot}    ${n.padEnd(18)}${String(4100 + i * 7)}    ${cur ? "10/17/84" : `0${(i % 9) + 1}/${10 + (i % 18)}/${yr}`}  ${cur ? "" : "--"}`
        const y = 61 + i * 6.4
        d.type(line, 25, y, { pt: 9, font: "Courier Prime" })
        if (!cur || i % 3 === 0) d.scribble(24, y - 1.3, 178, y - 1.6, 0.5, INK.red)
      })
      d.hand("all 4 rotations — 0 OUT", 120, 230, { pt: 15, color: INK.red, font: "Caveat", slant: -0.04 })
      d.crease(0, d.hmm / 2, d.wmm, d.hmm / 2, 0.6)
    },
  },
  {
    id: "memo_next_of_kin",
    title: "Memo: SL rotation — next of kin letters (6)",
    size: LETTER,
    paper: "white",
    tags: ["desk", "creepy"],
    draw(d) {
      letterhead(d)
      const y = memoHead(d, "Chief, Program Administration (1-07)", "R. Halloran, Director", "October 18, 1984", "Re: SL rotation - next of kin letters (6)")
      const body =
        "Please have Personnel prepare letters for the next of kin of the six staff on the current SL rotation, using the 1983 wording. Do not date them. Do not send them. Hold in the vault (1-01v) until I instruct you otherwise.\n" +
        "Word processing is not to keep copies on disk. Type them yourself or have Mrs. Kemper do it after hours.\n" +
        "Payroll will continue to pay all six through the end of the quarter."
      const yy = d.typeLines(d.wrap(body, 62), 25, y, 4.6)
      d.type("Halverson, D.     Lindqvist, E.     Moreau, P.", 32, yy + 8, { pt: 9.5 })
      d.type("Szabo, B.         Dorsey, K.        Nakamura, A.", 32, yy + 13, { pt: 9.5 })
      d.hand("R. Halloran", 120, yy + 30, { pt: 20, font: "Nothing You Could Do", color: INK.black })
      d.stamp(["CONFIDENTIAL"], 150, 32, -0.08, INK.red, 12)
      d.hand("he means it this time", 40, yy + 52, { pt: 14, color: INK.pencil, font: "Reenie Beanie" })
      d.coffee(170, 240, 30, 0.3)
    },
  },
  {
    id: "letter_regret",
    title: "Half-typed letter: '…regret to inform you that…'",
    size: LETTER,
    paper: "white",
    tags: ["desk", "creepy"],
    draw(d) {
      letterhead(d)
      d.type("October    , 1984", 130, 44)
      d.type("Mrs. Ingrid Lindqvist", 25, 58)
      d.type("Rural Route 2, Box 114", 25, 63)
      d.type("Merritt Falls", 25, 68)
      d.type("Dear Mrs. Lindqvist:", 25, 82)
      const body =
        "On behalf of the Interagency Office of Propagation Studies it is my duty to write to you about your daughter Ellen, a valued member of the Field Operations staff at Pine Hollow Station since 1982. We regret to inform you that"
      d.typeLines(d.wrap(body, 62), 25, 94, 4.6)
      d.type("x", 98, 112.4, { fade: 0.4 })
    },
  },
  {
    id: "security_log",
    title: "Protective Services night log (last entry 01:40, FL-1 called)",
    size: LETTER,
    paper: "white",
    tags: ["desk", "clipboard", "creepy"],
    draw(d) {
      d.print("PROTECTIVE SERVICES — NIGHT LOG", d.wmm / 2, 18, { pt: 13, weight: 800, align: "center" })
      d.print("Security office 0-38 · IOPS Form PS-3 · one entry per round, alarm or call", d.wmm / 2, 24, { pt: 7, align: "center" })
      d.print("DATE  OCT 17-18 1984        OFFICER ON DUTY", 16, 33, { pt: 8, weight: 700 })
      d.hand("S. Vance / R. Doyle (booth)", 90, 33.5, { pt: 14, color: INK.black })
      for (let r = 0; r < 26; r++) d.line(14, 40 + r * 8.6, 202, 40 + r * 8.6, 0.18, "#5f86b8", 0.5)
      d.line(36, 36, 36, 40 + 25 * 8.6, 0.25, "#c25a50", 0.6)
      const e: [string, string][] = [
        ["22:00", "On duty. Lobby secured. 3 on station (TO, JK, MB)."],
        ["22:40", "Round 1 - all floors - OK. 4th fl west hoarding shut."],
        ["22:58", "Field Ops x6 badged thru 0-15. FL-1 down. Per Dir."],
        ["23:30", "Contractor Farris signed in (4th fl site office)."],
        ["00:10", "Booth: radio check OK. North lot dark."],
        ["00:45", "Round 2 - W-1 cupboard 3rd fl warm to touch. Locked."],
        ["01:12", "Lab 2-27 hot plate on? Light under door. Left it - R. back?"],
        ["01:25", "FL-1 call light lit at 0-15 for ~5 sec. Car still at SL."],
        ["01:40", "SL freight lift called. No one on camera."],
      ]
      e.forEach(([t, s], r) => {
        const y = 40 + (r + 1) * 8.6 - 2.2
        d.hand(t, 16, y, { pt: 14, color: INK.black })
        d.hand(s, 39, y, { pt: 13.5, color: INK.black, slant: r === 8 ? -0.02 : 0 })
      })
      d.coffee(160, 225, 34, 0.35)
      d.ctx.save()
      d.ctx.fillStyle = "rgba(60,50,40,0.35)"
      d.ctx.beginPath()
      d.ctx.ellipse(60, 230, 8, 3, 0.4, 0, Math.PI * 2)
      d.ctx.fill()
      d.ctx.restore()
    },
  },
  {
    id: "ops_log",
    title: "Operations log, console 3-06 ('03:04 — ???')",
    size: LETTER,
    paper: "white",
    tags: ["desk", "clipboard", "creepy"],
    draw(d) {
      d.print("COMPUTER OPERATIONS LOG", d.wmm / 2, 18, { pt: 13, weight: 800, align: "center" })
      d.print("Computing & Signal Processing · Console 3-06 · log every IPL, abend, tape mount and link event", d.wmm / 2, 24, { pt: 7, align: "center" })
      const cols = [14, 32, 150, 176, 202]
      ;["TIME", "EVENT / ACTION", "JOB", "OPER"].forEach((h, i) => d.print(h, cols[i]! + 1.5, 34, { pt: 7, weight: 700 }))
      for (let r = 0; r <= 24; r++) d.line(14, 36 + r * 8.8, 202, 36 + r * 8.8, r === 0 ? 0.4 : 0.18)
      for (const x of cols) d.line(x, 29, x, 36 + 24 * 8.8, 0.2)
      const e: [string, string, string, string][] = [
        ["23:00", "Shift change. Mounted RCV-288 / RCV-289.", "SIGLOG", "TO"],
        ["23:41", "Tape 3 read error, remount, OK.", "SIGLOG", "TO"],
        ["00:15", "Halon panel trouble lamp - reset.", "", "TO"],
        ["01:02", "Listening rm (3-08) strip chart out of paper. Reloaded.", "", "TO"],
        ["01:58", "W-1 trunk noise floor +6 dB, all channels.", "SIGLOG", "TO"],
        ["02:30", "Print run to 3-01, HALVERSON pigeonhole full.", "SLRPT", "TO"],
        ["03:02", "SL link up.", "SLLNK", "TO"],
      ]
      e.forEach((row, r) => row.forEach((v, i) => v && d.hand(v, cols[i]! + 2, 36 + (r + 1) * 8.8 - 2.2, { pt: 14, color: INK.ballBlue })))
      const y = 36 + 8 * 8.8 - 2.2
      d.hand("03:04", cols[0]! + 2, y, { pt: 14, color: INK.ballBlue })
      d.hand("— ???", cols[1]! + 4, y + 0.6, { pt: 20, color: INK.ballBlue, font: "Nothing You Could Do", slant: -0.12 })
      d.scribble(cols[1]! + 22, y - 1, cols[1]! + 60, y + 3, 0.45, INK.ballBlue)
      d.holes(d.wmm / 2, 6)
    },
  },
  {
    id: "work_order_halt",
    title: "Work order: halt all work 4th floor, by order of the Director",
    size: HALF,
    paper: "yellow",
    tags: ["desk", "board", "creepy"],
    draw(d) {
      d.print("FACILITIES & PLANT — WORK ORDER", 12, 14, { pt: 11, weight: 800 })
      d.print("No. 84-1192", d.wmm - 12, 14, { pt: 10, weight: 700, align: "right", color: INK.red })
      const box = (x: number, y: number, w: number, h: number, label: string, val: string, hand = false) => {
        d.rect(x, y, w, h, 0.3)
        d.print(label, x + 1.2, y + 3, { pt: 5.5 })
        hand ? d.hand(val, x + 2, y + h - 2.4, { pt: 14, color: INK.black }) : d.type(val, x + 2, y + h - 2.4, { pt: 10 })
      }
      box(12, 20, 70, 12, "DATE", "SEPT. 26, 1984")
      box(82, 20, 122, 12, "LOCATION", "4TH FLOOR - WEST (4-01, 4-02, 4-04)")
      box(12, 32, 192, 40, "WORK TO BE DONE", "")
      d.type("HALT ALL WORK 4TH FLOOR - BY ORDER OF THE", 16, 44, { pt: 12 })
      d.type("DIRECTOR. CONTRACTOR TO VACATE. DO NOT", 16, 50, { pt: 12 })
      d.type("REMOVE THE PANEL MARKED \"DO NOT DEMO\".", 16, 56, { pt: 12 })
      d.type("W-1 CUPBOARD NOT TO BE OPENED.", 16, 62, { pt: 12 })
      box(12, 72, 96, 14, "REQUESTED BY", "R. Halloran", true)
      box(108, 72, 96, 14, "CONTRACTOR ACK.", "W. Farris", true)
      d.stamp(["HOLD"], 170, 100, -0.15, INK.red, 18)
      d.hand("still not paid for Sept — WF", 16, 104, { pt: 14, color: INK.pencil, font: "Reenie Beanie" })
      d.holes(d.wmm / 2, 5)
    },
  },
  {
    id: "work_order_night",
    title: "Night janitor work order (the player's task list)",
    size: LETTER,
    paper: "white",
    tags: ["clipboard", "desk"],
    draw(d) {
      d.print("FACILITIES & PLANT — NIGHT WORK ORDERS", d.wmm / 2, 18, { pt: 13, weight: 800, align: "center" })
      d.print("Custodial, third shift · Wed/Thurs Oct 17–18 1984 · pick up keys from the cabinet in 0-30", d.wmm / 2, 24, { pt: 7.5, align: "center" })
      const tasks: [string, string][] = [
        ["GROUND", "Stock cart from JC-0. Mop lobby 0-01. Empty cafeteria bins."],
        ["1ST", "Empty bins, cubicle area 1-24 + offices 1-04..07. Vacuum Conf. A."],
        ["2ND", "Mop glasswash 2-28 (wet floor signs!). Check 2-27 hot plate OFF."],
        ["3RD", "Breakers trip after 0200 - reset in EL-3. Do NOT touch 3-03."],
        ["4TH", "DO NOT ENTER - see W.O. 84-1192. East side (Directorate) only if called."],
        ["", "Do not open W-1 cupboards on any floor. Not ours."],
      ]
      tasks.forEach(([f, s], i) => {
        const y = 40 + i * 13
        d.checkbox(16, y, 4, i < 1)
        d.print(f, 24, y, { pt: 10, weight: 800 })
        d.type(s, 46, y, { pt: 9.5 })
      })
      d.print("Keys issued: master J (janitor), EL/JC. NOT issued: Comms, Sublevel, Server, Signal, Containment.", 16, 130, { pt: 8 })
      d.hand("If the Director calls down, do what he says and don't ask. — Supv.", 16, 150, { pt: 14, color: INK.ballBlue, font: "Caveat" })
      d.hand("radio is ch. 2. booth is ch. 3.", 16, 162, { pt: 14, color: INK.ballBlue, font: "Caveat" })
      d.holes(d.wmm / 2, 6)
      d.coffee(170, 230, 32, 0.28)
    },
  },
  {
    id: "log_shower_test",
    title: "Weekly safety-shower test log (blank after Oct 3)",
    size: LETTER,
    paper: "white",
    tags: ["wall", "clipboard", "creepy"],
    draw(d) {
      d.print("EYEWASH & DRENCH SHOWER — WEEKLY TEST", d.wmm / 2, 18, { pt: 13, weight: 800, align: "center" })
      d.print("Lab Safety Office 2-20 · flush 3 min, check clear water, initial · ext. " + EXT.labSafety, d.wmm / 2, 24, { pt: 7.5, align: "center" })
      const cols = [14, 44, 76, 108, 140, 172, 202]
      ;["WEEK OF", "2-02", "2-04", "2-05", "2-10", "2-24"].forEach((h, i) => d.print(h, cols[i]! + 2, 34, { pt: 7, weight: 700 }))
      for (let r = 0; r <= 22; r++) d.line(14, 36 + r * 9, 202, 36 + r * 9, r === 0 ? 0.4 : 0.18)
      for (const x of cols) d.line(x, 29, x, 36 + 22 * 9, 0.2)
      const weeks = ["7/2", "7/9", "7/16", "7/23", "7/30", "8/6", "8/13", "8/20", "8/27", "9/3", "9/10", "9/17", "9/24", "10/1", "10/8", "10/15"]
      const h = { font: "Caveat" as const, color: INK.ballBlue }
      weeks.forEach((w, r) => {
        const y = 36 + (r + 1) * 9 - 2.5
        d.hand(w + "/84", cols[0]! + 2, y, { pt: 13, color: INK.black })
        if (r < 14) for (let c = 1; c < 6; c++) d.hand(r === 13 && c > 2 ? "" : "LP", cols[c]! + 8, y, { pt: 13, ...h })
      })
      d.hand("3 Oct last test — L. Pruitt", 60, 36 + 17 * 9, { pt: 13, color: INK.pencil, font: "Reenie Beanie" })
      d.holes(d.wmm / 2, 6)
    },
  },
  {
    id: "signup_bowling",
    title: "Bowling league sign-up sheet",
    size: LETTER,
    paper: "white",
    tags: ["board", "clipboard"],
    draw(d) {
      d.print("FALL BOWLING LEAGUE — SIGN UP", d.wmm / 2, 22, { pt: 15, weight: 800, align: "center" })
      d.print("Thursdays 7:00 PM · Pine Hollow Lanes · teams of four · $3/week incl. shoes", d.wmm / 2, 29, { pt: 8, align: "center" })
      d.print("NAME", 22, 42, { pt: 8, weight: 700 })
      d.print("EXT.", 100, 42, { pt: 8, weight: 700 })
      d.print("AVG", 128, 42, { pt: 8, weight: 700 })
      d.print("TEAM / NOTES", 150, 42, { pt: 8, weight: 700 })
      for (let r = 0; r < 24; r++) d.line(18, 45 + r * 9, 200, 45 + r * 9, 0.18)
      const e: [string, string, string, string][] = [
        ["Doris Kemper", EXT.payroll, "142", "Payroll Pinheads (capt.)"],
        ["Gary Pell", EXT.ops, "168", "Payroll Pinheads"],
        ["Ted Okafor", EXT.ops, "110?", "anywhere"],
        ["Marge Duquette", EXT.cafeteria, "151", "w/ Doris"],
        ["Bill Szabo", EXT.fieldOps, "175", "Field Ops"],
        ["Kevin Dorsey", EXT.fieldOps, "", "Field Ops"],
        ["Ellen Lindqvist", EXT.fieldOps, "131", "Field Ops"],
        ["Jan Kowalski", EXT.ops, "155", "whoever needs 1"],
      ]
      e.forEach((row, r) => {
        const h = { font: pick(HANDS), color: pick([INK.ballBlue, INK.black, INK.blue]), slant: rr(-0.05, 0.03) }
        row.forEach((v, i) => v && d.hand(v, [22, 100, 128, 150][i]!, 45 + (r + 1) * 9 - 2.5, { pt: 15, ...h }))
      })
      d.hand("Field Ops no-show 3 wks — forfeit", 60, 45 + 10 * 9, { pt: 14, color: INK.red, font: "Caveat" })
      d.holes(d.wmm / 2, 6)
      d.coffee(160, 230, 36, 0.3)
    },
  },
  {
    id: "flyer_bowling",
    title: "Bowling league flyer with tear-off tabs",
    size: LETTER,
    paper: "goldenrod",
    tags: ["board", "wall"],
    copy: true,
    draw(d) {
      d.print("STRIKE UP", d.wmm / 2, 34, { pt: 44, font: "Archivo Black", align: "center" })
      d.print("THE FALL!", d.wmm / 2, 54, { pt: 36, font: "Archivo Black", align: "center" })
      d.image("bowling", 58, 62, 100, 82, "grayscale(1) contrast(1.4)", 0.9)
      d.print("STATION BOWLING LEAGUE", d.wmm / 2, 158, { pt: 16, weight: 800, align: "center", spacing: 0.5 })
      d.print("Thursdays · 7 PM · Pine Hollow Lanes, Route 9", d.wmm / 2, 167, { pt: 11, align: "center" })
      d.print("Season starts October 4 · teams of four · all skill levels", d.wmm / 2, 174, { pt: 10, align: "center" })
      d.print("See Doris in Payroll (1-09) or call ext. " + EXT.payroll, d.wmm / 2, 184, { pt: 11, weight: 700, align: "center" })
      tabs(d, 9, 232, "BOWLING · Doris x" + EXT.payroll, [2, 5, 6])
    },
  },
  {
    id: "poster_missing_cat",
    title: "Missing cat poster (Biscuit)",
    size: LETTER,
    paper: "white",
    tags: ["board", "wall", "creepy"],
    copy: true,
    draw(d) {
      d.hand("MISSING CAT", 22, 34, { pt: 52, font: "Permanent Marker", color: "#151515" })
      d.image("cat", 33, 44, 150, 112, "grayscale(1) contrast(1.6) brightness(1.05)")
      d.rect(33, 44, 150, 112, 0.3)
      d.hand("\"BISCUIT\"", 70, 172, { pt: 34, font: "Permanent Marker", color: "#151515" })
      const l = ["Grey long-hair tabby, 9 yrs, very friendly. Answers to Biscuit.", "Last seen by the RECEIVING DOCK on Tues. Oct 2 around 11 PM.", "He never goes near the north lot. Please check sheds and garages."]
      l.forEach((s, i) => d.print(s, d.wmm / 2, 186 + i * 6, { pt: 10, align: "center" }))
      d.print("REWARD · Marge Duquette, Cafeteria, ext. " + EXT.cafeteria + " or 555-0142", d.wmm / 2, 210, { pt: 10.5, weight: 800, align: "center" })
      d.hand("on the dock camera 10/9 3am, by FL-1 gate? — S.V.", 26, 226, { pt: 14, color: INK.ballBlue, font: "Reenie Beanie", slant: -0.03 })
      tabs(d, 8, 238, "BISCUIT 555-0142", [1, 4], 700)
      d.holes(d.wmm / 2, 6)
    },
  },
  {
    id: "menu_cafeteria",
    title: "Cafeteria menu, week of Oct 15 1984",
    size: LETTER,
    paper: "white",
    tags: ["board", "wall"],
    draw(d) {
      d.print("STATION CAFETERIA", d.wmm / 2, 24, { pt: 22, font: "Oswald", weight: 700, align: "center", spacing: 1 })
      d.print("ROOM 0-39 · MENU — WEEK OF OCTOBER 15, 1984", d.wmm / 2, 32, { pt: 11, weight: 700, align: "center" })
      d.print("Hot line 11:15–1:30 · Night staff: vending machines by the servery", d.wmm / 2, 38, { pt: 8, align: "center" })
      const days: [string, string[], string][] = [
        ["MONDAY", ["Chicken à la king on toast", "Buttered peas · Waldorf salad", "Chocolate pudding"], "$1.95"],
        ["TUESDAY", ["Meat loaf, brown gravy", "Mashed potatoes · stewed tomatoes", "Apple crisp"], "$2.10"],
        ["WEDNESDAY", ["Chili con carne, cornbread", "Tossed salad · Jell-O cubes", "Oatmeal cookie"], "$1.85"],
        ["THURSDAY", ["Turkey tetrazzini", "Green beans almondine", "Peach cobbler"], "$2.05"],
        ["FRIDAY", ["Fish sticks, tartar sauce", "Tater rounds · coleslaw", "Pineapple upside-down cake"], "$1.90"],
      ]
      days.forEach(([day, items, price], i) => {
        const y = 52 + i * 38
        d.print(day, 24, y, { pt: 12, weight: 800 })
        d.print(price, d.wmm - 24, y, { pt: 12, weight: 700, align: "right" })
        items.forEach((s, k) => d.print(s, 30, y + 7 + k * 5.6, { pt: 10 }))
        d.line(22, y + 26, d.wmm - 22, y + 26, 0.15, INK.black, 0.5)
      })
      d.print("Coffee 25¢ · Milk 30¢ · Soup of the day 60¢ · Field Ops box lunches: order by 2 PM", d.wmm / 2, 248, { pt: 9, align: "center" })
      d.hand("6 box lunches Wed — not picked up", 104, 120, { pt: 14, color: INK.red, font: "Caveat", slant: -0.06 })
      d.coffee(40, 220, 34, 0.32)
      d.holes(d.wmm / 2, 6)
    },
  },
  {
    id: "poster_radiation",
    title: "Safety poster: caution radiation area",
    size: TABLOID,
    paper: "poster",
    tags: ["wall"],
    density: 1.8,
    draw(d) {
      d.fill(0, 0, d.wmm, 80, "#e8c31a")
      d.print("CAUTION", d.wmm / 2, 42, { pt: 64, font: "Archivo Black", align: "center", color: "#7a1f6e" })
      d.print("RADIATION AREA", d.wmm / 2, 68, { pt: 34, font: "Archivo Black", align: "center", color: "#111" })
      const c = d.ctx
      const cx = d.wmm / 2
      const cy = 150
      c.save()
      c.fillStyle = "#e8c31a"
      c.beginPath()
      c.arc(cx, cy, 60, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = "#7a1f6e"
      for (let k = 0; k < 3; k++) {
        const a = -Math.PI / 2 + (k * 2 * Math.PI) / 3
        c.beginPath()
        c.moveTo(cx + Math.cos(a - Math.PI / 6) * 9, cy + Math.sin(a - Math.PI / 6) * 9)
        c.arc(cx, cy, 50, a - Math.PI / 6, a + Math.PI / 6)
        c.arc(cx, cy, 9, a + Math.PI / 6, a - Math.PI / 6, true)
        c.fill()
      }
      c.beginPath()
      c.arc(cx, cy, 6, 0, Math.PI * 2)
      c.fill()
      c.restore()
      const rules = ["1. Wear your dosimeter at all times beyond this point.", "2. No eating, drinking or smoking.", "3. Survey hands and shoes at the 0-14 decon exit.", "4. Return badges to the rack at 0-15 every shift.", "5. Report alarms to Lab Safety (2-20), ext. " + EXT.labSafety + "."]
      rules.forEach((s, i) => d.print(s, 26, 236 + i * 9, { pt: 13.5 }))
      d.print("LAB SAFETY OFFICE · " + STATION + " · POSTER RS-2 (1981)", d.wmm / 2, 420, { pt: 7, align: "center" })
      d.holes(10, 8)
      d.holes(d.wmm - 10, 8)
    },
  },
  {
    id: "poster_chemical",
    title: "Safety poster: chemical hazards, know your labels",
    size: TABLOID,
    paper: "poster",
    tags: ["wall"],
    density: 1.8,
    draw(d) {
      d.fill(0, 0, d.wmm, 60, "#1e4f8c")
      d.print("KNOW YOUR LABELS", d.wmm / 2, 38, { pt: 40, font: "Archivo Black", align: "center", color: "#f2efe6" })
      const c = d.ctx
      const cx = d.wmm / 2
      const cy = 140
      const s = 34
      const cells: [number, number, string, string, string][] = [
        [0, -1, "#c4302b", "3", "FLAMMABILITY"],
        [-1, 0, "#2a62b8", "2", "HEALTH"],
        [1, 0, "#e3c420", "1", "REACTIVITY"],
        [0, 1, "#f2f0ea", "W", "SPECIAL"],
      ]
      for (const [dx, dy, col, txt] of cells) {
        c.save()
        c.translate(cx + dx * s, cy + dy * s)
        c.rotate(Math.PI / 4)
        c.fillStyle = col
        c.fillRect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4)
        c.strokeStyle = "#111"
        c.lineWidth = 1
        c.strokeRect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4)
        c.restore()
        d.print(txt, cx + dx * s, cy + dy * s + 9, { pt: 40, font: "Archivo Black", align: "center", color: "#111" })
      }
      cells.forEach(([, , col, , name], i) => {
        d.fill(30, 222 + i * 22, 12, 12, col)
        d.rect(30, 222 + i * 22, 12, 12, 0.4)
        d.print(name, 48, 232 + i * 22, { pt: 15, weight: 800 })
        d.print(["0 minimal · 4 severe", "0 minimal · 4 deadly", "0 stable · 4 may detonate", "W react with water · OX oxidizer"][i]!, 140, 232 + i * 22, { pt: 11 })
      })
      d.print("When in doubt: do not mix, do not sniff, ask.", d.wmm / 2, 340, { pt: 16, weight: 700, align: "center" })
      d.print("Spills: evacuate, close the door, call ext. " + EXT.labSafety + ".", d.wmm / 2, 352, { pt: 13, align: "center" })
      d.print("Chemical store 2-01 requires the CHEM STORE key from the lab manager (2-08).", d.wmm / 2, 362, { pt: 10, align: "center" })
      d.print("LABORATORY SAFETY COMMITTEE · SAMPLE SCIENCES · POSTER LS-5", d.wmm / 2, 420, { pt: 7, align: "center" })
      d.holes(10, 8)
      d.holes(d.wmm - 10, 8)
      d.crease(0, d.hmm / 2, d.wmm, d.hmm / 2, 0.8)
    },
  },
  evacMap(0),
  evacMap(1),
  evacMap(2),
  evacMap(3),
  evacMap(4),
  {
    id: "form_requisition",
    title: "Lab supply requisition form (IOPS 113-B)",
    size: LETTER,
    paper: "white",
    tags: ["desk", "clipboard"],
    draw(d) {
      d.print("IOPS FORM 113-B (Rev. 3-82)", 14, 12, { pt: 7 })
      d.print("LABORATORY SUPPLY REQUISITION", d.wmm / 2, 22, { pt: 14, weight: 800, align: "center" })
      d.print("SAMPLE SCIENCES · " + STATION, d.wmm / 2, 28, { pt: 7.5, align: "center" })
      const box = (x: number, y: number, w: number, h: number, label: string, val?: string) => {
        d.rect(x, y, w, h, 0.3)
        d.print(label, x + 1.2, y + 3, { pt: 5.5 })
        if (val) d.type(val, x + 2, y + h - 2.4, { pt: 9.5, font: "Courier Prime" })
      }
      box(14, 34, 94, 12, "REQUESTED BY", "R. ESPOSITO")
      box(108, 34, 46, 12, "DEPT. / ROOM", "SS / 2-27")
      box(154, 34, 48, 12, "DATE", "10-11-84")
      box(14, 46, 94, 12, "CHARGE ACCOUNT", "84-SS-0331-SL")
      box(108, 46, 94, 12, "DELIVER TO", "2-27 ANALYTICAL LAB 4")
      const cols = [14, 30, 48, 150, 176, 202]
      ;["QTY", "UNIT", "DESCRIPTION", "UNIT $", "TOTAL"].forEach((h, i) => d.print(h, cols[i]! + 1.2, 64, { pt: 6.5, weight: 700 }))
      for (let r = 0; r <= 16; r++) d.line(14, 66 + r * 7.5, 202, 66 + r * 7.5, r === 0 ? 0.35 : 0.18)
      for (const x of cols) d.line(x, 60, x, 66 + 16 * 7.5, 0.25)
      d.line(14, 60, 202, 60, 0.3)
      const items = [
        ["12", "EA", "BEAKER, BOROSILICATE, 600 ML", "2.15", "25.80"],
        ["6", "EA", "FLASK, ERLENMEYER, 250 ML", "3.40", "20.40"],
        ["2", "BX", "CHART PAPER, 6-CH, ROLL", "18.75", "37.50"],
        ["4", "EA", "SAMPLE JAR, 1 L, SCREW LID", "4.90", "19.60"],
        ["1", "CS", "FORMALIN 10%, 4 L (4)", "31.40", "31.40"],
        ["2", "EA", "GLOVE, ISOLATOR, BUTYL (2-10)", "48.00", "96.00"],
        ["1", "EA", "KITCHEN TIMER", "3.25", "3.25"],
      ]
      items.forEach((row, r) => row.forEach((v, i) => d.type(v, cols[i]! + 1.5, 66 + (r + 1) * 7.5 - 2, { pt: 9, font: "Courier Prime" })))
      box(150, 66 + 16 * 7.5, 52, 10, "TOTAL", "$233.95")
      box(14, 200, 94, 18, "JUSTIFICATION")
      d.type("SL CORE INTAKE BACKLOG. ISOLATOR", 16, 211, { pt: 8.5, font: "Courier Prime" })
      d.type("GLOVE TORN 10/9 (TRAY SL-14).", 16, 215.5, { pt: 8.5, font: "Courier Prime" })
      box(108, 200, 94, 18, "APPROVED (LAB MANAGER)")
      d.hand("D. Amundsen", 120, 214, { pt: 18, font: "Nothing You Could Do", color: INK.black })
      d.stamp(["APPROVED", "OCT 12 1984"], 70, 240, -0.08, INK.green)
      d.print("WHITE: PURCHASING   YELLOW: RECEIVING (0-16)   PINK: REQUESTER", d.wmm / 2, 268, { pt: 6, align: "center" })
    },
  },
  {
    id: "printout_greenbar",
    title: "Green-bar printout: SL link log (03:02 link up, 03:04 saturated)",
    size: [0.378, 0.279],
    paper: "greenbar",
    tags: ["desk", "floor", "creepy"],
    density: 2.9,
    draw(d) {
      const left = 14
      const lines: string[] = []
      lines.push("IOPS/PHS  COMPUTING CENTRE  SLLNK - W-1 TRUNK  RUN 84.291.03     PAGE 0117")
      lines.push("DATE      TIME(L)   CHAN   FREQ(KHZ)   LEVEL(DB)   SNR    FLAG   OPER")
      lines.push("--------  --------  -----  ----------  ----------  -----  -----  ----")
      let t = 2 * 3600 + 54 * 60
      for (let i = 0; i < 30; i++) {
        t += 8 + Math.floor(rand() * 22)
        const hh = String(Math.floor(t / 3600) % 24).padStart(2, "0")
        const mm = String(Math.floor(t / 60) % 60).padStart(2, "0")
        const ss = String(t % 60).padStart(2, "0")
        const f = (11.905 + rand() * 0.004).toFixed(4)
        const anomalous = t >= 3 * 3600 + 4 * 60
        const up = t >= 3 * 3600 + 2 * 60
        const lvl = anomalous ? (-12.0 + rand()).toFixed(1) : (-71 + rand() * 6).toFixed(1)
        const snr = anomalous ? "  41.8" : rr(2, 9).toFixed(1).padStart(6)
        const flag = anomalous ? "*****" : up ? " LINK" : "     "
        lines.push(`10/18/84  ${hh}:${mm}:${ss}  SL-${(i % 6) + 1}  ${f.padStart(10)}  ${lvl.padStart(10)}  ${snr}  ${flag}  ${anomalous ? "----" : "TO  "}`)
      }
      lines.push("")
      lines.push("*** LEVEL EXCEEDS CALIBRATED RANGE - ALL SL CHANNELS IN PHASE ***")
      lines.push("*** OPERATOR NOT AT CONSOLE 03:04:31 - ***")
      lines.forEach((l, i) => d.type(l, left + 6, 14 + i * 6.35 - 1.5, { pt: 9, font: "VT323", color: "#2a2a30" }))
      d.hand("03:04 again", 255, 160, { pt: 18, color: INK.red, font: "Caveat", slant: -0.08 })
      d.ctx.save()
      d.ctx.strokeStyle = INK.red
      d.ctx.lineWidth = 0.5
      d.ctx.globalAlpha = 0.8
      d.ctx.beginPath()
      d.ctx.ellipse(130, 14 + 24 * 6.35, 112, 26, 0, 0, Math.PI * 2)
      d.ctx.stroke()
      d.ctx.restore()
    },
  },
  {
    id: "note_repeated",
    title: "Legal pad sheet, one line written over and over",
    size: LEGAL_PAD,
    paper: "legal",
    tags: ["desk", "floor", "creepy"],
    draw(d) {
      const n = 30
      for (let i = 0; i < n; i++) {
        const y = 38 + i * 8.5 - 1.5
        const decay = i / n
        d.hand("I did not hear anything on third watch.", 36 + rr(-1, 1) + decay * 4, y, {
          pt: 15 - decay * 1.5,
          font: decay < 0.55 ? "Caveat" : decay < 0.8 ? "Reenie Beanie" : "Nothing You Could Do",
          color: decay < 0.7 ? INK.ballBlue : INK.pencil,
          slant: -0.02 + decay * rr(-0.05, 0.08),
        })
      }
      d.crease(0, 90, d.wmm, 110, 1)
      d.crease(40, 0, 70, d.hmm, 0.7)
      d.crease(0, 200, d.wmm, 185, 0.9)
    },
  },
  {
    id: "sticky_dish",
    title: "Sticky note: dish stays pointed down",
    size: [0.076, 0.076],
    paper: "sticky",
    tags: ["desk", "board", "wall"],
    density: 4.4,
    draw(d) {
      d.hand("DISH: DO", 7, 18, { pt: 20, font: "Permanent Marker", color: "#1a1a1a" })
      d.hand("NOT SLEW", 7, 32, { pt: 20, font: "Permanent Marker", color: "#1a1a1a" })
      d.hand("stays at −12° (north)", 7, 48, { pt: 13, color: INK.ballBlue })
      d.hand("per Dir. 10/14", 30, 64, { pt: 13, color: INK.ballBlue })
    },
  },
  {
    id: "sticky_marge",
    title: "Sticky note: call Marge",
    size: [0.076, 0.076],
    paper: "sticky",
    tags: ["desk", "board"],
    density: 4.4,
    draw(d) {
      d.hand("Call Marge", 6, 18, { pt: 17, color: INK.ballBlue, font: "Caveat" })
      d.hand("re: box lunches", 6, 30, { pt: 15, color: INK.ballBlue, font: "Caveat" })
      d.hand("& the cat thing", 6, 42, { pt: 15, color: INK.ballBlue, font: "Caveat" })
      d.scribble(6, 46, 50, 46.5, 0.35)
      d.hand("x" + EXT.cafeteria, 40, 64, { pt: 16, color: INK.black, font: "Caveat" })
    },
  },
  {
    id: "sticky_dont",
    title: "Sticky note: don't answer 300",
    size: [0.076, 0.076],
    paper: "sticky",
    tags: ["desk", "creepy"],
    density: 4.4,
    draw(d) {
      d.hand("if x300", 8, 24, { pt: 22, color: INK.black, font: "Nothing You Could Do" })
      d.hand("rings —", 8, 40, { pt: 22, color: INK.black, font: "Nothing You Could Do" })
      d.hand("let it.", 18, 58, { pt: 22, color: INK.black, font: "Nothing You Could Do" })
    },
  },
  {
    id: "sticky_back5",
    title: "Sticky note: back in 5 — R. (lab 2-27)",
    size: [0.076, 0.076],
    paper: "sticky",
    tags: ["desk", "creepy"],
    density: 4.4,
    draw(d) {
      d.hand("back in 5", 8, 30, { pt: 24, color: INK.black, font: "Caveat" })
      d.hand("— R.", 36, 46, { pt: 20, color: INK.black, font: "Caveat" })
      d.hand("12:58", 44, 66, { pt: 12, color: INK.pencil, font: "Reenie Beanie" })
    },
  },
  {
    id: "card_extensions",
    title: "Index card: phone extensions",
    size: [0.127, 0.076],
    paper: "card",
    tags: ["desk", "board"],
    density: 4,
    draw(d) {
      d.line(0, 12, d.wmm, 12, 0.3, "#b3261e", 0.7)
      for (let i = 1; i < 7; i++) d.line(0, 12 + i * 8.6, d.wmm, 12 + i * 8.6, 0.18, "#4a7ab8", 0.6)
      d.hand("EXTENSIONS", 6, 9.5, { pt: 15, color: INK.black, font: "Caveat" })
      const e = [`Guard desk ... ${EXT.lobby}`, `Security 0-38 ... ${EXT.security}`, `Facilities ... ${EXT.facilities}`, `Lab Safety ... ${EXT.labSafety}`, `Ops console ... ${EXT.ops}`, `Director ... ${EXT.director}`]
      e.forEach((s, i) => d.hand(s, 6, 12 + (i + 1) * 8.6 - 1.5, { pt: 13.5, color: INK.ballBlue }))
      d.hand("300 = SL ??", 80, 12 + 6 * 8.6 - 1.5, { pt: 13.5, color: INK.red })
    },
  },
  {
    id: "polaroid_dish",
    title: "Polaroid: the dish at dusk",
    size: [0.088, 0.107],
    paper: "polaroid",
    tags: ["board", "desk"],
    density: 4.4,
    draw(d) {
      d.image("polaroid-dish", 6, 6, 76, 77, "sepia(0.25) saturate(0.8) contrast(0.9) brightness(1.05)")
      d.gloss.push([6, 6, 76, 77, 1])
      d.hand("dish, '79 — before", 10, 97, { pt: 14, color: INK.black, font: "Caveat" })
    },
  },
  {
    id: "polaroid_corridor",
    title: "Polaroid: corridor at 2:40 am",
    size: [0.088, 0.107],
    paper: "polaroid",
    tags: ["board", "desk", "creepy"],
    density: 4.4,
    draw(d) {
      d.image("polaroid-corridor", 6, 6, 76, 77, "sepia(0.15) saturate(0.85) contrast(0.95)")
      d.gloss.push([6, 6, 76, 77, 1])
      d.hand("2nd fl. 2:40am", 10, 95, { pt: 14, color: INK.black, font: "Caveat" })
      d.hand("who?", 58, 101, { pt: 13, color: INK.red, font: "Caveat" })
    },
  },
  {
    id: "calendar_oct84",
    title: "Wall calendar page, October 1984",
    size: [0.28, 0.215],
    paper: "white",
    tags: ["wall", "board"],
    density: 2.8,
    draw(d) {
      d.print("OCTOBER", 14, 22, { pt: 30, font: "Oswald", weight: 700 })
      d.print("1984", d.wmm - 14, 22, { pt: 30, font: "Oswald", weight: 300, align: "right" })
      const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
      const x0 = 12
      const cw = (d.wmm - 24) / 7
      const y0 = 30
      const ch = 30
      days.forEach((s, i) => d.print(s, x0 + i * cw + cw / 2, y0 + 5, { pt: 7, weight: 700, align: "center" }))
      for (let day = 1; day <= 31; day++) {
        const col = day % 7 // 1 Oct 1984 = Monday
        const row = Math.floor(day / 7)
        const x = x0 + col * cw
        const y = y0 + 8 + row * ch
        d.rect(x, y, cw, ch, 0.2)
        d.print(String(day), x + 2, y + 6, { pt: 10, weight: 700, color: col === 0 ? "#b3261e" : INK.black })
        if (day <= 17) d.scribble(x + 3, y + 3, x + cw - 3, y + ch - 3, 0.3, INK.black)
      }
      const notes: [number, string, string][] = [
        [3, "shower test", INK.black],
        [4, "bowling 7pm", INK.ballBlue],
        [12, "PAYDAY", INK.green],
        [15, "sign-in rule", INK.ballBlue],
        [17, "SL rot. 6", INK.red],
        [26, "PAYDAY", INK.green],
        [31, "party - caf.", INK.ballBlue],
      ]
      for (const [day, s, col] of notes) {
        const x = x0 + (day % 7) * cw
        const y = y0 + 8 + Math.floor(day / 7) * ch
        d.hand(s, x + 2, y + 18, { pt: 11, color: col })
      }
      d.holes(d.wmm / 2, 5)
    },
  },
  {
    id: "directory_extensions",
    title: "Typed station telephone directory",
    size: LETTER,
    paper: "white",
    tags: ["wall", "desk", "board"],
    draw(d) {
      letterhead(d)
      d.type("STATION TELEPHONE DIRECTORY - REVISED SEPT. 1984", 25, 42, { pt: 11 })
      const rows: [string, string][] = [
        ["Operator / PBX (0-20)", EXT.operator], ["Lobby guard desk (0-01)", EXT.lobby], ["Protective Services (0-38)", EXT.security],
        ["Facilities & Plant (0-30)", EXT.facilities], ["Receiving (0-16)", EXT.receiving], ["Personnel & badges (0-36)", EXT.badges],
        ["Cafeteria (0-39)", EXT.cafeteria], ["Records Center (1-01)", EXT.records], ["Program Admin., Chief (1-07)", EXT.progChief],
        ["Personnel & Payroll (1-09)", EXT.payroll], ["Lab manager (2-08)", EXT.labMgr], ["Lab Safety Office (2-20)", EXT.labSafety],
        ["Analytical Lab 4 (2-27)", EXT.lab4], ["Computer operations (3-06)", EXT.ops], ["Listening room (3-08)", EXT.listening],
        ["Manager, Computing (3-22)", EXT.compMgr], ["Director (4-14)", EXT.director], ["Executive secretary (4-15)", EXT.execSec],
        ["Emergency (fire / medical)", EXT.emergency],
      ]
      rows.forEach(([k, v], i) => {
        d.type(k, 28, 54 + i * 6.6, { pt: 10 })
        d.type(".".repeat(16), 118, 54 + i * 6.6, { fade: 0.6, pt: 10 })
        d.type(v, 166, 54 + i * 6.6, { pt: 10 })
      })
      const yy = 54 + rows.length * 6.6 + 6
      d.type("Ext. 300 (Field Operations / FL-1 lobby) was disconnected", 28, yy, { pt: 9.5 })
      d.type("in 1983. Report any call from 300 to Protective Services.", 28, yy + 5, { pt: 9.5 })
      d.hand("again", 150, yy + 13, { pt: 15, color: INK.red, font: "Caveat" })
      d.holes(d.wmm / 2, 6)
      d.coffee(175, 252, 30, 0.28)
    },
  },
  {
    id: "memo_coffee",
    title: "Memo: coffee fund short",
    size: HALF,
    paper: "pink",
    tags: ["board", "wall"],
    draw(d) {
      d.type("TO ALL WHO DRINK THE COFFEE (1-08):", 18, 22, { pt: 11 })
      const l = d.wrap("The coffee fund is $14.50 short this month. You know who you are. The can is on the shelf above the machine. Filters are NOT free either. The pot does not wash itself. Thank you.", 58)
      d.typeLines(l, 18, 34, 5)
      d.hand("— Doris", 130, 84, { pt: 20, color: INK.ballBlue, font: "Caveat" })
      d.hand("paid! -GP", 22, 116, { pt: 14, color: INK.black, font: "Reenie Beanie" })
      d.holes(d.wmm / 2, 6)
    },
  },
  {
    id: "checklist_rounds",
    title: "Night rounds checklist (FL-1 gate open at 0310)",
    size: LETTER,
    paper: "white",
    tags: ["clipboard", "creepy"],
    draw(d) {
      d.print("NIGHT ROUNDS CHECKLIST", d.wmm / 2, 20, { pt: 15, weight: 800, align: "center" })
      d.print("Protective Services · IOPS Form PS-7 · one sheet per watch · initial each check", d.wmm / 2, 26, { pt: 7.5, align: "center" })
      d.hand("Date: 10/17/84    Officer: S. Vance", 20, 38, { pt: 15, color: INK.black })
      const stops = ["Lobby doors locked (0-01)", "Staff entrance 0-10 latched", "Receiving roll-ups down (0-16)", "FL-1 gates SHUT, both (0-15)", "EL / TC doors locked, all floors", "W-1 cupboards locked, all floors", "2-27 / 2-04 hot plates & hoods off", "Machine room temp < 70°F (3-04)", "4th fl. west hoarding shut", "Guard booth radio check, ch. 3"]
      const times = ["2300", "0100", "0300", "0500"]
      times.forEach((t, i) => d.print(t, 130 + i * 18, 50, { pt: 8, weight: 700 }))
      stops.forEach((s, r) => {
        const y = 60 + r * 11
        d.print(s, 20, y, { pt: 9.5 })
        d.line(18, y + 3.5, 200, y + 3.5, 0.15, INK.black, 0.5)
        times.forEach((_, i) => {
          const done = i < 2 || (i === 2 && r < 3)
          d.checkbox(131 + i * 18, y, 3.4, done, INK.black)
          if (done && rand() < 0.5) d.hand("SV", 136 + i * 18, y, { pt: 10, color: INK.black })
        })
      })
      d.hand("FL-1 gate OPEN 0310. Shut it. Open again 0318.", 20, 186, { pt: 14, color: INK.black, font: "Caveat", slant: -0.02 })
      d.hand("Car at ground. Empty. Called 300 — it rang.", 20, 196, { pt: 14, color: INK.black, font: "Caveat", slant: -0.015 })
      d.holes(d.wmm / 2, 6)
    },
  },
  {
    id: "envelope_interoffice",
    title: "Interoffice routing envelope",
    size: [0.25, 0.33],
    paper: "manila",
    tags: ["desk", "floor"],
    density: 2.6,
    draw(d) {
      d.print("INTEROFFICE MAIL — DO NOT SEAL", d.wmm / 2, 16, { pt: 12, weight: 800, align: "center" })
      d.print("Mail & messenger 0-19 · cross out previous name · reuse", d.wmm / 2, 22, { pt: 7, align: "center" })
      const cols = [12, 92, 162, 238]
      ;["NAME", "ROOM / DEPT.", "DATE"].forEach((h, i) => d.print(h, cols[i]! + 2, 32, { pt: 7, weight: 700 }))
      for (let r = 0; r <= 24; r++) d.line(12, 34 + r * 11.5, 238, 34 + r * 11.5, 0.25)
      for (const x of cols) d.line(x, 27, x, 34 + 24 * 11.5, 0.25)
      const e: [string, string, string][] = [
        ["H. Yost", "Property", "6/84"], ["Chief, Prog. Admin", "1-07", "7/84"], ["D. Halverson", "Field Ops SL", "8/84"],
        ["Records", "1-01", "9/84"], ["E. Lindqvist", "Field Ops SL", "10/9"], ["D. Halverson", "3-01 pigeonhole", "10/16"],
        ["Director", "4-14", "10/17"],
      ]
      e.forEach((row, r) => {
        const h = { font: pick(HANDS), color: pick([INK.ballBlue, INK.black, INK.pencil]) }
        row.forEach((v, i) => d.hand(v, cols[i]! + 3, 34 + (r + 1) * 11.5 - 3, { pt: 15, ...h }))
        if (r < 6) d.scribble(13, 34 + (r + 1) * 11.5 - 5, 236, 34 + (r + 1) * 11.5 - 5.5, 0.45, INK.black)
      })
      d.crease(0, d.hmm * 0.55, d.wmm, d.hmm * 0.56, 0.7)
    },
  },
  timeCard("timecard_halverson", "D. Halverson", "1047"),
  timeCard("timecard_lindqvist", "E. Lindqvist", "1052"),
  {
    id: "board_dosimeter",
    title: "Sign: SUBLEVEL — DOSIMETER REQUIRED (0-15)",
    size: [0.45, 0.3],
    paper: "plate",
    tags: ["wall"],
    density: 1.15,
    draw(d) {
      d.fill(0, 0, d.wmm, d.hmm, "#e8c31a")
      d.fill(0, 0, d.wmm, 70, "#141414")
      d.print("SUBLEVEL", d.wmm / 2, 52, { pt: 110, font: "Archivo Black", align: "center", color: "#e8c31a" })
      d.print("DOSIMETER REQUIRED", d.wmm / 2, 118, { pt: 64, font: "Archivo Black", align: "center", color: "#141414" })
      d.print("FREIGHT LIFT FL-1 · FIELD OPERATIONS ONLY · SUBLEVEL KEYCARD", d.wmm / 2, 160, { pt: 22, font: "Libre Franklin", weight: 800, align: "center", color: "#141414" })
      d.print("Take a badge from the rack. Return it when you come up.", d.wmm / 2, 200, { pt: 22, font: "Libre Franklin", weight: 600, align: "center", color: "#141414" })
      d.print("Survey out at 0-14 before entering the clean side.", d.wmm / 2, 228, { pt: 22, font: "Libre Franklin", weight: 600, align: "center", color: "#141414" })
      d.rect(6, 6, d.wmm - 12, d.hmm - 12, 2, "#141414")
      d.hand("6 OUT", d.wmm - 110, d.hmm - 26, { pt: 46, font: "Permanent Marker", color: "#a3241c", slant: -0.05 })
    },
  },
  {
    id: "stencil_w1",
    title: "Stencil: W-1 — SL TRUNK (riser cupboard)",
    size: [0.36, 0.12],
    paper: "plate",
    tags: ["wall"],
    density: 1.2,
    draw(d) {
      d.fill(0, 0, d.wmm, d.hmm, "#8d9088")
      d.print("W-1 — SL TRUNK", d.wmm / 2, 62, { pt: 90, font: "Archivo Black", align: "center", color: "#1a1a1a", alpha: 0.88 })
      d.print("NO ACCESS WITHOUT SIGNAL KEYCARD · DO NOT OPEN", d.wmm / 2, 96, { pt: 26, font: "Archivo Black", align: "center", color: "#1a1a1a", alpha: 0.85 })
      // Stencil bridges.
      for (let x = 20; x < d.wmm; x += 13) d.fill(x, 26, 1.4, 42, "#8d9088", 0.8)
    },
  },
  plate("plate_el0", "Door plate: EL-0 Electrical", ["EL-0", "ELECTRICAL"], { sub: "JANITOR KEY · NO STORAGE" }),
  plate("plate_el1", "Door plate: EL-1 Electrical", ["EL-1", "ELECTRICAL"], { sub: "JANITOR KEY · NO STORAGE" }),
  plate("plate_el2", "Door plate: EL-2 Electrical", ["EL-2", "ELECTRICAL"], { sub: "JANITOR KEY · NO STORAGE" }),
  plate("plate_el3", "Door plate: EL-3 Electrical", ["EL-3", "ELECTRICAL"], { sub: "JANITOR KEY · NO STORAGE" }),
  plate("plate_el4", "Door plate: EL-4 Electrical", ["EL-4", "ELECTRICAL"], { sub: "TEMPORARY SUPPLY · CONTRACTOR" }),
  plate("plate_tc0", "Door plate: TC-0 Telecom", ["TC-0", "TELECOM"], { sub: "COMMS KEYCARD ONLY", color: "#22324a" }),
  plate("plate_tc1", "Door plate: TC-1 Telecom", ["TC-1", "TELECOM"], { sub: "COMMS KEYCARD ONLY", color: "#22324a" }),
  plate("plate_tc2", "Door plate: TC-2 Telecom", ["TC-2", "TELECOM"], { sub: "COMMS KEYCARD ONLY", color: "#22324a" }),
  plate("plate_tc3", "Door plate: TC-3 Telecom", ["TC-3", "TELECOM"], { sub: "COMMS KEYCARD ONLY", color: "#22324a" }),
  plate("plate_tc4", "Door plate: TC-4 Telecom", ["TC-4", "TELECOM"], { sub: "COMMS KEYCARD ONLY", color: "#22324a" }),
  plate("plate_jc", "Door plate: Janitor closet", ["JANITOR"], { sub: "CUSTODIAL · FACILITIES & PLANT" }),
  plate("plate_vault", "Door plate: vault, two-person rule (1-01v)", ["VAULT", "1-01v"], { sub: "TWO-PERSON RULE", color: "#5a1d18" }),
  {
    id: "sign_out_of_order",
    title: "Taped sign: OUT OF ORDER (4th floor WCs)",
    size: HALF,
    paper: "white",
    tags: ["wall"],
    density: 1.5,
    draw(d) {
      d.hand("OUT OF", 30, 60, { pt: 80, font: "Permanent Marker", color: "#151515", slant: -0.02 })
      d.hand("ORDER", 40, 104, { pt: 80, font: "Permanent Marker", color: "#151515", slant: -0.03 })
      d.hand("use 3rd floor — Facilities", 70, 128, { pt: 15, color: INK.ballBlue })
    },
  },
]


// ---------------------------------------------------------------------------------------------------- stand-in replacements
// Documents for every place the storey/kit code drew fake text (docs/text-stand-ins.md maps call sites to ids).

/** Rooms from docs/building-program.md (injected by scripts/build-documents.ts): id → label. */
const ROOMS = (globalThis as { __rooms?: [string, string][] }).__rooms ?? []

/** Room number plate: engraved charcoal plastic, number large, room name small (fits the kit's 0.16 × 0.10 plate). */
function doorPlate(id: string, label: string, color = "#2b2e31"): DocSpec {
  return {
    id: `door_${id.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`,
    title: `Door plate ${id} ${label}`,
    size: [0.16, 0.1],
    paper: "plate",
    tags: ["wall"],
    density: 1.1,
    draw(d) {
      d.fill(0, 0, d.wmm, d.hmm, color)
      d.rect(2.5, 2.5, d.wmm - 5, d.hmm - 5, 0.5, "#c9c6bd")
      d.print(id, d.wmm / 2, 54, { pt: 110, font: "Archivo Black", align: "center", color: "#e9e6dc" })
      // Fit the label to the plate width.
      let pt = 28
      d.font("Libre Franklin", pt, 700)
      while (d.ctx.measureText(label).width > d.wmm - 16 && pt > 9) d.font("Libre Franklin", (pt -= 1), 700)
      d.print(label, d.wmm / 2, 84, { pt, font: "Libre Franklin", weight: 700, align: "center", color: "#e9e6dc", spacing: 0.4 })
    },
  }
}

function smallLabel(id: string, title: string, size: [number, number], lines: string[], o: { paper?: Paper; hand?: boolean; color?: string; tags?: Tag[] } = {}): DocSpec {
  return {
    id,
    title,
    size,
    paper: o.paper ?? "card",
    tags: o.tags ?? ["desk"],
    density: 3,
    draw(d) {
      const n = lines.length
      const lh = d.hmm / (n + 0.6)
      lines.forEach((l, i) => {
        const y = lh * (i + 0.95)
        // Fit the line to the label width.
        let pt = (lh / PT) * (o.hand ? 0.95 : 0.72)
        d.font(o.hand ? "Caveat" : "Courier Prime", pt, o.hand ? 500 : 400)
        const w = o.hand ? d.ctx.measureText(l).width * 1.04 : d.ctx.measureText("M").width * l.length
        if (w > d.wmm - 6) pt *= (d.wmm - 6) / w
        if (o.hand) d.hand(l, 3, y, { pt, color: o.color ?? INK.black, font: "Caveat" })
        else d.type(l, 3, y, { pt, font: "Courier Prime", color: o.color })
      })
      d.rect(0.6, 0.6, d.wmm - 1.2, d.hmm - 1.2, 0.2, INK.black)
    },
  }
}

function sign(id: string, title: string, size: [number, number], bg: string, fg: string, lines: [string, number][], o: { density?: number; border?: string } = {}): DocSpec {
  return {
    id,
    title,
    size,
    paper: "plate",
    tags: ["wall"],
    density: o.density ?? 1.6,
    draw(d) {
      d.fill(0, 0, d.wmm, d.hmm, bg)
      if (o.border) d.rect(4, 4, d.wmm - 8, d.hmm - 8, 1.6, o.border)
      const total = lines.reduce((a, [, pt]) => a + pt * PT * 1.25, 0)
      let y = (d.hmm - total) / 2
      for (const [s, pt] of lines) {
        y += pt * PT * 1.05
        d.print(s, d.wmm / 2, y, { pt, font: pt > 30 ? "Archivo Black" : "Libre Franklin", weight: 800, align: "center", color: fg })
        y += pt * PT * 0.2
      }
    },
  }
}

/** Chalkboard / whiteboard face: chalk or marker text with ghosts of earlier writing. */
function board(id: string, title: string, size: [number, number], kind: "chalk" | "white", draw: (d: Draw, ink: (s: string, x: number, y: number, pt?: number, color?: string) => void) => void): DocSpec {
  return {
    id,
    title,
    size,
    paper: kind === "chalk" ? "chalk" : "white_board",
    tags: ["wall"],
    density: 0.32,
    draw(d) {
      const chalk = kind === "chalk"
      // Ghosts of wiped writing.
      for (let i = 0; i < 9; i++)
        d.hand(pick(["f = c / λ", "Δt = 12.4 ms", "∮ E·dl", "α = 0.031", "SL-3 ↔ SL-5", "N = 6", "h ≈ 410 m"]), rr(30, d.wmm - 300), rr(80, d.hmm - 40), {
          pt: rr(120, 180),
          color: chalk ? "rgba(220,225,215,0.07)" : "rgba(40,60,120,0.06)",
          font: "Caveat",
        })
      const ink = (s: string, x: number, y: number, pt = 240, color = chalk ? "#e6e8de" : "#1f2f7a") =>
        d.hand(s, x, y, { pt, color, font: chalk ? "Reenie Beanie" : "Caveat", slant: rr(-0.02, 0.02) })
      draw(d, ink)
    },
  }
}

function dayCard(id: string, name: string, number: string): DocSpec {
  return {
    id,
    title: `Time card: ${name} (day staff, punched out)`,
    size: [0.0825, 0.187],
    paper: "timecard",
    tags: ["wall", "desk"],
    density: 3.4,
    draw(d) {
      d.print("PINE HOLLOW STA.", d.wmm / 2, 8, { pt: 8, weight: 800, align: "center" })
      d.print("WEEKLY TIME CARD", d.wmm / 2, 12.5, { pt: 6, align: "center" })
      d.print("NO.", 5, 20, { pt: 6, weight: 700 })
      d.type(number, 14, 20.5, { pt: 11, font: "Courier Prime" })
      d.print("NAME", 5, 27, { pt: 6, weight: 700 })
      d.hand(name, 16, 27.5, { pt: 15, color: INK.black })
      d.print("WEEK ENDING  OCT 20 1984", 5, 41, { pt: 6, weight: 700 })
      for (let r = 0; r <= 7; r++) d.line(4, 50.5 + r * 17, d.wmm - 4, 50.5 + r * 17, 0.2)
      for (let c = 0; c <= 4; c++) d.line(14 + c * 16, 46, 14 + c * 16, 50.5 + 7 * 17, 0.2)
      ;["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].forEach((s, r) => d.print(s, 4.5, 50.5 + r * 17 + 9.5, { pt: 5.5, weight: 700 }))
      ;["IN", "OUT", "IN", "OUT"].forEach((c, i) => d.print(c, 14 + i * 16 + 6, 49, { pt: 6, weight: 700, align: "center" }))
      const days = ["M", "T", "W"]
      days.forEach((dy, r) => {
        const a = 7 * 60 + Math.floor(rr(-6, 4))
        const b = 15 * 60 + Math.floor(rr(0, 9))
        const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
        d.type(`${dy} ${f(a)}`, 15.2, 50.5 + r * 17 + 10, { pt: 7.5, font: "Courier Prime", fade: 0.9 })
        d.type(`${dy} ${f(b)}`, 31.2, 50.5 + r * 17 + 10, { pt: 7.5, font: "Courier Prime", fade: 0.9 })
      })
    },
  }
}

const SERVICE_PLATES: [string, string][] = []
for (let s = 0; s <= 4; s++) SERVICE_PLATES.push([`WC-M${s}`, "MEN"], [`WC-W${s}`, "WOMEN"], [`JC-${s}`, "JANITOR"], [`ST-${s}`, "STORE"])

const IN_OUT_NAMES = [
  "Kemper, D.", "Pell, G.", "Duquette, M.", "Halverson, D.", "Reyes, A.", "Whitcomb, J.", "Brandt, M.", "Lindqvist, E.",
  "Moreau, P.", "Albrecht, S.", "Tolliver, K.", "Hsu, L.", "Szabo, B.", "Ferraro, N.", "Gaines, R.", "Ostrowski, T.",
  "Dunleavy, C.", "Dorsey, K.", "Marsh, F.", "Petrakis, H.", "Nakamura, A.", "Quinlan, V.",
]

const STAND_INS: DocSpec[] = [
  {
    id: "note_do_not_disturb",
    title: "Taped note: DO NOT DISTURB — R.H. (Director's door)",
    size: [0.22, 0.16],
    paper: "white",
    tags: ["wall", "creepy"],
    density: 3.2,
    draw(d) {
      // Torn top edge.
      d.ctx.save()
      d.ctx.fillStyle = "#1a1814"
      d.ctx.beginPath()
      d.ctx.moveTo(0, 0)
      for (let x = 0; x <= d.wmm; x += 3) d.ctx.lineTo(x, rr(0, 4))
      d.ctx.lineTo(d.wmm, 0)
      d.ctx.fill()
      d.ctx.restore()
      for (let y = 30; y < d.hmm; y += 8.5) d.line(0, y, d.wmm, y, 0.18, "#5f86b8", 0.4)
      d.hand("DO NOT", 18, 58, { pt: 64, font: "Permanent Marker", color: "#151515", slant: -0.04 })
      d.hand("DISTURB", 14, 100, { pt: 64, font: "Permanent Marker", color: "#151515", slant: -0.03 })
      d.hand("— R.H.", 120, 138, { pt: 40, font: "Nothing You Could Do", color: "#151515", slant: -0.06 })
      d.crease(0, d.hmm * 0.55, d.wmm, d.hmm * 0.5, 0.8)
    },
  },
  {
    id: "spray_do_not_demo",
    title: "Spray-painted 'DO NOT DEMO — SEE DIRECTOR' on gypsum board (4-01)",
    size: [1.3, 0.45],
    paper: "gypsum",
    tags: ["wall", "creepy"],
    density: 0.7,
    draw(d) {
      const spray = (s: string, x: number, y: number, pt: number) => {
        // Overspray halo, then the line.
        d.hand(s, x, y, { pt, font: "Permanent Marker", color: "rgba(200,80,26,0.18)", slant: -0.02 })
        d.ctx.save()
        d.ctx.filter = "blur(1.2px)"
        d.hand(s, x, y, { pt, font: "Permanent Marker", color: "#c8501a", slant: -0.02 })
        d.ctx.restore()
        // Drips.
        for (let i = 0; i < 6; i++) {
          const dx = x + rr(10, s.length * pt * 0.16)
          d.line(dx, y + 2, dx + rr(-0.5, 0.5), y + rr(10, 45), rr(1.2, 2.2), "#c8501a", 0.8)
        }
      }
      spray("DO NOT DEMO", 90, 190, 320)
      spray("SEE DIRECTOR", 170, 400, 220)
      d.hand("↓", 1150, 420, { pt: 260, font: "Permanent Marker", color: "#c8501a" })
    },
  },
  board("chalkboard_equations", "Chalkboard, 3-09 analysis bullpen: propagation equations and SL source fixes", [4.2, 1.1], "chalk", (d, ink) => {
    ink("E(z) = E₀ · e^(−αz)      α = 0.031 / m (wet granite)", 120, 190)
    ink("λ = c / f  →  f = 11.905 kHz,  λ ≈ 25.2 km", 120, 340)
    ink("Δφ(SL-1…SL-6) = 0.0° ± 0.3°   ALL SIX IN PHASE", 120, 490)
    ink("⇒ source not a point?  or it is everywhere at once", 120, 640, 208)
    ink("depth fix:  h = 410 m (Aug)   388 m (Sep)   361 m (Oct)", 120, 800)
    ink("rising 25 m / month", 2700, 800, 240, "#e8b0a0")
    d.ctx.save()
    d.ctx.strokeStyle = "#e8b0a0"
    d.ctx.lineWidth = 6
    d.ctx.beginPath()
    d.ctx.ellipse(3100, 760, 520, 110, -0.02, 0, Math.PI * 2)
    d.ctx.stroke()
    d.ctx.restore()
    ink("DO NOT ERASE", 3350, 1020, 176)
  }),
  board("chalkboard_agenda", "Chalkboard, Conference A (1-02): staff meeting agenda", [3.0, 1.1], "chalk", (d, ink) => {
    ink("STAFF MTG  — Mon 10/15", 100, 170, 272)
    ink("1. FY85 contracts — IOPS renewal (due 11/1)", 120, 330)
    ink("2. SL rotation staffing — 6 → Field Ops Wed.", 120, 470)
    ink("3. Payroll: hold letters (see Dir.)", 120, 610)
    ink("4. Parking — north lot CLOSED", 120, 750)
    ink("5. Bowling — forfeits", 120, 890)
    ink("✓", 2200, 330, 240)
  }),
  board("chalkboard_titration", "Chalkboard, biochem teaching lab (2-24): titration notes", [3.6, 1.1], "chalk", (d, ink) => {
    ink("Titration — acid/base", 100, 170, 272)
    ink("M₁V₁ = M₂V₂", 120, 340)
    ink("0.100 M NaOH  ·  25.00 mL sample  ·  phenolphthalein", 120, 490)
    ink("endpoint: faint pink 30 s", 120, 640)
    ink("SL core leachate: pH 3.1 (?!) — redo w/ fresh std.", 120, 800, 224)
    ink("goggles ON", 2700, 980, 224)
  }),
  board("chalkboard_wiped", "Chalkboard, wiped with ghosts of writing (generic)", [2.4, 1.1], "chalk", (d, ink) => {
    ink("intake log — see binder", 120, 250, 208, "rgba(230,232,222,0.55)")
    ink("SL-14  →  2-10 ONLY", 140, 520, 256)
  }),
  board("whiteboard_ops", "Whiteboard, operations console 3-06: shift and tape schedule", [2.6, 1.1], "white", (d, ink) => {
    ink("OPS — WEEK OF 10/15", 90, 150, 256)
    d.line(80, 190, 2500, 190, 4, "#1f2f7a", 0.8)
    ink("2300–0700   Okafor  /  ———", 100, 300)
    ink("0700–1500   Brandt  /  Vance", 100, 430)
    ink("TAPE MOUNTS:  RCV-288, 289 (SIGLOG)", 100, 560)
    ink("SL LINK WINDOW 0300–0315 — DO NOT IPL", 100, 700, 240, "#a3241c")
    ink("call 3-22 if link drops (NOT x300)", 100, 840, 208)
    ink("Halverson printouts → 3-01 (uncollected)", 100, 980, 192)
  }),
  {
    id: "inout_board_1_09",
    title: "Magnetic in/out board face, Personnel & Payroll (1-09): 22 names, IN / OUT / SL columns",
    size: [1.2, 22 * 0.045 + 0.16],
    paper: "white_board",
    tags: ["wall"],
    density: 0.85,
    draw(d) {
      // Matches s1 furniture inOutBoard: name strips x −0.5..0, columns IN 0.05..0.25, OUT 0.25..0.42, SL 0.42..0.6.
      const cx = d.wmm / 2
      const top = (v: number) => d.hmm / 2 - v * 1000 + 10
      d.fill(cx - 580, top(0.5 * (22 * 0.045 + 0.16) - 0.025) - 25, 1160, 50, "#2b2e31")
      d.print("PERSONNEL & PAYROLL", cx - 560, top(0.5 * (22 * 0.045 + 0.16) - 0.05) + 9, { pt: 62, font: "Libre Franklin", weight: 800, color: "#e9e6dc" })
      d.print("IN", cx + 150, top(0.5 * (22 * 0.045 + 0.16) - 0.05) + 9, { pt: 62, font: "Archivo Black", align: "center", color: "#e9e6dc" })
      d.print("OUT", cx + 335, top(0.5 * (22 * 0.045 + 0.16) - 0.05) + 9, { pt: 62, font: "Archivo Black", align: "center", color: "#e9e6dc" })
      d.fill(cx + 430, top(0.5 * (22 * 0.045 + 0.16) - 0.05) - 15, 150, 30, "#a3241c")
      d.print("SL", cx + 510, top(0.5 * (22 * 0.045 + 0.16) - 0.05) + 9, { pt: 62, font: "Archivo Black", align: "center", color: "#f1ece0" })
      for (const u of [0.05, 0.25, 0.42]) d.line(cx + u * 1000, top(0.5 * (22 * 0.045 + 0.16) - 0.09), cx + u * 1000, d.hmm - 30, 4, "#3a3a3a", 0.8)
      IN_OUT_NAMES.forEach((n, r) => {
        const v = (22 * 0.045 + 0.16) / 2 - 0.11 - r * 0.045
        const y = top(v)
        d.fill(cx - 500, y - 20, 500, 40, "#ece7da")
        d.rect(cx - 500, y - 20, 500, 40, 1, "#9a968a")
        d.type(n.toUpperCase(), cx - 485, y + 12, { pt: 72, font: "Courier Prime" })
        d.line(cx + 50, y + 22, cx + 600, y + 22, 1.2, "#bdbab0", 0.7)
      })
      d.hand("SL: back Fri? — D.K.", cx + 60, d.hmm - 40, { pt: 70, color: INK.red, font: "Caveat" })
    },
  },
  {
    id: "directory_board",
    title: "Lobby floor directory: felt letter board (0-02)",
    size: [0.9, 1.1],
    paper: "felt",
    tags: ["wall"],
    density: 0.7,
    draw(d) {
      const t = (s: string, x: number, y: number, pt: number) => d.print(s, x, y, { pt, font: "Libre Franklin", weight: 600, color: "#e8e6df", spacing: 2 })
      t("PINE HOLLOW STATION", 50, 90, 64)
      t("FLOOR DIRECTORY", 50, 140, 40)
      const rows: [string, string][] = [
        ["4", "DIRECTORATE · RECEIVER ROOM"], ["4W", "CLOSED — REFURBISHMENT"], ["3", "COMPUTING & SIGNAL PROCESSING"], ["3", "TERMINAL POOL · DATA CONTROL"],
        ["2", "SAMPLE SCIENCES · LABS 2-02–2-29"], ["2", "LAB SAFETY OFFICE 2-20"], ["1", "PROGRAM ADMINISTRATION"], ["1", "PERSONNEL & PAYROLL 1-09"],
        ["1", "RECORDS CENTER 1-01 · LIBRARY 1-10"], ["G", "SECURITY 0-38 · BADGES 0-36"], ["G", "CAFETERIA 0-39 · AUDITORIUM 0-35"], ["G", "RECEIVING 0-16 · MAIL 0-19"],
      ]
      rows.forEach(([f, s], i) => {
        const y = 240 + i * 66
        t(f, 50, y, 40)
        t(s, 150, y, 32)
      })
      t("SL — AUTHORIZED PERSONNEL ONLY", 50, 1060, 28)
    },
  },
  {
    id: "plaque_dedication",
    title: "Bronze dedication plaque under the 1979 dish photo (0-02)",
    size: [0.42, 0.26],
    paper: "bronze",
    tags: ["wall"],
    density: 1.3,
    draw(d) {
      const gold = "#e2c27a"
      d.rect(8, 8, d.wmm - 16, d.hmm - 16, 2, gold)
      d.print("PINE HOLLOW STATION", d.wmm / 2, 52, { pt: 56, font: "Archivo Black", align: "center", color: gold })
      d.print("ATMOSPHERIC PROPAGATION RESEARCH FACILITY", d.wmm / 2, 92, { pt: 26, font: "Libre Franklin", weight: 800, align: "center", color: gold })
      d.print("DEDICATED JUNE 9, 1979", d.wmm / 2, 140, { pt: 30, font: "Libre Franklin", weight: 700, align: "center", color: gold })
      d.print("\"TO LISTEN TO THE EARTH AND THE SKY\"", d.wmm / 2, 180, { pt: 22, font: "Libre Franklin", weight: 600, align: "center", color: gold })
      d.print("INTERAGENCY OFFICE OF PROPAGATION STUDIES", d.wmm / 2, 225, { pt: 18, font: "Libre Franklin", weight: 700, align: "center", color: gold })
      d.gloss.push([0, 0, d.wmm, d.hmm, 0])
    },
  },
  {
    id: "flipchart_contracts",
    title: "Flip chart: contracts Q4 FY84 bar chart (1-25)",
    size: [0.66, 0.84],
    paper: "newsprint",
    tags: ["wall"],
    density: 0.9,
    draw(d) {
      const m = (s: string, x: number, y: number, pt: number, c = "#1f2f7a") => d.hand(s, x, y, { pt, font: "Permanent Marker", color: c })
      m("CONTRACTS — Q4 FY84", 50, 110, 64)
      d.line(80, 700, 600, 700, 5, "#151515", 0.9)
      d.line(80, 700, 80, 220, 5, "#151515", 0.9)
      const bars = [["JUL", 260], ["AUG", 320], ["SEP", 410], ["OCT", 180]] as const
      bars.forEach(([lab, h], i) => {
        d.fill(120 + i * 120, 700 - h, 80, h, i === 3 ? "#a3241c" : "#2a5a3a", 0.85)
        m(lab, 120 + i * 120, 760, 40, "#151515")
      })
      m("$ (000)", 90, 200, 36, "#151515")
      m("Oct: SL contract on HOLD", 60, 820, 44, "#a3241c")
    },
  },
  {
    id: "blueprint_4th_floor",
    title: "Blueprint: 4th floor refurbishment plan (4-02 site office / 4-01 wall)",
    size: [0.9, 0.62],
    paper: "blueprint",
    tags: ["wall", "desk"],
    density: 1.0,
    draw(d) {
      const w = "#dfe8f4"
      d.rect(20, 20, d.wmm - 40, d.hmm - 40, 2, w)
      // Plan: corridor and stud partitions of the west half.
      const x0 = 50, x1 = 720, y0 = 90, y1 = 470
      d.rect(x0, y0, x1 - x0, y1 - y0, 3, w)
      d.line(x0, 270, x1, 270, 2, w)
      d.line(x0, 290, x1, 290, 2, w)
      for (let x = x0 + 70; x < x1; x += 70) {
        d.line(x, y0, x, 270, 1.2, w)
        d.line(x, 290, x, y1, 1.2, w)
      }
      d.rect(560, 150, 50, 50, 1.5, w)
      d.print("W-1", 585, 182, { pt: 26, weight: 700, align: "center", color: w })
      d.print("DO NOT DEMO", 585, 225, { pt: 18, weight: 800, align: "center", color: "#ffd8a0" })
      d.print("4TH FLOOR — WEST · STRIP-OUT", x0, 70, { pt: 34, weight: 800, color: w })
      // Title block.
      d.rect(740, 380, 140, 220, 1.5, w)
      ;["PINE HOLLOW STA.", "4th FL. REFURB", "SHEET A-4.1", "DRN: WF", "DATE: 8/84", "SCALE 1:100"].forEach((s, i) => d.print(s, 748, 405 + i * 30, { pt: 15, weight: 700, color: w }))
      d.print("ALL WORK HALTED 9/26", 60, 540, { pt: 30, weight: 800, color: "#ffd8a0" })
    },
  },
  {
    id: "whiteprint_ceiling",
    title: "White print: reflected ceiling plan, 4th floor (blue-line)",
    size: [0.9, 0.62],
    paper: "white",
    tags: ["wall", "desk"],
    density: 1.0,
    draw(d) {
      const b = "#3b4f8e"
      d.rect(20, 20, d.wmm - 40, d.hmm - 40, 1.5, b)
      d.print("REFLECTED CEILING PLAN — 4TH FLOOR", 50, 70, { pt: 30, weight: 800, color: b })
      for (let x = 60; x < 720; x += 40) d.line(x, 100, x, 500, 0.6, b, 0.7)
      for (let y = 100; y < 500; y += 40) d.line(60, y, 720, y, 0.6, b, 0.7)
      for (let i = 0; i < 18; i++) d.rect(80 + (i % 6) * 110, 130 + Math.floor(i / 6) * 130, 40, 80, 1.2, b, "#c9d2ea")
      d.print("2×4 TROFFERS · SEE E-4.2", 60, 540, { pt: 22, weight: 700, color: b })
      d.rect(740, 380, 140, 220, 1.2, b)
      ;["PINE HOLLOW STA.", "SHEET E-4.1", "DRN: WF", "DATE: 8/84"].forEach((s, i) => d.print(s, 748, 405 + i * 30, { pt: 15, weight: 700, color: b }))
    },
  },
  {
    id: "chart_circular",
    title: "Circular chart-recorder disc, 7-day temperature (0-21 HVAC panel)",
    size: [0.3, 0.3],
    paper: "white",
    tags: ["wall"],
    density: 1.6,
    draw(d) {
      const c = d.ctx
      const cx = d.wmm / 2, cy = d.hmm / 2, R = 140
      c.save()
      c.strokeStyle = "#7a6a9a"
      c.lineWidth = 0.6
      for (let r = 30; r <= R; r += 15) {
        c.beginPath()
        c.arc(cx, cy, r, 0, Math.PI * 2)
        c.stroke()
      }
      for (let k = 0; k < 168; k += 6) {
        const a = (k / 168) * Math.PI * 2
        c.beginPath()
        c.moveTo(cx + Math.cos(a) * 30, cy + Math.sin(a) * 30)
        c.quadraticCurveTo(cx + Math.cos(a + 0.2) * 90, cy + Math.sin(a + 0.2) * 90, cx + Math.cos(a + 0.25) * R, cy + Math.sin(a + 0.25) * R)
        c.stroke()
      }
      c.strokeStyle = "#a3241c"
      c.lineWidth = 1.4
      c.beginPath()
      for (let k = 0; k <= 400; k++) {
        const a = (k / 400) * Math.PI * 2 * 0.85
        const r = 85 + Math.sin(k * 0.21) * 8 + (k > 330 ? (k - 330) * 0.8 : 0)
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r
        k ? c.lineTo(px, py) : c.moveTo(px, py)
      }
      c.stroke()
      c.restore()
      ;["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].forEach((s, i) => {
        const a = (i / 7) * Math.PI * 2
        d.print(s, cx + Math.cos(a) * (R + 4), cy + Math.sin(a) * (R + 4), { pt: 12, weight: 700, align: "center", color: "#5a4a7a" })
      })
      d.print("SL INTAKE AIR  °F", cx, cy - 4, { pt: 10, weight: 700, align: "center", color: "#5a4a7a" })
      d.hand("10/15", cx - 12, cy + 12, { pt: 12, color: INK.black })
    },
  },
  {
    id: "printout_teletype",
    title: "Teletype paper roll output: SL link console log",
    size: [0.22, 0.3],
    paper: "white",
    tags: ["desk"],
    density: 2.6,
    draw(d) {
      const l = [
        "PHS SLLNK 84.291", "", "0258 SL-1 CARRIER OK", "0258 SL-2 CARRIER OK", "0259 SL-3 CARRIER OK", "0259 SL-4 CARRIER OK",
        "0300 SL-5 CARRIER OK", "0300 SL-6 CARRIER OK", "0302 LINK UP 6/6", "0303 LEVEL HIGH SL-1..6", "0304 LEVEL HIGH SL-1..6",
        "0304 PHASE LOCK 6/6", "0304 ?? ?? ?? ??", "0305 HELLO", "0305 HELLO", "0305 HELLO", "0306 CARRIER LOST",
      ]
      l.forEach((s, i) => d.type(s, 12, 18 + i * 15, { pt: 11, font: "Courier Prime" }))
    },
  },
  sign("sign_eyewash", "Sign: EMERGENCY EYE WASH (green)", [0.16, 0.12], "#1f6a3a", "#f1ece0", [["EMERGENCY", 30], ["EYE WASH", 46], ["PUSH PADDLE · FLUSH 15 MIN", 14]], { border: "#f1ece0" }),
  sign("sign_drench", "Sign: EMERGENCY SHOWER (green)", [0.3, 0.3], "#1f6a3a", "#f1ece0", [["EMERGENCY", 56], ["SHOWER", 90], ["PULL HANDLE DOWN", 26], ["Lab Safety ext. 270", 22]], { border: "#f1ece0" }),
  sign("sign_halon_area", "Sign: WARNING — HALON 1301 PROTECTED AREA (machine room door)", [0.26, 0.32], "#e8c31a", "#141414", [["WARNING", 60], ["HALON 1301", 50], ["PROTECTED AREA", 30], ["WHEN ALARM SOUNDS", 22], ["LEAVE ROOM AT ONCE", 22], ["DO NOT ENTER UNTIL", 20], ["VENTILATED", 20]], { border: "#141414" }),
  sign("sign_chem_store", "Plate: CHEMICAL STORE 2-01, under the hazard diamond", [0.3, 0.09], "#2b2e31", "#e9e6dc", [["CHEMICAL STORE 2-01", 34], ["FLAMMABLES · CORROSIVES · KEY: LAB MGR 2-08", 13]]),
  sign("sign_cold_room", "Plate: COLD ROOM 4 °C (2-06)", [0.4, 0.14], "#2f6a44", "#f1ece0", [["COLD ROOM  4 °C", 46], ["KEEP DOOR SHUT · INSIDE RELEASE ON LATCH", 16]]),
  sign("sign_sensor_store", "Placard: SL-ARRAY 2 — SENSOR HEADS (2-25)", [0.6, 0.14], "#e8c31a", "#141414", [["SL-ARRAY 2 — SENSOR HEADS", 44], ["SIGN OUT WITH FIELD OPS · DO NOT POWER ON BENCH", 15]]),
  sign("plate_sl_link", "Legend plate: SL LINK STATUS (3-06)", [0.26, 0.22], "#2b2e31", "#e9e6dc", [["SL LINK STATUS", 30], ["1   2   3   4   5   6", 34], ["GREEN = CARRIER", 16], ["RED = LOST", 16]]),
  sign("label_rack_in", "Time-card rack label: IN", [0.4, 0.05], "#ece7da", "#141414", [["IN", 60]]),
  sign("label_rack_out", "Time-card rack label: OUT", [0.4, 0.05], "#ece7da", "#141414", [["OUT", 60]]),
  sign("label_rack_sl", "Time-card rack strip: SL (red)", [0.4, 0.05], "#a3241c", "#f1ece0", [["SL — FIELD OPERATIONS", 40]]),
  {
    id: "lift_dial",
    title: "Lift floor indicator dial face (semicircle: G 1 2 3 4)",
    size: [0.34, 0.17],
    paper: "plate",
    tags: ["wall"],
    density: 1.6,
    draw(d) {
      d.fill(0, 0, d.wmm, d.hmm, "#d8d2c0")
      const cx = d.wmm / 2, cy = d.hmm - 6
      ;["G", "1", "2", "3", "4"].forEach((s, k) => {
        const a = -Math.PI / 2 + ((k + 0.5) / 5) * Math.PI - Math.PI / 2
        const r = 130
        d.print(s, cx + Math.cos(a) * r, cy + Math.sin(a) * r + 10, { pt: 60, font: "Archivo Black", align: "center", color: "#1a1a1a" })
      })
    },
  },
  {
    id: "lift_panel",
    title: "Lift car operating panel labels",
    size: [0.1, 0.4],
    paper: "plate",
    tags: ["wall"],
    density: 2,
    draw(d) {
      d.fill(0, 0, d.wmm, d.hmm, "#b9b8b0")
      ;["4", "3", "2", "1", "G"].forEach((s, i) => d.print(s, 22, 60 + i * 55, { pt: 50, font: "Archivo Black", align: "center", color: "#1a1a1a" }))
      d.print("ALARM", 50, 340, { pt: 22, weight: 800, align: "center", color: "#a3241c" })
      d.print("SL ⌧ KEY", 50, 380, { pt: 20, weight: 800, align: "center", color: "#1a1a1a" })
      d.print("CAP. 2500 LB", 50, 20, { pt: 14, weight: 700, align: "center", color: "#1a1a1a" })
    },
  },
  {
    id: "cert_elevator",
    title: "Elevator inspection certificate (framed, in the car)",
    size: [0.2, 0.26],
    paper: "white",
    tags: ["wall"],
    density: 2.4,
    draw(d) {
      d.rect(6, 6, d.wmm - 12, d.hmm - 12, 1, "#3b4f8e")
      d.print("CERTIFICATE OF INSPECTION", d.wmm / 2, 30, { pt: 15, weight: 800, align: "center", color: "#3b4f8e" })
      d.print("PASSENGER ELEVATOR", d.wmm / 2, 42, { pt: 11, weight: 700, align: "center" })
      const r: [string, string][] = [["LOCATION", "PINE HOLLOW STATION, CORE"], ["CAR NO.", "P-1"], ["CAPACITY", "2500 LB / 16 PERSONS"], ["SERVES", "G, 1, 2, 3, 4"], ["INSPECTED", "MAY 14, 1984"], ["EXPIRES", "MAY 31, 1985"]]
      r.forEach(([k, v], i) => {
        d.print(k, 16, 70 + i * 22, { pt: 8, weight: 700 })
        d.type(v, 62, 70 + i * 22, { pt: 9, font: "Courier Prime" })
      })
      d.hand("H. Grieve", 100, 225, { pt: 18, font: "Nothing You Could Do", color: INK.black })
      d.print("STATE ELEVATOR INSPECTOR", d.wmm / 2, 245, { pt: 7, align: "center" })
      d.hand("SL stop? not on cert", 14, 205, { pt: 12, color: INK.pencil, font: "Reenie Beanie" })
    },
  },
  {
    id: "tag_halon",
    title: "Halon bottle inspection tag",
    size: [0.12, 0.16],
    paper: "card",
    tags: ["wall"],
    density: 3,
    draw(d) {
      d.fill(0, 0, d.wmm, 26, "#e8c31a")
      d.print("DO NOT REMOVE", d.wmm / 2, 17, { pt: 14, weight: 800, align: "center" })
      d.print("HALON 1301 · 95 LB", d.wmm / 2, 40, { pt: 11, weight: 700, align: "center" })
      ;["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].forEach((m, i) => {
        const x = 10 + (i % 4) * 26, y = 60 + Math.floor(i / 4) * 26
        d.rect(x, y, 22, 20, 0.3)
        d.print(m, x + 11, y + 8, { pt: 7, align: "center" })
        if (i < 9) d.hand("✓", x + 6, y + 19, { pt: 14, color: INK.black })
      })
      d.hand("1984 — TO", 20, 150, { pt: 16, color: INK.black })
    },
  },
  ...[0, 1, 2, 3, 4].map((s): DocSpec => ({
    id: `breaker_schedule_${s}`,
    title: `Panelboard directory card, EL-${s}`,
    size: [0.24, 0.2],
    paper: "card",
    tags: ["wall"],
    density: 2,
    draw(d) {
      d.print(`PANEL ${s === 0 ? "G" : s}A — EL-${s}`, d.wmm / 2, 14, { pt: 13, weight: 800, align: "center" })
      d.print("120/208 V 3Ø 4W · 225 A MAIN", d.wmm / 2, 22, { pt: 7, align: "center" })
      const ccts = ["SPINE LTG E", "SPINE LTG W", "EXIT / EMERG", "RECEPT N", "RECEPT S", s === 3 ? "MACH RM (SEE 3-03)" : "OFFICE LTG", s === 4 ? "TEMP — CONTRACTOR" : "WC / JC", "W-1 TRUNK HTR", "SPARE", "SPARE"]
      ccts.forEach((c, i) => {
        const col = i % 2, row = Math.floor(i / 2)
        const x = 8 + col * 116, y = 40 + row * 30
        d.type(String(i * 2 + 1 + col), x, y, { pt: 9, font: "Courier Prime" })
        d.hand(c, x + 14, y, { pt: 12, color: INK.black })
        d.line(x, y + 4, x + 110, y + 4, 0.15)
      })
      if (s === 3) d.hand("trips after 0200 — reset", 20, 192, { pt: 12, color: INK.red, font: "Caveat" })
    },
  })),
  ...[0, 1, 2, 3, 4, 5].map((s): DocSpec => ({
    id: `stencil_storey_${s}`,
    title: `Stair landing stencil: storey ${s === 0 ? "G" : s === 5 ? "ROOF" : s}`,
    size: [0.5, 0.6],
    paper: "concrete",
    tags: ["wall"],
    density: 0.5,
    draw(d) {
      const t = s === 0 ? "G" : s === 5 ? "R" : String(s)
      d.print(t, d.wmm / 2, 400, { pt: 1200, font: "Archivo Black", align: "center", color: "#1e1e1e", alpha: 0.82 })
      d.print(s === 5 ? "ROOF" : s === 0 ? "GROUND" : "FLOOR", d.wmm / 2, 540, { pt: 180, font: "Archivo Black", align: "center", color: "#1e1e1e", alpha: 0.8 })
      for (let x = 60; x < d.wmm; x += 110) d.fill(x, 80, 6, 360, "#8d8b84", 0.5)
    },
  })),
  ...Array.from({ length: 12 }, (_, i) => smallLabel(`locker_${String(i + 1).padStart(2, "0")}`, `Locker number plate ${i + 1}`, [0.06, 0.03], [String(i + 1)], { paper: "brass_plate", tags: ["wall"] })),
  ...["SL −120 m  TRAYS 1–40", "SL −180 m  TRAYS 41–88", "SL −240 m  TRAYS 89–130", "SL −300 m  TRAYS 131–160", "SL −361 m  SPECIMENS", "SL −388 m  SPECIMENS", "SL −410 m  DO NOT OPEN", "WATER  SL-W1…W12"].map((s, i) =>
    smallLabel(`label_depth_${i + 1}`, `Archive shelf label: ${s}`, [0.12, 0.025], [s], { tags: ["wall"] }),
  ),
  ...["SL-03 · 361 m · 9/12/84", "SL-07 · 372 m · 9/20/84", "SL-11 · 388 m · 10/1/84", "SL-14 · 401 m · 10/9/84", "SL-W4 water · 10/2", "SL-16 · 410 m · 10/17"].map((s, i) =>
    smallLabel(`label_jar_${i + 1}`, `Specimen jar label: ${s}`, [0.07, 0.035], s.split(" · ").slice(0, 2).concat(s.split(" · ")[2] ?? ""), { hand: true }),
  ),
  ...["CORE 81-07  118–121 m", "CORE 82-22  204–207 m", "CORE 83-40  296–299 m", "CORE 84-11  388–391 m"].map((s, i) => smallLabel(`label_core_${i + 1}`, `Core box end label: ${s}`, [0.1, 0.05], s.split("  "), { hand: true })),
  smallLabel("label_tray_sl14", "Tray label: SL-14 (containment)", [0.08, 0.03], ["SL-14  10/9"], { hand: true, color: INK.red }),
  smallLabel("tag_sl_array", "Sensor head tag: SL-ARRAY 2", [0.06, 0.04], ["SL-ARRAY 2", "HEAD 07"], { hand: true }),
  smallLabel("label_chem_key", "Key cabinet label: CHEM STORE", [0.12, 0.05], ["CHEM STORE 2-01", "RETURN HERE"], {}),
  ...["RESPIRATORS", "FILM · DARKROOM", "SPILL KIT", "GLASSWARE"].map((s, i) => smallLabel(`label_cabinet_${i + 1}`, `Cabinet label: ${s}`, [0.16, 0.06], [s], { tags: ["wall"] })),
  ...["A – BAL", "BAN – CAR", "CAS – DOR", "DOS – FEN", "FER – HAL", "HAM – KEM", "KEN – LIN", "LIP – MOR"].map((s, i) =>
    smallLabel(`label_catalogue_${i + 1}`, `Card catalogue drawer label: ${s}`, [0.04, 0.016], [s]),
  ),
  ...["CONTRACTS 1982", "CONTRACTS 1983", "CONTRACTS 1984", "PERSONNEL A–L", "PERSONNEL M–Z", "SL ROTATION 81–84", "PAYROLL FY84", "IOPS CORRESP."].map((s, i) =>
    smallLabel(`label_file_${i + 1}`, `File / shelving range label: ${s}`, [0.08, 0.04], [s], { tags: ["wall", "desk"] }),
  ),
  ...[
    ["R. HALLORAN", "DIRECTOR"], ["M. ESCOBAR", "DEPUTY DIRECTOR"], ["G. PRUITT", "PROTECTIVE SVCS"], ["D. AMUNDSEN", "SAMPLE SCIENCES"],
    ["T. WEXLER", "COMPUTING"], ["J. ORMOND", "PROGRAM ADMIN."], ["P. MOREAU", "FIELD OPERATIONS"], ["H. YOST", "PROPERTY"],
    ["L. PRUITT", "LAB SAFETY"], ["C. BRANDT", "FACILITIES & PLANT"], ["IOPS", "OBSERVER"], ["S. KALE", "IOPS LIAISON"],
  ].map(([n, r], i): DocSpec => ({
    id: `namecard_${String(i + 1).padStart(2, "0")}`,
    title: `Table name card: ${n} (${r}), 4-12`,
    size: [0.21, 0.095],
    paper: "card",
    tags: ["desk"],
    density: 1.8,
    draw(d) {
      d.print(n!, d.wmm / 2, 52, { pt: 46, font: "Libre Franklin", weight: 800, align: "center" })
      d.print(r!, d.wmm / 2, 78, { pt: 20, font: "Libre Franklin", weight: 600, align: "center" })
    },
  })),
  dayCard("timecard_day_1", "D. Kemper", "0412"),
  dayCard("timecard_day_2", "G. Pell", "0431"),
  dayCard("timecard_day_3", "M. Duquette", "0377"),
  dayCard("timecard_day_4", "T. Okafor", "0519"),
  ...ROOMS.map(([id, label]) => doorPlate(id, label)),
  ...SERVICE_PLATES.map(([id, label]) => doorPlate(id, label, label === "JANITOR" || label === "STORE" ? "#2b2e31" : "#22324a")),
]
DOCS.push(...STAND_INS)

// ---------------------------------------------------------------------------------------------------- paper
const PAPER: Record<Paper, { color: string; rough: number; age: number; grain: number }> = {
  white: { color: "#ece7da", rough: 0.88, age: 0.45, grain: 0.06 },
  onion: { color: "#e6e2d6", rough: 0.8, age: 0.3, grain: 0.05 },
  yellow: { color: "#ecdf9a", rough: 0.86, age: 0.35, grain: 0.06 },
  goldenrod: { color: "#e2b85c", rough: 0.86, age: 0.3, grain: 0.06 },
  pink: { color: "#efc9c4", rough: 0.86, age: 0.35, grain: 0.06 },
  green: { color: "#cfe0c4", rough: 0.86, age: 0.35, grain: 0.06 },
  manila: { color: "#cfae74", rough: 0.92, age: 0.5, grain: 0.1 },
  card: { color: "#efebdf", rough: 0.85, age: 0.4, grain: 0.05 },
  legal: { color: "#f0e08a", rough: 0.86, age: 0.35, grain: 0.05 },
  greenbar: { color: "#ece9dc", rough: 0.86, age: 0.35, grain: 0.05 },
  polaroid: { color: "#eeece4", rough: 0.6, age: 0.3, grain: 0.03 },
  poster: { color: "#efebe0", rough: 0.7, age: 0.4, grain: 0.04 },
  sticky: { color: "#efe07a", rough: 0.86, age: 0.25, grain: 0.04 },
  plate: { color: "#2b2e31", rough: 0.45, age: 0.06, grain: 0.015 },
  timecard: { color: "#e6dcc2", rough: 0.88, age: 0.35, grain: 0.05 },
  chalk: { color: "#2b3a33", rough: 0.92, age: 0.02, grain: 0.04 },
  white_board: { color: "#e4e4dc", rough: 0.25, age: 0.08, grain: 0.015 },
  gypsum: { color: "#b9b6a9", rough: 0.92, age: 0.1, grain: 0.05 },
  felt: { color: "#1b1c1e", rough: 0.97, age: 0.02, grain: 0.03 },
  bronze: { color: "#5a4426", rough: 0.4, age: 0.05, grain: 0.03 },
  newsprint: { color: "#e2ddcc", rough: 0.9, age: 0.3, grain: 0.04 },
  blueprint: { color: "#2c4a78", rough: 0.88, age: 0.15, grain: 0.05 },
  concrete: { color: "#8d8b84", rough: 0.92, age: 0.05, grain: 0.07 },
  brass_plate: { color: "#b8955a", rough: 0.35, age: 0.05, grain: 0.02 },
}

function paperBase(d: Draw, paper: Paper) {
  const c = d.ctx
  c.fillStyle = PAPER[paper].color
  c.fillRect(0, 0, d.wmm, d.hmm)
  if (paper === "legal") {
    for (let y = 30; y < d.hmm - 8; y += 8.5) d.line(0, y, d.wmm, y, 0.18, "#5f86b8", 0.55)
    d.line(31, 0, 31, d.hmm, 0.25, "#c25a50", 0.6)
    d.line(32.2, 0, 32.2, d.hmm, 0.25, "#c25a50", 0.6)
    d.fill(0, 0, d.wmm, 4, "#7a4a2a", 0.25)
  }
  if (paper === "greenbar") {
    for (let y = 8; y < d.hmm; y += 25.4) d.fill(14, y, d.wmm - 28, 12.7, "#c3dcc0", 0.85)
    for (const x of [6, d.wmm - 6]) for (let y = 6; y < d.hmm; y += 12.7) {
      c.save()
      c.fillStyle = "#2a2a2a"
      c.globalAlpha = 0.75
      c.beginPath()
      c.arc(x, y, 2, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }
    d.line(12, 0, 12, d.hmm, 0.15, "#888", 0.5)
    d.line(d.wmm - 12, 0, d.wmm - 12, d.hmm, 0.15, "#888", 0.5)
  }
  if (paper === "polaroid") d.fill(5.6, 5.6, 76.8, 77.8, "#1a1a1a")
}

/** Ageing pass in pixel space: grain, edge yellowing, foxing, photocopy speckle, slight vignette. */
function age(canvas: HTMLCanvasElement, spec: DocSpec, mm: number) {
  const c = canvas.getContext("2d")!
  const p = PAPER[spec.paper]
  const W = canvas.width
  const H = canvas.height
  c.save()
  c.globalCompositeOperation = "multiply"
  const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) * 0.62)
  g.addColorStop(0, "rgba(255,255,255,1)")
  g.addColorStop(1, `rgba(${200 - p.age * 40},${180 - p.age * 50},${130 - p.age * 60},1)`)
  c.globalAlpha = p.age
  c.fillStyle = g
  c.fillRect(0, 0, W, H)
  // Foxing spots.
  for (let i = 0; i < 6 + p.age * 20; i++) {
    const x = rand() * W
    const y = rand() * H
    const r = rr(0.5, 3) * mm
    const fg = c.createRadialGradient(x, y, 0, x, y, r)
    fg.addColorStop(0, "rgba(150,110,60,0.25)")
    fg.addColorStop(1, "rgba(150,110,60,0)")
    c.globalAlpha = 1
    c.fillStyle = fg
    c.fillRect(x - r, y - r, 2 * r, 2 * r)
  }
  // Fibre/cloud texture at ~2 mm scale (smooth, so it costs little after compression); per-pixel noise stays tiny.
  const gw = Math.max(2, Math.round(W / (mm * 2)))
  const gh = Math.max(2, Math.round(H / (mm * 2)))
  const gcv = document.createElement("canvas")
  gcv.width = gw
  gcv.height = gh
  const gc = gcv.getContext("2d")!
  const gi = gc.createImageData(gw, gh)
  for (let i = 0; i < gi.data.length; i += 4) {
    const v = 255 - rand() * p.grain * 255 * 0.55
    gi.data[i] = gi.data[i + 1] = v
    gi.data[i + 2] = v * 0.99
    gi.data[i + 3] = 255
  }
  gc.putImageData(gi, 0, 0)
  c.globalAlpha = 1
  c.imageSmoothingEnabled = true
  c.imageSmoothingQuality = "high"
  c.drawImage(gcv, 0, 0, W, H)
  c.restore()
  const img = c.getImageData(0, 0, W, H)
  const a = img.data
  const copy = spec.copy
  for (let y = 0; y < H; y++) {
    const edge = copy ? Math.max(0, 1 - Math.min(y, H - y) / (H * 0.08)) * 0.25 : 0
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      let n = (rand() - 0.5) * p.grain * 40
      if (copy) {
        if (rand() < 0.0015) n -= 140
        n -= edge * 60 + Math.max(0, 1 - Math.min(x, W - x) / (W * 0.05)) * 15
      }
      a[i] = Math.max(0, Math.min(255, a[i]! + n))
      a[i + 1] = Math.max(0, Math.min(255, a[i + 1]! + n))
      a[i + 2] = Math.max(0, Math.min(255, a[i + 2]! + n * 0.95))
    }
  }
  if (copy) {
    // Photocopy: crush to a slightly grey, contrasty tone curve.
    for (let i = 0; i < a.length; i += 4) {
      const l = (a[i]! + a[i + 1]! + a[i + 2]!) / 3
      const k = l < 120 ? 0.82 : 1
      a[i] = a[i]! * k
      a[i + 1] = a[i + 1]! * k
      a[i + 2] = a[i + 2]! * k
    }
  }
  c.putImageData(img, 0, 0)
}

// ---------------------------------------------------------------------------------------------------- atlas
type Placed = { spec: DocSpec; canvas: HTMLCanvasElement; height: HTMLCanvasElement; rough: number; gloss: Draw["gloss"]; x: number; y: number; w: number; h: number; mm: number }

const SWATCHES: Record<string, { color: string; rough: number; metal: number }> = {
  pin_red: { color: "#b3261e", rough: 0.32, metal: 0 },
  pin_blue: { color: "#2a4fa0", rough: 0.32, metal: 0 },
  pin_yellow: { color: "#e2b31c", rough: 0.32, metal: 0 },
  pin_green: { color: "#2f7a3e", rough: 0.32, metal: 0 },
  pin_white: { color: "#e8e6e0", rough: 0.35, metal: 0 },
  steel: { color: "#a9abae", rough: 0.3, metal: 1 },
  brass: { color: "#b8955a", rough: 0.35, metal: 1 },
  tape: { color: "#d8c9a0", rough: 0.75, metal: 0 },
  clip_black: { color: "#1c1c1e", rough: 0.4, metal: 0.6 },
  cork: { color: "#9a7348", rough: 0.95, metal: 0 },
  paper: { color: "#e2dccb", rough: 0.9, metal: 0 },
}

export async function build(atlasSize: number, maxHeight = atlasSize) {
  const fonts = ["Special Elite", "Courier Prime", "Caveat", "Reenie Beanie", "Nothing You Could Do", "Oswald", "Archivo Black", "Libre Franklin", "VT323", "Permanent Marker"]
  await Promise.all(fonts.map((f) => document.fonts.load(`20px "${f}"`)))
  await Promise.all(
    Object.entries(IMAGES).map(
      ([k, url]) =>
        new Promise<void>((res) => {
          const img = new Image()
          img.onload = () => ((loaded[k] = img), res())
          img.src = url
        }),
    ),
  )
  // Pack with a shelf packer; shrink densities until everything fits.
  const gutter = 12
  let scale = 1
  let placed: Placed[] = []
  let usedH = 0
  for (let attempt = 0; attempt < 20; attempt++) {
    const sizes = DOCS.map((s) => {
      const mm = (s.density ?? 3.2) * ((s.density ?? 3.2) >= 2.2 ? scale : 1)
      return { s, mm, w: Math.ceil(s.size[0] * 1000 * mm), h: Math.ceil(s.size[1] * 1000 * mm) }
    })
    const order = [...sizes].sort((a, b) => b.h - a.h)
    let x = gutter
    let y = gutter
    let shelf = 0
    let ok = true
    const pos = new Map<DocSpec, [number, number]>()
    for (const it of order) {
      if (x + it.w + gutter > atlasSize) {
        x = gutter
        y += shelf + gutter * 2
        shelf = 0
      }
      if (y + it.h + gutter > maxHeight - 56) {
        ok = false
        break
      }
      pos.set(it.s, [x, y])
      x += it.w + gutter * 2
      shelf = Math.max(shelf, it.h)
    }
    if (ok) {
      usedH = y + shelf + gutter
      placed = sizes.map((it) => ({ spec: it.s, canvas: null!, height: null!, rough: 0, gloss: [], x: pos.get(it.s)![0], y: pos.get(it.s)![1], w: it.w, h: it.h, mm: it.mm }))
      break
    }
    scale *= 0.95
  }
  if (!placed.length) throw new Error("documents do not fit the atlas")
  const AW = atlasSize
  const AH = Math.ceil((usedH + 56) / 64) * 64

  for (const p of placed) {
    seed = 1 + [...p.spec.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 100000, 7)
    const cv = document.createElement("canvas")
    cv.width = p.w
    cv.height = p.h
    const ctx = cv.getContext("2d")!
    const d = new Draw(ctx, p.mm, p.spec.size[0] * 1000, p.spec.size[1] * 1000)
    paperBase(d, p.spec.paper)
    p.spec.draw(d)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    age(cv, p.spec, p.mm)
    // Crease shading in colour (a light ridge beside a soft shadow).
    for (const [x0, y0, x1, y1, s] of d.creases) {
      if (!s) continue
      const ax = x0 * p.mm, ay = y0 * p.mm, bx = x1 * p.mm, by = y1 * p.mm
      const nx = -(by - ay), ny = bx - ax
      const l = Math.hypot(nx, ny) || 1
      ctx.save()
      ctx.globalAlpha = 0.18 * s
      ctx.lineWidth = 1.2 * p.mm
      ctx.strokeStyle = "#5a4a30"
      ctx.beginPath()
      ctx.moveTo(ax + (nx / l) * p.mm * 0.5, ay + (ny / l) * p.mm * 0.5)
      ctx.lineTo(bx + (nx / l) * p.mm * 0.5, by + (ny / l) * p.mm * 0.5)
      ctx.stroke()
      ctx.globalAlpha = 0.25 * s
      ctx.strokeStyle = "#fffaf0"
      ctx.lineWidth = 0.6 * p.mm
      ctx.beginPath()
      ctx.moveTo(ax - (nx / l) * p.mm * 0.4, ay - (ny / l) * p.mm * 0.4)
      ctx.lineTo(bx - (nx / l) * p.mm * 0.4, by - (ny / l) * p.mm * 0.4)
      ctx.stroke()
      ctx.restore()
    }
    // Height map (full res; downsampled with the normal atlas): grain + crease ridges.
    const hv = document.createElement("canvas")
    hv.width = p.w
    hv.height = p.h
    const hc = hv.getContext("2d")!
    hc.fillStyle = "#808080"
    hc.fillRect(0, 0, p.w, p.h)
    const hi = hc.getImageData(0, 0, p.w, p.h)
    for (let i = 0; i < hi.data.length; i += 4) {
      const v = 128 + (rand() - 0.5) * 18
      hi.data[i] = hi.data[i + 1] = hi.data[i + 2] = v
    }
    hc.putImageData(hi, 0, 0)
    hc.filter = `blur(${Math.max(0.6, p.mm * 0.2)}px)`
    hc.drawImage(hv, 0, 0)
    hc.filter = "none"
    for (const [x0, y0, x1, y1, s] of d.creases) {
      if (!s) continue
      hc.save()
      hc.filter = `blur(${p.mm * 1.2}px)`
      hc.strokeStyle = `rgba(255,255,255,${0.6 * s})`
      hc.lineWidth = p.mm * 2.2
      hc.beginPath()
      hc.moveTo(x0 * p.mm, y0 * p.mm)
      hc.lineTo(x1 * p.mm, y1 * p.mm)
      hc.stroke()
      hc.restore()
    }
    p.canvas = cv
    p.height = hv
    p.rough = PAPER[p.spec.paper].rough
    p.gloss = d.gloss
  }

  const base = document.createElement("canvas")
  base.width = AW
  base.height = AH
  const bc = base.getContext("2d")!
  bc.fillStyle = "#e6e0d0"
  bc.fillRect(0, 0, AW, AH)
  const height = document.createElement("canvas")
  height.width = AW
  height.height = AH
  const hc = height.getContext("2d")!
  hc.fillStyle = "#808080"
  hc.fillRect(0, 0, AW, AH)
  const orm = document.createElement("canvas")
  orm.width = AW
  orm.height = AH
  const oc = orm.getContext("2d")!
  oc.fillStyle = "rgb(255,224,0)"
  oc.fillRect(0, 0, AW, AH)
  const manifest: Record<string, unknown> = {}
  for (const p of placed) {
    // Gutter: the page stretched under itself so mips don't bleed the background in.
    bc.drawImage(p.canvas, p.x - gutter, p.y - gutter, p.w + gutter * 2, p.h + gutter * 2)
    bc.drawImage(p.canvas, p.x, p.y)
    hc.drawImage(p.height, p.x - gutter, p.y - gutter, p.w + gutter * 2, p.h + gutter * 2)
    hc.drawImage(p.height, p.x, p.y)
    const r = Math.round(p.rough * 255)
    oc.fillStyle = `rgb(255,${r},0)`
    oc.fillRect(p.x - gutter, p.y - gutter, p.w + gutter * 2, p.h + gutter * 2)
    for (const [gx, gy, gw, gh, kind] of p.gloss) {
      oc.fillStyle = kind ? "rgb(255,90,0)" : "rgb(255,80,255)"
      oc.fillRect(p.x + gx * p.mm, p.y + gy * p.mm, gw * p.mm, gh * p.mm)
    }
    manifest[p.spec.id] = {
      title: p.spec.title,
      size: p.spec.size,
      uv: [p.x / AW, p.y / AH, (p.x + p.w) / AW, (p.y + p.h) / AH],
      tags: p.spec.tags,
      paper: p.spec.paper,
      pxPerMm: +p.mm.toFixed(2),
    }
  }
  // Swatches for pins, tape and clips along the bottom edge.
  const swatches: Record<string, [number, number]> = {}
  Object.entries(SWATCHES).forEach(([k, s], i) => {
    const x = 16 + i * 48
    const y = AH - 48
    bc.fillStyle = s.color
    bc.fillRect(x, y, 40, 40)
    if (k === "tape" || k === "cork") {
      for (let n = 0; n < 400; n++) {
        bc.fillStyle = `rgba(${k === "cork" ? "60,40,20" : "120,100,60"},${rr(0.05, 0.25)})`
        bc.fillRect(x + rand() * 40, y + rand() * 40, 1.5, 1.5)
      }
    }
    oc.fillStyle = `rgb(255,${Math.round(s.rough * 255)},${Math.round(s.metal * 255)})`
    oc.fillRect(x, y, 40, 40)
    swatches[k] = [(x + 20) / AW, (y + 20) / AH]
  })
  // Height → tangent-space normal (OpenGL convention: +Y up, V down in the image so green is flipped).
  const H = hc.getImageData(0, 0, AW, AH).data
  const ncan = document.createElement("canvas")
  ncan.width = AW
  ncan.height = AH
  const nc = ncan.getContext("2d")!
  const out = nc.createImageData(AW, AH)
  const k = 2.2
  for (let y = 0; y < AH; y++)
    for (let x = 0; x < AW; x++) {
      const i = y * AW + x
      const l = H[(y * AW + Math.max(0, x - 1)) * 4]!
      const r = H[(y * AW + Math.min(AW - 1, x + 1)) * 4]!
      const u = H[(Math.max(0, y - 1) * AW + x) * 4]!
      const dn = H[(Math.min(AH - 1, y + 1) * AW + x) * 4]!
      let nx = ((l - r) / 255) * k
      let ny = ((dn - u) / 255) * k
      let nz = 1
      const len = Math.hypot(nx, ny, nz)
      nx /= len
      ny /= len
      nz /= len
      out.data[i * 4] = (nx * 0.5 + 0.5) * 255
      out.data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255
      out.data[i * 4 + 2] = (nz * 0.5 + 0.5) * 255
      out.data[i * 4 + 3] = 255
    }
  nc.putImageData(out, 0, 0)
  return {
    base: base.toDataURL("image/png"),
    normal: ncan.toDataURL("image/png"),
    orm: orm.toDataURL("image/png"),
    manifest: { atlas: [AW, AH], documents: manifest, swatches },
  }
}

;(globalThis as { __build?: typeof build }).__build = build
