import { fogSceneWgsl, fogScatterVolume } from "@arcade/kit/gpu/fog-scatter"
import { withPhysicalLights } from "@arcade/kit/gpu/lights/physical"
import { postShader, type SceneHooks } from "@arcade/kit/gpu/shaders"
import { AUX } from "./world-view"

/**
 * Stock kit night shading for the toy: physical lights (beams, spots, points), the shared fog medium for sky, skylight
 * and distance, and two tags from `world-view.ts`: the sky dome and the flagging tape, whose lit colour is boosted so
 * a trail reads back in a beam (cheap retroreflection).
 */
const uniform = `struct Woods { look: vec4f }
@group(0) @binding(13) var<uniform> W: Woods;`
/** Floats in the Woods uniform: look = (night sky light, tape gain, tape shine per metre, unused). */
export const WOODS_FLOATS = 4

export const fogVolume = (atmosphere: boolean) => fogScatterVolume({ declarations: uniform, atmosphere })

const base: SceneHooks = {
  lampGrid: false,
  declarations: uniform + fogSceneWgsl,
  bounce: "vec3f(0.0)",
  directional: "vec3f(0.0)",
  lightLeak: "0.0",
  wallDirectScale: "1.0",
  ambient: "fogAmbient(n)*W.look.x",
  material: /* wgsl */ `
    pbrRough=0.88;
    if(mat==10) { pbrRough=select(0.35,0.06,abs(o.aux-${AUX.water}.0)<0.5); }
    if(mat==12) { pbrRough=0.7; }
  `,
  surface: /* wgsl */ `
    if(mat==3 && o.aux<-0.5) {
      col=fogSky(F.cam.xyz,normalize(o.world-F.cam.xyz));
    } else {
      // Tape stays readable down a trail: brighter with distance, against the beam's falloff.
      if(mat==0 && abs(o.aux-${AUX.tape}.0)<0.5) { col*=W.look.y*(0.45+length(o.world-F.cam.xyz)*W.look.z); }
      col=fogApply(col,F.cam.xyz,o.world);
    }
  `,
}

export const hooks = withPhysicalLights(base, { env: "mix(fogEnv(dir),fogAmbient(n),rough*rough)" })

export const post = postShader(false, false, { chromatic: 0, bloom: 0.24, grain: 0.012, vignette: 0.42, bloomGate: { cap: 0.04, hot: 2 }, saturation: 0.92, shadowLiftColor: [0.0002, 0.0004, 0.0006], shadowTint: [0.92, 1, 1.04], highlightTint: [1.04, 1, 0.92] })
