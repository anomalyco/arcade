import {
  Color, DataTexture, LinearFilter, Mesh, PlaneGeometry, RedFormat, ShaderMaterial, UniformsLib, UniformsUtils, UnsignedByteType,
} from "three"
import { WORLD_HALF, WORLD_SIZE } from "../../sim/geography"
import { PALETTE } from "./palette"
import { SHORE_MAX, SHORE_MIN, SHORE_SIZE } from "./tile-gen"

/**
 * Low-poly stylised sea: three flat depth bands (turquoise shallows → water → deep) with a crisp
 * foam line, a gentle faceted shimmer near the camera, and the scene fog. Two triangles.
 */
export function createWater() {
  const data = new Uint8Array(SHORE_SIZE * SHORE_SIZE) // 0 = deep until the worker fills it in
  const shore = new DataTexture(data, SHORE_SIZE, SHORE_SIZE, RedFormat, UnsignedByteType)
  shore.minFilter = LinearFilter
  shore.magFilter = LinearFilter
  shore.generateMipmaps = false
  shore.needsUpdate = true
  const c = (hex: string) => ({ value: new Color(hex) })
  const material = new ShaderMaterial({
    name: "World · ocean",
    fog: true,
    toneMapped: false,
    uniforms: {
      ...UniformsUtils.clone(UniformsLib.fog),
      shore: { value: shore }, time: { value: 0 },
      deep: c(PALETTE.deep), water: c(PALETTE.water), shallow: c(PALETTE.shallow), foam: c(PALETTE.foam),
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
      uniform vec3 deep, water, shallow, foam;
      varying vec3 vWorld;
      float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float band(float x, float edge) { float w = fwidth(x) * 0.75 + 1e-4; return smoothstep(edge - w, edge + w, x); }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = vWorld.xz;
        float dist = length(cameraPosition - vWorld);
        vec2 uv = (p + ${WORLD_HALF.toFixed(1)}) / ${WORLD_SIZE.toFixed(1)};
        float inside = step(abs(p.x), ${WORLD_HALF.toFixed(1)}) * step(abs(p.y), ${WORLD_HALF.toFixed(1)});
        float h = texture2D(shore, uv).r * ${(SHORE_MAX - SHORE_MIN).toFixed(1)} + ${SHORE_MIN.toFixed(1)};
        float depth = mix(60.0, max(0.0, -h), inside);

        // Hard depth bands (anti-aliased only across one pixel).
        vec3 col = mix(shallow, water, band(depth, 5.5));
        col = mix(col, deep, band(depth, 22.0));
        // Foam line hugging the coast; breathes slowly.
        float foamEdge = 0.9 + 0.35 * sin(time * 0.9 + p.x * 0.004 + p.y * 0.003);
        col = mix(col, foam, 1.0 - band(depth, foamEdge));
        // Slightly darker sea beyond the map boundary.
        vec2 outside = max(abs(p) - ${WORLD_HALF.toFixed(1)}, 0.0);
        col *= 1.0 - 0.12 * smoothstep(0.0, 1200.0, length(outside));

        float nearFade = 1.0 - smoothstep(600.0, 1500.0, dist);
        // Faceted shimmer: a slowly breathing triangular lattice, fading out with distance.
        vec2 q = p / 60.0;
        q.x += q.y * 0.5;
        vec2 cell = floor(q);
        vec2 f = fract(q);
        float tri = step(1.0, f.x + f.y);
        float r = h21(cell * 2.0 + tri);
        float facet = sin(time * (0.5 + r * 0.6) + r * 6.283) * 0.028;
        col *= 1.0 + facet * (1.0 - smoothstep(300.0, 2500.0, dist));

        // Open-sea swell: faceted bands travelling across the lattice (per-triangle, so no gradients).
        vec2 centre = (cell + (tri > 0.5 ? vec2(0.6667) : vec2(0.3333))) * 60.0;
        float swell = sin(dot(centre, vec2(0.0042, 0.0029)) - time * 0.55 + r * 0.6);
        float swell2 = sin(dot(centre, vec2(-0.0021, 0.0051)) - time * 0.37);
        float bandsLit = step(0.55, swell * 0.7 + swell2 * 0.3);
        float openSea = smoothstep(6.0, 20.0, depth);
        col *= 1.0 + (bandsLit * 0.07 - 0.02) * nearFade * openSea;

        // Sparse whitecaps: small triangles that flare up briefly on swell crests.
        vec2 wq = p / 14.0;
        wq.x += wq.y * 0.5;
        vec2 wc = floor(wq);
        float wt = step(1.0, fract(wq).x + fract(wq).y);
        float wr = h21(wc * 2.0 + wt + 17.0);
        float pulse = smoothstep(0.75, 1.0, sin(time * (0.6 + wr) + wr * 40.0));
        float cap = step(wr, 0.006) * pulse * bandsLit;
        col = mix(col, foam, cap * 0.6 * nearFade * openSea);

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
        #ifdef USE_FOG
          // Melt the far sea fully into the horizon colour so there is no seam against the sky.
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(fogFar * 0.6, fogFar * 0.97, vFogDepth));
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
