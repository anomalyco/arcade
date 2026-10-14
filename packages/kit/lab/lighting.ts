import type { LabContext, LabSection } from "./types"

export const lightingDefaults = () => ({
  lamps:true,lampPower:2,lampRadius:10,lampHeight:3,
  spot:true,spotPower:4,spotAngle:38,spotYaw:-120,spotPitch:40,
  shadows:true,shadowSoftness:0.45,edgeAA:true,moon:true,moonPower:0.35,moonAzimuth:-45,moonElevation:55,
  count:2,exposure:0,tone:0,temperature:0,saturation:1,
})
export function createLighting({stage}:LabContext):LabSection {
  return {id:"lighting",label:"Lighting",settings:stage.lighting,controls:[
    {key:"count",label:"Light count",group:"Scene",type:"range",min:0,max:8,step:1},
    {key:"edgeAA",label:"Edge AA",group:"Scene"},
    {key:"lamps",label:"Lamps",group:"Lamp"},
    {key:"lampPower",label:"Power",group:"Lamp",type:"range",min:0,max:8,step:0.1},
    {key:"lampRadius",label:"Radius",group:"Lamp",type:"range",min:2,max:20,step:0.5},
    {key:"lampHeight",label:"Height",group:"Lamp",type:"range",min:0.5,max:6,step:0.1},
    {key:"spot",label:"Spotlight",group:"Spot"},
    {key:"spotPower",label:"Spot power",group:"Spot",type:"range",min:0,max:12,step:0.1},
    {key:"spotAngle",label:"Cone angle",group:"Spot",type:"range",min:8,max:80},
    {key:"spotYaw",label:"Yaw",group:"Spot",type:"range",min:-180,max:180},
    {key:"spotPitch",label:"Pitch",group:"Spot",type:"range",min:5,max:85},
    {key:"shadows",label:"Polar shadows",group:"Shadows"},
    {key:"shadowSoftness",label:"Softness",group:"Shadows",type:"range",min:0.05,max:1.2,step:0.05,enabled:s=>Boolean(s.shadows)},
    {key:"moon",label:"Moon",group:"Moon"},
    {key:"moonPower",label:"Moon power",group:"Moon",type:"range",min:0,max:2,step:0.05},
    {key:"moonAzimuth",label:"Azimuth",group:"Moon",type:"range",min:-180,max:180},
    {key:"moonElevation",label:"Elevation",group:"Moon",type:"range",min:10,max:85},
    {key:"tone",label:"Tone",type:"select",group:"Grade",options:[{value:0,label:"Reinhard"},{value:1,label:"ACES fit"},{value:2,label:"Linear"}]},
    {key:"exposure",label:"Exposure",group:"Grade",type:"range",min:-3,max:3,step:0.1},
    {key:"temperature",label:"Temperature",group:"Grade",type:"range",min:-1,max:1,step:0.05},
    {key:"saturation",label:"Saturation",group:"Grade",type:"range",min:0,max:1.5,step:0.05},
  ],telemetry:()=>`${stage.lightCount} lights · ${stage.lighting.shadows?256:0} polar rays/light`}
}
