// Generator benchmark in Bun (JavaScriptCore). The same suite runs in Chrome/V8 via bench/browser-bench.ts.
//
//   bun bench/wasm/build.ts && bun bench/gen-bench.ts
import { runSuite } from "./kernels/gen-suite"
import { TMP } from "./lib"

const scalar = new Uint8Array(await Bun.file(`${TMP}/terrain.wasm`).arrayBuffer())
const simd = new Uint8Array(await Bun.file(`${TMP}/terrain-simd.wasm`).arrayBuffer())
console.log(JSON.stringify({ runtime: `bun ${Bun.version} (JSC)`, ...(await runSuite({ scalar, simd })) }, null, 1))
