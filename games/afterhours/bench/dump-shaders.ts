// Dumps every WGSL program three built for the game (after boot completes) and explains why there are so many:
// clusters them by material name and by "shape" (numeric literals and identifiers normalised) to show how many are
// distinct only by baked-in constants, plus where the node-build count comes from (render objects per material).
//
//   bun bench/dump-shaders.ts --dir $TMP/build-dev [--view road] [--out $TMP/shaders]
import { mkdirSync, writeFileSync } from "node:fs"
import { arg, launch, serve, TMP } from "./lib"

const args = process.argv.slice(2)
const dir = arg(args, "dir", `${TMP}/build-dev`)!
const view = arg(args, "view", "road")!
const outDir = arg(args, "out", `${TMP}/shaders`)!
const server = serve(dir, 5224)
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } })
await page.goto(`http://localhost:5224/?shot=1&view=${view}`)
await page.waitForFunction(() => (globalThis as any).__afterhours?.complete, undefined, { timeout: 240_000, polling: 200 })
const dump = await page.evaluate(() => {
  const { renderer } = (globalThis as any).__afterhoursDebug
  const P = renderer._pipelines
  const progs = (m: Map<string, any>) => [...m.values()].map((s) => ({ id: s.id, name: s.name, stage: s.stage, code: s.code, usedTimes: s.usedTimes }))
  const { scene } = (globalThis as any).__afterhoursDebug
  const limit = renderer.backend.capabilities.getUniformBufferLimit()
  const inst: Record<string, { meshes: number; uniformPath: number; instances: number; materials: Set<unknown> }> = {}
  const meshes: Record<string, { meshes: number; materials: Set<unknown> }> = {}
  for (const root of scene.children) {
    root.traverse((o: any) => {
      if (!o.isMesh) return
      const key = root.name || root.type
      const m = (meshes[key] ??= { meshes: 0, materials: new Set() })
      m.meshes++
      m.materials.add(o.material)
      if (!o.isInstancedMesh) return
      const e = (inst[key] ??= { meshes: 0, uniformPath: 0, instances: 0, materials: new Set() })
      e.meshes++
      e.instances += o.count
      e.materials.add(o.material)
      if (o.instanceMatrix.count * 64 <= limit && !o.instanceMatrix.isStorageInstancedBufferAttribute) e.uniformPath++
    })
  }
  const fix = (r: Record<string, any>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ...v, materials: v.materials.size }]))
  return { vertex: progs(P.programs.vertex), fragment: progs(P.programs.fragment), pipelines: P.caches.size, uniformLimit: limit, instancedByModule: fix(inst), meshesByModule: fix(meshes) }
})
await browser.close()
server.stop(true)

mkdirSync(outDir, { recursive: true })
const norm = (c: string) =>
  c
    .replace(/\/\/.*$/gm, "")
    .replace(/\b\d+\.\d+(e[+-]?\d+)?\b|\b\d+(u|i|f)?\b/g, "#")
    .replace(/\b(nodeVar|nodeVarying|nodeUniform|NodeBuffer_|nodeUniformsGroup|NodeTexture|v)\w*/g, "$1")
    .replace(/\s+/g, " ")
const report: Record<string, unknown> = { pipelines: dump.pipelines, uniformLimit: dump.uniformLimit, instancedByModule: dump.instancedByModule, meshesByModule: dump.meshesByModule }
for (const stage of ["vertex", "fragment"] as const) {
  const list = dump[stage]
  for (const p of list) writeFileSync(`${outDir}/${stage}-${String(p.id).padStart(4, "0")}-${(p.name || "unnamed").replace(/\W+/g, "_")}.wgsl`, p.code)
  const byName = new Map<string, number>()
  for (const p of list) byName.set(p.name || "(unnamed)", (byName.get(p.name || "(unnamed)") ?? 0) + 1)
  const shapes = new Set(list.map((p) => norm(p.code)))
  const bytes = list.reduce((a, p) => a + p.code.length, 0)
  report[stage] = {
    programs: list.length,
    distinctIgnoringLiteralsAndNames: shapes.size,
    avgKB: +(bytes / list.length / 1024).toFixed(1),
    topMaterialNames: Object.fromEntries([...byName].sort((a, b) => b[1] - a[1]).slice(0, 25)),
  }
}
console.log(JSON.stringify(report, null, 1))
process.exit(0)
