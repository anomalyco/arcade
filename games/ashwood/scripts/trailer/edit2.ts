// Trailer v2 edit: cuts captures/trailer/frames-v2/<shot>/ into ~30 s, a sound-only mix (score drone, ambience, SFX,
// no voices), one scream over black, the title card; −14 LUFS. Writes captures/trailer/ashwood-trailer-v2.mp4 and
// ashwood-trailer-v2-contact.jpg.
//
//   bun scripts/trailer/edit2.ts
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"

const ROOT = `${import.meta.dir}/../../captures/trailer`
const SFX = `${import.meta.dir}/../../public/sfx`
const LAB = `${import.meta.dir}/../../audio-lab/sfx`
const FPS = 30
const ff = (args: string[]) => {
  const r = Bun.spawnSync(["ffmpeg", "-hide_banner", "-y", "-loglevel", "error", ...args])
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}

// ---- picture: [shot, first frame, frame count]
const CUTS: [string, number, number][] = [
  ["forest", 20, 84], // pines in the fog, slow pan
  ["gate", 24, 72], // the south gate's sodium light, crane up to the block
  ["woods", 28, 69], // the block through the pines, crane down
  ["northgate", 24, 69], // the north gate standing open
  ["road", 28, 54], // the logging road into the trees, torchlight
  ["corridor", 28, 72], // the empty ground-floor corridor
  ["mapsite", 56, 57], // clipboard: "Station radio silent 48 hrs."
  ["map308", 62, 66], // clipboard: 3-08 circled
  ["hargrove", 32, 51], // 3-08: Hargrove at the foot of TX-1, ON AIR lit
  ["operator", 32, 48], // Kessler slumped over the console
  ["wall", 34, 33], // Bellamy against the wall
  ["note", 20, 57], // DO NOT TURN ON THE RADIO
  ["black", 0, 42], // the scream, over black
  ["title", 0, 138], // ASHWOOD
]
const seq = `${ROOT}/edit-v2/seq`
rmSync(seq, { recursive: true, force: true })
mkdirSync(seq, { recursive: true })
const black = `${ROOT}/edit-v2/black.jpg`
ff(["-f", "lavfi", "-i", "color=c=black:s=1920x1080", "-frames:v", "1", "-q:v", "2", black])
let n = 0
const T: Record<string, number> = {}
for (const [shot, first, count] of CUTS) {
  T[shot] = n / FPS
  for (let i = 0; i < count; i++) {
    const src = shot === "black" ? black : `${ROOT}/frames-v2/${shot}/${String(first + i).padStart(5, "0")}.jpg`
    if (!existsSync(src)) throw new Error(`missing ${src}`)
    copyFileSync(src, `${seq}/${String(n++).padStart(5, "0")}.jpg`)
  }
}
const total = n / FPS
const inside = T.corridor!
const blackAt = T.black!
const screamAt = blackAt + 0.4
console.log("cuts", Object.fromEntries(Object.entries(T).map(([k, v]) => [k, +v.toFixed(2)])), "total", total.toFixed(2))

// ---- sound only (no voices): [file, start (s), offset into file (s), length (s), gain (dB), extra filters]
type Cue = [string, number, number, number, number, string?]
const S = (id: string) => `${SFX}/${id}`
const CUES: Cue[] = [
  // Score: the v2 drone, low under the night, swelling through 3-08, cut dead on the black.
  [`${ROOT}/audio/score-v2.mp3`, 0.6, 1.2, blackAt - 0.6, -4, `volume='0.45+0.55*min(1,max(0,(t-${(T.hargrove! - 0.6 - 4).toFixed(2)})/5))':eval=frame,afade=t=in:d=2`],
  // Outside: wind in the pines, an owl far off, a rustle, the north gate's chain-link creaking, a twig on the road.
  [S("amb-pine-wind/v1.ogg"), 0, 1, inside + 0.15, 4, `afade=t=in:d=1.5,afade=t=out:st=${inside - 0.25}:d=0.4`],
  [S("out-owl/v2.ogg"), T.forest! + 1.4, 0, 2.5, -14, "lowpass=f=2500,aecho=0.6:0.5:220:0.25"],
  [S("out-rustle/v2.ogg"), T.woods! + 0.8, 0, 1.8, -10, "lowpass=f=4000"],
  [S("gate-chainlink/v1.ogg"), T.northgate! + 0.3, 0, 2.4, -7, "asetrate=48000*0.82,aresample=48000,lowpass=f=3000,afade=t=out:st=1.8:d=0.6"],
  [S("out-twig/v2.ogg"), T.road! + 1.3, 0, 0.9, -6, "aecho=0.7:0.6:180:0.2"],
  // Inside: HVAC and the fluorescent hum, a tube flickering, footsteps on the floor above.
  [S("amb-hvac/v2.ogg"), inside, 2, blackAt - inside, -6, "afade=t=in:d=0.15"],
  [S("light-fluoro-hum/v3.ogg"), inside, 0, T.mapsite! - inside + 0.6, -4, "afade=t=in:d=0.1,afade=t=out:st=2.4:d=0.6"],
  [S("light-fluoro-flicker/v1.ogg"), inside + 0.9, 0, 1.6, -8],
  [S("hor-footsteps-other/v1.ogg"), inside + 0.6, 0, 3.2, -9, "lowpass=f=900,afade=t=out:st=2.6:d=0.6"],
  // The clipboard: a page turned over, then knocking somewhere in the building.
  [S("int-paper/v2.ogg"), T.mapsite! + 0.05, 0, 1.4, -6],
  [S("int-paper/v2.ogg"), T.map308! + 0.0, 0.3, 0.9, -9],
  [S("hor-knock/v1.ogg"), T.map308! + 1.0, 0, 2.6, -8, "lowpass=f=1200,aecho=0.6:0.5:260:0.3"],
  // 3-08: the carrier hiss on the air, a CRT whine, a creak, a far-off metal bang, the sub rumble before the cut.
  [S("amb-radio-static/v2.ogg"), T.hargrove!, 3, blackAt - T.hargrove!, -14, "highpass=f=300,afade=t=in:d=0.2"],
  [S("int-crt-whine/v3.ogg"), T.hargrove!, 0, 2.4, -16],
  [S("out-creak/v2.ogg"), T.operator! + 0.6, 0, 1.6, -10, "lowpass=f=2500"],
  [S("hor-metal-bang/v2.ogg"), T.wall! + 0.2, 0, 2.2, -9, "lowpass=f=1500,aecho=0.7:0.6:300:0.35"],
  [S("hor-sub-rumble/v2.ogg"), T.note! - 0.6, 0, blackAt - T.note! + 0.6, -2, "afade=t=in:d=1.4"],
  // Over black: silence, one scream, silence.
  [`${LAB}/ban2-scream-tear/v1.mp3`, screamAt, 0, Math.min(3.5, T.title! - screamAt + 0.2), 3, "afade=t=out:st=1.6:d=0.4"],
  // Title: a burst of snow, then a low hiss.
  [S("amb-radio-static/v2.ogg"), T.title!, 6, total - T.title!, 0, `volume='if(lt(t,0.45),4,0.45)':eval=frame,afade=t=out:st=${(total - T.title! - 0.7).toFixed(2)}:d=0.7`],
]
const inputs: string[] = []
const chains: string[] = []
CUES.forEach(([file, start, off, len, gain, extra], i) => {
  if (!existsSync(file)) throw new Error(`missing ${file}`)
  inputs.push("-i", file)
  const ms = Math.max(0, Math.round(start * 1000))
  chains.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=${off}:${(off + len).toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain}dB${extra ? `,${extra}` : ""},adelay=${ms}|${ms}[a${i}]`)
})
// Everything but the scream drops out at the cut to black (the hard silence), until the title.
const mix = `${CUES.map((_, i) => `[a${i}]`).join("")}amix=inputs=${CUES.length}:normalize=0:duration=longest,atrim=0:${total.toFixed(3)}[mix]`
const pre = `${ROOT}/edit-v2/mix.wav`
mkdirSync(`${ROOT}/edit-v2`, { recursive: true })
ff([...inputs, "-filter_complex", [...chains, mix].join(";"), "-map", "[mix]", "-c:a", "pcm_s24le", pre])
const m = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", pre, "-af", "ebur128", "-f", "null", "-"]).stderr.toString()
const inI = Number(m.match(/I:\s+(-?[\d.]+) LUFS/g)!.pop()!.match(/-?[\d.]+/)![0])
const norm = `${ROOT}/edit-v2/mix-norm.wav`
ff(["-i", pre, "-af", `volume=${(-14 - inI + 1.1).toFixed(2)}dB,alimiter=limit=0.84:attack=1:release=80:level=disabled,aresample=48000`, "-c:a", "pcm_s24le", norm])

// ---- picture: a gentle lift on the night exteriors (they're very dark on small screens), fade in from black.
const out = `${ROOT}/ashwood-trailer-v2.mp4`
const vf = [`eq=gamma=1.18:brightness=0.012:enable='lt(t,${inside.toFixed(3)})'`, "fade=t=in:st=0:d=1.2", "format=yuv420p"].join(",")
ff(["-framerate", String(FPS), "-i", `${seq}/%05d.jpg`, "-i", norm, "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "256k", "-shortest", out])
const loud = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", out, "-af", "ebur128=peak=true", "-f", "null", "-"]).stderr.toString()
ff(["-i", out, "-vf", "fps=1,scale=384:-1,tile=6x6", "-frames:v", "1", "-q:v", "3", `${ROOT}/ashwood-trailer-v2-contact.jpg`])
console.log(JSON.stringify({ out, seconds: total, mb: +(statSync(out).size / 1e6).toFixed(1), loudness: loud.match(/I:\s+-?[\d.]+ LUFS/g)?.pop(), peak: loud.match(/Peak:\s+-?[\d.]+ dBFS/g)?.pop() }))
writeFileSync(`${ROOT}/edit-v2/cuts.json`, JSON.stringify(T, null, 2))
