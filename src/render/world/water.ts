import {
  DataTexture, LinearFilter, Mesh, PlaneGeometry, RedFormat, ShaderMaterial, UniformsLib, UniformsUtils, UnsignedByteType, Vector3,
} from "three"
import { WORLD_HALF, WORLD_SIZE } from "../../sim/geography"
import { HAZE_GLSL, HAZE_UNIFORMS, srgbColor } from "./atmosphere"
import { PALETTE, SUN_COLOR, SUN_DIRECTION } from "./palette"
import { SHORE_MAX, SHORE_MIN, SHORE_SIZE } from "./tile-gen"

/**
 * Golden-hour stylised sea (sRGB): deep teal-indigo, turquoise shallows turning gold at the beach,
 * a soft glowing foam ring, a faceted golden glitter path toward the low sun, faint swells and rare
 * whitecaps near the camera, and the directional haze. Two triangles.
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
      ...UniformsUtils.clone(UniformsLib.fog), ...HAZE_UNIFORMS,
      shore: { value: shore }, time: { value: 0 },
      deep: c(PALETTE.deep), water: c(PALETTE.water), shallow: c(PALETTE.shallow), gold: c(PALETTE.goldShallow),
      foam: c(PALETTE.foam), glitter: c(PALETTE.glitter), sunCol: c(SUN_COLOR),
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
      uniform vec3 deep, water, shallow, gold, foam, glitter, sunCol, sunDir;
      varying vec3 vWorld;
      ${HAZE_GLSL}
      float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float band(float x, float edge) { float w = fwidth(x) * 0.75 + 1e-4; return smoothstep(edge - w, edge + w, x); }
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

        // Depth bands: gold at the beach → turquoise → teal → deep teal-indigo.
        vec3 col = mix(gold, shallow, band(depth, 1.6));
        col = mix(col, water, band(depth, 6.0));
        col = mix(col, deep, band(depth, 20.0));
        // Soft glowing foam ring: crisp core plus a faint halo.
        float foamEdge = 0.75 + 0.3 * sin(time * 0.9 + p.x * 0.004 + p.y * 0.003);
        col = mix(col, foam, (1.0 - band(depth, foamEdge)) * 0.95);
        col = mix(col, foam, (1.0 - smoothstep(foamEdge, foamEdge + 1.6, depth)) * 0.22 * step(foamEdge, depth));
        vec2 outside = max(abs(p) - ${WORLD_HALF.toFixed(1)}, 0.0);
        col *= 1.0 - 0.15 * smoothstep(0.0, 1500.0, length(outside));

        // Faceted lattice (60 m triangles) drives per-facet normals for shimmer and glitter.
        vec2 q = p / 60.0;
        q.x += q.y * 0.5;
        vec2 cell = floor(q);
        vec2 f = fract(q);
        float tri = step(1.0, f.x + f.y);
        float r = h21(cell * 2.0 + tri);
        float r2 = h21(cell * 2.0 + tri + 7.3);
        float wob = time * (0.4 + r * 0.5) + r * 6.283;
        vec3 n = normalize(vec3(sin(wob) * 0.09 + (r2 - 0.5) * 0.12, 1.0, cos(wob * 0.8) * 0.09 + (r - 0.5) * 0.12));
        float nearFade = 1.0 - smoothstep(600.0, 1500.0, dist);
        float openSea = smoothstep(6.0, 20.0, depth);

        // Gentle faceted swells (per triangle) near the camera.
        vec2 centre = (cell + (tri > 0.5 ? vec2(0.6667) : vec2(0.3333))) * 60.0;
        float swell = sin(dot(centre, vec2(0.0042, 0.0029)) - time * 0.55 + r * 0.6) * 0.7
                    + sin(dot(centre, vec2(-0.0021, 0.0051)) - time * 0.37) * 0.3;
        float bandsLit = step(0.55, swell);
        col *= 1.0 + (bandsLit * 0.05 - 0.015) * nearFade * openSea + (r - 0.5) * 0.03 * nearFade;

        // Warm sheen in the sun's direction, then a faceted golden glitter path.
        vec3 refl = reflect(-eye, n);
        float sAlign = max(dot(refl, sunDir), 0.0);
        float broad = pow(max(dot(reflect(-eye, vec3(0.0, 1.0, 0.0)), sunDir), 0.0), 6.0);
        col = mix(col, sunCol, broad * 0.42);
        // Glitter: small (12 m) facets with their own normals, only along the sun path.
        vec2 gq = p / 8.0;
        gq.x += gq.y * 0.5;
        vec2 gc = floor(gq);
        float gt = step(1.0, fract(gq).x + fract(gq).y);
        float gr = h21(gc * 2.0 + gt + 3.1), gr2 = h21(gc * 2.0 + gt + 9.7);
        float gw = time * (0.8 + gr) + gr * 6.283;
        vec3 gn = normalize(vec3(sin(gw) * 0.12 + (gr2 - 0.5) * 0.18, 1.0, cos(gw * 0.9) * 0.12 + (gr - 0.5) * 0.18));
        float gAlign = max(dot(reflect(-eye, gn), sunDir), 0.0);
        float spark = smoothstep(0.988, 0.997, gAlign) * broad;
        col = mix(col, glitter, min(1.0, spark * 1.2) * openSea * (1.0 - smoothstep(2500.0, 7000.0, dist) * 0.6));

        // Very sparse whitecaps on swell crests.
        vec2 wq = p / 14.0;
        wq.x += wq.y * 0.5;
        vec2 wc = floor(wq);
        float wt = step(1.0, fract(wq).x + fract(wq).y);
        float wr = h21(wc * 2.0 + wt + 17.0);
        float pulse = smoothstep(0.75, 1.0, sin(time * (0.6 + wr) + wr * 40.0));
        col = mix(col, foam, step(wr, 0.004) * pulse * bandsLit * 0.5 * nearFade * openSea);

        gl_FragColor = vec4(col, 1.0);
        #ifdef USE_FOG
          float hazeFactor = smoothstep(fogNear, fogFar, vFogDepth);
          hazeFactor = 1.0 - (1.0 - hazeFactor) * (1.0 - hazeFactor);
          vec3 hz = goldenHaze(-eye);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, hz, hazeFactor);
          // Melt the far sea fully into the horizon colour so there is no seam against the sky.
          gl_FragColor.rgb = mix(gl_FragColor.rgb, hz, smoothstep(fogFar * 0.6, fogFar * 0.97, vFogDepth));
        #endif
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
