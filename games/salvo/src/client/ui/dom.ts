// Tiny DOM helpers. Every setter caches the last written value so `update()` can run
// every frame without touching the DOM unless something actually changed.

type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, children?: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (children) for (const c of children) if (c) el.append(c)
  return el
}

export const SVG_NS = "http://www.w3.org/2000/svg"

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number>, children?: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  if (attrs) for (const k in attrs) el.setAttribute(k, String(attrs[k]))
  if (children) for (const c of children) if (c) el.append(c)
  return el
}

export function html(markup: string): HTMLElement {
  const t = document.createElement("template")
  t.innerHTML = markup.trim()
  return t.content.firstElementChild as HTMLElement
}

const memo = new WeakMap<Node, Map<string, unknown>>()

function changed(el: Node, key: string, v: unknown): boolean {
  let m = memo.get(el)
  if (!m) memo.set(el, (m = new Map()))
  if (m.get(key) === v) return false
  m.set(key, v)
  return true
}

export function text(el: Node, v: string | number): void {
  const str = String(v)
  if (changed(el, "#text", str)) el.textContent = str
}

export function style(el: HTMLElement | SVGElement, prop: string, v: string): void {
  if (changed(el, "s:" + prop, v)) el.style.setProperty(prop, v)
}

export function attr(el: Element, name: string, v: string | number | null): void {
  if (!changed(el, "a:" + name, v)) return
  if (v === null) el.removeAttribute(name)
  else el.setAttribute(name, String(v))
}

export function cls(el: Element, name: string, on: boolean): void {
  if (changed(el, "c:" + name, on)) el.classList.toggle(name, on)
}

export function show(el: HTMLElement | SVGElement, on: boolean): void {
  if (changed(el, "show", on)) el.style.display = on ? "" : "none"
}

// Keyed list reconciliation: reuses rows by key, creates/removes as needed and only
// reorders children when the key order changes.
export class Keyed<T, R extends { el: HTMLElement }> {
  private rows = new Map<string, R>()
  private order = ""
  constructor(
    private parent: HTMLElement,
    private make: (item: T) => R,
    private patch: (row: R, item: T, index: number) => void,
  ) {}

  sync(items: T[], key: (item: T) => string): void {
    const keys = items.map(key)
    const seen = new Set(keys)
    for (const [k, row] of this.rows) {
      if (!seen.has(k)) {
        row.el.remove()
        this.rows.delete(k)
      }
    }
    items.forEach((item, i) => {
      let row = this.rows.get(keys[i])
      if (!row) {
        row = this.make(item)
        this.rows.set(keys[i], row)
      }
      this.patch(row, item, i)
    })
    const order = keys.join("|")
    if (order !== this.order) {
      this.order = order
      for (const k of keys) this.parent.append(this.rows.get(k)!.el)
    }
  }
}

export function fmtClock(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`
}

export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

export function segBar(n = 10): HTMLElement {
  const el = h("div", "segbar")
  for (let i = 0; i < n; i++) el.append(h("i"))
  return el
}

export function setSegBar(el: HTMLElement, frac: number): void {
  const n = el.children.length
  const on = Math.round(Math.max(0, Math.min(1, frac)) * n)
  if (!changed(el, "seg", on)) return
  for (let i = 0; i < n; i++) el.children[i].classList.toggle("on", i < on)
}
