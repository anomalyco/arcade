import { ringEnvelope, type Call } from "../shared/call"
import { Foley, type RoomSample } from "./foley"
import { OPENING } from "./opening"
import type { FoleyEvent } from "./walk"
import { encodeWavPcm16 } from "@arcade/kit/audio/offline"

/** Synthesized room/bells and Kit's authorized recorded fictional performance. */
export class OfficeAudio {
  private ctx?: AudioContext
  private master?: GainNode
  private bell?: GainNode
  private pan?: StereoPannerNode
  private recording?: AudioBuffer
  private speech?: AudioBufferSourceNode
  private speechGain?: GainNode
  private speechPan?: StereoPannerNode
  private speechStart=0
  private foley?: Foley
  private tone?: OscillatorNode
  private toneGain?: GainNode
  error=false
  get ready(){return !!this.recording}
  get context(){return this.ctx}
  muted=false
  async unlock() {
    if(this.ctx) { await this.ctx.resume();return }
    const c=this.ctx=new AudioContext(),master=this.master=c.createGain();master.gain.value=0;master.connect(c.destination)
    const bell=this.bell=c.createGain(),pan=this.pan=c.createStereoPanner();bell.gain.value=0;bell.connect(pan);pan.connect(master)
    const speechGain=this.speechGain=c.createGain(),speechPan=this.speechPan=c.createStereoPanner();speechGain.connect(speechPan);speechPan.connect(master)
    for(const [hz,gain] of [[838,0.18],[1174,0.1],[2514,0.022]]) {const o=c.createOscillator(),g=c.createGain();o.frequency.value=hz;g.gain.value=gain;o.connect(g);g.connect(bell);o.start()}
    this.foley=new Foley(c,c.destination)
    const tone=this.tone=c.createOscillator(),toneGain=this.toneGain=c.createGain();toneGain.gain.value=0;tone.connect(toneGain);toneGain.connect(master);tone.start()
    void fetch(`${import.meta.env.BASE_URL}audio/kit-call.mp3`).then(r=>{if(!r.ok)throw new Error(`Call audio: ${r.status}`);return r.arrayBuffer()}).then(b=>c.decodeAudioData(b)).then(b=>{this.recording=b}).catch(e=>{this.error=true;console.error(e)})
    await c.resume()
  }
  update(time:number,distance:number,pan:number,call:Call,volume:number,active:boolean,openingTime:number,parked=0) {
    if(!this.ctx || !this.master) return
    const now=this.ctx.currentTime, gain=(node:GainNode|undefined,v:number)=>node?.gain.setTargetAtTime(v,now,0.015)
    gain(this.master,active&&!this.muted?volume*0.32:0)
    gain(this.bell,bellLevel(time,openingTime,distance,call.phase))
    const tone=introTone(openingTime);gain(this.toneGain,tone.gain);this.tone?.frequency.setTargetAtTime(tone.hz,now,.015)
    this.pan!.pan.setTargetAtTime(Math.max(-0.9,Math.min(0.9,pan)),now,0.05)
    gain(this.speechGain,1-parked+parked*.6/(1+distance*.26))
    this.speechPan!.pan.setTargetAtTime(parked*Math.max(-.7,Math.min(.7,pan)),now,.05)
    const playing=active&&call.phase==="call"&&this.recording&&call.elapsed<this.recording.duration
    // Re-seek after focus loss or a stalled frame so subtitles remain the clock.
    if(this.speech&&(!playing||Math.abs(now-this.speechStart-call.elapsed)>0.15)) {this.speech.stop();this.speech.disconnect();this.speech=undefined}
    if(playing&&!this.speech) {
      const s=this.speech=this.ctx.createBufferSource();s.buffer=this.recording!;s.connect(this.speechGain!)
      s.onended=()=>{s.disconnect();if(this.speech===s)this.speech=undefined}
      this.speechStart=now-call.elapsed;s.start(now,call.elapsed)
    }
  }
  movement(room:RoomSample,events:readonly FoleyEvent[]){this.foley?.update({...room,active:room.active&&!this.muted},events)}
  dispose() { void this.ctx?.close() }
}
export function introTone(time:number){const span=OPENING.empty-OPENING.drain,t=Math.max(0,Math.min(1,(time-OPENING.drain)/span));return {hz:660*Math.pow(110/660,t),gain:time>=OPENING.drain&&time<OPENING.empty?.022*Math.sin(Math.PI*t)**.6:0}}
function bellLevel(time:number,openingTime:number,distance:number,phase:Call["phase"]){return openingTime>=OPENING.ring&&phase==="ringing"?ringEnvelope(time)/(1+distance*distance*.22)*(.65+.35*Math.sin(time*2*Math.PI*23)**2):0}
export type BeatAudioFrame={time:number;openingTime:number;ringTime:number;distance:number;pan:number;call:Call;room:RoomSample;events:FoleyEvent[]}
/** Review-file audio uses the same PCM, levels and clocks, with no speaker output. */
export async function renderBeatAudio(tape:BeatAudioFrame[],duration:number,recording:ArrayBuffer){
  const c=new OfflineAudioContext(2,Math.ceil(duration*48000),48000),foley=new Foley(c,c.destination)
  const master=c.createGain();master.gain.value=0;master.connect(c.destination)
  const bell=c.createGain(),pan=c.createStereoPanner(),tone=c.createOscillator(),toneGain=c.createGain()
  bell.gain.value=toneGain.gain.value=0;bell.connect(pan);pan.connect(master);tone.connect(toneGain);toneGain.connect(master);tone.start()
  for(const [hz,gain] of [[838,.18],[1174,.1],[2514,.022]]){const o=c.createOscillator(),g=c.createGain();o.frequency.value=hz;g.gain.value=gain;o.connect(g);g.connect(bell);o.start()}
  for(const f of tape){
    const now=f.time,t=introTone(f.openingTime)
    foley.update(f.room,f.events,now)
    master.gain.setTargetAtTime(f.room.volume*.32,now,.015)
    bell.gain.setTargetAtTime(bellLevel(f.ringTime,f.openingTime,f.distance,f.call.phase),now,.015)
    pan.pan.setTargetAtTime(Math.max(-.9,Math.min(.9,f.pan)),now,.05)
    tone.frequency.setTargetAtTime(t.hz,now,.015);toneGain.gain.setTargetAtTime(t.gain,now,.015)
  }
  const start=tape.find(f=>f.call.phase==="call")
  if(start){const s=c.createBufferSource();s.buffer=await c.decodeAudioData(recording);s.connect(master);s.start(Math.max(0,start.time-start.call.elapsed))}
  return encodeWavPcm16(await c.startRendering())
}
