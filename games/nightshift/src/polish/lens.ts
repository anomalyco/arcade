import { postShader } from "@arcade/kit/gpu/shaders"

/** Existing kit bloom/ACES/grade/grain/IGN, with three live lens controls in the grade's spare tuple. */
export const lensPost=postShader(true,false,{
  chromatic:0,bloom:.22,grain:.006,vignette:.3,bloomGate:{cap:.06,hot:.7},
  composite:/* wgsl */ `
  let G=grade.frame;let on=grade.look.w>0.5;
  let uv=o.uv;let fromC=uv-.5;let texel=1.0/vec2f(textureDimensions(src));
  let centre=clean(textureSample(src,samp,uv)).rgb;
  var hdr=centre;
  if(on){
    let edge=smoothstep(.15,.68,length(fromC));
    let shift=fromC*edge*grade.look.z*texel*2.0;
    let red=clean(textureSampleLevel(src,samp,uv+shift,0)).r;
    let blue=clean(textureSampleLevel(src,samp,uv-shift,0)).b;
    let hot=smoothstep(.5,2.0,max(centre.r,max(centre.g,centre.b))*G.w);
    hdr=mix(centre,vec3f(red,centre.g,blue),hot);
    let blur=texel*grade.look.y*edge;
    let soft=(clean(textureSampleLevel(src,samp,uv+blur,0)).rgb+clean(textureSampleLevel(src,samp,uv-blur,0)).rgb)*.5;
    hdr=mix(hdr,soft,edge*.25);
  }
  hdr+=textureSample(bloomTex,samp,uv).rgb*.22;
  var c=aces(hdr*G.w);let l=dot(c,vec3f(.2126,.7152,.0722));
  c=mix(vec3f(l),c,.95);
  c+=vec3f(.0001,.0004,.0005)*(1.0-smoothstep(0.0,.25,l));
  c*=mix(vec3f(.9,1.0,1.03),vec3f(1.04,1.0,.91),smoothstep(.2,.8,l));
  let v=length(fromC*vec2f(1,.8));
  c*=mix(1.0,select(.3,1.0-G.y,on),smoothstep(.32,.85,v));
  c=pow(max(c,vec3f(0)),vec3f(1.0/2.2));
  let px=o.pos.xy;let t=select(0.0,G.x,on);
  let grain=hash(px+fract(t*13.7)*1000.0)+hash(px*1.37+fract(t*7.3)*500.0)-1.0;
  let mid=smoothstep(.02,.20,l)*(1.0-smoothstep(.75,1.0,l));
  c+=grain*select(.006,G.z,on)*select(.25+.75*mid,mid,on);
  let ign=fract(52.9829189*fract(dot(floor(px),vec2f(.06711056,.00583715))));
  c+=(ign-.5)/255.0*step(.001,l);
  return vec4f(c,1);
  `,
})
