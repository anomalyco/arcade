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
