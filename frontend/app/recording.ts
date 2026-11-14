export const MAX_SECONDS = 90;
const SAMPLE_RATE = 24_000;
const WAV_HEADER_BYTES = 44;
const MAX_SOCKET_BUFFER = 512 * 1024;

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

export type Clip = {
  blob: Blob;
  duration: number;
};

type RecordingEvents = {
  started: (analyser: AnalyserNode) => void;
  stopped: (clip: Clip | null) => void;
  transcript: (text: string) => void;
  transcriptionFailed: (message: string) => void;
  captureFailed: (message: string) => void;
};

function makeWav(chunks: ArrayBuffer[]): Clip {
  const bytes = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const header = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(header);
  view.setUint32(0, 0x52494646); // RIFF
  view.setUint32(4, bytes + 36, true);
  view.setUint32(8, 0x57415645); // WAVE
  view.setUint32(12, 0x666d7420); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461); // data
  view.setUint32(40, bytes, true);
  return {
    blob: new Blob([header, ...chunks], { type: "audio/wav" }),
    duration: bytes / (SAMPLE_RATE * 2),
  };
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone access was denied. Allow access in your browser and try again.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "No microphone was found.";
  }
  return "Could not start the microphone. Check that it is available and try again.";
}

export class RecordingSession {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private analyser?: AnalyserNode;
  private worklet?: AudioWorkletNode;
  private socket?: WebSocket;
  private chunks: ArrayBuffer[] = [];
  private sentChunks = 0;
  private socketReady = false;
  private stopSent = false;
  private captureFinished = false;
  private closed = false;
  private autoStopTimer?: number;
  private flushTimer?: number;
  private socketTimer?: number;

  constructor(private readonly events: RecordingEvents) {}

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      this.events.captureFailed("Microphone recording requires a supported browser on HTTPS or localhost.");
      return;
    }

    try {
      // Resume in the button's activation handler for browsers with an autoplay policy.
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.context = context;
      const resume = context.resume();
      void resume.catch(() => {});
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      if (this.closed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      await resume;
      await context.audioWorklet.addModule("/pcm-recorder.js");
      if (this.closed) return;

      this.source = context.createMediaStreamSource(stream);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 512;
      this.source.connect(this.analyser);
      this.worklet = new AudioWorkletNode(context, "pcm-recorder", {
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { maxSamples: SAMPLE_RATE * MAX_SECONDS },
      });
      this.worklet.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | "stopped">) => {
        if (this.closed || this.captureFinished) return;
        if (data === "stopped") {
          this.finishCapture();
        } else {
          this.chunks.push(data);
          this.sendQueuedAudio();
        }
      };
      this.worklet.onprocessorerror = () => {
        this.failTranscription("The microphone stopped unexpectedly. Record again to retry.");
        this.finishCapture();
      };
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener("ended", () => this.stop(), { once: true });
      });

      this.connectTranscription();
      this.worklet.connect(context.destination); // The worklet emits silence.
      this.source.connect(this.worklet);
      this.autoStopTimer = window.setTimeout(() => this.stop(), MAX_SECONDS * 1000);
      this.events.started(this.analyser);
    } catch (error) {
      if (!this.closed) {
        this.dispose();
        this.events.captureFailed(microphoneError(error));
      }
    }
  }

  stop() {
    if (!this.worklet || this.captureFinished || this.flushTimer !== undefined) return;
    this.worklet.port.postMessage("stop");
    // A suspended audio context may be unable to acknowledge Stop.
    this.flushTimer = window.setTimeout(() => this.finishCapture(), 300);
  }

  dispose() {
    this.closed = true;
    this.closeTranscription();
    this.releaseMicrophone();
    this.chunks = [];
  }

  private finishCapture() {
    if (this.captureFinished || this.closed) return;
    this.captureFinished = true;
    this.releaseMicrophone();
    const clip = this.chunks.length ? makeWav(this.chunks) : null;
    this.events.stopped(clip);
    if (!clip) {
      this.closeTranscription();
      return;
    }
    this.sendQueuedAudio();
    this.releaseSentAudio();
  }

  private releaseMicrophone() {
    window.clearTimeout(this.autoStopTimer);
    window.clearTimeout(this.flushTimer);
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.worklet?.disconnect();
    this.worklet?.port.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") {
      void this.context.close().catch(() => {});
    }
    this.source = undefined;
    this.analyser = undefined;
    this.worklet = undefined;
    this.stream = undefined;
    this.context = undefined;
  }

  private connectTranscription() {
    try {
      const url = new URL(`${API_URL}/api/transcription`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      this.socket = socket;
      const disconnected = () => {
        this.failTranscription("The transcription connection was interrupted. Record again to retry.");
      };
      this.socketTimer = window.setTimeout(disconnected, 28_000);
      socket.onclose = disconnected;
      socket.onerror = disconnected;
      socket.onmessage = ({ data }: MessageEvent<string>) => {
        const event = JSON.parse(data);
        if (event.type === "ready") {
          window.clearTimeout(this.socketTimer);
          this.socketReady = true;
          this.sendQueuedAudio();
        } else if (event.type === "transcript") {
          this.closeTranscription();
          this.events.transcript(event.text);
        } else if (event.type === "error") {
          this.failTranscription(event.message);
        }
      };
    } catch {
      this.events.transcriptionFailed("Could not connect to live transcription. Record again to retry.");
    }
  }

  private sendQueuedAudio() {
    const socket = this.socket;
    if (!socket || !this.socketReady || socket.readyState !== WebSocket.OPEN || this.stopSent) return;
    while (this.sentChunks < this.chunks.length) {
      if (socket.bufferedAmount > MAX_SOCKET_BUFFER) {
        this.failTranscription("The transcription connection is too slow. Record again to retry.");
        return;
      }
      socket.send(this.chunks[this.sentChunks]);
      this.sentChunks += 1;
    }
    if (this.captureFinished) {
      socket.send("stop");
      this.stopSent = true;
      this.releaseSentAudio();
      this.socketTimer = window.setTimeout(() => {
        this.failTranscription("Transcription took too long. Record again to retry.");
      }, 30_000);
    }
  }

  private releaseSentAudio() {
    if (this.captureFinished && (this.stopSent || !this.socket)) this.chunks = [];
  }

  private failTranscription(message: string) {
    if (!this.socket) return;
    this.closeTranscription();
    this.events.transcriptionFailed(message);
  }

  private closeTranscription() {
    window.clearTimeout(this.socketTimer);
    const socket = this.socket;
    this.socket = undefined;
    this.releaseSentAudio();
    if (!socket) return;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
  }
}
