import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type Job = {
  frames: number
  fps: number
  width: number
  height: number
  panes: { label: string; dir: string }[]
  outputs: { layout: "stack" | "side"; path: string }[]
}

async function run(args: string[]) {
  const p = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" })
  if (await p.exited) throw new Error(`Failed: ${args[0]}`)
}

// Tiny local images; the fleet worker only needs ffmpeg.
export async function prepareLabels(job: Job) {
  for (const output of job.outputs) {
    const width = output.layout === "stack" ? 720 : Math.floor(1920 / job.panes.length / 2) * 2
    for (const pane of job.panes) {
      const label = join(pane.dir, `label-${width}.png`)
      // label: interprets '%' expansions and '@' reads, so use a text file with annotate instead.
      const text = join(pane.dir, "label.txt")
      await Bun.write(text, pane.label)
      await run([
        "magick",
        "-size",
        `${width}x42`,
        "xc:#10131cdd",
        "-font",
        process.env.COMPARE_FONT ?? "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "-pointsize",
        "20",
        "-fill",
        "white",
        "-gravity",
        "West",
        "-annotate",
        "+14+0",
        `@${text}`,
        label,
      ])
    }
  }
}

export async function compose(job: Job) {
  for (const output of job.outputs) {
    mkdirSync(dirname(output.path), { recursive: true })
    const width = output.layout === "stack" ? 720 : Math.floor(1920 / job.panes.length / 2) * 2
    const height = Math.round((width * job.height) / job.width / 2) * 2
    const inputs: string[] = []
    const filters: string[] = []
    for (const [i, pane] of job.panes.entries()) {
      inputs.push("-framerate", String(job.fps), "-i", join(pane.dir, "%05d.png"))
      filters.push(`[${i}:v]scale=${width}:${height},setsar=1[v${i}]`)
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
      output.layout === "stack" ? "main" : "high",
      "-b:v",
      output.layout === "stack" ? "6M" : "9M",
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
