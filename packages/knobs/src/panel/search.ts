import { iconSvg } from "./icons.js"

export interface SearchChipSpec {
  readonly id: string
  readonly label: string
  readonly count?: boolean
}

/**
 * A panel's search field: a text field that filters rows as you type, and filter chips beside it
 * ("Modified 3") that narrow them further. It's drawn by the DOM in both renderers.
 */
export interface SearchBar {
  readonly element: HTMLElement
  readonly input: HTMLInputElement
  readonly chips: readonly HTMLButtonElement[]
  /** The trimmed query, lower-cased. */
  query(): string
  /** The chips that are on. */
  active(): ReadonlySet<string>
  /** Whether anything narrows the rows (a query or a chip). */
  filtering(): boolean
  /** Shows each counted chip's number. */
  counts(counts: ReadonlyMap<string, number>): void
  /** Empties the query and turns the chips off. */
  clear(): void
  focus(): void
}

export function createSearch(
  doc: Document,
  options: { placeholder: string; chips: readonly SearchChipSpec[]; change(): void },
): SearchBar {
  const element = doc.createElement("div")
  element.className = "knobs-search"
  const field = doc.createElement("label")
  field.className = "knobs-search-field"
  field.append(iconSvg(doc, "search"))
  const input = doc.createElement("input")
  input.type = "search"
  input.placeholder = options.placeholder
  input.spellcheck = false
  input.autocomplete = "off"
  input.setAttribute("aria-label", "Search controls")
  input.setAttribute("aria-keyshortcuts", "/")
  field.append(input)
  element.append(field)
  const on = new Set<string>()
  const chips = options.chips.map((spec) => {
    const b = doc.createElement("button")
    b.type = "button"
    b.className = "knobs-search-chip"
    b.tabIndex = -1
    b.dataset.chip = spec.id
    b.setAttribute("aria-pressed", "false")
    const name = doc.createElement("span")
    name.textContent = spec.label
    b.append(name)
    if (spec.count) {
      const n = doc.createElement("span")
      n.className = "knobs-search-count"
      b.append(n)
    }
    b.onclick = () => {
      if (on.has(spec.id)) on.delete(spec.id)
      else on.add(spec.id)
      b.setAttribute("aria-pressed", String(on.has(spec.id)))
      options.change()
    }
    element.append(b)
    return b
  })
  input.addEventListener("input", () => options.change())
  return {
    element,
    input,
    chips,
    query: () => input.value.trim().toLowerCase(),
    active: () => on,
    filtering: () => input.value.trim() !== "" || on.size > 0,
    counts(counts) {
      for (const b of chips) {
        const n = b.querySelector<HTMLElement>(".knobs-search-count")
        if (!n) continue
        const text = String(counts.get(b.dataset.chip!) ?? 0)
        if (n.textContent !== text) n.textContent = text
        // A chip with nothing to keep sits quiet (but stays, so the bar doesn't shift).
        const none = text === "0" && !on.has(b.dataset.chip!)
        if (b.hasAttribute("data-none") !== none) b.toggleAttribute("data-none", none)
      }
    },
    clear() {
      const had = input.value !== "" || on.size > 0
      input.value = ""
      on.clear()
      for (const b of chips) b.setAttribute("aria-pressed", "false")
      if (had) options.change()
    },
    focus() {
      input.focus({ preventScroll: true })
      input.select()
    },
  }
}

/** Where `query` matches in `text` (case-insensitive), as [start, end), or undefined. */
export function matchSpan(text: string, query: string): [number, number] | undefined {
  if (!query) return undefined
  const at = text.toLowerCase().indexOf(query)
  return at < 0 ? undefined : [at, at + query.length]
}

/** Writes `text` into `label`, with the matched span wrapped in `<mark class="knobs-match">`. */
export function markLabel(label: HTMLElement, text: string, span: [number, number] | undefined) {
  const doc = label.ownerDocument
  const parts: Node[] = []
  if (!span) parts.push(doc.createTextNode(text))
  else {
    if (span[0] > 0) parts.push(doc.createTextNode(text.slice(0, span[0])))
    const mark = doc.createElement("mark")
    mark.className = "knobs-match"
    mark.textContent = text.slice(span[0], span[1])
    parts.push(mark)
    if (span[1] < text.length) parts.push(doc.createTextNode(text.slice(span[1])))
  }
  // Labels can hold more than their text (an accessory): only the text and its mark change.
  const current = [...label.childNodes].filter(
    (c) => c.nodeType === 3 || (c instanceof HTMLElement && c.classList.contains("knobs-match")),
  )
  const same =
    current.length === parts.length &&
    current.every(
      (c, i) => c.nodeName === parts[i]!.nodeName && c.textContent === parts[i]!.textContent,
    )
  if (same) return
  for (const c of current) c.remove()
  label.prepend(...parts)
}
