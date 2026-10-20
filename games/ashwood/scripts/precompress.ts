// Post-build: writes a brotli copy (`<file>.br`, quality 11) next to every built asset that Cloudflare won't compress
// on its own (binary types: .glb, .bin), when it saves at least 5%. The Worker (server/index.ts) serves the .br with
// `Content-Encoding: br` to browsers that accept it. KTX2 (Basis, already supercompressed) and Ogg don't shrink, and
// text types (.js, .css, .json, .html, .wasm) are compressed by Cloudflare already.
//
//   bun scripts/precompress.ts            # after `vite build` (part of `bun run build`)
import { brotliCompressSync, constants } from "node:zlib"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, existsSync } from "node:fs"
import { join } from "node:path"

const root = `${import.meta.dir}/../dist/arcade/ashwood`
// Quality 11 is slow (~2 min for the whole set), so results are cached by content hash across builds.
const cache = `${import.meta.dir}/../node_modules/.cache/precompress`
mkdirSync(cache, { recursive: true })
const EXT = /\.(glb|bin)$/
let raw = 0
let packed = 0
let files = 0
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (EXT.test(name)) {
      const buf = readFileSync(p)
      const key = `${cache}/${createHash("sha1").update(buf).digest("hex")}.br`
      let br: Buffer
      if (existsSync(key)) br = readFileSync(key)
      else {
        br = brotliCompressSync(buf, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
        })
        writeFileSync(key, br)
      }
      raw += buf.length
      if (br.length < buf.length * 0.95) {
        writeFileSync(`${p}.br`, br)
        packed += br.length
        files++
      } else {
        if (existsSync(`${p}.br`)) unlinkSync(`${p}.br`)
        packed += buf.length
      }
    }
  }
}
walk(root)
console.log(`precompress: ${files} files, ${(raw / 1e6).toFixed(1)} MB → ${(packed / 1e6).toFixed(1)} MB on the wire`)
