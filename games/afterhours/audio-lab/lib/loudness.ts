// Loudness measurement and normalisation for audio-lab clips (ffmpeg ebur128 + volume/alimiter).
//
// Metric follows docs/sfx-library.md: one-shots are matched on momentary-max LUFS (loudest 400 ms), loops on
// integrated LUFS. Targets are per category (relative intent: stingers loud, room tone quiet) and sit above the
// shared library's in-game mix targets so the audition page plays at a comfortable level; the library build
// re-normalises picks to its own targets. True peak is capped at -1 dBTP; up to MAX_LIMIT_DB of peak limiting is
// allowed so peaky takes still reach their target, beyond that the take stays under target.
import { copyFile, mkdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ManifestSound } from "./eleven"

export const RAW_DIR = "sfx-raw"
export const TP_CEILING = -1
const MAX_LIMIT_DB = 10
const BITRATE = "64k"

export interface LoudnessStats {
  integrated: number
  momentaryMax: number
  truePeak: number
}

export interface LoudnessInfo {
  metric: "momentary-max" | "integrated"
  target: number
  raw: LoudnessStats
  out: LoudnessStats
  gainDb: number
  limitedDb: number
  /** generatedAt of the take this was applied to; a mismatch means the file on disk is a new raw take. */
  take: string
  at: string
}

/** Momentary max for one-shots, integrated for loops. */
const TARGETS: Record<string, number> = {
  // footsteps: quieter than doors/impacts, as in the library (foot -27 vs door -19)
  "foot-linoleum": -19, "foot-carpet": -21, "foot-stairwell": -18, "foot-grating": -17,
  "foot-wet-asphalt": -19, "foot-gravel": -18, "foot-forest": -19,
  // doors and gates
  "door-fire-steel": -13, "door-office-wood": -16, "door-panic-bar": -14, "door-rollup-dock": -14,
  "gate-chainlink": -15, "gate-motorized": -15,
  // lift
  "lift-motor": -24, "lift-cable": -17, "lift-ding": -16, "lift-stall": -13, "lift-scissor-gate": -14,
  // lights
  "light-fluoro-hum": -27, "light-fluoro-flicker": -17, "light-sodium-buzz": -27, "light-switch": -18, "light-breaker": -14,
  // ambience beds (integrated); room tone well under the rest
  "amb-forest-night": -23,
  // round-2 forest nights are asked to sit very low; drizzle a touch higher
  "amb-forest-night/v4": -28, "amb-forest-night/v5": -28, "amb-forest-night/v6": -28, "amb-forest-night/v7": -28,
  "amb-forest-night/v8": -26, "amb-forest-night/v9": -26, "amb-rain-asphalt": -23, "amb-hvac": -25, "amb-corridor-tone": -30,
  "amb-machine-room": -23, "amb-radio-static": -25,
  // rain bed with thunder sits with the other beds; thunder one-shots per variant (distant quiet, strike loud)
  "amb-rain-thunder": -22, "amb-thunder": -15,
  "amb-thunder/v1": -17, "amb-thunder/v2": -14, "amb-thunder/v3": -18, "amb-thunder/v4": -11,
  "amb-thunder/v5": -21, "amb-thunder/v6": -15,
  // interactions
  "int-flashlight": -18, "int-keys": -16, "int-mop-bucket": -17, "int-paper": -18, "int-typewriter": -16,
  "int-phone-ring": -14, "int-phone-offhook": -24, "int-crt-whine": -18, "int-lab-glass": -16,
  // horror: stingers louder, distant/under-floor things a little lower
  "hor-metal-bang": -11, "hor-knock": -14, "hor-drone": -23, "hor-radio-whisper": -17,
  "hor-footsteps-other": -19, "hor-sub-rumble": -14,
  // UI sits under everything
  "ui-notify": -20,
  // outdoor night parts: the bed sits very low, one-shots are placed and attenuated at runtime
  "amb-pine-wind": -28, "out-owl": -20, "out-twig": -18, "out-cone": -20, "out-creak": -20, "out-rustle": -22,
  "out-far-animal": -24,
}

/** Per-category targets in LUFS; "category/variant" keys override for variants with a different intended level. */
export function targetFor(s: { category: string; variant?: string; loop: boolean }): { target: number; metric: LoudnessInfo["metric"] } {
  const metric = s.loop ? "integrated" : "momentary-max"
  return { target: TARGETS[`${s.category}/${s.variant}`] ?? TARGETS[s.category] ?? (s.loop ? -23 : -16), metric }
}

export async function measure(path: string): Promise<LoudnessStats> {
  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"],
    { stderr: "pipe", stdout: "ignore" },
  )
  const text = await new Response(proc.stderr).text()
  await proc.exited
  let momentaryMax = -Infinity
  for (const m of text.matchAll(/\bM:\s*(-?[\d.]+|-inf)/g)) {
    const v = Number(m[1])
    if (Number.isFinite(v)) momentaryMax = Math.max(momentaryMax, v)
  }
  const summary = text.slice(text.lastIndexOf("Summary:"))
  const integrated = Number(summary.match(/I:\s*(-?[\d.]+)\s*LUFS/)?.[1] ?? NaN)
  const truePeak = Number(summary.match(/Peak:\s*(-?[\d.]+|-inf)\s*dBFS/)?.[1] ?? NaN)
  if (!Number.isFinite(integrated)) throw new Error(`ebur128 failed for ${path}`)
  return { integrated, momentaryMax: Number.isFinite(momentaryMax) ? momentaryMax : integrated, truePeak: Number.isFinite(truePeak) ? truePeak : -99 }
}

async function render(src: string, dst: string, gainDb: number, limitDb: number, ceiling: number) {
  const filters = [`volume=${gainDb.toFixed(2)}dB`]
  if (limitDb > 0) filters.push(`alimiter=limit=${(10 ** (ceiling / 20)).toFixed(4)}:attack=1:release=80:level=false:latency=1`)
  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-af", filters.join(","), "-c:a", "libmp3lame", "-b:a", BITRATE, dst],
    { stderr: "pipe" },
  )
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed: ${err.slice(0, 300)}`)
}

const level = (s: LoudnessStats, metric: LoudnessInfo["metric"]) => (metric === "integrated" ? s.integrated : s.momentaryMax)

/**
 * Normalises one clip in place. The untouched take is kept at sfx-raw/<category>/<variant>.mp3; if the file on disk is
 * a new take (sound.loudness.take !== sound.generatedAt) it becomes the new raw first. Always renders from raw, so
 * re-running with new targets never stacks processing.
 */
export async function normaliseSound(root: string, s: ManifestSound & { loudness?: LoudnessInfo }): Promise<LoudnessInfo> {
  const live = join(root, s.file)
  const raw = join(root, s.file.replace(/^sfx\//, `${RAW_DIR}/`))
  await mkdir(dirname(raw), { recursive: true })
  const fresh = s.loudness?.take !== s.generatedAt || !(await Bun.file(raw).exists())
  if (fresh) await copyFile(live, raw)

  const { target, metric } = targetFor(s)
  const rawStats = await measure(raw)
  const wanted = target - level(rawStats, metric)
  // Limiter ceiling (sample peak) starts under -1 dBTP to leave room for inter-sample peaks and MP3 overshoot.
  let ceiling = TP_CEILING - 0.7
  // Gain that keeps peaks under the ceiling unlimited, plus up to MAX_LIMIT_DB of limiting for peaky takes.
  const headroom = ceiling - rawStats.truePeak
  let gainDb = wanted
  let limitDb = 0
  if (wanted > headroom) {
    limitDb = Math.min(MAX_LIMIT_DB, wanted - headroom)
    gainDb = headroom + limitDb
  }
  const tmp = `${live}.norm.mp3`
  let out: LoudnessStats
  // Iterate: limiting costs loudness, encoding adds peak; correct toward target within the limit budget.
  for (let pass = 0; ; pass++) {
    await render(raw, tmp, gainDb, limitDb, ceiling)
    out = await measure(tmp)
    const tpOver = out.truePeak - TP_CEILING
    const err = target - level(out, metric)
    if (pass >= 8 || (tpOver <= 0 && (pass >= 5 || Math.abs(err) <= 0.5)) || (tpOver <= 0 && err > 0 && limitDb >= MAX_LIMIT_DB)) break
    if (tpOver > 0) {
      if (limitDb > 0) ceiling -= tpOver + 0.2
      else gainDb -= tpOver + 0.2
      continue
    }
    if (err < 0) {
      gainDb += err
      limitDb = Math.max(0, limitDb + err)
    } else {
      const step = limitDb > 0 || gainDb + rawStats.truePeak + err > ceiling ? Math.min(err, MAX_LIMIT_DB - limitDb) : err
      gainDb += step
      if (gainDb + rawStats.truePeak > ceiling) limitDb = Math.max(0, gainDb + rawStats.truePeak - ceiling)
    }
  }
  await rename(tmp, live).catch(async (e) => {
    await rm(tmp, { force: true })
    throw e
  })
  const info: LoudnessInfo = {
    metric,
    target,
    raw: rawStats,
    out,
    gainDb: Math.round(gainDb * 10) / 10,
    limitedDb: Math.round(limitDb * 10) / 10,
    take: s.generatedAt,
    at: new Date().toISOString(),
  }
  s.loudness = info
  s.bytes = Bun.file(live).size
  return info
}
