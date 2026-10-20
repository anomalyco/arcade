// Cuts the recorded shots (captures/trailer/frames/<shot>/) into the 30 s trailer, mixes the score and the game's
// SFX, loudness-normalises to −14 LUFS and writes captures/trailer/ashwood-trailer.mp4 plus a contact sheet.
//
//   bun scripts/trailer/edit.ts
import { copyFileSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs"

const ROOT = `${import.meta.dir}/../../captures/trailer`
const SFX = `${import.meta.dir}/../../public/sfx`
const FPS = 30
const ff = (args: string[]) => {
  const r = Bun.spawnSync(["ffmpeg", "-hide_banner", "-y", "-loglevel", "error", ...args])
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stderr.toString()
}

// ---- picture: [shot, first frame, frame count] in order; "black" is a held black frame.
const CUTS: [string, number, number][] = [
  ["drive", 0, 180], // 0.00  the drive up the access road
  ["building", 15, 75], // 6.00  the lit block
  ["corridor", 15, 105], // 8.50  flashlight down the tiled corridor
  ["room", 15, 60], // 12.00 3-08: ON AIR, the operator at the desk
  ["switch", 30, 55], // 14.00 TX POWER, the ON AIR lamp lights
  ["hand", 10, 65], // 15.83 the hand by the mic
  ["note", 0, 75], // 18.00 DO NOT TURN ON THE RADIO / it hears it
  ["charge", 25, 40], // 20.00 the Wendigo's charge
  ["ambush", 36, 78], // 21.03 the lift doors open, the jump scare
  ["black", 0, 23], // 24.43 hard silence
  ["title", 0, 144], // 25.20 ASHWOOD
]
const seq = `${ROOT}/edit/seq`
rmSync(seq, { recursive: true, force: true })
mkdirSync(seq, { recursive: true })
const black = `${ROOT}/edit/black.jpg`
ff(["-f", "lavfi", "-i", "color=c=black:s=1920x1080", "-frames:v", "1", "-q:v", "2", black])
let n = 0
const at: Record<string, number> = {}
for (const [shot, first, count] of CUTS) {
  at[shot] = n / FPS
  for (let i = 0; i < count; i++) {
    const src = shot === "black" ? black : `${ROOT}/frames/${shot}/${String(first + i).padStart(5, "0")}.jpg`
    if (!existsSync(src)) throw new Error(`missing ${src}`)
    copyFileSync(src, `${seq}/${String(n++).padStart(5, "0")}.jpg`)
  }
}
const total = n / FPS
console.log("cuts", Object.fromEntries(Object.entries(at).map(([k, v]) => [k, +v.toFixed(2)])), "total", total.toFixed(2))

// ---- sound: [file, start in trailer (s), offset into file (s), length (s), gain (dB), extra filters]
const T = at
/** The ambush's pounce frame (the scream lands on it), and a shot's first frame in the cut. */
const POUNCE = 103
const first = (shot: string) => CUTS.find((c) => c[0] === shot)![1]
const silenceAt = T.black!
type Cue = [string, number, number, number, number, string?]
const steps: Cue[] = []
for (let k = 0, t = T.corridor! + 0.25; t < T.room! - 0.2; k++, t += 0.56) steps.push([`foot-linoleum/v3-${(k % 8) + 1}.ogg`, t, 0, 0.45, -9 + (k % 2) * -1.5])
const CUES: Cue[] = [
  // Score: its natural hard stop (21.33 s in) lands on the cut to black.
  ["../../captures/trailer/audio/score.mp3", silenceAt - 21.33, 0, 21.33, -1, "afade=t=in:d=1.5"],
  // Night outside: pine wind under the drive and the block, a car radio's hiss at the start.
  ["amb-pine-wind/v1.ogg", 0, 2, T.corridor! + 0.3, 6, `afade=t=in:d=1.2,afade=t=out:st=${T.corridor! - 0.6}:d=0.9`],
  ["amb-radio-static/v2.ogg", 0.2, 1, 4.2, -10, "lowpass=f=2400,afade=t=in:d=0.8,afade=t=out:st=2.6:d=1.6"],
  ...steps,
  // 3-08: County's reply (its "...Do not move." lands on the note), static as ON AIR lights.
  ["amb-radio-static/v2.ogg", T.switch! + 0.4, 4, 2.0, -6, "afade=t=in:d=0.5,afade=t=out:st=1.2:d=0.8"],
  ["story-call-reply/v7.ogg", T.note! + 0.5 - 5.9, 0, 7.2, 3, "afade=t=out:st=6.7:d=0.5"],
  // Outside, the car alarm (far off, through walls) under the note.
  ["story-car-alarm/v1.ogg", T.note! + 0.9, 0, T.charge! - T.note! - 0.9, -10, "lowpass=f=1400,afade=t=in:d=0.3"],
  // The charge, then the scare: screams cut dead on the black.
  ["monsters/wen2-huge-scream.mp3", T.charge! + 0.05, 0.4, T.ambush! - T.charge! - 0.05, 0, "afade=t=out:st=0.85:d=0.1"],
  ["monsters/wen2-huge-scream.mp3", T.ambush! + (POUNCE - first("ambush")) / FPS, 0, silenceAt - (T.ambush! + (POUNCE - first("ambush")) / FPS), 7],
  // Title: a burst of snow, then a low hiss under the card.
  ["amb-radio-static/v2.ogg", T.title!, 6, total - T.title!, 0, `volume='if(lt(t,0.45),4,0.45)':eval=frame,afade=t=out:st=${total - T.title! - 0.7}:d=0.7`],
]
const inputs: string[] = []
const chains: string[] = []
CUES.forEach(([file, start, off, len, gain, extra], i) => {
  const path = file.startsWith("..") ? `${SFX}/${file}` : `${SFX}/${file}`
  inputs.push("-i", path)
  const ms = Math.max(0, Math.round(start * 1000))
  chains.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=${off}:${(off + len).toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain}dB${extra ? `,${extra}` : ""},adelay=${ms}|${ms}[a${i}]`)
})
// Duck the score under County's voice.
const duck = [T.note! + 0.5 - 5.9, T.note! + 1.3]
const pounceAt = T.ambush! + (POUNCE - first("ambush")) / FPS
const mix = `${CUES.map((_, i) => `[a${i}]`).join("")}amix=inputs=${CUES.length}:normalize=0:duration=longest,atrim=0:${total.toFixed(3)},volume='if(between(t,${silenceAt.toFixed(3)},${T.title!.toFixed(3)}),0,1)':eval=frame[mix]`
chains[0] = chains[0]!.replace("[a0]", "[s0]")
chains.push(`[s0]volume='if(between(t,${duck[0]!.toFixed(2)},${duck[1]!.toFixed(2)}),0.5,1)*if(gt(t,${(pounceAt - 0.05).toFixed(2)}),0.45,1)':eval=frame[a0]`)
const pre = `${ROOT}/edit/mix.wav`
ff([...inputs, "-filter_complex", [...chains, mix].join(";"), "-map", "[mix]", "-c:a", "pcm_s24le", pre])

// Loudness: one static gain to −14 LUFS integrated, then a true-peak limiter (loudnorm's dynamic fallback would
// flatten the scare and the drop to silence).
const m = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", pre, "-af", "ebur128=peak=true", "-f", "null", "-"]).stderr.toString()
const inI = Number(m.match(/I:\s+(-?[\d.]+) LUFS/g)!.pop()!.match(/-?[\d.]+/)![0])
const norm = `${ROOT}/edit/mix-norm.wav`
ff(["-i", pre, "-af", `volume=${(-14 - inI + 0.4).toFixed(2)}dB,alimiter=limit=0.84:attack=1:release=60:level=disabled,aresample=48000`, "-c:a", "pcm_s24le", norm])

// ---- encode
const out = `${ROOT}/ashwood-trailer.mp4`
ff(["-framerate", String(FPS), "-i", `${seq}/%05d.jpg`, "-i", norm, "-vf", "fade=t=in:st=0:d=0.8,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-profile:v", "high", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "256k", "-shortest", out])
const loud = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", out, "-af", "ebur128", "-f", "null", "-"]).stderr.toString()
const I = loud.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop()
// Contact sheet: one frame per second.
ff(["-i", out, "-vf", "fps=1,scale=384:-1,tile=6x5", "-frames:v", "1", "-q:v", "3", `${ROOT}/ashwood-trailer-contact.jpg`])
console.log(JSON.stringify({ out, seconds: total, mb: +(statSync(out).size / 1e6).toFixed(1), loudness: I }))
writeFileSync(`${ROOT}/edit/cuts.json`, JSON.stringify(at, null, 2))
