"use client";

import { LoaderCircle, Mic, Pause, Play, RotateCcw, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { API_URL, MAX_SECONDS, RecordingSession, type Clip } from "./recording";
import { Waveform } from "./waveform";

type Phase = "idle" | "starting" | "recording" | "stopping" | "review";
type PlaybackLink = { audioUrl: string; expiresAt: string };
type Message = {
  id: string;
  text: string;
  clip: Clip | null;
  link?: PlaybackLink;
  error?: string;
};

function timeLabel(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function MessageAudio({ link }: { link: PlaybackLink }) {
  const player = useRef<HTMLAudioElement>(null);
  const [expired, setExpired] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const delay = new Date(link.expiresAt).getTime() - Date.now();
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, delay));
    return () => window.clearTimeout(timer);
  }, [link.expiresAt]);

  async function togglePlayback() {
    const audio = player.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (audio.error) audio.load();
    setFailed(false);
    try {
      await audio.play();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
    }
  }

  if (expired) return <p className="attachment-status" role="status">Recording link expired.</p>;

  return (
    <div className="message-audio">
      <div className="message-audio-actions">
        <button className="message-play" type="button" onClick={togglePlayback}>
          <span className={playing ? "icon-pause" : "icon-play"} aria-hidden="true" />
          {playing ? "Pause" : "Play"}
        </button>
        <a className="recording-link" href={link.audioUrl} target="_blank" rel="noreferrer">
          <span className="icon-external" aria-hidden="true" />
          Open recording
        </a>
      </div>
      <audio
        ref={player}
        hidden
        preload="none"
        src={link.audioUrl}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          setFailed(true);
        }}
      />
      {failed && <p className="attachment-status" role="alert">Could not play the recording.</p>}
    </div>
  );
}

export default function VoiceResponses() {
  const session = useRef<RecordingSession | null>(null);
  const previewUrl = useRef("");
  const player = useRef<HTMLAudioElement>(null);
  const activeUploads = useRef(new Map<string, AbortController>());
  const [phase, setPhase] = useState<Phase>("idle");
  const [startedAt, setStartedAt] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode>();
  const [remaining, setRemaining] = useState(MAX_SECONDS);
  const [clip, setClip] = useState<Clip | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [transcriptionError, setTranscriptionError] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    const uploads = activeUploads.current;
    return () => {
      session.current?.dispose();
      URL.revokeObjectURL(previewUrl.current);
      for (const request of uploads.values()) request.abort();
    };
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => {
      const elapsed = (performance.now() - startedAt) / 1000;
      setRemaining(Math.max(0, Math.ceil(MAX_SECONDS - elapsed)));
    }, 100);
    return () => window.clearInterval(timer);
  }, [phase, startedAt]);

  function clearTake() {
    session.current?.dispose();
    session.current = null;
    player.current?.pause();
    player.current?.removeAttribute("src");
    player.current?.load();
    URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = "";
    setClip(null);
    setAnalyser(undefined);
    setTranscript(null);
    setTranscriptionError("");
    setError("");
    setPlaying(false);
  }

  function start() {
    clearTake();
    setRemaining(MAX_SECONDS);
    setPhase("starting");

    const recording = new RecordingSession({
      started(inputAnalyser) {
        if (session.current !== recording) return;
        setAnalyser(inputAnalyser);
        setStartedAt(performance.now());
        setPhase("recording");
      },
      stopped(result) {
        if (session.current !== recording) return;
        if (!result) {
          clearTake();
          setError("No audio was captured. Try recording again.");
          setPhase("idle");
          return;
        }
        previewUrl.current = URL.createObjectURL(result.blob);
        setAnalyser(undefined);
        setClip(result);
        setPhase("review");
      },
      transcript(text) {
        if (session.current === recording) setTranscript(text);
      },
      transcriptionFailed(message) {
        if (session.current === recording) setTranscriptionError(message);
      },
      captureFailed(message) {
        if (session.current !== recording) return;
        clearTake();
        setError(message);
        setPhase("idle");
      },
    });
    session.current = recording;
    void recording.start();
  }

  function stop() {
    setPhase("stopping");
    session.current?.stop();
  }

  async function play() {
    const audio = player.current;
    if (!audio || !previewUrl.current) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (audio.getAttribute("src") !== previewUrl.current) audio.src = previewUrl.current;
    try {
      await audio.play();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError("Could not play the draft. Try again.");
    }
  }

  async function upload(id: string, recording: Clip) {
    if (activeUploads.current.has(id)) return;
    const request = new AbortController();
    activeUploads.current.set(id, request);
    setMessages((items) => items.map((item) => item.id === id ? { ...item, error: undefined } : item));
    try {
      const response = await fetch(`${API_URL}/api/recordings/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "audio/wav" },
        body: recording.blob,
        signal: request.signal,
      });
      const result = await response.json();
      if (!response.ok) {
        const message = typeof result.detail === "string"
          ? result.detail
          : "The recording could not be saved.";
        throw new Error(message);
      }
      setMessages((items) => items.map((item) => item.id === id
        ? { ...item, clip: null, link: result as PlaybackLink }
        : item));
    } catch (error) {
      if (request.signal.aborted) return;
      const message = error instanceof Error && !(error instanceof TypeError)
        ? error.message
        : "Could not reach recording storage. Try again.";
      setMessages((items) => items.map((item) => item.id === id ? { ...item, error: message } : item));
    } finally {
      activeUploads.current.delete(id);
    }
  }

  function send() {
    if (!session.current || !clip || transcript === null) return;
    const id = crypto.randomUUID();
    const text = transcript || "No speech detected";
    setMessages((items) => [...items, { id, text, clip }]);
    clearTake();
    setPhase("idle");
    void upload(id, clip);
  }

  const recording = phase === "recording";
  const review = phase === "review";
  const transcribing = review && transcript === null && !transcriptionError;
  const starting = phase === "starting";
  const stopping = phase === "stopping";
  const orbLabel = recording || stopping ? "Stop" : "Record voice";
  const status = {
    idle: "",
    starting: "Connecting to your microphone…",
    recording: "Recording",
    stopping: "Finishing recording…",
    review: clip ? `Recorded ${timeLabel(clip.duration)}` : "",
  }[phase];

  return (
    <main className="canvas">
      <h1>Naveed voice demo</h1>
      <ol className="messages" aria-label="Sent voice responses">
        {messages.map((message) => (
          <li className="message" key={message.id}>
            <div className="bubble">
              <p className="message-text">{message.text}</p>
              {message.link ? <MessageAudio link={message.link} /> : (
                <>
                  <p className="attachment-status" role={message.error ? "alert" : "status"}>
                    {message.error || "Saving recording…"}
                  </p>
                  {message.error && message.clip && (
                    <button type="button" onClick={() => {
                      if (message.clip) void upload(message.id, message.clip);
                    }}>Retry upload</button>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>

      <section className="composer" aria-label="Voice recorder">
        {!review && (
          <div className="orb-control">
            <button
              className="orb-button"
              type="button"
              onClick={recording ? stop : start}
              disabled={starting || stopping}
            >
              <span className={recording || stopping ? "orb orb-recording" : "orb"}>
                {recording || stopping
                  ? <Waveform analyser={recording ? analyser : undefined} />
                  : <Mic size={28} aria-hidden="true" />}
              </span>
              {orbLabel}
            </button>
          </div>
        )}
        <p className="status" role="status">
          {status}
          {transcribing && (
            <span className="transcription-status">
              <LoaderCircle className="transcription-spinner" size={16} aria-hidden="true" />
              Preparing transcript…
            </span>
          )}
        </p>
        {recording && <span className="countdown" aria-label="Time remaining">{timeLabel(remaining)}</span>}
        {(transcriptionError || error) && <p className="error" role="alert">{transcriptionError || error}</p>}
        {review && (
          <div className="actions">
            <button className="review-action" type="button" onClick={play}>
              {playing
                ? <Pause size={16} fill="currentColor" aria-hidden="true" />
                : <Play size={16} fill="currentColor" aria-hidden="true" />}
              {playing ? "Pause" : "Play"}
            </button>
            <button className="review-action" type="button" onClick={start}>
              <RotateCcw size={16} aria-hidden="true" />
              Record again
            </button>
            <button className="review-action send-action" type="button" onClick={send} disabled={transcript === null}>
              <Send size={16} aria-hidden="true" />
              Send
            </button>
          </div>
        )}
        <audio
          ref={player}
          hidden
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      </section>
    </main>
  );
}
