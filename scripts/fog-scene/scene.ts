/**
 * A first-person night lot for the kit fog proof (`scripts/fog-gpu-proof.ts`): wet ground, a road of sodium lamps on
 * poles, a building and a car as silhouettes, the fog sky, and Ashwood's numbers (fog 0.01 /m, falloff 0.05 /m, teal
 * at 0.034, sodium cones 1.1 rad / 0.45, exposure −2.2 EV). "Today"
 * is the same scene with the fog's scattering off, so the A/B isolates the port.
 */
import { mat4 } from "wgpu-matrix"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_MAP_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS } from "../../packages/kit/limits"
import { FRAME_FLOATS, common, makeSceneShader, postShader, spriteShader } from "../../packages/kit/gpu/shaders"
import { MAT, Mesh } from "../../packages/kit/gpu/mesh"
import { Renderer, SPRITE_FLOATS, type FrameInput, type VolumeLightShader } from "../../packages/kit/gpu/renderer"
import {
  FogScatter,
  SODIUM_CONE,
  createFogSettings,
  fogCone,
  fogSceneWgsl,
  fogScatterVolume,
  packLampGlow,
  type FogLamp,
  type Vec3,
} from "../../packages/kit/gpu/fog-scatter"

export const FOG_SCENE_ALPHA = 2.5
const GAIN = 5
const cone = fogCone(SODIUM_CONE.angle, SODIUM_CONE.inner)
const SODIUM: Vec3 = [1, 0.42, 0.1]
/** Lamp heads (x, height, z): a road of sodium lamps receding past a gate. */
const HEADS: Vec3[] = [
  [4.5, 7.5, 22],
  [-7, 7.5, 44],
  [9, 7.5, 58],
  [-6, 7.5, 80],
  [16, 7, 96],
  [-14, 7.5, 120],
]
const POWER = 350

/** A flashlight-style slot with no depth: proves two volume shaders share the pass. */
export const plainVolume: VolumeLightShader = {
  code: /* wgsl */ `
${common}
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@fragment fn fs(o: VO) -> @location(0) vec4f { return vec4f(0.002, 0.0, 0.0, 0.2); }
`,
}

const hooks = {
  lampGrid: false,
  declarations: fogSceneWgsl,
  bounce: "vec3f(0.0)",
  directional: "vec3f(0.0)",
  lightLeak: "0.0",
  wallDirectScale: "1.0",
  // The surface pool uses the same cone as the fog (`fogLampCone`), so the two line up.
  lightAttenuation: /* wgsl */ `
    let cutoff = pow(max(0.0, 1.0 - pow(d3 / r, 4.0)), 2.0);
    let coneK = select(1.0, fogLampCone(dy / d3, ${cone.cosOuter.toFixed(6)}, ${cone.cosInner.toFixed(6)}), hl > 4.0);
    var att = power * cutoff * coneK / (3.14159265 * max(d3 * d3, 0.01));
  `,
  ambient: "fogAmbient(n)",
  material: "gloss = vec2f(0.0); if (mat == 20) { albedo *= 0.55; }",
  surface: /* wgsl */ `
    let ray = normalize(o.world - F.cam.xyz);
    if (mat == 3 && o.aux < 0.0) {
      col = fogSky(F.cam.xyz, ray);
    } else {
      if (mat == 20) {
        let fres = 0.04 + 0.96 * pow(1.0 - clamp(-ray.y, 0.0, 1.0), 5.0);
        col += fogEnv(reflect(ray, vec3f(0.0, 1.0, 0.0))) * fres * 0.8;
      }
      col = fogApply(col, F.cam.xyz, o.world);
    }
  `,
  fragmentReturn: `return vec4f(col, ${FOG_SCENE_ALPHA.toFixed(1)});`,
}

export type FogScene = {
  renderer: Renderer
  fog: FogScatter
  /** One frame's input: `fogOn` false is Today (no scattering), `plain` also runs the no-depth slot. */
  input(fogOn: boolean, plain?: boolean): FrameInput
  eye: Vec3
  viewProj: Float32Array
}

export function buildFogScene(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, width: number, height: number): FogScene {
  const renderer = new Renderer(device, context, format, {
    scene: makeSceneShader(hooks),
    sprite: spriteShader(),
    post: postShader(false, false, { chromatic: 0, bloom: 0.26, grain: 0.008, vignette: 0.55, huePreserve: 1, saturation: 1.05, shadowLift: 0, bloomGate: { cap: 0.02, hot: 4 } }),
    volume: [plainVolume, fogScatterVolume({ wet: "select(0.0, 0.85, p.y < 0.05)", roughness: "0.55", normal: "vec3f(0.0, 1.0, 0.0)" })],
  })
  renderer.resize(width, height)

  const solid = new Mesh()
  solid.box(-400, -1, -400, 400, 0, 400, [0.42, 0.42, 0.42], MAT.ground)
  solid.box(-1000, -1000, -1000, 1000, 1000, 1000, [1, 1, 1], MAT.glow, -1)
  solid.box(-70, 0, 135, 25, 19, 160, [0.25, 0.25, 0.27])
  solid.box(-20, 0, 165, 60, 26, 185, [0.25, 0.25, 0.27])
  solid.box(-9, 0, 30, -4.6, 1.45, 32, [0.08, 0.2, 0.18])
  solid.box(5.5, 0, 33, 9.5, 2.8, 37, [0.4, 0.38, 0.33])
  for (const [x, y, z] of HEADS) {
    const side = x > 0 ? 1 : -1
    solid.box(x + side * 1.4 - 0.09, 0, z - 0.09, x + side * 1.4 + 0.09, y + 0.2, z + 0.09, [0.2, 0.2, 0.2])
    solid.box(Math.min(x, x + side * 1.4) - 0.05, y + 0.1, z - 0.05, Math.max(x, x + side * 1.4) + 0.05, y + 0.2, z + 0.05, [0.2, 0.2, 0.2])
    solid.box(x - 0.25, y - 0.05, z - 0.12, x + 0.25, y + 0.1, z + 0.12, [0.15, 0.15, 0.15])
  }
  const model = renderer.addModel(solid)
  const inst = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0])

  const eye: Vec3 = [1.5, 1.7, 0]
  const viewProj = mat4.multiply(mat4.perspective(0.95, width / height, 0.15, 1200), mat4.lookAt(eye, [2.5, 3.2, 40], [0, 1, 0])) as Float32Array
  const frame = new Float32Array(FRAME_FLOATS)
  frame.set(viewProj, 0)
  frame.set([...eye, 1], 16)
  frame.set([width, height, HEADS.length, 0], 20)
  // No monitor-light suffix: the first "monitor" light is past the last light.
  frame[35] = HEADS.length
  const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  HEADS.forEach(([x, y, z], i) => lights.set([x, y, z, 40, ...SODIUM, POWER, 0, 0, 0, 0, 0, 0, 0.45, -1], i * LIGHT_FLOATS))
  const lamps: FogLamp[] = HEADS.map(([x, y, z], i) => ({ x, y, z, range: 40, color: SODIUM, intensity: (POWER * GAIN) / Math.PI, ...cone, size: 0.45, id: i }))
  const fog = new FogScatter(createFogSettings())
  const glows = new Float32Array(HEADS.length * SPRITE_FLOATS)
  const medium = () => ({ density: fog.settings.density, falloff: fog.settings.falloff, base: fog.settings.base })
  const empty = new Float32Array(SPRITE_FLOATS)
  let time = 1

  return {
    renderer,
    fog,
    eye,
    viewProj,
    input(fogOn, plain = false) {
      fog.settings.mode = fogOn ? "scatter" : "today"
      frame[19] = time += 1 / 60
      let o = 0
      for (const [x, y, z] of HEADS) o = packLampGlow(glows, o, { x, y: y - 0.06, z }, 0.9, [SODIUM[0] * 60, SODIUM[1] * 60, SODIUM[2] * 60], eye, medium())
      return {
        frame,
        lights,
        lightCount: HEADS.length,
        shadowLightCount: 0,
        occluders: new Float32Array(MAX_OCCLUDERS * OCC_FLOATS),
        occluderCount: 0,
        lampPower: new Float32Array(MAX_MAP_LIGHTS),
        lampCount: 0,
        view: [-500, -500, 500, 500],
        batches: [{ model, data: inst, count: 1 }],
        alphaSprites: empty,
        alphaCount: 0,
        addSprites: glows,
        addCount: HEADS.length,
        grade: [0, 0, 0, 2 ** -2.2],
        fog: fog.update({ eye, viewProj, lamps }),
        volume: [plain ? { downscale: 2 } : null, fog.volumeInput()],
      }
    },
  }
}
