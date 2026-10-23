import { RADIO, RADIO_CONTROLS, RADIO_DEFAULTS, RADIO_LINES, type RadioLine } from "../audio/radio"
import type { Life } from "../game/life"
import { BIRD_CONTROLS, BIRD_DEFAULTS, BIRDS } from "../render/birds"
import { CANOPY_RAIN, CANOPY_RAIN_CONTROLS, CANOPY_RAIN_DEFAULTS } from "../render/canopy-rain"
import type { DevSection } from "./dev-panel"

/**
 * Life around you on the dev panel: radio chatter (Audio tab: filter, squelch, duck, gaps, and a button per line to
 * hear it through the radio), seabirds and canopy rain (World tab). Every value is read live.
 */
export function lifeSections(life: Life): DevSection[] {
  const lines = Object.keys(RADIO_LINES) as RadioLine[]
  return [
    {
      id: "radio",
      tab: "Audio",
      bind: (panel) =>
        panel.addControls(
          RADIO,
          [
            ...RADIO_CONTROLS,
            {
              key: "radio-say",
              label: "Say",
              group: "Radio chatter",
              type: "buttons",
              items: lines.map((l) => ({ key: `radio-say-${l}`, label: l, run: () => void life.radio.say(l) })),
            },
          ],
          RADIO_DEFAULTS,
        ),
    },
    { id: "birds", tab: "World", bind: (panel) => panel.addControls(BIRDS, BIRD_CONTROLS, BIRD_DEFAULTS) },
    { id: "canopy-rain", tab: "World", bind: (panel) => panel.addControls(CANOPY_RAIN, CANOPY_RAIN_CONTROLS, CANOPY_RAIN_DEFAULTS) },
  ]
}
