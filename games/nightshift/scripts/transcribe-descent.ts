import { resolve } from "node:path"
import { descentLines } from "../shared/descent-lines"
const out=resolve(process.argv[2]),audio=resolve(out,"all-lines.mp3")
const inputs=descentLines.flatMap(l=>["-i",resolve(import.meta.dir,`../public/audio/descent/${l.id}.mp3`)])
const concat=descentLines.map((_,i)=>`[${i}:a]`).join("")+`concat=n=${descentLines.length}:v=0:a=1,volume=4[a]`
const mux=Bun.spawn(["ffmpeg","-v","error","-y",...inputs,"-filter_complex",concat,"-map","[a]",audio],{stdout:"inherit",stderr:"inherit"})
if(await mux.exited!==0)throw Error("Stem assembly failed")
const key=process.env.ELEVENLABS_API_KEY;if(!key)throw Error("Inject ELEVENLABS_API_KEY")
const form=new FormData();form.append("model_id","scribe_v1");form.append("file",Bun.file(audio));form.append("language_code","eng");form.append("tag_audio_events","false")
const r=await fetch("https://api.elevenlabs.io/v1/speech-to-text",{method:"POST",headers:{"xi-api-key":key},body:form})
if(!r.ok)throw Error(`Transcript HTTP ${r.status}`)
const result=await r.json();await Bun.write(resolve(out,"transcript.json"),JSON.stringify(result,null,2));console.log((result as {text:string}).text)
