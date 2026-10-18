import * as THREE from "three/webgpu"

// A period two-D-cell aluminium flashlight (black anodised barrel with knurled grip, flared reflector head, tail cap),
// turned from a lathe profile. Origin at the grip (where the fist closes), lens toward -Z.

/** Barrel radius where the hand holds it (m). */
export const TORCH_BARREL_R = 0.0172

export function createTorch() {
  // [radius, z] from the tail cap (+z) to the lens (-z), metres.
  // A two-D-cell torch: 25 cm overall, 34 mm barrel, 52 mm head; the fist (origin) is 6 cm from the tail cap so the
  // tail ends just past the heel of the hand.
  const profile: [number, number][] = [
    [0, 0.06], [0.012, 0.06], [0.0165, 0.056], [0.0172, 0.05], [0.0168, 0.045], [0.0168, -0.11],
    [0.0175, -0.115], [0.0175, -0.126], [0.0215, -0.148], [0.025, -0.166], [0.026, -0.172], [0.026, -0.186],
    [0.025, -0.189], [0.023, -0.19],
  ]
  const pts = profile.map(([r, z]) => new THREE.Vector2(r, z))
  const body = new THREE.LatheGeometry(pts, 28)
  // Lathe turns about Y; lay it along Z.
  body.rotateX(Math.PI / 2)
  body.computeVertexNormals()
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x141416, metalness: 0.85, roughness: 0.42 })
  const knurl = new THREE.MeshStandardNodeMaterial({ color: 0x101012, metalness: 0.8, roughness: 0.7 })
  const lens = new THREE.MeshStandardNodeMaterial({ color: 0x222222, metalness: 0, roughness: 0.05 })

  const group = new THREE.Group()
  group.name = "torch"
  const barrel = new THREE.Mesh(body, metal)
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.0172, 0.0172, 0.09, 28, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.01), knurl)
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.024, 28).translate(0, 0, 0).rotateY(Math.PI).translate(0, 0, -0.1895), lens)
  for (const m of [barrel, grip, glass]) {
    m.castShadow = false
    m.receiveShadow = true
    group.add(m)
  }
  const lensAt = new THREE.Object3D()
  lensAt.position.set(0, 0, -0.192)
  group.add(lensAt)
  group.userData.lens = lensAt
  group.visible = false
  return group
}
