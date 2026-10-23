/**
 * The Lab's quick switch: step through a few chosen choices (a game's Looks, camera looks, quality) while you play
 * with the Backquote panel closed, and flip back to the last one to compare by eye. Every floating `LabPanel` has one;
 * a select row joins it with `cycle` (`LabControl.cycle`), anything else with `LabPanel.addCycle`.
 *
 *   ] / [   next / previous preset in the current group
 *   ' / ;   next / previous group
 *   \       back to the preset before (tap swaps; hold to peek, let go to return)
 *
 * Physical keys (`KeyboardEvent.code`), so they sit in the same place on every layout; the toast names them by their
 * QWERTY labels like every prompt. `QuickSwitch` is the plain model; `QuickSwitchToast` is the key-cap toast.
 */
import { installKeyCapStyles, keyCapHtml } from "./client/key-cap"

export const QUICK_SWITCH_KEYS = {
  previous: "BracketLeft",
  next: "BracketRight",
  previousGroup: "Semicolon",
  nextGroup: "Quote",
  back: "Backslash",
} as const
const CODES: ReadonlySet<string> = new Set(Object.values(QUICK_SWITCH_KEYS))
export const isQuickSwitchCode = (code: string): boolean => CODES.has(code)

export type QuickSwitchValue = string | number
export type QuickSwitchOption = { value: QuickSwitchValue; label: string }

/** One group the quick switch steps through: a choice read and written through `get` and `set`. */
export type QuickSwitchTarget = {
  /** Unique among the panel's groups (a row's setting key). */
  key: string
  /** The group's name in the toast ("Look", "Camera"). */
  label: string
  options(): readonly QuickSwitchOption[]
  get(): QuickSwitchValue
  set(value: QuickSwitchValue): void
}

/** What the toast shows. */
export type QuickSwitchView = {
  group: string
  preset: string
  /** Every preset's label, so the toast can keep the width of the longest. */
  presets: readonly string[]
  index: number
  count: number
  /** What `\` goes back to, if anything. */
  back: string | null
  /** The next group's name, when there is more than one. */
  nextGroup: string | null
  groups: readonly string[]
}

const wrap = (i: number, n: number) => ((i % n) + n) % n

export class QuickSwitch {
  private list: QuickSwitchTarget[] = []
  private at = 0
  /** The value each group had when the quick switch last looked: a change made elsewhere (the panel) shows up here. */
  private seen = new Map<string, QuickSwitchValue>()
  /** What `\` goes back to, per group. */
  private backs = new Map<string, QuickSwitchValue>()

  add(target: QuickSwitchTarget): void {
    const i = this.list.findIndex(t => t.key === target.key)
    if (i >= 0) this.list[i] = target
    else this.list.push(target)
    this.seen.set(target.key, target.get())
  }

  remove(key: string): void {
    const i = this.list.findIndex(t => t.key === key)
    if (i < 0) return
    this.list.splice(i, 1)
    this.seen.delete(key)
    this.backs.delete(key)
    if (this.at >= this.list.length) this.at = Math.max(0, this.list.length - 1)
    else if (i < this.at) this.at--
  }

  get size(): number { return this.list.length }
  get keys(): string[] { return this.list.map(t => t.key) }
  get current(): QuickSwitchTarget | undefined { return this.list[this.at] }

  /** Puts these groups first, in this order (the rest keep theirs after them), and starts on the first. */
  order(keys: readonly string[]): void {
    const rank = (t: QuickSwitchTarget) => { const i = keys.indexOf(t.key); return i < 0 ? keys.length : i }
    this.list = this.list.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map(e => e.t)
    this.at = 0
  }

  /** Makes a group current by key; false when there is no such group. */
  select(key: string): boolean {
    const i = this.list.findIndex(t => t.key === key)
    if (i < 0) return false
    this.at = i
    return true
  }

  /** The next (1) or previous (-1) preset in the current group. */
  step(direction: 1 | -1): boolean {
    const t = this.current
    if (!t) return false
    this.observe(t)
    const options = t.options()
    if (!options.length) return false
    const now = t.get()
    const i = options.findIndex(o => o.value === now)
    const next = options[i < 0 ? (direction > 0 ? 0 : options.length - 1) : wrap(i + direction, options.length)]!
    if (next.value === now) return false
    this.backs.set(t.key, now)
    t.set(next.value)
    this.seen.set(t.key, t.get())
    return true
  }

  /** The next (1) or previous (-1) group; values stay as they are. */
  group(direction: 1 | -1): boolean {
    if (this.list.length < 2) return false
    this.at = wrap(this.at + direction, this.list.length)
    return true
  }

  /** Back to the preset before in the current group; doing it again comes forward (A/B). */
  swap(): boolean {
    const t = this.current
    if (!t) return false
    this.observe(t)
    const back = this.backs.get(t.key)
    if (back === undefined || !t.options().some(o => o.value === back)) return false
    const now = t.get()
    t.set(back)
    this.backs.set(t.key, now)
    this.seen.set(t.key, t.get())
    return true
  }

  view(): QuickSwitchView | null {
    const t = this.current
    if (!t) return null
    this.observe(t)
    const options = t.options()
    const now = t.get()
    const index = options.findIndex(o => o.value === now)
    const back = this.backs.get(t.key)
    const label = (v: QuickSwitchValue | undefined) => options.find(o => o.value === v)?.label ?? null
    return {
      group: t.label,
      preset: index >= 0 ? options[index]!.label : String(now),
      presets: options.map(o => o.label),
      index,
      count: options.length,
      back: back === undefined ? null : label(back),
      nextGroup: this.list.length > 1 ? this.list[wrap(this.at + 1, this.list.length)]!.label : null,
      groups: this.list.map(g => g.label),
    }
  }

  private observe(t: QuickSwitchTarget) {
    const now = t.get(), was = this.seen.get(t.key)
    if (was !== undefined && was !== now) this.backs.set(t.key, was)
    this.seen.set(t.key, now)
  }
}

const CSS = `
[data-lab-quickswitch]{position:fixed;z-index:1001;left:50%;top:var(--lab-quickswitch-top,14px);pointer-events:none;color:rgba(255,255,255,.92);font:13px/1.35 system-ui,-apple-system,"SF Pro Text",sans-serif;font-variant-numeric:tabular-nums;--akc-size:1.6em;padding:8px 12px;border-radius:12px;background:rgba(28,28,30,.86);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),inset 0 1px 0 rgba(255,255,255,.09),0 12px 36px rgba(0,0,0,.5);-webkit-backdrop-filter:blur(24px) saturate(1.6);backdrop-filter:blur(24px) saturate(1.6);opacity:0;visibility:hidden;transform:translateX(-50%) scale(.96);transition:opacity 150ms cubic-bezier(.4,0,1,1),transform 150ms cubic-bezier(.4,0,1,1),visibility 0s linear 150ms}
[data-lab-quickswitch][data-shown]{opacity:1;visibility:visible;transform:translateX(-50%);transition:opacity 180ms cubic-bezier(.2,.8,.2,1),transform 180ms cubic-bezier(.2,.8,.2,1),visibility 0s}
[data-lab-quickswitch] .lqs-body{display:grid;gap:6px;filter:blur(3px);transition:filter 150ms cubic-bezier(.4,0,1,1)}
[data-lab-quickswitch][data-shown] .lqs-body{filter:none;transition:filter 180ms cubic-bezier(.2,.8,.2,1)}
[data-lab-quickswitch] .lqs-main,[data-lab-quickswitch] .lqs-hints{display:flex;align-items:center;gap:8px;white-space:nowrap}
[data-lab-quickswitch] .lqs-caps{display:inline-flex;gap:3px}
[data-lab-quickswitch] .lqs-group{color:rgba(255,255,255,.56)}
[data-lab-quickswitch] .lqs-preset{font-weight:600}
[data-lab-quickswitch] .lqs-count{color:rgba(255,255,255,.56);margin-left:auto;padding-left:6px}
[data-lab-quickswitch] .lqs-hints{font-size:11.5px;color:rgba(255,255,255,.56);--akc-size:1.5em;gap:12px}
[data-lab-quickswitch] .lqs-hint{display:inline-flex;align-items:center;gap:6px}
[data-lab-quickswitch] .lqs-stack{display:inline-grid}
[data-lab-quickswitch] .lqs-stack>*{grid-area:1/1}
[data-lab-quickswitch] .lqs-stack>[data-ghost]{visibility:hidden}
@media (prefers-reduced-motion: reduce){
[data-lab-quickswitch],[data-lab-quickswitch][data-shown]{transform:translateX(-50%)}
[data-lab-quickswitch]{transition:opacity 160ms linear,visibility 0s linear 160ms}
[data-lab-quickswitch][data-shown]{transition:opacity 160ms linear,visibility 0s}
[data-lab-quickswitch] .lqs-body,[data-lab-quickswitch][data-shown] .lqs-body{filter:none;transition:none}
}
`

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
/** Every label in one grid cell, only `shown` visible: the slot keeps the longest one's width, so nothing shifts. */
const stack = (labels: readonly string[], shown: string, className = "") =>
  `<span class="lqs-stack ${className}">${[...new Set([shown, ...labels])].map(l => `<span${l === shown ? "" : " data-ghost aria-hidden=\"true\""}>${esc(l)}</span>`).join("")}</span>`

/**
 * The toast: the group, the preset and where it sits ("Look  Ground fog  3/7"), with the keys. It fades in and out
 * (opacity, a 3 px blur on its contents and scale .96, opacity alone with reduced motion) and never pops; a change
 * while it shows is your own key, so the text swaps at once.
 */
export class QuickSwitchToast {
  readonly element: HTMLDivElement
  private timer: ReturnType<typeof setTimeout> | undefined
  private held = false

  constructor(private readonly doc: Document = document, private readonly linger = 1600) {
    installKeyCapStyles(doc)
    if (!doc.querySelector("style[data-lab-quickswitch-css]")) {
      const style = doc.createElement("style")
      style.dataset.labQuickswitchCss = ""
      style.textContent = CSS
      doc.head.append(style)
    }
    this.element = doc.createElement("div")
    this.element.dataset.labQuickswitch = ""
    this.element.setAttribute("role", "status")
    this.element.setAttribute("aria-live", "polite")
    doc.body.append(this.element)
  }

  get shown(): boolean { return this.element.hasAttribute("data-shown") }

  /** Shows `view`, with the cap for `down` drawn pressed; it fades after `linger` ms unless `hold` keeps it. */
  show(view: QuickSwitchView, down?: string, hold = false): void {
    this.held = hold
    const cap = (code: string) => keyCapHtml(code, { down: code === down })
    const back = view.back
      ? `<span class="lqs-hint">${cap(QUICK_SWITCH_KEYS.back)}${stack(view.presets, view.back)}</span>`
      : ""
    const group = view.nextGroup
      ? `<span class="lqs-hint"><span class="lqs-caps">${cap(QUICK_SWITCH_KEYS.previousGroup)}${cap(QUICK_SWITCH_KEYS.nextGroup)}</span>${stack(view.groups, view.nextGroup)}</span>`
      : ""
    this.element.innerHTML = `<div class="lqs-body"><div class="lqs-main"><span class="lqs-caps">${cap(QUICK_SWITCH_KEYS.previous)}${cap(QUICK_SWITCH_KEYS.next)}</span>`
      + `<span class="lqs-group">${esc(view.group)}</span>${stack(view.presets, view.preset, "lqs-preset")}`
      + `<span class="lqs-count">${view.index >= 0 ? view.index + 1 : "–"}/${view.count}</span></div>`
      + (back || group ? `<div class="lqs-hints">${back}${group}</div>` : "") + `</div>`
    this.element.setAttribute("data-shown", "")
    clearTimeout(this.timer)
    if (!hold) this.timer = setTimeout(() => this.hide(), this.linger)
  }

  /** Lets a toast held open (a peek) fade on the usual delay. */
  release(): void {
    if (!this.held) return
    this.held = false
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.hide(), this.linger)
  }

  hide(): void {
    clearTimeout(this.timer)
    this.held = false
    this.element.removeAttribute("data-shown")
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.element.remove()
  }
}
