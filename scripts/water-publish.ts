/** Publish one measured/captured checkpoint without overwriting earlier evidence. */
import { mkdirSync, copyFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { homedir } from "node:os"

const iteration = process.argv[2]
if (!iteration || !/^candidate-\d+$/.test(iteration)) throw Error("Usage: bun scripts/water-publish.ts candidate-N")
const source = resolve(`captures/water/${iteration}`)
const root = resolve(homedir(), "code/home/artifacts/water-2026-10-22")
const out = resolve(root, iteration)
mkdirSync(out, { recursive: true })
for (const file of ["carrier-today-control.png", "carrier-continuous.png", "carrier-today-restored.png", "stills.json", "timing.json", "baseline.json"]) {
  if (existsSync(`${source}/${file}`)) copyFileSync(`${source}/${file}`, `${out}/${file}`)
}
const wake = existsSync(`${source}/wake/carrier-wake.mp4`)
if (wake) {
  const manifest = await Bun.file(`${source}/wake/manifest.json`).json()
  if (!manifest.simulationAndCameraIdentical || manifest.frames !== 180 || JSON.stringify(manifest.traces[0]) !== JSON.stringify(manifest.traces[1])) throw Error("Wake traces do not match")
  mkdirSync(`${out}/wake`, { recursive: true })
  for (const file of ["carrier-wake.mp4", "today.mp4", "continuous.mp4", "today.png", "continuous.png", "today-strip.png", "continuous-strip.png", "manifest.json"]) copyFileSync(`${source}/wake/${file}`, `${out}/wake/${file}`)
}
const notes: Record<string, string> = {
  "candidate-3": "Rejected: irregular close chop improves on the repeating waves, but broad glare and solid crest foam remain.",
  "candidate-4": "Superseded: sparse glints improved the glare, but the surface wake had gaps and weak arms.",
  "candidate-5": "Superseded: surface wake and Kelvin arms became continuous, but foam was too solid.",
  "candidate-6": "Current review candidate: seven irregular wave scales, sharp glints, broken whitecaps, surface prop wash and Kelvin arms. Broader reflected bands and more saturated blue remain compared with the target. Today is the default. Kit will judge performance on his computer.",
}
await Bun.write(`${out}/.opencode-session`, process.env.OPENCODE_SESSION_ID ?? "ses_e9b42f83effel2YM9iP7ZfShOS")
await Bun.write(`${out}/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Water · ${iteration}</title>
<style>body{margin:24px;background:#0c141d;color:#dce7ee;font:16px/1.5 system-ui}main{max-width:1800px;margin:auto}a{color:#8ed6e9}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0}img{display:block;width:100%}figcaption{padding:8px 0}video{width:100%;max-width:800px}p{max-width:900px}@media(max-width:800px){.grid{grid-template-columns:1fr}}</style>
<main><a href="../index.html">Water review</a><h1>Water · ${iteration}</h1><p>${notes[iteration] ?? "Captured checkpoint; status is in the experiment ledger."}</p>
<div class="grid"><figure><a href="carrier-today-control.png"><img src="carrier-today-control.png" alt="Today"></a><figcaption>Today</figcaption></figure><figure><a href="carrier-continuous.png"><img src="carrier-continuous.png" alt="Candidate"></a><figcaption>${iteration} · actual renderer</figcaption></figure><figure><a href="../carrier-target-v2.png"><img src="../carrier-target-v2.png" alt="Generated shading target"></a><figcaption>Target · generated paint-over</figcaption></figure></div>
${wake ? `<h2>Six-second wake comparison</h2><p>Today above, candidate below. Same boat, ship and camera traces; all 180 frames agree.</p><video controls muted playsinline preload="metadata" src="wake/carrier-wake.mp4"></video><p><a href="wake/continuous.mp4">Candidate full-size clip</a> · <a href="wake/manifest.json">Trace evidence</a></p><h2>Motion samples</h2><img src="wake/continuous-strip.png" alt="Twelve frames over six seconds">` : ""}
<p><a href="../water.md">Experiment ledger</a>${existsSync(`${out}/timing.json`) ? ' · <a href="timing.json">GPU timings</a>' : " · GPU cost not measured for this checkpoint."}</p></main></html>`)
console.log(out)
