import { motionGatherWGSL } from "@arcade/kit/gpu/motion-blur"
export {
  MotionBlur,
  MotionBlurBurst,
  MotionHistory,
  MotionKeys,
  motionBlurControls,
  motionBlurDefaults,
  type MotionBlurSettings,
  type MotionKey,
} from "@arcade/kit/gpu/motion-blur"
export const motionSettings = { strength: 1, shutter: 1, burst: 1, burstDecay: 14 }

/** One depth-aware gather, used by the existing composite only when motion blur is enabled. */
export const motionGather = /* wgsl */ `
@group(0) @binding(5) var velocityTex: texture_2d<f32>;
fn motionField(uv:vec2f)->vec4f {
  let size=vec2f(textureDimensions(src));
  let m=textureLoad(velocityTex,clamp(vec2i(uv*size),vec2i(0),vec2i(size)-1),0);
  return vec4f(m.xy/size,m.zw);
}
fn motionColor(uv:vec2f)->vec4f {return clean(textureSampleLevel(src,samp,uv,0));}
${motionGatherWGSL(true)}
fn motionColour(uv: vec2f) -> vec3f {
  return clean(gatherMotion(uv,vec2f(textureDimensions(src)),1.0,32.0)).rgb;
}
`

export const motionOutput = /* wgsl */ `
struct Motion { previous: mat4x4f, shutter: vec4f }
@group(0) @binding(7) var<uniform> M: Motion;
struct MotionOut { @location(0) color: vec4f, @location(1) velocity: vec4f }
fn shutterVelocity(uv: vec2f, previous: vec4f) -> vec2f {
  let prev = previous.xy / max(previous.w, 0.0001) * vec2f(0.5, -0.5) + 0.5;
  let velocity = (uv - prev) * F.screen.xy * M.shutter.x;
  let speed = length(velocity);
  // Slow top-down following stays sharp; recoil and fast objects get a full-frame shutter.
  if (previous.w <= 0.0 || speed <= 1.25) { return vec2f(0.0); }
  return velocity * (min(32.0, speed - 1.25) / speed);
}
fn motionOutput(color: vec4f, frag: vec4f, previous: vec4f, world: vec3f) -> MotionOut {
  let uv = frag.xy / F.screen.xy;
  let velocity = shutterVelocity(uv, previous);
  var out: MotionOut;
  out.color = color;
  out.velocity = vec4f(velocity, length(world - F.cam.xyz), 1.0) * clamp(color.a, 0.0, 1.0);
  return out;
}
`
