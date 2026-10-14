import { makeSceneShader, spriteShader, postShader } from "@arcade/kit/gpu/shaders"
import { surfaceMaterial, surfaceMaterialDeclarations } from "@arcade/kit/gpu/surface-materials"
import { foliageWindDeclarationsWgsl } from "@arcade/kit/gpu/foliage"
import { BUILDING_RECTS } from "../shared/map"

/** Slot zero casts from eye height, has no radiance, and is reserved for visibility. */
export const shaders = {
  sprite: spriteShader(),
  post: postShader(false,false,{chromatic:0,bloom:.055,grain:.002,vignette:.90,diagnostics:true,shadowLift:0,huePreserve:.42}),
  scene: makeSceneShader({
    ao: "0.42",
    lightLeak: "0.006 * vis",
    lightAttenuation: `let dn = max(d3, 0.55);
    var att = power * win * (0.08 + 3.4 / (1.0 + dn * dn * 0.45));`,
    wallDirectScale: "mix(0.20, 0.34, smoothstep(0.0, 1.5, o.world.y))",
    ambient: "ambientAt(n) * mix(0.09, 1.0, select(floorData(o.world.xz).g, 1.0, o.world.y > 2.8)) + select(vec3f(0.0), vec3f(0.014, 0.009, 0.005), interior(o.world.xz) && o.world.y < 2.8)",
    diagnostics: "F.map.z",
    smoothShadows: true,
    shadowTaps: 5,
    lightMask: "if (L.cone.w < -0.5 && world.y > 2.75) { continue; }",
    material: surfaceMaterial + `
      if (mat == 4 && interior(o.world.xz+n.xz*.3)) {
        let s = evalPlasterWall(o.world, n, vec3f(.34, .29, .23), defaultMaterialRecipe(2));
        albedo = s.albedo;
        gloss = s.gloss;
      }
    `,
    fragmentStart: "surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world))); surfaceTime = F.cam.w;",
    vertex: /* wgsl */ `
  if (v.matAux.x > 21.5 && v.matAux.x < 22.5) {
    let fw = applyFoliageVertexWind(o.world, o.normal, v.matAux.y, F.cam.w, F.cam.xyz, defaultFoliageWindConfig());
    o.world = fw[0];
    o.normal = fw[1];
  }`,
    declarations: /* wgsl */ `
@group(0) @binding(9) var exploredTex: texture_2d<f32>;
${surfaceMaterialDeclarations}
${foliageWindDeclarationsWgsl}
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
    directional: "mix(vec3f(0.46, 0.68, 1.08), vec3f(1.0, 0.79, 0.53), F.monitorBounds.w) * select(fd.g * 0.35, 1.0, !interior(o.world.xz) || o.world.y > 2.8) * F.ambient.w * max(0.0, dot(n, F.monitorBounds.xyz))",
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
  if(mat == 2) { col *= .88; }
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
  if(mat == 22) {
    // Above the Grassland + Botanics subsurface chlorophyll translucency & 4th-power grazing Fresnel rim.
    let tipWeight = clamp(abs(o.aux), 0.0, 1.0);
    let keyDir = normalize(F.monitorBounds.xyz);
    let forwardScatter = pow(clamp(dot(-V, keyDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
    let backNormal = max(0.0, dot(-n, keyDir));
    let transLobe = (forwardScatter * 0.55 + backNormal * 0.45) * F.ambient.w * 0.24 * tipWeight;
    let chloroTint = mix(vec3f(0.10, 0.24, 0.05), vec3f(0.28, 0.44, 0.14), sqrt(tipWeight));
    let fresnelRim = pow(1.0 - max(dot(n, V), 0.0), 4.0) * 0.14 * tipWeight * F.ambient.w;
    let lampTrans = spill(o.world) * 0.05 * tipWeight;
    col += o.color * (chloroTint * transLobe + vec3f(0.32, 0.52, 0.22) * fresnelRim + lampTrans);
  }
  // Scenery and illumination are not an enemy-visibility mask. Exterior form remains readable.
  // Dynamic entities use the authoritative CPU Vision before submitting a draw (the local survivor is exempt).
  if (mat != 12 && mat != 21 && mat != 2) {
    let luminance=dot(col,vec3f(.2126,.7152,.0722));
    let peripheral=mix(vec3f(luminance)*vec3f(.83,.94,1.05),col,.72);
    if (interior(o.world.xz) && o.world.y < 2.8) {
      // Room discovery is deliberately coarser than actor LOS. No view-cone-shaped blackout.
      let room=mix(vec3f(luminance)*vec3f(.90,.96,1.0),col,.88+.12*visible);
      col=mix(o.color*.008, room * mix(F.effects.w, 1.0, .82), explored);
    } else {
      col=mix(peripheral*(.86+.14*explored),col,.86+.14*visible);
    }
  }
`,
  }),
}
