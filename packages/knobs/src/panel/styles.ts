import rolling from "./rolling-css.js"
import { presetCss, type TokenPreset } from "../core/theme.js"
import { GRADIENT_SAMPLES } from "../core/ramp.js"
import { FILL, LEAD, springEasing, TRAIL } from "./motion.js"

// CSS transitions run on the GPU renderer's springs (sampled into linear() easings), so both
// renderers move alike. The trailing edge's time stretches with --k-blur, like trailScale().
const lead = springEasing(LEAD.omega, LEAD.zeta)
const trail = springEasing(TRAIL.omega, TRAIL.zeta)
const fill = springEasing(FILL.omega, FILL.zeta)
const LEAD_T = `${lead.ms}ms var(--k-lead)`
const TRAIL_T = `calc(${trail.ms}ms * (.6 + .4 * clamp(0, var(--k-blur), 2))) var(--k-trail)`
const FILL_T = `calc(var(--k-fill-ms) * 1ms * clamp(var(--k-blur),.1,2)) var(--k-fill-ease)`
// Slider fills run on the spring itself, as the GPU's fill spring does (--k-blur stretches only the
// editor morphs, like the GPU's morph spring).
const SLIDE_T = `calc(var(--k-fill-ms) * 1ms) var(--k-fill-ease)`
const DELAY = "var(--k-delay,0ms)"
/**
 * What DELAY times: a row's turn in a preset's cascade is set on these (see `showValues` in
 * panel.ts) rather than on the row, where the custom property would restyle all of the row.
 */
export const DELAYED =
  ".knobs-fill,.knobs-handle,.knobs-seg-pill,.knobs-toggle,.knobs-toggle i,.knobs-arm,.knobs-curve,.knobs-swatch,.knobs-strip-thumb,.knobs-pad>i,.knobs-ease-handle,.knobs-range-fill,.knobs-range-thumb,.knobs-dial-hand,.knobs-grad,.knobs-grad-mini,.knobs-grad-mini>i,.knobs-grad-stop,.knobs-graph-pt"

// A gradient strip is painted from its samples, each a registered colour (so it transitions):
// a preset blends the strip sample by sample, as the GPU's morph does.
const GRAD_N = GRADIENT_SAMPLES
const gradStops = (at: (i: number) => string) =>
  Array.from({ length: GRAD_N }, (_, i) => `var(--kgrad-${i}) ${at(i)}`).join(",")
const GRAD_STRIP = `linear-gradient(to right,${gradStops((i) => `calc(var(--kg-r) + (100% - var(--kg-r) * 2) * ${Number((i / (GRAD_N - 1)).toFixed(5))})`)})`
const GRAD_MINI = `linear-gradient(to right,${gradStops((i) => `${Number(((i / (GRAD_N - 1)) * 100).toFixed(3))}%`)})`
const GRAD_T = Array.from({ length: GRAD_N }, (_, i) => `--kgrad-${i} ${FILL_T} ${DELAY}`).join(",")
const GRAD_PROPS = Array.from(
  { length: GRAD_N },
  (_, i) => `@property --kgrad-${i}{syntax:"<color>";inherits:false;initial-value:transparent}`,
).join("\n")

// Every token animates when it changes (a theme, a preset, the meta page tuning itself). Each
// public token (--k-pad) drives a typed, non-inherited twin on the panel (--kt-pad) that the browser
// can interpolate and transitions on the panel spring; an untyped alias (--kv-pad) hands the
// in-between value down, so the subtree inherits plain values, which restyle far more cheaply
// than typed ones. The panel's own rules read the aliases; the GPU overlay reads them each frame.
const COLOR_TOKENS = [
  "bg",
  "surface",
  "surface-hi",
  "line",
  "line-hi",
  "text",
  "label",
  "dim",
  "accent",
  "modified",
  "seg-bg",
  "seg-active",
  "toggle-track",
  "toggle-thumb",
  "rim",
  "page",
]
const LENGTH_TOKENS = ["pad", "inset", "row", "gap", "radius", "panel-radius", "font-size"]
const NUMBER_TOKENS = ["label-weight", "blur", "glow", "glass", "glass-tone"]
const ANIMATED = [...COLOR_TOKENS, ...LENGTH_TOKENS, ...NUMBER_TOKENS, "width"]
const TOKEN_TRANSITIONS = ANIMATED.map((t) => `--kt-${t} var(--k-token-t)`).join(",")
const register = (names: readonly string[], syntax: string, initial: string) =>
  names
    .map((n) => `@property --kt-${n}{syntax:"${syntax}";inherits:false;initial-value:${initial}}`)
    .join("\n")
const DRIVERS = `${register(COLOR_TOKENS, "<color>", "transparent")}
${register(LENGTH_TOKENS, "<length>", "0px")}
${register(NUMBER_TOKENS, "<number>", "0")}
${register(["width"], "<length-percentage>", "288px")}
.knobs-panel,.knobs-chip{${ANIMATED.map((t) => `--kt-${t}:var(--k-${t});--kv-${t}:var(--kt-${t})`).join(";")}}`
/** The panel's rules read the gliding aliases; the :root defaults keep the public names. */
const aliased = (css: string) =>
  css.replace(new RegExp(`var\\(--k-(${ANIMATED.join("|")})\\)`, "g"), "var(--kv-$1)")

const lightVars = `
  --k-bg:#f5f5f7;--k-surface:rgba(0,0,0,calc(.05 * var(--k-contrast)));--k-surface-hi:rgba(0,0,0,calc(.095 * var(--k-contrast)));--k-line:rgba(0,0,0,calc(.1 * var(--k-contrast)));--k-line-hi:rgba(0,0,0,calc(.2 * var(--k-contrast)));
  --k-text:rgba(0,0,0,.88);--k-label:rgba(60,60,67,.68);--k-dim:rgba(60,60,67,.5);--k-accent:#1c1c1e;--k-modified:rgba(0,0,0,.42);
  --k-seg-bg:rgba(0,0,0,.065);--k-seg-active:#fff;--k-toggle-track:rgba(0,0,0,.14);--k-toggle-thumb:#fff;--k-shadow:0 10px 32px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);
  --k-rim:rgba(255,255,255,.75);--k-glass-tone:1.08;--k-page:#e6e6eb;--k-group-ink:var(--k-dim);
  color-scheme:light;`

const defaultsCss = `
@property --k-fill{syntax:"<percentage>";inherits:false;initial-value:0%}
@property --k-fill-mix{syntax:"<percentage>";inherits:false;initial-value:20%}
@property --k-readout{syntax:"<length>";inherits:true;initial-value:0px}
@property --kc-value-size{syntax:"<length>";inherits:true;initial-value:11.5px}
@property --kr-lo{syntax:"<number>";inherits:true;initial-value:0}
@property --kr-hi{syntax:"<number>";inherits:true;initial-value:0}
@property --kr-show-lo{syntax:"<number>";inherits:true;initial-value:0}
@property --kr-show-hi{syntax:"<number>";inherits:true;initial-value:0}
${GRAD_PROPS}
:where(:root,:host){
  --k-bg:#1c1c1e;--k-contrast:1;--k-surface:rgba(255,255,255,calc(.055 * var(--k-contrast)));--k-surface-hi:rgba(255,255,255,calc(.11 * var(--k-contrast)));--k-line:rgba(255,255,255,calc(.1 * var(--k-contrast)));--k-line-hi:rgba(255,255,255,calc(.18 * var(--k-contrast)));
  --k-text:rgba(255,255,255,.92);--k-label:rgba(255,255,255,.64);--k-dim:rgba(255,255,255,.42);--k-accent:#fff;--k-modified:rgba(255,255,255,.5);
  --k-seg-bg:rgba(0,0,0,.26);--k-seg-active:var(--k-surface-hi);--k-toggle-track:rgba(255,255,255,.14);--k-toggle-thumb:var(--k-bg);--k-shadow:0 12px 36px rgba(0,0,0,.52),0 1px 2px rgba(0,0,0,.3);
  --k-rim:rgba(255,255,255,.09);--k-glass-tone:.5;--k-page:#101012;
  --k-group-ink:rgba(255,255,255,.48);
  --k-unit:4px;--k-density:1;--k-width:288px;--k-row:round(calc(32px * var(--k-density)),2px);--k-pad:round(calc(10px * var(--k-density)),2px);--k-inset:var(--k-pad);--k-gap:round(calc(var(--k-unit) * var(--k-density)),1px);--k-radius:round(calc(8px * var(--k-density)),2px);--k-panel-radius:calc(var(--k-radius) + var(--k-unit));
  --k-font-size:round(calc(12px * var(--k-density)),.5px);--k-label-weight:500;--k-blur:1;--k-glow:0.5;--k-roll:320;--k-drag-roll:0;--k-cascade:12;--k-glass:0.6;
  --k-font:system-ui,-apple-system,"SF Pro Text",sans-serif;
  --k-mono:"SF Mono",SFMono-Regular,ui-monospace,Menlo,monospace;
  --k-spring:0.24 0.16;--k-ease:cubic-bezier(.2,.8,.2,1);--k-reveal-ease:var(--k-ease);
  --k-font-weight:400;--k-title-weight:600;--k-thumb:#fff;--k-lift:1;--k-frame:card;
  --k-row-gap:0px;--k-hover-in:150;--k-hover-out:150;--k-fill-base:var(--k-surface-hi);--k-fill-rest-mix:20%;--k-fill-hover-mix:var(--k-fill-rest-mix);--k-fill-active-mix:30%;--k-chrome:1;--k-handle:var(--k-accent);--k-handle-inset:0px;--k-handle-rest:0;--k-step-resist:0.25;--k-motion-blur:0;--k-group-transform:uppercase;--k-value-font:var(--k-font);
  --k-lead:${lead.easing};--k-trail:${trail.easing};--k-fill-ease:${fill.easing};--k-fill-ms:${fill.ms};
}
:where(.knobs-panel,.knobs-chip)[data-theme="light"],
:where([data-knobs-theme="light"]) :where(.knobs-panel,.knobs-chip):not([data-theme="dark"]),
:where(:root[data-theme="light"]) :where(.knobs-panel,.knobs-chip)[data-theme="auto"]{${lightVars}}
@media(prefers-color-scheme:light){
  :where(:root:not([data-theme="dark"])) :where(.knobs-panel,.knobs-chip)[data-theme="auto"]{${lightVars}}
}
:where(.knobs-panel)[data-density="compact"]{--k-density:.875;--k-row:28px;--k-gap:3px;--k-radius:6px;--k-panel-radius:calc(var(--k-radius) + var(--k-unit));--k-pad:8px;--k-inset:8px;--k-font-size:11px}
:where(.knobs-panel)[data-density="comfortable"]{--k-density:1.1875;--k-row:38px;--k-gap:6px;--k-radius:10px;--k-panel-radius:calc(var(--k-radius) + var(--k-unit));--k-pad:12px;--k-inset:12px;--k-font-size:13px}
`

const css = `
:where(.knobs-panel,.knobs-chip,.knobs-menu){
  --k-tray-pad:calc(var(--k-unit) * .5);
  --k-section-gap:calc(var(--k-gap) * 2);
  --k-group-gap:calc(var(--k-gap) * 3);
  /* Public sizes a host may set anywhere (:root, the panel, a preset); derived otherwise. */
  --kc-control-h:var(--k-control-h,calc(var(--k-row) - var(--k-unit) * 2));
  --kc-value-size:var(--k-value-size,calc(var(--k-font-size) - .5px));
  --k-action-h:calc(var(--k-row) - var(--k-unit));
  --k-track-h:calc(var(--k-row) - 14px);
  --k-icon-btn:22px;
  --k-icon-size:14px;
  --k-icon-sm:13px;
  --k-radius-md:max(0px,calc(var(--k-radius) - var(--k-tray-pad)));
  --k-radius-sm:max(0px,calc(var(--k-radius) - var(--k-tray-pad) * 2));
  /* Round things (switches, icon buttons, handles, thumbs): capsules, or square with --k-radius 0. */
  --k-round:calc(var(--k-radius) * 999);
  --k-lift-shadow:0 1px 2px rgba(0,0,0,calc(.16 * var(--k-lift)));
  --k-text-title:calc(var(--k-font-size) + 1px);
  --k-text-body:var(--k-font-size);
  --k-text-control:calc(var(--k-font-size) - .5px);
  --k-text-meta:calc(var(--k-font-size) - 1px);
  --k-text-cap:calc(var(--k-font-size) - 2px);
  --k-row-hover:color-mix(in srgb,var(--k-surface) 50%,transparent);
  --k-pill-bg:color-mix(in srgb,var(--k-accent) 18%,var(--k-seg-active));
  --k-pill-border:color-mix(in srgb,var(--k-accent) 32%,transparent);
  --k-fill-rest:color-mix(in srgb,var(--k-accent) var(--k-fill-rest-mix),var(--k-fill-base));
  --k-fill-active:color-mix(in srgb,var(--k-accent) var(--k-fill-active-mix),var(--k-fill-base));
  --k-disabled-opacity:.32;
  --k-unit-gap:.28em;--k-unit-color:var(--k-dim);--k-readout-mark:0;
  --k-group-size:var(--k-text-cap);--k-group-color:var(--k-group-ink);--k-group-inset:var(--k-inset);--k-group-tracking:.04em;--k-group-divider:transparent;--k-group-divider-gap:0px;
  --k-curve-inset:6px;--k-curve-guide:solid;--k-curve-dot:1;
  --k-hint-typed-opacity:.42;
}
/* Inherited text properties that a host's element rules set on its own elements (span{letter-
   spacing}, div{line-height}, *{box-sizing}) come from the panel instead. (0,1,0) and first, so
   every knobs rule wins over it; the host's accessories and custom card contents are its own. */
.knobs-panel *:where(:not(.knobs-accessory,.knobs-accessory *,.knobs-live *)),.knobs-menu *{box-sizing:border-box;color:inherit;letter-spacing:inherit;word-spacing:inherit;line-height:inherit;text-transform:inherit;text-shadow:inherit;font-style:inherit}
/* Hover washes come in at --k-hover-in and leave at --k-hover-out (ms). Set per element, so a
   hovered card doesn't hand its quick entrance to the rows inside it. */
:where(.knobs-panel,.knobs-menu) *{--k-hover-t:calc(var(--k-hover-out) * 1ms)}
:where(.knobs-panel,.knobs-menu) :is(:hover,.knobs-active){--k-hover-t:calc(var(--k-hover-in) * 1ms)}

.knobs-panel,.knobs-chip{
  box-sizing:border-box;font:var(--k-font-weight) var(--k-font-size)/1.35 var(--k-font);color:var(--k-text);text-align:left;color-scheme:dark;
  -webkit-font-smoothing:antialiased;
}
/* Text properties a host page sets on its own elements (letter-spacing, capitals, shadows) stop
   at the panel: it inherits only its tokens. */
.knobs-panel,.knobs-chip,.knobs-menu{letter-spacing:normal;word-spacing:normal;text-transform:none;text-indent:0;text-shadow:none;text-decoration:none;font-style:normal;font-variant:normal;font-feature-settings:normal;font-kerning:auto;white-space:normal;direction:ltr;margin:0;float:none}
:where(.knobs-panel,.knobs-chip) :where(*,*::before,*::after){box-sizing:border-box}
.knobs-panel .rn-slot{box-sizing:content-box}
.knobs-panel [hidden],.knobs-chip[hidden]{display:none!important}
.knobs-mono{font-family:var(--k-mono);font-variant-numeric:tabular-nums}

.knobs-chip{position:fixed;z-index:2147480000;padding:4px 9px;border-radius:999px;cursor:pointer;background:var(--k-bg);border:1px solid var(--k-line);
  color:var(--k-label);font-size:var(--k-text-control);letter-spacing:.01em;box-shadow:0 4px 16px rgba(0,0,0,.35);transition:color .15s,border-color .15s,transform .2s var(--k-ease),opacity .2s,${TOKEN_TRANSITIONS};}
.knobs-chip:hover{color:var(--k-text);border-color:var(--k-line-hi)}
.knobs-chip[data-shown="true"]{transition:color .15s,border-color .15s,opacity .16s var(--k-ease),transform .22s var(--k-ease),visibility 0s,${TOKEN_TRANSITIONS}}
.knobs-chip[data-shown="false"]{opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-2px) scale(.94);transition:opacity .12s ease-in,transform .12s ease-in,visibility 0s .12s,${TOKEN_TRANSITIONS}}
.knobs-chip:focus-visible{outline:none;color:var(--k-text);border-color:var(--k-line-hi)}

/* Tokens glide on the panel spring. While a control is dragged (data-knobs-scrub) they follow it
   step for step instead: the pointer already moves them continuously, and a declared transition
   makes every step restyle the panel twice. */
.knobs-panel,.knobs-chip{--k-token-t:calc(var(--k-fill-ms) * 1ms) var(--k-fill-ease)}
:root[data-knobs-scrub] .knobs-chip{--k-token-t:0s}
:root[data-knobs-scrub] .knobs-panel{transition:none}
@media(prefers-reduced-motion:reduce){.knobs-chip{--k-token-t:0s}.knobs-panel.knobs-panel{transition:none}}
/* Panel material: --k-glass (0 opaque … 1 clearest) thins the surface over a blurred, saturated
   backdrop, toned toward the theme (--k-glass-tone dims it under dark panels) so text keeps its
   contrast; a 1px specular rim catches the top edge. */
.knobs-panel{transition:${TOKEN_TRANSITIONS};position:fixed;z-index:2147480001;width:var(--k-width);max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;padding:var(--k-pad);
  background:color-mix(in srgb,var(--k-bg) calc(100% - var(--k-glass) * 20%),transparent);border:1px solid var(--k-line);border-radius:var(--k-panel-radius);box-shadow:var(--k-shadow),inset 0 1px 0 var(--k-rim);scrollbar-width:thin;
  --k-backdrop:blur(calc(var(--k-glass) * 24px)) saturate(calc(1 + var(--k-glass) * .8)) brightness(calc(1 + (var(--k-glass-tone) - 1) * var(--k-glass)));
  -webkit-backdrop-filter:var(--k-backdrop);backdrop-filter:var(--k-backdrop);
  animation:knobs-in .16s var(--k-ease);}
.knobs-panel[data-restored]{animation:none}
/* Opening from its chip, the panel's chrome rides a separate shape (see morph.ts) while the
   content, laid out at full size, is clipped to it and revealed top first. */
.knobs-panel[data-morphing]{background:transparent;border-color:transparent;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;animation:none}
.knobs-morph{position:fixed;left:0;top:0;z-index:2147480001;pointer-events:none;box-sizing:border-box;--p:0;
  background:color-mix(in srgb,var(--k-bg) calc(100% - var(--k-glass) * 20% * var(--p)),transparent);border:1px solid var(--k-line);
  box-shadow:inset 0 1px 0 color-mix(in srgb,var(--k-rim) calc(var(--p) * 100%),transparent);
  --k-backdrop:blur(calc(var(--k-glass) * 24px)) saturate(calc(1 + var(--k-glass) * .8)) brightness(calc(1 + (var(--k-glass-tone) - 1) * var(--k-glass)));
  -webkit-backdrop-filter:var(--k-backdrop);backdrop-filter:var(--k-backdrop)}
.knobs-morph::before,.knobs-morph::after{content:"";position:absolute;inset:-1px;border-radius:inherit;pointer-events:none}
.knobs-morph::before{box-shadow:0 4px 16px rgba(0,0,0,.35);opacity:calc(1 - var(--p))}
.knobs-morph::after{box-shadow:var(--k-shadow);opacity:var(--p)}
/* Meanwhile the chip is just its label, fading on the shape. */
.knobs-chip.knobs-chip[data-morph]{visibility:visible;pointer-events:auto;transform:none;transition:none;background:transparent;border-color:transparent;box-shadow:none}
.knobs-panel.knobs-inline{position:relative;z-index:auto;left:auto!important;top:auto!important;max-width:100%;max-height:none;box-shadow:inset 0 1px 0 color-mix(in srgb,var(--k-rim) calc(var(--k-chrome) * 100%),transparent);animation:none;
  /* --k-chrome 0: an embedded panel sheds its card (background, border, rim) for the host's column. */
  background:color-mix(in srgb,color-mix(in srgb,var(--k-bg) calc(100% - var(--k-glass) * 20%),transparent) calc(var(--k-chrome) * 100%),transparent);border-color:color-mix(in srgb,var(--k-line) calc(var(--k-chrome) * 100%),transparent);
  --k-backdrop:blur(calc(var(--k-glass) * var(--k-chrome) * 24px)) saturate(calc(1 + var(--k-glass) * var(--k-chrome) * .8)) brightness(calc(1 + (var(--k-glass-tone) - 1) * var(--k-glass) * var(--k-chrome)))}
@keyframes knobs-in{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.knobs-panel{animation:none}.knobs-panel *{transition:none!important}}

/* A scoped reset, (0,1,1): above a host's element rules (button{...}, button:hover{...},
   input[type=text]{...}) and below every knobs rule that styles these elements, which are all
   (0,1,1) or more and come later. */
:is(.knobs-panel,.knobs-menu) :is(button,input,select,textarea):where(:not(.knobs-accessory *)){all:revert;box-sizing:border-box;font:inherit;color:inherit;letter-spacing:inherit;text-transform:inherit;text-shadow:none;
  background:var(--k-surface);border:0;border-radius:var(--k-radius);min-width:0;box-shadow:none;outline:none}
:is(.knobs-panel,.knobs-menu) :is(header,strong,p,kbd,aside,mark):where(:not(.knobs-accessory *)){all:revert;box-sizing:border-box;margin:0;padding:0;font:inherit;color:inherit;letter-spacing:inherit;text-transform:inherit}
.knobs-panel .knobs-icon>path{fill:currentColor}
:is(.knobs-panel,.knobs-menu) :is(:focus,:focus-visible):where(:not(.knobs-accessory *)){outline:none}

/* Header */
.knobs-panel header{display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:grab;touch-action:none;padding:0 var(--k-inset) var(--k-section-gap);min-height:var(--k-icon-btn)}
.knobs-panel.knobs-inline header,.knobs-panel.knobs-inline header:active{cursor:default}
.knobs-panel header:active{cursor:grabbing}
.knobs-panel header strong{flex:1;min-width:0;font-weight:var(--k-title-weight);font-size:var(--k-text-title);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .2s var(--k-ease)}
/* Holding \\ shows the values from before the last change; the title dims meanwhile. */
.knobs-panel[data-comparing] header strong{opacity:.4}
.knobs-head-actions{display:flex;align-items:center;margin-right:calc((var(--k-icon-size) - var(--k-icon-btn)) / 2)}
.knobs-head-split{margin-left:calc(var(--k-unit) * 1.5)}
.knobs-icon{width:var(--k-icon-size);height:var(--k-icon-size);display:block;flex:none}
.knobs-die-icon{position:relative;display:block;width:var(--k-icon-size);height:var(--k-icon-size);flex:none}
.knobs-die-icon>canvas{position:absolute;margin:0}
.knobs-panel[data-gpu-active="true"] .knobs-die-icon>canvas{visibility:hidden}
.knobs-panel header button{width:var(--k-icon-btn);height:var(--k-icon-btn);padding:0;display:inline-flex;align-items:center;justify-content:center;color:var(--k-label);background:transparent;border-radius:var(--k-round);cursor:pointer;font-size:12px;line-height:1;transition:background .15s,color .15s,opacity .15s}
.knobs-panel header button:is(:hover:not([disabled]),:focus-visible),.knobs-panel header button[aria-expanded="true"]{background:var(--k-surface-hi);color:var(--k-text)}
.knobs-panel header button[disabled]{opacity:var(--k-disabled-opacity);cursor:default}

/* Shortcuts Popover */
.knobs-popover{margin:0 0 var(--k-section-gap);padding:var(--k-section-gap) var(--k-inset);background:var(--k-surface-hi);border:1px solid var(--k-line);border-radius:var(--k-radius);font-size:var(--k-text-meta)}
.knobs-popover-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:baseline}
.knobs-popover-grid kbd{font:var(--k-text-cap)/1 var(--k-mono);font-variant-numeric:tabular-nums;color:var(--k-text);background:var(--k-seg-bg);padding:2px 5px;border-radius:var(--k-radius-sm);justify-self:start;white-space:nowrap}
.knobs-popover-grid span{color:var(--k-label)}

/* Custom Preset Strip */
.knobs-presets{position:relative;display:flex;align-items:flex-start;gap:var(--k-tray-pad);margin:0 0 var(--k-section-gap);padding:var(--k-tray-pad);background:var(--k-seg-bg);border-radius:var(--k-radius);user-select:none;touch-action:none}
.knobs-presets-track{position:relative;flex:1;min-width:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,var(--k-preset-min,58px)),1fr));align-items:stretch;gap:var(--k-tray-pad)}
/* The selected pill is placed by its edges: the edge facing the move leads, the other trails. */
.knobs-presets-pill{position:absolute;top:0;left:0;background:var(--k-pill-bg);border:1px solid var(--k-pill-border);border-radius:var(--k-radius-md);box-shadow:var(--k-lift-shadow),0 0 calc(var(--k-glow) * 10px) color-mix(in srgb,var(--k-accent) 24%,transparent);pointer-events:none;
  transition:left ${TRAIL_T},right ${LEAD_T},top ${LEAD_T},opacity .15s,scale .15s}
.knobs-presets-pill[data-dir="left"]{transition:left ${LEAD_T},right ${TRAIL_T},top ${LEAD_T},opacity .15s,scale .15s}
.knobs-panel .knobs-preset-chip{position:relative;z-index:1;height:var(--kc-control-h);min-height:20px;padding:0 6px;font-size:var(--k-text-control);font-weight:var(--k-label-weight);color:var(--k-label);background:transparent!important;border-radius:var(--k-radius-md);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .15s}
.knobs-panel .knobs-preset-chip:hover{color:var(--k-text)}
.knobs-panel .knobs-preset-chip[aria-checked="true"]{color:var(--k-text);font-weight:var(--k-title-weight)}
.knobs-panel .knobs-preset-save{flex:none;width:calc((var(--k-inset) - var(--k-tray-pad)) * 2 + 8px);padding:0!important;color:var(--k-dim)!important;font-weight:400!important;font-size:var(--k-text-title)!important}
.knobs-panel .knobs-preset-save:hover{color:var(--k-text)!important}

/* Group headers */
.knobs-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:20px;margin:var(--k-group-gap) 0 var(--k-gap);padding:0 var(--k-group-inset);color:var(--k-group-color);font-size:var(--k-group-size);font-weight:var(--k-title-weight);letter-spacing:var(--k-group-tracking);text-transform:var(--k-group-transform)}
.knobs-panel:not(.knobs-page) .knobs-group-head:not(:first-child){border-top:1px solid var(--k-group-divider);padding-top:var(--k-group-divider-gap)}
.knobs-group-head:first-child{margin-top:0}
.knobs-group-head>span:last-child{display:flex;align-items:center;gap:var(--k-tray-pad);margin-right:calc((var(--k-icon-sm) - 20px) / 2)}
.knobs-group-head button{height:20px;padding:0 6px;font-size:var(--k-text-meta);font-weight:500;letter-spacing:0;text-transform:none;color:var(--k-label);background:transparent;border-radius:var(--k-radius-sm);cursor:pointer}
.knobs-group-head button:is(:hover:not([disabled]),:focus-visible){background:var(--k-surface-hi);color:var(--k-text)}
.knobs-group-head .knobs-group-reset{width:20px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--k-round);
  transition:opacity .18s var(--k-ease),transform .3s cubic-bezier(.34,1.45,.64,1),background .15s,color .15s,visibility 0s}
.knobs-group-head :is(.knobs-icon,.knobs-die-icon){width:var(--k-icon-sm);height:var(--k-icon-sm)}
.knobs-group-reset[data-shown="false"]{opacity:0;visibility:hidden;transform:scale(.55);transition:opacity .14s ease-in,transform .14s ease-in,visibility 0s .14s}
.knobs-group-head .knobs-group-die{width:20px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--k-round);color:var(--k-dim)}
.knobs-group-head .knobs-group-die[disabled]{opacity:var(--k-disabled-opacity);cursor:default}
.knobs-panel .knobs-group-head button:where(:not(.knobs-group-reset)){transition:background .15s,color .15s,opacity .2s,transform .12s}

/* Grouped cards: rows share one surface, split by hairlines */
.knobs-card{position:relative;margin-bottom:var(--k-section-gap);border-radius:var(--k-radius);background:var(--k-surface);overflow:hidden}
.knobs-card:last-child{margin-bottom:0}
.knobs-card>*{position:relative;min-height:var(--k-row);transition:background var(--k-hover-t),opacity .2s}
.knobs-card>:hover,.knobs-card>.knobs-active{background:var(--k-row-hover)}
.knobs-card>*+*::before{content:"";position:absolute;z-index:1;left:0;right:0;top:0;height:1px;transform:scaleY(.5);transform-origin:top;background:var(--k-line);pointer-events:none;transition:opacity .15s}
.knobs-card>:is(:hover:not(.knobs-x),.knobs-x:has(>.knobs-x-head:is(:hover,:focus-visible)),:has(:focus-visible):not(.knobs-x),.knobs-active)::before,.knobs-card>:is(:hover:not(.knobs-x),.knobs-x:has(>.knobs-x-head:is(:hover,:focus-visible)),:has(:focus-visible):not(.knobs-x),.knobs-active)+*::before{opacity:0}
.knobs-card>::after{content:"";position:absolute;z-index:2;inset:0;background:var(--k-surface);opacity:0;pointer-events:none;transition:opacity .15s,box-shadow .15s}
.knobs-card>:has(:focus-visible)::after{opacity:1}
.knobs-panel .knobs-slider{height:var(--k-row);contain:layout style}
.knobs-panel .knobs-row:where(:not(.knobs-slider,.knobs-x,.knobs-spring)){display:flex;align-items:center;justify-content:space-between;gap:8px;height:var(--k-row);padding:0 var(--k-inset);contain:layout style}
.knobs-panel .knobs-row>span:first-child{color:var(--k-label);font-weight:var(--k-label-weight);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knobs-row>span:first-child::after{content:"";display:inline-block;width:4px;height:4px;margin-left:5px;border-radius:50%;background:var(--k-modified);vertical-align:middle;opacity:0;transform:scale(.4);transition:opacity .16s ease-out,transform .28s cubic-bezier(.34,1.5,.64,1)}
.knobs-modified.knobs-row>span:first-child::after{opacity:.95;transform:none}
/* A locked row's lock sits just left of its readout (or its control), where the eye reads the value.
   Its room opens at once (it's right-aligned, so nothing beside it moves); the icon fades and
   scales in place. */
.knobs-lock{position:relative;flex:none;order:-1;display:inline-block;width:0;height:10px;color:var(--k-dim)}
.knobs-lock>svg{position:absolute;right:0;top:0;width:10px;height:10px;opacity:0;transform:scale(.5);transition:opacity .14s ease-in,transform .14s ease-in}
.knobs-locked .knobs-lock{width:10px}
.knobs-value>.knobs-lock>svg{right:6px}
.knobs-locked .knobs-value>.knobs-lock{width:16px}
.knobs-row>.knobs-lock{order:0;margin-left:auto}
.knobs-locked .knobs-lock>svg{opacity:1;transform:none;transition:opacity .18s var(--k-ease),transform .3s cubic-bezier(.34,1.45,.64,1)}
/* On iPhones a switch's tap lands on a label for a hidden native switch: iOS's system tick. */
.knobs-tap-tick{position:absolute;inset:0;border-radius:inherit;-webkit-tap-highlight-color:transparent}

/* Slider: one flat accent-tinted fill, a hairline handle on its edge and centerline scale ticks.
   The ticks and handle fade where the label and readout sit (--k-text-mask). The fill and handle
   are moved by transforms, never layout or background sizes, which snap to whole pixels: the
   edge and the handle's centre both land on the value's exact sub-pixel position, as on the GPU. */
.knobs-track{position:absolute;left:0;right:0;top:0;height:var(--k-row);overflow:hidden;contain:layout style paint;cursor:ew-resize;user-select:none;touch-action:none;transition:--k-readout .25s var(--k-ease);
  --k-text-mask:linear-gradient(to right,transparent calc(var(--k-label-end,0px) + 4px),#000 calc(var(--k-label-end,0px) + 12px),#000 calc(100% - var(--k-inset) - var(--k-readout) - 12px),transparent calc(100% - var(--k-inset) - var(--k-readout) - 4px))}
.knobs-panel .knobs-track:focus-visible{outline:none;box-shadow:none}
.knobs-marks,.knobs-handle-zone{position:absolute;inset:0;pointer-events:none;-webkit-mask:var(--k-text-mask);mask:var(--k-text-mask)}
.knobs-marks>i{position:absolute;top:50%;width:1px;height:7px;border-radius:999px;transform:translate(-50%,-50%);background:transparent;transition:background .2s}
.knobs-fill{position:absolute;inset:0;pointer-events:none;--k-fill-mix:var(--k-fill-rest-mix);--k-fill-tint:color-mix(in srgb,var(--k-accent) var(--k-fill-mix),var(--k-fill-base));
  background:var(--k-fill-tint);transform:translateX(calc(var(--k-fill) - 100%));transition:--k-fill-mix .15s}
.knobs-slider:hover .knobs-fill{--k-fill-mix:var(--k-fill-hover-mix)}
.knobs-active .knobs-fill,.knobs-active:hover .knobs-fill{--k-fill-mix:var(--k-fill-active-mix)}
/* --k-motion-blur: a moving edge smears into a ramp as wide as its speed (--k-smear, px), as a
   horizontal box blur would; the handle widens and thins to match. */
.knobs-smear .knobs-fill{background:linear-gradient(to left,transparent,var(--k-fill-tint) calc(var(--k-smear) * 1px));transform:translateX(calc(var(--k-fill) - 100% + var(--k-smear) * .5px))}
.knobs-smear .knobs-handle::before{scale:calc(1 + var(--k-smear) / 3) 1;opacity:calc(3 / (3 + var(--k-smear)))}
.knobs-animate .knobs-fill,.knobs-animate .knobs-handle{transition:--k-fill ${SLIDE_T} ${DELAY},--k-fill-mix .15s,opacity .15s}
.knobs-settle .knobs-fill,.knobs-settle .knobs-handle{transition:--k-fill .1s cubic-bezier(.25,1,.5,1),--k-fill-mix .12s,opacity .15s}
.knobs-marks>.knobs-notch{width:1.5px;height:9px;background:var(--k-accent);opacity:0;transition:opacity .2s,height .15s var(--k-ease)}
.knobs-slider:is(:hover,.knobs-active,:has(:focus-visible)) .knobs-notch{opacity:.38}
.knobs-slider.knobs-modified:is(:hover,.knobs-active,:has(:focus-visible)) .knobs-notch{opacity:.55}
.knobs-magnet .knobs-notch{opacity:.95;height:11px}
/* The handle is a full-width layer moved by the fill (translate's % is its own width, the track's). */
.knobs-handle{position:absolute;inset:0;pointer-events:none;transform:translateX(var(--k-fill));opacity:var(--k-handle-rest);transition:opacity .15s}
.knobs-handle::before{content:"";position:absolute;left:0;top:50%;width:3px;height:calc(var(--k-row) - 12px);margin-top:calc(6px - var(--k-row) / 2);translate:calc(-50% - var(--k-handle-inset)) 0;border-radius:var(--k-round);background:var(--k-handle);
  box-shadow:0 0 calc(var(--k-glow) * 8px) color-mix(in srgb,var(--k-accent) 60%,transparent);transform:scaleX(calc(.25 + .75 * min(1, var(--k-handle-rest) * 4)));transition:transform .22s var(--k-ease)}
.knobs-slider:hover .knobs-handle,.knobs-track:focus-visible .knobs-handle{opacity:max(.65,var(--k-handle-rest))}
.knobs-active .knobs-handle{opacity:.95}
.knobs-slider:is(:hover,.knobs-active) .knobs-handle::before,.knobs-track:focus-visible .knobs-handle::before{transform:scaleX(1)}
.knobs-slider:is(:hover,:has(:focus-visible)) .knobs-marks>i:not(.knobs-notch){background:color-mix(in srgb,var(--k-accent) 15%,transparent)}
.knobs-active .knobs-marks>i:not(.knobs-notch){background:color-mix(in srgb,var(--k-accent) 22%,transparent)}
.knobs-digits{display:inline-flex;align-items:center;line-height:2.1;margin-block:-.375em;--rn-edge-fade:.5em}
.knobs-unit{color:var(--k-unit-color);margin-left:var(--k-unit-gap)}
/* --k-readout-mark (0 or 1): a modified value takes the modified colour behind a small dot. */
.knobs-value::before{content:"";flex:none;width:calc(5px * var(--k-readout-mark));height:5px;margin-right:calc(6px * var(--k-readout-mark));border-radius:50%;background:var(--k-modified);opacity:0;transform:scale(0);transition:opacity .16s ease,transform .3s cubic-bezier(.34,1.56,.64,1)}
:is(.knobs-slider,.knobs-sub).knobs-modified .knobs-value{color:color-mix(in srgb,var(--k-modified) calc(var(--k-readout-mark) * 100%),var(--k-label))}
:is(.knobs-slider,.knobs-sub).knobs-modified:is(.knobs-active,:has(.knobs-track:focus-visible)) .knobs-value{color:color-mix(in srgb,var(--k-modified) calc(var(--k-readout-mark) * 100%),var(--k-text))}
:is(.knobs-slider,.knobs-sub).knobs-modified .knobs-value::before{opacity:var(--k-readout-mark);transform:none}
.knobs-label{position:absolute;left:var(--k-inset);top:50%;transform:translateY(-50%);max-width:calc(100% - var(--k-inset) * 2 - var(--k-readout,48px) - 8px - var(--k-accessory-w,0px));overflow:hidden;text-overflow:ellipsis;color:var(--k-label);font-weight:var(--k-label-weight);pointer-events:none;white-space:nowrap}
.knobs-panel .knobs-value{position:absolute;right:var(--k-inset);top:50%;transform:translateY(-50%);transform-origin:100% 0;display:inline-flex;align-items:center;justify-content:flex-end;gap:0;padding:4px 0 4px 8px;background:transparent!important;border-radius:0!important;line-height:1.35;overflow:visible;white-space:nowrap;
  color:var(--k-label);font-family:var(--k-value-font);font-variant-numeric:tabular-nums;font-feature-settings:"tnum";font-size:var(--kc-value-size);
  border-bottom:1px solid transparent;cursor:text;transition:color .15s,border-color .15s .4s}
.knobs-value:hover{border-bottom-color:var(--k-label)}
.knobs-active .knobs-value,.knobs-track:focus-visible .knobs-value{color:var(--k-text)}
.knobs-panel .knobs-number{position:absolute;right:var(--k-inset);top:50%;transform:translateY(-50%);z-index:2;width:6.5ch;padding:1px 4px;text-align:right;background:var(--k-bg)!important;
  border-radius:var(--k-radius-sm)!important;border-bottom:1px solid var(--k-text)!important;color:var(--k-text);font-family:var(--k-value-font);font-variant-numeric:tabular-nums;font-size:var(--kc-value-size);appearance:textfield}
.knobs-number::-webkit-inner-spin-button,.knobs-number::-webkit-outer-spin-button{appearance:none}
.knobs-number:focus-visible{outline:none;box-shadow:none}

/* Segmented choice */
.knobs-seg{position:relative;display:flex;flex-wrap:nowrap;align-items:center;justify-content:flex-end;gap:var(--k-tray-pad);height:var(--kc-control-h);padding:var(--k-tray-pad);max-width:76%;background:var(--k-seg-bg);border-radius:var(--k-radius-md)}
.knobs-seg-pill{position:absolute;top:var(--k-tray-pad);bottom:var(--k-tray-pad);left:0;right:100%;border-radius:var(--k-radius-sm);background:var(--k-pill-bg);box-shadow:var(--k-lift-shadow);pointer-events:none;
  transition:left ${TRAIL_T} ${DELAY},right ${LEAD_T} ${DELAY},opacity .15s}
.knobs-seg-pill[data-dir="left"]{transition:left ${LEAD_T} ${DELAY},right ${TRAIL_T} ${DELAY},opacity .15s}
.knobs-seg-pill[data-off]{opacity:0}
/* --k-motion-blur: a gliding pill widens by its smear and fades over it at each end (see smear.ts). */
.knobs-smear-pill{margin-inline:calc(var(--k-smear) * -.5px);
  -webkit-mask:linear-gradient(to right,transparent,#000 calc(var(--k-smear) * 1px),#000 calc(100% - var(--k-smear) * 1px),transparent);
  mask:linear-gradient(to right,transparent,#000 calc(var(--k-smear) * 1px),#000 calc(100% - var(--k-smear) * 1px),transparent)}
.knobs-seg button{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;height:100%;padding:0 7px;font-size:var(--k-text-control);font-weight:var(--k-label-weight);white-space:nowrap;color:var(--k-label);background:transparent;cursor:pointer;border-radius:var(--k-radius-sm);transition:background .15s,color .15s}
.knobs-seg button:is(:hover,:focus-visible){color:var(--k-text)}
.knobs-seg button[aria-checked=true]{color:var(--k-text)}

/* Long choices: a compact button that drops down a menu */
.knobs-panel .knobs-select{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:62%;height:var(--kc-control-h);padding:0 6px 0 10px;background:var(--k-seg-bg);border-radius:var(--k-radius-md);color:var(--k-label);font-size:var(--k-text-control);font-weight:var(--k-label-weight);cursor:pointer;transition:background var(--k-hover-t),color var(--k-hover-t)}
.knobs-panel .knobs-select:is(:hover,:focus-visible,[aria-expanded="true"]){background:var(--k-surface-hi);color:var(--k-text)}
.knobs-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knobs-panel .knobs-row-full .knobs-select{flex:1;max-width:none;justify-content:space-between}
.knobs-select .knobs-icon{width:calc(var(--k-icon-sm) - 2px);height:calc(var(--k-icon-sm) - 2px);color:var(--k-dim)}
.knobs-menu[data-checks] .knobs-menu-item{padding-left:24px}
.knobs-menu-item[aria-checked="true"]::before{content:"";position:absolute;left:9px;top:50%;width:7px;height:4px;margin-top:-3.5px;border:solid currentColor;border-width:0 0 1.5px 1.5px;transform:rotate(-45deg)}

/* Action rows: a button the width of the row */
.knobs-panel .knobs-action-row{padding:0}
.knobs-panel .knobs-action{width:100%;height:100%;padding:0 var(--k-inset);text-align:left;background:transparent;border-radius:0;color:var(--k-text);font-size:calc(var(--k-text-control) + .5px);font-weight:var(--k-label-weight);cursor:pointer;transition:color var(--k-hover-t)}
.knobs-panel .knobs-action:is(:hover,:focus-visible){color:var(--k-accent)}
.knobs-panel .knobs-action:active{opacity:.7}

/* Switch */
/* The thumb spans two edges: the leading one springs ahead and the other follows, so it stretches
   into a capsule as it travels; a press widens it toward where it will go. */
.knobs-panel .knobs-toggle{position:relative;flex:none;width:32px;height:18px;padding:0;background:var(--k-toggle-track);border-radius:var(--k-round);cursor:pointer;transition:background .2s ${DELAY},box-shadow .2s ${DELAY}}
.knobs-panel .knobs-toggle[aria-checked=true]{background:var(--k-accent);box-shadow:0 0 calc(var(--k-glow) * 10px) color-mix(in srgb,var(--k-accent) 42%,transparent)}
.knobs-toggle i{position:absolute;top:var(--k-tray-pad);bottom:var(--k-tray-pad);left:var(--k-tray-pad);right:16px;border-radius:var(--k-round);background:var(--k-thumb);box-shadow:0 1px 2px rgba(0,0,0,calc(.25 * var(--k-lift)));transition:left ${LEAD_T} ${DELAY},right ${TRAIL_T} ${DELAY},background .2s ${DELAY}}
.knobs-toggle[aria-checked=true] i{left:16px;right:var(--k-tray-pad);background:var(--k-toggle-thumb);transition:left ${TRAIL_T} ${DELAY},right ${LEAD_T} ${DELAY},background .2s ${DELAY}}
.knobs-toggle:active i{right:12px;transition:right ${LEAD_T},background .2s}
.knobs-toggle[aria-checked=true]:active i{left:12px;right:var(--k-tray-pad);transition:left ${LEAD_T},background .2s}

/* Compound rows: a spring's two sliders beside its curve; disclosure rows with an editor body */
.knobs-card>:is(.knobs-spring,.knobs-x):hover{background:transparent}
.knobs-card>:is(.knobs-spring,.knobs-x):has(:focus-visible)::after{opacity:0}
/* Selected rows: one accent-tinted wash, joined across neighbours. */
.knobs-panel .knobs-card>.knobs-selected{background:color-mix(in srgb,var(--k-accent) 10%,transparent)}
.knobs-card>.knobs-selected+.knobs-selected::before{opacity:0}
.knobs-spring{display:flex}
.knobs-spring-tracks{position:relative;flex:1;min-width:0;overflow:hidden}
.knobs-sub{position:relative;transition:background var(--k-hover-t)}
.knobs-sub:hover,.knobs-sub.knobs-active,.knobs-x-head:hover{background:var(--k-row-hover)}
.knobs-sub+.knobs-sub::before{content:"";position:absolute;z-index:1;left:0;right:0;top:0;height:1px;transform:scaleY(.5);transform-origin:top;background:var(--k-line);pointer-events:none;transition:opacity .15s}
.knobs-sub:is(:hover,:has(:focus-visible),.knobs-active)::before,.knobs-sub:is(:hover,:has(:focus-visible),.knobs-active)+.knobs-sub::before{opacity:0}
:is(.knobs-sub,.knobs-x-head)::after{content:"";position:absolute;z-index:2;inset:0;background:var(--k-surface);opacity:0;pointer-events:none;transition:opacity .15s}
:is(.knobs-sub:has(:focus-visible),.knobs-x-head:focus-visible)::after{opacity:1}
.knobs-spring-curve{position:relative;flex:none;width:calc(var(--k-row) * 2.5);margin:var(--k-gap) var(--k-inset) var(--k-gap) 0;border-radius:var(--k-radius-sm);background:var(--k-seg-bg);pointer-events:none}
.knobs-panel :is(.knobs-spring-curve,.knobs-ease)>svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.knobs-guide{fill:none;stroke:var(--k-line);stroke-width:1}
.knobs-arm{fill:none;stroke:var(--k-dim);stroke-width:1;transition:d ${FILL_T} ${DELAY}}
.knobs-curve{fill:none;stroke:var(--k-accent);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;transition:d ${FILL_T} ${DELAY}}
.knobs-spring-dot{position:absolute;left:0;top:0;width:5px;height:5px;margin:-2.5px;border-radius:50%;background:var(--k-accent);box-shadow:0 0 calc(var(--k-glow) * 8px) var(--k-accent);opacity:0;scale:var(--k-curve-dot)}
.knobs-guide-dashed{stroke:var(--k-line-hi)}
.knobs-spring:has(.knobs-active) .knobs-curve{transition:none}

.knobs-x-head{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;height:var(--k-row);padding:0 var(--k-inset);cursor:pointer;user-select:none;transition:background var(--k-hover-t)}
.knobs-panel .knobs-x-head:focus-visible{outline:none;box-shadow:none}
.knobs-x-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--k-label);font-weight:var(--k-label-weight)}
.knobs-x-label::after{content:"";display:inline-block;width:4px;height:4px;margin-left:5px;border-radius:50%;background:var(--k-modified);vertical-align:middle;opacity:0;transform:scale(.4);transition:opacity .16s ease-out,transform .28s cubic-bezier(.34,1.5,.64,1)}
.knobs-modified .knobs-x-label::after{opacity:.95;transform:none}
.knobs-x-sum{display:flex;align-items:center;gap:8px;min-width:0}
.knobs-x-read,.knobs-strip-read{color:var(--k-label);font-size:var(--kc-value-size);font-variant-numeric:tabular-nums;font-feature-settings:"tnum";white-space:nowrap}
.knobs-caret{width:10px;height:10px;flex:none;margin-right:-2.5px;color:var(--k-dim);transition:transform ${LEAD_T},color .15s}
.knobs-caret path{fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.knobs-x-head:hover .knobs-caret{color:var(--k-label)}
.knobs-x-head[aria-expanded="true"] .knobs-caret{transform:rotate(90deg)}
.knobs-swatch{flex:none;width:var(--k-track-h);height:var(--k-track-h);border-radius:var(--k-radius-sm);box-shadow:inset 0 0 0 1px var(--k-line);transition:background-color .2s ${DELAY}}
.knobs-x-body{padding:0 var(--k-inset) var(--k-inset)}
.knobs-strips{display:grid}
.knobs-strip{display:grid;grid-template-columns:10px 1fr 36px;align-items:center;gap:8px;height:var(--k-action-h)}
.knobs-strip-label{color:var(--k-dim);font-size:var(--k-text-cap);font-weight:var(--k-title-weight);text-align:left}
.knobs-strip-read{text-align:right}
.knobs-strip-track{position:relative;height:var(--k-track-h);border-radius:var(--k-round);box-shadow:inset 0 0 0 1px var(--k-line);cursor:ew-resize;touch-action:none}
.knobs-strip-thumb{position:absolute;top:50%;left:0;width:calc(var(--k-row) - 12px);height:calc(var(--k-row) - 12px);margin:calc(6px - var(--k-row) / 2);border-radius:var(--k-round);box-shadow:0 0 0 2px var(--k-thumb),0 1px 4px rgba(0,0,0,calc(.4 * var(--k-lift)));pointer-events:none;transition:left ${FILL_T} ${DELAY},background-color .2s ${DELAY},scale .2s var(--k-ease)}
.knobs-strip.knobs-active .knobs-strip-thumb{transition:background-color .2s,scale .2s var(--k-ease)}
.knobs-strip:is(.knobs-active,:has(:focus-visible)) .knobs-strip-thumb{scale:1.1}
.knobs-pad,.knobs-ease{position:relative;border-radius:var(--k-radius-md);background:var(--k-seg-bg);touch-action:none}
.knobs-pad{height:calc(var(--k-row) * 4);cursor:crosshair;overflow:hidden}
.knobs-pad>i{position:absolute;left:0;top:0;pointer-events:none;transition:translate ${FILL_T} ${DELAY},scale .2s var(--k-ease)}
.knobs-pad-v{bottom:0;width:1px;margin-left:-.5px;background:var(--k-line)}
.knobs-pad-h{right:0;height:1px;margin-top:-.5px;background:var(--k-line)}
.knobs-pad .knobs-pad-home{width:7px;height:7px;margin:-3.5px;border-radius:50%;box-shadow:inset 0 0 0 1px var(--k-dim);transition:none}
.knobs-pad-puck{width:12px;height:12px;margin:-6px;border-radius:var(--k-round);background:var(--k-accent);box-shadow:0 0 0 1.5px var(--k-bg),0 0 calc(var(--k-glow) * 10px) color-mix(in srgb,var(--k-accent) 50%,transparent)}
.knobs-pad.knobs-active>i{transition:scale .2s var(--k-ease)}
.knobs-pad:is(.knobs-active,:focus-visible) .knobs-pad-puck{scale:1.2}
.knobs-ease{height:calc(var(--k-row) * 4.5)}
.knobs-panel .knobs-ease-handle{position:absolute;left:0;top:0;width:12px;height:12px;margin:-6px;padding:0;border-radius:var(--k-round);background:var(--k-bg);box-shadow:inset 0 0 0 2px var(--k-accent),0 1px 3px rgba(0,0,0,calc(.3 * var(--k-lift)));cursor:grab;touch-action:none;transition:translate ${FILL_T} ${DELAY},scale .2s var(--k-ease)}
.knobs-ease-handle::before{content:"";position:absolute;inset:-8px;border-radius:50%}
.knobs-ease.knobs-active :is(.knobs-curve,.knobs-arm){transition:none}
.knobs-ease.knobs-active .knobs-ease-handle{transition:scale .2s var(--k-ease)}
.knobs-ease-handle:active{scale:1.2;cursor:grabbing}
.knobs-ease-handle:focus-visible{scale:1.2}
.knobs-ease-mini{flex:none;width:30px;height:var(--k-track-h);overflow:visible}
.knobs-ease-chips{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--k-tray-pad);margin-top:6px;padding:var(--k-tray-pad);border-radius:var(--k-radius-md);background:var(--k-seg-bg)}
.knobs-panel .knobs-ease-chip{min-width:0;height:calc(var(--k-row) - 10px);padding:0 6px;font-size:var(--k-text-control);font-weight:var(--k-label-weight);color:var(--k-label);background:transparent;border-radius:var(--k-radius-sm);cursor:pointer;white-space:nowrap;transition:background .15s,color .15s,box-shadow .15s}
.knobs-panel .knobs-ease-chip:is(:hover,:focus-visible){color:var(--k-text)}
.knobs-panel .knobs-ease-chip[aria-checked="true"]{color:var(--k-text);background:var(--k-pill-bg);box-shadow:var(--k-lift-shadow)}

/* Gradients: a swatch strip with stop ticks in the head; a wide strip with a handle per stop (the
   selected one full size), then that stop's colour strips. The ramp runs a handle's radius in from
   each end, as the colour strips' do. */
.knobs-grad-mini{position:relative;flex:none;width:calc(var(--k-row) * 2.5);height:var(--k-track-h);border-radius:var(--k-radius-sm);box-shadow:inset 0 0 0 1px var(--k-line);background:${GRAD_MINI};transition:${GRAD_T}}
.knobs-grad-mini>i{position:absolute;top:calc(100% + 2px);left:0;width:1px;height:3px;margin-left:-.5px;background:var(--k-dim);transition:left ${FILL_T} ${DELAY},opacity .15s}
.knobs-grad{--kg-h:calc(var(--k-row) - 6px);--kg-r:calc(var(--kg-h) / 2);--kg-pin:round(calc(var(--kg-h) * .42),1px);position:relative;height:var(--kg-h);margin:2px 0 var(--k-gap);border-radius:var(--k-round);box-shadow:inset 0 0 0 1px var(--k-line);background:${GRAD_STRIP};cursor:pointer;touch-action:none;user-select:none;outline:none;transition:${GRAD_T}}
.knobs-grad-stop{position:absolute;top:50%;left:0;width:var(--kg-pin);height:calc(var(--kg-h) - 4px);margin:calc(2px - var(--kg-h) / 2) 0 0 calc(var(--kg-pin) / -2);border-radius:var(--k-round);box-shadow:0 0 0 2px var(--k-thumb),0 1px 4px rgba(0,0,0,calc(.4 * var(--k-lift)));pointer-events:none;scale:.78;
  transition:left ${FILL_T} ${DELAY},background-color .2s ${DELAY},scale .2s var(--k-ease),opacity .15s}
.knobs-grad-stop[data-selected]{scale:1}
.knobs-grad:is(:focus-visible,.knobs-active) .knobs-grad-stop[data-selected]{scale:1.12}
.knobs-grad-stop[data-leaving]{opacity:.35;scale:.6}
.knobs-x[data-k-active] :is(.knobs-grad,.knobs-grad-mini,.knobs-grad-mini>i){transition:none}
.knobs-x[data-k-active] .knobs-grad-stop{transition:scale .2s var(--k-ease),opacity .15s}
:is(.knobs-grad-stop,.knobs-graph-pt)[data-born]{animation:knobs-born .24s var(--k-ease)}
@keyframes knobs-born{from{opacity:0;scale:.4}}
.knobs-mixed :is(.knobs-grad,.knobs-grad-mini){background:transparent}
.knobs-panel .knobs-ramp-chips{display:flex;flex-wrap:wrap}
.knobs-panel .knobs-ramp-chips>.knobs-ease-chip{flex:1 1 auto}
.knobs-mixed :is(.knobs-grad-stop,.knobs-grad-mini>i){opacity:0}

/* Curves: a mini curve in the head; a graph with a grid, points (the selected one filled) and a
   hover crosshair whose readout sits in the corner. */
.knobs-curve-mini{flex:none;width:36px;height:var(--k-track-h);overflow:visible}
.knobs-graph{position:relative;height:calc(var(--k-row) * 4.5);border-radius:var(--k-radius-md);background:var(--k-seg-bg);cursor:crosshair;touch-action:none;user-select:none;outline:none;overflow:hidden}
.knobs-panel .knobs-graph>svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.knobs-graph>i{position:absolute;left:0;top:0;pointer-events:none}
.knobs-graph-pt{width:10px;height:10px;margin:-5px;border-radius:var(--k-round);background:var(--k-bg);box-shadow:inset 0 0 0 2px var(--k-accent),0 1px 3px rgba(0,0,0,calc(.3 * var(--k-lift)));
  transition:translate ${FILL_T} ${DELAY},background-color .15s,scale .2s var(--k-ease),opacity .15s}
.knobs-graph-pt[data-selected]{background:var(--k-accent)}
.knobs-graph:is(:focus-visible,.knobs-active) .knobs-graph-pt[data-selected]{scale:1.2}
.knobs-graph-pt[data-leaving]{opacity:.35;scale:.7}
.knobs-graph.knobs-active .knobs-graph-pt{transition:background-color .15s,scale .2s var(--k-ease),opacity .15s}
.knobs-graph.knobs-active .knobs-curve,.knobs-x[data-k-active] .knobs-curve-mini .knobs-curve{transition:none}
.knobs-graph :is(.knobs-graph-v,.knobs-graph-h,.knobs-graph-dot,.knobs-graph-read){opacity:0;transition:opacity .15s}
.knobs-graph[data-hover] :is(.knobs-graph-v,.knobs-graph-h,.knobs-graph-dot,.knobs-graph-read){opacity:1}
.knobs-graph-v{bottom:0;width:1px;margin-left:-.5px;background:var(--k-line-hi)}
.knobs-graph-h{right:0;height:1px;margin-top:-.5px;background:var(--k-line-hi)}
.knobs-graph-dot{width:5px;height:5px;margin:-2.5px;border-radius:50%;background:var(--k-accent)}
.knobs-graph-read{position:absolute;top:4px;right:4px;padding:1px 5px;border-radius:var(--k-radius-sm);background:var(--k-bg);color:var(--k-label);font-family:var(--k-value-font);font-size:var(--kc-value-size);font-variant-numeric:tabular-nums;font-feature-settings:"tnum";white-space:nowrap;pointer-events:none}
.knobs-mixed :is(.knobs-curve-mini,.knobs-graph .knobs-curve,.knobs-graph-pt){opacity:0}

/* Rows as separate bars (--k-row-gap above 0): each row carries its own surface, no hairlines.
   A spring stacks its curve over its two sliders. */
.knobs-panel[data-rows] .knobs-card{display:flex;flex-direction:column;gap:var(--k-row-gap);background:transparent;overflow:visible}
.knobs-panel[data-rows] .knobs-card>*{background:var(--k-surface);border-radius:var(--k-radius);overflow:hidden}
.knobs-panel[data-rows] .knobs-card>:is(:hover,.knobs-active){background:color-mix(in srgb,var(--k-surface-hi) 50%,var(--k-surface))}
.knobs-panel[data-rows] :is(.knobs-card>*,.knobs-sub)::before{display:none}
.knobs-panel[data-rows] .knobs-card>.knobs-subhead{background:transparent}
.knobs-panel[data-rows] .knobs-card>.knobs-spring{flex-direction:column-reverse;gap:var(--k-row-gap);background:transparent;overflow:visible}
.knobs-panel[data-rows] .knobs-spring-tracks{display:flex;flex-direction:column;gap:var(--k-row-gap);overflow:visible}
.knobs-panel[data-rows] .knobs-sub{background:var(--k-surface);border-radius:var(--k-radius);overflow:hidden}
.knobs-panel[data-rows] .knobs-sub:is(:hover,.knobs-active){background:color-mix(in srgb,var(--k-surface-hi) 50%,var(--k-surface))}
.knobs-panel[data-rows] .knobs-spring-curve{width:auto;height:calc(var(--k-row) * 2.8);margin:0;border-radius:var(--k-radius);background:var(--k-surface)}
/* --k-frame: flat. Groups are plain sections: no card surfaces, rows split by hairlines and a
   hairline over every group's label but the first. An inline panel sheds its own card and
   padding too, for a host's column or card, so nothing draws a card inside a card. */
:where(.knobs-panel)[data-frame="flat"]{--k-group-divider:var(--k-line);--k-group-divider-gap:var(--k-gap)}
:where(.knobs-panel.knobs-inline:not(.knobs-page))[data-frame="flat"]{--k-chrome:0;--k-pad:0px}
.knobs-panel[data-frame="flat"] .knobs-card{background:transparent;border-radius:0}
.knobs-panel[data-frame="flat"][data-rows] .knobs-card>*,.knobs-panel[data-frame="flat"][data-rows] .knobs-sub{background:transparent;border-radius:0}

/* Disabled rows dim and take no edits (focus still reaches them, to read); read-only rows keep
   full strength. Neither shows a hover wash or an edit cursor. */
.knobs-panel :is(.knobs-card>[data-disabled],.knobs-sub[data-disabled]){opacity:var(--k-disabled-opacity)}
.knobs-panel .knobs-card>:is([data-disabled],[data-readonly]):hover{background:transparent}
.knobs-panel :is([data-disabled],[data-readonly]) :is(.knobs-track,.knobs-value,.knobs-seg,.knobs-seg button,.knobs-select,.knobs-toggle,.knobs-action,.knobs-strip-track,.knobs-pad,.knobs-ease-handle,.knobs-ease-chip,.knobs-grad,.knobs-graph){cursor:default}
.knobs-slider:is([data-disabled],[data-readonly]):hover .knobs-fill{--k-fill-mix:var(--k-fill-rest-mix)}
.knobs-slider:is([data-disabled],[data-readonly]):hover:not(:has(:focus-visible)) :is(.knobs-handle,.knobs-marks>i){opacity:var(--k-handle-rest);background-color:transparent}
.knobs-slider:is([data-disabled],[data-readonly]):hover:not(:has(:focus-visible)) .knobs-handle::before{transform:scaleX(calc(.25 + .75 * min(1, var(--k-handle-rest) * 4)))}
.knobs-panel :is([data-disabled],[data-readonly]) .knobs-value:hover{border-bottom-color:transparent}
.knobs-panel :is([data-disabled],[data-readonly]) .knobs-seg button:not([aria-checked=true]):hover{color:var(--k-label)}
.knobs-panel :is([data-disabled],[data-readonly]) .knobs-action:hover:not(:focus-visible){color:var(--k-text)}
.knobs-panel :is([data-disabled],[data-readonly]) .knobs-select:hover:not(:focus-visible){background:var(--k-seg-bg);color:var(--k-label)}
/* A mixed value (a multi-selection whose items differ) reads "—" until it's edited. */
.knobs-mixed :is(.knobs-fill,.knobs-handle-zone,.knobs-marks){opacity:0}
.knobs-panel .knobs-mixed .knobs-value>:is(.knobs-digits,.knobs-unit,.knobs-lock){display:none}
.knobs-mixed .knobs-value::after{content:"—"}
.knobs-mixed :is(.knobs-range-fill,.knobs-range-thumb,.knobs-dial-hand,.knobs-strip-thumb,.knobs-pad-puck,.knobs-pad-v,.knobs-pad-h,.knobs-ease-mini,.knobs-ease .knobs-curve,.knobs-arm,.knobs-ease-handle){opacity:0}
.knobs-panel .knobs-toggle[aria-checked="mixed"] i{left:calc(50% - 7px);right:calc(50% - 7px)}

/* Tabs: text over a hairline; the chosen one's underline slides to it, its leading edge first. */
.knobs-tabs{position:relative;display:flex;align-items:stretch;gap:calc(var(--k-unit) * 4);margin:0 0 var(--k-section-gap);padding:0 var(--k-inset);overflow:hidden;transition:opacity .2s var(--k-ease)}
.knobs-tabs::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;transform:scaleY(.5);transform-origin:bottom;background:var(--k-line);pointer-events:none}
.knobs-panel .knobs-tab{flex:none;height:calc(var(--k-row) - var(--k-unit));padding:0;background:transparent;border-radius:0;font-size:var(--k-text-control);font-weight:var(--k-label-weight);color:var(--k-label);white-space:nowrap;cursor:pointer;transition:color .15s}
.knobs-panel .knobs-tab:is(:hover,:focus-visible),.knobs-panel .knobs-tab[aria-selected="true"]{color:var(--k-text)}
.knobs-tabs-bar{position:absolute;bottom:0;left:0;right:100%;height:1.5px;border-radius:1px;background:var(--k-accent);pointer-events:none;transition:left ${TRAIL_T},right ${LEAD_T}}
.knobs-tabs-bar[data-dir="left"]{transition:left ${LEAD_T},right ${TRAIL_T}}
/* A search spans every tab, so the strip steps back while it's on. */
.knobs-panel[data-searching] .knobs-tabs{opacity:.4}

/* Search: a field and its filter chips. Matches show in labels by colour alone. */
.knobs-search{display:flex;align-items:center;gap:var(--k-tray-pad);margin:0 0 var(--k-section-gap)}
.knobs-search-field{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:var(--kc-control-h);padding:0 8px;background:var(--k-seg-bg);border-radius:var(--k-radius-md);color:var(--k-dim);cursor:text}
.knobs-search-field>.knobs-icon{width:calc(var(--k-icon-sm) - 2px);height:calc(var(--k-icon-sm) - 2px)}
.knobs-panel .knobs-search input{flex:1;min-width:0;height:100%;padding:0;background:transparent;border-radius:0;color:var(--k-text);font-size:var(--k-text-control);-webkit-appearance:none;appearance:none}
.knobs-panel .knobs-search input::placeholder{color:var(--k-dim)}
.knobs-panel .knobs-search input::-webkit-search-cancel-button{display:none}
.knobs-panel .knobs-search-chip{flex:none;display:inline-flex;align-items:center;gap:5px;height:var(--kc-control-h);padding:0 8px;background:transparent;border-radius:var(--k-radius-md);box-shadow:inset 0 0 0 1px var(--k-line);color:var(--k-label);font-size:var(--k-text-meta);font-weight:var(--k-label-weight);white-space:nowrap;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s,opacity .15s}
.knobs-panel .knobs-search-chip:is(:hover,:focus-visible){color:var(--k-text);box-shadow:inset 0 0 0 1px var(--k-line-hi)}
.knobs-panel .knobs-search-chip[aria-pressed="true"]{background:var(--k-pill-bg);box-shadow:inset 0 0 0 1px var(--k-pill-border);color:var(--k-text)}
.knobs-panel .knobs-search-chip[data-none]{opacity:.5}
.knobs-search-count{color:var(--k-dim);font-variant-numeric:tabular-nums}
.knobs-search-chip[aria-pressed="true"] .knobs-search-count{color:var(--k-label)}
.knobs-panel mark.knobs-match{background:none;color:var(--k-accent)}
.knobs-panel[data-gpu-active="true"] .knobs-search{position:relative;z-index:2147480003}

/* Sub-headings: a flat heading inside the group's card, split off by the card's hairline. */
.knobs-panel .knobs-card>.knobs-subhead{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:0;height:calc(var(--k-row) - var(--k-unit) * 2);padding:0 var(--k-inset);color:var(--k-label);font-size:var(--k-text-meta);font-weight:var(--k-title-weight);cursor:pointer;user-select:none}
.knobs-subhead-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knobs-subhead[aria-expanded="true"] .knobs-caret{transform:rotate(90deg)}
.knobs-subhead:hover .knobs-caret{color:var(--k-label)}
.knobs-card>.knobs-subhead:focus-visible::after{opacity:1}

/* Inspector rows: number cells, ranges, dials, seeds and key combinations. */
.knobs-panel .knobs-insp{gap:8px}
.knobs-panel .knobs-insp[data-kind="vec"]>span:first-child{flex-shrink:0;max-width:34%}
.knobs-cells{flex:0 1 auto;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:var(--k-tray-pad);width:calc(var(--k-row) * 5);max-width:64%}
.knobs-cells[data-wide]{width:calc(var(--k-row) * 7.5);max-width:72%}
.knobs-cell{position:relative;display:flex;align-items:center;justify-content:space-between;gap:3px;min-width:0;height:var(--kc-control-h);padding:0 5px;border-radius:var(--k-radius-md);background:var(--k-seg-bg);cursor:ew-resize;user-select:none;touch-action:none;outline:none;transition:background var(--k-hover-t)}
.knobs-cell:hover,.knobs-cell:focus-visible{background:color-mix(in srgb,var(--k-surface-hi) 70%,var(--k-seg-bg))}
.knobs-active .knobs-cell:focus{background:var(--k-surface-hi)}
.knobs-cell-axis{flex:none;font-style:normal;font-size:var(--k-text-cap);font-weight:var(--k-title-weight);color:var(--k-dim)}
.knobs-cell-read,.knobs-range-read,.knobs-angle-read,.knobs-seed-read{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--k-label);font-family:var(--k-value-font);font-size:var(--kc-value-size);font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.knobs-cell:focus-visible .knobs-cell-read,.knobs-active .knobs-cell:focus .knobs-cell-read{color:var(--k-text)}
.knobs-panel .knobs-link{flex:none;width:20px;height:20px;margin:0 -4px 0 auto;padding:0;display:inline-flex;align-items:center;justify-content:center;background:transparent;border-radius:var(--k-round);color:var(--k-dim);cursor:pointer;transition:background .15s,color .15s}
.knobs-panel .knobs-link:hover{background:var(--k-surface-hi);color:var(--k-text)}
.knobs-panel .knobs-link[aria-pressed="true"]{color:var(--k-text)}
.knobs-link .knobs-icon{width:var(--k-icon-sm);height:var(--k-icon-sm)}
/* The inline editor over a readout: above the GPU canvas, which leaves that readout to it. */
.knobs-panel .knobs-cell-edit{position:absolute;z-index:3;right:var(--k-inset);top:50%;transform:translateY(-50%);width:7ch;height:auto;padding:1px 4px;text-align:right;background:var(--k-bg);border-radius:var(--k-radius-sm);border-bottom:1px solid var(--k-text);color:var(--k-text);font-family:var(--k-value-font);font-variant-numeric:tabular-nums;font-size:var(--kc-value-size)}
.knobs-cell.knobs-editing>:not(.knobs-cell-edit){visibility:hidden}
.knobs-panel .knobs-cell>.knobs-cell-edit{inset:0;width:auto;transform:none;padding:0 6px;border-radius:var(--k-radius-md)}
.knobs-panel[data-gpu-active="true"] .knobs-cell-edit{z-index:2147480003}

.knobs-panel .knobs-row.knobs-range{display:block;height:var(--k-row);padding:0}
.knobs-range-track{position:absolute;inset:0;overflow:hidden;cursor:ew-resize;user-select:none;touch-action:none;transition:--kr-lo ${FILL_T} ${DELAY},--kr-hi ${FILL_T} ${DELAY}}
.knobs-range-fill{position:absolute;inset:0;transform-origin:0 0;transform:scaleX(0);background:var(--k-fill-rest);pointer-events:none;transition:transform ${FILL_T} ${DELAY},background .15s}
.knobs-range:hover .knobs-range-fill{background:color-mix(in srgb,var(--k-accent) var(--k-fill-hover-mix),var(--k-fill-base))}
.knobs-range.knobs-active .knobs-range-fill{background:var(--k-fill-active)}
.knobs-range-thumb{position:absolute;top:0;bottom:0;left:calc(var(--kr-lo) * 100%);width:0;outline:none}
.knobs-range-thumb[data-end="hi"]{left:calc(var(--kr-hi) * 100%)}
/* Where a thumb shows, the label and readout fade around it (2.5px either side of its hairline). */
.knobs-range-text{position:absolute;inset:0;pointer-events:none;transition:--kr-show-lo .15s,--kr-show-hi .15s;
  --kg-lo:calc(var(--kr-lo) * 100% + 1.5px);--kg-hi:calc(var(--kr-hi) * 100% - 1.5px);--kg-in-lo:rgb(0 0 0/calc(1 - var(--kr-show-lo)));--kg-in-hi:rgb(0 0 0/calc(1 - var(--kr-show-hi)));
  --kg-mask:linear-gradient(to right,#000 calc(var(--kg-lo) - 6.5px),var(--kg-in-lo) calc(var(--kg-lo) - 2.5px),var(--kg-in-lo) calc(var(--kg-lo) + 2.5px),#000 calc(var(--kg-lo) + 6.5px)),linear-gradient(to right,#000 calc(var(--kg-hi) - 6.5px),var(--kg-in-hi) calc(var(--kg-hi) - 2.5px),var(--kg-in-hi) calc(var(--kg-hi) + 2.5px),#000 calc(var(--kg-hi) + 6.5px));
  -webkit-mask:var(--kg-mask);mask:var(--kg-mask);-webkit-mask-composite:source-in;mask-composite:intersect}
.knobs-range:not(.knobs-mixed):hover .knobs-range-text{--kr-show-lo:1;--kr-show-hi:1}
.knobs-range:not(.knobs-mixed)[data-end-focus="lo"]:is([data-k-fv],.knobs-active) .knobs-range-text{--kr-show-lo:1}
.knobs-range:not(.knobs-mixed)[data-end-focus="hi"]:is([data-k-fv],.knobs-active) .knobs-range-text{--kr-show-hi:1}
.knobs-range-thumb::before{content:"";position:absolute;left:0;top:50%;width:3px;height:calc(var(--k-row) - 12px);margin-top:calc(6px - var(--k-row) / 2);translate:-50% 0;border-radius:var(--k-round);background:var(--k-handle);opacity:0;scale:.25 1;transition:opacity .15s,scale .22s var(--k-ease)}
.knobs-range-thumb[data-end="lo"]::before{translate:0 0}
.knobs-range-thumb[data-end="hi"]::before{translate:-100% 0}
.knobs-range:hover .knobs-range-thumb::before{opacity:.5}
.knobs-range-thumb:focus-visible::before,.knobs-range.knobs-active .knobs-range-thumb:focus::before{opacity:.95;scale:1}
.knobs-range .knobs-label{max-width:calc(55% - var(--k-inset))}
.knobs-range-read{position:absolute;right:var(--k-inset);top:50%;transform:translateY(-50%);pointer-events:none}
.knobs-range.knobs-active .knobs-range-read,.knobs-range:has(:focus-visible) .knobs-range-read{color:var(--k-text)}
.knobs-range.knobs-modified .knobs-range-read{color:color-mix(in srgb,var(--k-modified) calc(var(--k-readout-mark) * 100%),var(--k-label))}
.knobs-range.knobs-editing .knobs-range-read{opacity:0}

.knobs-angle{display:inline-flex;align-items:center;gap:8px;height:var(--kc-control-h);margin-left:auto;cursor:ew-resize;user-select:none;touch-action:none;outline:none}
.knobs-angle:focus-visible .knobs-angle-read,.knobs-active .knobs-angle-read{color:var(--k-text)}
.knobs-dial{position:relative;flex:none;width:var(--kc-control-h);height:var(--kc-control-h);border-radius:50%;background:var(--k-seg-bg);box-shadow:inset 0 0 0 1px var(--k-line);cursor:grab;transition:box-shadow .15s}
.knobs-angle:is(:hover,:focus-visible) .knobs-dial,.knobs-active .knobs-dial{box-shadow:inset 0 0 0 1px var(--k-line-hi)}
.knobs-active .knobs-dial{cursor:grabbing}
.knobs-dial::after{content:"";position:absolute;left:50%;top:50%;width:3px;height:3px;margin:-1.5px;border-radius:50%;background:var(--k-accent)}
.knobs-dial-hand{position:absolute;left:50%;top:18%;bottom:50%;width:1.5px;margin-left:-.75px;border-radius:1px;background:var(--k-accent);transform-origin:50% 100%;transition:rotate ${FILL_T} ${DELAY}}
.knobs-active .knobs-dial-hand{transition:none}
.knobs-insp.knobs-editing .knobs-angle-read,.knobs-insp.knobs-editing .knobs-seed-read{opacity:0}

.knobs-panel .knobs-insp[data-kind="seed"]{gap:2px}
.knobs-seed{display:inline-flex;align-items:center;height:var(--kc-control-h);margin-left:auto;padding:0 4px;border-radius:var(--k-radius-sm);cursor:text;outline:none}
.knobs-seed:focus-visible .knobs-seed-read{color:var(--k-text)}
.knobs-seed-digits{display:inline-flex;align-items:center;line-height:2.1;margin-block:-.375em;--rn-edge-fade:.5em}
.knobs-seed-read{display:inline-flex;align-items:center}
.knobs-seed-read[data-mixed]::before{content:"—"}
.knobs-seed-read[data-mixed]>.knobs-seed-digits{display:none}
.knobs-panel .knobs-seed-roll{flex:none;width:var(--k-icon-btn);height:var(--k-icon-btn);padding:0;display:inline-flex;align-items:center;justify-content:center;background:transparent;border-radius:var(--k-round);color:var(--k-dim);cursor:pointer;transition:background .15s,color .15s}
.knobs-panel .knobs-seed-roll:hover{background:var(--k-surface-hi);color:var(--k-text)}
.knobs-seed-roll .knobs-die-icon{width:var(--k-icon-sm);height:var(--k-icon-sm)}

.knobs-panel .knobs-keys{flex:none;display:inline-flex;align-items:center;max-width:62%;height:var(--kc-control-h);padding:0 8px;background:var(--k-seg-bg);border-radius:var(--k-radius-md);color:var(--k-text);font-size:var(--kc-value-size);letter-spacing:.08em;white-space:nowrap;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s}
.knobs-panel .knobs-keys:is(:hover,:focus-visible){background:color-mix(in srgb,var(--k-surface-hi) 70%,var(--k-seg-bg))}
.knobs-panel .knobs-keys[data-empty]{color:var(--k-dim);letter-spacing:0}
.knobs-panel .knobs-keys[aria-pressed="true"]{background:var(--k-pill-bg);box-shadow:inset 0 0 0 1px var(--k-pill-border);color:var(--k-label);letter-spacing:.08em}
.knobs-keys-text{min-width:0;overflow:hidden;text-overflow:ellipsis}

/* Toolbars: icon, label and shortcut per button; they wrap. Buttons take the button tokens. */
.knobs-panel .knobs-row.knobs-toolbar{flex-wrap:wrap;justify-content:flex-start;gap:var(--k-tray-pad);height:auto;min-height:var(--k-row);padding:calc((var(--k-row) - var(--k-button-h,var(--kc-control-h))) / 2) var(--k-inset)}
.knobs-card>.knobs-toolbar:hover{background:transparent}
.knobs-card>.knobs-toolbar:has(:focus-visible)::after{opacity:0}
.knobs-panel .knobs-tool{display:inline-flex;align-items:center;gap:6px;height:var(--k-button-h,var(--kc-control-h));padding:0 8px;background:var(--k-button-bg,var(--k-seg-bg));border-radius:var(--k-button-radius,var(--k-radius-md));box-shadow:inset 0 0 0 1px var(--k-button-line,transparent);
  color:var(--k-label);font-size:var(--k-button-font-size,var(--k-text-control));font-weight:var(--k-label-weight);white-space:nowrap;cursor:pointer;transition:background var(--k-hover-t),color .15s,box-shadow .15s,scale .12s var(--k-ease),opacity .15s}
.knobs-panel .knobs-tool:is(:hover:not([disabled]),:focus-visible){background:var(--k-button-hover-bg,var(--k-surface-hi));box-shadow:inset 0 0 0 1px var(--k-button-hover-line,var(--k-button-line,transparent));color:var(--k-text)}
.knobs-panel .knobs-tool:is(:active:not([disabled]),.knobs-pressed){scale:.96}
.knobs-panel .knobs-tool[disabled]{opacity:var(--k-disabled-opacity);cursor:default}
.knobs-tool .knobs-icon{width:var(--k-icon-sm);height:var(--k-icon-sm)}
.knobs-panel .knobs-tool-key{font:inherit;font-size:var(--k-text-cap);color:var(--k-dim);letter-spacing:.06em}
.knobs-panel :is([data-disabled],[data-readonly]) :is(.knobs-cell,.knobs-range-track,.knobs-angle,.knobs-dial,.knobs-seed,.knobs-keys,.knobs-tool){cursor:default}

/* Row accessories (rowAccessory): the host's node, just after the label. */
.knobs-accessory{display:inline-flex;align-items:center;gap:var(--k-tray-pad);flex:none;min-width:0;color:var(--k-label)}
.knobs-accessory:empty{display:none}
.knobs-panel .knobs-row:where(:not(.knobs-slider,.knobs-x,.knobs-spring))>.knobs-accessory{margin:0 auto 0 -4px}
.knobs-track>.knobs-accessory{position:absolute;top:0;bottom:0;left:calc(var(--k-label-right,0px) + 4px);z-index:1}
.knobs-x-head>.knobs-accessory{margin:0 auto 0 -4px}
.knobs-action-row>.knobs-accessory{position:absolute;top:0;bottom:0;right:var(--k-inset)}

/* Foldable groups (folded / groupFolded): the header toggles its card. */
.knobs-panel .knobs-group-head[data-foldable]{cursor:pointer;user-select:none;transition:background var(--k-hover-t)}
.knobs-panel .knobs-group-head[data-foldable]:focus-visible{background:var(--k-surface)}
.knobs-group-head>span:last-child>.knobs-caret{margin:0 5px 0 3px}
.knobs-group-head[aria-expanded="true"] .knobs-caret{transform:rotate(90deg)}
.knobs-group-head[data-foldable]:hover .knobs-caret{color:var(--k-label)}

/* A long choice's menu row: the label keeps its words (up to half the row) and the value takes
   the rest, truncating at its end; the whole value is in the menu and the button's tooltip. */
.knobs-panel .knobs-row[data-display="menu"]>span:first-child{flex:0 0 auto;max-width:50%}
.knobs-panel .knobs-row[data-display="menu"]>.knobs-select{flex:0 1 auto;max-width:none}

/* A different item landing: values are placed, nothing glides. */
.knobs-panel[data-landing] :is(*,*::before,*::after){transition:none!important}

/* Hint mode: stable short codes, zero layout shift */
.knobs-hinting .knobs-hint-miss{opacity:var(--k-disabled-opacity);transition:opacity .1s}
.knobs-hint-layer{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:5;animation:knobs-in .1s var(--k-ease)}
.knobs-hint{position:absolute;transform:translateY(-50%);display:inline-flex;align-items:center;height:15px;padding:0 4px;border-radius:var(--k-radius-sm);background:var(--k-accent);color:var(--k-bg);box-shadow:0 1px 3px rgba(0,0,0,calc(.35 * var(--k-lift)));
  font:700 var(--k-text-cap)/1 var(--k-mono);letter-spacing:.04em;text-transform:uppercase;pointer-events:none}
.knobs-hint-typed{opacity:var(--k-hint-typed-opacity)}
.knobs-hint-rest{opacity:1}

/* Custom actions */
.knobs-panel .knobs-custom-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:var(--k-gap);margin-top:var(--k-section-gap)}
.knobs-panel .knobs-custom-actions button{height:var(--k-button-h,var(--k-action-h));min-height:24px;padding:0 8px;font-size:var(--k-button-font-size,var(--k-text-control));font-weight:var(--k-label-weight);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--k-label);cursor:pointer;
  background:var(--k-button-bg,var(--k-surface));border-radius:var(--k-button-radius,var(--k-radius));box-shadow:inset 0 0 0 1px var(--k-button-line,transparent);transition:background .15s,color .15s,opacity .15s,transform .12s,box-shadow .15s}
.knobs-panel .knobs-custom-actions button:is(:hover:not([disabled]),:focus-visible){background:var(--k-button-hover-bg,var(--k-surface-hi));box-shadow:inset 0 0 0 1px var(--k-button-hover-line,var(--k-button-line,transparent));color:var(--k-text)}
.knobs-panel .knobs-custom-actions button:active:not([disabled]){transform:scale(.97)}
.knobs-panel .knobs-tile-body>.knobs-custom-actions button[disabled]{opacity:var(--k-disabled-opacity);cursor:default}

/* Variants Disclosure Drawer */
.knobs-transfer{display:grid;grid-template-columns:1fr 1fr;gap:var(--k-gap);margin-top:8px;padding-top:8px;border-top:1px solid var(--k-line)}
.knobs-transfer button{height:var(--k-button-h,24px);padding:0 8px;background:var(--k-button-bg,var(--k-surface));border-radius:var(--k-button-radius,var(--k-radius));box-shadow:inset 0 0 0 1px var(--k-button-line,transparent);font-size:var(--k-button-font-size,var(--k-text-meta));color:var(--k-label);cursor:pointer;transition:background .15s,color .15s,box-shadow .15s}
.knobs-transfer button:is(:hover,:focus-visible){background:var(--k-button-hover-bg,var(--k-surface-hi));box-shadow:inset 0 0 0 1px var(--k-button-hover-line,var(--k-button-line,transparent));color:var(--k-text)}

/* Context menu: borrows its panel's tokens (see menu.ts) and floats above everything. */
.knobs-menu{position:fixed;z-index:2147480004;min-width:176px;padding:var(--k-unit);box-sizing:border-box;font:var(--k-font-weight) var(--k-text-control)/1.35 var(--k-font);color:var(--k-text);text-align:left;-webkit-font-smoothing:antialiased;
  background:linear-gradient(var(--k-surface-hi),var(--k-surface-hi)),color-mix(in srgb,var(--k-bg) 90%,transparent);border:1px solid var(--k-line);border-radius:var(--k-radius);
  box-shadow:var(--k-shadow),inset 0 1px 0 var(--k-rim);-webkit-backdrop-filter:blur(20px) saturate(1.6);backdrop-filter:blur(20px) saturate(1.6);outline:none;user-select:none}
.knobs-menu{max-width:min(480px,calc(100vw - 12px))}
.knobs-menu-list{max-height:min(360px,calc(100dvh - 120px));overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.knobs-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;gap:24px;height:var(--kc-control-h);min-height:20px;padding:0 8px;border-radius:var(--k-radius-sm);cursor:default;white-space:nowrap;transition:background .08s}
.knobs-menu-item>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.knobs-menu-item[hidden]{display:none}
/* The match shows by colour, not weight, so a filtered label keeps the width the menu measured. */
.knobs-menu-item>span[data-marked]{color:var(--k-label)}
.knobs-menu-item mark{background:none;color:var(--k-text)}
.knobs-menu .knobs-menu-search{display:block;width:100%;height:var(--kc-control-h);min-height:22px;margin:0 0 var(--k-unit);padding:0 8px;border:0;border-radius:var(--k-radius-sm);background:var(--k-seg-bg);color:var(--k-text);font:inherit;outline:none;-webkit-appearance:none;appearance:none}
.knobs-menu .knobs-menu-search::placeholder{color:var(--k-dim)}
.knobs-menu .knobs-menu-search::-webkit-search-cancel-button{display:none}
.knobs-menu [hidden]{display:none!important}
.knobs-menu-empty{padding:0 8px;height:var(--kc-control-h);display:flex;align-items:center;color:var(--k-dim)}
.knobs-menu-item[data-active]{background:color-mix(in srgb,var(--k-accent) 14%,transparent)}
.knobs-menu-item[aria-disabled]{opacity:var(--k-disabled-opacity);color:var(--k-label)}
.knobs-menu-item kbd{font:var(--k-text-cap)/1 var(--k-mono);font-variant-numeric:tabular-nums;color:var(--k-dim);letter-spacing:0}
.knobs-menu-item[data-separated]{margin-top:calc(var(--k-unit) * 2 + 1px)}
.knobs-menu-item[data-separated]::before{content:"";position:absolute;left:8px;right:8px;top:calc(var(--k-unit) * -1 - 1px);height:1px;transform:scaleY(.5);background:var(--k-line)}

/* Status & Transfer Textarea */
.knobs-panel .knobs-status{margin:6px 0 0;padding:0 var(--k-inset);color:var(--k-label);font-size:var(--k-text-meta);overflow-wrap:anywhere}

.knobs-panel textarea{width:100%;min-height:84px;margin-top:6px;padding:6px var(--k-inset);resize:vertical;font:var(--k-text-meta)/1.4 var(--k-mono)}
.knobs-panel .knobs-apply-btn{width:100%;height:26px;margin-top:var(--k-gap);font-size:var(--k-text-control);font-weight:500;color:var(--k-text);background:var(--k-surface-hi);cursor:pointer}

/* WebGPU Overlay Active Mirror State */
.knobs-panel[data-gpu-active="true"]{background:transparent!important;border-color:transparent!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
.knobs-panel[data-gpu-active="true"],.knobs-panel[data-gpu-active="true"] :where(*,:focus-visible):not(.knobs-live *,.knobs-search *){outline-color:transparent!important;box-shadow:none!important}
.knobs-panel[data-gpu-active="true"] :where(header strong,header button,.knobs-tile,.knobs-section-head,.knobs-group-label,.knobs-peek,.knobs-card>*,.knobs-presets,.knobs-preset-chip,.knobs-group-head,.knobs-group-head button,.knobs-card,.knobs-row,.knobs-row>span:first-child,.knobs-slider,.knobs-track,.knobs-label,.knobs-value,.knobs-digits,.knobs-digits *,.knobs-unit,.knobs-seg,.knobs-seg button,.knobs-custom-actions button,.knobs-action,.knobs-select,.knobs-select-value,
  .knobs-sub,.knobs-x-head,.knobs-x-label,.knobs-x-read,.knobs-strip-label,.knobs-strip-read,.knobs-pad,.knobs-ease,.knobs-spring-curve,.knobs-ease-chips,.knobs-ease-chip,.knobs-graph,.knobs-graph-read,
  .knobs-tabs,.knobs-tab,.knobs-subhead,.knobs-subhead-label,.knobs-match,.knobs-cell,.knobs-cell-axis,.knobs-cell-read,.knobs-link,.knobs-range-read,.knobs-angle,.knobs-angle-read,.knobs-dial,
  .knobs-seed,.knobs-seed-read,.knobs-seed-digits,.knobs-seed-digits *,.knobs-seed-roll,.knobs-keys,.knobs-keys-text,.knobs-tool,.knobs-tool-label,.knobs-tool-key,
  .knobs-section-name,.knobs-section-summary,.knobs-section-desc,.knobs-group-desc,.knobs-group-summary,.knobs-tab-count):not(.knobs-live,.knobs-live *){
  background:transparent!important;color:transparent!important;border-color:transparent!important;box-shadow:none!important;
}
.knobs-panel[data-gpu-active="true"] :where(.knobs-seg-pill,.knobs-presets-pill,.knobs-fill,.knobs-notch,.knobs-handle,.knobs-marks i,.knobs-toggle,.knobs-toggle i,.knobs-hint,.knobs-icon,
  .knobs-swatch,.knobs-caret,.knobs-strip-track,.knobs-pad>i,.knobs-ease>svg,.knobs-ease-handle,.knobs-ease-mini,.knobs-spring-curve>*,
  .knobs-grad,.knobs-grad-mini,.knobs-graph>svg,.knobs-graph>i,.knobs-curve-mini,
  .knobs-tabs-bar,.knobs-range-fill,.knobs-range-thumb,.knobs-dial-hand):not(.knobs-live *,.knobs-search *),
.knobs-panel[data-gpu-active="true"] :is(.knobs-tabs,.knobs-dial)::after,
.knobs-panel[data-gpu-active="true"] .knobs-section-head::before,
.knobs-panel[data-gpu-active="true"] :is(.knobs-sub,.knobs-x-head,.knobs-x-label)::before,
.knobs-panel[data-gpu-active="true"] :is(.knobs-sub,.knobs-x-head,.knobs-x-label)::after,
.knobs-panel[data-gpu-active="true"] .knobs-card:not(.knobs-live *)>::before,
.knobs-panel[data-gpu-active="true"] .knobs-card:not(.knobs-live *)>::after,
.knobs-panel[data-gpu-active="true"] .knobs-row:not(.knobs-live *)>span:first-child::after,
.knobs-panel[data-gpu-active="true"] :is(.knobs-tile:not(.knobs-live)>.knobs-veil,.knobs-tile:not(.knobs-live)>.knobs-mark,.knobs-section-head>.knobs-mark){opacity:0!important}
/* Parts the canvas doesn't draw (shortcuts, status, editors) sit above it. */
.knobs-panel[data-gpu-active="true"] :where(.knobs-popover,.knobs-status,textarea,.knobs-apply-btn){position:relative;z-index:2147480003}
.knobs-panel[data-gpu-active="true"] .knobs-number{z-index:2147480003}

/* Page: sections of cards in balanced columns, under a sticky glass header. The page scrolls the
   window, so nothing here may become a scroll container or a containing block for the fixed
   popover and status. Custom cards (.knobs-live) are drawn by the DOM in both renderers. */
.knobs-panel.knobs-page{width:auto;max-width:none;min-height:100dvh;padding:0 0 calc(var(--k-unit) * 16);border:0;border-radius:0;box-shadow:none;overflow:visible;background:var(--k-page);-webkit-backdrop-filter:none;backdrop-filter:none;
  --k-page-pad:calc(var(--k-unit) * 8);--k-page-gap:calc(var(--k-unit) * 4)}
.knobs-panel.knobs-page[data-gpu-active="true"]{background:var(--k-page)!important}
.knobs-panel.knobs-page>header{position:sticky;top:0;z-index:3;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(max-content,1fr);align-items:center;gap:var(--k-page-gap);min-height:calc(var(--k-row) + var(--k-unit) * 6);padding:calc(var(--k-unit) * 2.5) var(--k-page-pad);
  background:color-mix(in srgb,var(--k-page) 84%,transparent);-webkit-backdrop-filter:blur(24px) saturate(1.6);backdrop-filter:blur(24px) saturate(1.6);border-bottom:1px solid transparent;transition:border-color .2s}
.knobs-panel.knobs-page>header[data-scrolled]{border-bottom-color:var(--k-line)}
.knobs-panel.knobs-page>header strong{font-size:calc(var(--k-font-size) + 3px);letter-spacing:-.015em;padding-left:calc(var(--k-pad) + var(--k-inset) + 1px)}
.knobs-page>header .knobs-presets{margin:0;min-width:0;max-width:min(640px,46vw)}
.knobs-page>header .knobs-presets-track{display:flex;flex-wrap:wrap}
.knobs-page>header .knobs-preset-chip{flex:0 0 var(--k-preset-min,58px)}
.knobs-page-tools{display:flex;align-items:center;justify-content:flex-end;min-width:0}
.knobs-page-tools .knobs-head-actions{margin-right:calc((var(--k-icon-size) - var(--k-icon-btn)) / 2 + var(--k-pad) + var(--k-inset) - var(--k-unit))}
.knobs-panel.knobs-page>header[data-narrow]{grid-template-columns:minmax(0,1fr) auto;row-gap:calc(var(--k-unit) * 2)}
.knobs-panel.knobs-page>header[data-narrow]>strong{grid-area:1/1}
.knobs-panel.knobs-page>header[data-narrow] .knobs-page-tools{grid-area:1/2}
.knobs-panel.knobs-page>header[data-narrow] .knobs-presets{grid-area:2/1/3/3;max-width:none}
.knobs-page>header[data-narrow] .knobs-preset-chip{flex:1 0 var(--k-preset-min,58px)}
@media(max-width:640px){
  .knobs-panel.knobs-page{--k-page-pad:calc(var(--k-unit) * 4)}
  .knobs-panel.knobs-page>header{grid-template-columns:minmax(0,1fr) auto;row-gap:calc(var(--k-unit) * 2)}
  .knobs-panel.knobs-page>header>strong{grid-area:1/1}
  .knobs-panel.knobs-page>header .knobs-page-tools{grid-area:1/2}
  .knobs-panel.knobs-page>header .knobs-presets{grid-area:2/1/3/3;max-width:none}
  .knobs-page>header .knobs-preset-chip{flex:1 0 var(--k-preset-min,58px)}
}
/* The jump strip (nav: true): a chip per section along the header's foot, the one in view
   underlined; it scrolls sideways when the chips don't fit. */
.knobs-page>header>.knobs-nav{grid-column:1/-1;margin:0 calc(var(--k-page-pad) * -1) calc(var(--k-unit) * -2.5);padding:0 calc(var(--k-page-pad) + var(--k-pad) + var(--k-inset) + 1px);gap:calc(var(--k-unit) * 5);overflow-x:auto;overflow-y:hidden;scrollbar-width:none;overscroll-behavior-x:contain}
.knobs-page>header>.knobs-nav::-webkit-scrollbar{display:none}
.knobs-page>header>.knobs-nav::after{display:none}
.knobs-panel.knobs-page>header>.knobs-nav .knobs-tab{display:inline-flex;align-items:center;width:auto;height:calc(var(--k-row) + var(--k-unit));padding:0;border-radius:0;font-size:var(--k-text-control);line-height:1.25;color:var(--k-label);background:transparent}
.knobs-panel.knobs-page>header>.knobs-nav .knobs-tab:is(:hover,:focus-visible,[aria-selected="true"]){color:var(--k-text);background:transparent}
.knobs-tab-count{margin-left:5px;font-size:var(--k-text-meta);font-weight:500;font-variant-numeric:tabular-nums;color:var(--k-modified)}
.knobs-panel.knobs-page .knobs-page-tools .knobs-custom-actions{display:flex;gap:var(--k-tray-pad);margin:0 calc(var(--k-unit) * 2) 0 0}
.knobs-panel.knobs-page .knobs-page-tools .knobs-custom-actions button{height:var(--k-icon-btn);min-height:0;padding:0 8px;background:transparent;border-radius:var(--k-round)}
.knobs-panel .knobs-filter{width:0;height:var(--kc-control-h);padding:0;margin:0;opacity:0;pointer-events:none;background:var(--k-seg-bg);border-radius:var(--k-radius-md);font-size:var(--k-text-control);color:var(--k-text);-webkit-appearance:none;appearance:none;
  transition:width ${LEAD_T},padding ${LEAD_T},margin ${LEAD_T},opacity .18s}
.knobs-panel .knobs-filter::-webkit-search-cancel-button{display:none}
.knobs-panel .knobs-filter::placeholder{color:var(--k-dim)}
.knobs-panel .knobs-filter[data-open]{width:min(200px,22vw);padding:0 10px;margin-right:calc(var(--k-unit) * 2);opacity:1;pointer-events:auto}
.knobs-panel.knobs-page>.knobs-popover{position:fixed;z-index:2147480003;top:calc(var(--k-head-h,56px) + var(--k-unit) * 2);right:var(--k-page-pad);width:min(360px,calc(100vw - 32px));max-height:calc(100dvh - var(--k-head-h,56px) - 32px);overflow:auto;margin:0;padding:var(--k-pad) var(--k-inset);
  background:color-mix(in srgb,var(--k-bg) 94%,transparent);border-radius:var(--k-panel-radius);box-shadow:var(--k-shadow),inset 0 1px 0 var(--k-rim);-webkit-backdrop-filter:blur(24px) saturate(1.6);backdrop-filter:blur(24px) saturate(1.6)}
.knobs-panel.knobs-page>.knobs-status{position:fixed;z-index:2147480003;left:50%;bottom:calc(var(--k-unit) * 6);translate:-50% 0;max-width:min(480px,80vw);margin:0;padding:calc(var(--k-unit) * 2) calc(var(--k-unit) * 3.5);
  background:var(--k-bg);border:1px solid var(--k-line);border-radius:var(--k-round);box-shadow:var(--k-shadow);color:var(--k-text)}
.knobs-sections{padding:0 var(--k-page-pad);overflow-x:clip;overflow-anchor:none}
.knobs-columns{display:grid;grid-template-columns:repeat(var(--k-cols,1),minmax(0,1fr));gap:var(--k-page-gap);align-items:start;padding-top:calc(var(--k-unit) * 3)}
.knobs-column{display:flex;flex-direction:column;gap:var(--k-page-gap);min-width:0}
.knobs-section-head{margin:0 0 calc(var(--k-page-gap) * -.25);padding:0 calc(var(--k-pad) + var(--k-inset) + 1px);font:var(--k-title-weight) calc(var(--k-font-size) + 3px)/1.25 var(--k-font);letter-spacing:-.015em;color:var(--k-text);white-space:nowrap;
  display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr) auto;align-items:center;column-gap:8px;isolation:isolate}
.knobs-column>:not([hidden],[data-away])~.knobs-section-head{margin-top:calc(var(--k-page-gap) * .75)}
.knobs-section-name{grid-area:1/1;min-width:0;overflow:hidden;text-overflow:ellipsis}
/* A section that folds: its heading toggles it, its caret showing while it's hovered, focused or
   folded. Folded, the heading says what's in it and its cards wait out of the flow. */
.knobs-tile[data-away]{display:none}
.knobs-section-head[data-foldable]{cursor:pointer;user-select:none}
.knobs-section-head[data-folded]{margin-bottom:0}
.knobs-section-head[data-foldable]::before{content:"";position:absolute;z-index:-1;inset:-4px 0;border-radius:var(--k-radius-md);background:var(--k-surface);opacity:0;transition:opacity var(--k-hover-t)}
.knobs-section-head[data-foldable]:focus-visible{outline:none}
.knobs-section-head[data-foldable]:focus-visible::before{opacity:1}
.knobs-section-head>.knobs-caret{grid-area:1/3;margin:0 calc((var(--k-icon-sm) - 20px) / 2 + 5px) 0 0;opacity:0;transition:transform ${LEAD_T},opacity .15s,color .15s}
.knobs-section-head:is(:hover,:focus-visible,[data-folded])>.knobs-caret{opacity:1}
.knobs-section-head:hover>.knobs-caret{color:var(--k-label)}
.knobs-section-head[aria-expanded="true"]>.knobs-caret{transform:rotate(90deg)}
.knobs-section-summary{display:none;grid-area:1/2;justify-self:end;min-width:0;overflow:hidden;text-overflow:ellipsis;font:500 var(--k-text-control)/1.25 var(--k-font);letter-spacing:0;color:var(--k-dim);font-variant-numeric:tabular-nums}
.knobs-section-head[data-folded]>.knobs-section-summary{display:block;animation:knobs-fade .2s var(--k-ease) both}
.knobs-section-desc,.knobs-group-desc{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--k-label-weight) var(--k-text-meta)/1.35 var(--k-font);letter-spacing:0;color:var(--k-dim);text-transform:none}
.knobs-section-desc{grid-area:2/1/3/4;margin-top:1px}
.knobs-group-desc{padding:0 var(--k-group-inset)}
.knobs-tile>.knobs-group-desc{margin:calc(2px - var(--k-head-gap)) 0 var(--k-head-gap)}
.knobs-tile:is([data-foldable],[data-collapsible])>.knobs-group-desc{margin:2px 0 0}
@keyframes knobs-fade{from{opacity:0}}
.knobs-tile{position:relative;min-width:0;padding:var(--k-pad);background:var(--k-bg);border:1px solid var(--k-line);border-radius:var(--k-panel-radius);box-shadow:inset 0 1px 0 var(--k-rim)}
.knobs-tile>.knobs-card{margin:0}
.knobs-tile[data-foldable]>.knobs-group-head{margin-bottom:0}
.knobs-tile[data-foldable]>.knobs-card{margin-top:var(--k-head-gap)}
/* A card's header is compact: as tall as its 20px controls, then a gap and a half before its rows. */
.knobs-tile>.knobs-group-head{position:relative;margin:0 0 var(--k-head-gap);min-height:20px;color:var(--k-text);font-size:var(--k-text-title);font-weight:var(--k-title-weight);letter-spacing:-.01em;text-transform:none}
.knobs-panel.knobs-page{--k-head-gap:calc(var(--k-gap) * 1.5)}
/* The title wins the header's room: what's on the right (presets, a summary) gives way first. */
.knobs-tile>.knobs-group-head>.knobs-group-title{flex:1 1 auto}
.knobs-tile>.knobs-group-head>span:last-child{flex:0 1000 auto;min-width:0}
.knobs-tile>.knobs-group-head :is(.knobs-group-reset,.knobs-group-die){flex:none}
/* A folded card's header trades its controls (presets, reset, die) for a summary of the card. */
.knobs-group-ctl{display:flex;align-items:center;gap:var(--k-tray-pad);min-width:0}
.knobs-group-summary{display:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--k-dim);font-size:var(--k-text-control);font-weight:500;letter-spacing:0;font-variant-numeric:tabular-nums}
.knobs-tile[data-folded]>.knobs-group-head .knobs-group-summary:not(:empty){display:block}
.knobs-tile[data-folded]>.knobs-group-head .knobs-group-ctl{display:none}
.knobs-tile[data-fold-motion]>.knobs-group-head :is(.knobs-group-summary,.knobs-group-ctl){animation:knobs-fade .2s var(--k-ease) both}
/* A highlight (page.highlight): the rest dims under a veil of the page's colour (--k-page-dim at
   full), and what's highlighted on its own gets a dot in the gutter by its title. The veil and
   dot are written each frame on the panel spring (see page.ts). */
.knobs-panel.knobs-page{--k-page-dim:.4}
.knobs-veil{position:absolute;inset:-1px;z-index:1;border-radius:inherit;background:var(--k-page);pointer-events:none}
.knobs-mark{position:absolute;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:var(--k-accent);pointer-events:none}
.knobs-tile>.knobs-mark{z-index:2;top:calc(var(--k-pad) + 10px);left:calc((var(--k-pad) + var(--k-inset) + 1px) / 2 - 1px)}
.knobs-section-head{position:relative}
.knobs-section-head>.knobs-mark{left:calc((var(--k-pad) + var(--k-inset) + 1px) / 2)}
.knobs-group-title{display:grid;flex:1;min-width:0}
.knobs-group-title>*{grid-area:1/1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:opacity .15s}
.knobs-peek{opacity:0;pointer-events:none}
.knobs-group-head[data-peek] .knobs-group-label{opacity:0}
.knobs-group-head[data-peek] .knobs-peek{opacity:1}
.knobs-group-head .knobs-chips.knobs-seg{flex:none;height:20px;max-width:none;gap:0;margin-right:var(--k-unit)}
.knobs-group-head .knobs-chips button{width:18px;height:100%;padding:0;font-size:var(--k-text-meta);font-weight:500;font-variant-numeric:tabular-nums;border-radius:var(--k-radius-sm);background:transparent}
.knobs-group-head .knobs-chips button[aria-checked="true"]{color:var(--k-text)}
/* Named presets: their names as segments beside the title, or a compact menu of them. */
.knobs-group-presets{display:flex;align-items:center;flex:0 1 auto;min-width:0;margin-right:var(--k-unit)}
.knobs-group-presets .knobs-seg{flex:none;height:20px;max-width:none;padding:var(--k-tray-pad)}
.knobs-group-presets .knobs-seg button{height:100%;padding:0 6px;font-size:var(--k-text-meta);font-weight:500;background:transparent}
.knobs-panel .knobs-group-presets .knobs-select{height:20px;max-width:11em;gap:3px;padding:0 3px 0 7px;font-size:var(--k-text-meta);font-weight:500;letter-spacing:0;text-transform:none}
.knobs-group-presets .knobs-select[data-none]{color:var(--k-dim)}
.knobs-group-presets .knobs-select .knobs-icon{width:calc(var(--k-icon-sm) - 3px);height:calc(var(--k-icon-sm) - 3px)}
.knobs-tile-body{display:flex;flex-direction:column}
.knobs-tile-body>.knobs-card{margin:0}
.knobs-panel .knobs-tile-body>.knobs-custom-actions{position:relative;margin:0}
.knobs-panel .knobs-tile-body>:not([hidden])~*{margin-top:var(--k-section-gap)}
.knobs-row-full .knobs-seg{flex:1;max-width:none}
.knobs-row-full .knobs-seg button{flex:1}
.knobs-item[role="button"]{cursor:pointer}
.knobs-card>.knobs-item:focus-visible{outline:none}
.knobs-card>.knobs-item:focus-visible::after{opacity:1}
/* A collapsible custom card: its header toggles it, with a caret and, while folded, a summary. */
.knobs-live[data-collapsible]>.knobs-group-head{margin-bottom:0;cursor:pointer;border-radius:var(--k-radius-sm);transition:background var(--k-hover-t)}
.knobs-live[data-collapsible]>.knobs-group-head:focus-visible{background:var(--k-surface)}
.knobs-live[data-collapsible]>.knobs-tile-body{margin-top:var(--k-head-gap);transition:opacity var(--k-token-t)}
.knobs-live[data-collapsed]>.knobs-tile-body{opacity:0}
.knobs-live>.knobs-tile-body[data-folding]{position:absolute;left:var(--k-pad);right:var(--k-pad);margin-top:0}
.knobs-card-right{display:flex;align-items:center;gap:6px;min-width:0}
.knobs-card-side{display:grid;justify-items:end;min-width:0}
.knobs-card-side>*{grid-area:1/1;min-width:0;max-width:100%;transition:opacity var(--k-token-t)}
.knobs-card-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--k-dim);font-size:var(--k-text-control);font-weight:500;letter-spacing:0;opacity:0;pointer-events:none}
.knobs-live[data-collapsed] .knobs-card-summary{opacity:1;pointer-events:auto}
.knobs-live[data-collapsed] .knobs-card-summary:not(:empty)~*{opacity:0;pointer-events:none}
.knobs-card-right>.knobs-caret{margin-right:calc((var(--k-icon-sm) - 20px) / 2 + 5px)}
.knobs-live>.knobs-group-head:hover .knobs-caret{color:var(--k-label)}
.knobs-live>.knobs-group-head[aria-expanded="true"] .knobs-caret{transform:rotate(90deg)}
.knobs-item-detail{flex:none;color:var(--k-dim);font-size:var(--k-text-control);font-variant-numeric:tabular-nums;white-space:nowrap}
`
/** Adds a token preset's stylesheet once per document. */
export function injectPreset(doc: Document, preset: TokenPreset) {
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
/**
 * Keys move a panel's focus wash; the pointer resting where it last was mustn't keep a hover wash
 * of its own meanwhile. Typing marks the panel `data-keyboard` until the pointer moves again, and
 * the elements under the pointer `data-k-quiet`, where no hover state matches. (Only those: a rule
 * on `[data-keyboard] *` restyled the whole panel on the first key after the pointer.)
 */
const keyboardQuietsHover = (css: string) =>
  css.replaceAll(":hover", ":hover:where(:not([data-k-quiet]))")
/** The rules' `:has()` as the attributes has.ts keeps (see there for why). */
export const withoutHas = (css: string) =>
  css
    .replaceAll(
      ".knobs-x:has(>.knobs-x-head:is(:hover,:focus-visible))",
      '.knobs-x:is([data-k-head-hover]:where(:not([data-k-quiet])),[data-k-fv="head"])',
    )
    .replaceAll(":has(:focus-visible)", "[data-k-fv]")
    .replaceAll(":has(.knobs-track:focus-visible)", '[data-k-fv="track"]')
    .replaceAll(":has(.knobs-active)", "[data-k-active]")
export function injectStyles(doc: Document) {
  const content = rolling + DRIVERS + defaultsCss + keyboardQuietsHover(withoutHas(aliased(css)))
  const existing = doc.querySelector<HTMLStyleElement>("style[data-knobs-style]")
  if (existing) {
    if (existing.textContent !== content) existing.textContent = content
    return
  }
  const style = doc.createElement("style")
  style.dataset.knobsStyle = ""
  style.textContent = content
  doc.head.append(style)
}
