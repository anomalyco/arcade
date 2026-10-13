export const volumeShader = /* wgsl */ `
struct Frame { inverse: mat4x4f, eye: vec4f, screen: vec4f, ambient: vec4f, boxes: array<vec4f, 8>, lights: array<vec4f, 16> }
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var field: texture_2d_array<f32>;
@group(0) @binding(2) var linear: sampler;
@group(0) @binding(3) var depth: texture_depth_multisampled_2d;
@group(0) @binding(4) var noise: texture_3d<f32>;
@group(0) @binding(5) var repeat: sampler;
@group(0) @binding(6) var jitter: texture_2d<f32>;
@group(0) @binding(7) var cloud: texture_2d<f32>;
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var o: Out; o.position = vec4f(p[i],0,1); o.uv = p[i] * vec2f(0.5,-0.5) + 0.5; return o;
}
fn unproject(uv: vec2f, d: f32) -> vec3f { let p = F.inverse * vec4f(uv * vec2f(2,-2) + vec2f(-1,1),d,1); return p.xyz / p.w; }
fn sceneDepth(uv: vec2f) -> f32 {
  let p = clamp(vec2i(uv * F.screen.xy),vec2i(0),vec2i(F.screen.xy)-1);
  return min(min(textureLoad(depth,p,0),textureLoad(depth,p,1)),min(textureLoad(depth,p,2),textureLoad(depth,p,3)));
}
fn density(p: vec3f) -> vec2f {
  var sum = vec2f(0);
  for (var s = 0; s < 4; s++) {
    let b = F.boxes[s*2]; let uv = (p.xz-b.xy)/b.z;
    if (any(uv <= vec2f(0)) || any(uv >= vec2f(1))) { continue; }
    let d = textureSampleLevel(field,linear,uv,s,0.0).r;
    if (d <= 0.001) { continue; }
    let ceiling = 2.65 + 0.55*sin(p.x*1.5-F.eye.w*0.3)*sin(p.z*1.2+F.eye.w*0.2);
    let y = p.y / ceiling;
    let amount = d * smoothstep(0.0,0.13,y) * (1.0-smoothstep(0.32,1.0,y));
    sum += vec2f(amount,amount*F.boxes[s*2+1].z);
  }
  return sum;
}
fn billow(p: vec3f) -> f32 {
  let q = p * 0.055 + vec3f(-F.eye.w*0.009,-F.eye.w*0.012,F.eye.w*0.005);
  let warp = vec3f(sin(q.z*8.0),cos(q.x*7.0),sin(q.y*9.0))*0.045;
  return textureSampleLevel(noise,repeat,q+warp,0.0).r*0.6 + textureSampleLevel(noise,repeat,q*2.3-warp,0.0).r*0.4;
}
@fragment fn march(o: Out) -> @location(0) vec4f {
  let surface = unproject(o.uv,sceneDepth(o.uv)); let ray = normalize(surface-F.eye.xyz);
  let near = max(0.0,(3.8-F.eye.y)/min(-0.0001,ray.y));
  let far = min(distance(surface,F.eye.xyz),(0.015-F.eye.y)/min(-0.0001,ray.y));
  if (far <= near) { return vec4f(0); }
  let stepSize = (far-near)/24.0;
  let j = textureLoad(jitter,vec2i(o.position.xy)%32,0).r;
  var trans = 1.0; var rgb = vec3f(0); var optical = 0.0;
  for (var i = 0; i < 24; i++) {
    let p = F.eye.xyz + ray*(near+(f32(i)+j)*stepSize);
    let sample = density(p); let base = sample.x;
    if (base < 0.002) { continue; }
    let b = billow(p);
    let erode = smoothstep(0.0, 0.18, base - (1.0 - b) * 0.11);
    let d = base * erode * smoothstep(0.22,0.72,b) * 2.8;
    let a = 1.0-exp(-d*stepSize); optical += d*stepSize;
    let sun = exp(-density(p+vec3f(0,0.65,0)).x*1.7);
    var light = F.ambient.rgb + vec3f(0.38,0.43,0.51)*sun;
    for (var l = 0; l < min(8,i32(F.screen.z)); l++) {
      let pos = F.lights[l*2]; let color = F.lights[l*2+1]; let delta = pos.xyz-p;
      let d2 = dot(delta,delta);
      if (d2 >= pos.w*pos.w) { continue; }
      let dist = sqrt(max(0.001,d2));
      let shade = exp(-density(p+delta/dist*0.65).x*0.75);
      light += color.rgb*color.w*pow(1.0-dist/pos.w,2.0)*shade;
    }
    light *= mix(1.0,0.14,clamp(sample.y/max(base,0.001),0.0,1.0));
    if (F.screen.w == 1.0) { light = vec3f(base,base*0.4,1.0-base); }
    if (F.screen.w == 2.0) { light = vec3f(optical*0.16,0.12,1.0-optical*0.12); }
    if (F.screen.w == 3.0) { light = light / max(0.01,d); }
    rgb += trans*a*light; trans *= 1.0-a;
    if (trans < 0.015) { break; }
  }
  if (F.screen.w == 4.0) {
    let p = F.eye.xyz+ray*((1.5-F.eye.y)/ray.y);
    for (var s = 0; s < 4; s++) {
      let b = F.boxes[s*2]; let uv = (p.xz-b.xy)/b.z;
      if (F.boxes[s*2+1].w > 0.0 && all(uv>vec2f(0)) && all(uv<vec2f(1)) && min(min(uv.x,uv.y),min(1.0-uv.x,1.0-uv.y))<0.006) { return vec4f(0.1,1,0.6,1); }
    }
  }
  return vec4f(rgb,1.0-trans);
}
@fragment fn upsample(o: Out) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(cloud)); let pixel = o.uv*size-0.5; let base = floor(pixel); let frac = fract(pixel);
  let centre = unproject(o.uv,sceneDepth(o.uv));
  var sum = vec4f(0); var weight = 0.0;
  for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let at = clamp(vec2i(base)+vec2i(x,y),vec2i(0),vec2i(size)-1); let uv = (vec2f(at)+0.5)/size;
    let neighbor = unproject(uv,sceneDepth(uv));
    let bilinear = select(1.0-frac.x,frac.x,x==1)*select(1.0-frac.y,frac.y,y==1);
    let w = max(0.00001,bilinear*exp(-abs(neighbor.y-centre.y)*12.0));
    sum += textureLoad(cloud,at,0)*w; weight += w;
  }}
  return sum/weight;
}
`
