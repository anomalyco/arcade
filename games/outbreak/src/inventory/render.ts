import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { refAttr, type CaseItem, type InvCell, type InvMate, type InvModel } from "./model"
import { PORTRAITS } from "../portraits"

/**
 * The Attaché Case (AR-94, D-46) as markup from one model: quick slots on the lid, the case on grid paper with every
 * item at its shape, what you face as a crate beside it, teammates in reach. Every item and area is a `[data-ref]` the
 * bag's pointer handling reads. Items are painted portraits (`src/portraits/`, `scripts/item-portraits.ts`; a test
 * keeps every item covered), with the item's name only for one that has none yet.
 */

export type RenderState = {
  /** Things that arrived since the case was last open: they glow until hovered. */
  fresh: ReadonlySet<string>
  /** Things waiting for the room to answer a move. */
  pending: ReadonlySet<string>
  /** The case's size before a bigger bag or a pouch grew it: the new cells unfold in. */
  grown: { cols: number; rows: number } | null
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The item's painted portrait at its shape (`w`×`h` cells as it lies), turned a quarter when `turned`. */
export function artHtml(item: string, w: number, h: number, turned = false): string {
  const url = PORTRAITS[item]
  const style = `--fw:${w};--fh:${h}`
  if (!url) return `<span class="inv-art-box" style="${style}"><span class="inv-noart">${esc(item)}</span></span>`
  return `<span class="inv-art-box" style="${style}" data-turned="${turned}"><img class="inv-art" src="${url}" alt="" draggable="false" decoding="async"></span>`
}

/** The portrait contained in a box of any shape (quick slots, the dock). */
export function artFitHtml(item: string): string {
  const url = PORTRAITS[item]
  if (!url) return `<span class="inv-noart">${esc(item)}</span>`
  return `<img class="inv-art-fit" src="${url}" alt="" draggable="false" decoding="async">`
}

function chargeHtml(c: InvCell): string {
  const ch = c.charge
  if (!ch) return ""
  const f = Math.max(0, Math.min(1, ch.value / Math.max(1, ch.max)))
  // Rounds read as a number on the gun itself: "6/8". Wear and fuel read as a bar.
  if (ch.kind === "rounds") return `<span class="inv-rounds" data-empty="${ch.value === 0}">${ch.value}<small>/${ch.max}</small></span>`
  return `<span class="inv-bar" data-low="${f < 0.3}"><i style="--f:${f.toFixed(3)}"></i></span>`
}

function countHtml(c: InvCell): string {
  const n = c.stack?.count ?? 0
  return n > 1 ? `<span class="inv-count">${n}</span>` : ""
}

function attrs(c: InvCell, st: RenderState, extra: string[] = []): string {
  const ref = refAttr(c.ref)
  return [
    `data-ref="${ref}"`,
    `data-at="${c.ref.at}"`,
    c.stack ? `data-item="${c.stack.item}" data-tag="${c.def?.tag ?? ""}"` : `data-empty="true"`,
    c.selected ? `data-selected="true"` : "",
    c.blocked ? `data-blocked="${c.blocked}"` : "",
    st.fresh.has(ref) ? `data-fresh="true"` : "",
    st.pending.has(ref) ? `data-pending="true"` : "",
    c.stack ? `aria-label="${esc(c.label)}"` : "",
    ...extra,
  ]
    .filter(Boolean)
    .join(" ")
}

/** A quick slot on the lid: the portrait fitted into it, its key cap, its count or charge. */
function quickHtml(c: InvCell, index: number, st: RenderState): string {
  const art = c.stack ? artFitHtml(c.stack.item) : ""
  return `<div class="inv-quick" ${attrs(c, st)}>${art}${countHtml(c)}${chargeHtml(c)}<span class="inv-key">${keyCapHtml(`Digit${index + 1}`)}</span></div>`
}

/** An item lying on a grid at (`x`, `y`), `w`×`h` cells as it lies. */
function placedHtml(c: InvCell, st: RenderState, x: number, y: number, w: number, h: number, turned: boolean): string {
  const item = c.stack!.item
  const style = `--x:${x};--y:${y};--w:${w};--h:${h}`
  return `<div class="inv-item" ${attrs(c, st, [`style="${style}"`, turned ? `data-turned="true"` : ""])}>${artHtml(item, turned ? h : w, turned ? w : h, turned)}${countHtml(c)}${chargeHtml(c)}</div>`
}

function gridCellsHtml(cols: number, rows: number, grown: RenderState["grown"]): string {
  let out = ""
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const fresh = grown && (x >= grown.cols || y >= grown.rows)
      // New cells unfold from the old edge outward.
      const d = fresh ? Math.max(x - grown!.cols + 1, y - grown!.rows + 1, 0) * 45 + (x + y) * 12 : 0
      out += `<i class="inv-g" data-cell="${y * cols + x}"${fresh ? ` data-new="true" style="--d:${d}ms"` : ""}></i>`
    }
  return out
}

/** Lays footprints into a grid `cols` wide, biggest first, top-left first (the crate: what you face, for show). */
export function packShapes(items: readonly { id: string; w: number; h: number }[], cols: number): { id: string; x: number; y: number; w: number; h: number; rot: boolean }[] {
  const out: { id: string; x: number; y: number; w: number; h: number; rot: boolean }[] = []
  const filled: boolean[][] = []
  const free = (x: number, y: number, w: number, h: number) => {
    if (x + w > cols) return false
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (filled[yy]?.[xx]) return false
    return true
  }
  const fill = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) (filled[yy] ??= [])[xx] = true
  }
  const order = [...items].sort((a, b) => b.w * b.h - a.w * a.h || b.w - a.w)
  for (const it of order) {
    const rot = it.w > cols
    const w = rot ? it.h : it.w
    const h = rot ? it.w : it.h
    let placed = false
    for (let y = 0; !placed && y < 64; y++)
      for (let x = 0; !placed && x + w <= cols; x++)
        if (free(x, y, w, h)) {
          fill(x, y, w, h)
          out.push({ id: it.id, x, y, w, h, rot })
          placed = true
        }
  }
  return out
}

export const CRATE_COLS = 5

function crateHtml(m: InvModel, st: RenderState, shape: (item: string) => { w: number; h: number }): string {
  const t = m.target
  if (!t) return ""
  const cells = t.cells.filter((c) => c.stack)
  const shapes = packShapes(
    cells.map((c) => ({ id: refAttr(c.ref), ...shape(c.stack!.item) })),
    CRATE_COLS,
  )
  const rows = Math.max(2, ...shapes.map((s) => s.y + s.h))
  const byRef = new Map(cells.map((c) => [refAttr(c.ref), c]))
  const items = shapes.map((s) => placedHtml(byRef.get(s.id)!, st, s.x, s.y, s.w, s.h, s.rot)).join("")
  return `<div class="inv-crate" data-ref="target:-1" data-kind="${t.kind}">
    <div class="inv-head"><span>${esc(t.title)}</span></div>
    <div class="inv-paper inv-crate-paper" style="--cols:${CRATE_COLS};--rows:${rows}">${gridCellsHtml(CRATE_COLS, rows, null)}${items || `<span class="inv-none">Empty</span>`}</div>
  </div>`
}

function matesHtml(mates: readonly InvMate[]): string {
  if (!mates.length) return ""
  const chips = mates
    .map((m) => {
      const initial = esc((m.name.trim()[0] ?? "?").toUpperCase())
      return `<div class="inv-mate" data-ref="mate:${m.index}" style="--c:${m.colour}"><b>${initial}</b><span>${esc(m.name)}</span></div>`
    })
    .join("")
  return `<div class="inv-mates">${chips}</div>`
}

/** The whole case: the lid's quick slots, the case on grid paper, the crate and teammates beside it, the key hints. */
export function caseHtml(m: InvModel, st: RenderState, shape: (item: string) => { w: number; h: number }): string {
  const c = m.case
  const quick = m.hands.map((h, i) => quickHtml(h, i, st)).join("")
  const items = c.items.map((it: CaseItem) => placedHtml(it, st, it.x, it.y, it.w, it.h, it.r)).join("")
  const pouches = c.pouches ? ` <small>+${c.pouches} pouch${c.pouches > 1 ? "es" : ""}</small>` : ""
  const grownNote = st.grown ? `<span class="inv-grew">${c.cols}×${c.rows}</span>` : ""
  const hints = [
    `${keyCapHtml("KeyR")}<span>Turn</span>`,
    `${keyCapHtml("KeyG")}<span>Drop</span>`,
    `${keyCapHtml("ShiftLeft")}<span>Half</span>`,
    `${keyCapHtml("Tab")}<span>Close</span>`,
  ]
    .map((h) => `<span class="inv-hint">${h}</span>`)
    .join("")
  return `<div class="inv-case-wrap">
    <div class="inv-case" style="--cols:${c.cols};--rows:${c.rows}">
      <div class="inv-lid" data-ref="hotbar:-1">${quick}</div>
      <div class="inv-head"><span class="inv-bag">${esc(c.bag)}${pouches}</span>${grownNote}<span class="inv-used">${c.used}<small>/${c.cols * c.rows}</small></span></div>
      <div class="inv-paper inv-case-paper" data-ref="case:-1" style="--cols:${c.cols};--rows:${c.rows}"${st.grown ? ` data-grown="true"` : ""}>${gridCellsHtml(c.cols, c.rows, st.grown)}${items}</div>
      <div class="inv-hints">${hints}</div>
    </div>
    <div class="inv-side">${crateHtml(m, st, shape)}${matesHtml(m.mates)}</div>
  </div>`
}
