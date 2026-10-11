/** Tiny DOM helpers that skip writes when nothing changed, so per-frame HUD updates stay cheap. */

const textCache = new WeakMap<Node, string>()
const styleCache = new WeakMap<HTMLElement | SVGElement, Map<string, string>>()

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (html !== undefined) el.innerHTML = html
  parent?.appendChild(el)
  return el
}

export function text(el: HTMLElement | SVGElement, s: string) {
  if (textCache.get(el) === s) return
  textCache.set(el, s)
  el.textContent = s
}

export function style(el: HTMLElement | SVGElement, prop: string, v: string) {
  let m = styleCache.get(el)
  if (!m) styleCache.set(el, (m = new Map()))
  if (m.get(prop) === v) return
  m.set(prop, v)
  el.style.setProperty(prop, v)
}

export function show(el: HTMLElement | SVGElement, on: boolean) {
  if (el.classList.contains("off") === !on) return
  el.classList.toggle("off", !on)
}

export function flag(el: Element, cls: string, on: boolean) {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on)
}

export function attr(el: Element, name: string, v: string) {
  if (el.getAttribute(name) !== v) el.setAttribute(name, v)
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`

export function clock(sec: number) {
  const s = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

export function shortClock(sec: number) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function distance(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m / 10) * 10}m`
}

export const STAR = `<svg viewBox="0 0 24 24"><path d="M12 2.6l2.8 6.1 6.6.7-5 4.5 1.4 6.6L12 17.2l-5.8 3.3 1.4-6.6-5-4.5 6.6-.7z"/></svg>`
