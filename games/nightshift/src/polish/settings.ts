import type { LabControl } from "@arcade/kit/lab-panel"

export const polishDefaults = () => ({
  polish: 1, beamDust: true, dustWake: .45, dustRadius: .004, dustBrightness: .7,
  tubeSound: true, tubeCrackle: .3, tubeEnds: .08,
  lens: true, lensSoftness: .35, lensFringe: .6, lensGrain: .004, lensVignette: .16,
  physicalProps: true, chairFriction: 2.8, chairPush: .8, paperFlutter: .035, cordSwing: .65,
  continuity: true, unseenDelay: 8, changeInterval: 75, afterCallInterval: 28, continuitySeed: 87,
})
export type PolishSettings = ReturnType<typeof polishDefaults>
export function polishControls(): LabControl[] {
  const toggle=(key:keyof PolishSettings,label:string,group:string):LabControl=>({key,label,group,type:"toggle"})
  const row=(key:keyof PolishSettings,label:string,group:string,min:number,max:number,step:number,unit:string):LabControl=>({key,label,group,min,max,step,unit})
  return [
    {key:"polish",label:"Office detail",group:"Polish",type:"select",options:[{value:0,label:"Today"},{value:1,label:"Polished"}]},
    toggle("beamDust","Shadowed beam dust","Dust"),row("dustWake","Walking wake","Dust",0,1,.05,"×"),row("dustRadius","Mote radius","Dust",.001,.012,.001,"m"),row("dustBrightness","Brightness","Dust",0,2,.05,"×"),
    toggle("tubeSound","Synchronized ballast","Tube"),row("tubeCrackle","Starter crackle","Tube",0,1,.05,"×"),row("tubeEnds","Tube-end glow","Tube",0,.3,.01,"×"),
    toggle("lens","Lens","Lens"),row("lensSoftness","Edge softness","Lens",0,1,.05,"px"),row("lensFringe","Bright-source fringe","Lens",0,2,.05,"px"),row("lensGrain","Film grain","Lens",0,.02,.001,"×"),row("lensVignette","Vignette","Lens",0,.4,.01,"×"),
    toggle("physicalProps","Physical props","Props"),row("chairFriction","Caster friction","Props",1,8,.1,"s⁻¹"),row("chairPush","Chair push","Props",.1,2,.05,"×"),row("paperFlutter","Paper lift","Props",0,.08,.005,"m"),row("cordSwing","Cord swing","Props",0,1,.05,"×"),
    toggle("continuity","Something moved","Continuity"),row("unseenDelay","Not seen for","Continuity",3,30,1,"s"),row("changeInterval","Before call interval","Continuity",30,180,5,"s"),row("afterCallInterval","After call interval","Continuity",10,90,1,"s"),row("continuitySeed","Seed (resets changes)","Continuity",1,999,1,""),
  ]
}
