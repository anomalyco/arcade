import { LabPanel } from "@arcade/kit/lab-panel"

/**
 * One part of the dev panel: its controls on the shared panel, under one of the panel's
 * tabs. `bind` adds its typed settings and buttons; `shown` runs when its tab comes on screen (open and selected) or
 * leaves it, and `frame` every frame while it is on screen, for readouts that need the panel to catch up.
 */
export type DevSection = {
  /** Old tab id: `open(id)`, `?lab=<id>`. */
  id: string
  /** The panel tab it sits on. */
  tab: string
  bind(panel: LabPanel): void
  shown?(on: boolean): void
  frame?(dt: number): void
}

/**
 * The dev panel: Carrier's tunables and dev commands on the shared floating LabPanel (Backquote), drawn with knobs, one
 * tab per subject. Opening it releases pointer lock (a flying player gets the mouse back) and held gameplay keys; keys
 * stay the game's unless focus is in the panel, and `wantsInput` tells the game to ignore its own input while the
 * pointer is over the panel or it has focus.
 */
export class DevPanel {
  readonly panel: LabPanel
  private sections: { section: DevSection; groups: string[]; first?: string; on: boolean }[] = []
  private hover = false

  constructor(private release: () => void) {
    this.panel = new LabPanel({}, [], new URLSearchParams(), release, {
      open: false,
      pill: false,
      presets: false,
      groupActions: false,
      capture: "focus",
      variants: "carrier-dev",
      onToggle: (visible) => {
        if (visible && document.pointerLockElement) document.exitPointerLock()
        if (!visible) this.hover = false
      },
    })
    this.panel.header.textContent = ""
    this.panel.host.dataset.carrierDev = ""
    this.panel.host.style.width = "380px"
    this.panel.host.addEventListener("pointerenter", () => (this.hover = true))
    this.panel.host.addEventListener("pointerleave", () => (this.hover = false))
  }

  /** Adds sections in order; their tabs follow the order they first appear. */
  add(...sections: DevSection[]): void {
    for (const section of sections) {
      const before = this.panel.navigation.rows.length
      section.bind(this.panel)
      const rows = this.panel.navigation.rows.slice(before)
      const groups = [...new Set(rows.map((r) => r.group))]
      this.sections.push({ section, groups, first: rows.find((r) => r.control)?.control?.key, on: false })
    }
    const tabs = new Map<string, string[]>()
    for (const s of this.sections) tabs.set(s.section.tab, [...(tabs.get(s.section.tab) ?? []), ...s.groups])
    this.panel.setTabs([...tabs].map(([label, groups]) => ({ label, groups })))
  }

  get visible(): boolean {
    return this.panel.visible
  }

  /** True while the game should ignore its own mouse and keys: the pointer is over the panel or it has focus. */
  get wantsInput(): boolean {
    return this.visible && (this.hover || this.panel.hasFocus())
  }

  /** Opens the panel, on a section's tab when given (old tab ids such as "weather", "bots"). */
  open(id?: string): void {
    if (!this.visible) this.panel.toggle()
    if (id) this.select(id)
  }

  close(): void {
    if (this.visible) this.panel.toggle()
  }

  toggle(): void {
    this.panel.toggle()
  }

  /** Shows a section's tab and scrolls to its first row. */
  select(id: string): void {
    const s = this.sections.find((x) => x.section.id === id)
    if (!s) return
    this.panel.setTab(s.section.tab)
    if (this.visible && s.first) this.panel.reveal(s.first, false)
  }

  /** Every frame: sections on the shown tab get `frame`; sections that came on or left screen get `shown`. */
  frame(dt: number): void {
    const tab = this.visible ? this.panel.tab : undefined
    for (const s of this.sections) {
      const on = tab === s.section.tab
      if (on !== s.on) {
        s.on = on
        s.section.shown?.(on)
      }
      if (on) s.section.frame?.(dt)
    }
  }
}

/** Copies text, falling back to the console when the clipboard is blocked; says which. */
export async function copyText(text: string, what: string): Promise<string> {
  console.log(`[carrier dev] ${what}:\n${text}`)
  try {
    await navigator.clipboard.writeText(text)
    return `Copied ${what} (also printed to the console).`
  } catch {
    return `Clipboard blocked: ${what} printed to the console.`
  }
}

/** Reads text from the clipboard, or asks for it when the browser won't hand it over. */
export async function pasteText(what: string): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText()
    if (text.trim()) return text
  } catch {
    // Clipboard read blocked: ask instead.
  }
  return prompt(`Paste ${what}`)
}
