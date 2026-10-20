import { nightAtmosphere } from "@arcade/kit/gpu/night-atmosphere"
import type { SceneHooks } from "@arcade/kit/gpu/shaders"

export const hooks: SceneHooks = {
  lampGrid: false,
  declarations: /* wgsl */ `
    struct Night { fog: vec4f, look: vec4f, torch: vec4f }
    @group(0) @binding(13) var<uniform> N: Night;
    ${nightAtmosphere}
    // HSL(181°, .75, .5), normalised to .034 linear luminance (source atmosphere.ts).
    fn fogColor() -> vec3f { return vec3f(0.006016,0.041514,0.042113)*N.fog.z; }
    fn sky(ray: vec3f) -> vec3f {
      let up=max(ray.y,0.0);
      let dark=fogColor()*0.45*mix(1.0,0.55,smoothstep(0.0,0.8,up));
      let glow=fogColor()*0.35*exp(-up*5.0);
      let trans=1.0-heightFog(F.cam.xyz,F.cam.xyz+ray*4000.0,N.fog.x,N.fog.y);
      return mix(fogColor(),dark+glow,trans);
    }
    fn torchLight(p: vec3f, n: vec3f) -> vec3f {
      let delta=p-F.cam.xyz;
      let distance=max(length(delta),0.01);
      let beam=smoothstep(0.91,0.98,dot(delta/distance,N.torch.xyz));
      return vec3f(0.85,0.92,1.0)*beam*N.torch.w*max(dot(n,-delta/distance),0.0)*6.0/(1.0+distance*distance*0.10);
    }
    fn wetReflection(p: vec3f) -> vec3f {
      var result=vec3f(0.0);
      let ray=normalize(p-F.cam.xyz);
      for(var i=0u;i<u32(F.screen.z);i++) {
        let l=lights[i];
        if(l.color.w<1.0 || distance(l.pos.xz,p.xz)>l.pos.w*select(2.0,1.0,l.pos.y>4.0)) { continue; }
        let mirrored=normalize(vec3f(l.pos.x,-l.pos.y,l.pos.z)-F.cam.xyz);
        let across=dot(ray.xz,vec2f(-mirrored.z,mirrored.x));
        let elevation=ray.y-mirrored.y;
        let streak=exp(-across*across*30000.0-elevation*elevation*60.0);
        let breakup=0.35+0.65*noise2(p.xz*vec2f(3.0,15.0));
        result+=l.color.rgb*streak*breakup*0.18*N.look.x;
      }
      return result;
    }
  `,
  bounce: "vec3f(0.0)", directional: "vec3f(0.0)", lightLeak: "0.0", wallDirectScale: "1.0",
  lightAttenuation: /* wgsl */ `
    let cutoff=pow(max(0.0,1.0-pow(d3/r,4.0)),2.0);
    let cone=select(1.0,smoothstep(cos(1.1),cos(1.1*0.45),dy/d3),hl>4.0);
    // Physical source candela already carries the intensity; cancel kit's legacy ×5 light gain.
    var att=power*cutoff*cone/(GAIN*3.14159265*max(d3*d3,0.01));
  `,
  ambient: "fogColor()*mix(0.12,0.6,max(n.y,0.0))",
  combineLighting: "col=albedo*(amb+direct+torchLight(o.world,n))",
  material: /* wgsl */ `
    gloss=vec2f(0.0);
    if(mat==20) { albedo*=mix(1.0,0.52,N.look.x); }
  `,
  surface: /* wgsl */ `
    let ray=normalize(o.world-F.cam.xyz);
    if(mat==3 && o.aux<0.0) {
      col=sky(ray);
    } else {
      if(mat==20) { col+=wetReflection(o.world); }
      col=mix(col,fogColor(),heightFog(F.cam.xyz,o.world,N.fog.x,N.fog.y));
    }
    for(var i=0u;i<u32(F.screen.z);i++) {
      let l=lights[i];
      if(l.pos.y<4.0 || l.color.w<1.0) { continue; }
      let sigma=N.fog.x*exp(-l.pos.y*N.fog.y);
      let trans=1.0-heightFog(F.cam.xyz,l.pos.xyz,N.fog.x,N.fog.y);
      col+=l.color.rgb*l.color.w*sigma*trans*N.look.y*downlightScatter(F.cam.xyz,o.world,l.pos.xyz,l.pos.w,vec4f(cos(1.1),cos(1.1*0.45),0.03,4.5),0.225,0.6);
    }
  `,
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
