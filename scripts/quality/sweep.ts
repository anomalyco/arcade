import { mkdir, writeFile } from "node:fs/promises"
import type { Page } from "playwright-core"
import { qualityGates, type Frame } from "../../packages/kit/proof/legibility"
import type { LookCapture } from "../../packages/kit/proof/look"
import type { SweepSpec, SweepState } from "./spec"
import type { browserBudget } from "../browser-budget"

export async function decode(c: LookCapture): Promise<Frame> {
  const bytes = Buffer.from(c.png.slice(c.png.indexOf(",") + 1), "base64")
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { stdin: bytes, stdout: "pipe", stderr: "pipe" })
  const [data, error, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited])
  if (code) throw new Error(`PNG decode failed: ${error}`)
  return { width: c.width, height: c.height, data: new Uint8Array(data) }
}
const save = async (out: string, name: string, c: LookCapture) => writeFile(`${out}/${name}.png`, Buffer.from(c.png.split(",")[1]!, "base64"))

/** Includes on/off/shift captures in one state, always restoring the base before another probe. */
async function capture(page: Page, spec: SweepSpec, row: SweepState) {
  const t = performance.now()
  const result = await page.evaluate(async ({ row, settle, probe }) => {
    const look = window.look!
    for (const key of ["subject", "shift", "albedo"] as const) if (row.probes?.[key] && !look.capabilities[key]) throw new Error(`Required ${key} probe unavailable`)
    await look.apply(row.state); await look.settle(settle)
    // Meter once at game exposure, then use identical history length/sampling phase for every member of the pair.
    await look.settle(probe)
    const on = look.grab()
    // A repeat with unchanged simulation detects unstable capture/history before interpreting a counterfactual.
    await look.settle(probe)
    const repeat = look.grab()
    let without: LookCapture | undefined, shifted: LookCapture | undefined
    let albedo: { capture: LookCapture; mask: number[] } | undefined
    try {
      if (row.probes?.subject) {
        look.subject!(false); await look.settle(probe); without = look.grab()
        look.subject!(true); await look.settle(probe)
      }
      if (row.probes?.shift) { look.shift!(row.probes.shift); await look.settle(probe); shifted = look.grab() }
      if (row.probes?.albedo) {
        if (row.probes.shift) { look.shift!(0); await look.settle(probe) }
        albedo = await look.albedo!()
      }
    } finally {
      if (row.probes?.shift) look.shift!(0)
      if (row.probes?.subject) look.subject!(true)
    }
    return { on, repeat, without, shifted, albedo }
  }, { row, settle: spec.settleFrames, probe: spec.probeFrames })
  return { ...result, milliseconds: performance.now() - t }
}

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")

export async function sweep(budget: ReturnType<typeof browserBudget>, url: string, spec: SweepSpec, out: string, coldSamples = 0) {
  await mkdir(out, { recursive: true })
  await writeFile(`${out}/scoreboard.json`, JSON.stringify({ version: 1, complete: false, pass: false, state: "starting" }))
  await writeFile(`${out}/index.html`, "<!doctype html><title>Quality sweep incomplete</title><h1>Incomplete: diagnostic captures only</h1>")
  const started = performance.now(), errors: string[] = []
  const launch = () => budget.chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
  const browser = await launch()
  const open = async (b: typeof browser) => {
    const page = await b.newPage({ viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: 1 })
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
    await page.goto(url, { waitUntil: "load", timeout: 90_000 })
    await page.waitForFunction(() => window.look?.version === 1, undefined, { timeout: 90_000 })
    return page
  }
  const page = await open(browser), bootMs = performance.now() - started
  const rows = []
  const cold: { id: string; milliseconds: number; warmMilliseconds: number }[] = []
  let fatal: string | null = null
  try {
    for (const row of spec.states) {
      const c = await capture(page, spec, row)
      const frame = await decode(c.on), repeated = await decode(c.repeat)
      const without = c.without ? await decode(c.without) : undefined
      const shifted = c.shifted ? await decode(c.shifted) : undefined
      const albedo = c.albedo ? { frame: await decode(c.albedo.capture), mask: c.albedo.mask } : undefined
      const result = qualityGates(frame, { without, shifted, region: c.on.region, albedo }, { ...spec.limits, ...row.limits })
      let changed = 0
      for (let i = 0; i < frame.width * frame.height; i++) if ([0, 1, 2].some(k => Math.abs(frame.data[i * 4 + k]! - repeated.data[i * 4 + k]!) >= 4)) changed++
      const unstableShare = changed / (frame.width * frame.height)
      result.gates.push({ id: "repeat-stability", status: unstableShare <= 0.005 ? "pass" : "fail", value: unstableShare, limit: 0.005 })
      for (const [name, probe] of [["repeat", c.repeat], ["subject", c.without], ["shift", c.shifted]] as const) if (probe) {
        const honest = Number.isFinite(c.on.exposure) && c.on.exposure > 0 && Math.abs(probe.exposure / c.on.exposure - 1) < 0.001 && probe.time === c.on.time
        result.gates.push({ id: `${name}-matched-exposure-time`, status: honest ? "pass" : "fail", value: probe.exposure, limit: c.on.exposure })
      }
      result.pass = result.gates.every(g => g.status !== "fail")
      await save(out, row.id, c.on)
      if (c.without) await save(out, `${row.id}-without`, c.without)
      if (c.shifted) await save(out, `${row.id}-shift`, c.shifted)
      rows.push({ ...row, milliseconds: c.milliseconds, width: c.on.width, height: c.on.height, exposure: c.on.exposure, time: c.on.time, ...result })
      console.log(`${result.pass ? "PASS" : "FAIL"} ${row.id}: ${Math.round(c.milliseconds)}ms ${result.gates.filter(g => g.status === "fail").map(g => `${g.id}=${g.value}`).join(" ")}`)
      // Durable progress if a later state or the shared browser deadline fails.
      await writeFile(`${out}/scoreboard.json`, JSON.stringify({ version: 1, complete: false, pass: false, bootMs, rows, errors }, null, 2))
    }
    await browser.close()
    for (const row of spec.states.slice(0, coldSamples)) {
      const t = performance.now(), b = await launch()
      try { await capture(await open(b), spec, row) } finally { await b.close() }
      cold.push({ id: row.id, milliseconds: performance.now() - t, warmMilliseconds: rows.find(r => r.id === row.id)!.milliseconds })
    }
  } catch (e) { fatal = e instanceof Error ? e.message : String(e) }
  finally { await browser.close() }
  const complete = !fatal && rows.length === spec.states.length
  const pass = complete && !errors.length && rows.every(r => r.pass)
  const scoreboard = { version: 1, complete, pass, captured: new Date().toISOString(), url, spec, bootMs, totalMs: performance.now() - started, cold, rows, errors, fatal }
  await writeFile(`${out}/scoreboard.json`, JSON.stringify(scoreboard, null, 2))
  const cols = 3, tw = 480, th = Math.round(tw * spec.height / spec.width), cell = th + 48
  const tiles = await Promise.all(rows.map(async (r, i) => {
    const png = Buffer.from(await Bun.file(`${out}/${r.id}.png`).arrayBuffer()).toString("base64")
    return `<g transform="translate(${i % cols * tw},${Math.floor(i / cols) * cell + 44})"><image width="${tw}" height="${th}" href="data:image/png;base64,${png}"/><text x="8" y="${th + 20}" fill="${r.pass ? "#87dca1" : "#ff8f8f"}">${escape(r.id)} · ${r.pass ? "PASS" : "FAIL"}</text><text x="8" y="${th + 39}" fill="#ccc">p5 ${r.metrics.p5.toFixed(4)} · white ${(100 * r.metrics.whiteShare).toFixed(2)}%${r.subject ? ` · Weber ${r.subject.weber.toFixed(2)} · ${r.subject.changedPixels}px` : ""}</text></g>`
  }))
  await writeFile(`${out}/contact-sheet.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * tw}" height="${Math.ceil(rows.length / cols) * cell + 44}"><rect width="100%" height="100%" fill="#111"/><g font-family="sans-serif" font-size="14"><text x="10" y="28" fill="white">${pass ? "PASS" : "FAILED / DIAGNOSTIC ONLY"} · game exposure · ${rows.length}/${spec.states.length} states</text>${tiles.join("")}</g></svg>`)
  await writeFile(`${out}/index.html`, `<!doctype html><meta charset="utf-8"><title>Quality gates</title><style>body{margin:20px;background:#111;color:#ddd;font:16px system-ui}img{width:100%}a{color:#acd}</style><h1>${pass ? "Passed" : "Failed: diagnostic captures"}</h1><a href="scoreboard.json">Scoreboard and settings</a><img src="contact-sheet.svg">`)
  await writeFile(`${out}/ledger.md`, `# Quality sweep\n\n${pass ? "PASS" : "FAIL"}; ${rows.length}/${spec.states.length} states; boot ${bootMs.toFixed(0)} ms.\n\n| State | Result | Warm ms | Failed gates |\n|---|---|---:|---|\n${rows.map(r => `| ${r.id} | ${r.pass ? "PASS" : "FAIL"} | ${r.milliseconds.toFixed(0)} | ${r.gates.filter(g => g.status === "fail").map(g => g.id).join(", ")} |`).join("\n")}\n\nCold fresh-browser samples (includes startup and shutdown):\n${cold.map(c => `- ${c.id}: ${c.milliseconds.toFixed(0)} ms cold / ${c.warmMilliseconds.toFixed(0)} ms warm (${(c.milliseconds / c.warmMilliseconds).toFixed(2)}×).`).join("\n")}\n${fatal ?? ""}\n`)
  return scoreboard
}
