import {
  BackSide, Color, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshLambertMaterial, Quaternion, ShaderMaterial,
  SphereGeometry, Vector3,
} from "three"
import { WORLD_HALF, seededRandom, WORLD_SEED } from "../../sim/geography"
import { PALETTE } from "./palette"
import { SUN_DIRECTION } from "./settings"

/** Direction of the faint "wrong" star — the game's quiet cosmic-horror note. */
export const STRANGE_STAR = new Vector3(-0.42, 0.62, -0.66).normalize()

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
      starDir: { value: STRANGE_STAR.clone() },
      horizon: { value: new Color(PALETTE.horizon) },
      zenith: { value: new Color(PALETTE.zenith) },
      sunCol: { value: new Color(PALETTE.sunLight) },
      starCol: { value: new Color(PALETTE.starMint) },
      lilac: { value: new Color(PALETTE.auroraLilac) },
      time: { value: 0 },
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
      uniform vec3 sunDir, starDir, horizon, zenith, sunCol, starCol, lilac;
      uniform float time;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.0);
        vec3 col = mix(horizon, zenith, smoothstep(0.0, 0.55, pow(up, 0.8)));
        // Warm glow around a soft sun disc.
        float sd = max(dot(d, sunDir), 0.0);
        col = mix(col, sunCol, pow(sd, 12.0) * 0.25);
        col = mix(col, vec3(1.0, 0.99, 0.95), smoothstep(0.9986, 0.9992, sd));

        // The strange star: a tiny mint point with a lilac ring that breathes very slowly.
        float st = max(dot(d, normalize(starDir)), 0.0);
        float ang = acos(clamp(st, -1.0, 1.0));
        float pulse = 0.7 + 0.3 * sin(time * 0.31) * sin(time * 0.07 + 1.3);
        col = mix(col, starCol, smoothstep(0.0032, 0.0018, ang) * 0.9 * pulse);
        col = mix(col, lilac, smoothstep(0.0022, 0.0, abs(ang - 0.028)) * 0.35 * pulse);

        // Faint lilac aurora curtain low over the northern horizon.
        float north = smoothstep(0.2, 0.9, -d.z);
        float bandMask = smoothstep(0.03, 0.09, d.y) * (1.0 - smoothstep(0.1, 0.26, d.y));
        float curtain = 0.5 + 0.5 * sin(atan(d.x, -d.z) * 12.0 + time * 0.04);
        col = mix(col, lilac, north * bandMask * curtain * 0.12);

        col = mix(horizon, col, smoothstep(-0.02, 0.02, d.y));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
  const mesh = new Mesh(geometry, material)
  mesh.name = "World · sky dome"
  mesh.renderOrder = -1000
  mesh.frustumCulled = false
  return {
    mesh,
    update(camera: Vector3, time: number) {
      mesh.position.copy(camera)
      material.uniforms.time.value = time % 10000
    },
    dispose() { geometry.dispose(); material.dispose() },
  }
}

/** Low-poly cumulus: flat-shaded, flat-bottomed icospheres grouped into clusters (one draw call). */
export function createClouds(clusters: number) {
  const geometry = new IcosahedronGeometry(1, 1)
  geometry.deleteAttribute("normal")
  geometry.deleteAttribute("uv")
  const material = new MeshLambertMaterial({ color: "#ffffff", flatShading: true, emissive: new Color("#c9d6e2"), emissiveIntensity: 0.55, toneMapped: false })
  material.name = "World · clouds"
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed.y = max(transformed.y, -0.3);")
  }
  material.customProgramCacheKey = () => "world-clouds-lowpoly-v1"
  const rand = seededRandom(WORLD_SEED ^ 0xc10d)
  const mats: Matrix4[] = []
  const pos = new Vector3(), scl = new Vector3(), q = new Quaternion(), up = new Vector3(0, 1, 0)
  for (let c = 0; c < clusters; c++) {
    const cx = (rand() * 2 - 1) * (WORLD_HALF + 4000), cz = (rand() * 2 - 1) * (WORLD_HALF + 4000)
    const base = 1800 + rand() * 1300
    const size = 170 + rand() * 210
    const len = 1.3 + rand() * 1.4
    const ang = rand() * Math.PI
    const n = 5 + Math.floor(rand() * 5)
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * 2 - 1
      const along = t * size * len + (rand() - 0.5) * size * 0.4
      const across = (rand() - 0.5) * size * 0.8
      const s = size * (0.5 + 0.5 * (1 - Math.abs(t)) + rand() * 0.25)
      pos.set(cx + Math.cos(ang) * along - Math.sin(ang) * across, 0, cz + Math.sin(ang) * along + Math.cos(ang) * across)
      const sy = s * (0.85 + rand() * 0.25)
      pos.y = base + 0.3 * sy
      scl.set(s * (1.05 + rand() * 0.3), sy, s)
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
