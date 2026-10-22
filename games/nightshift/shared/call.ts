export type Phase = "ringing" | "pickup" | "call" | "hangup" | "ended"
export type Call = { phase: Phase; elapsed: number; lift: number }
export const newCall = (): Call => ({ phase: "ringing", elapsed: 0, lift: 0 })
export function interact(call: Call, reachable: boolean) {
  if (call.phase === "ringing" && reachable) { call.phase = "pickup"; call.elapsed = 0 }
  else if (call.phase === "call") { call.phase = "hangup"; call.elapsed = 0 }
}
export function stepCall(call: Call, dt: number, duration: number) {
  call.elapsed += dt
  const t = Math.min(1, call.elapsed / duration), smooth = t*t*t*(10+t*(-15+6*t))
  if(call.phase==="call"&&call.elapsed>=CALL_DURATION){call.phase="hangup";call.elapsed=0;return}
  if (call.phase === "pickup") { call.lift = smooth; if(t===1) { call.phase="call";call.elapsed=0 } }
  if (call.phase === "hangup") { call.lift = 1-smooth; if(t===1) { call.phase="ended";call.elapsed=0 } }
}
export function subtitle(call: Call) {
  if(call.phase!=="call") return ""
  if(call.elapsed<1) return "[line connects]"
  const cue=recording.cues.find(c=>call.elapsed>=c.start&&call.elapsed<c.end)
  return cue?`“${cue.text}”`:call.elapsed>=recording.click?"[click. dial tone]":""
}
export function ringEnvelope(time: number) {
  const t = ((time % 5.4)+5.4)%5.4
  return t<1.5 ? Math.min(1,t*30,(1.5-t)*30) : 0
}
import recording from "./kit-call.json"
export const CALL_DURATION=recording.duration
export const CALL_CLICK=recording.click
export const CALL_FIRST_LINE_END=recording.cues[0]!.end
