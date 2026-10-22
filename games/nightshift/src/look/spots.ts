/** The fixed paint-over cameras (the five office spots, the car, then the basement) (metres, radians). Seated poses use the opening's eye height. */
export const LOOK_SPOTS=[
  {id:"desk",label:"Seated at the desk",x:-.74,z:-4.47,height:1.2,yaw:0,pitch:-.12,ended:false},
  {id:"phone",label:"Looking at the phone",x:-.08,z:-4.82,height:1.65,yaw:-.30,pitch:-.95,ended:false},
  {id:"across",label:"Over the partition",x:-.74,z:-4.47,height:1.4,yaw:-3.10,pitch:.025,ended:false},
  {id:"aisle",label:"The aisle to the elevator",x:.05,z:-1.6,height:1.65,yaw:Math.PI,pitch:-.04,ended:true},
  {id:"elevator",label:"The elevator doorway",x:.1,z:6.4,height:1.65,yaw:Math.PI,pitch:-.08,ended:true},
  {id:"car",label:"Inside the elevator car",x:-.45,z:9.25,height:1.65,yaw:-2.5,pitch:-.12,ended:true},
  {id:"basement",label:"Out of the car into the basement",x:40,z:7.7,height:1.65,yaw:0,pitch:-.04,ended:true,downstairs:true},
  {id:"servers",label:"Halfway down the basement",x:40.3,z:-1.5,height:1.65,yaw:.35,pitch:-.06,ended:true,downstairs:true},
] as const
export type LookSpot=typeof LOOK_SPOTS[number]
