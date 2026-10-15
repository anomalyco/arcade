// Overlays: popovers, tooltips, the command palette, confirms and toasts. They live in one fixed
// layer above the page and the GPU overlay. Selectors are (0,2,0) so a toast inside a page wins
// over the panel's reset.
export const overlayCss = `
.knobs-layers{position:fixed;inset:0;z-index:2147480005;pointer-events:none}
.knobs-layers>.knobs-layer,.knobs-ui.knobs-toast{position:fixed;left:0;top:0;box-sizing:border-box;pointer-events:auto;outline:none;
  font:var(--ku-font-weight) var(--ku-font-size)/1.4 var(--ku-font);color:var(--ku-text);letter-spacing:normal;text-align:left;text-transform:none;
  -webkit-font-smoothing:antialiased;will-change:transform,opacity,filter}
/* The overlays' own elements stop a host's element rules; what you put in a popover is yours. */
:where(.knobs-layers,.knobs-toast) :is(.knobs-kbd,.knobs-palette-input,.knobs-palette-label>mark,.knobs-confirm-title,.knobs-confirm-body,.knobs-confirm-btn,.knobs-toast-action){all:revert;box-sizing:border-box;font:inherit;color:inherit;letter-spacing:inherit;
  background:transparent;border:0;margin:0;padding:0;outline:none;box-shadow:none}
.knobs-layers .knobs-layer *{box-sizing:border-box}
/* A floating surface: frosted, a hairline rim, a soft shadow. */
.knobs-layers>:is(.knobs-popover-layer,.knobs-palette,.knobs-confirm){background:color-mix(in srgb,var(--ku-bg) 88%,transparent);
  -webkit-backdrop-filter:blur(28px) saturate(1.7);backdrop-filter:blur(28px) saturate(1.7);border-radius:calc(var(--ku-radius) + 3px);
  box-shadow:0 0 0 .5px var(--ku-line-hi),0 12px 40px rgba(0,0,0,.36),0 2px 8px rgba(0,0,0,.18)}
.knobs-layers>.knobs-popover-layer{min-width:120px;max-width:min(420px,calc(100vw - 16px));padding:6px}
.knobs-popover-layer .knobs-popover-text{padding:4px 6px;color:var(--ku-label)}

.knobs-layers>.knobs-tooltip{display:inline-flex;align-items:center;gap:7px;max-width:300px;padding:4px 8px;pointer-events:none;white-space:nowrap;
  font-size:calc(var(--ku-font-size) - .5px);background:var(--ku-bg);color:var(--ku-text);border-radius:min(var(--ku-radius),6px);
  box-shadow:0 0 0 .5px var(--ku-line-hi),0 4px 14px rgba(0,0,0,.3)}
.knobs-tooltip .knobs-tooltip-text{overflow:hidden;text-overflow:ellipsis}
.knobs-layer :is(.knobs-tooltip-keys,.knobs-palette-keys){display:inline-flex;gap:2px;flex:none}
.knobs-layer .knobs-tooltip-keys[hidden]{display:none}
.knobs-layer .knobs-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 4px;
  border-radius:min(var(--ku-radius),4px);background:var(--ku-surface-hi);color:var(--ku-label);font:500 calc(var(--ku-font-size) - 1.5px)/1 var(--ku-font)}

.knobs-layers>.knobs-palette{left:50%;top:max(48px,15vh);translate:-50% 0;transform-origin:50% 0;display:flex;flex-direction:column;
  width:min(580px,calc(100vw - 32px));max-height:min(460px,72vh);overflow:hidden}
.knobs-palette .knobs-palette-field{display:flex;align-items:center;gap:10px;flex:none;height:46px;padding:0 16px;border-bottom:1px solid var(--ku-line);color:var(--ku-dim)}
.knobs-palette .knobs-palette-field svg{width:15px;height:15px;flex:none}
.knobs-palette .knobs-palette-input{flex:1;min-width:0;height:100%;font-size:calc(var(--ku-font-size) + 3px);color:var(--ku-text);caret-color:var(--ku-accent)}
.knobs-palette .knobs-palette-input::placeholder{color:var(--ku-dim)}
.knobs-palette .knobs-palette-list{position:relative;flex:1;min-height:0;overflow:auto;padding:6px;scrollbar-width:thin;overscroll-behavior:contain}
.knobs-palette .knobs-palette-hl{position:absolute;left:6px;right:6px;top:0;border-radius:min(var(--ku-radius),7px);background:var(--ku-wash-hi);opacity:0;pointer-events:none;
  transition:transform var(--ku-ease-ms) var(--ku-ease),height var(--ku-ease-ms) var(--ku-ease),opacity .12s}
.knobs-palette .knobs-palette-section{padding:10px 10px 4px;color:var(--ku-dim);font-size:calc(var(--ku-font-size) - 1px);font-weight:var(--ku-label-weight);user-select:none}
.knobs-palette .knobs-palette-section:first-of-type{padding-top:4px}
.knobs-palette .knobs-palette-item{position:relative;display:flex;align-items:center;gap:8px;height:max(32px,var(--ku-row));padding:0 10px;
  color:var(--ku-label);cursor:default;user-select:none}
.knobs-palette .knobs-palette-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ku-text)}
/* Searching, the label dims and its matched letters light up. */
.knobs-palette[data-query] .knobs-palette-label{color:var(--ku-label)}
.knobs-palette .knobs-palette-label mark{color:var(--ku-accent);font-weight:var(--ku-title-weight)}
.knobs-palette[data-query] .knobs-palette-item[data-active] .knobs-palette-label{color:var(--ku-text)}
.knobs-palette .knobs-palette-hint{flex:none;color:var(--ku-dim)}
.knobs-palette .knobs-palette-fill{flex:1}
.knobs-palette .knobs-palette-tag{flex:none;color:var(--ku-dim);font-size:calc(var(--ku-font-size) - 1px);white-space:nowrap}
.knobs-palette .knobs-palette-item[aria-disabled="true"]{opacity:.4}
.knobs-palette .knobs-palette-empty{padding:18px 10px;color:var(--ku-dim);text-align:center}

.knobs-layers>.knobs-scrim{inset:0;width:100%;height:100%;background:rgba(0,0,0,.3)}
.knobs-layers>.knobs-confirm{left:50%;top:42%;translate:-50% -50%;width:min(340px,calc(100vw - 32px));padding:18px 18px 14px}
.knobs-confirm .knobs-confirm-title{margin:0 0 6px;font-size:calc(var(--ku-font-size) + 1.5px);font-weight:var(--ku-title-weight);color:var(--ku-text);line-height:1.3}
.knobs-confirm .knobs-confirm-body{margin:0;color:var(--ku-label);line-height:1.45}
.knobs-confirm .knobs-confirm-buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.knobs-confirm .knobs-confirm-btn{height:28px;padding:0 14px;border-radius:min(var(--ku-radius),7px);background:var(--ku-surface-hi);color:var(--ku-text);
  font-weight:var(--ku-label-weight);cursor:pointer;transition:background .15s,filter .15s}
.knobs-confirm .knobs-confirm-cancel:is(:hover,:focus-visible){background:color-mix(in srgb,var(--ku-text) 18%,transparent)}
.knobs-confirm .knobs-confirm-ok{background:var(--ku-accent);color:var(--ku-bg)}
.knobs-confirm .knobs-confirm-ok[data-destructive]{background:var(--ku-critical);color:#fff}
.knobs-confirm .knobs-confirm-ok:is(:hover,:focus-visible){filter:brightness(1.14)}

.knobs-ui.knobs-toast{left:50%;top:auto;bottom:24px;z-index:2147480005;translate:-50% 0;display:inline-flex;align-items:center;gap:10px;
  max-width:min(480px,80vw);padding:8px 16px;background:var(--ku-bg);color:var(--ku-text);border-radius:calc(var(--ku-radius) * 999);
  box-shadow:0 0 0 .5px var(--ku-line-hi),0 8px 28px rgba(0,0,0,.32)}
.knobs-toast .knobs-toast-text{overflow-wrap:anywhere}
.knobs-toast[data-tone="warn"]::before,.knobs-toast[data-tone="error"]::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--ku-warn)}
.knobs-toast[data-tone="error"]::before{background:var(--ku-critical)}
.knobs-toast .knobs-toast-action{flex:none;color:var(--ku-accent);font-weight:var(--ku-title-weight);cursor:pointer}
.knobs-toast .knobs-toast-action[hidden]{display:none}
`
