/** Room-local fill from the warm lobby pool; no extra lights, no exterior light leak. */
export const interiorWgsl = /* wgsl */ `
fn lotIndoor(p: vec3f) -> f32 {
  return (1.0-smoothstep(21.6,22.2,p.z)) * smoothstep(-3.5,-3.0,p.z)
    * smoothstep(-55.0,-54.5,p.x) * (1.0-smoothstep(34.5,35.0,p.x))
    * (1.0-smoothstep(3.1,3.6,p.y));
}
fn lotBounce(p: vec3f, n: vec3f) -> vec3f {
  let lobby=(1.0-smoothstep(8.6,9.1,abs(p.x)))*smoothstep(8.8,9.2,p.z);
  let nearest=vec3f(clamp(p.x,-1.8,1.8),0.16,clamp(p.z,13.5,17.5));
  let d=nearest-p;
  let facing=max(dot(n,normalize(d+vec3f(0.0,0.0001,0.0))),0.0);
  return vec3f(0.22,0.18,0.10)*N.interior.y*lobby*(0.15+0.85*facing)/(1.0+dot(d,d)*0.18);
}
`
