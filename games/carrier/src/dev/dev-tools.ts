import type { GameQuality } from "@arcade/kit/client/quality"
import { WEATHER_KINDS, type WeatherKind } from "../../shared/weather"
import { MixerLab } from "../audio/mixer-lab"
import type { JetAudio } from "../audio/jet-audio"
import { SoundsLab } from "../audio/sounds-lab"
import type { Game } from "../game/game"
import type { Input } from "../input"
import type { Net } from "../net"
import type { Camera } from "../render/camera"
import type { DayNight } from "../render/daynight"
import { TimeLab } from "../render/daynight-lab"
import type { WeatherSystem } from "../render/weather-system"
import { BotsLab, type BotsHost } from "./bots-lab"
import { DevPanel } from "./dev-panel"
import { feelSection } from "./feel-lab"
import { juiceSection } from "./juice-lab"
import { radarSection } from "./radar-lab"
import { sightSection } from "./sight-lab"
import { feedbackSection } from "./feedback-lab"
import type { FlightModule } from "../flight/seam"
import { viewSection } from "./view-lab"
import { WeatherLab } from "./weather-lab"
import type { CarrierQuality } from "../quality"
import { zonesSection } from "../objective/lab"
import { applyZoneRules } from "../objective/zones"
import type { Ocean } from "../render/ocean"
import { waterSection } from "./water-lab"

export { localRoom } from "./local-room"

export type DevToolsContext = {
  params: URLSearchParams
  device: GPUDevice
  camera: Camera
  input: Input
  weather: WeatherSystem
  daynight: DayNight
  ocean: Ocean
  game: Game
  audio: JetAudio
  /** The current connection (it changes when the menu picks another room). */
  net: () => Net
  bots: Omit<BotsHost, "net">
  quality: GameQuality<CarrierQuality>
  /** The flight module (the feedback section previews damage and rewards on it). */
  flight: FlightModule
}

/**
 * Dev builds only: main.ts imports this module behind `import.meta.env.DEV`, so production bundles contain none of it.
 * The dev panel (the shared Lab panel, Backquote) and its tabs: World (weather, time; ?lab=weather or ?lab=time opens
 * it there, ?weather=kind previews a weather locally), Audio, Sounds (?sounds=1), Flight (bombsight, radar), Bots
 * (?bots opens it), Game (zones, quality, volume, key labels, camera shake). Add dev sections here, never in main.ts.
 */
export function installDevTools(ctx: DevToolsContext) {
  const { params, camera, input, game } = ctx
  const panel = new DevPanel(() => {
    input.suspend()
    input.release()
  })
  const lab = new WeatherLab({
    system: ctx.weather,
    device: ctx.device,
    focus: () => [camera.eye[0]! + camera.forward[0]! * 200, camera.eye[2]! + camera.forward[2]! * 200],
    broadcast: (to, fade) => ctx.net().sendWeather(to, fade),
    ship: () => game.state.ship,
  })
  const bots = new BotsLab({ ...ctx.bots, net: ctx.net })
  panel.add(
    lab.section,
    waterSection(ctx.ocean),
    new TimeLab({ daynight: ctx.daynight, broadcast: (hour, speed, fade) => ctx.net().sendTime(hour, speed, fade) }).section,
    // AUDIO: levels, jet sound tuning and test buttons (M mutes anywhere).
    new MixerLab(ctx.audio).section,
    // SOUNDS: the audition board (every sound slot's candidate takes; pick by ear).
    new SoundsLab().section,
    sightSection,
    radarSection,
    // FEEL: the flight camera's lean, lag, kicks and the g-load grey-out (src/flight/feel.ts).
    feelSection,
    // JUICE: vapour, the vapour cone, burner, heat shimmer and sea spray (src/render/flight-fx.ts).
    juiceSection,
    // FEEDBACK: damage and reward feedback (canopy, damage edge, kill moment, callouts, close calls) and previews.
    feedbackSection(ctx.flight),
    // BOTS: spawn and drive bots in a dev room (server/bots.ts).
    bots.section,
    // ZONES: the objective's rules (Apply to room restarts the round with them) and the zones' look.
    zonesSection(() => applyZoneRules(ctx.net())),
    // VIEW: the quality tier (also a saved setting, and `?quality=` for automation), volume and key labels.
    viewSection(ctx.quality),
  )
  const opening = params.has("sounds") ? "sounds" : params.has("bots") ? "bots" : params.get("lab")
  if (opening) queueMicrotask(() => panel.open(opening))
  const forced = params.get("weather")
  if (forced && (WEATHER_KINDS as readonly string[]).includes(forced)) lab.force(forced as WeatherKind, 0)
  return {
    menu: panel,
    lab,
    bots,
    /** Local sea time: the weather lab can pause or speed it. */
    time: (synced: number, dt: number) => lab.time(synced, dt),
    frame(dt: number, t: number) {
      lab.frame(dt, t)
      panel.frame(dt)
    },
    get visible() {
      return panel.visible
    },
    get wantsInput() {
      return panel.wantsInput
    },
  }
}
