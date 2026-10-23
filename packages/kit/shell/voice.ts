/** Structural adapter: games without voice do not import WebRTC or microphone code. */
export interface ShellVoice {
  readonly enabled: boolean
  readonly pending: boolean
  readonly micMuted: boolean
  readonly error: string
  readonly mode: "open" | "push"
  readonly volume: number
  readonly muted: ReadonlySet<string>
  setEnabled(on: boolean): Promise<void>
  setMode(mode: "open" | "push"): void
  setVolume(volume: number): void
  toggleMic(): void
  mute(id: string, on: boolean): void
  subscribe(fn: () => void): () => void
}
