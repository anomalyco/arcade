import css from "./debug-menu.css?inline"

/**
 * One tab of the debug menu. `mount` gets the tab's container each time the tab is shown (open and selected) and
 * `unmount` runs when it is hidden; `frame` runs every frame while it is shown. `css` is added to the menu's shadow
 * root once, so tabs can style their own markup (the shared controls in debug-menu.css are already there).
 */
export type DebugTab = {
  id: string
  label: string
  css?: string
  mount(el: HTMLElement): void
  unmount?(): void
  frame?(dt: number): void
}

const TOGGLE_CODES = new Set(["Backquote", "F2"])
const TOGGLE_KEYS = new Set(["`", "~"])
const isToggle = (e: KeyboardEvent) => TOGGLE_CODES.has(e.code) || TOGGLE_KEYS.has(e.key)
const STOP = ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove", "click", "dblclick", "wheel", "touchstart", "touchmove", "touchend", "keydown", "keyup", "keypress", "contextmenu"]

/**
 * The in-game debug menu: a tabbed panel over the game, toggled with ` (Backquote by position or the `/~ character,
 * so every layout works; F2 as an alias). Closed, it only listens for the toggle. Open, every event on the panel stays
 * in the panel, opening it releases pointer lock (a flying player gets the mouse back) and held gameplay keys, and
 * `wantsInput` tells the game to ignore its own input while the pointer is over the panel or a control has focus.
 * Other modules add tabs with `addTab`.
 */
export class DebugMenu {
  readonly host = document.createElement("aside")
  private root: ShadowRoot
  private panel: HTMLElement
  private nav: HTMLElement
  private body: HTMLElement
  private tabs: { tab: DebugTab; button: HTMLButtonElement; el: HTMLElement; mounted: boolean }[] = []
  private active: string | null = null
  private hover = false

  constructor(private opts: { release?: () => void; open?: boolean; tab?: string } = {}) {
    this.host.dataset.debug = ""
    this.root = this.host.attachShadow({ mode: "open" })
    this.root.innerHTML = `<style>${css}</style>
      <div class="panel" hidden>
        <div class="top"><span class="title">Debug</span><span class="keys">\` to close</span><button class="small" data-close>×</button></div>
        <nav></nav>
        <div class="body"></div>
      </div>`
    this.panel = this.root.querySelector(".panel")!
    this.nav = this.root.querySelector("nav")!
    this.body = this.root.querySelector(".body")!
    this.root.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () => this.close()
    for (const type of STOP)
      this.host.addEventListener(type, (e) => {
        e.stopPropagation()
        if (type === "pointerdown" || type === "mousedown" || type === "touchstart") opts.release?.()
        // Typing in a field never toggles the menu; elsewhere ` closes it even with focus inside.
        if (e instanceof KeyboardEvent && type === "keydown" && !e.repeat && isToggle(e) && !(e.composedPath()[0] instanceof HTMLTextAreaElement)) {
          e.preventDefault()
          this.toggle()
        }
      })
    this.host.addEventListener("pointerenter", () => (this.hover = true))
    this.host.addEventListener("pointerleave", () => (this.hover = false))
    addEventListener("keydown", (e) => {
      if (e.repeat || !isToggle(e)) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      e.preventDefault()
      this.toggle()
    })
    document.body.append(this.host)
    if (opts.open) queueMicrotask(() => this.open(opts.tab))
  }

  get visible(): boolean {
    return !this.panel.hidden
  }

  /** True while the game should ignore its own mouse and keys: the pointer is over the panel or a control has focus. */
  get wantsInput(): boolean {
    return this.visible && (this.hover || this.root.activeElement !== null)
  }

  addTab(tab: DebugTab): void {
    if (this.tabs.some((t) => t.tab.id === tab.id)) this.removeTab(tab.id)
    if (tab.css) {
      const style = document.createElement("style")
      style.dataset.tab = tab.id
      style.textContent = tab.css
      this.root.append(style)
    }
    const button = document.createElement("button")
    button.textContent = tab.label
    button.onclick = () => this.select(tab.id)
    this.nav.append(button)
    const el = document.createElement("div")
    el.dataset.tab = tab.id
    this.tabs.push({ tab, button, el, mounted: false })
    if (!this.active) this.active = tab.id
    if (this.visible) this.show()
  }

  removeTab(id: string): void {
    const i = this.tabs.findIndex((t) => t.tab.id === id)
    if (i < 0) return
    const t = this.tabs[i]!
    this.hide(t)
    t.button.remove()
    this.root.querySelector(`style[data-tab="${CSS.escape(id)}"]`)?.remove()
    this.tabs.splice(i, 1)
    if (this.active === id) this.active = this.tabs[0]?.tab.id ?? null
    if (this.visible) this.show()
  }

  select(id: string): void {
    this.active = id
    if (this.visible) this.show()
  }

  open(tab?: string): void {
    if (tab && this.tabs.some((t) => t.tab.id === tab)) this.active = tab
    this.panel.hidden = false
    // The mouse belongs to the menu now: a flying player's pointer lock ends, held keys release.
    if (document.pointerLockElement) document.exitPointerLock()
    this.opts.release?.()
    this.show()
  }

  close(): void {
    this.panel.hidden = true
    this.hover = false
    for (const t of this.tabs) this.hide(t)
    ;(this.root.activeElement as HTMLElement | null)?.blur()
  }

  toggle(): void {
    if (this.visible) this.close()
    else this.open()
  }

  /** Call every frame: the shown tab's per-frame update. */
  frame(dt: number): void {
    if (!this.visible) return
    this.tabs.find((t) => t.tab.id === this.active && t.mounted)?.tab.frame?.(dt)
  }

  private show(): void {
    for (const t of this.tabs) {
      const on = t.tab.id === this.active
      t.button.classList.toggle("on", on)
      if (!on) this.hide(t)
      else if (!t.mounted) {
        this.body.append(t.el)
        t.tab.mount(t.el)
        t.mounted = true
      }
    }
  }

  private hide(t: (typeof this.tabs)[number]): void {
    if (!t.mounted) return
    t.tab.unmount?.()
    t.el.remove()
    t.mounted = false
  }
}
