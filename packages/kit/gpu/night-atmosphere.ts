/** Shared outdoor height-fog, light-pollution sky and finite lamp scattering, in linear HDR.
 * `common` (gpu/shaders) supplies noise2/fbm. No game coordinates are embedded here. */
export const nightAtmosphere = /* wgsl */ `
fn nightSky(ray: vec3f, strength: f32) -> vec3f {
  let horizon = exp(-max(ray.y, 0.0) * 6.0);
  let cloud = fbm(ray.xz * 5.0 / max(0.2, ray.y + 0.45));
  return mix(vec3f(0.0015, 0.003, 0.006), vec3f(0.019, 0.024, 0.028), horizon) * (0.7 + cloud * 0.45) * strength;
}
fn heightFog(eye: vec3f, point: vec3f, density: f32, falloff: f32) -> f32 {
  let delta = point - eye;
  // Only descending rays need an overflow bound. Capping positive t makes long
  // upward rays accumulate extra fog instead of converging to density/falloff.
  let t = max(delta.y * falloff, -30.0);
  // Taylor limit at horizontal rays; avoids the zero-over-zero horizon seam.
  var integral = 1.0 - t * 0.5;
  if (abs(t) > 0.001) { integral = (1.0 - exp(-t)) / t; }
  return 1.0 - exp(-density * length(delta) * exp(-max(eye.y, 0.0) * falloff) * integral);
}
fn lampScatter(eye: vec3f, point: vec3f, lamp: vec3f, radius: f32) -> f32 {
  let delta = point - eye;
  let distance = length(delta);
  let ray = delta / max(distance, 0.001);
  let along = clamp(dot(lamp - eye, ray), 0.0, distance);
  let separation = length(eye + ray * along - lamp);
  return exp(-separation * separation / (radius * radius)) * (1.0 - exp(-distance * 0.05));
}
// Equiangular single scattering: inverse-square attenuation cancels the sampling PDF.
// cone = (cos outer angle, cos inner angle, side-leak fraction, beam length in metres).
fn downlightScatter(eye: vec3f, point: vec3f, lamp: vec3f, range: f32, cone: vec4f, radius: f32, g: f32) -> f32 {
  let delta=point-eye;
  let distance=length(delta);
  let ray=delta/max(distance,0.001);
  let toLamp=lamp-eye;
  let s0=dot(toLamp,ray);
  let h=max(sqrt(max(dot(toLamp,toLamp)-s0*s0,0.0)),0.03);
  let a=max(s0-range,0.0);
  let b=min(s0+range,distance);
  if(b<=a) { return 0.0; }
  let ta=atan((a-s0)/h);
  let tb=atan((b-s0)/h);
  var sum=0.0;
  for(var j=0;j<4;j++) {
    let t=mix(ta,tb,(f32(j)+0.5)/4.0);
    let sv=s0+h*tan(t);
    let lx=ray*sv-toLamp;
    let ld=max(length(lx),0.001);
    let ln=lx/ld;
    let aim=smoothstep(cone.x,cone.y,-ln.y)*(1.0-cone.z)+cone.z;
    let win=pow(clamp(1.0-pow(ld/range,4.0),0.0,1.0),2.0)*smoothstep(0.0,radius,ld)*exp(-ld/cone.w);
    let cosT=-dot(ln,ray);
    let hg=(1.0-g*g)/pow(max(1.0+g*g-2.0*g*cosT,0.0001),1.5);
    sum+=aim*win*mix(1.0,hg,0.85)/(4.0*3.14159265);
  }
  return sum*(tb-ta)/(h*4.0);
}
`
