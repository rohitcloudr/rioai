import { useEffect } from 'react';
import { useVoiceCall } from './useVoiceCall.js';
import ModelPickerPopover from '../ModelPickerPopover.jsx';

const STATUS_LABEL = {
  idle: 'Ready',
  ringing: 'Ringing…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  error: 'Error',
};

function formatDuration(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const ERROR_MESSAGES = {
  unsupported: 'Voice mode needs Chrome or Edge — Firefox doesn\'t support speech recognition yet.',
  'mic-permission': 'Mic permission denied. Allow microphone access in your browser, then tap Retry.',
  network: 'Speech recognition needs internet (Chrome routes audio to Google). Check your connection.',
  'lang-language-not-supported': 'This language isn\'t supported on your browser. Try a different one.',
};

export default function CallOverlay({
  isOpen,
  onClose,
  onTurn,
  modelOptions = [],
  voiceChoice = null,
  onVoiceChoiceChange,
  authedFetch,
}) {
  const call = useVoiceCall({ onTurn, authedFetch });

  const pickerDisabled = call.status === 'thinking' || call.status === 'speaking';

  useEffect(() => {
    if (isOpen) {
      call.start();
    } else {
      call.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  function endCall() {
    call.stop();
    onClose();
  }

  const errorMessage = call.error ? ERROR_MESSAGES[call.error] ?? `Error: ${call.error}` : null;

  // Timer color marks the entire "ask + answer" cycle vs the idle moment between turns.
  //   user is speaking (listening + hearingSpeech)  → red  ("recording your question")
  //   Rio is thinking / speaking                    → red  ("Rio is answering")
  //   Rio is done, idle listening for next question → green ("your turn — ask anything")
  const isUserAsking = call.status === 'listening' && call.hearingSpeech;
  const isRioAnswering = call.status === 'thinking' || call.status === 'speaking';
  const showTimer = call.status === 'listening' || isRioAnswering;
  const timerTone = isUserAsking || isRioAnswering ? 'wait' : 'go';
  const timerAria = isUserAsking
    ? 'Recording your question'
    : isRioAnswering
    ? 'Rio is answering, please wait'
    : 'Your turn — ask anything';

  return (
    <div className="call-overlay" role="dialog" aria-label="Voice call with Rio">
      <div className="call-top">
        <div className={`call-avatar status-${call.status}`} aria-hidden="true">
          <span className="call-avatar-dot" />
        </div>
        <h2 className="call-title">Rio</h2>
        <p className="call-status">{STATUS_LABEL[call.status] ?? ''}</p>
        {showTimer ? (
          <p
            className={`call-timer call-timer-${timerTone}`}
            aria-live="polite"
            aria-label={timerAria}
          >
            {formatDuration(call.duration)}
          </p>
        ) : call.status === 'ringing' ? (
          <p className="call-timer call-timer-ringing">Connecting…</p>
        ) : null}
        {call.usingFallbackVoice && (
          <p className="call-hint">using browser voice (TTS provider unavailable)</p>
        )}

        {modelOptions.length > 0 && (
          <div className={`call-model-picker ${pickerDisabled ? 'is-busy' : ''}`}>
            <span className="call-model-picker-label">Model</span>
            <ModelPickerPopover
              value={voiceChoice}
              onChange={(next) => {
                if (pickerDisabled) return;
                onVoiceChoiceChange?.(next);
              }}
              modelOptions={modelOptions}
              allowAuto
              variant="dark"
            />
          </div>
        )}
      </div>

      <LevelMeter level={call.level} active={call.status === 'listening' && !call.muted} hearing={call.hearingSpeech} />

      <div className="call-transcript">
        {errorMessage ? (
          <p className="call-error">{errorMessage}</p>
        ) : call.transcript ? (
          <p>{call.transcript}</p>
        ) : (
          <p className="muted">
            {call.status === 'ringing' && 'calling Rio…'}
            {call.status === 'listening' && (call.muted ? 'muted — tap mic to unmute' : 'kuch bol… main sun rahi hu.')}
            {call.status === 'thinking' && '…'}
            {call.status === 'speaking' && ''}
            {call.status === 'idle' && 'starting…'}
          </p>
        )}
      </div>

      <div className="call-controls">
        <button
          className={`call-btn-round ${call.muted ? 'active' : ''}`}
          onClick={call.toggleMute}
          aria-label={call.muted ? 'Unmute' : 'Mute'}
          title={call.muted ? 'Unmute' : 'Mute'}
          disabled={call.status === 'error' || call.status === 'ringing'}
        >
          {call.muted ? <MicOffIcon /> : <MicIcon />}
        </button>

        <button
          className="call-btn-round call-end"
          onClick={endCall}
          aria-label="End call"
          title="End call"
        >
          <PhoneDownIcon />
        </button>

        <button
          className="call-btn-round"
          onClick={call.cycleVoice}
          aria-label={`Voice: ${call.voice}`}
          title={`Voice: ${call.voice} (tap to change)`}
        >
          <SpeakerIcon />
          <span className="call-voice-tag">{call.voice}</span>
        </button>
      </div>

      {call.error && call.error !== 'unsupported' && (
        <button
          className="call-retry"
          onClick={() => {
            call.stop();
            setTimeout(() => call.start(), 100);
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

function LevelMeter({ level, active, hearing }) {
  const bars = 14;
  const arr = Array.from({ length: bars }, (_, i) => i);
  return (
    <div className={`call-meter ${active ? 'active' : ''} ${hearing ? 'hearing' : ''}`} aria-hidden="true">
      {arr.map((i) => {
        const center = (bars - 1) / 2;
        const dist = Math.abs(i - center) / center;
        const fall = 1 - dist * 0.6;
        const lit = level > i / bars * 0.9;
        const h = lit ? Math.max(8, 40 * level * fall) : 6;
        return <span key={i} className="call-meter-bar" style={{ height: h + 'px' }} />;
      })}
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}
function MicOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}
function PhoneDownIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.33 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)" />
    </svg>
  );
}
function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}
