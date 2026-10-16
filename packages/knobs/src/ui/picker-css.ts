import { springEasing } from "../core/spring.js"

const snappy = springEasing((2 * Math.PI) / 0.25, 1)

// The option picker: a column of options, the selected one on a card that glides between them
// and holds its parameters (whatever `body` mounts, usually a knobs panel) opening under it.
// Nothing here makes a stacking context at rest, so a panel inside stays on the GPU.
export const pickerCss = `
:where(.knobs-picker,.knobs-picker-option,.knobs-picker-head,.knobs-picker-head *,.knobs-picker-card,.knobs-picker-body){box-sizing:border-box}
.knobs-ui.knobs-picker{position:relative;display:flex;flex-direction:column;gap:2px;padding:0;outline:none;
  font:var(--ku-font-weight) var(--ku-font-size)/1.35 var(--ku-font);color:var(--ku-text);text-align:left;letter-spacing:normal;-webkit-font-smoothing:antialiased;
  --kp-card:var(--k-picker-card,var(--ku-surface));--kp-radius:var(--k-picker-radius,var(--ku-panel-radius));--kp-snappy:${snappy.easing};--kp-snappy-ms:${snappy.ms}ms}
.knobs-picker [hidden]{display:none!important}
/* The selection: one card behind the selected option and its parameters, gliding between them. */
.knobs-picker-card{position:absolute;left:0;right:0;top:0;height:0;border-radius:var(--kp-radius);background:var(--kp-card);box-shadow:inset 0 0 0 1px var(--ku-line);pointer-events:none}
.knobs-picker[data-frame="flat"] .knobs-picker-card{box-shadow:none}
.knobs-picker-option{position:relative;flex:none}
:where(.knobs-ui) .knobs-picker-head{all:revert;box-sizing:border-box;position:relative;display:flex;align-items:center;gap:8px;width:100%;height:var(--ku-row);padding:0 calc(var(--ku-inset) - 2px) 0 calc(var(--ku-inset) - 4px);
  border:0;margin:0;background:transparent;color:var(--ku-label);font:inherit;letter-spacing:inherit;text-align:left;cursor:default;outline:none;user-select:none;-webkit-user-select:none}
/* Hover: in at once, out over 100 ms. Keyboard focus: the same wash, a little firmer. */
.knobs-picker-head::before{content:"";position:absolute;inset:0;border-radius:var(--kp-radius);background:var(--ku-wash);opacity:0;transition:opacity calc(var(--k-hover-out,100) * 1ms) ease-out;pointer-events:none}
.knobs-picker-option:not([data-selected]) .knobs-picker-head:hover::before{opacity:1;transition-duration:calc(var(--k-hover-in,0) * 1ms)}
.knobs-picker-head:focus-visible::before{opacity:1;background:var(--ku-wash-hi);transition-duration:0s}
.knobs-picker-head>*{position:relative}
.knobs-picker-option[data-selected] .knobs-picker-head{color:var(--ku-text)}
.knobs-picker-key{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 4px;border-radius:5px;background:var(--ku-surface);
  color:var(--ku-dim);font:var(--ku-label-weight) calc(var(--ku-font-size) - 1.5px)/1 var(--ku-font);font-variant-numeric:tabular-nums;transition:background .15s,color .15s}
.knobs-picker-key:empty{visibility:hidden}
.knobs-picker-option[data-selected] .knobs-picker-key{background:var(--ku-surface-hi);color:var(--ku-text)}
.knobs-picker-name{flex:1;min-width:0;overflow:hidden;white-space:nowrap;font-weight:var(--ku-label-weight)}
.knobs-picker-suggested{flex:none;color:var(--ku-dim);font-size:var(--ku-text-meta)}
.knobs-picker-check{flex:none;display:flex;width:14px;height:14px;color:var(--ku-accent);opacity:0;scale:.6;filter:blur(2px);
  transition:opacity .11s ease-in,scale .11s ease-in,filter .11s ease-in}
.knobs-picker-check svg{display:block;width:14px;height:14px}
.knobs-picker-option[data-chosen] .knobs-picker-check{opacity:1;scale:1;filter:none;transition:opacity .15s ease-out,scale var(--kp-snappy-ms) var(--kp-snappy),filter .15s ease-out}
.knobs-picker-body{position:relative;overflow:visible}
.knobs-picker-body[data-moving]{overflow:hidden}
.knobs-picker-inner{padding:0 0 6px}
/* A panel inside sheds its own card for the picker's, so nothing draws a card inside a card. */
.knobs-picker-inner .knobs-panel.knobs-inline{--k-chrome:0}
.knobs-picker-empty{padding:8px var(--ku-inset);color:var(--ku-dim)}
@media(prefers-reduced-motion:reduce){.knobs-picker :where(*,::before,::after){transition-duration:.15s!important;scale:none!important;filter:none!important}}
`
