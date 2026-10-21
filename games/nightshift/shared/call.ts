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
  if (call.phase === "pickup") { call.lift = smooth; if(t===1) { call.phase="call";call.elapsed=0 } }
  if (call.phase === "hangup") { call.lift = 1-smooth; if(t===1) { call.phase="ended";call.elapsed=0 } }
}
export function subtitle(call: Call) {
  if(call.phase!=="call") return ""
  if(call.elapsed<1) return "[line connects]"
  if(call.elapsed<4.1) return "“…You're still here. Good.”"
  if(call.elapsed<6.5) return "“It's Jay.”"
  if(call.elapsed<7) return ""
  if(call.elapsed<10.7) return "“Come up to my office. I need to see you.”"
  if(call.elapsed<11.6) return ""
  if(call.elapsed<14) return "“…Don't take the lift.”"
  return "[click. dial tone]"
}
export function ringEnvelope(time: number) {
  const t = ((time % 5.4)+5.4)%5.4
  return t<1.5 ? Math.min(1,t*30,(1.5-t)*30) : 0
}
