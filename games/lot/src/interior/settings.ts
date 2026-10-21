import type { LabControl } from "@arcade/kit/lab-panel"

export type InteriorSettings = { mode: "today" | "interior"; emitters: "point" | "area"; fixtures: number; bounce: number; lobbyFixtures: number; lobbyBounce: number; air: number; wear: number; sheen: number; wax: number; glow: number }
export const interiorDefaults = (): InteriorSettings => ({ mode: "interior", emitters: "area", fixtures: 0.55, bounce: 0.3, lobbyFixtures: 0.36, lobbyBounce: 0.22, air: 0.12, wear: 0.85, sheen: 0.85, wax: 0.9, glow: 1.25 })
export const interiorControls: LabControl[] = [
  {key:"interior.mode",field:"mode",label:"Interior lighting",type:"select",group:"Interior",options:[{value:"today",label:"Today"},{value:"interior",label:"Room bounce"}]},
  {key:"interior.emitters",field:"emitters",label:"Troffer",type:"select",group:"Interior",options:[{value:"point",label:"Point"},{value:"area",label:"Area"}]},
  {key:"interior.fixtures",field:"fixtures",label:"Fixtures",min:0,max:3,step:0.05,unit:"×",group:"Interior"},
  {key:"interior.bounce",field:"bounce",label:"Fixture bounce",min:0,max:1,step:0.01,unit:"×",group:"Interior"},
  {key:"interior.lobbyFixtures",field:"lobbyFixtures",label:"Lobby fixtures",min:0,max:3,step:0.01,unit:"×",group:"Interior"},
  {key:"interior.lobbyBounce",field:"lobbyBounce",label:"Lobby bounce",min:0,max:1,step:0.01,unit:"×",group:"Interior"},
  {key:"interior.air",field:"air",label:"Indoor fog",min:0,max:1,step:0.01,unit:"×",group:"Interior"},
  {key:"interior.wear",field:"wear",label:"Surface wear",min:0,max:1,step:0.01,unit:"×",group:"Interior"},
  {key:"interior.sheen",field:"sheen",label:"Wall sheen",min:0,max:1,step:0.01,unit:"×",group:"Interior"},
  {key:"interior.wax",field:"wax",label:"Floor wax",min:0,max:1,step:0.01,unit:"×",group:"Interior"},
  {key:"interior.glow",field:"glow",label:"Diffuser glow",min:0.5,max:4,step:0.05,unit:"×",group:"Interior"},
]
