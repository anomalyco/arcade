export type PaletteKind = "object" | "library" | "command" | "setting"

export type PaletteItem = {
  id: string
  kind: PaletteKind
  label: string
  /** Secondary text: group, section, category. Matched with lower weight. */
  meta?: string
  hint?: string
  disabled?: boolean
  run(): void
}

export const PALETTE_KINDS: readonly { kind: PaletteKind; label: string; prefix: string }[] = [
  { kind: "object", label: "In scene", prefix: "@" },
  { kind: "setting", label: "Settings", prefix: "#" },
  { kind: "library", label: "Library", prefix: "+" },
  { kind: "command", label: "Commands", prefix: ">" },
]

/** Subsequence score (lower is better), favouring word starts and contiguous runs. Null when no match. */
export function fuzzyScore(text: string, query: string): number | null {
  const hay = text.toLowerCase()
  const needle = query.toLowerCase().replace(/\s+/g, " ").trim()
  if (!needle) return 0
  const direct = hay.indexOf(needle)
  if (direct >= 0) return direct === 0 || /[\s·:/(-]/.test(hay[direct - 1]!) ? -100 + direct * 0.01 : -50 + direct * 0.01
  let score = 0
  let at = -1
  for (const ch of needle.replace(/\s/g, "")) {
    const next = hay.indexOf(ch, at + 1)
    if (next < 0) return null
    const gap = next - at - 1
    const wordStart = next === 0 || /[\s·:/(-]/.test(hay[next - 1]!)
    score += wordStart ? gap * 0.25 : gap
    at = next
  }
  return score
}

/** Parse an optional kind prefix (`@` scene, `#` settings, `+` library, `>` commands). */
export function parsePaletteQuery(raw: string): { kind: PaletteKind | null; text: string } {
  const t = raw.trimStart()
  const hit = PALETTE_KINDS.find(k => t.startsWith(k.prefix))
  return hit ? { kind: hit.kind, text: t.slice(hit.prefix.length).trim() } : { kind: null, text: t.trim() }
}

/** Rank items into kind sections. Empty queries list scene objects and commands first. */
export function rankPalette(items: readonly PaletteItem[], raw: string, perKind = 8): PaletteItem[] {
  const { kind, text } = parsePaletteQuery(raw)
  const order: PaletteKind[] = text ? ["object", "setting", "library", "command"] : ["object", "command", "library", "setting"]
  const out: PaletteItem[] = []
  for (const k of order) {
    if (kind && k !== kind) continue
    const scored: { item: PaletteItem; score: number }[] = []
    for (const item of items) {
      if (item.kind !== k) continue
      const primary = fuzzyScore(item.label, text)
      const secondary = item.meta ? fuzzyScore(`${item.label} ${item.meta}`, text) : null
      const score = primary !== null ? primary : secondary !== null ? secondary + 40 : null
      if (score === null) continue
      scored.push({ item, score: score + (item.disabled ? 25 : 0) })
    }
    scored.sort((a, b) => a.score - b.score)
    const limit = kind ? 40 : text ? perKind : k === "object" ? 6 : 5
    out.push(...scored.slice(0, limit).map(s => s.item))
  }
  return out
}

export type Palette = ReturnType<typeof createPalette>

export function createPalette(root: HTMLElement, deps: { items(): PaletteItem[]; onOpenChange(open: boolean): void }) {
  const back = document.createElement("div")
  back.className = "lab-palette-backdrop"
  back.dataset.labPalette = ""
  back.hidden = true
  back.innerHTML = `
    <div class="lab-palette" role="dialog" aria-label="Search everything">
      <label class="lab-palette-row">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        <input type="text" class="lab-palette-input" role="combobox" aria-expanded="true" aria-controls="lab-palette-list" aria-autocomplete="list" aria-label="Search scene, library, commands and settings" placeholder="Search scene objects, library, commands, settings…" spellcheck="false" />
        <kbd>esc</kbd>
      </label>
      <div class="lab-palette-tokens"></div>
      <div class="lab-palette-list" id="lab-palette-list" role="listbox"></div>
      <div class="lab-palette-foot"><span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> run</span><span><kbd>@</kbd> scene <kbd>#</kbd> settings <kbd>+</kbd> library <kbd>&gt;</kbd> commands</span></div>
    </div>
  `
  root.append(back)
  const input = back.querySelector<HTMLInputElement>(".lab-palette-input")!
  const list = back.querySelector<HTMLElement>(".lab-palette-list")!
  const tokens = back.querySelector<HTMLElement>(".lab-palette-tokens")!
  let results: PaletteItem[] = []
  let index = 0
  let returnFocus: HTMLElement | null = null

  for (const k of PALETTE_KINDS) {
    const b = document.createElement("button")
    b.type = "button"
    b.className = "lab-palette-token"
    b.dataset.kind = k.kind
    b.innerHTML = `<kbd></kbd><span></span>`
    b.querySelector("kbd")!.textContent = k.prefix
    b.querySelector("span")!.textContent = k.label
    b.onclick = () => {
      const { kind, text } = parsePaletteQuery(input.value)
      input.value = kind === k.kind ? text : `${k.prefix}${text}`
      update()
      input.focus()
    }
    tokens.append(b)
  }

  function update() {
    results = rankPalette(deps.items(), input.value)
    index = Math.max(0, Math.min(index, results.length - 1))
    const { kind } = parsePaletteQuery(input.value)
    for (const b of tokens.querySelectorAll<HTMLElement>("[data-kind]")) b.setAttribute("aria-pressed", String(b.dataset.kind === kind))
    list.replaceChildren()
    if (!results.length) {
      const empty = document.createElement("div")
      empty.className = "lab-palette-empty"
      empty.textContent = "No matches"
      list.append(empty)
      input.removeAttribute("aria-activedescendant")
      return
    }
    let last: PaletteKind | null = null
    results.forEach((item, i) => {
      if (item.kind !== last) {
        last = item.kind
        const h = document.createElement("div")
        h.className = "lab-palette-sec"
        h.textContent = PALETTE_KINDS.find(k => k.kind === item.kind)!.label
        list.append(h)
      }
      const row = document.createElement("button")
      row.type = "button"
      row.id = `lab-pal-${i}`
      row.className = "lab-palette-item"
      row.dataset.kind = item.kind
      row.dataset.paletteId = item.id
      row.setAttribute("role", "option")
      row.setAttribute("aria-selected", String(i === index))
      row.setAttribute("aria-disabled", String(Boolean(item.disabled)))
      const name = document.createElement("span")
      name.className = "lab-palette-name"
      name.textContent = item.label
      const meta = document.createElement("span")
      meta.className = "lab-palette-meta"
      meta.textContent = item.meta ?? ""
      row.append(name, meta)
      if (item.hint) {
        const k = document.createElement("kbd")
        k.textContent = item.hint
        row.append(k)
      }
      row.onpointermove = () => {
        if (index !== i) {
          index = i
          for (const el of list.querySelectorAll(".lab-palette-item")) el.setAttribute("aria-selected", String(el === row))
        }
      }
      row.onclick = () => choose(i)
      list.append(row)
    })
    input.setAttribute("aria-activedescendant", `lab-pal-${index}`)
    list.querySelector(`#lab-pal-${index}`)?.scrollIntoView({ block: "nearest" })
  }

  function choose(i: number) {
    const item = results[i]
    if (!item) return
    close(false)
    item.run()
  }

  function open(query = "") {
    if (!back.hidden) {
      input.focus()
      return
    }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    back.hidden = false
    input.value = query
    index = 0
    update()
    input.focus()
    input.select()
    deps.onOpenChange(true)
  }

  function close(restoreFocus = true) {
    if (back.hidden) return
    back.hidden = true
    deps.onOpenChange(false)
    if (restoreFocus) returnFocus?.focus({ preventScroll: true })
  }

  input.addEventListener("input", () => {
    index = 0
    update()
  })
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const n = results.length
      index = n ? (index + (event.key === "ArrowDown" ? 1 : -1) + n) % n : 0
      update()
    } else if (event.key === "Enter") {
      event.preventDefault()
      choose(index)
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === "Tab") {
      event.preventDefault()
    }
  })
  back.addEventListener("pointerdown", event => {
    if (event.target === back) close()
  })

  return {
    el: back,
    input,
    open,
    close,
    get isOpen() {
      return !back.hidden
    },
    get results(): readonly PaletteItem[] {
      return results
    },
  }
}
