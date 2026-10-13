import { getMap, type MapDef, type Prop, type Wall } from "../../shared/maps"
import { layout } from "../../shared/maps/layout"
import { Rng } from "../../shared/rng"
import type { Rect } from "../../shared/geom"
import { deskMonitorLights } from "../render/models"

export const blackoutRooms=[{value:"office",label:"Open-plan office"},{value:"corridor",label:"Corridor"},{value:"meeting",label:"Meeting room with glass"},{value:"breakroom",label:"Breakroom"},{value:"server",label:"Server room"},{value:"downtown",label:"Downtown street"}]

/** Crop a real generated floor about a room, rather than imitating the room with generic boxes. */
export function blackoutEnvironment(kind:string,seed:number):MapDef {
  let sourceSeed=seed,cx=0,cy=0
  if(kind!=="downtown"){
    for(let attempt=0;attempt<64;attempt++){
      sourceSeed=(seed+attempt)>>>0
      const plan=layout(new Rng(sourceSeed))
      const room=plan.rooms.find(r=>kind==="office"?["hall","cubicles"].includes(r.kind):kind==="breakroom"?["kitchen","cafe"].includes(r.kind):r.kind===kind)
      const rect=kind==="corridor"?plan.corridors[0]:room?.rect
      if(rect){cx=(rect[0]+rect[2])/2;cy=(rect[1]+rect[3])/2;break}
      if(attempt===63)throw new Error(`No ${kind} in 64 generated office floors`)
    }
  }
  const map=getMap(kind==="downtown"?"downtown":"office",sourceSeed),r=new Rng(seed^0xF00D)
  if(kind==="downtown"){const road=map.roads?.[Math.floor(r.next()*(map.roads?.length??1))];cx=road?(road.rect[0]+road.rect[2])/2:map.size[0]/2;cy=road?(road.rect[1]+road.rect[3])/2:map.size[1]/2}
  const x0=Math.max(0,Math.min(map.size[0]-24,cx-12)),y0=Math.max(0,Math.min(map.size[1]-20,cy-10))
  const overlaps=(a:Rect)=>a[0]<x0+24&&a[2]>x0&&a[1]<y0+20&&a[3]>y0
  const rect=(a:Rect):Rect=>[Math.max(0,a[0]-x0),Math.max(0,a[1]-y0),Math.min(24,a[2]-x0),Math.min(20,a[3]-y0)]
  const walls:Wall[]=map.walls.filter(w=>overlaps(w.rect)).map(w=>({...w,rect:rect(w.rect)}))
  const props:Prop[]=map.props.filter(p=>overlaps(p.rect)).map(p=>({...p,rect:rect(p.rect),light:undefined}))
  // Production prop/surface specimens keep every impact path available in every generated room.
  // The five specimens sit in a cleared test bay; the surrounding floor retains the generator's furnishing.
  const bay:Rect=[6,5,18,14],inBay=(a:Rect)=>a[0]<bay[2]&&a[2]>bay[0]&&a[1]<bay[3]&&a[3]>bay[1]
  const glass:Rect=[7,9,10,9.1],desk:Prop={kind:"desk",rect:[11,8.5,13,9.3],rot:0,solid:true}
  const specimens:Wall[]=[{rect:[11,5.5,13,5.7],h:1.8,style:"wall"},{rect:[15,8,17,8.5],h:1.8,style:"rack"},{rect:[7,5.5,9,5.7],h:1.3,style:"partition"}]
  const lights=map.lights.filter(l=>l.x>x0&&l.x<x0+24&&l.y>y0&&l.y<y0+20).slice(0,6).map((l,id)=>({...l,id,x:l.x-x0,y:l.y-y0,power:l.power*(.7+r.next()),color:[.5+r.next()*.5,.4+r.next()*.6,.35+r.next()*.65] as const}))
  lights.push({id:lights.length,kind:"panel",x:8+r.next()*8,y:7+r.next()*5,h:2.8,r:10,power:1.5+r.next(),color:[1,.72,.45]})
  // The production desk builder only equips some desks with monitors. Pick its material seed so
  // specimen zero contains one, rather than adding a fake screen or silently missing this path.
  let materialSeed=seed
  for(let i=0;i<128;i++,materialSeed++)if(deskMonitorLights({...map,seed:materialSeed,props:[desk]}).length)break
  return {...map,id:`lab-${kind}-${seed}`,seed:materialSeed,size:[24,20],floors:map.floors.filter(f=>overlaps(f.rect)).map(f=>({...f,rect:rect(f.rect)})),walls:[...specimens,...walls.filter(w=>!inBay(w.rect))],props:[desk,...props.filter(p=>!inBay(p.rect))],glass:[glass,...map.glass.filter(a=>overlaps(a)&&!inBay(rect(a))).map(rect)],windows:map.windows.filter(a=>overlaps(a)&&!inBay(rect(a))).map(rect),lights,tape:map.tape.filter(overlaps).map(rect),voids:[],vehicles:[],spawns:[{x:12,y:12}],roads:map.roads?.filter(a=>overlaps(a.rect)).map(a=>({...a,rect:rect(a.rect)})),paint:map.paint?.filter(a=>overlaps(a.rect)).map(a=>({...a,rect:rect(a.rect)}))}
}

/** Decode the game's packed 24-byte vertices for the Lab's neutral shared material adapter. */
export function unpackLevel(data:ArrayBuffer):number[] {
  const view=new DataView(data),vertices:number[]=[]
  const half=(h:number)=>{const s=h&0x8000?-1:1,e=h>>10&31,m=h&1023;return s*(e?Math.pow(2,e-15)*(1+m/1024):Math.pow(2,-14)*m/1024)}
  for(let i=0;i<data.byteLength;i+=72){
    const mat=half(view.getUint16(i+20,true));if([7,11,13].includes(mat))continue
    for(let j=i;j<i+72;j+=24)vertices.push(view.getFloat32(j,true),view.getFloat32(j+4,true),view.getFloat32(j+8,true),view.getInt8(j+12)/127,view.getInt8(j+13)/127,view.getInt8(j+14)/127,view.getUint8(j+16)/255,view.getUint8(j+17)/255,view.getUint8(j+18)/255,[2,3].includes(mat)?1.5:0)
  }
  return vertices
}
