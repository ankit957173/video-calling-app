/** Mobile browsers cannot run Web Speech API while WebRTC holds the mic. */
export function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

const CAPTURE_INTERVAL_MS = 3500;
const VAD_THRESHOLD = 0.01;
const TARGET_SAMPLE_RATE = 16000;

function downsample(buffer, fromRate, toRate) {
  if (fromRate === toRate) return buffer;
  const ratio = fromRate / toRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    result[i] = buffer[Math.min(Math.round(i * ratio), buffer.length - 1)];
  }
  return result;
}

function encodeWAV(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/** Tap the existing WebRTC audio track and send WAV chunks for server-side STT. */
export class MobileAudioCapturer {
  constructor({ onChunk, intervalMs = CAPTURE_INTERVAL_MS }) {
    this.onChunk = onChunk;
    this.intervalMs = intervalMs;
    this.audioContext = null;
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    this.chunks = [];
    this.peakRms = 0;
    this.intervalId = null;
  }

  start(stream) {
    this.stop();

    const track = stream?.getAudioTracks()[0];
    if (!track?.enabled) return;

    const audioStream = new MediaStream([track]);
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    this.audioContext = new AudioCtx();
    this.source = this.audioContext.createMediaStreamSource(audioStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0;

    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      if (rms > this.peakRms) this.peakRms = rms;
      this.chunks.push(new Float32Array(input));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioContext.destination);

    this.intervalId = setInterval(() => this.flush(), this.intervalMs);

    if (this.audioContext.state === "suspended") {
      this.audioContext.resume().catch(() => {});
    }
  }

  flush() {
    if (!this.chunks.length || !this.audioContext) return;

    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) {
      merged.set(c, off);
      off += c.length;
    }
    this.chunks = [];

    const rms = this.peakRms;
    this.peakRms = 0;
    if (rms < VAD_THRESHOLD) return;

    const downsampled = downsample(merged, this.audioContext.sampleRate, TARGET_SAMPLE_RATE);
    const wav = encodeWAV(downsampled, TARGET_SAMPLE_RATE);
    this.onChunk(wav);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try { this.processor.disconnect(); } catch (_) {}
      this.processor = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch (_) {}
      this.source = null;
    }
    if (this.silentGain) {
      try { this.silentGain.disconnect(); } catch (_) {}
      this.silentGain = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.chunks = [];
    this.peakRms = 0;
  }
}
