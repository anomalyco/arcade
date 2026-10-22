import { WET_ASPHALT, WET_NOISE_SIGMA, type WetSettings, type WetMaterial } from "./wet"
const smooth=(a:number,b:number,x:number)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t)}
function hash(x:number,z:number,seed:number){
  let h=Math.imul(x,0x8da6b343)^Math.imul(z,0xd8163841)^Math.imul(seed,0xcb1ab31f)
  h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b)
  return ((h^(h>>>16))>>>0)/4294967296
}
function value(x:number,z:number,seed:number){
  const ix=Math.floor(x),iz=Math.floor(z),u=smooth(0,1,x-ix),v=smooth(0,1,z-iz)
  const a=hash(ix,iz,seed),b=hash(ix+1,iz,seed),c=hash(ix,iz+1,seed),d=hash(ix+1,iz+1,seed)
  return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v
}
function noise(x:number,z:number,seed:number){
  const raw=value(x,z,seed)*.5714+value(x*2.03+17.1,z*2.03+5.3,seed+1)*.2857+value(x*4.07+3.7,z*4.07+29.9,seed+2)*.1429
  const t=(raw-.5)/(WET_NOISE_SIGMA*1.41421356)
  return .5+.5*Math.tanh(Math.max(-15,Math.min(15,1.1283791671*t*(1+.0886226925*t*t))))
}
/** CPU mirror of wetSurface's standing-water mask, with the same scanned cavity AO and world scale. */
export function puddleAt(x:number,z:number,ao:number,s:WetSettings,m:WetMaterial=WET_ASPHALT){
  const qx=x/Math.max(s.puddleScale,.01),qz=z/Math.max(s.puddleScale,.01)
  const h=noise(qx/41,qz/41,41)*.62+noise(qx/13,qz/13,13)*.38+(1-ao)*.35,line=1.12-s.puddles*m.puddles*.82
  return smooth(line,line+.035,h)*smooth(.15,.6,s.wetness)
}
