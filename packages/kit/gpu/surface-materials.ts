/** Opt-in matte outdoor finishes. Games assign materials/palettes; existing shaders stay identical. */
export const surfaceMaterialDeclarations = /* wgsl */ `
var<private> surfaceFootprint: f32;
// Four distinct lattice corners. Kept separate from the legacy material noise to preserve its look.
fn surfaceNoise(p:vec2f) -> f32 {
  let i=floor(p); let f=fract(p); let u=f*f*(3.0-2.0*f);
  return mix(mix(hash2(i),hash2(i+vec2f(1.0,0.0)),u.x),mix(hash2(i+vec2f(0.0,1.0)),hash2(i+vec2f(1.0,1.0)),u.x),u.y);
}
fn surfaceFbm(p:vec2f) -> f32 {
  return surfaceNoise(p)*.5+surfaceNoise(p*2.03+7.1)*.3+surfaceNoise(p*4.1+3.7)*.2;
}
fn seam(q: f32, width: f32, frequency: f32) -> f32 {
  let d = abs(fract(q + 0.5) - 0.5);
  let aa = max(surfaceFootprint * frequency, 0.002);
  return smoothstep(width - aa, width + aa, d);
}
fn grain(p: vec2f, frequency: f32) -> f32 {
  let fade = 1.0 - smoothstep(0.35, 1.0, surfaceFootprint * frequency);
  return (surfaceNoise(p * frequency) - 0.5) * fade;
}
`
export const surfaceMaterial = /* wgsl */ `
    if (mat == 20) {
      let kind = i32(round(o.aux));
      let p = o.world.xz;
      if (kind == 0) {
        let patches = smoothstep(0.35, 0.7, surfaceFbm(p * 0.7));
        albedo = mix(albedo * vec3f(0.83,0.91,0.65), vec3f(0.19,0.155,0.10), patches * 0.6);
        albedo *= 0.90 + 0.16 * surfaceNoise(p*2.0) + grain(p, 12.0)*0.45;
      } else if (kind == 1) {
        albedo *= 0.90 + grain(p, 14.0)*0.28 + surfaceNoise(p*2.0)*.10;
      } else if (kind == 2) {
        albedo *= .92 + grain(p,28.0)*.15;
        albedo *= mix(.67,1.0,seam(p.x/1.6,.004,.625)*seam(p.y/1.6,.004,.625));
      } else if (kind == 3) {
        albedo *= .7 + grain(p,18.0)*.7 + surfaceNoise(p*3.0)*.4;
      } else {
        let row=floor(p.y/.18);
        albedo *= .93 + .12*hash2(vec2f(row,floor((p.x+row*.37)/1.8)));
        albedo *= mix(.86,1.0,seam(p.y/.18,.018,5.55));
        albedo *= 1.0 + grain(vec2f(p.x*.15,p.y),65.0)*.18;
      }
      gloss = vec2f(0.0);
    }
    if (mat == 4 && o.aux > 19.5) {
      albedo *= mix(.72,1.0,seam(o.world.y/.18,.025,5.55));
      albedo *= .96 + grain(vec2f(o.world.x+o.world.z,o.world.y*4.0),12.0)*.12;
    }
    if (mat == 21) {
      let row=floor(o.world.z/.24);
      let q=vec2f(o.world.x/.36+fract(row*.5),o.world.z/.24);
      albedo *= .82+.3*hash2(floor(q));
      albedo *= mix(.55,1.0,seam(q.x,.018,2.77)*seam(q.y,.035,4.16));
      albedo *= 1.0+grain(o.world.xz,70.0)*.12;
    }
    if (mat == 23) {
      let p=vec2f(o.world.x+o.world.z,o.world.y);
      let row=floor(p.y/.085);
      let q=vec2f(p.x/.25+fract(row*.5),p.y/.085);
      albedo=mix(vec3f(.32,.30,.26),albedo*(.8+.35*hash2(floor(q))),seam(q.x,.025,4.0)*seam(q.y,.06,11.76));
    }
    if (mat == 22) { albedo *= .72+surfaceNoise(o.world.xz*4.0+o.world.y)*.38; }
    if (mat == 24) { albedo *= .82+surfaceNoise(vec2f(o.world.x+o.world.z,o.world.y*.15)*35.0)*.25; }
`
