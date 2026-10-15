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
import { BotsTab, type BotsHost } from "./bots-tab"
import { controlsTab } from "./controls-tab"
import { DebugMenu } from "./debug-menu"
import { RadarLab } from "./radar-lab"
import { SightLab } from "./sight-lab"
import { ViewLab } from "./view-lab"
import { WeatherLab } from "./weather-lab"
import type { CarrierQuality } from "../quality"
import { ZonesLab } from "../objective/lab"
import { applyZoneRules } from "../objective/zones"

export { localRoom } from "./local-room"

export type DevToolsContext = {
  params: URLSearchParams
  device: GPUDevice
  camera: Camera
  input: Input
  weather: WeatherSystem
  daynight: DayNight
  game: Game
  audio: JetAudio
  /** The current connection (it changes when the menu picks another room). */
  net: () => Net
  bots: Omit<BotsHost, "net" | "release" | "close">
  quality: GameQuality<CarrierQuality>
}

/**
 * Dev builds only: main.ts imports this module behind `import.meta.env.DEV`, so production bundles contain none of it.
 * The debug menu (` or F2) and every tab: WEATHER (?lab=weather; ?weather=kind previews a weather locally), TIME, AUDIO,
 * SOUNDS (?sounds=1), CONTROLS, SIGHT, RADAR, VIEW (quality), BOTS (?bots opens it). Add dev tabs here, never in main.ts.
 */
export function installDevTools(ctx: DevToolsContext) {
  const { params, camera, input, game } = ctx
  const release = () => {
    input.suspend()
    input.release()
  }
  const lab = new WeatherLab({
    system: ctx.weather,
    device: ctx.device,
    focus: () => [camera.eye[0]! + camera.forward[0]! * 200, camera.eye[2]! + camera.forward[2]! * 200],
    broadcast: (to, fade) => ctx.net().sendWeather(to, fade),
    ship: () => game.state.ship,
  })
  const menu = new DebugMenu({ release, open: params.get("lab") === "weather", tab: "weather" })
  menu.addTab(lab.tab)
  menu.addTab(new TimeLab({ daynight: ctx.daynight, broadcast: (hour, speed, fade) => ctx.net().sendTime(hour, speed, fade) }).tab)
  // AUDIO: levels, jet sound tuning and test buttons (M mutes anywhere).
  menu.addTab(new MixerLab(ctx.audio).tab)
  // SOUNDS: the audition board (every sound slot's candidate takes; pick by ear).
  menu.addTab(new SoundsLab().tab)
  menu.addTab(controlsTab)
  // SIGHT: the F-35C bombsight's view and symbols on the shared Lab panel.
  menu.addTab(new SightLab({ close: () => menu.close(), release }).tab)
  // RADAR: the pilot's radar, full map (G) and target markers.
  menu.addTab(new RadarLab({ close: () => menu.close(), release }).tab)
  // VIEW: the quality tier (also a saved setting, and `?quality=` for automation).
  menu.addTab(new ViewLab({ quality: ctx.quality, close: () => menu.close(), release }).tab)
  // ZONES: the objective's rules (APPLY TO ROOM restarts the round with them) and the zones' look.
  menu.addTab(new ZonesLab({ close: () => menu.close(), release, apply: () => applyZoneRules(ctx.net()) }).tab)
  // BOTS: spawn and drive bots in a dev room (server/bots.ts).
  const bots = new BotsTab({ ...ctx.bots, net: ctx.net, release, close: () => menu.close() })
  menu.addTab(bots.tab)
  if (params.has("sounds")) menu.open("sounds")
  else if (params.has("bots")) menu.open("bots")
  const forced = params.get("weather")
  if (forced && (WEATHER_KINDS as readonly string[]).includes(forced)) lab.force(forced as WeatherKind, 0)
  return {
    menu,
    lab,
    bots,
    /** Local sea time: the weather lab can pause or speed it. */
    time: (synced: number, dt: number) => lab.time(synced, dt),
    frame(dt: number, t: number) {
      lab.frame(dt, t)
      menu.frame(dt)
      bots.frame(dt)
    },
    get visible() {
      return menu.visible
    },
    get wantsInput() {
      return menu.wantsInput
    },
  }
}
