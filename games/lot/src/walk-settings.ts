import type { LabControl } from "@arcade/kit/lab-panel"

export const walkDefaults=()=>({walkMode:"grounded" as "today"|"grounded",cameraMotion:1,reduceMotion:false,stepLength:.72,walkSettle:.3,volume:.55,footsteps:.8,wind:.6,traffic:.35,lamps:.4,drizzle:.35,hvac:.45,wildlife:.4})
/** `reduceMotion` follows the game shell's Reduce camera motion (Settings); mute and the player's volumes are the shell's too. */
export type WalkSettings=ReturnType<typeof walkDefaults>
export const walkControls:LabControl[]=[
  {key:"walkMode",label:"Walking",type:"select",group:"Walking",options:[{value:"today",label:"Today"},{value:"grounded",label:"Grounded"}]},
  {key:"cameraMotion",label:"Head motion",min:0,max:1,step:.05,unit:"×",group:"Walking"},
  {key:"stepLength",label:"Step length",min:.45,max:1.1,step:.01,unit:"m",group:"Walking"},
  {key:"walkSettle",label:"Start/stop spring",min:.1,max:.6,step:.01,unit:"s",group:"Walking"},
  ...([['volume','Mix level'],['footsteps','Footsteps'],['wind','Wind in pines'],['traffic','Distant traffic'],['lamps','Lamp buzz'],['drizzle','Drips'],['hvac','Facility ventilation'],['wildlife','Distant wildlife']] as const).map(([key,label])=>({key,label,group:"Sound",min:0,max:1,step:.05,unit:"×"})),
]
