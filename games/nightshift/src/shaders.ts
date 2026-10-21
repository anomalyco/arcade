import { withPhysicalLights } from "@arcade/kit/gpu/lights/physical"
import { fogSceneWgsl, fogScatterVolume } from "@arcade/kit/gpu/fog-scatter"
import { postShader, type SceneHooks } from "@arcade/kit/gpu/shaders"
import { contactShadowVolume } from "@arcade/kit/gpu/contact-shadows"
import { BLINDS } from "./world"

const uniform = `struct Office { look: vec4f, lamps: vec4f, phone: vec4f, cord: vec4f, contactA: vec4f, contactB: vec4f, lightShape: vec4f }
@group(0) @binding(13) var<uniform> O: Office;`
const ambient = "vec3f(0.27,0.65,0.88)*O.look.x*(0.4+0.6*max(n.y,0.0))"
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
// Fade unresolved octaves to their mean before shading, including normals.
// TAA cannot reconstruct random detail several times smaller than one pixel.
fn officeDetail(p: vec3f, frequency: f32) -> f32 {
  return mix(officeNoise(p*frequency),0.5,smoothstep(0.25,0.75,officeFootprint*frequency));
}
fn blindCookie(p: vec3f, lamp: vec3f) -> f32 {
  // Project to the actual aperture, including its sill and head. The old gobo
  // omitted these bounds and painted stripes onto surfaces above the window.
  let axis=select(vec3f(0.9,-0.5,-0.5),vec3f(0.6,-0.22,-0.72),lamp.z<0.0);
  let distance=max(0.0,p.x-(${BLINDS.x}));
  let q=p-axis*distance/axis.x;
  let centre=select(4.0,0.0,lamp.z<0.0);
  let pen=0.003+distance*O.lightShape.x+officeFootprint*0.5;
  let aperture=smoothstep(0.90-pen,0.90+pen,q.y)*(1.0-smoothstep(2.55-pen,2.55+pen,q.y))*(1.0-smoothstep(1.14-pen,1.14+pen,abs(q.z-centre)));
  // Box-filtered periodic gaps conserve their mean when blades become subpixel.
  let phase=(q.y-${BLINDS.bottom})/${BLINDS.pitch};
  let width=max(0.002,pen/${BLINDS.pitch});
  let a=phase-width;let b=phase+width;
  let fa=floor(a)*0.40+clamp(fract(a)-0.60,0.0,0.40);
  let fb=floor(b)*0.40+clamp(fract(b)-0.60,0.0,0.40);
  return aperture*(fb-fa)/(2.0*width);
}
fn officeBounce(p: vec3f,n:vec3f) -> vec3f {
  // One diffuse floor-patch bounce, an area-source approximation, not GI.
  let nearest=vec3f(clamp(p.x,-0.95,0.9),0.02,clamp(p.z,2.2,4.4));
  let d=nearest-p;let d2=dot(d,d);
  let facing=max(dot(n,d*inverseSqrt(max(d2,0.001))),0.0);
  let warm=vec3f(1.0,0.39,0.10)*(0.15+0.85*facing)/(1.0+d2*1.5);
  let desk=vec3f(0.11,0.38,0.23)*exp(-dot(p.xz-vec2f(-.7,-5.2),p.xz-vec2f(-.7,-5.2))*1.8);
  return (warm+desk)*O.lightShape.y;
}
fn officeOcclusion(p:vec3f,n:vec3f)->f32 {
  var occlusion=1.0;
  if(p.y>0.78 && p.y<0.795 && n.y>0.8 && p.z< -4.9) {
    let centres=array<vec2f,5>(vec2f(.12,-5.4),vec2f(-.74,-5.62),vec2f(-.74,-5.15),vec2f(.62,-5.48),vec2f(1.02,-5.35));
    let sizes=array<vec2f,5>(vec2f(.20,.24),vec2f(.25,.22),vec2f(.27,.10),vec2f(.065,.065),vec2f(.07,.065));
    for(var i=0u;i<5u;i++) {
      let edge=max(abs(p.xz-centres[i])-sizes[i],vec2f(0));
      occlusion*=1.0-.42*exp(-dot(edge,edge)*1800.0);
    }
  }
  return occlusion;
}
fn terminal(uv:vec2f)->vec3f {
  let cell=vec2f(uv.x,1.0-uv.y)*vec2f(80,25);
  let id=floor(cell);let f=fract(cell);
  let seed=officeHash(vec3f(id,87.0));
  // 3x5 hexadecimal diagnostic glyphs, 80 columns by 25 rows like a 5151.
  let glyphs=array<u32,16>(31599u,9362u,29671u,29391u,23497u,31183u,31215u,29257u,31727u,31695u,31725u,23534u,31015u,19182u,31207u,31204u);
  let pixel=min(vec2u(f*vec2f(4,7)),vec2u(3,6));
  let ink=f32((glyphs[u32(seed*15.99)] >> min(14u,pixel.y*3u+pixel.x))&1u);
  let row=select(0.0,1.0,id.y>1.0&&id.y<23.0&&id.x>2.0&&id.x<12.0+officeHash(vec3f(id.y,7,2))*62.0);
  let gaps=select(1.0,0.0,pixel.x==3u||pixel.y>=5u||seed<.14);
  let resolved=1.0-smoothstep(.0007,.004,officeFootprint);
  let text=mix(.24,ink*gaps,resolved)*row;
  let face=pow(max(0.0,1.0-dot(uv-.5,uv-.5)*1.6),.5);
  return vec3f(.012,.041,.025)*face+vec3f(.16,.85,.34)*text*face;
}
`,
  bounce: "officeBounce(o.world,n)", directional: "vec3f(0.0)", lightLeak: "0.0", wallDirectScale: "1.0",
  ambient: `(${ambient})*officeOcclusion(o.world,n)`,
  material: /* wgsl */ `
    pbrRough=0.65;
    let p=o.world;
    let kind=i32(round(o.aux));
    let footprint=officeFootprint;
    let grain=officeDetail(p,160.0);
    let wear=officeNoise(p*6.0)*0.5+officeNoise(p*21.0)*0.5;
    albedo*=0.88+0.2*wear;
    if(kind==1) {
      let uv=select(p.xy,p.zy,abs(n.x)>0.5);
      let weave=sin(uv.x*3400.0)*sin(uv.y*2100.0);
      albedo*=0.55+0.65*grain+0.18*weave*(1.0-smoothstep(0.0004,0.005,footprint));
      let bump=(vec3f(officeNoise(p*550.0),officeNoise(p*550.0+17.0),officeNoise(p*550.0+39.0))-0.5)*(1.0-smoothstep(0.25,0.75,footprint*550.0));
      n=normalize(n+bump*0.35);
      pbrRough=0.96;
    }
    if(kind==2) {
      let fibre=officeDetail(p,420.0);let stain=officeNoise(p*1.5);
      albedo*=(0.33+0.95*fibre+0.25*stain)*(0.67+0.66*officeDetail(p,95.0));
      n=normalize(n+vec3f(officeNoise(p*350.0)-0.5,0.0,officeNoise(p*350.0+13.0)-0.5)*0.65*(1.0-smoothstep(0.25,0.75,footprint*350.0)));
      pbrRough=0.98;
      // Broad dirt/traffic along the aisle, grounded partition bases.
      albedo*=mix(0.77,1.0,smoothstep(0.1,1.3,abs(p.x)));
    }
    if(kind==3) { albedo*=0.55+0.48*officeDetail(p,85.0)+0.25*officeDetail(p,430.0);pbrRough=0.53; }
    if(kind==4) { albedo*=0.48+0.65*grain;pbrRough=0.97; }
    if(kind==5) { pbrRough=0.46;pbrMetal=0.2; }
    if(kind==6) { pbrRough=0.94;albedo*=0.9+0.15*grain; }
    if(kind==0) { pbrRough=0.43+wear*0.15;albedo*=0.95+grain*0.1; }
  `,
  surface: /* wgsl */ `
    let kind=i32(round(o.aux));
    if(kind==7) { col=vec3f(0.77,0.89,0.70)*O.lamps.x*2.5; }
    if(kind==8) {
      let uv=(o.world.xy-vec2f(-0.74,1.18))/vec2f(.31,.22)+.5;
      col=terminal(uv)+col*.12;
    }
    if(kind==9) { col=vec3f(3.5,0.11,0.025)*O.lamps.y; }
    if(kind==11) { col+=vec3f(1.0,0.38,0.10)*O.lamps.z*(0.45+0.55*officeNoise(o.world*3.0))*(1.0-0.8*smoothstep(1.2,2.55,o.world.y)); }
    if(kind==12) { col+=vec3f(1.0,0.55,0.18)*O.lamps.w; }
    col=fogApply(col,F.cam.xyz,o.world);
  `,
}
const physical=withPhysicalLights(base,{spotShadows:true,env:"vec3f(0.012,0.026,0.025)",settings:{spill:0,specularAA:1}})
export const hooks: SceneHooks = {...physical, lightAttenuation: physical.lightAttenuation + `
    if(L.pos.x < -3.0 && L.color.r>0.95 && L.color.b<0.2) { att*=blindCookie(world,L.pos.xyz); }
`}
// Imported PBR maps keep their roughness/metalness and mapped-normal AA; the
// procedural recipes above otherwise overwrite these with the plastic default.
export const propHooks: SceneHooks = {...hooks,
  fragmentStart: hooks.fragmentStart!.replace("normalize(o.normal)","texNormal"),
  material: hooks.material+"\n pbrRough=rough;pbrMetal=metal;",
  surface: hooks.surface!.replace("(o.world.xy-vec2f(-0.74,1.18))/vec2f(.31,.22)+.5","o.uv"),
}
export const post=postShader(false,false,{chromatic:0,bloom:0.22,grain:0.006,vignette:0.3,bloomGate:{cap:0.06,hot:0.7},shadowLiftColor:[0.0001,0.0004,0.0005],shadowTint:[0.9,1.0,1.03],highlightTint:[1.04,1,0.91],saturation:0.95})
