// Builds Body B: public/models/playerb/janitor_b.glb and src/playerb/clips.json (see scripts/playerb/build.py).
//
//   bun scripts/playerb/build.ts
//
// Needs Blender with MPFB 2 and the CC0 MakeHuman assets (scripts/player/build-body.ts installs both), and fetches
// (cached in $TMPDIR/ahb): the Quaternius UAL 1+2 Standard GLBs and the CMU mocap takes listed in build.py.
import { existsSync, mkdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const cache = join(tmpdir(), "ahb")
const cmu = join(cache, "cmu")
mkdirSync(cmu, { recursive: true })
const UAL = "https://raw.githubusercontent.com/NafisRayan/Animate-Rigged-Humanoid-No-Blender/HEAD/"
const UAL1 = `${UAL}Universal%20Animation%20Library%5BStandard%5D/Universal%20Animation%20Library%5BStandard%5D/Unreal-Godot/UAL1_Standard.glb`
const UAL2 = `${UAL}Universal%20Animation%20Library%202%5BStandard%5D/Universal%20Animation%20Library%202%5BStandard%5D/Unreal-Godot/UAL2_Standard.glb`
const TAKES = ["07_01", "07_12", "16_35", "16_02", "127_06", "143_39", "143_40"]

const download = async (url: string, file: string) => {
  if (existsSync(file) && statSync(file).size > 0) return file
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await Bun.write(file, res)
  return file
}
const ual1 = await download(UAL1, join(cache, "UAL1.glb"))
const ual2 = await download(UAL2, join(cache, "UAL2.glb"))
await Promise.all(
  TAKES.flatMap((t) => {
    const s = t.split("_")[0]!
    const dir = `http://mocap.cs.cmu.edu/subjects/${s.padStart(2, "0")}`
    return [download(`${dir}/${t}.amc`, join(cmu, `${t}.amc`)), download(`${dir}/${s}.asf`, join(cmu, `${s}.asf`))]
  }),
)
const raw = join(cache, "raw.glb")
const p = Bun.spawn(["blender", "-b", "--python", join(import.meta.dir, "build.py"), "--", raw, ual1, ual2, cmu, join(root, "src/playerb/clips.json")], { stdout: "pipe", stderr: "pipe" })
const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text())
if ((await p.exited) !== 0 || out.includes("Traceback")) throw new Error(out.slice(-3000))
for (const l of out.split("\n")) if (/^(M_|mocap|hip ratio|palm|forearm)/.test(l) || l.includes("->")) console.log(l)
await Bun.write(join(root, "public/models/playerb/janitor_b.glb"), Bun.file(raw))
console.log("wrote public/models/playerb/janitor_b.glb", (statSync(raw).size / 1e6).toFixed(2), "MB")
