import type { LabControl } from "@arcade/kit/lab-panel"
export const descentControls:LabControl[]=[
  {key:"rideSeconds",label:"Ride",min:8,max:26,step:.5,unit:"s",group:"Descent"},
  {key:"doorSeconds",label:"Doors",min:1,max:3,step:.1,unit:"s",group:"Descent"},
  {key:"sway",label:"Car sway",min:0,max:.01,step:.001,unit:"rad",group:"Descent"},
  {key:"heat",label:"Heat shimmer",min:0,max:1,step:.05,unit:"×",group:"Descent"},
  {key:"voice",label:"Speaker voice",min:0,max:.6,step:.02,unit:"×",group:"Descent"},
  {key:"machinery",label:"Fans and motor",min:0,max:.7,step:.02,unit:"×",group:"Descent"},
  {key:"lingerSeconds",label:"Screen linger",min:.5,max:3,step:.1,unit:"s",group:"Descent"},
]
