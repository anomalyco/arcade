/**
 * Runtime-painted texture atlas for text and signage decals (POLICE door lettering, unit numbers, HOTEL neon,
 * billboards, district lettering). The layout is a fixed table so mesh builders can map UVs without a canvas;
 * `paintAtlas()` draws the same table into a 2048x2048 RGBA image in the browser.
 *
 * Texture convention: lettering is painted white on transparent so the vertex color tints it; billboards are
 * painted in full color (use a white vertex color). Alpha below 0.5 is discarded (alpha test).
 */
export const ATLAS_SIZE = 2048

type Paint = (g: OffscreenCanvasRenderingContext2D, w: number, h: number) => void

type Entry = { x: number; y: number; w: number; h: number; paint: Paint }

const DISPLAY = "'Barlow Condensed', 'Arial Narrow', sans-serif"

function text(str: string, opts: { weight?: number; size?: number; spacing?: number; color?: string; italic?: boolean } = {}): Paint {
  return (g, w, h) => {
    const size = opts.size ?? h * 0.82
    g.font = `${opts.italic ? "italic " : ""}${opts.weight ?? 800} ${size}px ${DISPLAY}`
    g.fillStyle = opts.color ?? "#fff"
    g.textAlign = "center"
    g.textBaseline = "middle"
    const sp = opts.spacing ?? 0
    if (!sp) {
      const m = g.measureText(str)
      const scale = Math.min(1, (w * 0.94) / m.width)
      g.save()
      g.translate(w / 2, h / 2 + size * 0.04)
      g.scale(scale, 1)
      g.fillText(str, 0, 0)
      g.restore()
      return
    }
    // Letter-spaced: lay out manually and fit the width.
    const widths = [...str].map((c) => g.measureText(c).width)
    const total = widths.reduce((a, b) => a + b, 0) + sp * (str.length - 1)
    const scale = Math.min(1, (w * 0.94) / total)
    g.save()
    g.translate(w / 2 - (total * scale) / 2, h / 2 + size * 0.04)
    g.scale(scale, 1)
    let x = 0
    g.textAlign = "left"
    ;[...str].forEach((c, i) => {
      g.fillText(c, x, 0)
      x += widths[i]! + sp
    })
    g.restore()
  }
}

/** A vertical sign: letters stacked top to bottom. */
function vertical(str: string): Paint {
  return (g, w, h) => {
    const n = str.length
    const size = Math.min(w * 0.85, (h / n) * 0.92)
    g.font = `800 ${size}px ${DISPLAY}`
    g.fillStyle = "#fff"
    g.textAlign = "center"
    g.textBaseline = "middle"
    ;[...str].forEach((c, i) => g.fillText(c, w / 2, (h / n) * (i + 0.5)))
  }
}

function billboard(lines: string[], bg: [string, string], fg: string, skyline = true): Paint {
  return (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, bg[0])
    grad.addColorStop(1, bg[1])
    g.fillStyle = grad
    g.fillRect(0, 0, w, h)
    if (skyline) {
      g.fillStyle = "rgba(10,20,40,0.55)"
      let x = 0
      let s = 7
      while (x < w) {
        s = (s * 9301 + 49297) % 233280
        const bw = 10 + (s % 26)
        const bh = h * (0.12 + ((s >> 3) % 100) / 380)
        g.fillRect(x, h - bh, bw, bh)
        x += bw + 2
      }
    }
    g.fillStyle = fg
    g.textAlign = "left"
    g.textBaseline = "top"
    const size = h * 0.16
    g.font = `italic 800 ${size}px ${DISPLAY}`
    lines.forEach((l, i) => g.fillText(l, w * 0.08, h * 0.1 + i * size * 1.02))
    g.strokeStyle = "rgba(255,255,255,0.85)"
    g.lineWidth = Math.max(4, w * 0.02)
    g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth)
  }
}

function stripes(a: string, b: string): Paint {
  return (g, w, h) => {
    g.fillStyle = a
    g.fillRect(0, 0, w, h)
    g.fillStyle = b
    const s = h
    for (let x = -h; x < w + h; x += s * 2) {
      g.beginPath()
      g.moveTo(x, h)
      g.lineTo(x + s, h)
      g.lineTo(x + s + h, 0)
      g.lineTo(x + h, 0)
      g.closePath()
      g.fill()
    }
  }
}

function digits(): Record<string, Entry> {
  const out: Record<string, Entry> = {}
  for (let i = 0; i < 10; i++) out[`num${i}`] = { x: 1040 + i * 96, y: 0, w: 88, h: 128, paint: text(String(i), { weight: 800 }) }
  return out
}

/** Region table: name -> pixel rect in the atlas. Keep rects non-overlapping. (0..16, 0..16) is solid white. */
const TABLE = {
  white: { x: 0, y: 0, w: 16, h: 16, paint: (g, w, h) => ((g.fillStyle = "#fff"), g.fillRect(0, 0, w, h)) },
  police: { x: 16, y: 0, w: 512, h: 128, paint: text("POLICE", { weight: 800, italic: true }) },
  policeBlock: { x: 528, y: 0, w: 512, h: 128, paint: text("POLICE", { weight: 800, spacing: 8 }) },
  spd: { x: 0, y: 128, w: 256, h: 128, paint: text("SPD", { weight: 800, italic: true }) },
  hotel: { x: 256, y: 128, w: 128, h: 640, paint: vertical("HOTEL") },
  motel: { x: 384, y: 128, w: 128, h: 640, paint: vertical("MOTEL") },
  bar: { x: 512, y: 128, w: 128, h: 384, paint: vertical("BAR") },
  diner: { x: 640, y: 128, w: 512, h: 160, paint: text("DINER", { weight: 800, italic: true }) },
  liquor: { x: 640, y: 288, w: 512, h: 160, paint: text("LIQUOR", { weight: 800 }) },
  pawn: { x: 1152, y: 128, w: 512, h: 160, paint: text("PAWN", { weight: 800 }) },
  bank: { x: 1152, y: 288, w: 896, h: 160, paint: text("FIRST NATIONAL BANK", { weight: 700, spacing: 10 }) },
  jewelers: { x: 640, y: 448, w: 896, h: 160, paint: text("GOLDEN MILE JEWELERS", { weight: 700, spacing: 8 }) },
  gallery: { x: 640, y: 608, w: 896, h: 160, paint: text("HALCYON GALLERY", { weight: 700, spacing: 10 }) },
  precinct: { x: 1536, y: 448, w: 512, h: 160, paint: text("PRECINCT 9", { weight: 700, spacing: 6 }) },
  riverdale: { x: 0, y: 768, w: 1024, h: 320, paint: (g, w, h) => {
    g.font = `800 ${h * 0.46}px ${DISPLAY}`
    g.fillStyle = "#fff"
    g.textAlign = "center"
    g.textBaseline = "middle"
    g.fillText("RIVERDALE", w / 2, h * 0.3)
    g.fillText("CITY", w / 2, h * 0.76)
  } },
  harbor: { x: 1024, y: 768, w: 1024, h: 160, paint: text("HARBOR 7", { weight: 800, spacing: 18 }) },
  billboardA: { x: 0, y: 1088, w: 768, h: 1024 - 64, paint: billboard(["A CLEANER", "BRIGHTER", "TOMORROW"], ["#e7c79a", "#3d6f9a"], "#0d1a2e") },
  billboardB: { x: 768, y: 1088, w: 1024, h: 576, paint: billboard(["DRIVE", "A CLEANER", "TOMORROW"], ["#7fb8b0", "#2f5d6b"], "#f3efe6") },
  hazard: { x: 768, y: 1664, w: 512, h: 128, paint: stripes("#e9e4dc", "#c3262b") },
  hazardYellow: { x: 1280, y: 1664, w: 512, h: 128, paint: stripes("#16161a", "#e8b923") },
  container: { x: 768, y: 1792, w: 512, h: 128, paint: (g, w, h) => {
    g.fillStyle = "#fff"
    g.fillRect(0, 0, w, h)
    g.fillStyle = "rgba(0,0,0,0.28)"
    for (let x = 0; x < w; x += 18) g.fillRect(x, 0, 7, h)
  } },
  crosswalk: { x: 1280, y: 1792, w: 256, h: 128, paint: (g, w, h) => {
    g.fillStyle = "#fff"
    g.fillRect(0, 0, w, h)
    // Worn paint speckle.
    let s = 3
    for (let i = 0; i < 900; i++) {
      s = (s * 16807) % 2147483647
      const x = s % w
      s = (s * 16807) % 2147483647
      const y = s % h
      g.clearRect(x, y, 2 + (s % 4), 2)
    }
  } },
  ...digits(),
} satisfies Record<string, Entry>

export type AtlasRegion = keyof typeof TABLE

export const ATLAS_REGIONS = Object.keys(TABLE) as AtlasRegion[]

/** UV rect [u0, v0, u1, v1] for a region, inset half a texel to avoid bleeding. */
export function regionUv(name: AtlasRegion): [number, number, number, number] {
  const r = TABLE[name]
  const s = ATLAS_SIZE
  return [(r.x + 0.5) / s, (r.y + 0.5) / s, (r.x + r.w - 0.5) / s, (r.y + r.h - 0.5) / s]
}

/** Pixel aspect (width / height) of a region, for sizing decals without distortion. */
export function regionAspect(name: AtlasRegion) {
  const r = TABLE[name]
  return r.w / r.h
}

/** Paints the whole atlas. Waits for the display font so lettering uses Barlow Condensed. */
export async function paintAtlas(): Promise<ImageData> {
  try {
    await Promise.all([document.fonts.load(`800 64px ${DISPLAY}`), document.fonts.load(`italic 800 64px ${DISPLAY}`), document.fonts.load(`700 64px ${DISPLAY}`)])
  } catch {
    // Fall back to the system condensed font.
  }
  const c = new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE)
  const g = c.getContext("2d")!
  g.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)
  for (const r of Object.values(TABLE) as Entry[]) {
    g.save()
    g.beginPath()
    g.rect(r.x, r.y, r.w, r.h)
    g.clip()
    g.translate(r.x, r.y)
    r.paint(g, r.w, r.h)
    g.restore()
  }
  return g.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE)
}
