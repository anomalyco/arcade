// Moonlight with your torch off, headless and muted (run after `bun run build`, through HiveMind's browser kind): the
// same four spots (dense canopy, a canopy gap, a clearing, the lake edge) plus the gap with your torch on, each before
// (main's Today: the catalogue sky with no moon) and after (the physical moon, its shafts, the moonlit dome), fresh and
// after the eye has dark-adapted, plus a few variants at the gap and the clearing. Then paired GPU time at the gap.
//   ARCADE_BROWSER_BUDGET_S=300 bun scripts/moonlight-proof.ts [--out <dir>] [--size 1600x900] [--moon key=value,...] [--shots spot-variant,...]
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", "../../captures/barbara-moonlight"))
const [W, H] = arg("--size", "1600x900").split("x").map(Number) as [number, number]
const parse = (s: string) => Object.fromEntries(s.split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k!, v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v] }))
/** `--debug fern=false,...` turns off forest draw kinds (`forest.debug`); `--tag` suffixes the file names. */
const debugs = parse(arg("--debug", ""))
const tag = arg("--tag", "")
mkdirSync(out, { recursive: true })

type Look = Record<string, number | string | boolean>
type Woods = {
  frames: number; paused: boolean
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  camera: { flashlight: boolean }
  state: { players: { id: number; x: number; z: number }[]; brains: { id: number; mode: string; timer: number }[] }
  world: { params: { half: number }; camp: { x: number; z: number }; lake: { x: number; z: number; rx: number; rz: number } }
  debug: { dark: number[] }
  look: Look
  view: { forest: { build: { field: Uint8Array; fieldSize: number }; camera: { exposure: number; dark: number }; stats(): Record<string, unknown>; measure(n: number): Promise<{ median: number } | null> } }
}
declare const woods: Woods

/** Main's Today: the catalogue sky, no moon, no dark adaptation. */
const BEFORE: Look = { skyMoon: "none", darkAdapt: 0 }
/** The new Today: a full moon at the sky's default place (220°, 34°) with every moonlight term at its default. */
const AFTER: Look = { skyMoon: "full", darkAdapt: 1, ...parse(arg("--moon", "")) }
type Variant = { name: string; look: Look; dark: number; torch?: boolean }
const core: Variant[] = [
  { name: "before", look: BEFORE, dark: 0 },
  { name: "after", look: AFTER, dark: 0 },
  { name: "adapted", look: AFTER, dark: 1 },
]
const extra: Variant[] = [
  { name: "noshafts", look: { ...AFTER, moonMist: 0 }, dark: 1 },
]
const spots: { spot: string; variants: Variant[] }[] = [
  // Dark adaptation acts where the scene alone holds the camera at its lift: moonless (the New moon look).
  { spot: "dense", variants: [...core, { name: "moonless-adapted", look: { ...BEFORE, darkAdapt: 1 }, dark: 1 }] },
  { spot: "gap", variants: [...core, ...extra] },
  { spot: "clearing", variants: [...core, ...extra] },
  { spot: "lake", variants: core },
  { spot: "torch", variants: [{ ...core[0]!, torch: true }, { ...core[1]!, torch: true }] },
]

await using budget = browserBudget()
const root = resolve("dist/arcade/barbara"), prefix = "/arcade/barbara/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
} })
const browser = await budget.chromium.launch({ timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 150000 }).catch((e) => { console.log(errors.join("\n")); throw e })

// The spots, from the forest's own sky-openness field (red: 1 open sky, 0 closed crowns) and the moon's heading.
const poses = await page.evaluate(() => {
  for (const el of document.querySelectorAll<HTMLElement>("#start, .arcade-shell, #hud, #prompt, #room, #goal, #objective, #reticle, #subs, #toast, #tuning")) el.style.visibility = "hidden"
  woods.paused = true
  const { field, fieldSize: n } = woods.view.forest.build
  const half = woods.world.params.half, reach = half + 50, texel = (2 * reach) / n
  const open = (x: number, z: number) => {
    const i = Math.floor((x + reach) / texel), j = Math.floor((z + reach) / texel)
    return i < 0 || j < 0 || i >= n || j >= n ? 1 : field[(j * n + i) * 4]! / 255
  }
  const disc = (x: number, z: number, r: number) => { let s = 0, c = 0; for (let dz = -r; dz <= r; dz += 3) for (let dx = -r; dx <= r; dx += 3) if (dx * dx + dz * dz <= r * r) { s += open(x + dx, z + dz); c++ } return s / c }
  const { camp, lake } = woods.world
  const away = (x: number, z: number, campR: number) => Math.hypot(x - camp.x, z - camp.z) > campR && Math.hypot((x - lake.x) / (lake.rx + 25), (z - lake.z) / (lake.rz + 25)) > 1 && Math.abs(x) < half - 25 && Math.abs(z) < half - 25
  // Toward the moon in plan (sky azimuth 220°: x east, z south); the view looks along (−sin yaw, −cos yaw).
  const az = (220 * Math.PI) / 180, mx = Math.sin(az), mz = -Math.cos(az)
  const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz)
  let dense = { x: 0, z: 0, o: 2 }, gap = { x: 0, z: 0, o: -1 }, clear = { x: 0, z: 0, o: -1 }
  for (let z = -half; z <= half; z += 4) for (let x = -half; x <= half; x += 4) {
    if (!away(x, z, 45)) continue
    const here = open(x, z), ring = disc(x, z, 18)
    if (ring < dense.o) dense = { x, z, o: ring }
    // A gap: open sky over a few metres with closed crowns round it.
    const g = here - ring
    if (here > 0.35 && here < 0.85 && g > gap.o) gap = { x, z, o: g }
    const c = disc(x, z, 9)
    if (away(x, z, 70) && c > clear.o) clear = { x, z, o: c }
  }
  return {
    // Under the closest crowns, the moon on your left, a little up for the sky between the crowns.
    dense: { x: dense.x, z: dense.z, yaw: yawTo(-mz, mx), pitch: 0.1, open: dense.o },
    // 9 m on the far side of the gap from the moon, looking through it towards the moon (forward scatter in the mist).
    gap: { x: gap.x - mx * 9, z: gap.z - mz * 9, yaw: yawTo(mx, mz), pitch: 0.06, open: gap.o },
    // At the clearing's edge with the moon behind you, so its far tree line is lit.
    clearing: { x: clear.x + mx * 12, z: clear.z + mz * 12, yaw: yawTo(-mx, -mz), pitch: 0.04, open: clear.o },
    lake: { x: -22, z: 89, yaw: Math.PI, pitch: -0.08, open: open(-22, 89) },
    torch: { x: gap.x - mx * 9, z: gap.z - mz * 9, yaw: yawTo(mx, mz), pitch: -0.12, open: gap.o },
  }
})
console.log("poses", JSON.stringify(poses))
await page.evaluate((d) => { Object.assign((woods.view.forest as unknown as { debug: object }).debug, d) }, debugs)

const shoot = async (spot: keyof typeof poses, v: Variant) => {
  const pose = poses[spot]
  const state = await page.evaluate(async ({ pose, v }) => {
    Object.assign(woods.look, v.look)
    const ids = woods.state.players.slice(1).map((p) => p.id)
    woods.debug.dark = ids
    for (const p of woods.state.players.slice(1)) { p.x = woods.world.camp.x + 150; p.z = woods.world.camp.z + 150 }
    for (const b of woods.state.brains) { b.mode = "wait"; b.timer = 99 }
    woods.camera.flashlight = !!v.torch
    woods.setPose(pose.x, pose.z, pose.yaw, pose.pitch)
    // Settle the eye as it would over ~20 s (fast response times), then hold it with the real ones: the still is the
    // settled exposure, with the dark adaptation pinned to the variant's (fresh 0, a few minutes in 1).
    const { adaptBrighten, adaptDarken } = woods.look
    Object.assign(woods.look, { adaptBrighten: 0.2, adaptDarken: 0.1 })
    for (let i = 0; i < 90; i++) { woods.view.forest.camera.dark = v.dark; woods.step(1000 / 60); if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0)) }
    Object.assign(woods.look, { adaptBrighten, adaptDarken })
    for (let i = 0; i < 6; i++) { woods.view.forest.camera.dark = v.dark; woods.step(1000 / 60); await new Promise((r) => setTimeout(r, 0)) }
    const s = woods.view.forest.stats()
    return { exposure: s.exposure, dark: +woods.view.forest.camera.dark.toFixed(3) }
  }, { pose, v })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.screenshot({ path: `${out}/${spot}-${v.name}${tag}.png` })
  console.log(spot, v.name, JSON.stringify(state))
  return state
}

const report: Record<string, unknown> = { poses, after: AFTER, shots: {} as Record<string, unknown> }
// `--shots lake-after,gap-adapted` re-takes only those stills and skips the timings.
const only = arg("--shots", "").split(",").filter(Boolean)
for (const { spot, variants } of spots) for (const v of variants) {
  if (only.length && !only.includes(`${spot}-${v.name}`)) continue
  ;(report.shots as Record<string, unknown>)[`${spot}-${v.name}`] = await shoot(spot as keyof typeof poses, v)
}
if (only.length) {
  writeFileSync(`${out}/moonlight-retake.json`, JSON.stringify({ ...report, errors }, null, 2))
  if (errors.length) console.log("browser messages:", errors.slice(0, 10))
  server.stop(true)
  await budget.exit(0)
}

// Paired GPU time at the gap, torch off: before, after and after without shafts alternate, each the median of 12 frames.
const gpu: Record<"before" | "after" | "noshafts", number[]> = { before: [], after: [], noshafts: [] }
for (let round = 0; round < 3; round++) for (const [name, look] of [["before", BEFORE], ["after", AFTER], ["noshafts", { ...AFTER, moonMist: 0 }]] as const) {
  const ms = await page.evaluate(async ({ pose, look }) => {
    Object.assign(woods.look, look)
    woods.camera.flashlight = false
    woods.setPose(pose.x, pose.z, pose.yaw, pose.pitch)
    for (let i = 0; i < 20; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) }
    return (await woods.view.forest.measure(12))?.median ?? -1
  }, { pose: poses.gap, look })
  gpu[name].push(+ms.toFixed(3))
}
report.gpu = gpu
// The moon's canopy shadow map re-renders when the eye crosses an 8 m snap: whole-frame wall time (submit to GPU done)
// of a step that crosses one against a step that doesn't, alternating, with the moon up.
report.moonMap = await page.evaluate(async ({ pose, look }) => {
  Object.assign(woods.look, look)
  const device = (woods.view.forest as unknown as { renderer: { device: GPUDevice } }).renderer.device
  const time = async (dx: number) => {
    const t0 = performance.now()
    woods.setPose(pose.x + dx, pose.z, pose.yaw, pose.pitch)
    woods.step(1000 / 60)
    await device.queue.onSubmittedWorkDone()
    return performance.now() - t0
  }
  const cross: number[] = [], still: number[] = []
  for (let i = 0; i < 8; i++) { await time(i % 2 ? 0 : 8.5); cross.push(await time(i % 2 ? 8.5 : 0)); still.push(await time(i % 2 ? 8.5 : 0)) }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!
  return { crossMs: +med(cross).toFixed(2), stillMs: +med(still).toFixed(2) }
}, { pose: poses.gap, look: AFTER })
console.log("moon map", JSON.stringify(report.moonMap))
report.errors = errors
writeFileSync(`${out}/moonlight.json`, JSON.stringify(report, null, 2))
console.log("gpu", JSON.stringify(gpu))
if (errors.length) console.log("browser messages:", errors.slice(0, 10))
server.stop(true)
