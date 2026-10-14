import { makeSceneShader, spriteShader, postShader } from "@arcade/kit/gpu/shaders"
import { surfaceMaterial, surfaceMaterialDeclarations } from "@arcade/kit/gpu/surface-materials"
import { BUILDING_RECTS } from "../shared/map"

/** Slot zero casts from eye height, has no radiance, and is reserved for visibility. */
export const shaders = {
  sprite: spriteShader(),
  post: postShader(false,false,{chromatic:0,bloom:.045,grain:.002,vignette:.92,diagnostics:true,shadowLift:0,huePreserve:.35}),
  scene: makeSceneShader({
    ao: "0.35",
    lightLeak: "0.004 * vis",
    ambient: "ambientAt(n) * mix(0.25, 1.0, select(floorData(o.world.xz).g, 1.0, o.world.y > 2.8))",
    diagnostics: "F.map.z",
    smoothShadows: true,
    shadowTaps: 5,
    lightMask: "if (L.cone.w < -0.5 && world.y > 2.75) { continue; }",
    material: surfaceMaterial + `
      if (mat == 4 && interior(o.world.xz+n.xz*.3)) {
        let s = evalPlasterWall(o.world, n, vec3f(.38, .34, .28), defaultMaterialRecipe(2));
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
  for(var i=0;i<4;i++) { let b=houseRect(i); if(all(p>b.xy+0.25)&&all(p<b.zw-0.25)){return true;} }
  return false;
}
fn roofCut(p:vec3f, id:i32) -> bool {
  let b=houseRect(id);
  return all(F.eye.xy>b.xy-0.1)&&all(F.eye.xy<b.zw+0.1)&&all(p.xz>b.xy+0.35)&&all(p.xz<b.zw-0.35);
}
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
    directional: "mix(vec3f(0.52, 0.68, 1.0), vec3f(1.0, 0.79, 0.53), F.monitorBounds.w) * select(fd.g, 1.0, o.world.y > 2.8) * F.ambient.w * max(0.0, dot(n, F.monitorBounds.xyz))",
    cutaway: `
      if (i32(round(o.mat)) == 21 && roofCut(o.world, i32(round(o.aux)))) { discard; }
      if (o.world.y > 2.8 && interior(o.world.xz)) {
        for(var i=0;i<4;i++) { if(roofCut(o.world,i)){discard;} }
      }
    `,
    // High/roof triangles are always routed through fs; low opaque triangles cannot hit these discards.
    solidCutaway: "",
    surface: /* wgsl */ `
  let visible = eyeVisible(o.world.xz + n.xz * 0.06);
  let explored = textureSampleLevel(exploredTex, floorSamp, o.world.xz * F.map.xy, 0.0).r;
  if(mat == 2) { col *= .38; }
  if(mat == 4 && !interior(o.world.xz+n.xz*.3)) { col *= mix(1.0,.66,smoothstep(2.25,2.8,o.world.y)); }
  // Scenery and illumination are not an enemy-visibility mask. Exterior form remains readable.
  // Dynamic entities use the authoritative CPU Vision before submitting a draw (the local survivor is exempt).
  if (mat != 12 && mat != 21 && mat != 2) {
    let luminance=dot(col,vec3f(.2126,.7152,.0722));
    let peripheral=mix(vec3f(luminance)*vec3f(.83,.94,1.05),col,.55);
    if (interior(o.world.xz) && o.world.y < 2.8) {
      // Room discovery is deliberately coarser than actor LOS. No view-cone-shaped blackout.
      let room=mix(vec3f(luminance)*vec3f(.90,.96,1.0),col,.86+.14*visible);
      col=mix(o.color*.008, room * mix(F.effects.w, 1.0, .82), explored);
    } else {
      col=mix(peripheral*(.72+.18*explored),col,.7+.3*visible);
    }
  }
`,
  }),
}
