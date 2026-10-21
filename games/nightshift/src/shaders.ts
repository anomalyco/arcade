import { withPhysicalLights } from "@arcade/kit/gpu/lights/physical"
import { fogSceneWgsl, fogScatterVolume } from "@arcade/kit/gpu/fog-scatter"
import { postShader, type SceneHooks } from "@arcade/kit/gpu/shaders"
import { contactShadowVolume } from "@arcade/kit/gpu/contact-shadows"

const uniform = `struct Office { look: vec4f, lamps: vec4f, phone: vec4f, cord: vec4f, contactA: vec4f, contactB: vec4f }
@group(0) @binding(13) var<uniform> O: Office;`
const ambient = "vec3f(0.32,0.68,1.0)*O.look.x*(0.55+0.45*max(n.y,0.0))"
export const fogVolume = fogScatterVolume({ declarations: uniform })
export const contactVolume = contactShadowVolume({ declarations: uniform, knobs: ["O.contactA", "O.contactB"], ambient })
const base: SceneHooks = {
  lampGrid: false,
  vertex: `if(v.matAux.y<0.0){let t=clamp((-v.matAux.y-1.0)/100.0,0.0,1.0);o.world+=O.cord.xyz*t*t;}`,
  fragmentStart: "officeFootprint=max(length(dpdx(o.world)),length(dpdy(o.world)));",
  declarations: uniform + fogSceneWgsl + /* wgsl */ `
var<private> officeFootprint: f32;
fn officeHash(p: vec3f) -> f32 { return fract(sin(dot(p,vec3f(127.1,311.7,74.7)))*43758.5453); }
fn officeNoise(p: vec3f) -> f32 {
  let i=floor(p); let f=fract(p); let u=f*f*(3.0-2.0*f);
  return mix(mix(mix(officeHash(i),officeHash(i+vec3f(1,0,0)),u.x),mix(officeHash(i+vec3f(0,1,0)),officeHash(i+vec3f(1,1,0)),u.x),u.y),mix(mix(officeHash(i+vec3f(0,0,1)),officeHash(i+vec3f(1,0,1)),u.x),mix(officeHash(i+vec3f(0,1,1)),officeHash(i+vec3f(1,1,1)),u.x),u.y),u.z);
}
fn blindCookie(p: vec3f, lamp: vec3f) -> f32 {
  // A planar Venetian-blind gobo projected along the incident ray. The half-open
  // blades have a finite penumbra which grows with distance from the window.
  let left=lamp.x < -5.0;
  let axis=select(vec3f(-0.62,-0.65,0.43),vec3f(0.88,-0.43,-0.2),left);
  let q=p-lamp;
   let across=q.z-q.x*axis.z/axis.x;
   let slat=select(q.y-q.z*axis.y/axis.z,q.y-q.x*axis.y/axis.x,left)/0.115;
   let pen=0.09+abs(q.x)*0.018;
  let mask=smoothstep(0.36-pen,0.36+pen,abs(fract(slat)-0.5));
  return mask*(1.0-smoothstep(0.8,1.05,abs(across)))*(1.0-smoothstep(1.2,2.0,p.y));
}
`,
  bounce: "vec3f(0.0)", directional: "vec3f(0.0)", lightLeak: "0.0", wallDirectScale: "1.0",
  ambient,
  material: /* wgsl */ `
    pbrRough=0.65;
    let p=o.world;
    let kind=i32(round(o.aux));
    let footprint=officeFootprint;
    let grain=officeNoise(p*160.0);
    let wear=officeNoise(p*6.0)*0.5+officeNoise(p*21.0)*0.5;
    albedo*=0.88+0.2*wear;
    if(kind==1) {
      let uv=select(p.xy,p.zy,abs(n.x)>0.5);
      let weave=sin(uv.x*3400.0)*sin(uv.y*2100.0);
      albedo*=0.55+0.65*grain+0.18*weave*(1.0-smoothstep(0.0004,0.005,footprint));
      let bump=vec3f(officeNoise(p*550.0),officeNoise(p*550.0+17.0),officeNoise(p*550.0+39.0))-0.5;
      n=normalize(n+bump*0.35);
      pbrRough=0.96;
    }
    if(kind==2) {
      let fibre=officeNoise(p*420.0);let stain=officeNoise(p*1.5);
      albedo*=0.33+0.95*fibre+0.25*stain;
      n=normalize(n+vec3f(officeNoise(p*350.0)-0.5,0.0,officeNoise(p*350.0+13.0)-0.5)*0.65);
      pbrRough=0.98;
      // Broad dirt/traffic along the aisle, grounded partition bases.
      albedo*=mix(0.77,1.0,smoothstep(0.1,1.3,abs(p.x)));
    }
    if(kind==3) { albedo*=0.55+0.48*officeNoise(p*85.0)+0.25*officeNoise(p*430.0);pbrRough=0.53; }
    if(kind==4) { albedo*=0.48+0.65*grain;pbrRough=0.97; }
    if(kind==5) { pbrRough=0.46;pbrMetal=0.2; }
    if(kind==6) { pbrRough=0.94;albedo*=0.9+0.15*grain; }
    if(kind==0) { pbrRough=0.43+wear*0.15;albedo*=0.95+grain*0.1; }
  `,
  surface: /* wgsl */ `
    let kind=i32(round(o.aux));
    if(kind==7) { col=vec3f(0.77,0.89,0.70)*O.lamps.x*2.5; }
    if(kind==8) {
      let uv=(o.world.xy-vec2f(-0.74,1.12))*vec2f(2.75,3.8);
      let screen=1.0-smoothstep(0.25,0.75,length(uv));
      let scan=0.92+0.08*sin(o.world.y*4400.0);
      col=vec3f(0.12,0.67,0.38)*(0.5+screen*0.5)*scan;
      col+=vec3f(0.02,0.07,0.03)*officeHash(floor(o.world*1300.0)+floor(F.cam.w*12.0));
    }
    if(kind==9) { col=vec3f(3.5,0.11,0.025)*O.lamps.y; }
    col=fogApply(col,F.cam.xyz,o.world);
  `,
}
const physical=withPhysicalLights(base,{spotShadows:true,env:"vec3f(0.012,0.026,0.025)",settings:{spill:0,specularAA:1}})
export const hooks: SceneHooks = {...physical, lightAttenuation: physical.lightAttenuation + `
    if(L.pos.x < -5.0 || (L.pos.x>1.4 && L.pos.x<1.6)) { att*=blindCookie(world,L.pos.xyz); }
`}
export const post=postShader(false,false,{chromatic:0,bloom:0.18,grain:0.006,vignette:0.4,bloomGate:{cap:0.04,hot:3},shadowLiftColor:[0.0001,0.0005,0.0005],shadowTint:[0.83,1.02,0.98],highlightTint:[1.02,1,0.93],saturation:0.85})
