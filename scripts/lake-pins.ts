/** Today's forest scene shader must be byte-identical to main's: the moonlit lake compiles separately. */
import { createHash } from "node:crypto"
import { unlinkSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { makeSceneShader } from "../packages/kit/gpu/shaders"
import { cutoutDepthWgsl, forestHooks, treeVertexWgsl, WOODS_FLOATS } from "../packages/kit/forest/shaders"

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args])
  if (r.exitCode) throw Error(r.stderr.toString())
  return r.stdout.toString()
}
const base = process.argv[2] ?? git("merge-base", "HEAD", "origin/main").trim()
const temporary = resolve("packages/kit/forest/.lake-baseline-shaders.ts")
writeFileSync(temporary, git("show", `${base}:packages/kit/forest/shaders.ts`), { flag: "wx" })
let before: { text: string; floats: number }
try {
  const m = await import(temporary)
  before = { text: makeSceneShader(m.forestHooks) + m.treeVertexWgsl + m.cutoutDepthWgsl, floats: m.WOODS_FLOATS }
} finally { unlinkSync(temporary) }
const now = makeSceneShader(forestHooks) + treeVertexWgsl + cutoutDepthWgsl
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)
if (now !== before.text) throw Error(`Today forest shader differs from ${base}: ${hash(before.text)} → ${hash(now)}`)
if (WOODS_FLOATS !== before.floats) throw Error(`WOODS_FLOATS ${before.floats} → ${WOODS_FLOATS}`)
console.log(`Today forest shader byte-identical to ${base.slice(0, 8)} (${hash(now)}, ${now.length} chars); WOODS_FLOATS ${WOODS_FLOATS}`)
