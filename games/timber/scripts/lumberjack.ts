// The lumberjack's person: Rocketbox m05 (MIT, `packages/kit/people/assets/CREDITS.md`) with its outfit texture
// repainted by `lumberjack.py` (buffalo-check flannel shirt, black canvas vest, dark work trousers and boots), written
// to `public/people/lumberjack.glb`. Everything else (mesh, skeleton, `extras.people`) is m05's own.
//   bun scripts/lumberjack.ts   (needs uv, for the Python repaint)
import { NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const src = join(root, "../../packages/kit/people/assets/m05-rocketbox.glb")
const out = join(root, "public/people/lumberjack.glb")
await MeshoptDecoder.ready
await MeshoptEncoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder })
const doc = await io.read(src)
const body = doc.getRoot().listTextures().find((t) => /body_color/.test(t.getName() || t.getURI()))
if (!body) throw new Error(`${src}: no body colour texture`)
const tmp = mkdtempSync(join(tmpdir(), "lumberjack-"))
try {
  const a = join(tmp, "in.webp"), b = join(tmp, "out.webp")
  await Bun.write(a, body.getImage()!)
  const p = Bun.spawnSync(["uv", "run", "-q", "--with", "numpy", "--with", "pillow", "python", join(import.meta.dir, "lumberjack.py"), a, b], { stdout: "inherit", stderr: "inherit" })
  if (p.exitCode !== 0) throw new Error("lumberjack.py failed")
  body.setImage(new Uint8Array(readFileSync(b))).setMimeType("image/webp")
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
mkdirSync(join(root, "public/people"), { recursive: true })
await io.write(out, doc)
const sha = new Bun.CryptoHasher("sha256").update(readFileSync(out)).digest("hex")
console.log(`wrote ${out} (${Math.round(readFileSync(out).byteLength / 1024)} KB, sha256 ${sha})`)
