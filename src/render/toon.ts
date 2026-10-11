// Stylized "cartoon" shading for aircraft: banded diffuse, crisp specular blob, soft rim, inverted-hull outlines.
import {
  BackSide,
  Color,
  DataTexture,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  UnsignedByteType,
  type ColorRepresentation,
  type WebGLProgramParametersWithUniforms,
} from "three"

let gradientMap: DataTexture | null = null

/**
 * Shared gradient ramp for MeshToonMaterial. The toon shader samples it at dot(N, L) * 0.5 + 0.5,
 * so the first half of the ramp is the shadow side and the bands sit on the lit half.
 */
export function toonGradientMap(): DataTexture {
  if (gradientMap) return gradientMap
  const n = 32
  const data = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n
    let v: number
    if (x < 0.47) v = 0.2
    else if (x < 0.6) v = 0.5
    else if (x < 0.8) v = 0.82
    else v = 1
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

export interface ToonOptions {
  color: ColorRepresentation
  /** 0..1, glTF roughness. Drives highlight size/strength. */
  roughness?: number
  metalness?: number
  opacity?: number
  transparent?: boolean
  /** Glass: strong highlight, bright fresnel edge, no depth write. */
  glass?: boolean
}

const TOON_LIGHTS = /* glsl */ `
varying vec3 vViewPosition;
uniform float toonSpecular;
uniform float toonShininess;
struct ToonMaterial { vec3 diffuseColor; };
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
  vec3 h = normalize( directLight.direction + geometryViewDir );
  float nh = max( dot( geometryNormal, h ), 0.0 );
  float s = pow( nh, toonShininess );
  float fw = fwidth( s ) + 1e-4;
  s = smoothstep( 0.5 - fw, 0.5 + fw, s );
  reflectedLight.directSpecular += directLight.color * ( s * toonSpecular );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct RE_Direct_Toon
#define RE_IndirectDiffuse RE_IndirectDiffuse_Toon
`

const TOON_OUTPUT = /* glsl */ `
  vec3 toonView = normalize( vViewPosition );
  float toonFres = 1.0 - clamp( dot( normal, toonView ), 0.0, 1.0 );
  float toonRimMask = smoothstep( 0.62, 0.7, toonFres );
  vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + totalEmissiveRadiance;
  outgoingLight += toonRim * toonRimMask * ( diffuseColor.rgb * 0.5 + 0.1 );
  #ifdef TOON_GLASS
    diffuseColor.a = mix( diffuseColor.a, 1.0, toonFres * toonFres * 0.6 );
    diffuseColor.a = max( diffuseColor.a, clamp( length( reflectedLight.directSpecular ) * 0.6, 0.0, 0.8 ) );
  #endif
`

/** Banded toon material with a crisp highlight and a soft rim. Works with skinning, hemisphere + directional lights. */
export function createToonMaterial(opts: ToonOptions): MeshToonMaterial {
  const roughness = opts.roughness ?? 0.55
  const metal = opts.metalness ?? 0
  const glass = opts.glass === true
  // Lift near-black albedos slightly so banding and highlights still read on dark paint.
  const color = new Color(opts.color)
  const floor = glass ? 0 : 0.03
  color.r = Math.max(color.r, floor * 0.9)
  color.g = Math.max(color.g, floor)
  color.b = Math.max(color.b, floor * 1.25)
  const mat = new MeshToonMaterial({
    color,
    gradientMap: toonGradientMap(),
    transparent: opts.transparent ?? glass,
    opacity: opts.opacity ?? 1,
    depthWrite: !glass,
  })
  const spec = glass ? 0.5 : Math.max(0, (1 - roughness) * 0.22 + metal * 0.12)
  const shininess = glass ? 160 : 8 + (1 - roughness) * 50
  const rim = glass ? 0.35 : 0.22
  mat.userData.toon = { spec, shininess, rim }
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.toonSpecular = { value: spec }
    shader.uniforms.toonShininess = { value: shininess }
    shader.uniforms.toonRim = { value: rim }
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <lights_toon_pars_fragment>", TOON_LIGHTS + "\nuniform float toonRim;\n")
      .replace(
        "vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;",
        TOON_OUTPUT,
      )
    if (glass) shader.fragmentShader = "#define TOON_GLASS\n" + shader.fragmentShader
  }
  mat.customProgramCacheKey = () => (glass ? "wings-toon-glass" : "wings-toon")
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
