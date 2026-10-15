/** Small preview images of Library items, rendered once from the Lab's own viewport and kept in the browser. */

export const THUMB_KEY = "arcade.lab.library-thumbs.v1"
export const THUMB_WIDTH = 112
export const THUMB_HEIGHT = 72
const MAX_THUMBS = 240
const CROP = 0.7

type Stored = { version: 1; items: Record<string, { url: string; at: number }> }

function read(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(THUMB_KEY) ?? "null") as Stored | null
    if (raw && raw.version === 1 && raw.items && typeof raw.items === "object") {
      for (const [id, item] of Object.entries(raw.items)) {
        if (!item || typeof item.url !== "string" || !item.url.startsWith("data:image/")) delete raw.items[id]
      }
      return raw
    }
  } catch {}
  return { version: 1, items: {} }
}

export type ThumbCache = ReturnType<typeof createThumbCache>

export function createThumbCache() {
  let stored = read()
  const listeners = new Set<() => void>()

  function persist() {
    const ids = Object.keys(stored.items)
    if (ids.length > MAX_THUMBS) {
      ids.sort((a, b) => stored.items[a]!.at - stored.items[b]!.at)
      for (const id of ids.slice(0, ids.length - MAX_THUMBS)) delete stored.items[id]
    }
    for (;;) {
      try {
        localStorage.setItem(THUMB_KEY, JSON.stringify(stored))
        return
      } catch {
        // Over quota: drop the oldest half and retry.
        const rest = Object.keys(stored.items).sort((a, b) => stored.items[a]!.at - stored.items[b]!.at)
        if (!rest.length) return
        for (const id of rest.slice(0, Math.ceil(rest.length / 2))) delete stored.items[id]
      }
    }
  }

  return {
    get(id: string): string | null {
      return stored.items[id]?.url ?? null
    },
    has(id: string) {
      return id in stored.items
    },
    set(id: string, url: string) {
      stored.items[id] = { url, at: Date.now() }
      persist()
      for (const l of listeners) l()
    },
    clear(ids?: readonly string[]) {
      if (ids) for (const id of ids) delete stored.items[id]
      else stored = { version: 1, items: {} }
      persist()
      for (const l of listeners) l()
    },
    get size() {
      return Object.keys(stored.items).length
    },
    onChange(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Which readback path produced the last thumbnail (for proofs). */
export const thumbStats = { canvas: 0, fallback: 0, blank: 0 }

/**
 * Center-crops a frame to the thumbnail aspect and encodes it as WebP. Reads the viewport canvas's presented frame;
 * when that is unreadable or blank, `fallback` copies the renderer's own output into a 2D canvas instead.
 * Returns null when both are blank (nothing drawn yet).
 */
export async function captureThumb(source: HTMLCanvasElement, fallback?: (target: HTMLCanvasElement) => Promise<void>): Promise<string | null> {
  const direct = await encode(source)
  if (direct) {
    thumbStats.canvas++
    return direct
  }
  if (fallback) {
    const copy = document.createElement("canvas")
    try {
      await fallback(copy)
      const url = await encode(copy)
      if (url) {
        thumbStats.fallback++
        return url
      }
    } catch {}
  }
  thumbStats.blank++
  return null
}

async function encode(source: HTMLCanvasElement): Promise<string | null> {
  const sw = source.width, sh = source.height
  if (!sw || !sh) return null
  // The middle 70% of the frame: framed subjects sit in the centre and read better at tile size.
  const aspect = THUMB_WIDTH / THUMB_HEIGHT
  let cw = Math.round(sw * CROP), ch = Math.round(cw / aspect)
  if (ch > sh * CROP) {
    ch = Math.round(sh * CROP)
    cw = Math.round(ch * aspect)
  }
  const sx = Math.round((sw - cw) / 2), sy = Math.round((sh - ch) / 2)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(source, sx, sy, cw, ch, { resizeWidth: THUMB_WIDTH, resizeHeight: THUMB_HEIGHT, resizeQuality: "medium" })
  } catch {
    return null
  }
  const out = document.createElement("canvas")
  out.width = THUMB_WIDTH
  out.height = THUMB_HEIGHT
  const ctx = out.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const px = ctx.getImageData(0, 0, out.width, out.height).data
  let lit = 0
  for (let i = 0; i < px.length; i += 64) if (px[i]! + px[i + 1]! + px[i + 2]! > 24) lit++
  if (lit < px.length / 64 / 50) return null
  return out.toDataURL("image/webp", 0.82)
}
