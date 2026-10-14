import { GRID, SmokeVolumes, VOLUMES } from "./volume"
import { volumeShader } from "./volume-shader"

/** Caller supplies its inverse view-projection, camera, HDR target and readable 4x MSAA depth.
 * The renderer caps at 480x320 pixels, 24 steps, four volumes and eight lights.
 * Light input is eight floats per light: xyz/radius, rgb/intensity. */
export class VolumeRenderer {
  readonly uniforms = new Float32Array(136)
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
    this.uniforms[20]=width;this.uniforms[21]=height
    this.pass={label:"smoke low resolution",colorAttachments:[{view:this.lowView,clearValue:{r:0,g:0,b:0,a:0},loadOp:"clear",storeOp:"store"}]}
  }
  upload(volumes:SmokeVolumes) {
    this.uniforms[19]=volumes.time;this.uniforms[23]=this.debug;this.uniforms[27]=volumes.colorShift
    this.uniforms.set(volumes.bounds,28)
    const s=volumes.settings
    this.uniforms[124]=s.height;this.uniforms[125]=s.billowScale;this.uniforms[126]=s.extinction;this.uniforms[127]=s.lighting
    this.uniforms[128]=s.rise;this.uniforms[129]=s.wind;this.uniforms[130]=s.turbulence;this.uniforms[131]=volumes.coreGlow
    this.uniforms.set(volumes.advection,132)
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
