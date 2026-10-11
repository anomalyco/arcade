import {
  BackSide, Color, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshToonMaterial, Quaternion,
  ShaderMaterial, SphereGeometry, Vector3, type DataTexture,
} from "three"
import { WORLD_HALF, seededRandom, WORLD_SEED } from "../../sim/geography"
import { PALETTE, SUN_DIRECTION } from "./settings"

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
      uniform vec3 sunDir, starDir, horizon, zenith;
      uniform float time;
      varying vec3 vDir;
      float h1(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.0);
        vec3 col = mix(horizon, zenith, pow(up, 0.55));
        // Warm haze toward the sun.
        float sd = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.86, 0.6) * pow(sd, 10.0) * 0.22 * (1.0 - up * 0.5);
        // Cartoon sun: crisp disc + soft halo.
        col = mix(col, vec3(1.0, 0.98, 0.9), smoothstep(0.9985, 0.9991, sd));
        col += vec3(1.0, 0.92, 0.7) * pow(sd, 260.0) * 0.5;

        // The strange star: a cold pale-green point with a slow, uneasy pulse and thin rays.
        vec3 sdir = normalize(starDir);
        float st = max(dot(d, sdir), 0.0);
        vec3 side = normalize(cross(sdir, vec3(0.0, 1.0, 0.0)));
        vec3 upv = cross(side, sdir);
        vec2 q = vec2(dot(d, side), dot(d, upv));
        float pulse = 0.75 + 0.25 * sin(time * 0.37) * sin(time * 0.11 + 1.3);
        float core = smoothstep(0.99994, 0.99999, st);
        float halo = pow(st, 900.0) * 0.35 + pow(st, 120.0) * 0.06;
        float rays = (exp(-abs(q.x) * 1400.0) + exp(-abs(q.y) * 1400.0)) * pow(st, 900.0) * 0.3;
        float ring = smoothstep(0.0025, 0.0, abs(acos(clamp(st, -1.0, 1.0)) - 0.03)) * 0.09;
        vec3 starCol = vec3(0.62, 1.0, 0.7);
        col += starCol * (core * 0.9 + halo * 0.7 + rays) * pulse + vec3(0.7, 0.55, 1.0) * ring * pulse;

        // A very faint aurora-like veil low on the northern horizon.
        float north = smoothstep(0.1, 0.8, -d.z);
        float band = smoothstep(0.02, 0.1, d.y) * (1.0 - smoothstep(0.12, 0.32, d.y));
        float curtain = 0.5 + 0.5 * sin(atan(d.x, -d.z) * 14.0 + time * 0.05 + sin(d.x * 9.0 + time * 0.03) * 2.0);
        col += vec3(0.55, 0.45, 0.95) * north * band * curtain * 0.05;

        // Below the horizon blend into fog colour so the edge never shows.
        col = mix(horizon, col, smoothstep(-0.02, 0.03, d.y));
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

/** Puffy cartoon cumulus: one instanced mesh of flat-bottomed spheres, grouped into clusters. */
export function createClouds(ramp: DataTexture, clusters: number) {
  const geometry = new IcosahedronGeometry(1, 2)
  const material = new MeshToonMaterial({ color: "#ffffff", gradientMap: ramp, emissive: new Color("#a9bccd"), emissiveIntensity: 0.45, toneMapped: false })
  material.name = "World · clouds"
  // Clamp each puff's underside so clusters get the classic flat cumulus base.
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nif (position.y < -0.3) objectNormal = mix(objectNormal, vec3(0.0, -1.0, 0.0), 0.85);")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed.y = max(transformed.y, -0.3);")
  }
  material.customProgramCacheKey = () => "world-clouds-v1"
  const rand = seededRandom(WORLD_SEED ^ 0xc10d)
  const mats: Matrix4[] = []
  const pos = new Vector3(), scl = new Vector3(), q = new Quaternion(), up = new Vector3(0, 1, 0)
  for (let c = 0; c < clusters; c++) {
    const cx = (rand() * 2 - 1) * (WORLD_HALF + 4000), cz = (rand() * 2 - 1) * (WORLD_HALF + 4000)
    const base = 1800 + rand() * 1300
    const size = 160 + rand() * 220
    const len = 1.4 + rand() * 1.6
    const ang = rand() * Math.PI
    const n = 7 + Math.floor(rand() * 7)
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * 2 - 1 // along the cluster
      const along = t * size * len + (rand() - 0.5) * size * 0.4
      const across = (rand() - 0.5) * size * 0.9
      const center = 1 - Math.abs(t)
      const s = size * (0.45 + 0.55 * center + rand() * 0.25)
      pos.set(cx + Math.cos(ang) * along - Math.sin(ang) * across, 0, cz + Math.sin(ang) * along + Math.cos(ang) * across)
      // Bottom of each puff (local y = -0.3) sits on the shared base altitude.
      const sy = s * (0.8 + rand() * 0.25)
      pos.y = base + 0.3 * sy
      scl.set(s * (1.05 + rand() * 0.3), sy, s)
      q.setFromAxisAngle(up, rand() * Math.PI)
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
