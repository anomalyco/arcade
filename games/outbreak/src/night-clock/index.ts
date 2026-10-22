import { COOP_TIME_SCALE } from "../../shared/coop-config"
import { townNight } from "../details/touches"
import { registerOutbreakClientFeature } from "../feature-registry"
import { NightClock } from "./clock"
import { nightClockReading } from "./reading"
import { NIGHT_CLOCK_TODAY, nightClockControls, type NightClockSettings } from "./settings"

/**
 * The night clock (playtest Oct 21, 1:38:07 "I have no concept of how much time is left"; Kit: "There should
 * definitely be like a clock"): how long until dawn, at the top left (Backquote › HUD › Night clock). The Diegetic HUD
 * hides the summary that carried the hour, so the night had no end you could see.
 */
let clock: NightClock | null = null

export const outbreakNightClockFeature = registerOutbreakClientFeature({
  id: "nightClock",
  order: 63,
  labControls: () => nightClockControls,
  frame: {
    overlay: (ctx) => {
      if (typeof document === "undefined") return
      const s = ctx.settings.hud as unknown as NightClockSettings
      if (s.nightClock === NIGHT_CLOCK_TODAY) {
        clock?.draw(null, 0)
        return
      }
      clock ??= new NightClock()
      const timeScale = ctx.coop.net ? COOP_TIME_SCALE : ctx.settings.dayCycle.timeScale
      clock.draw(nightClockReading(ctx.session.view.hour, timeScale, s.nightClockWarn), townNight(ctx.session.sim))
    },
  },
  harnessState: () => ({ nightClock: clock?.shown ? { ...clock.shown } : null }),
})
