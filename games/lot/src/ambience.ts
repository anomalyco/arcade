/** Original seeded sounds, rendered identically into Web Audio buffers and offline evidence. */
export type AmbientSound="wind"|"traffic"|"buzz"|"hvac"|"drip"|"owl"|"dog"
export function ambiencePcm(kind:AmbientSound,seed=1,rate=24000):Float32Array<ArrayBuffer>{
  const loop=["wind","traffic","buzz","hvac"].includes(kind),duration=loop?8:kind==="drip"?.45:2
  const pcm=new Float32Array(Math.round(duration*rate)),cross=Math.round(rate*.25)
  let rng=seed*7919+37,low=0,mid=0,phase=0
  for(let i=0;i<pcm.length;i++){
    rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5
    const n=(rng>>>0)/4294967296*2-1,t=i/rate
    low+=(n-low)*.012;mid+=(n-mid)*.15
    if(kind==="wind")pcm[i]=(.2*low+.025*(mid-low))*(.65+.25*Math.sin(t*Math.PI/2)+.1*Math.sin(t*Math.PI*1.25))
    if(kind==="traffic")pcm[i]=low*.15*(.6+.4*Math.sin(t*Math.PI/8)**2)+.003*Math.sin(t*2*Math.PI*72)
    if(kind==="hvac")pcm[i]=low*.12+.007*Math.sin(t*2*Math.PI*48)+.002*Math.sin(t*2*Math.PI*96)
    if(kind==="buzz")pcm[i]=.018*Math.sin(t*2*Math.PI*120)+.005*Math.sin(t*2*Math.PI*240)+.002*mid
    const end=Math.min(1,(duration-t)*30),attack=1-Math.exp(-t*130)
    if(kind==="drip")pcm[i]=(.07*Math.sin(2*Math.PI*(1600*t-800*t*t))+.1*mid)*attack*Math.exp(-t*24)*end
    if(kind==="owl"){
      const pulse=Math.max(0,Math.sin(t*Math.PI*2.5))**3*Math.sin(Math.PI*t/duration)**2
      phase+=2*Math.PI*(420+25*Math.sin(t*8))/rate;pcm[i]=.07*Math.sin(phase)*pulse
    }
    if(kind==="dog"){
      const pulse=Math.max(0,Math.sin(t*Math.PI*3))**5*Math.exp(-t*1.5)
      pcm[i]=(.06*Math.sin(t*2*Math.PI*170)+.09*mid)*pulse*attack*end
    }
  }
  if(loop){for(let i=0;i<cross;i++){const k=i/cross;pcm[pcm.length-cross+i]=pcm[pcm.length-cross+i]!*(1-k)+pcm[i]!*k}return pcm.slice(cross)}
  return pcm
}
