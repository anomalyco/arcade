import { keyCapHtml } from "@arcade/kit/client/key-cap"
import { footprint, itemIconSvg } from "./icons"
import { refAttr, type InvCell, type InvMate, type InvModel } from "./model"

/**
 * The three bag layouts (AR-94) as markup from one model. Every slot is a `[data-ref]` the bag's pointer handling reads,
 * so dragging, Shift+click, hover + digit and G work the same in each; only where things sit and how they look differ.
 */

export type RenderState = {
  /** Cells that changed since the bag was last open: they glow until hovered. */
  fresh: ReadonlySet<string>
  /** Cells waiting for the room to answer a move. */
  pending: ReadonlySet<string>
  cell: number
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function chargeHtml(c: InvCell): string {
  const ch = c.charge
  if (!ch) return ""
  const f = Math.max(0, Math.min(1, ch.value / Math.max(1, ch.max)))
  // Rounds read as a number on the gun itself (Dead Space): "6/8". Wear, battery and fuel read as a bar.
  if (ch.kind === "rounds") return `<span class="inv-rounds" data-empty="${ch.value === 0}">${ch.value}<small>/${ch.max}</small></span>`
  return `<span class="inv-bar" data-low="${f < 0.3}"><i style="--f:${f.toFixed(3)}"></i></span>`
}

function countHtml(c: InvCell): string {
  const n = c.stack?.count ?? 0
  return n > 1 || c.ref.at === "belt" ? `<span class="inv-count">${n}</span>` : ""
}

/** One slot. `fit` sizes the icon to the slot ("cell") or to the item's footprint ("shape"). */
export function cellHtml(c: InvCell, st: RenderState, opts: { keyCap?: string; fit?: "cell" | "shape"; rotate?: boolean; extraClass?: string } = {}): string {
  const ref = refAttr(c.ref)
  const fp = c.stack ? footprint(c.stack.item) : { w: 1, h: 1 }
  const rot = Boolean(opts.rotate)
  const w = rot ? fp.h : fp.w
  const h = rot ? fp.w : fp.h
  const attrs = [
    `class="inv-cell${opts.extraClass ? ` ${opts.extraClass}` : ""}"`,
    `data-ref="${ref}"`,
    `data-at="${c.ref.at}"`,
    c.stack ? `data-item="${c.stack.item}" data-tag="${c.def?.tag ?? ""}"` : `data-empty="true"`,
    c.selected ? `data-selected="true"` : "",
    c.blocked ? `data-blocked="${c.blocked}"` : "",
    st.fresh.has(ref) ? `data-fresh="true"` : "",
    st.pending.has(ref) ? `data-pending="true"` : "",
    `style="--w:${w};--h:${h}"`,
    c.stack ? `aria-label="${esc(c.label)}"` : "",
  ]
  const icon = c.stack ? itemIconSvg(c.stack.item, { rotate: rot }) : ""
  const cap = opts.keyCap ? `<span class="inv-key">${keyCapHtml(opts.keyCap)}</span>` : ""
  return `<div ${attrs.filter(Boolean).join(" ")}>${icon}${countHtml(c)}${chargeHtml(c)}${cap}</div>`
}

function matesHtml(mates: readonly InvMate[], where: "edge" | "list"): string {
  if (!mates.length) return ""
  return mates
    .map((m) => {
      const angle = Math.atan2(m.dy, m.dx)
      const initial = esc((m.name.trim()[0] ?? "?").toUpperCase())
      const style = `--c:${m.colour};--a:${angle.toFixed(3)}rad`
      if (where === "list") return `<div class="inv-mate" data-ref="mate:${m.index}" style="${style}"><b>${initial}</b><span>${esc(m.name)}</span></div>`
      return `<div class="inv-mate" data-ref="mate:${m.index}" style="${style}" title="${esc(m.name)}"><b>${initial}</b></div>`
    })
    .join("")
}

/** A: the backpack open on the floor. Hands are loops on the flap, the pack's four pockets, the belt's pouches. */
export function groundHtml(m: InvModel, st: RenderState): string {
  const hands = m.hands.map((c, i) => cellHtml(c, st, { keyCap: `Digit${i + 1}`, fit: "cell" })).join("")
  const pockets = m.pack.map((c) => cellHtml(c, st, { fit: "shape", extraClass: "inv-pocket" })).join("")
  const belt = m.belt.map((c) => cellHtml(c, st, { fit: "cell", extraClass: "inv-pouch" })).join("")
  const found = m.target
    ? `<div class="inv-cloth" data-ref="target:-1" data-kind="${m.target.kind}">${m.target.cells.map((c) => cellHtml(c, st, { fit: "shape" })).join("") || `<span class="inv-none"></span>`}</div>`
    : ""
  return `<div class="inv-mat" data-has-target="${Boolean(m.target)}">
    <div class="inv-light"></div>
    <div class="inv-flap" data-ref="hotbar:-1">${hands}</div>
    <div class="inv-bag" data-ref="pack:-1"><div class="inv-bag-mouth"></div>${pockets}</div>
    <div class="inv-strap">${belt}</div>
    ${found}
    <div class="inv-mates">${matesHtml(m.mates, "edge")}</div>
  </div>`
}

/** Shelf-packs footprints into a grid `cols` wide, long side across, turning anything too long to fit down. */
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

const CASE_COLS = 8
const CRATE_COLS = 5

function gridHtml(cells: readonly InvCell[], st: RenderState, cols: number, minRows: number, area: string, ghosts = 0): string {
  const shapes = packShapes(
    cells.filter((c) => c.stack).map((c) => ({ id: refAttr(c.ref), ...footprint(c.stack!.item) })),
    cols,
  )
  const rows = Math.max(minRows, ...shapes.map((s) => s.y + s.h))
  const byRef = new Map(cells.map((c) => [refAttr(c.ref), c]))
  const items = shapes
    .map((s) => {
      const c = byRef.get(s.id)!
      return `<div class="inv-place" style="grid-column:${s.x + 1} / span ${s.w};grid-row:${s.y + 1} / span ${s.h}">${cellHtml(c, st, { fit: "shape", rotate: s.rot })}</div>`
    })
    .join("")
  const room = Array.from({ length: ghosts }, () => `<div class="inv-room" aria-hidden="true"></div>`).join("")
  return `<div class="inv-grid" data-ref="${area}" style="--cols:${cols};--rows:${rows}">${items}</div>${ghosts ? `<div class="inv-room-row">${room}</div>` : ""}`
}

/** B: the attaché case. Quick slots across the lid, the pack laid out on grid paper, the found crate beside it. */
export function caseHtml(m: InvModel, st: RenderState): string {
  const quick = m.hands.map((c, i) => cellHtml(c, st, { keyCap: `Digit${i + 1}`, fit: "cell" })).join("")
  const free = m.pack.filter((c) => !c.stack).length
  const belt = m.belt.map((c) => cellHtml(c, st, { fit: "cell", extraClass: "inv-loop" })).join("")
  const crate = m.target
    ? `<div class="inv-crate" data-kind="${m.target.kind}"><div class="inv-crate-lid"></div>${gridHtml(m.target.cells, st, CRATE_COLS, 3, "target:-1")}</div>`
    : ""
  return `<div class="inv-case-wrap">
    <div class="inv-case">
      <div class="inv-lid" data-ref="hotbar:-1">${quick}</div>
      <div class="inv-paper">${gridHtml(m.pack, st, CASE_COLS, 3, "pack:-1", free)}</div>
      <div class="inv-loops">${belt}</div>
    </div>
    ${crate}
    <div class="inv-mates">${matesHtml(m.mates, "list")}</div>
  </div>`
}

function rowHtml(c: InvCell, st: RenderState, keyCap?: string): string {
  return `<div class="inv-row" data-row-ref="${refAttr(c.ref)}">${cellHtml(c, st, { keyCap, fit: "cell" })}<span class="inv-row-label">${c.stack ? esc(c.label) : ""}</span></div>`
}

/** C: the survivor sheet. You on the left (hands, pack, belt), what is nearby on the right (what you face, the floor, teammates). */
export function sheetHtml(m: InvModel, st: RenderState): string {
  const hands = m.hands.map((c, i) => cellHtml(c, st, { keyCap: `Digit${i + 1}`, fit: "cell" })).join("")
  const pack = m.pack.map((c) => rowHtml(c, st)).join("")
  const belt = m.belt.map((c) => cellHtml(c, st, { fit: "cell" })).join("")
  const used = m.pack.filter((c) => c.stack).length
  const target = m.target
    ? `<section data-ref="target:-1"><h3>${esc(m.target.title)}</h3>${m.target.cells.map((c) => rowHtml(c, st)).join("") || `<p class="inv-none">Empty</p>`}</section>`
    : ""
  const mates = m.mates.length ? `<section><h3>Hand to</h3>${matesHtml(m.mates, "list")}</section>` : ""
  return `<div class="inv-sheet">
    <div class="inv-col inv-you">
      <section data-ref="hotbar:-1"><h3>Hands</h3><div class="inv-hands">${hands}</div></section>
      <section data-ref="pack:-1"><h3>Pack <span class="inv-weight"><i style="--f:${(used / Math.max(1, m.pack.length)).toFixed(3)}"></i></span></h3>${pack}</section>
      ${belt ? `<section><h3>Belt</h3><div class="inv-belt">${belt}</div></section>` : ""}
    </div>
    <div class="inv-col inv-near">
      ${target}
      <section class="inv-floor-row" data-ref="ground:0"><h3>Floor</h3></section>
      ${mates}
    </div>
  </div>`
}
