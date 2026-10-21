import type { PlanBounceShader } from "@arcade/kit/gpu/gi/plan-bounce"
import { planBounceSceneWgsl } from "@arcade/kit/gpu/gi/plan-bounce"

/**
 * Bounced light's emission (AR-115): the light each Outbreak light puts on the ground, as the scene's
 * `lightAttenuation` hook shapes it (`shaders.ts`), simplified to what a 0.5 m grid can show. The local torch (cone.w
 * 2) takes `flashAttenuation`'s magnitude (radiance 9, the 6 m near-lens softening) in a flat-topped plan cone, table
 * lamps stay in their room, sconces light only their side of the wall, and everything else uses the lamp falloff with
 * the kit's plan spot cone (windows, remote torches).
 */
export const outbreakPlanBounceShader: PlanBounceShader = {
  attenuation: /* wgsl */ `var att = 0.0;
    if (L.cone.w < -2.5 && (p.x < L.cone.x - 0.03 || p.x > L.cone.z + 0.03 || p.y < L.cone.y - 0.03 || p.y > L.extra.x + 0.03)) { continue; }
    if (L.cone.w > 1.125 && L.cone.w < 1.5 && dot(dv, L.cone.xy) < -L.extra.x) { continue; }
    if (L.cone.w > 0.5 && L.cone.w < 2.5 && dot(dv, L.cone.xy) <= 0.0) { continue; }
    if (L.cone.w > 1.5 && L.cone.w < 2.5) {
      let c = dot(dv * inverseSqrt(max(dPlan2, 1e-6)), L.cone.xy);
      let halfAng = acos(clamp(L.cone.z, -1.0, 1.0));
      let cone = 1.0 - smoothstep(halfAng * 0.8, halfAng, acos(clamp(c, -1.0, 1.0)));
      let x2 = d3 * d3 / max(r * r, 1.0);
      let w = clamp(1.0 - x2 * x2, 0.0, 1.0);
      att = power * 9.0 * cone * w * w / (1.0 + d3 * d3 / 36.0);
    } else {
      let dn = max(d3, 0.85);
      att = power * win * (0.025 + 2.25 / (1.0 + dn * dn * 0.62));
      if (L.cone.w > 0.5 && L.cone.w < 1.125 && dPlan2 > 1e-6) {
        let c = dot(dv * inverseSqrt(dPlan2), L.cone.xy);
        let t = clamp((c - L.cone.z) / 0.25, 0.0, 1.0);
        att *= t * t * (3.0 - 2.0 * t);
      }
    }`,
}

/**
 * Scene side: the kit's `planBounceAt` plus `outbreakBounceAndGi`, which the `bounce` hook calls in place of the baked
 * bounce alone. Bounced light is added light (the surface's albedo multiplies it with the rest of the ambient), fades
 * up walls and bodies, stops at the wall tops (roofs and canopies take none), and leaves its luminance in
 * `outbreakGiIrr` so the colour rule counts it as light: colour comes back only where bounced light actually lands.
 */
export const outbreakBounceSceneWgsl = /* wgsl */ `
${planBounceSceneWgsl}
fn outbreakBounceAndGi(p: vec2f, scale: f32, world: vec3f, n: vec3f) -> vec3f {
  let baked = outbreakBounce(p, scale);
  if (planBounceStrength() <= 0.0 || world.y > 2.78) { return baked; }
  let lift = mix(1.0, 0.45, smoothstep(0.2, 2.6, world.y));
  let gi = planBounceAt(world.xz + n.xz * 0.3) * lift;
  outbreakGiIrr = dot(gi, vec3f(0.2126, 0.7152, 0.0722)) * planBounceU.d.y;
  return baked + gi;
}`
