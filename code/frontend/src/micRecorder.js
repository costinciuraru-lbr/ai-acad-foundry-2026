// Records the microphone as PCM and hands back a plain WAV blob.
//
// Why not MediaRecorder: it produces webm/opus (or ogg/opus) by default, but
// /tools/transcribe forwards a hardcoded "codecs=audio/pcm" to Azure — the bytes
// have to actually be PCM in a WAV container, so we capture raw samples via the
// Web Audio API and write the WAV header ourselves instead of trusting a codec.
const TARGET_SAMPLE_RATE = 16000

function downsample(samples, inputRate, outputRate) {
  if (outputRate >= inputRate) return samples
  const ratio = inputRate / outputRate
  const outLength = Math.round(samples.length / ratio)
  const result = new Float32Array(outLength)
  let outIndex = 0, inIndex = 0
  while (outIndex < outLength) {
    const nextInIndex = Math.round((outIndex + 1) * ratio)
    let sum = 0, count = 0
    for (let i = inIndex; i < nextInIndex && i < samples.length; i++) { sum += samples[i]; count++ }
    result[outIndex] = count ? sum / count : 0
    outIndex++
    inIndex = nextInIndex
  }
  return result
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)) }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)        // fmt chunk size
  view.setUint16(20, 1, true)         // PCM
  view.setUint16(22, 1, true)         // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)   // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true)         // block align
  view.setUint16(34, 16, true)        // bits per sample
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([view], { type: 'audio/wav' })
}

export class MicRecorder {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.context = new (window.AudioContext || window.webkitAudioContext)()
    this.source = this.context.createMediaStreamSource(this.stream)
    // ScriptProcessorNode is deprecated but universally supported and simple —
    // fine for a short recorded question, not worth an AudioWorklet module here.
    this.processor = this.context.createScriptProcessor(4096, 1, 1)
    this.chunks = []
    this.processor.onaudioprocess = (e) => {
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }
    this.source.connect(this.processor)
    this.processor.connect(this.context.destination)
  }

  /** Stop capturing and return the recording as a WAV Blob. */
  stop() {
    this.processor.disconnect()
    this.source.disconnect()
    this.stream.getTracks().forEach((t) => t.stop())

    const totalLength = this.chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Float32Array(totalLength)
    let offset = 0
    for (const chunk of this.chunks) { merged.set(chunk, offset); offset += chunk.length }

    const resampled = downsample(merged, this.context.sampleRate, TARGET_SAMPLE_RATE)
    const blob = encodeWAV(resampled, TARGET_SAMPLE_RATE)
    this.context.close()
    return blob
  }
}
