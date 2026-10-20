import { nightAtmosphere } from "@arcade/kit/gpu/night-atmosphere"
import type { SceneHooks } from "@arcade/kit/gpu/shaders"

export const hooks: SceneHooks = {
  lampGrid: false,
  declarations: /* wgsl */ `
    struct Night { fog: vec4f, look: vec4f, torch: vec4f }
    @group(0) @binding(13) var<uniform> N: Night;
    ${nightAtmosphere}
    fn wetMask(p: vec2f) -> f32 {
      return smoothstep(0.40, 0.62, fbm(p * 0.28 + 17.0)) * N.look.x;
    }
    fn torchLight(p: vec3f, n: vec3f) -> vec3f {
      let delta = p - F.cam.xyz;
      let distance = max(length(delta), 0.01);
      let beam = smoothstep(0.91, 0.98, dot(delta / distance, N.torch.xyz));
      return vec3f(0.85, 0.92, 1.0) * beam * N.torch.w * max(dot(n, -delta / distance), 0.0) * 6.0 / (1.0 + distance * distance * 0.10);
    }
  `,
  bounce: "vec3f(0.0)",
  directional: "vec3f(0.0)",
  wallDirectScale: "0.8",
  combineLighting: "col = albedo * (amb + direct + moon + torchLight(o.world, n))",
  material: /* wgsl */ `
    if (mat == 20) {
      let wet = wetMask(o.world.xz);
      albedo *= mix(0.65, 0.27, wet);
      n = normalize(mix(n, vec3f(0.0, 1.0, 0.0), wet * 0.92));
      gloss = vec2f(mix(24.0, 210.0, wet), mix(0.06, 0.72, wet));
    }
    if (mat == 22) { albedo *= 0.65; }
  `,
  surface: /* wgsl */ `
    let ray = normalize(o.world - F.cam.xyz);
    if (mat == 3 && o.aux < 0.0) {
      col = nightSky(ray, N.fog.z);
    } else {
      if (mat == 20) {
        let wet = wetMask(o.world.xz);
        let fresnel = 0.025 + 0.975 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        col += nightSky(reflect(-V, n), N.fog.z) * fresnel * wet;
        // Analytic reflection of the sodium emitter, not screen-space geometry reflection.
        let mirror = normalize(vec3f(-6.5, -9.1, 100.0) - F.cam.xyz);
        let streak = pow(max(dot(ray, mirror), 0.0), 700.0);
        col += vec3f(1.0, 0.44, 0.10) * streak * wet * fresnel * N.fog.w * 1.5;
      }
      let fog = heightFog(F.cam.xyz, o.world, N.fog.x, N.fog.y);
      col = mix(col, nightSky(vec3f(ray.x, 0.02, ray.z), N.fog.z), fog);
    }
    col += vec3f(1.0, 0.45, 0.13) * lampScatter(F.cam.xyz, o.world, vec3f(-6.5, 9.1, 100.0), 2.2) * N.look.y * N.fog.w;
  `,
}
