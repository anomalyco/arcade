/** Stable part identities survive batching, disappearance and reordering. Owners are weakly held. */
export type MotionKey = object
export class MotionKeys {
  private owners = new WeakMap<object, Map<number, MotionKey[]>>()
  private arrays = new WeakMap<number[], (MotionKey | undefined)[]>()
  private counts = new Map<number, number>()
  private parts: Map<number, MotionKey[]> | undefined
  begin(owner?: object): void {
    this.counts.clear()
    this.parts = owner ? this.owners.get(owner) : undefined
    if (owner && !this.parts) this.owners.set(owner, this.parts = new Map())
  }
  record(array: number[], model: number): void {
    const key = this.key(model)
    if (!key) return
    let keys = this.arrays.get(array)
    if (!keys) this.arrays.set(array, keys = [])
    keys[array.length / 12 - 1] = key
  }
  of(array: number[]) { return this.arrays.get(array) }
  key(model: number): MotionKey | undefined {
    if (!this.parts) return
    const index = this.counts.get(model) ?? 0
    this.counts.set(model, index + 1)
    let parts = this.parts.get(model)
    if (!parts) this.parts.set(model, parts = [])
    return parts[index] ?? (parts[index] = {})
  }
}

/** Previous *submitted* transforms, rather than previous simulation or build calls. */
export class MotionHistory {
  private entries = new WeakMap<MotionKey, { frame: number; pose: Float32Array }>()
  private frame = 0
  private valid = false
  begin(valid: boolean): void { this.frame++; this.valid = valid }
  write(dst: Float32Array, offset: number, current: Float32Array, start: number, key?: MotionKey): void {
    let old = key ? this.entries.get(key) : undefined
    const continuous = this.valid && old?.frame === this.frame - 1 &&
      Math.hypot(current[start]! - old.pose[0]!, current[start + 1]! - old.pose[1]!, current[start + 2]! - old.pose[2]!) < 4
    for (let j = 0; j < 12; j++) dst[offset + j] = continuous ? old!.pose[j]! : current[start + j]!
    if (!key) return
    if (!old) { old = { frame: this.frame, pose: new Float32Array(12) }; this.entries.set(key, old) }
    old.frame = this.frame
    for (let j = 0; j < 12; j++) old.pose[j] = current[start + j]!
  }
}

/** One depth-aware gather, used by the existing composite only when motion blur is enabled. */
export const motionGather = /* wgsl */ `
@group(0) @binding(5) var velocityTex: texture_2d<f32>;
fn motionColour(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(src));
  let center = textureLoad(velocityTex, vec2i(uv * size), 0);
  let velocity = center.xy / size;
  let original = clean(textureSampleLevel(src, samp, uv, 0.0)).rgb;
  if (dot(center.xy, center.xy) < 0.25) { return original; }
  var colour = original;
  var weight = 1.0;
  for (var i = 0; i < 8; i++) {
    let t = (f32(i) + 0.5) / 8.0 - 0.5;
    let at = clamp(uv + velocity * t, 0.5 / size, 1.0 - 0.5 / size);
    let sample = textureLoad(velocityTex, vec2i(at * size), 0);
    // Reject other depth layers; retain sloping floors. No silhouette-wide blur of unrelated rooms.
    let w = 1.0 - smoothstep(0.15, max(0.35, center.z * 0.018), abs(sample.z - center.z));
    colour += textureSampleLevel(src, samp, at, 0.0).rgb * w;
    weight += w;
  }
  return clean(vec4f(colour / weight, 1.0)).rgb;
}
`

export const motionOutput = /* wgsl */ `
struct Motion { previous: mat4x4f, shutter: vec4f }
@group(0) @binding(7) var<uniform> M: Motion;
struct MotionOut { @location(0) color: vec4f, @location(1) velocity: vec4f }
fn motionOutput(color: vec4f, frag: vec4f, previous: vec4f, world: vec3f) -> MotionOut {
  let uv = frag.xy / F.screen.xy;
  let prev = previous.xy / max(previous.w, 0.0001) * vec2f(0.5, -0.5) + 0.5;
  var velocity = (uv - prev) * F.screen.xy * M.shutter.x;
  if (previous.w <= 0.0) { velocity = vec2f(0.0); }
  velocity *= min(1.0, 24.0 / max(length(velocity), 0.001));
  var out: MotionOut;
  out.color = color;
  out.velocity = vec4f(velocity, length(world - F.cam.xyz), 1.0) * clamp(color.a, 0.0, 1.0);
  return out;
}
`
