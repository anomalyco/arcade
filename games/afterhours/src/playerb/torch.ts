import * as THREE from "three/webgpu"
import { exp, length, uniform, uv, vec3 } from "three/tsl"

// A period two-D-cell aluminium flashlight (black anodised barrel with knurled grip, flared reflector head, tail cap),
// turned from a lathe profile. Origin at the grip (where the fist closes), lens toward -Z.

export function createTorch() {
  // [radius, z] from the tail cap (+z) to the lens (-z), metres.
  const profile: [number, number][] = [
    [0, 0.105], [0.012, 0.105], [0.0165, 0.1], [0.0172, 0.093], [0.0168, 0.088], [0.0168, -0.07],
    [0.0175, -0.075], [0.0175, -0.088], [0.0215, -0.11], [0.0262, -0.128], [0.0272, -0.134], [0.0272, -0.148],
    [0.0262, -0.152], [0.024, -0.153],
  ]
  // Lathe points must run bottom to top (increasing y) for outward faces; listed tail to lens, so reversed. (Inward
  // faces left only the far inside of the head visible: a thin dark ring floating at the lens.)
  const pts = profile.map(([r, z]) => new THREE.Vector2(r, z)).reverse()
  const body = new THREE.LatheGeometry(pts, 28)
  // Lathe turns about Y; lay it along Z.
  body.rotateX(Math.PI / 2)
  body.computeVertexNormals()
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x141416, metalness: 0.85, roughness: 0.42 })
  const knurl = new THREE.MeshStandardNodeMaterial({ color: 0x101012, metalness: 0.8, roughness: 0.7 })
  // The lit lens: the filament's image in the reflector, a hot centre fading to the rim (seen in mirrors, or when the
  // beam is turned back at you). `userData.lensLevel` (0..1) dims it with the light.
  const lens = new THREE.MeshStandardNodeMaterial({ color: 0x222222, metalness: 0, roughness: 0.05 })
  const lensLevel = uniform(1)
  const r = length(uv().sub(0.5)).mul(2)
  lens.emissiveNode = vec3(1, 0.86, 0.62).mul(exp(r.mul(r).mul(-3.5)).mul(36).add(2)).mul(lensLevel)

  const group = new THREE.Group()
  group.name = "torch"
  const barrel = new THREE.Mesh(body, metal)
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.0172, 0.0172, 0.11, 28, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.0), knurl)
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.024, 28).translate(0, 0, 0).rotateY(Math.PI).translate(0, 0, -0.1525), lens)
  for (const m of [barrel, grip, glass]) {
    m.castShadow = false
    m.receiveShadow = true
    group.add(m)
  }
  const lensAt = new THREE.Object3D()
  lensAt.position.set(0, 0, -0.155)
  group.add(lensAt)
  group.userData.lens = lensAt
  group.userData.lensLevel = lensLevel
  group.visible = false
  return group
}
