import {
  BackSide, Color, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshLambertMaterial, Quaternion, ShaderMaterial,
  SphereGeometry, Vector3,
} from "three"
import { WORLD_HALF, seededRandom, WORLD_SEED } from "../../sim/geography"
import { applyGoldenHaze, HAZE_GLSL, HAZE_UNIFORMS, srgbColor } from "./atmosphere"
import { PALETTE, SUN_COLOR, WATCHER_DIRECTION, WATCHER_RADIUS } from "./palette"
import { SUN_DIRECTION } from "./settings"

/**
 * Golden-hour sky dome (all colours in sRGB): haze at the horizon (matches the fog), peach → rose
 * → dusty lavender → indigo zenith, a low sun with a soft halo, and the Watcher — a vast pale ringed
 * moon hanging opposite the sun, with faint aurora ribbons. One draw call.
 */
export function createSky() {
  const geometry = new SphereGeometry(1000, 48, 24)
  const material = new ShaderMaterial({
    name: "World · sky",
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    uniforms: {
      ...HAZE_UNIFORMS,
      sunDir: { value: SUN_DIRECTION.clone() },
      sunCol: { value: srgbColor(SUN_COLOR) },
      watcherDir: { value: new Vector3(...WATCHER_DIRECTION).normalize() },
      watcherRadius: { value: WATCHER_RADIUS },
      peach: { value: srgbColor(PALETTE.skyPeach) },
      rose: { value: srgbColor(PALETTE.skyRose) },
      lavender: { value: srgbColor(PALETTE.skyLavender) },
      indigo: { value: srgbColor(PALETTE.skyIndigo) },
      moonLit: { value: srgbColor(PALETTE.watcher) },
      moonShade: { value: srgbColor(PALETTE.watcherShade) },
      aurora: { value: srgbColor(PALETTE.aurora) },
      auroraLilac: { value: srgbColor(PALETTE.auroraLilac) },
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
      uniform vec3 sunDir, sunCol, watcherDir, peach, rose, lavender, indigo, moonLit, moonShade, aurora, auroraLilac;
      uniform float watcherRadius, time;
      varying vec3 vDir;
      ${HAZE_GLSL}
      float h31(vec3 p) { p = fract(p * 0.3183 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float n3(vec3 x) {
        vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      void main() {
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.0);
        float s = dot(d, sunDir);
        float sunSide = smoothstep(-0.5, 1.0, s);

        // Elevation gradient; the sun side stays warmer and brighter for longer.
        float e = pow(up, 0.62);
        vec3 col = mix(peach, rose, smoothstep(0.03, 0.30 + 0.2 * sunSide, e));
        col = mix(col, lavender, smoothstep(0.28 + 0.15 * sunSide, 0.62, e));
        col = mix(col, indigo, smoothstep(0.62, 1.0, e));
        // Horizon haze band == fog colour, so distant islands melt into the sky.
        col = mix(goldenHaze(d), col, smoothstep(0.0, 0.11, up));
        col = mix(col, goldenHaze(d), (1.0 - smoothstep(-0.02, 0.0, d.y)));

        // Sun: small crisp disc (~2°) + soft halo (~3× size) + wide warm bloom.
        float sAng = acos(clamp(s, -1.0, 1.0));
        col += sunCol * 0.55 * pow(1.0 - smoothstep(0.0, 0.06, sAng), 2.0);
        col += sunCol * 0.18 * pow(max(s, 0.0), 6.0);
        col = mix(col, vec3(1.0, 0.97, 0.88), 1.0 - smoothstep(0.0165, 0.0185, sAng));

        // ---- The Watcher ----
        vec3 W = normalize(watcherDir);
        vec3 wr = normalize(cross(vec3(0.0, 1.0, 0.0), W));
        vec3 wu = cross(W, wr);
        float wAng = acos(clamp(dot(d, W), -1.0, 1.0));
        float r = wAng / watcherRadius;
        vec2 q = vec2(dot(d, wr), dot(d, wu));
        vec2 uv = (length(q) > 1e-5 ? normalize(q) : vec2(0.0)) * r;
        // Atmospheric glow just outside the limb.
        col = mix(col, mix(lavender, moonLit, 0.4), (1.0 - smoothstep(1.0, 1.35, r)) * 0.22);
        // Ring: tilted ellipse, back half hidden by the body.
        float tilt = 0.32;
        vec2 ru = vec2(uv.x * 0.94 + uv.y * 0.34, -uv.x * 0.34 + uv.y * 0.94);
        float ringR = length(vec2(ru.x, ru.y / tilt));
        float ringBand = smoothstep(1.45, 1.52, ringR) * (1.0 - smoothstep(1.98, 2.08, ringR));
        ringBand *= 0.75 + 0.25 * sin(ringR * 22.0);
        bool ringFront = ru.y < 0.0;
        vec3 ringCol = mix(moonShade, moonLit, 0.55);
        if (r > 1.0 || ringFront) col = mix(col, ringCol, ringBand * 0.22);
        if (r < 1.0) {
          vec3 n = vec3(uv, sqrt(1.0 - r * r));
          // Lit from the sun behind the viewer, slightly from the side: a gibbous, uncanny phase.
          vec3 L = normalize(vec3(-0.55, 0.25, 0.8));
          float lit = smoothstep(-0.15, 0.55, dot(n, L));
          // Surface: soft bands + pale maria, very low contrast.
          vec3 sp = n * 3.1;
          float maria = smoothstep(0.52, 0.72, n3(sp + 4.0) * 0.65 + n3(sp * 2.3) * 0.35);
          float bands = 0.5 + 0.5 * sin(n.y * 9.0 + n3(sp * 1.4) * 2.5);
          vec3 surf = mix(moonLit, mix(moonLit, moonShade, 0.35), maria * 0.4 + bands * 0.1);
          vec3 body = mix(moonShade * 0.92, surf, lit);
          // Peach catch-light on the sun-facing limb and a dim violet rim.
          body += peach * 0.18 * pow(1.0 - n.z, 3.0) * lit;
          // An eye-like crater, far too regular.
          float eye = length((uv - vec2(0.18, 0.12)) * vec2(1.0, 1.6));
          body = mix(body, moonShade, (1.0 - smoothstep(0.08, 0.11, eye)) * 0.22);
          body = mix(body, moonLit, (1.0 - smoothstep(0.025, 0.04, eye)) * 0.35);
          if (ringFront) body = mix(body, ringCol, ringBand * 0.45);
          float edge = 1.0 - smoothstep(0.985, 1.0, r);
          // Sink into the horizon haze like a real body behind air.
          float sink = smoothstep(0.0, 0.22, up);
          // Seen through warm air: tinted toward the sky behind, never fully opaque.
          body = mix(body, lavender, 0.18);
          col = mix(col, mix(goldenHaze(d), body, 0.3 + 0.55 * sink), edge * 0.86);
        }

        // Faint aurora ribbons drifting beside the Watcher.
        float az = atan(dot(d, wr), dot(d, W));
        float nearW = 1.0 - smoothstep(0.3, 1.25, abs(az));
        float ribbonY = 0.18 + 0.06 * sin(az * 5.0 + time * 0.05) + 0.03 * sin(az * 13.0 - time * 0.07);
        float ribbon = exp(-pow((d.y - ribbonY) / 0.025, 2.0)) * (0.5 + 0.5 * sin(az * 40.0 + time * 0.3));
        float ribbon2 = exp(-pow((d.y - ribbonY - 0.07) / 0.018, 2.0));
        float outside = smoothstep(1.05, 1.4, r);
        col += (aurora * ribbon * 0.10 + auroraLilac * ribbon2 * 0.07) * nearW * outside;

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
    update(camera: Vector3, time: number) {
      mesh.position.copy(camera)
      material.uniforms.time.value = time % 10000
    },
    dispose() { geometry.dispose(); material.dispose() },
  }
}

/** Big soft low-poly cloud banks: lit pink/gold by the low sun, lilac in shade, rim glow. */
export function createClouds(clusters: number) {
  const geometry = new IcosahedronGeometry(1, 1)
  geometry.deleteAttribute("normal")
  geometry.deleteAttribute("uv")
  const material = new MeshLambertMaterial({ color: "#fff4ee", flatShading: true, emissive: new Color("#b9a3d6"), emissiveIntensity: 0.32, toneMapped: false })
  material.name = "World · clouds"
  material.onBeforeCompile = shader => {
    shader.uniforms.cloudSun = { value: SUN_DIRECTION.clone() }
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed.y = max(transformed.y, -0.3);")
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 cloudSun;")
      .replace("#include <opaque_fragment>", /* glsl */ `#include <opaque_fragment>
        // Rim glow: edges seen against the sun light up gold.
        vec3 vdir = normalize(vViewPosition);
        float rim = pow(1.0 - abs(dot(normal, -vdir)), 3.0);
        vec3 sunView = normalize((viewMatrix * vec4(cloudSun, 0.0)).xyz);
        float toward = smoothstep(0.0, 1.0, dot(-vdir, sunView));
        gl_FragColor.rgb += vec3(1.0, 0.78, 0.5) * rim * (0.12 + 0.35 * toward);`)
  }
  material.customProgramCacheKey = () => "world-clouds-golden-v1"
  applyGoldenHaze(material)
  const rand = seededRandom(WORLD_SEED ^ 0xc10d)
  const mats: Matrix4[] = []
  const pos = new Vector3(), scl = new Vector3(), q = new Quaternion(), up = new Vector3(0, 1, 0)
  for (let c = 0; c < clusters; c++) {
    const cx = (rand() * 2 - 1) * (WORLD_HALF + 5000), cz = (rand() * 2 - 1) * (WORLD_HALF + 5000)
    const base = 1100 + rand() * 1200
    const size = 240 + rand() * 300
    const len = 1.6 + rand() * 1.8
    const ang = rand() * Math.PI
    const n = 6 + Math.floor(rand() * 6)
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * 2 - 1
      const along = t * size * len + (rand() - 0.5) * size * 0.4
      const across = (rand() - 0.5) * size * 0.8
      const s = size * (0.5 + 0.5 * (1 - Math.abs(t)) + rand() * 0.25)
      pos.set(cx + Math.cos(ang) * along - Math.sin(ang) * across, 0, cz + Math.sin(ang) * along + Math.cos(ang) * across)
      const sy = s * (0.75 + rand() * 0.25)
      pos.y = base + 0.3 * sy
      scl.set(s * (1.1 + rand() * 0.3), sy, s)
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
