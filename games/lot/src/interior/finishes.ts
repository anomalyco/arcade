/** Authored wear on metre-scaled surfaces. Large stains are continuous; texture mipmaps carry the fine grain. */
export const finishWgsl = /* wgsl */ `
fn finishHash(p:vec2f)->f32 { return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453); }
fn finishNoise(p:vec2f)->f32 {
  let i=floor(p); let f=fract(p); let u=f*f*(3.0-2.0*f);
  return mix(mix(finishHash(i),finishHash(i+vec2f(1.0,0.0)),u.x),mix(finishHash(i+vec2f(0.0,1.0)),finishHash(i+vec2f(1.0)),u.x),u.y);
}
fn finishStain(p:vec2f)->f32 {
  let m=finishNoise(p*0.9)*0.65+finishNoise(p*2.7)*0.25+finishNoise(p*7.1)*0.1;
  return smoothstep(0.48,0.73,m);
}
`

export const finishMaterial = /* wgsl */ `
    let finish=i32(round(o.aux));
    if(mat!=3 && finish>=101 && finish<=106) {
      let p=o.world;
      let wear=N.finish.x;
      let s=finishStain(p.xz+vec2f(17.1,9.3));
      if(finish==105) {
        let cell=floor((p.xz-vec2f(0.3,0.6))/vec2f(0.6,1.2));
        let variation=finishHash(cell);
        let damp=finishStain(p.xz*0.63+vec2f(3.2,9.7));
        let tide=smoothstep(0.12,0.2,damp)*(1.0-smoothstep(0.25,0.42,damp));
        let speckle=smoothstep(0.55,0.75,finishNoise(p.xz*42.0));
        let grainFade=1.0-smoothstep(0.015,0.06,wetFootprint);
        albedo*=mix(vec3f(1.0),vec3f(0.70,0.57,0.36),damp*wear*0.8);
        albedo*=1.0-wear*(0.14*variation+0.27*tide+speckle*grainFade*0.28);
        pbrRough=0.92;
      } else if(finish==101 || finish==102) {
        let stain=finishStain(p.xz*1.7+vec2f(51.0,8.2));
        albedo*=mix(vec3f(1.0),vec3f(0.72,0.65,0.51),wear*stain*0.35);
        if(finish==101) {
          let cell=p.xz/0.6;
          let edge=abs(fract(cell)-0.5);
          let aa=max(wetFootprint/0.6,0.0001);
          let seam=smoothstep(0.5-0.004/0.6-aa,0.5-0.004/0.6+aa,max(edge.x,edge.y));
          albedo*=1.0-seam*0.36;
          albedo*=0.96+0.08*finishHash(floor(cell));
        }
        // Wax is a polished dielectric, with dull scuffed patches rather than outdoor puddle ripples.
        pbrRough=mix(pbrRough,0.07+stain*wear*0.15,N.finish.z);
      } else if(finish==103 || finish==104) {
        let along=select(p.x,p.z,abs(n.x)>0.5);
        let grime=finishStain(vec2f(along*0.6,p.y*1.8));
        let foot=1.0-smoothstep(0.16,0.65,p.y);
        let drip=finishNoise(vec2f(along*3.0,p.y*0.25));
        albedo*=1.0-wear*(grime*0.19+foot*0.3+smoothstep(0.68,0.82,drip)*0.14);
        pbrRough=mix(pbrRough,select(0.38,0.19,finish==104)+grime*0.12,N.finish.y);
      } else if(finish==106) {
        pbrRough=0.12+wear*s*0.14;
        albedo*=1.0-wear*s*0.1;
      }
    }
`
