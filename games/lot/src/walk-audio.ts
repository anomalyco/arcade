import { Footsteps, type FootEvent, type FootSurface } from "@arcade/kit/audio/footsteps"
import { encodeWavPcm16 } from "@arcade/kit/audio/offline"
import { ambiencePcm, type AmbientSound } from "./ambience"
import type { WalkSettings } from "./walk-settings"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import type { StormAudioFrame, StormListener } from "./weather/audio"
export type AudioLamp={position:readonly number[]}
export type WalkAudioFrame={time:number;x:number;z:number;yaw:number;active:boolean;surface:FootSurface;inside:boolean;wetness:number;events:FootEvent[];settings:WalkSettings;storm?:StormAudioFrame}
/** Weather sound inside the walking master (weather/audio.ts), attached once weather is first turned on. */
/** `play`: the walking sound is audible and its clock is running; one-shots and thunder are only scheduled then. */
export type StormVoice={update(f:StormAudioFrame,l:StormListener,now:number,play:boolean):void;interrupt():void}
export type StormLoader=(ctx:BaseAudioContext,destination:AudioNode)=>Promise<StormVoice>

/** Scene-owned emitter placement; shared footsteps own contact synthesis and scheduling. */
export class LotAudioGraph {
  private master:GainNode
  private feet:Footsteps
  private buffers=new Map<AmbientSound,AudioBuffer>()
  private loops:{kind:AmbientSound;gain:GainNode;pan:StereoPannerNode;position?:readonly number[]}[]=[]
  private dripAt=1.8
  private animalAt=23
  private serial=0
  private oneShots=new Set<AudioBufferSourceNode>()
  private storm?:StormVoice
  private stormLoading?:Promise<void>
  constructor(private ctx:BaseAudioContext,destination:AudioNode,lamps:readonly AudioLamp[]){
    this.master=ctx.createGain();this.master.gain.value=0;this.master.connect(destination)
    this.feet=new Footsteps(ctx,this.master)
    for(const kind of ["wind","traffic","hvac"] as const)this.loop(kind)
    for(const lamp of lamps)this.loop("buzz",lamp.position)
  }
  private buffer(kind:AmbientSound){
    let b=this.buffers.get(kind)
    if(!b){const pcm=ambiencePcm(kind);b=this.ctx.createBuffer(1,pcm.length,24000);b.copyToChannel(pcm,0);this.buffers.set(kind,b)}return b
  }
  private voice(kind:AmbientSound){const source=this.ctx.createBufferSource(),gain=this.ctx.createGain(),pan=this.ctx.createStereoPanner();source.buffer=this.buffer(kind);source.connect(gain);gain.connect(pan);pan.connect(this.master);return {source,gain,pan}}
  private loop(kind:AmbientSound,position?:readonly number[]){const v=this.voice(kind);v.source.loop=true;v.gain.gain.value=0;v.source.start();this.loops.push({kind,...v,position})}
  attachStorm(load:StormLoader){
    // A failed fetch is not cached: the next attach (weather toggled again, the next play gesture) tries again.
    this.stormLoading??=load(this.ctx,this.master).then(v=>{this.storm=v},e=>{this.stormLoading=undefined;throw e})
    return this.stormLoading
  }
  /** A suspended live context freezes `currentTime`; anything scheduled then would all fire at once on resume. */
  private get running(){return typeof AudioContext==="undefined"||!(this.ctx instanceof AudioContext)||this.ctx.state==="running"}
  update(f:WalkAudioFrame,now=this.ctx.currentTime){
    const s=f.settings,enabled=f.active&&s.walkMode!=="today"&&!s.muted,outside=f.inside?.12:1
    this.master.gain.setTargetAtTime(enabled?s.volume:0,now,.025)
    if(f.storm&&this.storm)this.storm.update(f.storm,{x:f.x,z:f.z,yaw:f.yaw,inside:f.inside,time:f.storm.clock},now,enabled&&this.running)
    for(const l of this.loops){
      let gain=0,pan=0
      if(l.kind==="wind")gain=s.wind*outside
      if(l.kind==="traffic"){gain=s.traffic*outside;pan=.25*Math.sin(f.time*.12)}
      if(l.kind==="hvac")gain=s.hvac*.8/(1+(Math.hypot(Math.max(-55-f.x,0,f.x-35),Math.max(0,f.z-22))/18)**2)
      if(l.position){
        const dx=l.position[0]!-f.x,dz=l.position[2]!-f.z,d=Math.hypot(dx,dz,l.position[1]!-1.7)
        gain=s.lamps*outside/(1+(d/4)**2)
        pan=Math.max(-.85,Math.min(.85,(dx*Math.cos(f.yaw)-dz*Math.sin(f.yaw))/Math.max(d,1)))
      }
      l.gain.gain.setTargetAtTime(gain,now,.1);l.pan.pan.setTargetAtTime(pan,now,.08)
    }
    if(!enabled)return
    this.feet.play(f.events.filter(e=>e.kind!=="creak"),f.surface,f.time,s.footsteps,now)
    const one=(kind:AmbientSound,gain:number,pan:number)=>{const v=this.voice(kind);v.gain.gain.value=gain;v.pan.pan.value=pan;this.oneShots.add(v.source);v.source.onended=()=>{this.oneShots.delete(v.source);v.source.disconnect();v.gain.disconnect();v.pan.disconnect()};v.source.start(now)}
    if(f.time>=this.dripAt){one("drip",s.drizzle*f.wetness*outside,.65*Math.sin(++this.serial*7.1));this.dripAt=f.time+1.2+(Math.sin(this.serial*17.3)*.5+.5)*2.8}
    if(f.time>=this.animalAt){one(this.serial%2?"owl":"dog",s.wildlife*outside*.35,.75*Math.sin(this.serial*4.1));this.animalAt=f.time+29+(this.serial%11)}
  }
  interrupt(){
    this.feet.stop();for(const source of this.oneShots)source.stop();this.oneShots.clear();this.storm?.interrupt()
    this.master.gain.cancelScheduledValues(this.ctx.currentTime)
    this.master.gain.setValueAtTime(0,this.ctx.currentTime)
  }
}
export class LotAudio {
  private ctx?:AudioContext
  private graph?:LotAudioGraph
  private stormLoader?:StormLoader
  constructor(private lamps:readonly AudioLamp[]){}
  async unlock(){if(!this.ctx){this.ctx=new AudioContext();this.graph=new LotAudioGraph(this.ctx,this.ctx.destination,this.lamps);if(this.stormLoader)this.attach(this.stormLoader)}await this.ctx.resume()}
  private attach(load:StormLoader){void this.graph!.attachStorm(load).catch(e=>{console.warn("Lot storm audio failed to load; retrying in 10 s",e);this.stormLoader=undefined;this.stormRetry=performance.now()+10000})}
  private stormRetry=0
  /** Weather was turned on: fetch its samples now (or at the next play gesture). */
  enableStorm(load:StormLoader){if(this.stormLoader||performance.now()<this.stormRetry)return;this.stormLoader=load;if(this.graph)this.attach(load)}
  update(frame:WalkAudioFrame){this.graph?.update(frame)}
  suspend(){this.graph?.interrupt();void this.ctx?.suspend()}
  dispose(){void this.ctx?.close()}
}
/** Explicit play gesture unlocks sound. Focus/pointer-lock loss suspends it;
 * returning to the tab does not restart it until the next play gesture. */
export function bindLotAudio(canvas:HTMLCanvasElement,audio:LotAudio,settings:WalkSettings,blocked:()=>boolean){
  const abort=new AbortController(),options={signal:abort.signal}
  const unlock=()=>{if(!blocked()&&settings.walkMode!=="today"&&!settings.muted)void audio.unlock().catch(e=>console.warn("Lot audio",e))}
  canvas.addEventListener("click",unlock,options)
  window.addEventListener("keydown",e=>{
    if(e.code!=="KeyM"||e.repeat||e.metaKey||e.ctrlKey||e.altKey||blocked()||isEditableEventTarget(e.target)||document.pointerLockElement!==canvas)return
    settings.muted=!settings.muted
    if(settings.muted)audio.suspend();else unlock()
  },options)
  window.addEventListener("blur",()=>audio.suspend(),options)
  document.addEventListener("visibilitychange",()=>{if(document.hidden)audio.suspend()},options)
  document.addEventListener("pointerlockchange",()=>{if(document.pointerLockElement!==canvas)audio.suspend()},options)
  const dispose=()=>{abort.abort();audio.dispose()}
  window.addEventListener("pagehide",e=>{if(e.persisted)audio.suspend();else dispose()},options)
  return dispose
}
export async function renderWalkAudio(tape:readonly WalkAudioFrame[],duration:number,lamps:readonly AudioLamp[],storm?:StormLoader){
  const ctx=new OfflineAudioContext(2,Math.ceil(duration*48000),48000),graph=new LotAudioGraph(ctx,ctx.destination,lamps)
  if(storm)await graph.attachStorm(storm)
  for(const frame of tape)graph.update(frame,frame.time)
  return encodeWavPcm16(await ctx.startRendering())
}
