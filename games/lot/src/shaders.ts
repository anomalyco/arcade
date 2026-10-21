import type { SceneHooks } from "@arcade/kit/gpu/shaders"
import { withPhysicalLights } from "@arcade/kit/gpu/lights/physical"
import { fogParamsWgsl, fogSceneWgsl, fogScatterVolume } from "@arcade/kit/gpu/fog-scatter"
import { reflectiveSurfaceReturn } from "@arcade/kit/gpu/reflections/surface"
import { ssrVolume } from "@arcade/kit/gpu/reflections/ssr"
import { WET_ASPHALT, wetMaterialWgsl, wetSurfaceWgsl } from "@arcade/kit/gpu/reflections/wet"
import { interiorWindowHooks, thinGlassHooks } from "@arcade/kit/gpu/materials/glass"
import { ROOM_ATLAS } from "@arcade/kit/gpu/materials/rooms"
import { contactShadowVolume } from "@arcade/kit/gpu/contact-shadows"

const nightUniform = `struct Night { fog: vec4f, look: vec4f, torch: vec4f, forest: vec4f, wet: vec4f, glassA: vec4f, glassB: vec4f, glassC: vec4f, contactA: vec4f, contactB: vec4f }
@group(0) @binding(13) var<uniform> N: Night;`
/** Floats in the Night uniform (`main.ts` packs it). */
export const NIGHT_FLOATS = 40
// Wet reflections follow the materials: every physical surface tags its roughness in the HDR alpha, and the asphalt's
// wet/puddle term (kit reflections/wet) sets that roughness, so puddles mirror and the film between them smears.
export const fogVolume = fogScatterVolume({ declarations: nightUniform, surface: true, wetSettings: "N.wet", wetMaterial: WET_ASPHALT,
  reflectionSamples:4, reflectionCap:"N.look.z",
})
export const reflectionVolume = ssrVolume({ wetMaterial: WET_ASPHALT })

const nightHooks: SceneHooks = {
  lampGrid: false,
  vertex: `if(v.matAux.x==30.0) {
    let toCam=normalize(F.cam.xz-v.pos.xz);
    let side=vec2f(toCam.y,-toCam.x);
    o.world+=vec3f(side.x*v.normal.x*v.normal.z*0.5,v.normal.y,side.y*v.normal.x*v.normal.z*0.5)*v.matAux.y;
    o.normal=normalize(vec3f(toCam.x,0.55,toCam.y));
  }`,
  declarations: nightUniform + fogSceneWgsl + wetSurfaceWgsl + "\nvar<private> wetFootprint: f32 = 0.0;",
  bounce: "vec3f(0.0)", directional: "vec3f(0.0)", lightLeak: "0.0", wallDirectScale: "1.0",
  ambient: "fogAmbient(n)",
  material: /* wgsl */ `
    pbrRough=0.8;
  `,
  fragmentReturn: reflectiveSurfaceReturn(),
  surface: /* wgsl */ `
    let ray=normalize(o.world-F.cam.xyz);
    if(mat==3 && o.aux<0.0) {
      col=fogSky(F.cam.xyz,ray);
    } else {
      col=fogApply(col,F.cam.xyz,o.world);
    }
  `,
}

const physical = { env: "mix(fogEnv(dir),fogAmbient(n),rough*rough)", knobs:"vec4f(N.look.w,1.0,1.0,0.02)", spotShadows:true }
export const hooks = withPhysicalLights(nightHooks, physical)
export const texturedHooks: SceneHooks = withPhysicalLights({ ...nightHooks,
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
/** Booth glass you can see through: Fresnel opacity, sky and lamp reflections, grime and condensation (Glass › Thin glass). */
// The booth (Ashwood layout BOOTH: x 9, z 127.5, 3.4 × 2.8 m) is the only glass: its inner faces mirror its lit room.
export const thinGlassHooksLot = thinGlassHooks(hooks, { knobs: glassKnobs,
  roomSide: "select(0.0, 1.0, dot(n.xz, vec2f(9.0, 127.5) - p.xz) > 0.0 && abs(p.x - 9.0) < 1.9 && abs(p.z - 127.5) < 1.6)",
  roomAlbedo: "vec3f(0.5, 0.45, 0.38)" })
/** Facility lit windows as interior-mapped rooms behind front glass (Glass › Lit windows › Rooms). */
// Ashwood shell.ts bays: 3 lights (70 mm bars), a transom 0.47 m above the pane on storeys 1–4.
export const windowHooks = interiorWindowHooks(hooks, { knobs: glassKnobs, layout: ROOM_ATLAS, mullions: { cols: 3, width: 0.07, transom: 0.47, transomAbove: 3.9 } })
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
