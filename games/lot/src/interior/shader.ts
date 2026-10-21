/** Indirect fixture light, constrained to the lobby, connecting hall and corridor. */
export const interiorWgsl = /* wgsl */ `
fn lotIndoor(p: vec3f) -> f32 {
  return (1.0-smoothstep(21.6,22.2,p.z)) * smoothstep(-3.5,-3.0,p.z)
    * smoothstep(-55.0,-54.5,p.x) * (1.0-smoothstep(34.5,35.0,p.x))
    * (1.0-smoothstep(3.1,3.6,p.y));
}
fn lotBounce(p: vec3f, n: vec3f) -> vec3f {
  if(lotIndoor(p)<0.01 || N.interior.y<=0.0) { return vec3f(0.0); }
  let lobby=(1.0-smoothstep(8.6,9.1,abs(p.x)))*smoothstep(8.8,9.2,p.z);
  let corridor=1.0-smoothstep(1.4,1.8,abs(p.z));
  let link=(1.0-smoothstep(1.2,1.6,abs(p.x)))*smoothstep(1.2,1.8,p.z)*(1.0-smoothstep(8.8,9.2,p.z));
  var light=vec3f(0.0);
  for(var i=0u;i<u32(F.screen.z);i++) {
    let L=lights[i];
    // Only the ceiling fittings on this route; no flashlight or adjacent-room spill through partitions.
    if(L.pos.y<2.5 || L.pos.y>3.4 || L.cone.w>=5.0) { continue; }
    let room=select(0.0,lobby,abs(L.pos.x)<0.1 && L.pos.z>9.0 && L.pos.z<20.0)
      +select(0.0,corridor,abs(L.pos.z)<0.1)
      +select(0.0,link,abs(L.pos.x)<0.1 && L.pos.z>2.0 && L.pos.z<9.0);
    if(room<=0.0) { continue; }
    let delta=L.pos.xyz-p;
    let d=max(length(delta),0.05);
    let window=pow(clamp(1.0-pow(d/max(9.0,L.pos.w*2.2),4.0),0.0,1.0),2.0);
    let facing=0.4+0.6*max(dot(n,delta/d),0.0);
    light+=L.color.rgb*L.color.w*room*window*facing/(d*d+2.5);
  }
  return light*N.interior.y;
}
`
