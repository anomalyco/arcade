// Browser-side renderer for the set-dressing document atlas (bundled and run headless by scripts/build-documents.ts).
// Every document is drawn with Canvas 2D in millimetres: typewriter/print/handwriting text, stamps, forms, then paper
// ageing (grain, yellowing, foxing, creases, pin holes, coffee rings). Outputs three atlases — base colour, a height
// map turned into a normal map (creases, grain), ORM (roughness per material) — and a manifest of UV rects.
// All content is original: the "Office of Signal Research, Larch Hollow Field Station" and everyone in it are invented.

type Ctx = CanvasRenderingContext2D
type Paper = "white" | "onion" | "yellow" | "goldenrod" | "pink" | "green" | "manila" | "card" | "legal" | "greenbar" | "polaroid" | "poster" | "sticky"
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
const STATION = "LARCH HOLLOW FIELD STATION"
const OFFICE = "OFFICE OF SIGNAL RESEARCH"
const NAMES = [
  "R. Kessler", "D. Amundsen", "T. Okafor", "M. Brandt", "L. Pruitt", "J. Halloran", "S. Vance", "E. Lindqvist",
  "P. Moreau", "C. Duquette", "W. Farris", "A. Nakamura", "G. Pell", "H. Yost", "B. Szabo", "K. Dorsey",
]
const letterhead = (d: Draw, y = 18) => {
  d.print(OFFICE, d.wmm / 2, y, { font: "Libre Franklin", pt: 11, weight: 700, align: "center", spacing: 0.6 })
  d.print(STATION + " · MERRITT FALLS", d.wmm / 2, y + 5, { pt: 7.5, align: "center", spacing: 0.4 })
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

const DOCS: DocSpec[] = [
  {
    id: "memo_signin",
    title: "Memo: night shift sign-in procedure",
    size: LETTER,
    paper: "white",
    tags: ["board", "desk", "clipboard"],
    draw(d) {
      letterhead(d)
      const y = memoHead(d, "All Division 4 Personnel", "R. Kessler, Acting Station Supv.", "October 9, 1984", "Night shift sign-in")
      const body =
        "Effective Monday 15 October, all personnel remaining on station after 2200 hours will sign in AND out at the lobby desk. This applies to contractors and visiting staff from the regional office.\n" +
        "Escort is required beyond Corridor 2 after 2200. The receiving bay and the north stair are to remain closed overnight. If you find either open, close it and note the time on the sheet.\n" +
        "Several entries last week showed a sign-in with no sign-out. I am sure these are oversights. Please be careful.\n" +
        "Questions to my office, ext. 214."
      let yy = d.typeLines(d.wrap(body, 62), 25, y, 4.6)
      d.hand("RK", 128, yy + 10, { pt: 22, font: "Nothing You Could Do", color: INK.black })
      d.type("RK/dla", 25, yy + 24, { pt: 9 })
      d.type("cc: Security, File 4-117", 25, yy + 29, { pt: 9 })
      d.stamp(["RECEIVED", "OCT 11 1984", "DIV. 4"], 160, 34, -0.12)
      d.holes(d.wmm / 2, 6)
      d.crease(0, d.hmm / 3, d.wmm, d.hmm / 3)
      d.crease(0, (d.hmm * 2) / 3, d.wmm, (d.hmm * 2) / 3)
    },
  },
  {
    id: "memo_carbon_inventory",
    title: "Carbon copy: Sublevel B equipment inventory",
    size: LETTER,
    paper: "onion",
    tags: ["desk", "clipboard"],
    draw(d) {
      const o = { color: INK.carbon, carbon: true, fade: 0.85 }
      d.type(OFFICE + " - " + STATION, 25, 20, { ...o, pt: 9 })
      const y = memoHead(d, "H. Yost, Property Control", "T. Okafor, Div. 4 Receivers", "Oct. 3, 1984", "Inventory, Sublevel B", 32, o)
      const items = [
        "QTY  DESCRIPTION                           TAG NO.",
        " 2   Receiver, VLF, rack mount             OSR-40871",
        " 1   Chart recorder, 6-channel             OSR-40904",
        " 4   Headset, closed back                  OSR-41022",
        " 1   Oscilloscope, dual trace              OSR-38815",
        " 1   Tape deck, reel, 1/4 in.              OSR-39760",
        " 12  Reels, 7 in., blank                   --",
        " 1   Cot, folding                          OSR-12002",
        " 1   Cot, folding                          MISSING",
      ]
      let yy = d.typeLines(items, 25, y, 4.6, { ...o, font: "Courier Prime" })
      yy = d.typeLines(d.wrap("Items tagged MISSING were last signed for on the night of 9/28. Lock on B-14 replaced 10/2. Recommend the stair door alarm be reconnected.", 62), 25, yy + 6, 4.6, o)
      d.type("TO:dk     cc: File, Security (2)", 25, yy + 10, { ...o, pt: 9 })
      d.crease(0, d.hmm / 2, d.wmm, d.hmm / 2, 0.6)
    },
  },
  {
    id: "notice_sublevel",
    title: "Notice: unauthorized access to Sublevel C",
    size: LETTER,
    paper: "white",
    tags: ["board", "wall", "creepy"],
    copy: true,
    draw(d) {
      letterhead(d)
      d.print("NOTICE TO ALL PERSONNEL", d.wmm / 2, 48, { pt: 18, weight: 800, align: "center", spacing: 0.8 })
      d.print("Unauthorized access to Sublevel C", d.wmm / 2, 58, { pt: 12, weight: 600, align: "center" })
      const body = [
        "The Sublevel C stairwell is CLOSED until further notice.",
        "Access requires written authorization from the Station",
        "Supervisor and a second badged escort. No exceptions.",
        "",
        "Personnel are reminded that sounds reported from the",
        "stairwell are to be logged on OSR Form 41-C and are",
        "NOT to be investigated. Do not open the stair door to",
        "check on anyone. Telephone ext. 300 instead.",
        "",
        "The door at the bottom of the stair is to remain shut",
        "even if                                                         .",
      ]
      body.forEach((l, i) => d.print(l, 30, 76 + i * 5.6, { pt: 10.5 }))
      d.redact(43, 76 + 10 * 5.6 - 3.6, 100)
      d.redact(30, 76 + 11 * 5.6 - 3.6, 150)
      d.redact(30, 76 + 12 * 5.6 - 3.6, 82)
      d.print("By order of the Station Supervisor  ·  Station Order 84-31", d.wmm / 2, 168, { pt: 8.5, align: "center" })
      d.stamp(["RESTRICTED", "DIVISION 4"], 150, 196, 0.1, INK.red, 13)
      d.hand("who is ext 300?", 34, 214, { pt: 15, color: INK.pencil, font: "Reenie Beanie", slant: -0.04 })
      d.holes(d.wmm / 2, 7)
    },
  },
  {
    id: "notice_parking",
    title: "Notice: Parking Lot B closed",
    size: LETTER,
    paper: "white",
    tags: ["board", "wall"],
    copy: true,
    draw(d) {
      d.print("PARKING", d.wmm / 2, 52, { pt: 52, font: "Oswald", weight: 700, align: "center" })
      d.print("LOT B CLOSED", d.wmm / 2, 82, { pt: 40, font: "Oswald", weight: 700, align: "center" })
      d.print("October 15 – November 2, 1984", d.wmm / 2, 98, { pt: 14, weight: 600, align: "center" })
      const l = ["Lot B is being resurfaced by the county.", "Please use Lot A or the gravel overflow by the guard booth.", "Vehicles left in Lot B after 6 AM Monday will be towed", "at the owner's expense.", "", "Night staff: the lot lamps by the dish road are out.", "Walk in pairs to your car after midnight."]
      l.forEach((s, i) => d.print(s, d.wmm / 2, 120 + i * 6.4, { pt: 11, align: "center" }))
      d.print("— Facilities, ext. 230", d.wmm / 2, 180, { pt: 10, align: "center" })
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
      const l = ["Fire doors must be kept closed at all times.", "Propping a fire door with wedges, chairs or", "extinguishers is a violation of Station Order 12-7.", "", "Doors on the north stair are alarmed after 2200.", "If a door will not latch, report it to Facilities", "at once. Do not leave it."]
      l.forEach((s, i) => d.print(s, d.wmm / 2, 82 + i * 6.6, { pt: 12, align: "center" }))
      d.print("THIS DOOR TO REMAIN CLOSED", d.wmm / 2, 160, { pt: 16, weight: 800, align: "center", spacing: 0.8 })
      d.rect(14, 14, d.wmm - 28, d.hmm - 28, 0.8, "#a3241c")
      d.hand("someone keeps opening it", 40, 230, { pt: 15, color: INK.black, font: "Caveat", slant: -0.05 })
    },
  },
  {
    id: "notice_nightshift",
    title: "Notice: night shift sign in at lobby desk",
    size: HALF,
    paper: "goldenrod",
    tags: ["board", "wall"],
    copy: true,
    draw(d) {
      d.print("NIGHT SHIFT", d.wmm / 2, 32, { pt: 34, font: "Oswald", weight: 700, align: "center" })
      d.print("SIGN IN AT THE LOBBY DESK AFTER 2200", d.wmm / 2, 50, { pt: 13, weight: 700, align: "center" })
      d.print("Escort required beyond Corridor 2.  Badges visible at all times.", d.wmm / 2, 64, { pt: 10, align: "center" })
      d.print("Sign OUT when you leave. Every time.", d.wmm / 2, 74, { pt: 10, weight: 700, align: "center" })
      d.print("Station Supervisor", d.wmm / 2, 112, { pt: 8, align: "center" })
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
      d.print("OSR Form 41-A (Rev. 8-83) · Lobby desk · Retain 90 days", d.wmm / 2, 26, { pt: 7.5, align: "center" })
      const cols = [14, 38, 92, 120, 148, 176, 202]
      const heads = ["DATE", "NAME (PRINT)", "BADGE", "TIME IN", "TIME OUT", "INIT."]
      heads.forEach((h, i) => d.print(h, cols[i]! + 1.5, 36, { pt: 7, weight: 700 }))
      for (let r = 0; r <= 26; r++) d.line(14, 38 + r * 8.6, 202, 38 + r * 8.6, r === 0 ? 0.4 : 0.18)
      for (const x of cols) d.line(x, 31, x, 38 + 26 * 8.6, 0.2)
      d.line(14, 31, 202, 31, 0.4)
      const rows: [string, string, string, string, string, string][] = [
        ["10/12", "T. Okafor", "4417", "2215", "0140", "TO"],
        ["10/12", "J. Halloran", "4402", "2230", "0315", "JH"],
        ["10/13", "M. Brandt", "4388", "2205", "2350", "MB"],
        ["10/13", "S. Vance", "4425", "2300", "0410", "SV"],
        ["10/14", "T. Okafor", "4417", "2210", "0122", "TO"],
        ["10/14", "E. Lindqvist", "4391", "2245", "", ""],
        ["10/15", "J. Halloran", "4402", "2220", "0305", "JH"],
        ["10/15", "W. Farris (contr.)", "V-12", "2330", "0200", "WF"],
        ["10/16", "T. Okafor", "4417", "2208", "0118", "TO"],
        ["10/16", "E. Lindqvist", "4391", "2240", "", ""],
        ["10/17", "S. Vance", "4425", "2310", "0402", "SV"],
        ["10/17", "E. Lindqvist", "4391", "2240", "", ""],
        ["10/18", "E. Lindqvist", "4391", "2240", "", ""],
        ["10/18", "E. Lindqvist", "4391", "2240", "", ""],
      ]
      const hands = new Map<string, { font: (typeof HANDS)[number]; color: string; slant: number }>()
      rows.forEach((row, r) => {
        const who = row[1].split(" (")[0]!
        if (!hands.has(who)) hands.set(who, { font: pick(HANDS), color: pick([INK.ballBlue, INK.black, INK.blue, INK.pencil]), slant: rr(-0.06, 0.03) })
        const h = hands.get(who)!
        const y = 38 + (r + 1) * 8.6 - 2.2
        row.forEach((v, i) => v && d.hand(v, cols[i]! + 2, y, { pt: h.font === "Caveat" ? 14 : 15, ...h }))
      })
      d.hand("?", 152, 38 + 6 * 8.6 - 2.2, { pt: 16, color: INK.red })
      d.scribble(176, 38 + 13 * 8.6 - 4, 200, 38 + 14 * 8.6 - 2, 0.4, INK.red)
      d.hand("see me — RK", 150, 38 + 16 * 8.6, { pt: 15, color: INK.red, font: "Caveat" })
      d.holes(d.wmm / 2, 6)
    },
  },
  {
    id: "roster_duty",
    title: "Duty roster, week of Oct 15 (one name crossed out)",
    size: LETTER,
    paper: "white",
    tags: ["board", "wall", "creepy"],
    draw(d) {
      letterhead(d, 16)
      d.type("DIVISION 4 - RECEIVER WATCH ROSTER", 25, 38, { pt: 12 })
      d.type("Week of 15 October 1984", 25, 44)
      const days = ["MON 15", "TUE 16", "WED 17", "THU 18", "FRI 19", "SAT 20", "SUN 21"]
      const x0 = 22
      const cw = 24
      days.forEach((s, i) => d.type(s, x0 + 30 + i * cw, 56, { pt: 8.5 }))
      const watches = ["0700-1500", "1500-2300", "2300-0700"]
      const crew = [["Okafor", "Brandt", "Vance"], ["Halloran", "Pell", "Lindqvist"], ["Moreau", "Szabo", "Dorsey"]]
      for (let w = 0; w < 3; w++) {
        d.type(watches[w]!, x0, 66 + w * 22, { pt: 9 })
        for (let i = 0; i < 7; i++)
          for (let k = 0; k < 2; k++) {
            const name = crew[w]![(i + k + w) % 3]!
            const y = 66 + w * 22 + k * 6
            d.type(name, x0 + 30 + i * cw, y, { pt: 8, font: "Courier Prime" })
            if (name === "Lindqvist") {
              d.scribble(x0 + 29 + i * cw, y - 1.2, x0 + 50 + i * cw, y - 1.4, 0.55, INK.black)
              d.scribble(x0 + 29 + i * cw, y - 0.6, x0 + 50 + i * cw, y - 1.8, 0.55, INK.black)
            }
          }
      }
      for (let w = 0; w <= 3; w++) d.line(x0, 60 + w * 22, d.wmm - 18, 60 + w * 22, 0.2)
      d.type("Swaps must be approved by the watch supervisor.", 25, 140, { pt: 9.5 })
      d.type("Third watch: two on station at all times. No exceptions.", 25, 145, { pt: 9.5 })
      d.hand("Lindqvist off roster until further notice — do not call", 26, 162, { pt: 15, color: INK.black, font: "Caveat", slant: -0.02 })
      d.hand("she called in Tues. 0300 from ext 300??", 32, 174, { pt: 14, color: INK.ballBlue, font: "Reenie Beanie", slant: 0.03 })
      d.holes(15, 7)
      d.holes(d.wmm - 15, 7)
      d.crease(d.wmm / 2, 0, d.wmm / 2, d.hmm, 0.5)
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
      d.print("Thursdays 7:00 PM · Larch Hollow Lanes · teams of four · $3/week incl. shoes", d.wmm / 2, 29, { pt: 8, align: "center" })
      d.print("NAME", 22, 42, { pt: 8, weight: 700 })
      d.print("EXT.", 100, 42, { pt: 8, weight: 700 })
      d.print("AVG", 128, 42, { pt: 8, weight: 700 })
      d.print("TEAM / NOTES", 150, 42, { pt: 8, weight: 700 })
      for (let r = 0; r < 24; r++) d.line(18, 45 + r * 9, 200, 45 + r * 9, 0.18)
      const e: [string, string, string, string][] = [
        ["Doris Kemper", "231", "142", "Payroll Pinheads (capt.)"],
        ["Gary Pell", "226", "168", "Payroll Pinheads"],
        ["Ted Okafor", "247", "110?", "anywhere"],
        ["Marge Duquette", "205", "151", "w/ Doris"],
        ["Bill Szabo", "262", "175", "Receivers team"],
        ["Kevin Dorsey", "263", "", "Receivers"],
        ["Ellen Lindqvist", "248", "131", "Receivers"],
        ["J. Halloran", "246", "155", "whoever needs 1"],
      ]
      e.forEach((row, r) => {
        const h = { font: pick(HANDS), color: pick([INK.ballBlue, INK.black, INK.blue]), slant: rr(-0.05, 0.03) }
        row.forEach((v, i) => v && d.hand(v, [22, 100, 128, 150][i]!, 45 + (r + 1) * 9 - 2.5, { pt: 15, ...h }))
      })
      d.scribble(20, 45 + 7 * 9 - 4, 98, 45 + 7 * 9 - 4.5, 0.4, INK.black)
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
      d.print("Thursdays · 7 PM · Larch Hollow Lanes, Route 9", d.wmm / 2, 167, { pt: 11, align: "center" })
      d.print("Season starts October 4 · teams of four · all skill levels", d.wmm / 2, 174, { pt: 10, align: "center" })
      d.print("See Doris in Payroll or call ext. 231", d.wmm / 2, 184, { pt: 11, weight: 700, align: "center" })
      // Tear-off tabs, three torn away.
      const n = 9
      const tw = (d.wmm - 8) / n
      for (let i = 0; i < n; i++) {
        const x = 4 + i * tw
        if (i === 2 || i === 5 || i === 6) {
          d.scribble(x, 238 + rr(-1, 1), x + tw, 238 + rr(-1, 1), 0.2, "#7a6a50")
          d.fill(x + 0.3, 239, tw - 0.6, d.hmm - 239, "#1a1814", 0.9)
          continue
        }
        d.line(x, 232, x, d.hmm, 0.25, INK.black, 0.5)
        d.ctx.save()
        d.ctx.translate(x + tw / 2 + 1.2, 274)
        d.ctx.rotate(-Math.PI / 2)
        d.print("BOWLING · Doris x231", 0, 0, { pt: 7.5 })
        d.ctx.restore()
      }
      d.line(4, 232, d.wmm - 4, 232, 0.2, INK.black, 0.4)
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
      const l = ["Grey long-hair tabby, 9 yrs, very friendly. Answers to Biscuit.", "Last seen by the LOADING DOCK on Tues. Oct 2 around 11 PM.", "He does not go near the woods. Please check sheds and garages."]
      l.forEach((s, i) => d.print(s, d.wmm / 2, 186 + i * 6, { pt: 10, align: "center" }))
      d.print("REWARD · call Marge Duquette, ext. 205 or 555-0142", d.wmm / 2, 210, { pt: 11, weight: 800, align: "center" })
      d.hand("seen him on the dock camera 10/9 3am? — S.V.", 30, 226, { pt: 14, color: INK.ballBlue, font: "Reenie Beanie", slant: -0.03 })
      const n = 8
      const tw = (d.wmm - 8) / n
      for (let i = 0; i < n; i++) {
        const x = 4 + i * tw
        if (i === 1 || i === 4) {
          d.scribble(x, 240 + rr(-1, 1), x + tw, 240 + rr(-1, 1), 0.2, "#7a6a50")
          d.fill(x + 0.3, 241, tw - 0.6, d.hmm - 241, "#1a1814", 0.9)
          continue
        }
        d.line(x, 238, x, d.hmm, 0.25, INK.black, 0.5)
        d.ctx.save()
        d.ctx.translate(x + tw / 2 + 1.5, 276)
        d.ctx.rotate(-Math.PI / 2)
        d.print("BISCUIT 555-0142", 0, 0, { pt: 8, weight: 700 })
        d.ctx.restore()
      }
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
      d.print("MENU — WEEK OF OCTOBER 15, 1984", d.wmm / 2, 32, { pt: 11, weight: 700, align: "center" })
      d.print("Hot line 11:15–1:30 · Night cart 0100 (Corridor 2 vending alcove)", d.wmm / 2, 38, { pt: 8, align: "center" })
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
      d.print("Coffee 25¢ · Milk 30¢ · Soup of the day 60¢", d.wmm / 2, 248, { pt: 9.5, align: "center" })
      d.hand("Thurs. CANCELLED - see note", 110, 160, { pt: 14, color: INK.red, font: "Caveat", slant: -0.06 })
      d.scribble(28, 160, 105, 159, 0.4, INK.red)
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
    density: 2.3,
    draw(d) {
      d.fill(0, 0, d.wmm, 80, "#e8c31a")
      d.print("CAUTION", d.wmm / 2, 42, { pt: 64, font: "Archivo Black", align: "center", color: "#7a1f6e" })
      d.print("RADIATION AREA", d.wmm / 2, 68, { pt: 34, font: "Archivo Black", align: "center", color: "#111" })
      // Trefoil.
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
      const rules = ["1. Wear your film badge at all times in this area.", "2. No eating, drinking or smoking.", "3. Survey hands and shoes at the exit monitor.", "4. Report spills and alarms to the Radiation Safety", "    Officer, ext. 270, immediately.", "5. Do not remove sources from the vault."]
      rules.forEach((s, i) => d.print(s, 30, 236 + i * 9, { pt: 14 }))
      d.print("RADIATION SAFETY OFFICE · LARCH HOLLOW FIELD STATION · POSTER RS-2 (1981)", d.wmm / 2, 420, { pt: 7, align: "center" })
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
    density: 2.3,
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
      d.print("Spills: evacuate, close the door, call ext. 270.", d.wmm / 2, 352, { pt: 13, align: "center" })
      d.print("LABORATORY SAFETY COMMITTEE · POSTER LS-5", d.wmm / 2, 420, { pt: 7, align: "center" })
      d.holes(10, 8)
      d.holes(d.wmm - 10, 8)
      d.crease(0, d.hmm / 2, d.wmm, d.hmm / 2, 0.8)
    },
  },
  {
    id: "map_evacuation",
    title: "Evacuation route map, typical floor",
    size: [0.279, 0.216],
    paper: "white",
    tags: ["wall"],
    density: 3,
    draw(d) {
      d.print("EMERGENCY EVACUATION ROUTE", 14, 16, { pt: 16, weight: 800 })
      d.print("MAIN BLOCK · TYPICAL UPPER FLOOR · DO NOT USE ELEVATOR", 14, 22, { pt: 8 })
      const x0 = 14
      const x1 = d.wmm - 14
      const y0 = 40
      const y1 = 160
      const cy = (y0 + y1) / 2
      d.rect(x0, y0, x1 - x0, y1 - y0, 0.9)
      d.line(x0, cy - 5, x1, cy - 5, 0.5)
      d.line(x0, cy + 5, x1, cy + 5, 0.5)
      for (let i = 1; i < 14; i++) {
        const x = x0 + ((x1 - x0) * i) / 14
        d.line(x, y0, x, cy - 5, 0.35)
        if (i !== 4 && i !== 5) d.line(x, cy + 5, x, y1, 0.35)
      }
      d.rect(x0 + ((x1 - x0) * 4) / 14 + 2, cy + 8, ((x1 - x0) * 1) / 14 - 4, 30, 0.4, INK.black, "#d8d4c8")
      d.print("STAIR", x0 + ((x1 - x0) * 4.5) / 14, cy + 26, { pt: 6, align: "center" })
      d.print("ELEV.", x0 + ((x1 - x0) * 5.4) / 14, cy + 26, { pt: 6, align: "center" })
      d.rect(x1 - 10, cy - 5, 10, 10, 0.4, INK.black, "#d8d4c8")
      d.print("STAIR", x1 - 5, cy + 1.5, { pt: 5, align: "center" })
      d.rect(x0, cy - 5, 8, 10, 0.4, INK.black, "#d8d4c8")
      d.print("FIRE ESC.", x0 + 4, cy + 1.2, { pt: 4.2, align: "center" })
      const arrow = (ax: number, bx: number) => {
        d.line(ax, cy, bx, cy, 1.4, "#b3261e", 0.95)
        const s = Math.sign(bx - ax)
        const c = d.ctx
        c.save()
        c.fillStyle = "#b3261e"
        c.beginPath()
        c.moveTo(bx + s * 3, cy)
        c.lineTo(bx - s * 1, cy - 2.4)
        c.lineTo(bx - s * 1, cy + 2.4)
        c.fill()
        c.restore()
      }
      arrow(x0 + 120, x0 + 12)
      arrow(x0 + 128, x1 - 14)
      d.ctx.save()
      d.ctx.fillStyle = "#b3261e"
      d.ctx.beginPath()
      d.ctx.arc(x0 + 124, cy, 3, 0, Math.PI * 2)
      d.ctx.fill()
      d.ctx.restore()
      d.print("YOU ARE HERE", x0 + 124, cy - 9, { pt: 7, weight: 800, align: "center", color: "#b3261e" })
      d.print("ASSEMBLY POINT: PARKING LOT A, NORTH OF THE FLAGPOLE", 14, 176, { pt: 9, weight: 700 })
      d.print("■ extinguisher   ▲ pull station   — route", 14, 184, { pt: 8 })
      d.print("Sublevel stair not shown. Not an exit.", 14, 200, { pt: 7 })
    },
  },
  {
    id: "form_requisition",
    title: "Lab supply requisition form (OSR 113-B)",
    size: LETTER,
    paper: "white",
    tags: ["desk", "clipboard"],
    draw(d) {
      d.print("OSR FORM 113-B (Rev. 3-82)", 14, 12, { pt: 7 })
      d.print("LABORATORY SUPPLY REQUISITION", d.wmm / 2, 22, { pt: 14, weight: 800, align: "center" })
      d.print(OFFICE + " · " + STATION, d.wmm / 2, 28, { pt: 7.5, align: "center" })
      const box = (x: number, y: number, w: number, h: number, label: string, val?: string) => {
        d.rect(x, y, w, h, 0.3)
        d.print(label, x + 1.2, y + 3, { pt: 5.5 })
        if (val) d.type(val, x + 2, y + h - 2.4, { pt: 9.5, font: "Courier Prime" })
      }
      box(14, 34, 94, 12, "REQUESTED BY", "T. OKAFOR")
      box(108, 34, 46, 12, "DIVISION / ROOM", "4 / 2-117")
      box(154, 34, 48, 12, "DATE", "10-11-84")
      box(14, 46, 94, 12, "CHARGE ACCOUNT", "84-4-0331-R")
      box(108, 46, 94, 12, "DELIVER TO", "SUBLEVEL B, RM B-14")
      const cols = [14, 30, 48, 150, 176, 202]
      ;["QTY", "UNIT", "DESCRIPTION", "UNIT $", "TOTAL"].forEach((h, i) => d.print(h, cols[i]! + 1.2, 64, { pt: 6.5, weight: 700 }))
      for (let r = 0; r <= 16; r++) d.line(14, 66 + r * 7.5, 202, 66 + r * 7.5, r === 0 ? 0.35 : 0.18)
      for (const x of cols) d.line(x, 60, x, 66 + 16 * 7.5, 0.25)
      d.line(14, 60, 202, 60, 0.3)
      const items = [
        ["12", "EA", "BEAKER, BOROSILICATE, 600 ML", "2.15", "25.80"],
        ["6", "EA", "FLASK, ERLENMEYER, 250 ML", "3.40", "20.40"],
        ["2", "BX", "CHART PAPER, 6-CH, ROLL", "18.75", "37.50"],
        ["10", "EA", "REEL, MAGNETIC TAPE, 7 IN.", "6.90", "69.00"],
        ["1", "CS", "BATTERY, D CELL (24)", "14.40", "14.40"],
        ["4", "EA", "LAMP, FLASHLIGHT, SPARE", "1.10", "4.40"],
        ["1", "EA", "PADLOCK, KEYED ALIKE (B-14)", "8.25", "8.25"],
      ]
      items.forEach((row, r) => row.forEach((v, i) => d.type(v, cols[i]! + 1.5, 66 + (r + 1) * 7.5 - 2, { pt: 9, font: "Courier Prime" })))
      box(150, 66 + 16 * 7.5, 52, 10, "TOTAL", "$179.75")
      box(14, 200, 94, 18, "JUSTIFICATION")
      d.type("REPLACE ITEMS LOST 9/28. SEE MEMO", 16, 211, { pt: 8.5, font: "Courier Prime" })
      d.type("TO/10-3. LOCK PER SECURITY.", 16, 215.5, { pt: 8.5, font: "Courier Prime" })
      box(108, 200, 94, 18, "APPROVED (DIV. HEAD)")
      d.hand("D. Amundsen", 120, 214, { pt: 18, font: "Nothing You Could Do", color: INK.black })
      d.stamp(["APPROVED", "OCT 12 1984"], 70, 240, -0.08, INK.green)
      d.print("WHITE: PURCHASING   YELLOW: RECEIVING   PINK: REQUESTER", d.wmm / 2, 268, { pt: 6, align: "center" })
    },
  },
  {
    id: "printout_greenbar",
    title: "Green-bar computer printout (receiver log)",
    size: [0.378, 0.279],
    paper: "greenbar",
    tags: ["desk", "floor", "creepy"],
    density: 3,
    draw(d) {
      const left = 14
      const lines: string[] = []
      lines.push("OSR/LHFS  RCVR 3 SIGNAL LOG          RUN 84.288.03        PAGE 0117")
      lines.push("DATE      TIME(L)   FREQ(KHZ)   LEVEL(DB)   SNR    FLAG   OPER")
      lines.push("--------  --------  ----------  ----------  -----  -----  ----")
      let t = 2 * 3600 + 51 * 60
      for (let i = 0; i < 30; i++) {
        t += 13 + Math.floor(rand() * 40)
        const hh = String(Math.floor(t / 3600) % 24).padStart(2, "0")
        const mm = String(Math.floor(t / 60) % 60).padStart(2, "0")
        const ss = String(t % 60).padStart(2, "0")
        const f = (11.905 + rand() * 0.004).toFixed(4)
        const anomalous = i > 18
        const lvl = anomalous ? (-12.0 + rand()).toFixed(1) : (-71 + rand() * 6).toFixed(1)
        const snr = anomalous ? "  41.8" : rr(2, 9).toFixed(1).padStart(6)
        const flag = anomalous ? "*****" : i % 7 === 3 ? "  NB " : "     "
        lines.push(`10/14/84  ${hh}:${mm}:${ss}  ${f.padStart(10)}  ${lvl.padStart(10)}  ${snr}  ${flag}  ${anomalous ? "----" : "TO  "}`)
      }
      lines.push("")
      lines.push("*** LEVEL EXCEEDS CALIBRATED RANGE - RECORDER 3 SATURATED ***")
      lines.push("*** OPERATOR NOT AT CONSOLE 03:10:44 - 03:58:02 ***")
      lines.forEach((l, i) => d.type(l, left + 6, 14 + i * 6.35 - 1.5, { pt: 9.2, font: "VT323", color: "#2a2a30" }))
      d.hand("03:10 again", 250, 158, { pt: 18, color: INK.red, font: "Caveat", slant: -0.08 })
      d.ctx.save()
      d.ctx.strokeStyle = INK.red
      d.ctx.lineWidth = 0.5
      d.ctx.globalAlpha = 0.8
      d.ctx.beginPath()
      d.ctx.ellipse(130, 14 + 22 * 6.35, 112, 30, 0, 0, Math.PI * 2)
      d.ctx.stroke()
      d.ctx.restore()
      d.crease(0, d.hmm, d.wmm, d.hmm, 0)
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
    title: "Sticky note: dish motor down",
    size: [0.076, 0.076],
    paper: "sticky",
    tags: ["desk", "board", "wall"],
    density: 5,
    draw(d) {
      d.hand("DISH MOTOR", 7, 18, { pt: 20, font: "Permanent Marker", color: "#1a1a1a" })
      d.hand("DOWN", 7, 32, { pt: 26, font: "Permanent Marker", color: "#1a1a1a" })
      d.hand("do not slew - T.", 7, 48, { pt: 15, color: INK.ballBlue })
      d.hand("10/14", 46, 64, { pt: 13, color: INK.ballBlue })
    },
  },
  {
    id: "sticky_marge",
    title: "Sticky note: call Marge",
    size: [0.076, 0.076],
    paper: "sticky",
    tags: ["desk", "board"],
    density: 5,
    draw(d) {
      d.hand("Call Marge", 6, 18, { pt: 17, color: INK.ballBlue, font: "Caveat" })
      d.hand("re: X-ray film", 6, 30, { pt: 15, color: INK.ballBlue, font: "Caveat" })
      d.hand("& the cat thing", 6, 42, { pt: 15, color: INK.ballBlue, font: "Caveat" })
      d.scribble(6, 46, 50, 46.5, 0.35)
      d.hand("x205", 40, 64, { pt: 16, color: INK.black, font: "Caveat" })
    },
  },
  {
    id: "sticky_dont",
    title: "Sticky note: don't answer 300",
    size: [0.076, 0.076],
    paper: "sticky",
    tags: ["desk", "creepy"],
    density: 5,
    draw(d) {
      d.hand("if x300", 8, 24, { pt: 22, color: INK.black, font: "Nothing You Could Do" })
      d.hand("rings —", 8, 40, { pt: 22, color: INK.black, font: "Nothing You Could Do" })
      d.hand("let it.", 18, 58, { pt: 22, color: INK.black, font: "Nothing You Could Do" })
    },
  },
  {
    id: "card_extensions",
    title: "Index card: phone extensions",
    size: [0.127, 0.076],
    paper: "card",
    tags: ["desk", "board"],
    density: 4.5,
    draw(d) {
      d.line(0, 12, d.wmm, 12, 0.3, "#b3261e", 0.7)
      for (let i = 1; i < 7; i++) d.line(0, 12 + i * 8.6, d.wmm, 12 + i * 8.6, 0.18, "#4a7ab8", 0.6)
      d.hand("EXTENSIONS", 6, 9.5, { pt: 15, color: INK.black, font: "Caveat" })
      const e = ["Lobby desk ... 200", "Kessler ... 214", "Facilities ... 230", "Rad. Safety ... 270", "Dish control ... 288", "Security ... 299"]
      e.forEach((s, i) => d.hand(s, 6, 12 + (i + 1) * 8.6 - 1.5, { pt: 13.5, color: INK.ballBlue }))
      d.hand("300 = ???", 80, 12 + 6 * 8.6 - 1.5, { pt: 13.5, color: INK.red })
    },
  },
  {
    id: "polaroid_dish",
    title: "Polaroid: the dish at dusk",
    size: [0.088, 0.107],
    paper: "polaroid",
    tags: ["board", "desk"],
    density: 5,
    draw(d) {
      d.image("polaroid-dish", 6, 6, 76, 77, "sepia(0.25) saturate(0.8) contrast(0.9) brightness(1.05)")
      d.gloss.push([6, 6, 76, 77, 1])
      d.hand("dish, Sept '84", 12, 97, { pt: 15, color: INK.black, font: "Caveat" })
    },
  },
  {
    id: "polaroid_corridor",
    title: "Polaroid: corridor at 2:40 am",
    size: [0.088, 0.107],
    paper: "polaroid",
    tags: ["board", "desk", "creepy"],
    density: 5,
    draw(d) {
      d.image("polaroid-corridor", 6, 6, 76, 77, "sepia(0.15) saturate(0.85) contrast(0.95)")
      d.gloss.push([6, 6, 76, 77, 1])
      d.hand("C-wing 2:40am", 10, 95, { pt: 14, color: INK.black, font: "Caveat" })
      d.hand("who?", 58, 101, { pt: 13, color: INK.red, font: "Caveat" })
    },
  },
  {
    id: "calendar_oct84",
    title: "Wall calendar page, October 1984",
    size: [0.28, 0.215],
    paper: "white",
    tags: ["wall", "board"],
    density: 3,
    draw(d) {
      d.print("OCTOBER", 14, 22, { pt: 30, font: "Oswald", weight: 700 })
      d.print("1984", d.wmm - 14, 22, { pt: 30, font: "Oswald", weight: 300, align: "right" })
      const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
      const x0 = 12
      const cw = (d.wmm - 24) / 7
      const y0 = 30
      const ch = 30
      days.forEach((s, i) => d.print(s, x0 + i * cw + cw / 2, y0 + 5, { pt: 7, weight: 700, align: "center" }))
      // Oct 1 1984 = Monday.
      for (let day = 1; day <= 31; day++) {
        const idx = day // Monday offset 1
        const col = idx % 7
        const row = Math.floor(idx / 7)
        const x = x0 + col * cw
        const y = y0 + 8 + row * ch
        d.rect(x, y, cw, ch, 0.2)
        d.print(String(day), x + 2, y + 6, { pt: 10, weight: 700, color: col === 0 ? "#b3261e" : INK.black })
        if (day <= 17) d.scribble(x + 3, y + 3, x + cw - 3, y + ch - 3, 0.3, INK.black)
      }
      const notes: [number, string, string][] = [
        [4, "bowling 7pm", INK.ballBlue],
        [9, "dish svc", INK.black],
        [12, "PAYDAY", INK.green],
        [15, "Lot B closed", INK.ballBlue],
        [17, "E.L. ??", INK.red],
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
      const rows = [
        ["Lobby / night desk", "200"], ["Station Supervisor (Kessler)", "214"], ["Admin. office (Amundsen)", "216"],
        ["Payroll (Kemper)", "231"], ["Facilities / maintenance", "230"], ["Cafeteria", "240"],
        ["Div. 4 Receivers - console", "246"], ["Div. 4 Receivers - office", "247"], ["Records", "252"],
        ["Computer room", "260"], ["Radiation Safety Officer", "270"], ["Chemistry lab 2-04", "275"],
        ["Dish control (roof)", "288"], ["Guard booth", "298"], ["Security office", "299"],
        ["Emergency (fire / medical)", "333"],
      ]
      rows.forEach(([k, v], i) => {
        d.type(k!, 30, 56 + i * 7.2)
        d.type(v!, 160, 56 + i * 7.2)
        d.type(".".repeat(22), 112, 56 + i * 7.2, { fade: 0.6 })
      })
      d.type("Ext. 300 is not assigned. Report calls from 300 to", 30, 56 + 17 * 7.2, { pt: 9.5 })
      d.type("Security (299).", 30, 56 + 18 * 7.2, { pt: 9.5 })
      d.hand("again", 100, 56 + 18 * 7.2 + 1, { pt: 15, color: INK.red, font: "Caveat" })
      d.holes(d.wmm / 2, 6)
      d.coffee(175, 250, 32, 0.28)
    },
  },
  {
    id: "memo_coffee",
    title: "Memo: coffee fund short",
    size: HALF,
    paper: "pink",
    tags: ["board", "wall"],
    draw(d) {
      d.type("TO ALL WHO DRINK THE COFFEE:", 18, 22, { pt: 11 })
      const l = d.wrap("The coffee fund is $14.50 short this month. You know who you are. The can is on the shelf above the machine. Filters are NOT free either. The pot does not wash itself. Thank you.", 58)
      d.typeLines(l, 18, 34, 5)
      d.hand("— Doris", 130, 80, { pt: 20, color: INK.ballBlue, font: "Caveat" })
      d.hand("paid! -GP", 22, 116, { pt: 14, color: INK.black, font: "Reenie Beanie" })
      d.holes(d.wmm / 2, 6)
    },
  },
  {
    id: "checklist_rounds",
    title: "Night rounds checklist (last rounds unticked)",
    size: LETTER,
    paper: "white",
    tags: ["clipboard", "creepy"],
    draw(d) {
      d.print("NIGHT ROUNDS CHECKLIST", d.wmm / 2, 20, { pt: 15, weight: 800, align: "center" })
      d.print("Security · OSR Form 7-R · one sheet per watch · initial each check", d.wmm / 2, 26, { pt: 7.5, align: "center" })
      d.hand("Date: 10/17/84    Officer: S. Vance", 20, 38, { pt: 15, color: INK.black })
      const stops = ["Lobby doors locked", "Corridor 2 fire doors shut", "Receiving bay door down", "North stair door alarmed", "Lab 2-04 hood off", "Computer room temp < 70°F", "Dish control panel - stowed", "Sublevel C stair door SHUT", "Guard booth radio check", "Lot A / Lot B walk"]
      const times = ["2300", "0100", "0300", "0500"]
      times.forEach((t, i) => d.print(t, 130 + i * 18, 50, { pt: 8, weight: 700 }))
      stops.forEach((s, r) => {
        const y = 60 + r * 11
        d.print(s, 20, y, { pt: 9.5 })
        d.line(18, y + 3.5, 200, y + 3.5, 0.15, INK.black, 0.5)
        times.forEach((_, i) => {
          const done = i < 2 || (i === 2 && r < 7)
          d.checkbox(131 + i * 18, y, 3.4, done, INK.black)
          if (done && rand() < 0.5) d.hand("SV", 136 + i * 18, y, { pt: 10, color: INK.black })
        })
      })
      d.hand("C stair door OPEN 0310. Shut it. Open again 0318.", 20, 186, { pt: 14, color: INK.black, font: "Caveat", slant: -0.02 })
      d.hand("Called 299. No answer. Called 300", 20, 196, { pt: 14, color: INK.black, font: "Caveat", slant: -0.015 })
      d.holes(d.wmm / 2, 6)
    },
  },
  {
    id: "envelope_interoffice",
    title: "Interoffice routing envelope",
    size: [0.25, 0.33],
    paper: "manila",
    tags: ["desk", "floor"],
    density: 2.8,
    draw(d) {
      d.print("INTEROFFICE MAIL — DO NOT SEAL", d.wmm / 2, 16, { pt: 12, weight: 800, align: "center" })
      d.print("OSR Form 2 · cross out previous name · reuse", d.wmm / 2, 22, { pt: 7, align: "center" })
      const cols = [12, 92, 162, 238]
      ;["NAME", "ROOM / DIV.", "DATE"].forEach((h, i) => d.print(h, cols[i]! + 2, 32, { pt: 7, weight: 700 }))
      for (let r = 0; r <= 24; r++) d.line(12, 34 + r * 11.5, 238, 34 + r * 11.5, 0.25)
      for (const x of cols) d.line(x, 27, x, 34 + 24 * 11.5, 0.25)
      const e: [string, string, string][] = [
        ["H. Yost", "Property", "6/84"], ["R. Kessler", "214", "7/84"], ["T. Okafor", "2-117", "8/84"],
        ["Records", "3", "9/84"], ["E. Lindqvist", "Div 4", "10/9"], ["E. Lindqvist", "Div 4", "10/16"],
        ["Security", "299", "10/17"],
      ]
      e.forEach((row, r) => {
        const h = { font: pick(HANDS), color: pick([INK.ballBlue, INK.black, INK.pencil]) }
        row.forEach((v, i) => d.hand(v, cols[i]! + 3, 34 + (r + 1) * 11.5 - 3, { pt: 15, ...h }))
        if (r < 6) d.scribble(13, 34 + (r + 1) * 11.5 - 5, 236, 34 + (r + 1) * 11.5 - 5.5, 0.45, INK.black)
      })
      d.crease(0, d.hmm * 0.55, d.wmm, d.hmm * 0.56, 0.7)
    },
  },
]

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
  c.restore()
  const img = c.getImageData(0, 0, W, H)
  const a = img.data
  const copy = spec.copy
  for (let y = 0; y < H; y++) {
    const edge = copy ? Math.max(0, 1 - Math.min(y, H - y) / (H * 0.08)) * 0.25 : 0
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      let n = (rand() - 0.5) * p.grain * 255
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
}

export async function build(atlasSize: number) {
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
  for (let attempt = 0; attempt < 20; attempt++) {
    const sizes = DOCS.map((s) => {
      const mm = (s.density ?? 3.4) * scale
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
      if (y + it.h + gutter > atlasSize - 64) {
        ok = false
        break
      }
      pos.set(it.s, [x, y])
      x += it.w + gutter * 2
      shelf = Math.max(shelf, it.h)
    }
    if (ok) {
      placed = sizes.map((it) => ({ spec: it.s, canvas: null!, height: null!, rough: 0, gloss: [], x: pos.get(it.s)![0], y: pos.get(it.s)![1], w: it.w, h: it.h, mm: it.mm }))
      break
    }
    scale *= 0.95
  }
  if (!placed.length) throw new Error("documents do not fit the atlas")

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
  base.width = base.height = atlasSize
  const bc = base.getContext("2d")!
  bc.fillStyle = "#e6e0d0"
  bc.fillRect(0, 0, atlasSize, atlasSize)
  const height = document.createElement("canvas")
  height.width = height.height = atlasSize
  const hc = height.getContext("2d")!
  hc.fillStyle = "#808080"
  hc.fillRect(0, 0, atlasSize, atlasSize)
  const orm = document.createElement("canvas")
  orm.width = orm.height = atlasSize
  const oc = orm.getContext("2d")!
  oc.fillStyle = "rgb(255,224,0)"
  oc.fillRect(0, 0, atlasSize, atlasSize)
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
      uv: [p.x / atlasSize, p.y / atlasSize, (p.x + p.w) / atlasSize, (p.y + p.h) / atlasSize],
      tags: p.spec.tags,
      paper: p.spec.paper,
      pxPerMm: +p.mm.toFixed(2),
    }
  }
  // Swatches for pins, tape and clips along the bottom edge.
  const swatches: Record<string, [number, number]> = {}
  Object.entries(SWATCHES).forEach(([k, s], i) => {
    const x = 16 + i * 48
    const y = atlasSize - 48
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
    swatches[k] = [(x + 20) / atlasSize, (y + 20) / atlasSize]
  })
  // Height → tangent-space normal (OpenGL convention: +Y up, V down in the image so green is flipped).
  const H = hc.getImageData(0, 0, atlasSize, atlasSize).data
  const ncan = document.createElement("canvas")
  ncan.width = ncan.height = atlasSize
  const nc = ncan.getContext("2d")!
  const out = nc.createImageData(atlasSize, atlasSize)
  const k = 2.2
  for (let y = 0; y < atlasSize; y++)
    for (let x = 0; x < atlasSize; x++) {
      const i = y * atlasSize + x
      const l = H[(y * atlasSize + Math.max(0, x - 1)) * 4]!
      const r = H[(y * atlasSize + Math.min(atlasSize - 1, x + 1)) * 4]!
      const u = H[(Math.max(0, y - 1) * atlasSize + x) * 4]!
      const dn = H[(Math.min(atlasSize - 1, y + 1) * atlasSize + x) * 4]!
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
    manifest: { atlas: atlasSize, documents: manifest, swatches },
  }
}

;(globalThis as { __build?: typeof build }).__build = build
