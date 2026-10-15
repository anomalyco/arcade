import { springMotion } from "../../core/spring.js"

export type Rgba = readonly [number, number, number, number]

const colorCache = new Map<string, Rgba>()
let probeCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null

function getProbeCtx() {
  if (probeCtx) return probeCtx
  if (typeof OffscreenCanvas !== "undefined") {
    probeCtx = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })
  } else if (typeof document !== "undefined") {
    const c = document.createElement("canvas")
    c.width = 1
    c.height = 1
    probeCtx = c.getContext("2d", { willReadFrequently: true })
  }
  return probeCtx
}

export function parseCssColor(raw: string, fallback: Rgba = [1, 1, 1, 1]): Rgba {
  const s = raw.trim()
  if (!s) return fallback
  const hit = colorCache.get(s)
  if (hit) return hit

  let out: Rgba | undefined
  if (s.startsWith("#")) {
    const hex = s.slice(1)
    if (hex.length === 3) {
      out = [
        parseInt(hex[0]! + hex[0]!, 16) / 255,
        parseInt(hex[1]! + hex[1]!, 16) / 255,
        parseInt(hex[2]! + hex[2]!, 16) / 255,
        1,
      ]
    } else if (hex.length === 6 || hex.length === 8) {
      out = [
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      ]
    }
  } else if (s.startsWith("rgb")) {
    const nums = s.match(/[\d.]+/g)?.map(Number)
    if (nums && nums.length >= 3) {
      out = [
        Math.min(1, Math.max(0, nums[0]! / 255)),
        Math.min(1, Math.max(0, nums[1]! / 255)),
        Math.min(1, Math.max(0, nums[2]! / 255)),
        nums.length >= 4 ? Math.min(1, Math.max(0, nums[3]!)) : 1,
      ]
    }
  }

  if (!out) {
    const ctx = getProbeCtx()
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = s
      ctx.fillRect(0, 0, 1, 1)
      const data = ctx.getImageData(0, 0, 1, 1).data
      out = [data[0]! / 255, data[1]! / 255, data[2]! / 255, data[3]! / 255]
    } else {
      out = fallback
    }
  }

  if (colorCache.size > 1024) colorCache.clear()
  colorCache.set(s, out)
  return out
}

export function withAlpha(c: Rgba, alphaFactor: number): Rgba {
  return [c[0], c[1], c[2], Math.min(1, Math.max(0, c[3] * alphaFactor))]
}

export function mixColor(a: Rgba, b: Rgba, t: number): Rgba {
  const u = Math.min(1, Math.max(0, t))
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
    a[3] + (b[3] - a[3]) * u,
  ]
}

/** CSS `color-mix(in srgb, a p, b)`, interpolated with premultiplied alpha like the browser. */
export function cssMix(a: Rgba, b: Rgba, p: number): Rgba {
  const alpha = a[3] * p + b[3] * (1 - p)
  if (alpha <= 0) return [0, 0, 0, 0]
  const ch = (i: number) => (a[i]! * a[3] * p + b[i]! * b[3] * (1 - p)) / alpha
  return [ch(0), ch(1), ch(2), alpha]
}

export interface PanelThemeTokens {
  readonly bg: Rgba
  readonly surface: Rgba
  readonly surfaceHi: Rgba
  readonly line: Rgba
  readonly lineHi: Rgba
  readonly text: Rgba
  readonly label: Rgba
  readonly dim: Rgba
  readonly accent: Rgba
  readonly modified: Rgba
  readonly segBg: Rgba
  readonly segActive: Rgba
  readonly toggleTrack: Rgba
  readonly toggleThumb: Rgba
  readonly rim: Rgba
  readonly rowHover: Rgba
  /** Space between rows (px); above 0 each row is its own bar rather than part of one card. */
  readonly rowGap: number
  /** Hover wash in and out (ms). */
  readonly hoverIn: number
  readonly hoverOut: number
  /** A slider handle's opacity at rest (0 shows it only on hover, focus and drag). */
  readonly handleRest: number
  /** Group headings in small caps (`--k-group-transform: none` keeps their case). */
  readonly groupUpper: boolean
  /** The slider handle's colour and how far inside the fill's edge it sits (px). */
  readonly handle: Rgba
  readonly handleInset: number
  /** Group headings: size (px), colour, letter spacing (em) and the hairline above a group. */
  readonly groupSize: number
  readonly groupColor: Rgba
  readonly groupTracking: number
  readonly groupDivider: Rgba
  /** Readout units: the space before them (px) and their colour. */
  readonly unitGap: number
  /** null: the readout's own colour (`currentColor`). */
  readonly unitColor: Rgba | null
  /** 1: a modified readout takes the modified colour behind a small dot. */
  readonly readoutMark: number
  /** The readout's face. */
  readonly valueFamily: string
  /** Spring curve: horizontal inset (px), one dashed guide at rest (vs. two solid), the running dot. */
  readonly curveInset: number
  readonly curveDashed: boolean
  readonly curveDot: number
  readonly pillBg: Rgba
  readonly pillBorder: Rgba
  readonly fillRest: Rgba
  readonly fillActive: Rgba
  /** The fill under a hovered slider. */
  readonly fillHover: Rgba
  /** 0 drops an inline panel's card: background, border and rim. */
  readonly chrome: number
  /** A page's background (--k-page). */
  readonly page: Rgba
  readonly pad: number
  readonly inset: number
  readonly row: number
  readonly gap: number
  readonly trayPad: number
  readonly radius: number
  readonly panelRadius: number
  readonly radiusMd: number
  readonly radiusSm: number
  readonly fontSize: number
  readonly textTitle: number
  readonly textBody: number
  readonly textControl: number
  readonly textMeta: number
  readonly textCap: number
  /** Readouts' size (--k-value-size, else a half pixel under the body size). */
  readonly valueSize: number
  /** The button tokens (--k-button-*), where set; each element keeps its own look otherwise. */
  readonly buttonBg: Rgba | null
  readonly buttonLine: Rgba | null
  readonly buttonHoverBg: Rgba | null
  readonly buttonHoverLine: Rgba | null
  readonly buttonRadius: number | null
  readonly buttonFontSize: number | null
  readonly iconSize: number
  readonly iconSm: number
  readonly labelWeight: number
  readonly disabledOpacity: number
  readonly hintTypedOpacity: number
  readonly blurStrength: number
  /** Smear on moving fill edges and selection pills, 0 (off) to 1 (--k-motion-blur). */
  readonly motionBlur: number
  readonly glowStrength: number
  /** 0 is an opaque panel; up to 1 thins it over a blurred backdrop (--k-glass). */
  readonly glass: number
  /** Backdrop brightness under full glass (dims what shows through dark panels). */
  readonly glassTone: number
  /** The spring values settle on (--k-spring: duration bounce), as ω and ζ. */
  readonly fillOmega: number
  readonly fillZeta: number
  readonly fontFamily: string
  readonly monoFamily: string
  readonly isLight: boolean
  /** Body and readout weight (--k-font-weight) and titles' and headings' (--k-title-weight). */
  readonly fontWeight: number
  readonly titleWeight: number
  /** Round things' radius (--k-round): fully round unless --k-radius is 0, or a px value. */
  readonly round: number
  /** `flat`: groups draw no card surfaces and rows square off (--k-frame). */
  readonly flat: boolean
  /** A switch's thumb when off, and colour strips' rings (--k-thumb). */
  readonly thumb: Rgba
  /** How strongly small drop shadows show under thumbs and pills (--k-lift). */
  readonly lift: number
}

/** A token as the panel shows it now: the gliding alias (see styles.ts), else the public value. */
const token = (style: CSSStyleDeclaration, name: string) =>
  style.getPropertyValue(`--kv-${name}`) || style.getPropertyValue(`--k-${name}`)

const numProp = (style: CSSStyleDeclaration, name: string, fallback: number): number => {
  const raw = parseFloat(token(style, name))
  return Number.isFinite(raw) ? raw : fallback
}

/** A length token in px: `Npx`, or `Nem` against `em`; anything else (a calc) is `fallback`. */
const lengthProp = (style: CSSStyleDeclaration, name: string, em: number, fallback: number) => {
  const raw = token(style, name).trim()
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return fallback
  return raw.endsWith("em") ? n * em : n
}
const colorProp = (style: CSSStyleDeclaration, name: string, fallback: Rgba): Rgba =>
  token(style, name).trim() ? parseCssColor(token(style, name), fallback) : fallback

const optColor = (style: CSSStyleDeclaration, name: string): Rgba | null => {
  const raw = style.getPropertyValue(`--k-${name}`).trim()
  return raw ? parseCssColor(raw, [0, 0, 0, 0]) : null
}
const optLength = (style: CSSStyleDeclaration, name: string, em: number): number | null => {
  const raw = style.getPropertyValue(`--k-${name}`).trim()
  if (!raw) return null
  const n = parseFloat(raw)
  return Number.isFinite(n) ? (raw.endsWith("em") ? n * em : n) : null
}

const tokenCache = new WeakMap<HTMLElement, { version: number; tokens: PanelThemeTokens }>()

export function readPanelTokens(panel: HTMLElement, version = -1): PanelThemeTokens {
  if (version >= 0) {
    const hit = tokenCache.get(panel)
    if (hit && hit.version === version) return hit.tokens
  }
  const style = getComputedStyle(panel)
  const bg = parseCssColor(token(style, "bg"), [0.11, 0.11, 0.12, 1])
  const isLight = bg[0] * 0.2126 + bg[1] * 0.7152 + bg[2] * 0.0722 > 0.55
  const surface = parseCssColor(
    token(style, "surface"),
    isLight ? [0, 0, 0, 0.05] : [1, 1, 1, 0.055],
  )
  const surfaceHi = parseCssColor(
    token(style, "surface-hi"),
    isLight ? [0, 0, 0, 0.095] : [1, 1, 1, 0.11],
  )
  const line = parseCssColor(token(style, "line"), isLight ? [0, 0, 0, 0.1] : [1, 1, 1, 0.1])
  const lineHi = parseCssColor(token(style, "line-hi"), isLight ? [0, 0, 0, 0.2] : [1, 1, 1, 0.18])
  const text = parseCssColor(token(style, "text"), isLight ? [0, 0, 0, 0.88] : [1, 1, 1, 0.92])
  const label = parseCssColor(
    token(style, "label"),
    isLight ? [0.23, 0.23, 0.26, 0.68] : [1, 1, 1, 0.64],
  )
  const dim = parseCssColor(
    token(style, "dim"),
    isLight ? [0.235, 0.235, 0.263, 0.5] : [1, 1, 1, 0.42],
  )
  const accent = parseCssColor(
    token(style, "accent"),
    isLight ? [0.11, 0.11, 0.12, 1] : [1, 1, 1, 1],
  )
  const modified = parseCssColor(
    token(style, "modified"),
    isLight ? [0, 0, 0, 0.42] : [1, 1, 1, 0.5],
  )
  const segBg = parseCssColor(token(style, "seg-bg"), isLight ? [0, 0, 0, 0.065] : [0, 0, 0, 0.26])
  const segActive = parseCssColor(token(style, "seg-active"), surfaceHi)
  const toggleTrack = parseCssColor(
    token(style, "toggle-track"),
    isLight ? [0, 0, 0, 0.14] : [1, 1, 1, 0.14],
  )
  const fillBase = style.getPropertyValue("--k-fill-base").trim()
    ? parseCssColor(token(style, "fill-base"), surfaceHi)
    : surfaceHi
  const accentLum = accent[0] * 0.2126 + accent[1] * 0.7152 + accent[2] * 0.0722
  const toggleThumb = parseCssColor(
    token(style, "toggle-thumb"),
    !isLight && accentLum > 0.78 ? bg : [1, 1, 1, 1],
  )

  const [duration, bounce] = style.getPropertyValue("--k-spring").trim().split(/\s+/).map(Number)
  const fill =
    Number.isFinite(duration) && Number.isFinite(bounce)
      ? springMotion({ duration: duration!, bounce: bounce! })
      : { omega: 30, zeta: 0.88 }

  const fontFamily =
    style.fontFamily ||
    style.getPropertyValue("--k-font").trim() ||
    'system-ui, -apple-system, "SF Pro Text", sans-serif'
  const monoFamily =
    style.getPropertyValue("--k-mono").trim() ||
    '"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace'

  const unit = numProp(style, "unit", 4)
  const pad = numProp(style, "pad", 10)
  const inset = numProp(style, "inset", pad)
  const row = numProp(style, "row", 32)
  const gap = numProp(style, "gap", 4)
  const trayPad = numProp(style, "tray-pad", unit * 0.5)
  const radius = numProp(style, "radius", 8)
  const panelRadius = numProp(style, "panel-radius", radius + unit)
  const radiusMd = Math.max(0, radius - trayPad)
  const radiusSm = Math.max(0, radius - trayPad * 2)
  const fontSize = parseFloat(style.fontSize) || numProp(style, "font-size", 12)
  const roundRaw = style.getPropertyValue("--k-round").trim()
  const round = /^-?[\d.]+(px)?$/.test(roundRaw)
    ? Math.max(0, parseFloat(roundRaw))
    : radius > 0
      ? 1e4
      : 0

  const tokens: PanelThemeTokens = {
    bg,
    surface,
    surfaceHi,
    line,
    lineHi,
    text,
    label,
    dim,
    accent,
    modified,
    segBg,
    segActive,
    toggleTrack,
    toggleThumb,
    rim: parseCssColor(token(style, "rim"), isLight ? [1, 1, 1, 0.75] : [1, 1, 1, 0.09]),
    page: parseCssColor(
      token(style, "page"),
      isLight ? [0.902, 0.902, 0.922, 1] : [0.063, 0.063, 0.071, 1],
    ),
    rowHover: withAlpha(surface, 0.5),
    rowGap: numProp(style, "row-gap", 0),
    hoverIn: numProp(style, "hover-in", 150),
    hoverOut: numProp(style, "hover-out", 150),
    handleRest: numProp(style, "handle-rest", 0),
    handle: colorProp(style, "handle", accent),
    handleInset: lengthProp(style, "handle-inset", fontSize, 0),
    groupUpper: style.getPropertyValue("--k-group-transform").trim() !== "none",
    groupSize: lengthProp(style, "group-size", fontSize, fontSize - 2),
    groupColor: colorProp(style, "group-color", dim),
    groupTracking: lengthProp(style, "group-tracking", 1, 0.04),
    groupDivider: colorProp(style, "group-divider", [0, 0, 0, 0]),
    unitGap: lengthProp(style, "unit-gap", fontSize - 0.5, (fontSize - 0.5) * 0.28),
    unitColor: /^currentcolor$/i.test(token(style, "unit-color").trim())
      ? null
      : colorProp(style, "unit-color", dim),
    readoutMark: numProp(style, "readout-mark", 0),
    valueFamily: style.getPropertyValue("--k-value-font").trim() || fontFamily,
    curveInset: lengthProp(style, "curve-inset", fontSize, 6),
    curveDashed: style.getPropertyValue("--k-curve-guide").trim() === "dashed",
    curveDot: numProp(style, "curve-dot", 1),
    pillBg: cssMix(accent, segActive, 0.18),
    pillBorder: withAlpha(accent, 0.32),
    fillRest: cssMix(accent, fillBase, numProp(style, "fill-rest-mix", 20) / 100),
    fillActive: cssMix(accent, fillBase, numProp(style, "fill-active-mix", 30) / 100),
    fillHover: cssMix(
      accent,
      fillBase,
      numProp(style, "fill-hover-mix", numProp(style, "fill-rest-mix", 20)) / 100,
    ),
    chrome: Math.min(1, Math.max(0, numProp(style, "chrome", 1))),
    pad,
    inset,
    row,
    gap,
    trayPad,
    radius,
    panelRadius,
    radiusMd,
    radiusSm,
    fontSize,
    textTitle: fontSize + 1,
    textBody: fontSize,
    textControl: fontSize - 0.5,
    textMeta: fontSize - 1,
    textCap: fontSize - 2,
    valueSize: parseFloat(style.getPropertyValue("--kc-value-size")) || fontSize - 0.5,
    buttonBg: optColor(style, "button-bg"),
    buttonLine: optColor(style, "button-line"),
    buttonHoverBg: optColor(style, "button-hover-bg"),
    buttonHoverLine: optColor(style, "button-hover-line"),
    buttonRadius: optLength(style, "button-radius", fontSize),
    buttonFontSize: optLength(style, "button-font-size", fontSize),
    iconSize: numProp(style, "icon-size", 14),
    iconSm: numProp(style, "icon-sm", 13),
    labelWeight: numProp(style, "label-weight", 500),
    disabledOpacity: numProp(style, "disabled-opacity", 0.32),
    hintTypedOpacity: numProp(style, "hint-typed-opacity", 0.42),
    blurStrength: numProp(style, "blur", 1),
    motionBlur: Math.min(1, Math.max(0, numProp(style, "motion-blur", 0))),
    glowStrength: numProp(style, "glow", 0.5),
    glass: Math.min(1, Math.max(0, numProp(style, "glass", 0))),
    glassTone: numProp(style, "glass-tone", isLight ? 1.08 : 0.5),
    fillOmega: fill.omega,
    fillZeta: fill.zeta,
    fontFamily,
    monoFamily,
    isLight,
    fontWeight: numProp(style, "font-weight", 400),
    titleWeight: numProp(style, "title-weight", 600),
    round,
    flat: style.getPropertyValue("--k-frame").trim() === "flat",
    thumb: colorProp(style, "thumb", [1, 1, 1, 1]),
    lift: Math.max(0, numProp(style, "lift", 1)),
  }
  if (version >= 0) tokenCache.set(panel, { version, tokens })
  return tokens
}
