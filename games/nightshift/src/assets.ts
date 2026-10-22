/** Files the office needs before Begin; main.ts fetches them all at once with boot-screen progress. */
export const PROP_DEFINITIONS=[
  {kind:"crt",file:"authored/crt",at:[-.74,.795,-5.65],size:[.52,.50,.57],yaw:0},
  {kind:"pen-cup",file:"pen-cup",at:[1.02,.795,-5.35],size:[.15,.25,.14],yaw:.3},
  {kind:"mug",file:"period/mug",at:[.62,.795,-5.48],size:[.10,.14,.145],yaw:-.7},
  {kind:"chair",file:"period/chair",at:[.65,0,-4.55],size:[.62,1.02,.65],yaw:-.3},
  {kind:"phone",file:"authored/phone-base",at:[.12,.79,-5.4],size:[.40,.13,.38],yaw:0},
  {kind:"rolodex",file:"authored/rolodex",at:[1.34,.795,-5.55],size:[.23,.19,.23],yaw:-.15},
]
export const CARPET_MAPS=["color","normal","orm"] as const
/** Boot-log stages: path relative to the base, stage id and label. */
export const OFFICE_FILES=[
  ...PROP_DEFINITIONS.map(d=>({id:d.kind,path:`props/${d.file}.glb`,label:`READ ${d.file.split("/").pop()!.toUpperCase()}.GLB`})),
  ...CARPET_MAPS.map(m=>({id:`carpet-${m}`,path:`props/carpet-${m}.webp`,label:`READ CARPET-${m.toUpperCase()}.WEBP`})),
]
/**
 * Boot-bar weights, roughly milliseconds of a cold desktop load (load-timing.ts, Oct 21): bundle, adapter, world and
 * renderer, the GPU's pipeline compiles, each file by its kilobytes (download and decode), then the first frame.
 */
export const BOOT_PLAN:Record<string,number>={program:900,video:50,office:400,shaders:300,frame:500,
  crt:902,"pen-cup":54,mug:1451,chair:1937,phone:870,rolodex:220,"carpet-color":426,"carpet-normal":2274,"carpet-orm":569}
