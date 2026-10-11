import { Color, ShaderMaterial, UniformsLib, UniformsUtils, Vector3 } from "three"
import { NOISE_GLSL, TOON_GLSL } from "./glsl"
import { PALETTE, SUN_DIRECTION } from "./settings"

export interface LightingUniforms {
  sunDir: { value: Vector3 }
  sunColor: { value: Color }
  hemiSky: { value: Color }
  hemiGround: { value: Color }
}

export function createLightingUniforms(sunIntensity: number, hemiIntensity: number): LightingUniforms {
  return {
    sunDir: { value: SUN_DIRECTION.clone() },
    sunColor: { value: new Color(PALETTE.sunLight).multiplyScalar(sunIntensity) },
    hemiSky: { value: new Color(PALETTE.hemiSky).multiplyScalar(hemiIntensity) },
    hemiGround: { value: new Color(PALETTE.hemiGround).multiplyScalar(hemiIntensity) },
  }
}

export const LIGHTING_GLSL = /* glsl */ `
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 hemiSky;
uniform vec3 hemiGround;
${TOON_GLSL}
vec3 worldLight(vec3 n) {
  vec3 hemi = mix(hemiGround, hemiSky, n.y * 0.5 + 0.5);
  return (hemi + sunColor * toonDiffuse(dot(n, sunDir))) * RECIPROCAL_PI;
}
`

export function createTerrainMaterial(lighting: LightingUniforms): ShaderMaterial {
  const c = (hex: string) => ({ value: new Color(hex) })
  return new ShaderMaterial({
    name: "World · terrain",
    toneMapped: false,
    fog: true,
    lights: false,
    uniforms: {
      ...UniformsUtils.clone(UniformsLib.fog), ...lighting,
      sand: c(PALETTE.sand), lush: c(PALETTE.lush), meadow: c(PALETTE.meadow), forest: c(PALETTE.forest),
      darkForest: c(PALETTE.darkForest), rock: c(PALETTE.rock), darkRock: c(PALETTE.darkRock), snow: c(PALETTE.snow),
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      attribute float forest;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vForest;
      void main() {
        vForest = forest;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(normal);
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
      uniform vec3 sand, lush, meadow, forest, darkForest, rock, darkRock, snow;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vForest;
      ${NOISE_GLSL}
      ${LIGHTING_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vNormal);
        float h = vWorld.y;
        vec2 p = vWorld.xz;
        float n1 = wNoise(p * 0.0021);
        float n2 = wNoise(p * 0.011 + 17.0);
        float n3 = wNoise(p * 0.06 - 5.0);
        float slope = 1.0 - n.y;

        vec3 grass = mix(meadow, lush, smoothstep(0.25, 0.7, n1));
        float forestAmt = smoothstep(0.35, 0.6, vForest + (n2 - 0.5) * 0.25);
        vec3 woods = mix(forest, darkForest, smoothstep(0.3, 0.8, n2));
        vec3 col = mix(grass, woods, forestAmt);
        // Close-up grain so big flats don't read as plastic.
        float dist = length(cameraPosition - vWorld);
        float grain = wNoise(p * 0.35) * 0.6 + wNoise(p * 1.3) * 0.4;
        col *= 1.0 + (grain - 0.5) * 0.14 * (1.0 - smoothstep(150.0, 900.0, dist));
        float sandAmt = 1.0 - smoothstep(2.4, 4.0, h + (n2 - 0.5) * 2.4);
        col = mix(col, sand, sandAmt);

        float rockAmt = smoothstep(0.34, 0.44, slope + (n2 - 0.5) * 0.14);
        rockAmt = max(rockAmt, smoothstep(700.0, 790.0, h + (n1 - 0.5) * 160.0) * (0.55 + 0.45 * smoothstep(0.08, 0.25, slope)));
        vec3 rockCol = mix(darkRock, rock, 0.3 + 0.5 * smoothstep(0.25, 0.75, n2) + 0.15 * n3);
        rockCol *= 0.9 + 0.12 * sin(h * 0.11 + n2 * 6.0);
        col = mix(col, rockCol, rockAmt * (1.0 - sandAmt));

        float snowAmt = smoothstep(1010.0, 1030.0, h + (n2 - 0.5) * 70.0) * (1.0 - smoothstep(0.45, 0.65, slope));
        col = mix(col, snow, snowAmt);

        col *= 1.0 - 0.2 * (1.0 - smoothstep(0.2, 1.4, h));
        col *= 0.92 + 0.12 * n3;

        gl_FragColor = vec4(col * worldLight(n), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  })
}
