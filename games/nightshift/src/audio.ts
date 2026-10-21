import { ringEnvelope, type Call } from "../shared/call"

/** Synthesized room/bells and Kit's authorized recorded fictional performance. */
export class OfficeAudio {
  private ctx?: AudioContext
  private master?: GainNode
  private bell?: GainNode
  private pan?: StereoPannerNode
  private recording?: AudioBuffer
  private speech?: AudioBufferSourceNode
  private speechStart=0
  private hum?: GainNode
  muted=false
  async unlock() {
    if(this.ctx) { await this.ctx.resume();return }
    const c=this.ctx=new AudioContext(),master=this.master=c.createGain();master.gain.value=0;master.connect(c.destination)
    const bell=this.bell=c.createGain(),pan=this.pan=c.createStereoPanner();bell.gain.value=0;bell.connect(pan);pan.connect(master)
    for(const [hz,gain] of [[838,0.18],[1174,0.1],[2514,0.022]]) {const o=c.createOscillator(),g=c.createGain();o.frequency.value=hz;g.gain.value=gain;o.connect(g);g.connect(bell);o.start()}
    const hum=this.hum=c.createGain();hum.gain.value=0;hum.connect(master)
    const ballast=c.createOscillator();ballast.type="triangle";ballast.frequency.value=120;ballast.connect(hum);ballast.start()
    void fetch(`${import.meta.env.BASE_URL}audio/jay-call.mp3`).then(r=>{if(!r.ok)throw new Error(`Call audio: ${r.status}`);return r.arrayBuffer()}).then(b=>c.decodeAudioData(b)).then(b=>{this.recording=b}).catch(e=>console.error(e))
    await c.resume()
  }
  update(time:number,distance:number,pan:number,call:Call,volume:number,active:boolean,tube:number) {
    if(!this.ctx || !this.master) return
    const now=this.ctx.currentTime, gain=(node:GainNode|undefined,v:number)=>node?.gain.setTargetAtTime(v,now,0.015)
    gain(this.master,active&&!this.muted?volume*0.32:0)
    gain(this.bell,call.phase==="ringing"?ringEnvelope(time)/(1+distance*distance*0.22)*(0.65+0.35*Math.sin(time*2*Math.PI*23)**2):0)
    this.pan!.pan.setTargetAtTime(Math.max(-0.9,Math.min(0.9,pan)),now,0.05)
    const playing=active&&call.phase==="call"&&this.recording&&call.elapsed<this.recording.duration
    // Re-seek after focus loss or a stalled frame so subtitles remain the clock.
    if(this.speech&&(!playing||Math.abs(now-this.speechStart-call.elapsed)>0.15)) {this.speech.stop();this.speech=undefined}
    if(playing&&!this.speech) {
      const s=this.speech=this.ctx.createBufferSource();s.buffer=this.recording!;s.connect(this.master)
      this.speechStart=now-call.elapsed;s.start(now,call.elapsed)
    }
    gain(this.hum,0.008*tube)
  }
  dispose() { void this.ctx?.close() }
}
