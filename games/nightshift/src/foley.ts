import type { FoleyEvent } from "./walk"
import { encodeWavPcm16 } from "@arcade/kit/audio/offline"
import type { TubeSignal } from "./polish/tube"
export type Sound=FoleyEvent["kind"]|"hvac"|"hum"|"crackle"
export const durations:Record<Sound,number>={step:.26,cloth:.32,scuff:.38,bump:.55,creak:1.8,hvac:6,hum:2,crackle:2}
/** Original deterministic PCM synthesis; no samples or external licence obligations. */
export function synth(sound:Sound,seed:number,rate=24000):Float32Array<ArrayBuffer>{
  const duration=durations[sound],a=new Float32Array(Math.ceil(duration*rate))
  let rng=(seed+1)*7919,low=0,mid=0,phase=0
  const random=()=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return (rng>>>0)/4294967296*2-1}
  // Carpet compresses rather than clicks. Vary the envelope and low-pass colour,
  // not just the noise; keep the heel resonance below the soft fabric contact.
  const shade=sound==="step"?(random()+1)/2:0,weight=sound==="step"?.75+.25*(random()+1)/2:1
  for(let i=0;i<a.length;i++){
    const t=i/rate,u=t/duration,n=random(),attack=1-Math.exp(-t*180),end=Math.min(1,(duration-t)*35)
    low+=(n-low)*.045;mid+=(n-mid)*.28
    if(sound==="step"){
      const press=Math.sin(Math.min(1,t/(.022+.014*shade))*Math.PI/2)**2
      a[i]=((low*(.35+.1*shade)+mid*.025)*Math.exp(-t*(15+8*shade))+.009*Math.sin(2*Math.PI*(62+seed%23)*t)*Math.exp(-t*28))*press*end*weight
    }
    if(sound==="cloth"||sound==="scuff")a[i]=(mid-low)*Math.sin(Math.PI*u)**2*(sound==="cloth"?.055:.19)
    if(sound==="bump")a[i]=(.17*Math.sin(t*2*Math.PI*83)+.085*Math.sin(t*2*Math.PI*151)+mid*.08)*attack*Math.exp(-t*12)*end
    if(sound==="creak"){
      phase+=2*Math.PI*(270+40*Math.sin(t*6)+17*Math.sin(t*39))/rate
      a[i]=(.035*Math.sin(phase)+.016*Math.sin(phase*2.01)+mid*.035)*Math.sin(Math.PI*u)**2*(.7+.3*Math.sin(t*48))
    }
    if(sound==="hvac")a[i]=low*.08+Math.sin(2*Math.PI*48*t)*.004
    if(sound==="hum")a[i]=.012*Math.sin(2*Math.PI*120*t)+.003*Math.sin(2*Math.PI*240*t)+.002*Math.sin(2*Math.PI*360*t)
    if(sound==="crackle")a[i]=(n-mid)*.09
  }
  // Crossfade the noisy HVAC loop's seam. The hum contains integer cycles.
  if(sound==="hvac"){
    const overlap=rate/10
    for(let i=0;i<overlap;i++){const t=i/overlap;a[a.length-overlap+i]=a[a.length-overlap+i]!*(1-t)+a[i]!*t}
    return a.slice(overlap)
  }
  return a
}
export type RoomSample={time:number;x:number;z:number;yaw:number;volume:number;active:boolean;tube:number;foley:number;room:number;ballast?:TubeSignal;crackle?:number}
export type FoleyFrame={room:RoomSample;events:FoleyEvent[]}
export async function renderFoley(tape:readonly FoleyFrame[],duration:number){
  const ctx=new OfflineAudioContext(2,Math.ceil(duration*48000),48000),foley=new Foley(ctx,ctx.destination)
  for(const frame of tape)foley.update(frame.room,frame.events,frame.room.time)
  return encodeWavPcm16(await ctx.startRendering())
}
/** Same graph schedules live sound and the offline proof. No speaker destination in offline mode. */
export class Foley {
  private cache=new Map<string,AudioBuffer>()
  private master:GainNode
  private air:GainNode
  private hum:GainNode
  private crackle:GainNode
  private humPan:StereoPannerNode
  constructor(private ctx:BaseAudioContext,destination:AudioNode){
    this.master=ctx.createGain();this.master.gain.value=0;this.master.connect(destination)
    this.air=this.loop("hvac",this.master)
    this.humPan=ctx.createStereoPanner();this.humPan.connect(this.master)
    this.hum=this.loop("hum",this.humPan)
    this.crackle=this.loop("crackle",this.humPan)
  }
  private buffer(kind:Sound,seed:number){
    const variants=kind==="step"?32:8,key=`${kind}:${seed%variants}`;let b=this.cache.get(key)
    if(!b){const pcm=synth(kind,seed%variants);b=this.ctx.createBuffer(1,pcm.length,24000);b.copyToChannel(pcm,0);this.cache.set(key,b)}return b
  }
  private loop(kind:Sound,to:AudioNode){const s=this.ctx.createBufferSource(),g=this.ctx.createGain();g.gain.value=0;s.buffer=this.buffer(kind,0);s.loop=true;s.connect(g);g.connect(to);s.start();return g}
  update(room:RoomSample,events:readonly FoleyEvent[],now=this.ctx.currentTime){
    const gain=(node:GainNode,value:number)=>node.gain.setTargetAtTime(value,now,.025)
    gain(this.master,room.active?room.volume:0);gain(this.air,room.room*.7)
    const distance=Math.hypot(room.x,room.z,1.15)
    const attenuation=room.room/(1+distance*distance*.18)
    if(room.ballast){
      // No separate easing or event clock: exactly the same frame's signal as the emissive and light.
      this.hum.gain.setValueAtTime(attenuation*room.ballast.level,now)
      this.crackle.gain.setValueAtTime(attenuation*room.ballast.crackle*(room.crackle??0),now)
    }else{gain(this.hum,attenuation*room.tube);gain(this.crackle,0)}
    this.humPan.pan.setTargetAtTime(Math.max(-.8,Math.min(.8,(-room.x*Math.cos(room.yaw)+room.z*Math.sin(room.yaw))/distance)),now,.08)
    if(!room.active)return
    for(const event of events){
      const s=this.ctx.createBufferSource(),g=this.ctx.createGain(),p=this.ctx.createStereoPanner()
      s.buffer=this.buffer(event.kind,event.seed);g.gain.value=event.gain*(event.kind==="creak"?room.room:room.foley)
      p.pan.value=Math.max(-1,Math.min(1,event.pan));s.connect(g);g.connect(p);p.connect(this.master)
      s.onended=()=>{s.disconnect();g.disconnect();p.disconnect()}
      s.start(Math.max(this.ctx.currentTime,now+event.time-room.time))
    }
  }
}
