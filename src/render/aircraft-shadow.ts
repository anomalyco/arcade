// Soft blob "contact shadow" under low-flying aircraft (Low quality fallback when shadow maps are off).
import { DataTexture, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, RGBAFormat, UnsignedByteType } from "three"

let texture: DataTexture | null = null
let geometry: PlaneGeometry | null = null

function blobTexture(): DataTexture {
  if (texture) return texture
  const n = 64
  const data = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5
      const dy = (y + 0.5) / n - 0.5
      const r = Math.sqrt(dx * dx + dy * dy) * 2
      // Soft falloff: solid-ish core, smooth fade to the rim.
      const a = r >= 1 ? 0 : Math.min(1, Math.pow(1 - r * r, 0.8) * 1.15)
      const i = (y * n + x) * 4
      data[i] = 30
      data[i + 1] = 36
      data[i + 2] = 48
      data[i + 3] = Math.round(a * 255)
    }
  }
  texture = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType)
  texture.magFilter = LinearFilter
  texture.minFilter = LinearFilter
  texture.needsUpdate = true
  return texture
}

/** Unit (1 × 1 m) horizontal blob in the XZ plane; scale X = span, Z = length. */
export function createBlobShadow(): Mesh {
  geometry ??= new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const mat = new MeshBasicMaterial({
    map: blobTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.4,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  })
  const mesh = new Mesh(geometry, mat)
  mesh.name = "ground_shadow"
  mesh.matrixAutoUpdate = false
  mesh.renderOrder = -1
  mesh.frustumCulled = false
  return mesh
}
