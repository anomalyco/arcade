// What the board's HUD prototype bundles: the game's own HUD renderer, meter inputs and settings, with no camera,
// simulation or CSS imports. Build: bun build scripts/hud-prototype-entry.ts --format esm --outfile <dir>/game-hud.js
export { CharacterHud, LOCAL_ACTOR } from "../src/hud/character"
export { localVitals } from "../src/hud/vitals"
export { DEFAULT_HUD_SETTINGS } from "../src/hud/settings"
export { STYLES, STYLE_TODAY, STYLE_BELOW, STYLE_HADES, STYLE_ZOMBOID, STYLE_DIEGETIC } from "../src/hud/styles"
export { CALLOUTS_STYLE, CALLOUTS_BELOW, CALLOUTS_ABOVE, CALLOUTS_BESIDE, VITALS_STYLE, VITALS_BESIDE, VITALS_FEET } from "../src/hud/placement"
export { installKeyCapStyles } from "@arcade/kit/client/key-cap"
