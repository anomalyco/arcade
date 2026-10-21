/** Downward rectangular Lambertian emitter. Dimensions are half-extents in metres; yaw rotates X toward Z. */
export type RectEmitter = { halfWidth: number; halfLength: number; yaw?: number }

/** The negative tag is separate from plan cones, spots, beams, capsules and street lenses. */
export function rectCone(rect: RectEmitter): [number, number, number, number] {
  const { halfWidth: x, halfLength: z, yaw = 0 } = rect
  if (![x, z, yaw].every(Number.isFinite) || x <= 0 || z <= 0) throw Error("Rectangular emitter needs finite positive half-extents")
  return [x, z, yaw, -3]
}

export const rectEmitterWgsl = /* wgsl */ `
fn rectBasis(yaw:f32)->mat2x2f { return mat2x2f(cos(yaw),sin(yaw),-sin(yaw),cos(yaw)); }
// Exact polygon irradiance: clip to the receiver's horizon, then integrate each spherical edge.
// Returns irradiance per unit on-axis intensity. A far-away panel tends to cos(receiver)*cos(emitter)/distance².
fn rectIrradiance(center:vec3f, halfSize:vec2f, yaw:f32, p:vec3f, n:vec3f)->f32 {
  if(p.y>=center.y) { return 0.0; }
  let basis=rectBasis(yaw);
  let u=vec3f(basis[0].x,0.0,basis[0].y)*halfSize.x;
  let v=vec3f(basis[1].x,0.0,basis[1].y)*halfSize.y;
  let d=center-p;
  let corners=array<vec3f,4>(d-u-v,d-u+v,d+u+v,d+u-v);
  var polygon:array<vec3f,6>;
  var count=0u;
  for(var k=0u;k<4u;k++) {
    let a=corners[k]; let b=corners[(k+1u)%4u];
    let da=dot(a,n); let db=dot(b,n);
    if(da>0.0) { polygon[count]=a; count++; }
    if((da>0.0)!=(db>0.0)) { polygon[count]=mix(a,b,da/(da-db)); count++; }
  }
  if(count<3u) { return 0.0; }
  var integral=vec3f(0.0);
  for(var k=0u;k<count;k++) {
    let a=normalize(polygon[k]); let b=normalize(polygon[(k+1u)%count]);
    let c=cross(a,b); let s=length(c);
    integral+=c*(atan2(s,clamp(dot(a,b),-1.0,1.0))/max(s,1e-7));
  }
  return max(dot(integral,n),0.0)/(8.0*halfSize.x*halfSize.y);
}
/** Representative point for the shared GGX lobe. The reflected footprint follows the rectangle rather than a sphere. */
fn rectMirrorPoint(center:vec3f,halfSize:vec2f,yaw:f32,p:vec3f,ray:vec3f)->vec3f {
  let basis=rectBasis(yaw);
  let t=(center.y-p.y)/max(ray.y,1e-5);
  let hit=p.xz+ray.xz*max(t,0.0)-center.xz;
  let q=clamp(transpose(basis)*hit,-halfSize,halfSize);
  let xz=center.xz+basis*q;
  return vec3f(xz.x,center.y,xz.y);
}
`

type Vec3 = readonly [number, number, number]
const dot = (a: Vec3, b: Vec3) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
const cross = (a: Vec3,b: Vec3): Vec3 => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
/** CPU mirror for deterministic checks against a numerical area integral. */
export function rectIrradiance(center: Vec3, rect: RectEmitter, p: Vec3, n: Vec3): number {
  rectCone(rect)
  if(p[1]>=center[1]) return 0
  const c=Math.cos(rect.yaw??0),s=Math.sin(rect.yaw??0)
  const corners: Vec3[]=[[-1,-1],[-1,1],[1,1],[1,-1]].map(([x,z])=>{
    const u=x!*rect.halfWidth,v=z!*rect.halfLength
    return [center[0]-p[0]+c*u-s*v,center[1]-p[1],center[2]-p[2]+s*u+c*v]
  })
  const polygon:Vec3[]=[]
  for(let i=0;i<4;i++) {
    const a=corners[i]!,b=corners[(i+1)%4]!,da=dot(a,n),db=dot(b,n)
    if(da>0) polygon.push(a)
    if((da>0)!==(db>0)) polygon.push(a.map((v,k)=>v+(b[k]!-v)*da/(da-db)) as unknown as Vec3)
  }
  let sum=0
  for(let i=0;i<polygon.length;i++) {
    const norm=(v:Vec3)=>v.map(x=>x/Math.hypot(...v)) as unknown as Vec3
    const a=norm(polygon[i]!),b=norm(polygon[(i+1)%polygon.length]!),v=cross(a,b),l=Math.hypot(...v)
    sum+=dot(v,n)*Math.atan2(l,Math.max(-1,Math.min(1,dot(a,b))))/Math.max(l,1e-7)
  }
  return Math.max(sum,0)/(8*rect.halfWidth*rect.halfLength)
}
