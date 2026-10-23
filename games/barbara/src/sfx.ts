/** Library cues: torch clicks, the find chime, tape rustles. The night itself is the woods' own soundscape (src/audio/). */
export const WOODS_SFX = ["flashlight.click", "ui.ping", "pack.open", "pack.close", "ui.tick"] as const

/** The storm's samples (`src/audio/storm.ts`), fetched the first time it sounds. */
export const STORM_SFX = [
  "weather.thunder.close", "weather.thunder.mid", "weather.thunder.far", "weather.thunder.sky",
  "weather.wind.gust", "weather.drip", "weather.rain.asphalt", "ambience.rain.roof",
] as const
