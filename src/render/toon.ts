// "Muted Tactical" aircraft materials: smooth-shaded matte paint (MeshStandardMaterial) with an optional
// cheap fake sky reflection (used mostly on glass) and a faint rim light.
// Also holds the paint remap applied to authored GLB colors.
import {
  Color,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
  type ColorRepresentation,
  type WebGLProgramParametersWithUniforms,
} from "three"

// ---------------------------------------------------------------------------------------------------------
// Paint remap (display/sRGB HSL space)

export type PaintKind = "hull" | "metal"

const _hsl = { h: 0, s: 0, l: 0 }

/**
 * Deterministic remap of an authored GLB color into muted military paint: desaturated olive/slate hulls,
 * neutral light grays, near-blacks lifted to gunmetal.
 */
export function paintColor(src: Color, kind: PaintKind = "hull"): Color {
  const out = new Color()
  src.getHSL(_hsl, SRGBColorSpace)
  let { h, s, l } = _hsl
  if (l < 0.18) {
    // Near-black -> gunmetal.
    h = 0.58
    s = 0.06
    l = 0.24 + l * 0.4
  } else if (s < 0.12) {
    // Neutral grays stay neutral and light-medium.
    h = 0.12
    s = Math.min(s, 0.04)
    l = Math.min(0.8, l)
  } else {
    // Muted: desaturate toward the olive/slate family.
    s = Math.min(0.35, s * 0.55)
    l = Math.min(0.72, l)
  }
  if (kind === "metal") {
    s = Math.min(s, 0.06)
    l = Math.min(l, 0.5)
  }
  return out.setHSL(h, s, l, SRGBColorSpace)
}

// ---------------------------------------------------------------------------------------------------------
// Materials

/** Fake environment used by the paint shader: sky above the horizon, ground below. */
export const PAINT_ENV = {
  sky: new Color("#a8cdf2"),
  horizon: new Color("#e4eef7"),
  ground: new Color("#6f7a5e"),
  rim: new Color("#dbe9ff"),
}

export interface PaintOptions {
  color: ColorRepresentation
  roughness?: number
  metalness?: number
  /** Strength of the fake sky reflection (0..1). */
  reflect?: number
  rim?: number
  vertexColors?: boolean
  /** Glossy tinted glass: transparent, strong fresnel reflection, no depth write. */
  glass?: boolean
  opacity?: number
}

const PAINT_PARS = /* glsl */ `
uniform vec3 paintSky;
uniform vec3 paintHorizon;
uniform vec3 paintGround;
uniform vec3 paintRimColor;
uniform float paintReflect;
uniform float paintRim;
`

const PAINT_OUTPUT = /* glsl */ `
  {
    vec3 pV = normalize( vViewPosition );
    float pNV = clamp( dot( normal, pV ), 0.0, 1.0 );
    float pFres = pow( 1.0 - pNV, 4.0 );
    // Reflection direction in world space for a simple sky/horizon/ground gradient.
    vec3 pR = inverseTransformDirection( reflect( -pV, normal ), viewMatrix );
    vec3 pEnv = pR.y > 0.0 ? mix( paintHorizon, paintSky, smoothstep( 0.0, 0.6, pR.y ) ) : mix( paintHorizon, paintGround, smoothstep( 0.0, 0.25, -pR.y ) );
    float pGloss = 1.0 - roughnessFactor;
    outgoingLight += pEnv * paintReflect * ( 0.04 + 0.96 * pFres ) * ( 0.35 + 0.65 * pGloss );
    outgoingLight += paintRimColor * ( smoothstep( 0.55, 1.0, 1.0 - pNV ) * paintRim );
    #ifdef PAINT_GLASS
      diffuseColor.a = clamp( diffuseColor.a + pFres * 0.5, 0.0, 0.95 );
    #endif
  }
  #include <opaque_fragment>
`

/** Smooth-shaded stylized paint. Works with skinning, shadows, hemisphere + directional lights. */
export function createPaintMaterial(opts: PaintOptions): MeshStandardMaterial {
  const glass = opts.glass === true
  const mat = new MeshStandardMaterial({
    color: new Color(opts.color),
    roughness: opts.roughness ?? (glass ? 0.08 : 0.58),
    metalness: opts.metalness ?? (glass ? 0.1 : 0.05),
    transparent: glass,
    opacity: opts.opacity ?? (glass ? 0.72 : 1),
    depthWrite: !glass,
    vertexColors: opts.vertexColors ?? false,
  })
  const uniforms = {
    paintSky: { value: PAINT_ENV.sky },
    paintHorizon: { value: PAINT_ENV.horizon },
    paintGround: { value: PAINT_ENV.ground },
    paintRimColor: { value: PAINT_ENV.rim },
    paintReflect: { value: opts.reflect ?? (glass ? 0.9 : 0.25) },
    paintRim: { value: opts.rim ?? (glass ? 0.05 : 0.12) },
  }
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + PAINT_PARS)
      .replace("#include <opaque_fragment>", PAINT_OUTPUT)
    if (glass) shader.fragmentShader = "#define PAINT_GLASS\n" + shader.fragmentShader
  }
  mat.customProgramCacheKey = () => (glass ? "wings-paint-glass" : "wings-paint")
  return mat
}

/** Unlit glowing material (afterburners, nav lights). `intensity` multiplies the color. */
export function createGlowMaterial(color: ColorRepresentation, intensity = 1): MeshBasicMaterial {
  const mat = new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity), toneMapped: false })
  mat.userData.baseColor = new Color(color)
  return mat
}
