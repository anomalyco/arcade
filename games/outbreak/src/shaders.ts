import { makeSceneShader, spriteShader } from "@arcade/kit/gpu/shaders"

/** Slot zero casts from eye height, has no radiance, and is reserved for visibility. */
export const shaders = {
  sprite: spriteShader,
  scene: makeSceneShader({
    ao: "0.0",
    declarations: /* wgsl */ `
@group(0) @binding(7) var exploredTex: texture_2d<f32>;
fn eyeVisible(p: vec2f) -> f32 {
  let delta = p - F.eye.xy;
  let distance = length(delta);
  let a = (atan2(delta.y, delta.x) + TAU) % TAU;
  let ray = u32(floor(a / TAU * f32(RAYS))) % RAYS;
  let reach = polar[ray * 2u].x;
  let los = 1.0 - smoothstep(reach + 0.025, reach + 0.10, distance);
  let facing = dot(delta / max(distance, 0.001), vec2f(cos(F.effects.x), sin(F.effects.x)));
  let cone = smoothstep(F.effects.y, F.effects.y + 0.035, facing);
  let near = 1.0 - smoothstep(F.effects.z - 0.2, F.effects.z, distance);
  let range = 1.0 - smoothstep(lights[0].pos.w - 1.0, lights[0].pos.w, distance);
  return los * max(cone, near) * range;
}`,
    directional: "mix(vec3f(0.52, 0.68, 1.0), vec3f(1.0, 0.79, 0.53), F.monitorBounds.w) * fd.g * F.ambient.w * max(0.0, dot(n, F.monitorBounds.xyz))",
    surface: /* wgsl */ `
  let visible = eyeVisible(o.world.xz + n.xz * 0.06);
  let explored = textureSampleLevel(exploredTex, floorSamp, o.world.xz * F.map.xy, 0.0).r;
  // Memory is unlit and desaturated: switching lamps cannot reveal a room through its wall.
  let memory = vec3f(dot(o.color, vec3f(0.2126, 0.7152, 0.0722))) * F.effects.w * vec3f(0.67, 0.76, 0.88);
  col = mix(mix(vec3f(0.002, 0.003, 0.005), memory, explored), col, visible);
`,
  }),
}
