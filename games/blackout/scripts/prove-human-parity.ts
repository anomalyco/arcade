// Pass an exported 8223033 repository tree. Compare within one runtime to avoid cross-engine rounding claims.
import { resolve } from "node:path"
import { animate, fire, hit, newAvatar } from "../src/game/anim"
import { animation } from "../src/game/anim-settings"

const baseline = process.argv[2]
if (!baseline) throw new Error("Usage: bun scripts/prove-human-parity.ts <baseline repository directory>")
const original = await import(resolve(baseline, "games/blackout/src/game/anim.ts")) as typeof import("../src/game/anim")
const settings = await import(resolve(baseline, "games/blackout/src/game/anim-settings.ts")) as typeof import("../src/game/anim-settings")
const current = { animate, fire, hit, newAvatar }
const results = []
for (const mode of ["old", "new"]) {
  settings.animation.animationMode = animation.animationMode = mode
  const hashes = [original, current].map(api => {
    const a = api.newAvatar("parity", 0, 0, 0, "rifle"), hash = new Bun.CryptoHasher("sha256")
    let x = 0, y = 0
    for (let n = 0; n < 900; n++) {
      const speed = n < 300 ? 4.2 : n < 600 ? 6.3 : 1.4, direction = n / 150
      const vx = Math.cos(direction) * speed, vy = Math.sin(direction) * speed
      x += vx / 60; y += vy / 60
      if (n % 43 === 0) api.fire(a, n / 60)
      if (n === 380) api.hit(a, 0.2, 1)
      api.animate(a, 1 / 60, n / 60, x, y, vx, vy, n / 130)
      hash.update(JSON.stringify(a.body))
    }
    return hash.digest("hex")
  })
  results.push({ mode, frames: 900, exact: hashes[0] === hashes[1], hashes })
}
console.log(JSON.stringify({ baseline: "822303310da0bd95901879570e27c5b942ca4aa9", results }, null, 2))
if (results.some(result => !result.exact)) process.exit(1)
