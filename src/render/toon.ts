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
const CHARCOAL_HUE = 0.6
const _hsl = { h: 0, s: 0, l: 0 }

/**
 * Deterministic remap of an authored GLB color into the soft world palette: hulls get lighter and less
 * saturated with a slight warm cast, near-blacks become soft blue-charcoal, glass becomes soft blue-gray.
 */
export function pastelize(src: Color, kind: PastelKind = "hull"): Color {
  const out = new Color()
  if (kind === "glass") return out.set("#9db4c6")
  src.getHSL(_hsl, SRGBColorSpace)
  let { h, s, l } = _hsl
  if (kind === "livery") {
    s = Math.min(s, 0.62) * 0.85
    l = Math.min(0.72, l + (1 - l) * 0.22)
  } else if (l < 0.2) {
    // Black / dark metal -> soft charcoal (keeps a hint of the original hue).
    h = CHARCOAL_HUE
    s = 0.1
    l = 0.3 + l * 0.45
  } else {
    s *= 0.72
    l = Math.min(0.9, l + (1 - l) * 0.15)
  }
  out.setHSL(h, s, l, SRGBColorSpace)
  return out.lerp(WARM, kind === "livery" ? 0.04 : 0.08)
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
  float toonRimMask = smoothstep( 0.6, 0.85, toonFres );
  vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
  outgoingLight += toonRimColor * ( toonRimMask * toonRim );
  #ifdef TOON_GLASS
    diffuseColor.a = mix( diffuseColor.a, 0.9, toonFres * toonFres * 0.5 );
  #endif
`

/** Soft 2-band toon material, no specular, faint cool rim. Works with skinning, hemisphere + directional lights. */
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
  const rim = glass ? 0.12 : 0.06
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.toonRim = { value: rim }
    shader.uniforms.toonRimColor = { value: new Color("#c9dcf2") }
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <lights_toon_pars_fragment>", "#include <lights_toon_pars_fragment>\nuniform float toonRim;\nuniform vec3 toonRimColor;\n")
      .replace(
        "vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;",
        TOON_OUTPUT,
      )
    if (glass) shader.fragmentShader = "#define TOON_GLASS\n" + shader.fragmentShader
  }
  mat.customProgramCacheKey = () => (glass ? "wings-toon2-glass" : "wings-toon2")
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
  /** Outline width in meters per meter of view depth (keeps a roughly constant screen width). */
  perDepth?: number
  min?: number
  max?: number
}

/**
 * Inverted-hull outline: back faces pushed out along (smoothed) normals. Width grows with view depth so
 * it stays a similar thickness on screen, clamped to [min, max] meters.
 */
export function createOutlineMaterial(opts: OutlineOptions = {}): MeshBasicMaterial {
  const mat = new MeshBasicMaterial({ color: new Color(opts.color ?? "#161a22"), side: BackSide })
  const perDepth = opts.perDepth ?? 0.0013
  const min = opts.min ?? 0.022
  const max = opts.max ?? 0.2
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.outlinePerDepth = { value: perDepth }
    shader.uniforms.outlineMin = { value: min }
    shader.uniforms.outlineMax = { value: max }
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float outlinePerDepth;\nuniform float outlineMin;\nuniform float outlineMax;",
      )
      .replace(
        "#include <skinning_vertex>",
        `#include <skinning_vertex>
        {
          vec4 olView = modelViewMatrix * vec4( transformed, 1.0 );
          float olW = clamp( -olView.z * outlinePerDepth, outlineMin, outlineMax );
          #ifdef USE_SKINNING
            vec3 olN = objectNormal;
          #else
            vec3 olN = normal;
          #endif
          transformed += normalize( olN ) * olW;
        }`,
      )
  }
  mat.customProgramCacheKey = () => "wings-outline"
  return mat
}
