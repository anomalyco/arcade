const common = /* wgsl */ `
struct Frame {
  inverse:mat4x4f, vp:mat4x4f, eye:vec4f,
  options:vec4f, moon:vec4f, grade:vec4f, ambient:vec4f,
  lights:array<vec4f,24>
}
@group(0) @binding(0) var<uniform> F:Frame;
struct Box { lo:vec3f, hi:vec3f }
const boxes=array<Box,9>(
  Box(vec3f(-6,0,-4),vec3f(6,2.2,-3.6)),Box(vec3f(-6,0,-4),vec3f(-5.6,2.2,5)),
  Box(vec3f(5.6,0,-4),vec3f(6,2.2,-1)),Box(vec3f(5.6,0,1),vec3f(6,2.2,5)),Box(vec3f(-6,0,4.6),vec3f(6,0.65,5)),
  Box(vec3f(-3.5,0.2,-0.8),vec3f(-0.5,0.85,0.8)),Box(vec3f(-2.7,0.85,-0.65),vec3f(-1.1,1.4,0.65)),
  Box(vec3f(2.5,0,0.7),vec3f(3,1.3,1.2)),Box(vec3f(2.55,1.3,0.75),vec3f(2.95,1.7,1.15)));
fn intersect(origin:vec3f,ray:vec3f,b:Box)->f32 {
  let safe=select(vec3f(0.000001),ray,abs(ray)>vec3f(0.000001));
  let a=(b.lo-origin)/safe;let c=(b.hi-origin)/safe;let lo=min(a,c);let hi=max(a,c);
  let near=max(max(lo.x,lo.y),lo.z);let far=min(min(hi.x,hi.y),hi.z);
  return select(10000.0,max(near,0.0),near<far&&far>0.0);
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
    let box=boxes[b];let a=(box.lo.xz-origin)/safe;let c=(box.hi.xz-origin)/safe;
    let lo=min(a,c);let hi=max(a,c);let near=max(0.0,max(lo.x,lo.y));let far=min(hi.x,hi.y);
    polar[(light*256u+bin)*9u+b]=select(vec4f(10000,10000,0,0),vec4f(near,far,box.lo.y,box.hi.y),near<far&&far>0.0);
  }
}
`

export const stageShader = common + /* wgsl */ `
@group(0) @binding(1) var<storage,read> polar:array<vec4f>;
struct Out {@builtin(position) p:vec4f,@location(0) uv:vec2f}
@vertex fn vs(@builtin(vertex_index)i:u32)->Out {let c=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.p=vec4f(c[i],0,1);o.uv=c[i]*vec2f(0.5,-0.5)+0.5;return o;}
fn visibility(p:vec3f,l:i32,surface:i32)->f32 {
  if(F.options.y<0.5){return 1.0;}
  let source=F.lights[l*3];let delta=p-source.xyz;let distance=max(0.001,length(delta.xz));
  let angle=atan2(delta.z,delta.x);let bin=i32(fract(angle/6.2831853+1.0)*256.0);
  var sum=0.0;
  for(var tap=-1;tap<=1;tap++){
    let at=(bin+tap+256)%256;var lit=1.0;
    for(var b=0;b<9;b++){
      // Convex receiver cannot occlude itself; angular quantization otherwise stripes wall faces.
      if(b==surface){continue;}
      let interval=polar[(l*256+at)*9+b];let end=min(interval.y,distance-0.06);
      if(interval.x>=end){continue;}
      let h0=source.y+delta.y*interval.x/distance;let h1=source.y+delta.y*end/distance;
      if(min(h0,h1)<interval.w-0.015&&max(h0,h1)>interval.z+0.015){lit=0.06;break;}
    }
    sum+=lit;
  }
  return sum/3.0;
}
struct Pixel {@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
@fragment fn fs(o:Out)->Pixel {
  let q=F.inverse*vec4f(o.uv*vec2f(2,-2)+vec2f(-1,1),1,1);let ray=normalize(q.xyz/q.w-F.eye.xyz);
  var hit=-F.eye.y/ray.y;var index=-1;
  for(var i=0;i<9;i++){let d=intersect(F.eye.xyz,ray,boxes[i]);if(d<hit){hit=d;index=i;}}
  // Neutral calibration sphere in Lighting/Materials. Material adapters replace the latter with their own meshes.
  if(F.options.w==1.0||F.options.w==2.0){let d=sphere(F.eye.xyz,ray,vec3f(1.3,0.85,-1.8),0.85);if(d<hit){hit=d;index=9;}}
  let p=F.eye.xyz+ray*hit;var normal=vec3f(0,1,0);var albedo=vec3f(0.18,0.21,0.26);
  if(index>=0&&index<9){let b=boxes[index];let mid=(b.lo+b.hi)*0.5;let r=(p-mid)/((b.hi-b.lo)*0.5);let m=max(max(abs(r.x),abs(r.y)),abs(r.z));normal=normalize(select(vec3f(0),sign(r),abs(r)>=vec3f(m-0.002)));albedo=vec3f(0.3,0.34,0.38);if(index==5){albedo=vec3f(0.06,0.22,0.26);}if(index==6){albedo=vec3f(0.035,0.08,0.11);}if(index>=7){albedo=vec3f(0.42,0.32,0.17);}}
  if(index==9){normal=normalize(p-vec3f(1.3,0.85,-1.8));albedo=vec3f(0.5);}
  var light=F.ambient.rgb*(0.5+0.5*max(normal.y,0.0));
  var specular=vec3f(0);
  let moon=normalize(F.moon.xyz);var moonVisibility=1.0;
  if(F.options.y>0.5){for(var b=0;b<9;b++){if(intersect(p+normal*0.04,moon,boxes[b])<1000.0){moonVisibility=0.1;break;}}}
  light+=vec3f(0.48,0.61,0.9)*F.moon.w*max(0.0,dot(normal,moon))*moonVisibility;
  for(var l=0;l<min(8,i32(F.options.x));l++){
    let pos=F.lights[l*3];let color=F.lights[l*3+1];let cone=F.lights[l*3+2];
    let delta=pos.xyz-p;let distance=length(delta);if(distance>=pos.w||color.w==0.0){continue;}
    let direction=delta/max(distance,0.001);var atten=pow(max(0.0,1.0-distance/pos.w),2.0)*color.w;
    if(cone.w>-1.0){atten*=smoothstep(cone.w,min(1.0,cone.w+0.08),dot(-direction,cone.xyz));}
    atten*=visibility(p+normal*0.04,l,index);
    light+=color.rgb*atten*max(0.0,dot(normal,direction));
    let halfway=normalize(direction-ray);specular+=color.rgb*atten*pow(max(0.0,dot(normal,halfway)),48.0)*select(0.06,0.3,index==9);
  }
  let cell=abs(fract(p.xz+0.5)-0.5);let aa=max(fwidth(p.xz),vec2f(0.001));
  let lines=1.0-smoothstep(vec2f(0.015),vec2f(0.015)+aa,cell);
  let grid=select(1.0,1.0-0.28*max(lines.x,lines.y),index<0);
  var rgb=albedo*light*grid+specular;
  // Visible fixture cores locate the adjustable lights in world space.
  for(var l=0;l<min(8,i32(F.options.x));l++){
    let pos=F.lights[l*3];let color=F.lights[l*3+1];let lamp=sphere(F.eye.xyz,ray,pos.xyz,0.12);
    if(lamp<hit){rgb=color.rgb*color.w;hit=lamp;normal=normalize(F.eye.xyz+ray*hit-pos.xyz);}
  }
  if(F.options.z==3.0){rgb=light;}
  if(F.options.z==5.0){rgb=normal*0.5+0.5;}
  let clip=F.vp*vec4f(F.eye.xyz+ray*hit,1);var out:Pixel;out.color=vec4f(rgb,1);out.depth=clip.z/clip.w;return out;
}
@group(1) @binding(0) var hdr:texture_2d<f32>;
@fragment fn post(o:Out)->@location(0) vec4f {
  let p=vec2i(o.uv*vec2f(textureDimensions(hdr)));var c=textureLoad(hdr,p,0).rgb;
  if(F.options.z==5.0){return vec4f(c,1);}
  c*=exp2(F.grade.x)*vec3f(1.0+F.grade.w*0.22,1.0,1.0-F.grade.w*0.22);
  c=mix(vec3f(dot(c,vec3f(0.2126,0.7152,0.0722))),c,F.grade.z);
  if(F.grade.y==0.0){c=c/(c+0.8);}
  if(F.grade.y==1.0){c=clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14),vec3f(0),vec3f(1));}
  return vec4f(pow(max(c,vec3f(0)),vec3f(1.0/2.2)),1);
}
`
