// AudioContext resamples the microphone to 24 kHz before calling this processor.
class PcmRecorder extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.remaining = processorOptions.maxSamples;
    this.chunk = new ArrayBuffer(sampleRate / 10 * 2);
    this.view = new DataView(this.chunk);
    this.bytes = 0;
    this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (data === "stop") this.finish();
    };
  }

  flush() {
    if (!this.bytes) return;
    const pcm = this.bytes === this.chunk.byteLength
      ? this.chunk
      : this.chunk.slice(0, this.bytes);
    this.port.postMessage(pcm, [pcm]);
    this.chunk = new ArrayBuffer(sampleRate / 10 * 2);
    this.view = new DataView(this.chunk);
    this.bytes = 0;
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.flush();
    this.port.postMessage("stopped");
  }

  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0][0];
    if (!input) return true;

    const count = Math.min(input.length, this.remaining);
    for (let index = 0; index < count; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[index]));
      this.view.setInt16(this.bytes, sample * (sample < 0 ? 32768 : 32767), true);
      this.bytes += 2;
      if (this.bytes === this.chunk.byteLength) this.flush();
    }
    this.remaining -= count;
    if (!this.remaining) this.finish();
    return !this.finished;
  }
}

registerProcessor("pcm-recorder", PcmRecorder);
