import { springCss } from "./spring.js"

/**
 * A named set of `--k-*` token values for dark and light, applied to panels mounted with
 * `{ preset }` (or with `data-preset="<name>"` and `presetCss(preset)` in your own stylesheet).
 * `css` adds rules for anything tokens don't cover; `&` stands for the panel.
 */
export interface TokenPreset {
  readonly name: string
  readonly dark: Readonly<Record<string, string | number>>
  readonly light?: Readonly<Record<string, string | number>>
  readonly css?: string
}

const block = (tokens: Readonly<Record<string, string | number>>) =>
  Object.entries(tokens)
    .map(([k, v]) => `${k.startsWith("--") || k === "color-scheme" ? k : `--k-${k}`}:${v}`)
    .join(";")

/** The stylesheet for a preset: its dark tokens, its light ones wherever a panel is light. */
export function presetCss(preset: TokenPreset): string {
  if (!/^[\w-]+$/.test(preset.name)) throw new Error(`Invalid preset name: ${preset.name}`)
  const at = `.knobs-panel[data-preset="${preset.name}"]`
  const light = preset.light
    ? `:where(.knobs-panel)[data-preset="${preset.name}"][data-theme="light"],` +
      `:where([data-knobs-theme="light"]) ${at}:not([data-theme="dark"]),` +
      `:where(:root[data-theme="light"]) ${at}[data-theme="auto"]{${block(preset.light)}}` +
      `@media(prefers-color-scheme:light){:where(:root:not([data-theme="dark"])) ${at}[data-theme="auto"]{${block(preset.light)}}}`
    : ""
  return `${at}{${block(preset.dark)}}${light}${(preset.css ?? "").replaceAll("&", at)}`
}

const glide = /* @__PURE__ */ springCss({ duration: 0.185, bounce: 0.14 })

/**
 * A dense, square editor (Arcade's Lab): radius 0, compact 26 px rows, the flat frame (groups as
 * plain sections split by hairlines, no cards, and no panel card when inline), the Lab's greys
 * and one blue accent, small type with monospaced readouts, and no glass, glow or lift. Mount it
 * inside the host's own card or column.
 */
export const labPreset: TokenPreset = {
  name: "lab",
  dark: {
    bg: "#191a1e",
    page: "#141518",
    surface: "rgba(216,219,224,.045)",
    "surface-hi": "rgba(216,219,224,.08)",
    line: "#23252a",
    "line-hi": "#2c2f35",
    text: "#d8dbe0",
    label: "#8b9098",
    dim: "#5b6068",
    accent: "#4d8dff",
    modified: "#4d8dff",
    "seg-bg": "#0e0f11",
    "seg-active": "#2c3747",
    "toggle-track": "#2c2f35",
    "toggle-thumb": "#fff",
    thumb: "#c4c8ce",
    rim: "transparent",
    font: '-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif',
    mono: 'ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace',
    "font-size": "11.5px",
    "font-weight": 400,
    "label-weight": 400,
    "title-weight": 600,
    row: "26px",
    pad: "0px",
    inset: "8px",
    gap: "3px",
    radius: "0px",
    "panel-radius": "0px",
    frame: "flat",
    chrome: 0,
    glass: 0,
    glow: 0,
    lift: 0,
    blur: 0.6,
    "hover-in": 0,
    "hover-out": 120,
    "fill-rest-mix": "22%",
    "fill-hover-mix": "28%",
    "fill-active-mix": "34%",
    "handle-rest": 0,
    "value-font": "var(--k-mono)",
    "unit-gap": ".3em",
    "readout-mark": 1,
    "group-size": "10px",
    "group-color": "#8b9098",
    "group-tracking": ".06em",
    "group-divider": "#23252a",
    "group-divider-gap": "6px",
    "disabled-opacity": 0.38,
    "curve-guide": "dashed",
    "curve-dot": 0,
  },
}

/**
 * The Problems viewer's parameter panel: separate 34 px bars 4 px apart, its blue fill and
 * labels, a spring card that stacks its curve over two sliders, washes that arrive at once and
 * leave over 100 ms, and Problems' own slider spring (ω 34, ζ 0.86). An inline panel sheds its
 * chrome to sit in the host's column. Every difference from the defaults is a token.
 */
export const problemsPreset: TokenPreset = {
  name: "problems",
  dark: {
    bg: "#161618",
    surface: "rgba(255,255,255,.055)",
    "surface-hi": "rgba(255,255,255,.11)",
    line: "rgba(255,255,255,.075)",
    "line-hi": "rgba(255,255,255,.12)",
    text: "#f5f5f7",
    label: "rgba(235,235,245,.62)",
    dim: "rgba(235,235,245,.36)",
    accent: "#0091ff",
    modified: "#0091ff",
    "seg-bg": "rgba(120,120,128,.16)",
    "seg-active": "rgba(120,120,128,.24)",
    "toggle-track": "rgba(120,120,128,.32)",
    "toggle-thumb": "#fff",
    rim: "transparent",
    font: 'system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif',
    mono: '"Kit SF Mono",ui-monospace,Menlo,monospace',
    "font-size": "13px",
    "label-weight": 500,
    row: "34px",
    radius: "8px",
    "panel-radius": "12px",
    pad: "0px",
    inset: "10px",
    gap: "4px",
    "row-gap": "4px",
    glass: 0,
    glow: 0,
    blur: 0.6,
    "hover-in": 0,
    "hover-out": 100,
    "handle-rest": 0.55,
    handle: "var(--k-text)",
    "handle-inset": "7.5px",
    "fill-base": "transparent",
    "fill-rest-mix": "24%",
    "fill-hover-mix": "36%",
    "fill-active-mix": "36%",
    chrome: 0,
    "group-transform": "none",
    "value-font": "var(--k-mono)",
    "unit-gap": "0px",
    "unit-color": "currentColor",
    "readout-mark": 1,
    "group-size": "12px",
    "group-color": "rgba(235,235,245,.62)",
    "group-inset": "0px",
    "group-tracking": "-.01em",
    "group-divider": "rgba(255,255,255,.075)",
    "group-divider-gap": "8px",
    "curve-inset": "0px",
    "curve-guide": "dashed",
    "curve-dot": 0,
    spring: "0.185 0.14",
    "fill-ease": glide.easing,
    "fill-ms": glide.duration,
  },
  light: {
    bg: "#fff",
    surface: "rgba(0,0,0,.045)",
    "surface-hi": "rgba(0,0,0,.09)",
    line: "rgba(0,0,0,.07)",
    "line-hi": "rgba(0,0,0,.11)",
    text: "#000",
    label: "rgba(60,60,67,.66)",
    dim: "rgba(60,60,67,.38)",
    accent: "#0088ff",
    modified: "#0088ff",
    "seg-bg": "rgba(120,120,128,.11)",
    "seg-active": "#fff",
    "toggle-track": "rgba(120,120,128,.2)",
    "toggle-thumb": "#fff",
    rim: "transparent",
    "group-color": "rgba(60,60,67,.66)",
    "group-divider": "rgba(0,0,0,.07)",
    "color-scheme": "light",
  },
}
