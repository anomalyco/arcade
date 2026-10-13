import { Miniflare } from "../../games/blackout/node_modules/miniflare"
// @ts-expect-error The locked transitive ws package has no bundled declarations.
import WebSocket from "../../games/blackout/node_modules/ws"
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Local workerd negotiation proof; no deployment or connection to a production room.
const rows=[]
for (const enabled of [true,false]) {
  const contents=`export default {fetch(request) {const [client,server]=Object.values(new WebSocketPair()); server.accept();server.addEventListener('message',event=>server.send(event.data));return new Response(null,{status:101,webSocket:client})}}`
  const mf=new Miniflare({host:"127.0.0.1",port:0,workers:[{config:{name:"compression-proof",compatibilityDate:"2026-09-08",compatibilityFlags:enabled?[]:["no_web_socket_compression"],manifest:{mainModule:"worker.js",modules:{"worker.js":{type:"esm",contents}}}}}]})
  try {
    const url=await mf.ready
    const result=await new Promise<any>((resolve,reject)=>{
      const ws=new WebSocket(String(url).replace('http:','ws:'),{perMessageDeflate:true})
      const timeout=setTimeout(()=>{ws.terminate();reject(Error('Local compression handshake timed out'))},10000)
      ws.on('error',reject)
      ws.on('open',()=>ws.send('snapshot '.repeat(1000)))
      ws.on('message',(data:Buffer)=>{const record={enabled,extension:ws.extensions,echoBytes:data.length,echoMatches:data.toString()==='snapshot '.repeat(1000)};clearTimeout(timeout);ws.close();resolve(record)})
    })
    if(!result.echoMatches)throw Error('Echo mismatch')
    rows.push(result)
  } finally {await mf.dispose()}
}
const record={experiment:"proposals-compression-negotiation",runtime:"local Miniflare/workerd",compatibilityDate:"2026-09-08",results:rows,note:"Local front-door negotiation only. Both enabled and disabled cases advertise permessage-deflate, so the Miniflare proxy masks the workerd flag; this does NOT validate production negotiation or distinguish runtime compression settings. Corpus byte counts are separately modeled."}
const root=join(import.meta.dir,"../..")
appendFileSync(join(root,"perf/results.jsonl"),JSON.stringify(record)+"\n")
writeFileSync(join(root,"perf/proposals-data/compression.json"),JSON.stringify(record,null,2))
console.log(JSON.stringify(record))
