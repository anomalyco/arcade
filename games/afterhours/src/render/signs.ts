import * as THREE from "three/webgpu"
import { texture, uv, vec3 } from "three/tsl"

// Lit sign faces drawn once into mipmapped canvas textures (readable up close, averaging cleanly at distance).

let exitMat: THREE.MeshStandardNodeMaterial | null = null

/**
 * Internally lit EXIT sign face (quad with 0..1 UVs, ~0.54 × 0.21 m): red stencil letters on a red translucent
 * face lit evenly from behind, a faint inner rim, the slight hot-spot of the tubes behind the plastic.
 */
export function exitSignMaterial() {
  if (exitMat) return exitMat
  const W = 512
  const H = 200
  const c = document.createElement("canvas")
  c.width = W
  c.height = H
  const g = c.getContext("2d")!
  g.fillStyle = "#000"
  g.fillRect(0, 0, W, H)
  // Glow layer (blurred) under crisp letters: the diffuser spreads the light a little around each stroke.
  const letters = (blur: number, alpha: number) => {
    g.save()
    g.filter = blur ? `blur(${blur}px)` : "none"
    g.globalAlpha = alpha
    g.fillStyle = "#fff"
    g.strokeStyle = "#fff"
    g.textAlign = "center"
    g.textBaseline = "middle"
    // Stencil style: heavy condensed sans with the bridges cut.
    g.font = `bold 128px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`
    g.fillText("EXIT", W / 2, H / 2 + 6)
    // Thin inner rim of the face panel (subtle).
    g.globalAlpha = alpha * 0.25
    g.lineWidth = 4
    g.strokeRect(14, 14, W - 28, H - 28)
    g.restore()
  }
  letters(6, 0.35)
  letters(0, 1)
  // Stencil bridges: thin horizontal gaps through the letters.
  g.fillStyle = "#000"
  g.globalAlpha = 0.85
  g.fillRect(W / 2 - 120, H / 2 + 4, 240, 5)
  g.globalAlpha = 1
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  t.anisotropy = 8
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x120303, roughness: 0.35 })
  const a = texture(t, uv()).r
  // Dim red diffuser everywhere, bright letters; a gentle vertical hot-spot from the lamps behind.
  const hot = uv().y.sub(0.5).abs().mul(-0.6).add(1)
  // Evenly backlit translucent face: letters a little brighter than the red field, both modest so bloom barely
  // catches (a 1984 sign glows, it doesn't flare).
  m.emissiveNode = vec3(1, 0.07, 0.035).mul(a.mul(0.75).add(0.14)).mul(hot.mul(0.3).add(0.7))
  m.name = "interior_exit_sign"
  exitMat = m
  return m
}
