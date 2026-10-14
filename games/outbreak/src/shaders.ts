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
    lightAttenuation: `let dn = max(d3, 0.85);
    if (L.cone.w > 0.5 && L.pos.w < 4.5) {
      let rx = clamp(1.0 - max(0.0, abs(dv.x) - 0.96) / 0.65, 0.0, 1.0);
      let ry = clamp(1.0 - max(0.0, abs(dv.y - 0.55) - 0.85) / 1.25, 0.0, 1.0);
      win = rx * rx * ry * ry * (0.78 + 0.22 * smoothstep(0.0, 0.14, abs(dv.x)));
    }
    var att = power * win * (0.04 + 2.45 / (1.0 + dn * dn * 0.55));
    if (L.extra.w > -0.5 && L.pos.w > 7.5) {
      att *= 1.0 + 1.85 * smoothstep(0.2, 4.8, dv.y) * exp(-pow(dv.x / 3.8, 2.0));
    }
    if (att <= 0.0035) { continue; }`,
    wallDirectScale: "mix(0.28, 0.46, smoothstep(0.0, 1.5, o.world.y))",
    ambient: "ambientAt(n) * mix(0.08, 1.0, select(floorData(o.world.xz + n.xz * 0.28).g, 1.0, o.world.y > 2.8)) + select(vec3f(0.0), vec3f(0.016, 0.011, 0.006), interior(o.world.xz + n.xz * 0.28) && o.world.y < 2.8)",
    diagnostics: "F.map.z",
    smoothShadows: true,
    shadowTaps: 5,
    lightMask: "if (L.cone.w < -0.5 && world.y > 2.75) { continue; }",
    material: surfaceMaterial + `
      if (mat == 22 && o.aux < -1.5 && alpha < 0.22) { return vec4f(0.0); }
      if (mat == 4 && interior(o.world.xz+n.xz*.3)) {
        let s = evalPlasterWall(o.world, n, vec3f(.44, .38, .31), defaultMaterialRecipe(2));
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
  if (p.x < 21.22 || p.x > 72.78 || p.y < 23.22 || p.y > 67.78 || (p.x > 36.78 && p.x < 53.22) || (p.y > 37.78 && p.y < 54.22)) { return false; }
  if (p.x < 45.0) {
    let b = select(vec4f(22.0, 24.0, 37.0, 35.5), vec4f(21.0, 54.0, 36.0, 65.5), p.y > 45.0);
    let south = p.x > b.x + 0.22 && p.x < b.z - 0.22 && p.y > b.y + 5.70 && p.y < b.w - 0.22;
    let north = p.x > b.x + 2.22 && p.x < b.x + 9.28 && p.y > b.y + 0.22 && p.y < b.y + 5.72;
    return south || north;
  }
  let s = select(vec4f(53.0, 23.0, 73.0, 38.0), vec4f(53.0, 54.0, 72.0, 68.0), p.y > 45.0);
  return all(p > s.xy + 0.22) && all(p < s.zw - 0.22);
}
fn roofCut(p:vec3f, id:i32, frag:vec4f) -> bool {
  let b=houseRect(id);
  if (F.eye.z <= 1.0001) {
    if (F.eye.x < b.x - 0.1 || F.eye.x > b.z + 0.1 || F.eye.y < b.y - 0.1 || F.eye.y > b.w + 0.1) { return false; }
    if (id < 2) {
      let eyeIn = F.eye.y > b.y + 5.4 || (F.eye.x > b.x + 1.9 && F.eye.x < b.x + 9.6);
      if (!eyeIn) { return false; }
      let south = p.x > b.x + 0.35 && p.x < b.z - 0.35 && p.z > b.y + 5.65 && p.z < b.w + 1.65;
      let north = p.x > b.x + 2.25 && p.x < b.x + 9.25 && p.z > b.y + 0.35 && p.z < b.y + 5.85;
      return south || north;
    }
    return p.x>b.x+0.35&&p.x<b.z-0.35&&p.z>b.y+0.35&&p.z<b.w+1.65;
  }
  if (!(all(F.eye.xy>b.xy-0.1)&&all(F.eye.xy<b.zw+0.1)&&all(p.xz>b.xy-0.55)&&all(p.xz<b.zw+1.65))) {
    return false;
  }
  let alpha = clamp(F.eye.z - 1.0, 0.0, 1.0);
  let worldR = length(p.xz - F.eye.xy) / (5.8 * alpha + 0.001);
  if (worldR > 1.0) { return false; }
  let fade = smoothstep(1.0, 0.48, worldR) * alpha;
  if (fade >= 0.995) { return true; }
  return bayer4x4(frag) < fade;
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
    directional: "mix(vec3f(0.46, 0.68, 1.08), vec3f(1.0, 0.79, 0.53), F.monitorBounds.w) * select(floorData(o.world.xz + n.xz * 0.28).g * 1.75, 1.0, !interior(o.world.xz + n.xz * 0.28) || o.world.y > 2.8) * F.ambient.w * max(0.0, dot(n, F.monitorBounds.xyz))",
    cutaway: `
      if (i32(round(o.mat)) == 21 && roofCut(o.world, i32(round(o.aux)), o.pos)) { discard; }
      if (o.world.y > 2.8 && interior(o.world.xz)) {
        for(var i=0;i<4;i++) { if(roofCut(o.world,i,o.pos)){discard;} }
      }
      if (F.eye.z > 1.0001 && o.world.y > 0.88 && (mat == 4 || mat == 9 || mat == 2 || mat == 6)) {
        let alpha = clamp(F.eye.z - 1.0, 0.0, 1.0);
        let wr = length(o.world.xz - F.eye.xy) / (3.4 * alpha + 0.001);
        if (wr < 1.0 && bayer4x4(o.pos) < smoothstep(1.0, 0.45, wr) * alpha * 0.92) { discard; }
      }
    `,
    // High/roof triangles are always routed through fs; low opaque triangles cannot hit these discards.
    solidCutaway: "",
    surface: /* wgsl */ `
  let inRoom = interior(o.world.xz + n.xz * 0.28);
  let visible = eyeVisible(o.world.xz + n.xz * 0.06);
  let explored = textureSampleLevel(exploredTex, floorSamp, (o.world.xz + n.xz * 0.24) * F.map.xy, 0.0).r;
  let nightLamps = clamp(1.0 - F.monitorBounds.w * 1.4, 0.0, 1.0);
  if(mat == 2) {
    col *= .88;
    if (inRoom && o.world.y < 2.8) { col *= max(explored, visible); }
  }
  if(mat == 6) {
    // Clear window glass without milky white wash so rich warm amber interior & dark drapes read crisply.
    let outsideView = !interior(F.eye.xy);
    col = select(vec3f(0.012, 0.022, 0.045), vec3f(0.18, 0.075, 0.015) * nightLamps, outsideView);
  }
  if(mat == 4 && !inRoom) { col *= mix(1.0,.52,smoothstep(2.15,2.78,o.world.y)); }
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
    let tipWeight = clamp(abs(o.aux), 0.0, 1.2);
    let keyDir = normalize(F.monitorBounds.xyz);
    let forwardScatter = pow(clamp(dot(-V, keyDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
    let backNormal = max(0.0, dot(-n, keyDir));
    let transLobe = (forwardScatter * 0.55 + backNormal * 0.45) * F.ambient.w * 0.48 * tipWeight;
    let chloroTint = mix(vec3f(0.18, 0.46, 0.04), vec3f(0.58, 0.85, 0.12), sqrt(clamp(tipWeight, 0.0, 1.0)));
    let fresnelRim = pow(1.0 - max(dot(n, V), 0.0), 4.0) * 0.22 * tipWeight * F.ambient.w;
    col += o.color * (chloroTint * transLobe + vec3f(0.50, 0.85, 0.30) * fresnelRim) + col * 0.18 * tipWeight;
  }
  // Scenery and illumination are not an enemy-visibility mask. Exterior form remains readable.
  // Dynamic entities use the authoritative CPU Vision before submitting a draw (the local survivor is exempt).
  if (mat != 12 && mat != 21 && mat != 2 && mat != 6) {
    let luminance=dot(col,vec3f(.2126,.7152,.0722));
    let peripheral=mix(vec3f(luminance)*vec3f(.83,.94,1.05),col,.72);
    if (inRoom && o.world.y < 2.8) {
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
