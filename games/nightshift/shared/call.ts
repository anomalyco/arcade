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
  if(call.elapsed<4.3) return "“You're still there. Good.”"
  if(call.elapsed<8) return "“Leave the file on your desk. We'll call again.”"
  return "[the line goes quiet]"
}
export function ringEnvelope(time: number) {
  const t = ((time % 5.4)+5.4)%5.4
  return t<1.5 ? Math.min(1,t*30,(1.5-t)*30) : 0
}
