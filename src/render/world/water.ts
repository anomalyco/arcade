import {
  Color, DataTexture, LinearFilter, Mesh, PlaneGeometry, RedFormat, ShaderMaterial, UniformsLib, UniformsUtils, UnsignedByteType,
} from "three"
import { WORLD_HALF, WORLD_SIZE } from "../../sim/geography"
import { NOISE_GLSL } from "./glsl"
import { PALETTE } from "./settings"
import { SHORE_MAX, SHORE_MIN, SHORE_SIZE } from "./tile-gen"
import type { LightingUniforms } from "./terrain-material"

export function createWater(lighting: LightingUniforms) {
  const data = new Uint8Array(SHORE_SIZE * SHORE_SIZE) // 0 = deep until the worker fills it in
  const shore = new DataTexture(data, SHORE_SIZE, SHORE_SIZE, RedFormat, UnsignedByteType)
  shore.minFilter = LinearFilter
  shore.magFilter = LinearFilter
  shore.generateMipmaps = false
  shore.needsUpdate = true
  const c = (hex: string) => ({ value: new Color(hex) })
  const material = new ShaderMaterial({
    name: "World · ocean",
    toneMapped: false,
    fog: true,
    uniforms: {
      ...UniformsUtils.clone(UniformsLib.fog), ...lighting,
      shore: { value: shore }, time: { value: 0 },
      deep: c(PALETTE.deepWater), mid: c(PALETTE.midWater), shallow: c(PALETTE.shallowWater), foam: c(PALETTE.foam),
      abyss: c(PALETTE.abyss), skyHorizon: c(PALETTE.horizon), skyZenith: c(PALETTE.zenith),
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D shore;
      uniform float time;
      uniform vec3 deep, mid, shallow, foam, abyss, skyHorizon, skyZenith;
      uniform vec3 sunDir, sunColor, hemiSky, hemiGround;
      varying vec3 vWorld;
      ${NOISE_GLSL}
      vec2 waveGrad(vec2 p, float t) {
        vec2 g = vec2(0.0);
        // A handful of directional sines; derivatives give a cheap analytic normal.
        vec4 dirsX = vec4(0.8, -0.35, 0.25, -0.9);
        vec4 dirsZ = vec4(0.6, 0.94, -0.97, 0.3);
        vec4 freq = vec4(0.021, 0.034, 0.057, 0.093);
        vec4 amp = vec4(0.9, 0.55, 0.32, 0.2);
        vec4 speed = vec4(0.9, 1.15, 1.5, 1.9);
        for (int i = 0; i < 4; i++) {
          vec2 d = vec2(dirsX[i], dirsZ[i]);
          float ph = dot(d, p) * freq[i] + t * speed[i];
          g += d * cos(ph) * freq[i] * amp[i];
        }
        return g;
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = vWorld.xz;
        vec3 toEye = cameraPosition - vWorld;
        float dist = length(toEye);
        vec3 eye = toEye / dist;
        vec2 uv = (p + ${WORLD_HALF.toFixed(1)}) / ${WORLD_SIZE.toFixed(1)};
        float inside = step(abs(p.x), ${WORLD_HALF.toFixed(1)}) * step(abs(p.y), ${WORLD_HALF.toFixed(1)});
        float h = texture2D(shore, uv).r * ${(SHORE_MAX - SHORE_MIN).toFixed(1)} + ${SHORE_MIN.toFixed(1)};
        h = mix(-60.0, h, inside);
        float depth = max(0.0, -h);

        float detail = 1.0 - smoothstep(300.0, 3500.0, dist);
        vec2 g = waveGrad(p, time) * detail;
        float ripple = (wNoise(p * 0.09 + time * vec2(0.35, 0.2)) - 0.5) * 0.25 * (1.0 - smoothstep(80.0, 700.0, dist));
        vec3 n = normalize(vec3(-g.x * 1.3 + ripple, 1.0, -g.y * 1.3 + ripple));

        // Stylized depth bands: turquoise shallows → bright blue → deep.
        vec3 col = mix(shallow, mid, smoothstep(1.0, 9.0, depth));
        col = mix(col, deep, smoothstep(12.0, 34.0, depth));
        // Darker sea beyond the map boundary.
        vec2 outside = max(abs(p) - ${WORLD_HALF.toFixed(1)}, 0.0);
        float beyond = smoothstep(0.0, 1500.0, length(outside));
        col = mix(col, abyss, beyond * 0.85);

        float ndl = max(dot(n, sunDir), 0.0);
        vec3 lit = col * (mix(hemiGround, hemiSky, 0.85) + sunColor * (0.55 + 0.45 * ndl)) * RECIPROCAL_PI;

        float fres = pow(1.0 - max(dot(n, eye), 0.0), 4.0);
        vec3 refl = mix(skyHorizon, skyZenith, clamp(reflect(-eye, n).y * 2.0, 0.0, 1.0));
        lit = mix(lit, refl, fres * 0.6);

        // Cartoon sun glints.
        float spec = pow(max(dot(reflect(-sunDir, n), eye), 0.0), 220.0);
        lit += sunColor * 0.25 * smoothstep(0.25, 0.6, spec);

        // Shoreline foam: animated rings hugging the coast + a solid lip.
        float shoreBand = 1.0 - smoothstep(0.0, 4.5, depth);
        float rings = smoothstep(0.55, 0.75, sin(depth * 2.2 - time * 1.6 + wNoise(p * 0.02) * 4.0) * 0.5 + 0.5);
        float lip = 1.0 - smoothstep(0.15, 0.9, depth);
        float f = max(lip, rings * shoreBand * 0.8) * inside * step(0.01, h + 40.0);
        // Scattered whitecaps in open water.
        lit = mix(lit, foam * (hemiSky + sunColor) * RECIPROCAL_PI * 0.75, f);

        gl_FragColor = vec4(lit, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  })
  const geometry = new PlaneGeometry(120_000, 120_000, 1, 1)
  geometry.rotateX(-Math.PI / 2)
  const mesh = new Mesh(geometry, material)
  mesh.name = "World · ocean"
  mesh.frustumCulled = false

  let dirty = false, lastUpload = 0
  return {
    mesh,
    writeRows(z0: number, z1: number, rows: Uint8Array) {
      data.set(rows, z0 * SHORE_SIZE)
      dirty = true
      void z1
    },
    update(time: number) {
      material.uniforms.time.value = time % 3600
      if (dirty && time - lastUpload > 0.3) { shore.needsUpdate = true; dirty = false; lastUpload = time }
    },
    dispose() { geometry.dispose(); material.dispose(); shore.dispose() },
  }
}
