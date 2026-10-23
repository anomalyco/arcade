# Room voice

`@arcade/kit/voice` carries opt-in microphone audio over a WebRTC mesh (six people maximum). The existing room
WebSocket carries signalling only. `RoomCore.voice = new VoiceRoom(...)` opts a game in. The room stamps the sender
from its authenticated seat, restricts targets to the room, validates bounded SDP/ICE frames, and removes voice
membership immediately on disconnect or idle kick. A fresh voice session id rejects stale reconnect messages.

Pass the `VoiceChat` to `RoomSocket` and the shared shell as `voice`. The shell supplies the lobby toggle,
Settings, voice volume, open mic / push-to-talk and individual player mutes. Only switching the toggle on calls
`getUserMedia`; switching off stops its tracks. Permission failures stay in the shell, with a retry by toggling on.
Voice opt-in is not saved across page loads. Reconnecting the room reuses the already-consented microphone and
rebuilds peer connections. No microphone is requested by solo or bot play.

## Audio and controls

One mono Opus track per peer, echo cancellation, noise suppression and DTX. Track transmission is disabled whenever
neither proximity nor radio is active. Natural speech follows the friend's rendered head through the shared
`audio/spatial-path`: travel delay at 343 m/s, HRTF, distance gain, obstruction low-pass and forest reverb send.
The default hearing range is 36 m; the direct voice and its reverb send both reach zero there.

Each remote stream also owns a muted media element to start Chromium's WebRTC decoder. Without it, ICE and RTP
can be healthy while WebAudio receives zero samples. Only the spatial/radio WebAudio graph is audible. Peer
cleanup pauses the element and clears its stream. `addTrack` lets incoming offers reuse the sending transceiver.

The walkie adds a distance-independent receiver path: 300–3400 Hz, light saturation, squelch clicks and seeded
static increasing with distance and depleted battery. Natural speech remains at the transmitter's position while
the radio is keyed, so a nearby friend hears both the mouth and the radio. There is no local microphone sidetone.
Mute-player gates both paths and the wet send. Game mute affects listening, never the microphone's mute state.

BARBARA bindings (physical codes, QWERTY key caps): V (`KeyV`) radio, B (`KeyB`) nearby push-to-talk, N (`KeyN`)
microphone mute. M remains game audio mute. Other adopters must check their bindings: V is melee in Blackout and
Outbreak, and weapon cycle in Carrier. Held inputs release on blur, hidden tabs, menus and Meta release.
`bindVoiceLab` exposes the typed spatial settings and Reset in the shared LabPanel.

## TURN setup

Without Worker secrets this uses Cloudflare STUN only. Direct connections work on compatible networks; symmetric
NATs and restrictive networks need TURN. No saved TURN credential was found by `2password find` on Oct 22, 2026.
The Cloudflare account has not been modified.

To enable relaying for BARBARA:

1. In the **anomaly** account (`15d29c8639fd3733b1b5486a2acfd968`), open **Realtime → TURN** and create an Arcade
   TURN key. Save its key ID and API token in the team's secret store.
2. On the Pro, from the BARBARA checkout using the anomaly auth profile, set **only** the `arcade-barbara` Worker's
   `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` secrets using Wrangler's stdin prompts. Never put the token in source,
   client configuration or command arguments.
3. Join a room with two consenting microphones on distinct networks and verify a relayed connection (force
   `iceTransportPolicy: "relay"` in a dedicated diagnostic build). The local proof does not verify public TURN.

`server/voice-turn` calls Cloudflare's `generate-ice-servers` API server-side with a one-hour TTL. Only authenticated
room members can request credentials. Clients refresh every 30 minutes with `setConfiguration`; per-seat caching,
refresh throttling and a room token bucket bound minting even if players toggle or churn seats. Provider failures
fall back to STUN. No public credential endpoint or new signalling service is deployed.

Source: https://developers.cloudflare.com/realtime/turn/generate-credentials/

## Proof

`hivemind run --worker pro --kind browser --browser-approval '<requested voice proof>' --fetch captures/voice-chat -- bun scripts/prove-voice.ts` runs two headless Chromium contexts, fake microphone
PCM and `--mute-audio`, against a local Wrangler room using the production `RoomCore`, `RoomSocket`, relay and
voice client. It measures received level at 2 m, 30 m and behind an obstruction, then re-renders the received PCM
through the production audio chain in an `OfflineAudioContext`. It also checks opt-in and peer cleanup. Output is
`captures/voice-chat/two-client.json` (or `$LEASE_OUT`). The launcher uses the shared browser budget. No video or
audible playback is produced.

The proof uses direct host ICE candidates (mDNS disabled only in its Chromium launch) and no public STUN/TURN.
On Oct 22, 2026, Pro passed: received RMS 0.03392 at 2 m, 0.00073 at 30 m and 0.00139 behind an obstruction;
offline proximity at 60 m was exactly zero and radio at 300 m was 0.02677. Mini failed to establish direct ICE,
so it did not exercise audio decoding. Public relay, device permissions and human speech quality remain separate checks.
