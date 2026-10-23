import { postShader } from "@arcade/kit/gpu/shaders"

// Port of Ashwood render/post.ts:735–799. The source calls this a film look;
// its actual curve is a max-channel rational shoulder (not AgX).
export const post = postShader(false, false, { chromatic: 0, bloom: 0.26, grain: 0.008, vignette: 0.45, bloomGate: { cap: 0.02, hot: 4 }, composite: /* wgsl */ `
  let uv=o.uv;
  // Three's five bloom weights sum to 3; kit's additive five-level pyramid sums to 5.
  var hdr=(clean(textureSample(src,samp,uv)).rgb+textureSample(bloomTex,samp,uv).rgb*(0.26*3.0/5.0)*(1.0+G.z))*G.w;
  let wb=vec3f(0.97,1.0072,1.042);
  hdr*=wb/dot(wb,vec3f(0.2126,0.7152,0.0722));
  let lum=dot(hdr,vec3f(0.2126,0.7152,0.0722));
  hdr*=mix(vec3f(1.0),vec3f(0.86,1.04,1.02),(1.0-smoothstep(0.0,0.15,lum))*0.6);
  hdr*=mix(vec3f(1.0),vec3f(1.12,1.0,0.82),smoothstep(0.05,1.5,lum)*0.12);
  let peak=max(max(hdr.r,hdr.g),max(hdr.b,0.00001));
  let shoulder=1.6;
  let mapped=min(1.0,peak*(shoulder+1.0)/(peak*shoulder+1.0));
  var c=mix(hdr*(mapped/peak),vec3f(mapped),smoothstep(3.0,30.0,peak)*0.85);
  let l2=dot(c,vec3f(0.2126,0.7152,0.0722));
  let mx=max(max(c.r,c.g),max(c.b,0.00001));
  let warm=smoothstep(0.15,0.45,(c.r-c.b)/mx)*smoothstep(0.2,0.4,(c.r-c.g)/mx)*smoothstep(0.02,0.12,mx);
  c=max(mix(vec3f(l2),c,mix(0.92,1.4,warm)),vec3f(0.0));
  c=select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>vec3f(0.0031308));
  c=max((c-0.42)*1.12+0.42,vec3f(0.0));
  c/=max(1.0,max(max(c.r,c.g),c.b));
  c=pow(c,vec3f(1.06));
  let lift=vec3f(0.55,1.05,1.0)*0.018;
  c=lift+c*(1.0-lift);
  let radius=length((uv-0.5)*vec2f(1.0,1.15));
  c*=mix(1.0,1.0-smoothstep(0.25,0.85,radius),0.45);
  let grainAmount=0.008*mix(0.55,1.0,1.0-smoothstep(0.15,0.9,dot(c,vec3f(0.2126,0.7152,0.0722))));
  c+=(hash(o.pos.xy)+hash(o.pos.xy+vec2f(57.3,19.1))-1.0)*0.7*grainAmount*vec3f(1.0,0.97,1.02);
  return vec4f(clamp(c,vec3f(0.0),vec3f(1.0)),1.0);
` })
