// Voice mode: the browser side of a GPT-Live session. The server creates the session (it holds
// the key) and answers our WebRTC offer; audio flows on media tracks and JSON events on the
// "oai-events" data channel. The backend model asks for tools; the page runs them and the
// result goes back to be spoken.
import type { VoiceProof } from "@nilo/core";
import { useEffect, useRef, useState } from "react";

export type VoiceState = "idle" | "connecting" | "live" | "closing";

export interface VoiceHandlers {
  /** Runs a tool the backend asked for; the returned text goes back to the conversation. */
  onToolCall: (name: string, args: unknown) => Promise<string>;
  /** A finished turn of speech, for the chat log. */
  onTranscript: (role: "user" | "assistant", text: string) => void;
  onError: (message: string) => void;
}

/** Hang up on our own after this long: an open session is billed by the second. */
const MAX_SESSION_MS = 5 * 60_000;
const ICE_TIMEOUT_MS = 10_000;
/** How long to wait for session.closed (final usage) before tearing down anyway. */
const CLOSE_TIMEOUT_MS = 15_000;

export interface VoiceLevels {
  /** Loudness of the microphone, 0 to 1. */
  mic: number;
  /** Loudness of the assistant's speech, 0 to 1. */
  out: number;
}

/** Root mean square of the analyser's current waveform, 0 to 1. */
function rms(analyser: AnalyserNode | null, buf: Uint8Array<ArrayBuffer>): number {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += ((v - 128) / 128) ** 2;
  return Math.sqrt(sum / buf.length);
}

export function useVoiceSession(handlers: VoiceHandlers) {
  const [state, setState] = useState<VoiceState>("idle");
  const h = useRef(handlers);
  h.current = handlers;
  const teardown = useRef<(() => void) | null>(null);
  const hangup = useRef<(() => void) | null>(null);
  /** Sends a client event on the open session's data channel; null while there is none. */
  const sender = useRef<((event: object) => boolean) | null>(null);
  /** Read-only taps on the two audio streams, for the level meter. Not connected to the speakers. */
  const meters = useRef<{ mic: AnalyserNode | null; out: AnalyserNode | null }>({ mic: null, out: null });
  const buf = useRef(new Uint8Array(256));

  useEffect(() => () => teardown.current?.(), []);

  /** `getProof` may ask the wallet to sign; it runs after the click's audio setup, before the microphone. */
  async function start(getProof: () => Promise<VoiceProof>) {
    // A session already starting or running (checked on the ref, not the state, so a double click can't open two).
    if (teardown.current) return;
    setState("connecting");
    const pc = new RTCPeerConnection();
    const audio = new Audio();
    audio.autoplay = true;
    // Created inside the click so the browser lets it run.
    const ctx = new AudioContext();
    const tap = (stream: MediaStream) => {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      return analyser;
    };
    let mic: MediaStream | null = null;
    let dc: RTCDataChannel | null = null;
    const timers: number[] = [];
    let done = false;
    /** The server has asked OpenAI for the session: from here it may exist, and is billed until closed. */
    let requested = false;
    /** The user hung up before the session started: close it as soon as it does. */
    let closeOnStart = false;

    const send = (event: object) => {
      if (dc?.readyState !== "open") return false;
      dc.send(JSON.stringify(event));
      return true;
    };
    const cleanup = () => {
      if (done) return;
      done = true;
      window.removeEventListener("pagehide", onPageHide);
      timers.forEach(clearTimeout);
      mic?.getTracks().forEach((t) => t.stop());
      pc.close();
      audio.srcObject = null;
      meters.current = { mic: null, out: null };
      ctx.close().catch(() => {});
      teardown.current = hangup.current = sender.current = null;
      setState("idle");
    };
    /** Leaving (unmount, other page): ask OpenAI to close, give the message a moment to go out, then drop the connection. */
    const abandon = () => {
      if (send({ type: "session.close" })) timers.push(window.setTimeout(cleanup, 300));
      else cleanup();
    };
    /** Closing the tab: there is no time to wait, but the close request can still go out. */
    const onPageHide = () => send({ type: "session.close" });
    window.addEventListener("pagehide", onPageHide);
    teardown.current = abandon;
    sender.current = send;
    hangup.current = () => {
      setState("closing");
      if (send({ type: "session.close" })) {
        // OpenAI answers with session.closed (and the final usage); don't wait forever for it.
        timers.push(window.setTimeout(cleanup, CLOSE_TIMEOUT_MS));
      } else if (requested) {
        // Still connecting, but OpenAI may already have the session: finish connecting only to close it,
        // rather than leave it open until it times out.
        closeOnStart = true;
        timers.push(window.setTimeout(cleanup, CLOSE_TIMEOUT_MS));
      } else {
        cleanup();
      }
    };

    try {
      const proof = await getProof();
      if (done) return;
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach((t) => pc.addTrack(t, mic!));
      meters.current.mic = tap(mic);
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        audio.srcObject = stream;
        audio.play().catch(() => {});
        if (!done) meters.current.out = tap(stream);
      };
      // The channel has to exist before the offer so it is negotiated with it.
      dc = pc.createDataChannel("oai-events");
      listen(dc, send, cleanup, () => {
        if (closeOnStart) send({ type: "session.close" });
        else setState("live");
      });

      await pc.setLocalDescription(await pc.createOffer());
      await iceGathered(pc);
      if (done || closeOnStart) return cleanup();
      requested = true;
      const res = await fetch("/api/voice/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: pc.localDescription!.sdp, proof }),
      });
      const body = (await res.json().catch(() => ({}))) as { sdp?: string; message?: string };
      if (!res.ok || !body.sdp) throw new Error(body.message ?? "Voice mode is unavailable right now.");
      if (done) return;
      // Connected even if the user hung up meanwhile: session.started then sends the close.
      await pc.setRemoteDescription({ type: "answer", sdp: body.sdp });
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") cleanup();
      };
      timers.push(window.setTimeout(() => hangup.current?.(), MAX_SESSION_MS));
    } catch (e) {
      const err = e as Error;
      // Nothing to report when the user had already hung up.
      if (!closeOnStart && !done) h.current.onError(
        err.name === "NotAllowedError" ? "Voice mode needs the microphone. Allow it in your browser and try again." : err.message,
      );
      cleanup();
    }
  }

  function listen(dc: RTCDataChannel, send: (e: object) => boolean, cleanup: () => void, onStarted: () => void) {
    // Speech arrives as transcript fragments; a turn ends when the other side starts speaking.
    let turn: { role: "user" | "assistant"; text: string } | null = null;
    const flush = () => {
      if (turn?.text.trim()) h.current.onTranscript(turn.role, turn.text.trim());
      turn = null;
    };
    const hear = (role: "user" | "assistant", delta: string) => {
      if (turn?.role !== role) flush();
      turn ??= { role, text: "" };
      turn.text += delta;
    };

    dc.onmessage = async (msg) => {
      let event: { type?: string; [k: string]: unknown };
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }
      switch (event.type) {
        case "session.started":
          onStarted();
          break;
        case "session.input_transcript.delta":
          hear("user", String(event.delta ?? ""));
          break;
        case "session.output_transcript.delta":
          hear("assistant", String(event.delta ?? ""));
          break;
        case "response.event": {
          const inner = event.event as { type?: string; item?: { type?: string; call_id?: string; name?: string; arguments?: string } };
          if (inner?.type !== "response.output_item.done" || inner.item?.type !== "function_call") break;
          flush();
          const { call_id, name = "", arguments: raw = "{}" } = inner.item;
          let output: string;
          try {
            output = await h.current.onToolCall(name, JSON.parse(raw));
          } catch (e) {
            output = `Error: ${(e as Error).message}`;
          }
          send({ type: "response.item.create", item: { type: "function_call_output", call_id, output } });
          send({ type: "response.create" });
          break;
        }
        case "error": {
          const error = event.error as { code?: string; message?: string } | undefined;
          console.warn("voice session error:", error);
          break;
        }
        case "session.closed":
          flush();
          console.info("voice session closed:", event.reason, event.usage);
          if (event.reason === "expired") h.current.onError("The voice session reached its time limit.");
          else if (event.reason === "connection_lost") h.current.onError("The voice connection dropped. Try again.");
          else if (event.reason === "content") h.current.onError("The voice session was ended by a safety filter.");
          cleanup();
          break;
      }
    };
    dc.onclose = () => {
      flush();
      cleanup();
    };
  }

  return {
    state,
    start,
    stop: () => (hangup.current ?? teardown.current)?.(),
    /**
     * Tells the backend what happened on screen (a review signed or cancelled) and asks it to
     * respond, so the voice says it. Does nothing without an open session.
     */
    notify: (text: string) => {
      if (sender.current?.({ type: "response.item.create", item: { type: "message", role: "developer", content: text } })) {
        sender.current({ type: "response.create" });
      }
    },
    levels: (): VoiceLevels => ({ mic: rms(meters.current.mic, buf.current), out: rms(meters.current.out, buf.current) }),
    /** Fills `into` with the frequency spectrum of one side (128 bins, 0 to 255); false before it has audio. */
    spectrum: (side: "mic" | "out", into: Uint8Array<ArrayBuffer>): boolean => {
      const analyser = meters.current[side];
      if (!analyser) return false;
      analyser.getByteFrequencyData(into);
      return true;
    },
  };
}

function iceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ICE_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      resolve();
    });
  });
}
