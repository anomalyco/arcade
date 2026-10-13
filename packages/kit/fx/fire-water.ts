import { fireWaterShader, heatShader } from "./fire-water-shader"

export type ElementLight={x:number;y:number;z:number;radius:number;r:number;g:number;b:number;power:number}
export type ElementEffect="fire"|"wreck"|"explosion"|"fireball"|"water"
export const fireStyles=[{value:0,label:"Current"},{value:1,label:"Flowing"},{value:2,label:"Graphic"}]
export const fireDefaults=()=>({height:3.7,width:1.25,speed:1.7,erosion:.65,embers:32,smoke:.5,light:3.2,shimmer:1.7})
export const waterDefaults=()=>({height:4.4,width:.65,speed:2.8,spray:100,mist:.42,puddle:3.6,sheen:2.8,roughness:.32,foam:.7})
export type FireSettings=ReturnType<typeof fireDefaults>
export type WaterSettings=ReturnType<typeof waterDefaults>
const hash=(n:number)=>{const v=Math.sin(n*127.1+311.7)*43758.5453;return v-Math.floor(v)}
/** The same continuous signal modulates flame size, ember intensity and the scene light. */
export const fireFlicker=(t:number)=>.86+.09*Math.sin(t*9.1)+.05*Math.sin(t*17.3+1.8)

/** Analytic seeded motion avoids allocation and timestep-dependent particle births. 768 bounded quads. */
export class FireWater {
  readonly fire=[fireDefaults(),fireDefaults(),{...fireDefaults(),height:3.4,width:1.4,erosion:.4,embers:20,smoke:.35}]
  readonly water=[waterDefaults(),waterDefaults(),{...waterDefaults(),height:4.8,width:.72,spray:60,mist:.22,foam:1}]
  time=0
  age=0
  effect:ElementEffect="fire"
  style=1
  x=0;y=0;z=0
  count=0
  private split=0
  private readonly data=new Float32Array(768*20)
  private readonly frame=new Float32Array(88)
  private readonly buffer:GPUBuffer
  private readonly uniform:GPUBuffer
  private readonly group:GPUBindGroup
  private readonly alpha:GPURenderPipeline
  private readonly additive:GPURenderPipeline
  private readonly heat:GPURenderPipeline
  private readonly heatLayout:GPUBindGroupLayout
  private readonly heatUniform:GPUBuffer
  private readonly heatFrame=new Float32Array(28)
  private snapshot?:GPUTexture
  private heatGroup?:GPUBindGroup
  private heatDepth?:GPUTextureView
  private heatTarget?:GPUTexture
  private heatTargetView?:GPUTextureView
  private width=0;private height=0
  constructor(private readonly device:GPUDevice,depthFormat:GPUTextureFormat="depth24plus",samples=4){
    const d=device,module=d.createShaderModule({code:fireWaterShader,label:"Fire and water"})
    this.buffer=d.createBuffer({size:this.data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    this.uniform=d.createBuffer({size:this.frame.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    const layout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}}]})
    const pipeline=(add:boolean)=>d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[layout]}),vertex:{module,entryPoint:"vs",buffers:[{arrayStride:80,stepMode:"instance",attributes:[0,1,2,3,4].map(i=>({shaderLocation:i,offset:i*16,format:"float32x4"}))}]},fragment:{module,entryPoint:"fs",targets:[{format:"rgba16float",blend:{color:{srcFactor:"src-alpha",dstFactor:add?"one":"one-minus-src-alpha"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha"}}}]},depthStencil:{format:depthFormat,depthWriteEnabled:false,depthCompare:"less-equal"},multisample:{count:samples}})
    this.alpha=pipeline(false);this.additive=pipeline(true)
    this.group=d.createBindGroup({layout,entries:[{binding:0,resource:{buffer:this.uniform}}]})
    this.heatLayout=d.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"unfilterable-float"}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"depth",multisampled:true}}]})
    this.heatUniform=d.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    const heat=d.createShaderModule({code:heatShader,label:"Bounded heat refraction"})
    this.heat=d.createRenderPipeline({layout:d.createPipelineLayout({bindGroupLayouts:[this.heatLayout]}),vertex:{module:heat,entryPoint:"vs"},fragment:{module:heat,entryPoint:"fs",targets:[{format:"rgba16float"}]}})
  }
  reset(effect:ElementEffect=this.effect){this.effect=effect;this.time=this.age=0}
  update(dt:number){this.time+=dt;this.age+=dt}
  private quad(kind:number,x:number,y:number,z:number,width:number,height:number,r:number,g:number,b:number,alpha:number,seed=0,ax=0,ay=1,az=0,a=0,bias=0,c=0){
    if(this.count===768)return
    const p=this.data,o=this.count++*20
    p[o]=x;p[o+1]=y;p[o+2]=z;p[o+3]=width;p[o+4]=ax;p[o+5]=ay;p[o+6]=az;p[o+7]=height
    p[o+8]=r;p[o+9]=g;p[o+10]=b;p[o+11]=alpha;p[o+12]=kind;p[o+13]=seed;p[o+14]=this.age;p[o+15]=this.style
    p[o+16]=a;p[o+17]=bias;p[o+18]=c;p[o+19]=0
  }
  light():ElementLight|null {
    if(this.effect==="water"||this.style===0)return null
    const s=this.fire[this.style],explosion=this.effect==="explosion"||this.effect==="fireball",burst=explosion?Math.exp(-this.age*5)*5:0
    return {x:this.x,y:this.y+1.6,z:this.z,radius:11,r:1,g:.31,b:.045,power:s.light*fireFlicker(this.time)*(explosion?Math.max(0,1-this.age/8):1)+burst}
  }
  prepare(vp:Float32Array,eye:Float32Array,lights:readonly ElementLight[]){
    this.count=0;this.split=0
    const {x,y,z,time:t,age}=this
    if(this.style>0&&this.effect==="water"){
      const s=this.water[this.style],grow=Math.min(1,.22+age*.24),radius=s.puddle*grow
      this.quad(6,x,y+.035,z,radius,radius*.86,1,1,1,.82,7,0,1,0,s.sheen,s.roughness,s.foam)
      for(let i=0;i<4;i++){const u=(t*.6+i*.25)%1;this.quad(7,x+Math.sin(i*8)*.25,y+.048,z+Math.cos(i*8)*.25,.15+u*radius*.7,.15+u*radius*.7,.52,.78,.86,(1-u)*.22,hash(i))}
      // The continuous sheet keeps the pressure column readable between discrete droplets.
      this.quad(4,x,y+s.height*.5,z,s.width,s.height*.5,.3,.65,.8,.88,3,0,1,0,s.speed)
      for(let i=0;i<Math.min(240,s.spray);i++){
        const seed=hash(i+4),angle=hash(i+200)*Math.PI*2,life=1.1+hash(i+900)*.4,u=(t/life+seed)%1
        const speed=s.height*(1.5+hash(i+400)*.3),vx=Math.cos(angle)*(.35+seed*1.1),vz=Math.sin(angle)*(.35+seed*1.1)
        const flight=u*speed/4.9,py=flight*speed-4.9*flight*flight,vy=speed-9.8*flight
        if(py>0)this.quad(5,x+vx*flight,y+.08+py,z+vz*flight,.022+seed*.022,.06+Math.abs(vy)*.013,.28,.63,.78,.7,seed,vx,vy,vz)
        const splash=(t*1.4+seed)%1,dist=.2+splash*(.4+seed*1.4)
        if(i<32)this.quad(5,x+Math.cos(angle)*dist,y+.08+Math.sin(splash*Math.PI)*.45,z+Math.sin(angle)*dist,.025,.07,.5,.8,.9,(1-splash)*.65,seed,Math.cos(angle),1-splash*3,Math.sin(angle))
      }
      for(let i=0;i<10;i++){
        const u=(t*.43+hash(i+41))%1,a=i*2.4;
        this.quad(2,x+Math.cos(a)*u*.75,y+s.height*.75+u*.7,z+Math.sin(a)*u*.75,.25+u*.55,.2+u*.3,.45,.65,.7,s.mist*(1-u)*.55,i)
      }
      this.split=this.count
    }else if(this.style>0){
      const s=this.fire[this.style],wreck=this.effect==="wreck",explosion=this.effect==="explosion"||this.effect==="fireball",flick=fireFlicker(t)
      const sustain=explosion?Math.min(1,Math.max(0,age-.12)*3)*Math.max(0,1-age/8):1
      // Smoke first, behind the colored alpha flames; a small additive core follows last.
      for(let i=0;i<9;i++){
        const seed=hash(i+30),u=(t*.28+seed)%1;
        this.quad(2,x+Math.sin(i*4+u*2)*u*.7,y+1.4+u*3.3,z-u*.6,.55+u*1.05,.7+u*.85,.09,.085,.08,Math.sin(u*Math.PI)*s.smoke*1.2*sustain,i)
      }
      for(let i=0;i<3;i++){
        const side=(i-1)*s.width*.48,dx=wreck?side:side*.8,dz=Math.sin(i*4.7)*.22;
        const height=s.height*(i===1?1:i===0?.73:.59)*flick*(wreck?.85:1);
        this.quad(0,x+dx,y+height*.5+(wreck?.55:0),z+dz,s.width*(i===1?.8:.48),height*.5,1,1,1,.92*sustain,i*2.83,0,1,0,s.speed,s.erosion)
      }
      if(explosion&&age<1.1){
        const radius=.3+Math.sqrt(age)*2.6,fade=Math.max(0,1-age/1.1)
        for(let i=0;i<5;i++){const a=i*2.4;this.quad(8,x+Math.cos(a)*radius*.33,y+.7+radius*.5+Math.sin(a)*radius*.15,z+Math.sin(a)*radius*.22,radius*.68,radius*.7,1,1,1,fade*.95,i*3.1)}
      }
      this.split=this.count
      const h=s.height*.68*flick
      this.quad(1,x,y+h*.5+(wreck?.55:0),z+.08,s.width*.65,h*.5,1,1,1,sustain,5,0,1,0,s.speed,s.erosion)
      for(let i=0;i<Math.min(120,s.embers);i++){
        const seed=hash(i+99),u=(t*(.35+seed*.15)+seed)%1,a=i*2.399+u*2.3
        this.quad(3,x+Math.cos(a)*(.2+u*u*1.5),y+.5+u*4.8,z+Math.sin(a)*(.2+u*u*1.1),.016+seed*.014,.04+seed*.045,2.2,.35+seed*.35,.035,Math.sin(u*Math.PI)*sustain*flick,seed,-Math.sin(a)*.4,1,Math.cos(a)*.4)
      }
    }
    this.frame.set(vp);this.frame.set(eye,16);this.frame[19]=t;this.frame[20]=Math.min(8,lights.length)
    this.frame.fill(0,24);lights.slice(0,8).forEach((l,i)=>this.frame.set([l.x,l.y,l.z,l.radius,l.r,l.g,l.b,l.power],24+i*8))
    this.device.queue.writeBuffer(this.uniform,0,this.frame)
    if(this.count)this.device.queue.writeBuffer(this.buffer,0,this.data.buffer,0,this.count*80)
    this.heatFrame.set(vp);this.heatFrame.set(eye,16);this.heatFrame[19]=t
  }
  draw(pass:GPURenderPassEncoder){
    if(!this.count)return
    pass.setBindGroup(0,this.group);pass.setVertexBuffer(0,this.buffer)
    if(this.split){pass.setPipeline(this.alpha);pass.draw(6,this.split)}
    if(this.count>this.split){pass.setPipeline(this.additive);pass.draw(6,this.count-this.split,0,this.split)}
  }
  shimmer(encoder:GPUCommandEncoder,hdr:GPUTexture,depth:GPUTextureView,width:number,height:number){
    if(this.style===0||this.effect==="water"||this.fire[this.style].shimmer===0)return
    const strength=this.fire[this.style].shimmer*(["explosion","fireball"].includes(this.effect)?Math.max(0,1-this.age/8):1)
    if(strength===0)return
    if(!this.snapshot||width!==this.width||height!==this.height){
      this.snapshot?.destroy();this.width=width;this.height=height
      this.snapshot=this.device.createTexture({size:[width,height],format:"rgba16float",usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING})
      this.heatGroup=undefined
    }
    // Depth view can change after a section's resize even at a previously seen resolution.
    if(!this.heatGroup||depth!==this.heatDepth){this.heatDepth=depth;this.heatGroup=this.device.createBindGroup({layout:this.heatLayout,entries:[{binding:0,resource:{buffer:this.heatUniform}},{binding:1,resource:this.snapshot.createView()},{binding:2,resource:depth}]})}
    if(this.heatTarget!==hdr){this.heatTarget=hdr;this.heatTargetView=hdr.createView()}
    this.heatFrame.set([this.x,this.y,this.z,strength],20);this.heatFrame.set([width,height,0,0],24)
    this.device.queue.writeBuffer(this.heatUniform,0,this.heatFrame)
    encoder.copyTextureToTexture({texture:hdr},{texture:this.snapshot},[width,height])
    const pass=encoder.beginRenderPass({colorAttachments:[{view:this.heatTargetView!,loadOp:"load",storeOp:"store"}]})
    pass.setPipeline(this.heat);pass.setBindGroup(0,this.heatGroup);pass.draw(3);pass.end()
  }
}
