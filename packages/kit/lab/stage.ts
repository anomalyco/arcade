import { FrameTimer } from "../fx/frame-timer"
import { ParticleRenderer } from "../fx/particle-renderer"
import { Particles } from "../fx/particles"
import { SmokeRenderer } from "../fx/tyre-renderer"
import type { SmokeTrail } from "../fx/smoke-trail"
import { VolumeRenderer } from "../fx/volume-renderer"
import type { SmokeVolumes, Wall } from "../fx/volume"
import { polarShader, stageShader } from "./stage-shader"
import { lightingDefaults } from "./lighting"
import { LabMeshes } from "./meshes"

export const walls:readonly Wall[]=[[-6,-4,6,-3.6],[-6,-4,-5.6,5],[5.6,-4,6,-1],[5.6,1,6,5],[-6,4.6,6,5]]
const lightX=[-4,4,-4,4,0,0,-7,7],lightZ=[-2,2,3,-3,-6,6,0,0]
const tyreCommon=/* wgsl */`
struct Frame { viewProj:mat4x4f,cam:vec4f,screen:vec4f,moonDir:vec4f }
struct Light {pos:vec4f,color:vec4f,dir:vec4f}
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<storage,read> lights:array<Light>;
`
export type LabLight={x:number;y:number;z:number;radius:number;r:number;g:number;b:number;power:number;dx?:number;dy?:number;dz?:number;cone?:number}
export type CameraWriter=(width:number,height:number,vp:Float32Array,inverse:Float32Array,eye:Float32Array,focus:readonly number[])=>void
export type StageMarker={x:number;y:number;z:number;radius?:number;yaw?:number;kind?:"select"|"hover"|"ghost"|"invalid"}

const DEFAULT_PITCH = Math.atan2(22, 23)
const DEFAULT_DIST = Math.hypot(22, 23)

function writeOrbitCamera(width: number, height: number, vp: Float32Array, inverse: Float32Array, eye: Float32Array, focus: readonly number[], yaw: number, pitch: number, dist: number) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw)
  const ex = focus[0]! + sy * cp * dist
  const ey = focus[1]! + sp * dist
  const ez = focus[2]! + cy * cp * dist
  eye[0] = ex; eye[1] = ey; eye[2] = ez
  // Forward (from target to eye for right-handed lookAt)
  let zx = ex - focus[0]!, zy = ey - focus[1]!, zz = ez - focus[2]!
  const zlen = Math.hypot(zx, zy, zz) || 1; zx /= zlen; zy /= zlen; zz /= zlen
  let xx = zz, xy = 0, xz = -zx
  const xlen = Math.hypot(xx, xy, xz) || 1; xx /= xlen; xy /= xlen; xz /= xlen
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx
  const aspect = Math.max(0.1, width / Math.max(1, height))
  const f = 1 / Math.tan(0.65 * 0.5), near = 0.1, far = 150, nf = 1 / (near - far)
  const p0 = f / aspect, p5 = f, p10 = far * nf, p14 = far * near * nf
  const tx = -(xx * ex + xy * ey + xz * ez)
  const ty = -(yx * ex + yy * ey + yz * ez)
  const tz = -(zx * ex + zy * ey + zz * ez)
  vp[0] = p0 * xx; vp[1] = p5 * yx; vp[2] = p10 * zx; vp[3] = -zx
  vp[4] = p0 * xy; vp[5] = p5 * yy; vp[6] = p10 * zy; vp[7] = -zy
  vp[8] = p0 * xz; vp[9] = p5 * yz; vp[10] = p10 * zz; vp[11] = -zz
  vp[12] = p0 * tx; vp[13] = p5 * ty; vp[14] = p10 * tz + p14; vp[15] = -tz
  invertMat4(vp, inverse)
}

function invertMat4(m: Float32Array, out: Float32Array) {
  const m00 = m[0]!, m01 = m[1]!, m02 = m[2]!, m03 = m[3]!
  const m10 = m[4]!, m11 = m[5]!, m12 = m[6]!, m13 = m[7]!
  const m20 = m[8]!, m21 = m[9]!, m22 = m[10]!, m23 = m[11]!
  const m30 = m[12]!, m31 = m[13]!, m32 = m[14]!, m33 = m[15]!
  const b00 = m00 * m11 - m01 * m10, b01 = m00 * m12 - m02 * m10, b02 = m00 * m13 - m03 * m10
  const b03 = m01 * m12 - m02 * m11, b04 = m01 * m13 - m03 * m11, b05 = m02 * m13 - m03 * m12
  const b06 = m20 * m31 - m21 * m30, b07 = m20 * m32 - m22 * m30, b08 = m20 * m33 - m23 * m30
  const b09 = m21 * m32 - m22 * m31, b10 = m21 * m33 - m23 * m31, b11 = m22 * m33 - m23 * m32
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return
  det = 1 / det
  out[0] = (m11 * b11 - m12 * b10 + m13 * b09) * det
  out[1] = (m02 * b10 - m01 * b11 - m03 * b09) * det
  out[2] = (m31 * b05 - m32 * b04 + m33 * b03) * det
  out[3] = (m22 * b04 - m21 * b05 - m23 * b03) * det
  out[4] = (m12 * b08 - m10 * b11 - m13 * b07) * det
  out[5] = (m00 * b11 - m02 * b08 + m03 * b07) * det
  out[6] = (m32 * b02 - m30 * b05 - m33 * b01) * det
  out[7] = (m20 * b05 - m22 * b02 + m23 * b01) * det
  out[8] = (m10 * b10 - m11 * b08 + m13 * b06) * det
  out[9] = (m01 * b08 - m00 * b10 - m03 * b06) * det
  out[10] = (m30 * b04 - m31 * b02 + m33 * b00) * det
  out[11] = (m21 * b02 - m20 * b04 - m23 * b00) * det
  out[12] = (m11 * b07 - m10 * b09 - m12 * b06) * det
  out[13] = (m00 * b09 - m01 * b07 + m02 * b06) * det
  out[14] = (m31 * b01 - m30 * b03 - m32 * b00) * det
  out[15] = (m20 * b03 - m21 * b01 + m22 * b00) * det
}

function buildRingVertices(inner = 0.92, outer = 1.0, height = 0.03, segments = 28, arrow = true): number[] {
  const out: number[] = []
  const tri = (a: number[], b: number[], c: number[], n: number[]) => {
    for (const p of [a, b, c]) out.push(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, 1, 1, 1, -1.4)
  }
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1)
    const p0 = [s0 * inner, height, c0 * inner], p1 = [s0 * outer, height, c0 * outer]
    const p2 = [s1 * outer, height, c1 * outer], p3 = [s1 * inner, height, c1 * inner]
    tri(p0, p1, p2, [0, 1, 0]); tri(p0, p2, p3, [0, 1, 0])
  }
  if (arrow) {
    const a = [-0.12, height + 0.01, outer], b = [0.12, height + 0.01, outer], c = [0, height + 0.01, outer + 0.24]
    tri(a, b, c, [0, 1, 0])
  }
  return out
}

export class Stage {
  readonly lighting=lightingDefaults()
  readonly particles:ParticleRenderer
  readonly volume:VolumeRenderer
  readonly device:GPUDevice
  readonly meshes:LabMeshes
  readonly transients=new Particles()
  private readonly transientRenderer:ParticleRenderer
  readonly focus=[0,0,0]
  readonly targetFocus=[0,0,0]
  camYaw=0
  camPitch=DEFAULT_PITCH
  camDist=DEFAULT_DIST
  targetYaw=0
  targetPitch=DEFAULT_PITCH
  targetDist=DEFAULT_DIST
  hasDampedTarget=false
  camCustom=false
  showMarkers=false
  readonly markers:StageMarker[]=[]
  private readonly ringModel:number
  dynamicLights:LabLight[]|null=null
  /** Optional effect-study camera and post-HDR distortion; cleared when that section leaves. */
  cameraOverride?:CameraWriter
  afterScene?:(encoder:GPUCommandEncoder,hdr:GPUTexture,depth:GPUTextureView,width:number,height:number)=>void
  onFrameSubmitted?:()=>void
  private readonly tyre:SmokeRenderer
  private readonly tyreBuffer:GPUBuffer
  private readonly tyreLights:GPUBuffer
  private readonly tyreGroup:GPUBindGroup
  private readonly tyreFrame=new Float32Array(28)
  private readonly frame=new Float32Array(148)
  readonly inverse=this.frame.subarray(0,16)
  readonly viewProj=this.frame.subarray(16,32)
  readonly eye=this.frame.subarray(32,35)
  private readonly lightData=this.frame.subarray(52)
  private readonly buffer:GPUBuffer
  private readonly group:GPUBindGroup
  private readonly computeGroup:GPUBindGroup
  private readonly polar:GPUComputePipeline
  private readonly scene:GPURenderPipeline
  private readonly post:GPURenderPipeline
  private readonly postLayout:GPUBindGroupLayout
  private postGroup!:GPUBindGroup
  private textures:GPUTexture[]=[]
  private hdr!:GPUTextureView
  private hdrTexture!:GPUTexture
  private depthView!:GPUTextureView
  private output!:GPUTexture
  private outputView!:GPUTextureView
  private scenePass!:GPURenderPassDescriptor
  private readonly timer:FrameTimer|null
  private width=0;private height=0
  gpuMs:number|null=null
  lightCount=0
  sceneMode=0
  private measuring=false
  private frames=0
  constructor(device:GPUDevice,private readonly context:GPUCanvasContext,private readonly format:GPUTextureFormat,private readonly camera:CameraWriter){
    const d=this.device=device
    this.meshes=new LabMeshes(d)
    this.ringModel=this.meshes.add(buildRingVertices(),10,c=>c,0.75)
    this.particles=new ParticleRenderer(d);this.volume=new VolumeRenderer(d)
    this.transientRenderer=new ParticleRenderer(d)
    this.buffer=d.createBuffer({size:this.frame.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    const polarBuffer=d.createBuffer({size:8*256*9*16,usage:GPUBufferUsage.STORAGE})
    const layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"read-only-storage"}}]})
    this.group=d.createBindGroup({layout,entries:[{binding:0,resource:{buffer:this.buffer}},{binding:1,resource:{buffer:polarBuffer}}]})
    const computeLayout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}]})
    this.computeGroup=d.createBindGroup({layout:computeLayout,entries:[{binding:0,resource:{buffer:this.buffer}},{binding:1,resource:{buffer:polarBuffer}}]})
    this.polar=d.createComputePipeline({layout:d.createPipelineLayout({bindGroupLayouts:[computeLayout]}),compute:{module:d.createShaderModule({code:polarShader,label:"Lab polar"}),entryPoint:"cs"}})
    const module=d.createShaderModule({code:stageShader,label:"Lab stage"})
    this.scene=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[layout]}),vertex:{module,entryPoint:"vs"},fragment:{module,entryPoint:"fs",targets:[{format:"rgba16float"}]},depthStencil:{format:"depth24plus",depthCompare:"always",depthWriteEnabled:true},multisample:{count:4}})
    this.postLayout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{}}]})
    this.post=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[layout,this.postLayout]}),vertex:{module,entryPoint:"vs"},fragment:{module,entryPoint:"post",targets:[{format}]}})
    const tyreLayout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"read-only-storage"}}]})
    this.tyre=new SmokeRenderer(d,tyreLayout,tyreCommon,"depth24plus")
    this.tyreBuffer=d.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    this.tyreLights=d.createBuffer({size:8*48,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST})
    this.tyreGroup=d.createBindGroup({layout:tyreLayout,entries:[{binding:0,resource:{buffer:this.tyreBuffer}},{binding:1,resource:{buffer:this.tyreLights}}]})
    this.timer=d.features.has("timestamp-query")?new FrameTimer(d):null
  }
  resize(width:number,height:number){
    if(width===this.width&&height===this.height)return
    this.width=width;this.height=height
    for(const t of this.textures)t.destroy()
    const d=this.device,usage=GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING
    const hdr=d.createTexture({size:[width,height],format:"rgba16float",usage:usage|GPUTextureUsage.COPY_SRC})
    const msaa=d.createTexture({size:[width,height],format:"rgba16float",sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT})
    const depth=d.createTexture({size:[width,height],format:"depth24plus",sampleCount:4,usage})
    this.output=d.createTexture({size:[width,height],format:this.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC})
    this.outputView=this.output.createView()
    this.textures=[hdr,msaa,depth,this.output];this.hdr=hdr.createView();const depthView=depth.createView()
    this.hdrTexture=hdr;this.depthView=depthView
    this.scenePass={colorAttachments:[{view:msaa.createView(),resolveTarget:this.hdr,loadOp:"clear",storeOp:"discard",clearValue:{r:0,g:0,b:0,a:1}}],depthStencilAttachment:{view:depthView,depthLoadOp:"clear",depthStoreOp:"store",depthClearValue:1}}
    this.volume.resize(width,height,depthView)
    this.postGroup=d.createBindGroup({layout:this.postLayout,entries:[{binding:0,resource:this.hdr}]})
    this.updateCamera()
  }
  frameTarget(x:number,y:number,z:number,dist=17){
    this.focus[0]=x;this.focus[1]=y;this.focus[2]=z
    this.targetFocus[0]=x;this.targetFocus[1]=y;this.targetFocus[2]=z
    this.camDist=Math.max(4,Math.min(75,dist))
    this.targetDist=this.camDist
    this.targetYaw=this.camYaw
    this.targetPitch=this.camPitch
    this.hasDampedTarget=false
    this.camCustom=true
  }
  resetCamera(){
    this.camYaw=0;this.camPitch=DEFAULT_PITCH;this.camDist=DEFAULT_DIST
    this.targetYaw=0;this.targetPitch=DEFAULT_PITCH;this.targetDist=DEFAULT_DIST
    this.hasDampedTarget=false;this.camCustom=false
  }
  private ensureDampedTargets(){
    if(!this.hasDampedTarget){
      this.targetYaw=this.camYaw
      this.targetPitch=this.camPitch
      this.targetDist=this.camDist
      this.targetFocus[0]=this.focus[0]!
      this.targetFocus[1]=this.focus[1]!
      this.targetFocus[2]=this.focus[2]!
      this.hasDampedTarget=true
    }
  }
  orbit(dyaw:number,dpitch:number,smooth=false){
    this.camCustom=true
    if(!smooth){
      this.camYaw+=dyaw
      this.camPitch=Math.max(0.18,Math.min(1.45,this.camPitch+dpitch))
      this.targetYaw=this.camYaw
      this.targetPitch=this.camPitch
      return
    }
    this.ensureDampedTargets()
    this.targetYaw+=dyaw
    this.targetPitch=Math.max(0.18,Math.min(1.45,this.targetPitch+dpitch))
    this.camYaw+=(this.targetYaw-this.camYaw)*0.45
    this.camPitch+=(this.targetPitch-this.camPitch)*0.45
  }
  pan(dx:number,dz:number,smooth=false){
    this.camCustom=true
    const cy=Math.cos(this.camYaw),sy=Math.sin(this.camYaw),scale=this.camDist*0.0016
    const wx=(cy*dx+sy*dz)*scale
    const wz=(-sy*dx+cy*dz)*scale
    if(!smooth){
      this.focus[0]+=wx
      this.focus[2]+=wz
      this.targetFocus[0]=this.focus[0]!
      this.targetFocus[1]=this.focus[1]!
      this.targetFocus[2]=this.focus[2]!
      return
    }
    this.ensureDampedTargets()
    this.targetFocus[0]+=wx
    this.targetFocus[2]+=wz
    this.focus[0]+=(this.targetFocus[0]!-this.focus[0]!)*0.45
    this.focus[2]+=(this.targetFocus[2]!-this.focus[2]!)*0.45
  }
  zoomBy(factor:number,smooth=false){
    this.camCustom=true
    if(!smooth){
      this.camDist=Math.max(4,Math.min(75,this.camDist*factor))
      this.targetDist=this.camDist
      return
    }
    this.ensureDampedTargets()
    this.targetDist=Math.max(4,Math.min(75,this.targetDist*factor))
    this.camDist+=(this.targetDist-this.camDist)*0.45
  }
  stepCamera(dt:number):boolean{
    if(!this.hasDampedTarget)return false
    const k=1-Math.exp(-Math.max(0.001,dt)*18)
    this.camYaw+=(this.targetYaw-this.camYaw)*k
    this.camPitch+=(this.targetPitch-this.camPitch)*k
    this.camDist+=(this.targetDist-this.camDist)*k
    this.focus[0]+=(this.targetFocus[0]!-this.focus[0]!)*k
    this.focus[1]+=(this.targetFocus[1]!-this.focus[1]!)*k
    this.focus[2]+=(this.targetFocus[2]!-this.focus[2]!)*k
    const err=
      Math.abs(this.targetYaw-this.camYaw)+
      Math.abs(this.targetPitch-this.camPitch)+
      Math.abs(this.targetDist-this.camDist)+
      Math.hypot(this.targetFocus[0]!-this.focus[0]!,this.targetFocus[1]!-this.focus[1]!,this.targetFocus[2]!-this.focus[2]!)
    if(err<1e-4){
      this.camYaw=this.targetYaw
      this.camPitch=this.targetPitch
      this.camDist=this.targetDist
      this.focus[0]=this.targetFocus[0]!
      this.focus[1]=this.targetFocus[1]!
      this.focus[2]=this.targetFocus[2]!
      this.hasDampedTarget=false
    }
    return this.hasDampedTarget
  }
  screenRay(u:number,v:number):{origin:[number,number,number];dir:[number,number,number]}{
    const nx=u*2-1,ny=1-v*2,inv=this.inverse
    const x=inv[0]!*nx+inv[4]!*ny+inv[8]!+inv[12]!
    const y=inv[1]!*nx+inv[5]!*ny+inv[9]!+inv[13]!
    const z=inv[2]!*nx+inv[6]!*ny+inv[10]!+inv[14]!
    const w=inv[3]!*nx+inv[7]!*ny+inv[11]!+inv[15]!||1
    let dx=x/w-this.eye[0]!,dy=y/w-this.eye[1]!,dz=z/w-this.eye[2]!
    const len=Math.hypot(dx,dy,dz)||1
    return {origin:[this.eye[0]!,this.eye[1]!,this.eye[2]!],dir:[dx/len,dy/len,dz/len]}
  }
  pickGround(u:number,v:number,ground:(x:number,z:number)=>number=()=>0):{x:number;y:number;z:number}|null{
    const {origin:[ox,oy,oz],dir:[dx,dy,dz]}=this.screenRay(u,v)
    if(dy>=-0.01)return null
    const tFlat=-oy/dy
    if(tFlat<=0||tFlat>200)return null
    let lo=Math.max(0.1,(1.8-oy)/dy),hi=tFlat
    if(lo>hi){const tmp=lo;lo=hi;hi=tmp}
    for(let i=0;i<16;i++){
      const t=lo+(hi-lo)*(i/15),px=ox+dx*t,py=oy+dy*t,pz=oz+dz*t,gy=ground(px,pz)
      if(py<=gy){
        let a=lo+(hi-lo)*Math.max(0,(i-1)/15),b=t
        for(let j=0;j<6;j++){const m=(a+b)*0.5,mx=ox+dx*m,my=oy+dy*m,mz=oz+dz*m;if(my>ground(mx,mz))a=m;else b=m}
        const ft=(a+b)*0.5,fx=ox+dx*ft,fz=oz+dz*ft
        return {x:fx,y:ground(fx,fz),z:fz}
      }
    }
    const fx=ox+dx*tFlat,fz=oz+dz*tFlat
    return {x:fx,y:ground(fx,fz),z:fz}
  }
  projectWorld(x:number,y:number,z:number):{u:number;v:number;visible:boolean}{
    const m=this.viewProj
    const cx=m[0]!*x+m[4]!*y+m[8]!*z+m[12]!
    const cy=m[1]!*x+m[5]!*y+m[9]!*z+m[13]!
    const cw=m[3]!*x+m[7]!*y+m[11]!*z+m[15]!
    if(cw<=0.001)return {u:0.5,v:0.5,visible:false}
    const u=(cx/cw+1)*0.5
    const v=(1-cy/cw)*0.5
    return {u,v,visible:u>=0&&u<=1&&v>=0&&v<=1}
  }
  updateCamera(){
    if(this.cameraOverride&&!this.camCustom){
      this.cameraOverride(this.width,this.height,this.viewProj,this.inverse,this.eye,this.focus)
    }else if(this.camCustom){
      writeOrbitCamera(this.width,this.height,this.viewProj,this.inverse,this.eye,this.focus,this.camYaw,this.camPitch,this.camDist)
    }else{
      this.camera(this.width,this.height,this.viewProj,this.inverse,this.eye,this.focus)
    }
    this.volume.uniforms.set(this.inverse);this.volume.uniforms.set(this.eye,16)
    this.particles.uniforms.set(this.viewProj);this.particles.uniforms.set(this.eye,16)
    this.tyreFrame.set(this.viewProj);this.tyreFrame.set(this.eye,16);this.tyreFrame[20]=this.width;this.tyreFrame[21]=this.height
  }
  private uploadLighting(debug:number){
    const s=this.lighting,f=this.frame,deg=Math.PI/180,count=this.dynamicLights?Math.min(8,this.dynamicLights.length):Math.max(0,Math.min(8,Math.round(s.count)))
    f[36]=count;f[37]=Number(s.shadows);f[38]=debug;f[39]=this.sceneMode
    f[40]=Math.cos(s.moonAzimuth*deg)*Math.cos(s.moonElevation*deg);f[41]=Math.sin(s.moonElevation*deg);f[42]=Math.sin(s.moonAzimuth*deg)*Math.cos(s.moonElevation*deg);f[43]=s.moon?s.moonPower:0
    f[44]=s.exposure;f[45]=s.tone;f[46]=s.saturation;f[47]=s.temperature
    f[48]=0.06;f[49]=0.08;f[50]=0.13
    this.lightCount=0
    for(let i=0;i<8;i++){
      const o=i*12,spot=i===1,cool=i%2===1
      this.lightData[o]=lightX[i]!;this.lightData[o+1]=s.lampHeight;this.lightData[o+2]=lightZ[i]!;this.lightData[o+3]=s.lampRadius
      this.lightData[o+4]=cool?0.28:1.8;this.lightData[o+5]=cool?0.85:0.95;this.lightData[o+6]=cool?1.6:0.4
      const power=spot?(s.spot?s.spotPower:0):(s.lamps?s.lampPower:0)
      this.lightData[o+7]=i<count?power:0
      this.lightData[o+8]=Math.sin(s.spotYaw*deg)*Math.cos(s.spotPitch*deg);this.lightData[o+9]=-Math.sin(s.spotPitch*deg);this.lightData[o+10]=Math.cos(s.spotYaw*deg)*Math.cos(s.spotPitch*deg);this.lightData[o+11]=spot?Math.cos(s.spotAngle*deg):-2
      if(this.dynamicLights){
        const l=this.dynamicLights[i]
        this.lightData.fill(0,o,o+12)
        if(l){this.lightData.set([l.x,l.y,l.z,l.radius,l.r,l.g,l.b,l.power,l.dx??0,l.dy??-1,l.dz??0,l.cone??-2],o)}
      }
      if(i<count&&this.lightData[o+7]>0)this.lightCount++
      for(let j=0;j<8;j++){this.volume.uniforms[60+i*8+j]=this.lightData[o+j]!;this.particles.uniforms[24+i*8+j]=this.lightData[o+j]!}
    }
    this.volume.uniforms[22]=count;this.volume.uniforms[24]=0.08;this.volume.uniforms[25]=0.10;this.volume.uniforms[26]=0.15
    this.particles.uniforms[20]=0.25;this.particles.uniforms[21]=0.30;this.particles.uniforms[22]=0.42;this.particles.uniforms[23]=count
    this.tyreFrame[22]=count;for(let i=0;i<4;i++)this.tyreFrame[24+i]=f[40+i]!
    this.device.queue.writeBuffer(this.buffer,0,f);this.device.queue.writeBuffer(this.tyreLights,0,this.lightData)
  }
  async render(particles:Particles,volumes:SmokeVolumes,trail:SmokeTrail,debug:number,measure=false,draw?:(pass:GPURenderPassEncoder)=>void){
    if(this.measuring)return null
    const timed=!!this.timer&&(measure||this.frames++%45===0)
    this.uploadLighting(debug)
    if(this.showMarkers){
      for(const m of this.markers){
        const tint=m.kind==="invalid"?[1,0.32,0.32]:m.kind==="ghost"?[0.52,0.92,0.72]:m.kind==="hover"?[0.75,0.86,0.95]:[0.38,0.84,0.96]
        this.meshes.instance(this.ringModel,m.x,m.y+0.02,m.z,m.yaw??0,0,0,m.radius??0.85,tint)
      }
    }
    this.meshes.upload(this.frame)
    this.particles.uniforms[19]=debug;this.volume.debug=debug
    this.transientRenderer.uniforms.set(this.particles.uniforms);this.transientRenderer.upload(this.transients)
    this.particles.upload(particles);trail.prepare();this.tyre.upload(trail,true)
    this.tyreFrame[19]=volumes.time;this.device.queue.writeBuffer(this.tyreBuffer,0,this.tyreFrame)
    const enc=this.device.createCommandEncoder(),shadow=this.lighting.shadows&&this.frame[36]>0
    if(shadow){const p=enc.beginComputePass({timestampWrites:timed?this.timer!.start:undefined});p.setPipeline(this.polar);p.setBindGroup(0,this.computeGroup);p.dispatchWorkgroups(Math.ceil(this.frame[36]*256/64));p.end()}
    this.scenePass.timestampWrites=timed&&!shadow?this.timer!.start:undefined
    const pass=enc.beginRenderPass(this.scenePass);pass.setPipeline(this.scene);pass.setBindGroup(0,this.group);pass.draw(3)
    this.meshes.draw(pass)
    draw?.(pass)
    if(debug!==5){pass.setBindGroup(0,this.tyreGroup);this.tyre.draw(pass)}
    this.particles.draw(pass);this.transientRenderer.draw(pass);pass.end()
    if(debug!==5)this.volume.render(enc,this.hdr,volumes)
    this.afterScene?.(enc,this.hdrTexture,this.depthView,this.width,this.height)
    const output=this.outputView
    const post=enc.beginRenderPass({colorAttachments:[{view:output,loadOp:"clear",storeOp:"store",clearValue:{r:0,g:0,b:0,a:1}}]})
    post.setPipeline(this.post);post.setBindGroup(0,this.group);post.setBindGroup(1,this.postGroup);post.draw(3);post.end()
    if(timed)this.timer!.finish(enc,output)
    enc.copyTextureToTexture({texture:this.output},{texture:this.context.getCurrentTexture()},[this.width,this.height])
    this.device.queue.submit([enc.finish()])
    this.onFrameSubmitted?.()
    if(timed){this.measuring=true;try{this.gpuMs=await this.timer!.collect()}finally{this.measuring=false}}
    return timed?this.gpuMs:null
  }
}
