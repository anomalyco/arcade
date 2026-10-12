import {
  DataTexture, LinearFilter, Mesh, PlaneGeometry, RedFormat, ShaderMaterial, UniformsLib, UniformsUtils, UnsignedByteType, Vector3,
} from "three"
import { WORLD_HALF, WORLD_SIZE } from "../../sim/geography"
import { srgbColor } from "./atmosphere"
import { PALETTE, SKY_HORIZON, SKY_ZENITH, SUN_COLOR, SUN_DIRECTION } from "./palette"
import { SHORE_MAX, SHORE_MIN, SHORE_SIZE } from "./tile-gen"

/**
 * Bright stylised ocean: turquoise shallows → clear blue → deep blue (smooth depth gradient),
 * gentle analytic waves, soft fresnel toward the sky colour, a clean sun specular and crisp white
 * shore foam. Uses the standard scene fog. Two triangles.
 */
export function createWater() {
  const data = new Uint8Array(SHORE_SIZE * SHORE_SIZE) // 0 = deep until the worker fills it in
  const shore = new DataTexture(data, SHORE_SIZE, SHORE_SIZE, RedFormat, UnsignedByteType)
  shore.minFilter = LinearFilter
  shore.magFilter = LinearFilter
  shore.generateMipmaps = false
  shore.needsUpdate = true
  const c = (hex: string) => ({ value: srgbColor(hex) })
  const material = new ShaderMaterial({
    name: "World · ocean",
    fog: true,
    toneMapped: false,
    uniforms: {
      ...UniformsUtils.clone(UniformsLib.fog),
      shore: { value: shore }, time: { value: 0 },
      deep: c(PALETTE.deep), water: c(PALETTE.water), shallow: c(PALETTE.shallow), foam: c(PALETTE.foam),
      sky: c(SKY_HORIZON), zenith: c(SKY_ZENITH), sunCol: c(SUN_COLOR),
      sunDir: { value: new Vector3(...SUN_DIRECTION).normalize() },
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
      uniform vec3 deep, water, shallow, foam, sky, zenith, sunCol, sunDir;
      varying vec3 vWorld;
      vec2 waveGrad(vec2 p, float t) {
        vec2 g = vec2(0.0);
        vec4 dx = vec4(0.82, -0.41, 0.23, -0.88), dz = vec4(0.57, 0.91, -0.97, 0.47);
        vec4 fr = vec4(0.018, 0.031, 0.054, 0.097), am = vec4(0.9, 0.55, 0.3, 0.16), sp = vec4(0.8, 1.05, 1.4, 1.9);
        for (int i = 0; i < 4; i++) {
          vec2 d = vec2(dx[i], dz[i]);
          g += d * cos(dot(d, p) * fr[i] + t * sp[i]) * fr[i] * am[i];
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
        float depth = mix(60.0, max(0.0, -h), inside);

        // Gentle waves, fading with distance so the far sea stays calm and clean.
        float detail = 1.0 - smoothstep(400.0, 4000.0, dist);
        vec2 g = waveGrad(p, time) * detail;
        vec3 n = normalize(vec3(-g.x * 1.6, 1.0, -g.y * 1.6));

        // Smooth depth gradient.
        vec3 col = mix(shallow, water, smoothstep(0.5, 9.0, depth));
        col = mix(col, deep, smoothstep(10.0, 38.0, depth));
        // Soft diffuse response to the waves.
        col *= 0.92 + 0.12 * dot(n, sunDir);

        // Fresnel toward the sky.
        float fres = pow(1.0 - max(dot(n, eye), 0.0), 5.0);
        vec3 refl = reflect(-eye, n);
        vec3 skyCol = mix(sky, zenith, clamp(refl.y * 1.6, 0.0, 1.0));
        col = mix(col, skyCol, 0.06 + 0.5 * fres);

        // Clean sun specular.
        float spec = pow(max(dot(refl, sunDir), 0.0), 320.0);
        col += sunCol * spec * 1.2;
        col += sunCol * pow(max(dot(refl, sunDir), 0.0), 40.0) * 0.06;

        // Crisp white shore foam (with a thin second line that breathes).
        float w = fwidth(depth) + 1e-3;
        float foamLine = 1.0 - smoothstep(0.55 - w, 0.55 + w, depth);
        float pulse = 1.2 + 0.4 * sin(time * 0.8 + p.x * 0.01 + p.y * 0.012);
        float second = (1.0 - smoothstep(0.12, 0.12 + w * 2.0, abs(depth - pulse))) * (1.0 - smoothstep(0.0, 2.0, depth - 1.0));
        col = mix(col, foam, max(foamLine, second * 0.6) * inside);

        vec2 outside = max(abs(p) - ${WORLD_HALF.toFixed(1)}, 0.0);
        col *= 1.0 - 0.08 * smoothstep(0.0, 1500.0, length(outside));

        gl_FragColor = vec4(col, 1.0);
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
    writeRows(z0: number, rows: Uint8Array) {
      data.set(rows, z0 * SHORE_SIZE)
      dirty = true
    },
    update(time: number) {
      material.uniforms.time.value = time % 3600
      if (dirty && time - lastUpload > 0.3) { shore.needsUpdate = true; dirty = false; lastUpload = time }
    },
    dispose() { geometry.dispose(); material.dispose(); shore.dispose() },
  }
}
