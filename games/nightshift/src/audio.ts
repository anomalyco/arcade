import { ringEnvelope, type Call } from "../shared/call"

/** Original procedural sound. Created only by a canvas click; tests launch muted. */
export class OfficeAudio {
  private ctx?: AudioContext
  private master?: GainNode
  private bell?: GainNode
  private pan?: StereoPannerNode
  private voice?: GainNode
  private voicePitch?: OscillatorNode
  private hum?: GainNode
  muted=false
  async unlock() {
    if(this.ctx) { await this.ctx.resume();return }
    const c=this.ctx=new AudioContext(),master=this.master=c.createGain();master.gain.value=0;master.connect(c.destination)
    const bell=this.bell=c.createGain(),pan=this.pan=c.createStereoPanner();bell.gain.value=0;bell.connect(pan);pan.connect(master)
    for(const [hz,gain] of [[838,0.18],[1174,0.1],[2514,0.022]]) {const o=c.createOscillator(),g=c.createGain();o.frequency.value=hz;g.gain.value=gain;o.connect(g);g.connect(bell);o.start()}
    const hum=this.hum=c.createGain();hum.gain.value=0;hum.connect(master)
    const ballast=c.createOscillator();ballast.type="triangle";ballast.frequency.value=120;ballast.connect(hum);ballast.start()
    const voice=this.voice=c.createGain(),filter=c.createBiquadFilter();filter.type="bandpass";filter.frequency.value=680;filter.Q.value=0.7;voice.gain.value=0;voice.connect(filter);filter.connect(master)
    const o=this.voicePitch=c.createOscillator();o.type="sawtooth";o.frequency.value=115;o.connect(voice);o.start()
    await c.resume()
  }
  update(time:number,distance:number,pan:number,call:Call,volume:number,active:boolean,tube:number) {
    if(!this.ctx || !this.master) return
    const now=this.ctx.currentTime, gain=(node:GainNode|undefined,v:number)=>node?.gain.setTargetAtTime(v,now,0.015)
    gain(this.master,active&&!this.muted?volume*0.32:0)
    gain(this.bell,call.phase==="ringing"?ringEnvelope(time)/(1+distance*distance*0.22)*(0.65+0.35*Math.sin(time*2*Math.PI*23)**2):0)
    this.pan!.pan.setTargetAtTime(Math.max(-0.9,Math.min(0.9,pan)),now,0.05)
    const t=call.elapsed, talking=call.phase==="call" && t>1 && t<8
    // Deliberately indistinct syllables, never a claim to spoken/recorded dialogue.
    gain(this.voice,talking?0.045*Math.max(0,Math.sin(t*12))*Math.max(0.1,Math.sin(t*2.8)):0)
    this.voicePitch!.frequency.setTargetAtTime(112+Math.sin(t*4)*15+Math.sin(t*7)*9,now,0.03)
    gain(this.hum,0.008*tube)
  }
  dispose() { void this.ctx?.close() }
}
