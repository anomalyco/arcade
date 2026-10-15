import { springEasing } from "../core/spring.js"
import { presetCss, type TokenPreset } from "../core/theme.js"
import { overlayCss } from "./overlay-css.js"
import { readoutCss } from "./readout-css.js"

export type UiTheme = "dark" | "light" | "auto"

/** What every piece takes to match the panels beside it. */
export interface UiLook {
  /** A token preset (`labPreset`): the same tokens a panel takes. */
  readonly preset?: TokenPreset
  readonly theme?: UiTheme
}

const ease = springEasing(26, 1)

// The pieces read knobs' public tokens (--k-*), set by a host, a preset or the panel's own :root
// defaults; each falls back to the panel's default, so a piece standing alone looks the same.
const TOKENS: Record<string, string> = {
  bg: "#1c1c1e",
  surface: "rgba(255,255,255,.055)",
  "surface-hi": "rgba(255,255,255,.11)",
  line: "rgba(255,255,255,.1)",
  "line-hi": "rgba(255,255,255,.18)",
  text: "rgba(255,255,255,.92)",
  label: "rgba(255,255,255,.64)",
  dim: "rgba(255,255,255,.42)",
  accent: "#fff",
  font: 'system-ui,-apple-system,"SF Pro Text",sans-serif',
  mono: '"SF Mono",SFMono-Regular,ui-monospace,Menlo,monospace',
  "font-size": "12px",
  "font-weight": "400",
  "label-weight": "500",
  "title-weight": "600",
  row: "32px",
  inset: "10px",
  radius: "8px",
  "hover-in": "150",
  "hover-out": "150",
  warn: "#ff9f0a",
  critical: "#ff453a",
  rim: "rgba(255,255,255,.09)",
  page: "#101012",
  "seg-bg": "rgba(0,0,0,.26)",
  shadow: "0 12px 36px rgba(0,0,0,.52),0 1px 2px rgba(0,0,0,.3)",
}
const LIGHT: Record<string, string> = {
  bg: "#f5f5f7",
  surface: "rgba(0,0,0,.05)",
  "surface-hi": "rgba(0,0,0,.095)",
  line: "rgba(0,0,0,.1)",
  "line-hi": "rgba(0,0,0,.2)",
  text: "rgba(0,0,0,.88)",
  label: "rgba(60,60,67,.68)",
  dim: "rgba(60,60,67,.5)",
  accent: "#1c1c1e",
  warn: "#c56a00",
  critical: "#e0352b",
  rim: "rgba(255,255,255,.75)",
  page: "#e6e6eb",
  "seg-bg": "rgba(0,0,0,.065)",
  shadow: "0 10px 32px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08)",
}
const lightBlock = `${Object.entries(LIGHT)
  .map(([k, v]) => `--k-${k}:${v}`)
  .join(";")};color-scheme:light`

const css = `
:where(.knobs-ui){${Object.entries(TOKENS)
  .map(([k, v]) => `--ku-${k}:var(--k-${k},${v})`)
  .join(";")};
  --ku-control-h:var(--k-control-h,calc(var(--ku-row) - 8px));
  --ku-value-font:var(--k-value-font,var(--ku-font));
  --ku-value-size:var(--kc-value-size,calc(var(--ku-font-size) - .5px));
  --ku-text-meta:var(--k-text-meta,calc(var(--ku-font-size) - 1px));
  --ku-hit:var(--k-ui-hit,9px);
  --ku-rail:var(--k-ui-rail,var(--ku-row));
  --ku-indent:var(--k-ui-indent,14px);
  --ku-select:var(--k-ui-select,color-mix(in srgb,var(--ku-accent) 13%,transparent));
  --ku-select-focus:var(--k-ui-select-focus,color-mix(in srgb,var(--ku-accent) 19%,transparent));
  --ku-wash:var(--k-ui-wash,color-mix(in srgb,var(--ku-surface) 70%,transparent));
  --ku-wash-hi:var(--k-ui-wash-hi,var(--ku-surface-hi));
  --ku-ease:${ease.easing};--ku-ease-ms:${ease.ms}ms;
  /* The card frame (knobs' own look): every leaf pane a rounded card on the page, half a gap
     inside its slot, so panes sit a gap apart with the dividers' grips between them; tree rows
     inset as soft rounded washes. --k-frame: flat (labPreset) puts panes edge to edge on
     hairlines, square, as a dense editor's columns. */
  --ku-panel-radius:var(--k-panel-radius,calc(var(--ku-radius) + 4px));
  --ku-gap:var(--k-ui-gap,6px);
  --ku-pane-m:calc(var(--ku-gap) / 2);
  --ku-pane-bg:var(--k-ui-pane,var(--ku-bg));
  --ku-pane-radius:var(--ku-panel-radius);
  --ku-pane-ring:inset 0 0 0 1px var(--ku-line),inset 0 1px 0 var(--ku-rim);
  --ku-divider:var(--k-ui-divider,transparent);
  --ku-row-x:var(--k-ui-row-x,6px);
  --ku-row-radius:max(0px,calc(var(--ku-panel-radius) - var(--ku-row-x)));
}
:where(.knobs-ui)[data-frame="flat"]{--ku-gap:var(--k-ui-gap,0px);--ku-pane-bg:var(--k-ui-pane,transparent);--ku-pane-radius:0px;--ku-pane-ring:none;
  --ku-divider:var(--k-ui-divider,var(--ku-line));--ku-row-x:var(--k-ui-row-x,0px);--ku-row-radius:0px;
  --ku-select:var(--k-ui-select,color-mix(in srgb,var(--ku-accent) 24%,transparent));--ku-select-focus:var(--k-ui-select-focus,color-mix(in srgb,var(--ku-accent) 34%,transparent))}
:where(.knobs-ui)[data-theme="light"],
:where(:root[data-theme="light"]) :where(.knobs-ui)[data-theme="auto"]{${lightBlock}}
@media(prefers-color-scheme:light){:where(:root:not([data-theme="dark"])) :where(.knobs-ui)[data-theme="auto"]{${lightBlock}}}
/* Only the pieces' own elements take their type and resets: what you put in a pane is yours. */
.knobs-ui{box-sizing:border-box}
:where(.knobs-split>*,.knobs-pane-clip,.knobs-pane-inner,.knobs-pane-body,.knobs-pane-head,.knobs-pane-head *,.knobs-pane-rail,.knobs-pane-rail *,.knobs-tree,.knobs-tree *,.knobs-tree-ghost){box-sizing:border-box}
:is(.knobs-tree,.knobs-pane-head,.knobs-pane-rail,.knobs-tree-ghost){font:var(--ku-font-weight) var(--ku-font-size)/1.35 var(--ku-font);color:var(--ku-text);text-align:left;
  letter-spacing:normal;word-spacing:normal;text-transform:none;text-indent:0;text-shadow:none;font-style:normal;-webkit-font-smoothing:antialiased}
/* A host's element rules (button{padding}, header{margin}, mark{background}) stop at these, as
   they do at panels; (0,1,0), so the pieces' own rules after it win. */
:where(.knobs-ui) :is(.knobs-pane-head,.knobs-pane-btn,.knobs-pane-rail,.knobs-tree-toggle,.knobs-tree-edit,.knobs-tree-mark){all:revert;box-sizing:border-box;
  font:inherit;color:inherit;letter-spacing:inherit;background:transparent;border:0;border-radius:0;margin:0;padding:0;min-width:0;box-shadow:none;outline:none}
:is(.knobs-divider,.knobs-tree,.knobs-pane-btn,.knobs-pane-rail,.knobs-tree-toggle,.knobs-tree-edit):is(:focus,:focus-visible){outline:none}
:is(.knobs-tree,.knobs-split>.knobs-pane>.knobs-pane-clip>.knobs-pane-inner>.knobs-pane-head) [hidden]{display:none!important}
:is(.knobs-pane-head,.knobs-pane-rail,.knobs-tree) svg{display:block;flex:none}

/* Split: panes along a row or column, hairline dividers with a wider grip. */
.knobs-split{position:relative;display:flex;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}
.knobs-split[data-direction="column"]{flex-direction:column}
.knobs-pane{position:relative;flex:none;min-width:0;min-height:0;overflow:hidden}
.knobs-pane-clip{position:absolute;inset:0;margin:var(--ku-pane-m);overflow:hidden;border-radius:var(--ku-pane-radius);background:var(--ku-pane-bg)}
.knobs-pane-clip::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:var(--ku-pane-ring);pointer-events:none}
/* A pane holding another split is only its slot: the split's own panes are the cards. */
.knobs-pane[data-nested]>.knobs-pane-clip{margin:0;background:transparent}
.knobs-pane[data-nested]>.knobs-pane-clip::after{content:none}
.knobs-pane-inner{position:absolute;inset:0;display:flex;flex-direction:column;min-width:0;min-height:0}
.knobs-pane-body{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden}
.knobs-pane[data-scroll] .knobs-pane-body{overflow:auto;scrollbar-width:thin}
.knobs-pane[data-rail][data-collapsed][data-settled]>.knobs-pane-clip,.knobs-pane:not([data-rail])[data-collapsed][data-settled]>.knobs-pane-clip>.knobs-pane-inner>.knobs-pane-body{visibility:hidden}
.knobs-ui .knobs-pane-head{display:flex;align-items:center;gap:6px;flex:none;height:var(--ku-row);padding:0 calc(var(--ku-inset) - 4px) 0 var(--ku-inset);user-select:none;-webkit-user-select:none}
.knobs-pane-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:var(--ku-title-weight);color:var(--ku-text)}
.knobs-pane-count{flex:none;color:var(--ku-dim);font-variant-numeric:tabular-nums}
.knobs-pane-fill{flex:1}
.knobs-ui .knobs-pane-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:calc(var(--ku-radius) * 999);color:var(--ku-dim);cursor:pointer;
  transition:background var(--hover-t,.15s),color .15s}
.knobs-ui .knobs-pane-btn:is(:hover,:focus-visible){background:var(--ku-wash-hi);color:var(--ku-text)}
.knobs-ui .knobs-pane-btn[aria-pressed="true"]{color:var(--ku-accent)}
.knobs-pane-btn svg{width:13px;height:13px}
.knobs-pane-head[data-toggles]{cursor:pointer}
.knobs-pane-caret{transition:transform var(--ku-ease-ms) var(--ku-ease)}
.knobs-pane[data-collapsed] .knobs-pane-caret{transform:rotate(-90deg)}
/* A collapsed pane's rail: its title along the edge; a click opens it. */
.knobs-ui .knobs-pane-rail{position:absolute;inset:0;margin:var(--ku-pane-m);border-radius:var(--ku-pane-radius);background-color:var(--ku-pane-bg);box-shadow:var(--ku-pane-ring);display:flex;align-items:center;gap:8px;color:var(--ku-label);cursor:pointer;opacity:0;pointer-events:none;
  font-weight:var(--ku-title-weight);transition:background .15s,color .15s}
.knobs-split[data-direction="row"]>.knobs-pane>.knobs-pane-rail{writing-mode:vertical-rl;padding:10px 0}
.knobs-split[data-direction="column"]>.knobs-pane>.knobs-pane-rail{padding:0 var(--ku-inset)}
.knobs-pane[data-collapsed]>.knobs-pane-rail{pointer-events:auto}
.knobs-ui .knobs-pane-rail:is(:hover,:focus-visible){background-image:linear-gradient(var(--ku-wash),var(--ku-wash));color:var(--ku-text)}
.knobs-pane-rail span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.knobs-pane-rail svg{width:11px;height:11px;color:var(--ku-dim);writing-mode:horizontal-tb}

.knobs-divider{position:relative;z-index:2;flex:none;width:1px;background:var(--ku-divider);touch-action:none;outline:none}
.knobs-split[data-direction="column"]>.knobs-divider{width:auto;height:1px}
.knobs-divider::before{content:"";position:absolute;top:0;bottom:0;left:calc(50% - var(--ku-hit) / 2);width:var(--ku-hit);cursor:col-resize}
.knobs-split[data-direction="column"]>.knobs-divider::before{left:0;right:0;top:calc(50% - var(--ku-hit) / 2);bottom:auto;width:auto;height:var(--ku-hit);cursor:row-resize}
/* Hover, focus and drags draw the hairline in the accent, with a soft wash beside it. */
.knobs-divider::after{content:"";position:absolute;inset:0 -1px;background:var(--ku-accent);opacity:0;pointer-events:none;
  box-shadow:0 0 0 2px color-mix(in srgb,var(--ku-accent) 18%,transparent);transition:opacity .16s}
.knobs-split[data-direction="column"]>.knobs-divider::after{inset:-1px 0}
.knobs-divider:hover::after{opacity:.7;transition-delay:.12s}
.knobs-divider:focus-visible::after,.knobs-divider[data-active]::after{opacity:1;transition-delay:0s}
/* Between cards, the hairline gives way to a grip: a small capsule in the gap that shows on
   hover, and lengthens and takes the accent while dragged or focused. */
.knobs-split:not([data-frame="flat"])>.knobs-divider::after{inset:auto;left:50%;top:50%;width:4px;height:28px;margin:-14px 0 0 -2px;border-radius:2px;background:var(--ku-line-hi);box-shadow:none;
  transition:opacity .16s,background .16s,scale var(--ku-ease-ms) var(--ku-ease)}
.knobs-split[data-direction="column"]:not([data-frame="flat"])>.knobs-divider::after{inset:auto;left:50%;top:50%;width:28px;height:4px;margin:-2px 0 0 -14px}
.knobs-split:not([data-frame="flat"])>.knobs-divider:hover::after{opacity:1}
.knobs-split:not([data-frame="flat"])>.knobs-divider:is(:focus-visible,[data-active])::after{background:var(--ku-accent);opacity:.9;scale:1 1.45}
.knobs-split[data-direction="column"]:not([data-frame="flat"])>.knobs-divider:is(:focus-visible,[data-active])::after{scale:1.45 1}
:root[data-knobs-resizing],:root[data-knobs-resizing] *{user-select:none!important;-webkit-user-select:none!important}
:root[data-knobs-resizing="row"] *{cursor:col-resize!important}
:root[data-knobs-resizing="column"] *{cursor:row-resize!important}
:root[data-knobs-resizing] :is(iframe,canvas:not(.knobs-gpu-canvas)){pointer-events:none}

/* Tree: one scroller, rows placed by transform, only those near the view in the DOM. */
.knobs-tree{position:relative;overflow:auto;height:100%;outline:none;scrollbar-width:thin;overscroll-behavior:contain;user-select:none;-webkit-user-select:none}
.knobs-tree-space{position:relative;width:100%;pointer-events:none}
.knobs-tree-row{position:absolute;left:var(--ku-row-x);right:var(--ku-row-x);top:0;display:flex;align-items:center;height:var(--ku-row);padding-right:calc(var(--ku-inset) - 4px);
  color:var(--ku-text);white-space:nowrap;cursor:default;will-change:transform;contain:layout style}
.knobs-tree-row::before{content:"";position:absolute;inset:0;border-radius:var(--ku-row-radius);background:var(--ku-wash);opacity:0;transition:opacity calc(var(--ku-hover-out) * 1ms),background .12s;pointer-events:none}
.knobs-tree:not([data-keyboard]):not([data-dragging]) .knobs-tree-row:hover::before{opacity:1;transition-duration:calc(var(--ku-hover-in) * 1ms)}
.knobs-tree-row[aria-selected="true"]::before{opacity:1;background:var(--ku-select)}
.knobs-tree:focus-visible .knobs-tree-row[data-active]::before,.knobs-tree[data-keyboard]:focus .knobs-tree-row[data-active]::before{opacity:1;background:var(--ku-wash-hi)}
.knobs-tree:focus .knobs-tree-row[data-active][aria-selected="true"]::before{background:var(--ku-select-focus)}
.knobs-tree-row[data-drop="into"]::before{opacity:1;background:color-mix(in srgb,var(--ku-accent) 30%,transparent)}
.knobs-tree-row[data-dragged]{opacity:.38}
.knobs-tree-row>*{position:relative}
.knobs-tree-caret{flex:none;display:flex;align-items:center;justify-content:center;width:16px;height:100%;color:var(--ku-dim);transition:transform var(--ku-ease-ms) var(--ku-ease)}
.knobs-tree-caret svg{width:9px;height:9px}
.knobs-tree-row[aria-expanded="true"]>.knobs-tree-caret{transform:rotate(90deg)}
.knobs-tree-row:not([aria-expanded])>.knobs-tree-caret{visibility:hidden}
.knobs-tree-icon{flex:none;display:flex;align-items:center;justify-content:center;width:14px;margin-right:6px;color:var(--ku-dim);font-size:calc(var(--ku-font-size) - 1px)}
.knobs-tree-label{position:relative;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:var(--ku-font-weight)}
.knobs-tree-row[data-ancestor] .knobs-tree-label{color:var(--ku-label)}
.knobs-tree-label .knobs-tree-mark{color:var(--ku-accent)}
.knobs-tree-row[data-off~="visible"] :is(.knobs-tree-label,.knobs-tree-icon){opacity:.45}
.knobs-tree-row[data-off~="locked"] .knobs-tree-label{color:var(--ku-label)}
.knobs-tree-detail{flex:none;margin-left:6px;color:var(--ku-dim);font-variant-numeric:tabular-nums}
.knobs-tree-tools{flex:none;display:flex;align-items:center;gap:1px;margin-left:4px}
.knobs-ui .knobs-tree-toggle{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:calc(var(--ku-radius) * 999);color:var(--ku-dim);cursor:pointer;opacity:0;transition:opacity .12s,color .12s,background .12s}
.knobs-ui .knobs-tree-toggle svg{width:12px;height:12px}
.knobs-tree-row:is(:hover,[data-active],[aria-selected="true"]) .knobs-tree-toggle,.knobs-ui .knobs-tree-toggle[aria-pressed="false"]{opacity:1}
.knobs-ui .knobs-tree-toggle:hover{background:var(--ku-wash-hi);color:var(--ku-text)}
.knobs-ui .knobs-tree-toggle[aria-pressed="false"]{color:var(--ku-label)}
/* Renaming in place, as a number is edited in a panel: no box, just the text and an underline. */
.knobs-ui .knobs-tree-edit{position:absolute;inset:auto 0 auto 0;top:50%;transform:translateY(-50%);width:100%;height:calc(var(--ku-font-size) * 1.5);padding:0;
  background:transparent;color:var(--ku-text);caret-color:var(--ku-accent);font:inherit;font-weight:var(--ku-font-weight);border-bottom:1px solid var(--ku-text)}
.knobs-tree-edit::selection{background:color-mix(in srgb,var(--ku-accent) 40%,transparent)}
.knobs-tree-row[data-editing] .knobs-tree-text{visibility:hidden}
.knobs-tree-line{position:absolute;left:0;right:6px;top:0;height:2px;margin-top:-1px;border-radius:1px;background:var(--ku-accent);pointer-events:none;opacity:0;transition:opacity .1s}
.knobs-tree-line::before{content:"";position:absolute;left:-3px;top:-2px;width:6px;height:6px;border-radius:50%;box-shadow:inset 0 0 0 2px var(--ku-accent)}
.knobs-tree[data-dragging] .knobs-tree-line[data-shown]{opacity:1}
.knobs-tree-ghost{position:fixed;left:0;top:0;z-index:2147480004;padding:2px 8px;background:var(--ku-bg);color:var(--ku-text);border-radius:var(--ku-radius);
  box-shadow:0 0 0 1px var(--ku-line-hi),0 6px 18px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap;font:var(--ku-font-weight) var(--ku-font-size)/1.6 var(--ku-font)}
.knobs-tree-empty{padding:10px var(--ku-inset);color:var(--ku-dim)}
@media(prefers-reduced-motion:reduce){:is(.knobs-tree,.knobs-split>.knobs-divider,.knobs-pane-head,.knobs-pane-rail) :where(*,::before,::after){transition:none!important}}
`

/** Adds the pieces' stylesheet once per document. */
export function injectUiStyles(doc: Document) {
  if (doc.querySelector("style[data-knobs-ui]")) return
  const style = doc.createElement("style")
  style.dataset.knobsUi = ""
  style.textContent = css + readoutCss + overlayCss
  doc.head.append(style)
}

/** A preset's tokens on the pieces (`data-preset`), from the same preset a panel takes. */
function injectUiPreset(doc: Document, preset: TokenPreset) {
  const content = presetCss({ ...preset, css: undefined }).replaceAll(".knobs-panel", ".knobs-ui")
  const existing = doc.querySelector<HTMLStyleElement>(
    `style[data-knobs-ui-preset="${preset.name}"]`,
  )
  if (existing) {
    if (existing.textContent !== content) existing.textContent = content
    return
  }
  const style = doc.createElement("style")
  style.dataset.knobsUiPreset = preset.name
  style.textContent = content
  doc.head.append(style)
}

/** Styles, preset and theme for a piece's root. */
export function applyLook(root: HTMLElement, look: UiLook) {
  const doc = root.ownerDocument
  injectUiStyles(doc)
  root.classList.add("knobs-ui")
  if (look.preset) {
    injectUiPreset(doc, look.preset)
    root.dataset.preset = look.preset.name
  }
  if (look.theme) root.dataset.theme = look.theme
  syncFrame(root)
}

/**
 * `--k-frame: flat` (a preset's, or a host's on any ancestor) marks the piece `data-frame`. Read
 * again once the piece is in the page.
 */
export function syncFrame(root: HTMLElement) {
  if (!root.isConnected) return
  const view = root.ownerDocument.defaultView
  const flat = view?.getComputedStyle(root).getPropertyValue("--k-frame").trim() === "flat"
  if (flat) root.dataset.frame = "flat"
  else delete root.dataset.frame
}

/** A look for `restyle`: what the pieces take, and a panel's density. */
export interface RestyleLook extends UiLook {
  readonly density?: "compact" | "default" | "comfortable"
}

/**
 * Changes the look of what's already on screen: every knobs/ui piece and panel inside `target`
 * (the whole document by default) takes `look`'s preset (none for knobs' own), theme and, for
 * panels, density. Panels' tokens glide to the new values; splits and trees measure again. On a
 * document, overlays opened afterwards take it too (`overlayLook`).
 */
export function restyle(target: Document | Element, look: RestyleLook) {
  const doc = target instanceof Element ? target.ownerDocument : target
  injectUiStyles(doc)
  if (look.preset) {
    injectUiPreset(doc, look.preset)
    injectPanelPreset(doc, look.preset)
  }
  const roots = [
    ...(target instanceof Element && target.matches(".knobs-ui,.knobs-panel") ? [target] : []),
    ...target.querySelectorAll<HTMLElement>(".knobs-ui,.knobs-panel"),
  ] as HTMLElement[]
  const set = (el: HTMLElement, name: string, value: string | undefined) => {
    if (value === undefined) el.removeAttribute(name)
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value)
  }
  for (const el of roots) {
    set(el, "data-preset", look.preset?.name)
    if (look.theme) set(el, "data-theme", look.theme)
    if (el.classList.contains("knobs-panel")) {
      if (look.density) set(el, "data-density", look.density)
    }
  }
  for (const el of roots) {
    if (!el.classList.contains("knobs-ui")) continue
    syncFrame(el)
    el.dispatchEvent(new Event("knobs-restyle"))
  }
  if (!(target instanceof Element))
    lookDefaults.current = { preset: look.preset, ...(look.theme ? { theme: look.theme } : {}) }
  notifyLayout(doc)
}

/** The look overlays take unless given their own (`overlayLook`, `restyle(document)`). */
export const lookDefaults: { current: UiLook } = { current: {} }

/** The panel's own preset stylesheet (as `mountPanel({ preset })` adds it), for a restyle. */
function injectPanelPreset(doc: Document, preset: TokenPreset) {
  const content = presetCss(preset)
  const existing = doc.querySelector<HTMLStyleElement>(`style[data-knobs-preset="${preset.name}"]`)
  if (existing) {
    if (existing.textContent !== content) existing.textContent = content
    return
  }
  const style = doc.createElement("style")
  style.dataset.knobsPreset = preset.name
  style.textContent = content
  doc.head.append(style)
}

export const reducedMotion = (win: Window | null) =>
  win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

/**
 * Tells the page's GPU overlay that layout moved (a pane resizing, collapsing or sliding): it
 * reads rects afresh on its next frame, so a panel inside a pane keeps up.
 */
export function notifyLayout(doc: Document) {
  doc.dispatchEvent(new Event("knobs-layout"))
}

/** One rAF loop: `step(dt)` runs each frame while it returns true. */
export function frameLoop(win: Window, step: (dt: number) => boolean) {
  let raf = 0
  let last = 0
  const tick = (now: number) => {
    const dt = last ? Math.min(0.064, (now - last) / 1000) : 1 / 60
    last = now
    raf = step(dt) ? win.requestAnimationFrame(tick) : 0
    if (!raf) last = 0
  }
  return {
    wake() {
      if (!raf) raf = win.requestAnimationFrame(tick)
    },
    get running() {
      return raf !== 0
    },
    stop() {
      if (raf) win.cancelAnimationFrame(raf)
      raf = 0
      last = 0
    },
  }
}

export const svg = (body: string, box = 16) =>
  `<svg viewBox="0 0 ${box} ${box}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const ICONS = {
  caret: svg('<path d="M6 3.5 10.5 8 6 12.5"/>'),
  chevronDown: svg('<path d="M3.5 6 8 10.5 12.5 6"/>'),
  eye: svg(
    '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
  ),
  eyeOff: svg(
    '<path d="M2.5 2.5l11 11M6.6 4.2A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.7 2.2M10.2 11.9A6 6 0 0 1 8 12.5C3.9 12.5 1.5 8 1.5 8a11 11 0 0 1 2.4-2.9"/>',
  ),
  lock: svg(
    '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  ),
  unlock: svg(
    '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1"/>',
  ),
}
