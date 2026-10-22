// File-only authoring; no playback. Run under 2password with Kit's authorized key.
import { resolve } from "node:path"
import { descentLines } from "../shared/descent-lines"
const out=resolve(process.argv[2]??"captures/nightshift-descent/voice"),key=process.env.ELEVENLABS_API_KEY
if(!key)throw Error("Inject ELEVENLABS_API_KEY with 2password")
const headers={"xi-api-key":key,"Content-Type":"application/json"},voice="8olojUk4IXpvKgaOCHXj"
const modelResponse=await fetch("https://api.elevenlabs.io/v1/models",{headers})
if(modelResponse.ok){const models=await modelResponse.json() as {model_id:string}[];if(!models.some(m=>m.model_id==="eleven_v4"))throw Error("Requested model unavailable")}
else if(modelResponse.status!==401)throw Error(`Model discovery: HTTP ${modelResponse.status}`)
const identity=await fetch(`https://api.elevenlabs.io/v1/voices/${voice}`,{headers}).then(r=>r.json()) as {voice_id:string;name:string}
if(identity.voice_id!==voice)throw Error("Requested voice unavailable")
await Bun.write(resolve(out,"identity.json"),JSON.stringify({voice_id:identity.voice_id,name:identity.name,model:"eleven_v4"},null,2))
for(const line of descentLines){
  const path=resolve(out,`${line.id}.mp3`);if(await Bun.file(path).exists())continue
  const body={model_id:"eleven_v4",inputs:[{voice_id:voice,text:line.direction}],settings:{stability:.5,similarity:.75},use_pvc_as_ivc:false}
  const r=await fetch("https://api.elevenlabs.io/v1/text-to-dialogue",{method:"POST",headers,body:JSON.stringify(body)})
  if(!r.ok)throw Error(`${line.id}: HTTP ${r.status}`)
  await Bun.write(path,await r.arrayBuffer())
  await Bun.write(path.replace(".mp3",".json"),JSON.stringify({...body,requestId:r.headers.get("request-id"),subtitle:line.text,pause:line.pause,room:line.room},null,2))
  console.log(`Saved ${line.id}`)
}
