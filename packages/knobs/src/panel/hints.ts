import { cue } from "./sound.js"

export interface HintCandidate {
  readonly key: string
  readonly display: string
}

export interface HintBadgeState {
  readonly match: boolean
  readonly prefix: string
  readonly typed: string
  readonly rest: string
}

export interface HintResolution {
  readonly badges: readonly HintBadgeState[]
  readonly matchIndices: readonly number[]
  readonly uniqueMatchIndex: number
}

function extractWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+/g) ?? []
}

function candidatePool(words: readonly string[]): string[] {
  const flat = words.join("")
  const pool: string[] = []
  const push = (s: string) => {
    if (s && /^[a-z]{1,3}$/.test(s) && !pool.includes(s)) pool.push(s)
  }
  if (words.length >= 2) {
    const w0 = words[0]!
    const w1 = words[1]!
    const base2 = w0[0]! + w1[0]!
    push(base2)
    for (let i = 1; i < w1.length; i++) push(w0[0]! + w1[i]!)
    for (let i = 1; i < w0.length; i++) push(w0[i]! + w1[0]!)
    if (words.length >= 3) push(base2 + words[2]![0]!)
    if (w1.length >= 2) push(base2 + w1[1]!)
    if (w0.length >= 2) push(base2 + w0[1]!)
  } else if (flat.length > 0) {
    for (let i = 1; i < flat.length; i++) push(flat[0]! + flat[i]!)
    if (flat.length >= 3) push(flat.slice(0, 3))
  }
  const f0 = flat[0] || "x"
  for (let c = 97; c <= 122; c++) {
    push(f0 + String.fromCharCode(c))
  }
  return pool
}

/**
 * Assigns stable, prefix-free 1–2 letter (max 3) lowercase codes (`[a-z]{1,3}`) to `items`.
 * Multi-word labels prefer word initials ("Accent hue" -> "ah", "Accent chroma" -> "ac");
 * single-word labels use 1 letter when unique, else 2-letter combinations ("count" -> "cn", "Copy" -> "cp").
 */
export function assignHintCodes(items: readonly HintCandidate[]): string[] {
  const n = items.length
  if (n === 0) return []

  const displayCounts = new Map<string, number>()
  for (const item of items) {
    const d = item.display.toLowerCase()
    displayCounts.set(d, (displayCounts.get(d) ?? 0) + 1)
  }

  const itemWords = items.map((item) => {
    const d = item.display.toLowerCase()
    const useKey = (displayCounts.get(d) ?? 0) > 1 && d !== item.key.toLowerCase()
    const w = extractWords(useKey ? item.key : item.display)
    return w.length > 0 ? w : extractWords(item.key)
  })

  const pools = itemWords.map((w) => candidatePool(w))
  const base2Of = pools.map((p) => p[0] ?? "x")

  const firstLetterCounts = new Map<string, number>()
  const base2Counts = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const b2 = base2Of[i]!
    const f1 = b2[0]!
    firstLetterCounts.set(f1, (firstLetterCounts.get(f1) ?? 0) + 1)
    base2Counts.set(b2, (base2Counts.get(b2) ?? 0) + 1)
  }

  const codes = new Array<string>(n).fill("")
  const used = new Set<string>()

  // Pass 1: single-word items with a globally unique first letter get a 1-letter code,
  // and items with a unique 2-letter primary get that 2-letter code.
  for (let i = 0; i < n; i++) {
    const words = itemWords[i]!
    const b2 = base2Of[i]!
    const f1 = b2[0]!
    if (words.length === 1 && firstLetterCounts.get(f1) === 1 && !used.has(f1)) {
      codes[i] = f1
      used.add(f1)
    } else if (base2Counts.get(b2) === 1 && !used.has(b2)) {
      codes[i] = b2
      used.add(b2)
    }
  }

  // Pass 2: disambiguate any colliding items using their next unused 2-letter (or 3-letter) candidate.
  for (let i = 0; i < n; i++) {
    if (codes[i]) continue
    const pool = pools[i]!
    const chosen =
      pool.find((cand) => cand.length === 2 && !used.has(cand) && !used.has(cand[0]!)) ??
      pool.find((cand) => !used.has(cand) && !used.has(cand[0]!)) ??
      `x${i}`
    codes[i] = chosen
    used.add(chosen)
  }

  return codes
}

export function computeHintPrefixes(
  items: readonly HintCandidate[],
  rawQuery = "",
): HintResolution {
  return resolveHintCodes(assignHintCodes(items), rawQuery)
}

/** How `codes` read with `rawQuery` typed: which still match, what's typed of each, a sole match. */
export function resolveHintCodes(codes: readonly string[], rawQuery = ""): HintResolution {
  const q = rawQuery.toLowerCase().replace(/[^a-z]/g, "")
  const matchIndices: number[] = []

  const badges: HintBadgeState[] = codes.map((code, i) => {
    const match = q.length === 0 || code.startsWith(q)
    if (match) matchIndices.push(i)
    const typedLen = match ? Math.min(code.length, q.length) : 0
    return {
      match,
      prefix: code,
      typed: code.slice(0, typedLen),
      rest: code.slice(typedLen),
    }
  })

  const uniqueMatchIndex = matchIndices.length === 1 && q.length > 0 ? matchIndices[0]! : -1

  return {
    badges,
    matchIndices,
    uniqueMatchIndex,
  }
}

export interface HintTarget extends HintCandidate {
  readonly el: HTMLElement
  readonly labelEl?: HTMLElement
  activate(): void
}

/** Where a badge goes: just after its label, else at the element's top-left corner. */
export interface HintSpot {
  readonly el: HTMLElement
  readonly labelEl?: HTMLElement
}

export interface HintController {
  readonly isActive: boolean
  /** Hint mode inside this panel alone: its own codes, and it hears the keys (`handleKey`). */
  start(targets: HintTarget[]): void
  /** Draws badges with codes the page's coordinator chose; it hears the keys and calls `narrow`. */
  show(targets: readonly HintSpot[], codes: readonly string[]): void
  narrow(query: string): void
  stop(): void
  handleKey(event: KeyboardEvent): boolean
}

export function createHintController(
  doc: Document,
  root: HTMLElement,
  wakeGpu: () => void,
): HintController {
  const layer = doc.createElement("div")
  layer.className = "knobs-hint-layer"
  layer.setAttribute("aria-hidden", "true")

  let active = false
  /** Started by `start`: this controller hears the keys and activates the match itself. */
  let local = false
  let query = ""
  let spots: readonly HintSpot[] = []
  let targets: HintTarget[] = []
  let codes: readonly string[] = []
  let badgeNodes: {
    tag: HTMLElement
    typedSpan: HTMLElement
    restSpan: HTMLElement
  }[] = []

  function stop() {
    if (!active) return
    active = false
    local = false
    query = ""
    root.classList.remove("knobs-hinting")
    for (const t of spots) t.el.classList.remove("knobs-hint-match", "knobs-hint-miss")
    spots = []
    targets = []
    codes = []
    badgeNodes = []
    layer.replaceChildren()
    layer.remove()
    wakeGpu()
  }

  function paint() {
    if (!active) return
    const resolution = resolveHintCodes(codes, query)
    if (local && resolution.uniqueMatchIndex >= 0) {
      const hit = targets[resolution.uniqueMatchIndex]!
      stop()
      hit.activate()
      return
    }
    for (let i = 0; i < spots.length; i++) {
      const t = spots[i]!
      const b = resolution.badges[i]!
      const node = badgeNodes[i]
      t.el.classList.toggle("knobs-hint-match", b.match)
      t.el.classList.toggle("knobs-hint-miss", !b.match)
      if (!node) continue
      node.tag.hidden = !b.match
      if (b.match) {
        node.typedSpan.textContent = b.typed
        node.restSpan.textContent = b.rest
      }
    }
    wakeGpu()
  }

  function show(nextSpots: readonly HintSpot[], nextCodes: readonly string[]) {
    stop()
    if (nextSpots.length === 0) return
    active = true
    query = ""
    spots = nextSpots
    codes = nextCodes
    root.classList.add("knobs-hinting")
    if (!layer.isConnected) root.append(layer)
    cue(root, "hint")

    const rootRect = root.getBoundingClientRect()
    badgeNodes = spots.map((t) => {
      const tag = doc.createElement("kbd")
      tag.className = "knobs-hint"
      const typedSpan = doc.createElement("span")
      typedSpan.className = "knobs-hint-typed"
      const restSpan = doc.createElement("span")
      restSpan.className = "knobs-hint-rest"
      tag.append(typedSpan, restSpan)

      const rect = t.el.getBoundingClientRect()
      if (t.labelEl) {
        const lRect = t.labelEl.getBoundingClientRect()
        const left = lRect.right - rootRect.left - root.clientLeft + root.scrollLeft + 6
        const top = lRect.top - rootRect.top - root.clientTop + root.scrollTop + lRect.height * 0.5
        tag.style.left = `${Math.round(left)}px`
        tag.style.top = `${Math.round(top)}px`
      } else {
        const left = rect.left - rootRect.left - root.clientLeft + root.scrollLeft + 1
        const top = rect.top - rootRect.top - root.clientTop + root.scrollTop + 1
        tag.style.left = `${Math.round(left)}px`
        tag.style.top = `${Math.round(top)}px`
      }
      layer.append(tag)
      return { tag, typedSpan, restSpan }
    })
    paint()
  }

  function start(nextTargets: HintTarget[]) {
    show(nextTargets, assignHintCodes(nextTargets))
    if (!active) return
    local = true
    targets = nextTargets
  }

  function narrow(next: string) {
    if (next.length > query.length) cue(root, "type")
    query = next
    paint()
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (!active || !local) return false
    event.preventDefault()
    event.stopPropagation()
    if (event.key === "Escape") {
      stop()
    } else if (event.key === "Backspace") {
      query = query.slice(0, -1)
      paint()
    } else if (event.key === "Enter") {
      const resolution = resolveHintCodes(codes, query)
      const first = targets[resolution.matchIndices[0] ?? -1]
      stop()
      first?.activate()
    } else if (/^[a-zA-Z]$/.test(event.key)) {
      cue(root, "type")
      query += event.key.toLowerCase()
      paint()
    }
    return true
  }

  return {
    get isActive() {
      return active
    },
    start,
    show,
    narrow,
    stop,
    handleKey,
  }
}
