import type { LabControl } from "@arcade/kit/lab-panel"
export const defaults = () => ({ exposure: 0.72, ambient: 0.055, sodium: 3.2, fluorescent: 0.8, crt: 0.016, fog: 0.012, dust: 0.6, flicker: 1, speed: 1.7, volume: 0.55, pickup: 0.65 })
export type Settings = ReturnType<typeof defaults>
export function controls(): LabControl[] {
  const row = (key: keyof Settings, label: string, min: number, max: number, step: number, unit: string, group = "Office"): LabControl => ({ key, label, min, max, step, unit, group })
  return [row("exposure","Exposure",0.1,2,0.01,"×"),row("ambient","Teal ambient",0,0.2,0.001,"×"),row("sodium","Streetlight",0,20,0.1,"×"),row("fluorescent","Troffer",0,3,0.01,"×"),row("crt","CRT spill",0,1,0.01,"×"),row("fog","Air density",0,0.08,0.001,"m⁻¹"),row("dust","Dust",0,1,0.05,"×"),row("flicker","Tube flicker",0,2,0.05,"×"),row("speed","Walk speed",0.5,3,0.1,"m/s","Feel"),row("pickup","Handset travel",0.3,1.2,0.05,"s","Feel"),row("volume","Volume",0,1,0.05,"×","Audio")]
}
