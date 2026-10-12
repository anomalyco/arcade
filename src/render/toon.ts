// Soft "toy diorama" shading for aircraft, matched to the ISLANDERS-style world (flat-shaded Lambert,
// no tone mapping): flat facets, a gentle 2-band diffuse with a lifted shadow, no specular, faint cool rim.
// Also holds the pastel palette remap applied to GLB material colors.
import {
  BackSide,
  Color,
  DataTexture,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type ColorRepresentation,
  type WebGLProgramParametersWithUniforms,
} from "three"
import { INK_COLOR } from "./world/palette"

let gradientMap: DataTexture | null = null

/**
 * Shared gradient ramp for MeshToonMaterial (sampled at dot(N, L) * 0.5 + 0.5). Two soft bands plus a
 * narrow mid step; combined with the hemisphere fill the shadow side lands at ~0.55 of the lit side.
 */
export function toonGradientMap(): DataTexture {
  if (gradientMap) return gradientMap
  const n = 32
  const data = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n
    const v = x < 0.5 ? 0.12 : x < 0.56 ? 0.6 : 1
    data[i] = Math.round(v * 255)
  }
  const tex = new DataTexture(data, n, 1, RedFormat, UnsignedByteType)
  tex.minFilter = NearestFilter
  tex.magFilter = NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  gradientMap = tex
  return tex
}

// ---------------------------------------------------------------------------------------------------------
// Pastel palette remap (display/sRGB HSL space)

export type PastelKind = "hull" | "glass" | "livery"

const WARM = new Color("#f1ebdf") // world offWhite
const _hsl = { h: 0, s: 0, l: 0 }

/**
 * Deterministic remap of an authored GLB color into the soft world palette: hulls get lighter and less
 * saturated with a slight warm cast, near-blacks become soft blue-charcoal, glass becomes soft blue-gray.
 */
export function pastelize(src: Color, kind: PastelKind = "hull"): Color {
  const out = new Color()
  if (kind === "glass") return out.set("#a9b1d8")
  src.getHSL(_hsl, SRGBColorSpace)
  let { h, s, l } = _hsl
  if (kind === "livery") {
    s = Math.min(0.72, s * 0.95)
    l = Math.min(0.68, l + (1 - l) * 0.14)
    return out.setHSL(h, s, l, SRGBColorSpace)
  }
  if (l < 0.2) {
    // Black / dark metal -> warm plum graphite.
    h = 0.84
    s = 0.13
    l = 0.28 + l * 0.45
  } else if (s < 0.14 && l > 0.7) {
    // Light gray bellies / helmets -> soft cream.
    h = 0.11
    s = 0.38
    l = Math.min(0.9, l + 0.02)
  } else if (s < 0.14) {
    // Mid metals -> warm gray.
    h = 0.07
    s = 0.07
    l = l + (1 - l) * 0.08
  } else {
    s = Math.min(0.6, s * 0.82)
    l = Math.min(0.88, l + (1 - l) * 0.1)
  }
  out.setHSL(h, s, l, SRGBColorSpace)
  return out.lerp(WARM, 0.05)
}

export interface ToonOptions {
  color: ColorRepresentation
  opacity?: number
  transparent?: boolean
  /** Glass: translucent with a soft fresnel edge, no depth write, smooth normals. */
  glass?: boolean
  /** Faceted normals like the world terrain/props (default true for opaque). */
  flat?: boolean
  /** Multiply by the geometry's per-vertex "color" attribute (baked paint). */
  vertexColors?: boolean
}

const TOON_OUTPUT = /* glsl */ `
  vec3 toonView = normalize( vViewPosition );
  float toonFres = 1.0 - clamp( dot( normal, toonView ), 0.0, 1.0 );
  float toonSunFacing = 1.0;
  float toonSunSide = 0.5;
  #if NUM_DIR_LIGHTS > 0
    float toonNL = dot( normal, directionalLights[ 0 ].direction );
    toonSunFacing = smoothstep( -0.05, 0.2, toonNL );
    toonSunSide = clamp( toonNL * 0.5 + 0.5, 0.0, 1.0 );
  #endif
  // Golden hour: the sky fill on the shadow side is pushed toward lilac; the sun side keeps it neutral.
  vec3 toonIndirect = reflectedLight.indirectDiffuse * mix( toonShadowTint, vec3( 1.0 ), toonSunFacing * 0.6 );
  vec3 outgoingLight = reflectedLight.directDiffuse + toonIndirect + totalEmissiveRadiance;
  // Soft warm rim on silhouettes that face the sun.
  float toonRimMask = smoothstep( 0.55, 0.9, toonFres ) * toonSunSide * toonSunSide;
  outgoingLight += toonRimColor * ( toonRimMask * toonRim );
  #ifdef TOON_GLASS
    diffuseColor.a = mix( diffuseColor.a, 0.9, toonFres * toonFres * 0.5 );
  #endif
`

/** Golden-hour light tuning shared by aircraft materials (overridable once the world exports lighting). */
export const GOLDEN = {
  /** Multiplier applied to sky fill on shadow-facing facets (lilac). */
  shadowTint: new Color(0.9, 0.85, 1.15),
  rimColor: new Color("#ffc58a"),
  ink: new Color(INK_COLOR),
  shadowBlob: new Color("#5b4a86"),
}

/** Faceted 2-band toon: lilac shadow side, warm sun-side rim, no specular. Works with skinning. */
export function createToonMaterial(opts: ToonOptions): MeshToonMaterial {
  const glass = opts.glass === true
  const mat = new MeshToonMaterial({
    color: new Color(opts.color),
    gradientMap: toonGradientMap(),
    transparent: opts.transparent ?? glass,
    opacity: opts.opacity ?? 1,
    depthWrite: !glass,
    vertexColors: opts.vertexColors ?? false,
    toneMapped: false,
  })
  // MeshToonMaterial has no typed flatShading, but the renderer honors the flag on any material.
  ;(mat as unknown as { flatShading: boolean }).flatShading = opts.flat ?? !glass
  const rim = glass ? 0.3 : 0.38
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.toonRim = { value: rim }
    shader.uniforms.toonRimColor = { value: GOLDEN.rimColor }
    shader.uniforms.toonShadowTint = { value: GOLDEN.shadowTint }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <lights_toon_pars_fragment>",
        "#include <lights_toon_pars_fragment>\nuniform float toonRim;\nuniform vec3 toonRimColor;\nuniform vec3 toonShadowTint;\n",
      )
      .replace(
        "vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;",
        TOON_OUTPUT,
      )
    if (glass) shader.fragmentShader = "#define TOON_GLASS\n" + shader.fragmentShader
  }
  mat.customProgramCacheKey = () => (glass ? "wings-golden-glass" : "wings-golden")
  return mat
}

/** Unlit glowing material (afterburners, nav lights). `intensity` multiplies the color. */
export function createGlowMaterial(color: ColorRepresentation, intensity = 1): MeshBasicMaterial {
  const mat = new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity), toneMapped: false })
  mat.userData.baseColor = new Color(color)
  return mat
}

export interface OutlineOptions {
  color?: ColorRepresentation
  /** Outline width in meters per meter of view depth (≈ constant screen width). */
  perDepth?: number
  /** View depth (m) where the ink starts thinning, and where it is gone. */
  fadeStart?: number
  fadeEnd?: number
}

/**
 * Fine ink line (inverted hull): back faces pushed out along smoothed normals by a width proportional
 * to view depth (≈1–1.5 px), thinning to nothing with distance.
 */
export function createOutlineMaterial(opts: OutlineOptions = {}): MeshBasicMaterial {
  const mat = new MeshBasicMaterial({ color: new Color(opts.color ?? GOLDEN.ink), side: BackSide, toneMapped: false })
  const uniforms = {
    outlinePerDepth: { value: opts.perDepth ?? 0.0021 },
    outlineFadeStart: { value: opts.fadeStart ?? 220 },
    outlineFadeEnd: { value: opts.fadeEnd ?? 900 },
  }
  mat.userData.uniforms = uniforms
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float outlinePerDepth;\nuniform float outlineFadeStart;\nuniform float outlineFadeEnd;",
      )
      .replace(
        "#include <skinning_vertex>",
        `#include <skinning_vertex>
        {
          vec4 olView = modelViewMatrix * vec4( transformed, 1.0 );
          float olDepth = -olView.z;
          float olW = olDepth * outlinePerDepth * ( 1.0 - smoothstep( outlineFadeStart, outlineFadeEnd, olDepth ) );
          // Undo the object's own scale so distance-scaled aircraft keep the same line width.
          olW /= length( modelMatrix[ 0 ].xyz );
          #ifdef USE_SKINNING
            vec3 olN = objectNormal;
          #else
            vec3 olN = normal;
          #endif
          transformed += normalize( olN ) * olW;
        }`,
      )
  }
  mat.customProgramCacheKey = () => "wings-ink"
  return mat
}
