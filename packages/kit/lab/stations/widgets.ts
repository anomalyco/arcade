import type { LabPanel } from "../../lab-panel"
import type { PlacedWidget } from "./layout"
import { STATUS_LABEL, type LabStation, type StationVariant, type StationWidgetKind } from "./types"

export type StationChange = { sha: string; subject: string; when: string }
export type StationBranch = { name: string; ahead: number; subject: string; when: string }
export type StationChanges = { commits: StationChange[]; branches: StationBranch[] }

/** What a widget can read and do: the open station and the Lab around it. */
export type WidgetContext = {
  station: LabStation
  /** The section the demo runs, or null for page demos and sections not in this build. */
  section: string | null
  missing: string | null
  panel: LabPanel
  /** For page demos: resolves to the embedded page's LabPanel once loaded. */
  pagePanel?: () => Promise<LabPanel | null>
  variant(): StationVariant | null
  chooseVariant(variant: StationVariant): void
  invoke(command: string, args?: Record<string, unknown>): { ok: true } | { ok: false; error: string }
  say(text: string, error?: boolean): void
  /** GPU time, frames per second and the section's first telemetry line. */
  live(): string
  changes: (() => Promise<StationChanges | null>) | null
  storage: Storage | null
  /** The A/B wipe is waiting for a variant to be B. */
  abPending: { get(): boolean; set(on: boolean): void }
  /** The key chip before a variant's number: "⇧" while number keys open stations, "" once they pick variants. */
  variantKey?: string
}

export type WidgetInstance = {
  /** Live widgets refresh twice a second while their station is open. */
  tick?(): void
  /** The station changed variant or state outside the widget. */
  refresh?(): void
  dispose?(): void
}

type Renderer = (body: HTMLElement, widget: PlacedWidget, ctx: WidgetContext) => WidgetInstance

const html = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

function button(label: string, onClick: () => void, cls = "ls-btn") {
  const b = document.createElement("button")
  b.type = "button"
  b.className = cls
  b.innerHTML = label
  b.addEventListener("click", onClick)
  return b
}

export const WIDGET_TITLES: Record<StationWidgetKind, string> = {
  status: "Status",
  controls: "Controls",
  variants: "Variants",
  compare: "Compare",
  perf: "Live",
  metrics: "Measured",
  changes: "Recent changes",
  notes: "Notes",
  links: "Links",
}

export const WIDGET_HINTS: Record<StationWidgetKind, string> = {
  status: "What the station is, its status and board feature",
  controls: "Knobs cards for chosen Details groups",
  variants: "The station's variants (⇧1–⇧9)",
  compare: "A/B wipe and the variation grid",
  perf: "GPU time, frame rate and the section's telemetry",
  metrics: "Measured numbers with where they came from",
  changes: "Recent commits and unmerged branches (dev server)",
  notes: "Your notes for this station, kept in this browser",
  links: "Where the thing lives in the games",
}

const renderers: Record<StationWidgetKind, Renderer> = {
  status(body, _w, ctx) {
    const s = ctx.station
    const feature = s.board ? `<a class="ls-tag" href="https://opencode-team-board.anomalyco.workers.dev/?open=${html(s.board.feature)}&project=arcade" target="_blank" rel="noreferrer">${html(s.board.feature)} ↗</a>` : ""
    const missing = s.demo.kind === "section" && ctx.missing
      ? `<p class="ls-missing">The <code>${html(ctx.missing)}</code> section isn't in this build yet. The station runs it once that branch merges.</p>`
      : ""
    // Where it lives in the games, as buttons (Play Outbreak): the one thing to do from here besides tuning.
    const links = s.links?.length ? `<div class="ls-actions">${s.links.map(l => `<a class="ls-btn" href="${html(l.href)}" target="_blank" rel="noreferrer">${html(l.label)} ↗</a>`).join("")}</div>` : ""
    body.innerHTML = `<div class="ls-status-line"><span class="ls-status" data-status="${s.status}">${STATUS_LABEL[s.status]}</span>${s.statusNote ? `<span class="ls-dim">${html(s.statusNote)}</span>` : ""}${feature}</div><p class="ls-summary" title="${html(s.summary)}">${html(s.summary)}</p>${missing}${links}`
    return {}
  },

  controls(body, w, ctx) {
    const groups = new Set(w.groups ?? [])
    const keys = new Set(w.keys ?? [])
    if (!groups.size && !keys.size) {
      body.innerHTML = `<p class="ls-dim">${ctx.section || ctx.pagePanel ? "Pick Details groups for this card (✎ then Configure)." : "This station has no Lab section to tune."}</p>`
      return {}
    }
    if (!ctx.section && ctx.pagePanel) {
      body.innerHTML = `<p class="ls-dim">Loading page controls…</p>`
      let disposed = false
      let mounted: ReturnType<LabPanel["mountView"]> | null = null
      void ctx.pagePanel().then(panel => {
        if (disposed) return
        if (!panel) {
          body.innerHTML = `<p class="ls-dim">This station has no Lab controls to tune.</p>`
          return
        }
        body.replaceChildren()
        mounted = panel.mountView(body, {
          id: `station-${ctx.station.id}-${w.id}`,
          include: row => groups.has(row.group) || Boolean(row.control && keys.has(row.control.key)),
          order: () => [...groups],
          claim: true,
        })
        if (!mounted.keys.length) {
          const note = document.createElement("p")
          note.className = "ls-dim"
          note.textContent = `No settings match ${[...groups, ...keys].join(", ")} in this page.`
          body.append(note)
        }
      })
      return {
        tick: () => mounted?.sync(),
        refresh: () => mounted?.sync(),
        dispose: () => {
          disposed = true
          mounted?.dispose()
        },
      }
    }
    if (!ctx.section) {
      body.innerHTML = `<p class="ls-dim">This station has no Lab section to tune.</p>`
      return {}
    }
    const view = ctx.panel.mountView(body, {
      id: `station-${ctx.station.id}-${w.id}`,
      include: row => groups.has(row.group) || Boolean(row.control && keys.has(row.control.key)),
      order: () => [...groups],
      // Details leaves these rows out while the card shows them, so each setting appears once.
      claim: true,
    })
    if (!view.keys.length) {
      const note = document.createElement("p")
      note.className = "ls-dim"
      note.textContent = `No settings match ${[...groups, ...keys].join(", ")} in this section.`
      body.append(note)
    }
    return { dispose: () => view.dispose() }
  },

  variants(body, _w, ctx) {
    const variants = ctx.station.variants ?? []
    if (!variants.length) { body.innerHTML = `<p class="ls-dim">No variants.</p>`; return {} }
    const list = document.createElement("div")
    list.className = "ls-variants"
    const chips = variants.map((v, i) => {
      const chip = button(`${i < 9 ? `<kbd>${ctx.variantKey ?? "⇧"}${i + 1}</kbd>` : ""}<span>${html(v.label)}</span>`, () => ctx.chooseVariant(v), "ls-chip")
      chip.dataset.variant = v.id
      if (v.note) chip.title = v.note
      list.append(chip)
      return chip
    })
    body.append(list)
    const refresh = () => {
      const current = ctx.variant()?.id
      for (const chip of chips) chip.dataset.active = String(chip.dataset.variant === current)
    }
    refresh()
    return { refresh }
  },

  compare(body, _w, ctx) {
    const row = document.createElement("div")
    row.className = "ls-actions"
    const ab = button("A/B wipe", () => {
      if (ctx.abPending.get()) {
        ctx.abPending.set(false)
        if (!ctx.station.variants?.length) {
          const res = ctx.invoke("compare.wipe")
          if (!res.ok) ctx.say(res.error, true)
        }
        refresh()
        return
      }
      const res = ctx.invoke("compare.pin-a")
      if (!res.ok) return ctx.say(res.error, true)
      ctx.abPending.set(true)
      refresh()
      ctx.say(ctx.station.variants?.length ? "Pinned A. Pick a variant for B." : "Pinned A. Change something, then press A/B wipe again.")
    })
    ab.title = "Pin what you see now as A, then pick a variant (or change settings) for B"
    row.append(ab)
    if (ctx.station.grid) {
      row.append(button("⊞ Grid", () => {
        const res = ctx.invoke("grid.open", { preset: ctx.station.grid })
        if (!res.ok) ctx.say(res.error, true)
        else ctx.say("Grid open: click a tile or press its number, Esc or G to close")
      }))
    }
    const hint = document.createElement("p")
    hint.className = "ls-dim"
    hint.innerHTML = `Hold <kbd>\\</kbd> in a knobs card to see the values before your last change.`
    body.append(row, hint)
    const refresh = () => {
      const pending = ctx.abPending.get()
      ab.textContent = pending ? (ctx.station.variants?.length ? "Pick B…" : "Show wipe") : "A/B wipe"
      ab.dataset.active = String(pending)
    }
    refresh()
    return { refresh }
  },

  perf(body, _w, ctx) {
    const live = document.createElement("div")
    live.className = "ls-live"
    live.textContent = "—"
    body.append(live)
    return { tick: () => { const text = ctx.live(); if (live.textContent !== text) live.textContent = text } }
  },

  metrics(body, _w, ctx) {
    const metrics = ctx.station.metrics ?? []
    body.innerHTML = metrics.length
      ? metrics.map(m => `<div class="ls-metric"${m.source ? ` title="Measured by ${html(m.source)}"` : ""}><b>${html(m.value)}</b><span>${html(m.label)}</span></div>`).join("")
      : `<p class="ls-dim">No measurements recorded in the station file.</p>`
    return {}
  },

  changes(body, _w, ctx) {
    if (!ctx.changes) { body.innerHTML = `<p class="ls-dim">Recent commits show when the Lab runs under <code>bun run dev</code>.</p>`; return {} }
    body.innerHTML = `<p class="ls-dim">Loading…</p>`
    let alive = true
    void ctx.changes().then(c => {
      if (!alive) return
      if (!c || (!c.commits.length && !c.branches.length)) { body.innerHTML = `<p class="ls-dim">Nothing recent.</p>`; return }
      body.innerHTML = [
        ...c.commits.map(x => `<div class="ls-change"><code>${html(x.sha)}</code><span>${html(x.subject)}</span><i>${html(x.when)}</i></div>`),
        ...c.branches.map(b => `<div class="ls-change ls-branch"><code>${html(b.name)}</code><span>+${b.ahead} · ${html(b.subject)}</span><i>${html(b.when)}</i></div>`),
      ].join("")
    }).catch(() => { if (alive) body.innerHTML = `<p class="ls-dim">Couldn't load recent changes.</p>` })
    return { dispose: () => { alive = false } }
  },

  notes(body, w, ctx) {
    const key = `arcade.lab.station-notes.v1:${ctx.station.id}:${w.id}`
    const area = document.createElement("textarea")
    area.className = "ls-notes"
    area.placeholder = "Notes for this station (kept in this browser)"
    area.rows = 3
    area.spellcheck = true
    try { area.value = ctx.storage?.getItem(key) ?? "" } catch { /* no storage */ }
    area.addEventListener("input", () => { try { ctx.storage?.setItem(key, area.value) } catch { /* full */ } })
    body.append(area)
    return {}
  },

  links(body, _w, ctx) {
    const links = ctx.station.links ?? []
    body.innerHTML = links.length
      ? `<div class="ls-links">${links.map(l => `<a href="${html(l.href)}" target="_blank" rel="noreferrer">${html(l.label)} ↗</a>`).join("")}</div>`
      : `<p class="ls-dim">No links in the station file.</p>`
    return {}
  },
}

/** Renders a widget's body into `body`; the card around it belongs to the workspace. */
export function renderWidget(body: HTMLElement, widget: PlacedWidget, ctx: WidgetContext): WidgetInstance {
  return renderers[widget.widget](body, widget, ctx)
}
