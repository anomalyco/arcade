/**
 * Upright rectangular Lambertian emitter: a lit screen, a window or a light box standing on its edge. It faces
 * `(cos yaw, 0, sin yaw)` and emits only on that side; dimensions are half-extents in metres. `power` is the on-axis
 * intensity (radiance × area), as for the downward `RectEmitter`.
 */
export type PanelEmitter = { halfWidth: number; halfHeight: number; yaw: number }

/** The negative tag is separate from plan cones, spots, beams, capsules, street lenses and downward panels (−3). */
export function panelCone(panel: PanelEmitter): [number, number, number, number] {
  const { halfWidth: x, halfHeight: y, yaw } = panel
  if (![x, y, yaw].every(Number.isFinite) || x <= 0 || y <= 0) throw Error("Panel emitter needs finite positive half-extents")
  return [x, y, yaw, -4]
}

export const panelEmitterWgsl = /* wgsl */ `
fn panelNormal(yaw:f32)->vec3f { return vec3f(cos(yaw),0.0,sin(yaw)); }
// Exact polygon irradiance from the panel's front: clip it to the receiver's horizon, then integrate each spherical
// edge. Per unit on-axis intensity; far away it tends to cos(receiver)*cos(emitter)/distance².
fn panelIrradiance(center:vec3f, halfSize:vec2f, yaw:f32, p:vec3f, n:vec3f)->f32 {
  let nz=panelNormal(yaw);
  if(dot(p-center,nz)<=0.0) { return 0.0; }
  let u=vec3f(-nz.z,0.0,nz.x)*halfSize.x;
  let v=vec3f(0.0,halfSize.y,0.0);
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
  return abs(dot(integral,n))/(8.0*halfSize.x*halfSize.y);
}
/** Representative point for the shared GGX lobe: where the mirror ray meets the panel, clamped to its face. */
fn panelMirrorPoint(center:vec3f,halfSize:vec2f,yaw:f32,p:vec3f,ray:vec3f)->vec3f {
  let nz=panelNormal(yaw);
  let ax=vec3f(-nz.z,0.0,nz.x);
  let facing=dot(ray,nz);
  let t=select(0.0,dot(center-p,nz)/min(facing,-1e-5),facing<-1e-5);
  let hit=p+ray*max(t,0.0)-center;
  let q=clamp(vec2f(dot(hit,ax),hit.y),-halfSize,halfSize);
  return center+ax*q.x+vec3f(0.0,q.y,0.0);
}
`

type Vec3 = readonly [number, number, number]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** CPU mirror of `panelIrradiance`, for deterministic checks against a numerical area integral. */
export function panelIrradiance(center: Vec3, panel: PanelEmitter, p: Vec3, n: Vec3): number {
  panelCone(panel)
  const nz: Vec3 = [Math.cos(panel.yaw), 0, Math.sin(panel.yaw)]
  if (dot([p[0] - center[0], p[1] - center[1], p[2] - center[2]], nz) <= 0) return 0
  const u: Vec3 = [-nz[2] * panel.halfWidth, 0, nz[0] * panel.halfWidth]
  const corners: Vec3[] = [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([a, b]) => [
    center[0] - p[0] + u[0] * a!, center[1] - p[1] + panel.halfHeight * b!, center[2] - p[2] + u[2] * a!,
  ])
  const polygon: Vec3[] = []
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!, b = corners[(i + 1) % 4]!, da = dot(a, n), db = dot(b, n)
    if (da > 0) polygon.push(a)
    if ((da > 0) !== (db > 0)) polygon.push(a.map((v, k) => v + (b[k]! - v) * da / (da - db)) as unknown as Vec3)
  }
  let sum = 0
  const norm = (v: Vec3) => v.map(x => x / Math.hypot(...v)) as unknown as Vec3
  for (let i = 0; i < polygon.length; i++) {
    const a = norm(polygon[i]!), b = norm(polygon[(i + 1) % polygon.length]!), v = cross(a, b), l = Math.hypot(...v)
    sum += dot(v, n) * Math.atan2(l, Math.max(-1, Math.min(1, dot(a, b)))) / Math.max(l, 1e-7)
  }
  return Math.abs(sum) / (8 * panel.halfWidth * panel.halfHeight)
}
