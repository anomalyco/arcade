// Readouts' styles. They read the --ku-* tokens, which a readout's own root defines from the
// public --k-* tokens (a panel's, a preset's or the defaults), so a readout in a panel row and one
// standing alone look the same.
export const readoutCss = `
/* Readouts: live values, sparklines, graphs, meters, tables and logs. */
:where(.knobs-ui) :is(.knobs-rd-chip,.knobs-rd-copy,.knobs-rd-jump,.knobs-rd-find,.knobs-rd-match){all:revert;box-sizing:border-box;
  font:inherit;color:inherit;letter-spacing:inherit;background:transparent;border:0;border-radius:0;margin:0;padding:0;min-width:0;box-shadow:none;outline:none}
.knobs-ui.knobs-rd,.knobs-rd *{box-sizing:border-box}
.knobs-ui.knobs-rd{display:flex;align-items:center;gap:8px;min-width:0;color:var(--ku-text);letter-spacing:normal}
.knobs-rd .knobs-rd-v{font:var(--ku-font-weight) var(--ku-value-size)/1.25 var(--ku-value-font);font-variant-numeric:tabular-nums;font-feature-settings:"tnum";white-space:nowrap}
.knobs-rd .knobs-rd-mono{font:400 var(--ku-text-meta)/1.25 var(--ku-mono);font-variant-numeric:tabular-nums;white-space:pre}
.knobs-rd .knobs-rd-meta{font:var(--ku-font-weight) var(--ku-text-meta)/1.25 var(--ku-font);white-space:nowrap}
.knobs-rd .knobs-rd-value{display:inline-flex;justify-content:flex-end;align-items:baseline;flex:none;margin-left:auto;contain:layout paint style}
.knobs-rd .knobs-rd-num{color:var(--ku-text);transition:color .15s}
.knobs-rd .knobs-rd-unit{margin-left:var(--k-unit-gap,.28em);color:var(--ku-dim)}
.knobs-rd .knobs-rd-unit[hidden]{display:none}
.knobs-rd.knobs-rd-watch{flex:1 1 auto;justify-content:flex-end}
.knobs-rd.knobs-rd-spark,.knobs-rd.knobs-rd-meter{flex:0 1 64%;margin-left:auto}
.knobs-rd .knobs-rd-plot{display:block;flex:1 1 0;min-width:24px;height:max(12px,calc(var(--ku-control-h) - 2px))}
.knobs-rd.knobs-rd-meter>.knobs-rd-plot{height:8px}
.knobs-rd.knobs-rd-spark[data-hover] .knobs-rd-num{color:var(--ku-label)}
.knobs-rd .knobs-rd-cap,.knobs-rd .knobs-rd-head>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ku-label);font-weight:var(--ku-label-weight)}

/* Blocks: a head line (the label and what goes with it) over a body. In a panel the row grows to fit. */
.knobs-panel .knobs-row.knobs-rd-rowblock{display:block;height:auto}
.knobs-rd.knobs-rd-block{display:flex;flex-direction:column;align-items:stretch;gap:2px;width:100%}
.knobs-rd .knobs-rd-head{display:flex;align-items:center;gap:10px;height:var(--ku-row);min-width:0}
.knobs-rd .knobs-rd-legend{display:flex;align-items:center;gap:12px;margin-left:auto;min-width:0;overflow:hidden}
.knobs-rd .knobs-rd-key{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.knobs-rd .knobs-rd-swatch{flex:none;width:8px;height:2px;border-radius:1px}
.knobs-rd .knobs-rd-name{color:var(--ku-label)}
.knobs-rd .knobs-rd-key>.knobs-rd-value{margin-left:2px}
.knobs-rd .knobs-rd-plotbox{position:relative;outline:none;margin-bottom:6px}
.knobs-rd .knobs-rd-plotbox>.knobs-rd-plot{position:absolute;inset:0;width:100%;height:100%;min-width:0}
.knobs-rd .knobs-rd-tick,.knobs-rd .knobs-rd-mark{position:absolute;color:var(--ku-dim);pointer-events:none;line-height:14px;height:14px}
.knobs-rd .knobs-rd-tick{left:0}
.knobs-rd .knobs-rd-tick[data-at="top"]{top:-2px}
.knobs-rd .knobs-rd-tick[data-at="bottom"]{bottom:0}
.knobs-rd .knobs-rd-mark{right:0;top:0}
.knobs-rd .knobs-rd-mark[hidden]{display:none}

.knobs-rd .knobs-rd-grid{display:grid;column-gap:14px;align-items:center;outline:none;margin-bottom:4px}
.knobs-rd .knobs-rd-tr{display:contents}
.knobs-rd .knobs-rd-tr>*{height:calc(var(--ku-row) * .72);line-height:calc(var(--ku-row) * .72);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knobs-rd .knobs-rd-thead>*{height:var(--ku-row);line-height:var(--ku-row)}
.knobs-rd .knobs-rd-th{color:var(--ku-dim);text-align:right}
.knobs-rd .knobs-rd-td{color:var(--ku-text)}
.knobs-rd .knobs-rd-td:first-child{color:var(--ku-label)}
.knobs-rd .knobs-rd-td[data-num]{text-align:right}

.knobs-rd.knobs-rd-log{--rd-lh:18px}
.knobs-rd .knobs-rd-chips{display:inline-flex;align-items:center;gap:2px;margin-left:auto}
.knobs-ui .knobs-rd-chip,.knobs-ui .knobs-rd-copy{height:calc(var(--ku-control-h) - 2px);padding:0 7px;border-radius:min(var(--ku-radius),5px);color:var(--ku-label);cursor:pointer;transition:background .15s,color .15s}
.knobs-ui .knobs-rd-chip:hover,.knobs-ui .knobs-rd-copy:hover{background:var(--ku-wash);color:var(--ku-text)}
.knobs-ui .knobs-rd-chip[aria-checked="true"]{background:var(--ku-wash-hi);color:var(--ku-text)}
.knobs-ui .knobs-rd-find{width:84px;height:calc(var(--ku-control-h) - 2px);padding:0 7px;border-radius:min(var(--ku-radius),5px);
  background:color-mix(in srgb,var(--ku-surface-hi) 60%,transparent);color:var(--ku-text);caret-color:var(--ku-accent)}
.knobs-rd .knobs-rd-find::placeholder{color:var(--ku-dim)}
.knobs-rd .knobs-rd-find::-webkit-search-cancel-button{display:none}
.knobs-rd .knobs-rd-logbody{position:relative;margin-bottom:6px}
.knobs-rd .knobs-rd-scroll{position:relative;overflow-x:hidden;overflow-y:auto;height:calc(var(--knobs-rd-lines,8) * var(--rd-lh));outline:none;
  background:color-mix(in srgb,var(--ku-surface-hi) 45%,transparent);border-radius:min(var(--ku-radius),6px);scrollbar-width:thin;overscroll-behavior:contain}
.knobs-rd .knobs-rd-space{position:relative;width:100%}
.knobs-rd .knobs-rd-line{position:absolute;left:0;right:0;top:0;display:flex;gap:10px;height:var(--rd-lh);line-height:var(--rd-lh);padding:0 8px;contain:layout style;will-change:transform}
.knobs-rd .knobs-rd-line[hidden]{display:none}
.knobs-rd .knobs-rd-time{flex:none;color:var(--ku-dim)}
.knobs-rd .knobs-rd-text{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--ku-text)}
.knobs-rd .knobs-rd-line[data-level="warn"]>.knobs-rd-text{color:var(--ku-warn)}
.knobs-rd .knobs-rd-line[data-level="error"]>.knobs-rd-text{color:var(--ku-critical)}
.knobs-rd .knobs-rd-line[data-level="debug"]>.knobs-rd-text{color:var(--ku-dim)}
.knobs-ui .knobs-rd-match{color:var(--ku-accent)}
.knobs-ui .knobs-rd-jump{position:absolute;left:50%;bottom:6px;height:20px;padding:0 10px;border-radius:calc(var(--ku-radius) * 999);
  background:var(--ku-accent);color:var(--ku-bg);opacity:0;transform:translate(-50%,6px);cursor:pointer;white-space:nowrap}

/* Under the GPU overlay the readouts' DOM stays for focus, hit-testing and screen readers; the
   overlay draws them. Their filter field sits above it. */
.knobs-panel[data-gpu-active="true"] .knobs-rd :where(*:not(.knobs-rd-find)),.knobs-panel[data-gpu-active="true"] .knobs-rd{color:transparent!important;background:transparent!important;border-color:transparent!important;box-shadow:none!important}
.knobs-panel[data-gpu-active="true"] .knobs-rd-plot{visibility:hidden}
.knobs-panel[data-gpu-active="true"] .knobs-rd-find{position:relative;z-index:2147480003}
@media(prefers-reduced-motion:reduce){.knobs-rd :where(*){transition:none!important}}
`
