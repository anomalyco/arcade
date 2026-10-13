/** Integer hashes (pcg3d, Jarzynski & Olano 2020): identical on every GPU, no sin-hash banding. */
export const HASH_WGSL = /* wgsl */ `
fn pcg3d(a: vec3u) -> vec3u {
  var v = a * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
fn rand3(a: vec3u) -> vec3f { return vec3f(pcg3d(a) >> vec3u(8u)) * (1.0 / 16777216.0); }
fn rand3i(c: vec2i, s: u32) -> vec3f { return rand3(vec3u(bitcast<vec2u>(c), s)); }
`
