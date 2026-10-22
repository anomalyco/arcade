import { WalkCamera } from "./walk-camera"
import { isEditableEventTarget, onKeyLayoutChange } from "@arcade/kit/client/controls"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { openGpu } from "@arcade/kit/gpu/boot"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { flatLighting, newSceneFrame, packSceneFrame, SceneLights, type SceneLight } from "@arcade/kit/gpu/scene-frame"
import { SpotShadows } from "@arcade/kit/gpu/shadows/spot-shadows"
import { FogScatter, type FogLamp } from "@arcade/kit/gpu/fog-scatter"
import { contactShadowControls, contactShadowInput, createContactShadowSettings, packContactShadowKnobs } from "@arcade/kit/gpu/contact-shadows"
import { hash01 } from "@arcade/kit/gpu/lights/flicker"
import { makeSceneShader, spriteShader } from "@arcade/kit/gpu/shaders"
import { TEMPORAL_DEFAULTS } from "@arcade/kit/gpu/temporal"
import { LabPanel } from "@arcade/kit/lab-panel"
import { controls, defaults } from "./settings"
import { hooks, post, fogVolume, contactVolume } from "./shaders"
import { buildWorld, handset, phoneIndicator, PHONE, START, CLOSE, CORD_END, RECEIVER_PAD, OFFICE, walls, chairs, movingMeshes } from "./world"
import { newCall, interact, stepCall, subtitle, ringEnvelope } from "../shared/call"
import { OfficeAudio } from "./audio"
import { officeProps } from "./props"
import { renderFoley } from "./foley"
import { BeamDust, DustField } from "./polish/dust"
import { tubeSignal } from "./polish/tube"
import { lensPost } from "./polish/lens"
import { OfficePhysics } from "./polish/props"
import { Continuity } from "./polish/continuity"
import { MovingMeshPass } from "./polish/moving-mesh"

async function main() {
  const canvas=document.querySelector<HTMLCanvasElement>("#view")!,hud=document.getElementById("hud")!,prompt=document.getElementById("prompt")!,sub=document.getElementById("subtitle")!
  const gpu=await openGpu(canvas,"NIGHT SHIFT")
  if(typeof gpu==="string") throw new Error(gpu)
  const smoke=new URLSearchParams(location.search).has("smoke")
  const {device}=gpu,settings=defaults(),world=buildWorld(!smoke),audio=new OfficeAudio(),call=newCall()
  if(smoke)settings.polish=0
  const contact=createContactShadowSettings({mode:"screen",length:0.35,thickness:0.06})
  const renderer=new Renderer(device,gpu.context,gpu.format,{scene:makeSceneShader(hooks),sprite:spriteShader(),post:smoke?post:lensPost,volume:smoke?[fogVolume]:[contactVolume,fogVolume]})
  renderer.setTemporal({...TEMPORAL_DEFAULTS,mode:"taa",sharpen:0.15})
  renderer.setLevel({chunks:[{data:world.data,box:[-7,-10,7,10]}],glass:[],...flatLighting(0,0,[0,0,0])})
  const receiver=renderer.addModel(handset()),indicator=renderer.addModel(phoneIndicator()),parts=new FrameParts()
  settings.reduceMotion=matchMedia("(prefers-reduced-motion: reduce)").matches
  try{const saved=localStorage.getItem("nightshift.reduceMotion");if(saved!==null)settings.reduceMotion=saved==="true"}catch{}
  const camera:WalkCamera=new WalkCamera(canvas,()=>panel.visible,settings,()=>document.pointerLockElement===canvas&&!document.hidden&&!panel.visible&&camera.speed>0)
  camera.height=1.65;camera.fov=68;camera.far=45;camera.near=0.045
  const setCamera=(view:"wide"|"phone")=>{const p=view==="wide"?START:CLOSE;camera.body.x=p.x;camera.body.y=p.z;camera.yaw=p.yaw;camera.pitch=p.pitch;camera.release();camera.resetWalk()}
  setCamera("wide")
  const panel=new LabPanel(settings,controls(),new URLSearchParams(location.search),()=>camera.release(),{open:false,pill:false,groupActions:false})
  panel.addControls(contact,contactShadowControls("Shadows"))
  const fog=new FogScatter();Object.assign(fog.settings,{falloff:0.05,brightness:0.003,strength:0.4})
  const lights=new SceneLights(),spots=new SpotShadows(device,{count:4,size:1024})
  renderer.setSpotShadows(spots.bindings())
  const buffer=device.createBuffer({size:world.data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(buffer,0,world.data)
  const props=await officeProps(renderer)
  const physics=new OfficePhysics(chairs),continuity=new Continuity()
  const moving=smoke?null:new MovingMeshPass(renderer.passContext,movingMeshes,hooks)
  if(moving)renderer.addPass("opaque",moving)
  const casters=[{buffer,count:world.vertices,stride:24},...props.casters,...(moving?.casters??[])]
  const frame=newSceneFrame(),custom=new Float32Array(40),dustField=new DustField()
  const beamDust=smoke?null:new BeamDust(renderer.passContext)
  if(beamDust)renderer.addPass("alpha",beamDust)
  let time=0,frames=0,paused=false,last=performance.now(),fixedTime:number|null=null
  let handYaw=0,lastLookYaw=0,officeReached=false
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
  function render(now:number) {
    const dt=Math.min(0.05,(now-last)/1000);last=now
    if(paused){requestAnimationFrame(render);return}
    time=fixedTime??time+dt
    const width=Math.max(1,Math.round(innerWidth*Math.min(devicePixelRatio,1.5))),height=Math.max(1,Math.round(innerHeight*Math.min(devicePixelRatio,1.5)))
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;renderer.resize(width,height)}
    camera.speed=call.phase==="pickup"||call.phase==="call"||call.phase==="hangup"?0:settings.speed
    physics.step(dt,camera.body,walls,settings)
    const before=[camera.body.x,camera.body.y]
    const vp=camera.update(dt,width/height,walls)
    physics.flutter(dt,camera.body.x,camera.body.y,Math.hypot(camera.body.x-before[0],camera.body.y-before[1])/Math.max(dt,.001),settings)
    const watched=physics.chairs.find(c=>Math.abs(c.homeZ-1.45)<.01)!
    continuity.step(time,vp,call.phase==="ended",settings,[watched.x-.6,0,watched.z-.6,watched.x+.6,1.1,watched.z+.6])
    let propsDirty=false
    movingMeshes.forEach((m,i)=>{
      if(m.kind==="chair"){
        const c=physics.chairs.find(c=>Math.hypot(c.homeX-m.x,c.homeZ-m.z)<.001)!
        propsDirty=moving!.transform(i,m.x,m.z,c.x-m.x,c.z-m.z,c.yaw+(c===watched?continuity.value("chair")*.6:0))||propsDirty
      }else if(m.kind==="paper")propsDirty=moving!.transform(i,m.x,m.z,0,0,0,physics.paper*(.7+.3*Math.sin(time*15+i)))||propsDirty
      else propsDirty=moving!.transform(i,m.x,m.z,0,continuity.value("drawer")*.22,0)||propsDirty
    })
    const hero=physics.chairs.find(c=>Math.abs(c.homeX-.65)<.001)!
    propsDirty=props.move("chair",hero.x-hero.homeX,hero.z-hero.homeZ,hero.yaw)||propsDirty
    propsDirty=props.move("mug",continuity.value("mug")*.16,continuity.value("mug")*.08,continuity.value("mug")*.5)||propsDirty
    if(propsDirty)spots.picker.invalidate()
    stepCall(call,dt,settings.pickup)
    const signal=tubeSignal(time,settings.flicker),flicker=signal.level, led=call.phase==="ringing"?0.18+0.82*ringEnvelope(time):call.phase==="ended"?0.015:0.7
    const lampDefs:SceneLight[]=[
      {id:1,x:-3.55,y:2.9,h:2.4,r:11,color:[1,0.43,0.14],power:settings.sodium,size:0.28,spot:{axis:[0.9,-0.5,-0.5],cosOuter:0.45,cosInner:0.75}},
      {id:2,x:-3.55,y:-.75,h:2.45,r:10,color:[1,0.43,0.14],power:settings.sodium*settings.deskSodium,size:0.32,spot:{axis:[0.6,-0.25,-0.72],cosOuter:0.88,cosInner:0.97}},
      {id:3,x:0,y:0,h:2.80,r:7,color:[0.78,0.89,0.87],power:settings.fluorescent*flicker,size:0.35,spot:{axis:[0,-1,0],cosOuter:0.15,cosInner:0.5}},
      {id:4,x:-0.74,y:-5.48,h:1.14,r:2.7,color:[0.16,1,0.48],power:settings.crt,size:0.19,spot:{axis:[0,-0.35,0.937],cosOuter:0.05,cosInner:0.5}},
      {id:5,x:props.indicator[0],y:props.indicator[2],h:props.indicator[1]+.004,r:0.18,color:[1,0.025,0.004],power:0.0005*led,size:0.008,unshadowed:true},
      {id:6,x:-3.6,y:-4,h:2.8,r:4,color:[0.6,0.77,0.68],power:settings.fluorescent*0.12*(settings.polish?1:flicker),size:0.25,unshadowed:true},
      {id:8,x:3.74,y:-8.1,h:1.13,r:4.2,color:[1,.58,.22],power:settings.officeLamp,size:.12,spot:{axis:[0,-.8,.6],cosOuter:.05,cosInner:.4}},
    ]
    if(camera.flashlight)lampDefs.push({id:7,x:camera.eye[0],y:camera.eye[2],h:camera.eye[1],r:12,color:[0.85,0.92,1],power:0.9,size:0.08,unshadowed:true,beam:{axis:camera.direction,halfAngle:0.27}})
    lights.update(lampDefs,[])
    const enc=device.createCommandEncoder()
    if(spots.update(enc,lampDefs.filter(l=>l.spot).map(l=>({id:l.id!,pos:[l.x,l.h,l.y] as const,axis:l.spot!.axis,range:l.r,intensity:l.id===3?settings.fluorescent:l.power,cosOuter:l.spot!.cosOuter})),camera.eye,dt,id=>lights.indexOf(id),casters))renderer.setSpotShadows(spots.bindings())
    device.queue.submit([enc.finish()])
    parts.begin()
    parts.push(indicator,props.indicator[0],props.indicator[1],props.indicator[2],0,[1,1,1],0,0,0)
    // One receiver travels to the left ear. Looking moves its held endpoint 1:1.
    const t=call.lift,rx=Math.cos(camera.yaw),rz=-Math.sin(camera.yaw),fx=-Math.sin(camera.yaw),fz=-Math.cos(camera.yaw)
    const end=[camera.eye[0]-rx*0.32+fx*0.08,camera.eye[1]-0.08,camera.eye[2]-rz*0.32+fz*0.08]
    handYaw+=camera.yaw-lastLookYaw;lastLookYaw=camera.yaw
    const p=props.cradle.position.map((v,i)=>v+(end[i]-v)*t),yaw=handYaw*t,roll=props.cradle.roll*(1-t)-1.25*t
    parts.push(receiver,p[0],p[1],p[2],yaw,[1,1,1],0,roll,0)
    const cord=[p[0]-RECEIVER_PAD*Math.cos(roll)*Math.sin(yaw),p[1]-RECEIVER_PAD*Math.sin(roll),p[2]+RECEIVER_PAD*Math.cos(roll)*Math.cos(yaw)]
    physics.cord(dt,cord,settings)
    custom.set([settings.ambient,settings.fog,settings.dust,time,flicker,led,settings.window,settings.officeLamp,t,0,0,0,...cord.map((v,i)=>v-CORD_END[i]),0])
    packContactShadowKnobs(contact,custom,16)
    custom.set([settings.penumbra,settings.bounce,0,0],24)
    custom.set([Number(settings.polish),settings.tubeEnds,settings.fluorescent/1.8,0],28)
    custom.set([...physics.swing,0],32)
    custom.set([0,0,0,continuity.value("monitor")],36);renderer.setCustomUniforms(custom)
    if(beamDust){dustField.step(dt,time,camera.body.x,camera.body.y,settings.polish?settings.dustWake:0);beamDust.frame(dustField.data,settings.polish&&settings.beamDust?settings.dust:0,settings.dustRadius,settings.dustBrightness,[lights.indexOf(1),lights.indexOf(2)])}
    for(let i=0;i<(!settings.polish?150:0);i++) {
      const x=-1.5+hash01(i,1)*3,y=0.3+hash01(i,2)*2.3,z=-6.2+hash01(i,3)*12
      const drift=Math.sin(time*0.12+i)*0.05
      // Dust near the pools only; world anchored, no camera-following particle field.
      const strength=Math.exp(-((z-0.5)**2)/5)*flicker+Math.exp(-((z+5.4)**2)/0.9)*0.4
      parts.sprite(true,x+drift,y+Math.sin(time*0.17+i*3)*0.03,z,0.0035,0.62,0.69,0.48,strength*settings.dust*0.09,0)
    }
    Object.assign(fog.settings,{density:settings.fog})
    const fogLamps:FogLamp[]=lampDefs.filter(l=>l.id===3||l.id===4).map(l=>({id:l.id!,x:l.x,y:l.h,z:l.y,range:l.r,color:l.color,intensity:l.power,axis:l.spot!.axis,size:l.size}))
    packSceneFrame(frame,{viewProj:vp,eye:camera.eye,time,width,height,lightCount:lights.lightCount,ambient:[0,0,0,0],mapSize:[20,20],ao:0})
    renderer.render({frame,lights:lights.lights,lightCount:lights.lightCount,shadowLightCount:lights.shadowLightCount,occluders:lights.occ,occluderCount:lights.occCount,lampPower:lights.power,lampCount:0,view:[-7,-10,7,10],batches:parts.batches(),alphaSprites:parts.alpha,alphaCount:parts.nAlpha,addSprites:parts.add,addCount:parts.nAdd,grade:smoke?[0,0,0,settings.exposure]:[time,settings.lensVignette,settings.lensGrain,settings.exposure],postParams:[settings.lensSoftness,settings.lensFringe,Number(settings.polish&&settings.lens)],fog:fog.update({eye:camera.eye,viewProj:vp,lamps:fogLamps}),volume:smoke?[fog.volumeInput()]:[contactShadowInput(contact),fog.volumeInput()]})
    const dx=PHONE.x-camera.eye[0],dz=PHONE.z-camera.eye[2]
    audio.update(time,distance(),(dx*Math.cos(camera.yaw)-dz*Math.sin(camera.yaw))/Math.max(distance(),0.1),call,settings.volume,document.pointerLockElement===canvas&&!document.hidden,flicker)
    audio.movement({time:camera.walk.time,x:camera.body.x,z:camera.body.y,yaw:camera.yaw,volume:settings.volume,active:document.pointerLockElement===canvas&&!document.hidden&&!panel.visible,tube:flicker,foley:settings.foley,room:settings.roomTone,ballast:settings.polish&&settings.tubeSound?signal:undefined,crackle:settings.tubeCrackle},camera.walk.events)
    prompt.innerHTML=call.phase==="ringing"&&canAnswer()?keyPromptHtml("KeyE","Answer"):call.phase==="call"?keyPromptHtml("KeyE","Hang up"):""
    if(call.phase==="ended") {
      officeReached ||= Math.hypot(camera.body.x-OFFICE.x,camera.body.y-OFFICE.z)<.65
      prompt.textContent=officeReached?"Jay’s office · to be continued":"Find Jay’s corner office at the far right of the floor."
    }
    sub.textContent=subtitle(call)
    frames++;if(smoke&&frames>=2)paused=true
    requestAnimationFrame(render)
  }
  Object.assign(window,{nightshift:{camera,settings,renderer,call,action,setCamera,renderFoley,physics,continuity,dustField,tubeSignal,cradle:props.cradle,get clock(){return time},get frames(){return frames},get paused(){return paused},set paused(v:boolean){paused=v},set time(v:number){fixedTime=v},ready:true}})
  requestAnimationFrame(render)
}
void main().catch(e=>{console.error(e);document.getElementById("hud")!.textContent=String(e)})
