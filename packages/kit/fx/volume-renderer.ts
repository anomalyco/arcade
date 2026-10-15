import { GRID, SmokeVolumes, VOLUMES } from "./volume"
import { VolumeFrameStruct, volumeShader } from "./volume-shader"

export { VolumeFrameStruct }

export type VolumeFrameInput = {
  inverse?: ArrayLike<number>
  eye?: ArrayLike<number>
  ambient?: ArrayLike<number>
  lights?: Float32Array
  lightCount?: number
  lightStride?: number
  minLightPower?: number
  volumes?: SmokeVolumes
  debug?: number
}

const EYE_OFFSET = VolumeFrameStruct.offsetOf("eye")
const TIME_OFFSET = VolumeFrameStruct.offsetOf("time")
const SCREEN_SIZE_OFFSET = VolumeFrameStruct.offsetOf("screenSize")
const LIGHT_COUNT_OFFSET = VolumeFrameStruct.offsetOf("lightCount")
const DEBUG_OFFSET = VolumeFrameStruct.offsetOf("debug")
const AMBIENT_OFFSET = VolumeFrameStruct.offsetOf("ambient")
const COLOR_SHIFT_OFFSET = VolumeFrameStruct.offsetOf("colorShift")
const BOXES_OFFSET = VolumeFrameStruct.offsetOf("boxes")
const LIGHTS_OFFSET = VolumeFrameStruct.offsetOf("lights")
const HEIGHT_OFFSET = VolumeFrameStruct.offsetOf("height")
const BILLOW_SCALE_OFFSET = VolumeFrameStruct.offsetOf("billowScale")
const EXTINCTION_OFFSET = VolumeFrameStruct.offsetOf("extinction")
const LIGHTING_OFFSET = VolumeFrameStruct.offsetOf("lighting")
const RISE_OFFSET = VolumeFrameStruct.offsetOf("rise")
const WIND_OFFSET = VolumeFrameStruct.offsetOf("wind")
const TURBULENCE_OFFSET = VolumeFrameStruct.offsetOf("turbulence")
const CORE_GLOW_OFFSET = VolumeFrameStruct.offsetOf("coreGlow")
const ADVECTION_OFFSET = VolumeFrameStruct.offsetOf("advection")

/** Caller supplies its inverse view-projection, camera, HDR target and readable 4x MSAA depth.
 * The renderer caps at 480x320 pixels, 24 steps, four volumes and eight lights.
 * Light input is eight floats per light: xyz/radius, rgb/intensity. */
export class VolumeRenderer {
  readonly uniforms = VolumeFrameStruct.createBuffer()
  private readonly buffer: GPUBuffer
  private readonly field: GPUTexture
  private readonly noise: GPUTexture
  private readonly jitter: GPUTexture
  private readonly sampler: GPUSampler
  private readonly repeat: GPUSampler
  private readonly layout: GPUBindGroupLayout
  private readonly march: GPURenderPipeline
  private readonly composite: GPURenderPipeline
  private low?: GPUTexture
  private lowView!: GPUTextureView
  private dummy: GPUTexture
  private marchGroup!: GPUBindGroup
  private compositeGroup!: GPUBindGroup
  private pass!: GPURenderPassDescriptor
  private compositeAttachment:GPURenderPassColorAttachment|null=null
  private compositePass!:GPURenderPassDescriptor
  private destination: GPUTexelCopyTextureInfo
  private readonly uploadLayout = { bytesPerRow: GRID * 4, rowsPerImage: GRID }
  private readonly extent = { width: GRID, height: GRID, depthOrArrayLayers: VOLUMES }
  enabled = true
  debug = 0
  constructor(private readonly device: GPUDevice) {
    const d = device, usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    this.buffer = d.createBuffer({ size: this.uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.field = d.createTexture({ size: [GRID,GRID,VOLUMES], format: "rg16float", usage }); this.destination = { texture: this.field }
    this.noise = d.createTexture({ size: [32,32,32], dimension: "3d", format: "r8unorm", usage })
    let seed = 1729
    const noise = new Uint8Array(32**3)
    for (let i=0;i<noise.length;i++) { seed = Math.imul(seed,1664525)+1013904223|0; noise[i]=seed>>>24 }
    d.queue.writeTexture({texture:this.noise},noise,{bytesPerRow:32,rowsPerImage:32},[32,32,32])
    this.jitter = d.createTexture({size:[32,32],format:"r8unorm",usage})
    // Progressive toroidal farthest-point ranks: high-frequency spatial jitter, fixed between frames.
    const ranks = new Uint8Array(1024), distances = new Float32Array(1024).fill(Infinity)
    let chosen = 379
    for (let rank=0;rank<1024;rank++) {
      ranks[chosen]=rank*255/1023; distances[chosen]=-1
      let best=-1, next=0
      for (let i=0;i<1024;i++) {
        if (distances[i]<0) continue
        let dx=Math.abs(i%32-chosen%32),dy=Math.abs((i>>5)-(chosen>>5));dx=Math.min(dx,32-dx);dy=Math.min(dy,32-dy)
        distances[i]=Math.min(distances[i],dx*dx+dy*dy)
        const score=distances[i]+noise[i]*0.0001
        if(score>best){best=score;next=i}
      }
      chosen=next
    }
    d.queue.writeTexture({texture:this.jitter},ranks,{bytesPerRow:32},[32,32])
    this.sampler=d.createSampler({minFilter:"linear",magFilter:"linear"})
    this.repeat=d.createSampler({minFilter:"linear",magFilter:"linear",addressModeU:"repeat",addressModeV:"repeat",addressModeW:"repeat"})
    this.dummy=d.createTexture({size:[1,1],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING})
    this.layout=d.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},
      {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:"2d-array"}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{}},
      {binding:3,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"depth",multisampled:true}},
      {binding:4,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:"3d"}},
      {binding:5,visibility:GPUShaderStage.FRAGMENT,sampler:{}},
      {binding:6,visibility:GPUShaderStage.FRAGMENT,texture:{}},
      {binding:7,visibility:GPUShaderStage.FRAGMENT,texture:{}},
    ]})
    const module=d.createShaderModule({code:volumeShader,label:"kit volume"}), layout=d.createPipelineLayout({bindGroupLayouts:[this.layout]})
    const pipeline=(entryPoint:string, blend?:GPUBlendState)=>d.createRenderPipeline({layout,vertex:{module,entryPoint:"vs"},fragment:{module,entryPoint,targets:[{format:"rgba16float",blend}]}})
    this.march=pipeline("march")
    this.composite=pipeline("upsample",{color:{srcFactor:"one",dstFactor:"one-minus-src-alpha"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha"}})
  }
  resize(width:number,height:number,depth:GPUTextureView) {
    this.low?.destroy()
    const scale=Math.min(0.5,480/width,320/height)
    this.low=this.device.createTexture({size:[Math.max(1,Math.ceil(width*scale)),Math.max(1,Math.ceil(height*scale))],format:"rgba16float",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING})
    this.lowView=this.low.createView()
    const group=(cloud:GPUTextureView)=>this.device.createBindGroup({layout:this.layout,entries:[
      {binding:0,resource:{buffer:this.buffer}},{binding:1,resource:this.field.createView({dimension:"2d-array"})},
      {binding:2,resource:this.sampler},{binding:3,resource:depth},{binding:4,resource:this.noise.createView()},
      {binding:5,resource:this.repeat},{binding:6,resource:this.jitter.createView()},{binding:7,resource:cloud},
    ]})
    this.marchGroup=group(this.dummy.createView());this.compositeGroup=group(this.lowView)
    this.uniforms[SCREEN_SIZE_OFFSET]=width;this.uniforms[SCREEN_SIZE_OFFSET + 1]=height
    this.pass={label:"smoke low resolution",colorAttachments:[{view:this.lowView,clearValue:{r:0,g:0,b:0,a:0},loadOp:"clear",storeOp:"store"}]}
  }

  /** Updates frame uniforms using named fields instead of raw float offsets. */
  setFrame(input: VolumeFrameInput): void {
    const u = this.uniforms
    if (input.inverse) {
      for (let i = 0; i < 16; i++) u[i] = input.inverse[i] ?? 0
    }
    if (input.eye) {
      u[EYE_OFFSET] = input.eye[0] ?? 0
      u[EYE_OFFSET + 1] = input.eye[1] ?? 0
      u[EYE_OFFSET + 2] = input.eye[2] ?? 0
    }
    if (input.ambient) {
      u[AMBIENT_OFFSET] = input.ambient[0] ?? 0
      u[AMBIENT_OFFSET + 1] = input.ambient[1] ?? 0
      u[AMBIENT_OFFSET + 2] = input.ambient[2] ?? 0
    }
    if (input.debug !== undefined) {
      this.debug = input.debug
    }
    if (input.lights !== undefined) {
      const stride = input.lightStride ?? 8
      const total = input.lightCount ?? Math.floor(input.lights.length / stride)
      const minPower = input.minLightPower ?? -Infinity
      const vols = input.volumes
      let written = 0
      for (let i = 0; i < total && written < 8; i++) {
        const k = i * stride
        if (input.lights[k + 7]! <= minPower) continue
        if (vols) {
          let nearby = false
          for (let s = 0; s < 4; s++) {
            if (
              vols.bounds[s * 8 + 7]! > 0 &&
              Math.hypot(input.lights[k]! - vols.bounds[s * 8 + 4]!, input.lights[k + 2]! - vols.bounds[s * 8 + 5]!) <
                input.lights[k + 3]! + 5
            ) {
              nearby = true
            }
          }
          if (!nearby) continue
        }
        for (let j = 0; j < 8; j++) u[LIGHTS_OFFSET + written * 8 + j] = input.lights[k + j]!
        written++
      }
      u[LIGHT_COUNT_OFFSET] = minPower === -Infinity && !vols && input.lightCount !== undefined ? input.lightCount : written
    } else if (input.lightCount !== undefined) {
      u[LIGHT_COUNT_OFFSET] = input.lightCount
    }
  }

  upload(volumes:SmokeVolumes) {
    this.uniforms[TIME_OFFSET]=volumes.time;this.uniforms[DEBUG_OFFSET]=this.debug;this.uniforms[COLOR_SHIFT_OFFSET]=volumes.colorShift
    this.uniforms.set(volumes.bounds,BOXES_OFFSET)
    const s=volumes.settings
    this.uniforms[HEIGHT_OFFSET]=s.height;this.uniforms[BILLOW_SCALE_OFFSET]=s.billowScale;this.uniforms[EXTINCTION_OFFSET]=s.extinction;this.uniforms[LIGHTING_OFFSET]=s.lighting
    this.uniforms[RISE_OFFSET]=s.rise;this.uniforms[WIND_OFFSET]=s.wind;this.uniforms[TURBULENCE_OFFSET]=s.turbulence;this.uniforms[CORE_GLOW_OFFSET]=volumes.coreGlow
    this.uniforms.set(volumes.advection,ADVECTION_OFFSET)
    this.device.queue.writeBuffer(this.buffer,0,this.uniforms)
    this.device.queue.writeTexture(this.destination,volumes.field,this.uploadLayout,this.extent)
  }
  render(encoder:GPUCommandEncoder,target:GPUTextureView,volumes:SmokeVolumes) {
    if(!this.enabled||!volumes.count)return
    this.upload(volumes)
    const p=encoder.beginRenderPass(this.pass);p.setPipeline(this.march);p.setBindGroup(0,this.marchGroup);p.draw(3);p.end()
    if(!this.compositeAttachment){this.compositeAttachment={view:target,loadOp:"load",storeOp:"store"};this.compositePass={label:"smoke depth-aware upsample",colorAttachments:[this.compositeAttachment]}}
    this.compositeAttachment.view=target
    const c=encoder.beginRenderPass(this.compositePass)
    c.setPipeline(this.composite);c.setBindGroup(0,this.compositeGroup);c.draw(3);c.end()
  }
  destroy(){this.buffer.destroy();this.field.destroy();this.noise.destroy();this.jitter.destroy();this.low?.destroy();this.dummy.destroy()}
}
