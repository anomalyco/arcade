/**
 * Rooms behind the window glass (`window-rooms/settings.ts`): van Dongen's interior mapping, as the Lot's #356 port
 * (`kitRoomBoxUV`), but shaded analytically so no atlas or extra binding is needed. The view ray enters the pane and
 * exits a box behind the wall: `OL.rooms.y` deep, floor to ceiling, side walls at the room's ends (rooms 3.6 m wide
 * along the wall from the house's corner). The face it hits is lit by the room's own practical, placed where
 * `resolveLampLight` puts the house's room lamps (bedrooms at the back, the living room and kitchen behind the front),
 * so panes into the same room agree and the pool slides across the floor as the camera passes. Needs the scene
 * declarations (`OL`, `slotWindowsLit`, `surfaceNoise`, `F`).
 */
export const windowRoomWgsl = /* wgsl */ `
fn outbreakRoomHash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

/** Radiance seen through a lit house's pane at p (outward normal n), or the dark glass when its room is dark. */
fn outbreakWindowRoom(p: vec3f, n: vec3f, darkGlass: vec3f, lit: f32, curtain: f32) -> vec3f {
  let nBld = i32(OL.win.w);
  var b = vec4f(0.0);
  var found = false;
  for (var i = 0; i < 8; i++) {
    if (i >= nBld) { break; }
    let r = OL.bldRects[i];
    if (p.x > r.x - 0.05 && p.x < r.z + 0.05 && p.z > r.y - 0.05 && p.z < r.w + 0.05) { b = r; found = true; break; }
  }
  if (!found || lit <= 0.001) { return darkGlass; }
  let rd = normalize(p - F.cam.xyz);
  // Into the house: the pane's horizontal normal, whichever way the mesh wound it.
  let nh = vec3f(n.x, 0.0, n.z) / max(length(n.xz), 1e-4);
  let inward = select(-nh, nh, dot(nh, rd) > 0.0);
  let t = vec3f(-inward.z, 0.0, inward.x);
  let dw = dot(rd, inward);
  if (dw <= 0.02) { return darkGlass; }
  let du = dot(rd, t);
  let depth = max(OL.rooms.y, 0.5);
  // Rooms along the wall, 3.6 m wide from the corner the tangent runs from.
  let corner = select(select(b.z, b.x, t.x > 0.0), select(b.w, b.y, t.z > 0.0), abs(t.z) > 0.5);
  let u0 = dot(p.xz - vec2f(corner), t.xz);
  let cell = floor(u0 / 3.6);
  let uMin = cell * 3.6 + 0.08;
  let uMax = uMin + 3.44;
  let floorY = 0.12;
  let ceilY = 2.7;
  var tHit = depth / dw;
  var face = 0;
  if (abs(du) > 1e-4) {
    let ts = select(uMin - u0, uMax - u0, du > 0.0) / du;
    if (ts < tHit) { tHit = ts; face = 1; }
  }
  if (rd.y < -1e-4) {
    let tf = (floorY - p.y) / rd.y;
    if (tf < tHit) { tHit = tf; face = 2; }
  } else if (rd.y > 1e-4) {
    let tc = (ceilY - p.y) / rd.y;
    if (tc < tHit) { tHit = tc; face = 3; }
  }
  let hit = p + rd * max(tHit, 0.0);
  let hu = u0 + du * tHit;
  let hw = dw * tHit;
  // The room's practical: the house's room lamp nearest the room's middle, kept inside this room.
  let mid = p.xz + inward.xz * depth * 0.5;
  var lamp = vec2f(b.x + 2.75, b.w - 2.35);
  var best = dot(lamp - mid, lamp - mid);
  var lampId = 2.0;
  let cands = array<vec2f, 3>(vec2f(b.x + 2.75, b.y + 1.25), vec2f(b.x + 6.85, b.y + 2.15), vec2f(b.z - 3.35, b.w - 3.15));
  for (var k = 0; k < 3; k++) {
    let c = cands[k];
    let dd = dot(c - mid, c - mid);
    if (dd < best) { best = dd; lamp = c; lampId = f32(k); }
  }
  let lu = clamp(dot(lamp - p.xz, t.xz) + u0, uMin + 0.4, uMax - 0.4);
  let lw = clamp(dot(lamp - p.xz, inward.xz), 0.6, depth - 0.3);
  let lampOn = select(0.0, 1.0, outbreakRoomHash(b.xy + vec2f(lampId * 7.31, cell * 3.7)) < OL.rooms.w);
  let lampPos = vec3f(lu, 1.45, lw);
  let hp = vec3f(hu, hit.y, hw);
  let toL = lampPos - hp;
  let dl2 = dot(toL, toL);
  let fn_ = select(select(select(vec3f(0.0, 0.0, -1.0), vec3f(-sign(du), 0.0, 0.0), face == 1), vec3f(0.0, 1.0, 0.0), face == 2), vec3f(0.0, -1.0, 0.0), face == 3);
  let facing = max(dot(fn_, toL * inverseSqrt(max(dl2, 1e-4))), 0.0);
  let roomTone = outbreakRoomHash(b.xy * 0.37 + vec2f(cell, lampId));
  let wall = mix(vec3f(0.32, 0.27, 0.19), vec3f(0.24, 0.27, 0.22), roomTone);
  // Floorboards along the room, a rug in the middle; walls darker towards the ceiling.
  let boards = 0.85 + 0.15 * surfaceNoise(vec2f(floor(hu / 0.18) * 1.7, hw * 0.6));
  let rug = smoothstep(0.9, 0.7, max(abs(hu - (uMin + uMax) * 0.5) / 1.2, abs(hw - depth * 0.55) / (depth * 0.3)));
  var albedo = select(select(wall, vec3f(0.22, 0.14, 0.08) * boards, face == 2), vec3f(0.26, 0.25, 0.23), face == 3);
  if (face == 2) { albedo = mix(albedo, mix(vec3f(0.30, 0.10, 0.07), vec3f(0.16, 0.18, 0.24), roomTone), rug * 0.8); }
  if (face <= 1) { albedo *= mix(1.0, 0.7, smoothstep(1.6, 2.6, hit.y)); }
  let wallWash = select(OL.rooms2.y, 1.0, face == 2);
  let tungsten = vec3f(1.0, 0.56, 0.22);
  let pool = lampOn * (0.9 * facing + 0.1) / (0.35 + dl2 * 0.55) * wallWash;
  // Scaled so a lit room's floor pool reads as bright as Today's glow box behind the pane.
  var room = albedo * (tungsten * pool * 4.0 + vec3f(0.02, 0.016, 0.012)) * OL.rooms.z;
  // Half-drawn curtains, backlit by the room, over part of the pane.
  let drape = smoothstep(0.35, 0.75, curtain) * OL.rooms2.x;
  let fabric = vec3f(0.20, 0.10, 0.035) * (0.25 + 0.75 * lampOn) * OL.rooms.z;
  room = mix(room, fabric, drape * 0.85);
  return mix(darkGlass, room + darkGlass * 0.5, lit);
}
`
