import type { LabValue } from "../lab-panel"

export type CompareSnapshotLike = {
  sectionId: string
  sections: Record<string, Record<string, LabValue>>
  lighting: Record<string, LabValue>
}

export type CompareParameterDiff = {
  key: string
  before: LabValue
  after: LabValue
  deltaText: string
}

const IGNORED_DIFF_KEYS = new Set(["playing", "loop"])

export function computeSnapshotDiffs(
  snapA: CompareSnapshotLike,
  snapB: CompareSnapshotLike,
): CompareParameterDiff[] {
  const diffs: CompareParameterDiff[] = []
  const secId = snapB.sectionId
  const aSec = snapA.sections[secId] ?? {}
  const bSec = snapB.sections[secId] ?? {}

  for (const key of Object.keys(bSec)) {
    if (IGNORED_DIFF_KEYS.has(key)) continue
    const av = aSec[key]
    const bv = bSec[key]
    if (av === undefined || bv === undefined || av === bv) continue
    if (typeof av === "number" && typeof bv === "number") {
      if (Math.abs(bv - av) < 1e-6) continue
      const d = bv - av
      const sign = d > 0 ? "+" : ""
      diffs.push({
        key,
        before: Number(av.toFixed(3)),
        after: Number(bv.toFixed(3)),
        deltaText: `${sign}${Number(d.toFixed(3))} vs A`,
      })
    } else {
      diffs.push({
        key,
        before: av,
        after: bv,
        deltaText: `${String(av)} → ${String(bv)}`,
      })
    }
  }

  for (const key of Object.keys(snapB.lighting)) {
    const av = snapA.lighting[key]
    const bv = snapB.lighting[key]
    if (av === undefined || bv === undefined || av === bv) continue
    if (typeof av === "number" && typeof bv === "number") {
      if (Math.abs(bv - av) < 1e-6) continue
      const d = bv - av
      const sign = d > 0 ? "+" : ""
      diffs.push({
        key: `lighting.${key}`,
        before: Number(av.toFixed(3)),
        after: Number(bv.toFixed(3)),
        deltaText: `${sign}${Number(d.toFixed(3))} vs A`,
      })
    }
  }

  return diffs
}

export function createCompareWipeDOM(
  viewportEl: HTMLElement,
  onSplitChange: (split: number) => void,
) {
  const wrap = document.createElement("div")
  wrap.className = "lab-wipe-overlay"
  wrap.dataset.compareWipe = ""
  wrap.hidden = true

  // Unmounted offscreen canvas so `page.locator("canvas")` always resolves uniquely to the WebGPU scene canvas.
  const offscreenCanvas = document.createElement("canvas")
  const imageA = document.createElement("img")
  imageA.className = "lab-wipe-canvas"
  imageA.dataset.wipeImage = ""
  imageA.alt = "Baseline Slot A comparison frame"

  const badgeA = document.createElement("div")
  badgeA.className = "lab-wipe-badge lab-wipe-badge-a"
  badgeA.dataset.wipeBadgeA = ""
  badgeA.textContent = "SLOT A (Baseline)"

  const badgeB = document.createElement("div")
  badgeB.className = "lab-wipe-badge lab-wipe-badge-b"
  badgeB.dataset.wipeBadgeB = ""
  badgeB.textContent = "SLOT B (Candidate)"

  const divider = document.createElement("div")
  divider.className = "lab-wipe-divider"
  divider.dataset.wipeDivider = ""
  divider.tabIndex = 0
  divider.setAttribute("role", "separator")
  divider.setAttribute("aria-label", "A/B comparison split divider")
  const handle = document.createElement("span")
  handle.className = "lab-wipe-handle"
  handle.textContent = "◄►"
  divider.append(handle)

  let dragging = false
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragging = true
    try {
      divider.setPointerCapture(event.pointerId)
    } catch {}
  })
  divider.addEventListener("pointermove", event => {
    if (!dragging) return
    event.stopPropagation()
    const rect = viewportEl.getBoundingClientRect()
    const split = Math.max(0.1, Math.min(0.9, (event.clientX - rect.left) / Math.max(1, rect.width)))
    onSplitChange(Number(split.toFixed(3)))
  })
  const stopDrag = () => {
    dragging = false
  }
  divider.addEventListener("pointerup", stopDrag)
  divider.addEventListener("pointercancel", stopDrag)
  divider.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault()
      event.stopPropagation()
      const cur = Number(wrap.dataset.split ?? "0.5")
      const step = event.shiftKey ? 0.1 : 0.05
      const next = Math.max(0.1, Math.min(0.9, cur + (event.key === "ArrowRight" ? step : -step)))
      onSplitChange(Number(next.toFixed(3)))
    }
  })

  wrap.append(imageA, badgeA, badgeB, divider)
  viewportEl.append(wrap)

  function sync(opts: {
    enabled: boolean
    split: number
    frames: number
    diffs: readonly CompareParameterDiff[]
  }) {
    if (!opts.enabled) {
      wrap.hidden = true
      return
    }
    wrap.hidden = false
    wrap.dataset.split = String(opts.split)
    const pct = opts.split * 100
    imageA.style.clipPath = `inset(0 ${(100 - pct).toFixed(2)}% 0 0)`
    divider.style.left = `${pct.toFixed(2)}%`

    const diffSummaryA = opts.diffs.slice(0, 3).map(d => `${d.key}: ${d.before}`).join(" · ")
    const diffSummaryB = opts.diffs.slice(0, 3).map(d => `${d.key}: ${d.after} (${d.deltaText})`).join(" · ")
    badgeA.textContent = `SLOT A (f${opts.frames})${diffSummaryA ? ` · ${diffSummaryA}` : ""}`
    badgeB.textContent = `SLOT B (f${opts.frames})${diffSummaryB ? ` · ${diffSummaryB}` : ""}`
  }

  return {
    wrap,
    offscreenCanvas,
    imageA,
    divider,
    sync,
  }
}
