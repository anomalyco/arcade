import TAAUNode from "three/addons/tsl/display/TAAUNode.js"
import { clipAABB, sampleCurrentDepth, samplePreviousDepth } from "three/addons/tsl/utils/TAAUtils.js"
import { Fn as TslFn, context, convertToTexture, exp, float, ivec2, luminance, max, mix, outputStruct, property, texture, uniform, uv, vec2, vec4, velocity } from "three/tsl"
import { Matrix4, type Camera } from "three/webgpu"

// three's TAAU with a sharper resolve. Two changes to its resolve shader, the rest (jitter, history, depth tests,
// locks, variance clip) is three's:
// - The reconstruction kernel narrows towards one *output* pixel at rest (three's is ~1 input pixel wide, which at a
//   2× upscale converges to a visibly soft image) and widens back to three's width in motion, where a single frame's
//   samples are all there is.
// - History is read with a 5-tap Catmull-Rom filter instead of bilinear, so reprojection while moving doesn't blur a
//   little more every frame (the smear in motion).
// - Reconstruction, neighbourhood clip and history blend all run on tone-compressed colour (c / (1 + max(c)), Karis),
//   so a panel rim or lit window edge that is 50× brighter than the wall beside it converges like any other edge
//   instead of flickering pixel by pixel; the result is expanded back to linear HDR.
// - The jitter spans 0.75 of an output pixel while the camera is still (full span in motion).
// - The velocity node keeps the unjittered projection between frames. Stock TAAU resets it to null after every frame,
//   so any material compiled outside the pipeline (the boot warm-up and streamed modules compile between frames) baked
//   the *jittered* camera projection into its velocity: a static camera then reported the jitter as motion, history
//   was reprojected by it and nothing accumulated, so every bright edge flickered pixel by pixel.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any
const Fn = TslFn as N

/** Catmull-Rom history sample from 5 bilinear taps (the corners of the 4×4 stencil dropped). */
const catmullRom = (tex: N, uvIn: N, size: N) => {
  const pos = uvIn.mul(size)
  const c = pos.sub(0.5).floor().add(0.5)
  const f = pos.sub(c)
  const w0 = f.mul(f.mul(f.mul(-0.5).add(1)).sub(0.5))
  const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1)
  const w2 = f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5))
  const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5))
  const w12 = w1.add(w2)
  const t0 = c.sub(1).div(size)
  const t3 = c.add(2).div(size)
  const t12 = c.add(w2.div(w12)).div(size)
  const s = (x: N, y: N) => tex.sample(vec2(x, y))
  const sum = s(t12.x, t0.y)
    .mul(w12.x.mul(w0.y))
    .add(s(t0.x, t12.y).mul(w0.x.mul(w12.y)))
    .add(s(t12.x, t12.y).mul(w12.x.mul(w12.y)))
    .add(s(t3.x, t12.y).mul(w3.x.mul(w12.y)))
    .add(s(t12.x, t3.y).mul(w12.x.mul(w3.y)))
  const wsum = w12.x.mul(w0.y).add(w0.x.mul(w12.y)).add(w12.x.mul(w12.y)).add(w3.x.mul(w12.y)).add(w12.x.mul(w3.y))
  return sum.div(wsum).max(0)
}

/** Karis tone compression and its inverse (on rgb; alpha passes through). */
const compress = (c: N) => vec4(c.rgb.div(max(max(c.r, c.g), c.b).add(1)), c.a)
const expand = (c: N) => vec4(c.rgb.div(float(1).sub(max(max(c.r, c.g), c.b)).max(1e-4)), c.a)

const REST_JITTER = 0.75
/** One projection object for every material's velocity, shared across TAAU rebuilds (materials keep a reference). */
const VELOCITY_PROJECTION = new Matrix4()

class SharpTAAUNode extends (TAAUNode as unknown as new (...a: N[]) => N) {
  /** 0 = three's kernel width at rest, 1 = narrowed to one output pixel. */
  readonly sharpness = uniform(1)
  private lastCamera: number[] = []

  constructor(...args: N[]) {
    super(...args)
    velocity.setProjectionMatrix(VELOCITY_PROJECTION)
  }

  clearViewOffset() {
    super.clearViewOffset()
    velocity.setProjectionMatrix(VELOCITY_PROJECTION)
  }

  setViewOffset(inputWidth: number, inputHeight: number) {
    const self = this as N
    super.setViewOffset(inputWidth, inputHeight)
    VELOCITY_PROJECTION.copy(self._originalProjectionMatrix)
    velocity.setProjectionMatrix(VELOCITY_PROJECTION)
    const e = self.camera.matrixWorld.elements as number[]
    let still = this.lastCamera.length === 16
    for (let i = 0; i < 16; i++) {
      if (still && Math.abs(e[i]! - this.lastCamera[i]!) > 1e-6) still = false
      this.lastCamera[i] = e[i]!
    }
    if (!still) return
    const j = self._jitterOffset.value
    j.multiplyScalar(REST_JITTER)
    self.camera.setViewOffset(inputWidth, inputHeight, j.x, j.y, inputWidth, inputHeight)
  }

  setup(builder: N) {
    const result = super.setup(builder)
    const self = this as N
    const historyNode = texture(self._historyRenderTarget.textures[0]) as N
    const lockNode = texture(self._historyRenderTarget.textures[1]) as N
    const colorOutput = property("vec4") as N
    const lockOutput = property("vec4") as N
    const outputNode = outputStruct(colorOutput, lockOutput)

    const resolve = Fn(() => {
      const uvNode = uv() as N
      const inputSizeF = vec2(self.beautyNode.size()) as N
      const outputSizeF = vec2(historyNode.size()) as N
      const pIn = uvNode.mul(inputSizeF)
      const closestTapF = pIn.sub(vec2(0.5).add(self._jitterOffset)).round()
      const closestTap = ivec2(closestTapF)

      const currentDepth = sampleCurrentDepth(self.depthNode, closestTapF, self._cameraNearFar)
      const closestDepth = currentDepth.get("closestDepth")
      const closestPositionTexel = currentDepth.get("closestPositionTexel")
      const farthestDepth = currentDepth.get("farthestDepth")

      const offsetUV = self.velocityNode.load(closestPositionTexel).xy.mul(vec2(0.5, -0.5))
      const historyUV = uvNode.sub(offsetUV)
      const previousDepth = samplePreviousDepth(
        self._previousDepthNode,
        historyUV,
        self._previousCameraProjectionMatrixInverse,
        self._previousCameraWorldMatrix,
        self._cameraWorldMatrixInverse,
        self._cameraNearFar,
        self.camera,
      )

      const isValidUV = historyUV.greaterThanEqual(0).all().and(historyUV.lessThanEqual(1).all())
      const isEdge = farthestDepth.sub(closestDepth).greaterThan(self.edgeDepthDiff)
      const isDisocclusion = closestDepth.sub(previousDepth).greaterThan(self.depthThreshold)
      const hasValidHistory = isValidUV.and(isEdge.or(isDisocclusion.not()))

      // Motion in output pixels: the kernel stays narrow for sub-pixel drift and widens over a few pixels of motion.
      const motionPx = uvNode.sub(historyUV).mul(outputSizeF).length()
      const motionFactor = uvNode.sub(historyUV).mul(inputSizeF).length().div(self.maxVelocityLength).saturate()
      const upscale = outputSizeF.x.div(inputSizeF.x).max(1)
      const tight = mix(float(1), upscale.mul(upscale), self.sharpness).mul(motionPx.div(3).saturate().oneMinus())
      const k = float(2.29).mul(tight.max(1))

      const sumColor = vec4(0).toVar()
      const sumWeight = float(0).toVar()
      const moment1 = vec4(0).toVar()
      const moment2 = vec4(0).toVar()
      const boxMin = vec4(1e9).toVar()
      const boxMax = vec4(0).toVar()
      const offsets = [
        [-1, -1], [0, -1], [1, -1],
        [-1, 0], [0, 0], [1, 0],
        [-1, 1], [0, 1], [1, 1],
      ] as const
      for (const [x, y] of offsets) {
        const tap = closestTap.add(ivec2(x, y))
        const tapCenter = vec2(tap).add(vec2(0.5).add(self._jitterOffset))
        const delta = pIn.sub(tapCenter)
        const w = exp(delta.dot(delta).mul(k).negate()).add(x === 0 && y === 0 ? 1e-6 : 0)
        const c = compress(self.beautyNode.load(tap).max(0))
        sumColor.addAssign(c.mul(w))
        sumWeight.addAssign(w)
        moment1.addAssign(c)
        moment2.addAssign(c.pow2())
        boxMin.assign(boxMin.min(c))
        boxMax.assign(boxMax.max(c))
      }
      const currentColor = sumColor.div(sumWeight.max(1e-8))

      const n = float(offsets.length)
      const mean = moment1.div(n)
      // At rest the clip box widens to 2σ (bounded by the neighbourhood's min/max, so nothing outside the local
      // colours survives): a 1σ box sits inside the jittering edge of a bright window and drags the history with the
      // jitter every frame, which shimmered on every lit edge. In motion it tightens to three's 0.5σ.
      const varianceGamma = mix(0.5, 2, motionFactor.oneMinus().pow2().mul(motionPx.div(2).saturate().oneMinus()))
      const variance = moment2.div(n).sub(mean.pow2()).max(0).sqrt().mul(varianceGamma)
      const minColor = mean.sub(variance).max(boxMin)
      const maxColor = mean.add(variance).min(boxMax)

      const historyColor = compress(catmullRom(historyNode, historyUV, outputSizeF))
      const clippedHistoryColor = clipAABB(mean.clamp(minColor, maxColor), historyColor, minColor, maxColor)

      const currentLuma = luminance(currentColor.rgb)
      const meanLuma = (luminance(mean.rgb) as N).toConst()
      const thinFeature = currentLuma.sub(meanLuma).abs().div(meanLuma).smoothstep(0, 0.2)
      const isDepthChanged = closestDepth.sub(previousDepth).abs().greaterThan(self.depthThreshold)
      const canLock = isValidUV.and(isDepthChanged.not())
      const gatedThinFeature = canLock.select(thinFeature, float(0))
      const decay = isDisocclusion.select(0, 0.5)
      const lock = max(gatedThinFeature, lockNode.sample(historyUV).r.mul(decay)).saturate()
      const lockedHistoryColor = mix(clippedHistoryColor, historyColor, lock)

      // 0.3× the current-frame weight when still: residual jitter aliasing on bright edges (lit windows) shrinks with
      // it; motion, disocclusion and the variance clip still bring new content in quickly.
      const currentWeight = float(self.currentFrameWeight).mul(mix(float(0.3), float(1), motionPx.saturate())).toVar()
      currentWeight.assign(hasValidHistory.select(currentWeight.add(motionFactor).saturate(), 1))
      colorOutput.assign(expand(mix(lockedHistoryColor, currentColor, currentWeight)))
      lockOutput.assign(lock)
      return vec4(0)
    })

    self._resolveMaterial.contextNode = context(builder.getSharedContext())
    self._resolveMaterial.colorNode = resolve()
    self._resolveMaterial.outputNode = outputNode
    self._resolveMaterial.needsUpdate = true
    return result
  }
}

export function sharpTaau(beauty: N, depth: N, velocity: N, camera: Camera) {
  return new SharpTAAUNode(convertToTexture(beauty), depth, velocity, camera) as N
}
