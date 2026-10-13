import type { LabControl, LabSettings } from "../lab-panel"
import type { LabContext, LabSection } from "./types"

export type EffectGroup = { label:string; settings:Record<string,number>; ranges?:Record<string,readonly [number,number,number?]> }
export type EffectAdapter = {
  effects:readonly {value:string;label:string}[]
  environments:readonly {value:string;label:string}[]
  groups:Record<string,EffectGroup>
  controls?:readonly LabControl[]
  settings?:LabSettings
  environment(kind:string,seed:number):void
  trigger(effect:string,seed:number):void
  update(dt:number):void
  prepare():void
  draw?(pass:GPURenderPassEncoder):void
  clear():void
  leave?():void
  inspect():unknown
}

/** Game-owned emitters and defaults; the shared shell only handles playback and panel bindings. */
export function gameEffects(context:LabContext,id:string,label:string,create:()=>EffectAdapter):LabSection {
  let adapter:EffectAdapter|undefined,elapsed=0
  const settings:LabSettings={effect:"",environment:"",seed:7,effectSeed:19,loop:false,interval:2,playing:true,lockEffect:true,lockEnvironment:false}
  const controls:LabControl[]=[]
  const rng=(seed:number)=>()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296}
  const trigger=()=>{adapter!.trigger(String(settings.effect),Number(settings.effectSeed));elapsed=0}
  const rebuild=()=>{adapter!.environment(String(settings.environment),Number(settings.seed));context.sync()}
  const shuffle=()=>{
    if(!settings.lockEnvironment){settings.seed=((Number(settings.seed)*1664525+1013904223)>>>0)%99999+1;rebuild()}
    if(!settings.lockEffect)settings.effectSeed=((Number(settings.effectSeed)*1664525+1013904223)>>>0)%99999+1
    if(!settings.lockEnvironment||!settings.lockEffect)trigger()
    context.sync()
  }
  function init(){
    if(adapter)return
    adapter=create()
    for(const key of Object.keys(adapter.settings??{}))Object.defineProperty(settings,key,{enumerable:true,get:()=>adapter!.settings![key],set:v=>{adapter!.settings![key]=v}})
    settings.effect=adapter.effects[0].value;settings.environment=adapter.environments[0].value
    controls.push(
      {key:"effect",label:"Effect",type:"select",options:adapter.effects},
      ...(adapter.controls??[]),
      {key:"trigger",label:"Trigger effect",type:"action",run:trigger},
      {key:"loop",label:"Loop"},{key:"playing",label:"Play"},
      {key:"interval",label:"Interval",type:"range",min:.1,max:10,step:.1},
      {key:"clear",label:"Clear effects",type:"action",run:()=>adapter!.clear()},
      {key:"environment",label:"Environment",group:"Environment",type:"select",options:adapter.environments,change:rebuild},
      {key:"seed",label:"Room seed",group:"Environment",type:"range",min:1,max:99999,step:1,change:rebuild},
      {key:"effectSeed",label:"Effect seed",group:"Environment",type:"range",min:1,max:99999,step:1},
      {key:"lockEffect",label:"Lock effect",group:"Environment"},
      {key:"lockEnvironment",label:"Lock environment",group:"Environment"},
      {key:"shuffle",label:"Randomize environment",group:"Environment",type:"action",run:shuffle},
      {key:"copy",label:"Copy JSON",type:"action",run:async()=>{await navigator.clipboard.writeText(JSON.stringify({game:id,environment:settings.environment,seed:settings.seed,effect:settings.effect,effectSeed:settings.effectSeed,settings:Object.fromEntries(Object.entries(adapter!.groups).map(([key,g])=>[key,g.settings]))},null,2))}},
    )
    for(const [group,g] of Object.entries(adapter.groups)){
      const groupControls:LabControl[]=[]
      for(const [key,value] of Object.entries(g.settings)){
        const integer=/count|capacity|sparks$/i.test(key),positive=/life|fade|radius|size|width|spacing|time|duration|interval|retrigger/i.test(key)&&!key.endsWith("Spread")
        const name=`${group}.${key}`,range=g.ranges?.[key]??(value<0?[value*3,-.01,.01]:[integer?1:positive?.01:0,Math.max(1,value*3),integer?1:.01])
        Object.defineProperty(settings,name,{enumerable:true,get:()=>g.settings[key],set:(v:number)=>{g.settings[key]=v}})
        groupControls.push({key:name,label:key.replace(/([A-Z])/g," $1").replace(/^./,c=>c.toUpperCase()),group:g.label,type:"range",min:range[0],max:range[1],step:range[2]??.01})
      }
      controls.push(...groupControls,{key:`${group}.randomize`,label:`Randomize ${g.label}`,group:g.label,type:"action",run:()=>{
        // Explicit group edits are intentional; the lock preserves effects during room comparisons.
        const random=rng(Number(settings.effectSeed));settings.effectSeed=Number(settings.effectSeed)+1
        for(const c of groupControls)if(c.type==="range")settings[c.key]=Math.round((c.min+random()*(c.max-c.min))/(c.step??.01))*(c.step??.01)
        adapter!.clear();trigger();context.sync()
      }})
    }
  }
  // Factories allocate lazily, but controls must exist before main binds this section.
  init()
  return {id,label,settings,controls,enter:rebuild,leave:()=>adapter!.leave?.(),update(dt){if(!settings.playing)return;adapter!.update(dt);elapsed+=dt;if(settings.loop&&elapsed>=Number(settings.interval))trigger()},prepare:()=>adapter!.prepare(),draw:pass=>adapter!.draw?.(pass),telemetry:()=>`${label} · seed ${settings.seed}\n${JSON.stringify(adapter!.inspect())}`}
}

/** Scope a seeded emitter call without changing the host's random stream. Always restore, including on error. */
export function seeded<T>(seed:number,run:()=>T):T {
  const previous=Math.random
  Math.random=()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296}
  try{return run()}finally{Math.random=previous}
}
