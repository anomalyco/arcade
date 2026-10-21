import type { LabControl } from "@arcade/kit/lab-panel"

export type InteriorSettings = { mode: "today" | "interior"; fixtures: number; bounce: number; air: number }
export const interiorDefaults = (): InteriorSettings => ({ mode: "interior", fixtures: 0.55, bounce: 0.3, air: 0.12 })
export const interiorControls: LabControl[] = [
  {key:"interior.mode",field:"mode",label:"Interior lighting",type:"select",group:"Interior",options:[{value:"today",label:"Today"},{value:"interior",label:"Room bounce"}]},
  {key:"interior.fixtures",field:"fixtures",label:"Fixtures",min:0,max:3,step:0.05,unit:"×",group:"Interior"},
  {key:"interior.bounce",field:"bounce",label:"Fixture bounce",min:0,max:1,step:0.01,unit:"×",group:"Interior"},
  {key:"interior.air",field:"air",label:"Indoor fog",min:0,max:1,step:0.01,unit:"×",group:"Interior"},
]
