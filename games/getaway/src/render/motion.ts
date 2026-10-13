import { motionUniformWGSL, MotionBlur, motionBlurDefaults } from '@arcade/kit/gpu/motion-blur'
export const motionBlur = motionBlurDefaults()
/** The producer records persistent particle identities alongside packed colour instances. */
export const spriteMotionKeys=new WeakMap<Float32Array,(object|undefined)[]>()

const transform=/* wgsl */`
fn world(p:vec3f,a:vec4f,b:vec4f,scale:f32)->vec3f {
 var q=p*scale;let cr=cos(b.x);let sr=sin(b.x);q=vec3f(q.x*cr-q.y*sr,q.x*sr+q.y*cr,q.z);
 let cp=cos(b.y);let sp=sin(b.y);q=vec3f(q.x,q.y*cp-q.z*sp,q.y*sp+q.z*cp);
 let c=cos(a.w);let s=sin(a.w);return vec3f(q.x*c+q.z*s,q.y,-q.x*s+q.z*c)+a.xyz;
}
struct VOut {@builtin(position) pos:vec4f,@location(0) now:vec4f,@location(1) old:vec4f}
@vertex fn vs(@location(0) p:vec3f,@location(1) a:vec4f,@location(2) b:vec4f,@location(3) c:vec4f,
 @location(4) pa:vec4f,@location(5) pb:vec4f,@location(6) pc:vec4f)->VOut {
 var o:VOut;o.now=M.current*vec4f(world(p,a,b,c.w),1);o.old=M.previous*vec4f(world(p,pa,pb,pc.w),1);o.pos=o.now;return o;
}
@fragment fn fs(o:VOut)->@location(0) vec4f {return vec4f(velocity(o.now,o.old),o.pos.z,1);}
`
export function vehicleVelocityPipeline(device:GPUDevice,blur:MotionBlur){
  const module=device.createShaderModule({code:motionUniformWGSL+transform,label:'Getaway instance velocity'})
  return device.createRenderPipeline({layout:device.createPipelineLayout({bindGroupLayouts:[blur.layout]}),vertex:{module,entryPoint:'vs',buffers:[
    {arrayStride:48,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]},
    ...[1,4].map(location=>({arrayStride:48,stepMode:'instance' as const,attributes:[0,1,2].map(i=>({shaderLocation:location+i,offset:i*16,format:'float32x4' as const}))})),
  ]},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float'}]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less-equal',depthBias:-16},primitive:{cullMode:'back'}})
}

const spriteShader=motionUniformWGSL+/* wgsl */`
struct Out {@builtin(position) pos:vec4f,@location(0) now:vec4f,@location(1) old:vec4f,@location(2) uv:vec2f,@location(3) alpha:f32}
@vertex fn vs(@builtin(vertex_index) i:u32,@location(0) center:vec4f,@location(1) color:vec4f,@location(2) misc:vec4f,@location(3) previous:vec4f)->Out {
 let corner=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1))[i];
 let right=normalize(M.inverse[0].xyz);let up=normalize(M.inverse[1].xyz);
 var local=(right*corner.x+up*corner.y)*center.w;
 if(misc.x==6.0){let axis=vec3f(sin(misc.y),0,cos(misc.y));local=(axis*corner.x*misc.z+normalize(cross(axis,cross(right,up)))*corner.y)*center.w;}
 if(misc.x==20.0){let c=cos(misc.y);let s=sin(misc.y);local=(right*(corner.x*c-corner.y*s)+up*(corner.x*s+corner.y*c)*max(.08,abs(misc.z)))*center.w;}
 if(misc.x==21.0){local=(right*corner.x+up*corner.y*misc.z)*center.w;}
 var o:Out;o.now=M.current*vec4f(center.xyz+local,1);o.old=M.previous*vec4f(previous.xyz+local,1);o.pos=o.now;o.uv=corner;
 o.alpha=color.a*select(0.0,1.0,misc.x==6.0||misc.x==20.0||misc.x==21.0||misc.x==22.0||misc.x==1.0);return o;
}
@fragment fn fs(o:Out)->@location(0) vec4f {
 let a=o.alpha*max(0.0,1.0-dot(o.uv,o.uv));if(a<.15){discard;}
 let opacity=min(1.0,a);return vec4f(velocity(o.now,o.old)*opacity,o.pos.z*opacity,opacity);
}
`
export function particleVelocityPipeline(device:GPUDevice,blur:MotionBlur){
 const module=device.createShaderModule({code:spriteShader,label:'Particle velocity'})
 const blend:GPUBlendState={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}
 return device.createRenderPipeline({layout:device.createPipelineLayout({bindGroupLayouts:[blur.layout]}),vertex:{module,entryPoint:'vs',buffers:[
  {arrayStride:48,stepMode:'instance',attributes:[0,1,2].map(i=>({shaderLocation:i,offset:i*16,format:'float32x4' as const}))},
  {arrayStride:48,stepMode:'instance',attributes:[{shaderLocation:3,offset:0,format:'float32x4'}]},
 ]},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float',blend}]},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'less-equal',depthBias:-16}})
}
