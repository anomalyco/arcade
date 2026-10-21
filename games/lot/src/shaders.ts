import type { SceneHooks } from "@arcade/kit/gpu/shaders"
import { withPhysicalLights } from "@arcade/kit/gpu/lights/physical"
import { fogParamsWgsl, fogSceneWgsl, fogScatterVolume } from "@arcade/kit/gpu/fog-scatter"
import { reflectiveSurfaceReturn } from "@arcade/kit/gpu/reflections/surface"
import { ssrVolume } from "@arcade/kit/gpu/reflections/ssr"
import { WET_ASPHALT, wetMaterialWgsl, wetSurfaceWgsl } from "@arcade/kit/gpu/reflections/wet"
import { interiorWindowHooks, thinGlassHooks } from "@arcade/kit/gpu/materials/glass"
import { ROOM_ATLAS } from "@arcade/kit/gpu/materials/rooms"
import { contactShadowVolume } from "@arcade/kit/gpu/contact-shadows"
import { interiorWgsl } from "./interior/shader"
import { LENS_MAT } from "./lamps"

/** The CI smoke (`?smoke`, software GPU) keeps the street lamps at Today, so its shaders leave the street path out. */
const STREET_SHADERS = !new URLSearchParams(globalThis.location?.search ?? "").has("smoke")
const nightUniform = `struct Night { fog: vec4f, look: vec4f, torch: vec4f, wet: vec4f, interior: vec4f, forest: vec4f, glassA: vec4f, glassB: vec4f, glassC: vec4f, contactA: vec4f, contactB: vec4f, streetA: vec4f, streetB: vec4f, streetC: vec4f }
@group(0) @binding(13) var<uniform> N: Night;`
/** Floats in the Night uniform (`main.ts` packs it). */
export const NIGHT_FLOATS = 56
// Wet reflections follow the materials: every physical surface tags its roughness in the HDR alpha, and the asphalt's
// wet/puddle term (kit reflections/wet) sets that roughness, so puddles mirror and the film between them smears.
/** The lot's fog volume; `atmosphere` compiles the fog bank and cloud deck in, `street` the lens airlight (the CI smoke leaves both out). */
export const fogVolume = (atmosphere: boolean, street = STREET_SHADERS) => fogScatterVolume({ declarations: nightUniform, atmosphere, street, surface: true,
  wetSettings: "select(N.wet,vec4f(0.0,0.0,1.0,0.0),world.x>-55.0 && world.x<35.0 && world.z>-3.2 && world.z<22.0)", wetMaterial: WET_ASPHALT,
  reflectionSamples:4, reflectionCap:"N.look.z",
})
export const reflectionVolume = ssrVolume({ wetMaterial: WET_ASPHALT })

const nightHooks: SceneHooks = {
  lampGrid: false,
  // Glow decals (the stairwell's lit panes, 5 mm off their backing; lamp lenses) win their depth tie at any distance.
  // The street lens bowls sit 5 mm under Ashwood's shoebox glass, so they take the same offset to stay in front.
  depthBias: `select(0.0, N.forest.z, (v.matAux.x > 2.5 && v.matAux.x < 3.5) || abs(v.matAux.x - ${LENS_MAT}.0) < 0.5)`,
  vertex: `if(v.matAux.x==30.0) {
    let toCam=normalize(F.cam.xz-v.pos.xz);
    let side=vec2f(toCam.y,-toCam.x);
    o.world+=vec3f(side.x*v.normal.x*v.normal.z*0.5,v.normal.y,side.y*v.normal.x*v.normal.z*0.5)*v.matAux.y;
    o.normal=normalize(vec3f(toCam.x,0.55,toCam.y));
  }`,
  declarations: nightUniform + fogSceneWgsl + interiorWgsl + wetSurfaceWgsl + "\nvar<private> wetFootprint: f32 = 0.0;",
  bounce: "lotBounce(o.world,n)", directional: "vec3f(0.0)", lightLeak: "0.0", wallDirectScale: "1.0",
  ambient: "fogAmbient(n)*mix(1.0,0.12,lotIndoor(o.world))",
  material: /* wgsl */ `
    pbrRough=0.8;
  `,
  fragmentReturn: reflectiveSurfaceReturn(),
  surface: /* wgsl */ `
    let ray=normalize(o.world-F.cam.xyz);
    // Street lamp lens bowls (lamps.ts): emissive, core to rim; Today leaves Ashwood's own lens.
    if(mat==${LENS_MAT}) {
      if(N.streetB.x<0.5) { discard; }
      // The arc tube's core runs hot enough to bleach towards pale yellow; the rim keeps the sodium amber.
      let core=smoothstep(0.7,1.0,o.aux);
      col=mix(vec3f(1.0,0.55,0.18),vec3f(1.0,0.72,0.34),core*0.5)*o.aux*11.0*N.streetB.z;
    }
    if(mat==3 && o.aux<0.0) {
      col=fogSky(F.cam.xyz,ray);
    } else {
      col=mix(fogApply(col,F.cam.xyz,o.world),col,lotIndoor(o.world)*lotIndoor(F.cam.xyz)*(1.0-N.interior.z));
    }
  `,
}

const physical = { env: "mix(fogEnv(dir),fogAmbient(n),rough*rough)", knobs:"vec4f(N.look.w,1.0,1.0,0.02)", spotShadows:true, ...(STREET_SHADERS ? { street:{ a:"N.streetA", b:"N.streetB" } } : {}) }
export const hooks = withPhysicalLights(nightHooks, physical)
export const texturedHooks: SceneHooks = withPhysicalLights({ ...nightHooks,
  surface: `if(mat==3) { col*=texBase.rgb; }\n${nightHooks.surface}`,
  fragmentStart: "wetFootprint=max(length(dpdx(o.world)),length(dpdy(o.world)));",
  material: `${nightHooks.material}
    if(mat!=20) { pbrRough=rough; } else {
      let geo=normalize(o.normal);
      let wet=wetSurface(o.world,geo.y,rough,texAo,wetFootprint,N.wet,${wetMaterialWgsl(WET_ASPHALT)});
      albedo*=wet.albedo;
      n=normalize(mix(n,geo,wet.flat));
      // Like Ashwood's specularAA, puddles keep the asphalt's lost mip variance (×2, capped at 0.05): far puddles go
      // satin instead of mirroring the horizon as a sharp sky patch.
      let aaVar=texNormalVariance*N.look.w;
      pbrRough=pow(min(pow(wet.roughness,4.0)+mix(aaVar,min(aaVar*2.0,0.05),wet.flat),1.0),0.25);
    }
    pbrMetal=metal;`,
}, {...physical,aaNormal:"texNormal"})
export const glassHooks: SceneHooks = { ...hooks,
  material: `${hooks.material}\npbrRough=0.06; alpha=0.35;`,
  combineLighting: `${hooks.combineLighting}; col += vec3f(1.0,0.36,0.08)*0.7`,
}

const glassKnobs = ["N.glassA", "N.glassB", "N.glassC"] as const
/** Booth, entrance and interior glass: inner faces mirror local fixture light instead of the outdoor sky. */
export const thinGlassHooksLot = thinGlassHooks(hooks, { knobs: glassKnobs,
  roomSide: "select(0.0, 1.0, (dot(n.xz, vec2f(9.0, 127.5) - p.xz) > 0.0 && abs(p.x - 9.0) < 1.9 && abs(p.z - 127.5) < 1.6) || lotIndoor(p+n*0.15)>0.5)",
  roomAlbedo: "vec3f(0.5, 0.45, 0.38)" })
/** Facility lit windows as interior-mapped rooms behind front glass (Glass › Lit windows › Rooms). */
// Ashwood shell.ts bays: 3 lights (70 mm bars), a transom 0.47 m above the pane on storeys 1–4.
// Its panes sit 3 cm proud of the glow proxies, which take one offset: twice that keeps them in front.
export const windowHooks = { ...interiorWindowHooks(hooks, { knobs: glassKnobs, layout: ROOM_ATLAS, mullions: { cols: 3, width: 0.07, transom: 0.47, transomAbove: 3.9 } }), depthBias: "N.forest.z * 2.0" }
/** Screen-space contact shadows toward the strongest lamps; the fog sky shares the light at each pixel. */
export const contactVolume = contactShadowVolume({ declarations: fogParamsWgsl + nightUniform, knobs: ["N.contactA", "N.contactB"], ambient: "fogAmbient(n)" })

/** Ashwood's 50 mm diamond grid with subpixel coverage preserved by screen-space dithering. */
export const fenceHooks: SceneHooks = { ...hooks, fragmentStart: /* wgsl */ `
  let grid=vec2f(o.uv.x+o.uv.y,o.uv.x-o.uv.y)/0.070710678;
  let d=(fract(grid)-0.5)*0.05;
  let fw=max(fwidth(grid)*0.05,vec2f(0.00001));
  let hw=max(vec2f(0.0018),fw*0.6);
  let coverage=clamp((hw-abs(d))/fw+0.5,vec2f(0.0),vec2f(1.0))*(0.0018/hw);
  let noise=fract(52.9829189*fract(dot(floor(o.pos.xy),vec2f(0.06711056,0.00583715))));
  if(max(coverage.x,coverage.y)<noise) { discard; }
` }
