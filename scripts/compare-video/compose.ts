import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type Job = {
  quality: "draft" | "high"
  frames: number
  fps: number
  width: number
  height: number
  panes: { label: string; dir: string }[]
  outputs: { layout: "stack" | "side"; path: string }[]
}

export const qualities = {
  draft: { dpr: 1, stackWidth: 720, sideWidth: 1920, stackBitrate: "6M", sideBitrate: "9M", labelHeight: 42, fontSize: 20 },
  high: { dpr: 2, stackWidth: 1080, sideWidth: 2560, stackBitrate: "16M", sideBitrate: "28M", labelHeight: 60, fontSize: 30 },
} as const

function paneWidth(job: Job, layout: "stack" | "side") {
  const quality = qualities[job.quality]
  return layout === "stack" ? quality.stackWidth : Math.floor(quality.sideWidth / job.panes.length / 2) * 2
}

async function run(args: string[]) {
  const p = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" })
  if (await p.exited) throw new Error(`Failed: ${args[0]}`)
}

// Tiny local images; the fleet worker only needs ffmpeg.
export async function prepareLabels(job: Job) {
  const quality = qualities[job.quality]
  for (const output of job.outputs) {
    const width = paneWidth(job, output.layout)
    for (const pane of job.panes) {
      const label = join(pane.dir, `label-${width}.png`)
      // label: interprets '%' expansions and '@' reads, so use a text file with annotate instead.
      const text = join(pane.dir, "label.txt")
      await Bun.write(text, pane.label)
      await run([
        "magick",
        "-size",
        `${width}x${quality.labelHeight}`,
        "xc:#10131cdd",
        "-font",
        process.env.COMPARE_FONT ?? "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "-pointsize",
        String(quality.fontSize),
        "-fill",
        "white",
        "-gravity",
        "West",
        "-annotate",
        `+${Math.round(quality.fontSize * 0.7)}+0`,
        `@${text}`,
        label,
      ])
    }
  }
}

export async function compose(job: Job) {
  const quality = qualities[job.quality]
  for (const output of job.outputs) {
    mkdirSync(dirname(output.path), { recursive: true })
    const width = paneWidth(job, output.layout)
    const height = Math.round((width * job.height) / job.width / 2) * 2
    const inputs: string[] = []
    const filters: string[] = []
    for (const [i, pane] of job.panes.entries()) {
      inputs.push("-framerate", String(job.fps), "-i", join(pane.dir, "%05d.png"))
      filters.push(`[${i}:v]scale=${width}:${height}:flags=lanczos,setsar=1[v${i}]`)
    }
    for (const pane of job.panes) inputs.push("-i", join(pane.dir, `label-${width}.png`))
    for (let i = 0; i < job.panes.length; i++) filters.push(`[v${i}][${i + job.panes.length}:v]overlay=0:0[p${i}]`)
    filters.push(
      `${job.panes.map((_, i) => `[p${i}]`).join("")}${output.layout === "stack" ? "vstack" : "hstack"}=inputs=${job.panes.length}[out]`,
    )
    await run([
      "ffmpeg",
      "-y",
      "-loglevel",
      "error",
      "-threads",
      "2",
      ...inputs,
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-frames:v",
      String(job.frames),
      "-an",
      "-c:v",
      "h264_videotoolbox",
      "-profile:v",
      "high",
      "-b:v",
      output.layout === "stack" ? quality.stackBitrate : quality.sideBitrate,
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      output.path,
    ])
    const sheet = output.path.replace(/\.mp4$/i, "-sheet.jpg")
    const indices = [0.025, 0.4, 0.97].map((t) => Math.min(job.frames - 1, Math.floor(t * job.frames)))
    const select = indices.map((i) => `eq(n\\,${i})`).join("+")
    await run([
      "ffmpeg",
      "-y",
      "-loglevel",
      "error",
      "-threads",
      "2",
      "-i",
      output.path,
      "-vf",
      `select='${select}',scale=${output.layout === "stack" ? 360 : 960}:-2,tile=${output.layout === "stack" ? "3x1" : "1x3"}`,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      sheet,
    ])
  }
}

if (import.meta.main) await compose(JSON.parse(readFileSync(process.argv[2]!, "utf8")))
