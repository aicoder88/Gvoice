// AudioWorklet that captures mono mic input, downsamples to outputRate,
// converts to 16-bit PCM, and posts batches back to the main thread.
//
// Worklets cannot import — `downsample` and `floatTo16BitPcm` are duplicated
// here from public/realtime-voice-agent/audio-utils.js by design.

const DEFAULT_BATCH_SIZE = 4096;
const DEFAULT_INPUT_GAIN = 2.5;

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.outputRate = opts.outputRate;
    this.batchSize = opts.batchSize || DEFAULT_BATCH_SIZE;
    // Input gain boost applied before downsample/quantize so quiet/distant
    // speakers cross Deepgram's energy threshold. Soft-clipped to avoid
    // hard-clipping artifacts on loud syllables/plosives.
    const rawGain = Number(opts.inputGain);
    this.inputGain = Number.isFinite(rawGain) && rawGain > 0 ? rawGain : DEFAULT_INPUT_GAIN;
    // Precompute tanh(gain) so the per-sample soft-clip is one Math.tanh + one
    // multiply (no branches). Formula: y = tanh(gain*x) / tanh(gain) — smooth,
    // shape-preserving, asymptotes to ±1.0 so quantizer never hard-clips.
    this.softClipNorm = 1 / Math.tanh(this.inputGain);
    this.buffer = new Float32Array(this.batchSize);
    this.bufferIndex = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type !== "flush") return;
      // MessagePort preserves order: the partial PCM batch arrives before its
      // acknowledgement, so the renderer can commit without guessing delivery.
      this.flush(true);
      this.port.postMessage({ type: "flushed", requestId: data.requestId });
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    const gain = this.inputGain;
    const norm = this.softClipNorm;

    for (let i = 0; i < channel.length; i += 1) {
      // Branchless soft-clip: tanh saturates smoothly, norm rescales so |y|<=1.
      this.buffer[this.bufferIndex++] = Math.tanh(gain * channel[i]) * norm;
      if (this.bufferIndex >= this.batchSize) {
        this.flush();
      }
    }

    return true;
  }

  flush(final = false) {
    if (!this.bufferIndex) return;
    let peak = 0;
    for (let i = 0; i < this.bufferIndex; i += 1) {
      const a = Math.abs(this.buffer[i]);
      if (a > peak) peak = a;
    }

    const slice = this.buffer.subarray(0, this.bufferIndex);
    const downsampled = downsample(slice, sampleRate, this.outputRate, final);
    const pcm16 = floatTo16BitPcm(downsampled);
    this.port.postMessage({ pcm16: pcm16.buffer, peak }, [pcm16.buffer]);
    this.bufferIndex = 0;
  }
}

function downsample(input, inputRate, outputRate, final = false) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  // A final partial batch includes its last available sampling point. Regular
  // batches keep the existing conversion for engines that do not request flush.
  const length = final ? Math.ceil(input.length / ratio) : Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    output[i] = input[Math.floor(i * ratio)];
  }
  return output;
}

function floatTo16BitPcm(float32Array) {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return pcm16;
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
