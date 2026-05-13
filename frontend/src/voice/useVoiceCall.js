import { useCallback, useEffect, useRef, useState } from 'react';

const VOICES = ['female', 'male'];
// Language is locked to Hinglish (en-IN). en-IN handles English with an Indian
// accent and code-mixed Hindi-English speech better than hi-IN, which expects
// pure Hindi script.
const HINGLISH_LANG = 'en-IN';
const SILENCE_MS = 1200;
const RING_MS = 3000;

function getRecognition() {
  if (typeof window === 'undefined') return null;
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export function useVoiceCall({ onTurn, authedFetch }) {
  const doFetch = authedFetch || fetch;
  const [status, setStatus] = useState('idle'); // idle | ringing | listening | thinking | speaking | error
  const [transcript, setTranscript] = useState('');
  const [muted, setMuted] = useState(false);
  const [voice, setVoice] = useState('female');
  const [lang] = useState(HINGLISH_LANG);
  const [level, setLevel] = useState(0);
  const [hearingSpeech, setHearingSpeech] = useState(false);
  const [error, setError] = useState(null);
  const [usingFallbackVoice, setUsingFallbackVoice] = useState(false);
  const [duration, setDuration] = useState(0); // seconds since the call connected

  const recognitionRef = useRef(null);
  const audioRef = useRef(null);
  const audioUrlRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const finalTextRef = useRef('');
  const interimTextRef = useRef('');
  const abortRef = useRef(null);
  const mutedRef = useRef(false);
  const statusRef = useRef('idle');
  const onTurnRef = useRef(onTurn);
  const desiredListeningRef = useRef(false);
  const langRef = useRef(HINGLISH_LANG);
  const ringTimerRef = useRef(null);
  const durationTimerRef = useRef(null);
  const ringToneRef = useRef(null);

  // mic level meter
  const micStreamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    onTurnRef.current = onTurn;
  }, [onTurn]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  const setStatusBoth = useCallback((s) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setLevel(0);
  }, []);

  const clearAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const stopRecognition = useCallback(() => {
    const r = recognitionRef.current;
    if (!r) return;
    try {
      r.onresult = null;
      r.onerror = null;
      r.onend = null;
      r.onaudiostart = null;
      r.onspeechstart = null;
      r.onspeechend = null;
      r.stop();
    } catch {}
    recognitionRef.current = null;
    setHearingSpeech(false);
  }, []);

  const scheduleFinalize = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      finalize();
    }, SILENCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRecognition = useCallback(() => {
    if (recognitionRef.current) return;
    const r = getRecognition();
    if (!r) {
      setError('unsupported');
      setStatusBoth('error');
      return;
    }
    r.continuous = true;
    r.interimResults = true;
    r.lang = langRef.current;
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      if (mutedRef.current) return;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          finalTextRef.current += res[0].transcript + ' ';
        } else {
          interim += res[0].transcript;
        }
      }
      interimTextRef.current = interim;
      setTranscript((finalTextRef.current + interim).trim());
      scheduleFinalize();
    };

    r.onerror = (event) => {
      const code = event.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setError('mic-permission');
        setStatusBoth('error');
        return;
      }
      if (code === 'language-not-supported' || code === 'bad-grammar') {
        setError(`lang-${code}`);
        return;
      }
      if (code === 'network') {
        setError('network');
        return;
      }
      // 'no-speech' / 'aborted' / 'audio-capture' are mostly recoverable
    };

    r.onspeechstart = () => setHearingSpeech(true);
    r.onspeechend = () => setHearingSpeech(false);

    r.onend = () => {
      // Auto-restart if we're supposed to be listening but recognition ended on its own
      if (desiredListeningRef.current && statusRef.current === 'listening') {
        try {
          const next = getRecognition();
          if (!next) return;
          next.continuous = true;
          next.interimResults = true;
          next.lang = langRef.current;
          next.maxAlternatives = 1;
          next.onresult = r.onresult;
          next.onerror = r.onerror;
          next.onspeechstart = r.onspeechstart;
          next.onspeechend = r.onspeechend;
          next.onend = r.onend;
          recognitionRef.current = next;
          next.start();
        } catch {}
      }
    };

    try {
      r.start();
      recognitionRef.current = r;
    } catch {
      recognitionRef.current = r;
    }
  }, [setStatusBoth, scheduleFinalize]);

  const speakText = useCallback(
    async (text) => {
      if (!text) return;
      setStatusBoth('speaking');
      desiredListeningRef.current = false;
      stopRecognition();

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const r = await doFetch('/api/voice/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice, lang: langRef.current }),
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`tts http ${r.status}`);
        const blob = await r.blob();
        if (!blob || blob.size < 100) throw new Error('tts empty');
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        setUsingFallbackVoice(false);
        await new Promise((resolve) => {
          audio.onended = resolve;
          audio.onerror = resolve;
          audio.play().catch(resolve);
        });
      } catch {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          setUsingFallbackVoice(true);
          await new Promise((resolve) => {
            const utter = new SpeechSynthesisUtterance(text);
            utter.lang = langRef.current;
            utter.onend = resolve;
            utter.onerror = resolve;
            // pick a matching voice if available
            const voices = window.speechSynthesis.getVoices();
            const match =
              voices.find((v) => v.lang === langRef.current) ||
              voices.find((v) => v.lang?.startsWith(langRef.current.split('-')[0]));
            if (match) utter.voice = match;
            window.speechSynthesis.speak(utter);
          });
        }
      } finally {
        abortRef.current = null;
        clearAudio();
      }

      if (desiredListeningRef.current === false && statusRef.current === 'speaking') {
        finalTextRef.current = '';
        interimTextRef.current = '';
        setTranscript('');
        desiredListeningRef.current = true;
        setStatusBoth('listening');
        startRecognition();
      }
    },
    [voice, setStatusBoth, stopRecognition, startRecognition, clearAudio]
  );

  const finalize = useCallback(async () => {
    const text = (finalTextRef.current + interimTextRef.current).trim();
    if (!text) return;
    if (statusRef.current !== 'listening') return;
    setStatusBoth('thinking');
    desiredListeningRef.current = false;
    stopRecognition();
    finalTextRef.current = '';
    interimTextRef.current = '';

    try {
      const reply = await onTurnRef.current?.(text);
      if (typeof reply === 'string' && reply.trim()) {
        await speakText(reply);
      } else {
        if (statusRef.current === 'thinking') {
          desiredListeningRef.current = true;
          setStatusBoth('listening');
          setTranscript('');
          startRecognition();
        }
      }
    } catch {
      if (statusRef.current === 'thinking') {
        desiredListeningRef.current = true;
        setStatusBoth('listening');
        setTranscript('');
        startRecognition();
      }
    }
  }, [setStatusBoth, stopRecognition, startRecognition, speakText]);

  // soft synthesised phone-ring used during the 3s "ringing" phase
  const playRingTone = useCallback(() => {
    if (typeof window === 'undefined') return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    let ctx;
    try {
      ctx = new Ctx();
    } catch {
      return;
    }
    ringToneRef.current = ctx;
    const now = ctx.currentTime;
    // two short ringing bursts within 3s, classic phone cadence
    const bursts = [
      [now + 0.05, 0.85],
      [now + 1.25, 0.85],
    ];
    bursts.forEach(([t, len]) => {
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      const g = ctx.createGain();
      o1.frequency.value = 440;
      o2.frequency.value = 480;
      o1.type = 'sine';
      o2.type = 'sine';
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.05);
      g.gain.linearRampToValueAtTime(0.12, t + len - 0.05);
      g.gain.linearRampToValueAtTime(0, t + len);
      o1.connect(g);
      o2.connect(g);
      g.connect(ctx.destination);
      o1.start(t);
      o2.start(t);
      o1.stop(t + len);
      o2.stop(t + len);
    });
  }, []);

  const stopRingTone = useCallback(() => {
    if (ringToneRef.current) {
      ringToneRef.current.close().catch(() => {});
      ringToneRef.current = null;
    }
  }, []);

  const startDurationTimer = useCallback(() => {
    if (durationTimerRef.current) return;
    setDuration(0);
    const startedAt = Date.now();
    durationTimerRef.current = setInterval(() => {
      setDuration(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
  }, []);

  const stopDurationTimer = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  // Phase 2 of start(): actually open the mic and start listening (called after 3s ring)
  const connect = useCallback(async () => {
    if (statusRef.current !== 'ringing') return; // user hung up during ring
    if (!getRecognition()) {
      setError('unsupported');
      setStatusBoth('error');
      return;
    }
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!micStreamRef.current) {
          micStreamRef.current = stream;
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (Ctx) {
            const ctx = new Ctx();
            audioCtxRef.current = ctx;
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            analyserRef.current = analyser;
            const buf = new Uint8Array(analyser.fftSize);
            const tick = () => {
              if (!analyserRef.current) return;
              analyserRef.current.getByteTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i++) {
                const v = (buf[i] - 128) / 128;
                sum += v * v;
              }
              const rms = Math.sqrt(sum / buf.length);
              const lvl = Math.min(1, Math.pow(rms * 4, 0.7));
              setLevel(lvl);
              rafRef.current = requestAnimationFrame(tick);
            };
            tick();
          }
        } else {
          stream.getTracks().forEach((t) => t.stop());
        }
      }
    } catch {
      setError('mic-permission');
      setStatusBoth('error');
      return;
    }
    if (statusRef.current !== 'ringing') return; // hung up while requesting mic
    desiredListeningRef.current = true;
    setStatusBoth('listening');
    startDurationTimer();
    startRecognition();
  }, [setStatusBoth, startRecognition, startDurationTimer]);

  const start = useCallback(() => {
    setError(null);
    setTranscript('');
    setDuration(0);
    finalTextRef.current = '';
    interimTextRef.current = '';
    if (!getRecognition()) {
      setError('unsupported');
      setStatusBoth('error');
      return;
    }
    setStatusBoth('ringing');
    playRingTone();
    if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
    ringTimerRef.current = setTimeout(() => {
      ringTimerRef.current = null;
      stopRingTone();
      connect();
    }, RING_MS);
  }, [setStatusBoth, playRingTone, stopRingTone, connect]);

  const stop = useCallback(() => {
    desiredListeningRef.current = false;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    stopRingTone();
    stopDurationTimer();
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    stopRecognition();
    clearAudio();
    stopMeter();
    finalTextRef.current = '';
    interimTextRef.current = '';
    setTranscript('');
    setDuration(0);
    setStatusBoth('idle');
  }, [stopRecognition, clearAudio, stopMeter, setStatusBoth, stopRingTone, stopDurationTimer]);

  const toggleMute = useCallback(() => {
    setMuted((m) => !m);
  }, []);

  const cycleVoice = useCallback(() => {
    setVoice((v) => {
      const i = VOICES.indexOf(v);
      return VOICES[(i + 1) % VOICES.length];
    });
  }, []);


  // cleanup on unmount
  useEffect(() => {
    return () => {
      desiredListeningRef.current = false;
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
      stopRingTone();
      stopDurationTimer();
      stopRecognition();
      clearAudio();
      stopMeter();
    };
  }, [stopRecognition, clearAudio, stopMeter, stopRingTone, stopDurationTimer]);

  return {
    status,
    transcript,
    muted,
    voice,
    lang,
    level,
    hearingSpeech,
    error,
    usingFallbackVoice,
    duration,
    start,
    stop,
    toggleMute,
    cycleVoice,
    supported: typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  };
}
