/** Linear photometric sky. F is the kit Frame layout; all exposure belongs to the host. */
export const skyShader = /* wgsl */ `
struct Frame { viewProj: mat4x4f, cam: vec4f, screen: vec4f, eye: vec4f, ambient: vec4f, focus: vec4f, monitorBounds: vec4f, map: vec4f, effects: vec4f }
@group(0) @binding(0) var<uniform> F: Frame;
struct Sky {
  equatorX: vec4f, equatorY: vec4f, equatorZ: vec4f,
  moon: vec4f, moonRight: vec4f, moonUp: vec4f, sun: vec4f,
  radiometry: vec4f, layers: vec4f, phase: vec4f, flash: vec4f,
  scatter: vec4f,
}
@group(1) @binding(0) var<uniform> S: Sky;
@group(1) @binding(1) var moonMap: texture_2d<f32>;
@group(1) @binding(2) var moonSampler: sampler;
const PI: f32 = 3.14159265359;
fn worldDirection(e: vec3f) -> vec3f { return S.equatorX.xyz*e.x + S.equatorY.xyz*e.y + S.equatorZ.xyz*e.z; }
fn equatorial(d: vec3f) -> vec3f { return vec3f(dot(d,S.equatorX.xyz),dot(d,S.equatorY.xyz),dot(d,S.equatorZ.xyz)); }
fn cameraRay(pixel: vec2f) -> vec3f {
  let forward = normalize(vec3f(F.viewProj[0][3],F.viewProj[1][3],F.viewProj[2][3]));
  let rowX = vec3f(F.viewProj[0][0],F.viewProj[1][0],F.viewProj[2][0]);
  let rowY = vec3f(F.viewProj[0][1],F.viewProj[1][1],F.viewProj[2][1]);
  let cx = dot(rowX,forward); let cy = dot(rowY,forward);
  let right = rowX-cx*forward; let up = rowY-cy*forward;
  let ndc = pixel/F.screen.xy*vec2f(2,-2)+vec2f(-1,1);
  return normalize(forward+right*((ndc.x-cx)/dot(right,right))+up*((ndc.y-cy)/dot(up,up)));
}
fn transmission(alt: f32) -> vec3f {
  let degrees = max(0.0,alt*180.0/PI);
  let mass = 1.0/(sin(max(0.0,alt))+0.50572*pow(degrees+6.07995,-1.6364));
  return exp2(-1.32877124*S.radiometry.y*mass*vec3f(0.8,1,1.3))*smoothstep(0.0,0.0087,alt);
}
fn noise(p: vec3f) -> f32 {
  // Continuous low-frequency waves, no screen hashes or unresolved octaves.
  return 0.5+0.22*sin(dot(p,vec3f(1.7,2.3,0.8)))+0.16*sin(dot(p,vec3f(-2.1,1.2,2.7)))+0.12*sin(dot(p,vec3f(3.1,-2.2,1.4)));
}
struct V { @builtin(position) pos: vec4f }
@vertex fn domeVertex(@builtin(vertex_index) i: u32) -> V {
  let p=vec2f(f32((i<<1u)&2u),f32(i&2u));
  return V(vec4f(p*2.0-1.0,S.flash.w,1.0));
}
@fragment fn domeFragment(v: V) -> @location(0) vec4f {
  let d=cameraRay(v.pos.xy);
  let altitude=asin(clamp(d.y,-1.0,1.0));
  let trans=transmission(altitude);
  let eq=equatorial(d);
  let north=dot(eq,vec3f(-0.86766615,-0.19807637,0.45598378));
  let centre=dot(eq,vec3f(-0.05487556,-0.87343709,-0.48383502));
  let band=exp(-north*north/0.014)*(0.4+0.6*noise(eq*17.0));
  let rift=1.0-0.65*exp(-pow(north+0.018*sin(centre*13.0),2.0)/0.00045)*smoothstep(-0.3,0.5,centre);
  let milky=0.00012*S.layers.x*band*rift*mix(1.0,6.0,S.equatorY.w);
  // Finite 90 km emission shell (van Rhijn), suppressed at the horizon by extinction.
  let shell=inverseSqrt(max(0.028,1.0-0.972*(1.0-d.y*d.y)));
  let air=0.00011*S.layers.y*shell*(0.9+0.1*noise(d*8.0));
  let ecliptic=dot(eq,vec3f(0.0,-0.397777,0.917482));
  let zodiac=0.00005*S.layers.z*exp(-ecliptic*ecliptic/0.02)*pow(max(dot(d,S.sun.xyz),0.0),6.0);
  var colour=(vec3f(0.000055)+vec3f(0.96,1.02,0.96)*air+vec3f(1.04,1.0,0.94)*(milky+zodiac))*trans*pow(1.0-S.sun.w,2.0);
  // Night-only fitted scattering, not a full daytime atmosphere LUT.
  // The CPU selects host or astronomical daylight once for both stars and dome.
  let daylight=S.sun.w;
  colour+=daylight*vec3f(0.12,0.2,0.36)*(0.3+0.7*max(d.y,0.0));
  let cosine=clamp(dot(d,S.moon.xyz),-1.0,1.0);
  let angle=acos(cosine);
  let moonAlt=asin(clamp(S.moon.y,-1.0,1.0));
  let moonTrans=transmission(moonAlt);
  colour+=S.moon.w*S.layers.w*(0.0001+0.0015*exp(-angle/0.075))*vec3f(1.03,1.0,0.93)*moonTrans;
  // fwidth is evaluated uniformly, including fragments away from the disk.
  let radius=0.0045204028;
  let edge=max(fwidth(angle),0.00001);
  let disk=1.0-smoothstep(radius-edge*0.5,radius+edge*0.5,angle);
  let xy=vec2f(dot(d,S.moonRight.xyz),dot(d,S.moonUp.xyz))/sin(radius);
  let z=sqrt(max(0.0,1.0-dot(xy,xy)));
  let normal=vec3f(xy,z);
  let lit=max(dot(normal,vec3f(sin(S.phase.x),0,cos(S.phase.x))),0.0);
  let ls=lit/max(lit+z,0.0001);
  // NASA near side is centred on longitude zero; north stays up in the disk.
  let uv=vec2f(0.5+atan2(xy.x,z)/(2.0*PI),0.5-asin(clamp(xy.y,-1.0,1.0))/PI);
  let tex=textureSample(moonMap,moonSampler,uv).rgb;
  let earth=S.phase.z*pow(sin(S.phase.x*0.5),2.0);
  let surface=tex*S.phase.y*(ls+earth);
  // Moonlight scattered over the dome (model.ts moonSkyLuminance), bright enough to need no rod gain.
  let mass=1.0/(sin(max(0.0,altitude))+0.50572*pow(max(0.0,altitude*180.0/PI)+6.07995,-1.6364));
  let path=1.0-exp2(-1.32877124*S.radiometry.y*mass);
  let moonSky=S.moon.w*S.scatter.x*0.0848*(1.06+cosine*cosine+pow(10.0,0.79-angle*4.5/PI))*path*vec3f(0.9,1.0,1.2);
  // Adapt the diffuse sky and halo, not the already-bright lunar surface.
  colour=mix(colour*S.equatorZ.w+moonSky,surface*moonTrans,disk*S.phase.w);
  colour=colour*smoothstep(-0.025,0.015,d.y)*S.radiometry.x+S.flash.rgb;
  return vec4f(colour,1.0);
}
struct StarIn { @location(0) eq: vec3f, @location(1) visibilityWeight: f32, @location(2) lux: vec3f, @location(3) id: f32 }
struct StarOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) centre: vec2f,
  @location(1) @interpolate(flat) radiance: vec3f,
  @location(2) @interpolate(flat) psfScale: f32,
}
@vertex fn starVertex(v: StarIn, @builtin(vertex_index) i: u32) -> StarOut {
  let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  let d=worldDirection(v.eq);
  let p=F.viewProj*vec4f(d,0);
  let ndc=p.xy/max(p.w,0.000001);
  let centre=(ndc*vec2f(0.5,-0.5)+0.5)*F.screen.xy;
  let forward=normalize(vec3f(F.viewProj[0][3],F.viewProj[1][3],F.viewProj[2][3]));
  let rx=vec3f(F.viewProj[0][0],F.viewProj[1][0],F.viewProj[2][0]);
  let ry=vec3f(F.viewProj[0][1],F.viewProj[1][1],F.viewProj[2][1]);
  let fx=length(rx-forward*dot(rx,forward)); let fy=length(ry-forward*dot(ry,forward));
  let omega=4.0*pow(max(p.w,0.000001),3.0)/(F.screen.x*F.screen.y*fx*fy);
  let trans=transmission(asin(clamp(d.y,-1.0,1.0)));
  let seed=v.id*2.399963;
  let scint=1.0+S.radiometry.w*(1.0-0.7*max(d.y,0.0))*(0.65*sin(S.radiometry.z*3.1+seed)+0.35*sin(S.radiometry.z*5.7+seed*1.71));
  let visible=select(0.0,1.0,p.w>0.0001);
  var o:StarOut;
  // Include MSAA sample offsets beyond the pixel-integrated PSF's support.
  let clip=ndc+corners[i]*3.0/F.screen.xy*2.0;
  o.pos=vec4f(select(vec2f(4.0),clip,p.w>0.0001),S.flash.w,1);
  o.centre=centre;
  o.radiance=v.lux*mix(1.0,v.visibilityWeight,S.equatorY.w)*trans*S.radiometry.x*S.equatorX.w*S.equatorZ.w*scint*visible/max(omega,1e-12);
  o.psfScale=mix(1.0,0.72,S.equatorY.w);
  return o;
}
fn cdf(v: f32) -> f32 {
  let x=abs(v);
  var c=1.0-pow(max(2.0-x,0.0),4.0)/24.0;
  if(x<1.0){c=0.5+2.0*x/3.0-x*x*x/3.0+x*x*x*x/8.0;}
  return select(1.0-c,c,v>=0.0);
}
@fragment fn starFragment(v: StarOut) -> @location(0) vec4f {
  let p=v.pos.xy-v.centre;
  let energy=max(0.0,cdf((p.x+0.5)/v.psfScale)-cdf((p.x-0.5)/v.psfScale))*max(0.0,cdf((p.y+0.5)/v.psfScale)-cdf((p.y-0.5)/v.psfScale));
  // The unlit lunar disk is opaque too: stars must not shine through earthshine.
  let angle=acos(clamp(dot(cameraRay(v.pos.xy),S.moon.xyz),-1.0,1.0));
  let edge=max(fwidth(angle),0.00001);
  let visibility=mix(1.0,smoothstep(0.0045204028-edge*0.5,0.0045204028+edge*0.5,angle),S.phase.w);
  return vec4f(v.radiance*energy*visibility,0.0);
}
`
