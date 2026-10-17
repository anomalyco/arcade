// Builds the Rust terrain port twice (scalar, +simd128) into $TMP. Needs `rustup target add wasm32-unknown-unknown`.
import { TMP } from "../lib"

const env = { ...process.env, CARGO_TARGET_DIR: `${TMP}/cargo` }
const out = `${TMP}/cargo/wasm32-unknown-unknown/release/terrain_wasm.wasm`
for (const [name, flags] of [["terrain.wasm", ""], ["terrain-simd.wasm", "-C target-feature=+simd128"]] as const) {
  const r = Bun.spawnSync(["cargo", "build", "--release", "--target", "wasm32-unknown-unknown"], { cwd: import.meta.dir, env: { ...env, RUSTFLAGS: flags }, stderr: "inherit" })
  if (r.exitCode !== 0) process.exit(1)
  await Bun.write(`${TMP}/${name}`, Bun.file(out))
  console.log(`${TMP}/${name}`, Bun.file(`${TMP}/${name}`).size, "bytes")
}
