import * as THREE from "three/webgpu"
import { Fn, dot, float, interleavedGradientNoise, length, luminance, max, mix, pass, screenCoordinate, smoothstep, sRGBTransferOETF, uniform, uv, vec2, vec3, vec4 } from "three/tsl"
import { bloom } from "three/addons/tsl/display/BloomNode.js"

// The game's film finish (src/render/post.ts `finish`), trimmed for the lab: soft bloom, exposure, white balance,
// teal-shadow / warm-highlight split tone, the hue-preserving shoulder curve, saturation with protected warm hues,
// contrast, teal-lifted blacks, vignette and fine grain. Same default values as the game. No fog scattering, SSR, AO or
// TAAU (those are tied to the world's lamp list and layout), so MSAA stands in for the temporal AA.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export function createLabPost(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const pipeline = new THREE.RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const scenePass = (pass as N)(scene, camera, { samples: 4 })
  const color = scenePass.getTextureNode("output") as N
  const exposure = uniform(1)
  const frame = uniform(0)
  const g = {
    lift: uniform(0.018),
    warmth: uniform(0.12),
    teal: uniform(0.6),
    shoulder: uniform(1.6),
    contrast: uniform(1.12),
    saturation: uniform(0.92),
    warmSaturation: uniform(1.4),
    gamma: uniform(1.06),
    grain: uniform(0.012),
    vignette: uniform(0.45),
    halation: uniform(0.08),
  }
  const wb = uniform(new THREE.Color(1, 1, 1))
  {
    const temp = -0.12
    const tint = -0.04
    const c = new THREE.Color(1 + 0.25 * temp, 1 - 0.18 * tint, 1 - 0.35 * temp)
    wb.value.copy(c.multiplyScalar(1 / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b)))
  }
  const bl = bloom(color, 0.22, 0.75, 0) as N

  const finish = Fn(() => {
    const u = uv()
    const off = u.sub(0.5)
    let hdr: N = color.sample(u).rgb
    hdr = hdr.add(bl.rgb).add(bl.rgb.mul(vec3(1, 0.35, 0.12)).mul(g.halation))
    hdr = hdr.mul(exposure).mul(wb)
    const lum = luminance(hdr).toVar()
    hdr = hdr.mul(mix(vec3(1), vec3(0.86, 1.04, 1.02), smoothstep(0.15, 0.0, lum).mul(g.teal)))
    hdr = hdr.mul(mix(vec3(1), vec3(1.12, 1.0, 0.82), smoothstep(0.05, 1.5, lum).mul(g.warmth)))
    const peak = max(max(hdr.r, hdr.g), hdr.b).max(1e-5).toVar()
    const curve = (x: N) => {
      const k = x.mul(g.shoulder)
      return k.div(k.add(1)).mul(g.shoulder.add(1).div(g.shoulder))
    }
    const huePreserve = hdr.mul(curve(peak).min(1).div(peak))
    const perChannel = vec3(curve(hdr.r), curve(hdr.g), curve(hdr.b)).min(1)
    let ldr: N = mix(huePreserve, perChannel, smoothstep(4, 40, peak))
    const l2 = luminance(ldr)
    const mx = max(max(ldr.r, ldr.g), ldr.b).max(1e-5)
    const warm = smoothstep(0.15, 0.45, ldr.r.sub(ldr.b).div(mx)).mul(smoothstep(0.02, 0.12, mx))
    ldr = mix(vec3(l2), ldr, mix(g.saturation, g.warmSaturation, warm)).max(0)
    ldr = sRGBTransferOETF(ldr)
    ldr = ldr.sub(0.42).mul(g.contrast).add(0.42).clamp()
    ldr = ldr.pow(g.gamma)
    const liftCol = vec3(0.55, 1.05, 1.0).mul(g.lift)
    ldr = liftCol.add(ldr.mul(vec3(1).sub(liftCol)))
    const v = length(off.mul(vec2(1.0, 1.15)))
    ldr = ldr.mul(mix(float(1), smoothstep(0.85, 0.25, v), g.vignette))
    const p = screenCoordinate.xy
    const hash = (q: N) => {
      const w = vec3(q.x, q.y, frame.mul(17.31)).mul(vec3(0.1031, 0.103, 0.0973)).fract().toVar()
      const w2 = w.add(dot(w, w.yzx.add(33.33)))
      return w2.x.add(w2.y).mul(w2.z).fract()
    }
    const nn = hash(p.floor()).add(hash(p.floor().add(vec2(57.3, 19.1)))).sub(1).mul(0.7)
    const amt = g.grain.mul(mix(float(0.55), float(1), smoothstep(0.9, 0.15, luminance(ldr))))
    ldr = ldr.add(nn.mul(amt).mul(vec3(1, 0.97, 1.02)))
    const dn = interleavedGradientNoise(p.add(vec2(frame.mul(5.3), 0))).sub(0.5).div(255)
    return vec4(ldr.add(dn).clamp(), 1)
  })()
  pipeline.outputNode = finish

  return {
    /** Exposure in EV (the game's default is −2.2 for its physical lamp intensities). */
    setExposure(ev: number) {
      exposure.value = Math.pow(2, ev)
    },
    render() {
      frame.value = (frame.value + 1) % 4096
      pipeline.render()
    },
  }
}
