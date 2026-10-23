/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "./browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "..")
const outDir = resolve("/Users/kit/code/home/artifacts/2026-10-14-looks")
const dirTargets = resolve("/Users/kit/code/home/artifacts/2026-10-14-outbreak-directions")
mkdirSync(outDir, { recursive: true })

const roundTag = process.argv[2] ?? "r0"

const labDir = resolve(root, "games/lab")
const outbreakDir = resolve(root, "games/outbreak")
assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: labDir, stdout: "ignore", stderr: "inherit" }).exitCode, 0)
assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: outbreakDir, stdout: "ignore", stderr: "inherit" }).exitCode, 0)

const labDist = resolve(labDir, "dist/arcade/lab")
const outbreakDist = resolve(outbreakDir, "dist/arcade/outbreak")

const labServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const f = Bun.file(resolve(labDist, `.${p === "/" ? "/index.html" : p}`))
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
  },
})

const outbreakServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const f = Bun.file(resolve(outbreakDist, `.${p === "/" ? "/index.html" : p}`))
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
  },
})

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const errors: string[] = []
try {
  // 1. Capture Lab Debug Room (Current, Noir, Painterly)
  const labPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  labPage.on("pageerror", e => errors.push(e.message))
  labPage.on("console", m => {
    if (m.type() === "error") errors.push(m.text())
  })
  await labPage.goto(`http://127.0.0.1:${labServer.port}/?bench`)
  await labPage.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 25000 })
  await labPage.getByRole("button", { name: "Category Lighting", exact: true }).click()
  await labPage.locator('[data-catalog-id="section:looks"]').click()

  const roomPerf: Record<string, number> = {}
  for (const pid of ["current", "noir", "painterly"] as const) {
    await labPage.evaluate((id: string) => {
      ;(window as any).lab.workbench.invoke("look.preset", { preset: id })
      ;(window as any).lab.workbench.invoke("look.set", { key: "grainAnimated", value: false })
    }, pid)
    let sum = 0
    let cnt = 0
    for (let i = 0; i < 6; i++) {
      const ms = await labPage.evaluate(async () => {
        ;(window as any).lab.advance(1 / 60)
        return await (window as any).lab.render(true)
      })
      if (typeof ms === "number" && ms > 0 && i >= 1) {
        sum += ms
        cnt++
      }
    }
    roomPerf[pid] = cnt > 0 ? Number((sum / cnt).toFixed(3)) : 0
    await labPage.locator("canvas").screenshot({ path: resolve(outDir, `room-${pid}.png`) })
    await labPage.locator("canvas").screenshot({ path: resolve(outDir, `${roundTag}-room-${pid}.png`) })
  }
  await labPage.close()

  // 2. Capture Outbreak Street & Interior at exact paint-over framing (1000x680)
  const obPage = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  obPage.on("pageerror", e => errors.push(e.message))
  obPage.on("console", m => {
    if (m.type() === "error") errors.push(m.text())
  })
  await obPage.goto(`http://127.0.0.1:${outbreakServer.port}/?solo&seed=7&bench`, { waitUntil: "networkidle" })
  await obPage.waitForFunction(() => (window as any).__arcadeHarness?.ready, undefined, { timeout: 25000 })

  const poseOutbreak = async (x: number, y: number, aim: number, hour: number, zoom: number) => {
    await obPage.evaluate(
      async ({ x, y, aim, hour, zoom }) => {
        const h = (window as any).__arcadeHarness
        h.setLab("timeScale", 0)
        h.setLab("hour", hour)
        h.setLab("zoom", zoom)
        h.pose(x, y, aim)
        for (let i = 0; i < 6; i++) await h.step(0)
      },
      { x, y, aim, hour, zoom },
    )
  }

  // Street pose (30, 41, -PI/2, 18:00, zoom 42)
  await poseOutbreak(30, 41, -Math.PI / 2, 18, 42)
  const baseStreetBuf = await obPage.locator("#game").screenshot({ path: resolve(outDir, "outbreak-street-current.png") })

  const outbreakPerf: Record<string, number> = {}
  for (const pid of ["noir", "painterly"] as const) {
    const tMs = await obPage.evaluate(async (id: string) => {
      const h = (window as any).__arcadeHarness
      h.setLookPreset(id)
      h.setLook({ grainAnimated: false })
      await h.step(0)
      const t0 = performance.now()
      for (let i = 0; i < 6; i++) await h.step(0)
      return (performance.now() - t0) / 6
    }, pid)
    outbreakPerf[`street_${pid}`] = Number(tMs.toFixed(3))
    await obPage.locator("#game").screenshot({ path: resolve(outDir, `outbreak-street-${pid}.png`) })
    await obPage.locator("#game").screenshot({ path: resolve(outDir, `${roundTag}-street-${pid}.png`) })
  }

  // Verify Current pixel identity after switching presets
  await obPage.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLookPreset("current")
    for (let i = 0; i < 3; i++) await h.step(0)
  })
  const restoredStreetBuf = await obPage.locator("#game").screenshot()
  assert.equal(Buffer.compare(baseStreetBuf, restoredStreetBuf), 0, "Current preset must remain byte-for-byte identical")

  // Interior cutaway pose (27.7, 31, -PI/2, 19:00, zoom 34, front door opened)
  await poseOutbreak(27.7, 31, -Math.PI / 2, 19, 34)
  await obPage.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    await h.step(1 / 60, { interact: true })
    for (let i = 0; i < 5; i++) await h.step(0)
  })
  await obPage.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLookPreset("current")
    for (let i = 0; i < 3; i++) await h.step(0)
  })
  await obPage.locator("#game").screenshot({ path: resolve(outDir, "outbreak-interior-current.png") })

  for (const pid of ["noir", "painterly"] as const) {
    const tMs = await obPage.evaluate(async (id: string) => {
      const h = (window as any).__arcadeHarness
      h.setLookPreset(id)
      h.setLook({ grainAnimated: false })
      await h.step(0)
      const t0 = performance.now()
      for (let i = 0; i < 6; i++) await h.step(0)
      return (performance.now() - t0) / 6
    }, pid)
    outbreakPerf[`interior_${pid}`] = Number(tMs.toFixed(3))
    await obPage.locator("#game").screenshot({ path: resolve(outDir, `outbreak-interior-${pid}.png`) })
    await obPage.locator("#game").screenshot({ path: resolve(outDir, `${roundTag}-interior-${pid}.png`) })
  }
  await obPage.close()
  assert.equal(errors.length, 0, `Browser errors: ${errors.join("; ")}`)

  // 3. Compute quantitative metrics & build side-by-side comparison sheets via Python + Pillow
  const pyScript = `
import json, math
from PIL import Image, ImageDraw, ImageFont

out_dir = ${JSON.stringify(outDir)}
target_dir = ${JSON.stringify(dirTargets)}
tag = ${JSON.stringify(roundTag)}

def load_rgb(path, size=None):
    im = Image.open(path).convert("RGB")
    if size and im.size != size:
        im = im.resize(size, Image.Resampling.LANCZOS)
    return im

def stats_and_diff(cand_im, targ_im):
    w, h = cand_im.size
    c_px = cand_im.load()
    t_px = targ_im.load() if targ_im else None
    n = w * h
    c_hist = [0] * 16
    t_hist = [0] * 16
    luma_sum = 0.0
    t_luma_sum = 0.0
    luma_mae = 0.0
    rgb_mae = 0.0
    dark_cnt = 0
    mid_cnt = 0
    hi_cnt = 0
    sat_sum = 0.0
    t_sat_sum = 0.0
    grad_sum = 0.0
    for y in range(h):
        for x in range(w):
            cr, cg, cb = c_px[x, y]
            cl = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb
            luma_sum += cl
            b_idx = min(15, int(cl / 16.0))
            c_hist[b_idx] += 1
            if cl < 22.0:
                dark_cnt += 1
            elif cl < 140.0:
                mid_cnt += 1
            else:
                hi_cnt += 1
            cmax = max(cr, cg, cb)
            cmin = min(cr, cg, cb)
            sat_sum += (cmax - cmin) / max(cmax, 1.0)
            if x + 1 < w:
                nr, ng, nb = c_px[x + 1, y]
                grad_sum += abs(cr - nr) + abs(cg - ng) + abs(cb - nb)
            if t_px:
                tr, tg, tb = t_px[x, y]
                tl = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb
                t_luma_sum += tl
                tb_idx = min(15, int(tl / 16.0))
                t_hist[tb_idx] += 1
                luma_mae += abs(cl - tl)
                rgb_mae += (abs(cr - tr) + abs(cg - tg) + abs(cb - tb)) / 3.0
                tmax = max(tr, tg, tb)
                tmin = min(tr, tg, tb)
                t_sat_sum += (tmax - tmin) / max(tmax, 1.0)
    res = {
        "meanLuma": round(luma_sum / n, 2),
        "darkPct": round(dark_cnt * 100.0 / n, 1),
        "midPct": round(mid_cnt * 100.0 / n, 1),
        "hiPct": round(hi_cnt * 100.0 / n, 1),
        "meanSat": round(sat_sum / n, 3),
        "microGrad": round(grad_sum / n, 2),
    }
    if t_px:
        hist_l1 = sum(abs(c_hist[i] / n - t_hist[i] / n) for i in range(16))
        res.update({
            "targetMeanLuma": round(t_luma_sum / n, 2),
            "targetMeanSat": round(t_sat_sum / n, 3),
            "lumaMAE": round(luma_mae / n, 2),
            "rgbMAE": round(rgb_mae / n, 2),
            "histL1": round(hist_l1, 3),
        })
    return res

# Load images
st_cur = load_rgb(f"{out_dir}/outbreak-street-current.png", (1000, 680))
st_noir = load_rgb(f"{out_dir}/outbreak-street-noir.png", (1000, 680))
st_paint = load_rgb(f"{out_dir}/outbreak-street-painterly.png", (1000, 680))
in_cur = load_rgb(f"{out_dir}/outbreak-interior-current.png", (1000, 680))
in_noir = load_rgb(f"{out_dir}/outbreak-interior-noir.png", (1000, 680))
in_paint = load_rgb(f"{out_dir}/outbreak-interior-painterly.png", (1000, 680))

t_st_noir = load_rgb(f"{target_dir}/dir3-street.png", (1000, 680))
t_in_noir = load_rgb(f"{target_dir}/dir3-interior.png", (1000, 680))
t_st_paint = load_rgb(f"{target_dir}/dir2-street.png", (1000, 680))
t_in_paint = load_rgb(f"{target_dir}/dir2-interior.png", (1000, 680))

rm_cur = load_rgb(f"{out_dir}/room-current.png")
rm_noir = load_rgb(f"{out_dir}/room-noir.png")
rm_paint = load_rgb(f"{out_dir}/room-painterly.png")

metrics = {
    "round": tag,
    "noir": {
        "street": stats_and_diff(st_noir, t_st_noir),
        "interior": stats_and_diff(in_noir, t_in_noir),
        "room": stats_and_diff(rm_noir, None),
    },
    "painterly": {
        "street": stats_and_diff(st_paint, t_st_paint),
        "interior": stats_and_diff(in_paint, t_in_paint),
        "room": stats_and_diff(rm_paint, None),
    },
    "current": {
        "street": stats_and_diff(st_cur, t_st_noir),
        "room": stats_and_diff(rm_cur, None),
    }
}

# Build <=1280px comparison sheets:
# 1. Noir sheet (2x3 grid: top row Street Current | Target | Now, bottom row Interior Current | Target | Now, plus Debug Room inset)
def make_sheet(title, top_imgs, bot_imgs, labels, out_path):
    cell_w, cell_h = 416, 283
    pad = 8
    header_h = 34
    W = cell_w * 3 + pad * 4
    H = header_h * 2 + cell_h * 2 + pad * 3
    sheet = Image.new("RGB", (W, H), (13, 16, 22))
    draw = ImageDraw.Draw(sheet)
    draw.text((pad, 8), title, fill=(230, 236, 245))
    for idx, im in enumerate(top_imgs):
        x = pad + idx * (cell_w + pad)
        y = header_h
        sheet.paste(im.resize((cell_w, cell_h), Image.Resampling.LANCZOS), (x, y))
        draw.text((x + 6, y + 6), labels[idx], fill=(240, 180, 90))
    draw.text((pad, header_h + cell_h + 8), "Interior Cutaway & Debug Room", fill=(160, 175, 195))
    for idx, im in enumerate(bot_imgs):
        x = pad + idx * (cell_w + pad)
        y = header_h * 2 + cell_h
        sheet.paste(im.resize((cell_w, cell_h), Image.Resampling.LANCZOS), (x, y))
        draw.text((x + 6, y + 6), labels[3 + idx], fill=(124, 197, 214))
    sheet.save(out_path, quality=92)

make_sheet(
    f"Noir / Limbo Convergence ({tag}) — Street: Luma MAE {metrics['noir']['street']['lumaMAE']} (Hist L1 {metrics['noir']['street']['histL1']}) | Interior: Luma MAE {metrics['noir']['interior']['lumaMAE']}",
    [st_cur, t_st_noir, st_noir],
    [in_noir, t_in_noir, rm_noir],
    ["Street: Current", "Street: Noir Target (dir3)", f"Street: Noir ({tag})", f"Interior: Noir ({tag})", "Interior: Noir Target (dir3)", f"Debug Room: Noir ({tag})"],
    f"{out_dir}/sheet-noir-{tag}.jpg"
)

make_sheet(
    f"Painterly Convergence ({tag}) — Street: RGB MAE {metrics['painterly']['street']['rgbMAE']} | Interior: RGB MAE {metrics['painterly']['interior']['rgbMAE']}",
    [st_cur, t_st_paint, st_paint],
    [in_paint, t_in_paint, rm_paint],
    ["Street: Current", "Street: Painterly Target (dir2)", f"Street: Painterly ({tag})", f"Interior: Painterly ({tag})", "Interior: Painterly Target (dir2)", f"Debug Room: Painterly ({tag})"],
    f"{out_dir}/sheet-painterly-{tag}.jpg"
)

print(json.dumps(metrics))
`
  const py = Bun.spawnSync(["python3", "-c", pyScript], { stdout: "pipe", stderr: "inherit" })
  assert.equal(py.exitCode, 0)
  const metrics = JSON.parse(py.stdout.toString())
  const full = { ...metrics, roomPerf, outbreakPerf }
  writeFileSync(resolve(outDir, `metrics-${roundTag}.json`), JSON.stringify(full, null, 2) + "\n")
  console.log(JSON.stringify(full, null, 2))
} finally {
  labServer.stop(true)
  outbreakServer.stop(true)
  await browser.close()
}
