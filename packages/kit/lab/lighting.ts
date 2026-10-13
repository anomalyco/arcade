import type { LabContext, LabSection } from "./types"

export const lightingDefaults = () => ({
  lamps:true,lampPower:2,lampRadius:10,lampHeight:3,
  spot:true,spotPower:4,spotAngle:38,spotYaw:-120,spotPitch:40,
  shadows:true,moon:true,moonPower:0.35,moonAzimuth:-45,moonElevation:55,
  count:2,exposure:0,tone:0,temperature:0,saturation:1,
})
export function createLighting({stage}:LabContext):LabSection {
  return {id:"lighting",label:"Lighting",settings:stage.lighting,controls:[
    {key:"count",label:"Light count",type:"range",min:0,max:8},
    {key:"lamps",label:"Lamps",group:"Lamp"},
    {key:"lampPower",label:"Power",type:"range",min:0,max:8,step:0.1},
    {key:"lampRadius",label:"Radius",type:"range",min:2,max:20,step:0.5},
    {key:"lampHeight",label:"Height",type:"range",min:0.5,max:6,step:0.1},
    {key:"spot",label:"Spotlight",group:"Spot"},
    {key:"spotPower",label:"Spot power",type:"range",min:0,max:12,step:0.1},
    {key:"spotAngle",label:"Cone angle",type:"range",min:8,max:80},
    {key:"spotYaw",label:"Yaw",type:"range",min:-180,max:180},
    {key:"spotPitch",label:"Pitch",type:"range",min:5,max:85},
    {key:"shadows",label:"Polar shadows",group:"Shadows"},
    {key:"moon",label:"Moon",group:"Moon"},
    {key:"moonPower",label:"Moon power",type:"range",min:0,max:2,step:0.05},
    {key:"moonAzimuth",label:"Azimuth",type:"range",min:-180,max:180},
    {key:"moonElevation",label:"Elevation",type:"range",min:10,max:85},
    {key:"tone",label:"Tone",type:"select",group:"Grade",options:[{value:0,label:"Reinhard"},{value:1,label:"ACES fit"},{value:2,label:"Linear"}]},
    {key:"exposure",label:"Exposure",type:"range",min:-3,max:3,step:0.1},
    {key:"temperature",label:"Temperature",type:"range",min:-1,max:1,step:0.05},
    {key:"saturation",label:"Saturation",type:"range",min:0,max:1.5,step:0.05},
  ],telemetry:()=>`${stage.lightCount} lights · ${stage.lighting.shadows?256:0} polar rays/light`}
}
