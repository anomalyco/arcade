import { STUN_SERVERS, type VoiceIce, type VoiceIceServer } from "../net/voice"

export type VoiceTurnEnv = { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string }

/** Invoked only by an authenticated room's voice.join/refresh, never a public credential endpoint. */
export async function voiceIce(env: VoiceTurnEnv): Promise<VoiceIce> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return { iceServers: STUN_SERVERS, relay: false }
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 3600 }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`TURN credential service: ${response.status}`)
  const body = await response.json() as { iceServers?: VoiceIceServer[] }
  if (!Array.isArray(body.iceServers) || !body.iceServers.length) throw new Error("TURN service returned no ICE servers")
  return { iceServers: body.iceServers, relay: true }
}
