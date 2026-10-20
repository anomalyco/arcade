import type { SceneHooks } from "@arcade/kit/gpu/shaders"
import { withPhysicalLights } from "@arcade/kit/gpu/lights/physical"
import { fogSceneWgsl, fogScatterVolume } from "@arcade/kit/gpu/fog-scatter"

const nightUniform = `struct Night { fog: vec4f, look: vec4f, torch: vec4f }
@group(0) @binding(13) var<uniform> N: Night;`
export const fogVolume = fogScatterVolume({ declarations: nightUniform,
  wet: "select(0.0,N.look.x,p.y < 0.06 && p.y > -0.05 && (abs(p.x)<6.0 || (p.x > -13.0 && p.x < 13.0 && p.z > 120.0 && p.z < 145.0)))",
  roughness: "0.55", normal: "vec3f(0.0,1.0,0.0)",
})

const nightHooks: SceneHooks = {
  lampGrid: false,
  vertex: `if(v.matAux.x==30.0) {
    let toCam=normalize(F.cam.xz-v.pos.xz);
    let side=vec2f(toCam.y,-toCam.x);
    o.world+=vec3f(side.x*v.normal.x*v.normal.z*0.5,v.normal.y,side.y*v.normal.x*v.normal.z*0.5)*v.matAux.y;
    o.normal=normalize(vec3f(toCam.x,0.55,toCam.y));
  }`,
  declarations: nightUniform + fogSceneWgsl,
  bounce: "vec3f(0.0)", directional: "vec3f(0.0)", lightLeak: "0.0", wallDirectScale: "1.0",
  ambient: "fogAmbient(n)",
  material: /* wgsl */ `
    pbrRough=0.8;
    if(mat==20) { albedo*=mix(1.0,0.52,N.look.x); pbrRough=mix(0.8,0.36,N.look.x); }
  `,
  surface: /* wgsl */ `
    let ray=normalize(o.world-F.cam.xyz);
    if(mat==3 && o.aux<0.0) {
      col=fogSky(F.cam.xyz,ray);
    } else {
      col=fogApply(col,F.cam.xyz,o.world);
    }
  `,
}

export const hooks = withPhysicalLights(nightHooks, { env: "mix(fogEnv(dir),fogAmbient(n),rough*rough)", settings: { spill: 0 }, spotShadows: true })
export const texturedHooks: SceneHooks = { ...hooks, material: `${hooks.material}\nif(mat!=20) { pbrRough=rough; } pbrMetal=metal;` }
export const glassHooks: SceneHooks = { ...hooks,
  material: `${hooks.material}\npbrRough=0.06; alpha=0.35;`,
  combineLighting: `${hooks.combineLighting}; col += vec3f(1.0,0.36,0.08)*0.7`,
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
