import { makeSceneShader, spriteShader, postShader } from "@arcade/kit/gpu/shaders"
import { surfaceMaterial, surfaceMaterialDeclarations } from "@arcade/kit/gpu/surface-materials"
import { BUILDING_RECTS } from "../shared/map"

/** Slot zero casts from eye height, has no radiance, and is reserved for visibility. */
export const shaders = {
  sprite: spriteShader(),
  post: postShader(false,false,{chromatic:0,bloom:.055,grain:.002,vignette:.90,diagnostics:true,shadowLift:0,huePreserve:.42}),
  scene: makeSceneShader({
    ao: "0.42",
    lightLeak: "0.006 * vis",
    lightAttenuation: `let dn = max(d3, 0.85);
    if (L.cone.w > 0.5) {
      let rx = clamp(1.0 - max(0.0, abs(dv.x) - 0.88) / 0.42, 0.0, 1.0);
      let ry = clamp(1.0 - max(0.0, abs(dv.y - 0.25) - 0.65) / 0.85, 0.0, 1.0);
      win = rx * rx * ry * ry * (0.76 + 0.24 * smoothstep(0.0, 0.14, abs(dv.x)));
    }
    var att = power * win * (0.04 + 2.45 / (1.0 + dn * dn * 0.55));
    if (att <= 0.0035) { continue; }`,
    wallDirectScale: "mix(0.28, 0.46, smoothstep(0.0, 1.5, o.world.y))",
    ambient: "ambientAt(n) * mix(0.13, 1.0, select(floorData(o.world.xz).g, 1.0, o.world.y > 2.8)) + select(vec3f(0.0), vec3f(0.022, 0.015, 0.008), interior(o.world.xz) && o.world.y < 2.8)",
    diagnostics: "F.map.z",
    smoothShadows: true,
    shadowTaps: 5,
    lightMask: "if (L.cone.w < -0.5 && world.y > 2.75) { continue; }",
    material: surfaceMaterial + `
      if (mat == 4 && interior(o.world.xz+n.xz*.3)) {
        let s = evalPlasterWall(o.world, n, vec3f(.44, .38, .31), defaultMaterialRecipe(2));
        albedo = s.albedo;
        gloss = s.gloss;
      }
    `,
    fragmentStart: "surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world)));",
    declarations: /* wgsl */ `
@group(0) @binding(9) var exploredTex: texture_2d<f32>;
${surfaceMaterialDeclarations}
fn houseRect(id: i32) -> vec4f {
  switch id {
    ${BUILDING_RECTS.map((b,i)=>`${i===3?"default":`case ${i}`}: {return vec4f(${b.map(v=>v.toFixed(2)).join(",")});}`).join("\n")}
  }
}
fn interior(p:vec2f) -> bool {
  if (p.x < 21.25 || p.x > 72.75 || p.y < 23.25 || p.y > 67.75 || (p.x > 36.75 && p.x < 53.25) || (p.y > 37.75 && p.y < 54.25)) { return false; }
  for(var i=0;i<4;i++) { let b=houseRect(i); if(all(p>b.xy+0.25)&&all(p<b.zw-0.25)){return true;} }
  return false;
}
fn roofCut(p:vec3f, id:i32, frag:vec4f) -> bool {
  let b=houseRect(id);
  if (!(all(F.eye.xy>b.xy-0.1)&&all(F.eye.xy<b.zw+0.1)&&p.x>b.x+0.35&&p.x<b.z-0.35&&p.z>b.y+0.35&&p.z<b.w+1.65)) {
    return false;
  }
  if (F.eye.z <= 1.0001 || F.eye.z >= 1.999) { return true; }
  let alpha = clamp(F.eye.z - 1.0, 0.0, 1.0);
  let q = vec2u(frag.xy) % 4u;
  let m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[q.y * 4u + q.x] + 0.5) / 16.0 < alpha;
}
fn eyeVisible(p: vec2f) -> f32 {
  let delta = p - lights[0].pos.xz;
  let distance = length(delta);
  let a = (atan2(delta.y, delta.x) + TAU) % TAU;
  let f = a / TAU * f32(RAYS) - 0.5;
  let ray0 = u32(i32(floor(f)) + i32(RAYS)) % RAYS;
  let ray1 = (ray0 + 1u) % RAYS;
  let los0 = 1.0 - smoothstep(polar[ray0 * 2u].x + 0.025, polar[ray0 * 2u].x + 0.10, distance);
  let los1 = 1.0 - smoothstep(polar[ray1 * 2u].x + 0.025, polar[ray1 * 2u].x + 0.10, distance);
  let los = mix(los0, los1, fract(f));
  let facing = dot(delta / max(distance, 0.001), vec2f(cos(F.effects.x), sin(F.effects.x)));
  let cone = smoothstep(F.effects.y, F.effects.y + 0.035, facing);
  let near = 1.0 - smoothstep(F.effects.z - 0.2, F.effects.z, distance);
  let range = 1.0 - smoothstep(lights[0].pos.w - 1.0, lights[0].pos.w, distance);
  return los * max(cone, near) * range;
}`,
    directional: "mix(vec3f(0.46, 0.68, 1.08), vec3f(1.0, 0.79, 0.53), F.monitorBounds.w) * select(fd.g * 1.75, 1.0, !interior(o.world.xz) || o.world.y > 2.8) * F.ambient.w * max(0.0, dot(n, F.monitorBounds.xyz))",
    cutaway: `
      if (i32(round(o.mat)) == 21 && roofCut(o.world, i32(round(o.aux)), o.pos)) { discard; }
      if (o.world.y > 2.8 && interior(o.world.xz)) {
        for(var i=0;i<4;i++) { if(roofCut(o.world,i,o.pos)){discard;} }
      }
    `,
    // High/roof triangles are always routed through fs; low opaque triangles cannot hit these discards.
    solidCutaway: "",
    surface: /* wgsl */ `
  let visible = eyeVisible(o.world.xz + n.xz * 0.06);
  let explored = textureSampleLevel(exploredTex, floorSamp, o.world.xz * F.map.xy, 0.0).r;
  let nightLamps = clamp(1.0 - F.monitorBounds.w * 1.4, 0.0, 1.0);
  if(mat == 2) { col *= .88; }
  if(mat == 6) {
    // See-through window glass: warm interior glow when viewed from outside, cool sky reflection from inside.
    let outsideView = !interior(F.eye.xy);
    col += select(vec3f(0.020, 0.036, 0.072), vec3f(0.62, 0.35, 0.11) * nightLamps, outsideView);
  }
  if(mat == 4 && !interior(o.world.xz+n.xz*.3)) { col *= mix(1.0,.52,smoothstep(2.15,2.78,o.world.y)); }
  if(mat == 20 && i32(round(o.aux)) == 1) {
    // Cool moonlit sky sheen on asphalt road crown, strongest away from curb edges.
    let crown = 1.0 - abs(clamp((o.world.z - 40.0) / 8.0, 0.0, 1.0) * 2.0 - 1.0) * 0.35;
    col += vec3f(0.018, 0.026, 0.052) * F.ambient.w * crown * (0.88 + 0.24 * surfaceNoise(o.world.xz * 0.35));
  }
  if(mat == 20 && i32(round(o.aux)) == 2) {
    // Cool moonlit fill on concrete sidewalks and curbs.
    col += vec3f(0.012, 0.018, 0.036) * F.ambient.w;
  }
  if(mat == 21) {
    // Subtle cool twilight sky sheen on upper roof shingle slopes; eaves stay shadowed.
    let eave = smoothstep(2.88, 3.55, o.world.y);
    col = col * mix(0.62, 1.08, eave) + vec3f(0.005, 0.010, 0.022) * F.ambient.w * eave * max(0.0, n.y);
  }
  // Scenery and illumination are not an enemy-visibility mask. Exterior form remains readable.
  // Dynamic entities use the authoritative CPU Vision before submitting a draw (the local survivor is exempt).
  if (mat != 12 && mat != 21 && mat != 2 && mat != 6) {
    let luminance=dot(col,vec3f(.2126,.7152,.0722));
    let peripheral=mix(vec3f(luminance)*vec3f(.83,.94,1.05),col,.72);
    if (interior(o.world.xz) && o.world.y < 2.8) {
      let room=mix(vec3f(luminance)*vec3f(.90,.96,1.0),col,.88+.12*visible);
      let reveal = max(explored, visible * 0.92);
      col=mix(o.color*.008, room * mix(F.effects.w, 1.0, .82), reveal);
    } else {
      col=mix(peripheral*(.86+.14*explored),col,.86+.14*visible);
    }
  }
`,
  }),
}
