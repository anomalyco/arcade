import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createDeflateRaw, deflateRawSync, constants } from "node:zlib"
import { World as Getaway } from "../../games/getaway/shared/sim/world"
import { World as Blackout, NO_INTENT } from "../../games/blackout/shared/sim/world"
import { buildSnapshot, snapshotEntities } from "../../games/blackout/shared/sim/view"
import { enterVehicle } from "../../games/blackout/shared/sim/vehicle-rules"
import { Binary, delta, apply, type Json, type Patch } from "./codecs"

const root = join(import.meta.dir, "../.."), output = join(root,"perf/proposals-data")
mkdirSync(output,{recursive:true})
const median = (a: number[]) => [...a].sort((a,b)=>a-b)[Math.floor(a.length/2)]!
const summary = (a: number[]) => ({ median:median(a),mad:median(a.map(x=>Math.abs(x-median(a)))),min:Math.min(...a),max:Math.max(...a),runs:a })
type Packet = { viewer: number; index: number; tick: number; json: any; raw: string }
const stats = []
const estimatesOnly=process.argv.includes('--estimates-only')
for (const game of ["getaway", "blackout-office", "blackout-downtown", "blackout-downtown-driving"]) {
  const ids = Array.from({length:game==="getaway"?8:10},(_,i)=>`human${i}`)
  const world = game === "getaway" ? new Getaway(7123,[...ids.map(id=>({id,name:id,human:true,picks:{robber:"muscle",cop:"cruiser"}})),...[0,1].map(i=>({id:`bot${i}`,name:`bot${i}`,human:false,picks:{robber:"compact",cop:"interceptor"}}))]) : new Blackout(7123,null,"ffa",game.includes("downtown")?"downtown":"office")
  if (world instanceof Blackout) { for(const id of ids) world.addHuman(id,id); world.botFill=14; world.fill() }
  if (world instanceof Blackout && game.includes("driving")) {
    const car=world.vehicles[0]!,human=world.players.get(ids[0]!)!
    human.x=car.x;human.y=car.y
    if(!enterVehicle(world,human))throw Error('Could not enter vehicle')
  }
  const corpus: Packet[] = []
  let eventBytes = 0, eventMessages = 0
  for(let tick=0;tick<1000;tick++) {
    if(world instanceof Getaway) {
      for(let i=0;i<ids.length;i++) world.setInput(ids[i]!,{throttle:1,brake:0,steer:Math.sin((tick+i*70)*.015)*.7,handbrake:tick%180>160,boost:tick%200<20})
      world.step(1/30)
      const events=world.drainEvents()
      if(events.length) { eventBytes+=Buffer.byteLength(JSON.stringify({type:"events",events}));eventMessages++ }
      if(tick%2) continue
      const base=world.viewBase()
      ids.forEach((id,viewer)=>{const raw=JSON.stringify({type:"snapshot",tick:tick+1,ack:tick+1,view:world.view(id,base),you:world.carOf(id)?.body??null});corpus.push({viewer,index:tick/2,tick:tick+1,json:JSON.parse(raw),raw})})
    } else {
      for(let i=0;i<ids.length;i++) world.push(ids[i]!,tick+1,{...NO_INTENT,mx:Math.sin(tick*.02+i),my:Math.cos(tick*.02+i),aim:tick*.03+i,fire:tick%3===0})
      world.step()
      const events=world.takeEvents()
      if(events.length) {eventBytes+=Buffer.byteLength(JSON.stringify({type:"ev",events}));eventMessages++}
      if(tick%2) continue
      const shared=snapshotEntities(world)
      ids.forEach((id,viewer)=>{const raw=JSON.stringify(buildSnapshot(world,id,shared));corpus.push({viewer,index:tick/2,tick:tick+1,json:JSON.parse(raw),raw})})
    }
  }
  const sourceHash = new Bun.CryptoHasher("sha256"); corpus.forEach(p=>sourceHash.update(p.raw))
  const digest=sourceHash.digest("hex")
  for(const variant of estimatesOnly?[]:["json","delta-json","binary64","delta-binary64"]) {
    const runs: any[]=[]
    for(let run=0;run<8;run++) {
      const enc=ids.map(()=>new Binary()),dec=ids.map(()=>new Binary())
      const compressors=run===0?ids.map(()=>createDeflateRaw({level:6})):[]
      let contextBytes=0
      compressors.forEach(s=>s.on('data',chunk=>{contextBytes+=chunk.length}))
      const previous: Json[]=ids.map(()=>null), received:Json[]=ids.map(()=>null)
      let bytes=0, compressed=0, encodeMs=0,decodeMs=0,keyframes=0
      const hash=new Bun.CryptoHasher("sha256")
      const sizes:number[]=[]
      for(const packet of corpus) {
        const {viewer:v,json,index}=packet, d=variant.startsWith("delta"), bin=variant.includes("binary")
        const t=performance.now()
        const payload:Json=d ? index%30===0 ? [index,-1,[0,json]] : [index,index-1,delta(previous[v]!,json) as Json] : json
        if(d&&index%30===0)keyframes++
        const wire=bin?enc[v]!.encode(payload):JSON.stringify(payload)
        encodeMs+=performance.now()-t
        const byteLength=typeof wire==="string"?Buffer.byteLength(wire):wire.byteLength
        bytes+=byteLength;sizes.push(byteLength)
        // RFC7692-style no-context-takeover model, NOT a negotiated Workers connection.
        if(run===0) {
          compressed+=deflateRawSync(wire,{level:6,finishFlush:constants.Z_SYNC_FLUSH}).length-4
          const compressor=compressors[v]!
          compressor.write(wire)
          await new Promise<void>((resolve,reject)=>{compressor.once('error',reject);compressor.flush(constants.Z_SYNC_FLUSH,()=>{compressor.off('error',reject);resolve()})})
          contextBytes-=4
        }
        const t1=performance.now()
        const decoded:any=bin?dec[v]!.decode(wire as Uint8Array):JSON.parse(wire as string)
        if(d) {
          if(decoded[0]!==index||decoded[1]!== (index%30===0?-1:index-1))throw Error("Delta base mismatch")
          received[v]=apply(received[v]!,decoded[2] as Patch)
        } else received[v]=decoded
        decodeMs+=performance.now()-t1
        // Outside timed codec interval: strict equality of every reconstructed wire snapshot.
        const reconstructed=JSON.stringify(received[v])
        if(reconstructed!==packet.raw)throw Error(`Mismatch ${game}/${variant}/${index}/${v}`)
        hash.update(reconstructed);previous[v]=json
      }
      const outputDigest=hash.digest("hex");if(outputDigest!==digest)throw Error('Digest mismatch')
      compressors.forEach(s=>s.destroy())
      runs.push({run,warmup:run===0,bytes,compressed:run===0?compressed:undefined,compressed_context:run===0?contextBytes:undefined,encode_ms:encodeMs,decode_ms:decodeMs,digest:outputDigest,keyframes,min_packet:Math.min(...sizes),max_packet:Math.max(...sizes)})
    }
    const measured=runs.slice(1),first=runs[0]!
    const record={experiment:"proposals-network",game,variant,timestamp:new Date().toISOString(),warmup:1,measured:7,connections:ids.length,ticks:1000,seconds:1000/30,snapshot_hz:15,packets:corpus.length,bytes_per_snapshot:first.bytes/corpus.length,bytes_per_tick_per_player:first.bytes/ids.length/1000,bytes_per_second_per_player:first.bytes/ids.length/(1000/30),deflate_no_context_bytes_per_snapshot:first.compressed!/corpus.length,deflate_no_context_bytes_per_second_per_player:first.compressed!/ids.length/(1000/30),events_per_second_per_player:eventMessages/(1000/30),event_bytes_per_second_per_player:eventBytes/(1000/30),encode_ms:summary(measured.map(r=>r.encode_ms)),decode_ms:summary(measured.map(r=>r.decode_ms)),identicalSnapshots:true,digest,runs}
    Object.assign(record,{deflate_context_bytes_per_snapshot:first.compressed_context!/corpus.length,deflate_context_bytes_per_second_per_player:first.compressed_context!/ids.length/(1000/30)})
    stats.push(record);appendFileSync(join(root,"perf/results.jsonl"),JSON.stringify(record)+"\n")
    console.log(JSON.stringify({game,variant,bytes:record.bytes_per_snapshot,deflate:record.deflate_no_context_bytes_per_snapshot,encode:record.encode_ms.median,decode:record.decode_ms.median}))
  }
  // Separate lossy/visibility candidates: never used to drive the authoritative simulation.
  let quantBytes=0,interestBytes=0,quantError=0,angleError=0,entities=0,nearEntities=0
  for(const {json,viewer} of corpus) {
    const quant=(x:any,key=""):any=>{
      if(key==="you")return x // preserve exact authoritative own-body reconciliation
      if(typeof x==="number"&&["x","y","z","vx","vy","vz"].includes(key)){const q=Math.round(x*100)/100;quantError=Math.max(quantError,Math.abs(x-q));return q}
      if(typeof x==="number"&&["h","aim"].includes(key)){const q=Math.round(x/(2*Math.PI)*4096)*(2*Math.PI)/4096;angleError=Math.max(angleError,Math.abs(x-q));return q}
      if(Array.isArray(x))return x.map(v=>quant(v))
      if(x&&typeof x==="object")return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,quant(v,k)]))
      return x
    }
    quantBytes+=Buffer.byteLength(JSON.stringify(quant(json)))
    const copy=structuredClone(json),list=copy.view?.cars??copy.players
    const me=game==="getaway"?list.find((p:any)=>p.ownerId===ids[viewer]):list.find((p:any)=>p.id===ids[viewer])
    // Byte-only radius estimate per recipient; not a visibility or gameplay correctness prototype.
    if(me){const near=(p:any)=>Math.hypot(p.x-me.x,(p.z??p.y)-(me.z??me.y))<=60;entities+=list.length;const kept=list.filter(near);nearEntities+=kept.length;if(copy.view)copy.view.cars=kept;else{copy.players=kept;if(copy.vehicles)copy.vehicles=copy.vehicles.filter(near)}}
    interestBytes+=Buffer.byteLength(JSON.stringify(copy))
  }
  const estimate={experiment:"proposals-network-candidates-per-recipient",game,packets:corpus.length,quantized_json_bytes_per_snapshot:quantBytes/corpus.length,position_velocity_max_error:quantError,angle_max_error_rad:angleError,radius60_json_bytes_per_snapshot:interestBytes/corpus.length,entities_kept_fraction:nearEntities/entities,note:"Quantization and radius filtering are byte estimates only; reconstructed views are not identical. Radius estimate uses each recipient across already viewer-filtered snapshots; does not implement spectator/visibility/interaction guarantees."}
  stats.push(estimate);appendFileSync(join(root,"perf/results.jsonl"),JSON.stringify(estimate)+"\n")
}
writeFileSync(join(output,estimatesOnly?"network-candidates.json":"network.json"),JSON.stringify(stats,null,2))
