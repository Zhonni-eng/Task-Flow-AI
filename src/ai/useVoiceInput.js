// Voice input for the assistant's message box: record with the microphone, have the main process
// transcribe it (OpenAI), and hand the text to `onText` - which only inserts it into the box.
// Nothing is sent or applied here.
import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeAudio } from './aiSettingsClient.js';

export const MAX_RECORDING_SECONDS = 120;
const MIN_RECORDING_MS = 400;
const MIN_AUDIO_BYTES = 1000;
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

/** App error code for a getUserMedia failure. */
function micErrorCode(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'MIC_DENIED';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'NO_MIC';
    case 'NotReadableError':
      return 'MIC_BUSY';
    default:
      return 'MIC_ERROR';
  }
}

/** state: 'idle' | 'recording' | 'transcribing'; error: a code or null; seconds: recording time. */
export function useVoiceInput({ onText }) {
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  const [seconds, setSeconds] = useState(0);
  const session = useRef(null); // { recorder, stream, chunks, startedAt, timer, cancelled }
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const release = (current) => {
    clearInterval(current.timer);
    current.stream.getTracks().forEach((track) => track.stop());
  };

  const start = useCallback(async () => {
    if (session.current) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('MIC_ERROR');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (failure) {
      setError(micErrorCode(failure));
      return;
    }
    const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const current = { recorder, stream, chunks: [], startedAt: Date.now(), timer: null, cancelled: false };
    session.current = current;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size > 0) current.chunks.push(event.data);
    });
    recorder.addEventListener('stop', async () => {
      release(current);
      session.current = null;
      if (current.cancelled) {
        setState('idle');
        return;
      }
      const blob = new Blob(current.chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      if (Date.now() - current.startedAt < MIN_RECORDING_MS || blob.size < MIN_AUDIO_BYTES) {
        setState('idle');
        setError('EMPTY_RECORDING');
        return;
      }
      setState('transcribing');
      const result = await transcribeAudio({ audio: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type });
      setState('idle');
      if (result.ok) onTextRef.current(result.text);
      else setError(result.code);
    });
    current.timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - current.startedAt) / 1000);
      setSeconds(elapsed);
      // A forgotten recording stops by itself.
      if (elapsed >= MAX_RECORDING_SECONDS && recorder.state === 'recording') recorder.stop();
    }, 250);
    setSeconds(0);
    setState('recording');
    recorder.start();
  }, []);

  const stop = useCallback(() => {
    if (session.current?.recorder.state === 'recording') session.current.recorder.stop();
  }, []);

  const toggle = useCallback(() => (session.current ? stop() : start()), [start, stop]);

  // Closing the panel ends a recording without transcribing it.
  useEffect(
    () => () => {
      const current = session.current;
      if (!current) return;
      current.cancelled = true;
      if (current.recorder.state === 'recording') current.recorder.stop();
      else release(current);
    },
    [],
  );

  return { state, error, seconds, toggle, clearError: () => setError(null) };
}

/**
 * The message box text with `insert` placed at the selection [start, end] (replacing a selected
 * part), with a space where words would otherwise run together. Returns { value, caret, truncated }.
 */
export function insertAtSelection(value, insert, start, end, maxLength) {
  const from = Math.max(0, Math.min(start ?? value.length, value.length));
  const to = Math.max(from, Math.min(end ?? from, value.length));
  const before = value.slice(0, from);
  const after = value.slice(to);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^[\s.,!?;:)]/.test(after) ? ' ' : '';
  const room = Math.max(0, maxLength - before.length - after.length - lead.length - trail.length);
  const text = insert.slice(0, room);
  return { value: `${before}${lead}${text}${trail}${after}`, caret: before.length + lead.length + text.length, truncated: text.length < insert.length };
}
