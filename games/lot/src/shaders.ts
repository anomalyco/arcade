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
import { finishWgsl, finishMaterial } from "./interior/finishes"
import { EXTERIOR_WET, TERRAIN_MAT } from "./surface-materials"

/** The CI smoke (`?smoke`, software GPU) keeps the street lamps at Today, so its shaders leave the street path out. */
const STREET_SHADERS = !new URLSearchParams(globalThis.location?.search ?? "").has("smoke")
const nightUniform = `struct Night { fog: vec4f, look: vec4f, torch: vec4f, wet: vec4f, interior: vec4f, forest: vec4f, glassA: vec4f, glassB: vec4f, glassC: vec4f, contactA: vec4f, contactB: vec4f, streetA: vec4f, streetB: vec4f, streetC: vec4f, finish: vec4f }
@group(0) @binding(13) var<uniform> N: Night;`
/** Floats in the Night uniform (`main.ts` packs it). */
export const NIGHT_FLOATS = 60
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
  declarations: nightUniform + fogSceneWgsl + interiorWgsl + finishWgsl + wetSurfaceWgsl + "\nvar<private> wetFootprint: f32 = 0.0;",
  bounce: "lotBounce(o.world,n)", directional: "vec3f(0.0)", lightLeak: "0.0", wallDirectScale: "1.0",
  ambient: "fogAmbient(n)*mix(1.0,0.12,lotIndoor(o.world))",
  material: /* wgsl */ `
    pbrRough=0.8;
    if(mat==40) { pbrRough=fract(o.aux*0.5)*2.0; pbrMetal=floor(o.aux*0.5)/15.0; }
  `,
  fragmentReturn: reflectiveSurfaceReturn(),
  surface: /* wgsl */ `
    let ray=normalize(o.world-F.cam.xyz);
    // Street lamp lens bowls (lamps.ts): emissive, core to rim; Today leaves Ashwood's own lens.
    if(mat==${LENS_MAT}) {
      if(N.streetB.x<0.5) { discard; }
      // The prismatic bowl glows evenly to its rim in sodium amber, a touch hotter over the arc tube.
      let core=smoothstep(0.7,1.0,o.aux);
      col=mix(vec3f(1.0,0.55,0.18),vec3f(1.0,0.66,0.26),core*0.25)*o.aux*11.0*N.streetB.z;
    }
    if(mat==3 && o.aux<0.0) {
      col=fogSky(F.cam.xyz,ray);
    } else {
      col=mix(fogApply(col,F.cam.xyz,o.world),col,lotIndoor(o.world)*lotIndoor(F.cam.xyz)*(1.0-N.interior.z));
    }
  `,
}

const physical = { env: "mix(fogEnv(dir),fogAmbient(n),rough*rough)", knobs:"vec4f(N.look.w,1.0,1.0,0.02)", spotShadows:true, rect:STREET_SHADERS, ...(STREET_SHADERS ? { street:{ a:"N.streetA", b:"N.streetB" } } : {}) }
export const hooks = withPhysicalLights(nightHooks, physical)
export const texturedHooks: SceneHooks = withPhysicalLights({ ...nightHooks,
  surface: `if(mat==3) {
    col*=texBase.rgb;
    if(lotIndoor(o.world)>0.5 && o.world.y>2.9) {
      col*=N.finish.w;
      if(o.normal.y< -0.9) {
        // Prismatic troffer lens: softened edge into the frame and narrow diffusion ribs, filtered at distance.
        let edge=min(o.uv,vec2f(1.0)-o.uv);
        let rim=smoothstep(0.0,0.065,edge.x)*smoothstep(0.0,0.035,edge.y);
        let ribs=mix(0.92,0.84+0.16*pow(sin(o.uv.x*75.398),2.0),1.0-smoothstep(0.015,0.05,wetFootprint));
        col*=mix(0.35,1.0,rim)*ribs;
      }
    }
  }\n${nightHooks.surface}`,
  fragmentStart: "wetFootprint=max(length(dpdx(o.world)),length(dpdy(o.world)));",
  material: `${nightHooks.material}
    if(mat!=20) { pbrRough=rough; } else {
      let geo=normalize(o.normal);
      var recipe=${wetMaterialWgsl(WET_ASPHALT)};
      ${EXTERIOR_WET.slice(1).map(([,recipe],i)=>`if(abs(o.aux-${(i+1).toFixed(1)})<0.5) { recipe=${wetMaterialWgsl(recipe)}; }`).join("\n")}
      let wet=wetSurface(o.world,geo.y,rough,texAo,wetFootprint,N.wet,recipe);
      albedo*=wet.albedo;
      n=normalize(mix(n,geo,wet.flat));
      // Like Ashwood's specularAA, puddles keep the asphalt's lost mip variance (×2, capped at 0.05): far puddles go
      // satin instead of mirroring the horizon as a sharp sky patch.
      let aaVar=texNormalVariance*N.look.w;
      pbrRough=pow(min(pow(wet.roughness,4.0)+mix(aaVar,min(aaVar*2.0,0.05),wet.flat),1.0),0.25);
    }
    if(mat==${TERRAIN_MAT}) {
      // Ashwood terrain/surface.ts: recolour the floor's luminance, not its RGB channels.
      // Keeping weights until the fragment also avoids clipping the >1 grass/dirt tint in unorm vertex colours.
      let lum=dot(texBase.rgb,vec3f(0.2126,0.7152,0.0722));
      albedo=mix(mix(texBase.rgb,lum*vec3f(1.35,1.3,0.78)*1.15,o.color.r),lum*vec3f(1.25,1.05,0.85)*1.05,o.color.g);
      pbrRough=mix(rough,0.95,o.color.r*0.6);
    }
    pbrMetal=metal;
    ${finishMaterial}`,
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

/** Source facade rain streaks, alpha-blended without writing depth. */
export const stainHooks: SceneHooks = { ...hooks,
  declarations: `${hooks.declarations}\nvar<private> stainFootprint: f32;`,
  fragmentStart: `${hooks.fragmentStart ?? ""}\nstainFootprint=max(fwidth(o.uv.x),0.00001);`,
  material: `${hooks.material}
    let u=o.uv.x;
    let fine=1.0-smoothstep(0.015,0.08,stainFootprint);
    let streak=0.6+(sin(u*23.1+sin(u*5.3)*2.0)*0.25+sin(u*61.7+sin(u*13.1))*0.18)*fine;
    let reach=mix(0.55,1.0,fract(sin(floor(u*4.0)*17.3)*9134.7));
    let fade=1.0-smoothstep(0.0,reach,o.uv.y);
    alpha=clamp(streak*fade*fade*o.aux,0.0,0.9);
    pbrRough=1.0; pbrMetal=0.0;`,
}

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
