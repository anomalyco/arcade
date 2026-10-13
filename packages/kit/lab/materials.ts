import type { LabContext, LabSection, MaterialAdapter } from "./types"

/** Catalog and renderer seam only: a code is not a portable shader across games. */
export function createMaterials(context:LabContext,adapters:readonly MaterialAdapter[]):LabSection {
  const entries=adapters.flatMap(adapter=>Object.entries(adapter.codes).map(([name,code])=>({adapter,name,code})))
  const settings={material:0}
  const current=()=>entries[settings.material]
  return {id:"materials",label:"Materials",settings,
    controls:entries.length?[{key:"material",label:"Material",type:"select",options:entries.map((e,value)=>({value,label:`${e.adapter.game} · ${e.code} ${e.name}`}))}]:[],
    prepare:()=>current()?.adapter.prepare?.(current()!.code,context),
    draw:pass=>{const e=current();e?.adapter.draw?.(pass,e.code)},
    telemetry:()=>current()?.adapter.draw?`${current()!.adapter.game} · ${current()!.name}`:"Materials · renderer pending",
  }
}
