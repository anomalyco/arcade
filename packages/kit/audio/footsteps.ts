/** Original deterministic PCM synthesis. Surface is supplied by the game's collision/ground query. */
export type FootSurface = "carpet"|"asphalt"|"wet-asphalt"|"puddle"|"gravel"|"dirt"|"grass"|"concrete"|"wood"|"tile"
export type FootEvent = { kind:"step"|"cloth"|"scuff"|"bump"|"creak"; time:number; gain:number; pan:number; seed:number }
export const foleyDurations = {step:.26,cloth:.32,scuff:.38,bump:.55,creak:1.8} as const
const surfaces: Record<FootSurface, { low:number; grain:number; tone:number; hz:number; decay:number }> = {
  carpet:{low:.4,grain:.025,tone:.009,hz:62,decay:19},
  asphalt:{low:.62,grain:.38,tone:.08,hz:88,decay:24},
  "wet-asphalt":{low:.58,grain:.32,tone:.06,hz:82,decay:22},
  puddle:{low:.42,grain:.48,tone:.025,hz:60,decay:12},
  gravel:{low:.34,grain:.65,tone:.04,hz:96,decay:14},
  dirt:{low:.68,grain:.3,tone:.05,hz:74,decay:21},
  grass:{low:.45,grain:.42,tone:.025,hz:62,decay:14},
  concrete:{low:.52,grain:.24,tone:.15,hz:115,decay:29},
  wood:{low:.44,grain:.16,tone:.2,hz:132,decay:20},
  tile:{low:.3,grain:.3,tone:.18,hz:190,decay:33},
}
export function synthFoley(sound:FootEvent["kind"],seed:number,rate=24000,surface:FootSurface="carpet"):Float32Array<ArrayBuffer>{
  const duration=foleyDurations[sound],a=new Float32Array(Math.ceil(duration*rate)),p=surfaces[surface]
  let rng=(seed+1)*7919,low=0,mid=0,phase=0,crunch=0
  const random=()=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return (rng>>>0)/4294967296*2-1}
  const shade=sound==="step"?(random()+1)/2:0,weight=sound==="step"?.75+.25*(random()+1)/2:1
  for(let i=0;i<a.length;i++){
    const t=i/rate,u=t/duration,n=random(),attack=1-Math.exp(-t*180),end=Math.min(1,(duration-t)*35)
    low+=(n-low)*.045;mid+=(n-mid)*.28
    if(sound==="step"){
      const press=Math.sin(Math.min(1,t/(.022+.014*shade))*Math.PI/2)**2
      if(surface==="carpet"){
        // Exact quiet Night Shift bank; all games share its contact reference level.
        a[i]=((low*(.35+.1*shade)+mid*.025)*Math.exp(-t*(15+8*shade))+.009*Math.sin(2*Math.PI*(62+seed%23)*t)*Math.exp(-t*28))*press*end*weight
      }else{
      a[i]=((low*p.low+mid*p.grain)*Math.exp(-t*(p.decay+shade*4))+p.tone*.1*Math.sin(2*Math.PI*(p.hz+seed%17)*t)*Math.exp(-t*30))*press*end*weight
      if(surface==="gravel"||surface==="dirt"){
        crunch=crunch*.94+(n>.98?n*.25:0)
        a[i]+=crunch*n*Math.sin(Math.PI*u)* (surface==="gravel"?1:.4)
      }
      if(surface==="puddle")a[i]+=(mid-low)*.45*Math.sin(Math.PI*u)**2+.055*Math.sin(2*Math.PI*(520*t-350*t*t))*attack*Math.exp(-t*15)*end
      if(surface==="wet-asphalt")a[i]+=(mid-low)*.16*Math.sin(Math.PI*u)**2
      if(surface==="grass")a[i]+=(mid-low)*.24*Math.sin(Math.PI*u)**2
      // Crunch and splashes have a longer noisy tail; level-match those to the quiet contact bank.
      a[i]*=.32*(surface==="puddle"?.4:surface==="gravel"?.5:surface==="grass"?.7:1)
      }
    }
    if(sound==="cloth"||sound==="scuff")a[i]=(mid-low)*Math.sin(Math.PI*u)**2*(sound==="cloth"?.055:.19)
    if(sound==="bump")a[i]=(.17*Math.sin(t*2*Math.PI*83)+.085*Math.sin(t*2*Math.PI*151)+mid*.08)*attack*Math.exp(-t*12)*end
    if(sound==="creak"){
      phase+=2*Math.PI*(270+40*Math.sin(t*6)+17*Math.sin(t*39))/rate
      a[i]=(.035*Math.sin(phase)+.016*Math.sin(phase*2.01)+mid*.035)*Math.sin(Math.PI*u)**2*(.7+.3*Math.sin(t*48))
    }
  }
  return a
}

/** One scheduler for live and offline footsteps. The gait clock supplies sample-accurate contact times. */
export class Footsteps {
  private cache=new Map<string,AudioBuffer>()
  private voices=new Set<AudioBufferSourceNode>()
  constructor(private ctx:BaseAudioContext,private destination:AudioNode){}
  play(events:readonly FootEvent[],surface:FootSurface,time:number,gain:number,now=this.ctx.currentTime){
    for(const e of events){
      const variants=e.kind==="step"?32:8,seed=e.seed%variants
      const key=`${e.kind}:${surface}:${seed}`
      let b=this.cache.get(key)
      if(!b){const pcm=synthFoley(e.kind,seed,24000,surface);b=this.ctx.createBuffer(1,pcm.length,24000);b.copyToChannel(pcm,0);this.cache.set(key,b)}
      const source=this.ctx.createBufferSource(),level=this.ctx.createGain(),pan=this.ctx.createStereoPanner()
      source.buffer=b;level.gain.value=e.gain*gain;pan.pan.value=Math.max(-1,Math.min(1,e.pan))
      source.connect(level);level.connect(pan);pan.connect(this.destination)
      this.voices.add(source)
      source.onended=()=>{this.voices.delete(source);source.disconnect();level.disconnect();pan.disconnect()}
      source.start(Math.max(this.ctx.currentTime,now+e.time-time))
    }
  }
  stop(){for(const source of this.voices)source.stop();this.voices.clear()}
}
