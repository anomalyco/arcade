import {
  BackSide, Color, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshLambertMaterial, Quaternion, ShaderMaterial,
  SphereGeometry, Vector3,
} from "three"
import { WORLD_HALF, seededRandom, WORLD_SEED } from "../../sim/geography"
import { srgbColor } from "./atmosphere"
import { SKY_HORIZON, SKY_ZENITH, SUN_COLOR } from "./palette"
import { SUN_DIRECTION } from "./settings"

/** Clean blue sky dome: pale horizon (== fog) → deeper zenith, sun with a gentle glow. One draw call. */
export function createSky() {
  const geometry = new SphereGeometry(1000, 32, 16)
  const material = new ShaderMaterial({
    name: "World · sky",
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    uniforms: {
      sunDir: { value: SUN_DIRECTION.clone() },
      sunCol: { value: srgbColor(SUN_COLOR) },
      horizon: { value: srgbColor(SKY_HORIZON) },
      zenith: { value: srgbColor(SKY_ZENITH) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir, sunCol, horizon, zenith;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.0);
        vec3 col = mix(horizon, zenith, pow(smoothstep(0.0, 1.0, up), 0.55));
        float s = max(dot(d, sunDir), 0.0);
        // Gentle glow + a soft bright disc.
        col += sunCol * (pow(s, 8.0) * 0.06 + pow(s, 64.0) * 0.15);
        col = mix(col, vec3(1.0, 0.99, 0.95), smoothstep(0.9993, 0.9997, s));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const mesh = new Mesh(geometry, material)
  mesh.name = "World · sky dome"
  mesh.renderOrder = -1000
  mesh.frustumCulled = false
  return {
    mesh,
    update(camera: Vector3, _time: number) { mesh.position.copy(camera) },
    dispose() { geometry.dispose(); material.dispose() },
  }
}

/** Big smooth white cumulus: clusters of soft spheres with flattened, slightly shaded undersides. */
export function createClouds(clusters: number) {
  const geometry = new IcosahedronGeometry(1, 3)
  geometry.deleteAttribute("uv")
  const material = new MeshLambertMaterial({ color: "#eef1f2", emissive: new Color("#c9d2d8"), emissiveIntensity: 0.5, toneMapped: false })
  material.name = "World · clouds"
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nif (position.y < -0.25) objectNormal = normalize(mix(objectNormal, vec3(0.0, -1.0, 0.0), 0.7));")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed.y = max(transformed.y, -0.25);")
  }
  material.customProgramCacheKey = () => "world-clouds-smooth-v1"
  const rand = seededRandom(WORLD_SEED ^ 0xc10d)
  const mats: Matrix4[] = []
  const pos = new Vector3(), scl = new Vector3(), q = new Quaternion(), up = new Vector3(0, 1, 0)
  for (let c = 0; c < clusters; c++) {
    const cx = (rand() * 2 - 1) * (WORLD_HALF + 5000), cz = (rand() * 2 - 1) * (WORLD_HALF + 5000)
    const base = 1300 + rand() * 900
    const size = 280 + rand() * 260
    const n = 8 + Math.floor(rand() * 6)
    for (let i = 0; i < n; i++) {
      // Puffs heap toward the middle so each cloud has a tall rounded crown.
      const a = rand() * Math.PI * 2, r = Math.pow(rand(), 0.8) * size * 1.5
      const centre = 1 - r / (size * 1.6)
      const s = size * (0.45 + 0.55 * centre) * (0.8 + rand() * 0.4)
      const sy = s * (0.8 + rand() * 0.25) * (1 + centre * 0.6)
      // Every puff's clipped underside sits on the shared cloud base.
      pos.set(cx + Math.cos(a) * r, base + 0.25 * sy, cz + Math.sin(a) * r * 0.8)
      scl.set(s * 1.1, sy, s)
      q.setFromAxisAngle(up, rand() * Math.PI * 2)
      mats.push(new Matrix4().compose(pos, q, scl))
    }
  }
  const mesh = new InstancedMesh(geometry, material, mats.length)
  mats.forEach((m, i) => mesh.setMatrixAt(i, m))
  mesh.computeBoundingSphere()
  mesh.name = "World · clouds"
  mesh.frustumCulled = false
  return {
    mesh,
    dispose() { geometry.dispose(); material.dispose(); mesh.dispose() },
  }
}
