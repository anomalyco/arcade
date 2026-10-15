import { $ } from "bun"
import { deinterleave } from "../../packages/kit/audio/sfx-analysis"

/** Decodes any audio file to de-interleaved 48 kHz float channels with ffmpeg (native channel count unless forced). */
export async function decode(file: string, channels?: number): Promise<Float32Array[]> {
  const count = channels ?? Number((await $`ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 ${file}`.text()).trim() || 1)
  const raw = await $`ffmpeg -v error -i ${file} -ac ${count} -ar 48000 -f f32le -`.arrayBuffer()
  return deinterleave(new Float32Array(raw), count)
}

export async function probe(file: string): Promise<{ codec: string; sampleRate: number; channels: number; bitRate: number }> {
  const out = (await $`ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels,bit_rate:format=bit_rate -of json ${file}`.json()) as {
    streams: { codec_name: string; sample_rate: string; channels: number; bit_rate?: string }[]
    format: { bit_rate?: string }
  }
  const s = out.streams[0]!
  return { codec: s.codec_name, sampleRate: Number(s.sample_rate), channels: s.channels, bitRate: Number(s.bit_rate ?? out.format.bit_rate ?? 0) }
}
