import type { LabPanel } from "../lab-panel"
import { findControlRow } from "./commands"
import { renderMarkdownFragment, resolveAccentColors, resolveTourAssetUrl } from "./tours"
import type {
  DevControlAdapter,
  DevNotePayload,
  DevNoteResolvedRect,
  DevNoteTarget,
  TourDefinition,
  TourPageImage,
  TourStepDefinition,
} from "./types"

export const STUDIO_NOTE_STYLE_CSS = `
  :root {
    --arcade-studio-strip-h: 0px;
  }
  html[data-arcade-studio-open="true"]:not([data-arcade-studio-collapsed="true"]) {
    --arcade-studio-strip-h: 30px;
  }
  html[data-arcade-studio-open="true"]:not([data-arcade-studio-collapsed="true"]) .lab-workbench {
    margin-top: 30px !important;
    height: calc(100dvh - 30px) !important;
  }
  html[data-arcade-studio-open="true"]:not([data-arcade-studio-collapsed="true"]) .hub-bar {
    margin-top: 30px !important;
  }
  [data-arcade-note][hidden], [data-arcade-note-ring][hidden], [data-arcade-studio-strip][hidden], [data-arcade-studio-page][hidden], [data-arcade-studio-lightbox][hidden] {
    display: none !important;
  }
  @keyframes arcade-note-pulse {
    0%, 100% { transform: scale(1); opacity: 0.96; }
    50% { transform: scale(1.035); opacity: 0.68; }
  }
  @keyframes arcade-note-card-flash {
    0% { transform: translateX(-50%) scale(1.035); }
    100% { transform: translateX(-50%) scale(1); }
  }
  [data-arcade-note] button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.14) !important;
    color: #fff !important;
  }
  [data-arcade-note] button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  [data-arcade-studio-strip] {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 30px;
    z-index: 10002;
    background: #0c0d0f;
    border-bottom: 1px solid #23252a;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
    font: 11.5px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    color: #d8dbe0;
    user-select: none;
    box-sizing: border-box;
  }
  html[data-arcade-studio-collapsed="true"] [data-arcade-studio-strip] {
    right: auto;
    top: 6px;
    left: 8px;
    height: 24px;
    border-radius: 999px;
    border: 1px solid #2c2f35;
    background: rgba(12, 13, 15, 0.94);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
    padding: 0 6px 0 8px;
  }
  html[data-arcade-studio-collapsed="true"] [data-studio-tabs],
  html[data-arcade-studio-collapsed="true"] [data-studio-kbd] {
    display: none !important;
  }
  [data-studio-brand] {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 11px;
    color: #9fb0bd;
    padding-right: 4px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  [data-studio-counter] {
    font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #7cc5d6;
    background: rgba(124, 197, 214, 0.14);
    padding: 2px 5px;
    border-radius: 3px;
  }
  [data-studio-tabs] {
    display: flex;
    align-items: center;
    gap: 3px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 2px 0;
  }
  [data-studio-tabs]::-webkit-scrollbar {
    display: none;
  }
  [data-studio-step] {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 8px 0 6px;
    border-radius: 4px;
    border: 1px solid #23252a;
    background: #141518;
    color: #8b9098;
    font: 500 11px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.1s ease, color 0.1s ease, border-color 0.1s ease;
  }
  [data-studio-step]:hover {
    background: #1e2024;
    color: #d8dbe0;
    border-color: #2c2f35;
  }
  [data-studio-step][aria-selected="true"] {
    background: rgba(77, 141, 255, 0.16);
    color: #f2f6fa;
    border-color: var(--step-accent, #4d8dff);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--step-accent, #4d8dff) 35%, transparent);
  }
  [data-studio-step-num] {
    font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--step-accent, #7cc5d6);
    opacity: 0.85;
  }
  [data-studio-step][aria-selected="true"] [data-studio-step-num] {
    opacity: 1;
  }
  .arcade-studio-btn {
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 4px;
    border-radius: 4px;
    border: 1px solid #23252a;
    background: #141518;
    color: #9fb0bd;
    font: 600 11px/1 system-ui, -apple-system, sans-serif;
    cursor: pointer;
    flex-shrink: 0;
  }
  .arcade-studio-btn:hover:not(:disabled) {
    background: #1e2024;
    color: #fff;
    border-color: #353942;
  }
  .arcade-studio-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  [data-studio-kbd] {
    font: 500 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #5b6068;
    padding: 0 4px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  [data-arcade-studio-page] {
    position: fixed;
    top: var(--arcade-studio-strip-h, 30px);
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 9500;
    background: #0c0d0f;
    color: #d8dbe0;
    overflow-y: auto;
    padding: 66px 24px 28px;
    font: 12.5px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    box-sizing: border-box;
  }
  [data-studio-page-inner] {
    max-width: 1360px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  [data-studio-image-grid] {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
  @media (max-width: 960px) {
    [data-studio-image-grid] {
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
  }
  .arcade-studio-img-card {
    background: #141518;
    border: 1px solid #23252a;
    border-radius: 7px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    cursor: zoom-in;
    transition: border-color 0.12s ease;
  }
  .arcade-studio-img-card:hover {
    border-color: #4d8dff;
  }
  .arcade-studio-img-card img {
    width: 100%;
    height: 196px;
    object-fit: cover;
    display: block;
    background: #08090b;
  }
  .arcade-studio-img-meta {
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-top: 1px solid #1e2024;
  }
`

export function ensureNoteStyle() {
  if (typeof document === "undefined" || document.querySelector("style[data-arcade-note-style]")) return
  const style = document.createElement("style")
  style.dataset.arcadeNoteStyle = ""
  style.textContent = STUDIO_NOTE_STYLE_CSS
  document.head.append(style)
}

export function isTourPageStep(step: TourStepDefinition | undefined): boolean {
  if (!step) return false
  return step.kind === "page" || Boolean((step.markdown || (step.images && step.images.length > 0)) && step.url.includes("#tour/"))
}

export function resolveNoteTargetRectFromPage(
  target: DevNoteTarget,
  panels: readonly LabPanel[],
  adapter: DevControlAdapter,
  revealSetting = false,
): DevNoteResolvedRect | null {
  if (target.rect) {
    const [rx, ry, rw, rh] = target.rect
    const normalized = rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1 && rw > 0 && rw <= 1 && rh > 0 && rh <= 1
    const vw = window.innerWidth || 1280
    const vh = window.innerHeight || 800
    return {
      x: normalized ? rx * vw : rx,
      y: normalized ? ry * vh : ry,
      width: normalized ? rw * vw : rw,
      height: normalized ? rh * vh : rh,
      shape: "rect",
    }
  }

  if (target.setting) {
    const found = findControlRow(panels, target.setting)
    if (found) {
      const rowEl = found.panel.getControlElement(found.control.key, revealSetting)
      if (rowEl) {
        const r = rowEl.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          return { x: r.left, y: r.top, width: r.width, height: r.height, shape: "rect", label: found.control.label }
        }
      }
    }
  }

  if (adapter.resolveTargetRect) {
    const custom = adapter.resolveTargetRect(target)
    if (custom && custom.width > 0 && custom.height > 0) return custom
  }

  const harness = (globalThis as { __arcadeHarness?: { resolveTargetRect?: (t: DevNoteTarget) => DevNoteResolvedRect | null } }).__arcadeHarness
  if (harness?.resolveTargetRect) {
    const hRect = harness.resolveTargetRect(target)
    if (hRect && hRect.width > 0 && hRect.height > 0) return hRect
  }

  if (target.selector) {
    try {
      const el = document.querySelector<HTMLElement>(target.selector)
      if (el && !el.hidden) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          return { x: r.left, y: r.top, width: r.width, height: r.height, shape: "rect" }
        }
      }
    } catch {}
  }

  if (target.objectId) {
    const q = target.objectId
    const candidates = [
      `[data-object-id="${CSS.escape(q)}"]`,
      `[data-actor-id="${CSS.escape(q)}"]`,
      `[data-catalog-id="${CSS.escape(q)}"]`,
      `[data-game="${CSS.escape(q)}"]`,
      `#${CSS.escape(q)}`,
    ]
    for (const sel of candidates) {
      try {
        const el = document.querySelector<HTMLElement>(sel)
        if (el && !el.hidden) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) {
            return { x: r.left, y: r.top, width: r.width, height: r.height, shape: "rect" }
          }
        }
      } catch {}
    }
  }

  return null
}

export function renderStudioStripDom(opts: {
  tour: TourDefinition | null
  stepNumber: number
  collapsed: boolean
  singleTabAllowed: boolean
  existingStripEl: HTMLElement | null
  onSelectStep: (stepNum: number) => void
  onToggleCollapse: () => void
  onClose: () => void
}): HTMLElement | null {
  if (typeof document === "undefined" || !document.body) return opts.existingStripEl
  ensureNoteStyle()
  const { tour, stepNumber, collapsed, singleTabAllowed } = opts
  if (!tour || tour.singleTab === false || !singleTabAllowed) {
    if (opts.existingStripEl) opts.existingStripEl.hidden = true
    document.documentElement.removeAttribute("data-arcade-studio-open")
    document.documentElement.removeAttribute("data-arcade-studio-collapsed")
    document.documentElement.style.setProperty("--arcade-studio-strip-h", "0px")
    return opts.existingStripEl
  }

  document.documentElement.setAttribute("data-arcade-studio-open", "true")
  if (collapsed) {
    document.documentElement.setAttribute("data-arcade-studio-collapsed", "true")
    document.documentElement.style.setProperty("--arcade-studio-strip-h", "0px")
  } else {
    document.documentElement.removeAttribute("data-arcade-studio-collapsed")
    document.documentElement.style.setProperty("--arcade-studio-strip-h", "30px")
  }

  let strip = opts.existingStripEl
  if (!strip || !document.body.contains(strip)) {
    const nav = document.createElement("nav")
    nav.dataset.arcadeStudioStrip = ""
    nav.setAttribute("aria-label", "Arcade Studio Tour Tabs")
    document.body.prepend(nav)
    strip = nav
  }

  strip.hidden = false
  strip.replaceChildren()

  const brand = document.createElement("span")
  brand.dataset.studioBrand = ""
  const icon = document.createElement("span")
  icon.textContent = "◫"
  icon.style.color = "#4d8dff"
  const tourTitle = document.createElement("span")
  tourTitle.textContent = tour.title || tour.id
  const counter = document.createElement("span")
  counter.dataset.studioCounter = ""
  counter.textContent = `${stepNumber}/${tour.steps.length}`
  brand.append(icon, tourTitle, counter)
  strip.append(brand)

  const prevBtn = document.createElement("button")
  prevBtn.type = "button"
  prevBtn.className = "arcade-studio-btn"
  prevBtn.dataset.studioPrev = ""
  prevBtn.tabIndex = -1
  prevBtn.title = "Previous step (Alt+[)"
  prevBtn.setAttribute("aria-label", "Previous tour step")
  prevBtn.textContent = "‹"
  prevBtn.disabled = tour.steps.length <= 1
  prevBtn.onclick = e => {
    e.stopPropagation()
    const prev = stepNumber > 1 ? stepNumber - 1 : tour.steps.length
    opts.onSelectStep(prev)
  }

  const nextBtn = document.createElement("button")
  nextBtn.type = "button"
  nextBtn.className = "arcade-studio-btn"
  nextBtn.dataset.studioNext = ""
  nextBtn.tabIndex = -1
  nextBtn.title = "Next step (Alt+])"
  nextBtn.setAttribute("aria-label", "Next tour step")
  nextBtn.textContent = "›"
  nextBtn.disabled = tour.steps.length <= 1
  nextBtn.onclick = e => {
    e.stopPropagation()
    const next = stepNumber < tour.steps.length ? stepNumber + 1 : 1
    opts.onSelectStep(next)
  }

  strip.append(prevBtn, nextBtn)

  const tabsWrap = document.createElement("div")
  tabsWrap.dataset.studioTabs = ""
  tabsWrap.setAttribute("role", "tablist")

  tour.steps.forEach((step, idx) => {
    const stepNum = idx + 1
    const isSelected = stepNum === stepNumber
    const colors = resolveAccentColors(step.accent)
    const tab = document.createElement("button")
    tab.type = "button"
    tab.setAttribute("role", "tab")
    tab.dataset.studioStep = String(stepNum)
    tab.dataset.stepKind = isTourPageStep(step) ? "page" : "scene"
    tab.setAttribute("aria-selected", String(isSelected))
    tab.tabIndex = isSelected ? 0 : -1
    tab.title = `${stepNum}. ${step.title}${step.body ? ` — ${step.body}` : ""}`
    tab.style.setProperty("--step-accent", colors.text)

    const numSpan = document.createElement("span")
    numSpan.dataset.studioStepNum = ""
    numSpan.textContent = String(stepNum)

    const labelSpan = document.createElement("span")
    labelSpan.dataset.studioStepTitle = ""
    labelSpan.textContent = step.title

    tab.append(numSpan, labelSpan)
    if (isTourPageStep(step)) {
      const kindBadge = document.createElement("span")
      kindBadge.textContent = "▤"
      kindBadge.style.cssText = "font-size:10px;opacity:0.7;"
      kindBadge.title = "Studio landing page (0 WebGPU cost)"
      tab.append(kindBadge)
    }

    tab.onclick = e => {
      e.stopPropagation()
      tab.blur()
      opts.onSelectStep(stepNum)
    }
    tab.onkeydown = e => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault()
        e.stopPropagation()
        const delta = e.key === "ArrowLeft" ? -1 : 1
        const next = ((stepNum - 1 + delta + tour.steps.length) % tour.steps.length) + 1
        opts.onSelectStep(next)
      }
    }

    tabsWrap.append(tab)
  })

  strip.append(tabsWrap)

  const kbdHint = document.createElement("span")
  kbdHint.dataset.studioKbd = ""
  kbdHint.title = "Switch mini tabs with Alt+[ and Alt+]"
  kbdHint.textContent = "⌥[ ⌥]"
  strip.append(kbdHint)

  const collapseBtn = document.createElement("button")
  collapseBtn.type = "button"
  collapseBtn.className = "arcade-studio-btn"
  collapseBtn.dataset.studioCollapse = ""
  collapseBtn.tabIndex = -1
  collapseBtn.title = collapsed ? "Expand studio tab strip" : "Collapse studio tab strip"
  collapseBtn.setAttribute("aria-label", collapsed ? "Expand studio tab strip" : "Collapse studio tab strip")
  collapseBtn.textContent = collapsed ? "▾" : "▴"
  collapseBtn.onclick = e => {
    e.stopPropagation()
    opts.onToggleCollapse()
  }

  const closeBtn = document.createElement("button")
  closeBtn.type = "button"
  closeBtn.className = "arcade-studio-btn"
  closeBtn.dataset.studioClose = ""
  closeBtn.tabIndex = -1
  closeBtn.title = "Close studio tour strip"
  closeBtn.setAttribute("aria-label", "Close studio tour strip")
  closeBtn.textContent = "×"
  closeBtn.onclick = e => {
    e.stopPropagation()
    opts.onClose()
  }

  strip.append(collapseBtn, closeBtn)
  const activeTab = tabsWrap.querySelector<HTMLElement>('[aria-selected="true"]')
  activeTab?.scrollIntoView({ inline: "center", block: "nearest" })
  return strip
}

export function openStudioLightboxDom(
  images: TourPageImage[],
  tourId: string,
  initialIdx: number,
  existingLightboxEl: HTMLElement | null,
): HTMLElement | null {
  if (!document.body) return existingLightboxEl
  let lb = existingLightboxEl
  if (!lb || !document.body.contains(lb)) {
    lb = document.createElement("div")
    lb.dataset.arcadeStudioLightbox = ""
    lb.style.cssText =
      "position:fixed;inset:0;z-index:10005;background:rgba(6,8,10,0.92);backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;"
    document.body.append(lb)
  }
  let cur = initialIdx
  lb.hidden = false

  const renderLb = () => {
    lb!.replaceChildren()
    const item = images[cur]!
    const src = resolveTourAssetUrl(tourId, item.src)

    const topRow = document.createElement("div")
    topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;width:min(1280px,94vw);margin-bottom:10px;color:#e6eef4;"
    const labelEl = document.createElement("div")
    labelEl.style.cssText = "font:600 14px/1.3 system-ui,-apple-system,sans-serif;"
    labelEl.textContent = `${cur + 1}/${images.length} · ${item.label || item.src}${item.caption ? ` — ${item.caption}` : ""}`

    const btnGroup = document.createElement("div")
    btnGroup.style.cssText = "display:flex;gap:6px;"
    const prev = document.createElement("button")
    prev.type = "button"
    prev.className = "arcade-studio-btn"
    prev.style.cssText = "width:28px;height:26px;"
    prev.textContent = "‹"
    prev.onclick = e => {
      e.stopPropagation()
      cur = (cur - 1 + images.length) % images.length
      renderLb()
    }
    const next = document.createElement("button")
    next.type = "button"
    next.className = "arcade-studio-btn"
    next.style.cssText = "width:28px;height:26px;"
    next.textContent = "›"
    next.onclick = e => {
      e.stopPropagation()
      cur = (cur + 1) % images.length
      renderLb()
    }
    const close = document.createElement("button")
    close.type = "button"
    close.className = "arcade-studio-btn"
    close.style.cssText = "width:28px;height:26px;"
    close.textContent = "×"
    close.onclick = e => {
      e.stopPropagation()
      lb!.hidden = true
    }
    btnGroup.append(prev, next, close)
    topRow.append(labelEl, btnGroup)

    const img = document.createElement("img")
    img.src = src
    img.alt = item.label || item.src
    img.style.cssText = "max-width:94vw;max-height:calc(100dvh - 96px);border-radius:6px;border:1px solid #2c2f35;box-shadow:0 16px 48px rgba(0,0,0,0.65);object-fit:contain;"
    lb!.append(topRow, img)
  }

  lb.onclick = () => {
    lb!.hidden = true
  }
  renderLb()
  return lb
}

export function renderStudioPageDom(
  tour: TourDefinition,
  step: TourStepDefinition,
  existingPageEl: HTMLElement | null,
  onOpenLightbox: (images: TourPageImage[], tourId: string, idx: number) => void,
): HTMLElement | null {
  if (typeof document === "undefined" || !document.body) return existingPageEl
  ensureNoteStyle()
  let pageEl = existingPageEl
  if (!pageEl || !document.body.contains(pageEl)) {
    pageEl = document.createElement("section")
    pageEl.dataset.arcadeStudioPage = ""
    pageEl.setAttribute("aria-label", "Studio Tour Landing Page")
    document.body.append(pageEl)
  }

  pageEl.hidden = false
  pageEl.replaceChildren()

  const inner = document.createElement("div")
  inner.dataset.studioPageInner = ""

  const hiddenMeta = document.createElement("div")
  hiddenMeta.hidden = true
  const h1 = document.createElement("h1")
  h1.dataset.studioPageTitle = ""
  h1.textContent = step.title
  hiddenMeta.append(h1)
  if (step.body) {
    const lead = document.createElement("p")
    lead.dataset.studioPageBody = ""
    lead.textContent = step.body
    hiddenMeta.append(lead)
  }
  inner.append(hiddenMeta)

  if (step.markdown) {
    const mdCard = document.createElement("div")
    mdCard.dataset.studioMarkdown = ""
    mdCard.style.cssText = "background:#141518;border:1px solid #23252a;border-radius:7px;padding:10px 14px;"
    mdCard.append(renderMarkdownFragment(step.markdown))
    inner.append(mdCard)
  }

  if (step.images && step.images.length > 0) {
    const grid = document.createElement("div")
    grid.dataset.studioImageGrid = ""
    step.images.forEach((item, idx) => {
      const card = document.createElement("figure")
      card.className = "arcade-studio-img-card"
      card.style.margin = "0"
      card.dataset.studioImageCard = String(idx + 1)

      const img = document.createElement("img")
      img.dataset.studioImage = String(idx + 1)
      img.dataset.studioLabel = item.label || item.src
      img.src = resolveTourAssetUrl(tour.id, item.src)
      img.alt = item.label || item.src
      img.loading = "eager"

      const meta = document.createElement("figcaption")
      meta.className = "arcade-studio-img-meta"

      const titleRow = document.createElement("div")
      titleRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;"

      const nameSpan = document.createElement("span")
      nameSpan.style.cssText = "font-weight:600;font-size:12.5px;color:#e6eef4;"
      nameSpan.textContent = item.label || item.src
      titleRow.append(nameSpan)

      if (item.tag) {
        const tagSpan = document.createElement("span")
        tagSpan.style.cssText =
          "font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 6px;border-radius:4px;background:rgba(77,141,255,0.16);color:#8ab4ff;text-transform:uppercase;"
        tagSpan.textContent = item.tag
        titleRow.append(tagSpan)
      }
      meta.append(titleRow)

      if (item.caption) {
        const cap = document.createElement("div")
        cap.style.cssText = "font-size:11.5px;color:#8b9098;line-height:1.35;"
        cap.textContent = item.caption
        meta.append(cap)
      }

      card.append(img, meta)
      card.onclick = () => onOpenLightbox(step.images!, tour.id, idx)
      grid.append(card)
    })
    inner.append(grid)
  }

  pageEl.append(inner)
  return pageEl
}

export function renderNoteCardDom(opts: {
  note: DevNotePayload
  existingNoteEl: HTMLElement | null
  stripExpanded: boolean
  onNavigateStep: (direction: "prev" | "next") => void
  onDismiss: () => void
}): HTMLElement {
  ensureNoteStyle()
  const { note, stripExpanded } = opts
  let noteEl = opts.existingNoteEl
  if (!noteEl || !document.body.contains(noteEl)) {
    const el = document.createElement("aside")
    el.dataset.arcadeNote = ""
    el.setAttribute("role", "region")
    el.setAttribute("aria-label", "Show me note")
    document.body.append(el)
    noteEl = el
  }

  const colors = resolveAccentColors(note.accent)
  const studioPageVisible = Boolean(document.querySelector<HTMLElement>("[data-arcade-studio-page]:not([hidden])"))
  const hasTopbar = !studioPageVisible && Boolean(document.querySelector(".lab-topbar, .hub-bar"))
  const stripOffset = stripExpanded ? 30 : 0
  const topPx = (hasTopbar ? 42 : 8) + stripOffset
  noteEl.hidden = false
  noteEl.style.cssText = `position:fixed;top:${topPx}px;left:50%;transform:translateX(-50%);z-index:10000;pointer-events:none;max-width:min(760px,calc(100vw - 28px));background:rgba(11,15,20,0.93);backdrop-filter:blur(10px);color:#f0f5f8;border:1px solid ${colors.border};border-left:3.5px solid ${colors.text};border-radius:9px;padding:7px 12px;box-shadow:0 8px 26px rgba(0,0,0,0.48);font:12.5px/1.35 system-ui,-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;gap:10px;animation:arcade-note-card-flash 0.22s ease-out;`

  noteEl.replaceChildren()

  if (note.step) {
    const stepBadge = document.createElement("span")
    stepBadge.dataset.arcadeNoteStep = ""
    stepBadge.textContent = note.step
    stepBadge.style.cssText = `font:600 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 6px;border-radius:4px;background:${colors.badgeBg};color:${colors.text};white-space:nowrap;flex-shrink:0;`
    noteEl.append(stepBadge)
  }

  const textCol = document.createElement("div")
  textCol.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;"

  const titleEl = document.createElement("div")
  titleEl.dataset.arcadeNoteTitle = ""
  titleEl.textContent = `▸ ${note.title}`
  titleEl.style.cssText = "font-weight:600;font-size:13px;color:#f0f5f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
  textCol.append(titleEl)

  if (note.body) {
    const bodyEl = document.createElement("div")
    bodyEl.dataset.arcadeNoteBody = ""
    bodyEl.textContent = note.body
    bodyEl.style.cssText = "font-size:11.5px;color:#a5b5c2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
    bodyEl.title = note.body
    textCol.append(bodyEl)
  }
  noteEl.append(textCol)

  const hasTourNav = Boolean(note.prevUrl || note.nextUrl || (note.stepCount && note.stepCount > 1))
  if (hasTourNav) {
    const navWrap = document.createElement("div")
    navWrap.style.cssText = "display:flex;align-items:center;gap:4px;pointer-events:auto;flex-shrink:0;"
    const btnCss =
      "pointer-events:auto;font:600 11px/1 system-ui,-apple-system,sans-serif;padding:4px 7px;border-radius:5px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:#d7e2ea;cursor:pointer;"

    const prevBtn = document.createElement("button")
    prevBtn.type = "button"
    prevBtn.dataset.arcadeNotePrev = ""
    prevBtn.tabIndex = -1
    prevBtn.textContent = "‹ Prev"
    prevBtn.disabled = !note.prevUrl && (note.stepIndex === undefined || note.stepIndex <= 1)
    prevBtn.style.cssText = btnCss
    prevBtn.onclick = e => {
      e.stopPropagation()
      prevBtn.blur()
      opts.onNavigateStep("prev")
    }

    const nextBtn = document.createElement("button")
    nextBtn.type = "button"
    nextBtn.dataset.arcadeNoteNext = ""
    nextBtn.tabIndex = -1
    nextBtn.textContent = "Next ›"
    nextBtn.disabled = !note.nextUrl && (note.stepIndex === undefined || note.stepCount === undefined || note.stepIndex >= note.stepCount)
    nextBtn.style.cssText = btnCss
    nextBtn.onclick = e => {
      e.stopPropagation()
      nextBtn.blur()
      opts.onNavigateStep("next")
    }

    navWrap.append(prevBtn, nextBtn)
    noteEl.append(navWrap)
  }

  if (note.dismissible !== false) {
    const closeBtn = document.createElement("button")
    closeBtn.type = "button"
    closeBtn.dataset.arcadeNoteDismiss = ""
    closeBtn.tabIndex = -1
    closeBtn.title = "Dismiss note (Esc)"
    closeBtn.setAttribute("aria-label", "Dismiss note")
    closeBtn.textContent = "×"
    closeBtn.style.cssText =
      "pointer-events:auto;font:600 14px/1 system-ui,-apple-system,sans-serif;width:22px;height:22px;border-radius:5px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:#9fb0bd;cursor:pointer;display:grid;place-items:center;flex-shrink:0;padding:0;"
    closeBtn.onclick = e => {
      e.stopPropagation()
      opts.onDismiss()
    }
    noteEl.append(closeBtn)
  }

  return noteEl
}
