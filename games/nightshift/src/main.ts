import { FirstPerson } from "@arcade/kit/client/first-person"
import { isEditableEventTarget, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { openGpu } from "@arcade/kit/gpu/boot"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { flatLighting, newSceneFrame, packSceneFrame, SceneLights, type SceneLight } from "@arcade/kit/gpu/scene-frame"
import { SpotShadows } from "@arcade/kit/gpu/shadows/spot-shadows"
import { FogScatter, type FogLamp } from "@arcade/kit/gpu/fog-scatter"
import { lampFlicker, hash01 } from "@arcade/kit/gpu/lights/flicker"
import { makeSceneShader, spriteShader } from "@arcade/kit/gpu/shaders"
import { TEMPORAL_DEFAULTS } from "@arcade/kit/gpu/temporal"
import { LabPanel } from "@arcade/kit/lab-panel"
import { controls, defaults } from "./settings"
import { hooks, post, fogVolume } from "./shaders"
import { buildWorld, handset, PHONE, START, CLOSE, CRADLE, CORD_END, walls } from "./world"
import { newCall, interact, stepCall, subtitle, ringEnvelope } from "../shared/call"
import { OfficeAudio } from "./audio"

async function main() {
  const canvas=document.querySelector<HTMLCanvasElement>("#view")!,hud=document.getElementById("hud")!,prompt=document.getElementById("prompt")!,sub=document.getElementById("subtitle")!
  const gpu=await openGpu(canvas,"NIGHT SHIFT")
  if(typeof gpu==="string") throw new Error(gpu)
  const {device}=gpu,settings=defaults(),world=buildWorld(),audio=new OfficeAudio(),call=newCall()
  const renderer=new Renderer(device,gpu.context,gpu.format,{scene:makeSceneShader(hooks),sprite:spriteShader(),post,volume:[fogVolume]})
  renderer.setTemporal({...TEMPORAL_DEFAULTS,mode:"taa",sharpen:0.15})
  renderer.setLevel({chunks:[{data:world.data,box:[-7,-10,7,10]}],glass:[],...flatLighting(0,0,[0,0,0])})
  const receiver=renderer.addModel(handset()),parts=new FrameParts()
  const camera=new FirstPerson(canvas,()=>panel.visible)
  camera.height=1.65;camera.fov=68;camera.far=45;camera.near=0.045
  const setCamera=(view:"wide"|"phone")=>{const p=view==="wide"?START:CLOSE;camera.body.x=p.x;camera.body.y=p.z;camera.yaw=p.yaw;camera.pitch=p.pitch;camera.release()}
  setCamera("wide")
  const panel=new LabPanel(settings,controls(),new URLSearchParams(location.search),()=>camera.release(),{open:false,pill:false,groupActions:false})
  const fog=new FogScatter();Object.assign(fog.settings,{falloff:0.05,brightness:0.003,strength:0.4})
  const lights=new SceneLights(),spots=new SpotShadows(device,{count:4,size:1024})
  renderer.setSpotShadows(spots.bindings())
  const buffer=device.createBuffer({size:world.data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(buffer,0,world.data)
  const casters=[{buffer,count:world.vertices,stride:24}]
  const frame=newSceneFrame(),custom=new Float32Array(16)
  let time=0,frames=0,paused=false,last=performance.now(),fixedTime:number|null=null
  let handYaw=0,lastLookYaw=0
  const distance=()=>Math.hypot(camera.body.x-PHONE.x,camera.body.y-PHONE.z)
  const canAnswer=()=>distance()<1.35 && camera.direction[0]*(PHONE.x-camera.eye[0])+camera.direction[2]*(PHONE.z-camera.eye[2])>0.15
  const action=()=>{
    if((call.phase==="ringing"&&canAnswer())||call.phase==="call") {
      camera.release();handYaw=Math.atan2(Math.sin(camera.yaw),Math.cos(camera.yaw));lastLookYaw=camera.yaw
    }
    interact(call,canAnswer())
  }
  const prompts=()=>hud.innerHTML=[keyPromptHtml("Mouse0","Look"),keyPromptHtml("KeyW","Move"),keyPromptHtml("KeyF","Flashlight"),keyPromptHtml("KeyM","Mute"),keyPromptHtml("Backquote","Office")].join(" ")
  prompts();onKeyLayoutChange(prompts)
  canvas.addEventListener("click",()=>void audio.unlock())
  window.addEventListener("keydown",e=>{if(e.repeat||e.metaKey||e.ctrlKey||e.altKey||isEditableEventTarget(e.target)||panel.visible||document.pointerLockElement!==canvas)return;if(e.code==="KeyE")action();if(e.code==="KeyM")audio.muted=!audio.muted})
  window.addEventListener("pagehide",()=>audio.dispose())
  const smoke=new URLSearchParams(location.search).has("smoke")
  function render(now:number) {
    const dt=Math.min(0.05,(now-last)/1000);last=now
    if(paused){requestAnimationFrame(render);return}
    time=fixedTime??time+dt
    const width=Math.max(1,Math.round(innerWidth*Math.min(devicePixelRatio,1.5))),height=Math.max(1,Math.round(innerHeight*Math.min(devicePixelRatio,1.5)))
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;renderer.resize(width,height)}
    camera.speed=call.phase==="pickup"||call.phase==="call"||call.phase==="hangup"?0:settings.speed
    const vp=camera.update(dt,width/height,walls)
    stepCall(call,dt,settings.pickup)
    const flicker=lampFlicker("fluorescent",87,time,settings.flicker).level, led=call.phase==="ringing"?0.18+0.82*ringEnvelope(time):call.phase==="ended"?0.015:0.7
    const lampDefs:SceneLight[]=[
      {id:1,x:-5.55,y:4.9,h:2.65,r:13,color:[1,0.38,0.085],power:settings.sodium,size:0.09,spot:{axis:[0.88,-0.43,-0.2],cosOuter:0.45,cosInner:0.75}},
      {id:2,x:1.5,y:-6.1,h:2.7,r:6,color:[1,0.43,0.12],power:settings.sodium*0.1,size:0.06,spot:{axis:[-0.62,-0.65,0.43],cosOuter:0.3,cosInner:0.7}},
      {id:3,x:0,y:0,h:2.80,r:7,color:[0.71,0.84,0.72],power:settings.fluorescent*flicker,size:0.35,spot:{axis:[0,-1,0],cosOuter:0.15,cosInner:0.5}},
      {id:4,x:-0.74,y:-5.48,h:1.14,r:2.7,color:[0.16,1,0.48],power:settings.crt,size:0.19,spot:{axis:[0,-0.35,0.937],cosOuter:0.05,cosInner:0.5}},
      {id:5,x:PHONE.x+0.127*1.3,y:PHONE.z+0.085*1.3,h:PHONE.y+0.1,r:0.18,color:[1,0.025,0.004],power:0.0005*led,size:0.012,unshadowed:true},
      {id:6,x:-3.6,y:-4,h:2.8,r:4,color:[0.6,0.77,0.68],power:settings.fluorescent*0.12*flicker,size:0.25,unshadowed:true},
    ]
    if(camera.flashlight)lampDefs.push({id:7,x:camera.eye[0],y:camera.eye[2],h:camera.eye[1],r:12,color:[0.85,0.92,1],power:0.9,size:0.08,unshadowed:true,beam:{axis:camera.direction,halfAngle:0.27}})
    lights.update(lampDefs,[])
    const enc=device.createCommandEncoder()
    if(spots.update(enc,lampDefs.filter(l=>l.spot).map(l=>({id:l.id!,pos:[l.x,l.h,l.y] as const,axis:l.spot!.axis,range:l.r,intensity:l.power,cosOuter:l.spot!.cosOuter})),camera.eye,dt,id=>lights.indexOf(id),casters))renderer.setSpotShadows(spots.bindings())
    device.queue.submit([enc.finish()])
    parts.begin()
    // One receiver travels to the left ear. Looking moves its held endpoint 1:1.
    const t=call.lift,rx=Math.cos(camera.yaw),rz=-Math.sin(camera.yaw),fx=-Math.sin(camera.yaw),fz=-Math.cos(camera.yaw)
    const end=[camera.eye[0]-rx*0.32+fx*0.08,camera.eye[1]-0.08,camera.eye[2]-rz*0.32+fz*0.08]
    handYaw+=camera.yaw-lastLookYaw;lastLookYaw=camera.yaw
    const p=CRADLE.map((v,i)=>v+(end[i]-v)*t),yaw=handYaw*t,roll=-1.25*t
    parts.push(receiver,p[0],p[1],p[2],yaw,[1,1,1],0,roll,0)
    const cord=[p[0]-0.169*Math.cos(roll)*Math.sin(yaw),p[1]-0.169*Math.sin(roll),p[2]+0.169*Math.cos(roll)*Math.cos(yaw)]
    custom.set([settings.ambient,settings.fog,settings.dust,time,flicker,led,0,0,t,0,0,0,...cord.map((v,i)=>v-CORD_END[i]),0]);renderer.setCustomUniforms(custom)
    for(let i=0;i<150;i++) {
      const x=-1.5+hash01(i,1)*3,y=0.3+hash01(i,2)*2.3,z=-6.2+hash01(i,3)*12
      const drift=Math.sin(time*0.12+i)*0.05
      // Dust near the pools only; world anchored, no camera-following particle field.
      const strength=Math.exp(-((z-0.5)**2)/5)*flicker+Math.exp(-((z+5.4)**2)/0.9)*0.4
      parts.sprite(true,x+drift,y+Math.sin(time*0.17+i*3)*0.03,z,0.0035,0.62,0.69,0.48,strength*settings.dust*0.09,0)
    }
    Object.assign(fog.settings,{density:settings.fog})
    const fogLamps:FogLamp[]=lampDefs.filter(l=>l.id===3||l.id===4).map(l=>({id:l.id!,x:l.x,y:l.h,z:l.y,range:l.r,color:l.color,intensity:l.power,axis:l.spot!.axis,size:l.size}))
    packSceneFrame(frame,{viewProj:vp,eye:camera.eye,time,width,height,lightCount:lights.lightCount,ambient:[0,0,0,0],mapSize:[20,20],ao:0})
    renderer.render({frame,lights:lights.lights,lightCount:lights.lightCount,shadowLightCount:lights.shadowLightCount,occluders:lights.occ,occluderCount:lights.occCount,lampPower:lights.power,lampCount:0,view:[-7,-10,7,10],batches:parts.batches(),alphaSprites:parts.alpha,alphaCount:parts.nAlpha,addSprites:parts.add,addCount:parts.nAdd,grade:[0,0,0,settings.exposure],fog:fog.update({eye:camera.eye,viewProj:vp,lamps:fogLamps}),volume:[fog.volumeInput()]})
    const dx=PHONE.x-camera.eye[0],dz=PHONE.z-camera.eye[2]
    audio.update(time,distance(),(dx*Math.cos(camera.yaw)-dz*Math.sin(camera.yaw))/Math.max(distance(),0.1),call,settings.volume,document.pointerLockElement===canvas&&!document.hidden,flicker)
    prompt.innerHTML=call.phase==="ringing"&&canAnswer()?keyPromptHtml("KeyE","Answer"):call.phase==="call"?keyPromptHtml("KeyE","Hang up"):""
    sub.textContent=subtitle(call)
    frames++;if(smoke&&frames>=2)paused=true
    requestAnimationFrame(render)
  }
  Object.assign(window,{nightshift:{camera,settings,renderer,call,action,setCamera,get frames(){return frames},get paused(){return paused},set paused(v:boolean){paused=v},set time(v:number){fixedTime=v},ready:true}})
  requestAnimationFrame(render)
}
void main().catch(e=>{console.error(e);document.getElementById("hud")!.textContent=String(e)})
