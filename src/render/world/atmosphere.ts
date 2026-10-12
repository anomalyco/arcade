// Golden-hour atmosphere shared by world shaders and (optionally) any other material:
// directional haze (warm toward the sun, violet away) and a distance-faded ink line material.
import { Color, ShaderMaterial, UniformsLib, UniformsUtils, Vector3, type Material, type WebGLProgramParametersWithUniforms } from "three"
import { FOG_AWAY_FROM_SUN, FOG_TOWARD_SUN, INK_COLOR, INK_FADE, SUN_DIRECTION } from "./palette"

/** sRGB-encoded colour for uniforms that are mixed after colorspace conversion (fog stage). */
export function srgbColor(hex: string): Color {
  return new Color(hex).convertLinearToSRGB()
}

/** Shared uniforms (one instance for the whole scene). */
export const HAZE_UNIFORMS = {
  hazeToward: { value: srgbColor(FOG_TOWARD_SUN) },
  hazeAway: { value: srgbColor(FOG_AWAY_FROM_SUN) },
  hazeSunDir: { value: new Vector3(...SUN_DIRECTION).normalize() },
}

/** GLSL: sRGB haze colour seen along a world-space direction. Needs the HAZE_UNIFORMS. */
export const HAZE_GLSL = /* glsl */ `
uniform vec3 hazeToward;
uniform vec3 hazeAway;
uniform vec3 hazeSunDir;
vec3 goldenHaze(vec3 dir) {
  vec3 d = normalize(dir);
  float s = dot(d, hazeSunDir);
  float t = smoothstep(-0.75, 0.95, s);
  vec3 c = mix(hazeAway, hazeToward, t * t * (3.0 - 2.0 * t));
  // Bright bloom of air right around the low sun.
  c += vec3(1.0, 0.86, 0.62) * pow(max(s, 0.0), 10.0) * 0.18;
  return c;
}
`

/** Fog stage replacement: same range as THREE.Fog, colour from goldenHaze. */
const HAZE_FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  float hazeFactor = smoothstep(fogNear, fogFar, vFogDepth);
  hazeFactor = 1.0 - (1.0 - hazeFactor) * (1.0 - hazeFactor);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, goldenHaze(vHazeWorld - cameraPosition), hazeFactor);
#endif
`

/**
 * Patch a built-in three material (Lambert/Toon/Standard/Basic…) so its fog uses the golden
 * directional haze. Chains any existing onBeforeCompile. Requires scene.fog to be a THREE.Fog.
 */
export function applyGoldenHaze<T extends Material>(material: T): T {
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous.call(material, shader, renderer)
    Object.assign(shader.uniforms, HAZE_UNIFORMS)
    shader.vertexShader = shader.vertexShader
      .replace("#include <fog_pars_vertex>", "#include <fog_pars_vertex>\nvarying vec3 vHazeWorld;")
      .replace("#include <fog_vertex>", /* glsl */ `#include <fog_vertex>
        #ifdef USE_INSTANCING
          vHazeWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vHazeWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <fog_pars_fragment>", "#include <fog_pars_fragment>\nvarying vec3 vHazeWorld;\n" + HAZE_GLSL)
      .replace("#include <fog_fragment>", HAZE_FOG_FRAGMENT)
  }
  material.customProgramCacheKey = () => previousKey.call(material) + "|golden-haze-v1"
  material.needsUpdate = true
  return material
}

/** Distance-faded warm-dark ink for LineSegments (terrain creases, building edges). */
export function createInkMaterial(opacity = 0.6): ShaderMaterial {
  return new ShaderMaterial({
    name: "World · ink",
    transparent: true,
    depthWrite: false,
    fog: true,
    toneMapped: false,
    uniforms: {
      ...UniformsUtils.clone(UniformsLib.fog), ...HAZE_UNIFORMS,
      ink: { value: srgbColor(INK_COLOR) }, inkOpacity: { value: opacity }, inkFade: { value: [...INK_FADE] },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform vec2 inkFade;
      varying float vInkAlpha;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec3 toCam = cameraPosition - world.xyz;
        float dist = length(toCam);
        // Nudge toward the camera so lines win the depth test against their own faces.
        world.xyz += toCam / max(dist, 1e-3) * (0.35 + dist * 0.0025);
        vInkAlpha = 1.0 - smoothstep(inkFade.x, inkFade.y, dist);
        gl_Position = projectionMatrix * viewMatrix * world;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 ink;
      uniform float inkOpacity;
      varying float vInkAlpha;
      void main() {
        #include <logdepthbuf_fragment>
        if (vInkAlpha <= 0.0) discard;
        gl_FragColor = vec4(ink, inkOpacity * vInkAlpha);
      }
    `,
  })
}
