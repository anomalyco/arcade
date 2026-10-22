// File authoring only. Kit authorized his own PVC for the new caller.
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { beat1Lines } from "../shared/beat1-lines"
const out=resolve(process.argv[2]??"captures/nightshift-beat1/voice"),voice="8olojUk4IXpvKgaOCHXj"
await mkdir(out,{recursive:true})
const key=process.env.ELEVENLABS_API_KEY
if(!key)throw Error("Inject ELEVENLABS_API_KEY with 2password")
for(const [i,line] of beat1Lines.entries()){
  const file=resolve(out,`kit-${String(i+1).padStart(2,"0")}.mp3`)
  if(await Bun.file(file).exists())continue
  const body={model_id:"eleven_v4",inputs:[{voice_id:voice,text:line.direction}],settings:{stability:.5,similarity:.75},use_pvc_as_ivc:false}
  const r=await fetch("https://api.elevenlabs.io/v1/text-to-dialogue",{method:"POST",headers:{"xi-api-key":key,"Content-Type":"application/json"},body:JSON.stringify(body)})
  if(!r.ok)throw Error(`Stem ${i+1}: HTTP ${r.status}`)
  await Bun.write(file,await r.arrayBuffer())
  await Bun.write(file.replace(".mp3",".json"),JSON.stringify({...body,requestId:r.headers.get("request-id"),subtitle:line.text,pause:line.pause},null,2))
  console.log(`Saved stem ${i+1}/${beat1Lines.length}`)
}
