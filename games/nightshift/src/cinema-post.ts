import { customPostGradeWgsl } from "@arcade/kit/gpu/post-uniform"

/** The lens keeps frame.y/z and look.yzw; cinematic shutter/fade use only custom.xy. */
export function withCinematicPost(source:string){
  const baseline="@group(0) @binding(4) var<uniform> G: vec4f;"
  const lens="struct Grade { frame: vec4f, look: vec4f }\n@group(0) @binding(4) var<uniform> grade: Grade;"
  if(!source.includes(baseline)&&!source.includes(lens))throw Error("Post grade declaration changed")
  return source.replace(baseline,customPostGradeWgsl).replace(lens,customPostGradeWgsl)
    .replaceAll("G.","grade.frame.")
    .replace(/var hdr = vec3f\([\s\S]*?\n  \);/,"var hdr = cinemaShutter(uv);")
    .replaceAll(/return vec4f\(c,\s*1(?:\.0)?\);/g,"return vec4f(c*(1.0-clamp(grade.custom.y,0.0,1.0)),1.0);")+`
fn cinemaShutter(uv:vec2f)->vec3f {
  if(abs(grade.custom.x)<.00001){return clean(textureSampleLevel(src,samp,uv,0.0)).rgb;}
  var color=vec3f(0.0);
  for(var i=0;i<9;i++){
    let offset=(f32(i)/8.0-.5)*grade.custom.x;
    color+=clean(textureSampleLevel(src,samp,clamp(uv+vec2f(offset,0.0),vec2f(.001),vec2f(.999)),0.0)).rgb;
  }
  return color/9.0;
}`
}
