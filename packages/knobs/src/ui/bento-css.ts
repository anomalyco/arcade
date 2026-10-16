// The bento: tiles on the page with hairline gutters and nothing else. No cards, borders or
// shadows; labels are type on hover; a pick is a dot; the keyboard's place is a soft wash.
export const bentoCss = `
.knobs-ui.knobs-bento{--ku-bento-radius:var(--k-ui-bento-radius,max(0px,calc(var(--ku-radius) - 5px)));
  position:relative;width:100%;height:100%;overflow:hidden auto;outline:none;background:var(--k-ui-bento-bg,var(--ku-page));
  scrollbar-width:thin;scrollbar-gutter:stable;overscroll-behavior:contain;touch-action:pan-y;user-select:none;-webkit-user-select:none;
  font:var(--ku-font-weight) var(--ku-font-size)/1.35 var(--ku-font);color:var(--ku-text);letter-spacing:normal;text-align:left}
.knobs-bento[data-frame="flat"]{--ku-bento-radius:var(--k-ui-bento-radius,0px)}
.knobs-bento[data-pending] .knobs-bento-space{visibility:hidden}
:where(.knobs-bento-space,.knobs-bento-space *){box-sizing:border-box}
.knobs-bento-space{position:relative;width:100%}
.knobs-bento-tile{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden;border-radius:var(--ku-bento-radius);
  background:var(--ku-surface);contain:strict;cursor:zoom-in}
.knobs-bento-tile[data-focus]{z-index:2;cursor:zoom-out}
.knobs-bento-tile[data-focus][data-live]{cursor:auto}
.knobs-bento-img{display:block;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .18s cubic-bezier(.2,.8,.2,1);-webkit-user-drag:none}
.knobs-bento-tile[data-ready] .knobs-bento-img{opacity:1}
.knobs-bento-tile[data-instant] .knobs-bento-img{transition:none}
.knobs-bento-body{position:absolute;inset:0;pointer-events:none}
.knobs-bento-tile[data-focus] .knobs-bento-body{pointer-events:auto}
.knobs-bento-label{position:absolute;left:9px;right:9px;bottom:7px;color:#fff;font-size:var(--ku-text-meta);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  text-shadow:0 0 6px rgba(0,0,0,.55),0 0 1px rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity calc(var(--ku-hover-out) * 1ms)}
.knobs-bento:not([data-keyboard]) .knobs-bento-tile:hover .knobs-bento-label,
.knobs-bento[data-keyboard]:focus .knobs-bento-tile[data-active] .knobs-bento-label,
.knobs-bento-tile[data-focus] .knobs-bento-label{opacity:1;transition-duration:calc(var(--ku-hover-in) * 1ms)}
/* A pick: a small dot in the accent, ringed in the page so it reads on any picture. */
.knobs-bento-tile::after{content:"";position:absolute;top:8px;right:8px;width:8px;height:8px;border-radius:50%;background:var(--ku-accent);
  box-shadow:0 0 0 1.5px color-mix(in srgb,var(--ku-page) 70%,transparent);opacity:0;scale:.4;pointer-events:none;
  transition:opacity .11s cubic-bezier(.4,0,1,1),scale var(--ku-ease-ms) var(--ku-ease)}
.knobs-bento-tile[aria-selected="true"]::after{opacity:1;scale:1;transition:opacity .15s cubic-bezier(.2,.8,.2,1),scale var(--ku-ease-ms) var(--ku-ease)}
.knobs-bento-wash{position:absolute;left:0;top:0;width:100px;height:100px;transform-origin:0 0;z-index:3;pointer-events:none;border-radius:var(--ku-bento-radius);
  background:color-mix(in srgb,var(--ku-accent) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ku-accent) 45%,transparent);
  opacity:0;transition:opacity .15s}
.knobs-bento[data-keyboard]:focus:not([data-zoomed]) .knobs-bento-wash[data-on]{opacity:1}
.knobs-bento-scrim{position:absolute;left:0;top:0;width:100%;z-index:1;background:var(--k-ui-scrim,var(--k-ui-bento-bg,var(--ku-page)));opacity:0;pointer-events:none;cursor:zoom-out}
.knobs-bento[data-zoomed] .knobs-bento-scrim{pointer-events:auto}
.knobs-bento-head{position:absolute;left:0;top:0;display:flex;align-items:flex-end;padding:0 0 6px 2px;color:var(--ku-label);font-weight:var(--ku-label-weight);
  font-size:var(--ku-text-meta);white-space:nowrap;pointer-events:none}
`
