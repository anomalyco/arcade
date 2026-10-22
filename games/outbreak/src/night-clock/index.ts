import { COOP_TIME_SCALE } from "../../shared/coop-config"
import { wrapHour } from "../../shared/day-cycle"
import { NIGHTFALL_HOUR, openingClockActive } from "../../shared/pacing"
import { isPracticeSession, isTrainingSession } from "../onboarding/session"
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
/** Game hours a co-op room has run, as seen here (the replica's own `elapsedHours` never advances). */
let watched: { sim: object; hour: number; elapsed: number } | null = null

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
      // The training room and the lobby's practice hold the clock at dawn: there is no night to count.
      if (isTrainingSession(ctx.session) || isPracticeSession(ctx.session)) {
        clock.draw(null, 0)
        return
      }
      const { sim } = ctx.session
      const hour = ctx.session.view.hour
      let elapsed = sim.elapsedHours
      if (ctx.coop.net) {
        if (watched?.sim !== sim) watched = { sim, hour, elapsed: 0 }
        // Interpolation can step the hour back a hair; that is not a day gone by.
        const step = wrapHour(hour - watched.hour)
        if (step < 12) watched.elapsed += step
        watched.hour = hour
        elapsed = watched.elapsed
      }
      const timeScale = ctx.coop.net ? COOP_TIME_SCALE : ctx.settings.dayCycle.timeScale
      const pacing = sim.ai.config
      const night = townNight(sim)
      const opening = night <= 1 && openingClockActive(pacing.directorPacing, hour, elapsed) ? { factor: pacing.openingClock, until: NIGHTFALL_HOUR } : null
      clock.draw(nightClockReading(hour, timeScale, s.nightClockWarn, opening), night)
    },
  },
  harnessState: () => ({ nightClock: clock?.shown ? { ...clock.shown } : null }),
})
