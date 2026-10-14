export const frameShader = /* wgsl */ `
struct Frame {
  inverse:mat4x4f, vp:mat4x4f, eye:vec4f,
  options:vec4f, moon:vec4f, grade:vec4f, ambient:vec4f,
  lights:array<vec4f,24>
}
@group(0) @binding(0) var<uniform> F:Frame;
`
const common = frameShader + /* wgsl */ `
struct Box { lo:vec3f, hi:vec3f }
const fixtures=array<Box,9>(
  Box(vec3f(-6,0,-4),vec3f(6,2.2,-3.6)),Box(vec3f(-6,0,-4),vec3f(-5.6,2.2,5)),
  Box(vec3f(5.6,0,-4),vec3f(6,2.2,-1)),Box(vec3f(5.6,0,1),vec3f(6,2.2,5)),Box(vec3f(-6,0,4.6),vec3f(6,0.65,5)),
  Box(vec3f(-3.5,0.2,-0.8),vec3f(-0.5,0.85,0.8)),Box(vec3f(-2.7,0.80,-0.65),vec3f(-1.1,1.4,0.65)),
  Box(vec3f(2.5,0,0.7),vec3f(3,1.3,1.2)),Box(vec3f(2.55,1.20,0.75),vec3f(2.95,1.7,1.15)));
const yardBoxes=array<Box,9>(
  Box(vec3f(-36,0,-42),vec3f(36,2.2,-41)),Box(vec3f(-36,0,-42),vec3f(-35,2.2,34)),
  Box(vec3f(35,0,-42),vec3f(36,2.2,34)),Box(vec3f(-36,0,33),vec3f(36,2.2,34)),
  Box(vec3f(-22,0,-14),vec3f(-10,2.4,-13.4)),Box(vec3f(-22,0,-14),vec3f(-21.4,2.4,-4)),
  Box(vec3f(-22,0,-4.6),vec3f(-16.5,2.4,-4)),Box(vec3f(-6.5,0,-24),vec3f(-5.7,1.6,-20)),
  Box(vec3f(-6.5,0,2),vec3f(-5.7,1.6,6)));
fn boxAt(i:u32)->Box {
  if(F.options.w>=4.0){return Box(vec3f(1000),vec3f(1000.01));}
  if(F.options.w<3.0){return fixtures[i];}
  return yardBoxes[i];
}
fn safeDir(ray:vec3f)->vec3f {
  return select(select(vec3f(-1e-6),vec3f(1e-6),ray>=vec3f(0.0)),ray,abs(ray)>vec3f(1e-6));
}
struct BoxHit { dist:f32, normal:vec3f }
fn intersectBox(origin:vec3f,ray:vec3f,b:Box)->BoxHit {
  let safe=safeDir(ray);
  let a=(b.lo-origin)/safe;let c=(b.hi-origin)/safe;let lo=min(a,c);let hi=max(a,c);
  let near=max(max(lo.x,lo.y),lo.z);let far=min(min(hi.x,hi.y),hi.z);
  var n=vec3f(0.0,0.0,-sign(safe.z));
  if(lo.x>=lo.y&&lo.x>=lo.z){n=vec3f(-sign(safe.x),0.0,0.0);}
  else if(lo.y>=lo.x&&lo.y>=lo.z){n=vec3f(0.0,-sign(safe.y),0.0);}
  return BoxHit(select(10000.0,max(near,0.0),near<far&&far>0.0),n);
}
fn sphere(origin:vec3f,ray:vec3f,centre:vec3f,radius:f32)->f32 {
  let oc=origin-centre;let b=dot(oc,ray);let d=b*b-dot(oc,oc)+radius*radius;
  if(d<0.0){return 10000.0;}let t=-b-sqrt(d);return select(10000.0,t,t>0.0);
}
`

/** Per light/angle, retain each box's interval and height. Unlike a single nearest blocker,
 * this can represent both a low car and a tall wall along the same direction. */
export const polarShader = common + /* wgsl */ `
@group(0) @binding(1) var<storage,read_write> polar:array<vec4f>;
@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid:vec3u){
  let light=gid.x/256u;let bin=gid.x%256u;
  if(light>=min(8u,u32(F.options.x))){return;}
  let angle=(f32(bin)+0.5)/256.0*6.2831853;
  let direction=vec2f(cos(angle),sin(angle));let safe=select(vec2f(0.000001),direction,abs(direction)>vec2f(0.000001));
  let origin=F.lights[light*3u].xz;
  for(var b=0u;b<9u;b++){
    let box=boxAt(b);let a=(box.lo.xz-origin)/safe;let c=(box.hi.xz-origin)/safe;
    let lo=min(a,c);let hi=max(a,c);let near=max(0.0,max(lo.x,lo.y));let far=min(hi.x,hi.y);
    polar[(light*256u+bin)*9u+b]=select(vec4f(10000,10000,0,0),vec4f(near,far,box.lo.y,box.hi.y),near<far&&far>0.0);
  }
}
`

export const stageShader = common + /* wgsl */ `
@group(0) @binding(1) var<storage,read> polar:array<vec4f>;
struct Out {@builtin(position) p:vec4f,@location(0) uv:vec2f}
@vertex fn vs(@builtin(vertex_index)i:u32)->Out {let c=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.p=vec4f(c[i],0,1);o.uv=c[i]*vec2f(0.5,-0.5)+0.5;return o;}

/** Exact signed-slab clearance and contact-hardening penumbra along a ray segment [0, dist] against box b. */
fn boxShadow(p:vec3f,invSigned:vec3f,inv:vec3f,dist:f32,b:Box,rSource:f32)->f32 {
  let rPad=rSource+0.008;
  let t0=(b.lo-p)*invSigned;let t1=(b.hi-p)*invSigned;
  let en=min(t0,t1);let ex=max(t0,t1);
  let pad=rPad*inv;
  let nearExp=max(0.0,max(en.x-pad.x,max(en.y-pad.y,en.z-pad.z)));
  let farExp=min(dist,min(ex.x+pad.x,min(ex.y+pad.y,ex.z+pad.z)));
  if(nearExp>=farExp){return 1.0;}
  let half=0.5*(b.hi-b.lo);
  var wSigned=max(-half.x,max(-half.y,-half.z));
  var tCrit=0.5*(nearExp+farExp);
  let denom=inv+inv.yzx;
  let wA=(en-ex.yzx)/denom;
  let tA=(en*inv.yzx+ex.yzx*inv)/denom;
  if(wA.x>wSigned){wSigned=wA.x;tCrit=tA.x;}
  if(wA.y>wSigned){wSigned=wA.y;tCrit=tA.y;}
  if(wA.z>wSigned){wSigned=wA.z;tCrit=tA.z;}
  let wB=(en.yzx-ex)/denom;
  let tB=(en.yzx*inv+ex*inv.yzx)/denom;
  if(wB.x>wSigned){wSigned=wB.x;tCrit=tB.x;}
  if(wB.y>wSigned){wSigned=wB.y;tCrit=tB.y;}
  if(wB.z>wSigned){wSigned=wB.z;tCrit=tB.z;}
  let wStart=-ex/inv;
  let mStart=max(wStart.x,max(wStart.y,wStart.z));
  if(mStart>wSigned){wSigned=mStart;tCrit=0.0;}
  let wEnd=(en-vec3f(dist))/inv;
  let mEnd=max(wEnd.x,max(wEnd.y,wEnd.z));
  if(mEnd>wSigned){wSigned=mEnd;tCrit=dist;}
  if(tCrit<=0.001||tCrit>=dist-0.001){return 1.0;}
  let pen=0.008+rSource*(tCrit/dist);
  return smoothstep(-pen,pen,wSigned);
}

fn visibility(p:vec3f,dir:vec3f,dist:f32,surface:i32,rSource:f32)->f32 {
  if(F.options.y<0.5){return 1.0;}
  let safe=safeDir(dir);
  let invSigned=1.0/safe;
  let inv=abs(invSigned);
  var vis=1.0;
  for(var b=0;b<9;b++){
    if(b==surface){continue;}
    let box=boxAt(u32(b));
    if(all(p>box.lo+vec3f(0.002))&&all(p<box.hi-vec3f(0.002))){continue;}
    vis=min(vis,boxShadow(p,invSigned,inv,dist,box,rSource));
    if(vis<=0.001){break;}
  }
  return vis;
}

struct PrimaryHit { hit:f32, index:i32, ray:vec3f, normal:vec3f, albedo:vec3f, nearEdge:bool }
fn traceRay(uv:vec2f)->PrimaryHit {
  let q=F.inverse*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),1,1);
  let ray=normalize(q.xyz/q.w-F.eye.xyz);
  var hit=select(10000.0,-F.eye.y/ray.y,ray.y<-1e-5);
  var index=-1;
  var normal=vec3f(0,1,0);
  var albedo=vec3f(0.18,0.21,0.26);
  var nearEdge=false;
  let safe=safeDir(ray);
  for(var i=0;i<9;i++){
    let b=boxAt(u32(i));
    let aExp=(b.lo-vec3f(0.08)-F.eye.xyz)/safe;
    let cExp=(b.hi+vec3f(0.08)-F.eye.xyz)/safe;
    let loExp=min(aExp,cExp);let hiExp=max(aExp,cExp);
    let nExp=max(max(loExp.x,loExp.y),loExp.z);let fExp=min(min(hiExp.x,hiExp.y),hiExp.z);
    if(nExp<fExp&&fExp>0.0&&max(nExp,0.0)<hit+0.15){
      nearEdge=true;
      let bh=intersectBox(F.eye.xyz,ray,b);
      if(bh.dist<hit){
        hit=bh.dist;index=i;normal=bh.normal;
        albedo=vec3f(0.3,0.34,0.38);
        if(i==5){albedo=vec3f(0.06,0.22,0.26);}
        if(i==6){albedo=vec3f(0.035,0.08,0.11);}
        if(i>=7){albedo=vec3f(0.42,0.32,0.17);}
      }
    }
  }
  if(F.options.w==1.0||F.options.w==2.0){
    if(sphere(F.eye.xyz,ray,vec3f(1.3,0.85,-1.8),0.93)<hit+0.15){
      nearEdge=true;
      let d=sphere(F.eye.xyz,ray,vec3f(1.3,0.85,-1.8),0.85);
      if(d<hit){hit=d;index=9;normal=normalize(F.eye.xyz+ray*hit-vec3f(1.3,0.85,-1.8));albedo=vec3f(0.5);}
    }
  }
  if(F.options.w<2.0){
    for(var l=0;l<min(8,i32(F.options.x));l++){
      let pos=F.lights[l*3];let color=F.lights[l*3+1];let cone=F.lights[l*3+2];
      if(cone.w<-2.5){continue;}
      if(sphere(F.eye.xyz,ray,pos.xyz,0.18)<hit+0.15){
        nearEdge=true;
        let lamp=sphere(F.eye.xyz,ray,pos.xyz,0.12);
        if(lamp<hit){hit=lamp;index=10+l;normal=normalize(F.eye.xyz+ray*hit-pos.xyz);albedo=color.rgb*color.w;}
      }
    }
  }
  if(index>=0&&index<9){
    let p=F.eye.xyz+ray*hit;
    let b=boxAt(u32(index));
    let dEdge=min(abs(p-b.lo),abs(p-b.hi));
    // Interior of a box face (>8cm from any two box planes) cannot straddle a crease or silhouette.
    let cCount=i32(dEdge.x<0.08)+i32(dEdge.y<0.08)+i32(dEdge.z<0.08);
    if(cCount<2){nearEdge=false;}
  }
  return PrimaryHit(hit,index,ray,normal,albedo,nearEdge);
}

fn shadeSample(h:PrimaryHit,aa:vec2f)->vec3f {
  if(h.index>=10){
    if(F.options.z==5.0){return h.normal*0.5+0.5;}
    return h.albedo;
  }
  let p=F.eye.xyz+h.ray*h.hit;
  let normal=h.normal;
  let softness=max(0.05,select(0.45,F.ambient.w,F.ambient.w>0.0));
  var light=F.ambient.rgb*(0.5+0.5*max(normal.y,0.0));
  var specular=vec3f(0);
  let moon=normalize(F.moon.xyz);
  let moonVis=0.1+0.9*visibility(p+normal*0.015,moon,20.0,h.index,softness*0.8);
  light+=vec3f(0.48,0.61,0.9)*F.moon.w*max(0.0,dot(normal,moon))*moonVis;
  for(var l=0;l<min(8,i32(F.options.x));l++){
    let pos=F.lights[l*3];let color=F.lights[l*3+1];let cone=F.lights[l*3+2];
    let delta=pos.xyz-p;let distance=length(delta);if(distance>=pos.w||color.w==0.0){continue;}
    let direction=delta/max(distance,0.001);var atten=pow(max(0.0,1.0-distance/pos.w),2.0)*color.w;
    if(cone.w>-1.0){atten*=smoothstep(cone.w-0.08,min(1.0,cone.w+0.14),dot(-direction,cone.xyz));}
    let vis=0.06+0.94*visibility(p+normal*0.015,direction,distance,h.index,softness);
    atten*=vis;
    light+=color.rgb*atten*max(0.0,dot(normal,direction));
    let halfway=normalize(direction-h.ray);specular+=color.rgb*atten*pow(max(0.0,dot(normal,halfway)),48.0)*select(0.06,0.3,h.index==9);
  }
  let cell=abs(fract(p.xz+0.5)-0.5);
  let lines=1.0-smoothstep(vec2f(0.015),vec2f(0.015)+aa,cell);
  let grid=select(1.0,1.0-0.28*max(lines.x,lines.y),h.index<0);
  var rgb=h.albedo*light*grid+specular;
  if(F.options.z==3.0){rgb=light;}
  if(F.options.z==5.0){rgb=normal*0.5+0.5;}
  return rgb;
}

struct Pixel {@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
@fragment fn fs(o:Out)->Pixel {
  let center=traceRay(o.uv);
  let pCenter=F.eye.xyz+center.ray*center.hit;
  let aa=max(fwidth(pCenter.xz),vec2f(0.001));
  let du=dpdx(o.uv);let dv=dpdy(o.uv);
  // Sections with sceneMode >= 4 supply their own floor mesh; keep the analytic y=0 grid out of their depth buffer.
  if(F.options.w>=4.0){var out:Pixel;out.color=vec4f(.025,.03,.04,1);out.depth=1.0;return out;}
  var rgb:vec3f;
  var farHit=center.hit;
  var farRay=center.ray;
  if(F.eye.w>0.5&&center.nearEdge){
    let h0=traceRay(o.uv-0.125*du-0.375*dv);
    let h1=traceRay(o.uv+0.375*du-0.125*dv);
    let h2=traceRay(o.uv-0.375*du+0.125*dv);
    let h3=traceRay(o.uv+0.125*du+0.375*dv);
    if(h0.hit>farHit){farHit=h0.hit;farRay=h0.ray;}
    if(h1.hit>farHit){farHit=h1.hit;farRay=h1.ray;}
    if(h2.hit>farHit){farHit=h2.hit;farRay=h2.ray;}
    if(h3.hit>farHit){farHit=h3.hit;farRay=h3.ray;}
    let sameSurface=h0.index==h1.index&&h0.index==h2.index&&h0.index==h3.index&&all(h0.normal==h1.normal)&&all(h0.normal==h2.normal)&&all(h0.normal==h3.normal);
    let count=select(4,1,sameSurface);
    var acc=vec3f(0.0);
    for(var s=0;s<count;s++){
      var h=center;
      if(count==4){
        if(s==0){h=h0;}else if(s==1){h=h1;}else if(s==2){h=h2;}else{h=h3;}
      }
      acc+=shadeSample(h,aa);
    }
    rgb=acc/f32(count);
  }else{
    if(center.index<0){
      let qTop=F.inverse*vec4f((o.uv-0.375*dv)*vec2f(2,-2)+vec2f(-1,1),1,1);
      let rTop=normalize(qTop.xyz/qTop.w-F.eye.xyz);
      let hitTop=select(10000.0,-F.eye.y/rTop.y,rTop.y<-1e-5);
      if(hitTop>farHit){farHit=hitTop;farRay=rTop;}
    }
    rgb=shadeSample(center,aa);
  }
  let clip=F.vp*vec4f(F.eye.xyz+farRay*farHit,1);
  var out:Pixel;out.color=vec4f(rgb,1);out.depth=min(1.0,clip.z/clip.w+2.5e-6);return out;
}
@group(1) @binding(0) var hdr:texture_2d<f32>;
@fragment fn post(o:Out)->@location(0) vec4f {
  let p=vec2i(o.uv*vec2f(textureDimensions(hdr)));var c=textureLoad(hdr,p,0).rgb;
  if(F.options.z==5.0){return vec4f(c,1);}
  c*=exp2(F.grade.x)*vec3f(1.0+F.grade.w*0.22,1.0,1.0-F.grade.w*0.22);
  c=mix(vec3f(dot(c,vec3f(0.2126,0.7152,0.0722))),c,F.grade.z);
  if(F.grade.y==0.0){c=c/(c+0.8);}
  if(F.grade.y==1.0){c=clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14),vec3f(0),vec3f(1));}
  let srgb=pow(max(c,vec3f(0)),vec3f(1.0/2.2));
  let dither=(fract(52.9829189*fract(dot(vec2f(p),vec2f(0.06711056,0.00583715))))-0.5)/255.0;
  return vec4f(clamp(srgb+dither,vec3f(0.0),vec3f(1.0)),1);
}
`
