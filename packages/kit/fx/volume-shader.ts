export const volumeShader = /* wgsl */ `
struct Frame { inverse: mat4x4f, eye: vec4f, screen: vec4f, ambient: vec4f, boxes: array<vec4f, 8>, lights: array<vec4f, 16>, shape: vec4f, motion: vec4f, advection: vec4f }
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
    let source = F.boxes[s*2+1]; let offset = p.xz-source.xy;
    // Travel is never shorter than Euclidean distance; retain a full filter footprint.
    if (source.w <= 0.0 || dot(offset,offset) > (b.w+0.71)*(b.w+0.71)) { continue; }
    if (any(uv <= vec2f(0)) || any(uv >= vec2f(1))) { continue; }
    // Geometry is independent from an empty gas cell. Never clip the interpolated front.
    let cell = clamp(vec2i(uv*48.0),vec2i(0),vec2i(47));
    let centre = textureLoad(field,cell,s,0);
    if (centre.g > 0.5) { continue; }
    // Wall-aware bilinear reconstruction: the diagonal tap must not connect two free
    // cells across touching solid corners, even when a distant door makes both reachable.
    let local = fract(uv*48.0)-0.5;
    let dir = select(vec2i(-1),vec2i(1),local>=vec2f(0));
    let x = textureLoad(field,clamp(cell+vec2i(dir.x,0),vec2i(0),vec2i(47)),s,0);
    let z = textureLoad(field,clamp(cell+vec2i(0,dir.y),vec2i(0),vec2i(47)),s,0);
    let diagonal = textureLoad(field,clamp(cell+dir,vec2i(0),vec2i(47)),s,0).r;
    let safeDiagonal = select(diagonal,0.0,x.g>0.5 || z.g>0.5);
    var d = mix(mix(centre.r,x.r,abs(local.x)),mix(z.r,safeDiagonal,abs(local.x)),abs(local.y));
    let soot = source.z;
    if (soot > 0.0) {
      let lifeU = clamp(source.w, 0.0, 1.0);
      let dist = length(offset);
      let radialU = clamp(dist / max(0.35, b.w), 0.0, 1.0);
      let lobe = 0.5 + 0.28 * sin(p.x * 1.9 + F.advection.x * 0.45) * cos(p.z * 1.8 - F.advection.z * 0.45) + 0.22 * sin((p.x - p.z) * 2.7 - F.eye.w * 1.1);
      d = d * smoothstep(0.0, 0.36 + 0.44 * lobe, d + 0.16 * (1.0 - radialU));
      let lift = pow(lifeU, 0.74) * F.motion.x * 2.6 * (1.0 - radialU * 0.42);
      let rawCeiling = (F.shape.x * (0.56 + 0.64 * pow(lifeU, 0.45)) * (1.18 - 0.48 * radialU * radialU) + lift * 0.48) * (0.86 + 0.14 * lobe);
      let ceiling = min(F.shape.x * 1.38, rawCeiling);
      let floorY = lift * (0.18 + 0.40 * radialU * radialU) * smoothstep(0.08, 0.58, lifeU);
      let y = clamp((p.y - floorY) / max(0.45, ceiling - floorY), 0.0, 1.5);
      // Pinch lower stem inward as the buoyant column rises while letting the upper mushroom cap roll wider.
      let capShape = mix(0.72, 1.12, smoothstep(0.18, 0.68, y));
      let stemPinch = 1.0 - smoothstep(0.65 * capShape, 1.05 * capShape, radialU) * smoothstep(0.10, 0.48, lifeU) * 0.45;
      let amount = d * stemPinch * smoothstep(0.0, 0.14, y) * (1.0 - smoothstep(0.34, 1.0, y));
      let shift = select(0.80, F.ambient.w, F.ambient.w > 0.001);
      // Shift from dark soot crust (t < 0.45s) into sculpted medium charcoal-grey by 0.8–1.2s and light ash-grey as it disperses.
      let ageShift = smoothstep(0.08, 0.72, lifeU);
      let dispersion = clamp((ageShift * 0.74 + radialU * 0.22 + clamp(y, 0.0, 1.0) * 0.24) * shift, 0.0, 0.90);
      let cool = clamp(1.0 - dispersion, 0.10, 1.0);
      sum += vec2f(amount, amount * soot * cool);
    } else {
      let ceiling = F.shape.x * (0.86 + 0.14*sin(p.x*1.5-F.eye.w*0.3)*sin(p.z*1.2+F.eye.w*0.2));
      let y = p.y / ceiling;
      let amount = d * smoothstep(0.0,0.13,y) * (1.0-smoothstep(0.32,1.0,y));
      sum += vec2f(amount,amount*soot);
    }
  }
  return sum;
}
fn densityFast(p: vec3f) -> f32 {
  var sum = 0.0;
  for (var s = 0; s < 4; s++) {
    let b = F.boxes[s*2]; let uv = (p.xz-b.xy)/b.z;
    let source = F.boxes[s*2+1]; let offset = p.xz-source.xy;
    if (source.w <= 0.0 || dot(offset,offset) > (b.w+0.71)*(b.w+0.71)) { continue; }
    if (any(uv <= vec2f(0)) || any(uv >= vec2f(1))) { continue; }
    let cell = clamp(vec2i(uv*48.0),vec2i(0),vec2i(47));
    let centre = textureLoad(field,cell,s,0);
    if (centre.g > 0.5) { continue; }
    let y = p.y / max(0.8, F.shape.x * 1.15);
    sum += centre.r * smoothstep(0.0, 0.14, y) * (1.0 - smoothstep(0.34, 1.0, y));
  }
  return sum;
}
fn billow(p: vec3f) -> f32 {
  let q = (p + F.advection.xyz) * (0.035 / F.shape.y);
  let warp = vec3f(sin(q.z*8.0),cos(q.x*7.0),sin(q.y*9.0))*0.054*F.motion.z;
  return textureSampleLevel(noise,repeat,q+warp,0.0).r*0.65 + textureSampleLevel(noise,repeat,q*2.13-warp,0.0).r*0.35;
}
@fragment fn march(o: Out) -> @location(0) vec4f {
  let surface = unproject(o.uv,sceneDepth(o.uv)); let ray = normalize(surface-F.eye.xyz);
   // Intersect the actual height slab in either ray direction (including cameras inside it).
   if (abs(ray.y) < 0.00001) { return vec4f(0); }
   let a = (F.shape.x*1.42-F.eye.y)/ray.y; let b = (0.015-F.eye.y)/ray.y;
   let slabNear = max(0.0,min(a,b));
   let slabFar = min(distance(surface,F.eye.xyz),max(a,b));
  if (slabFar <= slabNear) { return vec4f(0); }
  if (F.screen.w == 4.0) {
    let p = F.eye.xyz+ray*((1.5-F.eye.y)/ray.y);
    for (var s = 0; s < 4; s++) {
      let bBox = F.boxes[s*2]; let uv = (p.xz-bBox.xy)/bBox.z;
      if (F.boxes[s*2+1].w > 0.0 && all(uv>vec2f(0)) && all(uv<vec2f(1)) && min(min(uv.x,uv.y),min(1.0-uv.x,1.0-uv.y))<0.006) { return vec4f(0.1,1,0.6,1); }
    }
  }
  // Tighten [near, far] to the union of active 3D volume bounding boxes and early-out rays that miss all volumes.
  let invRayXZ = 1.0 / select(ray.xz, vec2f(0.00001), abs(ray.xz) < vec2f(0.00001));
  var volNear = 1e9;
  var volFar = -1e9;
  for (var s = 0; s < 4; s++) {
    let src = F.boxes[s*2+1];
    if (src.w <= 0.0) { continue; }
    let bBox = F.boxes[s*2];
    let rad = bBox.w + 0.72;
    let minXZ = max(bBox.xy, src.xy - vec2f(rad));
    let maxXZ = min(bBox.xy + vec2f(bBox.z), src.xy + vec2f(rad));
    let t0 = (minXZ - F.eye.xz) * invRayXZ;
    let t1 = (maxXZ - F.eye.xz) * invRayXZ;
    let tMin = max(min(t0.x, t1.x), min(t0.y, t1.y));
    let tMax = min(max(t0.x, t1.x), max(t0.y, t1.y));
    if (tMax > max(0.0, tMin)) {
      volNear = min(volNear, tMin);
      volFar = max(volFar, tMax);
    }
  }
  let near = max(slabNear, volNear);
  let far = min(slabFar, volFar);
  if (far <= near) { return vec4f(0); }
  let steps = select(18, 14, far - near < 5.5);
  let stepSize = (far-near)/f32(steps);
  let j = textureLoad(jitter,vec2i(o.position.xy)%32,0).r;
  var trans = 1.0; var rgb = vec3f(0); var optical = 0.0;
  for (var i = 0; i < 18; i++) {
    if (i >= steps) { break; }
    let p = F.eye.xyz + ray*(near+(f32(i)+j)*stepSize);
    let sample = density(p); let base = sample.x;
    if (base < 0.002) { continue; }
    let bVal = billow(p);
    let isSoot = sample.y > 0.0005;
    let edgeErode = select(
      mix(0.75,smoothstep(0.22,0.72,bVal),F.motion.z),
      smoothstep(clamp(0.44 - base * 0.66, 0.02, 0.42) * clamp(F.motion.z, 0.1, 1.4), 0.76, bVal),
      isSoot
    );
    let d = base * edgeErode * F.shape.z;
    if (d < 0.002) { continue; }
    let a = 1.0-exp(-d*stepSize); optical += d*stepSize;
    let sun = exp(-densityFast(p+vec3f(0,0.65,0))*select(1.7,2.1,isSoot));
    var baseLight = F.ambient.rgb + vec3f(0.40,0.45,0.54)*sun*F.shape.w;
    var ptLight = vec3f(0);
    let localShade = exp(-base * select(0.42, 0.92, isSoot)) * (0.52 + 0.48 * sun);
    for (var l = 0; l < min(8,i32(F.screen.z)); l++) {
      let pos = F.lights[l*2]; let color = F.lights[l*2+1]; let delta = pos.xyz-p;
      let d2 = dot(delta,delta);
      if (d2 >= pos.w*pos.w) { continue; }
      let dist = sqrt(max(0.001,d2));
      ptLight += color.rgb*color.w*pow(1.0-dist/pos.w,2.0)*localShade*F.shape.w;
    }
    var light = baseLight + select(ptLight, ptLight / (vec3f(1.0) + ptLight * 0.58), isSoot);
    let sootRatio = clamp(sample.y/max(base,0.001),0.0,1.0);
    if (isSoot) {
      let ridge = smoothstep(0.22, 0.78, bVal) * (0.28 + 0.72 * clamp(p.y / max(0.8, F.shape.x), 0.0, 1.0));
      let darkTint = vec3f(0.056, 0.052, 0.049);
      let warmMid = vec3f(0.34, 0.32, 0.30);
      let ashLight = vec3f(0.84, 0.88, 0.94);
      let tone = clamp(sootRatio * 1.32 * (1.0 - ridge * 0.52), 0.0, 1.0);
      let smokeTint = mix(mix(ashLight, warmMid, clamp(tone * 1.68, 0.0, 1.0)), darkTint, smoothstep(0.34, 0.86, tone));
      light *= smokeTint;
      let glowScale = select(1.0, F.motion.w, F.motion.w > 0.001);
      for (var s = 0; s < 4; s++) {
        let src = F.boxes[s*2+1];
        if (src.z > 0.0 && src.w > 0.0 && src.w < 0.22) {
          let heatLife = pow(max(0.0, 1.0 - src.w / 0.22), 1.85);
          let distCore = length(vec3f(p.x - src.x, (p.y - 0.85) * 0.82, p.z - src.y));
          let coreScatter = exp(-distCore * 1.18) * heatLife * glowScale * 0.62 * (1.0 - bVal * 0.58);
          light += vec3f(2.0, 0.44, 0.04) * coreScatter;
        }
      }
    } else {
      light *= mix(1.0,0.14,sootRatio);
    }
    if (F.screen.w == 1.0) { light = vec3f(base,base*0.4,1.0-base); }
    if (F.screen.w == 2.0) { light = vec3f(optical*0.16,0.12,1.0-optical*0.12); }
    if (F.screen.w == 3.0) { light = light / max(0.01,d); }
    rgb += trans*a*light; trans *= 1.0-a;
    if (trans < 0.015) { break; }
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
