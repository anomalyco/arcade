import { encodeWavPcm16 } from "@arcade/kit/audio/offline"
import { descentLines, type DescentLineId } from "../../shared/descent-lines"
import { Foley, synth, type FoleyFrame } from "../foley"
import { BASEMENT_X } from "./state"

export type DescentAudioFrame={time:number;line:DescentLineId|null;lineTime:number;x:number;z:number;yaw:number;downstairs:boolean;speed:number;volume:number;voice:number;machinery:number;active:boolean}
/** All levels and emitter positions are shared by the live path and the silent offline proof. */
class DescentMixer {
  private master:GainNode
  private voice:GainNode
  private pan:StereoPannerNode
  private air:GainNode
  private motor:GainNode
  private rotor:OscillatorNode
  private sources:AudioScheduledSourceNode[]=[]
  private speech?:AudioBufferSourceNode
  private id:DescentLineId|null=null
  private start=0
  constructor(private ctx:BaseAudioContext,to:AudioNode){
    this.master=ctx.createGain();this.master.gain.value=0;this.master.connect(to)
    this.pan=ctx.createStereoPanner();this.voice=ctx.createGain();this.voice.gain.value=0;this.voice.connect(this.pan);this.pan.connect(this.master)
    this.air=ctx.createGain();this.air.gain.value=0;this.air.connect(this.master)
    const source=ctx.createBufferSource(),pcm=synth("hvac",87),b=ctx.createBuffer(1,pcm.length,24000);b.copyToChannel(pcm,0);source.buffer=b;source.loop=true;source.connect(this.air);source.start();this.sources.push(source)
    this.motor=ctx.createGain();this.motor.gain.value=0;this.motor.connect(this.master)
    this.rotor=ctx.createOscillator();this.rotor.frequency.value=48;this.rotor.connect(this.motor);this.rotor.start();this.sources.push(this.rotor)
  }
  update(f:DescentAudioFrame,buffers:Map<DescentLineId,AudioBuffer>,now=this.ctx.currentTime,offline=false){
    const gain=(g:GainNode,n:number)=>g.gain.setTargetAtTime(n,now,.035)
    gain(this.master,f.active?f.volume:0)
    gain(this.air,f.downstairs?f.machinery*(.11+.018*Math.sin(f.time*.61)):0)
    gain(this.motor,f.machinery*f.speed*.0025)
    this.rotor.frequency.setTargetAtTime(38+f.speed*22,now,.09)
    const floor=f.line?.startsWith("floor-")??false
    const sx=floor ? .12 : f.downstairs?BASEMENT_X:0,sz=floor?-5.4:f.z>8?10:Math.max(-15.4,f.z-3.5)
    const dx=sx-f.x,dz=sz-f.z,d=Math.hypot(dx,dz)
    const attenuation=floor ? .6/(1+d*.26) : 1/(1+Math.max(0,d-3)*.08)
    gain(this.voice,f.voice*attenuation)
    this.pan.pan.setTargetAtTime(Math.max(-.7,Math.min(.7,(dx*Math.cos(f.yaw)-dz*Math.sin(f.yaw))/Math.max(d,1))),now,.05)
    const buffer=f.line?buffers.get(f.line):undefined,playing=f.active&&buffer&&f.lineTime<buffer.duration
    if(this.speech&&(!playing||this.id!==f.line||!offline&&Math.abs(now-this.start-f.lineTime)>.15)){
      this.speech.stop(now);if(!offline)this.speech.disconnect();this.speech=undefined
    }
    if(playing&&!this.speech){
      const s=this.speech=this.ctx.createBufferSource();s.buffer=buffer;s.connect(this.voice);this.id=f.line;this.start=now-f.lineTime
      s.onended=()=>{s.disconnect();if(this.speech===s)this.speech=undefined}
      s.start(now,Math.min(f.lineTime,buffer.duration));
    }
  }
  dispose(){for(const s of this.sources){s.stop();s.disconnect()}this.speech?.stop();this.speech?.disconnect();this.master.disconnect()}
}
export class DescentAudio {
  private buffers=new Map<DescentLineId,AudioBuffer>()
  private mixer?:DescentMixer
  readonly errors: string[]=[]
  async unlock(ctx:AudioContext){
    if(this.mixer)return
    this.mixer=new DescentMixer(ctx,ctx.destination)
    await Promise.allSettled(descentLines.map(async({id})=>{
      try{
        const r=await fetch(`${import.meta.env.BASE_URL}audio/descent/${id}.mp3`)
        if(!r.ok)throw Error(`${id}: HTTP ${r.status}`)
        this.buffers.set(id,await ctx.decodeAudioData(await r.arrayBuffer()))
      }catch(e){this.errors.push(`${id}: ${String(e)}`)}
    }))
  }
  get loaded(){return this.buffers.size}
  update(frame:DescentAudioFrame){this.mixer?.update(frame,this.buffers)}
  dispose(){this.mixer?.dispose()}
}
export async function renderDescentAudio(tape:DescentAudioFrame[],feet:FoleyFrame[],duration:number){
  const ctx=new OfflineAudioContext(2,Math.ceil(duration*48000),48000),mixer=new DescentMixer(ctx,ctx.destination),foley=new Foley(ctx,ctx.destination)
  const buffers=new Map<DescentLineId,AudioBuffer>()
  await Promise.all([...new Set(tape.flatMap(f=>f.line?[f.line]:[]))].map(async id=>{const r=await fetch(`${import.meta.env.BASE_URL}audio/descent/${id}.mp3`);if(!r.ok)throw Error(`Missing stem ${id}`);buffers.set(id,await ctx.decodeAudioData(await r.arrayBuffer()))}))
  for(const f of tape)mixer.update(f,buffers,f.time,true)
  for(const f of feet)foley.update(f.room,f.events,f.room.time)
  return encodeWavPcm16(await ctx.startRendering())
}
