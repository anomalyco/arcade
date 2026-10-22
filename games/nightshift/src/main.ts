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
import { attachCameraFilter } from "@arcade/kit/gpu/post/camcorder"
import { controls, defaults } from "./settings"
import { hooks, post, fogVolume, contactVolume } from "./shaders"
import { buildWorld, handset, phoneIndicator, PHONE, START, CLOSE, CORD_END, RECEIVER_PAD, walls, chairs, movingMeshes, CONTINUITY_MONITOR, COLLEAGUES } from "./world"
import { newCall, interact, stepCall, subtitle, ringEnvelope, CALL_FIRST_LINE_END } from "../shared/call"
import { OfficeAudio, renderBeatAudio } from "./audio"
import { officeProps } from "./props"
import { renderFoley } from "./foley"
import { BeamDust, DustField } from "./polish/dust"
import { tubeSignal } from "./polish/tube"
import { lensPost } from "./polish/lens"
import { OfficePhysics } from "./polish/props"
import { Continuity } from "./polish/continuity"
import { MovingMeshPass } from "./polish/moving-mesh"
import { Opening, OPENING, openingSettings, cordLimit, CORD_REACH } from "./opening"
import { Terminal, colleagueScreens } from "./terminal"
import { elevatorLeaf } from "./elevator"
import { Descent, BASEMENT_X, descentDefaults } from "./descent/state"
import { buildBasement } from "./descent/room"
import { hallScreens, carDisplay } from "./descent/screens"
import { DescentAudio, renderDescentAudio, type DescentAudioFrame } from "./descent/audio"
import { descentControls } from "./descent/controls"
import { BootScreen, bootBytes } from "@arcade/kit/client/boot-screen"
import { BOOT_PLAN, OFFICE_FILES } from "./assets"

const boot=new BootScreen(BOOT_PLAN)
performance.mark("nightshift:program")
const bundle=(performance.getEntriesByName(import.meta.url)[0] as PerformanceResourceTiming|undefined)?.encodedBodySize
boot.done("program",bundle?bootBytes(bundle):"OK")
// Start every office file as soon as the bundle runs, in parallel with WebGPU, the world build and each other.
const officeBytes=new Map(OFFICE_FILES.map(f=>{const p=boot.fetch(f.id,`${import.meta.env.BASE_URL}${f.path}`,f.label);p.catch(()=>{});return [f.path,p]}))

async function main() {
  const canvas=document.querySelector<HTMLCanvasElement>("#view")!,hud=document.getElementById("hud")!,prompt=document.getElementById("prompt")!,sub=document.getElementById("subtitle")!
  boot.stage("video","VIDEO ADAPTER")
  const gpu=await openGpu(canvas,"NIGHT SHIFT")
  if(typeof gpu==="string"){hud.textContent=gpu;boot.fail("NO VIDEO ADAPTER: THIS OFFICE NEEDS WEBGPU");return}
  boot.done("video")
  const pipelines=boot.watchPipelines(gpu.device)
  boot.stage("office","LOADING OFFICE.DAT");await boot.paint()
  performance.mark("nightshift:gpu")
  const smoke=new URLSearchParams(location.search).has("smoke")
  const {device}=gpu,settings=defaults(),world=buildWorld(!smoke),audio=new OfficeAudio(),call=newCall()
  const opening=new Opening(),cinema=openingSettings(),elevator=new Descent(),terminal=new Terminal(device)
  const descent=descentDefaults(),basement=buildBasement(),storyAudio=new DescentAudio()
  let storyFrame:DescentAudioFrame|null=null
  let seen=false
  try{seen=localStorage.getItem("nightshift.openingSeen")==="true"}catch{}
  const repeatView=seen
  if(smoke)settings.polish=0
  const contact=createContactShadowSettings({mode:"screen",length:0.35,thickness:0.06})
  const renderer=new Renderer(device,gpu.context,gpu.format,{scene:makeSceneShader(hooks),sprite:spriteShader(),post:smoke?post:lensPost,volume:smoke?[fogVolume]:[contactVolume,fogVolume]})
  renderer.setTemporal({...TEMPORAL_DEFAULTS,mode:"taa",sharpen:0.15})
  renderer.setLevel({chunks:[{data:world.data,box:[-7,-10,7,11]},{data:basement.data,box:basement.box}],glass:[],...flatLighting(0,0,[0,0,0])})
  const receiver=renderer.addModel(handset()),indicator=renderer.addModel(phoneIndicator()),parts=new FrameParts()
  const leaf=renderer.addModel(elevatorLeaf())
  settings.reduceMotion=matchMedia("(prefers-reduced-motion: reduce)").matches
  try{const saved=localStorage.getItem("nightshift.reduceMotion");if(saved!==null)settings.reduceMotion=saved==="true"}catch{}
  boot.reducedMotion=settings.reduceMotion
  const camera:WalkCamera=new WalkCamera(canvas,()=>panel.visible||!boot.isReady||boot.failed,settings,()=>document.pointerLockElement===canvas&&!document.hidden&&!panel.visible&&camera.speed>0)
  camera.height=1.65;camera.fov=68;camera.far=45;camera.near=0.045
  const setCamera=(view:"wide"|"phone")=>{const p=view==="wide"?START:CLOSE;camera.body.x=p.x;camera.body.y=p.z;camera.yaw=p.yaw;camera.pitch=p.pitch;camera.release();camera.resetWalk();opening.started=opening.complete=opening.standing=true;opening.time=OPENING.end;opening.height.x=camera.height=1.65}
  Object.assign(camera.body,{x:OPENING.seat.x,y:OPENING.seat.z});Object.assign(camera,{height:OPENING.seat.height,yaw:OPENING.seat.yaw,pitch:OPENING.seat.pitch})
  if(smoke)setCamera("wide")
  const panel=new LabPanel(settings,controls(),new URLSearchParams(location.search),()=>camera.release(),{open:false,pill:false,groupActions:false})
  panel.addControls(contact,contactShadowControls("Shadows"))
  panel.addControls(descent,descentControls)
  const cameraFilter=attachCameraFilter(renderer,panel,device,gpu.format,{bodycam:camera})
  panel.addControls(cinema,[{key:"whipDuration",label:"Phone whip",min:.25,max:1,step:.01,unit:"s",group:"Opening"},{key:"whipBlur",label:"Whip blur",min:0,max:1,step:.05,unit:"×",group:"Opening"}])
  const fog=new FogScatter();Object.assign(fog.settings,{falloff:0.05,brightness:0.003,strength:0.4})
  const lights=new SceneLights(),spots=new SpotShadows(device,{count:4,size:1024})
  renderer.setSpotShadows(spots.bindings())
  const buffer=device.createBuffer({size:world.data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(buffer,0,world.data)
  const hallBuffer=device.createBuffer({size:basement.data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(hallBuffer,0,basement.data)
  boot.done("office");performance.mark("nightshift:office")
  const shaders=boot.stage("shaders","COMPILING SHADERS")
  void device.queue.onSubmittedWorkDone().then(()=>{shaders.done(`${pipelines()} PROGRAMS`);performance.mark("nightshift:shaders")})
  // Each file decodes in its own task, so the boot log repaints between them.
  const props=await officeProps(renderer,terminal.texture,{bytes:async path=>{const bytes=await officeBytes.get(path)!;await new Promise(r=>setTimeout(r));return bytes},loaded:path=>boot.done(OFFICE_FILES.find(f=>f.path===path)!.id)}),screens=colleagueScreens(renderer)
  const hall=hallScreens(renderer,basement.screens),display=carDisplay(renderer)
  performance.mark("nightshift:props")
  const physics=new OfficePhysics(chairs),continuity=new Continuity()
  const moving=smoke?null:new MovingMeshPass(renderer.passContext,movingMeshes,hooks)
  if(moving)renderer.addPass("opaque",moving)
  const casters=[{buffer,count:world.vertices,stride:24},{buffer:hallBuffer,count:basement.vertices,stride:24},...props.casters,...screens.pass.shadowCasters(),...hall.pass.shadowCasters(),...(moving?.casters??[])]
  const frame=newSceneFrame(),custom=new Float32Array(40),dustField=new DustField()
  const beamDust=smoke?null:new BeamDust(renderer.passContext)
  if(beamDust)renderer.addPass("alpha",beamDust)
  let time=0,frames=0,paused=false,stepping=false,last=performance.now(),fixedTime:number|null=null
  let handYaw=0,lastLookYaw=0,answered=false,parked=0
  const watched=physics.chairs.find(c=>Math.hypot(c.homeX-2.75,c.homeZ+.3)<.01)!
  const monitor=CONTINUITY_MONITOR
  continuity.targets.find(t=>t.kind==="monitor")!.bounds=[monitor.x-.3,.79,monitor.z-.3,monitor.x+.3,1.5,monitor.z+.3]
  const holdToCord=(body:{x:number;y:number},from:readonly number[])=>{cordLimit(body,from,PHONE,CORD_REACH)}
  const distance=()=>Math.hypot(camera.body.x-PHONE.x,camera.body.y-PHONE.z)
  const canAnswer=()=>distance()<1.35 && camera.direction[0]*(PHONE.x-camera.eye[0])+camera.direction[2]*(PHONE.z-camera.eye[2])>0.15
  const canHangUp=()=>repeatView&&call.phase==="call"&&call.elapsed>=CALL_FIRST_LINE_END
  const action=()=>{
    if(!opening.complete||elevator.phase!=="floor"||!audio.ready||call.phase==="call"&&!canHangUp())return
    if((call.phase==="ringing"&&canAnswer())||call.phase==="call") {
      camera.release();handYaw=Math.atan2(Math.sin(camera.yaw),Math.cos(camera.yaw));lastLookYaw=camera.yaw
    }
    interact(call,canAnswer())
    if(call.phase==="pickup")answered=true
  }
  const prompts=()=>hud.innerHTML=[keyPromptHtml("Mouse0","Look"),keyPromptHtml("KeyW","Move"),keyPromptHtml("KeyF","Flashlight"),keyPromptHtml("KeyM","Mute"),keyPromptHtml("Backquote","Office")].join(" ")
  prompts();onKeyLayoutChange(prompts)
  canvas.addEventListener("click",()=>{if(!boot.isReady||boot.failed)return;opening.start();void audio.unlock().then(()=>storyAudio.unlock(audio.context!))})
  window.addEventListener("mousemove",e=>{if(!opening.complete)e.stopImmediatePropagation()},true)
  window.addEventListener("keydown",e=>{
    if(isEditableEventTarget(e.target)||panel.visible||e.metaKey||e.ctrlKey||e.altKey||document.pointerLockElement!==canvas)return
    if(!opening.complete){
      if(e.code==="Space"&&!e.repeat)opening.skip(seen)
      if(e.code!=="Backquote"&&e.code!=="KeyM"){e.preventDefault();e.stopImmediatePropagation()}
    }else if(["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowLeft","ArrowDown","ArrowRight"].includes(e.code))opening.stand()
  },true)
  window.addEventListener("keydown",e=>{if(e.repeat||e.metaKey||e.ctrlKey||e.altKey||isEditableEventTarget(e.target)||panel.visible||document.pointerLockElement!==canvas)return;if(e.code==="KeyE")action();if(e.code==="KeyM")audio.muted=!audio.muted})
  window.addEventListener("pagehide",()=>{storyAudio.dispose();audio.dispose()})
  function render(now:number) {
    const dt=Math.min(0.05,(now-last)/1000);last=now
    if(paused&&!stepping){requestAnimationFrame(render);return}
    const active=document.pointerLockElement===canvas&&document.hasFocus()&&!document.hidden&&!panel.visible
    const wasComplete=opening.complete
    opening.step(dt,active,settings.reduceMotion,cinema.whipDuration)
    if(!wasComplete&&opening.complete){camera.release();camera.resetWalk();seen=true;try{localStorage.setItem("nightshift.openingSeen","true")}catch{}}
    time=fixedTime??time+(active?dt:0)
    if(!opening.complete){camera.yaw=opening.yaw.x;camera.pitch=opening.pitch.x}
    camera.height=opening.height.x
    terminal.update(opening.time,opening.tokens)
    const width=Math.max(1,Math.round(innerWidth*Math.min(devicePixelRatio,1.5))),height=Math.max(1,Math.round(innerHeight*Math.min(devicePixelRatio,1.5)))
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;renderer.resize(width,height)}
    const onCord=call.phase==="pickup"||call.phase==="call"
    const playerMoving=active&&opening.complete&&!elevator.done
    camera.speed=playerMoving?settings.speed:0
    if(!playerMoving)camera.release()
    const simDt=active?dt:0
    if(active&&!elevator.downstairs)physics.step(dt,camera.body,walls,settings)
    const station=call.phase!=="ended"?-1:COLLEAGUES.findIndex(s=>{
      const dx=s.x-camera.eye[0],dy=1.13-camera.eye[1],dz=s.z-.155-camera.eye[2],d=Math.hypot(dx,dy,dz)
      return d<1.6&&camera.eye[2]<s.z-.2&&(dx*camera.direction[0]+dy*camera.direction[1]+dz*camera.direction[2])/d>.9
    })
    const wasDownstairs=elevator.downstairs
    elevator.step(simDt,camera.body,opening.complete,station,descent,call.phase==="ended")
    if(wasDownstairs!==elevator.downstairs)spots.picker.invalidate()
    camera.height+=elevator.sway(time,settings.reduceMotion,descent)
    const sceneWalls=elevator.downstairs?basement.walls:walls
    const before=[camera.body.x,camera.body.y]
    // Keep the authored seated pose; optional camera movement comes in with the first-move stand.
    cameraFilter.motion=settings.reduceMotion?0:Math.max(0,Math.min(1,(opening.height.x-OPENING.across.height)/(1.65-OPENING.across.height)))
    camera.constrain=onCord?holdToCord:undefined
    const vp=camera.update(dt,width/height,[...sceneWalls,...elevator.collisions(call.phase==="ended")])
    physics.flutter(simDt,camera.body.x,camera.body.y,playerMoving?Math.hypot(camera.body.x-before[0],camera.body.y-before[1])/Math.max(dt,.001):0,settings)
    continuity.step(time,vp,call.phase==="ended",settings,[watched.x-.6,0,watched.z-.6,watched.x+.6,1.1,watched.z+.6],active&&opening.complete&&!elevator.downstairs)
    screens.update(continuity.value("monitor"))
    if(elevator.downstairs)hall.update(time,settings.reduceMotion)
    display.update(elevator.riding?elevator.elapsed/descent.rideSeconds:0,elevator.phase==="opening"||elevator.phase==="basement"||elevator.phase==="ending")
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
    if(active&&opening.complete&&(call.phase!=="call"||audio.ready))stepCall(call,dt,settings.pickup)
    const ringTime=Math.max(0,opening.time-OPENING.ring)
    const signal=tubeSignal(time,settings.flicker),flicker=signal.level, led=opening.time<OPENING.ring?0.015:call.phase==="ringing"?0.18+0.82*ringEnvelope(ringTime):call.phase==="ended"?0.015:0.7
    const lampDefs:SceneLight[]=[
      {id:1,x:-3.55,y:2.9,h:2.4,r:11,color:[1,0.43,0.14],power:settings.sodium,size:0.28,spot:{axis:[0.9,-0.5,-0.5],cosOuter:0.45,cosInner:0.75}},
      {id:2,x:-3.55,y:-.75,h:2.45,r:10,color:[1,0.43,0.14],power:settings.sodium*settings.deskSodium,size:0.32,spot:{axis:[0.6,-0.25,-0.72],cosOuter:0.88,cosInner:0.97}},
      {id:3,x:0,y:0,h:2.80,r:7,color:[0.78,0.89,0.87],power:settings.fluorescent*flicker,size:0.35,spot:{axis:[0,-1,0],cosOuter:0.15,cosInner:0.5}},
      {id:4,x:-0.74,y:-5.48,h:1.14,r:2.7,color:[0.16,1,0.48],power:settings.crt,size:0.19,spot:{axis:[0,-0.35,0.937],cosOuter:0.05,cosInner:0.5}},
      {id:5,x:props.indicator[0],y:props.indicator[2],h:props.indicator[1]+.004,r:0.18,color:[1,0.025,0.004],power:0.0005*led,size:0.008,unshadowed:true},
      {id:6,x:-3.6,y:-4,h:2.8,r:4,color:[0.6,0.77,0.68],power:settings.fluorescent*0.12*(settings.polish?1:flicker),size:0.25,unshadowed:true},
      {id:8,x:3.74,y:-8.1,h:1.13,r:4.2,color:[1,.58,.22],power:settings.officeLamp,size:.12,spot:{axis:[0,-.8,.6],cosOuter:.05,cosInner:.4}},
      {id:9,x:0,y:10,h:2.45,r:4,color:[1,.49,.16],power:1.5,size:.3,unshadowed:true},
    ]
    if(elevator.downstairs)lampDefs.splice(0,lampDefs.length,...basement.lamps.map(l=>({...l,power:l.power*(.97+.03*Math.sin(time*.61+l.id!))})))
    if(camera.flashlight)lampDefs.push({id:7,x:camera.eye[0],y:camera.eye[2],h:camera.eye[1],r:12,color:[0.85,0.92,1],power:0.9,size:0.08,unshadowed:true,beam:{axis:camera.direction,halfAngle:0.27}})
    lights.update(lampDefs,[])
    const enc=device.createCommandEncoder()
    if(spots.update(enc,lampDefs.filter(l=>l.spot).map(l=>({id:l.id!,pos:[l.x,l.h,l.y] as const,axis:l.spot!.axis,range:l.r,intensity:l.id===3?settings.fluorescent:l.power,cosOuter:l.spot!.cosOuter})),camera.eye,dt,id=>lights.indexOf(id),casters))renderer.setSpotShadows(spots.bindings())
    device.queue.submit([enc.finish()])
    parts.begin()
    for(const ox of [0,BASEMENT_X])for(const side of [-1,1])parts.push(leaf,ox+side*elevator.leafX,0,9.06,0,[1,1,1],0,0,0)
    parts.push(indicator,props.indicator[0],props.indicator[1],props.indicator[2],0,[1,1,1],0,0,0)
    // Set the one receiver beside the base when leaving; the optional lines stay at this desk.
    // The cord holds you within reach while the receiver is up, so the handset parks only when the call ends.
    if(answered&&(parked>0||call.phase==="hangup"||call.phase==="ended"))parked=Math.min(1,parked+simDt/.6)
    const park=parked*parked*(3-2*parked),t=call.lift*(1-park),rx=Math.cos(camera.yaw),rz=-Math.sin(camera.yaw),fx=-Math.sin(camera.yaw),fz=-Math.cos(camera.yaw)
    const end=[camera.eye[0]-rx*0.32+fx*0.08,camera.eye[1]-0.08,camera.eye[2]-rz*0.32+fz*0.08]
    handYaw+=camera.yaw-lastLookYaw;lastLookYaw=camera.yaw
    const rest=[PHONE.x+.25,PHONE.y+.029,PHONE.z+.08]
    const p=props.cradle.position.map((v,i)=>v+(end[i]-v)*t+(rest[i]-v)*park),yaw=handYaw*t+Math.PI/2*park,roll=props.cradle.roll*(1-t-park)-1.25*t
    parts.push(receiver,p[0],p[1],p[2],yaw,[1,1,1],0,roll,0)
    const cord=[p[0]-RECEIVER_PAD*Math.cos(roll)*Math.sin(yaw),p[1]-RECEIVER_PAD*Math.sin(roll),p[2]+RECEIVER_PAD*Math.cos(roll)*Math.cos(yaw)]
    physics.cord(simDt,cord,settings)
    custom.set([settings.ambient,settings.fog,settings.dust,time,flicker,led,settings.window,settings.officeLamp,t,0,0,0,...cord.map((v,i)=>v-CORD_END[i]),0])
    packContactShadowKnobs(contact,custom,16)
    custom.set([settings.penumbra,settings.bounce,0,0],24)
    custom.set([Number(settings.polish),settings.tubeEnds,settings.fluorescent/1.8,0],28)
    custom.set([...physics.swing,0],32)
    custom.set([0,0,0,continuity.value("monitor")],36);renderer.setCustomUniforms(custom)
    if(beamDust){dustField.step(simDt,time,camera.body.x,camera.body.y,settings.polish&&playerMoving?settings.dustWake:0);beamDust.frame(dustField.data,settings.polish&&settings.beamDust?settings.dust:0,settings.dustRadius,settings.dustBrightness,[lights.indexOf(1),lights.indexOf(2)])}
    for(let i=0;i<(!settings.polish?150:0);i++) {
      const x=-1.5+hash01(i,1)*3,y=0.3+hash01(i,2)*2.3,z=-6.2+hash01(i,3)*12
      const drift=Math.sin(time*0.12+i)*0.05
      // Dust near the pools only; world anchored, no camera-following particle field.
      const strength=Math.exp(-((z-0.5)**2)/5)*flicker+Math.exp(-((z+5.4)**2)/0.9)*0.4
      parts.sprite(true,x+drift,y+Math.sin(time*0.17+i*3)*0.03,z,0.0035,0.62,0.69,0.48,strength*settings.dust*0.09,0)
    }
    Object.assign(fog.settings,{density:settings.fog})
    const fogLamps:FogLamp[]=lampDefs.filter(l=>l.spot&&(elevator.downstairs||l.id===3||l.id===4)).map(l=>({id:l.id!,x:l.x,y:l.h,z:l.y,range:l.r,color:l.color,intensity:l.power,axis:l.spot!.axis,size:l.size}))
    packSceneFrame(frame,{viewProj:vp,eye:camera.eye,time,width,height,lightCount:lights.lightCount,ambient:[0,0,0,0],mapSize:[20,20],ao:0})
    const blur=!opening.complete&&!settings.reduceMotion?Math.max(-.12,Math.min(.12,opening.yaw.v/60*cinema.whipBlur)):0
    const fade=Math.max(opening.fade,elevator.fade)
    cameraFilter.fade=fade
    renderer.render({frame,lights:lights.lights,lightCount:lights.lightCount,shadowLightCount:lights.shadowLightCount,occluders:lights.occ,occluderCount:lights.occCount,lampPower:lights.power,lampCount:0,view:elevator.downstairs?basement.box:[-7,-10,7,11],batches:parts.batches(),alphaSprites:parts.alpha,alphaCount:parts.nAlpha,addSprites:parts.add,addCount:parts.nAdd,grade:smoke?[0,0,0,settings.exposure]:[time,settings.lensVignette,settings.lensGrain,settings.exposure],postParams:[settings.lensSoftness,settings.lensFringe,Number(settings.polish&&settings.lens)],postCustom:[blur,cameraFilter.active?0:fade,elevator.downstairs&&camera.body.y<8&&!settings.reduceMotion?descent.heat:0,time],fog:fog.update({eye:camera.eye,viewProj:vp,lamps:fogLamps}),volume:smoke?[fog.volumeInput()]:[contactShadowInput(contact),fog.volumeInput()]})
    const dx=PHONE.x-camera.eye[0],dz=PHONE.z-camera.eye[2]
    audio.update(ringTime,distance(),(dx*Math.cos(camera.yaw)-dz*Math.sin(camera.yaw))/Math.max(distance(),0.1),call,settings.volume*(1-elevator.fade),active&&opening.started,opening.time,park)
    audio.movement({time:camera.walk.time,x:camera.body.x,z:camera.body.y,yaw:camera.yaw,volume:settings.volume*(1-elevator.fade),active:active&&opening.started,tube:flicker,foley:settings.foley,room:elevator.downstairs?0:settings.roomTone*opening.roomGain,ballast:settings.polish&&settings.tubeSound?signal:undefined,crackle:settings.tubeCrackle},camera.walk.events)
    storyFrame={time,line:elevator.line,lineTime:elevator.lineTime,x:camera.body.x,z:camera.body.y,yaw:camera.yaw,downstairs:elevator.downstairs,speed:elevator.speed,volume:settings.volume*(1-elevator.fade),voice:descent.voice,machinery:descent.machinery,active:active&&opening.started&&!audio.muted}
    storyAudio.update(storyFrame)
    hud.style.visibility=opening.complete&&!elevator.done?"visible":"hidden"
    document.getElementById("reticle")!.style.visibility=opening.complete&&!elevator.done?"visible":"hidden"
    document.getElementById("title")!.style.opacity=String(.55*(1-fade))
    document.getElementById("credits")!.style.visibility=opening.complete&&!elevator.done?"visible":"hidden"
    if(opening.started)void boot.dismiss()
    prompt.innerHTML=!opening.started?"":!active?keyPromptHtml("Mouse0","Resume"):!opening.complete?seen?keyPromptHtml("Space","Skip opening"):"":call.phase==="ringing"&&canAnswer()?audio.error?"Call audio could not load. Reload to retry.":audio.ready?keyPromptHtml("KeyE","Answer"):"Connecting…":canHangUp()?keyPromptHtml("KeyE","Hang up"):""
    if(call.phase==="ended"&&active)prompt.textContent=elevator.phase==="floor"?"Take the elevator at the far end of the floor.":""
    sub.textContent=elevator.done?"":elevator.subtitle||subtitle(call)
    frames++;if(smoke&&frames>=2)paused=true
    // Begin waits for the GPU to finish the first frame, so the opening never starts on a compile stall.
    if(frames===1)void device.queue.onSubmittedWorkDone().then(()=>{boot.ready(["READY.","","> SESSION 087    02:13"],keyPromptHtml("Mouse0","Begin"));performance.mark("nightshift:ready")})
    requestAnimationFrame(render)
  }
  Object.assign(window,{nightshift:{camera,settings,cinema,opening,elevator,audio,renderer,call,action,setCamera,renderFoley,renderBeatAudio,renderDescentAudio,descent,storyAudio,get parked(){return parked},get storyFrame(){return storyFrame},physics,continuity,dustField,tubeSignal,cradle:props.cradle,get clock(){return time},step(ms:number){stepping=true;try{render(last+ms)}finally{stepping=false}},get frames(){return frames},get paused(){return paused},set paused(v:boolean){paused=v},set time(v:number){fixedTime=v},ready:true}})
  boot.stage("frame","FIRST FRAME")
  requestAnimationFrame(render)
}
void main().catch(e=>{console.error(e);document.getElementById("hud")!.textContent=String(e);boot.fail(e instanceof Error&&/DISK ERROR/.test(e.message)?e.message:"SYSTEM ERROR. THE OFFICE COULD NOT LOAD")})
