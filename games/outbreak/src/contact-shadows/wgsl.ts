import { contactShadowVolume } from "@arcade/kit/gpu/contact-shadows"
import { volumeParamsWgsl } from "@arcade/kit/gpu/volume-pass"

/**
 * Each Outbreak light's diffuse irradiance (luminance) at a pixel, as the scene's `lightAttenuation` shapes it, for the
 * contact shadows' share of the light: the torch (cone.w 2) through its plan cone with the near-lens softening, lens
 * street lamps (cone.w ≥ 6.5) through the lens kernel, window lamps through their half-plane, the rest with Today's
 * practical falloff. Slot 0 (the sight caster) has no power and drops out.
 */
const irradianceWgsl = /* wgsl */ `
fn outbreakContactIrradiance(L: Light, p: vec3f, n: vec3f) -> f32 {
  let power = L.color.w;
  if (power <= 0.001) { return 0.0; }
  let dv = p.xz - L.pos.xz;
  let dPlan2 = dot(dv, dv);
  let r = L.pos.w;
  if (dPlan2 >= r * r) { return 0.0; }
  let toL = L.pos.xyz - p;
  let d = max(length(toL), 0.05);
  let ndl = dot(n, toL / d);
  if (ndl <= 0.0) { return 0.0; }
  var win = 1.0 - dPlan2 / (r * r);
  win *= win;
  var att = 0.0;
  if (L.cone.w > 6.5) {
    let b = L.cone.w - 7.0;
    att = power * L.cone.z * win / (d * d + b * b);
  } else if (L.cone.w > 1.5 && L.cone.w < 2.5) {
    let c = dot(dv * inverseSqrt(max(dPlan2, 1e-6)), L.cone.xy);
    att = power * 9.0 * smoothstep(L.cone.z, mix(L.cone.z, 1.0, 0.25), c) * win / (1.0 + d * d / 36.0);
  } else {
    if (L.cone.w > 0.5 && L.cone.w < 1.125 && dot(dv, L.cone.xy) <= 0.0) { return 0.0; }
    let dn = max(d, 0.85);
    att = power * win * (0.025 + 2.25 / (1.0 + dn * dn * 0.62));
  }
  return att * ndl * dot(L.color.rgb, vec3f(0.2126, 0.7152, 0.0722));
}`

/** The contact-shadow volume slot: knobs in the slot's own params (`contactVolumeInput`), the sky shares the light. */
export const outbreakContactVolume = contactShadowVolume({
  declarations: `${volumeParamsWgsl}\n${irradianceWgsl}`,
  knobs: ["volumeParams[0]", "volumeParams[1]"],
  ambient: "F.ambient.rgb * (0.4 + 0.6 * max(n.y, 0.0))",
  irradiance: "outbreakContactIrradiance(L, p, n)",
})
